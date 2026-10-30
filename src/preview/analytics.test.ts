// @ts-nocheck -- offline browser fixtures ported verbatim from AgentArt.work's analytics tests.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createAnalytics, ANALYTICS_ORIGIN, ANALYTICS_PREFERENCE_KEY as preferenceKey,
  ANALYTICS_EXCLUSION_KEY as exclusionKey, ANALYTICS_PROBE_KEY as probeKey,
  ANALYTICS_CHANNEL, ANALYTICS_COOKIE_PREFIX, ANALYTICS_CHOICE_MS,
  ANALYTICS_ROUTES, ANALYTICS_PREVIEWS, parseAnalyticsPreference, analyticsScreen,
  analyticsEnvironmentAllowed, analyticsKnownAutomation, analyticsContext,
  ANALYTICS_MBTI_TYPES,
} from './analytics.js';
import { MBTI_TYPES } from '../openMint/identity.js';

// Entirely offline DOM/controller fixtures. No fetch, browser or real SDK.
const inertId = 'G-LOCALONLY01';
const enabled = { enabled: true, production: true, measurementId: inertId };
const disabledFlag = `ga-disable-${inertId}`;
const epoch = 1_800_000_000_000;
const valid = (choice = 'allow', expiresAt = epoch + ANALYTICS_CHOICE_MS) => JSON.stringify({ choice, version: 1, expiresAt });

class Target {
  handlers = new Map();
  addEventListener(name, callback) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.handlers.get(name)?.delete(callback); }
  dispatch(name, event = {}) { for (const fn of [...(this.handlers.get(name) ?? [])]) fn(event); }
}

function fixtureGroup({ broadcast = true } = {}) {
  const data = new Map(), tabs = [], channels = new Set(), pending = [];
  function tab({ url = ANALYTICS_ORIGIN, config = enabled, failure, webdriver = false, userAgent = 'Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36' } = {}) {
    const win = new Target(), doc = new Target();
    let time = epoch, nextTimer = 1;
    const writes = [], scripts = new Set(), createdScripts = [], timers = new Map(), notices = [], cookieWrites = [];
    const cookieJar = new Map([['unrelated', 'keep']]);
    const fake = { win, doc, scripts, createdScripts, writes, cookieJar, cookieWrites, timers, notices, failure,
      readHook: null, reloads: 0, start: () => createAnalytics({ window: win, document: doc, config, onChange: state => notices.push(state) }) };
    win.location = new URL(url);
    win.navigator = { webdriver, userAgent };
    win.Date = { now: () => time };
    win.setTimeout = (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, at: time + delay }); return id; };
    win.clearTimeout = id => timers.delete(id);
    fake.advance = amount => {
      time += amount;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    };
    win.history = Object.fromEntries(['pushState', 'replaceState'].map(method => [method, (_data, _unused, value) => {
      if (value != null) win.location = new URL(String(value), win.location.href);
    }]));
    win.document = doc;
    const storage = {
      getItem(key) {
        if (fake.failure === 'read') throw new Error('blocked read');
        const old = data.get(key) ?? null;
        if (key === preferenceKey && fake.readHook) { const hook = fake.readHook; fake.readHook = null; hook(); }
        return old;
      },
      setItem(key, value) {
        if (['write', 'write-and-remove'].includes(fake.failure) || (fake.failure === 'choice-write' && key === preferenceKey)) throw new Error('blocked write');
        if (fake.failure === 'silent-choice-write' && key === preferenceKey) return;
        writes.push({ key, value: String(value) });
        const oldValue = data.get(key) ?? null;
        data.set(key, String(value));
        if (oldValue !== String(value)) for (const other of tabs) if (other !== fake) {
          pending.push(() => other.win.dispatch('storage', { key, oldValue, newValue: String(value) }));
        }
      },
      removeItem(key) {
        if (['remove', 'write-and-remove'].includes(fake.failure)) throw new Error('blocked removal');
        const oldValue = data.get(key) ?? null;
        data.delete(key);
        if (oldValue !== null) for (const other of tabs) if (other !== fake) {
          pending.push(() => other.win.dispatch('storage', { key, oldValue, newValue: null }));
        }
      },
    };
    Object.defineProperty(win, 'localStorage', { get() { if (fake.failure === 'access') throw new Error('no storage'); return storage; } });
    if (broadcast) win.BroadcastChannel = class extends Target {
      constructor(name) { super(); this.name = name; channels.add(this); }
      postMessage(value) {
        if (fake.failure === 'channel') throw new Error('no channel');
        for (const channel of channels) if (channel !== this && channel.name === this.name) {
          pending.push(() => { if (channels.has(channel)) channel.dispatch('message', { data: value }); });
        }
      }
      close() { channels.delete(this); }
    };
    doc.referrer = 'https://private.example/secret-path?prompt=SENTINEL#draft';
    doc.title = 'Private title SENTINEL';
    Object.defineProperty(doc, 'cookie', {
      get: () => [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; '),
      set(value) {
        cookieWrites.push(value);
        const [name, content] = value.split(';')[0].split('=');
        if (value.includes('Max-Age=0')) cookieJar.delete(name); else cookieJar.set(name, content);
      },
    });
    doc.createElement = name => {
      assert.equal(name, 'script');
      const script = { remove: () => scripts.delete(script) };
      createdScripts.push(script);
      return script;
    };
    doc.head = { append: script => scripts.add(script) };
    tabs.push(fake);
    return fake;
  }
  function flush() {
    let count = 0;
    while (pending.length) {
      if (++count > 1000) throw new Error('Cross-tab storage feedback');
      pending.shift()();
    }
  }
  return { data, tabs, channels, pending, tab, flush };
}

