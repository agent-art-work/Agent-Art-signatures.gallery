import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, keccak256, stringToHex } from 'viem';
import { createSepoliaAdminWebService } from '../../scripts/pulse-sepolia-admin-web-service.mjs';
import { loadPulseAdminArtifact } from './pulse-admin-candidate.mjs';
import { buildAllowlist, verifyAllowlistArtifacts } from './pulse-allowlist.mjs';
import { ADMIN_PROFILE } from './pulse-sepolia-admin-plan.mjs';
import { createSepoliaReadFailover } from '../../scripts/pulse-sepolia-rpc.mjs';

const abi = loadPulseAdminArtifact().abi;
const ADMIN = getAddress('0x1111111111111111111111111111111111111111');
const OTHER = getAddress('0x3333333333333333333333333333333333333333');
const AT = getAddress('0x2222222222222222222222222222222222222222');
const HASH = '0x' + '55'.repeat(32), BAD_HASH = '0x' + '66'.repeat(32);
const PAUSER = keccak256(stringToHex('PAUSER_ROLE'));
const qty = value => '0x' + BigInt(value).toString(16);
const codeError = code => error => { assert.equal(error.code, code); assert.doesNotMatch(error.message, /secret|https:|AssertionError|\/tmp\//); return true; };
const getJson = path => JSON.parse(readFileSync(path, 'utf8'));

function fixture(t, options = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'pulse-admin-web-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const plan = { contractProfile: ADMIN_PROFILE, chainId: 11155111, testOnly: true, productionApproved: false,
    digest: 'mock-admin-plan', collection: { address: AT }, fees: { maxGasPerTransaction: '8000000' } };
  const binding = { contractProfile: ADMIN_PROFILE, chainId: 11155111, planDigest: plan.digest,
    collection: AT, runtimeCodeHash: keccak256('0x1234'),
    deployment: { blockNumber: '1', blockHash: '0x' + '11'.repeat(32), transactionHash: '0x' + '22'.repeat(32) } };
  const now = BigInt(Math.floor(Date.now() / 1000));
  const allowlist = buildAllowlist([ADMIN, ADMIN]);
  const state = { phase: 0, paused: true, root: allowlist.manifest.root, slotCount: 2n, quota: 2n,
    revision: 1n, freeMinted: 0n, freeDeadline: now + 86400n, admin: ADMIN, canPause: true,
    isAdmin: true, claims: new Set(), nonce: 7n, pendingNonce: 7n, height: 100n, writes: [], calls: [],
    txs: new Map(), receipts: new Map(), heads: new Map(), snapshots: new Map(), ...options };
  let configuration = { schema: 'sg-pulse-free-configuration/v1', planDigest: plan.digest, contract: AT,
    root: state.root, slotCount: '2', quota: '2', revision: '1',
    allowlist: { manifest: allowlist.manifest, slots: allowlist.slots, tree: allowlist.tree, proofs: allowlist.proofs } };
  let listReads = 0, bindingReady = true, updated = 0;
  const hashFor = height => '0x' + height.toString(16).padStart(64, '0');
  const snapshot = () => {
    const number = qty(state.height), head = { number, hash: hashFor(state.height), timestamp: qty(now) };
    state.heads.set(number, head);
    state.snapshots.set(number, { ...state, claims: new Set(state.claims) });
    return head;
  };
  async function rpc(method, params = []) {
    state.calls.push({ method, params });
    if (state.rpcFailure) throw Object.assign(new Error('https://secret.example/private credential'), { retryableRead: true });
    if (method === 'eth_getBlockByNumber') {
      const head = params[0] === 'latest' ? snapshot() : state.heads.get(params[0]);
      return head ? { ...head, ...(state.reorg === params[0] ? { hash: BAD_HASH } : {}) } : null;
    }
    if (method === 'eth_getCode') return '0x1234';
    if (method === 'eth_getTransactionCount') return qty(params[1] === 'pending' ? state.pendingNonce : state.nonce);
    if (method === 'eth_estimateGas') return '0x186a0';
    if (method === 'eth_getTransactionByHash') return state.txs.get(params[0]) ?? null;
    if (method === 'eth_getTransactionReceipt') return state.receipts.get(params[0]) ?? null;
    assert.equal(method, 'eth_call', 'Only read-only RPC methods are permitted');
    const request = decodeFunctionData({ abi, data: params[0].data });
    const s = state.snapshots.get(params[1]); assert.ok(s, 'Reads must use a pinned block');
    const result = request.functionName === 'saleStatus' ? { phase: s.phase, paused: s.paused,
      freeMinted: s.freeMinted, freeSlotCount: s.slotCount, freeMintQuota: s.quota, freeConfigRevision: s.revision,
      freeDeadline: s.freeDeadline, paidStartTime: s.phase === 0 ? 0n : now, endReason: s.phase === 0 ? 0 : 1, lastPaidMintBlock: 0n }
      : request.functionName === 'freeMintRoot' ? s.root : request.functionName === 'paused' ? s.paused
      : request.functionName === 'defaultAdmin' ? s.admin
      : request.functionName === 'hasRole' ? request.args[1] === s.admin && (request.args[0] === PAUSER ? s.canPause : s.isAdmin)
      : request.functionName === 'isFreeSlotClaimed' ? s.claims.has(Number(request.args[0])) : assert.fail('Unexpected contract read');
    return encodeFunctionResult({ abi, functionName: request.functionName, result });
  }
  const context = { rpc, readStatus: () => ({}), unlock() { assert.fail('The web service must never open a signer'); } };
  const dependencies = { plan, context, directory, getAllowlist: () => { listReads++; return configuration; },
    persistAllowlist: value => { verifyAllowlistArtifacts(value.allowlist); state.writes.push(structuredClone(value)); configuration = structuredClone(value); },
    requireBinding: () => { if (!bindingReady) throw Object.assign(new Error('binding pending'), { code: 'RPC_DATA_UNAVAILABLE' }); return binding; },
    onUpdated: () => { updated++; } };
  const service = createSepoliaAdminWebService(dependencies);
  function include(intent, { hash = HASH, revert = false, txPatch = {}, receiptPatch = {}, wrongEvent = false, missingEvent = false, doNotApply = false } = {}) {
    const decoded = decodeFunctionData({ abi, data: intent.transaction.data });
    if (!revert && !doNotApply) {
      if (intent.action === 'pause') state.paused = true;
      else if (intent.action === 'unpause') state.paused = false;
      else {
        [state.root, state.slotCount, state.quota] = decoded.args; state.revision++;
        if (state.quota === state.freeMinted) state.phase = 1;
      }
    }
    state.height++; state.nonce++; state.pendingNonce = state.nonce;
    const head = snapshot(), pointers = { transactionHash: hash, blockHash: head.hash, blockNumber: head.number,
      transactionIndex: '0x0', logIndex: '0x0', removed: false };
    let logs = [];
    if (!revert && !missingEvent) {
      const eventName = intent.action === 'configure' ? 'FreeMintConfigured' : intent.action === 'pause' ? 'Paused' : 'Unpaused';
      let args, data;
      if (intent.action === 'configure') {
        const [root, slots, quota] = decoded.args;
        args = { configHash: keccak256(encodeAbiParameters(['bytes32', 'uint256', 'uint256', 'uint64'].map(type => ({ type })),
          [root, slots, quota, state.revision])) };
        data = encodeAbiParameters(['bytes32', 'uint256', 'uint256', 'uint64'].map(type => ({ type })),
          [wrongEvent ? BAD_HASH : root, slots, quota, state.revision]);
      } else { args = {}; data = encodeAbiParameters([{ type: 'address' }], [wrongEvent ? OTHER : ADMIN]); }
      logs = [{ address: AT, data, topics: encodeEventTopics({ abi, eventName, args }), ...pointers }];
    }
    state.txs.set(hash, { hash, from: ADMIN, to: AT, chainId: qty(11155111), value: '0x0', input: intent.transaction.data,
      nonce: intent.transaction.nonce, gas: intent.transaction.gas, blockHash: head.hash, blockNumber: head.number,
      transactionIndex: '0x0', ...txPatch });
    state.receipts.set(hash, { type: '0x2', status: revert ? '0x0' : '0x1', transactionHash: hash, from: ADMIN, to: AT,
      contractAddress: null, blockHash: head.hash, blockNumber: head.number, transactionIndex: '0x0',
      cumulativeGasUsed: '0x186a0', gasUsed: '0x186a0', effectiveGasPrice: '0x1', logsBloom: '0x' + '00'.repeat(256), logs, ...receiptPatch });
    return state.receipts.get(hash);
  }
  return { service, state, dependencies, directory, binding, include, configuration: () => configuration,
    setConfiguration: value => { configuration = value; }, listReads: () => listReads, updated: () => updated,
    setBindingReady: value => { bindingReady = value; }, restart: () => createSepoliaAdminWebService(dependencies),
    saved: () => getJson(resolve(directory, 'admin-web.json')) };
}

async function reviewedConfigure(f, quota = '3', wallets = [ADMIN, ADMIN, OTHER]) {
  const summary = await f.service.review(ADMIN, { wallets: wallets.join('\n'), quota });
  return { summary, intent: await f.service.action(ADMIN, { action: 'configure', reviewId: summary.reviewId }) };
}

test('status is lazy, authorizes current roles at a canonical block, and never exposes the list to another wallet', async t => {
  const f = fixture(t); f.setBindingReady(false);
  assert.equal(f.state.calls.length, 0); assert.equal(existsSync(resolve(f.directory, 'admin-web.json')), false);
  await assert.rejects(() => f.service.status(ADMIN), codeError('ADMIN_READ_UNAVAILABLE'));
  f.setBindingReady(true);
  await assert.rejects(() => f.service.status(OTHER), codeError('ADMIN_REQUIRED')); assert.equal(f.listReads(), 0);
  const status = await f.service.status(ADMIN);
  assert.equal(status.chainId, 11155111); assert.equal(status.collection, AT); assert.equal(status.policy.canPause, true);
  assert.deepEqual(status.wallets, [ADMIN, ADMIN]);
  assert.ok(f.state.calls.filter(row => row.method === 'eth_call').every(row => row.params[1] === '0x64'));
  f.state.isAdmin = false; await assert.rejects(() => f.service.status(ADMIN), codeError('ADMIN_REQUIRED'));
});

test('review preserves ordered duplicate slot IDs and can preview before pausing; exact tx is durable before return', async t => {
  const f = fixture(t, { paused: false });
  const summary = await f.service.review(ADMIN, { wallets: [ADMIN, ADMIN, OTHER].join('\n'), quota: '3' });
  assert.equal(summary.addedSlots, 1); assert.equal(summary.reassignedSlots, 0); assert.equal(summary.revision, '2');
  assert.equal(summary.previousSlotCount, '2'); assert.equal(summary.endsFreeMint, false);
  await assert.rejects(() => f.service.action(ADMIN, { action: 'configure', reviewId: summary.reviewId }), codeError('ADMIN_PAUSE_REQUIRED'));
  const pause = await f.service.action(ADMIN, { action: 'pause' });
  assert.equal(pause.transaction.value, '0x0'); assert.equal(pause.transaction.chainId, '0xaa36a7'); assert.equal(pause.transaction.nonce, '0x7');
  assert.equal(pause.transaction.gas, '0x1d4c0'); assert.equal(pause.transaction.from, ADMIN); assert.equal(pause.transaction.to, AT);
  assert.deepEqual(f.saved().intents[0].transaction, pause.transaction); assert.equal(lstatSync(resolve(f.directory, 'admin-web.json')).mode & 0o077, 0);
  f.include(pause); await f.service.report(ADMIN, { intentId: pause.intentId, transactionHash: HASH });
  assert.equal((await f.service.status(ADMIN)).review.reviewId, summary.reviewId, 'Pause must preserve the preview');
  const configure = await f.service.action(ADMIN, { action: 'configure', reviewId: summary.reviewId });
  const decoded = decodeFunctionData({ abi, data: configure.transaction.data });
  assert.equal(decoded.functionName, 'configureFreeMint'); assert.deepEqual(decoded.args, [summary.root, 3n, 3n]);
  const restored = await f.restart().status(ADMIN); assert.equal(restored.pending.intentId, configure.intentId);
  await assert.rejects(() => f.service.action(ADMIN, { action: 'unpause' }), codeError('ADMIN_ACTION_PENDING'));
});

test('claimed replacement, shrinking capacity, decimal quota and 5,000-slot limits fail safely', async t => {
  const f = fixture(t, { freeMinted: 1n, claims: new Set([0]) });
  await assert.rejects(() => f.service.review(ADMIN, { wallets: [OTHER, ADMIN].join('\n'), quota: '2' }), codeError('CLAIMED_SLOT_REPLACEMENT'));
  await assert.rejects(() => f.service.review(ADMIN, { wallets: ADMIN, quota: '1' }), codeError('SLOT_CAPACITY_SHRINK'));
  for (const quota of ['0', '3']) await assert.rejects(() => f.service.review(ADMIN, { wallets: [ADMIN, ADMIN].join('\n'), quota }), codeError('INVALID_QUOTA'));
  for (const quota of ['01', '-1', '1.5', 2]) await assert.rejects(() => f.service.review(ADMIN, { wallets: ADMIN, quota }), codeError('INVALID_INPUT'));
  await assert.rejects(() => f.service.review(ADMIN, { wallets: Array(5001).fill(ADMIN).join('\n'), quota: '2' }), codeError('INVALID_WALLETS'));
  const summary = await f.service.review(ADMIN, { wallets: [ADMIN, OTHER].join('\n'), quota: '1' });
  assert.equal(summary.reassignedSlots, 1); assert.equal(summary.endsFreeMint, true);
});

test('paid/deadline closure, current pauser role, stale minted count and queued wallet gate each new action', async t => {
  const f = fixture(t);
  f.state.phase = 1; await assert.rejects(() => f.service.review(ADMIN, { wallets: [ADMIN, ADMIN].join('\n'), quota: '2' }), codeError('FREE_POLICY_CLOSED'));
  f.state.phase = 0; f.state.freeDeadline = 1n;
  await assert.rejects(() => f.service.review(ADMIN, { wallets: [ADMIN, ADMIN].join('\n'), quota: '2' }), codeError('FREE_POLICY_CLOSED'));
  f.state.freeDeadline = BigInt(Math.floor(Date.now() / 1000)) + 5000n;
  const summary = await f.service.review(ADMIN, { wallets: [ADMIN, ADMIN, OTHER].join('\n'), quota: '3' });
  f.state.freeMinted = 1n;
  await assert.rejects(() => f.service.action(ADMIN, { action: 'configure', reviewId: summary.reviewId }), codeError('ADMIN_REVIEW_STALE'));
  f.state.freeMinted = 0n; f.state.canPause = false;
  await assert.rejects(() => f.service.action(ADMIN, { action: 'unpause' }), codeError('ADMIN_PAUSER_REQUIRED'));
  f.state.canPause = true; f.state.pendingNonce = 8n;
  await assert.rejects(() => f.service.action(ADMIN, { action: 'unpause' }), codeError('ADMIN_WALLET_PENDING'));
  assert.equal(f.saved().intents.length, 0);
});

test('matching canonical transaction, configuration event and new state publish exact CLI-compatible artifacts', async t => {
  const f = fixture(t), { summary, intent } = await reviewedConfigure(f);
  f.include(intent);
  const result = await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH });
  assert.deepEqual(result, { state: 'confirmed', transactionHash: HASH }); assert.equal(f.state.writes.length, 1);
  const applied = f.configuration(); assert.equal(applied.schema, 'sg-pulse-free-configuration/v1'); assert.equal(applied.root, summary.root);
  assert.equal(applied.revision, '2'); assert.equal(applied.quota, '3'); assert.equal(applied.transactionHash, HASH);
  verifyAllowlistArtifacts(applied.allowlist); assert.equal(f.updated(), 1);
  assert.deepEqual((await f.restart().status(ADMIN)).wallets, [ADMIN, ADMIN, OTHER]);
  await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH }); assert.equal(f.state.writes.length, 1);
  f.state.reorg = f.state.receipts.get(HASH).blockNumber;
  await assert.rejects(() => f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH }), codeError('ADMIN_EVIDENCE_CONFLICT'));
});

