import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homePage, mintPage, explorePage, previewVariationsPage, OPEN_MINT_CSS } from '../src/openMint/pages.ts';
import { SITE_CSS } from '../src/v1/siteCss.ts';
import { siteFontAsset } from '../src/v1/fonts.ts';
import { bindHandleValidation } from '../src/openMint/fieldValidation.ts';
import { handleVariationsPath } from '../src/openMint/handleLink.ts';
import { preservedHandle } from '../src/openMint/identity.ts';
import { siteSaleStatus, sitePhasePresentation } from '../src/openMint/sitePhase.ts';
import { mintHandleDraft } from '../src/openMint/mintHandleDraft.ts';
import { previewExplorerClient } from './pulse-sepolia-client.mjs';
import { sepoliaAdminPage, SEPOLIA_ADMIN_CSS } from './pulse-sepolia-admin-page.mjs';
import { SLOGAN_MBTI_HERO_SCRIPT_URL, SLOGAN_MBTI_HERO_SCRIPT } from '../src/brand/sloganMbtiHero.ts';
import { SLOGAN_TOOLTIP_SCRIPT_URL, SLOGAN_TOOLTIP_SCRIPT } from '../src/brand/sloganTooltipScript.ts';
import { FAVICON_URL, FAVICON_SVG } from '../src/brand/favicon.ts';

// Render real templates/styles with synthetic data. No wallet provider, RPC,
// signer, credentials, paid API, or production request journal is loaded.
const WALLET = '0x1234567890123456789012345678901234567890';
const HASH = '0x' + 'a'.repeat(64);
const originalCases = ['home', 'mint', 'admin'].flatMap(page =>
  (page === 'admin' ? ['free'] : page === 'mint' ? ['free', 'paid', 'unknown'] : ['free', 'paid']).flatMap(phase =>
    ['light', 'dark'].flatMap(theme => [320, 375, 390, 640].map(width => ({ page, phase, theme, width, zoom: width === 640 ? 2 : 1 })))));
const phaseCases = (page, phase, paused = false) => ['light', 'dark'].flatMap(theme =>
  [320, 375, 390, 640].map(width => ({ page, phase, ...(paused ? { paused } : {}), theme, width, zoom: width === 640 ? 2 : 1 })));
// Keep the original 48 cases intact. Maintenance and unknown availability are
// overlays, never substitutes for the explicit pre-launch lifecycle.
export const UI_ACCESSIBILITY_MATRIX = Object.freeze([...originalCases,
  ...['home', 'mint'].flatMap(page => phaseCases(page, 'prelaunch')),
  ...['prelaunch', 'free', 'paid', 'unknown'].flatMap(phase => phaseCases('explore', phase)),
  ...['home', 'mint'].flatMap(page => ['free', 'paid'].flatMap(phase => phaseCases(page, phase, true))),
].map(Object.freeze));
const base = { stylesheetUrl: '/assets/qa.css', clientScriptUrl: '/assets/qa.js', wallet: WALLET, walletVerified: true,
  chainId: '11155111', chainName: 'Ethereum Sepolia', contract: WALLET, pulseMint: true,
  pulseSaleStatus: { phase: 'paid', paused: false }, assessmentSource: 'sample' };

export function accessibilityFixtureOptions(phase = 'paid', paused = false) {
  assert.ok(['prelaunch', 'free', 'paid', 'unknown'].includes(phase), 'Unknown accessibility fixture phase.');
  assert.equal(typeof paused, 'boolean', 'Fixture maintenance state must be explicit.');
  const siteLaunchMode = phase === 'prelaunch' ? 'prelaunch' : 'open';
  return { ...base, ...(siteLaunchMode === 'prelaunch' ? { wallet: null, walletVerified: false } : {}), siteLaunchMode,
    pulseSaleStatus: siteSaleStatus(siteLaunchMode, { phase: phase === 'prelaunch' ? 'paid' : phase, paused }) };
}
export function accessibilityFixture(page, phase = 'paid', paused = false) {
  const options = accessibilityFixtureOptions(phase, paused);
  if (page === 'home') return homePage(options, [{ handle: 'abcdefghijklmno', code: 'qa', mbti: 'INFP', imageUrl: '/art.svg', mint: { state: 'confirming' } }]);
  if (page === 'mint') return mintPage('Abcdefghijklmno', options);
  if (page === 'explore') return explorePage('Abcdefghijklmno', { ...options, wallet: null, walletVerified: false });
  if (page === 'admin') return sepoliaAdminPage({ ...base, adminWallet: WALLET });
  throw Error('Unknown accessibility fixture.');
}

