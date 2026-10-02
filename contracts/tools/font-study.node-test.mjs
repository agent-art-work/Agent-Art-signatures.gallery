import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFontStudy } from '../../scripts/font-study.mjs';

const fonts = ['space-grotesk', 'balsamiq-sans', 'comic-neue', 'playpen-sans'];
const variants = ['lighter', 'regular', 'bold'];
const retiredFonts = ['dm-sans', 'manrope', 'instrument-sans', 'caveat', 'kalam', 'patrick-hand'];

test('font previews are anonymous, GET-only and cannot forward mint, wallet or arbitrary asset requests', async () => {
  const sourceCalls = [];
  const html = '<!doctype html><html><head><title>Site</title><link rel="stylesheet" href="/assets/site.css"><script src="/assets/sepolia.js"></script></head><body><a href="/mint">Mint</a><input id="open-handle" value=""><img src="/test-art/alice.svg"></body></html>';
  const site = await startFontStudy({ port: 0, fetchSource: async (url, options) => {
    sourceCalls.push({ url: String(url), options });
    const value = url.pathname.endsWith('.css') ? 'body{font-family:var(--font-family)}' : url.pathname.endsWith('.svg') ? '<svg xmlns="http://www.w3.org/2000/svg"></svg>' : html;
    return new Response(value, { status: 200, headers: { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'text/html' } });
  } });
  try {
    for (const view of ['/', '/mint']) for (const font of fonts) for (const variant of variants) {
      const response = await fetch(`${site.origin}${view}?font=${font}&variant=${variant}&handle=Alice`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
      assert.match(response.headers.get('content-security-policy'), /form-action 'none'/);
      assert.equal(response.headers.get('set-cookie'), null);
      const text = await response.text();
      assert.ok(text.includes(`data-font-study="${font}"`));
      assert.ok(text.includes(`data-font-study-variant="${variant}"`));
      assert.ok(!text.includes('/assets/sepolia.js'));
      assert.ok(text.includes('value="Alice"'));
      assert.equal([...text.matchAll(/data-font-study-link/g)].length, 9);
      assert.equal([...text.matchAll(/aria-current="true"/g)].length, 2);
      assert.equal([...text.matchAll(/rel="preload"/g)].length, 1);
      const preloadWeight = font === 'balsamiq-sans' ? variant === 'bold' ? '700' : '400' : font === 'comic-neue' ? variant === 'lighter' ? '300' : variant === 'bold' ? '700' : '400' : 'wght';
      assert.ok(text.includes(`${font}-latin-${preloadWeight}-normal.woff2`));
      const links = [...text.matchAll(/<a\s+data-font-study-link\s+href="([^"]+)"[^>]*>/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), site.origin));
      assert.equal(links.length, 9);
      for (const url of links) assert.equal(url.searchParams.get('handle'), 'Alice');
      for (const url of [...links.slice(0, 4), ...links.slice(7)]) assert.equal(url.searchParams.get('variant'), variant);
      for (const url of links.slice(4)) assert.equal(url.searchParams.get('font'), font);
      if (font === 'balsamiq-sans') assert.ok(text.includes('Lighter · softer ink'));
      else assert.ok(!text.includes('Lighter · softer ink'));
      if (font === 'balsamiq-sans' && variant === 'lighter') assert.ok(text.includes('<p class="font-study-weight-note">Regular 400, softer ink. Balsamiq Sans has no light weight.</p>'));
    }
    for (const path of ['/api/wallet/connect', '/api/mint', '/assets/sepolia.js', '/.env.local', '/assets/unknown']) assert.equal((await fetch(site.origin + path)).status, 404);
    assert.equal((await fetch(site.origin + '/mint', { method: 'POST', body: 'mint' })).status, 405);
    assert.equal((await fetch(site.origin + '/mint?handle=%3Cscript%3E')).status, 400);
    for (const path of ['/?font=../bad&variant=bad', '/mint?font=caveat&variant=bad', '/']) {
      const fallback = await fetch(site.origin + path);
      const text = await fallback.text();
      assert.match(text, /data-font-study="space-grotesk"/);
      assert.match(text, /data-font-study-variant="regular"/);
    }
    for (const font of retiredFonts) {
      for (const path of [`/assets/font-study/${font}.css`, `/assets/font-study/${font}-5.3.0/${font}-latin-wght-normal.woff2`, `/assets/font-study/${font}-5.3.0/${font}-latin-400-normal.woff2`]) assert.equal((await fetch(site.origin + path)).status, 404);
    }
    for (const font of fonts) {
      const css = await fetch(site.origin + `/assets/font-study/${font}.css`);
      assert.equal(css.status, 200);
      const cssText = await css.text();
      assert.doesNotMatch(cssText, /https?:|\.woff\)|format\('woff'\)/);
      const paths = [...cssText.matchAll(/url\(([^)]+)\)/g)].map(match => match[1]);
      assert.ok(paths.length > 1);
      for (const path of paths) {
        const bytes = await fetch(site.origin + path);
        assert.equal(bytes.status, 200);
        assert.equal(bytes.headers.get('content-type'), 'font/woff2');
        assert.equal(Buffer.from(await bytes.arrayBuffer()).subarray(0, 4).toString(), 'wOF2');
      }
      const license = await fetch(site.origin + paths[0].replace(/[^/]+$/, 'LICENSE.txt'));
      assert.equal(license.status, 200);
      assert.match(await license.text(), /SIL OPEN FONT LICENSE/);
    }
    assert.equal((await fetch(site.origin + '/assets/font-study.js')).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await fetch(site.origin + '/test-art/alice.svg')).status, 200);
    assert.equal(sourceCalls.filter(call => call.url.endsWith('/test-art/alice.svg')).length, 1);
    assert.equal(sourceCalls.length, 4);
    for (const { options } of sourceCalls) {
      assert.equal(options.method, undefined); assert.equal(options.headers, undefined); assert.equal(options.body, undefined); assert.equal(options.redirect, 'error');
    }
  } finally { await site.close(); }
});

test('preview refuses remote or credential-bearing source origins before fetching', async () => {
  for (const sourceOrigin of ['https://example.com', 'http://user:password@127.0.0.1:3004', 'http://127.0.0.1:3004/api/mint']) {
    await assert.rejects(startFontStudy({ sourceOrigin, fetchSource: () => { throw Error('Must not fetch'); } }));
  }
});
