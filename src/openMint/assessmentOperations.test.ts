import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Assessment } from "./assessment.js";
import { AssessmentOperations, validateAssessmentAttempt, validateProviderReceipt, type AssessmentAttempt, type AssessmentExecution, type AssessmentOperationsOptions, type ProviderReceipt } from "./assessmentOperations.js";
import { FileKeyValueStore, MemoryKeyValueStore } from "./storage.js";
import type { XIdentitySnapshot } from "./xIdentity.js";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const IDENTITY: XIdentitySnapshot = { canonicalHandle: "alice", username: "ALIce", userId: "1234", verifiedAt: new Date(NOW).toISOString(), provenance: "x-api", freshness: "verified-at-preparation" };
const ASSESSMENT = { id: "9c1bafdd-51af-4c8a-9594-6d8753de7d55", handle: "alice", digest: `0x${"a".repeat(64)}` } as Assessment;
const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
function setup(overrides: Partial<AssessmentOperationsOptions> = {}) {
  const store = overrides.store ?? new MemoryKeyValueStore();
  let now = NOW;
  const options: AssessmentOperationsOptions = { store, generationEnabled: true, now: () => now, ...overrides };
  return { store, options, ops: new AssessmentOperations(options), setNow: (value: number) => { now = value; } };
}
function receipt(leg: ProviderReceipt["leg"], overrides: Partial<ProviderReceipt> = {}): ProviderReceipt {
  return { leg, startedAt: NOW, completedAt: NOW + 1, category: "success", httpStatus: 200, usageStatus: "valid",
    usage: { costInUsdTicks: "100000000", inputTokens: 12, outputTokens: 8, totalTokens: 20, cachedInputTokens: 1, reasoningTokens: 2, serverSideToolCalls: 1 },
    cost: { status: "actual", amount: "100000000", currency: "USD", scale: 10 }, ...overrides };
}
async function accepted(execution: AssessmentExecution) {
  await execution.beforeDispatch("x-identity");
  await execution.recordReceipt(receipt("x-identity"));
  await execution.identityVerified(IDENTITY);
  await execution.beforeDispatch("grok");
  await execution.recordReceipt(receipt("grok"));
  await execution.recordOutcome({ kind: "accepted" });
  await execution.assessmentPersisted(ASSESSMENT);
}
const unknownCost = { status: "unknown", currency: "USD", scale: 10 } as const;

