import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { ExclusiveWriter, WRITER_LOCK } from "../../../src/openMint/persistence/writer.ts";
import { OpenMintRepository } from "../../../src/openMint/persistence/repository.ts";
import { PostgresMintRequests } from "../../../src/openMint/persistence/requests.ts";
import { PostgresWalletSessions } from "../../../src/openMint/persistence/sessions.ts";
import { observeGenerativeDatabase, observeGenerativeRuntimeDatabase, observeGenerativeV2Database, verifyGenerativeDatabaseCertification,
  verifyGenerativeV2Database } from "../../../src/openMint/persistence/databaseCertification.ts";
import { GENERATIVE_DATABASE_LOCK, GENERATIVE_DATABASE_MIGRATIONS } from "../../../src/openMint/persistence/databaseSchemaLock.ts";
import { GENERATIVE_DATABASE_V2_LOCK, GENERATIVE_DATABASE_V2_MIGRATIONS } from "../../../src/openMint/persistence/databaseSchemaV2Lock.ts";
import { createStagingAssessmentController } from "../generative-staging-assessment.mjs";
import { stagingReviewFixture } from "../../../src/openMint/staging/fixtures/stagingReview.ts";

const sha = value => createHash("sha256").update(value).digest("hex");
const PG_ENV = Object.freeze({ PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C" });
const binary = name => process.env.OPEN_MINT_TEST_POSTGRES_BIN
  ? `${process.env.OPEN_MINT_TEST_POSTGRES_BIN}/${name}` : name;
const options = { env: PG_ENV, timeout: 20000, maxBuffer: 32 * 1024 * 1024 };
// Test harness ordering only. This is not an operator approval mechanism.
const acceptedRestores = new WeakMap();
function assertDisposable(cluster) {
  assert.match(String(cluster?.config?.host), /^\/tmp\/sg-open-mint-pg-[A-Za-z0-9]+\/socket$/);
  assert.equal(cluster.config.user, "open_mint_test");
  assert.equal(cluster.config.database, "postgres");
}
const lockedTables = migrations => Object.freeze(migrations.flatMap(migration => {
  const source = readFileSync(new URL(`../../../src/openMint/persistence/${migration.path}`, import.meta.url), "utf8");
  assert.equal(sha(source), migration.sha256, `Migration source changed: ${migration.path}`);
  return [...source.matchAll(/CREATE TABLE open_mint\.([a-z][a-z0-9_]*)/g)].map(match => match[1]);
}).sort());
const LOCKED_TABLES = lockedTables(GENERATIVE_DATABASE_MIGRATIONS);
const LOCKED_TABLES_V2 = lockedTables(GENERATIVE_DATABASE_V2_MIGRATIONS);

function tool(name, args, input) {
  const result = spawnSync(binary(name), args, { ...options, input, encoding: null });
  if (result.error || result.status !== 0 || result.signal) throw Error(`${name} failed in disposable restore test`);
  return result.stdout;
}

export function verifyPostgres16Tools() {
  return Object.fromEntries(["pg_dump", "pg_restore"].map(name => {
    const version = tool(name, ["--version"]).toString().trim();
    assert.match(version, /^pg_(?:dump|restore) \(PostgreSQL\) 16\./);
    return [name, version];
  }));
}

/** Hash all application table contents. Never serialize private rows to logs. */
export async function restoreInventory(client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'; SET LOCAL bytea_output='hex'");
    const names = (await client.query(`SELECT c.relname FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='open_mint' AND c.relkind IN ('r','p') ORDER BY c.relname`)).rows.map(row => row.relname);
    assert.ok(JSON.stringify(names) === JSON.stringify(LOCKED_TABLES) || JSON.stringify(names) === JSON.stringify(LOCKED_TABLES_V2),
      "RC1 table inventory differs from a locked migration profile");
    const tables = [];
    for (const name of names) {
      assert.match(name, /^[a-z][a-z0-9_]*$/);
      const rows = (await client.query(`SELECT pg_catalog.row_to_json(t)::text AS value FROM open_mint.${name} t LIMIT 1000`)).rows
        .map(row => row.value).sort();
      assert.ok(rows.length < 1000, "Unbounded restore fixture");
      tables.push(Object.freeze({ name, rows: rows.length, sha256: sha(rows.join("\n")) }));
    }
    await client.query("COMMIT");
    return Object.freeze({ tables: Object.freeze(tables), sha256: sha(JSON.stringify(tables)) });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

/** Only the caller's disposablePostgres() cluster/socket can be supplied. */
export function dumpDisposable(cluster, database) {
  assertDisposable(cluster);
  const versions = verifyPostgres16Tools();
  assert.equal(database, "readiness_test");
  const started = performance.now();
  const bytes = tool("pg_dump", ["--format=custom", "--host", String(cluster.config.host),
    "--username", "open_mint_test", "--dbname", database, "--no-password"]);
  assert.ok(bytes.length > 0 && bytes.length < 32 * 1024 * 1024);
  return Object.freeze({ bytes, sha256: sha(bytes), size: bytes.length, durationMs: performance.now() - started, versions });
}

/** Capture SOURCE pins only after its fixture runtime/writer has stopped. The
 * caller retains external isolation: an advisory lock does not fence a clone. */
export async function stoppedFixtureBackup(cluster, fixture) {
  if (fixture.writer) assert.throws(() => fixture.writer.assertHealthy(), /writer unavailable/);
  assert.equal((await fixture.db.query(`SELECT count(*)::integer AS n FROM pg_catalog.pg_locks
    WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND objsubid=2 AND granted
      AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())`, [...WRITER_LOCK])).rows[0].n, 0);
  const v2 = fixture.input.databaseReview.version === "sg-generative-paused-db-review-v2"
    || fixture.input.databaseReview.version === "sg-generative-runtime-db-review-v2";
  const target = v2 ? { ...fixture.target, inspectorRole: "sg_inspector", recoveryRole: "sg_recovery" } : fixture.target;
  const paused = v2 ? await observeGenerativeV2Database(fixture.runtime, target) : await observeGenerativeDatabase(fixture.runtime, target);
  const runtime = v2 ? await observeGenerativeV2Database(fixture.runtime, target, undefined, 5000, true)
    : await observeGenerativeRuntimeDatabase(fixture.runtime, target);
  assert.equal(runtime.generationEnabled, false); assert.equal(runtime.issuanceEnabled, false);
  const { version: _version, ...review } = fixture.input.databaseReview;
  const pausedReview = Object.freeze({ ...review, ...(v2 ? { version: "sg-generative-paused-db-review-v2" } : {}), profilesSha256: paused.profilesSha256 });
  if (v2) await verifyGenerativeV2Database(fixture.runtime, pausedReview);
  else await verifyGenerativeDatabaseCertification(fixture.runtime, pausedReview);
  const inventory = await restoreInventory(fixture.db), archive = dumpDisposable(cluster, "readiness_test");
  assert.deepEqual(await restoreInventory(fixture.db), inventory, "Source changed while dumping");
  const completion = Object.freeze({ version: v2 ? "r4-stopped-fixture-v2" : "r3-stopped-fixture-v1", sourceStopped: true,
    archiveSha256: archive.sha256, inventorySha256: inventory.sha256, pausedReview,
    runtimeProfilesSha256: runtime.profilesSha256,
    serverVersion: (await fixture.db.query("SHOW server_version")).rows[0].server_version });
  return { inventory, archive, completion };
}

export async function restoreDisposable(cluster, archive, expectedSha256, { v2 = false } = {}) {
  assertDisposable(cluster);
  verifyPostgres16Tools();
  assert.equal(typeof expectedSha256, "string");
  if (sha(archive.bytes) !== expectedSha256) throw Error("Restore archive integrity unavailable");
  const admin = new Client(cluster.config); await admin.connect();
  let db, runtime, writer, createdRoles = false, createdDatabase = false;
  try {
    await admin.query(`CREATE ROLE sg_migrator NOLOGIN; CREATE ROLE sg_browser LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      ${v2 ? "CREATE ROLE sg_inspector LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE sg_recovery LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;" : ""}`);
    createdRoles = true;
    await admin.query("CREATE DATABASE readiness_test OWNER sg_migrator");
    createdDatabase = true;
    const started = performance.now();
    tool("pg_restore", ["--host", String(cluster.config.host), "--username", "open_mint_test",
      "--dbname", "readiness_test", "--exit-on-error", "--single-transaction", "--no-password"], archive.bytes);
    const durationMs = performance.now() - started;
    db = new Client({ ...cluster.config, database: "readiness_test" }); await db.connect();
    runtime = new Client({ ...cluster.config, database: "readiness_test", user: "sg_browser",
      options: "-c search_path=pg_catalog -c timezone=UTC" }); await runtime.connect();
    const restored = { admin, db, runtime, durationMs, archiveSha256: expectedSha256,
      writer: () => writer,
      async acquire() {
        const accepted = acceptedRestores.get(restored);
        assert.ok(accepted, "Restore verification required before ownership");
        assert.equal(writer, undefined, "Previous restored writer must close");
        await verifyRestoredFixture(restored, accepted.fixture, accepted.inventory, accepted.completion);
        writer = await ExclusiveWriter.acquire(() => new Client({ ...cluster.config, database: "readiness_test",
          user: "sg_browser", options: "-c search_path=pg_catalog -c timezone=UTC" }));
        return writer;
      },
      async closeWriter() { await writer?.close(); writer = undefined; },
      async close() {
        acceptedRestores.delete(restored);
        await writer?.close(); writer = undefined;
        await runtime?.end(); await db?.end();
        await admin.query("DROP DATABASE readiness_test");
        await admin.query(`DROP ROLE sg_browser; ${v2 ? "DROP ROLE sg_inspector; DROP ROLE sg_recovery;" : ""} DROP ROLE sg_migrator`);
        await admin.end();
      },
    };
    return restored;
  } catch (error) {
    await writer?.close().catch(() => {}); await runtime?.end().catch(() => {}); await db?.end().catch(() => {});
    if (createdDatabase) await admin.query("DROP DATABASE readiness_test").catch(() => {});
    if (createdRoles) await admin.query(`DROP ROLE sg_browser; ${v2 ? "DROP ROLE sg_inspector; DROP ROLE sg_recovery;" : ""} DROP ROLE sg_migrator`).catch(() => {});
    await admin.end().catch(() => {});
    throw error;
  }
}

/** Independent evidence must come from outside the archive, before opening. */
export async function verifyRestoredFixture(restored, fixture, inventory, completion) {
  acceptedRestores.delete(restored);
  const v2 = completion?.version === "r4-stopped-fixture-v2";
  if (!completion || !["r3-stopped-fixture-v1","r4-stopped-fixture-v2"].includes(completion.version) || completion.archiveSha256 !== restored.archiveSha256
    || completion.inventorySha256 !== inventory.sha256 || completion.sourceStopped !== true)
    throw Error("Restore completeness unavailable");
  const after = await restoreInventory(restored.db);
  if (JSON.stringify(after) !== JSON.stringify(inventory)) throw Error("Restore inventory mismatch");
  const target = v2 ? { ...fixture.target, inspectorRole: "sg_inspector", recoveryRole: "sg_recovery" } : fixture.target;
  const observed = v2 ? await observeGenerativeV2Database(restored.runtime, target, undefined, 5000, true)
    : await observeGenerativeRuntimeDatabase(restored.runtime, target);
  const lock = v2 ? GENERATIVE_DATABASE_V2_LOCK : GENERATIVE_DATABASE_LOCK;
  assert.equal(observed.schemaSha256, lock.schemaSha256);
  assert.equal(observed.grantsSha256, lock.grantsSha256);
  assert.equal(observed.generationEnabled, false);
  assert.equal(observed.issuanceEnabled, false);
  assert.equal(observed.profilesSha256, completion.runtimeProfilesSha256, "Restored profiles differ from source pins");
  const paused = v2 ? await verifyGenerativeV2Database(restored.runtime, completion.pausedReview)
    : await verifyGenerativeDatabaseCertification(restored.runtime, completion.pausedReview);
  acceptedRestores.set(restored, { fixture, inventory, completion });
  return { after, observed, paused };
}

/** Construct fresh runtime objects without calling a seeding fixture. */
export async function openRestoredSiteInput(restored, fixture) {
  const accepted = acceptedRestores.get(restored);
  assert.ok(accepted && accepted.fixture === fixture, "Restore verification required before site open");
  const writer = await restored.acquire();
  const repository = await OpenMintRepository.open(writer, fixture.ns);
  const requests = await PostgresMintRequests.open(repository, fixture.target.deploymentId);
  const sessions = await PostgresWalletSessions.openStaging({ writer, namespaceId: fixture.ns.id,
    origin: fixture.settings.origin, chainId: 11155111 });
  const input = { ...fixture.input, requests,
    databaseReview: { ...fixture.input.databaseReview, profilesSha256: accepted.completion.runtimeProfilesSha256,
      reviewRevisionSha256: sha(JSON.stringify(accepted.completion)) } };
  const candidate = createStagingAssessmentController(input);
  const review = stagingReviewFixture(candidate.scope, { operations: ["reuse"], evidenceSha256: sha(JSON.stringify(accepted.completion)) });
  candidate.halt(); input.reviewSource = review.source;
  return { input, requests, sessions, repository, writer, review };
}
