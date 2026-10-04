import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SITE_FONT_CSS, siteFontAsset } from '../src/v1/fonts.ts';
import { FAVICON_SVG } from '../src/brand/favicon.ts';
import { signatureIcon } from '../src/brand/signatureIcon.ts';
import { SITE_ICON_MBTI_CASES } from '../src/brand/siteIconMbtiStudy.ts';

export const SITE_ICON_STUDY_PATH = '/design/site-icons';
export const SITE_ICON_CASE_STUDY_PATH = '/design/site-icons/case';
const directory = fileURLToPath(new URL('../design/site-icons/', import.meta.url));

/** Isolated, read-only branding comparison; no provider, wallet, RPC or state writer. */
export async function startSiteIconStudy({ port = 3009 } = {}) {
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.ok(Number.isSafeInteger(port) && (port === 0 || port >= 1024) && port <= 65535);
  const cards = SITE_ICON_MBTI_CASES.map(({ mbti }) => `<article class="icon-candidate" data-mbti-icon="${mbti}"><h2>${mbti}${mbti === 'ENFP' ? '<span>Current icon</span>' : ''}</h2><div class="icon-stage"><img class="icon-large" src="/S/${mbti}.svg" width="128" height="128" alt="Algorithm-generated S × ${mbti}"></div><div class="icon-sizes" aria-label="${mbti} at favicon sizes"><span><img src="/S/${mbti}.svg" width="16" height="16" alt="${mbti} at 16 pixels">16 px</span><span><img src="/S/${mbti}.svg" width="32" height="32" alt="${mbti} at 32 pixels">32 px</span></div></article>`).join('\n');
  const template = readFileSync(resolve(directory, 'index.html'), 'utf8');
  assert.equal(template.split('<!-- MBTI_ICON_CARDS -->').length, 2);
  const html = template.replace('<!-- MBTI_ICON_CARDS -->', cards);
  const assets = new Map([
    ['/', [html, 'text/html; charset=utf-8']],
    [SITE_ICON_CASE_STUDY_PATH, [readFileSync(resolve(directory, 'case.html')), 'text/html; charset=utf-8']],
    ['/style.css', [readFileSync(resolve(directory, 'style.css')), 'text/css; charset=utf-8']],
    ['/assets/fonts.css', [SITE_FONT_CSS, 'text/css; charset=utf-8']],
    ['/current.svg', [FAVICON_SVG, 'image/svg+xml']],
    ...['S', 's'].map(letter => [`/${letter}.svg`, [signatureIcon(letter).svg, 'image/svg+xml']]),
    ...SITE_ICON_MBTI_CASES.map(({ mbti, svg }) => [`/S/${mbti}.svg`, [svg, 'image/svg+xml']]),
  ]);
  assets.set(SITE_ICON_STUDY_PATH, assets.get('/'));
  let origin;
  const server = createServer((req, res) => {
    const send = (status, value, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type }); res.end(value);
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      assert.equal(req.headers.host, new URL(origin).host);
      assert.ok(typeof req.url === 'string' && req.url.length <= 2048);
      const url = new URL(req.url, origin);
      assert.equal(url.origin, origin);
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(405, 'Read-only icon study.'); }
      if (url.search) return send(400, 'No query parameters.');
      const asset = assets.get(url.pathname);
      if (asset) return send(200, asset[0], asset[1]);
      const font = siteFontAsset(url.pathname);
      if (font) return send(200, font.bytes, font.contentType);
      return send(404, 'Study page or asset not found.');
    } catch { return send(400, 'Invalid study request.'); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return { origin, close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startSiteIconStudy({ port: Number(process.env.PORT ?? 3009) }).then(site => {
    console.log(`Algorithm-generated site icons: ${site.origin}${SITE_ICON_STUDY_PATH}`);
    const stop = () => { void site.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }).catch(() => { console.error('Icon study could not start. Check the local port.'); process.exitCode = 1; });
}
