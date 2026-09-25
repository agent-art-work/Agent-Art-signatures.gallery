import { request } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPausedReadinessServer, READINESS_LIMITS, type ReadinessWitness } from "./readinessServer.js";

const defaults = { port: 0, requestTimeoutMs: 2000, drainTimeoutMs: 2000 };
const witness = (): ReadinessWitness => ({ assertCurrent() {} });
function socketClosed(socket: ReturnType<typeof connect>) {
  return new Promise<void>((resolve, reject) => {
    socket.once("close", () => resolve());
    // A forced close with unread client bytes may be a FIN or a reset. Both
    // close the malicious/incomplete connection; other errors still fail.
    socket.once("error", error => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); });
  });
}
function fixture(probe = vi.fn(async (_signal: AbortSignal) => witness()), config = defaults) {
  const halt = vi.fn(), server = createPausedReadinessServer(config, { probe, halt });
  return { server, probe, halt };
}
export function getReadiness(port: number, path = "/_health/ready", headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ code: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: "staging.signatures.gallery", "X-Forwarded-Proto": "https", ...headers }, agent: false }, res => {
      let body = ""; res.on("data", data => { body += data; }); res.on("end", () => resolve({ code: res.statusCode!, body, headers: res.headers }));
    }); req.on("error", reject); req.end();
  });
}
it.each([{ port: -1 }, { port: 65536 }, { port: 1.5 }, { requestTimeoutMs: 999 }, { requestTimeoutMs: 30001 },
  { drainTimeoutMs: 1000 }, { drainTimeoutMs: 120001 }, { extra: true }])("refuses invalid resource settings %j", patch => {
  expect(() => fixture(undefined, { ...defaults, ...patch })).toThrow();
});
it("preflight failure/cancellation does not listen and cannot be restarted", async () => {
  for (const aborted of [false, true]) {
    const f = fixture(vi.fn(async () => { throw Error("SECRET"); })), c = new AbortController(); if (aborted) c.abort();
    await expect(f.server.start(c.signal)).rejects.toThrow("Paused staging readiness unavailable.");
    expect(f.server.address()).toBeUndefined(); expect(f.server.snapshot().phase).toBe("closed");
    expect(f.probe).toHaveBeenCalledTimes(aborted ? 0 : 1); await expect(f.server.start()).rejects.toThrow(); await f.server.close();
  }
});
it("shutdown cancels a hanging startup without listening or replay", async () => {
  let signal: AbortSignal | undefined;
  const f = fixture(vi.fn(s => { signal = s; return new Promise<ReadinessWitness>(() => {}); }));
  const started = f.server.start(); await vi.waitFor(() => expect(signal).toBeDefined());
  const refusal = expect(started).rejects.toThrow(); await f.server.close(); await refusal;
  expect(signal!.aborted).toBe(true); expect(f.server.address()).toBeUndefined(); expect(f.probe).toHaveBeenCalledTimes(1);
});

