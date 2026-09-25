import type { AssessmentExecution, ProviderLeg, ProviderReceipt } from "./assessmentOperations.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const reference = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) ? value : undefined;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const ticks = (value: unknown): string | undefined => integer(value) ? String(value)
  : typeof value === "string" && /^(?:0|[1-9][0-9]{0,29})$/.test(value) ? value : undefined;

/** Dated wire contract: https://docs.x.ai/developers/rest-api-reference/inference/responses.md (2026-09-19).
 * USD ticks are the provider's actual total, including its tools; citations are never a billing meter.
 * X username lookup has no documented per-request billing field, so its cost stays unknown.
 */
export function providerReceipt(input: {
  leg: ProviderLeg; startedAt: number; completedAt: number; category: ProviderReceipt["category"];
  response?: Response; payload?: unknown;
}): ProviderReceipt {
  const payload = record(input.payload);
  const receipt: ProviderReceipt = { leg: input.leg, startedAt: input.startedAt, completedAt: input.completedAt,
    category: input.category, usageStatus: "missing", cost: { status: "unknown", currency: "USD", scale: 10 } };
  if (input.response) {
    receipt.httpStatus = input.response.status;
    const requestId = reference(input.response.headers.get("x-request-id"));
    if (requestId) receipt.requestId = requestId;
  }
  if (input.leg !== "grok") return receipt;
  const responseId = reference(payload?.id), model = reference(payload?.model);
  if (responseId) receipt.responseId = responseId;
  if (model) receipt.model = model;
  if (payload?.usage === undefined || payload.usage === null) return receipt;
  const raw = record(payload.usage);
  if (!raw) { receipt.usageStatus = "invalid"; return receipt; }
  const usage: NonNullable<ProviderReceipt["usage"]> = {};
  let invalid = false;
  const count = (source: Record<string, unknown>, key: string, target: keyof typeof usage) => {
    if (source[key] === undefined) return;
    if (!integer(source[key])) { invalid = true; return; }
    Object.assign(usage, { [target]: source[key] });
  };
  count(raw, "input_tokens", "inputTokens");
  count(raw, "output_tokens", "outputTokens");
  count(raw, "total_tokens", "totalTokens");
  count(raw, "num_server_side_tools_used", "serverSideToolCalls");
  for (const [key, source, target] of [
    ["input_tokens_details", "cached_tokens", "cachedInputTokens"],
    ["output_tokens_details", "reasoning_tokens", "reasoningTokens"],
    ["server_side_tool_usage_details", "x_search_calls", "searchCalls"],
  ] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const detail = record(raw[key]);
    if (!detail) invalid = true;
    else count(detail, source, target);
  }
  const hasTicks = raw.cost_in_usd_ticks !== undefined && raw.cost_in_usd_ticks !== null;
  const hasNano = raw.cost_in_nano_usd !== undefined && raw.cost_in_nano_usd !== null;
  if (hasTicks || hasNano) {
    const tickAmount = hasTicks ? ticks(raw.cost_in_usd_ticks) : undefined;
    const nanoAmount = hasNano && integer(raw.cost_in_nano_usd) ? String(BigInt(raw.cost_in_nano_usd) * 10n) : undefined;
    if ((hasTicks && tickAmount === undefined) || (hasNano && nanoAmount === undefined)
      || (tickAmount !== undefined && nanoAmount !== undefined && tickAmount !== nanoAmount)) invalid = true;
    else {
      const amount = tickAmount ?? nanoAmount!;
      usage.costInUsdTicks = amount;
      receipt.cost = { status: "actual", currency: "USD", scale: 10, amount };
    }
  }
  if (usage.cachedInputTokens !== undefined && usage.inputTokens !== undefined && usage.cachedInputTokens > usage.inputTokens) invalid = true;
  if (usage.reasoningTokens !== undefined && usage.outputTokens !== undefined && usage.reasoningTokens > usage.outputTokens) invalid = true;
  if (usage.searchCalls !== undefined && usage.serverSideToolCalls !== undefined && usage.searchCalls > usage.serverSideToolCalls) invalid = true;
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined && usage.totalTokens !== undefined
    && BigInt(usage.inputTokens) + BigInt(usage.outputTokens) !== BigInt(usage.totalTokens)) invalid = true;
  receipt.usageStatus = invalid ? "invalid" : Object.keys(usage).length ? "valid" : "missing";
  if (receipt.usageStatus === "valid") receipt.usage = usage;
  return receipt;
}

