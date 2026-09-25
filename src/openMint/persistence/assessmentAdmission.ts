import { performance } from "node:perf_hooks";
import { admissionDigest, type AdmissionDatabaseLease, type AdmissionIntent, type AdmissionOperation } from "../staging/admission.js";
import { generativeProfile } from "../generativeProfiles.js";
import { PostgresAssessmentWorker, type AssessmentWorkerIntent } from "./assessmentWorker.js";
import { type PostgresMintRequests } from "./requests.js";
import { type ExecutionTransaction } from "./repository.js";
import { auditGenerativeBrowserRole } from "./roleAudit.js";
import { capabilityHash } from "./sessions.js";
import { PersistenceConflictError, type OwnershipConnection } from "./writer.js";

type Transaction = Pick<OwnershipConnection, "query">;
type Leg = "x-identity" | "grok";
const check = (value: unknown): void => { if (!value) throw new PersistenceConflictError("Assessment admission unavailable."); };
const digest = (value: unknown): value is string => typeof value === "string" && /^(?!0{64}$)[0-9a-f]{64}$/.test(value);
const release = generativeProfile("generative-v1-rc1");

/** Local rehearsal binding, NOT a public schema certification or approval.
 * Keep PostgreSQL JSON quantities as text: never round policy amounts in JS.
 * The catalog audit covers layout/grants, not all constraints/triggers or the
 * identity of a hosted DB server. Public startup still requires those reviews.
 */
export async function inspectLocalAssessmentBinding(tx: Transaction, requests: PostgresMintRequests, expectedRole: string) {
  check(/^[a-z][a-z0-9_]{0,62}$/.test(expectedRole));
  check(requests.repository.namespace.profile === "local-real" && requests.repository.namespace.provenance === "grok"
    && requests.profile.chain_id === "31337" && requests.profile.session_chain_id === "31337");
  check((await auditGenerativeBrowserRole(tx)).ok);
  const { origin, session_chain_id: _chain, ...cachedRequest } = requests.profile;
  const rows = (await tx.query<{ database_name: string; role_name: string; cached: boolean;
    namespace: string; session: string; request: string; input: string; budget: string; schema: string; projection: string }>(`SELECT
      current_database()::text AS database_name, current_user::text AS role_name,
      ((to_jsonb(r)||jsonb_build_object('chain_id',r.chain_id::text,'deployment_block',r.deployment_block::text)) = $3::jsonb
        AND s.origin=$4 AND s.chain_id=r.chain_id) AS cached,
      to_jsonb(n)::text AS namespace, to_jsonb(s)::text AS session, to_jsonb(r)::text AS request,
      to_jsonb(i)::text AS input, (to_jsonb(b)-'generation_enabled')::text AS budget,
      (SELECT to_jsonb(v)::text FROM open_mint.schema_version v) AS schema,
      (SELECT to_jsonb(v)::text FROM open_mint.projection_schema_version v) AS projection
      FROM open_mint.namespaces n JOIN open_mint.session_profiles s USING(namespace_id)
      JOIN open_mint.request_profiles r USING(namespace_id) JOIN open_mint.generative_input_profiles i USING(namespace_id,deployment_id)
      JOIN open_mint.budget_policies b USING(namespace_id) WHERE n.namespace_id=$1 AND r.deployment_id=$2`,
    [requests.repository.namespace.id, requests.profile.deployment_id, JSON.stringify(cachedRequest), origin])).rows;
  check(rows.length === 1);
  const row = rows[0]!;
  check(row.role_name === expectedRole && row.cached === true && typeof row.schema === "string" && typeof row.projection === "string");
  check(JSON.parse(row.schema).version === 1 && JSON.parse(row.projection).version === 3);
  const ns = JSON.parse(row.namespace), pin = JSON.parse(row.input);
  check(ns.profile === requests.repository.namespace.profile && ns.provenance === requests.repository.namespace.provenance
    && ns.policy_version === requests.repository.namespace.policyVersion && pin.profile === release.inputProfile);
  return { sha256: admissionDigest({ version: "local-generative-assessment-binding-v1", ...row }), pin };
}

/** Read-only candidate pin. Recording it does not approve it or enable calls. */
export function observeLocalAssessmentBinding(requests: PostgresMintRequests, expectedRole: string): Promise<string> {
  return requests.repository.writer.transaction(async tx => (await inspectLocalAssessmentBinding(tx, requests, expectedRole)).sha256);
}

/** Internal provider-leg adapter for an ALREADY claimed local RC1 request.
 * No claim, provider client, review authority, signer, wallet or public route.
 * The registered effect must persist the existing receipts/identity/result;
 * committed fences survive errors, timeouts and process restarts unchanged.
 */
