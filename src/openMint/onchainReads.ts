import { performance } from "node:perf_hooks";
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, numberToHex, type Hex } from "viem";
import { openMintHandleKey } from "./authorization.js";
import { ONCHAIN_MINT_ABI } from "./onchainAuthorization.js";
import { encodeOnchainArtifact, ONCHAIN_MAX_SVG_BYTES, type OnchainArtifact } from "./onchainArtifact.js";
import { isMbti } from "./identity.js";
import type { PublicChainBlock, PublicChainGateConfig } from "./publicChain.js";
import { PublicChainGate, PUBLIC_CHAIN_READ_ABI } from "./publicChain.js";
import type { PublicChainRpc } from "./publicChainRpc.js";

export interface OnchainMintEvidence {
  readonly kind: "onchain-v1";
  readonly artifact: OnchainArtifact;
  readonly authorizationDigest: Hex;
  readonly recipient: string;
}
export class OnchainReadError extends Error {
  constructor() { super("On-chain artwork could not be verified at the requested block."); }
}
function fail(): never { throw new OnchainReadError(); }
const validHash = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) && !/^0x0{64}$/.test(value);

/** Chain-only recovery. No assessment store, renderer execution, publication
 * journal, filesystem, CDN or IPFS lookup is needed. This pins consistency at an
 * explicit block; inclusion/finality/freshness are the projection's job. */
export function createOnchainArtworkReader(options: {
  config: PublicChainGateConfig; rpcs: readonly [PublicChainRpc, PublicChainRpc];
}) {
  const config = structuredClone(options.config);
  if (config.contractProfile !== "onchain-v1") fail();
  new PublicChainGate(config, options.rpcs); // shared bounded configuration validation
  const rpcs = options.rpcs.map(r => ({ id: r.id, request: r.request.bind(r) }));
  return async (handle: string, inputBlock: PublicChainBlock, signal: AbortSignal): Promise<OnchainMintEvidence> => {
    const key = openMintHandleKey(handle), id = BigInt(key), block = { ...inputBlock };
    if (!validHash(block.hash) || typeof block.number !== "bigint" || block.number < config.deploymentBlock.number || block.number >= 2n ** 63n) fail();
    const controller = new AbortController(), expires = performance.now() + config.observationTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const stop = new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); reject(new OnchainReadError()); };
      signal.addEventListener("abort", abort, { once: true }); timer = setTimeout(abort, config.observationTimeoutMs);
    });
    const check = () => { if (signal.aborted || controller.signal.aborted || performance.now() >= expires) fail(); };
    try {
      check();
      const work = Promise.all(rpcs.map(async rpc => {
        const request = async (method: Parameters<PublicChainRpc["request"]>[0], params: readonly unknown[]) => {
          check(); const result = await rpc.request(method, params, controller.signal); check(); return result;
        };
        const header = async (pin: PublicChainBlock) => {
          const result = await request("eth_getBlockByNumber", [numberToHex(pin.number), false]) as { hash?: unknown; number?: unknown } | null;
          if (!result || result.hash !== pin.hash || result.number !== numberToHex(pin.number)) fail();
        };
        const pinned = { blockHash: block.hash, requireCanonical: true };
        const read = async (functionName: "tokenURI" | "svg" | "artwork" | "provenance"): Promise<unknown> => {
          const data = encodeFunctionData({ abi: ONCHAIN_MINT_ABI, functionName, args: [id] });
          const raw = await request("eth_call", [{ to: config.contract, data }, pinned]);
          if (typeof raw !== "string" || raw.length > 131074 || !/^0x(?:[0-9a-f]{2})*$/.test(raw)) fail();
          return decodeFunctionResult({ abi: ONCHAIN_MINT_ABI, functionName, data: raw as Hex });
        };
        const chain = await request("eth_chainId", []);
        if (chain !== numberToHex(config.chainId)) fail();
        await Promise.all([header({ number: 0n, hash: config.genesisHash }), header(config.deploymentBlock), header(block)]);
        const runtime = await request("eth_getCode", [config.contract, pinned]);
        if (typeof runtime !== "string" || runtime.length > 131074 || !/^0x(?:[0-9a-f]{2})+$/.test(runtime)
          || keccak256(runtime as Hex) !== config.runtimeCodeHash) fail();
        const domainData = encodeFunctionData({ abi: PUBLIC_CHAIN_READ_ABI, functionName: "eip712Domain" });
        const domainRaw = await request("eth_call", [{ to: config.contract, data: domainData }, pinned]);
        if (typeof domainRaw !== "string" || domainRaw.length > 4098 || !/^0x(?:[0-9a-f]{2})+$/.test(domainRaw)) fail();
        const d = decodeFunctionResult({ abi: PUBLIC_CHAIN_READ_ABI, functionName: "eip712Domain", data: domainRaw as Hex });
        if (d[0] !== "0x0f" || d[1] !== "SignaturesOnchainMint" || d[2] !== "1" || d[3] !== config.chainId
          || getAddress(d[4]) !== getAddress(config.contract) || d[5] !== `0x${"0".repeat(64)}` || d[6].length) fail();
        const [uri, svg, art, provenance] = await Promise.all([read("tokenURI"), read("svg"), read("artwork"), read("provenance")]);
        if (typeof svg !== "string" || Buffer.byteLength(svg) > ONCHAIN_MAX_SVG_BYTES || typeof uri !== "string" || uri.length > 40_000
          || !Array.isArray(art) || art.length !== 3 || typeof art[1] !== "string" || !isMbti(art[2])
          || !Array.isArray(provenance) || provenance.length !== 6 || provenance[0] !== handle || typeof provenance[3] !== "string"
          || !validHash(provenance[1]) || !validHash(provenance[2]) || !validHash(provenance[4]) || !validHash(provenance[5])) fail();
        const artifact = encodeOnchainArtifact({ renderHandle: art[1], mbti: art[2], svg }, provenance[1]);
        if (artifact.canonicalHandle !== handle || artifact.tokenURI !== uri || artifact.digest !== provenance[2]
          || artifact.tokenURIHash !== provenance[4]) fail();
        const recipient = getAddress(provenance[3]).toLowerCase();
        if (/^0x0{40}$/.test(recipient)) fail();
        await header(block);
        if (await request("eth_chainId", []) !== numberToHex(config.chainId)) fail();
        return { kind: "onchain-v1" as const, artifact, authorizationDigest: provenance[5], recipient };
      }));
      const [first, second] = await Promise.race([work, stop]); check();
      if (JSON.stringify(first) !== JSON.stringify(second)) fail();
      return Object.freeze(first);
    } catch { return fail(); }
    finally { clearTimeout(timer); controller.abort(); if (abort) signal.removeEventListener("abort", abort); }
  };
}
