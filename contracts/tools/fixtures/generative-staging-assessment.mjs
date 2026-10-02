import { Client } from "pg";
import { performance } from "node:perf_hooks";
import { decodeFunctionData, encodeFunctionResult, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readinessDatabaseFixture } from "./generative-staging-readiness.mjs";
import { activeStateFixture } from "./generative-active-state.mjs";
import { createStagingAssessmentController } from "../generative-staging-assessment.mjs";
import { readinessReviewFixture } from "../../../src/openMint/staging/fixtures/readinessReview.ts";
import { stagingReviewFixture } from "../../../src/openMint/staging/fixtures/stagingReview.ts";
import { observeGenerativeRuntimeDatabase, observeGenerativeV2Database } from "../../../src/openMint/persistence/databaseCertification.ts";
import { ExclusiveWriter } from "../../../src/openMint/persistence/writer.ts";
import { OpenMintRepository } from "../../../src/openMint/persistence/repository.ts";
import { PostgresMintRequests } from "../../../src/openMint/persistence/requests.ts";
import { PostgresWalletSessions } from "../../../src/openMint/persistence/sessions.ts";
import { createStagingEligibilityReader, PUBLIC_CHAIN_READ_ABI } from "../../../src/openMint/publicChain.ts";
import { GENERATIVE_MINT_ABI } from "../../../src/openMint/generativeAuthorization.ts";
import { POLICY_VERSION } from "../../../src/openMint/identity.ts";

// Targeted deadline tests can spend time at the intended mocked transport
// checkpoint rather than in slow covered SQL setup. Enable BEFORE composing
// controllers: their default wall-clock function is captured at construction.
// Ordinary fixture tests retain real clocks and real PostgreSQL timestamps.
export function controlledAssessmentTiming(t, fixture) {
  const origin = Date.now(), monotonic = performance.now(), originalQueryHook = fixture.faults.afterQuery;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: origin });
  t.mock.method(performance, "now", () => monotonic + (Date.now() - origin));
  fixture.faults.afterQuery = async (sql, result) => {
    await originalQueryHook?.(sql, result);
    // Align only the returned admission clock, not real expiry columns,
    // database constraints, certification, witnesses or freshness guards.
    if (sql === "SELECT clock_timestamp() AS now") result.rows[0].now = new Date(Date.now());
  };
  return { tick(ms) { t.mock.timers.tick(ms); }, close() {
    fixture.faults.afterQuery = originalQueryHook; t.mock.timers.reset(); t.mock.restoreAll();
  } };
}

