import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import type { XOAuthClient } from "../claim/xOAuthClient.js";
import { MemoryAuthState } from "../v1/authState.js";
import { seedDevelopmentFixtures } from "../v1/fixtures.js";
import { CARD_RENDERER_VERSION, RENDERER_VERSION, formalSignatureRenderer, RendererRegistry } from "../v1/renderer.js";
import { MemorySignatureStore } from "../v1/store.js";
import { errorPage } from "../v1/pages.js";
import { xProfileLink } from "../v1/xProfile.js";
import { SITE_FONT_CSS, SITE_FONT_PRELOAD, siteFontAsset } from "../v1/fonts.js";
import { FAVICON_CSP, FAVICON_SVG, FAVICON_URL } from "../brand/favicon.js";
import { loadMintConfig } from "../v2/config.js";
import { FIXTURE_TRANSFER_HOLDER, seedV2DevelopmentFixtures } from "../v2/fixtures.js";
import { GALLERY_DEVELOPMENT_FIXTURES, seedGalleryDevelopmentFixtures } from "../v2/galleryFixtures.js";
import { MemoryMintStore } from "../v2/memoryStore.js";
import { V2MintService } from "../v2/service.js";
import { startServer, type AppOptions } from "./server.js";

let server: ReturnType<typeof startServer>;
let store: MemorySignatureStore;
let auth: MemoryAuthState;
let mint: V2MintService | undefined;
let baseUrl: string;
const SELF_HOSTED_FONT_PATHS = [...SITE_FONT_CSS.matchAll(/url\(([^)]+)\)/g)].map(match => match[1]!);
const SELF_HOSTED_FONT_ASSET_PATHS = [...SELF_HOSTED_FONT_PATHS, SELF_HOSTED_FONT_PATHS[0]!.replace(/[^/]+$/, "LICENSE.txt")];

async function boot(seed = false, seedMint = false, mintEnabled = true, optionOverrides: Partial<AppOptions> = {}, seedGallery = false) {
  store = new MemorySignatureStore();
  const artifacts = new MemoryArtifactStore();
  auth = new MemoryAuthState();
  const renderers = new RendererRegistry([formalSignatureRenderer]);
  if (seed) await seedDevelopmentFixtures({ store, artifacts, renderers, cardRendererVersion: CARD_RENDERER_VERSION }, auth);
  if (seedMint) {
    const config = loadMintConfig({}, true, "http://localhost:3000");
    const state = new MemoryMintStore();
    mint = new V2MintService(config, state, store, artifacts);
    await seedV2DevelopmentFixtures(mint, store);
    if (seedGallery) await seedGalleryDevelopmentFixtures({ store, artifacts, renderers, cardRendererVersion: CARD_RENDERER_VERSION }, auth, mint);
    if (!mintEnabled) {
      mint = new V2MintService(loadMintConfig({ MINT_FEATURE_ENABLED: "false" }, true, "http://localhost:3000"), state, store, artifacts);
    }
  } else {
    mint = undefined;
  }
  server = startServer({ store, artifacts, auth, renderers, mint }, 0, { fixtureMode: true, activeRendererVersion: RENDERER_VERSION, ...optionOverrides });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
}

function postJson(path: string, body: Record<string, unknown>, cookie: string, csrf: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": csrf,
      Cookie: cookie,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function closeServer(): Promise<void> {
  const closing = server;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Test HTTP server teardown timed out.")), 2_000);
    timer.unref();
    closing.close(error => { clearTimeout(timer); error ? reject(error) : resolve(); });
    // Tests may assert a refusal using headers only. Those response bodies must
    // not keep an active connection alive after this isolated case is finished.
    closing.closeAllConnections();
  });
}

function post(path: string, body: URLSearchParams, cookie?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: baseUrl,
      "Sec-Fetch-Site": "same-origin",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
}

function responseCookie(response: Response): string {
  return response.headers.get("set-cookie")!.split(";")[0];
}

async function beginLocalOAuth(body: URLSearchParams, cookie?: string) {
  const response = await post("/auth/x/start", body, cookie);
  expect(response.status).toBe(302);
  const authorizationPath = response.headers.get("location")!;
  expect(authorizationPath).toMatch(/^\/dev\/oauth\/x\/authorize\?request=/);
  return { authorizationPath, cookie: cookie ?? responseCookie(response) };
}

async function decideLocalOAuth(
  started: Awaited<ReturnType<typeof beginLocalOAuth>>,
  decision: "approve" | "deny" | "provider_error" = "approve",
  account = "alice",
) {
  const request = new URL(started.authorizationPath, baseUrl).searchParams.get("request")!;
  const response = await post("/dev/oauth/x/authorize", new URLSearchParams({ request, decision, account }));
  expect(response.status).toBe(303);
  return { callbackPath: response.headers.get("location")!, cookie: started.cookie };
}

async function finishLocalOAuth(decided: Awaited<ReturnType<typeof decideLocalOAuth>>) {
  return fetch(`${baseUrl}${decided.callbackPath}`, { redirect: "manual", headers: { Cookie: decided.cookie } });
}

async function localLogin(account = "alice") {
  const started = await beginLocalOAuth(new URLSearchParams({ purpose: "account_login" }));
  const callback = await finishLocalOAuth(await decideLocalOAuth(started, "approve", account));
  expect(callback.status).toBe(303);
  expect(callback.headers.get("location")).toBe("/me");
  const cookie = responseCookie(callback);
  expect(cookie).not.toBe(started.cookie);
  return { cookie, originalCookie: started.cookie };
}

function expectCollectionShortcut(html: string) {
  const shortcuts = [...html.matchAll(/<a\b[^>]*class="collection-shortcut"[^>]*>[\s\S]*?<\/a>/g)];
  expect(shortcuts).toHaveLength(1);
  const shortcut = shortcuts[0][0];
  expect(shortcut).toContain('href="/me"');
  expect(shortcut).not.toContain("title=");
  expect(html).toContain('id="account-panel-heading"><a href="/me">My Collection</a></h2>');
  expect(shortcut).toContain('aria-label="My Collection"');
  expect(shortcut).toContain('<span class="collection-shortcut-dot" aria-hidden="true"></span>');
  expect(shortcut.replace(/<[^>]*>/g, "").trim()).toBe("");
}

beforeEach(() => boot());
afterEach(() => closeServer());