test('a hash alone stays pending and unknown delivery survives restart without sending or publishing', async t => {
  const f = fixture(t), { intent } = await reviewedConfigure(f);
  const result = await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH });
  assert.equal(result.state, 'pending'); assert.equal(result.hashValidated, false); assert.equal(f.state.writes.length, 0);
  const pending = (await f.restart().status(ADMIN)).pending; assert.equal(pending.transactionHash, HASH); assert.equal(pending.hashValidated, false);
  await assert.rejects(() => f.service.cancel(ADMIN, { intentId: intent.intentId }), codeError('ADMIN_ACTION_UNCERTAIN'));
  assert.equal(f.state.calls.some(row => /send|sign/i.test(row.method)), false);
});

test('exact sender, target, chain, calldata, value, nonce and gas are checked before receipt acceptance', async t => {
  for (const txPatch of [{ from: OTHER }, { to: OTHER }, { chainId: '0x1' }, { input: '0x12345678' },
    { value: '0x1' }, { nonce: '0x8' }, { gas: '0x1' }]) {
    const f = fixture(t), { intent } = await reviewedConfigure(f); f.include(intent, { txPatch });
    await assert.rejects(() => f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH }), codeError('ADMIN_TRANSACTION_MISMATCH'));
    assert.equal(f.state.writes.length, 0); assert.equal(f.saved().intents[0].state, 'prepared');
  }
});

