import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import canonicalize from 'canonicalize';
import { keccak256, stringToHex } from 'viem';
import { PULSE_MINT_CANDIDATE, PULSE_AUTHORIZATION_TYPES } from '../../src/openMint/pulseCandidate.ts';
import { artifactIdentity, verifyRelease } from './generative-release.mjs';
import { verifyPulseCoreBundle } from './verify-pulse-core-lock.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const LOCK_PATH = 'contracts/releases/generative-pulse-v1-rc1.json';
export const ABI_PATH = 'contracts/releases/generative-pulse-v1-rc1.abi.json';
export const CONTRACT = PULSE_MINT_CANDIDATE.contractName;
const sha = value => createHash('sha256').update(value).digest('hex');
export const jsonDigest = value => sha(canonicalize(value));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const paramType = p => p.type.startsWith('tuple')
  ? `(${p.components.map(paramType).join(',')})${p.type.slice(5)}` : p.type;
const signature = item => `${item.name}(${item.inputs.map(paramType).join(',')})`;

/** Numeric AST IDs are incidental; zero-placeholder byte ranges are stable. */
function immutableRanges(artifact, runtime) {
  const groups = Object.values(artifact.deployedBytecode.immutableReferences ?? {})
    .map(group => [...group].sort((a, b) => a.start - b.start));
  const occupied = new Set();
  for (const group of groups) {
    assert.ok(group.length > 0, 'empty immutable group');
    for (const ref of group) {
      assert.deepEqual(Object.keys(ref).sort(), ['length', 'start']);
      assert.ok(Number.isSafeInteger(ref.start) && ref.start >= 0 && ref.length === 32 &&
        ref.start + ref.length <= (runtime.length - 2) / 2, 'invalid immutable range');
      for (let i = ref.start; i < ref.start + 32; ++i) {
        assert.ok(!occupied.has(i), 'overlapping immutables'); occupied.add(i);
      }
      assert.equal(runtime.slice(2 + ref.start * 2, 2 + (ref.start + 32) * 2), '0'.repeat(64), 'nonzero immutable placeholder');
    }
  }
  return groups.sort((a, b) => a[0].start - b[0].start);
}

export function pulseArtifactIdentity(artifact, readSource) {
  const metadata = artifact.metadata;
  assert.equal(metadata.compiler.version, '0.8.30+commit.73712a01', 'consumer compiler');
  assert.deepEqual(metadata.settings, {
    remappings: ['@openzeppelin/contracts/=../node_modules/@openzeppelin/contracts/'],
    optimizer: { enabled: true, runs: 200 }, metadata: { bytecodeHash: 'ipfs' },
    compilationTarget: { [`src/release/${CONTRACT}.sol`]: CONTRACT }, evmVersion: 'prague', libraries: {},
  }, 'consumer compiler settings');
  for (const required of [`src/release/${CONTRACT}.sol`, 'src/release/ISignaturesPulseMintV1RC1.sol',
    'src/release/SignatureRendererV1RC1.sol', 'vendor/pulse-core-v1.0.0/IPulseCore.sol']) {
    assert.ok(metadata.sources[required], `missing source ${required}`);
  }
  for (const [path, source] of Object.entries(metadata.sources)) {
    assert.ok(/^src\/release\/(?:I?SignaturesPulseMintV1RC1|SignatureRendererV1RC1)\.sol$/.test(path) ||
      path === 'vendor/pulse-core-v1.0.0/IPulseCore.sol' ||
      /^\.\.\/node_modules\/@openzeppelin\/contracts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.sol$/.test(path),
    'unexpected compiler source path');
    assert.equal(keccak256(readSource(`contracts/${path}`)), source.keccak256, `stale compiled source: ${path}`);
  }
  for (const code of [artifact.bytecode, artifact.deployedBytecode]) {
    assert.deepEqual(code.linkReferences ?? {}, {}, 'linked code not supported');
    assert.match(code.object, /^0x(?:[a-f0-9]{2})+$/, 'invalid bytecode');
  }
  const creation = artifact.bytecode.object, runtime = artifact.deployedBytecode.object;
  const creationBytes = (creation.length - 2) / 2, runtimeBytes = (runtime.length - 2) / 2;
  assert.ok(runtimeBytes <= 24576, 'EIP-170 exceeded');
  // Constructor has 17 static ABI words: renderer(1), core(2), sale(8), authorities(6).
  assert.ok(creationBytes + 17 * 32 <= 49152, 'EIP-3860 including constructor exceeded');
  const fields = artifact.abi.find(item => item.name === 'authorizationDigest')?.inputs[0]?.components;
  assert.deepEqual(fields?.map(({ name, type }) => ({ name, type })), PULSE_AUTHORIZATION_TYPES.PulseMintAuthorization);
  const type = `PulseMintAuthorization(${fields.map(({ name, type }) => `${type} ${name}`).join(',')})`;
  assert.equal(type, PULSE_MINT_CANDIDATE.authorizationType);
  assert.equal(keccak256(stringToHex(type)), PULSE_MINT_CANDIDATE.authorizationTypeHash);
  assert.equal(artifact.abi.some(item => ['receive', 'fallback'].includes(item.type)), false);
  assert.equal(artifact.abi.some(item => item.type === 'function' && item.name === 'mint'), false);
  return {
    compilerVersion: metadata.compiler.version, metadataSha256: jsonDigest(metadata),
    sourceSha256: sha(readSource(`contracts/src/release/${CONTRACT}.sol`)),
    settingsSha256: jsonDigest(metadata.settings), abiSha256: jsonDigest(artifact.abi),
    creationCodeHash: keccak256(creation), runtimeTemplateHash: keccak256(runtime),
    creationBytes, constructorBytes: 17 * 32, runtimeBytes,
    immutableReferences: immutableRanges(artifact, runtime),
  };
}

