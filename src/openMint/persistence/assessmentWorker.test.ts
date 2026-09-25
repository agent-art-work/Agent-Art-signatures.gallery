import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { QueryResult, QueryResultRow } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { Assessment, AssessmentProvider } from "../assessment.js";
import type { AssessmentExecution, ProviderLeg, ProviderReceipt } from "../assessmentOperations.js";
import { opaqueCode } from "../security.js";
import { XApiIdentityResolver } from "../xIdentity.js";
import { PostgresAssessmentWorker, type AssessmentWorkerIntent } from "./assessmentWorker.js";
import type { AssessmentTerminal, ExecutionTransaction, OpenMintRepository, TerminalOutcome } from "./repository.js";
import type { PostgresMintRequests } from "./requests.js";
import { capabilityHash } from "./sessions.js";
import type { OwnershipConnection } from "./writer.js";
import { assessment, identity, namespace, receipt } from "./fixtures/data.js";
import { eligibilityFixture } from "./fixtures/eligibility.js";

const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
async function harness() {
  const ns = namespace(), deploymentId = randomUUID(), token = opaqueCode(), csrf = opaqueCode(), code = opaqueCode();
  let now = Date.parse("2026-09-20T00:00:00Z"), inTransaction = false;
  const gate = eligibilityFixture(ns.id, deploymentId, () => now), events: string[] = [], attemptId = randomUUID();
  const state = { healthy: true, claimed: false, finished: false, accepted: undefined as Assessment | undefined,
    fences: new Set<ProviderLeg>(),
    terminal: undefined as AssessmentTerminal | undefined, receipt: new Map<ProviderLeg, ProviderReceipt>(),
    session: { generation: "1", wallet: account.address, csrf, revoked: false, expires_at: new Date(now + 86400000), proof_wallet: account.address,
      proof_code_hash: null as string | null, proof_expires_at: new Date(now + 600000), active_challenge_hash: null as string | null },
    request: { request_id: randomUUID(), handle: "alice", wallet: account.address, expires_at: new Date(now + 900000), attempt_id: attemptId as string | null, assessment_id: null as string | null },
    fail: "", afterClaim: undefined as (() => void) | undefined, afterFence: undefined as (() => void) | undefined };
  const tx: Pick<OwnershipConnection, "query"> = { async query<R extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<R>> {
    let rows: unknown[] = [];
    if (sql.includes("clock_timestamp")) rows = [{ now: new Date(now) }];
    else if (sql.includes("FROM open_mint.sessions")) rows = values[1] === capabilityHash(token) ? [state.session] : [];
    else if (sql.includes("FROM open_mint.requests")) rows = values[2] === capabilityHash(code) && values[3] === capabilityHash(token) ? [state.request] : [];
    else throw new Error(`Unexpected SQL: ${sql}`);
    return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] } as QueryResult<R>;
  } };
  const assertHealthy = () => { if (!state.healthy) throw new Error("writer lost"); };
  const writer = { epoch: "1", assertHealthy, transaction: async <T>(work: (connection: typeof tx) => Promise<T>): Promise<T> => {
    assertHealthy(); inTransaction = true; events.push("begin");
    const priorFences = new Set(state.fences), priorClaim = state.claimed;
    try { const result = await work(tx); assertHealthy(); events.push("commit"); return result; }
    catch (error) { state.fences = priorFences; state.claimed = priorClaim; events.push("rollback"); throw error; }
    finally { inTransaction = false; }
  } };
  const operations: ExecutionTransaction = {
    inspectDispatch: async () => { throw new Error("Not used by the legacy worker path"); },
    getAssessment: async () => state.accepted,
    claimInitial: async () => { if (state.claimed) throw new Error("already claimed"); state.claimed = true; events.push("claim"); state.afterClaim?.(); },
    beforeDispatch: async (_id, leg) => { if (state.finished || state.fail === "fence") throw new Error("fence failed"); state.fences.add(leg); events.push(`fence:${leg}`); state.afterFence?.(); },
  };
  const repository = { namespace: ns, writer,
    executionTransaction: <T>(work: (connection: typeof tx, operations: ExecutionTransaction) => Promise<T>) => writer.transaction(connection => work(connection, operations)),
    getAssessment: async () => state.accepted,
    recordReceipt: async (_id: string, payload: Buffer) => { if (state.fail === "receipt") throw new Error("receipt failed"); const value = JSON.parse(payload.toString()); state.receipt.set(value.leg, value); events.push(`receipt:${value.leg}`); },
    recordIdentity: async () => { if (state.fail === "identity") throw new Error("identity failed"); events.push("identity"); },
    acceptAssessment: async (_id: string, payload: Buffer) => { if (state.fail === "accepted") throw new Error("accepted failed"); state.accepted = JSON.parse(payload.toString()); events.push("accepted"); return state.accepted!; },
    getReceipt: async (_id: string, leg: ProviderLeg) => state.receipt.get(leg),
    finishAttempt: vi.fn(async (_id: string, outcome: TerminalOutcome) => {
      if (state.fail === "terminal") throw new Error("terminal failed"); state.finished = true;
      const phase = state.fences.has("grok") ? "grok" : state.fences.has("x-identity") ? "x-identity" : "before-dispatch";
      state.terminal = { ...outcome, phase }; events.push(`terminal:${outcome.kind}`); return state.terminal;
    }),
    interruptAttempt: async () => {
      const phase = state.fences.has("grok") ? "grok" : state.fences.has("x-identity") ? "x-identity" : "before-dispatch";
      state.finished = true; state.terminal = { kind: phase === "before-dispatch" ? "blocked-before-dispatch" : "uncertain", phase }; return state.terminal;
    },
  } as unknown as OpenMintRepository;
  const requests = { repository, profile: gate.profile } as unknown as PostgresMintRequests;
  const provider: AssessmentProvider = { provenance: "development-fixture", model: "development-fixture-v1", assess: vi.fn<AssessmentProvider["assess"]>(async (handle, xIdentity, execution) => {
    expect(inTransaction).toBe(false); events.push("provider"); await execution!.recordReceipt(receipt("grok"));
    return { handle, mbti: "INTJ", model: "development-fixture-v1", providerResponseId: "development-fixture:test", sourceUrls: [], xUserId: xIdentity!.userId };
  }) };
  const resolver = { provenance: "development-fixture" as const, resolve: vi.fn(async (handle: string, execution?: AssessmentExecution) => {
    expect(inTransaction).toBe(false); events.push("resolver"); await execution!.recordReceipt(receipt("x-identity")); return identity(handle);
  }) };
  const refresh = vi.fn(async ({ handle, recipient }: { handle: string; recipient: Address }) => {
    expect(inTransaction).toBe(false); events.push("preflight"); return gate.witness(handle, recipient);
  });
  const options = { timeoutMs: 1000, provider, identityResolver: resolver, refreshEligibility: refresh }, worker = new PostgresAssessmentWorker(requests, options);
  const input: AssessmentWorkerIntent = { code, sessionToken: token, sessionGeneration: "1", origin: gate.profile.origin, csrf, eligibility: await gate.witness("alice", account.address) };
  return { worker, requests, options, input, state, events, provider, resolver, refresh, repository, advance: (ms: number) => { now += ms; } };
}

