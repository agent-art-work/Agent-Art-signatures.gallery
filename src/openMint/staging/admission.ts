import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import canonicalize from "canonicalize";

export const ADMISSION_OPERATIONS = ["read", "reuse", "assessment-x", "assessment-grok", "sign", "wallet-submit"] as const;
export type AdmissionOperation = typeof ADMISSION_OPERATIONS[number];
export interface AdmissionIntent {
  readonly operation: AdmissionOperation;
  /** Durable request/artifact identifier and exact saved payload digest, not a private mint code. */
  readonly requestId: string;
  readonly payloadSha256: string;
}
export interface AdmissionScope {
  readonly operatingPlanSha256: string;
  readonly activePolicySha256: string;
  /** Reviewed schema, grants, namespace, deployment, session and request-profile binding. */
  readonly databaseBindingSha256: string;
  readonly reviewRevisionSha256: string;
  readonly writerEpoch: string;
  readonly timeoutMs: number;
  readonly permitTtlMs: number;
  readonly paidValidFrom: number;
  readonly paidValidUntil: number;
  /** Opt-in, review-bound completion budgets. Never extend witness freshness. */
  readonly paidCompletionMs?: Readonly<{ "assessment-x": number; "assessment-grok": number }>;
}
export interface AdmissionEffectGuard {
  (): void;
  /** One-shot checkpoint immediately before transport dispatch. */
  beginDispatch?: () => void;
  /** Checks only the already-dispatched response, never authorizes another effect. */
  assertCompletion?: () => void;
}
export interface AdmissionChainEvidence { readonly observedAt: number; readonly validUntil: number }

/** Trusted internal adapter, NOT a JSON receipt accepted from HTTP. inspect()
 * must audit schema/grants/profile/owner plus this exact request/session and
 * current budget/issuance policy. fence() must revalidate them transactionally
 * and durably reserve this exact leg BEFORE any external effect. Existing
 * dispatch/signing/wallet fences remain authoritative across process restart.
 */
export interface AdmissionDatabaseLease {
  readonly databaseBindingSha256: string;
  readonly intentSha256: string;
  readonly writerEpoch: string;
  readonly observedAt: number;
  readonly validUntil: number;
  /** Synchronous live ownership/configuration/kill-switch check, not a cached true flag. */
  assertCurrent(operation: AdmissionOperation): void;
  fence(signal: AbortSignal): Promise<void>;
}
export interface AdmissionPorts<Result> {
  chain: {
    observe(signal: AbortSignal): Promise<unknown>;
    /** The release-aware adapter installs the actual opaque witness reader. */
    read(witness: unknown, now: number): AdmissionChainEvidence;
  };
  /** Trusted reviewed configuration/custody/security/provider-acceptance source.
   * Must throw on absence/revocation/drift. Never map a request's approved flag here. */
  requireReview(scopeSha256: string, operation: AdmissionOperation, now: number): void;
  database: { inspect(intent: Readonly<AdmissionIntent>, scopeSha256: string, signal: AbortSignal): Promise<AdmissionDatabaseLease> };
  /** Registered once by trusted composition. The request cannot choose a callback.
   * For wallet-submit this releases a durable wallet dispatch plan, never sends
   * a public transaction itself. Adapters persist outcomes even after timeout.
   * After any awaited work, invoke assertCurrent synchronously immediately
   * before the real external effect; the initial gate check is not reusable.
   * With paidCompletionMs, use beginDispatch immediately before the one fetch
   * and assertCompletion only for its response. Returning without beginning is
   * rejected; ordinary assertCurrent never inherits the completion lifetime. */
  effects: Record<AdmissionOperation, (intent: Readonly<AdmissionIntent>, signal: AbortSignal, assertCurrent: AdmissionEffectGuard) => Promise<Result>>;
}
export class StagingAdmissionError extends Error {
  constructor(readonly effectMayHaveStarted = false) {
    super(effectMayHaveStarted ? "The operation outcome needs reconciliation; no automatic retry is permitted."
      : "Operation admission unavailable; no external action was started by this gate.");
    this.name = "StagingAdmissionError";
  }
}
const check = (ok: unknown): void => { if (!ok) throw new StagingAdmissionError(); };
export const admissionDigest = (value: unknown): string => createHash("sha256").update(canonicalize(value)!).digest("hex");
function fields(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value as object);
  check(keys.length === names.length && keys.every(k => typeof k === "string" && names.includes(k))
    && names.every(k => ds[k]?.enumerable && "value" in ds[k]));
}
function digest(value: unknown): void { check(typeof value === "string" && /^[a-f0-9]{64}$/.test(value) && value !== "0".repeat(64)); }
const integer = (v: unknown, min: number, max: number): void => { check(typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max); };
function captureIntent(input: AdmissionIntent): Readonly<AdmissionIntent> {
  fields(input, ["operation", "requestId", "payloadSha256"]);
  check(ADMISSION_OPERATIONS.includes(input.operation as AdmissionOperation));
  check(typeof input.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.requestId));
  digest(input.payloadSha256); return Object.freeze({ ...input });
}
const paid = (operation: AdmissionOperation): boolean => operation === "assessment-x" || operation === "assessment-grok";
const external = (operation: AdmissionOperation): boolean => operation !== "read" && operation !== "reuse";

