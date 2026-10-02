import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, getAddress, keccak256, stringToHex, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadPulseAdminArtifact } from './pulse-admin-candidate.mjs';
import { buildAllowlist } from './pulse-allowlist.mjs';
import { observeSepoliaMintReceipt, readSepoliaMintState, saleNotice, startSepoliaTestSite } from '../../scripts/pulse-sepolia-site.mjs';
import { inspectSepoliaAttempt, savedMintAuthorization, sepoliaAuthorizationDigest, sepoliaMintAbi } from '../../scripts/pulse-sepolia-attempt-recovery.mjs';
import { PULSE_ADMIN_PROFILE, pulseAdminMintDigest, pulseAdminMintTypedData } from '../../src/openMint/pulseAdminAuthorization.ts';
import { PULSE_PAID_SLOT, pulseMintDigest } from '../../src/openMint/pulseAuthorization.ts';
import { generativeInputDigest } from '../../src/openMint/generativeInputs.ts';
import { openMintHandleKey } from '../../src/openMint/authorization.ts';

const abi = loadPulseAdminArtifact().abi, hash = '0x' + 'ab'.repeat(32), collection = getAddress('0x' + '22'.repeat(20));
const authorizerKey = '0x' + '1'.padStart(64, '0'), authorizer = privateKeyToAccount(authorizerKey);
const wallet = privateKeyToAccount('0x' + '2'.padStart(64, '0')), otherWallet = privateKeyToAccount('0x' + '3'.padStart(64, '0'));
const quantity = value => '0x' + BigInt(value).toString(16);
const plan = { contractProfile: PULSE_ADMIN_PROFILE, digest: hash, collection: { address: collection },
  renderer: { identity: hash, runtimeCodeHash: hash, address: getAddress('0x' + '44'.repeat(20)) },
  authorities: { authorizer: authorizer.address }, sale: { freeDeadline: String(Math.floor(Date.now() / 1000) + 86400) },
  allowlist: buildAllowlist([otherWallet.address]) };
const binding = { contractProfile: PULSE_ADMIN_PROFILE, collection, authorizer: authorizer.address,
  renderer: plan.renderer, testOnly: true, deployment: { finalized: true, blockNumber: '1' } };

function fixture() {
  const list = buildAllowlist([wallet.address, wallet.address, otherWallet.address]);
  const controls = { list, artifact: list, paused: false, phase: 0, freeMinted: 0n, quota: 2n, revision: 1n,
    claimed: new Set(), nonceUsed: false, minted: false, timestamp: BigInt(Math.floor(Date.now() / 1000)) };
  const calls = [], head = () => ({ number: '0x100', hash, timestamp: quantity(controls.timestamp) });
  const source = label => async (method, params = []) => {
    calls.push({ label, method, params });
    if (method === 'eth_getBlockByNumber') return head();
    if (method === 'eth_getCode') return '0x';
    if (method === 'eth_getLogs') return [];
    if (method === 'eth_estimateGas') {
      const decoded = decodeFunctionData({ abi, data: params[0].data });
      assert.equal(decoded.args[2].freeConfigRevision, decoded.functionName === 'mintFree' ? controls.revision : 0n);
      return '0x20000';
    }
    assert.equal(method, 'eth_call', 'Tests never sign or broadcast chain transactions');
    assert.equal(params[0].to, collection); assert.equal(params[1], head().number);
    const decoded = decodeFunctionData({ abi, data: params[0].data });
    let result;
    switch (decoded.functionName) {
      case 'saleStatus': result = { phase: controls.phase, paused: controls.paused, freeMinted: controls.freeMinted,
        freeSlotCount: BigInt(controls.list.manifest.slotCount), freeDeadline: BigInt(plan.sale.freeDeadline),
        paidStartTime: controls.phase === 1 ? controls.timestamp : 0n, endReason: controls.phase === 1 ? 1 : 0,
        lastPaidMintBlock: 0n, freeMintQuota: controls.quota, freeConfigRevision: controls.revision }; break;
      case 'freeMintRoot': result = controls.list.manifest.root; break;
      case 'trustedAuthorizer': result = authorizer.address; break;
      case 'isFreeSlotClaimed': result = controls.claimed.has(String(decoded.args[0])); break;
      case 'getCurrentPrice': result = 1000n; break;
      case 'usedNonces': result = controls.nonceUsed; break;
      case 'mintedHandle': result = controls.minted; break;
      default: assert.fail('Unexpected read: ' + decoded.functionName);
    }
    return encodeFunctionResult({ abi, functionName: decoded.functionName, result });
  };
  const context = { rpc: source('primary'), second: source('secondary') };
  const options = { allowlistProvider: () => controls.artifact };
  return { controls, calls, context, options, head };
}