const fixtureScript = `(() => {
  window.__uiQaWalletAccesses = 0;
  Object.defineProperty(window, 'ethereum', { configurable: true, get() { window.__uiQaWalletAccesses++; throw Error('Offline phase QA must not access a wallet provider.'); } });
  document.querySelectorAll('form:not([data-preview-explore-form])').forEach(form => form.addEventListener('submit', event => event.preventDefault()));
  (${bindHandleValidation.toString()})(document);
  (${previewExplorerClient.toString()})(${mintHandleDraft.toString()}, ${sitePhasePresentation.toString()});
  document.querySelectorAll('[data-admin-connect],[data-admin-wallets],[data-admin-quota],[data-admin-review]').forEach(node => node.disabled = false);
  const addresses = document.querySelector('[data-admin-wallets]'); if (addresses) addresses.value = ${JSON.stringify([WALLET, WALLET, WALLET].join('\n'))};
  const quota = document.querySelector('[data-admin-quota]'); if (quota) quota.value = '400';
  const pending = document.querySelector('[data-admin-pending]'); if (pending) pending.hidden = false;
  const hash = document.querySelector('[data-admin-pending-hash]'); if (hash) hash.textContent = ${JSON.stringify(HASH)};
  const recovery = document.querySelector('[data-mint-recovery]'); if (recovery) recovery.hidden = false;
  const oldHandle = document.querySelector('[data-mint-recovery-handle]'); if (oldHandle) oldHandle.textContent = '@Abcdefghijklmno';
  const ceiling = document.querySelector('[name=pulse-max-eth]'); if (ceiling) { ceiling.disabled = document.querySelector('[data-pulse-options]')?.dataset.pulsePaused === 'true'; ceiling.value = '0.0001'; }
  document.body.dataset.qaReady = 'true';
})();`;

export async function createAccessibilityFixtureServer() {
  let phase = 'paid', paused = false;
  const artwork = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#000"/><path d="M50 240 Q100 140 155 210 T350 190" stroke="#f4e7c7" stroke-width="12" fill="none"/></svg>';
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost'), pathname = url.pathname;
    if (request.method !== 'GET') { response.writeHead(405); response.end('Offline phase fixture accepts anonymous GET only.'); return; }
    const assets = new Map([
      ['/assets/qa.css', [SITE_CSS + OPEN_MINT_CSS, 'text/css']],
      ['/assets/qa.js', [fixtureScript, 'text/javascript']],
      ['/assets/sepolia-admin.css', [SEPOLIA_ADMIN_CSS, 'text/css']],
      [SLOGAN_MBTI_HERO_SCRIPT_URL, [SLOGAN_MBTI_HERO_SCRIPT, 'text/javascript']],
      [SLOGAN_TOOLTIP_SCRIPT_URL, [SLOGAN_TOOLTIP_SCRIPT, 'text/javascript']],
      [new URL(FAVICON_URL, 'http://localhost').pathname, [FAVICON_SVG, 'image/svg+xml']],
      ['/art.svg', [artwork, 'image/svg+xml']],
    ]);
    let asset = assets.get(pathname);
    const font = siteFontAsset(pathname); if (font) asset = [font.bytes, font.contentType];
    if (/^\/preview\/[A-Za-z0-9_]{1,15}\/[IE][NS][FT][JP]\.svg$/.test(pathname)) asset = [artwork, 'image/svg+xml'];
    if (asset) { response.writeHead(200, { 'content-type': asset[1] }); response.end(asset[0]); return; }
    // The phase query selects synthetic server configuration only. A native
    // explorer GET drops it, so the fixture retains its current server phase.
    if (url.searchParams.has('phase')) { phase = url.searchParams.get('phase'); paused = url.searchParams.get('paused') === 'true'; }
    if (pathname === '/explore' && /^@?[A-Za-z0-9_]{1,15}$/.test(url.searchParams.get('handle') ?? '')) {
      response.writeHead(302, { location: handleVariationsPath(url.searchParams.get('handle')) }); response.end(); return;
    }
    const variations = pathname.match(/^\/p\/([A-Za-z0-9_]{1,15})\/variations$/);
    if (variations) { response.writeHead(200, { 'content-type': 'text/html' });
      response.end(previewVariationsPage(variations[1], { ...accessibilityFixtureOptions(phase, paused), wallet: null, walletVerified: false })); return; }
    const page = pathname === '/' ? 'home' : pathname.slice(1);
    if (['home', 'mint', 'admin', 'explore'].includes(page)) { response.writeHead(200, { 'content-type': 'text/html' }); response.end(accessibilityFixture(page, phase, paused)); return; }
    response.writeHead(404); response.end('Unknown fixture asset.');
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(Error('Accessibility fixture server did not close.')), 2000);
    server.close(error => { clearTimeout(timer); error ? reject(error) : accept(); }); server.closeAllConnections();
  }) };
}

