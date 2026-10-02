import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync, mkdtempSync,existsSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createServer as tcpServer} from 'node:net';
import {setTimeout as sleep} from 'node:timers/promises';
import canonicalize from 'canonicalize';
import {Client} from 'pg';
import {createPublicClient,createWalletClient,defineChain,http,encodeDeployData,encodeFunctionData,decodeEventLog,getAddress,keccak256,stringToHex,numberToHex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {buildAllowlist} from '../contracts/tools/pulse-allowlist.mjs';
import {expectedPulseRuntime,pulseIntegrationInventory} from '../contracts/tools/pulse-integration.mjs';
import {verifyPulseCandidate} from '../contracts/tools/pulse-candidate-lock.mjs';
import {PULSE_MINT_CANDIDATE} from '../src/openMint/pulseCandidate.ts';
import {openMintHandleKey} from '../src/openMint/authorization.ts';
import {generativeRendererIdentity} from '../src/openMint/generativeInputs.ts';
import {PublicChainGate} from '../src/openMint/publicChain.ts';
import {PostgresPulseEconomics} from '../src/openMint/persistence/pulseEconomics.ts';
import {PostgresMintRequests} from '../src/openMint/persistence/requests.ts';
import {PostgresWalletSessions} from '../src/openMint/persistence/sessions.ts';
import {PostgresWalletSubmissions} from '../src/openMint/persistence/walletSubmissions.ts';
import {PostgresGenerativeInputJournal} from '../src/openMint/persistence/generativeInputs.ts';
import {PostgresGenerativeAuthorizationIssuer} from '../src/openMint/persistence/generativeAuthorizations.ts';
import {PostgresAssessmentWorker} from '../src/openMint/persistence/assessmentWorker.ts';
import {OpenMintRepository} from '../src/openMint/persistence/repository.ts';
import {ExclusiveWriter} from '../src/openMint/persistence/writer.ts';
import {DurableMintRuntime} from '../src/openMint/persistence/runtimeService.ts';
import {createIsolatedGenerativeSite} from '../src/openMint/persistence/generativeSite.ts';
import {pulseBrowserRuntimeGrants,pulseRecoveryGrants} from '../src/openMint/persistence/runtimeRole.ts';
import {PostgresGenerativeRecovery} from '../src/openMint/persistence/generativeRecovery.ts';
import {GenerativeRecoveryChain} from '../src/openMint/generativeRecoveryChain.ts';
import {certifyPulseLocalDatabase} from '../src/openMint/persistence/pulseDatabaseCertification.ts';
import {disposablePostgres,installSchema} from '../src/openMint/persistence/fixtures/postgres.ts';
import {namespace,receipt} from '../src/openMint/persistence/fixtures/data.ts';
import {OPEN_MINT_CLIENT_SCRIPT} from '../src/openMint/clientScript.ts';
import {pulseC7BrowserDriver} from './pulse-c7-browser.mjs';

// No env file, URL, credentials, existing directory or deployment accepted.
// Every chain write uses this child and literal public fixture keys.
const args=process.argv.slice(2);
assert.equal(args.length,2);assert.equal(args[0],'--visual-tool');assert.ok(args[1].startsWith('/'));
assert.notEqual(process.env.NODE_ENV,'production');verifyPulseCandidate();
const output=mkdtempSync('/tmp/sg-pulse-c7-evidence-'), evidence={version:'sg-pulse-c7-rehearsal-v2',publicStartupApproved:false,output,browser:[],matrix:[],inventory:pulseIntegrationInventory().digest,
  localOnly:true,realProviderCalls:0,publicTransactions:0,singleAnvilNode:true,finality:'explicit-test-boundary-not-public-consensus',
  sourceSha256:Object.fromEntries(['pulse-c7-rehearsal.mjs','pulse-c7-browser.mjs'].map(f=>[f,createHash('sha256').update(readFileSync(new URL(f,import.meta.url))).digest('hex')]))};
const artifact=name=>JSON.parse(readFileSync(new URL(`../contracts/out/${name}.sol/${name}.json`,import.meta.url)));
const gallery=artifact('SignaturesPulseMintV1RC1'), rendererArtifact=artifact('SignatureRendererV1RC1');
const coreCreation=readFileSync(new URL('../contracts/vendor/pulse-core-v1.0.0/PulseCoreV1.creation.hex',import.meta.url),'utf8').trim();
const key=n=>privateKeyToAccount('0x'+n.toString(16).padStart(64,'0'));
const signer=key(1),buyer=key(2),other=key(3),operator=key(4),treasury=key(5);
const unusedPort=async()=>{const s=tcpServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const port=await unusedPort(),url=`http://127.0.0.1:${port}`;
const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--hardfork','prague','--timestamp',String(Math.floor(Date.now()/1000)),'--silent'],{stdio:['ignore','ignore','pipe']});
let childError;child.on('error',e=>childError=e);
const chain=defineChain({id:31337,name:'Disposable C7 only',nativeCurrency:{name:'Test ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[url]}}});
const transport=http(url,{retryCount:0,timeout:10000}),client=createPublicClient({chain,transport,cacheTime:0,pollingInterval:20});
const wallet=a=>createWalletClient({account:a,chain,transport});
const rpc=(method,params=[])=>client.request({method,params},{retryCount:0});
const mine=()=>rpc('evm_mine');
const waitReceipt=h=>client.waitForTransactionReceipt({hash:h,timeout:10000,pollingInterval:20});
const send=(a,to,data,value=0n,nonce)=>wallet(a).sendTransaction({to,data,value,gas:6000000n,gasPrice:1000000000n,nonce});
const deploy=async(code,abi=[],a=[])=>{const r=await waitReceipt(await wallet(operator).sendTransaction({data:encodeDeployData({abi,bytecode:code,args:a}),gas:16000000n,gasPrice:1000000000n}));assert.equal(r.status,'success');return r;};
const read=(at,name,a=[])=>client.readContract({address:at,abi:gallery.abi,functionName:name,args:a});
const contexts=[];
let cluster,admin;
async function collection(renderer,core,slots,until){
  await rpc('evm_setAutomine',[true]);
  const list=buildAllowlist(slots),pulse={k:600000000000n,genesisPrice:1000000000000n,genesisFloor:900000000000n,pts:1000000000n};
  const deployed=await deploy(gallery.bytecode.object,gallery.abi,[renderer,{chainId:31337n,core},{freeMintRoot:list.manifest.root,freeSlotCount:BigInt(slots.length),freeDeadline:until,treasury:treasury.address,pulse},
    {adminDelay:172800,admin:operator.address,manager:operator.address,pauser:operator.address,revoker:operator.address,authorizer:signer.address}]);
  const at=deployed.contractAddress;
  assert.equal((await waitReceipt(await send(operator,at,encodeFunctionData({abi:gallery.abi,functionName:'unpauseMinting'})))).status,'success');
  const sale={core:getAddress(core),coreRuntimeCodeHash:keccak256(await client.getCode({address:core})),treasury:treasury.address,root:list.manifest.root,slotCount:String(slots.length),freeDeadline:String(until),deployedAt:String(await read(at,'deployedAt')),
    config:Object.fromEntries(Object.entries(pulse).map(([k,v])=>[k,String(v)])),saleConfigHash:await read(at,'saleConfigHash')};
  const pin={address:getAddress(renderer),runtimeCodeHash:keccak256(await client.getCode({address:renderer})),inputProfile:'sg-generative-pulse-inputs-v1-rc1'};
  pin.identity=generativeRendererIdentity(renderer,pin.runtimeCodeHash,pin.inputProfile);
  assert.equal(await client.getCode({address:at}),expectedPulseRuntime({chainId:31337,contract:at,renderer:pin,sale},gallery));
  const ns={...namespace(),profile:'local-real',provenance:'grok'},dep=randomUUID(),origin=`http://127.0.0.1:${await unusedPort()}`;
  const config={contractProfile:'generative-pulse-v1-rc1',generativeRenderer:pin,pulse:sale,namespaceId:ns.id,deploymentId:dep,chainId:31337n,genesisHash:(await client.getBlock({blockNumber:0n})).hash,
    deploymentBlock:{number:deployed.blockNumber,hash:deployed.blockHash},contract:getAddress(at),runtimeCodeHash:keccak256(await client.getCode({address:at})),authorizer:signer.address,maxBlockAgeMs:120000,maxFutureSkewMs:5000,evidenceTtlMs:30000,observationTimeoutMs:10000};
  const binding={version:'sg-pulse-pipeline-v1',candidateLockSha256:verifyPulseCandidate().lockSha256,deployment:sale,slots:list.proofs.map(p=>({slotId:String(p.slotId),wallet:getAddress(p.wallet),proof:p.siblings}))};
  await admin.query('INSERT INTO open_mint.namespaces VALUES($1,$2,$3,$4)',[ns.id,ns.profile,ns.provenance,ns.policyVersion]);
  await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id,profile_version,expected_model,generation_enabled,valid_until,max_total,max_daily,max_active,max_queued,reservation_usd_ticks,max_exposure_usd_ticks) VALUES($1,'offline-C7','grok-offline-test',true,'2099-01-01',20,20,1,20,100,10000)`,[ns.id]);
  await admin.query('INSERT INTO open_mint.session_profiles VALUES($1,$2,31337)',[ns.id,origin]);
  await admin.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms) VALUES($1,$2,31337,$3,$4,$5,$6,$7,$8,30000,120000,5000)`,[ns.id,dep,at.toLowerCase(),config.genesisHash,config.runtimeCodeHash,signer.address.toLowerCase(),String(deployed.blockNumber),deployed.blockHash]);
  await admin.query('INSERT INTO open_mint.generative_input_profiles VALUES($1,$2,$3,$4,$5,$6)',[ns.id,dep,pin.inputProfile,pin.address,pin.runtimeCodeHash,pin.identity]);
  await admin.query('INSERT INTO open_mint.generative_issuance_profiles VALUES($1,$2,true,30,5000,30000,120000,5000)',[ns.id,dep]);
  await admin.query('INSERT INTO open_mint.pulse_profiles VALUES($1,$2,$3,$4,$5,$6)',[ns.id,dep,binding.version,binding.candidateLockSha256,sale.saleConfigHash,Buffer.from(canonicalize(binding))]);
  const c={ns,dep,origin,at,config,binding,deployed,counts:{x:0,grok:0,sign:0,broadcast:0,send:0},flow:null,finalized:deployed.blockNumber,session:null};contexts.push(c);
  c.rpcs=['disposable-single-node-A','disposable-single-node-B'].map(id=>({id,request:async(method,params,signal)=>{signal.throwIfAborted();const v=await rpc(method,method==='eth_getBlockByNumber'&&params[0]==='finalized'?[numberToHex(c.finalized),false]:params);signal.throwIfAborted();return v;}}));
  c.gate=new PublicChainGate(config,c.rpcs);
  c.observe=async(input,signal)=>{const b=await client.getBlock();return c.gate.preflight({block:{number:b.number,hash:b.hash},handle:input.handle,recipient:input.recipient,nonce:input.nonce,pulseSlots:c.binding.slots.filter(s=>s.wallet.toLowerCase()===input.recipient.toLowerCase()).map(s=>s.slotId),signal});};
  c.boot=async(start=true)=>{
    const factory=()=>new Client({...cluster.config,user:'sg_pulse_c7',options:'-c search_path=pg_catalog'});
    c.writer=await ExclusiveWriter.acquire(factory); const repository=await OpenMintRepository.open(c.writer,ns);
    c.economics=await PostgresPulseEconomics.open(c.writer,ns.id,dep); c.requests=await PostgresMintRequests.open(repository,dep,c.economics);
    c.sessions=await PostgresWalletSessions.open({writer:c.writer,namespaceId:ns.id,origin,chainId:31337});
    c.journal=await PostgresGenerativeInputJournal.open(c.writer,ns.id,dep);c.issuer=await PostgresGenerativeAuthorizationIssuer.open(c.requests,c.journal);
    const worker=new PostgresAssessmentWorker(c.requests,{timeoutMs:30000,refreshEligibility:async(input,signal)=>c.observe({handle:input.handle,recipient:input.recipient,nonce:keccak256(stringToHex('offline-worker'))},signal),
      identityResolver:{provenance:'x-api',resolve:async(handle,execution)=>{c.counts.x++;await execution.recordReceipt(receipt('x-identity','1'));if(c.afterIdentity)await c.afterIdentity();return{canonicalHandle:handle,username:c.spelling?.get(handle)||handle,userId:'123',verifiedAt:new Date().toISOString(),provenance:'x-api',freshness:'verified-at-preparation'};}},
      provider:{provenance:'grok',model:'grok-offline-test',assess:async(handle,snapshot,execution)=>{c.counts.grok++;await execution.recordReceipt(receipt('grok','1'));if(c.afterAssessment)await c.afterAssessment();return{handle,mbti:'INTJ',model:'grok-offline-test',providerResponseId:'OFFLINE-C7-'+handle,sourceUrls:['https://x.com/'+snapshot.username],xUserId:snapshot.userId};}}});
    c.runtime=new DurableMintRuntime({contractProfile:'generative-pulse-v1-rc1',sessions:c.sessions,requests:c.requests,worker,journal:c.journal,issuer:c.issuer,signer:{address:signer.address,signTypedData:async data=>{c.counts.sign++;return signer.signTypedData(data);}},eligibility:c.observe,eligibilityTimeoutMs:10000});
    const deployment={id:dep,namespaceId:ns.id,chainId:'31337',contractAddress:at.toLowerCase(),manifestHash:keccak256(stringToHex('C7-offline-'+dep)),deploymentBlock:String(deployed.blockNumber),deploymentBlockHash:deployed.blockHash,generativeRenderer:pin,policy:{id:'explicit-test-finality',rollbackBlocks:8,snapshotRetentionBlocks:128}};
    c.site=await createIsolatedGenerativeSite({runtime:c.runtime,observation:{deployment,config,rpcs:c.rpcs,maxHeadLag:0,maxFinalizedLag:0,maxFinalizedAgeMs:600000},polling:{intervalMs:1000,maxBackoffMs:2000,passTimeoutMs:10000}});
    wrap(c);if(start)await c.site.start();
  };
  c.close=async()=>{await c.site?.close();await c.writer?.close();c.site=null;c.writer=null;};
  c.restart=async()=>{await c.close();await c.boot();};
  c.call=async(path,body,cookie)=>{const response=await fetch(origin+path,{method:body?'POST':'GET',redirect:'error',headers:{...(cookie?{cookie}:{}),...(body?{origin,'content-type':'application/json','x-csrf-token':c.session.csrf}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});const v=await response.json();return{status:response.status,body:v};};
  return c;
}
function wrap(c){
  const control='/__c7_'+c.dep,server=c.site.server,handler=server.listeners('request')[0];server.removeListener('request',handler);
  server.on('request',async(req,res)=>{
    const json=(v,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(v));};
    try{
      if(req.url==='/assets/generative-wallet.js'&&c.flow){
        res.setHeader('content-type','text/javascript');res.end(`sessionStorage.setItem('sg-open:wallet-provider',JSON.stringify('legacy:rabby'));window.ethereum={isRabby:true,on(){},removeListener(){},async request(v){const r=await fetch('${control}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet:v})});const b=await r.json();if(b.error)throw Object.assign(Error(b.error.message),{code:b.error.code});return b.result;}};\n`+OPEN_MINT_CLIENT_SCRIPT+`\n(${pulseC7BrowserDriver.toString()})(${JSON.stringify({control,handle:c.flow.handle,mode:c.flow.mode,scenario:c.flow.scenario})});`);return;
      }
      if(req.url===control&&req.method==='GET'){json({ready:!c.restarting});return;}
      if(req.url===control&&req.method==='POST'){
        assert.equal(req.socket.remoteAddress,'127.0.0.1');assert.equal(req.headers.origin,c.origin);
        let raw='';for await(const part of req){raw+=part;assert.ok(raw.length<16384);}const v=JSON.parse(raw),f=c.flow;
        if(v.wallet){const{method,params=[]}=v.wallet;let result;
          if(method==='eth_accounts'||method==='eth_requestAccounts')result=[buyer.address];
          else if(method==='personal_sign')result=await buyer.signMessage({message:params[0]});
          else if(method==='eth_sendTransaction'){
            c.counts.send++;f.sends++;assert.deepEqual(params,[f.plan]);assert.ok(f.permit);
            if(f.scenario==='reject'&&f.sends===1){json({error:{message:'User rejected fixture request',code:4001}});return;}
            assert.equal(f.broadcasts,0,'duplicate browser broadcast');f.broadcasts++;c.counts.broadcast++;
            f.hash=await send(buyer,c.at,params[0].data,BigInt(params[0].value),Number(BigInt(params[0].nonce)));
            if(f.scenario==='uncertain'){json({error:{message:'Fixture lost wallet response',code:-32000}});return;}result=f.hash;
          }else{assert.ok(['eth_chainId','eth_getCode','eth_getBlockByNumber','eth_getTransactionCount','eth_call','eth_getTransactionByHash','eth_getTransactionReceipt'].includes(method));result=await rpc(method,params);}
          json({result});return;
        }
        const cookie=req.headers.cookie;c.session=await c.sessions.requireSession(cookie);
        if(v.action==='pending'||v.action==='restart'){
          const pending=await c.call('/api/mints/status/'+v.code,undefined,cookie);assert.equal(pending.status,200);assert.equal(pending.body.state,'pending');
          assert.equal(f.broadcasts,1);assert.deepEqual({x:c.counts.x-f.before.x,grok:c.counts.grok-f.before.grok,sign:c.counts.sign-f.before.sign},{x:1,grok:1,sign:1});
          if(v.action==='restart'){
            c.restarting=true;
            res.once('finish',()=>{c.restart().then(()=>{c.restarting=false;}).catch(e=>{c.restartError=e;console.error(e);});});
          }json({});return;
        }
        if(v.action==='include'){await mine();f.receipt=await waitReceipt(f.hash);assert.equal(f.receipt.status,'success');json({});return;}
        if(v.action==='finalize'){c.finalized=f.receipt.blockNumber;const end=Date.now()+20000;while(Date.now()<end){if((await c.site.reads.lookup(f.handle.toLowerCase())).state==='confirmed')break;await sleep(100);}assert.equal((await c.site.reads.lookup(f.handle.toLowerCase())).state,'confirmed');json({});return;}
        assert.fail('Unknown C7 control');
      }
      const end=res.end.bind(res);
      if(req.url==='/api/assessments'||req.url==='/api/mints/authorize'||req.url==='/api/mints/begin')res.end=function(data,...rest){
        if(res.statusCode<300&&c.flow&&data){const v=JSON.parse(String(data));if(req.url==='/api/assessments')c.flow.code=v.code;if(v.transaction)c.flow.plan=v.transaction;if(v.permit)c.flow.permit=v.permit;}return end(data,...rest);
      };
      handler(req,res);
    }catch(e){json({error:{message:String(e.stack||e),code:-32000}},500);}
  });
}
async function browserFlow(c,handle,mode,scenario='success'){
  c.spelling??=new Map();c.spelling.set(handle.toLowerCase(),handle);
  c.flow={handle,mode,scenario,sends:0,broadcasts:0,before:{...c.counts}};
  await mine(); // New block after the previous paid inclusion, as on a live chain.
  await rpc('evm_setAutomine',[false]);
  const beforeBalance=await client.getBalance({address:buyer.address}),beforeTreasury=await client.getBalance({address:treasury.address});
  const screenshot=output+'/'+handle+'.png';
  const{stdout}=await promisify(execFile)(process.execPath,[args[1],'--url',c.origin+'/mint?handle='+handle,'--viewport',mode==='free'?'1024x1200':'390x1200','--color-scheme',mode==='free'?'light':'dark','--wait-for','[data-c7-result=done]','--timeout-ms','100000','--disable-cache','--screenshot',screenshot,'--eval','JSON.parse(sessionStorage.getItem("sg-c7-flow"))'],{timeout:115000,maxBuffer:3*1024*1024});
  const result=JSON.parse(stdout);assert.ok(result.evaluation,stdout);assert.equal(result.evaluation.error,undefined,JSON.stringify(result.evaluation));assert.equal(result.evaluation.phase,'complete');assert.equal(result.evaluation.imageLoaded,true);assert.equal(result.evaluation.overflow,false);
  const f=c.flow,r=f.receipt;assert.equal(f.broadcasts,1);assert.equal(f.sends,scenario==='reject'?2:1);
  const economic=r.logs.map(l=>{try{return decodeEventLog({abi:gallery.abi,...l});}catch{return null;}}).find(x=>x?.eventName==='MintEconomics');assert.ok(economic);
  assert.equal(economic.args.mintMode,mode==='free'?0:1);assert.equal(BigInt(f.plan.value),mode==='free'?0n:10000000000000000n);
  const treasuryPaid=(await client.getBalance({address:treasury.address}))-beforeTreasury;
  assert.equal(treasuryPaid,economic.args.price);
  assert.equal(beforeBalance-(await client.getBalance({address:buyer.address})),r.gasUsed*r.effectiveGasPrice+treasuryPaid,'unused ceiling must be refunded');
  const persisted=(await admin.query('SELECT payload FROM open_mint.projection_mints WHERE deployment_id=$1 AND handle=$2',[c.dep,handle.toLowerCase()])).rows[0];assert.ok(persisted);
  assert.equal(JSON.parse(persisted.payload.toString()).economics.price,String(treasuryPaid));
  const networkErrors=result.requests.filter(x=>x.status>=400);assert.deepEqual(networkErrors,[]);
  evidence.browser.push({handle,mode,scenario,stages:result.evaluation.stages,sends:f.sends,broadcasts:f.broadcasts,providerCalls:{x:c.counts.x-f.before.x,grok:c.counts.grok-f.before.grok},signs:c.counts.sign-f.before.sign,
    price:String(treasuryPaid),cap:f.plan.value,refundVerified:true,gas:String(r.gasUsed),transactionHash:r.transactionHash,screenshot,imageLoaded:result.evaluation.imageLoaded,overflow:result.evaluation.overflow,previewTiles:result.evaluation.previewTiles,provenanceVerified:result.evaluation.provenanceVerified,networkErrors});
  console.log(JSON.stringify({browser:handle,stages:result.evaluation.stages}));c.flow=null;
}
async function verified(c,a){
  let session=(await c.sessions.session()).session;
  const challenge=await c.sessions.challenge(session.id,a.address);
  await c.sessions.verify(session.id,challenge.challengeId,await a.signMessage({message:challenge.message}));
  session=(await c.sessions.session(c.sessions.cookie(session))).session;
  return {session,origin:c.origin,csrf:session.csrf};
}
async function prepare(c,a,handle,consent,intent){
  intent??=await verified(c,a);
  const request=await c.runtime.create(handle,intent,consent);await c.runtime.idle();
  assert.equal((await c.runtime.status(request.code,intent.session)).status,'ready');
  return {request,intent,handle,a};
}
async function dispatch(c,p){return c.site.browser.begin(p.request.code,true,p.intent,new AbortController().signal);}
async function broadcast(c,p,plan){c.counts.send++;c.counts.broadcast++;return send(p.a,c.at,plan.transaction.data,BigInt(plan.transaction.value),Number(BigInt(plan.transaction.nonce)));}
async function expireFree(c){
  try{
  await sleep(Math.max(0,Number(c.binding.deployment.freeDeadline)*1000+1100-Date.now()));
  assert.equal((await read(c.at,'saleStatus')).phase,0);
  const intent=await verified(c,buyer);
  await assert.rejects(c.runtime.mintOptions('C8_Clock',intent.session),/fresh on-chain paid quote/);
  // evm_revert also restores Anvil's clock offset. Anchor this boundary block
  // to the wall time we actually waited for, not a synthetic future deadline.
  await rpc('evm_setNextBlockTimestamp',[Math.floor(Date.now()/1000)]);
  await mine();assert.equal((await read(c.at,'saleStatus')).phase,1);
  const quote=await c.runtime.mintOptions('C8_Clock',intent.session);
  assert.equal(quote.phase,'paid');assert.equal(BigInt(quote.priceWei),await read(c.at,'getCurrentPrice'));
  }catch(error){evidence.hookFailure=String(error.stack||error);console.error(evidence.hookFailure);throw error;}
}
async function reorgMatrix(c,mode){
  await rpc('evm_setAutomine',[true]);
  const p=await prepare(c,buyer,'C8_'+mode+'_Reorg',{mode,maxPriceWei:mode==='free'?'0':'10000000000000000'});
  const plan=await dispatch(c,p),inputs=await c.journal.load(p.handle.toLowerCase());
  const request=await c.requests.get(p.request.code,p.intent.session.id);
  const reservedId=(await admin.query('SELECT authorization_id FROM open_mint.generative_authorizations WHERE namespace_id=$1 AND request_id=$2',[c.ns.id,request.id])).rows[0].authorization_id;
  const reserved=await c.issuer.inspect(reservedId);
  const before={freeMinted:await read(c.at,'freeMinted'),status:await read(c.at,'saleStatus'),treasury:await client.getBalance({address:treasury.address}),
    pulse:mode==='paid'?await read(c.at,'getPulseState'):null};
  const snapshot=await rpc('evm_snapshot');
  const minted=await waitReceipt(await broadcast(c,p,plan));assert.equal(minted.status,'success');
  const waitFor=async(check)=>{for(let i=0;i<100;i++){if(await check())return;await sleep(100);}assert.fail('C8 reorg observation timed out');};
  await waitFor(async()=> (await c.site.reads.lookup(p.handle.toLowerCase())).state==='confirming');
  const included=(await admin.query('SELECT payload FROM open_mint.projection_mints WHERE deployment_id=$1 AND handle=$2',[c.dep,p.handle.toLowerCase()])).rows[0];
  assert.equal(JSON.parse(included.payload.toString()).economics.mintMode,mode==='free'?0:1);
  assert.ok(!(await c.site.reads.gallery({limit:50})).items.some(x=>x.handle===p.handle.toLowerCase()));
  const effects={...c.counts};
  assert.equal(await rpc('evm_revert',[snapshot]),true);
  // Only this disposable node: don't let an orphaned transaction re-enter its
  // pool while testing the empty replacement branch. Never resend via the app.
  await rpc('anvil_removePoolTransactions',[buyer.address]);await mine();
  assert.notEqual((await client.getBlock({blockNumber:minted.blockNumber})).hash,minted.blockHash);
  await waitFor(async()=> (await admin.query('SELECT 1 FROM open_mint.projection_mints WHERE deployment_id=$1 AND handle=$2',[c.dep,p.handle.toLowerCase()])).rows.length===0);
  assert.equal((await c.site.reads.lookup(p.handle.toLowerCase())).state,'unknown');
  assert.ok(!(await c.site.reads.gallery({limit:50})).items.some(x=>x.handle===p.handle.toLowerCase()));
  assert.equal(await read(c.at,'mintedHandle',[openMintHandleKey(p.handle.toLowerCase())]),false);
  assert.equal(await read(c.at,'usedNonces',[reserved.authorization.nonce]),false);
  assert.equal(await read(c.at,'freeMinted'),before.freeMinted);
  assert.deepEqual(await read(c.at,'saleStatus'),before.status);
  assert.equal(await client.getBalance({address:treasury.address}),before.treasury);
  if(mode==='paid')assert.deepEqual(await read(c.at,'getPulseState'),before.pulse);
  else{
    assert.equal(await read(c.at,'isFreeSlotClaimed',[BigInt(reserved.authorization.slotId)]),false);
    for(const table of ['pulse_sponsorships','pulse_slot_heads'])assert.equal((await admin.query('SELECT count(*)::int AS n FROM open_mint.'+table+' WHERE namespace_id=$1 AND request_id=$2',[c.ns.id,request.id])).rows[0].n,1);
  }
  assert.deepEqual(await c.journal.load(p.handle.toLowerCase()),inputs);
  assert.equal((await new PostgresWalletSubmissions(c.requests).state(p.request.code,p.intent.session.id)).blocked,true);
  await assert.rejects(dispatch(c,p));assert.deepEqual(c.counts,effects);
  evidence.matrix.push({scenario:mode+'-unfinalized-reorg',confirmingWithdrawn:true,galleryExcluded:true,economicsRolledBack:true,
    signedAuthorityRetained:true,acceptedInputsRetained:true,noAutomaticResend:true,...(mode==='free'?{slotReservationAndSponsorshipRetained:true}:{}),transactionHash:minted.transactionHash});
}
async function economicMatrix(renderer,core){
  await rpc('evm_setAutomine',[true]);
  const deadline=await collection(renderer,core,[buyer.address,buyer.address],(await client.getBlock()).timestamp+12n);await deadline.boot(false);
  deadline.afterAssessment=()=>expireFree(deadline);
  const free=await prepare(deadline,buyer,'C7_Deadline',{mode:'free',maxPriceWei:'0'});deadline.afterAssessment=null;
  const accepted=await deadline.journal.load(free.handle.toLowerCase());assert.ok(accepted);
  await assert.rejects(deadline.runtime.authorize(free.request.code,true,free.intent),/phase or price changed/);
  assert.deepEqual(deadline.counts,{x:1,grok:1,sign:0,broadcast:0,send:0});
  const paid=await prepare(deadline,buyer,free.handle,{mode:'paid',maxPriceWei:'10000000000000000'},free.intent);
  assert.deepEqual(await deadline.journal.load(free.handle.toLowerCase()),accepted);
  assert.equal(deadline.counts.x,1);assert.equal(deadline.counts.grok,1);
  const plan=await dispatch(deadline,paid),r=await waitReceipt(await broadcast(deadline,paid,plan));assert.equal(r.status,'success');
  const status=await read(deadline.at,'saleStatus');assert.equal(status.endReason,2);assert.equal(status.paidStartTime,BigInt(deadline.binding.deployment.freeDeadline));
  assert.equal(await read(deadline.at,'freeMinted'),0n);assert.equal(await read(deadline.at,'isFreeSlotClaimed',[0n]),false);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM open_mint.pulse_sponsorships WHERE namespace_id=$1',[deadline.ns.id])).rows[0].n,1);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM open_mint.pulse_slot_heads WHERE namespace_id=$1',[deadline.ns.id])).rows[0].n,0);
  evidence.matrix.push({scenario:'free-assessment-crosses-deadline',counts:{...deadline.counts},assessmentRetained:true,unusedSlotsExpired:true,paidStartTime:String(status.paidStartTime),transactionHash:r.transactionHash});
  // A stale price can never silently enlarge the signed payment ceiling.
  const quote=await read(deadline.at,'getCurrentPrice');
  const stale=await prepare(deadline,buyer,'C7_Stale',{mode:'paid',maxPriceWei:String(quote)});
  const competitor=await prepare(deadline,other,'C7_Price',{mode:'paid',maxPriceWei:'10000000000000000'});
  const advance=await dispatch(deadline,competitor);assert.equal((await waitReceipt(await broadcast(deadline,competitor,advance))).status,'success');
  const newQuote=await read(deadline.at,'getCurrentPrice');assert.ok(newQuote>quote);
  const before={...deadline.counts};await assert.rejects(deadline.runtime.authorize(stale.request.code,true,stale.intent),/phase or price changed/);assert.deepEqual(deadline.counts,before);
  const renewed=await prepare(deadline,buyer,stale.handle,{mode:'paid',maxPriceWei:'10000000000000000'},stale.intent);
  assert.equal(deadline.counts.x,before.x);assert.equal(deadline.counts.grok,before.grok);
  evidence.matrix.push({scenario:'quote-change-requires-new-explicit-ceiling',oldPrice:String(quote),newPrice:String(newQuote),noExtraProviderOrSigner:true});
  const race=await prepare(deadline,other,'C7_Race',{mode:'paid',maxPriceWei:'10000000000000000'});
  const a=await dispatch(deadline,renewed),b=await dispatch(deadline,race),state=await read(deadline.at,'getPulseState');
  const treasuryBefore=await client.getBalance({address:treasury.address});
  await rpc('evm_setAutomine',[false]);const h1=await broadcast(deadline,renewed,a),h2=await broadcast(deadline,race,b);await mine();
  const receipts=await Promise.all([waitReceipt(h1),waitReceipt(h2)]);assert.equal(receipts[0].blockNumber,receipts[1].blockNumber);
  assert.equal(receipts.filter(x=>x.status==='success').length,1);assert.equal(receipts.filter(x=>x.status==='reverted').length,1);
  const after=await read(deadline.at,'getPulseState');assert.equal(after.epochIndex,state.epochIndex+1n);
  const failed=receipts[0].status==='reverted'?renewed:race;
  const winner=failed===renewed?race:renewed;
  assert.equal(await read(deadline.at,'mintedHandle',[openMintHandleKey(winner.handle.toLowerCase())]),true);
  assert.equal(await read(deadline.at,'mintedHandle',[openMintHandleKey(failed.handle.toLowerCase())]),false);
  assert.deepEqual(receipts.find(x=>x.status==='reverted').logs,[]);
  const success=receipts.find(x=>x.status==='success');const e=success.logs.map(l=>{try{return decodeEventLog({abi:gallery.abi,...l});}catch{return null;}}).find(x=>x?.eventName==='MintEconomics');
  assert.equal((await client.getBalance({address:treasury.address}))-treasuryBefore,e.args.price);
  evidence.matrix.push({scenario:'same-block-paid-competition',statuses:receipts.map(x=>x.status),epochAdvance:'1',winnerHandleMinted:true,failedHandleUnminted:true,failedReceiptHasNoLogs:true,treasuryPaid:String(e.args.price),transactionHashes:[h1,h2],counts:{...deadline.counts}});
  const row=(await admin.query('SELECT authorization_id FROM open_mint.generative_authorizations WHERE namespace_id=$1 AND handle=$2',[deadline.ns.id,failed.handle.toLowerCase()])).rows[0];assert.ok(row);
  const reserved=await deadline.issuer.inspect(row.authorization_id),savedInputs=await deadline.journal.load(failed.handle.toLowerCase()),effects={...deadline.counts};
  assert.equal(await read(deadline.at,'usedNonces',[reserved.authorization.nonce]),false);
  await deadline.close();await rpc('evm_setAutomine',[true]);
  await admin.query('UPDATE open_mint.generative_issuance_profiles SET enabled=false WHERE namespace_id=$1 AND deployment_id=$2',[deadline.ns.id,deadline.dep]);
  deadline.writer=await ExclusiveWriter.acquire(()=>new Client({...cluster.config,user:'sg_pulse_c7_recovery',options:'-c search_path=pg_catalog'}));
  const repository=await OpenMintRepository.open(deadline.writer,deadline.ns),economics=await PostgresPulseEconomics.open(deadline.writer,deadline.ns.id,deadline.dep);
  const requests=await PostgresMintRequests.open(repository,deadline.dep,economics),journal=await PostgresGenerativeInputJournal.open(deadline.writer,deadline.ns.id,deadline.dep),issuer=await PostgresGenerativeAuthorizationIssuer.open(requests,journal);
  const recovery=await PostgresGenerativeRecovery.open(issuer,new GenerativeRecoveryChain(deadline.config,deadline.rpcs));
  await assert.rejects(recovery.plan(reserved.id,'Retire expired C7 same-block loser',new AbortController().signal));
  await sleep(Math.max(0,Number(reserved.authorization.deadline)*1000+1100-Date.now()));await mine();deadline.finalized=(await client.getBlock()).number;
  const review=await recovery.plan(reserved.id,'Retire expired C7 same-block loser',new AbortController().signal);
  assert.deepEqual(await recovery.apply(review),review);assert.deepEqual(await recovery.outcome(review.recoveryId),review);
  assert.deepEqual(await journal.load(failed.handle.toLowerCase()),savedInputs);assert.deepEqual(deadline.counts,effects);
  assert.equal((await admin.query('SELECT enabled FROM open_mint.generative_issuance_profiles WHERE namespace_id=$1 AND deployment_id=$2',[deadline.ns.id,deadline.dep])).rows[0].enabled,false);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM open_mint.pulse_sponsorships WHERE namespace_id=$1',[deadline.ns.id])).rows[0].n,1);
  evidence.matrix.push({scenario:'restricted-operator-recovery-after-real-revert',beforeExpiryBlocked:true,authorizationRetired:true,acceptedInputsRetained:true,sponsorshipRetained:true,issuanceRemainsDisabled:true,noNewEffects:true});
  await deadline.close();
  // Expiry between identity and Grok must stop before the paid provider leg.
  const stopped=await collection(renderer,core,[buyer.address],(await client.getBlock()).timestamp+10n);await stopped.boot(false);stopped.afterIdentity=()=>expireFree(stopped);
  const intent=await verified(stopped,buyer),req=await stopped.runtime.create('C7_No_Grok',intent,{mode:'free',maxPriceWei:'0'});await stopped.runtime.idle();
  assert.equal((await stopped.runtime.status(req.code,intent.session)).status,'failed');
  assert.deepEqual(stopped.counts,{x:1,grok:0,sign:0,broadcast:0,send:0});
  evidence.matrix.push({scenario:'deadline-before-Grok-dispatch',counts:{...stopped.counts},noAutomaticPaidFallback:true});await stopped.close();
}
try{
  for(let i=0;i<100;i++){if(childError)throw childError;assert.equal(child.exitCode,null);try{assert.equal(await client.getChainId(),31337);break;}catch{await sleep(50);}}
  for(const a of[operator,buyer,other])await rpc('anvil_setBalance',[a.address,'0x56bc75e2d63100000']);
  const core=(await deploy(coreCreation)).contractAddress;assert.equal(keccak256(await client.getCode({address:core})),PULSE_MINT_CANDIDATE.pulseRuntimeCodeHash);
  const renderer=(await deploy(rendererArtifact.bytecode.object,rendererArtifact.abi)).contractAddress;
  cluster=disposablePostgres();admin=new Client({...cluster.config,options:'-c search_path=pg_catalog'});await admin.connect();await installSchema(admin);
  for(const f of['requests-schema.sql','generative-input-schema.sql','generative-release-profile-schema.sql','generative-authorization-schema.sql','wallet-submission-schema.sql','generative-recovery-schema.sql','pulse-schema.sql','../projection/projection-schema.sql','../projection/projection-v2.sql','../projection/projection-v3.sql'])await admin.query(readFileSync(new URL('../src/openMint/persistence/'+f,import.meta.url),'utf8'));
  await admin.query('CREATE ROLE sg_pulse_c7 LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');await admin.query(pulseBrowserRuntimeGrants('sg_pulse_c7'));
  await admin.query('CREATE ROLE sg_pulse_c7_recovery LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');await admin.query(pulseRecoveryGrants('sg_pulse_c7_recovery'));
  const audit=new Client({...cluster.config,user:'sg_pulse_c7',options:'-c search_path=pg_catalog'});await audit.connect();try{await certifyPulseLocalDatabase(audit,'open_mint_test',randomUUID(),randomUUID());}finally{await audit.end();}
  const main=await collection(renderer,core,[buyer.address,buyer.address],(await client.getBlock()).timestamp+600n);await main.boot();
  await browserFlow(main,'C7_Free_A','free');assert.equal(await read(main.at,'isFreeSlotClaimed',[0n]),true);assert.equal(await read(main.at,'isFreeSlotClaimed',[1n]),false);
  await browserFlow(main,'C7_Free_B','free');assert.equal(await read(main.at,'freeMinted'),2n);assert.equal((await read(main.at,'saleStatus')).endReason,1);
  await browserFlow(main,'C7_Paid_A','paid','reject');await browserFlow(main,'C7_Paid_B','paid','uncertain');
  evidence.matrix.push({scenario:'exhaustion',freeMinted:'2',repeatedWallet:true,paidEpoch:String((await read(main.at,'getPulseState')).epochIndex),counts:{...main.counts}});
  await reorgMatrix(main,'paid');
  await main.close();
  await economicMatrix(renderer,core);
  const unfinalized=await collection(renderer,core,[buyer.address,buyer.address],(await client.getBlock()).timestamp+600n);await unfinalized.boot();
  await reorgMatrix(unfinalized,'free');await unfinalized.close();
  evidence.status='passed';
}catch(e){evidence.status='failed';evidence.error=String(e.stack||e);throw e;}
finally{
  const errors=[];
  for(const c of contexts)await c.close().catch(e=>errors.push(String(e)));
  await admin?.end().catch(e=>errors.push(String(e)));
  try{cluster?.stop();}catch(e){errors.push(String(e));}
  if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
  evidence.cleanup={writersClosed:contexts.every(c=>!c.writer&&!c.site),postgresRemoved:!cluster||!existsSync(cluster.config.host),anvilStopped:child.exitCode!==null||child.signalCode!==null,activeRehearsalUntouched:true,errors};
  if(errors.length){evidence.status='failed';evidence.cleanupFailure=true;}
  await writeFile(output+'/report.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({evidence:output+'/report.json',status:evidence.status}));
  if(errors.length)throw Error('Disposable C7 cleanup requires review');
}
