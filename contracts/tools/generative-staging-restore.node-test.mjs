import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { test, describe } from "node:test";
import { Client } from "pg";
import { encodeEventTopics } from "viem";
import { GENERATIVE_MINT_ABI } from "../../src/openMint/generativeAuthorization.ts";
import { disposablePostgres, installSchema } from "../../src/openMint/persistence/fixtures/postgres.ts";
import { ExclusiveWriter } from "../../src/openMint/persistence/writer.ts";
import { OpenMintProjection } from "../../src/openMint/projection/postgres.ts";
import { createStagingProjectionCoordinator } from "../../src/openMint/projection/coordinator.ts";
import { createStagingGenerativeArtworkReads } from "../../src/openMint/projection/generativeArtwork.ts";
import { createStagingOperationReview } from "../../src/openMint/staging/stagingReview.ts";
import { admissionDigest } from "../../src/openMint/staging/admission.ts";
import { capabilityHash } from "../../src/openMint/persistence/sessions.ts";
import { stagingSiteFixture } from "./fixtures/generative-staging-site.mjs";
import { readinessDatabaseFixture, readinessInputFixture } from "./fixtures/generative-staging-readiness.mjs";
import { GENERATIVE_DATABASE_MIGRATIONS } from "../../src/openMint/persistence/databaseSchemaLock.ts";
import { generativeBrowserRuntimeGrants } from "../../src/openMint/persistence/runtimeRole.ts";
import { createStagingSite } from "./generative-staging-site.mjs";
import { createStagingAssessmentController, stagingRuntimeBinding } from "./generative-staging-assessment.mjs";
import { stagingNetworkBinding } from "./generative-staging-runtime.mjs";
import { dumpDisposable, openRestoredSiteInput, restoreDisposable, restoreInventory, stoppedFixtureBackup, verifyRestoredFixture } from "./fixtures/generative-staging-restore.mjs";

