import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { concatHex, encodeAbiParameters, getAddress, keccak256, parseAbiParameters } from 'viem';

export const FORMAT = 'sg-pulse-free-slots-v1';
export const LEAF_ENCODING = Object.freeze(['uint256', 'address']);
const ABI_FIELDS = parseAbiParameters('uint256 slotId, address wallet');
const SHA = bytes => createHash('sha256').update(bytes).digest('hex');
const JSON_BYTES = value => `${JSON.stringify(value, null, 2)}\n`;
const HEX32 = /^0x[0-9a-f]{64}$/;

export function normalizeWallet(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error('Wallet must be a 20-byte 0x hex address.');
  }
  if (/^0x0{40}$/i.test(value)) throw new Error('Zero wallet is not allowed.');
  return getAddress(value);
}

export function parseWalletRows(text) {
  if (typeof text !== 'string') throw new Error('Wallet source must be text.');
  const rows = text.split(/\r?\n/).map(row => row.trim()).filter(Boolean);
  if (rows[0]?.toLowerCase() === 'wallet') rows.shift();
  if (rows.length === 0) throw new Error('Wallet source is empty.');
  return rows.map(normalizeWallet);
}

export function leafForSlot(slotId, wallet) {
  if (!Number.isSafeInteger(slotId) || slotId < 0) throw new Error('Invalid slot ID.');
  const inner = keccak256(encodeAbiParameters(ABI_FIELDS, [BigInt(slotId), normalizeWallet(wallet)]));
  return keccak256(inner);
}

function sortedPairHash(a, b) {
  return keccak256(concatHex(a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]));
}

export function verifySolidityProof(root, leaf, siblings) {
  if (typeof root !== 'string' || !HEX32.test(root.toLowerCase())) return false;
  if (typeof leaf !== 'string' || !HEX32.test(leaf.toLowerCase())) return false;
  if (!Array.isArray(siblings) || siblings.length > 256) return false;
  let hash = leaf;
  for (const sibling of siblings) {
    if (typeof sibling !== 'string' || !HEX32.test(sibling.toLowerCase())) return false;
    hash = sortedPairHash(hash, sibling);
  }
  return hash.toLowerCase() === root.toLowerCase();
}

export function validateSlots(slots) {
  if (!Array.isArray(slots) || slots.length === 0) throw new Error('At least one slot is required.');
  const seen = new Set();
  return slots.map((slot, index) => {
    if (!slot || !Number.isSafeInteger(slot.slotId) || slot.slotId < 0 || slot.slotId >= slots.length) {
      throw new Error('Out-of-range slot ID.');
    }
    if (seen.has(slot.slotId)) throw new Error('Duplicate slot ID.');
    seen.add(slot.slotId);
    if (slot.slotId !== index) throw new Error('Slot IDs must be contiguous in input order.');
    return { slotId: slot.slotId, wallet: normalizeWallet(slot.wallet) };
  });
}

export function buildAllowlist(wallets, sourceBytes = undefined) {
  if (!Array.isArray(wallets) || wallets.length === 0) throw new Error('At least one wallet is required.');
  const slots = validateSlots(wallets.map((wallet, slotId) => ({ slotId, wallet })));
  const tree = StandardMerkleTree.of(slots.map(({ slotId, wallet }) => [String(slotId), wallet]), LEAF_ENCODING);
  const proofs = slots.map(({ slotId, wallet }) => {
    const siblings = tree.getProof(slotId);
    const leaf = leafForSlot(slotId, wallet);
    assert.equal(tree.leafHash([String(slotId), wallet]), leaf);
    assert.equal(verifySolidityProof(tree.root, leaf, siblings), true);
    return { slotId, wallet, leaf, siblings };
  });
  const treeDump = tree.dump();
  const files = {
    'slots.json': JSON_BYTES(slots),
    'tree.json': JSON_BYTES(treeDump),
    'proofs.json': JSON_BYTES(proofs),
  };
  const manifest = {
    format: FORMAT,
    leafEncoding: LEAF_ENCODING,
    slotCount: slots.length,
    root: tree.root,
    sourceSha256: sourceBytes === undefined ? null : SHA(sourceBytes),
    filesSha256: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, SHA(bytes)])),
  };
  return { manifest, slots, tree: treeDump, proofs, files: { ...files, 'manifest.json': JSON_BYTES(manifest) } };
}

