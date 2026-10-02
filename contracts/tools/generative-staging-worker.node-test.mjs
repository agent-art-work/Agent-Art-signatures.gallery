import assert from "node:assert/strict";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import { Client } from "pg";
import { stagingAssessmentFixture } from "./fixtures/generative-staging-assessment.mjs";
import { disposablePostgres } from "../../src/openMint/persistence/fixtures/postgres.ts";
import { createStagingAssessmentWorker } from "./generative-staging-worker.mjs";
import { createGuardedStagingWorker, PostgresAssessmentWorker } from "../../src/openMint/persistence/assessmentWorker.ts";
import { XApiIdentityResolver } from "../../src/openMint/xIdentity.ts";
import { GrokAssessmentProvider } from "../../src/openMint/grok.ts";
import { stagingReviewFixture } from "../../src/openMint/staging/fixtures/stagingReview.ts";
import { createStagingAssessmentController } from "./generative-staging-assessment.mjs";
import { admissionDigest } from "../../src/openMint/staging/admission.ts";

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

test("worker checkpoint reports early terminal completion instead of hanging", async () => {
  await assert.rejects(expectCheckpoint(new Promise(() => {}), Promise.resolve({ kind: "terminal", outcome: { kind: "blocked-before-dispatch" } }), "worker"),
    /completed before its checkpoint.*blocked-before-dispatch/);
});
test("worker checkpoint surfaces early refusal instead of hanging", async () => {
  const cause = Error("mock pre-dispatch refusal");
  await assert.rejects(expectCheckpoint(new Promise(() => {}), Promise.reject(cause), "worker"), error => error.cause === cause);
});
test("worker checkpoint bounds an unreachable mocked callback", async () => {
  await assert.rejects(expectCheckpoint(new Promise(() => {}), new Promise(() => {}), "worker", 5), /checkpoint timed out/);
});
test("worker close has a visible bound if settlement regresses", async () => {
  await assert.rejects(settleWithin(new Promise(() => {}), "worker drain", 5), TestSettlementTimeout);
});
test("worker settlement preserves the original rejection", async () => {
  const cause = Error("mock drain rejection");
  await assert.rejects(settleWithin(Promise.reject(cause), "worker drain"), error => error === cause);
});

