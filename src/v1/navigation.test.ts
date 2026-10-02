import { describe, expect, it } from "vitest";
import { HOME_LINK, HOME_ICON } from "./navigation.js";
import { aboutPage, collectionPage, signInRequiredPage } from "./pages.js";
import { buttonStudyPage } from "../brand/buttonStudy.js";
import { SITE_CSS } from "./siteCss.js";

describe("balanced public and personal navigation", () => {
  it("labels the public gallery with four canvases and no visible word", () => {
    expect(HOME_LINK).toContain('href="/" aria-label="Gallery" title="Gallery"');
    expect(HOME_LINK).toContain(HOME_ICON);
    expect(HOME_LINK).not.toMatch(/>Home<|>Gallery<|←|return-arrow/);
    expect(HOME_ICON).toContain('aria-hidden="true" focusable="false"');
    expect(HOME_ICON).toContain('fill="currentColor"');
    expect(HOME_ICON).not.toMatch(/stroke=|fill="none"/);
    expect(HOME_ICON).not.toContain("<path");
    expect(HOME_ICON).toContain('viewBox="0 0 11 11" width="11" height="11"');
    const squares = [...HOME_ICON.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/g)]
      .map(match => match.slice(1).map(Number));
    expect(squares).toEqual([[0, 0, 4.5, 4.5], [6.5, 0, 4.5, 4.5], [0, 6.5, 4.5, 4.5], [6.5, 6.5, 4.5, 4.5]]);
    const gridInkArea = squares.reduce((area, [, , width, height]) => area + width * height, 0);
    expect(gridInkArea).toBe(81);
    expect(Math.abs(gridInkArea / (Math.PI * 5 ** 2) - 1)).toBeLessThan(0.04);
  });

  it.each([
    ["about", () => aboutPage()],
    ["sign-in", () => signInRequiredPage(false)],
    ["collection", () => collectionPage({ currentHandle: "alice", signatures: [], csrfToken: "test-csrf", fixtureMode: true, mintEnabled: false, mintChainId: "31337" })],
    ["button study", () => buttonStudyPage()],
  ] as const)("uses the shared icon on %s", (_name, render) => {
    const html = render();
    expect(html).toContain(HOME_LINK);
    expect(html).not.toContain("<span>Home</span>");
  });

  it("balances an 11px grid and 10px dot inside identical centered 44px targets", () => {
    const rule = SITE_CSS.match(/(?:^|\})\s*\.gallery-return\{([^}]*)\}/)![1];
    expect(rule).toContain("place-items:center;width:44px;height:44px");
    expect(rule).toContain("color:var(--collection-dot)");
    expect(rule).toContain("inset-block-start:max(.75rem,env(safe-area-inset-top))");
    expect(rule).toContain("inset-inline-start:max(.75rem,env(safe-area-inset-left))");
    expect(SITE_CSS).toContain(".home-icon{display:block;width:11px;height:11px;flex:none}");
    expect(SITE_CSS).toContain(".collection-shortcut-dot{display:block;width:10px;height:10px;border-radius:50%;background:currentColor}");
    const personal = SITE_CSS.match(/(?:^|\})\s*\.collection-shortcut\{([^}]*)\}/)![1];
    expect(personal).toContain("place-items:center;width:44px;height:44px");
    expect(personal).toContain("color:var(--collection-dot)");
    expect(personal).toContain("inset-block-start:max(.75rem,env(safe-area-inset-top))");
    expect(SITE_CSS).not.toContain(".home-return:hover>span:last-child");
    expect(SITE_CSS).toContain(".gallery-return:focus-visible");
  });
});
