import { isGenerativeProfile } from "../generativeProfiles.js";
import { performance } from "node:perf_hooks";
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, numberToHex, type Hex } from "viem";
import { PUBLIC_CHAIN_READ_ABI, PublicChainGate, createStagingEligibilityReader, type PublicChainGateConfig } from "../publicChain.js";
import type { PublicChainRpc, PublicChainReadMethod } from "../publicChainRpc.js";
import { decodeOpenSignaturesBlock, normalizeProjectionLog, OPEN_PROJECTION_TOPICS } from "./decode.js";
import { decodeGenerativeSignaturesBlock, GENERATIVE_PROJECTION_TOPICS, PULSE_PROJECTION_TOPICS } from "./generativeDecode.js";
import { PULSE_TOPIC_COUNTS } from "./pulseDecode.js";
import { verifyPulseImmutables } from "../pulseEconomics.js";
import { createGenerativeArtworkReader, createStagingGenerativeArtworkReader } from "../generativeReads.js";
import { GENERATIVE_MINT_ABI } from "../generativeAuthorization.js";
import { profileForRenderer } from "../generativeInputs.js";
import { fields, hash, MAX_BATCH_BLOCKS, MAX_BATCH_EVENTS, MAX_BLOCK_EVENTS, quantity, stable, validateBatch, validateDeployment,
  type ProjectionDeployment, type ValidatedBatch } from "./model.js";

