/** Before minting opens, the wallet dot explains the phase instead of connecting. */
export function walletShortcut(prelaunch: boolean): string {
  if (!prelaunch) return '<a class="collection-shortcut" href="/me" aria-label="My Collection" title="My Collection"><span class="collection-shortcut-dot" aria-hidden="true"></span></a>';
  // A native disclosure still works without JavaScript. It is informational,
  // not an authentication control, and deliberately has no wallet address.
  return '<details class="preview-wallet-menu" data-preview-wallet-notice><summary class="collection-shortcut" aria-label="Wallet information" title="Wallet information" aria-controls="preview-wallet-notice"><span class="collection-shortcut-dot" aria-hidden="true"></span></summary><section class="preview-wallet-panel" id="preview-wallet-notice" aria-labelledby="preview-wallet-title"><h2 id="preview-wallet-title">Wallet</h2><p>Wallet connection isn’t needed yet.<br>Minting hasn’t opened.</p><p>Connect a wallet when minting opens.</p><a class="auth-action" href="/explore"><span>Explore previews</span></a></section></details>';
}

/** Self-contained for both serialized clients; never touches providers or sessions. */
export function bindPreviewWalletNotice(doc: Document): void {
  const notice = doc.querySelector<HTMLDetailsElement>("[data-preview-wallet-notice]");
  if (!notice || notice.dataset.previewWalletBound === "true") return;
  notice.dataset.previewWalletBound = "true";
  doc.addEventListener("pointerdown", event => {
    if (notice.open && event.target && !notice.contains(event.target as Node)) notice.open = false;
  });
  doc.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !notice.open) return;
    notice.open = false;
    notice.querySelector<HTMLElement>("summary")?.focus();
    event.preventDefault();
  });
}

export const PREVIEW_WALLET_CSS = `
.book-page>main>.preview-wallet-menu{inset-inline-end:max(var(--nav-inset),calc(env(safe-area-inset-right) - 22px))}
.preview-wallet-menu{position:absolute;inset-block-start:max(.75rem,env(safe-area-inset-top));z-index:30;width:44px;height:44px;margin:0}
.preview-wallet-menu>.collection-shortcut{inset:0;padding:0;border:0;background:transparent;list-style:none;cursor:pointer}
.preview-wallet-menu>.collection-shortcut::-webkit-details-marker{display:none}
.preview-wallet-menu>.collection-shortcut::marker{content:""}
.preview-wallet-panel{position:absolute;inset-block-start:calc(100% + 8px);inset-inline-end:0;width:320px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 88px);overflow-y:auto;overscroll-behavior:contain;padding:24px;border:1px solid var(--line);border-radius:16px;background:var(--paper);color:var(--ink);font-size:16px;line-height:1.6;box-shadow:0 8px 24px var(--art-shadow)}
.preview-wallet-panel h2{margin:0 0 16px;font-size:18px;font-weight:var(--emphasis-font-weight);line-height:1.5}
.preview-wallet-panel p{margin:0 0 16px;color:var(--muted)}
.preview-wallet-panel .auth-action{width:100%}
`;
