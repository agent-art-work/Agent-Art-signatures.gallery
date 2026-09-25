import { profileForRenderer } from "../generativeInputs.js";
import { performance } from "node:perf_hooks";
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { GENERATIVE_MINT_ABI } from "../generativeAuthorization.js";
import { canonicalHandle } from "../identity.js";
import type { createGenerativeArtworkReader } from "../generativeReads.js";
import { normalizeProjectionLog } from "./decode.js";
import { hash, quantity, MAX_BLOCK_EVENTS, validateBatch, validateDeployment, type ProjectionDeployment, type ValidatedEvent, type ValidatedBlock } from "./model.js";

export const GENERATIVE_PROJECTION_TOPICS = Object.freeze([
  encodeEventTopics({ abi: GENERATIVE_MINT_ABI, eventName: "Transfer" })[0],
  encodeEventTopics({ abi: GENERATIVE_MINT_ABI, eventName: "GenerativeSignatureMinted" })[0],
]);
const DATA = [{ type: "uint256" }, { type: "string" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }] as const;
const fail = (): never => { throw new Error("Generative event/input evidence failed validation."); };

/** Event/input validation, not a finality oracle. Only the observer supplies
 * canonical receipt/log completeness and issues a fresh projection witness. */
export async function decodeGenerativeSignaturesBlock(input: {
  deployment: ProjectionDeployment; block: { number: string; hash: string; parentHash: string; timestamp: string };
  logs: readonly unknown[]; signal: AbortSignal; timeoutMs: number;
  read: ReturnType<typeof createGenerativeArtworkReader>;
}): Promise<{ block: ValidatedBlock; chainAuthenticated: false }> {
  const deployment = validateDeployment(input.deployment), block = { ...input.block }, read = input.read;
  if (!deployment.generativeRenderer || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30000
    || !Array.isArray(input.logs) || input.logs.length > MAX_BLOCK_EVENTS || typeof read !== "function") fail();
  quantity(block.number, 63); quantity(block.timestamp, 64); hash(block.hash); hash(block.parentHash);
  const logs = input.logs.map(log => normalizeProjectionLog(log, deployment, block, GENERATIVE_PROJECTION_TOPICS));
  const controller = new AbortController(), end = performance.now() + input.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  const check = () => { if (input.signal.aborted || controller.signal.aborted || performance.now() >= end) fail(); };
  const stop = new Promise<never>((_, reject) => {
    abort = () => { controller.abort(); reject(new Error("Generative decoding cancelled.")); };
    input.signal.addEventListener("abort", abort, { once: true }); timer = setTimeout(abort, input.timeoutMs);
  });
  try {
    const work = async () => {
      check(); const events: ValidatedEvent[] = [];
      for (const log of logs) {
        check();
        const event = decodeEventLog({ abi: GENERATIVE_MINT_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
        const position = { transactionHash: log.transactionHash, transactionIndex: Number(BigInt(log.transactionIndex)), logIndex: Number(BigInt(log.logIndex)), tokenId: event.args.tokenId.toString() };
        if (event.eventName === "Transfer") {
          if (log.data !== "0x" || encodeEventTopics({ abi: GENERATIVE_MINT_ABI, eventName: "Transfer", args: event.args }).join() !== log.topics.join()) fail();
          events.push({ ...position, kind: "Transfer", from: event.args.from.toLowerCase(), to: event.args.to.toLowerCase() }); continue;
        }
        const a = event.args;
        if (encodeEventTopics({ abi: GENERATIVE_MINT_ABI, eventName: "GenerativeSignatureMinted", args: a }).join() !== log.topics.join()
          || encodeAbiParameters(DATA, [a.tokenId, a.renderHandle, a.mbti, a.assessmentDigest, a.inputDigest, a.authorizationDigest]) !== log.data) fail();
        const handle = canonicalHandle(a.renderHandle);
        const evidence = await read(handle, { number: BigInt(block.number), hash: block.hash as Hex }, controller.signal); check();
        if (evidence.kind !== profileForRenderer(deployment.generativeRenderer!).contractProfile || evidence.inputs.canonicalHandle !== handle || evidence.inputs.renderHandle !== a.renderHandle
          || evidence.inputs.mbti !== a.mbti || evidence.inputs.digest !== a.inputDigest || evidence.inputs.assessmentDigest !== a.assessmentDigest
          || evidence.inputs.rendererIdentity !== deployment.generativeRenderer!.identity || evidence.authorizationDigest !== a.authorizationDigest
          || evidence.recipient !== a.recipient.toLowerCase()) fail();
        events.push({ ...position, kind: "GenerativeSignatureMinted", handle, renderHandle: a.renderHandle, handleKey: a.handleKey,
          nonce: a.nonce, recipient: evidence.recipient, assessmentDigest: a.assessmentDigest, inputDigest: a.inputDigest,
          rendererIdentity: evidence.inputs.rendererIdentity, authorizationDigest: a.authorizationDigest, mbti: a.mbti, evidenceReference: `generative:${log.transactionHash}` });
      }
      const result = { number: block.number, hash: block.hash, parentHash: block.parentHash, events };
      validateBatch({ chainId: deployment.chainId, contractAddress: deployment.contractAddress, manifestHash: deployment.manifestHash, blocks: [result] }, deployment);
      check(); return { block: result, chainAuthenticated: false as const };
    };
    return await Promise.race([work(), stop]);
  } finally { clearTimeout(timer); controller.abort(); if (abort) input.signal.removeEventListener("abort", abort); }
}
