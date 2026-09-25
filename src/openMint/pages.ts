import { SITE_FONT_PRELOAD } from "../v1/fonts.js";
import { SITE_CSS_URL } from "../v1/siteCss.js";
import { HOME_LINK } from "../v1/navigation.js";
import { FAVICON_LINK } from "../brand/favicon.js";
import { siteFooter } from "../brand/footer.js";
import { handleLink, handleVariationsPath } from "./handleLink.js";
import { SLOGAN_MBTI_HERO_MANIFEST, SLOGAN_MBTI_HERO_SVG, SLOGAN_MBTI_HERO_CSS, SLOGAN_MBTI_HERO_SCRIPT_URL } from "../brand/sloganMbtiHero.js";
import { mintUiState } from "./mintUiState.js";
import { assessmentFailureText } from "./clientScript.js";
import { SLOGAN_TOOLTIP_SCRIPT_URL } from "../brand/sloganTooltipScript.js";
import { isMbti, MBTI_TYPES, preservedHandle, RENDERER_VERSION, type MBTI } from "./identity.js";
import type { PublicPreviewState } from "./previewState.js";
import { openMintSupportUrl } from "./supportUrl.js";
import { provenanceBody } from "./provenance.js";
import { canRevealMint, type MintConfidence } from "./revealPolicy.js";

export interface OpenMintPageOptions {
  csrfToken?: string;
  wallet?: string | null;
  walletVerified?: boolean;
  chainId?: string;
  chainName?: string;
  contract?: string;
  rpcUrl?: string;
  supportUrl?: string;
  publicOrigin?: string;
  clientScriptUrl?: string;
  stylesheetUrl?: string;
  durableWalletSubmission?: boolean;
  generativeArtwork?: boolean;
  development?: {
    fixture: boolean;
    localChain?: boolean;
    galleryFixtures?: boolean;
    tools?: Array<{ label: string; href: string }>;
    notes?: string[];
  };
}

export interface MintPageState {
  state: MintConfidence;
  transactionHash?: string;
  tokenId?: string;
  wallet?: string;
  explorerUrl?: string;
  submissionUncertain?: boolean;
}

export interface AssessmentPageModel {
  handle: string;
  renderHandle?: string;
  code: string;
  status: "pending" | "ready" | "failed" | "abstained";
  canMint: boolean;
  walletProvedForCode?: boolean;
  requestExpired?: boolean;
  requestExpiresAt?: number;
  walletProofExpiresAt?: number;
  serverNow?: number;
  mbti?: string;
  imageUrl?: string;
  svgUrl?: string;
  rendererVersion?: string;
  svgSha256?: string;
  pngSha256?: string;
  artifactDigest?: string;
  inputDigest?: string;
  rendererIdentity?: string;
  assessmentDigest?: string;
  assessedAt?: string;
  identityVerifiedAt?: string;
  assessmentProvenance?: "grok" | "development-fixture";
  assessmentModel?: string;
  assessmentSourceUrls?: readonly string[];
  verifiedXUserId?: string;
  error?: string;
  diagnosticReference?: string;
  errorCategory?: "assessment-abstained" | "assessment-blocked" | "preparation-interrupted";
  tokenId?: string;
  mint?: MintPageState;
  /** Presentation-only sample; never a chain-backed mint record. */
  galleryFixture?: boolean;
}

export interface GalleryEntry {
  handle: string;
  renderHandle?: string;
  code: string;
  mbti: string;
  imageUrl: string;
  url?: string;
  mint?: MintPageState;
}

const escapeHtml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
const e = (value: unknown): string => escapeHtml(String(value ?? ""));
const safeUrl = (value: string | undefined, fallback = "#"): string => {
  if (!value) return fallback;
  if (/^\/(?!\/)/.test(value) && !/[\\\u0000-\u0020]/.test(value)) return value;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : fallback; } catch { return fallback; }
};
export function canonicalPageHandle(value: string): string {
  const handle = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new Error("Enter an X handle with 1–15 letters, numbers, or underscores.");
  return handle;
}
const mintPath = (handle: string): string => `/mint?handle=${encodeURIComponent(preservedHandle(handle))}`;
const signaturePath = (handle: string): string => `/signatures/${canonicalPageHandle(handle)}`;
const renderedPageHandle = (handle: string, renderHandle?: string): string => {
  const canonical = canonicalPageHandle(handle);
  const preserved = preservedHandle(renderHandle ?? canonical);
  if (canonicalPageHandle(preserved) !== canonical) throw new Error("The artwork handle does not match its identity.");
  return preserved;
};
const action = (label: string, attributes: string): string => `<button class="auth-action" type="button" ${attributes}><span>${e(label)}</span></button>`;
const mbtiLink = (mbti: string): string => isMbti(mbti)
  ? `<a class="mbti-link" href="/${mbti}/">${mbti}</a>`
  : `<span>${e(mbti)}</span>`;

const artworkLabel = (handle: string, mbti?: string): string => `@${handle}${mbti ? ` × ${mbti}` : ""}`;

/** One caption policy for detail pages, previews, and every artwork grid. */
function artworkCaption(handle: string, mbti: string | undefined, options: {
  context: "detail" | "gallery" | "variation";
  status?: "Minted" | "Confirming" | "Preview";
  mintStateLabel?: boolean;
}): string {
  const { context, status } = options;
  const name = context === "detail" ? `<h1>${handleLink(handle)}</h1>`
    : `<span class="artwork-handle">${handleLink(handle)}</span>`;
  const personality = mbti ? `<span class="artwork-personality"><span class="artwork-personality-separator" aria-hidden="true">×</span>${mbtiLink(mbti)}</span>` : "";
  const captionClass = context === "gallery" ? " gallery-card-copy" : context === "variation" ? " open-preview-caption" : "";
  const statusClass = status === "Confirming" ? " artwork-confirming" : context === "variation" && status === "Minted" ? " open-preview-minted-badge" : "";
  const statusTag = status === "Minted" ? "a" : "span";
  const statusLink = status === "Minted" ? ' href="/"' : "";
  return `<div class="artwork-caption${captionClass}"><div class="artwork-identity">${name}${personality}</div>${status ? `<${statusTag} class="signature-tag artwork-status${statusClass}"${statusLink}${options.mintStateLabel ? " data-mint-state-label" : ""}>${status}</${statusTag}>` : ""}</div>`;
}