test('canonical receipt pointers and matching expected event are mandatory', async t => {
  for (const options of [{ wrongEvent: true }, { missingEvent: true }, { receiptPatch: { blockHash: BAD_HASH } },
    { receiptPatch: { to: OTHER } }, { receiptPatch: { transactionHash: BAD_HASH } }]) {
    const f = fixture(t), { intent } = await reviewedConfigure(f); f.include(intent, options);
    await assert.rejects(() => f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH }), codeError('ADMIN_EVIDENCE_CONFLICT'));
    assert.equal(f.state.writes.length, 0);
  }
});

test('reverted canonical transactions settle safely without publishing or automatic replacement', async t => {
  const f = fixture(t), { intent } = await reviewedConfigure(f); f.include(intent, { revert: true });
  assert.deepEqual(await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH }), { state: 'reverted', transactionHash: HASH });
  assert.equal(f.state.writes.length, 0); assert.equal(f.saved().intents[0].state, 'reverted');
  assert.equal((await f.restart().status(ADMIN)).pending, undefined);
  assert.equal(f.state.calls.some(row => /send|sign/i.test(row.method)), false);
});

test('explicit wallet rejection records abandonment; late same-nonce winner retires competing prepared request', async t => {
  const f = fixture(t), { intent } = await reviewedConfigure(f);
  await f.service.cancel(ADMIN, { intentId: intent.intentId });
  assert.equal(f.saved().intents[0].state, 'abandoned'); assert.equal(f.state.writes.length, 0);
  const after = await f.restart().status(ADMIN); assert.equal(after.pending, undefined); assert.equal(after.lastIntent.intentId, intent.intentId);
  const competing = await f.service.action(ADMIN, { action: 'configure', reviewId: intent.summary.reviewId });
  assert.equal(competing.transaction.nonce, intent.transaction.nonce);
  f.include(intent);
  await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH });
  assert.equal(f.saved().intents.find(row => row.intentId === competing.intentId).state, 'superseded');
  const status = await f.service.status(ADMIN); assert.equal(status.pending, undefined);
  assert.equal(status.resolvedIntents.find(row => row.intentId === competing.intentId).state, 'superseded');
  assert.ok(status.resolvedIntents.every(row => !row.transaction && !row.configuration));
});

