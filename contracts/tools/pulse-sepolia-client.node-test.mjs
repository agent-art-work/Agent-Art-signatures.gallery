import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';
import { SEPOLIA_TEST_CLIENT } from '../../scripts/pulse-sepolia-client.mjs';
import { SEPOLIA_READ_BUDGETS } from '../../scripts/pulse-sepolia-read-budgets.mjs';
import { createSepoliaReadFailover, withSepoliaReadSource } from '../../scripts/pulse-sepolia-rpc.mjs';

const WALLET = '0x0000000000000000000000000000000000000001';
const CONTRACT = '0x0000000000000000000000000000000000000002';
const HASH = '0x' + '11'.repeat(32);
const RESULT = { handle: 'somehandle', state: 'confirming', tokenId: '123', transactionHash: HASH,
  inputDigest: '0x' + '22'.repeat(32), rendererIdentity: '0x' + '33'.repeat(32), url: '/signatures/somehandle',
  html: '<article class="signature-page" data-mint-state="confirming"><img src="/test-art/somehandle.svg"><span data-mint-state-label>Confirming</span></article>' };
const flush = () => new Promise(resolve => setImmediate(resolve));

function explorerHarness({ phase = 'prelaunch', paused = false, handle = '', storage = new Map() } = {}) {
  const nodes = new Map(), events = new Map(), calls = [], locations = [], storageReads = [];
  for (const selector of ['[data-preview-explorer]', '[data-preview-explore-form]', '[name="handle"]',
    '[data-explorer-mint-link]', '[data-explorer-mint-label]', '[data-explorer-sale-status]', '[data-explorer-mint-status]']) nodes.set(selector, element());
  nodes.get('[data-preview-explorer]').dataset = { sitePhase: phase, sitePaused: String(paused) };
  const input = nodes.get('[name="handle"]'); input.value = input.defaultValue = handle;
  input.checkValidity = () => /^@?[A-Za-z0-9_]{1,15}$/.test(input.value);
  const location = { set href(value) { locations.push(value); } };
  runInNewContext(SEPOLIA_TEST_CLIENT, {
    document: { querySelector: selector => nodes.get(selector) }, location,
    window: { ethereum: { request(request) { calls.push(request.method); throw Error('Explorer cannot use a wallet'); } },
      addEventListener(name, handler) { events.set(name, handler); }, dispatchEvent(event) { calls.push(event.type); } },
    fetch: (...args) => { calls.push(args); throw Error('Explorer cannot fetch a session or paid operation'); },
    sessionStorage: { getItem(key) { storageReads.push(key); return storage.get(key); }, setItem(key, value) { storage.set(key, value); } },
  });
  return { nodes, events, calls, locations, storage, storageReads, input,
    update(value) { input.value = value; input.handlers.input(); },
    submit() { nodes.get('[data-preview-explore-form]').handlers.submit({ preventDefault() {} }); } };
}

test('prelaunch explorer never restores wallet/session or reads a saved submission, even with malicious mint readiness', () => {
  const h = explorerHarness({ handle: 'Alice_Bob', storage: new Map([['sg-sepolia-pending', '{bad'], ['sg-sepolia-reveal', '{bad']]) });
  h.events.get('sg:readiness-changed')({ detail: { mintReady: true, saleStatus: { phase: 'prelaunch', paused: false } } });
  assert.equal(h.nodes.get('[data-explorer-mint-link]').hidden, true);
  assert.equal(h.nodes.get('[data-explorer-sale-status]').textContent, 'Minting coming soon.');
  assert.deepEqual(h.calls, []); assert.deepEqual(h.locations, []);
  assert.deepEqual(h.storageReads, ['sg-open:mint-handle-draft:v1']);
});

test('explicit explorer submit preserves handle spelling and navigates only to anonymous variations', () => {
  const h = explorerHarness({ handle: '@Alice_Bob' }); h.submit();
  assert.deepEqual(h.locations, ['/p/Alice_Bob/variations']); assert.deepEqual(h.calls, []);
  assert.equal(JSON.parse(h.storage.get('sg-open:mint-handle-draft:v1')).value, '@Alice_Bob');
});

test('invalid programmatic exploration never navigates or enters wallet/mint work', () => {
  for (const handle of ['', 'invalid-handle', 'abcdefghijklmnop', '"<script>', '@@Alice']) {
    const h = explorerHarness({ handle }); h.submit();
    assert.deepEqual(h.locations, []); assert.deepEqual(h.calls, []);
  }
});

test('explorer restores the mint handle draft without overwriting it with an empty route', () => {
  const key = 'sg-open:mint-handle-draft:v1';
  const storage = new Map([[key, JSON.stringify({ version: 1, source: '', value: 'Mint_Draft' })]]);
  const h = explorerHarness({ storage }); assert.equal(h.input.value, 'Mint_Draft');
  assert.equal(JSON.parse(storage.get(key)).value, 'Mint_Draft');
  h.update('@Another_Name'); h.submit(); assert.deepEqual(h.locations, ['/p/Another_Name/variations']);
  const refreshed = explorerHarness({ storage }); assert.equal(refreshed.input.value, '@Another_Name');
  const explicit = explorerHarness({ storage, handle: 'URL_Handle' }); assert.equal(explicit.input.value, 'URL_Handle');
  assert.equal(JSON.parse(storage.get(key)).value, 'URL_Handle');
});

test('opening from prelaunch reveals only an explicit mint link, preserving exploration without wallet prompts', () => {
  const h = explorerHarness({ handle: 'Alice_Bob' });
  for (const [phase, label] of [['free', 'Free Mint'], ['paid', 'Paid Mint']]) {
    h.events.get('sg:readiness-changed')({ detail: { mintReady: true, saleStatus: { phase, paused: false } } });
    assert.equal(h.nodes.get('[data-explorer-mint-link]').hidden, false);
    assert.equal(h.nodes.get('[data-explorer-mint-link]').attributes.href, '/mint?handle=Alice_Bob');
    assert.equal(h.nodes.get('[data-explorer-mint-label]').textContent, label);
  }
  for (const saleStatus of [{ phase: 'free', paused: true }, { phase: 'unknown', paused: false }, { phase: 'prelaunch', paused: false }]) {
    h.events.get('sg:readiness-changed')({ detail: { mintReady: true, saleStatus } });
    assert.equal(h.nodes.get('[data-explorer-mint-link]').hidden, true);
    assert.equal(h.input.value, 'Alice_Bob');
  }
  assert.deepEqual(h.calls, []); assert.deepEqual(h.locations, []);
});

test('public home and previews bind optional Grok copy without session or wallet discovery', async () => {
  const calls = [], nodes = new Map([['[data-copy-handoff]', element()], ['[data-handoff-prompt]', { value: 'Preview prompt' }], ['[data-copy-feedback]', element()]]);
  runInNewContext(SEPOLIA_TEST_CLIENT, {
    document: { querySelector: selector => nodes.get(selector) },
    window: { addEventListener() { throw Error('No public-view wallet listeners'); }, dispatchEvent() { throw Error('No wallet discovery'); } },
    fetch() { throw Error('No viewer session request'); },
    navigator: { clipboard: { async writeText(text) { calls.push(text); } } },
  });
  await nodes.get('[data-copy-handoff]').handlers.click();
  assert.deepEqual(calls, ['Preview prompt']);
  assert.equal(nodes.get('[data-copy-feedback]').textContent, 'Copied.');
});

test('About binds reading and preview copies independently without session or wallet discovery', async () => {
  const copied = [], nodes = new Map();
  for (const selector of ['[data-about-reading]', '[data-copy-about-reading]', '[data-about-reading-prompt]', '[data-about-reading-feedback]', '[data-copy-handoff]', '[data-handoff-prompt]', '[data-copy-feedback]']) nodes.set(selector, element());
  nodes.get('[data-about-reading-prompt]').value = 'Read About the work';
  nodes.get('[data-handoff-prompt]').value = 'Make a chat preview';
  runInNewContext(SEPOLIA_TEST_CLIENT, {
    document: { querySelector: selector => nodes.get(selector) },
    window: { addEventListener() { throw Error('No About wallet listeners'); }, dispatchEvent() { throw Error('No About wallet discovery'); } },
    fetch() { throw Error('No About session request'); },
    sessionStorage: { getItem() { throw Error('No About mint recovery'); } },
    navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
  });
  await nodes.get('[data-copy-about-reading]').handlers.click();
  assert.deepEqual(copied, ['Read About the work']);
  assert.equal(nodes.get('[data-about-reading-feedback]').textContent, 'Copied.');
  assert.equal(nodes.get('[data-copy-feedback]').textContent, '');
  await nodes.get('[data-copy-handoff]').handlers.click();
  assert.deepEqual(copied, ['Read About the work', 'Make a chat preview']);
  assert.equal(nodes.get('[data-copy-feedback]').textContent, 'Copied.');
});

test('prelaunch collection without wallet controls stays anonymous and does not read saved mint recovery', () => {
  const nodes = new Map([['[data-collection-page]', element()], ['[data-collection-mint-cta]', element()]]);
  runInNewContext(SEPOLIA_TEST_CLIENT, {
    document: { querySelector: selector => nodes.get(selector) },
    window: { addEventListener() { throw Error('No wallet listeners before launch'); }, dispatchEvent() { throw Error('No wallet discovery before launch'); } },
    fetch() { throw Error('No prelaunch collection session request'); },
    sessionStorage: { getItem() { throw Error('No saved mint recovery from a preview-only collection'); } },
  });
  assert.equal(nodes.get('[data-collection-page]').hidden, false);
});

test('public prelaunch wallet notice binds before viewing early return, with no provider, session or storage access', () => {
  for (const surface of ['home', 'about', 'preview', 'variations', 'collection', 'MBTI gallery']) {
    const listeners = new Map(), nodes = new Map(), calls = [];
    const summary = { focus() { calls.push('focus'); } };
    const inside = {}, outside = {};
    const notice = { open: false, dataset: {}, querySelector(selector) { return selector === 'summary' ? summary : null; },
      contains(target) { return target === summary || target === inside || target === notice; } };
    nodes.set('[data-preview-wallet-notice]', notice);
    if (surface === 'about') nodes.set('[data-about-reading]', element());
    const forbidden = () => { throw Error(`${surface}: preview wallet information must stay anonymous`); };
    runInNewContext(SEPOLIA_TEST_CLIENT, {
      document: { querySelector: selector => nodes.get(selector), addEventListener(type, listener) { listeners.set(type, listener); } },
      window: new Proxy({}, { get: forbidden }), fetch: forbidden,
      localStorage: new Proxy({}, { get: forbidden }), sessionStorage: new Proxy({}, { get: forbidden }),
    });
    assert.equal(notice.dataset.previewWalletBound, 'true');
    assert.equal(notice.open, false);
    notice.open = true;
    listeners.get('pointerdown')({ target: inside });
    assert.equal(notice.open, true);
    listeners.get('keydown')({ key: 'Escape', preventDefault() { calls.push('prevent'); } });
    assert.equal(notice.open, false);
    assert.deepEqual(calls, ['focus', 'prevent']);
    notice.open = true;
    listeners.get('pointerdown')({ target: outside });
    assert.equal(notice.open, false);
    assert.deepEqual(calls, ['focus', 'prevent']);
  }
});

function element(tag = 'p') {
  let text = '', children = [];
  const node = { tag, handlers: {}, dataset: {}, attributes: {}, hidden: false, className: '', disabled: false, value: '',
    addEventListener(type, fn) { this.handlers[type] = fn; }, setAttribute(k, v) { this.attributes[k] = v; },
    get textContent() { return children.length ? children.map(child => child.textContent).join('') : text; },
    set textContent(value) { children = []; text = value; },
    removeChild(child) { children = children.filter(value => value !== child); child.parentNode = null; return child; },
    insertBefore(child, before) {
      child.parentNode?.removeChild(child);
      const index = before ? children.indexOf(before) : -1;
      children.splice(index < 0 ? children.length : index, 0, child);
      child.parentNode = this; return child;
    },
    appendChild(child) { return this.insertBefore(child, null); },
    replaceChildren(...nodes) { for (const child of children) child.parentNode = null; children = []; text = ''; for (const child of nodes) this.appendChild(child); },
    ownerDocument: { createElement: element, createTextNode(value) { const child = element('#text'); child.textContent = value; return child; } },
    classList: {
      add(...names) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove(...names) { node.className = node.className.split(/\s+/).filter(name => name && !names.includes(name)).join(' '); },
    },
    get children() { return children; },
  };
  return node;
}

function assertWarning(node, message) {
  assert.match(node.className, /\bopen-preview-warning\b/);
  assert.equal(node.children[0].className, 'open-preview-notice-label');
  assert.equal(node.children[0].textContent, 'Warning');
  assert.equal(node.children[2].tag, 'span');
  assert.equal(node.children[2].textContent, message);
  assert.equal(node.textContent, 'Warning ' + message);
}