test('RC2 eligibility uses current verified artifacts, available slots, revision and quota, not the static deployment list', async () => {
  const f = fixture();
  const first = await readSepoliaMintState(f.context, binding, plan, { wallet: wallet.address, handle: 'alice' }, f.options);
  assert.equal(first.free, true); assert.equal(first.paid, false); assert.equal(first.slot, 0);
  assert.deepEqual(first.proof, f.controls.list.proofs[0].siblings);
  assert.equal(first.freeConfigRevision, '1'); assert.equal(first.allowlistReady, true);
  assert.match(first.saleNotice, /0\/2 slots used/);
  f.controls.claimed.add('0');
  assert.equal((await readSepoliaMintState(f.context, binding, plan, { wallet: wallet.address }, f.options)).slot, 1);
  f.controls.claimed.add('1');
  assert.equal((await readSepoliaMintState(f.context, binding, plan, { wallet: wallet.address }, f.options)).free, false);
  assert.equal(plan.allowlist.proofs[0].wallet, otherWallet.address);
});

test('missing, stale or invalid allowlist artifacts disable only free eligibility, never invent authority or block paid reads', async () => {
  const f = fixture(), good = f.controls.artifact;
  const badProof = structuredClone(good); badProof.proofs[0].siblings[0] = hash;
  const badCapacity = structuredClone(good); badCapacity.manifest.slotCount++;
  for (const artifact of [undefined, {}, plan.allowlist, badProof, badCapacity]) {
    f.controls.artifact = artifact;
    for (const phase of [0, 1]) {
      f.controls.phase = phase;
      const state = await readSepoliaMintState(f.context, binding, plan, { wallet: wallet.address }, f.options);
      assert.equal(state.allowlistReady, false); assert.equal(state.free, false); assert.equal(state.slot, undefined);
      assert.equal(state.paid, phase === 1); assert.equal(state.priceWei, phase === 1 ? '1000' : '0');
    }
  }
  assert.ok(!f.calls.some(call => /send|sign/i.test(call.method)));
});

test('legitimate paused free policy changes are reflected without any immutable integrity halt', async () => {
  const f = fixture(); f.controls.paused = true;
  assert.equal((await readSepoliaMintState(f.context, binding, plan, {}, f.options)).saleNotice, 'Minting is paused.');
  f.controls.list = buildAllowlist([otherWallet.address, wallet.address, wallet.address, wallet.address]);
  f.controls.artifact = f.controls.list; f.controls.quota = 3n; f.controls.revision = 2n;
  const paused = await readSepoliaMintState(f.context, binding, plan, { wallet: wallet.address }, f.options);
  assert.equal(paused.free, false); assert.equal(paused.freeConfigRevision, '2'); assert.equal(paused.slot, 1);
  f.controls.paused = false;
  const opened = await readSepoliaMintState(f.context, binding, plan, { wallet: wallet.address }, f.options);
  assert.equal(opened.free, true); assert.equal(opened.sale.freeMintQuota, 3n); assert.match(opened.saleNotice, /0\/3/);
  assert.equal(plan.allowlist.manifest.slotCount, 1);
  f.controls.quota = 0n; f.controls.phase = 1;
  assert.equal((await readSepoliaMintState(f.context, binding, plan, {}, f.options)).paid, true);
  assert.match(saleNotice({ phase: 1, freeMinted: 0n, freeSlotCount: 4n, freeMintQuota: 0n }), /0\/0/);
});