const queue = tab => (tab.win.signaturesAnalyticsLayer ?? []).map(args => Array.from(args));

test('build and production gates fail closed', () => {
  assert.equal(analyticsEnvironmentAllowed(enabled, ANALYTICS_ORIGIN), true);
  for (const config of [{}, { ...enabled, enabled: false }, { ...enabled, enabled: 'true' },
    { ...enabled, production: false }, { ...enabled, production: 'true' },
    { ...enabled, measurementId: null }, { ...enabled, measurementId: 'G-TESTONLY01' },
    { ...enabled, measurementId: 'arbitrary' }]) {
    assert.equal(analyticsEnvironmentAllowed(config, ANALYTICS_ORIGIN), false);
  }
  for (const url of ['http://signatures.gallery/', 'https://www.signatures.gallery/', 'http://127.0.0.1:8877/',
    'https://staging.signatures.gallery/', 'https://signatures-gallery.workers.dev/', 'https://user:pass@signatures.gallery/']) {
    assert.equal(analyticsEnvironmentAllowed(enabled, url), false);
  }
  assert.equal(analyticsEnvironmentAllowed(enabled, ANALYTICS_ORIGIN, true), false);
});

test('only exact bounded consent records are accepted', () => {
  assert.equal(parseAnalyticsPreference(valid(), epoch).choice, 'allow');
  assert.equal(parseAnalyticsPreference(valid('reject'), epoch).choice, 'reject');
  for (const raw of [null, '', '{', 'null', '[]', '{}', valid('allow', epoch), valid('allow', epoch - 1),
    valid('allow', epoch + ANALYTICS_CHOICE_MS + 1), valid('maybe'),
    JSON.stringify({ choice: 'allow', expiresAt: epoch + 1, version: 2 }),
    JSON.stringify({ choice: 'allow', expiresAt: epoch + 1, version: 1, user: 'secret' }),
    JSON.stringify({ choice: 'allow', expiresAt: 'tomorrow', version: 1 })]) {
    assert.equal(parseAnalyticsPreference(raw, epoch), null, String(raw));
  }
});

