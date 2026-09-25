import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, numberToHex, type Hex } from "viem";
import { syntheticPublicAssessment } from "./fixtures/publicAssessment.js";
import { prepareOnchainArtifact } from "./onchainArtifact.js";
import { ONCHAIN_MINT_ABI } from "./onchainAuthorization.js";
import { PUBLIC_CHAIN_READ_ABI, type PublicChainGateConfig } from "./publicChain.js";
import type { PublicChainRpc } from "./publicChainRpc.js";
import { createOnchainArtworkReader } from "./onchainReads.js";
import { decodeOpenSignaturesBlock, OPEN_PROJECTION_EVENTS } from "./projection/decode.js";
import { createOnchainProjectionObserver } from "./projection/onchainObserver.js";
import { openMintHandleKey } from "./authorization.js";

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const a = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const artifact = prepareOnchainArtifact(syntheticPublicAssessment());
const block = { number: 10n, hash: h(10) }, runtime = "0x6000";
const abi = [...ONCHAIN_MINT_ABI, ...PUBLIC_CHAIN_READ_ABI] as const;
function fixture() {
  const calls: { source: number; method: string; params: readonly unknown[]; signal: AbortSignal }[] = [];
  const config: PublicChainGateConfig = { contractProfile: "onchain-v1", namespaceId: "22222222-2222-4222-8222-222222222222",
    deploymentId: "11111111-1111-4111-8111-111111111111", chainId: 31337n, genesisHash: h(1), deploymentBlock: { number: 2n, hash: h(2) },
    contract: a(10), runtimeCodeHash: keccak256(runtime), authorizer: a(99), maxBlockAgeMs: 120000,
    maxFutureSkewMs: 5000, evidenceTtlMs: 10000, observationTimeoutMs: 1000 };
  const overrides: ((call: typeof calls[number], name: string, value: unknown) => unknown)[] = [];
  const rpcs = [0, 1].map(source => ({ id: `rpc-${source}`, async request(method, params, signal) {
    const call = { source, method, params, signal }; calls.push(call);
    let result: unknown;
    let name: string = method;
    if (method === "eth_chainId") result = "0x7a69";
    else if (method === "eth_getCode") result = runtime;
    else if (method === "eth_getBlockByNumber") {
      const number = BigInt(params[0] as string); result = { number: numberToHex(number), hash: number === 0n ? h(1) : h(Number(number)) };
    } else {
      const decoded = decodeFunctionData({ abi, data: (params[0] as { data: Hex }).data }); name = decoded.functionName;
      const value = name === "tokenURI" ? artifact.tokenURI : name === "svg" ? artifact.artwork.svg
        : name === "artwork" ? [a(20), artifact.artwork.renderHandle, artifact.artwork.mbti]
        : name === "eip712Domain" ? ["0x0f", "SignaturesOnchainMint", "1", 31337n, a(10), h(0), []]
        : [artifact.canonicalHandle, artifact.assessmentDigest, artifact.digest, a(3), artifact.tokenURIHash, h(50)];
      result = encodeFunctionResult({ abi, functionName: name, result: value } as never);
    }
    for (const override of overrides) result = await override(call, name, result);
    return result;
  } } satisfies PublicChainRpc)) as unknown as readonly [PublicChainRpc, PublicChainRpc];
  return { config, calls, rpcs, overrides, read: createOnchainArtworkReader({ config, rpcs }) };
}
afterEach(() => vi.restoreAllMocks());
describe("chain-only artwork recovery", () => {
  it("recovers case, MBTI, SVG and metadata without a journal, renderer or website", async () => {
    const f = fixture(), result = await f.read(artifact.canonicalHandle, block, new AbortController().signal);
    expect(result).toEqual({ kind: "onchain-v1", artifact, authorizationDigest: h(50), recipient: a(3) });
    expect(Object.isFrozen(result)).toBe(true);
    for (const call of f.calls) if (call.method === "eth_call" || call.method === "eth_getCode") expect(call.params[1]).toEqual({ blockHash: h(10), requireCanonical: true });
    expect(f.calls.every(call => call.signal.aborted)).toBe(true);
  });
  it("requires explicit on-chain profile and independent RPC identities", () => {
    const f = fixture(); expect(() => createOnchainArtworkReader({ ...f, config: { ...f.config, contractProfile: undefined } })).toThrow();
    expect(() => createOnchainArtworkReader({ ...f, rpcs: [f.rpcs[0], f.rpcs[0]] })).toThrow();
  });
  it.each([
    ["eth_chainId", "0x1"], ["eth_getCode", "0x6001"], ["eth_getCode", "invalid"],
    ["eth_getBlockByNumber", null], ["eth_getBlockByNumber", { number: "0xa", hash: h(99) }],
    ["tokenURI", "0x"], ["svg", "0xzz"], ["artwork", "0x"], ["provenance", "0x"], ["eip712Domain", "0x"],
    ["eip712Domain", `0x${"00".repeat(2050)}`], ["svg", `0x${"00".repeat(65538)}`],
  ])("fails closed on mismatched or malformed %s", async (name, value) => {
    const f = fixture(); f.overrides.push((call, n, result) => call.source === 1 && n === name ? value : result);
    await expect(f.read(artifact.canonicalHandle, block, new AbortController().signal)).rejects.toThrow("could not be verified");
  });
  it.each([
    ["tokenURI", "https://mutable.example/art.json"], ["svg", "<svg/>"],
    ["svg", "x".repeat(16385)], ["tokenURI", "x".repeat(40001)],
    ["artwork", [a(20), "Bob", "INTJ"]], ["artwork", [a(20), "Alice_Bob_Key", "NOPE"]],
    ["provenance", [artifact.canonicalHandle, artifact.assessmentDigest, h(99), a(3), artifact.tokenURIHash, h(50)]],
    ["provenance", [artifact.canonicalHandle, artifact.assessmentDigest, artifact.digest, a(0), artifact.tokenURIHash, h(50)]],
    ["provenance", [artifact.canonicalHandle, artifact.assessmentDigest, artifact.digest, a(3), artifact.tokenURIHash, h(0)]],
    ["eip712Domain", ["0x0f", "SignaturesOpenMint", "1", 31337n, a(10), h(0), []]],
  ])("rejects decoded but inconsistent %s", async (name, value) => {
    const f = fixture(); f.overrides.push((call, n, result) => call.source === 1 && n === name
      ? encodeFunctionResult({ abi, functionName: name, result: value } as never) : result);
    await expect(f.read(artifact.canonicalHandle, block, new AbortController().signal)).rejects.toThrow();
  });
  it("rejects source disagreement on otherwise valid immutable provenance", async () => {
    const f = fixture(); f.overrides.push((call, name, result) => call.source === 1 && name === "provenance"
      ? encodeFunctionResult({ abi, functionName: "provenance", result: [artifact.canonicalHandle, artifact.assessmentDigest, artifact.digest, a(3), artifact.tokenURIHash, h(51)] }) : result);
    await expect(f.read(artifact.canonicalHandle, block, new AbortController().signal)).rejects.toThrow();
  });
  it("aborts hung reads, hides RPC secrets and does not accept a late response", async () => {
    const f = fixture(); f.config.observationTimeoutMs = 5;
    const read = createOnchainArtworkReader(f); f.overrides.push(() => new Promise(() => {}));
    await expect(read(artifact.canonicalHandle, block, new AbortController().signal)).rejects.toThrow("could not be verified");
    expect(f.calls.every(c => c.signal.aborted)).toBe(true);
    const g = fixture(); g.overrides.push(() => { throw new Error("https://secret-key-in-rpc.example"); });
    await expect(g.read(artifact.canonicalHandle, block, new AbortController().signal)).rejects.toThrow(/^On-chain artwork could not be verified at the requested block\.$/);
  });
  it("checks cancellation, elapsed time and explicit block bounds", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.read(artifact.canonicalHandle, block, controller.signal)).rejects.toThrow(); expect(f.calls).toHaveLength(0);
    await expect(f.read(artifact.canonicalHandle, { number: 1n, hash: h(1) }, new AbortController().signal)).rejects.toThrow();
    await expect(f.read(artifact.canonicalHandle, { number: 2n ** 63n, hash: h(1) }, new AbortController().signal)).rejects.toThrow();
    let time = 0; vi.spyOn(performance, "now").mockImplementation(() => time);
    f.overrides.push((_c, _n, result) => { time = 1001; return result; });
    await expect(f.read(artifact.canonicalHandle, block, new AbortController().signal)).rejects.toThrow();
  });
  it("rejects chain changes between the start and end of a read", async () => {
    const f = fixture(); let headers = 0;
    f.overrides.push((call, name, result) => call.source === 0 && name === "eth_getBlockByNumber" && call.params[0] === "0xa" && ++headers === 2
      ? { number: "0xa", hash: h(11) } : result);
    await expect(f.read(artifact.canonicalHandle, block, new AbortController().signal)).rejects.toThrow();
  });
});