async function harness({ alteredPlan, rejectSend = false, sendError, restoredWallet = false, challengeError, challengeGate, optionsError, announceRabby = false,
  missingProvider = false, walletState = { accounts: [WALLET], chainId: '0xaa36a7' }, accountsGate, walletReadError, optionsGate, accountEventOnGrant = false,
  prepareGate, prepareError, beginGate, sendGate, reportGate, recoveryGate, recoveryError, recoveryValue, initialOptions, maximumETH = '0.0001', initialPhase = 'paid',
  storage = new Map(), storageFault, fetchOverride, initialHandle = 'SomeHandle', status = RESULT, statusError, reportError,
  surface = 'entry', initialWarning = '', sessionError, readBudgets = SEPOLIA_READ_BUDGETS, realTimers = false } = {}) {
  const calls = [], nodes = new Map(), locations = [], timers = [], statusResponses = [], optionsResponses = [], optionsSignals = [];
  const recoveryResponses = [], recoveryBodies = [], recoverySignals = [], reportMarkers = [], storageOperations = [];
  let now = 1000000;
  let serverWallet = restoredWallet ? WALLET : undefined;
  let mintStatus = status, mintStatusError = statusError, mintOptionsError = optionsError;
  const selectors = ['[data-request-feedback]', '[data-mint-feedback]', '[data-wallet-label]', '[data-connect-wallet]', '[data-request-submit]',
    '[data-assessment-request]', '[data-mint-entry]', '[data-pulse-feedback]', '[data-pulse-sale-status]', '[data-pulse-check]', '[name="handle"]', '[name="pulse-max-eth"]',
    '[data-pulse-options]', '[data-pulse-title]', '[data-pulse-paid]', '[data-pulse-free]', '[data-pulse-refresh]', '[name="pulse-mode"]',
    '[data-mint-result]', '[data-mint-result-artwork]', '[data-mint-result-link]', '[data-mint-result-feedback]', '[data-mint-another]',
    '[data-mint-state-label]', '[data-mint-result] [data-mint-state-label]', '.signature-page',
    '[data-mint-observation-warning]', '[data-mint-observation-message]', '[data-mint-action-notice]', '[data-mint-result-notice]',
    '[data-mint-recovery]', '[data-mint-recovery-handle]', '[data-mint-recovery-check]', '[data-mint-recovery-transaction]',
    '[name="mint-recovery-hash"]', '[data-mint-recovery-feedback]', '[data-mint-retry-note]'];
  for (const key of selectors) nodes.set(key, element());
  nodes.get('[data-mint-result]').hidden = true;
  nodes.get('[data-mint-observation-warning]').hidden = true;
  nodes.get('[data-mint-recovery]').hidden = true;
  nodes.get('[data-mint-retry-note]').hidden = true;
  nodes.get('[data-assessment-request]').appendChild(nodes.get('[data-mint-action-notice]'));
  nodes.get('[data-mint-action-notice]').appendChild(nodes.get('[data-mint-observation-warning]'));
  nodes.get('[data-mint-action-notice]').appendChild(nodes.get('[data-request-feedback]'));
  nodes.get('[data-mint-result]').appendChild(nodes.get('[data-mint-result-notice]'));
  nodes.set('[data-mint-result] [data-mint-state-label]', nodes.get('[data-mint-state-label]'));
  // Model the DOM's destructive textContent setter: button styling lives on
  // its child span, not the button itself. The old flat mock missed this bug.
  for (const [selector, initialLabel] of [['[data-connect-wallet]', 'Connect wallet'], ['[data-pulse-check]', 'Refresh price'],
    ['[data-mint-recovery-check]', 'Check previous mint'], ['[data-mint-recovery-transaction]', 'Check transaction']]) {
    const button = nodes.get(selector), label = { textContent: initialLabel };
    nodes.set(selector + ' > span', label);
    Object.defineProperty(button, 'textContent', {
      get: () => nodes.has(selector + ' > span') ? label.textContent : button.unstyledText,
      set: text => { nodes.delete(selector + ' > span'); button.unstyledText = text; },
    });
  }
  nodes.get('[name="handle"]').value = initialHandle;
  nodes.set('[data-mint-preview]', { attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; } });
  nodes.get('[name="pulse-max-eth"]').value = maximumETH;
  nodes.get('[data-pulse-options]').dataset.pulsePhase = initialPhase;
  if (surface === 'collection') {
    for (const selector of selectors) if (!['[data-mint-feedback]', '[data-wallet-label]', '[data-connect-wallet]', '[data-mint-observation-warning]', '[data-mint-observation-message]'].includes(selector)) nodes.delete(selector);
    nodes.delete('[data-pulse-check] > span'); nodes.delete('[data-mint-preview]'); nodes.set('[data-collection-page]', element());
  } else if (surface !== 'entry') {
    // Detail pages have a reveal monitor but no mint form/result/wallet UI.
    // Keep a legacy notice mount to prove the client scopes its own writes,
    // not merely that new server templates omitted the mount.
    for (const selector of selectors) {
      if (!['.signature-page', '[data-mint-state-label]', '[data-mint-observation-warning]', '[data-mint-observation-message]'].includes(selector)) nodes.delete(selector);
    }
    nodes.delete('[data-connect-wallet] > span'); nodes.delete('[data-pulse-check] > span'); nodes.delete('[data-mint-preview]');
    const article = nodes.get('.signature-page');
    article.dataset = { revealHandle: RESULT.handle, mintState: status.state,
      revealToken: RESULT.tokenId, revealInput: RESULT.inputDigest, revealRenderer: RESULT.rendererIdentity };
    article.outerHTML = status.html;
    nodes.get('[data-mint-state-label]').textContent = status.state === 'minted' ? 'Minted' : 'Confirming';
    nodes.set('[data-reveal-monitor]', article);
    nodes.set('[data-reveal-feedback]', element());
    if (surface === 'process-result') nodes.set('[data-mint-process]', { dataset: {} });
  }
  nodes.get('[data-mint-observation-warning]').hidden = !initialWarning;
  nodes.get('[data-mint-observation-message]').textContent = initialWarning;
  for (const node of nodes.values()) if (node.ownerDocument) node.ownerDocument.querySelector = selector => nodes.get(selector);
  const walletEvents = new Map();
  const provider = { on: (name, fn) => walletEvents.set(name, fn), removeListener: name => walletEvents.delete(name), request: async ({ method }) => {
    calls.push(method);
    if (method === 'eth_chainId') return walletState.chainId;
    if (method === 'eth_accounts') { if (accountsGate) await accountsGate; if (walletReadError) throw Error(walletReadError); return walletState.accounts; }
    if (method === 'eth_requestAccounts') { if (accountEventOnGrant) walletEvents.get('accountsChanged')?.(walletState.accounts); return walletState.accounts; }
    if (method === 'personal_sign') return 'test-signature';
    if (method === 'eth_sendTransaction') { if (sendGate) await sendGate; if (sendError) throw sendError; if (rejectSend) throw Error('Unknown delivery'); return HASH; }
    throw Error('Unexpected wallet method');
  } };
  const fetch = async (path, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined; calls.push(path);
    if (fetchOverride) {
      const response = await fetchOverride(path, options);
      if (response !== undefined) return response;
    }
    if (path === '/api/test/recover') {
      recoveryBodies.push(body); recoverySignals.push(options.signal);
      const queued = recoveryResponses.shift(), gate = queued?.gate || recoveryGate;
      if (gate) await Promise.race([gate, new Promise((_, reject) => {
        if (options.signal?.aborted) reject(Error('Request aborted'));
        else options.signal?.addEventListener('abort', () => reject(Error('Request aborted')), { once: true });
      })]);
      if (queued?.error || recoveryError) return { ok: false, json: async () => ({ error: queued?.error || recoveryError }) };
      return { ok: true, json: async () => queued?.value || recoveryValue || mintStatus };
    }
    if (path === '/api/test/challenge' && challengeGate) await Promise.race([challengeGate, new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(Error('Request aborted')), { once: true });
    })]);
    if (path === '/api/test/challenge' && challengeError) return { ok: false, json: async () => ({ error: challengeError }) };
    if (path === '/api/test/options') {
      const queued = optionsResponses.shift(), gate = queued?.gate || optionsGate;
      optionsSignals.push(options.signal);
      if (gate) await Promise.race([gate, new Promise((_, reject) => {
        if (options.signal?.aborted) reject(Error('Request aborted'));
        else options.signal?.addEventListener('abort', () => reject(Error('Request aborted')), { once: true });
      })]);
      if (queued) return { ok: true, json: async () => queued.value };
    }
    if (path === '/api/test/prepare' && prepareGate) await prepareGate;
    if (path === '/api/test/begin' && beginGate) await beginGate;
    if (path === '/api/test/prepare' && prepareError) return { ok: false, json: async () => prepareError };
    if (path === '/api/test/report') { reportMarkers.push(storage.get('sg-sepolia-pending')); if (reportGate) await reportGate; }
    if (path === '/api/test/session' && sessionError) return { ok: false, json: async () => ({ error: sessionError }) };
    if (path === '/api/test/options' && mintOptionsError) return { ok: false, json: async () => ({ error: mintOptionsError }) };
    if (path.startsWith('/api/test/status?') && statusResponses.length) {
      const queued = statusResponses.shift(); if (queued.gate) await queued.gate;
      return { ok: true, json: async () => queued.value };
    }
    if (path.startsWith('/api/test/status?') && mintStatusError) return { ok: false,
      json: async () => typeof mintStatusError === 'string' ? { error: mintStatusError } : mintStatusError };
    if (path === '/api/test/report' && reportError) return { ok: false, json: async () => ({ error: reportError }) };
    const result = path === '/api/test/session' ? { csrf: 'csrf', ...(serverWallet ? { wallet: serverWallet } : {}) }
      : path === '/api/test/challenge' ? { challengeId: 'challenge', message: 'Local proof' }
      : path === '/api/test/verify' ? { wallet: walletState.accounts[0] }
      : path === '/api/test/options' ? initialOptions || { phase: 'paid', paid: true, free: false, priceETH: '0.000001', saleNotice: 'Free mint ended · 2/2 slots used.' }
      : path === '/api/test/prepare' ? { code: 'code', handle: 'somehandle', transaction: { chainId: '0xaa36a7', from: WALLET, to: CONTRACT, ...alteredPlan } }
      : path.startsWith('/api/test/status?') ? mintStatus : { saved: true };
    if (path === '/api/test/prepare') assert.deepEqual(body, { handle: 'SomeHandle', mode: initialOptions?.phase || 'paid', maximumETH: initialOptions?.phase === 'free' ? '0' : maximumETH });
    if (path === '/api/test/report') assert.deepEqual(body, { code: 'code', transactionHash: HASH });
    return { ok: true, json: async () => result };
  };
  const windowEvents = new Map();
  runInNewContext(SEPOLIA_TEST_CLIENT.replace(JSON.stringify(SEPOLIA_READ_BUDGETS), JSON.stringify(readBudgets)), {
    document: { querySelector: selector => nodes.get(selector), body: { dataset: { contract: CONTRACT } } },
    window: { ethereum: missingProvider ? undefined : announceRabby ? { request: () => { throw Error('Wrong extension selected'); } } : provider,
      addEventListener(name, fn) { windowEvents.set(name, fn); },
      dispatchEvent() { if (announceRabby) windowEvents.get('eip6963:announceProvider')({ detail: { provider, info: { rdns: 'io.rabby' } } }); } }, Event: class {}, TextEncoder,
    sessionStorage: {
      getItem: key => { storageFault?.({ operation: 'get', key }); return storage.get(key); },
      setItem: (key, value) => { storageOperations.push({ operation: 'set', key, value }); storageFault?.({ operation: 'set', key, value }); storage.set(key, value); },
      removeItem: key => { storageOperations.push({ operation: 'remove', key }); storageFault?.({ operation: 'remove', key }); storage.delete(key); },
    },
    location: { assign: value => locations.push(value), reload: () => locations.push('reload') },
    Date: class extends Date { static now() { return now; } },
    fetch, AbortController, setTimeout(fn, ms) {
      const timer = { fn, ms }; timers.push(timer);
      if (realTimers) timer.native = setTimeout(fn, ms);
      return timer;
    }, clearTimeout(timer) { if (timer) { timer.cleared = true; if (realTimers) clearTimeout(timer.native); } },
  });
  await flush();
  return { calls, nodes, storage, locations, walletEvents, windowEvents, timers, optionsSignals, recoveryBodies, recoverySignals, reportMarkers, storageOperations,
    queueStatus: (value, gate) => statusResponses.push({ value, gate }),
    queueOptions: (value, gate) => optionsResponses.push({ value, gate }),
    queueRecovery: (value, gate, error) => recoveryResponses.push({ value, gate, error }),
    tickStatus: async (elapsed = 5000) => { now += elapsed; timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush(); },
    setServerWallet: value => { serverWallet = value; },
    setOptionsError: value => { mintOptionsError = value; },
    setOptionsGate: value => { optionsGate = value; },
    setStorageFault: value => { storageFault = value; },
    setFetchOverride: value => { fetchOverride = value; },
    advanceTime: elapsed => { now += elapsed; },
    setStatus: value => { mintStatus = value; }, setStatusError: value => { mintStatusError = value; },
    announce: () => windowEvents.get('eip6963:announceProvider')({ detail: { provider, info: { rdns: 'io.rabby' } } }),
    connect: async () => { nodes.get('[data-connect-wallet]').handlers.click(); await flush(); },
    mint: () => nodes.get('[data-assessment-request]').handlers.submit({ preventDefault() {} }),
  };
}

test('a slow primary reaches the browser through HTTP fallback before the shared action deadline', async () => {
  // Scale only elapsed time. Exercise real HTTP requests, abort signals and the
  // serialized visitor client, with no external RPC or wallet effects.
  const scale = 0.02;
  const budgets = Object.fromEntries(Object.entries(SEPOLIA_READ_BUDGETS).map(([key, value]) => [key, value * scale]));
  const rpcCalls = [], statusSignals = [];
  let origin, context, h;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, origin).pathname;
    if (path.startsWith('/rpc/')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const { method } = JSON.parse(raw), source = path.split('/').at(-1);
      rpcCalls.push([source, method]);
      // Primary stays silent until its fetch is actually aborted by the
      // source deadline; secondary independently verifies the right chain.
      if (source === 'primary') return;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ result: method === 'eth_chainId' ? '0xaa36a7' : RESULT }));
    }
    if (path === '/api/test/status') {
      try {
        const value = await withSepoliaReadSource(context, source => source.rpc('eth_getTransactionReceipt', [HASH]),
          { signal: AbortSignal.timeout(budgets.semanticMs) });
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Status unavailable', code: 'MINT_STATUS_UNAVAILABLE' }));
      }
      return;
    }
    res.writeHead(404); res.end();
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = 'http://127.0.0.1:' + server.address().port;
    const rpc = source => async (method, params, options) => {
      const response = await fetch(origin + '/rpc/' + source, { method: 'POST', body: JSON.stringify({ method, params }), signal: options.signal });
      return (await response.json()).result;
    };
    context = createSepoliaReadFailover({ rpc: rpc('primary'), second: rpc('secondary') }, async source => {
      assert.equal(await source.rpc('eth_chainId'), '0xaa36a7');
    }, { attemptTimeoutMs: budgets.sourceMs, backgroundAttemptTimeoutMs: budgets.backgroundSourceMs });
    const marker = JSON.stringify({ version: 1, handle: 'somehandle', wallet: WALLET, chainId: 11155111, contract: CONTRACT });
    h = await harness({ restoredWallet: true, storage: new Map([['sg-sepolia-pending', marker]]), readBudgets: budgets, realTimers: true,
      fetchOverride: (path, options) => {
        if (!path.startsWith('/api/test/status?')) return undefined;
        statusSignals.push(options.signal); return fetch(origin + path, options);
      } });
    assert.equal(h.nodes.get('[data-mint-result]').hidden, true, 'A hash/slow source alone does not reveal');
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true, 'Normal loading does not manufacture a warning');
    const deadline = Date.now() + 2000;
    while (h.nodes.get('[data-mint-result]').hidden && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.nodes.get('[data-mint-result]').hidden, false);
    assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, RESULT.html);
    assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Confirming');
    assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
    assert.equal(context.readStatus().activeSource, 'secondary');
    assert.deepEqual(rpcCalls, [['primary', 'eth_chainId'], ['secondary', 'eth_chainId'], ['secondary', 'eth_getTransactionReceipt']]);
    assert.equal(statusSignals.length, 1); assert.equal(statusSignals[0].aborted, false);
    assert.equal(h.timers.filter(timer => timer.ms === budgets.browserMs && !timer.cleared).length, 0);
    assert.equal(h.calls.filter(call => typeof call === 'string' && call.startsWith('/api/test/status?')).length, 1);
    for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  } finally {
    h?.windowEvents.get('pagehide')?.();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('browser timeout bounds an uncooperative status fetch and discards its late response', async () => {
  const marker = JSON.stringify({ version: 1, handle: 'somehandle', wallet: WALLET, chainId: 11155111, contract: CONTRACT });
  let release, signal;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ restoredWallet: true, storage: new Map([['sg-sepolia-pending', marker]]),
    fetchOverride: async (path, options) => {
      if (!path.startsWith('/api/test/status?')) return undefined;
      signal = options.signal; await gate;
      return { ok: true, json: async () => RESULT };
    } });
  const timeout = h.timers.find(timer => timer.ms === SEPOLIA_READ_BUDGETS.browserMs && !timer.cleared);
  assert.ok(timeout); assert.equal(h.timers.some(timer => timer.ms === 12000), false);
  timeout.fn(); await flush();
  assert.equal(signal.aborted, true); assert.equal(timeout.cleared, true);
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
  release(); await flush();
  assert.equal(h.nodes.get('[data-mint-result]').hidden, true, 'Late timed-out inclusion cannot mutate the current document');
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
  for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('browser timeout also covers an uncooperative JSON body and cleans its abort listener', async () => {
  let release, responseSignal, removedListeners = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ restoredWallet: true,
    fetchOverride: (path, options) => {
      if (path !== '/api/test/options') return undefined;
      responseSignal = options.signal;
      const remove = responseSignal.removeEventListener.bind(responseSignal);
      // The API attached its listener before fetch; verify its explicit
      // cleanup without changing dispatch or abort semantics.
      responseSignal.removeEventListener = (name, listener, opts) => { if (name === 'abort') removedListeners++; return remove(name, listener, opts); };
      return { ok: true, json: async () => { await gate; return { phase: 'paid', paid: true, free: false, priceETH: '0.000001' }; } };
    } });
  const timeout = h.timers.find(timer => timer.ms === SEPOLIA_READ_BUDGETS.browserMs && !timer.cleared);
  assert.ok(timeout); timeout.fn(); await flush();
  assert.equal(responseSignal.aborted, true); assert.equal(timeout.cleared, true); assert.equal(removedListeners, 1);
  assertWarning(h.nodes.get('[data-pulse-feedback]'), 'Price could not be checked right now. Please try again.');
  assert.equal(h.nodes.get('[data-pulse-check]').disabled, false);
  release(); await flush();
  assertWarning(h.nodes.get('[data-pulse-feedback]'), 'Price could not be checked right now. Please try again.');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('an invalid handle blocks programmatic submission before wallet or request work', async () => {
  const h = await harness({ restoredWallet: true });
  const field = h.nodes.get('[name="handle"]');
  field.value = '';
  field.checkValidity = () => false;
  const before = h.calls.length;
  await h.mint();
  assert.deepEqual(h.calls.slice(before), []);
  assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
});

test('wallet failure and recovery use the shared warning style without styling normal progress', async () => {
  const absent = await harness({ missingProvider: true });
  await absent.connect();
  assertWarning(absent.nodes.get('[data-mint-feedback]'), 'Open this page in a browser with an Ethereum wallet connected to Sepolia.');
  assert.deepEqual(absent.calls, ['/api/test/session']);
  const h = await harness({ restoredWallet: true });
  const feedback = h.nodes.get('[data-mint-feedback]');
  assert.doesNotMatch(feedback.className, /open-preview-warning/);
  h.walletEvents.get('accountsChanged')([]);
  assertWarning(feedback, 'Wallet changed. Connect it again.');
  await h.connect();
  assert.doesNotMatch(feedback.className, /open-preview-warning|open-preview-notice/);
  assert.equal(feedback.textContent, 'Wallet connected.');
  assert.equal(feedback.children.length, 0);
  assert.ok(!h.calls.includes('/api/test/prepare'));
  assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('price retry clears its own warning without hiding wallet feedback or submitting a mint', async () => {
  const h = await harness({ restoredWallet: true, optionsError: 'Mint availability cannot be checked right now. Please try again shortly.' });
  const price = h.nodes.get('[data-pulse-feedback]');
  assertWarning(price, 'Mint availability cannot be checked right now. Please try again shortly.');
  h.setOptionsError(undefined);
  await h.nodes.get('[data-pulse-check]').handlers.click();
  assert.match(price.textContent, /Current Pulse price:/);
  assert.doesNotMatch(price.className, /open-preview-warning|open-preview-notice/);
  assert.equal(price.dataset.inlineWarningMessage, undefined);
  assert.equal(h.nodes.get('[data-mint-feedback]').textContent, 'Wallet connected.');
  for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/prepare', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('checking price immediately shows progress, preserves its styled span and coalesces same-wallet requests', async () => {
  const h = await harness({ restoredWallet: true });
  const price = h.nodes.get('[data-pulse-feedback]'), button = h.nodes.get('[data-pulse-check]');
  const label = h.nodes.get('[data-pulse-check] > span'), walletFeedback = h.nodes.get('[data-mint-feedback]').textContent;
  const before = h.calls.filter(call => call === '/api/test/options').length;
  let release; h.setOptionsGate(new Promise(resolve => { release = resolve; }));
  const first = button.handlers.click(), second = button.handlers.click();
  assert.equal(price.textContent, 'Checking price…');
  assert.equal(button.disabled, true);
  assert.equal(label.textContent, 'Checking price…');
  assert.equal(h.nodes.get('[data-pulse-check] > span'), label);
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.nodes.get('[data-mint-feedback]').textContent, walletFeedback);
  assert.equal(h.calls.filter(call => call === '/api/test/options').length, before + 1);
  release(); await Promise.all([first, second]); await flush();
  assert.match(price.textContent, /Current Pulse price:/);
  assert.equal(button.disabled, false);
  assert.equal(label.textContent, 'Refresh price');
  assert.equal(h.nodes.get('[data-pulse-check] > span'), label);
  assert.equal(h.nodes.get('[data-mint-feedback]').textContent, walletFeedback);
  for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('a price timeout releases its button and can be retried while keeping unknown-submission recovery intact', async () => {
  const marker = JSON.stringify({ version: 1, handle: 'somehandle', wallet: WALLET, chainId: 11155111, contract: CONTRACT });
  const h = await harness({ restoredWallet: true, storage: new Map([['sg-sepolia-pending', marker]]),
    status: { handle: 'somehandle', state: 'submission-unknown', submissionStage: 'begun' } });
  const warning = h.nodes.get('[data-mint-observation-warning]'), message = h.nodes.get('[data-mint-observation-message]').textContent;
  const walletFeedback = h.nodes.get('[data-mint-feedback]').textContent, requestFeedback = h.nodes.get('[data-request-feedback]').textContent;
  h.setOptionsGate(new Promise(() => {}));
  const request = h.nodes.get('[data-pulse-check]').handlers.click();
  assert.equal(h.nodes.get('[data-pulse-feedback]').textContent, 'Checking price…');
  const timer = h.timers.find(t => t.ms === SEPOLIA_READ_BUDGETS.browserMs && !t.cleared); assert.ok(timer);
  const signal = h.optionsSignals.at(-1); assert.ok(signal);
  timer.fn(); await request; await flush();
  assert.equal(signal.aborted, true);
  assertWarning(h.nodes.get('[data-pulse-feedback]'), 'Price could not be checked right now. Please try again.');
  assert.equal(h.nodes.get('[data-pulse-check]').disabled, false);
  assert.equal(h.nodes.get('[data-pulse-check] > span').textContent, 'Refresh price');
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[data-mint-feedback]').textContent, walletFeedback);
  assert.equal(h.nodes.get('[data-request-feedback]').textContent, requestFeedback);
  assert.equal(warning.hidden, false);
  assert.equal(warning.dataset.noticeOwner, 'mint-confirmation');
  assert.equal(h.nodes.get('[data-mint-observation-message]').textContent, message);
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
  h.setOptionsGate(undefined); await h.nodes.get('[data-pulse-check]').handlers.click(); await flush();
  assert.match(h.nodes.get('[data-pulse-feedback]').textContent, /Current Pulse price:/);
  assert.doesNotMatch(h.nodes.get('[data-pulse-feedback]').className, /open-preview-warning/);
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('checking price without a wallet gives explicit feedback and leaves wallet and mint controls usable', async () => {
  const h = await harness();
  await h.nodes.get('[data-pulse-check]').handlers.click();
  assertWarning(h.nodes.get('[data-pulse-feedback]'), 'Connect your wallet first.');
  assert.equal(h.nodes.get('[data-pulse-check]').disabled, false);
  assert.equal(h.nodes.get('[data-pulse-check] > span').textContent, 'Refresh price');
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.deepEqual(h.calls, ['/api/test/session']);
});

test('a late old-wallet quote cannot overwrite a new-wallet quote or release its loading button', async () => {
  const walletState = { accounts: [WALLET], chainId: '0xaa36a7' };
  const h = await harness({ restoredWallet: true, walletState });
  let releaseOld, releaseNew;
  h.queueOptions({ paid: false, free: true, saleNotice: 'Old wallet free slot' }, new Promise(resolve => { releaseOld = resolve; }));
  const oldRequest = h.nodes.get('[data-pulse-check]').handlers.click();
  walletState.accounts = [CONTRACT]; h.walletEvents.get('accountsChanged')([CONTRACT]);
  h.queueOptions({ paid: true, free: false, priceETH: '0.000123', saleNotice: 'New wallet price' }, new Promise(resolve => { releaseNew = resolve; }));
  await h.connect();
  assert.equal(h.nodes.get('[data-wallet-label]').textContent, CONTRACT);
  assert.equal(h.nodes.get('[data-pulse-check]').disabled, true);
  releaseOld(); await oldRequest; await flush();
  assert.equal(h.nodes.get('[data-pulse-feedback]').textContent, 'Checking price…');
  assert.equal(h.nodes.get('[data-pulse-check] > span').textContent, 'Checking price…');
  assert.equal(h.nodes.get('[data-pulse-check]').disabled, true);
  assert.notEqual(h.nodes.get('[data-pulse-sale-status]').textContent, 'Old wallet free slot');
  releaseNew(); await flush();
  assert.equal(h.nodes.get('[data-pulse-sale-status]').textContent, 'New wallet price');
  assert.match(h.nodes.get('[data-pulse-feedback]').textContent, /0\.000123 Sepolia ETH/);
  assert.equal(h.nodes.get('[name="pulse-mode"]').value, 'paid');
  assert.equal(h.nodes.get('[data-pulse-free]').hidden, true);
  assert.equal(h.nodes.get('[data-pulse-paid]').hidden, false);
  assert.equal(h.nodes.get('[data-pulse-check]').disabled, false);
  assert.equal(h.nodes.get('[data-pulse-check] > span').textContent, 'Refresh price');
  assert.ok(!h.calls.includes('/api/test/prepare')); assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('identical admission failure uses only the already visible shared network warning', async () => {
  const message = 'Mint availability cannot be checked right now. Please try again shortly.';
  const h = await harness({ restoredWallet: true, optionsError: message, initialWarning: message });
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, false);
  assert.equal(h.nodes.get('[data-pulse-feedback]').textContent, '');
  assert.doesNotMatch(h.nodes.get('[data-pulse-feedback]').className, /open-preview-warning/);
  assert.equal(h.nodes.get('[data-mint-feedback]').textContent, 'Wallet connected.');
});

test('passive collection session outages stay quiet but an explicit connect failure is styled', async () => {
  const h = await harness({ surface: 'collection', sessionError: 'Sign-in could not be initialized.' });
  const feedback = h.nodes.get('[data-mint-feedback]');
  assert.equal(feedback.textContent, '');
  assert.doesNotMatch(feedback.className, /open-preview-warning/);
  await h.connect();
  assertWarning(feedback, 'Sign-in could not be initialized. Refresh the page and try again.');
  assert.deepEqual(h.calls, ['/api/test/session']);
});

test('brief pending read failures stay neutral; sustained failures produce one transaction-specific CTA warning', async () => {
  const h = await harness({ statusError: 'Mint status could not be checked right now.' });
  await h.connect(); await h.mint();
  const feedback = h.nodes.get('[data-request-feedback]');
  assert.doesNotMatch(feedback.className, /open-preview-warning/);
  assert.match(feedback.textContent, /Checking your mint transaction again/);
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
  await h.tickStatus(); await h.tickStatus();
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
  await h.tickStatus();
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, false);
  assert.equal(h.nodes.get('[data-mint-observation-warning]').dataset.noticeOwner, 'mint-confirmation');
  assert.equal(h.nodes.get('[data-mint-observation-message]').textContent, 'Mint transaction status could not be checked. Check your wallet activity before trying again.');
  assert.doesNotMatch(h.nodes.get('[data-mint-observation-message]').textContent, /Mint availability|Checking again; do not submit another mint/);
  assert.doesNotMatch(feedback.className, /open-preview-warning/);
  h.setStatusError(undefined); h.setStatus({ handle: 'somehandle', state: 'pending', transactionHash: HASH });
  await h.tickStatus();
  assert.equal(feedback.textContent, 'Transaction submitted. Waiting for verified Sepolia inclusion…');
  assert.doesNotMatch(feedback.className, /open-preview-warning|open-preview-notice/);
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
  assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
  assert.equal(h.calls.filter(c => c === 'eth_sendTransaction').length, 1);
});

test('capability outage and automatic read recovery preserve wallet/input/consent without signing or submitting', async () => {
  const h = await harness({ restoredWallet: true }); const start = h.calls.length;
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: false } }); await flush();
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[name="handle"]').value, 'SomeHandle');
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true } }); await flush();
  assert.equal(h.nodes.get('[name="handle"]').value, 'SomeHandle');
  assert.equal(h.nodes.get('[name="pulse-max-eth"]').value, '0.0001');
  assert.ok(h.calls.slice(start).every(method => ['eth_accounts', 'eth_chainId', '/api/test/session', '/api/test/options'].includes(method)));
  assert.ok(!h.calls.includes('personal_sign')); assert.ok(!h.calls.includes('/api/test/prepare')); assert.ok(!h.calls.includes('eth_sendTransaction'));
});

