import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { ARCHIVE_DDL } from "../../.local/candidate-build/candidates/archive.js";
import { CANDIDATE_DDL } from "../../.local/candidate-build/candidates/schema.js";

const dependency = name => process.env.CANDIDATE_TEST_TOOLS
  ? pathToFileURL(resolve(process.env.CANDIDATE_TEST_TOOLS, "node_modules", name, "package.json"))
  : new URL(import.meta.resolve(name + "/package.json"));

const { Miniflare, convertV4MiniflareOptions } = createRequire(dependency("miniflare"))("miniflare");
const { build } = createRequire(dependency("esbuild"))("esbuild");
const root = new URL("../../", import.meta.url);
const origin = "https://signatures.test";
const here = name => new URL(name, root).pathname;
const headers = token => ({ Authorization: token, "Content-Type": "application/json" });

test("local workerd executes signed fixture approval, D1 atomic projection and exact reopen", { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "sg-candidate-workerd-"));
  const name = "synthetic-curves";
  const key = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", key.publicKey);
  const archiveKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  async function signed(role, subject) {
    const payload = Buffer.from(JSON.stringify({ role, subject })).toString("base64url");
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(payload));
    return "Fixture " + payload + "." + Buffer.from(signature).toString("base64url");
  }
  const [agent, curator] = await Promise.all([signed("agent", "synthetic"), signed("curator", "synthetic")]);
  const built = await build({
    bundle: true, write: false, format: "esm", target: "es2022", external: ["node:crypto"],
    stdin: { contents: `
      import { curveCandidates } from "./.local/candidate-build/candidates/service.js";
      import { candidateHttp } from "./.local/candidate-build/candidates/http.js";
      import { candidateArchive } from "./.local/candidate-build/candidates/archive.js";
      let key, archiveKey;
      export default { async fetch(request, env) {
        archiveKey ??= await crypto.subtle.importKey("raw", Uint8Array.from(atob(env.FIXTURE_ARCHIVE_KEY), x => x.charCodeAt(0)),
          { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
        const authenticate = async source => {
          const match = /^Fixture ([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)$/.exec(source.headers.get("Authorization") ?? "");
          if (!match) return null;
          const bytes = value => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), x => x.charCodeAt(0));
          key ??= await crypto.subtle.importKey("jwk", env.FIXTURE_KEY, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
          if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(match[2]), new TextEncoder().encode(match[1]))) return null;
          const a = JSON.parse(new TextDecoder().decode(bytes(match[1])));
          return { role: a.role, curatorId: a.subject, ...(a.role === "agent" ? { agentId: "fixture-agent" } : {}) };
        };
        return candidateHttp({ service: curveCandidates(env.DB, { binding: "urn:signatures:workerd-fixture",
          key: archiveKey, archive: candidateArchive(env.ARCHIVE) }, undefined, env.FIXTURE_FORMAT), origin: ${JSON.stringify(origin)}, authenticate, publicReads: true })(request);
      } };
    `, resolveDir: here(".") },
  });
  let runtime;
  t.after(async () => { await runtime?.dispose(); await rm(directory, { recursive: true }); });
  const options = {
    modules: true, script: built.outputFiles[0].text, host: "127.0.0.1", port: 0,
    compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"],
    cf: false, d1Databases: { DB: name, ARCHIVE: name + "-archive" }, resourcePersistencePath: directory,
    bindings: { FIXTURE_KEY: publicKey, FIXTURE_ARCHIVE_KEY: archiveKey, FIXTURE_FORMAT: 1 },
    outboundService: () => { throw Error("external I/O is prohibited in this fixture"); },
  };
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  const database = await runtime.getD1Database("DB");
  await database.batch(CANDIDATE_DDL.map(sql => database.prepare(sql)));
  const retained = await runtime.getD1Database("ARCHIVE");
  await retained.prepare(ARCHIVE_DDL).run();
  async function dispatch(path, options) {
    return runtime.dispatchFetch(origin + path, options);
  }
  const routeTimes = new Map();
  const record = (route, elapsed) => {
    if (!routeTimes.has(route)) routeTimes.set(route, []);
    routeTimes.get(route).push(elapsed);
  };
  async function call(tool, args, token = agent) {
    const started = performance.now();
    const response = await dispatch("/mcp", { method: "POST", headers: headers(token),
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 1, params: { name: tool, arguments: args } }) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.ok(!result.result.isError, JSON.stringify(result));
    record(tool, performance.now() - started);
    return result.result.structuredContent;
  }
  async function attempt() {
    const start = await call("start_signature", { handle: "939393939393939" });
    assert.equal(start.original.points.length, 31);
    assert.equal(start.original.sha256, "6421beeb2d35cd738b34e20ccade4582b98aad4556a83be452580d22390b68c4");
    const draft = await call("propose_signature", { encounter: start.encounter, previousDigest: null,
      edit: { point: 0, part: "outgoing", dx: 0, dy: 16 }, intention: "X".repeat(1024) });
    assert.equal(draft.svgSha256, "0f3f80c23fbbd7545f5662dae3ca7545d8d0802342b54c16cff660463b7c921a");
    const approveStarted = performance.now();
    const response = await dispatch("/candidate-review/" + start.encounter, { method: "POST",
      headers: { ...headers(curator), Origin: origin }, body: JSON.stringify({ digest: draft.digest }) });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    record("approve", performance.now() - approveStarted);
    return { draft, input: { encounter: start.encounter, digest: draft.digest, operation: crypto.randomUUID() } };
  }

  const first = await attempt();
  await database.prepare(`CREATE TRIGGER fixture_reject_export BEFORE INSERT ON curve_outbox
      BEGIN SELECT RAISE(ABORT, 'fixture export interruption'); END;`).run();
  const blocked = await dispatch("/mcp", { method: "POST", headers: headers(agent),
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 1, params: { name: "submit_signature", arguments: first.input } }) });
  assert.equal(blocked.status, 503);
  assert.equal((await database.prepare("SELECT count(*) AS n FROM curve_gallery").first()).n, 0);
  assert.equal((await database.prepare("SELECT count(*) AS n FROM curve_attempts WHERE receipt_json IS NOT NULL").first()).n, 0);
  await database.prepare("DROP TRIGGER fixture_reject_export").run();
  await retained.prepare(`CREATE TRIGGER fixture_archive_unavailable BEFORE INSERT ON curve_commit_archive
    BEGIN SELECT RAISE(ABORT, 'fixture independent archive unavailable'); END;`).run();
  assert.deepEqual(await call("submit_signature", first.input), {
    status: "pending_archive", encounter: first.input.encounter, operation: first.input.operation,
  });
  assert.equal((await database.prepare("SELECT count(*) AS n FROM curve_gallery").first()).n, 0);
  assert.equal((await database.prepare("SELECT count(*) AS n FROM curve_outbox").first()).n, 1);
  await retained.prepare("DROP TRIGGER fixture_archive_unavailable").run();
  const saved = await call("submit_signature", first.input);
  assert.equal((await retained.prepare("SELECT count(*) AS n FROM curve_commit_archive").first()).n, 1);
  const afterReopen = await attempt();
  await runtime.dispose();
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  const [original, second, secondRetry] = await Promise.all([
    call("submit_signature", first.input), call("submit_signature", afterReopen.input), call("submit_signature", afterReopen.input),
  ]);
  assert.deepEqual(original, saved);
  assert.deepEqual(second, secondRetry);
  assert.equal((await call("signature_receipt", { encounter: first.input.encounter })).draftDigest, first.draft.digest);
  const gallery = await (await dispatch("/candidate-gallery")).json();
  assert.equal(gallery.candidates.length, 2);
  const one = gallery.candidates.find(x => x.id === saved.candidate);
  assert.equal(await (await dispatch(one.artwork)).text(), first.draft.svg);
  const reopened = await runtime.getD1Database("DB");
  const tableSize = async () => (await reopened.prepare("SELECT sequence FROM curve_gallery ORDER BY sequence DESC LIMIT 1").all()).meta.size_after;
  const baselineBytes = await tableSize();
  routeTimes.clear();
  const times = [];
  for (let i = 0; i < 30; i++) {
    const started = performance.now();
    const { input } = await attempt();
    await call("submit_signature", input);
    times.push(performance.now() - started);
  }
  function percentiles(values) {
    values.sort((a, b) => a - b);
    return { p50: values[Math.ceil(values.length * .5) - 1], p95: values[Math.ceil(values.length * .95) - 1] };
  }
  const custodyStats = await (await runtime.getD1Database("ARCHIVE")).prepare("SELECT count(*) AS n FROM curve_commit_archive").all();
  assert.equal(custodyStats.results[0].n, 32);
  const pageStats = await reopened.prepare("SELECT candidate_id FROM curve_gallery WHERE handle_key = ? AND sequence < ? ORDER BY sequence DESC LIMIT 25")
    .bind("939393939393939", Number.MAX_SAFE_INTEGER).all();
  assert.equal(pageStats.results.length, 25);
  // D1 metadata in workerd is a simulation. Wall time includes the DB and the host transport.
  t.diagnostic(JSON.stringify({
    wallMsPerFourRequests: percentiles(times), wallMsByAuthenticatedRoute: Object.fromEntries(
      [...routeTimes].map(([route, samples]) => [route, percentiles(samples)])),
    maxPoints: 31, intentionBytes: 1024, storageIncrementBytesFor30: (await tableSize()) - baselineBytes,
    galleryFixtureMeta: pageStats.meta, retainedEnvelopes: custodyStats.results[0].n,
    archiveFixtureBytes: custodyStats.meta.size_after,
  }));

  await t.test("version 2 runs in Workerd against the same D1 stores and preserves exact retry", async () => {
    await runtime.dispose();
    runtime = new Miniflare(convertV4MiniflareOptions({
      ...options, bindings: { ...options.bindings, FIXTURE_FORMAT: 2 },
    }));
    const start = await call("start_signature", { handle: "D1CitedNorth" });
    const posts = [
      { url: "https://x.com/D1CitedNorth/status/1900000000000000002", author: "D1CitedNorth" },
      { url: "https://x.com/D1CitedNorth/status/1900000000000000001", author: "D1CitedNorth" },
    ];
    const draft = await call("propose_signature", {
      encounter: start.encounter, previousDigest: null, edit: { point: 0, part: "outgoing", dx: 0, dy: 12 },
      intention: "The curve keeps both references in order.", posts,
    });
    const reviewPath = "/candidate-review/" + start.encounter;
    const review = await dispatch(reviewPath, { headers: headers(curator) });
    assert.equal(review.status, 200);
    const reviewHtml = await review.text();
    const citedLinks = [...reviewHtml.matchAll(/href="(https:\/\/x\.com\/[^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(citedLinks, posts.map(post => post.url));
    const galleryPath = "/candidate-gallery?handle=D1CitedNorth";
    assert.deepEqual((await (await dispatch(galleryPath)).json()).candidates, []);
    const submit = () => dispatch(reviewPath, {
      method: "POST", headers: { ...headers(curator), Origin: origin },
      body: JSON.stringify({ action: "submit", digest: draft.digest, operation: draft.operation }),
    });
    const submitted = await submit();
    assert.equal(submitted.status, 200);
    const receiptBytes = await submitted.text();
    assert.equal(JSON.parse(receiptBytes).schema, "signatures-local-candidate-receipt/2");
    assert.equal(await (await submit()).text(), receiptBytes);
    assert.equal(JSON.stringify(await call("signature_receipt", { encounter: start.encounter })), receiptBytes);
    const persisted = await (await runtime.getD1Database("DB")).prepare(
      "SELECT candidate_format, posts_json, receipt_json FROM curve_attempts WHERE encounter = ?").bind(start.encounter).first();
    assert.deepEqual(persisted, { candidate_format: 2, posts_json: JSON.stringify(posts), receipt_json: receiptBytes });
    const newGallery = await (await dispatch(galleryPath)).json();
    assert.equal(newGallery.candidates.length, 1);
    assert.equal(await (await dispatch(newGallery.candidates[0].artwork)).text(), draft.svg);
    assert.deepEqual(await call("signature_receipt", { encounter: first.input.encounter }), saved);
  });
});
