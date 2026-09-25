import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createGenerativeSitePages } from "./generativeSitePages.js";
import type { DurableMintRuntime } from "./runtimeService.js";
import type { AssessmentPageModel } from "../pages.js";
import type { ProjectionReads } from "../projection/http.js";
import { ProjectionCursorError } from "../projection/model.js";
import { RENDERER_VERSION, MBTI_TYPES } from "../identity.js";

function fixture() {
  const wallet = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", digest = `0x${"a".repeat(64)}`;
  const session = { id: "session", generation: 1, wallet, verified: true };
  const runtime = { sessions: { origin: "http://127.0.0.1:12345", session: vi.fn(async () => ({ session, created: false })),
    requireSession: vi.fn(async () => ({ ...session })), cookie: vi.fn(() => "cookie") },
    sessionView: vi.fn((s: typeof session) => ({ wallet: s.wallet, walletVerified: s.verified })), requests: { profile: { contract_address: `0x${"2".repeat(40)}` } } };
  const model: AssessmentPageModel = { handle: "alice", renderHandle: "Alice", mbti: "INTJ", code: "", status: "ready", canMint: false,
    rendererVersion: "experimental-fixed18-not-locked", imageUrl: `/api/signatures/alice/artwork/${digest}/svg`, mint: { state: "minted" } };
  const detail = vi.fn(async (_handle: string, _signal: AbortSignal) => model);
  const item = { tokenId: "1", availability: "available" as const, handle: "alice", renderHandle: "Alice", mbti: "INTJ", inputDigest: digest, rendererIdentity: digest };
  const projection = { lookup: vi.fn<ProjectionReads["lookup"]>(), gallery: vi.fn<ProjectionReads["gallery"]>().mockResolvedValue({ state: "confirmed", items: [item], nextCursor: "next" }) };
  const handler = createGenerativeSitePages({ runtime: runtime as unknown as DurableMintRuntime, artwork: { detail }, projection });
  async function call(url: string, method = "GET", headers = {}, destroyed = false) {
    const response = Object.assign(new EventEmitter(), { statusCode: 200, destroyed, writableEnded: false, setHeader: vi.fn(), end: vi.fn() });
    const handled = await handler({ url, method, headers } as IncomingMessage, response as unknown as ServerResponse);
    return { status: response.statusCode, body: String(response.end.mock.calls[0]?.[0] ?? ""), handled, response };
  }
  return { call, runtime, session, detail, model, projection, wallet, item };
}

