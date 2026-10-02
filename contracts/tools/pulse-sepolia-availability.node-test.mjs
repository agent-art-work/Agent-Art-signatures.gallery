import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSepoliaTestSite, submissionTrackingStatus } from '../../scripts/pulse-sepolia-site.mjs';
import { privateKeyToAccount } from 'viem/accounts';
import { createSepoliaGalleryCache } from '../../scripts/pulse-sepolia-cache.mjs';
import { createSepoliaUiRenderer } from '../../scripts/pulse-sepolia-ui.mjs';
import { openMintHandleKey } from '../../src/openMint/authorization.ts';
import { generativeInputDigest } from '../../src/openMint/generativeInputs.ts';
import { INPUT_PROFILE } from './pulse-sepolia-plan.mjs';
import { DIR } from '../../scripts/pulse-sepolia.mjs';

const hash = '0x' + 'ab'.repeat(32), address = '0x' + '11'.repeat(20);
const plan = { digest: hash, collection: { address }, renderer: { identity: hash, runtimeCodeHash: hash },
  authorities: { authorizer: address }, allowlist: { proofs: [] } };
const head = { number: '0x100', hash, timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
const mint = { handle: 'alice', renderHandle: 'Alice', mbti: 'INTJ', tokenId: String(BigInt(openMintHandleKey('alice'))),
  transactionHash: hash, block: '0xf0', blockHash: hash, inputDigest: generativeInputDigest('Alice', 'INTJ', hash, INPUT_PROFILE),
  assessmentDigest: hash, wallet: address, state: 'minted' };
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>';
const transient = () => Object.assign(Error('secret RPC details'), { retryableRead: true, httpStatus: 503 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Reusing a port across cold restarts must not reuse a closing test socket.
const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, headers: { ...options.headers, connection: 'close' } });
async function until(predicate) { const deadline = Date.now() + 2500; while (!predicate() && Date.now() < deadline) await pause(5); assert.ok(predicate()); }
const testWallet = privateKeyToAccount('0x' + '1'.padStart(64, '0'));
async function signIn(origin) {
  const opened = await fetch(origin + '/api/test/session'), cookie = opened.headers.get('set-cookie').split(';')[0];
  const { csrf } = await opened.json();
  const post = async (path, body) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { cookie, origin,
      'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  const challenge = await post('/api/test/challenge', { address: testWallet.address });
  await post('/api/test/verify', { challengeId: challenge.challengeId,
    signature: await testWallet.signMessage({ message: challenge.message }) });
  return { cookie, post };
}
const rpcWarning = /data-mint-observation-warning|Gallery updates could not be checked|Live network checks are temporarily unavailable|Mint status cannot be verified right now|Ownership updates could not be checked|Ownership history needs to be checked|Previously verified mints need to be checked|Mint availability cannot be checked/;
async function assertQuietViewers(origin) {
  for (const path of ['/', '/INTJ/', '/signatures/alice', '/p/Alice/ISTJ', '/p/Alice/variations', '/me', '/about']) {
    const response = await fetch(origin + path); assert.equal(response.status, 200, path);
    assert.doesNotMatch(await response.text(), rpcWarning, path);
  }
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sg-availability-'));
  const sites = []; t.after(async () => { for (const site of sites) await site.close(); rmSync(directory, { recursive: true, force: true }); });
  const cache = createSepoliaGalleryCache(plan, directory), value = { at: Date.now(), head, finalized: head,
    mints: new Map([['alice', mint]]), sale: { phase: 1 }, expectedMintCount: 1 };
  cache.save(value, null, new Map([[hash + ':' + hash, svg]]));
  return { directory, cache, value, sites, dependencies: { plan, journal: {}, directory, cache, intervalMs: 5, ui: false,
    saveRecords: () => writeFileSync(join(directory, 'web-records.json'), JSON.stringify({ planDigest: plan.digest, requests: {} }), { mode: 0o600 }),
    context: { rpc: async () => { throw transient(); }, second: async () => { throw transient(); } }, validateSource: async () => {},
    verifyDeployment: async () => ({ testOnly: true, collection: address, authorizer: address, renderer: plan.renderer,
      deployment: { finalized: true, blockNumber: '1' } }),
    observe: async () => value,
    readMintState: async () => ({ at: Date.now(), head, sale: { phase: 1, endReason: 1, freeMinted: 2n, freeSlotCount: 2n } }),
  } };
}

test('cold startup serves historical gallery/images immediately; liveness and mint readiness are different', async t => {
  const f = fixture(t); let working = false, attempts = 0;
  f.dependencies.verifyDeployment = async () => { attempts++; if (!working) throw transient(); return { testOnly: true,
    collection: address, authorizer: address, renderer: plan.renderer, deployment: { finalized: true, blockNumber: '1' } }; };
  const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site);
  const origin = 'http://127.0.0.1:32005';
  assert.equal((await fetch(origin + '/health/live')).status, 200);
  assert.equal((await fetch(origin + '/health/ready')).status, 503);
  const html = await (await fetch(origin + '/')).text(); assert.match(html, /@Alice/);
  assert.doesNotMatch(html, rpcWarning);
  assert.equal(site.health().galleryState, 'unavailable'); assert.equal(Object.hasOwn(site.health(), 'galleryWarningDeferred'), false);
  assert.equal((await fetch(origin + '/test-art/alice.svg')).status, 200);
  assert.equal((await fetch(origin + '/signatures/alice')).status, 200);
  assert.equal((await fetch(origin + '/mint')).status, 200);
  assert.equal((await fetch(origin + '/p/Alice/variations')).status, 200);
  assert.equal((await fetch(origin + '/api/test/session')).status, 200);
  await assertQuietViewers(origin);
  assert.match(await (await fetch(origin + '/mint')).text(), /Mint availability cannot be checked right now/);
  const unavailable = await (await fetch(origin + '/api/test/capabilities')).json();
  assert.equal(unavailable.notice, undefined); assert.match(unavailable.mintNotice, /Mint availability/);
  working = true; await until(() => site.health().mintReady && site.health().observerHealthy);
  assert.ok(attempts >= 2); assert.equal((await fetch(origin + '/health/ready')).status, 200);
  assert.doesNotMatch(await (await fetch(origin + '/health')).text(), /secret RPC details/);
  assert.equal((await fetch(origin + '/api/test/capabilities')).status, 200);
});
test('a disposable site uses its own default request writer and never overwrites the active runtime', async t => {
  const f = fixture(t), activePath = join(DIR, 'web-records.json');
  const original = existsSync(activePath) ? readFileSync(activePath) : undefined;
  delete f.dependencies.saveRecords;
  const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site);
  const saved = JSON.parse(readFileSync(join(f.directory, 'web-records.json'), 'utf8'));
  assert.equal(saved.planDigest, plan.digest); assert.deepEqual(saved.requests, {});
  assert.deepEqual(existsSync(activePath) ? readFileSync(activePath) : undefined, original);
});

