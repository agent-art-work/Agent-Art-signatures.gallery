import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import canonicalize from "canonicalize";
import { ROOT, candidateSnapshot, verifyRelease } from "./generative-release.mjs";
import { GENERATIVE_DATABASE_V2_LOCK, GENERATIVE_DATABASE_V2_MIGRATIONS } from "../../src/openMint/persistence/databaseSchemaV2Lock.ts";
import { loadStagingInstallation } from "./generative-staging-installation.mjs";
export { browserConnectionFactory, inspectorConnectionFactory, createMountedRpcs, createMountedProviders, createMountedAuthorizer } from "./generative-staging-adapters.mjs";
export { openMountedReview, readMountedSecret } from "./generative-staging-mounts.mjs";
export { createStagingSite } from "./generative-staging-site.mjs";
export { createOwnerChallenge, attachOwnerReview, readOwnerAttachmentFd } from "./generative-staging-owner.mjs";
export { createActiveStagingHealth } from "./generative-staging-health.mjs";
export { verifyStagingBackupCompletion } from "./generative-staging-backup.mjs";
import { inspectInstalledStaging, verifyInstalledStagingBackup } from "./generative-staging-maintenance.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value) && value !== "0".repeat(64);
const deny = () => { throw Error("Staging bootstrap unavailable."); };
const exact = (object, keys) => {
  assert.ok(object && Object.getPrototypeOf(object) === Object.prototype);
  assert.deepEqual(Object.keys(object).sort(), [...keys].sort());
};
const pathName = value => typeof value === "string" && value.length <= 512 && value.length > 0 && !value.startsWith("/")
  && !value.includes("\\") && value.split("/").every(part => part && part !== "." && part !== "..");
const relativeTo = (root, name) => {
  assert.ok(pathName(name));
  const file = resolve(root, name);
  assert.ok(file.startsWith(root + sep));
  return file;
};
const INSTALL_ROOT = typeof __filename === "undefined" ? realpathSync(ROOT) : realpathSync(resolve(dirname(__filename), ".."));

/** Installed artifact verification. The expected digest is supplied by the
 * trusted launcher, not taken from this package. Run an external checksum
 * before executing this code when bootstrapping on an untrusted disk. */
export function verifyStagingPackage(root, expectedSha256) {
  try {
    assert.ok(hash(expectedSha256) && isAbsolute(root) && resolve(root) === root && realpathSync(root) === root);
    const manifestPath = join(root, "release-manifest.json"), stat = lstatSync(manifestPath);
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= 1_000_000);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(readFileBounded(manifestPath, 1_000_000)).replace(/\n$/, "");
    const m = JSON.parse(raw);
    assert.equal(canonicalize(m), raw);
    assert.equal(sha(raw), expectedSha256);
    exact(m, ["schema", "status", "nodeMajor", "platform", "architecture", "dependencyLockSha256", "databaseProfile", "releaseLockSha256", "sourceSnapshotSha256", "releaseSnapshotSha256", "files"]);
    assert.equal(m.schema, "sg-staging-release-package-v1");
    assert.equal(m.status, "candidate-not-approved");
    assert.equal(m.nodeMajor, Number(process.versions.node.split(".")[0]));
    assert.equal(m.platform, process.platform); assert.equal(m.architecture, process.arch);
    assert.ok(hash(m.releaseLockSha256) && hash(m.sourceSnapshotSha256) && hash(m.releaseSnapshotSha256) && hash(m.dependencyLockSha256));
    assert.deepEqual(m.databaseProfile, GENERATIVE_DATABASE_V2_LOCK);
    assert.ok(Array.isArray(m.files) && m.files.length > 0 && m.files.length <= 2048);
    const listed = new Set(); let previous = "";
    for (const entry of m.files) {
      exact(entry, ["path", "bytes", "sha256"]);
      assert.ok(pathName(entry.path) && entry.path > previous && !listed.has(entry.path)
        && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= 32_000_000 && hash(entry.sha256));
      previous = entry.path; listed.add(entry.path);
      const file = relativeTo(root, entry.path), s = lstatSync(file);
      assert.ok(s.isFile() && s.nlink === 1 && s.size === entry.bytes && sha(readFileBounded(file, 32_000_000)) === entry.sha256);
    }
    const actual = new Set();
    const visit = directory => {
      for (const item of readdirSync(directory)) {
        const file = join(directory, item), name = relative(root, file), s = lstatSync(file);
        assert.ok(pathName(name) && !s.isSymbolicLink());
        if (s.isDirectory()) visit(file);
        else { assert.ok(s.isFile() && s.nlink === 1); actual.add(name); }
      }
    };
    visit(root); actual.delete("release-manifest.json");
    assert.deepEqual([...actual].sort(), [...listed].sort());
    assert.equal(sha(readFileBounded(join(root, "contracts/releases/generative-v1-rc1.json"), 1_000_000)), m.releaseLockSha256);
    assert.equal(sha(readFileBounded(join(root, "package-lock.json"), 4_000_000)), m.dependencyLockSha256);
    for (const migration of GENERATIVE_DATABASE_V2_MIGRATIONS) {
      const path = resolve(root, "src/openMint/persistence", migration.path);
      assert.ok(path.startsWith(join(root, "src/openMint") + sep));
      assert.equal(sha(readFileBounded(path, 4_000_000)), migration.sha256);
    }
    assert.equal(verifyRelease(root).status, "candidate-not-approved");
    assert.equal(sha(canonicalize(candidateSnapshot(root))), m.releaseSnapshotSha256);
    return Object.freeze({ root, packageSha256: expectedSha256, manifest: m });
  } catch { return deny(); }
}