const freeOptions = (eligible = true) => ({ phase: 'free', free: eligible, paid: false,
  saleStatus: { phase: 'free', paused: false, freeMinted: 1, freeMintQuota: 4 }, saleNotice: 'Free mint open · 1/4 slots used.' });
const paidOptions = () => ({ phase: 'paid', free: false, paid: true, priceETH: '0.000001',
  saleStatus: { phase: 'paid', paused: false, freeMinted: 4, freeMintQuota: 4 }, saleNotice: 'Free mint ended · 4/4 slots used.' });

test('restored eligible wallet automatically selects the free phase without payment controls, price defaults or mint requests', async () => {
  const h = await harness({ restoredWallet: true, initialOptions: freeOptions(), initialPhase: 'free', maximumETH: '' });
  assert.equal(h.nodes.get('[data-pulse-options]').dataset.pulsePhase, 'free');
  assert.equal(h.nodes.get('[data-pulse-title]').textContent, 'Free Mint');
  assert.equal(h.nodes.get('[data-pulse-free]').hidden, false);
  assert.equal(h.nodes.get('[data-pulse-paid]').hidden, true);
  assert.equal(h.nodes.get('[data-pulse-check]').hidden, true);
  assert.equal(h.nodes.get('[data-pulse-refresh]').hidden, true);
  assert.equal(h.nodes.get('[name="pulse-mode"]').value, 'free');
  assert.equal(h.nodes.get('[name="pulse-max-eth"]').value, '');
  assert.equal(h.nodes.get('[name="pulse-max-eth"]').disabled, true);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.calls.filter(call => call === '/api/test/options').length, 1);
  assert.match(h.nodes.get('[data-pulse-feedback]').textContent, /unused free mint slot/);
  for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  await h.mint();
  assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1, 'Only an explicit submit may mint the selected free slot');
});

test('free phase wallet without a slot sees eligibility explanation, never a paid choice or an enabled mint', async () => {
  const h = await harness({ restoredWallet: true, initialOptions: freeOptions(false), initialPhase: 'free' });
  assert.equal(h.nodes.get('[data-pulse-title]').textContent, 'Free Mint');
  assert.equal(h.nodes.get('[data-pulse-paid]').hidden, true);
  assert.equal(h.nodes.get('[data-pulse-free]').hidden, false);
  assert.equal(h.nodes.get('[name="pulse-mode"]').value, '');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.match(h.nodes.get('[data-pulse-feedback]').textContent, /This wallet has no available free mint slot/);
  assert.doesNotMatch(h.nodes.get('[data-pulse-feedback]').className, /open-preview-warning/);
  await h.mint();
  for (const forbidden of ['/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('public phase updates display the free phase before sign-in without authorizing minting or checking wallet eligibility', async () => {
  const h = await harness({ initialPhase: 'unknown' });
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true, saleStatus: freeOptions().saleStatus } });
  await flush();
  assert.equal(h.nodes.get('[data-pulse-title]').textContent, 'Free Mint');
  assert.equal(h.nodes.get('[data-pulse-sale-status]').textContent, 'Free mint open · 1/4 slots used.');
  assert.equal(h.nodes.get('[data-pulse-paid]').hidden, true);
  assert.equal(h.nodes.get('[name="pulse-mode"]').value, '');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.deepEqual(h.calls, ['/api/test/session']);
});

test('an observed free-to-paid transition rejects late same-wallet free quotes and preserves an empty explicit ceiling', async () => {
  const h = await harness({ restoredWallet: true, initialOptions: freeOptions(), initialPhase: 'free', maximumETH: '' });
  let releaseFree, releasePaid;
  h.queueOptions(freeOptions(), new Promise(resolve => { releaseFree = resolve; }));
  const oldQuote = h.nodes.get('[data-pulse-check]').handlers.click();
  h.queueOptions(paidOptions(), new Promise(resolve => { releasePaid = resolve; }));
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true, saleStatus: paidOptions().saleStatus } });
  assert.equal(h.nodes.get('[data-pulse-options]').dataset.pulsePhase, 'paid');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[name="pulse-mode"]').value, '');
  releaseFree(); await oldQuote;
  assert.equal(h.nodes.get('[data-pulse-options]').dataset.pulsePhase, 'paid');
  assert.equal(h.nodes.get('[data-pulse-check]').disabled, true, 'A stale free quote cannot release the newer paid read');
  releasePaid(); await flush();
  assert.equal(h.nodes.get('[data-pulse-title]').textContent, 'Mint price');
  assert.equal(h.nodes.get('[data-pulse-paid]').hidden, false);
  assert.equal(h.nodes.get('[data-pulse-free]').hidden, true);
  assert.equal(h.nodes.get('[data-pulse-refresh]').hidden, false);
  assert.equal(h.nodes.get('[name="pulse-mode"]').value, 'paid');
  assert.equal(h.nodes.get('[name="pulse-max-eth"]').disabled, false);
  assert.equal(h.nodes.get('[name="pulse-max-eth"]').value, '', 'Entering the paid phase cannot invent spending consent');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true, 'Paid mint needs an explicit valid ceiling');
  h.nodes.get('[name="pulse-max-eth"]').value = '0.0001';
  h.nodes.get('[name="pulse-max-eth"]').handlers.input();
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('paused public phase invalidates eligibility without switching to paid or allowing a stale quote to reopen minting', async () => {
  const h = await harness({ restoredWallet: true, initialOptions: freeOptions(), initialPhase: 'free' });
  let release;
  h.queueOptions(freeOptions(), new Promise(resolve => { release = resolve; }));
  const quote = h.nodes.get('[data-pulse-check]').handlers.click();
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: false, saleStatus: { ...freeOptions().saleStatus, paused: true } } });
  assert.equal(h.nodes.get('[data-pulse-title]').textContent, 'Free Mint');
  assert.equal(h.nodes.get('[data-pulse-sale-status]').textContent, 'Minting is paused.');
  assert.equal(h.nodes.get('[data-pulse-feedback]').textContent, 'Minting is paused.');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[name="pulse-mode"]').value, '');
  release(); await quote;
  assert.equal(h.nodes.get('[data-pulse-sale-status]').textContent, 'Minting is paused.');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  await h.mint();
  for (const forbidden of ['/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('prelaunch blocks malicious readiness and late old quotes without erasing the handle or wallet proof', async () => {
  const h = await harness({ restoredWallet: true, initialOptions: freeOptions(), initialPhase: 'free' });
  let release;
  h.queueOptions(freeOptions(), new Promise(resolve => { release = resolve; }));
  const quote = h.nodes.get('[data-pulse-check]').handlers.click();
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true, saleStatus: { phase: 'prelaunch', paused: false } } });
  const optionCount = h.calls.filter(call => call === '/api/test/options').length;
  assert.equal(h.nodes.get('[data-pulse-options]').dataset.pulsePhase, 'prelaunch');
  assert.equal(h.nodes.get('[data-pulse-title]').textContent, 'Minting coming soon');
  assert.equal(h.nodes.get('[name="pulse-mode"]').value, '');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  release(); await quote; await h.mint();
  assert.equal(h.nodes.get('[data-pulse-options]').dataset.pulsePhase, 'prelaunch');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[name="handle"]').value, 'SomeHandle');
  assert.equal(h.nodes.get('[data-wallet-label]').textContent, WALLET);
  assert.equal(h.calls.filter(call => call === '/api/test/options').length, optionCount);
  for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true, saleStatus: freeOptions().saleStatus } }); await flush();
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.nodes.get('[name="pulse-mode"]').value, 'free');
});

test('prelaunch arriving during wallet verification prevents a later signature prompt', async () => {
  let release;
  const h = await harness({ initialOptions: freeOptions(), initialPhase: 'free', challengeGate: new Promise(resolve => { release = resolve; }) });
  await h.connect(); assert.ok(h.calls.includes('/api/test/challenge'));
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true, saleStatus: { phase: 'prelaunch', paused: false } } });
  release(); await flush();
  for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
});

test('prelaunch arriving during preparation fences begin and wallet send', async () => {
  let release;
  const h = await harness({ restoredWallet: true, initialOptions: freeOptions(), initialPhase: 'free', prepareGate: new Promise(resolve => { release = resolve; }) });
  const mint = h.mint(); await flush(); assert.ok(h.calls.includes('/api/test/prepare'));
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true, saleStatus: { phase: 'prelaunch', paused: false } } });
  release(); await mint;
  for (const forbidden of ['/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[name="handle"]').value, 'SomeHandle');
});

test('a begun mint is kept for explicit recovery if launch closes before the wallet submission', async () => {
  let release;
  const h = await harness({ restoredWallet: true, initialOptions: freeOptions(), initialPhase: 'free', beginGate: new Promise(resolve => { release = resolve; }) });
  const mint = h.mint(); await flush(); assert.ok(h.calls.includes('/api/test/begin'));
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true, saleStatus: { phase: 'prelaunch', paused: false } } });
  release(); await mint;
  assert.ok(!h.calls.includes('eth_sendTransaction')); assert.ok(!h.calls.includes('/api/test/report'));
  assert.equal(JSON.parse(h.storage.get('sg-sepolia-pending')).handle, 'somehandle');
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.match(h.nodes.get('[data-request-feedback]').textContent, /no transaction was sent/);
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true, saleStatus: freeOptions().saleStatus } }); await flush();
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true, 'Opening again cannot discard the unresolved begun request');
});

