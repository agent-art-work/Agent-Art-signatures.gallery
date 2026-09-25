import { describe, expect, it, vi } from "vitest";
import { captureAssessmentPolicy } from "./assessmentPolicy.js";
import { POLICY_VERSION } from "../identity.js";
import { admissionDigest } from "./admission.js";

const legacy = { schema: "sg-readiness-assessment-policy-v1", model: "grok-offline-test", profileVersion: "offline-v1", policyVersion: POLICY_VERSION };
const timing = { jobTimeoutMs: 180000, xCompletionMs: 20000, grokCompletionMs: 100000 };
const candidate = () => ({ ...legacy, schema: "sg-readiness-assessment-policy-v2", timing: { ...timing } });
describe("review-bound background timing policy", () => {
  it("keeps legacy hashes and requires an explicit v2 timing revision", () => {
    expect(admissionDigest(captureAssessmentPolicy(legacy))).toBe(admissionDigest(legacy));
    const input = candidate(), result = captureAssessmentPolicy(input);
    input.timing.jobTimeoutMs = 1; expect(result.timing).toEqual(timing); expect(Object.isFrozen(result.timing)).toBe(true);
    expect(admissionDigest(result)).not.toBe(admissionDigest(legacy));
  });
  it.each([null, {}, { ...legacy, extra: true }, { ...legacy, schema: "unknown" }, { ...legacy, model: "client" },
    { ...legacy, policyVersion: "old" }, { ...legacy, profileVersion: "" }, { ...legacy, timing },
    { ...legacy, schema: "sg-readiness-assessment-policy-v2" }, { ...candidate(), timing: null },
    ...["jobTimeoutMs", "xCompletionMs", "grokCompletionMs"].flatMap(key => [0, -1, NaN, 1.5, 180001].map(value =>
      ({ ...candidate(), timing: { ...timing, [key]: value } }))),
    { ...candidate(), timing: { ...timing, jobTimeoutMs: 120000 } },
    { ...candidate(), timing: { ...timing, xCompletionMs: 70001 } },
    { ...candidate(), timing: { ...timing, grokCompletionMs: 120001 } },
  ])("rejects invalid policy %#", value => { expect(() => captureAssessmentPolicy(value)).toThrow(); });
  it("does not invoke getters or accept hidden fields", () => {
    const getter = vi.fn();
    for (const v of [Object.defineProperty(candidate(), "timing", { get: getter }), Object.create(legacy),
      Object.defineProperty(candidate(), "hidden", { value: true }),
      { ...candidate(), timing: Object.defineProperty({ ...timing }, "jobTimeoutMs", { get: getter }) }]) {
      expect(() => captureAssessmentPolicy(v)).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });
});