export function expectedExplorerRedirect(request, origin) {
  try {
    const url = new URL(request.url), target = new URL(request.redirect, origin);
    const handle = url.searchParams.get('handle');
    return request.status === 302 && request.method === 'GET' && url.origin === origin && url.pathname === '/explore'
      && /^@?[A-Za-z0-9_]{1,15}$/.test(handle ?? '') && target.origin === origin
      && target.pathname === handleVariationsPath(handle) && !target.search && !target.hash;
  } catch { return false; }
}

/** Assert phase semantics against the actual rendered DOM, not a duplicated
 * implementation. Exported so negative mock cases prove these checks fail. */
export function assertPhaseSurface(entry, surface) {
  const { page, phase, paused = false } = entry;
  const explorer = page === 'explore' || page === 'mint' && phase === 'prelaunch';
  assert.deepEqual(surface.visibleWarnings, [], `${page}/${phase}: passive surface warns about infrastructure`);
  assert.equal(surface.walletAccesses, 0, `${page}/${phase}: fixture accessed a wallet provider`);
  if (phase === 'prelaunch' || explorer) {
    assert.equal(surface.walletControls, 0, `${page}/${phase}: exploration includes wallet controls`);
    assert.equal(surface.paidFields, 0, `${page}/${phase}: exploration includes paid fields`);
    assert.deepEqual(surface.mintMarkers, [], `${page}/${phase}: exploration includes mint submission markers`);
  }
  if (phase === 'prelaunch') {
    assert.deepEqual(surface.visibleMintLinks, [], `${page}: pre-launch exposes mint navigation`);
    assert.match(surface.phaseStatus, /Minting coming soon/, `${page}: pre-launch status is missing`);
  }
  if (page === 'home') {
    const label = { prelaunch: 'Explore previews', free: 'Free Mint', paid: 'Paid Mint', unknown: 'Mint a signature' }[phase];
    assert.equal(surface.primary?.label, label, 'Home CTA does not match the server phase.');
    assert.equal(surface.primary?.href, phase === 'prelaunch' ? '/explore' : '/mint', 'Home CTA targets the wrong phase.');
    if (paused && phase !== 'prelaunch') assert.match(surface.phaseStatus, /Minting is paused/, 'Maintenance replaces or loses the phase overlay.');
  }
  if (explorer) {
    assert.equal(surface.explorerPhase, phase, 'Explorer phase differs from the page phase.');
    assert.equal(surface.explorerForm?.method, 'get', 'Explorer must use anonymous GET navigation.');
    assert.equal(surface.explorerForm?.action, '/explore', 'Explorer submits to an unexpected destination.');
    assert.equal(surface.explorerForm?.submit, 'Explore previews', 'Explorer CTA is missing or mislabeled.');
    const open = ['free', 'paid'].includes(phase) && !paused;
    assert.equal(surface.explorerMintLink?.visible, open, 'Explorer mint navigation ignores the phase/maintenance gate.');
    if (open) assert.equal(surface.explorerMintLink.label, phase === 'free' ? 'Free Mint' : 'Paid Mint');
  }
  if (page === 'mint' && phase !== 'prelaunch') {
    assert.equal(surface.mintPhase, phase, 'Mint surface lost the actual contract phase.');
    assert.equal(surface.mintPaused, paused, 'Mint surface lost the maintenance overlay.');
    assert.equal(surface.submitDisabled, true, 'SSR mint CTA enables before a fresh wallet quote.');
    if (paused) assert.equal(surface.paidInputDisabled, true, 'Maintenance enables paid price consent.');
  }
}

const pause = ms => new Promise(accept => setTimeout(accept, ms));

