import { performance } from "node:perf_hooks";
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from "viem";
import { OPEN_MINT_ABI, normalizeOpenMintAuthorization, openMintDigest, openMintHandleKey, openMintTokenURIHash, verifyOpenMintAuthorization } from "../authorization.js";
import { PUBLIC_ARTIFACT_MAX_BYTES, verifyPreparedPublicArtifact, type PreparedPublicArtifact } from "../publicArtifacts.js";
import type { AuthorizationReservation } from "../persistence/authorizations.js";
import type { OnchainMintEvidence } from "../onchainReads.js";
import { encodeOnchainArtifact } from "../onchainArtifact.js";
import { address, hash, MAX_BLOCK_EVENTS, quantity, validateBatch, validateDeployment, type ProjectionDeployment, type ValidatedBlock, type ValidatedEvent, type ValidatedMint, type ValidatedTransfer } from "./model.js";

// Share the contract-facing ABI; an independently copied event definition can
// silently diverge when contract interfaces change.
export const OPEN_PROJECTION_EVENTS = OPEN_MINT_ABI.filter((item): item is Extract<typeof OPEN_MINT_ABI[number], { type: "event"; name: "Transfer" | "OpenSignatureMinted" }> =>
  item.type === "event" && (item.name === "Transfer" || item.name === "OpenSignatureMinted"));
