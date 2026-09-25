import { randomUUID } from "node:crypto";
import { validateAssessment, type Assessment, type AssessmentProvenance } from "../assessment.js";
import { validateProviderReceipt, type AbstentionReason, type ProviderLeg, type ProviderReceipt } from "../assessmentOperations.js";
import { canonicalHandle, POLICY_VERSION } from "../identity.js";
import { validateXIdentity, type XIdentitySnapshot } from "../xIdentity.js";
import { ExclusiveWriter, PersistenceConflictError, type OwnershipConnection } from "./writer.js";

export interface PersistenceNamespace {
  readonly id: string;
  readonly profile: "local-fixture" | "local-real" | "staging-testnet" | "production";
  readonly provenance: AssessmentProvenance;
  readonly policyVersion: string;
}
export type InitialAdmission =
  | { readonly kind: "accepted"; readonly assessment: Assessment }
  | { readonly kind: "created" | "joined"; readonly attemptId: string; readonly jobId: string };
export class AdmissionBlockedError extends Error {}
type Transaction = Pick<OwnershipConnection, "query">;
interface Policy {
  profile_version: string; expected_model: string; generation_enabled: boolean; valid_until: Date;
  max_total: number; max_daily: number; max_active: number; max_queued: number;
  reservation_usd_ticks: string; max_exposure_usd_ticks: string;
}
interface Attempt { attempt_id: string; handle: string; profile_version: string; state: "pending" | "accepted" | "closed" }
interface AssessmentRow { payload: Buffer; handle: string; assessment_id: string; digest: string }
interface ReceiptRow { payload: Buffer; leg: ProviderLeg; cost_status: string; cost_usd_ticks: string | null }
export type TerminalOutcome = { readonly kind: "abstained"; readonly reason: AbstentionReason }
  | { readonly kind: "invalid" | "uncertain" | "blocked-before-dispatch" };
export type AssessmentTerminal = TerminalOutcome & { readonly phase: "before-dispatch" | ProviderLeg };
export function validateAssessmentTerminal(row: { kind: string; reason: string | null; phase: string }): AssessmentTerminal {
  if (!["abstained", "invalid", "uncertain", "blocked-before-dispatch"].includes(row.kind)
    || !["before-dispatch", "x-identity", "grok"].includes(row.phase)
    || (row.kind === "abstained" ? !["insufficient-evidence", "subject-unavailable", "provider-refusal"].includes(row.reason ?? "") || row.phase !== "grok" : row.reason !== null)
    || ((row.kind === "blocked-before-dispatch") !== (row.phase === "before-dispatch"))) throw new PersistenceConflictError("Invalid stored terminal outcome.");
  return Object.freeze(row.kind === "abstained" ? { kind: row.kind, reason: row.reason, phase: row.phase } : { kind: row.kind, phase: row.phase }) as AssessmentTerminal;
}
export interface ExecutionTransaction {
  getAssessment(handle: string): Promise<Assessment | undefined>;
  claimInitial(id: string, expected: { handle: string; model: string }): Promise<void>;
  inspectDispatch(id: string, leg: ProviderLeg, expectedModel: string): Promise<DispatchReadiness>;
  beforeDispatch(id: string, leg: ProviderLeg, expectedModel: string): Promise<void>;
}
export interface DispatchReadiness {
  readonly handle: string; readonly profileVersion: string; readonly model: string;
  readonly now: number; readonly validUntil: number; readonly identity: XIdentitySnapshot | null;
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid persistence identifier.");
  return value;
}
function copyPayload(value: Uint8Array, maximum: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 2 || value.byteLength > maximum) throw new Error("Invalid immutable payload length.");
  return Buffer.from(value);
}
function json(bytes: Buffer): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
function sameBytes(actual: Buffer, expected: Buffer): void {
  if (!actual.equals(expected)) throw new PersistenceConflictError("Conflicting immutable evidence.");
}
function successful(receipt: ProviderReceipt | undefined): receipt is ProviderReceipt {
  return receipt?.category === "success" && (receipt.httpStatus === undefined || (receipt.httpStatus >= 200 && receipt.httpStatus < 300));
}

