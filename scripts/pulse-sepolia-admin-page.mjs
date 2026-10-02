import { errorPage } from '../src/openMint/pages.ts';

const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
const button = (label, name) => `<button class="auth-action" type="button" data-admin-${name} disabled><span>${label}</span></button>`;

/** Only admin layout rules; typography, navigation and controls belong to the shared site. */
export const SEPOLIA_ADMIN_CSS = `
.sepolia-admin .auth-sheet{max-width:853px}
.sepolia-admin .admin-heading{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:.5rem 1rem}
.sepolia-admin .admin-heading h1{font-size:24px}
.sepolia-admin .admin-section{margin-top:1.75rem;padding-top:1.25rem;border-top:1px dashed var(--line)}
.sepolia-admin .admin-section h2{margin:0 0 .75rem;font-size:16px}
.sepolia-admin .admin-wallet{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem 1rem}
.sepolia-admin .admin-wallet>div:first-child{flex:1;min-width:0}
.sepolia-admin .admin-wallet .auth-actions{margin:0}
.sepolia-admin .admin-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem 2rem;margin:1rem 0}
.sepolia-admin .admin-facts>div{min-width:0}
.sepolia-admin .admin-facts dt,.sepolia-admin .admin-field>span,.sepolia-admin .admin-note{color:var(--muted)}
.sepolia-admin .admin-facts dd{margin:.25rem 0 0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.sepolia-admin .admin-facts .admin-wide{grid-column:1/-1}
.sepolia-admin .admin-field{display:grid;gap:.35rem;margin-top:1rem}
.sepolia-admin [data-admin-wallets]{min-height:13rem;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.sepolia-admin .admin-quota{max-width:16rem}
.sepolia-admin .admin-feedback:empty{display:none}
.sepolia-admin .admin-review{margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--line)}
.sepolia-admin .admin-review h3{font-size:14px;margin:0}
.sepolia-admin .admin-actions{display:flex;flex-wrap:wrap;gap:.75rem 1rem;margin-top:1rem}
.sepolia-admin .admin-ack{display:flex;align-items:flex-start;gap:.65rem;margin:1rem 0;cursor:pointer}
.sepolia-admin .admin-ack input{flex:none;margin-top:.25rem}
.sepolia-admin .admin-pending-hash{overflow-wrap:anywhere}
.sepolia-admin .admin-pending .admin-field{margin-top:.5rem}
@media(max-width:600px){.sepolia-admin .admin-facts{grid-template-columns:minmax(0,1fr)}.sepolia-admin .admin-actions>button{width:100%}.sepolia-admin .admin-wallet{align-items:flex-start}}
`;

