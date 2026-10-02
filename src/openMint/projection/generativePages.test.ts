import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createGenerativeGalleryPages } from "./generativePages.js";
import type { ProjectionReads } from "./http.js";
import type { AssessmentPageModel } from "../pages.js";
import { handleDigest } from "../identity.js";
import { FAVICON_URL } from "../../brand/favicon.js";
import { SLOGAN_MBTI_HERO_SCRIPT_URL } from "../../brand/sloganMbtiHero.js";
import { SLOGAN_TOOLTIP_SCRIPT_URL } from "../../brand/sloganTooltipScript.js";
import { SITE_FONT_PRELOAD } from "../../v1/fonts.js";

const hash = (c: string) => `0x${c.repeat(64)}`;
function fixture() {
  const item = { tokenId: BigInt(handleDigest("alice_bob_key")).toString(), handle: "alice_bob_key", renderHandle: "Alice_Bob_Key", mbti: "INTJ",
    availability: "available" as const, inputDigest: hash("a"), rendererIdentity: hash("b"), transactionHash: hash("c") };
  const model: AssessmentPageModel = { ...item, code: "", status: "ready", canMint: false,
    rendererVersion: "experimental-fixed18-not-locked", imageUrl: `/api/signatures/${item.handle}/artwork/${item.inputDigest}/svg`,
    mint: { state: "confirming", tokenId: item.tokenId, transactionHash: item.transactionHash } };
  const projection = { lookup: vi.fn<ProjectionReads["lookup"]>(),
    gallery: vi.fn<ProjectionReads["gallery"]>().mockResolvedValue({ state: "confirmed", items: [item] }) };
  const detail = vi.fn<(h: string, s: AbortSignal) => Promise<AssessmentPageModel>>().mockResolvedValue(model);
  const handler = createGenerativeGalleryPages({ projection, artwork: { detail } });
  async function call(url = "/", method = "GET", headers = {}, destroyed = false) {
    const response = Object.assign(new EventEmitter(), { statusCode: 200, destroyed, writableEnded: false,
      setHeader: vi.fn(), end: vi.fn() });
    const handled = await handler({ url, method, headers } as IncomingMessage, response as unknown as ServerResponse);
    return { handled, status: response.statusCode, body: String(response.end.mock.calls[0]?.[0] ?? ""), response };
  }
  return { call, item, model, projection, detail };
}

