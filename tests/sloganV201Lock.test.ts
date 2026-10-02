import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCK_PATH, verifySloganV201Lock } from "../scripts/verify-slogan-v201-lock.mjs";

const SNAPSHOT_PATH = "src/brand/sloganMbtiFrames.ts";
const read = (path: string): Buffer => readFileSync(new URL(`../${path}`, import.meta.url));
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const readLock = () => JSON.parse(read(LOCK_PATH).toString());
const firstCapturedPath = () => read(SNAPSHOT_PATH).toString().match(/    d: "([^"]+)"/)![1];
const firstMove = firstCapturedPath().match(/^M[^L]+/)![0];
const shiftedMove = (path: string) => path.replace(/^M(-?\d+\.\d+)/, (_, x: string) => `M${(Number(x) + 0.01).toFixed(2)}`);
const withLock = (lock: ReturnType<typeof readLock>) => ({
  read: (path: string) => path === LOCK_PATH ? Buffer.from(JSON.stringify(lock)) : read(path),
});
const withRehashedFile = (path: string, bytes: Buffer, lock = readLock()) => {
  lock.files[path] = hash(bytes);
  return { read: (name: string) => name === path ? bytes : withLock(lock).read(name) };
};

describe("brand-only slogan v2.0.1 release pin", () => {
  it("verifies the tagged source, upstream long-text layout and eight captured paths", () => {
    expect(verifySloganV201Lock()).toEqual({ rendererVersion: "sg-renderer-2.0.1", scope: "brand-slogan-only", sourceFiles: 5, frames: 8 });
  });

  it("reads every protected source through the injected reader", () => {
    const paths: string[] = [];
    verifySloganV201Lock({ read: (path: string) => { paths.push(path); return read(path); } });
    expect(paths.sort()).toEqual([LOCK_PATH, ...Object.keys(readLock().files)].sort());
  });

  it.each(Object.keys(readLock().files))("rejects source drift in %s", changed => {
    expect(() => verifySloganV201Lock({ read: (path: string) => path === changed ? Buffer.concat([read(path), Buffer.from("\nchanged")]) : read(path) }))
      .toThrow(`Pinned v2.0.1 slogan source changed: ${changed}`);
  });

  it.each(Object.keys(readLock().files))("rejects omission of protected source %s", missing => {
    const lock = readLock();
    delete lock.files[missing];
    expect(() => verifySloganV201Lock(withLock(lock))).toThrow("Incomplete v2.0.1 slogan protected source list");
  });

  it("rejects unexpected protected paths before trying to read them", () => {
    const lock = readLock();
    lock.files["unexpected.py"] = "0".repeat(64);
    expect(() => verifySloganV201Lock(withLock(lock))).toThrow("Incomplete v2.0.1 slogan protected source list");
  });

  it.each([
    ["schema", "signatures-gallery-renderer-lock/2"],
    ["status", "candidate"],
    ["upstream.repository", "https://example.com/replacement"],
    ["upstream.tag", "v2.0.0"],
    ["upstream.commit", "0".repeat(40)],
    ["upstream.tagObject", "0".repeat(40)],
    ["algorithmVersion", "2.0.0"],
    ["rendererVersion", "sg-renderer-2.0.0"],
    ["adoption.scope", "all-artworks"],
    ["adoption.accountRendererVersion", "sg-renderer-2.0.1"],
    ["adoption.legacyRendererVersion", "sg-renderer-2.0.1"],
    ["source.displayText", "Whose_Signature_Will_You_Reveal"],
    ["source.displayText", "Whose_signature_will_you_reveal?"],
    ["source.displayText", "Whose_Shape_Will_You_Reveal?"],
    ["source.displayText", "What_shape_do_you_go_by?"],
    ["source.rendererVersion", "sg-renderer-2.0.0"],
    ["source.upstreamCommit", "0".repeat(40)],
    ["source.pythonSha256", "0".repeat(64)],
    ["source.adapter", "brand-only-whole-phrase-v1"],
    ["verification.ownerVisualApproval", "approved"],
  ])("rejects altered release identity or adoption: %s", (field, value) => {
    const lock = readLock();
    const parts = field.split(".");
    const parent = parts.length === 2 ? lock[parts[0]] : lock;
    parent[parts.at(-1)!] = value;
    expect(() => verifySloganV201Lock(withLock(lock))).toThrow();
  });

  it.each(Object.keys(readLock().files).filter(path => path.startsWith("reference/")))("rejects rehashed upstream drift in %s", path => {
    const bytes = Buffer.concat([read(path), Buffer.from("\n")]);
    expect(() => verifySloganV201Lock(withRehashedFile(path, bytes))).toThrow(`Slogan v2.0.1 upstream identity changed: ${path}`);
  });

  it.each(Object.keys(readLock().layout))("rejects altered locked layout: %s", field => {
    const lock = readLock();
    lock.layout[field] = typeof lock.layout[field] === "boolean" ? false : lock.layout[field] + 1;
    expect(() => verifySloganV201Lock(withLock(lock))).toThrow("Slogan layout differs from the upstream long-text policy");
  });

  it.each([
    ["rendererVersion: \"sg-renderer-2.0.1\"", "rendererVersion: \"sg-renderer-2.0.0\"", "Slogan snapshot capture identity changed"],
    [`curve_span: ${readLock().layout.curve_span}`, `curve_span: ${readLock().layout.curve_span + 1}`, "Slogan snapshot layout differs from the upstream long-text policy"],
    ["mbti: \"ISTJ\"", "mbti: \"INTJ\"", "Slogan MBTI frame order changed"],
    ["pairedMbti: \"ESTJ\"", "pairedMbti: \"ENTJ\"", "Slogan I/E frame pair changed"],
    [firstMove, shiftedMove(firstMove), "Slogan frame path hash differs: ISTJ"],
  ])("checks injected snapshot bytes even after file rehashing: %s", (before, after, message) => {
    const text = read(SNAPSHOT_PATH).toString();
    expect(text).toContain(before);
    const bytes = Buffer.from(text.replace(before, after));
    expect(() => verifySloganV201Lock(withRehashedFile(SNAPSHOT_PATH, bytes))).toThrow(message);
  });

  it("rejects a rehashed path and snapshot checksum that differ from the captured frame lock", () => {
    const text = read(SNAPSHOT_PATH).toString();
    const path = text.match(/    d: "([^"]+)"/)![1];
    const changed = shiftedMove(path);
    expect(changed).not.toBe(path);
    const bytes = Buffer.from(text.replace(path, changed).replace(hash(path), hash(changed)));
    expect(() => verifySloganV201Lock(withRehashedFile(SNAPSHOT_PATH, bytes))).toThrow("Slogan frame differs from the locked capture: ISTJ");
  });

  it("rejects an incomplete snapshot even if its file hash is changed", () => {
    const bytes = Buffer.from(read(SNAPSHOT_PATH).toString().replace(/  Object\.freeze\(\{[\s\S]*?  \} as const\),\n/, ""));
    expect(() => verifySloganV201Lock(withRehashedFile(SNAPSHOT_PATH, bytes))).toThrow("Incomplete v2.0.1 slogan snapshot");
  });

  it("rejects an incomplete frame lock", () => {
    const lock = readLock();
    lock.frames.pop();
    expect(() => verifySloganV201Lock(withLock(lock))).toThrow("Incomplete v2.0.1 slogan frame lock");
  });

  it("rejects changed captured frame hashes", () => {
    const lock = readLock();
    lock.frames[0].sha256 = "0".repeat(64);
    expect(() => verifySloganV201Lock(withLock(lock))).toThrow("Slogan frame differs from the locked capture: ISTJ");
  });
});
