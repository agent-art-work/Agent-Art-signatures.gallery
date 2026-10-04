import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MBTI_TYPES, RENDERER_VERSION, renderSignatureSvg } from "../algorithmV2/index.js";
import * as algorithmV2 from "../algorithmV2/index.js";
import { FAVICON_URL } from "../brand/favicon.js";
import { AGENT_DOCUMENT_PATHS } from "../openMint/agentDocuments.js";
import { handlePreviewRequest, type PreviewWorkerEnv } from "./worker.js";
import { RENDERER_VERSION as LEGACY_RENDERER_METADATA } from "../v1/rendererVersion.js";

const STAGING = "https://staging.signatures.gallery";
const PRODUCTION = "https://signatures.gallery";

function environment(origin = STAGING) {
  const fetch = vi.fn(async (_request: Request) => new Response("static asset", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  }));
  return { PUBLIC_ORIGIN: origin, ASSETS: { fetch } } satisfies PreviewWorkerEnv;
}

async function request(path: string, env = environment(), init?: RequestInit) {
  return handlePreviewRequest(new Request(new URL(path, env.PUBLIC_ORIGIN), init), env);
}

const MINT_CAPABILITIES = /data-connect-wallet|data-wallet-controls|data-mint-process|data-mint-entry|data-assessment-request|data-request-submit|data-mint-recovery|data-durable-wallet-submission="true"|data-wallet-verified="true"/;

afterEach(() => vi.restoreAllMocks());

