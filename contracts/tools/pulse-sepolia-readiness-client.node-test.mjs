import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { SEPOLIA_READINESS_CLIENT } from '../../scripts/pulse-sepolia-readiness-client.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function harness({ mintPage = false, collectionPage = false, previewPage = false, progressPage = false, processPage = false, detailPage = false, mintedDetail = false, resultVisible = false, confirmationNotice = false } = {}) {
  const calls = [], events = [], listeners = new Map(), timers = [], localFeedback = [];
  let now = 1000000;
  const warning = { hidden: false, dataset: confirmationNotice ? { noticeOwner: 'mint-confirmation' } : {} }, message = { textContent: confirmationNotice ? 'Confirmation status could not be checked.' : 'Unavailable' };
  let state = { chainId: 11155111, mintReady: false, revision: 'cold', notice: 'Unavailable' }, fail = false, pageFail = false, gate;
  const original = { outerHTML: 'empty', replaceWith(next) { root.current = next; } };
  const root = { current: original, querySelector: () => root.current, querySelectorAll: () => [], append(next) { this.current = next; } };
  const selectors = new Map([['[data-mint-observation-warning]', warning], ['[data-mint-observation-message]', message], ['.gallery-shell', root]]);
  if (mintPage) selectors.set('[data-mint-entry]', {});
  if (progressPage) selectors.set('[data-assessment-code]', {});
  if (processPage) selectors.set('[data-mint-process]', {});
  if (detailPage) selectors.set('[data-reveal-monitor]', {});
  if (mintedDetail) selectors.set('.signature-page[data-mint-state="minted"]', {});
  if (resultVisible) selectors.set('[data-mint-result]', { hidden: false });
  if (collectionPage) { selectors.delete('.gallery-shell'); selectors.set('[data-collection-page]', root); }
  const input = { value: 'MyHandle' }, hero = { text: 'Anyone_Can_Sign_Anyone' };
  const mintLabel = { textContent: 'Mint a signature' }, mintStatus = { textContent: '', hidden: true };
  const mintCta = { attributes: { href: '/mint' }, setAttribute(key, value) { this.attributes[key] = value; } };
  const explore = { hidden: false }, collectionLabel = { textContent: 'Mint a signature' };
  if (!mintPage && !collectionPage && !detailPage) {
    selectors.set('[data-home-mint-label]', mintLabel); selectors.set('[data-home-mint-status]', mintStatus);
    selectors.set('[data-home-mint-cta]', mintCta); selectors.set('[data-home-explore]', explore);
  }
  if (collectionPage) { selectors.set('[data-collection-mint-cta]', mintCta); selectors.set('[data-collection-mint-label]', collectionLabel); }
  const bridge = { hidden: false }, bridgeStatus = { hidden: true, textContent: '' };
  if (previewPage) { selectors.set('[data-preview-mint-link]', bridge); selectors.set('[data-preview-sale-status]', bridgeStatus); }
  const context = {
    document: { hidden: false, querySelector: key => selectors.get(key), querySelectorAll: key => key === '[data-inline-warning-message]' ? localFeedback.filter(node => node.dataset.inlineWarningMessage !== undefined) : [] }, location: { pathname: '/', href: 'http://127.0.0.1:3004/', origin: 'http://127.0.0.1:3004' },
    window: { addEventListener: (name, fn) => listeners.set(name, fn), dispatchEvent: event => events.push(event) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }, AbortSignal, URL,
    Date: class extends Date { static now() { return now; } },
    DOMParser: class { parseFromString(html) { return { querySelector: () => ({ querySelector: () => ({ outerHTML: html }) }) }; } },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout: timer => { if (timer) timer.cleared = true; },
    fetch: async (url, options) => {
      calls.push({ url, method: options?.method ?? 'GET' });
      if (gate) await gate;
      if (fail) throw Error('transport');
      if (pageFail && url === '/') throw Error('page transport');
      return { ok: true, json: async () => state, text: async () => state.revision === 'cold' ? 'empty' : 'verified-cards' };
    },
  };
  runInNewContext(SEPOLIA_READINESS_CLIENT, context);
  return { calls, events, listeners, timers, warning, message, root, input, hero, mintLabel, mintStatus, mintCta, explore, collectionLabel, bridge, bridgeStatus,
    localWarning: (text, extra = {}) => {
      const node = { textContent: 'Warning ' + text, className: 'open-feedback preserved open-preview-notice open-preview-warning', dataset: { inlineWarningMessage: text, ...extra } };
      node.classList = { remove: (...names) => { node.className = node.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); } };
      localFeedback.push(node); return node;
    },
    setState: next => { state = next; }, setFail: value => { fail = value; }, setPageFail: value => { pageFail = value; }, setGate: value => { gate = value; },
    now: () => now,
    tick: async (elapsed = 5000) => { now += elapsed; timers.at(-1).fn(); await flush(); } };
}

