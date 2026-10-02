import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { savedMintAuthorization, validateRecoveryTransaction, inspectSepoliaAttempt, requireExpiredAttemptProof } from '../../scripts/pulse-sepolia-attempt-recovery.mjs';
import { createSepoliaReadFailover } from '../../scripts/pulse-sepolia-rpc.mjs';
import { loadPulseArtifact } from './pulse-candidate-lock.mjs';
import { INPUT_PROFILE } from './pulse-sepolia-plan.mjs';
import { openMintHandleKey } from '../../src/openMint/authorization.ts';
import { generativeInputDigest } from '../../src/openMint/generativeInputs.ts';
import { PULSE_PAID_SLOT, pulseMintDigest } from '../../src/openMint/pulseAuthorization.ts';
import { startSepoliaTestSite } from '../../scripts/pulse-sepolia-site.mjs';

const abi = loadPulseArtifact().abi;
const hash = '0x' + 'ab'.repeat(32), otherHash = '0x' + 'cd'.repeat(32);
const address = '0x' + '11'.repeat(20), collection = '0x' + '22'.repeat(20), otherAddress = '0x' + '33'.repeat(20);
const binding = { collection, renderer: { identity: hash }, deployment: { blockNumber: '1' } };
const quantity = value => '0x' + BigInt(value).toString(16);
const finalized = { number: '0x200', hash, timestamp: quantity(1900) };
const transient = () => Object.assign(Error('private RPC detail'), { code: 'RPC_DATA_UNAVAILABLE', retryableRead: true });

function request(mode = 'paid', patch = {}, authorizationPatch = {}) {
  const row = { code: 'saved-attempt', wallet: address, mode, cap: mode === 'paid' ? '100000000000000' : '0',
    stage: 'begun', deadline: 1900, renderHandle: 'Alice', mbti: 'INTJ', ...patch };
  const authorization = { handleKey: openMintHandleKey('alice'), assessmentDigest: hash,
    inputDigest: generativeInputDigest('Alice', 'INTJ', binding.renderer.identity, INPUT_PROFILE),
    recipient: row.wallet, nonce: keccak256(stringToHex(row.code)), issuedAt: 1000n, deadline: 1900n,
    mintMode: mode === 'paid' ? 1 : 0, slotId: mode === 'paid' ? PULSE_PAID_SLOT : 7n,
    maxPrice: mode === 'paid' ? 100000000000000n : 0n, ...authorizationPatch };
  const args = ['Alice', 'INTJ', authorization, '0x' + '01'.repeat(65), ...(mode === 'free' ? [[]] : [])];
  row.transaction = { from: row.wallet, to: collection, chainId: '0xaa36a7',
    data: encodeFunctionData({ abi, functionName: mode === 'paid' ? 'mintPaid' : 'mintFree', args }),
    value: quantity(mode === 'paid' ? 100000000000000n : 0n), gas: '0x200000' };
  return row;
}

function transaction(row, patch = {}) {
  return { hash, from: row.wallet, to: collection, input: row.transaction.data,
    value: row.transaction.value, chainId: '0xaa36a7', ...patch };
}

function rpcFixture(row, options = {}) {
  const calls = [];
  const make = source => async (method, params = [], readOptions = {}) => {
    calls.push({ source, method, params, readOptions });
    readOptions.signal?.throwIfAborted();
    if (options.fail?.(source, method, params)) throw transient();
    if (method === 'eth_getTransactionByHash') {
      assert.equal(params[0], options.transactionHash ?? row.transactionHash ?? hash);
      return Object.hasOwn(options, 'transaction') ? options.transaction : transaction(row);
    }
    const head = options.head?.[source] ?? options.head ?? finalized;
    if (method === 'eth_getBlockByNumber') {
      assert.equal(params[1], false);
      assert.ok(params[0] === 'finalized' || params[0] === head.number);
      return params[0] !== 'finalized' && options.changedAnchor ? { ...head, ...options.changedAnchor } : head;
    }
    assert.equal(method, 'eth_call', 'Recovery cannot sign, send, or estimate a new mint');
    assert.equal(params[0].to, collection); assert.equal(params[1], head.number, 'Every contract fact uses the finalized anchor');
    const decoded = decodeFunctionData({ abi, data: params[0].data });
    assert.ok(['usedNonces', 'mintedHandle'].includes(decoded.functionName));
    assert.deepEqual(decoded.args, [decoded.functionName === 'usedNonces'
      ? keccak256(stringToHex(row.code)) : openMintHandleKey('alice')]);
    const value = decoded.functionName === 'usedNonces' ? options.nonceUsed : options.handleMinted;
    return encodeFunctionResult({ abi, functionName: decoded.functionName,
      result: typeof value === 'object' ? value[source] : !!value });
  };
  return { calls, context: { rpc: make('primary'), second: make('secondary') } };
}

test('saved mint recovery binds both modes to the original wallet, calldata, inputs, nonce, deadline and payment', () => {
  for (const mode of ['free', 'paid']) {
    const row = request(mode), decoded = decodeFunctionData({ abi, data: row.transaction.data }).args[2];
    assert.deepEqual(savedMintAuthorization(binding, row), decoded);
    const rowPatches = [{ code: 'another-attempt' }, { wallet: otherAddress }, { renderHandle: 'alice' },
      { mbti: 'ISTJ' }, { deadline: 1901 }, { mode: mode === 'paid' ? 'free' : 'paid' },
      { mode: 'auto' }, { cap: '1' }, { transaction: { ...row.transaction, chainId: '0x1' } },
      { transaction: { ...row.transaction, from: otherAddress } }, { transaction: { ...row.transaction, to: otherAddress } },
      { transaction: { ...row.transaction, data: '0xdeadbeef' } }, { transaction: { ...row.transaction, value: '0x1' } }];
    for (const patch of rowPatches) assert.throws(() => savedMintAuthorization(binding, { ...row, ...patch }), JSON.stringify(patch));
    for (const authorizationPatch of [{ handleKey: otherHash }, { recipient: otherAddress }, { nonce: otherHash },
      { inputDigest: otherHash }, { issuedAt: 0n }, { issuedAt: 999n }, { issuedAt: 1900n }, { deadline: 1901n },
      { mintMode: mode === 'paid' ? 0 : 1 }, { maxPrice: 1n }]) {
      assert.throws(() => savedMintAuthorization(binding, request(mode, {}, authorizationPatch)));
    }
    for (const field of ['code', 'wallet', 'transaction', 'deadline', 'mbti', 'renderHandle', 'mode', 'cap']) {
      const missing = { ...row }; delete missing[field]; assert.throws(() => savedMintAuthorization(binding, missing), field);
    }
  }
});

