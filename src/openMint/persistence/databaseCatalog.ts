import { RUNTIME_ROLE_AUDIT_SQL } from "./roleAudit.js";

/** One MVCC snapshot for definitions, ACLs, effective privileges and policies.
 * $1 privilege profile, $2 owner, $3 runtime, $4 namespace, $5 deployment.
 * Requires pg_catalog-only search_path; no user-defined function is invoked.
 * Internal FK trigger OIDs/names are generated anew on each install, so bind
 * their constraint/function/type instead. All other object names are exact.
 */
function catalogSql(runtime: boolean, v2 = false) { return `WITH
n AS (SELECT * FROM pg_catalog.pg_namespace WHERE nspname='open_mint'),
c AS (SELECT c.* FROM pg_catalog.pg_class c JOIN n ON n.oid=c.relnamespace),
f AS (SELECT p.* FROM pg_catalog.pg_proc p JOIN n ON n.oid=p.pronamespace),
t AS (SELECT t.* FROM pg_catalog.pg_type t JOIN n ON n.oid=t.typnamespace),
items(kind, name, value) AS (
  SELECT 'relation', c.relname::text, pg_catalog.jsonb_build_array(c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
    c.relreplident,c.relispartition,c.reloptions,a.amname,s.spcname,c.relowner=$2::regrole)
    FROM c LEFT JOIN pg_catalog.pg_am a ON a.oid=c.relam LEFT JOIN pg_catalog.pg_tablespace s ON s.oid=c.reltablespace
  UNION ALL SELECT 'column', c.relname||'.'||a.attnum, pg_catalog.jsonb_build_array(a.attname,a.attisdropped,
    pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,a.attstorage,a.attcompression,
    a.atthasmissing,a.attmissingval::text,cn.nspname,co.collname,pg_catalog.pg_get_expr(d.adbin,d.adrelid,false))
    FROM c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
  UNION ALL SELECT 'constraint', co.conrelid::regclass::text||'.'||co.conname,
    pg_catalog.jsonb_build_array(co.contype,co.convalidated,co.condeferrable,co.condeferred,co.conislocal,co.coninhcount,co.connoinherit,
      pg_catalog.pg_get_constraintdef(co.oid,false)) FROM pg_catalog.pg_constraint co JOIN n ON n.oid=co.connamespace
  UNION ALL SELECT 'index', c.relname::text, pg_catalog.jsonb_build_array(pg_catalog.pg_get_indexdef(i.indexrelid),i.indisvalid,
    i.indisready,i.indislive,i.indisclustered,i.indisreplident,i.indnullsnotdistinct)
    FROM c JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
  UNION ALL SELECT 'trigger', c.relname||'.'||CASE WHEN g.tgisinternal THEN co.conname||'.'||g.tgfoid::regprocedure::text||'.'||g.tgtype ELSE g.tgname END,
    pg_catalog.jsonb_build_array(g.tgenabled,g.tgisinternal,g.tgtype,g.tgfoid::regprocedure::text,g.tgdeferrable,g.tginitdeferred,
      g.tgconstrrelid::regclass::text,g.tgnargs,pg_catalog.encode(g.tgargs,'hex'),g.tgattr::text,
      CASE WHEN NOT g.tgisinternal THEN pg_catalog.pg_get_triggerdef(g.oid,false) END)
    FROM c JOIN pg_catalog.pg_trigger g ON g.tgrelid=c.oid LEFT JOIN pg_catalog.pg_constraint co ON co.oid=g.tgconstraint
  UNION ALL SELECT 'function', f.oid::regprocedure::text, pg_catalog.jsonb_build_array(pg_catalog.pg_get_functiondef(f.oid),
    f.proowner=$2::regrole,f.proleakproof,f.prosupport::regproc::text) FROM f
  UNION ALL SELECT 'type', t.typname::text, pg_catalog.jsonb_build_array(t.typtype,t.typcategory,t.typispreferred,t.typisdefined,
    t.typnotnull,t.typbasetype::regtype::text,t.typrelid::regclass::text,t.typelem::regtype::text,t.typdefault,t.typowner=$2::regrole) FROM t
  UNION ALL SELECT 'rule', c.relname||'.'||r.rulename, pg_catalog.jsonb_build_array(r.ev_enabled,pg_catalog.pg_get_ruledef(r.oid,false))
    FROM c JOIN pg_catalog.pg_rewrite r ON r.ev_class=c.oid
  UNION ALL SELECT 'policy', c.relname||'.'||p.polname, pg_catalog.jsonb_build_array(p.polcmd,p.polpermissive,p.polroles::text,
    pg_catalog.pg_get_expr(p.polqual,p.polrelid,false),pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,false))
    FROM c JOIN pg_catalog.pg_policy p ON p.polrelid=c.oid
  UNION ALL SELECT 'inheritance', i.inhrelid::regclass::text, pg_catalog.jsonb_build_array(i.inhparent::regclass::text,i.inhseqno,i.inhdetachpending)
    FROM pg_catalog.pg_inherits i WHERE i.inhrelid IN (SELECT oid FROM c) OR i.inhparent IN (SELECT oid FROM c)
),
acl_objects(kind,name,acl) AS (
  SELECT 'schema','open_mint',COALESCE(nspacl,pg_catalog.acldefault('n',nspowner)) FROM n
  UNION ALL SELECT 'relation',relname,COALESCE(relacl,pg_catalog.acldefault('r',relowner)) FROM c
  UNION ALL SELECT 'column',c.relname||'.'||a.attname,a.attacl FROM c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE a.attnum>0
  UNION ALL SELECT 'function',oid::regprocedure::text,COALESCE(proacl,pg_catalog.acldefault('f',proowner)) FROM f
  UNION ALL SELECT 'type',typname,COALESCE(typacl,pg_catalog.acldefault('T',typowner)) FROM t
  UNION ALL SELECT 'default',d.defaclobjtype::text||'.'||d.defaclnamespace::regnamespace::text,d.defaclacl
    FROM pg_catalog.pg_default_acl d WHERE d.defaclnamespace IN (SELECT oid FROM n) OR (d.defaclnamespace=0 AND d.defaclrole=$2::regrole)
),
system_acl_objects(kind,name,owner,acl) AS (
  SELECT 'system-schema',nspname,nspowner,COALESCE(nspacl,pg_catalog.acldefault('n',nspowner))
    FROM pg_catalog.pg_namespace WHERE nspname IN ('pg_catalog','information_schema','public')
  UNION ALL SELECT 'database','current',datdba,COALESCE(datacl,pg_catalog.acldefault('d',datdba))
    FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()
  UNION ALL SELECT 'system-function',p.oid::regprocedure::text,p.proowner,p.proacl FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname IN ('pg_catalog','information_schema') AND p.proacl IS NOT NULL
  UNION ALL SELECT 'system-relation',r.oid::regclass::text,r.relowner,r.relacl FROM pg_catalog.pg_class r
    JOIN pg_catalog.pg_namespace s ON s.oid=r.relnamespace WHERE s.nspname IN ('pg_catalog','information_schema') AND r.relacl IS NOT NULL
  UNION ALL SELECT 'system-column',r.oid::regclass::text||'.'||a.attname,r.relowner,a.attacl FROM pg_catalog.pg_class r
    JOIN pg_catalog.pg_namespace s ON s.oid=r.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
    WHERE s.nspname IN ('pg_catalog','information_schema') AND a.attacl IS NOT NULL
),
acls AS (SELECT o.kind,o.name,
    CASE WHEN a.grantor=$2::regrole THEN 'OWNER' WHEN a.grantor=$3::regrole THEN 'RUNTIME' ${v2 ? "WHEN a.grantor=$6::regrole THEN 'INSPECTOR' WHEN a.grantor=$7::regrole THEN 'RECOVERY' " : ""}ELSE a.grantor::regrole::text END AS grantor,
    CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=$2::regrole THEN 'OWNER' WHEN a.grantee=$3::regrole THEN 'RUNTIME' ${v2 ? "WHEN a.grantee=$6::regrole THEN 'INSPECTOR' WHEN a.grantee=$7::regrole THEN 'RECOVERY' " : ""}ELSE a.grantee::regrole::text END AS grantee,
    a.privilege_type,a.is_grantable FROM acl_objects o CROSS JOIN LATERAL pg_catalog.aclexplode(o.acl) a
  UNION ALL SELECT o.kind,o.name,
    CASE WHEN a.grantor=o.owner THEN 'SYSTEM_OWNER' WHEN a.grantor=$3::regrole THEN 'RUNTIME' ${v2 ? "WHEN a.grantor=$6::regrole THEN 'INSPECTOR' WHEN a.grantor=$7::regrole THEN 'RECOVERY' " : ""}ELSE a.grantor::regrole::text END,
    CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=o.owner THEN 'SYSTEM_OWNER' WHEN a.grantee=$3::regrole THEN 'RUNTIME' ${v2 ? "WHEN a.grantee=$6::regrole THEN 'INSPECTOR' WHEN a.grantee=$7::regrole THEN 'RECOVERY' " : ""}ELSE a.grantee::regrole::text END,
    a.privilege_type,a.is_grantable FROM system_acl_objects o CROSS JOIN LATERAL pg_catalog.aclexplode(o.acl) a),
profile_rows(kind,value) AS (
  SELECT 'namespace',pg_catalog.to_jsonb(p)::text FROM open_mint.namespaces p
  UNION ALL SELECT 'budget',(${runtime ? "pg_catalog.to_jsonb(p)-'generation_enabled'" : "pg_catalog.to_jsonb(p)"})::text FROM open_mint.budget_policies p
  UNION ALL SELECT 'session',pg_catalog.to_jsonb(p)::text FROM open_mint.session_profiles p
  UNION ALL SELECT 'request',pg_catalog.to_jsonb(p)::text FROM open_mint.request_profiles p
  UNION ALL SELECT 'input',pg_catalog.to_jsonb(p)::text FROM open_mint.generative_input_profiles p
  UNION ALL SELECT 'issuance',(${runtime ? "pg_catalog.to_jsonb(p)-'enabled'" : "pg_catalog.to_jsonb(p)"})::text FROM open_mint.generative_issuance_profiles p
  UNION ALL SELECT 'schema',pg_catalog.to_jsonb(p)::text FROM open_mint.schema_version p
  UNION ALL SELECT 'projection',pg_catalog.to_jsonb(p)::text FROM open_mint.projection_schema_version p
),
documents AS (SELECT
  (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) ORDER BY kind COLLATE "C",name COLLATE "C",value::text COLLATE "C")::text FROM items i) AS schema,
  (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY kind COLLATE "C",name COLLATE "C",grantor COLLATE "C",grantee COLLATE "C",privilege_type COLLATE "C")::text FROM acls a) AS grants,
  (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY kind COLLATE "C",value COLLATE "C")::text FROM profile_rows p) AS profiles)
SELECT
  ${runtime ? `(SELECT generation_enabled FROM open_mint.budget_policies WHERE namespace_id=$4::uuid) AS generation_enabled,
  (SELECT enabled FROM open_mint.generative_issuance_profiles WHERE namespace_id=$4::uuid AND deployment_id=$5::uuid) AS issuance_enabled,` : ""}
  CASE WHEN pg_catalog.octet_length(d.schema)<=1048576 THEN d.schema END AS schema,
  CASE WHEN pg_catalog.octet_length(d.grants)<=524288 THEN d.grants END AS grants,
  CASE WHEN pg_catalog.octet_length(d.profiles)<=65536 THEN d.profiles END AS profiles,
  (SELECT pg_catalog.to_jsonb(a) FROM (${RUNTIME_ROLE_AUDIT_SQL}) a)::text AS audit,
  pg_catalog.jsonb_build_object('database',pg_catalog.current_database(),'runtimeRole',current_user,'sessionRole',session_user,
    'ownerRole',$2::text,'databaseOwner',(SELECT datdba::regrole::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()),
    'encoding',pg_catalog.getdatabaseencoding(),'version',pg_catalog.current_setting('server_version_num'),
    'path',pg_catalog.current_setting('search_path'),'timeout',pg_catalog.current_setting('statement_timeout'),
    'timezone',pg_catalog.current_setting('TimeZone'),'replication',pg_catalog.current_setting('session_replication_role'),
    'fsync',pg_catalog.current_setting('fsync'),'commit',pg_catalog.current_setting('synchronous_commit'),
    'strings',pg_catalog.current_setting('standard_conforming_strings'),'rowSecurity',pg_catalog.current_setting('row_security'))::text AS identity,
  ((SELECT count(*)=1 AND bool_and(nspowner=$2::regrole) FROM n)
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()
      AND datcollate='C' AND datctype='C' AND datlocprovider='c' AND datcollversion IS NULL)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=$3::regrole OR roleid=$3::regrole${v2 ? " OR member=$6::regrole OR roleid=$6::regrole OR member=$7::regrole OR roleid=$7::regrole" : ""})
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=$3::regrole AND rolcanlogin)
    ${v2 ? `AND (SELECT count(*)=2 AND bool_and(rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
        AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication) FROM pg_catalog.pg_roles WHERE oid IN ($6::regrole,$7::regrole))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid IN ($6::regrole,$7::regrole)
        AND (pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
          OR pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace s WHERE pg_catalog.has_schema_privilege(r.oid,s.oid,'CREATE'))))` : ""}
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('open_mint','public','pg_catalog','pg_toast','information_schema'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class r JOIN pg_catalog.pg_namespace s ON s.oid=r.relnamespace WHERE s.nspname='public')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname='public')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace s ON s.oid=t.typnamespace WHERE s.nspname='public')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_collation WHERE collnamespace IN (SELECT oid FROM n))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_conversion WHERE connamespace IN (SELECT oid FROM n))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_operator WHERE oprnamespace IN (SELECT oid FROM n))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_opclass WHERE opcnamespace IN (SELECT oid FROM n))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_opfamily WHERE opfnamespace IN (SELECT oid FROM n))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extnamespace IN (SELECT oid FROM n))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_publication_tables WHERE schemaname='open_mint')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_seclabel WHERE (classoid='pg_class'::regclass AND objoid IN (SELECT oid FROM c))
      OR (classoid='pg_proc'::regclass AND objoid IN (SELECT oid FROM f)) OR (classoid='pg_namespace'::regclass AND objoid IN (SELECT oid FROM n)))
  ) AS supported,
  ((SELECT count(*) FROM profile_rows)=8
    AND EXISTS(SELECT 1 FROM open_mint.namespaces WHERE namespace_id=$4::uuid AND profile='staging-testnet' AND provenance='grok')
    AND EXISTS(SELECT 1 FROM open_mint.session_profiles WHERE namespace_id=$4::uuid AND chain_id=11155111 AND origin='https://staging.signatures.gallery')
    AND EXISTS(SELECT 1 FROM open_mint.request_profiles WHERE namespace_id=$4::uuid AND deployment_id=$5::uuid AND chain_id=11155111)
    AND EXISTS(SELECT 1 FROM open_mint.generative_input_profiles WHERE namespace_id=$4::uuid AND deployment_id=$5::uuid AND profile='sg-generative-inputs-v1-rc1')
    AND EXISTS(SELECT 1 FROM open_mint.budget_policies WHERE namespace_id=$4::uuid ${runtime ? "" : "AND NOT generation_enabled"})
    AND EXISTS(SELECT 1 FROM open_mint.generative_issuance_profiles WHERE namespace_id=$4::uuid AND deployment_id=$5::uuid ${runtime ? "" : "AND NOT enabled"})
    AND EXISTS(SELECT 1 FROM open_mint.schema_version WHERE version=1)
    AND EXISTS(SELECT 1 FROM open_mint.projection_schema_version WHERE version=3)
  ) AS staged FROM documents d`; }

// Separate fixed query profiles. Paused certification never accepts activation.
export const GENERATIVE_DATABASE_CATALOG_SQL = catalogSql(false);
export const GENERATIVE_RUNTIME_DATABASE_CATALOG_SQL = catalogSql(true);
/** Exact v2 queries: two additional independently named restricted roles. */
export const GENERATIVE_DATABASE_CATALOG_V2_SQL = catalogSql(false, true);
export const GENERATIVE_RUNTIME_DATABASE_CATALOG_V2_SQL = catalogSql(true, true);
