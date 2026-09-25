import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GenerativeWalletChain, createStagingWalletChain, WalletChainUnavailableError } from "./walletChain.js";
import { eligibilityFixture, fixtureRendererPin, fixturePinForProfile } from "./persistence/fixtures/eligibility.js";
import type { PublicChainRpc } from "./publicChainRpc.js";
import { encodeFunctionResult } from "viem";
import { PUBLIC_CHAIN_READ_ABI } from "./publicChain.js";
import { GENERATIVE_MINT_ABI } from "./generativeAuthorization.js";
const wallet = `0x${"4".repeat(40)}`;
function setup(change?: (value: unknown, method: string, params: readonly unknown[], source: number) => unknown) {
  const f = eligibilityFixture(randomUUID(), randomUUID()), config = { ...f.config, contractProfile: "generative-experimental-v1" as const, generativeRenderer: fixtureRendererPin };
  const rpcs = f.sources(config).map((r, source): PublicChainRpc => ({ id: r.id, async request(method, params, signal) {
    const v = await r.request(method, params, signal); return change ? change(v, method, params, source) : v;
  } })) as unknown as readonly [PublicChainRpc, PublicChainRpc];
  return { config, rpcs, chain: new GenerativeWalletChain(config, rpcs) };
}
describe("isolated generative wallet context", () => {
  it("agrees on deployment, pinned runtime/domain/renderer, EOA and three nonce reads", async () => {
    const { chain } = setup();
    expect(await chain.read(wallet, new AbortController().signal)).toMatchObject({ chainId: "0x7a69", blockNumber: "0xa", nonce: "0x0" });
    expect(await chain.read(undefined, new AbortController().signal)).not.toHaveProperty("nonce");
  });
  it.each(["pending", "latest", "block", "sources", "code", "chain", "hash", "stale", "future", "runtime", "quantity"])("rejects %s mismatch", async kind => {
    const { chain } = setup((v, method, params, source) => {
      if (method === "eth_getTransactionCount" && ((kind === "pending" && params[1] === "pending") || (kind === "latest" && params[1] === "latest")
        || (kind === "block" && typeof params[1] === "object") || (kind === "sources" && source === 1))) return "0x1";
      if (method === "eth_getTransactionCount" && kind === "quantity") return "0x00";
      if (method === "eth_getCode" && (kind === "runtime" || (kind === "code" && params[0] === wallet))) return "0x1234";
      if (method === "eth_chainId" && kind === "chain") return "0x1";
      if (method === "eth_getBlockByNumber") {
        if (kind === "hash" && source === 1 && params[0] === "latest") return { ...v as object, hash: `0x${"a".repeat(64)}` };
        if (kind === "stale") return { ...v as object, timestamp: "0x1" };
        if (kind === "future") return { ...v as object, timestamp: `0x${(Math.floor(Date.now() / 1000) + 99999).toString(16)}` };
      }
      return v;
    });
    await expect(chain.read(wallet, new AbortController().signal)).rejects.toBeInstanceOf(WalletChainUnavailableError);
  });
  it.each(["bad", "0x" + "0".repeat(40), {}, null])("rejects invalid recipient %s", async value => {
    await expect(setup().chain.read(value, new AbortController().signal)).rejects.toBeInstanceOf(WalletChainUnavailableError);
  });
  it("bounds a stalled provider and cancellation; never retries", async () => {
    const { config, rpcs } = setup(); let calls = 0;
    const stalled: PublicChainRpc = { id: "stall", request() { calls++; return new Promise(() => {}); } };
    const chain = new GenerativeWalletChain({ ...config, observationTimeoutMs: 10 }, [rpcs[0], stalled]);
    await expect(chain.read(wallet, new AbortController().signal)).rejects.toBeInstanceOf(WalletChainUnavailableError);
    expect(calls).toBe(1);
    const abort = new AbortController(); abort.abort();
    await expect(chain.read(wallet, abort.signal)).rejects.toBeInstanceOf(WalletChainUnavailableError);
    expect(calls).toBe(1);
  });
  it.each(["renderer", "rendererIdentity", "INPUT_PROFILE", "trustedAuthorizer", "eip712Domain"])("rejects changed contract %s", async field => {
    const { config, rpcs } = setup();
    const abi = [...PUBLIC_CHAIN_READ_ABI, ...GENERATIVE_MINT_ABI];
    const { decodeFunctionData } = await import("viem");
    const changed = rpcs.map(r => ({ id: r.id, async request(method: Parameters<PublicChainRpc['request']>[0], params: readonly unknown[], signal: AbortSignal) {
      if (method === "eth_call" && decodeFunctionData({ abi, data: (params[0] as { data: `0x${string}` }).data }).functionName === field) {
        return encodeFunctionResult({ abi, functionName: field, result: field === "renderer" || field === "trustedAuthorizer" ? wallet
          : field === "rendererIdentity" ? `0x${"f".repeat(64)}` : field === "INPUT_PROFILE" ? "wrong-profile"
          : ["0x0f", "wrong-domain", "1", 31337n, config.contract, `0x${"0".repeat(64)}`, []] } as Parameters<typeof encodeFunctionResult>[0]);
      }
      return r.request(method, params, signal);
    } })) as unknown as readonly [PublicChainRpc, PublicChainRpc];
    await expect(new GenerativeWalletChain(config, changed).read(wallet, new AbortController().signal)).rejects.toBeInstanceOf(WalletChainUnavailableError);
  });
  it("withdraws on a head change during reads", async () => {
    let latest = 0;
    const { chain } = setup((v, method, params) => method === "eth_getBlockByNumber" && params[0] === "latest" && ++latest > 2
      ? { ...v as object, hash: `0x${"e".repeat(64)}` } : v);
    await expect(chain.read(wallet, new AbortController().signal)).rejects.toBeInstanceOf(WalletChainUnavailableError);
  });
  it("refuses public chain/profile and captures configuration", () => {
    const { config, rpcs, chain } = setup(); config.contractProfile = "external-v1" as never;
    expect(chain.config.contractProfile).toBe("generative-experimental-v1");
    expect(() => new GenerativeWalletChain(config, rpcs)).toThrow();
    expect(() => new GenerativeWalletChain({ ...config, chainId: 1n }, rpcs)).toThrow();
  });
});