test('allowlist revision changes fence old eligibility responses without changing the sale phase or quota', async () => {
  const initial = { ...freeOptions(), saleStatus: { ...freeOptions().saleStatus, freeConfigRevision: '1' } };
  const h = await harness({ restoredWallet: true, initialOptions: initial, initialPhase: 'free' });
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true, saleStatus: initial.saleStatus } }); await flush();
  let releaseOld, releaseNew;
  h.queueOptions(initial, new Promise(resolve => { releaseOld = resolve; }));
  const oldQuote = h.nodes.get('[data-pulse-check]').handlers.click();
  const revised = { ...freeOptions(false), saleStatus: { ...initial.saleStatus, freeConfigRevision: '2' } };
  h.queueOptions(revised, new Promise(resolve => { releaseNew = resolve; }));
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true, saleStatus: revised.saleStatus } });
  releaseOld(); await oldQuote;
  assert.equal(h.nodes.get('[data-pulse-check]').disabled, true, 'Earlier policy response cannot settle the new policy read');
  releaseNew(); await flush();
  assert.equal(h.nodes.get('[name="pulse-mode"]').value, ''); assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.match(h.nodes.get('[data-pulse-feedback]').textContent, /no available free mint slot/);
  assert.ok(!h.calls.includes('/api/test/prepare')); assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('phase and eligibility disagreement cannot authorize free or paid minting', async () => {
  for (const quote of [{ ...freeOptions(), paid: true }, { ...freeOptions(), phase: 'paid' }, { ...paidOptions(), phase: 'free' }, { ...paidOptions(), phase: 'unknown' },
    { ...freeOptions(), free: 'true' }, { ...freeOptions(), saleStatus: { ...freeOptions().saleStatus, phase: 'paid' } }]) {
    const h = await harness({ restoredWallet: true, initialOptions: quote });
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[name="pulse-mode"]').value, '');
    assertWarning(h.nodes.get('[data-pulse-feedback]'), 'Mint availability could not be verified. Please try again shortly.');
    await h.mint();
    for (const forbidden of ['/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  }
});

test('changing the wallet while free eligibility is being checked cannot reuse the preceding wallet slot', async () => {
  const walletState = { accounts: [WALLET], chainId: '0xaa36a7' };
  const h = await harness({ restoredWallet: true, walletState, initialOptions: freeOptions(), initialPhase: 'free' });
  let release;
  h.queueOptions(freeOptions(), new Promise(resolve => { release = resolve; }));
  const quote = h.nodes.get('[data-pulse-check]').handlers.click();
  walletState.accounts = [CONTRACT]; h.walletEvents.get('accountsChanged')([CONTRACT]);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  release(); await quote;
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  await h.mint();
  for (const forbidden of ['/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('paid mint requires an explicit exact-wei ceiling without substituting a default or using floating-point rounding', async () => {
  const h = await harness({ restoredWallet: true, initialOptions: { ...paidOptions(), priceWei: '1000000000001', priceETH: '0.000001000000000001' }, maximumETH: '' });
  const cap = h.nodes.get('[name="pulse-max-eth"]'), submit = h.nodes.get('[data-request-submit]');
  assert.equal(cap.value, ''); assert.equal(submit.disabled, true);
  for (const invalid of ['', '0', '-1', '1e-6', '0.000001', '0.000001000000000000', '0.000100000000000001', '0.0000010000000000001']) {
    cap.value = invalid; cap.handlers.input(); assert.equal(submit.disabled, true, invalid);
  }
  cap.value = '0.000001000000000001'; cap.handlers.input(); assert.equal(submit.disabled, false);
  cap.value = '0.0001'; cap.handlers.input(); assert.equal(submit.disabled, false);
  for (const forbidden of ['/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('free eligibility outages get at most two delayed read retries then an explicit Try again action, never a mint', async () => {
  const h = await harness({ restoredWallet: true, initialOptions: freeOptions(), initialPhase: 'free', optionsError: 'Eligibility temporarily unavailable' });
  const retry = delay => h.timers.findLast(timer => timer.ms === delay && !timer.cleared);
  assert.equal(h.calls.filter(call => call === '/api/test/options').length, 1);
  assert.equal(h.nodes.get('[data-pulse-check]').hidden, true);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.ok(retry(10000)); retry(10000).fn(); await flush();
  assert.equal(h.calls.filter(call => call === '/api/test/options').length, 2);
  assert.ok(retry(20000)); retry(20000).fn(); await flush();
  assert.equal(h.calls.filter(call => call === '/api/test/options').length, 3);
  assert.equal(h.nodes.get('[data-pulse-check]').hidden, false);
  assert.equal(h.nodes.get('[data-pulse-refresh]').hidden, false);
  assert.equal(h.nodes.get('[data-pulse-check] > span').textContent, 'Try again');
  h.setOptionsError(undefined); await h.nodes.get('[data-pulse-check]').handlers.click();
  assert.equal(h.nodes.get('[data-pulse-check]').hidden, true);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.match(h.nodes.get('[data-pulse-feedback]').textContent, /unused free mint slot/);
  for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('eligibility retries cancel on phase changes, wallet invalidation and leaving the page', async () => {
  for (const interruption of ['phase', 'wallet', 'pagehide']) {
    const h = await harness({ restoredWallet: true, initialOptions: freeOptions(), initialPhase: 'free', optionsError: 'Transport unavailable' });
    const timer = h.timers.findLast(timer => timer.ms === 10000 && !timer.cleared); assert.ok(timer);
    if (interruption === 'phase') h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: false, saleStatus: { phase: 'paid', paused: true, freeMinted: 4, freeMintQuota: 4 } } });
    else if (interruption === 'wallet') h.walletEvents.get('accountsChanged')([]);
    else h.windowEvents.get('pagehide')({});
    assert.equal(timer.cleared, true, interruption);
    assert.equal(h.calls.filter(call => call === '/api/test/options').length, 1);
    for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  }
});

test('authentication, integrity and malformed eligibility failures are never automatically retried', async () => {
  for (const failure of [{ status: 401, code: 'CONNECT_WALLET' }, { status: 409, code: 'MINT_EVIDENCE_CONFLICT' }, { status: 409, code: 'REQUEST_UNAVAILABLE' }]) {
    const h = await harness({ restoredWallet: true, initialPhase: 'free', fetchOverride: path => path === '/api/test/options'
      ? { ok: false, status: failure.status, json: async () => ({ code: failure.code, error: 'Availability needs attention' }) } : undefined });
    assert.equal(h.calls.filter(call => call === '/api/test/options').length, 1);
    assert.equal(h.timers.filter(timer => [10000, 20000].includes(timer.ms) && !timer.cleared).length, 0);
    assert.equal(h.nodes.get('[data-pulse-check]').hidden, false);
    assert.equal(h.nodes.get('[data-pulse-check] > span').textContent, 'Try again');
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  }
  const malformed = await harness({ restoredWallet: true, initialPhase: 'free', initialOptions: { ...freeOptions(), paid: true } });
  assert.equal(malformed.timers.filter(timer => [10000, 20000].includes(timer.ms) && !timer.cleared).length, 0);
  assert.equal(malformed.nodes.get('[data-request-submit]').disabled, true);
});

test('loading and connecting never prepare or send; explicit submit persists begin then sends once and reveals only observed inclusion', async () => {
  const h = await harness(); assert.deepEqual(h.calls, ['/api/test/session']);
  await h.connect(); assert.ok(!h.calls.includes('/api/test/prepare')); assert.ok(!h.calls.includes('eth_sendTransaction'));
  assert.equal(h.nodes.get('[data-pulse-sale-status]').textContent, 'Free mint ended · 2/2 slots used.');
  assert.doesNotMatch(h.nodes.get('[data-request-feedback]').textContent, /fixture|test MBTI|not Grok/i);
  assert.equal(h.nodes.get('[name="pulse-mode"]').value, 'paid');
  assert.equal(h.nodes.get('[name="pulse-max-eth"]').value, '0.0001', 'A quote must preserve the explicit price ceiling');
  await Promise.all([h.mint(), h.mint()]);
  assert.equal(h.calls.filter(c => c === 'eth_sendTransaction').length, 1);
  assert.ok(h.calls.indexOf('/api/test/begin') < h.calls.indexOf('eth_sendTransaction'));
  assert.ok(h.calls.indexOf('eth_sendTransaction') < h.calls.indexOf('/api/test/report'));
  assert.deepEqual(h.locations, []); assert.equal(h.storage.has('sg-sepolia-pending'), false);
  assert.equal(h.nodes.get('[data-mint-result]').hidden, false);
  assert.equal(h.nodes.get('[data-assessment-request]').hidden, true);
  assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, RESULT.html);
  assert.equal(h.nodes.get('[data-mint-result-link]').attributes.href, '/signatures/somehandle');
  assert.equal(h.storage.get('sg-sepolia-reveal'), JSON.stringify({ handle: 'somehandle' }));
});

test('a wallet hash or an unverified status cannot reveal the result or enable another submission', async () => {
  for (const status of [{ handle: 'somehandle', state: 'pending' }, { ...RESULT, state: 'unknown' }, { ...RESULT, state: 'reverted', transactionHash: '' },
    { ...RESULT, handle: 'different' }, { ...RESULT, tokenId: '' }, { ...RESULT, tokenId: '0' }, { ...RESULT, tokenId: String(2n ** 256n) },
    { ...RESULT, rendererIdentity: '' }, { ...RESULT, html: '<script>bad()</script>' }]) {
    const h = await harness({ status }); await h.connect(); await h.mint();
    assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
    assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, undefined);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.calls.filter(c => c === 'eth_sendTransaction').length, 1);
    assert.equal(h.storage.has('sg-sepolia-pending'), true);
    assert.deepEqual(h.locations, []);
  }
});

test('a verified reverted receipt never reveals an image or automatically retries the mint', async () => {
  const h = await harness({ status: { handle: 'somehandle', state: 'reverted', transactionHash: HASH } });
  await h.connect(); await h.mint();
  assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
  assert.match(h.nodes.get('[data-mint-observation-message]').textContent, /transaction failed on Sepolia/);
  assert.equal(h.storage.has('sg-sepolia-pending'), true);
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
  assert.equal(h.nodes.get('[data-mint-recovery-check]').disabled, false);
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.timers.filter(t => t.ms === 5000 && !t.cleared).length, 0);
  assert.equal(h.calls.filter(c => c === 'eth_sendTransaction').length, 1);
});

test('pending inclusion reveals in place, then updates to Minted without navigating or resending', async () => {
  const h = await harness({ status: { handle: 'somehandle', state: 'pending', transactionHash: HASH } }); await h.connect(); await h.mint();
  assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
  h.setStatus(RESULT); h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  assert.equal(h.nodes.get('[data-mint-result]').hidden, false);
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Confirming');
  assert.equal(h.nodes.get('.signature-page').dataset.mintState, 'confirming');
  const done = { ...RESULT, state: 'minted', html: RESULT.html.replaceAll('confirming', 'minted').replace('>Confirming<', '>Minted<') };
  h.setStatus(done); h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, done.html);
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Minted');
  assert.deepEqual(h.locations, []); assert.equal(h.calls.filter(c => c === 'eth_sendTransaction').length, 1);
});

test('RPC failure, rechecking, or a changed commitment preserves a revealed image with honest status', async () => {
  const h = await harness(); await h.connect(); await h.mint(); const art = h.nodes.get('[data-mint-result-artwork]').innerHTML;
  h.setStatusError('RPC unavailable'); h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
  await h.tickStatus(); await h.tickStatus(); await h.tickStatus();
  assert.equal(h.nodes.get('[data-mint-result]').hidden, false);
  assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, art);
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Status unavailable');
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, false);
  assert.equal(h.nodes.get('[data-mint-observation-warning]').dataset.noticeOwner, 'mint-confirmation');
  assert.match(h.nodes.get('[data-mint-observation-message]').textContent, /confirmation could not be checked/);
  h.setStatusError(undefined); h.setStatus({ handle: 'somehandle', state: 'pending', transactionHash: HASH });
  h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Rechecking mint');
  assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, art);
  h.setStatus({ ...RESULT, inputDigest: HASH }); h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, art);
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Status unavailable');
  h.setStatus(RESULT); h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Confirming');
  assert.equal(h.nodes.get('[data-mint-result-feedback]').textContent, '');
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
  assert.equal(h.nodes.get('[data-mint-observation-warning]').dataset.noticeOwner, undefined);
  assert.equal(h.calls.filter(c => c === 'eth_sendTransaction').length, 1);
});

test('the one CTA warning moves into the visible revealed result and back without cloning or losing input', async () => {
  const h = await harness({ restoredWallet: true });
  const warning = h.nodes.get('[data-mint-observation-warning]');
  const actionMount = h.nodes.get('[data-mint-action-notice]'), resultMount = h.nodes.get('[data-mint-result-notice]');
  const form = h.nodes.get('[data-assessment-request]'), result = h.nodes.get('[data-mint-result]');
  assert.equal(warning.parentNode, actionMount);
  assert.deepEqual(actionMount.children, [warning, h.nodes.get('[data-request-feedback]')]);
  const input = h.nodes.get('[name="handle"]'), draft = input.value;
  await h.mint();
  assert.equal(warning.parentNode, resultMount);
  assert.deepEqual(resultMount.children, [warning]);
  assert.ok(!actionMount.children.includes(warning));
  assert.equal(form.hidden, true); assert.equal(result.hidden, false);
  h.setStatusError('RPC unavailable'); h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  await h.tickStatus(); await h.tickStatus(); await h.tickStatus();
  assert.equal(warning.hidden, false);
  assert.equal(warning.parentNode.parentNode.hidden, false);
  assert.equal(warning.dataset.noticeOwner, 'mint-confirmation');
  assert.match(h.nodes.get('[data-mint-observation-message]').textContent, /confirmation could not be checked/);
  const requests = h.calls.filter(call => ['/api/test/prepare', 'eth_sendTransaction'].includes(call));
  h.nodes.get('[data-mint-another]').handlers.click(); await flush();
  assert.equal(warning.parentNode, actionMount);
  assert.deepEqual(actionMount.children, [warning, h.nodes.get('[data-request-feedback]')]);
  assert.deepEqual(resultMount.children, []);
  assert.equal(form.hidden, false); assert.equal(result.hidden, true);
  assert.equal(warning.hidden, true); assert.equal(warning.dataset.noticeOwner, undefined);
  assert.equal(input.value, draft);
  assert.deepEqual(h.calls.filter(call => ['/api/test/prepare', 'eth_sendTransaction'].includes(call)), requests);
});

test('a restored pending mint keeps its warning by the CTA and its draft unchanged until verified reveal', async () => {
  const h = await harness({ restoredWallet: true, storage: new Map([['sg-sepolia-pending', JSON.stringify({ handle: 'somehandle' })]]),
    status: { handle: 'somehandle', state: 'pending', transactionHash: HASH }, initialHandle: '@SomeHandle',
    initialWarning: 'Mint availability cannot be checked right now. Please try again shortly.' });
  const warning = h.nodes.get('[data-mint-observation-warning]');
  assert.equal(warning.parentNode, h.nodes.get('[data-mint-action-notice]'));
  assert.equal(h.nodes.get('[data-assessment-request]').hidden, false);
  assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
  assert.equal(h.nodes.get('[name="handle"]').value, '@SomeHandle');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.storage.has('sg-sepolia-pending'), true);
  for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('a finalized reveal stays quiet through observation outages without downgrading verified Minted status', async () => {
  const done = { ...RESULT, state: 'minted', observationUnavailable: true,
    html: RESULT.html.replaceAll('confirming', 'minted').replace('>Confirming<', '>Minted<') };
  const h = await harness({ status: done }); await h.connect(); await h.mint();
  const art = h.nodes.get('[data-mint-result-artwork]').innerHTML;
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Minted');
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
  h.setStatusError('RPC unavailable');
  h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Minted');
  assert.equal(h.nodes.get('.signature-page').dataset.mintState, 'minted');
  assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, art);
  assert.equal(h.nodes.get('[data-mint-result-feedback]').textContent, '');
  assert.equal(h.nodes.get('[data-mint-observation-message]').textContent, '');
  h.setStatusError(undefined); h.setStatus({ ...done, observationUnavailable: false });
  h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
  assert.equal(h.calls.filter(c => c === 'eth_sendTransaction').length, 1);
  assert.deepEqual(h.locations, []);
});

test('passive revealed details keep honest status/artwork but never display RPC or integrity warning banners', async () => {
  for (const error of ['RPC unavailable', { code: 'MINT_EVIDENCE_CONFLICT', error: 'Recheck evidence.' }]) {
    const h = await harness({ surface: 'detail', statusError: error, initialWarning: 'Previously verified signatures are shown.' });
    const art = h.nodes.get('.signature-page').outerHTML;
    assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
    assert.equal(h.nodes.get('[data-mint-observation-message]').textContent, '');
    assert.equal(h.nodes.get('[data-reveal-feedback]').textContent, '');
    const conflict = typeof error !== 'string';
    assert.equal(h.nodes.get('[data-mint-state-label]').textContent, conflict ? 'Status unavailable' : 'Confirming');
    assert.equal(h.nodes.get('.signature-page').dataset.mintState, conflict ? 'unknown' : 'confirming');
    assert.equal(h.nodes.get('.signature-page').outerHTML, art);
    h.setStatusError(undefined); h.setStatus({ handle: 'somehandle', state: 'pending', transactionHash: HASH });
    h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
    assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Rechecking mint');
    assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
    assert.equal(h.nodes.get('[data-reveal-feedback]').textContent, '');
    assert.equal(h.nodes.get('.signature-page').outerHTML, art);
    for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  }
});

test('an explicit mint-process result warns about failed confirmation and releases notice ownership on recovery', async () => {
  const h = await harness({ surface: 'process-result', statusError: 'RPC unavailable' });
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
  await h.tickStatus(); await h.tickStatus(); await h.tickStatus();
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, false);
  assert.equal(h.nodes.get('[data-mint-observation-warning]').dataset.noticeOwner, 'mint-confirmation');
  assert.match(h.nodes.get('[data-mint-observation-message]').textContent, /confirmation could not be checked/);
  assert.match(h.nodes.get('[data-reveal-feedback]').textContent, /no new mint will be submitted/);
  h.setStatusError(undefined);
  h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
  assert.equal(h.nodes.get('[data-mint-observation-warning]').dataset.noticeOwner, undefined);
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Confirming');
  assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('finalized passive detail stays verified and quiet when its status transport is unavailable', async () => {
  const done = { ...RESULT, state: 'minted', observationUnavailable: true,
    html: RESULT.html.replaceAll('confirming', 'minted').replace('>Confirming<', '>Minted<') };
  const h = await harness({ surface: 'detail', status: done, statusError: 'RPC unavailable' });
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Minted');
  assert.equal(h.nodes.get('.signature-page').dataset.mintState, 'minted');
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
  assert.equal(h.nodes.get('[data-mint-observation-message]').textContent, '');
  assert.equal(h.nodes.get('[data-reveal-feedback]').textContent, '');
  assert.equal(h.nodes.get('.signature-page').outerHTML, done.html);
  assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('unavailable Confirming evidence fails closed in an active mint without hiding already revealed artwork', async () => {
  const h = await harness(); await h.connect(); await h.mint();
  const art = h.nodes.get('[data-mint-result-artwork]').innerHTML;
  // Status API authority permits only current inclusion for Confirming. A
  // stale/unavailable Confirming response must not bypass that reveal guard.
  h.setStatus({ ...RESULT, observationUnavailable: true });
  h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, art);
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Status unavailable');
  assert.equal(h.nodes.get('.signature-page').dataset.mintState, 'unknown');
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, false);
  assert.equal(h.nodes.get('[data-mint-observation-warning]').dataset.noticeOwner, 'mint-confirmation');
  assert.match(h.nodes.get('[data-mint-observation-message]').textContent, /Previously verified mints need to be checked/);
  h.setStatus({ ...RESULT, observationUnavailable: false });
  h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Confirming');
  assert.equal(h.nodes.get('.signature-page').dataset.mintState, 'confirming');
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
  assert.equal(h.nodes.get('[data-mint-observation-warning]').dataset.noticeOwner, undefined);
  assert.equal(h.calls.filter(c => c === 'eth_sendTransaction').length, 1);
});

test('unavailable Confirming evidence also fails closed on passive details without exposing a warning', async () => {
  const h = await harness({ surface: 'detail' });
  const art = h.nodes.get('.signature-page').outerHTML;
  h.setStatus({ ...RESULT, observationUnavailable: true });
  h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  assert.equal(h.nodes.get('.signature-page').outerHTML, art);
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Status unavailable');
  assert.equal(h.nodes.get('.signature-page').dataset.mintState, 'unknown');
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
  assert.equal(h.nodes.get('[data-mint-observation-message]').textContent, '');
  assert.equal(h.nodes.get('[data-reveal-feedback]').textContent, '');
  h.setStatus({ ...RESULT, observationUnavailable: false });
  h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
  assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Confirming');
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
  for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('a finality conflict or changed finalized commitment cannot retain an unqualified Minted claim', async () => {
  const done = { ...RESULT, state: 'minted', html: RESULT.html.replaceAll('confirming', 'minted') };
  for (const conflict of ['canonical', 'commitment', 'reorg']) {
    const h = await harness({ status: done }); await h.connect(); await h.mint();
    const art = h.nodes.get('[data-mint-result-artwork]').innerHTML;
    if (conflict === 'canonical') h.setStatusError({ code: 'MINT_EVIDENCE_CONFLICT', error: 'Recheck finalized evidence.' });
    else h.setStatus(conflict === 'commitment' ? { ...done, inputDigest: HASH } : { handle: 'somehandle', state: 'pending', transactionHash: HASH });
    h.windowEvents.get('pageshow')({ persisted: true }); await flush();
    assert.notEqual(h.nodes.get('[data-mint-state-label]').textContent, 'Minted');
    assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, art);
    assert.equal(h.calls.filter(c => c === 'eth_sendTransaction').length, 1);
    // A later transport failure must not quietly restore the disputed label.
    h.setStatusError('RPC unavailable');
    h.timers.filter(t => t.ms === 5000 && !t.cleared).at(-1).fn(); await flush();
    assert.notEqual(h.nodes.get('[data-mint-state-label]').textContent, 'Minted');
  }
});

test('refresh restores the last result from RPC, never from a stored connected or minted flag', async () => {
  const h = await harness({ storage: new Map([['sg-sepolia-reveal', JSON.stringify({ handle: 'somehandle' })]]) });
  assert.equal(h.nodes.get('[data-mint-result]').hidden, false); assert.deepEqual(h.locations, []);
  assert.equal(h.nodes.get('[data-assessment-request]').hidden, true);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  const marker = h.storage.get('sg-sepolia-reveal');
  const unverified = await harness({ storage: h.storage, status: { handle: 'somehandle', state: 'pending', transactionHash: HASH } });
  assert.equal(unverified.nodes.get('[data-mint-result]').hidden, true);
  assert.equal(unverified.nodes.get('[data-assessment-request]').hidden, false);
  assert.equal(unverified.nodes.get('[data-request-submit]').disabled, true);
  for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!unverified.calls.includes(forbidden));
  await unverified.connect(); await unverified.mint();
  assert.equal(unverified.storage.get('sg-sepolia-reveal'), marker);
  assert.equal(unverified.nodes.get('[data-request-submit]').disabled, true);
  assert.ok(!unverified.calls.includes('/api/test/prepare')); assert.ok(!unverified.calls.includes('eth_sendTransaction'));
});

test('a valid prior-reveal reference restores pending or confirmed status and keeps its form submission guarded', async () => {
  for (const status of [{ handle: 'somehandle', state: 'pending', transactionHash: HASH }, RESULT]) {
    const marker = JSON.stringify({ handle: 'somehandle' });
    const h = await harness({ restoredWallet: true, storage: new Map([['sg-sepolia-reveal', marker]]), status, initialHandle: '@SavedDraft' });
    const confirmed = status.state === 'confirming';
    assert.equal(h.nodes.get('[data-mint-result]').hidden, !confirmed);
    assert.equal(h.nodes.get('[data-assessment-request]').hidden, confirmed);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
    assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Change wallet');
    assert.equal(h.nodes.get('[name="handle"]').value, '@SavedDraft');
    assert.equal(h.storage.get('sg-sepolia-reveal'), marker);
    assert.ok(h.calls.includes('eth_accounts')); assert.ok(h.calls.includes('eth_chainId'));
    assert.ok(h.calls.some(call => call.startsWith('/api/test/status?')));
    if (confirmed) assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, RESULT.html);
    await h.mint();
    for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
    await h.connect(); await h.mint();
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[data-mint-result]').hidden, !confirmed);
    assert.equal(h.nodes.get('[data-assessment-request]').hidden, confirmed);
    assert.equal(h.storage.get('sg-sepolia-reveal'), marker);
    assert.ok(!h.calls.includes('/api/test/prepare')); assert.ok(!h.calls.includes('eth_sendTransaction'));
  }
});