export const OPEN_PROJECTION_TOPICS = Object.freeze([
  encodeEventTopics({ abi: OPEN_PROJECTION_EVENTS, eventName: "Transfer" })[0],
  encodeEventTopics({ abi: OPEN_PROJECTION_EVENTS, eventName: "OpenSignatureMinted" })[0],
]);
const MINT_DATA = [{ type: "uint256" }, { type: "string" }, ...Array.from({ length: 4 }, () => ({ type: "bytes32" as const }))] as const;
export interface MintProjectionEvidence {
  /** Must come from the private, durable completed-publication/issuance store.
   * Never resolve this callback from browser JSON or arbitrary metadata URLs. */
  readonly reservation: AuthorizationReservation;
  readonly signature: string;
  readonly artifact: PreparedPublicArtifact;
}
type MintLog = Omit<ValidatedMint, "mbti" | "evidenceReference">;
interface Log { address: string; topics: Hex[]; data: Hex; blockHash: string; blockNumber: string; transactionHash: string; transactionIndex: string; logIndex: string; removed: false }
const fail = (): never => { throw new Error("OpenSignatures log or durable mint evidence failed validation."); };
function rpcQuantity(value: unknown, bits = 256): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) || value.length > 66 || BigInt(value) >= 1n << BigInt(bits)) return fail();
  return BigInt(value);
}
export function normalizeProjectionLog(value: unknown, deployment: ProjectionDeployment, block: { number: string; hash: string }, topics: readonly Hex[] = OPEN_PROJECTION_TOPICS): Log {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const log = value as Log;
  if (log.address !== deployment.contractAddress || log.removed !== false || log.blockHash !== block.hash
    || rpcQuantity(log.blockNumber, 63).toString() !== block.number || !Array.isArray(log.topics) || log.topics.length !== 4
    || log.topics.some(topic => typeof topic !== "string" || !/^0x[0-9a-f]{64}$/.test(topic))
    || !topics.includes(log.topics[0]) || typeof log.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(log.data)
    || log.data.length > 2050) return fail();
  hash(log.transactionHash); rpcQuantity(log.transactionIndex, 31); rpcQuantity(log.logIndex, 31);
  // Snapshot only allowed public fields; optional RPC extras grant no authority.
  return { address: log.address, topics: [...log.topics], data: log.data, blockHash: log.blockHash, blockNumber: log.blockNumber,
    transactionHash: log.transactionHash, transactionIndex: log.transactionIndex, logIndex: log.logIndex, removed: false };
}
function decode(log: Log): ValidatedTransfer | MintLog {
  const event = decodeEventLog({ abi: OPEN_PROJECTION_EVENTS, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
  const position = { transactionHash: log.transactionHash, transactionIndex: Number(rpcQuantity(log.transactionIndex, 31)), logIndex: Number(rpcQuantity(log.logIndex, 31)), tokenId: event.args.tokenId.toString() };
  if (event.eventName === "Transfer") {
    const topics = encodeEventTopics({ abi: OPEN_PROJECTION_EVENTS, eventName: "Transfer", args: event.args });
    if (log.data !== "0x" || topics.join() !== log.topics.join()) return fail();
    return { ...position, kind: "Transfer", from: event.args.from.toLowerCase(), to: event.args.to.toLowerCase() };
  }
  const a = event.args, topics = encodeEventTopics({ abi: OPEN_PROJECTION_EVENTS, eventName: "OpenSignatureMinted", args: a });
  // ABI decoding alone may tolerate trailing/noncanonical encodings. Require
  // the exact canonical event bytes the pinned contract would emit.
  if (topics.join() !== log.topics.join() || log.data !== encodeAbiParameters(MINT_DATA,
    [a.tokenId, a.normalizedHandle, a.assessmentDigest, a.artifactDigest, a.tokenURIHash, a.authorizationDigest])) return fail();
  if (a.handleKey !== openMintHandleKey(a.normalizedHandle) || a.tokenId !== BigInt(a.handleKey)) return fail();
  return { ...position, kind: "OpenSignatureMinted", handle: a.normalizedHandle, handleKey: a.handleKey, nonce: a.nonce,
    recipient: a.recipient.toLowerCase(), assessmentDigest: a.assessmentDigest, artifactDigest: a.artifactDigest,
    tokenURIHash: a.tokenURIHash, authorizationDigest: a.authorizationDigest };
}

/** Strict event + durable-evidence decoder. It authenticates signatures and
 * commitments, NOT raw-log completeness, canonicality or finality. A separate
 * bounded independent-RPC observer must establish those before append/promote.
 * This function makes no network request and emits no new authority. */
export async function decodeOpenSignaturesBlock(input: {
  contractProfile?: "external-v1" | "onchain-v1";
  deployment: ProjectionDeployment; authorizer: Address;
  block: { number: string; hash: string; parentHash: string; timestamp: string };
  logs: readonly unknown[]; timeoutMs: number; signal: AbortSignal;
  resolveMint: (log: Readonly<MintLog>, signal: AbortSignal, block: { number: bigint; hash: Hex }) => Promise<MintProjectionEvidence | OnchainMintEvidence | undefined>;
}): Promise<{ block: ValidatedBlock; chainAuthenticated: false }> {
  const startedAt = performance.now();
  if (input.contractProfile !== undefined && input.contractProfile !== "external-v1" && input.contractProfile !== "onchain-v1") return fail();
  const onchain = input.contractProfile === "onchain-v1";
  const deployment = validateDeployment(input.deployment), authorizer = getAddress(input.authorizer), block = { ...input.block }, resolveMint = input.resolveMint;
  address(authorizer.toLowerCase()); quantity(block.number, 63); quantity(block.timestamp, 64); hash(block.hash); hash(block.parentHash);
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000 || !Array.isArray(input.logs)
    || input.logs.length > MAX_BLOCK_EVENTS || typeof resolveMint !== "function") return fail();
  const logs = input.logs.map(log => normalizeProjectionLog(log, deployment, block)), signal = input.signal, controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    abort = () => { controller.abort(); reject(new Error("Projection decoding cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new Error("Projection decoding timed out.")); }, input.timeoutMs);
  });
  const deadline = startedAt + input.timeoutMs;
  const check = () => {
    if (controller.signal.aborted || signal.aborted) throw new Error("Projection decoding cancelled.");
    // Microtask-only decoding may starve timer callbacks. Check elapsed time
    // explicitly as well as retaining the timer for a hung async resolver.
    if (performance.now() >= deadline) throw new Error("Projection decoding timed out.");
  };
  try {
    check();
    const work = async () => {
      const events: ValidatedEvent[] = [];
      for (const log of logs) {
        check(); const event = decode(log);
        if (event.kind === "Transfer") { events.push(event); continue; }
        const evidence = await resolveMint(Object.freeze({ ...event }), controller.signal,
          Object.freeze({ number: BigInt(block.number), hash: block.hash as Hex })); check();
        if (!evidence) return fail();
        if (onchain) {
          if (!("kind" in evidence) || evidence.kind !== "onchain-v1") return fail();
          const saved = structuredClone(evidence), a = saved.artifact;
          const expected = encodeOnchainArtifact(a.artwork, a.assessmentDigest);
          if (expected.tokenURI !== a.tokenURI || expected.digest !== a.digest || expected.tokenURIHash !== a.tokenURIHash
            || expected.canonicalHandle !== event.handle || a.assessmentDigest !== event.assessmentDigest
            || a.digest !== event.artifactDigest || a.tokenURIHash !== event.tokenURIHash
            || saved.authorizationDigest !== event.authorizationDigest || saved.recipient !== event.recipient) return fail();
          check(); events.push({ ...event, mbti: a.artwork.mbti, evidenceReference: `onchain:${event.transactionHash}` });
          continue;
        }
        if ("kind" in evidence) return fail();
        for (const object of [evidence.artifact.svg, evidence.artifact.png, evidence.artifact.metadata]) {
          if (!(object.bytes instanceof Uint8Array) || object.bytes.byteLength < 1 || object.bytes.byteLength > PUBLIC_ARTIFACT_MAX_BYTES) return fail();
        }
        const saved = structuredClone(evidence), r = saved.reservation, a = normalizeOpenMintAuthorization(r.authorization), artifact = saved.artifact;
        if (r.version !== "sg-open-authorization-1" || !/^[0-9a-f-]{36}$/.test(r.id) || r.namespaceId !== deployment.namespaceId || r.deploymentId !== deployment.id
          || r.domain.chainId !== deployment.chainId || r.domain.verifyingContract.toLowerCase() !== deployment.contractAddress
          || getAddress(r.authorizer) !== authorizer || r.handle !== event.handle || r.assessmentId !== artifact.assessment.id
          || r.tokenURI !== artifact.metadata.object.uri || r.digest !== event.authorizationDigest
          || openMintDigest(r.domain, a) !== event.authorizationDigest || a.handleKey !== event.handleKey || a.nonce !== event.nonce
          || a.recipient.toLowerCase() !== event.recipient || a.assessmentDigest !== event.assessmentDigest || a.artifactDigest !== event.artifactDigest
          || a.tokenURIHash !== event.tokenURIHash || a.tokenURIHash !== openMintTokenURIHash(r.tokenURI)
          || BigInt(block.timestamp) < a.issuedAt || BigInt(block.timestamp) > a.deadline
          || artifact.assessment.handle !== event.handle || artifact.assessment.digest !== event.assessmentDigest || artifact.digest !== event.artifactDigest) return fail();
        await verifyPreparedPublicArtifact(artifact); check();
        if (!await verifyOpenMintAuthorization(r.domain, a, saved.signature, authorizer)) return fail();
        check(); events.push({ ...event, mbti: artifact.assessment.mbti, evidenceReference: `authorization:${r.id}` });
      }
      const result = { number: block.number, hash: block.hash, parentHash: block.parentHash, events };
      validateBatch({ chainId: deployment.chainId, contractAddress: deployment.contractAddress, manifestHash: deployment.manifestHash, blocks: [result] }, deployment);
      check();
      return { block: result, chainAuthenticated: false as const };
    };
    return await Promise.race([work(), stop]);
  } finally { clearTimeout(timer); controller.abort(); if (abort) signal.removeEventListener("abort", abort); }
}
