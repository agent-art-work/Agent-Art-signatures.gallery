import { createHash, randomUUID } from "node:crypto";
import canonicalize from "canonicalize";
import { getAddress } from "viem";
import { GenerativeRecoveryBlockedError, GenerativeRecoveryChain, readGenerativeRecoveryEvidence,
  type GenerativeRecoveryWitness } from "../generativeRecoveryChain.js";
import type { AuthorizationReservation, PostgresGenerativeAuthorizationIssuer } from "./generativeAuthorizations.js";
import type { PreparedGenerativeInputs } from "./generativeInputs.js";
import { auditGenerativeRecoveryRole } from "./roleAudit.js";
import type { OwnershipConnection } from "./writer.js";

type Tx = Pick<OwnershipConnection, "query">;
const json = (v: unknown) => Buffer.from(canonicalize(v)!);
const hash = (v: unknown) => createHash("sha256").update(json(v)).digest("hex");
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
function fail(message: string): never { throw new GenerativeRecoveryBlockedError(message); }
export interface GenerativeRecoveryPlan {
  readonly recoveryId: string; readonly authorizationId: string; readonly handle: string;
  readonly deadline: string; readonly finalizedBlock: string; readonly snapshotHash: string;
  readonly reason: string; readonly action: "retire-expired-unminted";
  readonly recipient: string; readonly walletNonce: string | null;
  readonly submission: "not-started" | "unknown" | "rejected" | "submitted";
  readonly transactionHash: string | null;
}
interface Captured { reservation: AuthorizationReservation; artifact: PreparedGenerativeInputs; witness: GenerativeRecoveryWitness; plan: GenerativeRecoveryPlan; epoch: string }

/** Offline operator capability, not registered in HTTP or background tasks.
 * The writer must be newly acquired after site shutdown, with the separately
 * audited recovery role and issuance disabled. Planning does not write. Apply
 * is explicit, atomic and never restarts issuance, signs, assesses or sends.
 */