test('initial refresh with cached works is quiet, while an unknown gallery is loading rather than empty', async t => {
  const f = fixture(t), verify = f.dependencies.verifyDeployment;
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.dependencies.verifyDeployment = async () => { await gate; return verify(); };
  const first = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(first);
  const origin = 'http://127.0.0.1:32005';
  const html = await (await fetch(origin + '/')).text();
  assert.match(html, /@Alice/); assert.doesNotMatch(html, rpcWarning);
  assert.doesNotMatch(html, /Live network checks are temporarily unavailable/);
  release(); await until(() => first.health().observerHealthy); await first.close();
  const empty = join(f.directory, 'empty'); mkdirSync(empty);
  f.dependencies.cache = createSepoliaGalleryCache(plan, empty);
  const gate2 = new Promise(resolve => { release = resolve; });
  f.dependencies.verifyDeployment = async () => { await gate2; return verify(); };
  const second = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(second);
  const unknown = await (await fetch(origin + '/')).text();
  assert.match(unknown, /Checking for minted signatures/); assert.doesNotMatch(unknown, /No signatures minted yet/);
  assert.doesNotMatch(unknown, rpcWarning);
  release();
});

test('a healthy empty gallery and a paused mint are not network outages', async t => {
  const f = fixture(t);
  f.value.mints.clear(); f.value.expectedMintCount = 0;
  f.dependencies.readMintState = async () => ({ at: Date.now(), head, sale: { paused: true, phase: 1 } });
  const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site);
  await until(() => site.health().observerHealthy);
  assert.equal(site.health().galleryAvailable, true); assert.equal(site.health().mintState, 'paused');
  assert.equal(site.health().mintReady, false);
  const html = await (await fetch('http://127.0.0.1:32005/')).text();
  assert.match(html, /No signatures minted yet/);
  assert.doesNotMatch(html, rpcWarning);
});

