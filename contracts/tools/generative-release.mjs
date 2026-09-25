import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import { encodeAbiParameters, encodeDeployData, getContractAddress, keccak256 } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const RELEASE = Object.freeze({
  renderer: "sg-evm-renderer-1.0.0-rc.1", collection: "sg-generative-mint-1.0.0-rc.1",
  inputProfile: "sg-generative-inputs-v1-rc1", domainName: "SignaturesGenerativeMintRC1", domainVersion: "1",
});
export const LOCK_PATH = "contracts/releases/generative-v1-rc1.json";
export const PRINCIPALS = ["deployer", "delayedAdmin", "authorizerManager", "pauser", "nonceRevoker", "authorizer"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => sha(canonicalize(value));
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
function fields(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}: object required`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label}: exact fields required`);
}
function hexCode(value) { assert.match(value, /^0x(?:[a-f0-9]{2})+$/); return value; }
function sourcePath(path) {
  assert.ok(/^src\/release\/(SignatureRendererV1RC1|GenerativeSignaturesV1RC1)\.sol$/.test(path)
    || /^\.\.\/node_modules\/@openzeppelin\/contracts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.sol$/.test(path), "unrecognized compiler source path");
  return `contracts/${path}`;
}

/** Recompute, never rewrite, a build identity. Verify ALL transitive compiled sources. */
export function artifactIdentity(artifact, name, readSource) {
  assert.ok(["SignatureRendererV1RC1", "GenerativeSignaturesV1RC1"].includes(name));
  const metadata = artifact.metadata;
  assert.equal(metadata.compiler.version, "0.8.30+commit.73712a01", "compiler version");
  assert.deepEqual(metadata.settings, {
    remappings: ["@openzeppelin/contracts/=../node_modules/@openzeppelin/contracts/"],
    optimizer: { enabled: true, runs: 200 }, metadata: { bytecodeHash: "ipfs" },
    compilationTarget: { [`src/release/${name}.sol`]: name }, evmVersion: "prague", libraries: {},
  }, "compiler settings");
  assert.ok(metadata.sources[`src/release/${name}.sol`], "target source missing");
  for (const [path, entry] of Object.entries(metadata.sources)) {
    assert.equal(keccak256(readSource(sourcePath(path))), entry.keccak256, `stale compiled source: ${path}`);
  }
  assert.deepEqual(artifact.bytecode.linkReferences ?? {}, {}, "external creation links forbidden");
  assert.deepEqual(artifact.deployedBytecode.linkReferences ?? {}, {}, "external runtime links forbidden");
  const creation = hexCode(artifact.bytecode.object), runtime = hexCode(artifact.deployedBytecode.object);
  const runtimeBytes = (runtime.length - 2) / 2, creationBytes = (creation.length - 2) / 2;
  assert.ok(runtimeBytes <= 24576 && creationBytes <= 49152, "contract size limits");
  // AST IDs change when unrelated compilation units are added. Lock positions
  // grouped by immutable instead, not incidental numeric compiler IDs.
  const immutables = Object.values(artifact.deployedBytecode.immutableReferences ?? {})
    .map(group => [...group].sort((a, b) => a.start - b.start)).sort((a, b) => a[0].start - b[0].start);
  if (name === "SignatureRendererV1RC1") assert.deepEqual(immutables, [], "renderer must be stateless");
  const positions = new Set();
  for (const group of immutables) for (const ref of group) {
    fields(ref, ["start", "length"], "immutable reference");
    assert.ok(Number.isSafeInteger(ref.start) && ref.start >= 0 && ref.length === 32 && ref.start + ref.length <= runtimeBytes);
    for (let i = ref.start; i < ref.start + ref.length; i++) { assert.ok(!positions.has(i)); positions.add(i); }
    assert.equal(runtime.slice(2 + ref.start * 2, 2 + (ref.start + ref.length) * 2), "0".repeat(64));
  }
  return {
    compilerVersion: metadata.compiler.version, sourceSha256: sha(readSource(`contracts/src/release/${name}.sol`)),
    metadataSha256: digest(metadata), settingsSha256: digest(metadata.settings), abiSha256: digest(artifact.abi),
    creationCodeHash: keccak256(creation), runtimeTemplateHash: keccak256(runtime), creationBytes, runtimeBytes,
    immutableReferences: immutables,
  };
}

