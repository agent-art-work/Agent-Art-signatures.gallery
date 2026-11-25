import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openArchiveFixture, openCandidateFixture } from "./candidate-fixture-store.mjs";
import { curveCandidates } from "../../.local/candidate-build/candidates/service.js";
import { candidateHttp } from "../../.local/candidate-build/candidates/http.js";
import { basePoints, sha256 } from "../../.local/candidate-build/candidates/curve.js";
import { openRecord, sealRecord } from "../../.local/candidate-build/candidates/envelope.js";
import { restoreCandidates, CUTOFF_DOMAIN, RIGHTS_DOMAIN } from "../../.local/candidate-build/candidates/restore.js";

const origin = "http://127.0.0.1:39009";
const attendees = {
  "curator-a": { role: "curator", curatorId: "fixture-curator-a" },
  "agent-a": { role: "agent", curatorId: "fixture-curator-a", agentId: "fixture-agent-a" },
  "curator-b": { role: "curator", curatorId: "fixture-curator-b" },
  "agent-b": { role: "agent", curatorId: "fixture-curator-b", agentId: "fixture-agent-b" },
  "other-agent": { role: "agent", curatorId: "fixture-curator-a", agentId: "fixture-other-agent" },
};
const authenticate = async request => Object.hasOwn(attendees, request.headers.get("Authorization"))
  ? attendees[request.headers.get("Authorization")] : null;
const toolHeaders = { "Content-Type": "application/json" };
const defaultEdit = { point: 0, part: "outgoing", dx: 0, dy: 12 };

const signingKey = () => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

async function workbench(t, clock) {
  const directory = await mkdtemp(join(tmpdir(), "sg-curve-fixture-"));
  const vault = await mkdtemp(join(tmpdir(), "sg-curve-archive-"));
  const vaultPath = join(vault, "archive.sqlite");
  let archive = openArchiveFixture(vaultPath);
  const custody = { binding: "urn:signatures:archive-fixture", key: await signingKey(), archive: archive.archive };
  const handles = new Set();
  const dbPath = join(directory, "stage.sqlite");
  t.after(async () => {
    for (const active of handles) active.close();
    archive.close();
    await rm(directory, { recursive: true });
    await rm(vault, { recursive: true });
  });
  async function open(path = dbPath, commissionedCustody = custody) {
    const db = openCandidateFixture(path);
    handles.add(db);
    const service = curveCandidates(db.binding, commissionedCustody, clock, 1);
    return { db, service, handle: candidateHttp({ service, origin, authenticate, publicReads: true }),
      async snapshot(name) {
        const destination = join(directory, name);
        await backup(db.sqlite, destination);
        return destination;
      },
      close() { db.close(); handles.delete(db); } };
  }
  return {
    open, dbPath, directory, vault, custody, get archive() { return archive; },
    reopenArchive() {
      archive.close();
      archive = openArchiveFixture(vaultPath);
      custody.archive = archive.archive;
    },
  };
}

const request = (path, options) => new Request(new URL(path, origin), options);
function rpc(handle, method, params, token = "agent-a", id = 1) {
  return handle(request("/mcp", { method: "POST", headers: { ...toolHeaders, Authorization: token },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }));
}

async function toolResult(handle, name, args, token) {
  const response = await rpc(handle, "tools/call", { name, arguments: args }, token);
  assert.equal(response.status, 200);
  return (await response.json()).result;
}
async function tool(handle, name, args, token) {
  const result = await toolResult(handle, name, args, token);
  assert.ok(!result.isError, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}
function approve(handle, draft, token, source = origin) {
  return handle(request("/candidate-review/" + draft.encounter, {
    method: "POST", headers: { Authorization: token, Origin: source, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ digest: draft.digest }),
  }));
}
const readGallery = async (handle, query = "") => {
  const res = await handle(request("/candidate-gallery" + query));
  assert.equal(res.status, 200);
  return res.json();
};
const counted = (db, name) => db.sqlite.prepare("SELECT count(*) as n FROM " + name).get().n;

async function draftFor(handle, name, credential, intention = "A gentle turn after the first stroke.") {
  const start = await tool(handle, "start_signature", { handle: name }, credential);
  const input = { encounter: start.encounter, previousDigest: null, edit: defaultEdit, intention };
  return { start, input, draft: await tool(handle, "propose_signature", input, credential) };
}

