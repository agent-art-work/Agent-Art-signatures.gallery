import { generateKeyPairSync, sign } from "node:crypto";
import canonicalize from "canonicalize";
import { admissionDigest, type AdmissionScope } from "../admission.js";
import { createLocalAdmissionReview, type LocalAdmissionReview, type SignedLocalAdmissionReview } from "../localReview.js";

/** Ephemeral TEST reviewer. Never operational evidence or user approval. */
export function localReviewFixture(input: AdmissionScope, overrides: Partial<LocalAdmissionReview> = {}) {
  const { reviewRevisionSha256: _old, ...bound } = input;
  const body: LocalAdmissionReview = { version: "local-admission-review-v1", scope: bound, operations: ["reuse"],
    validFrom: Date.now() - 1000, validUntil: Date.now() + 60000, evidenceSha256: "e".repeat(64), ...overrides };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload = canonicalize(body)!, envelope = { payload, signature: sign(null, Buffer.from(payload), privateKey).toString("hex") };
  const scope = { ...input, reviewRevisionSha256: admissionDigest(body) };
  const source: { current: SignedLocalAdmissionReview | undefined } = { current: envelope };
  const config = { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), scope, readCurrent: () => source.current };
  return { body, scope, source, envelope, config, privateKey, review: createLocalAdmissionReview(config) };
}