async function auditExplorerKeyboard({ client, evaluate, fixture, entry, screenshot }) {
  const pressEnter = async () => {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text:'\r',unmodifiedText:'\r' });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const before = await evaluate('location.href');
  await evaluate(`(() => {
    const input=document.querySelector('input[name="handle"]'),form=input.form;
    window.__uiQaInvalid=[];window.__uiQaSubmits=0;
    input.addEventListener('invalid', event => window.__uiQaInvalid.push({cancelled:event.defaultPrevented}));
    form.addEventListener('submit', () => window.__uiQaSubmits++);
  })()`);
  const validations = [];
  for (const value of ['', 'not valid!']) {
    await evaluate(`(() => { const input=document.querySelector('input[name="handle"]'); input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input'));input.focus(); })()`);
    await pressEnter();
    const validation = await evaluate(`(() => {
      const input=document.querySelector('input[name="handle"]'),notice=document.querySelector('[data-handle-validation]');
      return {value:input.value,invalid:input.getAttribute('aria-invalid'),hidden:notice.hidden,text:notice.textContent,
        label:notice.querySelector('.open-preview-notice-label')?.textContent,cancelled:window.__uiQaInvalid.at(-1)?.cancelled,
        submits:window.__uiQaSubmits,url:location.href};
    })()`);
    assert.equal(validation.invalid, 'true', `Explorer keyboard validation did not mark the invalid handle: ${JSON.stringify(validation)}`);
    assert.equal(validation.hidden, false, 'Explorer keyboard validation did not show its inline notice.');
    assert.equal(validation.label, 'Warning', 'Explorer validation bypasses the shared warning style.');
    assert.match(validation.text, value ? /1–15/ : /Choose an X handle/);
    assert.equal(validation.cancelled, true, 'Explorer did not prevent the native browser validation popup.');
    assert.equal(validation.submits, 0, 'Invalid explorer input reached form submission.');
    assert.equal(validation.url, before, 'Invalid explorer input changed the page.');
    validations.push(validation);
  }
  const input = '@Artist_QA', spelling = preservedHandle(input);
  const cleared = await evaluate(`(() => { const input=document.querySelector('input[name="handle"]');input.value=${JSON.stringify(input)};input.dispatchEvent(new Event('input'));input.focus();return {invalid:input.getAttribute('aria-invalid'),hidden:document.querySelector('[data-handle-validation]').hidden}; })()`);
  assert.equal(cleared.invalid, null); assert.equal(cleared.hidden, true, 'Explorer retained a stale warning after valid input.');
  await pressEnter();
  const deadline = Date.now() + 10000;
  while (!await evaluate('document.body?.dataset.qaReady === "true" && !!document.querySelector("[data-preview-variations]")')) {
    assert.ok(Date.now() < deadline, 'Explorer keyboard submission did not reach the preview variations.'); await pause(50);
  }
  await evaluate(`Promise.all([document.fonts.ready,...[...document.images].map(image => image.complete ? Promise.resolve() : new Promise((accept,reject) => {image.onload=accept;image.onerror=() => reject(Error('Preview fixture image failed.'));}))])`);
  const destination = await evaluate(`(() => {
    const visible=element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    return {url:location.href,cards:document.querySelectorAll('.open-preview-card').length,
      names:[...document.querySelectorAll('.open-preview-card')].map(element=>element.getAttribute('aria-label')),
      images:[...document.images].map(image=>({loaded:image.complete&&image.naturalWidth>0,source:image.getAttribute('src')})),
      mintLinks:[...document.querySelectorAll('a[href^="/mint"]')].filter(visible).map(element=>element.getAttribute('href')),
      walletControls:document.querySelectorAll('[data-wallet-controls],[data-connect-wallet]').length,
      visibleWarnings:[...document.querySelectorAll('[role="alert"],.open-preview-warning,.open-preview-notice-label')].filter(visible).map(element=>element.textContent.trim()),
      walletAccesses:window.__uiQaWalletAccesses};
  })()`);
  assert.equal(destination.url, fixture.origin + handleVariationsPath(spelling), 'Explorer changed the handle spelling or navigated to an unexpected destination.');
  assert.equal(destination.cards, 16, 'Explorer did not render all sixteen interpretations.');
  assert.equal(new Set(destination.names).size, 16, 'Explorer duplicated or omitted an accessible variation.');
  assert.ok(destination.names.every(name => name.endsWith(`for @${spelling}`)), 'Explorer variation labels changed handle identity.');
  assert.ok(destination.images.every(image => image.loaded), 'Explorer preview images did not load.');
  assert.equal(destination.walletControls, 0); assert.equal(destination.walletAccesses, 0);
  assert.deepEqual(destination.visibleWarnings, [], 'Anonymous previews displayed a mint/network warning.');
  if (entry.phase === 'prelaunch') assert.deepEqual(destination.mintLinks, [], 'Pre-launch previews expose mint navigation.');
  const previewScreenshot = screenshot.replace(/\.png$/, '-variations.png');
  const shot = await client.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  writeFileSync(previewScreenshot, Buffer.from(shot.data, 'base64'));
  return { validations, cleared, destination, screenshot:previewScreenshot };
}

function browserEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' && !url.username && !url.password && !url.search && !url.hash && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port
      && /^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(url.pathname) ? url.href : undefined;
  } catch { return undefined; }
}

const DEVTOOLS_ERROR_CODES = new Set(['ABORT_ERR', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM',
  'ENOTEMPTY', 'ERR_ASSERTION', 'DEVTOOLS_HTTP_STATUS', 'DEVTOOLS_BODY_LIMIT', 'DEVTOOLS_BODY_INCOMPLETE', 'DEVTOOLS_INVALID_JSON', 'DEVTOOLS_PROBE_TIMEOUT']);
