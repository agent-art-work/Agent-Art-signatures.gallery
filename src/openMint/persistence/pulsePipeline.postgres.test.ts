import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import canonicalize from "canonicalize";
import { Client } from "pg";
import { decodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pulseFixturePin } from "../fixtures/pulse.js";
import { PULSE_MINT_ABI, PULSE_PAID_SLOT } from "../pulseAuthorization.js";
import type { PulseObservation } from "../pulseEconomics.js";
import { namespace, identity, receipt } from "./fixtures/data.js";
import { eligibilityFixture, fixturePinForProfile } from "./fixtures/eligibility.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";
import { PostgresPulseEconomics } from "./pulseEconomics.js";
import { OpenMintRepository } from "./repository.js";
import { PostgresMintRequests } from "./requests.js";
import { PostgresWalletSessions } from "./sessions.js";
import { ExclusiveWriter } from "./writer.js";
import { PostgresAssessmentWorker } from "./assessmentWorker.js";
import { PostgresGenerativeInputJournal } from "./generativeInputs.js";
import { PostgresGenerativeAuthorizationIssuer } from "./generativeAuthorizations.js";
import { PostgresWalletSubmissions } from "./walletSubmissions.js";
import { reservedWalletTransaction } from "./reservedTransaction.js";
import { pulseBrowserRuntimeGrants, pulseRecoveryGrants } from "./runtimeRole.js";
import { auditPulseBrowserRole, auditPulseRecoveryRole } from "./roleAudit.js";
import { certifyPulseLocalDatabase } from "./pulseDatabaseCertification.js";
import { PostgresGenerativeRecovery } from "./generativeRecovery.js";
import { GenerativeRecoveryChain } from "../generativeRecoveryChain.js";
import { recoveryFixtureSources } from "../fixtures/generativeRecoveryRpc.js";