describe("isolated generative site pages", () => {
  it.each(MBTI_TYPES)("renders the free %s preview without any session or chain read", async mbti => {
    const f = fixture(), r = await f.call(`/preview/Alice/${mbti}.svg?renderer=${RENDERER_VERSION}`);
    expect(r.status).toBe(200); expect(r.body).toContain("<svg"); expect(r.body).toContain("Alice");
    expect(f.detail).not.toHaveBeenCalled(); expect(f.projection.lookup).not.toHaveBeenCalled(); expect(f.runtime.sessions.session).not.toHaveBeenCalled();
    expect(r.response.setHeader).toHaveBeenCalledWith("Content-Security-Policy", expect.stringContaining("sandbox"));
  });
  it.each(["minted", "confirming"] as const)("shows one on-chain %s tile and fifteen previews with honest renderer labels", async state => {
    const f = fixture(); f.model.mint = { state }; const r = await f.call("/p/Alice/variations");
    expect(r.status).toBe(200); expect(r.body.match(/class="open-preview-card"/g)).toHaveLength(16);
    expect(r.body).not.toMatch(/rel="canonical"|property="og:|name="twitter:/);
    expect(r.body.match(/>Preview<\/span>/g)).toHaveLength(15); expect(r.body).toContain('data-preview-minted="INTJ"');
    expect(r.body).toContain(f.model.imageUrl); expect(r.body).toContain("on-chain renderer"); expect(r.body).not.toContain("earlier renderer");
    expect(r.body).not.toContain("?renderer=experimental"); expect(r.body).not.toContain("Mint for this handle");
    expect(f.runtime.sessions.session).not.toHaveBeenCalled(); expect(r.response.listenerCount("close")).toBe(0);
    expect(f.detail.mock.calls[0][1].aborted).toBe(true);
  });
  it("uses the on-chain image for the selected type and the locked renderer for alternatives", async () => {
    const f = fixture();
    const selected = await f.call("/p/Alice/INTJ");
    expect(selected.body).toContain("generated from its immutable on-chain inputs");
    expect(selected.body).not.toMatch(/rel="canonical"|property="og:|name="twitter:/);
    expect((await f.call("/p/Alice/ENFP")).body).toContain(`/preview/Alice/ENFP.svg?renderer=${RENDERER_VERSION}`);
  });
  it.each(["failure", "pending", "bad-type", "wrong-handle", "no-image", "no-version"])("keeps exploration available without inventing chain absence: %s", async mode => {
    const f = fixture();
    if (mode === "failure") f.detail.mockRejectedValue(new Error("PRIVATE SECRET"));
    if (mode === "pending") f.model.mint = { state: "pending" };
    if (mode === "bad-type") f.model.mbti = "BAD";
    if (mode === "wrong-handle") f.model.renderHandle = "Other";
    if (mode === "no-image") delete f.model.imageUrl;
    if (mode === "no-version") delete f.model.rendererVersion;
    const r = await f.call("/p/Alice/variations"); expect(r.status).toBe(200);
    expect(r.body).toContain('data-preview-mint-state="unavailable"'); expect(r.body.match(/>Preview<\/span>/g)).toHaveLength(16);
    expect(r.body).toContain("One handle, all 16 MBTI interpretations"); expect(r.body).toContain("Warning");
    expect(r.body).not.toContain("PRIVATE SECRET"); expect(r.body).not.toContain("Mint for this handle");
  });
  it.each([["/s/alice/enfp", "/p/alice/ENFP", 308], ["/s/Alice", "/p/Alice", 308], ["/s/Alice/variations", "/p/Alice/variations", 308],
    ["/p/Alice", "/p/Alice/variations", 303], ["/p/alice/enfp", "/p/Alice/ENFP", 303], ["/p/%40Alice/variations", "/p/Alice/variations", 303]])("normalizes %s safely", async (path, target, status) => {
    const f = fixture(), r = await f.call(path as string); expect(r.status).toBe(status); expect(r.response.setHeader).toHaveBeenCalledWith("Location", target);
    if ((path as string).startsWith("/s/") || path === "/p/Alice") expect(f.detail).not.toHaveBeenCalled();
  });
  it("shows current-owner collections only for a still-verified session and paginates", async () => {
    const f = fixture(), r = await f.call("/me?after=cursor"); expect(r.status).toBe(200);
    expect(r.body).toContain("@Alice"); expect(r.body).toContain('href="/me?after=next"'); expect(r.body).toContain(f.wallet);
    expect(f.projection.gallery).toHaveBeenCalledWith({ filter: { kind: "owner", value: f.wallet.toLowerCase() }, limit: 24, cursor: "cursor" });
    expect(f.runtime.sessions.requireSession).toHaveBeenCalledWith("cookie");
  });
  it("allocates a session only for the signed-out collection, never claims an empty verified collection", async () => {
    const f = fixture(); f.session.verified = false; f.runtime.sessions.session.mockResolvedValue({ session: f.session, created: true });
    const r = await f.call("/me"); expect(r.status).toBe(200); expect(r.body).toContain("Connect your wallet");
    expect(r.body).not.toContain(f.wallet); expect(r.body).not.toContain("has no minted signatures");
    expect(r.response.setHeader).toHaveBeenCalledWith("Set-Cookie", "cookie"); expect(f.projection.gallery).not.toHaveBeenCalled();
  });
  it.each(["generation", "wallet", "proof", "logout"])("withdraws the collection after concurrent %s", async mode => {
    const f = fixture();
    if (mode === "logout") f.runtime.sessions.requireSession.mockRejectedValue(new Error("private logout"));
    else f.runtime.sessions.requireSession.mockResolvedValue({ ...f.session, ...(mode === "generation" ? { generation: 2 } : mode === "wallet" ? { wallet: `0x${"2".repeat(40)}` } : { verified: false }) });
    const r = await f.call("/me"); expect(r.status).toBeGreaterThanOrEqual(400); expect(r.body).not.toContain("@Alice"); expect(r.body).not.toContain("private logout");
  });
  it.each(["unknown", "safety-halted"] as const)("does not mistake %s for an empty wallet", async state => {
    const f = fixture(); f.projection.gallery.mockResolvedValue({ state, items: [] });
    const r = await f.call("/me"); expect(r.status).toBe(503); expect(r.body).not.toContain("no minted signatures");
  });
  it("rejects expired or mismatched cursors without leaking details", async () => {
    const f = fixture(); f.projection.gallery.mockRejectedValue(new ProjectionCursorError("private cursor"));
    const r = await f.call("/me?after=cursor"); expect(r.status).toBe(400); expect(r.body).toContain("Restart collection pagination"); expect(r.body).not.toContain("private cursor");
  });
  it.each(["/about", "/robots.txt", "/"])("supplies navigation, correct composition and assets on %s", async path => {
    const f = fixture(), r = await f.call(path); expect(r.status).toBe(200); expect(f.runtime.sessions.session).not.toHaveBeenCalled();
    if (path === "/about") { expect(r.body).toContain("immutable inputs"); expect(r.body).toContain("not uploaded to IPFS"); }
    if (path === "/robots.txt") expect(r.body).toBe("User-agent: *\nDisallow: /\n");
    if (path === "/") { expect(r.body).toContain("http://127.0.0.1:12345/p/"); expect(r.body).toContain('src="/assets/generative-wallet.js"'); }
  });
  it.each(["/about?", "/me?owner=other", "/me?after=a&after=b", "/me?after=", "/me?after=%22", "/p/Alice/BOGUS", "/p/Alice/INTJ?mbti=ENFP",
    "/p/%ZZ/INTJ", "/p/%3Cscript%3E/INTJ", "/p/abcdefghijklmnop/INTJ", "/p/Alice/INTJ#hash", "/preview/Alice/XXXX.svg", "/preview/Alice/INTJ.svg?renderer=evil",
    "/preview/Alice/INTJ.svg?renderer=a&renderer=b", "/preview/Alice/INTJ.svg?mbti=ENFP", "/me?after=" + "x".repeat(4100)])("rejects malformed route %# before session or chain reads", async path => {
    const f = fixture(), r = await f.call(path); expect(r.status).toBeGreaterThanOrEqual(400);
    expect(f.runtime.sessions.session).not.toHaveBeenCalled(); expect(f.detail).not.toHaveBeenCalled(); expect(f.projection.gallery).not.toHaveBeenCalled();
  });
  it.each(["POST", "HEAD", "PUT"])("rejects %s before work", async method => {
    const f = fixture(), r = await f.call("/about", method); expect(r.status).toBe(405); expect(r.response.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });
  it.each([{ "transfer-encoding": "chunked" }, { "content-length": "1" }])("rejects GET body %#", async headers => {
    const f = fixture(); expect((await f.call("/me", "GET", headers)).status).toBe(400); expect(f.runtime.sessions.session).not.toHaveBeenCalled();
  });
  it("does not write to closed responses or expose unknown routes", async () => {
    const f = fixture(); expect((await f.call("/about", "GET", {}, true)).response.end).not.toHaveBeenCalled(); expect((await f.call("/admin")).handled).toBe(false);
  });
});