describe("private assessment lifecycle", () => {
  it("keeps admission, accepted reference and append-only phases separate from artifact failure/recovery", async () => {
    const { ops, setNow } = setup();
    const admitted = await ops.admit("@Alice", "grok-mbti-v2");
    setNow(NOW + 2000);
    const execution = await ops.execution("ALICE");
    expect(execution.attemptId).toBe(admitted.id);
    await accepted(execution);
    await ops.artifactOutcome("alice", "failed");
    const failed = await ops.get("alice") as AssessmentAttempt;
    expect(failed).toMatchObject({ id: admitted.id, admittedAt: NOW, profileVersion: "grok-mbti-v2", outcome: "accepted", artifact: "failed", reconciliation: "complete", acceptedAssessment: { id: ASSESSMENT.id, digest: ASSESSMENT.digest } });
    setNow(NOW - 10_000); // A backwards wall clock cannot rewrite phase history.
    await ops.artifactOutcome("alice", "prepared");
    await ops.artifactOutcome("alice", "failed");
    const report = await ops.report(admitted.id);
    expect(report).toMatchObject({ accounting: "actual", exposureUsdTicks: "200000000", automaticRetryAllowed: false, attempt: { artifact: "prepared", phases: { ...failed.phases, artifactPreparedAt: NOW + 2000 } } });
    expect(report!.receipts).toHaveLength(2);
    expect(report).not.toHaveProperty("mbti");
    await expect(ops.admit("ALICE", "different-profile")).rejects.toMatchObject({ code: "ASSESSMENT_RETRY_BLOCKED" });
  });

  it("uses no credentials, provider or generation permission for operator reads", async () => {
    const { ops, store } = setup();
    const attempt = await ops.admit("alice", "profile-v1");
    await accepted(await ops.execution("alice"));
    const disabled = new AssessmentOperations({ store });
    expect(await disabled.get("ALIce")).toMatchObject({ id: attempt.id, outcome: "accepted" });
    expect(await disabled.report(attempt.id)).toMatchObject({ accounting: "actual" });
    await expect(disabled.admit("bob", "profile-v1")).rejects.toMatchObject({ code: "GENERATION_DISABLED" });
    expect(await disabled.report("fe434ddb-38d4-46a4-914f-67c9b43fc31c")).toBeUndefined();
    await expect(disabled.report("../secret")).rejects.toMatchObject({ code: "ASSESSMENT_OPERATIONS_STATE" });
  });

  it("projects old started, failed and succeeded records as unknown without rewriting them", async () => {
    const { ops, store } = setup({ maxTotalAttempts: 10, dailyLimit: 10 });
    for (const status of ["started", "failed", "succeeded"]) {
      const handle = status;
      const legacy = { handle, createdAt: NOW, status, ...(status === "succeeded" ? { assessmentId: "old-result" } : {}) };
      await store.put(`attempt:${handle}`, legacy);
      const view = await ops.get(handle);
      expect(view).toMatchObject({ version: 0, admission: "unknown", outcome: "uncertain-after-dispatch", reconciliation: "operator-review", legacyObservedAt: NOW });
      expect(await ops.report(view!.id)).toMatchObject({ accounting: "legacy-unknown", receipts: [], automaticRetryAllowed: false });
      expect(await store.get(`attempt:${handle}`)).toEqual(legacy);
      await expect(ops.execution(handle)).rejects.toMatchObject({ code: "ASSESSMENT_OPERATIONS_STATE" });
      await expect(ops.admit(handle, "profile")).rejects.toMatchObject({ code: "ASSESSMENT_RETRY_BLOCKED" });
    }
    await expect(ops.admit("fresh", "profile")).rejects.toMatchObject({ code: "ASSESSMENT_ACCOUNTING_UNKNOWN" });
  });

  it("rejects out-of-order and duplicate dispatch, receipt replacement, outcome change and reassessment linkage", async () => {
    const { ops } = setup(); await ops.admit("alice", "profile");
    const execution = await ops.execution("alice");
    await expect(execution.recordReceipt(receipt("grok"))).rejects.toThrow();
    await expect(execution.identityVerified(IDENTITY)).rejects.toThrow();
    await expect(execution.recordOutcome({ kind: "accepted" })).rejects.toThrow();
    await expect(execution.assessmentPersisted(ASSESSMENT)).rejects.toThrow();
    await expect(ops.artifactOutcome("alice", "prepared")).rejects.toThrow();
    await execution.beforeDispatch("x-identity");
    await expect(execution.beforeDispatch("x-identity")).rejects.toThrow();
    await expect(execution.beforeDispatch("grok")).rejects.toThrow();
    await execution.recordReceipt(receipt("x-identity")); await execution.recordReceipt(receipt("x-identity"));
    await expect(execution.recordReceipt(receipt("x-identity", { requestId: "another-response" }))).rejects.toThrow();
    await execution.identityVerified(IDENTITY); await execution.identityVerified(IDENTITY);
    await expect(execution.identityVerified({ ...IDENTITY, userId: "5678" })).rejects.toThrow();
    await execution.beforeDispatch("grok");
    await expect(execution.identityVerified(IDENTITY)).rejects.toThrow();
    await execution.recordOutcome({ kind: "accepted" }); await execution.recordOutcome({ kind: "accepted" });
    await expect(execution.recordOutcome({ kind: "invalid" })).rejects.toThrow();
    await execution.assessmentPersisted(ASSESSMENT); await execution.assessmentPersisted(ASSESSMENT);
    await expect(execution.assessmentPersisted({ ...ASSESSMENT, id: "another-assessment" })).rejects.toThrow();
    await expect(execution.beforeDispatch("grok")).rejects.toThrow();
    expect(await ops.get("alice")).toMatchObject({ reconciliation: "operator-review" });
  });

  it.each(["insufficient-evidence", "subject-unavailable", "provider-refusal"] as const)("persists bounded abstention %s without any accepted reference", async reason => {
    const { ops } = setup(); const attempt = await ops.admit("alice", "profile");
    const execution = await ops.execution("alice"); await execution.beforeDispatch("grok");
    await execution.recordReceipt(receipt("grok")); await execution.recordOutcome({ kind: "abstained", reason });
    await ops.fail("alice", "provider");
    expect(await ops.report(attempt.id)).toMatchObject({ accounting: "actual", attempt: { outcome: "abstained", abstentionReason: reason, failureCategory: "provider" } });
    await expect(execution.assessmentPersisted(ASSESSMENT)).rejects.toThrow();
    await expect(execution.recordOutcome({ kind: "accepted" })).rejects.toThrow();
  });

  it.each(["before", "x-unknown", "x-response", "grok-unknown", "grok-response"])("classifies %s failures using durable evidence", async stage => {
    const { ops } = setup(); await ops.admit("alice", "profile"); const execution = await ops.execution("alice");
    if (stage !== "before") await execution.beforeDispatch("x-identity");
    if (stage === "x-response" || stage.startsWith("grok")) await execution.recordReceipt(receipt("x-identity", { category: "http-error", httpStatus: 429 }));
    if (stage.startsWith("grok")) { await execution.identityVerified(IDENTITY); await execution.beforeDispatch("grok"); }
    if (stage === "grok-response") await execution.recordReceipt(receipt("grok", { category: "invalid-body" }));
    await ops.fail("alice", "storage"); await ops.fail("alice", "interrupted");
    expect(await ops.get("alice")).toMatchObject({ outcome: stage === "before" ? "failed-before-dispatch" : stage.endsWith("response") ? "failed-after-response" : "uncertain-after-dispatch", failureCategory: "storage", reconciliation: "operator-review" });
    await expect(ops.admit("alice", "profile")).rejects.toMatchObject({ code: "ASSESSMENT_RETRY_BLOCKED" });
  });
});

