import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadPulseAdminArtifact } from './pulse-admin-candidate.mjs';
import { buildAllowlist } from './pulse-allowlist.mjs';
import { sepoliaAdminTestPlan } from './pulse-sepolia-admin-plan.mjs';
import { DEPLOYER, INPUT_PROFILE, SEPOLIA } from './pulse-sepolia-plan.mjs';
import { adminWebCheckArguments, adminWebHttpClient, assertCurrentFreeConfiguration,
  assertPreparedAdminFreeMint, simulatePreparedAdminFreeMint, waitForAdminWebReady,
  ADMIN_WEB_ORIGIN } from '../../scripts/pulse-sepolia-admin-web-check.mjs';
import { createSepoliaReadFailover, unavailableRpcData } from '../../scripts/pulse-sepolia-rpc.mjs';
import { fixtureMbti } from '../../scripts/pulse-sepolia-site.mjs';
import { pulseAdminMintTypedData } from '../../src/openMint/pulseAdminAuthorization.ts';
import { pulseMintTypedData } from '../../src/openMint/pulseAuthorization.ts';
import { canonicalHandle } from '../../src/openMint/identity.ts';
import { openMintHandleKey } from '../../src/openMint/authorization.ts';
import { generativeInputDigest } from '../../src/openMint/generativeInputs.ts';

// Fixed unfunded keys are test fixtures only; no real keystore/provider/HTTP.
const authorizer = privateKeyToAccount('0x' + '2'.padStart(64, '0'));
const other = privateKeyToAccount('0x' + '3'.padStart(64, '0'));
const abi = loadPulseAdminArtifact().abi, qty = n => '0x' + BigInt(n).toString(16);

async function fixture() {
  const now = Math.floor(Date.now() / 1000), handle = 'RC2WebTest01';
  const p = sepoliaAdminTestPlan({ deployer: DEPLOYER, authorizer: authorizer.address, nonce: 90, createdAt: now });
  const list = buildAllowlist([DEPLOYER, other.address]);
  const policy = { phase: 0, paused: false, freeMinted: '0', quota: '2', slotCount: '2', revision: '2',
    root: list.manifest.root, freeDeadline: p.sale.freeDeadline, timestamp: String(now) };
  const config = { schema: 'sg-pulse-free-configuration/v1', planDigest: p.digest, contract: p.collection.address,
    root: policy.root, slotCount: policy.slotCount, quota: policy.quota, revision: policy.revision, allowlist: list };
  const code = 'rc2_free_web_only', mbti = fixtureMbti(handle);
  const a = { handleKey: openMintHandleKey(canonicalHandle(handle)),
    assessmentDigest: keccak256(stringToHex('SEPOLIA FIXTURE NOT GROK:' + p.digest + ':' + canonicalHandle(handle))),
    inputDigest: generativeInputDigest(handle, mbti, p.renderer.identity, INPUT_PROFILE), recipient: DEPLOYER,
    nonce: keccak256(stringToHex(code)), issuedAt: BigInt(now), deadline: BigInt(now + 900),
    mintMode: 0, slotId: 0n, maxPrice: 0n, freeConfigRevision: 2n };
  const signature = await authorizer.signTypedData(pulseAdminMintTypedData({ chainId: SEPOLIA, verifyingContract: p.collection.address }, a));
  const encode = (authorization = a, sig = signature, siblings = list.proofs[0].siblings) => encodeFunctionData({ abi,
    functionName: 'mintFree', args: [handle, mbti, authorization, sig, siblings] });
  const prepared = { code, handle: canonicalHandle(handle), transaction: { from: DEPLOYER, to: p.collection.address,
    chainId: '0xaa36a7', data: encode(), value: '0x0', gas: '0x100000' } };
  return { p, policy, config, handle, wallet: DEPLOYER, prepared, abi, a, encode, signature };
}

test('RC2 web CLI is explicitly prepare-only and preserves render spelling', () => {
  assert.equal(adminWebCheckArguments(['--prepare-only', '@RC2WebTest01']), 'RC2WebTest01');
  for (const args of [[], ['--mint', 'alice'], ['--prepare-only', 'alice', '--send'], ['--prepare-only', '../alice']])
    assert.throws(() => adminWebCheckArguments(args));
});

test('HTTP helper refuses submission/recovery/other origins before any request', async () => {
  const requests = [];
  const http = adminWebHttpClient({ request: async (url, options) => {
    requests.push({ url, options }); return new Response('{"csrf":"test_csrf"}', { headers: { 'set-cookie': 'sg_session=opaque; HttpOnly' } });
  } });
  for (const path of ['/api/test/begin', '/api/test/report', '/api/test/recover', 'https://example.com/api/test/prepare']) {
    await assert.rejects(http.api(path, {})); await assert.rejects(http.api(path));
  }
  assert.equal(requests.length, 0);
  http.setCsrf('test_csrf'); await http.api('/api/test/session'); await http.api('/api/test/prepare', { handle: 'alice', mode: 'free', maximumETH: '0' });
  assert.equal(requests[0].url, ADMIN_WEB_ORIGIN + '/api/test/session');
  assert.equal(requests[1].options.headers.Cookie, 'sg_session=opaque');
  assert.equal(requests[1].options.headers.Origin, ADMIN_WEB_ORIGIN);
  assert.equal(requests[1].options.headers['X-CSRF-Token'], 'test_csrf'); assert.equal(requests[1].options.redirect, 'error');
});

