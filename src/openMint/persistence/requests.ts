import { randomUUID, timingSafeEqual } from "node:crypto";
import { getAddress, type Address } from "viem";
import { validateAssessment } from "../assessment.js";
import { canonicalHandle, preservedHandle } from "../identity.js";
import { readPublicChainEligibility, type PublicChainEvidence } from "../publicChain.js";
import { isCode, opaqueCode, PublicError } from "../security.js";
import { OpenMintRepository, validateAssessmentTerminal, type AssessmentTerminal } from "./repository.js";
import { capabilityHash } from "./sessions.js";
import { PersistenceConflictError, type OwnershipConnection } from "./writer.js";
import { PostgresPulseEconomics } from "./pulseEconomics.js";

type Transaction = Pick<OwnershipConnection, "query">;
export interface CreateDurableMintRequest {
  readonly sessionToken: string;
  readonly origin: string | undefined;
  readonly csrf: string | undefined;
  /** Capture both before obtaining trusted chain preflight outside the tx. */
  readonly sessionGeneration: string;
  readonly recipient: Address;
  readonly handle: string;
  /** Ephemeral opaque witness, issued by the configured backend chain gate. */
  readonly eligibility: unknown;
  readonly mintIntent?: unknown;
}
export interface DurableMintRequest {
  readonly id: string;
  /** New on creation; supplied by the browser for an existing request read. */
  readonly code: string;
  readonly handle: string;
  readonly requestedHandle: string;
  readonly wallet: Address;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Accepted assessment does not mean rendered/published/ready to mint. */
  readonly status: "pending-assessment" | "assessment-accepted" | "assessment-abstained" | "assessment-invalid" | "assessment-uncertain" | "assessment-blocked";
  readonly terminal?: AssessmentTerminal;
  readonly attemptId?: string;
  readonly assessmentId?: string;
}
interface RequestProfile {
  deployment_id: string; chain_id: string; contract_address: string; genesis_hash: string; runtime_code_hash: string;
  authorizer: string; deployment_block: string; deployment_block_hash: string; origin: string; session_chain_id: string;
  max_evidence_age_ms: number; max_block_age_ms: number; max_future_skew_ms: number;
}
interface SessionRow {
  session_hash: string; generation: string; csrf: string; expires_at: Date; revoked: boolean; wallet: string | null;
  proof_wallet: string | null; proof_code_hash: string | null; proof_expires_at: Date | null; active_challenge_hash: string | null;
}
interface RequestRow {
  request_id: string; code_hash: string; handle: string; requested_handle: string; wallet: string; created_at: Date; expires_at: Date;
  attempt_id: string | null; assessment_id: string | null; current_assessment_id: string | null; assessment_payload: Buffer | null; assessment_digest: string | null;
  terminal_kind: string | null; terminal_reason: string | null; terminal_phase: string | null;
}
function uint(value: string | bigint): string {
  const integer = BigInt(value);
  if (integer < 0n || integer >= 2n ** 256n) throw new PersistenceConflictError("Invalid persisted chain quantity.");
  return integer.toString();
}
const sessionRequired = () => new PublicError(403, "SESSION_REQUIRED", "Refresh this page and try again.");
const notFound = () => new PublicError(404, "NOT_FOUND", "Signature request not found.");

/** Durable private requests. Creation, wallet/CSRF checks and initial assessment
 * admission share one owner transaction. This does not run jobs or sign mint
 * authority; adapters must never expose the lower-level admitInitial method.
 */
