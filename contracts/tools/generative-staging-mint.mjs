import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { ROOT } from "./generative-release.mjs";
import { stagingRuntimeBinding } from "./generative-staging-assessment.mjs";
import { createStagingAdmission } from "./generative-admission.mjs";
import { ADMISSION_OPERATIONS, admissionDigest, StagingAdmissionError } from "../../src/openMint/staging/admission.ts";
import { createStagingOperationReview } from "../../src/openMint/staging/stagingReview.ts";
import { certifyStagingMintBinding, prepareStagingMintAdmission } from "../../src/openMint/persistence/stagingMintAdmission.ts";
import { PostgresGenerativeInputJournal } from "../../src/openMint/persistence/generativeInputs.ts";
import { PostgresGenerativeAuthorizationIssuer } from "../../src/openMint/persistence/generativeAuthorizations.ts";
import { PostgresWalletSubmissions } from "../../src/openMint/persistence/walletSubmissions.ts";
import { GENERATIVE_MINT_ABI, normalizeGenerativeAuthorization } from "../../src/openMint/generativeAuthorization.ts";

/** Internal future-staging composition developed locally. No listener, key
 * discovery, RPC-selected wallet nonce, broadcaster, queue or activation.
 * Request eligibility, signer and wallet network context are server-owned. */
