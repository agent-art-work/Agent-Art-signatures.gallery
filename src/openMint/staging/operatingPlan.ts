import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { GENERATIVE_READ_LIMITS } from "../generativeReadLimits.js";

/** Offline declarations only. No runtime may use this as admission evidence. */
export const STAGING_ORIGIN = "https://staging.signatures.gallery";
export const OPERATING_PLAN_MAX_BYTES = 32_768;
export const OPERATING_PRINCIPALS = ["deployer", "delayedAdmin", "authorizerManager", "pauser", "nonceRevoker", "authorizer"] as const;
type Principal = typeof OPERATING_PRINCIPALS[number];
type Frozen<T> = T extends object ? { readonly [P in keyof T]: Frozen<T[P]> } : T;

export interface OperatingSettings {
  schema: "sg-sepolia-operating-settings-v1";
  deploymentPlanSha256: string;
  namespace: "sepolia-staging";
  deploymentId: string;
  ownerReference: string;
  origin: string;
  session: { origin: string; chainId: 11155111; cookieName: "__Host-sg-staging"; secure: true; sameSite: "strict"; csrfRequired: true };
  hosting: { accountReference: string; serviceReference: string; tlsMode: "direct" | "trusted-proxy";
    trustedProxyHops: number; ingressPolicyReference: string; maxRequestBytes: number; requestTimeoutMs: number; drainTimeoutMs: number };
  database: { resourceReference: string; migrationPlanReference: string; backupEvidenceReference: string;
    roles: Record<"migrator" | "browser" | "projection" | "recovery", { name: string; connectionSecretReference: string }>;
    exclusiveWriter: true; migrateOnStartup: false; initialIssuanceEnabled: false; initialGenerationEnabled: false };
  rpc: { sources: { id: string; operatorReference: string; accountReference: string; endpointSecretReference: string;
    acceptanceEvidenceReference: string }[]; readLimitsVersion: string; jsonResponseBytes: number;
    timeoutMs: number; maxHeadAgeMs: number; maxFinalizedAgeMs: number; maxFutureSkewMs: number; evidenceTtlMs: number };
  custody: Record<Principal, { address: string; ownerReference: string; custodyPolicyReference: string; signerSecretReference: string }>;
  assessment: { profileReference: string; profileSha256: string; xCredentialReference: string; xaiCredentialReference: string;
    pricingReviewReference: string; spendingPolicyReference: string; validFrom: string; validUntil: string;
    dailyAttempts: number; totalAttempts: number; maxActive: 1; maxQueued: number; reservationUsdTicks: string;
    maxExposureUsdTicks: string; automaticRetries: 0; preserveUnknownExposure: true };
  operations: { supportReference: string; incidentPolicyReference: string; securityReviewReference: string;
    compatibilityEvidenceReference: string; finalityPolicyReference: string; reveal: "canonical-inclusion-confirming";
    gallery: "finalized-only"; staleEvidence: "stop-new-effects"; signerCompromise: "never-restore" };
}
export type OperatingSettingsV2 = Omit<OperatingSettings, "schema" | "database"> & {
  schema: "sg-sepolia-operating-settings-v2";
  database: Omit<OperatingSettings["database"], "roles"> & {
    schemaProfile: "sg-generative-database-v2";
    roles: OperatingSettings["database"]["roles"] & { inspector: { name: string; connectionSecretReference: string } };
  };
};

/** Constructed by the release-tool adapter, never taken from an approval report. */
export interface CandidateOperatingBinding {
  planSha256: string;
  releaseLockSha256: string;
  collectionRuntimeCodeHash: string;
  principals: Record<Principal, { address: string; ownerReference: string }>;
}

