import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { test, describe, before, after, beforeEach, afterEach, mock } from "node:test";
import { performance } from "node:perf_hooks";
import { admissionDigest } from "../../src/openMint/staging/admission.ts";
import { Client } from "pg";
import { decodeFunctionData } from "viem";
import { controlledAssessmentTiming, stagingAssessmentFixture } from "./fixtures/generative-staging-assessment.mjs";
import { disposablePostgres } from "../../src/openMint/persistence/fixtures/postgres.ts";
import { createStagingRuntime } from "./generative-staging-runtime.mjs";
import { createStagingMintController } from "./generative-staging-mint.mjs";
import { createStagingRuntimeApiServer } from "./generative-staging-http.mjs";
import { stagingReviewFixture } from "../../src/openMint/staging/fixtures/stagingReview.ts";
import { identity, receipt } from "../../src/openMint/persistence/fixtures/data.ts";
import { GENERATIVE_MINT_ABI } from "../../src/openMint/generativeAuthorization.ts";

// Diagnostic bounds must remain real even inside a targeted virtual-clock case.
const diagnosticSetTimeout = globalThis.setTimeout;
const diagnosticClearTimeout = globalThis.clearTimeout;
async function expectCheckpoint(checkpoint, operation, label, timeoutMs = 20000) {
  let timer;
  try {
    await Promise.race([checkpoint, operation.then(
      result => { throw Error(`${label} completed before its checkpoint: ${JSON.stringify(result)}`); },
      cause => { throw Error(`${label} rejected before its checkpoint`, { cause }); },
    ), new Promise((_, reject) => { timer = diagnosticSetTimeout(() => reject(Error(`${label} checkpoint timed out`)), timeoutMs); })]);
  } finally { diagnosticClearTimeout(timer); }
}
class TestSettlementTimeout extends Error {}
async function settleWithin(operation, label, timeoutMs = 20000) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = diagnosticSetTimeout(() => reject(new TestSettlementTimeout(`${label} settlement timed out`)), timeoutMs);
    })]);
  } finally { diagnosticClearTimeout(timer); }
}
function readHttpResponse(response) {
  return new Promise((resolve, reject) => {
    let text = "";
    response.on("data", chunk => text += chunk);
    response.on("error", reject);
    response.on("aborted", () => reject(Error("Runtime test HTTP response aborted")));
    response.on("end", () => {
      try { resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : undefined }); }
      catch (error) { reject(error); }
    });
  });
}
function closeHttpListener(listener) {
  return new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
}
test("runtime checkpoint reports early completion instead of waiting for an unreachable provider", async () => {
  await assert.rejects(expectCheckpoint(new Promise(() => {}), Promise.resolve({ status: "failed" }), "runtime provider"),
    /completed before its checkpoint.*failed/);
});
test("runtime checkpoint surfaces early refusal with its original cause", async () => {
  const cause = Error("mock runtime admission refusal");
  await assert.rejects(expectCheckpoint(new Promise(() => {}), Promise.reject(cause), "runtime provider"), error => error.cause === cause);
});
test("runtime checkpoint bounds an unreachable held provider", async () => {
  await assert.rejects(expectCheckpoint(new Promise(() => {}), new Promise(() => {}), "runtime provider", 5), /checkpoint timed out/);
});
test("runtime close and drain have a visible test-only settlement bound", async () => {
  await assert.rejects(settleWithin(new Promise(() => {}), "runtime drain", 5), TestSettlementTimeout);
});
test("runtime settlement preserves the original rejection", async () => {
  const cause = Error("mock runtime drain rejection");
  await assert.rejects(settleWithin(Promise.reject(cause), "runtime drain"), error => error === cause);
});
test("runtime diagnostic bounds remain real while the targeted virtual clock is frozen", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  try {
    await assert.rejects(expectCheckpoint(new Promise(() => {}), new Promise(() => {}), "frozen runtime", 5), /checkpoint timed out/);
    await assert.rejects(settleWithin(new Promise(() => {}), "frozen runtime", 5), TestSettlementTimeout);
  } finally { t.mock.timers.reset(); }
});
test("runtime response helper preserves JSON, status, headers and an empty body", async () => {
  const headers = { "content-type": "application/json" };
  const response = Object.assign(new EventEmitter(), { statusCode: 202, headers });
  const pending = readHttpResponse(response);
  response.emit("data", '{"accepted":'); response.emit("data", 'true}'); response.emit("end");
  assert.deepEqual(await pending, { status: 202, headers, body: { accepted: true } });
  const empty = Object.assign(new EventEmitter(), { statusCode: 204, headers: {} });
  const emptyPending = readHttpResponse(empty); empty.emit("end");
  assert.deepEqual(await emptyPending, { status: 204, headers: {}, body: undefined });
});
test("runtime response helper rejects malformed JSON without throwing from an event callback", async () => {
  const response = new EventEmitter(), pending = readHttpResponse(response);
  const rejected = assert.rejects(pending, SyntaxError);
  response.emit("data", "{broken"); response.emit("end"); await rejected;
});
test("runtime response helper preserves stream errors and diagnoses an aborted response", async () => {
  const response = new EventEmitter(), cause = Error("mock response stream failure");
  const rejected = assert.rejects(readHttpResponse(response), error => error === cause);
  response.emit("error", cause); await rejected;
  const aborted = new EventEmitter(), abortedResult = assert.rejects(readHttpResponse(aborted), /HTTP response aborted/);
  aborted.emit("aborted"); await abortedResult;
});
test("runtime listener close preserves callback errors instead of resolving them", async () => {
  const cause = Error("mock listener close failure");
  await assert.rejects(closeHttpListener({ close(callback) { callback(cause); } }), error => error === cause);
  await closeHttpListener({ close(callback) { callback(); } });
});

