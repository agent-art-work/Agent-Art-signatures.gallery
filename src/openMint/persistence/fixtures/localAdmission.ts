import { admissionDigest, type AdmissionScope } from "../../staging/admission.js";
import { localReviewFixture } from "../../staging/fixtures/localReview.js";
import { observeLocalAssessmentBinding } from "../assessmentAdmission.js";
import { observeLocalMintBinding } from "../mintAdmission.js";
import { LocalAdmissionRuntime } from "../localAdmissionRuntime.js";
import { type PostgresMintRequests } from "../requests.js";

/** Disposable test/rehearsal review keys ONLY. Not an operational approval. */
export async function localRuntimeAdmissionFixture(requests: PostgresMintRequests, role: string, timeoutMs = 5000) {
  const now = Date.now(), events: string[] = [];
  const base: AdmissionScope = {
    operatingPlanSha256: admissionDigest({ fixture: "isolated-local-admission", namespace: requests.repository.namespace, deployment: requests.profile }),
    activePolicySha256: admissionDigest({ fixture: "local-request-eligibility", profile: requests.profile }),
    databaseBindingSha256: await observeLocalAssessmentBinding(requests, role), reviewRevisionSha256: "a".repeat(64),
    writerEpoch: requests.repository.writer.epoch, timeoutMs, permitTtlMs: timeoutMs, paidValidFrom: now - 1000, paidValidUntil: now + 3600000,
  };
  const assessment = localReviewFixture(base, { operations: ["reuse", "assessment-x", "assessment-grok"], validUntil: now + 3600000 });
  const mint = localReviewFixture({ ...base, databaseBindingSha256: await observeLocalMintBinding(requests, role) },
    { operations: ["reuse", "sign", "wallet-submit"], validUntil: now + 3600000 });
  const binding = (review: typeof assessment, name: string) => ({ scope: review.scope,
    requireReview: (...args: Parameters<typeof review.review.requireReview>) => { review.review.requireReview(...args); events.push(`${name}:${args[1]}`); } });
  return { events, assessment, mint, admission: new LocalAdmissionRuntime(requests,
    { expectedRole: role, assessment: binding(assessment, "assessment"), mint: binding(mint, "mint") }) };
}
