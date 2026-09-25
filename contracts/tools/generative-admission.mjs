import assert from "node:assert/strict";
import { keccak256, stringToHex } from "viem";
import { operatingPlan } from "./generative-operating-plan.mjs";
import { createActiveStateObserver, readActiveStateObservation } from "./generative-active-state.mjs";
import { ROOT } from "./generative-release.mjs";
import { parseOperatingJson } from "../../src/openMint/staging/operatingPlan.ts";
import { createAdmissionGate, StagingAdmissionError } from "../../src/openMint/staging/admission.ts";

/** Internal release-aware composition only. No CLI, secret loading, database
 * initialization, provider client, public HTTP listener or broadcast exists.
 * Trusted ports must implement real review/durable guards before runtime use.
 */
export function createStagingAdmission({ operatingJson, transactions, transitions, historyLimits, sources, bindings, ports, validateObservation, assessmentTiming, root = ROOT, now = Date.now }) {
  try {
    const { deploymentPlan: d, operatingPlan: p } = operatingPlan(operatingJson, root), s = p.settings;
    assert.ok(validateObservation === undefined || typeof validateObservation === "function");
    assert.deepEqual(Object.keys(historyLimits).sort(), ["logBlockRange", "maxHistorySpan", "maxLogs", "maxTransactions"]);
    assert.deepEqual(Object.keys(bindings).sort(), ["databaseBindingSha256", "reviewRevisionSha256", "writerEpoch"]);
    assert.deepEqual(Object.keys(ports).sort(), ["database", "effects", "requireReview"]);
    assert.deepEqual(sources.map(({ id, operatorReference }) => ({ id, operatorReference })),
      s.rpc.sources.map(({ id, operatorReference }) => ({ id, operatorReference })));
    assert.notEqual(sources[0], sources[1]); assert.notEqual(sources[0].request, sources[1].request);
    const boundedSources = sources.map(source => {
      assert.deepEqual(Object.keys(source).sort(), ["id", "operatorReference", "request"]);
      const request = source.request.bind(source);
      return { id: source.id, operatorReference: source.operatorReference, request: async (method, params, signal) => {
        signal.throwIfAborted(); const result = await request(method, params, signal); signal.throwIfAborted();
        // The actual transport must ALSO enforce streaming capacity before
        // decoding. This additional check enforces the declared decoded cap.
        const json = JSON.stringify(result); assert.ok(typeof json === "string" && Buffer.byteLength(json) <= s.rpc.jsonResponseBytes); return result;
      } };
    });
    // Common limits are derived, never independently caller-selected. History
    // ceilings are additionally committed by the observer's policy digest.
    const policy = { timeoutMs: s.rpc.timeoutMs, maxHeadAgeMs: s.rpc.maxHeadAgeMs, maxFinalizedAgeMs: s.rpc.maxFinalizedAgeMs,
      maxFutureSkewMs: s.rpc.maxFutureSkewMs, validityMs: s.rpc.evidenceTtlMs, ...historyLimits };
    const observer = createActiveStateObserver({ config: parseOperatingJson(operatingJson).deployment, transactions, transitions, sources: boundedSources, policy, root, now });
    assert.equal(observer.plan.planSha256, d.planSha256);
    const expectedRoles = Object.fromEntries(["DEFAULT_ADMIN_ROLE", "AUTHORIZER_MANAGER_ROLE", "PAUSER_ROLE", "NONCE_REVOKER_ROLE"].map((r, i) =>
      [i === 0 ? "0x" + "00".repeat(32) : keccak256(stringToHex(r)), [s.custody[["delayedAdmin", "authorizerManager", "pauser", "nonceRevoker"][i]].address]]));
    const scope = { operatingPlanSha256: p.operatingPlanSha256, activePolicySha256: observer.policySha256, ...bindings,
      timeoutMs: s.rpc.timeoutMs, permitTtlMs: s.rpc.evidenceTtlMs,
      ...(assessmentTiming ? { paidCompletionMs: { "assessment-x": assessmentTiming.xCompletionMs, "assessment-grok": assessmentTiming.grokCompletionMs } } : {}),
      paidValidFrom: Date.parse(s.assessment.validFrom), paidValidUntil: Date.parse(s.assessment.validUntil) };
    const chain = { observe: observer.observe.bind(observer), read(witness, time) {
      const r = readActiveStateObservation(witness, { policySha256: observer.policySha256, now: time });
      assert.equal(r.planSha256, d.planSha256); assert.equal(r.releaseLockSha256, p.releaseLockSha256);
      assert.equal(r.collectionRuntimeCodeHash, p.collectionRuntimeCodeHash); assert.equal(r.origin, s.origin); assert.equal(r.chainId, 11155111);
      // A declared rotation is not an updated custody review. Until there is a
      // separate versioned custody-update adapter, refuse changed principals.
      assert.equal(r.state.authorizer, s.custody.authorizer.address); assert.deepEqual(r.state.roles, expectedRoles);
      if (validateObservation) assert.equal(validateObservation(r), undefined);
      return { observedAt: r.observedAt, validUntil: r.validUntil };
    } };
    return createAdmissionGate(scope, { ...ports, chain }, now);
  } catch { throw new StagingAdmissionError(); }
}