describe("hosted preview Worker", () => {
  it("keeps sharp-free legacy metadata equal to the immutable source-locked renderer", () => {
    const source = readFileSync(new URL("../v1/renderer.ts", import.meta.url), "utf8");
    const declaration = /export const RENDERER_VERSION = "([^"]+)";/.exec(source);
    expect(declaration?.[1]).toBe(LEGACY_RENDERER_METADATA);
  });
  it.each([STAGING, PRODUCTION])("serves the fixed prelaunch home at %s without chain access", async origin => {
    const env = environment(origin);
    const externalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request"));
    const response = await request("/", env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(html).toContain("Minting coming soon.");
    expect(html).toContain('href="/explore" data-home-mint-cta');
    expect(html).toContain("data-preview-wallet-notice");
    expect(html).not.toMatch(MINT_CAPABILITIES);
    expect(html).not.toMatch(/No signatures minted yet|Checking for minted signatures|RPC unavailable|Gallery updates could not be checked|deterministic fixture|Local Anvil|Ethereum Sepolia/);
    expect(html).toContain(`${origin}/p/&lt;handle&gt;/&lt;MBTI&gt;`);
    expect(externalFetch).not.toHaveBeenCalled();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each([STAGING, PRODUCTION])("prevents edge injection into %s HTML while requiring revalidation", async origin => {
    for (const path of ["/", "/explore?handle=bad-handle", "/p/Alice/variations"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await request(path, environment(origin), { method });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
        expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate, no-transform");
        expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
        expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
      }
    }
  });

  it.each([
    ["/health/ready", 200], ["/api/mint", 409], ["/agent-index.json", 200],
    ["/robots.txt", 200], ["/about?wallet=0x123", 400], ["/missing", 404],
  ] as const)("keeps non-HTML and error responses at %s uncacheable", async (path, status) => {
    for (const origin of [STAGING, PRODUCTION]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await request(path, environment(origin), { method });
        expect(response.status).toBe(status);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
    }
  });

  it.each(["/", "/about", "/explore", "/mint", "/me", "/INTJ/", "/p/Agent_Art/INTJ", "/p/Agent_Art/variations"])("has no wallet/session/signing capability on %s", async path => {
    const response = await request(path);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("data-preview-wallet-notice");
    expect(html).not.toMatch(MINT_CAPABILITIES);
    expect(html).not.toMatch(/assets\/sepolia|assets\/open-mint\.js|\/api\/(session|challenge|verify|test\/options)|personal_sign|eth_requestAccounts|eth_sendTransaction/);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("keeps /mint a preview explorer rather than a disabled mint flow", async () => {
    const response = await request("/mint?handle=Agent_Art");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("data-preview-explorer");
    expect(html).toContain('value="Agent_Art"');
    expect(html).toContain("No wallet needed.");
    expect(html).toContain("Minting coming soon.");
    expect(html).not.toMatch(/Connect wallet|Check price|Free slot|Maximum mint price|Mint &amp; reveal/);
  });

  it("keeps /me informational before launch without inventing empty ownership", async () => {
    const html = await (await request("/me")).text();
    expect(html).toContain("Minting hasn’t opened yet. Explore previews for now.");
    expect(html).toContain('href="/explore" data-collection-mint-cta');
    expect(html).not.toMatch(/Checking your collection|This wallet has no minted signatures|data-wallet-label|data-disconnect-wallet/);
  });

  it.each(MBTI_TYPES)("describes the honest empty %s minted gallery", async mbti => {
    const response = await request(`/${mbti}/`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`Minted signatures with ${mbti} appear here.`);
    expect(html).toContain("Minting hasn’t opened yet.");
    expect(html).toContain('href="/explore"');
    expect(html).not.toMatch(/Checking for minted signatures|No signatures minted|data-mbti-preview|RPC|Warning<\/strong>/);
  });

  it("generates all 16 variants for an arbitrary mixed-case handle", async () => {
    const env = environment();
    const response = await request("/p/Alice_Bob_Key/variations", env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html.match(/class="open-preview-card"/g)).toHaveLength(16);
    expect(html.match(/>Preview<\/span>/g)).toHaveLength(16);
    for (const mbti of MBTI_TYPES) {
      expect(html).toContain(`href="/p/Alice_Bob_Key/${mbti}"`);
      expect(html).toContain(`/preview/Alice_Bob_Key/${mbti}.svg?renderer=${RENDERER_VERSION}`);
    }
    expect(html).not.toMatch(/Minted<\/a>|Confirming<\/span>|data-preview-minted="/);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each(MBTI_TYPES)("serves algorithm-derived %s SVG, never a fixture", async mbti => {
    const env = environment();
    const response = await request(`/preview/Alice_Bob_Key/${mbti}.svg?renderer=${RENDERER_VERSION}`, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^image\/svg\+xml/);
    expect(await response.text()).toBe(renderSignatureSvg("Alice_Bob_Key", mbti));
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each(MBTI_TYPES)("HEAD validates %s SVG without invoking the renderer", async mbti => {
    const render = vi.spyOn(algorithmV2, "renderSignatureSvg").mockImplementation(() => {
      throw new Error("HEAD must not render artwork");
    });
    const response = await request(`/preview/012345678901234/${mbti}.svg?renderer=${RENDERER_VERSION}`, environment(), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await response.text()).toBe("");
    expect(render).not.toHaveBeenCalled();
  });

  it.each([
    ["/preview/Alice/intj.svg", 308],
    ["/preview/Alice/NOPE.svg", 404],
    ["/preview/0123456789012345/INTJ.svg", 404],
    ["/preview/Alice/INTJ.svg?renderer=obsolete", 400],
    [`/preview/Alice/INTJ.svg?renderer=${RENDERER_VERSION}&renderer=${RENDERER_VERSION}`, 400],
  ] as const)("HEAD keeps SVG validation and redirects at %s", async (path, status) => {
    const render = vi.spyOn(algorithmV2, "renderSignatureSvg");
    const response = await request(path, environment(), { method: "HEAD" });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
    expect(render).not.toHaveBeenCalled();
  });

  it.each(["A", "a_b", "123456789012345"])("accepts valid edge handle %s", async handle => {
    const response = await request(`/p/${handle}/INTJ`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`/preview/${handle}/INTJ.svg`);
  });

  it.each([
    ["/explore?handle=%40Alice_Bob_Key", "/p/Alice_Bob_Key/variations", 302],
    ["/explore?handle=%20Alice_Bob_Key%20", "/p/Alice_Bob_Key/variations", 302],
    ["/p/Alice_Bob_Key", "/p/Alice_Bob_Key/variations", 308],
    ["/s/Alice_Bob_Key", "/p/Alice_Bob_Key/variations", 308],
    ["/s/Alice_Bob_Key/INTJ", "/p/Alice_Bob_Key/INTJ", 308],
    ["/p/Alice_Bob_Key/intj", "/p/Alice_Bob_Key/INTJ", 308],
    ["/p/Alice_Bob_Key/INTJ/", "/p/Alice_Bob_Key/INTJ", 308],
    ["/p/Alice_Bob_Key/variations/", "/p/Alice_Bob_Key/variations", 308],
    ["/intj", "/INTJ/", 308],
    ["/INTJ", "/INTJ/", 308],
    ["/intj/", "/INTJ/", 308],
    ["/preview/Alice_Bob_Key/intj.svg", "/preview/Alice_Bob_Key/INTJ.svg", 308],
  ] as const)("canonicalizes %s with a local redirect", async (path, location, status) => {
    const response = await request(path);
    expect(response.status).toBe(status);
    expect(response.headers.get("Location")).toBe(location);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("retains an invalid explorer draft safely instead of redirecting to a supplied URL", async () => {
    const response = await request("/explore?handle=%22%3Cscript%3Ebad");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(html).toContain('value="&quot;&lt;script&gt;bad"');
    expect(html).not.toContain("<script>bad");
  });

  it.each(["/health", "/health/live", "/health/ready"])("reports %s as preview readiness, not mint readiness", async path => {
    const response = await request(path);
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ live: true, frontendOnly: true, siteLaunchMode: "prelaunch", mintingEnabled: false,
      walletConnectionEnabled: false, rpcEnabled: false });
    expect(JSON.stringify(body)).not.toMatch(/privateKey|authorizerKey|rpcUrl|databaseUrl/i);
  });

  it.each(["/api/session", "/api/challenge", "/api/verify", "/api/test/options", "/api/test/prepare", "/api/test/begin", "/api/assessment", "/api/mint", "/api/admin"])("fails closed on %s regardless of method", async path => {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const env = environment();
      const response = await request(path, env, { method });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "SITE_NOT_OPEN" });
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    }
  });

  it.each(AGENT_DOCUMENT_PATHS)("publishes read-only agent document %s with exact origin", async path => {
    for (const origin of [STAGING, PRODUCTION]) {
      const response = await request(path, environment(origin));
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body.length).toBeGreaterThan(100);
      if (path !== "/prompts/mint-assessment.txt") expect(body).toContain(origin);
      expect(body).not.toMatch(/127\.0\.0\.1|localhost|YOUR_PRIVATE_KEY/);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
    expect((await request(`${path}?wallet=0x123`)).status).toBe(400);
    expect((await request(path, environment(), { method: "POST" })).status).toBe(405);
  });

  it("the agent index does not claim a live mint or an assessed artwork", async () => {
    const response = await request("/agent-index.json");
    const index = await response.json() as { preview: Record<string, unknown>; context: Record<string, unknown> };
    expect(index.preview).toMatchObject({ walletRequired: false, siteAssessmentRequested: false, editable: true });
    expect(index.context.assessmentSource).not.toBe("sample");
    expect(JSON.stringify(index)).not.toMatch(/chainId|contractAddress|rpcUrl|signingKey/);
  });

  it("staging is unindexable while production is indexable", async () => {
    for (const origin of [STAGING, PRODUCTION]) {
      const env = environment(origin);
      const response = await request("/", env);
      const html = await response.text();
      const robots = await (await request("/robots.txt", env)).text();
      if (origin === STAGING) {
        expect(response.headers.get("X-Robots-Tag")).toMatch(/noindex/);
        expect(html).toMatch(/<meta name="robots" content="[^\"]*noindex/);
        expect(robots).toContain("Disallow: /");
      } else {
        expect(response.headers.get("X-Robots-Tag") ?? "").not.toContain("noindex");
        expect(html).not.toMatch(/<meta name="robots" content="[^\"]*noindex/);
        expect(robots).not.toContain("Disallow: /\n");
        expect(robots).toContain(`${origin}/sitemap.xml`);
      }
    }
  });

  it("production sitemap contains public documentation and discovery, not mint or wallet actions", async () => {
    const response = await request("/sitemap.xml", environment(PRODUCTION));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/xml/);
    expect(body).toContain(`${PRODUCTION}/about`);
    expect(body).toContain(`${PRODUCTION}/explore`);
    expect(body).not.toMatch(/staging\.|127\.0\.0\.1|\/api\/|\/me<|\/mint</);
  });

  it.each(["/", "/about", "/explore", "/INTJ/", "/p/Alice/INTJ", "/p/Alice/variations"])("gives production %s an exact-origin canonical URL", async path => {
    const html = await (await request(path, environment(PRODUCTION))).text();
    expect(html).toContain(`<link rel="canonical" href="${PRODUCTION}${path}">`);
    expect(html).not.toMatch(/staging\.signatures\.gallery|127\.0\.0\.1/);
  });

  it.each(["/mint", "/me", "/explore?handle=bad-handle"])("keeps production utility/draft %s unindexable", async path => {
    const response = await request(path, environment(PRODUCTION));
    const html = await response.text();
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(html).toMatch(/<meta name="robots" content="[^\"]*noindex/);
    expect(html).not.toContain('rel="canonical"');
  });

  it("staging sitemap remains constrained to staging and is marked unindexable", async () => {
    const response = await request("/sitemap.xml");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    const xml = await response.text();
    expect(xml).toContain(`${STAGING}/about`);
    expect(xml).not.toContain(`${PRODUCTION}/`);
  });

  it.each(["/", "/about", "/preview/Alice/INTJ.svg", "/agent-index.json", "/robots.txt", "/missing", "/api/mint"])("sets security headers on %s", async path => {
    const response = await request(path);
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])("rejects %s to page routes", async method => {
    const env = environment();
    const response = await request("/explore", env, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toContain("GET");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each(["/", "/about", "/explore", "/INTJ/", "/preview/Alice/INTJ.svg", "/agent-index.json", "/missing"])("HEAD %s has GET status and headers but no body", async path => {
    const get = await request(path);
    const head = await request(path, environment(), { method: "HEAD" });
    expect(head.status).toBe(get.status);
    expect(head.headers.get("Content-Type")).toBe(get.headers.get("Content-Type"));
    expect(await head.text()).toBe("");
  });

  it.each(["/p/Alice/NOPE", "/p/Alice/1234", "/p/0123456789012345/INTJ", "/p/alice-bob/INTJ", "/preview/Alice/NOPE.svg", "/NOPE/", "/signatures/alice", "/admin", "/requests/opaque"])("does not invent public state at %s", async path => {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/Minted<\/a>|Confirming<\/span>|data-connect-wallet|data-request-submit/);
  });

  it.each(["/?phase=free", "/about?wallet=0x123", "/me?address=0x123", "/explore?handle=Alice&handle=Bob", "/mint?handle=Alice&phase=paid", "/p/Alice/INTJ?phase=paid", "/preview/Alice/INTJ.svg?renderer=obsolete", `/preview/Alice/INTJ.svg?renderer=${RENDERER_VERSION}&renderer=${RENDERER_VERSION}`])("rejects unsupported or duplicate query at %s", async path => {
    const response = await request(path);
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  it.each(["http://staging.signatures.gallery", "https://staging.signatures.gallery.evil.example", "https://signatures.gallery.evil.example", "https://evil.example", "https://signatures.gallery:8443", "https://user:password@signatures.gallery", "https://signatures.gallery/path", "https://signatures.gallery?phase=free", ""])("fails closed on invalid configured origin %s", async origin => {
    const env = environment(origin);
    const response = await handlePreviewRequest(new Request(`${STAGING}/`), env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/password|data-home-mint-cta/);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each(["https://evil.example", "https://signatures.gallery", "https://staging.signatures.gallery:8443"])("rejects a request origin differing from staging: %s", async origin => {
    const env = environment();
    const response = await handlePreviewRequest(new Request(`${origin}/`), env);
    expect(response.status).toBe(421);
    expect(response.headers.get("Location")).toBeNull();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each([STAGING, PRODUCTION])("upgrades only %s's same-host HTTP GET/HEAD, preserving path and query", async origin => {
    const env = environment(origin);
    for (const method of ["GET", "HEAD"]) {
      const path = "/explore?handle=%40Alice_Bob_Key";
      const response = await handlePreviewRequest(new Request(origin.replace("https:", "http:") + path, { method }), env);
      expect(response.status).toBe(308);
      expect(response.headers.get("Location")).toBe(origin + path);
      expect(await response.text()).toBe("");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    }
  });

  it("upgrades HTTP with a matching Host but does not trust forwarded redirect destinations", async () => {
    const response = await handlePreviewRequest(new Request("http://staging.signatures.gallery/about?next=https://evil.example", {
      headers: { Host: "staging.signatures.gallery", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https" },
    }), environment());
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(`${STAGING}/about?next=https://evil.example`);
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])("does not redirect same-host HTTP %s", async method => {
    const env = environment();
    const response = await handlePreviewRequest(new Request("http://staging.signatures.gallery/api/mint", { method }), env);
    expect(response.status).toBe(421);
    expect(response.headers.get("Location")).toBeNull();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://evil.example/", "http://signatures.gallery/", "http://www.staging.signatures.gallery/",
    "http://staging.signatures.gallery.evil.example/", "http://staging.signatures.gallery:8443/",
    "http://staging.signatures.gallery:443/", "https://staging.signatures.gallery:8443/",
  ])("does not upgrade a foreign host or explicit non-default port: %s", async url => {
    const env = environment();
    const response = await handlePreviewRequest(new Request(url), env);
    expect(response.status).toBe(421);
    expect(response.headers.get("Location")).toBeNull();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each(["evil.example", "signatures.gallery", "staging.signatures.gallery:80"])("does not redirect HTTP with forged Host %s", async host => {
    const env = environment();
    const response = await handlePreviewRequest(new Request("http://staging.signatures.gallery/", { headers: { Host: host } }), env);
    expect(response.status).toBe(421);
    expect(response.headers.get("Location")).toBeNull();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each(["http://user@staging.signatures.gallery/", "http://user:password@staging.signatures.gallery/", "http://:password@staging.signatures.gallery/"])("does not redirect a credential-bearing URL: %s", async url => {
    const env = environment();
    // Fetch's constructor rejects credentials first; this synthetic request
    // exercises the handler boundary as well without logging a real secret.
    const response = await handlePreviewRequest({ url, method: "GET", headers: new Headers() } as Request, env);
    expect(response.status).toBe(421);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).not.toContain("password");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each(["/p/Alice%2Fadmin/INTJ", "/assets//secret"])("does not upgrade an invalid HTTP path: %s", async path => {
    const env = environment();
    const response = await handlePreviewRequest(new Request("http://staging.signatures.gallery" + path), env);
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("does not trust forwarded headers to turn a foreign request into the configured origin", async () => {
    const env = environment();
    const response = await handlePreviewRequest(new Request("https://evil.example/", {
      headers: { "X-Forwarded-Host": "staging.signatures.gallery", "X-Forwarded-Proto": "https", "Origin": STAGING },
    }), env);
    expect(response.status).toBe(421);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("rejects a mismatched explicit Host header instead of reflecting it", async () => {
    const env = environment();
    const response = await handlePreviewRequest(new Request(`${STAGING}/`, { headers: { Host: "evil.example" } }), env);
    expect(response.status).toBe(421);
    expect(response.headers.get("Location")).toBeNull();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("accepts a matching explicit Host header", async () => {
    const response = await request("/", environment(), { headers: { Host: "staging.signatures.gallery" } });
    expect(response.status).toBe(200);
  });

  it("fails closed when the static binding is unavailable", async () => {
    const response = await handlePreviewRequest(new Request(`${STAGING}/`), { PUBLIC_ORIGIN: STAGING } as PreviewWorkerEnv);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("data-home-mint-cta");
  });

  it.each(["/p/Alice%2Fadmin/INTJ", "/p/Alice%00/INTJ", "/p/Alice%5Cfoo/INTJ", "/assets/%2e%2e%2fsecret", "/assets//secret", "/.env.local", "/wrangler.jsonc", "/src/preview/worker.ts"])("does not delegate invalid path %s to static assets", async path => {
    const env = environment();
    const response = await request(path, env);
    expect([400, 404]).toContain(response.status);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized input without generating artwork", async () => {
    const env = environment();
    const response = await request(`/explore?handle=${"A".repeat(4096)}`, env);
    expect([400, 414]).toContain(response.status);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("delegates only same-origin published assets and reapplies security headers", async () => {
    const env = environment();
    env.ASSETS.fetch.mockResolvedValueOnce(new Response("font bytes", {
      headers: { "Content-Type": "font/woff2", "Set-Cookie": "unexpected=1", "Access-Control-Allow-Origin": "*" },
    }));
    const response = await request("/assets/fonts/playpen-sans-5.3.0/playpen-sans-latin-wght-normal.woff2", env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("font/woff2");
    expect(await response.text()).toBe("font bytes");
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
    const delegated = env.ASSETS.fetch.mock.calls[0]![0];
    expect(delegated.url).toBe(`${STAGING}/assets/fonts/playpen-sans-5.3.0/playpen-sans-latin-wght-normal.woff2`);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it.each([
    [404, 404], [302, 503], [403, 503], [500, 503],
  ] as const)("treats asset status %s as %s without forwarding a redirect or private response", async (assetStatus, status) => {
    const env = environment();
    env.ASSETS.fetch.mockResolvedValueOnce(new Response("private upstream details", {
      status: assetStatus, headers: { Location: "https://evil.example", "Set-Cookie": "token=secret" },
    }));
    const response = await request("/assets/preview.css", env);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toMatch(/private upstream details|secret/);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("does not serve an HTML fallback as a font", async () => {
    const env = environment();
    env.ASSETS.fetch.mockResolvedValueOnce(new Response("<html>fallback</html>", { headers: { "Content-Type": "text/html" } }));
    const response = await request("/assets/fonts/playpen-sans-5.3.0/playpen-sans-latin-wght-normal.woff2", env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("<html>fallback</html>");
  });

  it.each(["/assets/preview.css", "/assets/preview.js", FAVICON_URL])("rejects an HTML fallback for static %s", async path => {
    const env = environment();
    env.ASSETS.fetch.mockResolvedValueOnce(new Response("<html>fallback</html>", { headers: { "Content-Type": "text/html" } }));
    const response = await request(path, env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("<html>fallback</html>");
  });

  it.each([
    ["/assets/preview.css", "text/css; charset=utf-8"],
    ["/assets/preview.js", "text/javascript; charset=utf-8"],
    [FAVICON_URL, "image/svg+xml; charset=utf-8"],
    ["/assets/fonts/playpen-sans-5.3.0/LICENSE.txt", "text/plain; charset=utf-8"],
  ] as const)("serves exact typed asset %s", async (path, type) => {
    const env = environment();
    env.ASSETS.fetch.mockResolvedValueOnce(new Response("public typed asset", { headers: { "Content-Type": type } }));
    const response = await request(path, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(type);
    expect(response.headers.get("Cache-Control")).toBe(/\/preview\.(css|js)$/.test(path) ? "no-cache" : "public, max-age=300");
    expect(await response.text()).toBe("public typed asset");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
  });

  it("cannot enable minting from extra deployment settings or a private-key-shaped binding", async () => {
    const env = { ...environment(), SITE_LAUNCH_MODE: "open", MINTING_ENABLED: "true", PRIVATE_KEY: "do-not-publish" };
    const home = await request("/", env);
    const html = await home.text();
    expect(home.status).toBe(200);
    expect(html).toContain("Minting coming soon.");
    expect(html).not.toMatch(MINT_CAPABILITIES);
    expect(html).not.toContain("do-not-publish");
    const health = await (await request("/health/ready", env)).json();
    expect(health).toMatchObject({ mintingEnabled: false, walletConnectionEnabled: false, rpcEnabled: false });
    expect((await request("/api/mint", env, { method: "POST" })).status).toBe(409);
  });

  it("handles static-binding errors without leaking infrastructure details", async () => {
    const env = environment();
    env.ASSETS.fetch.mockRejectedValueOnce(new Error("Authorization failed: secret infrastructure token"));
    const response = await request("/assets/preview.js", env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/secret infrastructure token|Authorization failed/);
  });

  it.each(["/assets/preview.css?phase=paid", "/assets/preview.js?handle=Alice", "/assets/fonts/playpen-sans-5.3.0/LICENSE.txt?key=secret", "/assets/favicon.svg?v=obsolete", "/assets/favicon.svg?v=one&v=two"])("rejects asset query %s without invoking the binding", async path => {
    const env = environment();
    const response = await request(path, env);
    expect(response.status).toBe(400);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("HEAD on a static asset delegates once but returns no body", async () => {
    const env = environment();
    env.ASSETS.fetch.mockResolvedValueOnce(new Response("script body", { headers: { "Content-Type": "text/javascript" } }));
    const response = await request("/assets/preview.js", env, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript");
    expect(await response.text()).toBe("");
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
  });
});