describe.skipIf(process.env.OPEN_MINT_TEST_HTTP !== "1")("bounded loopback paused-readiness HTTP", () => {
  const servers: ReturnType<typeof fixture>[] = [];
  const start = async (probe?: ReturnType<typeof fixture>["probe"], config = defaults) => {
    const f = fixture(probe, config); servers.push(f); await f.server.start(); return { ...f, port: f.server.address()!.port };
  };
  afterEach(async () => { await Promise.all(servers.splice(0).map(f => f.server.close())); vi.restoreAllMocks(); });
  it("checks before listening, exposes only fixed read-only responses and has no public bind", async () => {
    const f = await start(); expect(f.probe).toHaveBeenCalledTimes(1); expect(f.server.address()!.host).toBe("127.0.0.1");
    const live = await getReadiness(f.port, "/_health/live"); expect(live.code).toBe(200); expect(f.probe).toHaveBeenCalledTimes(1);
    const ready = await getReadiness(f.port); expect(ready.code).toBe(200);
    expect(JSON.parse(ready.body)).toEqual({ status: "ready-paused", mode: "paused-readiness-only", minting: false });
    expect(ready.headers["cache-control"]).toBe("no-store"); expect(ready.headers["access-control-allow-origin"]).toBeUndefined();
    expect(ready.headers["set-cookie"]).toBeUndefined(); expect(ready.headers.connection).toBe("close");
    const limited = await getReadiness(f.port); expect(limited.code).toBe(429); expect(limited.headers["retry-after"]).toBeDefined();
    expect(f.probe).toHaveBeenCalledTimes(2); await expect(f.server.start()).rejects.toThrow();
    await Promise.all([f.server.close(), f.server.close()]); expect(f.server.address()).toBeUndefined();
  });
  it.each([
    ["/_health/ready?mint=1", {}, "GET", 404], ["/mint", {}, "GET", 404], ["/_health/ready", {}, "POST", 405],
    ["/_health/ready", {}, "OPTIONS", 405], ["/_health/ready", { Host: "127.0.0.1" }, "GET", 400],
    ["/_health/ready", { "X-Forwarded-Proto": "http" }, "GET", 400], ["/_health/ready", { Origin: "https://evil.invalid" }, "GET", 400],
    ["/_health/ready", { Forwarded: "proto=https" }, "GET", 400], ["/_health/ready", { "X-Forwarded-For": "127.0.0.1" }, "GET", 400],
    ["/_health/ready", { Forwarded: "" }, "GET", 400],
    ["/_health/ready", { "X-Forwarded-Host": "staging.signatures.gallery" }, "GET", 400],
    ["/_health/ready", { "Content-Length": "1" }, "GET", 400], ["/_health/ready", { "Transfer-Encoding": "chunked" }, "GET", 400],
    ["/_health/ready", { Expect: "100-continue" }, "GET", 417], ["/_health/ready", { Expect: "other" }, "GET", 417],
  ] as const)("denies invalid ingress (%#)", async (path, headers, method, expected) => {
    const f = await start(), r = await getReadiness(f.port, path, headers, method);
    expect(r.code).toBe(expected); expect(f.probe).toHaveBeenCalledTimes(1); expect(r.body).not.toContain("Error");
  });
  it("accepts same origin and zero body without treating a cookie as authority", async () => {
    const f = await start(); const r = await getReadiness(f.port, "/_health/ready", { Origin: "https://staging.signatures.gallery", "Content-Length": "0", Cookie: "fake=admin" });
    expect(r.code).toBe(200); expect(r.body).not.toContain("admin");
  });
  it("global rate limit bounds cheap requests too", async () => {
    const f = await start();
    for (let i = 0; i < READINESS_LIMITS.maxRequestsPerMinute; i++) expect((await getReadiness(f.port, "/no-route")).code).toBe(404);
    expect((await getReadiness(f.port, "/_health/live")).code).toBe(429); expect(f.probe).toHaveBeenCalledTimes(1);
  });
  it("permits at most one in-flight probe; no waiting request queue", async () => {
    const f = await start(); let complete!: (value: ReadinessWitness) => void;
    f.probe.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const first = getReadiness(f.port); await vi.waitFor(() => expect(f.server.snapshot().busy).toBe(true));
    expect((await getReadiness(f.port)).code).toBe(429); expect(f.probe).toHaveBeenCalledTimes(2);
    complete(witness()); expect((await first).code).toBe(200);
  });
  it("stale assertion/provider failure permanently quarantines readiness, not liveness", async () => {
    for (const throws of [false, true]) {
      const f = await start(); f.probe.mockImplementationOnce(async () => {
        if (throws) throw Error("SECRET"); return { assertCurrent() { throw Error("SECRET"); } };
      });
      const result = await getReadiness(f.port); expect(result.code).toBe(503); expect(result.body).not.toContain("SECRET");
      expect((await getReadiness(f.port)).code).toBe(503); expect((await getReadiness(f.port, "/_health/live")).code).toBe(200);
      expect(f.probe).toHaveBeenCalledTimes(2); expect(f.server.snapshot().phase).toBe("quarantined");
    }
  });
  it("a hanging probe is aborted at the application deadline, never retried", async () => {
    // The socket has the same absolute safety budget; either 503 or closed is
    // valid when transport and application timers expire in the same tick.
    const f = await start(undefined, { port: 0, requestTimeoutMs: 1000, drainTimeoutMs: 1000 }); let signal: AbortSignal | undefined;
    f.probe.mockImplementationOnce(s => { signal = s; return new Promise(() => {}); });
    await getReadiness(f.port).catch(() => undefined);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(f.server.snapshot().phase).toBe("quarantined"); expect(f.probe).toHaveBeenCalledTimes(2);
  });
  it("client disconnect aborts the probe and quarantines instead of orphaning work", async () => {
    const f = await start(); let signal: AbortSignal | undefined;
    f.probe.mockImplementationOnce(s => { signal = s; return new Promise(() => {}); });
    const socket = connect(f.port, "127.0.0.1"); await once(socket, "connect");
    socket.write("GET /_health/ready HTTP/1.1\r\nHost: staging.signatures.gallery\r\nX-Forwarded-Proto: https\r\n\r\n");
    await vi.waitFor(() => expect(signal).toBeDefined()); socket.destroy();
    await vi.waitFor(() => expect(signal!.aborted).toBe(true)); expect(f.server.snapshot().phase).toBe("quarantined");
  });
  async function raw(port: number, text: string) {
    const socket = connect(port, "127.0.0.1"); let data = ""; socket.on("data", chunk => { data += chunk; });
    await once(socket, "connect"); const closed = socketClosed(socket); socket.write(text); await closed; return data;
  }
  it.each([
    "GET /_health/ready HTTP/1.0\r\nHost: staging.signatures.gallery\r\nX-Forwarded-Proto: https\r\n\r\n",
    "GET /_health/ready HTTP/1.1\r\nHost: staging.signatures.gallery\r\nX-Forwarded-Proto: https\r\nX-A: 1\r\nx-a: 2\r\n\r\n",
    "GET /_health/ready HTTP/1.1\r\nHost: staging.signatures.gallery\r\nX-Forwarded-Proto: https\r\n" + Array.from({ length: 31 }, (_, i) => `X-${i}: a\r\n`).join("") + "\r\n",
    "GET /_health/ready HTTP/1.1\r\nHost: staging.signatures.gallery\r\nX-Forwarded-Proto: https\r\nX-Big: " + "x".repeat(8192) + "\r\n\r\n",
    "GET /_health/ready HTTP/1.1\r\nHost: staging.signatures.gallery\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    "CONNECT staging.signatures.gallery:443 HTTP/1.1\r\nHost: staging.signatures.gallery\r\n\r\n",
    "GET /_health/ready HTTP/1.1\r\nHost: ",
  ])("refuses raw/slow malformed ingress (%#)", async text => {
    const f = await start(undefined, { port: 0, requestTimeoutMs: 1000, drainTimeoutMs: 1000 });
    const result = await raw(f.port, text); expect(result).not.toContain("200 OK"); expect(f.probe).toHaveBeenCalledTimes(1);
  });
  it("port collision returns sanitized refusal; shutdown does not close another listener", async () => {
    const f = await start(), other = fixture(undefined, { ...defaults, port: f.port }); servers.push(other);
    await expect(other.server.start()).rejects.toThrow("Paused staging readiness unavailable.");
    expect((await getReadiness(f.port, "/_health/live")).code).toBe(200);
  });
  it("closes idle incomplete sockets within its own drain budget", async () => {
    const f = await start(undefined, { port: 0, requestTimeoutMs: 1000, drainTimeoutMs: 1000 });
    const socket = connect(f.port, "127.0.0.1"); await once(socket, "connect"); socket.write("GET /");
    const closed = socketClosed(socket); await f.server.close(); await closed; expect(f.server.snapshot().phase).toBe("closed");
  });
  it("absolute connection deadline defeats header dripping that avoids idle timeouts", async () => {
    const f = await start(undefined, { port: 0, requestTimeoutMs: 1000, drainTimeoutMs: 1000 });
    const socket = connect(f.port, "127.0.0.1"); await once(socket, "connect"); const started = Date.now();
    socket.write("GET /_health/ready HTTP/1.1\r\nX-Drip: ");
    const drip = setInterval(() => socket.write("x"), 25);
    try { await socketClosed(socket); } finally { clearInterval(drip); socket.destroy(); }
    expect(Date.now() - started).toBeLessThan(2000); expect(f.probe).toHaveBeenCalledTimes(1);
  });
  it("closes a listener if evidence becomes invalid while listen is completing", async () => {
    let n = 0;
    const f = fixture(vi.fn(async () => ({ assertCurrent() { if (++n === 3) throw Error("expired"); } }))); servers.push(f);
    await expect(f.server.start()).rejects.toThrow(); expect(f.server.address()).toBeUndefined(); expect(f.server.snapshot().phase).toBe("closed");
  });
  it("shutdown racing the asynchronous listen does not leak a socket", async () => {
    let n = 0;
    const f = fixture(vi.fn(async () => ({ assertCurrent() { if (++n === 2) queueMicrotask(() => { void f.server.close(); }); } }))); servers.push(f);
    await expect(f.server.start()).rejects.toThrow();
    await new Promise(resolve => setImmediate(resolve)); expect(f.server.address()).toBeUndefined(); expect(f.server.snapshot().phase).toBe("closed");
  });
});
