import { createHash, createPublicKey, verify } from "node:crypto";
import canonicalize from "canonicalize";

const fail = (): never => { throw Error("Staging recovery approval unavailable."); };
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const hex = (v: unknown) => typeof v === "string" && /^(?!0{64}$)[0-9a-f]{64}$/.test(v);
const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const keys = (v: unknown, fields: string[]) => v && typeof v === "object" && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join() === fields.sort().join();

export interface RecoveryApprovalTarget {
  readonly action: "retire-expired-unminted"; readonly recoveryId: string; readonly namespaceId: string;
  readonly deploymentId: string; readonly authorizationId: string; readonly authorizationDigest: string;
  readonly snapshotHash: string; readonly operatorReference: string; readonly evidenceReference: string;
  readonly writerEpoch: string; readonly databaseBinding: string; readonly activePolicyDigest: string;
  readonly operatingPlanSha256: string; readonly releaseLockSha256: string;
}
export interface RecoveryReviewSource {
  readonly publicKeyPem: string; readonly publicKeySpkiSha256: string; readonly revisionSha256: string;
  readCurrent(): unknown;
}
const targetFields = ["action","recoveryId","namespaceId","deploymentId","authorizationId","authorizationDigest","snapshotHash",
  "operatorReference","evidenceReference","writerEpoch","databaseBinding","activePolicyDigest","operatingPlanSha256","releaseLockSha256"];

/** Separate signed domain from browser operation reviews; a browser review
 * cannot authorize retirement. The source supplies only a pinned public key. */
export function createStagingRecoveryReview(source: RecoveryReviewSource, target: RecoveryApprovalTarget) {
  try {
    if (!keys(source, ["publicKeyPem","publicKeySpkiSha256","revisionSha256","readCurrent"])
      || !keys(target, targetFields) || target.action !== "retire-expired-unminted"
      || ![target.recoveryId,target.namespaceId,target.deploymentId,target.authorizationId].every(uuid)
      || ![target.authorizationDigest.slice(2),target.snapshotHash,target.databaseBinding,target.activePolicyDigest,
        target.operatingPlanSha256,target.releaseLockSha256].every(hex)
      || !/^0x[0-9a-f]{64}$/.test(target.authorizationDigest) || !/^[1-9]\d{0,18}$/.test(target.writerEpoch)
      || ![target.operatorReference,target.evidenceReference].every(v => /^[a-z][a-z0-9:/._-]{2,127}$/.test(v))
      || !hex(source.publicKeySpkiSha256) || !hex(source.revisionSha256)
      || typeof source.readCurrent !== "function" || typeof source.publicKeyPem !== "string"
      || source.publicKeyPem.length > 1024 || !source.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----")) fail();
    const key = createPublicKey(source.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519" || sha(key.export({ type:"spki", format:"der" })) !== source.publicKeySpkiSha256) fail();
    const stable = Object.freeze(structuredClone(target)), read = source.readCurrent.bind(source);
    const revisionSha256 = source.revisionSha256;
    let halted = false, last = -1;
    return Object.freeze({ halt() { halted = true; }, require(now: number) {
      try {
        if (halted || !Number.isSafeInteger(now) || now < last) fail(); last = now;
        const envelope = read();
        if (!keys(envelope, ["payload","signature"])) fail();
        const e = envelope as {payload:string;signature:string};
        if (typeof e.payload !== "string" || Buffer.byteLength(e.payload) > 8192 || !/^[a-f0-9]{128}$/.test(e.signature)
          || sha(e.payload) !== revisionSha256 || !verify(null,Buffer.from(e.payload),key,Buffer.from(e.signature,"hex"))) fail();
        const payload = JSON.parse(e.payload);
        if (!keys(payload,["version","target","validFrom","validUntil"]) || canonicalize(payload) !== e.payload
          || payload.version !== "sg-staging-recovery-review-v1" || !keys(payload.target,targetFields)
          || canonicalize(payload.target) !== canonicalize(stable)
          || !Number.isSafeInteger(payload.validFrom) || !Number.isSafeInteger(payload.validUntil)
          || payload.validUntil <= payload.validFrom || payload.validUntil-payload.validFrom > 15*60_000
          || now < payload.validFrom || now >= payload.validUntil) fail();
        return Object.freeze({ revisionSha256, target: stable, validUntil: payload.validUntil as number });
      } catch { halted = true; fail(); }
    } });
  } catch { fail(); }
}
