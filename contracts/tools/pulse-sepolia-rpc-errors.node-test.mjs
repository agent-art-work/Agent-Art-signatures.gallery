import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryableSepoliaRpcError, retrySafeReads } from '../../scripts/pulse-sepolia.mjs';

const reads = ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs', 'eth_call', 'eth_estimateGas'];

test('EIP-1474 resource-not-found/unavailable errors permit only existing safe reads to recover', () => {
  for (const method of reads) for (const code of [-32001, -32002]) {
    assert.equal(retryableSepoliaRpcError(method, { code, message: 'Resource not found' }), true, method + ':' + code);
  }
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'eth_getStorageAt', 'eth_blockNumber']) {
    for (const code of [-32001, -32002]) assert.equal(retryableSepoliaRpcError(method, { code, message: 'Resource temporarily unavailable' }), false);
    assert.equal(retryableSepoliaRpcError(method, { code: -32603, message: 'Rate limit exceeded' }), false);
  }
});

test('invalid inputs and execution errors cannot fall through the availability-message classifier', () => {
  for (const code of [-32700, -32600, -32601, -32602, -32000, -32003, -32004, -32006, 3]) {
    assert.equal(retryableSepoliaRpcError('eth_call', { code, message: 'temporarily invalid parameters; rate limit' }), false, String(code));
  }
  for (const code of [-32001, -32002, -32603, -32005]) {
    for (const message of ['execution reverted: temporary mint limit', 'revert', 'invalid opcode: historical state', 'out of gas: limit', 'execution failed: timeout']) {
      assert.equal(retryableSepoliaRpcError('eth_call', { code, message }), false, code + ':' + message);
    }
  }
});

test('existing transient messages remain recoverable without treating all RPC failures as outages', () => {
  for (const message of ['Rate limit exceeded', 'request timeout', 'temporarily unavailable', 'historical state unavailable', 'missing trie node']) {
    assert.equal(retryableSepoliaRpcError('eth_getCode', { code: -32603, message }), true, message);
  }
  for (const error of [undefined, null, false, 'Resource not found', [], {}, { code: '-32001', message: 'Resource not found' },
    { code: -32603, message: 'internal error' }, { code: -32603, message: 'incorrect chain code' }]) {
    assert.equal(retryableSepoliaRpcError('eth_getCode', error), false);
  }
});

test('read resource failure retries once, without changing the method or pinned parameters', async () => {
  const calls = [], params = ['0x' + '11'.repeat(20), '0xabc'];
  const request = retrySafeReads(async (method, received, options) => {
    calls.push([method, received, options]);
    if (calls.length === 1) throw Object.assign(Error('Details suppressed.'), {
      rpcErrorCode: -32001, retryableRead: retryableSepoliaRpcError(method, { code: -32001, message: 'Resource not found' }),
    });
    return '0x1234';
  });
  const options = { signal: new AbortController().signal };
  assert.equal(await request('eth_getCode', params, options), '0x1234');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([method, received, passed]) => method === 'eth_getCode' && received === params && passed === options));
});

test('a repeated resource error does not receive an unbounded retry loop', async () => {
  let calls = 0;
  const failure = Object.assign(Error('Details suppressed.'), { retryableRead: true, rpcErrorCode: -32002 });
  const request = retrySafeReads(async () => { calls++; throw failure; });
  await assert.rejects(request('eth_getCode', []), error => error === failure);
  assert.equal(calls, 2);
});

test('writes, EVM reverts, and integrity assertions never use the read retry lane', async () => {
  for (const [method, failure] of [
    ['eth_sendRawTransaction', Object.assign(Error('Resource unavailable'), { retryableRead: true, rpcErrorCode: -32002 })],
    ['eth_call', Object.assign(Error('Details suppressed.'), { retryableRead: retryableSepoliaRpcError('eth_call', { code: -32001, message: 'execution reverted: rate limit' }) })],
    ['eth_getCode', new assert.AssertionError({ message: 'Runtime code differs from the pinned deployment' })],
    ['eth_chainId', Object.assign(Error('Wrong chain'), { code: 'MINT_EVIDENCE_CONFLICT' })],
  ]) {
    let calls = 0;
    const request = retrySafeReads(async () => { calls++; throw failure; });
    await assert.rejects(request(method, []), error => error === failure);
    assert.equal(calls, 1, method);
  }
});
