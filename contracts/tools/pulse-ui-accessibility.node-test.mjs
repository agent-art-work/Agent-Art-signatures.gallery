import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessibilityFixture, accessibilityFixtureOptions, assertPhaseSurface, expectedExplorerRedirect, createAccessibilityFixtureServer, auditTargetEndpoint, connectCdp, launchAccessibilityChrome, probePrivateDevtools, accessibilityFailureEvidence, runAccessibilityAudit, UI_ACCESSIBILITY_MATRIX } from '../../scripts/pulse-ui-accessibility.mjs';
import { OPEN_MINT_CSS } from '../../src/openMint/pages.ts';
import { SEPOLIA_ADMIN_CSS } from '../../scripts/pulse-sepolia-admin-page.mjs';

test('offline browser audit covers mobile widths, zoom reflow, themes and sale phases', () => {
  const original = ['home', 'mint', 'admin'].flatMap(page =>
    (page === 'admin' ? ['free'] : page === 'mint' ? ['free', 'paid', 'unknown'] : ['free', 'paid']).flatMap(phase =>
      ['light', 'dark'].flatMap(theme => [320, 375, 390, 640].map(width => ({ page, phase, theme, width, zoom:width === 640 ? 2 : 1 })))));
  assert.deepEqual(UI_ACCESSIBILITY_MATRIX.slice(0, 48), original, 'The mandatory original 48 cases were changed or removed.');
  assert.equal(UI_ACCESSIBILITY_MATRIX.length, 128);
  assert.equal(new Set(UI_ACCESSIBILITY_MATRIX.map(entry => JSON.stringify(entry))).size, 128, 'Duplicate matrix cases hide missing coverage.');
  assert.ok(Object.isFrozen(UI_ACCESSIBILITY_MATRIX) && UI_ACCESSIBILITY_MATRIX.every(Object.isFrozen));
  for (const page of ['home', 'mint', 'admin', 'explore']) for (const theme of ['light', 'dark']) for (const width of [320, 375, 390, 640])
    assert.ok(UI_ACCESSIBILITY_MATRIX.some(entry => entry.page === page && entry.theme === theme && entry.width === width));
  assert.ok(UI_ACCESSIBILITY_MATRIX.filter(entry => entry.width === 640).every(entry => entry.zoom === 2));
  for (const page of ['home', 'mint']) for (const theme of ['light', 'dark']) for (const width of [320, 375, 390, 640]) {
    assert.equal(UI_ACCESSIBILITY_MATRIX.filter(entry => entry.page === page && entry.phase === 'prelaunch' && entry.theme === theme && entry.width === width).length, 1);
    for (const phase of ['free', 'paid']) assert.equal(UI_ACCESSIBILITY_MATRIX.filter(entry => entry.page === page && entry.phase === phase && entry.paused && entry.theme === theme && entry.width === width).length, 1);
  }
  for (const phase of ['prelaunch', 'free', 'paid', 'unknown']) assert.equal(UI_ACCESSIBILITY_MATRIX.filter(entry => entry.page === 'explore' && entry.phase === phase).length, 8);
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
  for (const page of ['home', 'mint', 'admin', 'explore']) {
    const html = accessibilityFixture(page);
    assert.match(html, /src="\/assets\/qa\.js"/);
    assert.doesNotMatch(html, /src="\/assets\/(?:sepolia(?:-admin|-readiness)?|open-mint)\.js"/);
    assert.doesNotMatch(html, /PRIVATE_KEY|eth_sendTransaction|personal_sign|https:\/\/[^" ]+\.rpc/);
  }
  assert.throws(() => accessibilityFixture('unknown'), /Unknown accessibility fixture/);
});

test('fixture launch is explicit while unknown and maintenance retain the underlying sale identity', () => {
  assert.deepEqual(accessibilityFixtureOptions('prelaunch').pulseSaleStatus, { phase:'prelaunch', paused:false });
  assert.equal(accessibilityFixtureOptions('prelaunch').siteLaunchMode, 'prelaunch');
  assert.equal(accessibilityFixtureOptions('prelaunch').walletVerified, false);
  assert.equal(accessibilityFixtureOptions('prelaunch').wallet, null);
  for (const phase of ['free', 'paid', 'unknown']) for (const paused of [false, true]) {
    const options = accessibilityFixtureOptions(phase, paused);
    assert.equal(options.siteLaunchMode, 'open'); assert.deepEqual(options.pulseSaleStatus, { phase, paused });
  }
  for (const phase of ['paused', '', 'FREE', null]) assert.throws(() => accessibilityFixtureOptions(phase), /Unknown accessibility fixture phase/);
  assert.throws(() => accessibilityFixtureOptions('paid', 'true'), /maintenance state must be explicit/);
});

test('pre-launch SSR uses exploration only without wallet, paid or mint submission controls', () => {
  for (const page of ['home', 'mint', 'explore']) for (const paused of [false, true]) {
    const html = accessibilityFixture(page, 'prelaunch', paused);
    assert.match(html, /Minting coming soon/);
    assert.doesNotMatch(html, /data-wallet-controls|data-connect-wallet|data-assessment-request|data-request-submit|data-mint-process|data-pulse-options|name="pulse-max-eth"/);
    for (const link of html.match(/<a\b[^>]*href="\/mint(?:"|\?)[^>]*>/g) ?? []) assert.match(link, /\shidden(?:\s|>)/, 'Pre-launch contains visible mint navigation.');
    assert.doesNotMatch(html, /Free mint coming soon|Minting is paused|<strong[^>]*>Warning<\/strong>/);
    if (page === 'home') assert.match(html, /href="\/explore" data-home-mint-cta[^>]*>[\s\S]*?<span data-home-mint-label>Explore previews<\/span>/);
    else {
      assert.match(html, /data-preview-explorer data-site-phase="prelaunch"/);
      assert.match(html, /data-preview-explore-form method="get" action="\/explore"/);
      assert.match(html, /id="explore-handle"[^>]*aria-describedby="handle-validation explore-explanation"/);
      assert.match(html, /data-explore-submit><span>Explore previews<\/span>/);
    }
  }
});

test('anonymous explorer remains wallet-free in every phase and never loads production wallet/RPC code', () => {
  for (const phase of ['prelaunch', 'free', 'paid', 'unknown']) for (const paused of [false, true]) {
    const html = accessibilityFixture('explore', phase, paused);
    assert.match(html, new RegExp(`data-preview-explorer data-site-phase="${phase}"`));
    assert.match(html, /data-preview-explore-form method="get" action="\/explore"/);
    assert.doesNotMatch(html, /data-wallet-controls|data-assessment-request|data-request-submit|name="pulse-max-eth"|src="\/assets\/(?:sepolia|open-mint)\.js"/);
    const mintLink = html.match(/<a\b[^>]*data-explorer-mint-link[^>]*>/)?.[0]; assert.ok(mintLink);
    assert.equal(/\shidden(?:\s|>)/.test(mintLink), phase === 'prelaunch' || phase === 'unknown' || paused);
  }
});

test('a maintenance overlay preserves free/paid labels and never impersonates pre-launch', () => {
  for (const phase of ['free', 'paid']) {
    const home = accessibilityFixture('home', phase, true), mint = accessibilityFixture('mint', phase, true);
    assert.match(home, /Minting is paused\./);
    assert.match(home, new RegExp(`<span data-home-mint-label>${phase === 'free' ? 'Free Mint' : 'Paid Mint'}<\\/span>`));
    assert.match(mint, new RegExp(`data-pulse-phase="${phase}"`));
    assert.match(mint, /Minting is paused\. You can still explore previews\./);
    assert.doesNotMatch(home + mint, /Minting coming soon|data-preview-explorer/);
  }
});

const explorerSurface = () => ({ visibleWarnings:[],walletAccesses:0,walletControls:0,paidFields:0,mintMarkers:[],visibleMintLinks:[],
  phaseStatus:'Minting coming soon.',explorerPhase:'prelaunch',explorerForm:{method:'get',action:'/explore',submit:'Explore previews'},
  explorerMintLink:{visible:false,label:'Explore previews',href:'/mint'} });
test('browser phase assertions reject unsafe pre-launch UI even when the template looks otherwise valid', () => {
  const entry = { page:'explore',phase:'prelaunch' }, base = explorerSurface();
  assert.doesNotThrow(() => assertPhaseSurface(entry, base));
  for (const patch of [{visibleWarnings:['RPC unavailable']},{walletAccesses:1},{walletControls:1},{paidFields:1},{mintMarkers:['[data-request-submit]']},
    {visibleMintLinks:['/mint']},{phaseStatus:'Minting is paused.'},{explorerPhase:'paid'},
    {explorerForm:{...base.explorerForm,method:'post'}},{explorerForm:{...base.explorerForm,action:'/api/mint'}},
    {explorerForm:{...base.explorerForm,submit:'Mint & reveal'}},{explorerMintLink:{...base.explorerMintLink,visible:true}}]) {
    assert.throws(() => assertPhaseSurface(entry, { ...base,...patch }));
  }
});

test('browser home and explorer phase assertions reject stale labels, destinations and maintenance gates', () => {
  for (const phase of ['prelaunch', 'free', 'paid', 'unknown']) for (const paused of [false, true]) {
    const surface = explorerSurface(), label = {prelaunch:'Explore previews',free:'Free Mint',paid:'Paid Mint',unknown:'Mint a signature'}[phase];
    Object.assign(surface,{phaseStatus:phase === 'prelaunch' ? 'Minting coming soon.' : paused ? 'Minting is paused.' : '',
      primary:{label,href:phase === 'prelaunch' ? '/explore' : '/mint'}});
    assert.doesNotThrow(() => assertPhaseSurface({page:'home',phase,paused}, surface));
    assert.throws(() => assertPhaseSurface({page:'home',phase,paused}, {...surface,primary:{...surface.primary,href:'/wrong'}}));
    assert.throws(() => assertPhaseSurface({page:'home',phase,paused}, {...surface,primary:{...surface.primary,label:'Stale phase'}}));
    Object.assign(surface,{explorerPhase:phase,explorerMintLink:{visible:['free','paid'].includes(phase) && !paused,label,href:'/mint'}});
    assert.doesNotThrow(() => assertPhaseSurface({page:'explore',phase,paused}, surface));
    assert.throws(() => assertPhaseSurface({page:'explore',phase,paused}, {...surface,explorerMintLink:{...surface.explorerMintLink,visible:!surface.explorerMintLink.visible}}));
  }
});

test('browser mint assertions preserve phase, maintenance and fresh-quote admission before enabling CTA', () => {
  for (const phase of ['free', 'paid', 'unknown']) for (const paused of [false, true]) {
    const entry = {page:'mint',phase,paused}, surface = {...explorerSurface(),mintPhase:phase,mintPaused:paused,submitDisabled:true,paidInputDisabled:true};
    assert.doesNotThrow(() => assertPhaseSurface(entry, surface));
    for (const patch of [{mintPhase:'prelaunch'},{mintPaused:!paused},{submitDisabled:false},...(paused ? [{paidInputDisabled:false}] : [])])
      assert.throws(() => assertPhaseSurface(entry, {...surface,...patch}));
  }
});

test('only the exact anonymous explorer same-origin redirect is exempt from failed-request assertions', () => {
  const origin = 'http://127.0.0.1:45678';
  const request = { url:origin+'/explore?handle=%40Artist_QA',method:'GET',status:302,redirect:'/p/Artist_QA/variations' };
  assert.equal(expectedExplorerRedirect(request, origin), true);
  for (const patch of [{status:200},{status:307},{method:'POST'},{url:origin+'/api/mint?handle=Artist_QA'},
    {url:'http://outside.invalid/explore?handle=Artist_QA'},{url:origin+'/explore?handle=not%20valid'},
    {redirect:'http://outside.invalid/p/Artist_QA/variations'},{redirect:'/p/SomeoneElse/variations'},
    {redirect:'/p/Artist_QA/variations?mint=true'},{redirect:'/p/Artist_QA/variations#mint'}, {redirect:'http://['}])
    assert.equal(expectedExplorerRedirect({...request,...patch}, origin), false);
});

test('offline explorer supports anonymous GET fallback and locally serves all16 previews without API routes', async () => {
  const fixture = await createAccessibilityFixtureServer();
  const fetchLocal = path => fetch(fixture.origin + path, { redirect:'manual',signal:AbortSignal.timeout(10000) });
  try {
    const entry = await fetchLocal('/explore?phase=prelaunch'); assert.equal(entry.status, 200);
    assert.match(await entry.text(), /data-preview-explorer data-site-phase="prelaunch"/);
    const navigation = await fetchLocal('/explore?handle=%40Artist_QA'); assert.equal(navigation.status, 302);
    assert.equal(navigation.headers.get('location'), '/p/Artist_QA/variations');
    const previews = await fetchLocal(navigation.headers.get('location')); assert.equal(previews.status, 200);
    const html = await previews.text(); assert.equal((html.match(/class="open-preview-card"/g) ?? []).length, 16);
    assert.doesNotMatch(html, /data-wallet-controls|data-assessment-request|data-request-submit/);
    for (const link of html.match(/<a\b[^>]*href="\/mint(?:"|\?)[^>]*>/g) ?? []) assert.match(link, /\shidden(?:\s|>)/);
    for (const source of [...html.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map(match=>match[1])) {
      const image = await fetchLocal(source.replaceAll('&amp;', '&')); assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/svg+xml');
    }
    assert.equal((await fetchLocal('/api/mint')).status, 404);
    assert.equal((await fetch(fixture.origin+'/api/mint', {method:'POST',signal:AbortSignal.timeout(10000)})).status, 405);
  } finally { await fixture.close(); }
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
    assert.equal(ready.attempts, 1); assert.equal(ready.transport, 'injected-test-probe');
    assert.deepEqual(h.supervisor.diagnostics().readiness, { attempts: 1, portFile: 'valid', phase: 'ready',
      probes: [{ attempt: 1, source: 'DevToolsActivePort', phase: 'identity', elapsedMs: h.supervisor.diagnostics().readiness.probes[0].elapsedMs,
        status: 200, errorCode: null, outcome: 'ready' }] });
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

test('a hung DevTools HTTP probe is bounded and aborted even if the mock ignores cancellation', async t => {
  // Enter the probe before spending its budget: runner scheduling is not the
  // transport refusal under test. Keep the exact five-millisecond deadline.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = browserFixture(); let probeSignal;
  try {
    const pending = h.supervisor.ready({ timeoutMs: 5, pollMs: 1,
      probe: async (_url, signal) => { probeSignal = signal; return new Promise(() => {}); } });
    pending.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(probeSignal?.aborted, false);
    t.mock.timers.tick(4); await new Promise(resolve => setImmediate(resolve));
    assert.equal(probeSignal.aborted, false);
    t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve));
    assert.equal(probeSignal.aborted, true);
    t.mock.timers.tick(0); // Complete the expired readiness loop's final pause.
    await assert.rejects(pending,
    error => /did not become ready/.test(error.message) && /HTTP readiness probe timed out/.test(error.cause?.message));
    assert.equal(probeSignal.aborted, true);
  } finally { t.mock.timers.reset(); await h.supervisor.close(); }
});

test('Chrome never accepts a different browser identity or external DevTools endpoint', async t => {
  // Identity rejection must precede startup expiry. A coherent clock keeps a
  // busy runner from replacing the security failure with a pre-probe timeout.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = browserFixture(), urls = []; let probeSignal;
  try {
    const pending = h.supervisor.ready({ timeoutMs: 5, pollMs: 1,
      probe: async (url, signal) => { urls.push(url); probeSignal = signal; return version('ws://external.invalid:12345/devtools/browser/not-ours'); } });
    pending.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(probeSignal?.aborted, true, 'The mismatched identity is rejected before the startup deadline advances.');
    t.mock.timers.tick(5);
    await assert.rejects(pending,
    error => /differs from the spawned private browser/.test(error.cause?.message));
    assert.ok(urls.length > 0 && urls.every(url => url === 'http://127.0.0.1:12345/json/version'));
  } finally { t.mock.timers.reset(); await h.supervisor.close(); }
});

test('Chrome cleanup awaits actual close rather than a fixed sleep or only the exit event', async () => {
  let close;
  const h = browserFixture({ onKill(signal) { h.child.emit('exit', null, signal); close = () => h.child.emit('close', null, signal); } });
  const cleanup = h.supervisor.close(); let settled = false; cleanup.then(() => settled = true);
  await new Promise(accept => setImmediate(accept)); assert.equal(settled, false); assert.equal(h.supervisor.diagnostics().closed, false);
  close(); await cleanup; assert.equal(h.supervisor.diagnostics().closed, true); assert.deepEqual(h.signals, ['SIGTERM']);
});

test('Chrome cleanup releases only owned inherited pipes after verified exit and still awaits actual child close', async () => {
  let finish;
  const h = browserFixture({onKill(signal) { h.child.emit('exit', 0, signal); finish=()=>h.child.emit('close', 0, signal); }});
  assert.equal(h.child.stdout.destroyed, false); assert.equal(h.child.stderr.destroyed, false);
  const cleanup = h.supervisor.close(); let settled = false; cleanup.then(()=>settled=true);
  await new Promise(accept=>setImmediate(accept));
  assert.equal(h.child.stdout.destroyed, true); assert.equal(h.child.stderr.destroyed, true);
  assert.equal(h.supervisor.diagnostics().exited, true); assert.equal(h.supervisor.diagnostics().closed, false);
  assert.equal(settled, false, 'Destroyed pipes are not a substitute for actual child close.');
  assert.deepEqual(h.signals, ['SIGTERM']); finish(); await cleanup;
  assert.equal(h.supervisor.diagnostics().closed, true);
});

test('Chrome cleanup never signals an already exited PID when a descendant retains its pipes', async () => {
  const h = browserFixture(); h.child.exitCode = 0; h.child.emit('exit',0,null);
  assert.equal(h.child.stdout.destroyed, false); assert.equal(h.child.stderr.destroyed, false);
  const pipesClosed = Promise.all([new Promise(accept=>h.child.stdout.once('close',accept)),new Promise(accept=>h.child.stderr.once('close',accept))]);
  pipesClosed.then(()=>h.child.emit('close',0,null));
  await h.supervisor.close();
  assert.deepEqual(h.signals, []); assert.equal(h.supervisor.diagnostics().closed, true);
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

async function privateDevtoolsFixture(handler) {
  const requests = [], server = createServer((request, response) => { requests.push({ path: request.url, host: request.headers.host }); handler(request, response); });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const port = server.address().port;
  return { requests, port, origin: `http://127.0.0.1:${port}`, endpoint: `ws://127.0.0.1:${port}/devtools/browser/offline-test`,
    close: () => new Promise((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); }) };
}

test('direct DevTools readiness is independent of a hung global fetch dispatcher and records its successful phases', async () => {
  const fixture = await privateDevtoolsFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ Browser: 'Chrome/offline-test', webSocketDebuggerUrl: fixture.endpoint }));
  });
  const original = globalThis.fetch, h = browserFixture({ readActivePort: () => `${fixture.port}\n/devtools/browser/offline-test\n` }); let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; return new Promise(() => {}); };
  try {
    const ready = await h.supervisor.ready();
    assert.equal(ready.webSocketDebuggerUrl, fixture.endpoint); assert.equal(ready.transport, 'direct-loopback-http'); assert.equal(ready.attempts, 1);
    assert.equal(fetchCalls, 0); assert.deepEqual(fixture.requests, [{ path: '/json/version', host: `127.0.0.1:${fixture.port}` }]);
    const probe = h.supervisor.diagnostics().readiness.probes[0];
    assert.equal(probe.phase, 'identity'); assert.equal(probe.status, 200); assert.equal(probe.outcome, 'ready');
  } finally { globalThis.fetch = original; await h.supervisor.close(); await fixture.close(); }
});

