import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signInRequiredPage } from "./pages.js";
import { SITE_CSS, SITE_CSS_URL } from "./siteCss.js";
import { SITE_ACTION_SELECTOR, SITE_FIELD_SELECTOR, SITE_CONTROLS_CSS } from "./controlsCss.js";

describe("site-wide pill controls and compact status tags", () => {
  it("reserves no space for the X progress notice until an action starts", () => {
    expect(SITE_CSS).toContain('[data-x-action-feedback]{min-height:0;margin:.5rem 0 0}');
    expect(SITE_CSS).toContain('[data-x-action-feedback]:empty{margin:0}');
  });
  it("anchors every collection state to the gallery edge without widening other auth pages", () => {
    const signedOut = signInRequiredPage(false);
    expect(signedOut).toContain('class="auth-sheet collection-sheet"');
    expect(signedOut).toContain('<div class="collection-intro"><div class="signature-heading"><h1>My Collection</h1>');
    expect(SITE_CSS).toContain('.auth-sheet.collection-sheet{max-width:none}');
    expect(SITE_CSS).toContain('.collection-intro .signature-heading{line-height:1.5}');
    expect(SITE_CSS).toContain('.collection-sheet .signature-heading h1{line-height:1.5}');
    expect(SITE_CSS).toContain('.collection-empty{width:100%;max-width:42rem;margin-inline:0;padding:0}');
    expect(SITE_CSS).toContain('.participation{width:100%;max-width:42rem;margin-inline:0;line-height:1.6}');
    expect(SITE_CSS).toContain('.signed-out-participation{padding:2rem 0}');
    expect(SITE_CSS).toContain('.auth-sheet{width:100%;max-width:42rem;margin-inline:auto;');
  });
  const rules = (selector: string) => {
    const css = SITE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .find(([, name]) => name!.trim() === selector)?.[2] ?? "";
  };

  it("uses 16px pill actions while preserving compact tags and 44px navigation", () => {
    expect(SITE_CSS).toContain("--control-padding:12px 24px;--control-line-height:1.35");
    for (const property of ["min-height:48px", "min-width:44px", "font-size:16px",
      "font-weight:var(--ui-font-weight)", "padding:var(--control-padding)", "border-radius:999px"]) {
      expect(rules(SITE_ACTION_SELECTOR)).toContain(property);
    }
    for (const selector of [".signature-tag", ".gallery-tabs a>span", ".auth-account-handle"]) {
      expect(rules(selector)).toContain("padding:var(--tag-padding)");
      expect(rules(selector)).toContain("border-radius:var(--tag-radius)");
    }
    expect(rules(".gallery-tabs a")).toContain("min-height:44px");
    expect(SITE_ACTION_SELECTOR).toContain(".account-menu-toggle");
    expect(SITE_ACTION_SELECTOR).toContain(".claim-toast button");
  });

  it("paints one solid pill instead of a second box around its label", () => {
    expect(rules(SITE_ACTION_SELECTOR)).toContain("background:var(--ink)");
    expect(rules(SITE_ACTION_SELECTOR)).toContain("color:var(--paper)");
    expect(rules(SITE_ACTION_SELECTOR)).toContain("border:0");
    expect(rules("body .auth-action>span:first-child")).toContain("padding:0;border:0");
    expect(rules("body .auth-action>span:first-child")).toContain("background:transparent");
    expect(rules(SITE_ACTION_SELECTOR + ">span:not(.action-tooltip)"))
      .toContain("font-size:inherit;font-weight:inherit;line-height:inherit");
    const hover = rules(SITE_ACTION_SELECTOR + ":not(:disabled):not([aria-disabled=true]):hover");
    for (const property of ["background:var(--paper)", "color:var(--ink)", "box-shadow:inset 0 0 0 1px var(--ink)"]) {
      expect(hover).toContain(property);
    }
    expect(hover).not.toMatch(/background:var\(--muted\)|padding:|border:/);
    expect(rules(".signature-tag")).toContain("background:var(--paper-2)");
    expect(SITE_CSS).not.toContain(".auth-action:not(:disabled):hover>span:first-child");
  });

  it("shares underlined fields without displaying hidden inputs or restyling comparison specimens", () => {
    for (const property of ["height:48px", "padding:12px 0", "border:0",
      "border-bottom:1px solid var(--line)", "border-radius:0", "font-size:16px", "font-weight:var(--ui-font-weight)", "box-shadow:none"]) {
      expect(rules(SITE_FIELD_SELECTOR)).toContain(property);
    }
    expect(SITE_FIELD_SELECTOR).toContain("[type=hidden]");
    expect(SITE_FIELD_SELECTOR).toContain("[type=radio]");
    expect(SITE_FIELD_SELECTOR).toContain("[type=checkbox]");
    expect(SITE_FIELD_SELECTOR).toContain("[data-control-style] input");
    expect(SITE_ACTION_SELECTOR).toContain("[data-control-style] button");
    expect(rules(SITE_FIELD_SELECTOR + ":is(textarea)")).toContain("height:auto");
    expect(rules(SITE_FIELD_SELECTOR + ":is(select)")).toContain("appearance:auto");
    expect(rules("body :is(input[type=radio],input[type=checkbox])")).toContain("accent-color:var(--ink)");
    expect(SITE_CSS).toContain("body [hidden]{display:none!important}");
  });

  it("defines one focus, disabled, working and reduced-motion policy for all controls", () => {
    expect(rules(SITE_ACTION_SELECTOR + ":focus-visible,body :is(input[type=radio],input[type=checkbox]):focus-visible"))
      .toContain("outline:2px solid var(--ink);outline-offset:4px");
    expect(rules(SITE_ACTION_SELECTOR + ":is(:disabled,[aria-disabled=true])"))
      .toContain("opacity:.45;cursor:not-allowed");
    expect(rules(SITE_ACTION_SELECTOR + "[aria-busy=true]")).toContain("opacity:.6;cursor:progress");
    expect(SITE_CONTROLS_CSS).toContain("@media(prefers-reduced-motion:reduce)");
    expect(SITE_CONTROLS_CSS).toContain("{transition:none}");
    expect(SITE_CONTROLS_CSS).toContain("{transform:none}");
    expect(SITE_CSS).toContain("gap:8px 1rem");
  });

  it("uses underline-only field focus for pointer and keyboard without removing button focus outlines", () => {
    expect(rules(SITE_FIELD_SELECTOR + ":is(:focus,:focus-visible)"))
      .toBe("outline:none;box-shadow:none");
    expect(rules(SITE_FIELD_SELECTOR + ":not(:disabled):is(:hover,:focus)"))
      .toContain("border-bottom-color:var(--ink)");
    expect(SITE_CONTROLS_CSS).not.toContain(SITE_FIELD_SELECTOR + ":focus-visible,");
  });

  it("loads the canonical controls once, after the general descendant type reset", () => {
    expect(SITE_CSS.split(SITE_CONTROLS_CSS)).toHaveLength(2);
    expect(SITE_CSS.indexOf(SITE_CONTROLS_CSS)).toBeGreaterThan(SITE_CSS.indexOf("body :not(svg,svg *)"));
    expect(SITE_CSS).not.toContain(".collection-page .reauth-button{");
    expect(SITE_CSS).not.toContain(".account-panel .reauth-button{");
    expect(SITE_CSS).not.toContain(".auth-action>span:first-child{display:inline-flex;align-items:center;justify-content:center;min-width:0;max-width:100%;padding:var(--control-padding)");
  });
});

