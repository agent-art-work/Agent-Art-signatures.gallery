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
  pulseMint?: boolean;
  assessmentSource?: "grok" | "sample";
  pulseSaleNotice?: string;
  /** Relay presentation only; a fresh wallet quote still authorizes the active phase. */
  pulseSaleStatus?: {
    phase: "free" | "paid" | "unknown";
    paused: boolean;
    freeMinted?: number;
    freeMintQuota?: number;
    freeConfigRevision?: string;
  };
  /** Active mint request/result context, never a permanent signature view. */
  mintProcess?: boolean;
  /** Actionable mint-process notice; passive viewing never renders this. */
  mintObservationNotice?: string;
  /** The upstream relay owns freshness/error wording; do not infer an outage from cached records. */
  mintObservationManaged?: boolean;
  /** No verified gallery projection yet: loading is not an empty gallery. */
  galleryPending?: boolean;
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
  /** Public consent metadata only; never the unrevealed artistic result. */
  pulseMaxPriceWei?: string;
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
  /** A read outage does not invalidate a previously verified finalized mint. */
  mintObservationUnavailable?: boolean;
  /** Positive evidence was contradicted, not merely inaccessible. */
  mintEvidenceInvalidated?: boolean;
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
  /** Presentation only; never authorizes a mint, ownership or sharing action. */
  mintObservationUnavailable?: boolean;
  mintEvidenceInvalidated?: boolean;
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
  status?: "Minted" | "Confirming" | "Preview" | "Status unavailable";
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

