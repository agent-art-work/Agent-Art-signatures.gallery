import { createHash, randomUUID } from "node:crypto";
import type { Assessment } from "./assessment.js";
import { canonicalHandle } from "./identity.js";
import { SerialKeys, type KeyValueStore } from "./storage.js";
import { validateXIdentity, type XIdentitySnapshot } from "./xIdentity.js";

export type ProviderLeg = "x-identity" | "grok";
export type AbstentionReason = "insufficient-evidence" | "subject-unavailable" | "provider-refusal";
export type SafeAssessmentOutcome = { kind: "accepted" } | { kind: "abstained"; reason: AbstentionReason } | { kind: "invalid" };
export type AssessmentFailureCategory = "identity" | "provider" | "storage" | "interrupted";
export interface ProviderReceipt {
  leg: ProviderLeg;
  startedAt: number;
  completedAt: number;
  category: "success" | "http-error" | "transport-error" | "timeout" | "invalid-body" | "oversized-body";
  httpStatus?: number;
  requestId?: string;
  responseId?: string;
  model?: string;
  usageStatus: "valid" | "missing" | "invalid";
  usage?: {
    inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number;
    reasoningTokens?: number; searchCalls?: number; serverSideToolCalls?: number; costInUsdTicks?: string;
  };
  cost: { status: "actual" | "estimated" | "unknown"; currency: "USD"; scale: 10; amount?: string; pricingReference?: string };
}
export interface AssessmentExecution {
  readonly attemptId: string;
  /** Optional internal admission boundary. Registered by trusted composition,
   * never decoded from browser JSON. No hook preserves the existing local path. */
  readonly dispatch?: {
    readonly signal: AbortSignal;
    assertCurrent(leg: ProviderLeg): void;
    /** Versioned staging admission: a one-use fetch checkpoint, separate from
     * completion of that response. Old local callers retain assertCurrent. */
    beginDispatch?(leg: ProviderLeg): void;
    assertCompletion?(leg: ProviderLeg): void;
  };
  beforeDispatch(leg: ProviderLeg): Promise<void>;
  recordReceipt(receipt: ProviderReceipt): Promise<void>;
  identityVerified(snapshot: XIdentitySnapshot): Promise<void>;
  recordOutcome(outcome: SafeAssessmentOutcome): Promise<void>;
  assessmentPersisted(assessment: Assessment): Promise<void>;
}

