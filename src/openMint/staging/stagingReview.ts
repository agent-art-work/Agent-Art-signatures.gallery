import { createHash, createPublicKey, verify } from "node:crypto";
import canonicalize from "canonicalize";
import { ADMISSION_OPERATIONS, admissionDigest, captureAdmissionScope, type AdmissionOperation, type AdmissionScope } from "./admission.js";
import type { ReadinessReviewSource } from "./readinessReview.js";

const deny = (): never => { throw Error("Staging operation review unavailable."); };
const check = (v: unknown) => { if (!v) deny(); };
const hash = (v: unknown) => typeof v === "string" && /^(?!0{64}$)[a-f0-9]{64}$/.test(v);
function fields(v: unknown, names: readonly string[]): asserts v is Record<string, unknown> {
  check(v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(v); check(Reflect.ownKeys(v as object).length === names.length
    && names.every(k => ds[k]?.enumerable && "value" in ds[k]));
}

/** Operation-specific review, NOT the local or paused-readiness review domain.
 * The independently pinned key/revision must attest the real evidence. No
 * approval generation, signer secrets, discovery or file/network loader. */
export function createStagingOperationReview(source: ReadinessReviewSource, input: AdmissionScope) {
  try {
    fields(source, ["publicKeyPem", "publicKeySpkiSha256", "revisionSha256", "readCurrent"]);
    const scope = captureAdmissionScope(input), digest = admissionDigest(scope), { reviewRevisionSha256, ...bodyScope } = scope;
    check(hash(source.publicKeySpkiSha256) && source.revisionSha256 === reviewRevisionSha256 && typeof source.readCurrent === "function"
      && typeof source.publicKeyPem === "string" && source.publicKeyPem.length <= 1024 && source.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----")
      && !source.publicKeyPem.includes("PRIVATE"));
    const key = createPublicKey(source.publicKeyPem);
    check(key.asymmetricKeyType === "ed25519" && createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex") === source.publicKeySpkiSha256);
    const read = source.readCurrent.bind(source); let halted = false, lastTime = -1;
    return Object.freeze({ halt() { halted = true; }, requireReview(scopeSha256: string, operation: AdmissionOperation, now: number): void {
      try {
        check(!halted && digest === scopeSha256 && Number.isSafeInteger(now) && now >= 0 && now >= lastTime); lastTime = now;
        const envelope = read(); fields(envelope, ["payload", "signature"]);
        check(typeof envelope.payload === "string" && Buffer.byteLength(envelope.payload) <= 16384
          && typeof envelope.signature === "string" && /^[a-f0-9]{128}$/.test(envelope.signature));
        const payload = envelope.payload as string, bytes = Buffer.from(payload);
        check(createHash("sha256").update(bytes).digest("hex") === reviewRevisionSha256
          && verify(null, bytes, key, Buffer.from(envelope.signature as string, "hex")));
        const body = JSON.parse(payload); fields(body, ["version", "scope", "operations", "validFrom", "validUntil", "evidenceSha256"]);
        check(body.version === "sg-staging-operation-review-v1" && canonicalize(body) === payload && hash(body.evidenceSha256)
          && admissionDigest(body.scope) === admissionDigest(bodyScope));
        const ops = body.operations;
        check(Array.isArray(ops) && ops.length > 0 && JSON.stringify(ops) === JSON.stringify(ADMISSION_OPERATIONS.filter(op => ops.includes(op))) && ops.includes(operation));
        check(typeof body.validFrom === "number" && typeof body.validUntil === "number" && Number.isSafeInteger(body.validFrom)
          && Number.isSafeInteger(body.validUntil) && body.validFrom >= 0 && body.validUntil > body.validFrom
          && body.validUntil - body.validFrom <= 31 * 86400000 && now >= body.validFrom && now < body.validUntil);
      } catch { halted = true; deny(); }
    } });
  } catch { return deny(); }
}
