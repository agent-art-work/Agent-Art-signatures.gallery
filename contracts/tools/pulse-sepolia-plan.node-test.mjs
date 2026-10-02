import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeAbiParameters, getAddress, keccak256 } from 'viem';
import { sepoliaTestPlan, validateSepoliaTestPlan, DEPLOYER, CORE } from './pulse-sepolia-plan.mjs';
import { loadPulseArtifact } from './pulse-candidate-lock.mjs';
import { verifyAllowlistArtifacts } from './pulse-allowlist.mjs';
const input = { deployer: DEPLOYER, authorizer: '0x8888888888888888888888888888888888888888', nonce: 81, createdAt: 1790474400 };

test('disposable Sepolia plan locks bytes, immutable config, ordered duplicate slots and exact CREATE nonces', () => {
  const p = sepoliaTestPlan(input), artifact = loadPulseArtifact();
  assert.equal(p.chainId, 11155111); assert.equal(p.core, CORE); assert.equal(p.testOnly, true); assert.equal(p.productionApproved, false);
  assert.notEqual(p.renderer.address, p.collection.address); assert.equal(p.collection.nonce, 82);
  assert.equal(p.sale.freeDeadline, String(input.createdAt + 604800)); assert.equal(p.sale.freeSlotCount, '2');
  assert.equal(verifyAllowlistArtifacts(p.allowlist), true);
  assert.deepEqual(p.allowlist.slots.map(x => x.wallet), [DEPLOYER, DEPLOYER]);
  const encoded = '0x' + p.collection.data.slice(artifact.bytecode.object.length);
  const [renderer, core, sale, roles] = decodeAbiParameters(artifact.abi.find(x => x.type === 'constructor').inputs, encoded);
  assert.equal(renderer, getAddress(p.renderer.address)); assert.equal(core.chainId, 11155111n); assert.equal(core.core, CORE);
  assert.equal(sale.freeMintRoot, p.allowlist.manifest.root); assert.equal(sale.freeSlotCount, 2n);
  assert.equal(roles.authorizer, input.authorizer); assert.notEqual(roles.authorizer, roles.admin);
  assert.deepEqual(validateSepoliaTestPlan(p), p); assert.notEqual(keccak256(p.collection.data), keccak256(p.renderer.data));
});

test('refuses unexpected fields, crossed signer and malformed quantities', () => {
  for (const patch of [{ chainId: 1 }, { deployer: input.authorizer }, { authorizer: DEPLOYER }, { authorizer: '0x' + '0'.repeat(40) },
    { nonce: -1 }, { nonce: 0.5 }, { nonce: Number.MAX_SAFE_INTEGER }, { createdAt: 0 }, { createdAt: NaN }]) {
    assert.throws(() => sepoliaTestPlan({ ...input, ...patch }));
  }
});

test('refuses mutation of every deployment-sensitive plan field', () => {
  const p = sepoliaTestPlan(input);
  const mutations = [q => q.chainId = 1, q => q.core = DEPLOYER, q => q.sale.freeDeadline = '1', q => q.sale.freeSlotCount = '3',
    q => q.authorities.authorizer = DEPLOYER, q => q.sale.pulse.genesisPrice = '100', q => q.collection.data += '00',
    q => q.allowlist.proofs[0].wallet = input.authorizer, q => q.renderer.runtimeCodeHash = '0x' + '0'.repeat(64),
    q => q.fees.totalWorstCaseWei = '999999999999999999', q => q.productionApproved = true, q => q.testOnly = false];
  for (const mutate of mutations) { const q = structuredClone(p); mutate(q); assert.throws(() => validateSepoliaTestPlan(q)); }
});
