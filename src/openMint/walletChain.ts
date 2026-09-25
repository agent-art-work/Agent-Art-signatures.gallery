import { isGenerativeProfile } from "./generativeProfiles.js";
import { performance } from "node:perf_hooks";
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, type Hex } from "viem";
import { PublicChainGate, createStagingEligibilityReader, PUBLIC_CHAIN_READ_ABI, type PublicChainGateConfig } from "./publicChain.js";
import type { PublicChainRpc } from "./publicChainRpc.js";
import { GENERATIVE_MINT_ABI } from "./generativeAuthorization.js";
import { profileForRenderer } from "./generativeInputs.js";

export interface WalletChainContext { chainId: Hex; contract: string; blockNumber: Hex; blockHash: Hex; nonce?: Hex }
export class WalletChainUnavailableError extends Error { constructor() { super("The wallet's connection to the mint network cannot be verified."); } }
const fail = (): never => { throw new WalletChainUnavailableError(); };
const quantity = (v: unknown): Hex => {
  if (typeof v !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v) || v.length > 16 || BigInt(v) > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return v as Hex;
};
function header(v: unknown) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  const r = v as Record<string, unknown>, number = quantity(r.number), timestamp = quantity(r.timestamp);
  if (typeof r.hash !== "string" || !/^0x[0-9a-f]{64}$/.test(r.hash) || /^0x0{64}$/.test(r.hash)) return fail();
  return { number, timestamp, hash: r.hash as Hex };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const abi = [...PUBLIC_CHAIN_READ_ABI, ...GENERATIVE_MINT_ABI];
const stagingReadOnly = Symbol("Sepolia wallet context only");

/** Read-only Sepolia RC1 context. Does not grant authority or enable startup. */
export function createStagingWalletChain(config: PublicChainGateConfig, rpcs: readonly [PublicChainRpc, PublicChainRpc]): Pick<GenerativeWalletChain, "read"> {
  const reader = new GenerativeWalletChain(config, rpcs, stagingReadOnly);
  return Object.freeze({ read: reader.read.bind(reader) });
}

/** Read-only wallet identity/nonce context, not a mint eligibility witness.
 * Two exact current heads are required for this isolated profile. No fallback,
 * signing, broadcaster, guessed nonce, private RPC URL or endpoint is exposed. */
