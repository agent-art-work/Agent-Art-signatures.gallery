import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, type QueryResultRow } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ADMISSION_OPERATIONS, admissionDigest, createAdmissionGate, type AdmissionPorts, type AdmissionScope } from "../staging/admission.js";
import { localReviewFixture } from "../staging/fixtures/localReview.js";
import { observeLocalAssessmentBinding } from "./assessmentAdmission.js";
import { prepareLocalReuseAdmission } from "./reuseAdmission.js";
import { assessment, bytes, identity, namespace, receipt } from "./fixtures/data.js";
import { eligibilityFixture, fixturePinForProfile } from "./fixtures/eligibility.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";
import { OpenMintRepository } from "./repository.js";
import { PostgresMintRequests } from "./requests.js";
import { PostgresWalletSessions } from "./sessions.js";
import { generativeBrowserRuntimeGrants } from "./runtimeRole.js";
import { ExclusiveWriter, type OwnershipConnectionFactory } from "./writer.js";

const authorizer = privateKeyToAccount(`0x${"0".repeat(63)}1`), wallet = privateKeyToAccount(`0x${"0".repeat(63)}2`);
const role = "sg_browser", model = "grok-offline-test", hash = "a".repeat(64);
// Real disposable PG + ephemeral signed TEST review. No provider or signer.
describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("local RC1 private saved-assessment admission", () => {
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
  async function setup(factory: OwnershipConnectionFactory = runtime, accepted = true) {
    await writer?.close(); writer = undefined;
    const ns = { ...namespace(), profile: "local-real" as const, provenance: "grok" as const }, deployment = randomUUID();
    const chain = eligibilityFixture(ns.id, deployment), p = { ...chain.profile, authorizer: authorizer.address.toLowerCase() }, pin = fixturePinForProfile("generative-v1-rc1");
    const witness = () => chain.witness("alice", wallet.address, { authorizer: authorizer.address, contractProfile: "generative-v1-rc1", generativeRenderer: pin });
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,$2,$3,$4)", [ns.id, ns.profile, ns.provenance, ns.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id,profile_version,expected_model,generation_enabled,valid_until,max_total,max_daily,max_active,max_queued,reservation_usd_ticks,max_exposure_usd_ticks)
      VALUES($1,'offline-reuse-admission',$2,true,'2099-01-01',1,1,1,1,100,1000)`, [ns.id, model]);
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
    const saved = assessment("alice", { provenance: "grok", model, providerResponseId: "offline-reuse-admission", sourceUrls: ["https://x.com/Alice"],
      xIdentity: { ...identity(), username: "Alice", provenance: "x-api" } });
    if (accepted) {
      await repository.claimInitial(request.attemptId!);
      await repository.beforeDispatch(request.attemptId!, "x-identity");
      await repository.recordReceipt(request.attemptId!, bytes(receipt("x-identity", "1")));
      await repository.recordIdentity(request.attemptId!, bytes(saved.xIdentity));
      await repository.beforeDispatch(request.attemptId!, "grok");
      await repository.recordReceipt(request.attemptId!, bytes(receipt("grok", "1")));
      await repository.acceptAssessment(request.attemptId!, bytes(saved));
    }
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [ns.id]);
    const input = async () => ({ code: request.code, sessionToken: session.id, sessionGeneration: session.generation, origin: p.origin, csrf: session.csrf, eligibility: await witness() });
    const scope: AdmissionScope = { operatingPlanSha256: hash, activePolicySha256: hash, reviewRevisionSha256: hash,
      databaseBindingSha256: await observeLocalAssessmentBinding(requests, role), writerEpoch: writer.epoch,
      timeoutMs: 5000, permitTtlMs: 5000, paidValidFrom: Date.now() - 2000, paidValidUntil: Date.now() - 1000 };
    const reviewed = localReviewFixture(scope);
    const config = { expectedRole: role, databaseBindingSha256: scope.databaseBindingSha256, scopeSha256: admissionDigest(reviewed.scope), leaseMs: 5000 };
    const gate = (adapter: Awaited<ReturnType<typeof prepareLocalReuseAdmission>>) => createAdmissionGate(reviewed.scope, {
      chain: { observe: async () => ({}), read: (_w, now) => ({ observedAt: now, validUntil: now + 5000 }) },
      requireReview: reviewed.review.requireReview, database: adapter.database,
      effects: Object.fromEntries(ADMISSION_OPERATIONS.map(op => [op, op === "reuse" ? adapter.effect : async () => { throw Error("Unregistered"); }])) as AdmissionPorts<typeof saved>["effects"],
    });
    const snapshot = async () => {
      const tables = ["requests", "assessment_attempts", "budget_reservations", "jobs", "dispatch_fences", "provider_receipts", "verified_identities", "assessments",
        "generative_inputs", "generative_authorizations", "generative_authorization_signatures", "wallet_mint_plans", "wallet_mint_dispatches"];
      const snapshots: string[] = [];
      for (const table of tables) snapshots.push((await admin.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]')::text AS snapshot FROM open_mint.${table} t WHERE namespace_id=$1`, [ns.id])).rows[0].snapshot);
      return snapshots;
    };
    return { ns, deployment, chain, repository, requests, sessions, session, input, request, saved, reviewed, config, gate, snapshot };
  }
  async function corrupt(sql: string, values: unknown[]) {
    await admin.query("BEGIN");
    try { await admin.query("SET LOCAL session_replication_role=replica"); await admin.query(sql, values); await admin.query("COMMIT"); }
    catch (error) { await admin.query("ROLLBACK"); throw error; }
  }
  it("reuses byte-equivalent saved results with paid/generation/issuance disabled and no writes", async () => {
    const h = await setup(), before = await h.snapshot();
    const a = await prepareLocalReuseAdmission(h.requests, await h.input(), h.config), g = h.gate(a), token = await g.prepare(a.intent);
    const result = await g.execute(token); expect(result).toEqual(h.saved); expect(await h.snapshot()).toEqual(before);
    await expect(g.execute(token)).rejects.toThrow();
    // Read reuse may be explicitly repeated with a NEW permit, never a reroll.
    expect(await g.execute(await g.prepare(a.intent))).toEqual(result); expect(await h.snapshot()).toEqual(before);
  });
  it("survives restart with a fresh writer/review binding and without paid clients", async () => {
    const h = await setup(), before = await h.snapshot();
    await writer!.close(); writer = await ExclusiveWriter.acquire(runtime);
    const repo = await OpenMintRepository.open(writer, h.ns), requests = await PostgresMintRequests.open(repo, h.deployment);
    const review = localReviewFixture({ ...h.reviewed.scope, writerEpoch: writer.epoch });
    const a = await prepareLocalReuseAdmission(requests, await h.input(), { ...h.config, scopeSha256: admissionDigest(review.scope) });
    const g = createAdmissionGate(review.scope, { chain: { observe: async () => ({}), read: (_w, now) => ({ observedAt: now, validUntil: now + 5000 }) },
      database: a.database, requireReview: review.review.requireReview, effects: Object.fromEntries(ADMISSION_OPERATIONS.map(op => [op, a.effect])) as AdmissionPorts<typeof h.saved>["effects"] });
    expect(await g.execute(await g.prepare(a.intent))).toEqual(h.saved); expect(await h.snapshot()).toEqual(before);
  });
  it("reuses a coalesced accepted request and rejects a crossed saved assessment reference", async () => {
    const h = await setup(), input = await h.input();
    const request = await h.requests.create({ ...input, recipient: wallet.address, handle: "ALICE" });
    expect(request.assessmentId).toBe(h.saved.id); expect(request.attemptId).toBeUndefined();
    const a = await prepareLocalReuseAdmission(h.requests, { ...input, code: request.code }, h.config), g = h.gate(a);
    expect(await g.execute(await g.prepare(a.intent))).toEqual(h.saved);
    const token = await g.prepare(a.intent);
    await corrupt("UPDATE open_mint.requests SET assessment_id=$2 WHERE namespace_id=$1 AND request_id=$3", [h.ns.id, randomUUID(), request.id]);
    await expect(g.execute(token)).rejects.toThrow();
  });
  it.each(["code", "session", "csrf", "origin", "generation", "chain", "renderer", "binding", "role", "ttl", "scope"])("rejects crossed %s before reuse", async scenario => {
    const h = await setup(), input = await h.input(), config = { ...h.config };
    if (scenario === "code") input.code = "z".repeat(43);
    if (scenario === "session") input.sessionToken = "z".repeat(43);
    if (scenario === "csrf") input.csrf = "z".repeat(43);
    if (scenario === "origin") input.origin = "https://other.example";
    if (scenario === "generation") input.sessionGeneration = "999";
    if (scenario === "chain") input.eligibility = {} as typeof input.eligibility;
    if (scenario === "renderer") input.eligibility = await h.chain.witness("alice", wallet.address, { authorizer: authorizer.address });
    if (scenario === "binding") config.databaseBindingSha256 = "b".repeat(64);
    if (scenario === "role") config.expectedRole = "unknown_role";
    if (scenario === "ttl") config.leaseMs = 0;
    if (scenario === "scope") config.scopeSha256 = "invalid";
    await expect(prepareLocalReuseAdmission(h.requests, input, config)).rejects.toThrow();
  });
  it.each(["logout", "challenge", "proof-expired", "request-expired", "session-expired", "wallet", "review", "halt", "writer", "grant", "saved-bytes"])("rechecks %s after preparation", async reason => {
    const h = await setup(), a = await prepareLocalReuseAdmission(h.requests, await h.input(), h.config), g = h.gate(a), token = await g.prepare(a.intent);
    if (reason === "logout") await h.sessions.logout(h.session.id);
    if (reason === "challenge") await h.sessions.challenge(h.session.id, wallet.address);
    if (reason === "proof-expired") await admin.query("UPDATE open_mint.sessions SET proof_expires_at='2000-01-01' WHERE namespace_id=$1", [h.ns.id]);
    if (reason === "request-expired") await corrupt("UPDATE open_mint.requests SET created_at=created_at-interval '1 day',expires_at=expires_at-interval '1 day',preflight_observed_at=preflight_observed_at-interval '1 day',preflight_valid_until=preflight_valid_until-interval '1 day' WHERE namespace_id=$1", [h.ns.id]);
    if (reason === "session-expired") await corrupt("UPDATE open_mint.sessions SET expires_at='2000-01-01' WHERE namespace_id=$1", [h.ns.id]);
    if (reason === "wallet") await admin.query("UPDATE open_mint.sessions SET wallet=$2 WHERE namespace_id=$1", [h.ns.id, authorizer.address]);
    if (reason === "review") h.reviewed.source.current = undefined;
    if (reason === "halt") a.halt();
    if (reason === "writer") await writer!.close();
    if (reason === "grant") await admin.query(`GRANT UPDATE(generation_enabled) ON open_mint.budget_policies TO ${role}`);
    if (reason === "saved-bytes") await corrupt("UPDATE open_mint.assessments SET payload=$2 WHERE namespace_id=$1", [h.ns.id, bytes({ ...h.saved, mbti: "ENTP" })]);
    try { await expect(g.execute(token)).rejects.toMatchObject({ effectMayHaveStarted: false }); }
    finally { if (reason === "grant") await admin.query(`REVOKE UPDATE(generation_enabled) ON open_mint.budget_policies FROM ${role}`); }
    if (reason === "request-expired" || reason === "proof-expired") expect((await h.requests.get(h.request.code, h.session.id)).assessmentId).toBe(h.saved.id);
  });
  it("will not generate a missing result", async () => {
    const h = await setup(runtime, false), before = await h.snapshot();
    await expect(prepareLocalReuseAdmission(h.requests, await h.input(), h.config)).rejects.toThrow(); expect(await h.snapshot()).toEqual(before);
  });
  it("binds exact scope/payload, captures input, and refuses all fences", async () => {
    const h = await setup(), input = await h.input(), config = { ...h.config }, a = await prepareLocalReuseAdmission(h.requests, input, config);
    input.code = "changed"; config.expectedRole = "changed";
    const s = new AbortController().signal;
    await expect(a.database.inspect(a.intent, hash, s)).rejects.toThrow();
    await expect(a.database.inspect({ ...a.intent, operation: "sign" }, h.config.scopeSha256, s)).rejects.toThrow();
    const lease = await a.database.inspect(a.intent, h.config.scopeSha256, s);
    expect(() => lease.assertCurrent("sign")).toThrow(); await expect(lease.fence(s)).rejects.toThrow("no dispatch fence");
    await expect(a.effect({ ...a.intent, payloadSha256: hash }, s, () => {})).rejects.toThrow();
    const g = h.gate(a); expect(await g.execute(await g.prepare(a.intent))).toEqual(h.saved);
    const now = vi.spyOn(Date, "now").mockReturnValue(lease.validUntil);
    try { expect(() => lease.assertCurrent("reuse")).toThrow(); } finally { now.mockRestore(); }
  });
  it("rechecks withdrawn review after the handler's awaited DB read", async () => {
    const fault = { armed: false, reads: 0 };
    const h = await setup(() => {
      const client = runtime();
      return { connect: () => client.connect(), end: () => client.end(), on: (event, listener) => client.on(event, listener),
        async query<R extends QueryResultRow>(sql: string, values?: unknown[]) {
          const result = await client.query<R>(sql, values);
          if (fault.armed && sql === "COMMIT" && ++fault.reads === 2) h.reviewed.source.current = undefined;
          return result;
        } };
    });
    const a = await prepareLocalReuseAdmission(h.requests, await h.input(), h.config), g = h.gate(a), token = await g.prepare(a.intent);
    fault.armed = true;
    await expect(g.execute(token)).rejects.toMatchObject({ effectMayHaveStarted: false });
    expect(fault.reads).toBe(2);
  });
  it("does not release results after cancellation or a lost read COMMIT reply", async () => {
    const fault = { armed: false };
    const h = await setup(() => {
      const client = runtime();
      return { connect: () => client.connect(), end: () => client.end(), on: (event, listener) => client.on(event, listener),
        async query<R extends QueryResultRow>(sql: string, values?: unknown[]) {
          const result = await client.query<R>(sql, values); if (fault.armed && sql === "COMMIT") throw Error("Lost read COMMIT reply"); return result;
        } };
    });
    const stop = AbortSignal.abort();
    await expect(prepareLocalReuseAdmission(h.requests, await h.input(), h.config, stop)).rejects.toThrow();
    const a = await prepareLocalReuseAdmission(h.requests, await h.input(), h.config), g = h.gate(a), token = await g.prepare(a.intent), before = await h.snapshot();
    await expect(a.database.inspect(a.intent, h.config.scopeSha256, stop)).rejects.toThrow();
    fault.armed = true; await expect(g.execute(token)).rejects.toThrow(); expect(await h.snapshot()).toEqual(before);
    expect(() => writer!.assertHealthy()).toThrow();
  });
});
