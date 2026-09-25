import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ROOT } from "./generative-release.mjs";
import { stagingRuntimeBinding } from "./generative-staging-assessment.mjs";
import { createStagingRuntime, stagingNetworkBinding } from "./generative-staging-runtime.mjs";
import { createStagingRuntimeApiServer, createInstalledStagingRuntimeApiServer } from "./generative-staging-http.mjs";
import { OpenMintProjection } from "../../src/openMint/projection/postgres.ts";
import { createStagingProjectionCoordinator } from "../../src/openMint/projection/coordinator.ts";
import { createProjectionPoller } from "../../src/openMint/projection/poller.ts";
import { createStagingGenerativeArtworkReads } from "../../src/openMint/projection/generativeArtwork.ts";
import { createProjectionReadHandler } from "../../src/openMint/projection/http.ts";
import { createGenerativeSitePages } from "../../src/openMint/persistence/generativeSitePages.ts";
import { assessmentPage, mintPage } from "../../src/openMint/pages.ts";
import { OPEN_MINT_CLIENT_SCRIPT } from "../../src/openMint/clientScript.ts";
import { handleDigest, preservedHandle } from "../../src/openMint/identity.ts";
import { PublicError } from "../../src/openMint/security.ts";
import { closeHttpServer } from "../../src/openMint/shutdown.ts";
import { createStagingGenerativeSharing, createGenerativeSharingHandler } from "../../src/openMint/generativeSharing.ts";
import { openMintSupportUrl } from "../../src/openMint/supportUrl.ts";
import canonicalize from "canonicalize";
import { checkStagingInstallation, readFileBounded } from "./generative-staging-bootstrap.mjs";
import { loadStagingInstallation } from "./generative-staging-installation.mjs";

/** Initially unlistened LOOPBACK composition, not public staging startup. Builds
 * its own observer/readers from the runtime's exact pins and captured sources;
 * no caller-supplied projection, inclusion flag or reported hash can reveal.
 * start(port, signal) owns a bounded read-only observer and listener; manual
 * sync/listen remains available to offline harnesses before lifecycle startup.
 * No environment/key discovery, migration, deployment or effect retries. */
