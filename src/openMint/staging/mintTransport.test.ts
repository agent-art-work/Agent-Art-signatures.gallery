import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPrivateMintBody } from "../persistence/http.js";
import { createStagingTransportServer, STAGING_HTTP_LIMITS, type StagingTransport } from "./mintTransport.js";

const origin = "https://staging.signatures.gallery";
const config: StagingTransport = { origin, tlsMode: "trusted-proxy", trustedProxyHops: 1, maxRequestBytes: 1024, requestTimeoutMs: 2000 };
type Handler = Parameters<typeof createStagingTransportServer>[1];
const ok: Handler = async (_req, res) => { res.end("ok"); };
it.each([{ origin: "http://staging.signatures.gallery" }, { origin: origin + "/" }, { origin: "https://signatures.gallery" },
  { tlsMode: "direct", trustedProxyHops: 0 }, { trustedProxyHops: 0 }, { trustedProxyHops: 2 }, { tlsMode: "auto" },
  { maxRequestBytes: 1023 }, { maxRequestBytes: 8193 }, { maxRequestBytes: 1024.5 },
  { requestTimeoutMs: 999 }, { requestTimeoutMs: 30001 }, { requestTimeoutMs: NaN }, { extra: true },
])("refuses unsupported transport before any socket or work: %j", patch => {
  const handler = vi.fn(ok);
  expect(() => createStagingTransportServer({ ...config, ...patch }, handler)).toThrow("Unsupported staging transport");
  expect(handler).not.toHaveBeenCalled();
});
it("bounds the shared body parser's configured and actual stream limits", async () => {
  function body(text: string, headers: Record<string, string> = {}) {
    return Object.assign(Readable.from([Buffer.from(text)]), { headers: { "content-type": "application/json", ...headers } }) as unknown as IncomingMessage;
  }
  for (const limit of [0, -1, 8193, NaN, 1.5]) await expect(readPrivateMintBody(body("{}"), limit)).rejects.toThrow("Invalid private body limit");
  await expect(readPrivateMintBody(body("{}"), 2)).resolves.toEqual({});
  await expect(readPrivateMintBody(body("{}", { "content-length": "3" }), 2)).rejects.toMatchObject({ status: 413 });
  await expect(readPrivateMintBody(body("{} "), 2)).rejects.toMatchObject({ status: 413 });
});

