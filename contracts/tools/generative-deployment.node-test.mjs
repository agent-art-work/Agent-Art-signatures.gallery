import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeFunctionResult, keccak256, stringToHex } from "viem";
import { createDeploymentObserver, expectedCollectionRuntime, readDeploymentObservation, SEPOLIA_GENESIS,
  verifyCreationTransaction } from "./generative-deployment.mjs";
import { deploymentFixture } from "./fixtures/generative-deployment.mjs";
const fail = /Deployment verification failed/;
const h = s => keccak256(stringToHex(s));
const zero = "0x"+"00".repeat(32), zeroAddress = "0x"+"00".repeat(20);
const run = f => createDeploymentObserver(f).observe();
const report = (f,w) => readDeploymentObservation(w,{planSha256:f.plan.planSha256,now:f.now()});

test("zero future-skew allowance remains valid and rejects future blocks", async () => {
  const f = await deploymentFixture(); f.policy.maxFutureSkewMs = 0;
  await run(f);
  f.mutate((m,p,v) => m === "eth_getBlockByNumber" && p[0] === "latest" ? { ...v, timestamp: "0x" + BigInt(f.now()/1000+1).toString(16) } : v);
  await assert.rejects(run(f), fail);
});

test("two pinned sources observe the exact pristine paused deployment, never activation authority", async () => {
  const f = await deploymentFixture(), w = await run(f), r = report(f,w);
  assert.equal(r.status,"observed-paused-not-admitted"); assert.equal(r.genesis.hash,SEPOLIA_GENESIS);
  assert.equal(r.collectionRuntimeCodeHash,keccak256(f.runtime));
  assert.equal(r.requestCount,118); assert.equal(f.requests.length,236);
  for(const field of ["runtimeAdmissionAllowed","activationAllowed","publicBroadcastAllowed","readLimitsValidated","custodyVerified"]) assert.equal(r[field],false);
  assert.equal(r.sourceIndependence,"operator-declared-not-proven"); assert.ok(Object.isFrozen(r.deployment));
  assert.ok(f.requests.every(r=>/^eth_(?:chainId|getBlockByNumber|getCode|call|getLogs|getTransactionReceipt|getTransactionByHash)$/.test(r.method)));
  for(const r of f.requests.filter(r=>["eth_call","eth_getCode"].includes(r.method))) {
    assert.deepEqual(Object.keys(r.params[1]).sort(),["blockHash","requireCanonical"]);
    assert.equal(r.params[1].requireCanonical,true);
  }
  for(const forged of [r,{},JSON.parse(JSON.stringify(w)),undefined,1]) assert.throws(()=>report(f,forged),/absent/);
  assert.throws(()=>readDeploymentObservation(w,{planSha256:"wrong",now:f.now()}),/another plan/);
  assert.throws(()=>readDeploymentObservation(w,{planSha256:f.plan.planSha256,now:r.observedAt-1}),/stale/);
  f.advance(15000); assert.throws(()=>report(f,w),/stale/);
});
for(const [name,mutate] of [
  ["local genesis",f=>{f.config.genesisHash=h("Anvil");}],
  ["mainnet",f=>{f.config.chainId=1;}],
  ["missing transaction",f=>{delete f.transactions.renderer;}],
  ["extra authority field",f=>{f.transactions.approved=true;}],
  ["same transaction",f=>{f.transactions.collection=f.transactions.renderer;}],
  ["no timeout",f=>{f.policy.timeoutMs=0;}],["unbounded timeout",f=>{f.policy.timeoutMs=30001;}],
  ["negative future skew",f=>{f.policy.maxFutureSkewMs=-1;}],
  ["long freshness",f=>{f.policy.validityMs=30001;}],["unbounded range",f=>{f.policy.maxDeploymentSpan=513;}],
  ["NaN policy",f=>{f.policy.maxHeadAgeMs=NaN;}],["extra policy",f=>{f.policy.approved=true;}],
  ["same source object",f=>{f.sources[1]=f.sources[0];}],
  ["same source function",f=>{f.sources[1].request=f.sources[0].request;}],
  ["same provider",f=>{f.sources[1].operatorReference=f.sources[0].operatorReference;}],
  ["same source ID",f=>{f.sources[1].id=f.sources[0].id;}],
  ["secret in source config",f=>{f.sources[0].privateKey="never accepted";}],
]) test("rejects "+name+" before any RPC request", async()=>{
  const f=await deploymentFixture();mutate(f);assert.throws(()=>createDeploymentObserver(f));assert.equal(f.requests.length,0);
});
for(const [name,mutate] of [
  ["wrong chain",(m,p,v)=>m==="eth_chainId"?"0x1":v],
  ["wrong genesis",(m,p,v)=>m==="eth_getBlockByNumber"&&p[0]==="0x0"?{...v,hash:h("not Sepolia")}:v],
  ["missing finalized tag",(m,p,v)=>m==="eth_getBlockByNumber"&&p[0]==="finalized"?null:v],
  ["stale latest",(m,p,v)=>m==="eth_getBlockByNumber"&&p[0]==="latest"?{...v,timestamp:"0x1"}:v],
  ["future latest",(m,p,v)=>m==="eth_getBlockByNumber"&&p[0]==="latest"?{...v,timestamp:"0x7fffffffffff"}:v],
  ["finalized beyond latest",(m,p,v)=>m==="eth_getBlockByNumber"&&p[0]==="finalized"?{...v,number:"0x5"}:v],
  ["wrong transaction-list entry",(m,p,v)=>m==="eth_getBlockByNumber"&&p[0]==="0x1"?{...v,transactions:[h("not tx")]}:v],
  ["absent receipt",(m,p,v)=>m==="eth_getTransactionReceipt"?null:v],
  ["failed receipt",(m,p,v)=>m==="eth_getTransactionReceipt"?{...v,status:"0x0"}:v],
  ["unfinalized receipt",(m,p,v)=>m==="eth_getTransactionReceipt"?{...v,blockNumber:"0x4"}:v],
  ["wrong receipt destination",(m,p,v)=>m==="eth_getTransactionReceipt"?{...v,contractAddress:zeroAddress}:v],
  ["reorged receipt",(m,p,v)=>m==="eth_getTransactionReceipt"?{...v,blockHash:h("reorg")}:v],
  ["removed log",(m,p,v)=>m==="eth_getLogs"?v.map(r=>({...r,removed:true})):v],
  ["missing role event",(m,p,v)=>m==="eth_getLogs"?v.slice(1):v],
  ["extra later event",(m,p,v)=>m==="eth_getLogs"?[...v,{...v[0],logIndex:"0x6"}]:v],
  ["reordered events",(m,p,v)=>m==="eth_getLogs"?v.reverse():v],
  ["oversized logs",(m,p,v)=>m==="eth_getLogs"?Array(2049).fill(v[0]):v],
  ["missing runtime",(m,p,v)=>m==="eth_getCode"&&v!=="0x"?"0x":v],
  ["noncanonical ABI encoding",(m,p,v)=>m==="eth_call"?v+"00".repeat(32):v],
  ["oversized ABI",(m,p,v)=>m==="eth_call"?"0x"+"00".repeat(16385):v],
  ["oversized response",(m,p,v)=>m==="eth_chainId"?"x".repeat(1048577):v],
]) test("fails closed on "+name,async()=>{
  const f=await deploymentFixture(); f.mutate(mutate); await assert.rejects(run(f),fail);
});
for(const offset of [0,100,1692,3164,4217,4414,1994,4638,4865,7727,7772,11510,11552,11594,11675,11715,16318]) {
  test("matches runtime byte "+offset+" including every immutable occurrence",async()=>{
    const f=await deploymentFixture();
    f.mutate((m,p,v)=>{if(m!=="eth_getCode"||p[0]!==f.plan.collection.address)return v;
      const b=Buffer.from(v.slice(2),"hex");b[offset]^=1;return "0x"+b.toString("hex");});
    await assert.rejects(run(f),fail);
  });
}
for(const [name,bad] of [
  ["VERSION","wrong-version"],["INPUT_PROFILE","sg-generative-inputs-experimental-1"],
  ["renderer",zeroAddress],["rendererIdentity",h("bad-id")],["trustedAuthorizer",zeroAddress],
  ["paused",false],["defaultAdmin",zeroAddress],["defaultAdminDelay",1],
  ["pendingDefaultAdmin",[zeroAddress,1]],["pendingDefaultAdminDelay",[1,1]],
  ["eip712Domain",["0x0f","SignaturesGenerativeMintExperimental","1",11155111n,zeroAddress,zero,[]]],
  ["getRoleAdmin",h("unexpected role admin")],["hasRole",true],
]) test("checks "+name+" at finalized and latest state",async()=>{
  for(const onlyLatest of [false,true]) {
    const f=await deploymentFixture(),abi=f.builds.GenerativeSignaturesV1RC1.abi;
    f.mutate((m,p,v)=>{
      if(m!=="eth_call"||p[0].to!==f.plan.collection.address||(onlyLatest&&p[1].blockHash!==f.headers[4].hash))return v;
      const decoded=decodeFunctionData({abi,data:p[0].data});
      return decoded.functionName===name?encodeFunctionResult({abi,functionName:name,result:bad}):v;
    });
    await assert.rejects(run(f),fail);
  }
});
for(const [name,mutate] of [
  ["from",r=>{r.from=zeroAddress;}],["nonce",r=>{r.nonce="0x2";}],["value",r=>{r.value="0x1";}],
  ["type",r=>{r.type="0x0";}],["chain",r=>{r.chainId="0x1";}],["input",r=>{r.input+="00";}],
  ["forged hash",r=>{r.hash=h("forged");}],["signature",r=>{r.r=h("bad signature");}],
  ["high s",r=>{r.s="0x"+"ff".repeat(32);}],["parity",r=>{r.yParity="0x2";}],
  ["inconsistent v",r=>{r.v=r.v==="0x0"?"0x1":"0x0";}],["access list",r=>{r.accessList=[{}];}],
]) test("reconstructs signed CREATE transaction: rejects changed "+name,async()=>{
  const f=await deploymentFixture(),r=f.txs[f.transactions.renderer];mutate(r);
  await assert.rejects(verifyCreationTransaction(r,f.receipts[f.transactions.renderer],f.headers[1],
    {...f.plan.renderer,transactionHash:f.transactions.renderer},f.plan));
});
test("refuses head/chain changes during the observation and disagreement between sources",async()=>{
  for(const change of ["head","chain","sources","receipt","history"]) {
    const f=await deploymentFixture();let heads=0,chains=0,receipts=0,logs=0;
    f.mutate((m,p,v,i)=>{
      if(change==="head"&&m==="eth_getBlockByNumber"&&p[0]==="latest"&&++heads>2)return {...v,hash:h("new head")};
      if(change==="chain"&&m==="eth_chainId"&&++chains>2)return "0x1";
      if(change==="sources"&&m==="eth_getBlockByNumber"&&i===1&&p[0]!=="0x0")return {...v,parentHash:h("other fork")};
      if(change==="receipt"&&m==="eth_getTransactionReceipt"&&++receipts>4)return {...v,blockHash:h("reorg")};
      if(change==="history"&&m==="eth_getLogs"&&++logs>2)return [];
      return v;
    });
    await assert.rejects(run(f),fail);
  }
});
test("deadlines, cancellation and failures abort both sources and redact provider details",async()=>{
  for(const kind of ["hung","error","pre-aborted","cancelled","clock-backwards","clock-jump"]) {
    const f=await deploymentFixture();f.policy.timeoutMs=20;
    const controller=new AbortController();
    if(kind==="pre-aborted")controller.abort();
    f.mutate(()=>{
      if(kind==="error")throw Error("https://private-rpc.example/?token=SECRET");
      if(kind==="clock-backwards")f.advance(-1);
      if(kind==="clock-jump")f.advance(30000);
      if(kind==="cancelled")queueMicrotask(()=>controller.abort());
      return new Promise(()=>{});
    });
    const start=performance.now();
    await assert.rejects(createDeploymentObserver(f).observe(controller.signal),e=>fail.test(e.message)&&!String(e).includes("SECRET"));
    assert.ok(performance.now()-start<1000);
    if(kind==="pre-aborted")assert.equal(f.requests.length,0);
    assert.ok(f.requests.every(r=>r.signal.aborted));
  }
});
test("snapshots caller configuration and refuses modified immutable layouts",async()=>{
  const f=await deploymentFixture(),observer=createDeploymentObserver(f);
  f.policy.validityMs=999999;f.transactions.renderer=h("other");f.config.principals.authorizer.address=zeroAddress;
  const r=report(f,await observer.observe());assert.ok(r.validUntil-r.observedAt<=15000);
  const a=structuredClone(f.builds.GenerativeSignaturesV1RC1);
  Object.values(a.deployedBytecode.immutableReferences)[0][0].start++;
  assert.throws(()=>expectedCollectionRuntime(f.plan,a));
});