test('direct DevTools rejects redirects without contacting the redirect location', async () => {
  const fixture = await privateDevtoolsFixture((_request, response) => { response.writeHead(302, { location: 'http://outside.invalid/json/version' }); response.end(); });
  const progress = [];
  try {
    await assert.rejects(probePrivateDevtools(fixture.origin + '/json/version', AbortSignal.timeout(1000), (...value) => progress.push(value)), { code: 'DEVTOOLS_HTTP_STATUS' });
    assert.equal(fixture.requests.length, 1); assert.ok(progress.some(value => value[0] === 'body' && value[1] === 302));
  } finally { await fixture.close(); }
});

test('direct DevTools rejects malformed and oversized JSON without retaining its response text', async () => {
  for (const [body, code] of [['private-invalid-json', 'DEVTOOLS_INVALID_JSON'], ['x'.repeat(65537), 'DEVTOOLS_BODY_LIMIT']]) {
    const fixture = await privateDevtoolsFixture((_request, response) => { response.writeHead(200); response.end(body); });
    try {
      await assert.rejects(probePrivateDevtools(fixture.origin + '/json/version', AbortSignal.timeout(1000)), error => error.code === code && !error.message.includes(body));
    } finally { await fixture.close(); }
  }
});

test('direct DevTools distinguishes refused connections and truncated response bodies without following another endpoint', async () => {
  const closedFixture = await privateDevtoolsFixture(() => {}); await closedFixture.close();
  const progress = [];
  await assert.rejects(probePrivateDevtools(closedFixture.origin + '/json/version', AbortSignal.timeout(1000), (...value) => progress.push(value)), { code: 'ECONNREFUSED' });
  assert.deepEqual(progress, [['connect']]);
  let response;
  const fixture = await privateDevtoolsFixture((_request, value) => { response = value; response.writeHead(200, { 'content-length': 1000 }); response.write('{'); });
  try {
    await assert.rejects(probePrivateDevtools(fixture.origin + '/json/version', AbortSignal.timeout(1000), phase => {
      if (phase === 'body') queueMicrotask(() => response.destroy());
    }), { code: 'DEVTOOLS_BODY_INCOMPLETE' });
    assert.equal(fixture.requests.length, 1);
  } finally { await fixture.close(); }
});

