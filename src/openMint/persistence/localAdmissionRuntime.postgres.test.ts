import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import canonicalize from "canonicalize";
import { Client } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GrokAssessmentProvider } from "../grok.js";
import { XApiIdentityResolver } from "../xIdentity.js";
import { generativeRendererIdentity } from "../generativeInputs.js";
import { localRuntimeAdmissionFixture } from "./fixtures/localAdmission.js";
import { localReviewFixture } from "../staging/fixtures/localReview.js";
import { localReviewFilesFixture } from "../staging/fixtures/localReviewFiles.js";
import { prepareLocalAdmissionStartup } from "./localAdmissionStartup.js";
import { eligibilityFixture, fixturePinForProfile } from "./fixtures/eligibility.js";
import { namespace } from "./fixtures/data.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";
import { PostgresAssessmentWorker } from "./assessmentWorker.js";
import { PostgresGenerativeAuthorizationIssuer } from "./generativeAuthorizations.js";
import { PostgresGenerativeInputJournal } from "./generativeInputs.js";
import { PostgresMintRequests } from "./requests.js";
import { PostgresWalletSessions } from "./sessions.js";
import { OpenMintRepository } from "./repository.js";
import { DurableMintRuntime } from "./runtimeService.js";
import { LocalAdmissionRuntime } from "./localAdmissionRuntime.js";
import { PostgresWalletSubmissions } from "./walletSubmissions.js";
import { generativeBrowserRuntimeGrants } from "./runtimeRole.js";
import { ExclusiveWriter } from "./writer.js";

