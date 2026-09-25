import { performance } from "node:perf_hooks";
import { getAddress, type Hex } from "viem";
import { createStagingEligibilityReader, readPublicChainEligibility, type PublicChainGateConfig } from "./publicChain.js";
import type { PublicChainRpc } from "./publicChainRpc.js";
import type { AuthorizationReservation } from "./persistence/generativeAuthorizations.js";

export class StagingRecoveryChainError extends Error {
  constructor() { super("Fresh Sepolia retirement proof unavailable; preserve the authorization."); this.name = "StagingRecoveryChainError"; }
}
const fail = (): never => { throw new StagingRecoveryChainError(); };
const same = (a: unknown,b: unknown) => JSON.stringify(a) === JSON.stringify(b);
interface Anchor { readonly number: string; readonly hash: Hex; readonly timestamp: string }
function anchor(value: unknown): Anchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value as Record<string, unknown>;
  if (typeof v.number !== "string" || typeof v.timestamp !== "string"
    || !/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(v.number)
    || !/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(v.timestamp)
    || typeof v.hash !== "string" || !/^0x(?!0{64}$)[0-9a-f]{64}$/.test(v.hash)
    || BigInt(v.timestamp as string)>BigInt(Math.floor(Number.MAX_SAFE_INTEGER/1000))) fail();
  return Object.freeze({number:BigInt(v.number as string).toString(),hash:v.hash as Hex,timestamp:BigInt(v.timestamp as string).toString()});
}
export interface ActiveRecoveryReport {
  readonly policySha256: string; readonly planSha256: string; readonly releaseLockSha256: string;
  readonly chainId: number; readonly origin: string; readonly observedAt: number; readonly validUntil: number;
  readonly state: { readonly paused: boolean; readonly authorizer: string };
  readonly finalized: { readonly number:string; readonly hash:string; readonly timestamp:string };
  readonly latest: { readonly number:string; readonly hash:string; readonly timestamp:string };
  readonly observationSha256: string;
  readonly collectionRuntimeCodeHash: string;
  readonly genesis: {readonly hash:string};
  readonly deployment: {readonly collection:{readonly blockNumber:string;readonly blockHash:string}};
}
export interface ActiveRecoveryReader {
  observe(signal: AbortSignal): Promise<unknown>;
  read(witness: unknown, now: number): ActiveRecoveryReport;
}
interface RecoveryChainPolicy {
  activePolicyDigest:string;planSha256:string;releaseLockSha256:string;operatingPlanSha256:string;databaseBinding:string;
  maxFinalizedAgeMs:number;maxHeadAgeMs:number;
}
export interface StagingRecoveryEvidence {
  readonly version: "sg-staging-expired-unminted-v1"; readonly authorizationId: string;
  readonly authorizationDigest: string; readonly namespaceId: string; readonly deploymentId: string;
  readonly finalized: Anchor; readonly latest: Anchor; readonly observedAt:number; readonly validUntil:number;
  readonly sources: readonly [string,string]; readonly config: Readonly<PublicChainGateConfig>;
  readonly activePolicyDigest: string; readonly activeObservationDigest: string;
  readonly maxFinalizedAgeMs: number; readonly maxHeadAgeMs: number;
}
declare const brand: unique symbol;
export interface StagingRecoveryWitness { readonly [brand]: true }
const witnesses = new WeakMap<StagingRecoveryWitness,StagingRecoveryEvidence>();
const witnessMonotonicDeadlines = new WeakMap<StagingRecoveryWitness,number>();
function binding(r: AuthorizationReservation,c: PublicChainGateConfig) {
  if (r.version !== "sg-generative-authorization-v1-rc1" || c.contractProfile !== "generative-v1-rc1"
    || c.chainId !== 11155111n || r.domain.chainId !== "11155111"
    || r.namespaceId !== c.namespaceId || r.deploymentId !== c.deploymentId
    || getAddress(r.domain.verifyingContract) !== getAddress(c.contract)
    || getAddress(r.authorizer) !== getAddress(c.authorizer)
    || r.rendererIdentity !== c.generativeRenderer?.identity
    || !/^[1-9]\d{0,15}$/.test(r.authorization.deadline)) fail();
}
/** Process-local witness, not an exportable approval or serialized report. */
export function readStagingRecoveryEvidence(witness: unknown,r:AuthorizationReservation,now:number):StagingRecoveryEvidence {
  const e = witness && typeof witness === "object" ? witnesses.get(witness as StagingRecoveryWitness) : undefined;
  if (!e || !Number.isSafeInteger(now) || now<e.observedAt || now>=e.validUntil
    || performance.now() >= (witnessMonotonicDeadlines.get(witness as StagingRecoveryWitness) ?? -1)
    || now-Number(e.finalized.timestamp)*1000>=e.maxFinalizedAgeMs
    || now-Number(e.latest.timestamp)*1000>=e.maxHeadAgeMs
    || e.authorizationId!==r.id || e.authorizationDigest!==r.digest
    || BigInt(e.finalized.timestamp)<=BigInt(r.authorization.deadline)
    || BigInt(now)<=BigInt(r.authorization.deadline)*1000n) fail();
  binding(r,e!.config); return e!;
}