describe("separate Sepolia RC1 read-only wallet context", () => {
  function fixture() {
    const f = eligibilityFixture(randomUUID(), randomUUID());
    const config = { ...f.config, chainId: 11155111n, contractProfile: "generative-v1-rc1" as const, generativeRenderer: fixturePinForProfile("generative-v1-rc1") };
    return { f, config, sources: f.sources(config) };
  }
  it("returns exact server-observed Sepolia nonce, without widening ordinary construction", async () => {
    const { config, sources } = fixture();
    expect(() => new GenerativeWalletChain(config, sources)).toThrow();
    expect(() => new GenerativeWalletChain(config, sources, Symbol("forged"))).toThrow();
    const reader = createStagingWalletChain(config, sources);
    expect(Object.keys(reader)).toEqual(["read"]);
    expect(await reader.read(wallet, new AbortController().signal)).toMatchObject({ chainId: "0xaa36a7", nonce: "0x0" });
  });
  it.each(["anvil", "mainnet", "experimental", "external", "duplicate", "pin"])("refuses %s configuration", kind => {
    const { config, sources } = fixture();
    if (kind === "anvil") config.chainId = 31337n;
    if (kind === "mainnet") config.chainId = 1n;
    if (kind === "experimental") config.contractProfile = "generative-experimental-v1" as never;
    if (kind === "external") config.contractProfile = "external-v1" as never;
    if (kind === "pin") config.generativeRenderer.identity = `0x${"a".repeat(64)}`;
    expect(() => createStagingWalletChain(config, kind === "duplicate" ? [sources[0], sources[0]] : sources)).toThrow();
  });
  it.each(["pending", "source", "code", "stale", "head", "chain"])("refuses %s disagreement without a fallback nonce", async kind => {
    const { config, sources } = fixture(); let latest = 0;
    const changed = sources.map((source, i) => ({ id: source.id, async request(method, params, signal) {
      const value = await source.request(method, params, signal);
      if (method === "eth_getTransactionCount" && ((kind === "pending" && params[1] === "pending") || (kind === "source" && i === 1))) return "0x1";
      if (kind === "code" && method === "eth_getCode" && params[0] === wallet) return "0x1234";
      if (kind === "chain" && method === "eth_chainId") return "0x1";
      if (kind === "stale" && method === "eth_getBlockByNumber") return { ...value as object, timestamp: "0x1" };
      if (kind === "head" && method === "eth_getBlockByNumber" && params[0] === "latest" && ++latest > 2) return { ...value as object, hash: `0x${"e".repeat(64)}` };
      return value;
    } } as PublicChainRpc)) as unknown as readonly [PublicChainRpc, PublicChainRpc];
    await expect(createStagingWalletChain(config, changed).read(wallet, new AbortController().signal)).rejects.toThrow();
  });
});
