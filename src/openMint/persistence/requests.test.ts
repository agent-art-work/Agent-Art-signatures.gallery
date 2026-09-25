import { randomUUID } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { assessmentDigest, type UnsignedAssessment } from "../assessment.js";
import { LEGACY_MAPPING_VERSION, LEGACY_RENDERER_VERSION, seedForMbti } from "../identity.js";
import { opaqueCode } from "../security.js";
import { OpenMintRepository, type InitialAdmission } from "./repository.js";
import { PostgresMintRequests, type CreateDurableMintRequest } from "./requests.js";
import { capabilityHash } from "./sessions.js";
import { ExclusiveWriter, type OwnershipConnection } from "./writer.js";
import { assessment, bytes, namespace } from "./fixtures/data.js";
import { chainHash, eligibilityFixture } from "./fixtures/eligibility.js";

const alice = privateKeyToAccount(`0x${"1".repeat(64)}`).address, bob = privateKeyToAccount(`0x${"2".repeat(64)}`).address;
type Row = Record<string, any>;
async function harness() {
  const ns = namespace(), deploymentId = randomUUID(), token = opaqueCode(), csrf = opaqueCode();
  let now = Date.parse("2026-09-20T00:00:00Z");
  const gate = eligibilityFixture(ns.id, deploymentId, () => now), calls: { sql: string; values: unknown[] }[] = [];
  const state = { profile: { ...gate.profile } as Row | undefined, count: "0", expireAfterInsert: 0,
    terminal: undefined as { kind: string; reason: string | null; phase: string } | undefined,
    session: { session_hash: capabilityHash(token), csrf, expires_at: new Date(now + 86400000), generation: "1", revoked: false,
      wallet: alice, proof_wallet: alice, proof_code_hash: null, proof_expires_at: new Date(now + 600000), active_challenge_hash: null } as Row | undefined,
    request: undefined as Row | undefined, assessment: undefined as ReturnType<typeof assessment> | undefined,
    admission: { kind: "created", attemptId: randomUUID(), jobId: randomUUID() } as InitialAdmission };
  const tx: Pick<OwnershipConnection, "query"> = { async query<R extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<R>> {
    calls.push({ sql, values }); let rows: unknown[] = [];
    if (sql.includes("FROM open_mint.request_profiles")) rows = state.profile ? [state.profile] : [];
    else if (sql.includes("clock_timestamp")) rows = [{ now: new Date(now) }];
    else if (sql.includes("FROM open_mint.sessions")) rows = state.session && state.session.session_hash === values[1] ? [state.session] : [];
    else if (sql.includes("FROM open_mint.assessment_terminals")) rows = state.terminal ? [state.terminal] : [];
    else if (sql.includes("count(*)")) rows = [{ count: state.count }];
    else if (sql.startsWith("INSERT INTO open_mint.requests")) {
      state.request = { request_id: values[1], code_hash: values[2], wallet: values[6], handle: values[7], requested_handle: values[8], created_at: values[9], expires_at: values[10],
        attempt_id: values[11], assessment_id: values[12], current_assessment_id: null, assessment_payload: null, assessment_digest: null };
      now += state.expireAfterInsert;
    } else if (sql.includes("FROM open_mint.requests r")) {
      const row = state.request;
      if (row && row.code_hash === values[2]) rows = [{ ...row, current_assessment_id: state.assessment?.id ?? null,
        assessment_payload: state.assessment ? bytes(state.assessment) : null, assessment_digest: state.assessment?.digest ?? null,
        terminal_kind: state.terminal?.kind ?? null, terminal_reason: state.terminal?.reason ?? null, terminal_phase: state.terminal?.phase ?? null }];
    } else throw new Error(`Unexpected query: ${sql}`);
    return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] } as QueryResult<R>;
  } };
  const writer = { epoch: "1", transaction: <T>(work: (connection: typeof tx) => Promise<T>) => Promise.resolve().then(() => work(tx)) } as ExclusiveWriter;
  const admit = vi.fn(async (): Promise<InitialAdmission> => state.admission);
  const repository = { writer, namespace: ns, admissionTransaction: <T>(work: (connection: typeof tx, admit: (value: string) => Promise<InitialAdmission>) => Promise<T>) => writer.transaction(transaction => work(transaction, admit)) } as OpenMintRepository;
  const requests = await PostgresMintRequests.open(repository, deploymentId);
  const input: CreateDurableMintRequest = { sessionToken: token, origin: gate.profile.origin, csrf, sessionGeneration: "1", recipient: alice, handle: "@ALIce", eligibility: await gate.witness("alice", alice) };
  return { requests, repository, gate, state, calls, input, admit, deploymentId, token, advance: (ms: number) => { now += ms; } };
}

