import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { closeHttpServer } from "../shutdown.js";

/** Fixed limits are committed by the release-aware composition's review scope.
 * This is a loopback control surface behind ONE trusted local TLS proxy, not a
 * general mint API. No body, cookie, arbitrary URL, origin or caller key input. */
export const READINESS_LIMITS = Object.freeze({ version: "sg-paused-readiness-http-v1", maxConnections: 32,
  maxHeaderBytes: 8192, maxHeaderCount: 32, maxRequestsPerSocket: 16, maxRequestsPerMinute: 60,
  minProbeIntervalMs: 10000, maxInFlightProbes: 1, maxBodyBytes: 0 });
export interface ReadinessWitness { assertCurrent(): void }
export interface ReadinessPorts {
  probe(signal: AbortSignal): Promise<ReadinessWitness>;
  halt(): void;
}
const unavailable = () => new Error("Paused staging readiness unavailable.");

/** Internal infrastructure factory. Only the release-aware adapter should
 * supply these trusted ports. Never expose probe callbacks to HTTP callers.
 * Owns listener/sockets only; never closes the caller's database connection. */
export function createPausedReadinessServer(input: { port: number; requestTimeoutMs: number; drainTimeoutMs: number }, ports: ReadinessPorts) {
  const config = Object.freeze({ ...input }), probe = ports.probe.bind(ports), halt = ports.halt.bind(ports);
  if (Object.keys(config).sort().join() !== "drainTimeoutMs,port,requestTimeoutMs" || !Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535
    || !Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1000 || config.requestTimeoutMs > 30000
    || !Number.isSafeInteger(config.drainTimeoutMs) || config.drainTimeoutMs < config.requestTimeoutMs || config.drainTimeoutMs > 120000) throw unavailable();
  const stop = new AbortController();
  let phase: "idle" | "starting" | "running" | "quarantined" | "closing" | "closed" = "idle";
  let busy = false, nextProbe = -Infinity, windowStart = performance.now(), requestCount = 0, closing: Promise<void> | undefined;
  const quarantine = () => { if (phase !== "closing" && phase !== "closed") phase = "quarantined"; stop.abort(); halt(); };
  async function check(signal: AbortSignal) {
    const combined = AbortSignal.any([signal, stop.signal]), local = new AbortController();
    const started = performance.now(), wall = Date.now(); let timer: ReturnType<typeof setTimeout> | undefined, aborted!: () => void;
    const current = () => { if (combined.aborted || local.signal.aborted || performance.now() - started >= config.requestTimeoutMs
      || Date.now() < wall || Date.now() - wall >= config.requestTimeoutMs) throw unavailable(); };
    try {
      current();
      const deadline = new Promise<never>((_, reject) => {
        aborted = () => { local.abort(); reject(unavailable()); };
        combined.addEventListener("abort", aborted, { once: true }); timer = setTimeout(aborted, config.requestTimeoutMs);
      });
      const witness = await Promise.race([Promise.resolve().then(() => { current(); return probe(AbortSignal.any([combined, local.signal])); }), deadline]);
      current(); witness.assertCurrent(); return witness;
    } catch { quarantine(); throw unavailable(); }
    finally { clearTimeout(timer); if (aborted) combined.removeEventListener("abort", aborted); local.abort(); }
  }
  function reply(res: ServerResponse, code: number, status: string, extra: Record<string, string> = {}) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Connection": "close",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...extra });
    res.end(JSON.stringify({ status, mode: "paused-readiness-only", minting: false }));
  }
  function ingress(req: IncomingMessage): boolean {
    const counts = new Map<string, number>();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i].toLowerCase(); counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return req.httpVersion === "1.1" && req.rawHeaders.length / 2 <= READINESS_LIMITS.maxHeaderCount
      && [...counts.values()].every(n => n === 1) && req.headers.host === "staging.signatures.gallery"
      && req.headers["x-forwarded-proto"] === "https" && req.socket.remoteAddress === "127.0.0.1"
      && req.headers.forwarded === undefined && req.headers["x-forwarded-host"] === undefined && req.headers["x-forwarded-for"] === undefined
      && req.headers.upgrade === undefined && req.headers.expect === undefined && req.headers["transfer-encoding"] === undefined
      && (req.headers["content-length"] === undefined || req.headers["content-length"] === "0")
      && (req.headers.origin === undefined || req.headers.origin === "https://staging.signatures.gallery");
  }
  const server = createServer({ maxHeaderSize: READINESS_LIMITS.maxHeaderBytes }, (req, res) => {
    const now = performance.now();
    if (now - windowStart >= 60000) { windowStart = now; requestCount = 0; }
    if (++requestCount > READINESS_LIMITS.maxRequestsPerMinute) { reply(res, 429, "rate-limited", { "Retry-After": "60" }); return; }
    if (!ingress(req)) { reply(res, 400, "invalid-request"); return; }
    if (req.method !== "GET") { reply(res, 405, "method-not-allowed", { Allow: "GET" }); return; }
    if (req.url !== "/_health/live" && req.url !== "/_health/ready") { reply(res, 404, "not-found"); return; }
    if (phase === "closing" || phase === "closed") { reply(res, 503, "unavailable"); return; }
    if (req.url === "/_health/live") { reply(res, 200, "live"); return; }
    if (phase !== "running") { reply(res, 503, "unavailable"); return; }
    if (busy || now < nextProbe) { reply(res, 429, "probe-limited", { "Retry-After": String(Math.max(1, Math.ceil((nextProbe - now) / 1000))) }); return; }
    busy = true; nextProbe = now + READINESS_LIMITS.minProbeIntervalMs;
    const controller = new AbortController(), abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", abort);
    void check(controller.signal).then(witness => {
      if (phase !== "running" || controller.signal.aborted) throw unavailable();
      witness.assertCurrent(); reply(res, 200, "ready-paused");
    }).catch(() => { quarantine(); reply(res, 503, "unavailable"); }).finally(() => { busy = false; res.removeListener("close", abort); });
  });
  server.maxConnections = READINESS_LIMITS.maxConnections; server.maxHeadersCount = READINESS_LIMITS.maxHeaderCount + 1;
  server.maxRequestsPerSocket = READINESS_LIMITS.maxRequestsPerSocket;
  server.requestTimeout = config.requestTimeoutMs; server.headersTimeout = Math.min(5000, config.requestTimeoutMs);
  server.keepAliveTimeout = 1000;
  // Also bound incomplete headers/body-idle sockets; Node's request timer alone
  // does not bound asynchronous application work (check() does that above).
  server.setTimeout(config.requestTimeoutMs, socket => socket.destroy());
  // An idle timeout can be extended by dripping bytes, and Node's built-in
  // header watchdog checks on its own interval. These close-only connections
  // also get an absolute lifetime from accept, independent of client progress.
  server.on("connection", socket => {
    const deadline = setTimeout(() => socket.destroy(), config.requestTimeoutMs); deadline.unref();
    socket.once("close", () => clearTimeout(deadline));
  });
  server.on("checkContinue", (_req, res) => reply(res, 417, "expectation-failed"));
  server.on("checkExpectation", (_req, res) => reply(res, 417, "expectation-failed"));
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (_req, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("error", quarantine);
  const close = () => {
    if (!closing) {
      phase = "closing"; stop.abort(); halt();
      closing = closeHttpServer(server, config.drainTimeoutMs).finally(() => { phase = "closed"; });
    }
    return closing;
  };
  return Object.freeze({
    async start(signal = new AbortController().signal) {
      if (phase !== "idle") throw unavailable(); phase = "starting";
      try {
        const witness = await check(signal);
        if (phase !== "starting" || signal.aborted) throw unavailable(); witness.assertCurrent();
        const listening = once(server, "listening", { signal: stop.signal });
        server.listen(config.port, "127.0.0.1"); await listening;
        if (phase !== "starting" || signal.aborted) throw unavailable(); witness.assertCurrent(); phase = "running";
      } catch { await close(); throw unavailable(); }
    }, close,
    address() { const a = server.address(); return a && typeof a !== "string" ? Object.freeze({ host: a.address, port: a.port }) : undefined; },
    snapshot: () => Object.freeze({ phase, busy, mode: "paused-readiness-only", minting: false }),
  });
}
