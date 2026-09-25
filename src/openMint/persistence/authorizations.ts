import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import canonicalize from "canonicalize";
import { getAddress, type Address, type Hex } from "viem";
import { validateAssessment } from "../assessment.js";
import { normalizeOpenMintAuthorization, openMintDigest, openMintHandleKey, openMintTokenURIHash, openMintTypedData,
  verifyOpenMintAuthorization, type OpenMintAuthorizationInput } from "../authorization.js";
import { readPublicChainEligibility, type PublicChainEvidence } from "../publicChain.js";
import type { PreparedPublicArtifact } from "../publicArtifacts.js";
import type { MintProjectionEvidence } from "../projection/decode.js";
import { isCode } from "../security.js";
import { PostgresPublicationJournal } from "./publication.js";
import { PostgresMintRequests } from "./requests.js";
import { capabilityHash } from "./sessions.js";
import { PersistenceConflictError, type OwnershipConnection } from "./writer.js";

type Transaction = Pick<OwnershipConnection, "query">;
export interface IssuanceIntent {
  readonly code: string; readonly sessionToken: string; readonly sessionGeneration: string;
  readonly origin: string | undefined; readonly csrf: string | undefined; readonly consent: boolean;
  /** Server-owned gate witness. The browser cannot select authorization fields. */
  readonly eligibility: unknown;
}
export interface ReservedAuthorizationSigner {
  readonly address: Address;
  signTypedData(input: ReturnType<typeof openMintTypedData>, signal: AbortSignal): Promise<string>;
}
interface AuthorizationFields extends Omit<OpenMintAuthorizationInput, "issuedAt" | "deadline"> { issuedAt: string; deadline: string }
export interface AuthorizationReservation {
  readonly version: "sg-open-authorization-1"; readonly id: string; readonly namespaceId: string; readonly deploymentId: string;
  readonly requestId: string; readonly sessionHash: string; readonly generation: string; readonly handle: string; readonly assessmentId: string;
  readonly tokenURI: string; readonly authorizer: Address;
  readonly domain: { readonly chainId: string; readonly verifyingContract: Address };
  readonly authorization: AuthorizationFields; readonly digest: Hex; readonly typedData: unknown;
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
  recipient: string; assessment_id: string; artifact_digest: string; nonce: string; authorization_digest: string; issued_at: string; deadline: string;
  payload: Buffer; state: "reserved" | "signing" | "unknown" | "signed"; signing_epoch: string | null;
}
interface CapturedIntent extends IssuanceIntent { sessionHash: string; codeHash: string }
const json = (value: unknown): Buffer => Buffer.from(canonicalize(value)!);
const plainTypedData = (value: ReturnType<typeof openMintTypedData>): unknown => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
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
function artifactHeader(artifact: PreparedPublicArtifact): Buffer {
  const { svg, png, metadata, ...rest } = artifact;
  return json({ ...rest, svg: svg.object, png: png.object, metadata: metadata.object });
}
/** Real canonical ECDSA verification, separately exercised with public literals.
 * No injected verification bypass exists in production. */
export function verifyReservedSignature(value: Pick<AuthorizationReservation, "domain" | "authorization" | "authorizer">, signature: string): Promise<boolean> {
  return verifyOpenMintAuthorization(value.domain, value.authorization, signature, value.authorizer);
}

/** Local-only foundation. Public issuance remains unavailable, including when
 * a future staging/production profile accidentally sets enabled=true. */
