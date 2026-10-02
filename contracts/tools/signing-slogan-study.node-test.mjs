import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { startSigningSloganStudy } from '../../scripts/signing-slogan-study.mjs';
import { SIGNING_SLOGAN_STUDY_PATH, SIGNING_SLOGAN_STUDY_CSS_PATH, SIGNING_SLOGAN_STUDY_CSS,
  signingSloganStudyPage } from '../../src/brand/sloganSigningStudy.ts';
import { SITE_CSS, SITE_CSS_URL } from '../../src/v1/siteCss.ts';
import { SITE_FONT_CSS, siteFontAsset } from '../../src/v1/fonts.ts';
import { FAVICON_URL, FAVICON_SVG } from '../../src/brand/favicon.ts';
import { SLOGAN_MBTI_HERO_SCRIPT_URL, SLOGAN_MBTI_HERO_SCRIPT } from '../../src/brand/sloganMbtiHero.ts';

test('standalone slogan comparison serves only anonymous local pages and allowlisted assets', { timeout: 30000 }, async t => {
  const site = await startSigningSloganStudy({ port: 0 });
  t.after(site.close);
  for (const path of ['/', SIGNING_SLOGAN_STUDY_PATH, `${SIGNING_SLOGAN_STUDY_PATH}?shape=INFP`, `${SIGNING_SLOGAN_STUDY_PATH}?shape=ENTJ`,
    `${SIGNING_SLOGAN_STUDY_PATH}?shape=infp`, `${SIGNING_SLOGAN_STUDY_PATH}?layout=native`,
    `${SIGNING_SLOGAN_STUDY_PATH}?shape=INFP&layout=native`, `${SIGNING_SLOGAN_STUDY_PATH}?layout=other`]) {
    const response = await fetch(site.origin + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /form-action 'none'/);
    assert.match(response.headers.get('content-security-policy'), /font-src 'self'/);
    const html = await response.text(), query = new URL(path, site.origin).searchParams;
    assert.equal(html, signingSloganStudyPage(SITE_CSS_URL, query.get('shape') ?? undefined, query.get('layout') === 'native' ? 'native' : 'fit'));
    assert.deepEqual([...html.matchAll(/<figure data-signing-candidate="([^"]+)"/g)].map(match => match[1]),
      ['current', 'camel', 'title-words', 'sentence-words']);
    assert.equal([...html.matchAll(/data-signing-art=/g)].length, 4);
    for (const literal of ['AnyOneCanSignAnyone', 'Anyone Can Sign Anyone', 'Anyone can sign anyone']) assert.ok(html.includes(`<strong>${literal}</strong>`));
    assert.ok(html.includes(`data-layout="${query.get('layout') === 'native' ? 'native' : 'fit'}"`));
    assert.ok(html.includes(`data-animation="${query.get('shape') === 'INFP' ? 'off' : 'on'}"`));
    assert.match(html, /href="http:\/\/127\.0\.0\.1:3004\/"/);
    assert.doesNotMatch(html, /data-open-mint|data-mint-entry|\/assets\/sepolia\.js|\/api\/test/);
  }
  for (const [path, expected, type] of [
    [SITE_CSS_URL, SITE_CSS, 'text/css; charset=utf-8'],
    [SIGNING_SLOGAN_STUDY_CSS_PATH, SIGNING_SLOGAN_STUDY_CSS, 'text/css; charset=utf-8'],
    [FAVICON_URL, FAVICON_SVG, 'image/svg+xml'],
    [SLOGAN_MBTI_HERO_SCRIPT_URL, SLOGAN_MBTI_HERO_SCRIPT, 'text/javascript; charset=utf-8'],
  ]) {
    const response = await fetch(site.origin + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), type);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(await response.text(), expected);
  }
  const fonts = [...new Set([...SITE_FONT_CSS.matchAll(/url\((?:['"])?([^)'"\s]+\.woff2)(?:['"])?\)/g)].map(match => match[1]))];
  assert.equal(fonts.length, 16);
  const license = fonts[0].slice(0, fonts[0].lastIndexOf('/') + 1) + 'LICENSE.txt';
  for (const path of [...fonts, license]) {
    const response = await fetch(site.origin + path), expected = siteFontAsset(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), expected.contentType);
    assert.equal(response.headers.get('set-cookie'), null);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, expected.bytes);
    if (path.endsWith('.woff2')) assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
    else assert.match(bytes.toString(), /SIL OPEN FONT LICENSE/);
  }
  for (const path of ['/api/test/session', '/api/test/begin', '/api/mint', '/mint', '/about', '/unknown', '/.env',
    '/authorizer.key', '/assets/unknown', '/assets/fonts/%2e%2e/authorizer.key', '/assets/fonts/../../.env',
    fonts[0] + '?source=other', SIGNING_SLOGAN_STUDY_CSS_PATH + '?other=1']) {
    const response = await fetch(site.origin + path);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  for (const path of ['/', SIGNING_SLOGAN_STUDY_PATH, '/api/test/begin', fonts[0]]) {
    const response = await fetch(site.origin + path, { method: 'POST', body: 'not-a-submission' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const badHost = await new Promise((accept, reject) => {
    const req = request(site.origin + SIGNING_SLOGAN_STUDY_PATH, { headers: { host: 'example.com' } }, response => {
      response.resume(); response.once('end', () => accept(response));
    });
    req.once('error', reject); req.end();
  });
  assert.equal(badHost.statusCode, 400);
  assert.equal(badHost.headers['set-cookie'], undefined);
});