describe("durable private request admission boundaries", () => {
  it("does not turn the ordinary local request path into a staging guard bypass", async () => {
    const h = await harness(), guard = vi.fn(async () => {});
    await expect(h.requests.createGuardedStaging(h.input, guard)).rejects.toThrow("Guarded staging request binding required");
    await expect(h.requests.createGuardedStaging(h.input, undefined as never)).rejects.toThrow("Guarded staging request binding required");
    expect(guard).not.toHaveBeenCalled(); expect(h.admit).not.toHaveBeenCalled();
  });
  it("validates deployment ID and immutable session/deployment chain profile", async () => {
    const h = await harness();
    await expect(PostgresMintRequests.open(h.repository, "invalid")).rejects.toThrow("identifier");
    h.state.profile!.session_chain_id = "1";
    await expect(PostgresMintRequests.open(h.repository, h.deploymentId)).rejects.toThrow("profile mismatch");
    h.state.profile = undefined; await expect(PostgresMintRequests.open(h.repository, h.deploymentId)).rejects.toThrow("profile mismatch");
  });
  it("checks current session under the transaction and stores only a capability hash with fixed preserved spelling/lifetime", async () => {
    const h = await harness(), request = await h.requests.create(h.input);
    expect(request.handle).toBe("alice"); expect(request.requestedHandle).toBe("ALIce"); expect(request.expiresAt - request.createdAt).toBe(900000);
    expect(request.status).toBe("pending-assessment"); expect(h.state.request!.code_hash).toBe(capabilityHash(request.code));
    expect(JSON.stringify(h.calls)).not.toContain(request.code);
    expect(h.admit).toHaveBeenCalledTimes(1); expect(h.admit).toHaveBeenCalledWith("alice");
    expect(await h.requests.get(request.code, h.token)).toEqual(request);
  });
  it.each(["origin", "csrf", "missing-csrf", "missing", "revoked", "expired"])("rejects %s sessions before admission", async failure => {
    const h = await harness(); let input = h.input;
    if (failure === "origin") input = { ...input, origin: "https://evil.example" };
    else if (failure === "csrf") input = { ...input, csrf: opaqueCode() };
    else if (failure === "missing-csrf") input = { ...input, csrf: undefined };
    else if (failure === "missing") h.state.session = undefined;
    else if (failure === "revoked") h.state.session!.revoked = true;
    else h.state.session!.expires_at = new Date(0);
    await expect(h.requests.create(input)).rejects.toMatchObject({ code: "SESSION_REQUIRED" }); expect(h.admit).not.toHaveBeenCalled();
  });
  it.each(["generation", "invalid-generation", "recipient", "proof-wallet", "missing-proof", "proof-expired", "scoped-proof", "challenge"])("rejects stale or scoped preparation proof: %s", async failure => {
    const h = await harness(); let input = h.input;
    if (failure === "generation") h.state.session!.generation = "2";
    else if (failure === "invalid-generation") input = { ...input, sessionGeneration: "-1" };
    else if (failure === "recipient") h.state.session!.wallet = bob;
    else if (failure === "proof-wallet") h.state.session!.proof_wallet = bob;
    else if (failure === "missing-proof") h.state.session!.proof_expires_at = null;
    else if (failure === "proof-expired") h.state.session!.proof_expires_at = new Date(0);
    else if (failure === "scoped-proof") h.state.session!.proof_code_hash = "ab".repeat(32);
    else h.state.session!.active_challenge_hash = "ab".repeat(32);
    await expect(h.requests.create(input)).rejects.toThrow(); expect(h.admit).not.toHaveBeenCalled();
  });
  it.each([undefined, true, {}, { eligible: true }])("rejects caller-authored chain eligibility %j", async eligibility => {
    const h = await harness(); await expect(h.requests.create({ ...h.input, eligibility })).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE" }); expect(h.admit).not.toHaveBeenCalled();
  });
  it.each(["expired", "handle", "recipient", "deployment", "namespace"])("rejects authentically issued but wrong %s chain evidence", async mismatch => {
    const h = await harness(); let eligibility = h.input.eligibility;
    if (mismatch === "expired") h.advance(10000);
    else eligibility = await h.gate.witness(mismatch === "handle" ? "bob" : "alice", mismatch === "recipient" ? bob : alice,
      mismatch === "deployment" ? { deploymentId: randomUUID() } : mismatch === "namespace" ? { namespaceId: randomUUID() } : {});
    await expect(h.requests.create({ ...h.input, eligibility })).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE" }); expect(h.admit).not.toHaveBeenCalled();
  });
  it.each(["chain_id", "contract_address", "genesis_hash", "runtime_code_hash", "authorizer", "deployment_block", "deployment_block_hash"])("compares trusted witness against the database's %s pin", async field => {
    const h = await harness(); h.state.profile![field] = field === "chain_id" || field === "deployment_block" ? "1" : field === "contract_address" || field === "authorizer" ? bob.toLowerCase() : chainHash("99");
    if (field === "chain_id") h.state.profile!.session_chain_id = "1";
    const requests = await PostgresMintRequests.open(h.repository, h.deploymentId);
    await expect(requests.create(h.input)).rejects.toMatchObject({ code: "CHAIN_PROFILE_MISMATCH" }); expect(h.admit).not.toHaveBeenCalled();
  });
  it("caps live requests before invoking assessment admission", async () => {
    const h = await harness(); h.state.count = "10";
    await expect(h.requests.create(h.input)).rejects.toMatchObject({ code: "REQUEST_LIMIT" }); expect(h.admit).not.toHaveBeenCalled();
  });
  it.each(["max_evidence_age_ms", "max_block_age_ms"])("enforces the stored %s even when a gate has a looser policy", async field => {
    const h = await harness(); h.state.profile![field] = 100;
    const requests = await PostgresMintRequests.open(h.repository, h.deploymentId); h.advance(100);
    await expect(requests.create(h.input)).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE" }); expect(h.admit).not.toHaveBeenCalled();
  });
  it("captures mutable input before waiting on the transaction queue", async () => {
    const h = await harness(), input = { ...h.input }, pending = h.requests.create(input);
    input.handle = "bob"; input.csrf = "invalid"; input.recipient = bob; input.sessionGeneration = "2";
    expect((await pending).requestedHandle).toBe("ALIce");
  });
  it.each(["chain", "proof", "session"])("rechecks %s freshness after request writes", async boundary => {
    const h = await harness(); h.state.expireAfterInsert = boundary === "chain" ? 10000 : 600000;
    if (boundary === "session") h.state.session!.expires_at = new Date(Date.parse("2026-09-20T00:00:00Z") + 1000);
    await expect(h.requests.create(h.input)).rejects.toThrow();
    expect(h.calls.some(call => call.sql.startsWith("INSERT INTO open_mint.requests"))).toBe(true);
  });
  it("returns only accepted-result linkage and never implies publication/mint readiness", async () => {
    const h = await harness(), value = assessment(); h.state.admission = { kind: "accepted", assessment: value }; h.state.assessment = value;
    const result = await h.requests.create(h.input);
    expect(result.status).toBe("assessment-accepted"); expect(result.assessmentId).toBe(value.id);
    expect(result.attemptId).toBeUndefined(); expect(result).not.toHaveProperty("mbti");
    expect(await h.requests.get(result.code, h.token)).toEqual(result);
  });
  it.each(["native", "legacy"])("refuses restored identity-less %s Grok results on private request reads", async version => {
    const h = await harness(), created = await h.requests.create(h.input);
    Object.assign(h.repository.namespace, { provenance: "grok", profile: "local-real" });
    const { digest: _, xIdentity: _identity, ...unsigned } = assessment("alice", {
      provenance: "grok", model: "grok-4-1", providerResponseId: "synthetic-real-response", sourceUrls: ["https://x.com/alice"],
    });
    const restored: UnsignedAssessment = version === "legacy" ? { ...unsigned, rendererVersion: LEGACY_RENDERER_VERSION,
      mappingVersion: LEGACY_MAPPING_VERSION, seed: seedForMbti(unsigned.mbti) } : unsigned;
    h.state.assessment = { ...restored, digest: assessmentDigest(restored) };
    await expect(h.requests.get(created.code, h.token)).rejects.toThrow("lacks verified X identity");
    expect(h.admit).toHaveBeenCalledTimes(1);
  });
  it("privately reads expired requests without extending expiry or creating work", async () => {
    const h = await harness(), created = await h.requests.create(h.input); h.advance(900000);
    const read = await h.requests.get(created.code, h.token); expect(read).toEqual(created); expect(h.admit).toHaveBeenCalledTimes(1);
    await expect(h.requests.get("invalid", h.token)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(h.requests.get(opaqueCode(), h.token)).rejects.toMatchObject({ code: "NOT_FOUND" });
    h.state.session!.wallet = bob;
    await expect(h.requests.get(created.code, h.token)).rejects.toMatchObject({ code: "REQUEST_WALLET_MISMATCH" });
  });
  it.each(["expiry", "handle", "spelling", "missing-assessment", "assessment-scope", "assessment-id"])("refuses corrupt stored request metadata: %s", async corruption => {
    const h = await harness(), created = await h.requests.create(h.input);
    if (corruption === "expiry") h.state.request!.expires_at = new Date(0);
    else if (corruption === "handle") h.state.request!.handle = "ALICE";
    else if (corruption === "spelling") h.state.request!.requested_handle = "bob";
    else if (corruption === "missing-assessment") h.state.request!.assessment_id = randomUUID();
    else if (corruption === "assessment-scope") h.state.assessment = assessment("bob");
    else { h.state.assessment = assessment(); h.state.request!.assessment_id = randomUUID(); }
    await expect(h.requests.get(created.code, h.token)).rejects.toThrow();
  });
  it.each(["abstained", "invalid", "uncertain", "blocked-before-dispatch"])("projects %s terminal facts on joined creation and private reads", async kind => {
    const h = await harness(); h.state.terminal = { kind, reason: kind === "abstained" ? "provider-refusal" : null, phase: kind === "blocked-before-dispatch" ? "before-dispatch" : "grok" };
    h.state.admission = { kind: "joined", attemptId: randomUUID(), jobId: randomUUID() };
    const created = await h.requests.create(h.input);
    expect(created.status).toBe(kind === "blocked-before-dispatch" ? "assessment-blocked" : `assessment-${kind}`);
    expect(await h.requests.get(created.code, h.token)).toEqual(created);
    h.state.assessment = assessment(); await expect(h.requests.get(created.code, h.token)).rejects.toThrow("conflicting accepted and terminal");
  });
});
