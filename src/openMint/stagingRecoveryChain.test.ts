import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { openMintHandleKey } from "./authorization.js";
import { generativeInputDigest } from "./generativeInputs.js";
import { chainHash, eligibilityFixture, fixturePinForProfile } from "./persistence/fixtures/eligibility.js";
import type { AuthorizationReservation } from "./persistence/generativeAuthorizations.js";
import { StagingRecoveryChain, readStagingRecoveryEvidence, type ActiveRecoveryReader } from "./stagingRecoveryChain.js";
import type { PublicChainRpc } from "./publicChainRpc.js";
import { PUBLIC_CHAIN_READ_ABI } from "./publicChain.js";
import { GENERATIVE_MINT_ABI } from "./generativeAuthorization.js";

function fixture() {
  const clock=Math.floor(Date.now()/1000)*1000,now=()=>clock;
  const base=eligibilityFixture(randomUUID(),randomUUID(),now),pin=fixturePinForProfile("generative-v1-rc1");
  const config={...base.config,chainId:11155111n,contractProfile:"generative-v1-rc1" as const,generativeRenderer:pin,
    maxBlockAgeMs:120000,observationTimeoutMs:1000};
  const deadline=String(Math.floor(clock/1000)-10),recipient="0x5555555555555555555555555555555555555555" as const;
  const authorization={handleKey:openMintHandleKey("alice"),assessmentDigest:chainHash("44"),
    inputDigest:generativeInputDigest("Alice","INTJ",pin.identity,pin.inputProfile),recipient,nonce:chainHash("33"),
    issuedAt:String(Number(deadline)-60),deadline};
  const reservation:AuthorizationReservation={version:"sg-generative-authorization-v1-rc1",id:randomUUID(),namespaceId:config.namespaceId,
    deploymentId:config.deploymentId,requestId:randomUUID(),sessionHash:"0".repeat(64),generation:"1",handle:"alice",assessmentId:randomUUID(),
    renderHandle:"Alice",mbti:"INTJ",rendererIdentity:pin.identity,authorizer:config.authorizer,
    domain:{chainId:"11155111",verifyingContract:config.contract},authorization,digest:chainHash("55"),typedData:{}};
  const raw=base.sources(config),calls:string[]=[];
  const sources=raw.map(r=>({id:r.id,async request(method:Parameters<PublicChainRpc["request"]>[0],
    params:Parameters<PublicChainRpc["request"]>[1],signal:Parameters<PublicChainRpc["request"]>[2]){
    calls.push(method);
    return r.request(method,method==="eth_getBlockByNumber"&&params[0]==="finalized"?["0xa",false]:params,signal);
  }})) as unknown as readonly [PublicChainRpc,PublicChainRpc];
  const block={number:"0xa",hash:chainHash("10"),timestamp:`0x${BigInt(clock/1000).toString(16)}`};
  const report={policySha256:"a".repeat(64),planSha256:"b".repeat(64),releaseLockSha256:"c".repeat(64),
    chainId:11155111,origin:"https://staging.signatures.gallery",observedAt:clock-1000,validUntil:clock+10000,
    state:{paused:false,authorizer:config.authorizer},finalized:block,latest:block,observationSha256:"d".repeat(64),
    collectionRuntimeCodeHash:config.runtimeCodeHash,genesis:{hash:config.genesisHash},
    deployment:{collection:{blockNumber:"0x2",blockHash:config.deploymentBlock.hash}}};
  const active:ActiveRecoveryReader={observe:vi.fn(async()=>Object.freeze({})),read:vi.fn(()=>report)};
  const policy={activePolicyDigest:report.policySha256,planSha256:report.planSha256,releaseLockSha256:report.releaseLockSha256,
    operatingPlanSha256:"e".repeat(64),databaseBinding:"f".repeat(64),
    maxFinalizedAgeMs:1800000,maxHeadAgeMs:120000};
  return {config,reservation,sources,active,report,policy,calls};
}
afterEach(()=>vi.restoreAllMocks());
describe("staging retirement proof",()=>{
  it("accepts a realistically older finalized block without widening latest freshness",async()=>{
    const f=fixture(),old={number:"0x9",hash:chainHash("09"),timestamp:`0x${(BigInt(f.report.latest.timestamp)-900n).toString(16)}`};
    f.report.finalized=old;f.reservation.authorization.deadline=(BigInt(old.timestamp)-1n).toString();
    const sources=f.sources.map(source=>({id:source.id,async request(method:Parameters<PublicChainRpc["request"]>[0],
      params:Parameters<PublicChainRpc["request"]>[1],signal:Parameters<PublicChainRpc["request"]>[2]){
      if(method==="eth_getBlockByNumber"&&["finalized","0x9"].includes(params[0] as string))return old;
      return source.request(method,params,signal);
    }})) as unknown as readonly [PublicChainRpc,PublicChainRpc];
    await expect(new StagingRecoveryChain(f.config,sources,f.active,f.policy).observe(f.reservation,new AbortController().signal)).resolves.toBeDefined();
    await expect(new StagingRecoveryChain(f.config,sources,f.active,{...f.policy,maxFinalizedAgeMs:f.policy.maxHeadAgeMs})
      .observe(f.reservation,new AbortController().signal)).rejects.toThrow();
  });
  it("captures nested configuration and rejects a stalled source within its deadline",async()=>{
    const f=fixture(),supplied=structuredClone(f.config),chain=new StagingRecoveryChain(supplied,f.sources,f.active,f.policy);
    Object.assign(supplied.deploymentBlock,{hash:chainHash("97")});supplied.generativeRenderer.identity=chainHash("96");
    await expect(chain.observe(f.reservation,new AbortController().signal)).resolves.toBeDefined();
    const stalled=fixture();stalled.config.observationTimeoutMs=50;
    const sources=stalled.sources.map(s=>({id:s.id,request:async()=>new Promise(()=>{})})) as unknown as readonly [PublicChainRpc,PublicChainRpc];
    await expect(new StagingRecoveryChain(stalled.config,sources,stalled.active,stalled.policy)
      .observe(stalled.reservation,new AbortController().signal)).rejects.toThrow();
  });
  it("is process-local, exact, read-only and independently bounds finalized/head",async()=>{
    const f=fixture(),chain=new StagingRecoveryChain(f.config,f.sources,f.active,f.policy);
    const witness=await chain.observe(f.reservation,new AbortController().signal);
    const value=readStagingRecoveryEvidence(witness,f.reservation,Date.now());
    expect(value).toMatchObject({version:"sg-staging-expired-unminted-v1",maxFinalizedAgeMs:1800000,maxHeadAgeMs:120000});
    expect(f.calls.every(method=>method.startsWith("eth_")&&!/send|sign/i.test(method))).toBe(true);
    expect(()=>readStagingRecoveryEvidence({},f.reservation,Date.now())).toThrow();
    expect(()=>readStagingRecoveryEvidence(witness,{...f.reservation,id:randomUUID()},Date.now())).toThrow();
    expect(()=>readStagingRecoveryEvidence(witness,f.reservation,value.validUntil)).toThrow();
    const elapsed=performance.now();
    vi.spyOn(performance,"now").mockReturnValue(elapsed+1_000_000);
    expect(()=>readStagingRecoveryEvidence(witness,f.reservation,Date.now())).toThrow();
  });
  it.each(["paused","wrong-authorizer","wrong-genesis","wrong-code","wrong-deployment","wrong-domain","wrong-renderer","wrong-head","deadline-equal","cancelled"])("blocks %s",async scenario=>{
    const f=fixture();
    if(scenario==="paused")f.report.state.paused=true;
    if(scenario==="wrong-authorizer")f.report.state.authorizer=f.config.contract;
    if(scenario==="wrong-genesis")f.report.genesis.hash=chainHash("91");
    if(scenario==="wrong-code")f.report.collectionRuntimeCodeHash=chainHash("92");
    if(scenario==="wrong-deployment")f.report.deployment.collection.blockHash=chainHash("93");
    if(scenario==="wrong-domain")f.reservation={...f.reservation,domain:{...f.reservation.domain,verifyingContract:f.config.authorizer}};
    if(scenario==="wrong-renderer")f.reservation={...f.reservation,rendererIdentity:chainHash("94")};
    if(scenario==="wrong-head")f.report.latest.hash=chainHash("77");
    if(scenario==="deadline-equal")f.reservation.authorization.deadline=BigInt(f.report.finalized.timestamp).toString();
    const signal=new AbortController();if(scenario==="cancelled")signal.abort();
    await expect(new StagingRecoveryChain(f.config,f.sources,f.active,f.policy).observe(f.reservation,signal.signal)).rejects.toThrow();
  });
  it.each(["wrong-network","source-disagreement","minted-handle","used-nonce","revoked-nonce","stale-finalized"])(
    "rejects %s without producing an exportable witness",async scenario=>{
      const f=fixture(),abi=[...PUBLIC_CHAIN_READ_ABI,...GENERATIVE_MINT_ABI];
      const sources=f.sources.map((source,index)=>({id:source.id,async request(method:Parameters<PublicChainRpc["request"]>[0],
        params:Parameters<PublicChainRpc["request"]>[1],signal:Parameters<PublicChainRpc["request"]>[2]){
        const value=await source.request(method,params,signal);
        if(scenario==="wrong-network"&&method==="eth_chainId")return "0x1";
        if(scenario==="source-disagreement"&&index===1&&method==="eth_getBlockByNumber"&&params[0]==="latest")
          return {...value as Record<string,unknown>,hash:chainHash("88")};
        if(scenario==="stale-finalized"&&method==="eth_getBlockByNumber"&&params[0]==="finalized")
          return {...value as Record<string,unknown>,timestamp:`0x${BigInt(Math.floor(Date.now()/1000)-1900).toString(16)}`};
        if(method==="eth_call"&&["minted-handle","used-nonce","revoked-nonce"].includes(scenario)){
          const {functionName}=decodeFunctionData({abi,data:(params[0] as {data:`0x${string}`}).data});
          if(functionName==={"minted-handle":"mintedHandle","used-nonce":"usedNonces","revoked-nonce":"revokedNonces"}[scenario])
            return encodeFunctionResult({abi,functionName,result:true});
        }
        return value;
      }})) as unknown as readonly [PublicChainRpc,PublicChainRpc];
      await expect(new StagingRecoveryChain(f.config,sources,f.active,f.policy)
        .observe(f.reservation,new AbortController().signal)).rejects.toThrow();
    });
});