describe("explicit read-only generative gallery pages", () => {
  it.each(["/", "/INTJ/", "/?after=cursor"])("renders an inclusion-aware gallery %s with case-preserved caption and input-bound media", async path => {
    const f = fixture(), r = await f.call(path);
    expect(r.status).toBe(200); expect(r.body).toContain("@Alice_Bob_Key"); expect(r.body).toContain("INTJ");
    expect(r.body).toContain(`/api/signatures/${f.item.handle}/artwork/${f.item.inputDigest}/svg`);
    expect(r.body).toContain('href="/p/Alice_Bob_Key/variations"'); expect(r.body).toContain('href="/INTJ/"');
    expect(r.body).not.toContain("data-mint-entry"); expect(f.detail).not.toHaveBeenCalled();
    expect(r.body).not.toMatch(/rel="canonical"|property="og:|name="twitter:/);
    expect(f.projection.gallery).toHaveBeenCalledWith({ filter: path.includes("INTJ") ? { kind: "mbti", value: "INTJ" } : { kind: "home" }, limit: 24, includeConfirming: true,
      ...(path.includes("after") ? { cursor: "cursor" } : {}) });
    expect(r.response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(r.response.setHeader).toHaveBeenCalledWith("Content-Security-Policy", expect.stringContaining("form-action 'none'"));
  });
  it.each(["confirming", "minted"] as const)("renders %s from verified detail, with no wallet or provider client", async state => {
    const f = fixture(); f.detail.mockResolvedValue({ ...f.model, mint: { ...f.model.mint!, state } });
    const r = await f.call("/signatures/alice_bob_key");
    expect(r.status).toBe(200); expect(r.body).toContain(`data-mint-state="${state}"`);
    expect(r.body).not.toMatch(/rel="canonical"|property="og:|name="twitter:/);
    expect(r.body).toContain('src="/assets/generative-reveal.js"'); expect(r.body).not.toContain("data-reveal-artifact");
    if (state === "confirming") expect(r.body).toContain(`data-reveal-input="${f.item.inputDigest}"`);
    expect(f.detail.mock.calls[0][1].aborted).toBe(true); expect(f.projection.gallery).not.toHaveBeenCalled();
    expect(r.response.listenerCount("close")).toBe(0);
  });
  it("renders only bounded safe pagination cursors", async () => {
    const f = fixture(); f.projection.gallery.mockResolvedValue({ state: "confirmed", items: [f.item], nextCursor: "next_cursor-1" });
    expect((await f.call("/INTJ/")).body).toContain('href="/INTJ/?after=next_cursor-1"');
    for (const nextCursor of ['"><script>', "x".repeat(2049)]) {
      f.projection.gallery.mockResolvedValue({ state: "confirmed", items: [f.item], nextCursor });
      expect((await f.call()).status).toBe(503);
    }
  });
  it.each(["unknown", "safety-halted"] as const)("withdraws %s galleries instead of showing stale cards", async state => {
    const f = fixture(); f.projection.gallery.mockResolvedValue({ state, items: [f.item] });
    const r = await f.call(); expect(r.status).toBe(503); expect(r.body).not.toContain("Alice_Bob_Key");
    expect(r.body).toContain("This page could not be loaded right now.");
    expect(r.body).not.toContain("Mint status cannot be verified");
  });
  it.each([{ availability: "quarantined" }, { handle: undefined }, { renderHandle: undefined }, { inputDigest: undefined },
    { rendererIdentity: undefined }, { artifactDigest: hash("e") }, { mbti: "BOGUS" }])("refuses mixed or incomplete gallery identity %#", async patch => {
    const f = fixture(); f.projection.gallery.mockResolvedValue({ state: "confirmed", items: [{ ...f.item, ...patch } as typeof f.item] });
    expect((await f.call()).status).toBe(503);
  });
  it.each(["/?foo=bar", "/?after=a&after=b", "/?after=", "/?after=%22", "/?after=" + "a".repeat(2049), "/?after=x#fragment", "/?" + "a".repeat(4100), "/signatures/alice_bob_key?"])("rejects malformed page route %# before reads", async url => {
    const f = fixture(); expect((await f.call(url)).status).toBe(503); expect(f.detail).not.toHaveBeenCalled(); expect(f.projection.gallery).not.toHaveBeenCalled();
  });
  it.each(["POST", "HEAD", "PUT"])("rejects %s before reading", async method => {
    const f = fixture(), r = await f.call("/", method); expect(r.status).toBe(405); expect(r.response.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(f.projection.gallery).not.toHaveBeenCalled();
  });
  it.each([{ "transfer-encoding": "chunked" }, { "content-length": "1" }])("rejects request bodies %#", async headers => {
    const f = fixture(); expect((await f.call("/", "GET", headers)).status).toBe(503); expect(f.projection.gallery).not.toHaveBeenCalled();
  });
  it.each(["/mint", "/me", "/api/session", "/INVALID/", "/signatures/Alice", "https://other.example/"])("does not take over unsupported route %s", async url => {
    const f = fixture(); expect((await f.call(url)).handled).toBe(false); expect(f.projection.gallery).not.toHaveBeenCalled();
  });
  it.each(["/assets/generative-gallery.css", "/assets/generative-reveal.js", FAVICON_URL, SLOGAN_MBTI_HERO_SCRIPT_URL, SLOGAN_TOOLTIP_SCRIPT_URL])("serves explicit static dependency %s without assessment or chain work", async url => {
    const f = fixture(), r = await f.call(url); expect(r.status).toBe(200); expect(r.body.length).toBeGreaterThan(10); expect(f.detail).not.toHaveBeenCalled();
    expect(f.projection.gallery).not.toHaveBeenCalled();
    if (url.includes("reveal.js")) { expect(r.body).not.toContain("eth_sendTransaction"); expect(r.body).not.toContain("/api/mints/authorize"); }
  });
  it("redacts internal failures and does not write to a closed response", async () => {
    const f = fixture(); f.detail.mockRejectedValue(new Error("https://rpc/SECRET"));
    const r = await f.call("/signatures/alice_bob_key"); expect(r.status).toBe(503); expect(r.body).not.toContain("SECRET");
    expect(r.body).toContain("This page could not be loaded right now.");
    expect(r.body).not.toContain("No new assessment or mint was requested");
    expect((await f.call("/", "GET", {}, true)).response.end).not.toHaveBeenCalled();
  });
  it("serves pinned fonts and refuses query parameters on them", async () => {
    const f = fixture(), path = /href="([^"]+)"/.exec(SITE_FONT_PRELOAD)![1];
    const r = await f.call(path); expect(r.status).toBe(200); expect(r.response.setHeader).toHaveBeenCalledWith("Content-Type", "font/woff2");
    expect((await f.call(path + "?after=a")).status).toBe(503); expect(f.projection.gallery).not.toHaveBeenCalled();
  });
});
