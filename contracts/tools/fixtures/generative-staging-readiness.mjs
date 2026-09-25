import { readFileSync } from "node:fs";
import { Client } from "pg";
import { deploymentFixture } from "./generative-deployment.mjs";
import { deploymentPlan } from "../generative-release.mjs";
import { operatingPlan } from "../generative-operating-plan.mjs";
import { pausedReadinessScope } from "../generative-staging-readiness.mjs";
import { operatingSettingsFixture } from "../../../src/openMint/staging/fixtures/operatingPlan.ts";
import { readinessReviewFixture } from "../../../src/openMint/staging/fixtures/readinessReview.ts";
import { admissionDigest } from "../../../src/openMint/staging/admission.ts";
import { POLICY_VERSION } from "../../../src/openMint/identity.ts";
import { GENERATIVE_DATABASE_LOCK, GENERATIVE_DATABASE_MIGRATIONS } from "../../../src/openMint/persistence/databaseSchemaLock.ts";
import { GENERATIVE_DATABASE_V2_LOCK } from "../../../src/openMint/persistence/databaseSchemaV2Lock.ts";
import { observeGenerativeDatabase, observeGenerativeV2Database } from "../../../src/openMint/persistence/databaseCertification.ts";
import { generativeBrowserRuntimeGrants, stagingRecoveryGrants } from "../../../src/openMint/persistence/runtimeRole.ts";
import { stagingInspectorGrants } from "../../../src/openMint/persistence/stagingOperatorRole.ts";

/** Offline chain/settings fixture only: no real accounts, secrets or evidence. */
export async function readinessInputFixture({ v2 = false } = {}) {
  const chain = await deploymentFixture();
  for (const [name, principal] of Object.entries(chain.config.principals)) principal.ownerReference = `custodians/${name.toLowerCase()}`;
  const d = deploymentPlan(chain.config), settings = operatingSettingsFixture(d);
  const assessmentPolicy = { schema: "sg-readiness-assessment-policy-v1", model: "grok-offline-test", profileVersion: "readiness-offline-test", policyVersion: POLICY_VERSION };
  settings.assessment.profileSha256 = admissionDigest(assessmentPolicy);
  settings.assessment.validFrom = new Date(chain.now()).toISOString(); settings.assessment.validUntil = new Date(chain.now() + 86400000).toISOString();
  settings.hosting.requestTimeoutMs = 5000; settings.hosting.drainTimeoutMs = 5000; settings.rpc.timeoutMs = 3000;
  if (v2) {
    settings.schema = "sg-sepolia-operating-settings-v2";
    settings.database.schemaProfile = GENERATIVE_DATABASE_V2_LOCK.version;
    settings.database.roles.inspector = { name: "sg_inspector", connectionSecretReference: "secret:gallery/database/inspector" };
  }
  const target = { database: "readiness_test", ownerRole: "sg_migrator", runtimeRole: "sg_browser",
    namespaceId: "11111111-1111-4111-8111-111111111111", deploymentId: settings.deploymentId };
  const input = { operatingJson: JSON.stringify({ deployment: chain.config, settings }), transactions: { ...chain.transactions },
    databaseReview: { ...target, ...(v2 ? { version: "sg-generative-paused-db-review-v2", inspectorRole: "sg_inspector", recoveryRole: "sg_recovery" } : {}),
      migrationManifestSha256: (v2 ? GENERATIVE_DATABASE_V2_LOCK : GENERATIVE_DATABASE_LOCK).migrationManifestSha256,
      migrationReceiptSha256: "a".repeat(64), profilesSha256: "b".repeat(64), reviewRevisionSha256: "c".repeat(64) },
    assessmentPolicy, port: 0, maxDeploymentSpan: 256 };
  const sources = chain.sources.map((source, i) => ({ ...source, id: settings.rpc.sources[i].id, operatorReference: settings.rpc.sources[i].operatorReference }));
  return { chain, d, settings, target, input, sources };
}

/** Called ONLY with the disposable cluster helper's isolated socket config.
 * Migration owner differs from the cluster superuser, like deployed PG16. */
