import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import canonicalize from "canonicalize";
import { Client } from "pg";
import { getAddress } from "viem";
import { createStagingEligibilityReader } from "../../src/openMint/publicChain.ts";
import { stagingAssessmentFixture } from "./fixtures/generative-staging-assessment.mjs";
import { readinessDatabaseFixture } from "./fixtures/generative-staging-readiness.mjs";
import { stoppedFixtureBackup, restoreDisposable, verifyRestoredFixture } from "./fixtures/generative-staging-restore.mjs";
import { disposablePostgres } from "../../src/openMint/persistence/fixtures/postgres.ts";
import { createStagingAssessmentWorker } from "./generative-staging-worker.mjs";
import { createStagingMintController } from "./generative-staging-mint.mjs";
import { stagingReviewFixture } from "../../src/openMint/staging/fixtures/stagingReview.ts";
import { identity, receipt } from "../../src/openMint/persistence/fixtures/data.ts";
import { ExclusiveWriter } from "../../src/openMint/persistence/writer.ts";
import { PostgresStagingGenerativeRecovery } from "../../src/openMint/persistence/stagingGenerativeRecovery.ts";
import { createStagingRecoveryChain } from "./generative-staging-recovery.mjs";
import { operatingPlan } from "./generative-operating-plan.mjs";
import { observeGenerativeV2Database, verifyGenerativeV2Database } from "../../src/openMint/persistence/databaseCertification.ts";
import { requireStagingRecoveryRole } from "../../src/openMint/persistence/roleAudit.ts";
import { inspectStagingRetirementOutcome } from "../../src/openMint/persistence/stagingOperatorInspection.ts";
import { restoreInventory } from "./fixtures/generative-staging-restore.mjs";

test("explicit v2 staging runtime starts against a disposable PG16 and synthetic active Sepolia", {
  skip: process.env.OPEN_MINT_TEST_POSTGRES !== "1",
}, async () => {
  const cluster = disposablePostgres(), admin = new Client(cluster.config);
  let fixture;
  try {
    await admin.connect();
    fixture = await stagingAssessmentFixture(cluster, admin, { v2: true });
    assert.equal(fixture.input.databaseReview.version, "sg-generative-runtime-db-review-v2");
    assert.equal(typeof fixture.controller.dispatch, "function");
    let acquisitions=0;
    await assert.rejects(PostgresStagingGenerativeRecovery.open({
      acquireWriter:async()=>{acquisitions++;throw Error("must not acquire before disabled-policy certification");},
      browserCatalog:fixture.runtime,databaseReview:fixture.input.databaseReview,
      chain:{},reviewSource:{},operatingPlanSha256:"a".repeat(64),releaseLockSha256:"b".repeat(64),
    }));
    assert.equal(acquisitions,0);
  } finally {
    await fixture?.close();
    await admin.end().catch(() => {});
    cluster.stop();
  }
});