/** Page layouts and notices build on the shared site-wide controls. */
export const OPEN_MINT_CSS = `
${SLOGAN_MBTI_HERO_CSS}
.open-mint .home-grid .slogan-lockup{max-width:56rem}
.open-mint .home-grid .intro-panel{padding-block-start:7rem;padding-block-end:clamp(2.5rem,4vw,4rem)}
.open-mint .home-grid .home-guidance{font-size:min(16px,2.4cqi);line-height:1.5;text-align:center;white-space:nowrap;margin:0 0 .75rem}
.open-mint .home-grid .home-guidance>span{display:inline-block;max-width:100%;font:inherit}
/* One centered decision stack; expanded preview instructions retain their reading alignment. */
.open-mint .home-grid .open-intro{display:grid;justify-items:center;gap:.5rem;text-align:center;container-type:inline-size}
.open-mint .home-grid .open-intro>.auth-actions{margin:0;justify-content:center}
.open-mint .home-grid .home-mint-cta,.open-mint .home-grid .home-mint-cta>span{font-size:16px}
.open-mint .home-grid .home-mint-status{font-size:13px;color:var(--muted);text-align:center;margin:.5rem 0 0}
.open-mint .home-grid .open-handoff{width:100%;margin:0;text-align:start}
.open-mint .home-grid .open-handoff>summary{margin-inline:auto}
.open-mint .home-grid .open-handoff>summary:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
.open-mint .home-grid .open-handoff-content{margin-top:1rem;padding-top:1rem;border-top:1px solid var(--line)}
.open-mint .home-grid .open-handoff-content>p:first-child{margin-top:0}
/* Let home artwork reach the page edges without widening the intro or other galleries. */
.open-mint .home-grid .public-gallery-grid{margin-inline:calc(-1 * var(--page-gutter,32px))}
.open-mint .provenance-caveats{margin-block:1rem;line-height:1.6}
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
.open-mint [data-wallet-choice] button{width:100%;margin:.5rem 0 0;white-space:normal;overflow-wrap:anywhere}
.open-mint [data-wallet-choice] p{margin:0 0 .75rem;font-size:1rem}
.open-mint .open-preview-note a{color:var(--ink);text-underline-offset:.2em}.open-mint .open-preview-note a:focus-visible{outline:2px solid var(--blue);outline-offset:3px}.open-mint .open-preview-variations{padding:5rem var(--page-gutter) 3rem}.open-mint .open-preview-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1.5rem 1rem;list-style:none;margin:2rem 0;padding:0}.open-mint .open-preview-grid>li{min-width:0}.open-mint .open-preview-card{display:block;text-decoration:none}.open-mint .open-preview-card img{display:block;width:100%;height:auto;aspect-ratio:1;background:var(--art-paper)}.open-mint .open-preview-grid>li>.signature-tag{margin-top:.6rem}.open-mint .open-preview-card:focus-visible{outline:2px solid var(--blue);outline-offset:4px}@media(max-width:600px){.open-mint .open-preview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.open-mint .open-preview-minted>.open-preview-card{outline:1px solid var(--ink);outline-offset:4px}.open-mint .open-preview-minted>.open-preview-card:focus-visible{outline:2px solid var(--blue)}
.open-mint .open-preview-intro{color:var(--ink);line-height:1.6}.open-mint .open-preview-notice{max-width:48rem;margin-block:1rem;padding:.65rem .85rem;border-inline-start:2px solid var(--line);background:var(--paper-2);color:var(--ink);line-height:1.6}.open-mint .open-preview-notice-label{display:block;font-weight:600}.open-mint :is(.open-preview-warning,.provenance-caveats){--preview-warning:#806014;border-inline-start:1px solid var(--preview-warning);background:transparent;padding:.15rem 0 .15rem .65rem;color:var(--ink);font-size:.9em}.open-mint :is(.open-preview-warning,.provenance-caveats) .open-preview-notice-label{display:inline;font-weight:500;color:var(--preview-warning)}.open-mint :is(.open-preview-warning,.provenance-caveats) .open-preview-notice-label::after{content:":"}@media(prefers-color-scheme:dark){.open-mint :is(.open-preview-warning,.provenance-caveats){--preview-warning:#c6a65a}}
.open-mint :is(.gallery-handle,.mbti-link){text-decoration:none;text-underline-offset:.18em}.open-mint :is(.gallery-handle,.mbti-link):hover,.open-mint :is(.gallery-handle,.mbti-link):focus-visible{text-decoration:underline}.open-mint :is(.gallery-handle,.mbti-link):focus-visible{outline:2px solid var(--blue);outline-offset:3px}
.open-mint .artwork-caption{display:flex;align-items:baseline;flex-wrap:wrap;gap:.35rem .75rem;width:100%;min-width:0;line-height:1.5}.open-mint .artwork-identity{display:flex;align-items:baseline;flex-wrap:wrap;gap:.2em .35em;min-width:0;max-width:100%}.open-mint .artwork-identity h1,.open-mint .artwork-handle{margin:0;min-width:0;max-width:100%;line-height:inherit;overflow-wrap:anywhere}.open-mint .artwork-personality{display:inline-flex;align-items:baseline;gap:.35em;white-space:nowrap}.open-mint .artwork-personality-separator{color:var(--muted)}.open-mint .artwork-status{flex:none;margin-inline-start:auto;color:var(--ink)}.open-mint .open-preview-caption{padding-top:.6rem}
.open-mint a.signature-tag{text-decoration:none}.open-mint a.signature-tag:hover,.open-mint a.signature-tag:focus-visible{background:var(--ink);color:var(--paper);text-decoration:none}.open-mint a.signature-tag:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
.open-mint .artwork-confirming{color:#806014}.open-mint [data-reveal-feedback]{margin-block:1rem;line-height:1.6;font-size:.9em;color:var(--muted)}@media(prefers-color-scheme:dark){.open-mint .artwork-confirming{color:#c6a65a}}
.open-mint [hidden]{display:none!important}.open-mint .open-handle-form{display:flex;align-items:center;flex-wrap:wrap;gap:0 .65rem;max-width:28rem}.open-mint .open-handle-form .open-handle-input{width:14rem}.open-mint .open-intro{width:100%;max-width:42rem;margin-inline:auto}.open-mint .open-intro p{line-height:1.6}.open-mint .open-handoff{margin-top:.25rem}.open-mint .open-handoff>summary{color:var(--muted)}.open-mint .open-handoff textarea{min-height:10rem}.open-mint .open-art-waiting{display:grid;place-items:center;aspect-ratio:1;background:var(--art-paper);color:#625f59;text-align:center;padding:2rem}.open-mint .open-art-waiting p{max-width:22rem;line-height:1.6}.open-mint .open-mint-panel{scroll-margin-top:5rem;margin-top:.5rem;padding-top:.5rem;border-top:1px solid var(--line)}.open-mint .open-mint-panel .consent-line{margin:.8rem 0}.open-mint .open-mint-panel .signature-facts{margin:.5rem 0}.open-mint .open-feedback{margin:.25rem 0;min-height:0;color:var(--muted);line-height:1.5}.open-mint .open-feedback:empty{margin:0}.open-mint .open-wallet-address{overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.open-mint .open-mint-entry{margin-top:.3rem}.open-mint .open-mint-entry .auth-action{margin-inline-start:auto}.open-mint .open-mint-entry .signature-tag{margin-inline-end:auto}.open-mint .open-collection-wallet{display:flex;flex-wrap:wrap;align-items:center;gap:0 .75rem}.open-mint .open-dev-tools{display:flex;flex-wrap:wrap;gap:.5rem 1rem}.open-mint .open-poll-note{color:var(--muted)}
.open-mint .open-mint-form{display:grid;align-items:start;gap:1rem;max-width:35rem}.open-mint .open-mint-form>label{display:grid;gap:.45rem}.open-mint .open-mint-form .auth-actions{margin:0}.open-mint .open-mint-form p{margin:0;line-height:1.6}.open-mint .open-mint-explanation{max-width:35rem;line-height:1.6}.open-mint .open-mint-explanation strong{font-weight:700}.open-mint .open-mint-cost{color:var(--muted)}.open-mint .open-mint-progress{max-width:35rem}.open-mint .open-mint-progress>p{line-height:1.6}.open-mint .open-mint-progress form{margin-block:1rem}.open-mint .open-gallery-empty{margin-block:2rem;color:var(--muted)}.open-mint .open-preview-note{color:var(--muted);line-height:1.6}.open-mint .open-preview-bridge{margin-block:1rem}.open-mint .open-mint-form .open-wallet-address{margin-bottom:.4rem}
/* Use the midpoint of the slogan's 832–874px ink span; shared gutters stay responsive. */
.open-mint .mint-entry-sheet{max-width:853px}.open-mint .mint-entry-sheet .open-mint-form{gap:0;max-width:none}.open-mint .mint-entry-sheet .open-mint-explanation{max-width:none}.open-mint .mint-entry-part{padding-block:1.25rem;border:0}.open-mint .mint-entry-handle{padding-top:0;padding-bottom:1.75rem}.open-mint .mint-entry-handle label{display:grid;gap:.5rem;font-size:14px;color:var(--muted)}
.open-mint .mint-entry-sheet .mint-section-title{display:block;min-width:0;font-size:14px;font-weight:var(--ui-font-weight);line-height:1.6;color:var(--muted)}
.open-mint .mint-entry-handle .open-handle-input{font-size:48px;line-height:1.35;height:90px}
.open-mint .mint-entry-handle .open-handle-input::placeholder{font-size:inherit}
.open-mint .mint-entry-sheet .mint-entry-handle [data-handle-validation]{margin:.65rem 0 0;font-size:14px;max-width:none}
.open-mint .mint-entry-wallet .open-wallet-address:empty{display:none}
.open-mint .mint-entry-wallet{padding-top:0}.open-mint .mint-entry-wallet h2{margin:0 0 .5rem;color:var(--muted)}.open-mint .mint-entry-wallet [data-wallet-controls]{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:.5rem 1rem}.open-mint .mint-entry-wallet-summary{min-width:0}.open-mint .mint-entry-wallet .open-wallet-address{overflow-wrap:anywhere;margin:0;font-size:14px}.open-mint .mint-entry-wallet .open-mint-cost{font-size:13px}.open-mint .mint-entry-wallet [data-mint-feedback]{grid-column:1/-1;font-size:13px}.open-mint .mint-entry-action{display:grid;gap:.75rem;border-top:1px dashed var(--line)}.open-mint .mint-entry-action .auth-actions{margin-top:.25rem}
.open-mint .mint-entry-part .open-feedback:empty{display:none}.open-mint .mint-entry-action .open-mint-cost{font-size:13px;line-height:1.5}.open-mint .mint-entry-action .open-mint-explanation{font-size:14px}.open-mint .mint-entry-sheet .open-preview-warning{margin:0 0 1rem}.open-mint .mint-entry-submit{display:grid;gap:.75rem}.open-mint .mint-entry-sheet .mint-entry-submit .open-preview-warning{margin:0}.open-mint [data-mint-result-notice]:empty{display:none}
.open-mint .mint-entry-price-head{display:flex;align-items:center;justify-content:space-between;gap:1rem}.open-mint .mint-entry-price-head .auth-actions{margin:0}.open-mint .mint-entry-sheet [data-pulse-sale-status]{font-size:13px;color:var(--muted)}.open-mint .mint-entry-sheet [data-pulse-feedback]{font-size:14px}.open-mint .mint-entry-sheet [data-pulse-paid]{display:grid;gap:.75rem}.open-mint .mint-entry-ceiling{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,10rem);align-items:center;gap:1rem;font-size:14px}.open-mint .mint-entry-sheet [data-pulse-options] .mint-entry-ceiling{display:grid;gap:1rem}.open-mint .mint-entry-sheet [data-mint-result]:not([hidden]){margin-top:0}
.open-mint .mint-entry-recovery{display:grid;gap:.75rem;min-width:0;padding-top:1rem;border-top:1px dashed var(--line)}.open-mint .mint-entry-recovery h2{margin:0}.open-mint .mint-entry-recovery p,.open-mint .mint-entry-recovery label{font-size:14px}.open-mint .mint-entry-recovery label{display:grid;gap:.5rem;min-width:0}.open-mint .mint-entry-recovery input{width:100%;min-width:0;box-sizing:border-box;font-size:14px}.open-mint [data-mint-retry-note]{font-size:13px;color:var(--muted)}
@media(max-width:480px){.open-mint [data-mint-entry]{padding-inline:24px}.open-mint .mint-entry-ceiling{grid-template-columns:minmax(0,1fr) minmax(0,8rem)}}
.open-mint .open-mint-progress>h1{font-size:24px;margin-bottom:1.5rem}.open-mint .mint-progress-status{margin:2rem 0 1rem;padding-top:1.5rem;border-top:1px dashed var(--line)}.open-mint .mint-progress-status p{font-size:18px;line-height:1.5}.open-mint [data-assessment-code]:not([data-progress-recovery="true"]) [data-wallet-controls]>:not([data-mint-feedback]),.open-mint [data-assessment-code]:not([data-progress-recovery="true"]) [data-mint-form]{display:none}.open-mint .open-mint-progress .open-feedback:empty{display:none}.open-mint .open-mint-progress [data-wallet-controls]{margin-top:1.5rem}.open-mint .open-mint-progress [data-mint-feedback]{color:var(--muted);font-size:14px;line-height:1.6}.open-mint .open-mint-progress [data-wallet-label]{overflow-wrap:anywhere}
.open-mint [data-pulse-options] h2{margin:0;color:var(--muted)}.open-mint [data-pulse-options] label:has([name=pulse-max-eth]){display:grid;gap:.5rem}.open-mint [data-pulse-options] [name=pulse-max-eth]{width:100%;box-sizing:border-box}.open-mint [data-pulse-options] [data-pulse-feedback]{overflow-wrap:anywhere}
.open-mint [data-mint-result] .signature-page{padding:0}.open-mint [data-mint-result]{scroll-margin-top:4rem}.open-mint [data-mint-result]>.auth-actions{margin-top:1.5rem}
.open-mint :is(.open-feedback,[data-pulse-feedback],[data-poll-feedback],[data-reveal-feedback]).open-preview-warning{color:var(--ink)}

`;

