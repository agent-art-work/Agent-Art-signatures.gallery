import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { operatingPlan } from "./generative-operating-plan.mjs";
import { createDeploymentObserver, readDeploymentObservation, SEPOLIA_GENESIS } from "./generative-deployment.mjs";
import { ROOT } from "./generative-release.mjs";
import { admissionDigest } from "../../src/openMint/staging/admission.ts";
import { captureAssessmentPolicy } from "../../src/openMint/staging/assessmentPolicy.ts";
import { parseOperatingJson } from "../../src/openMint/staging/operatingPlan.ts";
import { createReadinessReview } from "../../src/openMint/staging/readinessReview.ts";
import { createPausedReadinessServer, READINESS_LIMITS } from "../../src/openMint/staging/readinessServer.ts";
import { verifySelectedPausedDatabase, readCertifiedDatabaseProfiles } from "../../src/openMint/persistence/databaseCertification.ts";
import { GENERATIVE_DATABASE_LOCK } from "../../src/openMint/persistence/databaseSchemaLock.ts";
import { GENERATIVE_DATABASE_V2_LOCK } from "../../src/openMint/persistence/databaseSchemaV2Lock.ts";
import { parseExactDatabaseProfiles } from "../../src/openMint/persistence/databaseProfiles.ts";

const fail = () => new Error("Paused staging readiness unavailable.");
const keys = (v, names) => {
  assert.ok(v && Object.getPrototypeOf(v) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(v).sort(), [...names].sort());
  const ds = Object.getOwnPropertyDescriptors(v); assert.ok(names.every(k => ds[k]?.enumerable && "value" in ds[k]));
};
const hash = v => assert.match(v, /^(?!0{64}$)[a-f0-9]{64}$/);

/** Offline scope only. The operator reviews/signs this, with separately pinned
 * key/revision/evidence. No auto-approval, discovery, provisioning or effects. */
