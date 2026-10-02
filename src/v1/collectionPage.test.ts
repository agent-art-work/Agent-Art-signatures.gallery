import { describe, expect, it } from "vitest";
import { LOCAL_TEST_RECIPIENT, LOCAL_TEST_WALLET } from "../local/wallet.js";
import { collectionPage, signInRequiredPage, type CollectionMintView, type SignatureView } from "./pages.js";
import { SITE_CSS } from "./siteCss.js";

const signature: SignatureView = {
  signatureId: `sg1_${"c".repeat(52)}`,
  handleAtClaim: "old_handle",
  gr0kRaw: 37,
  rendererVersion: "artwork/1",
  svgSha256: "d".repeat(64),
  pngSha256: "e".repeat(64),
  cardRendererVersion: "social-card/1",
  xAuthenticatedAt: new Date("2026-09-01T09:00:00.000Z"),
  claimedAt: new Date("2026-09-01T09:01:00.000Z"),
  publicAccountId: "opaque-account-reference",
};
const wallet = {
  address: LOCAL_TEST_WALLET,
  chainId: "31337",
  chainName: "Local Anvil",
  provedAt: new Date("2026-09-02T10:00:00.000Z"),
};
const base = {
  currentHandle: "alice",
  signatures: [signature],
  csrfToken: "collection-csrf",
  fixtureMode: false,
  mintEnabled: true,
  mintChainId: "1",
  walletLinkConfirmed: true,
  walletRevokeConfirmed: true,
};
const local = { ...base, fixtureMode: true, localOAuthMode: true, localChainRehearsal: true, mintChainId: "31337", wallet };
const finalized: CollectionMintView = {
  state: "finalized",
  label: "Minted on Ethereum",
  txHash: `0x${"3".repeat(64)}`,
  tokenId: "12345678901234567890123456789012345678901234567890",
  currentTokenHolder: LOCAL_TEST_WALLET,
  explorerTransactionUrl: `https://etherscan.io/tx/0x${"3".repeat(64)}`,
  explorerTokenUrl: "https://etherscan.io/token/example?a=123",
};

function body(html: string): string {
  return html.slice(html.indexOf("<body"));
}

/** Extract complete disclosures, including nested ones, without a DOM dependency. */
function disclosures(html: string): string[] {
  const stack: number[] = [];
  const result: string[] = [];
  for (const match of html.matchAll(/<details\b[^>]*>|<\/details>/g)) {
    if (match[0].startsWith("</")) {
      const start = stack.pop();
      if (start !== undefined) result.push(html.slice(start, match.index + match[0].length));
    } else {
      stack.push(match.index);
    }
  }
  return result;
}

function closedDisclosureWith(html: string, content: string): string {
  const found = disclosures(html).find((candidate) => candidate.includes(content));
  expect(found, `Expected ${content} inside a native disclosure`).toBeDefined();
  expect(found!.slice(0, found!.indexOf(">") + 1)).not.toMatch(/\sopen(?:\s|=|>)/);
  return found!;
}

function visibleBody(html: string): string {
  let visible = body(html);
  for (const disclosure of disclosures(visible).sort((a, b) => b.length - a.length)) {
    const summary = disclosure.match(/^<details\b[^>]*>\s*(<summary\b[^>]*>[\s\S]*?<\/summary>)/)?.[1] ?? "";
    visible = visible.replace(disclosure, summary);
  }
  return visible;
}

