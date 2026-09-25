import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "pg";
import { disposablePostgres } from "../../src/openMint/persistence/fixtures/postgres.ts";
import { readinessDatabaseFixture } from "./fixtures/generative-staging-readiness.mjs";
import { stagingAssessmentFixture } from "./fixtures/generative-staging-assessment.mjs";
import { restoreInventory } from "./fixtures/generative-staging-restore.mjs";
import { observeGenerativeDatabase, verifyGenerativeDatabaseCertification, verifyGenerativeV2Database } from "../../src/openMint/persistence/databaseCertification.ts";
import { GENERATIVE_DATABASE_V2_LOCK } from "../../src/openMint/persistence/databaseSchemaV2Lock.ts";
import { migrateStagingDatabaseV2 } from "../../src/openMint/persistence/stagingMigration.ts";

for (const scenario of ["upgrade", "wrong-source", "source-drift", "enabled", "writer-held", "wrong-backup", "grant-failure", "lost-commit"])
test(`R4 explicit v1-to-v2 migration: ${scenario}`, {skip:process.env.OPEN_MINT_TEST_POSTGRES!=="1"}, async()=>{
  const cluster=disposablePostgres(),admin=new Client(cluster.config);let f;
  try {
    await admin.connect();
    const populated=["upgrade","lost-commit"].includes(scenario);
    f=populated?await stagingAssessmentFixture(cluster,admin):await readinessDatabaseFixture(cluster,admin);
    if(populated){
      await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=false");
      await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false");
      await f.writer.close();
    }
    const {version: _version,...sourceFields}=f.input.databaseReview;
    const observed=await observeGenerativeDatabase(f.runtime,f.target);
    const sourceReview={...sourceFields,profilesSha256:observed.profilesSha256};
    await admin.query("ALTER ROLE sg_migrator LOGIN; CREATE ROLE sg_inspector LOGIN; CREATE ROLE sg_recovery LOGIN");
    // Representative historical data must survive byte-for-byte; no relabeling.
    await f.db.query("INSERT INTO open_mint.handle_guards VALUES($1,'alice') ON CONFLICT DO NOTHING",[f.target.namespaceId]);
    const before=await restoreInventory(f.db);
    if(populated)for(const name of ["sessions","requests","assessment_attempts","budget_reservations","jobs"])
      assert.ok(before.tables.find(t=>t.name===name).rows>0,`missing populated ${name}`);
    const certified=await verifyGenerativeDatabaseCertification(f.runtime,sourceReview);
    const targetReview={...sourceReview,version:"sg-generative-paused-db-review-v2",inspectorRole:"sg_inspector",recoveryRole:"sg_recovery",
      migrationManifestSha256:GENERATIVE_DATABASE_V2_LOCK.migrationManifestSha256};
    let ddl=false,commits=0;
    const config={browserCatalog:f.runtime,sourceReview,targetReview,
      migrationSql:readFileSync(new URL("../../src/openMint/persistence/generative-staging-recovery-schema.sql",import.meta.url),"utf8"),
      stoppedBackup:{version:"sg-stopped-backup-review-v1",databaseBindingSha256:certified.databaseBindingSha256,
        archiveSha256:"a".repeat(64),completionRevisionSha256:"b".repeat(64)}, // fixture custody, not real backup attestation
      connectMigrator:()=>{
        const client=new Client({...cluster.config,database:f.target.database,user:"sg_migrator"}),query=client.query.bind(client);
        client.query=async(sql,...args)=>{
          if(sql.includes("CREATE TABLE open_mint.staging_generative_recoveries"))ddl=true;
          if(scenario==="grant-failure"&&ddl&&sql.startsWith("GRANT"))throw Error("fixture grant failure");
          const value=await query(sql,...args);
          if(sql==="COMMIT"){commits++;if(scenario==="lost-commit")throw Error("fixture lost commit reply");}
          return value;
        };return client;
      }};
    if(scenario==="wrong-source")config.migrationSql+="\n-- unreviewed";
    if(scenario==="source-drift")await f.db.query("ALTER TABLE open_mint.handle_guards ADD COLUMN unreviewed text");
    if(scenario==="enabled")await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=true");
    if(scenario==="writer-held")await f.db.query("SELECT pg_advisory_lock(1936152941,17)");
    if(scenario==="wrong-backup")config.stoppedBackup.databaseBindingSha256="f".repeat(64);
    if(scenario==="upgrade"){
      assert.equal((await migrateStagingDatabaseV2(config)).status,"upgraded-paused");
    }else await assert.rejects(migrateStagingDatabaseV2(config),error=>error.outcome===(scenario==="lost-commit"?"unknown":"not-committed"));
    if(["upgrade","lost-commit"].includes(scenario)){
      await verifyGenerativeV2Database(f.runtime,targetReview);
      const after=await restoreInventory(f.db);
      assert.deepEqual(after.tables.filter(t=>t.name!=="staging_generative_recoveries"),before.tables);
      assert.equal(after.tables.find(t=>t.name==="staging_generative_recoveries").rows,0);
      await assert.rejects(migrateStagingDatabaseV2(config),error=>error.outcome==="not-committed");
      assert.equal(commits,1);
    }else{
      assert.equal((await f.db.query("SELECT to_regclass('open_mint.staging_generative_recoveries') AS ledger")).rows[0].ledger,null);
      assert.equal(commits,0);
      if(scenario==="grant-failure")assert.deepEqual(await restoreInventory(f.db),before);
      else assert.equal(ddl,false);
    }
  }finally{
    await f?.close();await admin.query("DROP ROLE IF EXISTS sg_inspector; DROP ROLE IF EXISTS sg_recovery").catch(()=>{});
    await admin.end();cluster.stop();
  }
});
