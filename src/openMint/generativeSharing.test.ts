import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGenerativeSharingHandler, createStagingGenerativeSharing, SHARING_READ_LIMITS } from "./generativeSharing.js";
import { generativeProjectionFixture } from "./fixtures/generativeProjectionRpc.js";
import { profileForRenderer } from "./generativeInputs.js";
import { MBTI_TYPES, RENDERER_VERSION } from "./identity.js";
import { PRIVATE_ROBOTS } from "./sharing.js";
import type { AssessmentPageModel } from "./pages.js";
import { renderSignatureSvg } from "../algorithmV2/index.js";

const origin = "https://staging.signatures.gallery", privateHead = `<meta name="robots" content="${PRIVATE_ROBOTS}">`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a53sAAAAASUVORK5CYII=", "base64");
function fixture() {
  const f = generativeProjectionFixture("generative-v1-rc1"), deployment = { ...f.options.deployment, chainId: "11155111" };
  const model: AssessmentPageModel = { handle: f.inputs.canonicalHandle, renderHandle: f.inputs.renderHandle, mbti: f.inputs.mbti,
    code: "", status: "ready", canMint: false, rendererVersion: profileForRenderer(deployment.generativeRenderer!).rendererVersion,
    rendererIdentity: f.inputs.rendererIdentity, inputDigest: f.inputs.digest, assessmentDigest: f.inputs.assessmentDigest,
    imageUrl: `/api/signatures/${f.inputs.canonicalHandle}/artwork/${f.inputs.digest}/svg`, tokenId: f.tokenId,
    mint: { state: "minted", tokenId: f.tokenId, transactionHash: `0x${"1".repeat(64)}` } };
  return { f, deployment, model, sharing: createStagingGenerativeSharing({ origin, deployment }) };
}