test('prelaunch updates home href and copy but never opens minting from a contradictory true capability', async () => {
  const h = harness(); await flush();
  h.setState({ chainId: 11155111, mintReady: true, revision: 'same', saleStatus: { phase: 'prelaunch', paused: false } }); await h.tick();
  assert.equal(h.mintCta.attributes.href, '/explore'); assert.equal(h.mintLabel.textContent, 'Explore previews');
  assert.equal(h.mintStatus.textContent, 'Minting coming soon.'); assert.equal(h.explore.hidden, true);
  assert.equal(h.events.at(-1).detail.mintReady, false); assert.equal(h.warning.hidden, true);
  h.setState({ chainId: 11155111, mintReady: true, revision: 'same', saleStatus: { phase: 'free', paused: false } }); await h.tick();
  assert.equal(h.mintCta.attributes.href, '/mint'); assert.equal(h.mintLabel.textContent, 'Free Mint');
  assert.equal(h.explore.hidden, false); assert.equal(h.events.at(-1).detail.mintReady, true);
  assert.ok(h.calls.every(call => call.method === 'GET')); assert.equal(h.input.value, 'MyHandle');
});

test('prelaunch, maintenance and unknown remain distinct on preview and collection invitations', async () => {
  for (const options of [{ previewPage: true }, { collectionPage: true }]) {
    const h = harness(options); await flush();
    for (const [saleStatus, status] of [[{ phase: 'prelaunch', paused: false }, 'Minting coming soon.'],
      [{ phase: 'free', paused: true }, 'Minting is paused.'], [{ phase: 'unknown', paused: false }, 'Checking mint availability…']]) {
      h.setState({ chainId: 11155111, mintReady: false, revision: 'same', saleStatus }); await h.tick();
      if (options.previewPage) { assert.equal(h.bridge.hidden, true); assert.equal(h.bridgeStatus.textContent, status); }
      else assert.equal(h.mintCta.attributes.href, saleStatus.phase === 'prelaunch' ? '/explore' : '/mint');
      assert.equal(h.warning.hidden, true);
    }
    h.setState({ chainId: 11155111, mintReady: true, revision: 'same', saleStatus: { phase: 'paid', paused: false } }); await h.tick();
    if (options.previewPage) { assert.equal(h.bridge.hidden, false); assert.equal(h.bridgeStatus.hidden, true); }
    else assert.equal(h.collectionLabel.textContent, 'Paid Mint');
  }
});