test('known automation is excluded locally without using it as a human identity claim', () => {
  assert.equal(analyticsKnownAutomation({ webdriver: false, userAgent: 'Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36' }), false);
  for (const userAgent of ['Mozilla/5.0 HeadlessChrome/156.0.0.0', 'Googlebot/2.1', 'ChatGPT-User/1.0', 'ClaudeBot', 'bingbot/2.0']) {
    assert.equal(analyticsKnownAutomation({ webdriver: false, userAgent }), true);
    const group = fixtureGroup(); group.data.set(preferenceKey, valid());
    const tab = group.tab({ userAgent }); assert.equal(tab.start().status().eligible, false); assert.equal(tab.scripts.size, 0);
  }
});

test('closed coarse categories never include page text, query, fragment, referrer or article identity', () => {
  for (const [path, category] of Object.entries(ANALYTICS_ROUTES)) {
    assert.deepEqual(analyticsScreen(`${ANALYTICS_ORIGIN}${path}#private-fragment`), category);
  }
  assert.deepEqual(analyticsScreen(`${ANALYTICS_ORIGIN}/about`), ANALYTICS_ROUTES['/about/']);
  assert.deepEqual(analyticsScreen(`${ANALYTICS_ORIGIN}/INTJ/`), ANALYTICS_ROUTES['/ENFP/']);
  for (const path of ['/p/Alice_Bob_Key/variations', '/p/Alice_Bob_Key/ENFP', '/p/x/INTJ']) {
    assert.deepEqual(analyticsScreen(`${ANALYTICS_ORIGIN}${path}`), ANALYTICS_PREVIEWS, path);
  }
  for (const path of ['/?preview=1', '/?', '/?utm_source=private', '/explore?handle=Alice_Bob_Key', '/mint', '/me',
    '/p/Alice_Bob_Key/ABCD', '/p/Alice_Bob_Key', '/s/Alice_Bob_Key/ENFP', '/preview/Alice/ENFP.svg', '/agent-index.json',
    '/robots.txt', '/health/ready', '/api/mint', '/404.html', '/secret', '/__proto__/', '/about//']) {
    assert.equal(analyticsScreen(`${ANALYTICS_ORIGIN}${path}`), null, path);
  }
  const preview = analyticsScreen(`${ANALYTICS_ORIGIN}/p/Alice_Bob_Key/ENFP`);
  assert.deepEqual(analyticsContext(preview), { page_location: `${ANALYTICS_ORIGIN}/previews/`, page_title: 'Previews',
    page_referrer: '', campaign_id: '', campaign_source: '', campaign_medium: '', campaign_name: '',
    campaign_term: '', campaign_content: '' });
});

test('unknown, refused, invalid and expired choices never load a script or create analytics cookies', () => {
  for (const stored of [null, valid('reject'), valid('allow', epoch - 1), '{', '{}']) {
    const group = fixtureGroup();
    if (stored !== null) group.data.set(preferenceKey, stored);
    const tab = group.tab(); const controller = tab.start();
    assert.equal(controller.status().allowed, false);
    assert.equal(tab.scripts.size, 0);
    assert.equal(tab.createdScripts.length, 0);
    assert.equal(queue(tab).length, 0);
    assert.equal(tab.win[disabledFlag], true);
    assert.deepEqual([...tab.cookieJar], [['unrelated', 'keep']]);
  }
});

test('disabled and excluded environments do not persist an attempted grant', () => {
  for (const options of [{ config: {} }, { url: 'http://127.0.0.1:8877/' }, { webdriver: true },
    { url: `${ANALYTICS_ORIGIN}/?preview=1` }, { url: `${ANALYTICS_ORIGIN}/agent-index.json` }]) {
    const group = fixtureGroup(); const tab = group.tab(options); const controller = tab.start();
    assert.equal(controller.allow().allowed, false);
    assert.equal(group.data.has(preferenceKey), false);
    assert.equal(tab.scripts.size, 0);
  }
});

