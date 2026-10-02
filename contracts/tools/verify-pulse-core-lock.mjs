import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'viem';

export function verifyPulseCoreBundle(root = new URL('../vendor/pulse-core-v1.0.0/', import.meta.url)) {
  const read = path => readFileSync(new URL(path, root));
  const json = path => JSON.parse(read(path).toString('utf8'));
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = json('manifest.json');
  const lock = json('consumer-lock.json');
  const sepolia = json('sepolia.json');

  assert.equal(lock.tag, 'pulse-core-v1.0.0');
  assert.equal(lock.tagCommit, 'a08ec26e396b9d3e20ccebd8871f176368bcd713');
  assert.equal(manifest.schema, 'pulse-core-reviewed-build/v1');
  assert.equal(manifest.contract, 'PulseCoreV1');
  assert.equal(manifest.semanticsVersion, lock.semanticsVersion);
  assert.equal(manifest.compiler, lock.compiler);
  assert.equal(manifest.settings.evmVersion, lock.evmVersion);
  assert.deepEqual(manifest.settings.optimizer, { enabled: true, runs: 200 });
  assert.equal(manifest.settings.viaIR, false);
  assert.equal(manifest.versionId, sepolia.versionId);
  assert.equal(manifest.runtimeCodeHash, lock.runtimeCodeHash);
  assert.equal(manifest.runtimeCodeHash, sepolia.runtimeCodeHash);
  assert.equal(manifest.creationCodeHash, sepolia.creationCodeHash);
  assert.equal(sepolia.chainId, 11155111);
  assert.equal(sepolia.address, lock.sepoliaCore);
  assert.deepEqual(lock.supportedChains, [31337, 11155111]);
  assert.equal(lock.mainnetCore, null);

  for (const [path, expected] of Object.entries(manifest.filesSha256)) {
    assert.equal(sha256(read(path)), expected, `release SHA-256 mismatch: ${path}`);
  }
  for (const [path, expected] of Object.entries(manifest.sourceSha256)) {
    assert.equal(sha256(read(path)), expected, `source SHA-256 mismatch: ${path}`);
    assert.equal(sepolia.sourceSha256[path], expected);
  }
  assert.equal(read('IPulseCore.sol').equals(read('src/interfaces/IPulseCore.sol')), true);
  assert.equal(sha256(read('LICENSE')), lock.licenseSha256);

  for (const kind of ['creation', 'runtime']) {
    const code = read(`PulseCoreV1.${kind}.hex`).toString('utf8').trim();
    assert.match(code, /^0x(?:[0-9a-fA-F]{2})+$/);
    assert.equal((code.length - 2) / 2, manifest[`${kind}Bytes`]);
    assert.equal(keccak256(code), manifest[`${kind}CodeHash`]);
  }

  return { lock, manifest };
}

const { lock, manifest } = verifyPulseCoreBundle();

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`Pulse Core ${lock.tag} verified: ${manifest.runtimeCodeHash}`);
}

export { lock, manifest };
