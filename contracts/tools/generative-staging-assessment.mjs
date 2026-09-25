import assert from "node:assert/strict";
import { operatingPlan } from "./generative-operating-plan.mjs";
import { createStagingAdmission } from "./generative-admission.mjs";
import { ROOT } from "./generative-release.mjs";
import { SEPOLIA_GENESIS } from "./generative-deployment.mjs";
import { ADMISSION_OPERATIONS, admissionDigest, StagingAdmissionError } from "../../src/openMint/staging/admission.ts";
import { createStagingOperationReview } from "../../src/openMint/staging/stagingReview.ts";
import { prepareStagingAssessmentAdmission } from "../../src/openMint/persistence/stagingAssessmentAdmission.ts";
import { parseExactDatabaseProfiles } from "../../src/openMint/persistence/databaseProfiles.ts";
import { GENERATIVE_DATABASE_LOCK } from "../../src/openMint/persistence/databaseSchemaLock.ts";
import { GENERATIVE_DATABASE_V2_LOCK } from "../../src/openMint/persistence/databaseSchemaV2Lock.ts";
import { verifySelectedRuntimeDatabase, readCertifiedDatabaseProfiles } from "../../src/openMint/persistence/databaseCertification.ts";
import { POLICY_VERSION } from "../../src/openMint/identity.ts";
import { captureAssessmentPolicy } from "../../src/openMint/staging/assessmentPolicy.ts";

