import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { homePage, mintPage, OPEN_MINT_CSS } from "../openMint/pages.js";
import { SITE_CSS } from "../v1/siteCss.js";
import { SITE_CONTROLS_CSS } from "../v1/controlsCss.js";
import { FONT_STUDY_FAMILIES, FONT_STUDY_VARIANTS, FONT_STUDY_SCRIPT, FONT_STUDY_TYPE_SCALE_CSS, FONT_STUDY_VARIANT_CSS, fontStudyAsset, fontStudyFamily, fontStudyVariant, fontStudyWeight, fontStudyHref, fontStudyPage } from "./fontStudy.js";

const retiredFonts = ["dm-sans", "manrope", "instrument-sans", "caveat", "kalam", "patrick-hand"];

function fontFaceCss(css: string): string {
  return [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match => match[1]).join("\n");
}

function selectorList(selectors: string): string[] {
  const values: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < selectors.length; i++) {
    if (selectors[i] === "(" || selectors[i] === "[") depth++;
    else if (selectors[i] === ")" || selectors[i] === "]") depth--;
    else if (selectors[i] === "," && depth === 0) { values.push(selectors.slice(start, i).trim()); start = i + 1; }
  }
  return [...values, selectors.slice(start).trim()];
}

describe("real-page open-source font comparisons", () => {
  it("retains comparison candidates while the live site's chosen family is Playpen Sans light", () => {
    expect(FONT_STUDY_FAMILIES.map(font => font.id)).toEqual(["space-grotesk", "balsamiq-sans", "comic-neue", "playpen-sans"]);
    for (const font of FONT_STUDY_FAMILIES) expect(fontStudyFamily(font.id)).toBe(font.id);
    for (const value of [null, "unknown", 'x"; color:red', "../.env.local", ...retiredFonts]) expect(fontStudyFamily(value)).toBe("space-grotesk");
    expect(SITE_CSS).toContain('--font-family:"Playpen Sans",sans-serif');
    expect(SITE_CSS).toContain('--ui-font-weight:300');
    expect(SITE_CSS).not.toMatch(/Space Grotesk|DM Sans|Manrope|Caveat|Kalam|Patrick Hand|Balsamiq Sans|Comic Neue|Instrument Sans|font-study/);
  });

  it("uses real available weights and never invents a lighter Balsamiq font file", () => {
    expect(FONT_STUDY_VARIANTS).toEqual([{ id: "lighter", name: "Lighter" }, { id: "regular", name: "Regular" }, { id: "bold", name: "Bold" }]);
    for (const variant of FONT_STUDY_VARIANTS) expect(fontStudyVariant(variant.id)).toBe(variant.id);
    for (const value of [null, "unknown", 'bold";opacity:0', "../.env.local"]) expect(fontStudyVariant(value)).toBe("regular");
    expect(FONT_STUDY_VARIANTS.map(variant => fontStudyWeight("space-grotesk", variant.id))).toEqual([300, 400, 700]);
    expect(FONT_STUDY_VARIANTS.map(variant => fontStudyWeight("balsamiq-sans", variant.id))).toEqual([400, 400, 700]);
    expect(FONT_STUDY_VARIANTS.map(variant => fontStudyWeight("comic-neue", variant.id))).toEqual([300, 400, 700]);
    expect(FONT_STUDY_VARIANTS.map(variant => fontStudyWeight("playpen-sans", variant.id))).toEqual([300, 400, 700]);
    for (const font of retiredFonts) {
      expect(fontStudyAsset(`/assets/font-study/${font}.css`)).toBeUndefined();
      expect(fontStudyAsset(`/assets/font-study/${font}-5.3.0/${font}-latin-wght-normal.woff2`)).toBeUndefined();
      expect(fontStudyAsset(`/assets/font-study/${font}-5.3.0/${font}-latin-400-normal.woff2`)).toBeUndefined();
    }
  });

  it.each(FONT_STUDY_FAMILIES)("self-hosts real licensed $name font bytes", font => {
    const css = fontStudyAsset(`/assets/font-study/${font.id}.css`)!;
    expect(css.contentType).toContain("text/css");
    const text = css.bytes.toString();
    expect(text).toContain(`font-family: '${font.name}'`);
    expect(text).toContain(`--font-family:"${font.name}",sans-serif`);
    expect(text).toContain("font-display: swap");
    expect(text).toContain("unicode-range:");
    expect(text).not.toMatch(/https?:/);
    expect(fontFaceCss(text)).not.toMatch(/font-size:|height:/);
    const paths = [...text.matchAll(/url\(([^)]+)\)/g)].map(match => match[1]);
    expect(paths.length).toBeGreaterThan(1);
    for (const path of paths) {
      expect(path).toMatch(/^\/assets\/font-study\/[^/]+-5\.3\.0\//);
      expect(fontStudyAsset(path)!.bytes.subarray(0, 4).toString()).toBe("wOF2");
    }
    expect(fontStudyAsset(paths[0].replace(/[^/]+$/, "LICENSE.txt"))!.bytes.toString()).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(fontStudyAsset(paths[0].replace(/[^/]+$/, "package.json"))).toBeUndefined();
  });

  it.each(FONT_STUDY_FAMILIES)("applies the identical read-only type scale to $name", font => {
    const css = fontStudyAsset(`/assets/font-study/${font.id}.css`)!.bytes.toString();
    expect(FONT_STUDY_TYPE_SCALE_CSS.trim()).not.toBe("");
    expect(css.split(FONT_STUDY_TYPE_SCALE_CSS)).toHaveLength(2);
    expect(css.split(FONT_STUDY_VARIANT_CSS)).toHaveLength(2);
    expect(css).toMatch(/font-size:\s*56px/);
    expect(css).toMatch(/height:\s*104px/);
    expect(css).toMatch(/font-size:\s*20px/);
  });

  it("scopes weight and softer-ink variants away from SVG artwork and the comparison toolbar", () => {
    expect(FONT_STUDY_VARIANT_CSS).toMatch(/font-weight:\s*700/);
    expect(FONT_STUDY_VARIANT_CSS).toContain("strong");
    expect(FONT_STUDY_VARIANT_CSS).toContain("svg");
    expect(FONT_STUDY_VARIANT_CSS).toContain(".font-study-tools");
    expect(FONT_STUDY_VARIANT_CSS).toContain("color-mix(");
    expect(FONT_STUDY_VARIANT_CSS).not.toMatch(/opacity:|filter:|font-weight:\s*300[^}]*balsamiq/);
    const rules = [...FONT_STUDY_VARIANT_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) for (const selector of selectorList(rule[1])) expect(selector).toMatch(/^html\[data-font-study(?:[=\]])/);
    expect(rules.filter(rule => rule[1].includes(".font-study-tools")).map(rule => rule[2]).join("\n")).toMatch(/font-weight:\s*400/);
    expect(rules.filter(rule => /\bsvg\s*$/.test(rule[1])).map(rule => rule[2]).join("\n")).toContain("--ink:var(--font-study-original-ink)");
    const nativeLighter = rules.filter(rule => rule[1].includes(':not([data-font-study="balsamiq-sans"])') && rule[1].includes('[data-font-study-variant="lighter"]'));
    expect(nativeLighter).toHaveLength(1);
    expect(nativeLighter[0][2]).toMatch(/--font-study-weight:\s*300/);
  });

  it("scopes every size override to comparison pages and allows readable narrow-screen guidance", () => {
    const rules = [...FONT_STUDY_TYPE_SCALE_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selectors: match[1].trim(), declarations: match[2] }));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      for (const selector of selectorList(rule.selectors)) expect(selector).toMatch(/^html\[data-font-study\]/);
      expect(rule.declarations).not.toContain("cqi");
    }
    const declarationsFor = (fragment: string) => rules.filter(rule => rule.selectors.includes(fragment)).map(rule => rule.declarations).join("\n");
    expect(FONT_STUDY_TYPE_SCALE_CSS).toMatch(/--ui-font-size:\s*18px/);
    expect(declarationsFor(".mint-section-title")).toMatch(/font-size:\s*18px/);
    expect(declarationsFor(".home-guidance")).toMatch(/font-size:\s*18px/);
    expect(declarationsFor(".home-guidance")).toMatch(/white-space:\s*normal/);
    expect(declarationsFor(".open-handle-input")).toMatch(/font-size:\s*56px/);
    expect(declarationsFor(".open-handle-input")).toMatch(/height:\s*104px/);
    expect(declarationsFor("::placeholder")).toMatch(/font-size:\s*(?:inherit|56px)/);
  });

  it("keeps production sizes unchanged and isolates comparison size/weight overrides", () => {
    for (const original of [homePage(), mintPage()]) {
      expect(original).not.toContain('data-font-study');
      expect(original).not.toContain(FONT_STUDY_TYPE_SCALE_CSS);
      expect(original).not.toContain(FONT_STUDY_VARIANT_CSS);
      expect(original).not.toContain('/assets/font-study/');
    }
    expect(OPEN_MINT_CSS).toContain('.open-mint .mint-entry-handle .open-handle-input{font-size:48px;line-height:1.35;height:90px}');
    expect(OPEN_MINT_CSS).toContain('.open-mint .mint-entry-sheet .mint-section-title{display:block;min-width:0;font-size:14px');
    expect(OPEN_MINT_CSS).not.toContain(FONT_STUDY_TYPE_SCALE_CSS);
    expect(OPEN_MINT_CSS).not.toMatch(/data-font-study|font-size:56px|height:104px/);
    expect(SITE_CSS).toContain('--ui-font-size:14px');
    expect(SITE_CSS).not.toContain(FONT_STUDY_TYPE_SCALE_CSS);
    expect(SITE_CSS).not.toContain(FONT_STUDY_VARIANT_CSS);
    expect(SITE_CONTROLS_CSS).toContain('font-size:16px');
    expect(SITE_CONTROLS_CSS).not.toContain(FONT_STUDY_TYPE_SCALE_CSS);
    expect(SITE_CONTROLS_CSS).not.toContain(FONT_STUDY_VARIANT_CSS);
    expect(SITE_CONTROLS_CSS).not.toMatch(/data-font-study|font-size:(?:20|56)px|height:104px/);
  });

  it.each(FONT_STUDY_FAMILIES)("decorates both real pages with $name, removing all operational clients", font => {
    for (const view of ["home", "mint"] as const) for (const variant of FONT_STUDY_VARIANTS) {
      const original = view === "home" ? homePage() : mintPage("AnAgentArtist", { chainName: "Ethereum Sepolia" });
      const html = fontStudyPage(original, view, font.id, "http://127.0.0.1:3004", "@Alice", variant.id);
      expect(html).toContain(`data-font-study="${font.id}"`);
      expect(html).toContain(`data-font-study-variant="${variant.id}"`);
      expect(html).toMatch(new RegExp(`<title>${font.name}[^<]*${variant.name}[^<]*<\\/title>`));
      expect(html.match(/<script\b/g)).toHaveLength(1);
      expect(html).toContain('src="/assets/font-study.js"');
      expect(html).not.toMatch(/<script[^>]*src="[^\"]*(?:open-mint|sepolia|readiness)/);
      expect(html).not.toContain("Checking mint availability…");
      expect(html.match(/data-font-study-link/g)).toHaveLength(9);
      expect(html.match(/aria-current="true"/g)).toHaveLength(2);
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html.match(/rel="preload"/g)).toHaveLength(1);
      const weight = ["balsamiq-sans", "comic-neue"].includes(font.id) ? String(fontStudyWeight(font.id, variant.id)) : "wght";
      expect(html).toContain(`${font.id}-latin-${weight}-normal.woff2`);
      const links = [...html.matchAll(/<a\s+data-font-study-link\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
      expect(links).toHaveLength(9);
      const urls = links.map(link => new URL(link[1].replaceAll("&amp;", "&"), "http://127.0.0.1:3005"));
      for (const url of urls) expect(url.searchParams.get("handle")).toBe("@Alice");
      for (const url of urls.slice(0, 4)) expect(url.searchParams.get("variant")).toBe(variant.id);
      for (const url of urls.slice(4, 7)) expect(url.searchParams.get("font")).toBe(font.id);
      for (const url of urls.slice(7)) {
        expect(url.searchParams.get("font")).toBe(font.id);
        expect(url.searchParams.get("variant")).toBe(variant.id);
      }
      if (font.id === "balsamiq-sans") expect(html).toContain("Lighter · softer ink");
      else expect(html).not.toContain("Lighter · softer ink");
      if (font.id === "balsamiq-sans" && variant.id === "lighter") expect(html).toContain('<p class="font-study-weight-note">Regular 400, softer ink. Balsamiq Sans has no light weight.</p>');
      expect(html.match(/<svg\b[\s\S]*?<\/svg>/g)).toEqual(original.match(/<svg\b[\s\S]*?<\/svg>/g));
      expect(html.match(/<img\b[^>]*>/g)).toEqual(original.match(/<img\b[^>]*>/g));
      if (view === "mint") expect(html).toContain('value="@Alice"');
    }
  });

  it("loads only the real supplied handwriting weights, with no legacy WOFF fallback", () => {
    const space = fontStudyAsset("/assets/font-study/space-grotesk.css")!.bytes.toString();
    expect(fontFaceCss(space)).toContain("font-weight: 300 700;");
    const balsamiq = fontStudyAsset("/assets/font-study/balsamiq-sans.css")!.bytes.toString();
    expect([...new Set([...fontFaceCss(balsamiq).matchAll(/font-weight:\s*([^;]+);/g)].map(match => match[1]))]).toEqual(["400", "700"]);
    expect(balsamiq).toContain("balsamiq-sans-latin-400-normal.woff2");
    expect(balsamiq).toContain("balsamiq-sans-latin-700-normal.woff2");
    expect(balsamiq).not.toMatch(/\.woff\)|format\('woff'\)/);
    expect(balsamiq).not.toContain("balsamiq-sans-latin-300-normal.woff2");
    const comic = fontStudyAsset("/assets/font-study/comic-neue.css")!.bytes.toString();
    expect([...new Set([...fontFaceCss(comic).matchAll(/font-weight:\s*([^;]+);/g)].map(match => match[1]))]).toEqual(["300", "400", "700"]);
    for (const weight of [300, 400, 700]) expect(comic).toContain(`comic-neue-latin-${weight}-normal.woff2`);
    expect(comic).not.toMatch(/\.woff\)|format\('woff'\)/);
    const playpen = fontStudyAsset("/assets/font-study/playpen-sans.css")!.bytes.toString();
    expect(fontFaceCss(playpen)).toContain("font-weight: 100 800;");
    expect(playpen).toContain("playpen-sans-latin-wght-normal.woff2");
    expect(playpen).not.toMatch(/\.woff\)|format\('woff'\)/);
  });

  it("retains the same handle across both views and escapes values in markup", () => {
    expect(fontStudyHref("home", "space-grotesk", "@Alice")).toBe("/?font=space-grotesk&variant=regular&handle=%40Alice");
    expect(fontStudyHref("mint", "balsamiq-sans", "@Alice", "bold")).toBe("/mint?font=balsamiq-sans&variant=bold&handle=%40Alice");
    const html = fontStudyPage(mintPage(), "mint", "space-grotesk", "http://127.0.0.1:3004", '"><bad>');
    expect(html).toContain('value="&quot;&gt;&lt;bad&gt;"');
    expect(html).not.toContain("<bad>");
    expect(() => fontStudyPage(homePage(), "home", "space-grotesk", "https://example.com")).toThrow();
  });

  it("blocks submission and wallet buttons, and preserves drafts without storage or API access", () => {
    const handlers: Record<string, (event: { preventDefault(): void }) => void> = {};
    const notice = { hidden: true }, field = { value: "@Alice" }, link = { href: "http://127.0.0.1:3005/?font=balsamiq-sans&variant=bold", addEventListener: (_event: string, fn: () => void) => { handlers.link = fn; } };
    runInNewContext(FONT_STUDY_SCRIPT, {
      URL, URLSearchParams, location: { search: "" }, document: {
        querySelector: (selector: string) => selector === "#open-handle" ? field : notice,
        querySelectorAll: (selector: string) => selector === "form" || selector === "button" ? [{ addEventListener: (_event: string, fn: typeof handlers[string]) => { handlers[selector] = fn; } }] : [link],
      },
    });
    let prevented = 0;
    handlers.form({ preventDefault: () => { prevented++; } });
    handlers.button({ preventDefault: () => { prevented++; } });
    handlers.link({ preventDefault() {} });
    expect(prevented).toBe(2);
    expect(notice.hidden).toBe(false);
    expect(new URL(link.href).searchParams.get("handle")).toBe("@Alice");
    expect(new URL(link.href).searchParams.get("font")).toBe("balsamiq-sans");
    expect(new URL(link.href).searchParams.get("variant")).toBe("bold");
    expect(FONT_STUDY_SCRIPT).not.toMatch(/fetch\(|XMLHttpRequest|ethereum|localStorage|sessionStorage|\.submit\(/);
  });
});
