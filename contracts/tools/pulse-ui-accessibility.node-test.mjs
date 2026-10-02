import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessibilityFixture, auditTargetEndpoint, connectCdp, launchAccessibilityChrome, runAccessibilityAudit, UI_ACCESSIBILITY_MATRIX } from '../../scripts/pulse-ui-accessibility.mjs';
import { OPEN_MINT_CSS } from '../../src/openMint/pages.ts';
import { SEPOLIA_ADMIN_CSS } from '../../scripts/pulse-sepolia-admin-page.mjs';

test('offline browser audit covers mobile widths, zoom reflow, themes and sale phases', () => {
  assert.equal(UI_ACCESSIBILITY_MATRIX.length, 48);
  for (const page of ['home', 'mint', 'admin']) for (const theme of ['light', 'dark']) for (const width of [320, 375, 390, 640])
    assert.ok(UI_ACCESSIBILITY_MATRIX.some(entry => entry.page === page && entry.theme === theme && entry.width === width));
  assert.ok(UI_ACCESSIBILITY_MATRIX.filter(entry => entry.width === 640).every(entry => entry.zoom === 2));
  assert.deepEqual([...new Set(UI_ACCESSIBILITY_MATRIX.filter(entry => entry.page === 'mint').map(entry => entry.phase))], ['free', 'paid', 'unknown']);
});

