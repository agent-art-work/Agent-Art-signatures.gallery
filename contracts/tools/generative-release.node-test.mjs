import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { encodeDeployData, keccak256, stringToHex } from "viem";
import { ROOT, LOCK_PATH, RELEASE, PRINCIPALS, artifactIdentity, candidateSnapshot,
  assertReleaseLock, loadReleaseArtifacts, verifyRelease, deploymentPlan } from "./generative-release.mjs";

const artifacts = loadReleaseArtifacts();
const locked = JSON.parse(readFileSync(resolve(ROOT, LOCK_PATH), "utf8"));
const source = path => readFileSync(resolve(ROOT, path));
// Deliberately fabricated addresses/references, not a ready staging configuration.
const config = () => ({ chainId: 11155111, origin: "https://staging.signatures.gallery",
  genesisHash: keccak256(stringToHex("UNVERIFIED TEST GENESIS")), adminDelay: "172800", rendererNonce: "0", collectionNonce: "1",
  principals: Object.fromEntries(PRINCIPALS.map(name => [name, {
    address: `0x${keccak256(stringToHex(`UNOWNED TEST IDENTITY/${name}`)).slice(-40)}`, ownerReference: `unverified-test/${name.toLowerCase()}`,
  }])),
});
test("all sources, dependencies, oracle and compiled identities match the candidate lock", () => {
  assert.deepEqual(candidateSnapshot(), locked);
  assert.equal(verifyRelease().status, "candidate-not-approved");
  assert.equal(locked.oracle.rendererVersion, "sg-renderer-2.0.0");
  assert.notEqual(RELEASE.renderer, locked.oracle.rendererVersion);
});
for (const key of ["schema", "status", "renderer", "collection", "inputProfile", "domainName", "domainVersion", "foundryConfigSha256", "geometryAncestorSha256"]) {
  test(`lock rejects changed ${key}`, () => {
    const changed = structuredClone(locked); changed[key] += "changed";
    assert.throws(() => assertReleaseLock(locked, changed));
  });
}
for (const name of Object.keys(artifacts)) {
  for (const key of Object.keys(locked.builds[name])) test(`${name}: lock rejects changed ${key}`, () => {
    const changed = structuredClone(locked); changed.builds[name][key] = null;
    assert.throws(() => assertReleaseLock(locked, changed));
  });
  for (const [label, mutate] of [
    ["compiler", a => { a.metadata.compiler.version = "0.8.31"; }],
    ["optimizer", a => { a.metadata.settings.optimizer.runs = 201; }],
    ["via IR", a => { a.metadata.settings.viaIR = true; }],
    ["target", a => { a.metadata.settings.compilationTarget = { "src/OnchainSignatures.sol": "OnchainSignatures" }; }],
    ["oversized runtime", a => { a.deployedBytecode.object = `0x${"00".repeat(24577)}`; }],
    ["oversized initcode", a => { a.bytecode.object = `0x${"00".repeat(49153)}`; }],
    ["unresolved library", a => { a.bytecode.linkReferences = { Library: [] }; }],
    ["linked runtime", a => { a.deployedBytecode.linkReferences = { Library: [] }; }],
    ["unsafe source path", a => { a.metadata.sources["../../.env.local"] = { keccak256: "0x00" }; }],
  ]) test(`${name}: rejects ${label}`, () => {
    const changed = structuredClone(artifacts[name]); mutate(changed);
    assert.throws(() => artifactIdentity(changed, name, source));
  });
  for (const path of Object.keys(artifacts[name].metadata.sources)) test(`${name}: detects stale compiled ${path}`, () => {
    assert.throws(() => artifactIdentity(artifacts[name], name, p => p === `contracts/${path}` ? Buffer.from("tampered") : source(p)), /stale compiled source/);
  });
}
test("immutable groups are independent of incidental compiler AST IDs", () => {
  const name = "GenerativeSignaturesV1RC1", changed = structuredClone(artifacts[name]);
  changed.deployedBytecode.immutableReferences = Object.fromEntries(Object.values(changed.deployedBytecode.immutableReferences).map((value, index) => [index + 1, value]));
  assert.deepEqual(artifactIdentity(changed, name, source), locked.builds[name]);
});
test("renderer rejects any immutable and collection rejects overlapping reference positions", () => {
  const renderer = structuredClone(artifacts.SignatureRendererV1RC1);
  renderer.deployedBytecode.immutableReferences = { 1: [{ start: 0, length: 32 }] };
  assert.throws(() => artifactIdentity(renderer, "SignatureRendererV1RC1", source));
  const collection = structuredClone(artifacts.GenerativeSignaturesV1RC1);
  const refs = Object.values(collection.deployedBytecode.immutableReferences);
  refs[1][0] = { ...refs[0][0] };
  assert.throws(() => artifactIdentity(collection, "GenerativeSignaturesV1RC1", source));
});
test("plan binds exact constructor, code, roles, domain, nonces and profile without granting authority", () => {
  const input = config(), plan = deploymentPlan(input);
  assert.deepEqual(deploymentPlan(input), plan);
  assert.equal(plan.status, "plan-only-not-observed");
  assert.equal(plan.publicBroadcastAllowed, false); assert.equal(plan.runtimeAdmissionAllowed, false);
  assert.equal(plan.observedDeployment, false); assert.equal(plan.collection.startsPaused, true);
  assert.equal(plan.inputProfile, RELEASE.inputProfile);
  assert.equal(plan.domain.verifyingContract, plan.collection.address);
  assert.equal(plan.domain.name, RELEASE.domainName);
  assert.equal(plan.renderer.runtimeCodeHash, locked.builds.SignatureRendererV1RC1.runtimeTemplateHash);
  assert.notEqual(plan.renderer.address, plan.collection.address);
  assert.equal(plan.collection.initcodeHash, keccak256(encodeDeployData({ abi: artifacts.GenerativeSignaturesV1RC1.abi,
    bytecode: artifacts.GenerativeSignaturesV1RC1.bytecode.object,
    args: [plan.renderer.address, 172800n, ...PRINCIPALS.slice(1).map(name => input.principals[name].address)] })));
  input.principals.authorizer.address = input.principals.deployer.address;
  assert.notEqual(plan.principals.authorizer.address, input.principals.authorizer.address, "plan must not alias mutable caller fields");
});
for (const [label, mutate] of [
  ["mainnet", c => { c.chainId = 1; }],
  ["Anvil public plan", c => { c.chainId = 31337; }],
  ["string chain", c => { c.chainId = "11155111"; }],
  ["other origin", c => { c.origin = "https://signatures.gallery"; }],
  ["missing genesis", c => { delete c.genesisHash; }],
  ["zero genesis", c => { c.genesisHash = `0x${"0".repeat(64)}`; }],
  ["secret fields", c => { c.privateKey = "never accepted"; }],
  ["claimed approval", c => { c.publicBroadcastAllowed = true; }],
  ["claimed observed runtime", c => { c.runtimeCodeHash = "0x00"; }],
  ["no delay", c => { c.adminDelay = "0"; }],
  ["short delay", c => { c.adminDelay = "172799"; }],
  ["delay overflow", c => { c.adminDelay = String(2n ** 48n); }],
  ["fractional nonce", c => { c.rendererNonce = "1.5"; }],
  ["negative nonce", c => { c.rendererNonce = "-1"; }],
  ["leading zero nonce", c => { c.rendererNonce = "00"; }],
  ["numeric nonce", c => { c.rendererNonce = 0; }],
  ["nonce overflow", c => { c.rendererNonce = String(2n ** 64n - 1n); }],
  ["nonconsecutive nonces", c => { c.collectionNonce = "2"; }],
  ["missing principal", c => { delete c.principals.pauser; }],
  ["extra principal", c => { c.principals.extra = {}; }],
  ["role key material", c => { c.principals.pauser.privateKey = "never accepted"; }],
  ["zero principal", c => { c.principals.pauser.address = `0x${"0".repeat(40)}`; }],
  ["placeholder principal", c => { c.principals.pauser.address = `0x${"a001".padStart(40, "0")}`; }],
  ["public Anvil key", c => { c.principals.deployer.address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; }],
  ["public scalar key", c => { c.principals.authorizer.address = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"; }],
  ["shared address", c => { c.principals.pauser.address = c.principals.delayedAdmin.address; }],
  ["missing owner", c => { c.principals.pauser.ownerReference = ""; }],
  ["placeholder owner", c => { c.principals.pauser.ownerReference = "todo-owner"; }],
  ["shared owner reference", c => { c.principals.pauser.ownerReference = c.principals.delayedAdmin.ownerReference; }],
]) test(`plan rejects ${label}`, () => {
  const changed = config(); mutate(changed); assert.throws(() => deploymentPlan(changed));
});
test("each deployment input changes the plan digest; nonces also change predicted deployment identity", () => {
  const input = config(), baseline = deploymentPlan(input);
  input.rendererNonce = "2"; input.collectionNonce = "3";
  const moved = deploymentPlan(input);
  assert.notEqual(moved.planSha256, baseline.planSha256);
  assert.notEqual(moved.renderer.identity, baseline.renderer.identity);
  assert.notEqual(moved.collection.initcodeHash, baseline.collection.initcodeHash);
  input.adminDelay = "172801";
  assert.notEqual(deploymentPlan(input).planSha256, moved.planSha256);
  input.principals.pauser.ownerReference = "different-custody/pauser";
  assert.notEqual(deploymentPlan(input).planSha256, moved.planSha256);
});
test("read-only CLI verifies and rejects lock rewriting/deployment flags", () => {
  const run = (...args) => spawnSync(process.execPath, ["scripts/verify-generative-release.mjs", ...args], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run().status, 0);
  for (const option of ["--write", "--bless", "--deploy", "--broadcast", "--plan"]) assert.notEqual(run(option).status, 0);
});
