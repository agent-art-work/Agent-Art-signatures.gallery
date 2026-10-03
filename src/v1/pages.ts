import { formatGr0k } from "./input.js";
import { xProfileLink } from "./xProfile.js";
import { CLAIM_ON_RETURN_INTENT } from "./authState.js";
import { SITE_FONT_PRELOAD } from "./fonts.js";
import { SITE_CSS_URL } from "./siteCss.js";
import { HOME_LINK, HOME_ICON } from "./navigation.js";
import { FAVICON_LINK } from "../brand/favicon.js";
import { siteFooter } from "../brand/footer.js";
import { ARTIST_NAME, ARTIST_X_URL } from "../brand/artist.js";
import { LOCAL_TEST_RECIPIENT, LOCAL_TEST_WALLET } from "../local/wallet.js";
import { accountPanelShell, walletLinkControls, developmentWalletControls, developmentAuthenticationNotice, type AccountPanelView } from "./accountPanel.js";
import { MINT_SCRIPT_URL, ACCOUNT_PANEL_SCRIPT_URL, REHEARSAL_SCRIPT_URL, ACTION_TOOLTIP_SCRIPT_URL, CLAIM_NOTICE_SCRIPT_URL, WITHDRAW_CLAIM_DIALOG_SCRIPT_URL, X_ACTION_PROGRESS_SCRIPT_URL } from "./scriptAssets.js";
import { claimNoticeShell } from "./claimNotice.js";
import { grokPrompt, GROK_URL } from "./grokPrompt.js";
import { COLLECTION_STATE_FIXTURES } from "./collectionStateCatalog.js";
import {
  SLOGAN_DISPLAY_TEXT,
  SLOGAN_SIGNATURE_MANIFEST,
  SLOGAN_SIGNATURE_MOBILE_SVG,
  SLOGAN_SIGNATURE_SVG,
} from "../brand/sloganSignature.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function shortAddress(value: string): string {
  return value.length > 13 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}

export interface PagePreview {
  state: string;
  label: string;
  description: string;
}

interface LayoutOptions {
  title: string;
  description: string;
  body: string;
  fixtureMode?: boolean;
  localChainRehearsal?: boolean;
  localOAuthMode?: boolean;
  robots?: "index" | "noindex";
  ogImage?: string;
  bookPage?: boolean;
  sloganTooltip?: boolean;
  claimNoticeSignatureId?: string;
  accountPanel?: AccountPanelView;
  footerAboutCurrent?: boolean;
  grokHandoff?: boolean;
  preview?: PagePreview;
  developmentNotes?: ReadonlyArray<{ title: string; paragraphs: readonly string[] }>;
  /** First-party rendered tools only, never user-supplied markup. */
  developmentTools?: string;
  developmentOpen?: boolean;
}