const hash = n => `0x${n.repeat(64)}`;
const immutableAfterRecovery = async (client, before, allowed = []) => {
  const after = await restoreInventory(client);
  for (const table of before.tables)
    if (!allowed.includes(table.name)) assert.deepEqual(after.tables.find(t => t.name === table.name), table, `${table.name} changed during recovery`);
};
function noEffectsDependencies(f, sessions) {
  const counts = { x: 0, grok: 0, sign: 0 };
  return { counts, deps: { sessions,
    identityResolver: { provenance: "x-api", async resolve() { counts.x++; throw Error("Forbidden X call after restore"); } },
    provider: { provenance: "grok", model: f.input.assessmentPolicy.model, async assess() { counts.grok++; throw Error("Forbidden Grok call after restore"); } },
    signer: { address: f.deps.signer.address, async signTypedData() { counts.sign++; throw Error("Forbidden signer call after restore"); } } } };
}
function transferAfterBackup(f, mint) {
  const recipient = `0x${"2".repeat(40)}`, previous = f.active.headers.at(-1);
  const block = { number: `0x${(BigInt(previous.number) + 1n).toString(16)}`, hash: hash("c"), parentHash: previous.hash,
    timestamp: `0x${(BigInt(previous.timestamp) + 1n).toString(16)}`, transactions: [hash("d")] };
  f.active.headers.push(block);
  const log = { address: f.config.contract.toLowerCase(), blockNumber: block.number, blockHash: block.hash,
    transactionHash: hash("d"), transactionIndex: "0x0", logIndex: "0x0", removed: false, data: "0x",
    topics: encodeEventTopics({ abi: GENERATIVE_MINT_ABI, eventName: "Transfer", args: {
      tokenId: BigInt(mint.a.handleKey), from: mint.a.recipient, to: recipient } }) };
  f.active.receipts[hash("d")] = { status: "0x1", transactionHash: hash("d"), blockHash: block.hash,
    blockNumber: block.number, transactionIndex: "0x0", logs: [log] };
  f.controls.mutation = (value, method, params) => method === "eth_getLogs" && params[0].blockHash === block.hash ? [log] : value;
  return recipient;
}
async function rebuildProjectionOnly(cluster, f) {
  const db = new Client(cluster.config); await db.connect();
  let writer;
  try {
    await installSchema(db);
    for (const file of ["projection-schema.sql", "projection-v2.sql", "projection-v3.sql"])
      await db.query(readFileSync(new URL(`../../src/openMint/projection/${file}`, import.meta.url), "utf8"));
    await db.query("INSERT INTO open_mint.namespaces VALUES($1,'staging-testnet','grok',$2)", [f.ns.id, f.ns.policyVersion]);
    writer = await ExclusiveWriter.acquire(() => new Client(cluster.config));
    const binding = stagingRuntimeBinding(f.input), { config, sources } = stagingNetworkBinding(binding, f.input.sources);
    const deployment = { id: binding.db.deploymentId, namespaceId: binding.db.namespaceId, chainId: "11155111",
      contractAddress: config.contract.toLowerCase(), manifestHash: `0x${binding.d.planSha256}`,
      deploymentBlock: String(config.deploymentBlock.number), deploymentBlockHash: config.deploymentBlock.hash,
      generativeRenderer: config.generativeRenderer,
      policy: { id: "sepolia-rc1-canonical-finalized-v1", rollbackBlocks: 128, snapshotRetentionBlocks: 8192 } };
    const projection = await OpenMintProjection.open(writer, deployment);
    const coordinator = createStagingProjectionCoordinator(projection, { deployment, config, rpcs: sources,
      maxHeadLag: 0, maxFinalizedLag: 0, maxFinalizedAgeMs: binding.s.rpc.maxFinalizedAgeMs });
    assert.deepEqual(await coordinator.lookup("alice"), { state: "unknown" });
    assert.equal(await coordinator.sync(new AbortController().signal), "observed");
    const gallery = await coordinator.gallery({ filter: { kind: "home" }, limit: 24 });
    const artwork = createStagingGenerativeArtworkReads({ config, rpcs: sources, projection: coordinator, timeoutMs: 3000 });
    const detail = await artwork.detail("alice", new AbortController().signal);
    assert.equal(detail.assessmentModel, undefined);
    return { gallery, detail, lookup: await coordinator.lookup("alice"), async close() { await artwork.drain(); await writer.close(); await db.end(); } };
  } catch (error) { await writer?.close(); await db.end(); throw error; }
}
async function request(site, fixture, path, body, cookie = fixture.sessions.cookie(fixture.session)) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: site.server.address().port, path,
      method: body === undefined ? "GET" : "POST", headers: {
        host: "staging.signatures.gallery", "x-forwarded-proto": "https", cookie,
        origin: fixture.settings.origin, "x-csrf-token": fixture.session.csrf,
        ...(data === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) }),
      } }, res => {
      const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: res.headers["content-type"]?.includes("application/json") && text ? JSON.parse(text) : undefined, text });
      });
    }); req.setTimeout(10000, () => req.destroy(Error("Restore fixture HTTP timeout"))); req.on("error", reject); req.end(data);
  });
}

