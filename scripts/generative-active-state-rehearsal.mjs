import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploymentPlan, loadReleaseArtifacts, PRINCIPALS, verifyRelease } from "../contracts/tools/generative-release.mjs";
import { expectedCollectionRuntime, SEPOLIA_GENESIS, verifyCreationTransaction } from "../contracts/tools/generative-deployment.mjs";
import { createActiveStateObserver, verifyGovernanceTransaction } from "../contracts/tools/generative-active-state.mjs";

// Only our own new loopback child and PUBLIC test keys. No environment/key/RPC
// override, existing deployment, paid provider, active DB or public transaction.
assert.deepEqual(process.argv.slice(2),["--execute-local-test-transactions"]);
const release=verifyRelease(),builds=loadReleaseArtifacts(),abi=builds.GenerativeSignaturesV1RC1.abi;
const chain=defineChain({id:11155111,name:"Disposable active-state rehearsal",nativeCurrency:{name:"Test ETH",symbol:"ETH",decimals:18},rpcUrls:{default:{http:["http://127.0.0.1"]}}});
const socket=createServer();socket.listen(0,"127.0.0.1");await once(socket,"listening");
const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const child=spawn("anvil",["--host","127.0.0.1","--port",String(port),"--chain-id","11155111","--silent"],{stdio:"ignore"});
let startupError;child.on("error",e=>{startupError=e;});
const transport=http("http://127.0.0.1:"+port,{retryCount:0,timeout:10000}),client=createPublicClient({chain,transport});
const accounts=Object.fromEntries([...PRINCIPALS,"nextManager","nextAuthorizer"].map(name=>[name,privateKeyToAccount(keccak256(stringToHex("PUBLIC ACTIVE REHEARSAL KEY/"+name)))]));
const config={chainId:11155111,origin:"https://staging.signatures.gallery",genesisHash:SEPOLIA_GENESIS,adminDelay:"172800",rendererNonce:"0",collectionNonce:"1",
  principals:Object.fromEntries(PRINCIPALS.map(name=>[name,{address:accounts[name].address.toLowerCase(),ownerReference:"synthetic-custody/"+name.toLowerCase()}]))};