test('a mismatched hash cannot reactivate an abandoned intent or publish a configuration', async t => {
  const f = fixture(t), { intent } = await reviewedConfigure(f);
  await f.service.cancel(ADMIN, { intentId: intent.intentId }); f.include(intent, { txPatch: { from: OTHER } });
  await assert.rejects(() => f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH }), codeError('ADMIN_TRANSACTION_MISMATCH'));
  assert.equal(f.saved().intents[0].state, 'abandoned'); assert.equal(f.state.writes.length, 0);
});

test('successful superseded policy settles as history without overwriting current allowlist files', async t => {
  const f = fixture(t), { intent } = await reviewedConfigure(f); f.include(intent);
  f.state.height++; f.state.revision++; f.state.root = BAD_HASH;
  const result = await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH });
  assert.equal(result.state, 'confirmed'); assert.equal(result.configurationSuperseded, true);
  assert.equal(f.state.writes.length, 0); assert.equal(f.saved().intents[0].state, 'confirmed');
});

test('artifact mismatch disables review but leaves current admin pause controls available', async t => {
  const f = fixture(t); f.setConfiguration({ ...f.configuration(), revision: '999' });
  const status = await f.service.status(ADMIN); assert.deepEqual(status.wallets, []); assert.ok(status.configurationError);
  await assert.rejects(() => f.service.review(ADMIN, { wallets: [ADMIN, ADMIN].join('\n'), quota: '2' }), codeError('ADMIN_ARTIFACTS_MISMATCH'));
  const intent = await f.service.action(ADMIN, { action: 'unpause' }); assert.equal(intent.action, 'unpause');
});

