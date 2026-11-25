import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openArchiveFixture, openCandidateFixture } from "./candidate-fixture-store.mjs";
import { fixtureKey, FIXTURE_BINDING, makeReviewPacket, readPinnedFixture } from "./encounter-fixtures.mjs";
import { curveCandidates } from "../../.local/candidate-build/candidates/service.js";
import { candidateHttp } from "../../.local/candidate-build/candidates/http.js";
import { sealRecord, verifyEnvelope } from "../../.local/candidate-build/candidates/envelope.js";
import { restoreCandidates } from "../../.local/candidate-build/candidates/restore.js";
import { SCRIPTED_GROK as agent, SYNTHETIC_CURATOR as curator, scriptedProposal, syntheticEncounterApp } from "../../.local/candidate-build/candidates/encounterApp.js";

const origin = "http://127.0.0.1:39019";
const count = (db, table = "curve_gallery") => db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const operationFor = draft => ({ encounter: draft.encounter, digest: draft.digest, operation: draft.encounter });
const req = (path, options) => new Request(new URL(path, origin), options);
const post = body => ({ method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function bench(t) {
  const directory = await mkdtemp(join(tmpdir(), "sig-curator-test-"));
  const archive = openArchiveFixture(join(directory, "archive.sqlite"));
  const custody = { binding: FIXTURE_BINDING, key: await fixtureKey(), archive: archive.archive };
  let now = "2026-11-25T00:01:00.000Z", db;
  const open = () => {
    db = openCandidateFixture(join(directory, "primary.sqlite"));
    const service = curveCandidates(db.binding, custody, () => now);
    return { db, service, app: syntheticEncounterApp(service, origin) };
  };
  const initial = open();
  t.after(async () => { db.close(); archive.close(); await rm(directory, { recursive: true }); });
  return { ...initial, custody, archive, directory, setTime: value => { now = value; }, restart() { db.close(); return open(); } };
}
async function proposal(service, handle = "NorthWindow") {
  const start = await service.start(agent, { handle });
  const input = scriptedProposal(start);
  const draft = await service.propose(agent, input);
  return { start, input, draft };
}
async function rpc(app, name, args) {
  const res = await app(req("/mcp", { method: "POST", headers: { Authorization: "synthetic-agent", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: name === "tools/list" ? name : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } }) }));
  return (await res.json()).result;
}

test("handle selection through immutable review, explicit curator submission and exact gallery readback", async t => {
  const { db, app, service } = await bench(t);
  assert.match(await (await app(req("/"))).text(), /X handle/);
  const selected = await app(req("/encounter-start", { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: "handle=%40NorthWindow" }));
  assert.equal(selected.status, 303);
  const reviewUrl = selected.headers.get("Location"), encounter = reviewUrl.split("/").at(-1);
  const draft = await service.review(curator, encounter);
  const html = await (await app(req(reviewUrl))).text();
  assert.match(html, /Posts Grok cited/);
  assert.ok(html.includes(draft.original.sha256) && html.includes(draft.svgSha256) && html.includes(draft.digest));
  assert.ok(draft.posts.every(post => html.includes(post.url)));
  assert.ok(!/<textarea|contenteditable|<input(?![^>]*type="hidden")/i.test(html), "curator cannot edit any part of the proposal");
  assert.equal(await (await app(req(`${reviewUrl}/original/${draft.original.sha256}.svg`))).text(), draft.original.svg);
  assert.equal(await (await app(req(`${reviewUrl}/art/${draft.svgSha256}.svg`))).text(), draft.svg);
  assert.equal(count(db), 0, "reading and silence never submit");
  const submitted = await app(req(reviewUrl, post({ action: "submit", digest: draft.digest, operation: encounter })));
  assert.equal(submitted.status, 200);
  const receipt = await submitted.json();
  assert.equal(receipt.schema, "signatures-local-candidate-receipt/2");
  assert.equal(count(db), 1);
  const row = db.sqlite.prepare("SELECT * FROM curve_attempts").get();
  assert.equal(row.receipt_json, JSON.stringify(receipt));
  assert.equal(row.posts_json, JSON.stringify(draft.posts));
  const gallery = await (await app(req("/candidate-gallery?handle=NORTHWINDOW"))).json();
  assert.equal(gallery.candidates.length, 1);
  const saved = gallery.candidates[0];
  assert.equal(saved.intention, draft.intention);
  assert.equal(saved.svgSha256, draft.svgSha256);
  assert.equal(await (await app(req(saved.artwork))).text(), draft.svg);
  assert.ok(!JSON.stringify(gallery).includes(curator.curatorId));
  assert.ok(!JSON.stringify(gallery).includes(draft.posts[0].url), "research sources remain in private proposal, pending disclosure policy");
  assert.match(await (await app(req("/gallery"))).text(), /NorthWindow/);
});

