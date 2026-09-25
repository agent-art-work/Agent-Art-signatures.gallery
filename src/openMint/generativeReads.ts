import { isGenerativeProfile, type GenerativeContractProfile } from "./generativeProfiles.js";
import { performance } from "node:perf_hooks";
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, numberToHex, type Hex } from "viem";
import { openMintHandleKey } from "./authorization.js";
import { GENERATIVE_MINT_ABI } from "./generativeAuthorization.js";
import { profileForRenderer, generativeInputDigest, validateGenerativeInputs, type GenerativeInputs } from "./generativeInputs.js";
import type { PublicChainBlock, PublicChainGateConfig } from "./publicChain.js";
import { PublicChainGate, createStagingEligibilityReader, PUBLIC_CHAIN_READ_ABI } from "./publicChain.js";
import type { PublicChainRpc } from "./publicChainRpc.js";
import { decodeArtworkDataUri, decodeBoundedRead, GENERATIVE_READ_LIMITS as LIMITS } from "./generativeReadLimits.js";

export interface GenerativeMintEvidence {
  readonly kind: GenerativeContractProfile;
  readonly inputs: GenerativeInputs;
  readonly tokenURI: string; readonly svg: string;
  readonly authorizationDigest: Hex; readonly recipient: string; readonly owner: string;
}
export class GenerativeReadError extends Error {
  constructor() { super("Generative artwork could not be verified at the requested block."); }
}
function fail(): never { throw new GenerativeReadError(); }
const validHash = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) && !/^0x0{64}$/.test(value);

/** Read-generated metadata, recovered with no database, assessment provider,
 * uploader, TS renderer or website. Two configured RPC sources must agree at one
 * canonical block. This evidence alone does not establish finality/freshness. */
