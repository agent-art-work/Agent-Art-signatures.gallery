import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fontStudyAsset, fontStudyFamily, fontStudyVariant, fontStudyPage, FONT_STUDY_SCRIPT_PATH, FONT_STUDY_SCRIPT } from '../src/brand/fontStudy.ts';
import { siteFontAsset } from '../src/v1/fonts.ts';

/** Separate, GET-only UI preview. No credentials, wallet APIs, RPCs or state writers. */
export async function startFontStudy({ port = 3005, sourceOrigin = 'http://127.0.0.1:3004', fetchSource = fetch } = {}) {
  assert.notEqual(process.env.NODE_ENV, 'production');
  const source = new URL(sourceOrigin);
  assert.equal(source.protocol, 'http:'); assert.equal(source.hostname, '127.0.0.1');
  assert.ok(!source.username && !source.password && source.pathname === '/' && !source.search && !source.hash);
  const cachedAssets = new Map(), allowedAssets = new Set();
  async function readSource(path) {
    const response = await fetchSource(new URL(path, source), { redirect: 'error', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, 'Source page or asset is unavailable');
    return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  }
  // Freeze the same anonymous pages/artwork for a fair family/weight comparison.
  const [home, mint] = await Promise.all(['/', '/mint?handle=AnAgentArtist'].map(readSource));
  const pages = { home: home.bytes.toString(), mint: mint.bytes.toString() };
  for (const html of Object.values(pages)) {
    for (const match of html.matchAll(/<(?:link|img)\b[^>]*(?:href|src)="(\/[^"<>]+)"/g)) {
      const url = new URL(match[1], source);
      if (url.pathname.startsWith('/assets/') || /^\/test-art\/[a-z0-9_]{1,15}\.svg$/.test(url.pathname)) allowedAssets.add(url.pathname + url.search);
    }
  }
  // CSS is also a snapshot; referenced fonts are an explicit asset allowlist.
  for (const path of allowedAssets) {
    if (!new URL(path, source).pathname.endsWith('.css')) continue;
    const asset = await readSource(path); cachedAssets.set(path, asset);
    for (const match of asset.bytes.toString().matchAll(/url\(['"]?(\/assets\/[^)'"\s]+)['"]?\)/g)) allowedAssets.add(match[1]);
  }
  let origin;
  const server = createServer(async (req, res) => {
    const send = (status, value, type = 'text/plain; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type }); res.end(value); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (req.headers.host !== new URL(origin).host || (req.url?.length ?? 0) > 2048) return send(400, 'Invalid preview request.');
      if (req.method !== 'GET') return send(405, 'Read-only typography preview.');
      const url = new URL(req.url, origin), path = url.pathname;
      if (url.origin !== origin) return send(400, 'Invalid preview request.');
      if (path.startsWith('/api/')) return send(404, 'No wallet or mint APIs exist in this preview.');
      if (path === FONT_STUDY_SCRIPT_PATH) return send(200, FONT_STUDY_SCRIPT, 'text/javascript; charset=utf-8');
      const font = fontStudyAsset(path) ?? siteFontAsset(path);
      if (font) return send(200, font.bytes, font.contentType);
      if (path === '/' || path === '/mint') {
        const handle = url.searchParams.get('handle') ?? 'AnAgentArtist';
        if (!/^@?[A-Za-z0-9_]{0,15}$/.test(handle)) return send(400, 'Enter a valid X handle for this preview.');
        const view = path === '/' ? 'home' : 'mint';
        return send(200, fontStudyPage(pages[view], view, fontStudyFamily(url.searchParams.get('font')), source.origin, handle, fontStudyVariant(url.searchParams.get('variant'))), 'text/html; charset=utf-8');
      }
      const key = path + url.search;
      if (!allowedAssets.has(key)) return send(404, 'Preview asset not found.');
      let asset = cachedAssets.get(key);
      if (!asset) { asset = await readSource(key); cachedAssets.set(key, asset); }
      if (asset.contentType.includes('svg')) res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      return send(200, asset.bytes, asset.contentType);
    } catch { return send(503, 'Typography preview asset is temporarily unavailable.'); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise(accept => server.close(accept)) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startFontStudy().then(site => {
    console.log(`Home font comparison: ${site.origin}/?font=space-grotesk`);
    console.log(`Mint font comparison: ${site.origin}/mint?font=space-grotesk`);
    const stop = () => site.close().then(() => process.exit());
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }).catch(() => { console.error('Font preview could not start. Check that the local site is running on port 3004.'); process.exitCode = 1; });
}
