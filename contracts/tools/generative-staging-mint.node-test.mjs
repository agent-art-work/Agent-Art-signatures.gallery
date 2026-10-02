import assert from "node:assert/strict";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import { Client } from "pg";
import { decodeFunctionData, getAddress } from "viem";
import { stagingAssessmentFixture } from "./fixtures/generative-staging-assessment.mjs";
import { disposablePostgres } from "../../src/openMint/persistence/fixtures/postgres.ts";
import { createStagingAssessmentWorker } from "./generative-staging-worker.mjs";
import { createStagingMintController } from "./generative-staging-mint.mjs";
import { stagingReviewFixture } from "../../src/openMint/staging/fixtures/stagingReview.ts";
import { identity, receipt } from "../../src/openMint/persistence/fixtures/data.ts";
import { PostgresGenerativeInputJournal } from "../../src/openMint/persistence/generativeInputs.ts";
import { PostgresGenerativeAuthorizationIssuer, verifyReservedSignature } from "../../src/openMint/persistence/generativeAuthorizations.ts";
import { PostgresWalletSubmissions } from "../../src/openMint/persistence/walletSubmissions.ts";
import { GENERATIVE_MINT_ABI } from "../../src/openMint/generativeAuthorization.ts";
import { stagingRuntimeBinding } from "./generative-staging-assessment.mjs";
import { certifyStagingMintBinding, prepareStagingMintAdmission } from "../../src/openMint/persistence/stagingMintAdmission.ts";

