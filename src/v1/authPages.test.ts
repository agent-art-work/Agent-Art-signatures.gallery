import { describe, expect, it } from "vitest";
import { errorPage, localOAuthAuthorizePage, previewPage, reviewPage, signInRequiredPage } from "./pages.js";
import { SITE_CSS } from "./siteCss.js";
import { SITE_ACTION_SELECTOR, SITE_CONTROLS_CSS } from "./controlsCss.js";

const preview = {
  handle: "alice",
  gr0kRaw: 37,
  rendererVersion: "artwork/1",
  previewSvgSha256: "a".repeat(64),
  imageUrl: "/artifacts/preview.png",
  fixtureMode: false,
};
const review = { ...preview, flowId: "claim-flow", csrfToken: "claim-csrf" };
const accounts = [
  { key: "alice-fixture", username: "alice", displayName: "Alice fixture" },
  { key: "bob-fixture", username: "bob", displayName: "Bob fixture" },
];

function formFor(html: string, action: string): string {
  const form = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)]
    .map((match) => match[0])
    .find((candidate) => candidate.includes(`action="${action}"`));
  expect(form, `Expected a POST form for ${action}`).toBeDefined();
  expect(form).toMatch(/^<form\b[^>]*method="post"/);
  return form!;
}

function visibleBody(html: string): string {
  return html.slice(html.indexOf("<body"))
    .replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
}

