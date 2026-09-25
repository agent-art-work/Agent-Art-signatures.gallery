import assert from "node:assert/strict";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import { request } from "node:http";
import { Client } from "pg";
import { createSepoliaReadiness, pausedReadinessScope } from "./generative-staging-readiness.mjs";
import { readinessInputFixture, readinessDatabaseFixture } from "./fixtures/generative-staging-readiness.mjs";
import { readinessReviewFixture } from "../../src/openMint/staging/fixtures/readinessReview.ts";
import { disposablePostgres } from "../../src/openMint/persistence/fixtures/postgres.ts";
import { ROOT } from "./generative-release.mjs";
import { admissionDigest } from "../../src/openMint/staging/admission.ts";
const failure = /Paused staging readiness unavailable/;

test("scope is deterministic, release/DB/review/resource bound and grants no admission", async () => {
  const f = await readinessInputFixture(), a = pausedReadinessScope(f.input), b = pausedReadinessScope(structuredClone(f.input));
  assert.deepEqual(a, b); assert.equal(a.approved, false); assert.equal(a.minting, false); assert.ok(Object.isFrozen(a));
  for (const patch of [{ port: 9999 }, { maxDeploymentSpan: 128 }, { databaseReview: { ...f.input.databaseReview, migrationReceiptSha256: "d".repeat(64) } }])
    assert.notEqual(pausedReadinessScope({ ...f.input, ...patch }).scopeSha256, a.scopeSha256);
  assert.equal(f.chain.requests.length, 0);
});
test("v2 timing changes the paused review scope and cannot bypass the profile hash", async () => {
  const f = await readinessInputFixture(), original = pausedReadinessScope(f.input);
  f.input.assessmentPolicy = { ...f.input.assessmentPolicy, schema: "sg-readiness-assessment-policy-v2",
    timing: { jobTimeoutMs: 180000, xCompletionMs: 20000, grokCompletionMs: 100000 } };
  assert.throws(() => pausedReadinessScope(f.input), failure);
  const config = JSON.parse(f.input.operatingJson);
  config.settings.assessment.profileSha256 = admissionDigest(f.input.assessmentPolicy);
  f.input.operatingJson = JSON.stringify(config);
  const updated = pausedReadinessScope(f.input);
  assert.notEqual(updated.scopeSha256, original.scopeSha256);
  assert.equal(updated.approved, false); assert.equal(updated.minting, false);
  f.input.assessmentPolicy.timing.grokCompletionMs++;
  assert.throws(() => pausedReadinessScope(f.input), failure);
  assert.equal(f.chain.requests.length, 0);
});
for (const [name, mutate] of [
  ["extra authority", f => { f.input.approved = true; }], ["getter", f => { Object.defineProperty(f.input, "port", { get() { throw Error("SECRET"); } }); }],
  ["bad port", f => { f.input.port = -1; }], ["unbounded range", f => { f.input.maxDeploymentSpan = 513; }],
  ["same tx", f => { f.input.transactions.collection = f.input.transactions.renderer; }], ["bad tx", f => { f.input.transactions.renderer = "SECRET"; }],
  ["wrong manifest", f => { f.input.databaseReview.migrationManifestSha256 = "f".repeat(64); }],
  ["wrong runtime role", f => { f.input.databaseReview.runtimeRole = "sg_projection"; }],
  ["wrong owner", f => { f.input.databaseReview.ownerRole = "sg_browser"; }],
  ["wrong deployment", f => { f.input.databaseReview.deploymentId = "11111111-1111-4111-8111-111111111111"; }],
  ["bad namespace", f => { f.input.databaseReview.namespaceId = "bad"; }], ["bad database", f => { f.input.databaseReview.database = "pg_catalog"; }],
  ["missing policy", f => { f.input.assessmentPolicy = null; }], ["crossed model", f => { f.input.assessmentPolicy.model = "grok-other"; }],
  ["wrong policy domain", f => { f.input.assessmentPolicy.schema = "arbitrary"; }], ["wrong policy", f => { f.input.assessmentPolicy.policyVersion = "old"; }],
  ["extra policy approval", f => { f.input.assessmentPolicy.approved = true; }],
  ["direct TLS declaration", f => { const c = JSON.parse(f.input.operatingJson); c.settings.hosting.tlsMode = "direct"; c.settings.hosting.trustedProxyHops = 0; f.input.operatingJson = JSON.stringify(c); }],
  ["incompatible queue size", f => { const c = JSON.parse(f.input.operatingJson); c.settings.assessment.maxQueued = 0; f.input.operatingJson = JSON.stringify(c); }],
  ["incompatible total attempts", f => { const c = JSON.parse(f.input.operatingJson); c.settings.assessment.totalAttempts = 100001; f.input.operatingJson = JSON.stringify(c); }],
]) test(`scope refuses ${name}`, async () => {
  const f = await readinessInputFixture(); mutate(f); assert.throws(() => pausedReadinessScope(f.input), failure); assert.equal(f.chain.requests.length, 0);
});
for (const [name, mutate] of [
  ["shared source", f => { f.sources[1] = f.sources[0]; }], ["shared callback", f => { f.sources[1].request = f.sources[0].request; }],
  ["wrong source", f => { f.sources[0].id = "service:rpc/other"; }], ["wrong owner", f => { f.sources[1].operatorReference = "owner:rpc/other"; }],
  ["extra source authority", f => { f.sources[0].approved = true; }], ["missing source", f => { f.sources.pop(); }],
]) test(`construction refuses ${name} without IO`, async () => {
  const f = await readinessInputFixture(), signed = readinessReviewFixture(pausedReadinessScope(f.input).scopeSha256, f.chain.now()); mutate(f);
  assert.throws(() => createSepoliaReadiness({ ...f.input, sources: f.sources, connection: { query() { assert.fail("no query"); } }, review: signed.source }, ROOT, f.chain.now), failure);
  assert.equal(f.chain.requests.length, 0);
});
test("withdrawn/expired signed review prevents all database/RPC IO and listening", async () => {
  for (const expiry of [false, true]) {
    const f = await readinessInputFixture(), signed = readinessReviewFixture(pausedReadinessScope(f.input).scopeSha256, f.chain.now());
    if (expiry) f.chain.advance(60000); else signed.withdraw();
    const server = createSepoliaReadiness({ ...f.input, sources: f.sources, connection: { query() { assert.fail("no query"); } }, review: signed.source }, ROOT, f.chain.now);
    await assert.rejects(server.start(), failure); assert.equal(server.address(), undefined); assert.equal(f.chain.requests.length, 0);
  }
});

