import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeFunctionResult, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sendAdminStep, parseAdminArgs, main, configurationOperation, operatorContext, readAdminPolicy } from '../../scripts/pulse-sepolia-admin.mjs';
import { withSepoliaReadSource } from '../../scripts/pulse-sepolia-rpc.mjs';
import { loadPulseAdminArtifact } from './pulse-admin-candidate.mjs';
import { ADMIN_PROFILE, sepoliaAdminTestPlan, planAdminFreeUpdate, ADMIN_TEST_WALLET } from './pulse-sepolia-admin-plan.mjs';
import { DEPLOYER } from './pulse-sepolia-plan.mjs';

const wallet = privateKeyToAccount('0x' + '1'.padStart(64, '0'));
const at = '0x2222222222222222222222222222222222222222';
const blockHash = '0x' + '11'.repeat(32);
const fees = { maxGasPerTransaction: '8000000', maxFeePerGas: '20000000000',
  maxPriorityFeePerGas: '1000000000', totalWorstCaseWei: '150000000000000000' };
const basePlan = { contractProfile: ADMIN_PROFILE, chainId: 11155111, digest: 'fixture-plan',
  collection: { address: at }, fees };
const request = { to: at, data: '0x12345678', value: '0x0' };
function fixture(options = {}) {
  const plan = structuredClone(basePlan), journal = { planDigest: plan.digest, transactions: {}, operations: {} };
  const state = { delivered: false, included: false, sendCount: 0, unlockCount: 0, signedCount: 0,
    persisted: [], calls: [], raws: [], latest: 5, pending: 5, ...options };
  const persist = async () => {
    if (state.persistFailure) throw new Error('disk failure');
    state.persisted.push(structuredClone(journal));
  };
  const receipt = hash => ({ transactionHash: hash, from: wallet.address, to: request.to, contractAddress: null,
    status: '0x1', blockNumber: '0x6', blockHash, gasUsed: '0xc350', effectiveGasPrice: '0xb2d05e00', ...state.receiptPatch });
  const c = {
    unlock() { state.unlockCount++; return { address: wallet.address,
      async signTransaction(tx) { state.signedCount++; return wallet.signTransaction(tx); } }; },
    async rpc(method, params) {
      state.calls.push({ method, params });
      if (method === 'eth_getTransactionCount') return '0x' + state[params[1]].toString(16);
      if (method === 'eth_getBlockByNumber') return { hash: state.canonicalHash ?? blockHash, number: '0x6', baseFeePerGas: state.baseFee ?? '0x3b9aca00' };
      if (method === 'eth_estimateGas') return state.gas ?? '0xc350';
      if (method === 'eth_getBalance') return state.balance ?? '0x8ac7230489e80000';
      if (method === 'eth_getTransactionReceipt') return state.included ? receipt(params[0]) : null;
      if (method === 'eth_getTransactionByHash') return state.delivered ? { hash: params[0] } : null;
      if (method === 'eth_sendRawTransaction') {
        state.sendCount++; state.raws.push(params[0]);
        assert.ok(state.persisted.some(j => Object.values(j.transactions).some(tx =>
          tx.raw === params[0] && tx.status === 'delivery-unknown')), 'signed transaction was not durable before delivery');
        state.delivered = true;
        if (state.sendFailure) throw new Error('untrusted RPC secret diagnostic');
        if (state.wrongReturnedHash) return '0x' + '9'.repeat(64);
        state.included = !state.neverIncluded; return keccak256(params[0]);
      }
      throw new Error('Unexpected test RPC ' + method);
    },
  };
  const send = (step = 'unpause-1', req = request, extra = {}) => sendAdminStep(c, plan, journal, step, req,
    { expectedSigner: wallet.address, persist, pollTimeoutMs: 50, wait: async () => {}, ...extra });
  return { c, plan, journal, state, send, persist };
}

