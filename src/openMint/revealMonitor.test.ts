import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_MINT_CLIENT_SCRIPT } from "./clientScript.js";

const digest = `0x${"a".repeat(64)}`;
const confirming = { handle: "alice", tokenId: "123", artifactDigest: digest, state: "confirming" };
class Element {
  dataset: Record<string, string> = {};
  hidden = false;
  className = "";
  textContent = "";
  nodes: Element[] = [];
  children: Record<string, Element> = {};
  querySelector(key: string) { return this.children[key] ?? null; }
  replaceChildren() { this.nodes = []; }
  append(...nodes: Element[]) { this.nodes.push(...nodes); }
  text(): string { return this.textContent + this.nodes.map(node => node.text()).join(""); }
}
function setup(options: { dataset?: Record<string, string>; missing?: string; fetch?: typeof fetch; absent?: boolean; generative?: boolean } = {}) {
  vi.useFakeTimers();
  const root = new Element();
  root.dataset = { revealHandle: "alice", revealToken: "123", revealArtifact: digest, mintState: "confirming", ...options.dataset };
  if (options.generative) { delete root.dataset.revealArtifact; root.dataset.revealInput = digest; root.dataset.revealRenderer = `0x${"b".repeat(64)}`; }
  for (const key of ["mint-state-label", "reveal-feedback", "reveal-artwork", "reveal-provenance"]) root.children[`[data-${key}]`] = new Element();
  if (options.missing) delete root.children[options.missing];
  const events: Record<string, (event?: any) => void> = {};
  let result: unknown = confirming;
  const fetcher = vi.fn(options.fetch ?? (async () => Response.json(result)));
  const reload = vi.fn();
  const window = { addEventListener: (name: string, callback: () => void) => { events[name] = callback; } };
  Object.defineProperty(window, "ethereum", { get() { throw new Error("Public reveal must not touch a wallet"); } });
  const context = {
    window, document: {
      querySelector: (key: string) => !options.absent && ["[data-reveal-monitor]", "[data-open-mint]"].includes(key) ? root : null,
      createElement: () => new Element(), createTextNode: (text: string) => { const node = new Element(); node.textContent = text; return node; },
    },
    fetch: fetcher, location: { reload }, AbortController, TextDecoder, Uint8Array, performance,
    setTimeout, clearTimeout,
  };
  const run = () => runInNewContext(OPEN_MINT_CLIENT_SCRIPT, context);
  run();
  return { root, events, fetcher, reload, run, set: (value: unknown) => { result = value; },
    badge: root.children["[data-mint-state-label]"]!, feedback: root.children["[data-reveal-feedback]"]!, artwork: root.children["[data-reveal-artwork]"]!, provenance: root.children["[data-reveal-provenance]"]! };
}
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("read-only early reveal monitoring", () => {
  it("binds generative Confirming to inputs and renderer, never an old artifact hash", async () => {
    const f = setup({ generative: true });
    const state = { handle: "alice", tokenId: "123", state: "confirming", inputDigest: digest, rendererIdentity: `0x${"b".repeat(64)}` };
    await flush(); f.set(state); await vi.advanceTimersByTimeAsync(10000); expect(f.badge.textContent).toBe("Confirming");
    f.set({ ...state, state: "minted", rendererIdentity: digest }); await vi.advanceTimersByTimeAsync(5000);
    expect(f.badge.textContent).toBe("Confirmation unavailable"); expect(f.reload).not.toHaveBeenCalled();
    f.set({ ...state, state: "minted", artifactDigest: digest }); await vi.advanceTimersByTimeAsync(10000); expect(f.reload).not.toHaveBeenCalled();
    f.set({ ...state, state: "minted" }); await vi.advanceTimersByTimeAsync(20000); expect(f.reload).toHaveBeenCalledOnce();
  });
  it("rejects mixed input/artifact markup without fetching", async () => {
    const f = setup({ dataset: { revealInput: digest, revealRenderer: digest } }); await flush(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("polls only a bounded, uncached, same-origin read; no wallet/session work or duplicate binding", async () => {
    const f = setup(); await flush(); f.run();
    expect(f.badge.textContent).toBe("Confirming");
    expect(f.feedback.text()).toContain("still confirming");
    expect(f.artwork.hidden).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.fetcher).toHaveBeenCalledWith("/api/signatures/alice/status", { cache: "no-store", signal: expect.any(AbortSignal) });
    expect(f.reload).not.toHaveBeenCalled();
  });
  it("reloads into the terminal page only for the same verified artifact and token", async () => {
    const f = setup(); await flush(); f.set({ ...confirming, state: "minted" });
    await vi.advanceTimersByTimeAsync(5000); await flush();
    expect(f.reload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["pending", "unminted"])("withdraws artwork on %s without resubmitting, then restores the same verified artifact", async state => {
    const f = setup(); await flush(); f.set({ handle: "alice", tokenId: "123", state });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.badge.textContent).toBe("Rechecking mint");
    expect(f.feedback.text()).toContain("Warning");
    expect(f.artwork.hidden).toBe(true); expect(f.provenance.hidden).toBe(true);
    f.set({ ...confirming, state: "unknown" }); await vi.advanceTimersByTimeAsync(5000);
    expect(f.artwork.hidden).toBe(true); // Failure cannot restore a withdrawn reveal.
    f.set(confirming); await vi.advanceTimersByTimeAsync(10000);
    expect(f.artwork.hidden).toBe(false); expect(f.provenance.hidden).toBe(false);
    expect(f.badge.textContent).toBe("Confirming");
    expect(f.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    expect(f.reload).not.toHaveBeenCalled();
  });
  it.each([
    { ...confirming, handle: "other" }, { ...confirming, tokenId: "124" },
    { ...confirming, state: "minted", artifactDigest: `0x${"b".repeat(64)}` },
    { ...confirming, artifactDigest: undefined }, { ...confirming, state: "finalized" }, null,
  ])("fails closed on invalid confidence/bindings: %j", async result => {
    const f = setup(); await flush(); f.set(result); await vi.advanceTimersByTimeAsync(5000);
    expect(f.badge.textContent).toBe("Confirmation unavailable");
    expect(f.feedback.text()).toContain("No new mint will be submitted");
    expect(f.reload).not.toHaveBeenCalled();
  });
  it.each(["network", "status", "json", "oversized", "body"])("bounds %s failures with a generic warning and backoff", async kind => {
    const f = setup({ fetch: async () => {
      if (kind === "network") throw new Error("private diagnostic");
      if (kind === "status") return new Response("private diagnostic", { status: 503 });
      if (kind === "json") return new Response("not JSON");
      if (kind === "body") return new Response(null);
      return new Response("x".repeat(16385));
    } }); await flush();
    expect(f.badge.textContent).toBe("Confirmation unavailable");
    expect(f.feedback.text()).not.toContain("private diagnostic");
    await vi.advanceTimersByTimeAsync(9999); expect(f.fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.reload).not.toHaveBeenCalled();
  });
  it.each(["fetch", "body"])("times out a stalled %s and ignores late completion", async phase => {
    let release!: (value: Response) => void;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const f = setup({ fetch: async (_url, init) => {
      // Deliberately resolve after abort; the deadline still rejects late data.
      expect(init?.signal).toBeDefined();
      return phase === "fetch" ? new Promise(resolve => { release = resolve; }) : new Response(new ReadableStream({ start(value) { controller = value; } }));
    } }); await flush(); await vi.advanceTimersByTimeAsync(8000);
    expect(f.fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(f.badge.textContent).toBe("Confirmation unavailable");
    if (phase === "fetch") release(Response.json({ ...confirming, state: "minted" }));
    else { controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...confirming, state: "minted" }))); controller.close(); }
    await flush();
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.badge.textContent).toBe("Confirmation unavailable");
  });
  it("ignores completion after pagehide and resumes a restored page", async () => {
    let release!: (value: Response) => void;
    const f = setup({ fetch: () => new Promise(resolve => { release = resolve; }) });
    await flush(); f.events.pagehide!(); release(Response.json({ ...confirming, state: "minted" })); await flush();
    expect(f.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000); expect(f.fetcher).toHaveBeenCalledOnce();
    f.events.pageshow!({ persisted: true }); expect(f.fetcher).toHaveBeenCalledTimes(2);
    release(Response.json(confirming)); await flush(); expect(f.badge.textContent).toBe("Confirming");
  });
  it.each<Record<string, string>>([{ revealHandle: "../bad" }, { revealToken: "0x1" }, { revealArtifact: "" }])("does not fetch with invalid markup %j", async dataset => {
    const f = setup({ dataset }); await flush(); expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.badge.textContent).toBe("Confirmation unavailable");
  });
  it.each(["[data-mint-state-label]", "[data-reveal-feedback]", "[data-reveal-artwork]", "[data-reveal-provenance]"])("does not fetch with missing %s", async missing => {
    const f = setup({ missing }); await flush(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("ignores pages without a reveal monitor", async () => {
    const f = setup({ absent: true }); await flush(); expect(f.fetcher).not.toHaveBeenCalled();
  });
});
