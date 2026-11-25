import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { ARCHIVE_DDL, candidateArchive } from "../../../.local/candidate-build/candidates/archive.js";
import { sealRecord } from "../../../.local/candidate-build/candidates/envelope.js";
import { CUTOFF_DOMAIN, RIGHTS_DOMAIN } from "../../../.local/candidate-build/candidates/restore.js";
import { CANDIDATE_DDL } from "../../../.local/candidate-build/candidates/schema.js";
import { curveCandidates } from "../../../.local/candidate-build/candidates/service.js";
import { candidateStore } from "../../../.local/candidate-build/candidates/store.js";
import { COMMISSION_DDL, initializeGate, qualifiedWriter, retireGate } from "./d1-recovery-fixture.mjs";
import { privateUnsealedStatus, UNSEALED_OPERATION_DDL } from "./d1-recovery-status.mjs";

const dependency = name => process.env.CANDIDATE_TEST_TOOLS
  ? pathToFileURL(resolve(process.env.CANDIDATE_TEST_TOOLS, "node_modules", name, "package.json"))
  : new URL(import.meta.resolve(name + "/package.json"));
const { Miniflare, convertV4MiniflareOptions } = createRequire(dependency("miniflare"))("miniflare");
const { build } = createRequire(dependency("esbuild"))("esbuild");
const fixture = JSON.parse(await readFile(new URL("CROSS-HOST-RESTORE-FIXTURE.json", import.meta.url), "utf8"));
const { bindingLabels, fixtureClock, actorLabels } = fixture;
const curator = { role: "curator", curatorId: actorLabels.curator };
const agent = { ...curator, role: "agent", agentId: actorLabels.agent };
const outsider = { role: "curator", curatorId: "other-fixture-curator" };
const sourceGeneration = fixture.sourceWriterGeneration;
const destinationGeneration = fixture.proposedReplacementGeneration;
const bind = (db, sql, ...params) => db.prepare(sql).bind(...params);
const counts = async db => Promise.all(
  ["curve_attempts", "curve_outbox", "curve_restrictions", "curve_gallery", "curve_winners", "recovery_guard"].map(async table =>
    (await db.prepare("SELECT count(*) AS n FROM " + table).first()).n),
);

const worker = `
  import { candidateArchive } from "./.local/candidate-build/candidates/archive.js";
  import { restoreD1Fixture, restoredInspectionAllowed } from "./services/signatures/qualification/d1-recovery-fixture.mjs";
  import { privateUnsealedStatus } from "./services/signatures/qualification/d1-recovery-status.mjs";

  function verifyKey(hex) {
    return crypto.subtle.importKey("raw", Uint8Array.from(hex.match(/../g), value => Number.parseInt(value, 16)),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  }

  const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  const notFound = () => json({ code: "not_found" }, 404);

  export default { async fetch(request, env) {
    if ("SOURCE" in env) throw Error("replacement received a source binding");
    const { pathname } = new URL(request.url);
    const authorization = request.headers.get("authorization");
    const { BINDING: binding, IDENTITY: identity, GENERATION: generation, ARCHIVE, CONTROL, DEST } = env;
    const custody = { binding, key: await verifyKey(env.ARCHIVE_KEY), archive: candidateArchive(ARCHIVE) };
    if (request.method !== "POST") return notFound();
    try {
      if (pathname === "/status") {
        const actor = env.CALLERS.find(person => person.token === authorization)?.actor;
        if (!actor) return notFound();
        const { operation } = await request.json();
        const result = await privateUnsealedStatus({ control: CONTROL, identity, generation, custody, actor,
          operation, now: () => env.NOW });
        return result ? json(result) : notFound();
      }
      if (authorization !== env.TEST_OPERATOR) return notFound();
      if (pathname === "/inspect") {
        return json({ open: await restoredInspectionAllowed(CONTROL, DEST, binding, identity, generation) });
      }
      if (pathname === "/restore") {
        const { cutoff, authority } = await request.json();
        const count = await restoreD1Fixture({ control: CONTROL, destination: DEST, identity, generation, custody,
          authorityKey: await verifyKey(env.AUTHORITY_KEY), cutoff, authority });
        return json({ count });
      }
      return notFound();
    } catch (error) {
      return json({ code: error.code ?? "storage_error" }, error.status ?? 503);
    }
  } };
`;

