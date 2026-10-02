import { describe, expect, it } from "vitest";
import { aboutPage, assessmentPage, canonicalPageHandle, collectionPage, errorPage, handoffPrompt, homePage, mbtiGalleryPage, mintPage, revealedSignature, OPEN_MINT_CSS, previewPage, previewVariationsPage, requestPage, type AssessmentPageModel, type GalleryEntry } from "./pages.js";
import { MBTI_TYPES, RENDERER_VERSION } from "./identity.js";
import { HOME_LINK } from "../v1/navigation.js";
import { SITE_CSS, SITE_CSS_URL } from "../v1/siteCss.js";
import { SITE_ACTION_SELECTOR, SITE_FIELD_SELECTOR, SITE_CONTROLS_CSS } from "../v1/controlsCss.js";
import { SLOGAN_MBTI_HERO_MANIFEST, SLOGAN_MBTI_HERO_SCRIPT_URL, SLOGAN_MBTI_HERO_SVG } from "../brand/sloganMbtiHero.js";
import { SLOGAN_TOOLTIP_SCRIPT_URL } from "../brand/sloganTooltipScript.js";
import type { PublicPreviewState } from "./previewState.js";

const ready: AssessmentPageModel = { handle: "agent_art", renderHandle: "Agent_Art", code: "opaque-request-code", status: "ready", canMint: true, mbti: "INTJ", imageUrl: "/art/hidden.png", svgUrl: "/art/hidden.svg", tokenId: "123", svgSha256: "secret-svg-digest", pngSha256: "secret-png-digest" };
const minted: AssessmentPageModel = { ...ready, mint: { state: "minted" } };
const entry: GalleryEntry = { handle: "alice_bob_key", renderHandle: "Alice_Bob_Key", code: "code", mbti: "INTJ", imageUrl: "/art/test.svg", mint: { state: "minted" } };
const publicMint: PublicPreviewState = {
  state: "minted", renderHandle: "Alice_Bob_Key", mbti: "INTJ", rendererVersion: RENDERER_VERSION,
  imageUrl: "/art/archived-mint.svg", url: "/signatures/alice_bob_key",
};

it('shows the relay sale phase on home without making visitors select free or paid', () => {
  for (const [phase, label, notice] of [
    ['free', 'Free Mint', 'Free mint open · 1/4 slots used.'],
    ['paid', 'Paid Mint', 'Paid mint open · Free mint ended.'],
    ['unknown', 'Mint a signature', 'Checking mint availability…'],
  ] as const) {
    const html = homePage({ pulseMint: true, pulseSaleStatus: { phase, paused: false, freeMinted: 1, freeMintQuota: 4 } });
    expect(html).toContain(`<span data-home-mint-label>${label}</span>`);
    expect(html).toContain(`data-home-mint-status role="status">${notice}</p>`);
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('Warning</strong>');
  }
  expect(homePage({ pulseMint: true, pulseSaleStatus: { phase: 'free', paused: true } })).toContain('Minting is paused.');
});

it('renders only the active phase controls and does not pre-authorize a wallet from public sale presentation', () => {
  const free = mintPage('', { pulseMint: true, pulseSaleStatus: { phase: 'free', paused: false } });
  expect(free).toContain('data-pulse-title>Free Mint</h2>');
  expect(free).toContain('data-pulse-paid hidden>');
  expect(free).toContain('data-pulse-refresh hidden>');
  expect(free).toContain('data-pulse-free>No mint fee. You pay network gas.');
  expect(free).toContain('Connect your wallet to check your free mint slot.');
  const paid = mintPage('', { pulseMint: true, pulseSaleStatus: { phase: 'paid', paused: false } });
  expect(paid).toContain('data-pulse-title>Mint price</h2>');
  expect(paid).toContain('<div data-pulse-paid>');
  expect(paid).toContain('data-pulse-free hidden>');
  expect(paid).toContain('Connect your wallet to check the current price.');
  const unknown = mintPage('', { pulseMint: true });
  expect(unknown).toContain('data-pulse-phase="unknown"');
  expect(unknown).toContain('data-pulse-title>Mint availability</h2>');
  expect(unknown).toContain('data-pulse-paid hidden>');
  expect(unknown).toContain('data-pulse-free hidden>');
  for (const html of [free, paid, unknown]) {
    expect(html).toContain('type="hidden" name="pulse-mode" value=""');
    expect(html).toContain('data-request-submit disabled');
    expect(html).not.toContain('Choose how to mint');
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('value="0.0001"');
  }
});

it('server-rendered failures and uncertain submissions share the inline warning style, not ordinary progress', () => {
  for (const status of ['failed', 'abstained'] as const) {
    const page = assessmentPage({ ...ready, status, canMint: false, error: '<script>bad</script>' });
    expect(page).toContain('class="open-feedback open-preview-notice open-preview-warning" data-mint-feedback');
    expect(page).toContain('<strong class="open-preview-notice-label">Warning</strong> <span>');
    expect(page).not.toContain('<script>bad</script>');
  }
  const uncertain = assessmentPage({ ...ready, mint: { state: 'pending', submissionUncertain: true } });
  expect(uncertain).toContain('class="open-feedback open-preview-notice open-preview-warning" data-mint-feedback');
  expect(uncertain).toContain('<span>A wallet submission was started, but its outcome is unknown.');
  const pending = assessmentPage({ ...ready, mint: { state: 'pending' } });
  expect(pending).toContain('class="open-feedback" data-mint-feedback role="status" aria-live="polite">Waiting for the transaction to be confirmed.</p>');
  expect(pending).not.toContain('class="open-feedback open-preview-notice open-preview-warning"');
  expect(OPEN_MINT_CSS).toContain('.open-mint :is(.open-feedback,[data-pulse-feedback],[data-poll-feedback],[data-reveal-feedback]).open-preview-warning{color:var(--ink)}');
});

it('sample-backed pages keep developer copy out of the user flow without claiming a Grok assessment', () => {
  const options = { assessmentSource: 'sample' as const, generativeArtwork: true, pulseMint: true, chainName: 'Ethereum Sepolia',
    pulseSaleNotice: 'Free mint ended · 2/2 slots used.' };
  const pages = [homePage(options), mintPage('Alice', options), aboutPage(options), collectionPage([], options),
    previewPage('Alice', 'INTJ', options), previewVariationsPage('Alice', options), mbtiGalleryPage('INTJ', [], options)];
  for (const page of pages) {
    expect(page).not.toMatch(/deterministic fixture|test runtime|Test MBTI fixture|Sepolia test|development fixture/i);
    expect(page).not.toContain('Grok chooses the final signature.');
    expect(page).not.toContain('Grok interprets it.');
    expect(page).not.toContain('asks Grok to research public X posts');
  }
  expect(pages[1]).toContain('data-pulse-sale-status role="status" aria-atomic="true">Free mint ended · 2/2 slots used.');
  expect(pages[1]).toContain('The final signature may differ from');
  expect(mintPage('', { ...options, pulseSaleNotice: '<script>bad</script>' })).toContain('&lt;script&gt;bad&lt;/script&gt;');
  expect(mintPage()).toContain('Grok chooses the final signature.');
  expect(homePage()).toContain('Choose any X handle.');
  const detail = assessmentPage({ ...minted, assessmentProvenance: 'development-fixture' }, options);
  expect(detail).toContain('Sample MBTI input; Grok was not called.');
});

const previewRows = [
  ["ISTJ", "ESTJ", "ISFJ", "ESFJ"],
  ["INFJ", "ENFJ", "INTJ", "ENTJ"],
  ["ISTP", "ESTP", "ISFP", "ESFP"],
  ["INFP", "ENFP", "INTP", "ENTP"],
] as const;

function artworkCaptions(html: string): string[] {
  return [...html.matchAll(/<div class="artwork-caption\b[^"]*"[^>]*>/g)].map(start => {
    const tags = /<\/?div\b[^>]*>/g;
    tags.lastIndex = start.index! + start[0].length;
    let depth = 1;
    for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
      depth += tag[0].startsWith("</") ? -1 : 1;
      if (depth === 0) return html.slice(start.index, tags.lastIndex);
    }
    throw new Error("Unclosed artwork caption");
  });
}

