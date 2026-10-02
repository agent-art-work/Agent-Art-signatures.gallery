import { randomBytes } from "node:crypto";
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { formalSignatureRenderer, renderCardPng, sha256Hex } from "../v1/renderer.js";
import { renderSignatureSvg } from "../algorithmV2/index.js";
import { AssessmentAbstainedError, AssessmentCoordinator, validateAssessment, type Assessment } from "./assessment.js";
import { AssessmentOperations, AssessmentOperationsError, AssessmentPersistenceError } from "./assessmentOperations.js";
import { FIXTURE_PROFILE_VERSION, GROK_PILOT_PROFILE } from "./providerProfile.js";
import { ProviderResponseInvalidError } from "./grok.js";
import { canonicalHandle, handleDigest, LEGACY_RENDERER_VERSION, preservedHandle } from "./identity.js";
import { normalizeOpenMintAuthorization, openMintTokenURIHash, type OpenMintAuthorizationInput } from "./authorization.js";
import { isCode, isDiagnosticReference, opaqueCode, PublicError, type SiteSession } from "./security.js";
import { SerialKeys, type KeyValueStore } from "./storage.js";
import type { OpenMintNetwork } from "./network.js";
import { canRevealMint, type MintConfidence } from "./revealPolicy.js";

export interface MintState {
  state: MintConfidence;
  tokenId?: string;
  wallet?: string;
  transactionHash?: Hex;
  assessmentDigest?: Hex;
  artifactDigest?: Hex;
  tokenURIHash?: Hex;
}
export interface SignatureRequest {
  code: string; handle: string; owner: string; status: "pending" | "ready" | "failed";
  /** Requests created before wallet-gated preparation have no recipient binding and cannot mint. */
  wallet?: Address;
  /** Missing only on requests saved before case-preserving rendering. */
  requestedHandle?: string;
  createdAt: number; expiresAt: number; assessmentId?: string; error?: string;
  /** Safe operational reference, never the private request code or provider payload. */
  attemptId?: string;
  errorCategory?: "assessment-abstained" | "assessment-blocked" | "preparation-interrupted";
}
export interface SignatureArtifact {
  assessment: Assessment; svgSha256: string; pngSha256: string; metadataSha256: string;
  /** New real artwork uses assessment.xIdentity.username. Historical bytes remain unchanged. */
  renderHandle?: string;
  tokenURI: string; digest: Hex;
}
interface Issuance {
  code: string; owner: string; handle: string; tokenURI: string;
  authorization: OpenMintAuthorizationInput; signature?: Hex;
}
const ASSESSMENT_FAILED = "The assessment could not be completed. No mint was submitted. It will not be retried automatically; please contact support.";
const ownerKey = (session: SiteSession): string => sha256Hex(Buffer.from(session.id));
const nowSeconds = (now: () => number): number => Math.floor(now() / 1000);
const artifactDigest = (value: Omit<SignatureArtifact, "digest">): Hex => keccak256(stringToHex(JSON.stringify(value)));

