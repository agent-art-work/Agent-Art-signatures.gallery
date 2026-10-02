import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeDeployData, getAddress, getContractAddress, keccak256 } from 'viem';
import { buildAllowlist, normalizeWallet } from './pulse-allowlist.mjs';
import { ROOT, verifyPulseCandidate, loadPulseArtifact, jsonDigest } from './pulse-candidate-lock.mjs';
import { generativeRendererIdentity } from '../../src/openMint/generativeInputs.ts';

export const SEPOLIA = 11155111;
export const GENESIS = '0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9';
export const CORE = '0xfb1Cc26356b1b0361c414Ec1B5fB52c5FEDc3EAC';
export const DEPLOYER = '0x3e4fA9f09d8EDe66561145E1ef3bc127F80ED396';
export const TEST_PULSE = Object.freeze({ k: '600000000000', genesisPrice: '1000000000000', genesisFloor: '900000000000', pts: '1000000000' });
export const INPUT_PROFILE = 'sg-generative-pulse-inputs-v1-rc1';

/** This deliberately narrow planner is for the approved disposable test only.
 * It cannot prepare mainnet or silently turn these numbers into launch policy. */
export function sepoliaTestPlan(input, root = ROOT) {
  assert.deepEqual(Object.keys(input).sort(), ['authorizer', 'createdAt', 'deployer', 'nonce'].sort());
  assert.equal(getAddress(input.deployer), DEPLOYER, 'Unexpected Sepolia test deployer');
  const authorizer = normalizeWallet(input.authorizer);
  assert.notEqual(authorizer, DEPLOYER, 'Separate test authorizer required');
  assert.ok(Number.isSafeInteger(input.createdAt) && input.createdAt > 0 && input.createdAt < 2 ** 48);
  assert.ok(Number.isSafeInteger(input.nonce) && input.nonce >= 0 && input.nonce < Number.MAX_SAFE_INTEGER - 1);
  const candidate = verifyPulseCandidate(root);
  const artifact = loadPulseArtifact(root);
  const rendererArtifact = JSON.parse(readFileSync(resolve(root, 'contracts/out/SignatureRendererV1RC1.sol/SignatureRendererV1RC1.json')));
  const renderer = getContractAddress({ from: DEPLOYER, nonce: BigInt(input.nonce) });
  const collection = getContractAddress({ from: DEPLOYER, nonce: BigInt(input.nonce + 1) });
  const allowlist = buildAllowlist([DEPLOYER, DEPLOYER]);
  const authorities = { adminDelay: 172800, admin: DEPLOYER, manager: DEPLOYER, pauser: DEPLOYER, revoker: DEPLOYER, authorizer };
  const sale = { freeMintRoot: allowlist.manifest.root, freeSlotCount: 2n, freeDeadline: BigInt(input.createdAt + 7 * 86400),
    treasury: DEPLOYER, pulse: Object.fromEntries(Object.entries(TEST_PULSE).map(([k, v]) => [k, BigInt(v)])) };
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [renderer, { chainId: BigInt(SEPOLIA), core: CORE }, sale, authorities] });
  const runtimeHash = keccak256(rendererArtifact.deployedBytecode.object);
  const plan = {
    schema: 'sg-pulse-sepolia-disposable-plan/v1', testOnly: true, productionApproved: false,
    input, chainId: SEPOLIA, genesisHash: GENESIS, candidateLockSha256: candidate.lockSha256, core: CORE,
    governance: 'Test operator roles and treasury share the existing deployer; mint authorizer is separate. Not production custody.',
    assessment: 'Controlled fixtures only. Not Grok assessments; no X/xAI calls.',
    renderer: { address: renderer, nonce: input.nonce, runtimeCodeHash: runtimeHash,
      inputProfile: INPUT_PROFILE, identity: generativeRendererIdentity(renderer, runtimeHash, INPUT_PROFILE), data: rendererArtifact.bytecode.object },
    collection: { address: collection, nonce: input.nonce + 1, data },
    sale: { ...sale, freeSlotCount: '2', freeDeadline: String(sale.freeDeadline), pulse: TEST_PULSE }, authorities,
    allowlist: { manifest: allowlist.manifest, slots: allowlist.slots, tree: allowlist.tree, proofs: allowlist.proofs },
    fees: { maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000', totalWorstCaseWei: '150000000000000000', maxGasPerTransaction: '8000000' },
  };
  return { ...plan, digest: jsonDigest(plan) };
}

export function validateSepoliaTestPlan(plan, root = ROOT) {
  assert.deepEqual(plan, sepoliaTestPlan(plan.input, root), 'Test plan or frozen build changed');
  return plan;
}
