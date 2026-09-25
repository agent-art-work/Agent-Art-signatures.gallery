import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectionPoller } from "./poller.js";
import { performance } from "node:perf_hooks";

const config = { intervalMs: 1000, maxBackoffMs: 8000, passTimeoutMs: 5000 };
const signal = () => new AbortController().signal;
describe("bounded read-only chain polling lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  const setup = () => {
    const coordinator = { sync: vi.fn(async (_signal: AbortSignal) => "observed" as const), withdraw: vi.fn() };
    const poller = createProjectionPoller(coordinator, config);
    return { coordinator, poller };
  };
  it("does nothing until explicitly started, then waits a full interval after each pass", async () => {
    const { coordinator, poller } = setup(); await vi.advanceTimersByTimeAsync(20_000);
    expect(poller.snapshot()).toEqual({ state: "idle", failures: 0 }); expect(coordinator.sync).not.toHaveBeenCalled();
    poller.start(signal()); await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.sync).toHaveBeenCalledOnce(); expect(poller.snapshot()).toMatchObject({ state: "waiting", lastOutcome: "observed", nextDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(999); expect(coordinator.sync).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(coordinator.sync).toHaveBeenCalledTimes(2);
    poller.stop(); await vi.advanceTimersByTimeAsync(20_000); expect(coordinator.sync).toHaveBeenCalledTimes(2);
    expect(coordinator.withdraw).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("backs off completed unavailable passes, caps delay, and resets only on observed success", async () => {
    const outcomes = ["unavailable", "unavailable", "unavailable", "unavailable", "observed"] as const;
    const sync = vi.fn(async () => outcomes[Math.min(sync.mock.calls.length - 1, outcomes.length - 1)]);
    const p = createProjectionPoller({ sync, withdraw: vi.fn() }, config); p.start(signal()); await vi.advanceTimersByTimeAsync(0);
    for (const delay of [2000, 4000, 8000, 8000]) {
      expect(p.snapshot()).toMatchObject({ state: "backing-off", nextDelayMs: delay }); await vi.advanceTimersByTimeAsync(delay);
    }
    expect(p.snapshot()).toEqual({ state: "waiting", failures: 0, lastOutcome: "observed", nextDelayMs: 1000 }); p.stop();
  });
  it.each([false, true])("owner can defer the first refresh; cancellation %s still removes its timer", async cancelled => {
    const coordinator = { sync: vi.fn(async () => "observed" as const), withdraw: vi.fn() };
    const p = createProjectionPoller(coordinator, { ...config, initialDelayMs: 1000 }), c = new AbortController();
    p.start(c.signal);
    expect(p.snapshot()).toEqual({ state: "waiting", failures: 0, nextDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(999); expect(coordinator.sync).not.toHaveBeenCalled();
    if (cancelled) c.abort();
    await vi.advanceTimersByTimeAsync(1); expect(coordinator.sync).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    await p.drain(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not overlap slow passes or accumulate missed ticks", async () => {
    let resolve!: (value: "observed") => void;
    const sync = vi.fn((_s: AbortSignal) => new Promise<"observed">(r => { resolve = r; }));
    const p = createProjectionPoller({ sync, withdraw: vi.fn() }, config); p.start(signal());
    await vi.advanceTimersByTimeAsync(4000); expect(sync).toHaveBeenCalledOnce();
    resolve("observed"); await vi.advanceTimersByTimeAsync(0); expect(p.snapshot().state).toBe("waiting");
    await vi.advanceTimersByTimeAsync(999); expect(sync).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(sync).toHaveBeenCalledTimes(2); p.stop();
  });
  it("withdraws late success when the event loop delays the deadline callback", async () => {
    let time = 0; vi.spyOn(performance, "now").mockImplementation(() => time);
    const withdraw = vi.fn(), sync = vi.fn(async () => { time = 5001; return "observed" as const; });
    const p = createProjectionPoller({ sync, withdraw }, config); p.start(signal()); await vi.advanceTimersByTimeAsync(0);
    expect(p.snapshot()).toEqual({ state: "failed", failures: 1, lastOutcome: "deadline" });
    expect(withdraw).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["resolve", "reject"])("halts on a hung pass and ignores its late %s", async mode => {
    let resolve!: (v: "observed") => void, reject!: (e: Error) => void;
    const sync = vi.fn((_s: AbortSignal) => new Promise<"observed">((a, b) => { resolve = a; reject = b; })), withdraw = vi.fn();
    const p = createProjectionPoller({ sync, withdraw }, config); p.start(signal()); await vi.advanceTimersByTimeAsync(5000);
    expect(p.snapshot()).toEqual({ state: "failed", failures: 1, lastOutcome: "deadline" }); expect(sync.mock.calls[0][0].aborted).toBe(true);
    if (mode === "resolve") resolve("observed"); else reject(new Error("secret transport details"));
    await vi.advanceTimersByTimeAsync(30_000); expect(sync).toHaveBeenCalledOnce(); expect(withdraw).toHaveBeenCalledOnce();
    expect(p.snapshot().state).toBe("failed"); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["safety-halted", "busy", "writer-unavailable"] as const)("stops without retry on %s", async outcome => {
    const sync = vi.fn(async () => outcome), withdraw = vi.fn(); const p = createProjectionPoller({ sync, withdraw }, config);
    p.start(signal()); await vi.advanceTimersByTimeAsync(30_000);
    expect(sync).toHaveBeenCalledOnce(); expect(withdraw).toHaveBeenCalledOnce(); expect(p.snapshot().state).toBe(outcome === "safety-halted" ? outcome : "failed");
    expect(() => p.start(signal())).toThrow("single-use"); p.stop(); expect(withdraw).toHaveBeenCalledOnce();
  });
  it.each([true, false])("consumes unexpected %s synchronous errors without leaking details", async synchronous => {
    const sync = vi.fn(() => { if (synchronous) throw new Error("secret"); return Promise.reject(new Error("secret")); });
    const p = createProjectionPoller({ sync, withdraw: vi.fn() }, config); p.start(signal()); await vi.advanceTimersByTimeAsync(30_000);
    expect(p.snapshot()).toEqual({ state: "failed", failures: 1, lastOutcome: "error" }); expect(sync).toHaveBeenCalledOnce();
  });
  it.each(["before", "immediately", "running", "waiting"])("parent cancellation %s permanently withdraws reads and removes timers", async when => {
    const c = new AbortController(), { coordinator, poller } = setup();
    if (when === "before") c.abort();
    if (when === "running") coordinator.sync.mockImplementation(async () => new Promise(() => {}));
    poller.start(c.signal);
    if (when === "immediately") c.abort(); else { await vi.advanceTimersByTimeAsync(0); c.abort(); }
    await vi.advanceTimersByTimeAsync(30_000); expect(poller.snapshot().state).toBe("stopped"); expect(coordinator.withdraw).toHaveBeenCalledOnce();
    expect(coordinator.sync).toHaveBeenCalledTimes(["before", "immediately"].includes(when) ? 0 : 1); expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects restart and defensively snapshots configuration and status", async () => {
    const coordinator = { sync: vi.fn(async () => "observed" as const), withdraw: vi.fn() }, input = { ...config };
    const p = createProjectionPoller(coordinator, input); input.intervalMs = 0; p.start(signal());
    expect(() => p.start(signal())).toThrow(); await vi.advanceTimersByTimeAsync(0);
    expect(Object.isFrozen(p.snapshot())).toBe(true); expect(p.snapshot().nextDelayMs).toBe(1000); p.stop();
    const unopened = createProjectionPoller(coordinator, config); unopened.stop(); expect(() => unopened.start(signal())).toThrow();
  });
  it.each([
    { intervalMs: 0 }, { intervalMs: 249 }, { intervalMs: 60001 }, { intervalMs: NaN },
    { maxBackoffMs: 999 }, { maxBackoffMs: 300001 }, { maxBackoffMs: 1000.5 },
    { passTimeoutMs: 0 }, { passTimeoutMs: 60001 }, { passTimeoutMs: Infinity },
    { initialDelayMs: -1 }, { initialDelayMs: 1001 }, { initialDelayMs: 0.5 }, { initialDelayMs: NaN },
  ])("rejects invalid policy %j", change => {
    expect(() => createProjectionPoller({ sync: vi.fn(), withdraw: vi.fn() }, { ...config, ...change })).toThrow("polling policy");
  });
});