export class OpenMintService {
  readonly #locks = new SerialKeys();
  readonly #jobs = new Set<Promise<void>>();
  readonly #assessing = new Map<string, Promise<Assessment>>();
  readonly now: () => number;
  readonly operations: AssessmentOperations;
  constructor(readonly options: {
    assessments?: AssessmentCoordinator;
    store: KeyValueStore;
    origin: string;
    network?: OpenMintNetwork;
    fixture: boolean;
    now?: () => number;
    dailyAssessmentLimit?: number;
    operations?: AssessmentOperations;
    assessmentProfileVersion?: string;
  }) {
    this.now = options.now ?? Date.now;
    this.operations = options.operations ?? new AssessmentOperations({ store: options.store, now: this.now,
      generationEnabled: options.fixture, accountingRequired: !options.fixture,
      dailyLimit: options.dailyAssessmentLimit ?? (options.fixture ? 25 : 1),
      maxTotalAttempts: options.fixture ? 10_000 : 1, maxActiveAttempts: options.fixture ? 4 : 1 });
  }
  get network(): OpenMintNetwork | undefined { return this.options.network; }
  async idle(): Promise<void> { await Promise.all([...this.#jobs]); }

  /** Read-only network identity and nonce; never accept an RPC URL from the caller. */
  async walletContext(value?: unknown) {
    let address: Address | undefined;
    if (value !== undefined) {
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new PublicError(400, "INVALID_WALLET", "Enter a valid wallet address.");
      address = getAddress(value.toLowerCase());
    }
    if (!this.network?.walletContext) throw new PublicError(503, "MINT_NETWORK_UNAVAILABLE", "The mint network cannot be verified. No transaction was sent.");
    try { return await this.network.walletContext(address); }
    catch { throw new PublicError(503, "MINT_NETWORK_UNAVAILABLE", "Cannot verify the mint network or wallet nonce. Wait for any pending wallet transactions to confirm, then try again."); }
  }

  /** A request is session-bound. Public callers never supply model output or authorization fields. */
  async request(value: unknown, session: SiteSession): Promise<SignatureRequest> {
    let handle: string;
    try { handle = canonicalHandle(value); } catch { throw new PublicError(400, "INVALID_HANDLE", "Enter a valid X handle."); }
    this.#requirePreparationWallet(session);
    if (!this.network) throw new PublicError(503, "MINT_UNAVAILABLE", "Minting is not configured yet.");
    return this.#locks.run("request-budget", async () => {
      this.#requirePreparationWallet(session);
      const wallet = session.wallet!;
      const generation = session.generation;
      let chainState: MintState;
      let chainTime: number;
      try { [chainState, chainTime] = await Promise.all([this.state(handle), this.network!.now()]); }
      catch { throw new PublicError(503, "CHAIN_UNAVAILABLE", "The local chain is temporarily unavailable. Please try again shortly."); }
      if (chainState.state === "minted") throw new PublicError(409, "ALREADY_MINTED", "This handle has already been minted. View its minted signature.");
      if (chainState.state === "pending" || chainState.state === "confirming") throw new PublicError(409, "MINT_PENDING", "This handle's mint is already confirming.");
      if (Math.abs(chainTime - nowSeconds(this.now)) > 60) throw new PublicError(503, "CHAIN_CLOCK", "The chain is not synchronized. Please try again shortly.");
      try { await this.network!.preflight?.(wallet); }
      catch { throw new PublicError(503, "CHAIN_UNAVAILABLE", "Minting is not available for this wallet right now. No assessment was requested."); }
      if (!this.options.assessments) throw new PublicError(503, "GROK_NOT_CONFIGURED", "Signature generation is not available yet. Please try again later.");
      const requests = await this.options.store.entries<SignatureRequest>("request:");
      const active = requests.map(([, request]) => request).filter(request => request.owner === ownerKey(session) && request.expiresAt > this.now());
      const existing = active.find(request => request.handle === handle && request.wallet === wallet && request.status !== "failed");
      const cached = await this.options.assessments.get(handle);
      if (!this.options.fixture && cached && cached.xIdentity?.provenance !== "x-api") throw new PublicError(409, "X_VERIFICATION_REQUIRED", "This saved assessment predates X username verification. It is preserved, but cannot receive a new mint authorization. Contact support.");
      if (!cached && !this.options.assessments.generationConfigured) throw new PublicError(503, "GROK_NOT_CONFIGURED", "New signature generation is disabled. Saved assessments remain available.");
      if (!this.options.fixture && !cached && this.options.assessments.identityProvenance !== "x-api") throw new PublicError(503, "X_LOOKUP_NOT_CONFIGURED", "X username verification is not configured. No assessment was requested.");
      const joining = this.#assessing.get(handle);
      if (existing && (existing.status === "ready" || joining)) {
        this.#requirePreparationWallet(session);
        if (session.wallet !== wallet || session.generation !== generation) throw new PublicError(409, "WALLET_CHANGED", "Your wallet changed. Connect it again before preparing a mint.");
        return existing;
      }
      const recovering = cached && existing;
      if (!recovering && active.length >= 10) throw new PublicError(429, "REQUEST_LIMIT", "Please finish an existing request first.");
      const profileVersion = this.options.assessmentProfileVersion ?? (this.options.fixture ? FIXTURE_PROFILE_VERSION : GROK_PILOT_PROFILE.id);
      let attemptId = (await this.operations.get(handle))?.id;
      if (!cached && !joining) {
        // Only a completed, separately approved operator recovery may advance a
        // failed handle. Old requests and their diagnostic references stay intact.
        try {
          const staged = await this.operations.stagedRecovery(handle, profileVersion, true);
          // A durable pending record is not evidence of live work. In particular, a failed
          // terminal write or a restarted process must never create a free paid retry.
          if (!staged && (attemptId || requests.some(([, request]) => request.handle === handle))) {
            throw new PublicError(409, "ASSESSMENT_RETRY_BLOCKED", ASSESSMENT_FAILED, { reference: attemptId, category: "assessment" });
          }
          const attempt = staged ?? await this.operations.admit(handle, profileVersion);
          attemptId = attempt.id;
        } catch (error) {
          if (!(error instanceof AssessmentOperationsError)) throw error;
          const message = error.code === "GENERATION_DISABLED" ? "New signature generation is paused. Saved assessments can still be reused."
            : error.code === "HANDLE_NOT_ALLOWED" ? "This local pilot is limited to its approved handle. No assessment was requested."
              : error.code === "ASSESSMENT_ACTIVE_LIMIT" ? "Another assessment is running. Wait for it to finish; no new assessment was requested."
                : ["ASSESSMENT_LIMIT", "ASSESSMENT_EXPOSURE_LIMIT"].includes(error.code) ? "The signature generation allowance has been reached. Saved assessments remain available."
                  : "Assessment accounting needs operator review. No new assessment was requested; automatic retries are disabled.";
          throw new PublicError(error.code.endsWith("LIMIT") ? 429 : 503, error.code, message, { category: "assessment" });
        }
      }
      // Keep the persisted lifetime exact even if the clock ticks while creating the record.
      const createdAt = recovering?.createdAt ?? this.now();
      const request: SignatureRequest = recovering || { code: opaqueCode(), handle, requestedHandle: preservedHandle(value), owner: ownerKey(session), wallet, status: "pending", createdAt, expiresAt: createdAt + 900_000, ...(attemptId ? { attemptId } : {}) };
      await this.options.store.put(`request:${request.code}`, request);
      this.#requirePreparationWallet(session);
      if (session.wallet !== wallet || session.generation !== generation) throw new PublicError(409, "WALLET_CHANGED", "Your wallet changed. Connect it again before preparing a mint.");
      const assessment = cached ? Promise.resolve(cached) : joining ?? this.#startAssessment(handle, attemptId);
      const operation = this.#complete(request, assessment).finally(() => { this.#jobs.delete(operation); });
      this.#jobs.add(operation);
      return request;
    });
  }
  #startAssessment(handle: string, attemptId?: string): Promise<Assessment> {
    const operation = (async () => {
      try {
        const execution = await this.operations.execution(handle, attemptId);
        const assessment = await this.options.assessments!.assess(handle, execution);
        return assessment;
      } catch (error) {
        if (error instanceof ProviderResponseInvalidError) {
          await this.operations.execution(handle, attemptId).then(execution => execution.recordOutcome({ kind: "invalid" })).catch(() => undefined);
        }
        const attempt = await this.operations.get(handle).catch(() => undefined);
        const category = error instanceof AssessmentPersistenceError || (attempt?.version === 1 && attempt.outcome === "accepted") ? "storage"
          : attempt?.version === 1 && attempt.phases.xDispatchedAt !== undefined && attempt.phases.xVerifiedAt === undefined ? "identity" : "provider";
        await this.operations.fail(handle, category, attemptId).catch(() => undefined);
        throw error;
      }
    })().finally(() => { this.#assessing.delete(handle); });
    this.#assessing.set(handle, operation);
    return operation;
  }
  async #complete(request: SignatureRequest, result: Promise<Assessment>): Promise<void> {
    try {
      const assessment = await result;
      if (!this.options.fixture && assessment.xIdentity?.provenance !== "x-api") throw new Error("Verified X preparation is required.");
      // A saved result can outlive a failed post-persistence ledger write. Reconcile its
      // reference only; this never dispatches a provider or changes the accepted bytes.
      const attempt = await this.operations.get(request.handle);
      if (attempt?.version === 1 && attempt.outcome === "accepted" && !attempt.acceptedAssessment) {
        await (await this.operations.execution(request.handle, request.attemptId)).assessmentPersisted(assessment);
      }
      await this.#locks.run(request.handle, () => this.#artifact(assessment, assessment.xIdentity?.username ?? request.requestedHandle ?? request.handle));
      if (attempt?.version === 1) await this.operations.artifactOutcome(request.handle, "prepared", request.attemptId);
      await this.options.store.put(`request:${request.code}`, { ...request, status: "ready", assessmentId: assessment.id });
    } catch (error) {
      // Provider responses and credentials are never exposed in browser errors or logs.
      const cached = await this.options.assessments!.get(request.handle).catch(() => undefined);
      if (cached) await this.operations.artifactOutcome(request.handle, "failed", request.attemptId).catch(() => undefined);
      await this.options.store.put(`request:${request.code}`, { ...request, status: "failed",
        errorCategory: cached ? "preparation-interrupted" : error instanceof AssessmentAbstainedError ? "assessment-abstained" : "assessment-blocked",
        error: cached ? "Your assessment is saved, but mint preparation was interrupted. Return to mint to reuse the same result."
          : error instanceof AssessmentAbstainedError ? "Grok could not make a supported assessment. No signature or mint was created. This attempt will not be retried automatically."
            : ASSESSMENT_FAILED }).catch(() => undefined);
    }
  }
  async recoverInterruptedRequests(): Promise<void> {
    for (const [key] of await this.options.store.entries("attempt:")) {
      const handle = key.slice("attempt:".length), attempt = await this.operations.get(handle);
      if (attempt?.version === 1 && (attempt.outcome === "pending" || (attempt.outcome === "accepted" && !attempt.acceptedAssessment))) {
        const profileVersion = this.options.assessmentProfileVersion ?? (this.options.fixture ? FIXTURE_PROFILE_VERSION : GROK_PILOT_PROFILE.id);
        // A staged recovery has no dispatch and still needs fresh wallet proof +
        // explicit browser intent. Merely restarting must not consume that grant.
        if (await this.operations.stagedRecovery(handle, profileVersion)) continue;
        await this.operations.fail(handle, "interrupted", attempt.id);
      }
    }
    for (const [key, request] of await this.options.store.entries<SignatureRequest>("request:")) {
      if (request.status === "pending") await this.options.store.put(key, { ...request, status: "failed", error: "This request was interrupted. A saved assessment can be reused; an unfinished assessment will not be retried automatically." });
    }
  }
  async getRequest(code: unknown): Promise<SignatureRequest> {
    if (!isCode(code)) throw new PublicError(404, "NOT_FOUND", "Signature request not found.");
    const record = await this.options.store.get<SignatureRequest>(`request:${code}`);
    if (!record) throw new PublicError(404, "NOT_FOUND", "Signature request not found.");
    if (record.code !== code || canonicalHandle(record.handle) !== record.handle || !/^[a-f0-9]{64}$/.test(record.owner)
      || !["pending", "ready", "failed"].includes(record.status) || !Number.isSafeInteger(record.createdAt) || record.expiresAt !== record.createdAt + 900_000) throw new Error("Corrupt signature request.");
    if (record.requestedHandle !== undefined && (preservedHandle(record.requestedHandle) !== record.requestedHandle || canonicalHandle(record.requestedHandle) !== record.handle)) throw new Error("Corrupt request spelling.");
    if (record.attemptId !== undefined && !isDiagnosticReference(record.attemptId)) throw new Error("Corrupt request diagnostic reference.");
    if (record.errorCategory !== undefined && !["assessment-abstained", "assessment-blocked", "preparation-interrupted"].includes(record.errorCategory)) throw new Error("Corrupt request error category.");
    if (record.wallet !== undefined && (!/^0x[0-9a-fA-F]{40}$/.test(record.wallet) || /^0x0{40}$/i.test(record.wallet))) throw new Error("Corrupt request wallet.");
    return record;
  }
  async sessionRequest(code: unknown, session: SiteSession): Promise<SignatureRequest> {
    const request = await this.getRequest(code);
    if (request.owner !== ownerKey(session)) throw new PublicError(403, "REQUEST_SESSION_MISMATCH", "Open this request in the browser that created it, or start your own request.");
    if (session.expiresAt <= this.now() || (request.wallet && request.wallet !== session.wallet)) throw new PublicError(403, "REQUEST_WALLET_MISMATCH", "Connect the wallet that started this mint.");
    return request;
  }
  async ownedRequest(code: unknown, session: SiteSession): Promise<SignatureRequest> {
    const request = await this.sessionRequest(code, session);
    if (request.expiresAt <= this.now()) throw new PublicError(410, "REQUEST_EXPIRED", "This mint window has expired. Start a new request; the saved assessment will be reused.");
    return request;
  }
  canMint(request: SignatureRequest, session: SiteSession): boolean {
    return request.status === "ready" && request.expiresAt > this.now() && session.expiresAt > this.now()
      && request.owner === ownerKey(session) && !!request.wallet && request.wallet === session.wallet;
  }
  #walletFresh(session: SiteSession): boolean {
    return session.expiresAt > this.now() && !!session.wallet && session.walletProof?.wallet === session.wallet && session.walletProof.expiresAt > this.now();
  }
  /** General sign-in can prepare a mint; an older code-scoped proof cannot. */
  walletVerified(session: SiteSession): boolean {
    return this.#walletFresh(session) && session.walletProof?.code === undefined;
  }
  #requirePreparationWallet(session: SiteSession): void {
    if (!this.walletVerified(session)) throw new PublicError(403, "WALLET_PROOF_REQUIRED", "Connect and verify your wallet before choosing Mint & reveal.");
  }
  async walletProved(code: string, session: SiteSession): Promise<boolean> {
    if (!this.#walletFresh(session) || (session.walletProof?.code !== undefined && session.walletProof.code !== code)) return false;
    const request = await this.getRequest(code);
    return this.#walletFresh(session) && (session.walletProof?.code === undefined || session.walletProof.code === code)
      && request.owner === ownerKey(session) && !!request.wallet && request.wallet === session.wallet;
  }
  async artifact(handle: string): Promise<SignatureArtifact | undefined> {
    const value = await this.options.store.get<SignatureArtifact>(`artifact:${canonicalHandle(handle)}`);
    if (!value) return undefined;
    validateAssessment(value.assessment);
    if (value.assessment.handle !== canonicalHandle(handle) || (value.assessment.provenance === "development-fixture") !== this.options.fixture) throw new Error("Artifact provenance mismatch.");
    if (value.renderHandle !== undefined && (preservedHandle(value.renderHandle) !== value.renderHandle || canonicalHandle(value.renderHandle) !== value.assessment.handle)) throw new Error("Artifact spelling does not match its identity.");
    if (value.assessment.xIdentity && value.renderHandle !== value.assessment.xIdentity.username) throw new Error("Artifact spelling does not match its verified X snapshot.");
    const { digest, ...unsigned } = value;
    if (digest !== artifactDigest(unsigned)) throw new Error("Corrupt artifact commitment.");
    for (const [hash, extension] of [[value.svgSha256, "svg"], [value.pngSha256, "png"], [value.metadataSha256, "json"]]) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid artifact hash.");
      const bytes = await this.asset(hash, extension);
      if (!bytes) throw new Error("Artifact bytes unavailable.");
    }
    if (!value.tokenURI.endsWith(`/artifacts/${value.metadataSha256}.json`)) throw new Error("Invalid metadata URI.");
    return value;
  }
  async #artifact(assessment: Assessment, renderHandle: string): Promise<SignatureArtifact> {
    const existing = await this.artifact(assessment.handle);
    if (existing) { if (existing.assessment.digest !== assessment.digest) throw new Error("Canonical artwork cannot be replaced."); return existing; }
    if ((assessment.provenance === "development-fixture") !== this.options.fixture) throw new Error("Wrong assessment mode.");
    if (!this.options.fixture && assessment.xIdentity?.provenance !== "x-api") throw new Error("Verified X preparation is required.");
    if (preservedHandle(renderHandle) !== renderHandle || canonicalHandle(renderHandle) !== assessment.handle) throw new Error("Invalid artwork spelling.");
    if (assessment.xIdentity && renderHandle !== assessment.xIdentity.username) throw new Error("Artwork must use the frozen X username.");
    const svg = assessment.rendererVersion === LEGACY_RENDERER_VERSION
      ? formalSignatureRenderer.render({ handle: renderHandle, gr0kRaw: assessment.seed, gr0kScale: 1, rendererVersion: assessment.rendererVersion }).svgUtf8
      : Buffer.from(renderSignatureSvg(renderHandle, assessment.mbti), "utf8");
    const png = await renderCardPng(svg);
    const svgSha256 = sha256Hex(svg), pngSha256 = sha256Hex(png);
    const metadata = Buffer.from(JSON.stringify({
      name: `@${renderHandle} · ${assessment.mbti}`,
      description: assessment.provenance === "development-fixture" ? "Development fixture: not a Grok assessment; local-chain token only." : "An artwork using Grok's inferred MBTI reading, not a psychological diagnosis or account-owner endorsement. Anyone may mint; no ownership of an X account is claimed.",
      image: `${this.options.origin}/artifacts/${pngSha256}.png`,
      animation_url: `${this.options.origin}/artifacts/${svgSha256}.svg`,
      external_url: `${this.options.origin}/signatures/${assessment.handle}`,
      attributes: [{ trait_type: "Handle", value: renderHandle }, { trait_type: "MBTI", value: assessment.mbti }],
      assessment, renderer: assessment.rendererVersion === LEGACY_RENDERER_VERSION
        ? { version: assessment.rendererVersion, handle: renderHandle, mappingVersion: assessment.mappingVersion, gr0k: assessment.seed, svgSha256, pngSha256 }
        : { version: assessment.rendererVersion, handle: renderHandle, mbti: assessment.mbti, svgSha256, pngSha256 },
    }));
    const metadataSha256 = sha256Hex(metadata);
    for (const [hash, extension, bytes] of [[svgSha256, "svg", svg], [pngSha256, "png", png], [metadataSha256, "json", metadata]] as const) {
      await this.options.store.put(`asset:${hash}`, { extension, base64: Buffer.from(bytes).toString("base64") });
    }
    const unsigned = { assessment, renderHandle, svgSha256, pngSha256, metadataSha256, tokenURI: `${this.options.origin}/artifacts/${metadataSha256}.json` };
    const artifact: SignatureArtifact = { ...unsigned, digest: artifactDigest(unsigned) };
    await this.options.store.put(`artifact:${assessment.handle}`, artifact);
    return artifact;
  }
  async asset(hash: string, extension: string): Promise<Buffer | undefined> {
    if (!/^[a-f0-9]{64}$/.test(hash) || !["svg", "png", "json"].includes(extension)) return undefined;
    const value = await this.options.store.get<{ extension: string; base64: string }>(`asset:${hash}`);
    if (!value || value.extension !== extension) return undefined;
    const bytes = Buffer.from(value.base64, "base64");
    if (sha256Hex(bytes) !== hash) throw new Error("Corrupt artifact bytes.");
    return bytes;
  }
  async state(handle: string): Promise<MintState> {
    if (!this.network) return { state: "unminted" };
    const state = await this.network.state(canonicalHandle(handle));
    if (state.state !== "unminted") {
      const artifact = await this.artifact(handle);
      if (!artifact || state.assessmentDigest !== artifact.assessment.digest || state.artifactDigest !== artifact.digest || state.tokenURIHash !== openMintTokenURIHash(artifact.tokenURI)) throw new Error("On-chain artifact commitment mismatch.");
    }
    return state;
  }
  async authorize(code: unknown, consent: unknown, session: SiteSession) {
    if (consent !== true) throw new PublicError(400, "CONSENT_REQUIRED", "Choose Mint & reveal to confirm that Grok chooses the final artwork and your wallet pays network gas.");
    const request = await this.ownedRequest(code, session);
    if (!await this.walletProved(request.code, session)) throw new PublicError(403, "WALLET_PROOF_REQUIRED", "Connect your wallet for this signature first.");
    if (!this.network) throw new PublicError(503, "MINT_UNAVAILABLE", "Minting is not configured yet.");
    return this.#locks.run(request.handle, async () => {
      // Recheck after lock/IO; logout or a changed challenge must never retain authorization.
      const current = await this.ownedRequest(code, session);
      if (!await this.walletProved(request.code, session) || current.status !== "ready") throw new PublicError(409, "NOT_READY", "Wait for the assessment and reconnect your wallet.");
      const recipient = session.wallet!;
      const generation = session.generation;
      const artifact = await this.artifact(request.handle);
      const assessment = await this.options.assessments?.get(request.handle);
      if (!artifact || !assessment || assessment.id !== current.assessmentId || artifact.assessment.digest !== assessment.digest) throw new Error("Trusted assessment is unavailable.");
      // Old records remain valid historical data; do not bless or replace their artwork.
      // Already signed vouchers cannot be revoked here, but this endpoint never issues
      // or re-signs an unverified real artifact, including after its old voucher expires.
      if (!this.options.fixture && assessment.xIdentity?.provenance !== "x-api") throw new PublicError(409, "X_VERIFICATION_REQUIRED", "This artwork predates X username verification. It is preserved, but cannot receive a new mint authorization. Contact support.");
      const chainTime = await this.network!.now();
      if (Math.abs(chainTime - nowSeconds(this.now)) > 60) throw new PublicError(503, "CHAIN_CLOCK", "The chain is not synchronized. Please try again shortly.");
      const state = await this.state(request.handle);
      if (state.state !== "unminted") throw new PublicError(409, "ALREADY_MINTED", "This handle has already been minted or is confirming.");
      const key = `issuance:${request.handle}`;
      let issuance = await this.options.store.get<Issuance>(key);
      if (issuance && BigInt(issuance.authorization.deadline) >= BigInt(chainTime)) {
        if (issuance.owner !== ownerKey(session) || issuance.code !== request.code || issuance.authorization.recipient !== recipient) throw new PublicError(409, "MINT_RESERVED", "A mint authorization for this handle is still active. Wait for its window to expire, then choose Continue mint.",
          { reservedUntil: new Date(Number(issuance.authorization.deadline) * 1000).toISOString(), category: "reservation", reference: request.attemptId });
      } else {
        const issuedAt = chainTime;
        const deadline = Math.min(Math.floor(request.expiresAt / 1000), issuedAt + 600);
        if (deadline <= issuedAt + 15) throw new PublicError(410, "REQUEST_EXPIRED", "Start a new request to get a fresh mint window.");
        issuance = { code: request.code, owner: ownerKey(session), handle: request.handle, tokenURI: artifact.tokenURI,
          authorization: { handleKey: handleDigest(request.handle), assessmentDigest: assessment.digest, artifactDigest: artifact.digest, recipient,
            tokenURIHash: openMintTokenURIHash(artifact.tokenURI), nonce: `0x${randomBytes(32).toString("hex")}`, issuedAt: String(issuedAt), deadline: String(deadline) } };
        // Persist the reservation BEFORE signing, including exact nonce and recipient.
        await this.options.store.put(key, issuance);
      }
      const a = normalizeOpenMintAuthorization(issuance.authorization);
      if (a.handleKey !== handleDigest(request.handle) || a.assessmentDigest !== assessment.digest || a.artifactDigest !== artifact.digest || a.tokenURIHash !== openMintTokenURIHash(artifact.tokenURI) || issuance.tokenURI !== artifact.tokenURI) throw new Error("Stored issuance commitment mismatch.");
      if (!await this.walletProved(request.code, session) || session.wallet !== recipient || session.generation !== generation) throw new PublicError(409, "WALLET_CHANGED", "Your wallet changed. Connect it again before continuing.");
      if (!issuance.signature) { issuance.signature = await this.network!.sign(a); await this.options.store.put(key, issuance); }
      const transaction = await this.network!.transaction(request.handle, a, artifact.tokenURI, issuance.signature);
      const network = await this.walletContext(recipient);
      if (network.nonce === undefined) throw new PublicError(503, "MINT_NETWORK_UNAVAILABLE", "The wallet nonce cannot be verified. No transaction was sent.");
      if (!await this.walletProved(request.code, session) || session.wallet !== recipient || session.generation !== generation) throw new PublicError(409, "WALLET_CHANGED", "Your wallet changed. Start a new request after this authorization expires.");
      return { code: request.code, handle: request.handle, tokenId: BigInt(a.handleKey).toString(), transaction: { ...transaction, nonce: network.nonce }, network, expiresAt: new Date(Number(a.deadline) * 1000).toISOString() };
    });
  }
  async report(code: unknown, transactionHash: unknown, session: SiteSession): Promise<void> {
    const request = await this.sessionRequest(code, session);
    if (typeof transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new PublicError(400, "INVALID_TRANSACTION", "Invalid transaction hash.");
    // A hash is only a hint. The UI and collection exclusively use verified chain state.
    await this.options.store.put(`hint:${request.code}`, { transactionHash: transactionHash.toLowerCase() });
  }
  async gallery(wallet?: Address): Promise<Array<{ artifact: SignatureArtifact; mint: MintState }>> {
    const result: Array<{ artifact: SignatureArtifact; mint: MintState }> = [];
    for (const [, value] of await this.options.store.entries<SignatureArtifact>("artifact:")) {
      const artifact = await this.artifact(value.assessment.handle);
      if (!artifact) continue;
      const mint = await this.state(artifact.assessment.handle);
      if (canRevealMint(mint.state) && (!wallet || mint.wallet?.toLowerCase() === wallet.toLowerCase())) result.push({ artifact, mint });
    }
    return result;
  }
}