test('RC2 saved attempt and expiry proof retain the RC2 wire/domain and reject downgrade or invalid revision', async () => {
  for (const mode of ['free', 'paid']) {
    const f = fixture(), code = 'admin-attempt', deadline = f.controls.timestamp;
    const authorization = { handleKey: openMintHandleKey('alice'), assessmentDigest: hash,
      inputDigest: generativeInputDigest('Alice', 'INTJ', hash, 'sg-generative-pulse-inputs-v1-rc1'), recipient: wallet.address,
      nonce: keccak256(stringToHex(code)), issuedAt: deadline - 900n, deadline, mintMode: mode === 'free' ? 0 : 1,
      slotId: mode === 'free' ? 0n : PULSE_PAID_SLOT, maxPrice: mode === 'free' ? 0n : 1000n,
      freeConfigRevision: mode === 'free' ? 1n : 0n };
    const row = { code, wallet: wallet.address, mode, cap: String(authorization.maxPrice), stage: 'begun',
      deadline: Number(deadline), renderHandle: 'Alice', mbti: 'INTJ', transaction: { chainId: '0xaa36a7', from: wallet.address,
        to: collection, value: quantity(authorization.maxPrice), data: encodeFunctionData({ abi,
          functionName: mode === 'free' ? 'mintFree' : 'mintPaid', args: ['Alice', 'INTJ', authorization,
            '0x' + '01'.repeat(65), ...(mode === 'free' ? [f.controls.list.proofs[0].siblings] : [])] }) } };
    assert.deepEqual(savedMintAuthorization(binding, row), authorization);
    assert.equal(sepoliaAuthorizationDigest(binding, authorization), pulseAdminMintDigest({ chainId: 11155111, verifyingContract: collection }, authorization));
    const { freeConfigRevision, ...legacy } = authorization;
    assert.notEqual(sepoliaAuthorizationDigest(binding, authorization), pulseMintDigest({ chainId: 11155111, verifyingContract: collection }, legacy));
    assert.throws(() => savedMintAuthorization({ ...binding, contractProfile: 'generative-pulse-v1-rc1' }, row));
    const result = await inspectSepoliaAttempt(f.context, binding, row);
    assert.equal(result.state, 'retry-allowed'); assert.equal(result.proof.nonce, authorization.nonce);
  }
  assert.throws(() => sepoliaMintAbi({ ...binding, contractProfile: 'invented-profile' }));
});

