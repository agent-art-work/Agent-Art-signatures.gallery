import { describe, expect, it } from "vitest";
import { xProfileLink } from "./xProfile.js";
import { accountPanelContent } from "./accountPanel.js";
import { collectionPage, homePage, mintEntryPage, mintPage, previewPage, signaturePage, type SignatureView } from "./pages.js";
import { SITE_CSS } from "./siteCss.js";

const signature: SignatureView = {
  signatureId: `sg1_${"a".repeat(52)}`, handleAtClaim: "Old_Handle", gr0kRaw: 50,
  rendererVersion: "artwork/1", svgSha256: "b".repeat(64), pngSha256: "c".repeat(64),
  cardRendererVersion: "social-card/1", publicAccountId: "account-reference",
  xAuthenticatedAt: new Date("2026-09-01"), claimedAt: new Date("2026-09-01"),
};
const account = { currentHandle: "Current_Handle", csrfToken: "csrf", fixtureMode: false, mintEnabled: true, mintChainId: "1" };

/** Check the source too: HTML parsers silently repair nested anchors. */
function expectNoNestedLinks(html: string): void {
  let depth = 0;
  for (const tag of html.match(/<a\b[^>]*>|<\/a>/g) ?? []) {
    depth += tag === "</a>" ? -1 : 1;
    expect(depth).toBeGreaterThanOrEqual(0);
    expect(depth).toBeLessThanOrEqual(1);
  }
  expect(depth).toBe(0);
}

describe("X profile links", () => {
  it.each(["alice", "TimD1919027", "under_score", "a", "abcdefghijklmno", "@AnAgentARTist"])("links %s without changing display case", handle => {
    const username = handle.replace(/^@/, "");
    const html = xProfileLink(handle);
    expect(html).toContain(`href="https://x.com/${username}"`);
    expect(html).toContain(`>@${username}</a>`);
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain(`aria-label="@${username} on X (opens in a new tab)"`);
  });
  it.each(["", "../settings", "a?b=c", "alice/with_replies", 'a" onclick="bad', "<img src=x onerror=bad>", "a&b", "a".repeat(16)])("does not link malformed input %s", handle => {
    const html = xProfileLink(handle);
    expect(html).not.toContain("<");
    expect(html).not.toContain('href="');
  });
  it.each(["claimed", "minted"] as const)("keeps %s artwork navigation separate from the X link", tab => {
    const entry = tab === "claimed" ? signature : { ...signature, finalizedAt: new Date(), mintWallet: "0x123", currentTokenHolder: "0x123" };
    const html = homePage(false, [entry], null, false, tab);
    expect(html).toContain(`class="gallery-card" href="/signatures/${signature.signatureId}"><img`);
    expect(html).toContain(`<strong>${xProfileLink(signature.handleAtClaim)}</strong>`);
    expectNoNestedLinks(html);
  });
  it.each([false, true])("links both current and recorded collection handles (fixture=%s)", fixture => {
    const html = collectionPage({ ...account, signatures: [signature], ...(fixture ? { preview: { state: "renamed", label: "Renamed", description: "Test" } } : {}) });
    expect(html).toContain(`<strong>${xProfileLink(signature.handleAtClaim)}</strong>`);
    expect(html).toContain(`<span class="auth-note">${xProfileLink(account.currentHandle)}</span>`);
    expectNoNestedLinks(html);
    if (!fixture) expect(html).toContain(`class="signature-art-link" href="/signatures/${signature.signatureId}"><img`);
  });
  it("links the account panel identity, including refreshed panel content", () => {
    expect(accountPanelContent(account)).toContain(xProfileLink(account.currentHandle));
    expect(accountPanelContent({ ...account, currentHandle: undefined })).not.toContain('class="x-profile"');
  });
  it("links preview and detail headings and claim provenance", () => {
    const preview = previewPage({ handle: signature.handleAtClaim, gr0kRaw: signature.gr0kRaw, rendererVersion: signature.rendererVersion, imageUrl: "/artwork.svg", fixtureMode: false });
    expect(preview).toContain(`<h1>${xProfileLink(signature.handleAtClaim)}</h1>`);
    const detail = signaturePage(signature, false);
    expect(detail).toContain(`<h1 id="signature-heading">${xProfileLink(signature.handleAtClaim)}</h1>`);
    expect(detail).toContain(`<dt>Handle at claim</dt><dd>${xProfileLink(signature.handleAtClaim)}</dd>`);
    expectNoNestedLinks(preview);
    expectNoNestedLinks(detail);
  });
  it("links mint entry and both mint review identities without changing consent controls", () => {
    const entry = mintEntryPage({ signature, stage: "sign-in", account });
    const review = mintPage({ signature, currentHandle: account.currentHandle, account, wallet: { address: "0x123", chainId: "1", chainName: "Ethereum", provedAt: new Date() }, walletBindingId: "binding-exact", claimInstanceId: "claim-exact", csrfToken: "csrf", chainName: "Ethereum", metadataUri: "ipfs://test", metadataSha256: "a", signatureDigest: "b", tokenUriHash: "c", contract: "0x123", fixtureMode: false });
    expect(entry).toContain(xProfileLink(signature.handleAtClaim));
    expect(review).toContain(`<dt>Handle at claim</dt><dd>${xProfileLink(signature.handleAtClaim)}</dd>`);
    expect(review).toContain(`<dt>Current X handle</dt><dd>${xProfileLink(account.currentHandle)}</dd>`);
    expect(review).toContain('required type="checkbox" name="permanence_acknowledged"');
    expectNoNestedLinks(entry);
    expectNoNestedLinks(review);
  });
  it("preserves minimal type and exposes hover and keyboard focus", () => {
    expect(SITE_CSS).toContain(".x-profile{color:inherit;text-decoration:none;");
    expect(SITE_CSS).toContain(".x-profile:hover,.x-profile:focus-visible{text-decoration:underline}");
    expect(SITE_CSS).toContain(".x-profile:focus-visible{outline:2px solid currentColor;");
  });
});
