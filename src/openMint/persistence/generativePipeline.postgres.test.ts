import { generativeProfile } from "../generativeProfiles.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AssessmentProvider } from "../assessment.js";
import { assessmentDigest } from "../assessment.js";
import { generativeRendererIdentity } from "../generativeInputs.js";
import { GENERATIVE_MINT_ABI, normalizeGenerativeAuthorization, verifyGenerativeMintAuthorization as verifyOpenMintAuthorization } from "../generativeAuthorization.js";
import { GenerativeRecoveryChain } from "../generativeRecoveryChain.js";
import { recoveryFixtureSources } from "../fixtures/generativeRecoveryRpc.js";
import { PostgresGenerativeRecovery } from "./generativeRecovery.js";
import { PostgresWalletSubmissions } from "./walletSubmissions.js";
import { generativeBrowserRuntimeGrants, generativeRecoveryGrants } from "./runtimeRole.js";
import { auditGenerativeBrowserRole, auditGenerativeRecoveryRole } from "./roleAudit.js";

import type { XIdentityResolver } from "../xIdentity.js";
import { PostgresAssessmentWorker, type AssessmentWorkerIntent } from "./assessmentWorker.js";
import { PostgresGenerativeAuthorizationIssuer, type IssuanceIntent, type ReservedAuthorizationSigner } from "./generativeAuthorizations.js";
import { identity, namespace, receipt } from "./fixtures/data.js";
import { eligibilityFixture, fixturePinForProfile } from "./fixtures/eligibility.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";
import { PostgresGenerativeInputJournal } from "./generativeInputs.js";
import { OpenMintRepository } from "./repository.js";
import { PostgresMintRequests } from "./requests.js";
import { PostgresWalletSessions } from "./sessions.js";
import { ExclusiveWriter } from "./writer.js";