export function layout(options: LayoutOptions): string {
  const title = escapeHtml(options.title);
  const description = escapeHtml(options.description);
  const og = options.ogImage
    ? `<meta property="og:type" content="website"><meta property="og:image" content="${escapeHtml(options.ogImage)}"><meta property="og:image:type" content="image/png"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${escapeHtml(options.ogImage)}">`
    : "";
  const robots = options.preview || options.fixtureMode || options.localChainRehearsal || options.localOAuthMode ? "noindex" : options.robots ?? "index";
  const bodyClass = (options.bookPage ? ' class="book-page"' : "") + (options.preview ? ' data-state-preview' : "");
  const sloganScript = options.sloganTooltip ? '<script src="/assets/slogan-tooltip.js" defer></script>' : "";
  const mintScript = options.preview ? "" : [MINT_SCRIPT_URL, X_ACTION_PROGRESS_SCRIPT_URL].map(src => `<script src="${src}" defer></script>`).join("");
  const promptScript = options.grokHandoff ? '<script src="/assets/grok-prompt.js" defer></script>' : "";
  const rehearsal = options.fixtureMode || options.localChainRehearsal || options.localOAuthMode || options.preview;
  const rehearsalScript = rehearsal ? `<script src="${REHEARSAL_SCRIPT_URL}" defer></script>` : "";
  const rehearsalDescription = options.localChainRehearsal
    ? "Repo-local Anvil chain, not Ethereum mainnet or Sepolia. Local promotion is not Ethereum finality. Seeded X identities are simulated. Interactive sign-in uses the configured provider. Public test keys. Never send real funds."
    : "Fictional demo: fixture accounts and works are simulated, not proof of X authentication or Ethereum provenance. No participation or endorsement is implied.";
  const fixtureNotes = options.preview
    ? `<section class="rehearsal-fixture" data-fixture-state="${escapeHtml(options.preview.state)}"><h2>Fixture · ${escapeHtml(options.preview.label)}</h2><p>Read-only UI fixture using the same page components with simulated data. This status is forced by the URL, not your live collection.</p><p>${escapeHtml(options.preview.description)}</p><p>Account and mint actions are disabled. Viewing this fixture changes no account, claim, or chain state.</p><p>URL override: <code>state=${escapeHtml(options.preview.state)}</code></p></section>` : "";
  const fixtureLinks = options.fixtureMode || options.preview
    ? `<section class="rehearsal-switcher"><h2>Switch fixture</h2><nav class="rehearsal-fixture-links" aria-label="Switch fixture">${COLLECTION_STATE_FIXTURES.map((state) => `<a href="/dev/collection-states?state=${escapeHtml(state.key)}"${options.preview?.state === state.key ? ' aria-current="page"' : ""}><span>${escapeHtml(state.label)}</span></a>`).join("")}</nav></section>` : "";
  const developmentNotes = (options.developmentNotes ?? []).map(note => `<section class="rehearsal-page-note"><h2>${escapeHtml(note.title)}</h2>${note.paragraphs.map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join("")}</section>`).join("");
  // Developer context stays outside the document flow and product landmarks.
  // Native details works with keyboard, touch, and JavaScript disabled.
  const watermark = rehearsal
    ? `<aside class="rehearsal-watermark" aria-label="Developer overlay"><details class="rehearsal-disclosure"${options.developmentOpen ? " open" : ""}><summary aria-controls="rehearsal-context" aria-label="${options.preview ? "UI fixture" : "Local rehearsal"} · developer notes"><span class="rehearsal-dev-badge">DEV</span><span>${options.preview ? "UI fixture" : "Local rehearsal"}</span></summary><div class="rehearsal-context" id="rehearsal-context"><p class="rehearsal-context-heading">Developer overlay · not part of the gallery</p>${options.developmentTools ?? ""}<div data-dev-account-tools>${developmentAuthenticationNotice(options.accountPanel ?? (options.localOAuthMode === undefined ? undefined : { fixtureMode: Boolean(options.fixtureMode), localChainRehearsal: options.localChainRehearsal, localOAuthMode: options.localOAuthMode, mintEnabled: false, mintChainId: "" }))}${developmentWalletControls(options.accountPanel)}</div>${developmentNotes}${fixtureNotes}<section><h2>Local rehearsal</h2><p>${rehearsalDescription}</p></section>${fixtureLinks}</div></details></aside>`
    : "";
  const footer = siteFooter(options.footerAboutCurrent);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="${robots}"><title>${title}</title><meta name="description" content="${description}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}">${og}${FAVICON_LINK}${mintScript}<script src="${ACCOUNT_PANEL_SCRIPT_URL}" defer></script>${sloganScript}${options.claimNoticeSignatureId ? `<script src="${CLAIM_NOTICE_SCRIPT_URL}" defer></script><script src="${WITHDRAW_CLAIM_DIALOG_SCRIPT_URL}" defer></script>` : ""}${options.body.includes("data-action-tooltip=") ? `<script src="${ACTION_TOOLTIP_SCRIPT_URL}" defer></script>` : ""}${promptScript}${rehearsalScript}${SITE_FONT_PRELOAD}<link rel="stylesheet" href="${SITE_CSS_URL}"></head><body${bodyClass}><main>${accountPanelShell(options.accountPanel)}${options.body}</main>${footer}${watermark}${options.claimNoticeSignatureId ? claimNoticeShell(options.claimNoticeSignatureId) : ""}</body></html>`;
}



/** The authentication flow uses the same paper, scale and column as the work. */
function authPage(options: LayoutOptions & { collection?: boolean }): string {
  return layout({ ...options, bookPage: true, robots: "noindex", body: `${HOME_LINK}<section class="auth-page"><div class="auth-sheet${options.collection ? " collection-sheet" : ""}">${options.body}</div></section>` });
}


function localIdentityNotes(localOAuth: boolean): NonNullable<LayoutOptions["developmentNotes"]> {
  return localOAuth ? [{ title: "Local identity", paragraphs: ["Local rehearsal. No X account was authenticated. The local OAuth emulator does not contact X or prove control of an X account."] }] : [];
}

export function aboutPage(fixtureMode = false, localChainRehearsal = false): string {
  const body = `${HOME_LINK}<article class="about-page" aria-labelledby="about-heading"><div class="about-sheet"><h1 id="about-heading">About the work</h1><p>Signatures Gallery turns an X handle into a handwriting-like mark. A public identifier becomes a drawn signature.</p><section><h2>Handle and Agent</h2><p>An artist-defined algorithm gives the handle its underlying structure. In the intended workflow, Grok reads recent public posts and selects <code>gr0k</code>, the environmental condition in which that structure is rendered.</p><p>The handle provides the architecture; the Agent contributes to its expression. <code>gr0k</code> is not a score, a mood, a probability, or a judgment of the person behind the handle.</p></section><section><h2>Claiming and minting</h2><p>A preview creates no claim. Choosing “Claim with X” creates a durable public record of the exact signature when the matching X account returns. Ordinary account sign-in creates no claim.</p><p>Minting is a separate, optional wallet action. It records the claimed work on Ethereum without changing the artwork. A token can move to another wallet; the original claimant remains the same. Holding the token does not prove control of the claimant’s X account.</p></section><section><h2>Agent Art</h2><p>This is Project 01, the inaugural project presented by <a href="${ARTIST_X_URL}">${ARTIST_NAME} ↗</a>. The work brings a public identifier, an artist-defined system, and an Agent’s contribution into one mark.</p></section><details class="auth-disclosure"><summary>About provenance</summary><p>X authentication establishes account control at the time of authentication. The gallery cannot independently verify the private conversation with Grok or who selected <code>gr0k</code>.</p><p>The stored SVG is the canonical artwork. Its PNG derivative is used for social link previews. Each signature’s Provenance section separates the claim, artwork, and mint records.</p></details></div></article>`;
  return layout({ title: "About the work · Signatures Gallery", description: "An X handle, an artist-defined system, and an Agent’s contribution become a handwriting-like signature.", body, fixtureMode, localChainRehearsal, robots: fixtureMode || localChainRehearsal ? "noindex" : "index", bookPage: true, footerAboutCurrent: true });
}

export interface GalleryCardView {
  signatureId: string;
  handleAtClaim: string;
  gr0kRaw: number;
  mintWallet: string;
  currentTokenHolder: string;
  finalizedAt: Date;
}

export type GalleryTab = "claimed" | "minted";

export interface ClaimedGalleryCardView {
  signatureId: string;
  handleAtClaim: string;
  gr0kRaw: number;
  claimedAt: Date;
}

function galleryCards(entries: Array<GalleryCardView | ClaimedGalleryCardView>, fixtureMode: boolean, localChainRehearsal: boolean, tab: GalleryTab, publicOrigin?: string): string {
  if (entries.length === 0) {
    const message = tab === "claimed" ? "No claimed signatures yet." : "No finalized signatures yet.";
    return `<div class="collection-empty gallery-empty"><h2>${message}</h2>${participationGuidance({ publicOrigin })}</div>`;
  }
  const walletLabel = "Initial recipient";
  return `<div class="public-gallery-grid">${entries.map((entry) => {
    const minted = "finalizedAt" in entry;
    const provenance = minted
      ? `<small>${walletLabel} · ${escapeHtml(shortAddress(entry.mintWallet))}</small><small>${entry.currentTokenHolder.toLowerCase() === entry.mintWallet.toLowerCase() ? "Held by initial recipient" : `Current holder · ${escapeHtml(shortAddress(entry.currentTokenHolder))}`}</small>`
      : fixtureMode || localChainRehearsal ? "" : '<small>Claimed via X</small>';
    return `<article class="gallery-item"><a class="gallery-card" href="/signatures/${escapeHtml(entry.signatureId)}"><img src="/artifacts/${escapeHtml(entry.signatureId)}.svg" alt="Signature claimed as @${escapeHtml(entry.handleAtClaim)}"></a><div class="gallery-card-copy"><strong>${xProfileLink(entry.handleAtClaim)}</strong><span>gr0k ${formatGr0k(entry.gr0kRaw)}</span>${provenance}</div></article>`;
  }).join("")}</div>`;
}

export function homePage(fixtureMode: boolean, entries: Array<GalleryCardView | ClaimedGalleryCardView> = [], nextGalleryHref: string | null = null, localChainRehearsal = false, tab: GalleryTab = "claimed", options: { publicOrigin?: string; preview?: PagePreview } = {}): string {
  const more = nextGalleryHref ? `<a class="gallery-more" rel="next" href="${escapeHtml(nextGalleryHref)}">More ${tab === "claimed" ? "claimed" : "finalized"} signatures →</a>` : "";
  const tabs = `<nav class="gallery-tabs" aria-label="Signature galleries"><a href="/?tab=claimed"${tab === "claimed" ? ' aria-current="page"' : ""}><span>Claimed</span></a><span aria-hidden="true">|</span><a href="/?tab=minted"${tab === "minted" ? ' aria-current="page"' : ""}><span>Minted</span></a></nav>`;
  const sloganText = escapeHtml(SLOGAN_DISPLAY_TEXT);
  const body = `<section class="home-grid"><div class="intro-panel"><div class="slogan-lockup"><h1 id="slogan-heading" class="visually-hidden">${sloganText}</h1><figure class="slogan-signature" title="${sloganText}" tabindex="0" role="img" aria-labelledby="slogan-heading" data-slogan-signature-version="${escapeHtml(SLOGAN_SIGNATURE_MANIFEST.version)}" data-shape-lock-schema="${escapeHtml(SLOGAN_SIGNATURE_MANIFEST.shapeLockSchema)}" data-source-renderer="${escapeHtml(SLOGAN_SIGNATURE_MANIFEST.sourceRendererVersion)}" data-source-gr0k="22"><span class="slogan-signature-layout slogan-signature-desktop">${SLOGAN_SIGNATURE_SVG}</span><span class="slogan-signature-layout slogan-signature-mobile">${SLOGAN_SIGNATURE_MOBILE_SVG}</span></figure><span id="slogan-tooltip" class="slogan-tooltip" role="tooltip" aria-hidden="true" hidden>${sloganText}</span></div></div><aside class="gallery-shell">${tabs}${galleryCards(entries, fixtureMode, localChainRehearsal, tab, options.publicOrigin)}${more}</aside></section>`;
  return layout({ title: `Signatures Gallery · ${ARTIST_NAME} project 01`, description: `The inaugural project presented by ${ARTIST_NAME}: signatures claimed through X and minted on Ethereum.`, body, fixtureMode, localChainRehearsal, robots: fixtureMode || tab === "claimed" ? "noindex" : "index", bookPage: true, sloganTooltip: true, grokHandoff: entries.length === 0, preview: options.preview, accountPanel: options.preview ? { fixtureMode, localOAuthMode: fixtureMode, mintEnabled: false, mintChainId: "31337", previewOnly: true } : undefined });
}

export interface PreviewPageParams {
  handle: string;
  gr0kRaw: number;
  rendererVersion: string;
  previewSvgSha256?: string;
  imageUrl: string;
  fixtureMode: boolean;
  localOAuthMode?: boolean;
  localChainRehearsal?: boolean;
  notice?: string;
  claim?: { state: "confirm" | "retry"; flowId: string; csrfToken: string } | { state: "claimed"; signatureId: string };
}

export function previewPage(params: PreviewPageParams): string {
  const handle = escapeHtml(params.handle);
  const gr0k = formatGr0k(params.gr0kRaw);
  const svgUrl = escapeHtml(params.imageUrl.replace(/\.png$/, ".svg"));
  const localOAuthMode = params.localOAuthMode ?? params.fixtureMode;
  const state = params.claim?.state ?? "sign-in";
  let action: string;
  if (params.claim?.state === "claimed") {
    action = `<p>Claimed. This signature is now in your collection and the public gallery.</p><div class="auth-actions"><a class="auth-action auth-action-quiet" href="/signatures/${escapeHtml(params.claim.signatureId)}"><span>View signature →</span></a></div>`;
  } else if (params.claim?.state === "confirm" || params.claim?.state === "retry") {
    const retry = params.claim.state === "retry";
    const explanation = retry
      ? `<p role="status">${escapeHtml(params.notice ?? "Your X sign-in succeeded, but the claim could not be saved. Try again.")}</p>`
      : `<p>Signed in as @${handle}. Confirm to add this signature to your collection and the public gallery. This does not mint a token. You can withdraw the claim before minting begins.</p>`;
    action = `${explanation}<form class="auth-actions" method="post" action="/api/v1/signatures"><input type="hidden" name="flow" value="${escapeHtml(params.claim.flowId)}"><input type="hidden" name="csrf" value="${escapeHtml(params.claim.csrfToken)}"><button class="auth-action" type="submit"><span>${retry ? "Retry claim" : "Confirm claim"}</span></button><a class="auth-action auth-action-quiet" href="/s/${handle}/${gr0k}#claim"><span>Cancel</span></a></form>`;
  } else {
    action = `${params.notice ? `<p role="status">${escapeHtml(params.notice)}</p>` : ""}<form class="auth-actions" method="post" action="/auth/x/start"><input type="hidden" name="purpose" value="claim"><input type="hidden" name="handle" value="${handle}"><input type="hidden" name="gr0k" value="${gr0k}"><input type="hidden" name="claim_intent" value="${CLAIM_ON_RETURN_INTENT}"><input type="hidden" name="renderer_version" value="${escapeHtml(params.rendererVersion)}"><input type="hidden" name="preview_sha256" value="${escapeHtml(params.previewSvgSha256 ?? "")}"><button class="auth-action" type="submit" data-action-tooltip="claim-tooltip" aria-describedby="claim-tooltip" title="Signing in as @${handle} will claim this signature for your collection and the public gallery. This does not mint a token. You can withdraw the claim before minting begins."><span>Claim with X</span></button><span class="action-tooltip" id="claim-tooltip" role="tooltip" hidden>Signing in as @${handle} will claim this signature for your collection and the public gallery. This does not mint a token. You can withdraw the claim before minting begins.</span></form>`;
  }
  const proof = params.claim && !localOAuthMode
    ? `X authenticated the account controlling @${handle}. It does not prove that Grok created this URL or selected the value.`
    : "In the intended workflow, gr0k is selected in a private Grok conversation. Signatures Gallery cannot independently verify that private step.";
  const body = `<figure class="signature-art"><img src="${svgUrl}" alt="Signature for @${handle}"></figure><div class="signature-record"><div class="signature-heading"><h1>${xProfileLink(params.handle)}</h1><span class="signature-gr0k">gr0k ${gr0k}</span><span class="signature-tags"><span class="signature-tag"${state === "claimed" ? ' data-signature-status="claimed"' : ""}>${state === "claimed" ? "Claimed" : "Unclaimed"}</span></span></div><section class="claim-action" id="claim" data-claim-state="${state}" aria-label="Claim this signature">${action}</section><details class="auth-disclosure"><summary>About this signature</summary><p>Choosing “Claim with X” authorizes a durable public claim after the matching X account returns. Opening a preview or using ordinary account sign-in creates no claim. Minting is a later, optional wallet action.</p><p>${proof}</p><dl class="signature-facts"><div><dt>Renderer</dt><dd>${escapeHtml(params.rendererVersion)}</dd></div></dl></details></div>`;
  const developmentNotes = localOAuthMode && state === "confirm"
    ? [{ title: "Claim review rehearsal", paragraphs: [`The local OAuth emulator asserted the fixture identity @${params.handle}. No request was sent to X, and this does not prove control of an X account.`] }]
    : localIdentityNotes(localOAuthMode);
  return authPage({ title: `@${params.handle} · gr0k ${gr0k}`, description: `${state === "claimed" ? "Claimed signature" : "Signature preview"} for @${params.handle} at gr0k ${gr0k}.`, body, fixtureMode: params.fixtureMode, localChainRehearsal: params.localChainRehearsal, ogImage: params.imageUrl, localOAuthMode, developmentNotes });
}

export interface SignatureView {
  signatureId: string;
  handleAtClaim: string;
  gr0kRaw: number;
  rendererVersion: string;
  svgSha256: string;
  pngSha256: string;
  cardRendererVersion: string;
  xAuthenticatedAt: Date;
  claimedAt: Date;
  publicAccountId: string;
}

export interface WalletView {
  address: string;
  chainName: string;
  chainId: string;
  provedAt: Date;
}

export interface CollectionMintView {
  state: string;
  label: string;
  txHash?: string | null;
  currentTokenHolder?: string | null;
  tokenId?: string | null;
  explorerTransactionUrl?: string | null;
  explorerTokenUrl?: string | null;
}

export interface SignatureMintView extends CollectionMintView {
  mintWallet?: string | null;
  currentTokenHolder?: string | null;
  contract?: string | null;
  chainName?: string | null;
  tokenId?: string | null;
  tokenUri?: string | null;
  metadataSha256?: string | null;
  finalizedAt?: Date | null;
  explorerTransactionUrl?: string | null;
  explorerContractUrl?: string | null;
  finalityLabel?: string | null;
}

/** Compatibility renderer: confirmation is a state of the artwork page, not a separate layout. */
export function reviewPage(params: Omit<PreviewPageParams, "claim"> & { flowId: string; csrfToken: string }): string {
  return previewPage({ ...params, claim: { state: "confirm", flowId: params.flowId, csrfToken: params.csrfToken } });
}

function signatureMintLabel(mint: SignatureMintView): string {
  return mint.state === "included_unfinalized" ? "Confirming" : mint.label;
}

function mintProvenance(mint: SignatureMintView, fixtureMode: boolean, localChainRehearsal = false): string {
  if (mint.state !== "finalized") {
    return `<section class="signature-provenance-section"><h2>Mint status</h2><p>${escapeHtml(signatureMintLabel(mint))}</p><p>Only a validated mint event that reaches Ethereum finality can enter the Minted gallery.</p></section>`;
  }
  const tx = mint.explorerTransactionUrl && mint.txHash
    ? `<a href="${escapeHtml(mint.explorerTransactionUrl)}">${escapeHtml(mint.txHash)} ↗</a>`
    : `<span>${escapeHtml(mint.txHash ?? "Not available")}</span>`;
  const contract = mint.explorerContractUrl && mint.contract
    ? `<a href="${escapeHtml(mint.explorerContractUrl)}">${escapeHtml(mint.contract)} ↗</a>`
    : `<span>${escapeHtml(mint.contract ?? "Not available")}</span>`;
  // The DEV overlay explains simulated finality; a real Anvil network name stays
  // in the record so no local transaction is relabelled as an Ethereum event.
  const finality = fixtureMode || localChainRehearsal ? "Finalized" : escapeHtml(mint.finalityLabel ?? "Finalized");
  return `<section class="signature-provenance-section"><h2>Mint</h2><dl class="signature-facts"><div><dt>Initially minted to</dt><dd>${escapeHtml(mint.mintWallet ?? "")}</dd></div><div><dt>Current token holder</dt><dd>${escapeHtml(mint.currentTokenHolder ?? "")}</dd></div><div><dt>Network</dt><dd>${escapeHtml(mint.chainName ?? "Ethereum")}</dd></div><div><dt>Transaction</dt><dd>${tx}</dd></div><div><dt>Contract</dt><dd>${contract}</dd></div><div><dt>Token ID</dt><dd>${escapeHtml(mint.tokenId ?? "")}</dd></div><div><dt>Token URI</dt><dd>${escapeHtml(mint.tokenUri ?? "")}</dd></div><div><dt>Metadata SHA-256</dt><dd>${escapeHtml(mint.metadataSha256 ?? "")}</dd></div><div><dt>Finality</dt><dd>${finality}</dd></div><div><dt>Finalized at</dt><dd>${escapeHtml(mint.finalizedAt?.toISOString() ?? "")}</dd></div></dl><p>The contract record is irreversible. IPFS availability still depends on retention and pinning. A later token holder is not implied to control the claimant’s X account.</p></section>`;
}

export function signaturePage(signature: SignatureView, fixtureMode: boolean, mint?: SignatureMintView, publicOrigin = "", localChainRehearsal = false, withdrawal?: { csrfToken: string; claimInstanceId: string; requiresXConfirmation: boolean; allowed: boolean }, mintRecipientVerified = false): string {
  const handle = escapeHtml(signature.handleAtClaim);
  const gr0k = formatGr0k(signature.gr0kRaw);
  const mintSection = mint ? mintProvenance(mint, fixtureMode, localChainRehearsal) : "";
  const finalized = mint?.state === "finalized";
  const galleryTab: GalleryTab = finalized ? "minted" : "claimed";
  const claimedAt = escapeHtml(signature.claimedAt.toISOString());
  const claimTitle = "Claimed with explicit consent and account authentication.";
  const mintTitle = "Minted to the claimant’s verified recipient.";
  const mintTag = finalized
    ? `<span class="signature-tag" data-signature-status="minted" title="${mintTitle}">Minted</span>`
    : mint && mint.state !== "unminted" ? `<span class="signature-pending">${escapeHtml(signatureMintLabel(mint))}</span>` : "";
  const developmentNotes: NonNullable<LayoutOptions["developmentNotes"]> = [
    ...(fixtureMode ? [{ title: localChainRehearsal ? "Local claim record" : "Development claim fixture", paragraphs: [localChainRehearsal ? "This record is stored only in the local rehearsal. Seeded identities are simulated; interactive claims use the authentication provider configured when they were made. Changing providers does not upgrade historical claims. This is not a production gallery record." : `This development fixture records @${signature.handleAtClaim} at ${signature.xAuthenticatedAt.toISOString()}. It is not production X account provenance. The handle is used for demonstration only; no participation or endorsement is implied.`] }] : []),
    ...(mint && (fixtureMode || localChainRehearsal) ? [{ title: localChainRehearsal ? "Local development-chain provenance" : "Simulated chain provenance", paragraphs: localChainRehearsal
      ? ["This transaction and contract exist only on the repo-local Anvil chain. The local reconciler validates and promotes events against one node; this is not independent-provider agreement or proof of Ethereum finality.", `Local finality: ${mint.finalityLabel ?? "Automatic local promotion"}.${mint.finalizedAt ? ` Locally promoted at ${mint.finalizedAt.toISOString()}.` : " Awaiting automatic local promotion."}`]
      : ["This lifecycle was simulated locally. It is not an Ethereum record, transaction, deployment, or proof of finality.", mint.state === "finalized" ? "Fixture finality." : mint.state === "included_unfinalized" ? "Awaiting simulated finality." : `Simulated status: ${mint.label}.`] }] : []),
  ];
  const claimSection = `<section class="signature-provenance-section"><h2>Claim</h2><p>Grok origin is declared, not independently verified.</p><dl class="signature-facts"><div><dt>Handle at claim</dt><dd>${xProfileLink(signature.handleAtClaim)}</dd></div><div><dt>Claimed at</dt><dd>${claimedAt}</dd></div><div><dt>X authenticated at</dt><dd>${escapeHtml(signature.xAuthenticatedAt.toISOString())}</dd></div><div><dt>Signature ID</dt><dd>${escapeHtml(signature.signatureId)}</dd></div><div><dt>Account reference</dt><dd>${escapeHtml(signature.publicAccountId)}</dd></div></dl></section>`;
  const artworkSection = `<section class="signature-provenance-section"><h2>Artwork</h2><p>The SVG is the canonical artwork. The PNG is an immutable derivative used only for social link previews through <code>og:image</code>.</p><dl class="signature-facts"><div><dt>Artwork renderer</dt><dd>${escapeHtml(signature.rendererVersion)}</dd></div><div><dt>Canonical SVG SHA-256</dt><dd>${escapeHtml(signature.svgSha256)}</dd></div><div><dt>Social-image renderer</dt><dd>${escapeHtml(signature.cardRendererVersion)}</dd></div><div><dt>Social-image PNG SHA-256</dt><dd>${escapeHtml(signature.pngSha256)}</dd></div></dl></section>`;
  const withdrawAction = !withdrawal || finalized ? "" : !withdrawal.allowed
    ? '<div class="claim-withdrawal"><button class="auth-action auth-action-quiet" disabled title="Wait for the pending mint or authorization to resolve."><span>Withdraw claim</span></button></div>'
    : withdrawal.requiresXConfirmation
      ? `<details class="auth-disclosure claim-withdrawal" id="withdraw"><summary>Withdraw claim</summary><p>This removes the claim from Claimed and My Collection. You can make a new claim later.</p><form method="post" action="/auth/x/start" data-x-action-form><input type="hidden" name="purpose" value="sensitive_action"><input type="hidden" name="action" value="claim_withdraw"><input type="hidden" name="signature_id" value="${escapeHtml(signature.signatureId)}"><input type="hidden" name="claim_instance" value="${escapeHtml(withdrawal.claimInstanceId)}"><input type="hidden" name="csrf" value="${escapeHtml(withdrawal.csrfToken)}"><input type="hidden" name="return_to" value="/signatures/${escapeHtml(signature.signatureId)}"><button class="auth-action" type="submit"><span>Withdraw claim</span></button><p class="inline-feedback" data-x-action-feedback role="status" aria-live="polite"></p></form></details>`
      : `<section class="claim-withdrawal" id="withdraw" data-withdraw-control><details class="auth-disclosure"><summary>Withdraw claim</summary><p id="withdraw-description">This removes the claim from Claimed and My Collection. You can make a new claim later.</p><div data-withdraw-confirmation><h2 id="withdraw-title">Withdraw this claim?</h2><p id="withdraw-work">@${handle} · gr0k ${gr0k}</p><form method="post" action="/signatures/${escapeHtml(signature.signatureId)}/withdraw"><input type="hidden" name="csrf" value="${escapeHtml(withdrawal.csrfToken)}"><input type="hidden" name="claim_instance" value="${escapeHtml(withdrawal.claimInstanceId)}"><div class="auth-actions"><button class="auth-action auth-action-quiet" type="button" data-withdraw-cancel hidden><span>Cancel</span></button><button class="auth-action" type="submit" name="confirm" value="withdraw"><span>Confirm withdrawal</span></button></div></form></div></details></section>`;
  // The server supplies owner controls only when the X account ID matches.
  const mintTooltip = mint?.state === "authorized"
    ? "Review the mint and confirm the transaction in the wallet you selected."
    : mintRecipientVerified
      ? "Review the mint and confirm it in the wallet you verified to receive the token."
      : "Connect a wallet to receive the token. You’ll prove you control it, then review and confirm the mint.";
  const mintEntry = (withdrawal && (!mint || ["unminted", "authorized", "expired"].includes(mint.state))
    ? `<div class="signature-mint-entry"><a class="auth-action" href="/signatures/${escapeHtml(signature.signatureId)}/mint" data-action-tooltip="mint-tooltip" aria-describedby="mint-tooltip" title="${mintTooltip}"><span>Mint this signature →</span></a><span class="action-tooltip" id="mint-tooltip" role="tooltip" hidden>${mintTooltip}</span></div>` : "");
const body = `<a class="gallery-return" href="/?tab=${galleryTab}" title="Gallery" aria-label="Gallery">${HOME_ICON}</a><article class="signature-page" aria-labelledby="signature-heading"><div class="signature-sheet"><figure class="signature-art"><img src="/artifacts/${escapeHtml(signature.signatureId)}.svg" alt="Signature claimed as @${handle}"></figure><div class="signature-record"><div class="signature-heading"><h1 id="signature-heading">${xProfileLink(signature.handleAtClaim)}</h1><span class="signature-gr0k">gr0k ${gr0k}</span><div class="signature-tags" aria-label="Signature status"><span class="signature-tag" data-signature-status="claimed" title="${claimTitle}">Claimed</span>${mintTag}</div></div>${mintEntry}<div class="signature-tools"><details class="signature-provenance"><summary>Provenance</summary><div class="signature-provenance-body">${claimSection}${artworkSection}${mintSection}</div></details><a class="signature-svg" href="/artifacts/${escapeHtml(signature.signatureId)}.svg" title="Open canonical SVG" aria-label="Open canonical SVG">SVG ↗</a></div>${withdrawAction}</div></div></article>`;
  const artifactPath = `/artifacts/${signature.signatureId}.png`;
  return layout({ title: `@${signature.handleAtClaim} · signature`, description: fixtureMode ? `A development rehearsal signature for @${signature.handleAtClaim}.` : `A signature claimed via X by @${signature.handleAtClaim}.`, body, fixtureMode, localChainRehearsal, robots: !fixtureMode && finalized ? "index" : "noindex", ogImage: `${publicOrigin.replace(/\/$/, "")}${artifactPath}`, bookPage: true, developmentNotes, claimNoticeSignatureId: signature.signatureId });
}

export interface CollectionPageParams {
  currentHandle: string;
  signatures: SignatureView[];
  csrfToken: string;
  fixtureMode: boolean;
  mintEnabled: boolean;
  mintChainId: string;
  wallet?: WalletView | null;
  mintBySignature?: ReadonlyMap<string, CollectionMintView>;
  localOAuthMode?: boolean;
  localChainRehearsal?: boolean;
  walletLinkConfirmed?: boolean;
  walletRevokeConfirmed?: boolean;
  publicOrigin?: string;
  preview?: PagePreview;
}

/** Shared by empty public galleries, private collections, and signed-out visitors. */
function participationGuidance(params: { handle?: string; publicOrigin?: string } = {}): string {
  const prompt = grokPrompt(params.handle, params.publicOrigin);
  return `<section class="participation" data-grok-handoff aria-label="How to participate"><p class="grok-intro">To participate, ask Grok for your signature.</p><ol class="grok-steps" role="list"><li><span class="grok-step-label">Step 1:</span><div><div class="grok-step-action"><button class="auth-action" type="button" data-copy-grok-prompt hidden><span>Copy the prompt</span></button><noscript>Copy the prompt below.</noscript><span class="inline-feedback" data-copy-feedback role="status" aria-live="polite"></span></div><details class="auth-disclosure grok-prompt-disclosure"><summary>View prompt</summary><label class="visually-hidden" for="grok-prompt">Your prompt</label><textarea class="grok-prompt" id="grok-prompt" data-grok-prompt readonly rows="10" spellcheck="false">${escapeHtml(prompt)}</textarea></details></div></li><li><span class="grok-step-label">Step 2:</span><div class="grok-step-copy"><a class="auth-action" href="${GROK_URL}" target="_blank" rel="noopener noreferrer"><span>Paste into Grok</span><span class="grok-step-arrow" aria-hidden="true">↗</span></a></div></li></ol></section>`;
}

export function collectionPage(params: CollectionPageParams): string {
  const developmentTools: string[] = [];
  if ((params.localOAuthMode ?? params.fixtureMode) && params.signatures.length === 0) {
    developmentTools.push(`<section class="rehearsal-page-note"><h2>Sample preview</h2><p>This gr0k is a fixture value, not an Agent’s reading. Opening the preview creates no claim.</p><a class="grok-local-sample" href="/s/${escapeHtml(params.currentHandle)}/37">Use a local sample instead →</a></section>`);
  }
  const cards = params.signatures.length === 0
    ? `<div class="collection-empty"><h2>No claimed signatures yet.</h2>${participationGuidance({ handle: params.currentHandle, publicOrigin: params.publicOrigin })}</div>`
    : params.signatures.map((signature) => {
      const mint = params.mintBySignature?.get(signature.signatureId) ?? { state: "unminted", label: "Not minted" };
      // The shared watermark qualifies the environment; cards show lifecycle only.
      const displayLabel = ({ finalized: "Minted", submitted: "Submitted", included_unfinalized: "Confirming" }[mint.state] ?? mint.label);
      const mintHref = params.preview ? `/dev/collection-states?state=${escapeHtml(params.preview.state)}&amp;view=mint` : `/signatures/${escapeHtml(signature.signatureId)}/mint`;
      const action = ["unminted", "expired"].includes(mint.state) || params.localChainRehearsal && mint.state === "authorized"
        ? `<a class="auth-action" href="${mintHref}"><span>Mint this signature →</span></a>`
        : mint.state === "finalized"
          ? ""
          : "";
      const transaction = mint.txHash
        ? mint.explorerTransactionUrl
          ? `<a href="${escapeHtml(mint.explorerTransactionUrl)}">Transaction · ${escapeHtml(shortAddress(mint.txHash))} ↗</a>`
          : `<span>Transaction · ${escapeHtml(shortAddress(mint.txHash))}</span>`
        : "";
      const token = mint.state === "finalized" && mint.tokenId
        ? mint.explorerTokenUrl
          ? `<a href="${escapeHtml(mint.explorerTokenUrl)}">Token ID ${escapeHtml(mint.tokenId)} ↗</a>`
          : `<span>Token ID ${escapeHtml(mint.tokenId)}</span>`
        : "";
      const holder = mint.state === "finalized" && mint.currentTokenHolder
        ? `<span>Current holder · ${escapeHtml(shortAddress(mint.currentTokenHolder))}</span>`
        : "";
      const chainDetails = transaction || token || holder
        ? `<details class="auth-disclosure collection-provenance"><summary>Provenance</summary><div class="mint-card-detail">${transaction}${token}${holder}${params.preview ? "" : `<a class="auth-action auth-action-quiet" href="/signatures/${escapeHtml(signature.signatureId)}"><span>View chain provenance →</span></a>`}</div></details>`
        : "";
      const localTransfer = !params.preview && params.localChainRehearsal && params.mintEnabled && mint.state === "finalized" && mint.tokenId && params.wallet?.address.toLowerCase() === LOCAL_TEST_WALLET.toLowerCase() && mint.currentTokenHolder?.toLowerCase() === LOCAL_TEST_WALLET.toLowerCase()
        ? `<details class="auth-disclosure"><summary>Local transfer</summary><div class="mint-card-detail"><span>Transfer to second local TEST wallet · ${LOCAL_TEST_RECIPIENT}</span><button type="button" class="auth-action" data-local-transfer data-signature-id="${escapeHtml(signature.signatureId)}" data-token-id="${escapeHtml(mint.tokenId)}" data-owner="${LOCAL_TEST_WALLET}" data-recipient="${LOCAL_TEST_RECIPIENT}" data-csrf="${escapeHtml(params.csrfToken)}"><span>Transfer local token →</span></button><p data-transfer-feedback role="status" aria-live="polite"></p></div></details>`
        : "";
      const advance = !params.preview && params.fixtureMode && !params.localChainRehearsal && ["authorized", "submitted", "included_unfinalized"].includes(mint.state)
        ? `<button class="auth-action" type="button" data-advance-rehearsal data-signature-id="${escapeHtml(signature.signatureId)}" data-csrf="${escapeHtml(params.csrfToken)}"><span>Advance rehearsal →</span></button>` : "";
      if (advance || localTransfer) developmentTools.push(`<section class="rehearsal-page-note"><h2>@${escapeHtml(signature.handleAtClaim)} · gr0k ${formatGr0k(signature.gr0kRaw)}</h2>${advance}${localTransfer}</section>`);
      // Broadcasting is not itself projection evidence: a just-submitted mint
      // can still be "authorized" until the first reconciler observation.
      const pending = !params.preview && params.localChainRehearsal && ["authorized", "submitted", "included_unfinalized", "validation_pending"].includes(mint.state) ? ` data-local-mint-pending data-signature-id="${escapeHtml(signature.signatureId)}" data-mint-state="${escapeHtml(mint.state)}"` : "";
      const cardOpen = params.preview ? "" : `<a class="signature-art-link" href="/signatures/${escapeHtml(signature.signatureId)}">`;
      const image = params.preview ? "/dev/collection-states/artwork.svg" : `/artifacts/${escapeHtml(signature.signatureId)}.svg`;
      return `<article class="collection-card"${pending}><div class="signature-card">${cardOpen}<img src="${image}" alt="Signature claimed as @${escapeHtml(signature.handleAtClaim)}">${params.preview ? "" : "</a>"}<div><strong>${xProfileLink(signature.handleAtClaim)}</strong><span>gr0k ${formatGr0k(signature.gr0kRaw)}</span><time datetime="${escapeHtml(signature.claimedAt.toISOString())}">${escapeHtml(signature.claimedAt.toISOString().slice(0, 10))}</time></div></div><div class="mint-card-foot"><span class="signature-tag">${escapeHtml(displayLabel)}</span>${action}</div>${chainDetails}</article>`;
    }).join("");
  const body = `${HOME_LINK}<section class="collection-page" aria-label="Private account collection"><div class="collection-intro"><div class="signature-heading"><h1>My Collection</h1><span class="auth-note">${xProfileLink(params.currentHandle)}</span></div></div><section class="collection-grid" aria-label="Your claimed signatures">${cards}</section></section>`;
  return layout({ title: `@${params.currentHandle} · My collection`, description: params.localChainRehearsal ? "Durable local claims, real Anvil mints and transfers, and automatic local event projection." : "Your claimed signatures and Ethereum mint status.", body, fixtureMode: params.fixtureMode, localChainRehearsal: params.localChainRehearsal, robots: "noindex", bookPage: true, accountPanel: { ...params, previewOnly: Boolean(params.preview) }, grokHandoff: params.signatures.length === 0, preview: params.preview, developmentTools: developmentTools.join(""), localOAuthMode: params.localOAuthMode ?? params.fixtureMode, developmentNotes: localIdentityNotes(params.localOAuthMode ?? params.fixtureMode) });
}

export type MintEntryStage = "sign-in" | "wrong-account" | "paused" | "pending";

/** Read-only gate for the states the mint page itself cannot resolve. */
export function mintEntryPage(params: {
  signature: SignatureView;
  stage: MintEntryStage;
  account: AccountPanelView;
  statusLabel?: string;
  pendingElsewhere?: boolean;
  preview?: PagePreview;
}): string {
  const { signature, stage, account, preview } = params;
  const localOAuth = account.localOAuthMode ?? account.fixtureMode;
  const returnTo = `/signatures/${signature.signatureId}/mint`;
  const needsIdentity = ["sign-in", "wrong-account"].includes(stage);
  const message = {
    "sign-in": "Sign in with the X account that originally claimed this signature.",
    "wrong-account": "This signature belongs to another X account. Switch to the original claimant to continue.",
    paused: "Minting is paused. Your claim remains available; no wallet action is needed until minting resumes.",
    pending: params.pendingElsewhere ? "Another mint is still pending. Finish or resolve it before choosing a recipient for this signature." : "This mint is awaiting confirmation or verification. No new mint can be started while it is being resolved.",
  }[stage];
  const signInLabel = stage === "wrong-account" ? "Switch X account" : "Sign in with X";
  const action = needsIdentity
    ? `<form class="auth-actions" method="post" action="/auth/x/start"><input type="hidden" name="purpose" value="account_login"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><button class="auth-action" type="submit"><span>${signInLabel}</span></button></form>`
    : `<div class="auth-actions"><button class="auth-action" type="button" disabled><span>${stage === "paused" ? "Minting paused" : "Await mint verification"}</span></button></div>`;
  const artwork = preview ? "/dev/collection-states/artwork.svg" : `/artifacts/${escapeHtml(signature.signatureId)}.svg`;
  const back = preview ? `/dev/collection-states?state=${escapeHtml(preview.state)}` : `/signatures/${escapeHtml(signature.signatureId)}`;
  const content = `<h1>Mint this signature</h1><div class="signature-heading"><span>${xProfileLink(signature.handleAtClaim)}</span><span class="signature-gr0k">gr0k ${formatGr0k(signature.gr0kRaw)}</span></div><img class="mint-entry-art" src="${artwork}" alt="Signature claimed as @${escapeHtml(signature.handleAtClaim)}"><p>${escapeHtml(message)}</p>${params.statusLabel && !params.pendingElsewhere ? `<p class="auth-note">${escapeHtml(params.statusLabel)}</p>` : ""}${preview ? `<fieldset class="preview-controls" disabled>${action}</fieldset>` : action}<p class="auth-note">Minting is optional. Only an explicit authorization and wallet transaction can mint the work.</p><a class="auth-action auth-action-quiet" href="${back}"><span>Back to signature →</span></a>`;
  return authPage({ title: `Mint @${signature.handleAtClaim} signature`, description: "Sign in as the original claimant to mint this signature.", body: `<div data-mint-entry="${stage}">${content}</div>`, fixtureMode: account.fixtureMode, localChainRehearsal: account.localChainRehearsal, accountPanel: { ...account, mintRecipientConfirmed: false, previewOnly: Boolean(preview) }, preview, localOAuthMode: localOAuth, developmentNotes: localIdentityNotes(localOAuth) });
}

/** The single mint page: the exact work, its recipient, and the one authorization.
 * The recipient is absent until a fresh wallet proof exists for this exact mint;
 * the authorization form renders only once it does. */
export function mintPage(params: {
  signature: SignatureView;
  currentHandle: string;
  account: AccountPanelView;
  wallet?: WalletView | null;
  walletBindingId?: string;
  /** An unresolved authorization must keep its exact recipient. */
  resumeAuthorization?: boolean;
  claimInstanceId: string;
  csrfToken: string;
  chainName: string;
  metadataUri: string;
  metadataSha256: string;
  signatureDigest: string;
  tokenUriHash: string;
  contract: string;
  fixtureMode: boolean;
  localChainRehearsal?: boolean;
  preview?: PagePreview;
}): string {
  const { signature, account, preview } = params;
  const wallet = params.wallet;
  const recipientReady = Boolean(wallet && params.walletBindingId);
  const signatureId = escapeHtml(signature.signatureId);
  const handleChanged = params.currentHandle.toLowerCase() !== signature.handleAtClaim.toLowerCase()
    ? `<div><dt>Current X handle</dt><dd>${xProfileLink(params.currentHandle)}</dd></div>`
    : "";
  const rehearsalPermanence = params.localChainRehearsal
    ? "This submits a real transaction on your repo-local Anvil chain using test ETH. Wallet proofs and contract events are real local cryptographic operations. X identity is emulated, IPFS artifacts stay local, and automatic local promotion is not Ethereum finality. Production blockchain records cannot be deleted and published IPFS copies may remain available."
    : params.fixtureMode
    ? "This screen rehearses the permanent production disclosure: in production, Blockchain records cannot be deleted and IPFS copies may remain available. Here, the local wallet, IPFS, Ethereum transaction, and finality records are simulated and publish nothing."
    : "Minting permanently publishes a link among this historical X handle, signature, opaque account reference, wallet address, and Ethereum transaction. Blockchain records cannot be deleted. IPFS copies may remain available even if signatures.gallery later removes its own listing or pins.";
  const permanence = "Minting permanently publishes a link among this historical X handle, signature, opaque account reference, wallet address, and Ethereum transaction. Blockchain records cannot be deleted. IPFS copies may remain available even if signatures.gallery later removes its own listing or pins.";
  const usesLocalTestWallet = recipientReady && Boolean(params.localChainRehearsal) && wallet!.address.toLowerCase() === LOCAL_TEST_WALLET.toLowerCase();
  const changeRecipient = params.resumeAuthorization ? "" : `<a class="auth-action auth-action-quiet mint-recipient-change" href="/signatures/${signatureId}/mint?recipient=change"><span>Change recipient</span></a>`;
  const authorizeLabel = params.resumeAuthorization ? "Confirm in wallet" : "Authorize mint";
  // The recipient cell carries its own control: connecting a wallet is a step
  // inside this mint, never a separate page the claimant has to pass through.
  const recipientCell = recipientReady
    ? `<span class="mint-recipient-address">${escapeHtml(wallet!.address)}</span>${changeRecipient}`
    : `<p class="mint-recipient-hint">The wallet that will receive the token. You sign a one-time message to prove you control it; no transaction is sent.</p>${preview ? `<fieldset class="preview-controls" disabled>${walletLinkControls(account)}</fieldset>` : walletLinkControls(account)}`;
  const facts = `<dl class="facts"><div><dt>Signature</dt><dd>${xProfileLink(signature.handleAtClaim)} · gr0k ${formatGr0k(signature.gr0kRaw)}</dd></div>${handleChanged}<div><dt>Recipient</dt><dd>${recipientCell}</dd></div><div><dt>Network</dt><dd>${escapeHtml(params.chainName)}</dd></div><div><dt>Cost</dt><dd>No project fee. Your wallet estimates network gas before you confirm.</dd></div></dl>`;
  // Hashes and URIs verify the exact work; they are not what the claimant
  // decides on, so they open on request instead of filling the page.
  const verification = `<details class="auth-disclosure mint-verification"><summary>Verification details</summary><dl class="facts"><div><dt>Handle at claim</dt><dd>${xProfileLink(signature.handleAtClaim)}</dd></div><div><dt>Renderer</dt><dd>${escapeHtml(signature.rendererVersion)}</dd></div><div><dt>SVG SHA-256</dt><dd>${escapeHtml(signature.svgSha256)}</dd></div><div><dt>Metadata URI preview</dt><dd>${escapeHtml(params.metadataUri)}</dd></div><div><dt>Metadata SHA-256</dt><dd>${escapeHtml(params.metadataSha256)}</dd></div></dl><p class="trust-copy">The verified recipient will submit the transaction and initially receive the token. The token is transferable. Grok origin is declared, not independently verified.</p></details>`;
  const consent = `<label class="consent-line"><input required type="checkbox" name="permanence_acknowledged" value="yes"> I understand the public and irreversible record described above.</label><button class="auth-action" type="submit"><span>${authorizeLabel}</span></button>`;
  const form = recipientReady
    ? `<form id="mint-authorization" class="mint-authorization-form" data-local-chain-rehearsal="${params.localChainRehearsal === true}" data-local-wallet="${Boolean(usesLocalTestWallet)}" method="post" action="/api/v2/signatures/${signatureId}/mint-authorizations" data-signature-id="${signatureId}" data-signature-digest="${escapeHtml(params.signatureDigest)}" data-wallet="${escapeHtml(wallet!.address)}" data-recipient="${escapeHtml(wallet!.address)}" data-wallet-binding-id="${escapeHtml(params.walletBindingId!)}" data-claim-instance-id="${escapeHtml(params.claimInstanceId)}" data-chain-id="${escapeHtml(wallet!.chainId)}" data-contract="${escapeHtml(params.contract)}" data-svg-sha256="${escapeHtml(signature.svgSha256)}" data-png-sha256="${escapeHtml(signature.pngSha256)}" data-metadata-sha256="${escapeHtml(params.metadataSha256)}" data-token-uri="${escapeHtml(params.metadataUri)}" data-token-uri-hash="${escapeHtml(params.tokenUriHash)}"><input type="hidden" name="csrf" value="${escapeHtml(params.csrfToken)}">${preview ? `<fieldset class="preview-controls" disabled>${consent}</fieldset>` : consent}</form><p class="inline-feedback" data-mint-feedback role="status" aria-live="polite"></p><noscript><p class="fine-print">JavaScript is required to verify the authorization and ask your wallet to submit the mint.</p></noscript>`
    : "";
  const artwork = preview ? "/dev/collection-states/artwork.svg" : `/artifacts/${signatureId}.svg`;
  const heading = params.resumeAuthorization ? "Complete this mint." : recipientReady ? "Authorize this exact work." : "Mint this exact work.";
  const body = `<section class="mint-review"${params.localChainRehearsal ? " data-local-chain-rehearsal" : ""}${recipientReady ? "" : ' data-mint-entry="wallet"'}><div class="mint-art"><div class="art-label"><span>EXACT V1 ARTWORK</span><span>${escapeHtml(signature.signatureId.slice(0, 13))}…</span></div><img src="${artwork}" alt="Exact stored signature for @${escapeHtml(signature.handleAtClaim)}"></div><article class="mint-review-copy"><p class="eyebrow">Mint</p><h1>${heading}</h1>${facts}${verification}<div class="notice permanence"><strong>This publication cannot be undone</strong><p>${permanence}</p></div>${form}<a class="quiet-link" href="/me">Cancel and return to my collection</a></article></section>`;
  return layout({ title: `Mint @${signature.handleAtClaim} signature`, description: params.localChainRehearsal ? "Review and submit the exact claimed signature on the local Anvil chain." : "Review and authorize the exact claimed signature for Ethereum minting.", body, fixtureMode: params.fixtureMode, localChainRehearsal: params.localChainRehearsal, robots: "noindex", accountPanel: { ...account, mintRecipientConfirmed: !recipientReady && account.mintRecipientConfirmed, previewOnly: Boolean(preview) }, preview, localOAuthMode: account.localOAuthMode ?? account.fixtureMode, developmentTools: usesLocalTestWallet ? '<section class="rehearsal-page-note" data-dev-mint-controls><h2>Local wallet mint</h2><p>First acknowledge the publication disclosure on the page, then use the TEST wallet below. Anvil 31337 only; never send real funds.</p><button class="auth-action" type="submit" form="mint-authorization" data-wallet-provider="local"><span>Authorize with local TEST wallet</span></button><p data-mint-feedback role="status" aria-live="polite"></p></section>' : "", developmentNotes: [...(params.fixtureMode || params.localChainRehearsal ? [{ title: "Mint rehearsal", paragraphs: [rehearsalPermanence] }] : []), ...localIdentityNotes(account.localOAuthMode ?? account.fixtureMode)] });
}

export function signInRequiredPage(fixtureMode: boolean, localOAuthMode = fixtureMode, localChainRehearsal = false, preview?: PagePreview, publicOrigin?: string): string {
  const action = `<form class="auth-actions" method="post" action="/auth/x/start"><input type="hidden" name="purpose" value="account_login"><button class="auth-action" type="submit"${preview ? " disabled" : ""}><span>Sign in with X</span></button></form>`;
  const explanation = "Your collection is grouped by your numeric X account ID, not by a changeable handle.";
  return authPage({ collection: true, title: "Sign in · Signatures Gallery", description: "Sign in to view your collection.", fixtureMode, localChainRehearsal, preview, grokHandoff: true, localOAuthMode, developmentNotes: localIdentityNotes(localOAuthMode), accountPanel: preview ? { fixtureMode, localOAuthMode, mintEnabled: true, mintChainId: "31337", previewOnly: true } : undefined, body: `<div class="collection-intro"><div class="signature-heading"><h1>My Collection</h1></div></div><div class="signed-out-participation">${participationGuidance({ publicOrigin })}</div><section class="signed-out-access" aria-label="Access your collection"><p class="auth-note">Already have a collection?</p>${action}<details class="auth-disclosure"><summary>About sign-in</summary><p>${explanation}</p></details></section>` });
}

export function errorPage(status: number, code: string, message: string, fixtureMode = false, localOAuthMode = fixtureMode, localChainRehearsal = false, returnTo?: string): string {
  const signIn = code === "AUTH_REQUIRED" || code === "AUTH_EXPIRED"
    ? `<form method="post" action="/auth/x/start"><input type="hidden" name="purpose" value="account_login">${returnTo ? `<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">` : ""}<button class="auth-action" type="submit"><span>Sign in with X</span></button></form>`
    : "";
  const localMessage: Record<string, string> = {
    LOCAL_OAUTH_DENIED: "Sign-in was cancelled. Start again when you are ready.",
    LOCAL_OAUTH_UNAVAILABLE: "Sign-in could not be completed. Please try again.",
    LOCAL_OAUTH_REQUEST_INVALID: "This sign-in request is invalid or expired. Start sign-in again.",
    AUTH_REQUIRED: "Session expired. Sign in to continue.",
    AUTH_EXPIRED: "Session expired. Sign in to continue.",
    INVALID_OAUTH_STATE: "This sign-in request is invalid or expired. Start sign-in again.",
  };
  const productMessage = localOAuthMode ? localMessage[code] ?? message : message;
  const developmentError = localOAuthMode && code.startsWith("LOCAL_");
  const developmentNotes = [...localIdentityNotes(localOAuthMode), ...(developmentError || productMessage !== message ? [{ title: "Authentication test details", paragraphs: [code, message] }] : [])];
  const details = developmentError ? "" : `<details class="auth-disclosure"><summary>Details</summary><p>${escapeHtml(code)}</p></details>`;
  const body = `<h1>${status}</h1><p>${escapeHtml(productMessage)}</p><div class="auth-actions">${signIn}<a class="auth-action auth-action-quiet" href="${returnTo ? escapeHtml(returnTo) + (code === "X_ACTION_CONFIRMATION_REQUIRED" ? "#withdraw" : "") : "/"}"><span>${returnTo ? "Back to signature" : "Return home"}</span></a></div>${details}`;
  return authPage({ title: `${status} · ${code}`, description: productMessage, body, fixtureMode, localChainRehearsal, localOAuthMode, developmentNotes });
}

