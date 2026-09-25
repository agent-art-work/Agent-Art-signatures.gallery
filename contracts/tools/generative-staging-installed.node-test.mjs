import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import canonicalize from "canonicalize";
import { Client } from "pg";
import { disposablePostgres } from "../../src/openMint/persistence/fixtures/postgres.ts";
import { stagingSiteFixture } from "./fixtures/generative-staging-site.mjs";
import { createStagingSite, createInstalledStagingSite } from "./generative-staging-site.mjs";
import { checkStagingInstallation } from "./generative-staging-bootstrap.mjs";
import { loadStagingInstallation } from "./generative-staging-installation.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const sha = value => createHash("sha256").update(value).digest("hex");
const pin = (scratch, name, value, exactRaw) => {
  const path = join(scratch, `${name}.json`), bytes = exactRaw ?? `${canonicalize(value)}\n`;
  writeFileSync(path, bytes);
  return { path, sha256: sha(bytes), maxBytes: Math.max(1024, Buffer.byteLength(bytes)) };
};
const reviewer = (scratch, name, source) => {
  const key = source ?? (() => {
    const publicKey = generateKeyPairSync("ed25519").publicKey;
    return { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      publicKeySpkiSha256: sha(publicKey.export({ type: "spki", format: "der" })), revisionSha256: sha(name) };
  })();
  return { directory: scratch, fileName: `${name}.json`, ownerUid: process.getuid(),
    publicKeyPem: key.publicKeyPem, publicKeySpkiSha256: key.publicKeySpkiSha256, revisionSha256: key.revisionSha256 };
};

test("production site source composition checks a detached package and preprovisioned v2 projection only", {
  skip: process.env.OPEN_MINT_TEST_POSTGRES !== "1",
}, async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sg-r5-installed-")));
  let cluster, admin, f, site;
  const old = process.env.NODE_ENV;
  try {
    const root = join(scratch, "package");
    const built = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "scripts/build-staging-release.mjs", "--out", root],
      { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } }));
    cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect();
    f = await stagingSiteFixture(cluster, admin, { v2: true });
    // Installation is an explicit preexisting state; serving never provisions it.
    const provisioning = await createStagingSite(f.input, f.deps);
    await provisioning.close();
    const s = f.settings, db = f.input.databaseReview;
    const config = { schema: "sg-staging-installation-v1", installationId: "02ae7a4e-2433-4e75-8708-3bbcc8127c74",
      origin: s.origin, chainId: 11155111, deploymentId: s.deploymentId, namespaceId: db.namespaceId,
      operating: pin(scratch, "operating", null, f.input.operatingJson),
      evidence: { transactions: pin(scratch, "transactions", f.input.transactions), transitions: pin(scratch, "transitions", f.input.transitions),
        historyLimits: pin(scratch, "history", f.input.historyLimits), assessmentPolicy: pin(scratch, "policy", f.input.assessmentPolicy),
        databaseReview: pin(scratch, "database", db) },
      connections: { database: { resourceReference: s.database.resourceReference, host: "db.example.org", port: 5432,
        database: db.database, browserRole: s.database.roles.browser.name, tlsRoot: pin(scratch, "ca", { certificate: "fixture" }) },
        rpcs: s.rpc.sources.map(v => ({ id: v.id, operatorReference: v.operatorReference, endpointSecretReference: v.endpointSecretReference })) },
      secrets: [], reviews: { operation: reviewer(scratch, "operation", f.review.source), readiness: reviewer(scratch, "readiness"),
        recovery: reviewer(scratch, "recovery"), backup: reviewer(scratch, "backup") },
      listener: { publicPort: 3080, healthPort: 3081, attachmentWaitMs: 1000 }, supportUrl: null };
    const installed = pin(scratch, "installation", config), check = { packageSha256: built.manifestSha256,
      configPath: installed.path, configSha256: installed.sha256 };
    assert.equal(checkStagingInstallation(check, root).status, "checked-only-not-admitted");
    assert.equal(loadStagingInstallation(check.configPath, check.configSha256, root).config.namespaceId, db.namespaceId);
    process.env.NODE_ENV = "production";
    await assert.rejects(createStagingSite(f.input, f.deps), /Private staging site unavailable/);
    site = await createInstalledStagingSite(check, f.input, f.deps, root);
    assert.equal(site.server.listening, false);
    await site.start(0);
    assert.equal(site.snapshot().phase, "running");
    assert.equal(site.server.address().address, "127.0.0.1");
    assert.deepEqual(f.counts, { x: 0, grok: 0, sign: 0 });
    await site.close(); site = undefined;
    await f.db.query("DELETE FROM open_mint.projection_checkpoints WHERE deployment_id=$1", [s.deploymentId]);
    await assert.rejects(createInstalledStagingSite(check, f.input, f.deps, root), /Installed staging site unavailable/);
    assert.equal((await f.db.query("SELECT count(*)::int AS count FROM open_mint.projection_checkpoints WHERE deployment_id=$1", [s.deploymentId])).rows[0].count, 0);
    await assert.rejects(createInstalledStagingSite({ ...check, packageSha256: sha("wrong") }, f.input, f.deps, root));
    assert.deepEqual(f.counts, { x: 0, grok: 0, sign: 0 });
  } finally {
    if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old;
    await site?.close().catch(() => {});
    await f?.close(); await admin?.end(); cluster?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});
