import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { admissionDigest } from "../staging/admission.js";
import { GENERATIVE_DATABASE_CATALOG_SQL, GENERATIVE_RUNTIME_DATABASE_CATALOG_SQL,
  GENERATIVE_DATABASE_CATALOG_V2_SQL, GENERATIVE_RUNTIME_DATABASE_CATALOG_V2_SQL } from "./databaseCatalog.js";
import { GENERATIVE_DATABASE_LOCK } from "./databaseSchemaLock.js";
import { GENERATIVE_DATABASE_V2_LOCK } from "./databaseSchemaV2Lock.js";
import { RUNTIME_ROLE_AUDIT_CHECKS, type RoleAuditConnection } from "./roleAudit.js";
import { GENERATIVE_BROWSER_RUNTIME_PRIVILEGES } from "./runtimeRole.js";

export interface DatabaseTarget {
  readonly database: string;
  readonly ownerRole: string;
  readonly runtimeRole: string;
  readonly namespaceId: string;
  readonly deploymentId: string;
}
/** Trusted, separately reviewed configuration, not HTTP input. Receipt/review
 * hashes bind external evidence; this reader does NOT verify its authenticity
 * or prove that the historical migration sequence actually ran. */
export interface DatabaseCertificationReview extends DatabaseTarget {
  readonly migrationManifestSha256: string;
  readonly migrationReceiptSha256: string;
  readonly profilesSha256: string;
  readonly reviewRevisionSha256: string;
}
export interface RuntimeDatabaseReview extends DatabaseCertificationReview {
  readonly version: "sg-generative-runtime-db-review-v1";
}
export interface DatabaseV2Target extends DatabaseTarget { readonly inspectorRole: string; readonly recoveryRole: string }
export interface DatabaseV2Review extends DatabaseV2Target {
  readonly version: "sg-generative-runtime-db-review-v2" | "sg-generative-paused-db-review-v2";
  readonly migrationManifestSha256: string; readonly migrationReceiptSha256: string;
  readonly profilesSha256: string; readonly reviewRevisionSha256: string;
}
export class DatabaseCertificationError extends Error {
  constructor() { super("Database certification unavailable or mismatched."); this.name = "DatabaseCertificationError"; }
}
const check = (ok: unknown): void => { if (!ok) throw new DatabaseCertificationError(); };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const digest = (v: unknown) => typeof v === "string" && /^(?!0{64}$)[0-9a-f]{64}$/.test(v);
const targetFields = ["database", "ownerRole", "runtimeRole", "namespaceId", "deploymentId"] as const;
const reviewFields = [...targetFields, "migrationManifestSha256", "migrationReceiptSha256", "profilesSha256", "reviewRevisionSha256"];
function fields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  check(Object.keys(value as object).sort().join() === [...keys].sort().join());
}
function captureTarget(input: DatabaseTarget): Readonly<DatabaseTarget> {
  const v = Object.fromEntries(targetFields.map(k => [k, input[k]])) as unknown as DatabaseTarget;
  for (const k of ["database", "ownerRole", "runtimeRole"] as const)
    check(typeof v[k] === "string" && /^(?!pg_)(?!public$)[a-z][a-z0-9_]{0,62}$/.test(v[k]));
  for (const k of ["namespaceId", "deploymentId"] as const)
    check(typeof v[k] === "string" && /^(?!0{8}-0{4}-0{4}-0{4}-0{12}$)[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v[k]));
  check(v.ownerRole !== v.runtimeRole);
  return Object.freeze(Object.fromEntries(targetFields.map(k => [k, v[k]]))) as unknown as Readonly<DatabaseTarget>;
}
function settings(v: Record<string, unknown>) {
  const timeout = typeof v.timeout === "string" ? /^(\d+)(ms|s)?$/.exec(v.timeout) : null;
  const ms = timeout ? Number(timeout[1]) * (timeout[2] === "s" ? 1000 : 1) : NaN;
  check(typeof v.version === "string" && /^16\d{4}$/.test(v.version) && v.path === "pg_catalog"
    && Number.isSafeInteger(ms) && ms >= 1 && ms <= 5000);
}
function text(v: unknown, max: number): string {
  check(typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= max); return v as string;
}
const auditFields = RUNTIME_ROLE_AUDIT_CHECKS;
const observedProfiles = new WeakMap<object, string>(), certifiedProfiles = new WeakMap<object, string>();

