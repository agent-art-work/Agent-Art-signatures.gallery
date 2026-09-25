import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { closeHttpServer } from "../../src/openMint/shutdown.ts";

const deny = () => { throw Error("Staging health unavailable."); };

/** Separate loopback-only, snapshot-only health listener. A readiness request
 * may re-read the current local signed review, but never queries DB/RPC,
 * starts observation or requests an assessment/signature. */
export function createActiveStagingHealth({ port, site, writer, assertReview, timeoutMs = 5000 }) {
  try {
    assert.ok(Number.isSafeInteger(port) && port >= 0 && port <= 65535 && site && typeof site.snapshot === "function"
      && writer && typeof writer.assertHealthy === "function" && typeof assertReview === "function"
      && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 30000);
    let phase = "idle", closed;
    const reply = (res, code, status) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "Connection": "close", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      res.end(JSON.stringify({ status, mode: "active-staging" }));
    };
    const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
      if (req.socket.remoteAddress !== "127.0.0.1" || req.method !== "GET" || !["/_health/live", "/_health/ready"].includes(req.url)
        || req.rawHeaders.length > 64 || req.headers["transfer-encoding"] !== undefined
        || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) {
        reply(res, 400, "unavailable"); return;
      }
      if (phase !== "running") { reply(res, 503, "unavailable"); return; }
      try {
        writer.assertHealthy();
        const current = site.snapshot();
        if (req.url === "/_health/live") { reply(res, 200, "live"); return; }
        assertReview();
        assert.ok(current.phase === "running" && current.observer?.state === "waiting"
          && (current.observer.lastOutcome === undefined || current.observer.lastOutcome === "observed"));
        reply(res, 200, "ready");
      } catch { reply(res, 503, "unavailable"); }
    });
    server.maxConnections = 32; server.maxHeadersCount = 32; server.maxRequestsPerSocket = 16;
    server.requestTimeout = timeoutMs; server.headersTimeout = Math.min(timeoutMs, 5000); server.keepAliveTimeout = 1000;
    server.setTimeout(timeoutMs, socket => socket.destroy());
    server.on("upgrade", (_req, socket) => socket.destroy());
    server.on("connect", (_req, socket) => socket.destroy());
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("error", () => { phase = "failed"; });
    return Object.freeze({
      address() { const a = server.address(); return a && typeof a !== "string" ? { host: a.address, port: a.port } : undefined; },
      async start(signal = new AbortController().signal) {
        try {
          assert.equal(phase, "idle"); phase = "starting"; signal.throwIfAborted();
          writer.assertHealthy(); assertReview();
          const listening = once(server, "listening", { signal });
          server.listen(port, "127.0.0.1"); await listening;
          signal.throwIfAborted(); writer.assertHealthy(); assertReview(); phase = "running";
        } catch { phase = "failed"; await closeHttpServer(server, timeoutMs).catch(() => {}); return deny(); }
      },
      close() { phase = "closing"; return closed ??= closeHttpServer(server, timeoutMs).finally(() => { phase = "closed"; }); },
      snapshot() { return Object.freeze({ phase }); },
    });
  } catch { return deny(); }
}
