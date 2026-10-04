import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SLOGAN_STUDY_CSS } from "../brand/sloganStudy.js";
import { PREVIEW_WALLET_CSS } from "../openMint/previewWallet.js";
import { SITE_FONT_CSS, SITE_FONT_PRELOAD, SITE_FONT_FAMILY, SITE_FONT_WEIGHT, SITE_FONT_EMPHASIS_WEIGHT, siteFontAsset } from "./fonts.js";
import { SITE_CSS } from "./siteCss.js";
import { SITE_CONTROLS_CSS } from "./controlsCss.js";

describe("single-family site typography", () => {
  const require = createRequire(import.meta.url);
  const paths = [...SITE_FONT_CSS.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1]);

  it("defines Playpen Sans native light once, while preserving real bold emphasis", () => {
    expect(SITE_FONT_FAMILY).toBe("Playpen Sans");
    expect(SITE_FONT_WEIGHT).toBe(300);
    expect(SITE_FONT_EMPHASIS_WEIGHT).toBe(700);
    expect(SITE_CSS).toContain('--font-family:"Playpen Sans",sans-serif');
    expect(SITE_CSS).toContain("--ui-font-weight:300");
    expect(SITE_CSS).toContain("--emphasis-font-weight:700");
    expect(SITE_CSS).toContain("font-synthesis:style");
    expect(SITE_CSS).not.toMatch(/font-synthesis:(?:weight|none)/);
    expect(SITE_CSS).toContain("body :is(strong,b){font-weight:var(--emphasis-font-weight)}");
  });

  it("keeps reading text at 14px while shared controls opt into 16px without resizing SVG artwork", () => {
    const globalRule = "body,body :not(svg,svg *){font-size:var(--ui-font-size);font-weight:var(--ui-font-weight)}";
    const emphasisRule = "body :is(strong,b){font-weight:var(--emphasis-font-weight)}";
    expect(SITE_CSS).toContain("--ui-font-size:14px");
    expect(SITE_CSS).toContain(globalRule);
    expect(SITE_CSS).toMatch(/html\{font-size:16px(?:;[^}]*)?\}/);
    expect(SITE_CSS).toContain("max-width:1024px");
    expect(SITE_CSS).toContain("max-width:42rem");
    expect(SITE_CSS).toContain(SITE_CONTROLS_CSS);
    expect(SITE_CONTROLS_CSS.match(/font-size:16px;font-weight:var\(--ui-font-weight\)/g)).toHaveLength(2);
    const uiCss = (SITE_CSS.replace(SITE_FONT_CSS, "").replace(SITE_CONTROLS_CSS, "") + SLOGAN_STUDY_CSS)
      .replace("--ui-font-size:14px;", "").replace("--ui-font-weight:300;", "").replace("--emphasis-font-weight:700;", "")
      .replace(/html\{font-size:16px(?:;[^}]*)?\}/, "").replace(globalRule, "").replace(emphasisRule, "");
    // Only canonical controls and intentional bold emphasis opt out of reading typography.
    expect(uiCss).not.toMatch(/font-size:|font-weight:|font:(?!inherit)/);
    expect(SLOGAN_STUDY_CSS).toContain(".study-mark-large svg{height:54px;width:30px}");
    expect(SLOGAN_STUDY_CSS).toContain(".study-mark-small svg{height:24px;width:13.333px}");
  });

  it("preserves all native Playpen weight and Unicode ranges without inventing an italic font", () => {
    expect(paths).toHaveLength(16);
    expect(new Set(paths).size).toBe(16);
    expect(SITE_FONT_CSS.match(/font-family: 'Playpen Sans';/g)).toHaveLength(16);
    expect(SITE_FONT_CSS.match(/font-weight: 100 800;/g)).toHaveLength(16);
    expect(SITE_FONT_CSS.match(/font-display: swap;/g)).toHaveLength(16);
    expect(SITE_FONT_CSS.match(/font-style: normal;/g)).toHaveLength(16);
    expect(SITE_FONT_CSS.match(/unicode-range:/g)).toHaveLength(16);
    expect(SITE_FONT_CSS).not.toMatch(/font-style: italic;|italic\.woff2|https?:/);
    const upstream = readFileSync(require.resolve("@fontsource-variable/playpen-sans/wght.css"), "utf8");
    expect(SITE_FONT_CSS).toContain(upstream.replaceAll("Playpen Sans Variable", "Playpen Sans").replaceAll("./files/", "/assets/fonts/playpen-sans-5.3.0/"));
  });

  it("keeps the informational wallet disclosure on shared reading typography and canonical controls", () => {
    expect(SITE_CSS).toContain(PREVIEW_WALLET_CSS);
    expect(PREVIEW_WALLET_CSS).not.toMatch(/font-size:|font-weight:|font:(?!inherit)/);
    expect(PREVIEW_WALLET_CSS).toContain(".preview-wallet-panel .auth-action{width:100%}");
  });

  it.each(paths)("resolves versioned WOFF2 bytes for %s", (path) => {
    expect(path).toMatch(/^\/assets\/fonts\/playpen-sans-5\.3\.0\//);
    const asset = siteFontAsset(path)!;
    expect(asset.contentType).toBe("font/woff2");
    expect(asset.bytes.subarray(0, 4).toString()).toBe("wOF2");
    const filename = path.slice(path.lastIndexOf("/") + 1);
    expect(asset.bytes).toEqual(readFileSync(require.resolve(`@fontsource-variable/playpen-sans/files/${filename}`)));
  });

  it("preloads only upright Latin with the same anonymous URL used by CSS", () => {
    const path = SITE_FONT_PRELOAD.match(/href="([^"]+)"/)![1];
    expect(paths).toContain(path);
    expect(path).toMatch(/\/playpen-sans-latin-wght-normal\.woff2$/);
    expect(SITE_FONT_PRELOAD).toContain('as="font" type="font/woff2" crossorigin');
    expect(SITE_FONT_PRELOAD.match(/<link /g)).toHaveLength(1);
  });

  it("ships the license without exposing arbitrary package or filesystem paths", () => {
    const licensePath = paths[0].replace(/[^/]+$/, "LICENSE.txt");
    const license = siteFontAsset(licensePath)!;
    expect(license.bytes.toString()).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(license.bytes.toString()).toContain("Copyright 2023 The Playpen Sans Project Authors");
    expect(siteFontAsset(licensePath.replace("LICENSE.txt", "package.json"))).toBeUndefined();
    expect(siteFontAsset(`${licensePath}/../../package.json`)).toBeUndefined();
    expect(siteFontAsset("/assets/fonts/playpen-sans-5.3.0/playpen-sans-latin-wght-italic.woff2")).toBeUndefined();
    expect(siteFontAsset("/assets/fonts/instrument-sans-5.3.0/instrument-sans-latin-wght-normal.woff2")).toBeUndefined();
  });

  it("removes legacy serif and monospace overrides, including native form and code defaults", () => {
    expect(SITE_CSS).toContain('--font-family:"Playpen Sans",sans-serif');
    expect((SITE_CSS + SLOGAN_STUDY_CSS).replace("--emphasis-font-weight:700;", "")).not.toMatch(/Georgia|Times New Roman|Inter,|ui-monospace|SFMono|Consolas|font-weight:700/);
    expect(SITE_CSS).toContain("button,input,select,textarea{font:inherit}");
    expect(SITE_CSS).toContain("code,pre,kbd,samp{font-family:var(--font-family)}");
    expect(SITE_CSS).toContain("font-variant-numeric:tabular-nums");
    // Numeric captions and provenance retain tabular alignment at the common size.
    const numericSelectors = SITE_CSS.match(/([^{}]+)\{font-variant-numeric:tabular-nums\}/)![1].trim().split(",");
    expect(numericSelectors).toEqual(expect.arrayContaining([
      ".gallery-card-copy>span", ".signature-card time", ".gr0k-readout strong", ".facts dd",
    ]));
  });
});
