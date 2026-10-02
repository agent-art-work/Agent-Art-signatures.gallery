import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeDeployData, getAddress, getContractAddress, keccak256 } from 'viem';
import { buildAllowlist, normalizeWallet, verifyAllowlistArtifacts } from './pulse-allowlist.mjs';
import { ROOT, jsonDigest } from './pulse-candidate-lock.mjs';
import { loadPulseAdminArtifact, verifyPulseAdminCandidate } from './pulse-admin-candidate.mjs';
import { verifyRelease } from './generative-release.mjs';
import { CORE, DEPLOYER, GENESIS, INPUT_PROFILE, SEPOLIA, TEST_PULSE } from './pulse-sepolia-plan.mjs';
import { generativeRendererIdentity } from '../../src/openMint/generativeInputs.ts';

export const ADMIN_PROFILE = 'generative-pulse-v1-rc2';
export const ADMIN_RENDERER = '0x954b4Ee81F46a04435792A6deeA5126F058b13C1';
export const ADMIN_TEST_WALLET = '0x170AF4D923De5E3155067e104134C3b11d82E100';
const uint = value => { assert.match(String(value), /^(0|[1-9][0-9]*)$/); return BigInt(value); };

/** Disposable Sepolia only. Initial two slots are not consumed by deployment. */
export function sepoliaAdminTestPlan(input, root = ROOT) {
  assert.deepEqual(Object.keys(input).sort(), ['authorizer', 'createdAt', 'deployer', 'nonce'].sort());
  assert.equal(getAddress(input.deployer), DEPLOYER, 'Unexpected Sepolia deployer');
  const authorizer = normalizeWallet(input.authorizer);
  assert.notEqual(authorizer, DEPLOYER, 'A separate test authorizer is required');
  assert.ok(Number.isSafeInteger(input.createdAt) && input.createdAt > 0 && input.createdAt < 2 ** 48);
  assert.ok(Number.isSafeInteger(input.nonce) && input.nonce >= 0 && input.nonce < Number.MAX_SAFE_INTEGER);
  const candidate = verifyPulseAdminCandidate(root), artifact = loadPulseAdminArtifact(root);
  verifyRelease(root);
  const rendererArtifact = JSON.parse(readFileSync(resolve(root, 'contracts/out/SignatureRendererV1RC1.sol/SignatureRendererV1RC1.json')));
  const allowlist = buildAllowlist([DEPLOYER, DEPLOYER]);
  const collection = getContractAddress({ from: DEPLOYER, nonce: BigInt(input.nonce) });
  const runtimeCodeHash = keccak256(rendererArtifact.deployedBytecode.object);
  const renderer = { address: ADMIN_RENDERER, runtimeCodeHash, inputProfile: INPUT_PROFILE,
    identity: generativeRendererIdentity(ADMIN_RENDERER, runtimeCodeHash, INPUT_PROFILE) };
  const authorities = { adminDelay: 172800, admin: DEPLOYER, manager: DEPLOYER, pauser: DEPLOYER,
    revoker: DEPLOYER, authorizer };
  const sale = { freeMintRoot: allowlist.manifest.root, freeSlotCount: 2n, freeMintQuota: 2n,
    freeDeadline: BigInt(input.createdAt + 7 * 86400), treasury: DEPLOYER,
    pulse: Object.fromEntries(Object.entries(TEST_PULSE).map(([k, v]) => [k, BigInt(v)])) };
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object,
    args: [renderer.address, { chainId: BigInt(SEPOLIA), core: CORE }, sale, authorities] });
  assert.ok((data.length - 2) / 2 <= 49152, 'Constructor exceeds EIP-3860');
  const plan = {
    schema: 'sg-pulse-sepolia-admin-plan/v1', contractProfile: ADMIN_PROFILE, testOnly: true, productionApproved: false,
    input, chainId: SEPOLIA, genesisHash: GENESIS, candidateLockSha256: candidate.lockSha256, core: CORE,
    governance: 'Disposable test: deployer holds admin/manager/pauser/revoker and treasury; mint authorizer is separate.',
    assessment: 'Controlled fixture only, not a Grok assessment. No X/xAI requests.',
    renderer, collection: { address: collection, nonce: input.nonce, data },
    sale: { ...sale, freeSlotCount: '2', freeMintQuota: '2', freeDeadline: String(sale.freeDeadline), pulse: TEST_PULSE },
    authorities, allowlist: { manifest: allowlist.manifest, slots: allowlist.slots, tree: allowlist.tree, proofs: allowlist.proofs },
    fees: { maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000', totalWorstCaseWei: '150000000000000000', maxGasPerTransaction: '8000000' },
  };
  return { ...plan, digest: jsonDigest(plan) };
}

export function validateSepoliaAdminTestPlan(plan, root = ROOT) {
  assert.deepEqual(plan, sepoliaAdminTestPlan(plan.input, root), 'Admin deployment plan or frozen build changed');
  return plan;
}

/** Full ordered wallet source: additions append IDs, and only proven unclaimed
 * existing IDs may change wallets. Claims live in the contract and never reset. */
export function planAdminFreeUpdate(previous, wallets, quotaValue, current) {
  verifyAllowlistArtifacts(previous);
  assert.equal(current.paused, true, 'Pause minting before changing the free policy');
  assert.equal(current.phase, 0, 'Paid phase cannot be reopened');
  assert.ok(uint(current.timestamp) < uint(current.freeDeadline), 'Free deadline has passed');
  assert.equal(previous.manifest.root, current.root, 'Current allowlist artifacts do not match the chain');
  assert.equal(BigInt(previous.slots.length), uint(current.slotCount), 'Current slot capacity mismatch');
  assert.ok(Array.isArray(wallets) && wallets.length >= previous.slots.length, 'Slot IDs cannot shrink');
  const normalized = wallets.map(normalizeWallet);
  const changed = previous.slots.filter((slot, i) => normalized[i] !== slot.wallet).map(slot => String(slot.slotId));
  if (changed.length) {
    assert.ok(Array.isArray(current.claimedSlotIds), 'Replacement wallets need block-pinned claim evidence');
    const claimed = current.claimedSlotIds.map(id => String(uint(id)));
    assert.equal(new Set(claimed).size, claimed.length, 'Duplicate claimed slot evidence');
    assert.ok(claimed.every(id => BigInt(id) < uint(current.slotCount)), 'Claimed slot evidence out of range');
    assert.ok(changed.every(id => !claimed.includes(id)), 'A claimed slot wallet cannot be replaced');
  }
  const quota = uint(quotaValue), freeMinted = uint(current.freeMinted), revision = uint(current.revision);
  assert.ok(quota >= freeMinted && quota <= BigInt(normalized.length), 'Quota must cover successful free mints and fit slot capacity');
  assert.ok(revision > 0n && revision < (1n << 64n) - 1n, 'Free policy revision is out of range');
  const allowlist = buildAllowlist(normalized);
  return { schema: 'sg-pulse-free-configuration/v1', root: allowlist.manifest.root,
    slotCount: String(normalized.length), quota: String(quota), revision: String(revision + 1n),
    allowlist: { manifest: allowlist.manifest, slots: allowlist.slots, tree: allowlist.tree, proofs: allowlist.proofs } };
}
