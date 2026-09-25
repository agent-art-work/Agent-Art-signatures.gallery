import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import canonicalize from "canonicalize";
import { openMountedReview } from "./generative-staging-mounts.mjs";
import { GENERATIVE_DATABASE_V2_LOCK } from "../../src/openMint/persistence/databaseSchemaV2Lock.ts";
import { admissionDigest } from "../../src/openMint/staging/admission.ts";

const deny = () => { throw Error("Staging backup completion unavailable."); };
const hash = v => typeof v === "string" && /^(?!0{64}$)[0-9a-f]{64}$/.test(v);
const exact = (v, fields) => {
  assert.ok(v && Object.getPrototypeOf(v) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(v).sort(), [...fields].sort());
};
const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode
  && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Authenticates an externally signed stopped-backup completion and streams
 * the exact selected archive. It does not infer source isolation, latest
 * completion, quiescence or restoration safety from the archive itself. */
export async function verifyStagingBackupCompletion(installation, archivePath, maxArchiveBytes, signal = new AbortController().signal) {
  let handle, source;
  try {
    const { config, evidence } = installation, pin = config.reviews.backup;
    assert.ok(typeof archivePath === "string" && archivePath.length <= 4096 && isAbsolute(archivePath)
      && resolve(archivePath) === archivePath && realpathSync(dirname(archivePath)) === dirname(archivePath)
      && Number.isSafeInteger(maxArchiveBytes) && maxArchiveBytes > 0 && maxArchiveBytes <= 64 * 1024 ** 3);
    source = openMountedReview(pin);
    const envelope = source.readCurrent(), payload = envelope.payload, body = JSON.parse(payload);
    assert.equal(canonicalize(body), payload);
    exact(body, ["version", "installationId", "databaseResourceReference", "database", "namespaceId", "deploymentId",
      "databaseBindingSha256", "archiveSha256", "archiveBytes", "stoppedAt", "migrationManifestSha256", "migrationReceiptSha256",
      "profilesSha256", "roleRecipeSha256", "inventorySha256", "isolationEvidenceSha256", "completenessEvidenceSha256"]);
    assert.equal(body.version, "sg-staging-backup-completion-v1");
    assert.equal(body.installationId, config.installationId);
    assert.equal(body.databaseResourceReference, config.connections.database.resourceReference);
    assert.equal(body.database, evidence.databaseReview.database);
    assert.equal(body.namespaceId, config.namespaceId); assert.equal(body.deploymentId, config.deploymentId);
    assert.equal(body.migrationManifestSha256, evidence.databaseReview.migrationManifestSha256);
    assert.equal(body.migrationReceiptSha256, evidence.databaseReview.migrationReceiptSha256);
    assert.equal(body.profilesSha256, evidence.databaseReview.profilesSha256);
    assert.equal(body.databaseBindingSha256, admissionDigest({ lock: GENERATIVE_DATABASE_V2_LOCK, review: evidence.databaseReview }));
    for (const name of ["databaseBindingSha256", "archiveSha256", "roleRecipeSha256", "inventorySha256", "isolationEvidenceSha256", "completenessEvidenceSha256"]) assert.ok(hash(body[name]));
    assert.ok(Number.isSafeInteger(body.archiveBytes) && body.archiveBytes > 0 && body.archiveBytes <= maxArchiveBytes);
    assert.ok(typeof body.stoppedAt === "string" && Number.isFinite(Date.parse(body.stoppedAt)) && new Date(body.stoppedAt).toISOString() === body.stoppedAt);
    const key = createPublicKey(pin.publicKeyPem);
    assert.equal(key.asymmetricKeyType, "ed25519");
    assert.equal(createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex"), pin.publicKeySpkiSha256);
    assert.equal(createHash("sha256").update(payload).digest("hex"), pin.revisionSha256);
    assert.ok(verify(null, Buffer.from(payload), key, Buffer.from(envelope.signature, "hex")));
    const named = lstatSync(archivePath);
    assert.ok(named.isFile() && named.nlink === 1 && named.size === body.archiveBytes);
    handle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    assert.ok(unchanged(named, await handle.stat()));
    const sum = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < body.archiveBytes) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, body.archiveBytes - offset), offset);
      assert.ok(bytesRead > 0); sum.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    assert.ok(unchanged(named, await handle.stat()) && unchanged(named, lstatSync(archivePath)));
    assert.equal(sum.digest("hex"), body.archiveSha256);
    return Object.freeze({ version: "sg-stopped-backup-review-v1", databaseBindingSha256: body.databaseBindingSha256,
      archiveSha256: body.archiveSha256, completionRevisionSha256: pin.revisionSha256,
      status: "authenticated-only-isolation-not-proven" });
  } catch { return deny(); }
  finally { source?.halt(); try { await handle?.close(); } catch { deny(); } }
}
