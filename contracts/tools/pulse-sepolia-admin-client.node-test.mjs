import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { SEPOLIA_ADMIN_CLIENT } from '../../scripts/pulse-sepolia-admin-client.mjs';

const ADMIN = '0x0000000000000000000000000000000000000001';
const COLLECTION = '0x0000000000000000000000000000000000000002';
const OTHER = '0x0000000000000000000000000000000000000003';
const HASH = '0x' + '11'.repeat(32), ROOT = '0x' + '22'.repeat(32);
const KEY = 'sg-sepolia-admin-pending:' + COLLECTION;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function node(tag = 'p') {
  let children = [], text = '';
  const value = { tag, dataset: {}, handlers: {}, disabled: false, hidden: false, value: '', checked: false, className: '',
    addEventListener(name, handler) { this.handlers[name] = handler; },
    get textContent() { return children.length ? children.map(child => child.textContent).join('') : text; },
    set textContent(value) { children = []; text = String(value); },
    replaceChildren(...values) { children = values; text = ''; },
    get children() { return children; },
    ownerDocument: { createElement: node, createTextNode(value) { const text = node('#text'); text.textContent = value; return text; } },
    classList: { remove(...names) { value.className = value.className.split(' ').filter(name => !names.includes(name)).join(' '); },
      add(...names) { value.className = [...new Set([...value.className.split(' ').filter(Boolean), ...names])].join(' '); } },
  };
  return value;
}