export interface ChainPin { readonly number: string; readonly hash: string }
/** Supplied by the fenced projection, not by a public request. */
export interface ProjectionChainCursor {
  readonly head: ChainPin | null;
  readonly promoted: ChainPin | null;
  /** Ascending contiguous canonical tail, including the rollback ancestor. */
  readonly tail: readonly ChainPin[];
}
interface Header extends ChainPin { readonly parentHash: string; readonly timestamp: string; readonly transactions: readonly string[] }
export interface ProjectionObservationEvidence {
  readonly deployment: ProjectionDeployment;
  readonly cursor: ProjectionChainCursor;
  readonly head: ChainPin;
  readonly finalized: ChainPin;
  readonly observedAt: number; readonly validUntil: number;
  readonly sources: readonly string[];
  readonly batch?: ValidatedBatch;
  readonly promotion?: ChainPin;
  readonly halt?: "finality-contradiction" | "rollback-bound-exceeded";
}
declare const observationBrand: unique symbol;
export interface ProjectionObservation { readonly [observationBrand]: true }
const witnesses = new WeakMap<ProjectionObservation, ProjectionObservationEvidence>();
export class ProjectionObservationError extends Error {
  constructor() { super("Chain projection observation unavailable; no fresh authority was issued."); }
}
const fail = (): never => { throw new ProjectionObservationError(); };
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function rpcQuantity(value: unknown, bits = 63): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) || value.length > 66 || BigInt(value) >= 1n << BigInt(bits)) return fail();
  return BigInt(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function header(value: unknown): Header {
  const raw = record(value), number = rpcQuantity(raw.number).toString(), timestamp = rpcQuantity(raw.timestamp, 53).toString();
  hash(raw.hash);
  // Genesis may have a zero parent; deployment and all projected blocks may not.
  if (typeof raw.parentHash !== "string" || !/^0x[0-9a-f]{64}$/.test(raw.parentHash)) return fail();
  if (!Array.isArray(raw.transactions) || raw.transactions.length > 4096) return fail();
  raw.transactions.forEach(hash);
  if (new Set(raw.transactions).size !== raw.transactions.length) return fail();
  return freeze({ number, hash: raw.hash, parentHash: raw.parentHash, timestamp, transactions: [...raw.transactions] as string[] });
}
function pin(value: ChainPin): void { fields(value, ["number", "hash"]); quantity(value.number, 63); hash(value.hash); }
function cursor(value: ProjectionChainCursor, deployment: ProjectionDeployment): ProjectionChainCursor {
  const c = structuredClone(value); fields(c, ["head", "promoted", "tail"]);
  if (!Array.isArray(c.tail) || c.tail.length > deployment.policy.rollbackBlocks + 1) return fail();
  if (!c.head) { if (c.promoted || c.tail.length) return fail(); return freeze(c); }
  pin(c.head); if (BigInt(c.head.number) < BigInt(deployment.deploymentBlock)) return fail();
  if (c.promoted) { pin(c.promoted); if (BigInt(c.promoted.number) < BigInt(deployment.deploymentBlock) || BigInt(c.promoted.number) > BigInt(c.head.number)) return fail(); }
  const floor = BigInt(c.head.number) - BigInt(deployment.policy.rollbackBlocks);
  const first = floor < BigInt(deployment.deploymentBlock) ? BigInt(deployment.deploymentBlock) : floor;
  if (c.tail.length !== Number(BigInt(c.head.number) - first + 1n)) return fail();
  c.tail.forEach((p, index) => { pin(p); if (BigInt(p.number) !== first + BigInt(index)) fail(); });
  if (stable(c.tail.at(-1)) !== stable(c.head)) return fail();
  return freeze(c);
}
function clock(now: number): number { if (!Number.isSafeInteger(now) || now < 0) return fail(); return now; }
export function readProjectionObservation(value: unknown, deployment: ProjectionDeployment, now: number): ProjectionObservationEvidence {
  const evidence = value && typeof value === "object" ? witnesses.get(value as ProjectionObservation) : undefined;
  if (!evidence || stable(evidence.deployment) !== stable(deployment) || clock(now) < evidence.observedAt || now >= evidence.validUntil) return fail();
  return evidence;
}

/** Two explicitly trusted RPC operators, not a cryptographic light client.
 * Hash-filtered logs must agree, match successful receipts and block tx order.
 * Only Ethereum's finalized tag promotes; counts/elapsed time never substitute.
 * One call = one bounded pass. No background loops, retries or transactions.
 */
export interface ProjectionObserverOptions {
  deployment: ProjectionDeployment; config: PublicChainGateConfig;
  rpcs: readonly [PublicChainRpc, PublicChainRpc];
  maxHeadLag: number; maxFinalizedLag: number; maxFinalizedAgeMs: number;
  resolveMint?: Parameters<typeof decodeOpenSignaturesBlock>[0]["resolveMint"];
}
export function createProjectionObserver(options: ProjectionObserverOptions, now: () => number = Date.now) {
  return projectionObserver(options, now, false);
}
export function createStagingProjectionObserver(options: ProjectionObserverOptions, now: () => number = Date.now) {
  return projectionObserver(options, now, true);
}
function projectionObserver(options: ProjectionObserverOptions, now: () => number, staging: boolean) {
  const deployment = freeze(validateDeployment(options.deployment)), config = freeze(structuredClone(options.config));
  const contractProfile = config.contractProfile;
  const generative = isGenerativeProfile(contractProfile);
  if (generative !== !!deployment.generativeRenderer || (generative && (options.resolveMint !== undefined
    || stable(deployment.generativeRenderer) !== stable(config.generativeRenderer)))) fail();
  const readGenerative = generative ? (staging ? createStagingGenerativeArtworkReader : createGenerativeArtworkReader)(options) : undefined;
  const topics = config.pulse ? PULSE_PROJECTION_TOPICS : generative ? GENERATIVE_PROJECTION_TOPICS : OPEN_PROJECTION_TOPICS;
  const topicCounts = config.pulse ? PULSE_TOPIC_COUNTS : {};
  // Reuse all explicit chain-configuration validation; do not use its unminted
  // eligibility preflight to verify already-minted works.
  if (staging) createStagingEligibilityReader(config, options.rpcs, now);
  else new PublicChainGate(config, options.rpcs, now);
  if (deployment.id !== config.deploymentId || deployment.namespaceId !== config.namespaceId || deployment.chainId !== String(config.chainId)
    || deployment.contractAddress !== config.contract.toLowerCase() || deployment.deploymentBlock !== String(config.deploymentBlock.number)
    || deployment.deploymentBlockHash !== config.deploymentBlock.hash || (!generative && typeof options.resolveMint !== "function")) fail();
  const { maxHeadLag, maxFinalizedLag, maxFinalizedAgeMs, resolveMint } = options;
  for (const [v, min, max] of [[maxHeadLag, 0, 64], [maxFinalizedLag, 0, 128], [maxFinalizedAgeMs, 1, 3_600_000]]) {
    if (!Number.isSafeInteger(v) || v < min || v > max) fail();
  }
  const rpcs = options.rpcs.map(r => Object.freeze({ id: r.id, request: r.request.bind(r) }));
  return async (input: ProjectionChainCursor, signal: AbortSignal): Promise<ProjectionObservation> => {
    const saved = cursor(input, deployment), startedAt = clock(now()), deadlineAt = performance.now() + config.observationTimeoutMs;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const stop = new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); reject(new ProjectionObservationError()); };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, config.observationTimeoutMs);
    });
    const check = () => { if (signal.aborted || controller.signal.aborted || performance.now() >= deadlineAt) fail(); };
    const request = async (rpc: PublicChainRpc, method: PublicChainReadMethod, params: readonly unknown[]) => {
      check(); const result = await rpc.request(method, params, controller.signal); check(); return result;
    };
    const acquired = new Map<string, Header>();
    const pair = async (selector: string): Promise<Header> => {
      const results = await Promise.all(rpcs.map(async r => header(await request(r, "eth_getBlockByNumber", [selector, false]))));
      if (stable(results[0]) !== stable(results[1]) || (selector.startsWith("0x") && results[0].number !== rpcQuantity(selector).toString())) fail();
      const prior = acquired.get(results[0].number);
      if (prior && stable(prior) !== stable(results[0])) fail();
      acquired.set(results[0].number, results[0]);
      return results[0];
    };
    const common = async (tag: "latest" | "finalized", maxLag: number) => {
      const heads = await Promise.all(rpcs.map(async r => header(await request(r, "eth_getBlockByNumber", [tag, false]))));
      const lower = BigInt(heads[0].number) <= BigInt(heads[1].number) ? heads[0] : heads[1];
      if (BigInt(heads[0].number) - BigInt(lower.number) > BigInt(maxLag) || BigInt(heads[1].number) - BigInt(lower.number) > BigInt(maxLag)) fail();
      const result = await pair(numberToHex(BigInt(lower.number)));
      for (const h of heads) if (h.number === result.number && stable(h) !== stable(result)) fail();
      return result;
    };
    const identity = async (block: Header) => {
      const selector = { blockHash: block.hash, requireCanonical: true };
      await Promise.all(rpcs.map(async r => {
        const runtime = await request(r, "eth_getCode", [config.contract, selector]);
        if (typeof runtime !== "string" || !/^0x(?:[0-9a-f]{2}){1,65536}$/.test(runtime) || keccak256(runtime as Hex) !== config.runtimeCodeHash) fail();
        const read = async (functionName: "trustedAuthorizer" | "eip712Domain") => {
          const raw = await request(r, "eth_call", [{ to: config.contract, data: encodeFunctionData({ abi: PUBLIC_CHAIN_READ_ABI, functionName }) }, selector]);
          if (typeof raw !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(raw) || raw.length > 4098) return fail();
          return decodeFunctionResult({ abi: PUBLIC_CHAIN_READ_ABI, functionName, data: raw as Hex });
        };
        const [signer, domain] = await Promise.all([read("trustedAuthorizer"), read("eip712Domain")]);
        if (typeof signer !== "string" || getAddress(signer) !== getAddress(config.authorizer) || !Array.isArray(domain) || domain.length !== 7
          || domain[0] !== "0x0f" || domain[1] !== (generative ? profileForRenderer(config.generativeRenderer!).domainName : config.contractProfile === "onchain-v1" ? "SignaturesOnchainMint" : "SignaturesOpenMint") || domain[2] !== "1" || domain[3] !== config.chainId
          || getAddress(domain[4] as string) !== getAddress(config.contract) || domain[5] !== `0x${"00".repeat(32)}`
          || !Array.isArray(domain[6]) || domain[6].length) fail();
        if (generative) {
          const pin = config.generativeRenderer!;
          const code = await request(r, "eth_getCode", [pin.address, selector]);
          if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2}){1,65536}$/.test(code) || keccak256(code as Hex) !== pin.runtimeCodeHash) fail();
          for (const [name, expected] of [["renderer", getAddress(pin.address)], ["rendererIdentity", pin.identity], ["INPUT_PROFILE", profileForRenderer(config.generativeRenderer!).inputProfile]] as const) {
            const raw = await request(r, "eth_call", [{ to: config.contract, data: encodeFunctionData({ abi: GENERATIVE_MINT_ABI, functionName: name }) }, selector]);
            if (typeof raw !== "string" || raw.length > 4098 || !/^0x(?:[0-9a-f]{2})+$/.test(raw)
              || decodeFunctionResult({ abi: GENERATIVE_MINT_ABI, functionName: name, data: raw as Hex }) !== expected) fail();
          }
          if(config.pulse) await verifyPulseImmutables(config.pulse,config.chainId,
            async data => await request(r,"eth_call",[{to:config.contract,data},selector]) as Hex,
            async () => await request(r,"eth_getCode",[config.pulse!.core,selector]) as Hex);
        }
      }));
    };
    const work = async () => {
      check();
      for (const r of rpcs) if (rpcQuantity(await request(r, "eth_chainId", []), 256) !== config.chainId) fail();
      if ((await pair("0x0")).hash !== config.genesisHash || (await pair(numberToHex(config.deploymentBlock.number))).hash !== config.deploymentBlock.hash) fail();
      const head = await common("latest", maxHeadLag), finalized = await common("finalized", maxFinalizedLag);
      if (BigInt(head.number) < config.deploymentBlock.number || BigInt(finalized.number) > BigInt(head.number)
        || BigInt(finalized.timestamp) > BigInt(head.timestamp) || (saved.head && BigInt(saved.head.number) > BigInt(head.number))) fail();
      await identity(head);
      let halt: ProjectionObservationEvidence["halt"], from = config.deploymentBlock.number;
      if (saved.promoted) {
        if (BigInt(finalized.number) < BigInt(saved.promoted.number)) fail(); // a lagging node is not a proven contradiction
        if ((await pair(numberToHex(BigInt(saved.promoted.number)))).hash !== saved.promoted.hash) halt = "finality-contradiction";
      }
      if (saved.head && !halt) {
        let ancestor: ChainPin | undefined;
        for (const p of [...saved.tail].reverse()) {
          if ((await pair(numberToHex(BigInt(p.number)))).hash === p.hash) { ancestor = p; break; }
        }
        if (!ancestor) halt = "rollback-bound-exceeded";
        else from = BigInt(ancestor.number) + (ancestor.number === saved.head.number ? 0n : 1n);
      }
      let batch: ValidatedBatch | undefined, promotion: ChainPin | undefined;
      if (!halt) {
        const end = from + BigInt(MAX_BATCH_BLOCKS - 1) < BigInt(head.number) ? from + BigInt(MAX_BATCH_BLOCKS - 1) : BigInt(head.number);
        const blocks = []; let totalEvents = 0, previous: Header | undefined;
        for (let n = from; n <= end; n++) {
          const block = await pair(numberToHex(n));
          if (previous && (block.parentHash !== previous.hash || BigInt(block.timestamp) < BigInt(previous.timestamp))) fail();
          if (block.parentHash === `0x${"00".repeat(32)}` || BigInt(block.timestamp) > BigInt(head.timestamp)) fail();
          if (!previous && n > config.deploymentBlock.number) {
            const parent = saved.tail.find(p => BigInt(p.number) === n - 1n);
            if (!parent || block.parentHash !== parent.hash) fail();
          }
          await identity(block);
          const all = await Promise.all(rpcs.map(async r => {
            const raw = await request(r, "eth_getLogs", [{ address: config.contract, blockHash: block.hash, topics: [topics] }]);
            if (!Array.isArray(raw) || raw.length > MAX_BLOCK_EVENTS) return fail();
            return raw.map(log => normalizeProjectionLog(log, deployment, block, topics, topicCounts));
          }));
          if (stable(all[0]) !== stable(all[1]) || (totalEvents += all[0].length) > MAX_BATCH_EVENTS) fail();
          const logs = all[0];
          for (const txHash of new Set(logs.map(l => l.transactionHash))) {
            const expected = logs.filter(l => l.transactionHash === txHash), index = rpcQuantity(expected[0].transactionIndex, 31);
            if (block.transactions[Number(index)] !== txHash) fail();
            await Promise.all(rpcs.map(async r => {
              const receipt = record(await request(r, "eth_getTransactionReceipt", [txHash]));
              if (receipt.status !== "0x1" || receipt.transactionHash !== txHash || receipt.blockHash !== block.hash
                || rpcQuantity(receipt.blockNumber).toString() !== block.number || rpcQuantity(receipt.transactionIndex, 31) !== index
                || !Array.isArray(receipt.logs) || receipt.logs.length > 1024) fail();
              const relevant = (receipt.logs as unknown[]).filter(raw => {
                const l = record(raw);
                return l.address === deployment.contractAddress && Array.isArray(l.topics) && topics.includes(l.topics[0]);
              }).map(l => normalizeProjectionLog(l, deployment, block, topics, topicCounts));
              if (stable(relevant) !== stable(expected)) fail();
            }));
          }
          const common = { deployment, block: { number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp }, logs,
            timeoutMs: config.observationTimeoutMs, signal: controller.signal };
          const decoded = readGenerative ? await decodeGenerativeSignaturesBlock({ ...common, read: readGenerative, ...(config.pulse ? {pulse:config.pulse} : {}) })
            : await decodeOpenSignaturesBlock({ ...common, authorizer: config.authorizer,
              contractProfile: contractProfile as "external-v1" | "onchain-v1" | undefined, resolveMint: resolveMint! });
          check(); blocks.push(decoded.block); previous = block;
        }
        batch = validateBatch({ chainId: deployment.chainId, contractAddress: deployment.contractAddress, manifestHash: deployment.manifestHash, blocks }, deployment);
        // Finality may advance behind an unchanged projection tip. It must not
        // wait for another mint or another inclusion batch at that old height.
        if (BigInt(finalized.number) >= config.deploymentBlock.number) {
          const n = BigInt(finalized.number) < end ? BigInt(finalized.number) : end;
          const boundary = await pair(numberToHex(n));
          promotion = { number: boundary.number, hash: boundary.hash };
        }
      }
      // Recheck every acquired header (including rollback/finality anchors)
      // after evidence resolution, not just the tip.
      for (const b of [...acquired.values()]) await pair(numberToHex(BigInt(b.number)));
      if (stable(await pair(numberToHex(BigInt(head.number)))) !== stable(head)
        || stable(await pair(numberToHex(BigInt(finalized.number)))) !== stable(finalized)) fail();
      const endFinalized = await common("finalized", maxFinalizedLag);
      if (BigInt(endFinalized.number) < BigInt(finalized.number)) fail();
      for (const r of rpcs) if (rpcQuantity(await request(r, "eth_chainId", []), 256) !== config.chainId) fail();
      check();
      const observedAt = clock(now()), headTime = Number(head.timestamp) * 1000, finalTime = Number(finalized.timestamp) * 1000;
      if (!Number.isSafeInteger(headTime) || !Number.isSafeInteger(finalTime) || observedAt < startedAt
        || observedAt - headTime >= config.maxBlockAgeMs || headTime - observedAt > config.maxFutureSkewMs
        || observedAt - finalTime >= maxFinalizedAgeMs || finalTime - observedAt > config.maxFutureSkewMs) fail();
      const evidence = freeze({ deployment, cursor: saved, head: { number: head.number, hash: head.hash }, finalized: { number: finalized.number, hash: finalized.hash },
        observedAt, validUntil: Math.min(observedAt + config.evidenceTtlMs, headTime + config.maxBlockAgeMs, finalTime + maxFinalizedAgeMs),
        sources: rpcs.map(r => r.id), ...(halt ? { halt } : { batch: batch!, ...(promotion ? { promotion } : {}) }) });
      check(); const witness = Object.freeze({}) as ProjectionObservation; witnesses.set(witness, evidence); return witness;
    };
    try { return await Promise.race([work(), stop]); }
    catch { throw new ProjectionObservationError(); } // never expose credential-bearing RPC/provider errors
    finally { clearTimeout(timer); controller.abort(); if (abort) signal.removeEventListener("abort", abort); }
  };
}