test('admin write flags are mandatory and invalid CLI inputs fail before opening secrets/RPC', async () => {
  for (const args of [[], ['deploy'], ['configure', 'wallets.txt', '4'], ['configure', 'wallets.txt', '4', '--force'],
    ['configure', 'wallets.txt', '-1', '--broadcast'], ['configure', 'wallets.txt', '01', '--broadcast'],
    ['pause'], ['unpause'], ['smoke'], ['inspect', '--broadcast'], ['mainnet', '--broadcast'],
    ['prepare', '--broadcast']]) {
    assert.throws(() => parseAdminArgs(args)); await assert.rejects(() => main(args));
  }
  assert.deepEqual(parseAdminArgs(['deploy', '--broadcast']), { command: 'deploy' });
  assert.deepEqual(parseAdminArgs(['configure', 'wallets.txt', '4', '--broadcast']), { command: 'configure', walletFile: 'wallets.txt', quota: '4' });
  assert.deepEqual(parseAdminArgs(['inspect']), { command: 'inspect' });
});

test('admin signed bytes and exact nonce are journaled before a successful free/admin delivery', async () => {
  const f = fixture(); const receipt = await f.send();
  assert.equal(f.state.sendCount, 1); assert.equal(f.state.signedCount, 1);
  assert.equal(f.journal.transactions['unpause-1'].status, 'included');
  assert.equal(receipt.transactionHash, f.journal.transactions['unpause-1'].hash);
  assert.ok(f.state.persisted.some(j => j.transactions['unpause-1']?.status === 'signed'));
  assert.ok(f.state.persisted.some(j => j.transactions['unpause-1']?.status === 'delivery-unknown'));
  assert.equal(f.state.calls.filter(c => c.method === 'eth_sendRawTransaction').length, 1);
});

test('unknown delivery preserves exact bytes and resumes an included transaction without another send or signature', async () => {
  const f = fixture({ sendFailure: true });
  await assert.rejects(() => f.send(), /delivery is uncertain/);
  const saved = structuredClone(f.journal.transactions['unpause-1']);
  assert.equal(saved.status, 'delivery-unknown'); assert.equal(f.state.sendCount, 1);
  f.state.included = true; f.state.latest = 6; f.state.pending = 6;
  await f.send();
  assert.equal(f.state.sendCount, 1); assert.equal(f.state.signedCount, 1);
  assert.equal(f.journal.transactions['unpause-1'].raw, saved.raw);
  assert.equal(f.journal.transactions['unpause-1'].nonce, saved.nonce);
});

test('unknown delivery does not silently replace a changed nonce or request', async () => {
  const f = fixture({ sendFailure: true }); await assert.rejects(() => f.send());
  f.state.delivered = false; f.state.latest = 6; f.state.pending = 6;
  await assert.rejects(() => f.send(), /Signed nonce changed/);
  await assert.rejects(() => f.send('unpause-1', { ...request, data: '0x56781234' }), /cannot be replaced/);
  assert.equal(f.state.sendCount, 1); assert.equal(f.state.signedCount, 1);
});

test('explicit resume may only redeliver the identical signed transaction at the unchanged nonce', async () => {
  const f = fixture({ sendFailure: true }); await assert.rejects(() => f.send());
  const raw = f.journal.transactions['unpause-1'].raw;
  f.state.delivered = false; f.state.sendFailure = false;
  await f.send();
  assert.deepEqual(f.state.raws, [raw, raw]); assert.equal(f.state.signedCount, 1);
});

test('disk failure prevents any broadcast and unrelated unresolved steps prevent signing', async () => {
  const f = fixture({ persistFailure: true }); await assert.rejects(() => f.send(), /disk failure/);
  assert.equal(f.state.sendCount, 0);
  const g = fixture(); g.journal.transactions.collection = { status: 'delivery-unknown', worstCaseWei: '1' };
  await assert.rejects(() => g.send(), /previous journal transaction/);
  assert.equal(g.state.signedCount, 0); assert.equal(g.state.calls.length, 0);
});

