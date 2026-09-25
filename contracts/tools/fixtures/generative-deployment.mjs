import { decodeFunctionData, encodeAbiParameters, encodeDeployData, encodeEventTopics, encodeFunctionResult,
  keccak256, parseTransaction, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploymentPlan, loadReleaseArtifacts, PRINCIPALS, RELEASE } from "../generative-release.mjs";
import { expectedCollectionRuntime, SEPOLIA_GENESIS } from "../generative-deployment.mjs";

// Offline synthetic RPC fixture, NOT observed Sepolia evidence. Keys are public
// label-derived test material and never used with a real network or credential.
export async function deploymentFixture() {
  const h = s => keccak256(stringToHex(s)), q = n => "0x" + BigInt(n).toString(16);
  const accounts = Object.fromEntries(PRINCIPALS.map(n => [n,privateKeyToAccount(h("PUBLIC DEPLOYMENT TEST KEY/" + n))]));
  const config = {chainId:11155111,origin:"https://staging.signatures.gallery",genesisHash:SEPOLIA_GENESIS,
    adminDelay:"172800",rendererNonce:"0",collectionNonce:"1",principals:Object.fromEntries(PRINCIPALS.map(n =>
      [n,{address:accounts[n].address.toLowerCase(),ownerReference:"synthetic-custody/" + n.toLowerCase()}]))};
  const plan = deploymentPlan(config), builds = loadReleaseArtifacts(), rc = builds.GenerativeSignaturesV1RC1, renderer = builds.SignatureRendererV1RC1;
  let clock = 1800000000000;
  const zero = "0x" + "00".repeat(32), zeroAddress = "0x" + "00".repeat(20);
  const headers = Array.from({length:5},(_,n)=>({number:q(n),hash:n ? h("TEST BLOCK/"+n):SEPOLIA_GENESIS,
    parentHash:n===0 ? zero : n===1 ? SEPOLIA_GENESIS : h("TEST BLOCK/"+(n-1)),
    timestamp:q(clock/1000-120+n*29),transactions:[]}));
  const transactions = {}, txs = {}, receipts = {};
  for (const [i,name] of ["renderer","collection"].entries()) {
    const data = name === "renderer" ? renderer.bytecode.object : encodeDeployData({abi:rc.abi,bytecode:rc.bytecode.object,
      args:[plan.renderer.address,172800n,...PRINCIPALS.slice(1).map(n=>plan.principals[n].address)]});
    const serialized = await accounts.deployer.signTransaction({type:"eip1559",chainId:11155111,nonce:i,gas:10000000n,
      maxFeePerGas:1000000000n,maxPriorityFeePerGas:1n,value:0n,data,accessList:[]});
    const parsed = parseTransaction(serialized), hash = keccak256(serialized), block = headers[i+1];
    transactions[name] = hash; block.transactions.push(hash);
    txs[hash] = {type:"0x2",chainId:"0xaa36a7",hash,from:plan.principals.deployer.address,to:null,nonce:q(i),gas:q(10000000),
      maxFeePerGas:q(1000000000),maxPriorityFeePerGas:"0x1",value:"0x0",input:data,accessList:[],r:parsed.r,s:parsed.s,
      yParity:q(parsed.yParity),v:q(parsed.yParity),blockHash:block.hash,blockNumber:block.number,transactionIndex:"0x0"};
    receipts[hash] = {type:"0x2",transactionHash:hash,blockHash:block.hash,blockNumber:block.number,transactionIndex:"0x0",
      from:plan.principals.deployer.address,to:null,contractAddress:plan[name].address,status:"0x1",gasUsed:q(4000000),logs:[]};
  }
  const roles = new Map([["DEFAULT_ADMIN_ROLE","delayedAdmin"],["AUTHORIZER_MANAGER_ROLE","authorizerManager"],
    ["PAUSER_ROLE","pauser"],["NONCE_REVOKER_ROLE","nonceRevoker"]].map(([name,principal]) =>
    [name,{id:name==="DEFAULT_ADMIN_ROLE" ? zero : h(name),account:plan.principals[principal].address}]));
  const receipt = receipts[transactions.collection];
  function addLog(eventName,args,data="0x") {
    receipt.logs.push({address:plan.collection.address,topics:encodeEventTopics({abi:rc.abi,eventName,args}).map(v=>v.toLowerCase()),
      data,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,transactionHash:receipt.transactionHash,
      transactionIndex:receipt.transactionIndex,logIndex:q(receipt.logs.length),removed:false});
  }
  for (const role of roles.values()) addLog("RoleGranted",{role:role.id,account:role.account,sender:plan.principals.deployer.address});
  addLog("TrustedAuthorizerChanged",{previousAuthorizer:zeroAddress,newAuthorizer:plan.principals.authorizer.address});
  addLog("Paused",{},encodeAbiParameters([{type:"address"}],[plan.principals.deployer.address]));
  const runtime = expectedCollectionRuntime(plan,rc), requests = [];
  let mutate = (_method,_params,value) => value;
  const answer = (method,params) => {
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_getBlockByNumber") return headers[params[0]==="latest"?4:params[0]==="finalized"?3:Number(BigInt(params[0]))];
    if (method === "eth_getTransactionByHash") return txs[params[0]];
    if (method === "eth_getTransactionReceipt") return receipts[params[0]];
    if (method === "eth_getLogs") return receipt.logs;
    if (method === "eth_getCode") return params[0]===plan.renderer.address ? renderer.deployedBytecode.object :
      params[0]===plan.collection.address ? runtime : "0x";
    if (method === "eth_call") {
      const isRenderer = params[0].to === plan.renderer.address, abi = isRenderer ? renderer.abi : rc.abi;
      const {functionName:name,args=[]} = decodeFunctionData({abi,data:params[0].data});
      const values = {VERSION:isRenderer?RELEASE.renderer:RELEASE.collection,INPUT_PROFILE:RELEASE.inputProfile,
        renderer:plan.renderer.address,rendererIdentity:plan.renderer.identity,trustedAuthorizer:plan.principals.authorizer.address,
        paused:true,defaultAdmin:plan.principals.delayedAdmin.address,defaultAdminDelay:172800n,
        pendingDefaultAdmin:[zeroAddress,0n],pendingDefaultAdminDelay:[0n,0n],
        eip712Domain:["0x0f",RELEASE.domainName,RELEASE.domainVersion,11155111n,plan.collection.address,zero,[]]};
      const result = roles.has(name) ? roles.get(name).id : name==="getRoleAdmin" ? zero :
        name==="hasRole" ? [...roles.values()].some(r=>r.id===args[0]&&r.account===args[1].toLowerCase()) : values[name];
      if (result===undefined) throw Error("Unimplemented fixture read: "+name);
      return encodeFunctionResult({abi,functionName:name,result});
    }
    throw Error("Non-read fixture method: "+method);
  };
  const sources = [0,1].map(i=>({id:"fixture-"+i,operatorReference:"synthetic-operator/"+i,
    request:async (method,params,signal) => {
      requests.push({source:i,method,params:structuredClone(params),signal});
      if (signal.aborted) throw Error("aborted");
      return mutate(method,params,structuredClone(answer(method,params)),i,requests);
    }}));
  return {config,plan,builds,accounts,transactions,txs,receipts,headers,requests,runtime,sources,
    policy:{timeoutMs:10000,maxHeadAgeMs:120000,maxFinalizedAgeMs:1800000,maxFutureSkewMs:5000,validityMs:15000,maxDeploymentSpan:256},
    now:()=>clock,advance:ms=>{clock+=ms;},mutate:fn=>{mutate=fn;}};
}