test('finalized expiry boundary plus unused nonce and unminted handle permits a retry with an auditable proof', async () => {
  for (const timestamp of [1900n, 1901n]) {
    const row = request(), f = rpcFixture(row, { head: { ...finalized, timestamp: quantity(timestamp) } });
    const result = await inspectSepoliaAttempt(f.context, binding, row);
    assert.deepEqual(result, { state: 'retry-allowed', submissionStage: 'expired', proof: {
      number: finalized.number, hash, timestamp: quantity(timestamp),
      nonce: keccak256(stringToHex(row.code)), handleKey: openMintHandleKey('alice'),
    } });
    assert.equal(row.stage, 'begun', 'Inspection leaves persistence to the authenticated route');
    assert.ok(f.calls.every(call => ['eth_getBlockByNumber', 'eth_call'].includes(call.method)));
    for (const source of ['primary', 'secondary']) {
      assert.equal(f.calls.filter(call => call.source === source && call.method === 'eth_call').length, 2);
      assert.ok(f.calls.some(call => call.source === source && call.method === 'eth_getBlockByNumber'
        && call.params[0] === finalized.number), 'Canonical anchor is checked after facts');
    }
  }
});

test('pre-expiry, consumed nonce and already minted handle each keep the ambiguous attempt blocked', async () => {
  for (const options of [{ head: { ...finalized, timestamp: quantity(1899) } }, { nonceUsed: true }, { handleMinted: true }]) {
    const row = request(), f = rpcFixture(row, options);
    assert.deepEqual(await inspectSepoliaAttempt(f.context, binding, row), { state: 'submission-unknown', submissionStage: 'begun' });
    assert.ok(!f.calls.some(call => /send|sign|estimate/i.test(call.method)));
  }
});

test('missing RPC data, changed finalized anchors and conflicting two-source facts fail closed', async () => {
  const row = request();
  for (const options of [{ changedAnchor: { hash: otherHash } }, { changedAnchor: { number: '0x201' } },
    { changedAnchor: { timestamp: quantity(1901) } }, { nonceUsed: { primary: false, secondary: true } },
    { handleMinted: { primary: false, secondary: true } },
    { head: { primary: finalized, secondary: { ...finalized, hash: otherHash } } },
    { head: { primary: finalized, secondary: { ...finalized, timestamp: quantity(1901) } } },
    { fail: () => true }]) {
    const f = rpcFixture(row, options); await assert.rejects(inspectSepoliaAttempt(f.context, binding, row));
  }
  for (const method of ['eth_getBlockByNumber', 'eth_call']) {
    const f = rpcFixture(row), nullSource = async (called, ...args) => called === method ? null : f.context.rpc(called, ...args);
    await assert.rejects(inspectSepoliaAttempt({ rpc: nullSource, second: f.context.second }, binding, row));
  }
});

test('a newly pasted hash is adopted only when its transaction matches the entire saved mint', async () => {
  for (const saved of [false, true]) {
    const row = request('paid', saved ? { stage: 'reported', transactionHash: hash } : {}), f = rpcFixture(row);
    const result = await inspectSepoliaAttempt(f.context, binding, row, saved ? {} : { transactionHash: hash });
    assert.equal(result.state, 'retry-allowed'); assert.equal(result.transactionHash, hash);
    assert.equal(f.calls.filter(call => call.method === 'eth_getTransactionByHash').length, saved ? 0 : 2,
      'A new hash is verified before adoption; conclusive proof can retire an already saved hash');
  }
  const row = request(), tx = transaction(row);
  assert.equal(validateRecoveryTransaction(row, binding, hash, tx), tx);
  assert.doesNotThrow(() => validateRecoveryTransaction(row, binding, hash,
    transaction(row, { chainId: undefined, value: '0x00005af3107a4000' })));
  for (const patch of [{ hash: otherHash }, { from: otherAddress }, { to: otherAddress }, { to: null },
    { input: '0xdeadbeef' }, { value: '0x0' }, { chainId: '0x1' }]) {
    assert.throws(() => validateRecoveryTransaction(row, binding, hash, transaction(row, patch)),
      { code: 'RECOVERY_TRANSACTION_MISMATCH' });
    const f = rpcFixture(row, { transaction: transaction(row, patch) });
    await assert.rejects(inspectSepoliaAttempt(f.context, binding, row, { transactionHash: hash }),
      { code: 'RECOVERY_TRANSACTION_MISMATCH' });
    assert.ok(f.calls.some(call => call.method === 'eth_getTransactionByHash'));
  }
  for (const missing of [null, undefined]) {
    const f = rpcFixture(row, { transaction: missing });
    await assert.rejects(inspectSepoliaAttempt(f.context, binding, row, { transactionHash: hash }),
      error => error.code === 'RPC_DATA_UNAVAILABLE' && error.retryableRead === true);
  }
  await assert.rejects(inspectSepoliaAttempt(rpcFixture(row).context, binding, row, { transactionHash: 'not-a-hash' }),
    { code: 'INVALID_TRANSACTION_HASH' });
});