const MINT_OBSERVATION_NOTICE = "Your signature is revealed, but confirmation could not be checked. Please do not submit another mint.";
const ORDINARY_MINT_OUTAGE_NOTICES = new Set([
  MINT_OBSERVATION_NOTICE,
  "Mint availability cannot be checked right now. Please try again shortly.",
  "Live network checks are temporarily unavailable. Previously verified mints are shown.",
]);
const OBSERVATION_WARNING_SLOT = "<!--mint-observation-warning-->";
function withObservationNotice(options: OpenMintPageOptions, records: Array<GalleryEntry | AssessmentPageModel>): OpenMintPageOptions {
  // A completed result has no unfinished admission/confirmation to warn about.
  // Preserve explicit integrity evidence and unfamiliar actionable notices.
  if (options.mintProcess && records.length > 0 && records.every(record => record.mint?.state === "minted" && !record.mintEvidenceInvalidated)
    && options.mintObservationNotice && ORDINARY_MINT_OUTAGE_NOTICES.has(options.mintObservationNotice)) {
    options = { ...options, mintObservationNotice: undefined };
  }
  if (!options.mintProcess || options.mintObservationManaged || options.mintObservationNotice || !records.some(record => record.mintEvidenceInvalidated || record.mintObservationUnavailable && record.mint?.state !== "minted")) return options;
  return { ...options, mintObservationNotice: records.some(record => record.mintEvidenceInvalidated)
    ? "Previously verified mints need to be checked before minting can continue." : MINT_OBSERVATION_NOTICE };
}
function observationWarning(options: OpenMintPageOptions, body: string): string {
  // The relay owns viewing data. RPC health banners belong only to an actual
  // mint process, never home, previews, collection or permanent detail pages.
  if (!/data-mint-process|data-mint-entry|data-assessment-code/.test(body)) return "";
  return `<p class="open-preview-notice open-preview-warning" data-mint-observation-warning role="status"${options.mintObservationNotice ? "" : " hidden"} id="mint-observation-warning" aria-live="polite"><strong class="open-preview-notice-label">Warning</strong> <span data-mint-observation-message>${e(options.mintObservationNotice)}</span></p>`;
}

