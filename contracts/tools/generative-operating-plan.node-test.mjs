import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { keccak256, stringToHex } from "viem";
import canonicalize from "canonicalize";
import { deploymentPlan, PRINCIPALS, ROOT, loadReleaseArtifacts } from "./generative-release.mjs";
import { expectedCollectionRuntime, SEPOLIA_GENESIS } from "./generative-deployment.mjs";
import { operatingPlan } from "./generative-operating-plan.mjs";
import { OperatingPlanError, OPERATING_PLAN_MAX_BYTES } from "../../src/openMint/staging/operatingPlan.ts";
import { operatingSettingsFixture } from "../../src/openMint/staging/fixtures/operatingPlan.ts";

// Deliberately UNOWNED fabricated addresses: no private keys, accounts, secret
// resolver or evidence exist for these declarations. Not deployment settings.
function input() {
  const deployment = { chainId: 11155111, origin: "https://staging.signatures.gallery", genesisHash: SEPOLIA_GENESIS,
    adminDelay: "172800", rendererNonce: "0", collectionNonce: "1", principals: Object.fromEntries(PRINCIPALS.map(name => [name, {
      address: `0x${keccak256(stringToHex(`UNOWNED OPERATING PLAN FIXTURE/${name}`)).slice(-40)}`, ownerReference: `custodians/${name.toLowerCase()}`,
    }])) };
  const plan = deploymentPlan(deployment);
  return { deployment, settings: operatingSettingsFixture(plan) };
}
const run = value => operatingPlan(JSON.stringify(value));
test("release-aware plan recomputes exact immutables, binds all declarations, freezes and grants nothing", () => {
  const c = input(), result = run(c), d = result.deploymentPlan, p = result.operatingPlan;
  assert.equal(p.settings.deploymentPlanSha256, d.planSha256);
  assert.equal(p.releaseLockSha256, "508eefdca3073b8ba97d8a56bc407b9c5c3a6cd8e85a009ad483949d47c386b4");
  assert.equal(p.collectionRuntimeCodeHash, keccak256(expectedCollectionRuntime(d, loadReleaseArtifacts().GenerativeSignaturesV1RC1)));
  const { operatingPlanSha256, ...body } = p;
  assert.equal(operatingPlanSha256, createHash("sha256").update(canonicalize(body)).digest("hex"));
  assert.deepEqual(result, run(c));
  assert.equal(p.status, "declared-only-not-admitted");
  for (const field of ["observedDeployment", "evidenceVerified", "custodyVerified", "providerIndependenceVerified", "paidDispatchAllowed", "signingAllowed", "publicBroadcastAllowed", "runtimeAdmissionAllowed", "activationAllowed"]) assert.equal(p[field], false);
  assert.throws(() => { d.principals.authorizer.address = c.deployment.principals.pauser.address; }, TypeError);
  assert.throws(() => { p.settings.rpc.sources.push({}); }, TypeError);
  const changed = input(); changed.deployment.rendererNonce = "2"; changed.deployment.collectionNonce = "3";
  assert.throws(() => run(changed), /deployment binding/);
  changed.settings.deploymentPlanSha256 = deploymentPlan(changed.deployment).planSha256;
  const next = run(changed); assert.notEqual(next.operatingPlan.operatingPlanSha256, p.operatingPlanSha256);
  assert.notEqual(next.operatingPlan.collectionRuntimeCodeHash, p.collectionRuntimeCodeHash);
});
for (const [label, mutate] of [
  ["wrong genesis", c => { c.deployment.genesisHash = `0x${"1".repeat(64)}`; }],
  ["wrong chain", c => { c.deployment.chainId = 31337; }],
  ["mainnet", c => { c.deployment.chainId = 1; }],
  ["production origin", c => { c.deployment.origin = "https://signatures.gallery"; }],
  ["unreviewed release input", c => { c.deployment.releaseLockSha256 = "a".repeat(64); }],
  ["secret in deployment", c => { c.deployment.privateKey = "NEVER_PRINT_SECRET"; }],
  ["public Anvil key", c => { c.deployment.principals.authorizer.address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; }],
  ["public scalar key", c => { c.deployment.principals.authorizer.address = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"; }],
  ["duplicate role", c => { c.deployment.principals.pauser.address = c.deployment.principals.authorizer.address; }],
  ["duplicate owner", c => { c.deployment.principals.pauser.ownerReference = c.deployment.principals.authorizer.ownerReference; }],
  ["fixture custody", c => { c.deployment.principals.pauser.ownerReference = "synthetic-custody/pauser"; }],
  ["local custody", c => { c.deployment.principals.pauser.ownerReference = "local-custody/pauser"; }],
  ["short admin delay", c => { c.deployment.adminDelay = "1"; }],
  ["nonce beyond observer range", c => { c.deployment.rendererNonce = "9007199254740991"; c.deployment.collectionNonce = "9007199254740992"; }],
  ["unsupported runtime", c => { c.deployment.runtimeAdmissionAllowed = true; }],
  ["RPC endpoint URL", c => { c.settings.rpc.sources[0].endpointSecretReference = "https://rpc.invalid/NEVER_PRINT_SECRET"; }],
  ["extra approval", c => { c.approved = true; }],
  ["extra admission", c => { c.settings.runtimeAdmissionAllowed = true; }],
  ["secret field", c => { c.settings.assessment.xaiApiKey = "NEVER_PRINT_SECRET"; }],
  ["missing deployment", c => { delete c.deployment; }],
  ["null deployment", c => { c.deployment = null; }],
  ["missing settings", c => { delete c.settings; }],
]) test(`rejects ${label} without exposing submitted values`, () => {
  const c = input(); mutate(c);
  assert.throws(() => run(c), e => e instanceof OperatingPlanError && !String(e).includes("NEVER_PRINT_SECRET"));
});
for (const name of PRINCIPALS) for (const key of ["address", "ownerReference"]) test(`crossed custody ${name}.${key}`, () => {
  const c = input(); c.settings.custody[name][key] = key === "address" ? `0x${"9".repeat(40)}` : "custodian/another";
  assert.throws(() => run(c), OperatingPlanError);
});
test("bad roots and release failures have redacted diagnostics", () => {
  for (const json of ["null", "[]", "1", '"text"', "{malformed_SECRET"]) {
    assert.throws(() => operatingPlan(json), e => e instanceof OperatingPlanError && !e.message.includes("SECRET"));
  }
  assert.throws(() => operatingPlan(JSON.stringify(input()), "/nonexistent-do-not-open-SECRET"),
    e => e instanceof OperatingPlanError && !e.message.includes("SECRET"));
});
test("highest exactly observable nonce pair remains representable and bound", () => {
  const c = input(); c.deployment.rendererNonce = "9007199254740990"; c.deployment.collectionNonce = "9007199254740991";
  c.settings.deploymentPlanSha256 = deploymentPlan(c.deployment).planSha256;
  assert.equal(run(c).deploymentPlan.collection.nonce, "9007199254740991");
});
test("CLI reads only a bounded explicit regular UTF-8 JSON file; no activation flags or sensitive error echoes", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-operating-plan-")), file = join(dir, "settings.json");
  const cli = (...args) => spawnSync(process.execPath, ["--import", "tsx", "scripts/generative-operating-plan.mjs", ...args],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, ALLOW_PUBLIC_STARTUP: "1", OPEN_MINT_GENERATION_ENABLED: "1", NODE_ENV: "production" }, timeout: 10000 });
  try {
    writeFileSync(file, JSON.stringify(input()));
    const result = cli("--input", file); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).operatingPlan.runtimeAdmissionAllowed, false);
    for (const args of [[], ["--deploy"], ["--input", file, "--broadcast"], ["--input", dir], ["--input", join(dir, "missing_SECRET")]]) {
      const failed = cli(...args); assert.equal(failed.status, 1); assert.equal(failed.stdout, ""); assert.ok(!failed.stderr.includes("SECRET"));
    }
    symlinkSync(file, join(dir, "link.json")); assert.equal(cli("--input", join(dir, "link.json")).status, 1);
    for (const content of ["NEVER_PRINT_SECRET", " ".repeat(OPERATING_PLAN_MAX_BYTES + 1), Buffer.from([0xff, 0xfe]), '\ufeff{}', JSON.stringify({ ...input(), secret: "NEVER_PRINT_SECRET" })]) {
      writeFileSync(file, content); const failed = cli("--input", file);
      assert.equal(failed.status, 1); assert.equal(failed.stdout, ""); assert.ok(!failed.stderr.includes("NEVER_PRINT_SECRET"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
