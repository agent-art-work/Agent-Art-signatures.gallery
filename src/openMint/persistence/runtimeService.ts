import { type GenerativeContractProfile } from "../generativeProfiles.js";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { OPEN_MINT_ABI, normalizeOpenMintAuthorization } from "../authorization.js";
import { canonicalHandle, handleDigest, preservedHandle } from "../identity.js";
import { preparePublicArtifact } from "../publicArtifacts.js";
import { publishPublicArtifact } from "../publicPublication.js";
import { isCode, PublicError } from "../security.js";
import { PostgresAssessmentWorker } from "./assessmentWorker.js";
import { PostgresAuthorizationIssuer, type ReservedAuthorizationSigner } from "./authorizations.js";
import { PostgresPublicationJournal } from "./publication.js";
import { PostgresMintRequests, type DurableMintRequest } from "./requests.js";
import { capabilityHash, PostgresWalletSessions, type DurableSiteSession } from "./sessions.js";
import type { Assessment } from "../assessment.js";
import { PostgresGenerativeInputJournal } from "./generativeInputs.js";
import { PostgresGenerativeAuthorizationIssuer, type IssuanceIntent, type ReservedAuthorizationSigner as GenerativeSigner } from "./generativeAuthorizations.js";
import { reservedWalletTransaction } from "./reservedTransaction.js";
import { LocalAdmissionRuntime } from "./localAdmissionRuntime.js";
import { type PostgresWalletSubmissions, type WalletMintPlan } from "./walletSubmissions.js";
import { readPublicChainEligibility } from "../publicChain.js";

export interface RuntimeIntent {
  readonly session: DurableSiteSession;
  readonly origin: string | undefined;
  readonly csrf: string | undefined;
}
export interface RuntimeEligibilityInput { readonly handle: string; readonly recipient: Address; readonly nonce: Hex; readonly pulseSlots?: readonly string[] }
type Publication = Pick<Parameters<typeof publishPublicArtifact>[0], "uploader" | "reader" | "timeoutMs">;
export interface DurableRuntimeOptions {
  readonly contractProfile?: "external-v1";
  readonly sessions: PostgresWalletSessions;
  readonly requests: PostgresMintRequests;
  readonly worker: PostgresAssessmentWorker;
  readonly journal: PostgresPublicationJournal;
  readonly issuer: PostgresAuthorizationIssuer;
  readonly signer: ReservedAuthorizationSigner;
  /** Must use the pinned backend chain gate; a serialized witness is rejected. */
  readonly eligibility: (input: RuntimeEligibilityInput, signal: AbortSignal) => Promise<unknown>;
  readonly eligibilityTimeoutMs: number;
  readonly publication: Publication;
}
interface GenerativeRuntimeBase extends Omit<DurableRuntimeOptions, "contractProfile" | "journal" | "issuer" | "signer" | "publication"> {
  readonly journal: PostgresGenerativeInputJournal;
  readonly issuer: PostgresGenerativeAuthorizationIssuer;
  readonly signer: GenerativeSigner;
  readonly admission?: LocalAdmissionRuntime;
}
export type GenerativeRuntimeOptions = GenerativeRuntimeBase &
  ({ readonly contractProfile: "generative-experimental-v1" } | { readonly contractProfile: "generative-v1-rc1" } | { readonly contractProfile: "generative-pulse-v1-rc1" });
interface MintTransaction { from: string; to: string; chainId: string; value: string; data: Hex }

function context(input: RuntimeIntent) {
  return { sessionToken: input.session.id, sessionGeneration: input.session.generation, origin: input.origin, csrf: input.csrf };
}
function proof(session: DurableSiteSession, now: number): boolean {
  return !!session.wallet && session.walletProof?.wallet === session.wallet && session.walletProof.expiresAt > now && session.expiresAt > now;
}
function parseHandle(value: unknown): string {
  try { return preservedHandle(value); }
  catch { throw new PublicError(400, "INVALID_HANDLE", "Enter a valid X handle."); }
}
function parseCode(value: unknown): string {
  if (!isCode(value)) throw new PublicError(404, "NOT_FOUND", "Signature request not found.");
  return value;
}

