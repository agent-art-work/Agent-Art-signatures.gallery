import { FOUNDATION_RUNTIME_PRIVILEGES, PREPARATION_RUNTIME_PRIVILEGES, PROJECTION_RUNTIME_PRIVILEGES, GENERATIVE_RUNTIME_PRIVILEGES, GENERATIVE_BROWSER_RUNTIME_PRIVILEGES, GENERATIVE_RECOVERY_PRIVILEGES, STAGING_RECOVERY_PRIVILEGES, type RuntimeTablePrivileges } from "./runtimeRole.js";
import { PULSE_BROWSER_PRIVILEGES, PULSE_RECOVERY_PRIVILEGES } from "./runtimeRole.js";

/** Connected, bounded catalog-read interface. The caller owns connection/auth
 * and statement timeout. This module never connects, SETs, grants, or writes. */
export interface RoleAuditConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const RUNTIME_ROLE_AUDIT_CHECKS = Object.freeze(["postgresVersion", "identity", "restrictedRoles", "noRoleDelegation", "noOwnership", "noCreation",
  "noSecurityDefiner", "noParameterEscalation", "foundationLayout", "requiredPrivileges", "noExtraPrivileges", "noGrantOptions"] as const);
const CHECKS = RUNTIME_ROLE_AUDIT_CHECKS;
export type FoundationRoleCheck = typeof CHECKS[number];
export interface FoundationRoleAudit {
  readonly scope: "open-mint-foundation-role-v1";
  readonly ok: boolean;
  readonly checks: Readonly<Record<FoundationRoleCheck, boolean>>;
  readonly failedChecks: readonly FoundationRoleCheck[];
}
export interface PreparationRoleAudit extends Omit<FoundationRoleAudit, "scope"> {
  readonly scope: "open-mint-preparation-role-v1";
}
export interface ProjectionRoleAudit extends Omit<FoundationRoleAudit, "scope"> {
  readonly scope: "open-mint-projection-role-v1";
}
export interface GenerativeRoleAudit extends Omit<FoundationRoleAudit, "scope"> { readonly scope: "open-mint-generative-role-v1" }
export class DatabaseRoleAuditError extends Error {
  constructor() { super("Foundation database role audit unavailable or rejected."); this.name = "DatabaseRoleAuditError"; }
}

// A single MVCC catalog statement avoids piecing together privileges observed at
// different statements. Fully qualify catalog functions to resist search_path
// shadowing. MEMBER deliberately includes NOINHERIT/SET ROLE paths; membership
// options that might make a path unusable are not a reason to weaken this audit.
/** Internal SQL fragment, also embedded in the single-snapshot structural audit.
 * Parameter $1 is the exact runtime privilege profile. Never accept request SQL. */
