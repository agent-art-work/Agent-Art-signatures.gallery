import { describe, expect, it } from "vitest";
import { SITE_CSS } from "../v1/siteCss.js";
import { SITE_ACTION_SELECTOR } from "../v1/controlsCss.js";
import { collectionPage, homePage, mbtiGalleryPage, OPEN_MINT_CSS, type GalleryEntry } from "./pages.js";

const entry: GalleryEntry = {
  handle: "alice", renderHandle: "Alice", code: "code", mbti: "INTJ",
  imageUrl: "/art/alice.svg", mint: { state: "minted" },
};

function rules(css: string): { selector: string; declarations: string }[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, declarations]) => ({ selector: selector!.trim(), declarations: declarations! }));
}

describe("home gallery width", () => {
  it("enlarges only the current homepage slogan while preserving responsive width and intro size", () => {
    const currentRules = rules(OPEN_MINT_CSS);
    expect(currentRules.filter(rule => rule.selector.includes(".slogan-lockup")))
      .toEqual([{
        selector: ".open-mint .home-grid .slogan-lockup",
        declarations: "max-width:56rem",
      }]);
    expect(rules(SITE_CSS).find(rule => rule.selector === ".slogan-lockup")?.declarations)
      .toBe("width:100%;max-width:42rem");
    expect(currentRules.find(rule => rule.selector === ".open-mint .open-intro")?.declarations)
      .toBe("width:100%;max-width:42rem;margin-inline:auto");
  });

  it("keeps the guidance centered at readable 16px and lets narrow screens wrap", () => {
    expect(rules(OPEN_MINT_CSS).filter(rule => rule.selector.includes(".home-guidance")))
      .toEqual([{
        selector: ".open-mint .home-grid .home-guidance",
        declarations: "font-size:16px;line-height:1.5;text-align:center;margin:0 0 .75rem",
      }, {
        selector: ".open-mint .home-grid .home-guidance>span",
        declarations: "display:inline-block;max-width:100%;font:inherit",
      }]);
    expect(SITE_CSS).not.toContain(".home-guidance");
    const home = homePage({}, [entry]);
    expect(home.match(/class="home-guidance"/g)).toHaveLength(1);
    expect(home).toContain('<p class="home-guidance"><span>Choose any X handle.</span> <span>One signature per handle—mint to reveal it.</span></p>');
    expect(home).not.toMatch(/<(?:form|button|input)[^>]*class="[^"]*home-guidance/);
    for (const html of [mbtiGalleryPage("INTJ", [entry]), collectionPage([entry])]) {
      expect(html).not.toContain('class="home-guidance"');
    }
  });

  it("makes each guidance phrase inherit its fitted parent rather than the shared 14px descendant reset", () => {
    // The reset targets spans directly, so enlarging their parent alone is insufficient.
    const reset = rules(SITE_CSS).find(rule => rule.selector.includes("body :not(svg,svg *)"));
    expect(reset?.declarations).toContain("font-size:var(--ui-font-size)");
    const phrases = rules(OPEN_MINT_CSS).find(rule => rule.selector === ".open-mint .home-grid .home-guidance>span");
    expect(phrases?.declarations).toContain("font:inherit");
    expect(phrases?.declarations).not.toMatch(/font-size:\s*(?:14px|var\(--ui-font-size\))/);
  });

  it("sets both the homepage Mint CTA and its label to 16px while retaining the shared 14px UI and adopting the shared 48px pill", () => {
    expect(rules(OPEN_MINT_CSS).filter(rule => rule.selector.includes(".home-mint-cta")))
      .toEqual([{
        selector: ".open-mint .home-grid .home-mint-cta,.open-mint .home-grid .home-mint-cta>span",
        declarations: "font-size:16px",
      }]);
    expect(rules(SITE_CSS).find(rule => rule.selector === ":root")?.declarations)
      .toContain("--ui-font-size:14px");
    const target = rules(SITE_CSS).find(rule => rule.selector === SITE_ACTION_SELECTOR)?.declarations;
    expect(target).toContain("min-width:44px;min-height:48px");
    expect(target).toContain("border-radius:999px");
    expect(SITE_CSS).not.toContain("home-mint-cta");
    const home = homePage({}, [entry]);
    expect(home.match(/class="auth-action home-mint-cta"/g)).toHaveLength(1);
    expect(home).toContain('<a class="auth-action home-mint-cta" href="/mint" data-home-mint-cta aria-describedby="home-mint-status"><span data-home-mint-label>Mint a signature</span></a>');
    for (const html of [mbtiGalleryPage("INTJ", [entry]), collectionPage([entry])]) {
      expect(html).not.toContain("home-mint-cta");
    }
  });

  it("centers the homepage guidance, primary CTA and disclosure on one axis without centering nested instructions", () => {
    const currentRules = rules(OPEN_MINT_CSS);
    expect(currentRules.find(rule => rule.selector === ".open-mint .home-grid .open-intro")?.declarations)
      .toBe("display:grid;justify-items:center;gap:.5rem;text-align:center;container-type:inline-size");
    expect(currentRules.find(rule => rule.selector === ".open-mint .home-grid .open-intro>.auth-actions")?.declarations)
      .toBe("margin:0;justify-content:center");
    expect(currentRules.filter(rule => /\.open-intro.*\.auth-actions/.test(rule.selector))
      .map(rule => rule.selector)).toEqual([".open-mint .home-grid .open-intro>.auth-actions"]);
    expect(currentRules.find(rule => rule.selector === ".open-mint .home-grid .open-handoff")?.declarations)
      .toBe("width:100%;margin:0;text-align:start");
    expect(currentRules.find(rule => rule.selector === ".open-mint .home-grid .open-handoff>summary")?.declarations)
      .toContain("margin-inline:auto");
    expect(SITE_CSS).not.toContain(".open-intro");
  });

  it("separates expanded preview instructions while retaining a visible keyboard focus for the disclosure", () => {
    const currentRules = rules(OPEN_MINT_CSS);
    expect(currentRules.find(rule => rule.selector === ".open-mint .home-grid .open-handoff-content")?.declarations)
      .toBe("display:grid;gap:1.5rem;margin-top:1.5rem;padding-top:1.5rem;border-top:1px solid var(--line)");
    expect(currentRules.find(rule => rule.selector === ".open-mint .home-grid .open-handoff-content>p")?.declarations)
      .toBe("margin:0");
    const focus = currentRules.find(rule => rule.selector === ".open-mint .home-grid .open-handoff>summary:focus-visible")?.declarations;
    expect(focus).toContain("outline:2px solid var(--blue)");
    expect(focus).toMatch(/outline-offset:\s*[1-9]/);
    expect(rules(SITE_CSS).find(rule => rule.selector === ".auth-disclosure p")?.declarations)
      .toContain("color:var(--muted)");
  });

  it("gives the expanded Grok prompt and wrapped actions breathing room without altering shared controls", () => {
    const currentRules = rules(OPEN_MINT_CSS);
    // A grid gap survives the shared field and disclosure action margin resets.
    expect(currentRules.find(rule => rule.selector === ".open-mint .home-grid .open-handoff-content")?.declarations)
      .toContain("display:grid;gap:1.5rem");
    expect(currentRules.find(rule => rule.selector === ".open-mint .home-grid .open-handoff-content>.grok-prompt")?.declarations)
      .toBe("min-height:14rem;margin:0;line-height:1.6");
    expect(currentRules.find(rule => rule.selector === ".open-mint .home-grid .open-handoff-content>.auth-actions")?.declarations)
      .toBe("margin:0;gap:1rem");
    // An empty live region must not add a spare grid row; populated feedback remains visible.
    expect(currentRules.find(rule => rule.selector === ".open-mint .home-grid .open-handoff-content>.open-feedback:empty")?.declarations)
      .toBe("display:none");
    expect(currentRules.filter(rule => rule.selector.includes(".open-handoff-content"))
      .every(rule => rule.selector.startsWith(".open-mint .home-grid "))).toBe(true);
  });

  it("lowers only the current homepage slogan by 24px while preserving its padded height and 896px width", () => {
    const currentRules = rules(OPEN_MINT_CSS);
    expect(currentRules.filter(rule => /\.intro-panel\b/.test(rule.selector)))
      .toEqual([{
        selector: ".open-mint .home-grid .intro-panel",
        declarations: "padding-block-start:7rem;padding-block-end:clamp(2.5rem,4vw,4rem)",
      }]);
    expect(rules(SITE_CSS).find(rule => rule.selector === ".intro-panel")?.declarations)
      .toContain("padding:clamp(2.5rem,4vw,4rem) var(--page-gutter,32px);padding-block-start:4rem");
    expect(currentRules.find(rule => rule.selector === ".open-mint .home-grid .slogan-lockup")?.declarations)
      .toBe("max-width:56rem");
  });

  it("cancels the current page gutter only on the home artwork grid", () => {
    const gutterCancellation = rules(OPEN_MINT_CSS)
      .filter(rule => /margin-inline:\s*calc\(-1 \* var\(--page-gutter,\s*32px\)\)/.test(rule.declarations));

    expect(gutterCancellation).toEqual([{
      selector: ".open-mint .home-grid .public-gallery-grid",
      declarations: "margin-inline:calc(-1 * var(--page-gutter,32px))",
    }]);
    expect(rules(SITE_CSS).find(rule => rule.selector === ".public-gallery-grid")?.declarations)
      .toContain("margin:auto 0");
  });

  it("retains the 1024px page, responsive gutters, and inset slogan and introduction", () => {
    const sharedRules = rules(SITE_CSS);
    expect(sharedRules.find(rule => rule.selector === ".book-page")?.declarations)
      .toContain("width:100%;max-width:1024px;margin-inline:auto;--page-gutter:32px");
    expect(SITE_CSS).toContain("@media(max-width:600px){.book-page{--page-gutter:20px}");
    expect(sharedRules.find(rule => rule.selector === ".gallery-shell")?.declarations)
      .toContain("padding:2rem var(--page-gutter,32px)");
    expect(sharedRules.find(rule => rule.selector === ".intro-panel")?.declarations)
      .toContain("padding:clamp(2.5rem,4vw,4rem) var(--page-gutter,32px)");
    expect(sharedRules.find(rule => rule.selector === ".slogan-lockup")?.declarations)
      .toBe("width:100%;max-width:42rem");
    expect(rules(OPEN_MINT_CSS).find(rule => rule.selector === ".open-mint .open-intro")?.declarations)
      .toBe("width:100%;max-width:42rem;margin-inline:auto");
  });

  it("keeps the expanded grid scoped out of MBTI and wallet collection pages", () => {
    const home = homePage({}, [entry]);
    expect(home).toContain('<section class="home-grid"><div class="intro-panel">');
    expect(home).toContain('<div class="gallery-shell"><section class="open-intro"');
    expect(home).toContain('</section><div class="public-gallery-grid">');
    expect(home).not.toContain('data-mint-observation-warning');
    for (const html of [mbtiGalleryPage("INTJ", [entry]), collectionPage([entry])]) {
      expect(html).toContain('<section class="collection-page"');
      expect(html).toContain('<div class="public-gallery-grid">');
      expect(html).not.toContain('class="home-grid"');
    }
  });

  it("uses shared navigation alignment without homepage-specific position overrides", () => {
    const navigationRules = rules(OPEN_MINT_CSS).filter(rule =>
      /--(?:home-)?nav-inset/.test(rule.declarations)
      || /\.(?:gallery-return|home-return|home-icon|collection-shortcut(?:-dot)?)\b/.test(rule.selector));
    expect(navigationRules).toEqual([]);
    expect(rules(SITE_CSS).find(rule => rule.selector === ".book-page")?.declarations)
      .toContain("--nav-inset:clamp(-22px,calc((1024px - 100vw)/2 + 20px),12px)");
    expect(rules(SITE_CSS).find(rule => rule.selector === ".book-page .gallery-return")?.declarations)
      .toBe("inset-inline-start:max(var(--nav-inset),calc(env(safe-area-inset-left) - 22px))");
    expect(rules(SITE_CSS).find(rule => rule.selector === ".book-page>main>.collection-shortcut,.book-page .account-menu")?.declarations)
      .toBe("inset-inline-end:max(var(--nav-inset),calc(env(safe-area-inset-right) - 22px))");
  });

  it("preserves centered 44px navigation targets and the existing 11px grid and 10px dot", () => {
    const sharedRules = rules(SITE_CSS);
    for (const selector of [".gallery-return", ".collection-shortcut"]) {
      expect(sharedRules.find(rule => rule.selector === selector)?.declarations)
        .toContain("place-items:center;width:44px;height:44px");
    }
    expect(sharedRules.find(rule => rule.selector === ".home-icon")?.declarations)
      .toBe("display:block;width:11px;height:11px;flex:none");
    expect(sharedRules.find(rule => rule.selector === ".collection-shortcut-dot")?.declarations)
      .toBe("display:block;width:10px;height:10px;border-radius:50%;background:currentColor");
  });
});
