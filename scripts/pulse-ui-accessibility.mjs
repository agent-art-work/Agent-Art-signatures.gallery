import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homePage, mintPage, OPEN_MINT_CSS } from '../src/openMint/pages.ts';
import { SITE_CSS } from '../src/v1/siteCss.ts';
import { siteFontAsset } from '../src/v1/fonts.ts';
import { bindHandleValidation } from '../src/openMint/fieldValidation.ts';
import { sepoliaAdminPage, SEPOLIA_ADMIN_CSS } from './pulse-sepolia-admin-page.mjs';
import { SLOGAN_MBTI_HERO_SCRIPT_URL, SLOGAN_MBTI_HERO_SCRIPT } from '../src/brand/sloganMbtiHero.ts';
import { SLOGAN_TOOLTIP_SCRIPT_URL, SLOGAN_TOOLTIP_SCRIPT } from '../src/brand/sloganTooltipScript.ts';
import { FAVICON_URL, FAVICON_SVG } from '../src/brand/favicon.ts';

// Render real templates/styles with synthetic data. No wallet provider, RPC,
// signer, credentials, paid API, or production request journal is loaded.
const WALLET = '0x1234567890123456789012345678901234567890';
const HASH = '0x' + 'a'.repeat(64);
export const UI_ACCESSIBILITY_MATRIX = Object.freeze(['home', 'mint', 'admin'].flatMap(page =>
  (page === 'admin' ? ['free'] : page === 'mint' ? ['free', 'paid', 'unknown'] : ['free', 'paid']).flatMap(phase =>
    ['light', 'dark'].flatMap(theme => [320, 375, 390, 640].map(width => ({ page, phase, theme, width, zoom: width === 640 ? 2 : 1 }))))));
const base = { stylesheetUrl: '/assets/qa.css', clientScriptUrl: '/assets/qa.js', wallet: WALLET, walletVerified: true,
  chainId: '11155111', chainName: 'Ethereum Sepolia', contract: WALLET, pulseMint: true,
  pulseSaleStatus: { phase: 'paid', paused: false }, assessmentSource: 'sample' };

export function accessibilityFixture(page, phase = 'paid') {
  const options = { ...base, pulseSaleStatus: { phase, paused: false } };
  if (page === 'home') return homePage(options, [{ handle: 'abcdefghijklmno', code: 'qa', mbti: 'INFP', imageUrl: '/art.svg', mint: { state: 'confirming' } }]);
  if (page === 'mint') return mintPage('Abcdefghijklmno', options);
  if (page === 'admin') return sepoliaAdminPage({ ...base, adminWallet: WALLET });
  throw Error('Unknown accessibility fixture.');
}

const fixtureScript = `(() => {
  document.querySelectorAll('form').forEach(form => form.addEventListener('submit', event => event.preventDefault()));
  (${bindHandleValidation.toString()})(document);
  document.querySelectorAll('[data-admin-connect],[data-admin-wallets],[data-admin-quota],[data-admin-review]').forEach(node => node.disabled = false);
  const addresses = document.querySelector('[data-admin-wallets]'); if (addresses) addresses.value = ${JSON.stringify([WALLET, WALLET, WALLET].join('\n'))};
  const quota = document.querySelector('[data-admin-quota]'); if (quota) quota.value = '400';
  const pending = document.querySelector('[data-admin-pending]'); if (pending) pending.hidden = false;
  const hash = document.querySelector('[data-admin-pending-hash]'); if (hash) hash.textContent = ${JSON.stringify(HASH)};
  const recovery = document.querySelector('[data-mint-recovery]'); if (recovery) recovery.hidden = false;
  const oldHandle = document.querySelector('[data-mint-recovery-handle]'); if (oldHandle) oldHandle.textContent = '@Abcdefghijklmno';
  const ceiling = document.querySelector('[name=pulse-max-eth]'); if (ceiling) { ceiling.disabled = false; ceiling.value = '0.0001'; }
  document.body.dataset.qaReady = 'true';
})();`;