const plan=deploymentPlan(config),wallet=account=>createWalletClient({chain,transport,account}),rpc=(method,params)=>client.request({method,params},{retryCount:0});
try {
  let ready=false;
  for(let i=0;i<80;i++){if(startupError)throw startupError;if(child.exitCode!==null)throw Error("Disposable Anvil exited");
    try{assert.equal(await client.getChainId(),11155111);ready=true;break;}catch{await sleep(100);}}
  assert.ok(ready);assert.equal(await client.getTransactionCount({address:accounts.deployer.address}),0);
  assert.match(await rpc("web3_clientVersion",[]),/anvil/i);
  for(const account of Object.values(accounts))await rpc("anvil_setBalance",[account.address,"0x56bc75e2d63100000"]);
  const transactions={},transitions=[],receipts=[];
  for(const [i,name] of ["renderer","collection"].entries()){
    const artifact=name==="renderer"?builds.SignatureRendererV1RC1:builds.GenerativeSignaturesV1RC1;
    const hash=await wallet(accounts.deployer).deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,nonce:i,gas:10000000n,
      maxFeePerGas:2000000000n,maxPriorityFeePerGas:1n,...(name==="collection"?{args:[plan.renderer.address,172800n,...PRINCIPALS.slice(1).map(n=>plan.principals[n].address)]}:{})});
    await client.waitForTransactionReceipt({hash});transactions[name]=hash;
    const raw=await rpc("eth_getTransactionByHash",[hash]),receipt=await rpc("eth_getTransactionReceipt",[hash]),block=await rpc("eth_getBlockByNumber",[receipt.blockNumber,false]);
    await verifyCreationTransaction(raw,receipt,block,{...plan[name],transactionHash:hash},plan);
  }
  const read=(functionName,args=[])=>client.readContract({address:plan.collection.address,abi,functionName,args});
  assert.equal(await read("paused"),true);
  const managerRole=keccak256(stringToHex("AUTHORIZER_MANAGER_ROLE")),nonce=keccak256(stringToHex("PUBLIC REHEARSAL REVOKED NONCE"));
  const calls=[
    ["unpauseMinting",[],"pauser","Unpaused"],
    ["grantRole",[managerRole,accounts.nextManager.address],"delayedAdmin","RoleGranted"],
    ["revokeRole",[managerRole,accounts.authorizerManager.address],"delayedAdmin","RoleRevoked"],
    ["setTrustedAuthorizer",[accounts.nextAuthorizer.address],"nextManager","TrustedAuthorizerChanged"],
    ["revokeNonce",[nonce],"nonceRevoker","NonceRevoked"],
    ["pauseMinting",[],"pauser","Paused"],
    ["unpauseMinting",[],"pauser","Unpaused"],
  ];
  for(const [functionName,args,name,eventName] of calls){
    const hash=await wallet(accounts[name]).writeContract({address:plan.collection.address,abi,functionName,args,value:0n,gas:300000n,maxFeePerGas:2000000000n,maxPriorityFeePerGas:1n});
    await client.waitForTransactionReceipt({hash});
    const transition={transactionHash:hash,sender:accounts[name].address.toLowerCase(),functionName,args:args.map(v=>typeof v==="string"?v.toLowerCase():v)};
    const raw=await rpc("eth_getTransactionByHash",[hash]),receipt=await rpc("eth_getTransactionReceipt",[hash]),block=await rpc("eth_getBlockByNumber",[receipt.blockNumber,false]);
    await verifyGovernanceTransaction(raw,receipt,block,transition,plan,abi);assert.equal(receipt.logs.length,1);
    assert.equal(decodeEventLog({abi,topics:receipt.logs[0].topics,data:receipt.logs[0].data,strict:true}).eventName,eventName);
    transitions.push(transition);receipts.push({functionName,gasUsed:receipt.gasUsed,transactionHash:hash,signedTransactionVerified:true});
  }
  assert.equal(await read("paused"),false);assert.equal((await read("trustedAuthorizer")).toLowerCase(),accounts.nextAuthorizer.address.toLowerCase());
  assert.equal(await read("hasRole",[managerRole,accounts.authorizerManager.address]),false);assert.equal(await read("hasRole",[managerRole,accounts.nextManager.address]),true);
  assert.equal(await read("revokedNonces",[nonce]),true);
  assert.equal(await client.getCode({address:plan.collection.address}),expectedCollectionRuntime(plan,builds.GenerativeSignaturesV1RC1));
  const sources=[0,1].map(i=>({id:"local-test-"+i,operatorReference:"same-anvil-simulation/"+i,request:async(m,p,signal)=>{signal.throwIfAborted();return rpc(m,p);}}));
  const genesis=await rpc("eth_getBlockByNumber",["0x0",false]);assert.notEqual(genesis.hash,SEPOLIA_GENESIS);
  await assert.rejects(createActiveStateObserver({config,transactions,transitions,sources,policy:{timeoutMs:10000,maxHeadAgeMs:120000,maxFinalizedAgeMs:1800000,
    maxFutureSkewMs:5000,validityMs:15000,maxHistorySpan:256,logBlockRange:64,maxLogs:128,maxTransactions:32}}).observe(),/Active-state verification failed/);
  const result={passed:true,release,localOnly:true,publicTransactions:0,paidProviderCalls:0,actualSepoliaObserved:false,sourceIndependenceVerified:false,
    initialPausedStateVerified:true,localActivationAndChangesVerified:true,exactRuntimePreserved:true,localGenesisRejected:true,runtimeAdmissionAllowed:false,receipts};
  const dir=new URL("../.local/generative-renderer/",import.meta.url);await mkdir(dir,{recursive:true});
  await writeFile(new URL("active-state-rehearsal.json",dir),JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result,null,2));
} finally {
  if(child.exitCode===null&&!startupError){const exited=once(child,"exit");child.kill("SIGTERM");let timer;
    try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Disposable Anvil did not stop")),5000);})]);}finally{clearTimeout(timer);}}
}