async function seedInterrupted(f) {
  const ns = f.ns.id, model = f.input.assessmentPolicy.profileVersion, epoch = f.writer.epoch;
  const attempts = [];
  for (const [handle, mode] of [["uncertain", "uncertain"], ["abstain", "abstained"], ["queued", "queued"], ["interrupted", "running"], ["grokunknown", "grok"]]) {
    const id = randomUUID();
    await f.db.query("INSERT INTO open_mint.handle_guards(namespace_id,handle) VALUES($1,$2)", [ns, handle]);
    await f.db.query(`INSERT INTO open_mint.assessment_attempts(namespace_id,attempt_id,handle,profile_version,admitted_at)
      VALUES($1,$2,$3,$4,clock_timestamp())`, [ns, id, handle, model]);
    await f.db.query("INSERT INTO open_mint.budget_reservations(namespace_id,attempt_id,admitted_day,reserved_usd_ticks) VALUES($1,$2,current_date,1)", [ns, id]);
    await f.db.query(`INSERT INTO open_mint.jobs(namespace_id,job_id,attempt_id,kind,state,owner_epoch)
      VALUES($1,$2,$3,'assessment',$4,$5)`, [ns, randomUUID(), id, mode === "queued" ? "queued" : "running", mode === "queued" ? null : epoch]);
    if (mode !== "queued") await f.db.query(`INSERT INTO open_mint.dispatch_fences(namespace_id,attempt_id,leg,owner_epoch,dispatched_at)
      VALUES($1,$2,'x-identity',$3,clock_timestamp())`, [ns, id, epoch]);
    if (mode === "uncertain") await f.db.query(`INSERT INTO open_mint.assessment_terminals
      (namespace_id,attempt_id,kind,phase,owner_epoch) VALUES($1,$2,'uncertain','x-identity',$3)`, [ns, id, epoch]);
    if (mode === "abstained" || mode === "grok") {
      await f.db.query(`INSERT INTO open_mint.dispatch_fences(namespace_id,attempt_id,leg,owner_epoch,dispatched_at)
        VALUES($1,$2,'grok',$3,clock_timestamp())`, [ns, id, epoch]);
      if (mode === "abstained") await f.db.query(`INSERT INTO open_mint.assessment_terminals
        (namespace_id,attempt_id,kind,reason,phase,owner_epoch)
        VALUES($1,$2,'abstained','insufficient-evidence','grok',$3)`, [ns, id, epoch]);
    }
    if (["abstained", "uncertain"].includes(mode)) {
      await f.db.query("UPDATE open_mint.assessment_attempts SET state='closed' WHERE namespace_id=$1 AND attempt_id=$2", [ns, id]);
      await f.db.query("UPDATE open_mint.jobs SET state='complete' WHERE namespace_id=$1 AND attempt_id=$2", [ns, id]);
    }
    attempts.push({ id, mode });
  }
  const proofSession = (await f.sessions.session()).session;
  const challenge = await f.sessions.challenge(proofSession.id, f.wallet.address);
  const signature = await f.wallet.signMessage({ message: challenge.message });
  await f.sessions.verify(proofSession.id, challenge.challengeId, signature);
  const revoked = (await f.sessions.session()).session;
  await f.sessions.logout(revoked.id);
  return { revoked, attempts, proofSession, challenge, signature };
}

