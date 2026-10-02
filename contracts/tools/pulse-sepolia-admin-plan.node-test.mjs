import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAbiParameters, getAddress, getContractAddress } from 'viem';
import { ADMIN_PROFILE, ADMIN_RENDERER, ADMIN_TEST_WALLET, sepoliaAdminTestPlan,
  validateSepoliaAdminTestPlan, planAdminFreeUpdate } from './pulse-sepolia-admin-plan.mjs';
import { loadPulseAdminArtifact } from './pulse-admin-candidate.mjs';
import { DEPLOYER } from './pulse-sepolia-plan.mjs';
import { verifyAllowlistArtifacts } from './pulse-allowlist.mjs';

const input = { deployer: DEPLOYER, authorizer: '0x8888888888888888888888888888888888888888', nonce: 81, createdAt: 1790935200 };
const plan = sepoliaAdminTestPlan(input);
const current = { paused: true, phase: 0, root: plan.sale.freeMintRoot, slotCount: '2', quota: '2', revision: '1',
  freeMinted: '0', timestamp: String(input.createdAt), freeDeadline: plan.sale.freeDeadline };
const wallets = [DEPLOYER, DEPLOYER, ADMIN_TEST_WALLET, ADMIN_TEST_WALLET];

test('RC2 plan reuses the exact renderer and deploys one collection at the planned nonce', () => {
  assert.equal(plan.contractProfile, ADMIN_PROFILE); assert.equal(plan.chainId, 11155111);
  assert.equal(plan.renderer.address, ADMIN_RENDERER);
  assert.equal(Object.hasOwn(plan.renderer, 'nonce'), false); assert.equal(Object.hasOwn(plan.renderer, 'data'), false);
  assert.equal(plan.collection.nonce, input.nonce);
  assert.equal(plan.collection.address, getContractAddress({ from: DEPLOYER, nonce: 81n }));
  const artifact = loadPulseAdminArtifact(), encoded = '0x' + plan.collection.data.slice(artifact.bytecode.object.length);
  const [renderer, core, sale, roles] = decodeAbiParameters(artifact.abi.find(item => item.type === 'constructor').inputs, encoded);
  assert.equal(renderer, getAddress(ADMIN_RENDERER)); assert.equal(core.chainId, 11155111n);
  assert.equal(sale.freeSlotCount, 2n); assert.equal(sale.freeMintQuota, 2n);
  assert.equal(sale.freeDeadline, BigInt(input.createdAt + 604800)); assert.equal(sale.freeMintRoot, plan.allowlist.manifest.root);
  assert.equal(roles.authorizer, input.authorizer); assert.notEqual(roles.authorizer, roles.admin);
  assert.ok((plan.collection.data.length - 2) / 2 <= 49152);
  assert.equal(verifyAllowlistArtifacts(plan.allowlist), true);
  assert.equal(plan.testOnly, true); assert.equal(plan.productionApproved, false);
  assert.deepEqual(validateSepoliaAdminTestPlan(plan), plan);
});

test('RC2 planner rejects foreign chain inputs, alternate custody and malformed quantities', () => {
  for (const patch of [{ chainId: 1 }, { deployer: input.authorizer }, { authorizer: DEPLOYER },
    { authorizer: '0x' + '0'.repeat(40) }, { nonce: -1 }, { nonce: 0.5 }, { nonce: Number.MAX_SAFE_INTEGER },
    { createdAt: 0 }, { createdAt: NaN }, { createdAt: 2 ** 48 }])
    assert.throws(() => sepoliaAdminTestPlan({ ...input, ...patch }));
});