export class PostgresMintRequests {
  private constructor(readonly repository: OpenMintRepository, readonly profile: Readonly<RequestProfile>, readonly pulse?: PostgresPulseEconomics) {}
  static async open(repository: OpenMintRepository, deploymentId: string, pulse?: PostgresPulseEconomics): Promise<PostgresMintRequests> {
    if (pulse && (!(pulse instanceof PostgresPulseEconomics) || pulse.writer !== repository.writer || pulse.namespaceId !== repository.namespace.id
      || pulse.deploymentId !== deploymentId || repository.namespace.profile !== "local-real")) throw new PersistenceConflictError("Pulse request composition mismatch.");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(deploymentId)) throw new PersistenceConflictError("Invalid request deployment identifier.");
    const profile = await repository.writer.transaction(async tx => {
      const row = (await tx.query<RequestProfile>(`SELECT p.*, p.chain_id::text, p.deployment_block::text, s.origin, s.chain_id::text AS session_chain_id
        FROM open_mint.request_profiles p JOIN open_mint.session_profiles s USING(namespace_id)
        WHERE p.namespace_id = $1 AND p.deployment_id = $2`, [repository.namespace.id, deploymentId])).rows[0];
      if (!row || row.chain_id !== row.session_chain_id) throw new PersistenceConflictError("Request deployment/session profile mismatch.");
      return Object.freeze({ ...row });
    });
    return new PostgresMintRequests(repository, profile, pulse);
  }
  async #now(tx: Transaction): Promise<Date> { return (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now; }
  async #session(tx: Transaction, sessionHash: string, now: Date): Promise<SessionRow> {
    const row = (await tx.query<SessionRow>("SELECT *, generation::text FROM open_mint.sessions WHERE namespace_id = $1 AND session_hash = $2 FOR UPDATE", [this.repository.namespace.id, sessionHash])).rows[0];
    if (!row || row.revoked || row.expires_at.getTime() <= now.getTime()) throw sessionRequired();
    return row;
  }
  #preflight(witness: unknown, handle: string, recipient: Address, now: number): PublicChainEvidence {
    let evidence: PublicChainEvidence;
    try { evidence = readPublicChainEligibility(witness, { namespaceId: this.repository.namespace.id, deploymentId: this.profile.deployment_id, handle, recipient, now }); }
    catch { throw new PublicError(503, "CHAIN_UNAVAILABLE", "Fresh verified chain eligibility is required. No assessment was requested."); }
    const expected = this.profile;
    if ((evidence.contractProfile === "generative-pulse-v1-rc1") !== !!this.pulse) throw new PublicError(503, "CHAIN_PROFILE_MISMATCH", "Explicit Pulse request composition required.");
    if (uint(evidence.chainId) !== expected.chain_id || evidence.contract.toLowerCase() !== expected.contract_address
      || evidence.genesisHash !== expected.genesis_hash || evidence.runtimeCodeHash !== expected.runtime_code_hash
      || evidence.authorizer.toLowerCase() !== expected.authorizer || uint(evidence.deploymentBlock.number) !== expected.deployment_block
      || evidence.deploymentBlock.hash !== expected.deployment_block_hash) throw new PublicError(503, "CHAIN_PROFILE_MISMATCH", "The chain observation does not match this request deployment.");
    const blockTime = Number(evidence.block.timestamp) * 1000;
    if (now - evidence.observedAt >= expected.max_evidence_age_ms || now - blockTime >= expected.max_block_age_ms
      || blockTime - now > expected.max_future_skew_ms) throw new PublicError(503, "CHAIN_UNAVAILABLE", "The chain observation exceeds this deployment's freshness policy.");
    return evidence;
  }

  async create(input: CreateDurableMintRequest): Promise<DurableMintRequest> {
    return this.#create(input);
  }

  /** Internal staging composition. Database-only review/catalog validation
   * surrounds admission in its owner transaction; never a browser callback. */
  async createGuardedStaging(input: CreateDurableMintRequest, guard: (tx: Transaction, generation: boolean) => Promise<void>): Promise<DurableMintRequest> {
    if (typeof guard !== "function" || this.repository.namespace.profile !== "staging-testnet" || this.repository.namespace.provenance !== "grok"
      || this.profile.chain_id !== "11155111" || this.profile.session_chain_id !== "11155111" || this.profile.origin !== "https://staging.signatures.gallery") {
      throw new PersistenceConflictError("Guarded staging request binding required.");
    }
    return this.#create(input, guard);
  }

  async #create(input: CreateDurableMintRequest, guard?: (tx: Transaction, generation: boolean) => Promise<void>): Promise<DurableMintRequest> {
    // Capture every caller-owned value before entering the asynchronous queue.
    const sessionHash = capabilityHash(input.sessionToken), origin = input.origin, csrf = input.csrf,
      generation = input.sessionGeneration, recipient = getAddress(input.recipient), handle = canonicalHandle(input.handle),
      requestedHandle = preservedHandle(input.handle), witness = input.eligibility, mintIntent = input.mintIntent === undefined ? undefined : structuredClone(input.mintIntent);
    if (!this.pulse && mintIntent !== undefined) throw new PublicError(400, "INVALID_INPUT", "Mint economics are not supported by this deployment.");
    if (!/^(?:0|[1-9][0-9]{0,18})$/.test(generation)) throw new PublicError(409, "WALLET_CHANGED", "Connect your wallet again before preparing a mint.");
    return this.repository.admissionTransaction(async (tx, admit) => {
      await guard?.(tx, false);
      const now = await this.#now(tx), session = await this.#session(tx, sessionHash, now);
      if (origin !== this.profile.origin || !isCode(csrf) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))) throw sessionRequired();
      if (session.generation !== generation || session.wallet !== recipient) throw new PublicError(409, "WALLET_CHANGED", "Your wallet changed. Connect it again before preparing a mint.");
      if (session.proof_wallet !== recipient || !session.proof_expires_at || session.proof_expires_at.getTime() <= now.getTime()
        || session.proof_code_hash !== null || session.active_challenge_hash !== null) throw new PublicError(403, "WALLET_PROOF_REQUIRED", "Connect your wallet again before preparing a mint.");
      const evidence = this.#preflight(witness, handle, recipient, now.getTime());
      const count = (await tx.query<{ count: string }>("SELECT count(*)::text AS count FROM open_mint.requests WHERE namespace_id = $1 AND session_hash = $2 AND expires_at > $3", [this.repository.namespace.id, sessionHash, now])).rows[0];
      if (!count || BigInt(count.count) >= 10n) throw new PublicError(429, "REQUEST_LIMIT", "Please finish an existing request first.");
      const code = opaqueCode(), id = randomUUID(), expires = new Date(now.getTime() + 900_000);
      await this.pulse?.reserve(tx, { requestId: id, wallet: recipient, handle, generation, sessionHash, consent: mintIntent, evidence, now: now.getTime() });
      const admission = await admit(handle);
      if (admission.kind === "accepted" && this.repository.namespace.provenance === "grok" && admission.assessment.xIdentity?.provenance !== "x-api") throw new PersistenceConflictError("Saved assessment lacks verified X identity.");
      await tx.query(`INSERT INTO open_mint.requests(namespace_id, request_id, code_hash, deployment_id, session_hash, session_generation,
        wallet, handle, requested_handle, created_at, expires_at, attempt_id, assessment_id, owner_epoch,
        preflight_observed_at, preflight_valid_until, preflight_block_number, preflight_block_hash, preflight_nonce)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [this.repository.namespace.id, id, capabilityHash(code), this.profile.deployment_id, sessionHash, generation, recipient, handle, requestedHandle,
        now, expires, admission.kind === "accepted" ? null : admission.attemptId, admission.kind === "accepted" ? admission.assessment.id : null,
        this.repository.writer.epoch, new Date(evidence.observedAt), new Date(evidence.validUntil), uint(evidence.block.number), evidence.block.hash, uint(evidence.nonce)]);
      const terminalRow = admission.kind !== "accepted" ? (await tx.query<{ kind: string; reason: string | null; phase: string }>(
        "SELECT kind, reason, phase FROM open_mint.assessment_terminals WHERE namespace_id=$1 AND attempt_id=$2", [this.repository.namespace.id, admission.attemptId])).rows[0] : undefined;
      const terminal = terminalRow ? validateAssessmentTerminal(terminalRow) : undefined;
      const status: DurableMintRequest["status"] = terminal ? terminal.kind === "blocked-before-dispatch" ? "assessment-blocked" : `assessment-${terminal.kind}`
        : admission.kind === "accepted" ? "assessment-accepted" : "pending-assessment";
      // Include the terminal-status read in the final freshness boundary too.
      const end = await this.#now(tx);
      if (session.expires_at.getTime() <= end.getTime() || session.proof_expires_at.getTime() <= end.getTime()) throw sessionRequired();
      this.#preflight(witness, handle, recipient, end.getTime());
      await this.pulse?.check(tx, id, evidence, end.getTime());
      await guard?.(tx, admission.kind !== "accepted");
      if (guard) {
        const final = await this.#now(tx);
        if (session.expires_at.getTime() <= final.getTime() || session.proof_expires_at.getTime() <= final.getTime()) throw sessionRequired();
        this.#preflight(witness, handle, recipient, final.getTime());
      }
      return { id, code, handle, requestedHandle, wallet: recipient, createdAt: now.getTime(), expiresAt: expires.getTime(),
        status, ...(terminal ? { terminal } : {}),
        ...(admission.kind === "accepted" ? { assessmentId: admission.assessment.id } : { attemptId: admission.attemptId }) };
    });
  }

  /** Expired requests remain privately readable, as in the local recovery UI.
   * Expiry is never extended and a read never creates work or mint authority. */
  async get(code: string, sessionToken: string): Promise<DurableMintRequest> {
    if (!isCode(code)) throw notFound();
    const sessionHash = capabilityHash(sessionToken), codeHash = capabilityHash(code);
    return this.repository.writer.transaction(async tx => {
      const now = await this.#now(tx), session = await this.#session(tx, sessionHash, now);
      const row = (await tx.query<RequestRow>(`SELECT r.*, a.assessment_id AS current_assessment_id, a.payload AS assessment_payload, a.digest AS assessment_digest,
        t.kind AS terminal_kind, t.reason AS terminal_reason, t.phase AS terminal_phase
        FROM open_mint.requests r LEFT JOIN open_mint.assessments a ON a.namespace_id = r.namespace_id AND a.handle = r.handle
        LEFT JOIN open_mint.assessment_terminals t ON t.namespace_id = r.namespace_id AND t.attempt_id = r.attempt_id
        WHERE r.namespace_id = $1 AND r.deployment_id = $2 AND r.code_hash = $3 AND r.session_hash = $4`, [this.repository.namespace.id, this.profile.deployment_id, codeHash, sessionHash])).rows[0];
      if (!row) throw notFound();
      if (session.wallet !== row.wallet) throw new PublicError(403, "REQUEST_WALLET_MISMATCH", "Connect the wallet that started this mint.");
      if (row.code_hash !== codeHash || canonicalHandle(row.handle) !== row.handle || preservedHandle(row.requested_handle) !== row.requested_handle
        || canonicalHandle(row.requested_handle) !== row.handle || row.expires_at.getTime() !== row.created_at.getTime() + 900_000) throw new PersistenceConflictError("Stored request failed its integrity check.");
      if (row.current_assessment_id !== null) {
        if (!row.assessment_payload) throw new PersistenceConflictError("Stored request assessment is missing.");
        const value = validateAssessment(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.assessment_payload)));
        if (value.id !== row.current_assessment_id || value.digest !== row.assessment_digest || value.handle !== row.handle
          || value.provenance !== this.repository.namespace.provenance || value.policyVersion !== this.repository.namespace.policyVersion
          || (row.assessment_id !== null && row.assessment_id !== value.id)) throw new PersistenceConflictError("Stored request assessment does not match its namespace.");
        if (this.repository.namespace.provenance === "grok" && value.xIdentity?.provenance !== "x-api") throw new PersistenceConflictError("Saved assessment lacks verified X identity.");
      } else if (row.assessment_id !== null) throw new PersistenceConflictError("Stored accepted request lost its assessment.");
      const terminal = row.terminal_kind != null ? validateAssessmentTerminal({ kind: row.terminal_kind, reason: row.terminal_reason, phase: row.terminal_phase! }) : undefined;
      if (terminal && row.current_assessment_id !== null) throw new PersistenceConflictError("Request has conflicting accepted and terminal outcomes.");
      const status: DurableMintRequest["status"] = terminal ? terminal.kind === "blocked-before-dispatch" ? "assessment-blocked" : `assessment-${terminal.kind}`
        : row.current_assessment_id ? "assessment-accepted" : "pending-assessment";
      return { id: row.request_id, code, handle: row.handle, requestedHandle: row.requested_handle, wallet: getAddress(row.wallet),
        createdAt: row.created_at.getTime(), expiresAt: row.expires_at.getTime(), status, ...(terminal ? { terminal } : {}),
        ...(row.attempt_id ? { attemptId: row.attempt_id } : {}), ...(row.current_assessment_id ? { assessmentId: row.current_assessment_id } : {}) };
    });
  }
}
