import { createPublicKey, verify } from "node:crypto";
import canonicalize from "canonicalize";
import { ADMISSION_OPERATIONS, admissionDigest, type AdmissionOperation, type AdmissionScope } from "./admission.js";

/** Signed local rehearsal policy only. This is not Sepolia approval, evidence
 * collection or key provisioning. The reviewer key and source must be supplied
 * by trusted composition, never from a browser request or the signed envelope.
 */
export interface LocalAdmissionReview {
  version: "local-admission-review-v1";
  scope: Omit<AdmissionScope, "reviewRevisionSha256">;
  operations: readonly AdmissionOperation[];
  validFrom: number;
  validUntil: number;
  /** Digest of material the reviewer actually examined, not proof by itself. */
  evidenceSha256: string;
}
export interface SignedLocalAdmissionReview { payload: string; signature: string }
const unavailable = (): never => { throw new Error("Local admission review unavailable."); };
const check = (ok: unknown): void => { if (!ok) unavailable(); };
function fields(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Reflect.ownKeys(value as object), ds = Object.getOwnPropertyDescriptors(value);
  check(keys.length === names.length && keys.every(k => typeof k === "string" && names.includes(k))
    && names.every(k => ds[k]?.enumerable && "value" in ds[k]));
}
const hash = (v: unknown) => typeof v === "string" && /^(?!0{64}$)[a-f0-9]{64}$/.test(v);
const instant = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Reads the current signed revision synchronously at EVERY checkpoint.
 * Absence, revocation, crossed revision or invalid material permanently stops
 * this instance; restoring a file cannot revive an in-flight permit. A new
 * process still needs a trusted current source and explicitly pinned revision.
 * No signer/private key, file loader, approval writer or network access exists.
 */
export function createLocalAdmissionReview(input: {
  publicKeyPem: string; scope: AdmissionScope;
  readCurrent(): SignedLocalAdmissionReview | undefined;
}) {
  const key = createPublicKey(input.publicKeyPem);
  check(key.asymmetricKeyType === "ed25519");
  // Canonical serialization detaches nested caller data; scope contains scalars.
  const scope: AdmissionScope = JSON.parse(canonicalize(input.scope)!);
  check(hash(scope.reviewRevisionSha256));
  const { reviewRevisionSha256, ...reviewedScope } = scope;
  const scopeSha256 = admissionDigest(scope), boundScope = admissionDigest(reviewedScope);
  const readCurrent = input.readCurrent.bind(input);
  let stopped = false, lastTime = -1;
  return Object.freeze({
    halt() { stopped = true; },
    requireReview(digest: string, operation: AdmissionOperation, now: number): void {
      try {
        check(!stopped && digest === scopeSha256 && instant(now) && now >= lastTime);
        lastTime = now;
        const envelope = readCurrent();
        fields(envelope, ["payload", "signature"]);
        const { payload, signature } = envelope;
        check(typeof payload === "string" && Buffer.byteLength(payload) <= 16384
          && typeof signature === "string" && /^[0-9a-f]{128}$/.test(signature));
        const bytes = Buffer.from(payload as string);
        check(verify(null, bytes, key, Buffer.from(signature as string, "hex")));
        const body = JSON.parse(payload as string);
        fields(body, ["version", "scope", "operations", "validFrom", "validUntil", "evidenceSha256"]);
        check(canonicalize(body) === payload && body.version === "local-admission-review-v1"
          && admissionDigest(body) === reviewRevisionSha256 && admissionDigest(body.scope) === boundScope && hash(body.evidenceSha256));
        const ops = body.operations;
        check(Array.isArray(ops) && ops.length > 0 && ops.length <= ADMISSION_OPERATIONS.length
          && JSON.stringify(ops) === JSON.stringify(ADMISSION_OPERATIONS.filter(op => ops.includes(op))) && ops.includes(operation));
        check(instant(body.validFrom) && instant(body.validUntil) && body.validUntil > body.validFrom
          && body.validUntil - body.validFrom <= 31 * 86400000 && now >= body.validFrom && now < body.validUntil);
      } catch { stopped = true; unavailable(); }
    },
  });
}
