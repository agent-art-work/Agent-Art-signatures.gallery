import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { PULSE_ADMIN_PROFILE } from '../../src/openMint/pulseAdminAuthorization.ts';
import { startSepoliaTestSite } from '../../scripts/pulse-sepolia-site.mjs';
import { startSepoliaFrontend } from '../../scripts/pulse-sepolia-fe.mjs';
import { SITE_LAUNCH_RECORD } from '../../scripts/pulse-site-launch.mjs';
import { MBTI_TYPES } from '../../src/openMint/identity.ts';

// Owned, unfunded public test keys and synthetic chain only. No live RPC,
// provider, secret environment file or public-chain write enters this suite.
const key = '0x' + '1'.padStart(64, '0'), wallet = privateKeyToAccount(key);
const hash = '0x' + 'ab'.repeat(32), address = '0x' + '11'.repeat(20), port = 32581;
const plan = { digest: hash, contractProfile: PULSE_ADMIN_PROFILE, collection: { address },
  renderer: { identity: hash, runtimeCodeHash: hash }, authorities: { authorizer: wallet.address, admin: wallet.address },
  allowlist: { proofs: [] } };
const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(5000),
  headers: { ...options.headers, connection: 'close' } });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const end = Date.now() + 3000; while (!predicate() && Date.now() < end) await wait(5); assert.ok(predicate()); }
