import { describe, expect, it } from "vitest";
import { MINT_STATE_LABELS } from "../v2/model.js";
import { collectionPage, errorPage, homePage, mintEntryPage, mintPage, signaturePage, type SignatureMintView, type SignatureView } from "./pages.js";
import { LOCAL_TEST_RECIPIENT, LOCAL_TEST_WALLET } from "../local/wallet.js";
import { SITE_CSS } from "./siteCss.js";
import { xProfileLink } from "./xProfile.js";

const signature: SignatureView = {
  signatureId: `sg1_${"a".repeat(52)}`,
  handleAtClaim: "historical_name",
  gr0kRaw: 37,
  rendererVersion: "artwork/1",
  svgSha256: "b".repeat(64),
  pngSha256: "c".repeat(64),
  cardRendererVersion: "social-card/1",
  xAuthenticatedAt: new Date("2026-08-25T08:58:00.000Z"),
  claimedAt: new Date("2026-08-25T09:00:00.000Z"),
  publicAccountId: "public-account-reference",
};
const finalized: SignatureMintView = {
  state: "finalized",
  label: "Minted on Ethereum",
  mintWallet: `0x${"1".repeat(40)}`,
  currentTokenHolder: `0x${"2".repeat(40)}`,
  txHash: `0x${"3".repeat(64)}`,
  contract: `0x${"4".repeat(40)}`,
  chainName: "Ethereum mainnet",
  tokenId: "12345678901234567890123456789012345678901234567890",
  tokenUri: `ipfs://bafy${"d".repeat(55)}`,
  metadataSha256: `0x${"e".repeat(64)}`,
  finalizedAt: new Date("2026-09-06T00:00:00.000Z"),
  finalityLabel: "Finalized",
  explorerTransactionUrl: `https://etherscan.io/tx/0x${"3".repeat(64)}`,
  explorerContractUrl: `https://etherscan.io/address/0x${"4".repeat(40)}`,
};