test('a failed first load without verified data stays neutral rather than warning or claiming an empty gallery', async t => {
  const f = fixture(t), empty = join(f.directory, 'no-projection'); mkdirSync(empty);
  f.dependencies.cache = createSepoliaGalleryCache(plan, empty);
  f.dependencies.verifyDeployment = async () => { throw transient(); };
  const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site);
  await until(() => site.health().galleryState === 'unavailable');
  assert.equal(site.health().galleryAvailable, false); assert.equal(Object.hasOwn(site.health(), 'galleryWarningDeferred'), false);
  assert.equal(site.health().mintReady, false);
  const html = await (await fetch('http://127.0.0.1:32005/')).text();
  assert.match(html, /Checking for minted signatures/); assert.doesNotMatch(html, /No signatures minted yet/);
  assert.doesNotMatch(html, rpcWarning);
  assert.match(await (await fetch('http://127.0.0.1:32005/mint')).text(), /Mint availability cannot be checked right now/);
});

test('history outage does not block sale readiness; sale outage keeps verified artwork visible and recovers', async t => {
  const f = fixture(t); let failHistory = true, failSale = false;
  const headOnly = async method => method === 'eth_getBlockByNumber' ? head : Promise.reject(transient());
  f.dependencies.context = { rpc: headOnly, second: (...args) => headOnly(...args) };
  f.dependencies.observe = async () => { if (failHistory) throw transient(); return { ...f.value, at: Date.now() }; };
  const read = f.dependencies.readMintState;
  f.dependencies.readMintState = async (...args) => { if (failSale) throw transient(); return read(...args); };
  const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site); const origin = 'http://127.0.0.1:32005';
  await until(() => site.health().mintReady);
  assert.equal(site.health().observerHealthy, false); assert.equal((await fetch(origin + '/health/ready')).status, 200);
  assert.doesNotMatch(await (await fetch(origin + '/')).text(), rpcWarning);
  assert.equal(site.health().galleryState, 'unavailable'); assert.equal(Object.hasOwn(site.health(), 'galleryWarningDeferred'), false);
  assert.ok(Number.isSafeInteger(site.health().galleryFailureSince));
  failHistory = false; await site.refresh(); assert.equal(site.health().observerHealthy, true);
  assert.equal(site.health().galleryFailureSince, undefined);
  failSale = true; await site.refreshSale(); assert.equal(site.health().mintReady, true);
  assert.equal(site.health().saleReadState, 'retrying');
  assert.equal((await fetch(origin + '/health/ready')).status, 200);
  assert.equal((await fetch(origin + '/test-art/alice.svg')).status, 200);
  assert.equal((await fetch(origin + '/')).status, 200);
  await assertQuietViewers(origin);
  assert.doesNotMatch(await (await fetch(origin + '/mint')).text(), /Mint availability cannot be checked right now/);
  // Visitor polls retry after the demand-driven lane's outage cooldown.
  // These viewing requests may have advanced the backoff beyond its first
  // delay. Keep sending demand; health snapshots themselves do not wake it.
  failSale = false;
  for (let i = 0; i < 100 && site.health().saleReadState !== 'current'; i++) { await pause(25); await fetch(origin + '/api/test/capabilities'); }
  assert.equal(site.health().mintReady, true);
  assert.equal(site.health().saleReadState, 'current');
});

test('durable tracking distinguishes absence, preparation and ambiguous broadcast without guessing from expiry', () => {
  assert.deepEqual(submissionTrackingStatus(), { state: 'not-submitted', submissionStage: 'none' });
  assert.deepEqual(submissionTrackingStatus({ stage: 'prepared' }), { state: 'not-submitted', submissionStage: 'prepared' });
  assert.deepEqual(submissionTrackingStatus({ stage: 'begun', deadline: 1 }), { state: 'submission-unknown', submissionStage: 'begun' });
  assert.deepEqual(submissionTrackingStatus({ stage: 'reported', transactionHash: hash }),
    { state: 'pending', submissionStage: 'reported', transactionHash: hash });
  assert.throws(() => submissionTrackingStatus({ stage: 'reported' }));
  assert.throws(() => submissionTrackingStatus({ stage: 'invalid' }));
});