test("Grok gets a one-handle start and cannot approve or submit the new proposal", async t => {
  const { service, app, db } = await bench(t);
  const { tools } = await rpc(app, "tools/list");
  assert.deepEqual(tools.map(tool => tool.name), ["start_signature", "propose_signature", "signature_receipt"]);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties), ["handle"]);
  assert.ok(tools[1].inputSchema.required.includes("posts"));
  const { draft, input } = await proposal(service);
  assert.equal((await rpc(app, "submit_signature", operationFor(draft))).isError, true);
  await assert.rejects(service.submit(agent, operationFor(draft)), /role_not_permitted/);
  await assert.rejects(service.approve(curator, draft.encounter, draft.digest), /explicit_submission_required/);
  await assert.rejects(service.propose(curator, input), /role_not_permitted/);
  await assert.rejects(service.start(agent, { handle: "NorthWindow", posts: input.posts }), /invalid_start/);
  await assert.rejects(service.review({ ...curator, curatorId: "other" }, draft.encounter), /attempt_not_found/);
  assert.equal(count(db, "curve_outbox"), 0);
});

test("citation and edit substitution fail; exact proposal replay is stable", async t => {
  const { service, db } = await bench(t);
  const { input, draft } = await proposal(service);
  assert.deepEqual(await service.propose(agent, input), draft);
  for (const substituted of [
    { ...input, posts: [...input.posts].reverse() },
    { ...input, posts: [{ ...input.posts[0], url: input.posts[0].url.replace(/1$/, "3") }] },
    { ...input, edit: { ...input.edit, dy: 1 } },
    { ...input, intention: input.intention + " Changed." },
    { ...input, previousDigest: draft.digest },
  ]) await assert.rejects(service.propose(agent, substituted), /proposal_is_fixed/);
  await assert.rejects(service.submit(curator, { ...operationFor(draft), digest: "0".repeat(64) }), /exact_approval_required/);
  await assert.rejects(service.submit(curator, { ...operationFor(draft), posts: input.posts }), /invalid_submission/);
  assert.equal(count(db, "curve_outbox"), 0);
  assert.deepEqual(await service.review(curator, draft.encounter), draft);
});

test("absent public posts, another author, profile links and malformed citations cannot complete an encounter", async t => {
  const { service, db, app } = await bench(t);
  const start = await service.start(agent, { handle: "NorthWindow" });
  const input = scriptedProposal(start);
  for (const posts of [undefined, [], [{ url: "https://x.com/Other/status/123", author: "Other" }],
    [{ url: "https://x.com/NorthWindow", author: "NorthWindow" }],
    [{ url: "https://x.com/NorthWindow/status/123?ref=secret", author: "NorthWindow" }],
    [{ url: "https://x.com/NorthWindow/status/123", author: "Other" }],
    [input.posts[0], input.posts[0]], [{ ...input.posts[0], excerpt: "Injected field" }]]) {
    await assert.rejects(service.propose(agent, { ...input, posts }), /no_qualifying_public_post|invalid_cited_post/);
  }
  await assert.rejects(service.review(curator, start.encounter), /draft_not_found/);
  const incomplete = await app(req("/encounter-start", { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: "handle=NoPublicPosts" }));
  const page = await (await app(req(incomplete.headers.get("Location")))).text();
  assert.match(page, /Encounter incomplete/);
  assert.ok(!page.includes("Submit this exact proposal"));
  assert.equal(count(db, "curve_outbox"), 0);
});

test("silence, save locally, decline and their page reads create no receipt, archive or gallery entry", async t => {
  const { service, db, app, custody } = await bench(t);
  const silent = await proposal(service), saved = await proposal(service), declined = await proposal(service);
  for (const [draft, action] of [[saved.draft, "save"], [declined.draft, "decline"]]) {
    const response = await app(req(`/candidate-review/${draft.encounter}`, post({ action, digest: draft.digest, operation: draft.encounter })));
    assert.equal(response.status, 303);
    assert.equal((await app(req(response.headers.get("Location")))).status, 200);
  }
  assert.equal((await service.review(curator, saved.draft.encounter)).localState, "saved");
  assert.equal((await service.review(curator, silent.draft.encounter)).localState, "open");
  await assert.rejects(service.submit(curator, operationFor(declined.draft)), /encounter_declined/);
  assert.equal(count(db), 0); assert.equal(count(db, "curve_outbox"), 0);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM curve_attempts WHERE receipt_json IS NOT NULL OR approved_at IS NOT NULL").get().n, 0);
  assert.deepEqual(await custody.archive.inventory(custody.binding), []);
  // Saving does not authorize a future submit; a separate explicit action does.
  await service.submit(curator, operationFor(saved.draft));
  assert.equal(count(db), 1);
  assert.ok(!(await (await app(req(`/candidate-review/${saved.draft.encounter}`))).text()).includes("Saved locally. No gallery entry"));
});