async function composeStagingSite(input, dependencies, root, now, configuredSupportUrl, installedCheck) {
  let runtime, coordinator;
  try {
    const installed = !!installedCheck;
    if (!installed) assert.notEqual(process.env.NODE_ENV, "production");
    const supportUrl = openMintSupportUrl(configuredSupportUrl);
    const binding = stagingRuntimeBinding(input, root), { d, s, requests, db } = binding, sessions = dependencies.sessions;
    runtime = createStagingRuntime(input, dependencies, root, now);
    const { config, sources } = stagingNetworkBinding(binding, input.sources);
    const deployment = { id: db.deploymentId, namespaceId: db.namespaceId, chainId: "11155111", contractAddress: config.contract.toLowerCase(),
      manifestHash: `0x${d.planSha256}`, deploymentBlock: String(config.deploymentBlock.number), deploymentBlockHash: config.deploymentBlock.hash,
      generativeRenderer: config.generativeRenderer,
      policy: { id: "sepolia-rc1-canonical-finalized-v1", rollbackBlocks: 128, snapshotRetentionBlocks: 8192 } };
    await runtime.check();
    const projection = await (installed ? OpenMintProjection.openExisting : OpenMintProjection.open)(requests.repository.writer, deployment);
    coordinator = createStagingProjectionCoordinator(projection, { deployment, config, rpcs: sources,
      maxHeadLag: 0, maxFinalizedLag: 0, maxFinalizedAgeMs: s.rpc.maxFinalizedAgeMs });
    const stop = new AbortController(); let closing, syncing, startupWork, parent, cancel;
    let phase = "idle", failed = false;
    const live = () => { stop.signal.throwIfAborted(); runtime.assertHealthy(); };
    const intervalMs = Math.max(250, Math.min(5000, Math.floor(s.rpc.evidenceTtlMs / 2)));
    const poller = createProjectionPoller({ sync: observe, withdraw() {
      coordinator.withdraw();
      // A timed-out/uncooperative pass, overlap or finality contradiction must
      // stop admission too. Never leave a listener issuing new work behind a
      // dead observer. Transient unavailable observations only back off.
      if (["failed", "safety-halted"].includes(poller.snapshot().state)) {
        failed = true; void close().catch(() => {});
      }
    } }, { intervalMs, initialDelayMs: intervalMs, maxBackoffMs: 30000, passTimeoutMs: s.hosting.requestTimeoutMs });
    const reads = Object.freeze({
      async lookup(handle) { try { live(); const result = await coordinator.lookup(handle); live(); return result; } catch { return { state: "unknown" }; } },
      async gallery(value) { live(); const result = await coordinator.gallery(value); live(); return result; },
    });
    const artwork = createStagingGenerativeArtworkReads({ config, rpcs: sources, projection: reads, timeoutMs: s.rpc.timeoutMs,
      provenance: { timeoutMs: Math.min(1000, s.rpc.timeoutMs), loadAccepted: requests.repository.getAcceptedAssessment.bind(requests.repository) } });
    const sharing = createStagingGenerativeSharing({ origin: s.origin, deployment }), sharingRead = createGenerativeSharingHandler(artwork);
    const options = { stylesheetUrl: "/assets/generative-gallery.css", clientScriptUrl: "/assets/generative-wallet.js", publicOrigin: s.origin,
      chainId: "11155111", chainName: "Ethereum Sepolia", contract: config.contract, durableWalletSubmission: true, generativeArtwork: true,
      ...(supportUrl ? { supportUrl } : {}) };
    const publicPages = createGenerativeSitePages({ projection: reads, artwork, pageOptions: options, sharing,
      runtime: { sessions, requests,
        sessionView(session) { live(); return { wallet: session.wallet, walletVerified: !!session.wallet && session.expiresAt > now()
          && session.walletProof?.wallet === session.wallet && session.walletProof.expiresAt > now() && !session.walletProof.codeHash }; } } });
    async function status(code, cookie, signal) {
      const saved = await runtime.status(code, cookie, signal), result = await reads.lookup(saved.handle), item = result.item;
      // A token for this handle may have been minted by someone else. Report
      // canonical token state, never claim that the caller's hash succeeded.
      if (["confirmed", "confirming"].includes(result.state) && item && item.handle === saved.handle && item.inclusion && item.inputDigest
        && item.tokenId === BigInt(handleDigest(saved.handle)).toString() && /^0x[0-9a-f]{64}$/.test(item.transactionHash ?? "")
        && item.rendererIdentity === config.generativeRenderer.identity && item.availability !== "quarantined" && !item.artifactDigest && !item.tokenURIHash) {
        // Recheck request ownership/session expiry after awaiting projection.
        const current = await runtime.status(code, cookie, signal); live();
        const next = await reads.lookup(saved.handle);
        if (JSON.stringify(next) === JSON.stringify(result)) return { ...current, canMint: false,
          mint: { state: result.state === "confirmed" ? "minted" : "confirming", transactionHash: item.transactionHash, submissionBlocked: true } };
      }
      return saved;
    }
    // A navigation may overlap the outgoing page's final poll. Do not strand
    // the browser on raw BUSY JSON for this short-lived read-only contention.
    // Retry ONLY pre-operation BUSY rejection; never a POST, provider, signing
    // operation, failed result or arbitrary service error. Keep abort/deadline.
    async function pageRead(read, signal) {
      const deadline = performance.now() + 1000;
      for (;;) {
        live(); signal.throwIfAborted();
        try { return await read(); }
        catch (error) {
          if (!(error instanceof PublicError) || error.code !== "BUSY" || performance.now() >= deadline) throw error;
          await delay(25, undefined, { signal });
        }
      }
    }
    async function page(req, res) {
      live();
      const raw = req.url ?? "", url = new URL(raw, s.origin), match = /^\/mint\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
      if (url.pathname !== "/mint" && !match && raw !== "/assets/generative-wallet.js") return publicPages(req, res);
      if (req.method !== "GET" || raw.split("?")[0] !== url.pathname || raw.length > 4096 || raw.includes("#") || req.headers["transfer-encoding"]
        || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) throw new PublicError(400, "INVALID_REQUEST", "Invalid page request.");
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      if (raw === "/assets/generative-wallet.js") { res.setHeader("Content-Type", "text/javascript; charset=utf-8"); res.end(OPEN_MINT_CLIENT_SCRIPT); return true; }
      const controller = new AbortController(), cancel = () => controller.abort(); res.once("close", cancel);
      try {
        let html;
        if (match) {
          if (url.search) throw new PublicError(400, "INVALID_REQUEST", "Mint progress accepts no parameters.");
          const model = await pageRead(() => status(match[1], req.headers.cookie, controller.signal), controller.signal);
          if (["minted", "confirming"].includes(model.mint.state)) {
            res.statusCode = 303; res.setHeader("Location", `/signatures/${model.handle}`); res.end(); return true;
          }
          html = assessmentPage({ ...model, status: model.status === "preparing" ? "pending" : model.status },
            { ...options, wallet: model.wallet, walletVerified: model.walletProvedForCode });
        } else {
          if ([...url.searchParams.keys()].some(k => k !== "handle") || url.searchParams.getAll("handle").length > 1) throw new PublicError(400, "INVALID_REQUEST", "Choose one handle.");
          const handle = url.searchParams.get("handle") ?? "";
          try { if (handle) preservedHandle(handle); } catch { throw new PublicError(400, "INVALID_HANDLE", "Enter a valid X handle."); }
          const session = await pageRead(() => runtime.session(req.headers.cookie, controller.signal), controller.signal);
          if (session.cookie) res.setHeader("Set-Cookie", session.cookie);
          html = mintPage(handle, { ...options, wallet: session.wallet, walletVerified: session.walletVerified });
        }
        live(); res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); return true;
      } finally { controller.abort(); res.removeListener("close", cancel); }
    }
    const projectionRead = createProjectionReadHandler(reads, artwork);
    const httpView = { read: async (req, res) => await sharingRead(req, res) || projectionRead(req, res), page, status };
    const server = installed ? createInstalledStagingRuntimeApiServer(runtime, httpView, installedCheck, root)
      : createStagingRuntimeApiServer(runtime, httpView);
    async function observe(signal = new AbortController().signal) {
      live(); if (syncing) return "busy";
      const combined = AbortSignal.any([signal, stop.signal]);
      const work = (async () => {
        coordinator.withdraw();
        try { await runtime.check(combined); live(); const result = await coordinator.sync(combined);
          // Terminal evidence grants nothing. Stop owned admission immediately,
          // not after waiting behind another post-pass database certification.
          if (result === "safety-halted" || result === "writer-unavailable") {
            if (phase !== "idle") runtime.halt();
            return result;
          }
          await runtime.check(combined); live(); combined.throwIfAborted(); return result; }
        catch { coordinator.withdraw(); return "unavailable"; }
      })();
      syncing = work; try { return await work; } finally { if (syncing === work) syncing = undefined; }
    }
    function close() {
      if (closing) return closing;
      phase = "closing";
      parent?.removeEventListener("abort", cancel);
      stop.abort(); poller.stop(); coordinator.withdraw(); runtime.halt();
      closing = (async () => {
        let timer;
        try {
          await Promise.race([Promise.all([closeHttpServer(server), runtime.close(), syncing, poller.drain(), artwork.drain(), sharingRead.drain(), startupWork?.catch(() => {})]),
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Site drain incomplete; retain writer ownership.")), s.hosting.drainTimeoutMs); })]);
          phase = failed ? "failed" : "closed";
        } catch (error) { phase = "failed"; throw error;
        } finally { clearTimeout(timer); }
      })();
      return closing;
    }
    server.once("close", () => { void close().catch(() => {}); });
    return Object.freeze({ server, close, idle: runtime.idle, reads, artwork,
      snapshot: () => Object.freeze({ phase, observer: poller.snapshot() }),
      async start(port, signal = new AbortController().signal) {
        // No caller-controlled host/TLS/proxy setting or environment fallback.
        // Port zero is for disposable rehearsals; every listener is loopback.
        live();
        if (phase !== "idle" || syncing || server.listening) throw Error("Staging site is single-use; manual observation/listening is already active.");
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || !(signal instanceof AbortSignal)) throw Error("Invalid loopback startup configuration.");
        phase = "starting"; parent = signal;
        const expires = performance.now() + s.hosting.requestTimeoutMs;
        const current = () => { live(); signal.throwIfAborted(); if (performance.now() >= expires) throw Error("Startup deadline."); };
        cancel = () => { void close().catch(() => {}); };
        parent.addEventListener("abort", cancel, { once: true });
        startupWork = (async () => {
          signal.throwIfAborted();
          if (process.env.NODE_ENV === "production" && !installed) throw Error("Public startup remains disabled.");
          if (await observe(AbortSignal.any([signal, stop.signal])) !== "observed") throw Error("Startup observation unavailable.");
          current();
          const listening = once(server, "listening", { signal: stop.signal });
          server.listen({ host: "127.0.0.1", port, signal: stop.signal }); await listening;
          current();
          poller.start(stop.signal); phase = "running";
        })();
        let timer;
        try { await Promise.race([startupWork, new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Startup deadline.")), s.hosting.requestTimeoutMs);
        })]); }
        catch { failed = true; await close(); throw Error("Private staging site could not start."); }
        finally { clearTimeout(timer); }
      },
      async sync(signal) { live(); if (phase !== "idle") throw Error("Observation is owned by the site lifecycle."); return observe(signal); },
    });
  } catch { coordinator?.withdraw(); await runtime?.close(); throw Error("Private staging site unavailable."); }
}