/** Integrates the durable components without activating public startup. Only
 * explicit POST intent starts work. There is no restart queue pump or retry.
 * One bounded preparation runs at a time; PostgreSQL owns the durable fences.
 */
export class DurableMintRuntime {
  readonly contractProfile: "external-v1" | GenerativeContractProfile;
  readonly sessions: PostgresWalletSessions;
  readonly requests: PostgresMintRequests;
  readonly #worker: PostgresAssessmentWorker;
  readonly #prepare: (assessment: Assessment) => Promise<void>;
  readonly #ready: (handle: string) => Promise<boolean>;
  readonly #preflightNonce: (input: Omit<IssuanceIntent, "eligibility">) => Promise<Hex>;
  readonly #issue: (input: IssuanceIntent) => Promise<{ version?: "sg-pulse-wallet-plan-v1-rc1"; expiresAt: string; transaction: MintTransaction }>;
  readonly #admission?: LocalAdmissionRuntime;
  readonly #generativeIssuer?: PostgresGenerativeAuthorizationIssuer;
  readonly #eligibility: DurableRuntimeOptions["eligibility"];
  readonly #eligibilityTimeoutMs: number;
  readonly #tasks = new Map<string, Promise<void>>();
  #creating = false;
  #draining = false;
  constructor(options: DurableRuntimeOptions | GenerativeRuntimeOptions) {
    this.contractProfile = options.contractProfile ?? "external-v1";
    const { sessions, requests, worker, journal, issuer, signer } = options, { repository } = requests;
    if (repository.namespace.profile !== "local-real" || repository.namespace.provenance !== "grok" || requests.profile.chain_id !== "31337"
      || sessions.writer !== repository.writer || sessions.namespaceId !== repository.namespace.id || sessions.origin !== requests.profile.origin
      || String(sessions.chainId) !== requests.profile.chain_id || worker.requests !== requests || issuer.requests !== requests
      || issuer.journal !== journal || journal.writer !== repository.writer || journal.namespaceId !== repository.namespace.id
      || ((options.contractProfile === "generative-experimental-v1" || options.contractProfile === "generative-v1-rc1" || options.contractProfile === "generative-pulse-v1-rc1") ? options.journal.deploymentId !== requests.profile.deployment_id : options.journal.origin !== sessions.origin)
      || getAddress(signer.address) !== getAddress(requests.profile.authorizer)) {
      throw new Error("Durable HTTP integration requires matching isolated local components; public startup remains disabled.");
    }
    if (!Number.isSafeInteger(options.eligibilityTimeoutMs) || options.eligibilityTimeoutMs < 1 || options.eligibilityTimeoutMs > 30000) throw new Error("Invalid eligibility deadline.");
    this.sessions = sessions; this.requests = requests; this.#worker = worker;
    const admission = "admission" in options ? options.admission : undefined;
    if (worker.admission !== admission || (admission && (!(admission instanceof LocalAdmissionRuntime) || admission.requests !== requests
      || options.contractProfile !== "generative-v1-rc1"))) throw new Error("Explicit matching RC1 admission is required; no unguarded fallback.");
    this.#admission = admission;
    this.#preflightNonce = issuer.preflightNonce.bind(issuer);
    this.#eligibility = options.eligibility; this.#eligibilityTimeoutMs = options.eligibilityTimeoutMs;
    if ((options.contractProfile === "generative-experimental-v1" || options.contractProfile === "generative-v1-rc1" || options.contractProfile === "generative-pulse-v1-rc1")) {
      const { journal, issuer, signer } = options, signing = Object.freeze({ address: signer.address, signTypedData: signer.signTypedData.bind(signer) });
      if (!(journal instanceof PostgresGenerativeInputJournal) || !(issuer instanceof PostgresGenerativeAuthorizationIssuer) || journal.profile.contractProfile !== options.contractProfile) throw new Error("Explicit generative components required.");
      this.#generativeIssuer = issuer;
      this.#ready = async handle => !!await journal.load(handle);
      this.#prepare = async assessment => { await journal.stage(assessment); };
      this.#issue = async input => {
        const { reservation: r, signature } = await (admission ? admission.issue(issuer, input, signing) : issuer.issue(input, signing));
        this.#available();
        const saved = await journal.load(r.handle);
        if (!saved) throw new Error("Generative inputs unavailable.");
        const a = r.authorization;
        const transaction = reservedWalletTransaction(r, signature);
        this.#available();
        return { ...(requests.pulse ? { version: "sg-pulse-wallet-plan-v1-rc1" as const } : {}), expiresAt: new Date(Number(a.deadline) * 1000).toISOString(), transaction };
      };
    } else {
      const { journal, issuer, signer } = options, signing = Object.freeze({ address: signer.address, signTypedData: signer.signTypedData.bind(signer) });
      const { uploader, reader, timeoutMs } = options.publication;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("Invalid publication deadline.");
      const publication = Object.freeze({ timeoutMs, uploader: Object.freeze({ id: uploader.id, upload: uploader.upload.bind(uploader) }),
        reader: Object.freeze({ id: reader.id, retrieve: reader.retrieve.bind(reader) }) });
      this.#ready = async handle => !!await journal.load(handle, true);
      this.#prepare = async assessment => {
        const artifact = await journal.load(assessment.handle) ?? await preparePublicArtifact({ assessment, origin: sessions.origin });
        this.#available();
        if (!await journal.load(assessment.handle, true)) await publishPublicArtifact({ ...publication, artifact, journal });
      };
      this.#issue = async input => {
        const { reservation: r, signature } = await issuer.issue(input, signing); this.#available();
        const a = normalizeOpenMintAuthorization(r.authorization);
        return { expiresAt: new Date(Number(a.deadline) * 1000).toISOString(), transaction: { from: a.recipient, to: r.domain.verifyingContract,
          chainId: `0x${BigInt(r.domain.chainId).toString(16)}`, value: "0x0", data: encodeFunctionData({ abi: OPEN_MINT_ABI,
            functionName: "mint", args: [r.handle, a, r.tokenURI, signature] }) } };
      };
    }
  }
  #available(): void {
    if (this.#draining) throw new PublicError(503, "SERVICE_DRAINING", "The service is restarting. Saved work is preserved.");
    this.requests.repository.writer.assertHealthy();
  }
  async #observe(input: RuntimeEligibilityInput): Promise<unknown> {
    this.#available();
    const controller = new AbortController(), end = performance.now() + this.#eligibilityTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      this.#available();
      if (controller.signal.aborted || performance.now() >= end) throw new Error("Eligibility deadline exceeded.");
    };
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Eligibility timed out.")); }, this.#eligibilityTimeoutMs); });
      const witness = await Promise.race([Promise.resolve().then(() => { check(); return this.#eligibility(Object.freeze({ ...input,
        ...(this.requests.pulse ? {pulseSlots:Object.freeze(this.requests.pulse.slotIds(input.recipient))} : {}) }), controller.signal); }), timeout]);
      check(); return witness;
    } catch {
      throw new PublicError(503, "CHAIN_UNAVAILABLE", "Mint eligibility cannot be verified right now. No new assessment or signature was requested.");
    } finally { clearTimeout(timer); controller.abort(); }
  }
  sessionView(session: DurableSiteSession) {
    return { csrfToken: session.csrf, wallet: session.wallet ?? null,
      walletVerified: proof(session, Date.now()) && !session.walletProof?.codeHash,
      walletProofExpiresAt: session.walletProof?.expiresAt, serverNow: Date.now(), chainId: this.requests.profile.chain_id, chainName: "Local Anvil" };
  }
  /** Private read-only quote. No admission, provider, signer or reservation. */
  async mintOptions(value: unknown, session: DurableSiteSession) {
    if(!this.requests.pulse) throw new PublicError(404,"NOT_FOUND","Mint options are unavailable.");
    const handle=canonicalHandle(parseHandle(value));
    if(!proof(session,Date.now()) || session.walletProof?.codeHash) throw new PublicError(403,"WALLET_PROOF_REQUIRED","Connect and verify your wallet first.");
    const witness=await this.#observe({handle,recipient:session.wallet!,nonce:`0x${randomBytes(32).toString("hex")}`});
    const e=readPublicChainEligibility(witness,{namespaceId:this.requests.repository.namespace.id,deploymentId:this.requests.profile.deployment_id,handle,recipient:session.wallet!,now:Date.now()});
    if(!e.pulse) throw new PublicError(503,"CHAIN_UNAVAILABLE","Pulse options could not be verified.");
    const occupied=await this.requests.repository.writer.transaction(async tx => (await tx.query<{slot_id:string}>("SELECT slot_id::text FROM open_mint.pulse_slot_heads WHERE namespace_id=$1 AND deployment_id=$2",[this.requests.repository.namespace.id,this.requests.profile.deployment_id])).rows.map(r => r.slot_id));
    // Local expiry can withdraw a free offer, but cannot manufacture a paid
    // quote from the old free block's zero-price placeholder.
    if(e.pulse.phase === 0 && BigInt(Date.now()) >= BigInt(e.pulse.deployment.freeDeadline)*1000n)
      throw new PublicError(503,"CHAIN_UNAVAILABLE","The free window ended. Wait for a fresh on-chain paid quote, then check mint options again.");
    const free=e.pulse.phase === 0;
    return {version:"sg-pulse-mint-options-v1",handle,wallet:session.wallet,phase:free ? "free" : "paid",priceWei:e.pulse.price,
      availableSlots:free ? e.pulse.slots.filter(s => !s.claimed && !occupied.includes(s.slotId)).map(s => s.slotId) : [],
      saleConfigHash:e.pulse.deployment.saleConfigHash,validUntil:e.validUntil};
  }
  async create(value: unknown, intent: RuntimeIntent, mintIntent?: unknown) {
    const handle = parseHandle(value), canonical = canonicalHandle(handle), captured = context(intent);
    this.#available();
    if (!proof(intent.session, Date.now()) || intent.session.walletProof?.codeHash) throw new PublicError(403, "WALLET_PROOF_REQUIRED", "Connect your wallet before preparing a mint.");
    if (this.#creating || (this.#tasks.size > 0 && !this.#tasks.has(canonical))) throw new PublicError(429, "BUSY", "Another preparation is in progress. Please wait.");
    this.#creating = true;
    try {
      const witness = await this.#observe({ handle: canonical, recipient: intent.session.wallet!, nonce: `0x${randomBytes(32).toString("hex")}` });
      const request = await this.requests.create({ ...captured, recipient: intent.session.wallet!, handle, eligibility: witness, mintIntent });
      this.#available();
      if (!this.#tasks.has(canonical) && ["pending-assessment", "assessment-accepted"].includes(request.status)) {
        const task = Promise.resolve().then(async () => {
          this.#available();
          const result = await this.#worker.run({ ...captured, code: request.code, eligibility: witness });
          if (result.kind !== "accepted") return;
          this.#available();
          await this.#prepare(result.assessment);
        }).catch(() => {
          // The durable attempt/receipt/publication/reservation records own the
          // outcome. Do not log provider bodies or fabricate completion/retry.
        }).finally(() => { this.#tasks.delete(canonical); });
        this.#tasks.set(canonical, task);
      }
      return { code: request.code, handle: request.handle, tokenId: BigInt(handleDigest(request.handle)).toString(),
        url: `/mint/${request.code}`, status: "preparing" as const };
    } finally { this.#creating = false; }
  }
  async status(code: unknown, session: DurableSiteSession) {
    const request = await this.requests.get(parseCode(code), session.id), now = Date.now();
    const pulseIntent = this.requests.pulse ? await this.requests.repository.writer.transaction(tx => this.requests.pulse!.load(tx, request.id)) : undefined;
    const complete = request.status === "assessment-accepted" && await this.#ready(request.handle);
    const active = this.#tasks.has(request.handle);
    const failed = !complete && (!active || !["pending-assessment", "assessment-accepted"].includes(request.status));
    // Explicit allowlist: never expose accepted MBTI, assessment, receipts,
    // publication URI, signer output or wallet capability before reveal.
    return { code: request.code, handle: request.handle, renderHandle: request.requestedHandle,
      tokenId: BigInt(handleDigest(request.handle)).toString(), requestExpiresAt: request.expiresAt, requestExpired: request.expiresAt <= now,
      status: complete ? "ready" : request.status === "assessment-abstained" ? "abstained" : failed ? "failed" : "preparing",
      canMint: complete && request.expiresAt > now && proof(session, now)
        && (!session.walletProof?.codeHash || session.walletProof.codeHash === capabilityHash(request.code)),
      preparationActive: active, diagnosticReference: request.attemptId,
      ...(pulseIntent ? { pulseMaxPriceWei: pulseIntent.maxPrice } : {}),
      ...(failed ? { error: request.status === "assessment-abstained" ? "Grok could not assess this handle from the available evidence."
        : "This preparation needs operator review. No assessment will be retried automatically." } : {}), serverNow: now };
  }
  async authorize(value: unknown, consent: unknown, intent: RuntimeIntent) {
    this.#available();
    if (consent !== true) throw new PublicError(400, "CONSENT_REQUIRED", "Choose Mint & reveal to continue.");
    const code = parseCode(value), captured = { ...context(intent), code, consent: true };
    const request: DurableMintRequest = await this.requests.get(code, intent.session.id);
    const nonce = await this.#preflightNonce(captured);
    const eligibility = await this.#observe({ handle: request.handle, recipient: request.wallet, nonce });
    const issued = await this.#issue({ ...captured, eligibility });
    this.#available();
    return { code, handle: request.handle, tokenId: BigInt(handleDigest(request.handle)).toString(), ...issued };
  }
  /** Private browser dispatch: the guarded runtime cannot fall through to the
   * legacy begin path. The released permit is not a transaction broadcast. */
  async beginSubmission(submissions: PostgresWalletSubmissions, code: string, intent: RuntimeIntent, plan: WalletMintPlan, signal: AbortSignal) {
    this.#available(); signal.throwIfAborted();
    if (submissions.requests !== this.requests) throw new Error("Wallet runtime mismatch.");
    if (!this.#admission && !this.requests.pulse) return submissions.begin(code, intent, plan);
    const captured = { ...context(intent), code, consent: true }, request = await this.requests.get(code, intent.session.id);
    const nonce = await this.#preflightNonce(captured), eligibility = await this.#observe({ handle: request.handle, recipient: request.wallet, nonce });
    this.#available(); signal.throwIfAborted();
    if (this.requests.pulse) return submissions.beginPulse(this.#generativeIssuer!, { ...captured, eligibility }, intent, plan);
    return this.#admission!.submit(submissions, this.#generativeIssuer!, { ...captured, eligibility }, intent, plan, signal);
  }
  /** Stop accepting new work. Never reschedule jobs after drain/restart. The
   * owner must close the writer after this resolves, not underneath a task. */
  async drain(): Promise<void> { this.#draining = true; this.#admission?.halt(); await Promise.all([...this.#tasks.values()]); }
  /** Observation for local tests/controlled shutdown, not an HTTP operation. */
  async idle(): Promise<void> { await Promise.all([...this.#tasks.values()]); }
}