function layout(title: string, body: string, options: OpenMintPageOptions, description = "An X handle, an artist-defined system, and Grok’s reading become a signature."): string {
  const sloganScript = body.includes('id="slogan-tooltip"') ? `<script src="${SLOGAN_TOOLTIP_SCRIPT_URL}" defer></script><script src="${SLOGAN_MBTI_HERO_SCRIPT_URL}" defer></script>` : "";
  const dev = options.development;
  body = body.replace(OBSERVATION_WARNING_SLOT, observationWarning(options, body));
  if (options.assessmentSource === "sample") description = "An X handle and a personality become a signature.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${e(title === "Signatures Gallery" ? title : `${title} · Signatures Gallery`)}</title><meta name="description" content="${e(description)}">${FAVICON_LINK}${SITE_FONT_PRELOAD}<link rel="stylesheet" href="${e(safeUrl(options.stylesheetUrl, SITE_CSS_URL))}"><script src="${e(safeUrl(options.clientScriptUrl, "/assets/open-mint.js"))}" defer></script>${sloganScript}</head><body class="book-page open-mint" data-open-mint${options.durableWalletSubmission ? ' data-durable-wallet-submission="true"' : ""} data-wallet-verified="${options.walletVerified ? "true" : "false"}" data-chain-id="${e(options.chainId)}" data-contract="${e(options.contract)}"${dev?.fixture ? ' data-fixture="true"' : ""}${dev?.localChain ? ' data-local-chain="true"' : ""}><main>${HOME_LINK}<a class="collection-shortcut" href="/me" aria-label="My Collection" title="My Collection"><span class="collection-shortcut-dot" aria-hidden="true"></span></a>${body}</main>${siteFooter()}</body></html>`;
}

