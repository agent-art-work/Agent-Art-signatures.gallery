import { createServer as createProbeServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createOpenMintServer, type OpenMintServerOptions } from "./server.js";
import { OpenMintService } from "./service.js";
import { PublicError, WalletSessions } from "./security.js";
import { MemoryKeyValueStore } from "./storage.js";
import { assessmentDigest, AssessmentCoordinator, type AssessmentProvider, type LegacyAssessment, type UnsignedAssessment } from "./assessment.js";
import { MemoryAssessmentRepository } from "./assessmentStore.js";
import { DevelopmentAssessmentProvider } from "./grok.js";
import { handleDigest, LEGACY_MAPPING_VERSION, LEGACY_RENDERER_VERSION, MBTI_TYPES, RENDERER_VERSION, seedForMbti } from "./identity.js";
import { openMintTokenURIHash } from "./authorization.js";
import type { OpenMintNetwork } from "./network.js";
import type { MintState, SignatureRequest } from "./service.js";
import { renderSignatureSvg } from "../algorithmV2/index.js";
import { formalSignatureRenderer, sha256Hex } from "../v1/renderer.js";
import { SLOGAN_TOOLTIP_SCRIPT, SLOGAN_TOOLTIP_SCRIPT_URL } from "../brand/sloganTooltipScript.js";
import { SLOGAN_MBTI_HERO_SCRIPT, SLOGAN_MBTI_HERO_SCRIPT_URL, SLOGAN_MBTI_HERO_SVG } from "../brand/sloganMbtiHero.js";
import { OPEN_FLOW_QUESTION_MARK, REBALANCED_INK_HOOK_QUESTION_MARK } from "../brand/sloganQuestionMark.js";
import { QUESTION_MARK_V2_CANDIDATES } from "../brand/sloganQuestionMarkCandidates.js";
import { QUESTION_MARK_STUDY_CSS, QUESTION_MARK_STUDY_CSS_PATH, QUESTION_MARK_STUDY_PATH } from "../brand/sloganQuestionMarkStudy.js";
import { QUESTION_MARK_REVEAL_CSS, QUESTION_MARK_REVEAL_CSS_PATH, QUESTION_MARK_REVEAL_PATH, REVEAL_QUESTION_MARK_OPTIONS } from "../brand/sloganQuestionMarkRevealStudy.js";
import { SLOGAN_MBTI_FRAMES } from "../brand/sloganMbtiFrames.js";
import { OPEN_MINT_GALLERY_FIXTURES } from "./galleryFixtures.js";
import { MINT_CONTROL_STUDY_PATH, MINT_CONTROL_STUDY_CSS_PATH, MINT_CONTROL_STUDY_CSS, MINT_CONTROL_STUDY_SCRIPT_PATH, MINT_CONTROL_STUDY_SCRIPT } from "../brand/mintControlStudy.js";
import { SITE_FONT_CSS, SITE_FONT_PRELOAD, siteFontAsset } from "../v1/fonts.js";

const servers: Server[] = [];
const wallet = privateKeyToAccount(`0x${"7".repeat(64)}`);
const SELF_HOSTED_FONT_PATHS = [...SITE_FONT_CSS.matchAll(/url\(([^)]+)\)/g)].map(match => match[1]!);
const SELF_HOSTED_FONT_LICENSE_PATH = SELF_HOSTED_FONT_PATHS[0]!.replace(/[^/]+$/, "LICENSE.txt");
interface RequestOptions { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; skipOrigin?: boolean; skipCsrf?: boolean; skipCookie?: boolean; followRedirects?: boolean }

function expectProductionPresentation(html: string): void {
  expect(html).not.toMatch(/data-gallery-fixture-notice|Developer overlay|Fixture tools|Developer tools|rehearsal-overlay/);
  // Fixture provenance belongs in the collapsed evidence record, never a page-wide overlay.
  const chrome = html.replace(/<details class="signature-provenance">[\s\S]*?<\/details>/g, "");
  expect(chrome.replace(/<[^>]*>/g, " ")).not.toMatch(/\bfixtures?\b|\bsimulat(?:ed|ions?)\b|No tokens were minted/i);
  expect(html).not.toContain('href="/dev/gallery/');
}

function expectHandleNavigation(html: string, handle?: string, count?: number): void {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? html;
  const links = [...main.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    .map(([, attributes, label]) => ({ attributes: attributes!, handle: label!.replace(/<[^>]*>/g, "").trim().match(/^@([A-Za-z0-9_]{1,15})$/)?.[1] }))
    .filter(link => link.handle && (!handle || link.handle === handle));
  if (count === undefined) expect(links.length).toBeGreaterThan(0);
  else expect(links).toHaveLength(count);
  for (const link of links) {
    expect(link.attributes.match(/\bhref="([^"]*)"/)?.[1]).toBe(`/p/${link.handle}/variations`);
    expect(link.attributes).not.toMatch(/\btarget=/);
  }
}

function expectArtworkCaptionPolicy(html: string, count: number, mintedCount: number, previewCount = 0): void {
  const captions = [...html.matchAll(/<div class="artwork-caption\b[^"]*">[\s\S]*?<\/div>(?:<(a|span)\b[^>]*>[^<]*<\/\1>)?<\/div>/g)].map(match => match[0]);
  expect(captions).toHaveLength(count);
  for (const caption of captions) {
    expect(caption).toContain('class="artwork-identity"');
    expect(caption).toContain('<span class="artwork-personality-separator" aria-hidden="true">×</span>');
    const handleLink = caption.match(/<a\b[^>]*class="gallery-handle(?: [^"]*)?"[^>]*>([\s\S]*?)<\/a>/);
    expect(handleLink?.[1].replace(/<[^>]*>/g, "")).toMatch(/^@[A-Za-z0-9_]{1,15}$/);
    expect(handleLink?.index).toBeLessThan(caption.indexOf('artwork-personality-separator'));
    expect(caption.indexOf('artwork-personality-separator')).toBeLessThan(caption.indexOf('class="mbti-link"'));
    expectHandleNavigation(caption, undefined, 1);
    expect(caption).not.toMatch(/<img\b|<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
  }
  const statuses = captions.flatMap(caption => [...caption.matchAll(/<(a|span) class="[^"]*\bartwork-status\b[^"]*"([^>]*)>([^<]+)<\/\1>/g)]);
  for (const [, tag, attributes, label] of statuses) {
    expect(tag).toBe(label === "Minted" ? "a" : "span");
    if (label === "Minted") expect(attributes).toContain('href="/"');
    else expect(attributes).not.toContain('href=');
  }
  const labels = statuses.map(match => match[3]);
  expect(labels.filter(label => label === "Minted")).toHaveLength(mintedCount);
  expect(labels.filter(label => label === "Preview")).toHaveLength(previewCount);
}

function expectPreviewNoticePolicy(html: string, state: "unminted" | "pending" | "unavailable" | "minted" | "fixture", variations = true): void {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)![1]!;
  const intros = [...main.matchAll(/<p\b[^>]*data-preview-intro[^>]*>([\s\S]*?)<\/p>/g)];
  expect(intros).toHaveLength(variations ? 1 : 0);
  if (variations) {
    expect(intros[0]![0]).toContain('class="open-preview-intro"');
    expect(intros[0]![1]).toBe("One handle, all 16 MBTI interpretations. Choose a variation to explore.");
    expect(intros[0]![0]).not.toMatch(/role=|open-preview-notice|open-preview-warning/);
  }
  const notices = [...main.matchAll(/<p\b[^>]*data-preview-status[^>]*>[\s\S]*?<\/p>/g)].map(match => match[0]);
  expect(notices).toHaveLength(state === "pending" ? 1 : 0);
  for (const notice of notices) {
    expect(notice).toContain('role="status"');
    expect(notice).not.toMatch(/data-preview-intro|role="alert"/);
    expect(notice).toContain('<strong class="open-preview-notice-label">Pending</strong>');
    expect(notice).toContain('class="open-preview-notice"');
    if (variations) expect(main.indexOf(intros[0]![0])).toBeLessThan(main.indexOf(notice));
  }
  expect(main).not.toContain('open-preview-warning');
  const mintedNotes = [...main.matchAll(/<p\b[^>]*data-preview-minted-note[^>]*>([\s\S]*?)<\/p>/g)];
  expect(mintedNotes).toHaveLength(variations && (state === "minted" || state === "fixture") ? 1 : 0);
  for (const [, note] of mintedNotes) expect(note).toBe("One minted signature. Fifteen alternative interpretations, for exploration only.");
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Test HTTP server teardown timed out.")), 2_000);
      timer.unref();
      server.close(error => { clearTimeout(timer); error ? reject(error) : resolve(); });
      server.closeAllConnections();
    });
  }
  vi.restoreAllMocks();
});

async function fixture(options: Pick<OpenMintServerOptions, "rpcUrl" | "supportUrl" | "devWallet" | "devMint"> & { offline?: boolean; now?: () => number; fixture?: boolean; provider?: AssessmentProvider } = {}) {
  // By default exercise the actual asynchronous HTTP request listener through streams,
  // without opening a socket. Opt in to transport-level loopback coverage when permitted.
  const httpTransport = process.env.OPEN_MINT_TEST_HTTP === "1";
  let port = 43123;
  if (httpTransport) {
    const probe = createProbeServer();
    probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  }
  const origin = `http://127.0.0.1:${port}`;
  const provider = options.provider ?? new DevelopmentAssessmentProvider();
  const assess = vi.spyOn(provider, "assess");
  const repository = new MemoryAssessmentRepository();
  const assessments = new AssessmentCoordinator({ provider, repository });
  const store = new MemoryKeyValueStore();
  const states = new Map<string, MintState>();
  const network: OpenMintNetwork = {
    chainId: 31337, address: wallet.address, authorizer: wallet.address,
    now: async () => Math.floor(Date.now() / 1000),
    walletContext: vi.fn(async (recipient?: string) => ({ chainId: "0x7a69" as const, contract: wallet.address, blockNumber: "0xa" as const, blockHash: `0x${"b".repeat(64)}` as const, ...(recipient ? { nonce: "0x1" as const } : {}) })),
    state: vi.fn(async handle => states.get(handle) ?? { state: "unminted" as const }),
    sign: async () => `0x${"1".repeat(130)}`,
    transaction: async (_handle, authorization) => ({ from: authorization.recipient, to: wallet.address, data: "0x1234", value: "0x0", chainId: "0x7a69" }),
  };
  const service = new OpenMintService({ assessments: options.offline ? undefined : assessments, store, origin, fixture: options.fixture ?? true, network: options.offline ? undefined : network, now: options.now });
  const sessions = new WalletSessions(origin, 31337, options.now);
  const server = createOpenMintServer({ origin, fixture: options.fixture ?? true, service, sessions, rpcUrl: options.rpcUrl, supportUrl: options.supportUrl, devWallet: options.devWallet, devMint: options.devMint });
  if (httpTransport) { server.listen(port, "127.0.0.1"); await once(server, "listening"); servers.push(server); }
  const dispatch = async (path: string, method: string, headers: Record<string, string>, body?: string): Promise<Response> => {
    if (httpTransport) return new Promise((resolve, reject) => {
      // Unlike fetch, preserve caller-supplied Host so host-boundary tests reach
      // the server with the exact HTTP headers they claim to exercise.
      const outgoing = httpRequest(origin + path, { method, headers }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () => {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
          resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }));
        });
      });
      outgoing.on("error", reject);
      outgoing.setTimeout(5_000, () => outgoing.destroy(new Error("Test HTTP request timed out.")));
      outgoing.end(body);
    });
    const incoming = new Headers(headers);
    if (!incoming.has("host")) incoming.set("host", new URL(origin).host);
    const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
      method, url: path, headers: Object.fromEntries(incoming.entries()), socket: { remoteAddress: "127.0.0.1" },
    }) as unknown as IncomingMessage;
    const responseHeaders = new Headers();
    let output = Buffer.alloc(0), ended = false;
    const response = {
      statusCode: 200,
      setHeader(name: string, value: string | number | readonly string[]) {
        responseHeaders.delete(name);
        for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, String(item));
        return this;
      },
      end(content?: string | Uint8Array) {
        output = content === undefined ? Buffer.alloc(0) : Buffer.from(content);
        ended = true;
        return this;
      },
    };
    const listener = server.listeners("request")[0] as (request: IncomingMessage, response: ServerResponse) => Promise<void>;
    await listener(request, response as unknown as ServerResponse);
    expect(ended, "HTTP listener must terminate its response").toBe(true);
    return new Response(output, { status: response.statusCode, headers: responseHeaders });
  };
  const client = () => {
    let cookie = "";
    let csrf = "";
    return {
      get cookie() { return cookie; },
      get csrf() { return csrf; },
      async request(path: string, init: RequestOptions = {}) {
        const method = init.method ?? "GET";
        let currentPath = path;
        let response: Response;
        for (let redirects = 0; ; redirects++) {
          const headers: Record<string, string> = { ...(cookie && !init.skipCookie ? { Cookie: cookie } : {}), ...(method === "POST" ? { "Content-Type": "application/json", ...(!init.skipOrigin ? { Origin: origin } : {}), ...(!init.skipCsrf ? { "X-CSRF-Token": csrf } : {}) } : {}), ...init.headers };
          response = await dispatch(currentPath, method, headers, init.rawBody !== undefined ? init.rawBody : init.body === undefined ? undefined : JSON.stringify(init.body));
          const issued = response.headers.get("set-cookie");
          if (issued) cookie = issued.split(";")[0]!;
          const location = response.headers.get("location");
          if (init.followRedirects === false || method !== "GET" || ![301, 302, 303, 307, 308].includes(response.status) || !location) break;
          if (redirects >= 5) throw new Error("Too many test-client redirects.");
          const target = new URL(location, origin + currentPath);
          if (target.origin !== origin) throw new Error("Unexpected cross-origin test redirect.");
          await response.arrayBuffer();
          currentPath = target.pathname + target.search;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const text = bytes.toString("utf8");
        const json = response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : undefined;
        if (path === "/api/session" && response.ok) csrf = json.csrfToken;
        return { status: response.status, headers: response.headers, text, bytes, json };
      },
      async init() { return this.request("/api/session"); },
      async assess(handle = "Agent_Art") {
        await this.prove();
        const response = await this.request("/api/assessments", { method: "POST", body: { handle } });
        expect(response.status).toBe(202);
        await service.idle();
        const url = response.json.url as string;
        return { url, code: url.split("/").at(-1)! };
      },
      async prove(code?: string) {
        const response = await this.request("/api/wallet/challenge", { method: "POST", body: { address: wallet.address, ...(code ? { code } : {}) } });
        expect(response.status).toBe(200);
        const { challengeId, message } = response.json;
        const signature = await wallet.signMessage({ message });
        return { result: await this.request("/api/wallet/verify", { method: "POST", body: { challengeId, signature } }), challengeId, signature, message };
      },
    };
  };
  const mint = async (handle: string, state: "minted" | "confirming" | "pending" = "minted") => {
    const artifact = (await service.artifact(handle))!;
    states.set(handle.toLowerCase(), { state, tokenId: BigInt(handleDigest(handle)).toString(), wallet: wallet.address,
      transactionHash: `0x${"a".repeat(64)}`, assessmentDigest: artifact.assessment.digest, artifactDigest: artifact.digest,
      tokenURIHash: openMintTokenURIHash(artifact.tokenURI) });
  };
  return { origin, client, service, store, sessions, assess, network, mint, repository, states };
}

