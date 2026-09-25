import assert from "node:assert/strict";
import { createStagingAssessmentController, stagingRuntimeBinding } from "./generative-staging-assessment.mjs";
import { createGuardedStagingWorker } from "../../src/openMint/persistence/assessmentWorker.ts";
import { ROOT } from "./generative-release.mjs";

/** Locally developed future staging backend. Explicit run only: no listener,
 * queue pump, environment/key discovery, request creation, signing or minting.
 * Transports and eligibility refresh are installed by trusted server code. */
export function createStagingAssessmentWorker(input, dependencies, root = ROOT, now = Date.now) {
  let admission;
  try {
    assert.ok(dependencies && Object.getPrototypeOf(dependencies) === Object.prototype);
    const allowed = ["provider", "identityResolver", "refreshEligibility"];
    for (const key of Reflect.ownKeys(dependencies)) {
      assert.ok(allowed.includes(key)); const d = Object.getOwnPropertyDescriptor(dependencies, key); assert.ok(d.enumerable && "value" in d);
    }
    const { provider, identityResolver, refreshEligibility } = dependencies;
    const configured = [provider, identityResolver, refreshEligibility].filter(v => v !== undefined).length;
    assert.ok(configured === 0 || configured === 3);
    if (configured) {
      assert.equal(provider.model, input.assessmentPolicy.model); assert.equal(provider.provenance, "grok");
      assert.equal(identityResolver.provenance, "x-api"); assert.equal(typeof refreshEligibility, "function");
    }
    const { s, policy } = stagingRuntimeBinding(input, root);
    admission = createStagingAssessmentController(input, root, now);
    const worker = createGuardedStagingWorker(input.requests, { timeoutMs: policy.timing?.jobTimeoutMs ?? s.hosting.requestTimeoutMs,
      admission, provider, identityResolver, refreshEligibility });
    const stop = new AbortController(); let running;
    const halt = () => { stop.abort(); admission.halt(); };
    return Object.freeze({ scope: admission.scope, scopeSha256: admission.scopeSha256,
      halt,
      async close() { halt(); await running?.catch(() => {}); },
      async run(value, signal = new AbortController().signal) {
        stop.signal.throwIfAborted(); assert.ok(!running, "Assessment worker is already running.");
        const pending = worker.run(value, AbortSignal.any([stop.signal, signal])); running = pending;
        try { return await pending; } finally { if (running === pending) running = undefined; }
      },
    });
  } catch { admission?.halt(); throw Error("Staging assessment worker unavailable."); }
}