export function createStagingMintController(input, root = ROOT, now = Date.now) {
  let halt;
  try {
    const { s, requests, db, binding, observeDatabase, policy } = stagingRuntimeBinding(input, root), stop = new AbortController();
    let adapter, review, activeSignal, running, resources;
    const effects = new Set();
    const live = signal => { stop.signal.throwIfAborted(); signal.throwIfAborted(); requests.repository.writer.assertHealthy(); };
    const gate = createStagingAdmission({ operatingJson: input.operatingJson, transactions: input.transactions, transitions: input.transitions,
      historyLimits: input.historyLimits, sources: input.sources, root, now, assessmentTiming: policy.timing,
      bindings: { databaseBindingSha256: binding, reviewRevisionSha256: input.reviewSource.revisionSha256, writerEpoch: requests.repository.writer.epoch },
      validateObservation(r) { assert.equal(BigInt(r.deployment.collection.blockNumber).toString(), requests.profile.deployment_block);
        assert.equal(r.deployment.collection.blockHash, requests.profile.deployment_block_hash); },
      ports: { requireReview(scope, op, t) { live(activeSignal); assert.ok(["reuse", "sign", "wallet-submit"].includes(op)); review.requireReview(scope, op, t); },
        database: { inspect: (...args) => adapter.database.inspect(...args) },
        effects: Object.fromEntries(ADMISSION_OPERATIONS.map(op => [op, (intent, signal, guard) => {
          assert.equal(op, adapter.intent.operation);
          const effect = adapter.effect(intent, signal, guard); effects.add(effect);
          return effect.finally(() => effects.delete(effect));
        }])),
      } });
    review = createStagingOperationReview(input.reviewSource, gate.scope);
    const config = Object.freeze({ review: db, databaseBindingSha256: binding, scopeSha256: gate.scopeSha256,
      leaseMs: gate.scope.permitTtlMs, assertProfiles: observeDatabase });
    halt = () => { stop.abort(); gate.halt(); review.halt(); adapter?.halt(); };
    // Unsigned preparation/private saved work needs reuse review. The final
    // signing/submission gate separately requires its exact operation review.
    const guard = async tx => {
      const signal = activeSignal; live(signal); review.requireReview(gate.scopeSha256, "reuse", now());
      await certifyStagingMintBinding(tx, requests, config, signal, false);
      live(signal); review.requireReview(gate.scopeSha256, "reuse", now());
    };
    async function open() {
      if (!resources) {
        const journal = await PostgresGenerativeInputJournal.openGuardedStaging(requests.repository.writer, requests.repository.namespace.id, requests.profile.deployment_id, guard);
        const issuer = await PostgresGenerativeAuthorizationIssuer.openGuardedStaging(requests, journal, guard);
        resources = { journal, issuer, submissions: PostgresWalletSubmissions.guardedStaging(requests, guard) };
      }
      return resources;
    }
    async function execute(operation) {
      live(activeSignal); adapter = await prepareStagingMintAdmission(operation, config, activeSignal);
      return gate.execute(await gate.prepare(adapter.intent, activeSignal), activeSignal);
    }
    async function run(work, signal = new AbortController().signal) {
      live(signal); assert.ok(!running, "Mint controller is already running.");
      const combined = AbortSignal.any([signal, stop.signal]); activeSignal = combined;
      let timer;
      const pending = (async () => {
        try {
          const deadline = new Promise((_, reject) => { timer = setTimeout(() => { halt(); reject(new StagingAdmissionError(true)); }, s.hosting.requestTimeoutMs); });
          return await Promise.race([(async () => { live(combined); review.requireReview(gate.scopeSha256, "reuse", now());
            const result = await work(await open(), combined); live(combined); return result; })(), deadline]);
        } finally {
          clearTimeout(timer); adapter?.halt();
          // Gate cancellation can return before the signer records unknown.
          // Drain that bounded cleanup before reusing per-run guard state.
          await Promise.allSettled([...effects]); adapter = undefined;
        }
      })();
      running = pending;
      try { return await pending; } finally { if (running === pending) running = undefined; }
    }
    return Object.freeze({ scope: gate.scope, scopeSha256: gate.scopeSha256, halt,
      async close() { halt(); await running?.catch(() => {}); },
      preflightNonce: (value, signal) => run(({ issuer }) => issuer.preflightNonce(value), signal),
      issue(value, signer, signal) {
        return run(async ({ journal, issuer }) => {
          // Never accept an assessment/MBTI from the caller. Load by the exact
          // authenticated request and require accepted-state SQL linkage.
          await issuer.preflightNonce(value);
          const request = await requests.get(value.code, value.sessionToken), assessment = await requests.repository.getAssessment(request.handle);
          assert.ok(assessment); await journal.stage(assessment);
          return execute(await issuer.prepareIssuanceAdmission(value, signer));
        }, signal);
      },
      stageWallet(value, browser, network, signal) {
        return run(async ({ issuer, submissions }) => {
          const signed = await issuer.prepareSignedInspection(value);
          const r = signed.reservation;
          const saved = await execute({ requests, intent: { operation: "reuse", requestId: r.requestId,
            payloadSha256: admissionDigest({ version: "staging-wallet-plan-signature-v1", reservation: r }) }, inspect: signed.inspect,
            fence: async () => { throw Error("Saved signature is read-only."); },
            effect: async (s, current) => { current(); const result = await requests.repository.writer.transaction(signed.inspect); s.throwIfAborted(); current(); return result; } });
          return submissions.stage(value.code, browser, { expiresAt: new Date(Number(r.authorization.deadline) * 1000).toISOString(), transaction: {
            from: r.authorization.recipient, to: r.domain.verifyingContract, chainId: `0x${BigInt(r.domain.chainId).toString(16)}`, value: "0x0",
            data: encodeFunctionData({ abi: GENERATIVE_MINT_ABI, functionName: "mint", args: [r.renderHandle, r.mbti, normalizeGenerativeAuthorization(r.authorization), saved.signature] }),
          } }, network);
        }, signal);
      },
      submit: (value, browser, plan, signal) => run(async ({ issuer, submissions }) => execute(await submissions.prepareSubmissionAdmission(issuer, value, browser, plan)), signal),
      report: (code, browser, permit, outcome, hash, signal) => run(({ submissions }) => submissions.report(code, browser, permit, outcome, hash), signal),
      submissionState: (code, sessionToken, signal) => run(({ submissions }) => submissions.state(code, sessionToken), signal),
    });
  } catch { halt?.(); throw Error("Staging mint controller unavailable."); }
}