describe("minimal authentication pages", () => {
  it.each([false, true])("keeps claim guidance on the CTA below the artwork without numbered steps (local=%s)", localOAuthMode => {
    const pages = [previewPage({ ...preview, localOAuthMode }), reviewPage({ ...review, localOAuthMode })];
    pages.forEach((html, index) => {
      const action = html.match(/<section class="claim-action"[\s\S]*?<\/section>/)![0];
      expect(action).toContain(`data-claim-state="${index === 0 ? "sign-in" : "confirm"}"`);
      expect(action).not.toContain("auth-note");
      expect(html.indexOf(action)).toBeGreaterThan(html.indexOf('</figure>'));
      if (index === 0) {
        expect(action).not.toContain("<p>");
        expect(action).toContain('data-action-tooltip="claim-tooltip" aria-describedby="claim-tooltip"');
        expect(action).toContain('id="claim-tooltip" role="tooltip" hidden>Signing in as @alice');
        expect(html).toContain('/assets/action-tooltip.js?v=');
      } else expect(action.indexOf("<p>")).toBeLessThan(action.indexOf("<form"));
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      expect(visibleBody(html)).toContain(action);
      expect(html).not.toMatch(/Step [12] of 2|claim-progress|data-claim-step/);
    });
    expect(pages[0]).toContain("Claim with X");
    expect(pages[0]).toContain("will claim this signature");
    expect(pages[0]).not.toContain("then confirm");
    expect(pages[1]).toContain("Signed in as @alice. Confirm to add this signature");
    expect(SITE_CSS).toMatch(/\.claim-action\{[^}]*color:var\(--ink\)/);
  });

  it("shows completion in the same action area without a second claim form", () => {
    const html = previewPage({ ...preview, claim: { state: "claimed", signatureId: "saved-signature" } });
    const action = html.match(/<section class="claim-action"[\s\S]*?<\/section>/)![0];
    expect(action).toContain('id="claim" data-claim-state="claimed"');
    expect(action).toContain("now in your collection");
    expect(action).not.toContain('href="/me"');
    expect(action).not.toContain('href="/?tab=claimed"');
    expect(action).toContain('href="/signatures/saved-signature"');
    expect(action).not.toContain("<form");
    expect(html).toContain('data-signature-status="claimed"');
  });

  it("clearly separates successful sign-in from failed saving and offers an explicit retry", () => {
    const html = previewPage({ ...preview, claim: { state: "retry", flowId: "retry-flow", csrfToken: "retry-csrf" } });
    const form = formFor(html, "/api/v1/signatures");
    expect(form).toContain("Retry claim");
    expect(form).toContain('name="flow" value="retry-flow"');
    expect(form).toContain('name="csrf" value="retry-csrf"');
    expect(html).toContain("Your X sign-in succeeded, but the claim could not be saved.");
    expect(html).not.toMatch(/Confirm claim|data-signature-status="claimed"/);
    const custom = previewPage({ ...preview, claim: { state: "retry", flowId: "f", csrfToken: "t" }, notice: '<script>alert("bad")</script>' });
    expect(custom).not.toContain('<script>alert("bad")</script>');
    expect(custom).toContain("&lt;script&gt;");
  });

  it.each([
    ["preview", () => previewPage(preview)],
    ["claim review", () => reviewPage(review)],
    ["sign in", () => signInRequiredPage(false)],
    ["error", () => errorPage(401, "AUTH_EXPIRED", "Sign in again.")],
    ["local OAuth", () => localOAuthAuthorizePage({ requestId: "oauth-request", accounts })],
  ] as const)("puts %s on the shared compact book canvas", (_name, render) => {
    const html = render();
    expect(html).toContain('<body class="book-page">');
    expect(html).toMatch(/<section\b[^>]*class="auth-page(?:\s[^"]*)?"/);
    expect(html).toMatch(/class="auth-sheet(?:\s[^"]*)?"/);
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toMatch(/class="auth-action(?:\s[^"]*)?"[^>]*><span>/);
    expect(html).not.toMatch(/class="(?:preview-grid|claim-panel|review-wrap|review-copy|message-page|oauth-rehearsal|oauth-consent)(?:\s|")/);
    const main = html.match(/<main>[\s\S]*?<\/main>/)![0];
    const disclosures = [...main.matchAll(/<details\b[^>]*>/g)].map((match) => match[0]);
    if (_name === "local OAuth") {
      expect(main).not.toContain('action="/dev/oauth/x/authorize"');
      expect(html).toContain('<details class="rehearsal-disclosure" open>');
    } else expect(disclosures.length).toBeGreaterThan(0);
    for (const disclosure of disclosures) {
      expect(disclosure).toMatch(/class="auth-disclosure(?:\s[^"]*)?"/);
      expect(disclosure).not.toMatch(/\sopen(?:\s|=|>)/);
    }
  });

  it.each([false, true])("keeps the preview claim as a POST with its exact inputs (local=%s)", (localOAuthMode) => {
    const html = previewPage({ ...preview, localOAuthMode });
    const form = formFor(html, "/auth/x/start");
    expect(form).toContain('<input type="hidden" name="purpose" value="claim">');
    expect(form).toContain('<input type="hidden" name="handle" value="alice">');
    expect(form).toContain('<input type="hidden" name="gr0k" value="37">');
    expect(form).toContain('name="claim_intent" value="claim-on-return-v1"');
    expect(form).toContain('name="renderer_version" value="artwork/1"');
    expect(form).toContain(`name="preview_sha256" value="${preview.previewSvgSha256}"`);
    expect(form).toContain("<span>Claim with X</span>");
    expect(html).toContain('src="/artifacts/preview.svg"');
    expect(html).toContain('property="og:image" content="/artifacts/preview.png"');
  });

  it.each([false, true])("keeps sign-in separate from claiming (local=%s)", (localOAuthMode) => {
    const html = signInRequiredPage(true, localOAuthMode);
    const form = formFor(html, "/auth/x/start");
    expect(form).toContain('<input type="hidden" name="purpose" value="account_login">');
    expect(form).not.toMatch(/name="(?:handle|gr0k|claim_intent)"/);
    expect(form).toContain("Sign in with X");
    expect(form).not.toContain("Use local OAuth emulator");
  });

  it("retains every local OAuth decision, the request binding and native account selection", () => {
    const html = localOAuthAuthorizePage({ requestId: "oauth-request", accounts });
    const form = formFor(html, "/dev/oauth/x/authorize");
    expect(form).toContain('<input type="hidden" name="request" value="oauth-request">');
    const radios = [...form.matchAll(/<input\b[^>]*type="radio"[^>]*>/g)].map((match) => match[0]);
    expect(radios).toHaveLength(2);
    expect(radios[0]).toContain('name="account" value="alice-fixture" checked');
    expect(radios[1]).toContain('name="account" value="bob-fixture"');
    expect(radios[1]).not.toMatch(/\schecked(?:\s|=|>)/);
    for (const decision of ["approve", "deny", "provider_error"]) {
      expect(form).toMatch(new RegExp(`<button\\b[^>]*type="submit"[^>]*name="decision"[^>]*value="${decision}"`));
    }
    expect(form).toContain("Approve local identity");
    expect(form).toContain("Simulate account denial");
    expect(form).toContain("Simulate provider error");
  });

  it.each([false, true])("preserves the explicit claim and its visible consequences (local=%s)", (localOAuthMode) => {
    const html = reviewPage({ ...review, localOAuthMode });
    const form = formFor(html, "/api/v1/signatures");
    expect(form).toContain('<input type="hidden" name="flow" value="claim-flow">');
    expect(form).toContain('<input type="hidden" name="csrf" value="claim-csrf">');
    expect(form).toContain("Confirm claim");
    const visible = visibleBody(html);
    expect(visible).toMatch(/withdraw the claim before minting begins/i);
    expect(visible).toMatch(/public/i);
    expect(visible).toMatch(/does not mint a token/i);
    expect(html).toContain('href="/s/alice/37#claim"');
  });

  it("puts local identity limits in the distinct DEV overlay before an approval or claim", () => {
    for (const html of [
      previewPage({ ...preview, localOAuthMode: true }),
      reviewPage({ ...review, localOAuthMode: true }),
      signInRequiredPage(true),
      localOAuthAuthorizePage({ requestId: "oauth-request", accounts }),
    ]) {
      const main = html.match(/<main>[\s\S]*?<\/main>/)![0];
      expect(main).not.toMatch(/No X account|accounts are simulated|emulator asserted|Local identity rehearsal/i);
      const overlay = html.slice(html.indexOf('<aside class="rehearsal-watermark"'));
      expect(overlay).toMatch(/(?:does not|doesn[’']t)[^.]*prove control of (?:an|any) X account|no X account (?:was|is) authenticated/i);
    }
    const realReview = reviewPage({ ...review, fixtureMode: true, localOAuthMode: false });
    expect(realReview).toContain("X authenticated");
    expect(realReview).not.toContain("emulator asserted");
    expect(realReview).toMatch(/does not prove[^.]*Grok/);
  });

  it.each(["AUTH_EXPIRED", "AUTH_REQUIRED"])("keeps %s recovery as an account-login POST", (code) => {
    for (const localOAuthMode of [false, true]) {
      const html = errorPage(401, code, "Identity expired.", true, localOAuthMode);
      const form = formFor(html, "/auth/x/start");
      expect(form).toContain('<input type="hidden" name="purpose" value="account_login">');
      expect(form).toContain("Sign in with X");
      expect(html).not.toContain('href="/auth/x/start"');
    }
    expect(errorPage(404, "NOT_FOUND", "No such page.")).not.toContain('action="/auth/x/start"');
  });

  it("escapes dynamic text and attribute values throughout authentication", () => {
    const attack = '\"><script>alert(1)</script>&';
    const escaped = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;';
    const htmlPages = [
      previewPage({ ...preview, handle: attack, rendererVersion: attack, imageUrl: attack }),
      reviewPage({ ...review, handle: attack, rendererVersion: attack, imageUrl: attack, flowId: attack, csrfToken: attack }),
      errorPage(400, attack, attack),
      localOAuthAuthorizePage({ requestId: attack, accounts: [{ key: attack, username: attack, displayName: attack }] }),
    ];
    for (const html of htmlPages) {
      expect(html).not.toContain(attack);
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain(escaped);
    }
    expect(formFor(htmlPages[1], "/api/v1/signatures")).toContain(`name="flow" value="${escaped}"`);
    expect(formFor(htmlPages[1], "/api/v1/signatures")).toContain(`name="csrf" value="${escaped}"`);
    expect(formFor(htmlPages[3], "/dev/oauth/x/authorize")).toContain(`name="request" value="${escaped}"`);
  });

  it("uses the shared pill controls with accessible labels and hit targets", () => {
    expect(SITE_CSS).toContain("body,body :not(svg,svg *){font-size:var(--ui-font-size);font-weight:var(--ui-font-weight)}");
    const action = SITE_CONTROLS_CSS.split(SITE_ACTION_SELECTOR + "{")[1]?.split("}")[0];
    expect(action).toContain("min-height:48px");
    expect(action).toContain("min-width:44px");
    expect(action).toContain("font-size:16px;font-weight:var(--ui-font-weight)");
    expect(action).toContain("border-radius:999px");
    expect(SITE_CONTROLS_CSS).toContain("body .auth-action>span:first-child");
    expect(SITE_CONTROLS_CSS).toContain("padding:0;border:0");
    expect(SITE_CONTROLS_CSS).toContain(":focus-visible{outline:2px solid var(--ink);outline-offset:4px}");
    expect(SITE_CSS).toContain(".auth-disclosure>summary:focus-visible");
  });
});