export function verifyAllowlistArtifacts(artifacts) {
  const { manifest, slots, tree: dump, proofs } = artifacts;
  if (manifest?.format !== FORMAT || !Array.isArray(manifest.leafEncoding) ||
      JSON.stringify(manifest.leafEncoding) !== JSON.stringify(LEAF_ENCODING)) throw new Error('Wrong allowlist format.');
  const normalized = validateSlots(slots);
  if (JSON.stringify(normalized) !== JSON.stringify(slots)) throw new Error('Noncanonical wallet casing.');
  if (manifest.slotCount !== slots.length) throw new Error('Slot count mismatch.');
  const rebuilt = buildAllowlist(slots.map(slot => slot.wallet));
  if (manifest.root !== rebuilt.manifest.root) throw new Error('Merkle root mismatch.');
  if (JSON.stringify(dump) !== JSON.stringify(rebuilt.tree)) throw new Error('Tree dump mismatch.');
  StandardMerkleTree.load(dump).validate();
  if (!Array.isArray(proofs) || proofs.length !== slots.length) throw new Error('Proof count mismatch.');
  for (const [index, proof] of proofs.entries()) {
    if (JSON.stringify(proof) !== JSON.stringify(rebuilt.proofs[index]) ||
        !verifySolidityProof(manifest.root, proof.leaf, proof.siblings)) {
      throw new Error(`Invalid proof for slot ${index}.`);
    }
  }
  for (const [name, digest] of Object.entries(rebuilt.manifest.filesSha256)) {
    if (manifest.filesSha256?.[name] !== digest) throw new Error(`Artifact SHA-256 mismatch: ${name}.`);
  }
  if (manifest.sourceSha256 !== null &&
      (typeof manifest.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sourceSha256))) {
    throw new Error('Invalid source digest.');
  }
  return true;
}

function cli(args) {
  const [command, first, second] = args;
  if (command === 'build' && first && second && !args[3]) {
    if (existsSync(second)) throw new Error('Output directory already exists; refusing to overwrite it.');
    const source = readFileSync(first);
    const artifact = buildAllowlist(parseWalletRows(source.toString('utf8')), source);
    verifyAllowlistArtifacts(artifact);
    mkdirSync(second);
    for (const [name, bytes] of Object.entries(artifact.files)) writeFileSync(join(second, name), bytes, { flag: 'wx' });
    console.log(`N=${artifact.manifest.slotCount} root=${artifact.manifest.root}`);
    return;
  }
  if (command === 'verify' && first && !second) {
    const manifest = JSON.parse(readFileSync(join(first, 'manifest.json'), 'utf8'));
    const expectedNames = ['slots.json', 'tree.json', 'proofs.json'];
    if (JSON.stringify(Object.keys(manifest.filesSha256 ?? {}).sort()) !== JSON.stringify([...expectedNames].sort())) {
      throw new Error('Unexpected artifact file list.');
    }
    for (const name of expectedNames) {
      const digest = manifest.filesSha256[name];
      if (SHA(readFileSync(join(first, name))) !== digest) throw new Error(`File SHA-256 mismatch: ${name}.`);
    }
    const read = name => JSON.parse(readFileSync(join(first, name), 'utf8'));
    const artifact = { manifest, slots: read('slots.json'), tree: read('tree.json'), proofs: read('proofs.json') };
    verifyAllowlistArtifacts(artifact);
    console.log(`Verified N=${artifact.manifest.slotCount} root=${artifact.manifest.root}`);
    return;
  }
  throw new Error('Usage: pulse-allowlist.mjs build <wallets.txt> <new-output-dir> | verify <output-dir>');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) cli(process.argv.slice(2));
