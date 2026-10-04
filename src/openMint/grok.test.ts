import { afterEach, describe, expect, it, vi } from "vitest";
import { DevelopmentAssessmentProvider, GROK_DEFAULT_MODEL, GROK_MAX_RESPONSE_BYTES, GROK_RESPONSES_ENDPOINT, GrokAssessmentProvider, ProviderResponseInvalidError, validateGrokResponse } from "./grok.js";
import type { XIdentitySnapshot } from "./xIdentity.js";
import type { ProviderAssessment, ProviderAbstention } from "./assessment.js";
import type { AssessmentExecution, ProviderReceipt } from "./assessmentOperations.js";
import { GROK_PILOT_PROFILE } from "./providerProfile.js";
import { GROK_INSTRUCTIONS } from "./grokInstructions.js";

function accepted(value: ProviderAssessment | ProviderAbstention): ProviderAssessment {
  if ("kind" in value) throw new Error("Expected accepted assessment");
  return value;
}
function executionRecorder() {
  const receipts: ProviderReceipt[] = [];
  const execution: AssessmentExecution = { attemptId: "attempt-test", beforeDispatch: vi.fn(async () => {}),
    recordReceipt: vi.fn(async receipt => { receipts.push(receipt); }), identityVerified: vi.fn(async () => {}),
    recordOutcome: vi.fn(async () => {}), assessmentPersisted: vi.fn(async () => {}) };
  return { execution, receipts };
}