type ArtworkReaderOptions = { config: PublicChainGateConfig; rpcs: readonly [PublicChainRpc, PublicChainRpc] };
export function createGenerativeArtworkReader(options: ArtworkReaderOptions) {
  return artworkReader(options, false);
}
/** Explicit read-only Sepolia RC1 path; ordinary construction remains local. */
export function createStagingGenerativeArtworkReader(options: ArtworkReaderOptions) {
  return artworkReader(options, true);
}
function artworkReader(options: ArtworkReaderOptions, staging: boolean) {
  const config = structuredClone(options.config);
  if (!isGenerativeProfile(config.contractProfile) || !config.generativeRenderer) fail();
  if (staging) createStagingEligibilityReader(config, options.rpcs);
  else new PublicChainGate(config, options.rpcs);
  const pin = config.generativeRenderer, selected = profileForRenderer(pin);
  const rpcs = options.rpcs.map(r => ({ id: r.id, request: r.request.bind(r) }));
  return async (handle: string, inputBlock: PublicChainBlock, signal: AbortSignal): Promise<GenerativeMintEvidence> => {
    const key = openMintHandleKey(handle), id = BigInt(key), block = { ...inputBlock };
    if (!validHash(block.hash) || typeof block.number !== "bigint" || block.number < config.deploymentBlock.number || block.number >= 2n ** 63n) fail();
    const controller = new AbortController(), expires = performance.now() + config.observationTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const stop = new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); reject(new GenerativeReadError()); };
      signal.addEventListener("abort", abort, { once: true }); timer = setTimeout(abort, config.observationTimeoutMs);
    });
    const check = () => { if (signal.aborted || controller.signal.aborted || performance.now() >= expires) fail(); };
    try {
      check();
      const work = Promise.all(rpcs.map(async rpc => {
        const request = async (method: Parameters<PublicChainRpc["request"]>[0], params: readonly unknown[]) => {
          check(); const result = await rpc.request(method, params, controller.signal); check(); return result;
        };
        const header = async (p: PublicChainBlock) => {
          const result = await request("eth_getBlockByNumber", [numberToHex(p.number), false]) as { hash?: unknown; number?: unknown } | null;
          if (!result || result.hash !== p.hash || result.number !== numberToHex(p.number)) fail();
        };
        const pinned = { blockHash: block.hash, requireCanonical: true };
        const read = async (functionName: "tokenURI" | "inputs" | "provenance" | "renderer" | "rendererIdentity" | "INPUT_PROFILE" | "ownerOf"): Promise<unknown> => {
          const args = ["renderer", "rendererIdentity", "INPUT_PROFILE"].includes(functionName) ? [] : [id];
          const data = encodeFunctionData({ abi: GENERATIVE_MINT_ABI, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
          // Bound execution explicitly. One tokenURI call per source, not an
          // additional svg() render or unbounded provider-default read.
          const artwork = functionName === "tokenURI";
          const raw = await request("eth_call", [{ to: config.contract, data,
            gas: numberToHex(artwork ? LIMITS.artworkGas : LIMITS.scalarGas) }, pinned]);
          return decodeBoundedRead(GENERATIVE_MINT_ABI, functionName, raw, artwork ? LIMITS.artworkAbiBytes : LIMITS.scalarAbiBytes);
        };
        if (await request("eth_chainId", []) !== numberToHex(config.chainId)) fail();
        await Promise.all([header({ number: 0n, hash: config.genesisHash }), header(config.deploymentBlock), header(block)]);
        for (const [address, expected] of [[config.contract, config.runtimeCodeHash], [pin.address, pin.runtimeCodeHash]]) {
          const runtime = await request("eth_getCode", [address, pinned]);
          if (typeof runtime !== "string" || runtime.length > 131074 || !/^0x(?:[0-9a-f]{2})+$/.test(runtime) || keccak256(runtime as Hex) !== expected) fail();
        }
        const domainData = encodeFunctionData({ abi: PUBLIC_CHAIN_READ_ABI, functionName: "eip712Domain" });
        const raw = await request("eth_call", [{ to: config.contract, data: domainData, gas: numberToHex(LIMITS.scalarGas) }, pinned]);
        decodeBoundedRead(PUBLIC_CHAIN_READ_ABI, "eip712Domain", raw, LIMITS.scalarAbiBytes);
        const d = decodeFunctionResult({ abi: PUBLIC_CHAIN_READ_ABI, functionName: "eip712Domain", data: raw as Hex });
        if (d[0] !== "0x0f" || d[1] !== selected.domainName || d[2] !== "1" || d[3] !== config.chainId
          || getAddress(d[4]) !== getAddress(config.contract) || d[5] !== `0x${"0".repeat(64)}` || d[6].length) fail();
        const [uri, art, provenance, renderer, identity, profile, owner] = await Promise.all([
          read("tokenURI"), read("inputs"), read("provenance"), read("renderer"), read("rendererIdentity"), read("INPUT_PROFILE"), read("ownerOf"),
        ]);
        if (renderer !== getAddress(pin.address) || identity !== pin.identity || profile !== selected.inputProfile
          || !Array.isArray(art) || art.length !== 2 || !Array.isArray(provenance) || provenance.length !== 3
          || !validHash(provenance[0]) || !validHash(provenance[1]) || typeof provenance[2] !== "string" || typeof owner !== "string") fail();
        const inputs = validateGenerativeInputs({ profile: selected.inputProfile, canonicalHandle: handle, renderHandle: art[0], mbti: art[1],
          assessmentDigest: provenance[0], rendererIdentity: pin.identity, digest: generativeInputDigest(art[0], art[1], pin.identity, selected.inputProfile) });
        const json = decodeArtworkDataUri(uri, "data:application/json;base64,", LIMITS.metadataJsonBytes), metadata = JSON.parse(json);
        const svg = decodeArtworkDataUri(metadata.image, "data:image/svg+xml;base64,", LIMITS.svgBytes);
        const expected = { name: `@${inputs.renderHandle} × ${inputs.mbti}`, description: selected.description, image: metadata.image,
          attributes: [{ trait_type: "Handle", value: inputs.renderHandle }, { trait_type: "MBTI", value: inputs.mbti }],
          properties: { renderer: selected.rendererVersion, input_profile: selected.inputProfile, renderer_identity: pin.identity, assessment_digest: provenance[0] } };
        if (json !== JSON.stringify(expected)) fail();
        const recipient = getAddress(provenance[2]).toLowerCase(), currentOwner = getAddress(owner).toLowerCase();
        if (/^0x0{40}$/.test(recipient) || /^0x0{40}$/.test(currentOwner)) fail();
        await header(block);
        if (await request("eth_chainId", []) !== numberToHex(config.chainId)) fail();
        return { kind: selected.contractProfile, inputs, tokenURI: uri as string, svg, authorizationDigest: provenance[1], recipient, owner: currentOwner };
      }));
      const [first, second] = await Promise.race([work, stop]); check();
      if (JSON.stringify(first) !== JSON.stringify(second)) fail();
      return Object.freeze(first);
    } catch { return fail(); }
    finally { clearTimeout(timer); controller.abort(); if (abort) signal.removeEventListener("abort", abort); }
  };
}