test('changing any deployment-sensitive plan field is detected, including the new quota and domain profile', () => {
  const mutations = [p => p.contractProfile = 'generative-pulse-v1-rc1', p => p.chainId = 1,
    p => p.sale.freeMintQuota = '1', p => p.sale.freeSlotCount = '3', p => p.sale.freeDeadline = '1',
    p => p.sale.pulse.genesisPrice = '1', p => p.collection.nonce++, p => p.collection.data += '00',
    p => p.renderer.address = DEPLOYER, p => p.authorities.authorizer = DEPLOYER,
    p => p.allowlist.proofs[0].wallet = ADMIN_TEST_WALLET, p => p.fees.totalWorstCaseWei = '999999999999999999',
    p => p.testOnly = false, p => p.productionApproved = true];
  for (const mutate of mutations) { const p = structuredClone(plan); mutate(p); assert.throws(() => validateSepoliaAdminTestPlan(p)); }
});

test('admin free update appends distinct wallet slots without deduplicating repeated addresses', () => {
  const next = planAdminFreeUpdate(plan.allowlist, wallets, '4', current);
  assert.equal(next.revision, '2'); assert.equal(next.slotCount, '4'); assert.equal(next.quota, '4');
  assert.notEqual(next.root, current.root); assert.equal(verifyAllowlistArtifacts(next.allowlist), true);
  assert.deepEqual(next.allowlist.slots.map(row => row.wallet), wallets);
  assert.deepEqual(next.allowlist.slots.map(row => row.slotId), [0, 1, 2, 3]);
});

test('updates need paused pre-paid state and exact previous artifacts', () => {
  for (const patch of [{ paused: false }, { phase: 1 }, { timestamp: current.freeDeadline },
    { root: '0x' + '1'.repeat(64) }, { slotCount: '3' }, { revision: '0' }, { revision: String((1n << 64n) - 1n) }])
    assert.throws(() => planAdminFreeUpdate(plan.allowlist, wallets, '4', { ...current, ...patch }));
  const bad = structuredClone(plan.allowlist); bad.proofs[0].siblings = [];
  assert.throws(() => planAdminFreeUpdate(bad, wallets, '4', current));
});

test('IDs cannot shrink or change wallets without block-pinned unclaimed-slot evidence', () => {
  for (const rows of [[DEPLOYER], [ADMIN_TEST_WALLET, DEPLOYER], [DEPLOYER, ADMIN_TEST_WALLET, DEPLOYER]])
    assert.throws(() => planAdminFreeUpdate(plan.allowlist, rows, '1', current));
  assert.throws(() => planAdminFreeUpdate(plan.allowlist, [DEPLOYER, DEPLOYER, '0x' + '0'.repeat(40)], '1', current));
});

test('unclaimed existing wallets may be updated but claimed wallets cannot be replaced', () => {
  const rows = [ADMIN_TEST_WALLET, DEPLOYER];
  const next = planAdminFreeUpdate(plan.allowlist, rows, '2', { ...current, claimedSlotIds: [] });
  assert.notEqual(next.root, current.root); assert.equal(next.revision, '2');
  assert.deepEqual(next.allowlist.slots.map(row => row.wallet), rows);
  assert.throws(() => planAdminFreeUpdate(plan.allowlist, rows, '2', current), /block-pinned/);
  assert.throws(() => planAdminFreeUpdate(plan.allowlist, rows, '2', { ...current, claimedSlotIds: ['0'] }), /claimed slot wallet/);
  for (const claimedSlotIds of [['0', '0'], ['2'], ['-1'], ['1.5']])
    assert.throws(() => planAdminFreeUpdate(plan.allowlist, rows, '2', { ...current, claimedSlotIds }));
});

test('quota supports conservative early closure but never drops below successfully minted tokens', () => {
  const sameSlots = [DEPLOYER, DEPLOYER];
  assert.equal(planAdminFreeUpdate(plan.allowlist, sameSlots, '0', current).quota, '0');
  assert.equal(planAdminFreeUpdate(plan.allowlist, sameSlots, '1', { ...current, freeMinted: '1' }).quota, '1');
  assert.throws(() => planAdminFreeUpdate(plan.allowlist, sameSlots, '0', { ...current, freeMinted: '1' }));
  for (const quota of ['3', '-1', '1.5', '01', 'abc']) assert.throws(() => planAdminFreeUpdate(plan.allowlist, sameSlots, quota, current));
});
