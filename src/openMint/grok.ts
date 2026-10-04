import { canonicalHandle, handleDigest, isMbti, MBTI_TYPES } from "./identity.js";
import { GROK_INSTRUCTIONS } from "./grokInstructions.js";
import { exactObject, validateSourceUrls, type AssessmentProvider, type ProviderAssessment, type ProviderAbstention } from "./assessment.js";
import { validateXIdentity, type XIdentitySnapshot } from "./xIdentity.js";
import type { AssessmentExecution } from "./assessmentOperations.js";
import { receiptedJsonRequest } from "./providerReceipt.js";
import type { GROK_PILOT_PROFILE } from "./providerProfile.js";

export const GROK_DEFAULT_MODEL = "grok-4.6";
export const GROK_RESPONSES_ENDPOINT = "https://api.x.ai/v1/responses";
export const GROK_MAX_RESPONSE_BYTES = 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export class ProviderResponseInvalidError extends Error {
  constructor() { super("Grok returned an invalid assessment response."); this.name = "ProviderResponseInvalidError"; }
}

/** Parse only a direct authenticated transport response; this function never accepts client callbacks. */
export function validateGrokResponse(value: unknown, expectedHandle: string, expectedModel: string, expectedIdentity?: XIdentitySnapshot): ProviderAssessment | ProviderAbstention {
  const handle = canonicalHandle(expectedHandle);
  const identity = expectedIdentity ? validateXIdentity(expectedIdentity, handle) : undefined;
  const response = record(value);
  if (!response || response.status !== "completed" || response.error != null || response.incomplete_details != null) throw new Error("Grok assessment did not complete successfully.");
  if (typeof response.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(response.id) || response.id.startsWith("development-fixture:")) throw new Error("Grok response identifier is missing or invalid.");
  if (response.model !== expectedModel) throw new Error("Grok response model mismatch.");
  if (!Array.isArray(response.output) || response.output.length === 0 || response.output.length > 256) throw new Error("Grok response output is missing or invalid.");
  const outputs = response.output.map(record);
  if (outputs.some((item) => !item || item.error != null || (item.status != null && item.status !== "completed"))) throw new Error("Grok returned incomplete or failed output.");
  const texts: string[] = [];
  const sources: unknown[] = [];
  let refusals = 0;
  if (response.citations !== undefined) {
    if (!Array.isArray(response.citations) || response.citations.length > 128) throw new Error("Invalid Grok citations.");
    sources.push(...response.citations);
  }
  for (const item of outputs) {
    if (!item) continue;
    if (!["message", "reasoning", "x_search_call"].includes(String(item.type))) throw new Error("Unexpected Grok output type.");
    if (item.type !== "message") continue;
    if (item.role !== "assistant" || !Array.isArray(item.content) || item.content.length > 32) throw new Error("Invalid Grok message.");
    for (const value of item.content) {
      const content = record(value);
      if (content?.type === "refusal" && typeof content.refusal === "string" && content.refusal.length > 0 && content.refusal.length <= 4096) {
        refusals += 1;
        continue;
      }
      if (!content || content.type !== "output_text" || typeof content.text !== "string") throw new Error("Grok refused or returned invalid assessment content.");
      if (content.text.length > 4096) throw new Error("Grok assessment text exceeds size limit.");
      texts.push(content.text);
      if (content.annotations === undefined) continue;
      if (!Array.isArray(content.annotations) || content.annotations.length > 128) throw new Error("Invalid Grok citation annotations.");
      for (const value of content.annotations) {
        const annotation = record(value);
        if (annotation?.type === "url_citation") sources.push(annotation.url);
      }
    }
  }
  if (refusals === 1 && texts.length === 0) return Object.freeze({ kind: "abstained", reason: "provider-refusal", handle, model: expectedModel, providerResponseId: response.id,
    ...(identity ? { xUserId: identity.userId } : {}) });
  if (refusals) throw new Error("Grok returned ambiguous refusal content.");
  if (texts.length !== 1) throw new Error("Grok must return exactly one structured assessment.");
  let parsed: unknown;
  try { parsed = JSON.parse(texts[0]); } catch { throw new Error("Grok assessment is not valid JSON."); }
  const typed = record(parsed)?.kind !== undefined;
  const fields = ["handle", "mbti", ...(typed ? ["kind", "reason"] : []), ...(identity ? ["xUserId"] : [])];
  const assessment = exactObject(parsed, fields, "Grok assessment");
  if (assessment.handle !== handle) throw new Error("Grok assessment handle or MBTI mismatch.");
  if (identity && assessment.xUserId !== identity.userId) throw new Error("Grok assessment X account mismatch.");
  if (typed && assessment.kind === "abstained") {
    if (assessment.mbti !== null || !["insufficient-evidence", "subject-unavailable", "provider-refusal"].includes(String(assessment.reason))) throw new Error("Invalid Grok abstention.");
    return Object.freeze({ kind: "abstained", reason: assessment.reason as ProviderAbstention["reason"], handle, model: expectedModel, providerResponseId: response.id,
      ...(identity ? { xUserId: identity.userId } : {}) });
  }
  if ((typed && (assessment.kind !== "accepted" || assessment.reason !== null)) || !isMbti(assessment.mbti)) throw new Error("Grok assessment handle or MBTI mismatch.");
  if (!outputs.some((item) => item?.type === "x_search_call" && item.status === "completed")) throw new Error("Grok response has no completed native X Search call.");
  const sourceUrls = validateSourceUrls([...new Set(sources)], "grok");
  if (identity && !sourceUrls.some(source => {
    const url = new URL(source);
    return ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)
      && (new RegExp(`^/${handle}(?:/status/[0-9]+)?/?$`, "i").test(url.pathname) || url.pathname.replace(/\/$/, "") === `/i/user/${identity.userId}`);
  })) throw new Error("Grok evidence does not reference the verified X subject.");
  return Object.freeze({ handle, mbti: assessment.mbti, model: expectedModel, providerResponseId: response.id, sourceUrls,
    ...(identity ? { xUserId: identity.userId } : {}) });
}