/** Lower-level persistence only: no HTTP/session admission, chain observation,
 * provider transport, worker loop, signer or public runtime is installed here.
 */
export class OpenMintRepository {
  readonly #namespace: PersistenceNamespace;
  private constructor(readonly writer: ExclusiveWriter, namespace: PersistenceNamespace) {
    this.#namespace = Object.freeze({ ...namespace });
  }
  get namespace(): PersistenceNamespace { return this.#namespace; }

  static async open(writer: ExclusiveWriter, namespace: PersistenceNamespace): Promise<OpenMintRepository> {
    uuid(namespace.id);
    if (namespace.policyVersion !== POLICY_VERSION) throw new PersistenceConflictError("Unsupported namespace assessment policy.");
    const copy = Object.freeze({ ...namespace });
    await writer.transaction(async tx => {
      const row = (await tx.query<{ profile: string; provenance: string; policy_version: string }>(
        "SELECT profile, provenance, policy_version FROM open_mint.namespaces WHERE namespace_id = $1", [copy.id])).rows[0];
      if (!row || row.profile !== copy.profile || row.provenance !== copy.provenance || row.policy_version !== copy.policyVersion) {
        throw new PersistenceConflictError("Namespace profile, provenance or policy mismatch.");
      }
    });
    return new OpenMintRepository(writer, copy);
  }

  #assessment(row: AssessmentRow, handle: string): Assessment {
    const value = validateAssessment(json(copyPayload(row.payload, 524288)));
    if (value.handle !== handle || row.handle !== handle || value.id !== row.assessment_id || value.digest !== row.digest
      || value.provenance !== this.#namespace.provenance || value.policyVersion !== this.#namespace.policyVersion) {
      throw new PersistenceConflictError("Stored assessment scope or commitment mismatch.");
    }
    return value;
  }
  async #getAssessment(tx: Transaction, handle: string): Promise<Assessment | undefined> {
    const row = (await tx.query<AssessmentRow>("SELECT payload, handle, assessment_id, digest FROM open_mint.assessments WHERE namespace_id = $1 AND handle = $2", [this.#namespace.id, handle])).rows[0];
    return row && this.#assessment(row, handle);
  }
  getAssessment(value: string): Promise<Assessment | undefined> {
    const handle = canonicalHandle(value);
    return this.writer.transaction(tx => this.#getAssessment(tx, handle));
  }

  /** Read-only provenance join for a separately chain-verified mint. No job,
   * reservation, input journal, generation policy or provider is invoked. */
  getAcceptedAssessment(value: string, digest: string, signal: AbortSignal): Promise<Assessment | undefined> {
    const handle = canonicalHandle(value);
    if (handle !== value || !/^0x[0-9a-f]{64}$/.test(digest)) throw new PersistenceConflictError("Invalid assessment lookup.");
    signal.throwIfAborted();
    return this.writer.transaction(async tx => {
      signal.throwIfAborted();
      const row = (await tx.query<AssessmentRow>(`SELECT s.payload,s.handle,s.assessment_id,s.digest
        FROM open_mint.assessments s JOIN open_mint.assessment_attempts a USING(namespace_id,attempt_id)
        WHERE s.namespace_id=$1 AND s.handle=$2 AND s.digest=$3 AND a.state='accepted'`,
      [this.#namespace.id, handle, digest])).rows[0];
      signal.throwIfAborted();
      if (!row) return undefined;
      const assessment = this.#assessment(row, handle);
      if (assessment.digest !== digest) throw new PersistenceConflictError("Stored assessment commitment mismatch.");
      return assessment;
    });
  }

  async #policy(tx: Transaction, now: Date): Promise<Policy> {
    const policy = (await tx.query<Policy>("SELECT * FROM open_mint.budget_policies WHERE namespace_id = $1 FOR UPDATE", [this.#namespace.id])).rows[0];
    if (!policy || !policy.generation_enabled || policy.valid_until.getTime() <= now.getTime()) throw new AdmissionBlockedError("Generation disabled or policy expired.");
    this.#paidReservation(policy);
    return policy;
  }
  #paidReservation(policy: Policy): void {
    if (this.#namespace.provenance === "grok" && BigInt(policy.reservation_usd_ticks) <= 0n) throw new AdmissionBlockedError("Real assessment requires a positive exposure reservation.");
    if (this.#namespace.provenance === "grok" ? !policy.expected_model.startsWith("grok-") : policy.expected_model !== "development-fixture-v1") throw new AdmissionBlockedError("Assessment model does not match namespace provenance.");
  }
  async #now(tx: Transaction): Promise<Date> {
    return (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
  }
  async #attempt(tx: Transaction, attemptId: string): Promise<Attempt> {
    const row = (await tx.query<Attempt>("SELECT attempt_id, handle, profile_version, state FROM open_mint.assessment_attempts WHERE namespace_id = $1 AND attempt_id = $2 FOR UPDATE", [this.#namespace.id, attemptId])).rows[0];
    if (!row) throw new PersistenceConflictError("Attempt not found in this namespace.");
    return row;
  }

  /** Lower-level assessment repository API; not an HTTP admission endpoint. */
  admitInitial(value: string): Promise<InitialAdmission> {
    const handle = canonicalHandle(value);
    return this.writer.transaction(tx => this.#admitInitial(tx, handle));
  }

  /** Internal composition boundary for durable request admission. The callback
   * performs database/local validation only, with the same owner transaction.
   * No provider, chain RPC, wallet or signer call may run inside this callback. */
  admissionTransaction<T>(work: (tx: Transaction, admit: (handle: string) => Promise<InitialAdmission>) => Promise<T>): Promise<T> {
    return this.writer.transaction(tx => work(tx, handle => this.#admitInitial(tx, canonicalHandle(handle))));
  }

  /** Internal database-only composition, never a provider/RPC callback. */
  executionTransaction<T>(work: (tx: Transaction, execution: ExecutionTransaction) => Promise<T>): Promise<T> {
    return this.writer.transaction(tx => work(tx, {
      getAssessment: handle => this.#getAssessment(tx, canonicalHandle(handle)),
      claimInitial: (id, expected) => this.#claimInitial(tx, uuid(id), expected),
      inspectDispatch: (id, leg, model) => this.#inspectDispatch(tx, uuid(id), leg, model),
      beforeDispatch: (id, leg, model) => this.#beforeDispatch(tx, uuid(id), leg, model),
    }));
  }
  #guardedMutation<T>(guard: (() => void) | undefined, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.writer.transaction(async tx => { guard?.(); const result = await work(tx); guard?.(); return result; });
  }
  async #admitInitial(tx: Transaction, handle: string): Promise<InitialAdmission> {
      // Policy then permanent handle guard is the fixed admission lock order.
      const policy = (await tx.query<Policy>("SELECT * FROM open_mint.budget_policies WHERE namespace_id = $1 FOR UPDATE", [this.#namespace.id])).rows[0];
      await tx.query("INSERT INTO open_mint.handle_guards(namespace_id, handle) VALUES ($1, $2) ON CONFLICT DO NOTHING", [this.#namespace.id, handle]);
      await tx.query("SELECT handle FROM open_mint.handle_guards WHERE namespace_id = $1 AND handle = $2 FOR UPDATE", [this.#namespace.id, handle]);
      const accepted = await this.#getAssessment(tx, handle);
      if (accepted) return { kind: "accepted", assessment: accepted };
      const previous = (await tx.query<{ attempt_id: string; job_id: string }>(`SELECT a.attempt_id, j.job_id FROM open_mint.assessment_attempts a
        JOIN open_mint.jobs j USING (namespace_id, attempt_id) WHERE a.namespace_id = $1 AND a.handle = $2 AND j.kind = 'assessment'`, [this.#namespace.id, handle])).rows[0];
      if (previous) return { kind: "joined", attemptId: previous.attempt_id, jobId: previous.job_id };
      const now = await this.#now(tx);
      if (!policy || !policy.generation_enabled || policy.valid_until.getTime() <= now.getTime()) throw new AdmissionBlockedError("Generation disabled or policy expired.");
      this.#paidReservation(policy);
      if (this.#namespace.provenance === "grok") {
        const unresolved = (await tx.query<{ unresolved: boolean }>(`SELECT EXISTS (SELECT 1 FROM open_mint.budget_reservations r
          WHERE r.namespace_id = $1 AND (SELECT count(*) FROM open_mint.provider_receipts p
            WHERE p.namespace_id = r.namespace_id AND p.attempt_id = r.attempt_id AND p.cost_status = 'actual') <> 2) AS unresolved`, [this.#namespace.id])).rows[0];
        if (unresolved?.unresolved !== false) throw new AdmissionBlockedError("Prior real accounting requires operator reconciliation.");
      }
      const day = now.toISOString().slice(0, 10);
      const totals = (await tx.query<{ total: string; daily: string; exposure: string }>(`SELECT count(*)::text AS total,
        count(*) FILTER (WHERE r.admitted_day = $2::date)::text AS daily,
        COALESCE(sum(GREATEST(r.reserved_usd_ticks, COALESCE((SELECT sum(p.cost_usd_ticks)
          FROM open_mint.provider_receipts p WHERE p.namespace_id = r.namespace_id AND p.attempt_id = r.attempt_id), 0))), 0)::text AS exposure
        FROM open_mint.budget_reservations r WHERE r.namespace_id = $1`, [this.#namespace.id, day])).rows[0]!;
      const counts = (await tx.query<{ active: string; queued: string }>(`SELECT
        (SELECT count(*) FROM open_mint.assessment_attempts WHERE namespace_id = $1 AND state = 'pending')::text AS active,
        (SELECT count(*) FROM open_mint.jobs WHERE namespace_id = $1 AND state <> 'complete')::text AS queued`, [this.#namespace.id])).rows[0]!;
      if (BigInt(totals.total) >= BigInt(policy.max_total) || BigInt(totals.daily) >= BigInt(policy.max_daily)
        || BigInt(counts.active) >= BigInt(policy.max_active) || BigInt(counts.queued) >= BigInt(policy.max_queued)
        || BigInt(totals.exposure) + BigInt(policy.reservation_usd_ticks) > BigInt(policy.max_exposure_usd_ticks)) {
        throw new AdmissionBlockedError("Assessment count, queue or exposure limit reached.");
      }
      const attemptId = randomUUID(), jobId = randomUUID();
      await tx.query(`INSERT INTO open_mint.assessment_attempts(namespace_id, attempt_id, handle, profile_version, admitted_at)
        VALUES ($1, $2, $3, $4, $5)`, [this.#namespace.id, attemptId, handle, policy.profile_version, now]);
      await tx.query(`INSERT INTO open_mint.budget_reservations(namespace_id, attempt_id, admitted_day, reserved_usd_ticks)
        VALUES ($1, $2, $3, $4)`, [this.#namespace.id, attemptId, day, policy.reservation_usd_ticks]);
      await tx.query("INSERT INTO open_mint.jobs(namespace_id, job_id, attempt_id, kind) VALUES ($1, $2, $3, 'assessment')", [this.#namespace.id, jobId, attemptId]);
      return { kind: "created", attemptId, jobId };
  }

  /** Does not dispatch anything. Previously claimed work requires recovery;
   * only an untouched queued job can acquire this process's epoch. */
  claimInitial(id: string): Promise<void> {
    const attemptId = uuid(id);
    return this.writer.transaction(tx => this.#claimInitial(tx, attemptId));
  }
  async #claimInitial(tx: Transaction, attemptId: string, expected?: { handle: string; model: string }): Promise<void> {
      const policy = await this.#policy(tx, await this.#now(tx));
      if (expected) {
        const attempt = await this.#attempt(tx, attemptId);
        if (attempt.handle !== expected.handle || attempt.state !== "pending" || attempt.profile_version !== policy.profile_version
          || policy.expected_model !== expected.model) throw new PersistenceConflictError("Worker attempt/model/profile mismatch.");
      }
      const changed = await tx.query(`UPDATE open_mint.jobs j SET state = 'running', owner_epoch = $3
        WHERE namespace_id = $1 AND attempt_id = $2 AND kind = 'assessment' AND state = 'queued'
        AND NOT EXISTS (SELECT 1 FROM open_mint.dispatch_fences d WHERE d.namespace_id = j.namespace_id AND d.attempt_id = j.attempt_id)`, [this.#namespace.id, attemptId, this.writer.epoch]);
      if (changed.rowCount !== 1) throw new PersistenceConflictError("Job already claimed, interrupted, or outside this namespace.");
  }
  async #running(tx: Transaction, attemptId: string): Promise<Attempt> {
    const attempt = await this.#attempt(tx, attemptId);
    const job = (await tx.query<{ owner_epoch: string; state: string }>("SELECT owner_epoch::text, state FROM open_mint.jobs WHERE namespace_id = $1 AND attempt_id = $2 AND kind = 'assessment'", [this.#namespace.id, attemptId])).rows[0];
    if (attempt.state !== "pending" || job?.owner_epoch !== this.writer.epoch || job.state !== "running") throw new PersistenceConflictError("Attempt is not running under this writer epoch.");
    return attempt;
  }
  async #receipt(tx: Transaction, attemptId: string, leg: ProviderLeg): Promise<{ value: ProviderReceipt; bytes: Buffer } | undefined> {
    const row = (await tx.query<ReceiptRow>("SELECT payload, leg, cost_status, cost_usd_ticks::text FROM open_mint.provider_receipts WHERE namespace_id = $1 AND attempt_id = $2 AND leg = $3", [this.#namespace.id, attemptId, leg])).rows[0];
    if (!row) return undefined;
    const bytes = copyPayload(row.payload, 16384), value = validateProviderReceipt(json(bytes));
    if (value.leg !== leg || row.leg !== leg || value.cost.status !== row.cost_status || (value.cost.amount ?? null) !== row.cost_usd_ticks) throw new PersistenceConflictError("Receipt scalar mismatch.");
    return { value, bytes };
  }
  getReceipt(id: string, leg: ProviderLeg): Promise<ProviderReceipt | undefined> {
    const attemptId = uuid(id);
    return this.writer.transaction(async tx => (await this.#receipt(tx, attemptId, leg))?.value);
  }
  async #identity(tx: Transaction, attemptId: string, handle: string): Promise<{ value: XIdentitySnapshot; bytes: Buffer } | undefined> {
    const row = (await tx.query<{ payload: Buffer }>("SELECT payload FROM open_mint.verified_identities WHERE namespace_id = $1 AND attempt_id = $2", [this.#namespace.id, attemptId])).rows[0];
    if (!row) return undefined;
    const bytes = copyPayload(row.payload, 4096), value = validateXIdentity(json(bytes), handle);
    if ((value.provenance === "development-fixture") !== (this.#namespace.provenance === "development-fixture")) throw new PersistenceConflictError("Identity provenance mismatch.");
    return { value, bytes };
  }

  /** The returned promise must settle successfully BEFORE the external call.
   * A marker survives process loss and is never a permission to retry a leg. */
  beforeDispatch(id: string, leg: ProviderLeg): Promise<void> {
    const attemptId = uuid(id);
    if (leg !== "x-identity" && leg !== "grok") throw new Error("Invalid provider leg.");
    return this.writer.transaction(tx => this.#beforeDispatch(tx, attemptId, leg));
  }
  async #inspectDispatch(tx: Transaction, attemptId: string, leg: ProviderLeg, expectedModel?: string): Promise<DispatchReadiness> {
      if (leg !== "x-identity" && leg !== "grok") throw new Error("Invalid provider leg.");
      const now = await this.#now(tx), policy = await this.#policy(tx, now);
      if (expectedModel !== undefined && policy.expected_model !== expectedModel) throw new PersistenceConflictError("Worker model/profile mismatch.");
      const attempt = await this.#running(tx, attemptId);
      if (attempt.profile_version !== policy.profile_version) throw new PersistenceConflictError("Attempt profile mismatch.");
      const exposure = (await tx.query<{ exposure: string }>(`SELECT COALESCE(sum(GREATEST(r.reserved_usd_ticks,
        COALESCE((SELECT sum(p.cost_usd_ticks) FROM open_mint.provider_receipts p
          WHERE p.namespace_id = r.namespace_id AND p.attempt_id = r.attempt_id), 0))), 0)::text AS exposure
        FROM open_mint.budget_reservations r WHERE r.namespace_id = $1`, [this.#namespace.id])).rows[0]!;
      if (BigInt(exposure.exposure) > BigInt(policy.max_exposure_usd_ticks)) throw new AdmissionBlockedError("Recorded exposure exceeds the policy limit.");
      let identity: XIdentitySnapshot | null = null;
      if (leg === "grok") {
        const receipt = await this.#receipt(tx, attemptId, "x-identity");
        identity = (await this.#identity(tx, attemptId, attempt.handle))?.value ?? null;
        if (!successful(receipt?.value) || !identity) throw new PersistenceConflictError("Grok requires durable successful X receipt and validated identity.");
      }
      if ((await tx.query("SELECT 1 FROM open_mint.dispatch_fences WHERE namespace_id=$1 AND attempt_id=$2 AND leg=$3", [this.#namespace.id, attemptId, leg])).rows.length)
        throw new PersistenceConflictError("Provider leg possibly dispatched already; retry forbidden.");
      return { handle: attempt.handle, profileVersion: policy.profile_version, model: policy.expected_model, now: now.getTime(), validUntil: policy.valid_until.getTime(), identity };
  }
  async #beforeDispatch(tx: Transaction, attemptId: string, leg: ProviderLeg, expectedModel?: string): Promise<void> {
      const ready = await this.#inspectDispatch(tx, attemptId, leg, expectedModel);
      const inserted = await tx.query(`INSERT INTO open_mint.dispatch_fences(namespace_id, attempt_id, leg, owner_epoch, dispatched_at)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [this.#namespace.id, attemptId, leg, this.writer.epoch, new Date(ready.now)]);
      if (inserted.rowCount !== 1) throw new PersistenceConflictError("Provider leg possibly dispatched already; retry forbidden.");
  }

  async #terminal(tx: Transaction, attemptId: string): Promise<AssessmentTerminal | undefined> {
    const row = (await tx.query<{ kind: AssessmentTerminal["kind"]; reason: AbstentionReason | null; phase: AssessmentTerminal["phase"] }>(
      "SELECT kind, reason, phase FROM open_mint.assessment_terminals WHERE namespace_id=$1 AND attempt_id=$2", [this.#namespace.id, attemptId])).rows[0];
    if (!row) return undefined;
    return validateAssessmentTerminal(row);
  }
  getTerminal(id: string): Promise<AssessmentTerminal | undefined> {
    const attemptId = uuid(id); return this.writer.transaction(tx => this.#terminal(tx, attemptId));
  }
  /** Closes only this epoch's running attempt. Spend and permanent guard survive. */
  finishAttempt(id: string, input: TerminalOutcome, guard?: () => void): Promise<AssessmentTerminal> {
    const attemptId = uuid(id), outcome = structuredClone(input);
    if (!outcome || !["abstained", "invalid", "uncertain", "blocked-before-dispatch"].includes(outcome.kind)
      || Object.keys(outcome).sort().join(",") !== (outcome.kind === "abstained" ? "kind,reason" : "kind")
      || (outcome.kind === "abstained" && !["insufficient-evidence", "subject-unavailable", "provider-refusal"].includes(outcome.reason))) throw new PersistenceConflictError("Invalid terminal outcome.");
    return this.#guardedMutation(guard, tx => this.#finishAttempt(tx, attemptId, outcome));
  }
  async #finishAttempt(tx: Transaction, attemptId: string, outcome: TerminalOutcome): Promise<AssessmentTerminal> {
      const previous = await this.#terminal(tx, attemptId);
      if (previous) {
        if (previous.kind !== outcome.kind || (previous.kind === "abstained" && (outcome.kind !== "abstained" || previous.reason !== outcome.reason))) throw new PersistenceConflictError("Conflicting immutable terminal outcome.");
        return previous;
      }
      await this.#running(tx, attemptId);
      const fences = (await tx.query<{ leg: ProviderLeg }>("SELECT leg FROM open_mint.dispatch_fences WHERE namespace_id=$1 AND attempt_id=$2", [this.#namespace.id, attemptId])).rows;
      const phase = fences.some(row => row.leg === "grok") ? "grok" : fences.some(row => row.leg === "x-identity") ? "x-identity" : "before-dispatch";
      if ((outcome.kind === "blocked-before-dispatch") !== (phase === "before-dispatch")) throw new PersistenceConflictError("Terminal outcome does not match dispatch evidence.");
      if (outcome.kind === "abstained" && (phase !== "grok" || !successful((await this.#receipt(tx, attemptId, "grok"))?.value))) throw new PersistenceConflictError("Abstention requires durable successful Grok receipt.");
      if (outcome.kind === "invalid" && !successful((await this.#receipt(tx, attemptId, phase as ProviderLeg))?.value)) throw new PersistenceConflictError("Semantic invalidity requires a durable successful response.");
      await tx.query("INSERT INTO open_mint.assessment_terminals(namespace_id,attempt_id,kind,reason,phase,owner_epoch) VALUES($1,$2,$3,$4,$5,$6)",
        [this.#namespace.id, attemptId, outcome.kind, outcome.kind === "abstained" ? outcome.reason : null, phase, this.writer.epoch]);
      await tx.query("UPDATE open_mint.assessment_attempts SET state='closed' WHERE namespace_id=$1 AND attempt_id=$2 AND state='pending'", [this.#namespace.id, attemptId]);
      await tx.query("UPDATE open_mint.jobs SET state='complete' WHERE namespace_id=$1 AND attempt_id=$2 AND kind='assessment' AND owner_epoch=$3", [this.#namespace.id, attemptId, this.writer.epoch]);
      return Object.freeze({ ...outcome, phase });
  }

  /** Deadline cleanup runs behind in-flight mutations. Never infer dispatch from
   * process memory or overwrite an accepted/queued/other-epoch operation. */
  interruptAttempt(id: string): Promise<AssessmentTerminal | undefined> {
    const attemptId = uuid(id);
    return this.writer.transaction(async tx => {
      const previous = await this.#terminal(tx, attemptId); if (previous) return previous;
      const attempt = await this.#attempt(tx, attemptId);
      const job = (await tx.query<{ owner_epoch: string; state: string }>("SELECT owner_epoch::text, state FROM open_mint.jobs WHERE namespace_id = $1 AND attempt_id = $2 AND kind = 'assessment'", [this.#namespace.id, attemptId])).rows[0];
      if (attempt.state !== "pending" || job?.state !== "running" || job.owner_epoch !== this.writer.epoch) return undefined;
      const fence = (await tx.query("SELECT leg FROM open_mint.dispatch_fences WHERE namespace_id=$1 AND attempt_id=$2", [this.#namespace.id, attemptId])).rows;
      return this.#finishAttempt(tx, attemptId, { kind: fence.length ? "uncertain" : "blocked-before-dispatch" });
    });
  }

  recordReceipt(id: string, payload: Uint8Array, guard?: () => void): Promise<void> {
    const attemptId = uuid(id), bytes = copyPayload(payload, 16384), receipt = validateProviderReceipt(json(bytes));
    return this.#guardedMutation(guard, async tx => {
      const previous = await this.#receipt(tx, attemptId, receipt.leg);
      if (previous) { sameBytes(previous.bytes, bytes); return; }
      await this.#running(tx, attemptId);
      const fence = (await tx.query<{ owner_epoch: string }>("SELECT owner_epoch::text FROM open_mint.dispatch_fences WHERE namespace_id = $1 AND attempt_id = $2 AND leg = $3", [this.#namespace.id, attemptId, receipt.leg])).rows[0];
      if (fence?.owner_epoch !== this.writer.epoch) throw new PersistenceConflictError("Receipt requires a committed dispatch owned by this process.");
      await tx.query(`INSERT INTO open_mint.provider_receipts(namespace_id, attempt_id, leg, payload, cost_status, cost_usd_ticks)
        VALUES ($1, $2, $3, $4, $5, $6)`, [this.#namespace.id, attemptId, receipt.leg, bytes, receipt.cost.status, receipt.cost.amount ?? null]);
    });
  }

  recordIdentity(id: string, payload: Uint8Array, guard?: () => void): Promise<void> {
    const attemptId = uuid(id), bytes = copyPayload(payload, 4096);
    return this.#guardedMutation(guard, async tx => {
      const attempt = await this.#attempt(tx, attemptId), identity = validateXIdentity(json(bytes), attempt.handle);
      if ((identity.provenance === "development-fixture") !== (this.#namespace.provenance === "development-fixture")) throw new PersistenceConflictError("Identity provenance mismatch.");
      const previous = await this.#identity(tx, attemptId, attempt.handle);
      if (previous) { sameBytes(previous.bytes, bytes); return; }
      await this.#running(tx, attemptId);
      if (!successful((await this.#receipt(tx, attemptId, "x-identity"))?.value)) throw new PersistenceConflictError("Identity requires a durable successful X receipt.");
      await tx.query("INSERT INTO open_mint.verified_identities(namespace_id, attempt_id, payload) VALUES ($1, $2, $3)", [this.#namespace.id, attemptId, bytes]);
    });
  }

  acceptAssessment(id: string, payload: Uint8Array, guard?: () => void): Promise<Assessment> {
    const attemptId = uuid(id), bytes = copyPayload(payload, 524288), value = validateAssessment(json(bytes));
    uuid(value.id);
    if (value.provenance !== this.#namespace.provenance || value.policyVersion !== this.#namespace.policyVersion) throw new PersistenceConflictError("Assessment namespace mismatch.");
    return this.#guardedMutation(guard, async tx => {
      const attempt = await this.#attempt(tx, attemptId);
      if (attempt.handle !== value.handle) throw new PersistenceConflictError("Assessment attempt handle mismatch.");
      const previous = (await tx.query<AssessmentRow>("SELECT payload, handle, assessment_id, digest FROM open_mint.assessments WHERE namespace_id = $1 AND handle = $2", [this.#namespace.id, value.handle])).rows[0];
      if (previous) { const accepted = this.#assessment(previous, value.handle); sameBytes(previous.payload, bytes); return accepted; }
      await this.#running(tx, attemptId);
      const policy = (await tx.query<Policy>("SELECT * FROM open_mint.budget_policies WHERE namespace_id = $1", [this.#namespace.id])).rows[0];
      if (!policy || value.model !== policy.expected_model || attempt.profile_version !== policy.profile_version) throw new PersistenceConflictError("Assessment model/profile mismatch.");
      const receipt = (await this.#receipt(tx, attemptId, "grok"))?.value;
      if (!successful(receipt)) throw new PersistenceConflictError("Assessment requires a durable successful Grok receipt.");
      if ((receipt.model !== undefined && receipt.model !== value.model) || (receipt.responseId !== undefined && receipt.responseId !== value.providerResponseId)) throw new PersistenceConflictError("Assessment does not match its provider receipt.");
      const identity = await this.#identity(tx, attemptId, attempt.handle);
      if (!identity || !value.xIdentity || Object.keys(identity.value).some(key => identity.value[key as keyof XIdentitySnapshot] !== value.xIdentity![key as keyof XIdentitySnapshot])) {
        throw new PersistenceConflictError("Assessment does not bind the durable verified identity.");
      }
      await tx.query(`INSERT INTO open_mint.assessments(namespace_id, handle, assessment_id, attempt_id, digest, payload)
        VALUES ($1, $2, $3, $4, $5, $6)`, [this.#namespace.id, value.handle, value.id, attemptId, value.digest, bytes]);
      await tx.query("UPDATE open_mint.assessment_attempts SET state = 'accepted' WHERE namespace_id = $1 AND attempt_id = $2 AND state = 'pending'", [this.#namespace.id, attemptId]);
      await tx.query("UPDATE open_mint.jobs SET state = 'complete' WHERE namespace_id = $1 AND attempt_id = $2 AND kind = 'assessment' AND owner_epoch = $3", [this.#namespace.id, attemptId, this.writer.epoch]);
      await tx.query("INSERT INTO open_mint.jobs(namespace_id, job_id, attempt_id, kind) VALUES ($1, $2, $3, 'render')", [this.#namespace.id, randomUUID(), attemptId]);
      return value;
    });
  }
}