test('a dropped saved hash cannot block conclusive finalized recovery, while every new hash still requires a matching lookup', async () => {
  const row = request('paid', { stage: 'reported', transactionHash: hash });
  const dropped = rpcFixture(row, { transaction: null });
  const recovered = await inspectSepoliaAttempt(dropped.context, binding, row);
  assert.equal(recovered.state, 'retry-allowed'); assert.equal(recovered.transactionHash, hash);
  assert.ok(!dropped.calls.some(call => call.method === 'eth_getTransactionByHash'));
  for (const options of [{ transaction: null }, { transaction: transaction(row, { from: otherAddress }) }]) {
    const supplied = rpcFixture(row, options);
    await assert.rejects(inspectSepoliaAttempt(supplied.context, binding, row, { transactionHash: hash }),
      error => ['RPC_DATA_UNAVAILABLE', 'RECOVERY_TRANSACTION_MISMATCH'].includes(error.code));
  }
  for (const unresolved of [{ head: { ...finalized, timestamp: quantity(1899) } }, { nonceUsed: true }, { handleMinted: true }]) {
    const missing = rpcFixture(row, { transaction: null, ...unresolved });
    await assert.rejects(inspectSepoliaAttempt(missing.context, binding, row), { code: 'RPC_DATA_UNAVAILABLE' });
    assert.ok(missing.calls.some(call => call.method === 'eth_getTransactionByHash'));
  }
});

test('runtime failover discards a partial read and reconstructs all recovery facts at one validated source', async () => {
  const row = request(), secondaryHead = { ...finalized, number: '0x201', hash: otherHash };
  const f = rpcFixture(row, { head: { primary: finalized, secondary: secondaryHead },
    fail: (source, method) => source === 'primary' && method === 'eth_call' });
  const validations = [];
  const c = createSepoliaReadFailover(f.context, async source => { validations.push(source.readSource); });
  const result = await inspectSepoliaAttempt(c, binding, row);
  assert.equal(result.state, 'retry-allowed'); assert.equal(result.proof.number, secondaryHead.number);
  assert.equal(result.proof.hash, otherHash); assert.deepEqual(validations, ['primary', 'secondary']);
  assert.equal(f.calls.filter(call => call.source === 'secondary' && call.method === 'eth_call').length, 2);
  assert.ok(f.calls.every(call => !/send|sign|estimate/i.test(call.method)));
});

test('an aborted recovery dispatches no reads and cannot authorize replacement', async () => {
  const row = request(), f = rpcFixture(row), controller = new AbortController();
  const reason = Error('Cancelled'); controller.abort(reason);
  await assert.rejects(inspectSepoliaAttempt(f.context, binding, row, { signal: controller.signal }), error => error === reason);
  assert.equal(f.calls.length, 0);
});

test('a persisted expiry proof cannot be applied to another nonce, handle, deployment or deadline', async () => {
  const row = request(), result = await inspectSepoliaAttempt(rpcFixture(row).context, binding, row);
  const resolved = { ...row, stage: 'expired', recovery: { kind: 'finalized-expired-unused', proof: result.proof } };
  assert.deepEqual(requireExpiredAttemptProof(binding, resolved), result.proof);
  for (const patch of [{ nonce: otherHash }, { handleKey: otherHash }, { number: '0x0' },
    { hash: 'invalid' }, { timestamp: quantity(1899) }]) {
    assert.throws(() => requireExpiredAttemptProof(binding, { ...resolved,
      recovery: { ...resolved.recovery, proof: { ...result.proof, ...patch } } }));
  }
  assert.throws(() => requireExpiredAttemptProof(binding, { ...resolved, stage: 'begun' }));
  assert.throws(() => requireExpiredAttemptProof(binding, { ...resolved, recovery: { ...resolved.recovery, kind: 'expired' } }));
});

const testWallet = privateKeyToAccount('0x' + '1'.padStart(64, '0'));
const testAuthorizerKey = '0x' + '2'.padStart(64, '0');
const testAuthorizer = privateKeyToAccount(testAuthorizerKey);
const fetch = (url, options = {}) => globalThis.fetch(url, { ...options,
  headers: { ...options.headers, connection: 'close' } });
