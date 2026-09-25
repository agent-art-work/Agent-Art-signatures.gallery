import { generateKeyPairSync, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createReadinessReview } from "./readinessReview.js";
import { readinessReviewFixture } from "./fixtures/readinessReview.js";

describe("separate read-only readiness review", () => {
  it("verifies current signed review each time; withdrawal/halt are sticky", () => {
    const f = readinessReviewFixture(), read = vi.spyOn(f.source, "readCurrent"), review = createReadinessReview(f.source, f.scopeSha256);
    review.require(f.now); review.require(f.now + 1); expect(read).toHaveBeenCalledTimes(2);
    const saved = f.source.readCurrent(); f.withdraw(); expect(() => review.require(f.now + 2)).toThrow();
    f.set(saved); expect(() => review.require(f.now + 3)).toThrow();
    const next = createReadinessReview(f.source, f.scopeSha256); next.halt(); expect(() => next.require(f.now)).toThrow();
  });
  it("captures pins and refuses review revision rotation without a new startup", () => {
    const f = readinessReviewFixture(), r = createReadinessReview(f.source, f.scopeSha256);
    f.replace({ ...f.body, evidenceSha256: "c".repeat(64) }); expect(() => r.require(f.now)).toThrow();
    expect(() => createReadinessReview(f.source, f.scopeSha256).require(f.now)).not.toThrow();
  });
  it.each([null, {}, [], { extra: true }, Object.create({ inherited: true })])("rejects malformed source %j", input => {
    expect(() => createReadinessReview(input as never, "a".repeat(64))).toThrow();
  });
  it.each(["publicKeyPem", "publicKeySpkiSha256", "revisionSha256", "readCurrent"])("refuses getter %s without invoking it", key => {
    const f = readinessReviewFixture(), getter = vi.fn(); Object.defineProperty(f.source, key, { get: getter, enumerable: true });
    expect(() => createReadinessReview(f.source, f.scopeSha256)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    ["publicKeyPem", "-----BEGIN PRIVATE KEY-----SECRET"], ["publicKeyPem", "x".repeat(1025)],
    ["publicKeyPem", "-----BEGIN PUBLIC KEY-----garbage"], ["publicKeySpkiSha256", "f".repeat(64)],
    ["publicKeySpkiSha256", "0".repeat(64)], ["revisionSha256", "A".repeat(64)], ["readCurrent", null],
  ])("refuses bad %s (%#)", (key, value) => {
    const f = readinessReviewFixture(); Object.assign(f.source, { [key]: value });
    expect(() => createReadinessReview(f.source, f.scopeSha256)).toThrow("Staging readiness review unavailable.");
  });
  it("refuses a different key algorithm even with matching fingerprint", () => {
    const f = readinessReviewFixture(), { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    f.source.publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    f.source.publicKeySpkiSha256 = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
    expect(() => createReadinessReview(f.source, f.scopeSha256)).toThrow();
  });
  it.each([NaN, -1, 1.5, 1799999999999, 1800000060000])("refuses invalid/outside review time %s", now => {
    const f = readinessReviewFixture(); expect(() => createReadinessReview(f.source, f.scopeSha256).require(now)).toThrow();
  });
  it("refuses clock regression", () => {
    const f = readinessReviewFixture(), r = createReadinessReview(f.source, f.scopeSha256); r.require(f.now + 1);
    expect(() => r.require(f.now)).toThrow();
  });
  it.each([
    { version: "sg-local-review-v1" }, { scopeSha256: "c".repeat(64) }, { evidenceSha256: "0".repeat(64) },
    { validFrom: "1800000000000" }, { validUntil: "1800000060000" }, { validUntil: 1800000000000 },
    { validUntil: 1800000000000 + 32 * 86400000 }, { extra: true }, { validFrom: -1 },
  ])("refuses signed wrong-domain/malformed payload %j", patch => {
    const f = readinessReviewFixture(); f.replace({ ...f.body, ...patch });
    expect(() => createReadinessReview(f.source, f.scopeSha256).require(f.now)).toThrow();
  });
  it("refuses noncanonical encoding, tampered signatures, malformed and oversized envelopes", () => {
    const f = readinessReviewFixture(); f.replace(f.body, false);
    expect(() => createReadinessReview(f.source, f.scopeSha256).require(f.now)).toThrow();
    for (const value of [undefined, { payload: "x".repeat(16385), signature: "1".repeat(128) },
      { ...f.source.readCurrent()!, signature: "1".repeat(128) }, { ...f.source.readCurrent()!, signature: "ff" },
      { payload: "{}", signature: "1".repeat(128), extra: true }]) {
      f.set(value); expect(() => createReadinessReview(f.source, f.scopeSha256).require(f.now)).toThrow();
    }
  });
});