export function loadReleaseArtifacts(root = ROOT) {
  return Object.fromEntries(["SignatureRendererV1RC1", "GenerativeSignaturesV1RC1"].map(name =>
    [name, readJson(resolve(root, `contracts/out/${name}.sol/${name}.json`))]));
}

/** A candidate snapshot is not production approval, a deployment or a parity proof. */
export function candidateSnapshot(root = ROOT) {
  const read = path => readFileSync(resolve(root, path));
  const oraclePath = "reference/algorithm-v2.0.0/renderer-lock.json";
  const oracle = JSON.parse(read(oraclePath));
  // The upstream verifier separately checks all 384 goldens. Bind that exact
  // lock and every file it protects here as well.
  fields(oracle.files, ["reference/algorithm-v2.0.0/signature_renderer_v2.0.0.py",
    "reference/algorithm-v2.0.0/signature_renderer_v2.0.0.json", "reference/algorithm-v2.0.0/SHA256SUMS",
    "reference/algorithm-v2.0.0/golden-svgs.json", "src/algorithmV2/index.ts"], "oracle file list");
  for (const [path, expected] of Object.entries(oracle.files)) assert.equal(sha(read(path)), expected, `oracle source: ${path}`);
  const experimental = read("contracts/src/experimental/SignatureRendererCandidate.sol").toString();
  const renderer = read("contracts/src/release/SignatureRendererV1RC1.sol").toString();
  const geometry = source => source.slice(source.indexOf("contract SignatureRenderer"))
    .replace(/contract SignatureRenderer(?:Candidate|V1RC1)/, "contract Renderer")
    .replace(/string public constant VERSION = "[^"]+";/, 'string public constant VERSION = "PROFILE";').replace(/\r\n/g, "\n");
  assert.ok(experimental.includes("contract SignatureRenderer") && renderer.includes("contract SignatureRenderer"));
  assert.equal(geometry(renderer), geometry(experimental), "candidate geometry differs from numerical experiment");
  const artifacts = loadReleaseArtifacts(root);
  return {
    schema: "sg-generative-release-lock-v1", status: "candidate-not-approved", ...RELEASE,
    oracle: { rendererVersion: oracle.rendererVersion, upstream: oracle.upstream, lockSha256: sha(read(oraclePath)) },
    geometryAncestorSha256: sha(Buffer.from(experimental)),
    foundryConfigSha256: sha(read("contracts/foundry.toml")),
    builds: Object.fromEntries(Object.entries(artifacts).map(([name, artifact]) => [name, artifactIdentity(artifact, name, read)])),
  };
}

export function assertReleaseLock(snapshot, locked) {
  assert.deepEqual(snapshot, locked, "release candidate lock mismatch; do not regenerate to silence this failure");
  return { releaseLockSha256: digest(locked), status: locked.status, ...RELEASE };
}

export function verifyRelease(root = ROOT) {
  return assertReleaseLock(candidateSnapshot(root), readJson(resolve(root, LOCK_PATH)));
}

const TEST_ADDRESSES = new Set([
  ...Array.from({ length: 20 }, (_, addressIndex) => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex }).address.toLowerCase()),
  ...Array.from({ length: 16 }, (_, i) => privateKeyToAccount(`0x${BigInt(i + 1).toString(16).padStart(64, "0")}`).address.toLowerCase()),
]);
function unsigned(value, maximum, label) {
  assert.ok(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78, `${label}: decimal string required`);
  assert.ok(BigInt(value) <= maximum, `${label}: out of range`);
  return BigInt(value);
}