describe("conservative paid admission", () => {
  it("starts disabled and checks the allowlisted handle before any durable write", async () => {
    const store = new MemoryKeyValueStore();
    await expect(new AssessmentOperations({ store }).admit("alice", "profile")).rejects.toMatchObject({ code: "GENERATION_DISABLED" });
    const { ops } = setup({ store, allowedHandle: "alice" });
    await expect(ops.admit("bob", "profile")).rejects.toMatchObject({ code: "HANDLE_NOT_ALLOWED" });
    expect(await store.entries("budget:")).toEqual([]);
    expect(await store.entries("attempt:")).toEqual([]);
  });

  it("enforces one total pilot admission atomically for simultaneous different handles", async () => {
    const { ops, store } = setup();
    const results = await Promise.allSettled([ops.admit("alice", "profile"), ops.admit("bob", "profile")]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason.code).toBe("ASSESSMENT_LIMIT");
    expect(await store.get("budget:2026-09-19")).toBe(1);
    expect(await store.entries("attempt:")).toHaveLength(1);
  });

  it("bounds active attempts, rechecks the kill switch before either provider and retains exposure across dates", async () => {
    let enabled = true;
    const { ops, options, setNow } = setup({ maxTotalAttempts: 4, dailyLimit: 4, maxExposureUsdTicks: "40000000000", generationEnabled: () => enabled });
    await ops.admit("alice", "profile");
    await expect(ops.admit("bob", "profile")).rejects.toMatchObject({ code: "ASSESSMENT_ACTIVE_LIMIT" });
    const execution = await ops.execution("alice"); enabled = false;
    await expect(execution.beforeDispatch("x-identity")).rejects.toMatchObject({ code: "GENERATION_DISABLED" });
    enabled = true; await execution.beforeDispatch("x-identity"); await execution.identityVerified(IDENTITY); enabled = false;
    await expect(execution.beforeDispatch("grok")).rejects.toMatchObject({ code: "GENERATION_DISABLED" });
    enabled = true; await ops.fail("alice", "interrupted"); setNow(NOW + 86_400_000);
    await expect(new AssessmentOperations(options).admit("bob", "profile")).rejects.toMatchObject({ code: "ASSESSMENT_ACCOUNTING_UNKNOWN" });
  });

  it("counts measured overruns and does not treat estimates or unknown usage as settled", async () => {
    for (const cost of [{ status: "actual", amount: "35000000000", currency: "USD", scale: 10 }, { status: "estimated", amount: "2", currency: "USD", scale: 10, pricingReference: "2026-09-19-profile" }, unknownCost] as const) {
      const { ops } = setup({ maxTotalAttempts: 4, dailyLimit: 4, maxExposureUsdTicks: "40000000000" });
      const attempt = await ops.admit("alice", "profile"); const execution = await ops.execution("alice");
      await execution.beforeDispatch("grok"); await execution.recordReceipt(receipt("grok", { usageStatus: "missing", usage: undefined, cost }));
      await execution.recordOutcome({ kind: "invalid" });
      const report = await ops.report(attempt.id);
      expect(report!.exposureUsdTicks).toBe(cost.status === "actual" ? "35000000000" : "10000000000");
      await expect(ops.admit("bob", "profile")).rejects.toMatchObject({ code: cost.status === "actual" ? "ASSESSMENT_EXPOSURE_LIMIT" : "ASSESSMENT_ACCOUNTING_UNKNOWN" });
    }
  });

  it("admits a separately allowed handle only when prior accounting is actual and capacity remains", async () => {
    const { ops, store } = setup({ maxTotalAttempts: 2, dailyLimit: 2, maxExposureUsdTicks: "10200000000" });
    await ops.admit("alice", "profile"); await accepted(await ops.execution("alice"));
    expect(await ops.admit("bob", "profile")).toMatchObject({ handle: "bob", outcome: "pending" });
    expect(await store.get("budget:2026-09-19")).toBe(2);
    await expect(ops.admit("charlie", "profile")).rejects.toMatchObject({ code: "ASSESSMENT_LIMIT" });
  });

  it("preserves legacy daily counters and rejects corrupt counters and reservation data", async () => {
    const daily = setup({ maxTotalAttempts: 5, dailyLimit: 3 });
    await daily.store.put("budget:2026-09-19", 3);
    await expect(daily.ops.admit("alice", "profile")).rejects.toMatchObject({ code: "ASSESSMENT_LIMIT" });
    for (const value of [-1, 0.5, "0", null, {}, Number.MAX_SAFE_INTEGER + 1]) {
      const { ops, store } = setup(); await store.put("budget:2026-09-18", value);
      await expect(ops.admit("alice", "profile")).rejects.toMatchObject({ code: "ASSESSMENT_OPERATIONS_CORRUPT" });
      expect(await store.entries("attempt:")).toEqual([]);
    }
    for (const value of [{}, { version: 2, reservations: [] }, { version: 1, reservations: [{}] }, { version: 1, reservations: "invalid" }]) {
      const { ops, store } = setup(); await store.put("budget:paid_v1", value);
      await expect(ops.admit("alice", "profile")).rejects.toMatchObject({ code: "ASSESSMENT_OPERATIONS_CORRUPT" });
    }
    for (const key of ["budget:unknown", "budget:2026-99-01", "budget:2026-02-30"]) {
      const { ops, store } = setup(); await store.put(key, 0);
      await expect(ops.admit("alice", "profile")).rejects.toMatchObject({ code: "ASSESSMENT_OPERATIONS_CORRUPT" });
    }
  });

  it("detects missing, duplicate, negative and conflicting reservation evidence", async () => {
    for (const alteration of ["missing", "duplicate", "negative", "conflict"]) {
      const { ops, store } = setup({ maxTotalAttempts: 3, dailyLimit: 3, maxActiveAttempts: 3, maxExposureUsdTicks: "30000000000" });
      await ops.admit("alice", "profile");
      const budget = await store.get<{ version: 1; reservations: Array<{ reservedUsdTicks: string; profileVersion: string }> }>("budget:paid_v1");
      if (alteration === "missing") budget!.reservations = [];
      else if (alteration === "duplicate") budget!.reservations.push({ ...budget!.reservations[0] });
      else if (alteration === "negative") budget!.reservations[0].reservedUsdTicks = "-1";
      else budget!.reservations[0].profileVersion = "changed-profile";
      await store.put("budget:paid_v1", budget);
      await expect(ops.admit("bob", "profile")).rejects.toMatchObject({ code: alteration === "missing" ? "ASSESSMENT_ACCOUNTING_UNKNOWN" : "ASSESSMENT_OPERATIONS_CORRUPT" });
    }
  });

  it("marks fixture accounting explicitly and never imports that exemption into a paid namespace", async () => {
    const { ops, store } = setup({ accountingRequired: false, maxTotalAttempts: 10, maxActiveAttempts: 3, dailyLimit: 3 });
    const attempt = await ops.admit("alice", "fixture-v1"); const execution = await ops.execution("alice");
    await execution.beforeDispatch("grok"); await execution.recordOutcome({ kind: "accepted" }); await execution.assessmentPersisted(ASSESSMENT);
    expect(await ops.report(attempt.id)).toMatchObject({ accounting: "fixture-not-billed", reservationUsdTicks: "0", exposureUsdTicks: "0", attempt: { reconciliation: "complete" } });
    await ops.admit("bob", "fixture-v1");
    expect(await store.get("budget:2026-09-19")).toBe(2);
    const real = setup({ store, maxTotalAttempts: 10, dailyLimit: 10 });
    await expect(real.ops.admit("charlie", "real-v1")).rejects.toMatchObject({ code: "ASSESSMENT_ACCOUNTING_UNKNOWN" });
  });
});

