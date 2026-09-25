import { performance } from "node:perf_hooks";
import { http } from "viem";

export type PublicChainReadMethod = "eth_chainId" | "eth_getBlockByNumber" | "eth_getCode" | "eth_call" | "eth_getLogs" | "eth_getTransactionReceipt" | "eth_getTransactionByHash" | "eth_getTransactionCount";
/** Implementations must honor cancellation. No transaction/signing methods exist. */
export interface PublicChainRpc {
  readonly id: string;
  request(method: PublicChainReadMethod, params: readonly unknown[], signal: AbortSignal): Promise<unknown>;
}
const METHODS = ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_getLogs", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getTransactionCount"] as const;

/** The injected fetch must enforce the operator's DNS/egress policy. This
 * transport adds no fallback RPC, retries, redirect following, or wallet. */
export function createPublicChainHttpRpc(options: {
  id: string; url: string; timeoutMs: number; maxResponseBytes: number;
  fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): PublicChainRpc {
  const url = new URL(options.url);
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(options.id) || url.protocol !== "https:" || url.username || url.password || url.hash
    || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal|invalid|test|onion)$/.test(url.hostname)
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000
    || !Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1024 || options.maxResponseBytes > 1_048_576
    || typeof options.fetchFn !== "function") throw new Error("Invalid explicit read-only RPC configuration.");
  const fetchFn = options.fetchFn, maxResponseBytes = options.maxResponseBytes;
  // viem forwards this request's signal unchanged to fetch. Keep deadlines
  // per signal so concurrent reads never renew or overwrite one another.
  const checks = new WeakMap<AbortSignal, () => void>();
  // viem does not correlate response IDs itself. Validate the bounded envelope
  // before returning its bytes to the normal viem HTTP/error/ABI path.
  const checkedFetch: typeof fetchFn = async (input, init) => {
    const check = init?.signal ? checks.get(init.signal) : undefined;
    if (!check) throw new Error("Missing RPC deadline context.");
    check();
    const request = JSON.parse(String(init?.body)) as { id: unknown };
    const response = await fetchFn(input, init), declaredSize = response.headers.get("content-length");
    try { check(); } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
    if (declaredSize !== null && (!/^(?:0|[1-9]\d*)$/.test(declaredSize) || Number(declaredSize) > maxResponseBytes)) {
      void response.body?.cancel().catch(() => {});
      throw new Error("RPC response exceeds its byte limit.");
    }
    if (!response.body) throw new Error("Missing RPC response body.");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0, finished = false, reads = 0;
    try {
      while (true) {
        check();
        const next = await reader.read();
        check();
        if (next.done) { finished = true; break; }
        // Also bound empty/tiny-chunk streams, which can otherwise spin in
        // microtasks without giving the request deadline timer a chance to run.
        if (++reads > 4096 || !(next.value instanceof Uint8Array)) throw new Error("Invalid or excessively fragmented RPC body.");
        size += next.value.length;
        if (size > maxResponseBytes) throw new Error("RPC response exceeds its byte limit.");
        chunks.push(next.value);
      }
    } finally {
      if (!finished) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), envelope: unknown = JSON.parse(text);
    check();
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Invalid RPC response envelope.");
    const value = envelope as Record<string, unknown>, hasResult = Object.hasOwn(value, "result"), hasError = Object.hasOwn(value, "error");
    if (value.jsonrpc !== "2.0" || !Object.hasOwn(value, "id") || value.id !== request.id || hasResult === hasError) throw new Error("Invalid RPC response envelope.");
    if (hasError) {
      const error = value.error as Record<string, unknown> | null;
      if (!error || typeof error !== "object" || Array.isArray(error) || !Number.isSafeInteger(error.code) || typeof error.message !== "string") throw new Error("Invalid RPC error envelope.");
    }
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json"); headers.set("content-length", String(size)); headers.delete("content-encoding");
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
  };
  const transport = http(url.href, { fetchFn: checkedFetch, fetchOptions: { redirect: "error" }, batch: false,
    retryCount: 0, timeout: options.timeoutMs, maxResponseBodySize: options.maxResponseBytes, methods: { include: [...METHODS] } })({});
  // viem's standard RPC schema predates EIP-1898 for some methods; retain the
  // block-hash selector on the wire, never substitute a numeric/latest block.
  const request = transport.request as unknown as (args: { method: string; params: readonly unknown[] }, options: { signal: AbortSignal; retryCount: number }) => Promise<unknown>;
  const timeoutMs = options.timeoutMs;
  return Object.freeze({ id: options.id, async request(method: PublicChainReadMethod, params: readonly unknown[], signal: AbortSignal) {
    const deadlineAt = performance.now() + timeoutMs;
    if (!(METHODS as readonly string[]).includes(method)) throw new Error("RPC method is not read-only.");
    const controller = new AbortController();
    const check = () => {
      if (performance.now() >= deadlineAt) { controller.abort(); throw new Error("RPC read timed out."); }
      if (signal.aborted || controller.signal.aborted) throw new Error("RPC read cancelled.");
    };
    checks.set(controller.signal, check);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const stop = new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); reject(new Error("RPC read cancelled.")); };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new Error("RPC read timed out.")); }, timeoutMs);
    });
    try {
      check();
      // Cover response-body reads too, not just the HTTP response headers.
      const result = await Promise.race([request({ method, params }, { signal: controller.signal, retryCount: 0 }), stop]);
      check(); return result;
    } finally {
      controller.abort();
      checks.delete(controller.signal);
      clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
    }
  } });
}