export const RUNTIME_ROLE_AUDIT_SQL = `WITH
expected AS (SELECT * FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS e(name text, columns text[], "insert" boolean, updates text[], "delete" boolean)),
roles AS (SELECT oid, rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_catalog.pg_roles
  WHERE rolname = current_user OR pg_catalog.pg_has_role(current_user, oid, 'MEMBER')),
objects AS (SELECT e.*, c.oid, c.relkind, c.relpersistence FROM expected e
  LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = 'open_mint'
  LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = e.name),
columns AS (SELECT o.*, a.attname, a.attnum FROM objects o JOIN pg_catalog.pg_attribute a ON a.attrelid = o.oid
  WHERE a.attnum > 0 AND NOT a.attisdropped),
table_permissions AS (SELECT r.oid AS role_oid, o.oid, o.name, p.permission,
  (p.permission = 'SELECT' OR (p.permission = 'INSERT' AND o."insert") OR (p.permission = 'DELETE' AND COALESCE(o."delete", false))) AS allowed
  FROM roles r CROSS JOIN objects o CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(permission)),
column_permissions AS (SELECT r.oid AS role_oid, c.oid, c.attnum, p.permission,
  (p.permission = 'SELECT' OR (p.permission = 'INSERT' AND c."insert") OR (p.permission = 'UPDATE' AND c.attname = ANY(c.updates))) AS allowed
  FROM roles r CROSS JOIN columns c CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(permission))
SELECT
  (pg_catalog.current_setting('server_version_num')::integer BETWEEN 160000 AND 169999) AS "postgresVersion",
  (current_user = session_user AND EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid = a.usesysid
    WHERE a.pid = pg_catalog.pg_backend_pid() AND r.rolname = current_user)) AS identity,
  NOT EXISTS (SELECT 1 FROM roles WHERE rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolname LIKE 'pg\\_%' ESCAPE '\\') AS "restrictedRoles",
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN roles r ON r.oid = m.member WHERE m.admin_option) AS "noRoleDelegation",
  NOT (EXISTS (SELECT 1 FROM pg_catalog.pg_database d JOIN roles r ON r.oid = d.datdba WHERE d.datname = pg_catalog.current_database())
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n JOIN roles r ON r.oid = n.nspowner WHERE n.nspname !~ '^pg_(toast_)?temp_')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN roles r ON r.oid = c.relowner JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname !~ '^pg_(toast_)?temp_')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN roles r ON r.oid = p.proowner JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname !~ '^pg_(toast_)?temp_')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_type t JOIN roles r ON r.oid = t.typowner JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname !~ '^pg_(toast_)?temp_')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_extension e JOIN roles r ON r.oid = e.extowner)) AS "noOwnership",
  NOT (EXISTS (SELECT 1 FROM roles r WHERE pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CREATE'))
    OR EXISTS (SELECT 1 FROM roles r CROSS JOIN pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_(toast_)?temp_' AND pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE'))) AS "noCreation",
  NOT EXISTS (SELECT 1 FROM roles r CROSS JOIN pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast_)?temp_'
    AND pg_catalog.has_schema_privilege(r.oid, n.oid, 'USAGE') AND pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')) AS "noSecurityDefiner",
  NOT (EXISTS (SELECT 1 FROM roles r WHERE pg_catalog.has_parameter_privilege(r.oid, 'session_replication_role', 'SET'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_parameter_acl p CROSS JOIN LATERAL pg_catalog.aclexplode(p.paracl) a
      LEFT JOIN pg_catalog.pg_settings s ON s.name = p.parname
      WHERE (a.grantee = 0 OR a.grantee IN (SELECT oid FROM roles)) AND
      (a.is_grantable OR a.privilege_type = 'ALTER SYSTEM' OR (a.privilege_type = 'SET' AND s.context IS DISTINCT FROM 'user')))) AS "noParameterEscalation",
  NOT EXISTS (SELECT 1 FROM objects o WHERE o.oid IS NULL OR o.relkind <> 'r' OR o.relpersistence <> 'p'
    OR o.columns IS DISTINCT FROM (SELECT pg_catalog.array_agg(c.attname::text ORDER BY c.attname::text COLLATE pg_catalog."C") FROM columns c WHERE c.oid = o.oid)) AS "foundationLayout",
  (EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = 'open_mint' AND pg_catalog.has_schema_privilege(current_user, n.oid, 'USAGE'))
    AND NOT EXISTS (SELECT 1 FROM objects o WHERE NOT COALESCE(pg_catalog.has_table_privilege(current_user, o.oid, 'SELECT'), false)
      OR (o."insert" AND NOT COALESCE(pg_catalog.has_table_privilege(current_user, o.oid, 'INSERT'), false))
      OR (COALESCE(o."delete", false) AND NOT COALESCE(pg_catalog.has_table_privilege(current_user, o.oid, 'DELETE'), false)))
    AND NOT EXISTS (SELECT 1 FROM columns c WHERE c.attname = ANY(c.updates) AND NOT pg_catalog.has_column_privilege(current_user, c.oid, c.attnum, 'UPDATE'))) AS "requiredPrivileges",
  NOT (EXISTS (SELECT 1 FROM table_permissions p WHERE NOT p.allowed AND pg_catalog.has_table_privilege(p.role_oid, p.oid, p.permission))
    OR EXISTS (SELECT 1 FROM column_permissions p WHERE NOT p.allowed AND pg_catalog.has_column_privilege(p.role_oid, p.oid, p.attnum, p.permission))) AS "noExtraPrivileges",
  NOT (EXISTS (SELECT 1 FROM table_permissions p WHERE pg_catalog.has_table_privilege(p.role_oid, p.oid, p.permission || ' WITH GRANT OPTION'))
    OR EXISTS (SELECT 1 FROM column_permissions p WHERE pg_catalog.has_column_privilege(p.role_oid, p.oid, p.attnum, p.permission || ' WITH GRANT OPTION'))
    OR EXISTS (SELECT 1 FROM roles r CROSS JOIN pg_catalog.pg_namespace n WHERE pg_catalog.has_schema_privilege(r.oid, n.oid, 'USAGE WITH GRANT OPTION') OR pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE WITH GRANT OPTION'))
    OR EXISTS (SELECT 1 FROM roles r WHERE pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CONNECT WITH GRANT OPTION') OR pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'TEMPORARY WITH GRANT OPTION'))) AS "noGrantOptions"`;

/** Audits catalog capabilities, not the integrity of stored application data or
 * full resistance to a compromised SQL client. Read-only; no public startup. */
export async function auditFoundationRole(connection: RoleAuditConnection): Promise<FoundationRoleAudit> {
  return Object.freeze({ scope: "open-mint-foundation-role-v1", ...await auditPrivileges(connection, FOUNDATION_RUNTIME_PRIVILEGES) });
}
/** Same catalog safeguards, explicitly including the request/publication/issuer
 * extension tables. Does not certify arbitrary future tables or projection. */
