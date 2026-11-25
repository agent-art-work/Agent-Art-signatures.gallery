import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { openArchiveFixture, openCandidateFixture } from "../services/signatures/candidate-fixture-store.mjs";
import { fixtureKey, FIXTURE_KEY_TEXT, FIXTURE_BINDING } from "../services/signatures/encounter-fixtures.mjs";
import { restoreCandidates } from "../.local/candidate-build/candidates/restore.js";
import { curveCandidates } from "../.local/candidate-build/candidates/service.js";
import { SYNTHETIC_CURATOR, SCRIPTED_GROK } from "../.local/candidate-build/candidates/encounterApp.js";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--input")) throw Error("Usage: node scripts/curator-encounter-restore.mjs [--input FIXTURE_DIRECTORY]");
const source = resolve(args[1] ?? ".local/curator-encounter-review");
const packet = JSON.parse(await readFile(join(source, "restore-packet.json"), "utf8"));
const baselines = JSON.parse(await readFile(join(source, "baselines.json"), "utf8"));
assert.equal(packet.synthetic, true); assert.equal(packet.schema, "signatures-synthetic-restore-review/1");
assert.equal(packet.binding, FIXTURE_BINDING); assert.equal(packet.keyText, FIXTURE_KEY_TEXT);
assert.deepEqual(baselines.map(item => item.format), [1, 2]);
const directory = await mkdtemp(join(tmpdir(), "sig-mixed-restore-"));
const target = openCandidateFixture(join(directory, "empty-primary.sqlite"));
const vault = openArchiveFixture(join(directory, "independent-fixture-archive.sqlite"));
try {
  const custody = { binding: packet.binding, key: await fixtureKey(), archive: vault.archive };
  for (const record of packet.records) {
    const envelope = JSON.parse(record.body);
    await custody.archive.putIfAbsent(packet.binding, envelope.encounter, record);
  }
  const count = await restoreCandidates({ ...packet, custody, authorityKey: custody.key,
    hasExclusiveRestoreAuthority: async () => true, importAtomically: target.importAtomically });
  assert.equal(count, 2);
  const service = curveCandidates(target.binding, custody, () => "2026-11-25T00:03:00.000Z");
  const sha = value => createHash("sha256").update(value).digest("hex");
  const checked = [];
  for (const before of baselines) {
    const row = target.sqlite.prepare("SELECT * FROM curve_attempts WHERE encounter = ?").get(before.encounter);
    assert.equal(row.receipt_json, before.receiptBytes);
    assert.equal(row.candidate_format, before.format);
    assert.equal(row.original_svg, before.originalSvg); assert.equal(row.original_points, before.originalGeometry);
    assert.equal(row.final_svg, before.svg); assert.equal(row.intention, before.intention); assert.equal(row.edit_json, before.editJson);
    assert.deepEqual(row.posts_json === null ? null : JSON.parse(row.posts_json), before.posts);
    assert.equal(JSON.stringify(await service.receipt(SYNTHETIC_CURATOR, before.encounter)), before.receiptBytes);
    assert.equal(JSON.stringify(await service.submit(before.format === 1 ? SCRIPTED_GROK : SYNTHETIC_CURATOR, before.operation)), before.receiptBytes);
    const review = await service.review(SYNTHETIC_CURATOR, before.encounter);
    assert.deepEqual(review.posts ?? null, before.posts);
    checked.push({ format: before.format, receiptSha256: sha(row.receipt_json),
      orderedPostsSha256: before.posts === null ? null : sha(JSON.stringify(before.posts)) });
  }
  assert.equal((await service.gallery(null, Number.MAX_SAFE_INTEGER, 24)).length, 2);
  console.log(JSON.stringify({ synthetic: true, restored: count, receiptsByteIdentical: true,
    originalAndFinalSvgIdentical: true, orderedPostsIdentical: true, checked, temporaryStoresRemovedOnExit: true }, null, 2));
} finally { target.close(); vault.close(); await rm(directory, { recursive: true }); }