export function pausedReadinessScope(input, root = ROOT) {
  try {
    keys(input, ["operatingJson", "transactions", "databaseReview", "assessmentPolicy", "port", "maxDeploymentSpan"]);
    const { deploymentPlan: d, operatingPlan: p } = operatingPlan(input.operatingJson, root), s = p.settings;
    assert.equal(s.hosting.tlsMode, "trusted-proxy"); assert.equal(s.hosting.trustedProxyHops, 1);
    assert.ok(Number.isSafeInteger(input.port) && input.port >= 0 && input.port <= 65535);
    assert.ok(Number.isSafeInteger(input.maxDeploymentSpan) && input.maxDeploymentSpan > 0 && input.maxDeploymentSpan <= 512);
    keys(input.transactions, ["renderer", "collection"]);
    for (const tx of Object.values(input.transactions)) assert.match(tx, /^0x[0-9a-f]{64}$/);
    assert.notEqual(input.transactions.renderer, input.transactions.collection);
    const r = input.databaseReview;
    const v2 = s.schema === "sg-sepolia-operating-settings-v2", lock = v2 ? GENERATIVE_DATABASE_V2_LOCK : GENERATIVE_DATABASE_LOCK;
    keys(r, ["database", "ownerRole", "runtimeRole", "namespaceId", "deploymentId", "migrationManifestSha256", "migrationReceiptSha256", "profilesSha256", "reviewRevisionSha256",
      ...(v2 ? ["version", "inspectorRole", "recoveryRole"] : [])]);
    for (const k of ["migrationManifestSha256", "migrationReceiptSha256", "profilesSha256", "reviewRevisionSha256"]) hash(r[k]);
    assert.equal(r.migrationManifestSha256, lock.migrationManifestSha256);
    if (v2) { assert.equal(r.version, "sg-generative-paused-db-review-v2"); assert.equal(s.database.schemaProfile, lock.version);
      assert.equal(r.inspectorRole, s.database.roles.inspector.name); assert.equal(r.recoveryRole, s.database.roles.recovery.name); }
    assert.equal(r.runtimeRole, s.database.roles.browser.name); assert.equal(r.ownerRole, s.database.roles.migrator.name);
    assert.equal(r.deploymentId, s.deploymentId); assert.match(r.database, /^(?!pg_)(?!public$)[a-z][a-z0-9_]{0,62}$/);
    assert.match(r.namespaceId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const a = captureAssessmentPolicy(input.assessmentPolicy);
    assert.equal(admissionDigest(a), s.assessment.profileSha256);
    // The reviewed operating envelope can express more than the current DB
    // supports. Refuse that mismatch; never silently clamp a user's budget.
    assert.ok(s.assessment.totalAttempts <= 100000 && s.assessment.maxQueued >= 1);
    const binding = { version: "sg-paused-readiness-scope-v1", operatingPlanSha256: p.operatingPlanSha256,
      databaseLock: lock, databaseReview: { ...r }, assessmentPolicy: { ...a },
      transactions: { ...input.transactions }, port: input.port, maxDeploymentSpan: input.maxDeploymentSpan, limits: READINESS_LIMITS };
    return Object.freeze({ scopeSha256: admissionDigest(binding), operatingPlanSha256: p.operatingPlanSha256,
      approved: false, minting: false });
  } catch { throw fail(); }
}

// The outer profile document contains JSON strings, not decoded SQL numbers.
// Tokenize each flat row's JSON scalars: string tokens stay untouched; numeric
// lexemes become strings BEFORE JSON.parse can round bigint/numeric values.
function matchDatabase(result, review, policy, p, d, chain) {
  const v = parseExactDatabaseProfiles(readCertifiedDatabaseProfiles(result)), s = p.settings, ns = review.namespaceId;
  const subset = (record, expected) => { for (const [k, value] of Object.entries(expected)) assert.equal(record[k], value); };
  for (const kind of ["budget", "input", "issuance", "namespace", "request", "session"]) assert.equal(v[kind].namespace_id, ns);
  subset(v.namespace, { profile: "staging-testnet", provenance: "grok", policy_version: policy.policyVersion });
  subset(v.session, { origin: s.origin, chain_id: "11155111" });
  subset(v.request, { deployment_id: s.deploymentId, chain_id: "11155111", contract_address: d.collection.address,
    genesis_hash: SEPOLIA_GENESIS, runtime_code_hash: p.collectionRuntimeCodeHash, authorizer: s.custody.authorizer.address,
    deployment_block: BigInt(chain.deployment.collection.blockNumber).toString(), deployment_block_hash: chain.deployment.collection.blockHash,
    max_evidence_age_ms: String(s.rpc.evidenceTtlMs), max_block_age_ms: String(s.rpc.maxHeadAgeMs), max_future_skew_ms: String(s.rpc.maxFutureSkewMs) });
  subset(v.input, { deployment_id: s.deploymentId, profile: d.inputProfile, renderer_address: d.renderer.address,
    renderer_code_hash: d.renderer.runtimeCodeHash, renderer_identity: d.renderer.identity });
  subset(v.budget, { profile_version: policy.profileVersion, expected_model: policy.model, generation_enabled: false,
    max_total: String(s.assessment.totalAttempts), max_daily: String(s.assessment.dailyAttempts), max_active: "1", max_queued: String(s.assessment.maxQueued),
    reservation_usd_ticks: s.assessment.reservationUsdTicks, max_exposure_usd_ticks: s.assessment.maxExposureUsdTicks });
  assert.equal(Date.parse(v.budget.valid_until), Date.parse(s.assessment.validUntil));
  subset(v.issuance, { deployment_id: s.deploymentId, enabled: false, max_evidence_age_ms: String(s.rpc.evidenceTtlMs),
    max_block_age_ms: String(s.rpc.maxHeadAgeMs), max_future_skew_ms: String(s.rpc.maxFutureSkewMs) });
  assert.ok(BigInt(v.issuance.signer_timeout_ms) <= BigInt(s.hosting.requestTimeoutMs));
}

/** Separate paused Sepolia control surface. No mint/session/provider/signer
 * components or local-only constructors are imported or relaxed. The caller
 * supplies authenticated bounded RPC transports, serialized restricted DB
 * connection, independent review pins and current signed review source.
 * This does not configure a proxy/TLS, load credentials or publish a service. */
export function createSepoliaReadiness(input, root = ROOT, now = Date.now) {
  try {
    keys(input, ["operatingJson", "transactions", "databaseReview", "assessmentPolicy", "port", "maxDeploymentSpan", "sources", "connection", "review"]);
    const scopeInput = Object.fromEntries(["operatingJson", "transactions", "databaseReview", "assessmentPolicy", "port", "maxDeploymentSpan"].map(k => [k, input[k]]));
    const scope = pausedReadinessScope(scopeInput, root);
    const { deploymentPlan: d, operatingPlan: p } = operatingPlan(input.operatingJson, root), s = p.settings;
    const captured = JSON.parse(JSON.stringify(scopeInput)), connection = input.connection;
    const review = createReadinessReview(input.review, scope.scopeSha256);
    assert.equal(input.sources.length, 2);
    assert.notEqual(input.sources[0], input.sources[1]); assert.notEqual(input.sources[0].request, input.sources[1].request);
    const sources = input.sources.map((source, i) => {
      keys(source, ["id", "operatorReference", "request"]); assert.equal(typeof source.request, "function");
      assert.equal(source.id, s.rpc.sources[i].id); assert.equal(source.operatorReference, s.rpc.sources[i].operatorReference);
      const request = source.request.bind(source);
      return { id: source.id.replace(":", "/"), operatorReference: source.operatorReference.replace(":", "/"), request: async (method, params, signal) => {
        signal.throwIfAborted(); const value = await request(method, params, signal); signal.throwIfAborted();
        const json = JSON.stringify(value); assert.ok(typeof json === "string" && Buffer.byteLength(json) <= s.rpc.jsonResponseBytes); return value;
      } };
    });
    const observer = createDeploymentObserver({ config: parseOperatingJson(captured.operatingJson).deployment,
      transactions: captured.transactions, sources, root, now, policy: { timeoutMs: s.rpc.timeoutMs, maxHeadAgeMs: s.rpc.maxHeadAgeMs,
        maxFinalizedAgeMs: s.rpc.maxFinalizedAgeMs, maxFutureSkewMs: s.rpc.maxFutureSkewMs, validityMs: s.rpc.evidenceTtlMs, maxDeploymentSpan: captured.maxDeploymentSpan } });
    assert.equal(observer.plan.planSha256, d.planSha256);
    const server = createPausedReadinessServer({ port: captured.port, requestTimeoutMs: s.hosting.requestTimeoutMs, drainTimeoutMs: s.hosting.drainTimeoutMs }, {
      halt: review.halt,
      async probe(signal) {
        const started = performance.now(), wall = now();
        const live = () => { signal.throwIfAborted(); review.require(now()); assert.ok(now() >= wall
          && performance.now() - started < s.hosting.requestTimeoutMs && now() - wall < s.hosting.requestTimeoutMs); };
        live();
        const db = await verifySelectedPausedDatabase(connection, captured.databaseReview, signal, Math.min(5000, s.hosting.requestTimeoutMs)); live();
        const witness = await observer.observe(signal); live();
        const read = () => readDeploymentObservation(witness, { planSha256: d.planSha256, now: now() });
        const chain = read();
        assert.equal(chain.releaseLockSha256, p.releaseLockSha256); assert.equal(chain.collectionRuntimeCodeHash, p.collectionRuntimeCodeHash);
        matchDatabase(db, captured.databaseReview, captured.assessmentPolicy, p, d, chain);
        // The probe signal is closed once observation completes. Freshness and
        // review remain independently checked before listening/each response.
        return Object.freeze({ assertCurrent() {
          review.require(now()); assert.ok(now() >= wall && performance.now() - started < s.hosting.requestTimeoutMs
            && now() - wall < s.hosting.requestTimeoutMs); read();
        } });
      },
    });
    return Object.freeze({ ...server, scopeSha256: scope.scopeSha256 });
  } catch { throw fail(); }
}