async function recordedGrokFixture() {
  const test = await fixture({ fixture: false, provider: {
    provenance: "grok", model: "grok-runtime-must-not-replace-recorded-model",
    assess: async () => { throw new Error("Browsing saved provenance must not invoke a provider."); },
  } });
  const unsigned: UnsignedAssessment = {
    id: "e3b780ec-29ab-41a5-a157-176d43b1d7ed", handle: "alice_bob", mbti: "INTJ",
    rendererVersion: RENDERER_VERSION, policyVersion: "grok-x-search-v1", model: "grok-4.3",
    providerResponseId: "private-provider-response-never-project",
    sourceUrls: ["https://x.com/Alice_Bob/status/123456789", "https://x.com/i/status/987654321"],
    createdAt: "2026-09-18T08:16:31.583Z", provenance: "grok",
    xIdentity: { canonicalHandle: "alice_bob", username: "Alice_Bob", userId: "135791357913579",
      verifiedAt: "2026-09-18T08:16:25.000Z", provenance: "x-api", freshness: "verified-at-preparation" },
  };
  const assessment = await test.repository.putIfAbsent({ ...unsigned, digest: assessmentDigest(unsigned) });
  const owner = test.client(); await owner.init();
  const request = await owner.assess("ALICE_BOB");
  return { ...test, owner, assessment, ...request };
}