test('RC2 lost-report discovery and strict receipt reveal use the revision-bound digest, never an RC1 commitment', async () => {
  for (const mode of ['free', 'paid']) {
    const f = fixture(), code = 'lost-admin-report', deadline = f.controls.timestamp;
    const authorization = { handleKey: openMintHandleKey('alice'), assessmentDigest: hash,
      inputDigest: generativeInputDigest('Alice', 'INTJ', hash, 'sg-generative-pulse-inputs-v1-rc1'), recipient: wallet.address,
      nonce: keccak256(stringToHex(code)), issuedAt: deadline - 900n, deadline, mintMode: mode === 'free' ? 0 : 1,
      slotId: mode === 'free' ? 0n : PULSE_PAID_SLOT, maxPrice: mode === 'free' ? 0n : 1000n,
      freeConfigRevision: mode === 'free' ? 2n : 0n };
    const row = { code, wallet: wallet.address, mode, cap: String(authorization.maxPrice), stage: 'begun',
      deadline: Number(deadline), renderHandle: 'Alice', mbti: 'INTJ', transaction: { chainId: '0xaa36a7', from: wallet.address,
        to: collection, value: quantity(authorization.maxPrice), data: encodeFunctionData({ abi,
          functionName: mode === 'free' ? 'mintFree' : 'mintPaid', args: ['Alice', 'INTJ', authorization,
            '0x' + '01'.repeat(65), ...(mode === 'free' ? [f.controls.list.proofs[0].siblings] : [])] }) } };
    let digest = pulseAdminMintDigest({ chainId: 11155111, verifyingContract: collection }, authorization);
    const args = { ...authorization, renderHandle: 'Alice', mbti: 'INTJ', tokenId: BigInt(authorization.handleKey) };
    const event = (name, values, index) => {
      const entry = abi.find(item => item.type === 'event' && item.name === name);
      return { address: collection, topics: encodeEventTopics({ abi, eventName: name, args: values }),
        data: encodeAbiParameters(entry.inputs.filter(input => !input.indexed), entry.inputs.filter(input => !input.indexed).map(input => values[input.name])),
        removed: false, blockNumber: '0xf0', blockHash: hash, transactionHash: hash, transactionIndex: '0x0', logIndex: quantity(index) };
    };
    const logs = () => [event('Transfer', { from: '0x' + '00'.repeat(20), to: wallet.address, tokenId: args.tokenId }, 0),
      event('GenerativeSignatureMinted', { ...args, authorizationDigest: digest }, 1)];
    const rpc = async (method, params = []) => {
      if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'latest' || params[0] === 'finalized' ? 256n : BigInt(params[0]);
        return { number: quantity(number), hash, timestamp: quantity(number === 256n ? deadline : authorization.issuedAt + number) };
      }
      if (method === 'eth_getLogs') return [logs()[1]];
      if (method === 'eth_getTransactionByHash') return { hash, from: wallet.address, to: collection, input: row.transaction.data,
        value: row.transaction.value, chainId: row.transaction.chainId, blockHash: hash, blockNumber: '0xf0', transactionIndex: '0x0' };
      if (method === 'eth_getTransactionReceipt') return { type: '0x2', status: '0x1', transactionHash: hash, transactionIndex: '0x0',
        blockHash: hash, blockNumber: '0xf0', from: wallet.address, to: collection, contractAddress: null,
        cumulativeGasUsed: '0x20000', gasUsed: '0x20000', effectiveGasPrice: '0x1', logsBloom: '0x' + '00'.repeat(256), logs: logs() };
      assert.equal(method, 'eth_call');
      const decoded = decodeFunctionData({ abi, data: params[0].data });
      const result = decoded.functionName === 'inputs' ? ['Alice', 'INTJ']
        : decoded.functionName === 'svg' ? '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>'
        : decoded.functionName === 'trustedAuthorizer' ? authorizer.address : true;
      return encodeFunctionResult({ abi, functionName: decoded.functionName, result });
    };
    const context = { rpc, second: rpc };
    assert.equal((await inspectSepoliaAttempt(context, binding, row)).transactionHash, hash);
    const revealed = await observeSepoliaMintReceipt(context, binding, { handle: 'alice', wallet: wallet.address, transactionHash: hash, attempt: row });
    assert.equal(revealed.state, 'minted'); assert.match(revealed.svg, /^<svg/);
    const { freeConfigRevision, ...legacy } = authorization;
    digest = pulseMintDigest({ chainId: 11155111, verifyingContract: collection }, legacy);
    await assert.rejects(inspectSepoliaAttempt(context, binding, row));
    await assert.rejects(observeSepoliaMintReceipt(context, binding, { handle: 'alice', wallet: wallet.address, transactionHash: hash, attempt: row }));
    assert.equal(row.stage, 'begun'); assert.equal(row.transactionHash, undefined);
  }
});

