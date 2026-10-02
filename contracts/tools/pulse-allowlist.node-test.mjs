import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { buildAllowlist, leafForSlot, parseWalletRows, validateSlots, verifyAllowlistArtifacts, verifySolidityProof } from './pulse-allowlist.mjs';

const walletA = '0x1111111111111111111111111111111111111111';
const walletB = '0x2222222222222222222222222222222222222222';
const tool = fileURLToPath(new URL('./pulse-allowlist.mjs', import.meta.url));

test('one slot matches the C1 double-hashed Solidity leaf and accepts empty proof', () => {
  const artifacts = buildAllowlist([walletA]);
  assert.equal(artifacts.manifest.root, '0x53d1ea11c02bccf00efa13950923d7ec0991024794dcc0a5de4788c13baf062c');
  assert.equal(leafForSlot(0, walletA), artifacts.manifest.root);
  assert.deepEqual(artifacts.proofs[0].siblings, []);
  assert.equal(verifySolidityProof(artifacts.manifest.root, artifacts.proofs[0].leaf, []), true);
});

test('repeated wallets remain distinct numbered entitlements with Solidity proofs', () => {
  const artifacts = buildAllowlist([walletA, walletB, walletA]);
  assert.equal(artifacts.manifest.root, '0xd56fcadc336e04d31a7146c6472fd61dc315e9dd74f8b56b7b25166b4402b36a');
  assert.deepEqual(artifacts.slots.map(slot => slot.slotId), [0, 1, 2]);
  assert.notEqual(artifacts.proofs[0].leaf, artifacts.proofs[2].leaf);
  assert.equal(verifyAllowlistArtifacts(artifacts), true);
  for (const proof of artifacts.proofs) assert.equal(verifySolidityProof(artifacts.manifest.root, proof.leaf, proof.siblings), true);
  assert.equal(verifySolidityProof(artifacts.manifest.root, artifacts.proofs[0].leaf, artifacts.proofs[2].siblings), false);
});

test('1,025 slots are deterministic and have bounded proofs', () => {
  const wallets = Array.from({ length: 1025 }, (_, index) => getAddress(`0x${(index % 257 + 1).toString(16).padStart(40, '0')}`));
  const first = buildAllowlist(wallets);
  const second = buildAllowlist(wallets);
  assert.equal(first.files['manifest.json'], second.files['manifest.json']);
  assert.equal(first.files['tree.json'], second.files['tree.json']);
  assert.equal(first.manifest.slotCount, 1025);
  assert.ok(Math.max(...first.proofs.map(proof => proof.siblings.length)) < 256);
  assert.equal(verifyAllowlistArtifacts(first), true);
});

test('rejects malformed, zero, duplicate and out-of-range slot inputs', () => {
  assert.throws(() => parseWalletRows('wallet\n'), /empty/);
  assert.throws(() => parseWalletRows('0x0000000000000000000000000000000000000000'), /Zero/);
  assert.throws(() => parseWalletRows('hello'), /20-byte/);
  assert.throws(() => validateSlots([{ slotId: 0, wallet: walletA }, { slotId: 0, wallet: walletB }]), /Duplicate/);
  assert.throws(() => validateSlots([{ slotId: 1, wallet: walletA }]), /Out-of-range/);
  assert.throws(() => leafForSlot(-1, walletA), /Invalid/);
  assert.equal(verifySolidityProof('0x' + '0'.repeat(64), '0x' + '0'.repeat(64), ['bad']), false);
});

test('tampered artifact content or proof is rejected', () => {
  const good = buildAllowlist([walletA, walletB, walletA]);
  const artifact = structuredClone(good);
  artifact.proofs[1].siblings[0] = '0x' + '0'.repeat(64);
  assert.throws(() => verifyAllowlistArtifacts(artifact), /Invalid proof/);
  const changed = structuredClone(good);
  changed.slots[2].wallet = walletB;
  assert.throws(() => verifyAllowlistArtifacts(changed), /Merkle root mismatch/);
});

test('CLI exports a verifiable bundle and refuses to overwrite it', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sg-pulse-slots-'));
  try {
    const source = fileURLToPath(new URL('../fixtures/pulse-wallets.example.txt', import.meta.url));
    const output = join(temp, 'bundle');
    execFileSync(process.execPath, [tool, 'build', source, output]);
    execFileSync(process.execPath, [tool, 'verify', output]);
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.slotCount, 3);
    assert.throws(() => execFileSync(process.execPath, [tool, 'build', source, output], { stdio: 'pipe' }), /already exists/);
    const path = join(output, 'slots.json');
    writeFileSync(path, readFileSync(path, 'utf8') + '\n');
    assert.throws(() => execFileSync(process.execPath, [tool, 'verify', output], { stdio: 'pipe' }), /File SHA-256 mismatch/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('local example inputs bind the pinned core and example wallet root', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/pulse-local-deployment.example.json', import.meta.url), 'utf8'));
  const wallets = parseWalletRows(readFileSync(new URL('../fixtures/pulse-wallets.example.txt', import.meta.url), 'utf8'));
  const release = JSON.parse(readFileSync(new URL('../vendor/pulse-core-v1.0.0/consumer-lock.json', import.meta.url), 'utf8'));
  assert.equal(fixture.chainId, 31337);
  assert.equal(fixture.renderer.address, null);
  assert.equal(fixture.core.address, null);
  assert.equal(fixture.core.runtimeCodeHash, release.runtimeCodeHash);
  assert.equal(fixture.sale.freeSlotCount, wallets.length);
  assert.equal(fixture.sale.freeMintRoot, buildAllowlist(wallets).manifest.root);
  assert.deepEqual(fixture.sale.pulse, { k: '600', genesisPrice: '1000', genesisFloor: '900', pts: '1' });
});