test('durable state rejects a changed deployment, malformed rows, nonprivate files and symlinks', async t => {
  const f = fixture(t); await reviewedConfigure(f);
  const original = f.saved(); f.binding.deployment.blockHash = BAD_HASH;
  await assert.rejects(() => f.restart().status(ADMIN), codeError('ADMIN_BINDING_CHANGED'));
  f.binding.deployment.blockHash = original.binding.deployment.blockHash;
  const corrupt = structuredClone(original); corrupt.intents[0].state = 'whatever';
  writeFileSync(resolve(f.directory, 'admin-web.json'), JSON.stringify(corrupt), { mode: 0o600 });
  await assert.rejects(() => f.restart().status(ADMIN), codeError('ADMIN_STORAGE_UNAVAILABLE'));
  writeFileSync(resolve(f.directory, 'admin-web.json'), JSON.stringify(original)); chmodSync(resolve(f.directory, 'admin-web.json'), 0o644);
  await assert.rejects(() => f.restart().status(ADMIN), codeError('ADMIN_STORAGE_UNAVAILABLE'));
  const g = fixture(t); symlinkSync(resolve(f.directory, 'admin-web.json'), resolve(g.directory, 'admin-web.json'));
  await assert.rejects(() => g.service.status(ADMIN), codeError('ADMIN_STORAGE_UNAVAILABLE'));
});

