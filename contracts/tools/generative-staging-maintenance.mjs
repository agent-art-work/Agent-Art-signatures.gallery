import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { checkStagingInstallation } from "./generative-staging-bootstrap.mjs";
import { loadStagingInstallation } from "./generative-staging-installation.mjs";
import { inspectorConnectionFactory } from "./generative-staging-adapters.mjs";
import { inspectStagingOperation } from "../../src/openMint/persistence/stagingOperatorInspection.ts";
import { verifyStagingBackupCompletion } from "./generative-staging-backup.mjs";

const deny = () => { throw Error("Staging maintenance unavailable."); };

/** Bounded one-shot diagnosis. It has no writer, signer, RPC or provider and
 * cannot mutate or choose a role by request. `migrate-v2`/`recover` are not
 * aliases of this path and remain unavailable until separately reviewed. */
export async function inspectInstalledStaging(check, root, reference) {
  let connection;
  try {
    assert.equal(process.env.NODE_ENV, "production");
    assert.equal(realpathSync(root), root);
    assert.ok(reference && Object.getPrototypeOf(reference) === Object.prototype);
    assert.deepEqual(Object.keys(reference).sort(), ["id", "kind"]);
    assert.ok(["attempt", "authorization", "recovery"].includes(reference.kind));
    assert.match(reference.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const checked = checkStagingInstallation(check, root);
    const installation = loadStagingInstallation(check.configPath, check.configSha256, root);
    assert.equal(checked.configSha256, installation.configSha256);
    connection = inspectorConnectionFactory(installation)();
    await connection.connect();
    const result = await inspectStagingOperation(connection,
      { namespaceId: installation.config.namespaceId, deploymentId: installation.config.deploymentId },
      reference, AbortSignal.timeout(installation.operating.operatingPlan.settings.hosting.requestTimeoutMs));
    await connection.end(); connection = undefined;
    return result;
  } catch { return deny(); }
  finally { try { await connection?.end(); } catch { /* still unavailable */ } }
}

/** Authentication/stream check only. The result explicitly does not certify
 * latest completion, source isolation or permission to restore/migrate. */
export async function verifyInstalledStagingBackup(check, root, archivePath, maxArchiveBytes) {
  try {
    assert.equal(process.env.NODE_ENV, "production");
    assert.equal(realpathSync(root), root);
    const checked = checkStagingInstallation(check, root);
    const installation = loadStagingInstallation(check.configPath, check.configSha256, root);
    assert.equal(checked.configSha256, installation.configSha256);
    return await verifyStagingBackupCompletion(installation, archivePath, maxArchiveBytes);
  } catch { return deny(); }
}