test('a direct DevTools body stall is cancelled and diagnosed at its actual phase within the existing startup budget', async t => {
  const fixture = await privateDevtoolsFixture((_request, response) => { response.writeHead(200); response.write('{"Browser":'); });
  const h = browserFixture({ readActivePort: () => `${fixture.port}\n/devtools/browser/offline-test\n` });
  let enteredBody; const body = new Promise(resolve => { enteredBody = resolve; });
  // Real socket traffic establishes the body stall before the exact synthetic
  // deadline advances. Busy CI scheduling must not replace it with connect lag.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  try {
    const pending = h.supervisor.ready({ timeoutMs: 150, pollMs: 1, probe: (url, signal, progress) => probePrivateDevtools(url, signal,
      (phase, status) => { progress(phase, status); if (phase === 'body') enteredBody(); }) });
    pending.catch(() => {}); await body;
    t.mock.timers.tick(149); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.supervisor.diagnostics().readiness.probes[0].outcome, 'pending');
    t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(0);
    await assert.rejects(pending, /did not become ready within 150ms/);
    const diagnostic = h.supervisor.diagnostics();
    assert.equal(diagnostic.exited, false); assert.equal(diagnostic.readiness.portFile, 'valid');
    assert.equal(diagnostic.readiness.probes.at(-1).phase, 'body'); assert.equal(diagnostic.readiness.probes.at(-1).status, 200);
    assert.equal(diagnostic.readiness.probes.at(-1).errorCode, 'DEVTOOLS_PROBE_TIMEOUT'); assert.equal(diagnostic.readiness.probes.at(-1).outcome, 'failed');
    assert.equal(diagnostic.readiness.attempts, 1);
  } finally { t.mock.timers.reset(); await h.supervisor.close(); await fixture.close(); }
});