export class OperatingPlanError extends Error {
  constructor(path: string) { super(`Operating plan rejected at ${path}.`); this.name = "OperatingPlanError"; }
}
function check(ok: unknown, path: string): asserts ok { if (!ok) throw new OperatingPlanError(path); }
function object(value: unknown, fields: readonly string[], path: string): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), path);
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, path);
  const keys = Reflect.ownKeys(value);
  check(keys.length === fields.length && keys.every(k => typeof k === "string" && fields.includes(k)), path);
  // Do not invoke getters or allow hidden fields while validating in-process input.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(fields.every(k => descriptors[k]?.enumerable && "value" in descriptors[k]), path);
  return value as Record<string, unknown>;
}
function equal(value: unknown, expected: unknown, path: string): void { check(value === expected, path); }
function integer(value: unknown, min: number, max: number, path: string): void {
  check(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max, path);
}
function reference(value: unknown, kind: string, path: string): void {
  check(typeof value === "string" && new RegExp(`^${kind}:[a-z][a-z0-9/-]{2,79}$`).test(value)
    && !/(^|[:/-])(local|test|fixture|synthetic|example|todo|unknown|placeholder)([:/-]|$)/.test(value)
    && !value.includes("//") && !value.endsWith("/"), path);
}
function hash(value: unknown, path: string): void {
  check(typeof value === "string" && /^[a-f0-9]{64}$/.test(value) && value !== "0".repeat(64), path);
}
function decimal(value: unknown, path: string): bigint {
  check(typeof value === "string" && /^[1-9][0-9]{0,14}$/.test(value), path); return BigInt(value);
}
function timestamp(value: unknown, path: string): number {
  check(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(value), path);
  const time = Date.parse(value); check(Number.isFinite(time) && new Date(time).toISOString() === value, path); return time;
}
function freeze<T>(value: T): Frozen<T> {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value as Frozen<T>;
}
function plainCopy(value: unknown, depth = 0): unknown {
  check(depth <= 12, "settings nesting");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  check(typeof value === "object", "settings value");
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  check(proto === (array ? Array.prototype : Object.prototype) || proto === null, "settings prototype");
  const result: unknown = array ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    check(typeof key === "string" && key !== "__proto__", "settings key");
    const d = Object.getOwnPropertyDescriptor(value, key);
    check(d?.enumerable && "value" in d, "settings descriptor");
    (result as Record<string, unknown>)[key] = plainCopy(d.value, depth + 1);
  }
  return result;
}
export function parseOperatingJson(json: string): unknown {
  check(typeof json === "string" && Buffer.byteLength(json) <= OPERATING_PLAN_MAX_BYTES, "input size");
  try { return JSON.parse(json); } catch { throw new OperatingPlanError("JSON syntax"); }
}

/** Every field is bounded and checked; declarations/evidence references are NOT
 * retrieved or verified. No clock, environment, secret resolver, RPC or DB use. */