test('malformed, null or invalid prior-reveal references stay locked through explicit reconnect and readiness updates', async () => {
  for (const marker of ['{malformed', 'null', JSON.stringify({ handle: '<bad>' })]) {
    for (const restoredWallet of [false, true]) {
      const h = await harness({ restoredWallet, storage: new Map([['sg-sepolia-reveal', marker]]), initialHandle: '@SavedDraft' });
      assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
      assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
      assert.equal(h.storage.get('sg-sepolia-reveal'), marker);
      assert.ok(!h.calls.some(call => call.startsWith('/api/test/status?')));
      assert.ok(!h.calls.includes('personal_sign'));
      await h.connect();
      assert.equal(h.calls.filter(call => call === 'personal_sign').length, 1);
      h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true } }); await flush();
      await h.mint();
      assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
      assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
      assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
      assert.equal(h.nodes.get('[data-assessment-request]').hidden, false);
      assert.equal(h.nodes.get('[name="handle"]').value, '@SavedDraft');
      assert.equal(h.storage.get('sg-sepolia-reveal'), marker);
      assert.ok(!h.calls.some(call => call.startsWith('/api/test/status?')));
      assert.ok(!h.calls.includes('/api/test/prepare')); assert.ok(!h.calls.includes('/api/test/begin')); assert.ok(!h.calls.includes('eth_sendTransaction'));
    }
  }
});

test('an explicit next-mint action resets the result and rechecks the session, without preparing or sending', async () => {
  const h = await harness({ restoredWallet: true }); await h.mint(); const sent = h.calls.filter(c => c === 'eth_sendTransaction').length;
  h.nodes.get('[data-mint-another]').handlers.click(); await flush();
  assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
  assert.equal(h.nodes.get('[data-assessment-request]').hidden, false);
  assert.equal(h.storage.has('sg-sepolia-reveal'), false);
  assert.equal(h.storage.has('sg-sepolia-pending'), false);
  assert.equal(h.calls.filter(c => c === 'eth_sendTransaction').length, sent);
  assert.equal(h.calls.filter(c => c === '/api/test/prepare').length, 1);
});

test('lost report responses still poll for inclusion rather than hiding a successful mint or resending', async () => {
  const h = await harness({ reportError: 'Lost response' }); await h.connect(); await h.mint();
  assert.equal(h.nodes.get('[data-mint-result]').hidden, false);
  assert.equal(h.calls.filter(c => c === 'eth_sendTransaction').length, 1);
  assert.deepEqual(h.locations, []);
});

test('BFCache restores result monitoring without wallet prompts or another transaction', async () => {
  const h = await harness(); await h.connect(); await h.mint();
  const before = h.calls.filter(c => c.startsWith('/api/test/status?')).length;
  h.windowEvents.get('pagehide')(); h.windowEvents.get('pageshow')({ persisted: true }); await flush();
  assert.equal(h.calls.filter(c => c.startsWith('/api/test/status?')).length, before + 1);
  assert.equal(h.nodes.get('[data-mint-result]').hidden, false);
  assert.equal(h.calls.filter(c => c === 'eth_sendTransaction').length, 1);
});

test('handle draft survives page reload and restores preview link without signing or preparing', async () => {
  const storage = new Map(), first = await harness({ storage, initialHandle: '' });
  first.nodes.get('[name="handle"]').value = '@Alice_Bob_Key';
  first.nodes.get('[name="handle"]').handlers.input();
  const refreshed = await harness({ storage, initialHandle: '' });
  assert.equal(refreshed.nodes.get('[name="handle"]').value, '@Alice_Bob_Key');
  assert.equal(refreshed.nodes.get('[data-mint-preview]').attributes.href, '/p/Alice_Bob_Key/variations');
  assert.deepEqual(refreshed.calls, ['/api/test/session']);
  refreshed.nodes.get('[name="handle"]').value = '';
  refreshed.nodes.get('[name="handle"]').handlers.input();
  assert.equal(refreshed.nodes.get('[data-mint-preview]').attributes.href, undefined);
  const cleared = await harness({ storage, initialHandle: '' });
  assert.equal(cleared.nodes.get('[name="handle"]').value, '');
});