export async function createAccessibilityFixtureServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost'), pathname = url.pathname;
    const assets = new Map([
      ['/assets/qa.css', [SITE_CSS + OPEN_MINT_CSS, 'text/css']],
      ['/assets/qa.js', [fixtureScript, 'text/javascript']],
      ['/assets/sepolia-admin.css', [SEPOLIA_ADMIN_CSS, 'text/css']],
      [SLOGAN_MBTI_HERO_SCRIPT_URL, [SLOGAN_MBTI_HERO_SCRIPT, 'text/javascript']],
      [SLOGAN_TOOLTIP_SCRIPT_URL, [SLOGAN_TOOLTIP_SCRIPT, 'text/javascript']],
      [new URL(FAVICON_URL, 'http://localhost').pathname, [FAVICON_SVG, 'image/svg+xml']],
      ['/art.svg', ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#000"/><path d="M50 240 Q100 140 155 210 T350 190" stroke="#f4e7c7" stroke-width="12" fill="none"/></svg>', 'image/svg+xml']],
    ]);
    let asset = assets.get(pathname);
    const font = siteFontAsset(pathname); if (font) asset = [font.bytes, font.contentType];
    if (asset) { response.writeHead(200, { 'content-type': asset[1] }); response.end(asset[0]); return; }
    const page = pathname === '/' ? 'home' : pathname.slice(1);
    if (['home', 'mint', 'admin'].includes(page)) { response.writeHead(200, { 'content-type': 'text/html' }); response.end(accessibilityFixture(page, url.searchParams.get('phase') || 'paid')); return; }
    response.writeHead(404); response.end('Unknown fixture asset.');
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(Error('Accessibility fixture server did not close.')), 2000);
    server.close(error => { clearTimeout(timer); error ? reject(error) : accept(); }); server.closeAllConnections();
  }) };
}

const pause = ms => new Promise(accept => setTimeout(accept, ms));

function browserEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' && !url.username && !url.password && !url.search && !url.hash && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port
      && /^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(url.pathname) ? url.href : undefined;
  } catch { return undefined; }
}

