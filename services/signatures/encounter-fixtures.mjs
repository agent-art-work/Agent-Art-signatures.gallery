import { readFile } from "node:fs/promises";
import { openArchiveFixture, openCandidateFixture } from "./candidate-fixture-store.mjs";
import { curveCandidates } from "../../.local/candidate-build/candidates/service.js";
import { sealRecord, verifyEnvelope } from "../../.local/candidate-build/candidates/envelope.js";
import { CUTOFF_DOMAIN, RIGHTS_DOMAIN } from "../../.local/candidate-build/candidates/restore.js";
import { SCRIPTED_GROK, SYNTHETIC_CURATOR, scriptedProposal } from "../../.local/candidate-build/candidates/encounterApp.js";

export const FIXTURE_KEY_TEXT = "synthetic-curator-encounter-fixture-key-only";
export const FIXTURE_BINDING = "urn:signatures:synthetic-curator-fixtures";
export const fixtureKey = () => crypto.subtle.importKey("raw", new TextEncoder().encode(FIXTURE_KEY_TEXT),
  { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
export const readPinnedFixture = async name => JSON.parse(await readFile(new URL(`../../tests/fixtures/candidates/${name}.json`, import.meta.url), "utf8"));

export async function makeReviewPacket() {
  const db = openCandidateFixture(":memory:"), archive = openArchiveFixture(":memory:");
  try {
    const custody = { binding: FIXTURE_BINDING, key: await fixtureKey(), archive: archive.archive };
    const legacy = await readPinnedFixture("legacy-v1");
    await custody.archive.putIfAbsent(custody.binding, legacy.row.encounter, legacy.record);
    db.importAtomically([await verifyEnvelope(custody, legacy.record)], [], "2026-11-25T00:00:00.000Z");
    const service = curveCandidates(db.binding, custody, () => "2026-11-25T00:01:00.000Z");
    const start = await service.start(SCRIPTED_GROK, { handle: "NorthWindow" });
    const input = scriptedProposal(start);
    const draft = await service.propose(SCRIPTED_GROK, input);
    const operation = { encounter: start.encounter, digest: draft.digest, operation: start.encounter };
    await service.submit(SYNTHETIC_CURATOR, operation);
    const row = { ...db.sqlite.prepare("SELECT * FROM curve_attempts WHERE encounter = ?").get(start.encounter) };
    const record = await custody.archive.read(custody.binding, start.encounter);
    const current = { synthetic: true, keyText: FIXTURE_KEY_TEXT, binding: FIXTURE_BINDING, operation, row, record, receiptBytes: row.receipt_json };
    const entries = await custody.archive.inventory(custody.binding);
    const cutoff = await sealRecord(custody.key, CUTOFF_DOMAIN, JSON.stringify({
      schema: CUTOFF_DOMAIN, binding: custody.binding, profile: "unminted-study/1", cutoffAt: "2026-11-25T00:02:00.000Z", entries,
    }));
    const authority = await sealRecord(custody.key, RIGHTS_DOMAIN, JSON.stringify({
      schema: RIGHTS_DOMAIN, binding: custody.binding, cutoffDigest: cutoff.digest, asOf: "2026-11-25T00:02:00.000Z", revocations: [],
    }));
    // Capture from the source store BEFORE any restore, separately from the packet.
    const baselines = [legacy, current].map(item => ({
      format: item.row.candidate_format ?? 1, encounter: item.row.encounter, operation: item.operation,
      receiptBytes: item.receiptBytes, originalSvg: item.row.original_svg, originalGeometry: item.row.original_points,
      svg: item.row.final_svg, intention: item.row.intention, editJson: item.row.edit_json,
      posts: item.row.posts_json === undefined || item.row.posts_json === null ? null : JSON.parse(item.row.posts_json),
    }));
    return { current, baselines, packet: {
      schema: "signatures-synthetic-restore-review/1", synthetic: true, binding: custody.binding,
      keyText: FIXTURE_KEY_TEXT, records: [legacy.record, current.record], cutoff, authority,
      expectedCutoffDigest: cutoff.digest, latestAuthorityDigest: authority.digest,
    } };
  } finally { db.close(); archive.close(); }
}