test("do it again retires the local proposal and starts a fresh Work/Encounter from the original curve", async t => {
  const { service, app, db } = await bench(t);
  const { start, draft } = await proposal(service);
  const again = await app(req(`/encounter-again/${draft.encounter}`, { method: "POST", headers: { Origin: origin } }));
  assert.equal(again.status, 303);
  const id = again.headers.get("Location").split("/").at(-1), fresh = await service.review(curator, id);
  assert.notEqual(id, start.encounter); assert.notEqual(fresh.work, start.work);
  assert.deepEqual(fresh.original, draft.original);
  assert.deepEqual(fresh.originalPoints, start.original.points);
  assert.notEqual(fresh.digest, draft.digest);
  await assert.rejects(service.submit(curator, operationFor(draft)), /encounter_declined/);
  assert.equal(count(db), 0);
  await service.submit(curator, operationFor(fresh));
  const afterSubmit = await app(req(`/encounter-again/${id}`, { method: "POST", headers: { Origin: origin } }));
  assert.equal(afterSubmit.status, 303); assert.equal(count(db), 1, "fresh attempts do not mutate or duplicate prior submissions");
});

test("HTTP submission binds origin, exact fields, digest and stable operation", async t => {
  const { service, db } = await bench(t), { draft } = await proposal(service);
  const http = candidateHttp({ service, origin, publicReads: true, authenticate: async request => request.headers.get("Authorization") === "curator" ? curator : agent });
  const body = { action: "submit", digest: draft.digest, operation: draft.encounter };
  const headers = { ...post(body).headers, Authorization: "curator" };
  for (const options of [
    { ...post(body), headers: { ...headers, Origin: "https://other.invalid" } },
    { ...post(body), headers: { ...headers, "Sec-Fetch-Site": "cross-site" } },
    { ...post(body), headers: { ...headers, Authorization: "agent" } },
    { ...post({ ...body, edit: draft.edit }), headers },
    { ...post({ ...body, operation: crypto.randomUUID() }), headers },
  ]) assert.ok((await http(req(`/candidate-review/${draft.encounter}`, options))).status >= 400);
  assert.equal(count(db), 0);
  const result = await http(req(`/candidate-review/${draft.encounter}`, { ...post(body), headers }));
  assert.equal(result.status, 200); assert.equal(count(db), 1);
});

test("archive outage, restart and exact retry recover original v2 receipt without replacing citations", async t => {
  const b = await bench(t), { draft } = await proposal(b.service), op = operationFor(draft);
  const backing = b.custody.archive; let writes = 0, offline = true;
  b.custody.archive = { ...backing, async putIfAbsent(...args) { writes++; if (offline) throw Error("fixture outage"); return backing.putIfAbsent(...args); } };
  assert.equal((await b.service.submit(curator, op)).status, "pending_archive");
  const before = { ...b.db.sqlite.prepare("SELECT receipt_json, posts_json, final_svg FROM curve_attempts").get() };
  assert.equal(count(b.db), 0);
  const reopened = b.restart();
  assert.equal((await reopened.service.receipt(curator, draft.encounter)).status, "pending_archive");
  assert.equal(writes, 1, "receipt reads never repair archive");
  offline = false;
  b.setTime("2026-11-25T00:20:00.000Z");
  const receipt = await reopened.service.submit(curator, op);
  assert.equal(JSON.stringify(receipt), before.receipt_json);
  assert.deepEqual(await reopened.service.submit(curator, op), receipt);
  assert.equal(writes, 2); assert.equal(count(reopened.db), 1);
  assert.equal(reopened.db.sqlite.prepare("SELECT posts_json FROM curve_attempts").get().posts_json, before.posts_json);
  await assert.rejects(reopened.service.submit(curator, { ...op, operation: crypto.randomUUID() }), /exact_operation_required/);
});