function buttonWith(html: string, hook: string): string {
  const found = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map((match) => match[0])
    .find((candidate) => candidate.includes(hook));
  expect(found, `Expected a native button with ${hook}`).toBeDefined();
  expect(found).toMatch(/class="[^\"]*\bauth-action\b/);
  return found!;
}

describe("minimal My Collection", () => {
  it.each([
    ["signed out", () => signInRequiredPage(false)],
    ["signed in", () => collectionPage(base)],
  ] as const)("provides an icon-only Gallery link and home destination when %s", (_name, render) => {
    const html = render();
    const home = [...body(html).matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)]
      .map((match) => match[0])
      .find((link) => /class="[^\"]*\bgallery-return\b/.test(link));
    expect(home).toBeDefined();
    expect(home).toContain('href="/"');
    expect(home).toContain('aria-label="Gallery"');
    expect(home).not.toMatch(/>Home</);
    expect(home).toContain('class="home-icon"');
    expect(home).toContain('title="Gallery"');
    expect(home).not.toContain("←");
    expect(visibleBody(html)).toContain(home!);
  });

  it("uses the gallery canvas and heading without the previous wallet panels", () => {
    const html = collectionPage(local);
    expect(html).toContain('<body class="book-page">');
    expect(html).toMatch(/class="collection-page(?:\s[^\"]*)?"/);
    expect(html).toMatch(/<h1\b[^>]*>My Collection<\/h1>/);
    expect(visibleBody(html)).toContain("@alice");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(SITE_CSS).toContain("body,body :not(svg,svg *){font-size:var(--ui-font-size);font-weight:var(--ui-font-weight)}");
    expect(body(html)).not.toMatch(/class="(?:wallet-card|eyebrow|button)(?:\s|\")/);
  });

  it("retains the logout POST and escaped CSRF token in a compact native button", () => {
    const html = collectionPage({ ...base, csrfToken: 'csrf"<&' });
    const logout = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)]
      .map((match) => match[0]).find((form) => form.includes('action="/auth/logout"'));
    expect(logout).toMatch(/^<form\b[^>]*method="post"/);
    expect(logout).toContain('name="csrf" value="csrf&quot;&lt;&amp;"');
    expect(buttonWith(logout!, "Log out")).toContain('type="submit"');
  });

  it("keeps the title row full-width and aligned with the artwork grid", () => {
    const intro = SITE_CSS.match(/\.collection-intro\{([^}]*)\}/)![1];
    expect(intro).toContain("width:100%");
    expect(intro).not.toMatch(/max-width|margin|padding/);
    const html = collectionPage(base);
    expect(html).toContain('<div class="collection-intro"><div class="signature-heading"><h1>My Collection</h1>');
    expect(html).toContain('</div></div><section class="collection-grid"');
  });

  it("keeps the claim-time identity, exact SVG, gr0k and detail route for each work", () => {
    const html = collectionPage(base);
    expect(html.match(/<article\b[^>]*class="collection-card"/g)).toHaveLength(1);
    expect(html).toContain(`href="/signatures/${signature.signatureId}"`);
    expect(html).toContain(`src="/artifacts/${signature.signatureId}.svg"`);
    expect(html).not.toContain(`src="/artifacts/${signature.signatureId}.png"`);
    expect(html).toContain("@old_handle");
    expect(html).toContain("gr0k 37");
    expect(html).toContain("2026-09-01");
  });

  it("keeps identity and key warnings in DEV, outside the product account panel", () => {
    const html = collectionPage(local);
    expect(visibleBody(html)).toContain('class="rehearsal-watermark"');
    const panel = html.slice(html.indexOf('class="account-panel"'), html.indexOf('<section class="collection-page"'));
    expect(panel).not.toMatch(/No X account (?:was |is )?authenticated|Public test keys|Never send real funds/i);
    const overlay = html.slice(html.indexOf('<aside class="rehearsal-watermark"'));
    expect(overlay).toContain("No X account was authenticated");
    expect(overlay).toContain("Public test keys. Never send real funds.");
  });

  it("does not offer either local or injected wallet setup from My Collection", () => {
    const html = collectionPage({ ...local, wallet: null });
    expect(html).not.toContain("data-link-wallet");
    expect(html).not.toContain("data-wallet-provider");
    expect(html).not.toContain("data-wallet-feedback");
    expect(html).toContain(`href="/signatures/${signature.signatureId}/mint"`);
  });

  it("does not expose saved recipient records or global replace/revoke controls", () => {
    const html = collectionPage(local);
    expect(html).not.toContain('data-mode="replace"');
    expect(html).not.toContain("data-revoke-wallet");
    expect(html).not.toContain("Wallet details");
    expect(html).not.toContain(wallet.provedAt.toISOString());
    expect(html).not.toContain(wallet.address);
    expect(html).toContain('action="/auth/logout"');
  });

  it.each([false, true])("keeps wallet setup mint-only outside local Anvil (fixture=%s)", (fixtureMode) => {
    const html = collectionPage({ ...base, fixtureMode });
    expect(html).not.toContain("data-link-wallet");
    expect(html).not.toContain("data-wallet-provider");
    expect(html).toContain(`href="/signatures/${signature.signatureId}/mint"`);
    expect(html).not.toContain("data-local-chain-rehearsal");
  });

  it.each([null, wallet])("preserves read-only claims while minting is paused (wallet=%s)", (linkedWallet) => {
    const html = collectionPage({ ...local, wallet: linkedWallet, mintEnabled: false, mintBySignature: new Map([[signature.signatureId, finalized]]) });
    expect(visibleBody(html)).toContain("My Collection");
    expect(html).not.toContain("Wallet details");
    expect(html).toContain(`href="/signatures/${signature.signatureId}"`);
    expect(html).not.toContain(`href="/signatures/${signature.signatureId}/mint"`);
    for (const hook of ["data-link-wallet", "data-revoke-wallet", "data-local-transfer"]) expect(html).not.toContain(hook);
  });

  it.each(["unminted", "authorized", "expired"])("retains local mint/retry navigation for %s", (state) => {
    const mintBySignature = new Map([[signature.signatureId, { state, label: state }]]);
    expect(collectionPage({ ...local, mintBySignature })).toContain(`href="/signatures/${signature.signatureId}/mint"`);
    expect(collectionPage({ ...local, mintBySignature, wallet: null })).toContain(`href="/signatures/${signature.signatureId}/mint"`);
  });

  it.each([{}, { wallet: null }, { walletLinkConfirmed: false }, { mintEnabled: false }])("exposes the next mint step even with missing prerequisites: %j", (overrides) => {
    const html = collectionPage({ ...base, ...overrides });
    const main = html.match(/<main>[\s\S]*?<\/main>/)![0];
    expect(main).toContain(`href="/signatures/${signature.signatureId}/mint"`);
    expect(main).toContain("Mint this signature →");
    expect(main).not.toContain('class="mint-authorization-form"');
  });

  it.each(["authorized", "submitted", "included_unfinalized", "validation_pending"])("keeps %s polling attached to the correct collection article", (state) => {
    const html = collectionPage({ ...local, mintBySignature: new Map([[signature.signatureId, { state, label: state }]]) });
    const article = html.match(/<article\b[^>]*class="collection-card"[^>]*>/)?.[0];
    expect(article).toContain("data-local-mint-pending");
    expect(article).toContain(`data-signature-id="${signature.signatureId}"`);
    expect(article).toContain(`data-mint-state="${state}"`);
    expect(html).not.toContain("data-advance-rehearsal");
  });

  it("keeps complete finalized transaction, token and holder references inside closed details", () => {
    const html = collectionPage({ ...base, wallet, mintBySignature: new Map([[signature.signatureId, finalized]]) });
    const details = closedDisclosureWith(html, finalized.tokenId!);
    expect(details).toContain(`href="${finalized.explorerTransactionUrl}"`);
    expect(details).toContain(`href="${finalized.explorerTokenUrl}"`);
    expect(details).toContain("Current holder");
    expect(visibleBody(html)).not.toContain(finalized.tokenId!);
    expect(html).toContain(`href="/signatures/${signature.signatureId}"`);
  });

  it("preserves the fixed local transfer inputs and a sibling live feedback target", () => {
    const html = collectionPage({ ...local, mintBySignature: new Map([[signature.signatureId, finalized]]) });
    const transfer = buttonWith(html, "data-local-transfer");
    for (const attribute of [
      `data-signature-id="${signature.signatureId}"`,
      `data-token-id="${finalized.tokenId}"`,
      `data-owner="${LOCAL_TEST_WALLET}"`,
      `data-recipient="${LOCAL_TEST_RECIPIENT}"`,
      'data-csrf="collection-csrf"',
    ]) expect(transfer).toContain(attribute);
    closedDisclosureWith(html, "data-local-transfer");
    expect(html).toMatch(/data-local-transfer[^>]*>[\s\S]*?<\/button>\s*<p\b[^>]*data-transfer-feedback[^>]*role="status"[^>]*aria-live="polite"/);
  });

  it.each([
    ["not locally rehearsing", { localChainRehearsal: false }, finalized],
    ["no linked wallet", { wallet: null }, finalized],
    ["different linked wallet", { wallet: { ...wallet, address: LOCAL_TEST_RECIPIENT } }, finalized],
    ["different holder", {}, { ...finalized, currentTokenHolder: LOCAL_TEST_RECIPIENT }],
    ["not finalized", {}, { ...finalized, state: "included_unfinalized" }],
    ["no token ID", {}, { ...finalized, tokenId: undefined }],
  ] as const)("does not offer a local transfer when %s", (_reason, overrides, mint) => {
    const html = collectionPage({ ...local, ...overrides, mintBySignature: new Map([[signature.signatureId, mint]]) });
    expect(html).not.toContain("data-local-transfer");
  });

  it("keeps simulated advancement confined to fixture mode without local chain operations", () => {
    const mintBySignature = new Map([[signature.signatureId, { state: "submitted", label: "Submitted" }]]);
    const html = collectionPage({ ...base, fixtureMode: true, mintBySignature });
    expect(html).toContain("data-advance-rehearsal");
    expect(html).toContain(`data-signature-id="${signature.signatureId}"`);
    expect(html).toContain('data-csrf="collection-csrf"');
    expect(collectionPage({ ...base, mintBySignature })).not.toContain("data-advance-rehearsal");
    expect(collectionPage({ ...local, mintBySignature })).not.toContain("data-advance-rehearsal");
  });

  it("retains an empty collection without inventing a claim or wallet action", () => {
    const html = collectionPage({ ...base, signatures: [], mintEnabled: false });
    expect(html).toContain("No claimed signatures yet");
    expect(html).not.toContain('class="collection-card"');
    expect(html).not.toContain("data-link-wallet");
  });

  it("escapes handle, status and wallet proof text without turning it into markup", () => {
    const unsafe = '<img src=x onerror="bad">';
    const html = collectionPage({
      ...base,
      currentHandle: unsafe,
      signatures: [{ ...signature, handleAtClaim: unsafe }],
      wallet: { ...wallet, chainName: unsafe },
      mintBySignature: new Map([[signature.signatureId, { state: "quarantined", label: unsafe }]]),
    });
    expect(body(html)).not.toContain(unsafe);
    expect(body(html)).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
  });
});
