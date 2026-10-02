import { profileForReservation, type GenerativeReservationVersion } from "../generativeProfiles.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import canonicalize from "canonicalize";
import { getAddress, hashTypedData, type Address, type Hex, type TypedDataDefinition } from "viem";
import { generativeInputDigest } from "../generativeInputs.js";
import type { MBTI } from "../identity.js";
import { validateAssessment } from "../assessment.js";
import { openMintHandleKey } from "../authorization.js";
import { generativeMintTypedData, stagingGenerativeMintTypedData, normalizeGenerativeAuthorization, type GenerativeAuthorizationInput } from "../generativeAuthorization.js";
import { requireCanonicalSignatureFrom } from "../../v2/core/ethereumSignature.js";
import type { GenerativeInputProfile } from "../generativeProfiles.js";
import type { OpenMintDomainInput } from "../authorization.js";
import { readPublicChainEligibility, type PublicChainEvidence } from "../publicChain.js";
import { isCode } from "../security.js";
import { PostgresGenerativeInputJournal, type PreparedGenerativeInputs, type GenerativeTransactionGuard } from "./generativeInputs.js";
import { PostgresMintRequests } from "./requests.js";
import { capabilityHash } from "./sessions.js";
import { PersistenceConflictError, type OwnershipConnection } from "./writer.js";
import { admissionDigest } from "../staging/admission.js";
import type { LocalMintOperation } from "./mintAdmission.js";
import { normalizePulseAuthorization, pulseMintTypedData, type PulseAuthorizationInput } from "../pulseAuthorization.js";
import type { SavedPulseIntent } from "./pulseEconomics.js";

type Transaction = Pick<OwnershipConnection, "query">;
export interface IssuanceIntent {
  readonly code: string; readonly sessionToken: string; readonly sessionGeneration: string;
  readonly origin: string | undefined; readonly csrf: string | undefined; readonly consent: boolean;
  /** Server-owned gate witness. The browser cannot select authorization fields. */
  readonly eligibility: unknown;
}
export interface ReservedAuthorizationSigner {
  readonly address: Address;
  signTypedData(input: TypedDataDefinition, signal: AbortSignal): Promise<string>;
}
interface AuthorizationFields extends Omit<GenerativeAuthorizationInput, "issuedAt" | "deadline"> { issuedAt: string; deadline: string; mintMode?: 0 | 1; slotId?: string; maxPrice?: string }
export interface AuthorizationReservation {
  readonly version: GenerativeReservationVersion; readonly id: string; readonly namespaceId: string; readonly deploymentId: string;
  readonly requestId: string; readonly sessionHash: string; readonly generation: string; readonly handle: string; readonly assessmentId: string;
  readonly renderHandle: string; readonly mbti: string; readonly rendererIdentity: Hex; readonly authorizer: Address;
  readonly domain: { readonly chainId: string; readonly verifyingContract: Address };
  readonly authorization: AuthorizationFields; readonly digest: Hex; readonly typedData: unknown;
  readonly proof?: readonly Hex[];
}
interface Policy {
  enabled: boolean; lifetime_seconds: number; signer_timeout_ms: number;
  max_evidence_age_ms: number; max_block_age_ms: number; max_future_skew_ms: number;
}
interface Session {
  generation: string; wallet: string | null; csrf: string; revoked: boolean; expires_at: Date;
  proof_wallet: string | null; proof_code_hash: string | null; proof_expires_at: Date | null; active_challenge_hash: string | null;
}
interface Request { request_id: string; handle: string; wallet: string; expires_at: Date; assessment_id: string | null }
interface Stored {
  authorization_id: string; deployment_id: string; handle: string; request_id: string; session_hash: string; session_generation: string;
  recipient: string; assessment_id: string; input_digest: string; nonce: string; authorization_digest: string; issued_at: string; deadline: string;
  payload: Buffer; state: "reserved" | "signing" | "unknown" | "signed"; signing_epoch: string | null;
}
interface CapturedIntent extends IssuanceIntent { sessionHash: string; codeHash: string }
const json = (value: unknown): Buffer => Buffer.from(canonicalize(value)!);
const plainTypedData = (value: ReturnType<typeof generativeMintTypedData> | ReturnType<typeof pulseMintTypedData>): unknown => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
const reservedTypedData = (domain: OpenMintDomainInput, authorization: GenerativeAuthorizationInput, profile: GenerativeInputProfile) =>
  profile === "sg-generative-pulse-inputs-v1-rc1" ? pulseMintTypedData(domain, authorization as PulseAuthorizationInput)
    : String(domain.chainId) === "11155111" ? stagingGenerativeMintTypedData(domain, authorization, profile) : generativeMintTypedData(domain, authorization, profile);