describe("compact public gallery captions", () => {
  it.each(["claimed", "minted"] as const)("pairs the handle and gr0k without a date in %s", (tab) => {
    const entry = tab === "minted" ? { ...signature, finalizedAt: finalized.finalizedAt!, mintWallet: finalized.mintWallet!, currentTokenHolder: finalized.currentTokenHolder! } : signature;
    const html = homePage(false, [entry], null, false, tab);
    const card = html.match(/<article class="gallery-item"[\s\S]*?<\/article>/)![0];
    expect(card).toContain(`<strong>${xProfileLink("historical_name")}</strong><span>gr0k 37</span>`);
    expect(card).not.toContain("<time");
    expect(card).not.toContain("2026-08-25");
    expect(card).not.toContain("2026-09-06");
    expect(card).toContain(`/signatures/${signature.signatureId}`);
    expect(card).toContain(`/artifacts/${signature.signatureId}.svg`);
    expect(card).toContain(tab === "minted" ? "Initial recipient" : "Claimed via X");
    expect(SITE_CSS).toMatch(/\.gallery-card-copy\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
    expect(SITE_CSS).toMatch(/\.gallery-card-copy>span\{[^}]*grid-column:2;grid-row:1;white-space:nowrap/);
    expect(SITE_CSS).toMatch(/\.gallery-card-copy>strong\{[^}]*text-overflow:ellipsis;white-space:nowrap/);
    expect(SITE_CSS).not.toContain(".gallery-card-copy time");
  });
});

function provenance(html: string): string {
  const disclosure = html.match(/<details class="signature-provenance">([\s\S]*?)<\/details>/)?.[1];
  if (!disclosure) throw new Error("Expected a closed-by-default native provenance disclosure.");
  return disclosure;
}

describe("minimal shared signature detail", () => {
  it.each([false, true])("offers the wallet proof only to the active original claimant (eligible=%s)", confirmed => {
    const html = mintPage({ signature, currentHandle: "historical_name", fixtureMode: false, claimInstanceId: "claim-instance", csrfToken: "private-csrf", chainName: "Anvil", metadataUri: "ipfs://test", metadataSha256: "hash", signatureDigest: "digest", tokenUriHash: "hash", contract: "0xcontract", account: {
      currentHandle: "historical_name", csrfToken: "private-csrf", mintEnabled: true,
      mintChainId: "31337", fixtureMode: false, mintRecipientConfirmed: confirmed,
      mintSignatureId: signature.signatureId, mintClaimInstanceId: "claim-instance", mintPreviousBindingId: null,
    } });
    const main = html.match(/<main>[\s\S]*?<\/main>/)![0];
    expect(main.includes("data-link-wallet")).toBe(confirmed);
    expect(main).not.toContain('name="purpose" value="sensitive_action"');
    expect(main).toContain("The wallet that will receive the token. You sign a one-time message to prove you control it; no transaction is sent.");
    expect(main).not.toContain('class="mint-authorization-form"');
    expect(main.includes('<span>Connect wallet</span></button>')).toBe(confirmed);
    expect(main).not.toMatch(/Confirm with X to|X confirmed\./);
    expect(main).not.toContain('action="/auth/x/start"');
    if (confirmed) {
      expect(main).toContain(`data-signature-id="${signature.signatureId}"`);
      expect(main).toContain('data-claim-instance-id="claim-instance"');
      expect(main).toContain('data-csrf="private-csrf"');
      expect(main).toContain('data-previous-binding-id=""');
    }
  });

  it.each([false, true])("retains the collapsed withdrawal warning and binds X confirmation to the exact claim (confirmed=%s)", confirmed => {
    const html = signaturePage(signature, false, undefined, "", false, {
      csrfToken: 'csrf"value', claimInstanceId: 'claim"instance', requiresXConfirmation: !confirmed, allowed: true,
    });
    expect(html).toContain("<summary>Withdraw claim</summary>");
    expect(html.match(/id="withdraw"/g)).toHaveLength(1);
    expect(html).toContain("This removes the claim from Claimed and My Collection. You can make a new claim later.");
    expect(html).toContain('name="csrf" value="csrf&quot;value"');
    expect(html).toContain('name="claim_instance" value="claim&quot;instance"');
    expect(html).not.toContain("Confirm this withdrawal with X, then confirm removal here.");
    expect(html).not.toContain("Confirm with X to withdraw claim");
    if (confirmed) {
      expect(html).toContain("data-withdraw-control");
      expect(html).toContain(`action="/signatures/${signature.signatureId}/withdraw"`);
      expect(html).toContain('name="confirm" value="withdraw"');
    } else {
      expect(html).toContain('name="purpose" value="sensitive_action"');
      expect(html).toContain('name="action" value="claim_withdraw"');
      expect(html).toContain(`name="signature_id" value="${signature.signatureId}"`);
      expect(html).toContain('<span>Withdraw claim</span></button>');
      expect(html).toContain('action="/auth/x/start" data-x-action-form');
      expect(html).toContain('<p class="inline-feedback" data-x-action-feedback role="status" aria-live="polite"></p>');
      expect(html).not.toContain(`action="/signatures/${signature.signatureId}/withdraw"`);
    }
  });

  it("distinguishes session expiry from an expired OAuth request and action confirmation", () => {
    for (const code of ["AUTH_REQUIRED", "AUTH_EXPIRED"]) {
      const html = errorPage(401, code, "Internal message", true, true);
      expect(html).toContain("Session expired. Sign in to continue.");
      expect(html).toContain('name="purpose" value="account_login"');
      expect(html).not.toContain("Reauthenticate with X");
    }
    const expiredFlow = errorPage(400, "INVALID_OAUTH_STATE", "Expired state", true, true);
    expect(expiredFlow).toContain("This sign-in request is invalid or expired.");
    expect(expiredFlow).not.toContain("Session expired");
    const action = errorPage(403, "X_ACTION_CONFIRMATION_REQUIRED", "Confirm this wallet action with X.");
    expect(action).toContain("Confirm this wallet action with X.");
    expect(action).not.toContain('name="purpose" value="account_login"');
  });

  it.each([false, true])("keeps the recipient control inside the mint page rather than a step list (previous recipient=%s)", linked => {
    const html = mintPage({ signature, currentHandle: "historical_name", fixtureMode: false, claimInstanceId: "claim-instance", csrfToken: "private-csrf", chainName: "Anvil", metadataUri: "ipfs://test", metadataSha256: "hash", signatureDigest: "digest", tokenUriHash: "hash", contract: "0xcontract", account: {
      currentHandle: "historical_name", csrfToken: "private-csrf", mintEnabled: true, mintChainId: "31337", fixtureMode: false,
      mintRecipientConfirmed: true, mintSignatureId: signature.signatureId, mintClaimInstanceId: "claim-instance",
      mintPreviousBindingId: linked ? `0x${"1".repeat(64)}` : null,
      wallet: linked ? { address: LOCAL_TEST_WALLET, chainId: "31337", chainName: "Anvil", provedAt: new Date() } : null,
    } });
    const main = html.match(/<main>[\s\S]*?<\/main>/)![0];
    expect(main).not.toContain("mint-entry-steps");
    expect(main).not.toMatch(/Review the mint details|Confirm the transaction in your wallet/);
    // A previous recipient never fills the row: this mint needs its own proof.
    expect(main).toMatch(/<dt>Recipient<\/dt><dd><p class="mint-recipient-hint">[\s\S]*?data-link-wallet/);
    expect(main).not.toContain('class="mint-authorization-form"');
    expect(html).not.toMatch(/Reauthenticate|Confirm your X sign-in before minting/);
  });
  it.each(["sign-in", "wrong-account", "paused", "pending"] as const)("does not solicit new mint steps during %s", stage => {
    const html = mintEntryPage({ signature, stage, account: { mintEnabled: true, mintChainId: "31337", fixtureMode: false } });
    expect(html).not.toContain('class="mint-entry-steps"');
    expect(html).not.toContain("Sign in as the claimant");
  });
  it.each([undefined, "unminted", "authorized", "expired"] as const)("places the mint action before provenance with a hidden explanation (%s)", state => {
    const html = signaturePage(signature, false, state ? { state, label: state } : undefined, "", false, {
      csrfToken: "test", claimInstanceId: "test", requiresXConfirmation: false, allowed: true,
    });
    expect(html.indexOf('class="signature-mint-entry"')).toBeLessThan(html.indexOf('class="signature-tools"'));
    expect(html).toContain('data-action-tooltip="mint-tooltip" aria-describedby="mint-tooltip"');
    expect(html).toContain(`id="mint-tooltip" role="tooltip" hidden>${state === "authorized" ? "Review the mint and confirm the transaction in the wallet you selected." : "Connect a wallet to receive the token. You’ll prove you control it, then review and confirm the mint."}</span>`);
    expect(html).not.toContain("Sign-in and wallet linking come next.");
    expect(html).not.toContain('<p class="auth-note">Only the original claimant can mint.');
    expect(html).toMatch(/src="\/assets\/action-tooltip.js/);
  });
  it.each([
    ["unminted", false, "Connect a wallet to receive the token. You’ll prove you control it, then review and confirm the mint."],
    ["unminted", true, "Review the mint and confirm it in the wallet you verified to receive the token."],
    ["authorized", false, "Review the mint and confirm the transaction in the wallet you selected."],
    ["authorized", true, "Review the mint and confirm the transaction in the wallet you selected."],
  ] as const)("adapts the accessible mint tooltip to state=%s, exact draft=%s", (state, verified, copy) => {
    const html = signaturePage(signature, false, { state, label: state }, "", false, { csrfToken: "csrf", claimInstanceId: "claim", requiresXConfirmation: false, allowed: state !== "authorized" }, verified);
    expect(html).toContain('data-action-tooltip="mint-tooltip" aria-describedby="mint-tooltip"');
    expect(html).toContain(`title="${copy}"`);
    expect(html).toContain(`id="mint-tooltip" role="tooltip" hidden>${copy}</span>`);
    expect(html.match(/id="mint-tooltip"/g)).toHaveLength(1);
    expect(html).toContain(`/signatures/${signature.signatureId}/mint`);
    expect(html).toMatch(/src="\/assets\/action-tooltip.js/);
  });

  it("does not infer fresh recipient proof from historical mint data or expose private controls publicly", () => {
    const history = { state: "unminted", label: "Not minted", mintWallet: LOCAL_TEST_WALLET };
    const own = signaturePage(signature, false, history, "", false, { csrfToken: "csrf", claimInstanceId: "claim", requiresXConfirmation: false, allowed: true });
    expect(own).toContain('id="mint-tooltip" role="tooltip" hidden>Connect a wallet to receive the token.');
    expect(own).not.toContain("the wallet you verified");
    expect(signaturePage(signature, false, history, "", false, undefined, true)).not.toContain('id="mint-tooltip"');
  });
  it.each([undefined, finalized])("keeps navigation at the top without duplicate destination CTAs below the work (mint=%s)", mint => {
    const html = signaturePage(signature, false, mint);
    expect(html).not.toContain('aria-label="Claim destinations"');
    expect(html).not.toContain("My Collection →");
    expect(html).not.toContain("Claimed gallery →");
    expect(html).toContain('class="collection-shortcut" href="/me"');
    expect(html).toContain(`class="gallery-return" href="/?tab=${mint ? "minted" : "claimed"}"`);
    expect(html).toContain('<div class="signature-tools">');
    expect(html).toContain('data-signature-status="claimed"');
    expect(html).not.toContain("Your signature is not claimed yet");
  });

  it.each([undefined, finalized])("removes the standalone date but retains historical timestamps in provenance (mint=%s)", mint => {
    const html = signaturePage(signature, false, mint);
    const evidence = provenance(html);
    expect(html).not.toContain('class="signature-caption"');
    expect(html).not.toContain("<time");
    expect(evidence).toContain(signature.claimedAt.toISOString());
    expect(evidence).toContain(signature.xAuthenticatedAt.toISOString());
    expect(html.replace(evidence, "")).not.toContain(signature.claimedAt.toISOString().slice(0, 10));
  });
  it("uses the gallery canvas, a single artwork and small milestones without the former split panels", () => {
    const html = signaturePage(signature, false, finalized, "https://signatures.gallery");
    expect(html).toContain('<body class="book-page">');
    expect(html).toContain(`<h1 id="signature-heading">${xProfileLink("historical_name")}</h1>`);
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain(`src="/artifacts/${signature.signatureId}.svg"`);
    expect(html.match(/data-signature-status="claimed"/g)).toHaveLength(1);
    expect(html.match(/data-signature-status="minted"/g)).toHaveLength(1);
    expect(html).toContain('href="/?tab=minted" title="Gallery" aria-label="Gallery"');
    expect(html.match(/class="home-icon"/g)).toHaveLength(1);
    expect(html).not.toContain('class="return-arrow"');
    expect(html).toContain('aria-label="Open canonical SVG"');
    for (const removed of ['class="art-label"', 'class="eyebrow"', 'class="gr0k-readout"', 'class="button secondary"', 'class="mint-provenance"']) {
      expect(html).not.toContain(removed);
    }
  });

  it.each(Object.entries(MINT_STATE_LABELS).filter(([state]) => state !== "finalized"))(
    "never shows a Minted milestone or indexes the page for %s",
    (state, label) => {
      const html = signaturePage(signature, false, { state, label });
      expect(html).toContain('data-signature-status="claimed"');
      expect(html).not.toContain('data-signature-status="minted"');
      expect(html).toContain('<meta name="robots" content="noindex">');
      expect(html).toContain('href="/?tab=claimed" title="Gallery" aria-label="Gallery"');
      expect(html.match(/class="home-icon"/g)).toHaveLength(1);
      const displayLabel = state === "included_unfinalized" ? "Confirming" : label;
      expect(provenance(html)).toContain(displayLabel);
      if (state !== "unminted") expect(html).toContain(`<span class="signature-pending">${displayLabel}</span>`);
    },
  );

  it("also renders a committed claim when minting is unavailable", () => {
    const html = signaturePage(signature, false);
    expect(html).toContain('data-signature-status="claimed"');
    expect(html).not.toContain('data-signature-status="minted"');
    expect(html).not.toContain("Mint status</h2>");
    expect(provenance(html)).toContain(signature.publicAccountId);
  });

  it("puts complete historical, artwork and chain evidence inside one closed disclosure", () => {
    const html = signaturePage(signature, false, finalized);
    const evidence = provenance(html);
    const surface = html.replace(evidence, "");
    for (const value of [signature.publicAccountId, signature.rendererVersion, signature.svgSha256, signature.pngSha256, signature.cardRendererVersion, signature.xAuthenticatedAt.toISOString(), finalized.mintWallet!, finalized.currentTokenHolder!, finalized.txHash!, finalized.contract!, finalized.tokenId!, finalized.tokenUri!, finalized.metadataSha256!, finalized.finalizedAt!.toISOString()]) {
      expect(evidence).toContain(value);
      expect(surface).not.toContain(value);
    }
    expect(evidence).toContain("Initially minted to");
    expect(evidence).toContain("Current token holder");
    expect(evidence).toContain("A later token holder is not implied to control the claimant’s X account.");
    expect(evidence).toContain(`href="${finalized.explorerTransactionUrl}"`);
    expect(evidence).toContain(`href="${finalized.explorerContractUrl}"`);
  });

  it("retains canonical SVG display and PNG social previews with production indexing only at finality", () => {
    const html = signaturePage(signature, false, finalized, "https://signatures.gallery/");
    expect(html).toContain('<meta name="robots" content="index">');
    expect(html).toContain(`property="og:image" content="https://signatures.gallery/artifacts/${signature.signatureId}.png"`);
    expect(html).toContain('property="og:image:type" content="image/png"');
    expect(html).toContain(`name="twitter:image" content="https://signatures.gallery/artifacts/${signature.signatureId}.png"`);
    expect(html).not.toContain(`<img src="/artifacts/${signature.signatureId}.png"`);
  });

  it("moves the fictional-account disclaimer to the global watermark and qualifies provenance", () => {
    const html = signaturePage(signature, true, finalized);
    expect(html.replace(provenance(html), "")).toContain('class="rehearsal-watermark"');
    expect(html).not.toContain("Fictional demo</span>");
    expect(html).toContain("No participation or endorsement is implied.");
    const overlay = html.slice(html.indexOf('<aside class="rehearsal-watermark"'));
    expect(overlay).toContain("Simulated chain provenance");
    expect(overlay).toContain("not production X account provenance");
    expect(provenance(html)).toContain("<h2>Claim</h2>");
    expect(provenance(html)).toContain("<h2>Mint</h2>");
    expect(provenance(html)).not.toMatch(/fixture|simulat|development|not production X/i);
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("distinguishes local Anvil events from fabricated mints and Ethereum finality", () => {
    const html = signaturePage(signature, true, { ...finalized, chainName: "Local Anvil", finalityLabel: "Manual local promotion" }, "", true);
    expect(html).toContain('class="rehearsal-watermark"');
    expect(html).toContain("Repo-local Anvil chain, not Ethereum mainnet or Sepolia.");
    expect(html).not.toContain("Fictional demo</span>");
    const overlay = html.slice(html.indexOf('<aside class="rehearsal-watermark"'));
    expect(overlay).toContain("Local development-chain provenance");
    expect(overlay).toContain("Locally promoted at");
    expect(overlay).toContain("Manual local promotion");
    expect(provenance(html)).toContain("Local Anvil");
    expect(provenance(html)).not.toMatch(/development-chain|Locally promoted|Manual local promotion/);
    expect(provenance(html)).not.toContain("Simulated chain provenance");
  });

  it.each([undefined, finalized])("uses the same product provenance markup with or without fixture context (mint=%s)", mint => {
    const main = (html: string) => html.match(/<main>[\s\S]*?<\/main>/)![0];
    expect(main(signaturePage(signature, true, mint))).toBe(main(signaturePage(signature, false, mint)));
  });

  it.each([[false, "Awaiting simulated finality"], [true, "Awaiting automatic local promotion"]] as const)(
    "uses truthful pending-state language for local Anvil=%s",
    (localChain, label) => {
      const html = signaturePage(signature, true, { state: "included_unfinalized", label: MINT_STATE_LABELS.included_unfinalized }, "", localChain);
      expect(html).toContain('<span class="signature-pending">Confirming</span>');
      expect(html.slice(html.indexOf('<aside class="rehearsal-watermark"'))).toContain(label);
      expect(html).not.toContain(MINT_STATE_LABELS.included_unfinalized);
      expect(html).not.toContain('data-signature-status="minted"');
    },
  );

  it("escapes dynamic values in the compact heading, tags and disclosure", () => {
    const html = signaturePage({ ...signature, handleAtClaim: '<img src=x onerror="bad">', rendererVersion: "<script>bad</script>" }, false, { state: "quarantined", label: "<script>bad</script>" });
    expect(html).not.toContain('<img src=x onerror="bad">');
    expect(html).not.toContain("<script>bad</script>");
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
  });

  it("keeps shared regular typography, borderless artwork and home-style milestone tags", () => {
    expect(SITE_CSS).toContain("body,body :not(svg,svg *){font-size:var(--ui-font-size);font-weight:var(--ui-font-weight)}");
    expect(SITE_CSS).toContain(".signature-sheet{width:100%;max-width:42rem;margin-inline:auto}");
    expect(SITE_CSS).toMatch(/\.signature-tag\{[^}]*padding:var\(--tag-padding\)/);
    expect(SITE_CSS).toMatch(/\.signature-tag\{[^}]*border:0/);
    expect(SITE_CSS).toMatch(/\.signature-tag\{[^}]*background:var\(--paper-2\)/);
    const art = SITE_CSS.match(/\.signature-art img\{([^}]*)\}/)![1];
    expect(art).not.toMatch(/border|box-shadow|transform/);
    expect(SITE_CSS).not.toContain(".review-wrap,.signature-page");
    expect(SITE_CSS).not.toContain(".review-copy,.signature-record");
    expect(SITE_CSS).toContain(".signature-provenance>summary:focus-visible");
    expect(SITE_CSS).toMatch(/\.signature-facts dd\{[^}]*overflow-wrap:anywhere/);
  });
});

describe("interactive local rehearsal pages", () => {
  const wallet = { address: LOCAL_TEST_WALLET, chainName: "Local Anvil", chainId: "31337", provedAt: new Date() };
  const collection = { currentHandle: "alice", signatures: [signature], csrfToken: "csrf", fixtureMode: true, mintEnabled: true, mintChainId: "31337", localChainRehearsal: true, wallet, walletLinkConfirmed: true };

  it("offers an explicit local TEST wallet only within a confirmed mint recipient flow", () => {
    const html = mintPage({ signature, currentHandle: "alice", fixtureMode: true, localChainRehearsal: true, claimInstanceId: "claim-instance", csrfToken: "private-csrf", chainName: "Anvil", metadataUri: "ipfs://test", metadataSha256: "hash", signatureDigest: "digest", tokenUriHash: "hash", contract: "0xcontract", account: { ...collection, mintRecipientConfirmed: true, mintSignatureId: signature.signatureId, mintClaimInstanceId: "claim-instance" } });
    expect(html).toContain("data-local-chain-rehearsal");
    expect(html).toContain('data-wallet-provider="local"');
    expect(html).toContain('data-wallet-provider="injected"');
    expect(html).toContain("Public test keys. Anvil 31337 only. Never send real funds.");
    expect(html).toContain(LOCAL_TEST_WALLET);
    expect(html.match(/<main>[\s\S]*?<\/main>/)![0]).not.toContain("Minting paused");
    expect(html).not.toContain("manually promoted");
    expect(collectionPage(collection)).not.toContain("data-link-wallet");
    expect(collectionPage(collection)).not.toContain("Mint recipient test tools");
  });

  it.each([false, true])("does not offer local controls outside local-chain rehearsal (fixtures=%s)", (fixtureMode) => {
    const html = collectionPage({ ...collection, fixtureMode, localChainRehearsal: false });
    expect(html).not.toContain("data-local-chain-rehearsal");
    expect(html).not.toContain('data-wallet-provider="local"');
    expect(html).not.toContain("data-local-transfer");
  });

  it("allows retry after authorizing but cancelling before submission", () => {
    const authorized = collectionPage({ ...collection, mintBySignature: new Map([[signature.signatureId, { state: "authorized", label: "Authorized" }]]) });
    expect(authorized).toContain(`/signatures/${signature.signatureId}/mint`);
    expect(authorized).toContain('data-local-mint-pending data-signature-id=');
    expect(authorized).toContain('data-mint-state="authorized"');
  });

  it.each(["authorized", "submitted", "included_unfinalized", "validation_pending"])("polls %s so a broadcast redirect before first observation still becomes Minted", (state) => {
    const html = collectionPage({ ...collection, mintBySignature: new Map([[signature.signatureId, { state, label: state }]]) });
    expect(html).toContain('data-local-mint-pending data-signature-id=');
    expect(html).toContain(`data-mint-state="${state}"`);
    expect(html).not.toContain("data-advance-rehearsal");
    expect(collectionPage({ ...collection, localChainRehearsal: false, mintBySignature: new Map([[signature.signatureId, { state, label: state }]]) })).not.toContain("data-local-mint-pending");
  });

  it("offers the fixed-recipient transfer only when the linked local wallet still owns a finalized token", () => {
    const owned = { ...finalized, currentTokenHolder: LOCAL_TEST_WALLET };
    const html = collectionPage({ ...collection, mintBySignature: new Map([[signature.signatureId, owned]]) });
    expect(html).toContain("data-local-transfer");
    expect(html).toContain(LOCAL_TEST_RECIPIENT);
    for (const projection of [{ ...owned, state: "included_unfinalized" }, { ...owned, currentTokenHolder: LOCAL_TEST_RECIPIENT }]) {
      expect(collectionPage({ ...collection, mintBySignature: new Map([[signature.signatureId, projection]]) })).not.toContain("data-local-transfer");
    }
    expect(collectionPage({ ...collection, wallet: { ...wallet, address: LOCAL_TEST_RECIPIENT }, mintBySignature: new Map([[signature.signatureId, owned]]) })).not.toContain("data-local-transfer");
  });

  it("states local limits truthfully and offers both local and injected mint submission", () => {
    const html = mintPage({ signature, currentHandle: "alice", account: { ...collection, mintRecipientConfirmed: true, mintSignatureId: signature.signatureId, mintClaimInstanceId: "claim-instance" }, wallet, walletBindingId: "binding-exact", claimInstanceId: "claim-exact", csrfToken: "csrf", chainName: "Local Anvil", metadataUri: "ipfs://test", metadataSha256: "hash", signatureDigest: "digest", tokenUriHash: "hash", contract: "0xcontract", fixtureMode: true, localChainRehearsal: true });
    expect(html).toContain('data-local-chain-rehearsal="true" data-local-wallet="true"');
    expect(html).toContain("Authorize with local TEST wallet");
    expect(html).toContain('<button class="auth-action" type="submit"><span>Authorize mint</span></button>');
    expect(html).toContain('form="mint-authorization" data-wallet-provider="local"');
    expect(html.match(/<main>[\s\S]*?<\/main>/)![0]).not.toContain("Authorize with local TEST wallet");
    expect(html).toContain("X identity is emulated, IPFS artifacts stay local");
    expect(html).not.toContain("pauses new mint authorization");
  });
});

describe("mint-scoped recipient review", () => {
  const wallet = { address: LOCAL_TEST_WALLET, chainName: "Local Anvil", chainId: "31337", provedAt: new Date() };
  const reviewAccount = { currentHandle: "renamed_claimant", csrfToken: 'csrf"exact', mintEnabled: true, mintChainId: "31337", fixtureMode: false, mintRecipientConfirmed: true, mintSignatureId: signature.signatureId, mintClaimInstanceId: 'claim"exact' };
  const review = { signature, currentHandle: "renamed_claimant", account: reviewAccount, wallet, walletBindingId: 'binding"exact', claimInstanceId: 'claim"exact', csrfToken: 'csrf"exact', chainName: "Local Anvil", metadataUri: "ipfs://test", metadataSha256: "hash", signatureDigest: "digest", tokenUriHash: "hash", contract: "0xcontract", fixtureMode: false };

  it("uses ordinary sign-in for signed-out mint entry without another mint-specific OAuth action", () => {
    const html = mintEntryPage({ signature, stage: "sign-in", account: { mintChainId: "31337", mintEnabled: true, fixtureMode: false, mintSignatureId: signature.signatureId, mintClaimInstanceId: "claim-instance", mintCanStart: true } });
    const main = html.slice(html.indexOf('<div data-mint-entry="sign-in"'), html.indexOf("</main>"));
    expect(main).toContain('action="/auth/x/start"');
    expect(main).not.toContain('name="action" value="mint_recipient"');
    expect(main).toContain('name="purpose" value="account_login"');
    expect(main).toContain(`name="return_to" value="/signatures/${signature.signatureId}/mint"`);
    expect(main).toContain('<span>Sign in with X</span>');
    expect(main).not.toContain('name="purpose" value="sensitive_action"');
    expect(main).not.toContain("data-link-wallet");
  });

  it.each([
    { mintCanStart: false }, { mintCanStart: undefined }, { mintCanStart: true, mintClaimInstanceId: undefined }, { mintCanStart: true, mintSignatureId: undefined },
  ])("does not grant signed-out mint authority without server eligibility and exact context (%j)", override => {
    const html = mintEntryPage({ signature, stage: "sign-in", account: { mintChainId: "31337", mintEnabled: true, fixtureMode: false, mintSignatureId: signature.signatureId, mintClaimInstanceId: "claim-instance", ...override } });
    const main = html.match(/<main>[\s\S]*?<\/main>/)![0];
    expect(main).toContain('name="purpose" value="account_login"');
    expect(main).not.toContain('name="action" value="mint_recipient"');
  });

  it("switches a wrong account normally even when the mint is startable", () => {
    const html = mintEntryPage({ signature, stage: "wrong-account", account: { currentHandle: "bob", csrfToken: "csrf", mintChainId: "31337", mintEnabled: true, fixtureMode: false, mintSignatureId: signature.signatureId, mintClaimInstanceId: "claim-instance", mintCanStart: true } });
    const main = html.match(/<main>[\s\S]*?<\/main>/)![0];
    expect(main).toContain('name="purpose" value="account_login"');
    expect(main).toContain('<span>Switch X account</span>');
    expect(main).not.toContain('name="action" value="mint_recipient"');
  });

  it("names an unrelated pending mint without assigning its status to this work", () => {
    const html = mintEntryPage({ signature, stage: "pending", pendingElsewhere: true, statusLabel: "Not minted", account: { currentHandle: "alice", csrfToken: "csrf", mintChainId: "31337", mintEnabled: true, fixtureMode: false, mintSignatureId: signature.signatureId, mintClaimInstanceId: "claim-instance", mintRecipientConfirmed: true } });
    const main = html.match(/<main>[\s\S]*?<\/main>/)![0];
    expect(main).toContain("Another mint is still pending. Finish or resolve it before choosing a recipient for this signature.");
    expect(main).not.toContain("Not minted");
    expect(main).not.toContain("This mint is awaiting confirmation");
    expect(main).not.toContain("data-link-wallet");
    expect(main).not.toContain('name="action" value="mint_recipient"');
  });

  it("reviews and binds the exact recipient, proof record, signature and claim", () => {
    const html = mintPage(review);
    expect(html).toContain(`<dt>Recipient</dt><dd><span class="mint-recipient-address">${wallet.address}</span>`);
    expect(html).toContain(`data-recipient="${wallet.address}"`);
    expect(html).toContain('data-wallet-binding-id="binding&quot;exact"');
    expect(html).toContain('data-claim-instance-id="claim&quot;exact"');
    expect(html).toContain('<dt>Cost</dt><dd>No project fee. Your wallet estimates network gas before you confirm.</dd>');
    expect(html).not.toContain("data-link-wallet");
    // Hashes and URIs stay available, but behind the disclosure rather than in the decision.
    const decision = html.slice(html.indexOf('<dl class="facts">'), html.indexOf('<details'));
    expect(decision).not.toMatch(/SHA-256|Metadata URI|Renderer/);
    expect(html).toContain('<summary>Verification details</summary>');
    expect(html).toContain(`<dt>Metadata SHA-256</dt><dd>hash</dd>`);
    expect(html).toContain('<span>Change recipient</span>');
    expect(html).not.toContain('name="action" value="mint_recipient"');
    expect(html).not.toContain('action="/auth/x/start"');
    expect(html).toContain(`href="/signatures/${signature.signatureId}/mint?recipient=change"`);
    expect(html).toContain('name="csrf" value="csrf&quot;exact"');
    expect(html).not.toMatch(/Linked wallet|linked wallet|Replace wallet|Revoke wallet/);
    expect(html).toContain('href="/me">Cancel and return to my collection</a>');
    expect(html).toContain('required type="checkbox" name="permanence_acknowledged"');
    expect(html).toContain('This publication cannot be undone');
  });

  it("keeps an unresolved authorization on its recipient and only offers transaction resumption", () => {
    const html = mintPage({ ...review, resumeAuthorization: true });
    expect(html).toContain("Complete this mint.");
    expect(html).toContain('<span>Confirm in wallet</span>');
    expect(html).not.toContain("Change recipient");
    expect(html).not.toContain('name="action" value="mint_recipient"');
    expect(html).not.toContain("data-link-wallet");
    expect(html).toContain('data-wallet-binding-id="binding&quot;exact"');
    expect(html).toContain('required type="checkbox" name="permanence_acknowledged"');
    expect(html).toContain('href="/me">Cancel and return to my collection</a>');
  });

  it.each(["sign-in", "wrong-account", "pending", "paused"] as const)("suppresses recipient tools, even with stale approval, during %s", stage => {
    const html = mintEntryPage({ signature, stage, account: { currentHandle: "alice", csrfToken: "csrf", mintChainId: "31337", mintEnabled: true, fixtureMode: true, localChainRehearsal: true, wallet, mintSignatureId: signature.signatureId, mintClaimInstanceId: "claim-instance", mintRecipientConfirmed: true } });
    expect(html).not.toContain("data-link-wallet");
    expect(html).not.toContain("Change recipient");
    expect(html).not.toContain('name="action" value="mint_recipient"');
    if (stage === "sign-in" || stage === "wrong-account") {
      expect(html).toContain('name="purpose" value="account_login"');
      expect(html).toContain(`name="return_to" value="/signatures/${signature.signatureId}/mint"`);
    }
  });
});