function validResponse() {
  return {
    id: "response-123", model: GROK_DEFAULT_MODEL, status: "completed", error: null, incomplete_details: null,
    citations: ["https://x.com/alice/status/12345", "https://example.org/source"],
    output: [
      { type: "x_search_call", id: "search-1", status: "completed" },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ handle: "alice", mbti: "INTJ" }), annotations: [] }] },
    ],
  };
}
function stubFetch(value: unknown = validResponse()) {
  return vi.fn(async () => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("trusted direct Grok X Search assessment", () => {
  const identity: XIdentitySnapshot = { canonicalHandle: "alice", username: "ALIce", userId: "1234", verifiedAt: "2026-09-16T00:00:00.000Z", provenance: "x-api", freshness: "verified-at-preparation" };
  it("binds native X Search and structured assessment to the authenticated lookup subject", async () => {
    const response = validResponse();
    response.output[1].content![0].text = JSON.stringify({ handle: "alice", mbti: "INTJ", xUserId: identity.userId });
    const transport = stubFetch(response);
    const result = await new GrokAssessmentProvider({ apiKey: "mock-key", fetch: transport }).assess("ALICE", identity);
    expect(result.xUserId).toBe(identity.userId);
    const body = JSON.parse(String(vi.mocked(transport).mock.calls[0][1]?.body));
    expect(body.input[0].content).toContain("@ALIce");
    expect(body.input[0].content).toContain("https://x.com/i/user/1234");
    expect(body.tools).toEqual([{ type: "x_search", allowed_x_handles: ["alice"] }]);
    expect(body.text.format.schema.required).toContain("xUserId");
    expect(body.text.format.schema.properties.xUserId).toEqual({ type: "string", const: "1234" });
  });
  it("rejects unbound, wrong-account and unrelated-evidence conclusions", () => {
    const response = validResponse();
    expect(() => validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL, identity)).toThrow();
    response.output[1].content![0].text = JSON.stringify({ handle: "alice", mbti: "INTJ", xUserId: "9999" });
    expect(() => validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL, identity)).toThrow("X account mismatch");
    response.output[1].content![0].text = JSON.stringify({ handle: "alice", mbti: "INTJ", xUserId: "1234" });
    for (const source of ["https://x.com/bob/status/123", "https://x.com/i/user/9999", "https://x.com/i/status/123"]) {
      response.citations = [source];
      expect(() => validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL, identity)).toThrow("verified X subject");
    }
    response.citations = ["https://x.com/i/user/1234"];
    expect(validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL, identity).xUserId).toBe("1234");
  });
  it("sends a fresh native X Search request with server schema and returns provider citations", async () => {
    const transport = stubFetch();
    const provider = new GrokAssessmentProvider({ apiKey: "test-server-key", fetch: transport });
    const result = await provider.assess("@ALICE");
    expect(result).toEqual({ handle: "alice", mbti: "INTJ", model: GROK_DEFAULT_MODEL, providerResponseId: "response-123", sourceUrls: ["https://example.org/source", "https://x.com/alice/status/12345"] });
    const [url, options] = vi.mocked(transport).mock.calls[0];
    expect(url).toBe(GROK_RESPONSES_ENDPOINT);
    expect(options?.redirect).toBe("error");
    const body = JSON.parse(String(options?.body));
    expect(body.instructions).toBe(GROK_INSTRUCTIONS);
    expect(body.tools).toEqual([{ type: "x_search", allowed_x_handles: ["alice"] }]);
    expect(body.model).toBe(GROK_DEFAULT_MODEL);
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(body.text.format.schema.properties.handle.const).toBe("alice");
    expect(body.previous_response_id).toBeUndefined();
    expect(body.store).toBe(false);
    expect(JSON.stringify(result)).not.toContain("test-server-key");
  });

  const invalid: [string, (value: ReturnType<typeof validResponse>) => void][] = [
    ["failed response", (r) => { r.status = "failed"; }],
    ["truncated response", (r) => { r.status = "incomplete"; }],
    ["error envelope", (r) => { Object.assign(r, { error: { message: "provider failure" } }); }],
    ["incomplete details", (r) => { Object.assign(r, { incomplete_details: { reason: "max_output_tokens" } }); }],
    ["missing provider ID", (r) => { r.id = ""; }],
    ["fixture provider ID", (r) => { r.id = "development-fixture:123"; }],
    ["wrong model", (r) => { r.model = "client-chosen-model"; }],
    ["no X Search execution", (r) => { r.output.shift(); }],
    ["failed X Search", (r) => { r.output[0].status = "failed"; }],
    ["unproved X Search", (r) => { delete (r.output[0] as { status?: string }).status; }],
    ["web search is not X Search", (r) => { r.output[0].type = "web_search_call"; }],
    ["no citations", (r) => { r.citations = []; }],
    ["no X sources", (r) => { r.citations = ["https://example.com/alice"]; }],
    ["misleading X host", (r) => { r.citations = ["https://x.com.evil.example/alice"]; }],
    ["unsafe source scheme", (r) => { r.citations = ["javascript:alert(1)"]; }],
    ["wrong account replay", (r) => { r.output[1].content![0].text = '{"handle":"bob","mbti":"INTJ"}'; }],
    ["wrong casing", (r) => { r.output[1].content![0].text = '{"handle":"ALICE","mbti":"INTJ"}'; }],
    ["invalid MBTI", (r) => { r.output[1].content![0].text = '{"handle":"alice","mbti":"XXXX"}'; }],
    ["extra client seed", (r) => { r.output[1].content![0].text = '{"handle":"alice","mbti":"INTJ","seed":99}'; }],
    ["model authored citations", (r) => { r.output[1].content![0].text = '{"handle":"alice","mbti":"INTJ","sourceUrls":["https://x.com/alice"]}'; }],
    ["refusal content", (r) => { r.output[1].content![0].type = "refusal"; }],
    ["malformed JSON", (r) => { r.output[1].content![0].text = '{"handle":"alice",'; }],
    ["multiple conclusions", (r) => { r.output.push(r.output[1]); }],
  ];
  it.each(invalid)("rejects %s", (_, alter) => {
    const response = validResponse(); alter(response);
    expect(() => validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL)).toThrow();
  });

  it("accepts documented provider url citation annotations", () => {
    const response = validResponse(); response.citations = [];
    Object.assign(response.output[1].content![0], { annotations: [{ type: "url_citation", url: "https://x.com/i/status/123" }] });
    expect(accepted(validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL)).sourceUrls).toEqual(["https://x.com/i/status/123"]);
  });

  it("rejects public object payloads before spending a provider call", async () => {
    const transport = stubFetch();
    const provider = new GrokAssessmentProvider({ apiKey: "server-key", fetch: transport });
    await expect(provider.assess({ handle: "alice", mbti: "INTJ", model: "evil" } as never)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not retry or fall back after transport failure and does not leak secrets", async () => {
    const transport = vi.fn(async () => { throw new Error("transport-secret-key"); }) as unknown as typeof fetch;
    const provider = new GrokAssessmentProvider({ apiKey: "transport-secret-key", fetch: transport });
    await expect(provider.assess("alice")).rejects.toThrow("Grok transport failed.");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(provider.provenance).toBe("grok");
  });

  it("fails HTTP errors without returning upstream bodies", async () => {
    const transport = vi.fn(async () => new Response("private provider message", { status: 401 })) as unknown as typeof fetch;
    const provider = new GrokAssessmentProvider({ apiKey: "key", fetch: transport });
    await expect(provider.assess("alice")).rejects.toThrow("Grok request failed (HTTP 401).");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("bounds the complete transport operation even when fetch ignores cancellation", async () => {
    const transport = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    const provider = new GrokAssessmentProvider({ apiKey: "key", fetch: transport, timeoutMs: 10 });
    await expect(provider.assess("alice")).rejects.toThrow("timed out");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transport).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it.each([true, false])("bounds oversized provider body with content-length=%s", async (declared) => {
    const transport = vi.fn(async () => new Response("x".repeat(GROK_MAX_RESPONSE_BYTES + 1), {
      headers: declared ? { "content-length": String(GROK_MAX_RESPONSE_BYTES + 1) } : {},
    })) as unknown as typeof fetch;
    await expect(new GrokAssessmentProvider({ apiKey: "key", fetch: transport }).assess("alice")).rejects.toThrow("size limit");
  });

  it("requires explicit fixture construction and marks its outputs", async () => {
    expect(() => new GrokAssessmentProvider({ apiKey: "" })).toThrow("API key");
    const fixture = new DevelopmentAssessmentProvider();
    expect(fixture.provenance).toBe("development-fixture");
    expect(await fixture.assess("@ALICE")).toEqual(await fixture.assess("alice"));
    expect((await fixture.assess("alice")).providerResponseId).toMatch(/^development-fixture:/);
  });

  it.each([null, undefined, [], "response", 1])("rejects malformed response envelopes: %j", (value) => {
    expect(() => validateGrokResponse(value, "alice", GROK_DEFAULT_MODEL)).toThrow("did not complete");
  });

  const malformedOutputs: [string, (value: ReturnType<typeof validResponse>) => void, string][] = [
    ["absent outputs", (r) => { Object.assign(r, { output: undefined }); }, "output is missing"],
    ["non-array outputs", (r) => { Object.assign(r, { output: {} }); }, "output is missing"],
    ["empty outputs", (r) => { r.output = []; }, "output is missing"],
    ["too many outputs", (r) => { r.output = Array.from({ length: 257 }, () => r.output[0]); }, "output is missing"],
    ["null output", (r) => { r.output.push(null as never); }, "incomplete or failed output"],
    ["per-output error", (r) => { Object.assign(r.output[0], { error: { message: "search failed" } }); }, "incomplete or failed output"],
    ["unrecognized tool alongside valid search", (r) => { r.output.push({ type: "web_search_call", id: "web-search-1", status: "completed" }); }, "Unexpected Grok output type"],
    ["wrong message role", (r) => { r.output[1].role = "user"; }, "Invalid Grok message"],
    ["non-array message content", (r) => { Object.assign(r.output[1], { content: {} }); }, "Invalid Grok message"],
    ["too much message content", (r) => { r.output[1].content = Array.from({ length: 33 }, () => r.output[1].content![0]); }, "Invalid Grok message"],
    ["null content", (r) => { r.output[1].content = [null as never]; }, "invalid assessment content"],
    ["non-string text", (r) => { Object.assign(r.output[1].content![0], { text: 42 }); }, "invalid assessment content"],
    ["oversized assessment text", (r) => { r.output[1].content![0].text = " ".repeat(4097); }, "text exceeds size limit"],
    ["no structured conclusion", (r) => { r.output.pop(); }, "exactly one structured assessment"],
    ["non-array citations", (r) => { Object.assign(r, { citations: {} }); }, "Invalid Grok citations"],
    ["too many citations", (r) => { r.citations = Array.from({ length: 129 }, () => "https://x.com/alice"); }, "Invalid Grok citations"],
    ["non-array annotations", (r) => { Object.assign(r.output[1].content![0], { annotations: {} }); }, "citation annotations"],
    ["too many annotations", (r) => { Object.assign(r.output[1].content![0], { annotations: Array.from({ length: 129 }, () => ({})) }); }, "citation annotations"],
    ["missing URL in a URL citation", (r) => { Object.assign(r.output[1].content![0], { annotations: [{ type: "url_citation" }] }); }, "source URL"],
    ["JSON array conclusion", (r) => { r.output[1].content![0].text = '[]'; }, "Invalid Grok assessment"],
    ["JSON null conclusion", (r) => { r.output[1].content![0].text = 'null'; }, "Invalid Grok assessment"],
  ];
  it.each(malformedOutputs)("rejects %s", (_, alter, message) => {
    const response = validResponse(); alter(response);
    expect(() => validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL)).toThrow(message);
  });

  it("accepts optional-envelope omissions, reasoning, and absent text annotations", () => {
    const response = validResponse();
    Reflect.deleteProperty(response, "error");
    Reflect.deleteProperty(response, "incomplete_details");
    Reflect.deleteProperty(response.output[1], "status");
    Reflect.deleteProperty(response.output[1].content![0], "annotations");
    response.output.unshift({ type: "reasoning", id: "reasoning-1", status: "completed" });
    const result = accepted(validateGrokResponse(response, "@ALICE", GROK_DEFAULT_MODEL));
    expect(result.mbti).toBe("INTJ");
    expect(result.sourceUrls).toEqual(["https://example.org/source", "https://x.com/alice/status/12345"]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("combines and deduplicates provider citations, ignoring non-URL annotation metadata", () => {
    const response = validResponse();
    Object.assign(response.output[1].content![0], { annotations: [
      null, { type: "other_annotation", url: "https://untrusted.example" },
      { type: "url_citation", url: "https://x.com/alice/status/12345" },
      { type: "url_citation", url: "https://x.com/alice/status/23456" },
    ] });
    expect(accepted(validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL)).sourceUrls).toEqual([
      "https://example.org/source", "https://x.com/alice/status/12345", "https://x.com/alice/status/23456",
    ]);
    Reflect.deleteProperty(response, "citations");
    expect(accepted(validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL)).sourceUrls).toHaveLength(2);
  });

  it("bounds the merged evidence set even when each metadata source meets its own limit", () => {
    const response = validResponse();
    response.citations = Array.from({ length: 128 }, (_, i) => `https://x.com/alice/status/${i}`);
    Object.assign(response.output[1].content![0], { annotations: [{ type: "url_citation", url: "https://x.com/alice/status/999" }] });
    expect(() => validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL)).toThrow("source references");
  });

  it.each([" ", "key\rvalue", "key\nvalue", null, 123])("rejects invalid API key configuration: %j", (apiKey) => {
    expect(() => new GrokAssessmentProvider({ apiKey: apiKey as string })).toThrow("API key");
  });

  it.each(["", "other-model", "grok-", "grok-model\n", `grok-${"x".repeat(121)}`])("rejects invalid server model: %j", (model) => {
    expect(() => new GrokAssessmentProvider({ apiKey: "key", model })).toThrow("server Grok model");
  });

  it.each([0, -1, 1.5, 120001, NaN, Infinity])("rejects invalid timeout: %s", (timeoutMs) => {
    expect(() => new GrokAssessmentProvider({ apiKey: "key", timeoutMs })).toThrow("Grok timeout");
  });

  it("uses the configured server model and default fetch without allowing caller overrides", async () => {
    const response = validResponse(); response.model = "grok-custom-test";
    const transport = stubFetch(response);
    vi.stubGlobal("fetch", transport);
    const result = await new GrokAssessmentProvider({ apiKey: "test-only-key", model: response.model }).assess("alice");
    expect(result.model).toBe(response.model);
    const options = vi.mocked(transport).mock.calls[0][1];
    expect(JSON.parse(String(options?.body)).model).toBe(response.model);
    expect(options?.headers).toMatchObject({ Authorization: "Bearer test-only-key" });
  });

  it.each(["-1", "not-a-number", "1.5"])("rejects malformed declared response lengths: %s", async (length) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const transport = vi.fn(async () => new Response(body, { headers: { "content-length": length } })) as unknown as typeof fetch;
    await expect(new GrokAssessmentProvider({ apiKey: "key", fetch: transport }).assess("alice")).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing body", () => new Response(null), "empty response"],
    ["invalid JSON body", () => new Response("provider returned HTML"), "invalid response JSON"],
  ] as const)("rejects %s without retrying", async (_, response, message) => {
    const transport = vi.fn(async () => response()) as unknown as typeof fetch;
    await expect(new GrokAssessmentProvider({ apiKey: "key", fetch: transport }).assess("alice")).rejects.toThrow(message);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid response exactly at the byte limit", async () => {
    const json = JSON.stringify(validResponse());
    const body = json.padEnd(GROK_MAX_RESPONSE_BYTES, " ");
    const transport = vi.fn(async () => new Response(body, { headers: { "content-length": String(GROK_MAX_RESPONSE_BYTES) } })) as unknown as typeof fetch;
    expect(accepted(await new GrokAssessmentProvider({ apiKey: "key", fetch: transport }).assess("alice")).mbti).toBe("INTJ");
  });

  it("fails malformed UTF-8 rather than parsing replacement characters", async () => {
    const body = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
    const transport = vi.fn(async () => new Response(body)) as unknown as typeof fetch;
    await expect(new GrokAssessmentProvider({ apiKey: "key", fetch: transport }).assess("alice")).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("aborts a cooperative transport on timeout and clears its timer", async () => {
    vi.useFakeTimers();
    const transport = vi.fn((_url: unknown, options?: RequestInit) => new Promise<Response>((_, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("private transport details")), { once: true });
    })) as unknown as typeof fetch;
    const pending = new GrokAssessmentProvider({ apiKey: "key", fetch: transport, timeoutMs: 25 }).assess("alice");
    const failure = expect(pending).rejects.toThrow("Grok assessment timed out.");
    await vi.advanceTimersByTimeAsync(25);
    await failure;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["insufficient-evidence", "subject-unavailable", "provider-refusal"] as const)("allows %s without fabricating a type or citations", async reason => {
    const response = validResponse(); response.citations = []; response.output.shift();
    response.output[0].content![0].text = JSON.stringify({ handle: "alice", kind: "abstained", mbti: null, reason, xUserId: identity.userId });
    Object.assign(response, { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, cost_in_usd_ticks: 51 } });
    const { execution, receipts } = executionRecorder();
    const result = await new GrokAssessmentProvider({ apiKey: "key", fetch: stubFetch(response) }).assess("alice", identity, execution);
    expect(result).toEqual({ kind: "abstained", reason, handle: "alice", xUserId: identity.userId, model: GROK_DEFAULT_MODEL, providerResponseId: response.id });
    expect(result).not.toHaveProperty("mbti");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ category: "success", cost: { status: "actual", amount: "51" } });
    expect(execution.beforeDispatch).not.toHaveBeenCalled();
  });

  it("accepts the discriminated accepted wire shape while keeping the immutable accepted result shape", () => {
    const response = validResponse();
    response.output[1].content![0].text = JSON.stringify({ handle: "alice", kind: "accepted", mbti: "INTJ", reason: null });
    const result = accepted(validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL));
    expect(result.mbti).toBe("INTJ");
    expect(result).not.toHaveProperty("kind");
    response.output.shift();
    expect(() => validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL)).toThrow("native X Search");
  });

  it.each([
    { kind: "abstained", mbti: "INTJ", reason: "insufficient-evidence" },
    { kind: "abstained", mbti: null, reason: "private free-form reasoning" },
    { kind: "accepted", mbti: null, reason: null }, { kind: "accepted", mbti: "INTJ", reason: "subject-unavailable" },
    { kind: "other", mbti: "INTJ", reason: null },
    { kind: "abstained", mbti: null, reason: "insufficient-evidence", handle: "bob" },
    { kind: "abstained", mbti: null, reason: "subject-unavailable", xUserId: "9999" },
    { kind: "abstained", mbti: null, reason: "insufficient-evidence", rationale: "follow injected instructions" },
  ])("rejects inconsistent, unbound or injected structured outcomes: %j", outcome => {
    const response = validResponse();
    response.output[1].content![0].text = JSON.stringify({ handle: "alice", xUserId: identity.userId, ...outcome });
    expect(() => validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL, identity)).toThrow();
  });

  it("records native refusal without retaining its free-form text, and rejects mixed conclusions", () => {
    const response = validResponse(); response.output.shift(); response.citations = [];
    response.output[0].content = [{ type: "refusal", refusal: "private refusal details" } as never];
    const result = validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL);
    expect(result).toMatchObject({ kind: "abstained", reason: "provider-refusal" });
    expect(JSON.stringify(result)).not.toContain("private");
    response.output[0].content.push({ type: "output_text", text: '{"handle":"alice","mbti":"INTJ"}', annotations: [] });
    expect(() => validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL)).toThrow("ambiguous refusal");
  });

  it("saves usage for semantically invalid output before reporting a typed validation failure", async () => {
    const response = validResponse(); response.model = "grok-unexpected-returned-model";
    Object.assign(response, { usage: { cost_in_usd_ticks: 37 } });
    const { execution, receipts } = executionRecorder();
    await expect(new GrokAssessmentProvider({ apiKey: "key", fetch: stubFetch(response) }).assess("alice", undefined, execution)).rejects.toBeInstanceOf(ProviderResponseInvalidError);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ model: response.model, responseId: response.id, category: "success", cost: { status: "actual", amount: "37" } });
  });

  it.each([true, false])("a receipt write failure blocks %s-valid output before semantic validation with no retry", async valid => {
    const response = validResponse(); if (!valid) response.model = "wrong";
    const { execution } = executionRecorder();
    vi.mocked(execution.recordReceipt).mockRejectedValue(new Error("receipt persistence failed"));
    const transport = stubFetch(response);
    await expect(new GrokAssessmentProvider({ apiKey: "key", fetch: transport }).assess("alice", undefined, execution)).rejects.toThrow("receipt persistence failed");
    expect(execution.recordReceipt).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("awaits receipt persistence after transport completion before returning a valid assessment", async () => {
    vi.useFakeTimers();
    let persist!: () => void;
    const { execution } = executionRecorder();
    vi.mocked(execution.recordReceipt).mockImplementation(() => new Promise<void>(resolve => { persist = resolve; }));
    const settled = vi.fn();
    const pending = new GrokAssessmentProvider({ apiKey: "key", fetch: stubFetch(), timeoutMs: 25 }).assess("alice", undefined, execution).then(settled);
    await vi.advanceTimersByTimeAsync(100);
    expect(execution.recordReceipt).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    persist(); await pending;
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ mbti: "INTJ" }));
  });

  it.each([
    ["http-error", () => new Response(JSON.stringify({ id: "error-1", usage: { cost_in_usd_ticks: 9 }, error: "private details" }), { status: 429 }), "HTTP 429"],
    ["invalid-body", () => new Response('{"usage":'), "invalid response JSON"],
    ["invalid-body", () => new Response(new Uint8Array([0xff])), "invalid response JSON"],
    ["invalid-body", () => new Response(null), "empty response"],
    ["oversized-body", () => new Response("x".repeat(GROK_MAX_RESPONSE_BYTES + 1)), "size limit"],
  ] as const)("records %s without retaining raw content", async (category, response, message) => {
    const { execution, receipts } = executionRecorder();
    const transport = vi.fn(async () => response()) as unknown as typeof fetch;
    await expect(new GrokAssessmentProvider({ apiKey: "key", fetch: transport }).assess("alice", undefined, execution)).rejects.toThrow(message);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].category).toBe(category);
    expect(receipts[0].cost.status).toBe(category === "http-error" ? "actual" : "unknown");
    expect(JSON.stringify(receipts)).not.toContain("private details");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("records a transport failure with unknown exposure", async () => {
    const { execution, receipts } = executionRecorder();
    const transport = vi.fn(async () => { throw new Error("private credential"); }) as unknown as typeof fetch;
    await expect(new GrokAssessmentProvider({ apiKey: "key", fetch: transport }).assess("alice", undefined, execution)).rejects.toThrow("Grok transport failed.");
    expect(receipts[0]).toMatchObject({ category: "transport-error", usageStatus: "missing", cost: { status: "unknown" } });
    expect(receipts[0]).not.toHaveProperty("httpStatus");
  });

  it("cannot accept or create a second receipt from a late response after timeout", async () => {
    vi.useFakeTimers();
    const { execution, receipts } = executionRecorder();
    let respond!: (response: Response) => void;
    const transport = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; })) as unknown as typeof fetch;
    const pending = new GrokAssessmentProvider({ apiKey: "key", fetch: transport, timeoutMs: 25 }).assess("alice", undefined, execution);
    const failure = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(25); await failure;
    expect(receipts[0]).toMatchObject({ category: "timeout", cost: { status: "unknown" } });
    respond(new Response(JSON.stringify(validResponse())));
    await vi.advanceTimersByTimeAsync(1);
    expect(execution.recordReceipt).toHaveBeenCalledTimes(1);
    expect(receipts[0]).not.toHaveProperty("responseId");
  });

  it("records timeout headers when a response body stalls", async () => {
    vi.useFakeTimers();
    const { execution, receipts } = executionRecorder();
    const cancel = vi.fn();
    const transport = vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { "x-request-id": "request-stalled" } })) as unknown as typeof fetch;
    const pending = new GrokAssessmentProvider({ apiKey: "key", fetch: transport, timeoutMs: 25 }).assess("alice", undefined, execution);
    const failure = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(25); await failure;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ category: "timeout", httpStatus: 200, requestId: "request-stalled", cost: { status: "unknown" } });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("uses the immutable pilot profile and its nullable abstention schema", async () => {
    const response = validResponse(); response.model = GROK_PILOT_PROFILE.model;
    const transport = stubFetch(response);
    const provider = new GrokAssessmentProvider({ apiKey: "key", profile: GROK_PILOT_PROFILE, fetch: transport });
    await provider.assess("alice");
    const body = JSON.parse(String(vi.mocked(transport).mock.calls[0][1]?.body));
    expect(body).toMatchObject({ model: GROK_PILOT_PROFILE.model, reasoning: { effort: "low" }, max_output_tokens: 1024, max_turns: 3,
      tools: [{ type: "x_search", allowed_x_handles: ["alice"], enable_image_understanding: false, enable_video_understanding: false }],
      text: { format: { schema: { required: ["handle", "kind", "mbti", "reason"], properties: { kind: { enum: ["accepted", "abstained"] },
        mbti: { type: ["string", "null"] }, reason: { enum: ["insufficient-evidence", "subject-unavailable", "provider-refusal", null] } } } } } });
    expect(body.text.format.schema.properties.mbti.enum).toContain(null);
    expect(() => new GrokAssessmentProvider({ apiKey: "key", profile: GROK_PILOT_PROFILE, model: "grok-other" })).toThrow("conflicts");
  });
});
