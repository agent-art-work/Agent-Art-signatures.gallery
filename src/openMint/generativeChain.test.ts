import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, keccak256, numberToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { openMintHandleKey } from "./authorization.js";
import { generativeMintDigest, generativeMintTypedData, GENERATIVE_DOMAIN_NAME, GENERATIVE_MINT_ABI } from "./generativeAuthorization.js";
import { GENERATIVE_INPUT_PROFILE, GENERATIVE_RENDERER_VERSION, prepareGenerativeInputs } from "./generativeInputs.js";
import { createGenerativeArtworkReader } from "./generativeReads.js";
import { fixtureRendererPin, fixtureRendererRuntime, chainHash } from "./persistence/fixtures/eligibility.js";
import { syntheticPublicAssessment } from "./fixtures/publicAssessment.js";
import { PublicChainGate, PUBLIC_CHAIN_READ_ABI, readPublicChainEligibility, type PublicChainGateConfig } from "./publicChain.js";
import type { PublicChainRpc } from "./publicChainRpc.js";

const signer = privateKeyToAccount(`0x${"1".padStart(64, "0")}`), contract = "0x1111111111111111111111111111111111111111";
const block = { number: 10n, hash: chainHash("10") }, now = 1800000060000;
const inputs = prepareGenerativeInputs(syntheticPublicAssessment(), fixtureRendererPin.identity), runtime = "0x60006000" as Hex;
const authorization = { handleKey: openMintHandleKey(inputs.canonicalHandle), assessmentDigest: inputs.assessmentDigest,
  inputDigest: inputs.digest, recipient: signer.address, nonce: chainHash("44"), issuedAt: 1800000000n, deadline: 1800000900n };
const domain = { chainId: 31337, verifyingContract: contract };
const abi = [...PUBLIC_CHAIN_READ_ABI, ...GENERATIVE_MINT_ABI];
const encoded = (name: string, result: unknown) => encodeFunctionResult({ abi, functionName: name, result } as Parameters<typeof encodeFunctionResult>[0]);
const image = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
const metadata = { name: "@Alice_Bob_Key × INTJ", description: "Experimental local generative signature. Not a production token.", image,
  attributes: [{ trait_type: "Handle", value: "Alice_Bob_Key" }, { trait_type: "MBTI", value: "INTJ" }],
  properties: { renderer: GENERATIVE_RENDERER_VERSION, input_profile: GENERATIVE_INPUT_PROFILE, renderer_identity: fixtureRendererPin.identity, assessment_digest: inputs.assessmentDigest } };
const uri = (value: unknown) => "data:application/json;base64," + Buffer.from(JSON.stringify(value)).toString("base64");
function fixture() {
  const config: PublicChainGateConfig = { contractProfile: "generative-experimental-v1", generativeRenderer: { ...fixtureRendererPin },
    namespaceId: "ns", deploymentId: "deployment", chainId: 31337n, contract, genesisHash: chainHash("01"), runtimeCodeHash: keccak256(runtime),
    deploymentBlock: { number: 2n, hash: chainHash("02") }, authorizer: signer.address,
    maxBlockAgeMs: 120000, maxFutureSkewMs: 5000, evidenceTtlMs: 10000, observationTimeoutMs: 1000 };
  const observations: { method: string; params: readonly unknown[]; name?: string }[] = [];
  const overrides: ((name: string, result: unknown, source: number) => unknown)[] = [];
  const rpc = (source: number): PublicChainRpc => ({ id: `mock-${source}`, async request(method, params) {
    const name = method === "eth_call" ? decodeFunctionData({ abi, data: (params[0] as { data: Hex }).data }).functionName : method;
    observations.push({ method, params, name });
    let result: unknown;
    if (method === "eth_chainId") result = "0x7a69";
    else if (method === "eth_getBlockByNumber") result = { number: params[0], hash: params[0] === "0x0" ? config.genesisHash : params[0] === "0x2" ? config.deploymentBlock.hash : block.hash, timestamp: numberToHex(1800000060n) };
    else if (method === "eth_getCode") result = params[0] === contract ? runtime : params[0] === fixtureRendererPin.address ? fixtureRendererRuntime : "0x";
    else result = encoded(name, name === "renderer" ? fixtureRendererPin.address : name === "rendererIdentity" ? fixtureRendererPin.identity
      : name === "INPUT_PROFILE" ? GENERATIVE_INPUT_PROFILE : name === "eip712Domain" ? ["0x0f", GENERATIVE_DOMAIN_NAME, "1", 31337n, contract, chainHash("00"), []]
      : name === "trustedAuthorizer" || name === "ownerOf" ? signer.address : name === "authorizationDigest" ? generativeMintDigest(domain, authorization)
      : name === "tokenURI" ? uri(metadata) : name === "inputs" ? [inputs.renderHandle, inputs.mbti]
      : name === "provenance" ? [inputs.assessmentDigest, generativeMintDigest(domain, authorization), signer.address] : false);
    for (const override of overrides) result = await override(name, result, source);
    return result;
  } });
  const rpcs = [rpc(0), rpc(1)] as const;
  return { config, rpcs, overrides, observations, gate: () => new PublicChainGate(config, rpcs, () => now),
    reader: () => createGenerativeArtworkReader({ config, rpcs }),
    intent: () => ({ block, handle: inputs.canonicalHandle, recipient: signer.address, nonce: authorization.nonce }) };
}