async function waitUntil(predicate) {
  const until = Date.now() + 2500;
  while (!predicate() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Disposable site reached mint readiness');
}
async function httpFixture(t, patch = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sg-attempt-recovery-'));
  let site;
  t.after(async () => { await site?.close(); rmSync(directory, { recursive: true, force: true }); });
  const row = request('paid', { wallet: testWallet.address, ...patch.row }, patch.authorization ?? {});
  const plan = { digest: hash, collection: { address: collection }, renderer: { identity: hash, runtimeCodeHash: hash },
    authorities: { authorizer: testAuthorizer.address }, allowlist: { proofs: [] }, sale: { freeDeadline: '9999999999' } };
  const live = { ...finalized, number: '0x210', timestamp: quantity(Math.floor(Date.now() / 1000)) };
  const calls = [], controls = { timestamp: finalized.timestamp, nonceUsed: false, handleMinted: false, unavailable: false, ...patch };
  const requests = patch.requests ?? { alice: row };
  for (let i = 1; i < (patch.recordCount ?? 1); i++) requests['other' + i] = { stage: 'prepared', wallet: address, code: 'other-' + i };
  writeFileSync(join(directory, 'web-records.json'), JSON.stringify({ planDigest: plan.digest, requests }), { mode: 0o600 });
  const source = label => async (method, params = []) => {
    calls.push({ label, method, params });
    if (controls.chain) {
      const value = await controls.chain(method, params, label);
      if (value !== undefined) return value;
    }
    if (method === 'eth_getBlockByNumber') return params[0] === 'latest' || params[0] === live.number
      ? live : { ...finalized, timestamp: controls.timestamp };
    if (method === 'eth_getCode') return '0x';
    if (method === 'eth_getTransactionByHash') return controls.transaction === null ? null : transaction(row, { hash: params[0], ...controls.transaction });
    if (method === 'eth_getTransactionReceipt') return null;
    if (method === 'eth_estimateGas') return '0x200000';
    assert.equal(method, 'eth_call', 'Disposable recovery/prepare never broadcasts');
    if (controls.unavailable) throw transient();
    const decoded = decodeFunctionData({ abi, data: params[0].data });
    await controls.beforeFact?.(decoded);
    assert.ok(['usedNonces', 'mintedHandle'].includes(decoded.functionName));
    assert.equal(params[1], finalized.number);
    return encodeFunctionResult({ abi, functionName: decoded.functionName,
      result: decoded.functionName === 'usedNonces' ? controls.nonceUsed : controls.handleMinted });
  };
  site = await startSepoliaTestSite(32015, { plan, journal: {}, directory, ui: false, intervalMs: 5,
    ...(patch.failCommit ? { saveRecords: () => { throw Error('Private disk failure'); } } : {}),
    context: { rpc: source('primary'), second: source('secondary') }, validateSource: async () => {},
    verifyDeployment: async () => ({ ...binding, testOnly: true, authorizer: testAuthorizer.address,
      deployment: { ...binding.deployment, finalized: true } }),
    observe: async () => { throw transient(); },
    readMintState: async () => ({ at: Date.now(), head: live, sale: { phase: 1, paused: false },
      paid: true, free: false, priceWei: '1', minted: false }),
  });
  await waitUntil(() => site.health().mintReady);
  return { directory, row, calls, controls, site, live, origin: 'http://127.0.0.1:32015',
    records: () => JSON.parse(readFileSync(join(directory, 'web-records.json'), 'utf8')) };
}

async function authenticated(origin, wallet = testWallet) {
  const opened = await fetch(origin + '/api/test/session'), cookie = opened.headers.get('set-cookie').split(';')[0];
  const { csrf } = await opened.json();
  const post = async (path, body, headers = {}) => {
    const response = await fetch(origin + '/api/test/' + path, { method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': csrf, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const challenge = await post('challenge', { address: wallet.address }); assert.equal(challenge.status, 200);
  const verified = await post('verify', { challengeId: challenge.body.challengeId,
    signature: await wallet.signMessage({ message: challenge.body.message }) }); assert.equal(verified.status, 200);
  return { post, cookie, csrf };
}

test('authenticated recovery persists finalized proof during a gallery outage and allows a fresh authorization', async t => {
  const f = await httpFixture(t), { post, cookie } = await authenticated(f.origin);
  assert.equal(f.site.health().observerHealthy, false);
  const publicStatus = await (await fetch(f.origin + '/api/test/status?handle=alice')).json();
  assert.equal(publicStatus.state, 'submission-unknown');
  const result = await post('recover', { handle: 'Alice', attemptCode: f.row.code });
  assert.equal(result.status, 200); assert.equal(result.body.state, 'retry-allowed');
  assert.equal(result.body.submissionStage, 'expired'); assert.equal(result.body.recoveryWallet, testWallet.address);
  const persisted = f.records().requests.alice;
  assert.equal(persisted.stage, 'expired'); assert.equal(persisted.code, f.row.code);
  assert.equal(persisted.recovery.kind, 'finalized-expired-unused');
  assert.deepEqual(requireExpiredAttemptProof(binding, persisted), {
    number: finalized.number, hash, timestamp: finalized.timestamp,
    nonce: keccak256(stringToHex(f.row.code)), handleKey: openMintHandleKey('alice'),
  });
  const status = await (await fetch(f.origin + '/api/test/status?handle=alice', { headers: { cookie } })).json();
  assert.equal(status.state, 'retry-allowed'); assert.equal(status.recoveryWallet, testWallet.address);
  assert.ok(f.calls.every(call => !/send|sign|estimate/i.test(call.method)), 'Recovery requests only read network state');
  writeFileSync(join(f.directory, 'authorizer.key'), testAuthorizerKey, { mode: 0o600 });
  const prepared = await post('prepare', { handle: 'Alice', mode: 'paid', maximumETH: '0.0001' });
  assert.equal(prepared.status, 200); assert.notEqual(prepared.body.code, f.row.code);
  const next = f.records().requests.alice;
  assert.equal(next.stage, 'prepared'); assert.equal(next.code, prepared.body.code);
  assert.equal(next.history.length, 1); assert.equal(next.history[0].code, f.row.code);
  assert.equal(next.history[0].stage, 'expired'); assert.deepEqual(next.history[0].recovery, persisted.recovery);
  assert.notEqual(savedMintAuthorization(binding, next).nonce, keccak256(stringToHex(f.row.code)));
  const replaced = f.records(), stale = await post('recover', { handle: 'alice', attemptCode: f.row.code });
  assert.equal(stale.status, 409); assert.deepEqual(f.records(), replaced);
  assert.ok(f.calls.every(call => !/send|sign/i.test(call.method)));
});

test('recovery requires the saved wallet proof and rejects foreign attempts and mismatched transaction hashes', async t => {
  const f = await httpFixture(t), foreign = await authenticated(f.origin, testAuthorizer);
  const before = f.records();
  const denied = await foreign.post('recover', { handle: 'alice', attemptCode: f.row.code });
  assert.equal(denied.status, 409); assert.deepEqual(f.records(), before);
  const own = await authenticated(f.origin);
  const wrongCode = await own.post('recover', { handle: 'alice', attemptCode: 'another-attempt' });
  assert.equal(wrongCode.status, 409); assert.deepEqual(f.records(), before);
  f.controls.transaction = { from: otherAddress };
  const mismatch = await own.post('recover', { handle: 'alice', attemptCode: f.row.code,
    transactionHash: otherHash });
  assert.equal(mismatch.status, 409); assert.equal(mismatch.body.code, 'RECOVERY_TRANSACTION_MISMATCH');
  assert.deepEqual(f.records(), before);
});

test('HTTP recovery preserves the saved request when chain facts remain ambiguous or RPC reads fail', async t => {
  const f = await httpFixture(t), { post } = await authenticated(f.origin);
  const before = f.records();
  for (const controls of [{ timestamp: quantity(1899) }, { timestamp: finalized.timestamp, nonceUsed: true },
    { nonceUsed: false, handleMinted: true }]) {
    Object.assign(f.controls, controls);
    const result = await post('recover', { handle: 'alice', attemptCode: f.row.code });
    assert.equal(result.status, 200); assert.equal(result.body.state, 'submission-unknown');
    assert.deepEqual(f.records(), before);
  }
  Object.assign(f.controls, { handleMinted: false, unavailable: true });
  const unavailable = await post('recover', { handle: 'alice', attemptCode: f.row.code });
  assert.ok(unavailable.status >= 400); assert.deepEqual(f.records(), before);
  assert.doesNotMatch(JSON.stringify(unavailable.body), /private RPC detail/);
});

test('a retired handle can be prepared by a new wallet at the 50-record bound without consuming another slot', async t => {
  const f = await httpFixture(t, { recordCount: 50 }), own = await authenticated(f.origin);
  assert.equal(Object.keys(f.records().requests).length, 50);
  assert.equal((await own.post('recover', { handle: 'alice', attemptCode: f.row.code })).status, 200);
  const foreign = await authenticated(f.origin, testAuthorizer);
  const retired = f.records().requests.alice;
  writeFileSync(join(f.directory, 'authorizer.key'), testAuthorizerKey, { mode: 0o600 });
  const replaced = await foreign.post('prepare', { handle: 'Alice', mode: 'paid', maximumETH: '0.0001' });
  assert.equal(replaced.status, 200);
  const records = f.records();
  assert.equal(Object.keys(records.requests).length, 50);
  assert.equal(records.requests.alice.wallet, testAuthorizer.address);
  assert.deepEqual(records.requests.alice.history, [retired]);
  const blocked = await foreign.post('prepare', { handle: 'Bob', mode: 'paid', maximumETH: '0.0001' });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'PREPARATION_UNAVAILABLE');
  assert.deepEqual(f.records(), records);
});

test('a report can be retried with the same hash and cannot replace a hash already persisted', async t => {
  const f = await httpFixture(t), { post } = await authenticated(f.origin);
  assert.equal((await post('report', { code: f.row.code, transactionHash: hash })).status, 200);
  const reported = f.records();
  assert.equal(reported.requests.alice.stage, 'reported'); assert.equal(reported.requests.alice.transactionHash, hash);
  const retried = await post('report', { code: f.row.code, transactionHash: hash });
  assert.equal(retried.status, 200); assert.equal(retried.body.saved, true); assert.deepEqual(f.records(), reported);
  const changed = await post('report', { code: f.row.code, transactionHash: otherHash });
  assert.equal(changed.status, 409); assert.deepEqual(f.records(), reported);
});

test('begin, report and recovery roll back their in-memory state when the durable write fails', async t => {
  for (const action of ['begin', 'report', 'recover']) {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
    const f = await httpFixture(t, { failCommit: true,
      ...(action === 'begin' ? { row: { stage: 'prepared', deadline: Number(deadline) },
        authorization: { issuedAt: deadline - 900n, deadline } } : {}) });
    const { post, cookie } = await authenticated(f.origin), before = f.records();
    const body = action === 'recover' ? { handle: 'alice', attemptCode: f.row.code }
      : { code: f.row.code, ...(action === 'report' ? { transactionHash: hash } : {}) };
    const result = await post(action, body);
    assert.equal(result.status, 409); assert.doesNotMatch(JSON.stringify(result.body), /Private disk failure/);
    assert.deepEqual(f.records(), before);
    const status = await (await fetch(f.origin + '/api/test/status?handle=alice', { headers: { cookie } })).json();
    assert.equal(status.submissionStage, action === 'begin' ? 'prepared' : 'begun');
    assert.equal(status.state, action === 'begin' ? 'not-submitted' : 'submission-unknown');
    await f.site.close();
  }
});

test('a report arriving during recovery cannot revive the authorization recovery retires', async t => {
  const f = await httpFixture(t), { post } = await authenticated(f.origin);
  let release, reached;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  t.after(release);
  f.controls.beforeFact = async () => { reached(); await held; };
  const recovering = post('recover', { handle: 'alice', attemptCode: f.row.code });
  await entered;
  let arrived;
  const reportArrived = new Promise(resolve => { arrived = resolve; });
  const onRequest = request => { if (request.url === '/api/test/report') arrived(); };
  f.site.server.on('request', onRequest); t.after(() => f.site.server.off('request', onRequest));
  const reporting = post('report', { code: f.row.code, transactionHash: hash });
  await reportArrived; await new Promise(resolve => setImmediate(resolve));
  release();
  const [recovered, reported] = await Promise.all([recovering, reporting]);
  assert.equal(recovered.status, 200); assert.equal(recovered.body.state, 'retry-allowed');
  assert.equal(reported.status, 409);
  const row = f.records().requests.alice;
  assert.equal(row.stage, 'expired'); assert.equal(row.transactionHash, undefined);
  assert.doesNotThrow(() => requireExpiredAttemptProof(binding, row));
});

function discoveryFixture(row, options = {}) {
  const head = options.head ?? finalized, calls = [], finalReads = new Map();
  const block = number => ({ number: quantity(number), hash: number === BigInt(head.number) ? head.hash
    : keccak256(stringToHex('recovery-block:' + number)), timestamp: number === BigInt(head.number)
    ? head.timestamp : quantity(options.timestampAt ? options.timestampAt(number) : 900n + number) });
  const authorization = savedMintAuthorization(binding, row);
  const args = { handleKey: authorization.handleKey, nonce: authorization.nonce, recipient: row.wallet,
    tokenId: BigInt(authorization.handleKey), renderHandle: row.renderHandle, mbti: row.mbti,
    assessmentDigest: authorization.assessmentDigest, inputDigest: authorization.inputDigest,
    authorizationDigest: pulseMintDigest({ chainId: 11155111, verifyingContract: collection }, authorization), ...options.eventPatch };
  const event = abi.find(item => item.type === 'event' && item.name === 'GenerativeSignatureMinted');
  const mintBlockNumber = options.mintBlockNumber ?? 256n, mintBlock = block(mintBlockNumber);
  const log = { address: collection, topics: encodeEventTopics({ abi, eventName: event.name, args }),
    data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), event.inputs.filter(input => !input.indexed).map(input => args[input.name])),
    blockNumber: mintBlock.number, blockHash: mintBlock.hash, transactionHash: otherHash,
    transactionIndex: '0x0', logIndex: '0x0', removed: false, ...options.logPatch };
  const source = label => async (method, params = []) => {
    calls.push({ label, method, params });
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'finalized') return head;
      const number = BigInt(params[0]), value = block(number);
      if (number === BigInt(head.number)) {
        finalReads.set(label, (finalReads.get(label) ?? 0) + 1);
        if (options.changedFinalAnchor && finalReads.get(label) > 1) return { ...value, hash: otherHash };
      }
      return { ...value, ...(number === mintBlockNumber ? options.mintBlockPatch : {}) };
    }
    if (method === 'eth_call') {
      assert.equal(params[1], head.number);
      const decoded = decodeFunctionData({ abi, data: params[0].data });
      assert.ok(['usedNonces', 'mintedHandle'].includes(decoded.functionName));
      return encodeFunctionResult({ abi, functionName: decoded.functionName, result: true });
    }
    if (method === 'eth_getLogs') {
      const [filter] = params;
      assert.equal(filter.address, collection);
      assert.deepEqual(filter.topics, encodeEventTopics({ abi, eventName: event.name,
        args: { handleKey: authorization.handleKey, nonce: authorization.nonce, recipient: row.wallet } }));
      assert.ok(BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n <= 1000n, 'Every discovery page is bounded');
      const outside = BigInt(log.blockNumber) < BigInt(filter.fromBlock) || BigInt(log.blockNumber) > BigInt(filter.toBlock);
      return options.noEvent || options.noEventSource === label || options.respectFilter && outside ? [] : [log];
    }
    assert.equal(method, 'eth_getTransactionByHash', 'Discovery permits only chain reads');
    assert.equal(params[0], otherHash);
    return options.missingTransaction ? null : transaction(row, { hash: otherHash, ...options.transactionPatch });
  };
  return { calls, log, context: { rpc: source('primary'), second: source('secondary') } };
}

