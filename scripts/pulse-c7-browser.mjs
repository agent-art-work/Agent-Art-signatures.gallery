/** Served only by the disposable C7 harness. Uses the actual app controls. */
export function pulseC7BrowserDriver({control,handle,mode,scenario}) {
  const key='sg-c7-flow',read=()=>JSON.parse(sessionStorage.getItem(key)||'null'),save=x=>sessionStorage.setItem(key,JSON.stringify(x));
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  const wait=async(fn,label)=>{const end=Date.now()+40000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label+': '+document.body.innerText.slice(-1500));};
  const command=async(action)=>{const r=await fetch(control,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,code:location.pathname.split('/')[2]})});const v=await r.json();check(r.ok,v.error||action);return v;};
  async function run(){
    let s=read();
    if(!s && location.pathname==='/mint'){
      s={phase:'entry',stages:[]};save(s);
      const f=document.querySelector('[data-assessment-request]');
      check(f.dataset.pulseMint==='true','Pulse controls absent');
      check(f.querySelector('input[name=pulse-mode]')?.type==='hidden','Mint phase must be internal, not a user choice');
      check(!f.querySelector('input[type=radio][name=pulse-mode]'),'Manual mint mode choices remain');
      f.querySelector('input[name=handle]').value=handle;f.querySelector('input[name=handle]').dispatchEvent(new Event('input'));
      await wait(()=>document.querySelector('[data-connect-wallet]:not(:disabled)'),'connect enabled');
      document.querySelector('[data-connect-wallet]').click();
      await wait(()=>{
        try{const q=JSON.parse(f.dataset.pulseQuote||'null');return q?.handle===handle.toLowerCase()&&q.validUntil>Date.now()&&!f.dataset.pulseChecking;}catch{return false;}
      },'automatic read-only phase and eligibility quote');
      const q=JSON.parse(f.dataset.pulseQuote);
      check(q.phase===mode&&f.querySelector('input[name=pulse-mode]').value===mode,'Verified sale phase does not match this rehearsal');
      if(mode==='free')check(q.freeAvailable===true,'The rehearsal wallet has no unused free slot');
      const cap=f.querySelector('input[name=pulse-max-eth]');
      check(!cap.value,'Paid ceiling silently supplied');
      if(mode==='paid'){cap.value='0.01';cap.dispatchEvent(new Event('input'));}
      await wait(()=>!f.querySelector('button[type=submit]').disabled,'explicit mint action enabled');
      s.phase='sent';s.stages.push('SIWE','automatic-phase-quote','explicit-'+mode+'-mint');save(s);
      f.querySelector('button[type=submit]').click();return;
    }
    if(!s)return;
    if(s.phase==='sent' && location.pathname.startsWith('/mint/')){
      check(!document.body.innerText.includes('INTJ'),'Premature MBTI reveal');
      if(scenario==='reject'){
        await wait(()=>/rejected|declined|cancelled/i.test(document.body.innerText),'wallet rejection');
        await wait(()=>document.querySelector('[data-submit-mint]:not(:disabled)'),'explicit retry');
        s.stages.push('wallet-rejected-no-broadcast');save(s);document.querySelector('[data-submit-mint]').click();
      }
      const submissionKey='sg-open:submission:'+location.pathname.split('/')[2];
      await wait(()=>{const v=JSON.parse(sessionStorage.getItem(submissionKey)||'null');return v?.permit&&(scenario==='uncertain'?v.uncertain:v.hash);},'durable submission');
      await command('pending');await command('restart');
      await wait(async()=>{try{return (await(await fetch(control)).json()).ready;}catch{return false;}},'writer restart complete');
      s.phase='reloaded';s.stages.push('hidden-pending','writer-restart');save(s);
      if(scenario==='uncertain'){sessionStorage.removeItem(submissionKey);sessionStorage.removeItem('sg-open:intent:'+location.pathname.split('/')[2]);}
      location.reload();return;
    }
    if(s.phase==='reloaded' && location.pathname.startsWith('/mint/')){
      await wait(()=>/pending|unknown|Checking|Waiting|submitted|wallet activity/i.test(document.body.innerText),'reload safety');
      await command('pending');
      check(!document.querySelector('[data-submit-mint]:not(:disabled)') || document.querySelector('[data-mint-form]')?.hidden,'Reload offered duplicate send');
      s.phase='confirming';s.stages.push('reload-no-duplicate-send');save(s);await command('include');return;
    }
    if(s.phase==='confirming' && location.pathname==='/signatures/'+handle.toLowerCase()){
      await wait(()=>document.querySelector('[data-mint-state=confirming]'),'Confirming reveal');
      const gallery=await(await fetch('/api/gallery')).json();check(!gallery.items.some(x=>x.handle===handle.toLowerCase()),'Unfinalized work in gallery');
      const img=document.querySelector('.signature-art img');await img.decode();check(img.naturalWidth>0,'SVG unavailable');
      check(document.body.innerText.includes('INTJ'),'Missing revealed MBTI');
      s.phase='finalized';s.stages.push('Confirming-not-in-gallery');save(s);await command('finalize');location.reload();return;
    }
    if(s.phase==='finalized' && location.pathname==='/signatures/'+handle.toLowerCase()){
      await wait(()=>document.querySelector('[data-mint-state=minted]'),'Minted');
      const img=document.querySelector('.signature-art img');await img.decode();
      check(document.body.textContent.includes('grok-offline-test'),'Accepted assessment provenance missing');
      const variations=await(await fetch('/p/'+handle+'/variations')).text();
      check((variations.match(/>Preview<\/span>/g)||[]).length===15,'Minted handle must retain fifteen non-mintable previews');
      const about=await(await fetch('/about')).text();check(about.includes('Paid mints follow Pulse pricing')&&!about.includes('No mint fee.'),'Incorrect Pulse fee explanation');
      s.phase='complete';s.stages.push('Minted-in-gallery');
      const gallery=await(await fetch('/api/gallery')).json();check(gallery.items.some(x=>x.handle===handle.toLowerCase()),'Finalized work absent');
      s.overflow=document.documentElement.scrollWidth>innerWidth;s.imageLoaded=img.naturalWidth>0;s.previewTiles=15;s.provenanceVerified=true;check(!s.overflow,'Horizontal overflow');save(s);document.body.dataset.c7Result='done';
    }
  }
  run().catch(e=>{save({...read(),error:String(e.stack||e)});document.body.dataset.c7Result='done';});
}