test('explicit allowance queues only sanitized native configuration and pageview', () => {
  const group = fixtureGroup(); const tab = group.tab(); const controller = tab.start();
  assert.equal(controller.allow().allowed, true);
  assert.equal(tab.scripts.size, 1);
  assert.equal(tab.win[disabledFlag], false);
  const script = tab.createdScripts[0];
  assert.equal(script.src, `https://www.googletagmanager.com/gtag/js?id=${inertId}&l=signaturesAnalyticsLayer`);
  assert.equal(script.referrerPolicy, 'no-referrer');
  const commands = queue(tab), config = commands.find(([action]) => action === 'config')[2];
  assert.deepEqual(commands[0], ['consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }]);
  assert.equal(config.cookie_domain, 'none'); assert.equal(config.cookie_path, '/');
  assert.equal(config.cookie_prefix, ANALYTICS_COOKIE_PREFIX); assert.equal(config.cookie_update, false);
  assert.equal(config.cookie_expires, ANALYTICS_CHOICE_MS / 1000); assert.equal(config.cookie_flags, 'SameSite=Lax;Secure');
  assert.equal(config.send_page_view, false); assert.equal(config.allow_google_signals, false);
  assert.equal(config.allow_ad_personalization_signals, false); assert.equal(config.allow_enhanced_conversions, false);
  assert.equal(config.user_id, null); assert.equal(config.url_passthrough, false);
  assert.deepEqual(config.linker, { domains: [], accept_incoming: false, decorate_forms: false });
  assert.equal(commands.filter(([action, event]) => action === 'event' && event === 'page_view').length, 1);
  assert.doesNotMatch(JSON.stringify(commands), /SENTINEL|secret-path|private\.example|prompt=/);
  controller.refresh(); script.onload();
  assert.equal(tab.createdScripts.length, 1);
  assert.equal(queue(tab).filter(([action]) => action === 'event').length, 1);
});

test('status and refresh probe separately without rewriting consent or extending expiry', () => {
  const group = fixtureGroup(); const original = valid(); group.data.set(preferenceKey, original);
  const tab = group.tab(); const controller = tab.start();
  controller.status(); controller.refresh(); tab.advance(1000); controller.status();
  assert.deepEqual(tab.writes.filter(({ key }) => key === preferenceKey), []);
  assert.equal(group.data.get(preferenceKey), original);
  assert.equal(group.data.has(probeKey), false);
  const count = tab.writes.length;
  tab.win.dispatch('storage', { key: probeKey, newValue: '1' });
  assert.equal(tab.writes.length, count);
});

test('persisted allowance fails closed on storage access/read/write/probe-removal errors', () => {
  for (const failure of ['access', 'read', 'write', 'remove']) {
    const group = fixtureGroup(); group.data.set(preferenceKey, valid());
    const tab = group.tab({ failure }); const controller = tab.start();
    assert.equal(controller.status().storageAvailable, false, failure);
    assert.equal(controller.status().allowed, false, failure);
    assert.equal(tab.scripts.size, 0, failure);
    assert.equal(group.data.get(preferenceKey), valid(), 'Do not silently overwrite stored choice');
  }
});

test('failed and silently dropped explicit grants cannot enable measurement', () => {
  for (const failure of ['choice-write', 'silent-choice-write']) {
    const group = fixtureGroup(); const tab = group.tab(); const controller = tab.start();
    tab.failure = failure;
    assert.equal(controller.allow().allowed, false);
    assert.equal(controller.status().storageAvailable, false);
    assert.equal(tab.scripts.size, 0);
    tab.failure = undefined;
    assert.equal(controller.allow().allowed, false, 'Failed writes stay blocked in this document');
  }
});

test('a storage failure discovered by status immediately disables an active document', () => {
  const group = fixtureGroup(); const tab = group.tab(); const controller = tab.start(); controller.allow();
  tab.failure = 'read';
  assert.equal(controller.status().allowed, false);
  assert.equal(tab.win[disabledFlag], true);
  assert.equal(tab.scripts.size, 0); assert.equal(queue(tab).length, 0);
});

test('withdrawal stops before persistence, clears only owned cookies and preserves work', () => {
  const group = fixtureGroup(); const tab = group.tab(); const controller = tab.start(); controller.allow();
  group.data.set('reading-position', 'chapter-4'); group.data.set('saved-work', 'private-SENTINEL');
  tab.cookieJar.set(`${ANALYTICS_COOKIE_PREFIX}_ga`, 'client'); tab.cookieJar.set(`${ANALYTICS_COOKIE_PREFIX}_ga_stream`, 'session');
  tab.cookieJar.set(`${ANALYTICS_COOKIE_PREFIX}_ga_other_extra`, 'session');
  tab.cookieJar.set(`${ANALYTICS_COOKIE_PREFIX}_unrelated`, 'keep');
  const setItem = tab.win.localStorage.setItem;
  tab.win.localStorage.setItem = (key, value) => {
    if (key === preferenceKey) assert.equal(tab.win[disabledFlag], true, 'Native disable must precede refusal persistence');
    return setItem(key, value);
  };
  const previousUrl = tab.win.location.href;
  assert.equal(controller.reject().allowed, false);
  assert.equal(controller.status().choice, 'reject'); assert.equal(controller.status().reloadRequired, true);
  assert.equal(tab.win.location.href, previousUrl); assert.equal(tab.scripts.size, 0); assert.equal(queue(tab).length, 0);
  assert.deepEqual([...tab.cookieJar], [['unrelated', 'keep'], [`${ANALYTICS_COOKIE_PREFIX}_unrelated`, 'keep']]);
  assert.equal(group.data.get('reading-position'), 'chapter-4'); assert.equal(group.data.get('saved-work'), 'private-SENTINEL');
  for (const written of tab.cookieWrites) assert.match(written, /; Max-Age=0; Path=\/; SameSite=Lax; Secure$/);
});

test('reallow after withdrawal applies only in a new document and late loader cannot revive the old one', () => {
  const group = fixtureGroup(); const tab = group.tab(); const controller = tab.start(); controller.allow();
  const late = tab.createdScripts[0].onload;
  controller.reject();
  assert.equal(controller.allow().allowed, false);
  assert.equal(controller.status().choice, 'allow'); assert.equal(controller.status().reloadRequired, true);
  late(); controller.refresh(); tab.win.dispatch('pageshow');
  assert.equal(tab.win[disabledFlag], true); assert.equal(tab.scripts.size, 0); assert.equal(tab.createdScripts.length, 1);
  assert.equal(queue(tab).length, 0);
  const next = group.tab(); assert.equal(next.start().status().allowed, true); assert.equal(next.scripts.size, 1);
});

for (const broadcast of [true, false]) {
  test(`stale peer cannot restore withdrawal; tabs and subsequent documents remain refused (BroadcastChannel ${broadcast})`, () => {
    const group = fixtureGroup({ broadcast }); group.data.set(preferenceKey, valid());
    const first = group.tab(), peer = group.tab(); const main = first.start(), other = peer.start(); group.flush();
    assert.equal(first.scripts.size, 1); assert.equal(peer.scripts.size, 1);
    peer.readHook = () => main.reject();
    other.status(); group.flush(); other.refresh();
    const refusal = group.data.get(preferenceKey);
    assert.equal(JSON.parse(refusal).choice, 'reject');
    for (const [tab, controller] of [[first, main], [peer, other]]) {
      assert.equal(controller.status().choice, 'reject'); assert.equal(controller.status().allowed, false);
      assert.equal(tab.win[disabledFlag], true); assert.equal(tab.scripts.size, 0);
    }
    for (let i = 0; i < 3; i++) {
      const next = group.tab(); assert.equal(next.start().status().choice, 'reject'); assert.equal(next.scripts.size, 0);
    }
    group.flush();
    assert.equal(group.data.get(preferenceKey), refusal); assert.equal(group.data.has(probeKey), false);
    assert.equal(peer.writes.filter(({ key }) => key === preferenceKey).length, 0);
  });
}

test('persistent browser exclusion synchronizes tabs and survives a fresh document', () => {
  const group = fixtureGroup(); group.data.set(preferenceKey, valid());
  const first = group.tab(), peer = group.tab(); const main = first.start(), other = peer.start(); group.flush();
  main.exclude(); group.flush();
  assert.equal(group.data.get(exclusionKey), '1');
  for (const [tab, controller] of [[first, main], [peer, other]]) {
    assert.equal(controller.status().excluded, true); assert.equal(controller.status().allowed, false); assert.equal(tab.scripts.size, 0);
  }
  const next = group.tab(); const nextController = next.start();
  assert.equal(nextController.status().excluded, true); assert.equal(next.scripts.size, 0);
  nextController.allow(); assert.equal(next.scripts.size, 0);
  nextController.include(); assert.equal(next.scripts.size, 0, 'Removing exclusion requires a separate allowance');
  assert.equal(nextController.status().choice, 'reject');
  main.include(); assert.equal(main.status().allowed, false, 'Stopped document cannot revive');
  assert.equal(group.data.get(exclusionKey), '0');
});

test('unknown exclusion values fail closed and exclusion works in disabled builds', () => {
  for (const value of ['', 'false', 'garbage', 'true']) {
    const group = fixtureGroup(); group.data.set(preferenceKey, valid()); group.data.set(exclusionKey, value);
    assert.equal(group.tab().start().status().allowed, false);
  }
  const group = fixtureGroup(); const tab = group.tab({ config: {} }); const controller = tab.start();
  controller.exclude(); assert.equal(group.data.get(exclusionKey), '1'); assert.equal(tab.scripts.size, 0);
  controller.include(); assert.equal(group.data.get(exclusionKey), '0'); assert.equal(tab.scripts.size, 0);
});

test('BroadcastChannel can revoke but never grant; close and invalid messages are harmless', () => {
  const group = fixtureGroup(); const tab = group.tab(); const controller = tab.start();
  const channel = new tab.win.BroadcastChannel(ANALYTICS_CHANNEL);
  channel.postMessage('allow'); group.flush(); assert.equal(controller.status().choice, 'unknown'); assert.equal(tab.scripts.size, 0);
  controller.allow(); channel.postMessage('stop'); group.flush();
  assert.equal(controller.status().allowed, false); assert.equal(tab.win[disabledFlag], true);
  assert.equal(controller.status().reloadRequired, true); assert.equal(tab.scripts.size, 0);
});

test('failed refusal removes stale allowance when narrow deletion remains available', () => {
  const group = fixtureGroup(); group.data.set(preferenceKey, valid());
  const first = group.tab(), peer = group.tab(); const main = first.start(), other = peer.start(); group.flush();
  first.failure = 'choice-write'; main.reject(); group.flush();
  assert.equal(main.status().storageAvailable, false); assert.equal(main.status().allowed, false);
  assert.equal(other.status().allowed, false); assert.equal(peer.win[disabledFlag], true);
  assert.equal(group.data.get(preferenceKey), undefined);
  const next = group.tab(); assert.equal(next.start().status().allowed, false); assert.equal(next.scripts.size, 0);
});

test('total storage failure broadcasts stop without claiming durable refusal', () => {
  const group = fixtureGroup(); group.data.set(preferenceKey, valid());
  const first = group.tab(), peer = group.tab(); const main = first.start(), other = peer.start(); group.flush();
  first.failure = 'write-and-remove'; main.reject(); group.flush();
  assert.equal(main.status().storageAvailable, false); assert.equal(main.status().allowed, false);
  assert.equal(other.status().allowed, false); assert.equal(peer.win[disabledFlag], true);
  assert.equal(JSON.parse(group.data.get(preferenceKey)).choice, 'allow', 'Failure cannot promise durable refusal');
});

test('clear-all, deleted and invalid consent storage events revoke current measurement', () => {
  for (const newValue of [null, '{', valid('reject')]) {
    const group = fixtureGroup(); group.data.set(preferenceKey, valid());
    const tab = group.tab(); const controller = tab.start();
    if (newValue === null) group.data.delete(preferenceKey); else group.data.set(preferenceKey, newValue);
    tab.win.dispatch('storage', { key: preferenceKey, newValue });
    assert.equal(controller.status().allowed, false); assert.equal(tab.win[disabledFlag], true); assert.equal(tab.scripts.size, 0);
  }
  const group = fixtureGroup(); group.data.set(preferenceKey, valid());
  const tab = group.tab(); const controller = tab.start(); group.data.clear();
  tab.win.dispatch('storage', { key: null });
  assert.equal(controller.status().allowed, false); assert.equal(tab.scripts.size, 0);
});

test('consent expiry is enforced in active tabs and rechecked on lifecycle events', () => {
  const group = fixtureGroup(); group.data.set(preferenceKey, valid('allow', epoch + 100));
  const tab = group.tab(); const controller = tab.start(); assert.equal(tab.scripts.size, 1);
  tab.advance(100); assert.equal(controller.status().allowed, false); assert.equal(tab.win[disabledFlag], true); assert.equal(tab.scripts.size, 0);
  for (const event of ['focus', 'pageshow', 'visibilitychange']) {
    const otherGroup = fixtureGroup(); otherGroup.data.set(preferenceKey, valid());
    const other = otherGroup.tab(); const active = other.start(); otherGroup.data.delete(preferenceKey);
    (event === 'visibilitychange' ? other.doc : other.win).dispatch(event);
    assert.equal(active.status().allowed, false); assert.equal(other.scripts.size, 0);
  }
});

test('fragment-only navigation does not count; category paths are sanitized; unapproved routes stop before changing history', () => {
  const group = fixtureGroup(); const tab = group.tab(); const controller = tab.start(); controller.allow();
  tab.win.history.pushState({}, '', '/#private-SENTINEL');
  assert.equal(queue(tab).filter(([action]) => action === 'event').length, 1);
  tab.win.history.pushState({}, '', '/about#private-SENTINEL');
  tab.win.history.pushState({}, '', '/p/Priv_SENTINEL/ENFP');
  const events = queue(tab).filter(([action]) => action === 'event');
  assert.deepEqual(events.map(([, , context]) => context.page_location), [ANALYTICS_ORIGIN + '/', ANALYTICS_ORIGIN + '/about/', ANALYTICS_ORIGIN + '/previews/']);
  // The handle in the preview path never reaches the queue.
  assert.doesNotMatch(JSON.stringify(queue(tab)), /SENTINEL/);
  tab.win.history.replaceState({}, '', '/?private=SENTINEL');
  assert.equal(tab.win[disabledFlag], true); assert.equal(tab.scripts.size, 0); assert.equal(queue(tab).length, 0);
  tab.win.history.replaceState({}, '', '/');
  assert.equal(controller.status().allowed, false); assert.equal(tab.createdScripts.length, 1);
});

test('SDK failure blocks measurement and duplicate installation does not load twice', () => {
  const group = fixtureGroup(); const tab = group.tab(); const controller = tab.start();
  assert.equal(tab.start(), controller); controller.allow();
  tab.createdScripts[0].onerror();
  assert.equal(controller.status().allowed, false); assert.equal(controller.status().reloadRequired, true);
  assert.equal(tab.scripts.size, 0); assert.equal(queue(tab).length, 0);
});

test('destroy removes event hooks and timers without clearing preferences or other state', () => {
  const group = fixtureGroup(); const tab = group.tab(); const originalPushState = tab.win.history.pushState;
  const controller = tab.start(); controller.allow(); const preference = group.data.get(preferenceKey);
  controller.destroy();
  assert.equal(controller.status().reason, 'destroyed'); assert.equal(tab.scripts.size, 0); assert.equal(tab.timers.size, 0);
  assert.equal(tab.win.history.pushState, originalPushState); assert.equal(group.channels.size, 0);
  assert.equal(group.data.get(preferenceKey), preference);
  for (const callbacks of tab.win.handlers.values()) assert.equal(callbacks.size, 0);
  for (const callbacks of tab.doc.handlers.values()) assert.equal(callbacks.size, 0);
  controller.allow(); assert.equal(tab.scripts.size, 0);
});

test('the browser-safe MBTI list matches the renderer exactly', () => {
  assert.deepEqual([...ANALYTICS_MBTI_TYPES].sort(), [...MBTI_TYPES].sort());
});
