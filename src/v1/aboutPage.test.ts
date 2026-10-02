import { describe, expect, it } from "vitest";
import { aboutPage, homePage, signInRequiredPage } from "./pages.js";
import { SITE_CSS } from "./siteCss.js";

describe("footer and About the work", () => {
  it.each([
    ["home", () => homePage(false)],
    ["sign-in", () => signInRequiredPage(false)],
    ["about", () => aboutPage(false)],
  ] as const)("groups attribution and adds one about link on %s", (_name, render) => {
    const footer = render().match(/<footer\b[^>]*>[\s\S]*?<\/footer>/)![0];
    expect(footer).toContain('<div class="footer-credit">by <a class="footer-agent" href="https://x.com/AgentArt_AA" target="_blank" rel="noopener noreferrer" aria-label="Agent Art on X (opens in a new tab)"><svg class="footer-x-icon"');
    expect(footer).not.toContain("Signatures Gallery ·");
    const xIcon = footer.match(/<svg class="footer-x-icon"[\s\S]*?<\/svg>/)![0];
    expect(footer.match(/class="footer-x-icon"/g)).toHaveLength(1);
    expect(xIcon).toContain('fill="currentColor"');
    expect(xIcon).toContain('aria-hidden="true" focusable="false"');
    expect(xIcon).toContain('<path d="');
    expect(footer).toContain(`${xIcon}<span>Agent Art</span><span aria-hidden="true">↗</span></a>`);
    expect(SITE_CSS).toContain(".footer-x-icon{display:block;width:12px;height:12px;flex:none}");
    expect(footer).not.toContain("Project 01");
    expect(footer).not.toContain("v2");
    expect(footer.match(/class="footer-about"/g)).toHaveLength(1);
    expect(footer).toContain('href="/about"');
    expect(footer).toContain('>About the work</a>');
    expect(footer).not.toContain("Presented by");
  });

  it("marks About current only on its own page", () => {
    expect(aboutPage()).toContain('class="footer-about" href="/about" aria-current="page"');
    expect(homePage(false)).not.toContain('href="/about" aria-current="page"');
  });

  it("underlines only the Agent Art label, not the X icon or external-link arrow", () => {
    expect(SITE_CSS).toMatch(/\.footer-agent\{[^}]*text-decoration:none/);
    expect(SITE_CSS).toContain(".footer-agent>span:not([aria-hidden]){text-decoration:underline}");
    const footer = homePage(false).match(/<footer\b[^>]*>[\s\S]*?<\/footer>/)![0];
    expect(footer).toContain('<span>Agent Art</span><span aria-hidden="true">↗</span></a>');
    expect(footer).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it("uses the shared minimal canvas, Gallery navigation and account panel", () => {
    const html = aboutPage();
    expect(html).toContain('<body class="book-page">');
    expect(html).toContain('aria-label="Gallery"');
    expect(html).toContain('class="account-panel"');
    expect(html).toContain('<h1 id="about-heading">About the work</h1>');
    expect(SITE_CSS).toContain('body,body :not(svg,svg *){font-size:var(--ui-font-size);font-weight:var(--ui-font-weight)}');
    expect(SITE_CSS).toMatch(/\.about-sheet\{[^}]*max-width:42rem/);
    expect(SITE_CSS).toMatch(/\.footer-about\{[^}]*margin-inline-start:auto/);
    expect(SITE_CSS).toContain('.footer-about:focus-visible');
  });

  it("explains the work and separates previews, claims, mints and private Grok provenance", () => {
    const html = aboutPage();
    for (const text of ["artist-defined algorithm", "Grok reads recent public posts", "environmental condition", "not a score", "A preview creates no claim", "Minting is a separate, optional wallet action", "does not prove control of the claimant’s X account", "cannot independently verify the private conversation"]) expect(html).toContain(text);
    expect(html).not.toContain('action="/api/v1/signatures"');
    expect(html).not.toContain('class="mint-authorization-form"');
  });

  it.each([[true, false], [false, true], [true, true]])("qualifies development environments (%s, %s)", (fixture, local) => {
    const html = aboutPage(fixture, local);
    expect(html).toContain('name="robots" content="noindex"');
    expect(html.match(/class="rehearsal-watermark"/g)).toHaveLength(1);
  });

  it("makes the production explanation indexable and rehearsal-free", () => {
    const html = aboutPage(false, false);
    expect(html).toContain('name="robots" content="index"');
    expect(html).not.toContain('class="rehearsal-watermark"');
  });
});
