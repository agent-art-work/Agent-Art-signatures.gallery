import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sepoliaAdminPage, SEPOLIA_ADMIN_CSS } from '../../scripts/pulse-sepolia-admin-page.mjs';
import { errorPage } from '../../src/openMint/pages.ts';

const COLLECTION = '0x0000000000000000000000000000000000000002';
const ADMIN = '0x0000000000000000000000000000000000000001';

test('admin page uses the shared shell, dedicated client, and scoped CSS', () => {
  const page = sepoliaAdminPage({ contract: COLLECTION, adminWallet: ADMIN });
  const shell = errorPage('example');
  assert.match(page, /<title>Free mint admin · Signatures Gallery<\/title>/);
  assert.match(page, /data-admin-page data-admin-collection="0x0{39}2"/);
  assert.match(page, /Collection admin: 0x0{39}1/);
  assert.match(page, /Ethereum Sepolia · 11155111/);
  assert.match(page, /src="\/assets\/sepolia-admin\.js" defer/);
  assert.match(page, /href="\/assets\/sepolia-admin\.css"/);
  assert.match(page, /href="\/assets\/sepolia\.css"/);
  for (const className of ['home-return', 'collection-shortcut', 'footer-credit']) {
    assert.ok(shell.includes(className)); assert.ok(page.includes(className));
  }
  assert.doesNotMatch(page, /data-connect-wallet|data-mint-entry|sepolia-readiness|Unable to open this page|__ADMIN_CONTENT__/);
  assert.match(SEPOLIA_ADMIN_CSS, /\.sepolia-admin \.auth-sheet\{max-width:853px\}/);
  assert.doesNotMatch(SEPOLIA_ADMIN_CSS, /@font-face|font-family|:root|border-radius:999px/);
});

test('the initial page locks actions and presents deliberate review and recovery controls', () => {
  const page = sepoliaAdminPage({ collection: COLLECTION });
  for (const action of ['connect', 'logout', 'refresh', 'review', 'pause', 'configure', 'unpause', 'reconcile'])
    assert.match(page, new RegExp('data-admin-' + action + ' disabled'));
  assert.match(page, /repeated address grants multiple slots/);
  assert.match(page, /Append new rows to preserve existing slots/);
  assert.match(page, /Claimed slots cannot be reassigned/);
  assert.match(page, /data-admin-review-summary hidden/);
  assert.match(page, /data-admin-end-ack-label hidden/);
  assert.match(page, /permanently ends the free phase/);
  assert.match(page, /data-admin-reconcile-hash/);
  assert.match(page, /role="status" aria-live="polite"/);
});

test('admin metadata is escaped and custom shared asset options remain available', () => {
  const page = sepoliaAdminPage({ contract: '"><script>alert(1)</script>', adminWallet: '<img src=x onerror=alert(1)>',
    stylesheetUrl: '/custom.css', clientScriptUrl: '/custom.js' });
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>|<img src=x/);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(page, /href="\/custom.css"/); assert.match(page, /src="\/custom.js"/);
});