describe("staging generative sharing policy, no artifact journal or public indexing", () => {
  it.each(["http://staging.signatures.gallery", "https://signatures.gallery", origin + "/", "http://127.0.0.1", origin + "?secret=1"])("refuses alternate origin %s", value => {
    expect(() => createStagingGenerativeSharing({ origin: value, deployment: fixture().deployment })).toThrow();
  });
  it("requires a Sepolia RC1 binding and captures it rather than caller-owned mutation", () => {
    const { deployment } = fixture();
    for (const patch of [{ chainId: "31337" }, { generativeRenderer: undefined }, { chainId: "1" }]) {
      expect(() => createStagingGenerativeSharing({ origin, deployment: { ...deployment, ...patch } })).toThrow();
    }
    expect(() => createStagingGenerativeSharing({ origin, deployment, index: true } as never)).toThrow();
    const { sharing, model, deployment: captured } = fixture(); captured.chainId = "1"; Object.assign(captured.generativeRenderer!, { identity: `0x${"f".repeat(64)}` });
    expect(sharing.head("/signatures/alice_bob_key", model)).toContain('rel="canonical"');
  });
  it.each(["/mint", "/mint?handle=Alice", "/mint/" + "A".repeat(43), "/requests/private", "/me", "/me?after=private", "/api/session", "/api/assessments/private",
    "/signatures/alice_bob_key?token=private", "/signatures/alice_bob_key#private", "/?after=cursor", "/INTJ/?after=cursor", "/p/Alice/INTJ?key=private",
    "/p/Alice/XXXX", "/p/Alice/intj", "/p/@Alice/INTJ", "/p/<script>/INTJ", "/s/Alice/INTJ", "/signatures/Alice", "https://evil.invalid/", "//evil.invalid/", "/sitemap.xml"])("no metadata for private, noncanonical or query-bearing path %s", path => {
    const m = new Proxy({} as AssessmentPageModel, { get() { throw Error("Do not inspect private model."); } });
    expect(fixture().sharing.head(path, m)).toBe(privateHead);
  });
  it.each(MBTI_TYPES)("labels %s as a free preview, with exact case/version and no indexing", mbti => {
    const h = fixture().sharing.head(`/p/Alice_Bob_Key/${mbti}`);
    expect(h).toContain(`href="${origin}/p/Alice_Bob_Key/${mbti}"`);
    expect(h).toContain(`${origin}/sharing/previews/Alice_Bob_Key/${mbti}/${RENDERER_VERSION}.png`);
    expect(h).toContain("not a verified Grok assessment or a minted artwork"); expect(h).toContain(privateHead);
    expect(h).toContain('name="twitter:card" content="summary_large_image"');
  });
  it.each(["/", "/about", "/INTJ/", "/p/Alice_Bob_Key/variations"])("emits an image-free static descriptor, never a random gallery work, for %s", path => {
    const h = fixture().sharing.head(path);
    expect(h).toContain(`href="${origin}${path}"`); expect(h).toContain('name="twitter:card" content="summary"');
    expect(h).not.toContain("og:image"); expect(h).toContain(privateHead);
  });
  it("allows only verified finalized model fields, never private provenance, wallets or callbacks", () => {
    const { sharing, model } = fixture(); Object.assign(model, { csrfToken: "secret-csrf", diagnosticReference: "secret-ref", assessmentModel: "secret-model",
      assessmentSourceUrls: ["https://private.invalid/secret"], wallet: "secret-wallet", providerResponseId: "secret-response" });
    const h = sharing.head("/signatures/alice_bob_key", model);
    expect(h).toContain(`href="${origin}/signatures/alice_bob_key"`);
    expect(h).toContain(`${origin}/sharing/signatures/alice_bob_key/${model.inputDigest}.png`);
    expect(h).toContain("@Alice_Bob_Key × INTJ"); expect(h).not.toContain("secret"); expect(h).not.toContain(model.assessmentDigest);
    expect(h).toContain(privateHead);
    expect(sharing.head("/p/Alice_Bob_Key/INTJ", model)).toBe(h); // selected minted alias
    expect(sharing.head("/p/Alice_Bob_Key/ENFP", model)).toContain("free preview");
    model.mint!.state = "confirming";
    expect(sharing.head("/signatures/alice_bob_key", model)).toBe(privateHead);
    expect(sharing.head("/p/Alice_Bob_Key/INTJ", model)).toBe(privateHead);
  });
  it.each([{ handle: "other" }, { status: "pending" }, { code: "private" }, { canMint: true }, { galleryFixture: true },
    { mint: undefined }, { renderHandle: undefined }, { renderHandle: "alice_bob_key" }, { mbti: "XXXX" }, { artifactDigest: "legacy" },
    { rendererIdentity: "wrong" }, { rendererVersion: "wrong" }, { tokenId: "1" }, { inputDigest: "wrong" }, { imageUrl: "https://evil.invalid/png" },
    { assessmentDigest: "invalid" }, { mint: { state: "minted", tokenId: "1" } }])("rejects mismatched or nonpublic detail %#", patch => {
    const { sharing, model } = fixture(); expect(sharing.head("/signatures/alice_bob_key", { ...model, ...patch } as AssessmentPageModel)).toBe(privateHead);
  });
  it("decorates only the trusted template head, with one robots directive", () => {
    const { sharing } = fixture(), html = '<html><head><meta name="robots" content="noindex"><title>Page</title></head><body>artwork</body></html>';
    const rendered = sharing.decorate(html, "/about");
    expect(rendered.match(/name="robots"/g)).toHaveLength(1); expect(rendered).toContain("</head><body>artwork</body>");
    expect(sharing.decorate(html, "/mint/private")).not.toContain("canonical");
  });
});

