import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult,
  keccak256, parseTransaction, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploymentFixture } from "./generative-deployment.mjs";
import { RELEASE } from "../generative-release.mjs";

/** Fabricated RPC history signed with PUBLIC test keys, never real Sepolia. */
export async function activeStateFixture({changes=false,passive=false}={}) {
  const f=await deploymentFixture(),abi=f.builds.GenerativeSignaturesV1RC1.abi,h=s=>keccak256(stringToHex(s)),q=n=>"0x"+BigInt(n).toString(16);
  const zero="0x"+"00".repeat(32),empty="0x"+"00".repeat(20);
  const extra=privateKeyToAccount(h("PUBLIC ACTIVE OBSERVER NEW MANAGER")),next=privateKeyToAccount(h("PUBLIC ACTIVE OBSERVER NEW SIGNER"));
  const roles=new Map([[zero,new Set([f.plan.principals.delayedAdmin.address])],...["AUTHORIZER_MANAGER_ROLE","PAUSER_ROLE","NONCE_REVOKER_ROLE"].map((r,i)=>
    [h(r),new Set([f.plan.principals[["authorizerManager","pauser","nonceRevoker"][i]].address])])]);
  const calls=[["unpauseMinting",[],f.accounts.pauser]];
  if(changes)calls.push(["grantRole",[h("AUTHORIZER_MANAGER_ROLE"),extra.address.toLowerCase()],f.accounts.delayedAdmin],
    ["revokeRole",[h("AUTHORIZER_MANAGER_ROLE"),f.plan.principals.authorizerManager.address],f.accounts.delayedAdmin],
    ["setTrustedAuthorizer",[next.address.toLowerCase()],extra],["revokeNonce",[h("retired nonce")],f.accounts.nonceRevoker],
    ["pauseMinting",[],f.accounts.pauser],["unpauseMinting",[],f.accounts.pauser]);
  if(passive) calls.push(["setApprovalForAll",[extra.address.toLowerCase(),true],next]);
  const headers=Array.from({length:calls.length+5},(_,i)=>({number:q(i),hash:i?h("TEST BLOCK/"+i):f.headers[0].hash,
    parentHash:i?i===1?f.headers[0].hash:h("TEST BLOCK/"+(i-1)):zero,timestamp:q(f.now()/1000-120+i*4),
    transactions:i===1||i===2?[...f.headers[i].transactions]:[]}));
  const transitions=[],revoked=new Set(),history=[...f.receipts[f.transactions.collection].logs];
  let authorizer=f.plan.principals.authorizer.address,paused=true;
  for(const [i,[functionName,args,account]] of calls.entries()) {
    const sender=account.address.toLowerCase(),block=headers[i+3],data=encodeFunctionData({abi,functionName,args});
    const serialized=await account.signTransaction({type:"eip1559",chainId:11155111,nonce:i,gas:300000n,maxFeePerGas:1000000000n,
      maxPriorityFeePerGas:1n,to:f.plan.collection.address,value:0n,data,accessList:[]});
    const txHash=keccak256(serialized),parsed=parseTransaction(serialized);block.transactions.push(txHash);
    const raw={type:"0x2",chainId:"0xaa36a7",hash:txHash,from:sender,to:f.plan.collection.address,nonce:q(i),gas:q(300000),maxFeePerGas:q(1000000000),
      maxPriorityFeePerGas:"0x1",value:"0x0",input:data,accessList:[],r:parsed.r,s:parsed.s,yParity:q(parsed.yParity),v:q(parsed.yParity),
      blockHash:block.hash,blockNumber:block.number,transactionIndex:"0x0"};
    const receipt={type:"0x2",transactionHash:txHash,blockHash:block.hash,blockNumber:block.number,transactionIndex:"0x0",from:sender,
      to:f.plan.collection.address,contractAddress:null,status:"0x1",gasUsed:q(50000),logs:[]};
    let eventName,eventArgs;
    if(functionName==="setApprovalForAll") {eventName="ApprovalForAll";eventArgs={owner:sender,operator:args[0],approved:args[1]};}
    else if(functionName==="setTrustedAuthorizer") {eventName="TrustedAuthorizerChanged";eventArgs={previousAuthorizer:authorizer,newAuthorizer:args[0]};authorizer=args[0];}
    else if(functionName==="grantRole"||functionName==="revokeRole") {const grant=functionName==="grantRole";eventName=grant?"RoleGranted":"RoleRevoked";eventArgs={role:args[0],account:args[1],sender};if(grant)roles.get(args[0]).add(args[1]);else roles.get(args[0]).delete(args[1]);}
    else if(functionName==="revokeNonce") {eventName="NonceRevoked";eventArgs={nonce:args[0]};revoked.add(args[0]);}
    else {paused=functionName==="pauseMinting";eventName=paused?"Paused":"Unpaused";eventArgs={account:sender};}
    const event=abi.find(e=>e.type==="event"&&e.name===eventName);
    receipt.logs.push({address:f.plan.collection.address,topics:encodeEventTopics({abi,eventName,args:eventArgs}).map(v=>v.toLowerCase()),
      data:encodeAbiParameters(event.inputs.filter(v=>!v.indexed),event.inputs.filter(v=>!v.indexed).map(v=>eventArgs[v.name])),
      blockHash:block.hash,blockNumber:block.number,transactionHash:txHash,transactionIndex:"0x0",logIndex:"0x0",removed:false});
    f.txs[txHash]=raw;f.receipts[txHash]=receipt;history.push(...receipt.logs);
    if(functionName!=="setApprovalForAll") transitions.push({transactionHash:txHash,sender,functionName,args});
  }
  const requests=[];let mutate=(_m,_p,v)=>v;
  const answer=(m,p)=>{
    if(m==="eth_chainId")return "0xaa36a7";
    if(m==="eth_getBlockByNumber")return headers[p[0]==="latest"?headers.length-1:p[0]==="finalized"?headers.length-2:Number(BigInt(p[0]))];
    if(m==="eth_getTransactionByHash")return f.txs[p[0]];
    if(m==="eth_getTransactionReceipt")return f.receipts[p[0]];
    if(m==="eth_getLogs")return history.filter(l=>BigInt(l.blockNumber)>=BigInt(p[0].fromBlock)&&BigInt(l.blockNumber)<=BigInt(p[0].toBlock));
    if(m==="eth_getCode")return p[0]===f.plan.collection.address?f.runtime:p[0]===f.plan.renderer.address?f.builds.SignatureRendererV1RC1.deployedBytecode.object:"0x";
    if(m==="eth_call"){
      const render=p[0].to===f.plan.renderer.address,a=render?f.builds.SignatureRendererV1RC1.abi:abi;
      const {functionName:name,args=[]}=decodeFunctionData({abi:a,data:p[0].data});
      const values={VERSION:render?RELEASE.renderer:RELEASE.collection,INPUT_PROFILE:RELEASE.inputProfile,renderer:f.plan.renderer.address,
        rendererIdentity:f.plan.renderer.identity,trustedAuthorizer:authorizer,paused,defaultAdmin:f.plan.principals.delayedAdmin.address,
        defaultAdminDelay:172800n,pendingDefaultAdmin:[empty,0n],pendingDefaultAdminDelay:[0n,0n],
        eip712Domain:["0x0f",RELEASE.domainName,RELEASE.domainVersion,11155111n,f.plan.collection.address,zero,[]]};
      const result=name==="hasRole"?roles.get(args[0]).has(args[1].toLowerCase()):name==="getRoleAdmin"?zero:name==="DEFAULT_ADMIN_ROLE"?zero:
        name.endsWith("_ROLE")?h(name):name==="revokedNonces"?revoked.has(args[0]):values[name];
      if(result===undefined)throw Error("Unimplemented fixture getter");return encodeFunctionResult({abi:a,functionName:name,result});
    }
    throw Error("Non-read method");
  };
  return {...f,headers,transitions,history,requests,extra,next,
    policy:{timeoutMs:10000,maxHeadAgeMs:120000,maxFinalizedAgeMs:1800000,maxFutureSkewMs:5000,validityMs:15000,
      maxHistorySpan:256,logBlockRange:2,maxLogs:128,maxTransactions:32},
    sources:[0,1].map(i=>({id:"fixture-"+i,operatorReference:"synthetic-operator/"+i,request:async(m,p,signal)=>{
      requests.push({source:i,method:m,params:structuredClone(p),signal});signal.throwIfAborted();return mutate(m,p,structuredClone(answer(m,p)),i,requests);
    }})),mutate:fn=>{mutate=fn;}};
}