test("lost response after commit retries the same operation and receipt once", async t => {
  const b = await bench(t), { draft } = await proposal(b.service), op = operationFor(draft);
  let lost = false;
  const unreliable = { prepare(sql) {
    const statement = b.db.binding.prepare(sql);
    return { bind(...args) {
      const bound = statement.bind(...args);
      return { ...bound, async first() {
        const row = await bound.first();
        if (!lost && sql.includes("SET operation_id = ?, receipt_json")) { lost = true; throw Error("lost acknowledgement"); }
        return row;
      } };
    } };
  } };
  await assert.rejects(curveCandidates(unreliable, b.custody, () => "2026-11-25T00:01:00.000Z").submit(curator, op), /lost acknowledgement/);
  const receiptBytes = b.db.sqlite.prepare("SELECT receipt_json FROM curve_attempts").get().receipt_json;
  const restarted = b.restart();
  assert.equal(JSON.stringify(await restarted.service.submit(curator, op)), receiptBytes);
  assert.equal(count(restarted.db), 1); assert.equal(count(restarted.db, "curve_outbox"), 1);
});

test("concurrent explicit retries converge on one immutable receipt", async t => {
  const b = await bench(t), { draft } = await proposal(b.service), op = operationFor(draft);
  const other = openCandidateFixture(join(b.directory, "primary.sqlite"));
  t.after(() => other.close());
  const second = curveCandidates(other.binding, b.custody, () => "2026-11-25T00:01:00.000Z");
  const receipts = await Promise.all([b.service.submit(curator, op), second.submit(curator, op), b.service.submit(curator, op)]);
  assert.deepEqual(receipts[0], receipts[1]); assert.deepEqual(receipts[1], receipts[2]);
  assert.equal(count(b.db), 1); assert.equal(count(b.db, "curve_outbox"), 1);
});

test("stored edit or citation substitution cannot produce a commit under an existing digest", async t => {
  const { service, db } = await bench(t);
  for (const field of ["posts_json", "edit_json"]) {
    const { draft } = await proposal(service);
    const replacement = field === "posts_json" ? JSON.stringify([{ ...draft.posts[0], url: draft.posts[0].url.replace(/1$/, "3") }]) : JSON.stringify({ ...draft.edit, dy: 1 });
    db.sqlite.prepare(`UPDATE curve_attempts SET ${field} = ? WHERE encounter = ?`).run(replacement, draft.encounter);
    await assert.rejects(service.submit(curator, operationFor(draft)), /invalid_commit_envelope/);
  }
  assert.equal(count(db), 0); assert.equal(count(db, "curve_outbox"), 0);
});

test("mixed signed legacy/current archive restores exact pre-restore receipt bytes, SVG and ordered links", async t => {
  const { packet, baselines } = await makeReviewPacket();
  const b = await bench(t);
  for (const record of packet.records) {
    const row = await verifyEnvelope(b.custody, record);
    await b.custody.archive.putIfAbsent(packet.binding, row.encounter, record);
  }
  const options = { ...packet, custody: b.custody, authorityKey: b.custody.key,
    hasExclusiveRestoreAuthority: async () => true, importAtomically: b.db.importAtomically };
  assert.equal(await restoreCandidates(options), 2);
  assert.equal(count(b.db), 2);
  for (const baseline of baselines) {
    const row = b.db.sqlite.prepare("SELECT * FROM curve_attempts WHERE encounter = ?").get(baseline.encounter);
    assert.equal(row.receipt_json, baseline.receiptBytes, "literal original receipt bytes");
    assert.equal(row.candidate_format, baseline.format);
    assert.equal(row.original_svg, baseline.originalSvg); assert.equal(row.original_points, baseline.originalGeometry);
    assert.equal(row.final_svg, baseline.svg); assert.equal(row.intention, baseline.intention); assert.equal(row.edit_json, baseline.editJson);
    assert.deepEqual(row.posts_json && JSON.parse(row.posts_json), baseline.posts);
    assert.equal(JSON.stringify(await b.service.receipt(curator, baseline.encounter)), baseline.receiptBytes);
    assert.equal((await rpc(b.app, "signature_receipt", { encounter: baseline.encounter })).content[0].text, baseline.receiptBytes);
    const submittingActor = baseline.format === 1 ? agent : curator;
    assert.equal(JSON.stringify(await b.service.submit(submittingActor, baseline.operation)), baseline.receiptBytes);
    const review = await b.service.review(curator, baseline.encounter);
    if (baseline.format === 1) {
      assert.equal(row.posts_json, null); assert.equal(review.posts, undefined); assert.equal(review.format, undefined);
      assert.equal((await rpc(b.app, "submit_signature", baseline.operation)).content[0].text, baseline.receiptBytes,
        "known legacy MCP retries stay supported on the successor profile");
    } else assert.deepEqual(review.posts, baseline.posts);
  }
  assert.equal(count(b.db), 2);
});