test('valid server proof silently restores the matching authorized wallet after returning from preview', async () => {
  const h = await harness({ restoredWallet: true });
  assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Change wallet');
  assert.equal(h.nodes.get('[data-wallet-label]').textContent, WALLET);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.walletEvents.size, 3);
  assert.ok(h.calls.includes('eth_accounts')); assert.ok(h.calls.includes('eth_chainId')); assert.ok(h.calls.includes('/api/test/options'));
  for (const forbidden of ['eth_requestAccounts', 'wallet_switchEthereumChain', 'personal_sign', '/api/test/challenge', '/api/test/verify',
    '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  assert.equal(h.nodes.get('[name="pulse-mode"]').value, 'paid');
  assert.equal(h.nodes.get('[name="pulse-max-eth"]').value, '0.0001');
});

test('missing permission, different account, wrong chain, unavailable provider and failed reads do not silently enable minting', async () => {
  for (const setup of [{ missingProvider: true }, { walletState: { accounts: [], chainId: '0xaa36a7' } },
    { walletState: { accounts: [CONTRACT], chainId: '0xaa36a7' } }, { walletState: { accounts: [WALLET], chainId: '0x1' } },
    { walletReadError: 'Wallet locked' }]) {
    const h = await harness({ restoredWallet: true, ...setup });
    assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Reconnect wallet');
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
    for (const forbidden of ['eth_requestAccounts', 'wallet_switchEthereumChain', 'personal_sign', '/api/test/options',
      '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  }
});

test('expired or absent server proof cannot be replaced with browser permissions or stored wallet state', async () => {
  const storage = new Map([['sg-connected-wallet', WALLET]]);
  const h = await harness({ storage });
  assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Connect wallet');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.deepEqual(h.calls, ['/api/test/session']);
});

test('late Rabby discovery can restore a valid proof without prompts or minting', async () => {
  const h = await harness({ restoredWallet: true, missingProvider: true });
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  h.announce(); await flush();
  assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Change wallet');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/challenge', '/api/test/prepare', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('unavailable mint options do not turn a restored wallet into a reconnect requirement', async () => {
  const message = 'Mint availability cannot be checked right now. Please try again shortly.';
  const h = await harness({ restoredWallet: true, optionsError: message });
  assert.equal(h.nodes.get('[data-wallet-label]').textContent, WALLET);
  assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Change wallet');
  assertWarning(h.nodes.get('[data-pulse-feedback]'), message);
  assert.equal(h.nodes.get('[data-mint-feedback]').textContent, 'Wallet connected.');
  for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/challenge', '/api/test/prepare', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('account and chain changes or disconnect during a silent restore cannot revive stale wallet access', async () => {
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
    let release;
    const accountsGate = new Promise(resolve => { release = resolve; });
    const h = await harness({ restoredWallet: true, accountsGate });
    assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Restoring wallet…');
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    await h.connect(); assert.ok(!h.calls.includes('eth_requestAccounts'));
    h.walletEvents.get(event)([]); release(); await flush();
    assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Connect wallet');
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.ok(!h.calls.includes('/api/test/options')); assert.ok(!h.calls.includes('/api/test/challenge'));
  }
});

test('restored connection invalidates on subsequent account, network or disconnect events', async () => {
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
    const h = await harness({ restoredWallet: true });
    assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
    h.walletEvents.get(event)([]);
    assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Connect wallet');
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.ok(!h.calls.includes('/api/test/prepare')); assert.ok(!h.calls.includes('eth_sendTransaction'));
  }
});

test('a slow quote does not delay wallet restoration or overwrite a later wallet-change state', async () => {
  let release;
  const optionsGate = new Promise(resolve => { release = resolve; });
  const h = await harness({ restoredWallet: true, optionsGate });
  assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Change wallet');
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  h.walletEvents.get('accountsChanged')([]); release(); await flush();
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[data-pulse-sale-status]').textContent, '');
  assertWarning(h.nodes.get('[data-mint-feedback]'), 'Wallet changed. Connect it again.');
});

test('timed-out silent restore releases controls and ignores late permission results', async () => {
  let release;
  const accountsGate = new Promise(resolve => { release = resolve; });
  const h = await harness({ restoredWallet: true, accountsGate });
  h.timers.find(t => t.ms === 5000 && !t.cleared).fn(); await flush();
  assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Reconnect wallet');
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  release(); await flush();
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.ok(!h.calls.includes('/api/test/options')); assert.ok(!h.calls.includes('personal_sign'));
});

test('BFCache return rechecks the server proof and wallet binding without signing again', async () => {
  const h = await harness({ restoredWallet: true });
  h.windowEvents.get('pageshow')({ persisted: true }); await flush();
  assert.equal(h.calls.filter(c => c === '/api/test/session').length, 2);
  assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Change wallet');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.walletEvents.size, 3);
  h.setServerWallet(undefined); // Server restart, logout or proof expiry.
  h.windowEvents.get('pageshow')({ persisted: true }); await flush();
  assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Connect wallet');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/challenge', '/api/test/prepare', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('a restored pending submission is polled without prompting, preparing or resending', async () => {
  const h = await harness({ restoredWallet: true, storage: new Map([['sg-sepolia-pending', JSON.stringify({ handle: 'somehandle' })]]) });
  assert.deepEqual(h.locations, []);
  assert.equal(h.nodes.get('[data-mint-result]').hidden, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.ok(h.calls.includes('eth_accounts')); assert.ok(h.calls.includes('eth_chainId'));
  for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('connect, reconnect, change and busy states preserve the styled label span', async () => {
  for (const restoredWallet of [false, true]) {
    const h = await harness({ restoredWallet });
    const selector = '[data-connect-wallet] > span', label = h.nodes.get(selector);
    assert.ok(label);
    assert.equal(label.textContent, restoredWallet ? 'Change wallet' : 'Connect wallet');
    await h.connect(); assert.equal(h.nodes.get(selector), label); assert.equal(label.textContent, 'Change wallet');
    await h.mint(); assert.equal(h.nodes.get(selector), label);
  }
});

test('unsupported account is explained before signing, preparation or submission', async () => {
  const message = 'This wallet has smart-account delegation enabled on Sepolia. Choose an account without delegation, then reconnect.';
  const h = await harness({ restoredWallet: true, challengeError: message });
  await h.connect();
  assertWarning(h.nodes.get('[data-mint-feedback]'), message);
  assert.equal(h.nodes.get('[data-request-feedback]').textContent, '');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Connect wallet');
  for (const forbidden of ['personal_sign', '/api/test/verify', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('repeated availability failures after sign-in retain the verified wallet without preparing or sending a mint', async () => {
  const message = 'Mint availability cannot be checked right now. Please try again shortly.';
  const h = await harness({ optionsError: message });
  for (let attempt = 0; attempt < 2; attempt++) {
    await h.connect();
    assert.equal(h.nodes.get('[data-wallet-label]').textContent, WALLET);
    assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Change wallet');
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
    assertWarning(h.nodes.get('[data-pulse-feedback]'), message);
    assert.equal(h.nodes.get('[data-mint-feedback]').textContent, 'Wallet connected.');
  }
  assert.equal(h.calls.filter(c => c === '/api/test/verify').length, 2);
  assert.equal(h.calls.filter(c => c === '/api/test/options').length, 2);
  for (const forbidden of ['/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('slow verification is visible beside the wallet button and repeated clicks cannot create competing challenges', async () => {
  let release;
  const challengeGate = new Promise(resolve => { release = resolve; });
  const h = await harness({ challengeGate });
  await h.connect();
  assert.equal(h.nodes.get('[data-mint-feedback]').textContent, 'Checking this account on Sepolia…');
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, true);
  assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Connecting…');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  await h.connect(); await h.mint();
  assert.equal(h.calls.filter(c => c === '/api/test/challenge').length, 1);
  assert.ok(!h.calls.includes('personal_sign'));
  assert.ok(!h.calls.includes('/api/test/prepare'));
  release(); await flush();
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.nodes.get('[data-mint-feedback]').textContent, 'Wallet connected.');
  assert.equal(h.calls.filter(c => c === 'personal_sign').length, 1);
});

test('switching accounts during verification cannot sign or enable minting against a stale challenge', async () => {
  let release;
  const challengeGate = new Promise(resolve => { release = resolve; });
  const h = await harness({ challengeGate }); await h.connect();
  h.walletEvents.get('accountsChanged')([CONTRACT]);
  release(); await flush();
  assert.match(h.nodes.get('[data-mint-feedback]').textContent, /Wallet changed/);
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.ok(!h.calls.includes('personal_sign')); assert.ok(!h.calls.includes('/api/test/verify'));
  await h.connect();
  assert.equal(h.walletEvents.size, 3, 'Reconnect replaces listeners rather than stacking them');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
});

test('verification timeout releases the connect button without signing, minting or retrying', async () => {
  const h = await harness({ challengeGate: new Promise(() => {}) }); await h.connect();
  const timer = h.timers.find(t => t.ms === SEPOLIA_READ_BUDGETS.browserMs && !t.cleared); assert.ok(timer);
  timer.fn(); await flush();
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.match(h.nodes.get('[data-mint-feedback]').textContent, /verification timed out/);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.calls.filter(c => c === '/api/test/challenge').length, 1);
  assert.ok(!h.calls.includes('personal_sign')); assert.ok(!h.calls.includes('/api/test/prepare'));
});

test('Rabby discovery metadata wins over a competing legacy injected extension', async () => {
  const h = await harness({ announceRabby: true }); await h.connect();
  assert.equal(h.nodes.get('[data-wallet-label]').textContent, WALLET);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.calls.filter(c => c === 'personal_sign').length, 1);
});

test('an account announcement while granting explicit access does not discard the newly verified provider', async () => {
  const h = await harness({ accountEventOnGrant: true }); await h.connect();
  assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Change wallet');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.calls.filter(c => c === 'personal_sign').length, 1);
  assert.ok(!h.calls.includes('/api/test/prepare')); assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('ambiguous wallet failure retains the pending handle and never re-enables automatic resubmission', async () => {
  const h = await harness({ rejectSend: true }); await h.connect(); await h.mint(); await h.mint();
  assert.equal(h.calls.filter(c => c === 'eth_sendTransaction').length, 1);
  assert.ok(h.storage.has('sg-sepolia-pending')); assert.ok(!h.calls.includes('/api/test/report'));
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.match(h.nodes.get('[data-mint-observation-message]').textContent, /Submission could not be confirmed/);
  assert.equal(h.nodes.get('[data-request-feedback]').textContent, 'No new mint will be submitted automatically.');
});

const unknownMint = { handle: 'somehandle', state: 'submission-unknown', submissionStage: 'begun', attemptCode: 'old-code' };
const retryProof = { handle: 'somehandle', state: 'retry-allowed', submissionStage: 'expired', recoveryWallet: WALLET, attemptCode: 'old-code' };
const savedPending = (extra = {}) => JSON.stringify({ version: 1, handle: 'somehandle', wallet: WALLET, chainId: 11155111, contract: CONTRACT, code: 'old-code', ...extra });

test('unknown submission exposes explicit recovery for the saved handle without changing the draft or checking on load', async () => {
  const h = await harness({ restoredWallet: true, initialHandle: 'NewHandle', status: unknownMint,
    storage: new Map([['sg-sepolia-pending', savedPending({ transactionHash: HASH })]]) });
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
  assert.equal(h.nodes.get('[data-mint-recovery-handle]').textContent, '@somehandle');
  assert.equal(h.nodes.get('[name="handle"]').value, 'NewHandle');
  assert.equal(h.nodes.get('[name="mint-recovery-hash"]').value, HASH);
  assert.equal(h.nodes.get('[data-mint-recovery-check]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  await h.mint();
  for (const forbidden of ['/api/test/recover', '/api/test/prepare', '/api/test/begin', 'personal_sign', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('explicit recovery coalesces clicks, preserves styled spans, and unlocks only after same-wallet expiration proof', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ restoredWallet: true, status: unknownMint, recoveryValue: retryProof, recoveryGate: gate,
    storage: new Map([['sg-sepolia-pending', savedPending()]]) });
  const check = h.nodes.get('[data-mint-recovery-check]'), hash = h.nodes.get('[data-mint-recovery-transaction]');
  const span = h.nodes.get('[data-mint-recovery-check] > span'), hashSpan = h.nodes.get('[data-mint-recovery-transaction] > span');
  const first = check.handlers.click(), second = check.handlers.click(), third = hash.handlers.click();
  assert.equal(check.disabled, true); assert.equal(hash.disabled, true);
  assert.equal(span.textContent, 'Checking…'); assert.equal(hashSpan.textContent, 'Check transaction');
  assert.equal(h.nodes.get('[data-mint-recovery-feedback]').textContent, 'Checking your previous mint…');
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.equal(h.nodes.get('[data-pulse-check]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.deepEqual(h.recoveryBodies, [{ handle: 'somehandle', attemptCode: 'old-code' }]);
  release(); await Promise.all([first, second, third]);
  assert.equal(h.storage.has('sg-sepolia-pending'), false);
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, true);
  assert.equal(h.nodes.get('[data-mint-retry-note]').hidden, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.nodes.get('[data-mint-recovery-check] > span'), span);
  assert.equal(h.nodes.get('[data-mint-recovery-transaction] > span'), hashSpan);
  assert.equal(span.textContent, 'Check previous mint');
  assert.equal(h.nodes.get('[name="handle"]').value, 'SomeHandle');
  assert.equal(h.nodes.get('[name="pulse-max-eth"]').value, '0.0001');
  assert.equal(h.nodes.get('[name="pulse-mode"]').value, 'paid');
  assert.equal(h.nodes.get('[data-request-feedback]').textContent, 'The previous mint did not complete. You can mint when ready.');
  for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('authorized retry still requires current wallet permissions and read readiness before mint can enable', async () => {
  const h = await harness({ restoredWallet: true, status: unknownMint, recoveryValue: retryProof,
    storage: new Map([['sg-sepolia-pending', savedPending()]]) });
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: false } });
  await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.equal(h.storage.has('sg-sepolia-pending'), false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true } }); await flush();
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('unknown results and malformed retry proof keep the original reference and never enable another send', async () => {
  for (const value of [unknownMint, { ...retryProof, handle: 'other' }, { ...retryProof, attemptCode: 'new-code' },
    { ...retryProof, recoveryWallet: CONTRACT }, { ...retryProof, recoveryWallet: undefined }, { ...retryProof, submissionStage: 'begun' },
    { ...retryProof, submissionStage: 'rejected' }, { ...retryProof, submissionStage: undefined },
    { handle: 'somehandle', state: 'pending', attemptCode: 'old-code', transactionHash: '0x123' }]) {
    const marker = savedPending(), h = await harness({ restoredWallet: true, status: unknownMint, recoveryValue: value,
      storage: new Map([['sg-sepolia-pending', marker]]) });
    await h.nodes.get('[data-mint-recovery-check]').handlers.click(); await h.mint();
    assert.equal(h.storage.get('sg-sepolia-pending'), marker);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
    assert.equal(h.nodes.get('[data-mint-recovery-check]').disabled, false);
    assert.ok(!h.calls.includes('eth_sendTransaction')); assert.ok(!h.calls.includes('/api/test/prepare'));
  }
});

test('transaction-hash recovery uses inline validation and resumes status observation without revealing a wallet hash', async () => {
  const marker = savedPending(), h = await harness({ restoredWallet: true, status: unknownMint,
    storage: new Map([['sg-sepolia-pending', marker]]) });
  const input = h.nodes.get('[name="mint-recovery-hash"]'), check = h.nodes.get('[data-mint-recovery-transaction]');
  for (const value of ['', '0x123', 'bad']) {
    input.value = value; await check.handlers.click();
    assert.equal(h.recoveryBodies.length, 0);
    assertWarning(h.nodes.get('[data-mint-recovery-feedback]'), 'Enter the transaction hash from your wallet activity.');
  }
  input.value = ' ' + HASH + ' ';
  h.queueRecovery({ handle: 'somehandle', state: 'pending', transactionHash: HASH, attemptCode: 'old-code' });
  h.setStatus({ handle: 'somehandle', state: 'pending', transactionHash: HASH });
  await check.handlers.click();
  assert.deepEqual(h.recoveryBodies, [{ handle: 'somehandle', attemptCode: 'old-code', transactionHash: HASH }]);
  assert.deepEqual(JSON.parse(h.storage.get('sg-sepolia-pending')), { ...JSON.parse(marker), transactionHash: HASH });
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
  assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, undefined);
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, true);
  assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('a recovery inclusion response reveals only after normal status validation', async () => {
  for (const verified of [false, true]) {
    const h = await harness({ restoredWallet: true, status: unknownMint,
      storage: new Map([['sg-sepolia-pending', savedPending()]]) });
    h.queueRecovery({ ...RESULT, attemptCode: 'old-code', html: '<script>untrusted response</script>' });
    h.setStatus(verified ? RESULT : { handle: 'somehandle', state: 'pending', transactionHash: HASH });
    await h.nodes.get('[data-mint-recovery-check]').handlers.click();
    assert.equal(h.nodes.get('[data-mint-result]').hidden, !verified);
    assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, verified ? RESULT.html : undefined);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.ok(!h.calls.includes('eth_sendTransaction'));
  }
});

test('a recovery timeout releases its controls, retains the lock, and permits a deliberate retry', async () => {
  const marker = savedPending(), h = await harness({ restoredWallet: true, status: unknownMint,
    storage: new Map([['sg-sepolia-pending', marker]]) });
  h.queueRecovery(retryProof, new Promise(() => {}));
  const checking = h.nodes.get('[data-mint-recovery-check]').handlers.click();
  const timer = h.timers.filter(timer => timer.ms === SEPOLIA_READ_BUDGETS.browserMs && !timer.cleared).at(-1);
  timer.fn(); await checking;
  assert.equal(h.recoverySignals[0].aborted, true);
  assertWarning(h.nodes.get('[data-mint-recovery-feedback]'), 'The previous mint could not be checked right now. Please try again.');
  assert.equal(h.nodes.get('[data-mint-recovery-check]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
  h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('late recovery proofs cannot erase a replaced marker or a new wallet connection epoch', async () => {
  for (const changed of ['marker', 'wallet', 'reconnect']) {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const marker = savedPending(), h = await harness({ restoredWallet: true, status: unknownMint,
      recoveryValue: retryProof, recoveryGate: gate, storage: new Map([['sg-sepolia-pending', marker]]) });
    const checking = h.nodes.get('[data-mint-recovery-check]').handlers.click();
    if (changed === 'marker') h.storage.set('sg-sepolia-pending', savedPending({ code: 'new-code' }));
    else if (changed === 'wallet') h.walletEvents.get('accountsChanged')([]);
    else await h.connect();
    const kept = h.storage.get('sg-sepolia-pending');
    release(); await checking;
    assert.equal(h.storage.get('sg-sepolia-pending'), kept);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.ok(!h.calls.includes('eth_sendTransaction'));
  }
});

test('wallet rejection code 4001 cannot authorize retry even when the request has aged', async () => {
  const h = await harness({ sendError: Object.assign(Error('Cancelled'), { code: 4001 }), status: unknownMint });
  await h.connect(); await h.mint();
  const marker = h.storage.get('sg-sepolia-pending');
  assert.ok(marker); assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  await h.mint();
  assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
  assert.ok(!h.calls.includes('/api/test/recover'));
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
});

test('persisted authenticated retry proof restores availability on reload only for the matching attempt', async () => {
  for (const value of [retryProof, { ...retryProof, recoveryWallet: CONTRACT }, { ...retryProof, submissionStage: 'begun' },
    { ...retryProof, attemptCode: 'different' }]) {
    const valid = value === retryProof, marker = savedPending();
    const h = await harness({ restoredWallet: true, status: value, storage: new Map([['sg-sepolia-pending', marker]]) });
    assert.equal(h.storage.has('sg-sepolia-pending'), !valid);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, !valid);
    assert.ok(!h.calls.includes('/api/test/recover')); assert.ok(!h.calls.includes('eth_sendTransaction'));
  }
});

test('a wallet transaction hash is saved before report and restored for recovery when reporting is lost', async () => {
  const h = await harness({ restoredWallet: true, status: unknownMint, reportError: 'Lost report response' });
  await h.mint();
  assert.equal(h.reportMarkers.length, 1);
  const marker = JSON.parse(h.reportMarkers[0]);
  assert.deepEqual(marker, { version: 1, handle: 'somehandle', wallet: WALLET, chainId: 11155111, contract: CONTRACT, code: 'code', transactionHash: HASH });
  assert.equal(h.nodes.get('[name="mint-recovery-hash"]').value, HASH);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  const restored = await harness({ restoredWallet: true, status: unknownMint, storage: h.storage });
  assert.equal(restored.nodes.get('[name="mint-recovery-hash"]').value, HASH);
  assert.ok(!restored.calls.includes('eth_sendTransaction'));
  assert.ok(!restored.calls.includes('/api/test/recover'));
});

test('a supplied exact reverted receipt remains recoverable until finalized expiry proof allows a new mint', async () => {
  const h = await harness({ restoredWallet: true, status: unknownMint,
    storage: new Map([['sg-sepolia-pending', savedPending()]]) });
  h.nodes.get('[name="mint-recovery-hash"]').value = HASH;
  h.queueRecovery({ handle: 'somehandle', state: 'reverted', transactionHash: HASH, attemptCode: 'old-code' });
  h.setStatusError('Status reads unavailable');
  await h.nodes.get('[data-mint-recovery-transaction]').handlers.click();
  assert.equal(JSON.parse(h.storage.get('sg-sepolia-pending')).transactionHash, HASH);
  assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
  assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, undefined);
  assert.match(h.nodes.get('[data-mint-observation-message]').textContent, /transaction failed on Sepolia/);
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
  assert.equal(h.nodes.get('[data-mint-recovery-check]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  await h.mint(); assert.ok(!h.calls.includes('eth_sendTransaction'));
  h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.equal(h.storage.has('sg-sepolia-pending'), false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
  assert.ok(!h.calls.includes('eth_sendTransaction')); assert.ok(!h.calls.includes('/api/test/prepare'));
});

test('a failed receipt retains its reference across reload and persisted expiry proof clears the terminal guard', async () => {
  const marker = savedPending({ transactionHash: HASH });
  const h = await harness({ restoredWallet: true, status: { handle: 'somehandle', state: 'reverted', transactionHash: HASH },
    storage: new Map([['sg-sepolia-pending', marker]]) });
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  const restored = await harness({ restoredWallet: true, status: { handle: 'somehandle', state: 'reverted', transactionHash: HASH }, storage: h.storage });
  assert.equal(restored.storage.get('sg-sepolia-pending'), marker);
  assert.equal(restored.nodes.get('[data-mint-recovery]').hidden, false);
  restored.setStatus(retryProof); await restored.connect();
  assert.equal(restored.storage.has('sg-sepolia-pending'), false);
  assert.equal(restored.nodes.get('[data-request-submit]').disabled, false);
  assert.ok(!restored.calls.includes('/api/test/recover'));
  assert.ok(!restored.calls.includes('eth_sendTransaction')); assert.ok(!restored.calls.includes('/api/test/prepare'));
});

test('cleared local storage discovers guarded backend attempts only after an explicit mint action', async () => {
  for (const [code, status] of [['SUBMISSION_STARTED', unknownMint], ['REQUEST_EXPIRED',
    { handle: 'somehandle', state: 'not-submitted', submissionStage: 'prepared', recoveryWallet: WALLET }]]) {
    const h = await harness({ restoredWallet: true, status, prepareError: { code, error: 'Previous request needs recovery' } });
    assert.ok(!h.calls.some(call => call.startsWith('/api/test/status?')));
    assert.ok(!h.calls.includes('/api/test/recover'));
    await h.mint();
    const reference = JSON.parse(h.storage.get('sg-sepolia-pending'));
    assert.deepEqual(reference, { version: 1, handle: 'somehandle', wallet: WALLET, chainId: 11155111,
      contract: CONTRACT, requiresRecovery: true });
    assert.equal(h.calls.filter(call => call === '/api/test/prepare').length, 1);
    assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
    assert.equal(h.nodes.get('[data-mint-recovery-handle]').textContent, '@somehandle');
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.ok(!h.calls.includes('/api/test/begin')); assert.ok(!h.calls.includes('eth_sendTransaction'));
    h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
    assert.deepEqual(h.recoveryBodies, [{ handle: 'somehandle' }]);
    assert.equal(h.storage.has('sg-sepolia-pending'), false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
    assert.ok(!h.calls.includes('eth_sendTransaction'));
  }
});

test('unrelated prepare errors or a wallet change cannot create an unauthorized recovery marker', async () => {
  for (const code of ['HANDLE_RESERVED', 'HANDLE_MINTED', 'QUOTE_CHANGED']) {
    const h = await harness({ restoredWallet: true, prepareError: { code, error: 'Preparation failed' } });
    await h.mint();
    assert.equal(h.storage.has('sg-sepolia-pending'), false);
    assert.equal(h.nodes.get('[data-mint-recovery]').hidden, true);
    assert.ok(!h.calls.some(call => call.startsWith('/api/test/status?')));
    assert.ok(!h.calls.includes('/api/test/recover')); assert.ok(!h.calls.includes('eth_sendTransaction'));
  }
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ restoredWallet: true, prepareGate: gate,
    prepareError: { code: 'SUBMISSION_STARTED', error: 'Previous request needs recovery' } });
  const submitting = h.mint(); await flush();
  h.walletEvents.get('accountsChanged')([]); release(); await submitting;
  assert.equal(h.storage.has('sg-sepolia-pending'), false);
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, true);
  assert.ok(!h.calls.some(call => call.startsWith('/api/test/status?')));
  assert.ok(!h.calls.includes('/api/test/recover')); assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('an old recovery cannot release or overwrite the newer same-hash attempt and its loading controls', async () => {
  let releaseOld, releaseNew;
  const oldGate = new Promise(resolve => { releaseOld = resolve; }), newGate = new Promise(resolve => { releaseNew = resolve; });
  const h = await harness({ restoredWallet: true, status: unknownMint,
    storage: new Map([['sg-sepolia-pending', savedPending({ transactionHash: HASH })]]) });
  h.queueRecovery(retryProof, oldGate);
  const oldCheck = h.nodes.get('[data-mint-recovery-check]').handlers.click();
  h.walletEvents.get('accountsChanged')([]); await h.connect();
  const newerMarker = savedPending({ code: 'new-code', transactionHash: HASH });
  h.storage.set('sg-sepolia-pending', newerMarker);
  h.queueRecovery({ ...retryProof, attemptCode: 'new-code' }, newGate);
  const newCheck = h.nodes.get('[data-mint-recovery-transaction]').handlers.click();
  assert.deepEqual(h.recoveryBodies, [{ handle: 'somehandle', attemptCode: 'old-code' },
    { handle: 'somehandle', attemptCode: 'new-code', transactionHash: HASH }]);
  releaseOld(); await oldCheck;
  assert.equal(h.storage.get('sg-sepolia-pending'), newerMarker);
  assert.equal(h.nodes.get('[data-mint-recovery-check]').disabled, true);
  assert.equal(h.nodes.get('[data-mint-recovery-transaction]').disabled, true);
  assert.equal(h.nodes.get('[data-mint-recovery-transaction] > span').textContent, 'Checking…');
  assert.equal(h.nodes.get('[data-mint-recovery-feedback]').textContent, 'Checking your previous mint…');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  releaseNew(); await newCheck;
  assert.equal(h.storage.has('sg-sepolia-pending'), false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.ok(!h.calls.includes('eth_sendTransaction')); assert.ok(!h.calls.includes('/api/test/prepare'));
});

test('same-hash responses from a different attempt code cannot attach, reveal, fail or unlock the current attempt', async () => {
  for (const state of ['pending', 'confirming', 'minted', 'reverted', 'retry-allowed']) {
    const marker = savedPending({ transactionHash: HASH });
    const h = await harness({ restoredWallet: true, status: unknownMint, storage: new Map([['sg-sepolia-pending', marker]]) });
    h.queueRecovery({ ...RESULT, ...retryProof, state, transactionHash: HASH, attemptCode: 'another-code' });
    await h.nodes.get('[data-mint-recovery-transaction]').handlers.click();
    assert.deepEqual(h.recoveryBodies, [{ handle: 'somehandle', attemptCode: 'old-code', transactionHash: HASH }]);
    assert.equal(h.storage.get('sg-sepolia-pending'), marker);
    assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
    assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
    assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, undefined);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assertWarning(h.nodes.get('[data-mint-recovery-feedback]'), 'The previous mint could not be verified. Please try again.');
    assert.match(h.nodes.get('[data-mint-observation-message]').textContent, /Submission could not be confirmed/);
    await h.mint(); assert.ok(!h.calls.includes('eth_sendTransaction')); assert.ok(!h.calls.includes('/api/test/prepare'));
  }
});

test('recovery waits for silent wallet restoration without blocking an independent read-only price check', async () => {
  let releaseAccounts, releasePrice;
  const accountsGate = new Promise(resolve => { releaseAccounts = resolve; });
  const priceGate = new Promise(resolve => { releasePrice = resolve; });
  const h = await harness({ restoredWallet: true, accountsGate, status: unknownMint,
    storage: new Map([['sg-sepolia-pending', savedPending()]]) });
  assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Restoring wallet…');
  await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assertWarning(h.nodes.get('[data-mint-recovery-feedback]'), 'Reconnect the wallet used for this mint, then check again.');
  assert.ok(!h.calls.includes('/api/test/recover'));
  h.setOptionsGate(priceGate);
  const quote = h.nodes.get('[data-pulse-check]').handlers.click();
  assert.equal(h.nodes.get('[data-pulse-check]').disabled, true);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  releaseAccounts(); await flush();
  assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Change wallet');
  h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true, 'Recovery cannot replace the initial wallet eligibility/price quote');
  assert.equal(h.nodes.get('[data-pulse-check]').disabled, true);
  releasePrice(); await quote;
  assert.equal(h.nodes.get('[data-pulse-check]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('price completion and failure cannot overwrite recovery progress and new minting still needs a valid quote', async () => {
  for (const completionOrder of ['price-first', 'recovery-first']) for (const priceFails of [false, true]) {
    let releasePrice, releaseRecovery;
    const priceGate = new Promise(resolve => { releasePrice = resolve; }), recoveryGate = new Promise(resolve => { releaseRecovery = resolve; });
    const h = await harness({ restoredWallet: true, status: unknownMint,
      storage: new Map([['sg-sepolia-pending', savedPending()]]) });
    h.setOptionsGate(priceGate);
    if (priceFails) h.setOptionsError('Price unavailable');
    const quote = h.nodes.get('[data-pulse-check]').handlers.click();
    h.queueRecovery(retryProof, recoveryGate);
    const checking = h.nodes.get('[data-mint-recovery-check]').handlers.click();
    assert.equal(h.nodes.get('[data-pulse-check]').disabled, true);
    assert.equal(h.nodes.get('[data-mint-recovery-check]').disabled, true);
    if (completionOrder === 'price-first') {
      releasePrice(); await quote;
      assert.equal(h.nodes.get('[data-mint-recovery-check]').disabled, true);
      assert.equal(h.nodes.get('[data-mint-recovery-feedback]').textContent, 'Checking your previous mint…');
      assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
      releaseRecovery(); await checking;
    } else {
      releaseRecovery(); await checking;
      assert.equal(h.nodes.get('[data-pulse-check]').disabled, true);
      assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
      releasePrice(); await quote;
    }
    assert.equal(h.storage.has('sg-sepolia-pending'), false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, priceFails);
    assert.equal(h.nodes.get('[data-request-feedback]').textContent, 'The previous mint did not complete. You can mint when ready.');
    assert.equal(h.nodes.get('[data-mint-recovery-check]').disabled, false);
    if (priceFails) assertWarning(h.nodes.get('[data-pulse-feedback]'), 'Price unavailable');
    else assert.match(h.nodes.get('[data-pulse-feedback]').textContent, /Current Pulse price:/);
    for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  }
});

test('a stale recovery response after BFCache restores verified reveal cannot erase or downgrade the revealed signature', async () => {
  for (const response of [retryProof, { handle: 'somehandle', state: 'reverted', transactionHash: HASH, attemptCode: 'old-code' }]) {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const h = await harness({ restoredWallet: true, status: unknownMint,
      storage: new Map([['sg-sepolia-pending', savedPending()]]) });
    h.queueRecovery(response, gate);
    const checking = h.nodes.get('[data-mint-recovery-check]').handlers.click();
    h.setStatus(RESULT); h.windowEvents.get('pageshow')({ persisted: true }); await flush();
    assert.equal(h.nodes.get('[data-mint-result]').hidden, false);
    assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, RESULT.html);
    const revealMarker = h.storage.get('sg-sepolia-reveal');
    release(); await checking;
    assert.equal(h.storage.get('sg-sepolia-reveal'), revealMarker);
    assert.equal(h.storage.has('sg-sepolia-pending'), false);
    assert.equal(h.nodes.get('[data-mint-result]').hidden, false);
    assert.equal(h.nodes.get('[data-assessment-request]').hidden, true);
    assert.equal(h.nodes.get('[data-mint-state-label]').textContent, 'Confirming');
    assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  }
});

test('expiry labels and long elapsed time cannot turn unknown, pending or reverted receipts into retry permission', async () => {
  for (const state of ['submission-unknown', 'pending', 'reverted']) {
    const marker = savedPending({ transactionHash: HASH });
    const h = await harness({ restoredWallet: true, status: unknownMint, storage: new Map([['sg-sepolia-pending', marker]]) });
    h.advanceTime(30 * 86400000);
    const receipt = { handle: 'somehandle', state, transactionHash: HASH, submissionStage: 'expired', recoveryWallet: WALLET, attemptCode: 'old-code' };
    h.queueRecovery(receipt); h.setStatus(receipt);
    await h.nodes.get('[data-mint-recovery-check]').handlers.click(); await h.mint();
    assert.equal(h.storage.has('sg-sepolia-pending'), true);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
    assert.equal(h.calls.filter(call => call === '/api/test/recover').length, 1);
    assert.ok(!h.calls.includes('eth_sendTransaction')); assert.ok(!h.calls.includes('/api/test/prepare'));
  }
});

test('recovery transport, authentication and malformed response errors never start or reveal another mint', async () => {
  const failures = [
    () => { throw Error('Network disconnected'); },
    () => ({ ok: true, json: async () => { throw SyntaxError('Invalid JSON'); } }),
    () => ({ ok: false, json: async () => ({ error: 'Session expired', code: 'CONNECT_WALLET' }) }),
    () => ({ ok: false, json: async () => ({ error: 'Cancelled', code: 4001 }) }),
    () => ({ ok: true, json: async () => null }),
    () => ({ ok: true, json: async () => ({ handle: 'somehandle', state: 'not-submitted', recoveryWallet: WALLET }) }),
  ];
  for (const failure of failures) {
    const marker = savedPending();
    const h = await harness({ restoredWallet: true, status: unknownMint, storage: new Map([['sg-sepolia-pending', marker]]) });
    h.setFetchOverride(path => path === '/api/test/recover' ? failure() : undefined);
    await h.nodes.get('[data-mint-recovery-check]').handlers.click(); await h.mint();
    assert.equal(h.storage.get('sg-sepolia-pending'), marker);
    assert.equal(h.nodes.get('[data-mint-recovery-check]').disabled, false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
    assert.match(h.nodes.get('[data-mint-recovery-feedback]').className, /open-preview-warning/);
    for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  }
});

test('failed initial pending persistence prevents a wallet send and retains the duplicate guard', async () => {
  const h = await harness({ restoredWallet: true });
  h.setStorageFault(({ operation, key }) => { if (operation === 'set' && key === 'sg-sepolia-pending') throw Error('Storage unavailable'); });
  await h.mint(); await h.mint();
  assert.equal(h.calls.filter(call => call === '/api/test/prepare').length, 1);
  assert.equal(h.calls.filter(call => call === '/api/test/begin').length, 1);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.ok(!h.calls.includes('eth_sendTransaction')); assert.ok(!h.calls.includes('/api/test/report'));
  assertWarning(h.nodes.get('[data-request-feedback]'), 'Your mint was not sent because its recovery details could not be saved. Check the previous mint before trying again.');
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
  h.queueRecovery({ ...retryProof, attemptCode: 'code' }); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.deepEqual(h.recoveryBodies, [{ handle: 'somehandle', attemptCode: 'code' }]);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('authenticated expiry recovery permits exactly one later explicit new mint with a fresh attempt marker', async () => {
  for (const initialState of ['submission-unknown', 'reverted', 'retry-allowed']) {
    const initialStatus = initialState === 'retry-allowed' ? retryProof : initialState === 'reverted'
      ? { handle: 'somehandle', state: 'reverted', transactionHash: HASH } : unknownMint;
    const h = await harness({ restoredWallet: true, status: initialStatus,
      storage: new Map([['sg-sepolia-pending', savedPending({ transactionHash: HASH })]]) });
    if (initialState !== 'retry-allowed') {
      h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
    }
    assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
    for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
    h.setStatus(RESULT); await Promise.all([h.mint(), h.mint()]); await h.mint();
    assert.equal(h.calls.filter(call => call === '/api/test/prepare').length, 1);
    assert.equal(h.calls.filter(call => call === '/api/test/begin').length, 1);
    assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
    assert.equal(h.calls.filter(call => call === '/api/test/report').length, 1);
    assert.equal(JSON.parse(h.reportMarkers[0]).code, 'code');
    assert.notEqual(JSON.parse(h.reportMarkers[0]).code, 'old-code');
    assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, RESULT.html);
    assert.equal(h.nodes.get('[data-assessment-request]').hidden, true);
    assert.equal(h.nodes.get('[data-mint-retry-note]').hidden, true);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.ok(!h.calls.includes('personal_sign'));
  }
});

test('an actual recovery HTTP mismatch retains the attempt and allows a later deliberate proof check', async () => {
  const marker = savedPending({ transactionHash: HASH }), h = await harness({ restoredWallet: true, status: unknownMint,
    storage: new Map([['sg-sepolia-pending', marker]]) });
  h.queueRecovery(undefined, undefined, 'This transaction does not match your previous mint. Check its hash in your wallet.');
  await h.nodes.get('[data-mint-recovery-transaction]').handlers.click();
  assertWarning(h.nodes.get('[data-mint-recovery-feedback]'), 'This transaction does not match your previous mint. Check its hash in your wallet.');
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
  assert.equal(h.nodes.get('[data-mint-recovery-check]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.deepEqual(h.recoveryBodies, [{ handle: 'somehandle', attemptCode: 'old-code', transactionHash: HASH },
    { handle: 'somehandle', attemptCode: 'old-code' }]);
  assert.equal(h.storage.has('sg-sepolia-pending'), false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.nodes.get('[data-mint-recovery-feedback]').textContent, '');
  assert.ok(!h.calls.includes('eth_sendTransaction')); assert.ok(!h.calls.includes('/api/test/prepare'));
});

test('lost-storage recovery uses the handle actually submitted while preserving a draft edited during preparation', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ restoredWallet: true, status: unknownMint, prepareGate: gate,
    prepareError: { code: 'SUBMISSION_STARTED', error: 'Previous request needs recovery' } });
  const submitting = h.mint(); await flush();
  h.nodes.get('[name="handle"]').value = 'DifferentHandle'; h.nodes.get('[name="handle"]').handlers.input();
  release(); await submitting;
  assert.equal(JSON.parse(h.storage.get('sg-sepolia-pending')).handle, 'somehandle');
  assert.equal(h.nodes.get('[data-mint-recovery-handle]').textContent, '@somehandle');
  assert.equal(h.nodes.get('[name="handle"]').value, 'DifferentHandle');
  assert.equal(h.nodes.get('[data-mint-preview]').attributes.href, '/p/DifferentHandle/variations');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.calls.filter(call => call === '/api/test/prepare').length, 1);
  assert.ok(!h.calls.includes('/api/test/begin')); assert.ok(!h.calls.includes('/api/test/recover')); assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('a hash persistence error after sending still reports and observes the existing transaction without sending again', async () => {
  const h = await harness({ restoredWallet: true, status: unknownMint });
  h.setStorageFault(({ operation, key, value }) => {
    if (operation === 'set' && key === 'sg-sepolia-pending' && JSON.parse(value).transactionHash) throw Error('Hash storage unavailable');
  });
  await h.mint(); await h.mint();
  assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
  assert.equal(h.calls.filter(call => call === '/api/test/report').length, 1);
  assert.ok(h.calls.some(call => call.startsWith('/api/test/status?')));
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
});

test('failed retry-marker deletion gives recoverable feedback while preventing a duplicate send', async () => {
  const marker = savedPending(), h = await harness({ restoredWallet: true, status: unknownMint,
    storage: new Map([['sg-sepolia-pending', marker]]) });
  h.setStorageFault(({ operation, key }) => { if (operation === 'remove' && key === 'sg-sepolia-pending') throw Error('Storage removal unavailable'); });
  h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[data-mint-recovery-check]').disabled, false);
  assertWarning(h.nodes.get('[data-mint-recovery-feedback]'), 'Your saved mint could not be cleared. Please check the previous mint again.');
  await h.mint(); assert.ok(!h.calls.includes('eth_sendTransaction')); assert.ok(!h.calls.includes('/api/test/prepare'));
});

test('partial retry-reference deletion restores both markers and permits a later deliberate recovery retry', async () => {
  for (const restorationFails of [false, true]) {
    const marker = savedPending(), reveal = JSON.stringify({ handle: 'somehandle' });
    const h = await harness({ restoredWallet: true, status: unknownMint,
      storage: new Map([['sg-sepolia-pending', marker], ['sg-sepolia-reveal', reveal]]) });
    h.setStorageFault(({ operation, key }) => {
      if (operation === 'remove' && key === 'sg-sepolia-reveal') throw Error('Reveal removal failed');
      if (restorationFails && operation === 'set' && key === 'sg-sepolia-pending') throw Error('Pending restoration failed');
    });
    h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
    assert.equal(h.storage.get('sg-sepolia-pending'), restorationFails ? undefined : marker);
    assert.equal(h.storage.get('sg-sepolia-reveal'), reveal);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
    assertWarning(h.nodes.get('[data-mint-recovery-feedback]'), 'Your saved mint could not be cleared. Please check the previous mint again.');
    h.setStorageFault(undefined); h.queueRecovery(retryProof);
    await h.nodes.get('[data-mint-recovery-check]').handlers.click();
    assert.deepEqual(h.recoveryBodies, [{ handle: 'somehandle', attemptCode: 'old-code' }, { handle: 'somehandle', attemptCode: 'old-code' }]);
    assert.equal(h.storage.has('sg-sepolia-pending'), false);
    assert.equal(h.storage.has('sg-sepolia-reveal'), false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
    for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  }
});

test('partial deletion cannot restore an old marker over a newer same-handle attempt', async () => {
  const marker = savedPending(), newer = savedPending({ code: 'new-code' });
  const h = await harness({ restoredWallet: true, status: unknownMint,
    storage: new Map([['sg-sepolia-pending', marker], ['sg-sepolia-reveal', JSON.stringify({ handle: 'somehandle' })]]) });
  h.setStorageFault(({ operation, key }) => {
    if (operation === 'remove' && key === 'sg-sepolia-reveal') {
      h.storage.set('sg-sepolia-pending', newer); throw Error('Concurrent storage change');
    }
  });
  h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.equal(h.storage.get('sg-sepolia-pending'), newer);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.storageOperations.some(operation => operation.operation === 'set' && operation.value === marker), false);
  h.setStorageFault(undefined); h.queueRecovery({ ...retryProof, attemptCode: 'new-code' });
  await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.deepEqual(h.recoveryBodies.at(-1), { handle: 'somehandle', attemptCode: 'new-code' });
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('persisted GET retry proof keeps the lock and exposes recovery when browser storage cannot clear its marker', async () => {
  const marker = savedPending();
  const h = await harness({ restoredWallet: true, status: retryProof, storage: new Map([['sg-sepolia-pending', marker]]),
    storageFault: ({ operation, key }) => { if (operation === 'remove' && key === 'sg-sepolia-pending') throw Error('Read-recovery removal failed'); } });
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
  assertWarning(h.nodes.get('[data-mint-recovery-feedback]'), 'Your saved mint could not be cleared. Please check the previous mint again.');
  assert.ok(!h.calls.includes('/api/test/recover'));
  h.setStorageFault(undefined); await h.tickStatus();
  assert.equal(h.storage.has('sg-sepolia-pending'), false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, true);
  for (const forbidden of ['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('hash-cache and report failures retain a scoped transaction reference for explicit recovery without another send', async () => {
  const h = await harness({ restoredWallet: true, status: { ...unknownMint, attemptCode: 'code' }, reportError: 'Report unavailable' });
  h.setStorageFault(({ operation, key, value }) => {
    if (operation === 'set' && key === 'sg-sepolia-pending' && JSON.parse(value).transactionHash) throw Error('Hash cache unavailable');
  });
  await h.mint();
  assert.equal(JSON.parse(h.storage.get('sg-sepolia-pending')).transactionHash, undefined);
  assert.equal(h.nodes.get('[name="mint-recovery-hash"]').value, HASH);
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assertWarning(h.nodes.get('[data-mint-recovery-feedback]'), 'The transaction hash could not be saved in this browser. Check the previous mint before leaving this page.');
  h.queueRecovery({ ...unknownMint, attemptCode: 'code' });
  await h.nodes.get('[data-mint-recovery-transaction]').handlers.click(); await h.mint();
  assert.deepEqual(h.recoveryBodies, [{ handle: 'somehandle', attemptCode: 'code', transactionHash: HASH }]);
  assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
  assert.equal(h.calls.filter(call => call === '/api/test/report').length, 1);
  assert.equal(h.calls.filter(call => call === '/api/test/prepare').length, 1);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
});

test('a failed hash-cache fallback cannot hide a newer persisted attempt with the same hash', async () => {
  const h = await harness({ restoredWallet: true, status: { ...unknownMint, attemptCode: 'code' } });
  h.setStorageFault(({ operation, key, value }) => {
    if (operation === 'set' && key === 'sg-sepolia-pending' && JSON.parse(value).transactionHash) throw Error('Hash cache unavailable');
  });
  await h.mint();
  const newer = savedPending({ code: 'new-code', transactionHash: HASH });
  h.storage.set('sg-sepolia-pending', newer);
  h.queueRecovery({ ...retryProof, attemptCode: 'code' }); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.deepEqual(h.recoveryBodies.at(-1), { handle: 'somehandle', attemptCode: 'new-code' });
  assert.equal(h.storage.get('sg-sepolia-pending'), newer);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  h.queueRecovery({ ...retryProof, attemptCode: 'new-code' }); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.equal(h.storage.has('sg-sepolia-pending'), false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
});

test('guarded backend recovery remains usable when the newly discovered marker cannot be persisted', async () => {
  for (const code of ['SUBMISSION_STARTED', 'REQUEST_EXPIRED']) {
    const status = code === 'SUBMISSION_STARTED' ? unknownMint
      : { handle: 'somehandle', state: 'not-submitted', submissionStage: 'prepared', recoveryWallet: WALLET };
    const h = await harness({ restoredWallet: true, status, prepareError: { code, error: 'Previous request needs recovery' } });
    h.setStorageFault(({ operation, key }) => { if (operation === 'set' && key === 'sg-sepolia-pending') throw Error('Discovery cache unavailable'); });
    await h.mint();
    assert.equal(h.storage.has('sg-sepolia-pending'), false);
    assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
    assert.deepEqual(h.recoveryBodies, [{ handle: 'somehandle' }]);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
    assert.ok(!h.calls.includes('/api/test/begin')); assert.ok(!h.calls.includes('eth_sendTransaction'));
  }
});

test('Mint another preserves revealed evidence and its submission guard until both saved references clear', async () => {
  for (const failedKey of ['sg-sepolia-pending', 'sg-sepolia-reveal']) {
    const h = await harness({ restoredWallet: true }); await h.mint();
    const reveal = h.storage.get('sg-sepolia-reveal'), artwork = h.nodes.get('[data-mint-result-artwork]').innerHTML;
    const before = h.calls.length;
    h.setStorageFault(({ operation, key }) => { if (operation === 'remove' && key === failedKey) throw Error('Saved result removal failed'); });
    h.nodes.get('[data-mint-another]').handlers.click();
    assert.equal(h.storage.get('sg-sepolia-reveal'), reveal);
    assert.equal(h.nodes.get('[data-mint-result]').hidden, false);
    assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, artwork);
    assert.equal(h.nodes.get('[data-assessment-request]').hidden, true);
    assertWarning(h.nodes.get('[data-mint-result-feedback]'), 'Your saved mint could not be cleared. Please check the previous mint again.');
    assert.equal(h.calls.length, before, 'An unsuccessful clear cannot reload the session or prepare another mint');
    h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: false } });
    h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true } }); await h.mint();
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
    assert.equal(h.calls.filter(call => call === '/api/test/prepare').length, 1);
    h.setStorageFault(undefined); h.nodes.get('[data-mint-another]').handlers.click(); await flush();
    assert.equal(h.storage.has('sg-sepolia-reveal'), false);
    assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
    assert.equal(h.nodes.get('[data-assessment-request]').hidden, false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
    assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
    assert.ok(!h.calls.includes('personal_sign'));
  }
});

test('post-send pending-storage read errors still report and observe the transaction but cannot authorize clearing an unreadable marker', async () => {
  let release; const sendGate = new Promise(resolve => { release = resolve; });
  const h = await harness({ restoredWallet: true, sendGate, status: { ...unknownMint, attemptCode: 'code' } });
  const submitting = h.mint(); await flush();
  h.setStorageFault(({ operation, key }) => { if (operation === 'get' && key === 'sg-sepolia-pending') throw Error('Pending reads denied'); });
  release(); await submitting;
  assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
  assert.equal(h.calls.filter(call => call === '/api/test/report').length, 1);
  assert.ok(h.calls.some(call => call.startsWith('/api/test/status?')));
  assert.equal(h.nodes.get('[name="mint-recovery-hash"]').value, HASH);
  assert.equal(h.nodes.get('[data-mint-recovery]').hidden, false);
  h.queueRecovery({ ...retryProof, attemptCode: 'code' }); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.equal(h.storage.has('sg-sepolia-pending'), true);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assertWarning(h.nodes.get('[data-mint-recovery-feedback]'), 'Your saved mint could not be cleared. Please check the previous mint again.');
  h.setStorageFault(undefined); h.queueRecovery({ ...retryProof, attemptCode: 'code' });
  await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.equal(h.storage.has('sg-sepolia-pending'), false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
});

test('unreadable storage without a known reference cannot be treated as absence during load or reconnect', async () => {
  const marker = savedPending();
  const h = await harness({ restoredWallet: true, status: unknownMint, storage: new Map([['sg-sepolia-pending', marker]]),
    storageFault: ({ operation, key }) => { if (operation === 'get' && key === 'sg-sepolia-pending') throw Error('Storage access denied'); } });
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assertWarning(h.nodes.get('[data-mint-feedback]'), 'Your saved mint could not be read. Enable browser storage, then refresh this page.');
  await h.connect(); await h.mint();
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.ok(!h.calls.includes('/api/test/prepare')); assert.ok(!h.calls.includes('/api/test/begin')); assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('a reveal-reference read failure during authorized clearing retains both references and retry feedback', async () => {
  const marker = savedPending(), reveal = JSON.stringify({ handle: 'somehandle' });
  const h = await harness({ restoredWallet: true, status: unknownMint,
    storage: new Map([['sg-sepolia-pending', marker], ['sg-sepolia-reveal', reveal]]) });
  h.setStorageFault(({ operation, key }) => { if (operation === 'get' && key === 'sg-sepolia-reveal') throw Error('Reveal reads denied'); });
  h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
  assert.equal(h.storage.get('sg-sepolia-reveal'), reveal);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assertWarning(h.nodes.get('[data-mint-recovery-feedback]'), 'Your saved mint could not be cleared. Please check the previous mint again.');
  assert.equal(h.storageOperations.filter(operation => operation.operation === 'remove').length, 0);
  h.setStorageFault(undefined); h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('a read failure during partial-clear restoration preserves the known pending guard for a later retry', async () => {
  const marker = savedPending(), reveal = JSON.stringify({ handle: 'somehandle' });
  const h = await harness({ restoredWallet: true, status: unknownMint,
    storage: new Map([['sg-sepolia-pending', marker], ['sg-sepolia-reveal', reveal]]) });
  h.setStorageFault(({ operation, key }) => {
    if (operation === 'remove' && key === 'sg-sepolia-reveal') throw Error('Reveal removal failed');
    if (operation === 'get' && key === 'sg-sepolia-pending' && !h.storage.has('sg-sepolia-pending')) throw Error('Restore reads denied');
  });
  h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.equal(h.storage.has('sg-sepolia-pending'), false);
  assert.equal(h.storage.get('sg-sepolia-reveal'), reveal);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assertWarning(h.nodes.get('[data-mint-recovery-feedback]'), 'Your saved mint could not be cleared. Please check the previous mint again.');
  h.setStorageFault(undefined); h.queueRecovery(retryProof); await h.nodes.get('[data-mint-recovery-check]').handlers.click();
  assert.deepEqual(h.recoveryBodies.at(-1), { handle: 'somehandle', attemptCode: 'old-code' });
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('reveal-cache write failures retain verified artwork, state and the usable explicit Mint another action', async () => {
  for (const state of ['confirming', 'minted']) {
    const result = state === 'confirming' ? RESULT : { ...RESULT, state: 'minted',
      html: RESULT.html.replaceAll('confirming', 'minted').replace('>Confirming<', '>Minted<') };
    const h = await harness({ restoredWallet: true, status: result });
    h.setStorageFault(({ operation, key }) => { if (operation === 'set' && key === 'sg-sepolia-reveal') throw Error('Reveal cache unavailable'); });
    await h.mint(); await h.mint();
    assert.equal(h.nodes.get('[data-mint-result]').hidden, false);
    assert.equal(h.nodes.get('[data-mint-result-artwork]').innerHTML, result.html);
    assert.equal(h.nodes.get('[data-mint-state-label]').textContent, state === 'confirming' ? 'Confirming' : 'Minted');
    assert.equal(h.nodes.get('[data-assessment-request]').hidden, true);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
    assertWarning(h.nodes.get('[data-mint-result-feedback]'), 'Your signature is revealed. Its viewing reference could not be saved in this browser.');
    assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
    h.nodes.get('[data-mint-another]').handlers.click(); await flush();
    assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
    assert.equal(h.nodes.get('[data-assessment-request]').hidden, false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
    assert.equal(h.calls.filter(call => call === '/api/test/prepare').length, 1);
    assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
    assert.ok(!h.calls.includes('personal_sign'));
  }
});

test('a saved scoped pending reference restores wallet permissions and price access without releasing the mint lock', async () => {
  for (const status of [{ handle: 'somehandle', state: 'submission-unknown', submissionStage: 'begun' },
    { handle: 'somehandle', state: 'pending', transactionHash: HASH }]) {
    const marker = JSON.stringify({ version: 1, handle: 'somehandle', wallet: WALLET, chainId: 11155111, contract: CONTRACT });
    const h = await harness({ restoredWallet: true, storage: new Map([['sg-sepolia-pending', marker]]), status });
    assert.ok(h.calls.includes('eth_accounts')); assert.ok(h.calls.includes('eth_chainId'));
    assert.ok(h.calls.includes('/api/test/options'));
    assert.equal(h.walletEvents.size, 3);
    assert.equal(h.nodes.get('[data-wallet-label]').textContent, WALLET);
    assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Change wallet');
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.storage.get('sg-sepolia-pending'), marker);
    await h.nodes.get('[data-pulse-check]').handlers.click();
    assert.match(h.nodes.get('[data-pulse-feedback]').textContent, /Current Pulse price:/);
    await h.mint();
    for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
    await h.connect();
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.storage.get('sg-sepolia-pending'), marker);
    assert.equal(h.calls.filter(call => call === 'personal_sign').length, 1);
    for (const forbidden of ['/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  }
});

test('prepare, wallet submission and report keep change-wallet locked until the critical section finishes', async () => {
  for (const [gateName, call] of [['prepareGate', '/api/test/prepare'], ['sendGate', 'eth_sendTransaction'], ['reportGate', '/api/test/report']]) {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const h = await harness({ [gateName]: gate, status: { handle: 'somehandle', state: 'pending', transactionHash: HASH } });
    await h.connect();
    const submit = h.mint(); await flush();
    assert.ok(h.calls.includes(call));
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, true);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    const signIns = h.calls.filter(value => value === 'eth_requestAccounts').length;
    await h.connect(); await h.mint();
    assert.equal(h.calls.filter(value => value === 'eth_requestAccounts').length, signIns);
    assert.equal(h.calls.filter(value => value === '/api/test/prepare').length, 1);
    release(); await submit; await flush();
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.storage.has('sg-sepolia-pending'), true);
    assert.equal(h.calls.filter(value => value === 'eth_sendTransaction').length, 1);
  }
});

test('wallet invalidation during send or report cannot open a competing reconnect before settlement', async () => {
  for (const gateName of ['sendGate', 'reportGate']) {
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
      let release; const gate = new Promise(resolve => { release = resolve; });
      const h = await harness({ [gateName]: gate, status: { handle: 'somehandle', state: 'pending', transactionHash: HASH } });
      await h.connect(); const submit = h.mint(); await flush();
      const marker = h.storage.get('sg-sepolia-pending'); assert.ok(marker);
      h.walletEvents.get(event)([]);
      assert.equal(h.nodes.get('[data-connect-wallet]').disabled, true);
      assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
      const signIns = h.calls.filter(call => call === 'eth_requestAccounts').length;
      await h.connect();
      assert.equal(h.calls.filter(call => call === 'eth_requestAccounts').length, signIns);
      release(); await submit; await flush();
      assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
      assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
      assert.deepEqual(JSON.parse(h.storage.get('sg-sepolia-pending')), { ...JSON.parse(marker), transactionHash: HASH });
      assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
    }
  }
});

test('an in-flight transaction-status read releases change-wallet after reporting while mint remains locked', async () => {
  const h = await harness(); await h.connect();
  let release; const gate = new Promise(resolve => { release = resolve; });
  h.queueStatus({ handle: 'somehandle', state: 'pending', transactionHash: HASH }, gate);
  const submit = h.mint(); await flush();
  assert.ok(h.calls.includes('/api/test/report'));
  assert.ok(h.calls.some(call => call.startsWith('/api/test/status?')));
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  const marker = h.storage.get('sg-sepolia-pending'); assert.ok(marker);
  await h.mint(); assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
  release(); await submit; await flush();
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
});

test('a durable unknown submission uses one persistent transaction warning, not mint availability', async () => {
  const h = await harness({ restoredWallet: true, storage: new Map([['sg-sepolia-pending', JSON.stringify({ handle: 'somehandle' })]]),
    status: { handle: 'somehandle', state: 'submission-unknown', submissionStage: 'begun' },
    initialWarning: 'Mint availability cannot be checked right now. Please try again shortly.' });
  const warning = h.nodes.get('[data-mint-observation-warning]');
  assert.equal(warning.hidden, false); assert.equal(warning.dataset.noticeOwner, 'mint-confirmation');
  assert.equal(h.nodes.get('[data-mint-observation-message]').textContent, 'Submission could not be confirmed. Check your wallet activity before trying again.');
  await h.tickStatus(3600000);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.storage.has('sg-sepolia-pending'), true);
  assert.doesNotMatch(h.nodes.get('[data-request-feedback]').className, /open-preview-warning/);
  assert.ok(h.calls.every(call => !['personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction'].includes(call)));
  h.setStatus({ handle: 'somehandle', state: 'pending', transactionHash: HASH }); await h.tickStatus();
  assert.equal(warning.hidden, true); assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.storage.has('sg-sepolia-pending'), true);
});

test('reconnecting separates successful wallet connection from previous-mint recovery at the CTA', async () => {
  const unknown = { handle: 'somehandle', state: 'submission-unknown', submissionStage: 'begun' };
  const marker = JSON.stringify({ version: 1, handle: 'somehandle', wallet: WALLET, chainId: 11155111, contract: CONTRACT });
  const h = await harness({ storage: new Map([['sg-sepolia-pending', marker]]), status: unknown });
  let release; const gate = new Promise(resolve => { release = resolve; });
  h.queueStatus(unknown, gate);
  await h.connect();
  const walletFeedback = h.nodes.get('[data-mint-feedback]'), requestFeedback = h.nodes.get('[data-request-feedback]');
  assert.equal(walletFeedback.textContent, 'Wallet connected.');
  assert.doesNotMatch(walletFeedback.className, /open-preview-warning/);
  assert.equal(requestFeedback.textContent, 'Checking your previous mint…');
  assert.equal(requestFeedback.parentNode, h.nodes.get('[data-mint-action-notice]'));
  assert.equal(h.nodes.get('[data-wallet-label]').textContent, WALLET);
  release(); await flush();
  assert.equal(walletFeedback.textContent, 'Wallet connected.');
  assert.equal(requestFeedback.textContent, 'No new mint will be submitted automatically.');
  assert.equal(h.nodes.get('[data-mint-observation-message]').textContent, 'Submission could not be confirmed. Check your wallet activity before trying again.');
  assert.equal(h.nodes.get('[data-mint-observation-warning]').parentNode, h.nodes.get('[data-mint-action-notice]'));
  assert.equal(h.storage.get('sg-sepolia-pending'), marker);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  await h.tickStatus(); await h.mint();
  assert.equal(walletFeedback.textContent, 'Wallet connected.');
  for (const forbidden of ['/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
});

test('a pending transaction or failed recovery check never makes the successful wallet connection look pending', async () => {
  for (const failed of [false, true]) {
    const h = await harness({ storage: new Map([['sg-sepolia-pending', JSON.stringify({ handle: 'somehandle' })]]),
      status: { handle: 'somehandle', state: 'pending', transactionHash: HASH },
      ...(failed ? { statusError: { code: 'MINT_STATUS_UNAVAILABLE', error: 'Your transaction status could not be checked right now.' } } : {}) });
    await h.connect();
    assert.equal(h.nodes.get('[data-mint-feedback]').textContent, 'Wallet connected.');
    assert.equal(h.nodes.get('[data-request-feedback]').textContent, failed
      ? 'Checking your mint transaction again. No new mint will be submitted automatically.'
      : 'Transaction submitted. Waiting for verified Sepolia inclusion…');
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.storage.has('sg-sepolia-pending'), true);
    for (const forbidden of ['/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  }
});

test('backend authenticated no-submission proof alone releases obsolete local references without submitting', async () => {
  for (const submissionStage of ['none', 'prepared']) {
    const h = await harness({ restoredWallet: true, storage: new Map([['sg-sepolia-pending', JSON.stringify({ handle: 'somehandle' })]]),
      status: { handle: 'somehandle', state: 'not-submitted', submissionStage, recoveryWallet: WALLET } });
    assert.equal(h.storage.has('sg-sepolia-pending'), false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
    assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
    assert.equal(h.nodes.get('[data-request-feedback]').textContent, 'No mint was submitted. You can continue when ready.');
    for (const forbidden of ['eth_requestAccounts', 'personal_sign', '/api/test/prepare', '/api/test/begin', 'eth_sendTransaction']) assert.ok(!h.calls.includes(forbidden));
  }
});

test('missing, different-wallet or begun-stage no-submission responses never clear an ambiguous marker', async () => {
  for (const proof of [{ submissionStage: 'none' }, { submissionStage: 'none', recoveryWallet: CONTRACT },
    { submissionStage: 'begun', recoveryWallet: WALLET }, { recoveryWallet: WALLET }]) {
    const h = await harness({ restoredWallet: true, storage: new Map([['sg-sepolia-pending', JSON.stringify({ handle: 'somehandle' })]]),
      status: { handle: 'somehandle', state: 'not-submitted', ...proof } });
    await h.tickStatus(3600000);
    assert.equal(h.storage.has('sg-sepolia-pending'), true);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
    assert.ok(!h.calls.includes('eth_sendTransaction'));
  }
});

test('new saved references bind recovery to wallet, chain and collection without erasing legacy ambiguity', async () => {
  const sent = await harness({ rejectSend: true }); await sent.connect(); await sent.mint();
  const reference = JSON.parse(sent.storage.get('sg-sepolia-pending'));
  assert.equal(reference.version, 1); assert.equal(reference.wallet, WALLET);
  assert.equal(reference.chainId, 11155111); assert.equal(reference.contract, CONTRACT);
  for (const changed of [{ wallet: CONTRACT }, { chainId: 1 }, { contract: WALLET }, { version: 2 }]) {
    const h = await harness({ restoredWallet: true,
      storage: new Map([['sg-sepolia-pending', JSON.stringify({ ...reference, ...changed })]]),
      status: { handle: 'somehandle', state: 'not-submitted', submissionStage: 'none', recoveryWallet: WALLET } });
    assert.equal(h.storage.has('sg-sepolia-pending'), true);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
    assert.match(h.nodes.get('[data-mint-observation-message]').textContent, /Reconnect the wallet used for this mint/);
    assert.ok(!h.calls.some(call => call.startsWith('/api/test/status?')));
    h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true } }); await flush();
    await h.mint(); assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.ok(!h.calls.includes('/api/test/prepare')); assert.ok(!h.calls.includes('eth_sendTransaction'));
  }
});

test('a saved submission without wallet proof permits explicit recovery sign-in but never automatic resubmission', async () => {
  const h = await harness({ storage: new Map([['sg-sepolia-pending', JSON.stringify({ handle: 'somehandle' })]]),
    status: { handle: 'somehandle', state: 'not-submitted', submissionStage: 'none', recoveryWallet: WALLET } });
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
  assert.equal(h.storage.has('sg-sepolia-pending'), true);
  assert.ok(!h.calls.includes('personal_sign'));
  await h.connect();
  assert.equal(h.storage.has('sg-sepolia-pending'), false);
  assert.equal(h.nodes.get('[data-mint-feedback]').textContent, 'Wallet connected.');
  assert.equal(h.nodes.get('[data-request-submit]').disabled, false);
  assert.equal(h.calls.filter(call => call === 'personal_sign').length, 1);
  assert.ok(!h.calls.includes('/api/test/prepare')); assert.ok(!h.calls.includes('eth_sendTransaction'));
});

test('an integrity failure is immediately actionable even before the transient warning threshold', async () => {
  const h = await harness({ statusError: { code: 'MINT_EVIDENCE_CONFLICT', error: 'Mint availability cannot be checked right now.' } });
  await h.connect(); await h.mint();
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, false);
  assert.equal(h.nodes.get('[data-mint-observation-message]').textContent, 'Mint transaction evidence could not be verified. Check your wallet activity before trying again.');
  assert.doesNotMatch(h.nodes.get('[data-request-feedback]').className, /open-preview-warning/);
  assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
  h.setStatusError('Temporary transport failure'); await h.tickStatus(1);
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, false);
  assert.match(h.nodes.get('[data-mint-observation-message]').textContent, /transaction evidence could not be verified/);
  h.setStatusError(undefined); h.setStatus({ handle: 'somehandle', state: 'pending', transactionHash: HASH }); await h.tickStatus();
  assert.equal(h.nodes.get('[data-mint-observation-warning]').hidden, true);
});

test('an invalid saved reference remains locked rather than being discarded on parsing or status failure', async () => {
  for (const marker of ['{malformed', JSON.stringify({ handle: '<bad>' })]) {
    const h = await harness({ restoredWallet: true, storage: new Map([['sg-sepolia-pending', marker]]) });
    h.windowEvents.get('sg:readiness-changed')({ detail: { mintReady: true } }); await flush();
    await h.mint();
    assert.equal(h.storage.get('sg-sepolia-pending'), marker);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.ok(!h.calls.includes('/api/test/prepare')); assert.ok(!h.calls.includes('eth_sendTransaction'));
  }
});

test('wallet changes during restored ambiguous recovery allow reconnect without allowing a second mint', async () => {
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
    const marker = JSON.stringify({ version: 1, handle: 'somehandle', wallet: WALLET, chainId: 11155111, contract: CONTRACT });
    const h = await harness({ restoredWallet: true, storage: new Map([['sg-sepolia-pending', marker]]),
      status: { handle: 'somehandle', state: 'submission-unknown', submissionStage: 'begun' } });
    assert.equal(h.walletEvents.size, 3);
    h.walletEvents.get(event)([]); await flush();
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.storage.get('sg-sepolia-pending'), marker);
    await h.connect(); await h.mint();
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.storage.get('sg-sepolia-pending'), marker);
    assert.ok(!h.calls.includes('/api/test/prepare')); assert.ok(!h.calls.includes('eth_sendTransaction'));
  }
});

test('late status proofs cannot clear saved recovery while a reconnect sign-in is still in flight', async () => {
  for (const proof of [
    { handle: 'somehandle', state: 'not-submitted', submissionStage: 'none', recoveryWallet: WALLET },
    { handle: 'somehandle', state: 'reverted', transactionHash: HASH },
    RESULT,
  ]) {
    let releaseChallenge, releaseStatus;
    const challengeGate = new Promise(resolve => { releaseChallenge = resolve; });
    const marker = JSON.stringify({ version: 1, handle: 'somehandle', wallet: WALLET, chainId: 11155111, contract: CONTRACT });
    const h = await harness({ restoredWallet: true, challengeGate, storage: new Map([['sg-sepolia-pending', marker]]),
      status: { handle: 'somehandle', state: 'submission-unknown', submissionStage: 'begun' } });
    h.queueStatus(proof, new Promise(resolve => { releaseStatus = resolve; })); await h.tickStatus();
    await h.connect();
    assert.equal(h.nodes.get('[data-connect-wallet] > span').textContent, 'Connecting…');
    releaseStatus(); await flush();
    assert.equal(h.storage.get('sg-sepolia-pending'), marker);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[data-mint-result]').hidden, true);
    assert.equal(h.nodes.get('[data-mint-observation-message]').textContent, 'Submission could not be confirmed. Check your wallet activity before trying again.');
    releaseChallenge(); await flush();
    assert.equal(h.storage.get('sg-sepolia-pending'), marker);
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.ok(!h.calls.includes('eth_sendTransaction'));
  }
});

test('late pre-reconnect no-submission or reverted proofs cannot clear a newer begun submission', async () => {
  for (const oldProof of [
    { handle: 'somehandle', state: 'not-submitted', submissionStage: 'none', recoveryWallet: WALLET },
    { handle: 'somehandle', state: 'reverted', transactionHash: HASH },
  ]) {
    const unknown = { handle: 'somehandle', state: 'submission-unknown', submissionStage: 'begun' };
    const h = await harness({ status: unknown }); await h.connect(); await h.mint();
    let release; const gate = new Promise(resolve => { release = resolve; });
    h.queueStatus(oldProof, gate); await h.tickStatus();
    h.walletEvents.get('accountsChanged')([WALLET]); await flush();
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    // Explicit re-sign-in establishes a new recovery epoch. Its backend
    // proof may resolve the old reference; no mint is sent by that operation.
    h.queueStatus({ handle: 'somehandle', state: 'not-submitted', submissionStage: 'prepared', recoveryWallet: WALLET });
    await h.connect();
    assert.equal(h.storage.has('sg-sepolia-pending'), false);
    assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 1);
    await h.mint();
    const newMarker = h.storage.get('sg-sepolia-pending');
    assert.ok(newMarker); assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 2);
    release(); await flush();
    assert.equal(h.storage.get('sg-sepolia-pending'), newMarker);
    assert.equal(h.nodes.get('[data-request-submit]').disabled, true);
    assert.equal(h.nodes.get('[data-connect-wallet]').disabled, false);
    assert.equal(h.nodes.get('[data-mint-observation-message]').textContent, 'Submission could not be confirmed. Check your wallet activity before trying again.');
    await h.mint(); assert.equal(h.calls.filter(call => call === 'eth_sendTransaction').length, 2);
  }
});

test('cross-chain, cross-wallet or cross-contract plan cannot reach submission-start or the wallet', async () => {
  for (const alteredPlan of [{ chainId: '0x1' }, { from: CONTRACT }, { to: WALLET }]) {
    const h = await harness({ alteredPlan }); await h.connect(); await h.mint();
    assert.ok(!h.calls.includes('/api/test/begin')); assert.ok(!h.calls.includes('eth_sendTransaction'));
    assert.match(h.nodes.get('[data-request-feedback]').textContent, /binding changed/);
  }
});