export async function auditPreparationRole(connection: RoleAuditConnection): Promise<PreparationRoleAudit> {
  return Object.freeze({ scope: "open-mint-preparation-role-v1", ...await auditPrivileges(connection, PREPARATION_RUNTIME_PRIVILEGES) });
}
export async function auditProjectionRole(connection: RoleAuditConnection): Promise<ProjectionRoleAudit> {
  return Object.freeze({ scope: "open-mint-projection-role-v1", ...await auditPrivileges(connection, PROJECTION_RUNTIME_PRIVILEGES) });
}
export async function auditGenerativeRole(connection: RoleAuditConnection): Promise<GenerativeRoleAudit> {
  return Object.freeze({ scope: "open-mint-generative-role-v1", ...await auditPrivileges(connection, GENERATIVE_RUNTIME_PRIVILEGES) });
}
export async function auditGenerativeBrowserRole(connection: RoleAuditConnection) {
  return Object.freeze({ scope: "open-mint-generative-browser-role-v1" as const, ...await auditPrivileges(connection, GENERATIVE_BROWSER_RUNTIME_PRIVILEGES) });
}
export async function auditGenerativeRecoveryRole(connection: RoleAuditConnection) {
  return Object.freeze({ scope: "open-mint-generative-recovery-role-v1" as const, ...await auditPrivileges(connection, GENERATIVE_RECOVERY_PRIVILEGES) });
}
export async function auditPulseBrowserRole(connection: RoleAuditConnection) {
  return Object.freeze({ scope: "open-mint-pulse-browser-role-v1" as const, ...await auditPrivileges(connection, PULSE_BROWSER_PRIVILEGES) });
}
export async function auditPulseRecoveryRole(connection: RoleAuditConnection) {
  return Object.freeze({ scope: "open-mint-pulse-recovery-role-v1" as const, ...await auditPrivileges(connection, PULSE_RECOVERY_PRIVILEGES) });
}
export async function requireStagingRecoveryRole(connection: RoleAuditConnection) {
  const report = await auditPrivileges(connection, STAGING_RECOVERY_PRIVILEGES);
  if (!report.ok) throw new DatabaseRoleAuditError();
  try {
    const names = STAGING_RECOVERY_PRIVILEGES.map(t => t.name);
    const rows = (await connection.query(`SELECT
      NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='open_mint' AND c.relkind IN ('r','p','v','m','f') AND NOT (c.relname=ANY($1::text[]))
        AND (pg_catalog.has_table_privilege(current_user,c.oid,'SELECT') OR pg_catalog.has_table_privilege(current_user,c.oid,'INSERT')
          OR pg_catalog.has_table_privilege(current_user,c.oid,'UPDATE') OR pg_catalog.has_table_privilege(current_user,c.oid,'DELETE')
          OR pg_catalog.has_table_privilege(current_user,c.oid,'TRUNCATE') OR pg_catalog.has_table_privilege(current_user,c.oid,'REFERENCES')
          OR pg_catalog.has_table_privilege(current_user,c.oid,'TRIGGER')
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
            AND (pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,'SELECT')
              OR pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,'INSERT')
              OR pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')
              OR pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,'REFERENCES'))))) AS exact,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid IN(m.member,m.roleid) WHERE r.rolname=current_user) AS no_membership`, [names])).rows;
    if (rows.length!==1 || rows[0].exact!==true || rows[0].no_membership!==true) throw new DatabaseRoleAuditError();
    return report;
  } catch { throw new DatabaseRoleAuditError(); }
}
async function auditPrivileges(connection: RoleAuditConnection, profile: readonly RuntimeTablePrivileges[]): Promise<Omit<FoundationRoleAudit, "scope">> {
  try {
    // Probe only built-ins before resolving any cast, operator, or catalog
    // expression. Connection setup is explicit and outside this read-only API.
    const probe = await connection.query(`SELECT pg_catalog.current_setting('server_version_num') AS version,
      pg_catalog.current_setting('search_path') AS path, pg_catalog.current_setting('statement_timeout') AS timeout`);
    const settings = probe.rows[0], timeout = typeof settings?.timeout === "string" ? /^(\d+)(ms|s)?$/.exec(settings.timeout) : null;
    const milliseconds = timeout ? Number(timeout[1]) * (timeout[2] === "s" ? 1000 : 1) : NaN;
    if (probe.rows.length !== 1 || typeof settings.version !== "string" || !/^16\d{4}$/.test(settings.version)
      || settings.path !== "pg_catalog" || !Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 5000) throw new DatabaseRoleAuditError();
    const result = await connection.query(RUNTIME_ROLE_AUDIT_SQL, [JSON.stringify(profile)]);
    if (result.rows.length !== 1) throw new DatabaseRoleAuditError();
    const row = result.rows[0];
    if (Object.keys(row).sort().join(",") !== [...CHECKS].sort().join(",") || CHECKS.some(key => typeof row[key] !== "boolean")) throw new DatabaseRoleAuditError();
    const checks = Object.freeze(Object.fromEntries(CHECKS.map(key => [key, row[key]]))) as Readonly<Record<FoundationRoleCheck, boolean>>;
    const failedChecks = Object.freeze(CHECKS.filter(key => !checks[key]));
    return Object.freeze({ ok: failedChecks.length === 0, checks, failedChecks });
  } catch { throw new DatabaseRoleAuditError(); }
}

/** Fails closed without exposing role names, connection details or SQL errors. */
export async function requireFoundationRole(connection: RoleAuditConnection): Promise<FoundationRoleAudit> {
  const report = await auditFoundationRole(connection);
  if (!report.ok) throw new DatabaseRoleAuditError();
  return report;
}