export async function readinessDatabaseFixture(cluster, admin, { v2 = false } = {}) {
  const f = await readinessInputFixture({ v2 }), { input, target, settings: s, d } = f;
  await admin.query(`CREATE ROLE sg_migrator NOLOGIN; CREATE ROLE sg_browser LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    ${v2 ? "CREATE ROLE sg_inspector LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE sg_recovery LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;" : ""}`);
  await admin.query("CREATE DATABASE readiness_test OWNER sg_migrator");
  const db = new Client({ ...cluster.config, database: target.database }); await db.connect();
  let runtime;
  try {
    await db.query("SET ROLE sg_migrator");
    for (const migration of GENERATIVE_DATABASE_MIGRATIONS) await db.query(readFileSync(new URL(`../../../src/openMint/persistence/${migration.path}`, import.meta.url), "utf8"));
    await db.query(generativeBrowserRuntimeGrants(target.runtimeRole));
    await db.query("INSERT INTO open_mint.namespaces VALUES($1,'staging-testnet','grok',$2)", [target.namespaceId, POLICY_VERSION]);
    await db.query("INSERT INTO open_mint.budget_policies VALUES($1,$2,$3,false,$4,$5,$6,1,$7,$8,$9)", [target.namespaceId,
      input.assessmentPolicy.profileVersion, input.assessmentPolicy.model, s.assessment.validUntil, s.assessment.totalAttempts,
      s.assessment.dailyAttempts, s.assessment.maxQueued, s.assessment.reservationUsdTicks, s.assessment.maxExposureUsdTicks]);
    await db.query("INSERT INTO open_mint.session_profiles VALUES($1,$2,11155111)", [target.namespaceId, s.origin]);
    const p = operatingPlan(input.operatingJson).operatingPlan, receipt = f.chain.receipts[f.chain.transactions.collection];
    await db.query("INSERT INTO open_mint.request_profiles VALUES($1,$2,11155111,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [target.namespaceId, target.deploymentId,
      d.collection.address, f.chain.config.genesisHash, p.collectionRuntimeCodeHash, d.principals.authorizer.address,
      BigInt(receipt.blockNumber).toString(), receipt.blockHash, s.rpc.evidenceTtlMs, s.rpc.maxHeadAgeMs, s.rpc.maxFutureSkewMs]);
    await db.query("INSERT INTO open_mint.generative_input_profiles VALUES($1,$2,$3,$4,$5,$6)", [target.namespaceId, target.deploymentId,
      d.inputProfile, d.renderer.address, d.renderer.runtimeCodeHash, d.renderer.identity]);
    await db.query("INSERT INTO open_mint.generative_issuance_profiles VALUES($1,$2,false,600,1000,$3,$4,$5)",
      [target.namespaceId, target.deploymentId, s.rpc.evidenceTtlMs, s.rpc.maxHeadAgeMs, s.rpc.maxFutureSkewMs]);
    if (v2) {
      await db.query(readFileSync(new URL("../../../src/openMint/persistence/generative-staging-recovery-schema.sql", import.meta.url), "utf8"));
      await db.query(stagingInspectorGrants("sg_inspector"));
      await db.query(stagingRecoveryGrants("sg_recovery"));
    }
    await db.query("RESET ROLE");
    runtime = new Client({ ...cluster.config, database: target.database, user: target.runtimeRole, options: "-c search_path=pg_catalog -c timezone=UTC" }); await runtime.connect();
    const pin = async () => {
      // Fixture-only self-pinning: expressly not an operator approval workflow.
      input.databaseReview.profilesSha256 = (v2 ? await observeGenerativeV2Database(runtime,
        { ...target, inspectorRole: "sg_inspector", recoveryRole: "sg_recovery" }) : await observeGenerativeDatabase(runtime, target)).profilesSha256;
      const signed = readinessReviewFixture(pausedReadinessScope(input).scopeSha256, f.chain.now());
      return { ...input, sources: f.sources, connection: runtime, review: signed.source };
    };
    return { ...f, db, runtime, pin, async close() { await runtime.end(); await db.end();
      await admin.query("DROP DATABASE readiness_test"); await admin.query(`DROP ROLE sg_browser; ${v2 ? "DROP ROLE sg_inspector; DROP ROLE sg_recovery;" : ""} DROP ROLE sg_migrator`); } };
  } catch (error) {
    await runtime?.end(); await db.end(); await admin.query("DROP DATABASE readiness_test");
    await admin.query(`DROP ROLE sg_browser; ${v2 ? "DROP ROLE sg_inspector; DROP ROLE sg_recovery;" : ""} DROP ROLE sg_migrator`); throw error;
  }
}