for (const scenario of ["no-plan","unreported","rejected","submitted","reserved","signing","unknown"])
test(`v2 recovery: ${scenario}, strict expiry and one approved atomic retirement`, {
  skip: process.env.OPEN_MINT_TEST_POSTGRES !== "1", timeout: 90000,
}, async () => {
  const cluster = disposablePostgres(), admin = new Client(cluster.config);
  let f, worker, mint, recovery, recoveryWriter, inspector;
  try {
    await admin.connect();
    f = await stagingAssessmentFixture(cluster, admin, { v2: true, claimed: false });
    const freshHeaders = () => { const now = Math.floor(Date.now()/1000);
      for (const [i,h] of f.active.headers.entries()) h.timestamp = `0x${BigInt(now-f.active.headers.length+i).toString(16)}`; };
    freshHeaders();
    await f.db.query("BEGIN; SET LOCAL session_replication_role=replica");
    await f.db.query("UPDATE open_mint.generative_issuance_profiles SET lifetime_seconds=20");
    await f.db.query("COMMIT");
    await f.restart();
    const calls={x:0,grok:0,sign:0};
    worker = createStagingAssessmentWorker(f.input, { refreshEligibility: () => f.witness(),
      identityResolver: { provenance: "x-api", resolve: async (handle, execution) => { calls.x++;execution.dispatch.assertCurrent("x-identity");
        await execution.recordReceipt(receipt("x-identity", "1")); return { ...identity(handle), username: "Alice", provenance: "x-api" }; } },
      provider: { provenance: "grok", model: f.input.assessmentPolicy.model, assess: async (handle, snapshot, execution) => {
        calls.grok++;execution.dispatch.assertCurrent("grok"); await execution.recordReceipt(receipt("grok", "1"));
        return { handle, mbti: "ENFP", model: f.input.assessmentPolicy.model, providerResponseId: "offline-recovery",
          sourceUrls: ["https://x.com/Alice"], xUserId: snapshot.userId }; } },
    });
    assert.equal((await worker.run(await f.intent())).kind,"accepted");
    await worker.close(); worker=undefined;
    await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=true");
    await f.restart();
    freshHeaders();
    const candidate=createStagingMintController(f.input), signed=stagingReviewFixture(candidate.scope,
      {operations:["reuse","sign","wallet-submit"]}); candidate.halt();
    mint=createStagingMintController({...f.input,reviewSource:signed.source});
    const issued=await mint.issue({...await f.intent(),consent:true}, {
      address:f.active.accounts.authorizer.address,
      signTypedData:data=>{calls.sign++;return f.active.accounts.authorizer.signTypedData(data);},
    });
    assert.equal(issued.reservation.handle,"alice");
    if(["unreported","rejected","submitted"].includes(scenario)){
      const browser={session:f.session,origin:f.settings.origin,csrf:f.session.csrf};
      const plan=await mint.stageWallet({...await f.intent(),consent:true},browser,
        {chainId:"0xaa36a7",contract:getAddress(f.d.collection.address),blockNumber:f.active.headers.at(-1).number,
          blockHash:f.active.headers.at(-1).hash,nonce:"0x0"});
      const sent=await mint.submit({...await f.intent(),consent:true},browser,plan);
      if(scenario!=="unreported")await mint.report(f.request.code,browser,sent.permit,scenario,
        scenario==="submitted"?`0x${"5".repeat(64)}`:undefined);
    }
    if(["reserved","signing","unknown"].includes(scenario)){
      // Reconstruct an interrupted historical state only in the disposable fixture.
      await f.db.query("BEGIN; SET LOCAL session_replication_role=replica");
      await f.db.query("DELETE FROM open_mint.generative_authorization_signatures");
      await f.db.query("UPDATE open_mint.generative_authorizations SET state=$1,signing_epoch=CASE WHEN $1='reserved' THEN NULL ELSE signing_epoch END",[scenario]);
      await f.db.query("COMMIT");
    }
    await mint.close();mint=undefined;
    await f.db.query("INSERT INTO open_mint.projection_deployments VALUES($1,$2,$3)",
      [f.target.deploymentId,f.target.namespaceId,Buffer.from("{}")]);
    await f.db.query("INSERT INTO open_mint.projection_checkpoints(deployment_id,health) VALUES($1,'available')",
      [f.target.deploymentId]);
    await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false");
    await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=false");
    await f.writer.close();
    const target={...f.target,inspectorRole:"sg_inspector",recoveryRole:"sg_recovery"};
    const observed=await observeGenerativeV2Database(f.runtime,target,undefined,5000,true);
    const databaseReview={...f.input.databaseReview,profilesSha256:observed.profilesSha256};
    const recoverySources=f.eligibilitySources.map((source,i)=>({ ...source,
      id:f.settings.rpc.sources[i].id,operatorReference:f.settings.rpc.sources[i].operatorReference }));
    const chain=createStagingRecoveryChain({...f.input,sources:recoverySources,chainConfig:f.config,databaseReview});
    const key=generateKeyPairSync("ed25519");
    let envelope={payload:"{}",signature:"0".repeat(128)};
    const reviewSource={publicKeyPem:key.publicKey.export({type:"spki",format:"pem"}).toString(),
      publicKeySpkiSha256:createHash("sha256").update(key.publicKey.export({type:"spki",format:"der"})).digest("hex"),
      revisionSha256:"0".repeat(64),readCurrent:()=>envelope};
    let fault,armed=false;
    const recoveryConnection=()=>{const client=new Client({...cluster.config,database:f.target.database,user:"sg_recovery",
      options:"-c search_path=pg_catalog -c timezone=UTC"}),query=client.query.bind(client);
      client.query=async(sql,...args)=>{
        if(fault==="before-ledger"&&sql.startsWith("INSERT INTO open_mint.staging_generative_recoveries"))throw Error("fixture");
        const result=await query(sql,...args);
        const at={"after-ledger":"INSERT INTO open_mint.staging_generative_recoveries","after-lease":"UPDATE open_mint.wallet_mint_plans",
          "after-head":"DELETE FROM open_mint.generative_authorization_heads"};
        if(fault&&at[fault]&&sql.startsWith(at[fault]))throw Error("fixture");
        if(sql.startsWith("DELETE FROM open_mint.generative_authorization_heads")){
          armed=true;
          if(fault==="withdrawal")envelope={payload:"{}",signature:"0".repeat(128)};
        }
        if(armed&&fault==="expired-evidence"&&sql==="SELECT clock_timestamp() AS now")return {rows:[{now:new Date(Date.now()+60000)}]};
        if(armed&&fault==="lost-commit"&&sql==="COMMIT")throw Error("fixture lost commit reply");
        return result;
      };
      return client;};
    await verifyGenerativeV2Database(f.runtime,databaseReview);
    const declared=operatingPlan(f.input.operatingJson).operatingPlan;
    recovery=await PostgresStagingGenerativeRecovery.open({acquireWriter:async()=>{
      recoveryWriter=await ExclusiveWriter.acquire(recoveryConnection);return recoveryWriter;
    },browserCatalog:f.runtime,databaseReview,
      chain,reviewSource,operatingPlanSha256:declared.operatingPlanSha256,releaseLockSha256:declared.releaseLockSha256});
    await recoveryWriter.transaction(tx=>requireStagingRecoveryRole(tx));
    await assert.rejects(recovery.plan(issued.reservation.id,"expired-unminted","operator:r4","evidence:r4"));
    const wait=Math.max(0,Number(issued.reservation.authorization.deadline)*1000-Date.now()+4100);
    await new Promise(resolve=>setTimeout(resolve,wait));
    freshHeaders();
    let plan=await recovery.plan(issued.reservation.id,"expired-unminted","operator:r4","evidence:r4");
    assert.equal(plan.submission,scenario==="unreported"?"unknown":["submitted","rejected"].includes(scenario)?scenario:"not-started");
    if(scenario==="unreported"){
      // A late browser report changes reviewed evidence; it is still not chain proof.
      const oldPayload=canonicalize({version:"sg-staging-recovery-review-v1",target:plan.approvalTarget,validFrom:Date.now()-1000,validUntil:Date.now()+60000});
      envelope={payload:oldPayload,signature:sign(null,Buffer.from(oldPayload),key.privateKey).toString("hex")};
      reviewSource.revisionSha256=createHash("sha256").update(oldPayload).digest("hex");
      await f.db.query("INSERT INTO open_mint.wallet_mint_reports(namespace_id,request_id,attempt,outcome) VALUES($1,$2,1,'rejected')",[f.ns.id,f.request.id]);
      await assert.rejects(recovery.apply(plan));
      assert.equal((await f.db.query("SELECT count(*)::int AS n FROM open_mint.staging_generative_recoveries")).rows[0].n,0);
      plan=await recovery.plan(issued.reservation.id,"expired-unminted","operator:r4","evidence:r4");
      assert.equal(plan.submission,"rejected");
    }
    const payload=canonicalize({version:"sg-staging-recovery-review-v1",target:plan.approvalTarget,
      validFrom:Date.now()-1000,validUntil:Date.now()+60000});
    envelope={payload,signature:sign(null,Buffer.from(payload),key.privateKey).toString("hex")};
    reviewSource.revisionSha256=createHash("sha256").update(payload).digest("hex");
    await assert.rejects(recovery.apply({...plan}));
    const before=await restoreInventory(f.db),approvedEnvelope=envelope;
    if(scenario==="unreported")for(const point of ["before-ledger","after-ledger","after-lease","after-head","withdrawal","expired-evidence"]){
      fault=point;armed=false;await assert.rejects(recovery.apply(plan));
      assert.deepEqual(await restoreInventory(f.db),before);
      envelope=approvedEnvelope;
    }
    fault=scenario==="submitted"?"lost-commit":undefined;armed=false;
    if(fault)await assert.rejects(recovery.apply(plan));else await recovery.apply(plan);
    await assert.rejects(recovery.apply(plan));
    inspector=new Client({...cluster.config,database:f.target.database,user:"sg_inspector"}); await inspector.connect();
    const outcome=await inspectStagingRetirementOutcome(inspector,target,plan.recoveryId,new AbortController().signal);
    assert.equal(outcome.status,"retired");
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM open_mint.generative_authorization_heads")).rows[0].n,0);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM open_mint.assessments")).rows[0].n,1);
    const after=await restoreInventory(f.db),mutable=["staging_generative_recoveries","generative_authorization_heads","wallet_mint_plans"];
    assert.deepEqual(after.tables.filter(t=>!mutable.includes(t.name)),before.tables.filter(t=>!mutable.includes(t.name)));
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM open_mint.wallet_mint_plans WHERE nonce_active")).rows[0].n,0);
    assert.deepEqual(calls,{x:1,grok:1,sign:1});
    await recovery.close(); recovery=undefined; recoveryWriter=undefined;
    if(scenario==="submitted"||scenario==="no-plan"){
    const destination=disposablePostgres(); let restored,restoredInspector;
    try {
      const {inventory,archive,completion}=await stoppedFixtureBackup(cluster,f);
      restored=await restoreDisposable(destination,archive,archive.sha256,{v2:true});
      await verifyRestoredFixture(restored,f,inventory,completion);
      restoredInspector=new Client({...destination.config,database:f.target.database,user:"sg_inspector"});
      await restoredInspector.connect();
      assert.equal((await inspectStagingRetirementOutcome(restoredInspector,target,plan.recoveryId,new AbortController().signal)).status,"retired");
      assert.equal((await restored.db.query("SELECT count(*)::int AS n FROM open_mint.staging_generative_recoveries")).rows[0].n,1);
      assert.equal((await restored.db.query("SELECT count(*)::int AS n FROM open_mint.generative_authorization_heads")).rows[0].n,0);
      assert.equal((await restored.db.query("SELECT count(*)::int AS n FROM open_mint.assessments")).rows[0].n,1);
    } finally {await restoredInspector?.end();await restored?.close();destination.stop();}
    }
    if(scenario==="unreported"){
      // Fresh explicit request after operator resume. No provider or old intent retry.
      await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=true");
      await f.restart();freshHeaders();
      const candidate=createStagingMintController(f.input),approval=stagingReviewFixture(candidate.scope,{operations:["reuse","sign","wallet-submit"]});candidate.halt();
      mint=createStagingMintController({...f.input,reviewSource:approval.source});
      const signer={address:f.active.accounts.authorizer.address,signTypedData:data=>{calls.sign++;return f.active.accounts.authorizer.signTypedData(data);}};
      await assert.rejects(mint.issue({...await f.intent(),consent:true},signer));
      const witness=()=>createStagingEligibilityReader(f.config,f.eligibilitySources).preflight({
        block:{number:BigInt(f.active.headers.at(-1).number),hash:f.active.headers.at(-1).hash},handle:"alice",recipient:f.wallet.address,nonce:`0x${"4".repeat(64)}`});
      const request=await f.requests.create({sessionToken:f.session.id,sessionGeneration:f.session.generation,origin:f.settings.origin,
        csrf:f.session.csrf,recipient:f.wallet.address,handle:"Alice",eligibility:await witness()});
      assert.notEqual(request.id,f.request.id);
      const next=await mint.issue({...await f.intent(),code:request.code,eligibility:await witness(),consent:true},signer);
      assert.equal(next.reservation.assessmentId,issued.reservation.assessmentId);
      assert.equal(next.reservation.authorization.inputDigest,issued.reservation.authorization.inputDigest);
      assert.notEqual(next.reservation.id,issued.reservation.id);
      assert.notEqual(next.reservation.authorization.nonce,issued.reservation.authorization.nonce);
      assert.deepEqual(calls,{x:1,grok:1,sign:2});
    }
  } finally {
    await inspector?.end();await recovery?.close();await recoveryWriter?.close();await mint?.close();await worker?.close();
    await f?.close();await admin.end().catch(()=>{});cluster.stop();
  }
});

test("explicit v2 stopped backup restores its ledger, grants and private inventory without owner acquisition", {
  skip: process.env.OPEN_MINT_TEST_POSTGRES !== "1",
}, async () => {
  const source = disposablePostgres(), destination = disposablePostgres(), admin = new Client(source.config);
  let fixture, restored;
  try {
    await admin.connect();
    fixture = await readinessDatabaseFixture(source, admin, { v2: true });
    await fixture.pin();
    const { inventory, archive, completion } = await stoppedFixtureBackup(source, fixture);
    assert.equal(completion.version, "r4-stopped-fixture-v2");
    assert.ok(inventory.tables.some(table => table.name === "staging_generative_recoveries"));
    restored = await restoreDisposable(destination, archive, archive.sha256, { v2: true });
    const verified = await verifyRestoredFixture(restored, fixture, inventory, completion);
    assert.equal(verified.observed.schemaSha256.length, 64);
    await assert.rejects(restored.runtime.query("SELECT evidence FROM open_mint.staging_generative_recoveries"));
  } finally {
    await restored?.close();
    await fixture?.close();
    await admin.end().catch(() => {});
    destination.stop(); source.stop();
  }
});