test('read failures suppress raw diagnostics, and invalid request fields never become arbitrary wallet transactions', async t => {
  const f = fixture(t); f.state.rpcFailure = true;
  await assert.rejects(() => f.service.status(ADMIN), codeError('ADMIN_READ_UNAVAILABLE'));
  f.state.rpcFailure = false;
  for (const body of [{ action: 'configure', data: '0x1234' }, { action: 'transfer' }, { action: 'pause', to: OTHER },
    { action: 'pause', value: '0x1' }, { action: 'pause', reviewId: 'anything' }])
    await assert.rejects(() => f.service.action(ADMIN, body), error => { assert.equal(error.status, 400); return true; });
  assert.equal(f.state.calls.some(row => /send|sign/i.test(row.method)), false);
});

test('whole reads use fallback and commit only the selected semantic result', async t => {
  const f = fixture(t); let primaryCalls = 0, secondaryCalls = 0;
  const rpc = f.dependencies.context.rpc;
  const context = createSepoliaReadFailover({
    rpc: async (...args) => { primaryCalls++; throw Object.assign(new Error('primary unavailable'), { retryableRead: true }); },
    second: async (...args) => { secondaryCalls++; return rpc(...args); },
  }, async () => {}, { attemptTimeoutMs: 100 });
  const service = createSepoliaAdminWebService({ ...f.dependencies, context });
  const summary = await service.review(ADMIN, { wallets: [ADMIN, ADMIN, OTHER].join('\n'), quota: '3' });
  assert.equal(f.saved().reviews.length, 1); assert.equal(f.saved().reviews[0].reviewId, summary.reviewId);
  assert.ok(primaryCalls > 0 && secondaryCalls > 0); assert.equal(f.saved().intents.length, 0);
});