describe("on-chain projection enrichment", () => {
  const deployment = { id: "11111111-1111-4111-8111-111111111111", namespaceId: "22222222-2222-4222-8222-222222222222",
    chainId: "31337", contractAddress: a(10), manifestHash: h(10), deploymentBlock: "2", deploymentBlockHash: h(2),
    policy: { id: "offline-policy", rollbackBlocks: 5, snapshotRetentionBlocks: 10 } };
  function log() {
    const key = openMintHandleKey(artifact.canonicalHandle);
    return { address: a(10), blockNumber: "0xa", blockHash: h(10), transactionHash: h(20), transactionIndex: "0x0", logIndex: "0x1", removed: false,
      topics: encodeEventTopics({ abi: OPEN_PROJECTION_EVENTS, eventName: "OpenSignatureMinted", args: { handleKey: key, nonce: h(30), recipient: a(3) } }),
      data: encodeAbiParameters([{ type: "uint256" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [BigInt(key), artifact.canonicalHandle, artifact.assessmentDigest, artifact.digest, artifact.tokenURIHash, h(50)]) };
  }
  const input = () => ({ contractProfile: "onchain-v1" as const, deployment, authorizer: a(99), block: { number: "10", hash: h(10), parentHash: h(9), timestamp: "1200" },
    logs: [log()], timeoutMs: 1000, signal: new AbortController().signal,
    resolveMint: vi.fn(async () => ({ kind: "onchain-v1" as const, artifact, authorizationDigest: h(50), recipient: a(3) })) });
  it("enriches MBTI from verified chain bytes without private historical assessment data", async () => {
    const i = input(), result = await decodeOpenSignaturesBlock(i);
    expect(result.block.events[0]).toMatchObject({ mbti: "INTJ", evidenceReference: `onchain:${h(20)}` });
    expect(result.chainAuthenticated).toBe(false); // observer, not decoder, proves this
    expect(i.resolveMint.mock.calls[0]).toHaveLength(3);
  });
  it("refuses on-chain evidence under the external profile and vice versa", async () => {
    await expect(decodeOpenSignaturesBlock({ ...input(), contractProfile: "external-v1" })).rejects.toThrow();
    const i = input(); i.resolveMint.mockResolvedValue({ artifact } as never);
    await expect(decodeOpenSignaturesBlock(i)).rejects.toThrow();
    await expect(decodeOpenSignaturesBlock({ ...input(), contractProfile: "other" as never })).rejects.toThrow();
  });
  it("checks exact event/chain artwork binding", async () => {
    const i = input(); i.resolveMint.mockResolvedValue({ kind: "onchain-v1", artifact, authorizationDigest: h(51), recipient: a(3) });
    await expect(decodeOpenSignaturesBlock(i)).rejects.toThrow();
  });
  it("constructs a chain-only observer and rejects an unselected profile", () => {
    const f = fixture(), options = { ...f, deployment, maxHeadLag: 2, maxFinalizedLag: 2, maxFinalizedAgeMs: 120000 };
    expect(typeof createOnchainProjectionObserver(options)).toBe("function");
    expect(() => createOnchainProjectionObserver({ ...options, config: { ...f.config, contractProfile: undefined } })).toThrow();
  });
});