test('unreported submission status does not depend on gallery freshness and public absence cannot authorize recovery', async t => {
  const f = fixture(t), requests = { elonmusk: { stage: 'begun', wallet: testWallet.address, deadline: 1 },
    prepared: { stage: 'prepared', wallet: testWallet.address } };
  writeFileSync(join(f.directory, 'web-records.json'), JSON.stringify({ planDigest: plan.digest, requests }));
  f.dependencies.observe = async () => { throw transient(); };
  const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site);
  await until(() => site.health().mintReady); const origin = 'http://127.0.0.1:32005';
  for (const [handle, state, submissionStage] of [['elonmusk', 'submission-unknown', 'begun'],
    ['prepared', 'not-submitted', 'prepared'], ['absent', 'not-submitted', 'none']]) {
    const response = await fetch(origin + '/api/test/status?handle=' + handle);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { handle, state, submissionStage });
  }
  assert.equal(site.health().observerHealthy, false); assert.equal(site.health().mintReady, true);
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'web-records.json'))).requests, requests);
});

test('reported pending receipts use only transaction evidence despite a gallery outage', async t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'web-records.json'), JSON.stringify({ planDigest: plan.digest,
    requests: { bob: { stage: 'reported', wallet: testWallet.address, transactionHash: hash } } }));
  const receiptOnly = async method => { assert.equal(method, 'eth_getTransactionReceipt'); return null; };
  f.dependencies.context = { rpc: receiptOnly, second: (...args) => receiptOnly(...args) };
  f.dependencies.observe = async () => { throw transient(); };
  const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site); await until(() => site.health().mintReady);
  const response = await fetch('http://127.0.0.1:32005/api/test/status?handle=bob');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { handle: 'bob', state: 'pending', submissionStage: 'reported', transactionHash: hash });
});

test('transaction read failures use transaction status wording, not mint availability or gallery freshness', async t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'web-records.json'), JSON.stringify({ planDigest: plan.digest,
    requests: { bob: { stage: 'reported', wallet: testWallet.address, transactionHash: hash } } }));
  f.dependencies.observe = async () => { throw transient(); };
  const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site); await until(() => site.health().mintReady);
  const response = await fetch('http://127.0.0.1:32005/api/test/status?handle=bob');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'MINT_STATUS_UNAVAILABLE', error: 'Your transaction status could not be checked right now.' });
});

test('an authenticated wallet can resolve an unsubmitted marker, but not someone else\'s request or an ambiguous broadcast', async t => {
  const f = fixture(t), requests = { prepared: { stage: 'prepared', wallet: testWallet.address },
    other: { stage: 'prepared', wallet: address }, ambiguous: { stage: 'begun', wallet: testWallet.address } };
  writeFileSync(join(f.directory, 'web-records.json'), JSON.stringify({ planDigest: plan.digest, requests }));
  const support = async method => method === 'eth_getBlockByNumber' ? head : method === 'eth_getCode' ? '0x' : Promise.reject(transient());
  f.dependencies.context = { rpc: support, second: (...args) => support(...args) };
  const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site); await until(() => site.health().mintReady);
  const origin = 'http://127.0.0.1:32005', { cookie } = await signIn(origin);
  for (const handle of ['prepared', 'absent', 'other', 'ambiguous']) {
    const result = await (await fetch(origin + '/api/test/status?handle=' + handle, { headers: { cookie } })).json();
    assert.equal(result.recoveryWallet, ['prepared', 'absent'].includes(handle) ? testWallet.address : undefined);
    if (handle === 'ambiguous') assert.equal(result.state, 'submission-unknown');
  }
});