describe("stylesheet cache version", () => {
  it("derives the stylesheet URL from the complete CSS content", () => {
    const version = createHash("sha256").update(SITE_CSS).digest("hex").slice(0, 16);
    expect(SITE_CSS_URL).toBe(`/assets/site.css?v=${version}`);
  });

  it.each([true, false])("includes the content-versioned URL in the shared layout (fixture=%s)", fixture => {
    expect(signInRequiredPage(fixture)).toContain(`<link rel="stylesheet" href="${SITE_CSS_URL}">`);
    expect(signInRequiredPage(fixture)).not.toContain('href="/assets/site.css"');
  });
});

describe("site-wide navigation alignment", () => {
  it("shares one responsive inset across home links, standalone dots and account menus", () => {
    expect(SITE_CSS).toContain('--nav-inset:clamp(-22px,calc((1024px - 100vw)/2 + 20px),12px)');
    expect(SITE_CSS).toContain('.book-page .gallery-return{inset-inline-start:max(var(--nav-inset),calc(env(safe-area-inset-left) - 22px))}');
    expect(SITE_CSS).toContain('.book-page>main>.collection-shortcut,.book-page .account-menu{inset-inline-end:max(var(--nav-inset),calc(env(safe-area-inset-right) - 22px))}');
    // Position the account-menu shell, not its nested dot a second time.
    expect(SITE_CSS).toContain('.account-menu .collection-shortcut{inset:0}');
    expect(SITE_CSS).not.toContain('.book-page .collection-shortcut{');
    expect(SITE_CSS).not.toContain(':has(.home-grid)');
  });

  it("reserves scrollbar space so navigation stays put between short and long pages", () => {
    expect(SITE_CSS).toContain('html{font-size:16px;scrollbar-gutter:stable}');
    expect(SITE_CSS).not.toContain('overflow-x:hidden');
  });
});