class BodyFailure extends Error {
  constructor(readonly category: "invalid-body" | "oversized-body", message: string) { super(message); }
}

async function boundedJson(response: Response, limit: number, prefix: string, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    void response.body?.cancel().catch(() => {});
    throw new BodyFailure("oversized-body", `${prefix} response exceeds size limit.`);
  }
  if (!response.body) throw new BodyFailure("invalid-body", `${prefix} returned an empty response.`);
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0, body = "";
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { cancel(); throw new BodyFailure("oversized-body", `${prefix} response exceeds size limit.`); }
      body += decoder.decode(next.value, { stream: true });
    }
    if (signal.aborted) throw new Error("aborted");
    body += decoder.decode();
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof BodyFailure) throw error;
    throw new BodyFailure("invalid-body", `${prefix} returned invalid ${prefix === "Grok" ? "response JSON" : "JSON"}.`);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Exactly one transport terminal state writes a receipt. Losing timeout work cannot validate or persist a later result. */
export async function receiptedJsonRequest(options: {
  leg: ProviderLeg; timeoutMs: number; maxBytes: number; bodyPrefix: string;
  transportError: string; timeoutError: string; httpError(status: number): string;
  fetch(signal: AbortSignal): Promise<Response>; execution?: AssessmentExecution;
}): Promise<unknown> {
  const startedAt = Date.now(), controller = new AbortController();
  const dispatch = options.execution?.dispatch, signal = dispatch?.signal;
  const begin = dispatch?.beginDispatch?.bind(dispatch) ?? dispatch?.assertCurrent.bind(dispatch);
  const complete = dispatch?.assertCompletion?.bind(dispatch) ?? dispatch?.assertCurrent.bind(dispatch);
  const assertCheckpoint = (guard: typeof begin) => {
    if (signal?.aborted || (guard && guard(options.leg) !== undefined)) throw new Error("Provider dispatch unavailable.");
  };
  let response: Response | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  type Terminal = { category: ProviderReceipt["category"]; payload?: unknown; error?: string };
  let cancel!: () => void;
  const timeout = new Promise<Terminal>(resolve => {
    cancel = () => {
      // Cancellation cannot undo a dispatched request or establish zero cost.
      resolve({ category: "transport-error", error: options.transportError });
      controller.abort();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      // Resolve first: abort-triggered rejection must not win the race with a different category.
      resolve({ category: "timeout", error: options.timeoutError });
      controller.abort();
    }, options.timeoutMs);
  });
  const request = async (): Promise<Terminal> => {
    // No await between the synchronous admission checkpoint and actual fetch.
    // A denial here emits NO receipt: it is not evidence of a provider call.
    assertCheckpoint(begin);
    try {
      const received = await options.fetch(controller.signal);
      if (controller.signal.aborted) { void received.body?.cancel().catch(() => {}); return { category: "timeout", error: options.timeoutError }; }
      response = received;
    } catch { return { category: "transport-error", error: options.transportError }; }
    try {
      const payload = await boundedJson(response, options.maxBytes, options.bodyPrefix, controller.signal);
      return response.ok ? { category: "success", payload } : { category: "http-error", payload, error: options.httpError(response.status) };
    } catch (error) {
      return { category: error instanceof BodyFailure ? error.category : "invalid-body",
        error: response.ok ? (error instanceof BodyFailure ? error.message : `${options.bodyPrefix} returned invalid JSON.`) : options.httpError(response.status) };
    }
  };
  let terminal: Terminal;
  try { terminal = await Promise.race([request(), timeout]); }
  finally { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  const completedAt = Math.max(startedAt, Date.now());
  await options.execution?.recordReceipt(providerReceipt({ leg: options.leg, startedAt, completedAt,
    category: terminal.category, response, payload: terminal.payload }));
  if (terminal.error) throw new Error(terminal.error);
  // Persist observed accounting even if permission was withdrawn in flight;
  // Completion is NOT a fresh dispatch authorization. A reviewed completion
  // window may outlive its original RPC witness, but not withdrawal/cancellation.
  assertCheckpoint(complete);
  return terminal.payload;
}
