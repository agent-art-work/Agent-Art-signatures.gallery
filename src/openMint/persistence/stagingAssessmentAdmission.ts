import { timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { admissionDigest, type AdmissionDatabaseLease, type AdmissionIntent, type AdmissionOperation, type AdmissionEffectGuard } from "../staging/admission.js";
import { readPublicChainEligibility } from "../publicChain.js";
import { isCode } from "../security.js";
import { capabilityHash } from "./sessions.js";
import { type AssessmentWorkerIntent } from "./assessmentWorker.js";
import { type PostgresMintRequests } from "./requests.js";
import { type ExecutionTransaction } from "./repository.js";
import { PersistenceConflictError, type OwnershipConnection } from "./writer.js";
import { verifySelectedRuntimeDatabase, readCertifiedDatabaseProfiles, type SelectedRuntimeDatabaseReview } from "./databaseCertification.js";

type Tx = Pick<OwnershipConnection, "query">;
const check = (v: unknown): void => { if (!v) throw new PersistenceConflictError("Staging assessment admission unavailable."); };
export interface StagingAssessmentBinding {
  readonly review: SelectedRuntimeDatabaseReview;
  readonly databaseBindingSha256: string;
  readonly scopeSha256: string;
  readonly leaseMs: number;
  /** Installed by release-aware composition, never by a web request. */
  assertProfiles(raw: string): void;
}
interface Session { generation: string; wallet: string; csrf: string; revoked: boolean; expires_at: Date;
  proof_wallet: string | null; proof_code_hash: string | null; proof_expires_at: Date | null; active_challenge_hash: string | null }
interface Request { request_id: string; handle: string; wallet: string; expires_at: Date; attempt_id: string | null; assessment_id: string | null }

/** Separate public-profile DB adapter for an ALREADY admitted/claimed request.
 * Does not loosen the local worker, create requests, claim jobs, choose a
 * provider, sign, or broadcast. Caller must use the release-aware controller.
 * Every fence uses the writer's actual owner transaction and existing durable
 * provider-leg ledger; an uncertain dispatch is never made retryable here. */
export async function prepareStagingAssessmentAdmission(requests: PostgresMintRequests, value: AssessmentWorkerIntent,
  operation: "reuse" | "assessment-x" | "assessment-grok", model: string, config: StagingAssessmentBinding,
  signal = new AbortController().signal) {
  const repository = requests.repository, writer = repository.writer, epoch = writer.epoch, p = requests.profile, ns = repository.namespace;
  check(ns.profile === "staging-testnet" && ns.provenance === "grok" && p.chain_id === "11155111"
    && p.session_chain_id === "11155111" && p.origin === "https://staging.signatures.gallery");
  check(["reuse", "assessment-x", "assessment-grok"].includes(operation) && /^grok-[A-Za-z0-9._:-]{1,122}$/.test(model));
  const review = Object.freeze({ ...config.review }), binding = config.databaseBindingSha256, scope = config.scopeSha256,
    ttl = config.leaseMs, assertProfiles = config.assertProfiles.bind(config);
  check(review.namespaceId === ns.id && review.deploymentId === p.deployment_id
    && [binding, scope].every(v => /^(?!0{64}$)[a-f0-9]{64}$/.test(v)) && Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 30000);
  const input = Object.freeze({ ...value, codeHash: capabilityHash(value.code), sessionHash: capabilityHash(value.sessionToken) });
  check(/^(0|[1-9][0-9]{0,18})$/.test(input.sessionGeneration));
  const leg = operation === "assessment-x" ? "x-identity" : "grok", reuse = operation === "reuse";
  let halted = false, fenced = false, released = false;
  const live = (s: AbortSignal) => { check(!halted && !s.aborted); writer.assertHealthy(); };
  async function bound(tx: Tx, s: AbortSignal) {
    live(s); const db = await verifySelectedRuntimeDatabase(tx, review, s, Math.min(ttl, 5000)); live(s);
    check(db.databaseBindingSha256 === binding && (reuse || db.generationEnabled === true));
    check(assertProfiles(readCertifiedDatabaseProfiles(db)) === undefined);
    // Independently compare the cached constructor profile to the same live
    // rows. Do not let caller-owned handles/models or a stale instance retarget.
    const { origin, session_chain_id: _, ...cached } = p;
    const row = (await tx.query<{ ok: boolean }>(`SELECT ((to_jsonb(r)||jsonb_build_object('chain_id',r.chain_id::text,'deployment_block',r.deployment_block::text))=$3::jsonb
      AND s.origin=$4 AND s.chain_id=r.chain_id AND n.profile=$5 AND n.provenance=$6 AND n.policy_version=$7) AS ok
      FROM open_mint.request_profiles r JOIN open_mint.session_profiles s USING(namespace_id) JOIN open_mint.namespaces n USING(namespace_id)
      WHERE r.namespace_id=$1 AND r.deployment_id=$2`, [ns.id, p.deployment_id, JSON.stringify(cached), origin, ns.profile, ns.provenance, ns.policyVersion])).rows;
    live(s); check(row.length === 1 && row[0].ok === true);
  }
  async function context(tx: Tx, s: AbortSignal) {
    live(s); const now = (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
    const session = (await tx.query<Session>("SELECT *,generation::text FROM open_mint.sessions WHERE namespace_id=$1 AND session_hash=$2 FOR UPDATE", [ns.id, input.sessionHash])).rows[0];
    check(session && !session.revoked && session.expires_at.getTime() > now && input.origin === p.origin && isCode(input.csrf)
      && timingSafeEqual(Buffer.from(input.csrf!), Buffer.from(session.csrf)));
    const request = (await tx.query<Request>("SELECT request_id,handle,wallet,expires_at,attempt_id,assessment_id FROM open_mint.requests WHERE namespace_id=$1 AND deployment_id=$2 AND code_hash=$3 AND session_hash=$4",
      [ns.id, p.deployment_id, input.codeHash, input.sessionHash])).rows[0];
    check(request && request.expires_at.getTime() > now && session.generation === input.sessionGeneration && session.wallet === request.wallet
      && session.proof_wallet === request.wallet && session.proof_expires_at && session.proof_expires_at.getTime() > now
      && !session.active_challenge_hash && (session.proof_code_hash === null || session.proof_code_hash === input.codeHash));
    const e = readPublicChainEligibility(input.eligibility, { namespaceId: ns.id, deploymentId: p.deployment_id,
      handle: request.handle, recipient: request.wallet, now });
    check(e.chainId.toString() === p.chain_id && e.contract.toLowerCase() === p.contract_address && e.genesisHash === p.genesis_hash
      && e.runtimeCodeHash === p.runtime_code_hash && e.authorizer.toLowerCase() === p.authorizer && e.deploymentBlock.number.toString() === p.deployment_block
      && e.deploymentBlock.hash === p.deployment_block_hash && e.contractProfile === "generative-v1-rc1");
    const pin = (await tx.query<{ renderer_address: string; renderer_code_hash: string; renderer_identity: string }>(
      "SELECT renderer_address,renderer_code_hash,renderer_identity FROM open_mint.generative_input_profiles WHERE namespace_id=$1 AND deployment_id=$2", [ns.id, p.deployment_id])).rows[0];
    check(pin && e.generativeRenderer?.address.toLowerCase() === pin.renderer_address && e.generativeRenderer.runtimeCodeHash === pin.renderer_code_hash
      && e.generativeRenderer.identity === pin.renderer_identity);
    const blockTime = Number(e.block.timestamp) * 1000;
    check(now - e.observedAt < p.max_evidence_age_ms && now - blockTime < p.max_block_age_ms && blockTime - now <= p.max_future_skew_ms); live(s);
    return { request, now, validUntil: Math.min(request.expires_at.getTime(), session.expires_at.getTime(), session.proof_expires_at!.getTime(),
      e.validUntil, e.observedAt + p.max_evidence_age_ms, blockTime + p.max_block_age_ms) };
  }
  async function inspect(tx: Tx, ops: ExecutionTransaction, s: AbortSignal) {
    await bound(tx, s); const c = await context(tx, s), r = c.request;
    const assessment = reuse ? await ops.getAssessment(r.handle) : undefined;
    if (reuse) check(assessment && assessment.xIdentity?.provenance === "x-api" && (r.assessment_id === null || r.assessment_id === assessment.id));
    else check(r.attempt_id !== null && r.assessment_id === null);
    const ready = reuse ? undefined : await ops.inspectDispatch(r.attempt_id!, leg, model); live(s);
    check(!ready || ready.handle === r.handle);
    const intent: Readonly<AdmissionIntent> = Object.freeze({ operation, requestId: r.request_id, payloadSha256: admissionDigest({
      version: "staging-assessment-intent-v1", namespace: ns.id, deployment: p.deployment_id, request: r.request_id, handle: r.handle,
      attempt: r.attempt_id, session: input.sessionHash, generation: input.sessionGeneration, recipient: r.wallet,
      ...(reuse ? { assessment } : { model: ready!.model, profile: ready!.profileVersion, identity: ready!.identity, leg }),
    }) });
    return { ...c, intent, assessment, validUntil: Math.min(c.validUntil, c.now + ttl, ready?.validUntil ?? Infinity) };
  }
  const initial = await repository.executionTransaction((tx, ops) => inspect(tx, ops, signal)); live(signal);
  const intent = initial.intent, intentSha256 = admissionDigest(intent), matches = (v: AdmissionIntent) => check(admissionDigest(v) === intentSha256);
  return Object.freeze({ intent, halt() { halted = true; }, database: Object.freeze({
    async inspect(v: Readonly<AdmissionIntent>, digest: string, s: AbortSignal): Promise<AdmissionDatabaseLease> {
      live(s); matches(v); check(!fenced && scope === digest);
      const mono = performance.now(), row = await repository.executionTransaction((tx, ops) => inspect(tx, ops, s)); live(s); matches(row.intent);
      let consumed = false;
      const assertCurrent = (op: AdmissionOperation) => { live(s); check(op === operation && writer.epoch === epoch
        && Date.now() >= row.now && Date.now() < row.validUntil && performance.now() - mono < ttl); };
      assertCurrent(operation);
      return Object.freeze({ databaseBindingSha256: binding, writerEpoch: epoch, intentSha256, observedAt: row.now, validUntil: row.validUntil, assertCurrent,
        async fence(fs: AbortSignal) {
          check(!reuse && !consumed && !fenced); consumed = true; assertCurrent(operation); live(fs);
          await repository.executionTransaction(async (tx, ops) => {
            const fresh = await inspect(tx, ops, fs); matches(fresh.intent); assertCurrent(operation);
            await ops.beforeDispatch(fresh.request.attempt_id!, leg, model);
            await bound(tx, fs); await context(tx, fs); assertCurrent(operation); live(fs);
          });
          fenced = true; assertCurrent(operation); live(fs);
        },
      });
    },
  }), async effect<T>(v: Readonly<AdmissionIntent>, s: AbortSignal, guard: AdmissionEffectGuard, dispatch: (guard: AdmissionEffectGuard) => Promise<T>) {
    live(s); matches(v); check(!released && (reuse || fenced)); released = true;
    const current: AdmissionEffectGuard = () => { live(s); guard(); }; current();
    if (guard.beginDispatch) {
      current.beginDispatch = () => { live(s); guard.beginDispatch!(); };
      current.assertCompletion = () => { live(s); guard.assertCompletion!(); };
    }
    if (!reuse) return dispatch(current);
    const fresh = await repository.executionTransaction((tx, ops) => inspect(tx, ops, s)); matches(fresh.intent); current();
    return fresh.assessment!;
  } });
}
