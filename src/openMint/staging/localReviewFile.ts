import { createHash, createPublicKey } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import canonicalize from "canonicalize";
import { captureAdmissionScope, type AdmissionScope } from "./admission.js";
import { createLocalAdmissionReview, type SignedLocalAdmissionReview } from "./localReview.js";

export interface LocalReviewFileConfig {
  /** Canonical, absolute, operator-owned 0700 directory on a trusted local filesystem. */
  readonly directory: string;
  readonly fileName: string;
  readonly ownerUid: number;
  /** Independently pinned startup material. Never derive these from the review file. */
  readonly publicKeyPem: string;
  readonly publicKeySpkiSha256: string;
  readonly scope: AdmissionScope;
}
export const LOCAL_REVIEW_FILE_MAX_BYTES = 32768;
const unavailable = (): never => { throw new Error("Local review file unavailable."); };
const check = (ok: unknown): void => { if (!ok) unavailable(); };
const identity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: Stats, b: Stats) => identity(a, b) && a.size === b.size && a.uid === b.uid
  && a.mode === b.mode && a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Read-only local source. No environment discovery, private-key loading,
 * review signing, auto-repinning, polling daemon, file writes or network I/O.
 * File withdrawal/invalidity is sticky for this instance. Same-UID/root or a
 * malicious filesystem is outside the process trust boundary; signatures and
 * independently pinned revisions, not Unix modes alone, bind authority. */
export function openLocalReviewFile(config: LocalReviewFileConfig) {
  try {
    const { directory, fileName, ownerUid, publicKeyPem, publicKeySpkiSha256 } = config;
    const scope = captureAdmissionScope(config.scope);
    check(typeof directory === "string" && directory.length <= 4096 && isAbsolute(directory) && resolve(directory) === directory
      && directory !== parse(directory).root && !directory.includes("\0"));
    check(typeof fileName === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.json$/.test(fileName));
    check(Number.isSafeInteger(ownerUid) && ownerUid >= 0 && ownerUid <= 0xffffffff);
    check(typeof publicKeyPem === "string" && Buffer.byteLength(publicKeyPem) <= 1024
      && /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n?$/.test(publicKeyPem));
    check(typeof publicKeySpkiSha256 === "string" && /^(?!0{64}$)[a-f0-9]{64}$/.test(publicKeySpkiSha256));
    const key = createPublicKey(publicKeyPem);
    check(key.asymmetricKeyType === "ed25519" && createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex") === publicKeySpkiSha256);
    check(typeof constants.O_NOFOLLOW === "number" && typeof constants.O_NONBLOCK === "number");
    const root = () => {
      const s = lstatSync(directory);
      check(s.isDirectory() && s.uid === ownerUid && (s.mode & 0o7777) === 0o700 && realpathSync(directory) === directory);
      return s;
    };
    const pinnedRoot = root(), path = join(directory, fileName);
    const currentRoot = () => { check(identity(root(), pinnedRoot)); };
    const file = (s: Stats) => { check(s.isFile() && s.uid === ownerUid && s.nlink === 1
      && [0o400, 0o600].includes(s.mode & 0o7777) && s.size > 0 && s.size <= LOCAL_REVIEW_FILE_MAX_BYTES); };
    let stopped = false;
    const readCurrent = (): SignedLocalAdmissionReview => {
      check(!stopped);
      let fd: number | undefined;
      try {
        currentRoot(); const named = lstatSync(path); file(named);
        // NONBLOCK avoids a FIFO open hang if the leaf is swapped after lstat.
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = fstatSync(fd); file(before); check(unchanged(named, before));
        const buffer = Buffer.alloc(before.size + 1); let count = 0;
        while (count < buffer.length) {
          const n = readSync(fd, buffer, count, buffer.length - count, null);
          if (n === 0) break;
          count += n;
        }
        check(count === before.size && unchanged(before, fstatSync(fd)) && unchanged(before, lstatSync(path))); currentRoot();
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, count)).replace(/\n$/, "");
        const envelope = JSON.parse(text);
        // Canonical envelope (optional final LF) also rejects duplicate keys.
        check(canonicalize(envelope) === text);
        return envelope;
      } catch { stopped = true; return unavailable(); }
      finally { if (fd !== undefined) closeSync(fd); }
    };
    const review = createLocalAdmissionReview({ publicKeyPem, scope, readCurrent });
    return Object.freeze({ scope, publicKeySpkiSha256,
      halt() { stopped = true; review.halt(); },
      requireReview: (...args: Parameters<typeof review.requireReview>) => {
        try { check(!stopped); review.requireReview(...args); }
        catch { stopped = true; review.halt(); unavailable(); }
      },
    });
  } catch { return unavailable(); }
}