const readinessPlan = { contractProfile: 'generative-pulse-v1-rc2', collection: { address: DEPLOYER } };
const readiness = mintReady => ({ chainId: SEPOLIA, testOnly: true, frontendOnly: false,
  collection: DEPLOYER, mintReady, safetyHalted: false });

test('read-only readiness wakes demand and handles an expired 503 lease becoming ready', async () => {
  let clock = 0, rounds = 0; const calls = [], waits = [];
  const api = async (path, body, csrf, { signal }) => {
    calls.push(path); assert.equal(body, undefined); assert.equal(csrf, undefined); assert.ok(signal instanceof AbortSignal);
    if (path === '/api/test/capabilities') return { status: 200, value: readiness(rounds > 0) };
    assert.equal(path, '/health/ready'); return { status: ++rounds === 1 ? 503 : 200, value: readiness(rounds > 1) };
  };
  const result = await waitForAdminWebReady(api, readinessPlan, {
    now: () => clock, wait: async milliseconds => { waits.push(milliseconds); clock += milliseconds; },
  });
  assert.equal(result.mintReady, true); assert.deepEqual(waits, [5000]);
  assert.deepEqual(calls, ['/api/test/capabilities', '/health/ready', '/api/test/capabilities', '/health/ready']);
});

test('persistent readiness 503 has one bounded read-only deadline and no retry of signing/preparation', async () => {
  let clock = 0; const calls = [], waits = [];
  const api = async path => { calls.push(path); return { status: path === '/health/ready' ? 503 : 200, value: readiness(false) }; };
  await assert.rejects(waitForAdminWebReady(api, readinessPlan, { timeoutMs: 10000, now: () => clock,
    wait: async milliseconds => { waits.push(milliseconds); clock += milliseconds; } }), /readiness deadline/i);
  assert.equal(clock, 10000); assert.deepEqual(waits, [5000, 5000]);
  assert.deepEqual(calls, ['/api/test/capabilities', '/health/ready', '/api/test/capabilities', '/health/ready']);
  await assert.rejects(waitForAdminWebReady(api, readinessPlan, { timeoutMs: 90001 }));
});

test('readiness never retries integrity halt, profile/chain/collection mismatch or unexpected HTTP status', async () => {
  for (const response of [
    { status: 200, value: { ...readiness(true), safetyHalted: true } },
    { status: 200, value: { ...readiness(true), contractProfile: 'generative-pulse-v1-rc1' } },
    { status: 200, value: { ...readiness(true), chainId: 1 } },
    { status: 200, value: { ...readiness(true), collection: other.address } },
    { status: 500, value: readiness(false) },
  ]) {
    const calls = []; let waits = 0;
    await assert.rejects(waitForAdminWebReady(async path => { calls.push(path); return response; }, readinessPlan,
      { wait: async () => { waits++; } }));
    assert.deepEqual(calls, ['/api/test/capabilities']); assert.equal(waits, 0);
  }
});

test('RC2 prepared free authorization validates current revision, Merkle slot and independent signature', async () => {
  const f = await fixture(), value = await assertPreparedAdminFreeMint(f);
  assert.equal(value.tokenId, String(BigInt(f.a.handleKey))); assert.equal(value.slot, '0');
  assert.notEqual(f.config.root, f.p.sale.freeMintRoot, 'Current replacement allowlist differs from initial constructor list');
});

test('RC2 web check rejects wire substitution, stale proof/revision, paid value and injected wallet nonce', async () => {
  const f = await fixture();
  for (const mutate of [
    value => { value.transaction.value = '0x1'; },
    value => { value.transaction.nonce = '0x1'; },
    value => { value.transaction.chainId = '0x1'; },
    value => { value.transaction.to = other.address; },
    value => { value.transaction.from = other.address; },
    value => { value.code = 'changed_nonce'; },
    value => { value.transaction.data = f.encode({ ...f.a, freeConfigRevision: 1n }); },
    value => { value.transaction.data = f.encode({ ...f.a, recipient: other.address }); },
    value => { value.transaction.data = f.encode(f.a, f.signature, []); },
  ]) {
    const prepared = structuredClone(f.prepared); mutate(prepared);
    await assert.rejects(assertPreparedAdminFreeMint({ ...f, prepared }));
  }
  for (const mutate of [
    value => { value.revision = '1'; }, value => { value.root = f.p.sale.freeMintRoot; },
    value => { value.quota = '1'; }, value => { value.contract = other.address; },
  ]) {
    const config = structuredClone(f.config); mutate(config);
    assert.throws(() => assertCurrentFreeConfiguration(f.p, f.policy, config));
  }
});