/** Only exact reviewed Sepolia RC1, with independent head/finalized age bounds.
 * Caller must supply the real active-state observer bound to declared history. */
export class StagingRecoveryChain {
  readonly config: Readonly<PublicChainGateConfig>;
  readonly #sources: readonly [PublicChainRpc,PublicChainRpc];
  readonly #latest: ReturnType<typeof createStagingEligibilityReader>;
  readonly #finalized: ReturnType<typeof createStagingEligibilityReader>;
  readonly #active: ActiveRecoveryReader;
  readonly #policy: Readonly<RecoveryChainPolicy>;
  get policyDigest() { return this.#policy.activePolicyDigest; }
  get databaseBinding() { return this.#policy.databaseBinding; }
  get operatingPlanSha256() { return this.#policy.operatingPlanSha256; }
  get releaseLockSha256() { return this.#policy.releaseLockSha256; }
  constructor(config:PublicChainGateConfig,sources:readonly [PublicChainRpc,PublicChainRpc],active:ActiveRecoveryReader,
    policy:RecoveryChainPolicy) {
    config=structuredClone(config);
    if (config.chainId!==11155111n || config.contractProfile!=="generative-v1-rc1"
      || !/^[0-9a-f]{64}$/.test(policy.activePolicyDigest)
      || !/^[0-9a-f]{64}$/.test(policy.planSha256) || !/^[0-9a-f]{64}$/.test(policy.releaseLockSha256)
      || !/^[0-9a-f]{64}$/.test(policy.operatingPlanSha256) || !/^[0-9a-f]{64}$/.test(policy.databaseBinding)
      || !Number.isSafeInteger(policy.maxHeadAgeMs) || policy.maxHeadAgeMs<1000 || policy.maxHeadAgeMs>300000
      || !Number.isSafeInteger(policy.maxFinalizedAgeMs) || policy.maxFinalizedAgeMs<policy.maxHeadAgeMs || policy.maxFinalizedAgeMs>3600000
      || config.maxBlockAgeMs!==policy.maxHeadAgeMs || !active || typeof active.observe!=="function" || typeof active.read!=="function") fail();
    this.#latest=createStagingEligibilityReader(config,sources);
    this.#finalized=createStagingEligibilityReader({...config,maxBlockAgeMs:policy.maxFinalizedAgeMs},sources);
    Object.freeze(config.deploymentBlock);Object.freeze(config.generativeRenderer);
    this.config=Object.freeze(config); this.#sources=Object.freeze(sources.map(s=>Object.freeze({id:s.id,request:s.request.bind(s)}))) as unknown as readonly [PublicChainRpc,PublicChainRpc];
    this.#active=Object.freeze({observe:active.observe.bind(active),read:active.read.bind(active)}); this.#policy=Object.freeze({...policy});
  }
  async observe(input:AuthorizationReservation,signal:AbortSignal):Promise<StagingRecoveryWitness> {
    const r=structuredClone(input),c=this.config,started=Date.now(),until=performance.now()+c.observationTimeoutMs;
    const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
    const check=()=>{if(signal.aborted||controller.signal.aborted||performance.now()>=until)fail();};
    const stopped=new Promise<never>((_,reject)=>{abort=()=>{controller.abort();reject(new StagingRecoveryChainError());};
      timer=setTimeout(abort,c.observationTimeoutMs);signal.addEventListener("abort",abort,{once:true});});
    const heads=async()=>{
      check(); const values=await Promise.all(this.#sources.map(async s=>{
        const [f,l]=await Promise.all(["finalized","latest"].map(async tag=>anchor(await s.request("eth_getBlockByNumber",[tag,false],controller.signal))));
        return {finalized:f,latest:l};
      }));check();if(!same(values[0],values[1]))fail();return values[0];
    };
    try {return await Promise.race([(async()=>{
      check();binding(r,c);
      const activeWitness=await this.#active.observe(controller.signal);check();
      const state=this.#active.read(activeWitness,Date.now());
      if(state.policySha256!==this.#policy.activePolicyDigest || state.planSha256!==this.#policy.planSha256
        || state.releaseLockSha256!==this.#policy.releaseLockSha256 || state.chainId!==11155111
        || state.origin!=="https://staging.signatures.gallery" || state.state.paused
        || state.genesis.hash!==c.genesisHash || state.collectionRuntimeCodeHash!==c.runtimeCodeHash
        || BigInt(state.deployment.collection.blockNumber)!==c.deploymentBlock.number
        || state.deployment.collection.blockHash!==c.deploymentBlock.hash
        || getAddress(state.state.authorizer)!==getAddress(c.authorizer))fail();
      const h=await heads();
      if(!same(anchor(state.finalized),h.finalized)||!same(anchor(state.latest),h.latest)
        || BigInt(h.finalized.number)<c.deploymentBlock.number || BigInt(h.latest.number)<BigInt(h.finalized.number)
        || BigInt(h.latest.timestamp)<BigInt(h.finalized.timestamp)
        || BigInt(h.finalized.timestamp)<=BigInt(r.authorization.deadline))fail();
      const now=Date.now();
      for(const [block,age] of [[h.finalized,this.#policy.maxFinalizedAgeMs],[h.latest,this.#policy.maxHeadAgeMs]] as const)
        if(now-Number(block.timestamp)*1000>=age || Number(block.timestamp)*1000-now>c.maxFutureSkewMs)fail();
      const readings=await Promise.all([h.finalized,h.latest].map(async(block,i)=>{
        const reader=i===0?this.#finalized:this.#latest;
        const w=await reader.preflight({block:{number:BigInt(block.number),hash:block.hash},handle:r.handle,
          recipient:r.authorization.recipient,nonce:r.authorization.nonce,signal:controller.signal});
        const e=readPublicChainEligibility(w,{namespaceId:r.namespaceId,deploymentId:r.deploymentId,handle:r.handle,
          recipient:r.authorization.recipient,nonce:r.authorization.nonce,now:Date.now()});
        if(e.block.timestamp.toString()!==block.timestamp)fail();return e;
      }));
      if(!same(await heads(),h))fail();
      const again=this.#active.read(activeWitness,Date.now());
      if(again.observationSha256!==state.observationSha256 || !same(anchor(again.finalized),h.finalized)
        || !same(anchor(again.latest),h.latest))fail();
      check();const e:StagingRecoveryEvidence=Object.freeze({version:"sg-staging-expired-unminted-v1",authorizationId:r.id,
        authorizationDigest:r.digest,namespaceId:r.namespaceId,deploymentId:r.deploymentId,...h,observedAt:started,
        validUntil:Math.min(started+c.evidenceTtlMs,state.validUntil,...readings.map(v=>v.validUntil)),
        sources:Object.freeze(this.#sources.map(s=>s.id)) as readonly [string,string],config:c,
        activePolicyDigest:this.#policy.activePolicyDigest,activeObservationDigest:state.observationSha256,
        maxFinalizedAgeMs:this.#policy.maxFinalizedAgeMs,maxHeadAgeMs:this.#policy.maxHeadAgeMs});
      const witness=Object.freeze({}) as StagingRecoveryWitness;
      witnesses.set(witness,e);
      witnessMonotonicDeadlines.set(witness,performance.now()+Math.max(0,e.validUntil-Date.now()));
      readStagingRecoveryEvidence(witness,r,Date.now());return witness;
    })(),stopped]);}catch{return fail();}finally{clearTimeout(timer);controller.abort();if(abort)signal.removeEventListener("abort",abort);}
  }
}
