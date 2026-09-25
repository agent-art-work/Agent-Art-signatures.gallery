import { appendFileSync, closeSync, readFileSync, renameSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admissionDigest } from "./admission.js";
import { admissionFixture } from "./fixtures/admission.js";
import { localReviewFixture } from "./fixtures/localReview.js";
import { localReviewFilesFixture } from "./fixtures/localReviewFiles.js";
import { openLocalReviewFile } from "./localReviewFile.js";

// Deterministic filesystem race injection, while real descriptors, O_NOFOLLOW,
// metadata checks and bounded reads remain in use on private temporary files.
const hooks = vi.hoisted(() => ({ open: undefined as (() => void) | undefined, read: undefined as (() => void) | undefined, chunk: 0 }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, closeSync: vi.fn(fs.closeSync), openSync: ((...args: Parameters<typeof fs.openSync>) => {
    hooks.open?.(); return fs.openSync(...args);
  }), readSync: ((fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => {
    hooks.read?.(); return fs.readSync(fd, buffer, offset, hooks.chunk ? Math.min(hooks.chunk, length) : length, position);
  }) };
});
const roots: ReturnType<typeof localReviewFilesFixture>[] = [];
afterEach(() => { hooks.open = undefined; hooks.read = undefined; hooks.chunk = 0; vi.mocked(closeSync).mockClear(); while (roots.length) roots.pop()!.remove(); });
function fixture() {
  const review = localReviewFixture(admissionFixture().scope), files = localReviewFilesFixture({ assessment: review }); roots.push(files);
  const config = files.configs.assessment, source = openLocalReviewFile(config), path = join(config.directory, config.fileName);
  return { files, path, check: () => source.requireReview(admissionDigest(config.scope), "reuse", Date.now()) };
}
describe("local review file race/short-read boundaries", () => {
  it("handles partial reads and closes the descriptor", () => {
    const h = fixture(); hooks.chunk = 7; h.check(); expect(closeSync).toHaveBeenCalledOnce();
  });
  it.each(["grow", "truncate", "replace", "symlink"])("rejects %s between file checks and never leaks authority", reason => {
    const h = fixture();
    const once = () => {
      hooks.open = undefined; hooks.read = undefined;
      if (reason === "grow") appendFileSync(h.path, "!");
      if (reason === "truncate") truncateSync(h.path, 1);
      if (reason === "replace") {
        const replacement = join(h.files.directory, "next.json"); writeFileSync(replacement, readFileSync(h.path), { mode: 0o600 }); renameSync(replacement, h.path);
      }
      if (reason === "symlink") { const target = join(h.files.directory, "other.json"); renameSync(h.path, target); symlinkSync(target, h.path); }
    };
    if (["replace", "symlink"].includes(reason)) hooks.open = once; else hooks.read = once;
    expect(h.check).toThrow("Local review file unavailable.");
    if (reason !== "symlink") expect(closeSync).toHaveBeenCalledOnce(); else expect(closeSync).not.toHaveBeenCalled();
    expect(h.check).toThrow("unavailable");
  });
});
