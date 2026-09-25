import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssessmentExecution, ProviderLeg } from "./assessmentOperations.js";
import { receiptedJsonRequest } from "./providerReceipt.js";
import { XApiIdentityResolver } from "./xIdentity.js";
import { GrokAssessmentProvider } from "./grok.js";

function harness(leg: ProviderLeg = "grok") {
  const stop = new AbortController(), controls = { valid: true };
  const execution: AssessmentExecution = { attemptId: "offline-dispatch-test", dispatch: { signal: stop.signal,
    assertCurrent: vi.fn(value => { if (!controls.valid || value !== leg) throw Error("review unavailable"); }) },
    recordReceipt: vi.fn(async () => {}), beforeDispatch: vi.fn(async () => {}), identityVerified: vi.fn(async () => {}),
    recordOutcome: vi.fn(async () => {}), assessmentPersisted: vi.fn(async () => {}) };
  const fetch = vi.fn(async (_signal: AbortSignal) => Response.json({ ok: true }));
  const options = { leg, execution, timeoutMs: 1000, maxBytes: 1024, bodyPrefix: "Grok", transportError: "transport failed", timeoutError: "timed out",
    httpError: (status: number) => `HTTP ${status}`, fetch };
  return { stop, controls, execution, fetch, options, run: () => receiptedJsonRequest(options) };
}
afterEach(() => vi.useRealTimers());
describe("provider transport admission checkpoint (offline fetch only)", () => {
  it.each(["revoked", "cancelled", "async-guard", "crossed-leg"])("does not fetch or fabricate receipts on %s before dispatch", async scenario => {
    const h = harness();
    if (scenario === "revoked") h.controls.valid = false;
    if (scenario === "cancelled") h.stop.abort();
    if (scenario === "async-guard") h.execution.dispatch!.assertCurrent = (async () => {}) as never;
    if (scenario === "crossed-leg") h.options.leg = "x-identity";
    await expect(h.run()).rejects.toThrow(); expect(h.fetch).not.toHaveBeenCalled(); expect(h.execution.recordReceipt).not.toHaveBeenCalled();
  });
  it("checks immediately before fetch and again after receipt persistence", async () => {
    const h = harness(), events: string[] = [];
    h.execution.dispatch!.assertCurrent = () => { events.push("guard"); };
    h.fetch.mockImplementation(async () => { events.push("fetch"); return Response.json({ ok: true }); });
    h.execution.recordReceipt = async () => { await Promise.resolve(); events.push("receipt"); };
    expect(await h.run()).toEqual({ ok: true }); expect(events).toEqual(["guard", "fetch", "receipt", "guard"]);
  });
  it("separates one-shot dispatch from completion and cannot fetch again with the same checkpoint", async () => {
    const h = harness(), events: string[] = []; let begun = false;
    h.execution.dispatch!.beginDispatch = () => { if (begun) throw Error("used"); begun = true; events.push("begin"); };
    h.execution.dispatch!.assertCompletion = () => { events.push("complete"); };
    h.fetch.mockImplementation(async () => { events.push("fetch"); return Response.json({ ok: true }); });
    h.execution.recordReceipt = vi.fn(async () => { events.push("receipt"); });
    expect(await h.run()).toEqual({ ok: true }); expect(events).toEqual(["begin", "fetch", "receipt", "complete"]);
    expect(h.execution.dispatch!.assertCurrent).not.toHaveBeenCalled();
    await expect(h.run()).rejects.toThrow("used"); expect(h.fetch).toHaveBeenCalledOnce(); expect(h.execution.recordReceipt).toHaveBeenCalledOnce();
  });
  it.each(["review", "cancel"])("keeps observed accounting but withholds success after %s during persistence", async reason => {
    const h = harness();
    h.execution.recordReceipt = vi.fn(async () => { await Promise.resolve(); if (reason === "review") h.controls.valid = false; else h.stop.abort(); });
    await expect(h.run()).rejects.toThrow(); expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.execution.recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ category: "success", httpStatus: 200 }));
  });
  it("cancels an unresponsive transport once, preserving unknown cost and rejecting late success", async () => {
    const h = harness(); let settle!: (response: Response) => void, received: AbortSignal | undefined;
    h.fetch.mockImplementation(signal => { received = signal; return new Promise(resolve => { settle = resolve; }); });
    const work = h.run(); expect(h.fetch).toHaveBeenCalledOnce(); h.stop.abort();
    await expect(work).rejects.toThrow("transport failed"); expect(received?.aborted).toBe(true);
    expect(h.execution.recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ category: "transport-error", cost: { status: "unknown", currency: "USD", scale: 10 } }));
    const response = Response.json({ ok: true }), cancel = vi.spyOn(response.body!, "cancel"); settle(response);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled()); expect(h.execution.recordReceipt).toHaveBeenCalledOnce();
  });
  it("cleans up its admission listener and timer when the checkpoint throws", async () => {
    vi.useFakeTimers(); const h = harness(), remove = vi.spyOn(h.stop.signal, "removeEventListener"); h.controls.valid = false;
    await expect(h.run()).rejects.toThrow(); expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it.each(["x-identity", "grok"] as const)("carries the checkpoint into the actual %s client", async leg => {
    const h = harness(leg), fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({})); h.controls.valid = false;
    const call = leg === "x-identity" ? new XApiIdentityResolver({ bearerToken: "offline-placeholder", fetch }).resolve("Alice", h.execution)
      : new GrokAssessmentProvider({ apiKey: "offline-placeholder", fetch }).assess("Alice", undefined, h.execution);
    await expect(call).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled(); expect(h.execution.recordReceipt).not.toHaveBeenCalled();
  });
});
