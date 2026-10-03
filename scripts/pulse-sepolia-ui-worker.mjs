import assert from 'node:assert/strict';
import * as pages from '../src/openMint/pages.ts';
import { renderSignatureSvg } from '../src/algorithmV2/index.ts';
import { SITE_CSS } from '../src/v1/siteCss.ts';
import { SITE_FONT_CSS, siteFontAsset } from '../src/v1/fonts.ts';
import { FAVICON_URL, FAVICON_SVG } from '../src/brand/favicon.ts';
import { SLOGAN_MBTI_HERO_SCRIPT_URL, SLOGAN_MBTI_HERO_SCRIPT } from '../src/brand/sloganMbtiHero.ts';
import { SLOGAN_TOOLTIP_SCRIPT_URL, SLOGAN_TOOLTIP_SCRIPT } from '../src/brand/sloganTooltipScript.ts';
import { mintControlStudyPage, MINT_CONTROL_STUDY_CSS_PATH, MINT_CONTROL_STUDY_CSS, MINT_CONTROL_STUDY_SCRIPT_PATH, MINT_CONTROL_STUDY_SCRIPT } from '../src/brand/mintControlStudy.ts';
import { SEPOLIA_TEST_CLIENT } from './pulse-sepolia-client.mjs';
import { SEPOLIA_READINESS_CLIENT } from './pulse-sepolia-readiness-client.mjs';
import { sepoliaAdminPage, SEPOLIA_ADMIN_CSS } from './pulse-sepolia-admin-page.mjs';
import { SEPOLIA_ADMIN_CLIENT } from './pulse-sepolia-admin-client.mjs';

// This render-only child has no inherited credentials, signer, RPC, sessions,
// request journal or state writer. Replacing it cannot restart the backend.
const names = ['homePage', 'mintPage', 'explorePage', 'assessmentPage', 'revealedSignature', 'previewPage', 'previewVariationsPage',
  'mbtiGalleryPage', 'collectionPage', 'aboutPage', 'errorPage'];
const assets = new Map([
  ['/assets/sepolia.css', [SITE_FONT_CSS + SITE_CSS + pages.OPEN_MINT_CSS, 'text/css']],
  ['/assets/sepolia.js', [SEPOLIA_TEST_CLIENT, 'text/javascript']],
  ['/assets/sepolia-readiness.js', [SEPOLIA_READINESS_CLIENT, 'text/javascript']],
  ['/assets/sepolia-admin.js', [SEPOLIA_ADMIN_CLIENT, 'text/javascript']],
  ['/assets/sepolia-admin.css', [SEPOLIA_ADMIN_CSS, 'text/css']],
  [FAVICON_URL, [FAVICON_SVG, 'image/svg+xml']],
  [SLOGAN_MBTI_HERO_SCRIPT_URL, [SLOGAN_MBTI_HERO_SCRIPT, 'text/javascript']],
  [SLOGAN_TOOLTIP_SCRIPT_URL, [SLOGAN_TOOLTIP_SCRIPT, 'text/javascript']],
  [MINT_CONTROL_STUDY_CSS_PATH, [MINT_CONTROL_STUDY_CSS, 'text/css']],
  [MINT_CONTROL_STUDY_SCRIPT_PATH, [MINT_CONTROL_STUDY_SCRIPT, 'text/javascript']],
]);
assert.ok(process.send, 'UI renderer requires a private IPC parent');
process.on('message', request => {
  try {
    assert.ok(Number.isSafeInteger(request.id)); assert.ok(Buffer.byteLength(JSON.stringify(request)) < 1024 * 1024);
    let result;
    if (request.name === 'asset') {
      assert.equal(typeof request.args[0], 'string');
      result = assets.get(request.args[0]);
      if (!result) {
        const font = siteFontAsset(request.args[0]);
        if (font) result = [{ kind: 'font', encoding: 'base64', data: font.bytes.toString('base64') }, font.contentType];
      }
    }
    else if (request.name === 'sepoliaAdminPage') result = sepoliaAdminPage(...request.args);
    else if (request.name === 'mintControlStudyPage') result = mintControlStudyPage(...request.args);
    else if (request.name === 'previewSvg') result = renderSignatureSvg(...request.args);
    else { assert.ok(names.includes(request.name)); result = pages[request.name](...request.args); }
    process.send({ id: request.id, result });
  } catch { process.send({ id: request?.id, error: 'UI_RENDER_UNAVAILABLE' }); }
});
process.send({ ready: true });
