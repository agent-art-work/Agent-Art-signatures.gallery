import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicError } from '../../src/openMint/security.ts';
import { checkWalletSupport, requireSupportedWalletCode, requireForUser, requireFreshMintSnapshot, publicFailure } from '../../scripts/pulse-sepolia-errors.mjs';

const wallet = '0x0000000000000000000000000000000000000001';
const delegation = '0xef0100386fd05a0e6a8c51f2abf3d6af4a86b1e2f1972a';
const head = { number: '0x123', hash: '0x' + '11'.repeat(32) };

test('mint availability warning uses plain language while preserving the 90-second freshness guard and saved state', () => {
  const snapshot = Object.freeze({ at: 100000, mints: new Map() });
  assert.equal(requireFreshMintSnapshot(snapshot, undefined, 100000), snapshot);
  assert.equal(requireFreshMintSnapshot(snapshot, undefined, 190000), snapshot);
  for (const [state, error, now] of [[snapshot, undefined, 190001], [undefined, undefined, 100000],
    [snapshot, Error('private RPC failure'), 100000]]) {
    assert.throws(() => requireFreshMintSnapshot(state, error, now), failure => {
      const result = publicFailure(failure);
      assert.equal(result.status, 409); assert.equal(result.code, 'OBSERVATION_UNAVAILABLE');
      assert.equal(result.error, 'Mint availability cannot be checked right now. Please try again shortly.');
      assert.doesNotMatch(result.error, /Sepolia observation|saved request|snapshot|private|RPC/); return true;
    });
  }
  assert.equal(snapshot.at, 100000); assert.equal(snapshot.mints.size, 0);
});

test('RC1 permits code-free wallets and distinguishes delegated EOAs from ordinary contracts', () => {
  assert.doesNotThrow(() => requireSupportedWalletCode('0x'));
  for (const code of [delegation, delegation.toUpperCase().replace('0X', '0x')]) {
    assert.throws(() => requireSupportedWalletCode(code), error => {
      const result = publicFailure(error);
      assert.equal(result.code, 'DELEGATED_WALLET_UNSUPPORTED');
      assert.match(result.error, /without delegation.*reconnect/);
      assert.doesNotMatch(result.error, /actual|expected|0xef0100/); return true;
    });
  }
  for (const code of ['0x60006000', '0xef0100', delegation + '00']) {
    assert.throws(() => requireSupportedWalletCode(code), { code: 'CONTRACT_WALLET_UNSUPPORTED' });
  }
  for (const malformed of ['', '0x0', '0xgg', null]) {
    assert.throws(() => requireSupportedWalletCode(malformed), error => {
      assert.equal(publicFailure(error).code, 'REQUEST_UNAVAILABLE'); return true;
    });
  }
});

test('custom and generated assertions, RPC details and forged errors never leak into public responses', () => {
  const errors = [Error('RPC failed: secret'), { message: 'Choose secret', status: 400, code: 'INVALID_INPUT' }, null];
  for (const message of [undefined, 'Smart-contract wallets are not supported.']) {
    try { assert.equal(delegation, '0x', message); } catch (error) { errors.push(error); }
  }
  for (const error of errors) {
    const result = publicFailure(error);
    assert.equal(result.code, 'REQUEST_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result), /secret|actual|expected|Assertion|ef0100|Smart-contract/);
  }
  assert.deepEqual(publicFailure(new PublicError(403, 'SESSION_REQUIRED', 'Refresh this page and try again.')),
    { status: 403, code: 'SESSION_REQUIRED', error: 'Refresh this page and try again.' });
  assert.doesNotThrow(() => requireForUser(true, 'CODE', 'Safe explanation'));
  assert.throws(() => requireForUser(false, 'CODE', 'Safe explanation'), { code: 'CODE', message: 'Safe explanation' });
});

test('wallet check requires matching code and unchanged blocks from both sources', async () => {
  const requests = [];
  const rpc = (code = '0x', hash = head.hash) => async (method, params) => {
    requests.push({ method, params });
    if (method === 'eth_getCode') return code;
    if (method === 'eth_getBlockByNumber') return { hash };
    throw Error('Unexpected request');
  };
  assert.equal(await checkWalletSupport({ rpc: rpc(), second: rpc() }, wallet, head), wallet);
  assert.equal(requests.filter(r => r.method === 'eth_getCode').length, 2);
  assert.ok(requests.every(r => r.params.includes(head.number)));
  await assert.rejects(checkWalletSupport({ rpc: rpc(), second: rpc(delegation) }, wallet, head), /observations disagree/);
  await assert.rejects(checkWalletSupport({ rpc: rpc(), second: rpc('0x', 'changed') }, wallet, head));
  await assert.rejects(checkWalletSupport({ rpc: rpc(delegation), second: rpc(delegation) }, wallet, head), { code: 'DELEGATED_WALLET_UNSUPPORTED' });
  await assert.rejects(checkWalletSupport({}, 'not an address', head), { code: 'INVALID_WALLET' });
  await assert.rejects(checkWalletSupport({}, '0x' + '0'.repeat(40), head), { code: 'INVALID_WALLET' });
});
