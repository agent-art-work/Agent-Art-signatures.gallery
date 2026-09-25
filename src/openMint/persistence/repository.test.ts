import { randomUUID } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { ProviderLeg } from "../assessmentOperations.js";
import { OpenMintRepository, AdmissionBlockedError, validateAssessmentTerminal } from "./repository.js";
import { ExclusiveWriter, PersistenceConflictError, type OwnershipConnection } from "./writer.js";
import { assessment, bytes, identity, namespace, receipt } from "./fixtures/data.js";

/** Scripted database rows exercise repository boundaries, not SQL isolation.
 * The opt-in disposable PostgreSQL suite proves the latter separately. */
async function harness() {
  const ns = namespace(), id = randomUUID(), jobId = randomUUID();
  const state = {
    namespace: { profile: ns.profile as string, provenance: ns.provenance as string, policy_version: ns.policyVersion },
    policy: { profile_version: "fixture-profile-1", expected_model: "development-fixture-v1", generation_enabled: true, valid_until: new Date("2099-01-01"),
      max_total: 20, max_daily: 10, max_active: 1, max_queued: 100, reservation_usd_ticks: "100", max_exposure_usd_ticks: "1000" } as Record<string, unknown> | undefined,
    attempt: { attempt_id: id, handle: "alice", profile_version: "fixture-profile-1", state: "pending" } as Record<string, unknown> | undefined,
    job: { owner_epoch: "1", state: "running" },
    assessment: undefined as ReturnType<typeof assessment> | undefined,
    assessmentDigest: undefined as string | undefined,
    assessmentBytes: undefined as Buffer | undefined,
    receipt: new Map<ProviderLeg, Buffer>([["x-identity", bytes(receipt("x-identity"))], ["grok", bytes(receipt("grok"))]]),
    receiptCost: undefined as string | undefined,
    identity: bytes(identity()) as Buffer | undefined,
    fence: "1" as string | undefined,
    dispatchLegs: ["x-identity", "grok"] as ProviderLeg[],
    terminal: undefined as { kind: string; reason: string | null; phase: string } | undefined,
    joined: false, inserted: 1, unresolved: false, alreadyDispatched: false,
    totals: { total: "0", daily: "0", exposure: "0" }, counts: { active: "0", queued: "0" },
  };
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx: Pick<OwnershipConnection, "query"> = {
    async query<R extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<R>> {
      calls.push({ sql, values });
      let rows: unknown[] = [];
      if (sql.includes("FROM open_mint.namespaces")) rows = [state.namespace];
      else if (sql.includes("FROM open_mint.assessment_terminals")) rows = state.terminal ? [state.terminal] : [];
      else if (sql.startsWith("INSERT INTO open_mint.assessment_terminals")) state.terminal = { kind: values[2] as string, reason: values[3] as string | null, phase: values[4] as string };
      else if (sql.startsWith("SELECT leg FROM open_mint.dispatch_fences")) rows = state.dispatchLegs.map(leg => ({ leg }));
      else if (sql.startsWith("SELECT 1 FROM open_mint.dispatch_fences")) rows = state.alreadyDispatched ? [{}] : [];
      else if (sql.includes("FROM open_mint.budget_policies")) rows = state.policy ? [state.policy] : [];
      else if (sql.includes("clock_timestamp")) rows = [{ now: new Date("2026-09-20T00:00:00.000Z") }];
      else if (sql.includes("FROM open_mint.assessments")) rows = state.assessment ? [{ payload: state.assessmentBytes ?? bytes(state.assessment), handle: state.assessment.handle, assessment_id: state.assessment.id, digest: state.assessmentDigest ?? state.assessment.digest }] : [];
      else if (sql.includes("JOIN open_mint.jobs")) rows = state.joined ? [{ attempt_id: id, job_id: jobId }] : [];
      else if (sql.includes("AS unresolved")) rows = [{ unresolved: state.unresolved }];
      else if (sql.includes("FROM open_mint.budget_reservations r")) rows = [state.totals];
      else if (sql.includes("AS active")) rows = [state.counts];
      else if (sql.startsWith("SELECT") && sql.includes("FROM open_mint.assessment_attempts")) rows = state.attempt ? [state.attempt] : [];
      else if (sql.startsWith("SELECT") && sql.includes("FROM open_mint.jobs")) rows = [state.job];
      else if (sql.includes("FROM open_mint.provider_receipts")) {
        const payload = state.receipt.get(values[2] as ProviderLeg);
        if (payload) { const value = JSON.parse(payload.toString()); rows = [{ payload, leg: value.leg, cost_status: state.receiptCost ?? value.cost.status, cost_usd_ticks: value.cost.amount ?? null }]; }
      } else if (sql.startsWith("SELECT") && sql.includes("FROM open_mint.dispatch_fences")) rows = state.fence ? [{ owner_epoch: state.fence }] : [];
      else if (sql.includes("FROM open_mint.verified_identities")) rows = state.identity ? [{ payload: state.identity }] : [];
      return { rows, rowCount: /^(INSERT|UPDATE)/.test(sql) ? state.inserted : rows.length, command: "", oid: 0, fields: [] } as QueryResult<R>;
    },
  };
  const writer = { epoch: "1", transaction: <T>(work: (connection: typeof tx) => Promise<T>) => Promise.resolve().then(() => work(tx)) } as ExclusiveWriter;
  const repo = await OpenMintRepository.open(writer, ns); calls.length = 0;
  return { state, calls, writer, repo, ns, id, jobId };
}

