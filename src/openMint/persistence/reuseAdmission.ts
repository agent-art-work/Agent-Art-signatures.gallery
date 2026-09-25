import { performance } from "node:perf_hooks";
import { type Assessment } from "../assessment.js";
import { generativeProfile } from "../generativeProfiles.js";
import { admissionDigest, type AdmissionDatabaseLease, type AdmissionIntent, type AdmissionOperation } from "../staging/admission.js";
import { inspectLocalAssessmentBinding } from "./assessmentAdmission.js";
import { PostgresAssessmentWorker, type AssessmentWorkerIntent } from "./assessmentWorker.js";
import { type PostgresMintRequests } from "./requests.js";
import { capabilityHash } from "./sessions.js";
import { PersistenceConflictError } from "./writer.js";

const check = (value: unknown): void => { if (!value) throw new PersistenceConflictError("Saved assessment admission unavailable."); };
const digest = (value: unknown): value is string => typeof value === "string" && /^(?!0{64}$)[0-9a-f]{64}$/.test(value);
const release = generativeProfile("generative-v1-rc1");
export interface LocalReuseAdmissionConfig {
  expectedRole: string; databaseBindingSha256: string; scopeSha256: string; leaseMs: number;
}

/** Internal saved-assessment reuse, NOT a preview/reveal API or mint authority.
 * Uses the worker's current private proof/eligibility policy, without provider
 * clients, a paid-period check, an issuance switch, claims or durable writes.
 * Expired-request recovery reads keep their separate requests.get policy.
 */
export async function prepareLocalReuseAdmission(requests: PostgresMintRequests, value: AssessmentWorkerIntent,
  configuration: LocalReuseAdmissionConfig, signal = new AbortController().signal) {
  const { expectedRole, databaseBindingSha256, scopeSha256, leaseMs } = configuration;
  check(digest(databaseBindingSha256) && digest(scopeSha256) && Number.isSafeInteger(leaseMs) && leaseMs > 0 && leaseMs <= 30000);
  const input = Object.freeze({ code: value.code, sessionToken: value.sessionToken, sessionGeneration: value.sessionGeneration,
    origin: value.origin, csrf: value.csrf, eligibility: value.eligibility });
  const repository = requests.repository, writer = repository.writer, epoch = writer.epoch;
  const worker = new PostgresAssessmentWorker(requests, { timeoutMs: leaseMs });
  let halted = false;
  const live = (s: AbortSignal) => { check(!halted && !s.aborted); writer.assertHealthy(); };
  async function inspect(s: AbortSignal) {
    live(s);
    return repository.executionTransaction(async (tx, operations) => {
      const bound = await inspectLocalAssessmentBinding(tx, requests, expectedRole); live(s); check(bound.sha256 === databaseBindingSha256);
      const { request, evidence } = await worker.admissionContext(tx, input); live(s);
      check(evidence.contractProfile === release.contractProfile && evidence.generativeRenderer?.address.toLowerCase() === bound.pin.renderer_address.toLowerCase()
        && evidence.generativeRenderer?.runtimeCodeHash === bound.pin.renderer_code_hash && evidence.generativeRenderer?.identity === bound.pin.renderer_identity);
      const assessment = await operations.getAssessment(request.handle); live(s);
      check(assessment && assessment.xIdentity?.provenance === "x-api" && (request.assessment_id === null || request.assessment_id === assessment.id));
      const intent: Readonly<AdmissionIntent> = Object.freeze({ operation: "reuse", requestId: request.request_id, payloadSha256: admissionDigest({
        version: "local-generative-reuse-intent-v1", namespace: repository.namespace.id, deployment: requests.profile.deployment_id,
        request: request.request_id, session: capabilityHash(input.sessionToken), generation: input.sessionGeneration,
        recipient: request.wallet, assessment,
      }) });
      // Recheck expiry/proof after reading and validating the saved bytes.
      const final = await worker.admissionContext(tx, input); live(s);
      check(final.request.request_id === request.request_id);
      return { intent, assessment: assessment!, observedAt: final.now, validUntil: Math.min(final.validUntil, final.now + leaseMs) };
    });
  }
  const initial = await inspect(signal); live(signal);
  const intent = initial.intent, intentSha256 = admissionDigest(intent);
  const matches = (value: Readonly<AdmissionIntent>) => check(admissionDigest(value) === intentSha256);
  return Object.freeze({ intent, halt() { halted = true; }, database: Object.freeze({
    async inspect(value: Readonly<AdmissionIntent>, scope: string, s: AbortSignal): Promise<AdmissionDatabaseLease> {
      live(s); check(scope === scopeSha256); matches(value);
      const mono = performance.now(), row = await inspect(s); live(s); matches(row.intent);
      const assertCurrent = (op: AdmissionOperation) => {
        live(s); check(op === "reuse" && writer.epoch === epoch && Date.now() >= row.observedAt && Date.now() < row.validUntil
          && performance.now() - mono < leaseMs);
      };
      assertCurrent("reuse");
      return Object.freeze({ databaseBindingSha256, intentSha256, writerEpoch: epoch, observedAt: row.observedAt, validUntil: row.validUntil,
        assertCurrent, async fence() { throw new PersistenceConflictError("Saved assessment reuse has no dispatch fence."); } });
    },
  }),
  async effect(value: Readonly<AdmissionIntent>, s: AbortSignal, assertCurrent: () => void): Promise<Assessment> {
    live(s); matches(value); assertCurrent();
    const row = await inspect(s); live(s); matches(row.intent); assertCurrent();
    // Fresh validated storage snapshot, not the object seen at preparation.
    // Trusted backend callers only: never serialize an unrevealed MBTI to UI.
    return row.assessment;
  } });
}
