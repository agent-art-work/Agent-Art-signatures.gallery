import { isGenerativeProfile, profileForReservation } from "./generativeProfiles.js";
import { performance } from "node:perf_hooks";
import { getAddress, type Hex } from "viem";
import { PublicChainGate, readPublicChainEligibility, type PublicChainGateConfig } from "./publicChain.js";
import type { PublicChainRpc } from "./publicChainRpc.js";
import type { AuthorizationReservation } from "./persistence/generativeAuthorizations.js";

interface Anchor { readonly number: string; readonly hash: Hex; readonly timestamp: string }
export interface GenerativeRecoveryEvidence {
  readonly version: "generative-expired-unminted-v1";
  readonly authorizationId: string; readonly authorizationDigest: Hex;
  readonly namespaceId: string; readonly deploymentId: string;
  readonly finalized: Anchor; readonly latest: Anchor;
  readonly observedAt: number; readonly validUntil: number;
  readonly sources: readonly [string, string];
  readonly config: Readonly<PublicChainGateConfig>;
}
declare const brand: unique symbol;
export interface GenerativeRecoveryWitness { readonly [brand]: true }
const witnesses = new WeakMap<GenerativeRecoveryWitness, GenerativeRecoveryEvidence>();
export class GenerativeRecoveryBlockedError extends Error {
  constructor(message = "Recovery cannot be verified. Preserve the reservation and investigate; do not resubmit.") { super(message); }
}
const fail = (): never => { throw new GenerativeRecoveryBlockedError(); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function header(raw: unknown): Anchor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const r = raw as Record<string, unknown>;
  for (const key of ["number", "timestamp"]) if (typeof r[key] !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]{0,13})$/.test(r[key] as string)
    || BigInt(r[key] as string) > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))) fail();
  if (typeof r.hash !== "string" || !/^0x[0-9a-f]{64}$/.test(r.hash) || /^0x0{64}$/.test(r.hash)) return fail();
  return Object.freeze({ number: BigInt(r.number as string).toString(), hash: r.hash as Hex, timestamp: BigInt(r.timestamp as string).toString() });
}
function binding(r: AuthorizationReservation, c: PublicChainGateConfig) {
  if (profileForReservation(r.version).contractProfile !== c.contractProfile || r.namespaceId !== c.namespaceId || r.deploymentId !== c.deploymentId || r.domain.chainId !== c.chainId.toString()
    || getAddress(r.domain.verifyingContract) !== getAddress(c.contract) || getAddress(r.authorizer) !== getAddress(c.authorizer)
    || r.rendererIdentity !== c.generativeRenderer?.identity || !/^[1-9][0-9]{0,15}$/.test(r.authorization.deadline)) fail();
}
/** Opaque, process-local evidence. A JSON report, receipt, missing tx, wallet
 * rejection, consumed EOA nonce, or wall-clock expiry is never authority. */
export function readGenerativeRecoveryEvidence(witness: unknown, reservation: AuthorizationReservation, now: number): GenerativeRecoveryEvidence {
  const e = witness && typeof witness === "object" ? witnesses.get(witness as GenerativeRecoveryWitness) : undefined;
  if (!e || !Number.isSafeInteger(now) || now < e.observedAt || now >= e.validUntil
    || e.authorizationId !== reservation.id || e.authorizationDigest !== reservation.digest
    || BigInt(e.finalized.timestamp) <= BigInt(reservation.authorization.deadline)
    || BigInt(now) <= BigInt(reservation.authorization.deadline) * 1000n) return fail();
  binding(reservation, e.config);
  return e;
}

/** Conservative, read-only and local-only. Both sources must prove finalized
 * expiry AND unminted/unused authority at finalized and latest canonical heads.
 * A revoked nonce, paused contract or any ambiguity remains blocked for review.
 * No fixed-block/elapsed-time finality fallback, RPC mutation or retry exists. */
