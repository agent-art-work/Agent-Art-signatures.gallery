import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, stringToHex } from 'viem';
import { ROOT, jsonDigest, verifyPulseCandidate } from './pulse-candidate-lock.mjs';
import { PULSE_ADMIN_PROFILE, PULSE_ADMIN_AUTHORIZATION_TYPES } from '../../src/openMint/pulseAdminAuthorization.ts';

export const CONTRACT = 'SignaturesPulseMintV1RC2';
export const LOCK_PATH = 'contracts/releases/generative-pulse-v1-rc2.json';
export const ABI_PATH = 'contracts/releases/generative-pulse-v1-rc2.abi.json';
const sha = value => createHash('sha256').update(value).digest('hex');
export function loadPulseAdminArtifact(root = ROOT) {
  return JSON.parse(readFileSync(resolve(root, `contracts/out/${CONTRACT}.sol/${CONTRACT}.json`), 'utf8'));
}

/** RC2 has its own reviewed identity, ABI and signing domain. RC1 is not relocked. */
export function pulseAdminCandidateSnapshot(root = ROOT) {
  const previous = verifyPulseCandidate(root), artifact = loadPulseAdminArtifact(root);
  const read = path => readFileSync(resolve(root, path));
  const { metadata, abi } = artifact;
  assert.equal(metadata.compiler.version, '0.8.30+commit.73712a01');
  assert.deepEqual(metadata.settings, {
    remappings: ['@openzeppelin/contracts/=../node_modules/@openzeppelin/contracts/'],
    optimizer: { enabled: true, runs: 200 }, metadata: { bytecodeHash: 'ipfs' },
    compilationTarget: { [`src/release/${CONTRACT}.sol`]: CONTRACT }, evmVersion: 'prague', libraries: {},
  });
  const sources = {};
  for (const [path, source] of Object.entries(metadata.sources)) {
    assert.ok(/^src\/release\/(?:I?SignaturesPulseMintV1RC2|SignatureRendererV1RC1)\.sol$/.test(path) ||
      path === 'vendor/pulse-core-v1.0.0/IPulseCore.sol' ||
      /^\.\.\/node_modules\/@openzeppelin\/contracts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.sol$/.test(path));
    const bytes = read(`contracts/${path}`);
    assert.equal(keccak256(bytes), source.keccak256, `Stale RC2 source: ${path}`);
    sources[path] = sha(bytes);
  }
  for (const path of [`src/release/${CONTRACT}.sol`, 'src/release/ISignaturesPulseMintV1RC2.sol',
    'src/release/SignatureRendererV1RC1.sol', 'vendor/pulse-core-v1.0.0/IPulseCore.sol']) assert.ok(sources[path]);
  const fields = abi.find(item => item.name === 'authorizationDigest').inputs[0].components.map(({ name, type }) => ({ name, type }));
  assert.deepEqual(fields, PULSE_ADMIN_AUTHORIZATION_TYPES.PulseMintAuthorization);
  assert.ok(abi.some(item => item.type === 'function' && item.name === 'configureFreeMint'));
  assert.equal(abi.some(item => ['receive', 'fallback'].includes(item.type)), false);
  assert.equal(abi.some(item => item.type === 'function' && item.name === 'mint'), false);
  const creation = artifact.bytecode.object, runtime = artifact.deployedBytecode.object;
  for (const code of [artifact.bytecode, artifact.deployedBytecode]) {
    assert.deepEqual(code.linkReferences ?? {}, {}); assert.match(code.object, /^0x(?:[a-f0-9]{2})+$/);
  }
  const runtimeBytes = (runtime.length - 2) / 2, creationBytes = (creation.length - 2) / 2;
  assert.ok(runtimeBytes <= 24576 && creationBytes + 18 * 32 <= 49152);
  const occupied = new Set();
  const immutableReferences = Object.values(artifact.deployedBytecode.immutableReferences).map(group =>
    [...group].sort((a, b) => a.start - b.start)).sort((a, b) => a[0].start - b[0].start);
  for (const group of immutableReferences) for (const ref of group) {
    assert.ok(ref.length === 32 && Number.isSafeInteger(ref.start) && ref.start >= 0 && ref.start + 32 <= runtimeBytes);
    assert.equal(runtime.slice(2 + ref.start * 2, 2 + (ref.start + 32) * 2), '0'.repeat(64));
    for (let n = ref.start; n < ref.start + 32; n++) { assert.ok(!occupied.has(n)); occupied.add(n); }
  }
  return { schema: 'sg-pulse-admin-candidate-lock/v1', status: 'sepolia-disposable-test-candidate',
    productionApproved: false, contractProfile: PULSE_ADMIN_PROFILE, contractName: CONTRACT,
    version: 'sg-generative-pulse-mint-1.0.0-rc.2', inputProfile: 'sg-generative-pulse-inputs-v1-rc1',
    domainName: 'SignaturesPulseMintRC2', domainVersion: '1', previousCandidateLockSha256: previous.lockSha256,
    authorizationTypes: PULSE_ADMIN_AUTHORIZATION_TYPES,
    authorizationTypeHash: keccak256(stringToHex(`PulseMintAuthorization(${fields.map(f => `${f.type} ${f.name}`).join(',')})`)),
    compiler: metadata.compiler.version, settingsSha256: jsonDigest(metadata.settings), metadataSha256: jsonDigest(metadata),
    sourceSha256: sources, abiSha256: jsonDigest(abi), creationCodeHash: keccak256(creation), runtimeTemplateHash: keccak256(runtime),
    creationBytes, constructorBytes: 18 * 32, runtimeBytes, immutableReferences,
    adminPolicy: 'Paused default admin only; persistent claimed slots; monotonic capacity and revision; quota/deadline first; paid phase irreversible.' };
}

export function verifyPulseAdminCandidate(root = ROOT) {
  const snapshot = pulseAdminCandidateSnapshot(root);
  const lock = JSON.parse(readFileSync(resolve(root, LOCK_PATH), 'utf8'));
  const abi = JSON.parse(readFileSync(resolve(root, ABI_PATH), 'utf8'));
  assert.deepEqual(snapshot, lock, 'RC2 build drift requires review, not automatic relocking');
  assert.deepEqual(abi, loadPulseAdminArtifact(root).abi, 'RC2 frozen ABI drift');
  return { lockSha256: jsonDigest(lock), contract: CONTRACT, contractProfile: PULSE_ADMIN_PROFILE,
    runtimeBytes: snapshot.runtimeBytes, productionApproved: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2);
  console.log(JSON.stringify(verifyPulseAdminCandidate(), null, 2));
}
