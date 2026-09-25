import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedGenerativeSite } from "./generativeSite.js";

const mocks = vi.hoisted(() => ({ open: vi.fn(), coordinator: vi.fn(), artwork: vi.fn(), pages: vi.fn(), server: vi.fn(), close: vi.fn(), chain: vi.fn(), browser: vi.fn() }));
vi.mock("../projection/postgres.js", () => ({ OpenMintProjection: { open: mocks.open } }));
vi.mock("../projection/coordinator.js", () => ({ createProjectionCoordinator: mocks.coordinator }));
vi.mock("../projection/generativeArtwork.js", () => ({ createGenerativeArtworkReads: mocks.artwork }));
vi.mock("./generativeSitePages.js", () => ({ createGenerativeSitePages: mocks.pages }));
vi.mock("./http.js", () => ({ createDurableMintApiServer: mocks.server }));
vi.mock("../shutdown.js", () => ({ closeHttpServer: mocks.close }));
vi.mock("../walletChain.js", () => ({ GenerativeWalletChain: mocks.chain }));
vi.mock("./generativeBrowser.js", () => ({ GenerativeMintBrowser: mocks.browser }));

function siteFixture(contractProfile: string) {
  const contract = "0x1111111111111111111111111111111111111111", authorizer = "0x2222222222222222222222222222222222222222";
  const genesis = "0x" + "01".repeat(32), code = "0x" + "02".repeat(32), block = "0x" + "03".repeat(32);
  const server = Object.assign(new EventEmitter(), { listen: vi.fn(() => { queueMicrotask(() => server.emit("listening")); }) });
  const writer = {}, runtime = { contractProfile, sessions: { origin: "http://127.0.0.1:12345" },
    requests: { profile: { chain_id: "31337", session_chain_id: "31337", origin: "http://127.0.0.1:12345", deployment_id: "dep",
      contract_address: contract, genesis_hash: genesis, runtime_code_hash: code, authorizer, deployment_block: "1", deployment_block_hash: block },
    repository: { namespace: { profile: "local-real", id: "ns" }, writer, getAcceptedAssessment: vi.fn() } }, drain: vi.fn(async () => {}) };
  const coordinator = { sync: vi.fn(async (_signal: AbortSignal) => "observed" as "observed" | "unavailable"), withdraw: vi.fn(), lookup: vi.fn(), gallery: vi.fn() };
  mocks.open.mockResolvedValue({}); mocks.coordinator.mockReturnValue(coordinator); mocks.server.mockReturnValue(server);
  mocks.artwork.mockReturnValue({ drain: vi.fn(async () => {}) });
  mocks.chain.mockImplementation(function (config) { return { config: structuredClone(config) }; }); mocks.close.mockResolvedValue(undefined);
  const input = { runtime, observation: { config: { contractProfile, deploymentId: "dep", namespaceId: "ns", chainId: 31337n,
    contract, authorizer, genesisHash: genesis, runtimeCodeHash: code, deploymentBlock: { number: 1n, hash: block } }, deployment: { id: "dep", namespaceId: "ns" }, rpcs: [] },
    polling: { intervalMs: 250, maxBackoffMs: 1000, passTimeoutMs: 1000 }, shutdownTimeoutMs: 2000 };
  const create = () => createIsolatedGenerativeSite(input as unknown as Parameters<typeof createIsolatedGenerativeSite>[0]);
  return { server, runtime, coordinator, input, create, writer };
}