/** Extends the existing paper, type, navigation and hairline controls without replacing them. */
export const OPEN_MINT_CSS = `
${SLOGAN_MBTI_HERO_CSS}
.open-mint .home-grid .slogan-lockup{max-width:56rem}
.open-mint .home-grid .intro-panel{padding-block-start:7rem;padding-block-end:clamp(2.5rem,4vw,4rem)}
.open-mint .home-grid .home-guidance{font-size:min(16px,3.1cqi);line-height:1.5;text-align:center;white-space:nowrap;margin:0 0 .75rem}
.open-mint .home-grid .home-guidance>span{display:inline-block;max-width:100%;font:inherit}
/* One centered decision stack; expanded preview instructions retain their reading alignment. */
.open-mint .home-grid .open-intro{display:grid;justify-items:center;gap:.5rem;text-align:center;container-type:inline-size}
.open-mint .home-grid .open-intro>.auth-actions{margin:0;justify-content:center}
.open-mint .home-grid .home-mint-cta,.open-mint .home-grid .home-mint-cta>span{font-size:16px}
.open-mint .home-grid .open-handoff{width:100%;margin:0;text-align:start}
.open-mint .home-grid .open-handoff>summary{margin-inline:auto}
.open-mint .home-grid .open-handoff>summary:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
.open-mint .home-grid .open-handoff-content{margin-top:1rem;padding-top:1rem;border-top:1px solid var(--line)}
.open-mint .home-grid .open-handoff-content>p:first-child{margin-top:0}
/* Let home artwork reach the page edges without widening the intro or other galleries. */
.open-mint .home-grid .public-gallery-grid{margin-inline:calc(-1 * var(--page-gutter,32px))}
/* Center home navigation on the gallery edges; keep the 44px targets on-screen on narrow viewports. */
.open-mint .provenance-caveats{margin-block:1rem;line-height:1.6}
.open-mint .mint-entry-action [data-request-submit]>span:first-child{transform:translateY(1px)}
.open-mint .provenance-caveats p{margin:0;color:inherit;font-size:inherit;line-height:inherit}
.open-mint .provenance-caveats p+p{margin-top:.25rem}
.open-mint .provenance-mbti-meaning{display:block;margin-top:.35rem;color:var(--muted);line-height:1.6}
.open-mint .provenance-mbti-meaning>span{display:inline-block}
.open-mint .provenance-sources h3{font-size:inherit;margin:1rem 0 .5rem;font-weight:500}
.open-mint .provenance-sources ul{padding-inline-start:1.25rem;line-height:1.6;overflow-wrap:anywhere}
.open-mint .provenance-sources li+li{margin-top:.35rem}
.open-mint [data-mint-transaction],.open-mint [data-mint-network]{overflow-wrap:anywhere}
.open-mint [data-wallet-choice]{width:min(28rem,calc(100vw - 2rem));max-height:calc(100dvh - 2rem);box-sizing:border-box;padding:1rem;border:1px solid var(--line);border-radius:2px;background:var(--paper);color:var(--ink)}
.open-mint [data-wallet-choice]::backdrop{background:#0008}
.open-mint [data-wallet-choice] button{display:block;width:100%;min-height:44px;margin:.5rem 0 0;padding:.6rem .75rem;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;text-align:start;white-space:normal;overflow-wrap:anywhere}
.open-mint [data-wallet-choice] button:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.open-mint [data-wallet-choice] p{margin:0 0 .75rem;font-size:1rem}
.open-mint:has(.home-grid){--home-nav-inset:clamp(-22px,calc((1024px - 100vw)/2 + 20px),12px)}
.open-mint:has(.home-grid) .home-return{inset-inline-start:max(var(--home-nav-inset),calc(env(safe-area-inset-left) - 22px))}
.open-mint:has(.home-grid) .collection-shortcut{inset-inline-end:max(var(--home-nav-inset),calc(env(safe-area-inset-right) - 22px))}
.open-mint .open-preview-note a{color:var(--ink);text-underline-offset:.2em}.open-mint .open-preview-note a:focus-visible{outline:2px solid var(--blue);outline-offset:3px}.open-mint .open-preview-variations{padding:5rem var(--page-gutter) 3rem}.open-mint .open-preview-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1.5rem 1rem;list-style:none;margin:2rem 0;padding:0}.open-mint .open-preview-grid>li{min-width:0}.open-mint .open-preview-card{display:block;text-decoration:none}.open-mint .open-preview-card img{display:block;width:100%;height:auto;aspect-ratio:1;background:var(--art-paper)}.open-mint .open-preview-grid>li>.signature-tag{margin-top:.6rem}.open-mint .open-preview-card:focus-visible{outline:2px solid var(--blue);outline-offset:4px}@media(max-width:600px){.open-mint .open-preview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.open-mint .open-preview-minted>.open-preview-card{outline:1px solid var(--ink);outline-offset:4px}.open-mint .open-preview-minted>.open-preview-card:focus-visible{outline:2px solid var(--blue)}
.open-mint .open-preview-intro{color:var(--ink);line-height:1.6}.open-mint .open-preview-notice{max-width:48rem;margin-block:1rem;padding:.65rem .85rem;border-inline-start:2px solid var(--line);background:var(--paper-2);color:var(--ink);line-height:1.6}.open-mint .open-preview-notice-label{display:block;font-weight:600}.open-mint :is(.open-preview-warning,.provenance-caveats){--preview-warning:#806014;border-inline-start:1px solid var(--preview-warning);background:transparent;padding:.15rem 0 .15rem .65rem;color:var(--ink);font-size:.9em}.open-mint :is(.open-preview-warning,.provenance-caveats) .open-preview-notice-label{display:inline;font-weight:500;color:var(--preview-warning)}.open-mint :is(.open-preview-warning,.provenance-caveats) .open-preview-notice-label::after{content:":"}@media(prefers-color-scheme:dark){.open-mint :is(.open-preview-warning,.provenance-caveats){--preview-warning:#c6a65a}}
.open-mint :is(.gallery-handle,.mbti-link){text-decoration:none;text-underline-offset:.18em}.open-mint :is(.gallery-handle,.mbti-link):hover,.open-mint :is(.gallery-handle,.mbti-link):focus-visible{text-decoration:underline}.open-mint :is(.gallery-handle,.mbti-link):focus-visible{outline:2px solid var(--blue);outline-offset:3px}
.open-mint .artwork-caption{display:flex;align-items:baseline;flex-wrap:wrap;gap:.35rem .75rem;width:100%;min-width:0;line-height:1.5}.open-mint .artwork-identity{display:flex;align-items:baseline;flex-wrap:wrap;gap:.2em .35em;min-width:0;max-width:100%}.open-mint .artwork-identity h1,.open-mint .artwork-handle{margin:0;min-width:0;max-width:100%;line-height:inherit;overflow-wrap:anywhere}.open-mint .artwork-personality{display:inline-flex;align-items:baseline;gap:.35em;white-space:nowrap}.open-mint .artwork-personality-separator{color:var(--muted)}.open-mint .artwork-status{flex:none;margin-inline-start:auto;color:var(--ink)}.open-mint .open-preview-caption{padding-top:.6rem}
.open-mint a.signature-tag{text-decoration:none}.open-mint a.signature-tag:hover,.open-mint a.signature-tag:focus-visible{background:var(--ink);color:var(--paper);text-decoration:none}.open-mint a.signature-tag:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
.open-mint .artwork-confirming{color:#806014}.open-mint [data-reveal-feedback]{margin-block:1rem;line-height:1.6;font-size:.9em;color:var(--muted)}@media(prefers-color-scheme:dark){.open-mint .artwork-confirming{color:#c6a65a}}
.open-mint [hidden]{display:none!important}.open-mint .open-handle-form{display:flex;align-items:center;flex-wrap:wrap;gap:0 .65rem;max-width:28rem}.open-mint .open-handle-input{width:14rem;max-width:100%;min-width:0;margin:0;padding:7px 9px;border:1px solid var(--line);border-radius:2px;background:transparent;color:var(--ink);line-height:1.4}.open-mint .open-handle-input:focus-visible{outline:2px solid var(--ink);outline-offset:3px}.open-mint .open-intro{width:100%;max-width:42rem;margin-inline:auto}.open-mint .open-intro p{line-height:1.6}.open-mint .open-handoff{margin-top:.25rem}.open-mint .open-handoff>summary{color:var(--muted)}.open-mint .open-handoff textarea{min-height:10rem}.open-mint .open-art-waiting{display:grid;place-items:center;aspect-ratio:1;background:var(--art-paper);color:#625f59;text-align:center;padding:2rem}.open-mint .open-art-waiting p{max-width:22rem;line-height:1.6}.open-mint .open-mint-panel{scroll-margin-top:5rem;margin-top:.5rem;padding-top:.5rem;border-top:1px solid var(--line)}.open-mint .open-mint-panel .consent-line{margin:.8rem 0}.open-mint .open-mint-panel .signature-facts{margin:.5rem 0}.open-mint .open-feedback{margin:.25rem 0;min-height:0;color:var(--muted);line-height:1.5}.open-mint .open-feedback:empty{margin:0}.open-mint .open-wallet-address{overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.open-mint .open-mint-entry{margin-top:.3rem}.open-mint .open-mint-entry .auth-action{margin-inline-start:auto}.open-mint .open-mint-entry .signature-tag{margin-inline-end:auto}.open-mint .open-collection-wallet{display:flex;flex-wrap:wrap;align-items:center;gap:0 .75rem}.open-mint .open-dev-tools{display:flex;flex-wrap:wrap;gap:.5rem 1rem}.open-mint .open-poll-note{color:var(--muted)}
.open-mint .open-mint-form{display:grid;align-items:start;gap:1rem;max-width:35rem}.open-mint .open-mint-form>label{display:grid;gap:.45rem}.open-mint .open-mint-form .auth-actions{margin:0}.open-mint .open-mint-form p{margin:0;line-height:1.6}.open-mint .open-mint-explanation{max-width:35rem;line-height:1.6}.open-mint .open-mint-explanation strong{font-weight:700}.open-mint .open-mint-cost{color:var(--muted)}.open-mint .open-mint-progress{max-width:35rem}.open-mint .open-mint-progress>p{line-height:1.6}.open-mint .open-mint-progress form{margin-block:1rem}.open-mint .open-gallery-empty{margin-block:2rem;color:var(--muted)}.open-mint .open-preview-note{color:var(--muted);line-height:1.6}.open-mint .open-preview-bridge{margin-block:1rem}.open-mint .open-mint-form .open-wallet-address{margin-bottom:.4rem}
.open-mint .mint-entry-sheet{max-width:35rem}.open-mint .mint-entry-sheet>h1{font-size:24px;margin-bottom:2rem}.open-mint .mint-entry-sheet .open-mint-form{gap:0}.open-mint .mint-entry-part{padding-block:1.5rem;border-top:1px dashed var(--line)}.open-mint .mint-entry-handle{padding-top:0;border:0}.open-mint .mint-entry-handle label{display:grid;gap:.75rem}.open-mint .mint-entry-handle input{width:100%;box-sizing:border-box}.open-mint .mint-entry-wallet h2{margin:0 0 .75rem;font-size:14px;color:var(--muted)}.open-mint .mint-entry-wallet [data-wallet-controls]{display:grid;gap:.65rem}.open-mint .mint-entry-wallet .open-wallet-address{overflow-wrap:anywhere;margin:0}.open-mint .mint-entry-action{display:grid;gap:1rem}.open-mint .mint-entry-action .auth-actions{margin-top:.5rem}.open-mint .mint-entry-action [data-request-submit]{min-height:44px;background:var(--ink);color:var(--paper);padding:.5rem 1rem}.open-mint .mint-entry-action [data-request-submit]:disabled{opacity:.45}.open-mint .mint-entry-part .open-feedback:empty{display:none}.open-mint .mint-entry-wallet .open-feedback{font-size:14px}.open-mint .mint-entry-action .open-mint-cost{font-size:14px}.open-mint .mint-entry-action [data-request-submit]>span:first-child{color:inherit;border:0;padding:0;background:transparent}
.open-mint .open-mint-progress>h1{font-size:24px;margin-bottom:1.5rem}.open-mint .mint-progress-status{margin:2rem 0 1rem;padding-top:1.5rem;border-top:1px dashed var(--line)}.open-mint .mint-progress-status p{font-size:18px;line-height:1.5}.open-mint [data-assessment-code]:not([data-progress-recovery="true"]) [data-wallet-controls]>:not([data-mint-feedback]),.open-mint [data-assessment-code]:not([data-progress-recovery="true"]) [data-mint-form]{display:none}.open-mint .open-mint-progress .open-feedback:empty{display:none}.open-mint .open-mint-progress [data-wallet-controls]{margin-top:1.5rem}.open-mint .open-mint-progress [data-mint-feedback]{color:var(--muted);font-size:14px;line-height:1.6}.open-mint .open-mint-progress [data-wallet-label]{overflow-wrap:anywhere}
`;