test("pinned pre-refactor legacy and current envelopes verify; changed and unknown formats fail closed", async t => {
  const b = await bench(t);
  for (const name of ["legacy-v1", "current-v2"]) {
    const fixture = await readPinnedFixture(name);
    assert.equal((await verifyEnvelope(b.custody, fixture.record)).receipt_json, fixture.receiptBytes);
    const raw = JSON.parse(fixture.record.body);
    if (name === "current-v2") raw.act.posts.reverse(); else raw.act.intention += " Substitution.";
    const retagged = await sealRecord(b.custody.key, name === "current-v2" ? "signatures-commit-envelope/2" : "signatures-commit-envelope/1", JSON.stringify(raw));
    await assert.rejects(verifyEnvelope(b.custody, retagged), /invalid_commit_envelope/);
    raw.schema = "signatures-private-commit/999";
    const unknown = await sealRecord(b.custody.key, "signatures-commit-envelope/999", JSON.stringify(raw));
    await assert.rejects(verifyEnvelope(b.custody, unknown), /invalid_commit_envelope/);
  }
});

test("legacy SQLite schema upgrades additively without rewriting saved candidates or receipts", async t => {
  const b = await bench(t), fixture = await readPinnedFixture("legacy-v1"), path = join(b.directory, "legacy.sqlite");
  const old = new DatabaseSync(path);
  old.exec(await readFile(new URL("../../tests/fixtures/candidates/legacy-schema.sql", import.meta.url), "utf8"));
  old.exec("PRAGMA application_id = 0x53474331; PRAGMA user_version = 2;");
  const row = fixture.row, columns = Object.keys(row).filter(key => !["receipt_json", "operation_id", "accepted_at", "envelope_json", "envelope_sha"].includes(key));
  old.prepare(`INSERT INTO curve_attempts (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(key => row[key]));
  old.prepare("UPDATE curve_attempts SET operation_id = ?, receipt_json = ?, accepted_at = ?, envelope_json = ?, envelope_sha = ?").run(row.operation_id, row.receipt_json, row.accepted_at, row.envelope_json, row.envelope_sha);
  old.prepare("UPDATE curve_outbox SET published_at = ?").run(row.accepted_at);
  old.close();
  const upgraded = openCandidateFixture(path); t.after(() => upgraded.close());
  const saved = upgraded.sqlite.prepare("SELECT * FROM curve_attempts").get();
  assert.equal(upgraded.sqlite.prepare("PRAGMA user_version").get().user_version, 3);
  assert.equal(saved.candidate_format, 1); assert.equal(saved.posts_json, null);
  for (const [key, value] of Object.entries(row)) assert.equal(saved[key], value);
  assert.equal(count(upgraded), 1);
  const service = curveCandidates(upgraded.binding, b.custody, () => "2026-11-25T00:03:00.000Z");
  assert.equal(JSON.stringify(await service.receipt(curator, row.encounter)), row.receipt_json);
  assert.equal((await service.review(curator, row.encounter)).posts, undefined);
});

test("an existing legacy draft keeps its review and submission contract on the successor HTTP profile", async t => {
  const b = await bench(t), legacy = curveCandidates(b.db.binding, b.custody, () => "2026-11-25T00:01:00.000Z", 1);
  const start = await legacy.start(agent, { handle: "LegacyDraft" });
  const draft = await legacy.propose(agent, { encounter: start.encounter, previousDigest: null,
    edit: { point: 0, part: "outgoing", dx: 0, dy: 12 }, intention: "Keep this legacy draft intact." });
  const page = await (await b.app(req(`/candidate-review/${draft.encounter}`))).text();
  assert.match(page, /Approve this exact version/);
  assert.ok(!page.includes("Posts Grok cited"));
  const approval = await b.app(req(`/candidate-review/${draft.encounter}`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ digest: draft.digest }) }));
  assert.equal(approval.status, 200); assert.equal(count(b.db), 0);
  const result = await rpc(b.app, "submit_signature", { encounter: draft.encounter, digest: draft.digest, operation: crypto.randomUUID() });
  assert.equal(result.structuredContent.schema, "signatures-local-candidate-receipt/1"); assert.equal(count(b.db), 1);
});
