import { generativeProfile, isGenerativeProfile, type GenerativeContractProfile } from "../../generativeProfiles.js";
import { profileForRenderer } from "../../generativeInputs.js";
import { decodeFunctionData, encodeFunctionResult, keccak256, numberToHex, type Address, type Hex } from "viem";
import { PUBLIC_CHAIN_READ_ABI, PublicChainGate, type PublicChainGateConfig } from "../../publicChain.js";
import type { PublicChainRpc } from "../../publicChainRpc.js";
import { GENERATIVE_MINT_ABI } from "../../generativeAuthorization.js";
import { generativeRendererIdentity } from "../../generativeInputs.js";

export const chainHash = (byte: string): Hex => `0x${byte.repeat(32)}`;
export const fixtureRendererRuntime = "0x60016001" as Hex;
const rendererAddress = "0x3333333333333333333333333333333333333333";
export const fixtureRendererPin = Object.freeze({ address: rendererAddress, runtimeCodeHash: keccak256(fixtureRendererRuntime),
  identity: generativeRendererIdentity(rendererAddress, keccak256(fixtureRendererRuntime)) });
export function fixturePinForProfile(value: GenerativeContractProfile) {
  const p = generativeProfile(value);
  return { ...fixtureRendererPin, ...(value === "generative-experimental-v1" ? {} : { inputProfile: p.inputProfile }),
    identity: generativeRendererIdentity(rendererAddress, fixtureRendererPin.runtimeCodeHash, p.inputProfile) };
}
/** Real witness validation with two entirely mocked, read-only RPC transports. */
export function eligibilityFixture(namespaceId: string, deploymentId: string, now: () => number = Date.now) {
  const origin = "https://signatures.example", runtime = "0x60006000" as Hex;
  const config: PublicChainGateConfig = { namespaceId, deploymentId, chainId: 31337n, genesisHash: chainHash("01"),
    deploymentBlock: { number: 2n, hash: chainHash("02") }, contract: "0x1111111111111111111111111111111111111111",
    runtimeCodeHash: keccak256(runtime), authorizer: "0x2222222222222222222222222222222222222222",
    maxBlockAgeMs: 120000, maxFutureSkewMs: 5000, evidenceTtlMs: 10000, observationTimeoutMs: 1000 };
  const profile = { deployment_id: deploymentId, chain_id: "31337", contract_address: config.contract.toLowerCase(), genesis_hash: config.genesisHash,
    runtime_code_hash: config.runtimeCodeHash, authorizer: config.authorizer.toLowerCase(), deployment_block: "2", deployment_block_hash: config.deploymentBlock.hash,
    origin, session_chain_id: "31337", max_evidence_age_ms: 10000, max_block_age_ms: 120000, max_future_skew_ms: 5000 };
  const sources = (changes: Partial<PublicChainGateConfig> = {}, code: Hex = runtime, walletNonce: () => Hex = () => "0x0"): readonly [PublicChainRpc, PublicChainRpc] => {
    const pinned = { ...config, ...changes }, block = { number: 10n, hash: chainHash("10") }, timestamp = BigInt(Math.floor(now() / 1000));
    const rpc = (id: string): PublicChainRpc => ({ id, async request(method, params) {
      if (method === "eth_chainId") return numberToHex(pinned.chainId);
      if (method === "eth_getBlockByNumber") {
        const number = params[0] === "latest" ? block.number : BigInt(params[0] as string);
        return { number: numberToHex(number), hash: number === 0n ? pinned.genesisHash : number === pinned.deploymentBlock.number ? pinned.deploymentBlock.hash : block.hash, timestamp: numberToHex(timestamp) };
      }
      if (method === "eth_getCode") return params[0] === pinned.contract ? code : params[0] === pinned.generativeRenderer?.address ? fixtureRendererRuntime : "0x";
      if (method === "eth_getTransactionCount") return walletNonce();
      const abi = [...PUBLIC_CHAIN_READ_ABI, ...GENERATIVE_MINT_ABI];
      const name = decodeFunctionData({ abi, data: (params[0] as { data: Hex }).data }).functionName;
      const result = name === "renderer" ? pinned.generativeRenderer!.address : name === "rendererIdentity" ? pinned.generativeRenderer!.identity
        : name === "INPUT_PROFILE" ? profileForRenderer(pinned.generativeRenderer!).inputProfile : name === "eip712Domain" ? ["0x0f", isGenerativeProfile(pinned.contractProfile) ? generativeProfile(pinned.contractProfile).domainName : pinned.contractProfile === "onchain-v1" ? "SignaturesOnchainMint" : "SignaturesOpenMint", "1", pinned.chainId, pinned.contract, chainHash("00"), []]
        : name === "trustedAuthorizer" ? pinned.authorizer : false;
      return encodeFunctionResult({ abi, functionName: name, result } as Parameters<typeof encodeFunctionResult>[0]);
    } });
    return [rpc("mock-rpc-one"), rpc("mock-rpc-two")];
  };
  return { config, profile, sources, async witness(handle: string, recipient: Address, changes: Partial<PublicChainGateConfig> = {}, code: Hex = runtime, nonce: Hex = chainHash("33")) {
    return new PublicChainGate({ ...config, ...changes }, sources(changes, code), now).preflight({ block: { number: 10n, hash: chainHash("10") }, handle, recipient, nonce });
  } };
}