test('gas, fee, total exposure, balance and nonce limits are checked before unlocking/signing', async () => {
  const cases = [
    f => f.state.gas = '0x7a1200',
    f => f.state.baseFee = '0x4a817c800',
    f => f.plan.fees.totalWorstCaseWei = '1',
    f => f.state.balance = '0x0',
    f => f.state.pending = 6,
  ];
  for (const patch of cases) {
    const f = fixture(); patch(f); await assert.rejects(() => f.send());
    assert.equal(f.state.unlockCount, 0); assert.equal(f.state.signedCount, 0); assert.equal(f.state.sendCount, 0);
  }
  const f = fixture(); await assert.rejects(() => f.send('unpause-1', request, { nonce: 6 }), /CREATE nonce changed/);
  assert.equal(f.state.unlockCount, 0);
});

test('expired/changed free policy preflight blocks delivery while retaining a recoverable signed attempt', async () => {
  const f = fixture();
  await assert.rejects(() => f.send('free0', request, { beforeBroadcast: async () => { throw new Error('Free phase closed'); } }), /Free phase closed/);
  assert.equal(f.state.sendCount, 0); assert.equal(f.journal.transactions.free0.status, 'signed');
  assert.ok(f.state.persisted.some(j => j.transactions.free0?.raw));
});

test('pending or reverted receipts never trigger automatic replacement', async () => {
  const f = fixture({ neverIncluded: true }); await assert.rejects(() => f.send('free0', request, { pollTimeoutMs: 0 }), /Transaction pending/);
  assert.equal(f.state.sendCount, 1);
  const g = fixture({ receiptPatch: { status: '0x0' } }); await assert.rejects(() => g.send(), /reverted/);
  assert.equal(g.journal.transactions['unpause-1'].status, 'reverted');
  await assert.rejects(() => g.send(), /Reverted transaction/);
  assert.equal(g.state.sendCount, 1); assert.equal(g.state.signedCount, 1);
  const h = fixture({ receiptPatch: { status: '0x0', to: null, contractAddress: null } });
  await assert.rejects(() => h.send('collection', { data: '0x12345678', value: '0x0' }), /reverted/);
  assert.equal(h.journal.transactions.collection.status, 'reverted');
  assert.equal(h.state.sendCount, 1);
});

test('foreign receipt pointers and noncanonical blocks cannot be recorded as included', async () => {
  for (const receiptPatch of [{ from: at }, { to: wallet.address }, { contractAddress: at },
    { transactionHash: '0x' + '0'.repeat(64) }, { status: '0x2' }]) {
    const f = fixture({ receiptPatch }); await assert.rejects(() => f.send());
    assert.notEqual(f.journal.transactions['unpause-1'].status, 'included');
  }
  const f = fixture({ canonicalHash: '0x' + '9'.repeat(64) }); await assert.rejects(() => f.send(), /canonical chain/);
  assert.notEqual(f.journal.transactions['unpause-1'].status, 'included');
});

test('unexpected returned hash stays delivery-unknown and does not retry automatically', async () => {
  const f = fixture({ wrongReturnedHash: true }); await assert.rejects(() => f.send(), /delivery is uncertain/);
  assert.equal(f.state.sendCount, 1); assert.equal(f.journal.transactions['unpause-1'].status, 'delivery-unknown');
});

test('admin runner rejects foreign profile, recipient, value, extra fields and arbitrary step names without RPC', async () => {
  for (const req of [{ ...request, to: wallet.address }, { ...request, value: '0x1' }, { ...request, from: wallet.address }]) {
    const f = fixture(); await assert.rejects(() => f.send('unpause-1', req)); assert.equal(f.state.calls.length, 0);
  }
  const f = fixture(); await assert.rejects(() => f.send('paid0')); assert.equal(f.state.calls.length, 0);
  f.plan.contractProfile = 'generative-pulse-v1-rc1'; await assert.rejects(() => f.send()); assert.equal(f.state.calls.length, 0);
});