export function localOAuthAuthorizePage(params: { requestId: string; accounts: readonly { key: string; username: string; displayName: string }[]; localChainRehearsal?: boolean }): string {
  const accounts = params.accounts.map((account, index) => `<label class="auth-account"><input type="radio" name="account" value="${escapeHtml(account.key)}"${index === 0 ? " checked" : ""}><span><span class="auth-account-handle">@${escapeHtml(account.username)}</span><span class="auth-note">${escapeHtml(account.displayName)}</span></span></label>`).join("");
  const body = `<h1>Choose an account.</h1><form method="post" action="/dev/oauth/x/authorize"><input type="hidden" name="request" value="${escapeHtml(params.requestId)}"><fieldset class="auth-accounts"><legend class="visually-hidden">Simulated accounts</legend>${accounts}</fieldset><div class="auth-actions"><button class="auth-action" type="submit" name="decision" value="approve"><span>Approve local identity</span></button></div><details class="auth-disclosure"><summary>Test another outcome</summary><div class="auth-actions"><button class="auth-action auth-action-quiet" type="submit" name="decision" value="deny"><span>Simulate account denial</span></button><button class="auth-action auth-action-quiet" type="submit" name="decision" value="provider_error"><span>Simulate provider error</span></button></div></details></form>`;
  return authPage({ title: "Local OAuth emulator · Signatures Gallery", description: "Choose a simulated identity for the local OAuth rehearsal.", body: "", developmentTools: `<section class="rehearsal-page-note"><h2>X sign-in simulator</h2>${body}</section>`, developmentOpen: true, fixtureMode: true, localChainRehearsal: params.localChainRehearsal, developmentNotes: [{ title: "Local OAuth emulator", paragraphs: ["These accounts are simulated. This page behaves like an OAuth provider consent step, but it is part of the local development server. It does not open X, contact X, or prove control of any X account.", "Redirects, one-time state, PKCE, callback handling, identity lookup, session rotation, denial, and provider-error paths."] }] });
}

export function gonePage(fixtureMode = false, localChainRehearsal = false): string {
  return errorPage(410, "LEGACY_ROUTE_RETIRED", "This legacy signature route has been retired. Start again with the private Grok instructions.", fixtureMode, fixtureMode, localChainRehearsal);
}