describe("V1 previews", () => {
  it("serves the new favicon without permanently caching unversioned or stale URLs", async () => {
    for (const path of [FAVICON_URL, "/assets/favicon.svg", "/assets/favicon.svg?v=old"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image/svg+xml");
      expect(response.headers.get("content-security-policy")).toBe(FAVICON_CSP);
      expect(response.headers.get("cache-control")).toBe(path === FAVICON_URL ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate");
      expect(await response.text()).toBe(FAVICON_SVG);
      const head = await fetch(`${baseUrl}${path}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("cache-control")).toBe(response.headers.get("cache-control"));
      expect(head.headers.get("content-security-policy")).toBe(FAVICON_CSP);
      expect(await head.text()).toBe("");
    }
  });

  it("preserves native same-origin form origins without accepting null or foreign origins", async () => {
    const page = await fetch(`${baseUrl}/s/alice/37`);
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    for (const origin of ["null", "https://example.com"]) {
      const response = await fetch(`${baseUrl}/auth/x/start`, {
        method: "POST", redirect: "manual", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ purpose: "account_login" }),
      });
      expect(response.status).toBe(403);
    }
  });
  it("defaults to Claimed and exposes two keyboard-accessible, shareable gallery views", async () => {
    const claimed = await (await fetch(`${baseUrl}/`)).text();
    expect(claimed).toContain('<nav class="gallery-tabs" aria-label="Signature galleries">');
    expect(claimed).toContain('<a href="/?tab=claimed" aria-current="page"><span>Claimed</span></a>');
    expect(claimed).toContain('<span aria-hidden="true">|</span><a href="/?tab=minted"><span>Minted</span></a>');
    expect(claimed).toContain("No claimed signatures yet.");
    const minted = await (await fetch(`${baseUrl}/?tab=minted`)).text();
    expect(minted).toContain('<a href="/?tab=minted" aria-current="page"><span>Minted</span></a>');
    expect(minted).toContain("No finalized signatures yet.");
    expect(minted.match(/aria-current="page"/g)).toHaveLength(1);
    const head = await fetch(`${baseUrl}/?tab=claimed`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it.each(["/", "/?tab=claimed", "/?tab=minted", "/me"])("offers side-effect-free anonymous participation at %s", async (path) => {
    const response = await fetch(baseUrl + path);
    expect(response.status).toBe(path === "/me" ? 401 : 200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const html = await response.text();
    expect(html.match(/data-grok-handoff/g)).toHaveLength(1);
    expect(html).toContain("First, ask me for my X handle.");
    expect(html).toContain(`${baseUrl}/s/HANDLE/GR0K`);
    expect(html).not.toContain("/s/newcomer/GR0K");
    expect(html).not.toContain('class="empty-frame"');
    expect(html).not.toContain('class="gallery-card"');
    expect(html).not.toContain('class="collection-card"');
    const head = await fetch(baseUrl + path, { method: "HEAD" });
    expect(head.status).toBe(response.status);
    expect(head.headers.get("set-cookie")).toBeNull();
    expect(await head.text()).toBe("");
    expect(await store.listClaimedSignatures(100)).toEqual([]);
  });

  it("does not personalize public empty-gallery prompts from a private X session", async () => {
    const paths = ["/?tab=claimed", "/?tab=minted"];
    const before = await Promise.all(paths.map(async (path) => (await fetch(baseUrl + path)).text()));
    const { cookie } = await localLogin("newcomer");
    for (const [index, path] of paths.entries()) {
      const html = await (await fetch(baseUrl + path, { headers: { Cookie: cookie } })).text();
      expect(html).toBe(before[index]);
      expect(html).not.toContain("@newcomer");
      expect(html).toContain(`${baseUrl}/s/HANDLE/GR0K`);
    }
  });

  it("lists every account's committed claims, including minted works, independently of login", async () => {
    await closeServer();
    await boot(true, true);
    const claims = await store.listSignaturesForAccount("1234567890123456789");
    const bob = await store.claim({ ...claims[0], xUserId: "999999999", handleAtClaim: "bob", handleNormalized: "bob" });
    const anonymous = await (await fetch(`${baseUrl}/?tab=claimed`)).text();
    expect(anonymous.match(/class="gallery-card"/g)).toHaveLength(4);
    for (const signature of [...claims, bob.signature]) expect(anonymous).toContain(signature.signatureId);
    expect(anonymous).toContain("Fictional demo");
    expect(anonymous).not.toContain("Fixture mint wallet");
    expect(anonymous).not.toContain("999999999");
    const { cookie } = await localLogin();
    expect(await (await fetch(`${baseUrl}/?tab=claimed`, { headers: { Cookie: cookie } })).text()).toBe(anonymous);
    const minted = await (await fetch(`${baseUrl}/?tab=minted`)).text();
    expect(minted.match(/class="gallery-card"/g)).toHaveLength(1);
    expect(minted).not.toContain(bob.signature.signatureId);
    expect(minted).not.toContain("<time");
    expect(anonymous).not.toContain("<time");
  });

  it("centers same-color tabs with a background-only selected state and visible keyboard focus", async () => {
    const css = await (await fetch(`${baseUrl}/assets/site.css`)).text();
    const nav = css.match(/\.gallery-tabs\{([^}]*)\}/)![1];
    const link = css.match(/\.gallery-tabs a\{([^}]*)\}/)![1];
    const label = css.match(/\.gallery-tabs a>span\{([^}]*)\}/)![1];
    const selected = css.match(/\.gallery-tabs a\[aria-current="page"\]>span\{([^}]*)\}/)![1];
    expect(nav).toContain("justify-content:center");
    expect(nav).toContain("color:var(--ink)");
    expect(link).toContain("color:inherit");
    expect(link).toContain("text-decoration:none");
    expect(link).toContain("min-height:44px");
    expect(link).not.toContain("background:");
    expect(label).toContain("padding:var(--tag-padding)");
    expect(css).toContain("--tag-padding:1px 3px");
    expect(selected).toBe("background:var(--paper-2)");
    expect(css).toContain(".gallery-tabs a:focus-visible{outline:2px solid var(--blue);outline-offset:3px}");
  });

  it("shows the same public-handle fixtures and detail links in both tabs without claiming real participation", async () => {
    await closeServer();
    await boot(true, true, true, {}, true);
    const galleries: string[] = [];
    for (const [tab, aliceCount] of [["claimed", 3], ["minted", 1]] as const) {
      const expectedCount = GALLERY_DEVELOPMENT_FIXTURES.length + aliceCount;
      const pages: string[] = [];
      const seen: string[] = [];
      let path: string | undefined = `/?tab=${tab}`;
      for (let page = 0; path && page <= Math.ceil(expectedCount / 24); page++) {
        const response: Response = await fetch(`${baseUrl}${path}`);
        expect(response.status).toBe(200);
        const html: string = await response.text();
        const ids = [...html.matchAll(/class="gallery-card" href="\/signatures\/([^"]+)"/g)].map(match => match[1]);
        expect(ids).toHaveLength(Math.min(24, expectedCount - seen.length));
        seen.push(...ids);
        pages.push(html);
        expect(html).toContain('name="robots" content="noindex"');
        expect(html).toContain("No participation or endorsement is implied.");
        expect(html.match(/class="rehearsal-watermark"/g)).toHaveLength(1);
        expect(html).not.toContain('>Fictional demo</small>');
        expect(html).not.toContain("Claimed via X</small>");
        // Changing tabs starts at that gallery's first page, not the current cursor.
        expect(html).toContain('href="/?tab=claimed"');
        expect(html).toContain('href="/?tab=minted"');
        path = html.match(/class="gallery-more" rel="next" href="([^"]+)"/)?.[1].replaceAll("&amp;", "&");
        if (path) expect(path).toContain(`/?tab=${tab}&after=`);
      }
      expect(path).toBeUndefined();
      expect(pages).toHaveLength(Math.ceil(expectedCount / 24));
      expect(seen).toHaveLength(expectedCount);
      expect(new Set(seen).size).toBe(expectedCount);
      galleries.push(pages.join("\n"));
    }
    const claims = await store.listClaimedSignatures(GALLERY_DEVELOPMENT_FIXTURES.length + 3);
    for (const fixture of GALLERY_DEVELOPMENT_FIXTURES) {
      const signature = claims.find(({ handleAtClaim }) => handleAtClaim === fixture.handle)!;
      expect(signature).toBeDefined();
      for (const html of galleries) {
        expect(html).toContain(`<strong>${xProfileLink(fixture.handle)}</strong>`);
        expect(html).toContain(`class="gallery-card" href="/signatures/${signature.signatureId}"`);
        expect(html).toContain(`alt="Signature claimed as @${fixture.handle}"`);
      }
    }
    const sample = claims.find(({ handleNormalized }) => handleNormalized === "beeple")!;
    const detail = await (await fetch(`${baseUrl}/signatures/${sample.signatureId}`)).text();
    expect(detail).toContain("The handle is used for demonstration only; no participation or endorsement is implied.");
    expect(detail).toContain("Development claim fixture");
  }, 15_000); // Render the full 90-work SVG/PNG catalog, including under parallel-suite load.

  it("paginates all claims in stable order while filling pages past suppressed records", async () => {
    await closeServer();
    await boot(true, true);
    const template = (await store.listClaimedSignatures(1))[0];
    for (let i = 1; i <= 60; i++) {
      await store.claim({ ...template, xUserId: "99988", handleAtClaim: "pagination", handleNormalized: "pagination", gr0kRaw: i, claimedAt: new Date("2026-09-06T00:00:00.000Z") });
    }
    const ordered = await store.listClaimedSignatures(100);
    for (const signature of ordered.slice(0, 26)) mint!.state.suppress(signature.signatureId);
    const expected = ordered.slice(26).map(s => s.signatureId);
    const seen: string[] = [];
    let path: string | undefined = "/?tab=claimed";
    let cursor: string | null = null;
    for (let page = 0; path && page < 4; page++) {
      const response: Response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
      const html: string = await response.text();
      const ids = [...html.matchAll(/class="gallery-card" href="\/signatures\/([^"]+)"/g)].map(match => match[1]);
      expect(ids.length).toBe(page === 0 ? 24 : expected.length - 24);
      seen.push(...ids);
      path = html.match(/class="gallery-more" rel="next" href="([^"]+)"/)?.[1].replaceAll("&amp;", "&");
      if (path) {
        expect(path).toContain("/?tab=claimed&after=");
        cursor = new URL(path, baseUrl).searchParams.get("after");
      }
    }
    expect(path).toBeUndefined();
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
    // A cursor from Claimed is never interpreted as a mint-chain cursor.
    expect((await fetch(`${baseUrl}/?tab=minted&after=${cursor}`)).status).toBe(400);
  });

  it.each(["other", "CLAIMED", "", "claimed&tab=minted"])("rejects an invalid gallery selection: %s", async (tab) => {
    const response = await fetch(`${baseUrl}/?tab=${tab}`, { headers: { Accept: "application/json" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_GALLERY_TAB" } });
  });

  it.each(["!", Buffer.from(JSON.stringify(["claimed", "invalid-date", `sg1_${"a".repeat(52)}`])).toString("base64url"), Buffer.from(JSON.stringify(["1", 0, 0, `sg1_${"a".repeat(52)}`])).toString("base64url")])("rejects malformed or wrong-tab claim cursors: %s", async (cursor) => {
    const response = await fetch(`${baseUrl}/?tab=claimed&after=${cursor}`, { headers: { Accept: "application/json" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_GALLERY_CURSOR" } });
  });

  it("preloads the self-hosted font on shared pages and the standalone design study", async () => {
    for (const path of ["/", "/about", "/s/alice/37", "/me", "/dev/slogan-study", "/not-a-page"]) {
      const response = await fetch(`${baseUrl}${path}`);
      const html = await response.text();
      expect(html).toContain(SITE_FONT_PRELOAD);
      expect(html).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/);
      expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    }
  });

  // One exact byte comparison per case: under coverage/parallel load, all 16
  // subsets and their GET/HEAD responses must not share one five-second budget.
  it.each(SELF_HOSTED_FONT_ASSET_PATHS)("serves exact GET/HEAD font asset with immutable caching: %s", async path => {
    const asset = siteFontAsset(path)!;
    const get = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(2_000) });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe(asset.contentType);
    expect(get.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await get.arrayBuffer())).toEqual(asset.bytes);
    const head = await fetch(`${baseUrl}${path}`, { method: "HEAD", signal: AbortSignal.timeout(2_000) });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(asset.contentType);
    expect(head.headers.get("cache-control")).toBe(get.headers.get("cache-control"));
    expect(await head.text()).toBe("");
  });

  it("does not turn the font route into a general package-file server or write endpoint", async () => {
    const path = SITE_FONT_PRELOAD.match(/href="([^"]+)"/)![1];
    expect((await fetch(`${baseUrl}${path.replace(/[^/]+$/, "package.json")}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}${path}`, { method: "POST" })).status).toBe(404);
  });

  it("loads the versioned native X progress enhancement and serves it read-only", async () => {
    const page = await (await fetch(`${baseUrl}/me`)).text();
    const path = page.match(/src="(\/assets\/x-action-progress\.js\?v=[a-f0-9]{16})" defer/)?.[1];
    expect(path).toBeDefined();
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toContain("Opening X to confirm your identity…");
    const head = await fetch(`${baseUrl}${path}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await fetch(`${baseUrl}/assets/x-action-progress.js`, { method: "POST" })).status).toBe(404);
  });

  it("offers sign-in for an expired app session without substituting ordinary login for action confirmation", () => {
    const html = errorPage(401, "AUTH_REQUIRED", "Your sign-in session expired. Sign in with X to continue.");
    expect(html).toContain('action="/auth/x/start"');
    expect(html).toContain('name="purpose" value="account_login"');
    expect(html).toContain("Sign in with X");
    expect(html).not.toContain("Reauthenticate with X");
    const actionError = errorPage(401, "X_ACTION_CONFIRMATION_REQUIRED", "Confirm this action with X to continue.");
    expect(actionError).not.toContain('name="purpose" value="account_login"');
  });

  it("follows the system theme with no site header or empty header strip", async () => {
    const page = await fetch(`${baseUrl}/`);
    const html = await page.text();
    expect(html).not.toContain("Agent Art</a> · Project 01");
    expect(html).toContain('<div class="intro-panel"><div class="slogan-lockup">');
    expect(html).toContain('<h1 id="slogan-heading" class="visually-hidden">What_shape_do_you_go_by?</h1>');
    expect(html).not.toContain("What_shape_is_your_name?");
    expect(html).not.toContain('class="hero-slogan"');
    expect(html).toContain('class="slogan-signature"');
    expect(html).toContain('data-slogan-signature-version="sg-slogan-composition-8.0.0"');
    expect(html).toContain('data-shape-lock-schema="signature-shape-lock/1"');
    expect(html).toContain('data-source-renderer="sg-renderer-1.0.0"');
    expect(html).toContain('data-source-gr0k="22"');
    expect(html).toContain('class="slogan-signature-layout slogan-signature-desktop"');
    expect(html).toContain('class="slogan-signature-layout slogan-signature-mobile"');
    const slogan = html.match(/<figure class="slogan-signature"[\s\S]*?<\/figure>/)![0];
    expect(slogan.match(/<path\b/g)).toHaveLength(4);
    expect(slogan.match(/<circle\b/g)).toHaveLength(2);
    expect(html.match(/<g\b[^>]*class="slogan-signature-punctuation"[^>]*>/g)).toHaveLength(2);
    expect(html.match(/transform="translate\(565\.8571428571429 169\)"/g)).toHaveLength(2);
    expect(html).not.toMatch(/<text\b/);
    expect(html.match(/<g transform="translate\([^)]*\) scale\(1\)">/g)).toHaveLength(2);
    expect(html).not.toContain("matrix(");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('href="https://x.com/AgentArt_AA"');
    expect(html).not.toContain("data-theme-value");
    expect(html).not.toContain("Color theme");
    expect(html).not.toContain('<script src="/assets/theme.js"></script>');
    expect(html).not.toContain('<a href="/">Gallery</a>');
    expect(html).toContain('</head><body class="book-page"><main>');
    expect(html).not.toContain("<header");
    expect(html).not.toContain('class="wordmark"');
    expect(html).not.toContain('class="header-actions"');
    expect(html).not.toContain('<a href="/me">My collection</a>');
    expectCollectionShortcut(html);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await fetch(`${baseUrl}/assets/theme.js`)).status).toBe(404);

    const css = await fetch(`${baseUrl}/assets/site.css`);
    const stylesheet = await css.text();
    expect(stylesheet).toContain("prefers-color-scheme:dark");
    expect(stylesheet).not.toContain("data-theme");
  });

  it("makes the collection shortcut a small contrasting dot with an accessible hit target", async () => {
    const stylesheet = await (await fetch(`${baseUrl}/assets/site.css`)).text();
    const lightPalette = stylesheet.match(/:root\{([^}]*)\}/)?.[1];
    const darkPalette = stylesheet.match(/@media\(prefers-color-scheme:dark\)\{:root\{([^}]*)\}/)?.[1];
    expect(lightPalette).toContain("--collection-dot:#000;");
    expect(darkPalette).toContain("--collection-dot:#fff;");

    const shortcutRules = stylesheet.match(/\.collection-shortcut\{([^}]*)\}/)?.[1];
    expect(shortcutRules).toContain("position:absolute;");
    expect(shortcutRules).toContain("width:44px;");
    expect(shortcutRules).toContain("height:44px;");
    expect(shortcutRules).toContain("color:var(--collection-dot);");
    const dotRules = stylesheet.match(/\.collection-shortcut-dot\{([^}]*)\}/)?.[1];
    expect(dotRules).toContain("width:10px;");
    expect(dotRules).toContain("height:10px;");
    expect(dotRules).toContain("border-radius:50%;");
    expect(dotRules).toMatch(/(?:^|;)background:currentColor(?:;|$)/);
    expect(stylesheet).toMatch(/\.collection-shortcut:focus-visible\{[^}]*outline:/);
  });

  it("enhances the exact slogan tooltip with an I-beam cursor and preserves a native no-JS fallback", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const figure = html.match(/<figure\b[^>]*class="slogan-signature"[^>]*>[\s\S]*?<\/figure>/)?.[0];
    expect(figure).toBeDefined();
    expect(figure).toContain('tabindex="0"');
    expect(figure).toContain('role="img"');
    expect(figure).toContain('aria-labelledby="slogan-heading"');
    expect(figure).toContain('title="What_shape_do_you_go_by?"');
    expect(html).toContain('<h1 id="slogan-heading" class="visually-hidden">What_shape_do_you_go_by?</h1>');
    expect(html).not.toContain("What shape do you go by?");
    expect(figure).not.toContain("<figcaption");
    expect(html).toContain('<span id="slogan-tooltip" class="slogan-tooltip" role="tooltip" aria-hidden="true" hidden>What_shape_do_you_go_by?</span>');
    expect(html).toContain('<script src="/assets/slogan-tooltip.js" defer></script>');
    expect(html).not.toContain("What_<wbr>");

    const stylesheet = await (await fetch(`${baseUrl}/assets/site.css`)).text();
    expect(stylesheet).toMatch(/\.visually-hidden\{[^}]*position:absolute/);
    expect(stylesheet).toMatch(/\.slogan-signature\{[^}]*cursor:text/);
    expect(stylesheet).toMatch(/\.slogan-signature\{[^}]*color:var\(--ink\)/);
    expect(stylesheet).not.toMatch(/\.slogan-signature\{[^}]*color:var\(--blue\)/);
    expect(stylesheet).toMatch(/\.slogan-signature:focus-visible\{[^}]*outline:/);
    expect(stylesheet).toContain('.slogan-signature[data-tooltip-ready="true"]{cursor:default}');
    expect(stylesheet).toContain('.slogan-signature[data-tooltip-ready="true"][data-tooltip-hover="true"]{cursor:text}');
    expect(stylesheet).toMatch(/\.slogan-tooltip,\.action-tooltip\{[^}]*position:fixed/);
    expect(stylesheet).toContain(".slogan-tooltip[hidden],.action-tooltip[hidden]{display:none}");
    expect(stylesheet).not.toMatch(/\.slogan-signature\{[^}]*cursor:help/);
  });

  it("serves the tooltip enhancement as a same-origin script for GET and HEAD", async () => {
    const response = await fetch(`${baseUrl}/assets/slogan-tooltip.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const script = await response.text();
    expect(script).toContain("setTimeout(show, 120)");
    expect(script).toContain('figure.removeAttribute("title")');
    const head = await fetch(`${baseUrl}/assets/slogan-tooltip.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const preview = await (await fetch(`${baseUrl}/s/alice/37`)).text();
    expect(preview).not.toContain('src="/assets/slogan-tooltip.js"');
  });

  it("places the gallery directly after the slogan without introductory copy or instructions", async () => {
    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toMatch(/<\/figure><span id="slogan-tooltip"[^>]* hidden>[^<]+<\/span><\/div><\/div><aside class="gallery-shell">/);
    expect(html).not.toContain('class="gallery-index"');
    expect(html).not.toContain("GALLERY OF SIGNATURES");
    expect(html).not.toContain("REHEARSAL · SIMULATED");
    expect(html).not.toContain("ETHEREUM · FINALIZED");
    expect(html).toContain("No claimed signatures yet.");
    expect(html).not.toContain("Open the V2 mint rehearsal");
    expect(html).not.toContain('class="fixture-links"');
    for (const removed of [
      'class="work-thesis"',
      'class="lede"',
      'class="context-link"',
      'class="steps"',
      "Your handle becomes the line.",
      "Grok sets its gravity.",
      "handwriting-like signature",
      "What is Agent Art",
      "Copy the Grok instruction",
      'href="https://inshell.art/docs/agent-art"',
    ]) {
      expect(html).not.toContain(removed);
    }
  });

  it("stacks a centered slogan above a responsive three-column gallery independently of authentication", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    expect(html).toContain('class="home-grid"');
    expect(html).toMatch(/<\/figure><span id="slogan-tooltip"[^>]* hidden>[^<]+<\/span><\/div><\/div><aside class="gallery-shell">/);

    const stylesheet = await (await fetch(`${baseUrl}/assets/site.css`)).text();
    const homeRules = [...stylesheet.matchAll(/\.home-grid\{([^}]*)\}/g)];
    expect(homeRules).toHaveLength(1);
    expect(homeRules[0][1]).toContain("display:grid;");
    expect(homeRules[0][1]).toContain("grid-template-columns:minmax(0,1fr);");
    expect(homeRules[0][1]).toContain("grid-template-rows:auto 1fr;");
    expect(stylesheet).not.toContain(".home-grid,.auth-page");
    expect(stylesheet).not.toContain(".preview-grid");
    expect(stylesheet).toContain(".auth-sheet{width:100%;max-width:42rem;margin-inline:auto");

    const introRule = stylesheet.match(/\.intro-panel\{([^}]*)\}/)?.[1];
    expect(introRule).toContain("display:grid;");
    expect(introRule).toContain("place-items:center;");
    expect(introRule).not.toContain("border-bottom");
    expect(introRule).not.toContain("border-right");
    expect(stylesheet).toMatch(/\.slogan-lockup\{[^}]*width:100%;max-width:42rem/);

    const galleryRules = [...stylesheet.matchAll(/\.public-gallery-grid\{([^}]*)\}/g)];
    expect(galleryRules).toHaveLength(3);
    expect(galleryRules[0][1]).toContain("grid-template-columns:repeat(3,minmax(0,1fr));");
    expect(stylesheet).toMatch(/@media\(max-width:820px\)\{[^@]*?\.public-gallery-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);?\}/);
    expect(stylesheet).toMatch(/@media\(max-width:600px\)\{[^@]*?\.public-gallery-grid\{grid-template-columns:minmax\(0,1fr\);?\}/);
  });

  it("centers gallery and authentication surfaces in the shared 1024px page", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    expect(html).toContain('</head><body class="book-page"><main>');
    expectCollectionShortcut(html);

    const stylesheet = await (await fetch(`${baseUrl}/assets/site.css`)).text();
    const bookRules = stylesheet.match(/\.book-page\{([^}]*)\}/)?.[1];
    expect(bookRules).toContain("position:relative;");
    expect(bookRules).toContain("width:100%;");
    expect(bookRules).toContain("max-width:1024px;");
    expect(bookRules).toContain("margin-inline:auto;");
    expect(bookRules).toContain("--page-gutter:32px");
    expect(stylesheet).toMatch(/@media\(max-width:600px\)\{\.book-page\{--page-gutter:20px\}/);
    expect(stylesheet).toMatch(/\.intro-panel\{[^}]*padding:[^;}]*var\(--page-gutter,32px\)/);
    expect(stylesheet).toMatch(/\.gallery-shell\{[^}]*padding:[^;}]*var\(--page-gutter,32px\)/);
    expect(stylesheet).toMatch(/\.book-page footer\{[^}]*padding-inline:var\(--page-gutter\)/);
    expect(stylesheet.match(/(?:^|\})body\{([^}]*)\}/)?.[1]).not.toContain("max-width");

    for (const path of ["/s/alice/37", "/me", "/not-found"]) {
      const otherHtml = await (await fetch(`${baseUrl}${path}`)).text();
      expect(otherHtml).toContain('</head><body class="book-page"><main>');
      expect(otherHtml).toMatch(/class="auth-sheet(?: collection-sheet)?"/);
      expectCollectionShortcut(otherHtml);
    }
  });

  it("shares one system-themed page background between the slogan and gallery", async () => {
    const stylesheet = await (await fetch(`${baseUrl}/assets/site.css`)).text();
    const lightPalette = stylesheet.match(/:root\{([^}]*)\}/)?.[1];
    const darkPalette = stylesheet.match(/@media\(prefers-color-scheme:dark\)\{:root\{([^}]*)\}/)?.[1];
    expect(lightPalette).toContain("--paper:#f4f0e6;");
    expect(darkPalette).toContain("--paper:#101319;");
    expect(stylesheet).toMatch(/body\{[^}]*background:var\(--paper\)/);
    expect(stylesheet).not.toContain("--gallery-");

    for (const selector of ["intro-panel", "gallery-shell"]) {
      const rules = [...stylesheet.matchAll(new RegExp(`\\.${selector}\\{([^}]*)\\}`, "g"))];
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) expect(rule[1]).not.toMatch(/background(?:-color)?:/);
    }
    expect(stylesheet).toMatch(/\.gallery-shell\{[^}]*color:var\(--ink\)/);
    const cardRules = stylesheet.match(/\.gallery-card\{([^}]*)\}/)?.[1];
    expect(cardRules).toContain("color:var(--ink)");
    expect(cardRules).not.toMatch(/border(?:-top)?:/);
    // The private collection shares the same unframed artwork treatment.
    expect(stylesheet.match(/\.signature-card\{([^}]*)\}/)?.[1]).not.toMatch(/border(?:-top)?:/);
    expect(stylesheet).not.toContain(".gallery-index");
    expect(stylesheet).toMatch(/\.collection-empty\{[^}]*color:var\(--muted\)/);
    expect(stylesheet).toMatch(/\.gallery-card-copy small\{[^}]*color:var\(--muted\)/);

    // Artwork keeps its own paper; only the surrounding page surface is shared.
    expect(lightPalette).toContain("--art-paper:#f4e7c7;");
    expect(darkPalette).toContain("--art-paper:#f4e7c7;");
    expect(stylesheet).toMatch(/\.gallery-card img\{[^}]*background:var\(--art-paper\)/);
  });

  it("removes the @ prefix without lowercasing artwork or creating a signature", async () => {
    const response = await fetch(`${baseUrl}/s/%40Alice/50`, { redirect: "manual" });
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/s/Alice/50");
    expect(await store.listSignaturesForAccount("1234567890123456789")).toEqual([]);
  });

  it("renders canonical previews and card metadata without persistence", async () => {
    const response = await fetch(`${baseUrl}/s/alice/37`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<span class="signature-tag">Unclaimed</span>');
    expect(html).toContain("sg-renderer-1.0.0");
    expect(html).toContain("twitter:card");
    expect(await store.listSignaturesForAccount("1234567890123456789")).toEqual([]);
  });

  it("supports side-effect-free HEAD and immutable render assets", async () => {
    const head = await fetch(`${baseUrl}/s/alice/37`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const svg = await fetch(`${baseUrl}/renders/${RENDERER_VERSION}/alice/37.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("cache-control")).toContain("immutable");
    expect(await svg.text()).toContain("<svg");
    expect(await store.listSignaturesForAccount("1234567890123456789")).toEqual([]);
  });

  it("rejects obsolete decimals, invalid seeds and encoded slash handles", async () => {
    for (const seed of ["0.371924", "0", "101", "01", "22.0", "22%0A"]) {
      expect((await fetch(`${baseUrl}/s/alice/${seed}`)).status).toBe(400);
    }
    expect((await fetch(`${baseUrl}/s/alice/1e-3`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/s/alice%2Fbob/50`)).status).toBe(400);
  });

  it("serves case-distinct formal previews without aliases to the retired renderer", async () => {
    const upper = await fetch(`${baseUrl}/renders/${RENDERER_VERSION}/Alice/22.svg`, { redirect: "manual" });
    const lower = await fetch(`${baseUrl}/renders/${RENDERER_VERSION}/alice/22.svg`, { redirect: "manual" });
    expect(upper.status).toBe(200);
    expect(lower.status).toBe(200);
    const upperSvg = await upper.text();
    const lowerSvg = await lower.text();
    expect(upperSvg).not.toBe(lowerSvg);
    expect(upperSvg).toContain(">@Alice</text>");
    expect(lowerSvg).toContain(">@alice</text>");
    expect(upperSvg).toContain('width="1080" height="1080"');
    expect((await fetch(`${baseUrl}/renders/sg-renderer-dev-fixture/alice/22.svg`)).status).toBe(410);
    expect((await fetch(`${baseUrl}/renders/sg-renderer-dev-fixture/alice/0.371924.png`)).status).toBe(410);
    expect(await store.listClaimedSignatures(100)).toEqual([]);
  });

  it("retires the legacy routes with 410", async () => {
    expect((await fetch(`${baseUrl}/s/alice/hfwo/123`)).status).toBe(410);
    expect((await fetch(`${baseUrl}/c/alice`)).status).toBe(410);
    expect((await fetch(`${baseUrl}/v/1`)).status).toBe(410);
  });
});