describe("open-mint repository ingestion and boundaries", () => {
  it("captures namespace before asynchronous queries and refuses mismatched configuration", async () => {
    const h = await harness();
    await expect(OpenMintRepository.open(h.writer, { ...h.ns, policyVersion: "unknown" })).rejects.toThrow("Unsupported namespace");
    await expect(OpenMintRepository.open(h.writer, { ...h.ns, id: "not-an-id" })).rejects.toThrow("identifier");
  });
  it("locks policy before handle and inserts admission, reservation and job together", async () => {
    const h = await harness(); expect((await h.repo.admitInitial("@ALIce")).kind).toBe("created");
    expect(h.calls[0].sql).toContain("budget_policies");
    expect(h.calls[1].values).toEqual([h.ns.id, "alice"]);
    const inserts = h.calls.filter(call => call.sql.startsWith("INSERT"));
    expect(inserts).toHaveLength(4);
    expect(inserts[1].values[1]).toBe(inserts[2].values[1]);
    expect(inserts[1].values[1]).toBe(inserts[3].values[2]);
    expect(inserts[2].values.slice(2)).toEqual(["2026-09-20", "100"]);
  });
  it.each(["total", "daily", "exposure", "active", "queued"] as const)("refuses exceeded %s before any attempt insertion", async limit => {
    const h = await harness();
    if (limit === "active" || limit === "queued") h.state.counts[limit] = "100";
    else h.state.totals[limit] = "1000";
    await expect(h.repo.admitInitial("alice")).rejects.toThrow(AdmissionBlockedError);
    expect(h.calls.some(call => call.sql.startsWith("INSERT INTO open_mint.assessment_attempts"))).toBe(false);
  });
  it.each(["missing", "disabled", "expired"])("refuses %s policies at admission, job claim and dispatch", async failure => {
    const h = await harness();
    if (failure === "missing") h.state.policy = undefined;
    else if (failure === "disabled") h.state.policy!.generation_enabled = false;
    else h.state.policy!.valid_until = new Date("2020-01-01");
    await expect(h.repo.admitInitial("alice")).rejects.toThrow(AdmissionBlockedError);
    await expect(h.repo.claimInitial(h.id)).rejects.toThrow(AdmissionBlockedError);
    await expect(h.repo.beforeDispatch(h.id, "x-identity")).rejects.toThrow(AdmissionBlockedError);
  });
  it("reuses a stored result or existing attempt with generation disabled", async () => {
    const h = await harness(); h.state.policy = undefined; h.state.joined = true;
    expect(await h.repo.admitInitial("alice")).toEqual({ kind: "joined", attemptId: h.id, jobId: h.jobId });
    h.state.assessment = assessment();
    expect(await h.repo.getAssessment("ALICE")).toEqual(h.state.assessment);
    expect((await h.repo.admitInitial("alice")).kind).toBe("accepted");
  });
  it("blocks unresolved real accounting before a new admission", async () => {
    const h = await harness(); h.state.namespace.profile = "local-real"; h.state.namespace.provenance = "grok";
    h.state.policy!.expected_model = "grok-4.3";
    const repo = await OpenMintRepository.open(h.writer, { ...h.ns, profile: "local-real", provenance: "grok" });
    h.state.unresolved = true; await expect(repo.admitInitial("alice")).rejects.toThrow("operator reconciliation");
    h.state.unresolved = false; expect((await repo.admitInitial("alice")).kind).toBe("created");
    h.state.policy!.reservation_usd_ticks = "0";
    await expect(repo.admitInitial("alice")).rejects.toThrow("positive exposure");
    await expect(repo.beforeDispatch(h.id, "x-identity")).rejects.toThrow("positive exposure");
    h.state.policy!.reservation_usd_ticks = "1"; h.state.policy!.expected_model = "development-fixture-v1";
    await expect(repo.beforeDispatch(h.id, "x-identity")).rejects.toThrow("namespace provenance");
  });
  it("validates saved bytes and indexed commitment fields", async () => {
    const h = await harness(); expect(await h.repo.getAssessment("alice")).toBeUndefined();
    h.state.assessment = assessment(); h.state.assessmentDigest = `0x${"00".repeat(32)}`;
    await expect(h.repo.getAssessment("alice")).rejects.toThrow("commitment mismatch");
    h.state.assessmentDigest = undefined; h.state.assessmentBytes = Buffer.from([0xc3, 0x28]);
    await expect(h.repo.getAssessment("alice")).rejects.toThrow();
  });
  it("provenance reads select only the accepted namespace/handle/commitment, without work admission", async () => {
    const h = await harness(), c = new AbortController(); h.state.assessment = assessment(); h.state.policy = undefined;
    expect(await h.repo.getAcceptedAssessment("alice", h.state.assessment.digest, c.signal)).toEqual(h.state.assessment);
    expect(h.calls).toHaveLength(1); expect(h.calls[0].values).toEqual([h.ns.id, "alice", h.state.assessment.digest]);
    expect(h.calls[0].sql).toContain("a.state='accepted'"); expect(h.calls[0].sql).toContain("s.digest=$3");
    await expect(h.repo.getAcceptedAssessment("alice", `0x${"12".repeat(32)}`, c.signal)).rejects.toThrow("commitment mismatch");
    h.state.assessment = undefined;
    expect(await h.repo.getAcceptedAssessment("alice", `0x${"12".repeat(32)}`, c.signal)).toBeUndefined();
  });
  it("provenance rejects invalid keys and cancellation before or while queued, before querying", async () => {
    const h = await harness(), digest = `0x${"12".repeat(32)}`, c = new AbortController();
    expect(() => h.repo.getAcceptedAssessment("ALICE", digest, c.signal)).toThrow("lookup");
    expect(() => h.repo.getAcceptedAssessment("alice", "invalid", c.signal)).toThrow("lookup");
    const queued = h.repo.getAcceptedAssessment("alice", digest, c.signal); c.abort();
    await expect(queued).rejects.toThrow();
    expect(() => h.repo.getAcceptedAssessment("alice", digest, c.signal)).toThrow();
    expect(h.calls).toHaveLength(0);
  });
  it("provenance cancellation after the query withholds the result", async () => {
    const h = await harness(), c = new AbortController(); h.state.assessment = assessment();
    const pending = h.repo.getAcceptedAssessment("alice", h.state.assessment.digest, c.signal);
    await Promise.resolve(); c.abort(); await expect(pending).rejects.toThrow(); expect(h.calls).toHaveLength(1);
  });
  it("claims only one untouched job and refuses duplicate dispatch markers", async () => {
    const h = await harness(); await h.repo.claimInitial(h.id); await h.repo.beforeDispatch(h.id, "x-identity");
    h.state.inserted = 0;
    await expect(h.repo.claimInitial(h.id)).rejects.toThrow("already claimed");
    await expect(h.repo.beforeDispatch(h.id, "x-identity")).rejects.toThrow("retry forbidden");
  });
  it.each(["missing", "accepted", "epoch", "job", "profile"])("blocks %s attempts at dispatch", async failure => {
    const h = await harness();
    if (failure === "missing") h.state.attempt = undefined;
    else if (failure === "accepted") h.state.attempt!.state = "accepted";
    else if (failure === "epoch") h.state.job.owner_epoch = "2";
    else if (failure === "job") h.state.job.state = "queued";
    else h.state.attempt!.profile_version = "other-profile";
    await expect(h.repo.beforeDispatch(h.id, "x-identity")).rejects.toThrow(PersistenceConflictError);
  });
  it("blocks further egress if recorded actual cost exceeds reserved exposure", async () => {
    const h = await harness(); h.state.totals.exposure = "1001";
    await expect(h.repo.beforeDispatch(h.id, "grok")).rejects.toThrow("Recorded exposure");
  });
  it.each(["missing", "failed", "http", "identity", "provenance"])("requires successful durable X evidence before Grok: %s", async failure => {
    const h = await harness();
    if (failure === "missing") h.state.receipt.delete("x-identity");
    else if (failure === "failed") h.state.receipt.set("x-identity", bytes({ ...receipt("x-identity"), category: "http-error" }));
    else if (failure === "http") h.state.receipt.set("x-identity", bytes({ ...receipt("x-identity"), httpStatus: 402 }));
    else if (failure === "identity") h.state.identity = undefined;
    else h.state.identity = bytes({ ...identity(), provenance: "x-api" });
    await expect(h.repo.beforeDispatch(h.id, "grok")).rejects.toThrow(PersistenceConflictError);
  });
  it("accepts a Grok fence with validated success evidence", async () => {
    const h = await harness(); await h.repo.beforeDispatch(h.id, "grok");
    expect(h.calls.at(-1)!.values.slice(0, 4)).toEqual([h.ns.id, h.id, "grok", "1"]);
  });
  it("copies receipt bytes before asynchronous work and requires the same writer fence", async () => {
    const h = await harness(); h.state.receipt.clear();
    const original = bytes(receipt("x-identity")), input = Buffer.from(original), save = h.repo.recordReceipt(h.id, input); input.fill(0);
    await save; expect(h.calls.at(-1)!.values[3]).toEqual(original);
    h.state.fence = "2";
    await expect(h.repo.recordReceipt(h.id, original)).rejects.toThrow("committed dispatch");
  });
  it("allows exact receipt replay but refuses conflicts and corrupt scalar indexes", async () => {
    const h = await harness(); await h.repo.recordReceipt(h.id, bytes(receipt("grok")));
    await expect(h.repo.recordReceipt(h.id, bytes(receipt("grok", "1")))).rejects.toThrow("Conflicting immutable");
    expect(await h.repo.getReceipt(h.id, "grok")).toEqual(receipt("grok"));
    h.state.receiptCost = "actual";
    await expect(h.repo.getReceipt(h.id, "grok")).rejects.toThrow("scalar mismatch");
    h.state.receipt.clear(); expect(await h.repo.getReceipt(h.id, "grok")).toBeUndefined();
  });
  it("requires an allowlisted bounded immutable payload and a canonical UUID", async () => {
    const h = await harness();
    expect(() => h.repo.recordReceipt("bad", bytes(receipt("grok")))).toThrow("identifier");
    expect(() => h.repo.recordReceipt(h.id, Buffer.alloc(16385))).toThrow("length");
    expect(() => h.repo.recordReceipt(h.id, bytes({ ...receipt("grok"), secret: "reject" }))).toThrow();
    expect(() => h.repo.acceptAssessment(h.id, Buffer.from("bad"))).toThrow();
    expect(() => h.repo.beforeDispatch(h.id, "unknown" as ProviderLeg)).toThrow("leg");
  });
  it("persists a new verified identity only after the successful receipt", async () => {
    const h = await harness(); h.state.identity = undefined; await h.repo.recordIdentity(h.id, bytes(identity()));
    expect(h.calls.at(-1)!.sql).toContain("INSERT INTO open_mint.verified_identities");
    h.state.receipt.clear(); await expect(h.repo.recordIdentity(h.id, bytes(identity()))).rejects.toThrow("successful X");
    await expect(h.repo.recordIdentity(h.id, bytes({ ...identity(), provenance: "x-api" }))).rejects.toThrow("provenance");
  });
  it("accepts identical identity replay and rejects conflicting evidence", async () => {
    const h = await harness(); await h.repo.recordIdentity(h.id, bytes(identity()));
    await expect(h.repo.recordIdentity(h.id, bytes({ ...identity(), userId: "999" }))).rejects.toThrow("Conflicting immutable");
  });
  it("inserts a validated result, accepted linkage and render job in one transaction", async () => {
    const h = await harness(), value = assessment(); expect(await h.repo.acceptAssessment(h.id, bytes(value))).toEqual(value);
    expect(h.calls.slice(-4).map(call => call.sql.split(" ").slice(0, 3).join(" "))).toEqual([
      "INSERT INTO open_mint.assessments(namespace_id,", "UPDATE open_mint.assessment_attempts SET", "UPDATE open_mint.jobs SET", "INSERT INTO open_mint.jobs(namespace_id,",
    ]);
    h.state.assessment = value; expect(await h.repo.acceptAssessment(h.id, bytes(value))).toEqual(value);
    await expect(h.repo.acceptAssessment(h.id, bytes(assessment()))).rejects.toThrow("Conflicting immutable");
  });
  it.each(["handle", "policy", "model", "receipt", "identity", "response", "receipt-model"])("rejects mismatched accepted result: %s", async failure => {
    const h = await harness(); let value = assessment();
    if (failure === "handle") value = assessment("bob");
    else if (failure === "policy") h.state.policy = undefined;
    else if (failure === "model") h.state.policy!.expected_model = "other";
    else if (failure === "receipt") h.state.receipt.delete("grok");
    else if (failure === "identity") value = assessment("alice", { xIdentity: { ...identity(), userId: "999" } });
    else if (failure === "response") h.state.receipt.set("grok", bytes({ ...receipt("grok"), responseId: "different" }));
    else h.state.receipt.set("grok", bytes({ ...receipt("grok"), model: "different" }));
    await expect(h.repo.acceptAssessment(h.id, bytes(value))).rejects.toThrow(PersistenceConflictError);
  });
  it("freezes terminal evidence and rejects a conflicting outcome", async () => {
    const h = await harness();
    expect(await h.repo.finishAttempt(h.id, { kind: "uncertain" })).toEqual({ kind: "uncertain", phase: "grok" });
    expect(await h.repo.getTerminal(h.id)).toEqual({ kind: "uncertain", phase: "grok" });
    await expect(h.repo.finishAttempt(h.id, { kind: "uncertain" })).resolves.toMatchObject({ kind: "uncertain" });
    await expect(h.repo.finishAttempt(h.id, { kind: "invalid" })).rejects.toThrow("Conflicting immutable");
    expect(h.calls.some(call => call.sql.includes("SET state='closed'"))).toBe(true);
    expect(h.calls.some(call => call.sql.includes("SET state='complete'"))).toBe(true);
  });
  it("requires durable matching dispatch/response facts for each terminal classification", async () => {
    const h = await harness();
    await expect(h.repo.finishAttempt(h.id, { kind: "blocked-before-dispatch" })).rejects.toThrow("dispatch evidence");
    h.state.dispatchLegs = ["x-identity"];
    await expect(h.repo.finishAttempt(h.id, { kind: "abstained", reason: "provider-refusal" })).rejects.toThrow("successful Grok receipt");
    h.state.receipt.set("x-identity", bytes({ ...receipt("x-identity"), category: "timeout" }));
    await expect(h.repo.finishAttempt(h.id, { kind: "invalid" })).rejects.toThrow("successful response");
    h.state.dispatchLegs = [];
    await expect(h.repo.finishAttempt(h.id, { kind: "blocked-before-dispatch" })).resolves.toMatchObject({ phase: "before-dispatch" });
  });
  it("records and idempotently reads a bounded abstention reason", async () => {
    const h = await harness();
    const value = { kind: "abstained", reason: "subject-unavailable" } as const;
    await expect(h.repo.finishAttempt(h.id, value)).resolves.toEqual({ ...value, phase: "grok" });
    await expect(h.repo.finishAttempt(h.id, value)).resolves.toEqual({ ...value, phase: "grok" });
    await expect(h.repo.finishAttempt(h.id, { ...value, reason: "provider-refusal" })).rejects.toThrow("Conflicting immutable");
    expect(() => h.repo.finishAttempt(h.id, { kind: "invalid", raw: "private" } as never)).toThrow("Invalid terminal");
    expect(() => h.repo.finishAttempt(h.id, { kind: "abstained", reason: "unbounded" } as never)).toThrow("Invalid terminal");
  });
  it.each([
    { kind: "unknown", reason: null, phase: "grok" }, { kind: "uncertain", reason: "provider-refusal", phase: "grok" },
    { kind: "uncertain", reason: null, phase: "before-dispatch" }, { kind: "blocked-before-dispatch", reason: null, phase: "grok" },
    { kind: "abstained", reason: "unbounded", phase: "grok" }, { kind: "abstained", reason: "provider-refusal", phase: "x-identity" },
    { kind: "invalid", reason: null, phase: "other" },
  ])("rejects corrupted terminal projection %j", value => { expect(() => validateAssessmentTerminal(value)).toThrow("stored terminal"); });
  it.each(["queued", "accepted", "other-epoch"])("does not finalize %s work on interruption", async state => {
    const h = await harness();
    if (state === "queued") h.state.job.state = "queued";
    else if (state === "accepted") h.state.attempt!.state = "accepted";
    else h.state.job.owner_epoch = "2";
    await expect(h.repo.interruptAttempt(h.id)).resolves.toBeUndefined(); expect(h.state.terminal).toBeUndefined();
  });
  it.each([true, false])("derives interruption phase from durable dispatch rows: %s", async dispatched => {
    const h = await harness(); if (!dispatched) h.state.dispatchLegs = [];
    const expected = { kind: dispatched ? "uncertain" : "blocked-before-dispatch", phase: dispatched ? "grok" : "before-dispatch" };
    await expect(h.repo.interruptAttempt(h.id)).resolves.toEqual(expected);
    await expect(h.repo.interruptAttempt(h.id)).resolves.toEqual(expected);
  });
  it.each(["before", "after"])("enforces cancellation guard %s immutable writes", async boundary => {
    const h = await harness(); h.state.receipt.clear(); let calls = 0;
    const guard = () => { if (++calls === (boundary === "before" ? 1 : 2)) throw new Error("expired"); };
    await expect(h.repo.recordReceipt(h.id, bytes(receipt("grok")), guard)).rejects.toThrow("expired");
    expect(h.calls.some(call => call.sql.startsWith("INSERT INTO open_mint.provider_receipts"))).toBe(boundary === "after");
  });
});