function fixture(t, mode = 'prelaunch') {
  const directory = mkdtempSync(join(tmpdir(), 'sg-sepolia-launch-')), sites = [], calls = [];
  t.after(async () => { try { for (const site of sites) await site.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const head = { number: '0x100', hash, timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
  const sale = { phase: 0, paused: false, freeMinted: 0n, freeMintQuota: 10n, freeSlotCount: 10n,
    freeConfigRevision: 1n, freeDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600), lastPaidMintBlock: 0n };
  const snapshot = { at: Date.now(), head, finalized: head, mints: new Map(), expectedMintCount: 0 };
  const rpc = async (method, args) => {
    calls.push([method, args]);
    if (method === 'eth_getBlockByNumber') return head;
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getCode') return '0x';
    if (method === 'eth_getLogs') return [];
    if (method === 'eth_estimateGas') return '0x100000';
    throw Object.assign(Error('offline synthetic unsupported read'), { retryableRead: true });
  };
  const f = { directory, calls, sale, snapshot, sites, origin: `http://127.0.0.1:${port}` };
  f.dependencies = { plan, journal: {}, directory, siteLaunchMode: mode, intervalMs: 60000, ui: false,
    context: { rpc, second: (...args) => rpc(...args) }, validateSource: async () => {},
    verifyDeployment: async () => ({ testOnly: true, contractProfile: PULSE_ADMIN_PROFILE, collection: address,
      authorizer: wallet.address, renderer: plan.renderer, deployment: { finalized: true, blockNumber: '1' } }),
    observe: async () => ({ ...snapshot, at: Date.now() }),
    readMintState: async () => { calls.push(['mint-state']); return { at: Date.now(), head, sale: { ...sale },
      free: sale.phase === 0 && !sale.paused, paid: sale.phase === 1 && !sale.paused, allowlistReady: true,
      slot: 0n, proof: [], freeConfigRevision: 1n, saleNotice: 'Synthetic sale', priceWei: '1', priceETH: '0.000000000000000001' }; },
  };
  f.start = async overrides => { const site = await startSepoliaTestSite(port, { ...f.dependencies, ...overrides }); sites.push(site); return site; };
  return f;
}
async function signIn(f) {
  const response = await fetch(f.origin + '/api/test/session'), cookie = response.headers.get('set-cookie').split(';')[0];
  const { csrf } = await response.json(), headers = { cookie, origin: f.origin, 'content-type': 'application/json', 'x-csrf-token': csrf };
  const post = (path, value) => fetch(f.origin + path, { method: 'POST', headers, body: JSON.stringify(value) });
  const challengeResponse = await post('/api/test/challenge', { address: wallet.address }); assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  const verified = await post('/api/test/verify', { challengeId: challenge.challengeId, signature: await wallet.signMessage({ message: challenge.message }) });
  assert.equal(verified.status, 200);
  return { cookie, headers, post };
}

test('prelaunch is healthy but closed: options/prepare/begin reject before wallet, RPC, key and saved-request effects', async t => {
  const f = fixture(t), site = await f.start(); await until(() => site.health().observerHealthy);
  const before = readFileSync(join(f.directory, 'web-records.json'), 'utf8'), reads = f.calls.length;
  for (const [method, path] of [['GET', '/api/test/options'], ['POST', '/api/test/prepare'], ['POST', '/api/test/begin']]) {
    const response = await fetch(f.origin + path, { method }); assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { code: 'SITE_NOT_OPEN', error: 'Minting has not opened yet. Explore previews for now.' });
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal(f.calls.length, reads); assert.equal(readFileSync(join(f.directory, 'web-records.json'), 'utf8'), before);
  assert.equal(existsSync(join(f.directory, 'authorizer.key')), false); assert.equal(existsSync(join(f.directory, SITE_LAUNCH_RECORD)), false);
  const ready = await fetch(f.origin + '/health/ready'); assert.equal(ready.status, 200);
  const body = await ready.json(); assert.equal(body.mintReady, false); assert.equal(body.mintState, 'prelaunch');
  assert.equal(body.siteLaunchMode, 'prelaunch'); assert.deepEqual(body.saleStatus, { phase: 'prelaunch', paused: false });
  assert.equal(body.contractSaleStatus.phase, 'free'); assert.equal(body.mintNotice, undefined);
});
test('prelaunch /mint and /explore are wallet-free and preserve valid handle spelling with a no-JS GET redirect', async t => {
  const f = fixture(t); await f.start();
  for (const path of ['/mint?handle=Alice', '/explore', '/explore?handle=%3Cscript%3E', '/']) {
    const response = await fetch(f.origin + path); assert.equal(response.status, 200);
    const html = await response.text(); assert.match(html, /Explore previews/);
    assert.doesNotMatch(html, /data-assessment-request|data-request-submit|data-wallet-connect/);
    assert.doesNotMatch(html, /Mint availability cannot be checked|<script>/);
  }
  const response = await fetch(f.origin + '/explore?handle=%20%40Alice%20', { redirect: 'manual' });
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/p/Alice/variations');
  assert.equal(response.headers.get('set-cookie'), null);
  const variants = await fetch(f.origin + '/p/Alice/variations'); assert.equal(variants.status, 200);
  assert.match(await variants.text(), /data-preview-variations/);
  const category = await fetch(f.origin + '/ISFJ/'); assert.equal(category.status, 200);
  const categoryHtml = await category.text();
  assert.match(categoryHtml, /data-mbti-empty="prelaunch"/); assert.match(categoryHtml, /Minted signatures with ISFJ appear here\./);
  assert.match(categoryHtml, /Minting hasn’t opened yet\./);
  assert.match(categoryHtml, /Until then, explore previews for any X handle\./);
  assert.match(categoryHtml, /href="\/explore"><span>Explore previews/);
  assert.doesNotMatch(categoryHtml, /data-mbti-preview|Checking for minted|No signatures minted|data-wallet-connect|data-assessment-request/);
});
test('prelaunch does not infer launch from a paused contract or an expired absolute free window', async t => {
  const f = fixture(t); f.sale.paused = true; f.sale.phase = 1; f.sale.freeDeadline = 1n;
  const site = await f.start(); await until(() => site.health().observerHealthy);
  const status = await (await fetch(f.origin + '/health')).json();
  assert.deepEqual(status.saleStatus, { phase: 'prelaunch', paused: true }); assert.equal(status.contractSaleStatus.phase, 'paid');
  assert.equal(status.siteLaunchError, undefined); assert.equal(f.sale.freeDeadline, 1n);
});
test('late verified activity closes prelaunch presentation without inventing a chain integrity conflict or hiding views', async t => {
  const f = fixture(t), site = await f.start(); await until(() => site.health().observerHealthy);
  f.sale.freeMinted = 1n; await site.refreshSale();
  const status = await (await fetch(f.origin + '/health')).json();
  assert.equal(status.siteLaunchError, 'SITE_ALREADY_OPEN'); assert.equal(status.saleStatus.phase, 'unknown');
  assert.equal(status.mintReady, false); assert.equal(status.safetyHalted, false);
  assert.equal((await fetch(f.origin + '/health/ready')).status, 503);
  const refusal = await fetch(f.origin + '/api/test/options'); assert.equal((await refusal.json()).code, 'SITE_ALREADY_OPEN');
  assert.equal((await fetch(f.origin + '/p/Alice/variations')).status, 200);
  const session = await signIn(f);
  for (const [path, body] of [['/api/test/recover', { handle: 'Alice' }], ['/api/test/report', { code: 'no-such-code', transactionHash: hash }]]) {
    const response = await session.post(path, body); assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'REQUEST_NOT_FOUND'); // Recovery/report are not launch-gated.
  }
});
test('admin status stays role-checked during prelaunch and exposes website phase separately from numeric contract policy', async t => {
  const f = fixture(t), site = await f.start({ adminWeb: true, adminWebService: {
    async status(address_) { assert.equal(address_, wallet.address); return { policy: { ...f.sale }, wallets: [], chainId: 11155111 }; },
  } }); await until(() => site.health().observerHealthy);
  assert.equal((await fetch(f.origin + '/api/test/admin/status')).status, 409);
  const session = await signIn(f), response = await fetch(f.origin + '/api/test/admin/status', { headers: { cookie: session.cookie } });
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.policy.phase, 0); assert.equal(body.siteLaunchMode, 'prelaunch'); assert.equal(body.siteSaleStatus.phase, 'prelaunch');
  assert.equal(body.siteLaunchError, undefined);
});
test('late activity in admin status is explicitly diagnosed; maintenance stays available and new minting stays refused', async t => {
  const f = fixture(t); let actions = 0;
  const site = await f.start({ adminWeb: true, adminWebService: {
    async status(address_) { assert.equal(address_, wallet.address); return { policy: { ...f.sale }, wallets: [] }; },
    async action(address_, body) { assert.equal(address_, wallet.address); assert.equal(body.action, 'pause'); actions++; return { saved: true }; },
  } }); await until(() => site.health().observerHealthy);
  const session = await signIn(f); f.sale.lastPaidMintBlock = 255n; f.sale.phase = 1;
  const status = await fetch(f.origin + '/api/test/admin/status', { headers: { cookie: session.cookie } });
  assert.equal(status.status, 200); const body = await status.json();
  assert.equal(body.policy.phase, 1); assert.equal(body.siteLaunchMode, 'prelaunch');
  assert.deepEqual(body.siteSaleStatus, { phase: 'unknown', paused: false }); assert.equal(body.siteLaunchError, 'SITE_ALREADY_OPEN');
  assert.equal(site.health().safetyHalted, false);
  const action = await session.post('/api/test/admin/action', { action: 'pause' });
  assert.equal(action.status, 200); assert.deepEqual(await action.json(), { saved: true }); assert.equal(actions, 1);
  const options = await fetch(f.origin + '/api/test/options', { headers: { cookie: session.cookie } });
  assert.equal(options.status, 409); assert.equal((await options.json()).code, 'SITE_ALREADY_OPEN');
});
test('explicit admin maintenance actions stay available behind wallet, origin and CSRF checks during prelaunch', async t => {
  const f = fixture(t), invoked = [], service = {
    async status() { return { policy: { ...f.sale } }; },
    ...Object.fromEntries(['review', 'action', 'report', 'cancel'].map(method => [method, async (address_, body) => {
      assert.equal(address_, wallet.address); invoked.push([method, body]); return { saved: true };
    }])),
  };
  const site = await f.start({ adminWeb: true, adminWebService: service }); await until(() => site.health().observerHealthy);
  const session = await signIn(f);
  for (const [method, body] of [['review', { wallets: [wallet.address], quota: '1' }], ['action', { action: 'pause' }],
    ['report', { intentId: 'owned fixture', transactionHash: hash }], ['cancel', { intentId: 'owned fixture' }]]) {
    const denied = await fetch(f.origin + '/api/test/admin/' + method, { method: 'POST', headers: { ...session.headers, origin: 'http://127.0.0.1:1' }, body: JSON.stringify(body) });
    assert.equal(denied.status, 409); assert.equal(invoked.length, ['review', 'action', 'report', 'cancel'].indexOf(method));
    const response = await session.post('/api/test/admin/' + method, body); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { saved: true });
  }
  assert.deepEqual(invoked.map(([method]) => method), ['review', 'action', 'report', 'cancel']);
  assert.equal(existsSync(join(f.directory, SITE_LAUNCH_RECORD)), false);
});
test('open defaults preserve RC2 free/paid quotes and maintenance; restart cannot return to prelaunch', async t => {
  const f = fixture(t, 'open'), site = await f.start(); await until(() => site.health().mintReady);
  const original = readFileSync(join(f.directory, SITE_LAUNCH_RECORD), 'utf8'), session = await signIn(f);
  const quote = () => fetch(f.origin + '/api/test/options', { headers: { cookie: session.cookie } });
  let response = await quote(); assert.equal(response.status, 200); let body = await response.json();
  assert.equal(body.phase, 'free'); assert.equal(body.free, true); assert.equal(body.paid, false);
  f.sale.phase = 1; response = await quote(); body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.phase, 'paid'); assert.equal(body.paid, true); assert.equal(body.free, false);
  f.sale.paused = true; response = await quote(); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'MINT_PAUSED');
  await site.close();
  await assert.rejects(f.start({ siteLaunchMode: 'prelaunch' }), { code: 'SITE_ALREADY_OPEN' });
  assert.equal(existsSync(join(f.directory, 'site.lock')), false); assert.equal(readFileSync(join(f.directory, SITE_LAUNCH_RECORD), 'utf8'), original);
  const reopened = await f.start({ siteLaunchMode: 'open' }); await until(() => reopened.health().observerHealthy);
  assert.equal(readFileSync(join(f.directory, SITE_LAUNCH_RECORD), 'utf8'), original);
});
test('legacy saved attempts refuse prelaunch startup and remain untouched for recovery under open mode', async t => {
  const f = fixture(t), rows = { planDigest: plan.digest, requests: { alice: { stage: 'begun', code: 'prior-uncertain-attempt' } } };
  const original = JSON.stringify(rows); writeFileSync(join(f.directory, 'web-records.json'), original, { mode: 0o600 });
  await assert.rejects(f.start(), { code: 'SITE_ALREADY_OPEN' });
  assert.equal(existsSync(join(f.directory, 'site.lock')), false); assert.equal(readFileSync(join(f.directory, 'web-records.json'), 'utf8'), original);
  assert.equal(existsSync(join(f.directory, SITE_LAUNCH_RECORD)), false);
});
test('failed binding leaves no first-open record; invalid startup config refuses before deployment state access', async t => {
  const f = fixture(t, 'open'), occupied = createServer((_req, res) => res.end('owned fixture'));
  await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(port, '127.0.0.1', resolve); });
  try { await assert.rejects(f.start(), { code: 'EADDRINUSE' }); }
  finally { await new Promise(resolve => occupied.close(resolve)); }
  assert.equal(existsSync(join(f.directory, SITE_LAUNCH_RECORD)), false); assert.equal(existsSync(join(f.directory, 'site.lock')), false);
  const invalid = { siteLaunchMode: 'paused', get plan() { throw Error('deployment must not be loaded'); } };
  await assert.rejects(startSepoliaTestSite(port, invalid), /Invalid website launch mode/);
  const site = await f.start(); await until(() => site.health().observerHealthy);
});
test('first-open persistence failure closes the listener, UI and process lock; it never silently opens', async t => {
  const f = fixture(t, 'open'); let closed = 0;
  await assert.rejects(f.start({ ui: { close: async () => { closed++; }, call: async () => '' },
    saveRecords: () => { writeFileSync(join(f.directory, 'web-records.json'), JSON.stringify({ planDigest: hash, requests: {} }), { mode: 0o600 });
      writeFileSync(join(f.directory, SITE_LAUNCH_RECORD), 'owned collision fixture', { mode: 0o600 }); } }), { code: 'EEXIST' });
  assert.equal(closed, 1); assert.equal(existsSync(join(f.directory, 'site.lock')), false);
  assert.equal(readFileSync(join(f.directory, SITE_LAUNCH_RECORD), 'utf8'), 'owned collision fixture');
  const probe = createServer((_req, res) => res.end('released'));
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
});
test('startup cleanup preserves a replaced lock and the original error, and refuses known cached activity', async t => {
  const f = fixture(t, 'open'), original = Error('owned fixture startup failure');
  await assert.rejects(f.start({ saveRecords: () => {
    renameSync(join(f.directory, 'site.lock'), join(f.directory, 'old-site.lock'));
    writeFileSync(join(f.directory, 'site.lock'), String(process.pid), { mode: 0o600 });
    throw original;
  } }), error => error === original);
  assert.equal(readFileSync(join(f.directory, 'site.lock'), 'utf8'), String(process.pid));
  const separate = fixture(t);
  await assert.rejects(separate.start({ cache: { presentation: () => ({ mints: new Map([['alice', {}]]) }) } }), { code: 'SITE_ALREADY_OPEN' });
  assert.equal(existsSync(join(separate.directory, 'site.lock')), false);
});
test('standalone explicit prelaunch needs no plan, address, key or RPC and offers only anonymous previews/readiness', async t => {
  const site = await startSepoliaFrontend({ port, siteLaunchMode: 'prelaunch' }); t.after(() => site.close());
  const origin = `http://127.0.0.1:${port}`, status = await (await fetch(origin + '/health/ready')).json();
  assert.equal(status.frontendOnly, true); assert.equal(status.collection, undefined); assert.equal(status.mintReady, false); assert.equal(status.saleStatus.phase, 'prelaunch');
  const cap = await fetch(origin + '/api/test/capabilities'); assert.equal(cap.status, 200); assert.equal((await cap.json()).siteLaunchMode, 'prelaunch');
  for (const path of ['/', '/mint', '/explore', '/p/Alice/variations']) {
    const response = await fetch(origin + path); assert.equal(response.status, 200);
    const html = await response.text(); assert.match(html, /\/assets\/sepolia-readiness\.js/);
    assert.doesNotMatch(html, /data-assessment-request|data-request-submit|data-wallet-connect|Mint availability cannot be checked/);
  }
  for (const mbti of MBTI_TYPES) {
    const response = await fetch(origin + `/${mbti}/`); assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /data-mbti-empty="prelaunch"/); assert.ok(html.includes(`Minted signatures with ${mbti} appear here.`));
    assert.match(html, /Minting hasn’t opened yet\./);
    assert.match(html, /Until then, explore previews for any X handle\./);
    assert.match(html, /href="\/explore"><span>Explore previews/);
    assert.doesNotMatch(html, /data-mbti-preview|Checking for minted|No signatures minted|data-assessment-request|data-wallet-connect|data-mint-observation-warning/);
  }
  assert.equal((await fetch(origin + '/assets/sepolia-readiness.js')).status, 200);
  assert.equal((await fetch(origin + '/api/test/session')).status, 503);
  for (const path of ['/api/test/options', '/api/test/prepare', '/api/test/begin']) {
    const response = await fetch(origin + path); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'SITE_NOT_OPEN');
  }
  const redirect = await fetch(origin + '/explore?handle=%40Alice', { redirect: 'manual' });
  assert.equal(redirect.headers.get('location'), '/p/Alice/variations');
});
test('a deployment-bound preview frontend cannot relabel a previously opened or mismatched collection prelaunch', async t => {
  const f = fixture(t);
  await assert.rejects(startSepoliaFrontend({ port, siteLaunchMode: 'prelaunch', collection: address }), /exact plan and directory/);
  await assert.rejects(startSepoliaFrontend({ port, siteLaunchMode: 'prelaunch', collection: '0x' + '22'.repeat(20), plan, directory: f.directory }));
  const preview = await startSepoliaFrontend({ port, siteLaunchMode: 'prelaunch', plan, directory: f.directory });
  await preview.close(); assert.equal(existsSync(join(f.directory, SITE_LAUNCH_RECORD)), false);
  const open = await f.start({ siteLaunchMode: 'open' }); await open.close();
  await assert.rejects(startSepoliaFrontend({ port, siteLaunchMode: 'prelaunch', plan, directory: f.directory }), { code: 'SITE_ALREADY_OPEN' });
});
