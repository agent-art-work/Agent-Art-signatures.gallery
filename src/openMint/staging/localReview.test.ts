import { generateKeyPairSync, sign } from "node:crypto";
import canonicalize from "canonicalize";
import { describe, expect, it } from "vitest";
import { ADMISSION_OPERATIONS, admissionDigest } from "./admission.js";
import { admissionFixture } from "./fixtures/admission.js";
import { localReviewFixture } from "./fixtures/localReview.js";
import { createLocalAdmissionReview, type LocalAdmissionReview } from "./localReview.js";

const fixture = (overrides: Partial<LocalAdmissionReview> = {}) => localReviewFixture(admissionFixture().scope, overrides);
describe("signed local rehearsal review source (not public approval)", () => {
  it("requires a current signed exact revision on every checkpoint", () => {
    const h = fixture({ operations: ADMISSION_OPERATIONS }), digest = admissionDigest(h.scope);
    for (const op of ADMISSION_OPERATIONS) expect(h.review.requireReview(digest, op, Date.now())).toBeUndefined();
    h.source.current = undefined;
    expect(() => h.review.requireReview(digest, "reuse", Date.now())).toThrow("unavailable");
    h.source.current = h.envelope;
    expect(() => h.review.requireReview(digest, "reuse", Date.now())).toThrow("unavailable");
  });
  it.each(["scope", "operation", "halt", "backward", "expired", "future", "missing", "async", "extra", "accessor", "oversize", "signature", "payload", "revision", "noncanonical", "json"])("rejects %s", scenario => {
    const h = fixture(), digest = admissionDigest(h.scope), now = Date.now();
    let time = now, hash = digest, operation = "reuse" as typeof ADMISSION_OPERATIONS[number];
    if (scenario === "scope") hash = "a".repeat(64);
    if (scenario === "operation") operation = "assessment-grok";
    if (scenario === "halt") h.review.halt();
    if (scenario === "backward") { h.review.requireReview(digest, "reuse", now); time--; }
    if (scenario === "expired") time = h.body.validUntil;
    if (scenario === "future") time = h.body.validFrom - 1;
    if (scenario === "missing") h.source.current = undefined;
    if (scenario === "async") h.source.current = Promise.resolve(h.envelope) as never;
    if (scenario === "extra") h.source.current = { ...h.envelope, approved: true } as never;
    if (scenario === "accessor") h.source.current = Object.defineProperty({ signature: h.envelope.signature }, "payload", { get() { throw Error("never evaluate getter"); }, enumerable: true }) as never;
    if (scenario === "oversize") h.source.current = { ...h.envelope, payload: " ".repeat(16385) };
    if (scenario === "signature") h.source.current = { ...h.envelope, signature: "00".repeat(64) };
    if (scenario === "payload") h.source.current = { ...h.envelope, payload: h.envelope.payload.replace("reuse", "read") };
    if (scenario === "revision") h.source.current = fixture({ operations: ["read", "reuse"] }).envelope;
    if (["noncanonical", "json"].includes(scenario)) {
      const payload = scenario === "json" ? "not json" : JSON.stringify(h.body, null, 2);
      h.source.current = { payload, signature: sign(null, Buffer.from(payload), h.privateKey).toString("hex") };
    }
    expect(() => h.review.requireReview(hash, operation, time)).toThrow("unavailable");
  });
  it.each([
    { version: "public-admission-review-v1" }, { evidenceSha256: "0".repeat(64) }, { operations: [] },
    { operations: ["reuse", "reuse"] }, { operations: ["reuse", "read"] }, { operations: ["unknown"] },
    { operations: null }, { validFrom: -1 }, { validUntil: 0 }, { validUntil: Number.MAX_SAFE_INTEGER },
    { validFrom: 1.5 }, { validUntil: "later" },
  ])("rejects signed malformed review material %j", overrides => {
    const h = fixture(overrides as Partial<LocalAdmissionReview>);
    expect(() => h.review.requireReview(admissionDigest(h.scope), "reuse", Date.now())).toThrow("unavailable");
  });
  it("does not let a valid signature authorize a crossed database/writer/spend scope", () => {
    const h = fixture(); h.config.scope = { ...h.scope, writerEpoch: "999", databaseBindingSha256: "d".repeat(64), paidValidUntil: h.scope.paidValidUntil + 1 };
    const review = createLocalAdmissionReview(h.config);
    expect(() => review.requireReview(admissionDigest(h.config.scope), "reuse", Date.now())).toThrow("unavailable");
  });
  it("pins the review revision independently of source and detaches startup configuration", () => {
    const h = fixture(), digest = admissionDigest(h.scope);
    h.config.scope.writerEpoch = "999"; h.config.readCurrent = () => undefined;
    expect(h.review.requireReview(digest, "reuse", Date.now())).toBeUndefined();
    const replacement = { ...h.body, evidenceSha256: "f".repeat(64) }, payload = canonicalize(replacement)!;
    h.source.current = { payload, signature: sign(null, Buffer.from(payload), h.privateKey).toString("hex") };
    expect(() => h.review.requireReview(digest, "reuse", Date.now())).toThrow("unavailable");
  });
  it("requires a pinned Ed25519 key and nonzero review revision", () => {
    const h = fixture(), wrong = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
    expect(() => createLocalAdmissionReview({ ...h.config, publicKeyPem: wrong.export({ type: "spki", format: "pem" }).toString() })).toThrow();
    expect(() => createLocalAdmissionReview({ ...h.config, publicKeyPem: "" })).toThrow();
    expect(() => createLocalAdmissionReview({ ...h.config, scope: { ...h.scope, reviewRevisionSha256: "0".repeat(64) } })).toThrow();
  });
});