export class PostgresAuthorizationIssuer {
  private constructor(readonly requests: PostgresMintRequests, readonly journal: PostgresPublicationJournal) {}
  get writer() { return this.requests.repository.writer; }
  static async open(requests: PostgresMintRequests, journal: PostgresPublicationJournal): Promise<PostgresAuthorizationIssuer> {
    if (requests.repository.writer !== journal.writer || requests.repository.namespace.profile !== "local-real"
      || requests.repository.namespace.provenance !== "grok" || requests.profile.chain_id !== "31337") blocked("ISSUANCE_DISABLED", "Only the isolated local issuance foundation is implemented.");
    const issuer = new PostgresAuthorizationIssuer(requests, journal);
    await issuer.writer.transaction(tx => issuer.#policy(tx, false));
    return issuer;
  }
  async #policy(tx: Transaction, requireEnabled = true): Promise<Policy> {
    const row = (await tx.query<Policy>("SELECT enabled,lifetime_seconds,signer_timeout_ms,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms FROM open_mint.issuance_profiles WHERE namespace_id=$1 AND deployment_id=$2", [this.requests.repository.namespace.id, this.requests.profile.deployment_id])).rows[0];
    if (!row || (requireEnabled && !row.enabled)) blocked("ISSUANCE_DISABLED", "Authorization issuance is disabled.");
    return row;
  }
  async #now(tx: Transaction): Promise<number> { return (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime(); }
  async #context(tx: Transaction, input: CapturedIntent): Promise<{ request: Request; session: Session; now: number; policy: Policy }> {
    const namespace = this.requests.repository.namespace.id, now = await this.#now(tx), policy = await this.#policy(tx);
    const session = (await tx.query<Session>("SELECT *,generation::text FROM open_mint.sessions WHERE namespace_id=$1 AND session_hash=$2 FOR UPDATE", [namespace, input.sessionHash])).rows[0];
    if (!session || session.revoked || session.expires_at.getTime() <= now || input.origin !== this.requests.profile.origin
      || !isCode(input.csrf) || !timingSafeEqual(Buffer.from(input.csrf), Buffer.from(session.csrf))) blocked("SESSION_REQUIRED", "A current session and request origin are required.");
    const request = (await tx.query<Request>("SELECT request_id,handle,wallet,expires_at,assessment_id FROM open_mint.requests WHERE namespace_id=$1 AND deployment_id=$2 AND code_hash=$3 AND session_hash=$4", [namespace, this.requests.profile.deployment_id, input.codeHash, input.sessionHash])).rows[0];
    if (!request) blocked("NOT_FOUND", "Signature request not found.");
    if (request.expires_at.getTime() <= now) blocked("REQUEST_EXPIRED", "This request expired; its saved work and reservation are preserved.");
    if (session.generation !== input.sessionGeneration || session.wallet !== request.wallet) blocked("WALLET_CHANGED", "The current wallet or generation changed.");
    if (session.proof_wallet !== request.wallet || !session.proof_expires_at || session.proof_expires_at.getTime() <= now || session.active_challenge_hash
      || (session.proof_code_hash !== null && session.proof_code_hash !== input.codeHash)) blocked("WALLET_PROOF_REQUIRED", "A current general or matching request proof is required.");
    return { request, session, now, policy };
  }
  #chain(input: CapturedIntent, request: Request, policy: Policy, now: number, nonce?: string): PublicChainEvidence {
    let evidence: PublicChainEvidence;
    try { evidence = readPublicChainEligibility(input.eligibility, { namespaceId: this.requests.repository.namespace.id, deploymentId: this.requests.profile.deployment_id,
      handle: request.handle, recipient: request.wallet, nonce, now }); }
    catch { return blocked("CHAIN_UNAVAILABLE", "Fresh exact chain eligibility is required."); }
    const p = this.requests.profile;
    if (evidence.contractProfile !== undefined && evidence.contractProfile !== "external-v1") blocked("CHAIN_PROFILE_MISMATCH", "External-URI issuance cannot use an on-chain deployment.");
    if (evidence.chainId.toString() !== p.chain_id || evidence.contract.toLowerCase() !== p.contract_address || evidence.genesisHash !== p.genesis_hash
      || evidence.runtimeCodeHash !== p.runtime_code_hash || evidence.authorizer.toLowerCase() !== p.authorizer
      || evidence.deploymentBlock.number.toString() !== p.deployment_block || evidence.deploymentBlock.hash !== p.deployment_block_hash) blocked("CHAIN_PROFILE_MISMATCH", "The chain witness has different deployment pins.");
    const blockTime = Number(evidence.block.timestamp) * 1000;
    for (const bounds of [p, policy]) if (now - evidence.observedAt >= bounds.max_evidence_age_ms || now - blockTime >= bounds.max_block_age_ms
      || blockTime - now > bounds.max_future_skew_ms) blocked("CHAIN_UNAVAILABLE", "Chain evidence exceeds the durable freshness policy.");
    return evidence;
  }
  async #publication(tx: Transaction, artifact: PreparedPublicArtifact, request: Pick<Request, "handle" | "assessment_id">): Promise<void> {
    const namespace = this.requests.repository.namespace;
    const saved = (await tx.query<{ payload: Buffer; digest: string; assessment_id: string; handle: string }>(`SELECT s.payload,s.digest,s.assessment_id,s.handle FROM open_mint.assessments s
      JOIN open_mint.assessment_attempts a USING(namespace_id,attempt_id) WHERE s.namespace_id=$1 AND s.handle=$2 AND a.state='accepted'`, [namespace.id, request.handle])).rows[0];
    if (!saved) blocked("NOT_READY", "The exact accepted assessment is required.");
    const accepted = validateAssessment(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(saved.payload)));
    if (accepted.id !== saved.assessment_id || accepted.digest !== saved.digest || accepted.handle !== saved.handle || accepted.handle !== request.handle
      || accepted.policyVersion !== namespace.policyVersion || accepted.provenance !== namespace.provenance || accepted.xIdentity?.provenance !== "x-api"
      || (request.assessment_id !== null && request.assessment_id !== accepted.id) || !json(accepted).equals(json(artifact.assessment))) throw new PersistenceConflictError("Accepted assessment binding changed.");
    const row = (await tx.query<{ header: Buffer; svg: Buffer; png: Buffer; metadata: Buffer; origin: string; destination: string; source: string }>(`SELECT a.header,a.svg,a.png,a.metadata,p.origin,p.destination,p.source
      FROM open_mint.public_artifacts a JOIN open_mint.completed_publications c USING(namespace_id,digest)
      JOIN open_mint.publication_profiles p USING(namespace_id) WHERE a.namespace_id=$1 AND a.handle=$2 AND a.digest=$3`, [namespace.id, request.handle, artifact.digest])).rows[0];
    if (!row || row.origin !== this.requests.profile.origin || row.origin !== artifact.origin || !row.header.equals(artifactHeader(artifact))
      || !row.svg.equals(Buffer.from(artifact.svg.bytes)) || !row.png.equals(Buffer.from(artifact.png.bytes)) || !row.metadata.equals(Buffer.from(artifact.metadata.bytes))) blocked("NOT_READY", "Exact completed publication bytes are required.");
    const observed = (await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM open_mint.publication_observations WHERE namespace_id=$1 AND digest=$2
      AND ((phase='uploaded' AND identity=$3) OR (phase='retrieved' AND identity=$4))`, [namespace.id, artifact.digest, row.destination, row.source])).rows[0];
    if (row.destination === row.source || observed?.count !== 6) blocked("NOT_READY", "Independent publication evidence is incomplete.");
  }
  #decode(row: Stored): AuthorizationReservation {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.payload)) as AuthorizationReservation;
    exactKeys(value, ["version", "id", "namespaceId", "deploymentId", "requestId", "sessionHash", "generation", "handle", "assessmentId", "tokenURI", "authorizer", "domain", "authorization", "digest", "typedData"]);
    exactKeys(value.domain, ["chainId", "verifyingContract"]);
    exactKeys(value.authorization, ["handleKey", "assessmentDigest", "artifactDigest", "recipient", "tokenURIHash", "nonce", "issuedAt", "deadline"]);
    const p = this.requests.profile, a = normalizeOpenMintAuthorization(value.authorization);
    if (!json(value).equals(row.payload) || value.version !== "sg-open-authorization-1" || value.namespaceId !== this.requests.repository.namespace.id
      || value.id !== row.authorization_id || value.deploymentId !== row.deployment_id || value.deploymentId !== p.deployment_id
      || value.requestId !== row.request_id || value.sessionHash !== row.session_hash || value.generation !== row.session_generation
      || value.handle !== row.handle || value.assessmentId !== row.assessment_id || value.authorizer.toLowerCase() !== p.authorizer
      || value.domain.chainId !== p.chain_id || value.domain.verifyingContract.toLowerCase() !== p.contract_address
      || a.recipient !== getAddress(row.recipient) || a.artifactDigest !== row.artifact_digest || a.nonce !== row.nonce
      || a.issuedAt.toString() !== row.issued_at || a.deadline.toString() !== row.deadline || a.handleKey !== openMintHandleKey(value.handle)
      || a.tokenURIHash !== openMintTokenURIHash(value.tokenURI) || value.digest !== row.authorization_digest
      || value.digest !== openMintDigest(value.domain, a) || !json(value.typedData).equals(json(plainTypedData(openMintTypedData(value.domain, a))))) throw new PersistenceConflictError("Stored authorization binding mismatch.");
    return deepFreeze(value);
  }
  async #head(tx: Transaction, handle: string): Promise<Stored | undefined> {
    return (await tx.query<Stored>(`SELECT a.*,a.session_generation::text,a.issued_at::text,a.deadline::text,a.signing_epoch::text
      FROM open_mint.authorization_heads h JOIN open_mint.authorizations a USING(namespace_id,deployment_id,handle,authorization_id)
      WHERE h.namespace_id=$1 AND h.deployment_id=$2 AND h.handle=$3 FOR UPDATE OF a`, [this.requests.repository.namespace.id, this.requests.profile.deployment_id, handle])).rows[0];
  }
  /** Private read-only bridge for the canonical event decoder. Historical
   * issuance remains inspectable after logout/expiry/kill-switch; this does not
   * reserve, sign, assess, renew or publish anything. Never expose this payload
   * from an HTTP route: it contains private reservation/session references. */
  async projectionEvidence(log: { readonly handle: string; readonly nonce: string; readonly authorizationDigest: string }, signal: AbortSignal): Promise<MintProjectionEvidence | undefined> {
    const captured = { handle: log.handle, nonce: log.nonce, authorizationDigest: log.authorizationDigest };
    openMintHandleKey(captured.handle);
    if (![captured.nonce, captured.authorizationDigest].every(v => /^0x[0-9a-f]{64}$/.test(v))) throw new PersistenceConflictError("Invalid projection evidence key.");
    const check = () => { if (signal.aborted) throw new PersistenceConflictError("Projection evidence read cancelled."); this.writer.assertHealthy(); };
    check();
    const artifact = await this.journal.load(captured.handle, true); check();
    if (!artifact) return undefined;
    const result = await this.writer.transaction(async tx => {
      check();
      const row = (await tx.query<Stored & { signature: string | null }>(`SELECT a.*,a.session_generation::text,a.issued_at::text,a.deadline::text,a.signing_epoch::text,s.signature
        FROM open_mint.authorizations a LEFT JOIN open_mint.authorization_signatures s USING(namespace_id,authorization_id)
        WHERE a.namespace_id=$1 AND a.deployment_id=$2 AND a.handle=$3 AND a.nonce=$4 AND a.authorization_digest=$5`,
      [this.requests.repository.namespace.id, this.requests.profile.deployment_id, captured.handle, captured.nonce, captured.authorizationDigest])).rows[0];
      if (!row || row.state !== "signed" || !row.signature) return undefined;
      const reservation = this.#decode(row);
      await this.#publication(tx, artifact, { handle: captured.handle, assessment_id: reservation.assessmentId });
      check(); return { reservation, signature: row.signature, artifact };
    });
    check();
    if (result && !await verifyReservedSignature(result.reservation, result.signature)) throw new PersistenceConflictError("Stored projection signature is invalid.");
    check(); return result;
  }
  #sameOwner(value: AuthorizationReservation, input: CapturedIntent, request: Request, artifact: PreparedPublicArtifact): void {
    if (value.requestId !== request.request_id || value.sessionHash !== input.sessionHash || value.generation !== input.sessionGeneration
      || value.authorization.recipient !== getAddress(request.wallet) || value.assessmentId !== artifact.assessment.id
      || value.authorization.assessmentDigest !== artifact.assessment.digest || value.authorization.artifactDigest !== artifact.digest
      || value.tokenURI !== artifact.metadata.object.uri) blocked("MINT_RESERVED", "This handle has a preserved authorization reservation; expiry does not release it.");
  }
  async #prepare(input: CapturedIntent): Promise<PreparedPublicArtifact> {
    const request = await this.requests.get(input.code, input.sessionToken), artifact = await this.journal.load(request.handle, true);
    if (!artifact) blocked("NOT_READY", "Verified publication is required before reservation.");
    return structuredClone(artifact);
  }
  async #reserve(input: CapturedIntent, artifact: PreparedPublicArtifact): Promise<AuthorizationReservation> {
    return this.writer.transaction(async tx => {
      const { request, session, now, policy } = await this.#context(tx, input);
      await tx.query("SELECT handle FROM open_mint.handle_guards WHERE namespace_id=$1 AND handle=$2 FOR UPDATE", [this.requests.repository.namespace.id, request.handle]);
      await this.#publication(tx, artifact, request);
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
        Math.floor(session.expires_at.getTime() / 1000), Math.floor(session.proof_expires_at!.getTime() / 1000));
      if (deadline <= Math.max(wall, chain) + 15) blocked("REQUEST_EXPIRED", "Too little safe time remains for a mint authorization.");
      const domain = { chainId: this.requests.profile.chain_id, verifyingContract: getAddress(this.requests.profile.contract_address) };
      const authorization: AuthorizationFields = { handleKey: openMintHandleKey(request.handle), assessmentDigest: artifact.assessment.digest, artifactDigest: artifact.digest,
        recipient: getAddress(request.wallet), tokenURIHash: openMintTokenURIHash(artifact.metadata.object.uri), nonce: evidence.nonce, issuedAt: String(issuedAt), deadline: String(deadline) };
      const value: AuthorizationReservation = { version: "sg-open-authorization-1", id: randomUUID(), namespaceId: this.requests.repository.namespace.id,
        deploymentId: this.requests.profile.deployment_id, requestId: request.request_id, sessionHash: input.sessionHash, generation: input.sessionGeneration,
        handle: request.handle, assessmentId: artifact.assessment.id, tokenURI: artifact.metadata.object.uri, authorizer: getAddress(this.requests.profile.authorizer), domain,
        authorization, digest: openMintDigest(domain, authorization), typedData: plainTypedData(openMintTypedData(domain, authorization)) };
      await tx.query(`INSERT INTO open_mint.authorizations(namespace_id,authorization_id,deployment_id,handle,request_id,session_hash,session_generation,recipient,assessment_id,artifact_digest,nonce,authorization_digest,issued_at,deadline,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [value.namespaceId, value.id, value.deploymentId, value.handle, value.requestId, value.sessionHash, value.generation,
        authorization.recipient, value.assessmentId, authorization.artifactDigest, authorization.nonce, value.digest, authorization.issuedAt, authorization.deadline, json(value)]);
      await tx.query("INSERT INTO open_mint.authorization_heads(namespace_id,deployment_id,handle,authorization_id) VALUES($1,$2,$3,$4)", [value.namespaceId, value.deploymentId, value.handle, value.id]);
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
  async issue(value: IssuanceIntent, signer: ReservedAuthorizationSigner): Promise<{ reservation: AuthorizationReservation; signature: Hex }> {
    const input = capture(value), signerAddress = getAddress(signer.address), sign = signer.signTypedData.bind(signer);
    if (signerAddress !== getAddress(this.requests.profile.authorizer)) blocked("SIGNER_MISMATCH", "The signer does not match the pinned authorizer.");
    const artifact = await this.#prepare(input), reservation = await this.#reserve(input, artifact);
    const claim = await this.writer.transaction(async tx => {
      const { request, policy, now } = await this.#context(tx, input), row = await this.#head(tx, reservation.handle);
      if (!row || row.authorization_id !== reservation.id) throw new PersistenceConflictError("Reservation head changed.");
      this.#sameOwner(this.#decode(row), input, request, artifact); this.#chain(input, request, policy, now, reservation.authorization.nonce);
      if (BigInt(reservation.authorization.deadline) * 1000n <= BigInt(now)) blocked("AUTHORIZATION_EXPIRED", "The preserved authorization expired.");
      if (row.state === "signed") {
        const saved = (await tx.query<{ signature: Hex }>("SELECT signature FROM open_mint.authorization_signatures WHERE namespace_id=$1 AND authorization_id=$2", [reservation.namespaceId, reservation.id])).rows[0];
        if (!saved) throw new PersistenceConflictError("Signed reservation has no signature.");
        return { signature: saved.signature, timeoutMs: policy.signer_timeout_ms };
      }
      if (row.state !== "reserved") blocked("SIGNING_UNCERTAIN", "Signing is pending or uncertain; no duplicate dispatch is allowed.");
      await tx.query("UPDATE open_mint.authorizations SET state='signing',signing_epoch=$3 WHERE namespace_id=$1 AND authorization_id=$2", [reservation.namespaceId, reservation.id, this.writer.epoch]);
      const end = await this.#context(tx, input); this.#chain(input, request, end.policy, end.now, reservation.authorization.nonce);
      if (BigInt(reservation.authorization.deadline) * 1000n <= BigInt(end.now)) blocked("AUTHORIZATION_EXPIRED", "The preserved authorization expired before signing.");
      return { signature: undefined, timeoutMs: policy.signer_timeout_ms };
    });
    let signature = claim.signature;
    if (!signature) {
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = performance.now() + claim.timeoutMs;
      const check = () => {
        if (controller.signal.aborted || performance.now() >= deadline) throw new Error("signer timeout or cancellation");
        this.writer.assertHealthy();
      };
      try {
        check();
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("signer timeout")); }, claim.timeoutMs); });
        const result = await Promise.race([Promise.resolve().then(() => {
          // Recheck in the dispatch microtask, not only before scheduling it.
          check();
          return sign(deepFreeze(structuredClone(openMintTypedData(reservation.domain, reservation.authorization))), controller.signal);
        }), timeout]);
        check();
        if (typeof result !== "string" || result.length !== 132 || !await verifyReservedSignature(reservation, result)) throw new Error("invalid signer result");
        check();
        signature = result as Hex;
      } catch {
        await this.writer.transaction(async tx => {
          await tx.query("UPDATE open_mint.authorizations SET state='unknown' WHERE namespace_id=$1 AND authorization_id=$2 AND state='signing' AND signing_epoch=$3", [reservation.namespaceId, reservation.id, this.writer.epoch]);
        });
        blocked("SIGNING_UNCERTAIN", "The signing result is unavailable or invalid; its reservation is preserved.");
      } finally { clearTimeout(timer); controller.abort(); }
      const exactSignature = signature;
      await this.writer.transaction(async tx => {
        const row = await this.#head(tx, reservation.handle);
        if (!row || row.authorization_id !== reservation.id || row.state !== "signing" || row.signing_epoch !== this.writer.epoch
          || !row.payload.equals(json(reservation))) throw new PersistenceConflictError("Signing fence changed.");
        await tx.query("INSERT INTO open_mint.authorization_signatures(namespace_id,authorization_id,signature) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [reservation.namespaceId, reservation.id, exactSignature]);
        const saved = (await tx.query<{ signature: string }>("SELECT signature FROM open_mint.authorization_signatures WHERE namespace_id=$1 AND authorization_id=$2", [reservation.namespaceId, reservation.id])).rows[0];
        if (saved.signature !== exactSignature) throw new PersistenceConflictError("Conflicting immutable signature.");
        await tx.query("UPDATE open_mint.authorizations SET state='signed' WHERE namespace_id=$1 AND authorization_id=$2", [reservation.namespaceId, reservation.id]);
      });
    } else if (!await verifyReservedSignature(reservation, signature)) throw new PersistenceConflictError("Stored signature is invalid.");
    const releasedSignature = signature;
    return this.writer.transaction(async tx => {
      const { request, now, policy } = await this.#context(tx, input), row = await this.#head(tx, reservation.handle);
      if (!row || row.state !== "signed" || row.authorization_id !== reservation.id || !row.payload.equals(json(reservation))) throw new PersistenceConflictError("Signed reservation changed.");
      this.#sameOwner(reservation, input, request, artifact); await this.#publication(tx, artifact, request);
      const end = await this.#context(tx, input); this.#chain(input, request, policy, end.now, reservation.authorization.nonce);
      if (BigInt(reservation.authorization.deadline) * 1000n <= BigInt(Math.max(now, end.now))) blocked("AUTHORIZATION_EXPIRED", "The preserved authorization expired before release.");
      return { reservation, signature: releasedSignature! };
    });
  }
}