const deny = () => { throw Error("Staging assessment controller unavailable."); };
const fields = (v, expected) => {
  assert.ok(v && Object.getPrototypeOf(v) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(v); assert.deepEqual(Reflect.ownKeys(v).sort(), [...expected].sort());
  assert.ok(expected.every(k => ds[k].enumerable && "value" in ds[k]));
};

/** Shared exact static configuration/profile checks, not an admission permit.
 * Both future-staging controllers certify the actual database at use time. */
export function stagingRuntimeBinding(input, root = ROOT) {
    fields(input, ["operatingJson", "transactions", "transitions", "historyLimits", "sources", "requests", "databaseReview", "assessmentPolicy", "reviewSource"]);
    const { deploymentPlan: d, operatingPlan: p } = operatingPlan(input.operatingJson, root), s = p.settings, requests = input.requests;
    const db = Object.freeze({ ...input.databaseReview }), policy = captureAssessmentPolicy(input.assessmentPolicy);
    const v2 = s.schema === "sg-sepolia-operating-settings-v2", lock = v2 ? GENERATIVE_DATABASE_V2_LOCK : GENERATIVE_DATABASE_LOCK;
    fields(db, ["version", "database", "ownerRole", "runtimeRole", "namespaceId", "deploymentId", "migrationManifestSha256", "migrationReceiptSha256", "profilesSha256", "reviewRevisionSha256",
      ...(v2 ? ["inspectorRole", "recoveryRole"] : [])]);
    assert.equal(db.version, v2 ? "sg-generative-runtime-db-review-v2" : "sg-generative-runtime-db-review-v1");
    assert.equal(db.migrationManifestSha256, lock.migrationManifestSha256);
    if (v2) { assert.equal(s.database.schemaProfile, lock.version); assert.equal(db.inspectorRole, s.database.roles.inspector.name);
      assert.equal(db.recoveryRole, s.database.roles.recovery.name); }
    for (const k of ["migrationReceiptSha256", "profilesSha256", "reviewRevisionSha256"]) assert.match(db[k], /^(?!0{64}$)[a-f0-9]{64}$/);
    assert.equal(db.ownerRole, s.database.roles.migrator.name); assert.equal(db.runtimeRole, s.database.roles.browser.name);
    assert.match(db.database, /^(?!pg_)(?!public$)[a-z][a-z0-9_]{0,62}$/);
    assert.equal(db.namespaceId, requests.repository.namespace.id); assert.equal(db.deploymentId, s.deploymentId);
    assert.equal(requests.profile.deployment_id, s.deploymentId); assert.equal(requests.repository.namespace.profile, "staging-testnet");
    assert.equal(requests.repository.namespace.provenance, "grok"); assert.equal(requests.repository.namespace.policyVersion, POLICY_VERSION);
    assert.equal(admissionDigest(policy), s.assessment.profileSha256);
    const binding = admissionDigest(v2 ? { lock, review: db } : { version: db.version, lock, review: db });
    const observeDatabase = raw => {
      const v = parseExactDatabaseProfiles(raw), ns = db.namespaceId;
      const subset = (row, expected) => { for (const [k, value] of Object.entries(expected)) assert.equal(row[k], value); };
      for (const kind of ["namespace", "budget", "session", "request", "input", "issuance"]) assert.equal(v[kind].namespace_id, ns);
      subset(v.namespace, { profile: "staging-testnet", provenance: "grok", policy_version: POLICY_VERSION });
      subset(v.session, { origin: s.origin, chain_id: "11155111" });
      subset(v.request, { deployment_id: s.deploymentId, chain_id: "11155111", contract_address: d.collection.address,
        genesis_hash: SEPOLIA_GENESIS, runtime_code_hash: p.collectionRuntimeCodeHash, authorizer: s.custody.authorizer.address,
        deployment_block: requests.profile.deployment_block, deployment_block_hash: requests.profile.deployment_block_hash,
        max_evidence_age_ms: String(s.rpc.evidenceTtlMs), max_block_age_ms: String(s.rpc.maxHeadAgeMs), max_future_skew_ms: String(s.rpc.maxFutureSkewMs) });
      subset(v.input, { deployment_id: s.deploymentId, profile: d.inputProfile, renderer_address: d.renderer.address,
        renderer_code_hash: d.renderer.runtimeCodeHash, renderer_identity: d.renderer.identity });
      subset(v.budget, { profile_version: policy.profileVersion, expected_model: policy.model, max_total: String(s.assessment.totalAttempts),
        max_daily: String(s.assessment.dailyAttempts), max_active: "1", max_queued: String(s.assessment.maxQueued),
        reservation_usd_ticks: s.assessment.reservationUsdTicks, max_exposure_usd_ticks: s.assessment.maxExposureUsdTicks });
      assert.equal(Date.parse(v.budget.valid_until), Date.parse(s.assessment.validUntil));
      subset(v.issuance, { deployment_id: s.deploymentId, max_evidence_age_ms: String(s.rpc.evidenceTtlMs), max_block_age_ms: String(s.rpc.maxHeadAgeMs),
        max_future_skew_ms: String(s.rpc.maxFutureSkewMs) });
      assert.ok(BigInt(v.issuance.signer_timeout_ms) <= BigInt(s.hosting.requestTimeoutMs));
    };
    return { d, p, s, requests, db, policy, binding, observeDatabase };
}

/** Paid-leg dispatch and private assessment reuse only. No signer, wallet-send
 * permission, HTTP surface, credentials or public broadcast. */
export function createStagingAssessmentController(input, root = ROOT, now = Date.now) {
  try {
    const { s, requests, db, policy, binding, observeDatabase } = stagingRuntimeBinding(input, root);
    const stop = new AbortController(); let adapter, operation, review;
    // One controller supports one in-flight operation and owns no connection.
    // The gate captures ports once; HTTP/users cannot register effects.
    let effect, beginCompletion, busy = false;
    const gate = createStagingAdmission({ operatingJson: input.operatingJson, transactions: input.transactions, transitions: input.transitions,
      historyLimits: input.historyLimits, sources: input.sources, root, now, assessmentTiming: policy.timing,
      bindings: { databaseBindingSha256: binding, reviewRevisionSha256: input.reviewSource.revisionSha256, writerEpoch: requests.repository.writer.epoch },
      validateObservation(r) {
        assert.equal(BigInt(r.deployment.collection.blockNumber).toString(), requests.profile.deployment_block);
        assert.equal(r.deployment.collection.blockHash, requests.profile.deployment_block_hash);
      },
      ports: { requireReview(scope, op, t) { stop.signal.throwIfAborted(); assert.ok(["reuse", "assessment-x", "assessment-grok"].includes(op)); review.requireReview(scope, op, t); },
        database: { inspect: (...args) => adapter.database.inspect(...args) },
        effects: Object.fromEntries(ADMISSION_OPERATIONS.map(op => [op, async (intent, signal, guard) => {
          assert.equal(op, operation); return adapter.effect(intent, signal, guard, current => effect(signal, current));
        }])),
      } });
    review = createStagingOperationReview(input.reviewSource, gate.scope);
    const live = () => { stop.signal.throwIfAborted(); requests.repository.writer.assertHealthy(); };
    const halt = () => { stop.abort(); gate.halt(); review.halt(); adapter?.halt(); };
    async function run(value, op, callback, signal = new AbortController().signal) {
      live(); assert.ok(!busy); busy = true;
      const combined = AbortSignal.any([signal, stop.signal]);
      let timer, rejectDeadline;
      const arm = ms => { clearTimeout(timer); timer = setTimeout(() => {
        // A delayed effect/COMMIT may already exist. Preserve its fence.
        halt(); rejectDeadline(new StagingAdmissionError(true));
      }, ms); };
      try {
        const deadline = new Promise((_, reject) => { rejectDeadline = reject; arm(s.hosting.requestTimeoutMs); });
        beginCompletion = () => arm(op === "assessment-x" ? policy.timing.xCompletionMs : policy.timing.grokCompletionMs);
        const work = async () => {
          combined.throwIfAborted(); review.requireReview(gate.scopeSha256, op, now());
          operation = op; effect = callback;
          const prepared = await prepareStagingAssessmentAdmission(requests, value, op, policy.model, { review: db, databaseBindingSha256: binding,
            scopeSha256: gate.scopeSha256, leaseMs: gate.scope.permitTtlMs, assertProfiles: observeDatabase }, combined);
          live(); combined.throwIfAborted(); adapter = prepared;
          return gate.execute(await gate.prepare(adapter.intent, combined), combined);
        };
        return await Promise.race([work(), deadline]);
      } finally { clearTimeout(timer); adapter?.halt(); adapter = undefined; effect = undefined; beginCompletion = undefined; operation = undefined; busy = false; }
    }
    return Object.freeze({ requests, scope: gate.scope, scopeSha256: gate.scopeSha256,
      halt,
      async validateClaim(tx, model, signal) {
        const current = () => { live(); signal.throwIfAborted(); assert.equal(model, policy.model);
          review.requireReview(gate.scopeSha256, "assessment-x", now()); };
        current();
        const result = await verifySelectedRuntimeDatabase(tx, db, signal, Math.min(5000, gate.scope.timeoutMs)); current();
        assert.equal(result.databaseBindingSha256, binding); assert.equal(result.generationEnabled, true);
        observeDatabase(readCertifiedDatabaseProfiles(result)); current();
      },
      reuse: (value, signal) => run(value, "reuse", deny, signal),
      dispatch(value, leg, model, signal, callback) {
        assert.ok(leg === "x-identity" || leg === "grok"); assert.equal(model, policy.model); assert.equal(typeof callback, "function");
        return run(value, leg === "x-identity" ? "assessment-x" : "assessment-grok", (s, guard) => callback(Object.freeze({ signal: s,
          assertCurrent(current) { assert.equal(current, leg); live(); guard(); },
          ...(guard.beginDispatch ? {
            beginDispatch(current) { assert.equal(current, leg); live(); guard.beginDispatch(); beginCompletion(); },
            assertCompletion(current) { assert.equal(current, leg); live(); guard.assertCompletion(); },
          } : {}) })), signal);
      },
    });
  } catch { return deny(); }
}
