import type { RoleAuditConnection } from "./roleAudit.js";

/** A deliberately small column-level inspection surface. No payload, browser
 * capability, signature, session, challenge or permit columns are granted. */
export const STAGING_INSPECTOR_COLUMNS = Object.freeze({
  namespaces: "namespace_id profile provenance",
  request_profiles: "namespace_id deployment_id chain_id",
  assessment_attempts: "namespace_id attempt_id handle admitted_at state",
  jobs: "namespace_id attempt_id kind state owner_epoch",
  dispatch_fences: "namespace_id attempt_id leg dispatched_at",
  provider_receipts: "namespace_id attempt_id leg cost_status cost_usd_ticks",
  assessment_terminals: "namespace_id attempt_id kind reason phase recorded_at",
  budget_reservations: "namespace_id attempt_id reserved_usd_ticks",
  assessments: "namespace_id attempt_id assessment_id digest",
  generative_inputs: "namespace_id deployment_id handle digest",
  requests: "namespace_id deployment_id request_id attempt_id assessment_id handle",
  generative_authorizations: "namespace_id deployment_id authorization_id request_id assessment_id handle recipient authorization_digest deadline state",
  generative_authorization_heads: "namespace_id deployment_id authorization_id handle",
  wallet_mint_plans: "namespace_id deployment_id request_id authorization_id wallet_nonce nonce_active",
  wallet_mint_dispatches: "namespace_id request_id attempt dispatched_at",
  wallet_mint_reports: "namespace_id request_id attempt outcome transaction_hash recorded_at",
  projection_checkpoints: "deployment_id health halt_reason",
  staging_generative_recoveries: "namespace_id deployment_id recovery_id authorization_id request_id authorization_digest recorded_at",
} as const);

const roleName = (role: string) => {
  if (!/^(?!pg_)(?!public$)[a-z][a-z0-9_]{0,62}$/.test(role)) throw Error("Invalid inspector role.");
  return `"${role}"`;
};

/** Operator-applied recipe, not a provisioning action. */
export function stagingInspectorGrants(role: string): string {
  const target = roleName(role);
  return [
    `GRANT USAGE ON SCHEMA open_mint TO ${target};`,
    ...Object.entries(STAGING_INSPECTOR_COLUMNS).map(([table, columns]) =>
      `GRANT SELECT (${columns.split(" ").join(", ")}) ON open_mint.${table} TO ${target};`),
  ].join("\n");
}

export class StagingInspectorRoleError extends Error {
  constructor() { super("Restricted staging inspector role unavailable or mismatched."); this.name = "StagingInspectorRoleError"; }
}

/** Check effective rights over *every* application table/column, including
 * inherited and PUBLIC grants, not just the known allowlist. */
export async function requireStagingInspectorRole(connection: RoleAuditConnection): Promise<void> {
  try {
    const result = await connection.query(`WITH expected AS (
        SELECT key AS table_name, string_to_array(value, ' ') AS columns
        FROM pg_catalog.jsonb_each_text($1::jsonb)
      ), actual AS (
        SELECT c.oid, c.relname, a.attnum, a.attname
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace AND n.nspname='open_mint'
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE c.relkind IN ('r','p','v','m','f')
      ), roles AS (
        SELECT r.oid,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication
        FROM pg_catalog.pg_roles r
        WHERE r.rolname=current_user OR pg_catalog.pg_has_role(current_user,r.oid,'MEMBER')
      ) SELECT
        current_user=session_user AS identity,
        pg_catalog.current_setting('server_version_num')::integer BETWEEN 160000 AND 169999 AS pg16,
        pg_catalog.current_setting('search_path')='pg_catalog' AS path,
        NOT EXISTS (SELECT 1 FROM roles WHERE rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication) AS restricted,
        NOT pg_catalog.has_parameter_privilege(current_user,'session_replication_role','SET') AS no_trigger_bypass,
        NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN roles r ON r.oid=m.member) AS no_membership,
        NOT (EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database() AND d.datdba IN (SELECT oid FROM roles))
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_(toast_)?temp_' AND n.nspowner IN (SELECT oid FROM roles))
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner IN (SELECT oid FROM roles))
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner IN (SELECT oid FROM roles))
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_type t WHERE t.typowner IN (SELECT oid FROM roles))) AS no_ownership,
        NOT (EXISTS (SELECT 1 FROM roles r WHERE pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE'))
          OR EXISTS (SELECT 1 FROM roles r CROSS JOIN pg_catalog.pg_namespace n
            WHERE n.nspname !~ '^pg_(toast_)?temp_' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))) AS no_creation,
        NOT EXISTS (SELECT 1 FROM actual a WHERE pg_catalog.has_table_privilege(current_user,a.oid,'SELECT')
          OR pg_catalog.has_table_privilege(current_user,a.oid,'INSERT')
          OR pg_catalog.has_table_privilege(current_user,a.oid,'UPDATE')
          OR pg_catalog.has_table_privilege(current_user,a.oid,'DELETE')
          OR pg_catalog.has_table_privilege(current_user,a.oid,'TRUNCATE')
          OR pg_catalog.has_table_privilege(current_user,a.oid,'REFERENCES')
          OR pg_catalog.has_table_privilege(current_user,a.oid,'TRIGGER')) AS no_table_rights,
        NOT EXISTS (SELECT 1 FROM actual a LEFT JOIN expected e ON e.table_name=a.relname
          WHERE pg_catalog.has_column_privilege(current_user,a.oid,a.attnum,'SELECT') IS DISTINCT FROM
            COALESCE(a.attname=ANY(e.columns),false)
          OR pg_catalog.has_column_privilege(current_user,a.oid,a.attnum,'INSERT')
          OR pg_catalog.has_column_privilege(current_user,a.oid,a.attnum,'UPDATE')
          OR pg_catalog.has_column_privilege(current_user,a.oid,a.attnum,'REFERENCES')) AS exact_columns,
        NOT EXISTS (SELECT 1 FROM expected e WHERE NOT EXISTS
          (SELECT 1 FROM actual a WHERE a.relname=e.table_name)) AS complete,
        NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='open_mint'
          AND (pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE') OR NOT pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE'))) AS schema_rights,
        NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE')
          AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')) AS no_definer,
        NOT (EXISTS(SELECT 1 FROM actual a WHERE pg_catalog.has_table_privilege(current_user,a.oid,'SELECT WITH GRANT OPTION')
          OR pg_catalog.has_table_privilege(current_user,a.oid,'INSERT WITH GRANT OPTION')
          OR pg_catalog.has_table_privilege(current_user,a.oid,'UPDATE WITH GRANT OPTION')
          OR pg_catalog.has_table_privilege(current_user,a.oid,'DELETE WITH GRANT OPTION')
          OR pg_catalog.has_column_privilege(current_user,a.oid,a.attnum,'SELECT WITH GRANT OPTION'))
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE WITH GRANT OPTION')
            OR pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE WITH GRANT OPTION'))) AS no_grant_options
      `, [JSON.stringify(STAGING_INSPECTOR_COLUMNS)]);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row || Object.values(row).some(value => value !== true)) throw new StagingInspectorRoleError();
  } catch { throw new StagingInspectorRoleError(); }
}