/** One bounded regular file with stable metadata. Caller supplies an external
 * digest; no file may supply its own expected digest. */
export function readFileBounded(path, maximum, expectedSha256) {
  let fd;
  try {
    assert.ok(typeof path === "string" && path.length <= 4096 && isAbsolute(path) && resolve(path) === path);
    assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 32_000_000);
    if (expectedSha256 !== undefined) assert.ok(hash(expectedSha256));
    assert.equal(realpathSync(dirname(path)), dirname(path));
    const before = lstatSync(path);
    assert.ok(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= maximum);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const current = fstatSync(fd);
    assert.ok(current.isFile() && current.dev === before.dev && current.ino === before.ino && current.size === before.size);
    const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const next = readSync(fd, bytes, count, bytes.length - count, null); if (!next) break; count += next; }
    const after = fstatSync(fd), named = lstatSync(path);
    assert.ok(count === before.size && [after, named].every(s => s.dev === before.dev && s.ino === before.ino
      && s.size === before.size && s.uid === before.uid && s.mode === before.mode && s.mtimeMs === before.mtimeMs && s.ctimeMs === before.ctimeMs));
    const result = bytes.subarray(0, count);
    if (expectedSha256 !== undefined) assert.equal(sha(result), expectedSha256);
    return result;
  } catch { return deny(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readPinnedJson(input) {
  try {
    exact(input, ["path", "sha256", "maxBytes"]);
    const { path, sha256, maxBytes } = input;
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(readFileBounded(path, maxBytes, sha256)).replace(/\n$/, "");
    const parsed = JSON.parse(raw);
    assert.equal(canonicalize(parsed), raw);
    return parsed;
  } catch { return deny(); }
}

export function checkStagingInstallation(input, root = INSTALL_ROOT) {
  try {
    exact(input, ["packageSha256", "configPath", "configSha256"]);
    const release = verifyStagingPackage(root, input.packageSha256);
    const installation = loadStagingInstallation(input.configPath, input.configSha256, root), plan = installation.operating;
    return Object.freeze({ packageSha256: release.packageSha256,
      installationId: installation.config.installationId, configSha256: installation.configSha256,
      operatingPlanSha256: plan.operatingPlan.operatingPlanSha256,
      deploymentPlanSha256: plan.deploymentPlan.planSha256,
      status: "checked-only-not-admitted" });
  } catch { return deny(); }
}

async function cli() {
  if (process.argv[1] !== __filename) return;
  const [command, expectedPackage, configPath, expectedConfig, first, second] = process.argv.slice(2);
  if (!["check", "inspect", "verify-backup"].includes(command) || !hash(expectedPackage) || !isAbsolute(configPath ?? "") || !hash(expectedConfig)
    || process.argv.length !== (command === "check" ? 6 : 8)) deny();
  const check = { packageSha256: expectedPackage, configPath, configSha256: expectedConfig };
  if (command === "check") { process.stdout.write(`${JSON.stringify(checkStagingInstallation(check))}\n`); return; }
  if (process.env.NODE_ENV !== "production") deny();
  if (command === "inspect") { process.stdout.write(`${JSON.stringify(await inspectInstalledStaging(check, INSTALL_ROOT, { kind: first, id: second }))}\n`); return; }
  if (command === "verify-backup") {
    if (!/^[1-9][0-9]{0,10}$/.test(second ?? "")) deny();
    process.stdout.write(`${JSON.stringify(await verifyInstalledStagingBackup(check, INSTALL_ROOT, first, Number(second)))}\n`);
  }
}

// esbuild emits the installed CLI as CommonJS; tests import this source module.
if (typeof __filename !== "undefined") void cli().catch(() => {
  process.stderr.write("Staging bootstrap unavailable.\n"); process.exitCode = 1;
});
