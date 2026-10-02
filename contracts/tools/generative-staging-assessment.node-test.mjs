import assert from "node:assert/strict";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import { Client } from "pg";
import { stagingAssessmentFixture } from "./fixtures/generative-staging-assessment.mjs";
import { disposablePostgres } from "../../src/openMint/persistence/fixtures/postgres.ts";
import { assessment, bytes, identity, receipt } from "../../src/openMint/persistence/fixtures/data.ts";
import { createStagingAssessmentController } from "./generative-staging-assessment.mjs";
import { PostgresAssessmentWorker } from "../../src/openMint/persistence/assessmentWorker.ts";
import { LocalAdmissionRuntime } from "../../src/openMint/persistence/localAdmissionRuntime.ts";
import { XApiIdentityResolver } from "../../src/openMint/xIdentity.ts";
import { GrokAssessmentProvider } from "../../src/openMint/grok.ts";
import { capabilityHash } from "../../src/openMint/persistence/sessions.ts";
import { stagingReviewFixture } from "../../src/openMint/staging/fixtures/stagingReview.ts";

// A mocked dispatch can be refused before its callback is reached. Await the
// actual operation too, so that refusal fails the test instead of leaving a
// disposable PG connection alive behind an unreachable checkpoint forever.
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

test("assessment checkpoint surfaces early dispatch rejection instead of hanging", async () => {
  const cause = Error("mock pre-dispatch refusal");
  await assert.rejects(expectCheckpoint(new Promise(() => {}), Promise.reject(cause), "assessment"), error => error.cause === cause);
});
test("assessment checkpoint bounds an unreachable mocked callback", async () => {
  await assert.rejects(expectCheckpoint(new Promise(() => {}), new Promise(() => {}), "assessment", 5), /checkpoint timed out/);
});
test("assessment teardown has a visible bound if settlement regresses", async () => {
  await assert.rejects(settleWithin(new Promise(() => {}), "assessment drain", 5), TestSettlementTimeout);
});