describe("fixture account and claim flow", () => {
  it("serves About the work publicly with side-effect-free GET/HEAD and no write route", async () => {
    const before = await store.listClaimedSignatures(100);
    const response = await fetch(`${baseUrl}/about`);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('<h1 id="about-heading">About the work</h1>');
    expect(html).toContain('class="footer-about" href="/about" aria-current="page"');
    expect(html).toContain('name="robots" content="noindex"');
    const head = await fetch(`${baseUrl}/about`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("set-cookie")).toBeNull();
    expect((await fetch(`${baseUrl}/about`, { method: "POST" })).status).toBe(404);
    expect(await store.listClaimedSignatures(100)).toEqual(before);
  });

  it("loads X-only anonymous account controls privately without creating a session or wallet setup", async () => {
    const response = await fetch(`${baseUrl}/api/v1/account-panel`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("set-cookie")).toBeNull();
    const { html, developmentHtml } = await response.json();
    expect(developmentHtml).toContain('data-dev-x-auth="emulator"');
    expect(developmentHtml).not.toMatch(/<button|data-link-wallet|name="csrf"/);
    expect(html).toContain('aria-label="X account"');
    expect(html).not.toContain('aria-label="Wallet"');
    expect(html).toContain('name="purpose" value="account_login"');
    expect(html).toContain("Sign in with X");
    expect(html).not.toContain("Confirm your X account, then prove wallet ownership.");
    expect(html).not.toMatch(/Link wallet|Replace wallet|Revoke wallet|Connect wallet|data-link-wallet|data-revoke-wallet/);
    expect(html).not.toContain("data-csrf");
  });

  it("isolates X-only account identity and CSRF from other sessions and public HTML", async () => {
    await closeServer();
    await boot(true, true);
    const alice = await localLogin("alice");
    const bob = await localLogin("bob");
    const aliceSession = auth.getSession(alice.cookie.split("=")[1])!;
    const alicePanel = await (await fetch(`${baseUrl}/api/v1/account-panel`, { headers: { Cookie: alice.cookie } })).json();
    const bobPanel = await (await fetch(`${baseUrl}/api/v1/account-panel`, { headers: { Cookie: bob.cookie } })).json();
    expect(alicePanel.html).toContain("@alice");
    expect(alicePanel.html).toContain(aliceSession.csrfToken);
    expect(alicePanel.html).toContain('action="/auth/logout"');
    expect(alicePanel.html).not.toMatch(/aria-label="Wallet"|name="action"|data-link-wallet|data-revoke-wallet/);
    expect(bobPanel.html).toContain("@bob");
    expect(bobPanel.html).not.toContain("@alice");
    expect(bobPanel.html).not.toContain(aliceSession.csrfToken);
    expect(bobPanel.html).not.toContain("data-revoke-wallet");
    expect(alicePanel.developmentHtml).toContain('data-dev-x-auth="emulator"');
    expect(alicePanel.developmentHtml).not.toMatch(/<button|data-link-wallet|name="csrf"/);
    expect(bobPanel.html).toContain('action="/auth/logout"');
    expect(bobPanel.html).not.toMatch(/aria-label="Wallet"|name="action"|data-link-wallet|data-revoke-wallet/);
    const priorRecipient = mint!.state.getActiveBinding(aliceSession.identity!.xUserId, mint!.config.chainId)!;
    for (const html of [alicePanel.html, bobPanel.html]) expect(html).not.toContain(priorRecipient.address);
    expect(bobPanel.developmentHtml).not.toContain('data-wallet-provider="fixture"');
    expect(bobPanel.developmentHtml).not.toContain(aliceSession.csrfToken);
    expect(bobPanel.html).not.toContain('data-wallet-provider="fixture"');
    const publicHtml = await (await fetch(`${baseUrl}/`, { headers: { Cookie: alice.cookie } })).text();
    expect(publicHtml).not.toContain(aliceSession.csrfToken);
    expect(publicHtml).not.toContain("data-revoke-wallet");
    expect(publicHtml).toContain('class="account-panel"');
    expect(await (await fetch(`${baseUrl}/`)).text()).toBe(publicHtml);
  });

  it("keeps an older sign-in active without global recipient-management actions", async () => {
    await closeServer();
    await boot(true, true);
    const { cookie } = await localLogin();
    const session = auth.getSession(cookie.split("=")[1])!;
    const before = await (await fetch(`${baseUrl}/api/v1/account-panel`, { headers: { Cookie: cookie } })).json();
    session.identity!.authenticatedAt = new Date(Date.now() - 16 * 60_000);
    const { html, developmentHtml } = await (await fetch(`${baseUrl}/api/v1/account-panel`, { headers: { Cookie: cookie } })).json();
    expect(developmentHtml).toContain('data-dev-x-auth="emulator"');
    expect(developmentHtml).not.toMatch(/<button|data-link-wallet|name="csrf"/);
    expect(html).toBe(before.html);
    expect(html).toContain("@alice");
    expect(html).toContain('<span>Log out</span></button>');
    expect(html).not.toMatch(/Link wallet|Replace wallet|Revoke wallet|Connect wallet|Change recipient/);
    expect(html).not.toContain("Reauthenticate with X");
    expect(html).not.toContain("Refresh your X identity");
    expect(html).not.toContain('action="/auth/x/start"');
    expect(html).not.toContain("data-link-wallet");
    expect(html).not.toContain("data-revoke-wallet");
  });

  it("rejects cross-site account reads and serves side-effect-free HEAD and the panel script", async () => {
    const { cookie } = await localLogin();
    const crossSiteHeaders: Record<string, string>[] = [{ Origin: "https://foreign.example" }, { "Sec-Fetch-Site": "cross-site" }];
    for (const headers of crossSiteHeaders) {
      const response = await fetch(`${baseUrl}/api/v1/account-panel`, { headers: { Cookie: cookie, ...headers } });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("data-csrf");
    }
    const head = await fetch(`${baseUrl}/api/v1/account-panel`, { method: "HEAD", headers: { Cookie: cookie } });
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe("private, no-store");
    expect(await head.text()).toBe("");
    expect((await fetch(`${baseUrl}/api/v1/account-panel`, { method: "POST" })).status).toBe(404);
    const script = await fetch(`${baseUrl}/assets/account-panel.js`);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await script.text()).toContain('cache:"no-store"');
  });

  it("shows seeded fixture signatures only after fixture login", async () => {
    await closeServer();
    await boot(true);
    expect((await fetch(`${baseUrl}/me`)).status).toBe(401);
    const { cookie } = await localLogin();
    const collection = await fetch(`${baseUrl}/me`, { headers: { Cookie: cookie } });
    expect(collection.status).toBe(200);
    const html = await collection.text();
    expect(html).toContain("Private account collection");
    expect((html.match(/class="signature-card"/g) ?? [])).toHaveLength(3);
  });

  it("guides the newcomer through sign-in-and-claim, completing on the OAuth return", async () => {
    const { cookie } = await localLogin("newcomer");
    const collection = await fetch(`${baseUrl}/me`, { headers: { Cookie: cookie } });
    const empty = await collection.text();
    expect(collection.headers.get("cache-control")).toBe("no-store");
    expect(empty).toContain("No claimed signatures yet.");
    expect(empty).toContain(`${baseUrl}/s/newcomer/GR0K`);
    expect(empty).toContain("data-grok-handoff");
    expect(empty).not.toContain('class="collection-card"');
    expect(await store.listSignaturesForAccount("5550000000000000001")).toHaveLength(0);
    const preview = await (await fetch(`${baseUrl}/s/newcomer/37`)).text();
    const form = preview.match(/<form[^>]*action="\/auth\/x\/start"[^>]*>[\s\S]*?<\/form>/)![0];
    const fields = new URLSearchParams([...form.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1], m[2]]));
    expect(fields.get("claim_intent")).toBe("claim-on-return-v1");
    const started = await beginLocalOAuth(fields, cookie);
    const callback = await finishLocalOAuth(await decideLocalOAuth(started, "approve", "newcomer"));
    const rotatedCookie = responseCookie(callback);
    const review = await (await fetch(baseUrl + callback.headers.get("location")!, { headers: { Cookie: rotatedCookie } })).text();
    expect(callback.headers.get("location")).toMatch(/^\/signatures\/sg1_[a-z2-7]{52}$/);
    expect(review).toContain('data-signature-status="claimed"');
    expect(review).not.toContain('action="/api/v1/signatures"');
    const claimed = await (await fetch(`${baseUrl}/me`, { headers: { Cookie: rotatedCookie } })).text();
    expect(await store.listSignaturesForAccount("5550000000000000001")).toHaveLength(1);
    expect(claimed).toContain('class="collection-card"');
    expect(claimed).not.toContain("data-grok-handoff");
    expect(claimed).not.toContain("/assets/grok-prompt.js");
  });

  it("shows an unmistakable local provider consent step without contacting X", async () => {
    const started = await beginLocalOAuth(new URLSearchParams({ purpose: "claim", handle: "alice", gr0k: "50" }));
    const consent = await fetch(`${baseUrl}${started.authorizationPath}`, { headers: { Cookie: started.cookie } });
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html.slice(html.indexOf('<aside class="rehearsal-watermark"'))).toContain("These accounts are simulated.");
    expect(html).toContain("does not open X, contact X, or prove control");
    expect(html).toContain("@alice");
    expect(html).toContain("@bob");
    expect(html).toContain("Simulate account denial");
    expect(started.authorizationPath).not.toContain("state");
    expect(started.authorizationPath).not.toContain("code_challenge");
  });

  it("omits the shared header across durable HTML surfaces while retaining local disclosures and noindex", async () => {
    await closeServer();
    await boot(true, false, false, { localChainRehearsal: true });
    const assertHeaderless = async (response: Response, disclosure?: string, bookPage = false) => {
      const html = await response.text();
      expect(html).toContain(bookPage ? '</head><body class="book-page"><main>' : "</head><body><main>");
      expect(html).not.toContain("<header");
      expect(html).not.toContain('class="wordmark"');
      expect(html).not.toContain('class="header-actions"');
      expectCollectionShortcut(html);
      expect(html).not.toContain("environment-notice");
      expect(html).not.toContain("data-fixture-environment");
      expect(html).not.toContain('class="fixture-banner"');
      expect(html).toContain('<meta name="robots" content="noindex">');
      expect(html).toContain('<div class="footer-credit">by <a class="footer-agent" href="https://x.com/AgentArt_AA" target="_blank" rel="noopener noreferrer" aria-label="Agent Art on X (opens in a new tab)"><svg class="footer-x-icon"');
      expect(html).toContain('class="footer-x-icon"');
      expect(html).toContain('class="footer-about" href="/about"');
      if (disclosure) expect(html).toContain(disclosure);
    };

    const home = await fetch(`${baseUrl}/`);
    const homeHtml = await home.clone().text();
    expect(homeHtml).not.toContain('class="gallery-index"');
    expect(homeHtml).not.toContain("REHEARSAL · ANVIL 31337");
    await assertHeaderless(home, "Repo-local Anvil chain, not Ethereum mainnet or Sepolia.", true);
    await assertHeaderless(await fetch(`${baseUrl}/s/alice/37`), "does not contact X or prove control of an X account.", true);
    await assertHeaderless(await fetch(`${baseUrl}/me`), "Local rehearsal. No X account was authenticated.", true);
    await assertHeaderless(await fetch(`${baseUrl}/not-found`), undefined, true);
    await assertHeaderless(await fetch(`${baseUrl}/c/retired`), undefined, true);

    const started = await beginLocalOAuth(new URLSearchParams({ purpose: "claim", handle: "alice", gr0k: "50" }));
    await assertHeaderless(await fetch(`${baseUrl}${started.authorizationPath}`, { headers: { Cookie: started.cookie } }), "does not open X, contact X, or prove control", true);
    const callback = await finishLocalOAuth(await decideLocalOAuth(started));
    const cookie = responseCookie(callback);
    await assertHeaderless(await fetch(`${baseUrl}${callback.headers.get("location")!}`, { headers: { Cookie: cookie } }), "No request was sent to X", true);
    await assertHeaderless(await fetch(`${baseUrl}/me`, { headers: { Cookie: cookie } }), "No X account was authenticated.", true);
    const seeded = (await store.listSignaturesForAccount("1234567890123456789"))[0]!;
    await assertHeaderless(await fetch(`${baseUrl}/signatures/${seeded.signatureId}`), "This is not a production gallery record.", true);
  });

  it("keeps legacy forms non-claiming at OAuth callback until final POST", async () => {
    await fetch(`${baseUrl}/s/alice/50`);
    const signedIn = await localLogin();
    expect(await (await fetch(`${baseUrl}/`, { headers: { Cookie: signedIn.cookie } })).text()).not.toContain('class="gallery-card"');
    const started = await beginLocalOAuth(new URLSearchParams({ purpose: "claim", handle: "alice", gr0k: "50" }));
    const callback = await finishLocalOAuth(await decideLocalOAuth(started));
    expect(callback.status).toBe(303);
    const cookie = responseCookie(callback);
    const reviewPath = callback.headers.get("location")!;
    expect(await store.listSignaturesForAccount("1234567890123456789")).toHaveLength(0);
    const review = await fetch(`${baseUrl}${reviewPath}`, { headers: { Cookie: cookie } });
    expect(review.status).toBe(200);
    const html = await review.text();
    expect(html.slice(html.indexOf('<aside class="rehearsal-watermark"'))).toContain("Claim review rehearsal");
    expect(html).toContain("No request was sent to X");
    expect(html).toContain("your collection and the public gallery");
    const flow = html.match(/name="flow" value="([^"]+)"/)![1];
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
    expect(await store.listSignaturesForAccount("1234567890123456789")).toHaveLength(0);
    expect(await (await fetch(`${baseUrl}/?tab=claimed`)).text()).not.toContain('class="gallery-card"');
    const claim = await post("/api/v1/signatures", new URLSearchParams({ flow, csrf }), cookie);
    expect(claim.status).toBe(303);
    const signatures = await store.listSignaturesForAccount("1234567890123456789");
    expect(signatures).toHaveLength(1);
    expect(claim.headers.get("location")).toBe(`/signatures/${signatures[0].signatureId}`);
    expect(new URL(reviewPath, baseUrl).pathname).toBe("/s/alice/50");
    const completed = await (await fetch(`${baseUrl}${reviewPath}`, { headers: { Cookie: cookie } })).text();
    expect(completed).toContain('data-signature-status="claimed"');
    expect(completed).toContain(`/signatures/${signatures[0].signatureId}`);
    expect(await (await fetch(`${baseUrl}/?tab=claimed`)).text()).toContain(`class="gallery-card" href="/signatures/${signatures[0].signatureId}"`);
    expect(await (await fetch(`${baseUrl}/?tab=minted`)).text()).not.toContain('class="gallery-card"');
  });

  it("rotates the browser session and rejects callback replay", async () => {
    const started = await beginLocalOAuth(new URLSearchParams({ purpose: "account_login" }));
    const decided = await decideLocalOAuth(started);
    const callback = await finishLocalOAuth(decided);
    expect(callback.status).toBe(303);
    const rotatedCookie = responseCookie(callback);
    expect(rotatedCookie).not.toBe(started.cookie);
    expect((await fetch(`${baseUrl}/me`, { headers: { Cookie: started.cookie } })).status).toBe(401);
    const replay = await fetch(`${baseUrl}${decided.callbackPath}`, { redirect: "manual", headers: { Cookie: rotatedCookie } });
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("INVALID_OAUTH_STATE");
  });

  it("handles local denial and provider failure as terminal non-X outcomes", async () => {
    const deniedStart = await beginLocalOAuth(new URLSearchParams({ purpose: "account_login" }));
    const deniedDecision = await decideLocalOAuth(deniedStart, "deny");
    const denied = await finishLocalOAuth(deniedDecision);
    expect(denied.status).toBe(403);
    const deniedHtml = await denied.text();
    expect(deniedHtml).toContain("LOCAL_OAUTH_DENIED");
    expect(deniedHtml).toContain("No X authentication occurred");
    const denialReplay = await finishLocalOAuth(deniedDecision);
    expect(denialReplay.status).toBe(400);

    const errorStart = await beginLocalOAuth(new URLSearchParams({ purpose: "account_login" }));
    const providerError = await finishLocalOAuth(await decideLocalOAuth(errorStart, "provider_error"));
    expect(providerError.status).toBe(503);
    const providerHtml = await providerError.text();
    expect(providerHtml).toContain("LOCAL_OAUTH_UNAVAILABLE");
    expect(providerHtml).toContain("simulated an error");
  });

  it("rejects cross-origin consent submission without burning the local request", async () => {
    const started = await beginLocalOAuth(new URLSearchParams({ purpose: "account_login" }));
    const request = new URL(started.authorizationPath, baseUrl).searchParams.get("request")!;
    const forged = await fetch(`${baseUrl}/dev/oauth/x/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://attacker.invalid", "Sec-Fetch-Site": "cross-site" },
      body: new URLSearchParams({ request, decision: "approve", account: "alice" }),
    });
    expect(forged.status).toBe(403);
    const legitimate = await finishLocalOAuth(await decideLocalOAuth(started));
    expect(legitimate.status).toBe(303);
  });

  it("rejects cross-origin OAuth start before creating a browser session", async () => {
    const forged = await fetch(`${baseUrl}/auth/x/start`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://attacker.invalid", "Sec-Fetch-Site": "cross-site" },
      body: new URLSearchParams({ purpose: "account_login" }),
    });
    expect(forged.status).toBe(403);
    expect(forged.headers.get("location")).toBeNull();
    expect(forged.headers.get("set-cookie")).toBeNull();
  });

  it("enforces selected-account matching for a claim", async () => {
    const started = await beginLocalOAuth(new URLSearchParams({ purpose: "claim", handle: "alice", gr0k: "50" }));
    const callback = await finishLocalOAuth(await decideLocalOAuth(started, "approve", "bob"));
    expect(callback.status).toBe(403);
    const html = await callback.text();
    expect(html).toContain("HANDLE_MISMATCH");
    expect(html).toContain("Sign in with the X account matching @alice");
    expect(await store.listSignaturesForAccount("1234567890123456789")).toHaveLength(0);
  });

  it("does not expire claim review based on the age of the app identity", async () => {
    const started = await beginLocalOAuth(new URLSearchParams({ purpose: "claim", handle: "alice", gr0k: "50" }));
    const callback = await finishLocalOAuth(await decideLocalOAuth(started));
    const cookie = responseCookie(callback);
    const sessionId = cookie.slice(cookie.indexOf("=") + 1);
    const session = auth.getSession(sessionId)!;
    session.identity!.authenticatedAt = new Date(Date.now() - 16 * 60 * 1000);
    const review = await fetch(`${baseUrl}${callback.headers.get("location")!}`, { headers: { Cookie: cookie } });
    expect(review.status).toBe(200);
    const html = await review.text();
    expect(html).not.toContain("Your sign-in session expired.");
    expect(html).toContain('data-claim-state="confirm"');
    expect(html).toContain('action="/api/v1/signatures"');
    expect(html).not.toContain("Refresh local rehearsal identity");
  });

  it("distinguishes an actually expired app session from an older X sign-in", async () => {
    const started = await beginLocalOAuth(new URLSearchParams({ purpose: "claim", handle: "alice", gr0k: "50" }));
    const callback = await finishLocalOAuth(await decideLocalOAuth(started));
    const cookie = responseCookie(callback);
    const session = auth.getSession(cookie.split("=")[1])!;
    session.lastSeenAt = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    const review = await fetch(`${baseUrl}/claim/review?flow=unused`, { headers: { Cookie: cookie } });
    expect(review.status).toBe(401);
    const html = await review.text();
    expect(html).toContain("AUTH_REQUIRED");
    expect(html).toContain("Sign in with X");
    expect(html).not.toContain('action="/api/v1/signatures"');
    expect(html).not.toContain("Reauthenticate with X");
  });

  it("uses the selected local account for account login", async () => {
    const { cookie } = await localLogin("bob");
    const collection = await fetch(`${baseUrl}/me`, { headers: { Cookie: cookie } });
    expect(collection.status).toBe(200);
    const html = await collection.text();
    expect(html).toContain("<h1>My Collection</h1>");
    expect(html).toContain(`<span class="auth-note">${xProfileLink("bob")}</span>`);
    expect(html).toContain("No X account was authenticated");
  });

  it("gives an explicitly configured real-X provider precedence over the local emulator", async () => {
    await closeServer();
    let issuedState = "";
    const configuredProvider: XOAuthClient = {
      providerKind: "x",
      getAuthorizeUrl(state, challenge) {
        issuedState = state;
        return `https://x.example.test/oauth?state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}`;
      },
      async exchangeCode(code) {
        expect(code).toBe("configured-provider-code");
        return "configured-provider-token";
      },
      async getUser(token) {
        expect(token).toBe("configured-provider-token");
        return { id: "1234567890123456789", username: "alice" };
      },
    };
    await boot(false, false, true, { oauthClient: configuredProvider });
    const signIn = await (await fetch(`${baseUrl}/me`)).text();
    expect(signIn).toContain("Sign in with X");
    expect(signIn).not.toContain("Use local OAuth emulator");
    const preview = await (await fetch(`${baseUrl}/s/alice/50`)).text();
    expect(preview).toContain("<span>Claim with X</span>");
    expect(preview).not.toContain("Rehearse local claim");
    const started = await post("/auth/x/start", new URLSearchParams({ purpose: "account_login" }));
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toContain("https://x.example.test/oauth");
    const cookie = responseCookie(started);
    const localRoute = await fetch(`${baseUrl}/dev/oauth/x/authorize?request=anything`);
    expect(localRoute.status).toBe(404);
    const callback = await fetch(`${baseUrl}/auth/x/callback?state=${encodeURIComponent(issuedState)}&code=configured-provider-code`, { redirect: "manual", headers: { Cookie: cookie } });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/me");
    const rotatedCookie = responseCookie(callback);
    const session = auth.getSession(rotatedCookie.slice(rotatedCookie.indexOf("=") + 1))!;
    session.identity!.authenticatedAt = new Date(Date.now() - 16 * 60 * 1000);
    const collection = await fetch(`${baseUrl}/me`, { headers: { Cookie: rotatedCookie } });
    expect(collection.status).toBe(200);
    expect(await collection.text()).not.toContain("Reauthenticate with X");
    const invalidFlow = await fetch(`${baseUrl}/claim/review?flow=unused`, { headers: { Cookie: rotatedCookie } });
    expect(invalidFlow.status).toBe(409);
    expect(await invalidFlow.text()).toContain("CLAIM_FLOW_INVALID");
  });

  it("serves a stable permalink and revalidates withdrawable claimed artifacts", async () => {
    await closeServer();
    await boot(true);
    const { cookie } = await localLogin();
    const signatures = await store.listSignaturesForAccount("1234567890123456789");
    const signature = signatures[0];
    const page = await fetch(`${baseUrl}/signatures/${signature.signatureId}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Development claim fixture");
    expect(html).toContain("not production X account provenance");
    expect(html).toContain("The SVG is the canonical artwork");
    expect(html).toContain("Social-image renderer");
    expect(html).toContain('</head><body class="book-page"><main>');
    expect(html).toContain('data-signature-status="claimed"');
    expect(html).not.toContain('data-signature-status="minted"');
    expect(html).toContain('<details class="signature-provenance"><summary>Provenance</summary>');
    expect(html).not.toContain('class="claim-panel"');
    expect(html).toContain(`property="og:image" content="${baseUrl}/artifacts/${signature.signatureId}.png"`);
    expect(html).toContain(`name="twitter:image" content="${baseUrl}/artifacts/${signature.signatureId}.png"`);
    const svg = await fetch(`${baseUrl}/artifacts/${signature.signatureId}.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("cache-control")).toBe("no-store");
    expect(cookie).toContain("sg_dev_session=");
  });

  it("keeps one detail URL and artwork for Claimed and Minted, adding the mint milestone only at finality", async () => {
    await closeServer();
    await boot(true, true);
    const signatures = await store.listSignaturesForAccount("1234567890123456789");
    const unminted = signatures[0];
    const included = signatures[1];
    const finalized = signatures[2];
    const claimedGallery = await (await fetch(`${baseUrl}/?tab=claimed`)).text();
    const mintedGallery = await (await fetch(`${baseUrl}/?tab=minted`)).text();
    const canonicalLink = `class="gallery-card" href="/signatures/${finalized.signatureId}"`;
    expect(claimedGallery).toContain(canonicalLink);
    expect(mintedGallery).toContain(canonicalLink);
    for (const signature of [unminted, included, finalized]) {
      const response = await fetch(`${baseUrl}/signatures/${signature.signatureId}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('<article class="signature-page" aria-labelledby="signature-heading">');
      expect(html).toContain('data-signature-status="claimed"');
      expect(html.includes('data-signature-status="minted"')).toBe(signature === finalized);
      expect(html).toContain(`src="/artifacts/${signature.signatureId}.svg"`);
      expect(html).toContain(`property="og:image" content="${baseUrl}/artifacts/${signature.signatureId}.png"`);
      expect(html).toContain('<details class="signature-provenance"><summary>Provenance</summary>');
      expectCollectionShortcut(html);
      if (signature === included) expect(html).toContain("Awaiting simulated finality");
    }
  });
});

describe("V2 minting rehearsal", () => {
  async function login() {
    const { cookie } = await localLogin();
    const collection = await fetch(`${baseUrl}/me`, { headers: { Cookie: cookie } });
    const html = await collection.text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
    return { cookie, csrf, html };
  }

  async function finishPendingFixtureMint() {
    const included = (await store.listSignaturesForAccount("1234567890123456789"))[1];
    expect(mint!.state.getProjection(included.signatureId).state).toBe("included_unfinalized");
    mint!.advanceFixture(included.signatureId, included.xUserId);
    expect(mint!.state.getProjection(included.signatureId).state).toBe("finalized");
  }

  async function proveRecipient(cookie: string, target: { signatureId: string; claimInstanceId: string }) {
    const nextCookie = cookie;
    const current = auth.getSession(nextCookie.split("=")[1])!;
    const proof = await postJson("/dev/v2/wallet-bindings/seed", {
      chainId: mint!.config.chainId.toString(), ...target,
      recipientConsent: true, previousBindingId: mint!.state.getActiveBinding(current.identity!.xUserId, mint!.config.chainId)?.walletBindingId ?? null,
    }, nextCookie, current.csrfToken);
    expect(proof.status).toBe(201);
    const binding = mint!.state.getActiveBinding(current.identity!.xUserId, mint!.config.chainId)!;
    expect(current.actionApproval).toBeUndefined();
    expect(current.mintRecipient).toMatchObject({ ...target, walletBindingId: binding.walletBindingId, address: binding.address });
    return { cookie: nextCookie, csrf: current.csrfToken, snapshot: { walletBindingId: binding.walletBindingId, recipient: binding.address } };
  }

  it("shows only finalized fixture mints in the Minted gallery", async () => {
    await closeServer();
    await boot(true, true);
    const home = await fetch(`${baseUrl}/?tab=minted`);
    const html = await home.text();
    expect(home.status).toBe(200);
    expect(html).not.toContain('class="gallery-index"');
    expect(html).not.toContain("GALLERY OF SIGNATURES");
    expect(html).not.toContain("REHEARSAL · SIMULATED");
    expect((html.match(/class="gallery-card"/g) ?? [])).toHaveLength(1);
    expect(html).toContain("Initial recipient ·");
    expect(html).toContain('class="rehearsal-watermark"');
    expect(html).not.toContain("Open the V2 mint rehearsal");
    expect(html).not.toContain("environment-notice");
    expect(html).toContain("Current holder ·");
  });

  it("rejects malformed Gallery keyset cursors without changing public state", async () => {
    await closeServer();
    await boot(true, true);
    const response = await fetch(`${baseUrl}/?tab=minted&after=not+a+cursor`, { headers: { Accept: "application/json" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_GALLERY_CURSOR",
        message: "The Gallery cursor is invalid or expired.",
      },
    });
    expect(mint!.state.listGallery()).toHaveLength(1);
  });

  it("shows the three mint states without global wallet setup in the claimant collection", async () => {
    await closeServer();
    await boot(true, true);
    const { html } = await login();
    expect(html).not.toContain("Wallet linked for minting");
    expect(html).not.toMatch(/Link wallet|Replace wallet|Revoke wallet|data-link-wallet/);
    expect(html).toContain("Not minted");
    expect(html).toContain('<span class="signature-tag">Confirming</span>');
    expect(html).toContain('<span class="signature-tag">Minted</span>');
    expect(html).toContain("Mint this signature");
    expect(html).toContain("Token ID");
    expect(html).toContain("Current holder ·");
    expect(html).toContain(`${FIXTURE_TRANSFER_HOLDER.slice(0, 7)}…${FIXTURE_TRANSFER_HOLDER.slice(-5)}`);
  });

  it("keeps finalized Gallery, status, and permalink reads available while issuance is paused", async () => {
    await closeServer();
    await boot(true, true, false);
    const finalized = (await store.listSignaturesForAccount("1234567890123456789"))[2];
    const home = await (await fetch(`${baseUrl}/`)).text();
    expect(home).toContain(finalized.signatureId);
    const status = await fetch(`${baseUrl}/api/v2/signatures/${finalized.signatureId}/mint-status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ state: "finalized" });
    const permalink = await fetch(`${baseUrl}/signatures/${finalized.signatureId}`);
    expect(permalink.status).toBe(200);
    expect(await permalink.text()).toContain("Simulated chain provenance");

    const { html } = await login();
    expect(html).toContain("Minting paused");
    expect(html).not.toContain("data-link-wallet");
  });

  it("renders exact mint review and requires explicit permanence acknowledgment", async () => {
    await closeServer();
    await boot(true, true);
    const signedIn = await login();
    const signatures = await store.listSignaturesForAccount("1234567890123456789");
    const unminted = signatures[0];
    await finishPendingFixtureMint();
    const { cookie, snapshot } = await proveRecipient(signedIn.cookie, unminted);
    const review = await fetch(`${baseUrl}/signatures/${unminted.signatureId}/mint`, { headers: { Cookie: cookie } });
    const html = await review.text();
    expect(review.status).toBe(200);
    expect(html).toContain("Authorize this exact work.");
    expect(html).toContain("Blockchain records cannot be deleted");
    expect(html).toContain("The token is transferable");
    expect(html).toContain("Grok origin is declared, not independently verified");
    expect(html).toContain("Metadata SHA-256");
    expect(html).toContain("data-metadata-sha256=");
    expect(html).toContain(`data-wallet-binding-id="${snapshot.walletBindingId}"`);
    expect(html).toContain(`data-wallet="${snapshot.recipient}"`);
    expect(html).toContain(`data-claim-instance-id="${unminted.claimInstanceId}"`);
    expect(html).toContain('name="permanence_acknowledged"');
    expect(html).not.toContain('name="permanence_acknowledged" value="yes" checked');
  });

  it("blocks a new recipient while an earlier mint is unresolved, then still requires a fresh exact proof", async () => {
    await closeServer();
    await boot(true, true);
    const { cookie } = await login();
    const target = (await store.listSignaturesForAccount("1234567890123456789"))[0];
    const blocked = await (await fetch(`${baseUrl}/signatures/${target.signatureId}/mint`, { headers: { Cookie: cookie } })).text();
    expect(blocked).toContain('data-mint-entry="pending"');
    expect(blocked).not.toContain('class="mint-authorization-form"');
    expect(blocked).not.toContain('data-link-wallet');
    await finishPendingFixtureMint();
    const entry = await (await fetch(`${baseUrl}/signatures/${target.signatureId}/mint`, { headers: { Cookie: cookie } })).text();
    expect(entry).toContain('data-mint-entry="wallet"');
    expect(entry).toContain('<span>Connect wallet</span>');
    expect(entry).not.toContain('name="action" value="mint_recipient"');
    expect(entry).toContain('data-link-wallet');
    expect(entry).toContain(`data-signature-id="${target.signatureId}"`);
    expect(entry).toContain(`data-claim-instance-id="${target.claimInstanceId}"`);
    expect(entry).not.toContain('class="mint-authorization-form"');
    expect(auth.getSession(cookie.split("=")[1])!.mintRecipient).toBeUndefined();
  });

  it("returns the specified V2 error contract and does not authorize without consent", async () => {
    await closeServer();
    await boot(true, true);
    const { cookie, csrf } = await login();
    const unminted = (await store.listSignaturesForAccount("1234567890123456789"))[0];
    const response = await postJson(
      `/api/v2/signatures/${unminted.signatureId}/mint-authorizations`,
      {},
      cookie,
      csrf,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "AUTHORIZATION_UNAVAILABLE",
        message: "Review and acknowledge the permanent publication notice before authorizing.",
      },
    });
    expect(mint!.state.getProjection(unminted.signatureId).state).toBe("unminted");
  });

  it("uses one suppression gate for issuance, Gallery, status, permalink, artifacts, and the private collection", async () => {
    await closeServer();
    await boot(true, true);
    const { cookie, csrf } = await login();
    const signatures = await store.listSignaturesForAccount("1234567890123456789");
    const unminted = signatures[0];
    const finalized = signatures[2];
    const binding = mint!.state.getActiveBinding(unminted.xUserId, mint!.config.chainId)!;
    mint!.state.suppress(unminted.signatureId);
    mint!.state.suppress(finalized.signatureId);

    const authorization = await postJson(
      `/api/v2/signatures/${unminted.signatureId}/mint-authorizations`,
      { walletBindingId: binding.walletBindingId, recipient: binding.address },
      cookie,
      csrf,
      { "X-Mint-Permanence-Acknowledged": "1" },
    );
    expect(authorization.status).toBe(409);
    expect(await authorization.json()).toMatchObject({ error: { code: "MINT_INELIGIBLE" } });

    for (const tab of ["claimed", "minted"]) {
      const home = await (await fetch(`${baseUrl}/?tab=${tab}`)).text();
      expect(home).not.toContain(finalized.signatureId);
      expect(home).not.toContain(unminted.signatureId);
    }
    const collection = await (await fetch(`${baseUrl}/me`, { headers: { Cookie: cookie } })).text();
    expect(collection).not.toContain(unminted.signatureId);
    expect(collection).not.toContain(finalized.signatureId);

    for (const path of [
      `/signatures/${finalized.signatureId}`,
      `/artifacts/${finalized.signatureId}.svg`,
      `/api/v2/signatures/${finalized.signatureId}/mint-status`,
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: "application/json" } });
      expect(response.status).toBe(410);
      const payload = await response.json() as { error: { code: string; message: string } };
      expect(payload).toEqual({ error: { code: "SIGNATURE_REMOVED", message: "This signature is no longer available from signatures.gallery." } });
      expect(JSON.stringify(payload)).not.toContain("alice");
    }
  });

  it("keeps a transaction hint non-authoritative and publishes only after finality", async () => {
    await closeServer();
    await boot(true, true);
    const signedIn = await login();
    const unminted = (await store.listSignaturesForAccount("1234567890123456789"))[0];
    await finishPendingFixtureMint();
    const { cookie, csrf, snapshot } = await proveRecipient(signedIn.cookie, unminted);
    const authorization = await postJson(
      `/api/v2/signatures/${unminted.signatureId}/mint-authorizations`,
      snapshot,
      cookie,
      csrf,
      { "X-Mint-Permanence-Acknowledged": "1" },
    );
    expect(authorization.status).toBe(201);
    const payload = await authorization.json() as { authorization: { authorizationId: string; deadline: string; validAfter: string }; fixture: boolean };
    expect(BigInt(payload.authorization.deadline) - BigInt(payload.authorization.validAfter)).toBe(900n);
    expect(payload.fixture).toBe(true);

    const hint = await postJson(
      `/api/v2/mint-authorizations/${payload.authorization.authorizationId}/transactions`,
      { txHash: `0x${"ac".repeat(32)}` },
      cookie,
      csrf,
    );
    expect(hint.status).toBe(201);
    const publicStatus = await (await fetch(`${baseUrl}/api/v2/signatures/${unminted.signatureId}/mint-status`)).json() as Record<string, unknown>;
    expect(publicStatus).toMatchObject({ state: "authorized", txHash: null, mintWallet: null });
    expect(publicStatus).not.toHaveProperty("authorization");
    expect(publicStatus).not.toHaveProperty("attempts");
    let status = await (await fetch(`${baseUrl}/api/v2/signatures/${unminted.signatureId}/mint-status`, { headers: { Cookie: cookie } })).json() as { state: string };
    expect(status.state).toBe("authorized");

    for (const expected of ["submitted", "included_unfinalized", "finalized"]) {
      const advanced = await postJson(`/dev/v2/signatures/${unminted.signatureId}/advance`, {}, cookie, csrf);
      expect(advanced.status).toBe(200);
      status = await advanced.json() as { state: string };
      expect(status.state).toBe(expected);
    }
    const home = await (await fetch(`${baseUrl}/?tab=minted`)).text();
    expect((home.match(/class="gallery-card"/g) ?? [])).toHaveLength(3);
    const permalink = await (await fetch(`${baseUrl}/signatures/${unminted.signatureId}`)).text();
    expect(permalink).toContain('<meta name="robots" content="noindex">');
    expect(permalink).toContain("Simulated chain provenance");
    expect(permalink).toContain("Initially minted to");
    expect(permalink).toContain("Current token holder");
  });
});