describe("explicit durable assessment worker", () => {
  it("runs a fresh coordinator only after claim/fence commit and persists receipt before identity/result", async () => {
    const h = await harness(), result = await h.worker.run(h.input);
    expect(result.kind).toBe("accepted"); expect(result).toMatchObject({ reused: false, assessment: { handle: "alice", mbti: "INTJ" } });
    for (const [first, second] of [["claim", "fence:x-identity"], ["fence:x-identity", "resolver"], ["receipt:x-identity", "identity"],
      ["identity", "fence:grok"], ["fence:grok", "provider"], ["receipt:grok", "accepted"]]) expect(h.events.indexOf(first)).toBeLessThan(h.events.indexOf(second));
    expect(h.events[h.events.indexOf("resolver") - 1]).toBe("commit"); expect(h.events[h.events.indexOf("provider") - 1]).toBe("commit");
    expect(h.refresh).toHaveBeenCalledTimes(2);
    await expect(h.worker.run(h.input)).resolves.toMatchObject({ kind: "accepted", reused: true }); expect(h.provider.assess).toHaveBeenCalledTimes(1);
  });
  it("reuses a saved result without generation adapters", async () => {
    const h = await harness(); h.state.accepted = assessment();
    await expect(new PostgresAssessmentWorker(h.requests, { timeoutMs: 1000 }).run(h.input)).resolves.toMatchObject({ reused: true });
    expect(h.state.claimed).toBe(false); expect(h.refresh).not.toHaveBeenCalled();
  });
  it.each(["missing-code", "cookie", "origin", "csrf", "generation", "expired", "revoked", "proof", "scope", "challenge", "witness"])("blocks %s before claiming or external work", async fault => {
    const h = await harness(); let input = h.input;
    if (fault === "missing-code") input = { ...input, code: opaqueCode() };
    else if (fault === "cookie") input = { ...input, sessionToken: opaqueCode() };
    else if (fault === "origin") input = { ...input, origin: "https://wrong.example" };
    else if (fault === "csrf") input = { ...input, csrf: opaqueCode() };
    else if (fault === "generation") input = { ...input, sessionGeneration: "2" };
    else if (fault === "expired") h.state.request.expires_at = new Date(0);
    else if (fault === "revoked") h.state.session.revoked = true;
    else if (fault === "proof") h.state.session.proof_expires_at = new Date(0);
    else if (fault === "scope") h.state.session.proof_code_hash = capabilityHash(opaqueCode());
    else if (fault === "challenge") h.state.session.active_challenge_hash = "ab".repeat(32);
    else input = { ...input, eligibility: { eligible: true } };
    await expect(h.worker.run(input)).rejects.toThrow(); expect(h.state.claimed).toBe(false); expect(h.resolver.resolve).not.toHaveBeenCalled();
  });
  it("accepts only the matching request-scoped proof", async () => {
    const h = await harness(); h.state.session.proof_code_hash = capabilityHash(h.input.code);
    await expect(h.worker.run(h.input)).resolves.toMatchObject({ kind: "accepted" });
  });
  it.each(["claim", "fence"])("rechecks context after the %s write before its commit", async point => {
    const h = await harness(), expire = () => { h.advance(600000); };
    if (point === "claim") h.state.afterClaim = expire; else h.state.afterFence = expire;
    if (point === "claim") await expect(h.worker.run(h.input)).rejects.toThrow();
    else await expect(h.worker.run(h.input)).resolves.toMatchObject({ kind: "terminal", outcome: { kind: "blocked-before-dispatch" } });
    expect(h.resolver.resolve).not.toHaveBeenCalled(); expect(h.events).toContain("rollback");
  });
  it.each(["receipt", "identity", "accepted"])("preserves the claimed record on %s persistence failure instead of synthesizing terminal evidence", async fault => {
    const h = await harness(); h.state.fail = fault;
    await expect(h.worker.run(h.input)).rejects.toThrow(`${fault} failed`); expect(h.repository.finishAttempt).not.toHaveBeenCalled();
    await expect(h.worker.run(h.input)).rejects.toThrow("already claimed");
  });
  it("persists a validated abstention and never labels its storage failure invalid", async () => {
    const h = await harness(); vi.mocked(h.provider.assess).mockImplementation(async (handle, identity, execution) => {
      await execution!.recordReceipt(receipt("grok")); return { kind: "abstained", reason: "insufficient-evidence", handle, model: h.provider.model,
        providerResponseId: "development-fixture:abstention", xUserId: identity!.userId };
    });
    await expect(h.worker.run(h.input)).resolves.toMatchObject({ kind: "terminal", outcome: { kind: "abstained", reason: "insufficient-evidence" } });
    expect(h.state.accepted).toBeUndefined();
    const failed = await harness(); failed.state.fail = "terminal"; vi.mocked(failed.provider.assess).mockImplementation(vi.mocked(h.provider.assess).getMockImplementation()!);
    await expect(failed.worker.run(failed.input)).rejects.toThrow("terminal failed"); expect(failed.repository.finishAttempt).toHaveBeenCalledTimes(1);
    expect(failed.repository.finishAttempt).toHaveBeenCalledWith(failed.state.request.attempt_id, { kind: "abstained", reason: "insufficient-evidence" }, expect.any(Function));
  });
  it("records invalid only for a returned malformed semantic response with a successful receipt", async () => {
    const h = await harness(); vi.mocked(h.provider.assess).mockImplementation(async (_handle, _identity, execution) => {
      await execution!.recordReceipt(receipt("grok")); return { nonsense: "not persisted" } as never;
    });
    await expect(h.worker.run(h.input)).resolves.toMatchObject({ outcome: { kind: "invalid", phase: "grok" } });
  });
  it.each(["semantics", "body", "transport"])("classifies the actual X resolver's mocked %s failure without starting Grok", async failure => {
    const h = await harness(); Object.assign(h.repository.namespace, { profile: "local-real", provenance: "grok" });
    const fetch = vi.fn(async () => {
      if (failure === "transport") throw new Error("private transport detail");
      return new Response(failure === "body" ? "not JSON" : JSON.stringify({ data: { id: "123", username: "wrong" } }));
    }) as typeof globalThis.fetch;
    const provider: AssessmentProvider = { provenance: "grok", model: "grok-offline", assess: vi.fn() };
    const worker = new PostgresAssessmentWorker(h.requests, { timeoutMs: 1000, provider, refreshEligibility: h.refresh,
      identityResolver: new XApiIdentityResolver({ bearerToken: "offline-mock-token", fetch }) });
    await expect(worker.run(h.input)).resolves.toMatchObject({ outcome: { kind: failure === "semantics" ? "invalid" : "uncertain", phase: "x-identity" } });
    expect(provider.assess).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.state.receipt.get("x-identity")?.category).toBe(failure === "semantics" ? "success" : failure === "body" ? "invalid-body" : "transport-error");
  });
  it("preserves uncertainty after transport rejection and rejects late callbacks", async () => {
    const h = await harness(); let execution: AssessmentExecution | undefined;
    vi.mocked(h.resolver.resolve).mockImplementation(async (_handle, hooks) => { execution = hooks; throw new Error("private transport details"); });
    await expect(h.worker.run(h.input)).resolves.toMatchObject({ outcome: { kind: "uncertain", phase: "x-identity" } });
    await expect(execution!.recordReceipt(receipt("x-identity"))).rejects.toThrow("EXECUTION_FINISHED");
    expect(JSON.stringify(h.state.terminal)).not.toContain("private"); expect(h.provider.assess).not.toHaveBeenCalled();
  });
  it("does not dispatch Grok after logout during the X call", async () => {
    const h = await harness(), original = vi.mocked(h.resolver.resolve).getMockImplementation()!;
    vi.mocked(h.resolver.resolve).mockImplementation(async (...args) => { const value = await original(...args); h.state.session.revoked = true; return value; });
    await expect(h.worker.run(h.input)).resolves.toMatchObject({ outcome: { kind: "uncertain", phase: "x-identity" } });
    expect(h.provider.assess).not.toHaveBeenCalled(); expect(h.events).not.toContain("fence:grok");
  });
  it("does not invoke a provider if ownership disappears immediately after a fence", async () => {
    const h = await harness(); h.state.afterFence = () => { h.state.healthy = false; };
    await expect(h.worker.run(h.input)).rejects.toThrow("writer lost"); expect(h.resolver.resolve).not.toHaveBeenCalled(); expect(h.repository.finishAttempt).not.toHaveBeenCalled();
  });
  it("snapshots caller intent before queued work and refuses missing generation/public configuration", async () => {
    const h = await harness(), mutable = { ...h.input }, pending = h.worker.run(mutable); mutable.csrf = opaqueCode(); mutable.code = opaqueCode();
    await expect(pending).resolves.toMatchObject({ kind: "accepted" });
    const absent = await harness(); await expect(new PostgresAssessmentWorker(absent.requests, { timeoutMs: 1000 }).run(absent.input)).rejects.toThrow("GENERATION_NOT_CONFIGURED");
    Object.assign(absent.repository.namespace, { profile: "production" }); expect(() => new PostgresAssessmentWorker(absent.requests, { timeoutMs: 1000 })).toThrow("PUBLIC_WORKER_DISABLED");
  });
  it.each([0, -1, NaN, 1.5, 180001])("refuses unbounded/invalid whole-run deadline %s", async timeoutMs => {
    const h = await harness(); expect(() => new PostgresAssessmentWorker(h.requests, { ...h.options, timeoutMs })).toThrow("INVALID_EXECUTION_DEADLINE");
  });
  it("bounds a hung fresh-chain callback and aborts without dispatch", async () => {
    const h = await harness(); let signal: AbortSignal | undefined;
    const worker = new PostgresAssessmentWorker(h.requests, { ...h.options, timeoutMs: 20,
      refreshEligibility: async (_input, abort) => { signal = abort; return new Promise(() => undefined); } });
    await expect(worker.run(h.input)).resolves.toMatchObject({ outcome: { kind: "blocked-before-dispatch" } });
    expect(signal?.aborted).toBe(true); expect(h.resolver.resolve).not.toHaveBeenCalled();
  });
  it("rejects late provider receipts, semantic outcome and accepted result after whole-run timeout", async () => {
    const h = await harness(); let release!: () => void, arrived!: () => void, execution: AssessmentExecution | undefined;
    const arrivedPromise = new Promise<void>(resolve => { arrived = resolve; }), delayed = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(h.provider.assess).mockImplementation(async (handle, identity, hooks) => {
      execution = hooks; arrived(); await delayed;
      return { handle, mbti: "INTJ", model: h.provider.model, providerResponseId: "development-fixture:late", sourceUrls: [], xUserId: identity!.userId };
    });
    // Advance only after Grok is reached; CPU load must not move the timeout to an earlier phase.
    let elapsed = 0;
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = new PostgresAssessmentWorker(h.requests, { ...h.options, timeoutMs: 30 }).run(h.input); await arrivedPromise;
      elapsed = 31; await vi.advanceTimersByTimeAsync(31);
      await expect(pending).resolves.toMatchObject({ outcome: { kind: "uncertain", phase: "grok" } });
      await expect(execution!.recordReceipt(receipt("grok"))).rejects.toThrow("deadline exceeded");
      await expect(execution!.identityVerified(identity())).rejects.toThrow("deadline exceeded");
      release(); await vi.advanceTimersByTimeAsync(0);
      expect(h.state.accepted).toBeUndefined(); expect(h.state.receipt.has("grok")).toBe(false);
    } finally { release(); monotonic.mockRestore(); vi.useRealTimers(); }
  });
  it("checks elapsed monotonic time even before the timer can run", async () => {
    const h = await harness(), spy = vi.spyOn(performance, "now").mockImplementation(() => h.events.includes("claim") ? 2000 : 0);
    try { await expect(h.worker.run(h.input)).rejects.toThrow("deadline exceeded"); }
    finally { spy.mockRestore(); }
    expect(h.resolver.resolve).not.toHaveBeenCalled(); expect(h.events).toContain("rollback");
  });
  it("cancelled input cannot claim or call a provider", async () => {
    const h = await harness(), abort = new AbortController(); abort.abort();
    await expect(h.worker.run(h.input, abort.signal)).rejects.toThrow("cancelled");
    expect(h.state.claimed).toBe(false); expect(h.resolver.resolve).not.toHaveBeenCalled();
  });
  it("records interruption from committed fences after cancellation and rejects late persistence", async () => {
    const h = await harness(), abort = new AbortController(); let received!: () => void, release!: () => void, execution: AssessmentExecution | undefined;
    const ready = new Promise<void>(r => { received = r; }), hold = new Promise<void>(r => { release = r; });
    vi.mocked(h.provider.assess).mockImplementation(async (_handle, _identity, value) => { execution = value; received(); await hold; throw Error("late failure"); });
    const pending = h.worker.run(h.input, abort.signal); await ready; abort.abort();
    await expect(pending).resolves.toMatchObject({ kind: "terminal", outcome: { kind: "uncertain", phase: "grok" } });
    await expect(execution!.recordReceipt(receipt("grok"))).rejects.toThrow("cancelled"); release();
    expect(h.state.accepted).toBeUndefined();
  });
});
