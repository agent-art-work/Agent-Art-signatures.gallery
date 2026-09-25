import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { keccak256, stringToHex } from "viem";
import canonicalize from "canonicalize";
import { deploymentPlan, PRINCIPALS } from "./generative-release.mjs";
import { SEPOLIA_GENESIS } from "./generative-deployment.mjs";
import { operatingSettingsFixture } from "../../src/openMint/staging/fixtures/operatingPlan.ts";
import { openMountedReview, readMountedSecret } from "./generative-staging-mounts.mjs";
import { browserConnectionFactory, inspectorConnectionFactory, createMountedAuthorizer, createMountedProviders, createMountedRpcs } from "./generative-staging-adapters.mjs";
import { GROK_PILOT_PROFILE } from "../../src/openMint/providerProfile.ts";
import { attachOwnerReview, createOwnerChallenge } from "./generative-staging-owner.mjs";
import { createActiveStagingHealth } from "./generative-staging-health.mjs";
import { verifyStagingBackupCompletion } from "./generative-staging-backup.mjs";
import { startInstalledStagingService } from "./generative-staging-service.mjs";
import { admissionDigest } from "../../src/openMint/staging/admission.ts";
import { GENERATIVE_DATABASE_V2_LOCK } from "../../src/openMint/persistence/databaseSchemaV2Lock.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const run = (args, cwd = repo) => execFileSync(process.execPath, args, {
  cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "pipe", "pipe"],
});
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const pinned = (scratch, name, value) => {
  const path = join(scratch, `${name}.json`), raw = `${canonicalize(value)}\n`;
  writeFileSync(path, raw);
  return { path, sha256: sha(raw), maxBytes: Math.max(raw.length, 1024) };
};
function passiveConfig(scratch) {
  const deployment = { chainId: 11155111, origin: "https://staging.signatures.gallery", genesisHash: SEPOLIA_GENESIS,
    adminDelay: "172800", rendererNonce: "0", collectionNonce: "1", principals: Object.fromEntries(PRINCIPALS.map(name => [name, {
      address: `0x${keccak256(stringToHex(`UNOWNED R5 FIXTURE/${name}`)).slice(-40)}`, ownerReference: `custodians/${name.toLowerCase()}`,
    }])) };
  const settings = operatingSettingsFixture(deploymentPlan(deployment));
  settings.schema = "sg-sepolia-operating-settings-v2";
  settings.database.schemaProfile = "sg-generative-database-v2";
  settings.database.roles.inspector = { name: "sg_inspector", connectionSecretReference: "secret:gallery/database/inspector" };
  const namespaceId = "3f7faf5a-93b3-47c4-b8c8-c3a5b4ec32ee";
  const reviews = Object.fromEntries(["operation", "readiness", "recovery", "backup"].map(name => {
    const key = generateKeyPairSync("ed25519").publicKey;
    return [name, { directory: scratch, fileName: `${name}.json`, ownerUid: process.getuid(),
      publicKeyPem: key.export({ type: "spki", format: "pem" }).toString(),
      publicKeySpkiSha256: sha(key.export({ type: "spki", format: "der" })), revisionSha256: sha(name) }];
  }));
  const config = { schema: "sg-staging-installation-v1", installationId: "02ae7a4e-2433-4e75-8708-3bbcc8127c74",
    origin: settings.origin, chainId: 11155111, deploymentId: settings.deploymentId, namespaceId,
    operating: pinned(scratch, "operating", { deployment, settings }),
    evidence: { transactions: pinned(scratch, "transactions", []), transitions: pinned(scratch, "transitions", []),
      historyLimits: pinned(scratch, "limits", { maxHistorySpan: 256, logBlockRange: 2, maxLogs: 128, maxTransactions: 32 }),
      assessmentPolicy: pinned(scratch, "policy", {}), databaseReview: pinned(scratch, "dbreview", { version: "sg-generative-runtime-db-review-v2", namespaceId,
        deploymentId: settings.deploymentId, database: "sg_staging" }) },
    connections: { database: { resourceReference: settings.database.resourceReference, host: "db.example.org", port: 5432,
      database: "sg_staging", browserRole: settings.database.roles.browser.name, tlsRoot: pinned(scratch, "ca", { certificate: "offline-fixture" }) },
      rpcs: settings.rpc.sources.map(v => ({ id: v.id, operatorReference: v.operatorReference, endpointSecretReference: v.endpointSecretReference })) },
    secrets: [], reviews, listener: { publicPort: 3080, healthPort: 3081, attachmentWaitMs: 1000 }, supportUrl: null };
  return pinned(scratch, "installation", config);
}