// Test-only browser supervision. A fresh private profile's port file is a
// readiness signal; a stderr banner alone neither proves readiness nor life.
export function launchAccessibilityChrome(chromePath, profile, { spawnProcess = spawn,
  readActivePort = () => readFileSync(join(profile, 'DevToolsActivePort'), 'utf8') } = {}) {
  const started = Date.now(), child = spawnProcess(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--disable-gpu',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--no-sandbox', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', stdout = '', spawnError, exited = false, closed = false, exitCode, signal;
  const closedPromise = new Promise(accept => child.once('close', (code, value) => { closed = true; exited = true; exitCode = code; signal = value; accept(); }));
  child.on('error', error => { spawnError = error; });
  child.once('exit', (code, value) => { exited = true; exitCode = code; signal = value; });
  child.stderr?.on('data', value => { stderr = (stderr + value).slice(-16384); });
  child.stdout?.on('data', value => { stdout = (stdout + value).slice(-16384); });
  const diagnostics = () => ({ chromePath, profile, pid: child.pid ?? null, elapsedMs: Date.now() - started, exited, closed,
    exitCode: exitCode ?? child.exitCode ?? null, signal: signal ?? child.signalCode ?? null,
    spawnError: spawnError?.message ?? null, stderrTail: stderr, stdoutTail: stdout });
  const failure = (reason, cause) => Error(`${reason} ${JSON.stringify(diagnostics())}`, cause ? { cause } : undefined);
  const checkAlive = () => {
    if (spawnError) throw failure('Chrome could not be spawned.', spawnError);
    if (exited || child.exitCode !== null && child.exitCode !== undefined || child.signalCode)
      throw failure('Chrome exited before DevTools became ready.');
  };
  const untilClosed = async timeoutMs => {
    let timer;
    try { await Promise.race([closedPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('Chrome shutdown timed out.')), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  };
  return {
    diagnostics,
    async ready({ timeoutMs = 10000, pollMs = 50, probe = (url, abort) => fetch(url, { signal: abort, redirect: 'error' }) } = {}) {
      const deadline = Date.now() + timeoutMs; let lastProbeError;
      while (Date.now() < deadline) {
        checkAlive(); let endpoint, source;
        try {
          const [port, path] = readActivePort().trim().split(/\r?\n/);
          if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535) endpoint = browserEndpoint(`ws://127.0.0.1:${port}${path}`);
          if (endpoint) source = 'DevToolsActivePort';
        } catch (error) { if (error.code !== 'ENOENT') throw failure('Chrome port file could not be read.', error); }
        if (!endpoint) {
          endpoint = browserEndpoint((stderr + stdout).match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]);
          if (endpoint) source = 'browser-output';
        }
        if (endpoint) {
          const stop = new AbortController(); let timer;
          try {
            const version = await Promise.race([Promise.resolve().then(async () => {
              const response = await probe(`http://${new URL(endpoint).host}/json/version`, stop.signal);
              assert.equal(response.status, 200); return response.json();
            }), new Promise((_, reject) => { timer = setTimeout(() => { stop.abort(); reject(Error('DevTools HTTP readiness probe timed out.')); }, Math.min(1000, deadline - Date.now())); })]);
            checkAlive(); assert.ok(Date.now() < deadline && !stop.signal.aborted, 'DevTools readiness expired before its response could be accepted.');
            assert.equal(browserEndpoint(version.webSocketDebuggerUrl), endpoint, 'DevTools endpoint differs from the spawned private browser.');
            return { webSocketDebuggerUrl: endpoint, source, elapsedMs: Date.now() - started, browser: version.Browser ?? null };
          } catch (error) { lastProbeError = error; checkAlive(); }
          finally { clearTimeout(timer); stop.abort(); }
        }
        await pause(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      }
      checkAlive(); throw failure(`Chrome DevTools did not become ready within ${timeoutMs}ms.`, lastProbeError);
    },
    async close({ gracefulMs = 2000, forceMs = 2000 } = {}) {
      if (closed) return;
      if (!spawnError && !exited) child.kill('SIGTERM');
      try { await untilClosed(gracefulMs); }
      catch (error) {
        if (closed) return;
        if (spawnError || exited) throw error;
        child.kill('SIGKILL'); await untilClosed(forceMs);
      }
    },
  };
}
export function auditTargetEndpoint(browserWs, targetId, targets) {
  assert.ok(browserEndpoint(browserWs) && /^[a-zA-Z0-9_-]+$/.test(targetId), 'Invalid audit browser or target identity.');
  const target = targets.find(value => value.id === targetId); assert.ok(target, 'Chrome did not enumerate the created audit target.');
  const url = new URL(target.webSocketDebuggerUrl), browser = new URL(browserWs);
  assert.ok(url.protocol === 'ws:' && url.host === browser.host && !url.username && !url.password && !url.search && !url.hash
    && url.pathname === `/devtools/page/${targetId}`, 'Audit target endpoint differs from its owned browser and created page.');
  return url.href;
}

export async function connectCdp(url, { WebSocketClass = WebSocket, timeoutMs = 10000 } = {}) {
  const socket = new WebSocketClass(url), pending = new Map(), listeners = new Map(); let sequence = 0, closed = false, opened = false, rejectHandshake;
  const rejectPending = error => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); } pending.clear(); };
  const terminate = (error, closeSocket = false) => {
    closed = true; rejectPending(error); if (!opened) rejectHandshake?.(error);
    if (closeSocket && socket.readyState !== 2 && socket.readyState !== 3) { try { socket.close(); } catch { /* Preserve the original transport failure. */ } }
  };
  let timer;
  try { await new Promise((accept, reject) => {
    rejectHandshake = reject;
    timer = setTimeout(() => terminate(Error('CDP WebSocket handshake timed out.'), true), timeoutMs);
    socket.onopen = () => { if (!closed) { opened = true; accept(); } };
    socket.onerror = () => terminate(Error('CDP WebSocket handshake failed.'));
    socket.onclose = () => terminate(Error('CDP WebSocket closed before handshake.'));
  }); } catch (error) { terminate(error, true); throw error; } finally { clearTimeout(timer); }
  socket.onerror = () => terminate(Error('CDP WebSocket failed.'), true);
  socket.onclose = () => terminate(Error('CDP WebSocket closed.'));
  socket.onmessage = event => {
    try {
      const message = JSON.parse(event.data), task = pending.get(message.id);
      if (task) { pending.delete(message.id); clearTimeout(task.timer); message.error ? task.reject(Error(message.error.message)) : task.accept(message.result); }
      else for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    } catch (cause) { terminate(Error('CDP received a malformed message or failed event callback.', { cause }), true); }
  };
  return { send(method, params = {}) { return new Promise((accept, reject) => {
    if (closed || socket.readyState !== 1) { reject(Error('CDP client is closed.')); return; }
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { accept, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params })); } catch (cause) { terminate(Error('CDP send failed.', { cause }), true); }
  }); }, on(method, listener) { listeners.set(method, [...listeners.get(method) ?? [], listener]); }, close() { if (!closed) terminate(Error('CDP client closed.'), true); } };
}