function layout(title: string, body: string, options: OpenMintPageOptions, description = "An X handle, an artist-defined system, and Grok’s reading become a signature."): string {
  const sloganScript = body.includes('id="slogan-tooltip"') ? `<script src="${SLOGAN_TOOLTIP_SCRIPT_URL}" defer></script><script src="${SLOGAN_MBTI_HERO_SCRIPT_URL}" defer></script>` : "";
  const dev = options.development;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${e(title === "Signatures Gallery" ? title : `${title} · Signatures Gallery`)}</title><meta name="description" content="${e(description)}">${FAVICON_LINK}${SITE_FONT_PRELOAD}<link rel="stylesheet" href="${e(safeUrl(options.stylesheetUrl, SITE_CSS_URL))}"><script src="${e(safeUrl(options.clientScriptUrl, "/assets/open-mint.js"))}" defer></script>${sloganScript}</head><body class="book-page open-mint" data-open-mint${options.durableWalletSubmission ? ' data-durable-wallet-submission="true"' : ""} data-wallet-verified="${options.walletVerified ? "true" : "false"}" data-chain-id="${e(options.chainId)}" data-contract="${e(options.contract)}"${dev?.fixture ? ' data-fixture="true"' : ""}${dev?.localChain ? ' data-local-chain="true"' : ""}><main>${HOME_LINK}<a class="collection-shortcut" href="/me" aria-label="My Collection" title="My Collection"><span class="collection-shortcut-dot" aria-hidden="true"></span></a>${body}</main>${siteFooter()}</body></html>`;
}

function walletControls(options: OpenMintPageOptions, proved = options.walletVerified): string {
  return `<div data-wallet-controls><p class="open-wallet-address" data-wallet-label>${options.wallet ? e(options.wallet) : "Connect the wallet that will receive the token."}</p><p class="open-mint-cost">Network: <span data-review-chain>${e(options.chainName ?? "Configured mint network")}</span></p><div class="auth-actions">${action(!options.wallet ? "Connect wallet" : proved ? "Change wallet" : "Verify wallet", "data-connect-wallet")}</div><p class="open-feedback" data-mint-feedback role="status" aria-live="polite"></p></div>`;
}

export function handoffPrompt(publicOrigin?: string): string {
  const origin = safeUrl(publicOrigin, "https://signatures.gallery").replace(/\/$/, "");
  return `First, ask me which X handle I want to explore. Accept a handle containing 1–15 letters, numbers, or underscores; remove a leading @. After I provide a valid handle, resolve its exact current X username spelling and capitalization from public X information before constructing the preview URL. Check that the resolved username matches my input after removing @ and ignoring letter case; do not substitute another account. Use the resolved capitalization in the link. For example, if I enter @alice_bob_key and X shows Alice_Bob_Key, use Alice_Bob_Key. If you cannot verify the current username spelling, say so and do not invent a resolved link. Then use the public X information available to you to assess an MBTI for that handle in this chat. Treat the MBTI as an artistic interpretation, not a psychological diagnosis. If you cannot find enough information, say so instead of inventing an assessment. Choose one of these uppercase types: ${MBTI_TYPES.join(", ")}. Then return: Check the signature of @<handle>: ${origin}/p/<handle>/<MBTI>. For example: ${origin}/p/Alice_Bob_Key/ENFP. Use the letters, not a number. Resolving the username here is a convenience, not proof for minting. This is an editable preview, not a mint authorization. The preview site renders the spelling in the URL without looking up X. Do not call the site to request an assessment or ask for a wallet; minting is a separate action on the site.`;
}

function handoff(options: OpenMintPageOptions): string {
  return `<details class="auth-disclosure open-handoff"><summary>Preview with Grok</summary><div class="open-handoff-content"><p>Give this prompt to Grok on X or Grok.com. It asks for a handle, interprets its MBTI, and returns a preview link.</p><p>Previews are for exploration. Minting uses a fresh Grok assessment.</p><textarea class="grok-prompt" readonly data-handoff-prompt aria-label="Prompt for Grok">${e(handoffPrompt(options.publicOrigin))}</textarea><div class="auth-actions">${action("Copy prompt", "data-copy-handoff")}<a class="auth-action" href="https://grok.com" target="_blank" rel="noopener noreferrer"><span>Open Grok ↗</span></a></div><p class="open-feedback" data-copy-feedback role="status" aria-live="polite"></p></div></details>`;
}

function galleryCards(entries: GalleryEntry[]): string {
  return `<div class="public-gallery-grid">${entries.map(entry => {
    const handle = renderedPageHandle(entry.handle, entry.renderHandle);
    return `<article class="gallery-item"><a class="gallery-card" href="${e(safeUrl(entry.url, signaturePath(handle)))}"><img src="${e(safeUrl(entry.imageUrl))}" alt="Signature for ${e(artworkLabel(handle, entry.mbti))}" loading="lazy"></a>${artworkCaption(handle, entry.mbti, { context: "gallery", status: entry.mint?.state === "minted" ? "Minted" : undefined })}</article>`;
  }).join("")}</div>`;
}

export function homePage(options: OpenMintPageOptions = {}, entries: GalleryEntry[] = []): string {
  const minted = entries.filter(entry => entry.mint?.state === "minted");
  const sloganText = e(SLOGAN_MBTI_HERO_MANIFEST.displayText);
  const slogan = `<div class="slogan-lockup slogan-loop"><h1 id="slogan-heading" class="visually-hidden">${sloganText}</h1><figure class="slogan-signature" title="${sloganText}" tabindex="0" role="img" aria-labelledby="slogan-heading" data-slogan-signature-version="${e(SLOGAN_MBTI_HERO_MANIFEST.version)}" data-source-renderer="${e(SLOGAN_MBTI_HERO_MANIFEST.sourceRendererVersion)}"><span class="slogan-signature-layout">${SLOGAN_MBTI_HERO_SVG}</span></figure><span id="slogan-tooltip" class="slogan-tooltip" role="tooltip" aria-hidden="true" hidden>${sloganText}</span></div>`;
  const body = `<section class="home-grid"><div class="intro-panel">${slogan}</div><div class="gallery-shell"><section class="open-intro" aria-label="Mint a signature"><p class="home-guidance"><span>Choose any X handle.</span>&nbsp; <span>Grok interprets it.</span>&nbsp; <span>Mint to reveal the signature.</span></p><div class="auth-actions"><a class="auth-action home-mint-cta" href="/mint"><span>Mint a signature</span></a></div>${handoff(options)}</section>${minted.length ? galleryCards(minted) : '<p class="open-gallery-empty">No signatures minted yet.</p>'}</div></section>`;
  return layout("Signatures Gallery", body, options);
}

export function mbtiGalleryPage(mbti: MBTI, entries: GalleryEntry[], options: OpenMintPageOptions = {}): string {
  if (!isMbti(mbti)) throw new Error("Choose one of the 16 MBTI types, such as ENFP.");
  const minted = entries.filter(entry => entry.mint?.state === "minted" && entry.mbti === mbti);
  const title = `Signatures × ${mbti}`;
  const body = `<section class="collection-page" data-mbti-gallery="${mbti}"><div class="collection-intro"><h1>${title}</h1></div>${minted.length ? galleryCards(minted) : `<p class="open-gallery-empty">No signatures minted with ${mbti} yet.</p>`}</section>`;
  return layout(title, body, options);
}

export function requestPage(handle: string, options: OpenMintPageOptions = {}): string {
  return mintPage(handle, options);
}

export function mintPage(handle = "", options: OpenMintPageOptions = {}): string {
  const spelling = handle ? preservedHandle(handle.trim()) : "";
  return layout("Mint & reveal", `<section class="auth-page" data-mint-entry data-wallet-verified="${options.walletVerified ? "true" : "false"}"><div class="auth-sheet mint-entry-sheet"><h1>Mint &amp; reveal</h1><form class="open-mint-form" data-assessment-request><section class="mint-entry-part mint-entry-handle" aria-label="Choose a handle"><label for="open-handle">X handle<input class="open-handle-input" id="open-handle" name="handle" value="${e(spelling)}" placeholder="@handle" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="16" pattern="@?[A-Za-z0-9_]{1,15}" required aria-describedby="mint-explanation request-feedback"></label></section><section class="mint-entry-part mint-entry-wallet" aria-labelledby="recipient-heading"><h2 id="recipient-heading">Receiving wallet</h2>${walletControls(options)}</section><section class="mint-entry-part mint-entry-action" aria-label="Mint and reveal"><p id="mint-explanation" class="open-mint-explanation">Grok chooses the final signature. It may differ from <a data-mint-preview${spelling ? ` href="${e(handleVariationsPath(spelling))}"` : ""}>your preview</a>. <strong>Reveal after minting.</strong></p><p class="open-mint-cost">No mint fee. You pay network gas. Minting creates a permanent public token.</p><div class="auth-actions"><button class="auth-action" type="submit" data-request-submit${options.walletVerified ? "" : " disabled"}><span>Mint &amp; reveal</span></button></div><p class="open-feedback" id="request-feedback" data-request-feedback role="status" aria-live="polite"></p></section></form></div></section>`, options);
}

function previewContext(handle: string, options: OpenMintPageOptions, state: PublicPreviewState) {
  if (state.state === "fixture" && !options.development?.fixture) throw new Error("Gallery samples require fixture mode.");
  const record = state.state === "confirming" || state.state === "minted" || state.state === "fixture" ? state : undefined;
  if (record && !isMbti(record.mbti)) throw new Error("Choose one of the 16 MBTI types, such as ENFP.");
  const spelling = record ? renderedPageHandle(handle, record.renderHandle) : preservedHandle(handle);
  const rendererVersion = record?.previewRendererVersion ?? record?.rendererVersion ?? RENDERER_VERSION;
  const badge: "Confirming" | "Minted" = state.state === "confirming" ? "Confirming" : "Minted";
  const rendererNotice = record?.onchain ? `<p class="open-preview-note" data-preview-renderer-notice>The minted signature is generated by its on-chain renderer. Alternatives are previews from the locked ${e(rendererVersion)} renderer, not additional tokens.</p>` : record && rendererVersion !== RENDERER_VERSION ? `<p class="open-preview-notice" data-preview-renderer-notice><strong class="open-preview-notice-label">Renderer</strong> This signature uses an earlier renderer (${e(rendererVersion)}). Alternatives use that same renderer for comparison. The minted artwork remains the saved original.</p>` : "";
  const statusNotice = state.state === "pending" ? '<p class="open-preview-notice" data-preview-status role="status"><strong class="open-preview-notice-label">Pending</strong> Mint submitted. Waiting for confirmation. These variations remain previews; the final signature will be revealed after confirmation.</p>'
    : state.state === "unavailable" ? '<p class="open-preview-notice open-preview-warning" data-preview-status role="status"><strong class="open-preview-notice-label">Warning</strong> Mint status cannot be verified right now. You can still explore these previews.</p>'
    : state.state === "confirming" ? '<p class="open-preview-note" data-preview-status role="status">The signature is revealed. Its mint is still confirming and is not yet in the gallery.</p>' : "";
  const bridge = record ? `<div class="auth-actions open-preview-bridge"><a class="auth-action" href="${e(safeUrl(record.url))}"><span>View ${badge.toLowerCase()} signature</span></a></div>`
    : state.state === "unminted" ? `<div class="auth-actions open-preview-bridge"><a class="auth-action" href="${e(mintPath(spelling))}"><span>Mint for this handle →</span></a></div>` : "";
  return { record, spelling, rendererVersion, badge, notices: `${statusNotice}${rendererNotice}`, bridge };
}

export function previewPage(handle: string, mbti: MBTI, options: OpenMintPageOptions = {}, state: PublicPreviewState = { state: "unminted" }): string {
  if (!isMbti(mbti)) throw new Error("Choose one of the 16 MBTI types, such as ENFP.");
  const { record, spelling, rendererVersion, badge, notices, bridge } = previewContext(handle, options, state);
  const selected = record?.mbti === mbti;
  const image = selected ? safeUrl(record.imageUrl) : `/preview/${spelling}/${mbti}.svg?renderer=${encodeURIComponent(rendererVersion)}`;
  const label = selected ? badge : "Preview";
  const description = selected ? (record?.onchain ? "The signature, generated from its immutable on-chain inputs." : state.state === "confirming" ? "The saved signature, revealed while its mint confirms." : "The minted signature, shown from its saved artwork.")
    : record ? "An alternative interpretation, for exploration only." : "A playful preview. Change the MBTI in the URL to explore.";
  return layout(`${artworkLabel(spelling, mbti)} ${selected ? label.toLowerCase() : "preview"}`, `<article class="signature-page" data-preview-page data-preview-mint-state="${state.state}"><div class="signature-sheet"><figure class="signature-art"><img src="${e(image)}" alt="${selected ? `${badge} signature` : "Signature preview"} for ${e(artworkLabel(spelling, mbti))}"></figure><div class="signature-record">${artworkCaption(spelling, mbti, { context: "detail", status: selected ? badge : "Preview" })}<p class="open-preview-note">${description} <a href="${e(handleVariationsPath(spelling))}">View all 16 variations</a>.</p>${notices}${bridge}</div></div></article>`, options, selected ? "The saved signature for this handle." : "An editable signature preview. Minting uses an independent Grok assessment.");
}

// Presentation only: pair field polarities without changing the renderer's MBTI order.
const PREVIEW_MBTI_ORDER: readonly MBTI[] = [
  "ISTJ", "ESTJ", "ISFJ", "ESFJ",
  "INFJ", "ENFJ", "INTJ", "ENTJ",
  "ISTP", "ESTP", "ISFP", "ESFP",
  "INFP", "ENFP", "INTP", "ENTP",
];

export function previewVariationsPage(handle: string, options: OpenMintPageOptions = {}, state: PublicPreviewState = { state: "unminted" }): string {
  const { record, spelling, rendererVersion, badge, notices, bridge } = previewContext(handle, options, state);
  const cards = PREVIEW_MBTI_ORDER.map(mbti => {
    const selected = record?.mbti === mbti;
    const image = selected ? safeUrl(record.imageUrl) : `/preview/${spelling}/${mbti}.svg?renderer=${encodeURIComponent(rendererVersion)}`;
    const href = selected ? safeUrl(record.url) : `/p/${spelling}/${mbti}`;
    return `<li${selected ? ` class="open-preview-minted" data-preview-minted="${mbti}"` : ""}><a class="open-preview-card" href="${e(href)}" aria-label="${selected ? `View ${badge.toLowerCase()} ${mbti} signature` : `Explore ${mbti}`} for @${e(spelling)}"><img src="${e(image)}" alt="${selected ? `${badge} signature` : "Signature preview"} for ${e(artworkLabel(spelling, mbti))}" width="400" height="400"></a>${artworkCaption(spelling, mbti, { context: "variation", status: selected ? badge : "Preview" })}</li>`;
  }).join("");
  const mintedNote = record ? `<p class="open-preview-note" data-preview-minted-note>${state.state === "confirming" ? "One signature confirming." : "One minted signature."} Fifteen alternative interpretations, for exploration only.</p>` : "";
  return layout(`@${spelling} · 16 variations`, `<section class="open-preview-variations" data-preview-variations data-preview-mint-state="${state.state}"><header class="signature-heading"><h1>16 variations</h1>${handleLink(spelling)}</header><p class="open-preview-intro" data-preview-intro>One handle, all 16 MBTI interpretations. Choose a variation to explore.</p>${mintedNote}${notices}<ul class="open-preview-grid" aria-label="MBTI preview variations">${cards}</ul>${bridge}</section>`, options, "Explore all 16 MBTI signature interpretations for one handle.");
}

function mintControls(model: AssessmentPageModel, options: OpenMintPageOptions): string {
  const mint = model.mint?.state ?? "unminted";
  const explorerUrl = safeUrl(model.mint?.explorerUrl, "");
  if (mint === "confirming") return "";
  if (mint === "minted") return explorerUrl ? `<div class="auth-actions open-mint-entry"><a class="auth-action" href="${e(explorerUrl)}" target="_blank" rel="noopener noreferrer"><span>View token ↗</span></a></div>` : "";
  if (mint === "pending") return `<p class="open-feedback" data-mint-feedback role="status" aria-live="polite">${model.mint?.submissionUncertain ? "A wallet submission was started, but its outcome is unknown. Check wallet activity; do not send another mint." : "Waiting for the transaction to be confirmed."}</p>`;
  const view = mintUiState({ assessmentStatus: model.status, mintState: mint, requestExpired: model.requestExpired, canMint: model.canMint, walletVerified: model.walletProvedForCode });
  if (view.showReturn) return "";
  if (view.phase === "failed" || view.phase === "abstained") return `<p class="open-feedback" data-mint-feedback role="status" aria-live="polite">${e(assessmentFailureText(model))}</p>`;
  return `${walletControls(options, model.walletProvedForCode)}<form data-mint-form${model.status === "pending" ? " hidden" : ""}><button class="auth-action" type="submit" data-submit-mint disabled><span>Continue mint</span></button></form>`;
}

export function assessmentPage(model: AssessmentPageModel, options: OpenMintPageOptions = {}): string {
  if (model.galleryFixture && !options.development?.fixture) throw new Error("Gallery samples require fixture mode.");
  const canonical = canonicalPageHandle(model.handle);
  const handle = renderedPageHandle(model.handle, model.renderHandle);
  const attributes = `data-assessment-code="${e(model.code)}" data-assessment-handle="${e(canonical)}" data-assessment-state="${e(model.status)}" data-can-mint="${model.canMint ? "true" : "false"}" data-wallet-proved="${model.walletProvedForCode ? "true" : "false"}" data-mint-state="${e(model.mint?.state ?? "unminted")}" data-token-id="${e(model.tokenId ?? model.mint?.tokenId)}" data-mint-transaction-hash="${e(/^0x[a-f0-9]{64}$/i.test(model.mint?.transactionHash ?? "") ? model.mint?.transactionHash : "")}" data-request-expired="${model.requestExpired ? "true" : "false"}" data-request-expires-at="${e(model.requestExpiresAt)}" data-wallet-proof-expires-at="${e(model.walletProofExpiresAt)}" data-server-now="${e(model.serverNow)}"`;
  if (!canRevealMint(model.mint?.state)) {
    const view = mintUiState({ assessmentStatus: model.status, mintState: model.mint?.state ?? "unminted", requestExpired: model.requestExpired, canMint: model.canMint, walletVerified: model.walletProvedForCode, booting: model.canMint });
    if (model.mint?.submissionUncertain) view.status = "Checking your wallet submission. Check wallet activity before any retry.";
    const supportUrl = openMintSupportUrl(options.supportUrl);
    const support = supportUrl ? `<div class="auth-actions" data-assessment-support${view.phase === "failed" || view.phase === "abstained" ? "" : " hidden"}><a class="auth-action" href="${e(supportUrl)}" rel="noopener noreferrer" referrerpolicy="no-referrer"><span>Request help</span></a></div>` : "";
    const recovery = `<div data-request-recovery${view.showReturn ? "" : " hidden"}><p class="auth-note" data-request-recovery-message>Return to mint to continue. Any saved assessment and artwork will be reused.</p><div class="auth-actions"><a class="auth-action" href="${e(mintPath(handle))}"><span>Return to mint</span></a></div></div>`;
    return layout(`Mint & reveal · @${handle}`, `<section class="auth-page" ${attributes}><div class="auth-sheet open-mint-progress"><h1>Mint &amp; reveal</h1><p>${handleLink(handle)}</p><div class="mint-progress-status"><p data-assessment-status role="status" aria-live="polite">${view.status}</p></div>${mintControls(model, options)}${support}<p class="open-feedback" data-mint-transaction${/^0x[a-f0-9]{64}$/i.test(model.mint?.transactionHash ?? "") ? "" : " hidden"}>${/^0x[a-f0-9]{64}$/i.test(model.mint?.transactionHash ?? "") ? `Transaction: ${e(model.mint?.transactionHash)}` : ""}</p><p class="open-feedback" data-mint-network hidden></p>${recovery}<p class="open-feedback" data-poll-feedback role="status" aria-live="polite"></p><div class="auth-actions"><button class="auth-action" type="button" data-check-progress hidden><span>Check progress</span></button></div></div></section>`, options);
  }
  const image = safeUrl(model.svgUrl ?? model.imageUrl);
  const art = image !== "#" ? `<img src="${e(image)}" alt="Signature for ${e(artworkLabel(handle, model.mbti))}">` : `<div class="open-art-waiting"><p role="status">The minted artwork is temporarily unavailable.</p></div>`;
  const provenance = `<div class="signature-tools"><details class="signature-provenance"><summary>Provenance</summary><div class="signature-provenance-body">${provenanceBody(model, handle)}</div></details>${model.status === "ready" && model.svgUrl ? `<a class="signature-svg" href="${e(safeUrl(model.svgUrl))}" target="_blank" rel="noopener noreferrer" aria-label="Open original SVG">SVG ↗</a>` : ""}</div>`;
  const confirming = model.mint?.state === "confirming";
  const commitment = model.inputDigest ? ` data-reveal-input="${e(model.inputDigest)}" data-reveal-renderer="${e(model.rendererIdentity)}"` : ` data-reveal-artifact="${e(model.artifactDigest)}"`;
  const monitor = confirming ? ` data-reveal-monitor data-reveal-handle="${e(canonical)}" data-reveal-token="${e(model.tokenId ?? model.mint?.tokenId)}"${commitment}` : "";
  const feedback = confirming ? '<p data-reveal-feedback role="status" aria-live="polite">Your signature is revealed. The mint is included in a block and still confirming. It will appear in the gallery once confirmed.</p>' : "";
  return layout(artworkLabel(handle, model.mbti), `<article class="signature-page" data-mint-state="${confirming ? "confirming" : "minted"}"${monitor}><div class="signature-sheet"><figure class="signature-art" data-reveal-artwork>${art}</figure><div class="signature-record">${artworkCaption(handle, model.mbti, { context: "detail", status: confirming ? "Confirming" : "Minted", mintStateLabel: true })}${feedback}${mintControls(model, options)}<div data-reveal-provenance>${provenance}</div></div></div></article>`, options);
}

export function collectionPage(entries: GalleryEntry[] = [], options: OpenMintPageOptions = {}): string {
  const wallet = options.wallet;
  const minted = entries.filter(entry => entry.mint?.state === "minted");
  const body = `<section class="collection-page" data-collection-page><div class="collection-intro"><h1>My Collection</h1><div class="open-collection-wallet"><p class="open-wallet-address" data-wallet-label>${wallet ? e(wallet) : "Connect your wallet to see the signatures it holds."}</p>${action(wallet ? "Change wallet" : "Connect wallet", "data-connect-wallet")}${wallet ? action("Disconnect", "data-disconnect-wallet") : ""}</div><p class="open-feedback" data-mint-feedback role="status" aria-live="polite"></p></div>${minted.length ? galleryCards(minted) : `<div class="collection-empty signed-out-participation"><p>${wallet ? "This wallet has no minted signatures yet." : "Your collection follows your wallet."}</p><a class="auth-action" href="/mint"><span>Mint a signature</span></a></div>`}</section>`;
  return layout("My Collection", body, options);
}

export function aboutPage(options: OpenMintPageOptions = {}): string {
  const preparation = options.generativeArtwork
    ? "The verified spelling and first accepted assessment are preserved at preparation. Minting stores the handle and MBTI as immutable inputs. The on-chain renderer generates the SVG and metadata when they are read; the finished image is not uploaded to IPFS or stored in the mint transaction. The spelling is not checked again at transaction confirmation. Cancelling or expiring a request does not trigger another assessment. An unresolved transaction or reservation requires operator review before another attempt."
    : "The verified spelling, first accepted assessment, and artwork are saved as a snapshot at preparation. The spelling is not checked again at transaction confirmation. The first accepted assessment is kept for that handle; cancelling a transaction does not create another result. Later mint attempts reuse the saved assessment and artwork, including after a mint request expires. Expiry does not trigger another assessment.";
  const reveal = options.generativeArtwork ? "The inputs are prepared before the wallet transaction. The signature is generated from the contract and revealed after verified inclusion" : "The artwork is prepared before the wallet transaction and revealed after verified inclusion";
  return layout("About the work", `<article class="about-page"><div class="about-sheet"><h1>About the work</h1><p>Signatures Gallery turns an X handle into a handwriting-like mark. A public identifier becomes a drawn signature.</p>
<section><h2>Explore</h2><p>Ask Grok on X or Grok.com to resolve a handle’s current username spelling, interpret its MBTI, and share a preview link. A preview combines the handle and the MBTI in its URL. You can change either to play with the result. Preview pages keep the capitalization in the URL without looking up X. Preview pages do not call our assessment service or authorize a mint.</p><p>The MBTI is an artistic input, not a diagnosis or a fact about the person behind an account.</p></section>
<section><h2>Mint &amp; reveal</h2><p>Anyone can mint for any handle. Connect a wallet, enter a handle, and choose Mint &amp; reveal. During preparation, our backend independently verifies the current X username spelling and asks Grok to research public X posts and choose the MBTI. It does not accept the preview’s MBTI. The final signature may differ from your preview.</p><p>${preparation}</p><p>${reveal}, with a Confirming label while confirmation completes. It enters the gallery only once confirmed. This is a reveal experience, not cryptographic secrecy.</p><p>No mint fee. You pay network gas. A token is identified by the canonical handle, regardless of letter case: one minted token per handle. Identity follows the handle, not the X account ID. A renamed handle is a different identity; changing capitalization alone does not create another token. A token can move between wallets; holding one does not prove control of the X account. Minting leaves a permanent public record.</p></section>
<section><h2>Agent Art</h2><p>Project 01 by <a href="https://x.com/AgentArt_AA" target="_blank" rel="noopener noreferrer">Agent Art ↗</a>.</p></section></div></article>`, options);
}

export function errorPage(message: string, options: OpenMintPageOptions = {}): string {
  return layout("Unable to open this page", `<section class="auth-page"><div class="auth-sheet"><h1>Unable to open this page</h1><p role="alert">${e(message)}</p><a class="auth-action" href="/"><span>Back to gallery</span></a></div></section>`, options);
}