function walletControls(options: OpenMintPageOptions, proved = options.walletVerified, compact = false): string {
  return `<div data-wallet-controls>${compact ? '<div class="mint-entry-wallet-summary">' : ""}<p class="open-wallet-address" data-wallet-label>${options.wallet ? e(options.wallet) : compact ? "" : "Connect the wallet that will receive the token."}</p><p class="open-mint-cost">Network: <span data-review-chain>${e(options.chainName ?? "Configured mint network")}</span></p>${compact ? "</div>" : ""}<div class="auth-actions">${action(!options.wallet ? "Connect wallet" : proved ? "Change wallet" : "Verify wallet", "data-connect-wallet")}</div><p class="open-feedback" data-mint-feedback role="status" aria-live="polite"></p></div>`;
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
    const unavailable = entry.mintEvidenceInvalidated || entry.mintObservationUnavailable && entry.mint?.state !== "minted";
    return `<article class="gallery-item" data-mint-state="${unavailable ? "unknown" : e(entry.mint?.state)}"><a class="gallery-card" href="${e(safeUrl(entry.url, signaturePath(handle)))}"><img src="${e(safeUrl(entry.imageUrl))}" alt="Signature for ${e(artworkLabel(handle, entry.mbti))}" loading="lazy"></a>${artworkCaption(handle, entry.mbti, { context: "gallery", status: unavailable ? "Status unavailable" : entry.mint?.state === "minted" ? "Minted" : "Confirming" })}</article>`;
  }).join("")}</div>`;
}

export function homePage(options: OpenMintPageOptions = {}, entries: GalleryEntry[] = []): string {
  const minted = entries.filter(entry => canRevealMint(entry.mint?.state));
  const sale = options.pulseSaleStatus;
  const mintLabel = sale?.phase === "free" ? "Free Mint" : sale?.phase === "paid" ? "Paid Mint" : "Mint a signature";
  const freeCount = Number.isSafeInteger(sale?.freeMinted) && Number.isSafeInteger(sale?.freeMintQuota)
    ? ` · ${sale!.freeMinted}/${sale!.freeMintQuota} slots used.` : ".";
  const mintStatus = sale?.paused ? "Minting is paused." : sale?.phase === "paid" ? "Paid mint open · Free mint ended."
    : options.pulseSaleNotice ?? (sale?.phase === "free" ? "Free mint open" + freeCount : options.pulseMint ? "Checking mint availability…" : "");
  const sloganText = e(SLOGAN_MBTI_HERO_MANIFEST.displayText);
  const slogan = `<div class="slogan-lockup slogan-loop"><h1 id="slogan-heading" class="visually-hidden">${sloganText}</h1><figure class="slogan-signature" title="${sloganText}" tabindex="0" role="img" aria-labelledby="slogan-heading" data-slogan-signature-version="${e(SLOGAN_MBTI_HERO_MANIFEST.version)}" data-source-renderer="${e(SLOGAN_MBTI_HERO_MANIFEST.sourceRendererVersion)}"><span class="slogan-signature-layout">${SLOGAN_MBTI_HERO_SVG}</span></figure><span id="slogan-tooltip" class="slogan-tooltip" role="tooltip" aria-hidden="true" hidden>${sloganText}</span></div>`;
  const body = `<section class="home-grid"><div class="intro-panel">${slogan}</div><div class="gallery-shell"><section class="open-intro" aria-label="Mint a signature"><p class="home-guidance"><span>Choose any X handle.</span> <span>One signature per handle—mint to reveal it.</span></p><div class="auth-actions"><a class="auth-action home-mint-cta" href="/mint" data-home-mint-cta aria-describedby="home-mint-status"><span data-home-mint-label>${mintLabel}</span></a></div><p class="home-mint-status" id="home-mint-status" data-home-mint-status role="status"${mintStatus ? "" : " hidden"}>${e(mintStatus)}</p>${handoff(options)}</section>${OBSERVATION_WARNING_SLOT}${minted.length ? galleryCards(minted) : (options.galleryPending || options.mintObservationNotice) ? '<p class="open-gallery-empty">Checking for minted signatures…</p>' : '<p class="open-gallery-empty">No signatures minted yet.</p>'}</div></section>`;
  return layout("Signatures Gallery", body, withObservationNotice(options, minted));
}

export function mbtiGalleryPage(mbti: MBTI, entries: GalleryEntry[], options: OpenMintPageOptions = {}): string {
  if (!isMbti(mbti)) throw new Error("Choose one of the 16 MBTI types, such as ENFP.");
  const minted = entries.filter(entry => canRevealMint(entry.mint?.state) && entry.mbti === mbti);
  const title = `Signatures × ${mbti}`;
  const body = `<section class="collection-page" data-mbti-gallery="${mbti}"><div class="collection-intro"><h1>${title}</h1></div>${OBSERVATION_WARNING_SLOT}${minted.length ? galleryCards(minted) : (options.galleryPending || options.mintObservationNotice) ? '<p class="open-gallery-empty">Checking for minted signatures…</p>' : `<p class="open-gallery-empty">No signatures minted with ${mbti} yet.</p>`}</section>`;
  return layout(title, body, withObservationNotice(options, minted));
}

export function requestPage(handle: string, options: OpenMintPageOptions = {}): string {
  return mintPage(handle, options);
}

export function mintPage(handle = "", options: OpenMintPageOptions = {}): string {
  const spelling = handle ? preservedHandle(handle.trim()) : "";
  const phase = options.pulseSaleStatus?.phase ?? "unknown";
  const phaseTitle = phase === "free" ? "Free Mint" : phase === "paid" ? "Mint price" : "Mint availability";
  const phaseFeedback = phase === "free" ? "Connect your wallet to check your free mint slot." : phase === "paid"
    ? "Connect your wallet to check the current price." : "Checking mint availability…";
  const pulse = options.pulseMint ? `<section class="mint-entry-part mint-entry-action" aria-label="${phaseTitle}" data-pulse-options data-pulse-phase="${phase}"><div class="mint-entry-price-head"><h2 class="mint-section-title" data-pulse-title>${phaseTitle}</h2><div class="auth-actions" data-pulse-refresh${phase === "paid" ? "" : " hidden"}>${action("Refresh price", "data-pulse-check")}</div></div><p data-pulse-sale-status role="status">${e(options.pulseSaleNotice ?? "")}</p><p data-pulse-feedback role="status">${phaseFeedback}</p><input type="hidden" name="pulse-mode" value=""><p class="open-mint-cost" data-pulse-free${phase === "free" ? "" : " hidden"}>No mint fee. You pay network gas. Free slots expire when the free phase ends.</p><div data-pulse-paid${phase === "paid" ? "" : " hidden"}><label class="mint-entry-ceiling">Maximum mint price (ETH)<input class="open-handle-input" name="pulse-max-eth" inputmode="decimal" placeholder="Your ceiling" disabled aria-describedby="mint-price-note"></label><p class="open-mint-cost" id="mint-price-note">Paid mint sends your ceiling; unused ETH is refunded. Network gas is additional.</p></div></section>` : "";
  const recovery = options.pulseMint ? `<section class="mint-entry-recovery" data-mint-recovery hidden aria-label="Resolve previous mint"><h2 class="mint-section-title">Resolve previous mint</h2><p>The previous mint for <span data-mint-recovery-handle></span> needs to be resolved before minting again.</p><div class="auth-actions">${action("Check previous mint", "data-mint-recovery-check")}</div><label>Transaction hash (optional)<input class="open-handle-input" name="mint-recovery-hash" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="0x…" aria-describedby="mint-recovery-feedback"></label><div class="auth-actions">${action("Check transaction", "data-mint-recovery-transaction")}</div><p class="open-feedback" id="mint-recovery-feedback" data-mint-recovery-feedback role="status" aria-live="polite"></p></section><p data-mint-retry-note hidden>Cancel any queued transaction in your wallet before starting a new mint; it can still use gas.</p>` : "";
  return layout("Mint & reveal", `<section class="auth-page" data-mint-process data-mint-entry data-wallet-verified="${options.walletVerified ? "true" : "false"}"><div class="auth-sheet mint-entry-sheet"><form class="open-mint-form" data-assessment-request${options.pulseMint ? ' data-pulse-mint="true"' : ""}>
