import { describe, expect, it, vi } from "vitest";
import { assessmentDigest, type Assessment } from "../assessment.js";
import { syntheticPublicAssessment } from "../fixtures/publicAssessment.js";
import { generativeProjectionFixture } from "../fixtures/generativeProjectionRpc.js";
import { testAddress as a, testHash as h } from "../fixtures/projectionRpc.js";
import { assessmentPage } from "../pages.js";
import { createGenerativeArtworkReads } from "./generativeArtwork.js";
import { generativeAssessmentProvenance } from "./generativeProvenance.js";
import type { ProjectionReads } from "./http.js";
import type { ProjectedMint } from "./postgres.js";

const signal = () => new AbortController().signal;
function fixture(profile: "generative-experimental-v1" | "generative-v1-rc1" = "generative-v1-rc1", provenanceTimeoutMs = 1000) {
  const f = generativeProjectionFixture(profile), assessment = syntheticPublicAssessment();
  const mint: ProjectedMint = { tokenId: f.tokenId, availability: "available", handle: f.inputs.canonicalHandle,
    renderHandle: f.inputs.renderHandle, mbti: f.inputs.mbti, inputDigest: f.inputs.digest,
    rendererIdentity: f.inputs.rendererIdentity, assessmentDigest: f.inputs.assessmentDigest,
    originalRecipient: a(1), currentOwner: a(3), transactionHash: h(200), authorizationDigest: h(501), inclusion: { number: "11", hash: h(11) } };
  const lookup = vi.fn<ProjectionReads["lookup"]>().mockResolvedValue({ state: "confirming", item: mint });
  // Successful enrichment tests are not microbenchmarks: allow the validated
  // source's maximum budget under suite-wide CPU contention. Deadline-specific
  // cases opt into the narrow budget they deliberately exercise.
  const source = { timeoutMs: provenanceTimeoutMs, loadAccepted: vi.fn(async (_handle: string, _digest: string, _signal: AbortSignal): Promise<unknown> => assessment) };
  const options = { ...f.options, projection: { lookup }, timeoutMs: 2000, provenance: source };
  return { ...f, assessment, mint, lookup, source, options, reads: createGenerativeArtworkReads(options) };
}
const publicKeys = ["assessedAt", "assessmentModel", "assessmentProvenance", "assessmentSourceUrls", "identityVerifiedAt", "verifiedXUserId"];