export function createStagingSite(input, dependencies, root = ROOT, now = Date.now, configuredSupportUrl) {
  if (process.env.NODE_ENV === "production") return Promise.reject(Error("Private staging site unavailable."));
  return composeStagingSite(input, dependencies, root, now, configuredSupportUrl);
}

/** The only installed production composition. Rechecks the independently
 * supplied package/config pins and exact immutable inputs; it is not an
 * allowProduction switch. Runtime review and DB/chain checks remain required. */
export async function createInstalledStagingSite(check, input, dependencies, root, now = Date.now) {
  try {
    assert.equal(process.env.NODE_ENV, "production");
    const checked = checkStagingInstallation(check, root), installation = loadStagingInstallation(check.configPath, check.configSha256, root);
    assert.equal(checked.configSha256, installation.configSha256);
    assert.equal(input.operatingJson, new TextDecoder("utf-8", { fatal: true }).decode(
      readFileBounded(installation.config.operating.path, installation.config.operating.maxBytes, installation.config.operating.sha256)));
    for (const field of ["transactions", "transitions", "historyLimits", "assessmentPolicy", "databaseReview"])
      assert.equal(canonicalize(input[field]), canonicalize(installation.evidence[field]));
    assert.equal(input.reviewSource.publicKeySpkiSha256, installation.config.reviews.operation.publicKeySpkiSha256);
    assert.equal(input.reviewSource.revisionSha256, installation.config.reviews.operation.revisionSha256);
    return await composeStagingSite(input, dependencies, root, now, installation.config.supportUrl ?? undefined, check);
  } catch { throw Error("Installed staging site unavailable."); }
}
