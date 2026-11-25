import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { ARCHIVE_DDL, candidateArchive } from "../../../.local/candidate-build/candidates/archive.js";
import { sha256 } from "../../../.local/candidate-build/candidates/curve.js";
import { sealRecord, verifyEnvelope } from "../../../.local/candidate-build/candidates/envelope.js";
import { CUTOFF_DOMAIN, RIGHTS_DOMAIN } from "../../../.local/candidate-build/candidates/restore.js";
import { CANDIDATE_DDL } from "../../../.local/candidate-build/candidates/schema.js";
import { curveCandidates } from "../../../.local/candidate-build/candidates/service.js";
import { candidateStore } from "../../../.local/candidate-build/candidates/store.js";
import { FIXTURE_BINDING, fixtureKey, readPinnedFixture } from "../encounter-fixtures.mjs";
import { COMMISSION_DDL, initializeGate, qualifiedWriter, restoreD1Fixture, retireGate } from "./d1-recovery-fixture.mjs";

const dependency = name => process.env.CANDIDATE_TEST_TOOLS
  ? pathToFileURL(resolve(process.env.CANDIDATE_TEST_TOOLS, "node_modules", name, "package.json"))
  : new URL(import.meta.resolve(name + "/package.json"));
const { Miniflare, convertV4MiniflareOptions } = createRequire(dependency("miniflare"))("miniflare");
const { build } = createRequire(dependency("esbuild"))("esbuild");
const fixture = JSON.parse(await readFile(new URL("CROSS-HOST-RESTORE-FIXTURE.json", import.meta.url), "utf8"));
const { bindingLabels, fixtureClock, actorLabels } = fixture;
const curator = { role: "curator", curatorId: actorLabels.curator };
const agent = { ...curator, role: "agent", agentId: actorLabels.agent };
const oldIdentity = "retired-fixture-writer";
const newIdentity = "replacement-fixture";
const oldGeneration = fixture.sourceWriterGeneration;
const newGeneration = fixture.proposedReplacementGeneration;
const isError = code => ({ message: code });
const tables = ["curve_attempts", "curve_outbox", "curve_restrictions", "curve_gallery", "curve_winners", "recovery_guard"];
const row = (db, sql, ...parameters) => db.prepare(sql).bind(...parameters);
const counts = async db => Promise.all(tables.map(async table =>
  (await db.prepare("SELECT count(*) AS count FROM " + table).first()).count));

