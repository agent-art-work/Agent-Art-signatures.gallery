import { createHash } from "node:crypto";
import { GENERATIVE_DATABASE_V2_LOCK, GENERATIVE_DATABASE_V2_MIGRATIONS } from "./databaseSchemaV2Lock.js";
import { verifyGenerativeDatabaseCertification, verifyGenerativeV2Database,
  type DatabaseCertificationReview, type DatabaseV2Review } from "./databaseCertification.js";
import { stagingInspectorGrants } from "./stagingOperatorRole.js";
import { stagingRecoveryGrants } from "./runtimeRole.js";
import { WRITER_LOCK, type OwnershipConnectionFactory } from "./writer.js";
import type { RoleAuditConnection } from "./roleAudit.js";

export class StagingMigrationError extends Error {
  constructor(readonly outcome: "not-committed" | "unknown" | "committed-unverified") {
    super(`Staging migration ${outcome}; keep services stopped and inspect before any further action.`);
    this.name = "StagingMigrationError";
  }
}
const requireTrue = (value: unknown) => { if (!value) throw new Error("Migration precondition failed"); };

/** Internal, explicit one-shot upgrade. The caller authenticates BOTH connections
 * to the same reviewed installation and supplies independently reviewed pins and
 * known-complete stopped-backup custody evidence. Hashes here bind that evidence;
 * they do not authenticate its issuer or fence a restored clone. R5 owns custody.
 * Never call at site startup. No role creation, discovery, retry or down migration. */
export async function migrateStagingDatabaseV2(config: {
  connectMigrator: OwnershipConnectionFactory;
  browserCatalog: RoleAuditConnection;
  sourceReview: DatabaseCertificationReview;
  targetReview: DatabaseV2Review;
  migrationSql: string;
  stoppedBackup: { version: "sg-stopped-backup-review-v1"; databaseBindingSha256: string;
    archiveSha256: string; completionRevisionSha256: string };
}, signal = new AbortController().signal) {
  const source = Object.freeze({ ...config.sourceReview }), target = Object.freeze({ ...config.targetReview });
  const backup = Object.freeze({ ...config.stoppedBackup }), sql = config.migrationSql;
  let connection: ReturnType<OwnershipConnectionFactory> | undefined;
  let committing = false, committed = false;
  try {
    signal.throwIfAborted();
    requireTrue(target.version === "sg-generative-paused-db-review-v2"
      && Object.keys(target).sort().join() === [...Object.keys(source),"version","inspectorRole","recoveryRole"].sort().join()
      && target.migrationManifestSha256===GENERATIVE_DATABASE_V2_LOCK.migrationManifestSha256
      && [target.migrationReceiptSha256,target.reviewRevisionSha256].every(value=>/^(?!0{64}$)[0-9a-f]{64}$/.test(value))
      && new Set([target.ownerRole,target.runtimeRole,target.inspectorRole,target.recoveryRole]).size===4
      && ["database","namespaceId","deploymentId","ownerRole","runtimeRole","profilesSha256"].every(
        key => source[key as keyof DatabaseCertificationReview] === target[key as keyof DatabaseV2Review]));
    requireTrue(typeof sql === "string" && createHash("sha256").update(sql).digest("hex") === GENERATIVE_DATABASE_V2_MIGRATIONS.at(-1)!.sha256);
    requireTrue(backup.version === "sg-stopped-backup-review-v1"
      && [backup.databaseBindingSha256,backup.archiveSha256,backup.completionRevisionSha256]
        .every(value => /^(?!0{64}$)[0-9a-f]{64}$/.test(value)));
    // Only this locked source can reach stripping: no arbitrary SQL rewriting.
    const body = sql.replace(/^BEGIN;$/m, "").replace(/COMMIT;\s*$/, "");
    connection = config.connectMigrator();
    await connection.connect();
    connection.on("error", () => {}); // query failures still abort; never reconnect
    await connection.query("BEGIN; SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'; SET LOCAL idle_in_transaction_session_timeout='5s'; SET LOCAL synchronous_commit='on'");
    const identity = (await connection.query(`SELECT current_user AS role,session_user AS login,current_database() AS database,
      current_setting('fsync') AS fsync,pg_backend_pid() AS pid,
      pg_try_advisory_xact_lock($1,$2) AS held`, [...WRITER_LOCK])).rows[0];
    requireTrue(identity?.role === source.ownerRole && identity.login === source.ownerRole
      && identity.database === source.database && identity.fsync === "on" && identity.held === true);
    const same = (await config.browserCatalog.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
      WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND objsubid=2 AND granted AND pid=$3
      AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())) AS held`,
      [...WRITER_LOCK,identity.pid])).rows[0];
    requireTrue(same?.held === true);
    const roles=(await connection.query(`SELECT rolname FROM pg_catalog.pg_roles r
      WHERE rolname=ANY($1::text[]) AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb
        AND NOT rolcreaterole AND NOT rolreplication AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE r.oid IN(m.member,m.roleid))
        AND NOT pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))`,
      [[target.inspectorRole,target.recoveryRole]])).rows;
    requireTrue(roles.length===2);
    const tables = (await connection.query(`SELECT tablename FROM pg_catalog.pg_tables
      WHERE schemaname='open_mint' ORDER BY tablename COLLATE pg_catalog."C"`)).rows;
    requireTrue(tables.length > 0 && tables.length <= 64 && tables.every(t => /^[a-z][a-z0-9_]+$/.test(t.tablename)));
    await connection.query(`LOCK TABLE ${tables.map(t => `open_mint."${t.tablename}"`).join(",")} IN SHARE MODE`);
    const certified = await verifyGenerativeDatabaseCertification(config.browserCatalog,source,signal);
    requireTrue(certified.databaseBindingSha256 === backup.databaseBindingSha256);
    signal.throwIfAborted();
    await connection.query(body);
    await connection.query(stagingInspectorGrants(target.inspectorRole));
    await connection.query(stagingRecoveryGrants(target.recoveryRole));
    signal.throwIfAborted();
    committing = true;
    await connection.query("COMMIT");
    committed = true;
    const result = await verifyGenerativeV2Database(config.browserCatalog,target,signal);
    return Object.freeze({ status: "upgraded-paused" as const, databaseBindingSha256: result.databaseBindingSha256,
      archiveSha256: backup.archiveSha256, completionRevisionSha256: backup.completionRevisionSha256 });
  } catch {
    throw new StagingMigrationError(committed ? "committed-unverified" : committing ? "unknown" : "not-committed");
  } finally {
    // Closing rolls back pre-COMMIT work. An uncertain commit is never replayed.
    try { await connection?.end(); }
    catch { throw new StagingMigrationError(committed ? "committed-unverified" : committing ? "unknown" : "not-committed"); }
  }
}