test("MCP, exact signed-in review, atomic failure, lost acknowledgement and restored original receipt", async t => {
  const bench = await workbench(t);
  const active = await bench.open();
  const { db, handle, service } = active;
  const initialized = await rpc(handle, "initialize", {
    protocolVersion: "2025-06-18", clientInfo: { name: "fixture", version: "1" }, capabilities: {},
  });
  assert.equal((await initialized.json()).result.protocolVersion, "2025-06-18");
  const notification = await handle(request("/mcp", { method: "POST", headers: { ...toolHeaders, Authorization: "agent-a" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
  assert.equal(notification.status, 202);
  const list = await rpc(handle, "tools/list", {});
  assert.deepEqual((await list.json()).result.tools.map(x => x.name),
    ["start_signature", "propose_signature", "submit_signature", "signature_receipt"]);
  assert.equal((await rpc(handle, "tools/list", {}, "unknown")).status, 401);
  assert.equal((await rpc(handle, "tools/list", {}, "curator-a")).status, 403);

  const { start, draft: first, input } = await draftFor(handle, "@NorthWindow", "agent-a");
  assert.equal(start.handle, "NorthWindow");
  assert.notEqual(start.work, start.encounter);
  assert.equal(await sha256(start.original.svg), start.original.sha256);
  assert.notEqual(first.svg, start.original.svg);
  assert.deepEqual(await tool(handle, "propose_signature", input), first);
  assert.equal((await toolResult(handle, "propose_signature", input, "other-agent")).content[0].text, "attempt_not_found");
  const final = await tool(handle, "propose_signature", { ...input, previousDigest: first.digest, intention: "<script>turn</script> to the left" });
  assert.equal(final.svg, first.svg);
  assert.notEqual(final.digest, first.digest);
  assert.equal((await approve(handle, first, "curator-a")).status, 409);
  assert.equal((await approve(handle, final, "agent-a")).status, 403);
  assert.equal((await approve(handle, final, "curator-a", "https://other.invalid")).status, 403);
  assert.equal((await approve(handle, final, "curator-b")).status, 404);
  assert.deepEqual((await readGallery(handle)).candidates, []);
  const html = await handle(request(final.reviewUrl, { headers: { Authorization: "curator-a" } }));
  const review = await html.text();
  assert.match(review, /&lt;script&gt;turn&lt;\/script&gt;/);
  assert.ok(!review.includes("<script>"));
  assert.ok(review.includes(final.digest));
  const privateArtUrl = review.match(/src="([^"]+\.svg)"/)[1];
  assert.equal((await handle(request(privateArtUrl))).status, 401);
  const privateArt = await handle(request(privateArtUrl, { headers: { Authorization: "curator-a" } }));
  assert.equal(await privateArt.text(), final.svg);
  const operation = { encounter: final.encounter, digest: final.digest, operation: crypto.randomUUID() };
  assert.equal((await toolResult(handle, "submit_signature", operation)).content[0].text, "exact_approval_required");
  const approved = await approve(handle, final, "curator-a");
  assert.equal(approved.status, 200);
  assert.deepEqual(await (await approve(handle, final, "curator-a")).json(), await approved.json());
  assert.equal((await toolResult(handle, "propose_signature", { ...input, previousDigest: final.digest })).content[0].text, "draft_changed_or_locked");

  db.sqlite.exec(`CREATE TRIGGER fixture_break_outbox BEFORE INSERT ON curve_outbox
    BEGIN SELECT RAISE(ABORT, 'fixture interruption before commit'); END;`);
  assert.equal((await rpc(handle, "tools/call", { name: "submit_signature", arguments: operation })).status, 503);
  assert.equal(counted(db, "curve_gallery"), 0);
  assert.equal(counted(db, "curve_outbox"), 0);
  await assert.rejects(service.receipt(attendees["agent-a"], final.encounter), /receipt_not_found/);
  db.sqlite.exec("DROP TRIGGER fixture_break_outbox");

  let dropped = false;
  const unreliable = {
    prepare(sql) {
      const statement = db.binding.prepare(sql);
      return { bind(...values) {
        const bound = statement.bind(...values);
        return { ...bound, async first() {
          const row = await bound.first();
          if (!dropped && sql.includes("SET operation_id = ?, receipt_json")) {
            dropped = true;
            assert.ok(row.receipt_json);
            throw Error("simulated acknowledgement loss");
          }
          return row;
        } };
      } };
    },
  };
  const interrupted = candidateHttp({ service: curveCandidates(unreliable, bench.custody, undefined, 1), origin, authenticate, publicReads: true });
  assert.equal((await rpc(interrupted, "tools/call", { name: "submit_signature", arguments: operation })).status, 503);
  assert.equal(dropped, true);
  const exactStoredReceipt = db.sqlite.prepare("SELECT receipt_json FROM curve_attempts").get().receipt_json;
  assert.equal(counted(db, "curve_gallery"), 0);
  assert.equal(counted(db, "curve_outbox"), 1);
  const saved = await active.snapshot("backup.sqlite");
  active.close();

  const restored = await bench.open(saved);
  const retry = await tool(restored.handle, "submit_signature", operation);
  assert.equal(JSON.stringify(retry), exactStoredReceipt);
  assert.deepEqual(await tool(restored.handle, "signature_receipt", { encounter: final.encounter }), retry);
  assert.equal((await toolResult(restored.handle, "submit_signature", { ...operation, operation: crypto.randomUUID() })).content[0].text, "attempt_already_accepted");
  assert.equal((await toolResult(restored.handle, "signature_receipt", { encounter: final.encounter }, "agent-b")).content[0].text, "attempt_not_found");
  const gallery = await readGallery(restored.handle, "?handle=@NORTHWINDOW");
  assert.equal(gallery.candidates.length, 1);
  const candidate = gallery.candidates[0];
  assert.equal(candidate.mintStatus, "unminted");
  assert.equal(candidate.intention, final.intention);
  assert.equal(candidate.svgSha256, final.svgSha256);
  assert.ok(!JSON.stringify(gallery).includes("fixture-curator-a"));
  const artwork = await restored.handle(request(candidate.artwork));
  assert.equal(await artwork.text(), final.svg);
  assert.match(artwork.headers.get("cache-control"), /must-revalidate/);
  assert.equal((await restored.handle(request(candidate.artwork, { headers: { "If-None-Match": artwork.headers.get("etag") } }))).status, 304);
  assert.equal((await restored.handle(request(candidate.artwork.replace(final.svgSha256, "0".repeat(64))))).status, 404);
  const gated = candidateHttp({ service: restored.service, origin, authenticate });
  assert.equal((await gated(request("/candidate-gallery"))).status, 404);
  assert.equal((await gated(request(candidate.artwork))).status, 404);
});

test("two independent candidates can persist concurrently, one final winner and future candidates stay visible", async t => {
  const bench = await workbench(t);
  const a = await bench.open();
  const b = await bench.open();
  const inputs = await Promise.all([
    draftFor(a.handle, "PaperHarbor", "agent-a"),
    draftFor(b.handle, "@paperharbor", "agent-b", "A small inflection after the first beat."),
  ]);
  assert.notEqual(inputs[0].draft.work, inputs[1].draft.work);
  assert.notEqual(inputs[0].draft.encounter, inputs[1].draft.encounter);
  for (const [index, item] of inputs.entries()) {
    assert.equal((await approve(a.handle, item.draft, index === 0 ? "curator-a" : "curator-b")).status, 200);
  }
  const operations = inputs.map(({ draft }) => ({ encounter: draft.encounter, digest: draft.digest, operation: crypto.randomUUID() }));
  const [first, retry, second] = await Promise.all([
    tool(a.handle, "submit_signature", operations[0], "agent-a"),
    tool(b.handle, "submit_signature", operations[0], "agent-a"),
    tool(b.handle, "submit_signature", operations[1], "agent-b"),
  ]);
  assert.deepEqual(first, retry);
  assert.notEqual(first.candidate, second.candidate);
  assert.equal(counted(a.db, "curve_gallery"), 2);
  const before = await readGallery(a.handle, "?handle=PaperHarbor");
  assert.deepEqual(before.candidates.map(x => x.mintStatus), ["unminted", "unminted"]);
  const observe = (receipt, i, state = "finalized") => ({
    state, candidateId: receipt.candidate, draftDigest: receipt.draftDigest, tokenId: String(i), transactionHash: "0x" + String(i).repeat(64), block: "42",
  });
  assert.equal(await a.service.observeMint(observe(second, 1, "pending")), "ignored");
  assert.equal(await a.service.observeMint(observe(second, 1, "reorged")), "ignored");
  assert.equal(counted(a.db, "curve_winners"), 0);
  await assert.rejects(a.service.observeMint({ ...observe(first, 2), draftDigest: "0".repeat(64) }), /candidate_commitment_not_found/);

  const outcomes = await Promise.allSettled([a.service.observeMint(observe(first, 2)), b.service.observeMint(observe(second, 3))]);
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
  assert.match(outcomes.find(item => item.status === "rejected").reason.message, /finality_conflict/);
  assert.equal(counted(a.db, "curve_winners"), 1);
  const firstWon = outcomes[0].status === "fulfilled";
  const winner = firstWon ? first : second;
  assert.equal(await b.service.observeMint(observe(winner, firstWon ? 2 : 3)), "canonical");

  const future = await draftFor(a.handle, "@PAPERHARBOR", "agent-a");
  assert.equal((await approve(a.handle, future.draft, "curator-a")).status, 200);
  await tool(a.handle, "submit_signature", { encounter: future.draft.encounter, digest: future.draft.digest, operation: crypto.randomUUID() });
  const gallery = await readGallery(a.handle, "?handle=paperharbor");
  assert.equal(gallery.candidates.length, 3);
  assert.deepEqual(gallery.candidates.filter(item => item.mintStatus === "canonical").map(item => item.id), [winner.candidate]);
  assert.equal(gallery.candidates.filter(item => item.mintStatus === "ineligible").length, 2);
  for (const item of gallery.candidates) assert.equal(await sha256(await (await a.handle(request(item.artwork))).text()), item.svgSha256);
});

test("validates study limits and refuses a pre-existing unrelated database", async t => {
  const bench = await workbench(t);
  const unrelated = join(bench.directory, "unrelated.sqlite");
  const marker = new DatabaseSync(unrelated);
  marker.exec("CREATE TABLE prior_owner (data TEXT); INSERT INTO prior_owner VALUES ('preserved');");
  marker.close();
  assert.throws(() => openCandidateFixture(unrelated), /separate curve study database/);
  const inspect = new DatabaseSync(unrelated, { readOnly: true });
  assert.equal(inspect.prepare("SELECT data FROM prior_owner").get().data, "preserved");
  inspect.close();
  const { handle } = await bench.open();
  assert.equal((await toolResult(handle, "start_signature", { handle: "Artist\n" })).content[0].text, "invalid_handle");
  const maxHandle = "939393939393939";
  const { start, input } = await draftFor(handle, maxHandle, "agent-a");
  assert.equal(basePoints(maxHandle).length, 31);
  assert.equal((await toolResult(handle, "propose_signature", { ...input, edit: { ...defaultEdit, dy: 17 } })).content[0].text, "invalid_edit");
  assert.equal((await toolResult(handle, "propose_signature", { ...input, edit: { ...defaultEdit, part: "incoming" } })).content[0].text, "unused_coordinate");
  assert.equal((await toolResult(handle, "propose_signature", { ...input, edit: { ...defaultEdit, d: "<svg/>" } })).content[0].text, "invalid_proposal");
  assert.equal((await toolResult(handle, "propose_signature", { ...input, intention: "雪".repeat(342) })).content[0].text, "invalid_intention");
  const wrongPoint = { point: start.original.points.length, part: "outgoing", dx: 0, dy: 1 };
  assert.equal((await toolResult(handle, "propose_signature", { ...input, edit: wrongPoint })).content[0].text, "unused_coordinate");
  assert.equal((await handle(request("/candidate-gallery?handle=A&handle=B"))).status, 400);
  assert.equal((await rpc(handle, "tools/call", { name: "propose_signature", arguments: { ...input, intention: "a".repeat(9000) } })).status, 413);
  assert.ok((await stat(bench.dbPath)).size > 0);
});

test("approval and revision serialize against the same draft", async t => {
  const bench = await workbench(t);
  const a = await bench.open();
  const b = await bench.open();
  const { draft, input } = await draftFor(a.handle, "RaceFixture", "agent-a");
  const [approval, proposed] = await Promise.all([
    approve(a.handle, draft, "curator-a"),
    toolResult(b.handle, "propose_signature", { ...input, previousDigest: draft.digest, intention: "New exact version" }),
  ]);
  if (approval.status === 200) {
    assert.equal(proposed.content[0].text, "draft_changed_or_locked");
    assert.equal((await b.service.review(attendees["curator-a"], draft.encounter)).digest, draft.digest);
  } else {
    assert.equal(approval.status, 409);
    assert.ok(!proposed.isError);
    assert.equal((await b.service.review(attendees["curator-a"], draft.encounter)).approved, false);
  }
});

function operationFor(draft) {
  return { encounter: draft.encounter, digest: draft.digest, operation: crypto.randomUUID() };
}

test("fresh write expires, exact recovery survives write expiry, and each revocation is enforced", async t => {
  let now = "2026-11-21T00:00:00.000Z";
  const bench = await workbench(t, () => now);
  const { db, service, handle } = await bench.open();
  const a = attendees["agent-a"], c = attendees["curator-a"];
  const [first, late, revoked] = await Promise.all([
    draftFor(handle, "Deadline", "agent-a"),
    draftFor(handle, "Late", "agent-a"),
    draftFor(handle, "Revoked", "agent-a"),
  ]);
  const grants = await Promise.all([first, late, revoked].map(({ draft }) => service.approve(c, draft.encounter, draft.digest)));
  assert.deepEqual(grants.map(item => [item.writeUntil, item.recoverUntil]),
    Array(3).fill(["2026-11-21T00:15:00.000Z", "2026-11-22T00:00:00.000Z"]));
  await assert.rejects(service.revoke(a, revoked.draft.encounter, "write"), /role_not_permitted/);
  await assert.rejects(service.revoke(attendees["curator-b"], revoked.draft.encounter, "write"), /attempt_not_found/);
  await service.revoke(c, revoked.draft.encounter, "write");
  await assert.rejects(service.submit(a, operationFor(revoked.draft)), /write_authority_changed/);
  assert.equal(counted(db, "curve_outbox"), 0);

  const firstOp = operationFor(first.draft), receipt = await service.submit(a, firstOp);
  const lateOp = operationFor(late.draft);
  now = grants[0].writeUntil;
  await assert.rejects(service.submit(a, lateOp), /write_expired/);
  assert.deepEqual(await service.submit(a, firstOp), receipt);
  assert.deepEqual(await service.receipt(c, first.draft.encounter), receipt);
  await assert.rejects(service.submit(a, { ...firstOp, digest: "0".repeat(64) }), /attempt_already_accepted/);
  await service.revoke(c, first.draft.encounter, "recovery");
  await assert.rejects(service.receipt(a, first.draft.encounter), /recovery_revoked/);
  await assert.rejects(service.submit(a, firstOp), /recovery_revoked/);
  await assert.rejects(service.review(c, first.draft.encounter), /recovery_revoked/);
  await assert.rejects(service.propose(a, first.input), /attempt_already_committed/);
  await assert.rejects(service.approve(c, first.draft.encounter, first.draft.digest), /attempt_already_committed/);
  assert.equal((await readGallery(handle)).candidates.length, 1);

  now = grants[0].recoverUntil;
  await assert.rejects(service.receipt(a, first.draft.encounter), /recovery_expired/);
  await assert.rejects(service.review(a, first.draft.encounter), /recovery_expired/);
  const terminalReplay = await toolResult(handle, "propose_signature", first.input, "agent-a");
  assert.deepEqual(terminalReplay, { isError: true, content: [{ type: "text", text: "attempt_already_committed" }] });
  now = "2026-12-21T00:00:00.000Z";
  await assert.rejects(service.submit(a, lateOp), /write_expired/);
  assert.equal(counted(db, "curve_outbox"), 1);
});

test("commit, archive verification and visibility survive distinct interruption points", async t => {
  let now = "2026-11-21T00:00:00.000Z";
  const bench = await workbench(t, () => now);
  let offline = true;
  let writes = 0;
  const archive = {
    ...bench.custody.archive,
    async putIfAbsent(...args) {
      writes++;
      if (offline) throw Error("fixture archive unavailable");
      return bench.custody.archive.putIfAbsent(...args);
    },
  };
  const { db, service, handle } = await bench.open(bench.dbPath, { ...bench.custody, archive });
  const { draft } = await draftFor(handle, "CutPoints", "agent-a");
  const a = attendees["agent-a"], c = attendees["curator-a"];
  const { writeUntil } = await service.approve(c, draft.encounter, draft.digest);
  const input = operationFor(draft);
  const pending = { status: "pending_archive", encounter: input.encounter, operation: input.operation };
  assert.deepEqual(await tool(handle, "submit_signature", input), pending);
  assert.deepEqual(await service.receipt(a, input.encounter), pending);
  assert.equal(writes, 1, "status must not repair or write to the archive");
  assert.equal(counted(db, "curve_outbox"), 1);
  assert.equal(counted(db, "curve_gallery"), 0);
  assert.equal(await archive.read(bench.custody.binding, input.encounter), null);

  offline = false;
  db.sqlite.exec(`CREATE TRIGGER fixture_break_projection BEFORE INSERT ON curve_gallery
    BEGIN SELECT RAISE(ABORT, 'fixture interruption before projection'); END;`);
  assert.deepEqual(await tool(handle, "submit_signature", input), pending);
  assert.equal(counted(db, "curve_gallery"), 0);
  assert.equal(db.sqlite.prepare("SELECT published_at FROM curve_outbox").get().published_at, null);
  const stored = await archive.read(bench.custody.binding, input.encounter);
  assert.equal((await openRecord(bench.custody.key, "signatures-commit-envelope/1", stored)).operation, input.operation);
  assert.equal((await readGallery(handle)).candidates.length, 0);

  db.sqlite.exec("DROP TRIGGER fixture_break_projection");
  now = writeUntil;
  const interruptedReply = await rpc(handle, "tools/call", { name: "submit_signature", arguments: input });
  assert.equal(interruptedReply.status, 200);
  await interruptedReply.body.cancel(); // Disconnect after projection and before consuming the acceptance body.
  assert.equal((await readGallery(handle)).candidates.length, 1);
  const receipt = await tool(handle, "submit_signature", input);
  assert.equal(JSON.stringify(receipt), JSON.parse(stored.body).receipt);
  assert.equal(counted(db, "curve_gallery"), 1);
  assert.equal(counted(db, "curve_outbox"), 1);
  assert.equal((await archive.inventory(bench.custody.binding)).length, 1);
  assert.deepEqual(await archive.read(bench.custody.binding, input.encounter), stored);
  assert.equal(writes, 3, "an already visible receipt does not attempt any further archive writes");
});

test("an untrusted or conflicting immutable envelope stays quarantined and invisible", async t => {
  const bench = await workbench(t);
  const { db, service, handle } = await bench.open();
  const { draft } = await draftFor(handle, "Conflict", "agent-a");
  const input = operationFor(draft);
  const forged = await sealRecord(await signingKey(), "signatures-commit-envelope/1", JSON.stringify({ encounter: draft.encounter }));
  await bench.custody.archive.putIfAbsent(bench.custody.binding, draft.encounter, forged);
  await service.approve(attendees["curator-a"], draft.encounter, draft.digest);
  await assert.rejects(service.submit(attendees["agent-a"], input), /archive_conflict/);
  await assert.rejects(service.receipt(attendees["agent-a"], draft.encounter), /archive_conflict/);
  await assert.rejects(service.submit(attendees["agent-a"], input), /archive_conflict/);
  assert.equal(db.sqlite.prepare("SELECT quarantined FROM curve_outbox").get().quarantined, 1);
  assert.deepEqual({ ...await bench.custody.archive.read(bench.custody.binding, draft.encounter) }, forged);
  assert.equal((await readGallery(handle)).candidates.length, 0);
});

test("primary-file loss restores exact unminted outcomes under a commissioned cutoff and current rights", async t => {
  let now = "2026-11-21T00:00:00.000Z";
  const bench = await workbench(t, () => now);
  const primary = await bench.open();
  const a = attendees["agent-a"], c = attendees["curator-a"];
  const first = await draftFor(primary.handle, "@RestoreMe", "agent-a", "Keep the unminted bend.");
  const second = await draftFor(primary.handle, "@restoreme", "agent-a", "An alternative, initially disclosed.");
  const initial = [];
  for (const { draft } of [first, second]) {
    await primary.service.approve(c, draft.encounter, draft.digest);
    const op = operationFor(draft);
    initial.push({ draft, op, receipt: await primary.service.submit(a, op) });
  }
  const original = (await readGallery(primary.handle)).candidates;
  assert.equal(original.length, 2);
  const latestGalleryIds = original.map(item => item.id);
  const authorityKey = await signingKey();
  const entries = primary.db.sqlite.prepare(`SELECT candidate_id AS encounter, envelope_sha AS digest FROM curve_outbox
    WHERE published_at IS NOT NULL ORDER BY candidate_id`).all();
  const cutoff = await sealRecord(authorityKey, CUTOFF_DOMAIN, JSON.stringify({
    schema: CUTOFF_DOMAIN, profile: "unminted-study/1", cutoffAt: now, binding: bench.custody.binding, entries,
  }));
  const previousAuthority = await sealRecord(authorityKey, RIGHTS_DOMAIN, JSON.stringify({
    schema: RIGHTS_DOMAIN, asOf: now, binding: bench.custody.binding, cutoffDigest: cutoff.digest, revocations: [],
  }));
  now = "2026-11-21T00:16:00.000Z";
  await primary.service.revoke(c, second.draft.encounter, "recovery");
  await primary.service.revoke(c, second.draft.encounter, "disclosure");
  const revocations = primary.db.sqlite.prepare(`SELECT encounter, right_name AS right, revoked_at AS revokedAt
    FROM curve_restrictions ORDER BY encounter, right_name`).all();
  const latest = await sealRecord(authorityKey, RIGHTS_DOMAIN, JSON.stringify({
    schema: RIGHTS_DOMAIN, asOf: now, binding: bench.custody.binding, cutoffDigest: cutoff.digest, revocations,
  }));
  const witness = join(bench.vault, "commissioned-witness.json");
  await writeFile(witness, JSON.stringify({
    cutoff, authority: latest, expectedCutoffDigest: cutoff.digest, latestAuthorityDigest: latest.digest,
  }), { flag: "wx", mode: 0o600 });
  primary.close();
  await rm(bench.dbPath);
  await assert.rejects(stat(bench.dbPath), { code: "ENOENT" });
  bench.reopenArchive();

  const target = await bench.open(join(bench.directory, "isolated-target.sqlite"));
  let fenced = false;
  const options = {
    custody: bench.custody, authorityKey, ...JSON.parse(await readFile(witness, "utf8")),
    hasExclusiveRestoreAuthority: async () => fenced,
    importAtomically: target.db.importAtomically,
  };
  await assert.rejects(restoreCandidates(options), /restore_authority_required/);
  fenced = true;
  await assert.rejects(restoreCandidates({ ...options, authority: previousAuthority }), /restore_authority_required/);
  const archive = bench.archive.sqlite, row = archive.prepare(`SELECT * FROM curve_commit_archive WHERE encounter = ?`).get(initial[0].op.encounter);
  archive.prepare("UPDATE curve_commit_archive SET body = ? WHERE encounter = ?").run(row.body + " ", row.encounter);
  await assert.rejects(restoreCandidates(options), /invalid_archive_digest/);
  assert.equal(counted(target.db, "curve_attempts"), 0);
  archive.prepare("UPDATE curve_commit_archive SET body = ? WHERE encounter = ?").run(row.body, row.encounter);

  const changed = JSON.parse(row.body);
  changed.act.intention = "A cryptographically untrusted change.";
  const bogus = await sealRecord(await signingKey(), "signatures-commit-envelope/1", JSON.stringify(changed));
  await assert.rejects(openRecord(bench.custody.key, "signatures-commit-envelope/1", bogus), /untrusted_archive_record/);
  const retagged = await sealRecord(bench.custody.key, "signatures-commit-envelope/1", JSON.stringify(changed));
  const badCutoff = await sealRecord(authorityKey, CUTOFF_DOMAIN, JSON.stringify({
    schema: CUTOFF_DOMAIN, profile: "unminted-study/1", cutoffAt: "2026-11-21T00:00:00.000Z", binding: bench.custody.binding,
    entries: entries.map(entry => entry.encounter === row.encounter ? { ...entry, digest: retagged.digest } : entry),
  }));
  const badRights = await sealRecord(authorityKey, RIGHTS_DOMAIN, JSON.stringify({
    schema: RIGHTS_DOMAIN, asOf: now, binding: bench.custody.binding, cutoffDigest: badCutoff.digest, revocations,
  }));
  const update = archive.prepare("UPDATE curve_commit_archive SET body = ?, digest = ?, proof = ? WHERE encounter = ?");
  update.run(retagged.body, retagged.digest, retagged.proof, row.encounter);
  await assert.rejects(restoreCandidates({ ...options, cutoff: badCutoff, authority: badRights,
    expectedCutoffDigest: badCutoff.digest, latestAuthorityDigest: badRights.digest }), /invalid_commit_envelope/);
  assert.equal(counted(target.db, "curve_attempts"), 0);
  update.run(row.body, row.digest, row.proof, row.encounter);

  archive.prepare("DELETE FROM curve_commit_archive WHERE encounter = ?").run(row.encounter);
  await assert.rejects(restoreCandidates(options), /restore_archive_incomplete_or_conflicting/);
  assert.equal(counted(target.db, "curve_attempts"), 0);
  assert.equal((await readGallery(target.handle)).candidates.length, 0);
  await bench.custody.archive.putIfAbsent(row.binding, row.encounter, row);
  assert.equal(await restoreCandidates(options), 2);
  const [restoredA, restoredB] = initial;
  assert.deepEqual(await target.service.submit(a, restoredA.op), restoredA.receipt);
  assert.deepEqual(await target.service.receipt(c, restoredA.op.encounter), restoredA.receipt);
  assert.equal(target.db.sqlite.prepare("SELECT write_until FROM curve_attempts WHERE encounter = ?").get(restoredA.op.encounter).write_until,
    "2026-11-21T00:15:00.000Z");
  await assert.rejects(target.service.submit(attendees["agent-b"], restoredA.op), /attempt_not_found/);
  await assert.rejects(target.service.receipt(a, restoredB.op.encounter), /recovery_revoked/);

  const visible = (await readGallery(target.handle)).candidates;
  assert.deepEqual(visible, original.filter(item => item.id === first.draft.encounter));
  assert.equal(await (await target.handle(request(visible[0].artwork))).text(), first.draft.svg);
  assert.equal((await target.handle(request(original.find(item => item.id === second.draft.encounter).artwork))).status, 404);
  assert.equal(counted(target.db, "curve_gallery"), latestGalleryIds.length);
  assert.equal(counted(target.db, "curve_winners"), 0);
  assert.equal(counted(target.db, "curve_outbox"), 2);
  await assert.rejects(restoreCandidates(options), /not empty/);
  now = "2026-11-22T00:00:00.000Z";
  await assert.rejects(target.service.receipt(a, restoredA.op.encounter), /recovery_expired/);
});

test("revocation that arrives during archive I/O wins before visibility", async t => {
  const bench = await workbench(t);
  let enterArchive, releaseArchive;
  const inArchive = new Promise(resolve => { enterArchive = resolve; });
  const released = new Promise(resolve => { releaseArchive = resolve; });
  const archive = {
    ...bench.custody.archive,
    async putIfAbsent(...args) {
      await bench.custody.archive.putIfAbsent(...args);
      enterArchive();
      await released;
    },
  };
  const { service, handle, db } = await bench.open(bench.dbPath, { ...bench.custody, archive });
  const { draft } = await draftFor(handle, "InFlight", "agent-a");
  const a = attendees["agent-a"], c = attendees["curator-a"];
  await service.approve(c, draft.encounter, draft.digest);
  const operation = operationFor(draft);
  const outcome = service.submit(a, operation);
  const denied = assert.rejects(outcome, /recovery_revoked/);
  try {
    await Promise.race([inArchive, outcome]);
    await service.revoke(c, draft.encounter, "recovery");
  } finally {
    releaseArchive();
  }
  await denied;
  assert.equal(counted(db, "curve_gallery"), 0);
  assert.equal(counted(db, "curve_outbox"), 1);
  assert.equal((await archive.inventory(bench.custody.binding)).length, 1);
});

test("a proposal replay racing a terminal commit cannot return the pre-commit draft", async t => {
  let now = "2026-11-21T00:00:00.000Z";
  const clock = () => now;
  const bench = await workbench(t, clock);
  const { service, handle, db } = await bench.open();
  const { draft, input } = await draftFor(handle, "ReplayRace", "agent-a");
  const a = attendees["agent-a"], c = attendees["curator-a"];
  const grant = await service.approve(c, draft.encounter, draft.digest);
  let captured, release;
  const seen = new Promise(resolve => { captured = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  let firstRead = true;
  const delayed = {
    prepare(sql) {
      const statement = db.binding.prepare(sql);
      return { bind(...values) {
        const bound = statement.bind(...values);
        return { ...bound, async first() {
          const saved = await bound.first();
          if (firstRead && sql.startsWith("SELECT * FROM curve_attempts")) {
            firstRead = false;
            captured();
            await resume;
          }
          return saved;
        } };
      } };
    },
  };
  const staleReplay = curveCandidates(delayed, bench.custody, clock, 1).propose(a, input);
  const denied = assert.rejects(staleReplay, /attempt_already_committed/);
  try {
    await Promise.race([seen, staleReplay]);
    await service.submit(a, operationFor(draft));
    now = grant.recoverUntil;
  } finally {
    release();
  }
  await denied;
});