const reservedDigest = (domain: OpenMintDomainInput, authorization: GenerativeAuthorizationInput, profile: GenerativeInputProfile) => {
  const data = reservedTypedData(domain, authorization, profile);
  return data.primaryType === "PulseMintAuthorization" ? hashTypedData(data) : hashTypedData(data);
};
export function normalizeReservedAuthorization(version: GenerativeReservationVersion, a: GenerativeAuthorizationInput) {
  return version === "sg-generative-pulse-authorization-v1-rc1" ? normalizePulseAuthorization(a as PulseAuthorizationInput) : normalizeGenerativeAuthorization(a);
}
export class IssuanceBlockedError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "IssuanceBlockedError"; }
}
function blocked(code: string, message: string): never { throw new IssuanceBlockedError(code, message); }
function capture(input: IssuanceIntent): CapturedIntent {
  if (input.consent !== true) blocked("CONSENT_REQUIRED", "Explicit mint intent is required.");
  if (!/^(0|[1-9][0-9]{0,18})$/.test(input.sessionGeneration)) blocked("WALLET_CHANGED", "Current wallet generation is required.");
  return { code: input.code, sessionToken: input.sessionToken, sessionGeneration: input.sessionGeneration, origin: input.origin, csrf: input.csrf,
    consent: true, eligibility: input.eligibility, sessionHash: capabilityHash(input.sessionToken), codeHash: capabilityHash(input.code) };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const member of Object.values(value)) deepFreeze(member); Object.freeze(value); }
  return value;
}
function exactKeys(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new PersistenceConflictError("Stored authorization fields are invalid.");
}
/** Real canonical ECDSA verification, separately exercised with public literals.
 * No injected verification bypass exists in production. */
export async function verifyReservedSignature(value: Pick<AuthorizationReservation, "domain" | "authorization" | "authorizer" | "version">, signature: string): Promise<boolean> {
  try { await requireCanonicalSignatureFrom(reservedDigest(value.domain, value.authorization, profileForReservation(value.version).inputProfile), signature, value.authorizer); return true; }
  catch { return false; }
}

/** Local-only foundation. Public issuance remains unavailable, including when
 * a future staging/production profile accidentally sets enabled=true. */