const diagnosticCode = code => DEVTOOLS_ERROR_CODES.has(code) ? code : 'DEVTOOLS_PROBE_ERROR';
const startupEvidence = value => value && ({ source: value.source, elapsedMs: value.elapsedMs, attempts: value.attempts,
  transport: value.transport, browser: /^(?:HeadlessChrome|Chrome|Chromium)\/\d+(?:\.\d+){0,3}$/.test(value.browser ?? '') ? value.browser : null });

// This is the only failure object written to the CI-uploaded report. Detailed
// local diagnostics still exist on the supervisor/error for live triage, but
// no arbitrary error prose, browser output, profile, PID or endpoint is saved.
export function accessibilityFailureEvidence({ stage, completedCases, error, startup, chrome, profileRemoved, cleanupFailures = 0 }) {
  return { stage, completedCases, errorCode: diagnosticCode(error?.code), cleanupFailures,
    ...(startup ? { startup: startupEvidence(startup) } : {}), chrome: chrome && {
      elapsedMs: chrome.elapsedMs, exited: chrome.exited, closed: chrome.closed, exitCode: chrome.exitCode,
      signal: /^SIG[A-Z0-9]{1,12}$/.test(chrome.signal ?? '') ? chrome.signal : null,
      spawnFailed: Boolean(chrome.spawnError), stdoutPresent: Boolean(chrome.stdoutTail), stderrPresent: Boolean(chrome.stderrTail), profileRemoved,
      readiness: { attempts: chrome.readiness.attempts, portFile: chrome.readiness.portFile, phase: chrome.readiness.phase,
        probes: chrome.readiness.probes.map(value => ({ attempt: value.attempt, source: value.source, phase: value.phase,
          elapsedMs: value.elapsedMs, status: value.status, errorCode: value.errorCode, outcome: value.outcome })) },
    } };
}

export function createAccessibilityChromeProfile({ remove = rm } = {}) {
  // Ownership is a capability created here: callers cannot supply a path or
  // substitute an existing browser profile. Never delete until actual close.
  const profile = mkdtempSync(join(tmpdir(), 'sg-ui-chrome-'));
  return Object.freeze({ path: profile, async removeAfterClose(chrome) {
    assert.ok(!chrome || chrome.diagnostics().closed, 'Owned Chrome must actually close before its disposable profile is removed.');
    // Same five retries/100ms linear backoff as before. Node's async rimraf
    // rescans children on ENOTEMPTY; rmSync retries only the final rmdir, so a
    // late-created file could survive every retry even after its writer stops.
    await remove(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } });
}

// DevTools belongs to the newly spawned browser, not an application/provider
// HTTP client. A new direct IPv4 loopback socket avoids global fetch dispatchers,
// proxies and pooled connections surviving a cancelled startup probe. The
// caller's existing deadline bounds connect, headers AND body; redirects and
// oversized/incomplete JSON are never accepted as readiness.
export function probePrivateDevtools(value, abort, progress = () => {}) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && /^\d+$/.test(url.port) && Number(url.port) > 0 && Number(url.port) <= 65535
    && !url.username && !url.password && !url.search && !url.hash
    && ['/json/version', '/json/list'].includes(url.pathname), 'Invalid private DevTools probe URL.');
  return new Promise((accept, reject) => {
    let settled = false;
    const finish = (error, value) => { if (!settled) { settled = true; error ? reject(error) : accept(value); } };
    progress('connect');
    const request = httpRequest({ hostname: '127.0.0.1', port: Number(url.port), path: url.pathname,
      method: 'GET', agent: false, signal: abort, headers: { host: url.host, connection: 'close' } });
    request.on('socket', socket => socket.once('connect', () => progress('headers')));
    request.once('response', response => {
      progress('body', response.statusCode);
      if (response.statusCode !== 200) {
        response.destroy(); request.destroy();
        finish(Object.assign(Error('Private DevTools returned a non-200 response.'), { code: 'DEVTOOLS_HTTP_STATUS' })); return;
      }
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) {
          finish(Object.assign(Error('Private DevTools JSON exceeds 64 KiB.'), { code: 'DEVTOOLS_BODY_LIMIT' }));
          response.destroy(); request.destroy();
        } else chunks.push(chunk);
      });
      response.once('error', error => finish(error));
      response.once('aborted', () => finish(Object.assign(Error('Private DevTools JSON body was incomplete.'), { code: 'DEVTOOLS_BODY_INCOMPLETE' })));
      response.once('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          progress('complete', response.statusCode);
          finish(undefined, { status: response.statusCode, json: async () => parsed });
        } catch {
          finish(Object.assign(Error('Private DevTools returned invalid JSON.'), { code: 'DEVTOOLS_INVALID_JSON' }));
        }
      });
    });
    request.once('error', error => finish(error)); request.end();
  });
}