const authorizer = privateKeyToAccount(`0x${"0".repeat(63)}1`), wallet = privateKeyToAccount(`0x${"0".repeat(63)}2`);
describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("C6 Pulse durable integration (disposable PostgreSQL, mocked chain/providers)", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter | undefined;
  const factory = () => new Client({...cluster.config,options:"-c search_path=pg_catalog"});
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = factory(); await admin.connect(); await installSchema(admin);
    for (const file of ["requests-schema.sql", "generative-input-schema.sql", "generative-release-profile-schema.sql", "generative-authorization-schema.sql", "wallet-submission-schema.sql", "generative-recovery-schema.sql", "pulse-schema.sql",
      "../projection/projection-schema.sql", "../projection/projection-v2.sql", "../projection/projection-v3.sql"]) await admin.query(readFileSync(new URL(file, import.meta.url), "utf8"));
    await admin.query("CREATE ROLE sg_pulse_browser LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await admin.query(pulseBrowserRuntimeGrants("sg_pulse_browser"));
    await admin.query("CREATE ROLE sg_pulse_recovery LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await admin.query(pulseRecoveryGrants("sg_pulse_recovery"));
    const browser = new Client({...cluster.config, user:"sg_pulse_browser", options:"-c search_path=pg_catalog"}); await browser.connect();
    try {
      expect((await auditPulseBrowserRole(browser)).ok).toBe(true);
      const ns=randomUUID(), dep=randomUUID();
      expect((await certifyPulseLocalDatabase(browser,"open_mint_test",ns,dep)).publicStartupApproved).toBe(false);
      await admin.query("ALTER TABLE open_mint.pulse_slot_heads DISABLE TRIGGER guard_pulse_slot_head");
      await expect(certifyPulseLocalDatabase(browser,"open_mint_test",ns,dep)).rejects.toThrow();
      await admin.query("ALTER TABLE open_mint.pulse_slot_heads ENABLE TRIGGER guard_pulse_slot_head");
      await admin.query("ALTER TABLE open_mint.pulse_intents DROP CONSTRAINT pulse_intents_max_price_check");
      await expect(certifyPulseLocalDatabase(browser,"open_mint_test",ns,dep)).rejects.toThrow();
      await admin.query("ALTER TABLE open_mint.pulse_intents ADD CONSTRAINT pulse_intents_max_price_check CHECK(max_price>=0 AND max_price<2::numeric^256)");
      // Physical constraint order does not grant authority and is normalized by
      // catalog ordering; the exact restored body must certify again.
      expect((await certifyPulseLocalDatabase(browser,"open_mint_test",ns,dep)).publicStartupApproved).toBe(false);
    } finally { await browser.end(); }
  }, 30000);
  afterAll(async () => { await writer?.close(); await admin?.end(); cluster?.stop(); });
  it.each(["free", "paid", "phase-change", "slot-contention", "provider-phase-change", "recovery"])("retains phase/slot/cap and effect fences: %s", async scenario => {
    await writer?.close(); writer = undefined;
    const ns = {...namespace(), profile:"local-real" as const, provenance:"grok" as const}, dep = randomUUID();
    const gate = eligibilityFixture(ns.id, dep), renderer = fixturePinForProfile("generative-pulse-v1-rc1"), f = pulseFixturePin(gate.config.contract, renderer.identity, [wallet.address, wallet.address]);
    const p = {...gate.profile, authorizer:authorizer.address.toLowerCase()};
    const binding = {version:"sg-pulse-pipeline-v1", candidateLockSha256:"029851c5130f685b54abaf7f9b45ae03e56d31a42cfd72bb7de2756e63fed4a8", deployment:f.pin, slots:f.slots};
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,$2,$3,$4)", [ns.id,ns.profile,ns.provenance,ns.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id,profile_version,expected_model,generation_enabled,valid_until,max_total,max_daily,max_active,max_queued,reservation_usd_ticks,max_exposure_usd_ticks)
      VALUES($1,'offline-pulse-test','grok-offline-test',true,'2099-01-01',10,10,1,10,100,10000)`,[ns.id]);
    await admin.query("INSERT INTO open_mint.session_profiles VALUES($1,$2,31337)",[ns.id,p.origin]);
    await admin.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[ns.id,dep,p.chain_id,p.contract_address,p.genesis_hash,p.runtime_code_hash,p.authorizer,p.deployment_block,p.deployment_block_hash,p.max_evidence_age_ms,p.max_block_age_ms,p.max_future_skew_ms]);
    await admin.query("INSERT INTO open_mint.generative_input_profiles VALUES($1,$2,'sg-generative-pulse-inputs-v1-rc1',$3,$4,$5)",[ns.id,dep,renderer.address,renderer.runtimeCodeHash,renderer.identity]);
    await admin.query("INSERT INTO open_mint.generative_issuance_profiles VALUES($1,$2,true,$3,200,10000,120000,5000)",[ns.id,dep,scenario === "recovery" ? 20 : 600]);
    await admin.query("INSERT INTO open_mint.pulse_profiles VALUES($1,$2,'sg-pulse-pipeline-v1',$3,$4,$5)",[ns.id,dep,binding.candidateLockSha256,f.pin.saleConfigHash,Buffer.from(canonicalize(binding)!)]);
    let state: Partial<PulseObservation> = {phase:scenario === "paid" ? 1 : 0,price:"1000000000"};
    const witness = (handle="alice") => gate.witness(handle,wallet.address,{authorizer:authorizer.address,contractProfile:"generative-pulse-v1-rc1",generativeRenderer:renderer,pulse:f.pin},undefined,undefined,state,["0","1"]);
    writer = await ExclusiveWriter.acquire(factory);
    let repository = await OpenMintRepository.open(writer,ns), economics = await PostgresPulseEconomics.open(writer,ns.id,dep);
    let requests = await PostgresMintRequests.open(repository,dep,economics);
    const sessions = await PostgresWalletSessions.open({writer,namespaceId:ns.id,origin:p.origin,chainId:31337});
    let session = (await sessions.session()).session;
    const challenge = await sessions.challenge(session.id,wallet.address);
    await sessions.verify(session.id,challenge.challengeId,await wallet.signMessage({message:challenge.message}));
    session = (await sessions.session(sessions.cookie(session))).session;
    const requestContext = {sessionToken:session.id,sessionGeneration:session.generation,origin:p.origin,csrf:session.csrf,recipient:wallet.address};
    const create = async (handle="Alice",mintIntent:unknown={mode:"free",maxPriceWei:"0"}) => requests.create({...requestContext,handle,mintIntent,eligibility:await witness(handle.toLowerCase())});
    await expect(requests.create({...requestContext,handle:"Alice",eligibility:await witness()})).rejects.toThrow();
    const request = await create("Alice",scenario === "paid" ? {mode:"paid",maxPriceWei:"1500000000"} : {mode:"free",maxPriceWei:"0"});
    const workerIntent = async (code=request.code) => ({code,sessionToken:session.id,sessionGeneration:session.generation,origin:p.origin,csrf:session.csrf,eligibility:await witness()});
    if (scenario === "slot-contention") {
      await expect(create("Bob",{mode:"free",maxPriceWei:"0",slotId:"0"})).rejects.toThrow("No unused free");
      // A different slot is not permission to bypass the existing unresolved
      // provider-accounting gate. The failed admission rolls back that slot.
      await expect(create("Bob",{mode:"free",maxPriceWei:"0",slotId:"1"})).rejects.toThrow("operator reconciliation");
      expect((await admin.query("SELECT slot_id::text FROM open_mint.pulse_slot_heads WHERE namespace_id=$1",[ns.id])).rows).toEqual([{slot_id:"0"}]);
      await expect(admin.query("DELETE FROM open_mint.pulse_slot_heads WHERE namespace_id=$1",[ns.id])).rejects.toThrow("durable reconciliation");
      return;
    }
    const provider = {provenance:"grok" as const,model:"grok-offline-test",assess:vi.fn(async (handle:string,snapshot:any,execution:any) => {
      await execution.recordReceipt(receipt("grok","1")); return {handle,mbti:"INTJ" as const,model:"grok-offline-test",providerResponseId:"offline-pulse-test",sourceUrls:["https://x.com/Alice"],xUserId:snapshot.userId};
    })};
    const resolver = {provenance:"x-api" as const,resolve:vi.fn(async (handle:string,execution:any) => {
      await execution.recordReceipt(receipt("x-identity","1"));
      if(scenario === "provider-phase-change") state={phase:1,price:"1000000000"};
      return {...identity(handle),username:"Alice",provenance:"x-api" as const};
    })};
    let worker = new PostgresAssessmentWorker(requests,{timeoutMs:10000,provider,identityResolver:resolver,refreshEligibility:() => witness()});
    const result = await worker.run(await workerIntent());
    if(scenario === "provider-phase-change") {
      expect(result.kind).toBe("terminal"); expect(resolver.resolve).toHaveBeenCalledOnce(); expect(provider.assess).not.toHaveBeenCalled();
      expect((await admin.query("SELECT leg FROM open_mint.dispatch_fences WHERE namespace_id=$1",[ns.id])).rows).toEqual([{leg:"x-identity"}]);
      return;
    }
    expect(result.kind).toBe("accepted"); if(result.kind !== "accepted") throw new Error("fixture result missing");
    if(scenario === "free") {
      const other=await create("Bob",{mode:"free",maxPriceWei:"0",slotId:"1"});
      expect(await writer.transaction(tx => economics.load(tx,other.id))).toMatchObject({slotId:"1",wallet:wallet.address});
    }
    let current=request;
    if(scenario === "phase-change") {
      state={phase:1,price:"1000000000"};
      let journal=await PostgresGenerativeInputJournal.open(writer,ns.id,dep); await journal.stage(result.assessment);
      const issuer=await PostgresGenerativeAuthorizationIssuer.open(requests,journal);
      await expect(issuer.reserve({...await workerIntent(),consent:true})).rejects.toThrow("phase or price changed");
      current=await create("Alice",{mode:"paid",maxPriceWei:"1500000000"});
      expect(current.assessmentId).toBe(result.assessment.id);
      worker=new PostgresAssessmentWorker(requests,{timeoutMs:10000,provider,identityResolver:resolver,refreshEligibility:() => witness()});
      expect((await worker.run(await workerIntent(current.code))).kind).toBe("accepted");
      expect(provider.assess).toHaveBeenCalledOnce(); expect(resolver.resolve).toHaveBeenCalledOnce();
    }
    let journal=await PostgresGenerativeInputJournal.open(writer,ns.id,dep); await journal.stage(result.assessment);
    let issuer=await PostgresGenerativeAuthorizationIssuer.open(requests,journal);
    const signer={address:authorizer.address,signTypedData:vi.fn(data => authorizer.signTypedData(data))};
    const issued=await issuer.issue({...await workerIntent(current.code),consent:true},signer);
    expect(issued.reservation.authorization.mintMode).toBe(state.phase);
    expect(issued.reservation.authorization.slotId).toBe(state.phase ? PULSE_PAID_SLOT.toString() : "0");
    const transaction=reservedWalletTransaction(issued.reservation,issued.signature);
    expect(transaction.value).toBe(state.phase ? "0x59682f00" : "0x0");
    expect(decodeFunctionData({abi:PULSE_MINT_ABI,data:transaction.data}).functionName).toBe(state.phase ? "mintPaid" : "mintFree");
    const submissions=new PostgresWalletSubmissions(requests), runtimeIntent={session,origin:p.origin,csrf:session.csrf};
    const staged={version:"sg-pulse-wallet-plan-v1-rc1" as const,expiresAt:new Date(Number(issued.reservation.authorization.deadline)*1000).toISOString(),transaction};
    const plan=await submissions.stage(current.code,runtimeIntent,staged,{chainId:"0x7a69",contract:transaction.to,blockNumber:"0xa",blockHash:gate.config.deploymentBlock.hash,nonce:"0x0"});
    await expect(submissions.stage(current.code,runtimeIntent,{...staged,transaction:{...transaction,value:"0x1"}},{chainId:"0x7a69",contract:transaction.to,blockNumber:"0xa",blockHash:gate.config.deploymentBlock.hash,nonce:"0x0"})).rejects.toThrow();
    await submissions.beginPulse(issuer,{...await workerIntent(current.code),consent:true},runtimeIntent,plan);
    expect((await submissions.state(current.code,session.id)).blocked).toBe(true);
    await writer.close(); writer=await ExclusiveWriter.acquire(factory);
    repository=await OpenMintRepository.open(writer,ns); economics=await PostgresPulseEconomics.open(writer,ns.id,dep);
    requests=await PostgresMintRequests.open(repository,dep,economics); journal=await PostgresGenerativeInputJournal.open(writer,ns.id,dep);
    issuer=await PostgresGenerativeAuthorizationIssuer.open(requests,journal);
    expect(await issuer.inspect(issued.reservation.id)).toEqual(issued.reservation);
    expect((await new PostgresWalletSubmissions(requests).state(current.code,session.id)).blocked).toBe(true);
    await expect(economics.cancelBeforeDispatch(current.id,issued.reservation.sessionHash,session.generation)).rejects.toThrow();
    if(scenario === "recovery") {
      await writer.close();
      await admin.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false WHERE namespace_id=$1 AND deployment_id=$2",[ns.id,dep]);
      const operatorFactory=() => new Client({...cluster.config,user:"sg_pulse_recovery",options:"-c search_path=pg_catalog"});
      writer=await ExclusiveWriter.acquire(operatorFactory);
      expect((await writer.transaction(tx=>auditPulseRecoveryRole(tx))).ok).toBe(true);
      repository=await OpenMintRepository.open(writer,ns); economics=await PostgresPulseEconomics.open(writer,ns.id,dep);
      requests=await PostgresMintRequests.open(repository,dep,economics); journal=await PostgresGenerativeInputJournal.open(writer,ns.id,dep);
      issuer=await PostgresGenerativeAuthorizationIssuer.open(requests,journal);
      const changes={authorizer:authorizer.address,contractProfile:"generative-pulse-v1-rc1" as const,generativeRenderer:renderer,pulse:f.pin};
      const observer=new GenerativeRecoveryChain({...gate.config,...changes},recoveryFixtureSources(gate.sources(changes)));
      let recovery=await PostgresGenerativeRecovery.open(issuer,observer);
      await expect(recovery.plan(issued.reservation.id,"Retire expired unknown fixture submission",new AbortController().signal)).rejects.toThrow();
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,Number(issued.reservation.authorization.deadline)*1000+1100-Date.now())));
      recovery=await PostgresGenerativeRecovery.open(issuer,new GenerativeRecoveryChain({...gate.config,...changes},recoveryFixtureSources(gate.sources(changes))));
      const review=await recovery.plan(issued.reservation.id,"Retire expired unknown fixture submission",new AbortController().signal);
      expect(await recovery.outcome(review.recoveryId)).toBeUndefined();
      expect(await recovery.apply(review)).toEqual(review);
      expect(await recovery.outcome(review.recoveryId)).toEqual(review);
      expect((await admin.query("SELECT count(*)::int AS n FROM open_mint.pulse_slot_heads WHERE namespace_id=$1",[ns.id])).rows[0].n).toBe(0);
      expect((await admin.query("SELECT count(*)::int AS n FROM open_mint.pulse_sponsorships WHERE namespace_id=$1",[ns.id])).rows[0].n).toBe(1);
      await expect(writer.transaction(tx=>tx.query("UPDATE open_mint.generative_issuance_profiles SET enabled=true WHERE namespace_id=$1",[ns.id]))).rejects.toThrow("permission denied");
    }
    expect(provider.assess).toHaveBeenCalledOnce(); expect(signer.signTypedData).toHaveBeenCalledOnce();
  },40000);
});
