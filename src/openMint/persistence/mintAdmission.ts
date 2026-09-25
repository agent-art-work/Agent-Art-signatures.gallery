import { performance } from "node:perf_hooks";
import { admissionDigest, type AdmissionDatabaseLease, type AdmissionIntent } from "../staging/admission.js";
import { inspectLocalAssessmentBinding } from "./assessmentAdmission.js";
import type { PostgresMintRequests } from "./requests.js";
import { PersistenceConflictError, type OwnershipConnection } from "./writer.js";

type Tx = Pick<OwnershipConnection, "query">;
export interface LocalMintOperation<Result> {
  readonly requests: PostgresMintRequests;
  readonly intent: Readonly<AdmissionIntent>;
  inspect(tx: Tx): Promise<{ observedAt: number; validUntil: number }>;
  /** Uses the existing authorization/submission fence in the caller's owner transaction. */
  fence(tx: Tx): Promise<void>;
  /** No asynchronous gap between assertCurrent and the actual external effect. */
  effect(signal: AbortSignal, assertCurrent: () => void): Promise<Result>;
}
export interface LocalMintAdmissionConfig {
  expectedRole: string; databaseBindingSha256: string; scopeSha256: string; leaseMs: number;
}
const check = (v: unknown): void => { if (!v) throw new PersistenceConflictError("Local mint admission unavailable."); };
async function binding(tx: Tx, requests: PostgresMintRequests, role: string): Promise<string> {
  const base = await inspectLocalAssessmentBinding(tx, requests, role);
  const rows = (await tx.query<{ policy: string }>(`SELECT (to_jsonb(p)-'enabled')::text AS policy
    FROM open_mint.generative_issuance_profiles p WHERE namespace_id=$1 AND deployment_id=$2`,
  [requests.repository.namespace.id, requests.profile.deployment_id])).rows;
  check(rows.length === 1 && typeof rows[0]?.policy === "string");
  return admissionDigest({ version: "local-generative-mint-binding-v1", foundation: base.sha256, issuance: rows[0]!.policy });
}
/** Candidate pin, not public schema certification, custody or human approval. */
export function observeLocalMintBinding(requests: PostgresMintRequests, role: string): Promise<string> {
  return requests.repository.writer.transaction(tx => binding(tx, requests, role));
}

/** Server-owned operation only. No route, signer selection, broadcaster or
 * automatic retry. Acknowledged fences stay consumed even if release fails. */
export async function prepareLocalMintAdmission<Result>(operation: LocalMintOperation<Result>, config: LocalMintAdmissionConfig,
  signal = new AbortController().signal) {
  const { expectedRole, databaseBindingSha256, scopeSha256, leaseMs } = config;
  check([databaseBindingSha256, scopeSha256].every(v => typeof v === "string" && /^(?!0{64}$)[0-9a-f]{64}$/.test(v))
    && Number.isSafeInteger(leaseMs) && leaseMs > 0 && leaseMs <= 30000);
  const requests = operation.requests, writer = requests.repository.writer, epoch = writer.epoch;
  const intent = Object.freeze({ ...operation.intent }), intentSha256 = admissionDigest(intent);
  check(intent.operation === "sign" || intent.operation === "wallet-submit" || intent.operation === "reuse");
  const readonly = intent.operation === "reuse";
  const inspect = operation.inspect.bind(operation), fence = operation.fence.bind(operation), effect = operation.effect.bind(operation);
  let halted = false, acknowledged = false, released = false;
  const live = (s: AbortSignal) => { check(!halted && !s.aborted); writer.assertHealthy(); };
  const bound = async (tx: Tx, s: AbortSignal) => {
    live(s); check(await binding(tx, requests, expectedRole) === databaseBindingSha256); live(s);
  };
  await writer.transaction(async tx => { await bound(tx, signal); await inspect(tx); live(signal); });
  return Object.freeze({ intent, halt() { halted = true; }, database: Object.freeze({
    async inspect(value: Readonly<AdmissionIntent>, scope: string, s: AbortSignal): Promise<AdmissionDatabaseLease> {
      live(s); check(!acknowledged && scope === scopeSha256 && admissionDigest(value) === intentSha256);
      const start = performance.now();
      const observed = await writer.transaction(async tx => { await bound(tx, s); const r = await inspect(tx); live(s); return r; });
      const validUntil = Math.min(observed.validUntil, observed.observedAt + leaseMs);
      const assertCurrent = (op: string) => {
        live(s); check(op === intent.operation && writer.epoch === epoch && Date.now() >= observed.observedAt
          && Date.now() < validUntil && performance.now() - start < leaseMs);
      };
      let consumed = false; assertCurrent(intent.operation);
      return Object.freeze({ databaseBindingSha256, writerEpoch: epoch, intentSha256, observedAt: observed.observedAt, validUntil, assertCurrent,
        async fence(fs: AbortSignal) {
          check(!readonly && !consumed && !acknowledged); consumed = true; assertCurrent(intent.operation); live(fs);
          await writer.transaction(async tx => {
            await bound(tx, fs); await inspect(tx); assertCurrent(intent.operation);
            await fence(tx); await bound(tx, fs); assertCurrent(intent.operation); live(fs);
          });
          // Set only after acknowledged COMMIT. Lost replies preserve the DB
          // fence but cannot release a signature or wallet-send permission.
          acknowledged = true; assertCurrent(intent.operation); live(fs);
        },
      });
    },
  }), async effect(value: Readonly<AdmissionIntent>, s: AbortSignal, assertCurrent: () => void): Promise<Result> {
    live(s); check((readonly || acknowledged) && !released && admissionDigest(value) === intentSha256); released = true;
    const guard = () => { live(s); assertCurrent(); };
    guard(); return effect(s, guard);
  } });
}
