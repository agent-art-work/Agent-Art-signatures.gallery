import { timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { getAddress, type Address } from "viem";
import { AssessmentCoordinator, type Assessment, type AssessmentProvider } from "../assessment.js";
import type { AssessmentExecution, ProviderLeg } from "../assessmentOperations.js";
import { ProviderResponseInvalidError } from "../grok.js";
import { readPublicChainEligibility, type PublicChainEvidence } from "../publicChain.js";
import { isCode } from "../security.js";
import { XIdentityResponseInvalidError, type XIdentityResolver } from "../xIdentity.js";
import { PostgresMintRequests } from "./requests.js";
import { capabilityHash } from "./sessions.js";
import { type AssessmentTerminal, type TerminalOutcome } from "./repository.js";
import { PersistenceConflictError, type OwnershipConnection } from "./writer.js";

type Transaction = Pick<OwnershipConnection, "query">;
export interface AssessmentWorkerIntent {
  readonly code: string; readonly sessionToken: string; readonly sessionGeneration: string;
  readonly origin: string | undefined; readonly csrf: string | undefined;
  /** Fresh backend gate witness for this explicit claim, not browser JSON. */
  readonly eligibility: unknown;
}
export interface AssessmentPreflight {
  readonly namespaceId: string; readonly deploymentId: string; readonly handle: string;
  readonly recipient: Address; readonly leg: ProviderLeg;
}
export type AssessmentWorkerResult = { readonly kind: "accepted"; readonly assessment: Assessment; readonly reused: boolean }
  | { readonly kind: "terminal"; readonly outcome: AssessmentTerminal };
/** Trusted composition, not a browser-selected callback or approval. */
export interface WorkerAdmission {
  readonly requests: PostgresMintRequests;
  reuse(input: AssessmentWorkerIntent, signal: AbortSignal): Promise<Assessment>;
  dispatch<T>(input: AssessmentWorkerIntent, leg: ProviderLeg, model: string, signal: AbortSignal,
    effect: (dispatch: NonNullable<AssessmentExecution["dispatch"]>) => Promise<T>): Promise<T>;
  /** Optional for historical local callers; mandatory for staging. Database-
   * only check inside the writer transaction, before AND after initial claim. */
  validateClaim?(tx: Transaction, model: string, signal: AbortSignal): Promise<void>;
}
export class AssessmentWorkerBlockedError extends Error {
  constructor(readonly code: string) { super(code); this.name = "AssessmentWorkerBlockedError"; }
}
export class AssessmentWorkerDeadlineError extends Error {
  constructor() { super("Assessment execution deadline exceeded; no late dispatch or result is accepted."); this.name = "AssessmentWorkerDeadlineError"; }
}
export class AssessmentWorkerCancelledError extends Error {
  constructor() { super("Assessment execution cancelled; no late dispatch or result is accepted."); this.name = "AssessmentWorkerCancelledError"; }
}
export interface AssessmentWorkerOptions {
  timeoutMs: number;
  provider?: AssessmentProvider; identityResolver?: XIdentityResolver;
  refreshEligibility?: (input: AssessmentPreflight, signal: AbortSignal) => Promise<unknown>;
  admission?: WorkerAdmission;
}
interface Captured extends AssessmentWorkerIntent { sessionHash: string; codeHash: string }
interface Session {
  generation: string; wallet: string | null; csrf: string; revoked: boolean; expires_at: Date;
  proof_wallet: string | null; proof_code_hash: string | null; proof_expires_at: Date | null; active_challenge_hash: string | null;
}
interface Request { request_id: string; handle: string; wallet: string; expires_at: Date; attempt_id: string | null; assessment_id: string | null }
const blocked = (code: string): never => { throw new AssessmentWorkerBlockedError(code); };
const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

/** Explicit local backend execution of an already admitted private request.
 * No handle admission, retry, scheduled queue pump, signer or public route exists.
 * Injected generation transports must implement their own bounded request and
 * receipt protocol; they are server-owned, never request-selected callbacks.
 */
class AssessmentWorkerCore {
  readonly #provider?: AssessmentProvider;
  readonly #resolver?: XIdentityResolver;
  readonly #refresh?: (input: AssessmentPreflight, signal: AbortSignal) => Promise<unknown>;
  readonly #timeoutMs: number;
  readonly admission?: WorkerAdmission;
  constructor(readonly requests: PostgresMintRequests, input: AssessmentWorkerOptions) {
    const namespace = requests.repository.namespace;
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 180000) blocked("INVALID_EXECUTION_DEADLINE");
    this.#timeoutMs = input.timeoutMs;
    if (input.admission && input.admission.requests !== requests) blocked("ADMISSION_PROFILE_MISMATCH");
    // RC1 admission controllers do not implement Pulse sponsorship fences.
    // Refuse composition rather than let their dispatch path bypass those gates.
    if (requests.pulse && input.admission) blocked("PULSE_ADMISSION_NOT_SUPPORTED");
    // Local runtime uses this object's identity to reject crossed admission
    // instances. The separate staging composition supplies a frozen controller.
    this.admission = input.admission;
    const provider = input.provider, resolver = input.identityResolver;
    if (provider) this.#provider = Object.freeze({ provenance: provider.provenance, model: provider.model, assess: provider.assess.bind(provider) });
    if (resolver) this.#resolver = Object.freeze({ provenance: resolver.provenance, resolve: resolver.resolve.bind(resolver) });
    this.#refresh = input.refreshEligibility;
    if ((provider && provider.provenance !== namespace.provenance)
      || (resolver && (resolver.provenance === "development-fixture") !== (namespace.provenance === "development-fixture"))) blocked("PROVIDER_PROFILE_MISMATCH");
  }
  async #context(tx: Transaction, input: Captured): Promise<{ request: Request; now: number; validUntil: number }> {
    const namespace = this.requests.repository.namespace.id;
    const now = (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.getTime();
    const session = (await tx.query<Session>("SELECT *, generation::text FROM open_mint.sessions WHERE namespace_id=$1 AND session_hash=$2 FOR UPDATE", [namespace, input.sessionHash])).rows[0];
    if (!session || session.revoked || session.expires_at.getTime() <= now || input.origin !== this.requests.profile.origin
      || !isCode(input.csrf) || !timingSafeEqual(Buffer.from(input.csrf), Buffer.from(session.csrf))) blocked("SESSION_REQUIRED");
    const request = (await tx.query<Request>("SELECT request_id,handle,wallet,expires_at,attempt_id,assessment_id FROM open_mint.requests WHERE namespace_id=$1 AND deployment_id=$2 AND code_hash=$3 AND session_hash=$4",
      [namespace, this.requests.profile.deployment_id, input.codeHash, input.sessionHash])).rows[0];
    if (!request) blocked("NOT_FOUND");
    if (request.expires_at.getTime() <= now) blocked("REQUEST_EXPIRED");
    if (session.generation !== input.sessionGeneration || session.wallet !== request.wallet) blocked("WALLET_CHANGED");
    if (session.proof_wallet !== request.wallet || !session.proof_expires_at || session.proof_expires_at.getTime() <= now || session.active_challenge_hash
      || (session.proof_code_hash !== null && session.proof_code_hash !== input.codeHash)) blocked("WALLET_PROOF_REQUIRED");
    return { request, now, validUntil: Math.min(request.expires_at.getTime(), session.expires_at.getTime(), session.proof_expires_at!.getTime()) };
  }
  #chain(witness: unknown, request: Request, now: number): PublicChainEvidence {
    const p = this.requests.profile;
    let evidence;
    try { evidence = readPublicChainEligibility(witness, { namespaceId: this.requests.repository.namespace.id,
      deploymentId: p.deployment_id, handle: request.handle, recipient: request.wallet, now }); }
    catch { return blocked("CHAIN_UNAVAILABLE"); }
    if (evidence.chainId.toString() !== p.chain_id || evidence.contract.toLowerCase() !== p.contract_address
      || evidence.genesisHash !== p.genesis_hash || evidence.runtimeCodeHash !== p.runtime_code_hash
      || evidence.authorizer.toLowerCase() !== p.authorizer || evidence.deploymentBlock.number.toString() !== p.deployment_block
      || evidence.deploymentBlock.hash !== p.deployment_block_hash) blocked("CHAIN_PROFILE_MISMATCH");
    if ((evidence.contractProfile === "generative-pulse-v1-rc1") !== !!this.requests.pulse) blocked("CHAIN_PROFILE_MISMATCH");
    const blockTime = Number(evidence.block.timestamp) * 1000;
    if (now - evidence.observedAt >= p.max_evidence_age_ms || now - blockTime >= p.max_block_age_ms
      || blockTime - now > p.max_future_skew_ms) blocked("CHAIN_UNAVAILABLE");
    return evidence;
  }
  /** Internal database-only adapter boundary. Reuses the worker's actual
   * session/proof/request/chain checks; not an HTTP or paid execution method.
   * Caller must use this worker's repository execution transaction. */
  async admissionContext(tx: Transaction, value: AssessmentWorkerIntent): Promise<{ request: Request; now: number; validUntil: number; evidence: PublicChainEvidence }> {
    const input: Captured = { code: value.code, sessionToken: value.sessionToken, sessionGeneration: value.sessionGeneration,
      origin: value.origin, csrf: value.csrf, eligibility: value.eligibility, codeHash: capabilityHash(value.code), sessionHash: capabilityHash(value.sessionToken) };
    if (!/^(0|[1-9][0-9]{0,18})$/.test(input.sessionGeneration)) blocked("WALLET_CHANGED");
    const context = await this.#context(tx, input), evidence = this.#chain(value.eligibility, context.request, context.now);
    return { ...context, evidence, validUntil: Math.min(context.validUntil, evidence.validUntil,
      evidence.observedAt + this.requests.profile.max_evidence_age_ms, Number(evidence.block.timestamp) * 1000 + this.requests.profile.max_block_age_ms) };
  }
  async run(value: AssessmentWorkerIntent, signal = new AbortController().signal): Promise<AssessmentWorkerResult> {
    const input: Captured = { code: value.code, sessionToken: value.sessionToken, sessionGeneration: value.sessionGeneration,
      origin: value.origin, csrf: value.csrf, eligibility: value.eligibility, codeHash: capabilityHash(value.code), sessionHash: capabilityHash(value.sessionToken) };
    if (!/^(0|[1-9][0-9]{0,18})$/.test(input.sessionGeneration)) blocked("WALLET_CHANGED");
    const repository = this.requests.repository, writer = repository.writer;
    const started = performance.now(), controller = new AbortController();
    let active = true, timedOut = false, cancelled = false, storageFailed = false, ownedAttempt: string | undefined;
    let pendingClaim: Promise<{ request: Request; accepted: Assessment | undefined }> | undefined;
    const expire = () => { active = false; timedOut = true; controller.abort(); };
    const assertActive = () => {
      if (performance.now() - started >= this.#timeoutMs) expire();
      if (!active) { if (cancelled) throw new AssessmentWorkerCancelledError(); if (timedOut) throw new AssessmentWorkerDeadlineError(); blocked("EXECUTION_FINISHED"); }
      writer.assertHealthy();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expire(); reject(new AssessmentWorkerDeadlineError()); }, this.#timeoutMs);
      cancel = () => { active = false; cancelled = true; controller.abort(); reject(new AssessmentWorkerCancelledError()); };
      signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
    });
    const work = async (): Promise<AssessmentWorkerResult> => {
    pendingClaim = repository.executionTransaction(async (tx, execution) => {
      assertActive();
      const { request, now } = await this.#context(tx, input);
      const initialEvidence = this.#chain(input.eligibility, request, now);
      await this.requests.pulse?.check(tx, request.request_id, initialEvidence, now);
      const accepted = await execution.getAssessment(request.handle);
      if (accepted) {
        if ((request.assessment_id !== null && request.assessment_id !== accepted.id)
          || (repository.namespace.provenance === "grok" && accepted.xIdentity?.provenance !== "x-api")) throw new PersistenceConflictError("Accepted request assessment mismatch.");
      } else {
        if (!request.attempt_id || request.assessment_id !== null) throw new PersistenceConflictError("Request has no admitted initial attempt.");
        if (!this.#provider || !this.#resolver || !this.#refresh) blocked("GENERATION_NOT_CONFIGURED");
        await this.admission?.validateClaim?.(tx, this.#provider!.model, controller.signal); assertActive();
        await execution.claimInitial(request.attempt_id, { handle: request.handle, model: this.#provider!.model });
        await this.admission?.validateClaim?.(tx, this.#provider!.model, controller.signal); assertActive();
      }
      const end = await this.#context(tx, input); this.#chain(input.eligibility, end.request, end.now);
      assertActive();
      return { request, accepted };
    }).then(claim => {
      // Record ownership only after COMMIT acknowledgment. Timeout cleanup waits
      // for this bounded claim promise; it cannot close another concurrent run.
      if (!claim.accepted) ownedAttempt = claim.request.attempt_id!;
      return claim;
    });
    const claim = await pendingClaim; assertActive();
    if (claim.accepted) return { kind: "accepted", assessment: this.admission ? await this.admission.reuse(input, controller.signal) : claim.accepted, reused: true };
    const request = claim.request, id = request.attempt_id!;
    let leg: ProviderLeg | undefined, terminal: AssessmentTerminal | undefined, accepted: Assessment | undefined, semanticFailure = false;
    let preparedLeg: { leg: ProviderLeg; input: AssessmentWorkerIntent } | undefined;
    const progress: { stage: "claimed" | "identity-returned" | "identity-verified" | "provider-returned" | "accepted" } = { stage: "claimed" };
    const persist = async <T>(work: () => Promise<T>): Promise<T> => {
      assertActive();
      try { return await work(); } catch (error) { if (!(error instanceof AssessmentWorkerDeadlineError)) storageFailed = true; throw error; }
    };
    const execution: AssessmentExecution = {
      attemptId: id,
      beforeDispatch: async next => {
        assertActive();
        const witness = await this.#refresh!(Object.freeze({ namespaceId: repository.namespace.id, deploymentId: this.requests.profile.deployment_id,
          handle: request.handle, recipient: getAddress(request.wallet), leg: next }), controller.signal);
        assertActive();
        if (this.admission) {
          // The gate must encompass the actual provider call, not return a
          // checkpoint from a completed (and therefore expired) gate execution.
          preparedLeg = { leg: next, input: { ...input, eligibility: witness } };
          return;
        }
        await repository.executionTransaction(async (tx, operations) => {
          assertActive();
          const context = await this.#context(tx, input), evidence = this.#chain(witness, context.request, context.now);
          if (context.request.request_id !== request.request_id || context.request.attempt_id !== id) throw new PersistenceConflictError("Worker request binding changed.");
          await this.requests.pulse?.check(tx, request.request_id, evidence, context.now, next, id);
          await operations.beforeDispatch(id, next, this.#provider!.model);
          const end = await this.#context(tx, input), finalEvidence = this.#chain(witness, end.request, end.now);
          await this.requests.pulse?.check(tx, request.request_id, finalEvidence, end.now);
          assertActive();
        });
        leg = next;
      },
      recordReceipt: receipt => persist(() => repository.recordReceipt(id, json(receipt), assertActive)),
      identityVerified: async identity => { await persist(() => repository.recordIdentity(id, json(identity), assertActive)); progress.stage = "identity-verified"; },
      recordOutcome: async outcome => {
        assertActive();
        if (outcome.kind === "accepted") { progress.stage = "accepted"; return; }
        terminal = await persist(() => repository.finishAttempt(id, outcome, assertActive));
      },
      assessmentPersisted: async assessment => { assertActive(); if (accepted?.digest !== assessment.digest) throw new PersistenceConflictError("Worker accepted linkage mismatch."); },
    };
    const dispatch = async <T>(next: ProviderLeg, call: (execution: AssessmentExecution) => Promise<T>): Promise<T> => {
      assertActive();
      if (!this.admission) { if (leg !== next) blocked("DISPATCH_REQUIRED"); return call(execution); }
      const prepared = preparedLeg; preparedLeg = undefined;
      if (!prepared || prepared.leg !== next) blocked("DISPATCH_REQUIRED");
      return this.admission.dispatch(prepared!.input, next, this.#provider!.model, controller.signal, checkpoint => {
        // Called only after the gate acknowledged the durable leg fence.
        assertActive(); leg = next;
        return call({ ...execution, dispatch: checkpoint }).catch(error => {
          // Admission sanitizes thrown errors. Retain only this boolean, not a
          // provider body/secret, for terminal classification after its guard.
          semanticFailure = error instanceof ProviderResponseInvalidError || error instanceof XIdentityResponseInvalidError;
          throw error;
        });
      });
    };
    // A fresh coordinator has no cross-run identity/result cache or unsaved retry.
    const coordinator = new AssessmentCoordinator({ expectedProvenance: repository.namespace.provenance,
      provider: { provenance: this.#provider!.provenance, model: this.#provider!.model, assess: async (...args) => {
        const result = await dispatch("grok", e => this.#provider!.assess(args[0], args[1], e)); progress.stage = "provider-returned"; return result;
      } },
      identityResolver: { provenance: this.#resolver!.provenance, resolve: async (...args) => {
        const result = await dispatch("x-identity", e => this.#resolver!.resolve(args[0], e)); progress.stage = "identity-returned"; return result;
      } },
      repository: { get: handle => repository.getAssessment(handle), putIfAbsent: async assessment => {
        accepted = await persist(() => repository.acceptAssessment(id, json(assessment), assertActive)); return accepted;
      } },
    });
    try {
      const result = await coordinator.assess(request.handle, execution);
      await writer.transaction(async tx => { assertActive(); await this.#context(tx, input); assertActive(); });
      return { kind: "accepted", assessment: result, reused: false };
    } catch (error) {
      if (timedOut || cancelled) throw error;
      if (terminal) return { kind: "terminal", outcome: terminal };
      // Lost receipt/outcome/result acknowledgment preserves claimed uncertainty;
      // never overwrite a validated abstention or a possibly accepted result.
      if (storageFailed || accepted) throw error;
      writer.assertHealthy();
      let outcome: TerminalOutcome | undefined;
      if (leg && (semanticFailure || error instanceof ProviderResponseInvalidError || error instanceof XIdentityResponseInvalidError
        || progress.stage === "identity-returned" || progress.stage === "provider-returned")) {
        const receipt = await repository.getReceipt(id, leg);
        if (receipt?.category === "success" && (receipt.httpStatus === undefined || (receipt.httpStatus >= 200 && receipt.httpStatus < 300))) outcome = { kind: "invalid" };
      }
      // A fence can commit even if admission refuses before entering the
      // callback. Classify interruption from durable fences, not `leg` memory.
      terminal = outcome ? await repository.finishAttempt(id, outcome, assertActive) : await repository.interruptAttempt(id);
      if (!terminal) throw error;
      return { kind: "terminal", outcome: terminal };
    }
    };
    try { return await Promise.race([work(), deadline]); }
    catch (error) {
      if (!(timedOut || cancelled) || storageFailed) throw error;
      // Claim is database-only and bounded by owner statement/lock timeouts. A
      // lost acknowledgment makes the writer unhealthy, not a new execution.
      try { await pendingClaim; } catch (claimError) { if (!(claimError instanceof AssessmentWorkerDeadlineError || claimError instanceof AssessmentWorkerCancelledError)) throw claimError; }
      writer.assertHealthy();
      if (ownedAttempt) {
        const outcome = await repository.interruptAttempt(ownedAttempt);
        if (outcome) return { kind: "terminal", outcome };
      }
      if (cancelled) throw new AssessmentWorkerCancelledError();
      throw new AssessmentWorkerDeadlineError();
    } finally { active = false; clearTimeout(timer); signal.removeEventListener("abort", cancel); controller.abort(); }
  }
}

/** Historical/local constructor remains closed to public profiles. */
export class PostgresAssessmentWorker extends AssessmentWorkerCore {
  constructor(requests: PostgresMintRequests, input: AssessmentWorkerOptions) {
    if (!["local-fixture", "local-real"].includes(requests.repository.namespace.profile)) blocked("PUBLIC_WORKER_DISABLED");
    super(requests, input);
  }
}

/** Internal staging port; use only through the release-aware composition in
 * generative-staging-worker.mjs. Mandatory guards are trusted application code,
 * not a defense against code already controlling this process. No activation. */
export function createGuardedStagingWorker(requests: PostgresMintRequests, input: AssessmentWorkerOptions): Pick<AssessmentWorkerCore, "run"> {
  const ns = requests.repository.namespace, p = requests.profile;
  if (ns.profile !== "staging-testnet" || ns.provenance !== "grok" || p.chain_id !== "11155111" || p.session_chain_id !== "11155111"
    || p.origin !== "https://staging.signatures.gallery" || !input.admission || input.admission.requests !== requests
    || typeof input.admission.validateClaim !== "function" || typeof input.admission.dispatch !== "function" || typeof input.admission.reuse !== "function") blocked("STAGING_WORKER_GUARDS_REQUIRED");
  const worker = new AssessmentWorkerCore(requests, input);
  return Object.freeze({ run: worker.run.bind(worker) });
}