test('a mint with a lost report is discovered by the exact authorization event and validated transaction', async () => {
  const row = request(), f = discoveryFixture(row);
  assert.deepEqual(await inspectSepoliaAttempt(f.context, binding, row), {
    state: 'submission-unknown', submissionStage: 'begun', transactionHash: otherHash,
  });
  assert.equal(row.transactionHash, undefined, 'Discovery itself does not persist or claim reveal verification');
  for (const source of ['primary', 'secondary']) {
    assert.ok(f.calls.some(call => call.label === source && call.method === 'eth_getLogs'));
    assert.ok(f.calls.some(call => call.label === source && call.method === 'eth_getTransactionByHash'));
    assert.ok(f.calls.filter(call => call.label === source && call.method === 'eth_getBlockByNumber'
      && call.params[0] === finalized.number).length >= 2, 'Finalized anchor is rechecked after event adoption');
  }
});

test('a discovered event cannot adopt another nonce, wallet, input, digest, removed log or noncanonical block', async () => {
  const row = request();
  for (const options of [{ eventPatch: { nonce: otherHash } }, { eventPatch: { recipient: otherAddress } },
    { eventPatch: { handleKey: otherHash } }, { eventPatch: { tokenId: 1n } }, { eventPatch: { renderHandle: 'Bob' } },
    { eventPatch: { mbti: 'ISTJ' } }, { eventPatch: { assessmentDigest: otherHash } },
    { eventPatch: { inputDigest: otherHash } }, { eventPatch: { authorizationDigest: otherHash } },
    { noEventSource: 'secondary' }, { logPatch: { removed: true } },
    { logPatch: { address: otherAddress } }, { logPatch: { blockNumber: '0x201' } },
    { logPatch: { blockHash: hash } }, { mintBlockPatch: { timestamp: quantity(999) } },
    { mintBlockPatch: { timestamp: quantity(1900) } }, { changedFinalAnchor: true },
    { transactionPatch: { from: otherAddress } }, { transactionPatch: { to: otherAddress } },
    { transactionPatch: { input: '0xdeadbeef' } }, { transactionPatch: { value: '0x0' } },
    { missingTransaction: true }]) {
    const f = discoveryFixture(row, options);
    await assert.rejects(inspectSepoliaAttempt(f.context, binding, row),
      JSON.stringify(options, (_key, value) => typeof value === 'bigint' ? String(value) : value));
    assert.equal(row.transactionHash, undefined);
  }
});