// Entirely disposable database, public test wallet and fabricated active chain.
// No provider credential, network transaction or operational approval exists.
export async function stagingAssessmentFixture(cluster, admin, { claimed = true, admitted = true, v2 = false, requestTimeoutMs = 15000 } = {}) {
  // Success-path transport fixtures may select the canonical nominal 30s
  // operating-plan budget. Deadline/refusal cases retain the exact 15s default.
  // Reject unsupported options before allocating a database or signing reviews.
  if (![15000, 30000].includes(requestTimeoutMs)) throw TypeError("Unsupported assessment fixture request timeout");
  const f = await readinessDatabaseFixture(cluster, admin, { v2 }), active = await activeStateFixture(), now = Math.floor(Date.now() / 1000) * 1000;
  let writer, controller;
  try {
    for (const [name, principal] of Object.entries(active.config.principals)) principal.ownerReference = `custodians/${name.toLowerCase()}`;
    active.advance(now - active.now());
    for (const [i, block] of active.headers.entries()) block.timestamp = "0x" + BigInt(Math.floor(now / 1000) - 120 + i * 4).toString(16);
    f.settings.assessment.validFrom = new Date(now - 1000).toISOString(); f.settings.assessment.validUntil = new Date(now + 3600000).toISOString();
    f.settings.rpc.timeoutMs = 5000; f.settings.hosting.requestTimeoutMs = requestTimeoutMs; f.settings.hosting.drainTimeoutMs = requestTimeoutMs;
    await f.db.query("BEGIN; SET LOCAL session_replication_role=replica");
    await f.db.query("UPDATE open_mint.budget_policies SET generation_enabled=true,valid_until=$1", [f.settings.assessment.validUntil]);
    await f.db.query("COMMIT");
    const faults = { afterQuery: undefined };
    const connect = () => {
      const client = new Client({ ...cluster.config, database: f.target.database, user: f.target.runtimeRole,
        options: "-c search_path=pg_catalog -c timezone=UTC" });
      const query = client.query.bind(client);
      client.query = async (sql, values) => { const result = await query(sql, values); await faults.afterQuery?.(sql, result); return result; };
      return client;
    };
    const ns = { id: f.target.namespaceId, profile: "staging-testnet", provenance: "grok", policyVersion: POLICY_VERSION };
    const wallet = privateKeyToAccount(`0x${"0".repeat(63)}2`);
    const sources = active.sources.map((source, i) => ({ id: f.settings.rpc.sources[i].id, operatorReference: f.settings.rpc.sources[i].operatorReference, request: source.request }));
    const pin = { address: f.d.renderer.address, runtimeCodeHash: f.d.renderer.runtimeCodeHash, identity: f.d.renderer.identity, inputProfile: f.d.inputProfile };
    const runtime = (await f.runtime.query("SELECT runtime_code_hash FROM open_mint.request_profiles")).rows[0].runtime_code_hash;
    const config = { namespaceId: ns.id, deploymentId: f.target.deploymentId, contractProfile: "generative-v1-rc1", chainId: 11155111n,
      contract: f.d.collection.address, genesisHash: active.config.genesisHash, runtimeCodeHash: runtime, authorizer: f.d.principals.authorizer.address,
      deploymentBlock: { number: 2n, hash: active.headers[2].hash }, maxBlockAgeMs: f.settings.rpc.maxHeadAgeMs,
      maxFutureSkewMs: f.settings.rpc.maxFutureSkewMs, evidenceTtlMs: f.settings.rpc.evidenceTtlMs, observationTimeoutMs: 3000, generativeRenderer: pin };
    const eligibilitySources = sources.map((source, index) => ({ ...source, id: `eligibility-${index}`, async request(method, params, signal) {
      if (method === "eth_getCode") params = [params[0].toLowerCase(), ...params.slice(1)];
      if (method === "eth_call") params = [{ ...params[0], to: params[0].to.toLowerCase() }, ...params.slice(1)];
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "eth_call") {
        const abi = [...PUBLIC_CHAIN_READ_ABI, ...GENERATIVE_MINT_ABI];
        // The integrated runtime uses the same transports for the narrower
        // eligibility ABI and the full governance observer ABI.
        let functionName;
        try { ({ functionName } = decodeFunctionData({ abi, data: params[0].data })); } catch { /* Full fixture ABI handles other selectors. */ }
        if (["mintedHandle", "usedNonces"].includes(functionName)) return encodeFunctionResult({ abi, functionName, result: false });
      }
      return source.request(method, params, signal);
    } }));
    // Separate fresh public-chain witness for each exact request, not a fake
    // always-current object supplied to the admission adapter.
    const witness = () => createStagingEligibilityReader(config, eligibilitySources).preflight({ block: { number: BigInt(active.headers.at(-1).number), hash: active.headers.at(-1).hash },
      handle: "alice", recipient: wallet.address, nonce: `0x${"3".repeat(64)}` });
    // Explicit TEST chain progress after slow covered setup/restart. Never
    // mutate an already observed block or make an existing witness current.
    // Callers still obtain and validate a new opaque witness separately.
    const advanceHeadToNow = () => {
      const previous = active.headers.at(-1), timestamp = BigInt(Math.floor(Date.now() / 1000));
      if (timestamp <= BigInt(previous.timestamp)) return previous;
      const number = BigInt(previous.number) + 1n;
      const head = { number: `0x${number.toString(16)}`, hash: keccak256(stringToHex(`OFFLINE ASSESSMENT HEAD/${number}/${timestamp}`)),
        parentHash: previous.hash, timestamp: `0x${timestamp.toString(16)}`, transactions: [] };
      active.headers.push(head); return head;
    };
    let repository, requests, sessions, session, request, signed, input;
    const restart = async () => {
      controller?.halt(); await writer?.close(); writer = await ExclusiveWriter.acquire(connect);
      repository = await OpenMintRepository.open(writer, ns); requests = await PostgresMintRequests.open(repository, f.target.deploymentId);
      sessions = await PostgresWalletSessions.openStaging({ writer, namespaceId: ns.id, origin: f.settings.origin, chainId: 11155111 });
      if (!session) {
        session = (await sessions.session()).session; const challenge = await sessions.challenge(session.id, wallet.address);
        await sessions.verify(session.id, challenge.challengeId, await wallet.signMessage({ message: challenge.message }));
        session = (await sessions.session(sessions.cookie(session))).session;
      }
      if (!request && admitted) {
        request = await requests.create({ sessionToken: session.id, sessionGeneration: session.generation, origin: f.settings.origin, csrf: session.csrf,
          recipient: wallet.address, handle: "Alice", eligibility: await witness() });
        if (claimed) await repository.claimInitial(request.attemptId);
      }
      const observed = v2 ? await observeGenerativeV2Database(f.runtime,
        { ...f.target, inspectorRole: "sg_inspector", recoveryRole: "sg_recovery" }, undefined, 5000, true)
        : await observeGenerativeRuntimeDatabase(f.runtime, f.target);
      input = { operatingJson: JSON.stringify({ deployment: active.config, settings: f.settings }), transactions: active.transactions,
        transitions: active.transitions, historyLimits: { maxHistorySpan: 256, logBlockRange: 2, maxLogs: 128, maxTransactions: 32 }, sources, requests,
        databaseReview: { ...f.input.databaseReview, version: v2 ? "sg-generative-runtime-db-review-v2" : "sg-generative-runtime-db-review-v1",
          profilesSha256: observed.profilesSha256 },
        assessmentPolicy: f.input.assessmentPolicy, reviewSource: readinessReviewFixture().source };
      const candidate = createStagingAssessmentController(input); signed = stagingReviewFixture(candidate.scope); candidate.halt();
      input.reviewSource = signed.source; controller = createStagingAssessmentController(input);
    };
    await restart();
    return { ...f, active, wallet, ns, restart, config, witness, advanceHeadToNow, faults, eligibilitySources,
      get writer() { return writer; }, get repository() { return repository; }, get requests() { return requests; }, get sessions() { return sessions; },
      get session() { return session; }, get request() { return request; }, get signed() { return signed; }, get input() { return input; }, get controller() { return controller; },
      intent: async () => ({ code: request.code, sessionToken: session.id, sessionGeneration: session.generation, origin: f.settings.origin,
        csrf: session.csrf, eligibility: await witness() }),
      async fences() { return (await f.db.query("SELECT leg FROM open_mint.dispatch_fences ORDER BY leg")).rows.map(v => v.leg); },
      async close() { controller?.halt(); await writer?.close(); await f.close(); },
    };
  } catch (error) { controller?.halt(); await writer?.close(); await f.close(); throw error; }
}