test("explicit v2 paused readiness starts only against the v2 catalog", {
  skip: process.env.OPEN_MINT_TEST_POSTGRES !== "1",
}, async () => {
  const cluster = disposablePostgres(), admin = new Client(cluster.config);
  let fixture, server;
  try {
    await admin.connect();
    fixture = await readinessDatabaseFixture(cluster, admin, { v2: true });
    const input = await fixture.pin();
    server = createSepoliaReadiness(input, ROOT, fixture.chain.now);
    await server.start();
    assert.equal(server.address().host, "127.0.0.1");
    await fixture.db.query("SET ROLE sg_migrator");
    assert.equal((await fixture.db.query("SELECT count(*)::int AS n FROM open_mint.staging_generative_recoveries")).rows[0].n, 0);
    await fixture.db.query("RESET ROLE");
  } finally {
    await server?.close();
    await fixture?.close();
    await admin.end().catch(() => {});
    cluster.stop();
  }
});

describe("real disposable database + synthetic paused Sepolia + bounded HTTP composition", {
  skip: process.env.OPEN_MINT_TEST_POSTGRES !== "1" || process.env.OPEN_MINT_TEST_HTTP !== "1",
}, () => {
  let cluster, admin, f, server;
  before(async () => { cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); });
  after(async () => { await admin?.end(); cluster?.stop(); });
  beforeEach(async () => { f = await readinessDatabaseFixture(cluster, admin); });
  afterEach(async () => { await server?.close(); server = undefined; await f?.close(); f = undefined; });
  const build = input => createSepoliaReadiness(input, ROOT, f.chain.now);
  function get(path = "/_health/ready") {
    return new Promise((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: server.address().port, path, agent: false,
        headers: { Host: "staging.signatures.gallery", "X-Forwarded-Proto": "https" } }, res => {
        let text = ""; res.on("data", d => { text += d; }); res.on("end", () => resolve({ code: res.statusCode, body: JSON.parse(text) }));
      }); r.on("error", reject); r.end();
    });
  }
  test("checks actual locked schema/roles, profile pins, release artifacts and both RPCs before listening; zero effects", async () => {
    server = build(await f.pin()); await server.start();
    assert.equal(server.address().host, "127.0.0.1"); assert.ok(f.chain.requests.length > 200);
    assert.deepEqual(await get(), { code: 200, body: { status: "ready-paused", mode: "paused-readiness-only", minting: false } });
    assert.equal((await get("/mint")).code, 404); assert.equal((await get("/api/mint")).code, 404);
    assert.deepEqual((await f.db.query("SELECT epoch FROM open_mint.writer_epoch")).rows, [{ epoch: "0" }]);
    assert.deepEqual((await f.db.query("SELECT count(*)::int AS n FROM open_mint.dispatch_fences")).rows, [{ n: 0 }]);
    assert.deepEqual((await f.db.query("SELECT generation_enabled FROM open_mint.budget_policies")).rows, [{ generation_enabled: false }]);
    assert.deepEqual((await f.db.query("SELECT enabled FROM open_mint.generative_issuance_profiles")).rows, [{ enabled: false }]);
    await server.close(); assert.equal((await f.runtime.query("SELECT 1 AS ok")).rows[0].ok, 1);
  });
  test("copies reviewed input before awaits; source/DB input mutation cannot retarget startup", async () => {
    const input = await f.pin(); server = build(input);
    input.databaseReview.profilesSha256 = "f".repeat(64); input.transactions.collection = "0x" + "f".repeat(64);
    input.sources[0].request = () => { throw Error("retargeted"); }; await server.start(); assert.equal((await get()).code, 200);
  });
  test("withdrawal after startup quarantines ready without losing liveness or retrying IO", async () => {
    const input = await f.pin(), signed = readinessReviewFixture(pausedReadinessScope(f.input).scopeSha256, f.chain.now());
    server = build({ ...input, review: signed.source }); await server.start(); const count = f.chain.requests.length; signed.withdraw();
    assert.equal((await get()).code, 503); assert.equal((await get()).code, 503); assert.equal(f.chain.requests.length, count);
    assert.equal((await get("/_health/live")).code, 200);
  });
  test("database drift after startup refuses readiness before any new RPC", async () => {
    server = build(await f.pin()); await server.start(); const count = f.chain.requests.length;
    await f.db.query("ALTER TABLE open_mint.wallet_mint_reports DISABLE TRIGGER immutable_wallet_report");
    assert.equal((await get()).code, 503); assert.equal(f.chain.requests.length, count);
  });
  for (const sql of ["UPDATE open_mint.budget_policies SET generation_enabled=true",
    "UPDATE open_mint.generative_issuance_profiles SET enabled=true",
    "GRANT UPDATE ON open_mint.namespaces TO sg_browser"]) test(`refuses early activation or excess grants: ${sql}`, async () => {
    const input = await f.pin(); await f.db.query(sql); server = build(input);
    await assert.rejects(server.start(), failure); assert.equal(server.address(), undefined); assert.equal(f.chain.requests.length, 0);
  });
  test("shutdown aborts hanging observation without retry, connection close or background listener", async () => {
    const input = await f.pin(); let called = 0, signal;
    input.sources[0].request = async (_m, _p, s) => { signal = s; called++; return new Promise(() => {}); };
    server = build(input); const pending = server.start(), refused = assert.rejects(pending, failure);
    for (let i = 0; i < 500 && !signal; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(signal); await server.close(); await refused; assert.equal(signal.aborted, true); assert.equal(called, 1);
    assert.equal(server.address(), undefined); assert.equal((await f.runtime.query("SELECT 1 AS ok")).rows[0].ok, 1);
  });
  for (const [label, mutate] of [
    ["wrong chain", (m, _p, v) => m === "eth_chainId" ? "0x1" : v],
    ["wrong genesis", (m, p, v) => m === "eth_getBlockByNumber" && p[0] === "0x0" ? { ...v, hash: "0x" + "f".repeat(64) } : v],
    ["RPC disagreement", (m, _p, v, i) => m === "eth_chainId" && i === 1 ? "0x1" : v],
    ["oversized transport result", (m, _p, v) => m === "eth_chainId" ? "x".repeat(262145) : v],
    ["malformed transport result", (m, _p, v) => m === "eth_chainId" ? undefined : v],
    ["missing deployed code", (m, _p, v) => m === "eth_getCode" ? "0x" : v],
    ["revoked review during observation", (m, _p, v) => { f.chain.advance(60000); return v; }],
  ]) test(`never listens on ${label}`, async () => {
    const input = await f.pin(); f.chain.mutate(mutate); server = build(input);
    await assert.rejects(server.start(), failure); assert.equal(server.address(), undefined);
  });
  // Re-pin deliberately inconsistent fixtures: even an authentic matching
  // profile digest must not hide disagreement with the approved operating plan.
  for (const [name, sql] of [
    ["model", "UPDATE open_mint.budget_policies SET expected_model='grok-other'"],
    ["budget", "UPDATE open_mint.budget_policies SET max_exposure_usd_ticks=max_exposure_usd_ticks+1"],
    ["exact bigint", "UPDATE open_mint.request_profiles SET deployment_block=9007199254740993"],
    ["deployment block", "UPDATE open_mint.request_profiles SET deployment_block=3"],
    ["deployment hash", "UPDATE open_mint.request_profiles SET deployment_block_hash='0x' || repeat('a',64)"],
    ["runtime hash", "UPDATE open_mint.request_profiles SET runtime_code_hash='0x' || repeat('a',64)"],
    ["renderer hash", "UPDATE open_mint.generative_input_profiles SET renderer_code_hash='0x' || repeat('a',64)"],
    ["profile version", "UPDATE open_mint.budget_policies SET profile_version='other-version'"],
    ["budget expiry", "UPDATE open_mint.budget_policies SET valid_until=valid_until + interval '1 second'"],
    ["evidence TTL", "UPDATE open_mint.request_profiles SET max_evidence_age_ms=10000"],
    ["signer deadline", "UPDATE open_mint.generative_issuance_profiles SET signer_timeout_ms=6000"],
    ["policy version", "UPDATE open_mint.namespaces SET policy_version='wrong-policy'"],
  ]) test(`cross-checks ${name}, even when explicitly pinned by fixture review`, async () => {
    await f.db.query("BEGIN; SET LOCAL session_replication_role=replica"); await f.db.query(sql); await f.db.query("COMMIT");
    server = build(await f.pin()); await assert.rejects(server.start(), failure); assert.equal(server.address(), undefined);
  });
});