export class GenerativeRecoveryChain {
  readonly config: Readonly<PublicChainGateConfig>;
  readonly #sources: readonly [PublicChainRpc, PublicChainRpc];
  readonly #gate: PublicChainGate;
  constructor(config: PublicChainGateConfig, sources: readonly [PublicChainRpc, PublicChainRpc]) {
    this.#gate = new PublicChainGate(config, sources);
    if (config.chainId !== 31337n || !isGenerativeProfile(config.contractProfile)) fail();
    this.config = Object.freeze({ ...structuredClone(config), deploymentBlock: Object.freeze({ ...config.deploymentBlock }),
      generativeRenderer: Object.freeze({ ...config.generativeRenderer! }) });
    this.#sources = Object.freeze(sources.map(s => Object.freeze({ id: s.id, request: s.request.bind(s) }))) as unknown as readonly [PublicChainRpc, PublicChainRpc];
  }
  async observe(input: AuthorizationReservation, signal: AbortSignal): Promise<GenerativeRecoveryWitness> {
    const r = structuredClone(input), c = this.config, started = Date.now(), until = performance.now() + c.observationTimeoutMs;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const check = () => { if (signal.aborted || controller.signal.aborted || performance.now() >= until) fail(); };
    const stopped = new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); reject(new GenerativeRecoveryBlockedError()); };
      timer = setTimeout(abort, c.observationTimeoutMs); signal.addEventListener("abort", abort, { once: true });
    });
    const heads = async () => {
      check();
      const values = await Promise.all(this.#sources.map(async s => {
        const [finalized, latest] = await Promise.all(["finalized", "latest"].map(async tag => header(await s.request("eth_getBlockByNumber", [tag, false], controller.signal))));
        return { finalized, latest };
      }));
      check(); if (!same(values[0], values[1])) fail();
      return values[0];
    };
    try {
      return await Promise.race([(async () => {
        check(); binding(r, c);
        const anchors = await heads();
        if (BigInt(anchors.finalized.number) < c.deploymentBlock.number || BigInt(anchors.latest.number) < BigInt(anchors.finalized.number)
          || BigInt(anchors.latest.timestamp) < BigInt(anchors.finalized.timestamp)
          || BigInt(anchors.finalized.timestamp) <= BigInt(r.authorization.deadline)) fail();
        const observed = await Promise.all([anchors.finalized, anchors.latest].map(async block => {
          const witness = await this.#gate.preflight({ block: { number: BigInt(block.number), hash: block.hash }, handle: r.handle,
            recipient: r.authorization.recipient, nonce: r.authorization.nonce, signal: controller.signal });
          const evidence = readPublicChainEligibility(witness, { namespaceId: r.namespaceId, deploymentId: r.deploymentId,
            handle: r.handle, recipient: r.authorization.recipient, nonce: r.authorization.nonce, now: Date.now() });
          if (evidence.block.timestamp.toString() !== block.timestamp) fail();
          return evidence;
        }));
        if (!same(await heads(), anchors)) fail();
        check();
        const value: GenerativeRecoveryEvidence = Object.freeze({ version: "generative-expired-unminted-v1", authorizationId: r.id,
          authorizationDigest: r.digest, namespaceId: r.namespaceId, deploymentId: r.deploymentId, ...anchors, observedAt: started,
          validUntil: Math.min(started + c.evidenceTtlMs, ...observed.map(e => e.validUntil)),
          sources: Object.freeze(this.#sources.map(s => s.id)) as readonly [string, string], config: c });
        const witness = Object.freeze({}) as GenerativeRecoveryWitness;
        witnesses.set(witness, value); readGenerativeRecoveryEvidence(witness, r, Date.now());
        return witness;
      })(), stopped]);
    } catch { return fail(); }
    finally { clearTimeout(timer); controller.abort(); if (abort) signal.removeEventListener("abort", abort); }
  }
}