describe("public endpoint load shedding", () => {
  it("sheds artwork render requests past their per-minute budget", async () => {
    await boot();
    const path = `/renders/${encodeURIComponent(RENDERER_VERSION)}/alice/37.svg`;
    let shed: Response | null = null;
    for (let attempt = 0; attempt < 31 && !shed; attempt += 1) {
      const response = await fetch(`${baseUrl}${path}`);
      if (response.status === 429) shed = response;
      else await response.arrayBuffer();
    }
    expect(shed?.status).toBe(429);
    expect(shed!.headers.get("cache-control")).toBe("no-store");
    expect(await shed!.text()).toContain("Render capacity is temporarily full.");
  });

  it("sheds preview requests past their per-minute budget without caching the refusal", async () => {
    await boot(true);
    let shed: Response | null = null;
    for (let attempt = 0; attempt < 121 && !shed; attempt += 1) {
      const response = await fetch(`${baseUrl}/s/alice/37`);
      if (response.status === 429) shed = response;
      else await response.text();
    }
    expect(shed?.status).toBe(429);
    expect(shed!.headers.get("cache-control")).toBe("no-store");
    expect(await shed!.text()).toContain("Too many preview requests.");
  });

  it("sheds repeated sign-in starts before creating another OAuth request", async () => {
    await boot();
    let shed: Response | null = null;
    for (let attempt = 0; attempt < 11 && !shed; attempt += 1) {
      const response = await post("/auth/x/start", new URLSearchParams({ purpose: "account_login" }));
      if (response.status === 429) shed = response;
      else await response.text();
    }
    expect(shed?.status).toBe(429);
    expect(await shed!.text()).toContain("Too many");
  });

  it("keeps retired routes and renderers explicitly gone rather than missing", async () => {
    await boot();
    for (const path of ["/c/anything", "/v/legacy/37"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(410);
    }
    const retired = await fetch(`${baseUrl}/renders/sg-renderer-dev-fixture/alice/37.svg`);
    expect(retired.status).toBe(410);
    expect(await retired.text()).toContain("retired");
  });
});