export function sepoliaAdminPage(options = {}) {
  const contract = options.collection ?? options.contract ?? '';
  const body = `<section class="auth-page sepolia-admin" data-admin-page data-admin-collection="${escape(contract)}"><div class="auth-sheet">
<div class="admin-heading"><h1>Free mint admin</h1><span class="signature-tag" data-admin-state role="status" aria-live="polite" aria-atomic="true">Sign in to check policy</span></div>
<p class="admin-note">Ethereum Sepolia · RC2. Each change is signed and sent by your admin wallet.</p>
<dl class="admin-facts"><div><dt>Network</dt><dd>Ethereum Sepolia · 11155111</dd></div><div><dt>Collection</dt><dd data-admin-contract>${escape(contract)}</dd></div></dl>
<section class="admin-section" aria-labelledby="admin-wallet-title"><h2 id="admin-wallet-title">Admin wallet</h2>
<div class="admin-wallet"><div>${options.adminWallet ? `<p class="admin-note">Collection admin: ${escape(options.adminWallet)}</p>` : ''}<p data-admin-wallet-label>Connect the admin wallet to manage this collection.</p></div><div class="auth-actions">${button('Connect admin wallet', 'connect')}${button('Sign out', 'logout')}</div></div>
<p class="admin-feedback open-feedback" data-admin-wallet-feedback role="status" aria-live="polite"></p></section>
<section class="admin-section" aria-labelledby="admin-policy-title"><h2 id="admin-policy-title">Current policy</h2>
<dl class="admin-facts"><div><dt>Free mints used / quota</dt><dd data-admin-used>—</dd></div><div><dt>Allowlist slots</dt><dd data-admin-slots>—</dd></div><div><dt>Free deadline</dt><dd data-admin-deadline>—</dd></div><div><dt>Revision</dt><dd data-admin-revision>—</dd></div><div class="admin-wide"><dt>Merkle root</dt><dd data-admin-root>—</dd></div></dl>
<div class="auth-actions">${button('Refresh policy', 'refresh')}</div><p class="admin-feedback open-feedback" data-admin-feedback role="status" aria-live="polite"></p></section>
<section class="admin-section" aria-labelledby="admin-edit-title"><h2 id="admin-edit-title">Allowlist &amp; free quota</h2>
<p>One address per row. Row order defines slot IDs; a repeated address grants multiple slots. Append new rows to preserve existing slots. Claimed slots cannot be reassigned.</p>
<label class="admin-field"><span>Full ordered allowlist</span><textarea data-admin-wallets spellcheck="false" autocomplete="off" aria-describedby="admin-list-note" disabled></textarea></label>
<p class="admin-note" id="admin-list-note">Review the complete list before applying it. Quota is the total number of free mints, including mints already used.</p>
<label class="admin-field admin-quota"><span>Total free quota</span><input data-admin-quota type="text" inputmode="numeric" pattern="0|[1-9][0-9]*" autocomplete="off" disabled></label>
<div class="auth-actions">${button('Review changes', 'review')}</div>
<div class="admin-review" data-admin-review-summary hidden><h3>Reviewed change</h3><dl class="admin-facts"><div><dt>Quota</dt><dd data-admin-review-quota></dd></div><div><dt>Slots</dt><dd data-admin-review-slots></dd></div><div class="admin-wide"><dt>Slot changes</dt><dd data-admin-review-changes></dd></div><div class="admin-wide"><dt>New Merkle root</dt><dd data-admin-review-root></dd></div></dl>
<p class="open-preview-notice open-preview-warning" data-admin-end-warning hidden><strong class="open-preview-notice-label">Warning</strong> Applying a quota equal to free mints already used permanently ends the free phase. Raising the quota later cannot reopen it.</p>
<label class="admin-ack" data-admin-end-ack-label hidden><input type="checkbox" data-admin-end-ack><span>I understand that this change permanently ends free minting.</span></label></div>
<p class="admin-feedback open-feedback" data-admin-review-feedback role="status" aria-live="polite"></p></section>
<section class="admin-section" aria-labelledby="admin-action-title"><h2 id="admin-action-title">Minting controls</h2><p>Pause minting before applying the reviewed allowlist and quota. Resume only when the current policy is ready.</p>
<div class="admin-actions">${button('Pause minting', 'pause')}${button('Apply allowlist &amp; quota', 'configure')}${button('Resume minting', 'unpause')}</div>
<p class="admin-feedback open-feedback" data-admin-action-feedback role="status" aria-live="polite"></p></section>
<section class="admin-section admin-pending" data-admin-pending hidden aria-labelledby="admin-pending-title"><h2 id="admin-pending-title">Pending admin transaction</h2><p data-admin-pending-summary></p><p class="admin-pending-hash" data-admin-pending-hash></p>
<label class="admin-field"><span>Transaction hash from wallet activity</span><input data-admin-reconcile-hash type="text" spellcheck="false" autocomplete="off" placeholder="0x…"></label>
<div class="auth-actions">${button('Check transaction', 'reconcile')}</div><p class="admin-feedback open-feedback" data-admin-pending-feedback role="status" aria-live="polite"></p></section>
</div></section>`;
  // Reuse the real site shell instead of reproducing fonts, controls or navigation.
  const shell = errorPage('__ADMIN_CONTENT__', { ...options, contract, chainId: '11155111', chainName: 'Ethereum Sepolia',
    stylesheetUrl: options.stylesheetUrl ?? '/assets/sepolia.css', clientScriptUrl: options.clientScriptUrl ?? '/assets/sepolia-admin.js' });
  const placeholder = '<section class="auth-page"><div class="auth-sheet"><h1>Unable to open this page</h1><p role="alert">__ADMIN_CONTENT__</p><a class="auth-action" href="/"><span>Back to gallery</span></a></div></section>';
  if (!shell.includes(placeholder)) throw Error('Shared admin page shell changed.');
  return shell.replace(placeholder, body).replace('<title>Unable to open this page ·', '<title>Free mint admin ·')
    .replace('</head>', '<link rel="stylesheet" href="/assets/sepolia-admin.css"></head>');
}