describe("staging assessment/reuse controller; real private PG16 and synthetic active Sepolia", { skip: process.env.OPEN_MINT_TEST_POSTGRES !== "1" }, () => {
  let cluster, admin, f;
  const settle = async (operation, label) => {
    try { return await settleWithin(operation, label); }
    catch (error) {
      if (error instanceof TestSettlementTimeout) {
        f?.controller.halt();
        // The timeout already fails this test. Preserve it as the diagnostic;
        // idle socket shutdown must not turn into an uncaught Client event.
        for (const client of [admin, f?.db, f?.runtime].filter(Boolean)) client.on("error", () => {});
        // Only the new private cluster allocated by this suite is stopped.
        try { cluster?.stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], label); }
      }
      throw error;
    }
  };
  before(async () => { cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); });
  after(async () => { try { await settle(admin?.end(), "assessment administrator close"); } finally { cluster?.stop(); } });
  beforeEach(async () => { f = await stagingAssessmentFixture(cluster, admin); });
  afterEach(async () => { f?.controller.halt(); try { await settle(f?.close(), "assessment fixture close"); } finally { f = undefined; } });
  const dispatch = async (leg, effect = async d => { d.assertCurrent(leg); return "effect"; }, input) => f.controller.dispatch(input ?? await f.intent(), leg,
    f.input.assessmentPolicy.model, new AbortController().signal, effect);
  const modify = async sql => {
    await f.db.query("BEGIN; SET LOCAL session_replication_role=replica");
    try { await f.db.query(sql); await f.db.query("COMMIT"); } catch (error) { await f.db.query("ROLLBACK"); throw error; }
  };
  test("explicit v2 runtime binds inspector/recovery roles and dispatches only after the matching v2 certificate", async () => {
    await settle(f.close(), "assessment v1 fixture close"); f = await stagingAssessmentFixture(cluster, admin, { v2: true });
    assert.equal(f.input.databaseReview.version, "sg-generative-runtime-db-review-v2");
    await dispatch("x-identity", async d => { d.assertCurrent("x-identity"); return "offline-v2"; });
    assert.deepEqual(await f.fences(), ["x-identity"]);
    const crossed = { ...f.input, databaseReview: { ...f.input.databaseReview, version: "sg-generative-runtime-db-review-v1" } };
    assert.throws(() => createStagingAssessmentController(crossed), /controller unavailable/);
  });
  test("fences X then Grok before mock effects and preserves exact accepted assessment across writer restart", async () => {
    assert.deepEqual(await f.fences(), []);
    await dispatch("x-identity", async d => { d.assertCurrent("x-identity"); assert.deepEqual(await f.fences(), ["x-identity"]); return "X result"; });
    await assert.rejects(dispatch("x-identity"), /already|admission/);
    await assert.rejects(dispatch("grok"), /successful X/);
    const id = { ...identity(), username: "Alice", provenance: "x-api" };
    await f.repository.recordReceipt(f.request.attemptId, bytes(receipt("x-identity", "1")));
    await f.repository.recordIdentity(f.request.attemptId, bytes(id));
    await dispatch("grok", async d => { d.assertCurrent("grok"); assert.deepEqual(await f.fences(), ["grok", "x-identity"]); return "Grok result"; });
    await f.repository.recordReceipt(f.request.attemptId, bytes(receipt("grok", "1")));
    const saved = await f.repository.acceptAssessment(f.request.attemptId, bytes(assessment("alice", { provenance: "grok", model: f.input.assessmentPolicy.model,
      providerResponseId: "offline-staging-test", sourceUrls: ["https://x.com/Alice"], xIdentity: id })));
    const old = f.controller; await f.restart(); await assert.rejects(old.reuse(await f.intent()));
    await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=false");
    assert.deepEqual(await f.controller.reuse(await f.intent()), saved);
    assert.deepEqual(await f.fences(), ["grok", "x-identity"]);
  });
  test("public-profile local worker and local controller still refuse; no new mint entrypoint", () => {
    assert.throws(() => new PostgresAssessmentWorker(f.requests, { timeoutMs: 5000 }), /PUBLIC_WORKER_DISABLED/);
    assert.throws(() => new LocalAdmissionRuntime(f.requests, {}), /Local admission only/);
    for (const key of ["start", "issue", "submit", "activate", "sign"]) assert.equal(key in f.controller, false);
  });
  test("refuses malformed composition and changed deployment/model/review pins before use", () => {
    for (const input of [null, {}, { ...f.input, extra: true }, { ...f.input, assessmentPolicy: { ...f.input.assessmentPolicy, model: "grok-other" } },
      { ...f.input, databaseReview: { ...f.input.databaseReview, version: undefined } },
      { ...f.input, databaseReview: { ...f.input.databaseReview, ownerRole: "postgres" } },
      { ...f.input, databaseReview: { ...f.input.databaseReview, migrationManifestSha256: "0".repeat(64) } },
      { ...f.input, reviewSource: { ...f.input.reviewSource, revisionSha256: "bad" } }]) {
      assert.throws(() => createStagingAssessmentController(input), /controller unavailable/);
    }
    assert.throws(() => f.controller.dispatch({}, "sign", f.input.assessmentPolicy.model, undefined, async () => {}));
    assert.throws(() => f.controller.dispatch({}, "grok", "grok-other", undefined, async () => {}));
    assert.throws(() => f.controller.dispatch({}, "grok", f.input.assessmentPolicy.model, undefined, undefined));
  });
  for (const name of ["code", "sessionToken", "sessionGeneration", "origin", "csrf", "eligibility"]) test(`refuses crossed ${name} with no fence`, async () => {
    const input = await f.intent(); input[name] = name === "eligibility" ? {} : name === "sessionGeneration" ? "999" : "z".repeat(43);
    let effects = 0; await assert.rejects(dispatch("x-identity", async () => effects++, input));
    assert.equal(effects, 0); assert.deepEqual(await f.fences(), []);
  });
  for (const [name, sql] of Object.entries({
    "revoked session": "UPDATE open_mint.sessions SET revoked=true,wallet=NULL,proof_wallet=NULL,proof_expires_at=NULL,proof_code_hash=NULL,active_challenge_hash=NULL",
    "expired session": "UPDATE open_mint.sessions SET expires_at=clock_timestamp()-interval '1 second'",
    "missing wallet proof": "UPDATE open_mint.sessions SET proof_wallet=NULL,proof_expires_at=NULL,proof_code_hash=NULL",
    "expired wallet proof": "UPDATE open_mint.sessions SET proof_expires_at=clock_timestamp()-interval '1 second'",
    "wrong request-bound proof": `UPDATE open_mint.sessions SET proof_code_hash='${"a".repeat(64)}'`,
    "expired request": "UPDATE open_mint.requests SET created_at=created_at-interval '1 day',expires_at=expires_at-interval '1 day',preflight_observed_at=preflight_observed_at-interval '1 day',preflight_valid_until=preflight_valid_until-interval '1 day'",
    "disabled generation": "UPDATE open_mint.budget_policies SET generation_enabled=false",
    "static budget drift": "UPDATE open_mint.budget_policies SET max_total=max_total+1",
    "static model drift": "UPDATE open_mint.budget_policies SET expected_model='grok-other'",
    "request profile drift": "UPDATE open_mint.request_profiles SET max_evidence_age_ms=max_evidence_age_ms+1",
    "unreviewed grants": "GRANT DELETE ON open_mint.requests TO sg_browser",
  })) test(`refuses ${name} before provider dispatch`, async () => {
    const input = await f.intent(); await modify(sql); let effects = 0;
    await assert.rejects(dispatch("x-identity", async () => effects++, input)); assert.equal(effects, 0); assert.deepEqual(await f.fences(), []);
  });
  test("an active replacement-wallet challenge invalidates admission", async () => {
    await f.sessions.challenge(f.session.id, f.wallet.address); await assert.rejects(dispatch("x-identity")); assert.deepEqual(await f.fences(), []);
  });
  for (const [name, sql] of Object.entries({
    "budget ceiling": "UPDATE open_mint.budget_policies SET max_total=max_total+1",
    "renderer": `UPDATE open_mint.generative_input_profiles SET renderer_code_hash='0x${"1".repeat(64)}'`,
    "creation block": `UPDATE open_mint.request_profiles SET deployment_block_hash='0x${"1".repeat(64)}'`,
  })) test(`a freshly repinned database cannot override operating-plan ${name}`, async () => {
    await modify(sql); await f.restart(); let effects = 0;
    await assert.rejects(dispatch("x-identity", async () => effects++)); assert.equal(effects, 0); assert.deepEqual(await f.fences(), []);
  });
  test("allows exact request-bound wallet proof and does not require issuance for paid assessment", async () => {
    await f.db.query("UPDATE open_mint.sessions SET proof_code_hash=$1", [capabilityHash(f.request.code)]);
    assert.equal(await dispatch("x-identity"), "effect"); assert.deepEqual(await f.fences(), ["x-identity"]);
  });
  for (const scenario of ["withdrawn", "wrong operation", "halted", "cancelled", "closed writer", "chain mismatch"]) test(`refuses ${scenario} before transport`, async () => {
    const input = await f.intent(), abort = new AbortController(); let effects = 0;
    if (scenario === "withdrawn") f.signed.withdraw();
    if (scenario === "wrong operation") {
      f.controller.halt(); const signed = stagingReviewFixture(f.controller.scope, { operations: ["reuse"] });
      f.input.reviewSource = signed.source;
      const other = createStagingAssessmentController(f.input);
      await assert.rejects(other.dispatch(input, "x-identity", f.input.assessmentPolicy.model, abort.signal, async () => effects++)); other.halt();
    } else {
      if (scenario === "halted") f.controller.halt();
      if (scenario === "cancelled") abort.abort();
      if (scenario === "closed writer") await settle(f.writer.close(), "assessment writer close");
      if (scenario === "chain mismatch") f.active.mutate((m, _p, v, i) => m === "eth_chainId" && i === 1 ? "0x1" : v);
      await assert.rejects(f.controller.dispatch(input, "x-identity", f.input.assessmentPolicy.model, abort.signal, async () => effects++));
    }
    assert.equal(effects, 0); assert.deepEqual(await f.fences(), []);
  });
  for (const scenario of ["lost commit", "abort before commit", "review withdrawn after commit"]) test(`preserves durable fence semantics on ${scenario}`, async () => {
    const abort = new AbortController(), input = await f.intent(); let inserted = false, effects = 0;
    f.faults.afterQuery = sql => {
      if (sql.startsWith("INSERT INTO open_mint.dispatch_fences")) { inserted = true; if (scenario === "abort before commit") abort.abort(); }
      if (inserted && sql === "COMMIT") {
        if (scenario === "lost commit") throw Error("Injected lost acknowledgement, server committed");
        if (scenario === "review withdrawn after commit") f.signed.withdraw();
      }
    };
    await assert.rejects(f.controller.dispatch(input, "x-identity", f.input.assessmentPolicy.model, abort.signal, async () => effects++));
    assert.equal(effects, 0); assert.deepEqual(await f.fences(), scenario === "abort before commit" ? [] : ["x-identity"]);
    f.faults.afterQuery = undefined; await f.restart();
    await assert.rejects(dispatch("x-identity", async () => effects++)); assert.equal(effects, 0);
    await assert.rejects(f.repository.claimInitial(f.request.attemptId));
  });
  test("rechecks generation after initial inspection and before the paid fence", async () => {
    const input = await f.intent(); let changed = false;
    f.active.mutate(async (_m, _p, v) => { if (!changed) { changed = true; await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=false"); } return v; });
    await assert.rejects(dispatch("x-identity", async () => { throw Error("Must not dispatch"); }, input)); assert.deepEqual(await f.fences(), []);
  });
  test("rejects concurrent work and quarantines failed dispatched work across restart", async () => {
    const input = await f.intent(); let enter, release, effects = 0;
    const entered = new Promise(r => enter = r), hold = new Promise(r => release = r);
    const first = dispatch("x-identity", async d => { effects++; enter(); await hold; d.assertCurrent("x-identity"); throw Error("Transport outcome unknown"); }, input);
    try {
      await expectCheckpoint(entered, first, "concurrent assessment dispatch");
      await assert.rejects(dispatch("x-identity", async () => effects++, input)); release();
      await assert.rejects(first, error => error.effectMayHaveStarted === true);
    } finally { release(); await settle(first.catch(() => {}), "concurrent assessment drain"); }
    assert.equal(effects, 1); await f.restart(); await assert.rejects(dispatch("x-identity", async () => effects++));
    assert.equal(effects, 1); assert.deepEqual(await f.fences(), ["x-identity"]);
  });
  test("captures transport guard and refuses its use for another leg or after cancellation", async () => {
    const abort = new AbortController(), input = await f.intent(); let captured;
    await assert.rejects(f.controller.dispatch(input, "x-identity", f.input.assessmentPolicy.model, abort.signal, async d => {
      captured = d; assert.throws(() => d.assertCurrent("grok")); abort.abort(); await Promise.resolve(); d.assertCurrent("x-identity");
    }));
    assert.throws(() => captured.assertCurrent("x-identity")); assert.deepEqual(await f.fences(), ["x-identity"]);
  });
  test("rejects private reuse before an accepted assessment exists", async () => {
    await assert.rejects(f.controller.reuse(await f.intent())); assert.deepEqual(await f.fences(), []);
  });
  test("bounds pre-gate SQL work with the outer lifetime and quarantines late completion", async () => {
    const config = JSON.parse(f.input.operatingJson); config.settings.rpc.timeoutMs = 1000;
    config.settings.hosting.requestTimeoutMs = 1000; config.settings.hosting.drainTimeoutMs = 1000;
    const input = { ...f.input, operatingJson: JSON.stringify(config) }, candidate = createStagingAssessmentController(input);
    input.reviewSource = stagingReviewFixture(candidate.scope).source; candidate.halt();
    const controller = createStagingAssessmentController(input), intent = await f.intent(); let entered, resume, blocked = false, effects = 0;
    const waiting = new Promise(r => entered = r), held = new Promise(r => resume = r);
    f.faults.afterQuery = async sql => { if (!blocked && sql.startsWith("WITH")) { blocked = true; entered(); await held; } };
    const result = controller.dispatch(intent, "x-identity", f.input.assessmentPolicy.model, undefined, async () => effects++);
    try { await expectCheckpoint(waiting, result, "pre-gate SQL"); await assert.rejects(result, error => error.effectMayHaveStarted === true); }
    finally { resume(); f.faults.afterQuery = undefined; controller.halt(); await settle(result.catch(() => {}), "pre-gate SQL drain"); }
    await f.writer.transaction(tx => tx.query("SELECT 1"));
    await assert.rejects(controller.reuse(intent)); assert.equal(effects, 0); assert.deepEqual(await f.fences(), []);
  });
  test("bounds a hung transport; late callback guards cannot enable a second call", async () => {
    const config = JSON.parse(f.input.operatingJson); config.settings.rpc.timeoutMs = 2000;
    config.settings.hosting.requestTimeoutMs = 4000; config.settings.hosting.drainTimeoutMs = 4000;
    const input = { ...f.input, operatingJson: JSON.stringify(config) }, candidate = createStagingAssessmentController(input);
    input.reviewSource = stagingReviewFixture(candidate.scope).source; candidate.halt();
    const controller = createStagingAssessmentController(input), intent = await f.intent(); let resume, guard, effects = 0;
    const held = new Promise(r => resume = r);
    try {
      await assert.rejects(controller.dispatch(intent, "x-identity", f.input.assessmentPolicy.model, undefined, async d => {
        effects++; guard = d; await held; d.assertCurrent("x-identity");
      }), error => error.effectMayHaveStarted === true);
      assert.equal(effects, 1); assert.throws(() => guard.assertCurrent("x-identity")); assert.deepEqual(await f.fences(), ["x-identity"]);
    } finally { resume(); controller.halt(); }
    await f.restart(); await assert.rejects(dispatch("x-identity", async () => effects++)); assert.equal(effects, 1);
  });
  test("uses actual X/Grok clients with mock fetch, durable receipts and verified identity", async () => {
    let xCalls = 0, grokCalls = 0; const model = f.input.assessmentPolicy.model;
    const resolver = new XApiIdentityResolver({ bearerToken: "offline-placeholder", fetch: async () => {
      xCalls++; assert.deepEqual(await f.fences(), ["x-identity"]); return Response.json({ data: { id: "123", username: "ALIce" } });
    } });
    const provider = new GrokAssessmentProvider({ apiKey: "offline-placeholder", model, fetch: async () => {
      grokCalls++; assert.deepEqual(await f.fences(), ["grok", "x-identity"]);
      return Response.json({ id: "mock-staging-response", model, status: "completed", error: null, incomplete_details: null,
        citations: ["https://x.com/ALIce/status/12345"], usage: { cost_in_usd_ticks: 1 }, output: [
          { type: "x_search_call", id: "mock-search", status: "completed" }, { type: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: JSON.stringify({ handle: "alice", mbti: "ENFP", xUserId: "123" }), annotations: [] }] }] });
    } });
    const never = async () => { throw Error("Explicit handler persistence required"); };
    const execution = dispatch => ({ attemptId: f.request.attemptId, dispatch, beforeDispatch: never, identityVerified: never, recordOutcome: never, assessmentPersisted: never,
      recordReceipt: value => f.repository.recordReceipt(f.request.attemptId, bytes(value)).then(() => {}) });
    const verified = await dispatch("x-identity", async d => {
      const result = await resolver.resolve("alice", execution(d)); await f.repository.recordIdentity(f.request.attemptId, bytes(result)); d.assertCurrent("x-identity"); return result;
    });
    const saved = await dispatch("grok", async d => {
      const result = await provider.assess("alice", verified, execution(d)); assert.equal("kind" in result, false);
      const resultSaved = await f.repository.acceptAssessment(f.request.attemptId, bytes(assessment("alice", { provenance: "grok", model,
        providerResponseId: result.providerResponseId, sourceUrls: result.sourceUrls, mbti: result.mbti, xIdentity: verified })));
      d.assertCurrent("grok"); return resultSaved;
    });
    assert.equal(saved.mbti, "ENFP"); assert.equal(saved.xIdentity.username, "ALIce"); assert.equal(xCalls, 1); assert.equal(grokCalls, 1);
    await f.restart(); assert.deepEqual(await f.controller.reuse(await f.intent()), saved); assert.equal(grokCalls, 1);
  });
});