// This is a user-facing navigation contract, independent of the rendering helper
// or CSS classes: a displayed @handle always opens its case-preserved variations.
function expectHandleNavigation(html: string, handle: string, count?: number): void {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? html;
  const links = [...main.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    .filter(([, , label]) => label!.replace(/<[^>]*>/g, "").trim() === `@${handle}`);
  if (count === undefined) expect(links.length).toBeGreaterThan(0);
  else expect(links).toHaveLength(count);
  for (const [, attributes] of links) {
    expect(attributes!.match(/\bhref="([^"]*)"/)?.[1]).toBe(`/p/${handle}/variations`);
    expect(attributes).not.toMatch(/\btarget=/);
  }
}

function expectArtworkIdentity(caption: string, handle: string, mbti: string, status?: "Minted" | "Preview"): void {
  expect(caption).toContain('class="artwork-identity"');
  expect(caption).toContain(`@${handle}</a>`);
  expectHandleNavigation(caption, handle, 1);
  expect(caption).toContain('<span class="artwork-personality-separator" aria-hidden="true">×</span>');
  expect(caption).toContain(`<a class="mbti-link" href="/${mbti}/">${mbti}</a>`);
  expect(caption.indexOf(`@${handle}</a>`)).toBeLessThan(caption.indexOf('class="artwork-personality-separator"'));
  expect(caption.indexOf('class="artwork-personality-separator"')).toBeLessThan(caption.indexOf('class="mbti-link"'));
  const statusLabels = [...caption.matchAll(/<(a|span) class="[^"]*\bartwork-status\b[^"]*"([^>]*)>([^<]+)<\/\1>/g)];
  expect(statusLabels.map(match => match[3])).toEqual(status ? [status] : []);
  for (const [, tag, attributes, label] of statusLabels) {
    expect(tag).toBe(label === "Minted" ? "a" : "span");
    if (label === "Minted") expect(attributes).toContain('href="/"');
    else expect(attributes).not.toContain('href=');
  }
  if (status) expect(caption.indexOf('class="mbti-link"')).toBeLessThan(caption.indexOf('artwork-status'));
  expect(caption).not.toMatch(/<img\b|<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
}

function expectCleanProductCopy(html: string): void {
  const chrome = html.replace(/<details class="signature-provenance">[\s\S]*?<\/details>/g, "");
  const product = [...chrome.matchAll(/<(?:main|footer)\b[^>]*>([\s\S]*?)<\/(?:main|footer)>/g)].map(match => match[1]).join(" ");
  expect(product).not.toContain("data-gallery-fixture-notice");
  expect(product.replace(/<[^>]*>/g, " ")).not.toMatch(/\bfixtures?\b|\bsimulat(?:ed|ions?)\b|No tokens were minted/i);
}

function expectNoDevelopmentChrome(html: string): void {
  expectCleanProductCopy(html);
  expect(html).not.toMatch(/rehearsal-watermark|Developer overlay|open-dev-context|data-gallery-fixture-notice|data-dev-wallet|data-dev-mint/);
  const chrome = html.replace(/<details class="signature-provenance">[\s\S]*?<\/details>/g, "");
  expect(chrome.replace(/<[^>]*>/g, " ")).not.toMatch(/\bfixtures?\b|\bsimulat(?:ed|ions?)\b|\bDEV\b|No tokens were minted|Grok was not called|Grok did not research/i);
}

describe("open mint pages", () => {
  it('exposes only the saved Pulse ceiling before reveal and keeps historical fee copy', () => {
    const html=assessmentPage({...ready,pulseMaxPriceWei:'1500000000'},{pulseMint:true});
    expect(html).toContain('data-pulse-max-price-wei="1500000000"');
    expect(html).not.toContain('secret-svg-digest');
    expect(html).not.toContain('/art/hidden.svg');
    expect(()=>assessmentPage({...ready,pulseMaxPriceWei:'1500000000'})).toThrow();
    expect(()=>assessmentPage({...ready,pulseMaxPriceWei:'01'},{pulseMint:true})).toThrow();
    expect(aboutPage()).toContain('No mint fee. You pay network gas.');
    expect(aboutPage({pulseMint:true})).not.toContain('No mint fee.');
    const entry=mintPage('Alice',{pulseMint:true});
    expect(entry).toContain('data-pulse-options');
    expect(entry).toContain('Maximum mint price (ETH)');
    expect(entry).not.toContain(' checked');
  });
  it.each([
    ["home", () => homePage({}, [entry])],
    ["MBTI gallery", () => mbtiGalleryPage("INTJ", [entry])],
    ["preview", () => previewPage("Alice", "INTJ")],
    ["variations", () => previewVariationsPage("Alice")],
    ["mint", () => mintPage("Alice")],
    ["request", () => requestPage("Alice")],
    ["assessment", () => assessmentPage(ready)],
    ["minted signature", () => assessmentPage(minted)],
    ["collection", () => collectionPage([entry])],
    ["about", () => aboutPage()],
    ["error", () => errorPage("Unavailable")],
  ] as const)("preserves the linked X icon in the %s footer", (_name, render) => {
    const html = render();
    const footers = html.match(/<footer>[\s\S]*?<\/footer>/g)!;
    expect(footers).toHaveLength(1);
    const footer = footers[0]!;
    expect(footer).toContain('href="https://x.com/AgentArt_AA" target="_blank" rel="noopener noreferrer" aria-label="Agent Art on X (opens in a new tab)"');
    expect(footer.match(/class="footer-x-icon"/g)).toHaveLength(1);
    expect(footer).toMatch(/<svg class="footer-x-icon"[^>]*fill="currentColor"[^>]*aria-hidden="true" focusable="false"><path d="[^"]+"\/><\/svg><span>Agent Art<\/span><span aria-hidden="true">↗<\/span><\/a>/);
    expect(footer).toContain('href="/about"');
  });

  it("keeps development chrome and sample notices off the gallery", () => {
    const fixture = { development: { fixture: true, galleryFixtures: true } };
    expectNoDevelopmentChrome(homePage(fixture, [entry]));
    expect(homePage({ development: { fixture: false, galleryFixtures: true } }, [entry])).not.toContain("data-gallery-fixture-notice");
    expect(homePage({ development: { fixture: true, localChain: true } }, [entry])).not.toContain("data-gallery-fixture-notice");
  });

  it("requires fixture mode for simulated minted detail pages without inventing token facts", () => {
    const sample: AssessmentPageModel = { handle: "grok", code: "", status: "ready", canMint: false,
      galleryFixture: true, mint: { state: "minted" }, mbti: "ENFP", svgUrl: "/preview/grok/ENFP.svg" };
    expect(() => assessmentPage(sample)).toThrow("Gallery samples require fixture mode");
    const html = assessmentPage(sample, { development: { fixture: true } });
    expect(html).toContain("data-mint-state-label>Minted</a>");
    expectNoDevelopmentChrome(html);
    expect(html).toContain('href="/preview/grok/ENFP.svg"');
    expect(html).toContain('<a class="mbti-link" href="/ENFP/">ENFP</a>');
    expect(html).not.toContain("The backend asked Grok to research public X posts");
    expect(html).not.toMatch(/<dt>(Assessment|Spelling verified at preparation)<\/dt>/);
    expect(html).not.toMatch(/<dt>(Token|Transaction)<\/dt>|View token|data-submit-mint|data-mint-form/);
  });

  it("presents the eight v2 slogan shapes once while preserving the literal tooltip and keyboard label", () => {
    const approvedSlogan = "Anyone_Can_Sign_Anyone";
    const html = homePage();
    const heading = html.match(/<h1\b[^>]*id="slogan-heading"[^>]*>([\s\S]*?)<\/h1>/);
    expect(heading?.[1]).toBe(approvedSlogan);
    expect(heading?.[0]).toContain('class="visually-hidden"');
    const figure = html.match(/<figure\b[^>]*class="slogan-signature"[^>]*>[\s\S]*?<\/figure>/)?.[0];
    expect(figure).toBeDefined();
    expect(figure).toContain('tabindex="0"');
    expect(figure).toContain('role="img"');
    expect(figure).toContain('aria-labelledby="slogan-heading"');
    expect(figure).toContain(`title="${approvedSlogan}"`);
    expect(figure).toContain('data-slogan-signature-version="sg-slogan-mbti-1.3.0"');
    expect(figure).toContain(SLOGAN_MBTI_HERO_SVG);
    expect(figure!.match(/<svg\b/g)).toHaveLength(1);
    expect(figure).toContain('data-source-renderer="sg-renderer-2.0.1"');
    expect([...figure!.matchAll(/data-slogan-frame="([A-Z]{4})"/g)].map(match => match[1])).toEqual([
      "ISTJ", "ISFJ", "INFJ", "INTJ", "ISTP", "ISFP", "INFP", "INTP",
    ]);
    expect(figure).not.toMatch(/slogan-signature-desktop|slogan-signature-mobile/);
    const tip = html.match(/<span\b[^>]*id="slogan-tooltip"[^>]*>([\s\S]*?)<\/span>/);
    expect(tip?.[1]).toBe(approvedSlogan);
    expect(tip?.[0]).toContain('role="tooltip"');
    expect(tip?.[0]).toMatch(/\shidden(?:\s|>)/);
    expect(html.match(/id="slogan-heading"/g)).toHaveLength(1);
    expect(html.match(/id="slogan-tooltip"/g)).toHaveLength(1);
    expect(SLOGAN_MBTI_HERO_MANIFEST.sourceRendererVersion).toBe("sg-renderer-2.0.1");
    expect(SLOGAN_MBTI_HERO_MANIFEST.displayText).toBe(approvedSlogan);
    expect(SLOGAN_MBTI_HERO_MANIFEST.frameCount).toBe(8);
    expect(SLOGAN_MBTI_HERO_MANIFEST).not.toHaveProperty("sourceGr0kRaw");
    expect(RENDERER_VERSION).toBe("sg-renderer-2.0.0");
  });

  it("pairs the approved case-sensitive slogan with the mint-and-reveal supporting sentence", () => {
    for (const html of [homePage(), homePage({}, [entry]), homePage({ assessmentSource: "grok" }), homePage({ assessmentSource: "sample" })]) {
      const guidance = html.match(/<p class="home-guidance">([\s\S]*?)<\/p>/)?.[1];
      expect(guidance).toBe('<span>Choose any X handle.</span> <span>One signature per handle—mint to reveal it.</span>');
      expect(guidance?.replace(/<[^>]+>/g, ""))
        .toBe("Choose any X handle. One signature per handle—mint to reveal it.");
      expect(guidance).not.toContain("&nbsp;");
      expect(html).not.toContain("Any X handle. One minted signature.");
      expect(html).not.toContain("What_shape_do_you_go_by?");
      expect(html).not.toContain("Whose_shape_will_you_reveal?");
      expect(html).not.toContain("Whose_Shape_Will_You_Reveal?");
    }
  });

  it.each([{ entries: [] }, { entries: [entry] }])("keeps the mint action outside a native collapsed Preview with Grok disclosure (entries: $entries)", ({ entries }) => {
    const html = homePage({}, entries);
    const intro = html.match(/<section class="open-intro"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    expect(intro).toBeDefined();
    expect(intro).toMatch(/^<p class="home-guidance">[\s\S]*?<\/p><div class="auth-actions"><a class="auth-action home-mint-cta" href="\/mint"[^>]*><span data-home-mint-label>Mint a signature<\/span><\/a><\/div><p[^>]*data-home-mint-status[^>]*><\/p><details\b/);
    const disclosure = intro!.match(/<details\b([^>]*)>([\s\S]*?)<\/details>/);
    expect(disclosure?.[1]).toBe(' class="auth-disclosure open-handoff"');
    expect(disclosure?.[1]).not.toMatch(/\bopen\b(?:\s|=|$)/);
    expect(disclosure?.[2]).toMatch(/^<summary>Preview with Grok<\/summary><div class="open-handoff-content">[\s\S]*<\/div>$/);
    expect(disclosure?.[2]).not.toContain('href="/mint"');
    expect(disclosure?.[2]).not.toContain("home-mint-cta");
    expect(intro).not.toContain("Explore with Grok");
    expect(intro?.match(/<summary>/g)).toHaveLength(1);
  });

  it("does not apply homepage Mint CTA typography to the mint flow, previews or other pages", () => {
    for (const html of [mintPage("Alice_Bob_Key"), requestPage("Alice_Bob_Key"),
      previewPage("Alice_Bob_Key", "ENFP"), previewVariationsPage("Alice_Bob_Key"),
      collectionPage([entry]), mbtiGalleryPage("INTJ", [entry]), assessmentPage(ready), assessmentPage(minted), aboutPage(), errorPage("Not found")]) {
      expect(html).not.toContain('class="auth-action home-mint-cta"');
    }
  });

  it("keeps all preview instructions and the preview/mint distinction inside the expanded content", () => {
    const html = homePage();
    const disclosure = html.match(/<details class="auth-disclosure open-handoff">([\s\S]*?)<\/details>/)?.[1];
    const content = disclosure?.match(/^<summary>Preview with Grok<\/summary><div class="open-handoff-content">([\s\S]*)<\/div>$/)?.[1];
    expect(content).toBeDefined();
    expect(content).toContain("Give this prompt to Grok on X or Grok.com.");
    expect(content).toContain('readonly data-handoff-prompt aria-label="Prompt for Grok"');
    expect(content).toContain("data-copy-handoff");
    expect(content).toContain('href="https://grok.com" target="_blank" rel="noopener noreferrer"');
    expect(content).toContain('data-copy-feedback role="status" aria-live="polite"');
    expect(content).toContain('<p>Previews are for exploration. Minting uses a fresh Grok assessment.</p>');
    expect(html.match(/Previews are for exploration\. Minting uses a fresh Grok assessment\./g)).toHaveLength(1);
  });

  it("omits the pause button while retaining a focusable slogan for the tooltip and motion pause", () => {
    for (const html of [homePage(), homePage({}, [entry])]) {
      const hero = html.match(/<div\b[^>]*class="slogan-lockup slogan-loop"[^>]*>[\s\S]*?<\/div>/)?.[0];
      expect(hero).toBeDefined();
      expect(hero).not.toMatch(/<button\b/);
      expect(html).not.toMatch(/data-slogan-toggle|slogan-motion-toggle|Pause slogan animation|Resume slogan animation/);
      const figure = hero!.match(/<figure\b[^>]*class="slogan-signature"[^>]*>[\s\S]*?<\/figure>/)?.[0];
      expect(figure).toContain('tabindex="0"');
      expect(figure).toContain('aria-labelledby="slogan-heading"');
      expect(figure).toContain(SLOGAN_MBTI_HERO_SVG);
    }
  });

  it("loads the slogan tooltip and animation once on home and nowhere in mint or preview flows", () => {
    for (const html of [homePage(), homePage({}, [entry])]) {
      for (const url of [SLOGAN_TOOLTIP_SCRIPT_URL, SLOGAN_MBTI_HERO_SCRIPT_URL]) {
        const script = `<script src="${url}" defer></script>`;
        expect(html.split(script)).toHaveLength(2);
        expect(html.indexOf(script)).toBeLessThan(html.indexOf("</head>"));
      }
    }
    for (const html of [mintPage("Alice_Bob_Key"), requestPage("Alice_Bob_Key"),
      previewPage("Alice_Bob_Key", "ENFP"), previewVariationsPage("Alice_Bob_Key"),
      collectionPage([entry]), mbtiGalleryPage("INTJ", [entry]), assessmentPage(ready), assessmentPage(minted), aboutPage(), errorPage("Not found")]) {
      expect(html).not.toContain(SLOGAN_TOOLTIP_SCRIPT_URL);
      expect(html).not.toContain(SLOGAN_MBTI_HERO_SCRIPT_URL);
      expect(html).not.toContain('id="slogan-tooltip"');
      expect(html).not.toContain("data-slogan-frame");
      expect(html).not.toContain("data-slogan-toggle");
    }
  });

  it("preserves navigation, type assets, hairline controls and a wallet collection", () => {
    const html = homePage();
    expect(html).toContain('<title>Signatures Gallery</title>');
    expect(html).toContain(HOME_LINK);
    expect(html).toContain('class="collection-shortcut" href="/me"');
    expect(html).toContain('aria-label="My Collection"');
    expect(html).toContain(SITE_CSS_URL);
    expect(html).toContain('playpen-sans-latin-wght-normal.woff2');
    expect(html).toContain('href="/mint" data-home-mint-cta aria-describedby="home-mint-status"><span data-home-mint-label>Mint a signature</span>');
    expect(html).not.toContain('data-assessment-request');
    expect(html).not.toMatch(/Sign in with X|Claim with X|withdraw|\/auth\/x/);
    expect(OPEN_MINT_CSS).not.toMatch(/font-family:|--paper:|--font-family:/);
  });

  it("asks consumer Grok to verify current username capitalization before an MBTI preview link", () => {
    const prompt = handoffPrompt("https://example.com");
    expect(prompt).toContain("First, ask me which X handle");
    expect(prompt).toContain("After I provide a valid handle");
    expect(prompt).toContain("assess an MBTI for that handle in this chat");
    expect(prompt).toContain("Check the signature of @<handle>: https://example.com/p/<handle>/<MBTI>");
    expect(prompt).toContain("resolve its exact current X username spelling and capitalization");
    expect(prompt).toContain("before constructing the preview URL");
    expect(prompt).toContain("matches my input after removing @ and ignoring letter case");
    expect(prompt).toContain("do not substitute another account");
    expect(prompt).toContain("if I enter @alice_bob_key and X shows Alice_Bob_Key, use Alice_Bob_Key");
    expect(prompt).toContain("If you cannot verify the current username spelling, say so");
    expect(prompt).toContain("do not invent a resolved link");
    expect(prompt).toContain("https://example.com/p/Alice_Bob_Key/ENFP");
    expect(prompt).toContain("Use the letters, not a number");
    expect(prompt).toContain("Do not call the site to request an assessment or ask for a wallet");
    expect(prompt).toContain("editable preview, not a mint authorization");
    expect(prompt).toContain("a convenience, not proof for minting");
    expect(prompt).toContain("renders the spelling in the URL without looking up X");
    expect(prompt).not.toContain("Preserve its exact spelling and capitalization");
    expect(prompt).not.toContain("Create signature");
    for (const mbti of MBTI_TYPES) expect(prompt).toContain(mbti);
    expect(homePage()).toContain("Grok on X or Grok.com");
  });

  it("canonicalizes token identity but preserves exact spelling in the mint input", () => {
    expect(canonicalPageHandle(" @Agent_Art ")).toBe("agent_art");
    for (const html of [mintPage(" @Alice_Bob_Key "), requestPage(" @Alice_Bob_Key ")]) {
      expect(html).toContain('value="Alice_Bob_Key"');
      expect(html).toContain('<title>Mint &amp; reveal · Signatures Gallery</title>');
      expect(html).not.toContain('name="mbti"');
    }
    expect(mintPage()).toContain('name="handle" value=""');
    expect(() => mintPage("agent/art")).toThrow();
    expect(() => assessmentPage({ ...ready, handle: '<img src=x>' })).toThrow();
    expect(() => assessmentPage({ ...ready, renderHandle: "Someone_Else" })).toThrow("does not match");
  });

  it.each(["Alice_Bob_Key", undefined])("keeps one handle-link policy across every page and mint state (saved spelling: %s)", renderHandle => {
    const handle = renderHandle ?? "alice_bob_key";
    const model: AssessmentPageModel = { ...ready, handle: "alice_bob_key", renderHandle };
    const galleryEntry: GalleryEntry = { ...entry, renderHandle };
    const state: PublicPreviewState = { ...publicMint, renderHandle: handle };
    const fixtureOptions = { development: { fixture: true } };
    const pages: [string, string, number][] = [
      ["home", homePage({}, [galleryEntry]), 1],
      ["MBTI gallery", mbtiGalleryPage("INTJ", [galleryEntry]), 1],
      ["collection", collectionPage([galleryEntry]), 1],
      ["single preview", previewPage(handle, "INTJ"), 1],
      ["variations header and cards", previewVariationsPage(handle), 17],
      ["minted preview", previewPage(handle, "INTJ", {}, state), 1],
      ["minted variations", previewVariationsPage(handle, {}, state), 17],
      ["fixture detail", assessmentPage({ ...model, galleryFixture: true, mint: { state: "minted" } }, fixtureOptions), 2],
      ["fixture preview", previewPage(handle, "INTJ", fixtureOptions, { ...state, state: "fixture" }), 1],
      ["fixture variations", previewVariationsPage(handle, fixtureOptions, { ...state, state: "fixture" }), 17],
      ["assessment pending", assessmentPage({ ...model, status: "pending" }), 1],
      ["assessment failed", assessmentPage({ ...model, status: "failed", canMint: false }), 1],
      ["assessment prepared", assessmentPage(model), 1],
      ["mint submitted", assessmentPage({ ...model, mint: { state: "pending" } }), 1],
      ["request expired", assessmentPage({ ...model, canMint: false, requestExpired: true }), 1],
      ["reveal and provenance", assessmentPage({ ...model, mint: { state: "minted" } }), 2],
    ];
    for (const [name, html, count] of pages) {
      expect(html, name).toContain(`@${handle}</a>`);
      expectHandleNavigation(html, handle, count);
      // Agent Art footer credits and explicit source references are not artwork
      // identities, so the contract is scoped to visible @handle links in main.
      expect(html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1], name).not.toContain(`href="https://x.com/${handle}"`);
    }
    for (const html of [mintPage(handle), requestPage(handle)]) {
      expect(html).toContain(`name="handle" value="${handle}"`);
      expectHandleNavigation(html, handle, 0);
      expect(html).not.toContain(`href="https://x.com/${handle}"`);
    }
  });

  it("requires wallet proof and explicit Mint & reveal without a separate review checkbox", () => {
    const progress = assessmentPage(ready);
    expect(progress).not.toContain('Grok chooses the final signature');
    expect(progress).not.toContain('No mint fee.');
    expect(progress).toContain('mint-progress-status');
    const html = mintPage("Alice_Bob_Key");
    expect(html).toContain('data-mint-entry data-wallet-verified="false"');
    expect(html).toContain('data-connect-wallet');
    expect(html).toContain('data-request-submit disabled');
    expect(html).toContain('data-assessment-request');
    expect(html).toContain('data-request-feedback role="status" aria-live="polite"');
    expect(mintPage()).toContain('Grok chooses the final signature. It may differ from <a data-mint-preview>your preview</a>. <strong>Reveal after minting.</strong>');
    expect(mintPage('Alice_Bob')).toContain('data-mint-preview href="/p/Alice_Bob/variations"');
    // The shared site reset forces all descendants to 400; semantic markup alone is insufficient.
    expect(OPEN_MINT_CSS).toContain('.open-mint .open-mint-explanation strong{font-weight:700}');
    expect(html).toContain('No mint fee. You pay network gas. Minting creates a permanent public token.');
    expect(html.indexOf('Grok chooses')).toBeLessThan(html.indexOf('data-request-submit'));
    expect(html).not.toMatch(/checkbox|Create signature|data-mint-review|\/art\//);
    const verified = mintPage("Alice_Bob_Key", { wallet: "0x123", walletVerified: true, chainName: "Local Anvil" });
    expect(verified).toContain('data-wallet-verified="true"');
    expect(verified).toContain('data-request-submit><span>Mint &amp; reveal');
    expect(verified).toContain('data-wallet-label>0x123');
    expect(verified).toContain('data-review-chain>Local Anvil');
    expect(mintPage("", { wallet: "0x123" })).toContain('<span>Verify wallet</span>');
  });

  it("starts with the handle field and gives way to the revealed artwork without an introductory heading", () => {
    const html = mintPage(" @Alice_Bob_Key ");
    const form = html.match(/<form\b[^>]*data-assessment-request[^>]*>([\s\S]*?)<\/form>/)?.[1];
    expect(form).toBeDefined();
    expect(form?.trim()).toMatch(/^<section class="mint-entry-part mint-entry-handle"/);
    expect(html).not.toMatch(/mint-entry-intro|A name,|a signature\.<\/h1>|<h1\b(?! class="visually-hidden")/);
    expect(html).toContain('<h1 class="visually-hidden">Mint &amp; reveal</h1>');
    expect(OPEN_MINT_CSS).not.toContain("mint-entry-intro");
    expect(form?.match(/<input\b[^>]*name="handle"[^>]*>/g)).toHaveLength(1);
    expect(form).toContain('<label for="open-handle"><span class="mint-section-title">Choose any X handle.</span>');
    expect(form).toContain('id="open-handle" name="handle" value="Alice_Bob_Key"');
    expect(form).toContain('autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="16" pattern="@?[A-Za-z0-9_]{1,15}" required aria-describedby="handle-validation mint-explanation request-feedback"');
    expect(form).toContain('<p id="handle-validation" class="open-preview-notice open-preview-warning" data-handle-validation role="status" aria-live="polite" hidden></p>');
    expect(OPEN_MINT_CSS).toContain('.open-mint .mint-entry-sheet .mint-entry-handle [data-handle-validation]{margin:.65rem 0 0;font-size:14px;max-width:none}');
    expect(form).toContain('data-mint-preview href="/p/Alice_Bob_Key/variations"');
    expect(html).toContain('<div data-mint-result hidden tabindex="-1" aria-label="Revealed signature"><div data-mint-result-artwork></div>');
    expect(html.indexOf('data-mint-result hidden')).toBeGreaterThan(html.indexOf('</form>'));
    expect(form).not.toMatch(/<img\b|<figure\b|signature-provenance|name="mbti"|\/art\//);
    expect(html).not.toMatch(/<img\b|<figure\b|<article class="signature-page"|signature-provenance|\/art\//);
  });

  it("caps mint entry at the 853px visible-slogan midpoint while its form and explanation fill the sheet", () => {
    const rules = [...OPEN_MINT_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map(([, selector, declarations]) => ({ selector: selector.trim(), declarations }));
    const declarations = (selector: string) => {
      const matches = rules.filter(rule => rule.selector === selector);
      expect(matches, selector).toHaveLength(1);
      return matches[0].declarations;
    };
    expect(declarations(".open-mint .mint-entry-sheet")).toBe("max-width:853px");
    expect(declarations(".open-mint .home-grid .slogan-lockup")).toBe("max-width:56rem");
    expect(declarations(".open-mint .mint-entry-sheet .open-mint-form")).toBe("gap:0;max-width:none");
    expect(declarations(".open-mint .mint-entry-sheet .open-mint-explanation")).toBe("max-width:none");
    // The entry overrides follow their defaults; unrelated forms, explanatory
    // copy and the progress sheet retain their existing readable widths.
    expect(declarations(".open-mint .open-mint-form")).toContain("max-width:35rem");
    expect(declarations(".open-mint .open-mint-explanation")).toContain("max-width:35rem");
    expect(declarations(".open-mint .open-mint-progress")).toBe("max-width:35rem");
    expect(OPEN_MINT_CSS.indexOf(".open-mint .mint-entry-sheet .open-mint-form{")).toBeGreaterThan(OPEN_MINT_CSS.indexOf(".open-mint .open-mint-form{"));
    expect(OPEN_MINT_CSS.indexOf(".open-mint .mint-entry-sheet .open-mint-explanation{")).toBeGreaterThan(OPEN_MINT_CSS.indexOf(".open-mint .open-mint-explanation{"));
    expect(OPEN_MINT_CSS).not.toContain(".open-mint .auth-sheet{max-width:none");
    for (const pulseMint of [false, true]) {
      expect(mintPage("Alice", { pulseMint })).toContain('class="auth-sheet mint-entry-sheet"');
    }
    expect(assessmentPage(ready)).toContain('class="auth-sheet open-mint-progress"');
    expect(assessmentPage(ready)).not.toContain('class="auth-sheet mint-entry-sheet"');
    expect(errorPage("Unavailable")).not.toContain("mint-entry-sheet");
  });

  it("keeps the 1024px shell and responsive gutters around the 853px mint entry cap", () => {
    expect(SITE_CSS).toContain(".book-page{position:relative;width:100%;max-width:1024px;margin-inline:auto;--page-gutter:32px;");
    expect(SITE_CSS).toContain("html{font-size:16px;");
    expect(OPEN_MINT_CSS).toContain(".open-mint .mint-entry-sheet{max-width:853px}");
    expect(SITE_CSS).toContain(".auth-page{padding:5rem var(--page-gutter) 3rem}");
    expect(SITE_CSS).toContain(".auth-sheet{width:100%;max-width:42rem;margin-inline:auto;");
    expect(SITE_CSS).toContain("@media(max-width:600px){.book-page{--page-gutter:20px}");
    expect(OPEN_MINT_CSS).toContain("@media(max-width:480px){.open-mint [data-mint-entry]{padding-inline:24px}");
    const field = SITE_CONTROLS_CSS.split(`${SITE_FIELD_SELECTOR}{`)[1].split("}")[0];
    expect(field).toContain("width:100%;");
    expect(field).toContain("box-sizing:border-box;");
    expect(OPEN_MINT_CSS).not.toMatch(/\.open-mint \.mint-entry-sheet\{[^}]*\b(?:width|padding):(?:1024px|960px|0)/);
    expect(mintPage("Alice")).toContain('<body class="book-page open-mint"');
  });

  it.each([false, true])("keeps 14px section titles and enlarges only the handle text and placeholder to 48px (Pulse: %s)", pulseMint => {
    const html = mintPage("Alice", { pulseMint });
    const titles = [...html.matchAll(/<(?:span|h2)\b[^>]*class="mint-section-title"[^>]*>([^<]+)<\/(?:span|h2)>/g)]
      .map(match => match[1]);
    expect(titles).toEqual(["Choose any X handle.", "To your wallet", ...(pulseMint ? ["Mint availability", "Resolve previous mint"] : [])]);
    expect(html).toContain('<label for="open-handle"><span class="mint-section-title">Choose any X handle.</span><input');
    expect(html).toContain('aria-labelledby="recipient-heading"><h2 id="recipient-heading" class="mint-section-title"');
    expect(OPEN_MINT_CSS).toContain(".open-mint .mint-entry-sheet .mint-section-title{display:block;min-width:0;font-size:14px;font-weight:var(--ui-font-weight);line-height:1.6;");
    expect(OPEN_MINT_CSS).toContain(".open-mint .mint-entry-handle .open-handle-input{font-size:48px;line-height:1.35;height:90px}");
    expect(OPEN_MINT_CSS).toContain(".open-mint .mint-entry-handle .open-handle-input::placeholder{font-size:inherit}");
    expect(OPEN_MINT_CSS).not.toContain(".open-mint .open-handle-input{font-size:48px");
    expect(OPEN_MINT_CSS).not.toContain(".mint-entry-wallet h2{margin:0 0 .5rem;font-size:14px");
    expect(OPEN_MINT_CSS).not.toContain("[data-pulse-options] h2{font-size:14px");
    expect(SITE_CONTROLS_CSS.match(/font-size:16px;font-weight:var\(--ui-font-weight\)/g)).toHaveLength(2);
  });

  it("inherits the site-wide field and pill-button system throughout the mint flow", () => {
    const css = (SITE_CONTROLS_CSS + OPEN_MINT_CSS).replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map(([, selector, declarations]) => ({ selector: selector!.trim(), declarations: declarations! }));
    const declarations = (selector: string): string => {
      const matches = rules.filter(rule => rule.selector === selector);
      expect(matches.length, selector).toBeGreaterThan(0);
      return matches.map(rule => rule.declarations).join(";");
    };
    const buttonSelector = SITE_ACTION_SELECTOR;
    const field = declarations(SITE_FIELD_SELECTOR);
    for (const property of ["width:100%", "box-sizing:border-box", "height:48px", "min-height:48px",
      "padding:12px 0", "border:0", "border-bottom:1px solid var(--line)", "border-radius:0",
      "font-size:16px", "font-weight:var(--ui-font-weight)", "line-height:var(--control-line-height)", "letter-spacing:normal"]) {
      expect(field).toContain(property);
    }
    expect(field).not.toMatch(/clamp\(|box-shadow:(?!none)/);
    const fieldFeedback = declarations(`${SITE_FIELD_SELECTOR}:not(:disabled):is(:hover,:focus)`);
    expect(fieldFeedback).toContain("border-bottom-color:var(--ink)");
    const fieldFocus = declarations(`${SITE_FIELD_SELECTOR}:is(:focus,:focus-visible)`);
    expect(fieldFocus).toContain("outline:none;box-shadow:none");
    const buttonFocus = declarations(`${SITE_ACTION_SELECTOR}:focus-visible,body :is(input[type=radio],input[type=checkbox]):focus-visible`);
    expect(buttonFocus).toContain("outline:2px solid var(--ink)");
    expect(buttonFocus).toContain("outline-offset:4px");

    const button = declarations(buttonSelector);
    for (const property of ["min-height:48px", "padding:var(--control-padding)", "border:0", "border-radius:999px",
      "background:var(--ink)", "color:var(--paper)", "font-size:16px", "font-weight:var(--ui-font-weight)",
      "line-height:var(--control-line-height)", "box-shadow:none"]) {
      expect(button).toContain(property);
    }
    const buttonHover = declarations(`${buttonSelector}:not(:disabled):not([aria-disabled=true]):hover`);
    for (const property of ["background:var(--paper)", "color:var(--ink)", "box-shadow:inset 0 0 0 1px var(--ink)"]) {
      expect(buttonHover).toContain(property);
    }
    expect(declarations(`${buttonSelector}:is(:disabled,[aria-disabled=true])`))
      .toContain("opacity:.45");
    const label = declarations("body .auth-action>span:first-child");
    for (const property of ["border:0", "padding:0", "background:transparent"]) {
      expect(label).toContain(property);
    }
    // The earlier optical nudge is not part of the approved control study.
    expect(label).not.toContain("transform:");
    expect(declarations(`${SITE_ACTION_SELECTOR}>span:not(.action-tooltip)`))
      .toContain("font-size:inherit;font-weight:inherit;line-height:inherit");
    expect(OPEN_MINT_CSS).not.toContain("border-radius:999px");
    expect(OPEN_MINT_CSS).not.toContain("translateY(1px)");
    const pillRules = rules.filter(rule => /border-radius:999px|padding:12px 24px/.test(rule.declarations));
    expect(pillRules).toHaveLength(1);
    expect(pillRules[0]!.selector).toBe(buttonSelector);
    // The price ceiling must not retain a more specific rectangular-field override.
    expect(css).not.toContain(".mint-entry-ceiling [name=pulse-max-eth]{");
    expect(css).not.toContain(".mint-entry-action [data-request-submit]{");
    expect(declarations(`${SITE_FIELD_SELECTOR}:disabled`)).toContain("cursor:not-allowed");
    expect(OPEN_MINT_CSS).not.toContain("mint-entry-modes");

    const disconnected = mintPage("Alice", { pulseMint: true });
    const connected = mintPage("Alice", { pulseMint: true, wallet: "0x123", walletVerified: true });
    expect(disconnected).toContain('data-request-submit disabled><span>Mint &amp; reveal</span>');
    expect(connected).toContain('data-request-submit><span>Mint &amp; reveal</span>');
    for (const html of [disconnected, connected]) {
      expect(html).toContain('data-assessment-request data-pulse-mint="true"');
      expect(html).toContain('data-connect-wallet><span>');
      expect(html).toContain('data-pulse-check><span>Refresh price</span>');
      expect(html).toContain('class="open-handle-input" name="pulse-max-eth"');
      expect(html).toContain('class="auth-action" data-mint-result-link');
      expect(html).toContain('data-mint-another><span>Mint another signature</span>');
      expect(html).toContain('type="hidden" name="pulse-mode" value=""');
      expect(html).not.toMatch(/\bchecked(?:\s|=|>)/);
      expect(html.indexOf("Minting creates a permanent public token. Network gas is additional."))
        .toBeLessThan(html.indexOf("data-request-submit"));
    }
  });

  it.each([false, true])("keeps compact wallet identity, network and the styled connection control (verified: %s)", verified => {
    const options = { chainName: "Ethereum Sepolia", ...(verified ? { wallet: "0x123", walletVerified: true } : {}) };
    const html = mintPage("Alice", options);
    const wallet = html.match(/<section class="mint-entry-part mint-entry-wallet"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    expect(wallet).toContain('<h2 id="recipient-heading" class="mint-section-title">To your wallet</h2>');
    expect(wallet).toContain('<div data-wallet-controls><div class="mint-entry-wallet-summary">');
    expect(wallet).toContain(`data-wallet-label>${verified ? "0x123" : ""}</p>`);
    expect(wallet).toContain('Network: <span data-review-chain>Ethereum Sepolia</span>');
    expect(wallet).toContain(`type="button" data-connect-wallet><span>${verified ? "Change wallet" : "Connect wallet"}</span></button>`);
    expect(wallet).toContain('data-mint-feedback role="status" aria-live="polite"');
    expect(wallet).not.toContain('Connect the wallet that will receive the token.');
  });

  it("keeps payment consent and irreversible-mint disclosures visible before the artistic entry CTA", () => {
    const html = mintPage("Alice", { pulseMint: true, wallet: "0x123", walletVerified: true,
      pulseSaleNotice: "Free mint ended · 2/2 slots used.", pulseSaleStatus: { phase: "paid", paused: false, freeMinted: 2, freeMintQuota: 2 } });
    const form = html.match(/<form\b[^>]*data-assessment-request[^>]*>([\s\S]*?)<\/form>/)?.[1];
    expect(form).toBeDefined();
    expect(html).toContain('data-assessment-request data-pulse-mint="true"');
    expect(form?.match(/<input\b[^>]*name="pulse-mode"[^>]*>/g)).toHaveLength(1);
    expect(form).toContain('type="hidden" name="pulse-mode" value=""');
    expect(form).not.toContain('type="radio"');
    expect(form).not.toContain('Choose how to mint');
    expect(form).toContain('name="pulse-max-eth" inputmode="decimal" placeholder="Your ceiling" disabled aria-describedby="mint-price-note"');
    for (const disclosure of ["Maximum mint price (ETH)", "Paid mint sends your ceiling; unused ETH is refunded.",
      "Grok chooses the final signature.", "Reveal after minting.",
      "Minting creates a permanent public token. Network gas is additional."]) {
      expect(form).toContain(disclosure);
      expect(form!.indexOf(disclosure)).toBeLessThan(form!.indexOf('data-request-submit'));
    }
    expect(form).toContain('data-pulse-check><span>Refresh price</span>');
    expect(form).toContain('data-pulse-sale-status role="status" aria-atomic="true">Free mint ended · 2/2 slots used.');
    expect(form).toContain('data-request-submit><span>Mint &amp; reveal</span>');
    expect(form).not.toMatch(/<details\b|<summary\b|checkbox/);
    expect(form).toContain('data-pulse-free hidden>No mint fee.');
  });

  it("places the one conditional operational warning immediately beneath the mint CTA", () => {
    const notice = "Mint availability cannot be checked right now. Please try again shortly.";
    for (const value of [undefined, notice]) {
      const html = mintPage("Alice", { mintObservationNotice: value });
      const warning = html.match(/<p class="open-preview-notice open-preview-warning"[^>]*data-mint-observation-warning[^>]*>([\s\S]*?)<\/p>/)?.[0];
      expect(warning).toBeDefined();
      expect(html.match(/data-mint-observation-warning/g)).toHaveLength(1);
      expect(warning).toContain(`data-mint-observation-warning role="status"${value ? "" : " hidden"}`);
      expect(warning).toContain(`<span data-mint-observation-message>${value ?? ""}</span>`);
      const form = html.match(/<form\b[^>]*data-assessment-request[^>]*>([\s\S]*?)<\/form>/)?.[1];
      expect(form?.trim()).toMatch(/^<section class="mint-entry-part mint-entry-handle"/);
      expect(form).toContain(warning);
      expect(form!.indexOf('data-request-submit')).toBeLessThan(form!.indexOf('data-mint-observation-warning'));
      expect(form!.indexOf('data-mint-observation-warning')).toBeLessThan(form!.indexOf('id="request-feedback"'));
      expect(form).toContain('aria-describedby="mint-explanation mint-observation-warning request-feedback"');
      expect(warning).toContain('id="mint-observation-warning" aria-live="polite"');
      expect(form).toContain('class="mint-entry-submit" data-mint-action-notice');
      expect(html).toContain('<div data-mint-result-notice></div>');
      expect(html.match(/id="mint-observation-warning"/g)).toHaveLength(1);
    }
  });

  it("provides explicit Pulse recovery beside the mint CTA with optional inline-validated transaction input", () => {
    const html = mintPage("Alice", { pulseMint: true });
    const form = html.match(/<form\b[^>]*data-assessment-request[^>]*>([\s\S]*?)<\/form>/)?.[1]!;
    expect(form).toContain('data-mint-recovery hidden aria-label="Resolve previous mint"');
    expect(form).toContain('data-mint-recovery-check><span>Check previous mint</span>');
    expect(form).toContain('data-mint-recovery-transaction><span>Check transaction</span>');
    expect(form.indexOf('data-request-submit')).toBeLessThan(form.indexOf('data-mint-recovery hidden'));
    expect(form).toContain('<span data-mint-recovery-handle></span>');
    const hash = form.match(/<input\b[^>]*name="mint-recovery-hash"[^>]*>/)?.[0]!;
    expect(hash).toContain('type="text"');
    expect(hash).toContain('aria-describedby="mint-recovery-feedback"');
    expect(hash).not.toMatch(/\bpattern=|\brequired\b/);
    expect(form).toContain('data-mint-recovery-feedback role="status" aria-live="polite"');
    expect(form).toContain('data-mint-retry-note hidden');
    expect(mintPage("Alice")).not.toContain('data-mint-recovery');
  });

  it.each(MBTI_TYPES)("renders only the chosen %s preview and bridges with handle only", mbti => {
    const html = previewPage("Alice_Bob_Key", mbti);
    const main = html.match(/<main>([\s\S]*?)<\/main>/)![1]!;
    expect(main.match(/<img\b/g)).toHaveLength(1);
    expect(main).toContain(`src="/preview/Alice_Bob_Key/${mbti}.svg?renderer=${RENDERER_VERSION}"`);
    expect(main).not.toContain(`src="/preview/Alice_Bob_Key/${mbti}.svg"`);
    expect(main).not.toContain('renderer=sg-renderer-1.0.0');
    expectHandleNavigation(main, "Alice_Bob_Key", 1);
    expect(main).toContain(`<a class="mbti-link" href="/${mbti}/">${mbti}</a>`);
    const captions = artworkCaptions(main);
    expect(captions).toHaveLength(1);
    expectArtworkIdentity(captions[0]!, "Alice_Bob_Key", mbti, "Preview");
    expect(main.indexOf('<figure')).toBeLessThan(main.indexOf('class="artwork-caption'));
    expect(main).toContain('href="/mint?handle=Alice_Bob_Key"><span>Mint for this handle →');
    expect(main).toContain('Change the MBTI in the URL to explore');
    expect(main).toContain('href="/p/Alice_Bob_Key/variations">View all 16 variations</a>');
    expect(main).not.toMatch(/data-assessment-request|data-assessment-code|data-mint-form|data-connect-wallet|data-token-id|Provenance/);
    expect(main).not.toContain('href="/mint?handle=Alice_Bob_Key&amp;');
  });

  it("validates preview handles and types even if called outside the router", () => {
    expect(previewPage("@Agent_Art", "ENFP")).toContain('/preview/Agent_Art/ENFP.svg');
    expect(() => previewPage('<img src=x>', "ENFP")).toThrow();
    expect(() => previewPage('Agent_Art', "enfp" as "ENFP")).toThrow();
    expect(() => previewPage('Agent_Art', "17" as "ENFP")).toThrow();
  });

  it("renders exactly 16 named preview variations with case-preserved artwork and detail links", () => {
    const html = previewVariationsPage("Alice_Bob_Key");
    const main = html.match(/<main>([\s\S]*?)<\/main>/)![1]!;
    expect(main).toContain('data-preview-variations');
    expect(main).toContain('class="open-preview-grid"');
    expect(main).toContain('16 variations');
    expectHandleNavigation(main, "Alice_Bob_Key", 17);
    expect(main.match(/<span class="signature-tag artwork-status">Preview<\/span>/g)).toHaveLength(16);
    expect(main.match(/<img\b/g)).toHaveLength(16);
    const previewLinks = [...main.matchAll(/href="(\/p\/Alice_Bob_Key\/[A-Z]{4})"/g)].map(match => match[1]);
    expect(previewLinks).toHaveLength(16);
    expect(new Set(previewLinks)).toEqual(new Set(MBTI_TYPES.map(mbti => `/p/Alice_Bob_Key/${mbti}`)));
    for (const mbti of MBTI_TYPES) {
      expect(main).toContain(`src="/preview/Alice_Bob_Key/${mbti}.svg?renderer=${RENDERER_VERSION}"`);
      const card = main.match(new RegExp(`<a\\b[^>]*href="/p/Alice_Bob_Key/${mbti}"[^>]*>[\\s\\S]*?</a>`))?.[0];
      expect(card).toBeDefined();
      expect(card).toMatch(/<img\b[^>]*alt="[^"]+"/);
      expect(card).toContain(`aria-label="Explore ${mbti} for @Alice_Bob_Key"`);
      expect(card).not.toContain('mbti-link');
      const caption = artworkCaptions(main).find(value => value.includes(`href="/${mbti}/"`));
      expect(caption).toBeDefined();
      expectArtworkIdentity(caption!, "Alice_Bob_Key", mbti, "Preview");
      expect(caption).toContain('class="gallery-handle" href="/p/Alice_Bob_Key/variations"');
    }
    expect(main.match(/class="mbti-link"/g)).toHaveLength(16);
    expect(main).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
    const imageUrls = [...main.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map(match => match[1]);
    expect(imageUrls).toEqual(previewRows.flat().map(mbti => `/preview/Alice_Bob_Key/${mbti}.svg?renderer=${RENDERER_VERSION}`));
    expect(main).not.toMatch(/src="\/preview\/[^"?]+\.svg"/);
    expect(main).not.toContain('renderer=sg-renderer-1.0.0');
    expect(main).not.toMatch(/data-assessment-request|data-assessment-code|data-mint-form|data-connect-wallet|data-token-id|Provenance|\/signatures\//);
    expect(main).not.toContain('mbti=');
  });

  it.each(["unminted", "pending", "unavailable", "minted", "fixture"] as const)("labels each %s variation below its image without putting Preview in the page header", state => {
    const hasMintedArtwork = state === "minted" || state === "fixture";
    const context: PublicPreviewState = hasMintedArtwork ? { ...publicMint, state } : { state };
    const html = previewVariationsPage("Alice_Bob_Key", { development: { fixture: state === "fixture" } }, context);
    const main = html.match(/<main>([\s\S]*?)<\/main>/)![1]!;
    const header = main.match(/<header class="signature-heading">([\s\S]*?)<\/header>/)![1]!;
    const previewTags = [...main.matchAll(/<(a|span)\b([^>]*)>Preview<\/\1>/g)];

    expect(previewTags).toHaveLength(hasMintedArtwork ? 15 : 16);
    for (const [tag] of previewTags) expect(tag).toBe('<span class="signature-tag artwork-status">Preview</span>');
    expect(header).not.toContain('signature-tag');
    expectHandleNavigation(header, "Alice_Bob_Key", 1);
    expectHandleNavigation(main, "Alice_Bob_Key", 17);
    expect(main.match(/<img\b/g)).toHaveLength(16);
    expect(main.match(/>Minted<\/(?:a|span)>/g) ?? []).toHaveLength(hasMintedArtwork ? 1 : 0);
    expect(main.match(/data-preview-minted=/g) ?? []).toHaveLength(hasMintedArtwork ? 1 : 0);
    const captions = artworkCaptions(main);
    expect(captions).toHaveLength(16);
    for (const [index, caption] of captions.entries()) {
      const mbti = previewRows.flat()[index]!;
      expectArtworkIdentity(caption, "Alice_Bob_Key", mbti, hasMintedArtwork && mbti === publicMint.mbti ? "Minted" : "Preview");
    }
    const tiles = [...main.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map(match => match[0]);
    expect(tiles).toHaveLength(16);
    for (const tile of tiles) {
      expect(tile.indexOf('<img ')).toBeLessThan(tile.indexOf('artwork-caption'));
      expect(tile.indexOf('artwork-caption')).toBeLessThan(tile.indexOf('artwork-status'));
      expect(tile).toMatch(/<\/a><div class="artwork-caption/);
    }
  });

  it("pairs I/E variations in four rows without changing the renderer's canonical order", () => {
    const html = previewVariationsPage("Alice_Bob_Key");
    const types = [...html.matchAll(/href="\/p\/Alice_Bob_Key\/([A-Z]{4})"/g)].map(match => match[1]!);
    const rows = Array.from({ length: 4 }, (_, row) => types.slice(row * 4, row * 4 + 4));
    expect(types).toHaveLength(16);
    expect(rows).toEqual(previewRows);
    for (const row of rows) {
      expect(row.map(mbti => mbti[0])).toEqual(["I", "E", "I", "E"]);
      expect(row[0]!.slice(1)).toBe(row[1]!.slice(1));
      expect(row[2]!.slice(1)).toBe(row[3]!.slice(1));
    }
    expect(MBTI_TYPES).toEqual([
      "ISTJ", "ISFJ", "INFJ", "INTJ", "ISTP", "ISFP", "INFP", "INTP",
      "ESTP", "ESFP", "ENFP", "ENTP", "ESTJ", "ESFJ", "ENFJ", "ENTJ",
    ]);
  });

  it.each(["unminted", "pending", "unavailable", "minted", "fixture"] as const)("separates the permanent variations introduction from conditional %s notices", state => {
    const hasMintedArtwork = state === "minted" || state === "fixture";
    const context: PublicPreviewState = hasMintedArtwork ? { ...publicMint, state } : { state };
    const options = { development: { fixture: state === "fixture" } };
    const grid = previewVariationsPage("Alice_Bob_Key", options, context);
    const introduction = '<p class="open-preview-intro" data-preview-intro>One handle, all 16 MBTI interpretations. Choose a variation to explore.</p>';
    expect(grid.split(introduction)).toHaveLength(2);
    expect(grid.match(/data-preview-intro/g)).toHaveLength(1);
    expect(grid.indexOf(introduction)).toBeLessThan(grid.indexOf('<ul class="open-preview-grid"'));
    const mintedNotes = [...grid.matchAll(/<p\b[^>]*data-preview-minted-note[^>]*>([\s\S]*?)<\/p>/g)];
    expect(mintedNotes).toHaveLength(hasMintedArtwork ? 1 : 0);
    if (hasMintedArtwork) {
      expect(mintedNotes[0]![0]).toContain('class="open-preview-note"');
      expect(mintedNotes[0]![1]).toBe("One minted signature. Fifteen alternative interpretations, for exploration only.");
      expect(mintedNotes[0]![0]).not.toMatch(/open-preview-warning|open-preview-notice-label|role=/);
      expect(grid.indexOf(introduction)).toBeLessThan(grid.indexOf(mintedNotes[0]![0]));
    }

    for (const html of [grid, previewPage("Alice_Bob_Key", "ENFP", options, context)]) {
      const notices = [...html.matchAll(/<p\b[^>]*data-preview-status[^>]*>[\s\S]*?<\/p>/g)].map(match => match[0]);
      expect(notices).toHaveLength(state === "pending" ? 1 : 0);
      expect(html).not.toContain('data-preview-renderer-notice');
      expect(html).not.toContain('class="open-preview-notice open-preview-warning"');
      expect(html).not.toContain('<strong class="open-preview-notice-label">Warning</strong>');
      if (state === "pending") {
        expect(notices[0]).toContain('class="open-preview-notice"');
        expect(notices[0]).toContain('<strong class="open-preview-notice-label">Pending</strong>');
        expect(notices[0]).toContain('Mint submitted. Waiting for confirmation.');
      }
      for (const notice of notices) {
        expect(notice).toContain('role="status"');
        expect(notice).not.toMatch(/data-preview-intro|class="open-preview-intro"|role="alert"/);
        expect(html).not.toMatch(/href="\/mint|Mint for this handle|data-connect-wallet/);
      }
    }
  });

  it("keeps warnings compact and unfilled without losing their conditional status label", () => {
    expect(OPEN_MINT_CSS).toContain('.open-mint :is(.open-preview-warning,.provenance-caveats){--preview-warning:#806014;border-inline-start:1px solid var(--preview-warning);background:transparent;padding:.15rem 0 .15rem .65rem;color:var(--ink);font-size:.9em}');
    expect(OPEN_MINT_CSS).toContain('.open-mint :is(.open-preview-warning,.provenance-caveats) .open-preview-notice-label{display:inline;font-weight:500;color:var(--preview-warning)}');
    expect(OPEN_MINT_CSS).toContain('.open-mint :is(.open-preview-warning,.provenance-caveats) .open-preview-notice-label::after{content:":"}');
    expect(OPEN_MINT_CSS).toContain('@media(prefers-color-scheme:dark){.open-mint :is(.open-preview-warning,.provenance-caveats){--preview-warning:#c6a65a}}');
    expect(mintPage('Alice', { mintObservationNotice: 'Mint availability cannot be checked right now.' }))
      .toContain('class="open-preview-notice open-preview-warning" data-mint-observation-warning role="status"');
  });

  it.each(MBTI_TYPES)("keeps all 16 variations in order and marks only the archived %s mint", mbti => {
    const state = { ...publicMint, mbti };
    const html = previewVariationsPage("alice_bob_key", {}, state);
    const main = html.match(/<main>([\s\S]*?)<\/main>/)![1]!;
    const tiles = [...main.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map(match => match[0]);
    expect(main).toContain('data-preview-mint-state="minted"');
    expect(main).toContain("One minted signature. Fifteen alternative interpretations, for exploration only.");
    expectHandleNavigation(main, "Alice_Bob_Key", 17);
    expect(tiles).toHaveLength(16);
    expect(tiles.map(tile => tile.match(/class="mbti-link" href="\/([A-Z]{4})\/"/)![1])).toEqual(previewRows.flat());
    const selected = tiles[previewRows.flat().indexOf(mbti)]!;
    expect(selected).toContain(`class="open-preview-minted" data-preview-minted="${mbti}"`);
    expect(selected).toContain('class="open-preview-card" href="/signatures/alice_bob_key"');
    expect(selected).toContain('src="/art/archived-mint.svg"');
    expect(selected).toMatch(/<a class="[^"]*artwork-status[^"]*open-preview-minted-badge[^"]*" href="\/">Minted<\/a>/);
    expectArtworkIdentity(artworkCaptions(selected)[0]!, "Alice_Bob_Key", mbti, "Minted");
    expect(selected).not.toContain('/preview/');
    for (const [index, tile] of tiles.entries()) {
      if (tile === selected) continue;
      const type = previewRows.flat()[index]!;
      expect(tile).toContain(`href="/p/Alice_Bob_Key/${type}"`);
      expect(tile).toContain(`src="/preview/Alice_Bob_Key/${type}.svg?renderer=${RENDERER_VERSION}"`);
      expect(tile).not.toContain("open-preview-minted");
      expectArtworkIdentity(artworkCaptions(tile)[0]!, "Alice_Bob_Key", type, "Preview");
    }
    expect(main.match(/data-preview-minted=/g)).toHaveLength(1);
    expect(main).toContain('href="/signatures/alice_bob_key"><span>View minted signature</span>');
    expect(main).not.toMatch(/href="\/mint|Mint for this handle|data-connect-wallet|data-assessment-code/);
    expect(main).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
  });

  it("uses the saved work for the minted single preview and keeps alternatives labeled Preview", () => {
    for (const mbti of MBTI_TYPES) {
      const html = previewPage("ALICE_BOB_KEY", mbti, {}, publicMint);
      expect(html).toContain('data-preview-mint-state="minted"');
      expectHandleNavigation(html, "Alice_Bob_Key", 1);
      expect(html).toContain('href="/p/Alice_Bob_Key/variations"');
      expect(html).toContain('href="/signatures/alice_bob_key"><span>View minted signature</span>');
      expect(html).not.toMatch(/href="\/mint|Mint for this handle/);
      if (mbti === publicMint.mbti) {
        expect(html).toContain('src="/art/archived-mint.svg"');
        expectArtworkIdentity(artworkCaptions(html)[0]!, "Alice_Bob_Key", mbti, "Minted");
        expect(html).toContain('The minted signature, shown from its saved artwork.');
        expect(html).not.toContain('/preview/');
      } else {
        expect(html).toContain(`src="/preview/Alice_Bob_Key/${mbti}.svg?renderer=${RENDERER_VERSION}"`);
        expectArtworkIdentity(artworkCaptions(html)[0]!, "Alice_Bob_Key", mbti, "Preview");
        expect(html).toContain('An alternative interpretation, for exploration only.');
        expect(html).not.toContain('/art/archived-mint.svg');
      }
    }
  });

  it("compares legacy minted work with its saved renderer instead of silently upgrading it", () => {
    const legacy: PublicPreviewState = { ...publicMint, renderHandle: "alice_bob_key", rendererVersion: "sg-renderer-1.0.0" };
    const grid = previewVariationsPage("Alice_Bob_Key", {}, legacy);
    const urls = [...grid.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map(match => match[1]);
    expect(urls).toEqual(previewRows.flat().map(mbti => mbti === publicMint.mbti ? "/art/archived-mint.svg" : `/preview/alice_bob_key/${mbti}.svg?renderer=sg-renderer-1.0.0`));
    for (const html of [grid, previewPage("Alice_Bob_Key", "ENFP", {}, legacy), previewPage("Alice_Bob_Key", "INTJ", {}, legacy)]) {
      expect(html).toContain('data-preview-renderer-notice');
      expect(html).toMatch(/<p class="open-preview-notice"[^>]*data-preview-renderer-notice[^>]*><strong class="open-preview-notice-label">Renderer<\/strong>/);
      expect(html).not.toContain('class="open-preview-notice open-preview-warning"');
      expect(html).not.toContain('<strong class="open-preview-notice-label">Warning</strong>');
      expect(html).toContain('This signature uses an earlier renderer (sg-renderer-1.0.0).');
      expect(html).toContain('Alternatives use that same renderer for comparison.');
      expect(html).toContain('The minted artwork remains the saved original.');
      expect(html).not.toContain('renderer=sg-renderer-2.0.0');
      expectHandleNavigation(html, "alice_bob_key", html === grid ? 17 : 1);
    }
    expect(previewVariationsPage("Alice_Bob_Key", {}, publicMint)).not.toContain('data-preview-renderer-notice');
  });

  it.each(["pending", "unavailable"] as const)("leaves %s previews exploratory without a chosen result or mint CTA", state => {
    const context: PublicPreviewState = { state };
    const grid = previewVariationsPage("aLiCe_BoB_KeY", {}, context);
    expect(grid.match(/<img\b/g)).toHaveLength(16);
    for (const mbti of MBTI_TYPES) {
      expect(grid).toContain(`href="/p/aLiCe_BoB_KeY/${mbti}"`);
      expect(grid).toContain(`src="/preview/aLiCe_BoB_KeY/${mbti}.svg?renderer=${RENDERER_VERSION}"`);
    }
    for (const html of [grid, previewPage("aLiCe_BoB_KeY", "INTJ", {}, context)]) {
      expect(html).toContain(`data-preview-mint-state="${state}"`);
      expect(html).toContain('>Preview</span>');
      expectHandleNavigation(html, "aLiCe_BoB_KeY", html === grid ? 17 : 1);
      if (state === "pending") expect(html).toContain("Mint submitted. Waiting for confirmation.");
      else expect(html).not.toMatch(/Mint status cannot be verified|open-preview-warning|data-mint-observation-warning/);
      expect(html).not.toMatch(/href="\/mint|Mint for this handle|View minted signature|data-preview-minted=|\/art\/|\/signatures\//);
      expect(html).not.toMatch(/No signatures minted|One minted signature|data-token-id|data-assessment-code/);
    }
    expect(artworkCaptions(grid)).toHaveLength(16);
    for (const [index, caption] of artworkCaptions(grid).entries()) expectArtworkIdentity(caption, "aLiCe_BoB_KeY", previewRows.flat()[index]!, "Preview");
    expectArtworkIdentity(artworkCaptions(previewPage("aLiCe_BoB_KeY", "INTJ", {}, context))[0]!, "aLiCe_BoB_KeY", "INTJ", "Preview");
  });

  it("uses production preview copy and paths while limiting samples to fixture mode", () => {
    const fixture: PublicPreviewState = { ...publicMint, state: "fixture", imageUrl: `/preview/Alice_Bob_Key/INTJ.svg?renderer=${RENDERER_VERSION}`, url: "/signatures/alice_bob_key" };
    const options = { development: { fixture: true } };
    expect(() => previewVariationsPage("Alice_Bob_Key", {}, fixture)).toThrow("Gallery samples require fixture mode");
    expect(() => previewPage("Alice_Bob_Key", "INTJ", {}, fixture)).toThrow("Gallery samples require fixture mode");
    const grid = previewVariationsPage("alice_bob_key", options, fixture);
    const selected = previewPage("alice_bob_key", "INTJ", options, fixture);
    expect(grid).toContain("One minted signature. Fifteen alternative interpretations, for exploration only.");
    expect(selected).toContain("The minted signature, shown from its saved artwork.");
    for (const html of [grid, selected]) {
      expect(html).toContain('data-preview-mint-state="fixture"');
      expect(html).toContain('>Minted</a>');
      expectNoDevelopmentChrome(html);
      expect(html).toContain('href="/signatures/alice_bob_key"');
      expect(html).not.toMatch(/href="\/mint|data-token-id|View token/);
    }
    const alternative = previewPage("Alice_Bob_Key", "ENFP", options, fixture);
    expectArtworkIdentity(artworkCaptions(alternative)[0]!, "Alice_Bob_Key", "ENFP", "Preview");
    expectNoDevelopmentChrome(alternative);
    expect(alternative).not.toMatch(/>Minted<\/(?:span|a)>/);
  });

  it("validates minted identity and keeps markup from artifact URLs escaped", () => {
    expect(() => previewVariationsPage("other", {}, publicMint)).toThrow("does not match");
    expect(() => previewPage("other", "INTJ", {}, publicMint)).toThrow("does not match");
    const unsafe: PublicPreviewState = { ...publicMint, imageUrl: "javascript:boom()", url: "javascript:boom()" };
    for (const html of [previewVariationsPage("Alice_Bob_Key", {}, unsafe), previewPage("Alice_Bob_Key", "INTJ", {}, unsafe)]) {
      expect(html).not.toContain("javascript:");
      expect(html).toContain('src="#"');
      expect(html).toContain('href="#"');
    }
    const escaped: PublicPreviewState = { ...publicMint, imageUrl: '/art/minted.svg?x="&q=1' };
    expect(previewPage("Alice_Bob_Key", "INTJ", {}, escaped)).toContain('src="/art/minted.svg?x=&quot;&amp;q=1"');
  });

  it("marks the minted tile with a thin outline and keeps alternative artwork in full color", () => {
    expect(OPEN_MINT_CSS).toContain('.open-mint .open-preview-minted>.open-preview-card{outline:1px solid var(--ink);outline-offset:4px}');
    expect(OPEN_MINT_CSS).not.toMatch(/(?:open-preview-card|open-preview-grid)[^{]*\{[^}]*(?:filter:|opacity:)/);
  });

  it("validates variations handles and keeps developer wallet actions outside preview exploration", () => {
    const options = { development: { fixture: true, localChain: true } };
    const html = previewVariationsPage("@Agent_Art", options);
    expect(html).toContain('/p/Agent_Art/ENFP');
    expect(html).toContain('/preview/Agent_Art/ENFP.svg');
    expect(html).not.toContain('data-dev-wallet');
    expect(html).not.toContain('data-dev-mint');
    for (const handle of ['', '<img src=x>', 'agent/art', 'a'.repeat(16), 'alice?mbti=ENFP']) {
      expect(() => previewVariationsPage(handle)).toThrow();
    }
  });

  it("shows only minted entries on home and collection, never pending or cancelled attempts", () => {
    const entries: GalleryEntry[] = [entry, { ...entry, handle: "pending", renderHandle: "Pending", imageUrl: "/art/pending.svg", mint: { state: "pending" } }, { ...entry, handle: "cancelled", renderHandle: "Cancelled", imageUrl: "/art/cancelled.svg", mint: { state: "unminted" } }, { ...entry, handle: "unverified", renderHandle: "Unverified", imageUrl: "/art/unverified.svg", mint: undefined }];
    for (const html of [homePage({}, entries), collectionPage(entries)]) {
      expect(html.match(/class="gallery-item"/g)).toHaveLength(1);
      expect(html).toContain('alt="Signature for @Alice_Bob_Key × INTJ"');
      expect(html).toContain('class="gallery-handle" href="/p/Alice_Bob_Key/variations"');
      expect(html).toContain('href="/signatures/alice_bob_key"');
      expect(html).toContain('<a class="mbti-link" href="/INTJ/">INTJ</a>');
      expect(html).not.toMatch(/\/art\/(?:pending|cancelled|unverified)\.svg/);
    }
    expect(homePage({}, entries.slice(1))).toContain('No signatures minted yet.');
    const legacy = collectionPage([{ ...entry, renderHandle: undefined }]);
    expect(legacy).toContain('alt="Signature for @alice_bob_key × INTJ"');
    expect(legacy).toContain('href="/signatures/alice_bob_key"');
    expect(legacy).toContain('class="gallery-handle" href="/p/alice_bob_key/variations"');
  });

  it.each(["home", "MBTI", "collection"])("immediately shows verified confirming artwork in %s with an honest nonfinal label", kind => {
    const entries: GalleryEntry[] = [{ ...entry, mint: { state: "confirming" } }];
    const html = kind === "home" ? homePage({}, entries) : kind === "MBTI" ? mbtiGalleryPage("INTJ", entries) : collectionPage(entries);
    expect(html).toContain('class="gallery-item" data-mint-state="confirming"');
    expect(html).toContain('src="/art/test.svg"');
    expect(html).toContain('artwork-confirming">Confirming</span>');
    expect(html).not.toContain('>Minted</a>');
    expect(html).not.toMatch(/No signatures minted|no minted signatures/);
  });

  it.each(["home", "MBTI", "collection"])("retains finalized Minted in %s without a viewing network warning", kind => {
    const entries: GalleryEntry[] = [{ ...entry, mintObservationUnavailable: true }];
    const render = (items: GalleryEntry[]) => kind === "home" ? homePage({}, items) : kind === "MBTI" ? mbtiGalleryPage("INTJ", items) : collectionPage(items);
    const html = render(entries);
    expect(html).toContain('class="gallery-item" data-mint-state="minted"');
    expect(html).toContain('src="/art/test.svg"');
    expect(html).toContain('href="/">Minted</a>');
    expect(html).not.toMatch(/>Status unavailable<|>Confirming</);
    expect(html).not.toContain('data-mint-observation-warning');
    expect(html).not.toContain('Live network checks are temporarily unavailable.');
    expect(html).not.toContain('<strong class="open-preview-notice-label">Warning</strong>');
    for (const patch of [{ mint: { state: "confirming" as const } }, { mintEvidenceInvalidated: true }]) {
      const uncertain = render([{ ...entries[0], ...patch }]);
      expect(uncertain).toContain('data-mint-state="unknown"');
      expect(uncertain).toContain('>Status unavailable</span>');
      expect(uncertain).not.toContain('>Minted</a>');
    }
    for (const state of ["unknown", "unminted", "pending"] as const) {
      expect(render([{ ...entry, mintObservationUnavailable: true, mint: { state } }])).not.toContain('src="/art/test.svg"');
    }
  });

  it("keeps a previously verified detail visible with a status recheck, but never reveals an unverified assessment", () => {
    const final = assessmentPage({ ...minted, mintObservationUnavailable: true });
    expect(final).toContain('class="signature-page" data-mint-state="minted"');
    expect(final).toContain('>Minted</a>');
    expect(final).not.toContain('data-reveal-monitor');
    expect(final).not.toContain('data-mint-observation-warning');
    const result = revealedSignature({ ...minted, mint: { state: "confirming" }, mintObservationUnavailable: true });
    expect(result).toContain('data-mint-state="unknown" data-reveal-monitor');
    expect(result).toContain('>Status unavailable</span>');
    expect(result).not.toContain('Its current mint status cannot be checked right now.');
    expect(result).toContain(`src="${minted.svgUrl}"`);
    const conflict = revealedSignature({ ...minted, mintEvidenceInvalidated: true });
    expect(conflict).toContain('data-mint-state="unknown" data-reveal-monitor');
    expect(conflict).not.toContain('>Minted</a>');
    for (const state of ["unknown", "unminted", "pending"] as const) {
      expect(() => revealedSignature({ ...minted, mintObservationUnavailable: true, mint: { state } })).toThrow(/verified successful inclusion/);
    }
  });

  it('escapes network warning copy and keeps its single shared mount hidden when healthy', () => {
    const page = mintPage('Alice', { mintObservationNotice: '<script>not markup</script>' });
    expect(page).toContain('&lt;script&gt;not markup&lt;/script&gt;');
    expect(page.match(/data-mint-observation-warning/g)).toHaveLength(1);
    expect(mintPage()).toContain('data-mint-observation-warning role="status" hidden');
  });

  it('keeps every viewing surface quiet even when a caller supplies operational warning copy', () => {
    const notice = 'Gallery updates could not be checked. Previously verified signatures are shown.';
    const options = { mintObservationNotice: notice };
    const item = { ...entry, mintObservationUnavailable: true, mintEvidenceInvalidated: true };
    for (const html of [homePage(options, [item]), mbtiGalleryPage('INTJ', [item], options),
      collectionPage([item], options), assessmentPage({ ...minted, mintEvidenceInvalidated: true }, options),
      previewPage('Alice', 'INTJ', options, { state: 'unavailable' }), previewVariationsPage('Alice', options, { state: 'unavailable' })]) {
      expect(html).not.toContain(notice);
      expect(html).not.toContain('data-mint-observation-warning');
      expect(html).not.toContain('<strong class="open-preview-notice-label">Warning</strong>');
    }
    for (const html of [homePage(options), mbtiGalleryPage('INTJ', [], options)]) {
      expect(html).toContain('Checking for minted signatures…');
      expect(html).not.toContain('No signatures minted');
    }
    expect(collectionPage([], { ...options, wallet: '0xwallet' })).not.toContain('This wallet has no minted signatures yet.');
  });

  it('mounts exactly one warning for active assessment progress and unfinished mint results only', () => {
    const notice = 'Mint availability cannot be checked right now. Please try again shortly.';
    const progress = assessmentPage({ ...ready, mint: { state: 'pending' } }, { mintObservationNotice: notice });
    expect(progress.match(/data-mint-observation-warning/g)).toHaveLength(1);
    expect(progress).toContain(notice);
    const model = { ...minted, mint: { state: 'confirming' as const }, mintObservationUnavailable: true };
    const active = assessmentPage(model, { mintProcess: true });
    expect(active).toContain('<section data-mint-process>');
    expect(active.match(/data-mint-observation-warning/g)).toHaveLength(1);
    expect(active).toContain('Your signature is revealed, but confirmation could not be checked. Please do not submit another mint.');
    expect(assessmentPage(model)).not.toContain('data-mint-observation-warning');
    expect(assessmentPage({ ...minted, mintObservationUnavailable: true }, { mintProcess: true }))
      .toContain('data-mint-observation-warning role="status" hidden');
  });

  it("provides an initially empty inline mint result and shares the verified reveal with the detail page", () => {
    const initial = mintPage("Alice_Bob_Key");
    expect(initial).toContain('data-mint-result hidden tabindex="-1"');
    expect(initial).toContain('<div data-mint-result-artwork></div>');
    expect(initial).not.toContain(minted.svgUrl);
    for (const state of ["confirming", "minted"] as const) {
      const model = { ...minted, mint: { state } };
      const result = revealedSignature(model);
      expect(assessmentPage(model)).toContain(result.replace('<!--mint-observation-warning-->', ''));
      expect(result).toContain(`data-mint-state="${state}"`);
      expect(result).toContain(`src="${minted.svgUrl}"`);
      expect(result).not.toMatch(/gallery once confirmed|not yet in the gallery/);
    }
    for (const state of ["unknown", "unminted", "pending"] as const) {
      expect(() => revealedSignature({ ...minted, mint: { state } })).toThrow(/verified successful inclusion/);
    }
  });

  it("shows only existing minted signatures with the exact requested MBTI", () => {
    const entries: GalleryEntry[] = [
      entry,
      { ...entry, handle: "other", renderHandle: "Other", mbti: "ENFP", imageUrl: "/art/other.svg" },
      { ...entry, handle: "pending", renderHandle: "Pending", imageUrl: "/art/pending.svg", mint: { state: "pending" } },
      { ...entry, handle: "unminted", renderHandle: "Unminted", imageUrl: "/art/unminted.svg", mint: { state: "unminted" } },
      { ...entry, handle: "unverified", renderHandle: "Unverified", imageUrl: "/art/unverified.svg", mint: undefined },
      { ...entry, handle: "lowercase", renderHandle: "Lowercase", imageUrl: "/art/lowercase.svg", mbti: "intj" },
      { ...entry, handle: "existing", renderHandle: "Existing", imageUrl: "/art/frozen.svg", url: "/signatures/existing" },
    ];
    const original = structuredClone(entries);
    const html = mbtiGalleryPage("INTJ", entries);
    expect(html).toContain('<title>Signatures × INTJ · Signatures Gallery</title>');
    expect(html).toContain('<section class="collection-page" data-mbti-gallery="INTJ">');
    expect(html).toContain('<h1>Signatures × INTJ</h1>');
    expect(html).toContain(HOME_LINK);
    expect(html.match(/class="gallery-item"/g)).toHaveLength(2);
    expect(html).toContain('class="gallery-handle" href="/p/Alice_Bob_Key/variations"');
    expect(html).toContain('href="/signatures/alice_bob_key"');
    expect(html).toContain('src="/art/test.svg"');
    expect(html).toContain('href="/signatures/existing"');
    expect(html).toContain('src="/art/frozen.svg"');
    expect(html).not.toMatch(/\/art\/(other|pending|unminted|unverified|lowercase)\.svg/);
    expect(html).not.toMatch(/slogan-heading|data-slogan-frame|\/preview\/|data-connect-wallet|data-assessment-request/);
    expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
    expect(entries).toEqual(original);
  });

  it.each(MBTI_TYPES)("groups gallery handles with %s tags while keeping both destinations distinct", mbti => {
    const taggedEntry = { ...entry, mbti };
    for (const html of [homePage({}, [taggedEntry]), collectionPage([taggedEntry]), mbtiGalleryPage(mbti, [taggedEntry])]) {
      const card = html.match(/<article class="gallery-item"[^>]*>[\s\S]*?<\/article>/)![0];
      const handle = '<a class="gallery-handle" href="/p/Alice_Bob_Key/variations">@Alice_Bob_Key</a>';
      expect(card).toContain(handle);
      const captions = artworkCaptions(card);
      expect(captions).toHaveLength(1);
      expectArtworkIdentity(captions[0]!, "Alice_Bob_Key", mbti, "Minted");
      expect(card.indexOf('<img')).toBeLessThan(card.indexOf('class="artwork-caption'));
      expect(card).toContain('class="gallery-card" href="/signatures/alice_bob_key"');
      expect(card).toContain('src="/art/test.svg"');
      expect(card).not.toContain('https://x.com/');
      expect(card).not.toContain('/p/alice_bob_key/');
      expect(card).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
    }
    expectArtworkIdentity(artworkCaptions(assessmentPage({ ...minted, mbti }))[0]!, "Agent_Art", mbti, "Minted");
    const empty = mbtiGalleryPage(mbti, [{ ...taggedEntry, mint: { state: "pending" } }]);
    expect(empty).toContain(`<h1>Signatures × ${mbti}</h1>`);
    expect(empty).toContain(`No signatures minted with ${mbti} yet.`);
    expect(empty).not.toContain('class="gallery-item"');
  });

  it("omits gallery fixture notices on populated and empty MBTI pages", () => {
    for (const entries of [[entry], []]) {
      const html = mbtiGalleryPage("INTJ", entries, { development: { fixture: true, galleryFixtures: true } });
      expectNoDevelopmentChrome(html);
    }
    for (const options of [{}, { development: { fixture: false, galleryFixtures: true } }, { development: { fixture: true, localChain: true } }]) {
      expect(mbtiGalleryPage("INTJ", [entry], options)).not.toContain('data-gallery-fixture-notice');
    }
  });

  it("rejects invalid MBTI page types and keeps malformed stored types as plain escaped text", () => {
    for (const invalid of ['intj', '17', '<img src=x onerror="boom">']) {
      expect(() => mbtiGalleryPage(invalid as "INTJ", [entry])).toThrow();
      for (const html of [homePage({}, [{ ...entry, mbti: invalid }]), collectionPage([{ ...entry, mbti: invalid }]), assessmentPage({ ...minted, mbti: invalid })]) {
        expect(html).not.toContain('class="mbti-link"');
        expect(html).not.toContain('<img src=x onerror=');
        const personality = html.match(/<span class="artwork-personality">([\s\S]*?)<\/span><\/span>/)![1]!;
        expect(personality).not.toContain('signature-tag');
        expect(personality).not.toContain('<a');
      }
    }
  });

  it("keeps a maximum-length handle intact across details, previews, variations, and galleries", () => {
    const handle = "Long_Handle_123";
    expect(handle).toHaveLength(15);
    const longEntry: GalleryEntry = { ...entry, handle: handle.toLowerCase(), renderHandle: handle };
    const detail = assessmentPage({ ...minted, handle: handle.toLowerCase(), renderHandle: handle });
    for (const html of [detail, previewPage(handle, "INTJ"), homePage({}, [longEntry]), mbtiGalleryPage("INTJ", [longEntry]), collectionPage([longEntry])]) {
      const captions = artworkCaptions(html);
      expect(captions).toHaveLength(1);
      expectArtworkIdentity(captions[0]!, handle, "INTJ", html.includes('data-preview-mint-state=') ? "Preview" : "Minted");
    }
    const captions = artworkCaptions(previewVariationsPage(handle));
    expect(captions).toHaveLength(16);
    for (const [index, caption] of captions.entries()) expectArtworkIdentity(caption, handle, previewRows.flat()[index]!, "Preview");
  });

  it("does not invent an MBTI or leave a dangling multiplication sign when stored metadata has no type", () => {
    for (const mbti of [undefined, ""]) {
      const html = assessmentPage({ ...minted, mbti });
      const caption = artworkCaptions(html)[0]!;
      expect(caption).toContain('@Agent_Art</a>');
      expect(caption).toContain('href="/" data-mint-state-label>Minted</a>');
      expect(caption).not.toMatch(/artwork-personality|mbti-link|undefined|>×</);
    }
    for (const html of [homePage({}, [{ ...entry, mbti: "" }]), collectionPage([{ ...entry, mbti: "" }])]) {
      const caption = artworkCaptions(html)[0]!;
      expect(caption).toContain('@Alice_Bob_Key</a>');
      expect(caption).toContain('href="/">Minted</a>');
      expect(caption).not.toMatch(/artwork-personality|mbti-link|undefined|>×</);
    }
  });

  it("links every Minted tag to the home gallery while leaving Preview tags as plain status", () => {
    const sample: PublicPreviewState = { ...publicMint, state: "fixture" };
    const options = { development: { fixture: true } };
    const pages = [
      homePage({}, [entry]), mbtiGalleryPage("INTJ", [entry]), collectionPage([entry]),
      assessmentPage(minted), previewPage("Alice_Bob_Key", "INTJ", {}, publicMint),
      previewVariationsPage("Alice_Bob_Key", {}, publicMint),
      previewPage("Alice_Bob_Key", "INTJ", options, sample), previewVariationsPage("Alice_Bob_Key", options, sample),
    ];
    for (const html of pages) {
      const mintedTags = [...html.matchAll(/<(a|span)\b([^>]*)>Minted<\/\1>/g)];
      expect(mintedTags).toHaveLength(1);
      for (const [, tag, attributes] of mintedTags) {
        expect(tag).toBe("a");
        expect(attributes).toContain('href="/"');
        expect(attributes).toContain('artwork-status');
      }
    }
    for (const html of [previewPage("Alice_Bob_Key", "ENFP"), previewVariationsPage("Alice_Bob_Key"), previewPage("Alice_Bob_Key", "ENFP", {}, publicMint)]) {
      expect(html).toMatch(/<span\b[^>]*>Preview<\/span>/);
      expect(html).not.toMatch(/<a\b[^>]*>Preview<\/a>/);
    }
  });

  it("underlines handle and MBTI text links on hover and keyboard focus without giving them tag styling", () => {
    expect(OPEN_MINT_CSS).toContain('.open-mint :is(.gallery-handle,.mbti-link){text-decoration:none;text-underline-offset:.18em}');
    expect(OPEN_MINT_CSS).toContain('.open-mint :is(.gallery-handle,.mbti-link):hover,.open-mint :is(.gallery-handle,.mbti-link):focus-visible{text-decoration:underline}');
    expect(OPEN_MINT_CSS).toContain('.open-mint :is(.gallery-handle,.mbti-link):focus-visible{outline:2px solid var(--blue);outline-offset:3px}');
    const identityRules = [...OPEN_MINT_CSS.matchAll(/[^{}]*:is\(\.gallery-handle,\.mbti-link\)[^{}]*\{([^}]*)\}/g)].map(match => match[1]!);
    expect(identityRules).toHaveLength(3);
    for (const declarations of identityRules) expect(declarations).not.toMatch(/\b(?:background|color|padding|border-radius|margin|width|height|line-height|font-size|transform):/);
    for (const html of [homePage({}, [entry]), collectionPage([entry]), assessmentPage(minted), previewPage("Alice_Bob_Key", "ENFP"), previewVariationsPage("Alice_Bob_Key")]) {
      expect(html).not.toMatch(/<a\b[^>]*class="[^"]*signature-tag[^"]*"[^>]*>[A-Z]{4}<\/a>/);
    }
  });

  it("keeps Minted tag inversion and plain Preview status separate from identity text links", () => {
    expect(OPEN_MINT_CSS).toContain('.open-mint a.signature-tag{text-decoration:none}');
    expect(OPEN_MINT_CSS).toContain('.open-mint a.signature-tag:hover,.open-mint a.signature-tag:focus-visible{background:var(--ink);color:var(--paper);text-decoration:none}');
    expect(OPEN_MINT_CSS).toContain('.open-mint a.signature-tag:focus-visible{outline:2px solid var(--blue);outline-offset:3px}');
    expect(OPEN_MINT_CSS).not.toMatch(/\.artwork-status[^{]*\{[^}]*text-decoration:underline/);
    expect(OPEN_MINT_CSS).not.toMatch(/(?:span\.signature-tag|\.open-mint \.signature-tag):(?:hover|focus-visible)/);
    const interactiveTagRules = [...OPEN_MINT_CSS.matchAll(/(?:\.open-mint a\.signature-tag[^{}]*)\{([^}]*)\}/g)].map(match => match[1]!);
    expect(interactiveTagRules).toHaveLength(3);
    for (const declarations of interactiveTagRules) expect(declarations).not.toMatch(/\b(?:padding|border-radius|margin|width|height|line-height|font-size|transform):/);
    expect(OPEN_MINT_CSS).toMatch(/\.open-mint \.artwork-caption\{[^}]*display:(?:grid|flex)/);
    expect(OPEN_MINT_CSS).toMatch(/\.open-mint \.artwork-caption\{[^}]*width:100%/);
    expect(OPEN_MINT_CSS).toMatch(/\.open-mint \.artwork-status\{[^}]*margin-inline-start:auto/);
    expect(OPEN_MINT_CSS).toMatch(/\.open-mint \.artwork-identity\{[^}]*flex-wrap:wrap/);
    expect(OPEN_MINT_CSS).not.toMatch(/(?:\.mbti-link|\.artwork-status)[^{]*\{[^}]*\b(?:padding|border-radius):/);
  });

  it.each(["pending", "ready", "failed", "abstained"] as const)("withholds artwork and metadata for %s assessments until confirmed mint", status => {
    const html = assessmentPage({ ...ready, status });
    const main = html.match(/<main>([\s\S]*?)<\/main>/)![1]!;
    expect(main).toContain('data-assessment-handle="agent_art"');
    expect(main).toContain('data-assessment-state="' + status + '"');
    expectHandleNavigation(main, "Agent_Art", 1);
    expect(main).toContain('data-assessment-status role="status"');
    expect(main).not.toMatch(/<img\b|<figure\b|signature-provenance|INTJ|\/art\/hidden|secret-svg-digest|secret-png-digest|SVG ↗/);
    expect(html).not.toMatch(/<title>[^<]*INTJ/);
    expect(main).not.toMatch(/checkbox|data-mint-review|exact artwork/);
    expect(artworkCaptions(main)).toEqual([]);
  });

  it("offers progress and continuation without another artwork-review step", () => {
    const pending = assessmentPage({ ...ready, status: "pending", canMint: false });
    expect(pending).toContain('data-mint-form hidden');
    expect(pending).toContain('Preparing your signature…');
    const html = assessmentPage({ ...ready, walletProvedForCode: true });
    expect(html).toContain('data-wallet-proved="true"');
    expect(html).toContain('<form data-mint-form>');
    expect(html).toContain('data-submit-mint disabled><span>Continue mint');
    expect(html).toContain('Preparing your mint…');
    const submitted = assessmentPage({ ...ready, mint: { state: "pending" } });
    expect(submitted).toContain('Mint submitted. Waiting to reveal your signature…');
    expect(submitted).not.toContain('data-mint-form');
    expect(submitted).not.toContain('data-connect-wallet');
    expect(submitted).not.toContain('/art/hidden');
  });

  it("does not offer mint for other browser sessions or expired requests", () => {
    const html = assessmentPage({ ...ready, canMint: false });
    expect(html).toContain('This mint request is not available in this browser.');
    expect(html).toContain('href="/mint?handle=Agent_Art"><span>Return to mint');
    expect(html).not.toContain('data-mint-form');
    expect(html).not.toContain('data-connect-wallet');
    expect(assessmentPage({ ...ready, canMint: false, requestExpired: true })).toContain("This mint request has expired.");
  });

  it.each(["pending", "ready"] as const)("exposes only safe deadlines and a preserved-spelling return for %s expiry", status => {
    const model = { ...ready, status, requestExpiresAt: 1_800_000_900_000, walletProofExpiresAt: 1_800_000_600_000, serverNow: 1_800_000_000_000 };
    const active = assessmentPage(model);
    expect(active).toContain('data-request-expires-at="1800000900000"');
    expect(active).toContain('data-wallet-proof-expires-at="1800000600000"');
    expect(active).toContain('data-server-now="1800000000000"');
    expect(active).toContain('<div data-request-recovery hidden>');
    expect(active).toContain('data-check-progress hidden');
    expect(active).toContain('href="/mint?handle=Agent_Art"><span>Return to mint');
    const expired = assessmentPage({ ...model, canMint: false, requestExpired: true });
    expect(expired).toContain('data-request-expired="true"');
    expect(expired).toContain('<div data-request-recovery>');
    expect(expired).toContain('Any saved assessment and artwork will be reused.');
    expect(expired).not.toMatch(/data-submit-mint|data-connect-wallet|\/art\/hidden|secret-svg-digest|secret-png-digest/);
  });

  it("keeps expired submitted requests in confirmation instead of offering a new mint", () => {
    const html = assessmentPage({ ...ready, requestExpired: true, canMint: false, mint: { state: "pending" } });
    expect(html).toContain('Mint submitted. Waiting to reveal your signature…');
    expect(html).toContain('<div data-request-recovery hidden>');
    expect(html).not.toContain('This mint request has expired.');
    expect(html).not.toMatch(/data-submit-mint|data-connect-wallet/);
  });

  it("shows truthful assessment failure without a retry or reroll promise", () => {
    const html = assessmentPage({ ...ready, status: "failed", canMint: false, error: "The provider response is uncertain. Contact support." });
    expect(html).toContain('The provider response is uncertain. Contact support.');
    expect(html).not.toMatch(/Try again|another assessment|data-mint-form|data-connect-wallet/);
    expect(html).not.toMatch(/Request help|data-assessment-support/);
  });

  it.each(["failed", "abstained"] as const)("shows an optional static support link for %s, separate from diagnostics", status => {
    const reference = "12345678-1234-4123-8123-123456789abc";
    const html = assessmentPage({ ...ready, status, canMint: false, diagnosticReference: reference,
      errorCategory: status === "abstained" ? "assessment-abstained" : "assessment-blocked" }, { supportUrl: "https://help.example.test/request?source=mint" });
    const support = /<div class="auth-actions" data-assessment-support>(.*?)<\/div>/.exec(html)?.[1];
    expect(support).toContain('href="https://help.example.test/request?source=mint"');
    expect(support).toContain('referrerpolicy="no-referrer"');
    expect(support).toContain('rel="noopener noreferrer"');
    expect(support).toContain("Request help");
    expect(support).not.toContain(reference);
    expect(support).not.toContain(ready.code);
    expect(html).toContain(`Reference: ${reference}.`);
  });

  it.each(["pending", "ready"] as const)("keeps a configured support placeholder hidden while %s", status => {
    const html = assessmentPage({ ...ready, status }, { supportUrl: "https://help.example.test/" });
    expect(html).toContain('data-assessment-support hidden>');
    expect(html).toContain("Request help");
  });

  it.each(["javascript:alert(1)", "http://help.example.test", "https://user:password@example.test"])("rejects unsafe support links in direct page rendering: %s", supportUrl => {
    expect(() => assessmentPage({ ...ready, status: "failed" }, { supportUrl })).toThrow("HTTPS URL without credentials");
  });

  it.each(["assessment-blocked", "assessment-abstained", "preparation-interrupted"] as const)("shows bounded %s recovery with a safe reference", errorCategory => {
    const reference = "12345678-1234-4123-8123-123456789abc";
    const html = assessmentPage({ ...ready, status: errorCategory === "assessment-abstained" ? "abstained" : "failed", canMint: false, errorCategory, diagnosticReference: reference, error: "private-provider-payload" });
    expect(html).toContain(`Reference: ${reference}.`);
    expect(html).not.toContain("private-provider-payload");
    expect(html).not.toMatch(/data-mint-form|data-connect-wallet|href="mailto:|href="\/support/);
    expect(html).toContain(errorCategory === "assessment-abstained" ? "will not be retried automatically" : "operator review");
    expect(html).not.toMatch(/\/art\/hidden|secret-svg-digest|secret-png-digest/);
  });

  it.each(["opaque-request-code", "r".repeat(43), '<img src=x onerror=alert(1)>', "/mint/private"])("omits unsafe diagnostic references: %s", diagnosticReference => {
    const html = assessmentPage({ ...ready, status: "failed", canMint: false, code: "safe-request", errorCategory: "assessment-blocked", diagnosticReference });
    expect(html).not.toContain("Reference:");
    expect(html).not.toContain(diagnosticReference);
  });

  it("shows a known pending transaction hash without asserting unverified network state", () => {
    const transactionHash = `0x${"4".repeat(64)}`;
    const html = assessmentPage({ ...ready, mint: { state: "pending", transactionHash } });
    expect(html).toContain(`data-mint-transaction-hash="${transactionHash}"`);
    expect(html).toContain(`data-mint-transaction>Transaction: ${transactionHash}</p>`);
    expect(html).toContain('data-mint-network hidden');
    expect(html).not.toContain("Verified mint network:");
    const unsafe = assessmentPage({ ...ready, mint: { state: "pending", transactionHash: "/mint/private" } });
    expect(unsafe).not.toContain("/mint/private");
  });

  it("reveals frozen rendering spelling and provenance only after confirmed mint", () => {
    const html = assessmentPage({ ...minted, assessmentProvenance: 'grok' });
    expect(html).toContain('alt="Signature for @Agent_Art × INTJ"');
    expectHandleNavigation(html, "Agent_Art", 2);
    expect(html).toContain('<dt>Handle</dt><dd><a class="gallery-handle" href="/p/Agent_Art/variations">@Agent_Art</a></dd>');
    expect(html).toContain('<a class="mbti-link" href="/INTJ/">INTJ</a>');
    expect(html).toContain('<dt>Assessor</dt><dd>Grok</dd>');
    expect(html).toContain('<div class="provenance-caveats"><p><strong class="open-preview-notice-label">Caveat</strong> MBTI is an artistic input, not a psychological diagnosis. Owning this token does not imply ownership or control of the X account.</p></div>');
    expect(html).not.toContain('The backend asked Grok to research public X posts');
    expect(html).toContain('class="signature-provenance"');
    expect(html).toContain('SVG ↗');
    expect(html).not.toContain('data-mint-form');
    expect(html).not.toContain('data-assessment-code');
    expect(assessmentPage({ ...minted, handle: "alice_bob_key", renderHandle: undefined })).toContain('alt="Signature for @alice_bob_key × INTJ"');
  });

  it("escapes external data and does not turn unsafe URL schemes into links", () => {
    const html = assessmentPage({ ...minted, mbti: '<img src=x onerror="boom">', imageUrl: "javascript:boom()", svgUrl: "javascript:boom()", assessmentModel: '<script>boom()</script>' });
    expect(html).not.toContain('<img src=x onerror');
    expect(html).not.toContain('<script>boom()');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;script&gt;boom()&lt;/script&gt;');
    expect(assessmentPage({ ...ready, status: "failed", error: '<img src=x>' })).toContain('&lt;img src=x&gt;');
    expect(mintPage("", { wallet: '<img src=x>' })).toContain('&lt;img src=x&gt;');
    expect(errorPage('<img src=x>')).toContain('&lt;img src=x&gt;');
  });

  it("dates verified mint spelling as a preparation snapshot without claiming live verification", () => {
    const identityVerifiedAt = "2026-09-16T08:30:00.000Z";
    const html = assessmentPage({ ...minted, assessmentProvenance: "grok", identityVerifiedAt });
    expect(html).toContain(`<dt>Spelling verified at preparation</dt><dd>${identityVerifiedAt}</dd>`);
    expect(html).toContain("This is the spelling verified during preparation, not a live X profile lookup.");
    for (const unverified of [assessmentPage(minted), assessmentPage({ ...minted, assessmentProvenance: "development-fixture", identityVerifiedAt }, { development: { fixture: true } })]) {
      expect(unverified).not.toContain("Spelling verified at preparation");
      expect(unverified).not.toContain("This is the spelling verified during preparation");
      expect(unverified).not.toContain(identityVerifiedAt);
    }
    for (const mint of [{ state: "unminted" as const }, { state: "pending" as const }]) {
      const hidden = assessmentPage({ ...ready, identityVerifiedAt, mint });
      expect(hidden).not.toContain(identityVerifiedAt);
      expect(hidden).not.toContain("Spelling verified at preparation");
    }
  });

  it("removes developer chrome on every product page without changing runtime mode or provenance", () => {
    const options = { development: { fixture: true, localChain: true, galleryFixtures: true,
      tools: [{ label: "Fixture tools", href: "/dev/tools" }], notes: ["Development fixture notice"] } };
    for (const html of [homePage(options, [entry]), mintPage("", options), collectionPage([], options),
      assessmentPage(ready, options), assessmentPage(minted, options), aboutPage(options),
      mbtiGalleryPage("INTJ", [entry], options), previewPage("Agent_Art", "ENFP", options),
      previewVariationsPage("Agent_Art", options), errorPage("Not found", options)]) {
      expectNoDevelopmentChrome(html);
      expect(html).toContain('data-fixture="true"');
      expect(html).toContain('data-local-chain="true"');
      expect(html).not.toContain('href="/dev/tools"');
    }
    const revealed = assessmentPage(minted, options);
    expect(revealed).toContain('<div class="provenance-caveats"><p><strong class="open-preview-notice-label">Caveat</strong> MBTI is an artistic input, not a psychological diagnosis. Owning this token');
    expect(revealed).toContain('Owning this token does not imply ownership or control of the X account.');
    expect(revealed).toContain('<dt>Assessor</dt><dd>Not recorded</dd>');
  });

  it("shows only the minted tag and an optional actual explorer below minted artwork", () => {
    const html = assessmentPage(minted);
    const artwork = html.match(/<article class="signature-page"[\s\S]*?<\/article>/)![0];
    expect(artwork).toContain('data-mint-state-label>Minted');
    expect(artwork).not.toContain('My Collection');
    expect(artwork).not.toContain('href="/me"');
    expect(assessmentPage({ ...minted, mint: { state: 'minted', explorerUrl: 'https://etherscan.io/token/123' } })).toContain('View token ↗');
    expect(assessmentPage({ ...minted, mint: { state: 'minted', explorerUrl: 'javascript:boom()' } })).not.toContain('View token ↗');
  });

  it("explains independent assessment, durable reuse, gas, and limits of reveal", () => {
    const html = collectionPage([], { wallet: "0x" + "1".repeat(40) });
    expect(html).toContain("My Collection");
    expect(html).toContain("This wallet has no minted signatures yet.");
    expect(html).toContain('href="/mint"><span>Mint a signature');
    expect(html).not.toMatch(/claim|\/auth\/x|Sign in with X/i);
    const about = aboutPage();
    expect(about).toContain("Preview pages do not call our assessment service or authorize a mint.");
    expect(about).toContain("Preview pages keep the capitalization in the URL without looking up X.");
    expect(about).toContain("It does not accept the preview’s MBTI.");
    expect(about).toContain("independently verifies the current X username spelling");
    expect(about).toContain("saved as a snapshot at preparation");
    expect(about).toContain("The spelling is not checked again at transaction confirmation.");
    expect(about).toContain("cancelling a transaction does not create another result");
    expect(about).toContain("Later mint attempts reuse the saved assessment and artwork, including after a mint request expires.");
    expect(about).toContain("Expiry does not trigger another assessment.");
    expect(about).toContain("not cryptographic secrecy");
    expect(about).toContain("one minted token per handle");
    expect(about).toContain("Identity follows the handle, not the X account ID.");
    expect(about).toContain("A renamed handle is a different identity; changing capitalization alone does not create another token.");
    expectCleanProductCopy(about);
    const fixtureAbout = aboutPage({ development: { fixture: true, galleryFixtures: true } });
    expectNoDevelopmentChrome(fixtureAbout);
  });
});

describe("completed mint-result outage notice policy", () => {
  it.each([
    "Mint availability cannot be checked right now. Please try again shortly.",
    "Your signature is revealed, but confirmation could not be checked. Please do not submit another mint.",
    "Live network checks are temporarily unavailable. Previously verified mints are shown.",
  ])("does not flash an ordinary outage on a finalized result: %s", notice => {
    const html = assessmentPage({ ...minted, mintObservationUnavailable: true }, { mintProcess: true, mintObservationManaged: true, mintObservationNotice: notice });
    expect(html).toContain('data-mint-state="minted"');
    expect(html).toContain('data-mint-state-label>Minted');
    expect(html).toContain('data-mint-observation-warning role="status" hidden');
    expect(html).not.toContain(notice); expect(html).toContain('src="/art/hidden.svg"');
  });

  it("keeps actual invalidation visible and preserves the previously revealed image", () => {
    const html = assessmentPage({ ...minted, mintEvidenceInvalidated: true }, { mintProcess: true });
    expect(html).toContain('data-mint-state="unknown"'); expect(html).toContain('data-mint-state-label>Status unavailable');
    expect(html).toContain("Previously verified mints need to be checked before minting can continue.");
    expect(html).toContain('data-mint-observation-warning role="status" id="mint-observation-warning" aria-live="polite"><strong');
    expect(html).toContain('src="/art/hidden.svg"');
    const supplied = "Mint availability cannot be checked right now. Please try again shortly.";
    expect(assessmentPage({ ...minted, mintEvidenceInvalidated: true }, { mintProcess: true, mintObservationNotice: supplied })).toContain(supplied);
  });

  it("does not erase an unfamiliar explicit safety notice or suppress an unfinished confirmation", () => {
    const notice = "This mint needs operator review.";
    expect(assessmentPage(minted, { mintProcess: true, mintObservationNotice: notice })).toContain(notice);
    const outage = "Mint availability cannot be checked right now. Please try again shortly.";
    expect(assessmentPage({ ...minted, mint: { state: "confirming" } }, { mintProcess: true, mintObservationNotice: outage })).toContain(outage);
  });
});
