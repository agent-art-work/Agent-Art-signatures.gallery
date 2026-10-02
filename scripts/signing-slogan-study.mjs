import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SIGNING_SLOGAN_STUDY_PATH, SIGNING_SLOGAN_STUDY_CSS_PATH, SIGNING_SLOGAN_STUDY_CSS,
  signingSloganStudyPage } from '../src/brand/sloganSigningStudy.ts';
import { SITE_CSS, SITE_CSS_URL } from '../src/v1/siteCss.ts';
import { siteFontAsset } from '../src/v1/fonts.ts';
import { FAVICON_URL, FAVICON_SVG } from '../src/brand/favicon.ts';
import { SLOGAN_MBTI_HERO_SCRIPT_URL, SLOGAN_MBTI_HERO_SCRIPT } from '../src/brand/sloganMbtiHero.ts';

/** Standalone, anonymous artwork comparison. No upstream, wallet, RPC or state writer exists here. */
export async function startSigningSloganStudy({ port = 3006 } = {}) {
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.ok(Number.isSafeInteger(port) && (port === 0 || port >= 1024) && port <= 65535);
  const assets = new Map([
    [SITE_CSS_URL, [SITE_CSS, 'text/css; charset=utf-8']],
    [SIGNING_SLOGAN_STUDY_CSS_PATH, [SIGNING_SLOGAN_STUDY_CSS, 'text/css; charset=utf-8']],
    [FAVICON_URL, [FAVICON_SVG, 'image/svg+xml']],
    [SLOGAN_MBTI_HERO_SCRIPT_URL, [SLOGAN_MBTI_HERO_SCRIPT, 'text/javascript; charset=utf-8']],
  ]);
  let origin;
  const server = createServer((req, res) => {
    const send = (status, value, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type }); res.end(value);
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      assert.equal(req.headers.host, new URL(origin).host);
      assert.ok(typeof req.url === 'string' && req.url.length <= 2048);
      const url = new URL(req.url, origin);
      assert.equal(url.origin, origin);
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(405, 'Read-only slogan study.'); }
      if (url.pathname === '/' || url.pathname === SIGNING_SLOGAN_STUDY_PATH) {
        const layout = url.searchParams.get('layout') === 'native' ? 'native' : 'fit';
        return send(200, signingSloganStudyPage(SITE_CSS_URL, url.searchParams.get('shape') ?? undefined, layout), 'text/html; charset=utf-8');
      }
      const key = url.pathname + url.search, asset = assets.get(key);
      if (asset) return send(200, asset[0], asset[1]);
      const font = !url.search && siteFontAsset(url.pathname);
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
  startSigningSloganStudy({ port: Number(process.env.PORT ?? 3006) }).then(site => {
    console.log(`Slogan wording study: ${site.origin}${SIGNING_SLOGAN_STUDY_PATH}`);
    const stop = () => { void site.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }).catch(() => { console.error('Slogan study could not start. Check the local port and study build.'); process.exitCode = 1; });
}