export async function prepareLocalAssessmentAdmission(requests: PostgresMintRequests, value: AssessmentWorkerIntent, configuration: {
  leg: Leg; model: string; expectedRole: string; databaseBindingSha256: string; scopeSha256: string; leaseMs: number;
}, signal = new AbortController().signal) {
  const { leg, model, expectedRole, databaseBindingSha256, scopeSha256, leaseMs } = configuration;
  check((leg === "x-identity" || leg === "grok") && typeof model === "string" && model.length > 0 && model.length <= 200
    && digest(databaseBindingSha256) && digest(scopeSha256) && Number.isSafeInteger(leaseMs) && leaseMs > 0 && leaseMs <= 30000);
  const input = Object.freeze({ code: value.code, sessionToken: value.sessionToken, sessionGeneration: value.sessionGeneration,
    origin: value.origin, csrf: value.csrf, eligibility: value.eligibility });
  const repository = requests.repository, writer = repository.writer, epoch = writer.epoch;
  const worker = new PostgresAssessmentWorker(requests, { timeoutMs: leaseMs });
  const operation = leg === "x-identity" ? "assessment-x" : "assessment-grok";
  let halted = false;
  const live = (s: AbortSignal) => { check(!halted && !s.aborted); writer.assertHealthy(); };
  async function inspect(tx: Transaction, operations: ExecutionTransaction, s: AbortSignal) {
    live(s);
    const bound = await inspectLocalAssessmentBinding(tx, requests, expectedRole); live(s); check(bound.sha256 === databaseBindingSha256);
    const context = await worker.admissionContext(tx, input); live(s);
    const { request, evidence } = context;
    check(request.attempt_id !== null && request.assessment_id === null);
    check(evidence.contractProfile === release.contractProfile && evidence.generativeRenderer?.address.toLowerCase() === bound.pin.renderer_address.toLowerCase()
      && evidence.generativeRenderer?.runtimeCodeHash === bound.pin.renderer_code_hash && evidence.generativeRenderer?.identity === bound.pin.renderer_identity);
    const ready = await operations.inspectDispatch(request.attempt_id!, leg, model); live(s);
    check(ready.handle === request.handle);
    const intent: Readonly<AdmissionIntent> = Object.freeze({ operation, requestId: request.request_id, payloadSha256: admissionDigest({
      version: "local-generative-assessment-intent-v1", namespace: repository.namespace.id, deployment: requests.profile.deployment_id,
      request: request.request_id, attempt: request.attempt_id, handle: request.handle, recipient: request.wallet,
      session: capabilityHash(input.sessionToken), generation: input.sessionGeneration, profile: ready.profileVersion,
      model: ready.model, leg, identity: ready.identity,
    }) });
    return { intent, attempt: request.attempt_id!, observedAt: context.now,
      validUntil: Math.min(context.now + leaseMs, context.validUntil, ready.validUntil) };
  }
  const initial = await repository.executionTransaction((tx, operations) => inspect(tx, operations, signal)); live(signal);
  const intent = initial.intent, intentSha256 = admissionDigest(intent);
  return Object.freeze({ intent, halt() { halted = true; }, database: Object.freeze({
    async inspect(value: Readonly<AdmissionIntent>, scope: string, s: AbortSignal): Promise<AdmissionDatabaseLease> {
      live(s); check(scope === scopeSha256 && admissionDigest(value) === intentSha256);
      const row = await repository.executionTransaction((tx, operations) => inspect(tx, operations, s)); live(s);
      check(admissionDigest(row.intent) === intentSha256);
      const mono = performance.now(); let consumed = false;
      const assertCurrent = (op: AdmissionOperation) => {
        // prepare() aborts its internal signal on completion; the permit never
        // reuses that lease. execute() obtains its own live lease and signal.
        live(s); check(op === operation && Date.now() >= row.observedAt && Date.now() < row.validUntil
          && performance.now() - mono < leaseMs && writer.epoch === epoch);
      };
      assertCurrent(operation);
      return Object.freeze({ databaseBindingSha256, intentSha256, writerEpoch: epoch, observedAt: row.observedAt, validUntil: row.validUntil,
        assertCurrent,
        async fence(fenceSignal: AbortSignal) {
          check(!consumed); consumed = true; // Never reuse this lease, including rollback/unknown COMMIT.
          assertCurrent(operation); live(fenceSignal);
          await repository.executionTransaction(async (tx, operations) => {
            assertCurrent(operation); live(fenceSignal);
            const fresh = await inspect(tx, operations, fenceSignal);
            check(admissionDigest(fresh.intent) === intentSha256);
            await operations.beforeDispatch(fresh.attempt, leg, model);
            // The inspection would now reject its own fence. Recheck the
            // independently mutable controls and proof before COMMIT instead.
            check((await inspectLocalAssessmentBinding(tx, requests, expectedRole)).sha256 === databaseBindingSha256);
            await worker.admissionContext(tx, input);
            assertCurrent(operation); live(fenceSignal);
          });
          assertCurrent(operation); live(fenceSignal);
        },
      });
    },
  }) });
}