async function expectCheckpoint(checkpoint, operation, label, timeoutMs = 20000) {
  let timer;
  try {
    await Promise.race([checkpoint, operation.then(
      result => { throw Error(`${label} completed before its checkpoint: ${JSON.stringify(result)}`); },
      cause => { throw Error(`${label} rejected before its checkpoint`, { cause }); },
    ), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} checkpoint timed out`)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
class TestSettlementTimeout extends Error {}
async function settleWithin(operation, label, timeoutMs = 20000) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TestSettlementTimeout(`${label} settlement timed out`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

test("mint checkpoint reports early completion instead of waiting for an unreachable signer", async () => {
  await assert.rejects(expectCheckpoint(new Promise(() => {}), Promise.resolve({ reused: true }), "mint signer"),
    /completed before its checkpoint.*reused/);
});
test("mint checkpoint surfaces early refusal with its original cause", async () => {
  const cause = Error("mock pre-signing refusal");
  await assert.rejects(expectCheckpoint(new Promise(() => {}), Promise.reject(cause), "mint signer"), error => error.cause === cause);
});
test("mint checkpoint bounds an unreachable held signer", async () => {
  await assert.rejects(expectCheckpoint(new Promise(() => {}), new Promise(() => {}), "mint signer", 5), /checkpoint timed out/);
});
test("mint close and drain have a visible test-only settlement bound", async () => {
  await assert.rejects(settleWithin(new Promise(() => {}), "mint drain", 5), TestSettlementTimeout);
});
test("mint settlement preserves the original rejection", async () => {
  const cause = Error("mock mint drain rejection");
  await assert.rejects(settleWithin(Promise.reject(cause), "mint drain"), error => error === cause);
});

describe("future staging mint authority: disposable SQL, mocked assessment, public test signer, NO broadcast", { skip: process.env.OPEN_MINT_TEST_POSTGRES !== "1" }, () => {
  let cluster, admin, f, worker, controller, review, calls, hooks, signer, assessed;
  const releases = new Set();
  const hold = () => {
    let resolve; const promise = new Promise(r => resolve = r);
    const release = () => { releases.delete(release); resolve(); }; releases.add(release);
    return { promise, release };
  };
  const settle = async (operation, label) => {
    try { return await settleWithin(operation, label); }
    catch (error) {
      if (error instanceof TestSettlementTimeout) {
        for (const release of releases) release(); controller?.halt(); worker?.halt(); f?.controller.halt();
        // Query promises still reject. Quiet only idle socket error events
        // after this already-fatal test timeout so they cannot mask its cause.
        for (const client of [admin, f?.db, f?.runtime].filter(Boolean)) client.on("error", () => {});
        // This cluster belongs solely to the test, never an active environment.
        try { cluster?.stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], label); }
      }
      throw error;
    }
  };
  const closeController = () => settle(controller?.close(), "staging mint controller close");
  const closeWorker = () => settle(worker?.close(), "staging mint assessment worker close");
  before(async () => { cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); });
  after(async () => { try { await settle(admin?.end(), "mint administrator close"); } finally { cluster?.stop(); } });
  beforeEach(async () => {
    f = await stagingAssessmentFixture(cluster, admin, { claimed: false }); calls = { x: 0, grok: 0, sign: 0 }; hooks = {};
    // Fresh synthetic heads: exercise freshness without consuming almost the
    // entire allowed age before the longer restart/coverage tests even begin.
    for (const [i, header] of f.active.headers.entries()) header.timestamp = `0x${BigInt(Math.floor(Date.now() / 1000) - 20 + i * 2).toString(16)}`;
    worker = createStagingAssessmentWorker(f.input, { refreshEligibility: () => f.witness(),
      identityResolver: { provenance: "x-api", resolve: async (handle, execution) => { calls.x++; execution.dispatch.assertCurrent("x-identity");
        await execution.recordReceipt(receipt("x-identity", "1")); return { ...identity(handle), username: "ALIce", provenance: "x-api" }; } },
      provider: { provenance: "grok", model: f.input.assessmentPolicy.model, assess: async (handle, snapshot, execution) => {
        calls.grok++; execution.dispatch.assertCurrent("grok"); await execution.recordReceipt(receipt("grok", "1"));
        return { handle, mbti: "ENFP", model: f.input.assessmentPolicy.model, providerResponseId: "offline-mint", sourceUrls: ["https://x.com/ALIce"], xUserId: snapshot.userId }; } },
    });
    assessed = await worker.run(await f.intent()); assert.equal(assessed.kind, "accepted"); await closeWorker();
    await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=true");
    signer = { address: f.active.accounts.authorizer.address, async signTypedData(data, signal) {
      calls.sign++; assert.equal((await state()).authorization, "signing"); signal.throwIfAborted();
      return hooks.sign ? hooks.sign(data, signal) : f.active.accounts.authorizer.signTypedData(data);
    } };
    open();
  });
  afterEach(async () => {
    for (const release of releases) release();
    if (f) f.faults.afterQuery = undefined; controller?.halt(); worker?.halt(); f?.controller.halt();
    const failures = [];
    for (const cleanup of [closeController, closeWorker, () => settle(f?.close(), "mint fixture close")]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    f = undefined; controller = undefined; worker = undefined;
    if (failures.length) throw new AggregateError(failures, "Staging mint teardown failed");
  });
  function open(patch = {}) {
    controller?.halt(); const candidate = createStagingMintController(f.input);
    review = stagingReviewFixture(candidate.scope, { operations: ["reuse", "sign", "wallet-submit"], ...patch }); candidate.halt();
    controller = createStagingMintController({ ...f.input, reviewSource: review.source });
  }
  const intent = async () => ({ ...await f.intent(), consent: true });
  const browser = () => ({ session: f.session, origin: f.settings.origin, csrf: f.session.csrf });
  const network = () => ({ chainId: "0xaa36a7", contract: getAddress(f.d.collection.address), blockNumber: f.active.headers.at(-1).number,
    blockHash: f.active.headers.at(-1).hash, nonce: "0x0" });
  const issue = async () => controller.issue(await intent(), signer);
  const plan = async () => controller.stageWallet(await intent(), browser(), network());
  const state = async () => (await f.db.query(`SELECT (SELECT state FROM open_mint.generative_authorizations LIMIT 1) AS authorization,
    (SELECT count(*)::int FROM open_mint.generative_inputs) AS inputs,(SELECT count(*)::int FROM open_mint.generative_authorization_signatures) AS signatures,
    (SELECT count(*)::int FROM open_mint.wallet_mint_dispatches) AS dispatches`)).rows[0];
  const config = () => {
    const { db, binding, observeDatabase } = stagingRuntimeBinding(f.input);
    return { review: db, databaseBindingSha256: binding, scopeSha256: controller.scopeSha256, leaseMs: controller.scope.permitTtlMs, assertProfiles: observeDatabase };
  };

  test("accepted assessment -> compact inputs -> exact Sepolia authorization -> one wallet permit; no caller MBTI or nonce replacement", async () => {
    const value = { ...await intent(), handle: "bob", mbti: "ISTJ", renderHandle: "BOb", nonce: `0x${"9".repeat(64)}` };
    const result = await controller.issue(value, signer), r = result.reservation;
    assert.equal(r.renderHandle, "ALIce"); assert.equal(r.handle, "alice"); assert.equal(r.mbti, "ENFP"); assert.equal(r.domain.chainId, "11155111");
    assert.equal(r.authorization.assessmentDigest, assessed.assessment.digest); assert.equal(await verifyReservedSignature(r, result.signature), true);
    assert.equal(await verifyReservedSignature({ ...r, domain: { ...r.domain, chainId: "31337" } }, result.signature), false);
    assert.equal(await controller.preflightNonce(value), r.authorization.nonce);
    const p = await plan(), decoded = decodeFunctionData({ abi: GENERATIVE_MINT_ABI, data: p.transaction.data });
    assert.equal(p.transaction.chainId, "0xaa36a7"); assert.equal(p.transaction.value, "0x0"); assert.equal(p.transaction.nonce, "0x0");
    assert.deepEqual(decoded.args.slice(0, 2), ["ALIce", "ENFP"]); assert.equal(decoded.args[3], result.signature);
    const sent = await controller.submit(await intent(), browser(), p); assert.match(sent.permit, /^[A-Za-z0-9_-]{43}$/);
    await assert.rejects(controller.submit(await intent(), browser(), p)); assert.equal((await state()).dispatches, 1);
    const hash = `0x${"5".repeat(64)}`; await controller.report(f.request.code, browser(), sent.permit, "submitted", hash);
    assert.deepEqual(await controller.submissionState(f.request.code, f.session.id), { blocked: true, transactionHash: hash });
    assert.deepEqual(calls, { x: 1, grok: 1, sign: 1 });
  });
  test("restart and disabled generation reuse exact signature without provider or signer calls", async () => {
    const signed = await issue(); await closeController(); await settle(f.restart(), "mint fixture restart"); open();
    await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=false");
    hooks.sign = () => { throw Error("must not sign again"); };
    assert.deepEqual(await issue(), signed); assert.equal((await plan()).transaction.chainId, "0xaa36a7");
    assert.deepEqual(calls, { x: 1, grok: 1, sign: 1 });
  });
  test("local constructors and unguarded staging factories remain closed", async () => {
    await assert.rejects(PostgresGenerativeInputJournal.open(f.writer, f.ns.id, f.target.deploymentId));
    await assert.rejects(PostgresGenerativeInputJournal.openGuardedStaging(f.writer, f.ns.id, f.target.deploymentId));
    await assert.rejects(PostgresGenerativeAuthorizationIssuer.open(f.requests, { writer: f.writer, namespaceId: f.ns.id, deploymentId: f.target.deploymentId }));
    await assert.rejects(PostgresGenerativeAuthorizationIssuer.openGuardedStaging(f.requests, {}, undefined));
    assert.throws(() => new PostgresWalletSubmissions(f.requests)); assert.throws(() => PostgresWalletSubmissions.guardedStaging(f.requests));
    for (const key of ["issuer", "journal", "submissions", "activate", "broadcast", "requests"]) assert.equal(key in controller, false);
    assert.throws(() => createStagingMintController({ ...f.input, extra: true }), /controller unavailable/);
  });
  for (const failure of ["consent", "csrf", "wallet", "disabled", "review", "grants", "cancelled", "signer", "sign-review"]) test(`refuses ${failure} before signing`, async () => {
    const v = await intent(), abort = new AbortController();
    if (failure === "consent") v.consent = false;
    if (failure === "csrf") v.csrf = "z".repeat(43);
    if (failure === "wallet") await f.sessions.challenge(f.session.id, f.wallet.address);
    if (failure === "disabled") await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false");
    if (failure === "review") review.withdraw();
    if (failure === "grants") await f.db.query("GRANT DELETE ON open_mint.requests TO sg_browser");
    if (failure === "cancelled") abort.abort();
    if (failure === "signer") signer.address = f.wallet.address;
    if (failure === "sign-review") open({ operations: ["reuse", "wallet-submit"] });
    await assert.rejects(controller.issue(v, signer, abort.signal)); assert.equal(calls.sign, 0); assert.equal((await state()).signatures, 0);
  });
  for (const failure of ["invalid", "timeout", "review-withdrawn", "cancelled"]) test(`signer ${failure} preserves uncertainty without signing twice`, async () => {
    const held = hold();
    const abort = new AbortController(); hooks.sign = async data => {
      if (failure === "invalid") return "0x";
      if (failure === "timeout") await held.promise;
      if (failure === "review-withdrawn") review.withdraw();
      if (failure === "cancelled") abort.abort();
      return f.active.accounts.authorizer.signTypedData(data);
    };
    const pending = controller.issue(await intent(), signer, abort.signal);
    try { await settle(assert.rejects(pending), `signer ${failure} refusal`); }
    finally { held.release(); abort.abort(); await settle(pending.catch(() => {}), `signer ${failure} drain`); }
    assert.equal((await state()).authorization, "unknown");
    await closeController(); await settle(f.restart(), "mint fixture restart"); open(); hooks.sign = undefined;
    await assert.rejects(issue()); assert.equal(calls.sign, 1); assert.equal((await state()).signatures, 0);
  });
  for (const kind of ["inputs", "reservation", "signing", "signature", "wallet"]) test(`lost ${kind} COMMIT acknowledgment never duplicates authority`, async () => {
    if (kind === "wallet") await issue(); const p = kind === "wallet" ? await plan() : undefined;
    const prefix = { inputs: "INSERT INTO open_mint.generative_inputs", reservation: "INSERT INTO open_mint.generative_authorizations(",
      signing: "UPDATE open_mint.generative_authorizations SET state='signing'", signature: "INSERT INTO open_mint.generative_authorization_signatures", wallet: "INSERT INTO open_mint.wallet_mint_dispatches" }[kind];
    let armed = false; f.faults.afterQuery = sql => { if (sql.startsWith(prefix)) armed = true; if (armed && sql === "COMMIT") throw Error("Injected lost commit reply"); };
    await assert.rejects(kind === "wallet" ? controller.submit(await intent(), browser(), p) : issue()); f.faults.afterQuery = undefined;
    const previous = { ...calls }; await closeController(); await settle(f.restart(), "mint fixture restart"); open();
    if (kind === "signing") { await assert.rejects(issue()); assert.equal((await state()).authorization, "signing"); }
    else if (kind === "wallet") { await assert.rejects(controller.submit(await intent(), browser(), p)); assert.equal((await state()).dispatches, 1); }
    else { await issue(); assert.equal(calls.sign, kind === "signature" ? previous.sign : 1); }
    assert.equal(calls.x, 1); assert.equal(calls.grok, 1);
  });
  test("post-fence review withdrawal retains signing state even if signer never entered", async () => {
    let armed = false; f.faults.afterQuery = sql => { if (sql.startsWith("UPDATE open_mint.generative_authorizations SET state='signing'")) armed = true;
      if (armed && sql === "COMMIT") review.withdraw(); };
    await assert.rejects(issue()); f.faults.afterQuery = undefined; assert.equal(calls.sign, 0); assert.equal((await state()).authorization, "signing");
  });
  for (const kind of ["input-review", "reservation-disabled", "sign-fence-abort", "wallet-fence-review"]) test(`checks ${kind} at the durable boundary`, async () => {
    const abort = new AbortController(); if (kind === "wallet-fence-review") await issue();
    const p = kind === "wallet-fence-review" ? await plan() : undefined;
    let fenced = false;
    f.faults.afterQuery = async sql => {
      if (kind === "input-review" && sql.startsWith("INSERT INTO open_mint.generative_inputs")) review.withdraw();
      if (kind === "reservation-disabled" && sql.startsWith("INSERT INTO open_mint.generative_authorization_heads")) {
        await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false");
      }
      if (kind === "sign-fence-abort" && sql.startsWith("UPDATE open_mint.generative_authorizations SET state='signing'")) abort.abort();
      if (kind === "wallet-fence-review" && sql.startsWith("INSERT INTO open_mint.wallet_mint_dispatches")) fenced = true;
      if (fenced && sql === "COMMIT") review.withdraw();
    };
    await assert.rejects(p ? controller.submit(await intent(), browser(), p) : controller.issue(await intent(), signer, abort.signal));
    f.faults.afterQuery = undefined; const result = await state();
    assert.equal(calls.sign, p ? 1 : 0); assert.equal(result.dispatches, p ? 1 : 0);
    if (kind === "input-review") assert.equal(result.inputs, 0);
    if (kind === "reservation-disabled") assert.equal(result.authorization, null);
    if (kind === "sign-fence-abort") assert.equal(result.authorization, "reserved");
  });
  test("saved signature and wallet release still require active chain evidence and their own review", async () => {
    await issue(); const p = await plan(); open({ operations: ["reuse", "sign"] });
    await assert.rejects(controller.submit(await intent(), browser(), p)); assert.equal((await state()).dispatches, 0);
    open(); const value = await intent();
    f.active.mutate((method, params, result) => method === "eth_getCode" ? "0x" : result);
    await assert.rejects(controller.issue(value, signer)); await assert.rejects(controller.stageWallet(value, browser(), network()));
    assert.equal(calls.sign, 1);
  });
  test("mint rejects static profile and cached request-profile drift", async () => {
    const value = await intent();
    await f.db.query("BEGIN; SET LOCAL session_replication_role=replica");
    await f.db.query("UPDATE open_mint.generative_issuance_profiles SET lifetime_seconds=599"); await f.db.query("COMMIT");
    await assert.rejects(controller.issue(value, signer)); assert.equal(calls.sign, 0);
  });
  test("mandatory SQL adapter refuses invalid config, crossed cached profile and replayed/reuse fences", async () => {
    const c = config(), signal = new AbortController().signal, v = { operation: "sign", requestId: f.request.id, payloadSha256: "a".repeat(64) };
    let effects = 0, fences = 0;
    const op = { requests: f.requests, intent: v, async inspect() { return { observedAt: Date.now(), validUntil: Date.now() + 10000 }; },
      async fence() { fences++; }, async effect(_signal, guard) { guard(); effects++; return "ok"; } };
    await assert.rejects(prepareStagingMintAdmission(op, { ...c, leaseMs: 0 }));
    await assert.rejects(prepareStagingMintAdmission({ ...op, intent: { ...v, operation: "read" } }, c));
    await assert.rejects(f.writer.transaction(tx => certifyStagingMintBinding(tx, { ...f.requests, profile: { ...f.requests.profile, authorizer: f.wallet.address.toLowerCase() } }, c, signal, true)));
    const a = await prepareStagingMintAdmission(op, c);
    await assert.rejects(a.effect(v, signal, () => {}));
    await assert.rejects(a.database.inspect(v, "0".repeat(64), signal));
    await assert.rejects(a.database.inspect({ ...v, payloadSha256: "b".repeat(64) }, c.scopeSha256, signal));
    const lease = await a.database.inspect(v, c.scopeSha256, signal); assert.throws(() => lease.assertCurrent("reuse"));
    await lease.fence(signal); await assert.rejects(lease.fence(signal));
    assert.equal(await a.effect(v, signal, () => {}), "ok"); await assert.rejects(a.effect(v, signal, () => {}));
    assert.equal(effects, 1); assert.equal(fences, 1);
    const r = await prepareStagingMintAdmission({ ...op, intent: { ...v, operation: "reuse" } }, c);
    const readLease = await r.database.inspect(r.intent, c.scopeSha256, signal); await assert.rejects(readLease.fence(signal));
    assert.equal(await r.effect(r.intent, signal, () => {}), "ok"); r.halt(); await assert.rejects(r.database.inspect(r.intent, c.scopeSha256, signal));
  });
  test("internal staging resources prohibit unguarded issue/begin and reject forged accepted inputs", async () => {
    const guard = tx => certifyStagingMintBinding(tx, f.requests, config(), new AbortController().signal, false);
    const journal = await PostgresGenerativeInputJournal.openGuardedStaging(f.writer, f.ns.id, f.target.deploymentId, guard);
    const issuer = await PostgresGenerativeAuthorizationIssuer.openGuardedStaging(f.requests, journal, guard);
    await assert.rejects(issuer.issue(await intent(), signer), /requires admission/);
    await assert.rejects(PostgresWalletSubmissions.guardedStaging(f.requests, guard).begin(f.request.code, browser(), {}), /requires admission/);
    await assert.rejects(journal.stage({ ...assessed.assessment, mbti: "ISTJ" }));
    assert.equal(await journal.load("alice"), undefined); assert.equal(calls.sign, 0);
  });
  test("same nonce explicit rejected resend only; unknown or reported submission cannot be resubmitted", async () => {
    await issue(); const p = await plan(), sent = await controller.submit(await intent(), browser(), p);
    await assert.rejects(controller.stageWallet(await intent(), browser(), { ...network(), nonce: "0x1" }));
    await controller.report(f.request.code, browser(), sent.permit, "rejected");
    await assert.rejects(controller.stageWallet(await intent(), browser(), { ...network(), nonce: "0x1" }));
    assert.deepEqual(await plan(), p); const next = await controller.submit(await intent(), browser(), p); assert.notEqual(sent.permit, next.permit);
    await assert.rejects(controller.report(f.request.code, browser(), sent.permit, "rejected")); assert.equal((await state()).dispatches, 2);
  });
  test("wallet refuses changed plan and disabled issuance; reports remain recoverable after disable", async () => {
    await issue(); const p = await plan();
    await assert.rejects(controller.submit(await intent(), browser(), { ...p, transaction: { ...p.transaction, nonce: "0x1" } }));
    await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false"); await assert.rejects(controller.submit(await intent(), browser(), p));
    await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=true");
    const sent = await controller.submit(await intent(), browser(), p); await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false");
    await controller.report(f.request.code, browser(), sent.permit, "submitted", `0x${"6".repeat(64)}`);
    assert.equal((await controller.submissionState(f.request.code, f.session.id)).blocked, true);
  });
  test("close cancels signing, drains cleanup, refuses concurrent and subsequent operations", async () => {
    let entered; const ready = new Promise(r => entered = r), held = hold();
    hooks.sign = async () => { entered(); await held.promise; return "0x"; };
    const pending = issue();
    try {
      await expectCheckpoint(ready, pending, "close-cancels-signing signer");
      await assert.rejects(issue(), /already running/); await closeController(); await settle(assert.rejects(pending), "closed signer refusal");
    } finally {
      held.release(); controller.halt();
      await settle(pending.catch(() => {}), "closed signer operation drain"); await closeController();
    }
    assert.equal((await state()).authorization, "unknown"); await assert.rejects(issue());
  });
  test("whole-controller deadline quarantines a delayed SQL preparation without authority", async () => {
    controller.halt(); const parsed = JSON.parse(f.input.operatingJson);
    parsed.settings.rpc.timeoutMs = 1000; parsed.settings.hosting.requestTimeoutMs = 1000; parsed.settings.hosting.drainTimeoutMs = 1000;
    const input = { ...f.input, operatingJson: JSON.stringify(parsed) }, candidate = createStagingMintController(input);
    const signed = stagingReviewFixture(candidate.scope, { operations: ["reuse", "sign", "wallet-submit"] }); candidate.halt();
    controller = createStagingMintController({ ...input, reviewSource: signed.source });
    let delayed = false; f.faults.afterQuery = async sql => {
      if (!delayed && sql.startsWith("SELECT p.*,n.profile AS namespace_profile")) { delayed = true; await new Promise(r => setTimeout(r, 1500)); }
    };
    try { await assert.rejects(controller.preflightNonce(await intent())); await assert.rejects(issue()); }
    finally {
      f.faults.afterQuery = undefined;
      await settle(f.writer.transaction(async () => {}), "delayed mint SQL read drain"); // only this test's delayed read
    }
    assert.equal((await state()).authorization, null); assert.equal(calls.sign, 0);
  });
});