test('zero quota deliberately ends free minting and configure does not require the pauser role', async t => {
  const f = fixture(t, { canPause: false });
  const summary = await f.service.review(ADMIN, { wallets: [ADMIN, ADMIN].join('\n'), quota: '0' });
  assert.equal(summary.endsFreeMint, true);
  const intent = await f.service.action(ADMIN, { action: 'configure', reviewId: summary.reviewId });
  f.include(intent);
  assert.equal((await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH })).state, 'confirmed');
  assert.equal(f.state.phase, 1); assert.equal(f.configuration().quota, '0');
  await assert.rejects(() => f.service.review(ADMIN, { wallets: [ADMIN, ADMIN].join('\n'), quota: '2' }), codeError('FREE_POLICY_CLOSED'));
});

test('a verified pending hash cannot be replaced; an unindexed candidate can be corrected explicitly', async t => {
  const f = fixture(t), { intent } = await reviewedConfigure(f);
  await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: BAD_HASH });
  f.include(intent); const receipt = f.state.receipts.get(HASH); f.state.receipts.delete(HASH);
  const pending = await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH });
  assert.equal(pending.hashValidated, true); assert.equal((await f.service.status(ADMIN)).pending.hashValidated, true);
  await assert.rejects(() => f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: BAD_HASH }), codeError('ADMIN_TRANSACTION_MISMATCH'));
  f.state.receipts.set(HASH, receipt);
  assert.equal((await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH })).state, 'confirmed');
});

test('abandoned requests keep compact ordered wallets for late pending recovery across restart', async t => {
  const f = fixture(t), { intent } = await reviewedConfigure(f);
  await f.service.cancel(ADMIN, { intentId: intent.intentId });
  const abandoned = f.saved().intents[0];
  assert.deepEqual(abandoned.configuration.wallets, [ADMIN, ADMIN, OTHER]); assert.equal(abandoned.configuration.allowlist, undefined);
  f.include(intent); const receipt = f.state.receipts.get(HASH); f.state.receipts.delete(HASH);
  await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH });
  const restored = f.restart(); assert.equal((await restored.status(ADMIN)).pending.intentId, intent.intentId);
  f.state.receipts.set(HASH, receipt);
  assert.equal((await restored.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH })).state, 'confirmed');
  verifyAllowlistArtifacts(f.configuration().allowlist);
});

test('settled configuration history omits full proof copies over repeated updates', async t => {
  const f = fixture(t); let wallets = [ADMIN, ADMIN];
  for (let i = 1; i <= 10; i++) {
    wallets = [...wallets, OTHER];
    const { intent } = await reviewedConfigure(f, String(wallets.length), wallets);
    const hash = '0x' + i.toString(16).padStart(64, '0'); f.include(intent, { hash });
    await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: hash });
  }
  const saved = f.saved(); assert.equal(saved.reviews.length, 8); assert.equal(saved.intents.length, 10);
  assert.ok(saved.intents.every(row => !row.configuration.allowlist && !row.configuration.wallets && row.configuration.allowlistDigest));
  assert.ok(lstatSync(resolve(f.directory, 'admin-web.json')).size < 100000);
  assert.equal((await f.restart().status(ADMIN)).wallets.length, 12);
});