export class GenerativeWalletChain {
  readonly config: Readonly<PublicChainGateConfig>;
  readonly #rpcs: readonly PublicChainRpc[];
  constructor(config: PublicChainGateConfig, rpcs: readonly [PublicChainRpc, PublicChainRpc], mode?: symbol) {
    if (mode === stagingReadOnly) createStagingEligibilityReader(config, rpcs);
    else {
      new PublicChainGate(config, rpcs);
      if (config.chainId !== 31337n || !isGenerativeProfile(config.contractProfile)) fail();
    }
    this.config = Object.freeze({ ...structuredClone(config), generativeRenderer: Object.freeze({ ...config.generativeRenderer! }), deploymentBlock: Object.freeze({ ...config.deploymentBlock }) });
    this.#rpcs = rpcs.map(r => Object.freeze({ id: r.id, request: r.request.bind(r) }));
  }
  async read(value: unknown, signal: AbortSignal): Promise<WalletChainContext> {
    let recipient: string | undefined;
    try { if (value !== undefined) recipient = getAddress(String(value)); } catch { return fail(); }
    if (recipient && /^0x0{40}$/i.test(recipient)) fail();
    const c = this.config, controller = new AbortController(), end = performance.now() + c.observationTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const check = () => { if (signal.aborted || controller.signal.aborted || performance.now() >= end) fail(); };
    const stopped = new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); reject(new WalletChainUnavailableError()); };
      signal.addEventListener("abort", abort, { once: true }); timer = setTimeout(abort, c.observationTimeoutMs);
    });
    const work = async () => {
      check();
      const observations = await Promise.all(this.#rpcs.map(async rpc => {
        const request: PublicChainRpc["request"] = async (method, params) => { check(); const r = await rpc.request(method, params, controller.signal); check(); return r; };
        const call = (method: Parameters<PublicChainRpc["request"]>[0], params: readonly unknown[]) => request(method, params, controller.signal);
        const observed = header(await call("eth_getBlockByNumber", ["latest", false]));
        if (BigInt(observed.number) < c.deploymentBlock.number) fail();
        const block = { blockHash: observed.hash, requireCanonical: true };
        const read = async (functionName: "renderer" | "rendererIdentity" | "INPUT_PROFILE" | "trustedAuthorizer" | "eip712Domain") => {
          const raw = await call("eth_call", [{ to: c.contract, data: encodeFunctionData({ abi, functionName }) }, block]);
          if (typeof raw !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(raw) || raw.length > 4098) fail();
          return decodeFunctionResult({ abi, functionName, data: raw as Hex });
        };
        const [chain, genesis, deployment, runtime, rendererCode, renderer, identity, profile, signer, domain] = await Promise.all([
          call("eth_chainId", []), call("eth_getBlockByNumber", ["0x0", false]).then(header),
          call("eth_getBlockByNumber", [`0x${c.deploymentBlock.number.toString(16)}`, false]).then(header),
          call("eth_getCode", [c.contract, block]), call("eth_getCode", [c.generativeRenderer!.address, block]),
          read("renderer"), read("rendererIdentity"), read("INPUT_PROFILE"), read("trustedAuthorizer"), read("eip712Domain"),
        ]);
        if (quantity(chain) !== `0x${c.chainId.toString(16)}` || genesis.number !== "0x0" || genesis.hash !== c.genesisHash
          || BigInt(deployment.number) !== c.deploymentBlock.number || deployment.hash !== c.deploymentBlock.hash) fail();
        for (const [code, expected] of [[runtime, c.runtimeCodeHash], [rendererCode, c.generativeRenderer!.runtimeCodeHash]]) {
          if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2}){1,24576}$/.test(code) || keccak256(code as Hex) !== expected) fail();
        }
        if (renderer !== getAddress(c.generativeRenderer!.address) || identity !== c.generativeRenderer!.identity || profile !== profileForRenderer(c.generativeRenderer!).inputProfile || signer !== getAddress(c.authorizer)
          || !Array.isArray(domain) || domain.length !== 7 || domain[0] !== "0x0f" || domain[1] !== profileForRenderer(c.generativeRenderer!).domainName || domain[2] !== "1" || domain[3] !== c.chainId
          || domain[4] !== getAddress(c.contract) || domain[5] !== `0x${"0".repeat(64)}` || !Array.isArray(domain[6]) || domain[6].length) fail();
        let nonce: Hex | undefined;
        if (recipient) {
          const [accountCode, atBlock, latest, pending] = await Promise.all([call("eth_getCode", [recipient, block]),
            ...[block, "latest", "pending"].map(tag => call("eth_getTransactionCount", [recipient, tag]).then(quantity))]);
          if (accountCode !== "0x" || atBlock !== latest || latest !== pending) fail();
          nonce = quantity(pending);
        }
        if (!same(header(await call("eth_getBlockByNumber", [observed.number, false])), observed)
          || !same(header(await call("eth_getBlockByNumber", ["latest", false])), observed) || await call("eth_chainId", []) !== chain) fail();
        return { ...observed, nonce };
      }));
      check(); if (!same(observations[0], observations[1])) fail();
      const first = observations[0], time = Number(BigInt(first.timestamp)) * 1000, now = Date.now();
      if (!Number.isSafeInteger(time) || now - time >= c.maxBlockAgeMs || time - now > c.maxFutureSkewMs) fail();
      return { chainId: `0x${c.chainId.toString(16)}` as Hex, contract: getAddress(c.contract), blockNumber: first.number, blockHash: first.hash,
        ...(first.nonce ? { nonce: first.nonce } : {}) };
    };
    try { return await Promise.race([work(), stopped]); } catch { return fail(); }
    finally { clearTimeout(timer); controller.abort(); if (abort) signal.removeEventListener("abort", abort); }
  }
}
