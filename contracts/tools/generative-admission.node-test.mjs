import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentPlan } from "./generative-release.mjs";
import { createStagingAdmission } from "./generative-admission.mjs";
import { activeStateFixture } from "./fixtures/generative-active-state.mjs";
import { operatingSettingsFixture } from "../../src/openMint/staging/fixtures/operatingPlan.ts";
import { admissionFixture } from "../../src/openMint/staging/fixtures/admission.ts";
import { decodeFunctionData, encodeFunctionResult } from "viem";

// Successful observations are synthetic, not real Sepolia or approval. Only
// the real module's opaque chain witnesses are used by the adapter under test.
async function fixture(changes = false) {
  const chain = await activeStateFixture({ changes }), core = admissionFixture();
  for (const [name, p] of Object.entries(chain.config.principals)) p.ownerReference = "custodians/" + name.toLowerCase();
  const d = deploymentPlan(chain.config), settings = operatingSettingsFixture(d);
  settings.assessment.validFrom = new Date(chain.now() - 1000).toISOString(); settings.assessment.validUntil = new Date(chain.now() + 60000).toISOString();
  const sources = chain.sources.map((s, i) => ({ id: settings.rpc.sources[i].id, operatorReference: settings.rpc.sources[i].operatorReference, request: s.request }));
  const input = { operatingJson: JSON.stringify({ deployment: chain.config, settings }), transactions: chain.transactions, transitions: chain.transitions,
    sources, historyLimits: { maxHistorySpan: 256, logBlockRange: 2, maxLogs: 128, maxTransactions: 32 },
    bindings: { databaseBindingSha256: core.scope.databaseBindingSha256, reviewRevisionSha256: core.scope.reviewRevisionSha256, writerEpoch: "1" },
    ports: { database: core.ports.database, requireReview: core.ports.requireReview, effects: core.ports.effects }, now: chain.now };
  return { chain, core, input, settings, create: () => createStagingAdmission(input) };
}
test("real release/operating/active observer composition gates a simulated effect without public startup", async () => {
  const f = await fixture(), g = f.create(), p = await g.prepare(f.core.intent);
  assert.equal(g.scope.writerEpoch, "1"); assert.equal(g.scope.permitTtlMs, f.settings.rpc.evidenceTtlMs);
  assert.equal(await g.execute(p), "saved-result:sign");
  assert.ok(f.core.events.indexOf("fence:sign") < f.core.events.indexOf("effect:sign"));
  assert.ok(f.chain.requests.length > 0); assert.equal("start" in g, false); assert.equal("activate" in g, false);
});
test("reviewed completion limits change scope but never extend RPC or witness freshness", async () => {
  const f = await fixture(), original = f.create().scopeSha256;
  f.input.assessmentTiming = { jobTimeoutMs: 180000, xCompletionMs: 20000, grokCompletionMs: 100000 };
  f.input.ports.effects["assessment-grok"] = async (_i, _s, guard) => {
    guard.beginDispatch(); f.chain.advance(40000); f.core.advance(40000);
    assert.throws(guard); assert.throws(guard.beginDispatch); guard.assertCompletion(); return "received once";
  };
  const g = f.create(); assert.notEqual(g.scopeSha256, original);
  assert.equal(g.scope.timeoutMs, f.settings.rpc.timeoutMs); assert.equal(g.scope.permitTtlMs, f.settings.rpc.evidenceTtlMs);
  assert.equal(await g.execute(await g.prepare({ ...f.core.intent, operation: "assessment-grok" })), "received once");
});
test("trusted runtime cross-binding observes the real report and can refuse it synchronously", async () => {
  const f = await fixture(); let reads = 0;
  f.input.validateObservation = r => { reads++; assert.equal(r.chainId, 11155111); assert.equal(BigInt(r.deployment.collection.blockNumber), 2n); };
  const g = f.create(); await g.execute(await g.prepare(f.core.intent)); assert.ok(reads > 1);
  for (const callback of [() => { throw Error("different database deployment"); }, () => true]) {
    f.input.validateObservation = callback; await assert.rejects(f.create().prepare(f.core.intent));
  }
  f.input.validateObservation = "not a callback"; assert.throws(f.create);
});
test("copied reports and approved flags cannot manufacture permits", async () => {
  const f = await fixture(), g = f.create();
  for (const v of [{ approved: true }, { ...g.scope }, { runtimeAdmissionAllowed: true }]) await assert.rejects(g.execute(v));
  assert.equal(f.chain.requests.length, 0); assert.equal(f.core.events.length, 0);
});
test("unreviewed current signer/manager rotation cannot inherit initial custody approval", async () => {
  const f = await fixture(true), g = f.create(); await assert.rejects(g.prepare(f.core.intent));
  assert.ok(f.chain.requests.length > 0); assert.equal(f.core.events.some(e => e.startsWith("inspect:")), false);
});
test("review rejection happens before RPC and all effects", async () => {
  const f = await fixture(); f.core.control.review = false; await assert.rejects(f.create().prepare(f.core.intent));
  assert.equal(f.chain.requests.length, 0); assert.equal(f.core.fences.size, 0);
});
test("later missing review cannot reuse a previously prepared permit", async () => {
  const f = await fixture(), g = f.create(), p = await g.prepare(f.core.intent); f.core.control.review = false;
  await assert.rejects(g.execute(p)); assert.equal(f.core.fences.size, 0);
});
for (const [label, change] of [
  ["wrong operator", f => { f.input.sources[0].operatorReference = "owner:rpc/mismatch"; }],
  ["wrong source", f => { f.input.sources[0].id = "service:rpc/mismatch"; }],
  ["reordered sources", f => { f.input.sources.reverse(); }],
  ["shared callback", f => { f.input.sources[1].request = f.input.sources[0].request; }],
  ["unknown source field", f => { f.input.sources[0].approved = true; }],
  ["missing callback", f => { delete f.input.sources[0].request; }],
  ["history timeout override", f => { f.input.historyLimits.timeoutMs = 1; }],
  ["history limit bypass", f => { f.input.historyLimits.maxLogs = 999999; }],
  ["unknown binding", f => { f.input.bindings.approved = true; }],
  ["missing review pin", f => { delete f.input.bindings.reviewRevisionSha256; }],
  ["invalid writer epoch", f => { f.input.bindings.writerEpoch = "0"; }],
  ["injected chain reader", f => { f.input.ports.chain = { read() {} }; }],
  ["malformed operating input", f => { f.input.operatingJson = "SECRET invalid JSON"; }],
  ["plan instead of configuration", f => { f.input.operatingJson = JSON.stringify({ approved: true }); }],
  ["no activation", f => { f.input.transitions = []; }],
]) test("rejects " + label + " before observation without leaking inputs", async () => {
  const f = await fixture(); change(f); assert.throws(f.create, e => e.message === "Operation admission unavailable; no external action was started by this gate.");
  assert.equal(f.chain.requests.length, 0); assert.equal(f.core.fences.size, 0);
});
test("checks declared zero future skew without widening it", async () => {
  const f = await fixture(), c = JSON.parse(f.input.operatingJson); c.settings.rpc.maxFutureSkewMs = 0; f.input.operatingJson = JSON.stringify(c);
  const g = f.create(); await g.execute(await g.prepare(f.core.intent)); assert.ok(f.core.events.includes("effect:sign"));
});
test("freshness expiry between readiness and effect is enforced by real opaque reader", async () => {
  const f = await fixture(), g = f.create(), p = await g.prepare(f.core.intent); f.chain.advance(15000);
  await assert.rejects(g.execute(p)); assert.equal(f.core.fences.size, 0);
});
test("a changed deployment or governance policy changes the immutable scope", async () => {
  const f = await fixture(), first = f.create().scopeSha256;
  f.input.historyLimits.maxLogs = 127; assert.notEqual(f.create().scopeSha256, first);
  f.input.bindings.reviewRevisionSha256 = "f".repeat(64); const second = f.create().scopeSha256;
  f.input.bindings.writerEpoch = "2"; assert.notEqual(f.create().scopeSha256, second);
});
for (const mutation of ["genesis", "paused", "oversize", "abort"]) test("actual observer blocks " + mutation + " with no durable fence", async () => {
  const f = await fixture();
  f.chain.mutate((m, p, v) => {
    if (mutation === "genesis" && m === "eth_getBlockByNumber" && p[0] === "0x0") v.hash = "0x" + "ff".repeat(32);
    if (mutation === "paused" && m === "eth_call") {
      const abi = p[0].to === f.chain.plan.renderer.address ? f.chain.builds.SignatureRendererV1RC1.abi : f.chain.builds.GenerativeSignaturesV1RC1.abi;
      const d = decodeFunctionData({ abi, data: p[0].data }); if (d.functionName === "paused") return encodeFunctionResult({ abi, functionName: "paused", result: true });
    }
    if (mutation === "oversize" && m === "eth_getBlockByNumber") return { ...v, unused: "x".repeat(f.settings.rpc.jsonResponseBytes) };
    return v;
  });
  const controller = new AbortController(); if (mutation === "abort") controller.abort();
  await assert.rejects(f.create().prepare(f.core.intent, controller.signal)); assert.equal(f.core.fences.size, 0);
});