test("fresh local D1 restore preserves both exact receipts and ordered curator citations", { timeout: 60000 }, async t => {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    script: "export default { fetch() { return new Response(null, { status: 404 }); } };",
    modules: true, host: "127.0.0.1", port: 0, cf: false,
    compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DESTINATION: "fresh", ARCHIVE: "archive", CONTROL: "control" },
    outboundService: () => { throw Error("External I/O is prohibited in this fixture"); },
  }));
  t.after(() => runtime.dispose());
  const [destination, archiveDb, control] = await Promise.all(
    ["DESTINATION", "ARCHIVE", "CONTROL"].map(name => runtime.getD1Database(name)));
  await destination.batch(CANDIDATE_DDL.map(sql => destination.prepare(sql)));
  await archiveDb.prepare(ARCHIVE_DDL).run();
  await control.prepare(COMMISSION_DDL).run();
  const archive = candidateArchive(archiveDb);
  const key = await fixtureKey();
  const binding = FIXTURE_BINDING;
  const custody = { binding, key, archive };
  const fixtures = await Promise.all(["legacy-v1", "current-v2"].map(readPinnedFixture));
  for (const fixture of fixtures) await archive.putIfAbsent(binding, fixture.operation.encounter, fixture.record);
  const cutoffAt = fixtures.map(fixture => JSON.parse(fixture.receiptBytes).acceptedAt).sort().at(-1);
  const cutoff = await sealRecord(key, CUTOFF_DOMAIN, JSON.stringify({
    schema: CUTOFF_DOMAIN, binding, profile: "unminted-study/1", cutoffAt, entries: await archive.inventory(binding),
  }));
  const authority = await sealRecord(key, RIGHTS_DOMAIN, JSON.stringify({
    schema: RIGHTS_DOMAIN, binding, cutoffDigest: cutoff.digest, asOf: cutoffAt, revocations: [],
  }));
  await initializeGate(destination, newIdentity, newGeneration, "closed", cutoff.digest, authority.digest);
  await control.prepare("INSERT INTO recovery_commission VALUES (?, ?, ?, ?, ?, 1, 1)")
    .bind(binding, newIdentity, newGeneration, cutoff.digest, authority.digest).run();
  assert.equal(await restoreD1Fixture({
    control, destination, identity: newIdentity, generation: newGeneration,
    custody, authorityKey: key, cutoff, authority,
  }), fixtures.length);
  for (const fixture of fixtures) {
    const original = JSON.parse(fixture.receiptBytes);
    const service = curveCandidates(qualifiedWriter(destination, newIdentity, newGeneration), custody, () => original.acceptedAt);
    const owner = { role: "curator", curatorId: fixture.row.curator };
    const format = fixture.row.candidate_format ?? 1;
    const submitter = format === 2 ? owner : { ...owner, role: "agent", agentId: fixture.row.agent };
    const encounter = fixture.operation.encounter;
    const restored = await destination.prepare("SELECT receipt_json, candidate_format, posts_json FROM curve_attempts WHERE encounter = ?")
      .bind(encounter).first();
    const posts = fixture.row.posts_json ?? null;
    assert.deepEqual(restored, { receipt_json: fixture.receiptBytes, candidate_format: format, posts_json: posts });
    assert.deepEqual(await service.receipt(owner, encounter), original);
    assert.deepEqual(await service.submit(submitter, fixture.operation), original);
    const review = await service.review(owner, encounter);
    assert.equal(review.svg, fixture.row.final_svg);
    assert.equal(review.intention, fixture.row.intention);
    if (posts) assert.deepEqual(review.posts, JSON.parse(posts));
  }
});

const worker = `
  import { candidateArchive } from "./.local/candidate-build/candidates/archive.js";
  import { curveCandidates } from "./.local/candidate-build/candidates/service.js";
  import { qualifiedWriter, restoredInspectionAllowed, restoreD1Fixture } from "./services/signatures/qualification/d1-recovery-fixture.mjs";

  function key(hex) {
    return crypto.subtle.importKey("raw", Uint8Array.from(hex.match(/../g), byte => Number.parseInt(byte, 16)),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  }

  export default { async fetch(request, env) {
    if (request.method !== "POST" || request.headers.get("authorization") !== env.TEST_TOKEN) {
      return new Response(null, { status: 404 });
    }
    if ("SOURCE" in env) throw Error("source bound to replacement");
    const { binding, cutoff, authority, action, input, time } = await request.json();
    if (!Object.values(env.CASES).includes(binding)) return new Response(null, { status: 404 });
    const destination = binding === env.CASES.sealed ? env.DEST : env.UNSEALED;
    const { identity, generation } = env.REPLACEMENT;
    const custody = { binding, key: await key(env.ARCHIVE_KEY), archive: candidateArchive(env.ARCHIVE) };
    const access = () => restoredInspectionAllowed(env.CONTROL, destination, binding, identity, generation);
    try {
      if (action === "restore") {
        const count = await restoreD1Fixture({ control: env.CONTROL, destination, identity, generation, custody,
          authorityKey: await key(env.AUTHORITY_KEY), cutoff, authority });
        // Simulate a transport that discards the acknowledgement after the import commits.
        if (request.headers.has("x-discard-reply")) return new Response(null, { status: 504 });
        return Response.json({ count });
      }
      if (!await access()) return Response.json({ code: "restore_not_open" }, { status: 409 });
      const service = curveCandidates(qualifiedWriter(destination, identity, generation), custody, () => time, 1);
      let result;
      if (action === "retry") result = await service.submit(env.AGENT, input);
      if (action === "receipt") result = await service.receipt(env.CURATOR, input);
      if (action === "gallery") result = await service.gallery(null, Number.MAX_SAFE_INTEGER, 10);
      if (action === "artwork") result = await service.artwork(input.id, input.digest);
      if (!await access()) return Response.json({ code: "restore_not_open" }, { status: 409 });
      return Response.json(result);
    } catch (error) {
      return Response.json({ code: error.code ?? "storage_error" }, { status: error.status ?? 500 });
    }
  } };
`;