<section class="mint-entry-part mint-entry-handle" aria-label="Choose a handle"><label for="open-handle"><span class="mint-section-title">Choose any X handle.</span><input class="open-handle-input" id="open-handle" name="handle" value="${e(spelling)}" placeholder="@handle" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="16" pattern="@?[A-Za-z0-9_]{1,15}" required aria-describedby="handle-validation mint-explanation request-feedback"></label><p id="handle-validation" class="open-preview-notice open-preview-warning" data-handle-validation role="status" aria-live="polite" hidden></p></section>
<section class="mint-entry-part mint-entry-wallet" aria-labelledby="recipient-heading"><h2 id="recipient-heading" class="mint-section-title">To your wallet</h2>${walletControls(options, options.walletVerified, true)}</section>${pulse}
<section class="mint-entry-part mint-entry-action" aria-label="Mint and reveal"><p id="mint-explanation" class="open-mint-explanation">${options.assessmentSource === "sample" ? "The final signature may differ from " : "Grok chooses the final signature. It may differ from "}<a data-mint-preview${spelling ? ` href="${e(handleVariationsPath(spelling))}"` : ""}>your preview</a>. <strong>Reveal after minting.</strong></p><p class="open-mint-cost">${options.pulseMint ? "Minting creates a permanent public token. Network gas is additional." : "No mint fee. You pay network gas. Minting creates a permanent public token."}</p><div class="mint-entry-submit" data-mint-action-notice><div class="auth-actions"><button class="auth-action" type="submit" aria-describedby="mint-explanation mint-observation-warning request-feedback" data-request-submit${options.walletVerified ? "" : " disabled"}><span>Mint &amp; reveal</span></button></div>${OBSERVATION_WARNING_SLOT}<p class="open-feedback" id="request-feedback" data-request-feedback role="status" aria-live="polite"></p>${recovery}</div></section></form><div data-mint-result hidden tabindex="-1" aria-label="Revealed signature"><div data-mint-result-artwork></div><div data-mint-result-notice></div><p class="open-feedback" data-mint-result-feedback role="status" aria-live="polite"></p><div class="auth-actions"><a class="auth-action" data-mint-result-link><span>View signature</span></a>${action("Mint another signature", "data-mint-another")}</div></div></div></section>`, options);
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
    : state.state === "confirming" ? '<p class="open-preview-note" data-preview-status role="status">The signature is revealed and visible in the gallery. Its mint is still confirming.</p>' : "";
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
  if (mint === "pending") return `<p class="open-feedback${model.mint?.submissionUncertain ? " open-preview-notice open-preview-warning" : ""}" data-mint-feedback role="status" aria-live="polite">${model.mint?.submissionUncertain ? '<strong class="open-preview-notice-label">Warning</strong> <span>A wallet submission was started, but its outcome is unknown. Check wallet activity; do not send another mint.</span>' : "Waiting for the transaction to be confirmed."}</p>`;
  const view = mintUiState({ assessmentStatus: model.status, mintState: mint, requestExpired: model.requestExpired, canMint: model.canMint, walletVerified: model.walletProvedForCode });
  if (view.showReturn) return "";
  if (view.phase === "failed" || view.phase === "abstained") return `<p class="open-feedback open-preview-notice open-preview-warning" data-mint-feedback role="status" aria-live="polite"><strong class="open-preview-notice-label">Warning</strong> <span>${e(assessmentFailureText(model))}</span></p>`;
  return `${walletControls(options, model.walletProvedForCode)}<form data-mint-form${model.status === "pending" ? " hidden" : ""}><button class="auth-action" type="submit" data-submit-mint disabled><span>Continue mint</span></button></form>`;
}

export function assessmentPage(model: AssessmentPageModel, options: OpenMintPageOptions = {}): string {
  if (model.galleryFixture && !options.development?.fixture) throw new Error("Gallery samples require fixture mode.");
  const canonical = canonicalPageHandle(model.handle);
  const handle = renderedPageHandle(model.handle, model.renderHandle);
  if (model.pulseMaxPriceWei !== undefined && (!options.pulseMint || !/^(0|[1-9][0-9]*)$/.test(model.pulseMaxPriceWei) || BigInt(model.pulseMaxPriceWei) >= 2n ** 256n)) throw new Error("Invalid saved Pulse spending ceiling.");
let attributes = `data-assessment-code="${e(model.code)}" data-assessment-handle="${e(canonical)}" data-assessment-state="${e(model.status)}" data-can-mint="${model.canMint ? "true" : "false"}" data-wallet-proved="${model.walletProvedForCode ? "true" : "false"}" data-mint-state="${e(model.mint?.state ?? "unminted")}" data-token-id="${e(model.tokenId ?? model.mint?.tokenId)}" data-mint-transaction-hash="${e(/^0x[a-f0-9]{64}$/i.test(model.mint?.transactionHash ?? "") ? model.mint?.transactionHash : "")}" data-request-expired="${model.requestExpired ? "true" : "false"}" data-request-expires-at="${e(model.requestExpiresAt)}" data-wallet-proof-expires-at="${e(model.walletProofExpiresAt)}" data-server-now="${e(model.serverNow)}"`;
  if (model.pulseMaxPriceWei !== undefined) attributes += ` data-pulse-max-price-wei="${e(model.pulseMaxPriceWei)}"`;
  if (!canRevealMint(model.mint?.state)) {
    const view = mintUiState({ assessmentStatus: model.status, mintState: model.mint?.state ?? "unminted", requestExpired: model.requestExpired, canMint: model.canMint, walletVerified: model.walletProvedForCode, booting: model.canMint });
    if (model.mint?.submissionUncertain) view.status = "Checking your wallet submission. Check wallet activity before any retry.";
    const supportUrl = openMintSupportUrl(options.supportUrl);
    const support = supportUrl ? `<div class="auth-actions" data-assessment-support${view.phase === "failed" || view.phase === "abstained" ? "" : " hidden"}><a class="auth-action" href="${e(supportUrl)}" rel="noopener noreferrer" referrerpolicy="no-referrer"><span>Request help</span></a></div>` : "";
    const recovery = `<div data-request-recovery${view.showReturn ? "" : " hidden"}><p class="auth-note" data-request-recovery-message>Return to mint to continue. Any saved assessment and artwork will be reused.</p><div class="auth-actions"><a class="auth-action" href="${e(mintPath(handle))}"><span>Return to mint</span></a></div></div>`;
    return layout(`Mint & reveal · @${handle}`, `<section class="auth-page" ${attributes}><div class="auth-sheet open-mint-progress">${OBSERVATION_WARNING_SLOT}<h1>Mint &amp; reveal</h1><p>${handleLink(handle)}</p><div class="mint-progress-status"><p data-assessment-status role="status" aria-live="polite">${view.status}</p></div>${mintControls(model, options)}${support}<p class="open-feedback" data-mint-transaction${/^0x[a-f0-9]{64}$/i.test(model.mint?.transactionHash ?? "") ? "" : " hidden"}>${/^0x[a-f0-9]{64}$/i.test(model.mint?.transactionHash ?? "") ? `Transaction: ${e(model.mint?.transactionHash)}` : ""}</p><p class="open-feedback" data-mint-network hidden></p>${recovery}<p class="open-feedback" data-poll-feedback role="status" aria-live="polite"></p><div class="auth-actions"><button class="auth-action" type="button" data-check-progress hidden><span>Check progress</span></button></div></div></section>`, options);
  }
  const result = revealedSignature(model, options);
  return layout(artworkLabel(handle, model.mbti), options.mintProcess ? `<section data-mint-process>${result}</section>` : result, withObservationNotice(options, [model]));
}

/** Shared result for the mint page and permanent signature page. A submitted
 * transaction alone must never expose an unrevealed assessment or artwork. */
export function revealedSignature(model: AssessmentPageModel, options: OpenMintPageOptions = {}): string {
  if (model.galleryFixture && !options.development?.fixture) throw new Error("Gallery samples require fixture mode.");
  if (!canRevealMint(model.mint?.state)) throw new Error("A verified successful inclusion is required to reveal a signature.");
  const canonical = canonicalPageHandle(model.handle);
  const handle = renderedPageHandle(model.handle, model.renderHandle);
  const image = safeUrl(model.svgUrl ?? model.imageUrl);
  const art = image !== "#" ? `<img src="${e(image)}" alt="Signature for ${e(artworkLabel(handle, model.mbti))}">` : `<div class="open-art-waiting"><p role="status">The minted artwork is temporarily unavailable.</p></div>`;
  const provenance = `<div class="signature-tools"><details class="signature-provenance"><summary>Provenance</summary><div class="signature-provenance-body">${provenanceBody(model, handle)}</div></details>${model.status === "ready" && model.svgUrl ? `<a class="signature-svg" href="${e(safeUrl(model.svgUrl))}" target="_blank" rel="noopener noreferrer" aria-label="Open original SVG">SVG ↗</a>` : ""}</div>`;
  const confirming = model.mint?.state === "confirming";
  const unavailable = model.mintEvidenceInvalidated === true || model.mintObservationUnavailable === true && confirming;
  const commitment = model.inputDigest ? ` data-reveal-input="${e(model.inputDigest)}" data-reveal-renderer="${e(model.rendererIdentity)}"` : ` data-reveal-artifact="${e(model.artifactDigest)}"`;
  const monitor = confirming || unavailable ? ` data-reveal-monitor data-reveal-handle="${e(canonical)}" data-reveal-token="${e(model.tokenId ?? model.mint?.tokenId)}"${commitment}` : "";
  const feedback = options.mintProcess && unavailable ? '<p data-reveal-feedback role="status" aria-live="polite">This is your previously revealed signature. Its current mint status cannot be checked right now.</p>' : confirming && options.mintProcess ? '<p data-reveal-feedback role="status" aria-live="polite">Your signature is revealed and visible in the gallery. The mint succeeded and is still confirming.</p>' : '<p data-reveal-feedback role="status" aria-live="polite"></p>';
  return `<article class="signature-page" data-mint-state="${unavailable ? "unknown" : confirming ? "confirming" : "minted"}"${monitor}><div class="signature-sheet"><figure class="signature-art" data-reveal-artwork>${art}</figure><div class="signature-record">${artworkCaption(handle, model.mbti, { context: "detail", status: unavailable ? "Status unavailable" : confirming ? "Confirming" : "Minted", mintStateLabel: true })}${OBSERVATION_WARNING_SLOT}${feedback}${mintControls(model, options)}<div data-reveal-provenance>${provenance}</div></div></div></article>`;
}

export function collectionPage(entries: GalleryEntry[] = [], options: OpenMintPageOptions = {}): string {
  const wallet = options.wallet;
  const minted = entries.filter(entry => canRevealMint(entry.mint?.state));
  const body = `<section class="collection-page" data-collection-page><div class="collection-intro"><h1>My Collection</h1><div class="open-collection-wallet"><p class="open-wallet-address" data-wallet-label>${wallet ? e(wallet) : "Connect your wallet to see the signatures it holds."}</p>${action(wallet ? "Change wallet" : "Connect wallet", "data-connect-wallet")}${wallet ? action("Disconnect", "data-disconnect-wallet") : ""}</div><p class="open-feedback" data-mint-feedback role="status" aria-live="polite"></p></div>${OBSERVATION_WARNING_SLOT}${minted.length ? galleryCards(minted) : `<div class="collection-empty signed-out-participation"><p>${wallet ? options.galleryPending ? "Checking your collection…" : options.mintObservationNotice ? "Your collection cannot be checked right now." : "This wallet has no minted signatures yet." : "Your collection follows your wallet."}</p><a class="auth-action" href="/mint"><span>Mint a signature</span></a></div>`}</section>`;
  return layout("My Collection", body, withObservationNotice(options, minted));
}

export function aboutPage(options: OpenMintPageOptions = {}): string {
  const preparation = options.assessmentSource === "sample"
    ? "The entered handle and selected MBTI are fixed at preparation and stored as immutable inputs when minted. The on-chain renderer generates the signature and its metadata. The assessment source is recorded in each work’s provenance."
    : options.generativeArtwork
    ? "The verified spelling and first accepted assessment are preserved at preparation. Minting stores the handle and MBTI as immutable inputs. The on-chain renderer generates the SVG and metadata when they are read; the finished image is not uploaded to IPFS or stored in the mint transaction. The spelling is not checked again at transaction confirmation. Cancelling or expiring a request does not trigger another assessment. An unresolved transaction or reservation requires operator review before another attempt."
    : "The verified spelling, first accepted assessment, and artwork are saved as a snapshot at preparation. The spelling is not checked again at transaction confirmation. The first accepted assessment is kept for that handle; cancelling a transaction does not create another result. Later mint attempts reuse the saved assessment and artwork, including after a mint request expires. Expiry does not trigger another assessment.";
  const reveal = options.generativeArtwork ? "The inputs are prepared before the wallet transaction. The signature is generated from the contract and revealed after verified inclusion" : "The artwork is prepared before the wallet transaction and revealed after verified inclusion";
  return layout("About the work", `<article class="about-page"><div class="about-sheet"><h1>About the work</h1><p>Signatures Gallery turns an X handle into a handwriting-like mark. A public identifier becomes a drawn signature.</p>