test('used nonce and minted handle without the exact event fail closed without adopting another mint', async () => {
  const row = request(), f = discoveryFixture(row, { noEvent: true });
  await assert.rejects(inspectSepoliaAttempt(f.context, binding, row),
    error => error.code === 'RPC_DATA_UNAVAILABLE' && error.retryableRead === true);
  assert.ok(f.calls.some(call => call.method === 'eth_getLogs'));
  assert.ok(!f.calls.some(call => call.method === 'eth_getTransactionByHash'));
});

test('old lost reports binary-search expiry before querying at most 1000 blocks per event page', async () => {
  const row = request(), head = { number: quantity(5000), hash, timestamp: quantity(5900) };
  const f = discoveryFixture(row, { head });
  const result = await inspectSepoliaAttempt(f.context, binding, row);
  assert.equal(result.transactionHash, otherHash);
  const queries = f.calls.filter(call => call.method === 'eth_getLogs');
  assert.equal(queries.length, 2, 'Only one bounded event page is read per audit source');
  for (const query of queries) {
    assert.equal(query.params[0].fromBlock, '0x1'); assert.equal(query.params[0].toBlock, quantity(999));
  }
  assert.ok(f.calls.some(call => call.method === 'eth_getBlockByNumber' && BigInt(call.params[0] === 'finalized' ? 0 : call.params[0]) > 1000n),
    'Header reads narrow the expiry boundary without scanning old events');
});