test("fresh local Workerd/D1 recovery from the retained archive", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "sg-d1-recovery-"));
  const keyBytes = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  const archiveBytes = keyBytes();
  const authorityBytes = keyBytes();
  const mac = bytes => crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const [archiveKey, authorityKey] = await Promise.all([mac(archiveBytes), mac(authorityBytes)]);
  const token = crypto.randomUUID();
  const built = await build({
    bundle: true, write: false, format: "esm", target: "es2022", external: ["node:crypto"],
    stdin: { contents: worker, resolveDir: fileURLToPath(new URL("../../../", import.meta.url)) },
  });
  const options = {
    modules: true, host: "127.0.0.1", port: 0, resourcePersistencePath: directory,
    compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"], cf: false,
    outboundService: () => { throw Error("external I/O is prohibited in this fixture"); },
  };
  const names = { SOURCE: "original", ARCHIVE: "retained", CONTROL: "authority" };
  const binding = {
    TEST_TOKEN: token, CASES: bindingLabels, REPLACEMENT: { identity: newIdentity, generation: newGeneration },
    ARCHIVE_KEY: archiveBytes.toString("hex"), AUTHORITY_KEY: authorityBytes.toString("hex"), AGENT: agent, CURATOR: curator,
  };
  let runtime;
  t.after(async () => {
    await runtime?.dispose();
    await rm(directory, { recursive: true });
  });

  async function reopen(replacement) {
    await runtime?.dispose();
    runtime = new Miniflare(convertV4MiniflareOptions({
      ...options, script: replacement ? built.outputFiles[0].text : "export default { fetch() { return new Response(null); } };",
      bindings: replacement ? binding : {},
      d1Databases: replacement
        ? { ARCHIVE: names.ARCHIVE, CONTROL: names.CONTROL, DEST: "fresh-sealed", UNSEALED: "fresh-unsealed" }
        : names,
    }));
    return runtime;
  }
  async function databases(...names) {
    return Promise.all(names.map(name => runtime.getD1Database(name)));
  }
  async function schema(db) {
    await db.batch(CANDIDATE_DDL.map(sql => db.prepare(sql)));
  }
  await reopen(false);
  let [source, archiveDb, control] = await databases("SOURCE", "ARCHIVE", "CONTROL");
  await schema(source);
  await archiveDb.prepare(ARCHIVE_DDL).run();
  await control.prepare(COMMISSION_DDL).run();
  await initializeGate(source, oldIdentity, oldGeneration, "write");
  await initializeGate(archiveDb, oldIdentity, oldGeneration, "write");
  const custody = (db, name) => ({ archive: candidateArchive(db), binding: name, key: archiveKey });
  let time;
  const sourceService = (db, archive, name) => curveCandidates(qualifiedWriter(db, oldIdentity, oldGeneration),
    custody(qualifiedWriter(archive, oldIdentity, oldGeneration), name), () => time, 1);

  async function prepareCandidate(spec, name) {
    const service = sourceService(source, archiveDb, name);
    time = spec.approvalAt;
    const start = await service.start(agent, { handle: spec.handle });
    const draft = await service.propose(agent, { encounter: start.encounter, previousDigest: null,
      edit: spec.edit, intention: spec.intention });
    assert.equal(await sha256(JSON.stringify(start.original.points)), spec.originalGeometrySha256);
    assert.equal(start.original.sha256, spec.originalSvgSha256);
    assert.equal(await sha256(draft.intention), spec.intentionSha256);
    assert.equal(draft.svgSha256, spec.editedSvgSha256);
    const approval = await service.approve(curator, start.encounter, draft.digest);
    assert.equal(approval.writeUntil, fixtureClock.writeUntil);
    assert.equal(approval.recoverUntil, fixtureClock.recoverUntil);
    const input = { encounter: start.encounter, digest: draft.digest, operation: spec.operation };
    time = spec.commitAt;
    return { service, draft, input };
  }
  const [visibleSpec, restrictedSpec, pendingSpec] = fixture.candidates;
  const visible = await prepareCandidate(visibleSpec, bindingLabels.sealed);
  // The original caller lost its acknowledgement. Read the canonical Receipt from custody below.
  await visible.service.submit(agent, visible.input);
  const restricted = await prepareCandidate(restrictedSpec, bindingLabels.sealed);
  await restricted.service.submit(agent, restricted.input);
  const sealedArchive = custody(archiveDb, bindingLabels.sealed);
  const entries = await sealedArchive.archive.inventory(bindingLabels.sealed);
  assert.equal(entries.length, 2);
  const visibleEnvelope = await sealedArchive.archive.read(bindingLabels.sealed, visible.input.encounter);
  const original = await verifyEnvelope(sealedArchive, visibleEnvelope);
  const originalBytes = original.receipt_json;
  const cutoff = await sealRecord(authorityKey, CUTOFF_DOMAIN, JSON.stringify({
    schema: CUTOFF_DOMAIN, profile: fixture.profile, binding: bindingLabels.sealed, cutoffAt: fixtureClock.sealedCutoff, entries,
  }));
  const authorityAt = (asOf, revocations) => sealRecord(authorityKey, RIGHTS_DOMAIN, JSON.stringify({
    schema: RIGHTS_DOMAIN, binding: bindingLabels.sealed, cutoffDigest: cutoff.digest, asOf, revocations,
  }));
  const staleAuthority = await authorityAt(fixtureClock.sealedCutoff, []);
  time = fixtureClock.laterRevision;
  const revocations = [];
  for (const right of fixture.acceptance.sealed.restrictedRights) {
    await restricted.service.revoke(curator, restricted.input.encounter, right);
    revocations.push({ encounter: restricted.input.encounter, right, revokedAt: time });
  }
  const authority = await authorityAt(fixtureClock.laterRevision, revocations);

  const pending = await prepareCandidate(pendingSpec, bindingLabels.unsealed);
  await source.prepare(`CREATE TRIGGER hold_fixture_projection BEFORE UPDATE OF published_at ON curve_outbox
    BEGIN SELECT RAISE(ABORT, 'fixture interrupts projection after archive readback'); END;`).run();
  assert.equal((await pending.service.submit(agent, pending.input)).status, "pending_archive");
  const staged = await row(source, "SELECT envelope_sha FROM curve_attempts WHERE encounter = ?", pending.input.encounter).first();
  const pendingEnvelope = await candidateArchive(archiveDb).read(bindingLabels.unsealed, pending.input.encounter);
  assert.equal(pendingEnvelope.digest, staged.envelope_sha);
  assert.equal(await row(source, "SELECT 1 FROM curve_gallery WHERE candidate_id = ?", pending.input.encounter).first(), null);
  await source.prepare("DROP TRIGGER hold_fixture_projection").run();

  await testRetirement();

  async function testRetirement() {
    assert.equal((await retireGate(source, oldIdentity, oldGeneration)).phase, "retired");
    assert.equal((await retireGate(archiveDb, oldIdentity, oldGeneration)).phase, "retired");
    await reopen(false);
    [source, archiveDb, control] = await databases("SOURCE", "ARCHIVE", "CONTROL");
    const oldStore = candidateStore(qualifiedWriter(source, oldIdentity, oldGeneration));
    const oldArchive = candidateArchive(qualifiedWriter(archiveDb, oldIdentity, oldGeneration));
    const previousCounts = await counts(source);
    const appendId = crypto.randomUUID();
    await assert.rejects(sourceService(source, archiveDb, bindingLabels.unsealed).start(agent, { handle: "Fenced" }), /gate_assertion/);
    await assert.rejects(oldArchive.putIfAbsent(bindingLabels.unsealed, appendId, pendingEnvelope), /gate_assertion/);
    await assert.rejects(oldStore.publish(pending.input.encounter, pendingEnvelope.digest, fixtureClock.exactRecoveryProbe), /gate_assertion/);
    assert.equal(await oldArchive.read(bindingLabels.unsealed, appendId), null);
    assert.equal((await oldStore.exportState(pending.input.encounter)).published_at, null);
    assert.deepEqual(await counts(source), previousCounts);
    t.diagnostic("retired generation denied application write, archive append and delayed projection after reopen");
  }

  await reopen(true);
  const [dest, unsealed, retained, independentControl] = await databases("DEST", "UNSEALED", "ARCHIVE", "CONTROL");
  await Promise.all([schema(dest), schema(unsealed)]);
  await initializeGate(dest, newIdentity, newGeneration, "closed", cutoff.digest, authority.digest);
  await initializeGate(unsealed, newIdentity, newGeneration, "closed");
  const commitAuthority = (name, cutoffSha, authoritySha, sourceRetired, archiveRetired) =>
    row(independentControl, "INSERT OR REPLACE INTO recovery_commission VALUES (?, ?, ?, ?, ?, ?, ?)",
      name, newIdentity, newGeneration, cutoffSha, authoritySha, sourceRetired, archiveRetired).run();
  const empty = [0, 0, 0, 0, 0, 0];
  const request = async (action, input, overrides = {}, headers = {}) => {
    const response = await runtime.dispatchFetch("https://signatures.test/recovery-fixture", {
      method: "POST", headers: { authorization: token, "content-type": "application/json", ...headers },
      body: JSON.stringify({ binding: bindingLabels.sealed, cutoff, authority, time: fixtureClock.exactRecoveryProbe, action, input, ...overrides }),
    });
    const body = await response.text();
    return [response.status, body ? JSON.parse(body) : null];
  };
  const expectError = (status, code) => [status, { code }];
  const closed = expectError(409, "restore_authority_required");
  const sealedHead = (sourceRetired, archiveRetired) =>
    commitAuthority(bindingLabels.sealed, cutoff.digest, authority.digest, sourceRetired, archiveRetired);
  assert.deepEqual(await request("restore"), closed);
  await sealedHead(0, 1);
  assert.deepEqual(await request("restore"), closed);
  await sealedHead(1, 0);
  assert.deepEqual(await request("restore"), closed);
  await sealedHead(1, 1);
  assert.deepEqual(await request("restore", null, { authority: staleAuthority }), closed);
  assert.deepEqual(await request("gallery"), expectError(409, "restore_not_open"));

  await dest.prepare("UPDATE recovery_gate SET generation = generation + 1").run();
  assert.deepEqual(await request("restore"), expectError(500, "storage_error"));
  assert.deepEqual(await counts(dest), empty);
  await dest.prepare("UPDATE recovery_gate SET generation = generation - 1").run();
  // Inject unrelated target state through the privileged test controller.
  const preexistingEncounter = crypto.randomUUID();
  await candidateStore(dest).start({ ...original, encounter: preexistingEncounter,
    work_instance: "urn:signatures:study-work:" + crypto.randomUUID() });
  assert.deepEqual(await request("restore"), expectError(500, "storage_error"));
  assert.deepEqual(await counts(dest), [1, 0, 0, 0, 0, 0]);
  assert.equal((await dest.prepare("SELECT encounter FROM curve_attempts").first()).encounter, preexistingEncounter);
  await row(dest, "DELETE FROM curve_attempts WHERE encounter = ?", preexistingEncounter).run();

  const replacedHead = await sha256("fixture changed current authority");
  const replaceHead = () => row(independentControl, "UPDATE recovery_commission SET authority_sha = ? WHERE binding = ?",
    replacedHead, bindingLabels.sealed).run();
  const archiveDuringValidation = candidateArchive(retained);
  await assert.rejects(restoreD1Fixture({ control: independentControl, destination: dest, identity: newIdentity,
    generation: newGeneration, authorityKey, cutoff, authority, custody: {
      binding: bindingLabels.sealed, key: archiveKey,
      archive: { ...archiveDuringValidation, async read(binding, encounter) {
        const record = await archiveDuringValidation.read(binding, encounter);
        await replaceHead();
        return record;
      } },
    },
  }), isError("restore_scope_changed"));
  assert.deepEqual(await counts(dest), empty);
  await sealedHead(1, 1);

  await row(retained, "DELETE FROM curve_commit_archive WHERE binding = ? AND encounter = ?",
    bindingLabels.sealed, visible.input.encounter).run();
  assert.deepEqual(await request("restore"), expectError(409, "restore_archive_incomplete_or_conflicting"));
  await candidateArchive(retained).putIfAbsent(bindingLabels.sealed, visible.input.encounter, visibleEnvelope);
  const extraId = crypto.randomUUID();
  await candidateArchive(retained).putIfAbsent(bindingLabels.sealed, extraId, visibleEnvelope);
  assert.deepEqual(await request("restore"), expectError(409, "restore_archive_incomplete_or_conflicting"));
  await row(retained, "DELETE FROM curve_commit_archive WHERE binding = ? AND encounter = ?", bindingLabels.sealed, extraId).run();
  await row(retained, "UPDATE curve_commit_archive SET body = body || ' ' WHERE binding = ? AND encounter = ?",
    bindingLabels.sealed, visible.input.encounter).run();
  assert.deepEqual(await request("restore"), expectError(409, "invalid_archive_digest"));
  await row(retained, "UPDATE curve_commit_archive SET body = ? WHERE binding = ? AND encounter = ?",
    visibleEnvelope.body, bindingLabels.sealed, visible.input.encounter).run();
  assert.deepEqual(await counts(dest), empty);

  await dest.prepare(`CREATE TRIGGER reject_rebuild BEFORE INSERT ON curve_gallery
    BEGIN SELECT RAISE(ABORT, 'fixture late projection failure'); END;`).run();
  assert.deepEqual(await request("restore"), expectError(500, "storage_error"));
  assert.deepEqual(await counts(dest), empty);
  assert.equal((await dest.prepare("SELECT phase FROM recovery_gate").first()).phase, "closed");
  await dest.prepare("DROP TRIGGER reject_rebuild").run();
  t.diagnostic("missing/replayed/changed authority, wrong target generation, nonempty target and missing/extra/modified envelopes denied; late D1 batch failure rolled back all effects");

  const lostImportReplies = await Promise.all(Array.from({ length: 2 }, () =>
    request("restore", null, {}, { "x-discard-reply": "1" })));
  assert.deepEqual(lostImportReplies, [[504, null], [504, null]]);
  const restored = await row(dest, "SELECT receipt_json, final_svg, intention FROM curve_attempts WHERE encounter = ?",
    visible.input.encounter).first();
  assert.deepEqual(restored, { receipt_json: originalBytes, final_svg: original.final_svg, intention: original.intention });
  const restoredCounts = [2, 2, 2, 1, 0, 0];
  assert.deepEqual(await counts(dest), restoredCounts);
  await reopen(true);
  const [reopened, reopenedUnsealed, reopenedControl] = await databases("DEST", "UNSEALED", "CONTROL");
  assert.deepEqual(await request("restore"), [200, { count: 2 }]);
  assert.deepEqual(await request("restore", null, { authority: staleAuthority }), closed);
  const [retryStatus, retry] = await request("retry", visible.input);
  assert.equal(retryStatus, 200);
  assert.equal(JSON.stringify(retry), originalBytes);
  assert.deepEqual(await request("receipt", visible.input.encounter), [200, retry]);
  assert.deepEqual(await request("retry", { ...visible.input, operation: crypto.randomUUID() }),
    expectError(409, "attempt_already_accepted"));
  const art = { id: visible.input.encounter, digest: original.final_sha };
  assert.deepEqual(await request("artwork", art), [200, { svg: original.final_svg }]);
  const [listingStatus, listing] = await request("gallery");
  assert.equal(listingStatus, 200);
  assert.deepEqual(listing.map(({ candidate_id, intention, winner }) => [candidate_id, intention, winner]),
    [[visible.input.encounter, original.intention, null]]);
  assert.deepEqual(await request("artwork", { id: restricted.input.encounter, digest: restricted.draft.svgSha256 }), [200, null]);
  assert.deepEqual(await request("receipt", restricted.input.encounter), expectError(403, "recovery_revoked"));
  assert.deepEqual(await request("retry", restricted.input), expectError(403, "recovery_revoked"));
  assert.deepEqual(await request("retry", visible.input, { time: fixtureClock.expiryProbe }), expectError(403, "recovery_expired"));
  assert.deepEqual(await counts(reopened), restoredCounts);
  t.diagnostic(JSON.stringify({
    sealedEntries: entries.length, visible: listing.length, restrictedCandidates: 1, revokedRights: revocations.length,
    exactSvgSha256: await sha256(restored.final_svg), exactIntentionSha256: await sha256(restored.intention),
    originalReceiptSha256: await sha256(originalBytes), archiveBodyBytes: Buffer.byteLength(visibleEnvelope.body),
  }));

  await row(reopenedControl, "UPDATE recovery_commission SET authority_sha = ? WHERE binding = ?", replacedHead, bindingLabels.sealed).run();
  assert.deepEqual(await request("restore"), closed);
  for (const [action, input] of [["gallery", null], ["artwork", art], ["receipt", visible.input.encounter], ["retry", visible.input]]) {
    assert.deepEqual(await request(action, input), expectError(409, "restore_not_open"));
  }

  const unsealedScope = { binding: bindingLabels.unsealed, cutoff: null, authority: null };
  await row(reopenedControl, "INSERT INTO recovery_commission VALUES (?, ?, ?, NULL, NULL, 1, 1)",
    bindingLabels.unsealed, newIdentity, newGeneration).run();
  assert.deepEqual(await request("restore", null, unsealedScope), closed);
  assert.deepEqual(await request("receipt", pending.input.encounter, unsealedScope), expectError(409, "restore_not_open"));
  assert.deepEqual(await request("retry", pending.input, unsealedScope), expectError(409, "restore_not_open"));
  assert.deepEqual(await request("gallery", null, unsealedScope), expectError(409, "restore_not_open"));
  assert.deepEqual(await request("artwork", { id: pending.input.encounter, digest: pending.draft.svgSha256 }, unsealedScope),
    expectError(409, "restore_not_open"));
  const privateService = curveCandidates(qualifiedWriter(reopenedUnsealed, newIdentity, newGeneration),
    custody(await runtime.getD1Database("ARCHIVE"), bindingLabels.unsealed), () => time, 1);
  await assert.rejects(privateService.start(agent, { handle: "Fenced" }), /gate_assertion/);
  await assert.rejects(candidateStore(qualifiedWriter(reopenedUnsealed, newIdentity, newGeneration))
    .publish(pending.input.encounter, pendingEnvelope.digest, fixtureClock.exactRecoveryProbe), /gate_assertion/);
  assert.deepEqual(await counts(reopenedUnsealed), empty);
  t.diagnostic("without a proven cutoff, one archived pending operation remains private and fresh writes and projection are denied");
});