test('late background success or failure cannot overwrite a newer successful explicit sale read', async t => {
  for (const action of ['options', 'begin']) for (const outcome of ['failure', 'paused']) {
    const f = fixture(t), read = f.dependencies.readMintState; let calls = 0, release;
    if (action === 'begin') {
      delete f.dependencies.saveRecords;
      writeFileSync(join(f.directory, 'web-records.json'), JSON.stringify({ planDigest: plan.digest, requests: { bob: {
        code: 'race-test', wallet: testWallet.address, stage: 'prepared', renderHandle: 'Bob', mode: 'paid',
        cap: '100000000000000', deadline: Math.floor(Date.now() / 1000) + 900,
      } } }));
    }
    const delayed = new Promise(resolve => { release = resolve; }); t.after(release);
    f.dependencies.readMintState = async (...args) => {
      if (++calls === 2) { await delayed; if (outcome === 'failure') throw transient(); return { ...(await read(...args)), sale: { phase: 1, paused: true } }; }
      return { ...(await read(...args)), paid: true, priceWei: '1' };
    };
    const support = async method => method === 'eth_getBlockByNumber' ? head : method === 'eth_getCode' ? '0x' : Promise.reject(transient());
    f.dependencies.context = { rpc: support, second: (...args) => support(...args) };
    const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site); await until(() => site.health().mintReady);
    const origin = 'http://127.0.0.1:32005', { cookie, post } = await signIn(origin);
    const background = site.refreshSale(); await until(() => calls === 2);
    if (action === 'options') {
      const response = await fetch(origin + '/api/test/options', { headers: { cookie } }); assert.equal(response.status, 200);
    } else {
      assert.equal((await post('/api/test/begin', { code: 'race-test' })).saved, true);
      assert.equal(JSON.parse(readFileSync(join(f.directory, 'web-records.json'))).requests.bob.stage, 'begun');
    }
    const checkedAt = site.health().lastSaleCheckedAt;
    release(); await background;
    assert.equal(site.health().mintReady, true); assert.equal(site.health().saleReadState, 'current');
    assert.equal(site.health().lastSaleCheckedAt, checkedAt);
    await site.close();
  }
});

test('advisory transient grace never bypasses fresh prepare or begin checks', async t => {
  const f = fixture(t), row = { code: 'prepared-test', wallet: testWallet.address, stage: 'prepared',
    renderHandle: 'Bob', mode: 'paid', cap: '100000000000000', deadline: Math.floor(Date.now() / 1000) + 900 };
  writeFileSync(join(f.directory, 'web-records.json'), JSON.stringify({ planDigest: plan.digest, requests: { bob: row } }));
  let fail = false, calls = 0; const read = f.dependencies.readMintState;
  f.dependencies.readMintState = async (...args) => { calls++; if (fail) throw transient(); return read(...args); };
  const support = async method => method === 'eth_getBlockByNumber' ? head : method === 'eth_getCode' ? '0x' : Promise.reject(transient());
  f.dependencies.context = { rpc: support, second: (...args) => support(...args) };
  const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site); await until(() => site.health().mintReady);
  const origin = 'http://127.0.0.1:32005', { cookie } = await signIn(origin);
  const session = await (await fetch(origin + '/api/test/session', { headers: { cookie } })).json();
  fail = true; await site.refreshSale(); assert.equal(site.health().mintReady, true);
  for (const [path, body] of [['prepare', { handle: 'Bob', mode: 'paid', maximumETH: '0.0001' }], ['begin', { code: row.code }]]) {
    const before = calls;
    const response = await fetch(origin + '/api/test/' + path, { method: 'POST', headers: { cookie, origin,
      'content-type': 'application/json', 'x-csrf-token': session.csrf }, body: JSON.stringify(body) });
    assert.equal(response.status, 409); assert.ok(calls > before, 'The action must perform its own live read');
    assert.equal(JSON.parse(readFileSync(join(f.directory, 'web-records.json'))).requests.bob.stage, 'prepared');
  }
  assert.equal(existsSync(join(f.directory, 'authorizer.key')), false, 'No signing key is needed or loaded by failed preflight');
});

test('restart during RPC outage preserves known gallery bytes, without granting mint authority from disk', async t => {
  const f = fixture(t), first = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(first);
  await until(() => first.health().observerHealthy); await first.close();
  f.dependencies.cache = createSepoliaGalleryCache(plan, f.directory);
  f.dependencies.verifyDeployment = async () => { throw transient(); };
  const second = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(second); const origin = 'http://127.0.0.1:32005';
  assert.equal(second.health().mintReady, false);
  assert.equal(await (await fetch(origin + '/test-art/alice.svg')).text(), svg);
  assert.match(await (await fetch(origin + '/')).text(), /@Alice/);
  assert.equal((await fetch(origin + '/health/ready')).status, 503);
  await assertQuietViewers(origin);
  assert.match(await (await fetch(origin + '/mint')).text(), /Mint availability cannot be checked right now/);
});

