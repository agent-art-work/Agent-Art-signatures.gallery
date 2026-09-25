import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import canonicalize from "canonicalize";
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256,
  recoverTransactionAddress, serializeTransaction, stringToHex } from "viem";
import { decodeBoundedRead, GENERATIVE_READ_LIMITS } from "../../src/openMint/generativeReadLimits.ts";
import { deploymentPlan, loadReleaseArtifacts, PRINCIPALS, RELEASE, ROOT } from "./generative-release.mjs";
import { constructorEvents, expectedCollectionRuntime, observationHeader, observationLog,
  SEPOLIA_GENESIS, verifyCreationTransaction } from "./generative-deployment.mjs";

const ZERO = "0x" + "00".repeat(32), ADDRESS_ZERO = "0x" + "00".repeat(20);
const HASH = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/;
const sha = value => createHash("sha256").update(canonicalize(value)).digest("hex");
const same = (a,b) => assert.deepEqual(a,b);
const keys = (o, fields) => { assert.ok(o && typeof o === "object" && !Array.isArray(o)); same(Object.keys(o).sort(), [...fields].sort()); };
const hash = h => { assert.match(h,HASH); assert.notEqual(h,ZERO); return h; };
const address = a => { assert.match(a,ADDRESS); assert.ok(BigInt(a)>0xffffn); return a; };
const q = n => "0x" + BigInt(n).toString(16);
const number = n => { assert.match(n,/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/); const v=BigInt(n); assert.ok(v<=BigInt(Number.MAX_SAFE_INTEGER)); return Number(v); };
const freeze = v => { if(v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const lower = v => typeof v === "string" && v.startsWith("0x") ? v.toLowerCase() : typeof v === "number" ? BigInt(v) : Array.isArray(v) ? v.map(lower) : v;
const ROLES = ["DEFAULT_ADMIN_ROLE","AUTHORIZER_MANAGER_ROLE","PAUSER_ROLE","NONCE_REVOKER_ROLE"];
const roleId = name => name === ROLES[0] ? ZERO : keccak256(stringToHex(name));
const PASSIVE = new Set(["Transfer","Approval","ApprovalForAll","GenerativeSignatureMinted"]);
const ACTIONS = new Set(["unpauseMinting","pauseMinting","setTrustedAuthorizer","grantRole","revokeRole","revokeNonce"]);
const witnesses = new WeakMap();

export function readActiveStateObservation(witness,{policySha256,now=Date.now()}) {
  const report = witness && witnesses.get(witness);
  if(!report || report.policySha256!==policySha256 || !Number.isSafeInteger(now) || now<report.observedAt || now>=report.validUntil)
    throw Error("Active-state observation is absent, stale or belongs to another policy.");
  return report;
}

/** Narrow direct EOA type-2 governance calls only. No signing or broadcasting.
 * Recover the signed sender; matching an RPC's `from` field alone is not enough. */
export async function verifyGovernanceTransaction(raw,receipt,block,transition,plan,abi) {
  same(raw.type,"0x2"); same(raw.chainId,"0xaa36a7"); same(raw.value,"0x0"); same(raw.accessList,[]);
  same(raw.hash,transition.transactionHash); same(raw.to?.toLowerCase(),plan.collection.address);
  same(raw.from?.toLowerCase(),transition.sender); same(raw.blockHash,block.hash); same(raw.blockNumber,block.number);
  same(raw.input,encodeFunctionData({abi,functionName:transition.functionName,args:transition.args}));
  for(const k of ["gas","maxFeePerGas","maxPriorityFeePerGas"]) assert.match(raw[k],/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/);
  assert.ok(BigInt(raw.gas)>0n && BigInt(raw.maxFeePerGas)>=BigInt(raw.maxPriorityFeePerGas));
  assert.match(raw.r,HASH); assert.match(raw.s,HASH);
  assert.ok(BigInt(raw.r)>0n && BigInt(raw.s)>0n && BigInt(raw.s)<=0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n);
  const parity=number(raw.yParity??raw.v); assert.ok(parity===0 || parity===1);
  if(raw.v!==undefined) same(number(raw.v),parity);
  const serialized=serializeTransaction({type:"eip1559",chainId:11155111,nonce:number(raw.nonce),gas:BigInt(raw.gas),
    maxFeePerGas:BigInt(raw.maxFeePerGas),maxPriorityFeePerGas:BigInt(raw.maxPriorityFeePerGas),to:plan.collection.address,
    value:0n,data:raw.input,accessList:[]},{r:raw.r,s:raw.s,yParity:parity});
  same(keccak256(serialized),transition.transactionHash);
  same((await recoverTransactionAddress({serializedTransaction:serialized})).toLowerCase(),transition.sender);
  same(receipt.type,"0x2"); same(receipt.status,"0x1"); same(receipt.contractAddress,null);
  same(receipt.to?.toLowerCase(),plan.collection.address); same(receipt.from?.toLowerCase(),transition.sender);
  same(receipt.transactionHash,raw.hash); same(receipt.blockHash,block.hash); same(receipt.blockNumber,block.number);
  same(receipt.transactionIndex,raw.transactionIndex); same(block.transactions[number(receipt.transactionIndex)],raw.hash);
  assert.match(receipt.gasUsed,/^0x[0-9a-f]+$/); assert.ok(BigInt(receipt.gasUsed)>0n && BigInt(receipt.gasUsed)<=BigInt(raw.gas));
}

function eventBytes(abi,eventName,args) {
  const event=abi.find(e=>e.type==="event" && e.name===eventName); assert.ok(event);
  return {topics:encodeEventTopics({abi,eventName,args}).map(v=>v.toLowerCase()),
    data:encodeAbiParameters(event.inputs.filter(i=>!i.indexed),event.inputs.filter(i=>!i.indexed).map(i=>args[i.name]))};
}
function initialState(plan) {
  return {paused:true,authorizer:plan.principals.authorizer.address,retired:new Set(),revoked:new Set(),
    roles:new Map(ROLES.map((r,i)=>[roleId(r),new Set([plan.principals[["delayedAdmin","authorizerManager","pauser","nonceRevoker"][i]].address])]))};
}
/** Apply only supported declared actions. Admin transfers/delay changes,
 * renunciation, unknown events and restoration of retired signers halt. */
function applyTransition(state,t) {
  const f=t.functionName,[a,b]=t.args;
  const has=r=>assert.ok(state.roles.get(roleId(r)).has(t.sender),"unauthorized transition sender");
  if(f==="unpauseMinting" || f==="pauseMinting") {
    has("PAUSER_ROLE"); const pause=f==="pauseMinting"; assert.notEqual(state.paused,pause); state.paused=pause;
    return [pause?"Paused":"Unpaused",{account:t.sender}];
  }
  if(f==="setTrustedAuthorizer") {
    has("AUTHORIZER_MANAGER_ROLE"); assert.notEqual(a,state.authorizer); assert.ok(!state.retired.has(a),"retired signer restoration");
    const previousAuthorizer=state.authorizer; state.retired.add(previousAuthorizer); state.authorizer=a;
    return ["TrustedAuthorizerChanged",{previousAuthorizer,newAuthorizer:a}];
  }
  if(f==="revokeNonce") {
    has("NONCE_REVOKER_ROLE"); assert.ok(!state.revoked.has(a)); state.revoked.add(a); return ["NonceRevoked",{nonce:a}];
  }
  has("DEFAULT_ADMIN_ROLE"); const members=state.roles.get(a),grant=f==="grantRole";
  assert.notEqual(members.has(b),grant); if(grant)members.add(b); else members.delete(b);
  return [grant?"RoleGranted":"RoleRevoked",{role:a,account:b,sender:t.sender}];
}

/** Source agreement is observation, NOT human approval or cryptographic chain
 * consensus. Does not consume the pristine observer's witness or weaken it. */
export function createActiveStateObserver({config,transactions,transitions,sources,policy,root=ROOT,now=Date.now}) {
  const plan=freeze(deploymentPlan(config,root)),builds=loadReleaseArtifacts(root);
  same(plan.declaredGenesisHash,SEPOLIA_GENESIS);
  keys(transactions,["renderer","collection"]); hash(transactions.renderer); hash(transactions.collection);
  assert.notEqual(transactions.renderer,transactions.collection); const txs={...transactions};
  assert.ok(Array.isArray(transitions) && transitions.length>=1 && transitions.length<=16);
  const people=new Set(Object.values(plan.principals).map(p=>p.address)),seen=new Set(Object.values(txs));
  const actions=transitions.map(t=>{
    keys(t,["transactionHash","sender","functionName","args"]); hash(t.transactionHash); address(t.sender);
    assert.ok(!seen.has(t.transactionHash)); seen.add(t.transactionHash); people.add(t.sender);
    assert.ok(ACTIONS.has(t.functionName) && Array.isArray(t.args)); const args=[...t.args];
    if(["pauseMinting","unpauseMinting"].includes(t.functionName)) same(args,[]);
    else if(t.functionName==="setTrustedAuthorizer") { same(args.length,1); people.add(address(args[0])); }
    else if(t.functionName==="revokeNonce") { same(args.length,1); hash(args[0]); }
    else { same(args.length,2); assert.ok(ROLES.slice(1).map(roleId).includes(args[0])); people.add(address(args[1])); }
    return {...t,args};
  });
  same(actions[0].functionName,"unpauseMinting"); assert.ok(people.size<=32);
  const expected=initialState(plan); for(const t of actions) applyTransition(expected,t);
  same(expected.paused,false); for(const members of expected.roles.values()) same(members.size,1);
  keys(policy,["timeoutMs","maxHeadAgeMs","maxFinalizedAgeMs","maxFutureSkewMs","validityMs","maxHistorySpan","logBlockRange","maxLogs","maxTransactions"]);
  const p={...policy}; for(const [k,v] of Object.entries(p)) assert.ok(Number.isSafeInteger(v) && (k==="maxFutureSkewMs"?v>=0:v>0));
  assert.ok(p.timeoutMs<=30000 && p.maxHeadAgeMs<=300000 && p.maxFinalizedAgeMs<=3600000 && p.maxFinalizedAgeMs>=p.maxHeadAgeMs
    && p.maxFutureSkewMs<=30000 && p.validityMs<=Math.min(30000,p.maxHeadAgeMs) && p.maxHistorySpan<=65536
    && p.logBlockRange<=2048 && p.maxLogs<=2048 && p.maxTransactions<=128);
  assert.ok(Array.isArray(sources) && sources.length===2 && sources[0]!==sources[1] && sources[0].request!==sources[1].request);
  for(const s of sources) { keys(s,["id","operatorReference","request"]); for(const k of ["id","operatorReference"]) assert.match(s[k],/^[a-z0-9][a-z0-9:._/-]{2,95}$/); same(typeof s.request,"function"); }
  assert.notEqual(sources[0].id,sources[1].id); assert.notEqual(sources[0].operatorReference,sources[1].operatorReference);
  const rpcs=sources.map(s=>({id:s.id,operatorReference:s.operatorReference,request:s.request.bind(s)}));
  const declared=freeze({planSha256:plan.planSha256,transactions:txs,transitions:actions,policy:p,sources:rpcs.map(({id,operatorReference})=>({id,operatorReference}))});
  const policySha256=sha(declared),collection=builds.GenerativeSignaturesV1RC1,renderer=builds.SignatureRendererV1RC1,abi=collection.abi;
  const runtime=expectedCollectionRuntime(plan,collection),constructor=constructorEvents(plan,abi);
  return Object.freeze({plan,policySha256,async observe(signal=new AbortController().signal) {
    const controller=new AbortController(),started=performance.now(),startWall=now(); let timer,abort;
    const check=()=>{const wall=now();assert.ok(Number.isSafeInteger(wall)&&wall>=startWall&&!signal.aborted&&!controller.signal.aborted
      &&performance.now()-started<p.timeoutMs&&wall-startWall<p.timeoutMs);};
    const stop=new Promise((_,reject)=>{abort=()=>{controller.abort();reject(Error("cancelled"));};signal.addEventListener("abort",abort,{once:true});timer=setTimeout(abort,p.timeoutMs);});
    try {
      check();
      const observeSource=async rpc=>{
        let count=0;
        const call=async(method,params)=>{check();assert.ok(++count<=2048);const r=await rpc.request(method,params,controller.signal);check();
          const json=JSON.stringify(r);assert.ok(typeof json==="string"&&Buffer.byteLength(json)<=1048576);return r;};
        const pins=new Map(),receipts=new Map();
        const header=async tag=>{const b=observationHeader(await call("eth_getBlockByNumber",[tag,false])); if(!["latest","finalized"].includes(tag))same(b.number,tag);
          const old=pins.get(b.number);if(old)same(b,old);else pins.set(b.number,b);return b;};
        same(await call("eth_chainId",[]),"0xaa36a7"); const genesis=await header("0x0");same(genesis.hash,SEPOLIA_GENESIS);
        const [finalized,latest]=await Promise.all([header("finalized"),header("latest")]);
        assert.ok(number(finalized.number)<=number(latest.number)&&number(finalized.timestamp)<=number(latest.timestamp));
        for(const [b,age] of [[latest,p.maxHeadAgeMs],[finalized,p.maxFinalizedAgeMs]]) {const ms=number(b.timestamp)*1000;assert.ok(ms<=startWall+p.maxFutureSkewMs&&startWall-ms<=age);}
        const deployment={};
        for(const name of ["renderer","collection"]) {
          const [raw,receipt]=await Promise.all([call("eth_getTransactionByHash",[txs[name]]),call("eth_getTransactionReceipt",[txs[name]])]);
          const b=await header(receipt.blockNumber);assert.ok(number(b.number)>0&&number(b.number)<=number(finalized.number)&&number(latest.number)-number(b.number)<=p.maxHistorySpan);
          deployment[name]=await verifyCreationTransaction(raw,receipt,b,{...plan[name],transactionHash:txs[name]},plan);receipts.set(txs[name],receipt);
        }
        assert.ok(number(deployment.renderer.blockNumber)<number(deployment.collection.blockNumber)||(deployment.renderer.blockNumber===deployment.collection.blockNumber&&number(deployment.renderer.transactionIndex)<number(deployment.collection.transactionIndex)));
        same(deployment.renderer.logs,[]);same(deployment.collection.logs.map(({address,topics,data})=>({address,topics,data})),constructor);
        const queries=[],history=[];
        for(let from=number(deployment.collection.blockNumber);from<=number(latest.number);from+=p.logBlockRange) {
          const query={address:plan.collection.address,fromBlock:q(from),toBlock:q(Math.min(from+p.logBlockRange-1,number(latest.number)))};
          const raw=await call("eth_getLogs",[query]);assert.ok(Array.isArray(raw)&&history.length+raw.length<=p.maxLogs);
          const logs=raw.map(observationLog);for(const l of logs){same(l.address,plan.collection.address);assert.ok(number(l.blockNumber)>=from&&number(l.blockNumber)<=number(query.toBlock));}
          queries.push({query,raw});history.push(...logs);
        }
        for(let i=1;i<history.length;i++) {const a=history[i-1],b=history[i];assert.ok(number(a.blockNumber)<number(b.blockNumber)||
          (a.blockNumber===b.blockNumber && number(a.logIndex)<number(b.logIndex)&&number(a.transactionIndex)<=number(b.transactionIndex)));}
        same(history.slice(0,constructor.length),deployment.collection.logs);
        const groups=new Map();for(const l of history){if(!groups.has(l.transactionHash))groups.set(l.transactionHash,[]);groups.get(l.transactionHash).push(l);}
        assert.ok(groups.size<=p.maxTransactions);
        const state=initialState(plan);let actionIndex=0;const governance=[];
        for(const [txHash,logs] of groups) {
          const b=await header(logs[0].blockNumber),receipt=receipts.get(txHash)??await call("eth_getTransactionReceipt",[txHash]);
          assert.ok(receipt&&Array.isArray(receipt.logs)&&receipt.logs.length<=2048);same(receipt.status,"0x1");same(receipt.transactionHash,txHash);
          same(receipt.blockHash,b.hash);same(receipt.blockNumber,b.number);same(b.transactions[number(receipt.transactionIndex)],txHash);
          const decodedReceipt=receipt.logs.map(observationLog);
          for(const l of decodedReceipt){same(l.blockHash,b.hash);same(l.blockNumber,b.number);same(l.transactionHash,txHash);same(l.transactionIndex,receipt.transactionIndex);}
          for(let i=1;i<decodedReceipt.length;i++) assert.ok(number(decodedReceipt[i-1].logIndex)<number(decodedReceipt[i].logIndex));
          same(decodedReceipt.filter(l=>l.address===plan.collection.address),logs);receipts.set(txHash,receipt);
          if(txHash===txs.collection)continue;
          const events=logs.map(l=>{const d=decodeEventLog({abi,topics:l.topics,data:l.data,strict:true});
            same(eventBytes(abi,d.eventName,d.args),{topics:l.topics,data:l.data});return d;});
          const privileged=events.some(e=>!PASSIVE.has(e.eventName));
          if(!privileged)continue; // Token event semantics belong to the projection, not this governance observer.
          const t=actions[actionIndex++];assert.ok(t);same(txHash,t.transactionHash);same(logs.length,1);
          assert.ok(number(b.number)<=number(finalized.number));
          const raw=await call("eth_getTransactionByHash",[txHash]);await verifyGovernanceTransaction(raw,receipt,b,t,plan,abi);
          // Code-bearing governance principals/multisig calls require a distinct reviewed verifier.
          same(await call("eth_getCode",[t.sender,{blockHash:b.hash,requireCanonical:true}]),"0x");
          const [eventName,args]=applyTransition(state,t);same(eventBytes(abi,eventName,args),{topics:logs[0].topics,data:logs[0].data});
          governance.push({transactionHash:txHash,blockNumber:b.number,blockHash:b.hash,functionName:t.functionName,sender:t.sender});
        }
        same(actionIndex,actions.length);same(state.paused,false);
        const stateSummary={paused:false,authorizer:state.authorizer,roles:Object.fromEntries([...state.roles].map(([r,m])=>[r,[...m].sort()])),revokedNonces:[...state.revoked].sort()};
        const readState=async b=>{
          const pin={blockHash:b.hash,requireCanonical:true};
          const read=async(name,args=[],to=plan.collection.address,a=abi)=>lower(decodeBoundedRead(a,name,
            await call("eth_call",[{to,data:encodeFunctionData({abi:a,functionName:name,args}),gas:q(GENERATIVE_READ_LIMITS.scalarGas)},pin]),GENERATIVE_READ_LIMITS.scalarAbiBytes));
          same(await call("eth_getCode",[plan.renderer.address,pin]),renderer.deployedBytecode.object);same(await call("eth_getCode",[plan.collection.address,pin]),runtime);
          for(const [name,value] of [["VERSION",RELEASE.collection],["INPUT_PROFILE",RELEASE.inputProfile],["renderer",plan.renderer.address],
            ["rendererIdentity",plan.renderer.identity],["trustedAuthorizer",state.authorizer],["paused",false],["defaultAdmin",plan.principals.delayedAdmin.address],
            ["defaultAdminDelay",BigInt(plan.adminDelay)],["pendingDefaultAdmin",[ADDRESS_ZERO,0n]],["pendingDefaultAdminDelay",[0n,0n]],
            ["eip712Domain",["0x0f",RELEASE.domainName,RELEASE.domainVersion,11155111n,plan.collection.address,ZERO,[]]]])same(await read(name),value);
          same(await read("VERSION",[],plan.renderer.address,renderer.abi),RELEASE.renderer);
          for(const role of ROLES){same(await read(role),roleId(role));same(await read("getRoleAdmin",[roleId(role)]),ZERO);
            for(const person of people)same(await read("hasRole",[roleId(role),person]),state.roles.get(roleId(role)).has(person));}
          for(const nonce of state.revoked)same(await read("revokedNonces",[nonce]),true);
          same(await call("eth_getCode",[state.authorizer,pin]),"0x");same(await call("eth_getCode",[plan.principals.deployer.address,pin]),"0x");
        };
        await readState(finalized);if(latest.hash!==finalized.hash)await readState(latest);
        const orderedPins=[...pins.values()].sort((a,b)=>number(a.number)-number(b.number));
        for(let i=1;i<orderedPins.length;i++) {
          const a=orderedPins[i-1],b=orderedPins[i];assert.ok(number(a.timestamp)<=number(b.timestamp));
          if(number(b.number)===number(a.number)+1)same(b.parentHash,a.hash);
        }
        // Recheck every sampled canonical block and complete receipt/history, not just receipt status.
        for(const b of [...pins.values()])same(await header(b.number),b);
        for(const [txHash,r] of receipts)same(await call("eth_getTransactionReceipt",[txHash]),r);
        for(const {query,raw} of queries)same(await call("eth_getLogs",[query]),raw);
        same(await header("finalized"),finalized);same(await header("latest"),latest);same(await call("eth_chainId",[]),"0xaa36a7");
        return {genesis,finalized,latest,deployment,governance,state:stateSummary,historySha256:sha(history),collectionRuntimeCodeHash:keccak256(runtime),requestCount:count};
      };
      const results=await Promise.race([Promise.all(rpcs.map(observeSource)),stop]);check();same(results[0],results[1]);
      const observedAt=now(),validUntil=Math.min(observedAt+p.validityMs,number(results[0].latest.timestamp)*1000+p.maxHeadAgeMs,number(results[0].finalized.timestamp)*1000+p.maxFinalizedAgeMs);
      assert.ok(validUntil>observedAt);
      const body={schema:"sg-generative-active-observation-v1",status:"observed-declared-active-state-not-admitted",policySha256,
        planSha256:plan.planSha256,releaseLockSha256:plan.releaseLockSha256,chainId:11155111,origin:plan.origin,...results[0],observedAt,validUntil,
        sources:declared.sources,sourceIndependence:"operator-declared-not-proven",transitionApprovalVerified:false,custodyVerified:false,
        readLimitsValidated:false,paidDispatchAllowed:false,signingAllowed:false,publicBroadcastAllowed:false,runtimeAdmissionAllowed:false,activationAllowed:false};
      const report=freeze({...body,observationSha256:sha(body)}),w=Object.freeze({});witnesses.set(w,report);return w;
    } catch { throw Error("Active-state verification failed; stop new effects and investigate."); }
    finally {controller.abort();clearTimeout(timer);signal.removeEventListener("abort",abort);}
  }});
}
