import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { PublicError } from "../security.js";
import { PRIVATE_ROBOTS } from "../sharing.js";

export const STAGING_HTTP_LIMITS = Object.freeze({ version: "sg-staging-mint-http-v1", maxConnections: 32,
  maxInFlight: 32, maxHeaderBytes: 8192, maxHeaderCount: 32, maxRequestsPerMinute: 600 });
export interface StagingTransport {
  readonly origin: string;
  readonly tlsMode: string;
  readonly trustedProxyHops: number;
  readonly maxRequestBytes: number;
  readonly requestTimeoutMs: number;
}
type Handler = (req: IncomingMessage, res: ServerResponse, signal: AbortSignal) => Promise<unknown>;
function privateHeaders(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Robots-Tag", PRIVATE_ROBOTS);
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Connection", "close");
}
function reply(res: ServerResponse, status: number, code: string, error: string) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ code, error }));
}
function fail(status: number, code: string, message: string): never { throw new PublicError(status, code, message); }

/** One independently configured, trusted local TLS terminator. Headers do NOT
 * authenticate a proxy: deployment must isolate this loopback port from other
 * principals and strip client forwarding headers before installing its own.
 * This module neither provisions TLS nor admits direct/public HTTP listeners.
 * No key/env discovery, IP-based authority, forwarded chains or CORS grants. */
export function createStagingTransportServer(input: StagingTransport, handler: Handler) {
  const c = Object.freeze({ ...input });
  if (Object.keys(c).sort().join() !== "maxRequestBytes,origin,requestTimeoutMs,tlsMode,trustedProxyHops"
    || c.origin !== "https://staging.signatures.gallery" || c.tlsMode !== "trusted-proxy" || c.trustedProxyHops !== 1
    || !Number.isSafeInteger(c.maxRequestBytes) || c.maxRequestBytes < 1024 || c.maxRequestBytes > 8192
    || !Number.isSafeInteger(c.requestTimeoutMs) || c.requestTimeoutMs < 1000 || c.requestTimeoutMs > 30000) throw Error("Unsupported staging transport binding.");
  const headerTimeout = Math.min(5000, c.requestTimeoutMs);
  let active = 0, windowStart = performance.now(), count = 0;
  const server = createServer({ maxHeaderSize: STAGING_HTTP_LIMITS.maxHeaderBytes }, async (req, res) => {
    // One request per upstream socket: no pipelined/catch-up work, ambiguous
    // reuse, or indefinitely extendable incomplete-header connection.
    privateHeaders(res);
    const now = performance.now();
    if (now - windowStart >= 60000) { windowStart = now; count = 0; }
    if (++count > STAGING_HTTP_LIMITS.maxRequestsPerMinute) {
      req.resume(); res.setHeader("Retry-After", "60"); return reply(res, 429, "RATE_LIMITED", "Please try again later.");
    }
    if (active >= STAGING_HTTP_LIMITS.maxInFlight) { req.resume(); return reply(res, 503, "BUSY", "Please try again later."); }
    active++;
    const abort = new AbortController(), cancel = () => abort.abort(), expires = performance.now() + c.requestTimeoutMs;
    res.once("close", cancel);
    const deadline = setTimeout(() => { abort.abort(); res.destroy(); }, c.requestTimeoutMs);
    try {
      if (req.socket.remoteAddress !== "127.0.0.1" || req.socket.localAddress !== "127.0.0.1") fail(403, "LOCAL_ONLY", "The configured local proxy is required.");
      const seen = new Set<string>();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i].toLowerCase();
        if (seen.has(name)) fail(400, "INVALID_HEADERS", "Ambiguous request headers.");
        seen.add(name);
      }
      if (req.httpVersion !== "1.1" || seen.size > STAGING_HTTP_LIMITS.maxHeaderCount) fail(400, "INVALID_HEADERS", "Invalid request headers.");
      if (req.headers.host !== "staging.signatures.gallery") fail(421, "WRONG_HOST", "Open the configured site address.");
      if (req.headers["x-forwarded-proto"] !== "https" || [...seen].some(k =>
        k === "forwarded" || k.startsWith("x-forwarded-") && k !== "x-forwarded-proto"
        || ["x-real-ip", "x-original-url", "x-rewrite-url", "x-original-host"].includes(k))) fail(400, "PROXY_UNSUPPORTED", "Invalid proxy context.");
      if (req.method !== "GET" && req.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.length > 4096 || /[#\\\x00-\x20\x7f]/.test(req.url)) fail(400, "INVALID_REQUEST", "Invalid request target.");
      if (req.headers.expect !== undefined || req.headers.upgrade !== undefined) fail(400, "INVALID_HEADERS", "Unsupported request headers.");
      if ((req.headers.origin !== undefined && req.headers.origin !== c.origin) || req.method === "POST" &&
        (req.headers.origin !== c.origin || req.headers["sec-fetch-site"] !== undefined && req.headers["sec-fetch-site"] !== "same-origin")) fail(403, "SESSION_REQUIRED", "Open the configured site and try again.");
      const length = req.headers["content-length"];
      if (req.method === "GET" && (req.headers["transfer-encoding"] !== undefined || length !== undefined && length !== "0")) fail(400, "INVALID_INPUT", "GET requests must not include a body.");
      if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > c.maxRequestBytes)) fail(413, "REQUEST_TOO_LARGE", "Request is too large.");
      if (req.headers["transfer-encoding"] !== undefined && req.headers["transfer-encoding"] !== "chunked") fail(400, "INVALID_HEADERS", "Invalid request framing.");
      abort.signal.throwIfAborted();
      if (performance.now() >= expires) throw Error("Request deadline.");
      await handler(req, res, abort.signal);
    } catch (error) {
      const known = error instanceof PublicError;
      reply(res, known ? error.status : 503, known ? error.code : "SERVICE_UNAVAILABLE", known ? error.message : "This operation is unavailable."); req.resume();
    } finally { clearTimeout(deadline); abort.abort(); res.removeListener("close", cancel); active--; }
  });
  server.maxConnections = STAGING_HTTP_LIMITS.maxConnections;
  server.maxHeadersCount = STAGING_HTTP_LIMITS.maxHeaderCount + 1; server.maxRequestsPerSocket = 1;
  server.headersTimeout = headerTimeout; server.requestTimeout = c.requestTimeoutMs; server.keepAliveTimeout = 1000;
  server.setTimeout(c.requestTimeoutMs, socket => socket.destroy());
  server.on("connection", socket => {
    // Includes incomplete headers, independent of Node's watchdog interval or
    // incoming progress. In-flight handler admission is bounded separately.
    const deadline = setTimeout(() => socket.destroy(), headerTimeout + c.requestTimeoutMs); deadline.unref();
    socket.once("close", () => clearTimeout(deadline));
  });
  server.on("checkContinue", (_req, res) => { privateHeaders(res); reply(res, 417, "EXPECTATION_FAILED", "Expect is not supported."); });
  server.on("checkExpectation", (_req, res) => { privateHeaders(res); reply(res, 417, "EXPECTATION_FAILED", "Expect is not supported."); });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (_req, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  return server;
}
