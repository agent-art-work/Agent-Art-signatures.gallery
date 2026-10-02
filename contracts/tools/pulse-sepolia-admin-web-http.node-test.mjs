import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import { startSepoliaTestSite } from '../../scripts/pulse-sepolia-site.mjs';
import { PublicError } from '../../src/openMint/security.ts';
import { PULSE_ADMIN_PROFILE } from '../../src/openMint/pulseAdminAuthorization.ts';

const admin = privateKeyToAccount('0x' + '4'.padStart(64, '0'));
const minter = privateKeyToAccount('0x' + '5'.padStart(64, '0'));
const collection = getAddress('0x' + '21'.repeat(20)), hash = '0x' + 'a3'.repeat(32);
const plan = { contractProfile: PULSE_ADMIN_PROFILE, digest: hash, collection: { address: collection },
  authorities: { admin: admin.address, authorizer: minter.address }, renderer: { identity: hash } };
const binding = { ...plan, collection, authorizer: minter.address, testOnly: true,
  deployment: { finalized: true, blockNumber: '1', blockHash: hash } };
const head = () => ({ number: '0x100', hash, timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) });
const localFetch = (url, options = {}) => fetch(url, { ...options, headers: { connection: 'close', ...options.headers } });

async function fixture(t, enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), 'sg-admin-http-')), calls = [];
  const enforceAdmin = wallet => { if (wallet !== admin.address) throw new PublicError(403, 'ADMIN_REQUIRED', 'This wallet is not the contract admin.'); };
  const service = Object.fromEntries(['status', 'review', 'action', 'report', 'cancel'].map(method => [method, async (wallet, body) => {
    enforceAdmin(wallet); calls.push({ method, wallet, body });
    return method === 'status' ? { collection, chainId: 11155111, admin: admin.address, wallets: [admin.address] }
      : { method, received: body };
  }]));
  const rpc = async method => { if (method === 'eth_getCode') return '0x'; if (method === 'eth_getBlockByNumber') return head();
    assert.fail('No HTTP test may sign or broadcast: ' + method); };
  const site = await startSepoliaTestSite(32177, { plan, journal: {}, directory, ui: false, adminWeb: enabled,
    adminWebService: service, intervalMs: 30000, context: { rpc, second: (...args) => rpc(...args) }, validateSource: async () => {},
    verifyDeployment: async () => binding,
    readMintState: async () => ({ at: Date.now(), head: head(), sale: { phase: 0, paused: false,
      freeMinted: 0n, freeMintQuota: 1n, freeSlotCount: 1n, freeConfigRevision: 1n,
      freeDeadline: BigInt(Math.floor(Date.now() / 1000) + 86400) } }),
    observe: async () => ({ at: Date.now(), head: head(), finalized: head(), finalNumber: 256n,
      mints: new Map(), expectedMintCount: 0 }) });
  t.after(async () => { await site.close(); rmSync(directory, { recursive: true, force: true }); });
  const until = Date.now() + 2500;
  while (!site.health().mintReady && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(site.health().mintReady, true);
  const origin = 'http://127.0.0.1:32177';
  async function session(account) {
    const opened = await localFetch(origin + '/api/test/session');
    const cookie = opened.headers.get('set-cookie').split(';')[0], { csrf } = await opened.json();
    const post = async (path, body, overrides = {}) => {
      const response = await localFetch(origin + path, { method: 'POST', headers: {
        cookie, origin, 'content-type': 'application/json', 'x-csrf-token': csrf, ...overrides }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const get = async path => { const response = await localFetch(origin + path, { headers: { cookie } });
      return { status: response.status, body: await response.json() }; };
    if (account) {
      const challenge = await post('/api/test/admin/challenge', { address: account.address });
      assert.equal(challenge.status, 200); assert.match(challenge.body.message, /administer the free-mint allowlist and quota/);
      const proof = await post('/api/test/verify', { challengeId: challenge.body.challengeId,
        signature: await account.signMessage({ message: challenge.body.message }) });
      assert.equal(proof.status, 200);
    }
    return { post, get };
  }
  return { calls, origin, session };
}

test('admin page is public shell only, while unauthenticated and non-admin wallets cannot access ordered allowlist', async t => {
  const f = await fixture(t);
  const page = await (await localFetch(f.origin + '/admin')).text();
  assert.match(page, /data-admin/); assert.doesNotMatch(page, /sepolia-readiness\.js/);
  assert.doesNotMatch(page, /sepolia\.js["']/); assert.equal(f.calls.length, 0);
  const guest = await f.session(); assert.equal((await guest.get('/api/test/admin/status')).status, 409);
  assert.equal((await guest.post('/api/test/admin/review', { wallets: admin.address, quota: '1' })).status, 409);
  const user = await f.session(minter); const denied = await user.get('/api/test/admin/status');
  assert.equal(denied.status, 403); assert.equal(denied.body.code, 'ADMIN_REQUIRED');
  assert.equal((await user.post('/api/test/admin/action', { action: 'pause' })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('authenticated admin endpoints keep origin/CSRF/strict input fences and allow a bounded 5000-slot review', async t => {
  const f = await fixture(t), user = await f.session(admin);
  assert.equal((await user.get('/api/test/admin/status')).status, 200);
  for (const overrides of [{ 'x-csrf-token': 'wrong' }, { origin: 'https://attacker.example' }]) {
    const denied = await user.post('/api/test/admin/action', { action: 'pause' }, overrides);
    assert.ok(denied.status >= 400);
  }
  const before = f.calls.length;
  assert.equal((await user.post('/api/test/admin/action', { action: 'pause', to: minter.address })).status, 400);
  assert.equal((await user.post('/api/test/admin/report', { intentId: 'x', transactionHash: hash, data: '0x' })).status, 400);
  assert.equal(f.calls.length, before);
  const wallets = Array(5000).fill(admin.address).join('\n');
  const reviewed = await user.post('/api/test/admin/review', { wallets, quota: '5000' });
  assert.equal(reviewed.status, 200); assert.equal(reviewed.body.received.wallets, wallets);
  const oversized = await user.post('/api/test/admin/review', { wallets: 'x'.repeat(256 * 1024), quota: '1' });
  assert.equal(oversized.status, 409); assert.equal(oversized.body.code, 'INVALID_INPUT');
  const action = await user.post('/api/test/admin/action', { action: 'configure', reviewId: 'review' });
  assert.equal(action.status, 200); assert.deepEqual(action.body.received, { action: 'configure', reviewId: 'review' });
  assert.equal((await user.post('/api/test/admin/report', { intentId: 'intent', transactionHash: hash })).status, 200);
  assert.equal((await user.post('/api/test/admin/cancel', { intentId: 'intent' })).status, 200);
  await user.post('/api/test/logout', {});
  assert.equal((await user.get('/api/test/admin/status')).status, 409);
});

test('admin route and new challenge are disabled when the deployment has no admin-web capability', async t => {
  const f = await fixture(t, false), user = await f.session();
  assert.equal((await localFetch(f.origin + '/admin')).status, 404);
  const status = await user.get('/api/test/admin/status'); assert.equal(status.status, 409);
  assert.equal(status.body.code, 'ADMIN_UNAVAILABLE');
  assert.equal((await user.post('/api/test/admin/challenge', { address: admin.address })).body.code, 'ADMIN_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
});