test('configuration planning preserves stable IDs, is current-policy idempotent and pending-update exact', () => {
  const p = sepoliaAdminTestPlan({ deployer: DEPLOYER, authorizer: '0x8888888888888888888888888888888888888888',
    nonce: 81, createdAt: 1790935200 });
  const current = { paused: true, phase: 0, root: p.sale.freeMintRoot, slotCount: '2', quota: '2', revision: '1',
    freeMinted: '0', timestamp: '1790935200', freeDeadline: p.sale.freeDeadline };
  const prior = { ...current, allowlist: p.allowlist }, rows = [DEPLOYER, DEPLOYER, ADMIN_TEST_WALLET, ADMIN_TEST_WALLET];
  const j = { planDigest: p.digest, transactions: {}, operations: {} };
  assert.equal(configurationOperation(p, j, prior, [DEPLOYER, DEPLOYER], '2', current).alreadyCurrent, true);
  const op = configurationOperation(p, j, prior, rows, '4', current);
  assert.equal(op.step, 'configure-r2'); assert.equal(op.configuration.revision, '2');
  j.operations[op.step] = { kind: 'configure', configuration: op.configuration };
  j.transactions[op.step] = { status: 'delivery-unknown' };
  assert.deepEqual(configurationOperation(p, j, prior, rows, '4', current), op);
  assert.deepEqual(configurationOperation(p, j, prior, rows, '4',
    { ...current, revision: '2', root: op.configuration.root, quota: '4', slotCount: '4' }), op);
  assert.throws(() => configurationOperation(p, j, prior, rows, '3', current));
  assert.throws(() => configurationOperation(p, j, prior, [DEPLOYER, DEPLOYER, ADMIN_TEST_WALLET], '3', current));
  const ended = { ...current, phase: 1 };
  assert.throws(() => planAdminFreeUpdate(p.allowlist, rows, '4', ended));
});

test('operator endpoints and audit source count are validated before opening the approved signing context', () => {
  let opened = 0;
  const baseFactory = () => { opened++; throw new Error('Do not open signing context'); };
  for (const env of [{ SEPOLIA_ADMIN_RPC_URL: 'http://primary.test' },
    { SEPOLIA_ADMIN_SECONDARY_RPC_URL: 'https://secondary.test' },
    { SEPOLIA_ADMIN_RPC_URL: 'https://primary.test', SEPOLIA_ADMIN_SECONDARY_RPC_URL: 'https://primary.test/other' },
    { SEPOLIA_ADMIN_AUDIT_SOURCES: '0' }, { SEPOLIA_ADMIN_AUDIT_SOURCES: '3' }]) {
    assert.throws(() => operatorContext({ env, baseFactory }));
  }
  assert.equal(opened, 0);
});

test('operator ordinary reads discard a failed semantic attempt and retry pinned to the secondary, never writes', async () => {
  const calls = [], validation = [];
  const primary = async (method, params) => {
    calls.push(['primary', method, params]);
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getBalance') return 'primary-balance';
    throw Object.assign(new Error('unavailable'), { retryableRead: true });
  };
  const secondary = async (method, params) => {
    calls.push(['secondary', method, params]);
    return method === 'eth_chainId' ? '0xaa36a7' : 'secondary-' + method;
  };
  const c = operatorContext({ env: {}, baseFactory: () => ({ rpc: primary, second: secondary, unlock() {} }),
    validateSource: async source => { validation.push(source.readSource ?? 'write'); assert.equal(await source.rpc('eth_chainId'), '0xaa36a7'); } });
  const result = await withSepoliaReadSource(c.readContext, async source =>
    [await source.rpc('eth_getBalance', [at]), await source.rpc('eth_getCode', [at])]);
  assert.deepEqual(result, ['secondary-eth_getBalance', 'secondary-eth_getCode']);
  assert.deepEqual(validation, ['primary', 'secondary']);
  assert.equal(c.readContext.readStatus().failovers, 1);
  await assert.rejects(() => c.rpc('eth_sendRawTransaction', ['0x1234']));
  assert.equal(calls.filter(([source, method]) => source === 'primary' && method === 'eth_sendRawTransaction').length, 1);
  assert.equal(calls.filter(([source, method]) => source === 'secondary' && method === 'eth_sendRawTransaction').length, 0);
  assert.throws(() => c.readContext.rpc('eth_sendRawTransaction', ['0x1234']), /read-only/);
});