export class PostgresGenerativeRecovery {
  readonly #plans = new WeakMap<GenerativeRecoveryPlan, Captured>();
  private constructor(readonly issuer: PostgresGenerativeAuthorizationIssuer, readonly chain: GenerativeRecoveryChain) {}
  get writer() { return this.issuer.writer; }
  get namespaceId() { return this.issuer.requests.repository.namespace.id; }
  get deploymentId() { return this.issuer.requests.profile.deployment_id; }
  static async open(issuer: PostgresGenerativeAuthorizationIssuer, chain: GenerativeRecoveryChain) {
    const recovery = new PostgresGenerativeRecovery(issuer, chain);
    await issuer.writer.transaction(async tx => {
      if (!(await auditGenerativeRecoveryRole(tx)).ok) fail("A dedicated restricted recovery role is required.");
      await recovery.#disabled(tx);
    });
    return recovery;
  }
  async #disabled(tx: Tx) {
    const policy = (await tx.query<{ enabled: boolean; max_evidence_age_ms: number; max_block_age_ms: number; max_future_skew_ms: number }>(
      "SELECT enabled,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms FROM open_mint.generative_issuance_profiles WHERE namespace_id=$1 AND deployment_id=$2 FOR SHARE",
      [this.namespaceId, this.deploymentId])).rows[0];
    if (!policy || policy.enabled) fail("Stop and drain the site, then disable issuance before operator recovery.");
    return policy;
  }
  async #snapshot(tx: Tx, r: AuthorizationReservation, artifact: PreparedGenerativeInputs) {
    await this.#disabled(tx);
    const args = [this.namespaceId, this.deploymentId, r.id];
    const authorization = (await tx.query<{ payload: Buffer; state: string; signing_epoch: string | null }>(`SELECT a.payload,a.state,a.signing_epoch::text
      FROM open_mint.generative_authorizations a JOIN open_mint.generative_authorization_heads h USING(namespace_id,deployment_id,handle,authorization_id)
      WHERE a.namespace_id=$1 AND a.deployment_id=$2 AND a.authorization_id=$3`, args)).rows[0];
    if (!authorization || !authorization.payload.equals(json(r))) fail("The exact active reservation is required; no reset was performed.");
    const inputs = (await tx.query<{ payload: Buffer }>("SELECT payload FROM open_mint.generative_inputs WHERE namespace_id=$1 AND deployment_id=$2 AND handle=$3", [this.namespaceId, this.deploymentId, r.handle])).rows[0];
    const assessment = (await tx.query<{ payload: Buffer }>(`SELECT s.payload FROM open_mint.assessments s JOIN open_mint.assessment_attempts a USING(namespace_id,attempt_id)
      WHERE s.namespace_id=$1 AND s.assessment_id=$2 AND a.state='accepted'`, [this.namespaceId, r.assessmentId])).rows[0];
    if (!inputs?.payload.equals(json(artifact)) || !assessment
      || !json(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(assessment.payload))).equals(json(artifact.assessment))) fail("Accepted inputs changed; preserve the reservation.");
    const plans = (await tx.query<{ request_id: string; authorization_id: string; nonce_active: boolean; wallet_nonce: string }>(`SELECT request_id,authorization_id,recipient,wallet_nonce::text,payload,nonce_active
      FROM open_mint.wallet_mint_plans WHERE namespace_id=$1 AND (authorization_id=$2 OR request_id=$3) ORDER BY request_id`, [this.namespaceId, r.id, r.requestId])).rows;
    if (plans.length > 1 || plans.some(p => p.request_id !== r.requestId || p.authorization_id !== r.id || !p.nonce_active)) fail("Wallet plan does not match the reservation.");
    const signatures = (await tx.query("SELECT signature FROM open_mint.generative_authorization_signatures WHERE namespace_id=$1 AND authorization_id=$2", [this.namespaceId, r.id])).rows;
    const dispatches = (await tx.query<{ outcome: "rejected" | "submitted" | null; transaction_hash: string | null }>(`SELECT d.attempt,d.permit_hash,d.owner_epoch::text,r.outcome,r.transaction_hash
      FROM open_mint.wallet_mint_dispatches d LEFT JOIN open_mint.wallet_mint_reports r USING(namespace_id,request_id,attempt)
      WHERE d.namespace_id=$1 AND d.request_id=$2 ORDER BY d.attempt`, [this.namespaceId, r.requestId])).rows;
    const last = dispatches.at(-1);
    return { fingerprint: hash({ authorization, inputs, assessment, plans, signatures, dispatches }), planCount: plans.length,
      walletNonce: plans[0]?.wallet_nonce ?? null, submission: last ? last.outcome ?? "unknown" as const : "not-started" as const,
      transactionHash: last?.transaction_hash ?? null };
  }
  async #evidence(tx: Tx, r: AuthorizationReservation, witness: GenerativeRecoveryWitness) {
    const policy = await this.#disabled(tx), p = this.issuer.requests.profile;
    const now = (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
    const e = readGenerativeRecoveryEvidence(witness, r, now), c = e.config;
    if (c.genesisHash !== p.genesis_hash || c.runtimeCodeHash !== p.runtime_code_hash
      || c.deploymentBlock.number.toString() !== p.deployment_block || c.deploymentBlock.hash !== p.deployment_block_hash
      || getAddress(c.generativeRenderer!.address) !== getAddress(this.issuer.journal.rendererPin.address)
      || c.generativeRenderer!.runtimeCodeHash !== this.issuer.journal.rendererPin.runtimeCodeHash) fail("Recovery chain does not match the durable deployment.");
    for (const bounds of [policy, p]) {
      if (now - e.observedAt >= bounds.max_evidence_age_ms) fail("Recovery evidence expired; obtain a new observation.");
      for (const block of [e.finalized, e.latest]) if (now - Number(block.timestamp) * 1000 >= bounds.max_block_age_ms
        || Number(block.timestamp) * 1000 - now > bounds.max_future_skew_ms) fail("Recovery block exceeds the durable freshness policy.");
    }
    return e;
  }
  async plan(authorizationId: string, reason: string, signal: AbortSignal): Promise<GenerativeRecoveryPlan> {
    if (!uuid(authorizationId) || typeof reason !== "string" || reason.trim().length < 3 || reason.length > 300 || /[\x00-\x1f\x7f]/.test(reason)) fail("An exact authorization ID and short operator reason are required.");
    const operatorReason = reason.trim(), reservation = await this.issuer.inspect(authorizationId);
    const artifact = await this.issuer.journal.load(reservation.handle);
    if (!artifact || artifact.assessment.id !== reservation.assessmentId || artifact.digest !== reservation.authorization.inputDigest
      || artifact.assessment.digest !== reservation.authorization.assessmentDigest || artifact.renderHandle !== reservation.renderHandle
      || artifact.mbti !== reservation.mbti || artifact.rendererIdentity !== reservation.rendererIdentity) fail("Frozen inputs do not match the reservation.");
    const before = await this.writer.transaction(tx => this.#snapshot(tx, reservation, artifact));
    const witness = await this.chain.observe(reservation, signal);
    return this.writer.transaction(async tx => {
      const current = await this.#snapshot(tx, reservation, artifact), evidence = await this.#evidence(tx, reservation, witness);
      if (current.fingerprint !== before.fingerprint) fail("Submission changed during review. Inspect it again.");
      const plan: GenerativeRecoveryPlan = Object.freeze({ recoveryId: randomUUID(), authorizationId, handle: reservation.handle,
        deadline: reservation.authorization.deadline, finalizedBlock: evidence.finalized.number, snapshotHash: current.fingerprint,
        reason: operatorReason, action: "retire-expired-unminted", recipient: reservation.authorization.recipient,
        walletNonce: current.walletNonce, submission: current.submission, transactionHash: current.transactionHash });
      this.#plans.set(plan, { plan, reservation, artifact, witness, epoch: this.writer.epoch });
      return plan;
    });
  }
  /** For a lost COMMIT response/restart: read the known recovery ID before any
   * further action. A report is audit data, never a reusable chain witness. */
  async outcome(recoveryId: string) {
    if (!uuid(recoveryId)) fail("Invalid recovery ID.");
    return this.writer.transaction(tx => this.#outcome(tx, recoveryId));
  }
  async #outcome(tx: Tx, recoveryId: string): Promise<GenerativeRecoveryPlan | undefined> {
    const row = (await tx.query<{ evidence: Buffer; authorization_id: string; snapshot_hash: string; head_active: boolean; nonce_active: boolean }>(`SELECT e.evidence,e.authorization_id,e.snapshot_hash,
      EXISTS(SELECT 1 FROM open_mint.generative_authorization_heads h WHERE h.namespace_id=e.namespace_id AND h.authorization_id=e.authorization_id) AS head_active,
      EXISTS(SELECT 1 FROM open_mint.wallet_mint_plans p WHERE p.namespace_id=e.namespace_id AND p.authorization_id=e.authorization_id AND p.nonce_active) AS nonce_active
      FROM open_mint.generative_recoveries e WHERE namespace_id=$1 AND deployment_id=$2 AND recovery_id=$3`, [this.namespaceId, this.deploymentId, recoveryId])).rows[0];
    if (!row) return undefined;
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.evidence)), plan = data.plan as GenerativeRecoveryPlan;
    if (!json(data).equals(row.evidence) || data.version !== "generative-expired-unminted-v1" || !plan || plan.recoveryId !== recoveryId
      || plan.authorizationId !== row.authorization_id || plan.snapshotHash !== row.snapshot_hash || plan.action !== "retire-expired-unminted"
      || row.head_active || row.nonce_active) fail("Recovery record is incomplete or inconsistent. Keep issuance disabled for review.");
    return plan;
  }
  async apply(value: GenerativeRecoveryPlan): Promise<GenerativeRecoveryPlan> {
    const captured = value && typeof value === "object" ? this.#plans.get(value) : undefined;
    if (!captured || captured.epoch !== this.writer.epoch) fail("Review a fresh recovery plan in this operator process first.");
    const { reservation: r, artifact, witness, plan } = captured;
    return this.writer.transaction(async tx => {
      const previous = await this.#outcome(tx, plan.recoveryId);
      if (previous) {
        if (!json(previous).equals(json(plan))) fail("Conflicting recovery record.");
        return previous;
      }
      const current = await this.#snapshot(tx, r, artifact);
      if (current.fingerprint !== plan.snapshotHash) fail("Submission changed since review. No retirement was performed.");
      const e = await this.#evidence(tx, r, witness);
      // No secret capability, signature, calldata, raw RPC URL or paid-provider
      // payload is copied into the operator audit record.
      const evidence = json({ plan, version: e.version, authorizationDigest: e.authorizationDigest,
        finalized: e.finalized, latest: e.latest, sources: e.sources, observedAt: e.observedAt, validUntil: e.validUntil });
      await tx.query(`INSERT INTO open_mint.generative_recoveries(namespace_id,recovery_id,deployment_id,authorization_id,request_id,snapshot_hash,
        finalized_number,finalized_hash,finalized_timestamp,evidence,owner_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [this.namespaceId, plan.recoveryId, this.deploymentId, r.id, r.requestId, plan.snapshotHash, e.finalized.number, e.finalized.hash, e.finalized.timestamp, evidence, this.writer.epoch]);
      const plans = await tx.query("UPDATE open_mint.wallet_mint_plans SET nonce_active=false WHERE namespace_id=$1 AND authorization_id=$2 AND nonce_active RETURNING request_id", [this.namespaceId, r.id]);
      const heads = await tx.query("DELETE FROM open_mint.generative_authorization_heads WHERE namespace_id=$1 AND deployment_id=$2 AND authorization_id=$3 RETURNING handle", [this.namespaceId, this.deploymentId, r.id]);
      if (plans.rows.length !== current.planCount || heads.rows.length !== 1) fail("Retirement conflict; all changes rolled back.");
      await this.#evidence(tx, r, witness);
      return plan;
    });
  }
}