const role = "sg_browser", model = "grok-offline-test";
const signerAccount = privateKeyToAccount(`0x${"0".repeat(63)}1`), wallet = privateKeyToAccount(`0x${"0".repeat(63)}2`);
describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("guarded local runtime (real PostgreSQL, mocked HTTP)", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter | undefined, running: DurableMintRuntime | undefined;
  const reviewRoots: ReturnType<typeof localReviewFilesFixture>[] = [];
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); await installSchema(admin);
    for (const file of ["requests-schema.sql", "generative-input-schema.sql", "generative-release-profile-schema.sql", "generative-authorization-schema.sql", "wallet-submission-schema.sql",
      "../projection/projection-schema.sql", "../projection/projection-v2.sql", "../projection/projection-v3.sql"])
      await admin.query(readFileSync(new URL(file, import.meta.url), "utf8"));
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(generativeBrowserRuntimeGrants(role));
  }, 30000);
  afterAll(async () => { await running?.drain(); await writer?.close(); await admin?.end(); cluster?.stop(); for (const files of reviewRoots) files.remove(); });
  async function corruptPolicy(sql: string, namespaceId: string) {
    // Superuser fault injection in this disposable cluster only; production
    // immutability triggers remain enabled and reject these writes normally.
    await admin.query("BEGIN");
    try { await admin.query("SET LOCAL session_replication_role=replica"); await admin.query(sql, [namespaceId]); await admin.query("COMMIT"); }
    catch (error) { await admin.query("ROLLBACK"); throw error; }
  }
  async function setup(timeoutMs = 10000, wrongProviderLeg = false, fileBacked = false) {
    await running?.drain(); running = undefined; await writer?.close(); writer = undefined;
    const ns = { ...namespace(), profile: "local-real" as const, provenance: "grok" as const }, deployment = randomUUID();
    const chain = eligibilityFixture(ns.id, deployment), basePin = fixturePinForProfile("generative-v1-rc1");
    // Real deployments store checksummed addresses. Digits-only fixtures hid
    // a case-sensitive comparison bug caught by the actual Anvil rehearsal.
    const address = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
    const pin = { ...basePin, address, identity: generativeRendererIdentity(address, basePin.runtimeCodeHash, "sg-generative-inputs-v1-rc1") };
    const p = { ...chain.profile, authorizer: signerAccount.address.toLowerCase() };
    const witness = (nonce?: `0x${string}`) => chain.witness("alice", wallet.address,
      { authorizer: signerAccount.address, contractProfile: "generative-v1-rc1", generativeRenderer: pin }, undefined, nonce);
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,$2,$3,$4)", [ns.id, ns.profile, ns.provenance, ns.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id,profile_version,expected_model,generation_enabled,valid_until,max_total,max_daily,max_active,max_queued,reservation_usd_ticks,max_exposure_usd_ticks)
      VALUES($1,'offline-runtime-test',$2,true,'2099-01-01',1,1,1,1,100,1000)`, [ns.id, model]);
    await admin.query("INSERT INTO open_mint.session_profiles VALUES($1,$2,31337)", [ns.id, p.origin]);
    await admin.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [ns.id, deployment, p.chain_id, p.contract_address, p.genesis_hash, p.runtime_code_hash,
      p.authorizer, p.deployment_block, p.deployment_block_hash, p.max_evidence_age_ms, p.max_block_age_ms, p.max_future_skew_ms]);
    await admin.query("INSERT INTO open_mint.generative_input_profiles VALUES($1,$2,'sg-generative-inputs-v1-rc1',$3,$4,$5)", [ns.id, deployment, pin.address, pin.runtimeCodeHash, pin.identity]);
    await admin.query("INSERT INTO open_mint.generative_issuance_profiles VALUES($1,$2,true,600,1000,10000,120000,5000)", [ns.id, deployment]);
    writer = await ExclusiveWriter.acquire(() => new Client({ ...cluster.config, user: role, options: "-c search_path=pg_catalog" }));
    const repository = await OpenMintRepository.open(writer, ns), requests = await PostgresMintRequests.open(repository, deployment);
    const sessions = await PostgresWalletSessions.open({ writer, namespaceId: ns.id, origin: p.origin, chainId: 31337 });
    let session = (await sessions.session()).session;
    const challenge = await sessions.challenge(session.id, wallet.address);
    await sessions.verify(session.id, challenge.challengeId, await wallet.signMessage({ message: challenge.message }));
    session = (await sessions.session(sessions.cookie(session))).session;
    const trusted = await localRuntimeAdmissionFixture(requests, role), x = vi.fn<typeof fetch>(async () => Response.json({ data: { id: "123", username: "Alice" } }));
    const grok = vi.fn<typeof fetch>(async () => Response.json({ id: "offline-runtime-response", model, status: "completed", error: null, incomplete_details: null,
      citations: ["https://x.com/Alice"], usage: { cost_in_usd_ticks: 1 }, output: [{ type: "x_search_call", id: "offline-search", status: "completed" },
        { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ handle: "alice", mbti: "INTJ", xUserId: "123" }), annotations: [] }] }] }));
    const files = localReviewFilesFixture({ assessment: trusted.assessment, mint: trusted.mint }); reviewRoots.push(files);
    const startupInput = { requests, expectedRole: role, assessment: files.configs.assessment, mint: files.configs.mint };
    const startup = fileBacked ? await prepareLocalAdmissionStartup(startupInput) : undefined;
    const admission = startup?.admission ?? trusted.admission;
    const resolver = new XApiIdentityResolver({ bearerToken: "offline-placeholder", fetch: x });
    const worker = new PostgresAssessmentWorker(requests, { admission, timeoutMs, refreshEligibility: () => witness(),
      identityResolver: { provenance: resolver.provenance, resolve: (handle, execution) => {
        if (wrongProviderLeg) execution!.dispatch!.assertCurrent("grok");
        return resolver.resolve(handle, execution);
      } }, provider: new GrokAssessmentProvider({ apiKey: "offline-placeholder", model, fetch: grok }) });
    const journal = await PostgresGenerativeInputJournal.open(writer, ns.id, deployment), issuer = await PostgresGenerativeAuthorizationIssuer.open(requests, journal);
    const signer = { address: signerAccount.address, signTypedData: vi.fn<Parameters<typeof issuer.issue>[1]["signTypedData"]>(data => signerAccount.signTypedData(data)) };
    const options = { contractProfile: "generative-v1-rc1" as const, admission, requests, sessions, worker, journal, issuer, signer,
      eligibility: (input: { nonce: `0x${string}` }) => witness(input.nonce), eligibilityTimeoutMs: 5000 };
    const runtime = new DurableMintRuntime(options); running = runtime;
    const intent = { session, origin: p.origin, csrf: session.csrf };
    const create = async () => { const request = await runtime.create("Alice", intent); await runtime.idle(); return request; };
    const counts = async () => (await admin.query(`SELECT
      (SELECT count(*)::int FROM open_mint.dispatch_fences WHERE namespace_id=$1) AS providers,
      (SELECT count(*)::int FROM open_mint.wallet_mint_dispatches WHERE namespace_id=$1) AS wallets`, [ns.id])).rows[0];
    return { ns, chain, witness, requests, sessions, session, trusted, worker, journal, issuer, signer, x, grok, runtime, options, intent, create, counts, files, startupInput, startup };
  }
  it("guards preparation, saved reuse, signing, repeated authorization and wallet release", async () => {
    const h = await setup(), request = await h.create();
    const status = await h.runtime.status(request.code, h.session); expect(status.status).toBe("ready"); expect(status).not.toHaveProperty("mbti");
    expect(h.x).toHaveBeenCalledOnce(); expect(h.grok).toHaveBeenCalledOnce();
    const issued = await h.runtime.authorize(request.code, true, h.intent);
    expect(await h.runtime.authorize(request.code, true, h.intent)).toEqual(issued); expect(h.signer.signTypedData).toHaveBeenCalledOnce();
    const submissions = new PostgresWalletSubmissions(h.requests);
    const plan = await submissions.stage(request.code, h.intent, issued, { chainId: "0x7a69", contract: issued.transaction.to, blockNumber: "0xa", blockHash: h.chain.config.deploymentBlock.hash, nonce: "0x0" });
    const released = await h.runtime.beginSubmission(submissions, request.code, h.intent, plan, new AbortController().signal);
    expect(released.permit).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(h.runtime.beginSubmission(submissions, request.code, h.intent, plan, new AbortController().signal)).rejects.toThrow();
    expect(await h.counts()).toEqual({ providers: 2, wallets: 1 });
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [h.ns.id]);
    const reused = await h.create(); expect((await h.runtime.status(reused.code, h.session)).status).toBe("ready");
    expect(h.x).toHaveBeenCalledOnce(); expect(h.grok).toHaveBeenCalledOnce(); expect(h.signer.signTypedData).toHaveBeenCalledOnce();
    expect(h.trusted.events).toEqual(expect.arrayContaining(["assessment:assessment-x", "assessment:assessment-grok", "assessment:reuse", "mint:sign", "mint:reuse", "mint:wallet-submit"]));
  });
  it.each(["missing-review", "withdraw-after-x", "invalid-grok", "provider-timeout", "wrong-leg"])("preserves provider outcomes for %s without retry", async reason => {
    const h = await setup(reason === "provider-timeout" ? 1000 : 10000, reason === "wrong-leg");
    if (reason === "missing-review") h.trusted.assessment.source.current = undefined;
    if (reason === "withdraw-after-x") h.x.mockImplementation(async () => { h.trusted.assessment.source.current = undefined; return Response.json({ data: { id: "123", username: "Alice" } }); });
    if (reason === "invalid-grok") h.grok.mockImplementation(async () => Response.json({ bogus: true }));
    let transportSignal: AbortSignal | undefined;
    if (reason === "provider-timeout") h.x.mockImplementation(async (_url, options) => { transportSignal = options!.signal!; return new Promise(() => {}); });
    const request = await h.create(); expect((await h.runtime.status(request.code, h.session)).status).toBe("failed");
    const calls = h.x.mock.calls.length + h.grok.mock.calls.length;
    await h.create(); expect(h.x.mock.calls.length + h.grok.mock.calls.length).toBe(calls);
    expect(h.signer.signTypedData).not.toHaveBeenCalled(); expect((await h.counts()).wallets).toBe(0);
    if (reason === "missing-review") expect(calls).toBe(0);
    if (reason === "wrong-leg") { expect(calls).toBe(0); expect((await h.counts()).providers).toBe(1); }
    if (reason === "withdraw-after-x") { expect(calls).toBe(1); expect((await h.counts()).providers).toBe(1); }
    if (reason === "provider-timeout") { expect(calls).toBe(1); expect(transportSignal?.aborted).toBe(true); }
  });
  it("withdraws wallet release after signing without erasing the saved authorization", async () => {
    const h = await setup(), request = await h.create(), issued = await h.runtime.authorize(request.code, true, h.intent);
    const submissions = new PostgresWalletSubmissions(h.requests);
    const plan = await submissions.stage(request.code, h.intent, issued, { chainId: "0x7a69", contract: issued.transaction.to,
      blockNumber: "0xa", blockHash: h.chain.config.deploymentBlock.hash, nonce: "0x0" });
    h.trusted.mint.source.current = undefined;
    await expect(h.runtime.beginSubmission(submissions, request.code, h.intent, plan, new AbortController().signal)).rejects.toThrow();
    expect(h.signer.signTypedData).toHaveBeenCalledOnce(); expect((await h.counts()).wallets).toBe(0);
    expect((await h.runtime.status(request.code, h.session)).status).toBe("ready");
  });
  it("drains an in-flight provider, aborts transport and preserves its fence without retry", async () => {
    const h = await setup(); let entered!: () => void, transportSignal: AbortSignal | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.x.mockImplementation(async (_url, options) => { transportSignal = options!.signal!; entered(); return new Promise(() => {}); });
    const request = await h.runtime.create("Alice", h.intent); await started; await h.runtime.drain();
    expect(transportSignal?.aborted).toBe(true); expect((await h.runtime.status(request.code, h.session)).status).toBe("failed");
    expect(await h.counts()).toEqual({ providers: 1, wallets: 0 }); expect(h.x).toHaveBeenCalledOnce(); expect(h.grok).not.toHaveBeenCalled();
    expect(h.signer.signTypedData).not.toHaveBeenCalled(); await expect(h.create()).rejects.toThrow();
  });
  it("rejects asynchronous review and crossed issuer/wallet objects before release", async () => {
    const h = await setup(), request = await h.create();
    const value = { code: request.code, sessionToken: h.session.id, sessionGeneration: h.session.generation,
      origin: h.intent.origin, csrf: h.intent.csrf, consent: true, eligibility: await h.witness() };
    const binding = { scope: h.trusted.assessment.scope, requireReview: h.trusted.assessment.review.requireReview };
    const asyncReview = vi.fn(() => Promise.resolve());
    const asynchronous = new LocalAdmissionRuntime(h.requests, { expectedRole: role, assessment: binding,
      mint: { scope: h.trusted.mint.scope, requireReview: asyncReview as never } });
    await expect(asynchronous.issue(h.issuer, value, h.signer)).rejects.toThrow("Operation admission unavailable");
    expect(asyncReview).toHaveBeenCalledOnce();
    await expect(h.trusted.admission.issue({ ...h.issuer, requests: {} } as never, value, h.signer)).rejects.toThrow("issuer mismatch");
    await expect(h.trusted.admission.submit({ requests: {} } as never, h.issuer, value, h.intent, {} as never, new AbortController().signal)).rejects.toThrow("wallet mismatch");
    expect(h.signer.signTypedData).not.toHaveBeenCalled(); expect((await h.counts()).wallets).toBe(0);
  });
  it.each(["review", "invalid-signature", "halt", "proof"])("refuses unsafe signing/release after %s", async reason => {
    const h = await setup(), request = await h.create();
    if (reason === "review") h.trusted.mint.source.current = undefined;
    if (reason === "invalid-signature") h.signer.signTypedData.mockResolvedValue("0x");
    if (reason === "halt") h.trusted.admission.halt();
    if (reason === "proof") await h.sessions.challenge(h.session.id, wallet.address);
    await expect(h.runtime.authorize(request.code, true, h.intent)).rejects.toThrow();
    await expect(h.runtime.authorize(request.code, true, h.intent)).rejects.toThrow();
    expect(h.signer.signTypedData).toHaveBeenCalledTimes(reason === "invalid-signature" ? 1 : 0); expect((await h.counts()).wallets).toBe(0);
  });
  it("does not downgrade a guarded runtime or accept public/crossed components", async () => {
    const h = await setup();
    expect(() => new DurableMintRuntime({ ...h.options, admission: undefined })).toThrow("no unguarded fallback");
    expect(() => new PostgresAssessmentWorker(h.requests, { timeoutMs: 1000, admission: { ...h.trusted.admission, requests: {} } as never })).toThrow("ADMISSION_PROFILE_MISMATCH");
    const binding = { scope: h.trusted.mint.scope, requireReview: h.trusted.mint.review.requireReview };
    expect(() => new LocalAdmissionRuntime({ ...h.requests, profile: { ...h.requests.profile, chain_id: "11155111" } } as never, { expectedRole: role, assessment: binding, mint: binding })).toThrow("public startup");
    expect(() => new LocalAdmissionRuntime(h.requests, { expectedRole: role, assessment: { ...binding, scope: { ...binding.scope, writerEpoch: "999" } }, mint: binding })).toThrow("writer mismatch");
    const request = await h.create(); await h.runtime.drain();
    await expect(h.runtime.authorize(request.code, true, h.intent)).rejects.toThrow(); expect(h.signer.signTypedData).not.toHaveBeenCalled();
  });
  it("uses file-backed startup/recheck for the real local worker, issuer and wallet release", async () => {
    const h = await setup(10000, false, true); await h.startup!.recheck();
    expect(await h.counts()).toEqual({ providers: 0, wallets: 0 }); expect(h.x).not.toHaveBeenCalled(); expect(h.signer.signTypedData).not.toHaveBeenCalled();
    const request = await h.create(); expect((await h.runtime.status(request.code, h.session)).status).toBe("ready");
    const issued = await h.runtime.authorize(request.code, true, h.intent);
    expect(await h.runtime.authorize(request.code, true, h.intent)).toEqual(issued);
    const submissions = new PostgresWalletSubmissions(h.requests), plan = await submissions.stage(request.code, h.intent, issued,
      { chainId: "0x7a69", contract: issued.transaction.to, blockNumber: "0xa", blockHash: h.chain.config.deploymentBlock.hash, nonce: "0x0" });
    await h.runtime.beginSubmission(submissions, request.code, h.intent, plan, new AbortController().signal);
    expect(await h.counts()).toEqual({ providers: 2, wallets: 1 }); expect(h.signer.signTypedData).toHaveBeenCalledOnce();
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [h.ns.id]);
    await admin.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false WHERE namespace_id=$1", [h.ns.id]);
    await h.startup!.recheck(); // Disabled effects do not prohibit startup or imply permission to dispatch.
  });
  it.each(["missing", "revision", "key", "scope", "epoch", "database", "role", "public", "pre-aborted", "operations"])("refuses file-backed startup for %s without effects", async reason => {
    const h = await setup(), input = { ...h.startupInput }, controller = new AbortController();
    if (reason === "missing") unlinkSync(join(h.files.directory, "mint.json"));
    if (reason === "revision") input.mint = { ...input.mint, scope: { ...input.mint.scope, reviewRevisionSha256: "f".repeat(64) } };
    if (reason === "key") input.assessment = { ...input.assessment, publicKeySpkiSha256: "f".repeat(64) };
    if (reason === "scope") input.mint = { ...input.mint, scope: { ...input.mint.scope, activePolicySha256: "f".repeat(64) } };
    if (reason === "epoch") input.assessment = { ...input.assessment, scope: { ...input.assessment.scope, writerEpoch: "999" } };
    if (reason === "database") await corruptPolicy("UPDATE open_mint.budget_policies SET max_total=2 WHERE namespace_id=$1", h.ns.id);
    if (reason === "role") input.expectedRole = "unreviewed_role";
    if (reason === "public") input.requests = { ...input.requests, profile: { ...input.requests.profile, chain_id: "11155111" } } as never;
    if (reason === "pre-aborted") controller.abort();
    if (reason === "operations") {
      const incomplete = localReviewFixture(h.trusted.assessment.scope, { operations: ["reuse"] });
      const files = localReviewFilesFixture({ assessment: incomplete }); reviewRoots.push(files); input.assessment = files.configs.assessment;
    }
    await expect(prepareLocalAdmissionStartup(input, controller.signal)).rejects.toThrow("Local admission startup unavailable.");
    expect(await h.counts()).toEqual({ providers: 0, wallets: 0 }); expect(h.x).not.toHaveBeenCalled(); expect(h.grok).not.toHaveBeenCalled(); expect(h.signer.signTypedData).not.toHaveBeenCalled();
  });
  it("observes file withdrawal after X and stops before Grok without clearing its fence", async () => {
    const h = await setup(10000, false, true);
    h.x.mockImplementation(async () => { unlinkSync(join(h.files.directory, "assessment.json")); return Response.json({ data: { id: "123", username: "Alice" } }); });
    const request = await h.create(); expect((await h.runtime.status(request.code, h.session)).status).toBe("failed");
    expect(h.x).toHaveBeenCalledOnce(); expect(h.grok).not.toHaveBeenCalled(); expect(await h.counts()).toEqual({ providers: 1, wallets: 0 });
    writeFileSync(join(h.files.directory, "assessment.json"), canonicalize(h.trusted.assessment.envelope)!, { mode: 0o600 });
    await expect(h.startup!.recheck()).rejects.toThrow("startup unavailable");
    await expect(h.runtime.authorize(request.code, true, h.intent)).rejects.toThrow(); expect(h.signer.signTypedData).not.toHaveBeenCalled();
  });
  it("rechecks the file before releasing an already-signed wallet plan", async () => {
    const h = await setup(10000, false, true), request = await h.create(), issued = await h.runtime.authorize(request.code, true, h.intent);
    const submissions = new PostgresWalletSubmissions(h.requests), plan = await submissions.stage(request.code, h.intent, issued,
      { chainId: "0x7a69", contract: issued.transaction.to, blockNumber: "0xa", blockHash: h.chain.config.deploymentBlock.hash, nonce: "0x0" });
    unlinkSync(join(h.files.directory, "mint.json"));
    await expect(h.runtime.beginSubmission(submissions, request.code, h.intent, plan, new AbortController().signal)).rejects.toThrow();
    expect(h.signer.signTypedData).toHaveBeenCalledOnce(); expect((await h.counts()).wallets).toBe(0);
  });
  it.each(["withdrawal", "policy", "cancel", "halt"])("rechecks %s during/after database work before allowing startup", async reason => {
    const h = await setup(), startup = await prepareLocalAdmissionStartup(h.startupInput), controller = new AbortController();
    const queue = writer!.transaction(tx => tx.query("SELECT pg_sleep(0.12)"));
    const pending = startup.recheck(controller.signal);
    const failure = expect(pending).rejects.toThrow("Local admission startup unavailable.");
    if (reason === "withdrawal") unlinkSync(join(h.files.directory, "mint.json"));
    if (reason === "policy") await corruptPolicy("UPDATE open_mint.generative_issuance_profiles SET signer_timeout_ms=11000 WHERE namespace_id=$1", h.ns.id);
    if (reason === "cancel") controller.abort();
    if (reason === "halt") startup.halt();
    await failure; await queue;
    await expect(startup.recheck()).rejects.toThrow("startup unavailable");
    expect(await h.counts()).toEqual({ providers: 0, wallets: 0 }); writer!.assertHealthy();
  });
  it("bounds startup time without returning a late runtime or closing the caller's writer", async () => {
    const h = await setup(), patch = { timeoutMs: 30, permitTtlMs: 30 };
    const files = localReviewFilesFixture({
      assessment: localReviewFixture({ ...h.trusted.assessment.scope, ...patch }, { operations: ["reuse", "assessment-x", "assessment-grok"] }),
      mint: localReviewFixture({ ...h.trusted.mint.scope, ...patch }, { operations: ["reuse", "sign", "wallet-submit"] }),
    }); reviewRoots.push(files);
    const queue = writer!.transaction(tx => tx.query("SELECT pg_sleep(0.15)"));
    await expect(prepareLocalAdmissionStartup({ ...h.startupInput, assessment: files.configs.assessment, mint: files.configs.mint })).rejects.toThrow("startup unavailable");
    await queue; writer!.assertHealthy(); expect(await h.counts()).toEqual({ providers: 0, wallets: 0 });
    const restarted = await prepareLocalAdmissionStartup(h.startupInput); await restarted.recheck(); restarted.halt();
  });
});