test('an incomplete primary event index retries the complete recovery against the validated secondary', async () => {
  const row = request(), f = discoveryFixture(row, { noEventSource: 'primary' });
  const validations = [];
  const c = createSepoliaReadFailover(f.context, async source => { validations.push(source.readSource); });
  assert.deepEqual(await inspectSepoliaAttempt(c, binding, row), {
    state: 'submission-unknown', submissionStage: 'begun', transactionHash: otherHash,
  });
  assert.deepEqual(validations, ['primary', 'secondary']);
  assert.ok(f.calls.some(call => call.label === 'primary' && call.method === 'eth_getLogs'));
  assert.ok(f.calls.some(call => call.label === 'secondary' && call.method === 'eth_getTransactionByHash'));
  assert.ok(!f.calls.some(call => call.label === 'primary' && call.method === 'eth_getTransactionByHash'));
  assert.equal(c.readStatus().evidenceConflict, false);
});

test('discovery continues to an earlier bounded page when the newest page contains no matching event', async () => {
  const row = request(), head = { number: quantity(3000), hash, timestamp: quantity(2000) };
  const f = discoveryFixture(row, { head, mintBlockNumber: 1500n, respectFilter: true,
    timestampAt: number => 1000n + number * 3n / 10n });
  const result = await inspectSepoliaAttempt(f.context, binding, row);
  assert.equal(result.transactionHash, otherHash);
  for (const source of ['primary', 'secondary']) {
    const pages = f.calls.filter(call => call.label === source && call.method === 'eth_getLogs').map(call => call.params[0]);
    assert.deepEqual(pages.map(page => [page.fromBlock, page.toBlock]), [
      [quantity(2001), quantity(3000)], [quantity(1001), quantity(2000)],
    ]);
    assert.ok(pages.every(page => BigInt(page.toBlock) - BigInt(page.fromBlock) + 1n <= 1000n));
  }
});

function retiredRequest(patch = {}) {
  const row = request('paid', { wallet: testWallet.address });
  return { ...row, stage: 'expired', recovery: { kind: 'finalized-expired-unused', previousStage: 'begun',
    resolvedAt: 1, proof: { ...finalized, nonce: keccak256(stringToHex(row.code)), handleKey: openMintHandleKey('alice') } }, ...patch };
}

test('an authenticated matching hash is adopted as pending and survives status reads without granting a retry or reveal', async t => {
  const f = await httpFixture(t, { timestamp: quantity(1899) }), { post, cookie } = await authenticated(f.origin);
  const result = await post('recover', { handle: 'alice', attemptCode: f.row.code, transactionHash: otherHash });
  assert.equal(result.status, 200); assert.equal(result.body.state, 'pending');
  assert.equal(result.body.transactionHash, otherHash); assert.equal(result.body.recoveryWallet, undefined);
  const adopted = f.records().requests.alice;
  assert.equal(adopted.stage, 'reported'); assert.equal(adopted.transactionHash, otherHash);
  assert.equal(adopted.recovery, undefined); assert.deepEqual(adopted.transaction, f.row.transaction);
  const response = await fetch(f.origin + '/api/test/status?handle=alice', { headers: { cookie } });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.state, 'pending'); assert.equal(status.submissionStage, 'reported');
  assert.equal(status.transactionHash, otherHash); assert.equal(status.html, undefined);
  assert.ok(f.calls.some(call => call.method === 'eth_getTransactionByHash'));
  assert.ok(f.calls.some(call => call.method === 'eth_getTransactionReceipt'));
  assert.ok(!existsSync(join(f.directory, 'authorizer.key')));
});

test('a consumed attempt with a lost hash discovers its mint, verifies its receipt and reveals its immutable artwork', async t => {
  const f = await httpFixture(t), { post, cookie } = await authenticated(f.origin);
  const discovery = discoveryFixture(f.row), mint = discovery.log;
  const transfer = { ...mint, logIndex: '0x1', data: '0x', topics: encodeEventTopics({ abi, eventName: 'Transfer',
    args: { from: '0x' + '0'.repeat(40), to: testWallet.address, tokenId: BigInt(openMintHandleKey('alice')) } }) };
  const receipt = { type: '0x2', status: '0x1', transactionHash: otherHash, transactionIndex: mint.transactionIndex,
    blockHash: mint.blockHash, blockNumber: mint.blockNumber, from: testWallet.address, to: collection,
    contractAddress: null, cumulativeGasUsed: '0x200000', gasUsed: '0x100000', effectiveGasPrice: '0x10',
    logsBloom: '0x' + '00'.repeat(256), logs: [transfer, mint] };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>';
  f.controls.chain = async (method, params, label) => {
    if (method === 'eth_getCode') return '0x';
    if (method === 'eth_getBlockByNumber' && ['latest', f.live.number].includes(params[0])) return f.live;
    if (method === 'eth_getTransactionReceipt') return receipt;
    if (method === 'eth_getTransactionByHash') return transaction(f.row, { hash: otherHash,
      blockHash: mint.blockHash, blockNumber: mint.blockNumber, transactionIndex: mint.transactionIndex });
    if (method === 'eth_call') {
      const decoded = decodeFunctionData({ abi, data: params[0].data });
      const values = { inputs: [f.row.renderHandle, f.row.mbti], svg, trustedAuthorizer: testAuthorizer.address };
      if (Object.hasOwn(values, decoded.functionName)) {
        assert.equal(params[1], f.live.number);
        return encodeFunctionResult({ abi, functionName: decoded.functionName, result: values[decoded.functionName] });
      }
    }
    return discovery.context[label === 'primary' ? 'rpc' : 'second'](method, params);
  };
  const result = await post('recover', { handle: 'alice', attemptCode: f.row.code });
  assert.equal(result.status, 200); assert.equal(result.body.state, 'minted');
  assert.equal(result.body.transactionHash, otherHash); assert.equal(result.body.recoveryWallet, undefined);
  const adopted = f.records().requests.alice;
  assert.equal(adopted.stage, 'reported'); assert.equal(adopted.transactionHash, otherHash);
  assert.equal(adopted.recovery, undefined);
  const response = await fetch(f.origin + '/api/test/status?handle=alice', { headers: { cookie } });
  assert.equal(response.status, 200); const status = await response.json();
  assert.equal(status.state, 'minted'); assert.equal(status.transactionHash, otherHash);
  assert.equal(status.tokenId, String(BigInt(openMintHandleKey('alice'))));
  assert.equal(status.inputDigest, savedMintAuthorization(binding, f.row).inputDigest);
  assert.equal(status.url, '/signatures/alice'); assert.match(status.html, /data-mint-state="minted"/);
  assert.match(status.html, /data-reveal-artwork/);
  const image = await fetch(f.origin + '/test-art/alice.svg');
  assert.equal(image.status, 200); assert.equal(await image.text(), svg);
  assert.equal(f.site.health().observerHealthy, false, 'Receipt reveal works while full history remains unavailable');
  assert.ok(f.calls.some(call => call.method === 'eth_getLogs'));
  assert.ok(f.calls.some(call => call.method === 'eth_getTransactionReceipt'));
  assert.ok(!f.calls.some(call => /send|sign|estimate/i.test(call.method)));
  assert.ok(!existsSync(join(f.directory, 'authorizer.key')));
});

