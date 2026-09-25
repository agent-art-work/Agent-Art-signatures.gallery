import { generativeProfile } from "../src/openMint/generativeProfiles.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createServer as createTcpServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { Client } from "pg";
import { getAddress, keccak256, stringToHex, numberToHex } from "viem";
import { PublicChainGate } from "../src/openMint/publicChain.ts";
import { generativeRendererIdentity } from "../src/openMint/generativeInputs.ts";
import { generativeMintCalldata, generativeMintDigest } from "../src/openMint/generativeAuthorization.ts";
import { createGenerativeArtworkReader } from "../src/openMint/generativeReads.ts";
import { PostgresGenerativeInputJournal } from "../src/openMint/persistence/generativeInputs.ts";
import { PostgresGenerativeAuthorizationIssuer } from "../src/openMint/persistence/generativeAuthorizations.ts";
import { OpenMintRepository } from "../src/openMint/persistence/repository.ts";
import { PostgresMintRequests } from "../src/openMint/persistence/requests.ts";
import { PostgresWalletSessions } from "../src/openMint/persistence/sessions.ts";
import { PostgresAssessmentWorker } from "../src/openMint/persistence/assessmentWorker.ts";
import { ExclusiveWriter } from "../src/openMint/persistence/writer.ts";
import { disposablePostgres, installSchema } from "../src/openMint/persistence/fixtures/postgres.ts";
import { namespace } from "../src/openMint/persistence/fixtures/data.ts";
import { DurableMintRuntime } from "../src/openMint/persistence/runtimeService.ts";
import { createIsolatedGenerativeSite } from "../src/openMint/persistence/generativeSite.ts";
import { generativeBrowserRuntimeGrants } from "../src/openMint/persistence/runtimeRole.ts";
import { auditGenerativeBrowserRole } from "../src/openMint/persistence/roleAudit.ts";
import { OPEN_MINT_CLIENT_SCRIPT } from "../src/openMint/clientScript.ts";
import { localRuntimeAdmissionFixture } from "../src/openMint/persistence/fixtures/localAdmission.ts";
import { XApiIdentityResolver } from "../src/openMint/xIdentity.ts";
import { GrokAssessmentProvider } from "../src/openMint/grok.ts";
import { localReviewFilesFixture } from "../src/openMint/staging/fixtures/localReviewFiles.ts";
import { prepareLocalAdmissionStartup } from "../src/openMint/persistence/localAdmissionStartup.ts";

/** Invoked only by the explicit disposable-Anvil rehearsal. No environment file,
 * API credentials, production database, remote chain, or real provider request.
 * Mock provider payloads exercise the native acceptance path, not actual Grok. */
