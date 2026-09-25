import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploymentPlan, loadReleaseArtifacts, PRINCIPALS, verifyRelease } from "../contracts/tools/generative-release.mjs";
import { createDeploymentObserver, expectedCollectionRuntime, SEPOLIA_GENESIS, verifyCreationTransaction } from "../contracts/tools/generative-deployment.mjs";

// Only a new loopback child can be targeted. No configurable URL, key, wallet,
// .env, active chain, database, paid provider or public transaction.
assert.deepEqual(process.argv.slice(2),["--execute-local-test-transactions"]);
const release = verifyRelease(), builds = loadReleaseArtifacts();
const chain = defineChain({id:11155111,name:"Disposable Sepolia-ID simulation",nativeCurrency:{name:"Test ETH",symbol:"ETH",decimals:18},
  rpcUrls:{default:{http:["http://127.0.0.1"]}}});
const socket=createServer();socket.listen(0,"127.0.0.1");await once(socket,"listening");
const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const child=spawn("anvil",["--host","127.0.0.1","--port",String(port),"--chain-id","11155111","--silent"],{stdio:"ignore"});
let startupError;child.on("error",e=>{startupError=e;});
const transport=http("http://127.0.0.1:"+port,{retryCount:0,timeout:10000}),client=createPublicClient({chain,transport});
const accounts=Object.fromEntries(PRINCIPALS.map(name=>[name,privateKeyToAccount(keccak256(stringToHex("PUBLIC DEPLOYMENT TEST KEY/"+name)))]));
const config={chainId:11155111,origin:"https://staging.signatures.gallery",genesisHash:SEPOLIA_GENESIS,
  adminDelay:"172800",rendererNonce:"0",collectionNonce:"1",principals:Object.fromEntries(PRINCIPALS.map(name=>
    [name,{address:accounts[name].address.toLowerCase(),ownerReference:"synthetic-custody/"+name.toLowerCase()}]))};
const plan=deploymentPlan(config),wallet=createWalletClient({chain,transport,account:accounts.deployer});
const rpc=(method,params)=>client.request({method,params},{retryCount:0});
try{
  let ready=false;
  for(let i=0;i<80;i++){
    if(startupError)throw startupError;if(child.exitCode!==null)throw Error("Disposable Anvil exited");
    try{assert.equal(await client.getChainId(),11155111);ready=true;break;}catch{await sleep(100);}
  }
  assert.ok(ready);
  // Public test material funded exclusively on the newly spawned disposable node.
  await rpc("anvil_setBalance",[accounts.deployer.address,"0x56bc75e2d63100000"]);
  const transactions={},deployments=[];
  for(const [i,name] of ["renderer","collection"].entries()){
    const artifact=name==="renderer"?builds.SignatureRendererV1RC1:builds.GenerativeSignaturesV1RC1;
    const hash=await wallet.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,nonce:i,gas:10000000n,
      maxFeePerGas:2000000000n,maxPriorityFeePerGas:1n,
      ...(name==="collection"?{args:[plan.renderer.address,172800n,...PRINCIPALS.slice(1).map(n=>plan.principals[n].address)]}:{})});
    await client.waitForTransactionReceipt({hash});transactions[name]=hash;
    const raw=await rpc("eth_getTransactionByHash",[hash]),receipt=await rpc("eth_getTransactionReceipt",[hash]);
    const block=await rpc("eth_getBlockByNumber",[receipt.blockNumber,false]);
    const verified=await verifyCreationTransaction(raw,receipt,block,{...plan[name],transactionHash:hash},plan);
    const runtime=await rpc("eth_getCode",[plan[name].address,{blockHash:block.hash,requireCanonical:true}]);
    assert.equal(runtime,name==="renderer"?artifact.deployedBytecode.object:expectedCollectionRuntime(plan,artifact));
    deployments.push({contract:name,gas:receipt.gasUsed,runtimeCodeHash:keccak256(runtime),signedCreateVerified:true,logs:verified.logs.length});
  }
  const abi=builds.GenerativeSignaturesV1RC1.abi;
  assert.equal(await client.readContract({address:plan.collection.address,abi,functionName:"paused"}),true);
  assert.equal((await client.readContract({address:plan.collection.address,abi,functionName:"defaultAdmin"})).toLowerCase(),plan.principals.delayedAdmin.address);
  assert.equal(await client.readContract({address:plan.collection.address,abi,functionName:"defaultAdminDelay"}),172800);
  const sources=[0,1].map(i=>({id:"local-test-"+i,operatorReference:"same-anvil-simulation/"+i,
    request:async(method,params,signal)=>{assert.ok(!signal.aborted);return rpc(method,params);}}));
  // Do NOT spoof Sepolia's genesis to make this rehearsal pass the public gate.
  const actualGenesis=await rpc("eth_getBlockByNumber",["0x0",false]);
  assert.notEqual(actualGenesis.hash,SEPOLIA_GENESIS);
  await assert.rejects(createDeploymentObserver({config,transactions,sources,
    policy:{timeoutMs:10000,maxHeadAgeMs:120000,maxFinalizedAgeMs:1800000,maxFutureSkewMs:5000,validityMs:15000,maxDeploymentSpan:256}}).observe(),
  /Deployment verification failed/);
  const result={passed:true,release,localOnly:true,publicTransactions:0,providerCalls:0,
    chainIdOnlySimulation:true,actualSepoliaObserved:false,exactRuntimeAndImmutableValues:true,
    initialPausePreserved:true,localGenesisRejected:true,runtimeAdmissionAllowed:false,deployments};
  const dir=new URL("../.local/generative-renderer/",import.meta.url);await mkdir(dir,{recursive:true});
  await writeFile(new URL("deployment-rehearsal.json",dir),JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify(result,null,2));
}finally{
  if(child.exitCode===null&&!startupError){
    const exited=once(child,"exit");child.kill("SIGTERM");
    let timer;try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Disposable Anvil did not stop")),5000);})]);}
    finally{clearTimeout(timer);}
  }
}
