import { createHash, generateKeyPairSync, sign } from "node:crypto";
import canonicalize from "canonicalize";
import { type AdmissionScope } from "../admission.js";

/** Fresh test key and invented evidence; never an operational approval. */
export function stagingReviewFixture(input: AdmissionScope, patch: Record<string, unknown> = {}, encode = (body: unknown) => canonicalize(body)!) {
  const key = generateKeyPairSync("ed25519"), sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
  const { reviewRevisionSha256: _, ...scope } = input;
  const body = { version: "sg-staging-operation-review-v1", scope, operations: ["reuse", "assessment-x", "assessment-grok"],
    validFrom: input.paidValidFrom, validUntil: input.paidValidUntil, evidenceSha256: "d".repeat(64), ...patch };
  const payload = encode(body); let current: { payload: string; signature: string } | undefined = {
    payload, signature: sign(null, Buffer.from(payload), key.privateKey).toString("hex") };
  const revision = sha(payload), source = { publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
    publicKeySpkiSha256: sha(key.publicKey.export({ type: "spki", format: "der" })), revisionSha256: revision, readCurrent: () => current };
  return { source, scope: { ...input, reviewRevisionSha256: revision }, body, withdraw() { current = undefined; },
    replace(v: typeof current) { current = v; } };
}