<section><h2>Explore</h2><p>Ask Grok on X or Grok.com to resolve a handle’s current username spelling, interpret its MBTI, and share a preview link. A preview combines the handle and the MBTI in its URL. You can change either to play with the result. Preview pages keep the capitalization in the URL without looking up X. Preview pages do not call our assessment service or authorize a mint.</p><p>The MBTI is an artistic input, not a diagnosis or a fact about the person behind an account.</p></section>
<section><h2>Mint &amp; reveal</h2><p>Anyone can mint for any handle. Connect a wallet, enter a handle, and choose Mint &amp; reveal. ${options.assessmentSource === "sample" ? "The handle and personality are fixed before minting." : "During preparation, our backend independently verifies the current X username spelling and asks Grok to research public X posts and choose the MBTI."} It does not accept the preview’s MBTI. The final signature may differ from your preview.</p><p>${preparation}</p><p>${reveal}, with a Confirming label while confirmation completes. It appears in the gallery at the same time, then becomes Minted after finalization. This is a reveal experience, not cryptographic secrecy.</p><p>${options.pulseMint ? "Eligible slots mint free until the free phase ends. Paid mints follow Pulse pricing and require your explicit spending ceiling. You pay network gas in either phase." : "No mint fee. You pay network gas."} A token is identified by the canonical handle, regardless of letter case: one minted token per handle. Identity follows the handle, not the X account ID. A renamed handle is a different identity; changing capitalization alone does not create another token. A token can move between wallets; holding one does not prove control of the X account. Minting leaves a permanent public record.</p></section>
<section><h2>Agent Art</h2><p>Project 01 by <a href="https://x.com/AgentArt_AA" target="_blank" rel="noopener noreferrer">Agent Art ↗</a>.</p></section></div></article>`, options);
}

export function errorPage(message: string, options: OpenMintPageOptions = {}): string {
  return layout("Unable to open this page", `<section class="auth-page"><div class="auth-sheet"><h1>Unable to open this page</h1><p role="alert">${e(message)}</p><a class="auth-action" href="/"><span>Back to gallery</span></a></div></section>`, options);
}