test("detached package verifies only against an independently supplied digest", () => {
  const scratch = mkdtempSync(join(tmpdir(), "sg-staging-package-"));
  try {
    const root = resolve(realpathSync(scratch), "installed"), output = JSON.parse(run(["--import", "tsx", "scripts/build-staging-release.mjs", "--out", root]));
    assert.equal(output.status, "candidate-not-approved");
    const repeat = JSON.parse(run(["--import", "tsx", "scripts/build-staging-release.mjs", "--out", resolve(scratch, "repeat")]));
    assert.equal(repeat.manifestSha256, output.manifestSha256);
    const probe = `const p=require(${JSON.stringify(join(root, "bin/staging.cjs"))});
      const v=p.verifyStagingPackage(${JSON.stringify(root)},${JSON.stringify(output.manifestSha256)});
      process.stdout.write(JSON.stringify({count:v.manifest.files.length,lock:v.manifest.databaseProfile.version}));`;
    assert.deepEqual(JSON.parse(run(["-e", probe], scratch)), { count: output.files, lock: "sg-generative-database-v2" });
    const config = passiveConfig(realpathSync(scratch));
    const checked = JSON.parse(run([join(root, "bin/staging.cjs"), "check", output.manifestSha256, config.path, config.sha256], scratch));
    assert.equal(checked.status, "checked-only-not-admitted");
    assert.equal(checked.configSha256, config.sha256);
    assert.throws(() => run([join(root, "bin/staging.cjs"), "serve", output.manifestSha256, config.path, config.sha256], scratch));
    assert.throws(() => run([join(root, "bin/staging.cjs"), "inspect", output.manifestSha256, config.path, config.sha256,
      "attempt", "02ae7a4e-2433-4e75-8708-3bbcc8127c74"], scratch));
    assert.throws(() => run([join(root, "bin/staging.cjs"), "verify-backup", output.manifestSha256, config.path, config.sha256,
      join(scratch, "archive"), "1024"], scratch));
    // Even in production mode a passive fixture without an explicit inspector
    // mount refuses before any database connection is attempted.
    assert.throws(() => execFileSync(process.execPath, [join(root, "bin/staging.cjs"), "inspect", output.manifestSha256,
      config.path, config.sha256, "attempt", "02ae7a4e-2433-4e75-8708-3bbcc8127c74"], {
      cwd: scratch, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"],
    }));
    assert.throws(() => execFileSync(process.execPath, [join(root, "bin/staging.cjs"), "verify-backup", output.manifestSha256,
      config.path, config.sha256, join(scratch, "archive"), "1024"], {
      cwd: scratch, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"],
    }));
    const mounted = realpathSync(scratch), archive = join(mounted, "offline-stopped.archive"), archiveBytes = Buffer.from("disposable stopped-backup fixture");
    writeFileSync(archive, archiveBytes);
    const backupKey = generateKeyPairSync("ed25519"), backupConfig = JSON.parse(readFileSync(config.path, "utf8"));
    const databaseReview = { ...JSON.parse(readFileSync(backupConfig.evidence.databaseReview.path, "utf8")),
      migrationManifestSha256: GENERATIVE_DATABASE_V2_LOCK.migrationManifestSha256,
      migrationReceiptSha256: sha("migration"), profilesSha256: sha("profiles"), reviewRevisionSha256: sha("database-review") };
    backupConfig.evidence.databaseReview = pinned(mounted, "backed-database-review", databaseReview);
    const completion = { version: "sg-staging-backup-completion-v1", installationId: backupConfig.installationId,
      databaseResourceReference: backupConfig.connections.database.resourceReference, database: databaseReview.database,
      namespaceId: backupConfig.namespaceId, deploymentId: backupConfig.deploymentId,
      databaseBindingSha256: admissionDigest({ lock: GENERATIVE_DATABASE_V2_LOCK, review: databaseReview }),
      archiveSha256: sha(archiveBytes), archiveBytes: archiveBytes.length, stoppedAt: "2026-09-25T00:00:00.000Z",
      migrationManifestSha256: databaseReview.migrationManifestSha256, migrationReceiptSha256: databaseReview.migrationReceiptSha256,
      profilesSha256: databaseReview.profilesSha256, roleRecipeSha256: sha("roles"), inventorySha256: sha("inventory"),
      isolationEvidenceSha256: sha("isolation"), completenessEvidenceSha256: sha("completeness") };
    const backupPayload = canonicalize(completion), backupPath = join(mounted, "backup-completion.json");
    writeFileSync(backupPath, `${canonicalize({ payload: backupPayload,
      signature: sign(null, Buffer.from(backupPayload), backupKey.privateKey).toString("hex") })}\n`, { mode: 0o600 });
    backupConfig.reviews.backup = { directory: mounted, fileName: "backup-completion.json", ownerUid: process.getuid(),
      publicKeyPem: backupKey.publicKey.export({ type: "spki", format: "pem" }).toString(),
      publicKeySpkiSha256: sha(backupKey.publicKey.export({ type: "spki", format: "der" })), revisionSha256: sha(backupPayload) };
    const backed = pinned(mounted, "backed-installation", backupConfig);
    assert.equal(JSON.parse(run([join(root, "bin/staging.cjs"), "check", output.manifestSha256, backed.path, backed.sha256], scratch)).status,
      "checked-only-not-admitted");
    const backedArgs = [join(root, "bin/staging.cjs"), "verify-backup", output.manifestSha256, backed.path, backed.sha256, archive, "1024"];
    const backedEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production" };
    const authenticated = JSON.parse(execFileSync(process.execPath, backedArgs,
      { cwd: scratch, encoding: "utf8", env: backedEnv, stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(authenticated.status, "authenticated-only-isolation-not-proven");
    assert.equal(authenticated.archiveSha256, sha(archiveBytes));
    writeFileSync(archive, Buffer.from("disposable STOPPED-backup fixture"));
    assert.throws(() => execFileSync(process.execPath, backedArgs,
      { cwd: scratch, encoding: "utf8", env: backedEnv, stdio: ["ignore", "pipe", "pipe"] }));
    assert.throws(() => run([join(root, "bin/staging.cjs"), "check", output.manifestSha256, config.path, sha("wrong pin")], scratch));
    const linked = join(scratch, "linked-installation.json");
    symlinkSync(config.path, linked);
    assert.throws(() => run([join(root, "bin/staging.cjs"), "check", output.manifestSha256, linked, config.sha256], scratch));
    const extra = { ...JSON.parse(readFileSync(config.path, "utf8")), allowProduction: true };
    const extraRaw = `${canonicalize(extra)}\n`;
    writeFileSync(config.path, extraRaw);
    assert.throws(() => run([join(root, "bin/staging.cjs"), "check", output.manifestSha256, config.path, sha(extraRaw)], scratch));
    assert.throws(() => run(["-e", `const p=require(${JSON.stringify(join(root, "bin/staging.cjs"))});p.verifyStagingPackage(${JSON.stringify(root)},${JSON.stringify("a".repeat(64))})`], scratch));
    const file = join(root, "contracts/foundry.toml"), original = readFileSync(file);
    writeFileSync(file, Buffer.concat([original, Buffer.from("\n# tampered\n")]));
    assert.throws(() => run(["-e", probe], scratch));
    writeFileSync(file, original);
    writeFileSync(join(root, "unexpected"), "unlisted");
    assert.throws(() => run(["-e", probe], scratch));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("the unreviewed installed owner draft cannot acquire a writer or open a listener", async () => {
  await assert.rejects(startInstalledStagingService(undefined, undefined), /not accepted/);
});

test("mounted inputs are exact, permission-checked and review withdrawal is sticky", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sg-staging-mounts-")));
  try {
    const path = join(scratch, "provider.secret"), reference = "secret:gallery/xai", ownerUid = process.getuid();
    writeFileSync(path, "opaque-fixture-token", { mode: 0o600 });
    const config = { secrets: [{ reference, path, ownerUid }] };
    assert.equal(readMountedSecret(config, reference), "opaque-fixture-token");
    assert.throws(() => readMountedSecret(config, "secret:gallery/x"));
    chmodSync(path, 0o644); assert.throws(() => readMountedSecret(config, reference));
    chmodSync(path, 0o600);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"), payload = canonicalize({ kind: "offline-fixture" });
    const reviewPath = join(scratch, "operation.json"), envelope = { payload, signature: sign(null, Buffer.from(payload), privateKey).toString("hex") };
    writeFileSync(reviewPath, `${canonicalize(envelope)}\n`, { mode: 0o600 });
    const reviewer = { directory: scratch, fileName: "operation.json", ownerUid,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      publicKeySpkiSha256: sha(publicKey.export({ type: "spki", format: "der" })), revisionSha256: sha(payload) };
    const source = openMountedReview(reviewer);
    assert.deepEqual(source.readCurrent(), envelope);
    writeFileSync(reviewPath, `${canonicalize({ ...envelope, signature: "0".repeat(128) })}\n`);
    assert.deepEqual(source.readCurrent().signature, "0".repeat(128)); // Loader protects bytes; signature validator rejects it.
    rmSync(reviewPath);
    symlinkSync(path, reviewPath);
    assert.throws(() => source.readCurrent());
    rmSync(reviewPath);
    writeFileSync(reviewPath, `${canonicalize(envelope)}\n`, { mode: 0o600 });
    assert.throws(() => source.readCurrent());
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("real adapters construct without network/effects, reject send methods and crossed custody", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sg-staging-adapters-")));
  try {
    const secret = (reference, filename, value) => {
      const path = join(scratch, filename); writeFileSync(path, value, { mode: 0o600 });
      return { reference, path, ownerUid: process.getuid() };
    };
    const secrets = [secret("secret:rpc/a", "rpc-a", "https://rpc-a.example.org/key"),
      secret("secret:rpc/b", "rpc-b", "https://rpc-b.example.org/key"),
      secret("secret:db/browser", "db-password", "opaque-password"),
      secret("secret:db/inspector", "inspector-password", "opaque-inspector-password"),
      secret("secret:x", "x", "opaque-x"), secret("secret:xai", "xai", "opaque-xai"),
      secret("secret:authorizer", "signer", `0x${"1".repeat(64)}`)];
    const caPath = join(scratch, "ca.pem"), ca = "-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----\n";
    writeFileSync(caPath, ca);
    const config = { secrets, connections: { database: { host: "db.example.org", port: 5432, database: "sg_staging", browserRole: "sg_browser",
      tlsRoot: { path: caPath, sha256: sha(ca), maxBytes: 4096 } },
      rpcs: [{ id: "service:rpc/a", operatorReference: "owner:rpc/a", endpointSecretReference: "secret:rpc/a" },
        { id: "service:rpc/b", operatorReference: "owner:rpc/b", endpointSecretReference: "secret:rpc/b" }] } };
    const settings = { database: { roles: { browser: { name: "sg_browser", connectionSecretReference: "secret:db/browser" },
      inspector: { name: "sg_inspector", connectionSecretReference: "secret:db/inspector" } } },
      hosting: { requestTimeoutMs: 5000 }, rpc: { timeoutMs: 1000, jsonResponseBytes: 65536 },
      assessment: { xCredentialReference: "secret:x", xaiCredentialReference: "secret:xai" },
      custody: { authorizer: { address: "0x0000000000000000000000000000000000000001", signerSecretReference: "secret:authorizer" } } };
    const installation = { config, operating: { operatingPlan: { settings } }, evidence: { databaseReview: { database: "sg_staging", inspectorRole: "sg_inspector" },
      assessmentPolicy: { model: GROK_PILOT_PROFILE.model, profileVersion: GROK_PILOT_PROFILE.id } } };
    let calls = 0;
    const rpcs = createMountedRpcs(installation, async () => { calls++; throw Error("No network in constructor"); });
    assert.equal(rpcs.length, 2); assert.equal(calls, 0);
    await assert.rejects(rpcs[0].request("eth_sendRawTransaction", [], new AbortController().signal)); assert.equal(calls, 0);
    assert.throws(() => createMountedProviders(installation, async () => { calls++; throw Error("No provider call in constructor"); }));
    assert.equal(calls, 0); // The historical pricing profile has expired.
    assert.throws(() => createMountedAuthorizer(installation));
    let received;
    class FakeClient {
      constructor(options) { received = options; }
      on() {} async connect() {}
      async query() { return { rows: [{ session_user: received.user, current_user: received.user, database: "sg_staging", version: "160000", replica: false }] }; }
      async end() {}
    }
    const browser = browserConnectionFactory(installation, FakeClient)();
    await browser.connect();
    assert.equal(received.ssl.rejectUnauthorized, true); assert.equal(received.ssl.servername, "db.example.org");
    assert.equal(received.password, "opaque-password");
    const inspector = inspectorConnectionFactory(installation, FakeClient)();
    await inspector.connect();
    assert.equal(received.user, "sg_inspector"); assert.equal(received.password, "opaque-inspector-password");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("owner handoff binds the acquired epoch and consumes one external attachment", async () => {
  const reviewRevisionSha256 = sha("independently pinned review"), installation = {
    configSha256: sha("externally pinned config"),
    config: { installationId: "02ae7a4e-2433-4e75-8708-3bbcc8127c74", deploymentId: "ba911503-81c4-41c8-8209-e9589b94bdb0",
      namespaceId: "3f7faf5a-93b3-47c4-b8c8-c3a5b4ec32ee", origin: "https://staging.signatures.gallery", chainId: 11155111,
      reviews: { operation: { revisionSha256: reviewRevisionSha256 } } },
    operating: { operatingPlan: { operatingPlanSha256: sha("plan") }, deploymentPlan: { planSha256: sha("deployment") } },
    evidence: { databaseReview: { reviewRevisionSha256: sha("database") } },
  };
  const writer = { epoch: "42", assertHealthy() {} }, packageSha256 = sha("package");
  const scopeFor = epoch => ({ operatingPlanSha256: installation.operating.operatingPlan.operatingPlanSha256,
    activePolicySha256: sha("active-policy"), databaseBindingSha256: sha("binding"), reviewRevisionSha256, writerEpoch: epoch,
    timeoutMs: 1000, permitTtlMs: 1000, paidValidFrom: 1, paidValidUntil: 2 });
  const challenge = createOwnerChallenge(installation, packageSha256, writer, scopeFor("42"));
  const record = { schema: "sg-staging-owner-attachment-v1", scopeSha256: challenge.scopeSha256,
    ownerNonce: challenge.scope.ownerNonce, writerEpoch: writer.epoch, reviewRevisionSha256 };
  const receive = value => async () => Buffer.from(canonicalize(value));
  assert.equal((await attachOwnerReview(challenge, reviewRevisionSha256, receive(record), 1000)).attached, true);
  await assert.rejects(attachOwnerReview(challenge, reviewRevisionSha256, receive({ ...record, writerEpoch: "41" }), 1000));
  const restarted = createOwnerChallenge(installation, packageSha256, { ...writer, epoch: "43" }, scopeFor("43"));
  await assert.rejects(attachOwnerReview(restarted, reviewRevisionSha256, receive(record), 1000));
  await assert.rejects(attachOwnerReview(challenge, reviewRevisionSha256, async () => new Promise(() => {}), 10));
});

test("single-use inherited fd 3 reads a bounded attachment without a web endpoint", async () => {
  const source = fileURLToPath(new URL("./generative-staging-owner.mjs", import.meta.url));
  const code = `import(${JSON.stringify(source)}).then(async m => {
    try { const value = await m.readOwnerAttachmentFd(new AbortController().signal); process.stdout.write(value.toString()); }
    catch { process.exitCode = 2; }
  })`;
  const child = spawn(process.execPath, ["--import", "tsx", "-e", code], {
    cwd: repo, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", part => { stdout += part; });
  child.stdio[3].end("fixture-attachment");
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(exit, 0); assert.equal(stdout, "fixture-attachment");
});

test("private active health reads snapshots and review only, withdrawing readiness immediately", async () => {
  let state = { phase: "running", observer: { state: "waiting", failures: 0 } }, review = true, reads = 0;
  const health = createActiveStagingHealth({ port: 0, site: { snapshot: () => { reads++; return state; } },
    writer: { assertHealthy() {} }, assertReview() { if (!review) throw Error("withdrawn"); } });
  try {
    await health.start();
    const url = `http://127.0.0.1:${health.address().port}`;
    assert.equal((await fetch(`${url}/_health/ready`)).status, 200);
    review = false; assert.equal((await fetch(`${url}/_health/ready`)).status, 503);
    review = true; state = { phase: "running", observer: { state: "backing-off", failures: 1 } };
    assert.equal((await fetch(`${url}/_health/ready`)).status, 503);
    assert.equal((await fetch(`${url}/_health/live`)).status, 200);
    assert.ok(reads >= 4);
  } finally { await health.close(); }
});

test("signed stopped-backup completion authenticates exact streamed archive but grants no restore", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sg-staging-backup-")));
  try {
    const archivePath = join(scratch, "stopped.backup"), bytes = Buffer.from("offline backup fixture");
    writeFileSync(archivePath, bytes);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"), review = {
      version: "sg-generative-runtime-db-review-v2", database: "sg_staging", migrationManifestSha256: GENERATIVE_DATABASE_V2_LOCK.migrationManifestSha256,
      migrationReceiptSha256: sha("migration"), profilesSha256: sha("profiles") };
    const config = { installationId: "02ae7a4e-2433-4e75-8708-3bbcc8127c74", namespaceId: "3f7faf5a-93b3-47c4-b8c8-c3a5b4ec32ee",
      deploymentId: "ba911503-81c4-41c8-8209-e9589b94bdb0", connections: { database: { resourceReference: "resource:gallery/database" } }, reviews: {} };
    const body = { version: "sg-staging-backup-completion-v1", installationId: config.installationId,
      databaseResourceReference: config.connections.database.resourceReference, database: review.database,
      namespaceId: config.namespaceId, deploymentId: config.deploymentId,
      databaseBindingSha256: admissionDigest({ lock: GENERATIVE_DATABASE_V2_LOCK, review }), archiveSha256: sha(bytes), archiveBytes: bytes.length,
      stoppedAt: "2026-09-25T00:00:00.000Z", migrationManifestSha256: review.migrationManifestSha256,
      migrationReceiptSha256: review.migrationReceiptSha256, profilesSha256: review.profilesSha256,
      roleRecipeSha256: sha("roles"), inventorySha256: sha("inventory"), isolationEvidenceSha256: sha("isolation"),
      completenessEvidenceSha256: sha("completeness") };
    const payload = canonicalize(body), fileName = "backup-review.json";
    writeFileSync(join(scratch, fileName), `${canonicalize({ payload, signature: sign(null, Buffer.from(payload), privateKey).toString("hex") })}\n`, { mode: 0o600 });
    config.reviews.backup = { directory: scratch, fileName, ownerUid: process.getuid(),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      publicKeySpkiSha256: sha(publicKey.export({ type: "spki", format: "der" })), revisionSha256: sha(payload) };
    const installation = { config, evidence: { databaseReview: review } };
    const accepted = await verifyStagingBackupCompletion(installation, archivePath, 1024);
    assert.equal(accepted.status, "authenticated-only-isolation-not-proven");
    writeFileSync(archivePath, Buffer.from("OFFLINE backup fixture"));
    await assert.rejects(verifyStagingBackupCompletion(installation, archivePath, 1024));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
