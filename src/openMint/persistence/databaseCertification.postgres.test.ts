import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disposablePostgres } from "./fixtures/postgres.js";
import { GENERATIVE_DATABASE_LOCK, GENERATIVE_DATABASE_MIGRATIONS } from "./databaseSchemaLock.js";
import { observeGenerativeDatabase, verifyGenerativeDatabaseCertification, observeGenerativeRuntimeDatabase, verifyGenerativeRuntimeDatabase, readCertifiedDatabaseProfiles, type DatabaseCertificationReview } from "./databaseCertification.js";
import { generativeBrowserRuntimeGrants } from "./runtimeRole.js";

it("locks every migration's exact bytes and order, without touching a database", () => {
  expect(GENERATIVE_DATABASE_MIGRATIONS).toHaveLength(9);
  for (const migration of GENERATIVE_DATABASE_MIGRATIONS)
    expect(createHash("sha256").update(readFileSync(new URL(migration.path, import.meta.url))).digest("hex")).toBe(migration.sha256);
});

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("exact staging database boundary (disposable PG16 only)", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, db: Client, runtime: Client, serial = 0;
  let target: { database: string; ownerRole: string; runtimeRole: string; namespaceId: string; deploymentId: string }, review: DatabaseCertificationReview;
  beforeAll(async () => { cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); }, 30000);
  afterAll(async () => { await admin?.end(); cluster?.stop(); });
  beforeEach(async () => {
    const name = `certification_${++serial}`, role = `cert_runtime_${serial}`;
    target = { database: name, ownerRole: "open_mint_test", runtimeRole: role,
      namespaceId: "11111111-1111-4111-8111-111111111111", deploymentId: "22222222-2222-4222-8222-222222222222" };
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    db = new Client({ ...cluster.config, database: name }); await db.connect();
    for (const migration of GENERATIVE_DATABASE_MIGRATIONS) await db.query(readFileSync(new URL(migration.path, import.meta.url), "utf8"));
    await db.query(generativeBrowserRuntimeGrants(role));
    await db.query(`INSERT INTO open_mint.namespaces VALUES($1,'staging-testnet','grok','offline-certification-test');
      `, [target.namespaceId]);
    await db.query(`INSERT INTO open_mint.budget_policies VALUES($1,'offline-certification-test','grok-offline-test',false,'2099-01-01',1,1,1,1,9007199254740992,9007199254740993)`, [target.namespaceId]);
    await db.query("INSERT INTO open_mint.session_profiles VALUES($1,'https://staging.signatures.gallery',11155111)", [target.namespaceId]);
    await db.query(`INSERT INTO open_mint.request_profiles VALUES($1,$2,11155111,$3,$4,$4,$3,9007199254740993,$4,10000,120000,5000)`,
      [target.namespaceId, target.deploymentId, `0x${"1".repeat(40)}`, `0x${"2".repeat(64)}`]);
    await db.query("INSERT INTO open_mint.generative_input_profiles VALUES($1,$2,'sg-generative-inputs-v1-rc1',$3,$4,$4)",
      [target.namespaceId, target.deploymentId, `0x${"3".repeat(40)}`, `0x${"4".repeat(64)}`]);
    await db.query("INSERT INTO open_mint.generative_issuance_profiles VALUES($1,$2,false,600,1000,10000,120000,5000)", [target.namespaceId, target.deploymentId]);
    runtime = new Client({ ...cluster.config, database: name, user: role, options: "-c search_path=pg_catalog -c timezone=UTC" }); await runtime.connect();
    // Tests alone derive this fixture pin. Operational startup must receive an
    // independently reviewed value, never bless the database it is inspecting.
    const observed = await observeGenerativeDatabase(runtime, target);
    review = { ...target, profilesSha256: observed.profilesSha256, migrationManifestSha256: GENERATIVE_DATABASE_LOCK.migrationManifestSha256,
      migrationReceiptSha256: "a".repeat(64), reviewRevisionSha256: "b".repeat(64) };
  }, 30000);
  afterEach(async () => {
    await runtime?.end(); await db?.end();
    await admin.query(`DROP DATABASE ${target.database}`); await admin.query(`DROP ROLE ${target.runtimeRole}`);
  });
  it("matches a reproducible reference without granting approval or changing state", async () => {
    const observation = await observeGenerativeDatabase(runtime, target);
    expect(observation.schemaSha256).toBe(GENERATIVE_DATABASE_LOCK.schemaSha256);
    expect(observation.grantsSha256).toBe(GENERATIVE_DATABASE_LOCK.grantsSha256);
    const result = await verifyGenerativeDatabaseCertification(runtime, review);
    expect(result).toMatchObject({ approved: false, publicStartup: false, kind: "generative-database-match-v1" });
    expect(result.databaseBindingSha256).toMatch(/^[0-9a-f]{64}$/); expect(Object.isFrozen(result)).toBe(true);
    const exact = readCertifiedDatabaseProfiles(result);
    expect(exact).toContain("9007199254740993"); expect(exact).toContain("9007199254740992");
    expect(() => readCertifiedDatabaseProfiles({ ...result })).toThrow();
    expect(() => readCertifiedDatabaseProfiles(observation)).toThrow();
    expect((await db.query("SELECT epoch FROM open_mint.writer_epoch")).rows).toEqual([{ epoch: "0" }]);
    expect((await db.query("SELECT count(*)::int AS n FROM open_mint.dispatch_fences")).rows).toEqual([{ n: 0 }]);
    expect((await db.query("SELECT generation_enabled FROM open_mint.budget_policies")).rows).toEqual([{ generation_enabled: false }]);
  });
  it("runtime static pins omit only live kill switches; paused certification stays disabled-only", async () => {
    const observed = await observeGenerativeRuntimeDatabase(runtime, target);
    const input = { ...review, version: "sg-generative-runtime-db-review-v1" as const, profilesSha256: observed.profilesSha256 };
    const before = await verifyGenerativeRuntimeDatabase(runtime, input);
    expect(before).toMatchObject({ generationEnabled: false, issuanceEnabled: false, approved: false, publicStartup: false });
    const raw = readCertifiedDatabaseProfiles(before); expect(raw).toContain("9007199254740993");
    expect(raw).not.toContain("generation_enabled"); expect(raw).not.toContain('\\"enabled\\"');
    for (const [generation, issuance] of [[true, false], [true, true], [false, true]]) {
      await db.query("UPDATE open_mint.budget_policies SET generation_enabled=$1", [generation]);
      await db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=$1", [issuance]);
      const next = await verifyGenerativeRuntimeDatabase(runtime, input);
      expect(next.databaseBindingSha256).toBe(before.databaseBindingSha256);
      expect(next).toMatchObject({ generationEnabled: generation, issuanceEnabled: issuance });
      await expect(verifyGenerativeDatabaseCertification(runtime, review)).rejects.toThrow();
    }
    await db.query("BEGIN; SET LOCAL session_replication_role=replica; UPDATE open_mint.budget_policies SET max_exposure_usd_ticks=max_exposure_usd_ticks+1; COMMIT");
    await expect(verifyGenerativeRuntimeDatabase(runtime, input)).rejects.toThrow();
  });
  const mutations = [
    ["missing CHECK", "ALTER TABLE open_mint.wallet_mint_dispatches DROP CONSTRAINT wallet_mint_dispatches_attempt_check"],
    ["weakened CHECK", "ALTER TABLE open_mint.wallet_mint_dispatches DROP CONSTRAINT wallet_mint_dispatches_attempt_check; ALTER TABLE open_mint.wallet_mint_dispatches ADD CONSTRAINT wallet_mint_dispatches_attempt_check CHECK(attempt>=1)"],
    ["unvalidated CHECK", "ALTER TABLE open_mint.wallet_mint_dispatches DROP CONSTRAINT wallet_mint_dispatches_attempt_check; ALTER TABLE open_mint.wallet_mint_dispatches ADD CONSTRAINT wallet_mint_dispatches_attempt_check CHECK(attempt BETWEEN 1 AND 5) NOT VALID"],
    ["extra CHECK", "ALTER TABLE open_mint.wallet_mint_dispatches ADD CHECK(attempt<6)"],
    ["missing foreign key", "ALTER TABLE open_mint.wallet_mint_reports DROP CONSTRAINT wallet_mint_reports_namespace_id_request_id_attempt_fkey"],
    ["deferred foreign key", "ALTER TABLE open_mint.wallet_mint_reports ALTER CONSTRAINT wallet_mint_reports_namespace_id_request_id_attempt_fkey DEFERRABLE INITIALLY DEFERRED"],
    ["missing unique index", "DROP INDEX open_mint.wallet_mint_active_nonce"],
    ["changed index predicate", "DROP INDEX open_mint.wallet_mint_active_nonce; CREATE UNIQUE INDEX wallet_mint_active_nonce ON open_mint.wallet_mint_plans(namespace_id,deployment_id,lower(recipient),wallet_nonce) WHERE NOT nonce_active"],
    ["extra index", "CREATE INDEX surprise_index ON open_mint.wallet_mint_reports(outcome)"],
    ["changed column type", "ALTER TABLE open_mint.wallet_mint_reports ALTER COLUMN transaction_hash TYPE varchar(100)"],
    ["nullable column", "ALTER TABLE open_mint.wallet_mint_reports ALTER COLUMN outcome DROP NOT NULL"],
    ["changed default", "ALTER TABLE open_mint.wallet_mint_plans ALTER COLUMN nonce_active SET DEFAULT false"],
    ["missing trigger", "DROP TRIGGER immutable_wallet_report ON open_mint.wallet_mint_reports"],
    ["disabled trigger", "ALTER TABLE open_mint.wallet_mint_reports DISABLE TRIGGER immutable_wallet_report"],
    ["replica-only trigger", "ALTER TABLE open_mint.wallet_mint_reports ENABLE REPLICA TRIGGER immutable_wallet_report"],
    ["disabled internal FK trigger", "ALTER TABLE open_mint.wallet_mint_reports DISABLE TRIGGER ALL"],
    ["changed trigger body", "CREATE OR REPLACE FUNCTION open_mint.refuse_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$"],
    ["changed function configuration", "ALTER FUNCTION open_mint.refuse_immutable_mutation() SET search_path=public"],
    ["definer function", "ALTER FUNCTION open_mint.refuse_immutable_mutation() SECURITY DEFINER"],
    ["RLS", "ALTER TABLE open_mint.wallet_mint_reports ENABLE ROW LEVEL SECURITY"],
    ["forced RLS", "ALTER TABLE open_mint.wallet_mint_reports FORCE ROW LEVEL SECURITY"],
    ["RLS policy", "CREATE POLICY surprise_policy ON open_mint.wallet_mint_reports USING(true)"],
    ["rewrite rule", "CREATE RULE surprise_rule AS ON DELETE TO open_mint.wallet_mint_reports DO INSTEAD NOTHING"],
    ["extra table", "CREATE TABLE open_mint.extra_table(x int)"],
    ["extra function", "CREATE FUNCTION open_mint.extra_function() RETURNS int LANGUAGE sql AS 'SELECT 1'"],
    ["extra type", "CREATE TYPE open_mint.extra_enum AS ENUM('x')"],
    ["extra sequence", "CREATE SEQUENCE open_mint.extra_sequence"],
    ["extra view", "CREATE VIEW open_mint.extra_view AS SELECT 1 AS x"],
    ["extra collation", "CREATE COLLATION open_mint.extra_collation FROM pg_catalog.\"C\""],
    ["unlogged table", "ALTER TABLE open_mint.wallet_mint_reports SET UNLOGGED"],
    ["changed replica identity", "ALTER TABLE open_mint.wallet_mint_reports REPLICA IDENTITY FULL"],
    ["changed table storage", "ALTER TABLE open_mint.wallet_mint_reports SET(fillfactor=80)"],
    ["schema PUBLIC privilege", "GRANT USAGE ON SCHEMA open_mint TO PUBLIC"],
    ["function PUBLIC privilege", "GRANT EXECUTE ON FUNCTION open_mint.refuse_immutable_mutation() TO PUBLIC"],
    ["default privilege", "ALTER DEFAULT PRIVILEGES IN SCHEMA open_mint GRANT SELECT ON TABLES TO PUBLIC"],
    ["global default privilege", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC"],
    ["PUBLIC write privilege", "GRANT UPDATE ON open_mint.namespaces TO PUBLIC"],
    ["runtime write privilege", "GRANT UPDATE ON open_mint.namespaces TO ROLE"],
    ["missing runtime privilege", "REVOKE INSERT ON open_mint.wallet_mint_reports FROM ROLE"],
    ["runtime grant option", "GRANT SELECT ON open_mint.namespaces TO ROLE WITH GRANT OPTION"],
    ["runtime function privilege", "GRANT EXECUTE ON FUNCTION open_mint.refuse_immutable_mutation() TO ROLE"],
    ["wrong object owner", "ALTER TABLE open_mint.wallet_mint_reports OWNER TO ROLE"],
    ["wrong function owner", "ALTER FUNCTION open_mint.refuse_immutable_mutation() OWNER TO ROLE"],
    ["runtime bypass RLS", "ALTER ROLE __RUNTIME__ BYPASSRLS"],
    ["runtime superuser", "ALTER ROLE __RUNTIME__ SUPERUSER"],
    ["runtime role membership", "GRANT pg_read_all_data TO ROLE"],
    ["disabled runtime login", "ALTER ROLE __RUNTIME__ NOLOGIN"],
    ["wrong schema owner", "ALTER SCHEMA open_mint OWNER TO ROLE"],
    ["database CREATE privilege", "GRANT CREATE ON DATABASE DATABASE_NAME TO ROLE"],
    ["column write privilege", "GRANT UPDATE(profile) ON open_mint.namespaces TO ROLE"],
    ["server file access privilege", "GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO ROLE"],
    ["PUBLIC server file access", "GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO PUBLIC"],
    ["system table privilege", "GRANT SELECT ON pg_catalog.pg_authid TO ROLE"],
    ["system column privilege", "GRANT SELECT(rolpassword) ON pg_catalog.pg_authid TO ROLE"],
    ["extra nonapplication schema", "CREATE SCHEMA unexpected"],
    ["extra public function", "CREATE FUNCTION public.surprise() RETURNS int LANGUAGE sql AS 'SELECT 1'"],
    ["early generation activation", "UPDATE open_mint.budget_policies SET generation_enabled=true"],
    ["early issuance activation", "UPDATE open_mint.generative_issuance_profiles SET enabled=true"],
  ];
  it.each(mutations)("rejects %s", async (_name, sql) => {
    await db.query(sql.replaceAll(/(?<=TO |FROM )ROLE\b|__RUNTIME__/g, target.runtimeRole).replaceAll("DATABASE_NAME", target.database));
    await expect(verifyGenerativeDatabaseCertification(runtime, review)).rejects.toThrow("Database certification unavailable or mismatched.");
  });
  it.each(["SET search_path=public", "SET statement_timeout=0", "SET timezone='Asia/Shanghai'", "SET synchronous_commit=off",
    "SET standard_conforming_strings=off", "SET row_security=off"])("refuses changed runtime settings: %s", async sql => {
    await runtime.query(sql); await expect(verifyGenerativeDatabaseCertification(runtime, review)).rejects.toThrow();
  });
  it("binds an independent review/receipt revision without treating it as authenticated authority", async () => {
    const before = await verifyGenerativeDatabaseCertification(runtime, review);
    const after = await verifyGenerativeDatabaseCertification(runtime, { ...review, migrationReceiptSha256: "c".repeat(64) });
    expect(after.databaseBindingSha256).not.toBe(before.databaseBindingSha256); expect(after.approved).toBe(false);
  });
  it("captures the reviewed profile digest before awaiting the database", async () => {
    const input = { ...review }, work = verifyGenerativeDatabaseCertification(runtime, input);
    input.profilesSha256 = "f".repeat(64);
    await expect(work).resolves.toMatchObject({ publicStartup: false });
  });
  it.each([
    ["budget exceeds JS precision", "UPDATE open_mint.budget_policies SET max_exposure_usd_ticks=9007199254740992"],
    ["deployment block exceeds JS precision", "UPDATE open_mint.request_profiles SET deployment_block=9007199254740992"],
    ["different renderer", "UPDATE open_mint.generative_input_profiles SET renderer_code_hash='0x' || repeat('5',64)"],
    ["different origin", "UPDATE open_mint.session_profiles SET origin='https://evil.invalid'"],
    ["local namespace", "UPDATE open_mint.namespaces SET profile='local-real'"],
    ["different model", "UPDATE open_mint.budget_policies SET expected_model='different-model'"],
  ])("rejects exact profile drift: %s", async (_name, sql) => {
    await db.query("BEGIN; SET LOCAL session_replication_role=replica");
    await db.query(sql); await db.query("COMMIT");
    await expect(verifyGenerativeDatabaseCertification(runtime, review)).rejects.toThrow();
  });
  it("does not hash live wallet, mint or writer state into the static schema/policy binding", async () => {
    const before = await verifyGenerativeDatabaseCertification(runtime, review);
    await db.query("UPDATE open_mint.writer_epoch SET epoch=99");
    await db.query("INSERT INTO open_mint.handle_guards VALUES($1,'alice')", [target.namespaceId]);
    const after = await verifyGenerativeDatabaseCertification(runtime, review);
    expect(after.databaseBindingSha256).toBe(before.databaseBindingSha256);
  });
  it("times out behind real database work without closing or replaying the connection", async () => {
    const busy = runtime.query("SELECT pg_catalog.pg_sleep(0.1)");
    const calls = vi.spyOn(runtime, "query");
    await expect(verifyGenerativeDatabaseCertification(runtime, review, undefined, 20)).rejects.toThrow();
    await busy; await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toHaveBeenCalledTimes(1); calls.mockRestore();
    await expect(verifyGenerativeDatabaseCertification(runtime, review)).resolves.toMatchObject({ approved: false });
  });
});
