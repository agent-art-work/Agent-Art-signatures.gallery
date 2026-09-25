import { performance } from "node:perf_hooks";
import { admissionDigest, type AdmissionDatabaseLease, type AdmissionIntent } from "../staging/admission.js";
import { verifySelectedRuntimeDatabase, readCertifiedDatabaseProfiles } from "./databaseCertification.js";
import type { StagingAssessmentBinding } from "./stagingAssessmentAdmission.js";
import type { LocalMintOperation } from "./mintAdmission.js";
import type { PostgresMintRequests } from "./requests.js";
import { PersistenceConflictError, type OwnershipConnection } from "./writer.js";

type Tx = Pick<OwnershipConnection, "query">;
const check = (v: unknown): void => { if (!v) throw new PersistenceConflictError("Staging mint admission unavailable."); };

/** Database-only, same-transaction certification. Live switches are separate
 * from the pinned static profile; generation does not govern saved mint work. */
export async function certifyStagingMintBinding(tx: Tx, requests: PostgresMintRequests, config: StagingAssessmentBinding,
  signal: AbortSignal, issuance: boolean) {
  const { repository, profile: p } = requests, ns = repository.namespace;
  signal.throwIfAborted(); repository.writer.assertHealthy();
  check(ns.profile === "staging-testnet" && ns.provenance === "grok" && p.chain_id === "11155111"
    && p.session_chain_id === "11155111" && p.origin === "https://staging.signatures.gallery"
    && config.review.namespaceId === ns.id && config.review.deploymentId === p.deployment_id);
  const result = await verifySelectedRuntimeDatabase(tx, config.review, signal, Math.min(config.leaseMs, 5000));
  signal.throwIfAborted(); repository.writer.assertHealthy();
  check(result.databaseBindingSha256 === config.databaseBindingSha256 && (!issuance || result.issuanceEnabled));
  check(config.assertProfiles(readCertifiedDatabaseProfiles(result)) === undefined);
  const { origin, session_chain_id: _, ...cached } = p;
  const rows = (await tx.query<{ ok: boolean }>(`SELECT ((to_jsonb(r)||jsonb_build_object('chain_id',r.chain_id::text,'deployment_block',r.deployment_block::text))=$3::jsonb
    AND s.origin=$4 AND s.chain_id=r.chain_id AND n.profile=$5 AND n.provenance=$6 AND n.policy_version=$7) AS ok
    FROM open_mint.request_profiles r JOIN open_mint.session_profiles s USING(namespace_id) JOIN open_mint.namespaces n USING(namespace_id)
    WHERE r.namespace_id=$1 AND r.deployment_id=$2`, [ns.id, p.deployment_id, JSON.stringify(cached), origin, ns.profile, ns.provenance, ns.policyVersion])).rows;
  check(rows.length === 1 && rows[0].ok === true); signal.throwIfAborted(); repository.writer.assertHealthy();
}

/** Mandatory exact SQL certification around existing signing/wallet fences.
 * The operation is installed by trusted server code, never by a browser. */
export async function prepareStagingMintAdmission<T>(operation: LocalMintOperation<T>, config: StagingAssessmentBinding,
  signal = new AbortController().signal) {
  const requests = operation.requests, writer = requests.repository.writer, epoch = writer.epoch;
  const c = Object.freeze({ ...config, review: Object.freeze({ ...config.review }), assertProfiles: config.assertProfiles.bind(config) });
  check([c.databaseBindingSha256, c.scopeSha256].every(v => /^(?!0{64}$)[a-f0-9]{64}$/.test(v))
    && Number.isSafeInteger(c.leaseMs) && c.leaseMs > 0 && c.leaseMs <= 30000);
  const intent = Object.freeze({ ...operation.intent }), digest = admissionDigest(intent), reuse = intent.operation === "reuse";
  check(["sign", "wallet-submit", "reuse"].includes(intent.operation));
  const inspect = operation.inspect.bind(operation), fence = operation.fence.bind(operation), effect = operation.effect.bind(operation);
  let halted = false, acknowledged = false, released = false;
  const live = (s: AbortSignal) => { check(!halted && !s.aborted); writer.assertHealthy(); };
  const bound = async (tx: Tx, s: AbortSignal) => { live(s); await certifyStagingMintBinding(tx, requests, c, s, true); live(s); };
  await writer.transaction(async tx => { await bound(tx, signal); await inspect(tx); live(signal); });
  return Object.freeze({ intent, halt() { halted = true; }, database: Object.freeze({
    async inspect(v: Readonly<AdmissionIntent>, scope: string, s: AbortSignal): Promise<AdmissionDatabaseLease> {
      live(s); check(!acknowledged && scope === c.scopeSha256 && admissionDigest(v) === digest);
      const start = performance.now(), observed = await writer.transaction(async tx => {
        await bound(tx, s); const current = await inspect(tx); live(s); return current;
      });
      const validUntil = Math.min(observed.validUntil, observed.observedAt + c.leaseMs);
      const assertCurrent = (op: string) => { live(s); check(op === intent.operation && writer.epoch === epoch && Date.now() >= observed.observedAt
        && Date.now() < validUntil && performance.now() - start < c.leaseMs); };
      let consumed = false; assertCurrent(intent.operation);
      return Object.freeze({ databaseBindingSha256: c.databaseBindingSha256, writerEpoch: epoch, intentSha256: digest,
        observedAt: observed.observedAt, validUntil, assertCurrent,
        async fence(fs: AbortSignal) {
          check(!reuse && !consumed && !acknowledged); consumed = true; assertCurrent(intent.operation); live(fs);
          await writer.transaction(async tx => {
            await bound(tx, fs); await inspect(tx); assertCurrent(intent.operation);
            await fence(tx); await bound(tx, fs); assertCurrent(intent.operation); live(fs);
          });
          acknowledged = true; assertCurrent(intent.operation); live(fs);
        },
      });
    },
  }), async effect(v: Readonly<AdmissionIntent>, s: AbortSignal, guard: () => void): Promise<T> {
    live(s); check((reuse || acknowledged) && !released && admissionDigest(v) === digest); released = true;
    const current = () => { live(s); guard(); }; current(); return effect(s, current);
  } });
}
