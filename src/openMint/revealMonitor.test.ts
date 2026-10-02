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
  parent: Element | undefined;
  querySelector(key: string) { return this.children[key] ?? null; }
  closest(key: string): Element | null {
    const scopes: Record<string, string> = { "[data-mint-process]": "mintProcess", "[data-assessment-code]": "assessmentCode", "[data-mint-entry]": "mintEntry" };
    return key.split(",").some(selector => scopes[selector] && this.dataset[scopes[selector]] !== undefined) ? this : this.parent?.closest(key) ?? null;
  }
  replaceChildren() { this.nodes = []; }
  append(...nodes: Element[]) { this.nodes.push(...nodes); }
  text(): string { return this.textContent + this.nodes.map(node => node.text()).join(""); }
}
function setup(options: { dataset?: Record<string, string>; missing?: string; fetch?: typeof fetch; absent?: boolean; generative?: boolean; mintProcess?: boolean; mintWrapper?: boolean; assessmentWrapper?: boolean; entryWrapper?: boolean; sharedNotice?: boolean; initialNotice?: string } = {}) {
  vi.useFakeTimers();
  const root = new Element();
  root.dataset = { revealHandle: "alice", revealToken: "123", revealArtifact: digest, mintState: "confirming", ...options.dataset };
  if (options.mintProcess) root.dataset.mintProcess = "";
  if (options.mintWrapper) { root.parent = new Element(); root.parent.dataset.mintProcess = ""; }
  if (options.assessmentWrapper) { root.parent = new Element(); root.parent.dataset.assessmentCode = "saved-request"; }
  if (options.entryWrapper) { root.parent = new Element(); root.parent.dataset.mintEntry = ""; }
  if (options.generative) { delete root.dataset.revealArtifact; root.dataset.revealInput = digest; root.dataset.revealRenderer = `0x${"b".repeat(64)}`; }
  for (const key of ["mint-state-label", "reveal-feedback", "reveal-artwork", "reveal-provenance"]) root.children[`[data-${key}]`] = new Element();
  root.children["[data-mint-state-label]"]!.textContent = "Confirming";
  const mountedWarning = new Element(), mountedMessage = new Element();
  mountedWarning.hidden = !options.initialNotice; mountedMessage.textContent = options.initialNotice ?? "";
  if (options.missing) delete root.children[options.missing];
  const events: Record<string, (event?: any) => void> = {};
  let result: unknown = confirming;
  const fetcher = vi.fn(options.fetch ?? (async () => Response.json(result)));
  const reload = vi.fn();
  const window = { addEventListener: (name: string, callback: () => void) => { events[name] = callback; } };
  Object.defineProperty(window, "ethereum", { get() { throw new Error("Public reveal must not touch a wallet"); } });
  const context = {
    window, document: {
      querySelector: (key: string) => {
        if (options.sharedNotice && key === "[data-mint-observation-warning]") return mountedWarning;
        if (options.sharedNotice && key === "[data-mint-observation-message]") return mountedMessage;
        return !options.absent && ["[data-reveal-monitor]", "[data-open-mint]"].includes(key) ? root : null;
      },
      createElement: () => new Element(), createTextNode: (text: string) => { const node = new Element(); node.textContent = text; return node; },
    },
    fetch: fetcher, location: { reload }, AbortController, TextDecoder, Uint8Array, performance,
    setTimeout, clearTimeout,
  };
  const run = () => runInNewContext(OPEN_MINT_CLIENT_SCRIPT, context);
  run();
  return { root, events, fetcher, reload, run, mountedWarning, mountedMessage, set: (value: unknown) => { result = value; },
    badge: root.children["[data-mint-state-label]"]!, feedback: root.children["[data-reveal-feedback]"]!, artwork: root.children["[data-reveal-artwork]"]!, provenance: root.children["[data-reveal-provenance]"]! };
}
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("read-only early reveal monitoring", () => {
  it("binds generative Confirming to inputs and renderer, never an old artifact hash", async () => {
    const f = setup({ generative: true, mintProcess: true });
    const state = { handle: "alice", tokenId: "123", state: "confirming", inputDigest: digest, rendererIdentity: `0x${"b".repeat(64)}` };
    await flush(); f.set(state); await vi.advanceTimersByTimeAsync(10000); expect(f.badge.textContent).toBe("Confirming");
    f.set({ ...state, state: "minted", rendererIdentity: digest }); await vi.advanceTimersByTimeAsync(5000);
    expect(f.badge.textContent).toBe("Rechecking mint"); expect(f.reload).not.toHaveBeenCalled();
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
  it.each(["pending", "unminted"])("keeps previously revealed artwork on %s with honest rechecking status and never resubmits", async state => {
    const f = setup(); await flush(); f.set({ handle: "alice", tokenId: "123", state });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.badge.textContent).toBe("Rechecking mint");
    expect(f.feedback.text()).toBe(""); expect(f.feedback.hidden).toBe(true);
    expect(f.feedback.className).not.toContain("warning");
    expect(f.artwork.hidden).toBe(false); expect(f.provenance.hidden).toBe(false);
    f.set({ ...confirming, state: "unknown" }); await vi.advanceTimersByTimeAsync(5000);
    expect(f.artwork.hidden).toBe(false); // A read failure cannot replace the last verified state.
    expect(f.badge.textContent).toBe("Rechecking mint"); expect(f.feedback.text()).toBe("");
    f.set(confirming); await vi.advanceTimersByTimeAsync(10000);
    expect(f.artwork.hidden).toBe(false); expect(f.provenance.hidden).toBe(false);
    expect(f.badge.textContent).toBe("Confirming");
    expect(f.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    expect(f.reload).not.toHaveBeenCalled();
  });
  it.each([
    { ...confirming, handle: undefined }, { ...confirming, tokenId: 123 },
    { ...confirming, artifactDigest: undefined }, { ...confirming, artifactDigest: "malformed" }, { ...confirming, state: "finalized" }, null,
  ])("quietly retains the last verified badge on incomplete or malformed evidence: %j", async result => {
    const f = setup(); await flush(); f.set(result); await vi.advanceTimersByTimeAsync(5000);
    expect(f.badge.textContent).toBe("Confirming");
    expect(f.feedback.text()).toBe(""); expect(f.feedback.hidden).toBe(true);
    expect(f.reload).not.toHaveBeenCalled();
  });
  it.each([
    { ...confirming, handle: "other" }, { ...confirming, tokenId: "124" },
    { ...confirming, state: "minted", artifactDigest: `0x${"b".repeat(64)}` },
    { ...confirming, inputDigest: digest },
  ])("downgrades contradictory successful passive evidence without hiding the reveal or warning: %j", async result => {
    const f = setup({ sharedNotice: true }); await flush(); f.set(result); await vi.advanceTimersByTimeAsync(5000);
    expect(f.badge.textContent).toBe("Rechecking mint"); expect(f.root.dataset.mintState).toBe("rechecking");
    expect(f.artwork.hidden).toBe(false); expect(f.provenance.hidden).toBe(false);
    expect(f.feedback.hidden).toBe(true); expect(f.feedback.text()).toBe("");
    expect(f.mountedWarning.hidden).toBe(true); expect(f.mountedMessage.textContent).toBe("");
    expect(f.reload).not.toHaveBeenCalled();
    f.set({ ...confirming, state: "unknown" }); await vi.advanceTimersByTimeAsync(10000);
    expect(f.badge.textContent).toBe("Rechecking mint");
    f.set(confirming); await vi.advanceTimersByTimeAsync(20000);
    expect(f.badge.textContent).toBe("Confirming"); expect(f.root.dataset.mintState).toBe("confirming");
    expect(f.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
  it.each(["inputDigest", "rendererIdentity"])("quietly rechecks a passive generative %s conflict", async field => {
    const f = setup({ generative: true, sharedNotice: true });
    const result = { handle: "alice", tokenId: "123", state: "confirming", inputDigest: digest, rendererIdentity: `0x${"b".repeat(64)}` };
    f.set(result); await flush();
    f.set({ ...result, [field]: `0x${"c".repeat(64)}` }); await vi.advanceTimersByTimeAsync(5000);
    expect(f.badge.textContent).toBe("Rechecking mint"); expect(f.root.dataset.mintState).toBe("rechecking");
    expect(f.feedback.text()).toBe(""); expect(f.feedback.hidden).toBe(true); expect(f.mountedWarning.hidden).toBe(true);
    expect(f.artwork.hidden).toBe(false); expect(f.provenance.hidden).toBe(false); expect(f.reload).not.toHaveBeenCalled();
  });
  it("warns once in the shared active mint notice on disputed binding, and clears it on accepted recovery", async () => {
    const f = setup({ mintWrapper: true, sharedNotice: true }); await flush();
    f.set({ ...confirming, state: "minted", tokenId: "124" }); await vi.advanceTimersByTimeAsync(5000);
    expect(f.badge.textContent).toBe("Rechecking mint"); expect(f.root.dataset.mintState).toBe("rechecking");
    expect(f.mountedWarning.hidden).toBe(false); expect(f.mountedWarning.dataset.noticeOwner).toBe("mint-confirmation");
    expect(f.mountedMessage.textContent).toContain("does not match this signature"); expect(f.mountedMessage.textContent).toContain("do not submit another mint");
    expect(f.feedback.hidden).toBe(true); expect(f.feedback.text()).toBe("");
    expect(f.artwork.hidden).toBe(false); expect(f.provenance.hidden).toBe(false); expect(f.reload).not.toHaveBeenCalled();
    f.set(confirming); await vi.advanceTimersByTimeAsync(10000);
    expect(f.badge.textContent).toBe("Confirming"); expect(f.root.dataset.mintState).toBe("confirming");
    expect(f.mountedWarning.hidden).toBe(true); expect(f.mountedMessage.textContent).toBe(""); expect(f.mountedWarning.dataset.noticeOwner).toBeUndefined();
    expect(f.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
  it.each(["network", "status", "json", "oversized", "body"])("quietly bounds passive %s failures without changing verified status", async kind => {
    const f = setup({ fetch: async () => {
      if (kind === "network") throw new Error("private diagnostic");
      if (kind === "status") return new Response("private diagnostic", { status: 503 });
      if (kind === "json") return new Response("not JSON");
      if (kind === "body") return new Response(null);
      return new Response("x".repeat(16385));
    } }); await flush();
    expect(f.badge.textContent).toBe("Confirming");
    expect(f.feedback.text()).toBe(""); expect(f.feedback.hidden).toBe(true);
    expect(f.feedback.className).not.toContain("warning");
    await vi.advanceTimersByTimeAsync(9999); expect(f.fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.reload).not.toHaveBeenCalled();
  });
  it.each(["article", "wrapper", "assessment", "entry"])("warns only the mint process when scoped by its %s", async scope => {
    const f = setup({ mintProcess: scope === "article", mintWrapper: scope === "wrapper", assessmentWrapper: scope === "assessment", entryWrapper: scope === "entry",
      fetch: async () => { throw new Error("private RPC error"); } });
    await flush();
    expect(f.badge.textContent).toBe("Confirmation unavailable");
    expect(f.feedback.text()).toContain("Warning");
    expect(f.feedback.text()).toContain("No new mint will be submitted");
    expect(f.feedback.text()).not.toContain("private RPC error"); expect(f.feedback.hidden).toBe(false);
    expect(f.artwork.hidden).toBe(false); expect(f.provenance.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(10000); expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.reload).not.toHaveBeenCalled();
  });
  it("keeps the mint process reorganization warning and the revealed artwork", async () => {
    const f = setup({ mintWrapper: true }); await flush(); f.set({ handle: "alice", tokenId: "123", state: "pending" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.badge.textContent).toBe("Rechecking mint"); expect(f.feedback.text()).toContain("Warning");
    expect(f.feedback.text()).toContain("do not submit another mint");
    expect(f.artwork.hidden).toBe(false); expect(f.provenance.hidden).toBe(false);
    expect(f.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
  it("claims and clears an existing server-rendered confirmation notice on accepted recovery", async () => {
    const f = setup({ mintWrapper: true, sharedNotice: true, initialNotice: "Confirmation could not be checked." });
    expect(f.mountedWarning.dataset.noticeOwner).toBe("mint-confirmation");
    await flush();
    expect(f.badge.textContent).toBe("Confirming");
    expect(f.mountedWarning.hidden).toBe(true); expect(f.mountedMessage.textContent).toBe("");
    expect(f.mountedWarning.dataset.noticeOwner).toBeUndefined();
    expect(f.feedback.text()).not.toContain("Warning"); expect(f.feedback.text()).toContain("still confirming");
  });
  it("uses a single shared mint warning through read failure, changed evidence and recovery", async () => {
    let fail = true;
    const f = setup({ mintWrapper: true, sharedNotice: true, fetch: async () => {
      if (fail) throw new Error("private diagnostic");
      return Response.json(confirming);
    } }); await flush();
    expect(f.mountedWarning.hidden).toBe(false); expect(f.mountedWarning.dataset.noticeOwner).toBe("mint-confirmation");
    expect(f.mountedMessage.textContent).toContain("No new mint will be submitted");
    expect(f.mountedMessage.textContent).not.toContain("private diagnostic");
    expect(f.feedback.text()).toBe(""); expect(f.feedback.hidden).toBe(true); expect(f.feedback.className).not.toContain("warning");
    fail = false; await vi.advanceTimersByTimeAsync(10000);
    expect(f.mountedWarning.hidden).toBe(true); expect(f.mountedMessage.textContent).toBe("");
    expect(f.mountedWarning.dataset.noticeOwner).toBeUndefined(); expect(f.badge.textContent).toBe("Confirming");
    expect(f.artwork.hidden).toBe(false); expect(f.provenance.hidden).toBe(false); expect(f.reload).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
  it("shows rechecking in the shared mint notice without a second local warning", async () => {
    const f = setup({ mintWrapper: true, sharedNotice: true }); await flush(); f.set({ handle: "alice", tokenId: "123", state: "pending" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.badge.textContent).toBe("Rechecking mint"); expect(f.mountedMessage.textContent).toContain("do not submit another mint");
    expect(f.mountedWarning.hidden).toBe(false); expect(f.mountedWarning.dataset.noticeOwner).toBe("mint-confirmation");
    expect(f.feedback.hidden).toBe(true); expect(f.feedback.text()).toBe("");
  });
  it("silently clears legacy passive warning mounts before and after failed reads", async () => {
    const f = setup({ sharedNotice: true, initialNotice: "Gallery RPC unavailable.", fetch: async () => { throw new Error("private RPC error"); } });
    expect(f.mountedWarning.hidden).toBe(true); expect(f.mountedMessage.textContent).toBe("");
    await flush(); expect(f.feedback.hidden).toBe(true); expect(f.feedback.text()).toBe(""); expect(f.badge.textContent).toBe("Confirming");
    f.mountedWarning.hidden = false; f.mountedMessage.textContent = "Older warning";
    await vi.advanceTimersByTimeAsync(10000); expect(f.mountedWarning.hidden).toBe(true); expect(f.mountedMessage.textContent).toBe("");
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
    expect(f.badge.textContent).toBe("Confirming"); expect(f.feedback.hidden).toBe(true);
    if (phase === "fetch") release(Response.json({ ...confirming, state: "minted" }));
    else { controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...confirming, state: "minted" }))); controller.close(); }
    await flush();
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.badge.textContent).toBe("Confirming");
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
    expect(f.badge.textContent).toBe("Confirming"); expect(f.feedback.hidden).toBe(true);
  });
  it.each(["[data-mint-state-label]", "[data-reveal-feedback]", "[data-reveal-artwork]", "[data-reveal-provenance]"])("does not fetch with missing %s", async missing => {
    const f = setup({ missing }); await flush(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("ignores pages without a reveal monitor", async () => {
    const f = setup({ absent: true }); await flush(); expect(f.fetcher).not.toHaveBeenCalled();
  });
});