/** One shared pure validator for gate and local startup; not an approval. */
export function captureAdmissionScope(input: AdmissionScope): Readonly<AdmissionScope> {
  fields(input, ["operatingPlanSha256", "activePolicySha256", "databaseBindingSha256", "reviewRevisionSha256", "writerEpoch",
    "timeoutMs", "permitTtlMs", "paidValidFrom", "paidValidUntil", ...(Object.hasOwn(input, "paidCompletionMs") ? ["paidCompletionMs"] : [])]);
  for (const k of ["operatingPlanSha256", "activePolicySha256", "databaseBindingSha256", "reviewRevisionSha256"] as const) digest(input[k]);
  check(typeof input.writerEpoch === "string" && /^[1-9][0-9]{0,18}$/.test(input.writerEpoch));
  integer(input.timeoutMs, 1, 30000); integer(input.permitTtlMs, 1, 30000);
  integer(input.paidValidFrom, 0, Number.MAX_SAFE_INTEGER); integer(input.paidValidUntil, input.paidValidFrom + 1, Number.MAX_SAFE_INTEGER);
  check(input.paidValidUntil - input.paidValidFrom <= 31 * 86400000);
  if (Object.hasOwn(input, "paidCompletionMs")) {
    fields(input.paidCompletionMs, ["assessment-x", "assessment-grok"]);
    integer(input.paidCompletionMs["assessment-x"], 1, 70000);
    integer(input.paidCompletionMs["assessment-grok"], 1, 120000);
    return Object.freeze({ ...input, paidCompletionMs: Object.freeze({ ...input.paidCompletionMs }) });
  }
  return Object.freeze({ ...input });
}

/** Internal orchestration primitive. Its ports are trusted application code,
 * not an authorization boundary against code that controls this process.
 * Use the release-aware adapter; this module alone does not validate a release
 * or implement PostgreSQL checks. No public startup/credential/network adapter.
 */