test('home phase changes update CTA/status and notify clients even while readiness stays true', async () => {
  const h = harness(); await flush();
  const free = { phase: 'free', paused: false, freeMinted: 1, freeMintQuota: 4 };
  h.setState({ chainId: 11155111, mintReady: true, revision: 'same', saleStatus: free }); await h.tick();
  assert.equal(h.mintLabel.textContent, 'Free Mint'); assert.equal(h.mintStatus.textContent, 'Free mint open · 1/4 slots used.');
  assert.deepEqual(h.events.at(-1).detail.saleStatus, free); const count = h.events.length;
  await h.tick(); assert.equal(h.events.length, count, 'Unchanged phase/readiness does not repeatedly fetch eligibility');
  h.setState({ chainId: 11155111, mintReady: true, revision: 'same', saleStatus: { ...free, phase: 'paid', freeMinted: 4 } }); await h.tick();
  assert.equal(h.mintLabel.textContent, 'Paid Mint'); assert.equal(h.mintStatus.textContent, 'Paid mint open · Free mint ended.');
  assert.equal(h.events.length, count + 1); assert.equal(h.events.at(-1).detail.saleStatus.phase, 'paid');
  h.setState({ chainId: 11155111, mintReady: false, revision: 'same', saleStatus: { ...free, paused: true } }); await h.tick();
  assert.equal(h.mintStatus.textContent, 'Minting is paused.'); assert.equal(h.warning.hidden, true);
  h.setFail(true); await h.tick(); assert.equal(h.mintStatus.textContent, 'Minting is paused.', 'Transport failure does not fabricate a new phase');
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('unknown phase never advertises free eligibility and missing counts never display invalid quota', async () => {
  const h = harness(); await flush();
  h.setState({ chainId: 11155111, mintReady: false, revision: 'same', saleStatus: { phase: 'unknown', paused: false } }); await h.tick();
  assert.equal(h.mintLabel.textContent, 'Mint a signature'); assert.equal(h.mintStatus.textContent, 'Checking mint availability…');
  h.setState({ chainId: 11155111, mintReady: true, revision: 'same', saleStatus: { phase: 'free', paused: false, freeMinted: 9, freeMintQuota: 4 } }); await h.tick();
  assert.equal(h.mintStatus.textContent, 'Free mint open.'); assert.equal(h.warning.hidden, true);
});

test('open gallery recovers automatically using GET only, preserving hero, inputs and user consent', async () => {
  const h = harness(); await flush(); assert.equal(h.root.current.outerHTML, 'empty');
  h.setState({ chainId: 11155111, mintReady: true, revision: 'healthy' }); await h.tick();
  assert.equal(h.root.current.outerHTML, 'verified-cards'); assert.equal(h.warning.hidden, true);
  assert.equal(h.events.at(-1).detail.mintReady, true); assert.equal(h.input.value, 'MyHandle'); assert.equal(h.hero.text, 'Anyone_Can_Sign_Anyone');
  assert.ok(h.calls.every(call => call.method === 'GET' && ['/api/test/capabilities', '/'].includes(call.url)));
  h.setFail(true); await h.tick(); assert.equal(h.root.current.outerHTML, 'verified-cards'); assert.equal(h.warning.hidden, true);
  assert.equal(h.events.at(-1).detail.mintReady, true);
  await h.tick(); assert.equal(h.warning.hidden, true); assert.equal(h.message.textContent, '');
  await h.tick(); assert.equal(h.events.at(-1).detail.mintReady, false);
  h.setFail(false); await h.tick(); assert.equal(h.warning.hidden, true); assert.equal(h.events.at(-1).detail.mintReady, true);
});

test('shared admission warnings deduplicate only exactly matching tagged local warning bodies', async () => {
  const h = harness({ mintPage: true }); await flush();
  const text = 'Mint availability cannot be checked right now. Please try again shortly.';
  const matching = h.localWarning(text), otherMatching = h.localWarning(text);
  const wallet = h.localWarning('Wallet changed. Connect it again.');
  const confirmation = h.localWarning(text, { noticeOwner: 'mint-confirmation' });
  const longer = h.localWarning(text + ' Do not submit another mint.');
  const untagged = h.localWarning(text); delete untagged.dataset.inlineWarningMessage;
  h.setState({ chainId: 11155111, mintReady: false, mintState: 'unavailable', revision: 'outage' }); await h.tick();
  assert.equal(h.warning.hidden, false); assert.equal(h.message.textContent, text);
  for (const node of [matching, otherMatching]) {
    assert.equal(node.textContent, ''); assert.equal(node.className, 'open-feedback preserved');
    assert.equal(node.dataset.inlineWarningMessage, undefined);
  }
  for (const node of [wallet, confirmation, longer, untagged]) {
    assert.ok(node.textContent.startsWith('Warning ')); assert.match(node.className, /open-preview-warning/);
  }
  assert.equal(h.events.at(-1).detail.mintReady, false);
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('deduplication does not erase recovery progress or confirmation-owned notices', async () => {
  const text = 'Mint availability cannot be checked right now. Please try again shortly.';
  const h = harness({ mintPage: true }); await flush();
  const local = h.localWarning(text);
  h.setState({ chainId: 11155111, mintReady: false, mintState: 'unavailable', revision: 'outage' }); await h.tick();
  local.textContent = 'Wallet connected.';
  h.setState({ chainId: 11155111, mintReady: true, mintState: 'ready', revision: 'recovered' }); await h.tick();
  assert.equal(h.warning.hidden, true); assert.equal(local.textContent, 'Wallet connected.');
  h.setState({ chainId: 11155111, mintReady: false, mintState: 'unavailable', revision: 'outage-again' }); await h.tick();
  assert.equal(local.textContent, 'Wallet connected.');
  for (const options of [{ mintPage: true, confirmationNotice: true }, { mintPage: true, resultVisible: true }, { processPage: true, detailPage: true }, { collectionPage: true }]) {
    const guarded = harness(options); await flush();
    const untouched = guarded.localWarning(text);
    guarded.setState({ chainId: 11155111, mintReady: false, mintState: 'unavailable', revision: 'outage' }); await guarded.tick();
    assert.equal(untouched.textContent, 'Warning ' + text);
    assert.equal(untouched.dataset.inlineWarningMessage, text);
    assert.match(untouched.className, /open-preview-warning/);
  }
});

test('a failed HTML refresh does not erase successful capability evidence and retries the same revision', async () => {
  const h = harness(); await flush();
  h.setPageFail(true); h.setState({ chainId: 11155111, mintReady: true, revision: 'healthy' }); await h.tick();
  assert.equal(h.events.at(-1).detail.mintReady, true); assert.equal(h.warning.hidden, true);
  assert.equal(h.root.current.outerHTML, 'empty');
  h.setPageFail(false); await h.tick(); assert.equal(h.root.current.outerHTML, 'verified-cards');
});

test('mint notices distinguish checking, pause and failed admission from gallery failure', async () => {
  const h = harness({ mintPage: true }); await flush();
  h.setState({ chainId: 11155111, mintReady: false, mintState: 'checking', revision: 'checking' }); await h.tick();
  assert.equal(h.warning.hidden, true); assert.equal(h.events.at(-1).detail.mintReady, false);
  h.setState({ chainId: 11155111, mintReady: false, mintState: 'paused', revision: 'paused' }); await h.tick();
  assert.equal(h.warning.hidden, true);
  h.setState({ chainId: 11155111, mintReady: true, mintState: 'ready', revision: 'gallery-error', notice: 'Gallery updates could not be checked.' }); await h.tick();
  assert.equal(h.warning.hidden, true); assert.equal(h.events.at(-1).detail.mintReady, true);
  h.setState({ chainId: 11155111, mintReady: false, mintState: 'unavailable', revision: 'sale-error' }); await h.tick();
  assert.equal(h.warning.hidden, false); assert.match(h.message.textContent, /Mint availability/);
  h.setState({ chainId: 11155111, mintReady: false, mintState: 'halted', safetyHalted: true, revision: 'legacy-conflict', notice: 'Gallery updates could not be checked.' }); await h.tick();
  assert.equal(h.message.textContent, 'Previously verified mints need to be checked before minting can continue.');
});

test('ownership-only revisions refresh a collection silently despite ownership failures', async () => {
  const h = harness({ collectionPage: true }); await flush(); const before = h.calls.length;
  h.setState({ chainId: 11155111, mintReady: true, revision: 'cold', collectionRevision: 'owners-2',
    ownershipNotice: 'Ownership updates could not be checked.' }); await h.tick();
  assert.ok(h.calls.length >= before + 2); assert.equal(h.warning.hidden, true); assert.equal(h.message.textContent, '');
  h.setState({ chainId: 11155111, mintReady: true, revision: 'cold', collectionRevision: 'owners-3' }); await h.tick();
  assert.equal(h.warning.hidden, true);
});

test('viewer documents silently clear old gallery, ownership and integrity banners, including during polling failure', async () => {
  for (const options of [{}, { collectionPage: true }, { detailPage: true }]) {
    const h = harness(options);
    // Clear old SSR warnings without waiting for a capability request.
    assert.equal(h.warning.hidden, true); assert.equal(h.message.textContent, '');
    await flush();
    for (const notice of ['Gallery updates could not be checked.', 'Previously verified mints need to be checked before minting can continue.']) {
      h.warning.hidden = false; h.message.textContent = notice;
      h.setState({ chainId: 11155111, mintReady: false, mintState: 'halted', safetyHalted: true,
        revision: notice, notice, ownershipNotice: 'Ownership history needs to be checked.' });
      await h.tick(); assert.equal(h.warning.hidden, true); assert.equal(h.message.textContent, '');
      assert.equal(h.events.at(-1).detail.mintReady, false);
    }
    h.setFail(true); h.warning.hidden = false; h.message.textContent = 'Old warning';
    await h.tick(); await h.tick(); assert.equal(h.warning.hidden, true); assert.equal(h.message.textContent, '');
  }
});

test('mint entry and progress retain actionable admission and transport warnings without gallery notices', async () => {
  for (const options of [{ mintPage: true }, { progressPage: true }, { processPage: true }]) {
    const h = harness(options); await flush();
    h.setState({ chainId: 11155111, mintReady: false, mintState: 'halted', safetyHalted: true, revision: 'conflict',
      mintNotice: 'Minting is paused while a previous mint is checked.', notice: 'Gallery updates could not be checked.' });
    await h.tick(); assert.equal(h.warning.hidden, false); assert.equal(h.message.textContent, 'Minting is paused while a previous mint is checked.');
    h.setState({ chainId: 11155111, mintReady: true, mintState: 'ready', revision: 'ready', notice: 'Gallery updates could not be checked.' });
    await h.tick(); assert.equal(h.warning.hidden, true);
    h.setFail(true); await h.tick(); assert.equal(h.warning.hidden, true); assert.equal(h.events.at(-1).detail.mintReady, true);
    await h.tick(); await h.tick(); assert.equal(h.warning.hidden, true); assert.equal(h.events.at(-1).detail.mintReady, false);
    await h.tick(); assert.equal(h.warning.hidden, false); assert.match(h.message.textContent, /^Mint availability cannot be checked/);
    h.setFail(false); await h.tick(); assert.equal(h.warning.hidden, true); assert.equal(h.events.at(-1).detail.mintReady, true);
  }
});

test('general readiness cannot clear or replace confirmation notices owned by the mint result', async () => {
  for (const options of [{ mintPage: true, confirmationNotice: true }, { processPage: true, confirmationNotice: true }, { mintPage: true, resultVisible: true }, { processPage: true, detailPage: true }]) {
    const h = harness(options); const priorMessage = h.message.textContent; await flush();
    for (const state of [
      { mintReady: true, mintState: 'ready' },
      { mintReady: false, mintState: 'unavailable' },
      { mintReady: false, mintState: 'halted', safetyHalted: true, mintNotice: 'New mint paused.' },
    ]) {
      h.setState({ chainId: 11155111, revision: JSON.stringify(state), ...state }); await h.tick();
      assert.equal(h.warning.hidden, false); assert.equal(h.message.textContent, priorMessage);
      assert.equal(h.events.at(-1).detail.mintReady, state.mintReady);
    }
    h.setFail(true); await h.tick(); await h.tick();
    assert.equal(h.warning.hidden, false); assert.equal(h.message.textContent, priorMessage);
    assert.equal(h.events.at(-1).detail.mintReady, false);
  }
});

test('completed minted process clears obsolete admission notices, but a new entry still checks admission', async () => {
  const result = harness({ processPage: true, mintedDetail: true }); await flush();
  assert.equal(result.warning.hidden, true); assert.equal(result.message.textContent, '');
  result.setState({ chainId: 11155111, mintReady: false, mintState: 'unavailable', revision: 'outage' }); await result.tick();
  result.setFail(true); await result.tick(); await result.tick();
  assert.equal(result.warning.hidden, true); assert.equal(result.message.textContent, '');
  assert.equal(result.events.at(-1).detail.mintReady, false);
  const entry = harness({ mintPage: true, mintedDetail: true }); await flush();
  entry.setState({ chainId: 11155111, mintReady: false, mintState: 'unavailable', revision: 'outage' }); await entry.tick();
  assert.equal(entry.warning.hidden, false); assert.match(entry.message.textContent, /Mint availability/);
});
test('wrong-chain capabilities cannot enable minting, and a late pre-BFCache result cannot update the restored page', async () => {
  const h = harness(); await flush(); h.setState({ chainId: 1, mintReady: true, revision: 'wrong' }); await h.tick();
  assert.equal(h.events.at(-1).detail.mintReady, false); assert.equal(h.root.current.outerHTML, 'empty');
  let release; h.setGate(new Promise(resolve => { release = resolve; })); const pending = h.tick();
  h.listeners.get('pagehide')(); release(); await pending; assert.equal(h.root.current.outerHTML, 'empty');
  h.setGate(undefined); h.setState({ chainId: 11155111, mintReady: true, revision: 'healthy' });
  h.listeners.get('pageshow')({ persisted: true }); await flush();
  assert.equal(h.root.current.outerHTML, 'verified-cards'); assert.equal(h.warning.hidden, true);
});

test('capability transport grace expires after 15 seconds and never outlives verified sale evidence', async () => {
  for (const evidenceAge of [0, 85000]) {
    const h = harness({ mintPage: true }); await flush();
    h.setState({ chainId: 11155111, mintReady: true, mintState: 'ready', revision: 'ready', lastSaleCheckedAt: h.now() + 5000 - evidenceAge });
    await h.tick(); assert.equal(h.events.at(-1).detail.mintReady, true);
    h.setFail(true); await h.tick(1000);
    assert.equal(h.events.at(-1).detail.mintReady, true); assert.equal(h.warning.hidden, true);
    if (evidenceAge) { await h.tick(4000); assert.equal(h.events.at(-1).detail.mintReady, false); }
    else { await h.tick(13000); assert.equal(h.events.at(-1).detail.mintReady, true); await h.tick(1000); assert.equal(h.events.at(-1).detail.mintReady, false); }
    assert.equal(h.warning.hidden, true);
    await h.tick(15000); assert.equal(h.warning.hidden, false);
    assert.equal(h.message.textContent, 'Mint availability cannot be checked right now. Please try again shortly.');
    assert.ok(h.calls.every(call => call.method === 'GET'));
  }
});

test('explicit pause, conflict and wrong chain revoke a recent true capability immediately', async () => {
  for (const blocking of [{ mintReady: false, mintState: 'paused' }, { mintReady: true, mintState: 'paused' },
    { mintReady: false, mintState: 'halted', safetyHalted: true }, { chainId: 1, mintReady: true }]) {
    const h = harness({ mintPage: true }); await flush();
    h.setState({ chainId: 11155111, mintReady: true, mintState: 'ready', revision: 'ready' }); await h.tick();
    h.setState({ chainId: 11155111, revision: 'blocked', ...blocking }); await h.tick(1);
    assert.equal(h.events.at(-1).detail.mintReady, false);
    h.setFail(true); await h.tick(1); assert.equal(h.events.at(-1).detail.mintReady, false);
  }
});