test('custom HTTPS operator routing preserves custody and validates the selected primary before unlocking', async () => {
  const calls = [], validations = [];
  const unlock = () => wallet;
  const c = operatorContext({ env: { SEPOLIA_ADMIN_RPC_URL: 'https://primary.test',
    SEPOLIA_ADMIN_SECONDARY_RPC_URL: 'https://secondary.test', SEPOLIA_ADMIN_AUDIT_SOURCES: '1' },
    baseFactory: () => ({ rpc() { throw new Error('Old primary must not run'); },
      second() { throw new Error('Old secondary must not run'); }, unlock }),
    minimumStartIntervalMs: 0, transportFactory: url => async (method) => { calls.push([url, method]); return '0xaa36a7'; },
    validateSource: async source => { assert.equal(source.second, undefined); validations.push(source.readPolicy);
      assert.equal(await source.rpc('eth_chainId'), '0xaa36a7'); } });
  assert.equal(c.unlock, unlock); assert.equal(c.auditSources, 1);
  await c.validateWriteSource(); assert.deepEqual(validations, ['validated-write-primary/v1']);
  assert.deepEqual(calls, [['https://primary.test', 'eth_chainId']]);
  await c.rpc('eth_sendRawTransaction', ['0x1234']);
  assert.deepEqual(calls.at(-1), ['https://primary.test', 'eth_sendRawTransaction']);
  const f = fixture(); f.c.validateWriteSource = async () => { assert.equal(f.state.unlockCount, 0); throw new Error('Wrong write chain'); };
  await assert.rejects(() => f.send(), /Wrong write chain/);
  assert.equal(f.state.unlockCount, 0); assert.equal(f.state.sendCount, 0);
  const g = fixture({ sendFailure: true }); await assert.rejects(() => g.send());
  g.state.included = true; g.c.validateWriteSource = async () => { throw new Error('Resume source changed'); };
  await assert.rejects(() => g.send(), /Resume source changed/);
  assert.equal(g.journal.transactions['unpause-1'].status, 'delivery-unknown');
  assert.equal(g.state.sendCount, 1); assert.equal(g.state.signedCount, 1);
});

test('replacement wallet claim evidence is queried at the same concrete policy block and rechecked for canonicality', async () => {
  const abi = loadPulseAdminArtifact().abi, queries = [], root = '0x' + '5'.repeat(64);
  const head = { number: '0x100', hash: blockHash, timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
  let drift = false;
  const c = { rpc: async (method, params) => {
    if (method === 'eth_getBlockByNumber') return { ...head, hash: drift && params[0] !== 'latest' ? '0x' + '6'.repeat(64) : head.hash };
    assert.equal(method, 'eth_call'); assert.equal(params[1], head.number);
    const decoded = decodeFunctionData({ abi, data: params[0].data }); queries.push(decoded);
    const result = decoded.functionName === 'saleStatus' ? { phase: 0, paused: true, freeMinted: 1n, freeSlotCount: 2n,
      freeDeadline: BigInt(head.timestamp) + 1000n, paidStartTime: 0n, endReason: 0, lastPaidMintBlock: 0n,
      freeMintQuota: 2n, freeConfigRevision: 2n } : decoded.functionName === 'freeMintRoot' ? root
      : decoded.functionName === 'defaultAdmin' ? DEPLOYER : decoded.functionName === 'paused' ? true : decoded.args[0] === 0n;
    return encodeFunctionResult({ abi, functionName: decoded.functionName, result });
  } };
  const policy = await readAdminPolicy(c, basePlan, [0, 1]);
  assert.deepEqual(policy.claimedSlotIds, ['0']); assert.equal(policy.root, root); assert.equal(policy.revision, '2');
  assert.deepEqual(queries.filter(call => call.functionName === 'isFreeSlotClaimed').map(call => call.args[0]), [0n, 1n]);
  drift = true; await assert.rejects(() => readAdminPolicy(c, basePlan, [1]));
});
