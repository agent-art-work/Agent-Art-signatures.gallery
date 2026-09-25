import { createHash, createPublicKey, verify } from "node:crypto";
import canonicalize from "canonicalize";

export interface ReadinessReviewSource {
  publicKeyPem: string;
  publicKeySpkiSha256: string;
  revisionSha256: string;
  readCurrent(): { payload: string; signature: string } | undefined;
}
const deny = () => { throw new Error("Staging readiness review unavailable."); };
const check = (v: unknown) => { if (!v) deny(); };
const hash = (v: unknown): v is string => typeof v === "string" && /^(?!0{64}$)[a-f0-9]{64}$/.test(v);
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
function fields(v: unknown, names: string[]): asserts v is Record<string, unknown> {
  check(v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(v);
  check(Reflect.ownKeys(v as object).length === names.length && names.every(k => ds[k]?.enumerable && "value" in ds[k]));
}

/** Separate signed domain for READ-ONLY paused staging readiness. It cannot
 * satisfy local/mint admission reviews. Trust pins come from the caller, not
 * from the envelope; no file/secret discovery, signing or approval generation. */
export function createReadinessReview(input: ReadinessReviewSource, scopeSha256: string) {
  try {
    fields(input, ["publicKeyPem", "publicKeySpkiSha256", "revisionSha256", "readCurrent"]);
    check(hash(scopeSha256) && hash(input.publicKeySpkiSha256) && hash(input.revisionSha256)
      && typeof input.readCurrent === "function" && typeof input.publicKeyPem === "string" && input.publicKeyPem.length <= 1024
      && input.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----") && !input.publicKeyPem.includes("PRIVATE"));
    const key = createPublicKey(input.publicKeyPem), fingerprint = sha(key.export({ type: "spki", format: "der" }));
    check(key.asymmetricKeyType === "ed25519" && fingerprint === input.publicKeySpkiSha256);
    const revision = input.revisionSha256, read = input.readCurrent.bind(input);
    let halted = false, lastTime = -1;
    return Object.freeze({ halt() { halted = true; }, require(now: number): void {
      try {
        check(!halted && Number.isSafeInteger(now) && now >= 0 && now >= lastTime); lastTime = now;
        const e = read(); fields(e, ["payload", "signature"]);
        check(typeof e.payload === "string" && Buffer.byteLength(e.payload) <= 16384
          && typeof e.signature === "string" && /^[a-f0-9]{128}$/.test(e.signature));
        const payload = e.payload as string;
        check(sha(payload) === revision && verify(null, Buffer.from(payload), key, Buffer.from(e.signature as string, "hex")));
        const body = JSON.parse(payload); fields(body, ["version", "scopeSha256", "evidenceSha256", "validFrom", "validUntil"]);
        check(body.version === "sg-paused-readiness-review-v1" && canonicalize(body) === payload && body.scopeSha256 === scopeSha256
          && hash(body.evidenceSha256) && typeof body.validFrom === "number" && typeof body.validUntil === "number"
          && Number.isSafeInteger(body.validFrom) && Number.isSafeInteger(body.validUntil)
          && body.validFrom >= 0 && body.validUntil > body.validFrom && body.validUntil - body.validFrom <= 31 * 86400000
          && now >= body.validFrom && now < body.validUntil);
      } catch { halted = true; deny(); }
    } });
  } catch { return deny(); }
}
