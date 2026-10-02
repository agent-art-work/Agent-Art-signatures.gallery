import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encodeDeployData, hashTypedData, keccak256, toBytes, toFunctionSelector } from 'viem';
import { PULSE_MINT_CANDIDATE } from '../../src/openMint/pulseCandidate.ts';

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const candidate = readJson('../out/SignaturesPulseMintV1RC1.sol/SignaturesPulseMintV1RC1.json');
const contractInterface = readJson('../out/ISignaturesPulseMintV1RC1.sol/ISignaturesPulseMintV1RC1.json');
const clean = value => {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'internalType').map(([key, child]) => [key, clean(child)]));
  return value;
};

test('Solidity test fixture deploys the exact vendored release creation bytes', () => {
  const source = readFileSync(new URL('../test/fixtures/PulseCoreReleaseData.sol', import.meta.url), 'utf8');
  const fixture = source.match(/return hex"([0-9a-f]+)";/)?.[1];
  const release = readFileSync(new URL('../vendor/pulse-core-v1.0.0/PulseCoreV1.creation.hex', import.meta.url), 'utf8').trim();
  assert.ok(fixture);
  assert.equal(`0x${fixture}`, release);
});

test('candidate implements every frozen C1 interface member with the same ABI', () => {
  for (const item of contractInterface.abi) {
    const actual = candidate.abi.find(entry => entry.type === item.type && entry.name === item.name);
    assert.ok(actual, `missing ${item.type} ${item.name}`);
    assert.deepEqual(clean(actual), clean(item));
  }
  assert.equal(candidate.abi.some(item => item.type === 'function' && item.name === 'mint'), false, 'legacy route leaked');
  assert.equal(candidate.abi.some(item => item.type === 'receive' || item.type === 'fallback'), false);
  assert.equal(toFunctionSelector(candidate.abi.find(item => item.name === 'mintFree')), '0x1cc08a94');
  assert.equal(toFunctionSelector(candidate.abi.find(item => item.name === 'mintPaid')), '0x4f2e209c');
});

test('compiled authorization tuple reproduces the TypeScript lock and Solidity test vector', () => {
  const fields = candidate.abi.find(item => item.name === 'authorizationDigest').inputs[0].components.map(({ name, type }) => ({ name, type }));
  const type = `PulseMintAuthorization(${fields.map(field => `${field.type} ${field.name}`).join(',')})`;
  assert.equal(type, PULSE_MINT_CANDIDATE.authorizationType);
  assert.equal(keccak256(toBytes(type)), PULSE_MINT_CANDIDATE.authorizationTypeHash);
  const digest = hashTypedData({
    domain: { name: PULSE_MINT_CANDIDATE.domainName, version: '1', chainId: 31337, verifyingContract: '0x000000000000000000000000000000000000b001' },
    types: { PulseMintAuthorization: fields },
    primaryType: 'PulseMintAuthorization',
    message: {
      handleKey: '0x' + '11'.repeat(32), assessmentDigest: '0x' + '22'.repeat(32), inputDigest: '0x' + '33'.repeat(32),
      recipient: '0x1111111111111111111111111111111111111111', nonce: '0x' + '44'.repeat(32),
      issuedAt: 1800000000n, deadline: 1800000900n, mintMode: 1, slotId: (1n << 256n) - 1n, maxPrice: 1200n,
    },
  });
  assert.equal(digest, '0x16c6ee99a3916d62d07bf24b02096759cf1c0daad23d8a8b599179cfb2f2c262');
});

test('candidate runtime and full constructor data fit Ethereum code size limits', () => {
  const fixture = readJson('../fixtures/pulse-local-deployment.example.json');
  const data = encodeDeployData({
    abi: candidate.abi,
    bytecode: candidate.bytecode.object,
    args: [
      '0x1111111111111111111111111111111111111111',
      { chainId: 31337n, core: '0x2222222222222222222222222222222222222222' },
      fixture.sale,
      fixture.authorities,
    ],
  });
  assert.ok((candidate.deployedBytecode.object.length - 2) / 2 <= 24576, 'EIP-170 runtime too large');
  assert.ok((data.length - 2) / 2 <= 49152, 'EIP-3860 initcode too large');
});