describe("private future-staging runtime/HTTP: disposable PG, synthetic RPC, NO paid calls/broadcast", { skip: process.env.OPEN_MINT_TEST_POSTGRES !== "1" }, () => {
  let cluster, admin, f, runtime, review, deps, input, calls, hooks, server;
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
        for (const release of releases) release(); runtime?.halt(); f?.controller.halt(); server?.closeAllConnections();
        // The timeout has already failed the test. Preserve query rejections,
        // but prevent idle socket shutdown errors from masking its diagnostic.
        for (const client of [admin, f?.db, f?.runtime].filter(Boolean)) client.on("error", () => {});
        // This suite creates and owns this cluster, never an active environment.
        try { cluster?.stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], label); }
      }
      throw error;
    }
  };
  const closeRuntime = () => settle(runtime?.close(), "staging runtime close");
  const idleRuntime = () => settle(runtime?.idle(), "staging runtime preparation drain");
  before(async () => { cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); });
  after(async () => { try { await settle(admin?.end(), "runtime administrator close"); } finally { cluster?.stop(); } });
  beforeEach(async () => {
    f = await stagingAssessmentFixture(cluster, admin, { admitted: false }); calls = { x: 0, grok: 0, sign: 0 }; hooks = {};
    for (const [i, h] of f.active.headers.entries()) h.timestamp = `0x${BigInt(Math.floor(Date.now() / 1000) - 20 + i * 2).toString(16)}`;
    input = { ...f.input, sources: f.eligibilitySources.map((r, i) => ({ ...r, id: f.input.sources[i].id, operatorReference: f.input.sources[i].operatorReference,
      async request(method, params, signal) {
        if (hooks.rpc) { const value = await hooks.rpc(method, params, signal, i); if (value !== undefined) return value; }
        return r.request(method, params, signal);
      } })) };
    const candidate = createStagingMintController(input);
    review = stagingReviewFixture(candidate.scope, { operations: ["reuse", "assessment-x", "assessment-grok", "sign", "wallet-submit"] }); candidate.halt();
    input.reviewSource = review.source;
    deps = { sessions: f.sessions, signer: { address: f.active.accounts.authorizer.address, async signTypedData(data, signal) {
      calls.sign++; signal.throwIfAborted(); return hooks.sign ? hooks.sign(data, signal) : f.active.accounts.authorizer.signTypedData(data);
    } }, identityResolver: { provenance: "x-api", async resolve(handle, execution) {
      calls.x++; (execution.dispatch.beginDispatch ?? execution.dispatch.assertCurrent)("x-identity");
      await hooks.x?.(execution); await execution.recordReceipt(receipt("x-identity", "1")); execution.dispatch.assertCompletion?.("x-identity");
      return { ...identity(handle), username: "ALIce", provenance: "x-api" };
    } }, provider: { provenance: "grok", model: f.input.assessmentPolicy.model, async assess(handle, snapshot, execution) {
      calls.grok++; (execution.dispatch.beginDispatch ?? execution.dispatch.assertCurrent)("grok");
      await hooks.grok?.(execution); await execution.recordReceipt(receipt("grok", "1")); execution.dispatch.assertCompletion?.("grok");
      return { handle, mbti: "ENFP", model: f.input.assessmentPolicy.model, providerResponseId: "offline-runtime", sourceUrls: ["https://x.com/ALIce"], xUserId: snapshot.userId };
    } } };
    runtime = createStagingRuntime(input, deps);
    await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=true");
  });
  afterEach(async () => {
    for (const release of releases) release();
    if (f) f.faults.afterQuery = undefined; runtime?.halt(); f?.controller.halt();
    const failures = [];
    if (server) {
      server.closeAllConnections();
      try { await settle(closeHttpListener(server), "runtime HTTP listener close"); }
      catch (error) { failures.push(error); }
      server = undefined;
    }
    for (const cleanup of [closeRuntime, () => settle(f?.close(), "runtime fixture close")]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    f = undefined; runtime = undefined;
    if (failures.length) throw new AggregateError(failures, "Staging runtime teardown failed");
  });
  const auth = () => ({ cookie: f.sessions.cookie(f.session), origin: f.settings.origin, csrf: f.session.csrf });
  async function prepared() { const r = await runtime.create("Alice", auth()); await idleRuntime();
    assert.equal((await runtime.status(r.code, auth().cookie)).status, "ready"); return r; }
  const counts = async () => (await f.db.query(`SELECT (SELECT count(*)::int FROM open_mint.requests) AS requests,
    (SELECT count(*)::int FROM open_mint.assessment_attempts) AS attempts,(SELECT count(*)::int FROM open_mint.wallet_mint_dispatches) AS dispatches,
    (SELECT count(*)::int FROM open_mint.generative_authorizations) AS authorizations`)).rows[0];
  async function start() {
    server = createStagingRuntimeApiServer(runtime);
    await settle(new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); }), "runtime HTTP listener start");
  }
  async function http(path, body, headers = {}, method = body === undefined ? "GET" : "POST") {
    let req;
    const pending = new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
      req = httpRequest({ host: "127.0.0.1", port: server.address().port, path, method,
        headers: { host: "staging.signatures.gallery", "x-forwarded-proto": "https", cookie: auth().cookie, origin: auth().origin, "x-csrf-token": auth().csrf,
          ...(bytes === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(bytes) }), ...headers } }, res => {
        readHttpResponse(res).then(resolve, reject);
      }); req.on("error", reject); req.end(bytes);
    });
    try { return await settle(pending, `runtime HTTP ${method} ${path}`); }
    catch (error) { req?.destroy(); throw error; }
  }

  test("explicit create -> accepted assessment -> signed exact plan -> single durable permit -> report; polling never reveals", async () => {
    for (const site of [{}, { page() {}, read() {}, status: "browser-value" }, { page() {}, read() {}, status() {}, sync() {} }]) {
      assert.throws(() => createStagingRuntimeApiServer(runtime, site), /Invalid site composition/);
    }
    await runtime.check(); runtime.assertHealthy();
    await start(); const session = await http("/api/session"); assert.equal(session.body.chainName, "Ethereum Sepolia");
    const created = await http("/api/assessments", { handle: "Alice" }); assert.equal(created.status, 202);
    const code = created.body.code; await idleRuntime();
    for (let i = 0; i < 3; i++) {
      const s = await http(`/api/assessments/${code}`); assert.equal(s.body.status, "ready", JSON.stringify({ s: s.body, calls, terminals: (await f.db.query("SELECT kind,reason,phase FROM open_mint.assessment_terminals")).rows }));
      assert.equal(s.body.canMint, true); assert.doesNotMatch(JSON.stringify(s.body), /ENFP|assessmentDigest|providerResponse|ALIce|typedData|permit|signature"/);
    }
    const net = await http(`/api/wallet/context?address=${f.wallet.address}`); assert.equal(net.body.nonce, "0x0"); assert.equal(net.body.chainId, "0xaa36a7");
    const plan = await http("/api/mints/authorize", { code, consent: true }); assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.equal(plan.body.transaction.nonce, "0x0"); assert.equal(plan.body.transaction.value, "0x0");
    assert.deepEqual(decodeFunctionData({ abi: GENERATIVE_MINT_ABI, data: plan.body.transaction.data }).args.slice(0, 2), ["ALIce", "ENFP"]);
    const sent = await http("/api/mints/begin", { code, consent: true }); assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual(sent.body.transaction, plan.body.transaction); assert.match(sent.body.permit, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await http("/api/mints/begin", { code, consent: true })).status, 409);
    const hash = `0x${"5".repeat(64)}`;
    assert.equal((await http("/api/mints/report", { code, permit: sent.body.permit, transactionHash: hash })).status, 200);
    const s = await http(`/api/mints/status/${code}`); assert.equal(s.body.state, "pending"); assert.equal(s.body.transactionHash, hash);
    assert.deepEqual(calls, { x: 1, grok: 1, sign: 1 }); assert.equal((await counts()).dispatches, 1);
    assert.ok(f.active.requests.every(r => !/send|sign/i.test(r.method)));
    assert.match(s.headers["cache-control"], /no-store/); assert.match(s.headers["x-robots-tag"], /noindex/);
  });
  test("v2 sends 202 and serves private status while slow assessment outlives the disconnected HTTP request", async t => {
    await closeRuntime();
    // Exercise the exact reviewed 1s/10s budgets at the intended provider
    // checkpoint, not incidental covered PostgreSQL setup on a slow runner.
    const clock = controlledAssessmentTiming(t, f);
    let entered; const inFlight = new Promise(r => entered = r), held = hold();
    try {
      const config = JSON.parse(input.operatingJson);
      config.settings.hosting.requestTimeoutMs = 1000; config.settings.rpc.timeoutMs = 1000;
      const assessmentPolicy = { ...input.assessmentPolicy, schema: "sg-readiness-assessment-policy-v2",
        timing: { jobTimeoutMs: 10000, xCompletionMs: 2000, grokCompletionMs: 4000 } };
      config.settings.assessment.profileSha256 = admissionDigest(assessmentPolicy);
      input = { ...input, operatingJson: JSON.stringify(config), assessmentPolicy };
      const candidate = createStagingMintController(input); review = stagingReviewFixture(candidate.scope,
        { operations: ["reuse", "assessment-x", "assessment-grok", "sign", "wallet-submit"] }); candidate.halt();
      input.reviewSource = review.source; runtime = createStagingRuntime(input, deps);
      hooks.grok = async () => { entered(); await held.promise; };
      await start(); const created = await http("/api/assessments", { handle: "Alice" }, { connection: "close" });
      assert.equal(created.status, 202);
      await expectCheckpoint(inFlight, runtime.idle(), "disconnected HTTP assessment Grok");
      assert.equal(runtime.timeoutMs, 1000); const began = Date.now(); clock.tick(1300);
      assert.equal(Date.now() - began, 1300); assert.ok(Date.now() - began > runtime.timeoutMs);
      const status = await http(`/api/assessments/${created.body.code}`);
      assert.equal(status.status, 200); assert.equal(status.body.status, "preparing");
      assert.equal(status.body.preparationActive, true); assert.doesNotMatch(JSON.stringify(status.body), /ENFP|sourceUrls|assessmentDigest/);
      const blocked = await http("/api/assessments", { handle: "Bob" });
      assert.equal(blocked.status, 503); assert.equal(blocked.body.code, "BUSY");
      held.release(); await idleRuntime();
      assert.equal((await http(`/api/assessments/${created.body.code}`)).body.status, "ready");
      // Assessment completion is not mint consent and must not sign anything.
      assert.equal((await counts()).authorizations, 0);
      assert.deepEqual(calls, { x: 1, grok: 1, sign: 0 });
    } finally {
      held.release();
      try { await idleRuntime(); }
      finally { try { await closeRuntime(); } finally { clock.close(); } }
    }
  });
  test("new secure session, scoped wallet proof and logout are separate from paid/mint intent", async () => {
    await start(); const s = await http("/api/session", undefined, { cookie: "" });
    assert.equal(s.status, 200); assert.match(s.headers["set-cookie"][0], /^__Host-sg-staging=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=86400; Secure$/);
    assert.equal(s.body.cookie, undefined);
    const headers = { cookie: s.headers["set-cookie"][0], "x-csrf-token": s.body.csrfToken };
    const challenge = await http("/api/wallet/challenge", { address: f.wallet.address }, headers);
    assert.match(challenge.body.message, /Chain ID: 11155111/);
    const verified = await http("/api/wallet/verify", { challengeId: challenge.body.challengeId, signature: await f.wallet.signMessage({ message: challenge.body.message }) }, headers);
    assert.equal(verified.body.walletVerified, true); assert.equal((await counts()).attempts, 0);
    assert.equal((await http("/api/wallet/verify", { challengeId: challenge.body.challengeId, signature: "bad" }, headers)).status, 409);
    const logout = await http("/api/session/logout", {}, headers); assert.equal(logout.status, 200);
    assert.equal(logout.headers["set-cookie"][0], "__Host-sg-staging=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure");
    assert.equal((await http("/api/wallet/context", undefined, headers)).status, 403); assert.deepEqual(calls, { x: 0, grok: 0, sign: 0 });
  });
  test("reload/restart reads never resume work; accepted assessment and exact signed plan survive restart without providers", async () => {
    const r = await prepared(), original = await runtime.authorize(r.code, true, auth()); await closeRuntime();
    runtime = createStagingRuntime(input, { ...deps, provider: undefined, identityResolver: undefined });
    assert.equal((await runtime.status(r.code, auth().cookie)).canMint, true);
    await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=false");
    const repeated = await runtime.authorize(r.code, true, auth()); assert.deepEqual(repeated.transaction, original.transaction);
    const same = await runtime.create("aLiCe", auth()); await idleRuntime(); assert.equal((await runtime.status(same.code, auth().cookie)).status, "ready");
    assert.deepEqual(calls, { x: 1, grok: 1, sign: 1 });
  });
  test("queued saved request remains inert on construction and GET", async () => {
    await f.requests.create({ sessionToken: f.session.id, sessionGeneration: f.session.generation, origin: f.settings.origin, csrf: f.session.csrf,
      recipient: f.wallet.address, handle: "Alice", eligibility: await f.witness() }).then(async r => {
      assert.equal((await runtime.status(r.code, auth().cookie)).status, "failed"); await idleRuntime();
    }); assert.deepEqual(calls, { x: 0, grok: 0, sign: 0 });
  });
  test("all HTTP overrides and unsupported routes fail before effects", async () => {
    await start();
    for (const extra of [{ mbti: "INTJ" }, { nonce: "0x1" }, { model: "fake" }, { eligibility: {} }, { network: {} }, { renderer: "fake" }])
      assert.equal((await http("/api/assessments", { handle: "Alice", ...extra })).status, 400);
    for (const [path, body, headers, method, expected] of [
      ["/api/session", undefined, {}, "PUT", 405], ["/mint", undefined, {}, "GET", 404], ["/api/session?x=1", undefined, {}, "GET", 404],
      ["/api/session", undefined, { host: "evil.test" }, "GET", 421], ["/api/session", undefined, { "x-forwarded-host": "staging.signatures.gallery" }, "GET", 400],
      ["/api/session", undefined, { "x-forwarded-proto": "http" }, "GET", 400],
      ["/api/session", undefined, { cookie: auth().cookie.replace("__Host-sg-staging", "sg_open_session") }, "GET", 200],
      ["/api/wallet/context", undefined, { cookie: auth().cookie.replace("__Host-sg-staging", "sg_open_session") }, "GET", 403],
      ["/api/session", "{}", {}, "GET", 400], ["/api/assessments", "{", {}, "POST", 400],
      ["/api/assessments", {}, { "content-type": "text/plain" }, "POST", 415], ["/api/assessments", {}, { "content-encoding": "gzip" }, "POST", 415],
      ["/api/assessments", " ".repeat(8193), {}, "POST", 413], ["/api/assessments", { handle: "Alice" }, { origin: "https://evil.test" }, "POST", 403],
      ["/api/assessments", { handle: "Alice" }, { "x-csrf-token": "wrong" }, "POST", 403],
    ]) assert.equal((await http(path, body, headers, method)).status, expected, path);
    assert.equal((await counts()).attempts, 0); assert.deepEqual(calls, { x: 0, grok: 0, sign: 0 });
  });
  test("failed provider preserves operator-review outcome; reads cannot dispatch another call", async () => {
    hooks.x = () => { throw Error("secret provider body"); }; const r = await runtime.create("Alice", auth()); await idleRuntime();
    await start(); const status = await http(`/api/assessments/${r.code}`); assert.equal(status.body.status, "failed");
    assert.doesNotMatch(JSON.stringify(status), /secret provider/); await runtime.status(r.code, auth().cookie);
    await runtime.create("Alice", auth()); await idleRuntime(); assert.deepEqual(calls, { x: 1, grok: 0, sign: 0 });
  });
  for (const kind of ["review", "grant", "profile", "generation", "proof", "bad-handle", "wrong-wallet"]) test(`${kind} prevents request admission`, async () => {
    if (kind === "review") review.withdraw();
    if (kind === "grant") await f.db.query(`GRANT DELETE ON open_mint.requests TO "${f.target.runtimeRole}"`);
    if (kind === "profile") {
      await assert.rejects(f.db.query("UPDATE open_mint.request_profiles SET max_evidence_age_ms=max_evidence_age_ms+1"), /immutable/);
      // Simulate privileged corruption only in this disposable database.
      await f.db.query("BEGIN; SET LOCAL session_replication_role=replica; UPDATE open_mint.request_profiles SET max_evidence_age_ms=max_evidence_age_ms+1; COMMIT");
    }
    if (kind === "generation") await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=false");
    if (kind === "proof") await f.sessions.challenge(f.session.id, f.wallet.address);
    if (kind === "wrong-wallet") await f.sessions.logout(f.session.id);
    await assert.rejects(runtime.create(kind === "bad-handle" ? "too-long-of-a-handle" : "Alice", auth()));
    assert.equal((await counts()).requests, 0); assert.deepEqual(calls, { x: 0, grok: 0, sign: 0 });
  });
  test("review withdrawn during request INSERT rolls admission/reservation back atomically", async () => {
    f.faults.afterQuery = sql => { if (sql.startsWith("INSERT INTO open_mint.requests")) review.withdraw(); };
    await assert.rejects(runtime.create("Alice", auth())); f.faults.afterQuery = undefined;
    assert.equal((await counts()).attempts, 0); assert.equal((await counts()).requests, 0); assert.equal(calls.x, 0);
  });
  test("disconnect during request INSERT rolls back before background assessment can start", async () => {
    const abort = new AbortController();
    f.faults.afterQuery = sql => { if (sql.startsWith("INSERT INTO open_mint.requests")) abort.abort(); };
    await assert.rejects(runtime.create("Alice", auth(), abort.signal)); f.faults.afterQuery = undefined;
    assert.equal((await counts()).attempts, 0); assert.equal((await counts()).requests, 0); assert.equal(calls.x, 0);
  });
  test("missing generation operation review rolls new admission back", async () => {
    await closeRuntime(); const candidate = createStagingMintController(f.input);
    review = stagingReviewFixture(candidate.scope, { operations: ["reuse"] }); candidate.halt();
    runtime = createStagingRuntime({ ...input, reviewSource: review.source }, deps);
    await assert.rejects(runtime.create("Alice", auth())); assert.equal((await counts()).attempts, 0); assert.equal(calls.x, 0);
  });
  test("lost request COMMIT quarantines writer; no automatic paid dispatch or retry", async () => {
    let wrote = false; f.faults.afterQuery = sql => { if (sql.startsWith("INSERT INTO open_mint.requests")) wrote = true;
      if (wrote && sql === "COMMIT") throw Error("lost commit"); };
    await assert.rejects(runtime.create("Alice", auth())); f.faults.afterQuery = undefined;
    assert.equal((await counts()).requests, 1); await assert.rejects(runtime.create("Alice", auth())); assert.equal(calls.x, 0);
  });
  test("server nonce disagreement blocks a wallet plan; changing a saved nonce never replaces it", async () => {
    const r = await prepared(); hooks.rpc = (m, p) => m === "eth_getTransactionCount" && p[1] === "pending" ? "0x1" : undefined;
    await assert.rejects(runtime.authorize(r.code, true, auth())); assert.equal((await counts()).dispatches, 0);
    hooks.rpc = undefined; const plan = await runtime.authorize(r.code, true, auth());
    hooks.rpc = m => m === "eth_getTransactionCount" ? "0x1" : undefined;
    await assert.rejects(runtime.begin(r.code, true, auth())); assert.equal(plan.transaction.nonce, "0x0"); assert.equal(calls.sign, 1);
  });
  test("explicit rejection permits only same-transaction resend; report is still allowed after issuance closes", async () => {
    const r = await prepared(), sent = await runtime.begin(r.code, true, auth());
    await start(); assert.equal((await http("/api/mints/reject", { code: r.code, permit: sent.permit })).status, 200);
    const again = await runtime.begin(r.code, true, auth()); assert.deepEqual(again.transaction, sent.transaction);
    await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false");
    await runtime.report(r.code, again.permit, "submitted", `0x${"6".repeat(64)}`, auth());
    assert.equal((await runtime.status(r.code, auth().cookie)).mint.state, "pending"); assert.equal(calls.sign, 1);
  });
  test("consent, another session and extra mint payload fields cannot issue authority", async () => {
    const r = await prepared(); await assert.rejects(runtime.authorize(r.code, false, auth()));
    const other = (await f.sessions.session()).session;
    await assert.rejects(runtime.status(r.code, f.sessions.cookie(other)));
    await start(); for (const route of ["authorize", "begin"])
      assert.equal((await http(`/api/mints/${route}`, { code: r.code, consent: true, transaction: {} })).status, 400);
    assert.equal(calls.sign, 0);
  });
  test("one bounded preparation; cancellation/drain never starts the next paid leg", async () => {
    let entered; const started = new Promise(r => entered = r), held = hold();
    hooks.x = async () => { entered(); await held.promise; };
    const r = await runtime.create("Alice", auth());
    try {
      await expectCheckpoint(started, runtime.idle(), "bounded preparation X");
      const status = await runtime.status(r.code, auth().cookie); assert.equal(status.preparationActive, true);
      await assert.rejects(runtime.create("bob", auth())); const closing = closeRuntime(); held.release(); await closing;
    } finally { held.release(); await closeRuntime(); }
    assert.equal(calls.grok, 0); await assert.rejects(runtime.session(auth().cookie));
  });
  test("malformed composition and ordinary public startup remain closed", () => {
    assert.throws(() => createStagingRuntime(input, { ...deps, refreshEligibility: () => ({}) }));
    assert.throws(() => createStagingRuntime(input, { ...deps, sessions: {} }));
    assert.throws(() => createStagingRuntime(input, { ...deps, signer: { address: f.wallet.address, signTypedData() {} } }));
    assert.throws(() => createStagingRuntime(input, { ...deps, provider: undefined }));
    assert.throws(() => createStagingRuntimeApiServer({ ...runtime }));
    const old = process.env.NODE_ENV; process.env.NODE_ENV = "production";
    try { assert.throws(() => createStagingRuntimeApiServer(runtime)); } finally { if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old; }
  });
  test("reuse-only runtime cannot reserve a new paid attempt without provider adapters", async () => {
    await closeRuntime(); runtime = createStagingRuntime(input, { ...deps, provider: undefined, identityResolver: undefined });
    await assert.rejects(runtime.create("Alice", auth()), /New assessments are unavailable/);
    assert.equal((await counts()).attempts, 0); assert.equal((await counts()).requests, 0);
  });
  test("abort before admission and concurrent operations cannot leave a request or paid attempt", async () => {
    const abort = new AbortController(); abort.abort(); await assert.rejects(runtime.create("Alice", auth(), abort.signal));
    const first = runtime.session(auth().cookie); await assert.rejects(runtime.session(auth().cookie), /Another operation/); await first;
    assert.equal((await counts()).requests, 0);
  });
  test("bodyless private context GET requires a session and never supplies a guessed nonce", async () => {
    await start(); assert.equal((await http("/api/wallet/context")).body.nonce, undefined);
    assert.equal((await http("/api/wallet/context", undefined, { cookie: "" })).status, 403);
    assert.equal((await http("/api/wallet/challenge", { address: f.wallet.address, code: "bad" })).status, 404);
    const r = await prepared();
    const scoped = await http("/api/wallet/challenge", { address: f.wallet.address, code: r.code });
    assert.equal(scoped.status, 200); assert.match(scoped.body.message, new RegExp(r.code));
    assert.equal((await http("/api/assessments", { handle: "Alice" })).status, 403);
  });
  test("withdrawn review returns a sanitized HTTP failure and no work", async () => {
    await start(); review.withdraw(); const result = await http("/api/assessments", { handle: "Alice" });
    assert.equal(result.status, 503); assert.equal(result.body.code, "SERVICE_UNAVAILABLE");
    assert.deepEqual(Object.keys(result.body).sort(), ["code", "error"]); assert.equal(calls.x, 0);
  });
  for (const checkFirst of [true, false]) test(`owner certification and API work coexist; check first=${checkFirst}`, async () => {
    let enter; const entered = new Promise(r => { enter = r; }), held = hold();
    f.faults.afterQuery = async () => { f.faults.afterQuery = undefined; enter(); await held.promise; };
    const first = checkFirst ? runtime.check() : runtime.session(auth().cookie); let pending;
    try {
      await expectCheckpoint(entered, first, "concurrent owner/API SQL");
      const second = checkFirst ? runtime.session(auth().cookie) : runtime.check();
      pending = Promise.all([first, second]); pending.catch(() => {});
      // Each lane remains single-flight; there is no effect queue or retry.
      await assert.rejects(runtime.check(), error => error.code === "BUSY");
      await assert.rejects(runtime.session(auth().cookie), error => error.code === "BUSY");
      held.release(); const results = await settle(pending, "concurrent owner/API results");
      assert.equal(results[checkFirst ? 1 : 0].walletVerified, true);
    } finally {
      held.release(); f.faults.afterQuery = undefined;
      await settle((pending ?? first).catch(() => {}), "owner/API operations drain");
    }
    assert.deepEqual(calls, { x: 0, grok: 0, sign: 0 }); assert.equal((await counts()).requests, 0);
  });
  test("cancelled owner check cannot poison a concurrent API operation", async () => {
    let enter; const entered = new Promise(r => { enter = r; }), held = hold(), c = new AbortController();
    f.faults.afterQuery = async () => { f.faults.afterQuery = undefined; enter(); await held.promise; };
    const api = runtime.session(auth().cookie);
    try {
      await expectCheckpoint(entered, api, "cancelled owner concurrent SQL");
      const check = runtime.check(c.signal); const rejected = assert.rejects(check); c.abort(); held.release();
      await settle(rejected, "cancelled owner refusal"); assert.equal((await api).walletVerified, true);
    } finally { held.release(); c.abort(); f.faults.afterQuery = undefined; await settle(api.catch(() => {}), "concurrent API operation drain"); }
    await runtime.check(); runtime.assertHealthy(); assert.deepEqual(calls, { x: 0, grok: 0, sign: 0 });
  });
  for (const checkOnly of [false, true]) test(`runtime deadline quarantines both lanes and close drains delayed database work; owner=${checkOnly}`, async () => {
    let entered, once = false; const started = new Promise(r => entered = r), held = hold();
    f.faults.afterQuery = async sql => { if (!once && sql === "BEGIN") { once = true; entered(); await held.promise; } };
    const pending = checkOnly ? runtime.check() : runtime.session(auth().cookie);
    try {
      await expectCheckpoint(started, pending, "runtime deadline SQL");
      await settle(assert.rejects(pending, /deadline/), "runtime deadline refusal");
      let closed = false; const closing = closeRuntime().then(() => { closed = true; });
      await new Promise(r => setImmediate(r)); assert.equal(closed, false);
      held.release(); await closing;
    } finally {
      held.release(); f.faults.afterQuery = undefined;
      await settle(pending.catch(() => {}), "runtime deadline operation drain"); await closeRuntime();
    }
    await assert.rejects(runtime.session(auth().cookie)); assert.equal((await counts()).requests, 0); assert.equal(calls.x, 0);
  });
  test("monotonic expiry before a timer callback rolls admission back and starts no late worker", async () => {
    const original = performance.now.bind(performance); let offset = 0;
    const clock = mock.method(performance, "now", () => original() + offset);
    try {
      f.faults.afterQuery = sql => { if (sql.startsWith("INSERT INTO open_mint.requests")) offset = 20000; };
      await assert.rejects(runtime.create("Alice", auth())); f.faults.afterQuery = undefined;
    } finally { clock.mock.restore(); }
    assert.equal((await counts()).requests, 0); assert.equal((await counts()).attempts, 0); assert.equal(calls.x, 0);
    await assert.rejects(runtime.session(auth().cookie));
  });
});