export function loadPulseArtifact(root = ROOT) {
  return readJson(resolve(root, `contracts/out/${CONTRACT}.sol/${CONTRACT}.json`));
}

/** Computes a review identity. No writing, network, signing or activation. */
export function pulseCandidateSnapshot(root = ROOT) {
  const read = path => readFileSync(resolve(root, path));
  const artifact = loadPulseArtifact(root);
  const renderer = readJson(resolve(root, 'contracts/out/SignatureRendererV1RC1.sol/SignatureRendererV1RC1.json'));
  const { lock: coreLock } = verifyPulseCoreBundle(pathToFileURL(resolve(root, 'contracts/vendor/pulse-core-v1.0.0') + '/'));
  assert.equal(coreLock.runtimeCodeHash, PULSE_MINT_CANDIDATE.pulseRuntimeCodeHash);
  const coreAbi = JSON.parse(read('contracts/vendor/pulse-core-v1.0.0/IPulseCore.abi.json'));
  const selectors = Object.fromEntries(artifact.abi.filter(item => item.type === 'function').map(item =>
    [signature(item), keccak256(stringToHex(signature(item))).slice(0, 10)]).sort(([a], [b]) => a.localeCompare(b)));
  assert.equal(new Set(Object.values(selectors)).size, Object.keys(selectors).length, 'function selector collision');
  const events = Object.fromEntries(artifact.abi.filter(item => item.type === 'event').map(item =>
    [signature(item), keccak256(stringToHex(signature(item)))]).sort(([a], [b]) => a.localeCompare(b)));
  return {
    schema: 'sg-pulse-candidate-lock/v1', status: 'reviewed-for-c6-integration',
    publicDeploymentApproved: false, identity: PULSE_MINT_CANDIDATE,
    authorization: { primaryType: 'PulseMintAuthorization', types: PULSE_AUTHORIZATION_TYPES,
      maxWindowSeconds: 900, validity: 'issuedAt <= timestamp < deadline',
      freeMode: 0, paidMode: 1, paidSlot: String((1n << 256n) - 1n),
      freeValue: '0', paidValue: 'signed maxPrice', freeDeadlineExclusive: true },
    selectors, events,
    foundryConfigSha256: sha(read('contracts/foundry.toml')),
    interfaceSha256: sha(read('contracts/src/release/ISignaturesPulseMintV1RC1.sol')),
    core: { ...coreLock, abiSha256: jsonDigest(coreAbi),
      releaseManifestSha256: sha(read('contracts/vendor/pulse-core-v1.0.0/manifest.json')),
      consumerLockSha256: sha(read('contracts/vendor/pulse-core-v1.0.0/consumer-lock.json')) },
    historicalRelease: verifyRelease(root),
    collection: pulseArtifactIdentity(artifact, read),
    renderer: artifactIdentity(renderer, 'SignatureRendererV1RC1', read),
  };
}

export function assertPulseCandidateLock(snapshot, locked, abi, artifact) {
  assert.deepEqual(snapshot, locked, 'Pulse candidate drift; review changes before updating the lock');
  assert.deepEqual(abi, artifact.abi, 'frozen Pulse ABI drift');
  assert.equal(jsonDigest(abi), locked.collection.abiSha256, 'Pulse ABI hash mismatch');
  return { lockSha256: jsonDigest(locked), status: locked.status, contract: locked.identity.contractName,
    runtimeBytes: locked.collection.runtimeBytes, publicDeploymentApproved: false };
}

export function verifyPulseCandidate(root = ROOT) {
  return assertPulseCandidateLock(pulseCandidateSnapshot(root), readJson(resolve(root, LOCK_PATH)),
    readJson(resolve(root, ABI_PATH)), loadPulseArtifact(root));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  assert.equal(process.argv.length, 2, 'Usage: node --import tsx contracts/tools/pulse-candidate-lock.mjs');
  console.log(JSON.stringify(verifyPulseCandidate(), null, 2));
}