describe("failure injection and restart", () => {
  it.each([false, true])("never repeats a dispatch at any failed write boundary (write completed: %s)", async written => {
    for (let failAt = 1; failAt <= 13; failAt++) {
      const store = new MemoryKeyValueStore();
      const original = store.put.bind(store); let writes = 0;
      vi.spyOn(store, "put").mockImplementation(async (key, value) => {
        writes++;
        if (writes === failAt && !written) throw new Error("injected disk failure");
        await original(key, value);
        if (writes === failAt) throw new Error("injected fsync acknowledgement failure");
      });
      const { ops, options } = setup({ store });
      const calls: string[] = [];
      try {
        await ops.admit("alice", "profile"); const execution = await ops.execution("alice");
        await execution.beforeDispatch("x-identity"); calls.push("x");
        await execution.recordReceipt(receipt("x-identity")); await execution.identityVerified(IDENTITY);
        await execution.beforeDispatch("grok"); calls.push("grok");
        await execution.recordReceipt(receipt("grok")); await execution.recordOutcome({ kind: "accepted" });
        await execution.assessmentPersisted(ASSESSMENT); await ops.artifactOutcome("alice", "prepared");
      } catch { /* Simulate process death: do not issue any cleanup writes. */ }
      const restarted = new AssessmentOperations(options);
      if (await store.get("budget:paid_v1")) await expect(restarted.admit("alice", "profile")).rejects.toThrow();
      else expect(calls).toEqual([]);
      const saved = await restarted.get("alice");
      if (calls.includes("x")) expect(saved).toMatchObject({ phases: { xDispatchedAt: NOW } });
      if (calls.includes("grok")) expect(saved).toMatchObject({ phases: { grokDispatchedAt: NOW } });
      expect(calls.filter(call => call === "x")).toHaveLength(calls.includes("x") ? 1 : 0);
      expect(calls.filter(call => call === "grok")).toHaveLength(calls.includes("grok") ? 1 : 0);
    }
  });

  it("retains the receipt if its following phase write fails and never fabricates accounting", async () => {
    const { ops, store } = setup(); const attempt = await ops.admit("alice", "profile"); const execution = await ops.execution("alice");
    await execution.beforeDispatch("grok");
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (key, value) => { if (key === "attempt:alice") throw new Error("disk full"); await put(key, value); });
    await expect(execution.recordReceipt(receipt("grok"))).rejects.toMatchObject({ name: "AssessmentPersistenceError", message: "Assessment operational persistence failed.", cause: expect.objectContaining({ message: "disk full" }) });
    const report = await ops.report(attempt.id);
    expect(report).toMatchObject({ accounting: "unresolved", exposureUsdTicks: "10000000000", attempt: { outcome: "pending" } });
    expect(report!.receipts).toHaveLength(1);
  });

  it("survives an actual file-store restart with unknown cost, phases and result references intact", async () => {
    const path = await mkdtemp(join(tmpdir(), "sg-attempt-ops-")); paths.push(path);
    const store = await FileKeyValueStore.create(path); const { ops } = setup({ store });
    const attempt = await ops.admit("alice", "profile"); const execution = await ops.execution("alice");
    await execution.beforeDispatch("grok"); await execution.recordReceipt(receipt("grok", { cost: unknownCost, usageStatus: "invalid", usage: undefined }));
    await execution.recordOutcome({ kind: "accepted" }); await execution.assessmentPersisted(ASSESSMENT);
    const before = await readFile(store.path("attempt:alice"), "utf8");
    const restarted = new AssessmentOperations({ store: await FileKeyValueStore.create(path) });
    expect(await restarted.report(attempt.id)).toMatchObject({ accounting: "unresolved", attempt: { acceptedAssessment: { id: ASSESSMENT.id }, reconciliation: "operator-review" } });
    expect(await readFile(store.path("attempt:alice"), "utf8")).toBe(before);
  });

  it("runs the local CLI without changing files and refuses write flags and symlink records", async () => {
    const path = await mkdtemp(join(tmpdir(), "sg-attempt-inspect-")); paths.push(path);
    const store = await FileKeyValueStore.create(path); const { ops } = setup({ store });
    const attempt = await ops.admit("alice", "profile"); await accepted(await ops.execution("alice"));
    const names = (await readdir(path)).sort();
    const before = await Promise.all(names.map(name => readFile(join(path, name), "utf8")));
    const run = promisify(execFile), script = fileURLToPath(new URL("../../scripts/open-mint-attempt.mjs", import.meta.url));
    const args = ["--import", "tsx", script, "--records", path, "--reference", attempt.id];
    const childOptions = { timeout: 10_000 };
    const { stdout, stderr } = await run(process.execPath, args, childOptions);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ accounting: "actual", automaticRetryAllowed: false, attempt: { id: attempt.id } });
    expect((await readdir(path)).sort()).toEqual(names);
    expect(await Promise.all(names.map(name => readFile(join(path, name), "utf8")))).toEqual(before);
    await expect(run(process.execPath, [...args, "--retry"], childOptions)).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("Usage:") });
    await expect(run(process.execPath, args.slice(0, -1).concat("../secret"), childOptions)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ASSESSMENT_OPERATIONS_STATE") });
    await symlink(store.path("attempt:alice"), join(path, "attempt-bob.json"));
    await expect(run(process.execPath, args, childOptions)).rejects.toMatchObject({ code: 1, stderr: "Inspection failed: records are unavailable or invalid.\n" });
  }, 30_000);
});