export class PostgresGenerativeAuthorizationIssuer {
  private constructor(readonly requests: PostgresMintRequests, readonly journal: PostgresGenerativeInputJournal,
    private readonly guard?: GenerativeTransactionGuard) {}
  get writer() { return this.requests.repository.writer; }
  static async open(requests: PostgresMintRequests, journal: PostgresGenerativeInputJournal): Promise<PostgresGenerativeAuthorizationIssuer> {
    if ((journal.profile.contractProfile === "generative-pulse-v1-rc1") !== !!requests.pulse) blocked("ISSUANCE_DISABLED", "Explicit Pulse economics composition required.");
    if (requests.repository.writer !== journal.writer || requests.repository.namespace.id !== journal.namespaceId || requests.profile.deployment_id !== journal.deploymentId || requests.repository.namespace.profile !== "local-real"
      || requests.repository.namespace.provenance !== "grok" || requests.profile.chain_id !== "31337") blocked("ISSUANCE_DISABLED", "Only the isolated local issuance foundation is implemented.");
    const issuer = new PostgresGenerativeAuthorizationIssuer(requests, journal);
    await issuer.writer.transaction(tx => issuer.#policy(tx, false));
    return issuer;
  }
  /** Internal entrypoint for the release-aware staging controller only. Direct
   * issue is disabled; signing must use its acknowledged admission fence. */
  static async openGuardedStaging(requests: PostgresMintRequests, journal: PostgresGenerativeInputJournal, guard: GenerativeTransactionGuard) {
    if (typeof guard !== "function" || requests.repository.writer !== journal.writer || requests.repository.namespace.id !== journal.namespaceId
      || requests.profile.deployment_id !== journal.deploymentId || requests.repository.namespace.profile !== "staging-testnet"
      || requests.repository.namespace.provenance !== "grok" || requests.profile.chain_id !== "11155111"
      || requests.profile.session_chain_id !== "11155111" || requests.profile.origin !== "https://staging.signatures.gallery"
      || journal.profile.contractProfile !== "generative-v1-rc1") blocked("ISSUANCE_DISABLED", "Staging issuance guards required.");
    const issuer = new PostgresGenerativeAuthorizationIssuer(requests, journal, guard);
    await issuer.writer.transaction(tx => issuer.#policy(tx, false)); return issuer;
  }
  async #policy(tx: Transaction, requireEnabled = true): Promise<Policy> {
    await this.guard?.(tx);
    const row = (await tx.query<Policy>("SELECT enabled,lifetime_seconds,signer_timeout_ms,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms FROM open_mint.generative_issuance_profiles WHERE namespace_id=$1 AND deployment_id=$2", [this.requests.repository.namespace.id, this.requests.profile.deployment_id])).rows[0];
    if (!row || (requireEnabled && !row.enabled)) blocked("ISSUANCE_DISABLED", "Authorization issuance is disabled.");
    return row;
  }
  async #now(tx: Transaction): Promise<number> { return (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime(); }
  async #context(tx: Transaction, input: CapturedIntent): Promise<{ request: Request; session: Session; now: number; policy: Policy; pulseIntent?: SavedPulseIntent }> {
    const namespace = this.requests.repository.namespace.id, now = await this.#now(tx), policy = await this.#policy(tx);
    const session = (await tx.query<Session>("SELECT *,generation::text FROM open_mint.sessions WHERE namespace_id=$1 AND session_hash=$2 FOR UPDATE", [namespace, input.sessionHash])).rows[0];
    if (!session || session.revoked || session.expires_at.getTime() <= now || input.origin !== this.requests.profile.origin
      || !isCode(input.csrf) || !timingSafeEqual(Buffer.from(input.csrf), Buffer.from(session.csrf))) blocked("SESSION_REQUIRED", "A current session and request origin are required.");
    const request = (await tx.query<Request>("SELECT request_id,handle,wallet,expires_at,assessment_id FROM open_mint.requests WHERE namespace_id=$1 AND deployment_id=$2 AND code_hash=$3 AND session_hash=$4", [namespace, this.requests.profile.deployment_id, input.codeHash, input.sessionHash])).rows[0];
    if (!request) blocked("NOT_FOUND", "Signature request not found.");
    const retired = (await tx.query(`SELECT 1 FROM open_mint.generative_authorizations a
      LEFT JOIN open_mint.generative_authorization_heads h USING(namespace_id,deployment_id,handle,authorization_id)
      WHERE a.namespace_id=$1 AND a.request_id=$2 AND h.authorization_id IS NULL LIMIT 1`, [namespace, request.request_id])).rows.length;
    if (retired) blocked("REQUEST_RETIRED", "This request was retired by an operator. Start a new request; the accepted assessment is preserved.");
    if (request.expires_at.getTime() <= now) blocked("REQUEST_EXPIRED", "This request expired; its saved work and reservation are preserved.");
    if (session.generation !== input.sessionGeneration || session.wallet !== request.wallet) blocked("WALLET_CHANGED", "The current wallet or generation changed.");
    if (session.proof_wallet !== request.wallet || !session.proof_expires_at || session.proof_expires_at.getTime() <= now || session.active_challenge_hash
      || (session.proof_code_hash !== null && session.proof_code_hash !== input.codeHash)) blocked("WALLET_PROOF_REQUIRED", "A current general or matching request proof is required.");
    const pulseIntent = this.requests.pulse ? await this.requests.pulse.load(tx, request.request_id) : undefined;
    if (pulseIntent && input.eligibility !== undefined) {
      const evidence = this.#chain(input, request, policy, now);
      await this.requests.pulse!.check(tx, request.request_id, evidence, now);
      const saved = (await tx.query<{ payload: Buffer }>("SELECT payload FROM open_mint.generative_authorizations WHERE namespace_id=$1 AND request_id=$2", [namespace, request.request_id])).rows;
      for (const row of saved) {
        const r = JSON.parse(row.payload.toString("utf8")) as AuthorizationReservation;
        if (r.authorization.mintMode !== pulseIntent.mintMode || r.authorization.slotId !== pulseIntent.slotId || r.authorization.maxPrice !== pulseIntent.maxPrice
          || !json(r.proof).equals(json(pulseIntent.proof))) throw new PersistenceConflictError("Saved authorization economics changed.");
      }
    }
    return { request, session, now, policy, pulseIntent };
  }
  #chain(input: CapturedIntent, request: Request, policy: Policy, now: number, nonce?: string): PublicChainEvidence {
    let evidence: PublicChainEvidence;
    try { evidence = readPublicChainEligibility(input.eligibility, { namespaceId: this.requests.repository.namespace.id, deploymentId: this.requests.profile.deployment_id,
      handle: request.handle, recipient: request.wallet, nonce, now }); }
    catch { return blocked("CHAIN_UNAVAILABLE", "Fresh exact chain eligibility is required."); }
    const p = this.requests.profile;
    if (evidence.contractProfile !== this.journal.profile.contractProfile || evidence.generativeRenderer?.identity !== this.journal.rendererPin.identity
      || evidence.generativeRenderer?.address !== this.journal.rendererPin.address || evidence.generativeRenderer?.runtimeCodeHash !== this.journal.rendererPin.runtimeCodeHash) blocked("CHAIN_PROFILE_MISMATCH", "Generative issuance requires exact renderer and deployment pins.");
    if (evidence.chainId.toString() !== p.chain_id || evidence.contract.toLowerCase() !== p.contract_address || evidence.genesisHash !== p.genesis_hash
      || evidence.runtimeCodeHash !== p.runtime_code_hash || evidence.authorizer.toLowerCase() !== p.authorizer
      || evidence.deploymentBlock.number.toString() !== p.deployment_block || evidence.deploymentBlock.hash !== p.deployment_block_hash) blocked("CHAIN_PROFILE_MISMATCH", "The chain witness has different deployment pins.");
    const blockTime = Number(evidence.block.timestamp) * 1000;
    for (const bounds of [p, policy]) if (now - evidence.observedAt >= bounds.max_evidence_age_ms || now - blockTime >= bounds.max_block_age_ms
      || blockTime - now > bounds.max_future_skew_ms) blocked("CHAIN_UNAVAILABLE", "Chain evidence exceeds the durable freshness policy.");
    return evidence;
  }
  async #frozenInputs(tx: Transaction, artifact: PreparedGenerativeInputs, request: Pick<Request, "handle" | "assessment_id">): Promise<void> {
    const namespace = this.requests.repository.namespace;
    const saved = (await tx.query<{ payload: Buffer; digest: string; assessment_id: string; handle: string }>(`SELECT s.payload,s.digest,s.assessment_id,s.handle FROM open_mint.assessments s
      JOIN open_mint.assessment_attempts a USING(namespace_id,attempt_id) WHERE s.namespace_id=$1 AND s.handle=$2 AND a.state='accepted'`, [namespace.id, request.handle])).rows[0];
    if (!saved) blocked("NOT_READY", "The exact accepted assessment is required.");
    const accepted = validateAssessment(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(saved.payload)));
    if (accepted.id !== saved.assessment_id || accepted.digest !== saved.digest || accepted.handle !== saved.handle || accepted.handle !== request.handle
      || accepted.policyVersion !== namespace.policyVersion || accepted.provenance !== namespace.provenance || accepted.xIdentity?.provenance !== "x-api"
      || (request.assessment_id !== null && request.assessment_id !== accepted.id) || !json(accepted).equals(json(artifact.assessment))) throw new PersistenceConflictError("Accepted assessment binding changed.");
    const row = (await tx.query<{ payload: Buffer }>("SELECT payload FROM open_mint.generative_inputs WHERE namespace_id=$1 AND handle=$2 AND digest=$3 AND deployment_id=$4",
      [namespace.id, request.handle, artifact.digest, this.requests.profile.deployment_id])).rows[0];
    if (!row || !row.payload.equals(json(artifact))) blocked("NOT_READY", "Exact frozen generative inputs are required.");
  }

  #decode(row: Stored): AuthorizationReservation {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.payload)) as AuthorizationReservation;
    const pulse = this.journal.profile.contractProfile === "generative-pulse-v1-rc1";
    exactKeys(value, ["version", "id", "namespaceId", "deploymentId", "requestId", "sessionHash", "generation", "handle", "assessmentId", "renderHandle", "mbti", "rendererIdentity", "authorizer", "domain", "authorization", "digest", "typedData", ...(pulse ? ["proof"] : [])]);
    exactKeys(value.domain, ["chainId", "verifyingContract"]);
    exactKeys(value.authorization, ["handleKey", "assessmentDigest", "inputDigest", "recipient", "nonce", "issuedAt", "deadline", ...(pulse ? ["mintMode", "slotId", "maxPrice"] : [])]);
    const p = this.requests.profile, a = normalizeReservedAuthorization(this.journal.profile.reservationVersion, value.authorization);
    if (!json(value).equals(row.payload) || value.version !== this.journal.profile.reservationVersion || value.namespaceId !== this.requests.repository.namespace.id
      || value.id !== row.authorization_id || value.deploymentId !== row.deployment_id || value.deploymentId !== p.deployment_id
      || value.requestId !== row.request_id || value.sessionHash !== row.session_hash || value.generation !== row.session_generation
      || value.handle !== row.handle || value.assessmentId !== row.assessment_id || value.authorizer.toLowerCase() !== p.authorizer
      || value.domain.chainId !== p.chain_id || value.domain.verifyingContract.toLowerCase() !== p.contract_address
      || a.recipient !== getAddress(row.recipient) || a.inputDigest !== row.input_digest || a.nonce !== row.nonce
      || a.issuedAt.toString() !== row.issued_at || a.deadline.toString() !== row.deadline || a.handleKey !== openMintHandleKey(value.handle)
      || value.rendererIdentity !== this.journal.rendererPin.identity
      || a.inputDigest !== generativeInputDigest(value.renderHandle, value.mbti as MBTI, value.rendererIdentity, this.journal.profile.inputProfile) || value.digest !== row.authorization_digest
      || value.digest !== reservedDigest(value.domain, a, this.journal.profile.inputProfile) || !json(value.typedData).equals(json(plainTypedData(reservedTypedData(value.domain, a, this.journal.profile.inputProfile))))) throw new PersistenceConflictError("Stored authorization binding mismatch.");
    return deepFreeze(value);
  }
  /** Read-only operator inspection; never signs or releases a reservation. */
  async inspect(id: string): Promise<AuthorizationReservation> {
    return this.writer.transaction(async tx => {
      const row = (await tx.query<Stored>(`SELECT *,session_generation::text,issued_at::text,deadline::text,signing_epoch::text
        FROM open_mint.generative_authorizations WHERE namespace_id=$1 AND deployment_id=$2 AND authorization_id=$3`,
      [this.requests.repository.namespace.id, this.requests.profile.deployment_id, id])).rows[0];
      if (!row) throw new PersistenceConflictError("Authorization not found.");
      return this.#decode(row);
    });
  }
  async #head(tx: Transaction, handle: string): Promise<Stored | undefined> {
    return (await tx.query<Stored>(`SELECT a.*,a.session_generation::text,a.issued_at::text,a.deadline::text,a.signing_epoch::text
      FROM open_mint.generative_authorization_heads h JOIN open_mint.generative_authorizations a USING(namespace_id,deployment_id,handle,authorization_id)
      WHERE h.namespace_id=$1 AND h.deployment_id=$2 AND h.handle=$3 FOR UPDATE OF a`, [this.requests.repository.namespace.id, this.requests.profile.deployment_id, handle])).rows[0];
  }
  // Minted artwork/projection recovery uses the chain-only reader, not private reservations.
  #sameOwner(value: AuthorizationReservation, input: CapturedIntent, request: Request, artifact: PreparedGenerativeInputs): void {
    if (value.requestId !== request.request_id || value.sessionHash !== input.sessionHash || value.generation !== input.sessionGeneration
      || value.authorization.recipient !== getAddress(request.wallet) || value.assessmentId !== artifact.assessment.id
      || value.authorization.assessmentDigest !== artifact.assessment.digest || value.authorization.inputDigest !== artifact.digest
      || value.renderHandle !== artifact.renderHandle || value.mbti !== artifact.mbti || value.rendererIdentity !== artifact.rendererIdentity) blocked("MINT_RESERVED", "This handle has a preserved authorization reservation; expiry does not release it.");
  }
  async #prepare(input: CapturedIntent): Promise<PreparedGenerativeInputs> {
    const request = await this.requests.get(input.code, input.sessionToken), artifact = await this.journal.load(request.handle);
    if (!artifact) blocked("NOT_READY", "Frozen generative inputs are required before reservation.");
    return structuredClone(artifact);
  }
  async #reserve(input: CapturedIntent, artifact: PreparedGenerativeInputs): Promise<AuthorizationReservation> {
    return this.writer.transaction(async tx => {
      const { request, session, now, policy, pulseIntent } = await this.#context(tx, input);
      await tx.query("SELECT handle FROM open_mint.handle_guards WHERE namespace_id=$1 AND handle=$2 FOR UPDATE", [this.requests.repository.namespace.id, request.handle]);
      await this.#frozenInputs(tx, artifact, request);
      const existing = await this.#head(tx, request.handle);
      if (existing) {
        const value = this.#decode(existing); this.#sameOwner(value, input, request, artifact);
        this.#chain(input, request, policy, now, value.authorization.nonce);
        if (BigInt(value.authorization.deadline) * 1000n <= BigInt(now)) blocked("AUTHORIZATION_EXPIRED", "Expired authority remains reserved until explicit reconciliation.");
        if (existing.state === "signing" || existing.state === "unknown") blocked("SIGNING_UNCERTAIN", "The signing outcome requires review; no second signing attempt is started.");
        const end = await this.#context(tx, input); this.#chain(input, request, end.policy, end.now, value.authorization.nonce);
        return value;
      }
      const evidence = this.#chain(input, request, policy, now), wall = Math.floor(now / 1000), chain = Number(evidence.block.timestamp), issuedAt = Math.min(wall, chain);
      const deadline = Math.min(issuedAt + policy.lifetime_seconds, Math.floor(request.expires_at.getTime() / 1000),
        Math.floor(session.expires_at.getTime() / 1000), Math.floor(session.proof_expires_at!.getTime() / 1000),
        pulseIntent?.mintMode === 0 ? Number(this.requests.pulse!.binding.deployment.freeDeadline) : Infinity);
      if (deadline <= Math.max(wall, chain) + 15) blocked("REQUEST_EXPIRED", "Too little safe time remains for a mint authorization.");
      const domain = { chainId: this.requests.profile.chain_id, verifyingContract: getAddress(this.requests.profile.contract_address) };
      const authorization: AuthorizationFields = { handleKey: openMintHandleKey(request.handle), assessmentDigest: artifact.assessment.digest, inputDigest: artifact.digest,
        recipient: getAddress(request.wallet), nonce: evidence.nonce, issuedAt: String(issuedAt), deadline: String(deadline),
        ...(pulseIntent ? { mintMode: pulseIntent.mintMode, slotId: pulseIntent.slotId, maxPrice: pulseIntent.maxPrice } : {}) };
      const value: AuthorizationReservation = { version: this.journal.profile.reservationVersion, id: randomUUID(), namespaceId: this.requests.repository.namespace.id,
        deploymentId: this.requests.profile.deployment_id, requestId: request.request_id, sessionHash: input.sessionHash, generation: input.sessionGeneration,
        handle: request.handle, assessmentId: artifact.assessment.id, renderHandle: artifact.renderHandle, mbti: artifact.mbti, rendererIdentity: artifact.rendererIdentity, authorizer: getAddress(this.requests.profile.authorizer), domain,
        authorization, digest: reservedDigest(domain, authorization, this.journal.profile.inputProfile), typedData: plainTypedData(reservedTypedData(domain, authorization, this.journal.profile.inputProfile)),
        ...(pulseIntent ? { proof: pulseIntent.proof } : {}) };
      await tx.query(`INSERT INTO open_mint.generative_authorizations(namespace_id,authorization_id,deployment_id,handle,request_id,session_hash,session_generation,recipient,assessment_id,input_digest,nonce,authorization_digest,issued_at,deadline,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [value.namespaceId, value.id, value.deploymentId, value.handle, value.requestId, value.sessionHash, value.generation,
        authorization.recipient, value.assessmentId, authorization.inputDigest, authorization.nonce, value.digest, authorization.issuedAt, authorization.deadline, json(value)]);
      await tx.query("INSERT INTO open_mint.generative_authorization_heads(namespace_id,deployment_id,handle,authorization_id) VALUES($1,$2,$3,$4)", [value.namespaceId, value.deploymentId, value.handle, value.id]);
      const end = await this.#context(tx, input); this.#chain(input, request, end.policy, end.now, authorization.nonce);
      return deepFreeze(value);
    });
  }
  /** Select the exact saved reservation nonce for a fresh backend preflight,
   * or a candidate for first issuance. Read-only; neither reserves nor signs. */
  async preflightNonce(value: Omit<IssuanceIntent, "eligibility">): Promise<Hex> {
    const input = capture({ ...value, eligibility: undefined });
    return this.writer.transaction(async tx => {
      const { request } = await this.#context(tx, input), row = await this.#head(tx, request.handle);
      if (!row) return `0x${randomBytes(32).toString("hex")}` as Hex;
      const saved = this.#decode(row);
      if (saved.requestId !== request.request_id || saved.sessionHash !== input.sessionHash || saved.generation !== input.sessionGeneration) {
        blocked("MINT_RESERVED", "This handle has a preserved authorization reservation.");
      }
      return saved.authorization.nonce;
    });
  }
  /** Private backend operation; returned unsigned bytes grant no mint authority. */
  async reserve(value: IssuanceIntent): Promise<AuthorizationReservation> {
    const input = capture(value), artifact = await this.#prepare(input);
    return this.#reserve(input, artifact);
  }
  async #admissionInspection(tx: Transaction, input: CapturedIntent, artifact: PreparedGenerativeInputs,
    reservation: AuthorizationReservation, state: Stored["state"]) {
    const c = await this.#context(tx, input), row = await this.#head(tx, reservation.handle);
    if (!row || row.state !== state || row.authorization_id !== reservation.id || !row.payload.equals(json(reservation))
      || (state === "signing" && row.signing_epoch !== this.writer.epoch)) blocked("SIGNING_UNCERTAIN", "The preserved signing state cannot be dispatched again.");
    this.#sameOwner(this.#decode(row), input, c.request, artifact); await this.#frozenInputs(tx, artifact, c.request);
    const end = await this.#context(tx, input), evidence = this.#chain(input, end.request, end.policy, end.now, reservation.authorization.nonce);
    const validUntil = Math.min(Number(reservation.authorization.deadline) * 1000, end.request.expires_at.getTime(), end.session.expires_at.getTime(),
      end.session.proof_expires_at!.getTime(), evidence.validUntil, ...[end.policy, this.requests.profile].flatMap(p =>
        [evidence.observedAt + p.max_evidence_age_ms, Number(evidence.block.timestamp) * 1000 + p.max_block_age_ms]));
    if (validUntil <= end.now) blocked("AUTHORIZATION_EXPIRED", "The preserved authorization expired before signing.");
    return { observedAt: end.now, validUntil, timeoutMs: end.policy.signer_timeout_ms };
  }
  /** Private, read-only validation for wallet admission. Requires fresh proof,
   * current enabled issuance and exact saved signature; never re-signs. */
  async prepareSignedInspection(value: IssuanceIntent) {
    const input = capture(value), artifact = await this.#prepare(input);
    const reservation = await this.writer.transaction(async tx => {
      const { request } = await this.#context(tx, input), row = await this.#head(tx, request.handle);
      if (!row) blocked("NOT_READY", "A saved authorization is required.");
      return this.#decode(row);
    });
    const inspect = async (tx: Transaction) => {
      const context = await this.#admissionInspection(tx, input, artifact, reservation, "signed");
      const row = (await tx.query<{ signature: Hex }>("SELECT signature FROM open_mint.generative_authorization_signatures WHERE namespace_id=$1 AND authorization_id=$2",
        [reservation.namespaceId, reservation.id])).rows[0];
      if (!row || !await verifyReservedSignature(reservation, row.signature)) throw new PersistenceConflictError("Stored signature is invalid.");
      return { ...context, signature: row.signature };
    };
    await this.writer.transaction(inspect);
    return Object.freeze({ reservation, inspect });
  }
  /** Read-only preparation of an existing reservation for internal admission.
   * Does not reserve, sign, enable public issuance or accept a browser signer. */
  async prepareSigningAdmission(value: IssuanceIntent, signer: ReservedAuthorizationSigner): Promise<LocalMintOperation<{ reservation: AuthorizationReservation; signature: Hex }>> {
    const input = capture(value), sign = signer.signTypedData.bind(signer);
    if (getAddress(signer.address) !== getAddress(this.requests.profile.authorizer)) blocked("SIGNER_MISMATCH", "The signer does not match the pinned authorizer.");
    const artifact = await this.#prepare(input);
    const reservation = await this.writer.transaction(async tx => {
      const { request } = await this.#context(tx, input), row = await this.#head(tx, request.handle);
      if (!row) blocked("NOT_READY", "Reserve the exact authorization before admission.");
      return this.#decode(row);
    });
    let fenced = false, executed = false;
    const inspect = (tx: Transaction, state: "reserved" | "signing" = "reserved") => this.#admissionInspection(tx, input, artifact, reservation, state);
    await this.writer.transaction(tx => inspect(tx));
    return Object.freeze({ requests: this.requests, intent: Object.freeze({ operation: "sign" as const, requestId: reservation.requestId,
      payloadSha256: admissionDigest({ version: "local-generative-signing-intent-v1", reservation }) }), inspect,
      fence: async (tx: Transaction) => {
        if (fenced) blocked("SIGNING_UNCERTAIN", "This signing operation was already fenced.");
        await inspect(tx);
        await tx.query("UPDATE open_mint.generative_authorizations SET state='signing',signing_epoch=$3 WHERE namespace_id=$1 AND authorization_id=$2",
          [reservation.namespaceId, reservation.id, this.writer.epoch]);
        await inspect(tx, "signing"); fenced = true;
      },
      effect: async (signal: AbortSignal, guard: () => void) => {
        if (!fenced || executed) blocked("SIGNING_UNCERTAIN", "An acknowledged single-use signing fence is required.");
        executed = true; guard();
        // Queued behind the fence transaction: no signing on rollback or a
        // lost COMMIT acknowledgment, even if called outside the gate.
        const current = await this.writer.transaction(tx => inspect(tx, "signing")); guard();
        return this.#finishIssue(input, artifact, reservation, { signature: undefined, timeoutMs: current.timeoutMs }, sign, signal, guard);
      },
    });
  }
  async issue(value: IssuanceIntent, signer: ReservedAuthorizationSigner): Promise<{ reservation: AuthorizationReservation; signature: Hex }> {
    if (this.guard) blocked("ISSUANCE_DISABLED", "Staging issuance requires admission.");
    const input = capture(value), signerAddress = getAddress(signer.address), sign = signer.signTypedData.bind(signer);
    if (signerAddress !== getAddress(this.requests.profile.authorizer)) blocked("SIGNER_MISMATCH", "The signer does not match the pinned authorizer.");
    const artifact = await this.#prepare(input), reservation = await this.#reserve(input, artifact);
    const claim = await this.writer.transaction(async tx => {
      const { request, policy, now } = await this.#context(tx, input), row = await this.#head(tx, reservation.handle);
      if (!row || row.authorization_id !== reservation.id) throw new PersistenceConflictError("Reservation head changed.");
      this.#sameOwner(this.#decode(row), input, request, artifact); this.#chain(input, request, policy, now, reservation.authorization.nonce);
      if (BigInt(reservation.authorization.deadline) * 1000n <= BigInt(now)) blocked("AUTHORIZATION_EXPIRED", "The preserved authorization expired.");
      if (row.state === "signed") {
        const saved = (await tx.query<{ signature: Hex }>("SELECT signature FROM open_mint.generative_authorization_signatures WHERE namespace_id=$1 AND authorization_id=$2", [reservation.namespaceId, reservation.id])).rows[0];
        if (!saved) throw new PersistenceConflictError("Signed reservation has no signature.");
        return { signature: saved.signature, timeoutMs: policy.signer_timeout_ms };
      }
      if (row.state !== "reserved") blocked("SIGNING_UNCERTAIN", "Signing is pending or uncertain; no duplicate dispatch is allowed.");
      await tx.query("UPDATE open_mint.generative_authorizations SET state='signing',signing_epoch=$3 WHERE namespace_id=$1 AND authorization_id=$2", [reservation.namespaceId, reservation.id, this.writer.epoch]);
      const end = await this.#context(tx, input); this.#chain(input, request, end.policy, end.now, reservation.authorization.nonce);
      if (BigInt(reservation.authorization.deadline) * 1000n <= BigInt(end.now)) blocked("AUTHORIZATION_EXPIRED", "The preserved authorization expired before signing.");
      return { signature: undefined, timeoutMs: policy.signer_timeout_ms };
    });
    return this.#finishIssue(input, artifact, reservation, claim, sign);
  }
  /** Explicit guarded issuance: reserve unsigned intent, then select either a
   * new signing fence or read-only release of the exact saved signature. Never
   * fall back from uncertain signing to another signer call. */
  async prepareIssuanceAdmission(value: IssuanceIntent, signer: ReservedAuthorizationSigner): Promise<LocalMintOperation<{ reservation: AuthorizationReservation; signature: Hex }>> {
    const input = capture(value);
    if (getAddress(signer.address) !== getAddress(this.requests.profile.authorizer)) blocked("SIGNER_MISMATCH", "The signer does not match the pinned authorizer.");
    const artifact = await this.#prepare(input), reservation = await this.#reserve(input, artifact);
    const state = await this.writer.transaction(async tx => {
      const row = await this.#head(tx, reservation.handle);
      if (!row || row.authorization_id !== reservation.id) throw new PersistenceConflictError("Reservation head changed.");
      return row.state;
    });
    if (state === "reserved") return this.prepareSigningAdmission(input, signer);
    if (state !== "signed") blocked("SIGNING_UNCERTAIN", "Signing is pending or uncertain; no duplicate dispatch is allowed.");
    const saved = await this.prepareSignedInspection(input);
    return Object.freeze({ requests: this.requests, intent: Object.freeze({ operation: "reuse" as const, requestId: reservation.requestId,
      payloadSha256: admissionDigest({ version: "local-generative-saved-signature-v1", reservation }) }), inspect: saved.inspect,
      fence: async () => { throw new PersistenceConflictError("Saved signatures are read-only."); },
      effect: async (signal: AbortSignal, guard: () => void) => {
        signal.throwIfAborted(); guard();
        const current = await this.writer.transaction(saved.inspect); guard(); signal.throwIfAborted();
        return { reservation: saved.reservation, signature: current.signature };
      },
    });
  }
  async #finishIssue(input: CapturedIntent, artifact: PreparedGenerativeInputs, reservation: AuthorizationReservation,
    claim: { signature: Hex | undefined; timeoutMs: number }, sign: ReservedAuthorizationSigner["signTypedData"], externalSignal?: AbortSignal,
    guard: () => void = () => {}): Promise<{ reservation: AuthorizationReservation; signature: Hex }> {
    let signature = claim.signature;
    if (!signature) {
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => controller.abort();
      externalSignal?.addEventListener("abort", abort, { once: true });
      let rejectStopped!: (reason: Error) => void;
      const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
      const onStop = () => rejectStopped(new Error("signer cancelled"));
      controller.signal.addEventListener("abort", onStop, { once: true });
      const deadline = performance.now() + claim.timeoutMs;
      const check = () => {
        if (controller.signal.aborted || externalSignal?.aborted || performance.now() >= deadline) throw new Error("signer timeout or cancellation");
        this.writer.assertHealthy();
        guard();
      };
      try {
        check();
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("signer timeout")); }, claim.timeoutMs); });
        const result = await Promise.race([Promise.resolve().then(() => {
          // Recheck in the dispatch microtask, not only before scheduling it.
          check();
          return sign(deepFreeze(structuredClone(reservedTypedData(reservation.domain, reservation.authorization, this.journal.profile.inputProfile))), controller.signal);
        }), timeout, stopped]);
        check();
        if (typeof result !== "string" || result.length !== 132 || !await verifyReservedSignature(reservation, result)) throw new Error("invalid signer result");
        check();
        signature = result as Hex;
      } catch {
        await this.writer.transaction(async tx => {
          await tx.query("UPDATE open_mint.generative_authorizations SET state='unknown' WHERE namespace_id=$1 AND authorization_id=$2 AND state='signing' AND signing_epoch=$3", [reservation.namespaceId, reservation.id, this.writer.epoch]);
        });
        blocked("SIGNING_UNCERTAIN", "The signing result is unavailable or invalid; its reservation is preserved.");
      } finally { clearTimeout(timer); externalSignal?.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", onStop); controller.abort(); }
      const exactSignature = signature;
      await this.writer.transaction(async tx => {
        const row = await this.#head(tx, reservation.handle);
        if (!row || row.authorization_id !== reservation.id || row.state !== "signing" || row.signing_epoch !== this.writer.epoch
          || !row.payload.equals(json(reservation))) throw new PersistenceConflictError("Signing fence changed.");
        await tx.query("INSERT INTO open_mint.generative_authorization_signatures(namespace_id,authorization_id,signature) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [reservation.namespaceId, reservation.id, exactSignature]);
        const saved = (await tx.query<{ signature: string }>("SELECT signature FROM open_mint.generative_authorization_signatures WHERE namespace_id=$1 AND authorization_id=$2", [reservation.namespaceId, reservation.id])).rows[0];
        if (saved.signature !== exactSignature) throw new PersistenceConflictError("Conflicting immutable signature.");
        await tx.query("UPDATE open_mint.generative_authorizations SET state='signed' WHERE namespace_id=$1 AND authorization_id=$2", [reservation.namespaceId, reservation.id]);
      });
    } else if (!await verifyReservedSignature(reservation, signature)) throw new PersistenceConflictError("Stored signature is invalid.");
    const releasedSignature = signature;
    return this.writer.transaction(async tx => {
      guard();
      const { request, now, policy } = await this.#context(tx, input), row = await this.#head(tx, reservation.handle);
      if (!row || row.state !== "signed" || row.authorization_id !== reservation.id || !row.payload.equals(json(reservation))) throw new PersistenceConflictError("Signed reservation changed.");
      this.#sameOwner(reservation, input, request, artifact); await this.#frozenInputs(tx, artifact, request);
      const end = await this.#context(tx, input); this.#chain(input, request, policy, end.now, reservation.authorization.nonce);
      if (BigInt(reservation.authorization.deadline) * 1000n <= BigInt(Math.max(now, end.now))) blocked("AUTHORIZATION_EXPIRED", "The preserved authorization expired before release.");
      guard();
      return { reservation, signature: releasedSignature! };
    });
  }
}