test('direct DevTools probes refuse foreign, ambiguous or credential-bearing URLs before making any request', () => {
  for (const url of ['http://outside.invalid:12345/json/version', 'https://127.0.0.1:12345/json/version', 'http://127.0.0.1/json/version',
    'http://127.0.0.1:12345/json/version?token=private', 'http://user:password@127.0.0.1:12345/json/version',
    'http://127.0.0.1:12345/json/version#other', 'http://127.0.0.1:12345/other'])
    assert.throws(() => probePrivateDevtools(url, AbortSignal.timeout(1000)), /Invalid private DevTools probe URL/);
});

test('Chrome readiness never widens its total ten-second deadline or accepts an unbounded polling interval', async () => {
  const h = browserFixture();
  try {
    for (const timeoutMs of [10001, 0, NaN, Infinity, 1.5]) await assert.rejects(h.supervisor.ready({ timeoutMs }), /bounded at ten seconds/);
    for (const pollMs of [0, -1, NaN, Infinity, 1.5]) await assert.rejects(h.supervisor.ready({ pollMs }), /positive bounded interval/);
  } finally { await h.supervisor.close(); }
});

test('Chrome readiness retains only bounded classified probe evidence rather than arbitrary failure details', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = browserFixture();
  try {
    const pending = h.supervisor.ready({ timeoutMs: 20, pollMs: 1, probe: async () => { throw Object.assign(Error('private remote response text'), { code: 'private remote code' }); } });
    pending.catch(() => {});
    for (let index = 0; index < 20; index++) { await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(1); }
    await assert.rejects(pending, /did not become ready/);
    const readiness = h.supervisor.diagnostics().readiness;
    assert.equal(readiness.attempts, 20); assert.equal(readiness.probes.length, 8);
    assert.ok(readiness.probes.every(value => value.errorCode === 'DEVTOOLS_PROBE_ERROR' && value.outcome === 'failed'));
    assert.doesNotMatch(JSON.stringify(readiness), /private remote/);
  } finally { t.mock.timers.reset(); await h.supervisor.close(); }
});

