import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { pulseC7BrowserDriver } from '../../scripts/pulse-c7-browser.mjs';

const flush = async () => { for (let i=0;i<50;i++) await Promise.resolve(); };

/** In-memory entry-only driver: no server, wallet provider, signing or chain. */
function entryHarness(mode, overrides={}) {
  const handle='C7Browser01', calls=[], storage=new Map(), now=Date.now();
  const input={value:'',dispatchEvent(event){calls.push(['handle-input',event.type,this.value]);}};
  const internal={type:'hidden',value:''};
  const cap={value:overrides.ceiling??'',dispatchEvent(event){calls.push(['ceiling-input',event.type,this.value]);submit.disabled=false;}};
  const submit={disabled:true,click(){calls.push(['submit',internal.value,cap.value]);}};
  const form={dataset:{pulseMint:'true'},querySelector(selector){
    return {'input[name=handle]':input,'input[name=pulse-mode]':internal,'input[name=pulse-max-eth]':cap,'button[type=submit]':submit}[selector]??null;
  }};
  const wallet={disabled:false,click(){
    calls.push(['connect']);
    const phase=overrides.phase??mode;
    form.dataset.pulseQuote=JSON.stringify({handle:handle.toLowerCase(),phase,freeAvailable:overrides.freeAvailable??true,validUntil:now+10000});
    internal.value=phase;
    if(phase==='free')submit.disabled=false;
  }};
  const document={body:{dataset:{},innerText:''},querySelector(selector){
    return {'[data-assessment-request]':form,'[data-connect-wallet]':wallet,'[data-connect-wallet]:not(:disabled)':wallet}[selector]??null;
  }};
  runInNewContext(`(${pulseC7BrowserDriver.toString()})(${JSON.stringify({control:'/isolated-control',handle,mode,scenario:'normal'})})`,{
    document,sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    location:{pathname:'/mint'},Date:class extends Date{static now(){return now;}},Event,
    setTimeout(){throw Error('Unexpected waiting in isolated entry harness');},fetch(){throw Error('No network allowed in entry harness');},
  });
  return {calls,storage,document,input,cap};
}

for(const mode of ['free','paid'])test(`C7 driver waits for automatic ${mode} phase selection and submits only through the actual CTA`,async()=>{
  const h=entryHarness(mode);await flush();
  assert.deepEqual(h.calls.slice(0,2),[['handle-input','input','C7Browser01'],['connect']]);
  const submit=h.calls.filter(call=>call[0]==='submit');
  assert.deepEqual(submit,[['submit',mode,mode==='paid'?'0.01':'']]);
  assert.equal(h.calls.some(call=>call[0]==='ceiling-input'),mode==='paid');
  const saved=JSON.parse(h.storage.get('sg-c7-flow'));
  assert.equal(saved.phase,'sent');
  assert.deepEqual(saved.stages,['SIWE','automatic-phase-quote',`explicit-${mode}-mint`]);
  assert.equal(saved.error,undefined);
});

for(const scenario of [
  {mode:'free',phase:'paid',message:'Verified sale phase does not match'},
  {mode:'free',freeAvailable:false,message:'no unused free slot'},
  {mode:'paid',ceiling:'0.01',message:'Paid ceiling silently supplied'},
])test(`C7 driver refuses unsafe entry state: ${scenario.message}`,async()=>{
  const h=entryHarness(scenario.mode,scenario);await flush();
  assert.equal(h.calls.some(call=>call[0]==='submit'),false);
  assert.match(JSON.parse(h.storage.get('sg-c7-flow')).error,new RegExp(scenario.message));
  assert.equal(h.document.body.dataset.c7Result,'done');
});