function routeFixture() {
  const read = vi.fn(async (_h: string, _d: string, _s: AbortSignal) => ({ mediaType: "image/png" as const, bytes: png }));
  const handler = createGenerativeSharingHandler({ sharingPng: read });
  function begin(path: string, method = "GET", headers = {}) {
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, statusCode: 200, setHeader: vi.fn(), end: vi.fn() });
    const finished = handler({ url: path, method, headers } as IncomingMessage, res as unknown as ServerResponse);
    return { res, finished };
  }
  async function call(path: string, method = "GET", headers = {}) {
    const { res, finished } = begin(path, method, headers), handled = await finished;
    return { res, handled, status: res.statusCode, bytes: Buffer.from(res.end.mock.calls[0]?.[0] ?? "") };
  }
  return { begin, call, read, drain: handler.drain };
}
describe("bounded staging sharing PNG reads", () => {
  afterEach(() => vi.useRealTimers());
  const path = `/sharing/signatures/alice/0x${"a".repeat(64)}.png`;
  it.each(MBTI_TYPES)("serves the exact free %s preview raster without chain/session/provider work", async mbti => {
    const f = routeFixture(), r = await f.call(`/sharing/previews/Alice/${mbti}/${RENDERER_VERSION}.png`);
    expect(r.status).toBe(200); expect(f.read).not.toHaveBeenCalled();
    const expected = await sharp(Buffer.from(renderSignatureSvg("Alice", mbti))).png().toBuffer();
    expect(r.bytes).toEqual(expected); expect((await sharp(r.bytes).metadata()).width).toBe(1080);
    expect(r.res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store"); expect(r.res.setHeader).toHaveBeenCalledWith("X-Robots-Tag", PRIVATE_ROBOTS);
  });
  it("delivers only the finalized-only reader's bytes and no published artifact fallback", async () => {
    const f = routeFixture(), r = await f.call(path);
    expect(r.bytes).toEqual(png); expect(f.read).toHaveBeenCalledWith("alice", `0x${"a".repeat(64)}`, expect.any(AbortSignal));
    expect(f.read.mock.calls[0][2].aborted).toBe(true); expect(r.res.listenerCount("close")).toBe(0);
    f.read.mockRejectedValue(Error("secret RPC response")); const unavailable = await f.call(path);
    expect(unavailable.status).toBe(503); expect(unavailable.bytes.toString()).not.toContain("secret");
  });
  it.each(["/sharing/previews/Alice/XXXX/sg-renderer-2.0.0.png", "/sharing/previews/Alice/INTJ/legacy.png", "/sharing/previews/%41lice/INTJ/sg-renderer-2.0.0.png",
    "/sharing/signatures/Alice/invalid.png", "/sharing/private", "/sharing/" + "x".repeat(4096), path + "?token=secret", path + "#secret", "/sitemap.xml", "/sitemap.xml?after=secret"])("refuses invalid or enumerating route %s before reading", async p => {
    const f = routeFixture(), r = await f.call(p); expect(r.handled).toBe(true); expect(r.status).toBeGreaterThanOrEqual(400); expect(f.read).not.toHaveBeenCalled();
  });
  it("does not handle unrelated routes and rejects methods/body before reading", async () => {
    const f = routeFixture(); expect((await f.call("/mint/private")).handled).toBe(false);
    expect((await f.call(path, "POST")).status).toBe(405);
    for (const headers of [{ "content-length": "1" }, { "transfer-encoding": "chunked" }]) expect((await f.call(path, "GET", headers)).status).toBe(400);
    expect(f.read).not.toHaveBeenCalled();
  });
  it("bounds output size/type and refuses non-PNG bytes", async () => {
    const f = routeFixture();
    for (const value of [{ mediaType: "text/html", bytes: png }, { mediaType: "image/png", bytes: Buffer.alloc(0) },
      { mediaType: "image/png", bytes: Buffer.alloc(SHARING_READ_LIMITS.pngBytes + 1) }, { mediaType: "image/png", bytes: Buffer.from("not png") }]) {
      f.read.mockResolvedValue(value as never); expect((await f.call(path)).status).toBe(503);
    }
  });
  it("retains both busy slots after timeout until callbacks really settle, without retry", async () => {
    vi.useFakeTimers(); const f = routeFixture(), releases: (() => void)[] = [];
    f.read.mockImplementation(() => new Promise(resolve => releases.push(() => resolve({ mediaType: "image/png", bytes: png }))));
    const a = f.begin(path), b = f.begin(path); expect((await f.call(path)).status).toBe(503);
    await vi.advanceTimersByTimeAsync(5000); await Promise.all([a.finished, b.finished]);
    expect(a.res.statusCode).toBe(503); expect((await f.call(path)).status).toBe(503); expect(f.read).toHaveBeenCalledTimes(2);
    let drained = false; const draining = f.drain().then(() => { drained = true; }); await Promise.resolve(); expect(drained).toBe(false);
    releases.forEach(r => r()); await vi.advanceTimersByTimeAsync(0);
    await draining; expect(drained).toBe(true);
    f.read.mockResolvedValue({ mediaType: "image/png", bytes: png }); expect((await f.call(path)).status).toBe(200);
    expect(a.res.end).toHaveBeenCalledTimes(1); expect(b.res.end).toHaveBeenCalledTimes(1);
  });
  it("disconnect cancels the read and cannot write late bytes", async () => {
    const f = routeFixture(); let release!: () => void;
    f.read.mockImplementation(() => new Promise(resolve => release = () => resolve({ mediaType: "image/png", bytes: png })));
    const { res, finished } = f.begin(path); res.destroyed = true; res.emit("close"); await finished;
    expect(f.read.mock.calls[0][2].aborted).toBe(true); release(); await Promise.resolve(); expect(res.end).not.toHaveBeenCalled();
  });
});
