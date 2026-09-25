/** Test-only scripted RPCs. Never imported by startup or public adapters. */
import { randomUUID } from "node:crypto";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, keccak256, numberToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { openMintDigest, openMintHandleKey, openMintTokenURIHash, openMintTypedData } from "../authorization.js";
import { PUBLIC_CHAIN_READ_ABI, type PublicChainGateConfig } from "../publicChain.js";
import type { PublicChainReadMethod } from "../publicChainRpc.js";
import { preparePublicArtifact } from "../publicArtifacts.js";
import { OPEN_PROJECTION_EVENTS, type MintProjectionEvidence } from "../projection/decode.js";
import type { createProjectionObserver } from "../projection/observer.js";
import { syntheticPublicAssessment } from "./publicAssessment.js";

export const testHash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
export const testAddress = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
// Widely published Anvil test key, not a user's key.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
let artifactPromise: ReturnType<typeof preparePublicArtifact> | undefined;
export async function projectionRpcFixture(provided?: { evidence: MintProjectionEvidence; config: PublicChainGateConfig; runtime: Hex }) {
  const artifact = provided?.evidence.artifact ?? await (artifactPromise ??= preparePublicArtifact({ assessment: syntheticPublicAssessment(), origin: "https://gallery.example" }));
  const time = provided ? Number(provided.evidence.reservation.authorization.issuedAt) - 11 : Math.floor(Date.now() / 1000) - 120;
  const deployment = { id: provided?.config.deploymentId ?? randomUUID(), namespaceId: provided?.config.namespaceId ?? randomUUID(),
    chainId: String(provided?.config.chainId ?? 31337), contractAddress: (provided?.config.contract ?? testAddress(10)).toLowerCase(), manifestHash: testHash(900),
    deploymentBlock: String(provided?.config.deploymentBlock.number ?? 10), deploymentBlockHash: provided?.config.deploymentBlock.hash ?? testHash(10),
    policy: { id: "test-finalized", rollbackBlocks: 5, snapshotRetentionBlocks: 100 } };
  const domain = provided?.evidence.reservation.domain ?? { chainId: deployment.chainId, verifyingContract: testAddress(10) };
  const authorization = provided?.evidence.reservation.authorization ?? { handleKey: openMintHandleKey(artifact.assessment.handle), assessmentDigest: artifact.assessment.digest, artifactDigest: artifact.digest,
    recipient: testAddress(1), tokenURIHash: openMintTokenURIHash(artifact.metadata.object.uri), nonce: testHash(500), issuedAt: String(time), deadline: String(time + 900) };
  const typedData = openMintTypedData(domain, authorization);
  const evidence: MintProjectionEvidence = provided?.evidence ?? { artifact, signature: await account.signTypedData(typedData), reservation: {
    version: "sg-open-authorization-1", id: randomUUID(), namespaceId: deployment.namespaceId, deploymentId: deployment.id,
    requestId: randomUUID(), sessionHash: "a".repeat(64), generation: "1", handle: artifact.assessment.handle, assessmentId: artifact.assessment.id,
    tokenURI: artifact.metadata.object.uri, authorizer: account.address, domain, authorization, digest: openMintDigest(domain, authorization),
    typedData: JSON.parse(JSON.stringify(typedData, (_k, v) => typeof v === "bigint" ? v.toString() : v)),
  } };
  let head = 12, finalized = 9;
  const forks = new Map<number, number>();
  const blockHash = (n: number) => n === 0 ? provided?.config.genesisHash ?? testHash(1000)
    : n === Number(deployment.deploymentBlock) ? deployment.deploymentBlockHash : testHash(n + (forks.get(n) ?? 0));
  const logs = (n: number) => {
    if (n !== 11 || forks.has(n)) return [];
    const common = { address: deployment.contractAddress, blockNumber: numberToHex(n), blockHash: blockHash(n),
      transactionHash: testHash(200), transactionIndex: "0x0", removed: false };
    const args = { ...authorization, recipient: getAddress(authorization.recipient), tokenId: BigInt(authorization.handleKey), normalizedHandle: artifact.assessment.handle, authorizationDigest: evidence.reservation.digest };
    return [
      { ...common, logIndex: "0x0", data: "0x", topics: encodeEventTopics({ abi: OPEN_PROJECTION_EVENTS, eventName: "Transfer", args: { from: testAddress(0), to: args.recipient, tokenId: args.tokenId } }) },
      { ...common, logIndex: "0x1", topics: encodeEventTopics({ abi: OPEN_PROJECTION_EVENTS, eventName: "OpenSignatureMinted", args }),
        data: encodeAbiParameters([{ type: "uint256" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
          [args.tokenId, args.normalizedHandle, args.assessmentDigest, args.artifactDigest, args.tokenURIHash, args.authorizationDigest]) },
    ];
  };
  const header = (n: number) => ({ number: numberToHex(n), hash: blockHash(n), parentHash: n === 0 ? testHash(0) : blockHash(n - 1), timestamp: numberToHex(time + n), transactions: logs(n).length ? [testHash(200)] : [] });
  const calls: { source: number; method: PublicChainReadMethod; params: readonly unknown[]; signal: AbortSignal }[] = [];
  type Mutation = (result: unknown, call: typeof calls[number]) => unknown | Promise<unknown>;
  let mutate: Mutation = r => r;
  const rpcs = [0, 1].map(source => ({ id: `scripted-${source}`, async request(method: PublicChainReadMethod, params: readonly unknown[], signal: AbortSignal) {
    const call = { source, method, params, signal }; calls.push(call); let result: unknown;
    if (method === "eth_chainId") result = numberToHex(BigInt(deployment.chainId));
    else if (method === "eth_getBlockByNumber") result = header(params[0] === "latest" ? head : params[0] === "finalized" ? finalized : Number(BigInt(String(params[0]))));
    else if (method === "eth_getCode") result = provided?.runtime ?? "0x6001";
    else if (method === "eth_call") {
      const name = decodeFunctionData({ abi: PUBLIC_CHAIN_READ_ABI, data: (params[0] as { data: Hex }).data }).functionName;
      result = name === "trustedAuthorizer" ? encodeFunctionResult({ abi: PUBLIC_CHAIN_READ_ABI, functionName: name, result: evidence.reservation.authorizer })
        : encodeFunctionResult({ abi: PUBLIC_CHAIN_READ_ABI, functionName: "eip712Domain", result: ["0x0f", "SignaturesOpenMint", "1", BigInt(deployment.chainId), domain.verifyingContract, testHash(0), []] });
    } else if (method === "eth_getLogs") {
      const block = (params[0] as { blockHash: string }).blockHash;
      result = block === blockHash(11) ? logs(11) : [];
    } else if (method === "eth_getTransactionReceipt") result = { status: "0x1", transactionHash: testHash(200), blockHash: blockHash(11), blockNumber: "0xb", transactionIndex: "0x0", logs: logs(11) };
    else throw new Error("Unexpected RPC method.");
    return mutate(structuredClone(result), call);
  } })) as unknown as Parameters<typeof createProjectionObserver>[0]["rpcs"];
  const options: Parameters<typeof createProjectionObserver>[0] & { resolveMint: NonNullable<Parameters<typeof createProjectionObserver>[0]["resolveMint"]> } = { deployment, config: { namespaceId: deployment.namespaceId, deploymentId: deployment.id,
    chainId: 31337n, genesisHash: blockHash(0), deploymentBlock: { number: 10n, hash: blockHash(10) }, contract: testAddress(10),
    runtimeCodeHash: keccak256("0x6001"), authorizer: account.address, maxBlockAgeMs: 600_000, maxFutureSkewMs: 1000, evidenceTtlMs: 30_000, observationTimeoutMs: 5000,
    ...provided?.config },
    rpcs, maxHeadLag: 2, maxFinalizedLag: 2, maxFinalizedAgeMs: 3_600_000, resolveMint: async () => structuredClone(evidence) };
  return { options, evidence, calls, logs, header, blockHash,
    mutate(fn: Mutation) { mutate = fn; }, setHead(n: number) { head = n; }, setFinalized(n: number) { finalized = n; },
    fork(from: number) { for (let n = from; n <= head; n++) forks.set(n, 10000); },
  };
}
