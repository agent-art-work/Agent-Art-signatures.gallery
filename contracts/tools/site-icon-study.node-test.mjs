import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { startSiteIconStudy, SITE_ICON_STUDY_PATH, SITE_ICON_CASE_STUDY_PATH } from '../../scripts/site-icon-study.mjs';
import { FAVICON_SVG } from '../../src/brand/favicon.ts';
import { signatureIcon } from '../../src/brand/signatureIcon.ts';
import { SITE_ICON_MBTI_CASES } from '../../src/brand/siteIconMbtiStudy.ts';

const candidates = ['S', 's'];
const readIcon = id => signatureIcon(id).svg;

for (const id of candidates) {
  test(`${id} is a self-contained square SVG proposal, not an external asset or executable page`, () => {
    const svg = readIcon(id);
    assert.match(svg, /width="64" height="64" viewBox="[\d. ]+"/);
    assert.match(svg, /<title>[^<]+<\/title>/);
    assert.match(svg, /<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="#f4e7c7"\/>/);
    assert.match(svg, /#000000/);
    assert.doesNotMatch(svg, /<script|<style|<image|<text|<foreignObject|href=|on\w+=/i);
  });
  for (const size of [16, 32, 64]) test(`${id} has visible ink and unclipped opaque margins at ${size}px`, async () => {
    const { data, info } = await sharp(Buffer.from(readIcon(id))).resize(size, size).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, size); assert.equal(info.height, size); assert.equal(info.channels, 4);
    let ink = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      assert.equal(data[offset + 3], 255);
      if (data[offset] < 100) ink++;
      if (x === 0 || x === size - 1 || y === 0 || y === size - 1) assert.deepEqual([...data.subarray(offset, offset + 3)], [244, 231, 199]);
    }
    assert.ok(ink > size * size * .015 && ink < size * size * .45, 'The mark remains distinct from an empty or solid frame.');
  });
}

test('the comparison is local and read-only, with S/s and capital S as the site favicon', async t => {
  const site = await startSiteIconStudy({ port: 0 }); t.after(site.close);
  const fetchPage = (path, options = {}) => fetch(site.origin + path, { ...options, headers: { connection: 'close' } });
  const page = await fetchPage(SITE_ICON_CASE_STUDY_PATH), html = await page.text();
  assert.equal(page.status, 200); assert.equal(page.headers.get('set-cookie'), null);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.equal((html.match(/data-icon-candidate=/g) ?? []).length, 2);
  assert.match(html, /S is the site icon/);
  assert.match(html, /ENFP for both/);
  assert.match(html, /not a Grok assessment or a minted work/);
  assert.doesNotMatch(html, /<script|<form|data-connect-wallet|\/api\//);
  for (const id of candidates) {
    const response = await fetchPage(`/${id}.svg`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    assert.equal(await response.text(), readIcon(id));
  }
  assert.equal(await (await fetchPage('/current.svg')).text(), FAVICON_SVG);
  assert.equal(FAVICON_SVG, readIcon('S'));
  assert.equal((await fetchPage('/style.css')).status, 200);
  assert.equal((await fetchPage('/assets/fonts.css')).status, 200);
  assert.equal((await fetchPage('/S.svg?change=true')).status, 400);
  assert.equal((await fetchPage('/gesture.svg')).status, 404);
  assert.equal((await fetchPage('/api/mint')).status, 404);
  assert.equal((await fetchPage('/S.svg', { method: 'POST' })).status, 405);
});

test('the primary study serves all 16 capital S MBTI inputs without changing the selected favicon', async t => {
  const site = await startSiteIconStudy({ port: 0 }); t.after(site.close);
  const fetchPage = (path, options = {}) => fetch(site.origin + path, { ...options, headers: { connection: 'close' } });
  const page = await fetchPage(SITE_ICON_STUDY_PATH), html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('set-cookie'), null);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.equal((html.match(/data-mbti-icon=/g) ?? []).length, 16);
  assert.equal((html.match(/Current icon<\/span>/g) ?? []).length, 1);
  assert.match(html, /current site icon is still S × ENFP/);
  assert.match(html, /href="https:\/\/signatures\.gallery\/"/);
  assert.doesNotMatch(html, /href="http:\/\/(?:127\.0\.0\.1|localhost):/);
  assert.match(html, /Some variants look alike/);
  assert.match(html, /not Grok assessments or minted works|not.*Grok assessments or minted works/);
  assert.doesNotMatch(html, /<script|<form|data-connect-wallet|\/api\/|MBTI_ICON_CARDS/);
  for (const { mbti, svg } of SITE_ICON_MBTI_CASES) {
    assert.ok(html.includes(`data-mbti-icon="${mbti}"`));
    assert.ok(html.includes(`alt="Algorithm-generated S × ${mbti}"`));
    const response = await fetchPage(`/S/${mbti}.svg`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    assert.equal(await response.text(), svg);
  }
  assert.equal(await (await fetchPage('/')).text(), html);
  assert.equal(await (await fetchPage('/current.svg')).text(), FAVICON_SVG);
  assert.equal((await fetchPage('/S/XXXX.svg')).status, 404);
  assert.equal((await fetchPage('/S/enfp.svg')).status, 404);
  assert.equal((await fetchPage('/S/ENFP.svg?change=true')).status, 400);
  assert.equal((await fetchPage('/S/ENFP.svg', { method: 'POST' })).status, 405);
});
