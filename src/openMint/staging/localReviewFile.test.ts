import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import canonicalize from "canonicalize";
import { afterEach, describe, expect, it } from "vitest";
import { admissionDigest } from "./admission.js";
import { admissionFixture } from "./fixtures/admission.js";
import { localReviewFixture } from "./fixtures/localReview.js";
import { localReviewFilesFixture } from "./fixtures/localReviewFiles.js";
import { LOCAL_REVIEW_FILE_MAX_BYTES, openLocalReviewFile, type LocalReviewFileConfig } from "./localReviewFile.js";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const review = localReviewFixture(admissionFixture().scope), files = localReviewFilesFixture({ assessment: review }); cleanup.push(files.remove);
  const config = files.configs.assessment, path = join(config.directory, config.fileName), digest = admissionDigest(config.scope);
  return { review, files, config, path, digest };
}
describe("operator-pinned local review file (no live keys or approval creation)", () => {
  it("loads the exact signed revision repeatedly without modifying files", () => {
    const h = fixture(), before = readFileSync(h.path), source = openLocalReviewFile(h.config);
    source.requireReview(h.digest, "reuse", Date.now()); source.requireReview(h.digest, "reuse", Date.now());
    expect(readFileSync(h.path)).toEqual(before); expect(Object.isFrozen(source)).toBe(true); expect(Object.isFrozen(source.scope)).toBe(true);
    chmodSync(h.path, 0o400); source.requireReview(h.digest, "reuse", Date.now());
  });
  it("accepts an atomic replacement only with the same independently pinned signed material", () => {
    const h = fixture(), source = openLocalReviewFile(h.config);
    const replacement = join(h.files.directory, "replacement.json");
    writeFileSync(replacement, canonicalize(h.review.envelope)!, { mode: 0o600 }); renameSync(replacement, h.path);
    source.requireReview(h.digest, "reuse", Date.now());
  });
  it("withdrawal permanently stops the instance; restoring old bytes cannot revive it", () => {
    const h = fixture(), source = openLocalReviewFile(h.config); source.requireReview(h.digest, "reuse", Date.now());
    unlinkSync(h.path); expect(() => source.requireReview(h.digest, "reuse", Date.now())).toThrow("Local review file unavailable.");
    writeFileSync(h.path, canonicalize(h.review.envelope)!, { mode: 0o600 });
    expect(() => source.requireReview(h.digest, "reuse", Date.now())).toThrow("unavailable");
    source.halt(); expect(() => source.requireReview(h.digest, "reuse", Date.now())).toThrow("unavailable");
  });
  it("rotation requires a fresh independently pinned key and revision, not auto-discovery", () => {
    const h = fixture(), source = openLocalReviewFile(h.config);
    const rotated = localReviewFixture(h.review.scope, { evidenceSha256: "f".repeat(64) });
    const next = localReviewFilesFixture({ assessment: rotated }); cleanup.push(next.remove);
    writeFileSync(h.path, canonicalize(rotated.envelope)!);
    expect(() => source.requireReview(h.digest, "reuse", Date.now())).toThrow("unavailable");
    expect(() => openLocalReviewFile({ ...h.config, scope: rotated.scope }).requireReview(admissionDigest(rotated.scope), "reuse", Date.now())).toThrow("unavailable");
    const config = { ...next.configs.assessment, directory: h.files.directory };
    openLocalReviewFile(config).requireReview(admissionDigest(config.scope), "reuse", Date.now());
    expect(() => source.requireReview(h.digest, "reuse", Date.now())).toThrow("unavailable");
  });
  it("does not observe later mutations of trusted config objects", () => {
    const h = fixture(), config = { ...h.config, scope: { ...h.config.scope } }, source = openLocalReviewFile(config);
    config.directory = "/does-not-exist"; config.scope.writerEpoch = "999"; config.publicKeyPem = "not a key";
    source.requireReview(h.digest, "reuse", Date.now());
  });
  it.each([
    { directory: "relative" }, { directory: "/" }, { directory: "/tmp/../tmp" }, { directory: "/tmp/" }, { directory: "/does-not-exist" },
    { fileName: "../assessment.json" }, { fileName: "/assessment.json" }, { fileName: "assessment.txt" }, { fileName: "a\0.json" },
    { ownerUid: -1 }, { ownerUid: 1.1 }, { ownerUid: 0x100000000 }, { publicKeyPem: "private or invalid" },
    { publicKeyPem: "x".repeat(1025) }, { publicKeySpkiSha256: "0".repeat(64) }, { publicKeySpkiSha256: "a".repeat(64) },
  ])("refuses unsafe independent configuration %j", overrides => {
    const h = fixture(); expect(() => openLocalReviewFile({ ...h.config, ...overrides })).toThrow("Local review file unavailable.");
  });
  it.each(["owner", "root-mode", "root-file", "root-symlink", "ec-key", "private-key", "scope"])("rejects %s at construction", reason => {
    const h = fixture(); let config: LocalReviewFileConfig = { ...h.config };
    if (reason === "owner") config = { ...config, ownerUid: config.ownerUid + 1 };
    if (reason === "root-mode") chmodSync(h.files.directory, 0o755);
    if (reason === "root-file") config = { ...config, directory: h.path };
    if (reason === "root-symlink") { const alias = join(h.files.directory, "alias"); symlinkSync(h.files.directory, alias); config = { ...config, directory: alias }; }
    if (reason === "scope") config = { ...config, scope: { ...config.scope, timeoutMs: 0 } };
    if (reason === "ec-key") {
      const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
      config = { ...config, publicKeyPem: key.export({ type: "spki", format: "pem" }).toString(), publicKeySpkiSha256: createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex") };
    }
    if (reason === "private-key") config = { ...config, publicKeyPem: h.review.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    expect(() => openLocalReviewFile(config)).toThrow("unavailable");
  });
  it.each(["missing", "empty", "oversized", "mode", "hardlink", "symlink", "directory", "fifo", "json", "utf8", "duplicate", "extra", "signature", "expired", "root-mode", "root-replaced"])("fails closed at a live checkpoint for %s", reason => {
    const h = fixture(), source = openLocalReviewFile(h.config);
    if (reason === "missing") unlinkSync(h.path);
    if (reason === "empty") truncateSync(h.path, 0);
    if (reason === "oversized") truncateSync(h.path, LOCAL_REVIEW_FILE_MAX_BYTES + 1);
    if (reason === "mode") chmodSync(h.path, 0o644);
    if (reason === "hardlink") linkSync(h.path, join(h.files.directory, "linked.json"));
    if (["symlink", "directory", "fifo"].includes(reason)) {
      unlinkSync(h.path);
      if (reason === "symlink") symlinkSync("missing.json", h.path);
      if (reason === "directory") mkdirSync(h.path);
      if (reason === "fifo") execFileSync("mkfifo", [h.path]);
    }
    if (reason === "json") writeFileSync(h.path, "not json");
    if (reason === "utf8") writeFileSync(h.path, Buffer.from([0xff, 0xfe]));
    if (reason === "duplicate") writeFileSync(h.path, '{"payload":"shadow",' + canonicalize(h.review.envelope)!.slice(1));
    if (reason === "extra") writeFileSync(h.path, canonicalize({ ...h.review.envelope, approved: true })!);
    if (reason === "signature") writeFileSync(h.path, canonicalize({ ...h.review.envelope, signature: "00".repeat(64) })!);
    if (reason === "root-mode") chmodSync(h.files.directory, 0o777);
    if (reason === "root-replaced") {
      const moved = h.files.directory + "-moved"; renameSync(h.files.directory, moved); cleanup.push(() => rmSync(moved, { recursive: true, force: true }));
      mkdirSync(h.files.directory, { mode: 0o700 }); writeFileSync(h.path, canonicalize(h.review.envelope)!, { mode: 0o600 });
    }
    expect(() => source.requireReview(h.digest, "reuse", reason === "expired" ? h.review.body.validUntil : Date.now())).toThrow("Local review file unavailable.");
    expect(() => source.requireReview(h.digest, "reuse", Date.now())).toThrow("unavailable");
  });
  it("rejects a re-signed revision under the old pin even with the same reviewer key", () => {
    const h = fixture(), source = openLocalReviewFile(h.config), payload = canonicalize({ ...h.review.body, evidenceSha256: "f".repeat(64) })!;
    writeFileSync(h.path, canonicalize({ payload, signature: sign(null, Buffer.from(payload), h.review.privateKey).toString("hex") })!);
    expect(() => source.requireReview(h.digest, "reuse", Date.now())).toThrow("unavailable");
  });
});
