import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { admissionDigest } from "./admission.js";
import { admissionFixture } from "./fixtures/admission.js";
import { stagingReviewFixture } from "./fixtures/stagingReview.js";
import { createStagingOperationReview } from "./stagingReview.js";

const fixture = (patch: Record<string, unknown> = {}, encode?: (body: unknown) => string) => {
  const base = admissionFixture(), f = stagingReviewFixture(base.scope, patch, encode);
  const r = () => createStagingOperationReview(f.source, f.scope);
  return { ...f, now: base.now(), r, check: () => r().requireReview(admissionDigest(f.scope), "assessment-x", base.now()) };
};
describe("independently pinned staging operation review", () => {
  it("rechecks signed operation/scope evidence; withdrawal, halt and invalid use stay revoked", () => {
    const f = fixture(), read = vi.spyOn(f.source, "readCurrent"), r = f.r(), sha = admissionDigest(f.scope);
    for (const op of ["reuse", "assessment-x", "assessment-grok"] as const) r.requireReview(sha, op, f.now);
    expect(read).toHaveBeenCalledTimes(3); const saved = f.source.readCurrent();
    f.withdraw(); expect(() => r.requireReview(sha, "reuse", f.now)).toThrow();
    f.replace(saved); expect(() => r.requireReview(sha, "reuse", f.now)).toThrow();
    const next = f.r(); next.halt(); expect(() => next.requireReview(sha, "reuse", f.now)).toThrow();
    expect(() => f.r().requireReview(sha, "sign", f.now)).toThrow();
  });
  it("refuses scope mismatch and regressing time", () => {
    const f = fixture(), r = f.r(), sha = admissionDigest(f.scope); r.requireReview(sha, "reuse", f.now + 1);
    expect(() => r.requireReview(sha, "reuse", f.now)).toThrow();
    expect(() => f.r().requireReview("a".repeat(64), "reuse", f.now)).toThrow();
    expect(() => createStagingOperationReview(f.source, { ...f.scope, writerEpoch: "2" }).requireReview(
      admissionDigest({ ...f.scope, writerEpoch: "2" }), "reuse", f.now)).toThrow();
  });
  it.each([null, {}, [], { extra: true }, Object.create({ inherited: true })])("refuses malformed source (%#)", source => {
    expect(() => createStagingOperationReview(source as never, fixture().scope)).toThrow();
  });
  it.each(["publicKeyPem", "publicKeySpkiSha256", "revisionSha256", "readCurrent"])("refuses getter %s without calling it", name => {
    const f = fixture(), get = vi.fn(); Object.defineProperty(f.source, name, { get, enumerable: true });
    expect(f.r).toThrow(); expect(get).not.toHaveBeenCalled();
  });
  it.each([
    ["publicKeyPem", "-----BEGIN PRIVATE KEY-----SECRET"], ["publicKeyPem", "x".repeat(1025)],
    ["publicKeyPem", "-----BEGIN PUBLIC KEY-----garbage"], ["publicKeySpkiSha256", "f".repeat(64)],
    ["publicKeySpkiSha256", "0".repeat(64)], ["revisionSha256", "A".repeat(64)], ["readCurrent", null],
  ])("refuses bad pinned %s (%#)", (name, value) => { const f = fixture(); Object.assign(f.source, { [name]: value }); expect(f.r).toThrow(); });
  it("requires Ed25519 even with an accurately pinned different key algorithm", () => {
    const f = fixture(), { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    f.source.publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    f.source.publicKeySpkiSha256 = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
    expect(f.r).toThrow();
  });
  it.each([NaN, -1, 1.5, 1799999998000, 1800000010000])("refuses invalid/outside review time %s", now => {
    const f = fixture(); expect(() => f.r().requireReview(admissionDigest(f.scope), "reuse", now)).toThrow();
  });
  it.each([
    { version: "sg-local-review-v1" }, { version: "sg-paused-readiness-review-v1" }, { scope: {} }, { evidenceSha256: "0".repeat(64) },
    { operations: [] }, { operations: ["assessment-x", "reuse"] }, { operations: ["reuse", "reuse", "assessment-x"] },
    { operations: ["unknown", "assessment-x"] }, { operations: "assessment-x" }, { operations: ["sign"] },
    { validFrom: "1800000000000" }, { validUntil: "1800000060000" }, { validUntil: 1799999999000 },
    { validUntil: 1800000000000 + 32 * 86400000 }, { validFrom: -1 }, { extra: true },
  ])("refuses correctly signed invalid review body (%#)", patch => { expect(fixture(patch).check).toThrow(); });
  it.each([() => "{}", () => "not-json", (v: unknown) => JSON.stringify(v, null, 2)])("refuses signed noncanonical/malformed encoding (%#)", encode => {
    expect(fixture({}, encode).check).toThrow();
  });
  it.each([undefined, { payload: "x".repeat(16385), signature: "1".repeat(128) }, { payload: "{}", signature: "1".repeat(128) },
    { payload: "{}", signature: "ff" }, { payload: "{}", signature: "1".repeat(128), extra: true }])("refuses malformed envelope (%#)", value => {
    const f = fixture(); f.replace(value); expect(f.check).toThrow();
  });
  it("refuses forged signature, no-op pin replacement and throwing source", () => {
    const f = fixture(), r = f.r(); f.replace({ ...f.source.readCurrent()!, signature: "1".repeat(128) }); expect(f.check).toThrow();
    f.source.readCurrent = () => { throw Error("SECRET"); }; expect(() => r.requireReview(admissionDigest(f.scope), "reuse", f.now)).toThrow("Staging operation review unavailable.");
  });
});