export async function runAccessibilityAudit({ outputDir = mkdtempSync(join(tmpdir(), 'sg-ui-accessibility-')), chromePath = process.env.CHROME_PATH } = {}) {
  chromePath ||= ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
  assert.ok(chromePath && existsSync(chromePath), 'Chrome/Chromium required; set CHROME_PATH.');
  mkdirSync(outputDir, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'sg-ui-chrome-'));
  let client, browser, chrome, fixture, startup, failure, stage = 'fixture'; const rows = [], requests = [], errors = [];
  try {
    fixture = await createAccessibilityFixtureServer(); stage = 'chrome-startup';
    chrome = launchAccessibilityChrome(chromePath, profile); startup = await chrome.ready();
    const browserWs = startup.webSocketDebuggerUrl; stage = 'cdp-handshake';
    browser = await connectCdp(browserWs);
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const devtoolsOrigin = new URL(browserWs);
    const targetsResponse = await fetch(`http://${devtoolsOrigin.host}/json/list`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    assert.equal(targetsResponse.status, 200, 'Chrome target enumeration failed.');
    const targets = await targetsResponse.json();
    client = await connectCdp(auditTargetEndpoint(browserWs, targetId, targets)); browser.close(); browser = undefined; stage = 'audit';
    client.on('Network.requestWillBeSent', event => requests.push({ id: event.requestId, url: event.request.url, status: null }));
    client.on('Network.responseReceived', event => { const row = requests.find(row => row.id === event.requestId); if (row) row.status = event.response.status; });
    client.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.text));
    await client.send('Page.enable'); await client.send('Network.enable'); await client.send('Runtime.enable'); await client.send('Accessibility.enable');
    const evaluate = async expression => { const value = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.ok(!value.exceptionDetails, value.exceptionDetails?.text); return value.result.value; };
    for (const entry of UI_ACCESSIBILITY_MATRIX) {
      const { page, phase, width, theme, zoom } = entry, height = zoom === 2 ? 450 : 900;
      await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: zoom, mobile: false });
      await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      await client.send('Page.navigate', { url: `${fixture.origin}/${page === 'home' ? '' : page}?phase=${phase}` });
      const deadline = Date.now() + 10000;
      while (!await evaluate('document.body?.dataset.qaReady === "true"')) { assert.ok(Date.now() < deadline, `${page}: fixture not ready`); await pause(50); }
      await evaluate('document.fonts.ready');
      const geometry = await evaluate(`(() => {
        const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
        const box = element => { const value = element.getBoundingClientRect(); return { left:value.left, right:value.right, width:value.width, height:value.height }; };
        const controls = [...document.querySelectorAll('button:not(:disabled),a[href],input:not([type=hidden]):not(:disabled),textarea:not(:disabled),summary')].filter(visible);
        const overflowing = [...document.querySelectorAll('main,section,form,p,dl,dd,label,button,input,textarea,.auth-sheet')].filter(visible).filter(element => {
          const value = box(element); return value.left < -1 || value.right > innerWidth + 1;
        }).map(element => element.tagName + '.' + element.className);
        const titles = [...document.querySelectorAll('h1')].map(element => element.textContent);
        const guidance = document.querySelector('.home-guidance');
        const navigation = ['.home-return','.collection-shortcut'].map(selector => box(document.querySelector(selector)));
        return { viewport:innerWidth, documentWidth:document.documentElement.scrollWidth, overflowing, controls:controls.map(element => ({ tag:element.tagName, name:element.textContent || element.getAttribute('aria-label') || element.name || element.tagName,...box(element) })),
          titles, navigation, guidanceSize:guidance ? parseFloat(getComputedStyle(guidance).fontSize) : null,
          inputSize:document.querySelector('#open-handle') ? getComputedStyle(document.querySelector('#open-handle')).fontSize : null,
          animations:[...document.querySelectorAll('.slogan-mbti-frame')].map(element => getComputedStyle(element).animationName),
          transitions:controls.filter(element => element.matches('button,input,textarea')).map(element => getComputedStyle(element).transitionDuration) };
      })()`);
      assert.ok(geometry.documentWidth <= width, `${page}/${width}/${theme}: document overflow`);
      assert.deepEqual(geometry.overflowing, [], `${page}/${width}/${theme}: clipped content`);
      assert.ok(geometry.navigation.every(value => value.width >= 44 && value.height >= 44 && value.left >= 0 && value.right <= width), `${page}: navigation targets clipped`);
      assert.ok(geometry.controls.filter(value => ['BUTTON', 'INPUT', 'TEXTAREA'].includes(value.tag)).every(value => value.height >= 48), `${page}: undersized form control`);
      if (page === 'home') { assert.ok(geometry.guidanceSize >= 14, 'Home guidance shrinks below readable UI size.'); assert.ok(geometry.animations.every(value => value === 'none'), 'Reduced motion slogan still animates.'); }
      assert.ok(geometry.transitions.every(value => value === '0s'), `${page}: control ignores reduced motion`);
      const ax = await client.send('Accessibility.getFullAXTree');
      const interactive = ax.nodes.filter(node => !node.ignored && ['button', 'textbox', 'link'].includes(node.role?.value));
      assert.ok(interactive.length > 2 && interactive.every(node => node.name?.value), `${page}: unnamed interactive control`);
      assert.ok(ax.nodes.some(node => !node.ignored && node.role?.value === 'heading' && node.properties?.some(value => value.name === 'level' && value.value?.value === 1)), `${page}: missing accessible page heading`);
      const statuses = ax.nodes.filter(node => !node.ignored && node.role?.value === 'status');
      assert.ok(statuses.length > 0 && statuses.every(node => node.properties?.some(value => value.name === 'live' && value.value?.value === 'polite')), `${page}: missing polite status announcements`);
      if (page === 'mint') {
        const title = phase === 'free' ? 'Free Mint' : phase === 'paid' ? 'Mint price' : 'Mint availability';
        assert.ok(ax.nodes.some(node => !node.ignored && node.role?.value === 'region' && node.name?.value === title), 'Sale section accessible name is stale.');
      }
      if (page === 'admin') assert.equal(await evaluate('document.querySelector("[data-admin-wallets]").value'), [WALLET, WALLET, WALLET].join('\n'), 'Visual allowlist wrapping changed slot rows.');
      const focus = [];
      await evaluate('document.activeElement.blur(); scrollTo(0,0)');
      for (let index = 0; index < 9; index++) {
        await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        const active = await evaluate(`(() => { const element=document.activeElement, style=getComputedStyle(element); return { tag:element.tagName, name:element.textContent || element.getAttribute('aria-label') || element.name, visible:element.getClientRects().length > 0, outline:style.outlineStyle, border:style.borderBottomColor, ink:style.color, input:element.matches('input,textarea') }; })()`);
        assert.ok(active.visible, `${page}: keyboard entered hidden content`);
        if (active.input) { assert.equal(active.border, active.ink, `${page}: missing underline-only field focus`); assert.equal(active.outline, 'none', `${page}: unexpected field focus frame`); }
        if (!active.input && active.tag !== 'BODY') assert.notEqual(active.outline, 'none', `${page}: missing keyboard focus indication on ${active.name}`);
        focus.push({ tag:active.tag, name:active.name });
      }
      if (page === 'mint') {
        const validation = await evaluate(`(() => { const input=document.querySelector('#open-handle'); input.value='not valid!'; input.dispatchEvent(new Event('input')); input.checkValidity(); const error=document.querySelector('[data-handle-validation]'); return {invalid:input.getAttribute('aria-invalid'),hidden:error.hidden,text:error.textContent}; })()`);
        assert.equal(validation.invalid, 'true'); assert.equal(validation.hidden, false); assert.match(validation.text, /1–15/);
      }
      await evaluate('scrollTo(0,0)');
      const screenshot = join(outputDir, `${page}-${phase}-${width}-${theme}${zoom === 2 ? '-zoom200' : ''}.png`);
      const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
      rows.push({ ...entry, screenshot, geometry, accessibleControls:interactive.length, statusRegions:statuses.length, keyboard:focus });
    }
    for (const width of [320, 375, 390, 640]) {
      const group = rows.filter(row => row.width === width), baseline = group[0].geometry.navigation;
      assert.ok(group.every(row => JSON.stringify(row.geometry.navigation) === JSON.stringify(baseline)), `Navigation alignment differs between pages at ${width}px.`);
    }
    assert.deepEqual(errors, [], 'Browser JavaScript exceptions');
    const failedRequests = requests.filter(request => request.status !== 200), externalRequests = requests.filter(request => !request.url.startsWith(fixture.origin));
    assert.deepEqual(failedRequests, [], 'Fixture asset request failures'); assert.deepEqual(externalRequests, [], 'Audit made external requests');
    const result = { matrix:rows, failedRequests, externalRequests, javascriptErrors:errors, networkRequests:requests.length, startup,
      zoomMethod:'200% browser-zoom reflow: 1280×900 physical viewport represented by 640×450 CSS pixels with deviceScaleFactor 2.',
      scope:'Real templates, fonts, CSS, inline validation, keyboard traversal and AX tree; synthetic content only, no wallet signing or RPC. Not a manual screen-reader certification or full mint transaction rehearsal.' };
    writeFileSync(join(outputDir, 'results.json'), JSON.stringify(result, null, 2)); return result;
  } catch (error) {
    failure = error;
    writeFileSync(join(outputDir, 'results.json'), JSON.stringify({ stage, completedCases: rows.length, error: error.stack,
      ...(startup ? { startup } : {}), chrome: chrome?.diagnostics() ?? null }, null, 2));
    throw error;
  } finally {
    const cleanup = [];
    client?.close(); browser?.close();
    try { await chrome?.close(); } catch (error) { cleanup.push(error); }
    try { await fixture?.close(); } catch (error) { cleanup.push(error); }
    // Do not remove a profile until its owning browser has actually stopped.
    if (!chrome || chrome.diagnostics().closed) {
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { cleanup.push(error); }
    }
    if (cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], 'Accessibility audit cleanup failed.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--output-dir');
  runAccessibilityAudit({ ...(index >= 0 ? { outputDir: resolve(process.argv[index + 1]) } : {}) }).then(result =>
    console.log(JSON.stringify({ cases:result.matrix.length, failedRequests:result.failedRequests.length, externalRequests:result.externalRequests.length,
      javascriptErrors:result.javascriptErrors.length, evidence:join(resolve(result.matrix[0].screenshot, '..'), 'results.json') }))).catch(error => { console.error(error); process.exitCode = 1; });
}
