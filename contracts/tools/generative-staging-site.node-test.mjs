import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import { Client } from "pg";
import { stagingSiteFixture } from "./fixtures/generative-staging-site.mjs";
import { disposablePostgres } from "../../src/openMint/persistence/fixtures/postgres.ts";
import { createStagingSite } from "./generative-staging-site.mjs";

describe("future-staging site/projection: disposable PG and synthetic chain, no paid calls or broadcasting", { skip: process.env.OPEN_MINT_TEST_POSTGRES !== "1" }, () => {
  let cluster, admin, f, site;
  before(async () => { cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); });
  after(async () => { await admin?.end(); cluster?.stop(); });
  beforeEach(async () => { f = await stagingSiteFixture(cluster, admin); });
  afterEach(async () => { f.faults.afterQuery = undefined; await site?.close(); site = undefined; await f?.close(); });
  async function start() {
    site = await createStagingSite(f.input, f.deps); assert.equal(site.server.listening, false);
    assert.equal(f.calls.length, 0); assert.deepEqual(f.counts, { x: 0, grok: 0, sign: 0 });
    await new Promise(r => site.server.listen(0, "127.0.0.1", r));
  }
  async function http(path, body, headers = {}, method = body === undefined ? "GET" : "POST") {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest({ host: "127.0.0.1", port: site.server.address().port, path, method,
        headers: { host: "staging.signatures.gallery", "x-forwarded-proto": "https", cookie: f.sessions.cookie(f.session), origin: f.settings.origin, "x-csrf-token": f.session.csrf,
          ...(bytes === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(bytes) }), ...headers } }, res => {
        const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const bytes = Buffer.concat(chunks), text = bytes.toString();
          resolve({ status: res.statusCode, headers: res.headers, text, bytes, body: res.headers["content-type"]?.includes("application/json") && text ? JSON.parse(text) : undefined }); });
      }); req.on("error", reject); req.end(bytes);
    });
  }
  async function prepare() {
    const created = await http("/api/assessments", { handle: "Alice" }); assert.equal(created.status, 202, created.text); await site.idle();
    const code = created.body.code, plan = await http("/api/mints/begin", { code, consent: true }); assert.equal(plan.status, 200, plan.text);
    return { code, ...plan.body };
  }
  const sync = async () => assert.equal(await site.sync(), "observed");
  async function until(read, description, timeout = 22000) {
    const end = performance.now() + timeout;
    while (performance.now() < end) { if (await read()) return; await new Promise(r => setTimeout(r, 50)); }
    assert.fail(`Timed out: ${description}; ${JSON.stringify(site.snapshot())}`);
  }
  test("owned startup is inert until called, observes before listening, and close cancels the observer", async () => {
    site = await createStagingSite(f.input, f.deps);
    assert.deepEqual(site.snapshot(), { phase: "idle", observer: { state: "idle", failures: 0 } });
    for (const port of [-1, 65536, NaN, 1.5, "3000"]) await assert.rejects(site.start(port), /Invalid/);
    assert.equal(f.calls.length, 0); assert.equal(site.server.listening, false);
    const parent = new AbortController(); await site.start(0, parent.signal);
    assert.equal(site.snapshot().phase, "running"); assert.equal(site.server.address().address, "127.0.0.1");
    assert.equal(site.snapshot().observer.state, "waiting");
    assert.equal((await http("/api/gallery")).status, 200);
    await assert.rejects(site.start(0), /single-use/); await assert.rejects(site.sync(), /owned/);
    assert.equal((await http("/api/projection/sync", {})).status, 404);
    parent.abort(); await site.close();
    assert.equal(site.snapshot().phase, "closed"); assert.equal(site.snapshot().observer.state, "stopped");
    assert.equal(site.server.listening, false); assert.deepEqual(await site.reads.lookup("alice"), { state: "unknown" });
    const count = f.calls.length; await new Promise(r => setTimeout(r, 5100)); assert.equal(f.calls.length, count);
    assert.deepEqual(f.counts, { x: 0, grok: 0, sign: 0 }); f.writer.assertHealthy();
  });
  test("scheduled observation survives transient RPC failure, reveals/finalizes, then closes admission on a finality contradiction", async () => {
    site = await createStagingSite(f.input, f.deps); await site.start(0);
    const r = await prepare(); f.include(r.transaction);
    f.controls.mutation = (v, method, params, source) => method === "eth_chainId" && source === 1 ? "0x1" : v;
    await until(() => site.snapshot().observer.state === "backing-off", "transient backoff");
    assert.equal((await http("/api/gallery")).status, 503);
    f.controls.mutation = undefined;
    await until(async () => (await site.reads.lookup("alice")).state === "confirming", "automatic canonical observation");
    assert.equal((await http(`/api/mints/status/${r.code}`)).body.state, "confirming");
    f.finalize(); await until(async () => (await site.reads.lookup("alice")).state === "confirmed", "automatic finalized observation");
    assert.equal((await http("/api/gallery")).body.items.length, 1);
    f.reorg(); await until(() => site.snapshot().phase === "failed", "terminal observer halts admission");
    assert.equal(site.snapshot().observer.state, "safety-halted"); assert.equal(site.server.listening, false);
    assert.deepEqual(await site.reads.lookup("alice"), { state: "unknown" });
    assert.deepEqual(f.counts, { x: 1, grok: 1, sign: 1 }); f.writer.assertHealthy();
  });
  test("background certification can overlap an HTTP assessment without BUSY or repeating an effect", async () => {
    await start();
    let release, enter; const entered = new Promise(r => { enter = r; });
    f.faults.afterQuery = async () => { f.faults.afterQuery = undefined; enter(); await new Promise(r => { release = r; }); };
    const observation = site.sync(); await entered;
    const request = http("/api/assessments", { handle: "Alice" });
    await new Promise(r => setTimeout(r, 75)); release();
    assert.equal((await request).status, 202); assert.equal(await observation, "observed"); await site.idle();
    assert.deepEqual(f.counts, { x: 1, grok: 1, sign: 0 });
    assert.equal((await f.db.query("SELECT count(*)::int n FROM open_mint.requests")).rows[0].n, 1);
  });
  test("startup cancellation during observation never opens a late listener", async () => {
    site = await createStagingSite(f.input, f.deps);
    let release, enter, blocked = false; const entered = new Promise(r => { enter = r; }), parent = new AbortController();
    f.controls.mutation = async v => { if (!blocked) { blocked = true; enter(); await new Promise(r => { release = r; }); } return v; };
    const starting = site.start(0, parent.signal); await entered; parent.abort(); release();
    await assert.rejects(starting, /could not start/); await site.close();
    assert.equal(site.server.listening, false); assert.equal(site.snapshot().observer.state, "stopped");
    assert.deepEqual(f.counts, { x: 0, grok: 0, sign: 0 }); f.writer.assertHealthy();
  });
  test("startup rechecks authority and refuses unavailable sources before listening", async () => {
    site = await createStagingSite(f.input, f.deps); f.review.withdraw();
    await assert.rejects(site.start(0), /could not start/); assert.equal(site.server.listening, false);
    assert.equal(site.snapshot().phase, "failed"); assert.equal(f.calls.length, 0);
    assert.deepEqual(f.counts, { x: 0, grok: 0, sign: 0 }); f.writer.assertHealthy();
  });
  test("already-cancelled or production startup cannot open an already-prepared site", async () => {
    site = await createStagingSite(f.input, f.deps);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(site.start(0, cancelled.signal), /could not start/);
    assert.equal(site.server.listening, false); assert.equal(f.calls.length, 0);
    await site.close(); site = await createStagingSite(f.input, f.deps);
    const previous = process.env.NODE_ENV; process.env.NODE_ENV = "production";
    try { await assert.rejects(site.start(0), /could not start/); }
    finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
    assert.equal(site.server.listening, false); assert.equal(f.calls.length, 0);
    assert.deepEqual(f.counts, { x: 0, grok: 0, sign: 0 });
  });
  test("failed bind closes the owned runtime without closing an unrelated listener", async () => {
    const occupied = createServer(); await new Promise(r => occupied.listen(0, "127.0.0.1", r));
    try {
      site = await createStagingSite(f.input, f.deps);
      await assert.rejects(site.start(occupied.address().port), /could not start/);
      assert.equal(site.snapshot().phase, "failed"); assert.equal(site.server.listening, false);
      assert.equal(occupied.listening, true); f.writer.assertHealthy();
      assert.deepEqual(f.counts, { x: 0, grok: 0, sign: 0 });
    } finally { await new Promise(r => occupied.close(r)); }
  });
  test("startup deadline and incomplete drain retain ownership and cannot produce a late listener", async t => {
    site = await createStagingSite(f.input, f.deps);
    let release, enter; const entered = new Promise(r => { enter = r; });
    f.faults.afterQuery = async () => { f.faults.afterQuery = undefined; enter(); await new Promise(r => { release = r; }); };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const rejected = assert.rejects(site.start(0), /drain incomplete; retain writer ownership/);
      await entered; t.mock.timers.tick(15000); await new Promise(r => setImmediate(r));
      assert.equal(site.snapshot().phase, "closing"); assert.equal(site.server.listening, false);
      f.writer.assertHealthy();
      t.mock.timers.tick(15000); await rejected;
      assert.equal(site.snapshot().phase, "failed"); f.writer.assertHealthy();
      release(); await f.writer.transaction(async () => {});
      await assert.rejects(site.close(), /drain incomplete/);
      assert.equal(site.server.listening, false); assert.equal(f.calls.length, 0);
      assert.deepEqual(f.counts, { x: 0, grok: 0, sign: 0 });
      site = undefined; // Failed drain is deliberately sticky, not a cleanup retry.
    } finally { t.mock.timers.reset(); release?.(); }
  });
  test("an observer deadline closes admission before its delayed database cleanup settles", async t => {
    site = await createStagingSite(f.input, f.deps);
    t.mock.timers.enable({ apis: ["setTimeout"] }); let release;
    try {
      await site.start(0);
      let enter; const entered = new Promise(r => { enter = r; });
      f.faults.afterQuery = async () => { f.faults.afterQuery = undefined; enter(); await new Promise(r => { release = r; }); };
      t.mock.timers.tick(5000); await entered;
      t.mock.timers.tick(15000); await new Promise(r => setImmediate(r));
      assert.equal(site.snapshot().phase, "closing"); assert.equal(site.server.listening, false);
      assert.equal(site.snapshot().observer.lastOutcome, "deadline");
      assert.deepEqual(await site.reads.lookup("alice"), { state: "unknown" }); f.writer.assertHealthy();
      release(); await site.close();
      assert.equal(site.snapshot().phase, "failed");
      assert.deepEqual(f.counts, { x: 0, grok: 0, sign: 0 });
    } finally { t.mock.timers.reset(); release?.(); }
  });
  test("full HTTP preparation -> reported hash stays hidden -> canonical inclusion Confirming -> finalized home/MBTI/collection/media", async () => {
    await start(); await sync(); const r = await prepare();
    const pending = await http(`/mint/${r.code}`); assert.equal(pending.status, 200); assert.doesNotMatch(pending.text, /ALIce|ENFP|data:application\/json/);
    assert.doesNotMatch(pending.text.split("</head>")[0], /og:|twitter:|rel="canonical"/);
    await http("/api/mints/report", { code: r.code, permit: r.permit, transactionHash: `0x${"9".repeat(64)}` });
    assert.equal((await http(`/api/mints/status/${r.code}`)).body.state, "pending");
    assert.equal((await http("/signatures/alice")).status, 503); assert.deepEqual((await http("/api/gallery")).body.items, []);
    const minted = f.include(r.transaction); await sync();
    const status = await http(`/api/assessments/${r.code}`); assert.equal(status.body.mint.state, "confirming"); assert.equal(status.body.canMint, false);
    assert.equal(status.body.mint.transactionHash, minted.hash); assert.doesNotMatch(status.text, /ENFP|assessmentDigest|permit|ALIce/);
    const redirect = await http(`/mint/${r.code}`); assert.equal(redirect.status, 303); assert.equal(redirect.headers.location, "/signatures/alice");
    const page = await http("/signatures/alice"); assert.equal(page.status, 200); assert.match(page.text, /Confirming/); assert.match(page.text, /ALIce/);
    assert.match(page.text, /Grok selected this MBTI/); assert.match(page.text, /not a cryptographic signature from Grok/);
    assert.match(page.text, /Spelling verified at preparation/); assert.match(page.text, /Research sources/);
    assert.ok(page.text.includes(f.input.assessmentPolicy.model));
    assert.doesNotMatch(page.text, /offline-site|providerResponseId|cost_usd_ticks|budget_reservations/);
    assert.doesNotMatch(page.text.split("</head>")[0], /og:|twitter:|rel="canonical"/);
    const sharingPath = `/sharing/signatures/alice/${minted.a.inputDigest}.png`;
    assert.equal((await http(sharingPath)).status, 503);
    assert.doesNotMatch((await http("/p/ALIce/ENFP")).text.split("</head>")[0], /og:|twitter:|rel="canonical"/);
    assert.deepEqual((await http("/api/gallery")).body.items, []);
    const image = await http(`/api/signatures/alice/artwork/${minted.a.inputDigest}/svg`); assert.equal(image.text, minted.svg);
    const metadata = await http(`/api/signatures/alice/artwork/${minted.a.inputDigest}/metadata`); assert.deepEqual(metadata.body, minted.metadata);
    assert.equal((await http(`/api/signatures/alice/artwork/${minted.a.inputDigest}/png`)).bytes.subarray(1, 4).toString(), "PNG");
    assert.equal((await http("/p/ALIce/variations")).status, 200);
    f.finalize(); await sync();
    assert.equal((await http(`/api/mints/status/${r.code}`)).body.state, "minted");
    assert.equal((await http("/api/gallery")).body.items.length, 1);
    for (const path of ["/", "/ENFP/", "/me", "/signatures/alice"]) { const p = await http(path); assert.equal(p.status, 200, path); assert.match(p.text, /ALIce/); }
    const card = await http("/signatures/alice"), head = card.text.split("</head>")[0];
    assert.match(card.text, /Grok selected this MBTI/);
    assert.match(head, /href="https:\/\/staging.signatures.gallery\/signatures\/alice"/);
    assert.ok(head.includes(`content="https://staging.signatures.gallery${sharingPath}"`));
    assert.match(head, /@ALIce × ENFP/); assert.match(head, /noindex/); assert.doesNotMatch(head, /permit|csrf|assessmentDigest|providerResponseId/);
    const alias = (await http("/p/ALIce/ENFP")).text.split("</head>")[0]; assert.ok(alias.includes(`https://staging.signatures.gallery${sharingPath}`));
    const other = (await http("/p/ALIce/INTJ")).text.split("</head>")[0]; assert.match(other, /free preview/); assert.match(other, /sharing\/previews\/ALIce\/INTJ\/sg-renderer-2.0.0.png/);
    assert.doesNotMatch((await http("/me")).text.split("</head>")[0], /og:|twitter:|rel="canonical"/);
    const shared = await http(sharingPath); assert.equal(shared.status, 200); assert.equal(shared.headers["cache-control"], "no-store");
    assert.deepEqual(shared.bytes, (await http(`/api/signatures/alice/artwork/${minted.a.inputDigest}/png`)).bytes);
    assert.equal((await http("/sitemap.xml")).status, 404);
    assert.deepEqual(f.counts, { x: 1, grok: 1, sign: 1 }); assert.ok(f.calls.every(c => !/send|sign/i.test(c.method)));
    // Same accepted data survives listener/controller recreation; providers and
    // signer are now forbidden. Reading provenance is not a reuse/mint action.
    await site.close();
    site = await createStagingSite(f.input, { sessions: f.sessions, provider: undefined, identityResolver: undefined,
      signer: { address: f.deps.signer.address, signTypedData() { assert.fail("no signing on reads"); } } });
    await new Promise(resolve => site.server.listen(0, "127.0.0.1", resolve)); await sync();
    const restored = await http("/signatures/alice"); assert.equal(restored.status, 200); assert.match(restored.text, /Grok selected this MBTI/);
    assert.deepEqual(f.counts, { x: 1, grok: 1, sign: 1 });
  });
  test("unfinalized reorg withdraws reveal and media, retaining the pending dispatch and accepted assessment", async () => {
    await start(); const r = await prepare(), m = f.include(r.transaction); await sync();
    assert.equal((await http(`/api/mints/status/${r.code}`)).body.state, "confirming"); f.reorg(); await sync();
    assert.equal((await http(`/api/mints/status/${r.code}`)).body.state, "pending");
    assert.equal((await http("/signatures/alice")).status, 503);
    assert.equal((await http(`/api/signatures/alice/artwork/${m.a.inputDigest}/svg`)).status, 503);
    assert.equal((await http("/api/mints/begin", { code: r.code, consent: true })).status, 409); assert.deepEqual(f.counts, { x: 1, grok: 1, sign: 1 });
  });
  test("finalized contradiction safety-halts without rebuilding or disclosing saved artwork", async () => {
    await start(); const r = await prepare(); const m = f.include(r.transaction); f.finalize(); await sync(); f.reorg();
    assert.equal(await site.sync(), "safety-halted"); assert.equal((await http("/api/gallery")).status, 503);
    assert.equal((await http(`/api/mints/status/${r.code}`)).body.state, "pending"); assert.equal((await http("/signatures/alice")).status, 503);
    assert.equal((await http(`/sharing/signatures/alice/${m.a.inputDigest}.png`)).status, 503);
  });
  test("public browsing is free/inert; navigation, previews, assets, validation and exact Host work", async () => {
    await start(); assert.equal((await http("/")).status, 503); await sync();
    const paths = ["/", "/about", "/robots.txt", "/p/Alice/variations", "/p/Alice/INTJ", "/preview/Alice/INTJ.svg", "/sharing/previews/Alice/INTJ/sg-renderer-2.0.0.png", "/assets/generative-wallet.js", "/assets/generative-gallery.css", "/assets/generative-reveal.js"];
    for (const path of paths) { const p = await http(path, undefined, { cookie: "" }); assert.equal(p.status, 200, path);
      assert.match(p.headers["cache-control"], /no-store/); assert.match(p.headers["x-robots-tag"], /noindex/); assert.equal(p.headers["set-cookie"], undefined); }
    const mint = await http("/mint?handle=Alice", undefined, { cookie: "" }); assert.equal(mint.status, 200); assert.match(mint.text, /Ethereum Sepolia/); assert.match(mint.headers["set-cookie"][0], /Secure/);
    const collection = await http("/me", undefined, { cookie: "" }); assert.equal(collection.status, 200);
    assert.equal((await http("/s/Alice/INTJ")).headers.location, "/p/Alice/INTJ");
    for (const path of ["/mint?handle=Alice&handle=Bob", "/mint?mbti=INTJ", "/mint?handle=bad%2Fhandle", "/mint#x"]) assert.equal((await http(path)).status, 400, path);
    assert.equal((await http("/", undefined, { host: "evil.example" })).status, 421);
    assert.equal((await http("/", undefined, { "x-forwarded-host": "staging.signatures.gallery" })).status, 400);
    assert.equal((await http("/api/projection/sync", {})).status, 404);
    assert.equal((await http("/mint", {})).status, 400);
    assert.deepEqual(f.counts, { x: 0, grok: 0, sign: 0 });
    assert.equal((await f.db.query("SELECT count(*)::int n FROM open_mint.requests")).rows[0].n, 0);
  });
  test("progress is private and validates routes without automatic preparation or retries", async () => {
    await start(); const r = await prepare();
    assert.equal((await http(`/mint/${r.code}`, undefined, { cookie: "" })).status, 403);
    assert.equal((await http(`/api/assessments/${r.code}`, undefined, { cookie: "" })).status, 403);
    assert.equal((await http(`/mint/${r.code}?mbti=ENFP`)).status, 400);
    assert.equal((await http(`/mint/${"a".repeat(43)}`)).status, 404);
    assert.equal((await http(`/mint/${r.code}`)).status, 200); assert.deepEqual(f.counts, { x: 1, grok: 1, sign: 1 });
  });
  for (const kind of ["source", "receipt", "runtime", "metadata", "review", "cancel"]) test(`withdraws reads on ${kind} failure`, async () => {
    await start(); const r = await prepare(), m = f.include(r.transaction); await sync();
    f.controls.mutation = (v, method, params, source) => {
      if (kind === "source" && method === "eth_chainId" && source === 1) return "0x1";
      if (kind === "receipt" && method === "eth_getTransactionReceipt" && params[0] === m.hash) return { ...v, status: "0x0" };
      if (kind === "runtime" && method === "eth_getCode") return "0x6000";
      if (kind === "metadata" && method === "eth_call" && String(v).length > 2000) return "0x";
      return v;
    };
    if (kind === "review") f.review.withdraw();
    const c = new AbortController(); if (kind === "cancel") c.abort();
    assert.equal(await site.sync(c.signal), "unavailable");
    assert.equal((await http("/api/gallery")).status, 503); assert.equal((await http("/signatures/alice")).status, 503);
    assert.deepEqual(f.counts, { x: 1, grok: 1, sign: 1 });
  });
  test("close is idempotent, drains and withdraws reads without closing the caller-owned writer", async () => {
    await start(); await sync(); const p = site.close(); assert.equal(site.close(), p); await p;
    assert.equal(site.server.listening, false); assert.deepEqual(await site.reads.lookup("alice"), { state: "unknown" });
    await assert.rejects(site.sync()); f.writer.assertHealthy();
  });
  test("mint navigation waits for short read contention rather than showing raw BUSY JSON", async () => {
    await start(); const r = await prepare();
    for (const path of ["/mint?handle=Alice", `/mint/${r.code}`]) {
      let release, enter;
      const entered = new Promise(resolve => { enter = resolve; });
      f.faults.afterQuery = async () => { f.faults.afterQuery = undefined; enter(); await new Promise(resolve => { release = resolve; }); };
      const active = http("/api/session"); await entered;
      const page = http(path); await new Promise(resolve => setTimeout(resolve, 75)); release();
      assert.equal((await active).status, 200);
      const result = await page; assert.equal(result.status, 200, result.text); assert.match(result.headers["content-type"], /text\/html/);
    }
    assert.deepEqual(f.counts, { x: 1, grok: 1, sign: 1 });
  });
  test("page contention wait is bounded and disconnect does not start or retry mint work", async () => {
    await start();
    for (const cancelled of [false, true]) {
      let release, enter;
      const entered = new Promise(resolve => { enter = resolve; });
      f.faults.afterQuery = async () => { f.faults.afterQuery = undefined; enter(); await new Promise(resolve => { release = resolve; }); };
      const active = http("/api/session"); await entered;
      try {
        if (cancelled) {
          const req = httpRequest({ host: "127.0.0.1", port: site.server.address().port, path: "/mint?handle=Alice",
            headers: { host: "staging.signatures.gallery", "x-forwarded-proto": "https", cookie: f.sessions.cookie(f.session) } });
          req.on("error", () => {}); req.end();
          await new Promise(resolve => setTimeout(resolve, 75)); req.destroy();
          await new Promise(resolve => setTimeout(resolve, 75));
        } else {
          const start = performance.now(), result = await http("/mint?handle=Alice");
          assert.equal(result.status, 503); assert.equal(result.body.code, "BUSY");
          assert.ok(performance.now() - start >= 950 && performance.now() - start < 5000, "Contention is bounded to about one second");
        }
      } finally { release(); assert.equal((await active).status, 200); }
      assert.equal((await http("/mint?handle=Alice")).status, 200);
    }
    assert.deepEqual(f.counts, { x: 0, grok: 0, sign: 0 });
    assert.equal((await f.db.query("SELECT count(*)::int n FROM open_mint.requests")).rows[0].n, 0);
  });
  test("a restarted site requires fresh observation; persisted finalized rows alone never reveal", async () => {
    await start(); const r = await prepare(); f.include(r.transaction); f.finalize(); await sync(); await site.close();
    site = await createStagingSite(f.input, { ...f.deps, provider: undefined, identityResolver: undefined });
    await new Promise(r => site.server.listen(0, "127.0.0.1", r));
    assert.equal((await http("/api/gallery")).status, 503); assert.equal((await http("/signatures/alice")).status, 503);
    assert.equal((await http(`/api/mints/status/${r.code}`)).body.state, "pending"); await sync();
    assert.equal((await http(`/api/mints/status/${r.code}`)).body.state, "minted");
    assert.equal((await http("/api/gallery")).body.items.length, 1); assert.deepEqual(f.counts, { x: 1, grok: 1, sign: 1 });
  });
  test("overlapping sync is refused and close cancels a pass without restoring freshness", async () => {
    await start(); let release, entered;
    const reached = new Promise(r => { entered = r; });
    f.controls.mutation = async v => { entered(); await new Promise(r => { release = r; }); return v; };
    const pending = site.sync(); await reached; assert.equal(await site.sync(), "busy");
    const closing = site.close(); f.controls.mutation = undefined; release();
    assert.equal(await pending, "unavailable"); await closing;
    assert.deepEqual(await site.reads.lookup("alice"), { state: "unknown" }); f.writer.assertHealthy();
  });
  test("acceptance is not a reveal; saved ready page stays hidden until explicit wallet action", async () => {
    await start(); const r = await http("/api/assessments", { handle: "Alice" }); await site.idle();
    const ready = await http(`/mint/${r.body.code}`); assert.equal(ready.status, 200);
    assert.match(ready.text, /Continue mint/); assert.doesNotMatch(ready.text, /ALIce|ENFP/);
    assert.deepEqual(f.counts, { x: 1, grok: 1, sign: 0 });
    assert.equal((await f.db.query("SELECT count(*)::int n FROM open_mint.wallet_mint_dispatches")).rows[0].n, 0);
  });
  test("invalid/production composition is refused before projection creation", async () => {
    await assert.rejects(createStagingSite({ ...f.input, enabled: true }, f.deps), /unavailable/);
    await assert.rejects(createStagingSite(f.input, { ...f.deps, sessions: {} }), /unavailable/);
    const old = process.env.NODE_ENV; process.env.NODE_ENV = "production";
    try { await assert.rejects(createStagingSite(f.input, f.deps), /unavailable/); } finally { if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old; }
    assert.equal((await f.db.query("SELECT count(*)::int n FROM open_mint.projection_deployments")).rows[0].n, 0);
  });
});