describe("R3 disposable RC1 backup and restore", { skip: process.env.OPEN_MINT_TEST_POSTGRES !== "1" }, () => {
  test("restores populated authority, catches up finality/transfer and rebuilds without repeating effects", { timeout: 90000 }, async () => {
    const source = disposablePostgres(), destination = disposablePostgres(), projectionOnly = disposablePostgres();
    const admin = new Client(source.config); await admin.connect();
    let f, site, restored, resumed, rebuilt;
    try {
      f = await stagingSiteFixture(source, admin);
      site = await createStagingSite(f.input, f.deps);
      await new Promise(resolve => site.server.listen(0, "127.0.0.1", resolve));
      const created = await request(site, f, "/api/assessments", { handle: "Alice" });
      assert.equal(created.status, 202, created.text); await site.idle();
      const code = created.body.code;
      const mint = await request(site, f, "/api/mints/begin", { code, consent: true });
      assert.equal(mint.status, 200, mint.text);
      const included = f.include(mint.body.transaction);
      assert.equal(await site.sync(), "observed");
      assert.equal((await site.reads.lookup("alice")).state, "confirming");
      assert.equal((await request(site, f, "/api/gallery")).body.items.length, 0);
      const reported = await request(site, f, "/api/mints/report", { code, permit: mint.body.permit, transactionHash: included.hash });
      assert.equal(reported.status, 200, reported.text);
      await site.close(); site = undefined;
      const { revoked, attempts, proofSession, challenge, signature } = await seedInterrupted(f);
      await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [f.ns.id]);
      await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false WHERE namespace_id=$1", [f.ns.id]);
      await f.writer.close();
      const { inventory, archive, completion } = await stoppedFixtureBackup(source, f);
      restored = await restoreDisposable(destination, archive, archive.sha256);
      await verifyRestoredFixture(restored, f, inventory, completion);
      await assert.rejects(restored.runtime.query("UPDATE open_mint.assessments SET payload=payload WHERE namespace_id=$1", [f.ns.id]), /permission denied/);
      await assert.rejects(restored.runtime.query("DELETE FROM open_mint.assessments WHERE namespace_id=$1", [f.ns.id]), /permission denied/);
      await assert.rejects(restored.runtime.query("UPDATE open_mint.budget_policies SET generation_enabled=true WHERE namespace_id=$1", [f.ns.id]), /permission denied/);
      assert.equal((await restored.db.query("SELECT revoked FROM open_mint.sessions WHERE namespace_id=$1 AND session_hash=$2", [f.ns.id, capabilityHash(revoked.id)])).rows[0].revoked, true);
      assert.ok(Number((await restored.db.query("SELECT count(*)::integer AS n FROM open_mint.wallet_challenges WHERE consumed_at IS NOT NULL")).rows[0].n) > 0);
      const originalEpoch = BigInt((await restored.db.query("SELECT epoch::text FROM open_mint.writer_epoch")).rows[0].epoch);
      const opened = await openRestoredSiteInput(restored, f);
      await assert.rejects(opened.sessions.requireSession(opened.sessions.cookie(revoked)), /Refresh this page/);
      assert.ok(BigInt(opened.writer.epoch) > originalEpoch);
      await assert.rejects(opened.sessions.verify(proofSession.id, challenge.challengeId, signature), { code: "CHALLENGE_EXPIRED" });
      for (const attempt of attempts.filter(a => a.mode !== "queued")) await assert.rejects(opened.repository.claimInitial(attempt.id));
      const { counts: noEffects, deps } = noEffectsDependencies(f, opened.sessions);
      const freshController = createStagingAssessmentController(opened.input);
      const sourceReview = createStagingOperationReview(f.input.reviewSource, f.review.scope);
      sourceReview.requireReview(admissionDigest(f.review.scope), "reuse", Date.now()); sourceReview.halt();
      const oldScope = { ...freshController.scope, reviewRevisionSha256: f.input.reviewSource.revisionSha256 };
      const oldReview = createStagingOperationReview(f.input.reviewSource, oldScope);
      assert.throws(() => oldReview.requireReview(admissionDigest(oldScope), "reuse", Date.now()), /review unavailable/);
      oldReview.halt(); freshController.halt();
      resumed = await createStagingSite(opened.input, deps);
      await new Promise(resolve => resumed.server.listen(0, "127.0.0.1", resolve));
      assert.equal((await request(resumed, { ...f, sessions: opened.sessions }, "/api/gallery")).status, 503);
      assert.equal(await resumed.sync(), "observed");
      assert.equal((await resumed.reads.lookup("alice")).state, "confirming");
      assert.equal((await request(resumed, { ...f, sessions: opened.sessions }, "/api/gallery")).body.items.length, 0);
      const newOwner = transferAfterBackup(f, included); f.finalize();
      assert.equal(await resumed.sync(), "observed");
      assert.equal((await request(resumed, { ...f, sessions: opened.sessions }, "/api/gallery")).body.items.length, 1);
      const finalMint = await resumed.reads.lookup("alice");
      assert.equal(finalMint.item.originalRecipient, included.a.recipient.toLowerCase());
      assert.equal(finalMint.item.currentOwner, newOwner);
      const repeatedMint = await request(resumed, { ...f, sessions: opened.sessions }, "/api/mints/begin", { code, consent: true });
      assert.equal(repeatedMint.status, 409, repeatedMint.text);
      assert.equal(repeatedMint.body.code, "SUBMISSION_UNRESOLVED");
      const duplicate = await request(resumed, { ...f, sessions: opened.sessions }, "/api/mints/report", { code, permit: mint.body.permit, transactionHash: included.hash });
      assert.equal(duplicate.status, 200, duplicate.text);
      rebuilt = await rebuildProjectionOnly(projectionOnly, f);
      assert.equal(rebuilt.gallery.state, "confirmed");
      assert.equal(rebuilt.gallery.items.length, 1);
      assert.equal(rebuilt.gallery.items[0].tokenId, (await request(resumed, { ...f, sessions: opened.sessions }, "/api/gallery")).body.items[0].tokenId);
      assert.deepEqual(rebuilt.lookup, finalMint);
      const detail = await request(resumed, { ...f, sessions: opened.sessions }, "/signatures/alice");
      assert.equal(detail.status, 200, detail.text);
      assert.match(detail.text, /grok-offline-test/);
      assert.deepEqual(noEffects, { x: 0, grok: 0, sign: 0 });
      assert.deepEqual(f.counts, { x: 1, grok: 1, sign: 1 });
      await immutableAfterRecovery(restored.db, inventory, ["writer_epoch", "projection_checkpoints", "projection_blocks", "projection_logs", "projection_ownership", "projection_promotions"]);
      console.log(JSON.stringify({ archiveBytes: archive.size, dumpMs: Math.round(archive.durationMs), restoreMs: Math.round(restored.durationMs), tables: inventory.tables.length }));
    } finally {
      await rebuilt?.close(); await resumed?.close(); await site?.close(); await restored?.close();
      await f?.close(); await admin.end(); projectionOnly.stop(); destination.stop(); source.stop();
    }
  });

  test("rejects stale, unproven, tampered, and privilege-drifted archives before ownership", { timeout: 90000 }, async () => {
    const source = disposablePostgres(), destination = disposablePostgres();
    const admin = new Client(source.config); await admin.connect();
    let f, restored;
    try {
      f = await readinessDatabaseFixture(source, admin);
      await f.pin();
      const lostSessionHash = "e".repeat(64);
      await f.db.query("INSERT INTO open_mint.sessions(namespace_id,session_hash,csrf,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
        [f.target.namespaceId, lostSessionHash, "c".repeat(43)]);
      await f.db.query("SET timezone='Asia/Shanghai'");
      const { inventory: older, archive, completion } = await stoppedFixtureBackup(source, f);
      await f.db.query("INSERT INTO open_mint.handle_guards(namespace_id,handle) VALUES($1,'later')", [f.target.namespaceId]);
      await f.db.query("UPDATE open_mint.sessions SET revoked=true,generation=generation+1 WHERE namespace_id=$1 AND session_hash=$2", [f.target.namespaceId, lostSessionHash]);
      const latest = await restoreInventory(f.db);
      assert.notEqual(older.sha256, latest.sha256);
      const damaged = { ...archive, bytes: Buffer.concat([archive.bytes, Buffer.from("x")]) };
      await assert.rejects(restoreDisposable(destination, damaged, archive.sha256), /integrity/);
      const existing = new Client(destination.config); await existing.connect();
      try {
        await existing.query("CREATE DATABASE readiness_test");
        await assert.rejects(restoreDisposable(destination, archive, archive.sha256), /already exists/);
        assert.equal((await existing.query("SELECT count(*)::integer AS n FROM pg_database WHERE datname='readiness_test'")).rows[0].n, 1);
        await existing.query("DROP DATABASE readiness_test");
        await existing.query("CREATE ROLE sg_migrator NOLOGIN");
        await assert.rejects(restoreDisposable(destination, archive, archive.sha256), /already exists/);
        assert.equal((await existing.query("SELECT count(*)::integer AS n FROM pg_roles WHERE rolname='sg_migrator'")).rows[0].n, 1);
        await existing.query("DROP ROLE sg_migrator");
      } finally { await existing.end(); }
      const truncated = { ...archive, bytes: archive.bytes.subarray(0, 512) };
      await assert.rejects(restoreDisposable(destination, truncated, createHash("sha256").update(truncated.bytes).digest("hex")), /pg_restore failed/);
      restored = await restoreDisposable(destination, archive, archive.sha256);
      assert.equal((await restored.db.query("SELECT revoked FROM open_mint.sessions WHERE session_hash=$1", [lostSessionHash])).rows[0].revoked, false);
      await assert.rejects(restored.acquire(), /verification required/);
      await assert.rejects(verifyRestoredFixture(restored, f, latest, { ...completion, inventorySha256: latest.sha256 }), /inventory mismatch/);
      await assert.rejects(openRestoredSiteInput(restored, f), /verification required/);
      await assert.rejects(verifyRestoredFixture(restored, f, older, undefined), /completeness unavailable/);
      await assert.rejects(verifyRestoredFixture(restored, f, older, { ...completion, sourceStopped: false }), /completeness unavailable/);
      assert.equal(restored.writer(), undefined);
      await restored.close(); restored = undefined;
      await admin.query("CREATE ROLE r3_missing_owner NOLOGIN");
      try {
        await f.db.query("ALTER TABLE open_mint.handle_guards OWNER TO r3_missing_owner");
        const missingRole = dumpDisposable(source, "readiness_test");
        await assert.rejects(restoreDisposable(destination, missingRole, missingRole.sha256), /pg_restore failed/);
      } finally {
        await f.db.query("ALTER TABLE open_mint.handle_guards OWNER TO sg_migrator");
        await admin.query("DROP ROLE r3_missing_owner");
      }
      // Further checks use a new complete snapshot, never re-approve the stale one.
      const current = await stoppedFixtureBackup(source, f);
      restored = await restoreDisposable(destination, current.archive, current.archive.sha256);
      await restored.db.query("GRANT DELETE ON open_mint.assessments TO sg_browser");
      await assert.rejects(verifyRestoredFixture(restored, f, current.inventory, current.completion), /grants|Grant|privilege|Privilege|match|equal/i);
      await assert.rejects(restored.acquire(), /verification required/);
      assert.equal(restored.writer(), undefined);
      await restored.db.query("REVOKE DELETE ON open_mint.assessments FROM sg_browser");
      await assert.rejects(verifyRestoredFixture(restored, f, current.inventory, { ...current.completion, runtimeProfilesSha256: "0".repeat(64) }), /source pins/);
      await verifyRestoredFixture(restored, f, current.inventory, current.completion);
      await restored.db.query("UPDATE open_mint.budget_policies SET generation_enabled=true");
      await assert.rejects(openRestoredSiteInput(restored, f), /inventory mismatch/);
      await assert.rejects(restored.acquire(), /verification required/);
    } finally {
      await restored?.close(); await f?.close(); await admin.end(); destination.stop(); source.stop();
    }
  });

  for (const saved of ["reserved", "signing", "unknown", "wallet-unknown"]) test(`preserves ${saved} across restore and private reload without effects`, { timeout: 90000 }, async () => {
    const source = disposablePostgres(), destination = disposablePostgres();
    const admin = new Client(source.config); await admin.connect();
    let f, site, restored, resumed;
    try {
      f = await stagingSiteFixture(source, admin);
      if (saved === "unknown") f.deps.signer.signTypedData = async () => { f.counts.sign++; return "0x"; };
      site = await createStagingSite(f.input, f.deps);
      await new Promise(resolve => site.server.listen(0, "127.0.0.1", resolve));
      const created = await request(site, f, "/api/assessments", { handle: "Alice" });
      assert.equal(created.status, 202, created.text); await site.idle();
      const code = created.body.code;
      const prefix = saved === "reserved" ? "INSERT INTO open_mint.generative_authorizations(" : "UPDATE open_mint.generative_authorizations SET state='signing'";
      if (["reserved", "signing"].includes(saved)) {
        let armed = false;
        f.faults.afterQuery = sql => { if (sql.startsWith(prefix)) armed = true;
          if (armed && sql === "COMMIT") throw Error("R3 lost commit acknowledgement"); };
      }
      const plan = await request(site, f, "/api/mints/begin", { code, consent: true });
      f.faults.afterQuery = undefined;
      assert.equal(plan.status === 200, saved === "wallet-unknown", plan.text);
      assert.equal((await f.db.query("SELECT state FROM open_mint.generative_authorizations")).rows[0].state, saved === "wallet-unknown" ? "signed" : saved);
      if (saved === "wallet-unknown") { f.include(plan.body.transaction); assert.equal(await site.sync(), "observed"); }
      await site.close(); site = undefined;
      await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=false");
      await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false");
      await f.writer.close();
      const { inventory, archive, completion } = await stoppedFixtureBackup(source, f);
      restored = await restoreDisposable(destination, archive, archive.sha256);
      await verifyRestoredFixture(restored, f, inventory, completion);
      const opened = await openRestoredSiteInput(restored, f), blocked = noEffectsDependencies(f, opened.sessions);
      resumed = await createStagingSite(opened.input, blocked.deps);
      await new Promise(resolve => resumed.server.listen(0, "127.0.0.1", resolve));
      const restoredFixture = { ...f, sessions: opened.sessions };
      if (saved === "wallet-unknown") {
        assert.equal(await resumed.sync(), "observed");
        assert.equal((await resumed.reads.lookup("alice")).state, "confirming");
        f.reorg(); assert.equal(await resumed.sync(), "observed");
        assert.equal((await resumed.reads.lookup("alice")).state, "unknown");
        assert.equal((await restored.db.query("SELECT count(*)::integer AS n FROM open_mint.projection_mints")).rows[0].n, 0);
        await assert.rejects(resumed.artwork.detail("alice", new AbortController().signal));
      }
      for (let i = 0; i < 2; i++) {
        const status = await request(resumed, restoredFixture, `/api/assessments/${code}`);
        assert.equal(status.status, 200, status.text); assert.equal(status.body.preparationActive, false);
        assert.equal(status.body.mint.submissionUncertain, saved === "wallet-unknown");
        assert.equal(status.body.mbti, undefined); assert.equal(status.body.permit, undefined);
      }
      let sendCount = 0;
      const retry = await request(resumed, restoredFixture, "/api/mints/begin", { code, consent: true });
      // The scripted browser sends only when given a new dispatch permit.
      if (retry.status === 200 && retry.body.permit) sendCount++;
      assert.equal(retry.status, saved === "wallet-unknown" ? 409 : 503, retry.text); assert.equal(sendCount, 0);
      if (saved === "wallet-unknown") assert.equal(retry.body.code, "SUBMISSION_UNRESOLVED");
      assert.deepEqual(blocked.counts, { x: 0, grok: 0, sign: 0 });
      await immutableAfterRecovery(restored.db, inventory, saved === "wallet-unknown"
        ? ["writer_epoch", "projection_checkpoints", "projection_blocks", "projection_mints", "projection_ownership"] : ["writer_epoch"]);
    } finally {
      if (f) f.faults.afterQuery = undefined;
      await resumed?.close(); await site?.close(); await restored?.close(); await f?.close(); await admin.end(); destination.stop(); source.stop();
    }
  });

  test("archives exact experimental profile and populated v2 projection after explicit RC1 upgrades", { timeout: 90000 }, async () => {
    const source = disposablePostgres(), destination = disposablePostgres();
    const admin = new Client(source.config); await admin.connect();
    let db, restored, created = false;
    try {
      const f = await readinessInputFixture();
      await admin.query("CREATE ROLE sg_migrator NOLOGIN; CREATE ROLE sg_browser LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
      await admin.query("CREATE DATABASE readiness_test OWNER sg_migrator"); created = true;
      db = new Client({ ...source.config, database: "readiness_test" }); await db.connect();
      await db.query("SET ROLE sg_migrator");
      const apply = async migration => db.query(readFileSync(new URL(`../../src/openMint/persistence/${migration.path}`, import.meta.url), "utf8"));
      for (const migration of GENERATIVE_DATABASE_MIGRATIONS.slice(0, 3)) await apply(migration);
      await db.query("INSERT INTO open_mint.namespaces VALUES($1,'staging-testnet','grok',$2)", [f.target.namespaceId, "test"]);
      const address = `0x${"1".repeat(40)}`;
      await db.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,
        runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms)
        VALUES($1,$2,11155111,$3,$4,$4,$3,2,$4,3000,3000,0)`, [f.target.namespaceId, f.target.deploymentId, address, hash("1")]);
      await db.query(`INSERT INTO open_mint.generative_input_profiles VALUES($1,$2,'sg-generative-inputs-experimental-1',$3,$4,$4)`,
        [f.target.namespaceId, f.target.deploymentId, address, hash("2")]);
      const historical = (await db.query("SELECT * FROM open_mint.generative_input_profiles")).rows;
      for (const migration of GENERATIVE_DATABASE_MIGRATIONS.slice(3, 8)) await apply(migration);
      const config = Buffer.from("historical-projection-v2");
      await db.query("INSERT INTO open_mint.projection_deployments VALUES($1,$2,$3)", [f.target.deploymentId, f.target.namespaceId, config]);
      await db.query("INSERT INTO open_mint.projection_checkpoints(deployment_id) VALUES($1)", [f.target.deploymentId]);
      const historicalProjection = (await db.query("SELECT * FROM open_mint.projection_deployments")).rows;
      await apply(GENERATIVE_DATABASE_MIGRATIONS[8]);
      await db.query(generativeBrowserRuntimeGrants("sg_browser"));
      await db.query("RESET ROLE");
      assert.deepEqual((await db.query("SELECT * FROM open_mint.generative_input_profiles")).rows, historical);
      assert.deepEqual((await db.query("SELECT * FROM open_mint.projection_deployments")).rows, historicalProjection);
      assert.equal((await db.query("SELECT version FROM open_mint.projection_schema_version")).rows[0].version, 3);
      const inventory = await restoreInventory(db), archive = dumpDisposable(source, "readiness_test");
      restored = await restoreDisposable(destination, archive, archive.sha256);
      assert.deepEqual(await restoreInventory(restored.db), inventory);
      assert.deepEqual((await restored.db.query("SELECT * FROM open_mint.generative_input_profiles")).rows, historical);
      assert.deepEqual((await restored.db.query("SELECT * FROM open_mint.projection_deployments")).rows, historicalProjection);
      await assert.rejects(restored.runtime.query("UPDATE open_mint.generative_input_profiles SET profile=profile"), /permission denied/);
    } finally {
      await restored?.close(); await db?.end();
      if (created) { await admin.query("DROP DATABASE readiness_test"); await admin.query("DROP ROLE sg_browser; DROP ROLE sg_migrator"); }
      await admin.end(); destination.stop(); source.stop();
    }
  });

  test("a restored safety halt cannot be cleared by fresh chain observation", { timeout: 90000 }, async () => {
    const source = disposablePostgres(), destination = disposablePostgres();
    const admin = new Client(source.config); await admin.connect();
    let f, site, restored, resumed;
    try {
      f = await stagingSiteFixture(source, admin);
      site = await createStagingSite(f.input, f.deps);
      assert.equal(await site.sync(), "observed");
      await site.close(); site = undefined;
      await f.db.query(`UPDATE open_mint.projection_checkpoints SET health='safety-halted',halt_reason='canonical-contradiction'
        WHERE deployment_id=$1`, [f.target.deploymentId]);
      await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [f.ns.id]);
      await f.db.query("UPDATE open_mint.generative_issuance_profiles SET enabled=false WHERE namespace_id=$1", [f.ns.id]);
      await f.writer.close();
      const { inventory, archive, completion } = await stoppedFixtureBackup(source, f);
      restored = await restoreDisposable(destination, archive, archive.sha256);
      await verifyRestoredFixture(restored, f, inventory, completion);
      const opened = await openRestoredSiteInput(restored, f);
      const denied = { x: 0, grok: 0, sign: 0 };
      resumed = await createStagingSite(opened.input, { sessions: opened.sessions,
        identityResolver: { provenance: "x-api", async resolve() { denied.x++; throw Error("forbidden"); } },
        provider: { provenance: "grok", model: f.input.assessmentPolicy.model, async assess() { denied.grok++; throw Error("forbidden"); } },
        signer: { address: f.deps.signer.address, async signTypedData() { denied.sign++; throw Error("forbidden"); } } });
      assert.equal(await resumed.sync(), "safety-halted");
      assert.deepEqual(denied, { x: 0, grok: 0, sign: 0 });
      assert.deepEqual((await restored.db.query("SELECT health,halt_reason FROM open_mint.projection_checkpoints WHERE deployment_id=$1",
        [f.target.deploymentId])).rows[0], { health: "safety-halted", halt_reason: "canonical-contradiction" });
    } finally {
      await resumed?.close(); await site?.close(); await restored?.close(); await f?.close(); await admin.end(); destination.stop(); source.stop();
    }
  });
});
