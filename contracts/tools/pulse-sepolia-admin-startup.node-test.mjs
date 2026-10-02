import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyFinalizedAdminBinding } from '../../scripts/pulse-sepolia-admin-site.mjs';

const p = { contractProfile: 'generative-pulse-v1-rc2' };
const j = { transactions: { collection: { receipt: { blockNumber: '0x100' } } } };
test('new deployment waits for finality as a recoverable read, not a permanent service block', async () => {
  let checked = 0;
  for (const number of ['0x0', '0xff']) {
    const c = { rpc: async (method, params) => {
      assert.equal(method, 'eth_getBlockByNumber'); assert.deepEqual(params, ['finalized', false]); return { number };
    } };
    await assert.rejects(verifyFinalizedAdminBinding(c, p, j, async () => { checked++; }),
      error => error.code === 'RPC_DATA_UNAVAILABLE' && error.retryableRead === true);
  }
  assert.equal(checked, 0);
});
test('finalized deployment still requires complete byte/constructor/role verification before bootstrap', async () => {
  let checked = 0;
  const c = { rpc: async () => ({ number: '0x100' }) }, binding = { deployment: { finalized: true }, contractProfile: p.contractProfile };
  assert.equal(await verifyFinalizedAdminBinding(c, p, j, async (context, plan, journal) => {
    checked++; assert.equal(context, c); assert.equal(plan, p); assert.equal(journal, j); return { binding };
  }), binding);
  assert.equal(checked, 1);
  await assert.rejects(verifyFinalizedAdminBinding(c, p, j, async () => { throw new Error('Build mismatch'); }), /Build mismatch/);
});
test('missing or regressed finality evidence never enables minting', async () => {
  const c = { rpc: async () => ({ number: '0x100' }) };
  await assert.rejects(verifyFinalizedAdminBinding(c, p, j, async () => ({ binding: { deployment: { finalized: false } } })),
    error => error.code === 'RPC_DATA_UNAVAILABLE');
  for (const value of [null, { number: null }])
    await assert.rejects(verifyFinalizedAdminBinding({ rpc: async () => value }, p, j), error => error.code === 'RPC_DATA_UNAVAILABLE');
});