export async function rehearseGenerativeBackend({ client, wallet, account, signer, renderer, collection, expectedSvg, visualTool, reviewFiles = false, contractProfile = "generative-experimental-v1" }) {
  if (visualTool !== undefined) assert.ok(isAbsolute(visualTool), "Visual verifier must be an explicit absolute local path.");
  assert.equal(await client.getChainId(), 31337);
  assert.ok(!reviewFiles || contractProfile === "generative-v1-rc1", "File review rehearsal requires local RC1.");
  const profile = generativeProfile(contractProfile);
  const ns = { ...namespace(), profile: "local-real", provenance: "grok" }, deploymentId = randomUUID();
  const rendererCodeHash = keccak256(await client.getCode({ address: renderer }));
  const rendererPin = { address: getAddress(renderer), runtimeCodeHash: rendererCodeHash, identity: generativeRendererIdentity(renderer, rendererCodeHash, profile.inputProfile),
    ...(contractProfile === "generative-experimental-v1" ? {} : { inputProfile: profile.inputProfile }) };
  const config = { contractProfile, generativeRenderer: rendererPin, namespaceId: ns.id, deploymentId, chainId: 31337n,
    genesisHash: (await client.getBlock({ blockNumber: 0n })).hash, deploymentBlock: { number: collection.blockNumber, hash: collection.blockHash },
    contract: getAddress(collection.contractAddress), runtimeCodeHash: keccak256(await client.getCode({ address: collection.contractAddress })), authorizer: signer.address,
    maxBlockAgeMs: 120000, maxFutureSkewMs: 5000, evidenceTtlMs: 30000, observationTimeoutMs: 10000 };
  // Two independently invoked adapters against ONE disposable node. Deliberately
  // not evidence that two public RPC providers/operators have been validated.
  let finalizedCeiling;
  const rpc = id => ({ id, request: async (method, params, signal) => {
    signal.throwIfAborted();
    // A controlled TEST boundary exercises both states independently of Anvil's
    // native finalized tag. Not a public finality rule or elapsed-block fallback.
    const selected = method === "eth_getBlockByNumber" && params[0] === "finalized" && finalizedCeiling !== undefined ? [numberToHex(finalizedCeiling), false] : params;
    const result = await client.request({ method, params: selected }); signal.throwIfAborted(); return result;
  } });
  const rpcs = [rpc("disposable-anvil-a"), rpc("disposable-anvil-b")], gate = new PublicChainGate(config, rpcs);
  const cluster = disposablePostgres(), factory = () => new Client({ ...cluster.config, user: "sg_gen_rehearsal", options: "-c search_path=pg_catalog" });
  let admin, writer, prepared, issued, txReceipt, server, runtime, site, projectionEvidence;
  let providerCalls = 0, lookupCalls = 0, signingCalls = 0;
  const reviewRoots = [], startups = [];
  const bootAdmission = async requests => {
    if (contractProfile !== "generative-v1-rc1") return undefined;
    const fixture = await localRuntimeAdmissionFixture(requests, "sg_gen_rehearsal", 10000);
    if (!reviewFiles) return fixture;
    const files = localReviewFilesFixture({ assessment: fixture.assessment, mint: fixture.mint }); reviewRoots.push(files);
    const startup = await prepareLocalAdmissionStartup({ requests, expectedRole: "sg_gen_rehearsal", assessment: files.configs.assessment, mint: files.configs.mint });
    startups.push(startup);
    // Ephemeral fixture keys/revisions are regenerated for this new writer.
    // Operational startup must instead obtain independently reviewed pins.
    return { admission: startup.admission, events: [], recheck: startup.recheck };
  };
  try {
    admin = new Client(cluster.config); await admin.connect(); await installSchema(admin);
    for (const file of ["requests-schema.sql", "generative-input-schema.sql", "generative-release-profile-schema.sql", "generative-authorization-schema.sql", "wallet-submission-schema.sql", "../projection/projection-schema.sql", "../projection/projection-v2.sql", "../projection/projection-v3.sql"]) {
      await admin.query(readFileSync(new URL(`../src/openMint/persistence/${file}`, import.meta.url), "utf8"));
    }
    const probe = createTcpServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,$2,$3,$4)", [ns.id, ns.profile, ns.provenance, ns.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id,profile_version,expected_model,generation_enabled,valid_until,max_total,max_daily,max_active,max_queued,reservation_usd_ticks,max_exposure_usd_ticks)
      VALUES($1,'offline-generative-rehearsal','grok-offline-test',true,'2099-01-01',1,1,1,1,100,1000)`, [ns.id]);
    await admin.query("INSERT INTO open_mint.session_profiles VALUES($1,$2,31337)", [ns.id, origin]);
    await admin.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms)
      VALUES($1,$2,31337,$3,$4,$5,$6,$7,$8,30000,120000,5000)`, [ns.id, deploymentId, config.contract.toLowerCase(), config.genesisHash, config.runtimeCodeHash,
      signer.address.toLowerCase(), String(collection.blockNumber), collection.blockHash]);
    await admin.query("INSERT INTO open_mint.generative_input_profiles VALUES($1,$2,$6,$3,$4,$5)",
      [ns.id, deploymentId, rendererPin.address, rendererPin.runtimeCodeHash, rendererPin.identity, profile.inputProfile]);
    await admin.query("INSERT INTO open_mint.generative_issuance_profiles VALUES($1,$2,true,600,5000,30000,120000,5000)", [ns.id, deploymentId]);
    await admin.query("CREATE ROLE sg_gen_rehearsal LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await admin.query(generativeBrowserRuntimeGrants("sg_gen_rehearsal"));
    const audit = factory(); await audit.connect();
    try { assert.equal((await auditGenerativeBrowserRole(audit)).ok, true); } finally { await audit.end(); }
    writer = await ExclusiveWriter.acquire(factory);
    let repository = await OpenMintRepository.open(writer, ns), requests = await PostgresMintRequests.open(repository, deploymentId);
    let sessions = await PostgresWalletSessions.open({ writer, namespaceId: ns.id, origin, chainId: 31337 });
    let session = (await sessions.session()).session;
    const proof = await sessions.challenge(session.id, account.address);
    await sessions.verify(session.id, proof.challengeId, await account.signMessage({ message: proof.message }));
    session = (await sessions.session(sessions.cookie(session))).session;
    const handle = "Backend_Test_1", admissionNonce = keccak256(stringToHex("isolated-generative-admission"));
    const witness = async (nonce = admissionNonce, signal) => {
      const b = await client.getBlock();
      return gate.preflight({ block: { number: b.number, hash: b.hash }, handle: handle.toLowerCase(), recipient: account.address, nonce, signal });
    };
    let guarded = await bootAdmission(requests);
    const admissionEvents = [];
    const createWorker = requests => new PostgresAssessmentWorker(requests, { admission: guarded?.admission,
      timeoutMs: 30000, refreshEligibility: (_input, signal) => witness(admissionNonce, signal),
      identityResolver: new XApiIdentityResolver({ bearerToken: "offline-placeholder", fetch: async () => {
        lookupCalls++; return Response.json({ data: { id: "123", username: handle } });
      } }), provider: new GrokAssessmentProvider({ apiKey: "offline-placeholder", model: "grok-offline-test", fetch: async () => {
        providerCalls++; return Response.json({ id: "OFFLINE-NO-REAL-GROK-CALL", model: "grok-offline-test", status: "completed", error: null,
          incomplete_details: null, citations: [`https://x.com/${handle}`], usage: { cost_in_usd_ticks: 1 }, output: [
            { type: "x_search_call", id: "offline-search", status: "completed" }, { type: "message", role: "assistant", status: "completed",
              content: [{ type: "output_text", text: JSON.stringify({ handle: handle.toLowerCase(), mbti: "INTJ", xUserId: "123" }), annotations: [] }] }] });
      } }) });
    let journal = await PostgresGenerativeInputJournal.open(writer, ns.id, deploymentId);
    let issuer = await PostgresGenerativeAuthorizationIssuer.open(requests, journal);
    const signerAdapter = { address: signer.address, async signTypedData(data, signal) {
      signal.throwIfAborted(); signingCalls++; return signer.signTypedData(data);
    } };
    runtime = new DurableMintRuntime({ contractProfile, admission: guarded?.admission, sessions, requests, worker: createWorker(requests), journal, issuer, signer: signerAdapter,
      eligibility: (input, signal) => witness(input.nonce, signal), eligibilityTimeoutMs: 10000 });
    const deployment = { id: deploymentId, namespaceId: ns.id, chainId: "31337", contractAddress: config.contract.toLowerCase(),
      manifestHash: keccak256(stringToHex("isolated-generative-rehearsal-no-release-manifest")), deploymentBlock: String(collection.blockNumber), deploymentBlockHash: collection.blockHash,
      generativeRenderer: rendererPin, policy: { id: "local-finalized-tag-test", rollbackBlocks: 8, snapshotRetentionBlocks: 128 } };
    const projectionOptions = { deployment, config, rpcs, maxHeadLag: 0, maxFinalizedLag: 0, maxFinalizedAgeMs: 600000 };
    const siteConfig = () => ({ runtime, observation: projectionOptions, polling: { intervalMs: 5000, maxBackoffMs: 10000, passTimeoutMs: 10000 } });
    site = await createIsolatedGenerativeSite(siteConfig()); server = site.server; await guarded?.recheck?.(); await site.start();
    const call = async (path, body) => {
      const response = await fetch(origin + path, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { cookie: sessions.cookie(session).split(";")[0], ...(body ? { origin, "content-type": "application/json", "x-csrf-token": session.csrf } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.ok(response.ok, `Local API ${path} returned ${response.status}`); return response.json();
    };
    const request = await call("/api/assessments", { handle }); await runtime.idle();
    const status = await call(`/api/assessments/${request.code}`);
    assert.equal(status.status, "ready"); assert.equal(status.canMint, true); assert.equal(status.mbti, undefined);
    prepared = await journal.load(handle.toLowerCase());
    const base = { code: request.code, sessionToken: session.id, sessionGeneration: session.generation, origin, csrf: session.csrf, consent: true };
    const wireAuthorization = await call("/api/mints/authorize", { code: request.code, consent: true });
    const intent = async () => ({ ...base, eligibility: await witness(await issuer.preflightNonce(base)) });
    issued = await (guarded ? guarded.admission.issue(issuer, await intent(), signerAdapter) : issuer.issue(await intent(), signerAdapter));
    if (guarded) {
      // Exercise internal saved-assessment reuse before any chain mint. No new
      // provider execution; status remains redacted and no reroll is possible.
      const reused = await createWorker(requests).run({ ...base, eligibility: await witness() });
      assert.equal(reused.reused, true); assert.deepEqual(reused.assessment, prepared.assessment);
      admissionEvents.push(...guarded.events);
    }
    await site.close(); server = undefined;
    await writer.close(); writer = await ExclusiveWriter.acquire(factory);
    repository = await OpenMintRepository.open(writer, ns); requests = await PostgresMintRequests.open(repository, deploymentId);
    sessions = await PostgresWalletSessions.open({ writer, namespaceId: ns.id, origin, chainId: 31337 });
    journal = await PostgresGenerativeInputJournal.open(writer, ns.id, deploymentId); issuer = await PostgresGenerativeAuthorizationIssuer.open(requests, journal);
    guarded = await bootAdmission(requests);
    assert.deepEqual(await (guarded ? guarded.admission.issue(issuer, await intent(), signerAdapter) : issuer.issue(await intent(), signerAdapter)), issued);
    assert.equal(signingCalls, 1);
    const { assessment: _privateAssessment, ...inputs } = prepared;
    const b = await client.getBlock();
    const checked = await gate.verifyGenerativeAuthorization({ block: { number: b.number, hash: b.hash }, inputs,
      authorization: issued.reservation.authorization, signature: issued.signature });
    assert.equal(checked.authorizationDigest, generativeMintDigest(issued.reservation.domain, issued.reservation.authorization, profile.inputProfile));
    const data = await generativeMintCalldata({ domain: issued.reservation.domain, authorization: issued.reservation.authorization,
      inputs, signature: issued.signature, authorizer: signer.address });
    assert.equal(wireAuthorization.transaction.data, data);
    finalizedCeiling = (await client.getBlock()).number;
    runtime = new DurableMintRuntime({ contractProfile, admission: guarded?.admission, sessions, requests, worker: createWorker(requests), journal, issuer, signer: signerAdapter,
      eligibility: (input, signal) => witness(input.nonce, signal), eligibilityTimeoutMs: 10000 });
    site = await createIsolatedGenerativeSite(siteConfig()); server = site.server; await guarded?.recheck?.();
    const { browser, artwork, reads: coordinator } = site;
    let browserWalletSends = 0, browserBeginCalls = 0, browserReportCalls = 0;
    let collectionEntry;
    const browserEvidence = [];
    if (visualTool) {
      // Test-only wallet adapter, attached ONLY to this disposable listener.
      // No app route exposes a signer. Literal funded Anvil test account only.
      const secretPath = `/__isolated_test_${randomUUID()}`, cookie = sessions.cookie(session).split(";")[0];
      collectionEntry = secretPath + "/collection";
      const handler = server.listeners("request")[0]; server.removeListener("request", handler);
      server.on("request", async (req, res) => {
        if ((req.url === secretPath || req.url === collectionEntry) && req.method === "GET") {
          res.setHeader("Set-Cookie", sessions.cookie(session)); res.statusCode = 303; res.setHeader("Location", req.url === collectionEntry ? "/me" : `/mint/${request.code}`); res.end(); return;
        }
        if (req.headers.cookie?.includes(cookie) && req.url === "/assets/generative-wallet.js") {
          res.setHeader("Content-Type", "text/javascript"); res.setHeader("Cache-Control", "no-store");
          res.end(`sessionStorage.setItem('sg-open:wallet-provider',JSON.stringify('legacy:rabby'));
            window.ethereum={isRabby:true,on(){},removeListener(){},async request(input){const r=await fetch(${JSON.stringify(secretPath)},
              {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const v=await r.json();if(!r.ok)throw Error(v.error);return v.result;}};\n` + OPEN_MINT_CLIENT_SCRIPT); return;
        }
        if (req.url === secretPath && req.method === "POST") {
          try {
            assert.ok(req.headers.cookie?.includes(cookie)); assert.equal(req.headers.origin, origin);
            let raw = ""; for await (const chunk of req) { raw += chunk; assert.ok(raw.length < 16384); }
            const { method, params = [] } = JSON.parse(raw); let result;
            if (method === "eth_accounts" || method === "eth_requestAccounts") result = [account.address];
            else if (method === "eth_sendTransaction") {
              assert.equal(await client.getChainId(), 31337); assert.equal(browserWalletSends, 0);
              assert.deepEqual(params, [wireAuthorization.transaction]);
              assert.equal((await call(`/api/mints/status/${request.code}`)).state, "pending");
              browserWalletSends++;
              result = await wallet.sendTransaction({ to: config.contract, data, value: 0n, nonce: Number(BigInt(params[0].nonce)) });
              txReceipt = await client.waitForTransactionReceipt({ hash: result });
            } else {
              assert.ok(["eth_chainId", "eth_getCode", "eth_getBlockByNumber", "eth_getTransactionCount", "eth_call", "eth_getTransactionByHash", "eth_getTransactionReceipt"].includes(method));
              result = await client.request({ method, params });
            }
            res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ result }));
          } catch { res.statusCode = 500; res.end(JSON.stringify({ error: "Isolated test wallet rejected the operation." })); }
          return;
        }
        if (req.url === "/api/mints/begin") browserBeginCalls++;
        if (req.url === "/api/mints/report") browserReportCalls++;
        handler(req, res);
      });
      await site.start();
      const screenshot = new URL("../.local/generative-renderer/wallet-submitted-dark.png", import.meta.url).pathname;
      const { stdout } = await promisify(execFile)(process.execPath, [visualTool, "--url", origin + secretPath, "--viewport", "390x844", "--color-scheme", "dark",
        "--wait-for", "[data-submit-mint]:not(:disabled)", "--disable-cache", "--screenshot", screenshot, "--eval", `(async()=>{
          document.querySelector('[data-submit-mint]').click();
          const end=Date.now()+15000;while(Date.now()<end){
            const saved=JSON.parse(sessionStorage.getItem('sg-open:submission:${request.code}')||'null');
            if(saved?.hash){await new Promise(r=>setTimeout(r,200));return {hash:saved.hash,permitSaved:!!saved.permit,
              canSubmit:!!document.querySelector('[data-submit-mint]:not(:disabled)'),overflow:document.documentElement.scrollWidth>innerWidth};}
            await new Promise(r=>setTimeout(r,50));
          }throw Error('Test wallet did not submit');
        })()`], { timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
      const result = JSON.parse(stdout), v = result.evaluation;
      assert.equal(browserWalletSends, 1); assert.equal(browserBeginCalls, 1); assert.equal(browserReportCalls, 1);
      assert.equal(v.hash, txReceipt.transactionHash); assert.equal(v.permitSaved, true); assert.equal(v.canSubmit, false); assert.equal(v.overflow, false);
      assert.deepEqual(result.requests.filter(r => r.status >= 400), []);
      browserEvidence.push({ name: "real-browser-test-wallet", ...v, screenshot, simulatedWallet: true });
    } else {
      await site.start();
      const begun = await call("/api/mints/begin", { code: request.code, consent: true });
      assert.deepEqual(begun.transaction, wireAuthorization.transaction);
      txReceipt = await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: config.contract, data, value: 0n, nonce: Number(BigInt(begun.transaction.nonce)) }) });
      await call("/api/mints/report", { code: request.code, permit: begun.permit, transactionHash: txReceipt.transactionHash });
    }
    assert.equal(txReceipt.status, "success"); assert.ok(txReceipt.gasUsed < 350000n);
    // The lifecycle, not a test-side sync or a public GET, must observe the mint.
    const waitForProjection = async state => {
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        if ((await coordinator.lookup(inputs.canonicalHandle)).state === state && site.snapshot().observer.state === "waiting") return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail(`Automatic projection did not reach ${state}: ${JSON.stringify(site.snapshot())}`);
    };
    await waitForProjection("confirming");
    assert.equal((await call(`/api/mints/status/${request.code}`)).state, "confirming");
    const verifyPage = async (path, state, name, viewport, theme) => {
      await waitForProjection(state === "confirming" ? "confirming" : "confirmed");
      const response = await fetch(origin + path, { signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200); assert.equal(response.headers.get("set-cookie"), null);
      const html = await response.text();
      assert.ok(html.includes("Backend_Test_1")); assert.ok(!html.includes("OFFLINE-NO-REAL-GROK-CALL"));
      if (state) assert.ok(html.includes(`data-mint-state="${state}"`));
      if (!visualTool) return;
      const screenshot = new URL(`../.local/generative-renderer/${name}.png`, import.meta.url).pathname;
      const { stdout } = await promisify(execFile)(process.execPath, [visualTool, "--url", origin + path, "--viewport", viewport, "--color-scheme", theme,
        "--wait-for", ".signature-art img, .public-gallery-grid img", "--disable-cache", "--screenshot", screenshot, "--eval", `(async()=>{
          await document.fonts.ready;
          const images=[...document.querySelectorAll('.signature-art img, .public-gallery-grid img')];
          images.forEach(i=>{i.loading='eager'});
          await Promise.race([Promise.all(images.map(i=>i.decode().catch(()=>{}))),new Promise(r=>setTimeout(r,10000))]);
          await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          const first=images[0],svg=new DOMParser().parseFromString(await (await fetch(first.src)).text(),'image/svg+xml');
          const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1080;const ctx=canvas.getContext('2d');ctx.drawImage(first,0,0,1080,1080);
          let colored=0;const pixels=ctx.getImageData(0,0,1080,1080).data;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>150&&pixels[i+1]>100)colored++;
          return {imageCount:images.length,imagesLoaded:images.every(i=>i.complete&&i.naturalWidth>0),
            svgFill:svg.querySelector('path')?.getAttribute('fill'),coloredPixels:colored,
            overflow:document.documentElement.scrollWidth>innerWidth,
            state:document.querySelector('[data-mint-state]')?.dataset.mintState,
            badge:document.querySelector('[data-mint-state-label]')?.textContent,
            caption:[...document.querySelectorAll('.artwork-identity')].map(x=>x.textContent).join(' '),
            input:document.querySelector('[data-reveal-input]')?.dataset.revealInput};
        })()`], { timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
      const result = JSON.parse(stdout), v = result.evaluation;
      assert.ok(v.imageCount > 0 && v.imagesLoaded); assert.equal(v.overflow, false);
      assert.equal(v.svgFill, "#f4e7c7"); assert.ok(v.coloredPixels > 1000, "Actual decoded artwork must contain its light-colored ink.");
      assert.ok(v.caption.includes("@Backend_Test_1") && v.caption.includes("INTJ"));
      if (state) { assert.equal(v.state, state); assert.equal(v.badge, state === "confirming" ? "Confirming" : "Minted"); }
      if (state === "confirming") assert.equal(v.input, inputs.digest);
      assert.deepEqual(result.requests.filter(r => r.status >= 400), []);
      browserEvidence.push({ name, viewport, theme, ...v, screenshot });
    };
    const confirming = await artwork.detail(inputs.canonicalHandle, new AbortController().signal);
    assert.equal(confirming.mint.state, "confirming"); assert.equal(confirming.inputDigest, inputs.digest);
    assert.equal((await coordinator.gallery({ filter: { kind: "home" }, limit: 50 })).items.some(m => m.handle === inputs.canonicalHandle), false);
    await verifyPage(`/signatures/${inputs.canonicalHandle}`, "confirming", "confirming-dark", "1024x900", "dark");
    // Anvil's native finalized tag may lag by its configured epochs; advance
    // only this test adapter's explicit boundary, never the runtime policy.
    finalizedCeiling = txReceipt.blockNumber;
    await waitForProjection("confirmed");
    const gallery = await coordinator.gallery({ filter: { kind: "mbti", value: inputs.mbti }, limit: 50 });
    assert.ok(gallery.items.some(m => m.handle === inputs.canonicalHandle && m.renderHandle === handle));
    assert.equal((await artwork.detail(inputs.canonicalHandle, new AbortController().signal)).mint.state, "minted");
    await verifyPage(`/signatures/${inputs.canonicalHandle}`, "minted", "minted-light", "1024x900", "light");
    await verifyPage(`/${inputs.mbti}/`, undefined, "gallery-mobile-dark", "390x844", "dark");
    await verifyPage("/", undefined, "gallery-home-light", "1024x900", "light");
    const beforeBrowsing = { providerCalls, lookupCalls, signingCalls, browserWalletSends };
    const browse = async (path, cookie) => {
      const response = await fetch(origin + path, { redirect: "manual", headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: await response.text(), location: response.headers.get("location") };
    };
    await waitForProjection("confirmed");
    const variations = await browse(`/p/${handle}/variations`);
    assert.equal(variations.status, 200); assert.equal(variations.body.match(/class="open-preview-card"/g).length, 16);
    assert.equal(variations.body.match(/>Preview<\/span>/g).length, 15); assert.ok(variations.body.includes('data-preview-minted="INTJ"'));
    const alternative = await browse(`/p/${handle}/ENFP`); assert.equal(alternative.status, 200); assert.ok(alternative.body.includes("exploration only"));
    const alias = await browse(`/s/${handle}/ENFP`); assert.equal(alias.status, 308); assert.equal(alias.location, `/p/${handle}/ENFP`);
    const collectionPage = await browse("/me", sessions.cookie(session).split(";")[0]);
    assert.equal(collectionPage.status, 200); assert.ok(collectionPage.body.includes(handle)); assert.ok(collectionPage.body.includes(account.address));
    const ownedCount = collectionPage.body.match(/class="gallery-card"/g).length;
    const signedOut = await browse("/me"); assert.equal(signedOut.status, 200); assert.ok(!signedOut.body.includes(handle)); assert.ok(signedOut.body.includes("Connect your wallet"));
    const about = await browse("/about"); assert.equal(about.status, 200); assert.ok(about.body.includes("immutable inputs"));
    const noMint = await browse("/p/No_Token_Yet/variations");
    assert.equal(noMint.status, 200); assert.ok(noMint.body.includes('data-preview-mint-state="unavailable"')); assert.ok(!noMint.body.includes("Mint for this handle"));
    if (visualTool) {
      for (const [path, name, viewport, theme, count] of [[`/p/${handle}/variations`, "variations-mobile-dark", "390x844", "dark", 16],
        [`/p/${handle}/ENFP`, "preview-light", "1024x900", "light", 1], [collectionEntry, "collection-mobile-dark", "390x844", "dark", ownedCount],
        ["/about", "about-light", "1024x900", "light", 0]]) {
        await waitForProjection("confirmed");
        const screenshot = new URL(`../.local/generative-renderer/${name}.png`, import.meta.url).pathname;
        const { stdout } = await promisify(execFile)(process.execPath, [visualTool, "--url", origin + path, "--viewport", viewport, "--color-scheme", theme,
          "--wait-for", count ? "main img" : ".about-page", "--disable-cache", "--screenshot", screenshot, "--eval", `(async()=>{
            await document.fonts.ready;const images=[...document.querySelectorAll('main img')];images.forEach(i=>i.loading='eager');
            await Promise.all(images.map(i=>i.decode()));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
            return {imageCount:images.length,imagesLoaded:images.every(i=>i.naturalWidth>0),overflow:document.documentElement.scrollWidth>innerWidth,
              previewTags:document.querySelectorAll('.artwork-status').length,
              mintedTiles:document.querySelectorAll('[data-preview-minted]').length,
              brokenLinks:[...document.querySelectorAll('a')].filter(a=>a.getAttribute('href')==='#').length};})()`], { timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
        const result = JSON.parse(stdout), v = result.evaluation;
        assert.equal(v.imageCount, count); assert.equal(v.imagesLoaded, true); assert.equal(v.overflow, false); assert.equal(v.brokenLinks, 0);
        if (count === 16) { assert.equal(v.previewTags, 16); assert.equal(v.mintedTiles, 1); }
        assert.deepEqual(result.requests.filter(r => r.status >= 400), []); browserEvidence.push({ name, viewport, theme, ...v, screenshot });
      }
    }
    assert.deepEqual({ providerCalls, lookupCalls, signingCalls, browserWalletSends }, beforeBrowsing, "Browsing must not assess, sign, or send a transaction.");
    const media = await fetch(`${origin}/api/signatures/${inputs.canonicalHandle}/artwork/${inputs.digest}/svg`);
    assert.equal(media.status, 200); assert.equal(await media.text(), expectedSvg(handle, inputs.mbti));
    if (guarded) {
      admissionEvents.push(...guarded.events);
      if (!reviewFiles) for (const op of ["assessment:assessment-x", "assessment:assessment-grok", "assessment:reuse", "mint:sign", "mint:reuse", "mint:wallet-submit"]) assert.ok(admissionEvents.includes(op), `Missing guarded phase: ${op}`);
    }
    projectionEvidence = { confirmingBeforeFinality: true, galleryOnlyAfterFinality: true, restrictedRuntimeRole: true,
      guardedAdmission: !!guarded, guardedOperations: reviewFiles ? undefined : [...new Set(admissionEvents)], signedReviewIsTestFixture: !!guarded,
      fileBackedReview: reviewFiles, fileReviewStartupPasses: startups.length,
      httpPreparationAndAuthorization: true, durableWalletSubmission: true, browserWalletSends, browserBeginCalls, browserReportCalls,
      readOnlyHtmlAndMedia: true, automaticObservation: true, fullSiteNavigation: true, walletCollection: true, freePreviews: true,
      browserEvidence, testAdapterSimulatedFinalizedLag: true };
    await site.close(); assert.equal((await coordinator.lookup(inputs.canonicalHandle)).state, "unknown");
    assert.equal(site.snapshot().phase, "closed");
  } finally {
    await site?.close();
    await runtime?.drain();
    for (const startup of startups) startup.halt();
    await writer?.close(); await admin?.end(); cluster.stop();
    for (const files of reviewRoots) files.remove();
  }
  // Database is now gone. Recovery must not need private assessment/input rows,
  // original signer, local renderer, publication server, or provider credentials.
  const saved = await createGenerativeArtworkReader({ config, rpcs })(prepared.canonicalHandle,
    { number: txReceipt.blockNumber, hash: txReceipt.blockHash }, new AbortController().signal);
  assert.equal(saved.svg, expectedSvg(prepared.renderHandle, prepared.mbti));
  assert.equal(saved.authorizationDigest, issued.reservation.digest);
  assert.equal(saved.owner, account.address.toLowerCase());
  assert.equal(providerCalls, 1); assert.equal(lookupCalls, 1);
  return { passed: true, contractProfile, inputProfile: profile.inputProfile, mockedProviderCalls: providerCalls, mockedIdentityLookups: lookupCalls, realProviderCalls: 0, signingCalls,
    writerRestartReuse: true, databaseRemovedBeforeRecovery: true, chainOnlySvgExact: true, publicTransactions: 0,
    mintGas: String(txReceipt.gasUsed), receiptHash: txReceipt.transactionHash, separatePublicRpcProvidersValidated: false, projection: projectionEvidence };
}
