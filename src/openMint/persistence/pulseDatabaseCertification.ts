import { createHash } from "node:crypto";
import { GENERATIVE_DATABASE_CATALOG_SQL } from "./databaseCatalog.js";
import { auditPulseBrowserRole, type RoleAuditConnection } from "./roleAudit.js";

/** Isolated C6 installation only, NOT an R5/hosted startup certificate.
 * Full catalog includes columns, constraints, index/trigger/function bodies,
 * enabled flags, ownership and policies. Historical locks are not amended. */
export const PULSE_LOCAL_SCHEMA_SHA256 = "e804e32948c2b4cb999d839144e326846bd461094d75229bc192187f5b540a87";
// Reuse the exact existing schema-document serialization, but stop before its
// ACL/profile CTEs. Recovery can inspect metadata without reading app tables.
const boundary = GENERATIVE_DATABASE_CATALOG_SQL.indexOf("\nacl_objects(");
if (boundary < 0 || !GENERATIVE_DATABASE_CATALOG_SQL.slice(0,boundary).endsWith(",")) throw new Error("Database catalog layout changed; review the Pulse reader.");
const schemaSql = GENERATIVE_DATABASE_CATALOG_SQL.slice(0,boundary).slice(0,-1).replaceAll("$2::regrole","$1::regrole") +
  '\nSELECT (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) ORDER BY kind COLLATE "C",name COLLATE "C",value::text COLLATE "C")::text FROM items i) AS schema';
export async function inspectPulseLocalSchema(connection: RoleAuditConnection, ownerRole: string, namespaceId: string, deploymentId: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(ownerRole)) throw new Error("Invalid Pulse database owner.");
  const current = await connection.query("SELECT current_user::text AS role, pg_catalog.current_setting('search_path') AS path, pg_catalog.current_setting('server_version_num') AS version");
  const row = current.rows[0];
  if (current.rows.length !== 1 || row.path !== "pg_catalog" || !/^16\d{4}$/.test(String(row.version))) throw new Error("Pulse local certification requires PostgreSQL 16 and a catalog-only search path.");
  const catalog = await connection.query(schemaSql,[ownerRole]);
  const schema = catalog.rows[0]?.schema;
  if (catalog.rows.length !== 1 || typeof schema !== "string" || Buffer.byteLength(schema) > 1048576) throw new Error("Pulse database catalog unavailable.");
  return { schemaSha256: createHash("sha256").update(schema).digest("hex") };
}
export async function certifyPulseLocalDatabase(connection: RoleAuditConnection, ownerRole: string, namespaceId: string, deploymentId: string) {
  if (!(await auditPulseBrowserRole(connection)).ok) throw new Error("Pulse browser role certification failed.");
  const result = await inspectPulseLocalSchema(connection, ownerRole, namespaceId, deploymentId);
  if (result.schemaSha256 !== PULSE_LOCAL_SCHEMA_SHA256) throw new Error("Pulse local schema certification failed.");
  return Object.freeze({version:"sg-pulse-local-db-certification-v1", ...result, publicStartupApproved:false});
}
