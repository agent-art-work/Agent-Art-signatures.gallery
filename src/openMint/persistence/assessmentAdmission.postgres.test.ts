import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, type QueryResultRow } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ADMISSION_OPERATIONS, admissionDigest, createAdmissionGate, type AdmissionPorts, type AdmissionScope } from "../staging/admission.js";
import { localReviewFixture } from "../staging/fixtures/localReview.js";
import { XApiIdentityResolver } from "../xIdentity.js";
import { GrokAssessmentProvider } from "../grok.js";
import { type AssessmentExecution } from "../assessmentOperations.js";
import { observeLocalAssessmentBinding, prepareLocalAssessmentAdmission } from "./assessmentAdmission.js";
import { PostgresAssessmentWorker } from "./assessmentWorker.js";
import { assessment, bytes, identity, namespace, receipt } from "./fixtures/data.js";
import { eligibilityFixture, fixturePinForProfile } from "./fixtures/eligibility.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";
import { OpenMintRepository } from "./repository.js";
import { PostgresMintRequests } from "./requests.js";
import { generativeBrowserRuntimeGrants } from "./runtimeRole.js";
import { PostgresWalletSessions } from "./sessions.js";
import { ExclusiveWriter, type OwnershipConnectionFactory } from "./writer.js";

// Public test scalars only. PostgreSQL is real and disposable; chain, review
// and provider effects are offline fixtures, never a paid acceptance claim.
const authorizer = privateKeyToAccount(`0x${"0".repeat(63)}1`), wallet = privateKeyToAccount(`0x${"0".repeat(63)}2`);
const role = "sg_browser", model = "grok-offline-test", hash = "a".repeat(64);
describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("local RC1 PostgreSQL assessment admission", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter | undefined;
  const runtime = () => new Client({ ...cluster.config, user: role, options: "-c search_path=pg_catalog" });
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); await installSchema(admin);
    for (const file of ["requests-schema.sql", "generative-input-schema.sql", "generative-release-profile-schema.sql", "generative-authorization-schema.sql", "wallet-submission-schema.sql",
      "../projection/projection-schema.sql", "../projection/projection-v2.sql", "../projection/projection-v3.sql"])
      await admin.query(readFileSync(new URL(file, import.meta.url), "utf8"));
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(generativeBrowserRuntimeGrants(role));
  }, 30000);
  afterAll(async () => { await writer?.close(); await admin?.end(); cluster?.stop(); });
  async function setup(factory: OwnershipConnectionFactory = runtime) {
    await writer?.close(); writer = undefined;
    const ns = { ...namespace(), profile: "local-real" as const, provenance: "grok" as const }, deployment = randomUUID();
    const chain = eligibilityFixture(ns.id, deployment), p = { ...chain.profile, authorizer: authorizer.address.toLowerCase() };
    const pin = fixturePinForProfile("generative-v1-rc1");
    const witness = () => chain.witness("alice", wallet.address, { authorizer: authorizer.address, contractProfile: "generative-v1-rc1", generativeRenderer: pin });
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,$2,$3,$4)", [ns.id, ns.profile, ns.provenance, ns.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id,profile_version,expected_model,generation_enabled,valid_until,max_total,max_daily,max_active,max_queued,reservation_usd_ticks,max_exposure_usd_ticks)
      VALUES($1,'offline-admission-test',$2,true,'2099-01-01',2,2,1,2,100,1000)`, [ns.id, model]);
    await admin.query("INSERT INTO open_mint.session_profiles VALUES($1,$2,31337)", [ns.id, p.origin]);
    await admin.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [ns.id, deployment, p.chain_id, p.contract_address, p.genesis_hash, p.runtime_code_hash,
      p.authorizer, p.deployment_block, p.deployment_block_hash, p.max_evidence_age_ms, p.max_block_age_ms, p.max_future_skew_ms]);
    await admin.query("INSERT INTO open_mint.generative_input_profiles VALUES($1,$2,'sg-generative-inputs-v1-rc1',$3,$4,$5)", [ns.id, deployment, pin.address, pin.runtimeCodeHash, pin.identity]);
    await admin.query("INSERT INTO open_mint.generative_issuance_profiles VALUES($1,$2,false,600,200,10000,120000,5000)", [ns.id, deployment]);
    writer = await ExclusiveWriter.acquire(factory);
    const repository = await OpenMintRepository.open(writer, ns), requests = await PostgresMintRequests.open(repository, deployment);
    const sessions = await PostgresWalletSessions.open({ writer, namespaceId: ns.id, origin: p.origin, chainId: 31337 });
    let session = (await sessions.session()).session;
    const challenge = await sessions.challenge(session.id, wallet.address);
    await sessions.verify(session.id, challenge.challengeId, await wallet.signMessage({ message: challenge.message }));
    session = (await sessions.session(sessions.cookie(session))).session;
    const request = await requests.create({ sessionToken: session.id, sessionGeneration: session.generation, origin: p.origin, csrf: session.csrf,
      recipient: wallet.address, handle: "Alice", eligibility: await witness() });
    await repository.claimInitial(request.attemptId!);
    const scope: AdmissionScope = { operatingPlanSha256: hash, activePolicySha256: hash, reviewRevisionSha256: hash,
      databaseBindingSha256: await observeLocalAssessmentBinding(requests, role), writerEpoch: writer.epoch,
      timeoutMs: 5000, permitTtlMs: 5000, paidValidFrom: Date.now() - 1000, paidValidUntil: Date.now() + 60000 };
    const config = { leg: "x-identity" as "x-identity" | "grok", model, expectedRole: role,
      databaseBindingSha256: scope.databaseBindingSha256, scopeSha256: admissionDigest(scope), leaseMs: 5000 };
    const intent = async () => ({ code: request.code, sessionToken: session.id, sessionGeneration: session.generation,
      origin: p.origin, csrf: session.csrf, eligibility: await witness() });
    const adapter = async (leg: "x-identity" | "grok" = "x-identity") => prepareLocalAssessmentAdmission(requests, await intent(), { ...config, leg });
    const control = { reviewed: true };
    const calls: string[] = [];
    const effects = Object.fromEntries(ADMISSION_OPERATIONS.map(op => [op, vi.fn(async () => {
      calls.push(op);
      const fences = (await admin.query("SELECT leg FROM open_mint.dispatch_fences WHERE namespace_id=$1", [ns.id])).rows.map(r => r.leg);
      expect(fences).toContain(op === "assessment-x" ? "x-identity" : "grok");
      return "recorded";
    })])) as unknown as AdmissionPorts<string>["effects"];
    const gate = (db: AdmissionPorts<string>["database"]) => createAdmissionGate(scope, {
      chain: { observe: async () => ({}), read: (_w, now) => ({ observedAt: now, validUntil: now + 5000 }) },
      requireReview() { if (!control.reviewed) throw Error("Fixture review withdrawn"); }, database: db, effects,
    });
    const fenceCount = async () => (await admin.query("SELECT count(*)::int AS n FROM open_mint.dispatch_fences WHERE namespace_id=$1", [ns.id])).rows[0].n;
    return { ns, deployment, repository, requests, sessions, session, request, scope, config, intent, adapter, gate, effects, control, calls, fenceCount };
  }

  it("inspects without writes, fences each provider leg before its effect, and reuses the saved result after restart", async () => {
    const h = await setup(), a = await h.adapter(), g = h.gate(a.database), token = await g.prepare(a.intent);
    expect(await h.fenceCount()).toBe(0); expect(h.calls).toEqual([]);
    await expect(g.execute(token)).resolves.toBe("recorded");
    await expect(g.execute(token)).rejects.toThrow();
    await expect(h.adapter()).rejects.toThrow("already");
    await expect(h.adapter("grok")).rejects.toThrow("successful X");
    const snapshot = { ...identity(), username: "Alice", provenance: "x-api" as const };
    await h.repository.recordReceipt(h.request.attemptId!, bytes(receipt("x-identity", "1")));
    await h.repository.recordIdentity(h.request.attemptId!, bytes(snapshot));
    const b = await h.adapter("grok"), gg = h.gate(b.database);
    await gg.execute(await gg.prepare(b.intent));
    await h.repository.recordReceipt(h.request.attemptId!, bytes(receipt("grok", "1")));
    const saved = await h.repository.acceptAssessment(h.request.attemptId!, bytes(assessment("alice", { provenance: "grok", model,
      providerResponseId: "offline-admission-test", sourceUrls: ["https://x.com/Alice"], xIdentity: snapshot })));
    expect(await h.fenceCount()).toBe(2); expect(h.calls).toEqual(["assessment-x", "assessment-grok"]);
    await writer!.close(); writer = await ExclusiveWriter.acquire(runtime);
    const repo = await OpenMintRepository.open(writer, h.ns), requests = await PostgresMintRequests.open(repo, h.deployment);
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [h.ns.id]);
    const reused = await new PostgresAssessmentWorker(requests, { timeoutMs: 5000 }).run(await h.intent());
    expect(reused).toEqual({ kind: "accepted", assessment: saved, reused: true });
    expect(await h.fenceCount()).toBe(2); expect(h.calls).toHaveLength(2);
  });

  it.each(["session", "csrf", "origin", "generation", "code", "chain", "model", "binding", "role", "leg", "ttl", "scope-format", "experimental-chain"])("rejects a crossed %s at capture with no effect", async scenario => {
    const h = await setup(), input = await h.intent(), c = { ...h.config };
    if (scenario === "session") input.sessionToken = "z".repeat(43);
    if (scenario === "csrf") input.csrf = "z".repeat(43);
    if (scenario === "origin") input.origin = "https://other.example";
    if (scenario === "generation") input.sessionGeneration = "999";
    if (scenario === "code") input.code = "z".repeat(43);
    if (scenario === "chain") input.eligibility = {} as typeof input.eligibility;
    if (scenario === "model") c.model = "grok-other";
    if (scenario === "binding") c.databaseBindingSha256 = "b".repeat(64);
    if (scenario === "role") c.expectedRole = "wrong_role";
    if (scenario === "leg") c.leg = "sign" as typeof c.leg;
    if (scenario === "ttl") c.leaseMs = 0;
    if (scenario === "scope-format") c.scopeSha256 = "bad";
    if (scenario === "experimental-chain") input.eligibility = await eligibilityFixture(h.ns.id, h.deployment).witness("alice", wallet.address, { authorizer: authorizer.address });
    await expect(prepareLocalAssessmentAdmission(h.requests, input, c)).rejects.toThrow();
    expect(await h.fenceCount()).toBe(0);
  });

  it.each(["revoked", "proof", "disabled", "expired-policy", "model-drift", "profile-drift", "review", "halt", "writer-close", "extra-grant"])("rechecks %s between prepare and execute", async scenario => {
    const h = await setup(), a = await h.adapter(), g = h.gate(a.database), token = await g.prepare(a.intent);
    if (scenario === "revoked") await h.sessions.logout(h.session.id);
    if (scenario === "proof") await h.sessions.challenge(h.session.id, wallet.address);
    if (scenario === "disabled") await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [h.ns.id]);
    if (["expired-policy", "model-drift", "profile-drift"].includes(scenario)) {
      const assignments: Record<string, string> = { "expired-policy": "valid_until='2000-01-01'", "model-drift": "expected_model='grok-new'", "profile-drift": "profile_version='changed'" };
      const sql = `UPDATE open_mint.budget_policies SET ${assignments[scenario]} WHERE namespace_id=$1`;
      // Normal writes are blocked even as the fixture owner. Inject corruption
      // only in this freshly-created disposable DB to test defense in depth.
      await expect(admin.query(sql, [h.ns.id])).rejects.toThrow("immutable");
      await admin.query("BEGIN");
      try { await admin.query("SET LOCAL session_replication_role=replica"); await admin.query(sql, [h.ns.id]); await admin.query("COMMIT"); }
      catch (error) { await admin.query("ROLLBACK"); throw error; }
    }
    if (scenario === "review") h.control.reviewed = false;
    if (scenario === "halt") a.halt();
    if (scenario === "writer-close") await writer!.close();
    if (scenario === "extra-grant") await admin.query(`GRANT UPDATE(generation_enabled) ON open_mint.budget_policies TO ${role}`);
    try { await expect(g.execute(token)).rejects.toThrow(); expect(h.calls).toEqual([]); expect(await h.fenceCount()).toBe(0); }
    finally { if (scenario === "extra-grant") await admin.query(`REVOKE UPDATE(generation_enabled) ON open_mint.budget_policies FROM ${role}`); }
  });

  it("binds scope and payload, detaches input, and consumes fence leases before awaiting", async () => {
    const h = await setup(), input = await h.intent(), a = await prepareLocalAssessmentAdmission(h.requests, input, h.config);
    input.code = "changed"; h.config.model = "changed";
    const s = new AbortController().signal;
    await expect(a.database.inspect(a.intent, "b".repeat(64), s)).rejects.toThrow();
    await expect(a.database.inspect({ ...a.intent, payloadSha256: "b".repeat(64) }, admissionDigest(h.scope), s)).rejects.toThrow();
    await expect(a.database.inspect({ ...a.intent, operation: "reuse" }, admissionDigest(h.scope), s)).rejects.toThrow();
    const lease = await a.database.inspect(a.intent, admissionDigest(h.scope), s);
    expect(() => lease.assertCurrent("sign")).toThrow();
    const first = lease.fence(s);
    await expect(lease.fence(s)).rejects.toThrow(); await first;
    expect(await h.fenceCount()).toBe(1); expect(h.calls).toEqual([]);
  });

  it("rechecks controls inside the fence, not just during readiness", async () => {
    const h = await setup(), a = await h.adapter(), s = new AbortController().signal;
    const lease = await a.database.inspect(a.intent, admissionDigest(h.scope), s);
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [h.ns.id]);
    await expect(lease.fence(s)).rejects.toThrow(); expect(await h.fenceCount()).toBe(0);
  });

  it("allows only one of two independently prepared gates to commit a provider leg", async () => {
    const h = await setup(), a = await h.adapter(), b = await h.adapter();
    const ga = h.gate(a.database), gb = h.gate(b.database);
    const pa = await ga.prepare(a.intent), pb = await gb.prepare(b.intent);
    const results = await Promise.allSettled([ga.execute(pa), gb.execute(pb)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await h.fenceCount()).toBe(1); expect(h.calls).toEqual(["assessment-x"]);
  });

  it("stops Grok when the actual X receipt exceeds the reserved exposure", async () => {
    const h = await setup(), a = await h.adapter(), g = h.gate(a.database);
    await g.execute(await g.prepare(a.intent));
    await h.repository.recordReceipt(h.request.attemptId!, bytes(receipt("x-identity", "1001")));
    await h.repository.recordIdentity(h.request.attemptId!, bytes({ ...identity(), provenance: "x-api" }));
    await expect(h.adapter("grok")).rejects.toThrow("exposure");
    expect(await h.fenceCount()).toBe(1); expect(h.calls).toEqual(["assessment-x"]);
  });

  it.each(["lost-commit", "abort-before-commit"])("preserves the exact fence outcome on %s", async scenario => {
    const control = { armed: false, fenced: false }, cancel = new AbortController();
    const h = await setup(() => {
      const client = runtime();
      return { connect: () => client.connect(), end: () => client.end(), on: (event, callback) => client.on(event, callback),
        async query<R extends QueryResultRow>(sql: string, values?: unknown[]) {
          const result = await client.query<R>(sql, values);
          if (control.armed && sql.startsWith("INSERT INTO open_mint.dispatch_fences")) {
            control.fenced = true;
            if (scenario === "abort-before-commit") cancel.abort();
          }
          // Real PostgreSQL COMMIT succeeded; only the client's reply is lost.
          if (control.armed && control.fenced && sql === "COMMIT" && scenario === "lost-commit") throw Error("Injected lost COMMIT reply");
          return result;
        },
      };
    });
    const a = await h.adapter(), g = h.gate(a.database), permit = await g.prepare(a.intent);
    control.armed = true;
    await expect(g.execute(permit, cancel.signal)).rejects.toMatchObject({ effectMayHaveStarted: false });
    expect(h.calls).toEqual([]); expect(await h.fenceCount()).toBe(scenario === "lost-commit" ? 1 : 0);
    if (scenario === "lost-commit") expect(() => writer!.assertHealthy()).toThrow();
    control.armed = false;
    await writer!.close(); writer = await ExclusiveWriter.acquire(runtime);
    const repo = await OpenMintRepository.open(writer, h.ns);
    // Claimed work isn't silently reclaimable, even when rollback is known.
    await expect(repo.claimInitial(h.request.attemptId!)).rejects.toThrow();
    expect(h.calls).toEqual([]);
  });

  it("does not redispatch after an effect failure or process restart", async () => {
    const h = await setup(), a = await h.adapter();
    h.effects["assessment-x"] = async () => { h.calls.push("failed"); throw Error("Provider outcome unknown"); };
    const g = h.gate(a.database);
    await expect(g.execute(await g.prepare(a.intent))).rejects.toMatchObject({ effectMayHaveStarted: true });
    expect(await h.fenceCount()).toBe(1);
    await writer!.close(); writer = await ExclusiveWriter.acquire(runtime);
    const repo = await OpenMintRepository.open(writer, h.ns), requests = await PostgresMintRequests.open(repo, h.deployment);
    await expect(repo.claimInitial(h.request.attemptId!)).rejects.toThrow();
    await expect(prepareLocalAssessmentAdmission(requests, await h.intent(), h.config)).rejects.toThrow();
    expect(h.calls).toEqual(["failed"]); expect(await h.fenceCount()).toBe(1);
  });

  it("honors aborted and expired leases without starting work", async () => {
    const h = await setup(), controller = new AbortController(); controller.abort();
    await expect(prepareLocalAssessmentAdmission(h.requests, await h.intent(), h.config, controller.signal)).rejects.toThrow();
    const a = await h.adapter(), s = new AbortController();
    const lease = await a.database.inspect(a.intent, admissionDigest(h.scope), s.signal);
    vi.spyOn(Date, "now").mockReturnValue(lease.validUntil);
    try { expect(() => lease.assertCurrent("assessment-x")).toThrow(); } finally { vi.restoreAllMocks(); }
    s.abort(); await expect(lease.fence(s.signal)).rejects.toThrow(); expect(await h.fenceCount()).toBe(0);
  });

  it("refuses privileged ownership and keeps public namespaces disabled", async () => {
    const h = await setup(); await writer!.close(); writer = await ExclusiveWriter.acquire(() => new Client(cluster.config));
    const repo = await OpenMintRepository.open(writer, h.ns), requests = await PostgresMintRequests.open(repo, h.deployment);
    await expect(observeLocalAssessmentBinding(requests, "open_mint_test")).rejects.toThrow();
    await expect(observeLocalAssessmentBinding(h.requests, "invalid role")).rejects.toThrow();
    const publicRepo = { ...h.repository, namespace: { ...h.ns, profile: "staging-testnet" } } as unknown as OpenMintRepository;
    expect(() => new PostgresAssessmentWorker({ ...h.requests, repository: publicRepo } as PostgresMintRequests, { timeoutMs: 1000 })).toThrow("PUBLIC_WORKER_DISABLED");
  });

  it("composes signed fixture review, actual provider clients, durable fences and saved results without network", async () => {
    const h = await setup(), review = localReviewFixture(h.scope, { operations: ["assessment-x", "assessment-grok"] });
    const config = { ...h.config, scopeSha256: admissionDigest(review.scope) };
    const xFetch = vi.fn<typeof fetch>(async () => Response.json({ data: { id: "123", username: "ALIce" } }));
    const grokFetch = vi.fn<typeof fetch>(async () => Response.json({ id: "response-admitted-test", model, status: "completed", error: null, incomplete_details: null,
      citations: ["https://x.com/ALIce/status/12345"], usage: { cost_in_usd_ticks: 1 }, output: [
        { type: "x_search_call", id: "search-test", status: "completed" }, { type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: JSON.stringify({ handle: "alice", mbti: "INTJ", xUserId: "123" }), annotations: [] }] }] }));
    const resolver = new XApiIdentityResolver({ bearerToken: "offline-placeholder", fetch: xFetch });
    const provider = new GrokAssessmentProvider({ apiKey: "offline-placeholder", model, fetch: grokFetch });
    const execution = (leg: "x-identity" | "grok", signal: AbortSignal, guard: () => void): AssessmentExecution => ({
      attemptId: h.request.attemptId!, dispatch: { signal, assertCurrent(value) { expect(value).toBe(leg); guard(); } },
      beforeDispatch: async () => { throw Error("Already fenced"); },
      recordReceipt: receipt => h.repository.recordReceipt(h.request.attemptId!, bytes(receipt)).then(() => {}),
      identityVerified: async () => { throw Error("Explicit handler persistence"); }, recordOutcome: async () => { throw Error("Explicit handler persistence"); },
      assessmentPersisted: async () => { throw Error("Explicit handler persistence"); },
    });
    async function run<T>(leg: "x-identity" | "grok", effect: AdmissionPorts<T>["effects"]["read"]) {
      const a = await prepareLocalAssessmentAdmission(h.requests, await h.intent(), { ...config, leg });
      const g = createAdmissionGate(review.scope, { chain: { observe: async () => ({}), read: (_w, now) => ({ observedAt: now, validUntil: now + 5000 }) },
        requireReview: review.review.requireReview, database: a.database,
        effects: Object.fromEntries(ADMISSION_OPERATIONS.map(op => [op, op === a.intent.operation ? effect : async () => { throw Error("Unregistered"); }])) as AdmissionPorts<T>["effects"] });
      return g.execute(await g.prepare(a.intent));
    }
    const verified = await run("x-identity", async (_intent, signal, guard) => {
      expect(await h.fenceCount()).toBe(1);
      const result = await resolver.resolve("alice", execution("x-identity", signal, guard));
      await h.repository.recordIdentity(h.request.attemptId!, bytes(result)); guard(); return result;
    });
    const saved = await run("grok", async (_intent, signal, guard) => {
      expect(await h.fenceCount()).toBe(2);
      const result = await provider.assess("alice", verified, execution("grok", signal, guard));
      if ("kind" in result) throw Error("Expected accepted offline response");
      const saved = await h.repository.acceptAssessment(h.request.attemptId!, bytes(assessment("alice", { provenance: "grok", model,
        providerResponseId: result.providerResponseId, sourceUrls: result.sourceUrls, mbti: result.mbti, xIdentity: verified })));
      guard(); return saved;
    });
    expect(saved.xIdentity?.username).toBe("ALIce"); expect(saved.mbti).toBe("INTJ");
    expect(await h.repository.getAssessment("alice")).toEqual(saved);
    expect(xFetch).toHaveBeenCalledOnce(); expect(grokFetch).toHaveBeenCalledOnce(); expect(await h.fenceCount()).toBe(2);
    await expect(run("grok", async () => undefined)).rejects.toThrow(); expect(grokFetch).toHaveBeenCalledOnce();
  });

  it("withdrawn signed review after the durable fence prevents the actual X transport", async () => {
    const h = await setup(), review = localReviewFixture(h.scope, { operations: ["assessment-x"] });
    const a = await prepareLocalAssessmentAdmission(h.requests, await h.intent(), { ...h.config, scopeSha256: admissionDigest(review.scope) });
    const transport = vi.fn<typeof fetch>(async () => Response.json({ data: { id: "123", username: "Alice" } }));
    const resolver = new XApiIdentityResolver({ bearerToken: "offline-placeholder", fetch: transport }), recordReceipt = vi.fn(async () => {});
    const effect: AdmissionPorts<unknown>["effects"]["assessment-x"] = async (_intent, signal, guard) => {
      await Promise.resolve(); review.source.current = undefined;
      return resolver.resolve("alice", { attemptId: h.request.attemptId!, dispatch: { signal, assertCurrent: guard }, recordReceipt,
        beforeDispatch: async () => {}, identityVerified: async () => {}, recordOutcome: async () => {}, assessmentPersisted: async () => {} });
    };
    const g = createAdmissionGate(review.scope, { chain: { observe: async () => ({}), read: (_w, now) => ({ observedAt: now, validUntil: now + 5000 }) },
      requireReview: review.review.requireReview, database: a.database,
      effects: Object.fromEntries(ADMISSION_OPERATIONS.map(op => [op, effect])) as AdmissionPorts<unknown>["effects"] });
    await expect(g.execute(await g.prepare(a.intent))).rejects.toMatchObject({ effectMayHaveStarted: true });
    expect(transport).not.toHaveBeenCalled(); expect(recordReceipt).not.toHaveBeenCalled(); expect(await h.fenceCount()).toBe(1);
    await expect(h.adapter()).rejects.toThrow();
  });
});
