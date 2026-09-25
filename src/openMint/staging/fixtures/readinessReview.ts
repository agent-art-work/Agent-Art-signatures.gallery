import { createHash, generateKeyPairSync, sign } from "node:crypto";
import canonicalize from "canonicalize";

/** Ephemeral OFFLINE TEST keys/evidence only. Never installed or persisted. */
export function readinessReviewFixture(scopeSha256 = "a".repeat(64), now = 1800000000000) {
  const key = generateKeyPairSync("ed25519");
  const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const body = { version: "sg-paused-readiness-review-v1", scopeSha256, evidenceSha256: "b".repeat(64), validFrom: now, validUntil: now + 60000 };
  const envelope = (value: unknown, canonical = true) => {
    const payload = canonical ? canonicalize(value)! : JSON.stringify(value);
    return { payload, signature: sign(null, Buffer.from(payload), key.privateKey).toString("hex") };
  };
  let current: ReturnType<typeof envelope> | undefined = envelope(body);
  const source = { publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
    publicKeySpkiSha256: sha(key.publicKey.export({ type: "spki", format: "der" })), revisionSha256: sha(current.payload),
    readCurrent: () => current };
  return { body, source, withdraw() { current = undefined; }, set(value: typeof current) { current = value; },
    replace(value: unknown, canonical = true) { current = envelope(value, canonical); source.revisionSha256 = sha(current.payload); }, now, scopeSha256 };
}