test("local Workerd closes distinct-target competition and private unsealed status", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "sg-d1-controls-"));
  let runtime;
  t.after(async () => {
    await runtime?.dispose();
    await rm(directory, { recursive: true });
  });
  const archiveBytes = crypto.getRandomValues(new Uint8Array(32));
  const authorityBytes = crypto.getRandomValues(new Uint8Array(32));
  const importKey = bytes => crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify", "sign"]);
  const [archiveKey, authorityKey] = await Promise.all([importKey(archiveBytes), importKey(authorityBytes)]);
  const operatorToken = crypto.randomUUID();
  const callers = [curator, outsider, agent].map(actor => ({ actor, token: crypto.randomUUID() }));
  const built = await build({ bundle: true, write: false, format: "esm", target: "es2022", external: ["node:crypto"],
    stdin: { contents: worker, resolveDir: fileURLToPath(new URL("../../../", import.meta.url)) } });
  const shared = { ARCHIVE: "retained", CONTROL: "authority" };
  const options = { host: "127.0.0.1", port: 0, resourcePersistencePath: directory, cf: false };
  const workerOptions = { modules: true, compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"],
    outboundService: () => { throw Error("external I/O is prohibited"); } };

  async function seed() {
    runtime = new Miniflare(convertV4MiniflareOptions({ ...options, ...workerOptions,
      script: "export default { fetch() { return new Response(null); } };",
      d1Databases: { ...shared, SOURCE: "primary" } }));
    const [primary, archiveDb, control] = await Promise.all(["SOURCE", "ARCHIVE", "CONTROL"].map(name => runtime.getD1Database(name)));
    await primary.batch(CANDIDATE_DDL.map(sql => primary.prepare(sql)));
    await control.batch([COMMISSION_DDL, UNSEALED_OPERATION_DDL].map(sql => control.prepare(sql)));
    await archiveDb.prepare(ARCHIVE_DDL).run();
    const sourceIdentity = "original-writer";
    await initializeGate(primary, sourceIdentity, sourceGeneration, "write");
    await initializeGate(archiveDb, sourceIdentity, sourceGeneration, "write");
    const database = qualifiedWriter(primary, sourceIdentity, sourceGeneration);
    const archive = candidateArchive(qualifiedWriter(archiveDb, sourceIdentity, sourceGeneration));
    async function prepare(spec, binding) {
      let time = spec.approvalAt;
      const service = curveCandidates(database, { archive, binding, key: archiveKey }, () => time, 1);
      const { encounter } = await service.start(agent, { handle: spec.handle });
      const { digest, svgSha256 } = await service.propose(agent, { encounter, previousDigest: null, edit: spec.edit, intention: spec.intention });
      assert.equal(svgSha256, spec.editedSvgSha256);
      const approval = await service.approve(curator, encounter, digest);
      time = spec.commitAt;
      const result = await service.submit(agent, { encounter, digest, operation: spec.operation });
      return { encounter, result, approval, operation: spec.operation };
    }

    await prepare(fixture.candidates[0], bindingLabels.sealed);
    await primary.prepare(`CREATE TRIGGER hold_projection BEFORE UPDATE OF published_at ON curve_outbox
      BEGIN SELECT RAISE(ABORT, 'fixture holds pending operation before projection'); END;`).run();
    const pending = await prepare(fixture.candidates[2], bindingLabels.unsealed);
    assert.equal(pending.result.status, "pending_archive");
    assert.equal((await candidateStore(database).exportState(pending.encounter)).published_at, null);
    const retainedPending = await archive.read(bindingLabels.unsealed, pending.encounter);
    assert.ok(retainedPending);
    assert.equal((await retireGate(primary, sourceIdentity, sourceGeneration)).phase, "retired");
    assert.equal((await retireGate(archiveDb, sourceIdentity, sourceGeneration)).phase, "retired");

    const entries = await archive.inventory(bindingLabels.sealed);
    assert.equal(entries.length, 1);
    const cutoff = await sealRecord(authorityKey, CUTOFF_DOMAIN, JSON.stringify({
      schema: CUTOFF_DOMAIN, profile: fixture.profile, binding: bindingLabels.sealed, cutoffAt: fixtureClock.sealedCutoff, entries,
    }));
    const authority = await sealRecord(authorityKey, RIGHTS_DOMAIN, JSON.stringify({
      schema: RIGHTS_DOMAIN, binding: bindingLabels.sealed, cutoffDigest: cutoff.digest,
      asOf: fixtureClock.laterRevision, revocations: [],
    }));
    await control.batch([
      bind(control, "INSERT INTO recovery_commission VALUES (?, ?, ?, ?, ?, 1, 1)",
        bindingLabels.sealed, "target-a", destinationGeneration, cutoff.digest, authority.digest),
      bind(control, "INSERT INTO recovery_commission VALUES (?, ?, ?, NULL, NULL, 1, 1)",
        bindingLabels.unsealed, "private-status", destinationGeneration),
      bind(control, `INSERT INTO recovery_unsealed_operation
        (binding, operation, encounter, curator, recover_from, recover_until, pending_envelope_sha) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      bindingLabels.unsealed, pending.operation, pending.encounter, curator.curatorId,
      pending.approval.approvedAt, pending.approval.recoverUntil, retainedPending.digest),
    ]);
    return { cutoff, authority, pending, retainedPending };
  }

  const { cutoff, authority, pending, retainedPending } = await seed();
  async function openTargets() {
    await runtime.dispose();
    const bindings = { GENERATION: destinationGeneration, NOW: fixtureClock.exactRecoveryProbe, TEST_OPERATOR: operatorToken,
      ARCHIVE_KEY: Buffer.from(archiveBytes).toString("hex"), AUTHORITY_KEY: Buffer.from(authorityBytes).toString("hex"), CALLERS: callers };
    runtime = new Miniflare(convertV4MiniflareOptions({ ...options, workers:
      ["target-a", "target-b", "private-status"].map(name => ({ ...workerOptions, name, script: built.outputFiles[0].text,
        d1Databases: { ...shared, DEST: name }, bindings: {
          ...bindings, IDENTITY: name, BINDING: name === "private-status" ? bindingLabels.unsealed : bindingLabels.sealed,
        } })) }));
  }
  async function call(workerName, path, body, token = operatorToken) {
    const worker = await runtime.getWorker(workerName);
    const res = await worker.fetch("https://signatures.test" + path, { method: "POST",
      headers: { authorization: token, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(res.headers.get("cache-control"), "no-store");
    return [res.status, await res.json()];
  }
  const empty = [0, 0, 0, 0, 0, 0];
  await openTargets();
  const targets = ["target-a", "target-b", "private-status"];
  for (const name of targets) {
    const db = await runtime.getD1Database("DEST", name);
    await db.batch(CANDIDATE_DDL.map(sql => db.prepare(sql)));
    const exactHead = name === "private-status" ? [] : [cutoff.digest, authority.digest];
    await initializeGate(db, name, destinationGeneration, "closed", ...exactHead);
  }

  await t.test("only the commissioned D1 destination imports under overlapping claims", async () => {
    const payload = { cutoff, authority };
    const rejected = [409, { code: "restore_authority_required" }];
    // The uncommissioned Worker has its own empty database and a valid local gate for the same signed inputs.
    assert.deepEqual(await Promise.all([call("target-b", "/restore", payload), call("target-a", "/restore", payload)]),
      [rejected, [200, { count: 1 }]]);
    await openTargets();
    assert.deepEqual(await call("target-b", "/restore", payload), rejected);
    assert.deepEqual(await call("target-b", "/inspect", {}), [200, { open: false }]);
    assert.deepEqual(await call("target-a", "/inspect", {}), [200, { open: true }]);
    assert.deepEqual(await call("target-a", "/restore", payload), [200, { count: 1 }]);
    const [winner, loser] = await Promise.all(["target-a", "target-b"].map(name => runtime.getD1Database("DEST", name)));
    assert.deepEqual(await counts(winner), [1, 1, 0, 1, 0, 0]);
    assert.deepEqual(await counts(loser), empty);
    assert.deepEqual(await loser.prepare("SELECT phase, restored_count FROM recovery_gate").first(),
      { phase: "closed", restored_count: null });
  });

  await t.test("private unsealed status exposes only the disposition to its current curator", async () => {
    const control = await runtime.getD1Database("CONTROL", "private-status");
    const archiveDb = await runtime.getD1Database("ARCHIVE", "private-status");
    const destination = await runtime.getD1Database("DEST", "private-status");
    const [owner, other, agentCaller] = callers.map(({ token }) => token);
    const status = (token, operation = pending.operation) => call("private-status", "/status", { operation }, token);
    const result = status => [200, { operation: pending.operation, status }];
    const hidden = [404, { code: "not_found" }];
    const setWitness = digest => bind(control, "UPDATE recovery_unsealed_operation SET pending_envelope_sha = ? WHERE operation = ?",
      digest, pending.operation).run();
    const setRevoked = revoked => bind(control, "UPDATE recovery_unsealed_operation SET revoked = ? WHERE operation = ?",
      revoked, pending.operation).run();

    assert.deepEqual(await status(owner), result("pending"));
    assert.deepEqual(await status(other), hidden);
    assert.deepEqual(await status(agentCaller), hidden);
    assert.deepEqual(await status(operatorToken), hidden);
    assert.deepEqual(await status(owner, crypto.randomUUID()), hidden);
    assert.deepEqual(await status(owner, "invalid"), hidden);
    await setWitness(null);
    assert.deepEqual(await status(owner), result("unknown")); // An envelope on its own does not prove disposition.
    await setWitness(retainedPending.digest);
    await bind(archiveDb, "UPDATE curve_commit_archive SET body = body || ' ' WHERE encounter = ?", pending.encounter).run();
    assert.deepEqual(await status(owner), result("unknown"));
    await bind(archiveDb, "UPDATE curve_commit_archive SET body = ? WHERE encounter = ?", retainedPending.body, pending.encounter).run();
    await bind(archiveDb, "DELETE FROM curve_commit_archive WHERE encounter = ?", pending.encounter).run();
    assert.deepEqual(await status(owner), result("unknown"));
    const archive = candidateArchive(archiveDb);
    await archive.putIfAbsent(bindingLabels.unsealed, pending.encounter, retainedPending);
    assert.deepEqual(await status(owner), result("pending"));
    await setRevoked(1);
    assert.deepEqual(await status(owner), hidden);
    await setRevoked(0);

    const statusInput = { control, identity: "private-status", generation: destinationGeneration,
      custody: { binding: bindingLabels.unsealed, key: archiveKey, archive }, actor: curator, operation: pending.operation };
    const beforeApproval = new Date(Date.parse(pending.approval.approvedAt) - 1).toISOString();
    assert.equal(await privateUnsealedStatus({ ...statusInput, now: () => beforeApproval }), null);
    assert.equal(await privateUnsealedStatus({ ...statusInput, now: () => fixtureClock.expiryProbe }), null);
    const inaccessibleControl = await runtime.getD1Database("DEST", "target-b");
    assert.equal(await privateUnsealedStatus({ ...statusInput, control: inaccessibleControl,
      now: () => fixtureClock.exactRecoveryProbe }), null);
    let time = fixtureClock.exactRecoveryProbe;
    const rewindDuringRead = { ...archive, async read(binding, encounter) {
      const record = await archive.read(binding, encounter);
      time = fixtureClock.laterRevision;
      return record;
    } };
    assert.equal(await privateUnsealedStatus({ ...statusInput, custody: { ...statusInput.custody, archive: rewindDuringRead },
      now: () => time }), null);
    const revokeDuringRead = { ...archive, async read(binding, encounter) {
      const record = await archive.read(binding, encounter);
      await setRevoked(1);
      return record;
    } };
    assert.equal(await privateUnsealedStatus({ ...statusInput, custody: { ...statusInput.custody, archive: revokeDuringRead },
      now: () => fixtureClock.exactRecoveryProbe }), null);
    assert.deepEqual(await status(owner), hidden);

    assert.deepEqual(await call("private-status", "/restore", { cutoff: null, authority: null }),
      [409, { code: "restore_authority_required" }]);
    assert.deepEqual(await call("private-status", "/inspect", {}), [200, { open: false }]);
    const writer = qualifiedWriter(destination, "private-status", destinationGeneration);
    const service = curveCandidates(writer, statusInput.custody, () => fixtureClock.exactRecoveryProbe, 1);
    await assert.rejects(service.start(agent, { handle: "Fenced" }), /gate_assertion/);
    await assert.rejects(candidateStore(writer).publish(pending.encounter, retainedPending.digest, fixtureClock.exactRecoveryProbe), /gate_assertion/);
    assert.deepEqual(await counts(destination), empty);
  });
});
