import { POLICY_VERSION } from "../identity.js";

export interface AssessmentTiming {
  readonly jobTimeoutMs: number;
  /** Includes response parsing/accounting, not permission to dispatch again. */
  readonly xCompletionMs: number;
  readonly grokCompletionMs: number;
}
interface Policy {
  readonly schema: string; readonly model: string; readonly profileVersion: string; readonly policyVersion: string;
  readonly timing?: Readonly<AssessmentTiming>;
}
const check = (ok: unknown): void => { if (!ok) throw Error("Assessment policy unavailable."); };
function fields(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  check(v && Object.getPrototypeOf(v) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(v!);
  check(Reflect.ownKeys(v as object).length === keys.length && keys.every(k => ds[k]?.enumerable && "value" in ds[k]));
}
const duration = (v: unknown, max: number) => check(typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= max);

/** V1 remains byte-for-byte review-compatible and keeps its old short limits.
 * V2 timing is part of the operating profile hash AND the signed operation
 * scope. Merely installing this parser does not widen any existing approval. */
export function captureAssessmentPolicy(input: unknown): Readonly<Policy> {
  fields(input, Object.hasOwn(input as object, "timing")
    ? ["schema", "model", "profileVersion", "policyVersion", "timing"] : ["schema", "model", "profileVersion", "policyVersion"]);
  check(input.policyVersion === POLICY_VERSION);
  check(typeof input.model === "string" && /^grok-[A-Za-z0-9._:-]{1,122}$/.test(input.model));
  check(typeof input.profileVersion === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.profileVersion));
  if (input.schema === "sg-readiness-assessment-policy-v1") check(!Object.hasOwn(input, "timing"));
  else {
    check(input.schema === "sg-readiness-assessment-policy-v2");
    fields(input.timing, ["jobTimeoutMs", "xCompletionMs", "grokCompletionMs"]);
    duration(input.timing.jobTimeoutMs, 180000); duration(input.timing.xCompletionMs, 70000); duration(input.timing.grokCompletionMs, 120000);
    check((input.timing.jobTimeoutMs as number) > (input.timing.xCompletionMs as number) + (input.timing.grokCompletionMs as number));
    return Object.freeze({ ...input, timing: Object.freeze({ ...input.timing }) }) as unknown as Readonly<Policy>;
  }
  return Object.freeze({ ...input }) as unknown as Readonly<Policy>;
}
