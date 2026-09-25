import { generativeProfile, type GenerativeContractProfile } from "../generativeProfiles.js";
/** Scripted test chain; never a production provider or renderer. */
import { randomUUID } from "node:crypto";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, numberToHex, type Hex } from "viem";
import { openMintHandleKey } from "../authorization.js";
import { GENERATIVE_MINT_ABI } from "../generativeAuthorization.js";
import { prepareGenerativeInputs } from "../generativeInputs.js";
import { PUBLIC_CHAIN_READ_ABI, type PublicChainGateConfig } from "../publicChain.js";
import type { PublicChainRpc } from "../publicChainRpc.js";
import { fixturePinForProfile, fixtureRendererRuntime } from "../persistence/fixtures/eligibility.js";
import { syntheticPublicAssessment } from "./publicAssessment.js";
import { testHash as h, testAddress as a } from "./projectionRpc.js";
import type { ProjectionDeployment } from "../projection/model.js";

const abi = [...PUBLIC_CHAIN_READ_ABI, ...GENERATIVE_MINT_ABI];
export const genEncoded = (name: string, result: unknown) => encodeFunctionResult({ abi, functionName: name, result } as Parameters<typeof encodeFunctionResult>[0]);
export function generativeProjectionFixture(contractProfile: GenerativeContractProfile = "generative-experimental-v1") {
  const profile = generativeProfile(contractProfile), fixtureRendererPin = fixturePinForProfile(contractProfile);
  const inputs = prepareGenerativeInputs(syntheticPublicAssessment(), fixtureRendererPin.identity, profile.inputProfile), runtime = "0x6001", time = Math.floor(Date.now() / 1000) - 120;
  const deployment: ProjectionDeployment = { id: randomUUID(), namespaceId: randomUUID(), chainId: "31337", contractAddress: a(10),
    manifestHash: h(900), deploymentBlock: "10", deploymentBlockHash: h(10), generativeRenderer: { ...fixtureRendererPin },
    policy: { id: "test-generative-finality", rollbackBlocks: 5, snapshotRetentionBlocks: 100 } };
  const config: PublicChainGateConfig = { contractProfile, generativeRenderer: { ...fixtureRendererPin },
    namespaceId: deployment.namespaceId, deploymentId: deployment.id, chainId: 31337n, contract: a(10), authorizer: a(2),
    deploymentBlock: { number: 10n, hash: h(10) }, genesisHash: h(1000), runtimeCodeHash: keccak256(runtime),
    maxBlockAgeMs: 600000, maxFutureSkewMs: 5000, evidenceTtlMs: 30000, observationTimeoutMs: 2000 };
  const tokenId = BigInt(openMintHandleKey(inputs.canonicalHandle));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><rect width="1080" height="1080" fill="#f2eddc"/></svg>';
  const metadata = { name: `@${inputs.renderHandle} × ${inputs.mbti}`, description: profile.description,
    image: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    attributes: [{ trait_type: "Handle", value: inputs.renderHandle }, { trait_type: "MBTI", value: inputs.mbti }],
    properties: { renderer: profile.rendererVersion, input_profile: profile.inputProfile, renderer_identity: inputs.rendererIdentity, assessment_digest: inputs.assessmentDigest } };
  const tokenURI = `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString("base64")}`;
  let head = 12, finalized = 10, fork = Infinity, forkOffset = 0, transfer = false;
  const blockHash = (n: number): Hex => n === 0 ? h(1000) : h(n >= fork ? n + forkOffset : n);
  function logs(n: number) {
    const common = { address: a(10), blockNumber: numberToHex(n), blockHash: blockHash(n), transactionHash: h(n === 11 ? 200 : 201), transactionIndex: "0x0", removed: false };
    if (n >= fork) return [];
    if (n === 12 && transfer) return [{ ...common, logIndex: "0x0", data: "0x", topics: encodeEventTopics({ abi, eventName: "Transfer", args: { tokenId, from: a(1), to: a(3) } }) }];
    if (n !== 11) return [];
    const args = { tokenId, handleKey: openMintHandleKey(inputs.canonicalHandle), nonce: h(500), recipient: a(1), renderHandle: inputs.renderHandle,
      mbti: inputs.mbti, assessmentDigest: inputs.assessmentDigest, inputDigest: inputs.digest, authorizationDigest: h(501) };
    return [{ ...common, logIndex: "0x0", data: "0x", topics: encodeEventTopics({ abi, eventName: "Transfer", args: { tokenId, from: a(0), to: a(1) } }) },
      { ...common, logIndex: "0x1", topics: encodeEventTopics({ abi, eventName: "GenerativeSignatureMinted", args }),
        data: encodeAbiParameters([{ type: "uint256" }, { type: "string" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
          [tokenId, inputs.renderHandle, inputs.mbti, inputs.assessmentDigest, inputs.digest, h(501)]) }];
  }
  const header = (n: number) => ({ number: numberToHex(n), hash: blockHash(n), parentHash: n === 0 ? h(0) : blockHash(n - 1), timestamp: numberToHex(time + n), transactions: logs(n).length ? [h(n === 11 ? 200 : 201)] : [] });
  const calls: { source: number; method: string; params: readonly unknown[]; name: string; signal: AbortSignal }[] = [];
  type Mutation = (result: unknown, call: typeof calls[number]) => unknown | Promise<unknown>;
  let mutation: Mutation = r => r;
  const rpc = (source: number): PublicChainRpc => ({ id: `generative-scripted-${source}`, async request(method, params, signal) {
    const name = method === "eth_call" ? decodeFunctionData({ abi, data: (params[0] as { data: Hex }).data }).functionName : method;
    const call = { source, method, params, name, signal }; calls.push(call); let result: unknown;
    if (method === "eth_chainId") result = "0x7a69";
    else if (method === "eth_getBlockByNumber") result = header(params[0] === "latest" ? head : params[0] === "finalized" ? finalized : Number(BigInt(String(params[0]))));
    else if (method === "eth_getCode") result = params[0] === a(10) ? runtime : fixtureRendererRuntime;
    else if (method === "eth_getLogs") result = [11, 12].flatMap(n => (params[0] as { blockHash: string }).blockHash === blockHash(n) ? logs(n) : []);
    else if (method === "eth_getTransactionReceipt") {
      const n = params[0] === h(200) ? 11 : 12;
      result = { status: "0x1", transactionHash: params[0], blockHash: blockHash(n), blockNumber: numberToHex(n), transactionIndex: "0x0", logs: logs(n) };
    } else result = genEncoded(name, name === "renderer" ? fixtureRendererPin.address : name === "rendererIdentity" ? fixtureRendererPin.identity
      : name === "INPUT_PROFILE" ? profile.inputProfile : name === "eip712Domain" ? ["0x0f", profile.domainName, "1", 31337n, a(10), h(0), []]
      : name === "trustedAuthorizer" ? a(2) : name === "ownerOf" ? a(1) : name === "tokenURI" ? tokenURI : name === "inputs" ? [inputs.renderHandle, inputs.mbti]
      : name === "provenance" ? [inputs.assessmentDigest, h(501), a(1)] : false);
    return mutation(structuredClone(result), call);
  } });
  const options = { deployment, config, rpcs: [rpc(0), rpc(1)] as const, maxHeadLag: 2, maxFinalizedLag: 2, maxFinalizedAgeMs: 3600000 };
  return { options, inputs, svg, metadata, tokenURI, tokenId: tokenId.toString(), logs, header, calls,
    mutate(fn: Mutation) { mutation = fn; }, setFinalized(n: number) { finalized = n; }, setHead(n: number) { head = n; }, fork(n: number) { fork = n; forkOffset += 10000; }, transfer() { transfer = true; } };
}