describe.skipIf(process.env.OPEN_MINT_TEST_HTTP !== "1")("staging mint transport over real disposable loopback HTTP", () => {
  const servers: ReturnType<typeof createStagingTransportServer>[] = [];
  async function start(handler: Handler = ok, settings = config) {
    const run = vi.fn(handler), server = createStagingTransportServer(settings, run); servers.push(server);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    return { server, run, port: (server.address() as { port: number }).port };
  }
  afterEach(async () => {
    for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    vi.restoreAllMocks();
  });
  async function http(port: number, headers: Record<string, string | undefined> = {}, method = "GET", path = "/api/session", body?: string) {
    const merged = { host: "staging.signatures.gallery", "x-forwarded-proto": "https", ...headers };
    const clean = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) as Record<string, string>;
    return new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: clean, agent: false }, res => {
        let text = ""; res.on("data", d => text += d); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text })); res.on("error", reject);
      }); req.on("error", reject); req.end(body);
    });
  }
  async function raw(port: number, bytes: string) {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1"); let text = "";
      socket.on("connect", () => socket.write(bytes)); socket.on("data", d => text += d);
      socket.on("error", e => { if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e); });
      socket.on("close", () => resolve(text)); socket.setTimeout(6000, () => socket.destroy(Error("Test connection did not close")));
    });
  }
  it("captures exact policy, gives safe defaults, and accepts same-origin zero-length GET and POST", async () => {
    const mutable = { ...config }, f = await start(ok, mutable); mutable.origin = "https://evil.invalid";
    const r = await http(f.port, { origin, "content-length": "0" });
    expect(r.status).toBe(200); expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-robots-tag"]).toContain("noindex"); expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'"); expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers.connection).toBe("close"); expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect((await http(f.port, { origin, "sec-fetch-site": "same-origin" }, "POST")).status).toBe(200);
    expect(f.server.maxConnections).toBe(32); expect(f.server.maxRequestsPerSocket).toBe(1);
    expect(f.server.requestTimeout).toBe(config.requestTimeoutMs); expect(f.run).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ host: "127.0.0.1" }, "GET", "/", 421], [{ host: "staging.signatures.gallery:443" }, "GET", "/", 421],
    [{ "x-forwarded-proto": undefined }, "GET", "/", 400], [{ "x-forwarded-proto": "http" }, "GET", "/", 400],
    [{ "x-forwarded-proto": "https,https" }, "GET", "/", 400], [{ forwarded: "proto=https" }, "GET", "/", 400],
    [{ "x-forwarded-host": "staging.signatures.gallery" }, "GET", "/", 400], [{ "x-forwarded-for": "127.0.0.1" }, "GET", "/", 400],
    [{ "x-real-ip": "127.0.0.1" }, "GET", "/", 400], [{ "x-original-url": "/api/session" }, "GET", "/", 400],
    [{ "x-rewrite-url": "/api/session" }, "GET", "/", 400], [{ "x-original-host": "staging.signatures.gallery" }, "GET", "/", 400],
    [{}, "OPTIONS", "/", 405], [{}, "PUT", "/", 405], [{}, "GET", "//evil.invalid/path", 400],
    [{}, "GET", "https://staging.signatures.gallery/", 400], [{}, "GET", "/#x", 400], [{}, "GET", "/\\x", 400],
    [{}, "GET", "/".repeat(4097), 400], [{ upgrade: "websocket" }, "GET", "/", 400],
    [{ origin: "https://evil.invalid" }, "GET", "/", 403], [{}, "POST", "/", 403],
    [{ origin, "sec-fetch-site": "same-site" }, "POST", "/", 403], [{ origin, "sec-fetch-site": "cross-site" }, "POST", "/", 403],
    [{ "content-length": "1" }, "GET", "/", 400], [{ "transfer-encoding": "chunked" }, "GET", "/", 400],
    [{ origin, "content-length": "1025" }, "POST", "/", 413], [{ origin, "content-length": "01" }, "POST", "/", 413],
    [{ expect: "100-continue" }, "GET", "/", 417], [{ expect: "other" }, "GET", "/", 417],
  ] as const)("rejects invalid ingress before handler (%#)", async (headers, method, path, status) => {
    const f = await start(), r = await http(f.port, headers, method, path);
    expect(r.status).toBe(status); expect(r.headers["cache-control"]).toBe("no-store"); expect(f.run).not.toHaveBeenCalled();
  });
  it("rejects duplicate headers, oversize headers, extra headers, bad framing, old HTTP and upgrades before the handler", async () => {
    const f = await start(), base = "Host: staging.signatures.gallery\r\nX-Forwarded-Proto: https\r\n";
    for (const bytes of [
      `GET / HTTP/1.1\r\n${base}Host: staging.signatures.gallery\r\n\r\n`,
      `GET / HTTP/1.1\r\n${base}Cookie: x=1\r\ncookie: x=2\r\n\r\n`,
      `GET / HTTP/1.1\r\n${base}Cookie: ${"a".repeat(8192)}\r\n\r\n`,
      `GET / HTTP/1.1\r\n${base}${Array.from({ length: 31 }, (_, i) => `X-Test-${i}: value\r\n`).join("")}\r\n`,
      `GET / HTTP/1.0\r\n${base}\r\n`,
      `GET / HTTP/1.1\r\n${base}Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      `CONNECT staging.signatures.gallery:443 HTTP/1.1\r\n${base}\r\n`,
      `POST / HTTP/1.1\r\n${base}Origin: ${origin}\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n`,
    ]) { const r = await raw(f.port, bytes); expect(r === "" || /^HTTP\/1.1 400/.test(r)).toBe(true); }
    expect(f.run).not.toHaveBeenCalled();
  });
  it("bounds chunked JSON before application work, sanitizes internal errors, and never retries", async () => {
    const effect = vi.fn(), f = await start(async (req, res) => { await readPrivateMintBody(req, 1024); effect(); res.end("ok"); });
    const headers = { origin, "transfer-encoding": "chunked", "content-type": "application/json" };
    expect((await http(f.port, headers, "POST", "/", "{}")).status).toBe(200);
    effect.mockClear();
    // Node can close the incoming stream when its iterator is aborted on size overflow.
    const large = await http(f.port, headers, "POST", "/", JSON.stringify({ x: "a".repeat(1024) })).catch(() => undefined);
    if (large) expect(large.status).toBe(413);
    expect(effect).not.toHaveBeenCalled();
    const failed = await start(async () => { throw Error("PRIVATE PROVIDER SECRET"); });
    const r = await http(failed.port); expect(r.status).toBe(503); expect(r.body).not.toContain("PRIVATE"); expect(failed.run).toHaveBeenCalledTimes(1);
  });
  it("limits even cheap requests globally and resets only on the monotonic minute boundary", async () => {
    const f = await start(), clock = vi.spyOn(performance, "now"), began = performance.now(); clock.mockReturnValue(began);
    for (let i = 0; i < STAGING_HTTP_LIMITS.maxRequestsPerMinute; i++) expect((await http(f.port)).status).toBe(200);
    const r = await http(f.port); expect(r.status).toBe(429); expect(r.headers["retry-after"]).toBe("60");
    expect(f.run).toHaveBeenCalledTimes(600); clock.mockReturnValue(began + 60001);
    expect((await http(f.port)).status).toBe(200);
  });
  it("checks elapsed monotonic time before handing off even if the timer callback is delayed", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(10000);
    const f = await start(), r = await http(f.port);
    expect(r.status).toBe(503); expect(f.run).not.toHaveBeenCalled();
  });
  it("retains in-flight capacity after disconnect until non-cooperative handlers settle", async () => {
    const release: (() => void)[] = [], signals: AbortSignal[] = [];
    const f = await start(async (_req, _res, signal) => { signals.push(signal); await new Promise<void>(r => release.push(r)); });
    try {
      for (let i = 0; i < 32; i++) {
        const req = request({ host: "127.0.0.1", port: f.port, headers: { host: "staging.signatures.gallery", "x-forwarded-proto": "https" }, agent: false });
        req.on("error", () => {}); req.end(); await vi.waitFor(() => expect(signals).toHaveLength(i + 1), { interval: 2 });
        req.destroy(); await vi.waitFor(() => expect(signals[i].aborted).toBe(true), { interval: 2 });
      }
      expect((await http(f.port)).status).toBe(503); expect(f.run).toHaveBeenCalledTimes(32);
    } finally { release.forEach(r => r()); }
  });
  it("aborts a hanging callback at the absolute request deadline without replay", async () => {
    let signal: AbortSignal | undefined, release!: () => void;
    const f = await start(async (_req, _res, s) => { signal = s; await new Promise<void>(r => release = r); }, { ...config, requestTimeoutMs: 1000 });
    try {
      await expect(http(f.port)).rejects.toThrow();
      expect(signal?.aborted).toBe(true); expect(f.run).toHaveBeenCalledTimes(1);
    } finally { release?.(); }
  });
  it("closes incomplete headers at an absolute connection deadline even while bytes arrive", async () => {
    const f = await start(ok, { ...config, requestTimeoutMs: 1000 });
    const socket = connect(f.port, "127.0.0.1"); await once(socket, "connect");
    socket.write("GET / HTTP/1.1\r\nHost: staging.signatures.gallery\r\nX-Slow: ");
    const began = performance.now(), drip = setInterval(() => socket.write("a"), 100);
    try { await once(socket, "close"); expect(performance.now() - began).toBeLessThan(4000); expect(f.run).not.toHaveBeenCalled(); }
    finally { clearInterval(drip); socket.destroy(); }
  });
});
