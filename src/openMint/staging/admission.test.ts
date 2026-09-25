import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMISSION_OPERATIONS, admissionDigest, createAdmissionGate, StagingAdmissionError, type AdmissionDatabaseLease, type AdmissionIntent } from "./admission.js";
import { admissionFixture } from "./fixtures/admission.js";

afterEach(() => vi.useRealTimers());
describe("internal single-operation staging admission", () => {
  it("supplies a live boundary check to handlers that await before dispatch", async () => {
    const f = admissionFixture(), calls: string[] = [];
    f.ports.effects.sign = async (_intent, _signal, assertCurrent) => {
      await Promise.resolve(); f.control.review = false;
      assertCurrent(); calls.push("signed"); return "signature";
    };
    const g = f.create(); await expect(g.execute(await g.prepare(f.intent))).rejects.toMatchObject({ effectMayHaveStarted: true });
    expect(calls).toEqual([]); expect(f.fences.size).toBe(1);
  });
  it.each(ADMISSION_OPERATIONS)("binds and consumes one %s permit; uses fresh durable inspection at execution", async operation => {
    const f = admissionFixture(), g = f.create(), intent = { ...f.intent, operation }, token = await g.prepare(intent);
    expect(Object.keys(token)).toEqual([]); expect(Object.isFrozen(token)).toBe(true);
    expect(f.events.some(v => v.startsWith("effect:") || v.startsWith("fence:"))).toBe(false);
    expect(await g.execute(token)).toBe("saved-result:" + operation);
    expect(f.events.filter(v => v === "inspect:" + operation)).toHaveLength(2);
    const writes = !["read", "reuse"].includes(operation);
    expect(f.events.includes("fence:" + operation)).toBe(writes);
    if (writes) expect(f.events.indexOf("fence:" + operation)).toBeLessThan(f.events.indexOf("effect:" + operation));
    await expect(g.execute(token)).rejects.toBeInstanceOf(StagingAdmissionError);
    expect(f.signals.every(s => s.aborted)).toBe(true);
  });
  it("detaches intent/config and captures adapters; reports and copies cannot execute", async () => {
    const f = admissionFixture(), g = f.create(), token = await g.prepare(f.intent);
    (f.intent as { payloadSha256: string }).payloadSha256 = "b".repeat(64);
    f.ports.effects.sign = async () => { throw Error("replaced"); };
    f.ports.requireReview = () => { throw Error("replaced"); };
    expect(g.scopeSha256).toBe(admissionDigest(g.scope)); expect(Object.isFrozen(g.scope)).toBe(true);
    for (const clone of [{}, { ...token }, structuredClone(token), { approved: true }, g.scope, null, 1])
      await expect(g.execute(clone as object)).rejects.toBeInstanceOf(StagingAdmissionError);
    expect(await g.execute(token)).toBe("saved-result:sign");
  });
  it("rejects a permit from another gate or restart; durable fence prevents a second permit from redispatching", async () => {
    const f = admissionFixture(), g = f.create(), h = f.create(), token = await g.prepare(f.intent);
    await expect(h.execute(token)).rejects.toThrow(); await g.execute(token);
    const second = await h.prepare(f.intent); await expect(h.execute(second)).rejects.toMatchObject({ effectMayHaveStarted: false });
    expect(f.events.filter(v => v.startsWith("effect:"))).toHaveLength(1);
  });
  it("claims a permit before concurrent execution can start", async () => {
    const f = admissionFixture(), g = f.create(), p = await g.prepare(f.intent);
    const results = await Promise.allSettled([g.execute(p), g.execute(p)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(f.events.filter(v => v === "effect:sign")).toHaveLength(1);
  });
  it.each(["review", "healthy", "binding", "session", "issuance", "credentials"] as const)("blocks changed %s after readiness and consumes permit", async field => {
    const f = admissionFixture(), g = f.create(), p = await g.prepare(f.intent); f.control[field] = false;
    await expect(g.execute(p)).rejects.toMatchObject({ effectMayHaveStarted: false });
    f.control[field] = true; await expect(g.execute(p)).rejects.toThrow();
    expect(f.events.some(v => v.startsWith("effect:"))).toBe(false);
  });
  it.each(["generation", "budget", "credentials"] as const)("blocks paid %s policy drift", async field => {
    const f = admissionFixture(), g = f.create(), p = await g.prepare({ ...f.intent, operation: "assessment-grok" });
    f.control[field] = false; await expect(g.execute(p)).rejects.toThrow();
    expect(f.events.some(v => v.startsWith("effect:"))).toBe(false);
  });
  it.each(["read", "reuse"] as const)("%s needs no paid credentials, budget or issuance switch", async operation => {
    const f = admissionFixture(); f.control.generation = f.control.issuance = f.control.credentials = f.control.budget = false;
    f.advance(20000); const g = f.create(); expect(await g.execute(await g.prepare({ ...f.intent, operation }))).toBe("saved-result:" + operation);
    expect(f.fences.size).toBe(0);
  });
  it.each([-2000, 10000])("paid policy period excludes clock offset %s", async offset => {
    const f = admissionFixture(); f.advance(offset); const g = f.create();
    await expect(g.prepare({ ...f.intent, operation: "assessment-x" })).rejects.toThrow(); expect(f.events).not.toContain("observe");
  });
  it("signing/reuse are not coupled to a new paid assessment approval period", async () => {
    const f = admissionFixture(); f.advance(20000); const g = f.create(); await g.execute(await g.prepare(f.intent));
    expect(f.events).toContain("effect:sign");
  });
  it("private saved-result reuse still requires the original valid session", async () => {
    const f = admissionFixture(); f.control.session = false;
    await expect(f.create().prepare({ ...f.intent, operation: "reuse" })).rejects.toThrow();
  });
  it.each(["databaseBindingSha256", "intentSha256", "writerEpoch", "observedAt", "validUntil", "assertCurrent", "fence"] as const)("rejects malformed/crossed durable lease %s", async field => {
    const f = admissionFixture(), inspect = f.ports.database.inspect;
    f.ports.database.inspect = async (...a) => ({ ...await inspect(...a), [field]: field.endsWith("Sha256") ? "e".repeat(64) : field === "writerEpoch" ? "2" : field === "observedAt" ? f.now() + 1 : field === "validUntil" ? f.now() : undefined }) as AdmissionDatabaseLease;
    await expect(f.create().prepare(f.intent)).rejects.toThrow(); expect(f.events.some(v => v.startsWith("effect:"))).toBe(false);
  });
  it("rejects excessively long database leases", async () => {
    const f = admissionFixture(), inspect = f.ports.database.inspect;
    f.ports.database.inspect = async (...a) => ({ ...await inspect(...a), validUntil: f.now() + 1001 });
    await expect(f.create().prepare(f.intent)).rejects.toThrow();
  });
  it.each(["observedAt", "validUntil"] as const)("rejects invalid chain evidence %s", async field => {
    const f = admissionFixture(), read = f.ports.chain.read;
    f.ports.chain.read = (...a) => ({ ...read(...a), [field]: field === "observedAt" ? f.now() + 1 : f.now() });
    await expect(f.create().prepare(f.intent)).rejects.toThrow();
  });
  it("accepts only original opaque chain evidence", async () => {
    const f = admissionFixture(); f.ports.chain.observe = async () => ({ runtimeAdmissionAllowed: true });
    await expect(f.create().prepare(f.intent)).rejects.toThrow();
  });
  it.each([-1, 1000])("rejects expired or backwards permit time %s", async offset => {
    const f = admissionFixture(), g = f.create(), p = await g.prepare(f.intent); f.advance(offset);
    await expect(g.execute(p)).rejects.toThrow(); expect(f.events.some(v => v.startsWith("effect:"))).toBe(false);
  });
  it("checks monotonic permit age even with a frozen wall clock", async () => {
    const f = admissionFixture(); const scope = { ...f.scope, permitTtlMs: 1 };
    const inspect = f.ports.database.inspect; f.ports.database.inspect = async (...a) => ({ ...await inspect(...a), validUntil: f.now() + 1 });
    const g = createAdmissionGate(scope, f.ports, f.now), p = await g.prepare(f.intent);
    await new Promise(r => setTimeout(r, 10)); await expect(g.execute(p)).rejects.toThrow();
  });
  it.each(["healthy", "review", "issuance"] as const)("rechecks %s changed while durable fence commits", async field => {
    const f = admissionFixture(), inspect = f.ports.database.inspect;
    f.ports.database.inspect = async (...a) => { const r = await inspect(...a); return { ...r, fence: async (s: AbortSignal) => { await r.fence(s); f.control[field] = false; } }; };
    const g = f.create(); await expect(g.execute(await g.prepare(f.intent))).rejects.toMatchObject({ effectMayHaveStarted: false });
    expect(f.fences.size).toBe(1); expect(f.events.some(v => v.startsWith("effect:"))).toBe(false);
  });
  it("never dispatches after fence commit loses its reply; preserves the fence", async () => {
    const f = admissionFixture(), inspect = f.ports.database.inspect;
    f.ports.database.inspect = async (...a) => { const r = await inspect(...a); return { ...r, fence: async (s: AbortSignal) => { await r.fence(s); throw Error("lost COMMIT reply"); } }; };
    const g = f.create(); await expect(g.execute(await g.prepare(f.intent))).rejects.toMatchObject({ effectMayHaveStarted: false });
    expect(f.fences.size).toBe(1); expect(f.events.some(v => v.startsWith("effect:"))).toBe(false);
  });
  it("a provider/signer rejection is uncertain, sanitized and cannot reuse its permit", async () => {
    const f = admissionFixture(); f.ports.effects.sign = async () => { throw Error("SECRET provider response"); };
    const g = f.create(), p = await g.prepare(f.intent);
    await expect(g.execute(p)).rejects.toMatchObject({ effectMayHaveStarted: true, message: expect.not.stringContaining("SECRET") });
    await expect(g.execute(p)).rejects.toMatchObject({ effectMayHaveStarted: false }); expect(f.fences.size).toBe(1);
  });
  it("late success does not hide a potentially completed effect or remove its fence", async () => {
    const f = admissionFixture(); f.ports.effects.sign = async () => { f.advance(1000); return "saved late signature"; };
    const g = f.create(); await expect(g.execute(await g.prepare(f.intent))).rejects.toMatchObject({ effectMayHaveStarted: true }); expect(f.fences.size).toBe(1);
  });
  it.each(["observe", "inspect", "fence", "effect"])("bounds hung %s and cancels adapters", async stage => {
    vi.useFakeTimers(); const f = admissionFixture(), never = () => new Promise<never>(() => {});
    if (stage === "observe") f.ports.chain.observe = never;
    if (stage === "effect") f.ports.effects.sign = never;
    const original = f.ports.database.inspect; let n = 0;
    if (stage === "inspect" || stage === "fence") f.ports.database.inspect = async (...a) => {
      if (stage === "inspect" && n++ === 1) return never();
      const r = await original(...a); return stage === "fence" ? { ...r, fence: never } : r;
    };
    const g = f.create(), promise = stage === "observe" ? g.prepare(f.intent) : g.execute(await g.prepare(f.intent));
    const assertion = expect(promise).rejects.toMatchObject({ effectMayHaveStarted: stage === "effect" });
    await vi.advanceTimersByTimeAsync(1000); await assertion; expect(vi.getTimerCount()).toBe(0);
    expect(f.events.some(v => v.startsWith("effect:"))).toBe(false);
  });
  it("does not resume a late observation after timeout", async () => {
    vi.useFakeTimers(); const f = admissionFixture(), observe = f.ports.chain.observe; let release!: () => void;
    f.ports.chain.observe = async signal => { await new Promise<void>(r => { release = r; }); return observe(signal); };
    const promise = f.create().prepare(f.intent), assertion = expect(promise).rejects.toThrow(); await vi.advanceTimersByTimeAsync(1000); await assertion;
    release(); await vi.advanceTimersByTimeAsync(0); expect(f.events.some(v => v.startsWith("inspect:"))).toBe(false);
  });
  it("caller abort before and after preparation never reaches an effect", async () => {
    const f = admissionFixture(), g = f.create(), controller = new AbortController(); controller.abort();
    await expect(g.prepare(f.intent, controller.signal)).rejects.toThrow(); const p = await g.prepare(f.intent);
    await expect(g.execute(p, controller.signal)).rejects.toThrow(); expect(f.events.some(v => v.startsWith("effect:"))).toBe(false);
  });
  it("abort inside a fence prevents dispatch after its successful commit", async () => {
    const f = admissionFixture(), controller = new AbortController(), inspect = f.ports.database.inspect;
    f.ports.database.inspect = async (...a) => { const r = await inspect(...a); return { ...r, fence: async (s: AbortSignal) => { await r.fence(s); controller.abort(); } }; };
    const g = f.create(); await expect(g.execute(await g.prepare(f.intent), controller.signal)).rejects.toMatchObject({ effectMayHaveStarted: false });
    expect(f.events.some(v => v.startsWith("effect:"))).toBe(false);
  });
  it("cancellation after handler invocation preserves uncertainty and rejects late completion", async () => {
    const f = admissionFixture(), controller = new AbortController(); let finish!: () => void;
    f.ports.effects.sign = async () => { controller.abort(); await new Promise<void>(r => { finish = r; }); return "persisted signature"; };
    const g = f.create(); await expect(g.execute(await g.prepare(f.intent), controller.signal)).rejects.toMatchObject({ effectMayHaveStarted: true });
    finish(); await new Promise(r => setTimeout(r, 0)); expect(f.fences.size).toBe(1);
  });
  it("rejects a clock jump or permanent halt while inspecting the final durable state", async () => {
    for (const kind of ["clock", "halt"]) {
      const f = admissionFixture(), inspect = f.ports.database.inspect; let calls = 0, halt = () => {};
      f.ports.database.inspect = async (...a) => { const r = await inspect(...a); if (++calls === 2) { if (kind === "clock") f.advance(1000); else halt(); } return r; };
      const g = f.create(); halt = g.halt; await expect(g.execute(await g.prepare(f.intent))).rejects.toThrow(); expect(f.fences.size).toBe(0);
    }
  });
  it("halt is irreversible for this gate, including previously prepared permits", async () => {
    const f = admissionFixture(), g = f.create(), p = await g.prepare(f.intent); g.halt();
    await expect(g.execute(p)).rejects.toThrow(); await expect(g.prepare(f.intent)).rejects.toThrow();
  });
  it("review and live guards must be synchronous, not ignored async promises", async () => {
    const f = admissionFixture(); f.ports.requireReview = async () => {};
    await expect(f.create().prepare(f.intent)).rejects.toThrow();
    const h = admissionFixture(), inspect = h.ports.database.inspect;
    h.ports.database.inspect = async (...a) => ({ ...await inspect(...a), assertCurrent: async () => {} });
    await expect(h.create().prepare(h.intent)).rejects.toThrow();
  });
  it.each([NaN, -1, Infinity, 1.1])("invalid clock %s cannot prepare", async time => {
    const f = admissionFixture(); await expect(createAdmissionGate(f.scope, f.ports, () => time).prepare(f.intent)).rejects.toThrow();
  });
});

describe("admission exact-shape declarations", () => {
  const badFields = ["operatingPlanSha256", "activePolicySha256", "databaseBindingSha256", "reviewRevisionSha256", "writerEpoch", "timeoutMs", "permitTtlMs", "paidValidFrom", "paidValidUntil"];
  it.each(badFields)("rejects missing/invalid scope %s", field => {
    const f = admissionFixture(), c = { ...f.scope } as Record<string, unknown>; delete c[field];
    expect(() => createAdmissionGate(c as never, f.ports)).toThrow(); c[field] = null; expect(() => createAdmissionGate(c as never, f.ports)).toThrow();
  });
  it.each([0, -1, 30001, 1.5, NaN])("rejects invalid duration %s", timeoutMs => {
    const f = admissionFixture(); expect(() => createAdmissionGate({ ...f.scope, timeoutMs }, f.ports)).toThrow();
  });
  it("rejects extra approval fields, zero digests, invalid periods and missing registered handlers", () => {
    const f = admissionFixture();
    for (const patch of [{ approved: true }, { activePolicySha256: "0".repeat(64) }, { writerEpoch: "0" },
      { paidValidUntil: f.scope.paidValidFrom }, { paidValidUntil: f.scope.paidValidFrom + 32 * 86400000 }])
      expect(() => createAdmissionGate({ ...f.scope, ...patch }, f.ports)).toThrow();
    f.ports.effects.sign = undefined as never; expect(() => f.create()).toThrow();
  });
  it.each([null, [], { approved: true }, { operation: "sign" }, { operation: "admin", requestId: "a", payloadSha256: "a" },
    { operation: "read", requestId: "bad", payloadSha256: "a".repeat(64) }])("rejects malformed intent %j", intent => {
    const f = admissionFixture(); return expect(f.create().prepare(intent as AdmissionIntent)).rejects.toThrow();
  });
  it("does not invoke getters or accept hidden/symbol/prototype fields", async () => {
    const f = admissionFixture(), getter = vi.fn();
    const values = [Object.create(f.intent), Object.defineProperty({ ...f.intent }, "operation", { get: getter }),
      Object.defineProperty({ ...f.intent }, "secret", { value: "secret" }), { ...f.intent, [Symbol("approved")]: true }];
    for (const v of values) await expect(f.create().prepare(v)).rejects.toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});

describe("reviewed paid response lifetime is not dispatch authority", () => {
  function setup() {
    const f = admissionFixture(); Object.assign(f.scope, { paidCompletionMs: { "assessment-x": 20000, "assessment-grok": 100000 } });
    return { ...f, intent: { ...f.intent, operation: "assessment-grok" as const } };
  }
  it("accepts one response after HTTP, witness, lease and paid-dispatch window expiry without renewing any of them", async () => {
    const f = setup(); let saved!: Parameters<typeof f.ports.effects.read>[2];
    f.ports.effects["assessment-grok"] = async (_i, _s, guard) => {
      saved = guard; guard.beginDispatch!(); f.advance(90000);
      expect(() => guard()).toThrow(); expect(() => guard.beginDispatch!()).toThrow();
      guard.assertCompletion!(); return "one saved response";
    };
    const g = f.create(); expect(await g.execute(await g.prepare(f.intent))).toBe("one saved response");
    expect(() => saved.assertCompletion!()).toThrow();
    await expect(g.prepare(f.intent)).rejects.toThrow(); expect(f.fences.size).toBe(1);
  });
  it.each(["expired", "review", "cancel"])("requires fresh authority at actual dispatch after adapter await: %s", async reason => {
    const f = setup(), stop = new AbortController(); let calls = 0;
    f.ports.effects["assessment-grok"] = async (_i, _s, guard) => {
      await Promise.resolve(); if (reason === "expired") f.advance(1001);
      if (reason === "review") f.control.review = false; if (reason === "cancel") stop.abort();
      guard.beginDispatch!(); calls++; return "unexpected";
    };
    const g = f.create(); await expect(g.execute(await g.prepare(f.intent), stop.signal)).rejects.toThrow(); expect(calls).toBe(0);
  });
  it.each(["withdraw", "cancel", "halt", "timeout", "no-begin"])("withholds completion on %s and retains its fence", async reason => {
    const f = setup(), stop = new AbortController();
    f.ports.effects["assessment-grok"] = async (_i, _s, guard) => {
      if (reason !== "no-begin") guard.beginDispatch!();
      if (reason === "withdraw") f.control.review = false;
      if (reason === "cancel") stop.abort();
      if (reason === "halt") tested.halt();
      if (reason === "timeout") f.advance(100000);
      return "late response";
    };
    const tested = f.create(); await expect(tested.execute(await tested.prepare(f.intent), stop.signal)).rejects.toMatchObject({ effectMayHaveStarted: true });
    expect(f.fences.size).toBe(1);
  });
  it("times out hung completion with a frozen wall clock and cannot begin twice", async () => {
    vi.useFakeTimers(); const f = setup(); let checkpoint!: Parameters<typeof f.ports.effects.read>[2];
    f.ports.effects["assessment-grok"] = async (_i, _s, guard) => { checkpoint = guard; guard.beginDispatch!();
      expect(() => guard.beginDispatch!()).toThrow(); return new Promise(() => {}); };
    const g = f.create(), run = g.execute(await g.prepare(f.intent)), assertion = expect(run).rejects.toMatchObject({ effectMayHaveStarted: true });
    await vi.advanceTimersByTimeAsync(100000); await assertion;
    expect(() => checkpoint.assertCompletion!()).toThrow(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not extend pre-dispatch, sign, reuse or wallet budgets", async () => {
    for (const operation of ["assessment-x", "sign", "reuse", "wallet-submit"] as const) {
      const f = setup(); f.ports.effects[operation] = async (_i, _s, guard) => {
        if (operation !== "assessment-x") expect(guard.beginDispatch).toBeUndefined();
        f.advance(1000); return "too late";
      };
      const g = f.create(); await expect(g.execute(await g.prepare({ ...f.intent, operation }))).rejects.toThrow();
    }
  });
  it("pins and validates completion limits without changing legacy scope hashes", () => {
    const f = setup(), g = f.create(), original = g.scopeSha256;
    (f.scope.paidCompletionMs as { "assessment-grok": number })["assessment-grok"] = 99999;
    expect(g.scope.paidCompletionMs?.["assessment-grok"]).toBe(100000); expect(f.create().scopeSha256).not.toBe(original);
    for (const value of [undefined, {}, { "assessment-x": 0, "assessment-grok": 90000 }, { "assessment-x": 70001, "assessment-grok": 90000 },
      { "assessment-x": 20000, "assessment-grok": 120001 }, { "assessment-x": 1, "assessment-grok": NaN }]) {
      expect(() => createAdmissionGate({ ...f.scope, paidCompletionMs: value } as never, f.ports)).toThrow();
    }
  });
});