test('home guidance wraps at readable size and mobile wallet layout preserves address width', () => {
  assert.match(OPEN_MINT_CSS, /\.home-guidance\{font-size:16px;line-height:1\.5;text-align:center;margin/);
  assert.doesNotMatch(OPEN_MINT_CSS, /font-size:min\(16px,2\.4cqi\)/);
  assert.match(OPEN_MINT_CSS, /@media\(max-width:600px\)\{\.open-mint \.mint-entry-wallet \[data-wallet-controls\]\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(SEPOLIA_ADMIN_CSS, /\[data-admin-wallets\]\{[^}]*white-space:pre-wrap;overflow-wrap:anywhere/);
  assert.doesNotMatch(SEPOLIA_ADMIN_CSS, /white-space:pre;overflow-x:auto/);
});

test('real mint/admin templates expose named headings and atomic status updates without replacing artwork controls', () => {
  const mint = accessibilityFixture('mint'), admin = accessibilityFixture('admin');
  assert.match(mint, /<h1 class="visually-hidden">Mint &amp; reveal<\/h1>/);
  assert.match(mint, /aria-labelledby="mint-price-heading"/);
  assert.match(mint, /id="mint-price-heading" data-pulse-title/);
  assert.match(mint, /data-pulse-feedback role="status" aria-atomic="true"/);
  assert.match(admin, /data-admin-state role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(mint, /class="open-handle-input" id="open-handle"/);
  assert.match(mint, /aria-describedby="handle-validation mint-explanation request-feedback"/);
});

test('fixture pages have synthetic data only and load no production wallet/RPC client', () => {
  for (const page of ['home', 'mint', 'admin']) {
    const html = accessibilityFixture(page);
    assert.match(html, /src="\/assets\/qa\.js"/);
    assert.doesNotMatch(html, /src="\/assets\/(?:sepolia(?:-admin|-readiness)?|open-mint)\.js"/);
    assert.doesNotMatch(html, /PRIVATE_KEY|eth_sendTransaction|personal_sign|https:\/\/[^" ]+\.rpc/);
  }
  assert.throws(() => accessibilityFixture('unknown'), /Unknown accessibility fixture/);
});

const endpoint = 'ws://127.0.0.1:12345/devtools/browser/offline-test';
const portFile = () => '12345\n/devtools/browser/offline-test\n';
const missingPortFile = () => { throw Object.assign(Error('Port file not written yet.'), { code: 'ENOENT' }); };
const version = (value = endpoint) => Response.json({ Browser: 'Chrome/offline-test', webSocketDebuggerUrl: value });
function browserFixture({ readActivePort = portFile, onKill } = {}) {
  const child = new EventEmitter(), signals = []; child.pid = 99999; child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const finish = (code = 0, signal = null) => {
    child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal);
    child.stdout.end(); child.stderr.end(); child.emit('close', code, signal);
  };
  child.kill = signal => { signals.push(signal); onKill ? onKill(signal, finish) : queueMicrotask(() => finish(null, signal)); return true; };
  const supervisor = launchAccessibilityChrome('/offline/chrome', '/offline/private-profile', { readActivePort,
    spawnProcess(path, args, options) {
      assert.equal(path, '/offline/chrome'); assert.ok(args.includes('--remote-debugging-port=0'));
      assert.ok(args.includes('--user-data-dir=/offline/private-profile')); assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      return child;
    } });
  return { child, supervisor, signals, finish };
}

test('Chrome readiness uses the private port file without requiring a stderr banner', async () => {
  const h = browserFixture(), urls = [];
  try {
    const ready = await h.supervisor.ready({ probe: async (url, signal) => { urls.push(url); assert.equal(signal.aborted, false); return version(); } });
    assert.deepEqual(urls, ['http://127.0.0.1:12345/json/version']);
    assert.equal(ready.webSocketDebuggerUrl, endpoint); assert.equal(ready.source, 'DevToolsActivePort'); assert.equal(ready.browser, 'Chrome/offline-test');
    assert.equal(h.supervisor.diagnostics().stderrTail, '');
  } finally { await h.supervisor.close(); }
});

test('Chrome readiness retries a partially written port file and a not-yet-ready HTTP endpoint', async () => {
  let reads = 0, probes = 0;
  const h = browserFixture({ readActivePort: () => ++reads < 3 ? '12345\n' : portFile() });
  try {
    const ready = await h.supervisor.ready({ pollMs: 1, probe: async () => { if (++probes === 1) throw Error('Connection refused during startup.'); return version(); } });
    assert.equal(ready.source, 'DevToolsActivePort'); assert.ok(reads >= 4); assert.equal(probes, 2);
  } finally { await h.supervisor.close(); }
});

test('Chrome output is a fallback but still requires HTTP readiness from the same private browser', async () => {
  const h = browserFixture({ readActivePort: missingPortFile });
  h.child.stdout.write(`DevTools listening on ${endpoint}\n`);
  try { assert.equal((await h.supervisor.ready({ probe: async () => version() })).source, 'browser-output'); }
  finally { await h.supervisor.close(); }
});

test('Chrome early exit reports the actual status and stderr instead of waiting for a banner', async () => {
  const h = browserFixture({ readActivePort: missingPortFile }); h.child.stderr.write('Mock Chrome missing runtime library.'); h.finish(127);
  await assert.rejects(h.supervisor.ready(), error => /exited before DevTools/.test(error.message)
    && /Mock Chrome missing runtime library/.test(error.message) && /"exitCode":127/.test(error.message));
  await h.supervisor.close(); assert.deepEqual(h.signals, []);
});

test('Chrome spawn errors preserve their cause and do not try to signal a nonexistent child', async () => {
  const h = browserFixture(), cause = Object.assign(Error('Mock executable disappeared.'), { code: 'ENOENT' });
  h.child.emit('error', cause); h.child.emit('close', null, null);
  await assert.rejects(h.supervisor.ready(), error => error.cause === cause && /could not be spawned/.test(error.message));
  await h.supervisor.close(); assert.deepEqual(h.signals, []);
});

test('Chrome startup timeout retains bounded stdout/stderr diagnostics', async () => {
  const h = browserFixture({ readActivePort: missingPortFile }); h.child.stderr.write('x'.repeat(20000) + 'mock-stderr-tail'); h.child.stdout.write('mock-stdout-tail');
  try {
    await assert.rejects(h.supervisor.ready({ timeoutMs: 5, pollMs: 1 }), /did not become ready.*mock-stderr-tail.*mock-stdout-tail/);
    assert.equal(h.supervisor.diagnostics().stderrTail.length, 16384);
  } finally { await h.supervisor.close(); }
});

test('a hung DevTools HTTP probe is bounded and aborted even if the mock ignores cancellation', async () => {
  const h = browserFixture(); let probeSignal;
  try {
    await assert.rejects(h.supervisor.ready({ timeoutMs: 5, pollMs: 1,
      probe: async (_url, signal) => { probeSignal = signal; return new Promise(() => {}); } }),
    error => /did not become ready/.test(error.message) && /HTTP readiness probe timed out/.test(error.cause?.message));
    assert.equal(probeSignal.aborted, true);
  } finally { await h.supervisor.close(); }
});

test('Chrome never accepts a different browser identity or external DevTools endpoint', async () => {
  const h = browserFixture(), urls = [];
  try {
    await assert.rejects(h.supervisor.ready({ timeoutMs: 5, pollMs: 1,
      probe: async url => { urls.push(url); return version('ws://external.invalid:12345/devtools/browser/not-ours'); } }),
    error => /differs from the spawned private browser/.test(error.cause?.message));
    assert.ok(urls.length > 0 && urls.every(url => url === 'http://127.0.0.1:12345/json/version'));
  } finally { await h.supervisor.close(); }
});

test('Chrome cleanup awaits actual close rather than a fixed sleep or only the exit event', async () => {
  let close;
  const h = browserFixture({ onKill(signal) { h.child.emit('exit', null, signal); close = () => h.child.emit('close', null, signal); } });
  const cleanup = h.supervisor.close(); let settled = false; cleanup.then(() => settled = true);
  await new Promise(accept => setImmediate(accept)); assert.equal(settled, false); assert.equal(h.supervisor.diagnostics().closed, false);
  close(); await cleanup; assert.equal(h.supervisor.diagnostics().closed, true); assert.deepEqual(h.signals, ['SIGTERM']);
});

test('Chrome cleanup force-stops only its owned child after a bounded graceful shutdown', async () => {
  const h = browserFixture({ onKill(signal, finish) { if (signal === 'SIGKILL') queueMicrotask(() => finish(null, signal)); } });
  await h.supervisor.close({ gracefulMs: 5, forceMs: 5 }); assert.deepEqual(h.signals, ['SIGTERM', 'SIGKILL']); assert.equal(h.supervisor.diagnostics().closed, true);
});

test('Chrome cleanup fails visibly if the owned child never closes', async () => {
  const h = browserFixture({ onKill() {} });
  try { await assert.rejects(h.supervisor.close({ gracefulMs: 5, forceMs: 5 }), /Chrome shutdown timed out/); assert.deepEqual(h.signals, ['SIGTERM', 'SIGKILL']); }
  finally { h.finish(null, 'SIGKILL'); }
});

test('late HTTP readiness cannot beat an expired startup deadline when the event loop delays timers', async () => {
  const h = browserFixture();
  try {
    await assert.rejects(h.supervisor.ready({ timeoutMs: 5, probe: async () => {
      const until = Date.now() + 20; while (Date.now() < until) { /* Deliberately delay the timeout callback. */ } return version();
    } }), error => /did not become ready/.test(error.message) && /readiness expired before/.test(error.cause?.message));
  } finally { await h.supervisor.close(); }
});

test('default DevTools readiness probe rejects redirects rather than following them outside the private browser', async () => {
  const original = globalThis.fetch, h = browserFixture(); let options;
  globalThis.fetch = async (url, input) => { assert.equal(url, 'http://127.0.0.1:12345/json/version'); options = input; return version(); };
  try { await h.supervisor.ready(); assert.equal(options.redirect, 'error'); assert.equal(options.signal.aborted, true); }
  finally { globalThis.fetch = original; await h.supervisor.close(); }
});

test('audit target URL must identify the exact created page on the owned loopback browser', () => {
  const targetId = 'offline-page', valid = 'ws://127.0.0.1:12345/devtools/page/offline-page';
  assert.equal(auditTargetEndpoint(endpoint, targetId, [{ id: targetId, webSocketDebuggerUrl: valid }]), valid);
  for (const url of ['ws://external.invalid:12345/devtools/page/offline-page', 'ws://127.0.0.1:54321/devtools/page/offline-page',
    'ws://127.0.0.1:12345/devtools/page/other-page', 'wss://127.0.0.1:12345/devtools/page/offline-page',
    'ws://user:password@127.0.0.1:12345/devtools/page/offline-page', valid + '?other', valid + '#other'])
    assert.throws(() => auditTargetEndpoint(endpoint, targetId, [{ id: targetId, webSocketDebuggerUrl: url }]), /differs from its owned browser/);
  assert.throws(() => auditTargetEndpoint(endpoint, targetId, []), /did not enumerate/);
  assert.throws(() => auditTargetEndpoint('ws://external.invalid:12345/devtools/browser/other', targetId, []), /Invalid audit browser/);
  const source = readFileSync(new URL('../../scripts/pulse-ui-accessibility.mjs', import.meta.url), 'utf8');
  assert.match(source, /fetch\(`http:\/\/\$\{devtoolsOrigin.host\}\/json\/list`, \{ signal: AbortSignal.timeout\(10000\), redirect: 'error' \}\)/);
});

function websocketFixture({ open = true, onSend } = {}) {
  let socket;
  class FakeWebSocket {
    constructor() { socket = this; this.readyState = 0; this.sent = []; this.closes = 0;
      if (open) queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(value) { this.sent.push(JSON.parse(value)); onSend?.(this, this.sent.at(-1)); }
    close() { this.closes++; this.readyState = 3; this.onclose?.(); }
  }
  return { WebSocketClass: FakeWebSocket, get socket() { return socket; } };
}

test('CDP resolves a matching response and rejects pending or subsequent calls on close', async () => {
  const h = websocketFixture(), client = await connectCdp(endpoint, h);
  const completed = client.send('Runtime.evaluate');
  h.socket.onmessage({ data: JSON.stringify({ id: h.socket.sent[0].id, result: { value: 'ok' } }) });
  assert.deepEqual(await completed, { value: 'ok' });
  const pending = client.send('Page.enable'), rejected = assert.rejects(pending, /client closed/); client.close(); await rejected;
  await assert.rejects(client.send('Page.navigate'), /client is closed/); assert.equal(h.socket.sent.length, 2); assert.equal(h.socket.closes, 1);
});

test('a synchronous CDP send failure rejects all pending calls and clears their timers', async () => {
  const cause = Error('Mock socket send failed.'); let fail = false;
  const h = websocketFixture({ onSend() { if (fail) throw cause; } }), client = await connectCdp(endpoint, h);
  const pending = client.send('Page.enable'), rejected = assert.rejects(pending, error => error.cause === cause);
  fail = true; await assert.rejects(client.send('Runtime.evaluate'), error => error.cause === cause); await rejected;
  await assert.rejects(client.send('Page.navigate'), /client is closed/); assert.equal(h.socket.closes, 1);
});

test('malformed CDP messages cannot escape asynchronous transport cleanup', async () => {
  const h = websocketFixture(), client = await connectCdp(endpoint, h);
  const pending = client.send('Page.enable'), rejected = assert.rejects(pending, /malformed message/);
  assert.doesNotThrow(() => h.socket.onmessage({ data: '{malformed' })); await rejected;
  await assert.rejects(client.send('Page.navigate'), /client is closed/); assert.equal(h.socket.closes, 1);
});

test('an unresponsive CDP WebSocket handshake is bounded and closes only its owned socket', async () => {
  const h = websocketFixture({ open: false });
  await assert.rejects(connectCdp(endpoint, { ...h, timeoutMs: 5 }), /handshake timed out/);
  assert.equal(h.socket.readyState, 3); assert.equal(h.socket.closes, 1);
});

test('real child bootstrap failure produces actionable evidence and removes only its disposable profile', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'sg-ui-failed-bootstrap-test-'));
  try {
    // Node is an actual child with invalid Chrome-only switches. No browser,
    // account, private key, paid API, or remote request is involved.
    await assert.rejects(runAccessibilityAudit({ outputDir, chromePath: process.execPath }), /Chrome exited before DevTools/);
    const result = JSON.parse(readFileSync(join(outputDir, 'results.json'), 'utf8'));
    assert.equal(result.stage, 'chrome-startup'); assert.equal(result.completedCases, 0); assert.ok(result.chrome.exitCode > 0);
    assert.match(result.chrome.stderrTail, /bad option/); assert.equal(existsSync(result.chrome.profile), false);
  } finally { rmSync(outputDir, { recursive: true, force: true }); }
});