/** Server-only transport. No client-selected model, prompt, endpoint, or completion payload. */
export class GrokAssessmentProvider implements AssessmentProvider {
  readonly provenance = "grok" as const;
  readonly model: string;
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #profile?: typeof GROK_PILOT_PROFILE;
  constructor(options: { apiKey: string; model?: string; fetch?: typeof fetch; timeoutMs?: number; profile?: typeof GROK_PILOT_PROFILE }) {
    if (typeof options.apiKey !== "string" || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) throw new Error("Grok API key is required.");
    this.#key = options.apiKey;
    if (options.profile && options.model !== undefined && options.model !== options.profile.model) throw new Error("Grok model conflicts with the server profile.");
    this.#profile = options.profile;
    this.model = options.profile?.model ?? options.model ?? GROK_DEFAULT_MODEL;
    if (!/^grok-[a-zA-Z0-9._-]{1,120}$/.test(this.model)) throw new Error("Invalid server Grok model.");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? options.profile?.timeoutMs ?? 90_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 120_000) throw new Error("Invalid Grok timeout.");
  }

  async assess(value: string, expectedIdentity?: XIdentitySnapshot, execution?: AssessmentExecution): Promise<ProviderAssessment | ProviderAbstention> {
    const handle = canonicalHandle(value);
    const identity = expectedIdentity ? validateXIdentity(expectedIdentity, handle) : undefined;
    if (identity && identity.provenance !== "x-api") throw new Error("Grok requires an authoritative X identity snapshot.");
    const payload = await receiptedJsonRequest({ leg: "grok", execution, timeoutMs: this.#timeoutMs, maxBytes: GROK_MAX_RESPONSE_BYTES,
      bodyPrefix: "Grok", transportError: "Grok transport failed.", timeoutError: "Grok assessment timed out.",
      httpError: status => `Grok request failed (HTTP ${status}).`,
      fetch: signal => this.#fetch(GROK_RESPONSES_ENDPOINT, {
          method: "POST", redirect: "error", signal,
          headers: { "Authorization": `Bearer ${this.#key}`, "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({
            model: this.model, instructions: GROK_INSTRUCTIONS, stream: false, store: false,
            input: [{ role: "user", content: `Assess the public X account @${handle}. The required canonical handle is ${handle}.` + (identity
              ? ` X's authenticated username lookup returned exact username @${identity.username} and account ID ${identity.userId} at ${identity.verifiedAt}. Research that same account (https://x.com/i/user/${identity.userId}); if the handle now points to a different account or this subject cannot be established, refuse. Return xUserId ${identity.userId} in the JSON. This timestamp is preparation evidence, not a claim of live-current identity.` : "") }],
            tools: [{ type: "x_search", allowed_x_handles: [handle], ...(this.#profile ? { enable_image_understanding: false, enable_video_understanding: false } : {}) }],
            include: ["no_inline_citations"], max_output_tokens: this.#profile?.maxOutputTokens ?? 4096,
            ...(this.#profile ? { reasoning: { effort: this.#profile.reasoningEffort }, max_turns: this.#profile.maxTurns } : {}),
            text: { format: { type: "json_schema", name: "open_handle_mbti", strict: true, schema: {
              type: "object", additionalProperties: false, required: ["handle", "kind", "mbti", "reason", ...(identity ? ["xUserId"] : [])],
              properties: { handle: { type: "string", const: handle }, kind: { type: "string", enum: ["accepted", "abstained"] },
                mbti: { type: ["string", "null"], enum: [...MBTI_TYPES, null] },
                reason: { type: ["string", "null"], enum: ["insufficient-evidence", "subject-unavailable", "provider-refusal", null] },
                ...(identity ? { xUserId: { type: "string", const: identity.userId } } : {}) },
            } } },
          }),
        }),
    });
    // Exactly one paid request; errors propagate without automatic retries or fixture substitution.
    try { return validateGrokResponse(payload, handle, this.model, identity); }
    catch { throw new ProviderResponseInvalidError(); }
  }
}

/** Explicit local-development fixture; callers must opt in at server startup. Never a fallback. */
export class DevelopmentAssessmentProvider implements AssessmentProvider {
  readonly provenance = "development-fixture" as const;
  readonly model = "development-fixture-v1";
  async assess(value: string, expectedIdentity?: XIdentitySnapshot): Promise<ProviderAssessment> {
    const handle = canonicalHandle(value);
    const identity = expectedIdentity ? validateXIdentity(expectedIdentity, handle) : undefined;
    if (identity && identity.provenance !== "development-fixture") throw new Error("Development assessment requires a fixture identity.");
    const digest = handleDigest(handle);
    const mbti = MBTI_TYPES[Number(BigInt(digest) % 16n)];
    return Object.freeze({ handle, mbti, model: this.model, providerResponseId: `development-fixture:${digest.slice(2)}`, sourceUrls: Object.freeze([]),
      ...(identity ? { xUserId: identity.userId } : {}) });
  }
}