/** Offline PLANNING only. No RPC, signer, key, environment inference or broadcast. */
export function deploymentPlan(config, root = ROOT) {
  fields(config, ["chainId", "origin", "genesisHash", "adminDelay", "rendererNonce", "collectionNonce", "principals"], "configuration");
  assert.equal(config.chainId, 11155111, "Ethereum Sepolia only");
  assert.equal(config.origin, "https://staging.signatures.gallery", "approved staging origin only");
  assert.match(config.genesisHash, /^0x[0-9a-f]{64}$/, "explicit genesis hash required");
  assert.notEqual(config.genesisHash, `0x${"0".repeat(64)}`, "zero genesis hash");
  const delay = unsigned(config.adminDelay, 2n ** 48n - 1n, "admin delay");
  assert.ok(delay >= 172800n, "candidate plan requires at least 48-hour admin delay");
  const rendererNonce = unsigned(config.rendererNonce, 2n ** 64n - 2n, "renderer nonce");
  const collectionNonce = unsigned(config.collectionNonce, 2n ** 64n - 2n, "collection nonce");
  assert.equal(collectionNonce, rendererNonce + 1n, "consecutive CREATE nonces required");
  fields(config.principals, PRINCIPALS, "principals");
  const addresses = new Set(), owners = new Set();
  for (const name of PRINCIPALS) {
    const principal = config.principals[name]; fields(principal, ["address", "ownerReference"], name);
    assert.match(principal.address, /^0x[0-9a-f]{40}$/, `${name}: normalized public address required`);
    assert.ok(BigInt(principal.address) > 0xffffn && !TEST_ADDRESSES.has(principal.address), `${name}: placeholder/test identity forbidden`);
    assert.ok(!addresses.has(principal.address), "distinct role addresses required"); addresses.add(principal.address);
    assert.ok(typeof principal.ownerReference === "string" && /^[a-z0-9][a-z0-9._/-]{2,95}$/.test(principal.ownerReference)
      && !/(example|placeholder|todo|unknown)/.test(principal.ownerReference), `${name}: explicit owner reference required`);
    assert.ok(!owners.has(principal.ownerReference), "distinct role owner references required"); owners.add(principal.ownerReference);
  }
  const verified = verifyRelease(root), builds = loadReleaseArtifacts(root);
  const rendererBuild = builds.SignatureRendererV1RC1, collectionBuild = builds.GenerativeSignaturesV1RC1;
  const principals = Object.fromEntries(PRINCIPALS.map(name => [name, { ...config.principals[name] }]));
  const rendererAddress = getContractAddress({ from: principals.deployer.address, nonce: rendererNonce }).toLowerCase();
  const collectionAddress = getContractAddress({ from: principals.deployer.address, nonce: collectionNonce }).toLowerCase();
  assert.ok(!addresses.has(rendererAddress) && !addresses.has(collectionAddress) && rendererAddress !== collectionAddress, "deployment address collision");
  const rendererCodeHash = keccak256(rendererBuild.deployedBytecode.object);
  const rendererIdentity = keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "bytes32" }],
    [RELEASE.inputProfile, rendererAddress, rendererCodeHash]));
  const initcode = encodeDeployData({ abi: collectionBuild.abi, bytecode: collectionBuild.bytecode.object,
    args: [rendererAddress, delay, ...PRINCIPALS.slice(1).map(name => principals[name].address)] });
  assert.ok((initcode.length - 2) / 2 <= 49152, "collection initcode size cap");
  const plan = {
    schema: "sg-generative-deployment-plan-v1", status: "plan-only-not-observed",
    releaseLockSha256: verified.releaseLockSha256, inputProfile: RELEASE.inputProfile,
    chainId: config.chainId, origin: config.origin, declaredGenesisHash: config.genesisHash,
    adminDelay: config.adminDelay, principals,
    renderer: { version: RELEASE.renderer, address: rendererAddress, nonce: config.rendererNonce,
      initcodeHash: keccak256(rendererBuild.bytecode.object), runtimeCodeHash: rendererCodeHash, identity: rendererIdentity },
    collection: { version: RELEASE.collection, address: collectionAddress, nonce: config.collectionNonce,
      initcodeHash: keccak256(initcode), runtimeTemplateHash: keccak256(collectionBuild.deployedBytecode.object),
      constructor: { renderer: rendererAddress, adminDelay: config.adminDelay, ...Object.fromEntries(PRINCIPALS.slice(1).map(name => [name, principals[name].address])) },
      startsPaused: true },
    domain: { name: RELEASE.domainName, version: RELEASE.domainVersion, chainId: config.chainId, verifyingContract: collectionAddress },
    observedDeployment: false, publicBroadcastAllowed: false, runtimeAdmissionAllowed: false,
  };
  return { ...plan, planSha256: digest(plan) };
}
