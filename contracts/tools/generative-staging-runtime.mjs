import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { getAddress } from "viem";
import { ROOT } from "./generative-release.mjs";
import { stagingRuntimeBinding } from "./generative-staging-assessment.mjs";
import { createStagingAssessmentWorker } from "./generative-staging-worker.mjs";
import { createStagingMintController } from "./generative-staging-mint.mjs";
import { createStagingEligibilityReader } from "../../src/openMint/publicChain.ts";
import { createStagingWalletChain } from "../../src/openMint/walletChain.ts";
import { certifyStagingMintBinding } from "../../src/openMint/persistence/stagingMintAdmission.ts";
import { PostgresWalletSessions, capabilityHash } from "../../src/openMint/persistence/sessions.ts";
import { createStagingOperationReview } from "../../src/openMint/staging/stagingReview.ts";
import { admissionDigest } from "../../src/openMint/staging/admission.ts";
import { canonicalHandle, preservedHandle, handleDigest } from "../../src/openMint/identity.ts";
import { isCode, PublicError } from "../../src/openMint/security.ts";

const runtimes = new WeakSet();
export const isStagingRuntime = value => runtimes.has(value);
const context = v => ({ sessionToken: v.session.id, sessionGeneration: v.session.generation, origin: v.origin, csrf: v.csrf });
const proof = (s, now, code) => !!s.wallet && s.walletProof?.wallet === s.wallet && s.expiresAt > now && s.walletProof.expiresAt > now
  && (!s.walletProof.codeHash || (code && s.walletProof.codeHash === capabilityHash(code)));
const parseCode = code => { if (!isCode(code)) throw new PublicError(404, "NOT_FOUND", "Signature request not found."); return code; };
const busy = () => { throw new PublicError(503, "BUSY", "Another operation is in progress. Saved work is preserved."); };
const nonce = () => `0x${randomBytes(32).toString("hex")}`;

/** Pure pins shared by the private runtime and its read-only site composition.
 * Call only with stagingRuntimeBinding's validated result. */
export function stagingNetworkBinding({ d, p, s, requests, db }, transports) {
  const sources = transports.map(r => Object.freeze({ id: `staging-${admissionDigest(r.id)}`, request: r.request.bind(r) }));
  const config = { namespaceId: db.namespaceId, deploymentId: db.deploymentId, chainId: 11155111n, contractProfile: "generative-v1-rc1",
    contract: d.collection.address, genesisHash: requests.profile.genesis_hash, runtimeCodeHash: p.collectionRuntimeCodeHash,
    authorizer: s.custody.authorizer.address, deploymentBlock: { number: BigInt(requests.profile.deployment_block), hash: requests.profile.deployment_block_hash },
    maxBlockAgeMs: s.rpc.maxHeadAgeMs, maxFutureSkewMs: s.rpc.maxFutureSkewMs, evidenceTtlMs: s.rpc.evidenceTtlMs, observationTimeoutMs: s.rpc.timeoutMs,
    generativeRenderer: { address: d.renderer.address, runtimeCodeHash: d.renderer.runtimeCodeHash, identity: d.renderer.identity, inputProfile: d.inputProfile } };
  return { config, sources };
}

/** Private future-staging runtime. No startup, key/env discovery, broadcast,
 * projection/reveal claim, paid retry or restart queue. Server installs exact
 * transports once; clients supply only handles, consent and wallet reports. */