describe("verified early reveal", () => {
  it("reveals one confirming artifact consistently in details, galleries and the verified owner's collection", async () => {
    const f = await fixture(), owner = f.client(), viewer = f.client(); await owner.init();
    const { code, url } = await owner.assess("Alice_Bob");
    const artifact = (await f.service.artifact("alice_bob"))!;
    const before = JSON.stringify(artifact);
    await f.mint("alice_bob", "confirming");
    const privateState = await owner.request(`/api/assessments/${code}`);
    expect(privateState.json).toMatchObject({ canMint: false, mbti: artifact.assessment.mbti, artifactDigest: artifact.digest, mint: { state: "confirming" } });
    const redirect = await owner.request(url, { followRedirects: false });
    expect(redirect.status).toBe(303); expect(redirect.headers.get("location")).toBe("/signatures/alice_bob");
    const page = await viewer.request("/signatures/alice_bob");
    expect(page.status).toBe(200);
    expect(page.text).toContain(`data-reveal-artifact="${artifact.digest}"`);
    expect(page.text).toContain('data-reveal-monitor');
    expect(page.text).toContain('data-mint-state-label>Confirming</span>');
    expect(page.text).toContain(`/artifacts/${artifact.svgSha256}.svg`);
    expect(page.text).not.toMatch(/>Minted<|data-assessment-code|data-submit-mint|data-connect-wallet|property="og:/);
    expect(page.headers.get("cache-control")).toContain("no-store");
    expectArtworkCaptionPolicy(page.text, 1, 0);
    const status = await viewer.request("/api/signatures/alice_bob/status");
    expect(status.json).toEqual({ handle: "alice_bob", tokenId: BigInt(handleDigest("alice_bob")).toString(), state: "confirming", artifactDigest: artifact.digest, transactionHash: `0x${"a".repeat(64)}` });
    expect(status.headers.get("cache-control")).toContain("no-store");
    for (const path of ["/", `/${artifact.assessment.mbti}/`, "/me"]) {
      const gallery = await owner.request(path);
      expect(gallery.text).toContain('class="gallery-item" data-mint-state="confirming"');
      expectArtworkCaptionPolicy(gallery.text, 1, 0);
      expect(gallery.text).toContain('>Confirming</span>');
      expect(gallery.text).not.toContain('data-mint-observation-warning');
    }
    const variations = await viewer.request("/p/Alice_Bob/variations");
    expectArtworkCaptionPolicy(variations.text, 16, 0, 15);
    expect(variations.text.match(/>Confirming<\/span>/g)).toHaveLength(1);
    expect(variations.text).toContain('View confirming signature');
    expect(variations.text).not.toContain('Mint for this handle');
    const preview = await viewer.request(`/p/Alice_Bob/${artifact.assessment.mbti}`);
    expectArtworkCaptionPolicy(preview.text, 1, 0);
    expect(preview.text).toContain('>Confirming</span>');
    await owner.prove();
    expect((await owner.request("/api/assessments", { method: "POST", body: { handle: "Alice_Bob" } })).json.code).toBe("MINT_PENDING");
    await owner.prove(code);
    expect((await owner.request("/api/mints/authorize", { method: "POST", body: { code, consent: true } })).json.code).toBe("ALREADY_MINTED");
    await f.mint("alice_bob");
    const terminal = await viewer.request("/signatures/alice_bob");
    expect(terminal.text).toContain('data-mint-state-label>Minted</a>');
    expect(terminal.text).not.toContain('data-reveal-monitor');
    expect((await owner.request("/")).text).toContain('class="gallery-item"');
    expect((await owner.request("/me")).text).toContain('class="gallery-item"');
    expect(JSON.stringify(await f.service.artifact("alice_bob"))).toBe(before);
    expect(f.assess).toHaveBeenCalledOnce();
  });

  it("withdraws inclusion on reorg, fails closed on unavailable/corrupt evidence, and never regenerates", async () => {
    const f = await fixture(), owner = f.client(), viewer = f.client(); await owner.init();
    await owner.assess("Alice_Bob"); await f.mint("alice_bob", "confirming");
    const artifact = (await f.service.artifact("alice_bob"))!;
    for (const state of ["pending", "unminted"] as const) {
      if (state === "pending") await f.mint("alice_bob", state);
      else f.states.set("alice_bob", { state });
      const result = await viewer.request("/api/signatures/alice_bob/status");
      expect(result.json).toEqual({ state, handle: "alice_bob", tokenId: BigInt(handleDigest("alice_bob")).toString() });
      expect((await viewer.request("/signatures/alice_bob")).status).toBe(404);
    }
    await f.mint("alice_bob", "confirming");
    f.states.get("alice_bob")!.artifactDigest = `0x${"b".repeat(64)}`;
    expect((await viewer.request("/api/signatures/alice_bob/status")).status).toBe(503);
    expect((await viewer.request("/signatures/alice_bob")).status).toBe(503);
    vi.mocked(f.network.state).mockRejectedValue(new Error("private RPC failure"));
    const failed = await viewer.request("/api/signatures/alice_bob/status");
    expect(failed.status).toBe(503); expect(failed.text).not.toMatch(/artifactDigest|private RPC/);
    expect(await f.service.artifact("alice_bob")).toEqual(artifact);
    expect(f.assess).toHaveBeenCalledOnce();
  });

  it("rejects confidence overrides and mutations on the public read endpoint", async () => {
    const f = await fixture(), client = f.client(); await client.init();
    expect((await client.request("/api/signatures/alice/status?state=minted")).status).toBe(400);
    expect((await client.request("/api/signatures/alice/status", { method: "POST", body: { state: "minted" } })).status).toBe(404);
    expect(f.network.state).not.toHaveBeenCalled();
    expect(f.assess).not.toHaveBeenCalled();
  });
});

describe("local-only crawl policy", () => {
  it("serves disallow-all robots before session creation or service work", async () => {
    const f = await fixture(), session = vi.spyOn(f.sessions, "session"), client = f.client();
    const response = await client.request("/robots.txt");
    expect(response.status).toBe(200);
    expect(response.text).toBe("User-agent: *\nDisallow: /\n");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive, nosnippet");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false); expect(client.cookie).toBe("");
    expect(session).not.toHaveBeenCalled(); expect(f.assess).not.toHaveBeenCalled(); expect(f.network.state).not.toHaveBeenCalled();
  });
  it("keeps every local page, asset, API and error response noindex without changing page markup", async () => {
    const f = await fixture({ offline: true }), client = f.client();
    for (const path of ["/", "/mint", "/me", "/p/Alice/INTJ", "/preview/Alice/INTJ.svg", "/api/session", "/api/unknown", "/missing-page"]) {
      const response = await client.request(path);
      expect(response.headers.get("x-robots-tag"), path).toBe("noindex, nofollow, noarchive, nosnippet");
      expect(response.text).not.toMatch(/rel="canonical"|property="og:|name="twitter:/);
    }
    const wrongHost = await client.request("/robots.txt", { headers: { Host: "other.example" } });
    expect(wrongHost.status).toBe(421); expect(wrongHost.headers.get("x-robots-tag")).toContain("noindex");
    expect(f.assess).not.toHaveBeenCalled();
  });
});

describe("open mint HTTP boundary", () => {
  it("serves control comparisons without sessions, chain reads or assessment calls", async () => {
    const test = await fixture();
    const session = vi.spyOn(test.sessions, "session");
    const page = await test.client().request(MINT_CONTROL_STUDY_PATH);
    expect(page.status).toBe(200);
    expect(page.text.match(/data-control-style=/g)).toHaveLength(5);
    expect(page.text).not.toMatch(/<form\b|data-assessment-request|data-wallet/);
    for (const [path, content, type] of [
      [MINT_CONTROL_STUDY_CSS_PATH, MINT_CONTROL_STUDY_CSS, "text/css; charset=utf-8"],
      [MINT_CONTROL_STUDY_SCRIPT_PATH, MINT_CONTROL_STUDY_SCRIPT, "text/javascript; charset=utf-8"],
    ]) {
      const response = await test.client().request(path!);
      expect(response.status).toBe(200);
      expect(response.text).toBe(content);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(page.headers.get("content-security-policy")).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(session).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
    expect(test.network.state).not.toHaveBeenCalled();
  });

  it("keeps control comparisons unavailable outside fixture mode", async () => {
    const test = await fixture({ fixture: false });
    for (const path of [MINT_CONTROL_STUDY_PATH, MINT_CONTROL_STUDY_CSS_PATH, MINT_CONTROL_STUDY_SCRIPT_PATH]) {
      const response = await test.client().request(path);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('class="mcs-grid"');
      expect(response.text).not.toBe(MINT_CONTROL_STUDY_CSS);
      expect(response.text).not.toBe(MINT_CONTROL_STUDY_SCRIPT);
    }
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("serves the Reveal question-mark comparisons and CSS without sessions or assessment under the existing CSP", async () => {
    const test = await fixture();
    const session = vi.spyOn(test.sessions, "session");
    const css = await test.client().request(QUESTION_MARK_REVEAL_CSS_PATH);
    expect(css.status).toBe(200);
    expect(css.text).toBe(QUESTION_MARK_REVEAL_CSS);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    const responses = [css];
    for (const shape of [undefined, ...SLOGAN_MBTI_FRAMES.map(frame => frame.mbti)]) {
      const page = await test.client().request(`${QUESTION_MARK_REVEAL_PATH}${shape ? `?shape=${shape}` : ""}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(page.text.match(/data-context="/g)).toHaveLength(4);
      for (const mark of REVEAL_QUESTION_MARK_OPTIONS) {
        expect(page.text).toContain(`data-context="${mark.id}" data-shape="${shape ?? "INFP"}"`);
      }
      expect(page.text).not.toMatch(/<script\b|<form\b|<button\b|\bon[a-z]+=/);
      responses.push(page);
    }
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(session).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
    expect(test.network.state).not.toHaveBeenCalled();
  });

  it("rejects invalid Reveal comparison shapes without reflecting inputs or issuing sessions", async () => {
    const test = await fixture();
    const session = vi.spyOn(test.sessions, "session");
    for (const shape of ["", "unknown", "ENFP", "infp", "INFP\n", "__proto__", '\"><script>alert(1)</script>']) {
      const response = await test.client().request(`${QUESTION_MARK_REVEAL_PATH}?shape=${encodeURIComponent(shape)}`);
      expect(response.status).toBe(400);
      expect(response.text).not.toContain("alert(1)");
      expect(response.text).not.toContain("__proto__");
      expect(response.text).not.toContain('data-context="');
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(session).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
    expect(test.network.state).not.toHaveBeenCalled();
  });

  it("keeps Reveal comparison routes unavailable outside fixture mode", async () => {
    const test = await fixture({ fixture: false });
    for (const path of [QUESTION_MARK_REVEAL_PATH, `${QUESTION_MARK_REVEAL_PATH}?shape=INFP`, QUESTION_MARK_REVEAL_CSS_PATH]) {
      const response = await test.client().request(path);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('data-context="');
      expect(response.text).not.toBe(QUESTION_MARK_REVEAL_CSS);
    }
    expect(test.assess).not.toHaveBeenCalled();
    expect(test.network.state).not.toHaveBeenCalled();
  });

  it("visiting every Reveal comparison preserves the approved homepage without punctuation", async () => {
    const test = await fixture();
    const client = test.client();
    for (const frame of SLOGAN_MBTI_FRAMES) {
      expect((await client.request(`${QUESTION_MARK_REVEAL_PATH}?shape=${frame.mbti}`)).status).toBe(200);
    }
    const home = await client.request("/");
    expect(home.status).toBe(200);
    expect(home.text).toContain(SLOGAN_MBTI_HERO_SVG);
    expect(home.text).not.toContain('data-punctuation-id=');
    expect(home.text).not.toContain(OPEN_FLOW_QUESTION_MARK.svgMarkup);
    expect(home.text).not.toContain(QUESTION_MARK_REVEAL_CSS_PATH);
    for (const mark of REVEAL_QUESTION_MARK_OPTIONS) {
      expect(home.text).not.toContain(mark.svgMarkup);
    }
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("serves local question-mark proposals and their CSS without sessions, assessment, or weaker CSP", async () => {
    const test = await fixture();
    const session = vi.spyOn(test.sessions, "session");
    const page = await test.client().request(`${QUESTION_MARK_STUDY_PATH}?mark=ribbon-fold&shape=ISTJ`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-context="ribbon-fold" data-shape="ISTJ"');
    expect(page.text).toContain('data-context="previous" data-shape="ISTJ"');
    expect(page.text).not.toMatch(/<script\b|<form\b/);
    const css = await test.client().request(QUESTION_MARK_STUDY_CSS_PATH);
    expect(css.status).toBe(200);
    expect(css.text).toBe(QUESTION_MARK_STUDY_CSS);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    for (const response of [page, css]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("content-security-policy")).toContain("script-src 'self';");
      expect(response.headers.get("content-security-policy")).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(session).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
    expect(test.network.state).not.toHaveBeenCalled();
  });

  it("rejects invalid question-mark selections without reflecting inputs or issuing sessions", async () => {
    const test = await fixture();
    const session = vi.spyOn(test.sessions, "session");
    for (const query of ["mark=unknown", "shape=ENFP", "mark=", "shape=infp", "shape=INFP%0A", "mark=%22%3E%3Cscript%3Ealert(1)%3C/script%3E"]) {
      const response = await test.client().request(`${QUESTION_MARK_STUDY_PATH}?${query}`);
      expect(response.status).toBe(400);
      expect(response.text).toContain("Choose a listed question mark and slogan shape.");
      expect(response.text).not.toContain("alert(1)");
      expect(response.text).not.toContain('class="qm-options"');
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(session).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("does not expose the question-mark proposal routes outside fixture mode", async () => {
    const test = await fixture({ fixture: false });
    for (const path of [QUESTION_MARK_STUDY_PATH, `${QUESTION_MARK_STUDY_PATH}?mark=ink-hook&shape=INFP`, QUESTION_MARK_STUDY_CSS_PATH]) {
      const response = await test.client().request(path);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('class="qm-options"');
      expect(response.text).not.toBe(QUESTION_MARK_STUDY_CSS);
    }
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("proposal selections never add punctuation to the approved homepage", async () => {
    const test = await fixture(); const client = test.client();
    for (const mark of QUESTION_MARK_V2_CANDIDATES) {
      expect((await client.request(`${QUESTION_MARK_STUDY_PATH}?mark=${mark.id}&shape=INTP`)).status).toBe(200);
      const home = await client.request("/");
      expect(home.status).toBe(200);
      expect(home.text).toContain(SLOGAN_MBTI_HERO_SVG);
      expect(home.text).not.toContain('data-punctuation-id=');
      expect(home.text).not.toContain(REBALANCED_INK_HOOK_QUESTION_MARK.svgMarkup);
      expect(home.text).not.toContain(OPEN_FLOW_QUESTION_MARK.svgMarkup);
      expect(home.text).not.toContain(mark.svgMarkup);
      expect(home.text).not.toContain(QUESTION_MARK_STUDY_CSS_PATH);
    }
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("serves the home slogan tooltip as a content-addressed session-free script under the existing CSP", async () => {
    const test = await fixture(); const client = test.client();
    const home = await client.request("/");
    expect(home.status).toBe(200);
    const scripts = [...home.text.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map(match => match[1]!);
    expect(scripts.filter(path => path === SLOGAN_TOOLTIP_SCRIPT_URL)).toHaveLength(1);
    expect(home.text).toContain('aria-labelledby="slogan-heading"');
    expect(home.text).toContain('<h1 id="slogan-heading" class="visually-hidden">Anyone_Can_Sign_Anyone</h1>');
    expect(home.text).toContain('title="Anyone_Can_Sign_Anyone"');
    expect(home.text).toContain('role="tooltip" aria-hidden="true" hidden>Anyone_Can_Sign_Anyone</span>');
    const csp = home.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(SLOGAN_TOOLTIP_SCRIPT_URL).toBe(`/assets/slogan-tooltip-${sha256Hex(Buffer.from(SLOGAN_TOOLTIP_SCRIPT)).slice(0, 16)}.js`);

    const session = vi.spyOn(test.sessions, "session"); session.mockClear();
    for (const path of [SLOGAN_TOOLTIP_SCRIPT_URL, `${SLOGAN_TOOLTIP_SCRIPT_URL}?cache-check=1`]) {
      const asset = await test.client().request(path);
      expect(asset.status).toBe(200);
      expect(asset.text).toBe(SLOGAN_TOOLTIP_SCRIPT);
      expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(asset.headers.get("set-cookie")).toBeNull();
      expect(asset.headers.get("content-security-policy")).toBe(csp);
      expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(session).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
    for (const path of ["/mint", "/me", "/about", "/p/Alice_Bob_Key/ENFP", "/p/Alice_Bob_Key/variations"]) {
      const page = await client.request(path);
      expect(page.status).toBe(200);
      expect(page.text).not.toContain(SLOGAN_TOOLTIP_SCRIPT_URL);
      expect(page.text).not.toContain('id="slogan-tooltip"');
    }
  });

  it("serves the eight-shape animation script without sessions, assessment calls, or weaker CSP", async () => {
    const test = await fixture(); const client = test.client();
    const home = await client.request("/");
    const script = `<script src="${SLOGAN_MBTI_HERO_SCRIPT_URL}" defer></script>`;
    expect(home.status).toBe(200);
    expect(home.text.split(script)).toHaveLength(2);
    expect(home.text).toContain('data-source-renderer="sg-renderer-2.0.1"');
    expect(home.text.match(/data-slogan-frame="[A-Z]{4}"/g)).toHaveLength(8);
    const csp = home.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(SLOGAN_MBTI_HERO_SCRIPT_URL).toMatch(new RegExp(`/assets/[^/]+-${sha256Hex(Buffer.from(SLOGAN_MBTI_HERO_SCRIPT)).slice(0, 16)}\\.js$`));

    const session = vi.spyOn(test.sessions, "session"); session.mockClear();
    for (const path of [SLOGAN_MBTI_HERO_SCRIPT_URL, `${SLOGAN_MBTI_HERO_SCRIPT_URL}?cache-check=1`]) {
      const asset = await test.client().request(path);
      expect(asset.status).toBe(200);
      expect(asset.text).toBe(SLOGAN_MBTI_HERO_SCRIPT);
      expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(asset.headers.get("set-cookie")).toBeNull();
      expect(asset.headers.get("content-security-policy")).toBe(csp);
      expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(session).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
    for (const path of ["/mint", "/me", "/about", "/p/Alice_Bob_Key/ENFP", "/p/Alice_Bob_Key/variations"]) {
      const page = await client.request(path);
      expect(page.status).toBe(200);
      expect(page.text).not.toContain(SLOGAN_MBTI_HERO_SCRIPT_URL);
      expect(page.text).not.toContain('id="slogan-animation"');
    }
  });

  it("rejects an unexpected Host before creating a session or accessing application state", async () => {
    const test = await fixture(); const client = test.client();
    const session = vi.spyOn(test.sessions, "session");
    for (const path of ["/", "/api/session", "/preview/alice/ENFP.svg"]) {
      const response = await client.request(path, { headers: { Host: "attacker.example" } });
      expect(response.status).toBe(421);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      if (path.startsWith("/api/")) expect(response.json.code).toBe("WRONG_HOST");
      else expect(response.text).toContain("Open the configured site address.");
    }
    expect(session).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
    expect(test.network.state).not.toHaveBeenCalled();
  });

  it("keeps the preview available when assessment and mint services are not configured", async () => {
    const test = await fixture({ offline: true, rpcUrl: "http://127.0.0.1:18548/rpc" });
    const client = test.client();
    const session = await client.init();
    expect(session.json).toMatchObject({ wallet: null, walletVerified: false, chainId: "31337", rpcUrl: "http://127.0.0.1:18548/rpc" });
    const preview = await client.request("/p/Alice_Bob/ENFP");
    expect(preview.status).toBe(200);
    expectProductionPresentation(preview.text);
    expect(preview.text).not.toContain("Set XAI_API_KEY");
    expect(preview.text).not.toContain("Minting is disabled until the isolated local chain is started.");
    expect(preview.headers.get("content-security-policy")).toContain("connect-src 'self' http://127.0.0.1:18548;");
    expect(preview.headers.get("content-security-policy")).not.toContain("18548/rpc");
    expect((await client.request("/preview/Alice_Bob/ENFP.svg")).status).toBe(200);
    await client.prove();
    const mint = await client.request("/api/assessments", { method: "POST", body: { handle: "alice" } });
    expect(mint.status).toBe(503);
    expect(mint.json.code).toBe("MINT_UNAVAILABLE");
    expect(test.assess).not.toHaveBeenCalled();
    expect(await test.store.entries("")).toEqual([]);
  });

  it("serves all 80 offline gallery fixtures and their minted views without assessment, chain, or durable operations", async () => {
    const test = await fixture({ offline: true }); const client = test.client();
    const gallery = vi.spyOn(test.service, "gallery");
    const state = vi.spyOn(test.service, "state");
    const artifact = vi.spyOn(test.service, "artifact");
    const request = vi.spyOn(test.service, "request");
    const authorize = vi.spyOn(test.service, "authorize");
    const sign = vi.spyOn(test.network, "sign");
    const put = vi.spyOn(test.store, "put");
    const home = await client.request("/");
    expect(home.status).toBe(200);
    expect(home.text.match(/class="gallery-item"/g)).toHaveLength(80);
    expectArtworkCaptionPolicy(home.text, 80, 80);
    expect([...home.text.matchAll(/class="gallery-card" href="([^"]+)"/g)].map(match => match[1])).toEqual(OPEN_MINT_GALLERY_FIXTURES.map(entry => entry.url));
    expectProductionPresentation(home.text);
    expect(home.text).not.toContain("No signatures minted yet.");
    expect(home.text).toContain('href="/signatures/');
    expect(new Set(OPEN_MINT_GALLERY_FIXTURES.map(entry => entry.mbti))).toEqual(new Set(MBTI_TYPES));
    for (const entry of OPEN_MINT_GALLERY_FIXTURES) {
      expect(home.text).toContain(`src="${entry.imageUrl}"`);
      expect(entry.imageUrl).toBe(`/preview/${entry.renderHandle}/${entry.mbti}.svg?renderer=sg-renderer-2.0.0`);
      const svg = await client.request(entry.imageUrl);
      expect(svg.status).toBe(200);
      expect(svg.headers.get("content-type")).toBe("image/svg+xml");
      expect(svg.headers.get("set-cookie")).toBeNull();
      expect(svg.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(svg.text).toBe(renderSignatureSvg(entry.renderHandle, entry.mbti));
      const detail = await client.request(entry.url);
      expect(detail.status).toBe(200);
      expect(detail.text).toContain('class="signature-page" data-mint-state="minted"');
      expect(detail.text).toContain("data-mint-state-label>Minted</a>");
      expectArtworkCaptionPolicy(detail.text, 1, 1);
      expect(detail.text).toContain(`<title>@${entry.renderHandle} × ${entry.mbti} · Signatures Gallery</title>`);
      expect(detail.text).toContain(`@${entry.renderHandle}`);
      expect(detail.text).toContain(`src="${entry.imageUrl}"`);
      expect(detail.text).toContain(`href="${entry.imageUrl}"`);
      expect(detail.text).toContain('class="signature-provenance"');
      expect(detail.text).toContain("sg-renderer-2.0.0");
      expectProductionPresentation(detail.text);
      expect(detail.text).not.toContain("The backend asked Grok to research public X posts");
      expect(detail.text).not.toMatch(/<dt>(Assessment|Spelling verified at preparation)<\/dt>/);
      expect(detail.text).not.toMatch(/data-assessment-request|data-assessment-code|data-mint-form|data-connect-wallet|data-dev-wallet|data-dev-mint|<dt>(?:Token|Transaction|Wallet)<\/dt>|View token/);
      const alternateCase = await client.request(`/signatures/${entry.handle.toUpperCase()}`, { followRedirects: false });
      expect(alternateCase.status).toBe(303);
      expect(alternateCase.headers.get("location")).toBe(entry.url);
      expect(alternateCase.text).toBe("");
    }
    for (const operation of [gallery, state, artifact, request, authorize, test.assess, test.network.state, sign, put]) expect(operation).not.toHaveBeenCalled();
    expect(await test.store.entries("")).toEqual([]);
  });

  it("rejects unknown and malformed gallery fixture paths without consulting mint state", async () => {
    const test = await fixture({ offline: true }); const client = test.client();
    const artifact = vi.spyOn(test.service, "artifact");
    const state = vi.spyOn(test.service, "state");
    const entry = OPEN_MINT_GALLERY_FIXTURES[0]!;
    for (const path of ["/dev/gallery/", "/dev/gallery/not_a_fixture", `/dev/gallery/@${entry.handle}`, `/dev/gallery/%40${entry.handle}`, "/dev/gallery/invalid-handle", `/dev/gallery/${"a".repeat(16)}`, `/dev/gallery/${entry.handle}/extra`, `/dev/gallery/${entry.handle}%2Fextra`, "/dev/gallery/%3Cscript%3E"]) {
      const response = await client.request(path);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('data-mint-state="minted"');
    }
    expect(artifact).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
    expect(await test.store.entries("")).toEqual([]);
  });

  it("redirects legacy sample URLs to canonical product URLs without exposing data or permitting writes", async () => {
    const test = await fixture({ offline: true }); const client = test.client();
    const artifact = vi.spyOn(test.service, "artifact");
    const state = vi.spyOn(test.service, "state");
    const put = vi.spyOn(test.store, "put");
    for (const entry of OPEN_MINT_GALLERY_FIXTURES) {
      for (const spelling of [entry.handle, entry.renderHandle, entry.handle.toUpperCase()]) {
        const redirect = await client.request(`/dev/gallery/${spelling}?returnTo=https://example.invalid`, { followRedirects: false });
        expect(redirect.status).toBe(303);
        expect(redirect.headers.get("location")).toBe(`/signatures/${entry.handle}`);
        expect(redirect.headers.get("cache-control")).toBe("no-store");
        expect(redirect.text).toBe("");
      }
    }
    const followed = await client.request("/dev/gallery/TYLERXHOBBS");
    expect(followed.status).toBe(200);
    expect(followed.text).toContain("@tylerxhobbs");
    expectProductionPresentation(followed.text);
    await client.init();
    for (const path of ["/dev/gallery/tylerxhobbs", "/signatures/tylerxhobbs"]) {
      const response = await client.request(path, { method: "POST", body: {}, followRedirects: false });
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
    }
    for (const operation of [artifact, state, put, test.assess, test.network.state]) expect(operation).not.toHaveBeenCalled();
    expect(await test.store.entries("")).toEqual([]);
  });

  it("rejects unknown or malformed sample product URLs without creating a mint", async () => {
    const test = await fixture({ offline: true }); const client = test.client();
    const put = vi.spyOn(test.store, "put");
    for (const path of ["/signatures/", "/signatures/not_a_fixture", "/signatures/@grok", "/signatures/%40grok", "/signatures/grok/extra", "/signatures/grok%2Fextra", "/signatures/invalid-handle", `/signatures/${"a".repeat(16)}`, "/signatures/%3Cscript%3E"]) {
      const response = await client.request(path, { followRedirects: false });
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(response.text).not.toContain('data-mint-state="minted"');
      expectProductionPresentation(response.text);
    }
    for (const operation of [put, test.assess, test.network.state]) expect(operation).not.toHaveBeenCalled();
    expect(await test.store.entries("")).toEqual([]);
  });

  it("serves all 16 MBTI galleries using only matching offline fixtures and their original images", async () => {
    const test = await fixture({ offline: true }); const client = test.client();
    const gallery = vi.spyOn(test.service, "gallery");
    const request = vi.spyOn(test.service, "request");
    const authorize = vi.spyOn(test.service, "authorize");
    const sign = vi.spyOn(test.network, "sign");
    const put = vi.spyOn(test.store, "put");
    for (const mbti of MBTI_TYPES) {
      const entries = OPEN_MINT_GALLERY_FIXTURES.filter(candidate => candidate.mbti === mbti);
      expect(entries, mbti).toHaveLength(5);
      const page = await client.request(`/${mbti}/`, { followRedirects: false });
      expect(page.status, mbti).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(page.headers.get("location")).toBeNull();
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self';");
      expect(page.headers.get("content-security-policy")).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
      expect(page.headers.get("referrer-policy")).toBe("no-referrer");
      expect(page.text.match(/class="gallery-item"/g)).toHaveLength(5);
      expect([...page.text.matchAll(/class="gallery-card" href="([^"]+)"/g)].map(match => match[1])).toEqual(entries.map(entry => entry.url));
      for (const entry of entries) expect(page.text).toContain(`src="${entry.imageUrl}"`);
      expect(page.text).toContain(`href="/${mbti}/"`);
      expectProductionPresentation(page.text);
      expect(page.text).toContain('href="/signatures/');
      for (const other of OPEN_MINT_GALLERY_FIXTURES.filter(candidate => candidate.mbti !== mbti)) {
        expect(page.text).not.toContain(`href="${other.url}"`);
        expect(page.text).not.toContain(`src="${other.imageUrl}"`);
      }
    }
    for (const operation of [gallery, request, authorize, test.assess, test.network.state, sign, put]) expect(operation).not.toHaveBeenCalled();
    expect(await test.store.entries("")).toEqual([]);
  });

  it("canonicalizes MBTI gallery paths and rejects invalid types and non-GET browsing", async () => {
    const test = await fixture({ offline: true }); const client = test.client();
    const gallery = vi.spyOn(test.service, "gallery");
    const request = vi.spyOn(test.service, "request");
    const authorize = vi.spyOn(test.service, "authorize");
    const put = vi.spyOn(test.store, "put");
    for (const mbti of MBTI_TYPES) {
      for (const path of [`/${mbti}`, `/${mbti.toLowerCase()}`, `/${mbti.toLowerCase()}/`, `/${mbti[0]}${mbti.slice(1).toLowerCase()}/`]) {
        const response = await client.request(path, { followRedirects: false });
        expect(response.status, path).toBe(303);
        expect(response.headers.get("location"), path).toBe(`/${mbti}/`);
        expect(response.text).toBe("");
      }
    }
    for (const path of ["/INXX/", "/XXXX", "/IST/", "/ISTJJ/", "/ISTJ/extra", "/ISTJ//", "/ISTJ%2Fextra/", "/%3Cscript%3E/"]) {
      const response = await client.request(path, { followRedirects: false });
      expect(response.status, path).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(response.text).not.toContain('class="gallery-item"');
    }
    await client.init();
    for (const path of ["/ISTJ/", "/istj"]) {
      const response = await client.request(path, { method: "POST", body: {}, followRedirects: false });
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
    }
    expect((await client.request("/ISTJ/", { method: "HEAD" })).status).toBe(405);
    for (const operation of [gallery, request, authorize, test.assess, test.network.state, put]) expect(operation).not.toHaveBeenCalled();
  });

  it("filters chain-confirmed works by stored MBTI without exposing unminted or pending artwork or creating new work", async () => {
    const test = await fixture(); const owner = test.client(); await owner.init();
    const provider = new DevelopmentAssessmentProvider();
    test.assess.mockImplementation(async handle => ({ ...await provider.assess(handle), mbti: handle === "other_type" ? "ENFP" : "ISTJ" }));
    for (const handle of ["matching", "other_type", "unminted", "pending"]) await owner.assess(handle);
    await test.mint("matching");
    await test.mint("other_type");
    await test.mint("pending", "pending");
    const matching = (await test.service.artifact("matching"))!;
    const other = (await test.service.artifact("other_type"))!;
    const unminted = (await test.service.artifact("unminted"))!;
    const pending = (await test.service.artifact("pending"))!;
    const storedBefore = await test.store.entries("");
    const request = vi.spyOn(test.service, "request");
    const authorize = vi.spyOn(test.service, "authorize");
    const sign = vi.spyOn(test.network, "sign");
    const put = vi.spyOn(test.store, "put");
    test.assess.mockClear();
    const visitor = test.client();
    for (const [mbti, artifact] of [["ISTJ", matching], ["ENFP", other]] as const) {
      const page = await visitor.request(`/${mbti}/`);
      expect(page.status).toBe(200);
      expect(page.text.match(/class="gallery-item"/g)).toHaveLength(1);
      expect([...page.text.matchAll(/class="gallery-card" href="([^"]+)"/g)].map(match => match[1])).toEqual([`/signatures/${artifact.assessment.handle}`]);
      expect(page.text).toContain(`src="/artifacts/${artifact.pngSha256}.png"`);
      expect(page.text).not.toContain("/dev/gallery/");
      expect(page.text).not.toContain("/preview/");
      expectProductionPresentation(page.text);
      for (const excluded of [matching, other, unminted, pending].filter(candidate => candidate !== artifact)) {
        expect(page.text).not.toContain(`href="/signatures/${excluded.assessment.handle}"`);
        expect(page.text).not.toContain(`src="/artifacts/${excluded.pngSha256}.png"`);
      }
      const image = await visitor.request(`/artifacts/${artifact.pngSha256}.png`);
      expect(image.status).toBe(200);
      expect(sha256Hex(image.bytes)).toBe(artifact.pngSha256);
    }
    const empty = await visitor.request("/INTP/");
    expect(empty.status).toBe(200);
    expect(empty.text).not.toContain('class="gallery-item"');
    expect(empty.text).not.toContain("/dev/gallery/");
    expect(empty.text).not.toContain("/preview/");
    for (const operation of [request, authorize, test.assess, sign, put]) expect(operation).not.toHaveBeenCalled();
    expect(await test.store.entries("")).toEqual(storedBefore);
  });

  it.each([
    { fixture: false, offline: true },
    { fixture: false, offline: false },
    { fixture: true, offline: false },
  ])("disables gallery fixtures outside offline fixture mode ($fixture / offline $offline)", async options => {
    const test = await fixture(options); const client = test.client();
    const put = vi.spyOn(test.store, "put");
    const home = await client.request("/");
    expect(home.status).toBe(200);
    expect(home.text).toContain("No signatures minted yet.");
    expect(home.text).not.toContain('class="gallery-item"');
    expect(home.text).not.toContain("/dev/gallery/");
    expectProductionPresentation(home.text);
    for (const mbti of MBTI_TYPES) {
      const page = await client.request(`/${mbti}/`);
      expect(page.status).toBe(200);
      expect(page.text).not.toContain('class="gallery-item"');
      expect(page.text).not.toContain("/dev/gallery/");
      expectProductionPresentation(page.text);
    }
    for (const entry of OPEN_MINT_GALLERY_FIXTURES) {
      for (const path of [entry.url, `/dev/gallery/${entry.handle}`]) {
        const response = await client.request(path, { followRedirects: false });
        expect(response.status).toBe(404);
        expect(response.headers.get("location")).toBeNull();
        expect(response.text).not.toContain('data-mint-state="minted"');
        expectProductionPresentation(response.text);
      }
    }
    expect(test.assess).not.toHaveBeenCalled();
    expect(test.network.state).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps gallery fixtures out of wallet collections and stored mint state despite their product-style URLs", async () => {
    const test = await fixture({ offline: true }); const client = test.client();
    const put = vi.spyOn(test.store, "put");
    const sign = vi.spyOn(test.network, "sign");
    await client.init();
    expect((await client.request("/")).text.match(/class="gallery-item"/g)).toHaveLength(80);
    const signedOut = await client.request("/me");
    expect(signedOut.text).toContain("Your collection follows your wallet.");
    expect(signedOut.text).not.toContain('class="gallery-item"');
    expect((await client.prove()).result.status).toBe(200);
    const collection = await client.request("/me");
    expect(collection.status).toBe(200);
    expect(collection.text).toContain(wallet.address);
    expect(collection.text).toContain("This wallet has no minted signatures yet.");
    expect(collection.text).not.toContain('class="gallery-item"');
    expect(collection.text).not.toContain("/dev/gallery/");
    expectProductionPresentation(collection.text);
    for (const entry of OPEN_MINT_GALLERY_FIXTURES) {
      expect((await client.request(`/signatures/${entry.handle}`)).status).toBe(200);
      expect(await test.service.artifact(entry.handle)).toBeUndefined();
      expect(await test.service.state(entry.handle)).toEqual({ state: "unminted" });
    }
    expect(await test.service.gallery()).toEqual([]);
    expect(await test.service.gallery(wallet.address)).toEqual([]);
    expect(test.assess).not.toHaveBeenCalled();
    expect(test.network.state).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await test.store.entries("")).toEqual([]);
  });

  it("never shadows a chain-confirmed work with a catalog sample sharing its handle", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const entry = OPEN_MINT_GALLERY_FIXTURES.find(candidate => candidate.handle === "tylerxhobbs")!;
    await client.assess("TYLERXHOBBS");
    expect((await client.request(entry.url)).status).toBe(404);
    await test.mint(entry.handle);
    const artifact = (await test.service.artifact(entry.handle))!;
    test.assess.mockClear();
    const put = vi.spyOn(test.store, "put");
    const response = await client.request(entry.url);
    expect(response.status).toBe(200);
    expect(response.text).toContain("@TYLERXHOBBS");
    expect(response.text).toContain(`src="/artifacts/${artifact.svgSha256}.svg"`);
    expect(response.text).not.toContain(entry.imageUrl);
    expect(response.text).toContain("<dt>Token</dt>");
    expectProductionPresentation(response.text);
    const legacy = await client.request(`/dev/gallery/${entry.handle}`, { followRedirects: false });
    expect(legacy.status).toBe(404);
    expect(legacy.headers.get("location")).toBeNull();
    expect(test.assess).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("enforces the JSON byte limit before endpoint processing and accepts a charset parameter", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const request = vi.spyOn(test.service, "request");
    const atLimit = JSON.stringify({ handle: "alice" }).padEnd(8192, " ");
    const accepted = await client.request("/api/unknown", { method: "POST", rawBody: atLimit, headers: { "Content-Type": "application/json; charset=utf-8" } });
    expect(accepted.status).toBe(404);
    expect(accepted.json.code).toBe("NOT_FOUND");
    for (const rawBody of [atLimit + " ", JSON.stringify({ handle: "é".repeat(4096) })]) {
      const response = await client.request("/api/assessments", { method: "POST", rawBody });
      expect(response.status).toBe(413);
      expect(response.json).toEqual({ error: "Request is too large.", code: "REQUEST_TOO_LARGE" });
    }
    const empty = await client.request("/api/assessments", { method: "POST", rawBody: "" });
    expect(empty.status).toBe(400);
    expect(empty.json.code).toBe("INVALID_JSON");
    expect(request).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("rate-limits authenticated mutations, not reads, and allows the next window", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const initialTime = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(initialTime);
    for (let i = 0; i < 60; i++) {
      expect((await client.request("/api/unknown", { method: "POST", body: {} })).status).toBe(404);
    }
    const blocked = await client.request("/api/assessments", { method: "POST", body: { handle: "alice" } });
    expect(blocked.status).toBe(429);
    expect(blocked.json.code).toBe("RATE_LIMIT");
    expect((await client.request("/api/session")).status).toBe(200);
    expect((await client.request("/p/alice/ENFP")).status).toBe(200);
    clock.mockReturnValue(initialTime + 60_001);
    expect((await client.request("/api/unknown", { method: "POST", body: {} })).status).toBe(404);
    expect(test.assess).not.toHaveBeenCalled();
    expect(await test.store.entries("")).toEqual([]);
  });

  it("rejects extra fields consistently across wallet, mint, and logout mutations", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const calls = [vi.spyOn(test.sessions, "challenge"), vi.spyOn(test.sessions, "verify"), vi.spyOn(test.sessions, "logout"),
      vi.spyOn(test.service, "authorize"), vi.spyOn(test.service, "report")];
    for (const [path, payload] of [
      ["/api/wallet/challenge", { address: wallet.address }],
      ["/api/wallet/verify", { challengeId: "challenge", signature: "0x1234" }],
      ["/api/mints/authorize", { code: "a".repeat(43), consent: true }],
      ["/api/mints/report", { code: "a".repeat(43), transactionHash: `0x${"a".repeat(64)}` }],
      ["/api/session/logout", {}],
    ] as const) {
      const response = await client.request(path, { method: "POST", body: { ...payload, mbti: "INTJ" } });
      expect(response.status, path).toBe(400);
      expect(response.json.code, path).toBe("INVALID_FIELDS");
    }
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("guards explicitly enabled development hooks with CSRF, exact fields, and request ownership", async () => {
    const devWallet = vi.fn<NonNullable<OpenMintServerOptions["devWallet"]>>(async () => wallet.address);
    const devMint = vi.fn<NonNullable<OpenMintServerOptions["devMint"]>>(async () => ({ transactionHash: `0x${"d".repeat(64)}` }));
    const test = await fixture({ devWallet, devMint });
    const owner = test.client(); const visitor = test.client(); await owner.init(); await visitor.init();
    const { code } = await owner.assess("alice");
    expect((await owner.request("/api/dev/wallet", { method: "POST", body: {} })).json.wallet).toBe(wallet.address);
    expect(devWallet.mock.calls[0]![1]).toBeUndefined();
    expect((await owner.request("/api/dev/wallet", { method: "POST", body: { code } })).status).toBe(200);
    expect(devWallet.mock.calls[1]![1]).toBe(code);
    expect((await owner.request("/api/dev/mint", { method: "POST", body: { code, consent: true } })).json.transactionHash).toBe(`0x${"d".repeat(64)}`);
    expect(devMint).toHaveBeenCalledWith(test.sessions.session(owner.cookie).session, code, true);
    for (const [path, payload] of [["/api/dev/wallet", { code }], ["/api/dev/mint", { code, consent: true }]] as const) {
      expect((await visitor.request(path, { method: "POST", body: payload })).status).toBe(403);
      expect((await owner.request(path, { method: "POST", body: payload, skipCsrf: true })).status).toBe(403);
      expect((await owner.request(path, { method: "POST", body: { ...payload, mbti: "INTJ" } })).status).toBe(400);
    }
    expect(devWallet).toHaveBeenCalledTimes(2);
    expect(devMint).toHaveBeenCalledTimes(1);
    expectProductionPresentation((await owner.request("/mint")).text);
    expect(await test.store.entries("issuance:")).toEqual([]);
  });

  it("treats a reported transaction hash as a private hint, never as mint confirmation", async () => {
    const test = await fixture(); const owner = test.client(); const visitor = test.client(); await owner.init(); await visitor.init();
    const { code } = await owner.assess("alice");
    const transactionHash = `0x${"AB".repeat(32)}`;
    const report = (client: typeof owner, hash: string) => client.request("/api/mints/report", { method: "POST", body: { code, transactionHash: hash } });
    expect((await report(visitor, transactionHash)).status).toBe(403);
    const invalid = await report(owner, "0x1234");
    expect(invalid.status).toBe(400);
    expect(invalid.json.code).toBe("INVALID_TRANSACTION");
    expect(await test.store.entries("hint:")).toEqual([]);
    const result = await report(owner, transactionHash);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ ok: true });
    expect(await test.store.get(`hint:${code}`)).toEqual({ transactionHash: transactionHash.toLowerCase() });
    expect((await owner.request(`/api/mints/status/${code}`)).json).toEqual({ state: "unminted" });
    expect((await owner.request(`/api/assessments/${code}`)).json).not.toHaveProperty("mbti");
    expect((await owner.request("/signatures/alice")).status).toBe(404);
    expect((await owner.request("/")).text).not.toContain("/signatures/alice");
    expect(await test.store.entries("issuance:")).toEqual([]);
  });

  it.each([["png", "image/png"], ["json", "application/json"]] as const)("serves exact minted %s bytes with immutable but session-free responses", async (extension, type) => {
    const test = await fixture(); const owner = test.client(); await owner.init();
    await owner.assess("alice"); await test.mint("alice");
    const artifact = (await test.service.artifact("alice"))!;
    const visitor = test.client();
    const hash = extension === "png" ? artifact.pngSha256 : artifact.metadataSha256;
    const response = await visitor.request(`/artifacts/${hash}.${extension}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(type);
    expect(sha256Hex(response.bytes)).toBe(hash);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    if (extension === "png") expect(response.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    else expect(response.json).toHaveProperty("image");
  });

  it("links the self-hosted preload and session-free immutable favicon/font without assessment setup", async () => {
    const test = await fixture({ offline: true }); const owner = test.client(); const visitor = test.client();
    const home = await owner.request("/");
    const icon = home.text.match(/<link rel="icon"[^>]*href="([^"]+)"/)![1]!;
    const font = home.text.match(/<link rel="preload"[^>]*href="([^"]+)"/)![1]!;
    expect(home.text).toContain(SITE_FONT_PRELOAD);
    expect(font).toMatch(/\/playpen-sans-latin-wght-normal\.woff2$/);
    for (const [path, type] of [[icon, "image/svg+xml"], [font, "font/woff2"]]) {
      const response = await visitor.request(path!);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toContain("immutable");
      expect(response.bytes.length).toBeGreaterThan(0);
    }
    expect(SELF_HOSTED_FONT_PATHS).toHaveLength(16);
    expect(test.assess).not.toHaveBeenCalled();
  });

  // Each subset retains its exact Buffer equality and immutable/session-free
  // checks, with an independent five-second test budget and no artwork work.
  it.each(SELF_HOSTED_FONT_PATHS)("serves exact immutable session-free font bytes: %s", async path => {
    const test = await fixture({ offline: true }); const visitor = test.client();
    const response = await visitor.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("font/woff2");
    expect(response.bytes).toEqual(siteFontAsset(path)!.bytes);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("serves the Playpen Sans license without assessment or session creation", async () => {
    const test = await fixture({ offline: true }); const visitor = test.client();
    const response = await visitor.request(SELF_HOSTED_FONT_LICENSE_PATH);
    expect(response.status).toBe(200);
    expect(response.text).toContain("Copyright 2023 The Playpen Sans Project Authors");
    expect(response.bytes).toEqual(siteFontAsset(SELF_HOSTED_FONT_LICENSE_PATH)!.bytes);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(test.assess).not.toHaveBeenCalled();
  });

  it.each(["/assets/fonts/private.woff2", "/assets/fonts/playpen-sans-5.3.0/playpen-sans-latin-wght-italic.woff2", "/assets/fonts/instrument-sans-5.3.0/instrument-sans-latin-wght-normal.woff2"])("refuses unlisted font assets without caching: %s", async path => {
    const test = await fixture({ offline: true }); const visitor = test.client();
    const missing = await visitor.request(path);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses absent or mismatched artwork hashes without caching", async () => {
    const test = await fixture(); const owner = test.client(); await owner.init();
    await owner.assess("alice"); await test.mint("alice");
    const artifact = (await test.service.artifact("alice"))!; const visitor = test.client();
    for (const path of [`/artifacts/${"0".repeat(64)}.png`, `/artifacts/${artifact.pngSha256}.svg`]) {
      const missing = await visitor.request(path);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("redacts unexpected provider, storage, and service errors in JSON and HTML responses", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const secret = "private-api-key-and-provider-response";
    vi.spyOn(test.service, "walletContext").mockRejectedValue(new Error(secret));
    vi.spyOn(test.service, "gallery").mockRejectedValue(new Error(secret));
    vi.spyOn(test.service, "asset").mockRejectedValue(new Error(secret));
    for (const path of ["/api/wallet/context", "/", `/artifacts/${"a".repeat(64)}.png`]) {
      const response = await client.request(path);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.text).toContain("This operation is temporarily unavailable. Please try again shortly.");
      expect(response.text).not.toContain(secret);
      expect(response.text).not.toContain("Error:");
      if (path.startsWith("/api/")) expect(response.json.code).toBe("SERVICE_UNAVAILABLE");
    }
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("returns only safe reservation metadata and diagnostic references on API errors", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const details = { reference: "d63d39b6-fb45-45aa-bc27-914d4801cfd3", reservedUntil: "2026-09-19T10:00:00.000Z", category: "reservation" as const };
    const context = vi.spyOn(test.service, "walletContext").mockRejectedValue(new PublicError(409, "MINT_RESERVED", "Reserved until the current authorization expires.", { ...details, privateCode: "never-reflect-this" } as never));
    const response = await client.request("/api/wallet/context");
    expect(response.status).toBe(409);
    expect(response.json).toEqual({ code: "MINT_RESERVED", error: "Reserved until the current authorization expires.", ...details });
    expect(response.headers.get("cache-control")).toBe("no-store");
    context.mockRejectedValue(new PublicError(503, "ASSESSMENT_BLOCKED", "Operator review required.", { reference: "private-capability-code", reservedUntil: "tomorrow", category: "private-body" } as never));
    expect((await client.request("/api/wallet/context")).json).toEqual({ code: "ASSESSMENT_BLOCKED", error: "Operator review required." });
  });

  it("projects an abstention with an owner-only diagnostic reference, without revealing a prepared result", async () => {
    const test = await fixture(); const owner = test.client(); await owner.init();
    const { code } = await owner.assess("alice");
    const request = (await test.store.get<SignatureRequest>(`request:${code}`))!;
    const reference = "d63d39b6-fb45-45aa-bc27-914d4801cfd3";
    await test.store.put(`request:${code}`, { ...request, status: "failed", attemptId: reference, errorCategory: "assessment-abstained", error: "Not enough public evidence." });
    const result = await owner.request(`/api/assessments/${code}`);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ status: "abstained", errorCategory: "assessment-abstained", diagnosticReference: reference, canMint: false });
    for (const field of ["mbti", "imageUrl", "svgUrl", "assessedAt", "providerResponseId"]) expect(result.json).not.toHaveProperty(field);
    const stranger = await test.client().request(`/api/assessments/${code}`);
    expect(stranger.status).toBe(403);
    expect(stranger.text).not.toContain(reference);
    expect((await owner.request(`/mint/${code}`)).text).not.toContain("Request help");
  });

  it("passes a configured HTTPS support destination unchanged to private failure pages", async () => {
    const supportUrl = "https://help.example.test/request?source=mint";
    const test = await fixture({ supportUrl }); const owner = test.client(); await owner.init();
    const { code } = await owner.assess("alice");
    const request = (await test.store.get<SignatureRequest>(`request:${code}`))!;
    const reference = "d63d39b6-fb45-45aa-bc27-914d4801cfd3";
    await test.store.put(`request:${code}`, { ...request, status: "failed", attemptId: reference, errorCategory: "assessment-blocked" });
    const page = await owner.request(`/mint/${code}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.text).toContain(`href="${supportUrl}"`);
    expect(page.text).toContain(`Reference: ${reference}.`);
    const link = /<a[^>]+href="https:\/\/help\.example\.test[^>]+>.*?<\/a>/.exec(page.text)?.[0];
    expect(link).toContain("Request help");
    expect(link).not.toContain(code);
    expect(link).not.toContain(reference);
  });

  it.each(["javascript:alert(1)", "http://help.example.test", "https://user:secret@example.test"])("refuses unsafe server support configuration: %s", async supportUrl => {
    await expect(fixture({ supportUrl })).rejects.toThrow("HTTPS URL without credentials");
  });

  it("permanently redirects valid old preview links to /p/ without chain reads or assessment work", async () => {
    const test = await fixture(); const client = test.client();
    const state = vi.spyOn(test.service, "state");
    const stored = await test.store.entries("");
    for (const suffix of ["variations", ...MBTI_TYPES]) {
      const old = `/s/%40Alice_Bob_Key/${suffix === "variations" ? suffix : suffix.toLowerCase()}`;
      const response = await client.request(old, { followRedirects: false });
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe(`/p/Alice_Bob_Key/${suffix}`);
      expect(response.text).toBe("");
    }
    const bare = await client.request('/s/Alice_Bob_Key', { followRedirects: false });
    expect(bare.status).toBe(308);
    expect(bare.headers.get('location')).toBe('/p/Alice_Bob_Key');
    expect(state).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
    expect(await test.store.entries("")).toEqual(stored);
    expect((await client.request('/s/Alice_Bob_Key')).text).toContain('data-mint-entry');
    for (const suffix of ['variations', 'ENFP']) {
      const legacy = await client.request(`/s/Alice_Bob_Key/${suffix}`);
      const canonical = await client.request(`/p/Alice_Bob_Key/${suffix}`);
      expect(legacy.status).toBe(200);
      expect(legacy.text).toBe(canonical.text);
      expect(legacy.text).not.toContain('href="/s/');
    }
  });

  it("validates legacy aliases before redirecting and never turns malformed previews into mint requests", async () => {
    const test = await fixture(); const client = test.client();
    const state = vi.spyOn(test.service, 'state');
    for (const namespace of ['s', 'p']) {
      for (const tail of ['invalid%2Fhandle/ENFP', '%3Cscript%3E/variations', '%/ENFP', 'alice/INXX', 'alice/37', 'alice/variations/ENFP', `${'a'.repeat(16)}/INTJ`]) {
        const result = await client.request(`/${namespace}/${tail}`, { followRedirects: false });
        expect(result.status).toBe(404);
        expect(result.headers.get('location')).toBeNull();
      }
    }
    expect(state).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("preserves saved mint spelling, assets and status after following a legacy preview redirect", async () => {
    const test = await fixture(); const owner = test.client(); await owner.init();
    await owner.assess('Alice_Bob_Key'); await test.mint('alice_bob_key');
    const stored = await test.store.entries('');
    const visitor = test.client();
    for (const suffix of ['variations', ...MBTI_TYPES]) {
      const response = await visitor.request(`/s/ALICE_BOB_KEY/${suffix}`);
      const current = await visitor.request(`/p/Alice_Bob_Key/${suffix}`);
      expect(response.status).toBe(200);
      expect(response.text).toBe(current.text);
      expect(response.text).toContain('data-preview-mint-state="minted"');
      expectHandleNavigation(response.text, 'Alice_Bob_Key');
      expect(response.text).not.toContain('href="/s/');
    }
    expect(await test.store.entries('')).toEqual(stored);
    expect(test.assess).toHaveBeenCalledTimes(1);
  });

  it("returns canonical redirects without converting case-preserved preview handles into new identities", async () => {
    const test = await fixture(); const client = test.client();
    for (const [path, target] of [
      ["/p/%40Alice_Bob", "/mint?handle=Alice_Bob"],
      ["/p/%41lice_Bob/variations", "/p/Alice_Bob/variations"],
      ["/p/%40Alice_Bob/enfp", "/p/Alice_Bob/ENFP"],
    ]) {
      const response = await client.request(path!, { followRedirects: false });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(target);
      expect(response.text).toBe("");
    }
    await client.init();
    const { url } = await client.assess("Alice_Bob"); await test.mint("alice_bob");
    const minted = await client.request(url, { followRedirects: false });
    expect(minted.status).toBe(303);
    expect(minted.headers.get("location")).toBe("/signatures/alice_bob");
    expect(minted.text).toBe("");
    for (const path of ["/mint?handle=%3Cscript%3E", "/mint?handle=", "/mint?handle=invalid%2Fhandle"]) {
      expect((await client.request(path)).status).toBe(400);
    }
    for (const path of ["/signatures/nobody", `/mint/${"z".repeat(43)}`, `/api/assessments/${"z".repeat(43)}`]) {
      expect((await client.request(path)).status).toBe(404);
    }
  });

  it("keeps expired progress readable but requires a fresh window for minting", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const { code, url } = await client.assess("alice");
    await client.prove(code);
    expect((await client.request("/api/session")).json).toMatchObject({ wallet: wallet.address, walletVerified: false });
    const request = (await test.store.get<SignatureRequest>(`request:${code}`))!;
    await test.store.put(`request:${code}`, { ...request, createdAt: request.createdAt - 900_001, expiresAt: request.expiresAt - 900_001 });
    const progress = await client.request(`/api/assessments/${code}`);
    expect(progress.status).toBe(200);
    expect(progress.json).toMatchObject({ requestExpired: true, canMint: false });
    expect(progress.json.requestExpiresAt).toBe(request.expiresAt - 900_001);
    expect(progress.json.serverNow).toBeGreaterThan(progress.json.requestExpiresAt);
    expect(progress.json).not.toHaveProperty("mbti");
    const expiredPage = await client.request(url);
    expect(expiredPage.status).toBe(200);
    expect(expiredPage.text).toContain('data-request-expired="true"');
    expect(expiredPage.text).toContain('href="/mint?handle=alice"><span>Return to mint');
    const authorize = await client.request("/api/mints/authorize", { method: "POST", body: { code, consent: true } });
    expect(authorize.status).toBe(410);
    expect(authorize.json.code).toBe("REQUEST_EXPIRED");
    expect(await test.store.entries("issuance:")).toEqual([]);
    await client.prove();
    expect((await client.request("/api/session")).json.walletVerified).toBe(true);
    expect(test.assess).toHaveBeenCalledTimes(1);
  });

  it("publishes request and proof deadlines without exposing an unminted result", async () => {
    const time = Date.now();
    const test = await fixture({ now: () => time }); const client = test.client(); await client.init();
    const { code, url } = await client.assess("Alice_Bob");
    const request = (await test.store.get<SignatureRequest>(`request:${code}`))!;
    const session = await client.request('/api/session');
    expect(session.json).toMatchObject({ serverNow: time, walletProofExpiresAt: time + 600_000 });
    const status = await client.request(`/api/assessments/${code}`);
    expect(status.json).toMatchObject({ serverNow: time, requestExpiresAt: request.expiresAt, walletProofExpiresAt: time + 600_000, requestExpired: false });
    expect(status.json).not.toHaveProperty('mbti');
    expect(status.json).not.toHaveProperty('svgUrl');
    expect(status.json).not.toHaveProperty('walletProof');
    const page = await client.request(url);
    expect(page.text).toContain(`data-request-expires-at="${request.expiresAt}"`);
    expect(page.text).toContain(`data-server-now="${time}"`);
    expect(page.text).toContain('href="/mint?handle=Alice_Bob"><span>Return to mint');
    expect(test.assess).toHaveBeenCalledTimes(1);
  });

  it("continues canonical confirmation after request expiry without issuing fresh authority", async () => {
    let time = Date.now();
    const test = await fixture({ now: () => time }); const client = test.client(); await client.init();
    const { code, url } = await client.assess("Alice_Bob");
    await test.mint('Alice_Bob', 'pending');
    time += 900_001;
    const status = await client.request(`/api/assessments/${code}`);
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ requestExpired: true, canMint: false, mint: { state: 'pending' } });
    expect((await client.request(url)).text).toContain('Mint submitted. Waiting to reveal your signature…');
    expect((await client.request(`/api/mints/status/${code}`)).json.state).toBe('pending');
    await test.mint('Alice_Bob');
    expect((await client.request(`/api/mints/status/${code}`)).json.state).toBe('minted');
    expect(await test.store.entries('issuance:')).toEqual([]);
    expect(test.assess).toHaveBeenCalledTimes(1);
  });

  it("keeps a newly created request readable when the clock advances during preparation", async () => {
    let time = Date.now();
    const test = await fixture({ now: () => time++ }); const client = test.client(); await client.init();
    const { code, url } = await client.assess("Alice_Bob");
    const progress = await client.request(`/api/assessments/${code}`);
    expect(progress.status).toBe(200);
    expect(progress.json).toMatchObject({ handle: "alice_bob", renderHandle: "Alice_Bob", status: "ready", requestExpired: false, canMint: true });
    const request = (await test.store.get<SignatureRequest>(`request:${code}`))!;
    expect(request.expiresAt - request.createdAt).toBe(900_000);
    expect((await client.request(url)).status).toBe(200);
    expect(test.assess).toHaveBeenCalledTimes(1);
  });

  it("exposes a read-only exact-chain fingerprint and optional wallet nonce without signing or assessing", async () => {
    const test = await fixture(); const client = test.client();
    const context = await client.request("/api/wallet/context");
    expect(context.status).toBe(200);
    expect(context.headers.get("cache-control")).toBe("no-store");
    expect(context.json).toEqual({ chainId: "0x7a69", contract: wallet.address, blockNumber: "0xa", blockHash: `0x${"b".repeat(64)}` });
    const address = wallet.address.toLowerCase();
    expect((await client.request(`/api/wallet/context?address=${address}`)).json.nonce).toBe("0x1");
    expect(test.network.walletContext).toHaveBeenLastCalledWith(wallet.address);
    expect(test.assess).not.toHaveBeenCalled();
    expect(await test.store.entries("issuance:")).toEqual([]);
    for (const query of ["address=not-a-wallet", `address=${address}&address=${address}`, "rpcUrl=http://127.0.0.1:18545", `address=${address}&nonce=410`]) {
      expect((await client.request(`/api/wallet/context?${query}`)).status).toBe(400);
    }
    test.network.walletContext = undefined;
    expect((await client.request("/api/wallet/context")).status).toBe(503);
  });

  it("sets an HttpOnly session cookie and reads it consistently among other cookies", async () => {
    const test = await fixture(); const client = test.client();
    const initial = await client.init();
    expect(initial.status).toBe(200);
    expect(initial.headers.get("set-cookie")).toMatch(/^sg_open_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\//);
    expect(initial.json.wallet).toBeNull();
    expect(initial.json).not.toHaveProperty("id");
    expect(initial.json).not.toHaveProperty("challenge");
    const again = await client.request("/api/session", { headers: { Cookie: `other=example; ${client.cookie}; trailing=1` } });
    expect(again.json.csrfToken).toBe(initial.json.csrfToken);
    expect(again.headers.get("set-cookie")).toBeNull();
    const forged = await client.request("/api/session", { headers: { Cookie: `sg_open_session=${"a".repeat(43)}` } });
    expect(forged.json.csrfToken).not.toBe(initial.json.csrfToken);
  });

  it("requires matching Origin, session cookie, and CSRF for every state-changing request", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const invalidRequests: RequestOptions[] = [{ skipOrigin: true }, { skipCsrf: true }, { skipCookie: true }, { headers: { Origin: "https://attacker.example" } }, { headers: { "X-CSRF-Token": "forged" } }];
    for (const init of invalidRequests) {
      const result = await client.request("/api/assessments", { method: "POST", body: { handle: "alice" }, ...init });
      expect(result.status).toBe(403);
      expect(result.json.code).toBe("SESSION_REQUIRED");
      await client.init();
    }
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("rejects extra generation fields and malformed JSON without starting Grok", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    for (const body of [{ handle: "alice", mbti: "INTJ" }, { handle: "alice", gr0k: 42 }, { handle: "alice", signature: "forged" }, { handle: "alice", wallet: wallet.address }, {}, [], null]) {
      const response = await client.request("/api/assessments", { method: "POST", body });
      expect(response.status).toBe(400);
    }
    expect((await client.request("/api/assessments", { method: "POST", rawBody: "{" })).status).toBe(400);
    expect((await client.request("/api/assessments", { method: "POST", body: { handle: "alice" }, headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("exposes no legacy claim routes or development mutation endpoints by default", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    for (const path of ["/auth/x/start", "/api/v1/signatures", "/api/v2/wallet-bindings/challenge", "/api/dev/wallet", "/api/dev/mint"]) {
      const response = await client.request(path, { method: "POST", body: {} });
      expect(response.status).toBe(404);
    }
    for (const path of ["/api/assessments", "/api/wallet/challenge", "/api/wallet/verify", "/api/mints/authorize", "/api/mints/report", "/api/session/logout", "/api/dev/wallet", "/auth/x/start"]) expect((await client.request(path)).status).toBe(404);
    expect(test.assess).not.toHaveBeenCalled();
    expect((await client.request("/api/assessments", { method: "PUT", body: { handle: "alice" } })).status).toBe(405);
  });

  it("keeps mint progress private, wallet-bound, and unrevealed before confirmation", async () => {
    const test = await fixture(); const owner = test.client(); const visitor = test.client();
    await owner.init(); await visitor.init();
    const { url, code } = await owner.assess("@AGENT_ART");
    expect(url).toMatch(/^\/mint\/[A-Za-z0-9_-]{43}$/);
    const own = await owner.request(`/api/assessments/${code}`);
    expect(own.json).toMatchObject({ handle: "agent_art", renderHandle: "AGENT_ART", status: "ready", canMint: true, walletProvedForCode: true });
    expect(own.json).not.toHaveProperty("owner");
    expect(own.json).not.toHaveProperty("csrf");
    const shared = await visitor.request(`/api/assessments/${code}`);
    expect(shared.status).toBe(403);
    const view = await visitor.request(url);
    expect(view.status).toBe(403);
    expect(view.text).not.toContain("data-mint-form");
    expect((await visitor.request(`/api/mints/status/${code}`)).status).toBe(403);
    expect((await visitor.request(`/api/wallet/challenge`, { method: "POST", body: { code, address: wallet.address } })).status).toBe(403);
    for (const field of ["imageUrl", "svgUrl", "mbti", "svgSha256", "pngSha256", "assessedAt"]) expect(own.json).not.toHaveProperty(field);
    expect((await owner.request(url)).text).not.toContain("/artifacts/");
    expect((await owner.request("/signatures/agent_art")).status).toBe(404);
    expect((await visitor.assess("agent_art")).code).not.toBe(code);
    expect(test.assess).toHaveBeenCalledTimes(1);
    await test.mint("agent_art", "pending");
    expect((await owner.request(`/api/assessments/${code}`)).json).not.toHaveProperty("mbti");
    expect((await owner.request("/")).text).not.toContain('/signatures/agent_art');
    await test.mint("agent_art");
    const revealed = await owner.request(`/api/assessments/${code}`);
    expect(revealed.json.mbti).toBeDefined();
    expect((await owner.request(url)).text).toContain(revealed.json.svgUrl);
    expect((await owner.request("/")).text).toContain('/signatures/agent_art');
    expect((await owner.request("/me")).text).toContain('/signatures/agent_art');
  });

  it("projects recorded Grok evidence only after confirmation without changing immutable artwork or calling providers", async () => {
    const test = await recordedGrokFixture();
    await test.mint(test.assessment.handle);
    const artifact = (await test.service.artifact(test.assessment.handle))!;
    const storedBefore = JSON.stringify(await test.store.entries(""));
    const assessmentBefore = JSON.stringify(await test.repository.get(test.assessment.handle));
    const assets = await Promise.all(([ [artifact.svgSha256, "svg"], [artifact.pngSha256, "png"], [artifact.metadataSha256, "json"] ] as const)
      .map(async ([hash, extension]) => ({ hash, extension, bytes: await test.service.asset(hash, extension) })));
    const put = vi.spyOn(test.store, "put");
    const persist = vi.spyOn(test.repository, "putIfAbsent");
    const sign = vi.spyOn(test.network, "sign");
    const status = await test.owner.request(`/api/assessments/${test.code}`);
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({
      assessmentProvenance: "grok", assessmentModel: test.assessment.model,
      assessmentSourceUrls: test.assessment.sourceUrls, assessedAt: test.assessment.createdAt,
      verifiedXUserId: test.assessment.xIdentity!.userId, identityVerifiedAt: test.assessment.xIdentity!.verifiedAt,
      mbti: test.assessment.mbti, renderHandle: "Alice_Bob", rendererVersion: artifact.assessment.rendererVersion,
      svgSha256: artifact.svgSha256, pngSha256: artifact.pngSha256,
    });
    for (const field of ["sourceLabel", "providerResponseId", "receipt", "usage", "xIdentity"]) expect(status.json).not.toHaveProperty(field);
    expect(status.text).not.toContain(test.assessment.providerResponseId);
    for (const path of [test.url, "/signatures/alice_bob"]) {
      const page = await test.owner.request(path);
      expect(page.status).toBe(200);
      const provenance = page.text.match(/<details class="signature-provenance">([\s\S]*?)<\/details>/)?.[1];
      expect(provenance).toBeDefined();
      expect(provenance).toContain("Grok selected this MBTI from public X research.");
      expect(provenance).toContain("<dt>Assessor</dt><dd>Grok</dd>");
      expect(provenance).toContain(`<dt>Model</dt><dd>${test.assessment.model}</dd>`);
      expect(provenance).toContain(test.assessment.createdAt);
      expect(provenance).toContain("Spelling verified at preparation");
      expect(provenance).toContain(test.assessment.xIdentity!.verifiedAt);
      expect(provenance).toContain(`href="https://x.com/i/user/${test.assessment.xIdentity!.userId}"`);
      expect(provenance).toContain("data-assessment-sources");
      for (const source of test.assessment.sourceUrls) expect(provenance).toContain(`href="${source}"`);
      expect(page.text).not.toContain(test.assessment.providerResponseId);
      expect(page.text).not.toContain("grok-runtime-must-not-replace-recorded-model");
    }
    for (const { hash, extension, bytes } of assets) {
      const response = await test.owner.request(`/artifacts/${hash}.${extension}`);
      expect(response.status).toBe(200);
      expect(response.bytes).toEqual(bytes);
      expect(sha256Hex(response.bytes)).toBe(hash);
      // Historical metadata already embeds the immutable assessment, including its
      // response ID. E11 adds no ID to page/JSON projections and must not rewrite it.
      if (extension === "json") expect(response.json.assessment.providerResponseId).toBe(test.assessment.providerResponseId);
    }
    expect(JSON.stringify(await test.store.entries(""))).toBe(storedBefore);
    expect(JSON.stringify(await test.repository.get(test.assessment.handle))).toBe(assessmentBefore);
    for (const operation of [put, persist, sign, test.assess]) expect(operation).not.toHaveBeenCalled();
  });

  it.each(["ready", "preparing", "pending-mint", "failed"] as const)("does not reveal saved assessment evidence in %s JSON or HTML", async state => {
    const test = await recordedGrokFixture();
    const request = (await test.store.get<SignatureRequest>(`request:${test.code}`))!;
    if (state === "preparing" || state === "failed") await test.store.put(`request:${test.code}`, { ...request, status: state === "preparing" ? "pending" : "failed" });
    if (state === "pending-mint") await test.mint(test.assessment.handle, "pending");
    const status = await test.owner.request(`/api/assessments/${test.code}`);
    expect(status.status).toBe(200);
    for (const field of ["assessmentProvenance", "assessmentModel", "assessmentSourceUrls", "verifiedXUserId", "assessedAt", "identityVerifiedAt", "providerResponseId", "sourceLabel", "mbti", "imageUrl", "svgUrl"])
      expect(status.json).not.toHaveProperty(field);
    const page = await test.owner.request(test.url);
    expect(page.status).toBe(200);
    expect(page.text).not.toContain('class="signature-provenance"');
    expect(page.text).not.toContain("data-assessment-sources");
    expect((await test.owner.request("/signatures/alice_bob")).status).toBe(404);
    for (const secret of [test.assessment.model, test.assessment.createdAt, test.assessment.providerResponseId,
      test.assessment.xIdentity!.userId, test.assessment.xIdentity!.verifiedAt, ...test.assessment.sourceUrls]) {
      expect(page.text).not.toContain(secret);
      expect(status.text).not.toContain(secret);
    }
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("labels fixture evidence truthfully without inventing a Grok model or verified X identity", async () => {
    const test = await fixture(); const owner = test.client(); await owner.init();
    const sampleAssessment: UnsignedAssessment = {
      id: "5283a713-18c6-472c-bb52-d7e4d38f242a", handle: "alice", mbti: "ENFP",
      rendererVersion: RENDERER_VERSION, policyVersion: "grok-x-search-v1", model: "development-fixture-v1",
      providerResponseId: "development-fixture:alice", sourceUrls: [], createdAt: "2026-09-18T08:16:31.583Z", provenance: "development-fixture",
      xIdentity: { canonicalHandle: "alice", username: "Alice", userId: "864208642086420",
        verifiedAt: "2026-09-18T08:16:25.000Z", provenance: "development-fixture", freshness: "verified-at-preparation" },
    };
    await test.repository.putIfAbsent({ ...sampleAssessment, digest: assessmentDigest(sampleAssessment) });
    const { code } = await owner.assess("alice"); await test.mint("alice");
    const status = await owner.request(`/api/assessments/${code}`);
    expect(status.json).toMatchObject({ assessmentProvenance: "development-fixture", assessmentModel: "development-fixture-v1", assessmentSourceUrls: [] });
    expect(status.json).not.toHaveProperty("verifiedXUserId");
    expect(status.json).not.toHaveProperty("identityVerifiedAt");
    const page = await owner.request("/signatures/alice");
    expect(page.text).toContain("<dt>Assessor</dt><dd>Sample input</dd>");
    expect(page.text).toContain("<dt>Model</dt><dd>development-fixture-v1</dd>");
    expect(page.text).toContain("Sample MBTI input; Grok was not called.");
    expect(page.text).not.toContain("data-assessment-sources");
    expect(page.text).not.toContain("Verified X account");
    expect(page.text).not.toContain(sampleAssessment.xIdentity!.userId);
    expect(page.text).not.toContain(sampleAssessment.xIdentity!.verifiedAt);
    expectProductionPresentation(page.text);
    const gallery = await fixture({ offline: true });
    const sample = await gallery.client().request(OPEN_MINT_GALLERY_FIXTURES[0]!.url);
    expect(sample.status).toBe(200);
    expect(sample.text).toContain("<dt>Assessor</dt><dd>Sample input</dd>");
    expect(sample.text).toContain("Sample MBTI input; Grok was not called.");
    expect(sample.text).not.toContain("<dt>Model</dt>");
    expect(sample.text).not.toContain("data-assessment-sources");
    expectProductionPresentation(sample.text);
    expect(gallery.assess).not.toHaveBeenCalled();
  });

  it("preserves mixed-case request URLs and labels without introducing another assessment or permalink identity", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const entry = await client.request("/p/Alice_Bob_Key");
    expect(entry.status).toBe(200);
    expect(entry.text).toContain('value="Alice_Bob_Key"');
    const { url, code } = await client.assess("@Alice_Bob_Key");
    expect(url).toContain("/mint/");
    const status = await client.request(`/api/assessments/${code}`);
    expect(status.json).toMatchObject({ handle: "alice_bob_key", renderHandle: "Alice_Bob_Key" });
    for (const path of [url]) {
      const page = await client.request(path);
      expect(page.status).toBe(200);
      expect(page.text).toContain("@Alice_Bob_Key");
    }
    const second = test.client(); await second.init();
    const again = await second.assess("ALICE_BOB_KEY");
    const secondStatus = await second.request(`/api/assessments/${again.code}`);
    expect(secondStatus.json.renderHandle).toBe("ALICE_BOB_KEY");
    expect(secondStatus.json).not.toHaveProperty("svgUrl");
    expect(test.assess).toHaveBeenCalledTimes(1);
    await test.mint("alice_bob_key");
    expect((await second.request(`/api/assessments/${again.code}`)).json.renderHandle).toBe("Alice_Bob_Key");
    for (const path of ["/signatures/alice_bob_key", "/signatures/Alice_Bob_Key"]) expect((await client.request(path)).text).toContain("@Alice_Bob_Key");
  });

  it("requires proof before assessment, keeps explicit mint consent and consumes challenges once", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const anonymous = await client.request("/api/assessments", { method: "POST", body: { handle: "alice" } });
    expect(anonymous.status).toBe(403);
    expect(test.assess).not.toHaveBeenCalled();
    const { code } = await client.assess();
    expect((await client.prove()).result.json.wallet).toBe(wallet.address);
    expect((await client.request(`/api/assessments/${code}`)).json.walletProvedForCode).toBe(true);
    const proof = await client.prove(code);
    expect(proof.result.status).toBe(200);
    expect(proof.message).toContain(code);
    expect((await client.request(`/api/assessments/${code}`)).json.walletProvedForCode).toBe(true);
    expect((await client.request("/api/wallet/verify", { method: "POST", body: { challengeId: proof.challengeId, signature: proof.signature } })).status).toBe(409);
    expect((await client.request("/api/mints/authorize", { method: "POST", body: { code, consent: false } })).status).toBe(400);
    const authorized = await client.request("/api/mints/authorize", { method: "POST", body: { code, consent: true } });
    expect(authorized.status).toBe(200);
    expect(authorized.json.transaction.from).toBe(wallet.address);
    expect((await client.request("/me")).text).toContain(wallet.address);
    expect((await client.request("/api/session/logout", { method: "POST", body: {} })).status).toBe(200);
    expect((await client.init()).json.wallet).toBeNull();
  });

  it("serves locked artwork, hashed assets, public permalink, and restrictive browser headers", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const { code } = await client.assess("alice");
    await test.mint("alice");
    const status = await client.request(`/api/assessments/${code}`);
    const permalink = await client.request("/signatures/alice");
    expect(permalink.status).toBe(200);
    expect(permalink.text).toContain(status.json.mbti);
    expectProductionPresentation(permalink.text);
    expect(permalink.text).not.toContain("data-mint-form");
    const svg = await client.request(status.json.svgUrl);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("cache-control")).toContain("immutable");
    expect(svg.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(svg.text).toContain("<svg");
    const home = await client.request("/");
    expect(home.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(home.headers.get("referrer-policy")).toBe("no-referrer");
    expect(home.headers.get("x-content-type-options")).toBe("nosniff");
    expect(home.headers.get("cache-control")).toBe("no-store");
    const style = home.text.match(/<link rel="stylesheet" href="([^"]+)"/)![1]!;
    const script = home.text.match(/<script src="([^"]+)"/)![1]!;
    expect(style).toMatch(/^\/assets\/open-mint-[a-f0-9]+\.css$/);
    expect(script).toMatch(/^\/assets\/open-mint-[a-f0-9]+\.js$/);
    expect((await client.request(style)).text).toContain("Playpen Sans");
    expect((await client.request(script)).text).toContain("eth_sendTransaction");
    for (const path of ["/", "/me", "/about", "/p/alice", "/signatures/alice"]) expect((await client.request(path)).text).not.toMatch(/(?:xai|sk)-[A-Za-z0-9]{16,}|authorizerPrivateKey|providerResponse|walletProof|client_secret/);
  });

  it("renders all editable preview types without assessments, storage, mint authority or wallet access", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    for (const mbti of MBTI_TYPES) {
      const preview = await client.request(`/p/Alice_Bob_Key/${mbti}`);
      expect(preview.status).toBe(200);
      expect(preview.text).toContain(`/preview/Alice_Bob_Key/${mbti}.svg`);
      expect(preview.text).toContain('/mint?handle=Alice_Bob_Key');
      expect(preview.text).not.toContain('data-mint-form');
      const svg = await client.request(`/preview/Alice_Bob_Key/${mbti}.svg`);
      expect(svg.status).toBe(200);
      expect(svg.text).toBe(renderSignatureSvg("Alice_Bob_Key", mbti));
    }
    expect((await client.request('/p/Alice_Bob_Key/enfp')).text).toContain('/preview/Alice_Bob_Key/ENFP.svg');
    for (const path of ['/p/alice/17', '/p/alice/INXX', '/p/alice/1.000000', '/preview/alice/INXX.svg', '/p/invalid%2Fhandle/ENFP']) expect((await client.request(path)).status).toBe(404);
    expect((await client.request('/mint?handle=Alice_Bob_Key&mbti=INTJ')).text).toContain('value="Alice_Bob_Key"');
    expect((await client.request('/mint')).status).toBe(200);
    await client.prove();
    expect((await client.request('/api/session')).json.walletVerified).toBe(true);
    expect(test.assess).not.toHaveBeenCalled();
    expect(await test.store.entries('request:')).toHaveLength(0);
    expect(await test.store.entries('artifact:')).toHaveLength(0);
  });

  it("opens 16 case-preserved variations from each gallery caption without changing minted work", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const { url } = await client.assess("Alice_Bob_Key");
    const prepared = await client.request(url);
    expect(prepared.status).toBe(200);
    expectHandleNavigation(prepared.text, "Alice_Bob_Key", 1);
    expect(prepared.text).not.toContain("/artifacts/");
    await test.mint("alice_bob_key", "pending");
    const submitted = await client.request(url);
    expect(submitted.status).toBe(200);
    expectHandleNavigation(submitted.text, "Alice_Bob_Key", 1);
    expect(submitted.text).not.toContain("/artifacts/");
    await test.mint("alice_bob_key");
    const artifact = (await test.service.artifact("alice_bob_key"))!;
    const mbti = artifact.assessment.mbti;
    const storedBefore = await test.store.entries("");
    const request = vi.spyOn(test.service, "request");
    const authorize = vi.spyOn(test.service, "authorize");
    const sign = vi.spyOn(test.network, "sign");
    const put = vi.spyOn(test.store, "put");
    test.assess.mockClear();
    for (const path of ["/", `/${mbti}/`, "/me"]) {
      const gallery = await client.request(path);
      expect(gallery.status, path).toBe(200);
      const card = gallery.text.match(/<article class="gallery-item"[^>]*>[\s\S]*?<\/article>/)![0];
      const handleHref = card.match(/<a class="gallery-handle" href="([^"]+)">@Alice_Bob_Key<\/a>/)?.[1];
      expect(handleHref, path).toBe("/p/Alice_Bob_Key/variations");
      expect(card).toContain('<span class="artwork-personality-separator" aria-hidden="true">×</span>');
      expect(card).toContain('class="artwork-caption gallery-card-copy"');
      expect(card).toContain('class="signature-tag artwork-status" href="/">Minted</a>');
      expectArtworkCaptionPolicy(card, 1, 1);
      expect(card).toContain(`<a class="mbti-link" href="/${mbti}/">${mbti}</a>`);
      expect(card).toContain('class="gallery-card" href="/signatures/alice_bob_key"');
      expect(card).toContain(`src="/artifacts/${artifact.pngSha256}.png"`);
      expect(card).not.toContain("https://x.com/");
      const variations = await client.request(handleHref!);
      expect(variations.status).toBe(200);
      expect(variations.text).toContain("data-preview-variations");
      expect(variations.text.match(/class="open-preview-card"/g)).toHaveLength(16);
      expectArtworkCaptionPolicy(variations.text, 16, 1, 15);
      const links = [...variations.text.matchAll(/href="(\/p\/Alice_Bob_Key\/[A-Z]{4})"/g)].map(match => match[1]);
      expect(new Set(links)).toEqual(new Set(MBTI_TYPES.filter(type => type !== mbti).map(type => `/p/Alice_Bob_Key/${type}`)));
      expect(variations.text).toContain(`data-preview-minted="${mbti}"`);
      expect(variations.text).toContain(`src="/artifacts/${artifact.svgSha256}.svg"`);
      expect(variations.text).not.toContain("/p/alice_bob_key/");
      expectHandleNavigation(variations.text, "Alice_Bob_Key", 17);
    }
    const detail = await client.request("/signatures/alice_bob_key");
    expect(detail.status).toBe(200);
    expectArtworkCaptionPolicy(detail.text, 1, 1);
    expectHandleNavigation(detail.text, "Alice_Bob_Key", 2);
    expect(detail.text).toContain(`src="/artifacts/${artifact.svgSha256}.svg"`);
    for (const operation of [request, authorize, test.assess, sign, put]) expect(operation).not.toHaveBeenCalled();
    expect(await test.store.entries("")).toEqual(storedBefore);
  });

  it("serves all 16 variation links and their SVGs without wallet proof or paid and durable operations", async () => {
    const test = await fixture(); const client = test.client();
    const put = vi.spyOn(test.store, "put");
    const grid = await client.request('/p/Alice_Bob_Key/variations');
    expect(grid.status).toBe(200);
    expectHandleNavigation(grid.text, "Alice_Bob_Key", 17);
    expect(grid.headers.get('content-type')).toContain('text/html');
    expect(grid.text).toContain('data-preview-variations');
    expectArtworkCaptionPolicy(grid.text, 16, 0, 16);
    expectPreviewNoticePolicy(grid.text, "unminted");
    const links = [...grid.text.matchAll(/href="(\/p\/Alice_Bob_Key\/[A-Z]{4})"/g)].map(match => match[1]!);
    expect(links).toHaveLength(16);
    expect(new Set(links)).toEqual(new Set(MBTI_TYPES.map(mbti => `/p/Alice_Bob_Key/${mbti}`)));
    for (const mbti of MBTI_TYPES) {
      const detail = await client.request(`/p/Alice_Bob_Key/${mbti}`);
      expect(detail.status).toBe(200);
      expectHandleNavigation(detail.text, "Alice_Bob_Key", 1);
      expect(detail.text).toContain('href="/p/Alice_Bob_Key/variations">View all 16 variations</a>');
      const svg = await client.request(`/preview/Alice_Bob_Key/${mbti}.svg`);
      expect(svg.status).toBe(200);
      expect(svg.headers.get('content-type')).toContain('image/svg+xml');
      expect(svg.text).toContain('<svg');
    }
    expect(grid.text).not.toMatch(/data-assessment-request|data-assessment-code|data-mint-form|data-connect-wallet|data-dev-wallet|data-dev-mint|\/artifacts\//);
    expect((await client.request('/api/session')).json).toMatchObject({ wallet: null, walletVerified: false });
    expect(test.assess).not.toHaveBeenCalled();
    expect(test.network.state).toHaveBeenCalledTimes(17);
    expect(vi.mocked(test.network.state).mock.calls.every(([handle]) => handle === 'alice_bob_key')).toBe(true);
    expect(put).not.toHaveBeenCalled();
    expect(await test.store.entries('')).toHaveLength(0);
  });

  it("normalizes only variations URL syntax, preserves handle case, and rejects hostile or unknown paths", async () => {
    const test = await fixture(); const client = test.client();
    for (const path of ['/p/@Alice_Bob_Key/variations', '/p/%40Alice_Bob_Key/variations', '/p/%41lice_Bob_Key/variations']) {
      const result = await client.request(path);
      expect(result.status).toBe(200);
      expect(result.text).toContain('data-preview-variations');
      expect(result.text).toContain('/p/Alice_Bob_Key/ENFP');
      expect(result.text).not.toContain('/p/alice_bob_key/');
    }
    for (const path of ['/p/invalid%2Fhandle/variations', '/p/%3Cscript%3E/variations', '/p/a%00b/variations', '/p/%/variations', `/p/${'a'.repeat(16)}/variations`, '/p/alice/variation', '/p/alice/INXX', '/p/alice/variations/ENFP']) {
      expect((await client.request(path)).status, path).toBe(404);
    }
    const bareHandle = await client.request('/p/Alice_Bob_Key');
    expect(bareHandle.status).toBe(200);
    expect(bareHandle.text).toContain('data-mint-entry');
    expect(bareHandle.text).toContain('value="Alice_Bob_Key"');
    expect(bareHandle.text).not.toContain('data-preview-variations');
    expect(test.assess).not.toHaveBeenCalled();
    expect(test.network.state).toHaveBeenCalled();
    expect(vi.mocked(test.network.state).mock.calls.every(([handle]) => handle === 'alice_bob_key')).toBe(true);
    expect(await test.store.entries('')).toHaveLength(0);
  });

  it("uses canonical mint identity, frozen spelling, saved SVG, and the same variation order for confirmed mints", async () => {
    const test = await fixture(); const owner = test.client(); await owner.init();
    const beforeMint = await owner.request('/p/Alice_Bob_Key/variations');
    const originalOrder = [...beforeMint.text.matchAll(/<img[^>]+alt="Signature preview for @Alice_Bob_Key × ([A-Z]{4})"/g)].map(match => match[1]);
    expect(originalOrder).toHaveLength(16);
    await owner.assess('Alice_Bob_Key');
    await test.mint('alice_bob_key');
    const artifact = (await test.service.artifact('alice_bob_key'))!;
    const storedBefore = await test.store.entries('');
    const put = vi.spyOn(test.store, 'put');
    const request = vi.spyOn(test.service, 'request');
    const authorize = vi.spyOn(test.service, 'authorize');
    const sign = vi.spyOn(test.network, 'sign');
    const fetch = vi.spyOn(globalThis, 'fetch');
    test.assess.mockClear(); vi.mocked(test.network.state).mockClear();
    const visitor = test.client();
    for (const spelling of ['alice_bob_key', 'ALICE_BOB_KEY', 'aLiCe_BoB_kEy']) {
      for (const suffix of ['variations', ...MBTI_TYPES]) {
        const response = await visitor.request(`/p/${spelling}/${suffix}`, { followRedirects: false });
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(`/p/Alice_Bob_Key/${suffix}`);
        expect(response.text).toBe('');
      }
    }
    const grid = await visitor.request('/p/Alice_Bob_Key/variations', { followRedirects: false });
    expect(grid.status).toBe(200);
    expect(grid.text).toContain('data-preview-mint-state="minted"');
    expectPreviewNoticePolicy(grid.text, "minted");
    expect(grid.text.match(/data-preview-minted=/g)).toHaveLength(1);
    expectArtworkCaptionPolicy(grid.text, 16, 1, 15);
    const cards = [...grid.text.matchAll(/<li\b[^>]*><a class="open-preview-card"[\s\S]*?<\/li>/g)].map(match => match[0]);
    expect(cards).toHaveLength(16);
    expect(cards.map(card => card.match(/<img[^>]+alt="[^"]* × ([A-Z]{4})"/)![1])).toEqual(originalOrder);
    for (const card of cards) {
      const mbti = card.match(/<img[^>]+alt="[^"]* × ([A-Z]{4})"/)![1]!;
      if (mbti === artifact.assessment.mbti) {
        expect(card).toContain(`data-preview-minted="${mbti}"`);
        expect(card).toContain('href="/signatures/alice_bob_key"');
        expect(card).toContain(`src="/artifacts/${artifact.svgSha256}.svg"`);
        expect(card).toContain('>Minted</a>');
        expect(card).not.toContain('/preview/');
      } else {
        expect(card).toContain(`href="/p/Alice_Bob_Key/${mbti}"`);
        expect(card).toContain(`src="/preview/Alice_Bob_Key/${mbti}.svg?renderer=${artifact.assessment.rendererVersion}"`);
        expect(card).not.toContain('data-preview-minted');
      }
    }
    for (const mbti of MBTI_TYPES) {
      const detail = await visitor.request(`/p/Alice_Bob_Key/${mbti}`, { followRedirects: false });
      expect(detail.status).toBe(200);
      expect(detail.text).toContain('data-preview-mint-state="minted"');
      expectArtworkCaptionPolicy(detail.text, 1, mbti === artifact.assessment.mbti ? 1 : 0, mbti === artifact.assessment.mbti ? 0 : 1);
      expect(detail.text).toContain('href="/signatures/alice_bob_key"');
      expect(detail.text).toContain('href="/p/Alice_Bob_Key/variations"');
      expect(detail.text).not.toMatch(/href="\/mint(?:\?|"|\/)|data-mint-form|data-assessment-request/);
      expect(detail.text).toContain(mbti === artifact.assessment.mbti
        ? `src="/artifacts/${artifact.svgSha256}.svg"`
        : `src="/preview/Alice_Bob_Key/${mbti}.svg?renderer=${artifact.assessment.rendererVersion}"`);
      if (mbti !== artifact.assessment.mbti) expect(detail.text).toContain('>Preview</span>');
    }
    const archived = await visitor.request(`/artifacts/${artifact.svgSha256}.svg`);
    expect(archived.status).toBe(200);
    expect(sha256Hex(archived.bytes)).toBe(artifact.svgSha256);
    expect(grid.text).not.toMatch(/href="\/mint(?:\?|"|\/)|data-mint-form|data-assessment-request/);
    expect(vi.mocked(test.network.state).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(test.network.state).mock.calls.every(([handle]) => handle === 'alice_bob_key')).toBe(true);
    for (const operation of [request, authorize, sign, fetch, test.assess, put]) expect(operation).not.toHaveBeenCalled();
    expect(await test.store.entries('')).toEqual(storedBefore);
  });

  it("compares older minted artwork using the recorded v1 renderer and MBTI seed mapping without rewriting it", async () => {
    const test = await fixture(); const owner = test.client(); await owner.init();
    const unsigned: Omit<LegacyAssessment, 'digest'> = {
      id: '11111111-1111-4111-8111-111111111111', handle: 'legacy_case', mbti: 'INTJ',
      seed: seedForMbti('INTJ'), rendererVersion: LEGACY_RENDERER_VERSION, mappingVersion: LEGACY_MAPPING_VERSION,
      policyVersion: 'grok-x-search-v1', model: 'development-fixture-v1', providerResponseId: 'development-fixture:legacy',
      sourceUrls: [], createdAt: '2026-09-01T00:00:00.000Z', provenance: 'development-fixture',
    };
    await test.repository.putIfAbsent({ ...unsigned, digest: assessmentDigest(unsigned) });
    await owner.assess('Legacy_Case');
    await test.mint('legacy_case');
    const artifact = (await test.service.artifact('legacy_case'))!;
    expect(artifact.assessment.rendererVersion).toBe(LEGACY_RENDERER_VERSION);
    const storedBefore = await test.store.entries('');
    const put = vi.spyOn(test.store, 'put');
    const grid = await test.client().request('/p/LEGACY_CASE/variations');
    expect(grid.status).toBe(200);
    expectHandleNavigation(grid.text, "Legacy_Case", 17);
    expect(grid.text).toContain(`src="/artifacts/${artifact.svgSha256}.svg"`);
    expect(grid.text).toContain('href="/signatures/legacy_case"');
    expect(grid.text).toContain('data-preview-renderer-notice');
    expect(grid.text).not.toContain(`renderer=${RENDERER_VERSION}`);
    for (const mbti of MBTI_TYPES) {
      const detail = await test.client().request(`/p/legacy_case/${mbti}`);
      expect(detail.status).toBe(200);
      expectHandleNavigation(detail.text, "Legacy_Case", 1);
      const image = mbti === artifact.assessment.mbti
        ? `/artifacts/${artifact.svgSha256}.svg`
        : `/preview/Legacy_Case/${mbti}.svg?renderer=${LEGACY_RENDERER_VERSION}`;
      expect(grid.text).toContain(`src="${image}"`);
      expect(detail.text).toContain(`src="${image}"`);
      expect(detail.text).not.toContain('/mint?handle=');
      const svg = await test.client().request(image);
      expect(svg.status).toBe(200);
      expect(svg.text).toBe(Buffer.from(formalSignatureRenderer.render({
        handle: 'Legacy_Case', gr0kRaw: seedForMbti(mbti), gr0kScale: 1, rendererVersion: LEGACY_RENDERER_VERSION,
      }).svgUtf8).toString('utf8'));
    }
    expect(test.assess).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await test.store.entries('')).toEqual(storedBefore);
  });

  it("serves versioned preview assets without state lookup and rejects unsupported or ambiguous renderers", async () => {
    const test = await fixture(); const client = test.client();
    const put = vi.spyOn(test.store, 'put');
    for (const mbti of MBTI_TYPES) {
      for (const query of ['', `?renderer=${RENDERER_VERSION}`]) {
        const response = await client.request(`/preview/Case_Check/${mbti}.svg${query}`);
        expect(response.status).toBe(200);
        expect(response.text).toBe(renderSignatureSvg('Case_Check', mbti));
      }
      const legacy = await client.request(`/preview/Case_Check/${mbti}.svg?renderer=${LEGACY_RENDERER_VERSION}`);
      expect(legacy.status).toBe(200);
      expect(legacy.text).toBe(Buffer.from(formalSignatureRenderer.render({
        handle: 'Case_Check', gr0kRaw: seedForMbti(mbti), gr0kScale: 1, rendererVersion: LEGACY_RENDERER_VERSION,
      }).svgUtf8).toString('utf8'));
      expect(legacy.headers.get('content-type')).toBe('image/svg+xml');
      expect(legacy.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      expect(legacy.headers.get('set-cookie')).toBeNull();
    }
    for (const query of ['renderer=unsupported', 'renderer=', `renderer=${RENDERER_VERSION}&renderer=${LEGACY_RENDERER_VERSION}`, `renderer=${RENDERER_VERSION}&renderer=${RENDERER_VERSION}`]) {
      const response = await client.request(`/preview/Case_Check/ENFP.svg?${query}`);
      expect([400, 404]).toContain(response.status);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.text).toContain('role="alert"');
    }
    expect(test.network.state).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps pending mints browsable without revealing the prepared assessment or offering another mint", async () => {
    const test = await fixture(); const owner = test.client(); await owner.init();
    await owner.assess('Pending_Case'); await test.mint('pending_case', 'pending');
    const artifact = (await test.service.artifact('pending_case'))!;
    const storedBefore = await test.store.entries('');
    const put = vi.spyOn(test.store, 'put');
    const request = vi.spyOn(test.service, 'request');
    const authorize = vi.spyOn(test.service, 'authorize');
    test.assess.mockClear(); vi.mocked(test.network.state).mockClear();
    for (const suffix of ['variations', ...MBTI_TYPES]) {
      const page = await test.client().request(`/p/PENDING_CASE/${suffix}`, { followRedirects: false });
      expect(page.status).toBe(200);
      expect(page.headers.get('location')).toBeNull();
      expect(page.text).toContain('data-preview-mint-state="pending"');
      expectPreviewNoticePolicy(page.text, "pending", suffix === 'variations');
      expect(page.text).toContain('Waiting for confirmation');
      expect(page.text).toContain('/preview/PENDING_CASE/');
      expectArtworkCaptionPolicy(page.text, suffix === 'variations' ? 16 : 1, 0, suffix === 'variations' ? 16 : 1);
      expect(page.text).not.toMatch(/href="\/mint(?:\?|"|\/)|data-preview-minted=|data-mint-form|data-assessment-request|\/artifacts\/|\/signatures\/pending_case/);
      for (const secret of [artifact.assessment.digest, artifact.digest, artifact.svgSha256, artifact.assessment.id, artifact.assessment.providerResponseId]) expect(page.text).not.toContain(secret);
    }
    expect(vi.mocked(test.network.state).mock.calls).toHaveLength(17);
    expect(vi.mocked(test.network.state).mock.calls.every(([handle]) => handle === 'pending_case')).toBe(true);
    for (const operation of [request, authorize, test.assess, put]) expect(operation).not.toHaveBeenCalled();
    expect(await test.store.entries('')).toEqual(storedBefore);
  });

  it.each(['rpc-failure', 'no-network'] as const)("keeps %s previews usable with unknown mint status and no mint CTA", async failure => {
    const test = await fixture({ offline: failure === 'no-network', fixture: false });
    if (failure === 'rpc-failure') vi.mocked(test.network.state).mockRejectedValue(new Error('private RPC diagnostics'));
    const put = vi.spyOn(test.store, 'put');
    const request = vi.spyOn(test.service, 'request');
    const authorize = vi.spyOn(test.service, 'authorize');
    const client = test.client();
    for (const suffix of ['variations', ...MBTI_TYPES]) {
      const response = await client.request(`/p/Unknown_Case/${suffix}`, { followRedirects: false });
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(response.text).toContain('data-preview-mint-state="unavailable"');
      expect(response.text).not.toMatch(/Mint status cannot be verified|data-mint-observation-warning|open-preview-warning/);
      expectPreviewNoticePolicy(response.text, "unavailable", suffix === 'variations');
      expectArtworkCaptionPolicy(response.text, suffix === 'variations' ? 16 : 1, 0, suffix === 'variations' ? 16 : 1);
      expect(response.text).toContain('/preview/Unknown_Case/');
      expect(response.text).not.toMatch(/href="\/mint(?:\?|"|\/)|data-preview-minted=|data-mint-form|data-assessment-request|data-preview-mint-state="unminted"|private RPC diagnostics/);
    }
    expect((await client.request('/preview/Unknown_Case/ENFP.svg')).status).toBe(200);
    for (const operation of [request, authorize, test.assess, put]) expect(operation).not.toHaveBeenCalled();
    if (failure === 'no-network') expect(test.network.state).not.toHaveBeenCalled();
    else expect(vi.mocked(test.network.state).mock.calls.every(([handle]) => handle === 'unknown_case')).toBe(true);
    expect(await test.store.entries('')).toHaveLength(0);
  });

  it.each(['rpc-failure', 'commitment-mismatch'] as const)("does not expose a saved assessment when confirmed mint verification has a %s", async failure => {
    const test = await fixture(); const owner = test.client(); await owner.init();
    await owner.assess('Saved_Case'); await test.mint('saved_case');
    const artifact = (await test.service.artifact('saved_case'))!;
    if (failure === 'rpc-failure') vi.mocked(test.network.state).mockRejectedValue(new Error('RPC unavailable'));
    else vi.mocked(test.network.state).mockResolvedValue({
      state: 'minted', assessmentDigest: artifact.assessment.digest,
      artifactDigest: `0x${'0'.repeat(64)}`, tokenURIHash: openMintTokenURIHash(artifact.tokenURI),
    });
    const storedBefore = await test.store.entries('');
    const put = vi.spyOn(test.store, 'put');
    test.assess.mockClear();
    for (const suffix of ['variations', artifact.assessment.mbti]) {
      const response = await test.client().request(`/p/SAVED_CASE/${suffix}`, { followRedirects: false });
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(response.text).toContain('data-preview-mint-state="unavailable"');
      expect(response.text).toContain('/preview/SAVED_CASE/');
      expect(response.text).not.toMatch(/\/artifacts\/|data-preview-minted=|href="\/mint(?:\?|"|\/)|\/signatures\/saved_case/);
      for (const secret of [artifact.assessment.digest, artifact.digest, artifact.svgSha256, artifact.assessment.id]) expect(response.text).not.toContain(secret);
    }
    expect(test.assess).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await test.store.entries('')).toEqual(storedBefore);
  });

  it("renders production copy for exact preset previews without developer notices or durable minted records", async () => {
    const test = await fixture({ offline: true, fixture: true }); const client = test.client();
    const put = vi.spyOn(test.store, 'put');
    const state = vi.spyOn(test.service, 'state');
    const entry = OPEN_MINT_GALLERY_FIXTURES.find(candidate => candidate.renderHandle !== candidate.handle)!;
    const detail = await client.request(entry.url);
    expect(detail.status).toBe(200);
    expectHandleNavigation(detail.text, entry.renderHandle, 2);
    for (const suffix of ['variations', entry.mbti]) {
      const response = await client.request(`/p/${entry.renderHandle}/${suffix}`, { followRedirects: false });
      expect(response.status).toBe(200);
      expectHandleNavigation(response.text, entry.renderHandle, suffix === 'variations' ? 17 : 1);
      expect(response.headers.get('location')).toBeNull();
      expect(response.text).toContain('data-preview-mint-state="fixture"');
      expectPreviewNoticePolicy(response.text, "fixture", suffix === 'variations');
      expect(response.text).toContain('>Minted</a>');
      expectArtworkCaptionPolicy(response.text, suffix === 'variations' ? 16 : 1, 1, suffix === 'variations' ? 15 : 0);
      expectProductionPresentation(response.text);
      expect(response.text).toContain(suffix === 'variations'
        ? 'One minted signature. Fifteen alternative interpretations, for exploration only.'
        : 'The minted signature, shown from its saved artwork.');
      expect(response.text).toContain(`href="${entry.url}"`);
      expect(response.text).toContain(`src="${entry.imageUrl}"`);
      expect(response.text).not.toMatch(/href="\/mint(?:\?|"|\/)|\/artifacts\//);
    }
    for (const spelling of [entry.handle, entry.renderHandle.toUpperCase(), 'Not_A_Fixture']) {
      for (const suffix of ['variations', entry.mbti]) {
        const response = await client.request(`/p/${spelling}/${suffix}`, { followRedirects: false });
        expect(response.status).toBe(200);
        expect(response.headers.get('location')).toBeNull();
        expect(response.text).toContain('data-preview-mint-state="unavailable"');
        expect(response.text).toContain(`/preview/${spelling}/`);
        expect(response.text).not.toMatch(/>Minted<\/(?:span|a)>/);
        expect(response.text).not.toContain('data-preview-minted=');
        expect(response.text).not.toContain('/mint?handle=');
      }
    }
    expect(state).not.toHaveBeenCalled();
    expect(test.network.state).not.toHaveBeenCalled();
    expect(test.assess).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await test.store.entries('')).toHaveLength(0);
  });

  it.each([{ fixture: false, offline: true }, { fixture: false, offline: false }, { fixture: true, offline: false }])("does not project fixture mint state outside explicit offline fixture mode ($fixture / offline $offline)", async options => {
    const test = await fixture(options); const client = test.client();
    const entry = OPEN_MINT_GALLERY_FIXTURES.find(candidate => candidate.renderHandle !== candidate.handle)!;
    for (const suffix of ['variations', entry.mbti]) {
      const response = await client.request(`/p/${entry.renderHandle}/${suffix}`, { followRedirects: false });
      expect(response.status).toBe(200);
      expect(response.text).toContain(`data-preview-mint-state="${options.offline ? 'unavailable' : 'unminted'}"`);
      expect(response.text).not.toContain('data-preview-mint-state="fixture"');
      expect(response.text).not.toContain('data-preview-minted=');
      expect(response.text).not.toContain('href="/dev/gallery/');
    }
    expect(test.assess).not.toHaveBeenCalled();
    expect(await test.store.entries('')).toHaveLength(0);
  });

  it("preserves direct URL case edits while unminted and checks only canonical chain identity", async () => {
    const test = await fixture(); const client = test.client();
    const put = vi.spyOn(test.store, 'put');
    const request = vi.spyOn(test.service, 'request');
    const authorize = vi.spyOn(test.service, 'authorize');
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const spelling of ['Case_Edits', 'case_edits', 'CASE_EDITS', 'cAsE_eDiTs']) {
      for (const suffix of ['variations', 'ENFP']) {
        const response = await client.request(`/p/${spelling}/${suffix}`, { followRedirects: false });
        expect(response.status).toBe(200);
        expect(response.headers.get('location')).toBeNull();
        expect(response.text).toContain('data-preview-mint-state="unminted"');
        expect(response.text).toContain(`/preview/${spelling}/ENFP.svg?renderer=${RENDERER_VERSION}`);
        expect(response.text).toContain(`href="/mint?handle=${spelling}"`);
      }
    }
    expect(vi.mocked(test.network.state).mock.calls).toHaveLength(8);
    expect(vi.mocked(test.network.state).mock.calls.every(([handle]) => handle === 'case_edits')).toBe(true);
    for (const operation of [request, authorize, fetch, test.assess, put]) expect(operation).not.toHaveBeenCalled();
    expect(await test.store.entries('')).toHaveLength(0);
  });

  it("returns the already-minted permalink without another assessment", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    await client.assess('alice'); await test.mint('alice');
    const response = await client.request('/api/assessments', { method: 'POST', body: { handle: 'ALICE' } });
    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({ code: 'ALREADY_MINTED', url: '/signatures/alice' });
    expect(test.assess).toHaveBeenCalledTimes(1);
  });
});