describe("generative chain authority and recovery (mocked RPCs)", () => {
  it("verifies input typed data against the on-chain digest and pins the renderer on both sources", async () => {
    const f = fixture(), signature = await signer.signTypedData(generativeMintTypedData(domain, authorization));
    const result = await f.gate().verifyGenerativeAuthorization({ block, inputs, authorization, signature });
    expect(result.authorizationDigest).toBe(generativeMintDigest(domain, authorization));
    const evidence = readPublicChainEligibility(result.eligibility, { ...f.intent(), namespaceId: "ns", deploymentId: "deployment", now });
    expect(evidence.generativeRenderer).toEqual(fixtureRendererPin); expect(Object.isFrozen(evidence.generativeRenderer)).toBe(true);
    expect(f.observations.filter(o => o.name === "renderer")).toHaveLength(2);
    for (const o of f.observations.filter(o => ["eth_getCode", "eth_call"].includes(o.method))) expect(o.params[1]).toEqual({ blockHash: block.hash, requireCanonical: true });
    await expect(f.gate().verifyAuthorization({} as never)).rejects.toThrow("Output-based");
    await expect(f.gate().verifyGenerativeAuthorization({ block, inputs: { ...inputs, assessmentDigest: chainHash("ff") }, authorization, signature })).rejects.toThrow("commitment");
    await expect(f.gate().verifyGenerativeAuthorization({ block, inputs, authorization, signature: "0x" })).rejects.toThrow("signature");
  });
  it.each(["renderer", "rendererIdentity", "INPUT_PROFILE", "authorizationDigest", "eth_getCode", "eth_chainId"])("rejects mismatched %s from either source", async name => {
    for (const source of [0, 1]) {
      const f = fixture(), signature = await signer.signTypedData(generativeMintTypedData(domain, authorization));
      f.overrides.push((n, result, s) => n !== name || s !== source ? result : name === "eth_getCode" ? "0x" : name === "eth_chainId" ? "0x1"
        : encoded(name, name === "renderer" ? contract : name === "INPUT_PROFILE" ? "wrong" : chainHash("ff")));
      await expect(f.gate().verifyGenerativeAuthorization({ block, inputs, authorization, signature })).rejects.toThrow();
      if (name !== "authorizationDigest") await expect(f.reader()(inputs.canonicalHandle, block, new AbortController().signal)).rejects.toThrow();
    }
  });
  it("refuses implicit, invalid or public-chain renderer configuration", async () => {
    const f = fixture();
    for (const patch of [{ chainId: 11155111n }, { generativeRenderer: undefined }, { contractProfile: "external-v1" as const },
      { generativeRenderer: { ...fixtureRendererPin, identity: chainHash("ff") } }]) {
      expect(() => new PublicChainGate({ ...f.config, ...patch }, f.rpcs)).toThrow();
    }
    const old = new PublicChainGate({ ...f.config, contractProfile: "external-v1", generativeRenderer: undefined }, f.rpcs);
    await expect(old.verifyGenerativeAuthorization({} as never)).rejects.toThrow("generative deployment");
    expect(() => createGenerativeArtworkReader({ config: { ...f.config, contractProfile: "external-v1" }, rpcs: f.rpcs })).toThrow();
  });
  it("recovers only from pinned chain data; one bounded render per source", async () => {
    const f = fixture(), saved = await f.reader()(inputs.canonicalHandle, block, new AbortController().signal);
    expect(saved.inputs).toEqual(inputs); expect(saved.svg).toBe(Buffer.from(image.split(",")[1], "base64").toString());
    expect(saved.tokenURI).toBe(uri(metadata)); expect(saved.owner).toBe(signer.address.toLowerCase());
    expect(f.observations.filter(o => o.name === "tokenURI")).toHaveLength(2);
    expect(f.observations.filter(o => o.name === "svg")).toHaveLength(0);
    for (const o of f.observations.filter(o => o.name === "tokenURI")) expect(o.params[0]).toMatchObject({ gas: numberToHex(30000000n) });
    for (const o of f.observations.filter(o => o.method === "eth_call" && o.name !== "tokenURI"))
      expect(o.params[0]).toMatchObject({ gas: numberToHex(2000000n) });
  });
  it.each(["tokenURI", "inputs", "provenance", "eip712Domain"])("rejects noncanonical %s encoding from either source", async field => {
    for (const source of [0, 1]) {
      const f = fixture(); f.overrides.push((name, result, s) => name === field && s === source ? result + "00".repeat(32) : result);
      await expect(f.reader()(inputs.canonicalHandle, block, new AbortController().signal)).rejects.toThrow("could not be verified");
    }
  });
  it.each(["name", "image", "attributes", "properties", "extra"])("rejects changed metadata %s", async field => {
    const f = fixture(); f.overrides.push((name, result) => name === "tokenURI" ? encoded(name, uri({ ...metadata, [field]: "changed" })) : result);
    await expect(f.reader()(inputs.canonicalHandle, block, new AbortController().signal)).rejects.toThrow();
  });
  it.each(["ipfs://changed", "data:application/json;base64,e30=", "data:application/json;base64,!!!!", "data:application/json;base64," + "a".repeat(80000)])("rejects malformed or external token URI", async value => {
    const f = fixture(); f.overrides.push((name, result) => name === "tokenURI" ? encoded(name, value) : result);
    await expect(f.reader()(inputs.canonicalHandle, block, new AbortController().signal)).rejects.toThrow();
  });
  it("rejects inconsistent provenance/inputs, owner disagreement and reorgs", async () => {
    for (const [field, value] of [["inputs", ["Alice", "INTJ"]], ["inputs", ["Alice_Bob_Key", "ENFP"]],
      ["provenance", [chainHash("ff"), generativeMintDigest(domain, authorization), signer.address]], ["ownerOf", contract]] as const) {
      const f = fixture(); f.overrides.push((name, result, source) => name === field && source === 1 ? encoded(name, value) : result);
      await expect(f.reader()(inputs.canonicalHandle, block, new AbortController().signal)).rejects.toThrow();
    }
    const f = fixture(); let reads = 0;
    f.overrides.push((name, result) => name === "eth_getBlockByNumber" && ++reads > 6 ? { ...result as object, hash: chainHash("ff") } : result);
    await expect(f.reader()(inputs.canonicalHandle, block, new AbortController().signal)).rejects.toThrow();
  });
  it("bounds cancellation, stalled RPCs and untrusted errors", async () => {
    const f = fixture(), c = new AbortController(); c.abort();
    await expect(f.reader()(inputs.canonicalHandle, block, c.signal)).rejects.toThrow();
    expect(f.observations).toHaveLength(0);
    f.config.observationTimeoutMs = 5; f.overrides.push(() => new Promise(() => {}));
    await expect(f.reader()(inputs.canonicalHandle, block, new AbortController().signal)).rejects.toThrow("could not be verified");
    f.overrides.splice(0); f.overrides.push(() => { throw new Error("credential-bearing-rpc-url"); });
    await expect(f.reader()(inputs.canonicalHandle, block, new AbortController().signal)).rejects.toThrow(/^Generative artwork could not be verified/);
  });
});