export function createStagingRuntime(input, dependencies, root = ROOT, now = Date.now) {
  let worker, mint, review;
  try {
    assert.ok(dependencies && Object.getPrototypeOf(dependencies) === Object.prototype);
    assert.deepEqual(Reflect.ownKeys(dependencies).sort(), ["identityResolver", "provider", "sessions", "signer"].sort());
    for (const d of Object.values(Object.getOwnPropertyDescriptors(dependencies))) assert.ok(d.enumerable && "value" in d);
    const { d, p, s, requests, db, binding, observeDatabase } = stagingRuntimeBinding(input, root), { sessions } = dependencies;
    assert.ok(sessions instanceof PostgresWalletSessions);
    assert.equal(sessions.writer, requests.repository.writer); assert.equal(sessions.namespaceId, requests.repository.namespace.id);
    assert.equal(sessions.origin, s.origin); assert.equal(sessions.chainId, 11155111);
    assert.equal(sessions.cookiePolicy.name, s.session.cookieName); assert.equal(sessions.cookiePolicy.sameSite.toLowerCase(), s.session.sameSite);
    assert.equal(getAddress(dependencies.signer.address), getAddress(requests.profile.authorizer));
    const signer = Object.freeze({ address: dependencies.signer.address, signTypedData: dependencies.signer.signTypedData.bind(dependencies.signer) });
    // Operating-plan references may contain '/'; the read-only witness uses
    // bounded labels. Hashing preserves distinct pinned source identities.
    const { config: networkConfig, sources } = stagingNetworkBinding({ d, p, s, requests, db }, input.sources);
    const chain = createStagingWalletChain(networkConfig, sources), eligibility = createStagingEligibilityReader(networkConfig, sources, now);
    const stop = new AbortController(), pendingWork = new Set(), deadlines = new WeakMap(); let running, checking, preparation;
    const live = signal => {
      if (deadlines.has(signal) && performance.now() >= deadlines.get(signal)) halt();
      stop.signal.throwIfAborted(); signal.throwIfAborted(); requests.repository.writer.assertHealthy();
    };
    async function observe(handle, recipient, authorizationNonce, signal) {
      live(signal); const head = await chain.read(undefined, signal); live(signal);
      const result = await eligibility.preflight({ block: { number: BigInt(head.blockNumber), hash: head.blockHash }, handle, recipient, nonce: authorizationNonce, signal });
      live(signal); return result;
    }
    const configured = [dependencies.provider, dependencies.identityResolver].filter(v => v !== undefined).length;
    assert.ok(configured === 0 || configured === 2);
    worker = createStagingAssessmentWorker(input, configured ? { provider: dependencies.provider, identityResolver: dependencies.identityResolver,
      refreshEligibility: (value, signal) => observe(value.handle, value.recipient, nonce(), signal) } : {}, root, now);
    mint = createStagingMintController(input, root, now);
    assert.equal(worker.scopeSha256, mint.scopeSha256);
    review = createStagingOperationReview(input.reviewSource, mint.scope);
    const certification = Object.freeze({ review: db, databaseBindingSha256: binding, scopeSha256: mint.scopeSha256,
      leaseMs: mint.scope.permitTtlMs, assertProfiles: observeDatabase });
    async function guard(tx, signal, generation = false) {
      if (generation && !configured) throw new PublicError(503, "GENERATION_NOT_CONFIGURED", "New assessments are unavailable. Saved work is preserved.");
      const check = () => { live(signal); review.requireReview(mint.scopeSha256, generation ? "assessment-x" : "reuse", now()); };
      check(); await certifyStagingMintBinding(tx, requests, certification, signal, false); check();
    }
    const certify = signal => requests.repository.writer.transaction(tx => guard(tx, signal));
    const halt = () => { stop.abort(); worker.halt(); mint.halt(); review.halt(); };
    // One API operation, one read-only owner certification, and one explicitly
    // scheduled assessment. Certification shares the fenced writer's serial
    // transactions, not the API slot: observer checks cannot reject wallet
    // requests as BUSY. No effects move to this lane; neither lane is a retry
    // queue. A deadline in either lane quarantines the entire instance.
    async function run(work, signal = new AbortController().signal, checkOnly = false) {
      live(signal); if (checkOnly ? checking : running) busy();
      const combined = AbortSignal.any([signal, stop.signal]); let timer;
      deadlines.set(combined, performance.now() + s.hosting.requestTimeoutMs);
      const pending = (async () => {
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => { halt(); reject(new Error("Staging runtime deadline.")); }, s.hosting.requestTimeoutMs); });
        const workPromise = (async () => {
          await certify(combined); live(combined); const result = await work(combined); live(combined); return result;
        })();
        pendingWork.add(workPromise);
        try { return await Promise.race([workPromise, deadline]); } finally {
          clearTimeout(timer); workPromise.then(() => pendingWork.delete(workPromise), () => pendingWork.delete(workPromise));
        }
      })();
      if (checkOnly) checking = pending; else running = pending;
      try { return await pending; } finally {
        if (checkOnly) { if (checking === pending) checking = undefined; }
        else if (running === pending) running = undefined;
      }
    }
    const view = session => ({ csrfToken: session.csrf, wallet: session.wallet ?? null, walletVerified: !!proof(session, now()),
      walletProofExpiresAt: session.walletProof?.expiresAt, serverNow: now(), chainId: "11155111", chainName: "Ethereum Sepolia" });
    async function post(auth, signal) {
      live(signal); const session = await sessions.requireSession(auth.cookie);
      await sessions.authorizePost(session.id, auth.origin, auth.csrf); live(signal);
      return { session, origin: auth.origin, csrf: auth.csrf };
    }
    async function prepare(code, consent, intent, signal) {
      if (consent !== true) throw new PublicError(400, "CONSENT_REQUIRED", "Choose Mint & reveal to continue.");
      parseCode(code);
      if ((await mint.submissionState(code, intent.session.id, signal)).blocked) throw new PublicError(409, "SUBMISSION_UNRESOLVED", "Check the existing wallet submission. No new transaction was prepared.");
      const request = await requests.get(code, intent.session.id), captured = { ...context(intent), code, consent: true };
      const authorizationNonce = await mint.preflightNonce(captured, signal);
      await mint.issue({ ...captured, eligibility: await observe(request.handle, request.wallet, authorizationNonce, signal) }, signer, signal);
      // Refresh after signing, then bind the plan to backend-verified EOA nonce.
      const value = { ...captured, eligibility: await observe(request.handle, request.wallet, authorizationNonce, signal) };
      const network = await chain.read(request.wallet, signal); live(signal);
      const plan = await mint.stageWallet(value, intent, network, signal);
      return { request, captured, authorizationNonce, network, plan };
    }
    const runtime = Object.freeze({ origin: s.origin, timeoutMs: s.hosting.requestTimeoutMs, scope: mint.scope, scopeSha256: mint.scopeSha256,
      transport: Object.freeze({ origin: s.origin, tlsMode: s.hosting.tlsMode, trustedProxyHops: s.hosting.trustedProxyHops,
        maxRequestBytes: Math.min(8192, s.hosting.maxRequestBytes), requestTimeoutMs: s.hosting.requestTimeoutMs }),
      expiredSessionCookie: sessions.clearCookie(),
      halt,
      async close() { halt(); await Promise.allSettled([...pendingWork, preparation?.task]); await Promise.all([worker.close(), mint.close()]); },
      async idle() { await preparation?.task; },
      check(signal) { return run(async () => undefined, signal, true); },
      assertHealthy() { live(stop.signal); },
      session(cookie, signal) { return run(async s => { const found = await sessions.session(cookie); live(s);
        return { ...view(found.session), ...(found.created ? { cookie: sessions.cookie(found.session) } : {}) }; }, signal); },
      challenge(address, code, auth, signal) { return run(async s => { const intent = await post(auth, s);
        if (code !== undefined) await requests.get(parseCode(code), intent.session.id);
        return sessions.challenge(intent.session.id, address, code); }, signal); },
      verify(challengeId, signature, auth, signal) { return run(async s => { const intent = await post(auth, s);
        await sessions.verify(intent.session.id, challengeId, signature); live(s); return view(await sessions.requireSession(auth.cookie)); }, signal); },
      logout(auth, signal) { return run(async s => { const intent = await post(auth, s); await sessions.logout(intent.session.id); return { ok: true }; }, signal); },
      create(value, auth, signal) { return run(async s => {
        const intent = await post(auth, s); let handle;
        try { handle = preservedHandle(value); } catch { throw new PublicError(400, "INVALID_HANDLE", "Enter a valid X handle."); }
        if (!proof(intent.session, now())) throw new PublicError(403, "WALLET_PROOF_REQUIRED", "Connect your wallet before preparing a mint.");
        if (preparation) busy();
        const captured = context(intent), witness = await observe(canonicalHandle(handle), intent.session.wallet, nonce(), s);
        const request = await requests.createGuardedStaging({ ...captured, recipient: intent.session.wallet, handle, eligibility: witness },
          (tx, generation) => guard(tx, s, generation));
        live(s);
        if (["pending-assessment", "assessment-accepted"].includes(request.status)) {
          const owned = { handle: request.handle, task: undefined };
          // The explicit POST schedules exactly one bounded run. Reads and
          // process startup never recover/retry an incomplete paid attempt.
          owned.task = Promise.resolve().then(() => worker.run({ ...captured, code: request.code, eligibility: witness }, stop.signal))
            .catch(() => {}).finally(() => { if (preparation === owned) preparation = undefined; });
          preparation = owned;
        }
        return { code: request.code, handle: request.handle, tokenId: BigInt(handleDigest(request.handle)).toString(), url: `/mint/${request.code}`, status: "preparing" };
      }, signal); },
      status(code, cookie, signal) { return run(async s => {
        const session = await sessions.requireSession(cookie), request = await requests.get(parseCode(code), session.id), time = now();
        const saved = await mint.submissionState(code, session.id, s), active = preparation?.handle === request.handle;
        const ready = request.status === "assessment-accepted", failed = !ready && (!active || request.status !== "pending-assessment");
        // Explicit public allowlist: no MBTI, assessment, source payloads,
        // authorization or permit. A wallet report is NOT inclusion/reveal.
        return { code, handle: request.handle, renderHandle: request.requestedHandle, tokenId: BigInt(handleDigest(request.handle)).toString(),
          requestExpiresAt: request.expiresAt, requestExpired: request.expiresAt <= time, status: ready ? "ready" : request.status === "assessment-abstained" ? "abstained" : failed ? "failed" : "preparing",
          canMint: ready && request.expiresAt > time && !!proof(session, time, code) && !saved.blocked, preparationActive: !!active,
          wallet: session.wallet, walletProvedForCode: !!proof(session, time, code), walletProofExpiresAt: session.walletProof?.expiresAt,
          diagnosticReference: request.attemptId, serverNow: time,
          ...(failed ? { error: "This preparation needs operator review. No assessment will be retried automatically." } : {}),
          mint: { state: saved.blocked ? "pending" : "unknown", submissionBlocked: saved.blocked, submissionUncertain: saved.blocked && !saved.transactionHash,
            ...(saved.transactionHash ? { transactionHash: saved.transactionHash } : {}) } };
      }, signal); },
      walletContext(address, cookie, signal) { return run(async s => { await sessions.requireSession(cookie); return chain.read(address, s); }, signal); },
      authorize(code, consent, auth, signal) { return run(async s => {
        const prepared = await prepare(code, consent, await post(auth, s), s);
        return { code, handle: prepared.request.handle, tokenId: BigInt(handleDigest(prepared.request.handle)).toString(), ...prepared.plan, network: prepared.network };
      }, signal); },
      begin(code, consent, auth, signal) { return run(async s => {
        const intent = await post(auth, s), { request, captured, authorizationNonce, plan } = await prepare(code, consent, intent, s);
        const value = { ...captured, eligibility: await observe(request.handle, request.wallet, authorizationNonce, s) };
        // Recheck nonce after the preparation gates; never trust wallet/browser
        // JSON or silently substitute a changed nonce for the persisted plan.
        await mint.stageWallet(value, intent, await chain.read(request.wallet, s), s);
        const dispatch = await mint.submit(value, intent, plan, s);
        return { ...dispatch, transaction: plan.transaction };
      }, signal); },
      report(code, permit, outcome, hash, auth, signal) { return run(async s => mint.report(parseCode(code), await post(auth, s), permit, outcome, hash, s), signal); },
    });
    runtimes.add(runtime); return runtime;
  } catch { worker?.halt(); mint?.halt(); review?.halt(); throw Error("Staging runtime unavailable."); }
}