const fetchLocal = (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, connection: 'close' } });
async function authenticate(origin) {
  const opened = await fetchLocal(origin + '/api/test/session'), cookie = opened.headers.get('set-cookie').split(';')[0];
  const { csrf } = await opened.json();
  const post = async (action, body) => {
    const response = await fetchLocal(origin + '/api/test/' + action, { method: 'POST', headers: {
      cookie, origin, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const challenge = await post('challenge', { address: wallet.address }); assert.equal(challenge.status, 200);
  assert.equal((await post('verify', { challengeId: challenge.body.challengeId,
    signature: await wallet.signMessage({ message: challenge.body.message }) })).status, 200);
  const get = async action => { const response = await fetchLocal(origin + '/api/test/' + action, { headers: { cookie } });
    return { status: response.status, body: await response.json() }; };
  return { post, get, cookie };
}
async function httpFixture(t) {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'sg-admin-site-'));
  writeFileSync(join(directory, 'authorizer.key'), authorizerKey, { mode: 0o600 });
  const site = await startSepoliaTestSite(32023, { plan, journal: {}, directory, ui: false, intervalMs: 30000,
    context: f.context, validateSource: async () => {}, verifyDeployment: async () => binding,
    allowlistProvider: f.options.allowlistProvider,
    observe: async () => ({ at: Date.now(), head: f.head(), finalized: f.head(), finalNumber: 256n,
      mints: new Map(), expectedMintCount: 0, sale: { phase: f.controls.phase } }) });
  t.after(async () => { await site.close(); rmSync(directory, { recursive: true, force: true }); });
  const until = Date.now() + 2500;
  while (!site.health().mintReady && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(site.health().mintReady, true);
  return { ...f, site, directory, origin: 'http://127.0.0.1:32023', records: () => JSON.parse(readFileSync(join(directory, 'web-records.json'), 'utf8')) };
}

test('authenticated RC2 free prepare signs current revision/proof and begin refuses a changed policy', async t => {
  const f = await httpFixture(t), { post } = await authenticate(f.origin);
  f.controls.list = buildAllowlist([otherWallet.address, wallet.address, wallet.address, wallet.address]);
  f.controls.artifact = f.controls.list; f.controls.revision = 2n; f.controls.quota = 3n;
  const prepared = await post('prepare', { handle: 'Alice', mode: 'free', maximumETH: '0' });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const decoded = decodeFunctionData({ abi, data: prepared.body.transaction.data });
  assert.equal(decoded.functionName, 'mintFree'); assert.equal(decoded.args[2].freeConfigRevision, 2n);
  assert.equal(decoded.args[2].slotId, 1n); assert.deepEqual(decoded.args[4], f.controls.list.proofs[1].siblings);
  assert.equal(await verifyTypedData({ ...pulseAdminMintTypedData({ chainId: 11155111, verifyingContract: collection }, decoded.args[2]),
    address: authorizer.address, signature: decoded.args[3] }), true);
  f.controls.revision = 3n;
  const blocked = await post('begin', { code: prepared.body.code });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'QUOTE_CHANGED');
  assert.equal(f.records().requests.alice.stage, 'prepared'); assert.equal(f.site.health().safetyHalted, false);
  const staleReuse = await post('prepare', { handle: 'Alice', mode: 'free', maximumETH: '0' });
  assert.equal(staleReuse.status, 409); assert.equal(staleReuse.body.code, 'QUOTE_CHANGED');
  assert.ok(!f.calls.some(call => /send|sign/i.test(call.method)));
});

test('paid RC2 preparation uses revision zero even when reviewed free artifacts are missing', async t => {
  const f = await httpFixture(t), { post, get } = await authenticate(f.origin);
  f.controls.artifact = undefined; f.controls.phase = 1;
  const options = await get('options'); assert.equal(options.status, 200);
  assert.equal(options.body.free, false); assert.equal(options.body.paid, true);
  const prepared = await post('prepare', { handle: 'Bob', mode: 'paid', maximumETH: '0.0001' });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const decoded = decodeFunctionData({ abi, data: prepared.body.transaction.data });
  assert.equal(decoded.functionName, 'mintPaid'); assert.equal(decoded.args[2].freeConfigRevision, 0n);
  assert.equal(decoded.args[2].slotId, PULSE_PAID_SLOT); assert.equal(BigInt(prepared.body.transaction.value), 100000000000000n);
  assert.equal((await post('begin', { code: prepared.body.code })).status, 200);
});

test('invalid current artifacts cannot authorize free preparation or halt the rest of the site', async t => {
  const f = await httpFixture(t), { post, get } = await authenticate(f.origin);
  f.controls.artifact = structuredClone(f.controls.list);
  f.controls.artifact.proofs[0].siblings[0] = hash;
  const options = await get('options');
  assert.equal(options.status, 200); assert.equal(options.body.free, false);
  const preparation = await post('prepare', { handle: 'Alice', mode: 'free', maximumETH: '0' });
  assert.equal(preparation.status, 409); assert.equal(preparation.body.code, 'QUOTE_CHANGED');
  assert.deepEqual(f.records().requests, {});
  assert.equal(f.calls.some(call => call.method === 'eth_estimateGas'), false);
  assert.equal(f.site.health().safetyHalted, false);
  assert.equal((await fetchLocal(f.origin + '/')).status, 200);
  assert.equal((await fetchLocal(f.origin + '/health/live')).status, 200);
});