test('logout or a replacement wallet challenge during recovery revokes its authority before any write', async t => {
  for (const action of ['logout', 'challenge']) {
    const f = await httpFixture(t), { post, cookie } = await authenticated(f.origin), before = f.records();
    let release, reached;
    const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { reached = resolve; });
    f.controls.beforeFact = async () => { reached(); await held; };
    try {
      const recovery = post('recover', { handle: 'alice', attemptCode: f.row.code });
      await entered;
      const changed = await post(action, action === 'logout' ? {} : { address: testAuthorizer.address });
      assert.equal(changed.status, 200); release();
      const result = await recovery;
      assert.equal(result.status, 409); assert.deepEqual(f.records(), before);
      const response = await fetch(f.origin + '/api/test/status?handle=alice', { headers: { cookie } });
      assert.equal(response.status, 200);
      const status = await response.json();
      assert.equal(status.state, 'submission-unknown'); assert.equal(status.submissionStage, 'begun');
      assert.equal(status.recoveryWallet, undefined); assert.equal(status.transactionHash, undefined);
    } finally { release(); await f.site.close(); }
  }
});

test('preparing a retired handle rechecks current proof and preserves the retired record and history on failure', async t => {
  const retired = retiredRequest({ history: [{ stage: 'prepared', code: 'older-attempt' }] });
  const f = await httpFixture(t, { requests: { alice: retired } }), { post } = await authenticated(f.origin);
  const before = f.records();
  for (const controls of [{ nonceUsed: true }, { nonceUsed: false, handleMinted: true },
    { handleMinted: false, unavailable: true }]) {
    Object.assign(f.controls, controls);
    const result = await post('prepare', { handle: 'Alice', mode: 'paid', maximumETH: '0.0001' });
    assert.equal(result.status, 409); assert.deepEqual(f.records(), before);
    assert.ok(!existsSync(join(f.directory, 'authorizer.key')), 'Proof failure stops before loading the fixture authorizer');
  }
  assert.ok(!f.calls.some(call => call.method === 'eth_estimateGas'));
});

test('failed durable preparation restores a fresh empty request set or the retired request with its history', async t => {
  for (const previous of [undefined, retiredRequest({ history: [{ stage: 'prepared', code: 'older-attempt' }] })]) {
    const f = await httpFixture(t, { failCommit: true, requests: previous ? { alice: previous } : {} });
    const { post, cookie } = await authenticated(f.origin), before = f.records();
    writeFileSync(join(f.directory, 'authorizer.key'), testAuthorizerKey, { mode: 0o600 });
    const result = await post('prepare', { handle: 'Alice', mode: 'paid', maximumETH: '0.0001' });
    assert.equal(result.status, 409); assert.doesNotMatch(JSON.stringify(result.body), /Private disk failure/);
    assert.deepEqual(f.records(), before);
    const response = await fetch(f.origin + '/api/test/status?handle=alice', { headers: { cookie } });
    assert.equal(response.status, 200); const status = await response.json();
    assert.equal(status.state, previous ? 'retry-allowed' : 'not-submitted');
    assert.equal(status.submissionStage, previous ? 'expired' : 'none');
    assert.ok(f.calls.some(call => call.method === 'eth_estimateGas'), 'The failed action reached the durable commit');
    await f.site.close();
  }
});

test('recovery and preparation reject bad session, CSRF, origin and fields without changing saved authority', async t => {
  const f = await httpFixture(t), { post } = await authenticated(f.origin), before = f.records();
  for (const [path, body, headers, expected] of [
    ['recover', { handle: 'alice' }, { 'x-csrf-token': 'wrong-token' }, 403],
    ['recover', { handle: 'alice' }, { cookie: 'sg_open_session=missing-session' }, 403],
    ['recover', { handle: 'alice' }, { origin: 'http://other.example.test' }, 409],
    ['recover', { attemptCode: f.row.code }, {}, 400],
    ['recover', { handle: 'alice', deadline: 0 }, {}, 400],
    ['prepare', { handle: 'Alice', mode: 'paid', maximumETH: '0.0001', mbti: 'INTJ' }, {}, 400],
    ['begin', { code: f.row.code, deadline: 9999999999 }, {}, 400],
    ['report', { code: f.row.code, transactionHash: hash, wallet: testWallet.address }, {}, 400],
  ]) {
    const result = await post(path, body, headers);
    assert.equal(result.status, expected); assert.deepEqual(f.records(), before);
  }
  const session = await fetch(f.origin + '/api/test/session'), cookie = session.headers.get('set-cookie').split(';')[0];
  const { csrf } = await session.json();
  const unverified = await fetch(f.origin + '/api/test/recover', { method: 'POST', headers: {
    cookie, origin: f.origin, 'x-csrf-token': csrf, 'content-type': 'application/json',
  }, body: JSON.stringify({ handle: 'alice' }) });
  assert.equal(unverified.status, 409); assert.equal((await unverified.json()).code, 'CONNECT_WALLET');
  assert.deepEqual(f.records(), before); assert.ok(!existsSync(join(f.directory, 'authorizer.key')));
});
