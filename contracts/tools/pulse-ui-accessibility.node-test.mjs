import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessibilityFixture, UI_ACCESSIBILITY_MATRIX } from '../../scripts/pulse-ui-accessibility.mjs';
import { OPEN_MINT_CSS } from '../../src/openMint/pages.ts';
import { SEPOLIA_ADMIN_CSS } from '../../scripts/pulse-sepolia-admin-page.mjs';

test('offline browser audit covers mobile widths, zoom reflow, themes and sale phases', () => {
  assert.equal(UI_ACCESSIBILITY_MATRIX.length, 48);
  for (const page of ['home', 'mint', 'admin']) for (const theme of ['light', 'dark']) for (const width of [320, 375, 390, 640])
    assert.ok(UI_ACCESSIBILITY_MATRIX.some(entry => entry.page === page && entry.theme === theme && entry.width === width));
  assert.ok(UI_ACCESSIBILITY_MATRIX.filter(entry => entry.width === 640).every(entry => entry.zoom === 2));
  assert.deepEqual([...new Set(UI_ACCESSIBILITY_MATRIX.filter(entry => entry.page === 'mint').map(entry => entry.phase))], ['free', 'paid', 'unknown']);
});

test('home guidance wraps at readable size and mobile wallet layout preserves address width', () => {
  assert.match(OPEN_MINT_CSS, /\.home-guidance\{font-size:16px;line-height:1\.5;text-align:center;margin/);
  assert.doesNotMatch(OPEN_MINT_CSS, /font-size:min\(16px,2\.4cqi\)/);
  assert.match(OPEN_MINT_CSS, /@media\(max-width:600px\)\{\.open-mint \.mint-entry-wallet \[data-wallet-controls\]\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(SEPOLIA_ADMIN_CSS, /\[data-admin-wallets\]\{[^}]*white-space:pre-wrap;overflow-wrap:anywhere/);
  assert.doesNotMatch(SEPOLIA_ADMIN_CSS, /white-space:pre;overflow-x:auto/);
});

test('real mint/admin templates expose named headings and atomic status updates without replacing artwork controls', () => {
  const mint = accessibilityFixture('mint'), admin = accessibilityFixture('admin');
  assert.match(mint, /<h1 class="visually-hidden">Mint &amp; reveal<\/h1>/);
  assert.match(mint, /aria-labelledby="mint-price-heading"/);
  assert.match(mint, /id="mint-price-heading" data-pulse-title/);
  assert.match(mint, /data-pulse-feedback role="status" aria-atomic="true"/);
  assert.match(admin, /data-admin-state role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(mint, /class="open-handle-input" id="open-handle"/);
  assert.match(mint, /aria-describedby="handle-validation mint-explanation request-feedback"/);
});

test('fixture pages have synthetic data only and load no production wallet/RPC client', () => {
  for (const page of ['home', 'mint', 'admin']) {
    const html = accessibilityFixture(page);
    assert.match(html, /src="\/assets\/qa\.js"/);
    assert.doesNotMatch(html, /src="\/assets\/(?:sepolia(?:-admin|-readiness)?|open-mint)\.js"/);
    assert.doesNotMatch(html, /PRIVATE_KEY|eth_sendTransaction|personal_sign|https:\/\/[^" ]+\.rpc/);
  }
  assert.throws(() => accessibilityFixture('unknown'), /Unknown accessibility fixture/);
});