test('CI failure evidence allows only synthetic lifecycle/probe facts, never raw browser/error/profile/endpoint data', async () => {
  const h = browserFixture(); h.child.stderr.write('private-browser-stderr'); h.child.stdout.write('private-browser-stdout');
  try {
    await h.supervisor.ready({ probe: async () => version() });
    const evidence = accessibilityFailureEvidence({ stage: 'chrome-startup', completedCases: 0,
      error: Object.assign(Error('private-error-message'), { code: 'PRIVATE_ERROR_CODE', stack: 'private-error-stack' }),
      startup: { webSocketDebuggerUrl: endpoint, source: 'DevToolsActivePort', elapsedMs: 10, attempts: 1,
        transport: 'direct-loopback-http', browser: 'Chrome/154.0.0.1' }, chrome: h.supervisor.diagnostics(), profileRemoved: false });
    assert.equal(evidence.errorCode, 'DEVTOOLS_PROBE_ERROR'); assert.equal(evidence.chrome.exited, false);
    assert.equal(evidence.chrome.profileRemoved, false); assert.equal(evidence.chrome.stderrPresent, true); assert.equal(evidence.chrome.stdoutPresent, true);
    assert.equal(evidence.startup.browser, 'Chrome/154.0.0.1'); assert.equal(evidence.startup.transport, 'direct-loopback-http');
    assert.deepEqual(evidence.chrome.readiness, h.supervisor.diagnostics().readiness);
    for (const key of ['chromePath', 'profile', 'pid', 'stdoutTail', 'stderrTail', 'spawnError']) assert.equal(Object.hasOwn(evidence.chrome, key), false);
    assert.equal(Object.hasOwn(evidence.startup, 'webSocketDebuggerUrl'), false);
    assert.doesNotMatch(JSON.stringify(evidence), /private-browser|private-error|PRIVATE_ERROR_CODE|offline\/private-profile|99999|ws:\/\//);
  } finally { await h.supervisor.close(); }
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
  assert.match(source, /probePrivateDevtools\(`http:\/\/\$\{devtoolsOrigin.host\}\/json\/list`, AbortSignal.timeout\(10000\)\)/);
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
    assert.equal(result.chrome.stderrPresent, true); assert.equal(result.chrome.closed, true); assert.equal(result.chrome.profileRemoved, true);
    for (const key of ['error', 'stack']) assert.equal(Object.hasOwn(result, key), false);
    for (const key of ['chromePath', 'profile', 'pid', 'stdoutTail', 'stderrTail', 'spawnError']) assert.equal(Object.hasOwn(result.chrome, key), false);
  } finally { rmSync(outputDir, { recursive: true, force: true }); }
});