describe("strict allowlisted operational schemas", () => {
  it("rejects unbounded receipts, raw dumps, unsafe numbers and dishonest cost combinations", () => {
    const valid = receipt("grok");
    for (const patch of [
      { arbitraryResponseDump: "secret" }, { leg: "other" }, { startedAt: -1 }, { completedAt: NOW - 1 }, { httpStatus: 700 },
      { requestId: "a".repeat(257) }, { model: "Bearer secret" }, { category: "raw-provider-error" }, { usageStatus: "unknown" },
      { usage: { totalTokens: -1 } }, { usage: { totalTokens: Number.MAX_SAFE_INTEGER + 1 } }, { usage: { secret: "raw" } },
      { usage: {} }, { usage: { costInUsdTicks: "1.2" } }, { usageStatus: "missing" }, { usage: undefined },
      { cost: { ...valid.cost, amount: "-1" } }, { cost: { ...valid.cost, amount: "1" } }, { cost: { ...valid.cost, currency: "EUR" } },
      { cost: { ...valid.cost, scale: 6 } }, { cost: { ...unknownCost, amount: "0" } }, { cost: { ...valid.cost, status: "estimated" } },
      { cost: { ...unknownCost, pricingReference: "fake" } }, { cost: { ...valid.cost, pricingReference: "raw\nheader" } },
    ]) expect(() => validateProviderReceipt({ ...valid, ...patch })).toThrow();
    for (const value of [null, [], "payload", 1]) expect(() => validateProviderReceipt(value)).toThrow();
    expect(validateProviderReceipt(valid)).toEqual(valid);
  });

  it("rejects malformed attempt identities, phases, outcome references and appended private fields", async () => {
    const { ops } = setup(); await ops.admit("alice", "profile"); await accepted(await ops.execution("alice"));
    const valid = await ops.get("alice") as AssessmentAttempt;
    for (const patch of [
      { version: 2 }, { id: "invalid" }, { handle: "bob" }, { admittedAt: -1 }, { profileVersion: "secret\n" }, { accountingRequired: "false" },
      { phases: { rawResponse: NOW } }, { phases: { ...valid.phases, xVerifiedAt: NOW - 1 } }, { phases: { xVerifiedAt: NOW } },
      { phases: { grokDispatchedAt: NOW } }, { outcome: "maybe" }, { outcome: "abstained" }, { abstentionReason: "bad" },
      { failureCategory: "raw server error" }, { reconciliation: "safe-to-retry" }, { artifact: "lost" },
      { acceptedAssessment: { id: "result", digest: "bad" } }, { acceptedAssessment: undefined }, { identity: { ...IDENTITY, userId: "0" } },
      { identity: undefined }, { providerRawBody: "secret" },
    ]) expect(() => validateAssessmentAttempt({ ...valid, ...patch }, "alice")).toThrow();
    for (const value of [null, [], "payload", {}, { handle: "alice", createdAt: -1, status: "failed" }, { handle: "alice", createdAt: NOW, status: "unknown" }]) {
      expect(() => validateAssessmentAttempt(value, "alice")).toThrow();
    }
  });

  it("rejects malformed configuration, invalid safe outcomes and missing attempts", async () => {
    for (const options of [{ dailyLimit: 0 }, { maxTotalAttempts: -1 }, { maxActiveAttempts: 1.2 }, { reservationUsdTicks: "0" }, { maxExposureUsdTicks: "NaN" }, { allowedHandle: "Alice" }]) {
      expect(() => setup(options)).toThrow();
    }
    const { ops } = setup();
    await expect(ops.execution("missing")).rejects.toThrow();
    await expect(ops.admit("alice", "bad\nprofile")).rejects.toThrow();
    await ops.admit("alice", "profile"); const execution = await ops.execution("alice"); await execution.beforeDispatch("grok");
    await expect(execution.recordOutcome({ kind: "abstained", reason: "raw secret" } as never)).rejects.toThrow();
    await expect(execution.recordOutcome({ kind: "invalid", error: "secret" } as never)).rejects.toThrow();
    await expect(ops.fail("alice", "raw failure" as never)).rejects.toThrow();
  });
});
