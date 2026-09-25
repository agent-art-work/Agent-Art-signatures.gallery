import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import canonicalize from "canonicalize";
import { readFileBounded } from "./generative-staging-bootstrap.mjs";

const deny = () => { throw Error("Staging mounted input unavailable."); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const exact = (v, names) => {
  assert.ok(v && Object.getPrototypeOf(v) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(v).sort(), [...names].sort());
};
const directory = (path, uid) => {
  assert.ok(typeof path === "string" && path === resolve(path) && realpathSync(path) === path);
  const s = lstatSync(path);
  assert.ok(s.isDirectory() && s.uid === uid && (s.mode & 0o7777) === 0o700);
  return s;
};
const leaf = (path, uid, max) => {
  const s = lstatSync(path);
  assert.ok(s.isFile() && s.uid === uid && s.nlink === 1 && [0o400, 0o600].includes(s.mode & 0o7777) && s.size > 0 && s.size <= max);
  return s;
};
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode
  && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Resolve exactly one predeclared reference; no environment, fallback or scan.
 * The returned string must remain private and must never enter logs/health. */
export function readMountedSecret(config, reference, maxBytes = 4096) {
  try {
    assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 8192);
    const matches = config.secrets.filter(item => item.reference === reference);
    assert.equal(matches.length, 1);
    const item = matches[0], parent = resolve(item.path, "..");
    const root = directory(parent, item.ownerUid), before = leaf(item.path, item.ownerUid, maxBytes);
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileBounded(item.path, maxBytes));
    assert.ok(same(root, directory(parent, item.ownerUid)) && same(before, leaf(item.path, item.ownerUid, maxBytes))
      && value.length > 0 && !value.includes("\0") && !value.includes("\r") && !value.includes("\n"));
    return value;
  } catch { return deny(); }
}

/** Current operation review, not a cached approval. The cryptographic/domain
 * validator is createStagingOperationReview; this loader only protects bytes. */
export function openMountedReview(config) {
  try {
    exact(config, ["directory", "fileName", "ownerUid", "publicKeyPem", "publicKeySpkiSha256", "revisionSha256"]);
    const root = directory(config.directory, config.ownerUid), path = join(config.directory, config.fileName);
    assert.equal(resolve(path), path);
    let stopped = false;
    const readCurrent = () => {
      try {
        assert.ok(!stopped && same(root, directory(config.directory, config.ownerUid)));
        const before = leaf(path, config.ownerUid, 32768);
        const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileBounded(path, 32768)).replace(/\n$/, "");
        assert.ok(same(root, directory(config.directory, config.ownerUid)) && same(before, leaf(path, config.ownerUid, 32768)));
        const value = JSON.parse(raw);
        assert.equal(canonicalize(value), raw);
        exact(value, ["payload", "signature"]);
        assert.ok(typeof value.payload === "string" && Buffer.byteLength(value.payload) <= 16384
          && sha(value.payload) === config.revisionSha256 && /^[0-9a-f]{128}$/.test(value.signature));
        return value;
      } catch { stopped = true; return deny(); }
    };
    return Object.freeze({ publicKeyPem: config.publicKeyPem, publicKeySpkiSha256: config.publicKeySpkiSha256,
      revisionSha256: config.revisionSha256, readCurrent, halt() { stopped = true; } });
  } catch { return deny(); }
}