// Test-only browser supervision. A fresh private profile's port file is a
// readiness signal; a stderr banner alone neither proves readiness nor life.
export function launchAccessibilityChrome(chromePath, profile, { spawnProcess = spawn,
  readActivePort = () => readFileSync(join(profile, 'DevToolsActivePort'), 'utf8') } = {}) {
  const started = Date.now(), child = spawnProcess(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--disable-gpu',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--no-sandbox', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', stdout = '', spawnError, exited = false, closed = false, closing = false, exitCode, signal;
  const readiness = { attempts: 0, portFile: 'not-read', phase: 'waiting-private-endpoint', probes: [] };
  // Browser exit proves the owned PID has stopped. Mac updater descendants can
  // retain its inherited pipes; close only our pipe handles, then still await
  // the real Node child close event before deleting the private profile.
  const closeOwnedPipes = () => { child.stdout?.destroy(); child.stderr?.destroy(); };
  const closedPromise = new Promise(accept => child.once('close', (code, value) => { closed = true; exited = true; exitCode = code; signal = value; accept(); }));
  child.on('error', error => { spawnError = error; });
  child.once('exit', (code, value) => { exited = true; exitCode = code; signal = value; if (closing) closeOwnedPipes(); });
  child.stderr?.on('data', value => { stderr = (stderr + value).slice(-16384); });
  child.stdout?.on('data', value => { stdout = (stdout + value).slice(-16384); });
  const diagnostics = () => ({ chromePath, profile, pid: child.pid ?? null, elapsedMs: Date.now() - started, exited, closed,
    exitCode: exitCode ?? child.exitCode ?? null, signal: signal ?? child.signalCode ?? null,
    spawnError: spawnError?.message ?? null, stderrTail: stderr, stdoutTail: stdout,
    readiness: { ...readiness, probes: readiness.probes.map(value => ({ ...value })) } });
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
    async ready({ timeoutMs = 10000, pollMs = 50, probe = probePrivateDevtools } = {}) {
      assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000, 'Chrome startup must remain bounded at ten seconds.');
      assert.ok(Number.isInteger(pollMs) && pollMs > 0, 'Chrome startup polling must have a positive bounded interval.');
      const deadline = Date.now() + timeoutMs; let lastProbeError;
      while (Date.now() < deadline) {
        checkAlive(); let endpoint, source;
        try {
          const [port, path] = readActivePort().trim().split(/\r?\n/);
          if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535) endpoint = browserEndpoint(`ws://127.0.0.1:${port}${path}`);
          readiness.portFile = endpoint ? 'valid' : 'partial-or-invalid';
          if (endpoint) source = 'DevToolsActivePort';
        } catch (error) { readiness.portFile = error.code === 'ENOENT' ? 'missing' : 'read-error'; if (error.code !== 'ENOENT') throw failure('Chrome port file could not be read.', error); }
        if (!endpoint) {
          endpoint = browserEndpoint((stderr + stdout).match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]);
          if (endpoint) source = 'browser-output';
        }
        if (endpoint) {
          const stop = new AbortController(); let timer;
          const attempt = { attempt: ++readiness.attempts, source, phase: 'probe', elapsedMs: 0, status: null, errorCode: null, outcome: 'pending' };
          const probeStarted = Date.now(); readiness.phase = 'http-readiness';
          readiness.probes.push(attempt); if (readiness.probes.length > 8) readiness.probes.shift();
          try {
            const version = await Promise.race([Promise.resolve().then(async () => {
              const response = await probe(`http://${new URL(endpoint).host}/json/version`, stop.signal,
                (phase, status) => { attempt.phase = phase; if (status !== undefined) attempt.status = status; });
              attempt.status = response.status; attempt.phase = 'json';
              assert.equal(response.status, 200); return response.json();
            }), new Promise((_, reject) => { timer = setTimeout(() => { stop.abort(); reject(Object.assign(Error('DevTools HTTP readiness probe timed out.'), { code: 'DEVTOOLS_PROBE_TIMEOUT' })); }, Math.min(1000, deadline - Date.now())); })]);
            checkAlive(); assert.ok(Date.now() < deadline && !stop.signal.aborted, 'DevTools readiness expired before its response could be accepted.');
            attempt.phase = 'identity';
            assert.equal(browserEndpoint(version.webSocketDebuggerUrl), endpoint, 'DevTools endpoint differs from the spawned private browser.');
            attempt.outcome = 'ready'; readiness.phase = 'ready';
            return { webSocketDebuggerUrl: endpoint, source, elapsedMs: Date.now() - started, browser: version.Browser ?? null,
              attempts: readiness.attempts, transport: probe === probePrivateDevtools ? 'direct-loopback-http' : 'injected-test-probe' };
          } catch (error) {
            lastProbeError = error; attempt.outcome = 'failed';
            // Retain classifications, not arbitrary remote/error response text.
            attempt.errorCode = diagnosticCode(error.code); checkAlive();
          }
          finally { attempt.elapsedMs = Date.now() - probeStarted; clearTimeout(timer); stop.abort(); }
        }
        await pause(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      }
      checkAlive(); throw failure(`Chrome DevTools did not become ready within ${timeoutMs}ms.`, lastProbeError);
    },
    async close({ gracefulMs = 2000, forceMs = 2000 } = {}) {
      if (closed) return;
      closing = true;
      if (exited) closeOwnedPipes();
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
  const ownedProfile = createAccessibilityChromeProfile(), profile = ownedProfile.path;
  let client, browser, chrome, fixture, startup, failure, stage = 'fixture'; const rows = [], requests = [], errors = [];
  try {
    fixture = await createAccessibilityFixtureServer(); stage = 'chrome-startup';
    chrome = launchAccessibilityChrome(chromePath, profile); startup = await chrome.ready();
    const browserWs = startup.webSocketDebuggerUrl; stage = 'cdp-handshake';
    browser = await connectCdp(browserWs);
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const devtoolsOrigin = new URL(browserWs);
    const targetsResponse = await probePrivateDevtools(`http://${devtoolsOrigin.host}/json/list`, AbortSignal.timeout(10000));
    assert.equal(targetsResponse.status, 200, 'Chrome target enumeration failed.');
    const targets = await targetsResponse.json();
    client = await connectCdp(auditTargetEndpoint(browserWs, targetId, targets)); browser.close(); browser = undefined; stage = 'audit';
    client.on('Network.requestWillBeSent', event => {
      if (event.redirectResponse) { const previous = requests.findLast(row => row.id === event.requestId);
        if (previous) { previous.status = event.redirectResponse.status; previous.redirect = event.redirectResponse.headers.location ?? event.redirectResponse.headers.Location; } }
      requests.push({ id: event.requestId, url: event.request.url, method: event.request.method, status: null });
    });
    client.on('Network.responseReceived', event => { const row = requests.findLast(row => row.id === event.requestId); if (row) row.status = event.response.status; });
    client.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.text));
    await client.send('Page.enable'); await client.send('Network.enable'); await client.send('Runtime.enable'); await client.send('Accessibility.enable');
    const evaluate = async expression => { const value = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.ok(!value.exceptionDetails, value.exceptionDetails?.text); return value.result.value; };
    for (const entry of UI_ACCESSIBILITY_MATRIX) {
      const { page, phase, paused = false, width, theme, zoom } = entry, height = zoom === 2 ? 450 : 900;
      await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: zoom, mobile: false });
      await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      // Every scenario owns fresh synthetic browser storage. No visitor session
      // or application journal is read, cleared or imported into this audit.
      if (rows.length) await evaluate('sessionStorage.clear()');
      await client.send('Page.navigate', { url: `${fixture.origin}/${page === 'home' ? '' : page}?phase=${phase}&paused=${paused}` });
      const deadline = Date.now() + 10000;
      while (!await evaluate('document.body?.dataset.qaReady === "true"')) { assert.ok(Date.now() < deadline, `${page}: fixture not ready`); await pause(50); }
      await evaluate('document.fonts.ready');
      const surface = await evaluate(`(() => {
        const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
        const form = document.querySelector('[data-preview-explore-form]');
        const primary = document.querySelector('[data-home-mint-cta]'), mintLink = document.querySelector('[data-explorer-mint-link]');
        const mintSelectors = ['[data-assessment-request]','[data-request-submit]','[data-mint-process]','[data-pulse-options]','[data-mint-recovery]'];
        return {
          walletControls:document.querySelectorAll('[data-wallet-controls],[data-connect-wallet]').length,
          paidFields:document.querySelectorAll('[name="pulse-max-eth"]').length,
          mintMarkers:mintSelectors.filter(selector => document.querySelector(selector)),
          visibleMintLinks:[...document.querySelectorAll('a[href^="/mint"]')].filter(visible).map(element => element.getAttribute('href')),
          visibleWarnings:[...document.querySelectorAll('[role="alert"],.open-preview-warning,.open-preview-notice-label')].filter(visible).map(element => element.textContent.trim()),
          phaseStatus:[...document.querySelectorAll('[data-home-mint-status],[data-explorer-sale-status],[data-explorer-mint-status]')].filter(visible).map(element => element.textContent).join(' '),
          primary:primary ? {label:primary.textContent.trim(),href:primary.getAttribute('href')} : null,
          explorerPhase:document.querySelector('[data-preview-explorer]')?.dataset.sitePhase ?? null,
          explorerForm:form ? {method:form.getAttribute('method'),action:form.getAttribute('action'),submit:form.querySelector('[type="submit"]')?.textContent.trim()} : null,
          explorerMintLink:mintLink ? {visible:visible(mintLink),label:mintLink.textContent.trim(),href:mintLink.getAttribute('href')} : null,
          walletAccesses:window.__uiQaWalletAccesses,
          mintPhase:document.querySelector('[data-pulse-options]')?.dataset.pulsePhase ?? null,
          mintPaused:document.querySelector('[data-pulse-options]')?.dataset.pulsePaused === 'true',
          submitDisabled:document.querySelector('[data-request-submit]')?.disabled ?? null,
          paidInputDisabled:document.querySelector('[name="pulse-max-eth"]')?.disabled ?? true,
        };
      })()`);
      assertPhaseSurface(entry, surface);
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
          inputSize:document.querySelector('input[name="handle"]') ? getComputedStyle(document.querySelector('input[name="handle"]')).fontSize : null,
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
      if (page === 'mint' && phase !== 'prelaunch') {
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
      if (page === 'mint' && phase !== 'prelaunch') {
        const validation = await evaluate(`(() => { const input=document.querySelector('#open-handle'); input.value='not valid!'; input.dispatchEvent(new Event('input')); input.checkValidity(); const error=document.querySelector('[data-handle-validation]'); return {invalid:input.getAttribute('aria-invalid'),hidden:error.hidden,text:error.textContent}; })()`);
        assert.equal(validation.invalid, 'true'); assert.equal(validation.hidden, false); assert.match(validation.text, /1–15/);
      }
      await evaluate(`(() => { const field=document.querySelector('input[name="handle"]'); if(field)field.setSelectionRange(field.value.length,field.value.length);document.activeElement.blur();scrollTo(0,0); })()`);
      const screenshot = join(outputDir, `${page}-${phase}${paused ? '-paused' : ''}-${width}-${theme}${zoom === 2 ? '-zoom200' : ''}.png`);
      const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
      const exploration = page === 'explore' || page === 'mint' && phase === 'prelaunch'
        ? await auditExplorerKeyboard({ client, evaluate, fixture, entry, screenshot }) : undefined;
      rows.push({ ...entry, screenshot, geometry, surface, accessibleControls:interactive.length, statusRegions:statuses.length, keyboard:focus,
        ...(exploration ? { exploration } : {}) });
    }
    for (const width of [320, 375, 390, 640]) {
      const group = rows.filter(row => row.width === width), baseline = group[0].geometry.navigation;
      assert.ok(group.every(row => JSON.stringify(row.geometry.navigation) === JSON.stringify(baseline)), `Navigation alignment differs between pages at ${width}px.`);
    }
    assert.deepEqual(errors, [], 'Browser JavaScript exceptions');
    const failedRequests = requests.filter(request => request.status !== 200 && !expectedExplorerRedirect(request, fixture.origin)), externalRequests = requests.filter(request => new URL(request.url).origin !== fixture.origin);
    assert.deepEqual(failedRequests, [], 'Fixture asset request failures'); assert.deepEqual(externalRequests, [], 'Audit made external requests');
    const rpcOrApiRequests = requests.filter(request => /\/(?:api|internal|rpc)(?:[/?]|$)/.test(new URL(request.url).pathname) || request.method !== 'GET');
    assert.deepEqual(rpcOrApiRequests, [], 'Anonymous exploration made an API, RPC or non-GET request');
    const result = { matrix:rows, failedRequests, externalRequests, javascriptErrors:errors, networkRequests:requests.length, startup: startupEvidence(startup),
      zoomMethod:'200% browser-zoom reflow: 1280×900 physical viewport represented by 640×450 CSS pixels with deviceScaleFactor 2.',
      scope:'Real templates, fonts, CSS, inline validation, anonymous explorer GET navigation, phase/maintenance presentation, keyboard traversal and AX tree; synthetic content only, no wallet signing or RPC. Original 48 cases retained. Not a manual screen-reader certification or full mint transaction rehearsal.' };
    writeFileSync(join(outputDir, 'results.json'), JSON.stringify(result, null, 2)); return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanup = [];
    client?.close(); browser?.close();
    try { await chrome?.close(); } catch (error) { cleanup.push(error); }
    try { await fixture?.close(); } catch (error) { cleanup.push(error); }
    // Do not remove a profile until its owning browser has actually stopped.
    if (!chrome || chrome.diagnostics().closed) {
      try { await ownedProfile.removeAfterClose(chrome); } catch (error) { cleanup.push(error); }
    }
    if (failure || cleanup.length) {
      try { writeFileSync(join(outputDir, 'results.json'), JSON.stringify(accessibilityFailureEvidence({
        stage: failure ? stage : 'cleanup', completedCases: rows.length, error: failure ?? cleanup[0], startup,
        chrome: chrome?.diagnostics() ?? null, profileRemoved: !existsSync(profile), cleanupFailures: cleanup.length,
      }), null, 2)); } catch (error) { cleanup.push(error); }
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