export function createAdmissionGate<Result>(input: AdmissionScope, ports: AdmissionPorts<Result>, now: () => number = Date.now) {
  const scope = captureAdmissionScope(input), scopeSha256 = admissionDigest(scope);
  const observe = ports.chain.observe.bind(ports.chain), read = ports.chain.read.bind(ports.chain);
  const requireReview = ports.requireReview.bind(ports), inspect = ports.database.inspect.bind(ports.database);
  const effects = Object.freeze(Object.fromEntries(ADMISSION_OPERATIONS.map(op => {
    check(typeof ports.effects[op] === "function"); return [op, ports.effects[op].bind(ports.effects)];
  }))) as AdmissionPorts<Result>["effects"];
  interface Permit { intent: Readonly<AdmissionIntent>; witness: unknown; expires: number; started: number; createdAt: number }
  const permits = new WeakMap<object, Permit>();
  let halted = false;
  const clock = (): number => { const t = now(); integer(t, 0, Number.MAX_SAFE_INTEGER); return t; };
  const evidence = (witness: unknown, time: number): AdmissionChainEvidence => {
    const r = read(witness, time); integer(r.observedAt, 0, time); integer(r.validUntil, time + 1, Number.MAX_SAFE_INTEGER); return r;
  };
  const guard = (intent: Readonly<AdmissionIntent>, time: number): void => {
    check(!halted); check(requireReview(scopeSha256, intent.operation, time) === undefined);
    if (paid(intent.operation)) check(time >= scope.paidValidFrom && time < scope.paidValidUntil);
  };
  const lease = (r: AdmissionDatabaseLease, intent: Readonly<AdmissionIntent>, time: number) => {
    check(r.databaseBindingSha256 === scope.databaseBindingSha256 && r.writerEpoch === scope.writerEpoch && r.intentSha256 === admissionDigest(intent));
    integer(r.observedAt, 0, time); integer(r.validUntil, time + 1, Number.MAX_SAFE_INTEGER);
    check(r.validUntil - r.observedAt <= scope.permitTtlMs);
    check(typeof r.assertCurrent === "function" && typeof r.fence === "function");
    const assertCurrent = r.assertCurrent.bind(r), fence = r.fence.bind(r), observed = r.observedAt, expires = r.validUntil;
    return { fence, assert: (t: number) => { check(t >= observed && t < expires); check(assertCurrent(intent.operation) === undefined); } };
  };
  async function bounded<T>(signal: AbortSignal, work: (signal: AbortSignal, checkTime: () => number, completion: (ms: number) => void) => Promise<T>, outcome: () => boolean): Promise<T> {
    const controller = new AbortController(); let wall = clock(), mono = performance.now(), duration = scope.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined, done = false;
    const checkTime = () => { const time = clock(); check(!done && !halted && !signal.aborted && !controller.signal.aborted
      && time >= wall && time - wall < duration && performance.now() - mono < duration); return time; };
    let rejectStop!: (reason: unknown) => void;
    const stop = new Promise<never>((_, reject) => { rejectStop = reject; });
    const abort = () => { controller.abort(); rejectStop(new StagingAdmissionError()); };
    const completion = (ms: number) => { wall = checkTime(); mono = performance.now(); duration = ms;
      clearTimeout(timer); timer = setTimeout(abort, ms); };
    signal.addEventListener("abort", abort, { once: true }); timer = setTimeout(abort, scope.timeoutMs);
    try { checkTime(); return await Promise.race([work(controller.signal, checkTime, completion), stop]); }
    catch { throw new StagingAdmissionError(outcome()); }
    finally { done = true; controller.abort(); clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  return Object.freeze({ scope, scopeSha256,
    /** Permanent process-local stop. Restart must reconstruct review and evidence. */
    halt() { halted = true; },
    async prepare(value: AdmissionIntent, signal = new AbortController().signal): Promise<object> {
      const intent = captureIntent(value);
      return bounded(signal, async (s, tick) => {
        guard(intent, tick()); const witness = await observe(s); guard(intent, tick());
        const proof = evidence(witness, tick()), r = lease(await inspect(intent, scopeSha256, s), intent, tick());
        const time = tick(); guard(intent, time); evidence(witness, time); r.assert(time);
        const token = Object.freeze({}); permits.set(token, { intent, witness, createdAt: time, started: performance.now(), expires: Math.min(time + scope.permitTtlMs, proof.validUntil) });
        return token;
      }, () => false);
    },
    async execute(token: object, signal = new AbortController().signal): Promise<Result> {
      const p = permits.get(token); permits.delete(token); // Consume before any await, including failed attempts.
      if (!p) throw new StagingAdmissionError();
      let started = false;
      return bounded(signal, async (s, tick, completion) => {
        const recheck = () => { const t = tick(); check(t >= p.createdAt && t < p.expires && performance.now() - p.started < scope.permitTtlMs);
          guard(p.intent, t); evidence(p.witness, t); return t; };
        recheck(); const r = lease(await inspect(p.intent, scopeSha256, s), p.intent, recheck()); r.assert(recheck());
        if (external(p.intent.operation)) { await r.fence(s); r.assert(recheck()); }
        // No await/microtask between the final checks and invoking the captured
        // adapter. A fence commit with a lost reply does NOT permit retry.
        r.assert(recheck()); started = external(p.intent.operation);
        const completionMs = paid(p.intent.operation) ? scope.paidCompletionMs?.[p.intent.operation as "assessment-x" | "assessment-grok"] : undefined;
        let dispatched = false;
        const current: AdmissionEffectGuard = () => { r.assert(recheck()); };
        if (completionMs !== undefined) {
          current.beginDispatch = () => { check(!dispatched); current(); dispatched = true; completion(completionMs); };
          current.assertCompletion = () => {
            check(dispatched);
            // Dispatch-time witness/lease may age out while receiving a response.
            // Review, cancellation and the bounded lifetime still apply. This
            // checkpoint cannot be used as permission for another fetch/sign.
            const t = tick(); check(requireReview(scopeSha256, p.intent.operation, t) === undefined);
          };
        }
        const result = await effects[p.intent.operation](p.intent, s, Object.freeze(current));
        // Adapters own durable outcomes; rejecting a late reply cannot undo it.
        if (completionMs !== undefined) current.assertCompletion!();
        else { recheck(); r.assert(tick()); }
        return result;
      }, () => started);
    },
  });
}
