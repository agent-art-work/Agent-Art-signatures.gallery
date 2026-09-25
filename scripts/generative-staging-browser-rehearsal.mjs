import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { stagingSiteFixture } from "../contracts/tools/fixtures/generative-staging-site.mjs";
import { stagingBrowserDriver } from "../contracts/tools/fixtures/generative-staging-browser.mjs";
import { createStagingSite } from "../contracts/tools/generative-staging-site.mjs";
import { disposablePostgres } from "../src/openMint/persistence/fixtures/postgres.ts";
import { closeHttpServer } from "../src/openMint/shutdown.ts";

// Explicit offline-only entrypoint. No environment-file/key discovery, real RPC,
// broadcaster or active rehearsal paths. The relay is TEST infrastructure, NOT
// a deployable staging proxy or evidence for hosted TLS/cookie policy.
const args = process.argv.slice(2), at = args.indexOf("--visual-tool"), chosen = args.indexOf("--scenario");
assert.notEqual(process.env.NODE_ENV, "production");
assert.ok(at >= 0 && args[at + 1] && existsSync(args[at + 1]), "Pass --visual-tool /absolute/path/to/verify-page.mjs");
const visualTool = resolve(args[at + 1]), scenarios = chosen < 0 ? ["success", "uncertain", "revoked"] : [args[chosen + 1]];
assert.ok(at === 0 && (args.length === 2 || args.length === 4 && chosen === 2) && scenarios.every(v => ["success", "uncertain", "revoked"].includes(v)), "Unknown argument/scenario");
const output = resolve(".local/generative-renderer"); await mkdir(output, { recursive: true });
let cluster, admin;
const evidence = [];
const listen = server => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const hash = `0x${(9001n).toString(16).padStart(64, "0")}`;
try {
  cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect();
  for (const scenario of scenarios) {
    const f = await stagingSiteFixture(cluster, admin);
    let site, relay, origin, restart, code, plan, sessionCookie, permit, controlGate, withdrawn = false, sessionRevoked = false;
    const activeForwards = new Set();
    const counts = { connect: 0, proof: 0, create: 0, authorize: 0, begin: 0, report: 0, send: 0 }, failures = [], requests = [];
    const secret = `/__offline_browser_${randomUUID()}`, control = secret + "/control", wallet = secret + "/wallet", driver = secret + "/driver.js";
    const sendJson = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    async function upstream(path, method = "GET", bytes, headers = {}) {
      await restart;
      return new Promise((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: site.server.address().port, path, method,
          headers: { host: "staging.signatures.gallery", "x-forwarded-proto": "https", ...(bytes ? { "content-length": Buffer.byteLength(bytes), "content-type": "application/json" } : {}), ...headers } }, res => {
          const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => {
            const bytes = Buffer.concat(chunks), text = bytes.toString();
            resolve({ status: res.statusCode, headers: res.headers, bytes, text, body: res.headers["content-type"]?.includes("application/json") && text ? JSON.parse(text) : undefined });
          });
        }); req.setTimeout(20000, () => req.destroy(Error("Fixture upstream timed out"))); req.on("error", reject); req.end(bytes);
      });
    }
    const pending = async () => {
      // Operator read can overlap the browser's report/poll. Only retry this
      // read-only BUSY response; never an assessment/sign/begin/send operation.
      let status;
      for (let attempt = 0; attempt < 40; attempt++) {
        status = await upstream(`/api/mints/status/${code}`, "GET", undefined, { cookie: sessionCookie });
        if (status.body?.code !== "BUSY") break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.equal(status.status, 200, status.text); assert.equal(status.body.state, "pending");
      assert.equal((await site.reads.lookup("alice")).state === "confirmed", false); return status.body;
    };
    function exactCounts() {
      assert.deepEqual(f.counts, { x: 1, grok: 1, sign: 1 });
      assert.equal(counts.create, 1); assert.equal(counts.authorize, 1); assert.equal(counts.begin, 1);
      assert.equal(counts.send, scenario === "revoked" ? 0 : 1); assert.equal(counts.proof, 1);
      // Reload may replay the SAME idempotent report, never begin/send again.
      assert.ok(scenario === "success" ? counts.report >= 1 : counts.report === 0, "Unexpected report count");
    }
    try {
      site = await createStagingSite(f.input, f.deps); await site.start(0);
      relay = createServer(async (req, res) => {
        try {
          assert.equal(req.socket.remoteAddress, "127.0.0.1"); assert.equal(req.headers.host, new URL(origin).host);
          assert.ok(req.method === "GET" || req.method === "POST");
          assert.ok(!Object.keys(req.headers).some(k => k === "forwarded" || k.startsWith("x-forwarded-")));
          if (req.method === "POST") assert.equal(req.headers.origin, origin);
          let raw = ""; for await (const part of req) { raw += part; assert.ok(raw.length < 65536); }
          if (req.url === driver && req.method === "GET") {
            res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
            res.end(`(${stagingBrowserDriver.toString()})(${JSON.stringify({ control, scenario })});`); return;
          }
          if (req.url === wallet && req.method === "POST") {
            const { method, params = [] } = JSON.parse(raw); let result;
            if (method === "eth_accounts" || method === "eth_requestAccounts") { if (method === "eth_requestAccounts") counts.connect++; result = [f.wallet.address]; }
            else if (method === "personal_sign") {
              assert.equal(params[1], f.wallet.address); assert.match(params[0], /staging.signatures.gallery wants you to sign in/);
              counts.proof++; assert.equal(counts.proof, 1); result = await f.wallet.signMessage({ message: params[0] });
            } else if (method === "eth_sendTransaction") {
              assert.equal(counts.send, 0); assert.ok(permit && plan); assert.deepEqual(params, [plan]); await pending(); counts.send++;
              if (scenario === "uncertain") return sendJson(res, 200, { error: { message: "Offline wallet lost its outcome", code: -32000 } });
              result = hash; // Synthetic return only. Never broadcasts or manufactures inclusion.
            } else if (method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt") result = null;
            else if (method === "eth_call" && params[0]?.from) { assert.ok(plan); assert.equal(params[0].data, plan.data); result = "0x"; }
            else {
              assert.ok(["eth_chainId", "eth_getCode", "eth_getBlockByNumber", "eth_getTransactionCount"].includes(method), "Unexpected wallet method " + method);
              result = await f.input.sources[0].request(method, params, AbortSignal.timeout(5000));
            }
            sendJson(res, 200, { result }); return;
          }
          if (req.url === control && req.method === "POST") {
            const { action } = JSON.parse(raw);
            // Inclusion is synthetic TEST chain input, not a sync request.
            // Keep browser traffic flowing while the independently scheduled
            // observer discovers it; no test-side quiescence or acceleration.
            if (action === "include") {
              exactCounts(); const included = f.include(plan); assert.equal(included.hash, hash);
              assert.equal(site.snapshot().phase, "running"); sendJson(res, 200, {}); return;
            }
            // Restart/logout are explicit TEST operator transitions. Only
            // these controls quiesce forwarded HTTP, never the observer.
            assert.equal(controlGate, undefined); let release;
            controlGate = new Promise(r => { release = r; });
            try {
              await Promise.allSettled([...activeForwards]);
              let result = {};
              console.log(JSON.stringify({ scenario, testTransition: action }));
              if (action === "restart") {
                await site.idle(); exactCounts(); result = await pending();
                restart = (async () => {
                  await site.close(); site = await createStagingSite(f.input, { ...f.deps, provider: undefined, identityResolver: undefined });
                  assert.deepEqual(await site.reads.lookup("alice"), { state: "unknown" }); await site.start(0);
                })(); await restart; restart = undefined;
                assert.deepEqual((await upstream("/api/gallery")).body.items, []); await pending(); exactCounts();
              } else if (action === "pending-check") { await pending(); exactCounts(); }
              else if (action === "logout") {
                const session = await upstream("/api/session", "GET", undefined, { cookie: sessionCookie });
                assert.equal(session.status, 200);
                const loggedOut = await upstream("/api/session/logout", "POST", "{}", { cookie: sessionCookie, origin: f.settings.origin, "x-csrf-token": session.body.csrfToken });
                assert.equal(loggedOut.status, 200); sessionRevoked = true; res.setHeader("Set-Cookie", loggedOut.headers["set-cookie"]);
                exactCounts();
              } else if (action === "signed-out-check") {
                exactCounts(); const old = await upstream(`/api/assessments/${code}`, "GET", undefined, { cookie: sessionCookie }); assert.equal(old.status, 403);
              } else if (action === "revoked-check") {
                assert.ok(withdrawn); exactCounts();
                assert.equal((await f.db.query("SELECT count(*)::int n FROM open_mint.wallet_mint_dispatches")).rows[0].n, 0);
              } else assert.fail("Unknown control action");
              sendJson(res, 200, result); return;
            } finally { controlGate = undefined; release(); }
          }
          if (req.method === "POST") {
            const c = { "/api/assessments": "create", "/api/mints/authorize": "authorize", "/api/mints/begin": "begin", "/api/mints/report": "report" }[req.url];
            if (c) counts[c]++;
            if (req.url === "/api/mints/report") assert.deepEqual(JSON.parse(raw), { code, permit, transactionHash: hash });
            if (req.url === "/api/mints/begin" && scenario === "revoked") { f.review.withdraw(); withdrawn = true; }
          }
          const headers = { ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}), ...(req.method === "POST" ? { origin: f.settings.origin, "x-csrf-token": req.headers["x-csrf-token"] || "" } : {}) };
          await controlGate;
          const forwarded = upstream(req.url, req.method, raw || undefined, headers); activeForwards.add(forwarded);
          let response; try { response = await forwarded; } finally { activeForwards.delete(forwarded); }
          for (const cookie of response.headers["set-cookie"] ?? []) {
            assert.match(cookie, /^__Host-sg-staging=(?:[A-Za-z0-9_-]{43})?; HttpOnly; SameSite=Strict; Path=\/; Max-Age=(?:86400|0); Secure$/);
          }
          requests.push({ path: req.url, method: req.method, status: response.status, ...(response.status >= 400 ? { code: response.body?.code } : {}) });
          if (response.status >= 400) console.log(JSON.stringify({ scenario, response: response.status, code: response.body?.code, method: req.method }));
          if (req.url === "/api/assessments" && response.status === 202) {
            assert.match(req.headers.cookie, /(?:^|; )__Host-sg-staging=[A-Za-z0-9_-]{43}(?:;|$)/);
            assert.ok(!req.headers.cookie.includes("sg_open_session")); code = response.body.code; sessionCookie = req.headers.cookie;
          }
          if (req.url === "/api/mints/authorize" && response.status === 200) plan = response.body.transaction;
          if (req.url === "/api/mints/begin" && response.status === 200) { permit = response.body.permit; assert.deepEqual(response.body.transaction, plan); }
          let bytes = response.bytes;
          if (req.url === "/assets/generative-wallet.js") bytes = Buffer.from(`window.ethereum={isRabby:true,on(){},removeListener(){},async request(input){
            const r=await fetch(${JSON.stringify(wallet)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
            const v=await r.json();if(!r.ok||v.error)throw Object.assign(Error(v.error?.message||v.error||'Fixture wallet failed'),{code:v.error?.code});return v.result;}};\n` + response.text);
          if (response.headers["content-type"]?.includes("text/html")) bytes = Buffer.from(response.text.replace("</body>", `<script src="${driver}" defer></script></body>`));
          // Keep CSP, Secure/HttpOnly cookies and application bytes otherwise
          // unchanged. Chromium's loopback exception is NOT hosted TLS evidence.
          const out = { ...response.headers }; delete out["content-length"]; delete out["transfer-encoding"]; delete out.connection;
          res.writeHead(response.status, out); res.end(bytes);
        } catch (error) { failures.push(String(error.stack)); sendJson(res, 500, { error: String(error.message) }); }
      });
      await listen(relay); origin = `http://127.0.0.1:${relay.address().port}`;
      async function verify(name, path, viewport, theme, waitFor, expression) {
        const screenshot = resolve(output, name + ".png");
        let stdout;
        // The skill cleans up Chrome/profile in its module's finally. Exit
        // only AFTER that completes; many navigations can otherwise leave a
        // DevTools WebSocket handle keeping its finished Node process alive.
        const launch = `await import(${JSON.stringify(visualTool)});process.exit(process.exitCode ?? 0);`;
        try { ({ stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", launch, "--", "--url", origin + path, "--viewport", viewport, "--color-scheme", theme,
          "--wait-for", waitFor, "--timeout-ms", "90000", "--disable-cache", "--screenshot", screenshot, "--eval", expression], { timeout: 110000, maxBuffer: 8 * 1024 * 1024 }));
        } catch (error) {
          if (error.stdout) await writeFile(resolve(output, name + "-failed-output.txt"), error.stdout);
          throw Error(`Browser verifier failed (${name}); inspect its captured output and screenshot.`, { cause: error.message });
        }
        const result = JSON.parse(stdout); await writeFile(resolve(output, name + ".json"), JSON.stringify(result, null, 2));
        assert.deepEqual(failures, []); assert.ok(result.evaluation, "Missing browser result"); assert.equal(result.evaluation.error, undefined, JSON.stringify(result.evaluation));
        assert.equal(result.evaluation.overflow, false); return result;
      }
      const result = await verify(`staging-browser-${scenario}`, "/mint?handle=Alice", "390x844", "dark", "[data-staging-test-result]",
        `JSON.parse(sessionStorage.getItem('sg-test-flow')||'null')`);
      exactCounts(); assert.equal(result.evaluation.phase, "complete");
      const errors = requests.filter(r => r.status >= 400);
      assert.ok(errors.every(r => (r.code === "BUSY" && (r.method === "GET" || r.path === "/api/mints/report"))
        || scenario === "uncertain" && sessionRevoked && r.method === "GET" && r.status === 403 && r.code === "SESSION_REQUIRED" && r.path === `/api/mints/status/${code}`
        || scenario === "revoked" && ["/api/mints/begin", `/api/assessments/${code}`, `/api/mints/status/${code}`].includes(r.path)), JSON.stringify(errors));
      assert.ok(result.requests.every(r => r.url.startsWith(origin + "/")), "Unexpected external browser request");
      assert.ok(result.requests.filter(r => r.status >= 400).every(r => errors.some(e => origin + e.path === r.url && e.status === r.status)), "Unaccounted browser HTTP failure");
      assert.ok(f.calls.every(c => !/send|sign/i.test(c.method)), "No broadcasting/signing RPC");
      if (scenario === "success") {
        assert.ok(counts.report >= 2, "Reload re-reports the exact saved hash without another send");
        assert.equal(result.evaluation.state, "confirming"); assert.equal(result.evaluation.images, 1); assert.equal(result.evaluation.imagesLoaded, true);
        f.finalize(); const end = Date.now() + 20000;
        while ((await site.reads.lookup("alice")).state !== "confirmed") {
          assert.ok(Date.now() < end, "Scheduled observer did not finalize"); await new Promise(r => setTimeout(r, 100));
        }
        const final = await verify("staging-browser-finalized", "/", "1280x960", "light", ".public-gallery-grid img", `(async()=>{
          const images=[...document.querySelectorAll('.public-gallery-grid img')];await Promise.all(images.map(i=>i.decode()));
          images[0]?.closest('.gallery-card')?.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          const gallery=await(await fetch('/api/gallery')).json();return {count:images.length,loaded:images.every(i=>i.naturalWidth>0),
            handles:gallery.items.map(i=>i.handle),caption:document.querySelector('.artwork-identity')?.textContent,
            overflow:document.documentElement.scrollWidth>innerWidth};})()`);
        assert.equal(final.evaluation.count, 1); assert.equal(final.evaluation.loaded, true); assert.deepEqual(final.evaluation.handles, ["alice"]);
        assert.match(final.evaluation.caption, /@ALIce.*ENFP/); assert.deepEqual(final.requests.filter(r => r.status >= 400), []); exactCounts();
        evidence.push({ scenario: "finalized-gallery", ...final.evaluation, screenshot: final.screenshotPath });
        // Metadata is staging-origin absolute; test retrieval stays on the
        // loopback relay. Never contact the real hostname or a social crawler.
        for (const [label, path] of [["preview", "/p/ALIce/INTJ"], ["minted", "/signatures/alice"]]) {
          const card = await verify(`staging-browser-card-${label}`, path, "1280x960", "light", ".signature-art img", `(async()=>{
            const image=document.querySelector('meta[property="og:image"]')?.content;
            if(!image||new URL(image).origin!=='https://staging.signatures.gallery')throw Error('Invalid card origin');
            const r=await fetch(new URL(image).pathname);if(!r.ok)throw Error('Card image unavailable');
            const bitmap=await createImageBitmap(await r.blob());const size=[bitmap.width,bitmap.height];bitmap.close();
            const artwork=document.querySelector('.signature-art img');await artwork.decode();
            return {canonical:document.querySelector('link[rel="canonical"]')?.href,image,size,
              title:document.querySelector('meta[property="og:title"]')?.content,robots:document.querySelector('meta[name="robots"]')?.content,
              robotsHeader:r.headers.get('x-robots-tag'),cache:r.headers.get('cache-control'),
              overflow:document.documentElement.scrollWidth>innerWidth};})()`);
          assert.equal(card.evaluation.cache, "no-store"); assert.match(card.evaluation.robots, /noindex/); assert.match(card.evaluation.robotsHeader, /noindex/);
          assert.ok(card.evaluation.image.includes(label === "preview" ? "/sharing/previews/ALIce/INTJ/" : "/sharing/signatures/alice/"));
          assert.equal(card.evaluation.canonical, `https://staging.signatures.gallery${path}`);
          assert.match(card.evaluation.title, label === "preview" ? /free preview/ : /minted signature/);
          assert.ok(card.evaluation.size.every(n => n > 0 && n <= 1080));
          assert.ok(card.requests.every(r => r.url.startsWith(origin + "/"))); assert.deepEqual(card.requests.filter(r => r.status >= 400), []); exactCounts();
          evidence.push({ scenario: `card-${label}`, ...card.evaluation, screenshot: card.screenshotPath });
        }
        for (const [viewport, theme] of [["1280x960", "light"], ["390x844", "dark"]]) {
          const provenance = await verify(`staging-browser-provenance-${theme}`, "/signatures/alice", viewport, theme,
            ".signature-provenance", `(async()=>{
              const panel=document.querySelector('.signature-provenance');panel.open=true;
              panel.scrollIntoView({block:'start'});await document.fonts.ready;
              await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
              const sections=[...panel.querySelectorAll('.signature-provenance-section')];
              const facts=Object.fromEntries([...sections[0].querySelectorAll('.signature-facts>div')].map(row=>[row.querySelector('dt').textContent,row.querySelector('dd').textContent]));
              const sources=[...panel.querySelectorAll('[data-assessment-sources] a')];
              return {facts,sections:sections.map(s=>s.querySelector('h2').textContent),
                caveats:panel.querySelectorAll('.provenance-caveats').length,
                sources:sources.map(a=>({url:a.href,rel:a.rel,referrer:a.referrerPolicy})),
                explanation:sections[0].querySelector('p').textContent,
                privateLeak:/offline-site|providerResponseId|cost_usd_ticks|budget_reservations/.test(panel.textContent),
                fontSize:getComputedStyle(sections[0]).fontSize,
                overflow:document.documentElement.scrollWidth>innerWidth};})()`);
          assert.equal(provenance.evaluation.facts.Assessor, "Grok");
          assert.equal(provenance.evaluation.facts.Model, f.input.assessmentPolicy.model);
          assert.ok(provenance.evaluation.facts.Assessed); assert.ok(provenance.evaluation.facts["Spelling verified at preparation"]);
          assert.deepEqual(provenance.evaluation.sections, ["Assessment", "Artwork", "Mint"]);
          assert.equal(provenance.evaluation.caveats, 1); assert.equal(provenance.evaluation.privateLeak, false);
          assert.match(provenance.evaluation.explanation, /not a cryptographic signature from Grok/);
          assert.deepEqual(provenance.evaluation.sources, [{ url: "https://x.com/ALIce", rel: "noopener noreferrer", referrer: "no-referrer" }]);
          assert.ok(parseFloat(provenance.evaluation.fontSize) >= 14);
          assert.ok(provenance.requests.every(r => r.url.startsWith(origin + "/")));
          assert.deepEqual(provenance.requests.filter(r => r.status >= 400), []); exactCounts();
          evidence.push({ scenario: `provenance-${theme}`, ...provenance.evaluation, screenshot: provenance.screenshotPath });
        }
      }
      evidence.push({ scenario, ...result.evaluation, counts, providers: f.counts, lifecycle: site.snapshot(), screenshot: result.screenshotPath, expectedHttpFailures: errors });
      console.log(JSON.stringify({ scenario, pass: true, counts, providers: f.counts, stages: result.evaluation.stages }));
    } finally { await (restart?.catch(() => {})); if (relay) await closeHttpServer(relay); await site?.close(); await f.close(); }
  }
  await writeFile(resolve(output, "staging-browser-evidence.json"), JSON.stringify({ syntheticWalletAndRpc: true, scheduledObserver: true, broadcasts: 0, paidCalls: 0, evidence }, null, 2));
} finally { await admin?.end(); cluster?.stop(); }