describe("future staging worker developed locally: real disposable SQL, mocked X/Grok and synthetic Sepolia", { skip: process.env.OPEN_MINT_TEST_POSTGRES !== "1" }, () => {
  let cluster, admin, f; const workers = [];
  const settle = async (operation, label) => {
    try { return await settleWithin(operation, label); }
    catch (error) {
      if (error instanceof TestSettlementTimeout) {
        for (const worker of workers) worker.halt(); f?.controller.halt();
        // Query promises still reject; quiet only idle socket error events
        // after this already-fatal test timeout, preserving its diagnostic.
        for (const client of [admin, f?.db, f?.runtime].filter(Boolean)) client.on("error", () => {});
        // Never touch any active database: this suite owns this private cluster.
        try { cluster?.stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], label); }
      }
      throw error;
    }
  };
  const close = worker => settle(worker.close(), "staging worker close");
  before(async () => { cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); });
  after(async () => { try { await settle(admin?.end(), "worker administrator close"); } finally { cluster?.stop(); } });
  beforeEach(async () => { f = await stagingAssessmentFixture(cluster, admin, { claimed: false }); });
  afterEach(async () => {
    const failures = [], owned = workers.splice(0); for (const worker of owned) worker.halt(); f?.controller.halt();
    for (const worker of owned) { try { await close(worker); } catch (error) { failures.push(error); } }
    try { await settle(f?.close(), "worker fixture close"); } catch (error) { failures.push(error); }
    finally { f = undefined; }
    if (failures.length) throw new AggregateError(failures, "Staging worker teardown failed");
  });
  const state = async () => (await f.db.query(`SELECT j.state AS job,a.state AS attempt,
    (SELECT count(*)::int FROM open_mint.provider_receipts) AS receipts,
    (SELECT count(*)::int FROM open_mint.assessments) AS accepted,
    (SELECT count(*)::int FROM open_mint.budget_reservations) AS reservations
    FROM open_mint.jobs j JOIN open_mint.assessment_attempts a USING(namespace_id,attempt_id)`)).rows[0];
  function setup(overrides = {}, input = f.input) {
    const counts = { x: 0, grok: 0, refresh: 0 }, hooks = {};
    const model = input.assessmentPolicy.model;
    const dependencies = {
      identityResolver: new XApiIdentityResolver({ bearerToken: "offline-placeholder", fetch: async (...args) => {
        counts.x++; assert.deepEqual(await f.fences(), ["x-identity"]);
        return hooks.x ? hooks.x(...args) : Response.json({ data: { id: "123", username: "ALIce" } });
      } }),
      provider: new GrokAssessmentProvider({ apiKey: "offline-placeholder", model, fetch: async (...args) => {
        counts.grok++; assert.deepEqual(await f.fences(), ["grok", "x-identity"]);
        const response = { id: "mock-worker-response", model, status: "completed", error: null, incomplete_details: null,
          citations: ["https://x.com/ALIce/status/12345"], usage: { cost_in_usd_ticks: 1 }, output: [
            { type: "x_search_call", id: "mock-search", status: "completed" }, { type: "message", role: "assistant", status: "completed",
              content: [{ type: "output_text", text: JSON.stringify({ handle: "alice", mbti: "ENFP", xUserId: "123" }), annotations: [] }] }] };
        return hooks.grok ? hooks.grok(response, ...args) : Response.json(response);
      } }),
      refreshEligibility: async (_request, signal) => { counts.refresh++; signal.throwIfAborted(); await hooks.refresh?.(); return f.witness(); },
      ...overrides,
    };
    const worker = createStagingAssessmentWorker(input, dependencies); workers.push(worker);
    return { worker, counts, hooks, dependencies };
  }
  function timedInput(timing = { jobTimeoutMs: 10000, xCompletionMs: 2500, grokCompletionMs: 3500 }) {
    const config = JSON.parse(f.input.operatingJson);
    config.settings.rpc.timeoutMs = 1000; config.settings.hosting.requestTimeoutMs = 1000;
    const policy = { ...f.input.assessmentPolicy, schema: "sg-readiness-assessment-policy-v2", timing };
    config.settings.assessment.profileSha256 = admissionDigest(policy);
    const input = { ...f.input, assessmentPolicy: policy, operatingJson: JSON.stringify(config) };
    const candidate = createStagingAssessmentController(input), signed = stagingReviewFixture(candidate.scope); candidate.halt();
    return { input: { ...input, reviewSource: signed.source }, signed };
  }
  test("v2 real clients complete both slow paid legs beyond the HTTP/RPC budget and restart without re-spending", async () => {
    const { input } = timedInput(), h = setup({}, input);
    h.hooks.x = async () => { await new Promise(r => setTimeout(r, 1300)); return Response.json({ data: { id: "123", username: "ALIce" } }); };
    h.hooks.grok = async response => { await new Promise(r => setTimeout(r, 1300)); return Response.json(response); };
    const result = await h.worker.run(await f.intent());
    assert.equal(result.kind, "accepted"); assert.deepEqual(h.counts, { x: 1, grok: 1, refresh: 2 });
    assert.deepEqual(await state(), { job: "complete", attempt: "accepted", receipts: 2, accepted: 1, reservations: 1 });
    await close(h.worker); await f.restart(); const next = setup({ provider: undefined, identityResolver: undefined, refreshEligibility: undefined }, timedInput().input);
    assert.deepEqual(await next.worker.run(await f.intent()), { ...result, reused: true }); assert.equal(next.counts.grok, 0);
  });
  test("v1 signed review and unhashed timing edits cannot authorize v2 work", async () => {
    const { input } = timedInput();
    assert.throws(() => createStagingAssessmentWorker({ ...input, assessmentPolicy: { ...input.assessmentPolicy,
      timing: { ...input.assessmentPolicy.timing, jobTimeoutMs: 11000 } } }, {}));
    const h = setup({}, { ...input, reviewSource: f.input.reviewSource });
    await assert.rejects(h.worker.run(await f.intent())); assert.equal((await state()).job, "queued");
    assert.deepEqual(h.counts, { x: 0, grok: 0, refresh: 0 }); assert.deepEqual(await f.fences(), []);
  });
  test("v2 completion expiry quarantines a hung Grok call, preserves fences, and cannot accept its late response", async () => {
    const h = setup({}, timedInput({ jobTimeoutMs: 10000, xCompletionMs: 2000, grokCompletionMs: 250 }).input);
    let release; const held = new Promise(r => release = r);
    h.hooks.grok = async response => { await held; return Response.json(response); };
    try { const result = await h.worker.run(await f.intent()); assert.deepEqual(result, { kind: "terminal", outcome: { kind: "uncertain", phase: "grok" } }); }
    finally { release(); }
    await new Promise(r => setImmediate(r)); assert.equal((await state()).accepted, 0);
    assert.deepEqual(await f.fences(), ["grok", "x-identity"]); assert.equal((await state()).reservations, 1);
    await close(h.worker); await f.restart(); const next = setup({}, timedInput().input);
    await assert.rejects(next.worker.run(await f.intent())); assert.equal(next.counts.x, 0);
  });
  for (const reason of ["review", "cancel", "shutdown"]) test(`v2 in-flight ${reason} never accepts late Grok success or permits replay`, async () => {
    const { input, signed } = timedInput(), h = setup({}, input), stop = new AbortController(); let entered, release;
    const ready = new Promise(r => entered = r), held = new Promise(r => release = r);
    h.hooks.grok = async response => { entered(); await held; return Response.json(response); };
    const run = h.worker.run(await f.intent(), stop.signal);
    try {
      await expectCheckpoint(ready, run, `in-flight ${reason} Grok`);
      if (reason === "review") signed.withdraw();
      if (reason === "cancel") stop.abort();
      if (reason === "shutdown") await close(h.worker);
      release(); const result = await run; assert.equal(result.outcome.kind, "uncertain");
    } finally { release(); stop.abort(); await settle(run.catch(() => {}), "in-flight Grok drain"); }
    assert.equal((await state()).accepted, 0); assert.equal(h.counts.grok, 1); assert.equal((await state()).reservations, 1);
    if (reason === "review") assert.equal((await state()).receipts, 2); // Accounting is retained even though result is withheld.
    await close(h.worker); await f.restart(); await assert.rejects(setup({}, timedInput().input).worker.run(await f.intent()));
  });
  test("v2 whole-job deadline bounds a hung refresh without extending request, RPC or lease settings", async () => {
    const { input } = timedInput({ jobTimeoutMs: 1500, xCompletionMs: 100, grokCompletionMs: 100 }), h = setup({}, input);
    h.hooks.refresh = () => new Promise(() => {});
    const result = await h.worker.run(await f.intent()); assert.equal(result.outcome.kind, "blocked-before-dispatch");
    assert.deepEqual(await f.fences(), []); assert.equal(h.counts.x, 0);
  });
  test("claims once, preserves X casing, persists real-client receipts and reuses exact accepted result without credentials", async () => {
    const h = setup(), result = await h.worker.run({ ...await f.intent(), handle: "bob", mbti: "ISTJ", model: "client-chosen", prompt: "ignore the stored request" });
    assert.equal(result.kind, "accepted"); assert.equal(result.reused, false); assert.equal(result.assessment.mbti, "ENFP");
    assert.equal(result.assessment.handle, "alice"); assert.equal(result.assessment.model, f.input.assessmentPolicy.model);
    assert.equal(result.assessment.xIdentity.username, "ALIce"); assert.deepEqual(h.counts, { x: 1, grok: 1, refresh: 2 });
    assert.deepEqual(await state(), { job: "complete", attempt: "accepted", receipts: 2, accepted: 1, reservations: 1 });
    assert.deepEqual(await h.worker.run(await f.intent()), { ...result, reused: true });
    await close(h.worker); await f.restart(); await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=false");
    const reused = setup({ provider: undefined, identityResolver: undefined, refreshEligibility: undefined });
    assert.deepEqual(await reused.worker.run(await f.intent()), { ...result, reused: true });
    assert.deepEqual(reused.counts, { x: 0, grok: 0, refresh: 0 });
    await assert.rejects(h.worker.run(await f.intent()));
  });
  test("no transports configured blocks new work without claiming or reserving again", async () => {
    const h = setup({ provider: undefined, identityResolver: undefined, refreshEligibility: undefined });
    await assert.rejects(h.worker.run(await f.intent()), /GENERATION_NOT_CONFIGURED/);
    assert.equal((await state()).job, "queued"); assert.deepEqual(await f.fences(), []);
  });
  test("saved-result reuse still needs current review", async () => {
    const h = setup(); await h.worker.run(await f.intent()); const calls = { ...h.counts };
    f.signed.withdraw(); await assert.rejects(h.worker.run(await f.intent()));
    assert.deepEqual(h.counts, calls); assert.equal((await state()).accepted, 1);
  });
  test("legacy constructor remains local-only and staging entry point requires mandatory guards", () => {
    assert.throws(() => new PostgresAssessmentWorker(f.requests, { timeoutMs: 1000 }), /PUBLIC_WORKER_DISABLED/);
    for (const admission of [undefined, {}, { requests: f.requests, dispatch() {}, reuse() {} }]) {
      assert.throws(() => createGuardedStagingWorker(f.requests, { timeoutMs: 1000, admission }), /GUARDS_REQUIRED/);
    }
    const worker = setup().worker; for (const key of ["start", "issue", "submit", "activate", "sign", "requests"]) assert.equal(key in worker, false);
  });
  test("refuses malformed, partial, mismatched and getter-selected dependencies", () => {
    for (const value of [null, [], { extra: true }, { provider: {} }, { provider: { model: "grok-other", provenance: "grok" }, identityResolver: {}, refreshEligibility() {} },
      { provider: { model: f.input.assessmentPolicy.model, provenance: "development-fixture" }, identityResolver: {}, refreshEligibility() {} },
      { provider: { model: f.input.assessmentPolicy.model, provenance: "grok" }, identityResolver: { provenance: "development-fixture" }, refreshEligibility() {} },
      { provider: { model: f.input.assessmentPolicy.model, provenance: "grok" }, identityResolver: { provenance: "x-api" }, refreshEligibility: true }]) {
      assert.throws(() => createStagingAssessmentWorker(f.input, value), /worker unavailable/);
    }
    let got = false; const deps = { get provider() { got = true; return {}; } };
    assert.throws(() => createStagingAssessmentWorker(f.input, deps)); assert.equal(got, false);
    assert.throws(() => createStagingAssessmentWorker({ ...f.input, extra: true }, {}));
    assert.throws(() => createStagingAssessmentWorker(f.input, { provider: { model: f.input.assessmentPolicy.model, provenance: "grok" },
      identityResolver: { provenance: "x-api" }, refreshEligibility() {} }));
  });
  for (const scenario of ["review", "csrf", "generation", "grants", "post-claim review", "cancelled"]) test(`refuses ${scenario} before claim COMMIT`, async () => {
    const h = setup(), input = await f.intent(), signal = new AbortController();
    if (scenario === "review") f.signed.withdraw();
    if (scenario === "csrf") input.csrf = "z".repeat(43);
    if (scenario === "generation") await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=false");
    if (scenario === "grants") await f.db.query("GRANT DELETE ON open_mint.requests TO sg_browser");
    if (scenario === "post-claim review") f.faults.afterQuery = sql => { if (sql.startsWith("UPDATE open_mint.jobs j SET state = 'running'")) f.signed.withdraw(); };
    if (scenario === "cancelled") signal.abort();
    await assert.rejects(h.worker.run(input, signal.signal)); f.faults.afterQuery = undefined;
    assert.equal((await state()).job, "queued"); assert.deepEqual(await f.fences(), []); assert.equal(h.counts.x, 0);
  });
  for (const scenario of ["x-invalid", "grok-invalid", "abstention", "x-http", "grok-transport"]) test(`persists ${scenario} without fabrication or retries`, async () => {
    const h = setup();
    if (scenario === "x-invalid") h.hooks.x = () => Response.json({ data: { id: "123", username: "bob" } });
    if (scenario === "x-http") h.hooks.x = () => Response.json({}, { status: 402 });
    if (scenario === "grok-transport") h.hooks.grok = () => { throw Error("mock transport failure"); };
    if (["grok-invalid", "abstention"].includes(scenario)) h.hooks.grok = r => {
      r.output[1].content[0].text = JSON.stringify(scenario === "abstention"
        ? { handle: "alice", kind: "abstained", mbti: null, reason: "insufficient-evidence", xUserId: "123" }
        : { handle: "alice", mbti: "XXXX", xUserId: "123" }); return Response.json(r);
    };
    const result = await h.worker.run(await f.intent()); assert.equal(result.kind, "terminal");
    assert.equal(result.outcome.kind, scenario === "abstention" ? "abstained" : scenario.endsWith("invalid") ? "invalid" : "uncertain");
    assert.equal((await state()).accepted, 0); assert.equal((await state()).reservations, 1);
    const calls = { ...h.counts }; await assert.rejects(h.worker.run(await f.intent())); assert.deepEqual(h.counts, calls);
    await close(h.worker); await f.restart(); const next = setup(); await assert.rejects(next.worker.run(await f.intent())); assert.equal(next.counts.x, 0);
  });
  for (const scenario of ["review", "generation", "wallet"]) test(`checks ${scenario} again between X and Grok`, async () => {
    const h = setup(); h.hooks.refresh = async () => {
      if (h.counts.refresh !== 2) return;
      if (scenario === "review") f.signed.withdraw();
      if (scenario === "generation") await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=false");
      if (scenario === "wallet") await f.sessions.challenge(f.session.id, f.wallet.address);
    };
    const result = await h.worker.run(await f.intent()); assert.equal(result.kind, "terminal"); assert.equal(result.outcome.kind, "uncertain");
    assert.equal(h.counts.x, 1); assert.equal(h.counts.grok, 0); assert.deepEqual(await f.fences(), ["x-identity"]);
  });
  test("post-fence review withdrawal uses durable phase even though callback never entered", async () => {
    const h = setup(); let fenced = false;
    f.faults.afterQuery = sql => { if (sql.startsWith("INSERT INTO open_mint.dispatch_fences")) fenced = true; if (fenced && sql === "COMMIT") f.signed.withdraw(); };
    const result = await h.worker.run(await f.intent()); f.faults.afterQuery = undefined;
    assert.deepEqual(result, { kind: "terminal", outcome: { kind: "uncertain", phase: "x-identity" } });
    assert.equal(h.counts.x, 0); assert.deepEqual(await f.fences(), ["x-identity"]);
  });
  for (const kind of ["claim", "receipt", "accepted"]) test(`lost ${kind} COMMIT preserves ownership and cannot cause paid replay`, async () => {
    const h = setup(); let armed = false;
    f.faults.afterQuery = sql => {
      if (sql.startsWith(kind === "claim" ? "UPDATE open_mint.jobs j SET state = 'running'" : kind === "receipt" ? "INSERT INTO open_mint.provider_receipts" : "INSERT INTO open_mint.assessments")) armed = true;
      if (armed && sql === "COMMIT") throw Error("Injected lost commit acknowledgement");
    };
    await assert.rejects(h.worker.run(await f.intent())); f.faults.afterQuery = undefined;
    const previousCalls = { ...h.counts }; await close(h.worker); await f.restart(); const next = setup();
    if (kind === "accepted") assert.equal((await next.worker.run(await f.intent())).reused, true);
    else await assert.rejects(next.worker.run(await f.intent()));
    assert.equal(next.counts.x, 0); assert.deepEqual(h.counts, previousCalls); assert.equal((await state()).reservations, 1);
  });
  test("rejects concurrent runs; cancellation drains owned work and never accepts a late response", async () => {
    const h = setup(), signal = new AbortController(), input = await f.intent(); let entered, release;
    const inFlight = new Promise(r => entered = r), hold = new Promise(r => release = r);
    h.hooks.x = async () => { entered(); await hold; return Response.json({ data: { id: "123", username: "ALIce" } }); };
    const run = h.worker.run(input, signal.signal);
    try {
      await expectCheckpoint(inFlight, run, "concurrent worker X");
      await assert.rejects(h.worker.run(input), /already running/); signal.abort();
      const result = await run; assert.equal(result.outcome.kind, "uncertain");
    } finally { release(); signal.abort(); await settle(run.catch(() => {}), "concurrent X drain"); }
    await Promise.resolve();
    assert.equal((await state()).accepted, 0); assert.equal(h.counts.grok, 0); assert.equal(h.counts.x, 1);
    await close(h.worker); await assert.rejects(h.worker.run(input));
  });
  test("whole-worker deadline bounds a hung eligibility refresh before dispatch", async () => {
    const config = JSON.parse(f.input.operatingJson); config.settings.rpc.timeoutMs = 1000; config.settings.hosting.requestTimeoutMs = 1000; config.settings.hosting.drainTimeoutMs = 1000;
    const input = { ...f.input, operatingJson: JSON.stringify(config) }, candidate = createStagingAssessmentController(input);
    input.reviewSource = stagingReviewFixture(candidate.scope).source; candidate.halt();
    const h = setup({}, input); h.hooks.refresh = () => new Promise(() => {});
    const result = await h.worker.run(await f.intent()); assert.equal(result.outcome.kind, "blocked-before-dispatch");
    assert.deepEqual(await f.fences(), []); assert.equal(h.counts.x, 0);
  });
  test("close cancels and drains a just-started run before it owns a job", async () => {
    const h = setup(), pending = h.worker.run(await f.intent());
    await Promise.all([close(h.worker), assert.rejects(settle(pending, "just-started worker drain"), /cancelled/)]);
    assert.equal((await state()).job, "queued"); assert.equal(h.counts.x, 0); await close(h.worker);
  });
  test("close cancels an active provider call and waits for durable uncertainty", async () => {
    const h = setup(); let entered;
    const ready = new Promise(r => entered = r);
    h.hooks.x = async () => { entered(); return new Promise(() => {}); };
    const pending = h.worker.run(await f.intent());
    try { await expectCheckpoint(ready, pending, "closing active X provider"); }
    finally { await close(h.worker); }
    assert.deepEqual(await settle(pending, "active X provider drain"), { kind: "terminal", outcome: { kind: "uncertain", phase: "x-identity" } });
    assert.equal((await state()).job, "complete"); assert.equal(h.counts.grok, 0);
  });
});