export function validateOperatingSettings(input: unknown, binding: CandidateOperatingBinding) {
  if (input && typeof input === "object" && !Array.isArray(input)
    && (input as Record<string, unknown>).schema === "sg-sepolia-operating-settings-v2") {
    const value = plainCopy(input) as OperatingSettingsV2;
    const database = object(value.database, ["resourceReference", "migrationPlanReference", "backupEvidenceReference", "roles",
      "exclusiveWriter", "migrateOnStartup", "initialIssuanceEnabled", "initialGenerationEnabled", "schemaProfile"], "database v2");
    equal(database.schemaProfile, "sg-generative-database-v2", "database.schemaProfile");
    const roles = object(database.roles, ["migrator", "browser", "projection", "recovery", "inspector"], "database.roles v2");
    const inspector = object(roles.inspector, ["name", "connectionSecretReference"], "database.roles.inspector");
    check(typeof inspector.name === "string" && /^sg_[a-z][a-z0-9_]{2,59}$/.test(inspector.name)
      && !["migrator", "browser", "projection", "recovery"].some(k => (roles[k] as {name: string}).name === inspector.name), "database.roles.inspector.name");
    reference(inspector.connectionSecretReference, "secret", "database.roles.inspector.connectionSecretReference");
    check(!["migrator", "browser", "projection", "recovery"].some(k =>
      (roles[k] as {connectionSecretReference: string}).connectionSecretReference === inspector.connectionSecretReference), "database.roles.inspector.connectionSecretReference");
    const v1 = JSON.parse(JSON.stringify(value)) as OperatingSettings;
    v1.schema = "sg-sepolia-operating-settings-v1";
    delete (v1.database as unknown as Record<string,unknown>).schemaProfile;
    delete (v1.database.roles as unknown as Record<string,unknown>).inspector;
    // Reuse every historical field constraint; only the new fields above are
    // added. The v1 returned digest is discarded, never treated as v2 approval.
    validateOperatingSettings(v1, binding);
    const body = { schema: "sg-sepolia-operating-plan-v2" as const, status: "declared-only-not-admitted" as const, settings: value,
      releaseLockSha256: binding.releaseLockSha256, collectionRuntimeCodeHash: binding.collectionRuntimeCodeHash,
      readLimits: { ...GENERATIVE_READ_LIMITS }, observedDeployment: false, evidenceVerified: false,
      custodyVerified: false, providerIndependenceVerified: false, paidDispatchAllowed: false,
      signingAllowed: false, publicBroadcastAllowed: false, runtimeAdmissionAllowed: false, activationAllowed: false };
    return freeze({ ...body, operatingPlanSha256: createHash("sha256").update(canonicalize(body)!).digest("hex") });
  }
  const c = object(input, ["schema", "deploymentPlanSha256", "namespace", "deploymentId", "ownerReference", "origin", "session",
    "hosting", "database", "rpc", "custody", "assessment", "operations"], "settings");
  equal(c.schema, "sg-sepolia-operating-settings-v1", "schema");
  hash(c.deploymentPlanSha256, "deploymentPlanSha256"); equal(c.deploymentPlanSha256, binding.planSha256, "deployment binding");
  equal(c.namespace, "sepolia-staging", "namespace"); equal(c.origin, STAGING_ORIGIN, "origin");
  check(typeof c.deploymentId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.deploymentId), "deploymentId");
  reference(c.ownerReference, "owner", "ownerReference");
  const session = object(c.session, ["origin", "chainId", "cookieName", "secure", "sameSite", "csrfRequired"], "session");
  for (const [k, v] of Object.entries({ origin: STAGING_ORIGIN, chainId: 11155111, cookieName: "__Host-sg-staging", secure: true, sameSite: "strict", csrfRequired: true })) equal(session[k], v, `session.${k}`);
  const hosting = object(c.hosting, ["accountReference", "serviceReference", "tlsMode", "trustedProxyHops", "ingressPolicyReference", "maxRequestBytes", "requestTimeoutMs", "drainTimeoutMs"], "hosting");
  reference(hosting.accountReference, "account", "hosting.accountReference"); reference(hosting.serviceReference, "service", "hosting.serviceReference");
  reference(hosting.ingressPolicyReference, "policy", "hosting.ingressPolicyReference");
  check(hosting.tlsMode === "direct" || hosting.tlsMode === "trusted-proxy", "hosting.tlsMode");
  equal(hosting.trustedProxyHops, hosting.tlsMode === "direct" ? 0 : 1, "hosting.trustedProxyHops");
  integer(hosting.maxRequestBytes, 1024, 65536, "hosting.maxRequestBytes");
  integer(hosting.requestTimeoutMs, 1000, 30000, "hosting.requestTimeoutMs");
  integer(hosting.drainTimeoutMs, hosting.requestTimeoutMs as number, 120000, "hosting.drainTimeoutMs");
  const db = object(c.database, ["resourceReference", "migrationPlanReference", "backupEvidenceReference", "roles", "exclusiveWriter", "migrateOnStartup", "initialIssuanceEnabled", "initialGenerationEnabled"], "database");
  reference(db.resourceReference, "resource", "database.resourceReference"); reference(db.migrationPlanReference, "policy", "database.migrationPlanReference");
  reference(db.backupEvidenceReference, "evidence", "database.backupEvidenceReference");
  for (const k of ["migrateOnStartup", "initialIssuanceEnabled", "initialGenerationEnabled"]) equal(db[k], false, `database.${k}`);
  equal(db.exclusiveWriter, true, "database.exclusiveWriter");
  const roleNames = ["migrator", "browser", "projection", "recovery"], roles = object(db.roles, roleNames, "database.roles");
  const names = new Set<unknown>(), secrets = new Set<unknown>();
  const secret = (v: unknown, path: string) => { reference(v, "secret", path); check(!secrets.has(v), path); secrets.add(v); };
  for (const name of roleNames) {
    const role = object(roles[name], ["name", "connectionSecretReference"], `database.roles.${name}`);
    check(typeof role.name === "string" && /^sg_[a-z][a-z0-9_]{2,59}$/.test(role.name) && !names.has(role.name), `database.roles.${name}.name`);
    names.add(role.name); secret(role.connectionSecretReference, `database.roles.${name}.connectionSecretReference`);
  }
  const rpc = object(c.rpc, ["sources", "readLimitsVersion", "jsonResponseBytes", "timeoutMs", "maxHeadAgeMs", "maxFinalizedAgeMs", "maxFutureSkewMs", "evidenceTtlMs"], "rpc");
  check(Array.isArray(rpc.sources) && rpc.sources.length === 2 && Object.getPrototypeOf(rpc.sources) === Array.prototype
    && Reflect.ownKeys(rpc.sources).length === 3
    && ["0", "1"].every(k => { const d = Object.getOwnPropertyDescriptor(rpc.sources, k); return d && "value" in d; }), "rpc.sources");
  const ids = new Set<unknown>(), operators = new Set<unknown>(), accounts = new Set<unknown>();
  for (const [i, value] of rpc.sources.entries()) {
    const s = object(value, ["id", "operatorReference", "accountReference", "endpointSecretReference", "acceptanceEvidenceReference"], `rpc.sources.${i}`);
    for (const [field, kind, values] of [["id", "service", ids], ["operatorReference", "owner", operators], ["accountReference", "account", accounts]] as const) {
      reference(s[field], kind, `rpc.sources.${i}.${field}`); check(!values.has(s[field]), `rpc.sources.${i}.${field}`); values.add(s[field]);
    }
    secret(s.endpointSecretReference, `rpc.sources.${i}.endpointSecretReference`);
    reference(s.acceptanceEvidenceReference, "evidence", `rpc.sources.${i}.acceptanceEvidenceReference`);
  }
  equal(rpc.readLimitsVersion, GENERATIVE_READ_LIMITS.version, "rpc.readLimitsVersion");
  integer(rpc.jsonResponseBytes, 2 * GENERATIVE_READ_LIMITS.artworkAbiBytes + 1024, 1_048_576, "rpc.jsonResponseBytes");
  integer(rpc.timeoutMs, 1000, hosting.requestTimeoutMs as number, "rpc.timeoutMs");
  integer(rpc.maxHeadAgeMs, 1000, 300000, "rpc.maxHeadAgeMs");
  integer(rpc.maxFinalizedAgeMs, rpc.maxHeadAgeMs as number, 3600000, "rpc.maxFinalizedAgeMs");
  integer(rpc.maxFutureSkewMs, 0, 30000, "rpc.maxFutureSkewMs");
  integer(rpc.evidenceTtlMs, 1, Math.min(30000, rpc.maxHeadAgeMs as number), "rpc.evidenceTtlMs");
  const custody = object(c.custody, OPERATING_PRINCIPALS, "custody");
  for (const name of OPERATING_PRINCIPALS) {
    const principal = object(custody[name], ["address", "ownerReference", "custodyPolicyReference", "signerSecretReference"], `custody.${name}`);
    equal(principal.address, binding.principals[name].address, `custody.${name}.address`);
    equal(principal.ownerReference, binding.principals[name].ownerReference, `custody.${name}.ownerReference`);
    // Deployment tooling has its own established owner-reference syntax.
    reference(principal.custodyPolicyReference, "policy", `custody.${name}.custodyPolicyReference`);
    secret(principal.signerSecretReference, `custody.${name}.signerSecretReference`);
  }
  const a = object(c.assessment, ["profileReference", "profileSha256", "xCredentialReference", "xaiCredentialReference", "pricingReviewReference", "spendingPolicyReference", "validFrom", "validUntil", "dailyAttempts", "totalAttempts", "maxActive", "maxQueued", "reservationUsdTicks", "maxExposureUsdTicks", "automaticRetries", "preserveUnknownExposure"], "assessment");
  reference(a.profileReference, "policy", "assessment.profileReference"); hash(a.profileSha256, "assessment.profileSha256");
  secret(a.xCredentialReference, "assessment.xCredentialReference"); secret(a.xaiCredentialReference, "assessment.xaiCredentialReference");
  reference(a.pricingReviewReference, "evidence", "assessment.pricingReviewReference"); reference(a.spendingPolicyReference, "policy", "assessment.spendingPolicyReference");
  const start = timestamp(a.validFrom, "assessment.validFrom"), end = timestamp(a.validUntil, "assessment.validUntil");
  check(end > start && end - start <= 31 * 86400000, "assessment.validity window");
  integer(a.dailyAttempts, 1, 1000, "assessment.dailyAttempts"); integer(a.totalAttempts, a.dailyAttempts as number, 1000000, "assessment.totalAttempts");
  equal(a.maxActive, 1, "assessment.maxActive"); integer(a.maxQueued, 0, Math.min(100, a.totalAttempts as number), "assessment.maxQueued");
  check(decimal(a.reservationUsdTicks, "assessment.reservationUsdTicks") <= decimal(a.maxExposureUsdTicks, "assessment.maxExposureUsdTicks"), "assessment.exposure");
  equal(a.automaticRetries, 0, "assessment.automaticRetries"); equal(a.preserveUnknownExposure, true, "assessment.preserveUnknownExposure");
  const op = object(c.operations, ["supportReference", "incidentPolicyReference", "securityReviewReference", "compatibilityEvidenceReference", "finalityPolicyReference", "reveal", "gallery", "staleEvidence", "signerCompromise"], "operations");
  for (const [field, kind] of [["supportReference", "service"], ["incidentPolicyReference", "policy"], ["securityReviewReference", "evidence"], ["compatibilityEvidenceReference", "evidence"], ["finalityPolicyReference", "policy"]]) reference(op[field], kind, `operations.${field}`);
  for (const [field, v] of Object.entries({ reveal: "canonical-inclusion-confirming", gallery: "finalized-only", staleEvidence: "stop-new-effects", signerCompromise: "never-restore" })) equal(op[field], v, `operations.${field}`);
  const settings = JSON.parse(JSON.stringify(input)) as OperatingSettings;
  const body = { schema: "sg-sepolia-operating-plan-v1" as const, status: "declared-only-not-admitted" as const, settings,
    releaseLockSha256: binding.releaseLockSha256, collectionRuntimeCodeHash: binding.collectionRuntimeCodeHash,
    readLimits: { ...GENERATIVE_READ_LIMITS },
    observedDeployment: false, evidenceVerified: false, custodyVerified: false, providerIndependenceVerified: false,
    paidDispatchAllowed: false, signingAllowed: false, publicBroadcastAllowed: false, runtimeAdmissionAllowed: false, activationAllowed: false } as const;
  return freeze({ ...body, operatingPlanSha256: createHash("sha256").update(canonicalize(body)!).digest("hex") });
}