async function harness(options = {}) {
  const nodes = new Map(), calls = [], timers = new Map(), events = new Map(), storage = options.storage || new Map();
  const names = ['page', 'connect', 'logout', 'refresh', 'review', 'pause', 'configure', 'unpause', 'reconcile', 'wallets', 'quota', 'wallet-label',
    'wallet-feedback', 'feedback', 'review-feedback', 'action-feedback', 'pending-feedback', 'pending', 'pending-summary', 'pending-hash', 'reconcile-hash',
    'state', 'used', 'slots', 'deadline', 'revision', 'root', 'review-summary', 'review-quota', 'review-slots', 'review-changes', 'review-root',
    'end-warning', 'end-ack-label', 'end-ack'];
  for (const name of names) nodes.set('[data-admin-' + name + ']', node());
  nodes.set('[data-admin-connect] > span', node('span'));
  nodes.get('[data-admin-page]').dataset.adminCollection = COLLECTION;
  let serverWallet = options.restored === false ? undefined : ADMIN, nextTimer = 0, intents = 0;
  let currentReview;
  const state = { accounts: [ADMIN], chainId: '0xaa36a7', ...options.walletState };
  const policy = { phase: 0, paused: false, root: ROOT, slotCount: '1', quota: '4', revision: '1', freeMinted: '1', freeDeadline: '1790000000', ...options.policy };
  const server = { collection: COLLECTION, chainId: 11155111, admin: ADMIN, policy, wallets: [ADMIN], ...options.status };
  const providerEvents = new Map();
  const provider = { async request(request) {
    calls.push({ type: 'wallet', ...request });
    if (options.walletHook) await options.walletHook(request, { state, events: providerEvents, server });
    if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return [...state.accounts];
    if (request.method === 'eth_chainId') return state.chainId;
    if (request.method === 'wallet_switchEthereumChain') { state.chainId = request.params[0].chainId; return null; }
    if (request.method === 'personal_sign') { if (options.signError) throw options.signError; return '0xsignature'; }
    if (request.method === 'eth_sendTransaction') { if (options.sendError) throw options.sendError; return options.sendHash ?? HASH; }
    throw Error('Unexpected wallet method: ' + request.method);
  }, on(name, handler) { providerEvents.set(name, handler); }, removeListener(name, handler) { if (providerEvents.get(name) === handler) providerEvents.delete(name); } };
  const rabby = { ...provider, isRabby: true, async request(request) { calls.push({ type: 'rabby', ...request }); return provider.request(request); } };
  const window = { ethereum: options.missingProvider ? undefined : provider,
    addEventListener(name, handler) { events.set(name, handler); },
    dispatchEvent(event) {
      if (event.type === 'eip6963:requestProvider' && options.rabby)
        events.get('eip6963:announceProvider')?.({ detail: { provider: rabby, info: { rdns: 'io.rabby' } } });
    },
  };
  const response = value => ({ ok: true, async json() { return JSON.parse(JSON.stringify(value)); } });
  const fetch = async (path, request) => {
    const body = request.body ? JSON.parse(request.body) : undefined;
    calls.push({ type: 'api', path, body, request });
    const override = await options.apiHook?.(path, body, { server, state, calls });
    if (override) return override;
    if (path === '/api/test/session') return response({ csrf: 'csrf-token', wallet: serverWallet });
    if (path === '/api/test/admin/challenge') return response({ challengeId: 'challenge-1', message: 'Sign in to administer Sepolia. No transaction.' });
    if (path === '/api/test/verify') { serverWallet = state.accounts[0]; return response({ wallet: serverWallet }); }
    if (path === '/api/test/logout') { serverWallet = undefined; return response({ disconnected: true }); }
    if (path === '/api/test/admin/status') return response(server);
    if (path === '/api/test/admin/review') {
      currentReview = { reviewId: 'review-1', root: ROOT, slotCount: String(body.wallets.split(/\r?\n/).filter(value => value.trim()).length), quota: body.quota,
        previousQuota: server.policy.quota, previousSlotCount: server.policy.slotCount, revision: '2', addedSlots: '1', reassignedSlots: '0',
        endsFreeMint: body.quota === String(server.policy.freeMinted), ...options.reviewResult };
      return response(currentReview);
    }
    if (path === '/api/test/admin/action') {
      const word = value => BigInt(value).toString(16).padStart(64, '0');
      const data = body.action === 'pause' ? '0xda8fbf2a' : body.action === 'unpause' ? '0xae200322'
        : '0x6468c3a7' + currentReview.root.slice(2) + word(currentReview.slotCount) + word(currentReview.quota);
      const result = { intentId: 'intent-' + ++intents, action: body.action,
        transaction: { from: ADMIN, to: COLLECTION, chainId: '0xaa36a7', data, value: '0x0', gas: '0x186a0', ...options.transaction } };
      server.pending = { intentId: result.intentId, action: result.action };
      return response(result);
    }
    if (path === '/api/test/admin/cancel') { delete server.pending; return response({ state: 'abandoned' }); }
    if (path === '/api/test/admin/report') {
      const state = options.reportState ?? 'pending';
      if (state !== 'pending') {
        if (state === 'confirmed' && server.pending) {
          if (server.pending.action === 'pause') server.policy.paused = true;
          if (server.pending.action === 'unpause') server.policy.paused = false;
        }
        delete server.pending;
      } else if (server.pending) server.pending.transactionHash = body.transactionHash;
      return response({ state, transactionHash: body.transactionHash });
    }
    throw Error('Unexpected API: ' + path);
  };
  const context = { window, document: { querySelector(selector) { return nodes.get(selector) || null; } }, fetch, TextEncoder,
    sessionStorage: { getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { if (options.storageFailure) throw Error('storage unavailable'); storage.set(key, value); }, removeItem(key) { storage.delete(key); } },
    Event: class { constructor(type) { this.type = type; } },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  const client = runInNewContext(SEPOLIA_ADMIN_CLIENT, context);
  await client.initialized;
  return { client, calls, nodes, state, server, storage, timers, provider, events, providerEvents,
    node: name => nodes.get('[data-admin-' + name + ']'),
    emit(name) { providerEvents.get(name)?.(); },
    async timer() { const [id, timer] = timers.entries().next().value || []; if (timer) { timers.delete(id); timer.fn(); await flush(); } },
  };
}
const apiCalls = (h, path) => h.calls.filter(call => call.type === 'api' && (!path || call.path === path));
const sends = h => h.calls.filter(call => call.type === 'wallet' && call.method === 'eth_sendTransaction');

test('passive restoration reads permissions and policy without signing or preparing actions', async () => {
  const h = await harness();
  assert.deepEqual(apiCalls(h).map(call => call.path), ['/api/test/session', '/api/test/admin/status']);
  assert.deepEqual(h.calls.filter(call => call.type === 'wallet').map(call => call.method), ['eth_accounts', 'eth_chainId']);
  assert.equal(h.node('state').textContent, 'Live Free'); assert.equal(h.node('used').textContent, '1 / 4');
  assert.equal(h.node('wallets').value, ADMIN); assert.equal(h.node('pause').disabled, false);
  assert.equal(h.node('configure').disabled, true); assert.equal(h.storage.size, 0);
});

test('explicit connect chooses announced Rabby and switches Sepolia before admin sign-in', async () => {
  const h = await harness({ restored: false, rabby: true, walletState: { chainId: '0x1' } });
  assert.equal(apiCalls(h).length, 1);
  await h.client.connect();
  const methods = h.calls.filter(call => call.type === 'rabby').map(call => call.method);
  assert.ok(methods.includes('wallet_switchEthereumChain')); assert.ok(methods.includes('eth_requestAccounts')); assert.ok(methods.includes('personal_sign'));
  assert.ok(methods.indexOf('wallet_switchEthereumChain') < methods.indexOf('personal_sign'));
  assert.equal(apiCalls(h, '/api/test/admin/challenge').length, 1);
  assert.equal(apiCalls(h, '/api/test/challenge').length, 0);
  assert.equal(apiCalls(h, '/api/test/verify')[0].request.headers['X-CSRF-Token'], 'csrf-token');
  assert.equal(sends(h).length, 0);
});

test('a rejected sign-in grants no admin actions', async () => {
  const h = await harness({ restored: false, signError: { code: 4001 } });
  await h.client.connect();
  assert.equal(apiCalls(h, '/api/test/verify').length, 0);
  assert.equal(apiCalls(h, '/api/test/admin/status').length, 0);
  assert.equal(h.node('pause').disabled, true); assert.match(h.node('wallet-feedback').textContent, /cancelled/);
});

test('unsupported or non-admin wallets cannot gain capability from a displayed policy', async () => {
  const h = await harness({ status: { admin: OTHER } });
  assert.equal(h.node('pause').disabled, true); assert.equal(h.node('review').disabled, true);
  await h.client.act('pause'); assert.equal(apiCalls(h, '/api/test/admin/action').length, 0);
});

test('restoration fails closed on network mismatch and never switches automatically', async () => {
  const h = await harness({ walletState: { chainId: '0x1' } });
  assert.equal(h.node('pause').disabled, true);
  assert.ok(h.calls.every(call => call.method !== 'wallet_switchEthereumChain' && call.method !== 'personal_sign'));
  assert.match(h.node('wallet-feedback').textContent, /Sepolia/);
});

test('a challenge response arriving after an account change cannot request a signature', async () => {
  const gate = deferred();
  const h = await harness({ restored: false, apiHook: async path => { if (path === '/api/test/admin/challenge') await gate.promise; } });
  const connecting = h.client.connect(); await flush();
  h.state.accounts = [OTHER]; h.emit('accountsChanged'); gate.resolve(); await connecting;
  assert.equal(h.calls.filter(call => call.method === 'personal_sign').length, 0);
  assert.equal(h.node('pause').disabled, true);
});

test('review preserves ordered duplicate slots and editing invalidates the confirmation', async () => {
  const h = await harness({ policy: { paused: true } });
  h.node('wallets').value = ADMIN + '\n' + ADMIN + '\n' + OTHER;
  await h.client.review();
  assert.equal(apiCalls(h, '/api/test/admin/review')[0].body.wallets, ADMIN + '\n' + ADMIN + '\n' + OTHER);
  assert.equal(h.node('review-summary').hidden, false); assert.equal(h.node('configure').disabled, false);
  h.node('quota').value = '5'; h.node('quota').handlers.input();
  assert.equal(h.node('review-summary').hidden, true); assert.equal(h.node('configure').disabled, true);
  await h.client.act('configure'); assert.equal(apiCalls(h, '/api/test/admin/action').length, 0);
});

test('irreversible end of free minting requires explicit acknowledgement', async () => {
  const h = await harness({ policy: { paused: true } });
  h.node('quota').value = '1'; await h.client.review();
  assert.equal(h.node('end-warning').hidden, false); assert.equal(h.node('configure').disabled, true);
  await h.client.act('configure'); assert.equal(sends(h).length, 0);
  h.node('end-ack').checked = true; h.node('end-ack').handlers.change();
  await h.client.act('configure'); assert.equal(sends(h).length, 1);
  assert.match(sends(h)[0].params[0].data, /^0x6468c3a7/);
  assert.equal(h.node('pending').hidden, false);
});

test('a review arriving after a draft edit is ignored', async () => {
  const gate = deferred();
  const h = await harness({ policy: { paused: true }, apiHook: async path => { if (path === '/api/test/admin/review') await gate.promise; } });
  const reviewing = h.client.review(); await flush(); h.node('quota').value = '6'; h.node('quota').handlers.input();
  gate.resolve(); await reviewing;
  assert.equal(h.node('review-summary').hidden, true); assert.equal(h.node('configure').disabled, true);
});

test('wallet changes after preparing an intent fence the send and abandon only that unsent intent', async () => {
  const gate = deferred();
  const h = await harness({ apiHook: async path => { if (path === '/api/test/admin/action') await gate.promise; } });
  const acting = h.client.act('pause'); await flush(); h.emit('chainChanged'); gate.resolve(); await acting;
  assert.equal(sends(h).length, 0); assert.equal(h.node('pending').hidden, true);
  assert.deepEqual(apiCalls(h, '/api/test/admin/cancel')[0].body, { intentId: 'intent-1' });
});

for (const [label, transaction] of [['wrong collection', { to: OTHER }], ['wrong sender', { from: OTHER }], ['wrong chain', { chainId: '0x1' }],
  ['unexpected ETH', { value: '0x1' }], ['wrong function', { data: '0xdeadbeef' }], ['extra transaction field', { accessList: [] }],
  ['excessive gas', { gas: '0xffffffffff' }], ['invalid nonce', { nonce: '-1' }]]) {
  test('invalid transaction ' + label + ' is blocked before wallet send', async () => {
    const h = await harness({ transaction }); await h.client.act('pause');
    assert.equal(sends(h).length, 0); assert.deepEqual(apiCalls(h, '/api/test/admin/cancel')[0].body, { intentId: 'intent-1' });
    assert.match(h.node('action-feedback').textContent, /No transaction was sent/);
    assert.equal(h.node('pending').hidden, true); assert.equal(apiCalls(h, '/api/test/admin/action').length, 1);
  });
}

test('only an explicit action sends once and stores only intent and hash in the collection namespace', async () => {
  const h = await harness({ transaction: { nonce: '0x7' } });
  await h.client.act('pause'); await h.client.act('pause');
  assert.equal(sends(h).length, 1); assert.equal(sends(h)[0].params[0].nonce, '0x7');
  assert.deepEqual(JSON.parse(h.storage.get(KEY)), { intentId: 'intent-1', transactionHash: HASH });
  assert.equal(apiCalls(h, '/api/test/admin/action').length, 1);
  await h.timer(); assert.equal(sends(h).length, 1);
});

test('failed recovery storage blocks broadcasting', async () => {
  const h = await harness({ storageFailure: true }); await h.client.act('pause');
  assert.equal(sends(h).length, 0); assert.equal(h.node('pending').hidden, true);
  assert.match(h.node('action-feedback').textContent, /could not be saved/);
  assert.deepEqual(apiCalls(h, '/api/test/admin/cancel')[0].body, { intentId: 'intent-1' });
});

test('a definitive wallet rejection closes only that intent and requires another deliberate click', async () => {
  const h = await harness({ sendError: { code: 4001 } }); await h.client.act('pause');
  assert.equal(sends(h).length, 1); assert.deepEqual(apiCalls(h, '/api/test/admin/cancel')[0].body, { intentId: 'intent-1' });
  assert.equal(h.storage.has(KEY), false); assert.equal(h.node('pending').hidden, true);
  assert.equal(apiCalls(h, '/api/test/admin/action').length, 1); assert.equal(h.node('pause').disabled, false);
});

test('uncertain wallet submission retains an intent for manual hash reconciliation', async () => {
  const h = await harness({ sendError: Error('wallet transport disconnected') }); await h.client.act('pause');
  assert.equal(apiCalls(h, '/api/test/admin/cancel').length, 0);
  assert.deepEqual(JSON.parse(h.storage.get(KEY)), { intentId: 'intent-1' });
  await h.client.act('pause'); assert.equal(sends(h).length, 1);
  h.node('reconcile-hash').value = HASH; await h.client.reconcile();
  assert.deepEqual(apiCalls(h, '/api/test/admin/report')[0].body, { intentId: 'intent-1', transactionHash: HASH });
  assert.equal(sends(h).length, 1);
});

test('restored server pending state exposes manual reconciliation and never rebroadcasts', async () => {
  const h = await harness({ status: { pending: { intentId: 'intent-old', action: 'configure' } } });
  assert.equal(h.node('pending').hidden, false); assert.match(h.node('pending-summary').textContent, /no recorded hash/);
  assert.equal(h.node('pause').disabled, true); assert.equal(h.node('reconcile').disabled, false);
  assert.equal(sends(h).length, 0); assert.equal(apiCalls(h, '/api/test/admin/report').length, 0);
  h.node('reconcile-hash').value = HASH; await h.client.reconcile();
  assert.equal(sends(h).length, 0); assert.equal(apiCalls(h, '/api/test/admin/report').length, 1);
});

test('restored hashes are polled a bounded number of times without new sends', async () => {
  const h = await harness({ status: { pending: { intentId: 'intent-old', action: 'pause', transactionHash: HASH } } });
  await flush();
  for (let i = 0; i < 15; i++) await h.timer();
  assert.equal(apiCalls(h, '/api/test/admin/report').length, 12);
  assert.equal(h.timers.size, 0); assert.equal(sends(h).length, 0);
  assert.match(h.node('pending-feedback').textContent, /Check transaction/);
});

test('confirmed and reverted reports clear local recovery and refresh the authoritative policy', async () => {
  for (const reportState of ['confirmed', 'reverted']) {
    const h = await harness({ reportState }); await h.client.act('pause');
    assert.equal(h.storage.has(KEY), false); assert.equal(h.node('pending').hidden, true);
    assert.equal(h.node('state').textContent, reportState === 'confirmed' ? 'Paused' : 'Live Free');
    assert.match(h.node('action-feedback').textContent, new RegExp(reportState));
  }
});

test('an allowlist artifact error disables editing while retaining pause and resume permission', async () => {
  const h = await harness({ status: { configurationError: 'Stored allowlist does not match the live root.', wallets: [] } });
  assert.equal(h.node('wallets').disabled, true); assert.equal(h.node('review').disabled, true); assert.equal(h.node('configure').disabled, true);
  assert.equal(h.node('pause').disabled, false); assert.match(h.node('feedback').textContent, /allowlist/);
  await h.client.review(); assert.equal(apiCalls(h, '/api/test/admin/review').length, 0);
});

test('expired wallet proof removes action permission and requires explicit connection', async () => {
  let expired = false;
  const h = await harness({ apiHook: async path => expired && path === '/api/test/admin/status'
    ? { ok: false, async json() { return { code: 'CONNECT_WALLET', error: 'Wallet proof expired.' }; } } : undefined });
  expired = true; await h.client.refresh();
  assert.equal(h.node('pause').disabled, true); assert.equal(h.node('connect').disabled, false);
  assert.match(h.node('wallet-feedback').textContent, /expired/);
  assert.equal(apiCalls(h, '/api/test/admin/challenge').length, 0);
});

test('review then pause then apply preserves the reviewed draft across pause confirmation', async () => {
  const h = await harness({ reportState: 'confirmed' });
  await h.client.review(); assert.equal(h.node('review-summary').hidden, false); assert.equal(h.node('configure').disabled, true);
  await h.client.act('pause');
  assert.equal(h.node('state').textContent, 'Paused'); assert.equal(h.node('review-summary').hidden, false); assert.equal(h.node('configure').disabled, false);
  await h.client.act('configure');
  assert.deepEqual(apiCalls(h, '/api/test/admin/action').map(call => call.body.action), ['pause', 'configure']);
  assert.equal(sends(h).length, 2); assert.equal(h.node('review-summary').hidden, true);
});

test('refresh is single flight, visible, and ignores changing observation metadata', async () => {
  let held = false; const gate = deferred();
  const h = await harness({ policy: { paused: true }, apiHook: async path => { if (held && path === '/api/test/admin/status') await gate.promise; } });
  await h.client.review(); h.server.policy.head = { number: '0x123', hash: HASH }; h.server.policy.timestamp = '1234';
  held = true; const first = h.client.refresh(), second = h.client.refresh();
  assert.equal(first, second); assert.equal(h.node('refresh').disabled, true); assert.match(h.node('feedback').textContent, /Checking current policy/);
  gate.resolve(); await first;
  assert.equal(apiCalls(h, '/api/test/admin/status').length, 2); assert.equal(h.node('configure').disabled, false);
  h.server.policy.freeMinted = '2'; held = false; await h.client.refresh();
  assert.equal(h.node('configure').disabled, true); assert.equal(h.node('review-summary').hidden, true);
});

test('pause and resume require explicit pauser capability', async () => {
  for (const paused of [false, true]) {
    const h = await harness({ policy: { paused }, status: { canPause: false } });
    assert.equal(h.node('pause').disabled, true); assert.equal(h.node('unpause').disabled, true);
    await h.client.act(paused ? 'unpause' : 'pause'); assert.equal(apiCalls(h, '/api/test/admin/action').length, 0);
    await h.client.review(); assert.equal(h.node('review-summary').hidden, false);
  }
});

test('logging out clears the old draft before another verified admin signs in', async () => {
  const h = await harness();
  h.node('wallets').value = ADMIN + '\n' + ADMIN; await h.client.logout();
  h.state.accounts = [OTHER]; h.server.admin = OTHER; h.server.wallets = [OTHER]; h.server.policy.quota = '9';
  await h.client.connect();
  assert.equal(h.node('wallets').value, OTHER); assert.equal(h.node('quota').value, '9');
});

test('an unvalidated recovery hash can be corrected but a validated hash is immutable', async () => {
  const replacement = '0x' + '33'.repeat(32);
  for (const hashValidated of [false, true]) {
    const h = await harness({ status: { pending: { intentId: 'intent-old', action: 'pause', transactionHash: HASH, hashValidated } } });
    await flush(); h.node('reconcile-hash').value = replacement; await h.client.reconcile();
    const reports = apiCalls(h, '/api/test/admin/report');
    assert.equal(reports.length, hashValidated ? 1 : 2);
    assert.equal(reports.at(-1).body.transactionHash, hashValidated ? HASH : replacement);
    if (hashValidated) assert.match(h.node('pending-feedback').textContent, /already validated/);
  }
});

test('overlapping policy refresh and reconciliation reuse the in-flight report', async () => {
  const gate = deferred();
  const h = await harness({ status: { pending: { intentId: 'intent-old', action: 'pause', transactionHash: HASH } },
    apiHook: async path => { if (path === '/api/test/admin/report') await gate.promise; } });
  await h.client.refresh(); h.node('reconcile-hash').value = HASH; const checking = h.client.reconcile(); await flush();
  assert.equal(apiCalls(h, '/api/test/admin/report').length, 1);
  gate.resolve(); await checking;
  assert.equal(h.timers.size, 1); assert.equal(sends(h).length, 0);
});

test('network changes stop old polling and explicit reconnect resumes the same hash', async () => {
  const h = await harness({ status: { pending: { intentId: 'intent-old', action: 'pause', transactionHash: HASH } } });
  await flush(); h.emit('chainChanged'); assert.equal(h.timers.size, 0);
  const reports = apiCalls(h, '/api/test/admin/report').length;
  await h.client.connect(); await flush();
  assert.equal(apiCalls(h, '/api/test/admin/report').length, reports + 1); assert.equal(sends(h).length, 0);
});

test('pauser capability supplied in the policy also gates minting controls', async () => {
  const h = await harness({ policy: { canPause: false } });
  assert.equal(h.node('pause').disabled, true); await h.client.act('pause');
  assert.equal(apiCalls(h, '/api/test/admin/action').length, 0);
});

test('matching authoritative terminal intent retires a stale recovery marker after reload', async () => {
  for (const state of ['confirmed', 'reverted', 'abandoned', 'superseded']) {
    const h = await harness({ storage: new Map([[KEY, JSON.stringify({ intentId: 'intent-old' })]]),
      status: { lastIntent: { intentId: 'intent-old', action: 'pause', state } } });
    assert.equal(h.storage.has(KEY), false); assert.equal(h.node('pending').hidden, true); assert.equal(h.node('pause').disabled, false);
    assert.equal(sends(h).length, 0); assert.equal(apiCalls(h, '/api/test/admin/report').length, 0);
  }
});

test('an unrelated terminal intent cannot retire unresolved local recovery', async () => {
  const h = await harness({ storage: new Map([[KEY, JSON.stringify({ intentId: 'intent-old' })]]),
    status: { lastIntent: { intentId: 'intent-new', action: 'pause', state: 'confirmed' },
      resolvedIntents: [{ intentId: 'intent-new', action: 'pause', state: 'confirmed' }] } });
  assert.equal(h.storage.has(KEY), true); assert.equal(h.node('pending').hidden, false); assert.equal(h.node('pause').disabled, true);
});

test('an older superseded intent retires only through its matching authoritative history entry', async () => {
  const h = await harness({ storage: new Map([[KEY, JSON.stringify({ intentId: 'intent-old' })]]),
    status: { lastIntent: { intentId: 'intent-new', action: 'pause', state: 'confirmed' },
      resolvedIntents: [{ intentId: 'intent-old', action: 'pause', state: 'superseded' },
        { intentId: 'intent-new', action: 'pause', state: 'confirmed' }] } });
  assert.equal(h.storage.has(KEY), false); assert.equal(h.node('pending').hidden, true); assert.equal(h.node('pause').disabled, false);
  assert.match(h.node('action-feedback').textContent, /superseded/);
  assert.equal(sends(h).length, 0); assert.equal(apiCalls(h, '/api/test/admin/report').length, 0);
});

test('failed cancellation of an unsent prepared intent retains recovery and never retries a send', async () => {
  const h = await harness({ transaction: { to: OTHER }, apiHook: async path => path === '/api/test/admin/cancel'
    ? { ok: false, async json() { return { error: 'Cancellation unavailable.' }; } } : undefined });
  await h.client.act('pause');
  assert.equal(sends(h).length, 0); assert.equal(h.node('pending').hidden, false); assert.equal(h.node('pause').disabled, true);
  assert.match(h.node('action-feedback').textContent, /could not be closed/);
  await h.client.act('pause'); assert.equal(apiCalls(h, '/api/test/admin/action').length, 1);
});
