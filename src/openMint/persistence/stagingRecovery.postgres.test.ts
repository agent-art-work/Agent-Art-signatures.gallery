import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposablePostgres } from "./fixtures/postgres.js";
import { GENERATIVE_DATABASE_MIGRATIONS } from "./databaseSchemaLock.js";
import { stagingInspectorGrants, requireStagingInspectorRole } from "./stagingOperatorRole.js";
import { inspectStagingOperation, inspectStagingRetirementOutcome } from "./stagingOperatorInspection.js";
import { GENERATIVE_DATABASE_CATALOG_V2_SQL } from "./databaseCatalog.js";
import { GENERATIVE_DATABASE_V2_LOCK, GENERATIVE_DATABASE_V2_MIGRATIONS } from "./databaseSchemaV2Lock.js";
import { observeGenerativeV2Database, verifyGenerativeV2Database, verifyGenerativeDatabaseCertification } from "./databaseCertification.js";
import { GENERATIVE_DATABASE_LOCK } from "./databaseSchemaLock.js";
import { GENERATIVE_BROWSER_RUNTIME_PRIVILEGES, generativeBrowserRuntimeGrants, stagingRecoveryGrants } from "./runtimeRole.js";
import { requireStagingRecoveryRole } from "./roleAudit.js";

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("R4 staging inspection and migration (disposable PG16)", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, inspector: Client;
  const ns = "11111111-1111-4111-8111-111111111111", dep = "22222222-2222-4222-8222-222222222222";
  const attempt = "33333333-3333-4333-8333-333333333333";
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect();
    for (const migration of GENERATIVE_DATABASE_MIGRATIONS) await admin.query(readFileSync(new URL(migration.path, import.meta.url), "utf8"));
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,'staging-testnet','grok','r4-fixture')", [ns]);
    await admin.query("INSERT INTO open_mint.budget_policies VALUES($1,'r4-fixture','grok-offline',false,'2099-01-01',1,1,1,1,100,1000)", [ns]);
    await admin.query("INSERT INTO open_mint.session_profiles VALUES($1,'https://staging.signatures.gallery',11155111)", [ns]);
    await admin.query("INSERT INTO open_mint.request_profiles VALUES($1,$2,11155111,$3,$4,$4,$3,1,$4,10000,120000,5000)",
      [ns,dep,`0x${"1".repeat(40)}`,`0x${"2".repeat(64)}`]);
    await admin.query("INSERT INTO open_mint.generative_input_profiles VALUES($1,$2,'sg-generative-inputs-v1-rc1',$3,$4,$4)",
      [ns,dep,`0x${"3".repeat(40)}`,`0x${"4".repeat(64)}`]);
    await admin.query("INSERT INTO open_mint.generative_issuance_profiles VALUES($1,$2,false,600,1000,10000,120000,5000)", [ns,dep]);
    const migration = readFileSync(new URL("./generative-staging-recovery-schema.sql", import.meta.url), "utf8");
    expect(createHash("sha256").update(migration).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
    try { await admin.query(migration); }
    catch (error) { const e = error as { position?: string }; throw Error(`Staging migration failed near: ${migration.slice(Math.max(0, Number(e.position) - 100), Number(e.position) + 100)}`, { cause: error }); }
    await admin.query("CREATE ROLE sg_inspector LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await admin.query("CREATE ROLE sg_browser LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await admin.query("CREATE ROLE sg_recovery LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await admin.query(generativeBrowserRuntimeGrants("sg_browser"));
    await admin.query(stagingRecoveryGrants("sg_recovery"));
    await admin.query(stagingInspectorGrants("sg_inspector"));
    await admin.query("INSERT INTO open_mint.handle_guards VALUES($1,'alice')", [ns]);
    await admin.query("INSERT INTO open_mint.assessment_attempts(namespace_id,attempt_id,handle,profile_version,admitted_at) VALUES($1,$2,'alice','r4-fixture',now())", [ns,attempt]);
    await admin.query("INSERT INTO open_mint.budget_reservations VALUES($1,$2,current_date,100)", [ns,attempt]);
    await admin.query("INSERT INTO open_mint.jobs(namespace_id,job_id,attempt_id,kind) VALUES($1,$2,$3,'assessment')", [ns,randomUUID(),attempt]);
    await admin.query("INSERT INTO open_mint.dispatch_fences VALUES($1,$2,'grok',1,now())", [ns,attempt]);
    await admin.query("INSERT INTO open_mint.provider_receipts VALUES($1,$2,'grok',1,$3,'unknown',NULL)", [ns,attempt,Buffer.from('PRIVATE_PROVIDER_CANARY')]);
    inspector = new Client({ ...cluster.config, user: "sg_inspector", options: "-c search_path=pg_catalog -c timezone=UTC" }); await inspector.connect();
  }, 30000);
  afterAll(async () => { await inspector?.end(); await admin?.end(); cluster?.stop(); });

  it("reports only bounded metadata and never advances the writer epoch", async () => {
    await expect(requireStagingInspectorRole(inspector)).resolves.toBeUndefined();
    const before = (await admin.query("SELECT epoch FROM open_mint.writer_epoch")).rows;
    const report = await inspectStagingOperation(inspector,{namespaceId:ns,deploymentId:dep},{kind:"attempt",id:attempt},new AbortController().signal);
    expect(report).toMatchObject({ version:"sg-staging-inspection-v1",handle:"alice",chainVerification:"not-performed",
      nextAction:"operator-reconciliation-required" });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_PROVIDER_CANARY");
    expect((await admin.query("SELECT epoch FROM open_mint.writer_epoch")).rows).toEqual(before);
    await expect(inspector.query("SELECT payload FROM open_mint.provider_receipts")).rejects.toThrow();
    await expect(inspector.query("UPDATE open_mint.writer_epoch SET epoch=epoch+1")).rejects.toThrow();
    await expect(inspectStagingOperation(inspector,{namespaceId:ns,deploymentId:randomUUID()},{kind:"attempt",id:attempt},new AbortController().signal))
      .rejects.toThrow();
  });
  it("refuses cancelled, malformed and cross-namespace references without opening mutation authority", async () => {
    const before = (await admin.query("SELECT epoch FROM open_mint.writer_epoch")).rows;
    const cancelled = new AbortController(); cancelled.abort();
    await expect(inspectStagingOperation(inspector,{namespaceId:ns,deploymentId:dep},{kind:"attempt",id:attempt},cancelled.signal))
      .rejects.toThrow();
    await expect(inspectStagingOperation(inspector,{namespaceId:ns,deploymentId:dep},{kind:"attempt",id:"alice"},new AbortController().signal))
      .rejects.toThrow();
    await expect(inspectStagingOperation(inspector,{namespaceId:randomUUID(),deploymentId:dep},{kind:"attempt",id:attempt},new AbortController().signal))
      .rejects.toThrow();
    await expect(inspectStagingRetirementOutcome(inspector,{namespaceId:ns,deploymentId:dep},randomUUID(),new AbortController().signal))
      .resolves.toMatchObject({status:"not-recorded"});
    expect((await admin.query("SELECT epoch FROM open_mint.writer_epoch")).rows).toEqual(before);
  });
  it("rejects extra column and unrelated-table grants", async () => {
    await admin.query("GRANT SELECT (payload) ON open_mint.provider_receipts TO sg_inspector");
    await expect(requireStagingInspectorRole(inspector)).rejects.toThrow();
    await admin.query("REVOKE SELECT (payload) ON open_mint.provider_receipts FROM sg_inspector");
    await admin.query("GRANT SELECT ON open_mint.sessions TO sg_inspector");
    await expect(requireStagingInspectorRole(inspector)).rejects.toThrow();
    await admin.query("REVOKE SELECT ON open_mint.sessions FROM sg_inspector");
  });
  it("drains cancelled inspection and bounds related-row overflow without disclosing a partial report",async()=>{
    const abort=new AbortController();
    const cancelled={async query(sql:string,args?:unknown[]){const result=await inspector.query(sql,args);
      if(sql.startsWith("SELECT attempt_id,handle"))abort.abort();return result;}};
    await expect(inspectStagingOperation(cancelled,{namespaceId:ns,deploymentId:dep},{kind:"attempt",id:attempt},abort.signal)).rejects.toThrow();
    expect((await inspector.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("off");
    const overflow={async query(sql:string,args?:unknown[]){const result=await inspector.query(sql,args);
      if(sql.startsWith("SELECT request_id,assessment_id"))return {rows:Array.from({length:33},()=>({request_id:randomUUID(),assessment_id:null}))};
      return result;}};
    await expect(inspectStagingOperation(overflow,{namespaceId:ns,deploymentId:dep},{kind:"attempt",id:attempt},new AbortController().signal)).rejects.toThrow();
    expect((await inspector.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("off");
  });
  it("redacts saved projection reasons and gives a safety halt priority",async()=>{
    await admin.query("INSERT INTO open_mint.projection_deployments VALUES($1,$2,$3)",[dep,ns,Buffer.from("{}")]);
    const projected={async query(sql:string,args?:unknown[]){const result=await inspector.query(sql,args);
      if(sql.startsWith("SELECT health,halt_reason"))return {rows:[{health:"safety-halted",halt_reason:"PRIVATE_HALT_CANARY"}]};return result;}};
    const report=await inspectStagingOperation(projected,{namespaceId:ns,deploymentId:dep},{kind:"attempt",id:attempt},new AbortController().signal);
    expect(report.nextAction).toBe("operator-reconciliation-required");expect(JSON.stringify(report)).not.toContain("PRIVATE_HALT_CANARY");
  });
  it.each(["role-power","trigger-bypass","membership","public-column","truncate-other-table"])("rejects effective operator escalation: %s",async scenario=>{
    const recovery=new Client({...cluster.config,user:"sg_recovery",options:"-c search_path=pg_catalog -c statement_timeout=5000"});await recovery.connect();
    const statements:Record<string,[string,string]>={
      "role-power":["ALTER ROLE sg_inspector CREATEROLE","ALTER ROLE sg_inspector NOCREATEROLE"],
      "trigger-bypass":["GRANT SET ON PARAMETER session_replication_role TO sg_inspector","REVOKE SET ON PARAMETER session_replication_role FROM sg_inspector"],
      membership:["GRANT sg_inspector TO sg_recovery","REVOKE sg_inspector FROM sg_recovery"],
      "public-column":["GRANT SELECT (payload) ON open_mint.provider_receipts TO PUBLIC","REVOKE SELECT (payload) ON open_mint.provider_receipts FROM PUBLIC"],
      "truncate-other-table":["GRANT TRUNCATE ON open_mint.sessions TO sg_recovery","REVOKE TRUNCATE ON open_mint.sessions FROM sg_recovery"],
    };
    const [grant,revoke]=statements[scenario];
    const browser=new Client({...cluster.config,user:"sg_browser",options:"-c search_path=pg_catalog -c timezone=UTC"});await browser.connect();
    const target={database:"postgres",ownerRole:"open_mint_test",runtimeRole:"sg_browser",namespaceId:ns,deploymentId:dep,
      inspectorRole:"sg_inspector",recoveryRole:"sg_recovery"};
    try{
      const baseline=await observeGenerativeV2Database(browser,target);
      const review={...target,version:"sg-generative-paused-db-review-v2" as const,migrationManifestSha256:GENERATIVE_DATABASE_V2_LOCK.migrationManifestSha256,
        migrationReceiptSha256:"a".repeat(64),profilesSha256:baseline.profilesSha256,reviewRevisionSha256:"b".repeat(64)};
      await admin.query(grant);
      if(scenario==="truncate-other-table"||scenario==="membership")await expect(requireStagingRecoveryRole(recovery)).rejects.toThrow();
      else await expect(requireStagingInspectorRole(inspector)).rejects.toThrow();
      // Catalog certification must also reject before an operator writer is acquired.
      await expect(verifyGenerativeV2Database(browser,review)).rejects.toThrow();
    }finally{await admin.query(revoke);await recovery.end();await browser.end();}
  });
  it("keeps the recovery principal away from browser request and session secrets", async () => {
    const recovery = new Client({ ...cluster.config, user: "sg_recovery", options: "-c search_path=pg_catalog -c timezone=UTC" });
    await recovery.connect();
    try {
      await expect(recovery.query("SELECT code_hash FROM open_mint.requests")).rejects.toThrow();
      await expect(recovery.query("SELECT session_hash FROM open_mint.sessions")).rejects.toThrow();
      await expect(recovery.query("UPDATE open_mint.budget_policies SET generation_enabled=true")).rejects.toThrow();
      await expect(recovery.query("DELETE FROM open_mint.generative_authorizations WHERE false")).rejects.toThrow();
    } finally { await recovery.end(); }
  });
  it("observes the exact v2 schema and grants from the browser role", async () => {
    const browser = new Client({ ...cluster.config, user: "sg_browser", options: "-c search_path=pg_catalog -c timezone=UTC" });
    await browser.connect();
    try {
      await expect(browser.query("DELETE FROM open_mint.generative_authorization_heads WHERE false")).rejects.toThrow();
      await expect(browser.query("UPDATE open_mint.wallet_mint_plans SET nonce_active=false WHERE false")).rejects.toThrow();
      await expect(browser.query("INSERT INTO open_mint.staging_generative_recoveries DEFAULT VALUES")).rejects.toThrow();
      const row = (await browser.query(GENERATIVE_DATABASE_CATALOG_V2_SQL,
        [JSON.stringify(GENERATIVE_BROWSER_RUNTIME_PRIVILEGES),"open_mint_test","sg_browser",ns,dep,"sg_inspector","sg_recovery"])).rows[0];
      expect(row.supported).toBe(true); expect(row.staged).toBe(true);
      const sha = (text: string) => createHash("sha256").update(text).digest("hex");
      expect(sha(row.schema)).toBe(GENERATIVE_DATABASE_V2_LOCK.schemaSha256);
      expect(sha(row.grants)).toBe(GENERATIVE_DATABASE_V2_LOCK.grantsSha256);
      expect(GENERATIVE_DATABASE_V2_MIGRATIONS).toHaveLength(10);
      const target = { database:"postgres",ownerRole:"open_mint_test",runtimeRole:"sg_browser",namespaceId:ns,deploymentId:dep,
        inspectorRole:"sg_inspector",recoveryRole:"sg_recovery" };
      const observed = await observeGenerativeV2Database(browser,target);
      const review = { ...target,version:"sg-generative-paused-db-review-v2" as const,
        migrationManifestSha256:GENERATIVE_DATABASE_V2_LOCK.migrationManifestSha256,migrationReceiptSha256:"a".repeat(64),
        profilesSha256:observed.profilesSha256,reviewRevisionSha256:"b".repeat(64) };
      await expect(verifyGenerativeV2Database(browser,review)).resolves.toMatchObject({kind:"generative-database-match-v2"});
      const runtimeObserved = await observeGenerativeV2Database(browser,target,undefined,5000,true);
      await expect(verifyGenerativeV2Database(browser,{...review,version:"sg-generative-runtime-db-review-v2",
        profilesSha256:runtimeObserved.profilesSha256})).resolves.toMatchObject({kind:"generative-runtime-database-match-v2"});
      await expect(observeGenerativeV2Database(browser,{...target,inspectorRole:"sg_browser"})).rejects.toThrow();
      await expect(verifyGenerativeDatabaseCertification(browser,{ database:target.database,ownerRole:target.ownerRole,
        runtimeRole:target.runtimeRole,namespaceId:ns,deploymentId:dep,migrationManifestSha256:GENERATIVE_DATABASE_LOCK.migrationManifestSha256,
        migrationReceiptSha256:"a".repeat(64),profilesSha256:observed.profilesSha256,reviewRevisionSha256:"b".repeat(64) })).rejects.toThrow();
    } finally { await browser.end(); }
  });
  it("requires complete atomic retirement and preserves immutable history", async () => {
    const request=randomUUID(),auth=randomUUID(),recovery=randomUUID(),session="a".repeat(64),digest=`0x${"b".repeat(64)}`;
    const assessment=randomUUID();
    await admin.query("INSERT INTO open_mint.assessments VALUES($1,'alice',$2,$3,$4,$5)",
      [ns,assessment,attempt,`0x${"c".repeat(64)}`,Buffer.from("{}")]);
    await admin.query("UPDATE open_mint.assessment_attempts SET state='accepted' WHERE namespace_id=$1 AND attempt_id=$2",[ns,attempt]);
    await admin.query("INSERT INTO open_mint.sessions(namespace_id,session_hash,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
      [ns,session,"x".repeat(43)]);
    await admin.query(`INSERT INTO open_mint.requests(namespace_id,request_id,code_hash,deployment_id,session_hash,session_generation,wallet,handle,requested_handle,
      created_at,expires_at,attempt_id,owner_epoch,preflight_observed_at,preflight_valid_until,preflight_block_number,preflight_block_hash,preflight_nonce)
      VALUES($1,$2,$3,$4,$5,0,$6,'alice','Alice',now()-interval '1 hour',now()-interval '45 minutes',$7,1,
      now()-interval '61 minutes',now()-interval '59 minutes',1,$8,1)`,[ns,request,"d".repeat(64),dep,session,`0x${"1".repeat(40)}`,attempt,`0x${"e".repeat(64)}`]);
    await admin.query("INSERT INTO open_mint.generative_inputs VALUES($1,$2,'alice',$3,$4)",
      [ns,dep,`0x${"f".repeat(64)}`,Buffer.from("{}")]);
    await admin.query(`INSERT INTO open_mint.generative_authorizations(namespace_id,authorization_id,deployment_id,handle,request_id,session_hash,
      session_generation,recipient,assessment_id,input_digest,nonce,authorization_digest,issued_at,deadline,payload)
      VALUES($1,$2,$3,'alice',$4,$5,0,$6,$7,$8,$9,$10,1700000000,1700000600,$11)`,
      [ns,auth,dep,request,session,`0x${"1".repeat(40)}`,assessment,`0x${"f".repeat(64)}`,`0x${"a".repeat(64)}`,digest,Buffer.from("{}")]);
    await admin.query("INSERT INTO open_mint.generative_authorization_heads VALUES($1,$2,'alice',$3)",[ns,dep,auth]);
    await admin.query("INSERT INTO open_mint.wallet_mint_plans VALUES($1,$2,$3,$4,$5,1,$6,true)",
      [ns,dep,request,auth,`0x${"1".repeat(40)}`,Buffer.from("x")]);
    const evidence=Buffer.from("operator-proof"),sha="a".repeat(64),block=`0x${"b".repeat(64)}`;
    const insert=async(recoveryId:string,finalized="1700000601",ttlMs=60000)=>admin.query(`INSERT INTO open_mint.staging_generative_recoveries(
      namespace_id,recovery_id,deployment_id,authorization_id,request_id,authorization_digest,snapshot_hash,
      approval_revision,target_digest,database_binding,active_policy_digest,operator_reference,evidence_reference,
      finalized_number,finalized_hash,finalized_timestamp,latest_number,latest_hash,latest_timestamp,
      source_ids,observed_at,valid_until,evidence,owner_epoch)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'operator:r4','evidence:r4',10,$12,$13,11,$12,$14,
      ARRAY['source-one','source-two'],now()-interval '1 second',now()+$16*interval '1 millisecond',$15,1)`,
      [ns,recoveryId,dep,auth,request,digest,sha,sha,sha,sha,sha,block,finalized,"1700000602",evidence,ttlMs]);
    await admin.query("SELECT pg_advisory_lock(1936152941,17)");
    try {
      await admin.query("UPDATE open_mint.writer_epoch SET epoch=1");
      await admin.query("BEGIN");
      await expect(insert(recovery,"1700000600")).rejects.toThrow();
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await insert(recovery);
      await expect(admin.query("COMMIT")).rejects.toThrow();
      await admin.query("ROLLBACK");
      expect((await admin.query("SELECT count(*)::int AS n FROM open_mint.staging_generative_recoveries")).rows[0].n).toBe(0);
      await admin.query("BEGIN");
      await insert(recovery,"1700000601",100);
      await admin.query("UPDATE open_mint.wallet_mint_plans SET nonce_active=false WHERE request_id=$1",[request]);
      await admin.query("DELETE FROM open_mint.generative_authorization_heads WHERE authorization_id=$1",[auth]);
      await admin.query("SELECT pg_sleep(0.15)");
      await expect(admin.query("COMMIT")).rejects.toThrow();
      await admin.query("ROLLBACK");
      expect((await admin.query("SELECT count(*)::int AS n FROM open_mint.staging_generative_recoveries")).rows[0].n).toBe(0);
      await admin.query("BEGIN");
      await insert(recovery);
      await admin.query("UPDATE open_mint.wallet_mint_plans SET nonce_active=false WHERE namespace_id=$1 AND request_id=$2",[ns,request]);
      await admin.query("DELETE FROM open_mint.generative_authorization_heads WHERE namespace_id=$1 AND authorization_id=$2",[ns,auth]);
      await admin.query("COMMIT");
      expect((await admin.query("SELECT nonce_active FROM open_mint.wallet_mint_plans WHERE request_id=$1",[request])).rows[0].nonce_active).toBe(false);
      await expect(admin.query("DELETE FROM open_mint.staging_generative_recoveries WHERE recovery_id=$1",[recovery])).rejects.toThrow();
      await expect(admin.query("UPDATE open_mint.generative_authorizations SET handle='other' WHERE authorization_id=$1",[auth])).rejects.toThrow();
      const outcome=await inspectStagingRetirementOutcome(inspector,{namespaceId:ns,deploymentId:dep},recovery,new AbortController().signal);
      expect(outcome.status).toBe("retired");
    } finally { await admin.query("ROLLBACK"); await admin.query("SELECT pg_advisory_unlock(1936152941,17)"); }
  });
});