describe.each(["generative-experimental-v1", "generative-v1-rc1"])("%s explicit isolated-site startup and drain", contractProfile => {
  const fixture = () => siteFixture(contractProfile);
  beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  it("does no listening or observation until start; starts one bounded independent observer", async () => {
    const f = fixture(), site = await f.create(); expect(site.snapshot().phase).toBe("idle");
    expect(f.server.listen).not.toHaveBeenCalled(); expect(f.coordinator.sync).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith(f.writer, f.input.observation.deployment);
    expect(Object.keys(site.reads).sort()).toEqual(["gallery", "lookup"]);
    await site.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.server.listen).toHaveBeenCalledWith(12345, "127.0.0.1"); expect(f.coordinator.sync).toHaveBeenCalledOnce();
    expect(site.snapshot()).toMatchObject({ phase: "running", observer: { state: "waiting", lastOutcome: "observed" } });
    await expect(site.start()).rejects.toThrow("single-use"); await site.close();
    expect(site.snapshot().phase).toBe("closed"); expect(f.runtime.drain).toHaveBeenCalledOnce(); expect(f.coordinator.withdraw).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000); expect(f.coordinator.sync).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("backs off unavailable chain reads without restarting app work", async () => {
    const f = fixture(); f.coordinator.sync.mockResolvedValue("unavailable"); const site = await f.create(); await site.start(); await vi.advanceTimersByTimeAsync(0);
    expect(site.snapshot().observer.state).toBe("backing-off"); await vi.advanceTimersByTimeAsync(500); expect(f.coordinator.sync).toHaveBeenCalledTimes(2);
    expect(f.runtime.drain).not.toHaveBeenCalled(); await site.close();
  });
  it("withdraws immediately, waits for the current pass and returns one idempotent close promise", async () => {
    const f = fixture(); let resolve!: (v: "observed") => void;
    f.coordinator.sync.mockImplementation(() => new Promise(r => { resolve = r; }));
    const site = await f.create(); await site.start(); await vi.advanceTimersByTimeAsync(0);
    const closing = site.close(); expect(site.close()).toBe(closing); expect(f.coordinator.sync.mock.calls[0][0].aborted).toBe(true);
    expect(site.snapshot().phase).toBe("closing"); expect(f.runtime.drain).toHaveBeenCalledOnce(); resolve("observed"); await closing;
    expect(site.snapshot().phase).toBe("closed"); expect(site.snapshot().observer.state).toBe("stopped");
  });
  it.each(["worker", "observer", "http", "artwork"])("bounds an uncooperative %s drain without releasing writer ownership", async kind => {
    const f = fixture();
    if (kind === "worker") f.runtime.drain.mockImplementation(() => new Promise(() => {}));
    if (kind === "observer") f.coordinator.sync.mockImplementation(() => new Promise(() => {}));
    if (kind === "http") mocks.close.mockImplementation(() => new Promise(() => {}));
    if (kind === "artwork") mocks.artwork.mockReturnValue({ drain: () => new Promise(() => {}) });
    const site = await f.create(); await site.start(); await vi.advanceTimersByTimeAsync(0);
    const closing = expect(site.close()).rejects.toThrow("writer ownership was not released"); await vi.advanceTimersByTimeAsync(2000); await closing;
    expect(site.snapshot().phase).toBe("failed"); expect(vi.getTimerCount()).toBe(0);
  });
  it("stops observation if the caller closes its listener", async () => {
    const f = fixture(), site = await f.create(); await site.start(); await vi.advanceTimersByTimeAsync(0); f.server.emit("close"); await site.close();
    expect(site.snapshot().phase).toBe("closed"); expect(f.coordinator.withdraw).toHaveBeenCalledOnce();
  });
  it("consumes bind failure and drains rather than starting an observer", async () => {
    const f = fixture(); f.server.listen.mockImplementation(() => { queueMicrotask(() => f.server.emit("error", new Error("EADDRINUSE"))); });
    const site = await f.create(); await expect(site.start()).rejects.toThrow("could not start"); expect(f.coordinator.sync).not.toHaveBeenCalled(); expect(site.snapshot().phase).toBe("closed");
  });
  it("can be closed before startup and refuses a later start", async () => {
    const f = fixture(), site = await f.create(); await site.close(); await expect(site.start()).rejects.toThrow("single-use"); expect(f.server.listen).not.toHaveBeenCalled();
  });
  it("does not start an observer when closed during listener startup", async () => {
    const f = fixture(); f.server.listen.mockImplementation(() => {}); const site = await f.create();
    const starting = expect(site.start()).rejects.toThrow("could not start"); await site.close(); f.server.emit("listening"); await starting;
    expect(f.coordinator.sync).not.toHaveBeenCalled(); expect(site.snapshot().phase).toBe("closed");
  });
  it("reports a drain rejection without leaking its details", async () => {
    const f = fixture(); f.runtime.drain.mockRejectedValue(new Error("private transport")); const site = await f.create();
    await expect(site.close()).rejects.toThrow("operator review"); expect(site.snapshot().phase).toBe("failed"); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["production", "profile", "profile-mismatch", "namespace", "chain", "deployment", "projection", "projection-namespace", "timeout"])("refuses invalid %s configuration before projection writes", async kind => {
    const f = fixture();
    if (kind === "production") vi.stubEnv("NODE_ENV", "production");
    if (kind === "profile") f.runtime.contractProfile = "external-v1";
    if (kind === "profile-mismatch") f.input.observation.config.contractProfile =
      contractProfile === "generative-v1-rc1" ? "generative-experimental-v1" : "generative-v1-rc1";
    if (kind === "namespace") f.runtime.requests.repository.namespace.profile = "production";
    if (kind === "chain") f.runtime.requests.profile.chain_id = "1";
    if (kind === "deployment") f.input.observation.config.deploymentId = "other";
    if (kind === "projection") f.input.observation.deployment.id = "other";
    if (kind === "projection-namespace") f.input.observation.deployment.namespaceId = "other";
    if (kind === "timeout") f.input.shutdownTimeoutMs = 60001;
    await expect(f.create()).rejects.toThrow("configuration"); expect(mocks.open).not.toHaveBeenCalled(); expect(f.server.listen).not.toHaveBeenCalled();
  });
  it.each(["https://127.0.0.1:12345", "http://localhost:12345", "http://0.0.0.0:12345", "http://127.0.0.1", "http://127.0.0.1:0", "http://user:pass@127.0.0.1:12345", "http://127.0.0.1:12345/path", "http://127.0.0.1:12345#fragment"])("refuses unsafe listener %s", async origin => {
    const f = fixture(); f.runtime.sessions.origin = origin; await expect(f.create()).rejects.toThrow("configuration"); expect(mocks.open).not.toHaveBeenCalled();
  });
  it.each(["chain", "namespace", "contract", "genesis", "code", "authorizer", "block", "block-hash", "session-chain", "session-origin"])("rejects crossed %s before any projection write", async kind => {
    const f = fixture(), c = f.input.observation.config, p = f.runtime.requests.profile;
    if (kind === "chain") c.chainId = 11155111n;
    if (kind === "namespace") c.namespaceId = "other";
    if (kind === "contract") c.contract = c.authorizer;
    if (kind === "genesis") c.genesisHash = c.runtimeCodeHash;
    if (kind === "code") c.runtimeCodeHash = c.genesisHash;
    if (kind === "authorizer") c.authorizer = c.contract;
    if (kind === "block") c.deploymentBlock.number = 2n;
    if (kind === "block-hash") c.deploymentBlock.hash = c.genesisHash;
    if (kind === "session-chain") p.session_chain_id = "11155111";
    if (kind === "session-origin") p.origin = "https://staging.signatures.gallery";
    await expect(f.create()).rejects.toThrow("configuration");
    expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.server).not.toHaveBeenCalled(); expect(mocks.artwork).not.toHaveBeenCalled();
  });
  it.each(["production", "chain", "origin"])("rechecks %s immediately before listening", async kind => {
    const f = fixture(), site = await f.create();
    if (kind === "production") vi.stubEnv("NODE_ENV", "production");
    if (kind === "chain") f.runtime.requests.profile.chain_id = "11155111";
    if (kind === "origin") f.runtime.sessions.origin = "https://staging.signatures.gallery";
    await expect(site.start()).rejects.toThrow("could not start");
    expect(f.server.listen).not.toHaveBeenCalled(); expect(f.coordinator.sync).not.toHaveBeenCalled();
    expect(f.runtime.drain).toHaveBeenCalledOnce();
  });
  it("does not accept a plan/report or environment flag as public-startup authority", async () => {
    const f = fixture(); vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("ALLOW_PUBLIC_STARTUP", "true");
    f.runtime.requests.profile.chain_id = "11155111"; f.input.observation.config.chainId = 11155111n;
    Object.assign(f.input, { approved: true, runtimeAdmissionAllowed: true, observation: { ...f.input.observation,
      deploymentReport: { status: "observed-paused-not-admitted", runtimeAdmissionAllowed: true } } });
    await expect(f.create()).rejects.toThrow("configuration"); expect(mocks.open).not.toHaveBeenCalled(); expect(f.server.listen).not.toHaveBeenCalled();
  });
});