// Public scalar-1/scalar-2 test accounts; never live custody or a chain write.
const authorizer = privateKeyToAccount(`0x${"0".repeat(63)}1`);
const wallet = privateKeyToAccount(`0x${"0".repeat(63)}2`);

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1").each(["generative-experimental-v1", "generative-v1-rc1"] as const)("%s durable input-only pipeline (offline mocks, PostgreSQL and ECDSA)", contractProfile => {
  const profile = generativeProfile(contractProfile), fixtureRendererPin = fixturePinForProfile(contractProfile);
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter | undefined;
  const factory = () => new Client(cluster.config);
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = factory(); await admin.connect(); await installSchema(admin);
    for (const file of ["requests-schema.sql", "generative-input-schema.sql", "generative-release-profile-schema.sql", "generative-authorization-schema.sql", "wallet-submission-schema.sql",
      "../projection/projection-schema.sql", "../projection/projection-v2.sql", "../projection/projection-v3.sql"]) {
      // Exercise the profile upgrade on populated experimental history below.
      if (contractProfile === "generative-experimental-v1" && file === "generative-release-profile-schema.sql") continue;
      await admin.query(readFileSync(new URL(file, import.meta.url), "utf8"));
    }
    await admin.query("CREATE ROLE sg_recovery LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await admin.query("CREATE ROLE sg_browser LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await admin.query(generativeBrowserRuntimeGrants("sg_browser"));
  }, 30000);
  afterAll(async () => { await writer?.close(); await admin?.end(); cluster?.stop(); });

  it.each(["success", "timeout", "invalid-signature", "wallet-change", "disabled", "recovery"])("preserves authority and restart fences: %s", async scenario => {
    await writer?.close(); writer = undefined;
    const ns = { ...namespace(), profile: "local-real" as const, provenance: "grok" as const };
    const deploymentId = randomUUID(), gate = eligibilityFixture(ns.id, deploymentId);
    const p = { ...gate.profile, authorizer: authorizer.address.toLowerCase() };
    const witness = () => gate.witness("alice", wallet.address, { authorizer: authorizer.address, contractProfile, generativeRenderer: fixtureRendererPin });
    // Only isolated test configuration is seeded. Results, requests, proofs,
    // receipts, compact inputs and signatures use the actual APIs.
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,$2,$3,$4)", [ns.id, ns.profile, ns.provenance, ns.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id,profile_version,expected_model,generation_enabled,valid_until,max_total,max_daily,max_active,max_queued,reservation_usd_ticks,max_exposure_usd_ticks)
      VALUES($1,'offline-pipeline-test','grok-offline-test',true,'2099-01-01',1,1,1,1,100,1000)`, [ns.id]);
    await admin.query("INSERT INTO open_mint.session_profiles VALUES($1,$2,31337)", [ns.id, p.origin]);
    await admin.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [ns.id, deploymentId, p.chain_id, p.contract_address, p.genesis_hash,
      p.runtime_code_hash, p.authorizer, p.deployment_block, p.deployment_block_hash, p.max_evidence_age_ms, p.max_block_age_ms, p.max_future_skew_ms]);
    await admin.query("INSERT INTO open_mint.generative_input_profiles VALUES($1,$2,$6,$3,$4,$5)", [ns.id, deploymentId, fixtureRendererPin.address, fixtureRendererPin.runtimeCodeHash, fixtureRendererPin.identity, profile.inputProfile]);
    await admin.query("INSERT INTO open_mint.generative_issuance_profiles VALUES($1,$2,true,$3,200,10000,120000,5000)", [ns.id, deploymentId, scenario === "recovery" ? 20 : 600]);

    writer = await ExclusiveWriter.acquire(factory);
    let repository = await OpenMintRepository.open(writer, ns);
    let requests = await PostgresMintRequests.open(repository, deploymentId);
    const sessionConfig = { namespaceId: ns.id, origin: p.origin, chainId: 31337 };
    let sessions = await PostgresWalletSessions.open({ ...sessionConfig, writer });
    let session = (await sessions.session()).session;
    const challenge = await sessions.challenge(session.id, wallet.address);
    await sessions.verify(session.id, challenge.challengeId, await wallet.signMessage({ message: challenge.message }));
    session = (await sessions.session(sessions.cookie(session))).session;
    const request = await requests.create({ sessionToken: session.id, sessionGeneration: session.generation,
      origin: p.origin, csrf: session.csrf, recipient: wallet.address, handle: "Alice", eligibility: await witness() });
    const intent = async (): Promise<AssessmentWorkerIntent> => ({ code: request.code, sessionToken: session.id,
      sessionGeneration: session.generation, origin: p.origin, csrf: session.csrf, eligibility: await witness() });
    const issuerIntent = async (): Promise<IssuanceIntent> => ({ ...await intent(), consent: true });
    const resolver: XIdentityResolver = { provenance: "x-api", resolve: vi.fn<XIdentityResolver["resolve"]>(async (handle, execution) => {
      await execution!.recordReceipt(receipt("x-identity", "1"));
      return { ...identity(handle), username: "Alice", provenance: "x-api" };
    }) };
    const provider: AssessmentProvider = { provenance: "grok", model: "grok-offline-test", assess: vi.fn<AssessmentProvider["assess"]>(async (handle, snapshot, execution) => {
      await execution!.recordReceipt(receipt("grok", "1"));
      return { handle, mbti: "INTJ", model: "grok-offline-test", providerResponseId: "offline-pipeline-test",
        sourceUrls: ["https://x.com/Alice"], xUserId: snapshot!.userId };
    }) };
    const worker = new PostgresAssessmentWorker(requests, { timeoutMs: 10000, provider, identityResolver: resolver, refreshEligibility: witness });
    const result = await worker.run(await intent());
    expect(result.kind).toBe("accepted"); if (result.kind !== "accepted") throw new Error("Offline assessment not accepted");
    expect((await requests.get(request.code, session.id)).status).toBe("assessment-accepted");
    const assessmentBytes = (await admin.query<{ payload: Buffer }>("SELECT payload FROM open_mint.assessments WHERE namespace_id=$1", [ns.id])).rows[0].payload;
    expect(JSON.parse(assessmentBytes.toString())).toEqual(result.assessment);
    let journal = await PostgresGenerativeInputJournal.open(writer, ns.id, deploymentId);
    await expect(PostgresGenerativeInputJournal.open(writer, ns.id, randomUUID())).rejects.toThrow("profile mismatch");
    let issuer = await PostgresGenerativeAuthorizationIssuer.open(requests, journal);
    const signer: ReservedAuthorizationSigner = { address: authorizer.address, signTypedData: vi.fn(data => authorizer.signTypedData(data)) };
    await expect(issuer.issue(await issuerIntent(), signer)).rejects.toThrow("Frozen generative");
    expect(signer.signTypedData).not.toHaveBeenCalled();
    const artifact = await journal.stage(result.assessment);
    expect(await journal.stage(result.assessment)).toEqual(artifact);
    const forged = { ...result.assessment, mbti: "ENFP" as const };
    await expect(journal.stage({ ...forged, digest: assessmentDigest(forged) })).rejects.toThrow("exact accepted assessment");
    const baseIntent = await issuerIntent();
    await expect(issuer.issue({ ...baseIntent, consent: false }, signer)).rejects.toThrow("Explicit mint intent");
    await expect(issuer.issue({ ...baseIntent, eligibility: await gate.witness("alice", wallet.address, { authorizer: authorizer.address }) }, signer)).rejects.toThrow("renderer and deployment pins");
    await expect(issuer.issue({ ...baseIntent, csrf: "bad" }, signer)).rejects.toThrow("current session");
    await expect(issuer.issue({ ...baseIntent, origin: "https://attacker.example" }, signer)).rejects.toThrow("current session");
    await expect(issuer.issue({ ...baseIntent, sessionGeneration: "-1" }, signer)).rejects.toThrow("generation");
    await expect(issuer.issue({ ...baseIntent, eligibility: {} }, signer)).rejects.toThrow("chain eligibility");
    await expect(issuer.issue(baseIntent, { ...signer, address: wallet.address })).rejects.toThrow("pinned authorizer");
    const otherRenderer = { ...fixtureRendererPin, address: "0x4444444444444444444444444444444444444444",
      identity: generativeRendererIdentity("0x4444444444444444444444444444444444444444", fixtureRendererPin.runtimeCodeHash, profile.inputProfile) };
    await expect(issuer.issue({ ...baseIntent, eligibility: await gate.witness("alice", wallet.address,
      { authorizer: authorizer.address, contractProfile, generativeRenderer: otherRenderer }) }, signer)).rejects.toThrow("renderer and deployment pins");
    const nonce = await issuer.preflightNonce(baseIntent);
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const reserved = await issuer.reserve(baseIntent);
    expect(await issuer.preflightNonce(baseIntent)).toBe(reserved.authorization.nonce);
    expect(signer.signTypedData).not.toHaveBeenCalled();

    if (scenario !== "success" && scenario !== "recovery") {
      const failing: ReservedAuthorizationSigner = { address: authorizer.address, signTypedData: vi.fn(async data => {
        if (scenario === "timeout") return new Promise<string>(() => {});
        if (scenario === "invalid-signature") return "0x";
        if (scenario === "wallet-change") await sessions.logout(session.id);
        if (scenario === "disabled") await admin.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false WHERE namespace_id=$1", [ns.id]);
        return authorizer.signTypedData(data);
      }) };
      await expect(issuer.issue(await issuerIntent(), failing)).rejects.toThrow();
      expect(failing.signTypedData).toHaveBeenCalledOnce();
      const state = (await admin.query("SELECT state FROM open_mint.generative_authorizations WHERE namespace_id=$1", [ns.id])).rows[0].state;
      expect(state).toBe(scenario === "timeout" || scenario === "invalid-signature" ? "unknown" : "signed");
      await writer!.close(); writer = await ExclusiveWriter.acquire(factory);
      repository = await OpenMintRepository.open(writer, ns); requests = await PostgresMintRequests.open(repository, deploymentId);
      journal = await PostgresGenerativeInputJournal.open(writer, ns.id, deploymentId);
      issuer = await PostgresGenerativeAuthorizationIssuer.open(requests, journal);
      await expect(issuer.issue(await issuerIntent(), signer)).rejects.toThrow();
      expect(signer.signTypedData).not.toHaveBeenCalled();
      expect((await journal.load("Alice"))!.digest).toBe(artifact.digest);
      return;
    }

    // An extra user-supplied type is ignored: authority comes from the saved row.
    const issued = await issuer.issue({ ...await issuerIntent(), mbti: "ENFP" } as IssuanceIntent, signer);
    expect(issued.reservation.version).toBe(profile.reservationVersion);
    expect(artifact.profile).toBe(profile.inputProfile);
    expect(issued.reservation.authorization.assessmentDigest).toBe(result.assessment.digest);
    expect(issued.reservation.authorization.inputDigest).toBe(artifact.digest);
    expect(issued.reservation.renderHandle).toBe("Alice");
    expect(issued.reservation.mbti).toBe("INTJ");
    expect(issued.reservation.rendererIdentity).toBe(fixtureRendererPin.identity);
    expect(JSON.stringify(issued.reservation)).not.toMatch(/<svg|tokenURI|svgSha256/);
    expect(await verifyOpenMintAuthorization(issued.reservation.domain, issued.reservation.authorization,
      issued.signature, authorizer.address, profile.inputProfile)).toBe(true);

    if (scenario === "recovery") {
      const browserIntent = { session, origin: p.origin, csrf: session.csrf };
      const tx = { from: wallet.address, to: issued.reservation.domain.verifyingContract, chainId: "0x7a69", value: "0x0",
        data: encodeFunctionData({ abi: GENERATIVE_MINT_ABI, functionName: "mint", args: ["Alice", "INTJ", normalizeGenerativeAuthorization(issued.reservation.authorization), issued.signature] }) };
      const staged = { expiresAt: new Date(Number(issued.reservation.authorization.deadline) * 1000).toISOString(), transaction: tx };
      const submissions = new PostgresWalletSubmissions(requests);
      const walletPlan = await submissions.stage(request.code, browserIntent, staged, { chainId: "0x7a69", contract: tx.to, blockNumber: "0xa", blockHash: gate.config.deploymentBlock.hash, nonce: "0x0" });
      await submissions.begin(request.code, browserIntent, walletPlan);
      // No wallet response: this is deliberately an UNKNOWN dispatch, not a
      // reported rejection. Missing transaction/receipt never unlocks it.
      expect((await submissions.state(request.code, session.id)).blocked).toBe(true);
      const persisted = (await admin.query("SELECT payload FROM open_mint.wallet_mint_plans WHERE namespace_id=$1", [ns.id])).rows[0].payload;
      // Exercise the upgrade of the PREVIOUS populated schema, not just a
      // clean install. These DDL changes affect only this disposable cluster.
      await admin.query(`DROP TRIGGER guard_wallet_plan_insert ON open_mint.wallet_mint_plans;
        ALTER TABLE open_mint.wallet_mint_plans DROP COLUMN nonce_active;
        ALTER TABLE open_mint.wallet_mint_plans ADD CONSTRAINT legacy_wallet_nonce_unique UNIQUE(namespace_id,deployment_id,recipient,wallet_nonce)`);
      await admin.query(readFileSync(new URL("generative-recovery-schema.sql", import.meta.url), "utf8"));
      await admin.query(generativeRecoveryGrants("sg_recovery"));
      expect((await admin.query("SELECT payload,nonce_active FROM open_mint.wallet_mint_plans WHERE namespace_id=$1", [ns.id])).rows[0]).toEqual({ payload: persisted, nonce_active: true });
      const r = issued.reservation, changes = { authorizer: authorizer.address, contractProfile, generativeRenderer: fixtureRendererPin };
      const observer = () => new GenerativeRecoveryChain({ ...gate.config, ...changes }, recoveryFixtureSources(gate.sources(changes)));
      await expect(PostgresGenerativeRecovery.open(issuer, observer())).rejects.toThrow(); // Owner role cannot operate it.
      const browser = new Client({ ...cluster.config, user: "sg_browser", options: "-c search_path=pg_catalog" }); await browser.connect();
      expect((await auditGenerativeBrowserRole(browser)).ok).toBe(true);
      expect((await auditGenerativeRecoveryRole(browser)).ok).toBe(false);
      for (const sql of ["DELETE FROM open_mint.generative_authorization_heads", "UPDATE open_mint.wallet_mint_plans SET nonce_active=false", "INSERT INTO open_mint.generative_recoveries(namespace_id) VALUES($1)"]) {
        await expect(browser.query(sql, sql.includes("$1") ? [ns.id] : [])).rejects.toThrow("permission denied");
      }
      await browser.end();
      await writer.close(); writer = undefined;
      const operatorFactory = () => new Client({ ...cluster.config, user: "sg_recovery", options: "-c search_path=pg_catalog" });
      const openOperator = async () => {
        writer = await ExclusiveWriter.acquire(operatorFactory);
        repository = await OpenMintRepository.open(writer, ns); requests = await PostgresMintRequests.open(repository, deploymentId);
        journal = await PostgresGenerativeInputJournal.open(writer, ns.id, deploymentId);
        issuer = await PostgresGenerativeAuthorizationIssuer.open(requests, journal);
      };
      await openOperator();
      for (const table of ["sessions", "wallet_challenges", "provider_receipts", "budget_policies", "projection_mints"]) {
        await expect(writer!.transaction(c => c.query(`SELECT * FROM open_mint.${table} LIMIT 1`))).rejects.toThrow("permission denied");
      }
      await expect(PostgresGenerativeRecovery.open(issuer, observer())).rejects.toThrow("disable issuance");
      await admin.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false WHERE namespace_id=$1", [ns.id]);
      let recovery = await PostgresGenerativeRecovery.open(issuer, observer());
      await expect(recovery.plan(r.id, "Review missing wallet report", new AbortController().signal)).rejects.toThrow("Recovery cannot be verified");
      await expect(recovery.plan("bad", "x", new AbortController().signal)).rejects.toThrow("exact authorization ID");
      await expect(recovery.outcome("bad")).rejects.toThrow("Invalid recovery ID");
      expect(await recovery.outcome(randomUUID())).toBeUndefined();
      await expect(writer!.transaction(c => c.query("DELETE FROM open_mint.generative_authorization_heads WHERE namespace_id=$1", [ns.id]))).rejects.toThrow("durable operator evidence");
      await expect(admin.query("UPDATE open_mint.generative_authorization_heads SET authorization_id=authorization_id WHERE namespace_id=$1", [ns.id])).rejects.toThrow("immutable authorization head");
      await expect(writer!.transaction(c => c.query("UPDATE open_mint.wallet_mint_plans SET nonce_active=false WHERE namespace_id=$1", [ns.id]))).rejects.toThrow("durable operator evidence");
      await expect(writer!.transaction(c => c.query("UPDATE open_mint.generative_issuance_profiles SET enabled=true WHERE namespace_id=$1", [ns.id]))).rejects.toThrow("permission denied");
      await expect(ExclusiveWriter.acquire(factory)).rejects.toThrow("writer unavailable");
      // Let a REAL short authorization expire; no DB clock/trigger changes.
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(r.authorization.deadline) * 1000 + 1100 - Date.now())));
      recovery = await PostgresGenerativeRecovery.open(issuer, observer());
      const first = await recovery.plan(r.id, "Review missing wallet report", new AbortController().signal);
      expect(first.submission).toBe("unknown"); expect(first.walletNonce).toBe("0"); expect(first.transactionHash).toBeNull();
      await expect(recovery.apply({ ...first })).rejects.toThrow("fresh recovery plan");
      expect(await recovery.outcome(first.recoveryId)).toBeUndefined(); // Dry run only.
      const wrongPins = { ...changes, genesisHash: `0x${"aa".repeat(32)}` as const };
      const wrongChain = new GenerativeRecoveryChain({ ...gate.config, ...wrongPins }, recoveryFixtureSources(gate.sources(wrongPins)));
      await expect((await PostgresGenerativeRecovery.open(issuer, wrongChain)).plan(r.id, "Different chain must not unlock", new AbortController().signal)).rejects.toThrow("durable deployment");
      const shortChain = new GenerativeRecoveryChain({ ...gate.config, ...changes, evidenceTtlMs: 1000 }, recoveryFixtureSources(gate.sources(changes)));
      const shortRecovery = await PostgresGenerativeRecovery.open(issuer, shortChain);
      const stalePlan = await shortRecovery.plan(r.id, "Stale evidence must not unlock", new AbortController().signal);
      await new Promise(resolve => setTimeout(resolve, 1100));
      await expect(shortRecovery.apply(stalePlan)).rejects.toThrow("Recovery cannot be verified");
      expect(await shortRecovery.outcome(stalePlan.recoveryId)).toBeUndefined();
      // A late wallet report invalidates the reviewed snapshot, never overwritten.
      await admin.query("INSERT INTO open_mint.wallet_mint_reports(namespace_id,request_id,attempt,outcome,transaction_hash) VALUES($1,$2,1,'submitted',$3)", [ns.id, request.id, `0x${"ab".repeat(32)}`]);
      await expect(recovery.apply(first)).rejects.toThrow("changed since review");
      const plan = await recovery.plan(r.id, "Expired authority; preserve late report", new AbortController().signal);
      expect(plan.submission).toBe("submitted"); expect(plan.transactionHash).toBe(`0x${"ab".repeat(32)}`);
      // Inject a failure AFTER audit insertion + nonce retirement. The entire
      // transaction must roll back, including its newly inserted evidence.
      await admin.query(`CREATE FUNCTION open_mint.test_recovery_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected retirement failure'; END $$;
        CREATE TRIGGER test_recovery_failure BEFORE DELETE ON open_mint.generative_authorization_heads
        FOR EACH ROW EXECUTE FUNCTION open_mint.test_recovery_failure()`);
      await expect(recovery.apply(plan)).rejects.toThrow("injected retirement failure");
      expect(await recovery.outcome(plan.recoveryId)).toBeUndefined();
      expect((await admin.query("SELECT nonce_active FROM open_mint.wallet_mint_plans WHERE namespace_id=$1", [ns.id])).rows[0].nonce_active).toBe(true);
      await admin.query("DROP TRIGGER test_recovery_failure ON open_mint.generative_authorization_heads; DROP FUNCTION open_mint.test_recovery_failure()");
      // Policy change while an operator considers a plan also invalidates apply.
      await admin.query("UPDATE open_mint.generative_issuance_profiles SET enabled=true WHERE namespace_id=$1", [ns.id]);
      await expect(recovery.apply(plan)).rejects.toThrow("disable issuance");
      await admin.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false WHERE namespace_id=$1", [ns.id]);
      expect(await recovery.apply(plan)).toEqual(plan);
      expect(await recovery.apply(plan)).toEqual(plan); // Exactly one audit row.
      expect(await recovery.outcome(plan.recoveryId)).toEqual(plan);
      expect((await admin.query("SELECT count(*)::int AS n FROM open_mint.generative_recoveries WHERE namespace_id=$1", [ns.id])).rows[0].n).toBe(1);
      expect((await admin.query("SELECT count(*)::int AS n FROM open_mint.generative_authorization_heads WHERE namespace_id=$1", [ns.id])).rows[0].n).toBe(0);
      expect((await admin.query("SELECT payload,nonce_active FROM open_mint.wallet_mint_plans WHERE namespace_id=$1", [ns.id])).rows[0]).toEqual({ payload: persisted, nonce_active: false });
      await expect(admin.query("UPDATE open_mint.wallet_mint_plans SET nonce_active=true WHERE namespace_id=$1", [ns.id])).rejects.toThrow("immutable wallet plan");
      for (const table of ["generative_recoveries", "wallet_mint_plans", "wallet_mint_dispatches", "wallet_mint_reports", "generative_authorizations", "generative_authorization_signatures", "assessments", "generative_inputs"]) {
        await expect(admin.query(`DELETE FROM open_mint.${table} WHERE namespace_id=$1`, [ns.id])).rejects.toThrow("immutable");
      }
      await writer!.close(); writer = undefined; await openOperator();
      recovery = await PostgresGenerativeRecovery.open(issuer, observer());
      expect(await recovery.outcome(plan.recoveryId)).toEqual(plan); // Restart/lost-reply recovery.
      await expect(recovery.apply(plan)).rejects.toThrow("fresh recovery plan");
      await expect(recovery.plan(r.id, "Repeated retirement", new AbortController().signal)).rejects.toThrow("active reservation");
      // Explicit return to browser ownership, then fresh USER intent. Recovery
      // itself never enables issuance or initiates another request/signature.
      await writer!.close(); writer = await ExclusiveWriter.acquire(factory);
      repository = await OpenMintRepository.open(writer, ns); requests = await PostgresMintRequests.open(repository, deploymentId);
      journal = await PostgresGenerativeInputJournal.open(writer, ns.id, deploymentId); issuer = await PostgresGenerativeAuthorizationIssuer.open(requests, journal);
      await admin.query("UPDATE open_mint.generative_issuance_profiles SET enabled=true WHERE namespace_id=$1", [ns.id]);
      await expect(issuer.issue(await issuerIntent(), signer)).rejects.toThrow("retired by an operator");
      await expect(new PostgresWalletSubmissions(requests).begin(request.code, browserIntent, walletPlan)).rejects.toThrow();
      const next = await requests.create({ sessionToken: session.id, sessionGeneration: session.generation, origin: p.origin, csrf: session.csrf, recipient: wallet.address, handle: "Alice", eligibility: await witness() });
      expect(next.assessmentId).toBe(result.assessment.id);
      const fresh = await issuer.issue({ ...await issuerIntent(), code: next.code, eligibility: await gate.witness("alice", wallet.address, changes, undefined, `0x${"66".repeat(32)}`) }, signer);
      expect(fresh.reservation.authorization.inputDigest).toBe(r.authorization.inputDigest);
      expect(fresh.reservation.id).not.toBe(r.id); expect(fresh.reservation.requestId).toBe(next.id);
      const freshTx = { ...tx, data: encodeFunctionData({ abi: GENERATIVE_MINT_ABI, functionName: "mint", args: ["Alice", "INTJ", normalizeGenerativeAuthorization(fresh.reservation.authorization), fresh.signature] }) };
      const newPlan = await new PostgresWalletSubmissions(requests).stage(next.code, browserIntent,
        { expiresAt: new Date(Number(fresh.reservation.authorization.deadline) * 1000).toISOString(), transaction: freshTx },
        { chainId: "0x7a69", contract: tx.to, blockNumber: "0xa", blockHash: gate.config.deploymentBlock.hash, nonce: "0x0" });
      expect(newPlan.transaction.nonce).toBe("0x0"); // Safe reuse; old signed authority is expired, old record retained.
      expect((await admin.query("SELECT count(*)::int AS n FROM open_mint.wallet_mint_plans WHERE namespace_id=$1", [ns.id])).rows[0].n).toBe(2);
      expect((await admin.query("SELECT payload FROM open_mint.assessments WHERE namespace_id=$1", [ns.id])).rows[0].payload).toEqual(assessmentBytes);
      expect(provider.assess).toHaveBeenCalledOnce(); expect(resolver.resolve).toHaveBeenCalledOnce();
      expect(signer.signTypedData).toHaveBeenCalledTimes(2); // Second only AFTER explicit fresh request above.
      return;
    }

    if (contractProfile === "generative-experimental-v1" && scenario === "success") {
      const tables = ["assessments", "generative_input_profiles", "generative_inputs",
        "generative_authorizations", "generative_authorization_signatures"];
      const snapshot = () => Promise.all(tables.map(async table =>
        (await admin.query(`SELECT * FROM open_mint.${table} WHERE namespace_id=$1`, [ns.id])).rows));
      const beforeUpgrade = await snapshot();
      await admin.query(readFileSync(new URL("generative-release-profile-schema.sql", import.meta.url), "utf8"));
      expect(await snapshot()).toEqual(beforeUpgrade);
      await expect(admin.query("UPDATE open_mint.generative_input_profiles SET profile='sg-generative-inputs-v1-rc1' WHERE namespace_id=$1", [ns.id])).rejects.toThrow("immutable");
    }

    // Restart just this disposable writer; no active application/pilot is used.
    await writer.close(); writer = await ExclusiveWriter.acquire(factory);
    repository = await OpenMintRepository.open(writer, ns); requests = await PostgresMintRequests.open(repository, deploymentId);
    sessions = await PostgresWalletSessions.open({ ...sessionConfig, writer });
    expect((await sessions.session(sessions.cookie(session))).session).toEqual(session);
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [ns.id]);
    const reused = await new PostgresAssessmentWorker(requests, { timeoutMs: 10000 }).run(await intent());
    expect(reused).toEqual({ ...result, reused: true });
    journal = await PostgresGenerativeInputJournal.open(writer, ns.id, deploymentId);
    issuer = await PostgresGenerativeAuthorizationIssuer.open(requests, journal);
    expect(await issuer.issue(await issuerIntent(), signer)).toEqual(issued);
    const saved = await journal.load(artifact.assessment.handle);
    expect(saved).toEqual(artifact);
    if (!saved) throw new Error("Frozen generative artifact missing");
    expect(saved.assessment).toEqual(result.assessment);
    expect((await admin.query<{ payload: Buffer }>("SELECT payload FROM open_mint.assessments WHERE namespace_id=$1", [ns.id])).rows[0].payload).toEqual(assessmentBytes);
    expect(provider.assess).toHaveBeenCalledOnce(); expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(signer.signTypedData).toHaveBeenCalledOnce();
    for (const table of ["generative_inputs", "generative_authorization_signatures"]) {
      await expect(admin.query(`DELETE FROM open_mint.${table} WHERE namespace_id=$1`, [ns.id])).rejects.toThrow("immutable");
    }
    await expect(admin.query("UPDATE open_mint.generative_authorizations SET payload=convert_to('{}','UTF8') WHERE namespace_id=$1", [ns.id])).rejects.toThrow("immutable");
    await sessions.logout(session.id);
    await expect(issuer.issue(await issuerIntent(), signer)).rejects.toThrow();
    expect(signer.signTypedData).toHaveBeenCalledOnce();
    for (const table of ["assessment_attempts", "budget_reservations", "assessments", "generative_authorization_signatures"]) {
      expect((await admin.query(`SELECT count(*)::int AS n FROM open_mint.${table} WHERE namespace_id=$1`, [ns.id])).rows[0].n).toBe(1);
    }
  }, 45000);
});