describe("exact accepted assessment enrichment, never a new assessment", () => {
  it.each(["generative-experimental-v1", "generative-v1-rc1"] as const)("joins %s only after inclusion and preserves immutable chain output", async profile => {
    const f = fixture(profile);
    for (const state of ["confirming", "confirmed"] as const) {
      f.lookup.mockResolvedValue({ state, item: f.mint });
      const page = await f.reads.detail(f.inputs.canonicalHandle, signal());
      expect(page).toMatchObject({ assessmentProvenance: "grok", assessmentModel: "grok-4.3", assessedAt: f.assessment.createdAt,
        assessmentSourceUrls: ["https://x.com/Alice_Bob_Key/status/123"], verifiedXUserId: "123", identityVerifiedAt: f.assessment.xIdentity!.verifiedAt,
        mbti: "INTJ", renderHandle: "Alice_Bob_Key", assessmentDigest: f.assessment.digest,
        mint: { state: state === "confirmed" ? "minted" : "confirming" } });
      expect(f.source.loadAccepted).toHaveBeenLastCalledWith(f.inputs.canonicalHandle, f.assessment.digest, expect.any(AbortSignal));
      expect(f.source.loadAccepted.mock.calls.at(-1)![2].aborted).toBe(true);
      const html = assessmentPage(page);
      expect(html).toContain("Grok selected this MBTI"); expect(html).toContain("not a cryptographic signature from Grok");
      expect(html).not.toMatch(/private-response-id|private-reference|tracking=|token=secret|11111111-1111-4111/);
      expect(html).toContain('referrerpolicy="no-referrer"');
      const { provenance: _source, ...plain } = f.options;
      const bare = await createGenerativeArtworkReads(plain).detail(f.inputs.canonicalHandle, signal());
      const without = Object.fromEntries(Object.entries(page).filter(([key]) => !publicKeys.includes(key)));
      expect(without).toEqual(bare);
    }
    const count = f.source.loadAccepted.mock.calls.length;
    for (const kind of ["svg", "png", "metadata"] as const) await f.reads.media(f.inputs.canonicalHandle, f.inputs.digest, kind, signal());
    await f.reads.sharingPng(f.inputs.canonicalHandle, f.inputs.digest, signal());
    expect(f.source.loadAccepted).toHaveBeenCalledTimes(count);
  });
  it.each(["unknown", "pending", "safety-halted"] as const)("never reads private provenance before verified reveal: %s", async state => {
    const f = fixture(); f.lookup.mockResolvedValue({ state, item: f.mint });
    await expect(f.reads.detail(f.inputs.canonicalHandle, signal())).rejects.toThrow("unavailable");
    expect(f.source.loadAccepted).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0);
  });
  it("does not consult the private source when chain input verification fails", async () => {
    const f = fixture(); f.mutate((result, call) => call.name === "inputs" ? "0x" : result);
    await expect(f.reads.detail(f.inputs.canonicalHandle, signal())).rejects.toThrow(); expect(f.source.loadAccepted).not.toHaveBeenCalled();
  });
  it.each(["absent", "unavailable", "malformed", "mismatch"])("keeps verified art with Not recorded for %s evidence", async mode => {
    const f = fixture();
    if (mode === "unavailable") f.source.loadAccepted.mockRejectedValue(new Error("secret DB connection"));
    else f.source.loadAccepted.mockResolvedValue(mode === "absent" ? undefined : mode === "malformed" ? { ...f.assessment, prompt: "secret" } : { ...f.assessment, digest: h(55) });
    const page = await f.reads.detail(f.inputs.canonicalHandle, signal());
    for (const key of publicKeys) expect(page).not.toHaveProperty(key);
    expect(page.imageUrl).toContain(f.inputs.digest); const html = assessmentPage(page);
    expect(html).toContain("Not recorded"); expect(html).not.toContain("secret"); expect(html).not.toContain("grok-4.3");
  });
  it("bounds a stalled optional read, rejects its late enrichment and drains its cleanup", async () => {
    const f = fixture(undefined, 20); let release!: (value: unknown) => void;
    f.source.loadAccepted.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const page = await f.reads.detail(f.inputs.canonicalHandle, signal());
    expect(page).not.toHaveProperty("assessmentProvenance"); expect(f.source.loadAccepted.mock.calls[0][2].aborted).toBe(true);
    let drained = false; const draining = f.reads.drain().then(() => { drained = true; }); await Promise.resolve(); expect(drained).toBe(false);
    release(f.assessment); await draining; expect(drained).toBe(true); expect(page).not.toHaveProperty("assessmentProvenance");
    expect(f.source.loadAccepted).toHaveBeenCalledOnce();
  });
  it("aborts during a private read without returning provenance or orphaning cleanup", async () => {
    const f = fixture(), c = new AbortController();
    f.source.loadAccepted.mockImplementation(async () => { c.abort(); return f.assessment; });
    await expect(f.reads.detail(f.inputs.canonicalHandle, c.signal)).rejects.toThrow("unavailable"); await f.reads.drain();
    expect(f.source.loadAccepted.mock.calls[0][2].aborted).toBe(true);
  });
  it("drain also owns optional DB work created after the initial chain-read snapshot", async () => {
    const f = fixture(undefined, 20); let release!: (value: unknown) => void;
    f.source.loadAccepted.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const page = f.reads.detail(f.inputs.canonicalHandle, signal());
    let drained = false; const draining = f.reads.drain().then(() => { drained = true; });
    expect((await page).assessmentModel).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
    release(f.assessment); await draining; expect(drained).toBe(true);
  });
  it("rechecks projection after enrichment and withdraws a reorg/stale result", async () => {
    const f = fixture(); f.source.loadAccepted.mockImplementation(async () => { f.lookup.mockResolvedValue({ state: "unknown" }); return f.assessment; });
    await expect(f.reads.detail(f.inputs.canonicalHandle, signal())).rejects.toThrow("unavailable");
  });
  it("withholds a response past its monotonic deadline even before the timer callback runs", async () => {
    const f = fixture(undefined, 20);
    f.source.loadAccepted.mockImplementation(async () => {
      const until = performance.now() + 30; while (performance.now() < until) { /* Delayed event-loop timer. */ }
      return f.assessment;
    });
    const page = await f.reads.detail(f.inputs.canonicalHandle, signal());
    expect(page.assessmentModel).toBeUndefined(); expect(page.imageUrl).toContain(f.inputs.digest);
  });
  it("captures the trusted source and its timeout rather than later caller mutations", async () => {
    const f = fixture(); f.source.loadAccepted = vi.fn().mockRejectedValue(new Error("replacement")); f.source.timeoutMs = 0;
    expect((await f.reads.detail(f.inputs.canonicalHandle, signal())).assessmentModel).toBe("grok-4.3");
    expect(f.source.loadAccepted).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, 1001, 1.5])("refuses invalid optional-read deadline %s", timeoutMs => {
    const f = fixture(); expect(() => createGenerativeArtworkReads({ ...f.options, provenance: { ...f.source, timeoutMs } })).toThrow();
  });
  it("refuses a non-reader source", () => {
    const f = fixture(); expect(() => createGenerativeArtworkReads({ ...f.options, provenance: { ...f.source, loadAccepted: null as never } })).toThrow();
  });
  it("allowlists public fields and strips query/fragment from deduplicated X citations", () => {
    const f = fixture(), publicRecord = generativeAssessmentProvenance(f.assessment, f.inputs);
    expect(Object.keys(publicRecord).sort()).toEqual([...publicKeys].sort());
    expect(Object.isFrozen(publicRecord)).toBe(true); expect(Object.isFrozen(publicRecord.assessmentSourceUrls)).toBe(true);
  });
  it.each(["handle", "spelling", "mbti", "identity", "fixture", "legacy", "policy", "model", "time", "sources", "commitment", "extra"])("rejects %s inconsistencies even when supplied as a stored record", mode => {
    const f = fixture(), value = structuredClone(f.assessment) as Assessment;
    if (mode === "handle") Object.assign(value, { handle: "different", xIdentity: { ...value.xIdentity, username: "Different", canonicalHandle: "different" } });
    if (mode === "spelling") Object.assign(value, { xIdentity: { ...value.xIdentity, username: "alice_bob_key" } });
    if (mode === "mbti") Object.assign(value, { mbti: "ENFP" });
    if (mode === "identity") delete (value as { xIdentity?: unknown }).xIdentity;
    if (mode === "fixture") Object.assign(value, { provenance: "development-fixture", model: "development-fixture-v1", providerResponseId: "development-fixture:1", xIdentity: { ...value.xIdentity, provenance: "development-fixture" } });
    if (mode === "legacy") Object.assign(value, { rendererVersion: "sg-renderer-1.0.0" });
    if (mode === "policy") Object.assign(value, { policyVersion: "future" });
    if (mode === "model") Object.assign(value, { model: "not-grok" });
    if (mode === "time") Object.assign(value, { createdAt: "yesterday" });
    if (mode === "sources") Object.assign(value, { sourceUrls: ["javascript:alert(1)"] });
    if (mode === "extra") Object.assign(value, { reasoning: "private" });
    // Independent identity/input checks must survive even a new matching digest.
    if (["handle", "spelling", "mbti", "identity", "fixture"].includes(mode)) {
      Object.assign(value, { digest: assessmentDigest(value) });
      expect(() => generativeAssessmentProvenance(value, { ...f.inputs, assessmentDigest: value.digest })).toThrow();
    } else {
      if (mode === "commitment") Object.assign(value, { digest: h(99) });
      expect(() => generativeAssessmentProvenance(value, f.inputs)).toThrow();
    }
  });
});