test('a genuine integrity conflict is sticky, persists across restart and cannot be cleared by successful sale reads', async t => {
  const f = fixture(t); let conflicting = true;
  f.dependencies.observe = async () => { if (conflicting) throw Object.assign(Error('private conflict'), { code: 'MINT_EVIDENCE_CONFLICT' }); return f.value; };
  const first = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(first); await until(() => first.health().safetyHalted);
  conflicting = false; await first.refresh(); await first.refreshSale();
  assert.equal(first.health().mintReady, false); assert.equal(f.cache.presentation().invalidated, true); await first.close();
  f.dependencies.cache = createSepoliaGalleryCache(plan, f.directory);
  const second = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(second);
  assert.equal(second.health().safetyHalted, true); assert.equal(second.health().mintReady, false);
  assert.equal((await fetch('http://127.0.0.1:32005/health/ready')).status, 503);
  await assertQuietViewers('http://127.0.0.1:32005');
  const admission = await (await fetch('http://127.0.0.1:32005/mint')).text();
  assert.match(admission, /Previously verified mints need to be checked before minting can continue/);
  const capabilities = await (await fetch('http://127.0.0.1:32005/api/test/capabilities')).json();
  assert.equal(capabilities.notice, undefined); assert.match(capabilities.mintNotice, /before minting can continue/);
  assert.equal(await (await fetch('http://127.0.0.1:32005/test-art/alice.svg')).text(), svg);
});

test('an unknown sale exception does not invalidate verified works or persist a global safety halt', async t => {
  const f = fixture(t); let fail = true;
  const read = f.dependencies.readMintState;
  f.dependencies.readMintState = async (...args) => { if (fail) throw TypeError('private decoder details'); return read(...args); };
  const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site);
  await until(() => site.health().observerHealthy);
  assert.equal(site.health().safetyHalted, false); assert.equal(f.cache.state().safetyHalted, false);
  assert.equal(site.health().mintReady, false); assert.equal(site.health().mintState, 'unavailable');
  assert.equal(site.recovery().sale.phase, 'blocked');
  assert.equal(f.cache.presentation().invalidated, false);
  assert.doesNotMatch(await (await fetch('http://127.0.0.1:32005/health')).text(), /private decoder details/);
  assert.doesNotMatch(await (await fetch('http://127.0.0.1:32005/')).text(), rpcWarning);
  fail = false; await site.refreshSale(); assert.equal(site.health().mintReady, true);
});
test('a generic validation assertion blocks bootstrap without a permanent gallery conflict', async t => {
  const f = fixture(t);
  f.dependencies.validateSource = async () => { assert.equal('secret actual', 'secret expected'); };
  const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site);
  await until(() => site.recovery().bootstrap.phase === 'blocked');
  assert.equal(site.health().safetyHalted, false); assert.equal(site.health().mintReady, false);
  assert.equal(f.cache.presentation().invalidated, false);
  assert.equal(f.cache.state().lastReadFailure.code, 'ERR_ASSERTION');
});

test('UI-only renderer replacement retains backend wallet sessions, checkpoint and readiness', async t => {
  const ui = createSepoliaUiRenderer({ watchFiles: false }); t.after(ui.close);
  const f = fixture(t); f.dependencies.ui = ui;
  const site = await startSepoliaTestSite(32005, f.dependencies); f.sites.push(site); const origin = 'http://127.0.0.1:32005';
  await until(() => site.health().observerHealthy);
  const session = await fetch(origin + '/api/test/session'), cookie = session.headers.get('set-cookie').split(';')[0];
  const before = await session.json(), checkpoint = site.snapshot();
  const html = await (await fetch(origin + '/')).text(); assert.match(html, /Anyone_Can_Sign_Anyone/);
  const version = ui.revision(); await site.reloadUi(); assert.ok(ui.revision() > version);
  const after = await (await fetch(origin + '/api/test/session', { headers: { cookie } })).json();
  assert.equal(after.csrf, before.csrf); assert.equal(site.snapshot(), checkpoint); assert.equal(site.health().mintReady, true);
  assert.match(await (await fetch(origin + '/')).text(), /@Alice/);
  assert.doesNotMatch(readFileSync(new URL('../../scripts/pulse-sepolia-ui-worker.mjs', import.meta.url), 'utf8'), /readOnlyContext|privateKeyToAccount|signTypedData|eth_send/);
});