/** Internal composition only: retrieve exact numeric-preserving profile text
 * from a real successful check, not a copied/serialized observation. This is
 * still a read-only snapshot, never an operation permit or custody proof. */
export function readCertifiedDatabaseProfiles(result: unknown): string {
  const value = result && typeof result === "object" ? certifiedProfiles.get(result) : undefined;
  check(typeof value === "string"); return value!;
}

async function observe(connection: RoleAuditConnection, target: Readonly<DatabaseTarget>, signal: AbortSignal, timeoutMs: number, runtime = false,
  v2?: Readonly<DatabaseV2Target>) {
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 10000 && !signal.aborted);
  const started = performance.now(), wall = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined, abort!: () => void;
  const live = () => check(!signal.aborted && performance.now() - started < timeoutMs && Date.now() >= wall && Date.now() - wall < timeoutMs);
  try {
    const work = async () => {
      live();
      const probe = await connection.query(`SELECT pg_catalog.current_setting('server_version_num') AS version,
        pg_catalog.current_setting('search_path') AS path, pg_catalog.current_setting('statement_timeout') AS timeout`);
      live(); check(probe.rows.length === 1); fields(probe.rows[0], ["version", "path", "timeout"]); settings(probe.rows[0]);
      const result = await connection.query(v2 ? (runtime ? GENERATIVE_RUNTIME_DATABASE_CATALOG_V2_SQL : GENERATIVE_DATABASE_CATALOG_V2_SQL)
        : (runtime ? GENERATIVE_RUNTIME_DATABASE_CATALOG_SQL : GENERATIVE_DATABASE_CATALOG_SQL),
        [JSON.stringify(GENERATIVE_BROWSER_RUNTIME_PRIVILEGES), target.ownerRole, target.runtimeRole, target.namespaceId, target.deploymentId,
          ...(v2 ? [v2.inspectorRole, v2.recoveryRole] : [])]);
      live(); check(result.rows.length === 1);
      const row = result.rows[0]; fields(row, ["schema", "grants", "profiles", "audit", "identity", "supported", "staged", ...(runtime ? ["generation_enabled", "issuance_enabled"] : [])]);
      check(row.supported === true && row.staged === true);
      if (runtime) check(typeof row.generation_enabled === "boolean" && typeof row.issuance_enabled === "boolean");
      const audit = JSON.parse(text(row.audit, 4096)); fields(audit, auditFields); check(auditFields.every(k => audit[k] === true));
      const identity = JSON.parse(text(row.identity, 4096));
      fields(identity, ["database", "runtimeRole", "sessionRole", "ownerRole", "databaseOwner", "encoding", "version", "path", "timeout",
        "timezone", "replication", "fsync", "commit", "strings", "rowSecurity"]);
      settings(identity);
      check(identity.database === target.database && identity.runtimeRole === target.runtimeRole && identity.sessionRole === target.runtimeRole
        && identity.ownerRole === target.ownerRole && identity.databaseOwner === target.ownerRole && identity.encoding === "UTF8"
        && identity.timezone === "UTC" && identity.replication === "origin" && identity.fsync === "on"
        && (identity.commit === "on" || identity.commit === "remote_apply") && identity.strings === "on" && identity.rowSecurity === "on");
      // Hash PostgreSQL text directly. Policy NUMERIC/BIGINT values must never
      // make a round trip through JavaScript Number (or its JSON decoder).
      const observation = Object.freeze({ kind: runtime ? "generative-runtime-database-observation-v1" as const : "generative-database-observation-v1" as const,
        target, schemaSha256: sha256(text(row.schema, 1048576)), grantsSha256: sha256(text(row.grants, 524288)),
        profilesSha256: sha256(text(row.profiles, 65536)), identitySha256: sha256(row.identity as string),
        observedAt: Date.now(), approved: false as const, publicStartup: false as const,
        ...(runtime ? { generationEnabled: row.generation_enabled as boolean, issuanceEnabled: row.issuance_enabled as boolean } : {}) });
      live(); observedProfiles.set(observation, row.profiles as string); return observation;
    };
    const deadline = new Promise<never>((_, reject) => {
      abort = () => reject(new DatabaseCertificationError());
      signal.addEventListener("abort", abort, { once: true }); timer = setTimeout(abort, timeoutMs);
    });
    return await Promise.race([work(), deadline]);
  } catch { throw new DatabaseCertificationError(); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

/** Read-only offline review evidence. Never auto-pin this result at startup.
 * Caller owns/authenticates a serialized, bounded PG connection. Catalog and
 * role/profile observations share ONE statement snapshot. Cancellation cannot
 * close that caller's connection; its own statement timeout bounds DB work. */
export async function observeGenerativeDatabase(connection: RoleAuditConnection, input: DatabaseTarget,
  signal = new AbortController().signal, timeoutMs = 5000) {
  try { fields(input, targetFields); return await observe(connection, captureTarget(input), signal, timeoutMs); }
  catch { throw new DatabaseCertificationError(); }
}

/** Narrow certification check, NOT a permit. Static source/catalog/grant locks
 * plus externally reviewed staging profile/receipt binding; no migrations,
 * connections, key loading, writes, provider calls or public startup. Current
 * schema cannot prove past migration history, DB host identity or custody. */
export async function verifyGenerativeDatabaseCertification(connection: RoleAuditConnection, input: DatabaseCertificationReview,
  signal = new AbortController().signal, timeoutMs = 5000) {
  try {
    fields(input, reviewFields);
    const review = Object.freeze({ ...input }); // capture each value once, before validation and asynchronous work
    const target = captureTarget(review);
    check(reviewFields.filter(k => !targetFields.includes(k as typeof targetFields[number])).every(k => digest(review[k as keyof DatabaseCertificationReview])));
    check(review.migrationManifestSha256 === GENERATIVE_DATABASE_LOCK.migrationManifestSha256);
    const result = await observe(connection, target, signal, timeoutMs);
    check(result.schemaSha256 === GENERATIVE_DATABASE_LOCK.schemaSha256 && result.grantsSha256 === GENERATIVE_DATABASE_LOCK.grantsSha256
      && result.profilesSha256 === review.profilesSha256);
    const matched = Object.freeze({ ...result, kind: "generative-database-match-v1" as const,
      databaseBindingSha256: admissionDigest({ lock: GENERATIVE_DATABASE_LOCK, review }),
      reviewRevisionSha256: review.reviewRevisionSha256, migrationReceiptSha256: review.migrationReceiptSha256 });
    certifiedProfiles.set(matched, observedProfiles.get(result)!); return matched;
  } catch { throw new DatabaseCertificationError(); }
}

/** Distinct runtime observation: only the two live kill switches are excluded
 * from static policy text, and BOTH are returned from the SAME SQL snapshot.
 * Observation is not activation, custody approval or operation admission. */
export async function observeGenerativeRuntimeDatabase(connection: RoleAuditConnection, input: DatabaseTarget,
  signal = new AbortController().signal, timeoutMs = 5000) {
  try { fields(input, targetFields); return await observe(connection, captureTarget(input), signal, timeoutMs, true); }
  catch { throw new DatabaseCertificationError(); }
}
export async function verifyGenerativeRuntimeDatabase(connection: RoleAuditConnection, input: RuntimeDatabaseReview,
  signal = new AbortController().signal, timeoutMs = 5000) {
  try {
    fields(input, [...reviewFields, "version"]); const review = Object.freeze({ ...input });
    check(review.version === "sg-generative-runtime-db-review-v1"); const target = captureTarget(review);
    check(reviewFields.filter(k => !targetFields.includes(k as typeof targetFields[number])).every(k => digest(review[k as keyof RuntimeDatabaseReview])));
    check(review.migrationManifestSha256 === GENERATIVE_DATABASE_LOCK.migrationManifestSha256);
    const result = await observe(connection, target, signal, timeoutMs, true);
    check(result.schemaSha256 === GENERATIVE_DATABASE_LOCK.schemaSha256 && result.grantsSha256 === GENERATIVE_DATABASE_LOCK.grantsSha256
      && result.profilesSha256 === review.profilesSha256);
    const matched = Object.freeze({ ...result, kind: "generative-runtime-database-match-v1" as const,
      databaseBindingSha256: admissionDigest({ version: review.version, lock: GENERATIVE_DATABASE_LOCK, review }) });
    certifiedProfiles.set(matched, observedProfiles.get(result)!); return matched;
  } catch { throw new DatabaseCertificationError(); }
}

const v2TargetFields = [...targetFields, "inspectorRole", "recoveryRole"] as const;
const v2ReviewFields = [...v2TargetFields, "version", "migrationManifestSha256", "migrationReceiptSha256", "profilesSha256", "reviewRevisionSha256"] as const;
function captureV2(input: DatabaseV2Target): Readonly<DatabaseV2Target> {
  const base = captureTarget(input);
  for (const role of [input.inspectorRole, input.recoveryRole])
    check(typeof role === "string" && /^(?!pg_)(?!public$)[a-z][a-z0-9_]{0,62}$/.test(role));
  check(new Set([base.ownerRole, base.runtimeRole, input.inspectorRole, input.recoveryRole]).size === 4);
  return Object.freeze({ ...base, inspectorRole: input.inspectorRole, recoveryRole: input.recoveryRole });
}

/** Opt-in v2 observation. V1 functions above keep their exact lock and review. */
export async function observeGenerativeV2Database(connection: RoleAuditConnection, input: DatabaseV2Target,
  signal = new AbortController().signal, timeoutMs = 5000, runtime = false) {
  try { fields(input, v2TargetFields); const target = captureV2(input);
    return await observe(connection, target, signal, timeoutMs, runtime, target);
  } catch { throw new DatabaseCertificationError(); }
}
export async function verifyGenerativeV2Database(connection: RoleAuditConnection, input: DatabaseV2Review,
  signal = new AbortController().signal, timeoutMs = 5000) {
  try {
    fields(input, v2ReviewFields); const review = Object.freeze({ ...input }), target = captureV2(review);
    check(review.version === "sg-generative-runtime-db-review-v2" || review.version === "sg-generative-paused-db-review-v2");
    check([review.migrationManifestSha256, review.migrationReceiptSha256, review.profilesSha256, review.reviewRevisionSha256].every(digest));
    check(review.migrationManifestSha256 === GENERATIVE_DATABASE_V2_LOCK.migrationManifestSha256);
    const runtime = review.version === "sg-generative-runtime-db-review-v2";
    const result = await observe(connection, target, signal, timeoutMs, runtime, target);
    check(result.schemaSha256 === GENERATIVE_DATABASE_V2_LOCK.schemaSha256
      && result.grantsSha256 === GENERATIVE_DATABASE_V2_LOCK.grantsSha256
      && result.profilesSha256 === review.profilesSha256);
    const matched = Object.freeze({ ...result, kind: runtime ? "generative-runtime-database-match-v2" as const : "generative-database-match-v2" as const,
      databaseBindingSha256: admissionDigest({ lock: GENERATIVE_DATABASE_V2_LOCK, review }),
      reviewRevisionSha256: review.reviewRevisionSha256, migrationReceiptSha256: review.migrationReceiptSha256 });
    certifiedProfiles.set(matched, observedProfiles.get(result)!); return matched;
  } catch { throw new DatabaseCertificationError(); }
}

/** Closed trusted-profile selector; never infer a version from the catalog. */
export type SelectedRuntimeDatabaseReview = RuntimeDatabaseReview | (DatabaseV2Review & { version: "sg-generative-runtime-db-review-v2" });
export async function verifySelectedRuntimeDatabase(connection: RoleAuditConnection, input: SelectedRuntimeDatabaseReview,
  signal = new AbortController().signal, timeoutMs = 5000) {
  if (input.version === "sg-generative-runtime-db-review-v1")
    return verifyGenerativeRuntimeDatabase(connection, input, signal, timeoutMs);
  if (input.version === "sg-generative-runtime-db-review-v2")
    return verifyGenerativeV2Database(connection, input, signal, timeoutMs);
  throw new DatabaseCertificationError();
}
export async function verifySelectedPausedDatabase(connection: RoleAuditConnection,
  input: DatabaseCertificationReview | (DatabaseV2Review & { version: "sg-generative-paused-db-review-v2" }),
  signal = new AbortController().signal, timeoutMs = 5000) {
  if ("version" in input) {
    if (input.version !== "sg-generative-paused-db-review-v2") throw new DatabaseCertificationError();
    return verifyGenerativeV2Database(connection, input, signal, timeoutMs);
  }
  return verifyGenerativeDatabaseCertification(connection, input, signal, timeoutMs);
}
