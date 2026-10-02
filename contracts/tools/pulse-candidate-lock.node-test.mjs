import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ABI_PATH, LOCK_PATH, ROOT, loadPulseArtifact, pulseArtifactIdentity, pulseCandidateSnapshot,
  assertPulseCandidateLock, verifyPulseCandidate } from './pulse-candidate-lock.mjs';

const source = path => readFileSync(resolve(ROOT, path));
const locked = JSON.parse(source(LOCK_PATH));
const abi = JSON.parse(source(ABI_PATH));
const artifact = loadPulseArtifact();

test('C5 frozen ABI, exact compiled sources, dependency and historical renderer identities match', () => {
  assert.deepEqual(pulseCandidateSnapshot(), locked);
  assert.equal(verifyPulseCandidate().status, 'reviewed-for-c6-integration');
  assert.equal(verifyPulseCandidate().publicDeploymentApproved, false);
  assert.equal(locked.collection.runtimeBytes, 23819);
  assert.equal(locked.collection.creationBytes + locked.collection.constructorBytes, 44264);
});

test('interface, constructor, selectors, events and each authorization field cannot drift', () => {
  for (const item of abi) {
    const changed = structuredClone(abi), index = abi.indexOf(item);
    if (item.type === 'function') changed[index].stateMutability = 'pure';
    else if (item.type === 'event') changed[index].anonymous = !item.anonymous;
    else changed[index].inputs = [];
    if (JSON.stringify(changed) === JSON.stringify(abi)) changed.splice(index, 1);
    assert.throws(() => assertPulseCandidateLock(locked, locked, changed, artifact), /ABI drift/);
  }
  for (const field of ['schema', 'status', 'publicDeploymentApproved', 'identity', 'authorization', 'selectors',
    'events', 'foundryConfigSha256', 'interfaceSha256', 'core', 'historicalRelease', 'collection', 'renderer']) {
    const changed = structuredClone(locked); changed[field] = null;
    assert.throws(() => assertPulseCandidateLock(locked, changed, abi, artifact), /candidate drift/);
  }
  for (let i = 0; i < 10; ++i) {
    const changed = structuredClone(artifact);
    changed.abi.find(item => item.name === 'authorizationDigest').inputs[0].components[i].type = 'bytes';
    assert.throws(() => pulseArtifactIdentity(changed, source));
  }
});

test('compiler, settings, code, imports and immutable layout cannot bypass the freeze', () => {
  const mutations = [
    a => { a.metadata.compiler.version = '0.8.31'; },
    a => { a.metadata.settings.optimizer.runs = 201; },
    a => { a.metadata.settings.evmVersion = 'shanghai'; },
    a => { a.metadata.settings.viaIR = true; },
    a => { a.metadata.settings.compilationTarget = { 'other.sol': 'Other' }; },
    a => { a.bytecode.linkReferences = { Library: [] }; },
    a => { a.deployedBytecode.linkReferences = { Library: [] }; },
    a => { a.bytecode.object = '0x' + '00'.repeat(49152 - 17 * 32 + 1); },
    a => { a.deployedBytecode.object = '0x' + '00'.repeat(24577); },
    a => { a.metadata.sources['../../.env.local'] = { keccak256: '0x00' }; },
    a => { delete a.metadata.sources['vendor/pulse-core-v1.0.0/IPulseCore.sol']; },
    a => { const groups = Object.values(a.deployedBytecode.immutableReferences); groups[1][0] = { ...groups[0][0] }; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(artifact); mutate(changed);
    assert.throws(() => pulseArtifactIdentity(changed, source));
  }
  for (const path of Object.keys(artifact.metadata.sources)) {
    assert.throws(() => pulseArtifactIdentity(artifact, p => p === `contracts/${path}` ? Buffer.from('changed') : source(p)),
      /stale compiled source/);
  }
  for (const kind of ['bytecode', 'deployedBytecode']) {
    const changed = structuredClone(artifact);
    const last = changed[kind].object.slice(-2);
    changed[kind].object = changed[kind].object.slice(0, -2) + (last === '00' ? '01' : '00');
    const snapshot = structuredClone(locked); snapshot.collection = pulseArtifactIdentity(changed, source);
    assert.throws(() => assertPulseCandidateLock(snapshot, locked, abi, changed), /candidate drift/);
  }
});

test('unrelated compiler AST IDs do not change the reviewed identity', () => {
  const changed = structuredClone(artifact);
  changed.deployedBytecode.immutableReferences = Object.fromEntries(
    Object.values(changed.deployedBytecode.immutableReferences).map((value, i) => [String(100000 + i), value]));
  assert.deepEqual(pulseArtifactIdentity(changed, source), locked.collection);
});

test('verification CLI is read-only and rejects generation or deployment arguments', () => {
  const run = args => spawnSync(process.execPath, ['--import', 'tsx', 'contracts/tools/pulse-candidate-lock.mjs', ...args],
    { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run([]).status, 0);
  for (const flag of ['--write', '--update', '--deploy', '--broadcast']) assert.notEqual(run([flag]).status, 0);
});