test('history limits refuse another request instead of deleting abandoned executable tombstones', async t => {
  const f = fixture(t);
  for (let i = 0; i < 64; i++) {
    const intent = await f.service.action(ADMIN, { action: 'unpause' });
    await f.service.cancel(ADMIN, { intentId: intent.intentId });
  }
  const first = f.saved().intents[0].intentId;
  await assert.rejects(() => f.service.action(ADMIN, { action: 'unpause' }), codeError('ADMIN_STORAGE_FULL'));
  assert.equal(f.saved().intents.length, 64); assert.equal(f.saved().intents[0].intentId, first);
  assert.equal((await f.restart().status(ADMIN)).pending, undefined);
});

test('a persistence failure prevents returning the wallet request', async t => {
  const f = fixture(t); chmodSync(f.directory, 0o755);
  await assert.rejects(() => f.service.action(ADMIN, { action: 'unpause' }), codeError('ADMIN_STORAGE_UNAVAILABLE'));
  assert.equal(existsSync(resolve(f.directory, 'admin-web.json')), false);
  assert.equal(f.state.calls.some(row => /send|sign/i.test(row.method)), false);
});

test('same-nonce competitor is retired after a canonical revert and cannot be reactivated', async t => {
  const f = fixture(t), { intent } = await reviewedConfigure(f);
  await f.service.cancel(ADMIN, { intentId: intent.intentId });
  const competing = await f.service.action(ADMIN, { action: 'configure', reviewId: intent.summary.reviewId });
  f.include(intent, { revert: true }); await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH });
  assert.equal(f.saved().intents.find(row => row.intentId === competing.intentId).state, 'superseded');
  await assert.rejects(() => f.service.report(ADMIN, { intentId: competing.intentId, transactionHash: BAD_HASH }), codeError('ADMIN_INTENT_SUPERSEDED'));
  assert.equal(f.state.writes.length, 0);
});

test('a later same-block pause toggle does not prevent settling the exact historical action', async t => {
  const f = fixture(t, { paused: false });
  const intent = await f.service.action(ADMIN, { action: 'pause' }); f.include(intent);
  // The receipt block's end state includes a later unpause transaction whose
  // event belongs to a different receipt.
  f.state.paused = false;
  assert.equal((await f.service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH })).state, 'confirmed');
  assert.equal(f.state.writes.length, 0); assert.equal((await f.service.status(ADMIN)).policy.paused, false);
});

test('a durably reported hash cannot be abandoned after receipt observation fails', async t => {
  const f = fixture(t), { intent } = await reviewedConfigure(f);
  const rpc = f.dependencies.context.rpc;
  f.dependencies.context.rpc = async (method, ...rest) => {
    if (method === 'eth_getTransactionReceipt') throw Object.assign(new Error('private RPC failure'), { retryableRead: true });
    return rpc(method, ...rest);
  };
  const service = f.restart();
  await assert.rejects(() => service.report(ADMIN, { intentId: intent.intentId, transactionHash: HASH }), codeError('ADMIN_READ_UNAVAILABLE'));
  assert.equal(f.saved().intents[0].reportedHash, HASH); assert.equal(f.saved().intents[0].transactionHash, undefined);
  assert.equal((await service.status(ADMIN)).pending.transactionHash, HASH);
  await assert.rejects(() => service.cancel(ADMIN, { intentId: intent.intentId }), codeError('ADMIN_ACTION_UNCERTAIN'));
});

test('canonical checkpoint survives pruning the only settled receipt from bounded history', async t => {
  const f = fixture(t); let first;
  for (let i = 0; i < 64; i++) {
    const intent = await f.service.action(ADMIN, { action: 'unpause' }); first ??= intent;
    await f.service.cancel(ADMIN, { intentId: intent.intentId });
  }
  const receipt = f.include(first);
  await f.service.report(ADMIN, { intentId: first.intentId, transactionHash: HASH });
  await f.service.action(ADMIN, { action: 'pause' });
  assert.equal(f.saved().intents.some(row => row.intentId === first.intentId), false);
  assert.equal(f.saved().checkpoint.hash, receipt.blockHash);
  f.state.reorg = receipt.blockNumber;
  await assert.rejects(() => f.restart().status(ADMIN), codeError('ADMIN_EVIDENCE_CONFLICT'));
});
