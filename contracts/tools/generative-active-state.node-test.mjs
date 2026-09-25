import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeEventTopics, encodeFunctionResult, keccak256, stringToHex } from "viem";
import { activeStateFixture } from "./fixtures/generative-active-state.mjs";
import { createActiveStateObserver, readActiveStateObservation, verifyGovernanceTransaction } from "./generative-active-state.mjs";
import { createDeploymentObserver } from "./generative-deployment.mjs";
const h=s=>keccak256(stringToHex(s)),fail=/Active-state verification failed/;
const run=f=>createActiveStateObserver(f).observe();
test("accepts zero tolerated future clock skew but refuses negative skew",async()=>{
  const f=await activeStateFixture(); f.policy.maxFutureSkewMs=0; await run(f);
  f.policy.maxFutureSkewMs=-1; assert.throws(()=>createActiveStateObserver(f));
});
test("observes finalized activation and refuses copied/stale/wrong-policy evidence",async()=>{
  const f=await activeStateFixture(),o=createActiveStateObserver(f),w=await o.observe(),r=readActiveStateObservation(w,{policySha256:o.policySha256,now:f.now()});
  assert.equal(r.status,"observed-declared-active-state-not-admitted");assert.equal(r.governance.length,1);assert.equal(r.state.paused,false);
  for(const flag of ["transitionApprovalVerified","custodyVerified","readLimitsValidated","paidDispatchAllowed","signingAllowed","runtimeAdmissionAllowed","activationAllowed","publicBroadcastAllowed"]) assert.equal(r[flag],false);
  assert.ok(Object.isFrozen(r.state.roles));assert.ok(f.requests.every(r=>/^eth_(chainId|getBlockByNumber|getCode|call|getLogs|getTransactionReceipt|getTransactionByHash)$/.test(r.method)));
  for(const req of f.requests.filter(r=>r.method==="eth_call"||r.method==="eth_getCode"))assert.equal(req.params[1].requireCanonical,true);
  for(const copy of [r,{},structuredClone(w),null,1])assert.throws(()=>readActiveStateObservation(copy,{policySha256:o.policySha256,now:f.now()}));
  assert.throws(()=>readActiveStateObservation(w,{policySha256:"wrong",now:f.now()}));
  assert.throws(()=>readActiveStateObservation(w,{policySha256:o.policySha256,now:r.observedAt-1}));
  f.advance(15000);assert.throws(()=>readActiveStateObservation(w,{policySha256:o.policySha256,now:f.now()}));
});
test("replays declared manager handover, signer rotation, nonce revocation, pause/resume and ordinary token approval",async()=>{
  const f=await activeStateFixture({changes:true,passive:true}),o=createActiveStateObserver(f),r=readActiveStateObservation(await o.observe(),{policySha256:o.policySha256,now:f.now()});
  assert.equal(r.governance.length,7);assert.equal(r.state.authorizer,f.next.address.toLowerCase());
  assert.deepEqual(r.state.roles[h("AUTHORIZER_MANAGER_ROLE")],[f.extra.address.toLowerCase()]);assert.deepEqual(r.state.revokedNonces,[h("retired nonce")]);
  // The original observer must STILL reject active history; it wasn't widened.
  await assert.rejects(createDeploymentObserver({...f,policy:{timeoutMs:10000,maxHeadAgeMs:120000,maxFinalizedAgeMs:1800000,maxFutureSkewMs:5000,validityMs:15000,maxDeploymentSpan:256}}).observe(),/Deployment verification failed/);
});
for(const [name,mutate] of [
  ["wrong chain",f=>{f.config.chainId=31337;}],["wrong genesis",f=>{f.config.genesisHash=h("local");}],
  ["missing activation",f=>{f.transitions=[];}],["first action not activation",f=>{f.transitions[0].functionName="pauseMinting";}],
  ["activation wrong sender",f=>{f.transitions[0].sender=f.plan.principals.authorizer.address;}],
  ["undeclared action",f=>{f.transitions[0].functionName="changeDefaultAdminDelay";}],
  ["extra approval flag",f=>{f.transitions[0].approved=true;}],["activation args",f=>{f.transitions[0].args=[1];}],
  ["duplicate transaction",f=>{f.transitions.push(f.transitions[0]);}],["missing transaction",f=>{delete f.transactions.renderer;}],
  ["duplicate source",f=>{f.sources[1]=f.sources[0];}],["duplicate source function",f=>{f.sources[1].request=f.sources[0].request;}],
  ["duplicate operator",f=>{f.sources[1].operatorReference=f.sources[0].operatorReference;}],
  ["extra source field",f=>{f.sources[0].secret="secret";}],["zero timeout",f=>{f.policy.timeoutMs=0;}],
  ["unbounded history",f=>{f.policy.maxHistorySpan=65537;}],["unbounded log batch",f=>{f.policy.logBlockRange=2049;}],
  ["unbounded logs",f=>{f.policy.maxLogs=2049;}],["unbounded receipts",f=>{f.policy.maxTransactions=129;}],
])test("rejects before RPC: "+name,async()=>{const f=await activeStateFixture();mutate(f);assert.throws(()=>createActiveStateObserver(f));assert.equal(f.requests.length,0);});
for(const [name,mutate] of [
  ["wrong chain",(m,p,v)=>m==="eth_chainId"?"0x1":v],
  ["wrong genesis",(m,p,v)=>m==="eth_getBlockByNumber"&&p[0]==="0x0"?{...v,hash:h("Anvil")}:v],
  ["missing finalized",(m,p,v)=>m==="eth_getBlockByNumber"&&p[0]==="finalized"?null:v],
  ["stale head",(m,p,v)=>m==="eth_getBlockByNumber"&&p[0]==="latest"?{...v,timestamp:"0x1"}:v],
  ["future head",(m,p,v)=>m==="eth_getBlockByNumber"&&p[0]==="latest"?{...v,timestamp:"0x7fffffffffff"}:v],
  ["wrong header number",(m,p,v)=>m==="eth_getBlockByNumber"&&p[0]==="0x3"?{...v,number:"0x4"}:v],
  ["broken parent link agreed by both sources",(m,p,v)=>m==="eth_getBlockByNumber"&&v?.number==="0x3"?{...v,parentHash:h("other parent")}:v],
  ["unknown log topic",(m,p,v)=>m==="eth_getLogs"&&v.some(l=>l.blockNumber==="0x3")?v.map(l=>l.blockNumber==="0x3"?{...l,topics:[h("unknown")]}:l):v],
  ["removed log",(m,p,v)=>m==="eth_getLogs"?v.map(l=>({...l,removed:true})):v],
  ["missing activation log",(m,p,v)=>m==="eth_getLogs"?v.filter(l=>l.blockNumber!=="0x3"):v],
  ["reordered constructor logs",(m,p,v)=>m==="eth_getLogs"?v.reverse():v],
  ["wrong log address",(m,p,v)=>m==="eth_getLogs"?v.map(l=>({...l,address:"0x"+"11".repeat(20)})):v],
  ["extra receipt event",(m,p,v)=>m==="eth_getTransactionReceipt"&&v.blockNumber==="0x3"?{...v,logs:[...v.logs,{...v.logs[0],logIndex:"0x1"}]}:v],
  ["failed receipt",(m,p,v)=>m==="eth_getTransactionReceipt"&&v.blockNumber==="0x3"?{...v,status:"0x0"}:v],
  ["changed receipt block",(m,p,v)=>m==="eth_getTransactionReceipt"?{...v,blockHash:h("reorg")}:v],
  ["code-bearing governance sender",(m,p,v)=>m==="eth_getCode"&&v==="0x"?"0x00":v],
  ["missing code",(m,p,v)=>m==="eth_getCode"&&v!=="0x"?"0x":v],
  ["noncanonical scalar ABI",(m,p,v)=>m==="eth_call"?v+"00".repeat(32):v],
  ["oversized scalar ABI",(m,p,v)=>m==="eth_call"?"0x"+"00".repeat(2049):v],
  ["oversized decoded envelope",(m,p,v)=>m==="eth_chainId"?"x".repeat(1048577):v],
])test("fails closed: "+name,async()=>{const f=await activeStateFixture();f.mutate(mutate);await assert.rejects(run(f),fail);});
test("unknown or noncanonical events are rejected even when receipt and log query agree",async()=>{
  for(const kind of ["unknown","padding","admin-event"]) {
    const f=await activeStateFixture();const l=f.history.at(-1),abi=f.builds.GenerativeSignaturesV1RC1.abi;
    if(kind==="unknown")l.topics=[h("unknown event")];
    if(kind==="padding")l.data+="00".repeat(32);
    if(kind==="admin-event") {l.topics=encodeEventTopics({abi,eventName:"DefaultAdminTransferCanceled"});l.data="0x";}
    await assert.rejects(run(f),fail);
  }
});
test("declarations cannot restore a retired signer, change default admin or leave paused/multiple role holders",async()=>{
  for(const kind of ["restore","default-admin","paused","multiple-members","unsupported-role","redundant-grant","nonce-repeat"]) {
    const f=await activeStateFixture({changes:true}),last={transactionHash:h(kind),sender:f.plan.principals.delayedAdmin.address,functionName:"grantRole",args:[h("PAUSER_ROLE"),f.extra.address.toLowerCase()]};
    if(kind==="restore")Object.assign(last,{sender:f.extra.address.toLowerCase(),functionName:"setTrustedAuthorizer",args:[f.plan.principals.authorizer.address]});
    if(kind==="default-admin")last.args[0]="0x"+"00".repeat(32);
    if(kind==="unsupported-role")last.args[0]=h("NEW_ROLE");
    if(kind==="paused")Object.assign(last,{sender:f.plan.principals.pauser.address,functionName:"pauseMinting",args:[]});
    if(kind==="redundant-grant")last.args[1]=f.plan.principals.pauser.address;
    if(kind==="nonce-repeat")Object.assign(last,{sender:f.plan.principals.nonceRevoker.address,functionName:"revokeNonce",args:[h("retired nonce")]});
    f.transitions.push(last);assert.throws(()=>createActiveStateObserver(f));assert.equal(f.requests.length,0);
  }
});
test("history/receipt count limits stop bounded scans and input mutation cannot change policy",async()=>{
  for(const field of ["maxHistorySpan","maxLogs","maxTransactions"]) {
    const f=await activeStateFixture({changes:true});f.policy[field]=1;await assert.rejects(run(f),fail);
  }
  const f=await activeStateFixture(),o=createActiveStateObserver(f);
  f.policy.validityMs=999999;f.transitions[0].args.push("changed");f.transactions.renderer=h("wrong");
  const r=readActiveStateObservation(await o.observe(),{policySha256:o.policySha256,now:f.now()});assert.ok(r.validUntil-r.observedAt<=15000);
});
for(const [name,value] of [["paused",true],["trustedAuthorizer","0x"+"11".repeat(20)],["defaultAdminDelay",1],
  ["pendingDefaultAdmin",["0x"+"00".repeat(20),1]],["pendingDefaultAdminDelay",[1,1]],["hasRole",true],["getRoleAdmin",h("other admin")],
  ["VERSION","wrong"],["INPUT_PROFILE","wrong"],["rendererIdentity",h("other renderer")]])test("state disagrees with history: "+name,async()=>{
  for(const latestOnly of [false,true]){const f=await activeStateFixture(),abi=f.builds.GenerativeSignaturesV1RC1.abi;
    f.mutate((m,p,v)=>{if(m!=="eth_call"||p[0].to!==f.plan.collection.address||(latestOnly&&p[1].blockHash!==f.headers.at(-1).hash))return v;
      return decodeFunctionData({abi,data:p[0].data}).functionName===name?encodeFunctionResult({abi,functionName:name,result:value}):v;});await assert.rejects(run(f),fail);}
});
for(const field of ["from","hash","nonce","input","to","r","s","v","yParity","value","chainId","type","accessList"])test("signed governance transaction rejects changed "+field,async()=>{
  const f=await activeStateFixture(),t=f.transitions[0],raw=structuredClone(f.txs[t.transactionHash]);
  raw[field]=field==="accessList"?[{}]:field==="s"?"0x"+"ff".repeat(32):field==="input"?raw.input+"00":field==="nonce"?"0x2":field==="type"?"0x0":field==="value"?"0x1":field==="v"||field==="yParity"?"0x2":field==="chainId"?"0x1":h("bad");
  await assert.rejects(verifyGovernanceTransaction(raw,f.receipts[t.transactionHash],f.headers[3],t,f.plan,f.builds.GenerativeSignaturesV1RC1.abi));
});
test("rejects unfinalized or unlisted governance even if latest state is restored",async()=>{
  const f=await activeStateFixture({changes:true});f.transitions.splice(5,2); // Omit the observed pause/resume pair.
  await assert.rejects(run(f),fail);
  const g=await activeStateFixture();g.mutate((m,p,v)=>m==="eth_getBlockByNumber"&&p[0]==="finalized"?g.headers[2]:v);
  await assert.rejects(run(g),fail);
});
test("freshness, changing evidence, cancellation and provider failures are bounded and redacted",async()=>{
  for(const kind of ["history","receipt","head","chain","sources","hung","error","pre-abort","abort","clock-back","clock-jump"]){
    const f=await activeStateFixture();const calls=new Map();const controller=new AbortController();
    if(kind==="pre-abort")controller.abort();if(["hung","error","abort","clock-back","clock-jump"].includes(kind))f.policy.timeoutMs=30;
    f.mutate((m,p,v,i)=>{const key=i+"/"+m+"/"+JSON.stringify(p),count=(calls.get(key)??0)+1;calls.set(key,count);
      if(kind==="history"&&m==="eth_getLogs"&&count>1)return [];
      if(kind==="receipt"&&m==="eth_getTransactionReceipt"&&count>1)return {...v,gasUsed:"0x1"};
      if(kind==="head"&&m==="eth_getBlockByNumber"&&p[0]==="latest"&&count>1)return {...v,hash:h("reorg")};
      if(kind==="chain"&&m==="eth_chainId"&&count>1)return "0x1";
      if(kind==="sources"&&m==="eth_getBlockByNumber"&&p[0]==="latest"&&i===1)return {...v,parentHash:h("other fork")};
      if(kind==="error")throw Error("PRIVATE_RPC_SECRET");if(kind==="abort")queueMicrotask(()=>controller.abort());
      if(kind==="clock-back")f.advance(-1);if(kind==="clock-jump")f.advance(100000);
      return ["hung","abort","clock-back","clock-jump"].includes(kind)?new Promise(()=>{}):v;});
    await assert.rejects(createActiveStateObserver(f).observe(controller.signal),e=>fail.test(e.message)&&!e.message.includes("PRIVATE_RPC_SECRET"));
    assert.ok(f.requests.every(r=>r.signal.aborted));
  }
});