const PHASES = ["xDispatchedAt", "xVerifiedAt", "grokDispatchedAt", "responseReceivedAt", "outcomeAt", "assessmentPersistedAt", "failedAt", "artifactPreparedAt", "artifactFailedAt"] as const;
type Phase = typeof PHASES[number];
export interface AssessmentAttempt {
  version: 1;
  id: string;
  handle: string;
  admittedAt: number;
  profileVersion: string;
  accountingRequired: boolean;
  phases: Partial<Record<Phase, number>>;
  outcome: "pending" | "accepted" | "abstained" | "invalid" | "failed-before-dispatch" | "failed-after-response" | "uncertain-after-dispatch";
  abstentionReason?: AbstentionReason;
  failureCategory?: AssessmentFailureCategory;
  reconciliation: "pending" | "complete" | "operator-review";
  acceptedAssessment?: { id: string; digest: string };
  identity?: XIdentitySnapshot;
  artifact: "pending" | "prepared" | "failed";
  recovery?: { recoveryId: string; sourceAttemptId: string };
}
export interface LegacyAssessmentAttempt {
  version: 0;
  id: string;
  handle: string;
  admission: "unknown";
  legacyObservedAt: number;
  outcome: "uncertain-after-dispatch";
  reconciliation: "operator-review";
  artifact: "unknown";
}
export type AssessmentAttemptView = AssessmentAttempt | LegacyAssessmentAttempt;
interface Reservation {
  attemptId: string; handle: string; admittedAt: number; profileVersion: string; accountingRequired: boolean; reservedUsdTicks: string;
  recovery?: { recoveryId: string; sourceAttemptId: string };
}
interface PaidBudget { version: 1; reservations: Reservation[] }
interface SavedReceipt { version: 1; attemptId: string; receipt: ProviderReceipt }
export type AssessmentOperationsErrorCode = "GENERATION_DISABLED" | "HANDLE_NOT_ALLOWED" | "ASSESSMENT_RETRY_BLOCKED" | "ASSESSMENT_LIMIT" | "ASSESSMENT_ACTIVE_LIMIT" | "ASSESSMENT_EXPOSURE_LIMIT" | "ASSESSMENT_ACCOUNTING_UNKNOWN" | "ASSESSMENT_OPERATIONS_CORRUPT" | "ASSESSMENT_OPERATIONS_STATE" | "ASSESSMENT_RECOVERY_NOT_ELIGIBLE" | "ASSESSMENT_RECOVERY_CONFLICT" | "ASSESSMENT_RECOVERY_REVIEW_REQUIRED";
export class AssessmentOperationsError extends Error {
  constructor(readonly code: AssessmentOperationsErrorCode) { super(code); this.name = "AssessmentOperationsError"; }
}
/** Safe classification travels to the service; the original cause stays private. */
export class AssessmentPersistenceError extends Error {
  constructor(cause: unknown) { super("Assessment operational persistence failed.", { cause }); this.name = "AssessmentPersistenceError"; }
}
const BUDGET_KEY = "budget:paid_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
const REASONS = ["insufficient-evidence", "subject-unavailable", "provider-refusal"];
const FAILURES = ["identity", "provider", "storage", "interrupted"];
function corrupt(): never { throw new AssessmentOperationsError("ASSESSMENT_OPERATIONS_CORRUPT"); }
function stateError(): never { throw new AssessmentOperationsError("ASSESSMENT_OPERATIONS_STATE"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return corrupt();
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) corrupt();
}
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8_640_000_000_000_000; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function amount(value: unknown): value is string { return typeof value === "string" && /^(?:0|[1-9][0-9]{0,29})$/.test(value); }
function reference(value: unknown): value is string { return typeof value === "string" && REFERENCE.test(value); }
function canonical(value: unknown): value is string {
  try { return canonicalHandle(value) === value; } catch { return false; }
}
function validDay(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
const same = (first: unknown, second: unknown): boolean => JSON.stringify(first) === JSON.stringify(second);
const receiptKey = (id: string, leg: ProviderLeg): string => `receipt:${id}_${leg === "x-identity" ? "x" : "grok"}`;
const legPhase = (leg: ProviderLeg): Phase => leg === "x-identity" ? "xDispatchedAt" : "grokDispatchedAt";
function digest(value: unknown): string {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}
function recoveryLink(value: unknown): { recoveryId: string; sourceAttemptId: string } {
  const record = object(value); fields(record, ["recoveryId", "sourceAttemptId"]);
  if (typeof record.recoveryId !== "string" || !HASH.test(record.recoveryId) || typeof record.sourceAttemptId !== "string" || !UUID.test(record.sourceAttemptId)) corrupt();
  return record as { recoveryId: string; sourceAttemptId: string };
}

/** References identify evidence reviewed outside this tool; no credential, raw invoice or provider body belongs here. */
export interface AssessmentRecoveryCommand {
  version: 1;
  sourceAttemptId: string;
  idempotencyKey: string;
  operatorReference: string;
  approvalReference: string;
  rejectionEvidenceReference: string;
  billing: { actualCostUsdTicks: string; evidenceReference: string };
  profileVersion: string;
  reservationUsdTicks: string;
}
export interface AssessmentRecoveryPreview {
  version: 1;
  recoveryId: string;
  reviewDigest: string;
  command: AssessmentRecoveryCommand;
  handle: string;
  sourceAttemptId: string;
  sourceReceipt: ProviderReceipt;
  additionalAttempts: 1;
  totalReservationsAfter: 2;
  exposureAfterUsdTicks: string;
  dispatchAllowed: false;
}
export interface AssessmentRecoveryResult {
  version: 1;
  recoveryId: string;
  sourceAttemptId: string;
  attemptId: string;
  handle: string;
  status: "staged";
  dispatchAllowed: false;
}
interface RecoveryAudit {
  version: 1;
  recoveryId: string;
  reviewDigest: string;
  command: AssessmentRecoveryCommand;
  sourceDigest: string;
  createdAt: number;
  attempt: AssessmentAttempt;
  budgetBefore: PaidBudget;
  dailyKey: string;
  dailyBefore: number;
}
export function validateAssessmentRecoveryCommand(value: unknown): AssessmentRecoveryCommand {
  const record = object(value);
  fields(record, ["version", "sourceAttemptId", "idempotencyKey", "operatorReference", "approvalReference", "rejectionEvidenceReference", "billing", "profileVersion", "reservationUsdTicks"]);
  if (record.version !== 1 || typeof record.sourceAttemptId !== "string" || !UUID.test(record.sourceAttemptId)
    || !amount(record.reservationUsdTicks) || record.reservationUsdTicks === "0") corrupt();
  for (const key of ["idempotencyKey", "operatorReference", "approvalReference", "rejectionEvidenceReference", "profileVersion"]) if (!reference(record[key])) corrupt();
  const billing = object(record.billing); fields(billing, ["actualCostUsdTicks", "evidenceReference"]);
  if (!amount(billing.actualCostUsdTicks) || !reference(billing.evidenceReference)) corrupt();
  return structuredClone(record) as unknown as AssessmentRecoveryCommand;
}

/** Reject arbitrary dumps instead of trying to redact them after persistence. */
export function validateProviderReceipt(value: unknown): ProviderReceipt {
  const record = object(value);
  fields(record, ["leg", "startedAt", "completedAt", "category", "usageStatus", "cost"], ["httpStatus", "requestId", "responseId", "model", "usage"]);
  if (!["x-identity", "grok"].includes(String(record.leg)) || !timestamp(record.startedAt) || !timestamp(record.completedAt)
    || record.completedAt < record.startedAt || !["success", "http-error", "transport-error", "timeout", "invalid-body", "oversized-body"].includes(String(record.category))
    || !["valid", "missing", "invalid"].includes(String(record.usageStatus))) corrupt();
  if (record.httpStatus !== undefined && (!integer(record.httpStatus) || record.httpStatus < 100 || record.httpStatus > 599)) corrupt();
  for (const key of ["requestId", "responseId", "model"]) if (record[key] !== undefined && !reference(record[key])) corrupt();
  if (record.usage !== undefined) {
    const usage = object(record.usage);
    fields(usage, [], ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens", "searchCalls", "serverSideToolCalls", "costInUsdTicks"]);
    if (record.usageStatus !== "valid" || !Object.keys(usage).length) corrupt();
    for (const [key, value] of Object.entries(usage)) if (key === "costInUsdTicks" ? !amount(value) : !integer(value)) corrupt();
  }
  if (record.usageStatus === "valid" && record.usage === undefined) corrupt();
  const cost = object(record.cost);
  fields(cost, ["status", "currency", "scale"], ["amount", "pricingReference"]);
  if (cost.currency !== "USD" || cost.scale !== 10 || !["actual", "estimated", "unknown"].includes(String(cost.status))) corrupt();
  if (cost.status === "unknown") { if (cost.amount !== undefined || cost.pricingReference !== undefined) corrupt(); }
  else if (!amount(cost.amount)) corrupt();
  if (cost.pricingReference !== undefined && !reference(cost.pricingReference)) corrupt();
  if (cost.status === "estimated" && cost.pricingReference === undefined) corrupt();
  if (cost.status === "actual" && record.usage && (record.usage as ProviderReceipt["usage"])?.costInUsdTicks !== undefined
    && (record.usage as ProviderReceipt["usage"])!.costInUsdTicks !== cost.amount) corrupt();
  return structuredClone(record) as unknown as ProviderReceipt;
}

/** Legacy observations are projected conservatively; reading never rewrites old files. */
export function validateAssessmentAttempt(value: unknown, expectedHandle: string): AssessmentAttemptView {
  const record = object(value), handle = canonicalHandle(expectedHandle);
  if (record.version === undefined) {
    fields(record, ["handle", "createdAt", "status"], ["assessmentId"]);
    if (record.handle !== handle || !timestamp(record.createdAt) || !["started", "succeeded", "failed"].includes(String(record.status))
      || (record.assessmentId !== undefined && !reference(record.assessmentId))) corrupt();
    return { version: 0, id: `legacy-${createHash("sha256").update(handle).digest("hex").slice(0, 24)}`, handle, admission: "unknown",
      legacyObservedAt: record.createdAt, outcome: "uncertain-after-dispatch", reconciliation: "operator-review", artifact: "unknown" };
  }
  fields(record, ["version", "id", "handle", "admittedAt", "profileVersion", "accountingRequired", "phases", "outcome", "reconciliation", "artifact"],
    ["abstentionReason", "failureCategory", "acceptedAssessment", "identity", "recovery"]);
  if (record.version !== 1 || typeof record.id !== "string" || !UUID.test(record.id) || record.handle !== handle
    || !timestamp(record.admittedAt) || !reference(record.profileVersion) || typeof record.accountingRequired !== "boolean"
    || !["pending", "accepted", "abstained", "invalid", "failed-before-dispatch", "failed-after-response", "uncertain-after-dispatch"].includes(String(record.outcome))
    || !["pending", "complete", "operator-review"].includes(String(record.reconciliation)) || !["pending", "prepared", "failed"].includes(String(record.artifact))) corrupt();
  const phases = object(record.phases);
  fields(phases, [], PHASES);
  for (const time of Object.values(phases)) if (!timestamp(time) || time < record.admittedAt) corrupt();
  const ordered = ["xDispatchedAt", "xVerifiedAt", "grokDispatchedAt", "responseReceivedAt", "outcomeAt", "assessmentPersistedAt"];
  let previous = record.admittedAt;
  for (const key of ordered) if (phases[key] !== undefined) { if (Number(phases[key]) < previous) corrupt(); previous = Number(phases[key]); }
  if (phases.xVerifiedAt !== undefined && phases.xDispatchedAt === undefined) corrupt();
  if (phases.grokDispatchedAt !== undefined && phases.xDispatchedAt !== undefined && phases.xVerifiedAt === undefined) corrupt();
  if ((phases.responseReceivedAt !== undefined || phases.outcomeAt !== undefined) && phases.grokDispatchedAt === undefined) corrupt();
  if (["accepted", "abstained", "invalid"].includes(String(record.outcome)) && phases.outcomeAt === undefined) corrupt();
  if (["failed-before-dispatch", "failed-after-response", "uncertain-after-dispatch"].includes(String(record.outcome)) && phases.failedAt === undefined) corrupt();
  if (record.outcome === "failed-before-dispatch" && (phases.xDispatchedAt !== undefined || phases.grokDispatchedAt !== undefined)) corrupt();
  if (record.abstentionReason !== undefined && (!REASONS.includes(String(record.abstentionReason)) || record.outcome !== "abstained")) corrupt();
  if (record.outcome === "abstained" && record.abstentionReason === undefined) corrupt();
  if (record.failureCategory !== undefined && !FAILURES.includes(String(record.failureCategory))) corrupt();
  if (record.acceptedAssessment !== undefined) {
    const accepted = object(record.acceptedAssessment); fields(accepted, ["id", "digest"]);
    if (!reference(accepted.id) || typeof accepted.digest !== "string" || !/^0x[0-9a-f]{64}$/.test(accepted.digest)
      || record.outcome !== "accepted" || phases.assessmentPersistedAt === undefined) corrupt();
  } else if (phases.assessmentPersistedAt !== undefined) corrupt();
  if (record.reconciliation === "complete" && !record.acceptedAssessment) corrupt();
  if (record.identity !== undefined) {
    try { validateXIdentity(record.identity, handle); } catch { corrupt(); }
    if (phases.xVerifiedAt === undefined) corrupt();
  } else if (phases.xVerifiedAt !== undefined) corrupt();
  if ((record.artifact !== "pending" && !record.acceptedAssessment) || (record.artifact === "prepared" && phases.artifactPreparedAt === undefined)
    || (record.artifact === "failed" && phases.artifactFailedAt === undefined)) corrupt();
  if (record.recovery !== undefined && recoveryLink(record.recovery).sourceAttemptId === record.id) corrupt();
  return structuredClone(record) as unknown as AssessmentAttempt;
}

function validateBudget(value: unknown): PaidBudget {
  if (value === undefined) return { version: 1, reservations: [] };
  const record = object(value); fields(record, ["version", "reservations"]);
  if (record.version !== 1 || !Array.isArray(record.reservations) || record.reservations.length > 10_000) corrupt();
  const ids = new Set<string>(), handles = new Set<string>();
  for (const item of record.reservations) {
    const reservation = object(item); fields(reservation, ["attemptId", "handle", "admittedAt", "profileVersion", "accountingRequired", "reservedUsdTicks"], ["recovery"]);
    if (typeof reservation.attemptId !== "string" || !UUID.test(reservation.attemptId) || !canonical(reservation.handle)
      || !timestamp(reservation.admittedAt) || !reference(reservation.profileVersion) || typeof reservation.accountingRequired !== "boolean" || !amount(reservation.reservedUsdTicks)
      || (reservation.accountingRequired && reservation.reservedUsdTicks === "0")
      || ids.has(reservation.attemptId) || (handles.has(reservation.handle) && reservation.recovery === undefined)) corrupt();
    if (reservation.recovery !== undefined) {
      const link = recoveryLink(reservation.recovery);
      const source = (record.reservations as Reservation[]).find(item => item.attemptId === link.sourceAttemptId);
      if (!source || source.recovery || source.handle !== reservation.handle || !ids.has(source.attemptId)) corrupt();
    }
    ids.add(reservation.attemptId); handles.add(reservation.handle);
  }
  return structuredClone(record) as unknown as PaidBudget;
}

export interface AssessmentOperationsOptions {
  store: KeyValueStore;
  now?: () => number;
  generationEnabled?: boolean | (() => boolean);
  /** Only explicit development fixtures may disable monetary accounting. */
  accountingRequired?: boolean;
  allowedHandle?: string;
  maxTotalAttempts?: number;
  maxActiveAttempts?: number;
  dailyLimit?: number;
  reservationUsdTicks?: string;
  maxExposureUsdTicks?: string;
}
export interface AssessmentOperatorReport {
  version: 1;
  attempt: AssessmentAttemptView;
  receipts: ProviderReceipt[];
  reservationUsdTicks?: string;
  exposureUsdTicks?: string;
  accounting: "actual" | "unresolved" | "legacy-unknown" | "fixture-not-billed";
  automaticRetryAllowed: false;
  operatorReconciliation?: { recoveryId: string; operatorReference: string; approvalReference: string; rejectionEvidenceReference: string; billing: AssessmentRecoveryCommand["billing"] };
  recovery?: AssessmentRecoveryResult;
}

/** Single-writer operational ledger. No method deletes guards, releases unknown charges or retries a dispatch. */
export class AssessmentOperations {
  readonly #locks = new SerialKeys();
  readonly #now: () => number;
  readonly #limits: { total: number; active: number; daily: number; reservation: string; exposure: string };
  constructor(readonly options: AssessmentOperationsOptions) {
    this.#now = options.now ?? Date.now;
    this.#limits = { total: options.maxTotalAttempts ?? 1, active: options.maxActiveAttempts ?? 1, daily: options.dailyLimit ?? 1,
      reservation: options.reservationUsdTicks ?? "10000000000", exposure: options.maxExposureUsdTicks ?? "10000000000" };
    for (const limit of [this.#limits.total, this.#limits.active, this.#limits.daily]) if (!integer(limit) || limit < 1 || limit > 10_000) corrupt();
    if (!amount(this.#limits.reservation) || BigInt(this.#limits.reservation) === 0n || !amount(this.#limits.exposure)
      || (options.allowedHandle !== undefined && !canonical(options.allowedHandle))
      || (options.generationEnabled !== undefined && typeof options.generationEnabled !== "boolean" && typeof options.generationEnabled !== "function")
      || (options.accountingRequired !== undefined && typeof options.accountingRequired !== "boolean")) corrupt();
  }
  #time(attempt?: AssessmentAttempt): number {
    const time = this.#now();
    if (!timestamp(time)) corrupt();
    return Math.max(time, attempt?.admittedAt ?? 0, ...Object.values(attempt?.phases ?? {}));
  }
  async get(value: string): Promise<AssessmentAttemptView | undefined> {
    const handle = canonicalHandle(value), saved = await this.options.store.get<unknown>(`attempt:${handle}`);
    const source = saved === undefined ? undefined : validateAssessmentAttempt(saved, handle);
    const head = await this.options.store.get<unknown>(`recoveryhead:${handle}`);
    if (head === undefined) return source;
    const link = recoveryLink(head), audit = await this.#audit(link.recoveryId);
    if (!source || source.id !== link.sourceAttemptId || audit.attempt.handle !== handle || audit.command.sourceAttemptId !== source.id) corrupt();
    return this.#completedRecovery(audit);
  }
  async #current(handle: string): Promise<AssessmentAttempt> {
    const attempt = await this.get(handle);
    if (!attempt || attempt.version !== 1) return stateError();
    return attempt;
  }
  async #save(attempt: AssessmentAttempt): Promise<void> {
    validateAssessmentAttempt(attempt, attempt.handle);
    if (await this.options.store.get(`recoverylink:${attempt.id}`) !== undefined) return stateError();
    await this.#put(attempt.recovery ? `recoveryattempt:${attempt.id}` : `attempt:${attempt.handle}`, attempt);
  }
  async #put(key: string, value: unknown): Promise<void> {
    try { await this.options.store.put(key, value); }
    catch (error) { throw new AssessmentPersistenceError(error); }
  }
  async #immutable(key: string, value: unknown): Promise<void> {
    const existing = await this.options.store.get(key);
    if (existing !== undefined) { if (!same(existing, value)) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_CONFLICT"); return; }
    await this.#put(key, value);
  }
  async #allAttempts(): Promise<AssessmentAttemptView[]> {
    const original = (await this.options.store.entries<unknown>("attempt:")).map(([key, value]) => validateAssessmentAttempt(value, key.slice(8)));
    const recovered = (await this.options.store.entries<unknown>("recoveryattempt:")).map(([key, value]) => {
      const record = object(value), attempt = validateAssessmentAttempt(record, String(record.handle));
      if (attempt.version !== 1 || !attempt.recovery || key !== `recoveryattempt:${attempt.id}`) corrupt();
      return attempt;
    });
    return [...original, ...recovered];
  }
  async #daily(day: string): Promise<number> {
    let current = 0;
    for (const [key, value] of await this.options.store.entries<unknown>("budget:")) {
      if (key === BUDGET_KEY) continue;
      if (!/^budget:\d{4}-\d{2}-\d{2}$/.test(key) || !integer(value) || !validDay(key.slice(7))) corrupt();
      if (key === `budget:${day}`) current = value;
    }
    return current;
  }
  async #audit(id: string): Promise<RecoveryAudit> {
    if (!HASH.test(id)) corrupt();
    const record = object(await this.options.store.get(`recovery:${id}`));
    fields(record, ["version", "recoveryId", "reviewDigest", "command", "sourceDigest", "createdAt", "attempt", "budgetBefore", "dailyKey", "dailyBefore"]);
    const command = validateAssessmentRecoveryCommand(record.command), value = object(record.attempt);
    const attempt = validateAssessmentAttempt(value, String(value.handle)), budget = validateBudget(record.budgetBefore);
    if (record.version !== 1 || record.recoveryId !== id || id !== digest(command.idempotencyKey) || typeof record.reviewDigest !== "string" || !HASH.test(record.reviewDigest)
      || typeof record.sourceDigest !== "string" || !HASH.test(record.sourceDigest) || !timestamp(record.createdAt) || !integer(record.dailyBefore)
      || record.dailyKey !== `budget:${new Date(record.createdAt).toISOString().slice(0, 10)}` || attempt.version !== 1 || attempt.admittedAt !== record.createdAt
      || attempt.outcome !== "pending" || Object.keys(attempt.phases).length || attempt.acceptedAssessment || attempt.identity || attempt.failureCategory
      || attempt.artifact !== "pending" || attempt.reconciliation !== "pending" || attempt.profileVersion !== command.profileVersion || !attempt.accountingRequired
      || !same(attempt.recovery, { recoveryId: id, sourceAttemptId: command.sourceAttemptId }) || budget.reservations.length !== 1
      || budget.reservations[0].attemptId !== command.sourceAttemptId || budget.reservations[0].handle !== attempt.handle || budget.reservations[0].recovery) corrupt();
    if (record.reviewDigest !== digest({ command, sourceDigest: record.sourceDigest, budget, dailyBefore: record.dailyBefore, day: String(record.dailyKey).slice(7) })) corrupt();
    return structuredClone(record) as unknown as RecoveryAudit;
  }
  #recoveryReservation(audit: RecoveryAudit): Reservation {
    const attempt = audit.attempt;
    return { attemptId: attempt.id, handle: attempt.handle, admittedAt: attempt.admittedAt, profileVersion: attempt.profileVersion,
      accountingRequired: true, reservedUsdTicks: audit.command.reservationUsdTicks, recovery: attempt.recovery };
  }
  #recoveryResult(audit: RecoveryAudit): AssessmentRecoveryResult {
    return { version: 1, recoveryId: audit.recoveryId, sourceAttemptId: audit.command.sourceAttemptId, attemptId: audit.attempt.id,
      handle: audit.attempt.handle, status: "staged", dispatchAllowed: false };
  }
  async #sourceEvidence(command: AssessmentRecoveryCommand): Promise<{ attempt: AssessmentAttempt; receipt: ProviderReceipt; reservation: Reservation; sourceDigest: string }> {
    const source = (await this.options.store.entries<unknown>("attempt:")).map(([key, value]) => validateAssessmentAttempt(value, key.slice(8))).find(attempt => attempt.id === command.sourceAttemptId);
    const reject = (): never => { throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_NOT_ELIGIBLE"); };
    if (!source || source.version !== 1 || source.recovery || !source.accountingRequired || source.outcome !== "failed-after-response"
      || source.failureCategory !== "identity" || source.phases.xDispatchedAt === undefined || source.phases.failedAt === undefined
      || Object.keys(source.phases).some(key => !["xDispatchedAt", "failedAt"].includes(key)) || source.identity || source.acceptedAssessment || source.artifact !== "pending") return reject();
    const receipts = await this.#receipts(source), receipt = receipts[0];
    if (receipts.length !== 1 || receipt.leg !== "x-identity" || receipt.category !== "http-error" || receipt.httpStatus !== 402
      || receipt.startedAt < source.phases.xDispatchedAt || receipt.completedAt > source.phases.failedAt) return reject();
    const budget = validateBudget(await this.options.store.get(BUDGET_KEY)), reservation = budget.reservations.find(item => item.attemptId === source.id);
    if (!reservation || reservation.recovery || reservation.handle !== source.handle || reservation.admittedAt !== source.admittedAt
      || reservation.profileVersion !== source.profileVersion || reservation.accountingRequired !== source.accountingRequired) corrupt();
    if (command.profileVersion !== source.profileVersion || command.reservationUsdTicks !== reservation.reservedUsdTicks
      || (receipt.cost.status === "actual" && receipt.cost.amount !== command.billing.actualCostUsdTicks)) return reject();
    return { attempt: source, receipt, reservation, sourceDigest: digest({ attempt: source, receipts, reservation }) };
  }
  async #completedRecovery(audit: RecoveryAudit): Promise<AssessmentAttempt> {
    const source = await this.#sourceEvidence(audit.command);
    if (source.sourceDigest !== audit.sourceDigest) corrupt();
    const link = { recoveryId: audit.recoveryId, sourceAttemptId: audit.command.sourceAttemptId };
    if (!same(await this.options.store.get(`recoverylink:${audit.command.sourceAttemptId}`), link)
      || !same(await this.options.store.get(`recoveryhead:${audit.attempt.handle}`), link)) return stateError();
    const budget = validateBudget(await this.options.store.get(BUDGET_KEY));
    if (budget.reservations.filter(item => item.handle === audit.attempt.handle).length !== 2
      || !same(budget.reservations[0], audit.budgetBefore.reservations[0]) || !same(budget.reservations.find(item => item.attemptId === audit.attempt.id), this.#recoveryReservation(audit))
      || await this.#daily(audit.dailyKey.slice(7)) < audit.dailyBefore + 1) corrupt();
    const attempt = validateAssessmentAttempt(await this.options.store.get(`recoveryattempt:${audit.attempt.id}`), audit.attempt.handle);
    if (attempt.version !== 1 || attempt.id !== audit.attempt.id || attempt.admittedAt !== audit.attempt.admittedAt || attempt.profileVersion !== audit.attempt.profileVersion
      || !attempt.accountingRequired || !same(attempt.recovery, audit.attempt.recovery)) corrupt();
    return attempt;
  }
  async #receipts(attempt: AssessmentAttempt): Promise<ProviderReceipt[]> {
    const receipts: ProviderReceipt[] = [];
    for (const leg of ["x-identity", "grok"] as const) {
      const raw = await this.options.store.get<unknown>(receiptKey(attempt.id, leg));
      if (raw === undefined) continue;
      const record = object(raw); fields(record, ["version", "attemptId", "receipt"]);
      const receipt = validateProviderReceipt(record.receipt);
      if (record.version !== 1 || record.attemptId !== attempt.id || receipt.leg !== leg || attempt.phases[legPhase(leg)] === undefined) corrupt();
      receipts.push(receipt);
    }
    return receipts;
  }
  async #accounting(attempt: AssessmentAttempt, reservation: Reservation): Promise<{ exposure: bigint; actual: boolean; receipts: ProviderReceipt[] }> {
    const receipts = await this.#receipts(attempt);
    const dispatched = (["x-identity", "grok"] as const).filter(leg => attempt.phases[legPhase(leg)] !== undefined);
    const actual = !attempt.accountingRequired || (dispatched.length > 0 && attempt.outcome !== "pending" && receipts.length === dispatched.length && receipts.every(receipt => receipt.cost.status === "actual"));
    const known = receipts.reduce((sum, receipt) => sum + (receipt.cost.status === "unknown" ? 0n : BigInt(receipt.cost.amount!)), 0n);
    // Estimates and partial receipts cannot settle the reservation; known overruns still count.
    return { exposure: actual ? known : known > BigInt(reservation.reservedUsdTicks) ? known : BigInt(reservation.reservedUsdTicks), actual, receipts };
  }
  async #reconciliation(attempt: AssessmentAttempt): Promise<AssessmentOperatorReport["operatorReconciliation"]> {
    const raw = await this.options.store.get(`recoverylink:${attempt.id}`);
    if (raw === undefined) return undefined;
    const link = recoveryLink(raw), audit = await this.#audit(link.recoveryId);
    if (link.sourceAttemptId !== attempt.id || audit.command.sourceAttemptId !== attempt.id
      || (await this.#sourceEvidence(audit.command)).sourceDigest !== audit.sourceDigest) corrupt();
    return { recoveryId: audit.recoveryId, operatorReference: audit.command.operatorReference, approvalReference: audit.command.approvalReference,
      rejectionEvidenceReference: audit.command.rejectionEvidenceReference, billing: audit.command.billing };
  }
  #preview(audit: Pick<RecoveryAudit, "recoveryId" | "reviewDigest" | "command">, source: { attempt: AssessmentAttempt; receipt: ProviderReceipt }): AssessmentRecoveryPreview {
    return { version: 1, recoveryId: audit.recoveryId, reviewDigest: audit.reviewDigest, command: audit.command,
      handle: source.attempt.handle, sourceAttemptId: source.attempt.id, sourceReceipt: source.receipt, additionalAttempts: 1,
      totalReservationsAfter: 2, exposureAfterUsdTicks: (BigInt(audit.command.billing.actualCostUsdTicks) + BigInt(audit.command.reservationUsdTicks)).toString(), dispatchAllowed: false };
  }
  /** Read-only, offline review. It neither stages an allowance nor changes provider accounting. */
  async previewRecovery(value: AssessmentRecoveryCommand): Promise<AssessmentRecoveryPreview> {
    const command = validateAssessmentRecoveryCommand(value), recoveryId = digest(command.idempotencyKey);
    const existing = await this.options.store.get(`recovery:${recoveryId}`);
    if (existing !== undefined) {
      const audit = await this.#audit(recoveryId);
      if (digest(audit.command) !== digest(command)) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_CONFLICT");
      const source = await this.#sourceEvidence(command);
      if (source.sourceDigest !== audit.sourceDigest) corrupt();
      return this.#preview(audit, source);
    }
    const source = await this.#sourceEvidence(command);
    if (this.options.accountingRequired === false || command.reservationUsdTicks !== this.#limits.reservation) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_NOT_ELIGIBLE");
    if (this.options.allowedHandle !== undefined && source.attempt.handle !== this.options.allowedHandle) throw new AssessmentOperationsError("HANDLE_NOT_ALLOWED");
    if ((await this.options.store.entries("recovery:")).length || await this.options.store.get(`recoverylink:${source.attempt.id}`) !== undefined
      || await this.options.store.get(`recoveryhead:${source.attempt.handle}`) !== undefined) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_CONFLICT");
    const budget = validateBudget(await this.options.store.get(BUDGET_KEY));
    // Deliberately limited to the original one-attempt pilot. This is not a general limit override.
    if (budget.reservations.length !== 1 || (await this.#allAttempts()).length !== 1) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_NOT_ELIGIBLE");
    if (BigInt(command.billing.actualCostUsdTicks) + BigInt(command.reservationUsdTicks) > BigInt(this.#limits.exposure)) throw new AssessmentOperationsError("ASSESSMENT_EXPOSURE_LIMIT");
    const day = new Date(this.#time(source.attempt)).toISOString().slice(0, 10), dailyBefore = await this.#daily(day);
    if (dailyBefore >= Number.MAX_SAFE_INTEGER) corrupt();
    const reviewDigest = digest({ command, sourceDigest: source.sourceDigest, budget, dailyBefore, day });
    return this.#preview({ recoveryId, reviewDigest, command }, source);
  }
  /** Explicit offline operator write. Generation may stay disabled; no provider is invoked. */
  async stageRecovery(value: AssessmentRecoveryCommand, reviewDigest: string): Promise<AssessmentRecoveryResult> {
    const command = validateAssessmentRecoveryCommand(value), recoveryId = digest(command.idempotencyKey);
    if (typeof reviewDigest !== "string" || !HASH.test(reviewDigest)) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_REVIEW_REQUIRED");
    return this.#locks.run("admission", async () => {
      const source = await this.#sourceEvidence(command);
      return this.#locks.run(source.attempt.handle, async () => {
        let audit: RecoveryAudit;
        if (await this.options.store.get(`recovery:${recoveryId}`) !== undefined) {
          audit = await this.#audit(recoveryId);
          if (digest(audit.command) !== digest(command)) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_CONFLICT");
          if (audit.reviewDigest !== reviewDigest) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_REVIEW_REQUIRED");
        } else {
          const preview = await this.previewRecovery(command);
          if (preview.reviewDigest !== reviewDigest) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_REVIEW_REQUIRED");
          const evidence = await this.#sourceEvidence(command), createdAt = this.#time(evidence.attempt);
          const day = new Date(createdAt).toISOString().slice(0, 10), budgetBefore = validateBudget(await this.options.store.get(BUDGET_KEY));
          const attempt: AssessmentAttempt = { version: 1, id: randomUUID(), handle: source.attempt.handle, admittedAt: createdAt,
            profileVersion: command.profileVersion, accountingRequired: true, phases: {}, outcome: "pending", reconciliation: "pending", artifact: "pending",
            recovery: { recoveryId, sourceAttemptId: command.sourceAttemptId } };
          audit = { version: 1, recoveryId, reviewDigest, command, sourceDigest: evidence.sourceDigest, createdAt, attempt, budgetBefore,
            dailyKey: `budget:${day}`, dailyBefore: await this.#daily(day) };
          // If the clock crossed midnight during review, require a fresh review before any write.
          if (reviewDigest !== digest({ command, sourceDigest: audit.sourceDigest, budget: budgetBefore, dailyBefore: audit.dailyBefore, day })) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_REVIEW_REQUIRED");
          await this.#immutable(`recovery:${recoveryId}`, audit);
        }
        if ((await this.#sourceEvidence(command)).sourceDigest !== audit.sourceDigest) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_CONFLICT");
        const head = await this.options.store.get(`recoveryhead:${audit.attempt.handle}`);
        if (head !== undefined) { await this.#completedRecovery(audit); return this.#recoveryResult(audit); }
        const link = { recoveryId, sourceAttemptId: command.sourceAttemptId };
        // Reserve the source, then append admission, then count it, then save the attempt.
        // The head is the final commit point; an incomplete write sequence is never dispatchable.
        await this.#immutable(`recoverylink:${command.sourceAttemptId}`, link);
        const budget = validateBudget(await this.options.store.get(BUDGET_KEY));
        const after: PaidBudget = { version: 1, reservations: [...audit.budgetBefore.reservations, this.#recoveryReservation(audit)] };
        if (same(budget, audit.budgetBefore)) await this.#put(BUDGET_KEY, after);
        else if (!same(budget, after)) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_CONFLICT");
        const daily = await this.#daily(audit.dailyKey.slice(7));
        if (daily === audit.dailyBefore) await this.#put(audit.dailyKey, audit.dailyBefore + 1);
        else if (daily !== audit.dailyBefore + 1) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_CONFLICT");
        await this.#immutable(`recoveryattempt:${audit.attempt.id}`, audit.attempt);
        await this.#immutable(`recoveryhead:${audit.attempt.handle}`, link);
        await this.#completedRecovery(audit);
        return this.#recoveryResult(audit);
      });
    });
  }
  /** A fresh explicit mint request may consume only this completely staged, undispatched attempt. */
  async stagedRecovery(value: string, profileVersion: string, requireGeneration = false): Promise<AssessmentAttempt | undefined> {
    const handle = canonicalHandle(value), attempt = await this.get(handle);
    if (!attempt || attempt.version !== 1 || !attempt.recovery || attempt.outcome !== "pending" || Object.keys(attempt.phases).length) return undefined;
    if (attempt.profileVersion !== profileVersion || this.options.accountingRequired === false || (this.options.allowedHandle !== undefined && handle !== this.options.allowedHandle)) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_NOT_ELIGIBLE");
    if (requireGeneration) { this.#generationAllowed(handle); await this.#recoveryDispatchAllowed(attempt); }
    return attempt;
  }
  #generationAllowed(handle: string): void {
    const enabled = typeof this.options.generationEnabled === "function" ? this.options.generationEnabled() : this.options.generationEnabled;
    if (enabled !== true) throw new AssessmentOperationsError("GENERATION_DISABLED");
    if (this.options.allowedHandle !== undefined && handle !== this.options.allowedHandle) throw new AssessmentOperationsError("HANDLE_NOT_ALLOWED");
  }
  async #recoveryDispatchAllowed(attempt: AssessmentAttempt): Promise<void> {
    if (!attempt.recovery) return;
    const audit = await this.#audit(attempt.recovery.recoveryId);
    if (this.options.accountingRequired === false || audit.command.reservationUsdTicks !== this.#limits.reservation) throw new AssessmentOperationsError("ASSESSMENT_RECOVERY_NOT_ELIGIBLE");
    if (BigInt(audit.command.billing.actualCostUsdTicks) + BigInt(audit.command.reservationUsdTicks) > BigInt(this.#limits.exposure)) throw new AssessmentOperationsError("ASSESSMENT_EXPOSURE_LIMIT");
  }
  async admit(value: string, profileVersion: string): Promise<AssessmentAttempt> {
    const handle = canonicalHandle(value);
    if (!reference(profileVersion)) corrupt();
    return this.#locks.run("admission", async () => {
      this.#generationAllowed(handle);
      if (await this.get(handle)) throw new AssessmentOperationsError("ASSESSMENT_RETRY_BLOCKED");
      for (const [key] of await this.options.store.entries("recovery:")) {
        const audit = await this.#audit(key.slice(9));
        // An interrupted operator write must finish before unrelated admissions can advance the ledger.
        if (await this.options.store.get(`recoveryhead:${audit.attempt.handle}`) === undefined) throw new AssessmentOperationsError("ASSESSMENT_ACCOUNTING_UNKNOWN");
        await this.#completedRecovery(audit);
      }
      const now = this.#time(), day = new Date(now).toISOString().slice(0, 10);
      const budget = validateBudget(await this.options.store.get(BUDGET_KEY));
      const saved = await this.#allAttempts();
      const legacyDaily = await this.#daily(day);
      if (budget.reservations.some(item => item.handle === handle)) throw new AssessmentOperationsError("ASSESSMENT_RETRY_BLOCKED");
      const reservedIds = new Set(budget.reservations.map(item => item.attemptId));
      if (this.options.accountingRequired !== false && saved.some(item => item.version === 0 || !reservedIds.has(item.id))) throw new AssessmentOperationsError("ASSESSMENT_ACCOUNTING_UNKNOWN");
      if (Math.max(budget.reservations.length, saved.length) >= this.#limits.total || Math.max(legacyDaily, budget.reservations.filter(item => new Date(item.admittedAt).toISOString().slice(0, 10) === day).length) >= this.#limits.daily) {
        throw new AssessmentOperationsError("ASSESSMENT_LIMIT");
      }
      let exposure = 0n, active = 0;
      for (const reservation of budget.reservations) {
        const attempt = saved.find(item => item.id === reservation.attemptId);
        if (!attempt || attempt.version !== 1) throw new AssessmentOperationsError("ASSESSMENT_ACCOUNTING_UNKNOWN");
        if (attempt.handle !== reservation.handle || attempt.admittedAt !== reservation.admittedAt || attempt.profileVersion !== reservation.profileVersion || attempt.accountingRequired !== reservation.accountingRequired) corrupt();
        if (this.options.accountingRequired !== false && !attempt.accountingRequired) throw new AssessmentOperationsError("ASSESSMENT_ACCOUNTING_UNKNOWN");
        if (attempt.outcome === "pending") active++;
        const accounting = await this.#accounting(attempt, reservation);
        const reconciled = await this.#reconciliation(attempt);
        if (!accounting.actual && !reconciled && attempt.outcome !== "pending") throw new AssessmentOperationsError("ASSESSMENT_ACCOUNTING_UNKNOWN");
        exposure += reconciled ? BigInt(reconciled.billing.actualCostUsdTicks) : accounting.exposure;
      }
      if (active >= this.#limits.active) throw new AssessmentOperationsError("ASSESSMENT_ACTIVE_LIMIT");
      const accountingRequired = this.options.accountingRequired !== false;
      const reservationAmount = accountingRequired ? this.#limits.reservation : "0";
      if (exposure + BigInt(reservationAmount) > BigInt(this.#limits.exposure)) throw new AssessmentOperationsError("ASSESSMENT_EXPOSURE_LIMIT");
      const attempt: AssessmentAttempt = { version: 1, id: randomUUID(), handle, admittedAt: now, profileVersion, accountingRequired, phases: {}, outcome: "pending", reconciliation: "pending", artifact: "pending" };
      // Reserve first. A crash/write failure can consume a slot without a call, never hide a call.
      budget.reservations.push({ attemptId: attempt.id, handle, admittedAt: now, profileVersion, accountingRequired, reservedUsdTicks: reservationAmount });
      await this.#put(BUDGET_KEY, budget);
      await this.#put(`budget:${day}`, legacyDaily + 1);
      await this.#save(attempt);
      return attempt;
    });
  }
  async execution(value: string, expectedAttemptId?: string): Promise<AssessmentExecution> {
    const handle = canonicalHandle(value), admitted = await this.#current(handle);
    if (expectedAttemptId !== undefined && admitted.id !== expectedAttemptId) return stateError();
    const run = (action: (attempt: AssessmentAttempt) => Promise<void>) => this.#locks.run(handle, async () => {
      const attempt = await this.#current(handle);
      if (attempt.id !== admitted.id || await this.options.store.get(`recoverylink:${attempt.id}`) !== undefined) return stateError();
      await action(attempt);
    });
    return {
      attemptId: admitted.id,
      beforeDispatch: leg => run(async attempt => {
        if (!["x-identity", "grok"].includes(leg) || attempt.outcome !== "pending" || attempt.phases[legPhase(leg)] !== undefined) return stateError();
        if (leg === "x-identity" && attempt.phases.grokDispatchedAt !== undefined) return stateError();
        if (leg === "grok" && attempt.phases.xDispatchedAt !== undefined && attempt.phases.xVerifiedAt === undefined) return stateError();
        this.#generationAllowed(handle);
        await this.#recoveryDispatchAllowed(attempt);
        attempt.phases[legPhase(leg)] = this.#time(attempt);
        await this.#save(attempt);
      }),
      recordReceipt: value => run(async attempt => {
        const receipt = validateProviderReceipt(value);
        if (attempt.phases[legPhase(receipt.leg)] === undefined) return stateError();
        const key = receiptKey(attempt.id, receipt.leg);
        const saved: SavedReceipt = { version: 1, attemptId: attempt.id, receipt };
        const existing = await this.options.store.get<SavedReceipt>(key);
        if (existing !== undefined && !same(existing, saved)) return stateError();
        if (!existing) await this.#put(key, saved);
        if (receipt.leg === "grok" && receipt.httpStatus !== undefined && attempt.phases.responseReceivedAt === undefined) {
          attempt.phases.responseReceivedAt = this.#time(attempt); await this.#save(attempt);
        }
      }),
      identityVerified: snapshot => run(async attempt => {
        const identity = validateXIdentity(snapshot, handle);
        if (attempt.outcome !== "pending" || attempt.phases.xDispatchedAt === undefined || attempt.phases.grokDispatchedAt !== undefined) return stateError();
        if (attempt.identity) { if (!same(attempt.identity, identity)) return stateError(); return; }
        attempt.identity = identity; attempt.phases.xVerifiedAt = this.#time(attempt); await this.#save(attempt);
      }),
      recordOutcome: outcome => run(async attempt => {
        const value = object(outcome); fields(value, ["kind"], value.kind === "abstained" ? ["reason"] : []);
        if (!["accepted", "abstained", "invalid"].includes(String(value.kind)) || (value.kind === "abstained" && !REASONS.includes(String(value.reason)))) corrupt();
        if (attempt.outcome === outcome.kind && attempt.abstentionReason === (outcome.kind === "abstained" ? outcome.reason : undefined)) return;
        if (attempt.outcome !== "pending" || attempt.phases.grokDispatchedAt === undefined) return stateError();
        attempt.outcome = outcome.kind;
        if (outcome.kind === "abstained") attempt.abstentionReason = outcome.reason;
        attempt.phases.outcomeAt = this.#time(attempt); attempt.reconciliation = "operator-review";
        await this.#save(attempt);
      }),
      assessmentPersisted: assessment => run(async attempt => {
        if (assessment.handle !== handle || !reference(assessment.id) || !/^0x[0-9a-f]{64}$/.test(assessment.digest)
          || attempt.outcome !== "accepted") return stateError();
        const accepted = { id: assessment.id, digest: assessment.digest };
        if (attempt.acceptedAssessment) { if (!same(attempt.acceptedAssessment, accepted)) return stateError(); return; }
        attempt.acceptedAssessment = accepted; attempt.phases.assessmentPersistedAt = this.#time(attempt);
        const receipts = await this.#receipts(attempt);
        const dispatched = [attempt.phases.xDispatchedAt, attempt.phases.grokDispatchedAt].filter(time => time !== undefined).length;
        attempt.reconciliation = !attempt.accountingRequired || (receipts.length === dispatched && receipts.every(receipt => receipt.cost.status === "actual")) ? "complete" : "operator-review";
        await this.#save(attempt);
      }),
    };
  }
  async fail(value: string, category: AssessmentFailureCategory, expectedAttemptId?: string): Promise<void> {
    const handle = canonicalHandle(value);
    if (!FAILURES.includes(category)) corrupt();
    return this.#locks.run(handle, async () => {
      const attempt = await this.#current(handle);
      if (expectedAttemptId !== undefined && attempt.id !== expectedAttemptId) return stateError();
      if (attempt.phases.failedAt === undefined) attempt.phases.failedAt = this.#time(attempt);
      if (attempt.failureCategory === undefined) attempt.failureCategory = category;
      if (attempt.outcome === "pending") {
        const dispatched = attempt.phases.xDispatchedAt !== undefined || attempt.phases.grokDispatchedAt !== undefined;
        const receipts = await this.#receipts(attempt);
        const lastLeg = attempt.phases.grokDispatchedAt !== undefined ? "grok" : "x-identity";
        const received = receipts.some(receipt => receipt.leg === lastLeg && receipt.httpStatus !== undefined);
        attempt.outcome = !dispatched ? "failed-before-dispatch" : received ? "failed-after-response" : "uncertain-after-dispatch";
      }
      attempt.reconciliation = "operator-review";
      await this.#save(attempt);
    });
  }
  async artifactOutcome(value: string, outcome: "prepared" | "failed", expectedAttemptId?: string): Promise<void> {
    const handle = canonicalHandle(value);
    return this.#locks.run(handle, async () => {
      const attempt = await this.#current(handle);
      if (expectedAttemptId !== undefined && attempt.id !== expectedAttemptId) return stateError();
      if (!attempt.acceptedAssessment || !["prepared", "failed"].includes(outcome)) return stateError();
      if (attempt.artifact === "prepared" || attempt.artifact === outcome) return;
      attempt.artifact = outcome;
      const phase = outcome === "prepared" ? "artifactPreparedAt" : "artifactFailedAt";
      if (attempt.phases[phase] === undefined) attempt.phases[phase] = this.#time(attempt);
      await this.#save(attempt);
    });
  }
  async report(attemptId: string): Promise<AssessmentOperatorReport | undefined> {
    if (!UUID.test(attemptId) && !/^legacy-[a-f0-9]{24}$/.test(attemptId)) return stateError();
    const attempt = (await this.#allAttempts()).find(item => item.id === attemptId);
    if (!attempt) return undefined;
    if (attempt.version === 0) return { version: 1, attempt, receipts: [], accounting: "legacy-unknown", automaticRetryAllowed: false };
    const budget = validateBudget(await this.options.store.get(BUDGET_KEY));
    const reservation = budget.reservations.find(item => item.attemptId === attempt.id);
    if (!reservation || reservation.handle !== attempt.handle || reservation.admittedAt !== attempt.admittedAt || reservation.profileVersion !== attempt.profileVersion || reservation.accountingRequired !== attempt.accountingRequired) corrupt();
    const accounting = await this.#accounting(attempt, reservation);
    const operatorReconciliation = await this.#reconciliation(attempt);
    const recovery = attempt.recovery ? this.#recoveryResult(await this.#audit(attempt.recovery.recoveryId)) : undefined;
    return { version: 1, attempt, receipts: accounting.receipts, reservationUsdTicks: reservation.reservedUsdTicks,
      exposureUsdTicks: accounting.exposure.toString(), accounting: !attempt.accountingRequired ? "fixture-not-billed" : accounting.actual ? "actual" : "unresolved", automaticRetryAllowed: false,
      ...(operatorReconciliation ? { operatorReconciliation } : {}), ...(recovery ? { recovery } : {}) };
  }
}
