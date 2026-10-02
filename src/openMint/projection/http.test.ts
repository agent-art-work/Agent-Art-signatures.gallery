import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleDigest } from "../identity.js";
import { createProjectionReadHandler, type ProjectionReads } from "./http.js";
import { ProjectionCursorError } from "./model.js";

function fixture() {
  const item = { tokenId: BigInt(handleDigest("alice")).toString(), availability: "available" as const, handle: "alice", mbti: "INTJ",
    artifactDigest: `0x${"a".repeat(64)}`, transactionHash: `0x${"b".repeat(64)}`, sessionHash: "SECRET", signature: "SECRET" };
  const reads = { gallery: vi.fn<ProjectionReads["gallery"]>().mockResolvedValue({ state: "confirmed", items: [item], snapshot: { number: "12", hash: "hash" } }),
    lookup: vi.fn<ProjectionReads["lookup"]>().mockResolvedValue({ state: "confirming", item }) };
  const handler = createProjectionReadHandler(reads);
  async function call(url = "/api/gallery", method = "GET", headers = {}) {
    let body = "";
    const output: Record<string, string> = {}, req = { url, method, headers, resume: vi.fn() } as unknown as IncomingMessage;
    const res = { statusCode: 200, setHeader(k: string, v: string) { output[k] = v; }, end(v: string) { body = v; } };
    const handled = await handler(req, res as unknown as ServerResponse);
    return { handled, status: res.statusCode, body, value: body ? JSON.parse(body) : undefined, headers: output };
  }
  return { item, reads, call };
}
describe("read-only projection HTTP contract", () => {
  it("allowlists finalized gallery fields and exposes no private evidence or raw rows", async () => {
    const f = fixture(), r = await f.call(); expect(r.status).toBe(200); expect(r.value.items).toHaveLength(1);
    expect(r.body).not.toContain("SECRET"); expect(r.headers["Cache-Control"]).toBe("no-store"); expect(r.headers["X-Robots-Tag"]).toContain("noindex");
    expect(f.reads.gallery).toHaveBeenCalledWith({ filter: { kind: "home" }, limit: 24, includeConfirming: true }); expect(f.reads.lookup).not.toHaveBeenCalled();
  });
  it.each(["confirming", "confirmed"] as const)("projects %s confidence without private session or authority payload", async state => {
    const f = fixture(); f.reads.lookup.mockResolvedValue({ state, item: f.item }); const r = await f.call("/api/signatures/alice/status");
    expect(r.status).toBe(200); expect(r.value.state).toBe(state === "confirmed" ? "minted" : "confirming"); expect(r.body).not.toContain("SECRET");
    expect(r.value).not.toHaveProperty("mbti"); expect(f.reads.gallery).not.toHaveBeenCalled();
  });
  it.each(["confirming", "confirmed"] as const)("exposes %s input and renderer binding, not legacy output identity", async state => {
    const f = fixture(), item = { ...f.item, artifactDigest: undefined, inputDigest: `0x${"d".repeat(64)}`, rendererIdentity: `0x${"e".repeat(64)}`, renderHandle: "Alice" };
    f.reads.lookup.mockResolvedValue({ state, item });
    const r = await f.call("/api/signatures/alice/status");
    expect(r.status).toBe(200); expect(r.value).toMatchObject({ inputDigest: item.inputDigest, rendererIdentity: item.rendererIdentity });
    for (const field of ["artifactDigest", "tokenURIHash", "mbti", "signature"]) expect(r.value).not.toHaveProperty(field);
    f.reads.gallery.mockResolvedValue({ state: "confirmed", items: [item] });
    expect((await f.call()).value.items[0]).toMatchObject({ renderHandle: "Alice", inputDigest: item.inputDigest });
    for (const patch of [{ rendererIdentity: undefined }, { artifactDigest: f.item.artifactDigest }, { tokenURIHash: item.inputDigest }]) {
      f.reads.lookup.mockResolvedValue({ state, item: { ...item, ...patch } }); expect((await f.call("/api/signatures/alice/status")).status).toBe(503);
    }
  });
  it.each(["unknown", "safety-halted", "pending"] as const)("%s never means unminted and never leaks artwork commitments", async state => {
    const f = fixture(); f.reads.lookup.mockResolvedValue({ state, item: f.item }); const r = await f.call("/api/signatures/alice/status");
    expect(r.status).toBe(503); expect(r.value.state).toBe("unknown"); expect(r.value).not.toHaveProperty("artifactDigest");
  });
  it.each(["unknown", "safety-halted"] as const)("withdraws %s gallery fields even if an adapter returns old items", async state => {
    const f = fixture(); f.reads.gallery.mockResolvedValue({ state, items: [f.item], nextCursor: "old", snapshot: { number: "12", hash: "old" } });
    expect((await f.call()).value).toEqual({ state, items: [] });
  });
  it.each([
    "/api/gallery?mbti=ENFP&limit=2&after=cursor", "/api/gallery?owner=0x0000000000000000000000000000000000000001",
  ])("accepts bounded public filter %s", async url => { expect((await fixture().call(url)).status).toBe(200); });
  it.each([
    "/api/gallery?foo=x", "/api/gallery?mbti=INTJ&mbti=ENFP", "/api/gallery?mbti=INTJ&owner=0x1", "/api/gallery?mbti=intj",
    "/api/gallery?owner=invalid", "/api/gallery?limit=0", "/api/gallery?limit=51", "/api/gallery?limit=01", "/api/gallery?after=",
    "/api/gallery?after=" + "a".repeat(2049), "/api/gallery?after=" + "a".repeat(4096), "/api/gallery?limit=1#fragment", "/api/signatures/alice/status?",
  ])("rejects malformed read case %# without work", async url => {
    const f = fixture(), result = await f.call(url); expect(result.status).toBe(400); expect(f.reads.gallery).not.toHaveBeenCalled(); expect(f.reads.lookup).not.toHaveBeenCalled();
  });
  it.each(["POST", "PUT", "DELETE", "HEAD"])("rejects %s without allocating a session or syncing", async method => {
    const f = fixture(), result = await f.call("/api/gallery", method); expect(result.status).toBe(405); expect(result.headers.Allow).toBe("GET"); expect(f.reads.gallery).not.toHaveBeenCalled();
  });
  it.each([{ "transfer-encoding": "chunked" }, { "content-length": "1" }])("rejects GET bodies %#", async headers => { expect((await fixture().call("/api/gallery", "GET", headers)).status).toBe(400); });
  it.each(["/api/session", "/api/signatures/ALICE/status", "/dev/mint", "https://other.example/api/gallery"])("leaves other routes to the enclosing server: %s", async url => {
    const f = fixture(); expect((await f.call(url)).handled).toBe(false); expect(f.reads.gallery).not.toHaveBeenCalled();
  });
  it("returns safe cursor errors and strips credential-bearing internal failures", async () => {
    const f = fixture(); f.reads.gallery.mockRejectedValue(new ProjectionCursorError("PRIVATE"));
    expect((await f.call()).value).toEqual({ code: "INVALID_CURSOR", error: "Restart gallery pagination." });
    f.reads.gallery.mockRejectedValue(new Error("https://rpc.example/SECRET")); const r = await f.call(); expect(r.status).toBe(503); expect(r.body).not.toContain("SECRET");
  });
  it("quarantines corrupt entries and refuses mismatched reveal identity", async () => {
    const f = fixture(); f.reads.gallery.mockResolvedValue({ state: "confirmed", items: [{ ...f.item, availability: "quarantined" }], nextCursor: "next" });
    expect((await f.call()).value.items).toEqual([{ tokenId: f.item.tokenId, availability: "quarantined" }]);
    for (const changes of [{ handle: "bob" }, { tokenId: "1" }, { availability: "quarantined" as const }, { transactionHash: undefined }, { artifactDigest: undefined }]) {
      f.reads.lookup.mockResolvedValue({ state: "confirmed", item: { ...f.item, ...changes } }); expect((await f.call("/api/signatures/alice/status")).status).toBe(503);
    }
  });
  it("does not write to a closed HTTP response", async () => {
    const f = fixture(), res = { destroyed: true, setHeader: vi.fn(), end: vi.fn() };
    await createProjectionReadHandler(f.reads)({ url: "/api/gallery", method: "GET", headers: {}, resume() {} } as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.end).not.toHaveBeenCalled();
  });
});
