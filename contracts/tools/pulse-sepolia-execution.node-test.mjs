import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { validateSignedStep, rpcTransport, main } from '../../scripts/pulse-sepolia.mjs';

const wallet = privateKeyToAccount('0x' + '1'.padStart(64, '0'));
const fees = { maxGasPerTransaction: '8000000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' };
const request = { to: wallet.address, data: '0x12345678', value: '0x1' };
const transaction = { chainId: 11155111, type: 'eip1559', nonce: 5, gas: 100000n, maxFeePerGas: 2000000000n,
  maxPriorityFeePerGas: 1000000000n, to: wallet.address, data: request.data, value: 1n };
async function signed(overrides = {}) {
  const tx = { ...transaction, ...overrides }, raw = await wallet.signTransaction(tx);
  return { request, raw, hash: keccak256(raw), nonce: tx.nonce, worstCaseWei: String(tx.gas * tx.maxFeePerGas + tx.value) };
}
test('real signature journal validation binds the entire transaction, not just its hash', async () => {
  const s = await signed(); await validateSignedStep(s, request, fees, wallet.address);
  await assert.rejects(() => validateSignedStep(s, request, fees)); // Public Anvil key never accepted for live signing.
  for (const override of [{ chainId: 1 }, { gas: 8000001n }, { maxFeePerGas: 20000000001n },
    { maxPriorityFeePerGas: 1000000001n }, { data: '0x1234' }, { value: 2n }, { to: '0x' + '2'.repeat(40) }]) {
    await assert.rejects(() => signed(override).then(v => validateSignedStep(v, request, fees, wallet.address)));
  }
  for (const patch of [{ hash: '0x' + '0'.repeat(64) }, { nonce: 6 }, { worstCaseWei: '0' }, { request: { ...request, value: '0x2' } }]) {
    await assert.rejects(() => validateSignedStep({ ...s, ...patch }, request, fees, wallet.address));
  }
});
test('creation transactions also bind absent recipient and full initcode', async () => {
  const tx = { ...transaction, to: undefined, value: 0n };
  const raw = await wallet.signTransaction(tx), req = { data: tx.data, value: '0x0' };
  const s = { request: req, raw, hash: keccak256(raw), nonce: tx.nonce, worstCaseWei: String(tx.gas * tx.maxFeePerGas) };
  await validateSignedStep(s, req, fees, wallet.address);
  await assert.rejects(() => validateSignedStep(s, { ...req, to: wallet.address }, fees, wallet.address));
});
test('CLI refuses broadcasts without explicit flag before reading env or signing', async () => {
  for (const args of [[], ['deploy'], ['smoke'], ['deploy', '--force'], ['verify', '--broadcast'], ['mainnet', '--broadcast']]) {
    await assert.rejects(() => main(args));
  }
});
test('transport refuses insecure endpoints and arbitrary wallet methods without network activity', async () => {
  assert.throws(() => rpcTransport('http://example.test'));
  await assert.rejects(() => rpcTransport('https://example.test')('personal_sign', []));
});
