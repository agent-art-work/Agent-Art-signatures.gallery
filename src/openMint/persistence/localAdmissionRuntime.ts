import { type AssessmentExecution, type ProviderLeg } from "../assessmentOperations.js";
import { readPublicChainEligibility } from "../publicChain.js";
import { ADMISSION_OPERATIONS, admissionDigest, createAdmissionGate, type AdmissionPorts, type AdmissionScope } from "../staging/admission.js";
import { type AssessmentWorkerIntent, type WorkerAdmission } from "./assessmentWorker.js";
import { prepareLocalAssessmentAdmission } from "./assessmentAdmission.js";
import { prepareLocalReuseAdmission } from "./reuseAdmission.js";
import { prepareLocalMintAdmission } from "./mintAdmission.js";
import { type PostgresMintRequests } from "./requests.js";
import { type IssuanceIntent, type PostgresGenerativeAuthorizationIssuer, type ReservedAuthorizationSigner } from "./generativeAuthorizations.js";
import { type PostgresWalletSubmissions, type WalletMintPlan } from "./walletSubmissions.js";
import { type RuntimeIntent } from "./runtimeService.js";

export interface LocalAdmissionReviewBinding {
  scope: AdmissionScope;
  requireReview: AdmissionPorts<unknown>["requireReview"];
}
/** Explicit local RC1 composition. No credential loading, listener, approval
 * generation or public active-state bypass. Database pins and review sources
 * are supplied by the operator (ephemeral signed fixtures in tests only). */
export class LocalAdmissionRuntime implements WorkerAdmission {
  readonly #assessment: LocalAdmissionReviewBinding;
  readonly #mint: LocalAdmissionReviewBinding;
  readonly #role: string;
  readonly #stop = new AbortController();
  constructor(readonly requests: PostgresMintRequests, input: {
    expectedRole: string; assessment: LocalAdmissionReviewBinding; mint: LocalAdmissionReviewBinding;
  }) {
    if (process.env.NODE_ENV === "production" || requests.repository.namespace.profile !== "local-real"
      || requests.repository.namespace.provenance !== "grok" || requests.profile.chain_id !== "31337") throw Error("Local admission only; public startup remains disabled.");
    this.#role = input.expectedRole;
    const capture = (b: LocalAdmissionReviewBinding) => {
      if (b.scope.writerEpoch !== requests.repository.writer.epoch) throw Error("Admission writer mismatch.");
      return Object.freeze({ scope: Object.freeze({ ...b.scope }), requireReview: b.requireReview.bind(b) });
    };
    this.#assessment = capture(input.assessment); this.#mint = capture(input.mint);
  }
  halt() { this.#stop.abort(); }
  #live(signal: AbortSignal) {
    this.#stop.signal.throwIfAborted(); signal.throwIfAborted(); this.requests.repository.writer.assertHealthy();
  }
  #config(binding: LocalAdmissionReviewBinding) {
    return { expectedRole: this.#role, databaseBindingSha256: binding.scope.databaseBindingSha256,
      scopeSha256: admissionDigest(binding.scope), leaseMs: binding.scope.permitTtlMs };
  }
  async #run<T>(binding: LocalAdmissionReviewBinding, value: AssessmentWorkerIntent, signal: AbortSignal,
    adapter: { intent: Parameters<ReturnType<typeof createAdmissionGate<T>>["prepare"]>[0]; database: AdmissionPorts<T>["database"]; effect: AdmissionPorts<T>["effects"]["read"] }) {
    this.#live(signal);
    const request = await this.requests.get(value.code, value.sessionToken), witness = value.eligibility;
    this.#live(signal);
    const g = createAdmissionGate(binding.scope, {
      // LOCAL eligibility is real opaque evidence for this exact request, not
      // a synthetic always-current witness or a relaxed public observer.
      chain: { observe: async s => { this.#live(s); return witness; }, read: (w, now) => readPublicChainEligibility(w,
        { namespaceId: this.requests.repository.namespace.id, deploymentId: this.requests.profile.deployment_id,
          handle: request.handle, recipient: request.wallet, now }) },
      requireReview: (scope, op, now) => { this.#live(signal); if (binding.requireReview(scope, op, now) !== undefined) throw Error("Synchronous review required."); },
      database: adapter.database,
      effects: Object.fromEntries(ADMISSION_OPERATIONS.map(op => [op, op === adapter.intent.operation ? adapter.effect : async () => { throw Error("Unregistered local operation."); }])) as AdmissionPorts<T>["effects"],
    });
    return g.execute(await g.prepare(adapter.intent, signal), signal);
  }
  async reuse(value: AssessmentWorkerIntent, signal: AbortSignal) {
    const combined = AbortSignal.any([signal, this.#stop.signal]); this.#live(combined);
    const adapter = await prepareLocalReuseAdmission(this.requests, value, this.#config(this.#assessment), combined);
    return this.#run(this.#assessment, value, combined, adapter);
  }
  async dispatch<T>(value: AssessmentWorkerIntent, leg: ProviderLeg, model: string, signal: AbortSignal,
    effect: (dispatch: NonNullable<AssessmentExecution["dispatch"]>) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, this.#stop.signal]); this.#live(combined);
    const adapter = await prepareLocalAssessmentAdmission(this.requests, value, { ...this.#config(this.#assessment), leg, model }, combined);
    return this.#run(this.#assessment, value, combined, { ...adapter, effect: async (_intent, s, guard) => {
      this.#live(s); guard();
      return effect(Object.freeze({ signal: s, assertCurrent: (current: ProviderLeg) => { if (current !== leg) throw Error("Provider leg mismatch."); this.#live(s); guard(); } }));
    } });
  }
  async issue(issuer: PostgresGenerativeAuthorizationIssuer, value: IssuanceIntent, signer: ReservedAuthorizationSigner,
    signal = new AbortController().signal) {
    const combined = AbortSignal.any([signal, this.#stop.signal]); this.#live(combined);
    if (issuer.requests !== this.requests || issuer.journal.profile.contractProfile !== "generative-v1-rc1") throw Error("Admission issuer mismatch.");
    // Reservation is unsigned and may survive a later denial. It never makes
    // an uncertain signature eligible to sign again or consumes paid credit.
    const operation = await issuer.prepareIssuanceAdmission(value, signer); this.#live(combined);
    const adapter = await prepareLocalMintAdmission(operation, this.#config(this.#mint), combined);
    return this.#run(this.#mint, value, combined, adapter);
  }
  async submit(submissions: PostgresWalletSubmissions, issuer: PostgresGenerativeAuthorizationIssuer, value: IssuanceIntent,
    intent: RuntimeIntent, plan: WalletMintPlan, signal: AbortSignal) {
    const combined = AbortSignal.any([signal, this.#stop.signal]); this.#live(combined);
    if (submissions.requests !== this.requests || issuer.requests !== this.requests) throw Error("Admission wallet mismatch.");
    const operation = await submissions.prepareSubmissionAdmission(issuer, value, intent, plan); this.#live(combined);
    const adapter = await prepareLocalMintAdmission(operation, this.#config(this.#mint), combined);
    return this.#run(this.#mint, value, combined, adapter);
  }
}