test('RC1 signing domain and untrusted authorizer never pass RC2 acceptance', async () => {
  const f = await fixture(), { freeConfigRevision: _revision, ...rc1 } = f.a;
  const signatures = [
    await authorizer.signTypedData(pulseMintTypedData({ chainId: SEPOLIA, verifyingContract: f.p.collection.address }, rc1)),
    await other.signTypedData(pulseAdminMintTypedData({ chainId: SEPOLIA, verifyingContract: f.p.collection.address }, f.a)),
  ];
  for (const signature of signatures) {
    const prepared = structuredClone(f.prepared); prepared.transaction.data = f.encode(f.a, signature);
    await assert.rejects(assertPreparedAdminFreeMint({ ...f, prepared }));
  }
});

function mockReads(f, { failPrimary = false, mutateOnCall = false, wrongToken = false, reorg = false } = {}) {
  const calls = [], validations = []; let simulated = false;
  const head = { number: '0x100', hash: '0x' + 'ab'.repeat(32), timestamp: qty(f.policy.timestamp) };
  const source = label => async (method, params = []) => {
    calls.push({ label, method, params });
    if (label === 'primary' && failPrimary) throw unavailableRpcData();
    if (label === 'secondary' && !failPrimary) assert.fail('A healthy primary cannot depend on secondary agreement');
    if (method === 'eth_getBlockByNumber') return { ...head, ...(reorg && simulated ? { hash: '0x' + 'cd'.repeat(32) } : {}) };
    assert.equal(method, 'eth_call', 'No signing or transaction delivery RPC is permitted');
    assert.equal(params[1], head.number); assert.equal(params[0].to, f.p.collection.address);
    const decoded = decodeFunctionData({ abi, data: params[0].data }); let result;
    switch (decoded.functionName) {
      case 'saleStatus': result = { phase: 0, paused: false, freeMinted: 0n, freeSlotCount: 2n,
        freeDeadline: BigInt(f.policy.freeDeadline), paidStartTime: 0n, endReason: 0, lastPaidMintBlock: 0n,
        freeMintQuota: 2n, freeConfigRevision: 2n }; break;
      case 'freeMintRoot': result = f.policy.root; break;
      case 'isFreeSlotClaimed': case 'usedNonces': case 'revokedNonces': result = false; break;
      case 'mintedHandle': result = mutateOnCall && simulated; break;
      case 'mintFree': simulated = true; result = wrongToken ? 1n : BigInt(f.a.handleKey); break;
      default: assert.fail('Unexpected RPC getter');
    }
    return encodeFunctionResult({ abi, functionName: decoded.functionName, result });
  };
  const c = createSepoliaReadFailover({ rpc: source('primary'), second: source('secondary') }, async source => { validations.push(source.readSource); });
  return { c, calls, validations };
}

test('free simulation uses only one validated primary and proves mint/slot/nonce state unchanged', async () => {
  const f = await fixture(), reads = mockReads(f);
  const result = await simulatePreparedAdminFreeMint(reads.c, f.p, f.config, { renderHandle: f.handle, value: f.prepared }, abi);
  assert.equal(result.readSource, 'primary'); assert.equal(result.chainStateUnchanged, true);
  assert.equal(result.freeConfigRevision, '2'); assert.equal(result.tokenId, String(BigInt(f.a.handleKey)));
  assert.deepEqual(reads.validations, ['primary']); assert.ok(reads.calls.every(call => call.label === 'primary'));
  assert.equal(reads.calls.filter(call => call.method === 'eth_call' && decodeFunctionData({ abi, data: call.params[0].data }).functionName === 'mintFree').length, 1);
});

test('transport fallback restarts the complete simulation at one validated secondary', async () => {
  const f = await fixture(), reads = mockReads(f, { failPrimary: true });
  const result = await simulatePreparedAdminFreeMint(reads.c, f.p, f.config, { renderHandle: f.handle, value: f.prepared }, abi);
  assert.equal(result.readSource, 'secondary'); assert.deepEqual(reads.validations, ['primary', 'secondary']);
  assert.equal(reads.calls.filter(call => call.label === 'primary').length, 1);
});

test('simulation rejects token mismatch, state consumption and canonical block change without shopping for a provider', async () => {
  const f = await fixture();
  for (const options of [{ wrongToken: true }, { mutateOnCall: true }, { reorg: true }]) {
    const reads = mockReads(f, options);
    await assert.rejects(simulatePreparedAdminFreeMint(reads.c, f.p, f.config, { renderHandle: f.handle, value: f.prepared }, abi));
    assert.deepEqual(reads.validations, ['primary']); assert.ok(reads.calls.every(call => call.label === 'primary'));
  }
});
