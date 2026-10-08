/* ALISA Security — SPEAKER VERIFICATION ("who is speaking?") is separate from SPEECH RECOGNITION ("what was said?").
   Pipeline: mic → quality/VAD → speaker embedding → anti-replay checks → similarity → VERIFIED/UNCERTAIN/NOT-RECOGNIZED
             → speech recognition → command processor {transcript, speakerVerification} → permission check → action → TTS.
   Local only: raw audio lives in memory during processing. Stored: encrypted embedding reference + coarse envelope fingerprints + passcode hash.
   Browser storage is NOT hardware-backed: a compromised browser/device/extension can read or use it. Anti-replay checks are heuristics, not proof.
   Methods: 'neural' (ONNX speaker model via onnxruntime-web; HIGH assurance when loaded) | 'fallback' (MFCC statistics; LOW ASSURANCE, cannot authorize sensitive actions). */
(()=>{'use strict';
const CFG={modelUrl:'models/speaker.onnx',ortUrl:'vendor/ort.min.js',sens:1,devMode:false,
 // Calibrate on real enrolled/impostor recordings (pick the EER / target FAR). Placeholders, NOT validated values:
 thresholds:{neural:{HIGH_CONFIDENCE_THRESHOLD:.55,UNCERTAIN_THRESHOLD:.40},fallback:{HIGH_CONFIDENCE_THRESHOLD:.60,UNCERTAIN_THRESHOLD:.35}},strictOffset:[-.04,0,.04],
 enrollMinScore:{neural:.5,fallback:.3},enrollSamples:5,recMs:3500,minSpeechMs:1200,minSpeechRatio:.25,minPeak:.05,minSnr:8,maxClip:.02,flagClip:.002,dupFp:.995,sessionMs:60000,grantMs:25000,maxPinFails:5,lockMs:120000};   // grantMs = Strict Voice Lock: how long ONE fresh verification may wait for its ONE command
const MSG={silent:'No sound detected — check your microphone.',quiet:'Volume too low — speak closer to the microphone.',short:'Recording too short — speak for a few seconds.',sparse:'Too much silence in the recording.',distorted:'Audio is clipped/distorted — move back or lower input volume.',noisy:'Too much background noise — try a quieter place.','not-live':'Audio did not come from a live microphone capture.'};
const micMsg=e=>e&&(e.name=='NotAllowedError'||e.name=='SecurityError')?'Microphone permission is required.':'Microphone unavailable.';
// Voice-model test build: the ONLY speaker model this build accepts (WeSpeaker VoxCeleb ResNet34-LM, ONNX). Checked by SHA-256 + size on every load; any mismatch => model unavailable => Strict Voice Lock stays locked.
const EXPECT=Object.freeze({id:'wespeaker-voxceleb-resnet34-LM',sha256:'7bb2f06e9df17cdf1ef14ee8a15ab08ed28e8d0ef5054ee135741560df2ec068',bytes:26530309,dim:256});
// Safe operational events: a code + timestamp only (in memory, last 50). Never audio, embeddings, transcripts, PIN or tokens.
const EV=[],ev=c=>{EV.push({t:Date.now(),c});if(EV.length>50)EV.shift()},perf={loadMs:null,inferMs:null},tnow=()=>typeof performance!='undefined'?performance.now():Date.now();
let lastError=null;const fail=(w,e)=>{lastError=w+': '+((e&&(e.message||e.name))||e);console.warn('[ALISA security]',lastError)};
const SR=16000,te=new TextEncoder(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),PH=['Hey ALISA, this is my voice.','The quick brown fox jumps over the lazy dog.','Today I am speaking clearly and calmly.','My voice is my own, and I am enrolling it.','Seven blue lanterns glow above the water.'];
const norm=v=>{const n=Math.hypot(...v)||1;return v.map(x=>x/n)},cos=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
// ---- DSP ----
function fft(re,im){const n=re.length;for(let i=1,j=0;i<n;i++){let b=n>>1;for(;j&b;b>>=1)j^=b;j^=b;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]]}}
 for(let l=2;l<=n;l<<=1){const a=-2*Math.PI/l;for(let i=0;i<n;i+=l)for(let k=0;k<l/2;k++){const c=Math.cos(a*k),s=Math.sin(a*k),u=i+k,v=u+l/2,tr=re[v]*c-im[v]*s,ti=re[v]*s+im[v]*c;re[v]=re[u]-tr;im[v]=im[u]-ti;re[u]+=tr;im[u]+=ti}}}
const mel=f=>2595*Math.log10(1+f/700),imel=m=>700*(10**(m/2595)-1);
function logmel(x,nm){const N=512,pt=[...Array(nm+2)].map((_,i)=>Math.round(imel(mel(20)+(mel(7600)-mel(20))*i/(nm+1))/(SR/2)*(N/2))),w=Float32Array.from({length:400},(_,i)=>.54-.46*Math.cos(2*Math.PI*i/399)),m=[],en=[],avg=new Float32Array(N/2),nf=Math.max(1,Math.floor((x.length-400)/160)+1);
 for(let s=0;s+400<=x.length;s+=160){const re=new Float32Array(N),im=new Float32Array(N);let e=0;for(let i=0;i<400;i++){re[i]=(x[s+i]-(i?.97*x[s+i-1]:0))*w[i];e+=x[s+i]**2}fft(re,im);const p=new Float32Array(N/2),f=new Float32Array(nm);
  for(let k=0;k<N/2;k++){p[k]=re[k]**2+im[k]**2;avg[k]+=p[k]/nf}
  for(let b=0;b<nm;b++){let a=0;const c=pt[b+1],lo=pt[b],hi=pt[b+2];for(let k=lo;k<=hi;k++)a+=p[k]*Math.max(0,1-Math.abs(k-c)/Math.max(k<c?c-lo:hi-c,1));f[b]=Math.log(Math.max(a,1e-10))}
  m.push(f);en.push(10*Math.log10(e/400+1e-12))}return{m,en,avg}}
function rs(x,sr){if(sr==SR)return x;const r=sr/SR,n=Math.floor(x.length/r),o=new Float32Array(n);for(let i=0;i<n;i++){const a=Math.floor(i*r),b=Math.max(a+1,Math.floor((i+1)*r));let s=0;for(let k=a;k<b&&k<x.length;k++)s+=x[k];o[i]=s/(b-a)}return o}
// ---- single microphone path (no file/blob input exists; dev hook only when CFG.devMode) ----
const LIVE=new WeakSet(),dev={audioSource:null,pin:null,model:null};   // dev.model (test-only, honoured only when CFG.devMode) lets SYNTHETIC test stubs stand in for the pinned model identity
const EXP=()=>CFG.devMode&&dev.model?dev.model:EXPECT;
async function captureAudio(onP){let x;
 if(CFG.devMode&&dev.audioSource)x=await dev.audioSource();
 else{if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw{name:'NoMic'};
  const st=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1}}),ac=new(window.AudioContext||window.webkitAudioContext)(),sr=ac.sampleRate,src=ac.createMediaStreamSource(st),pr=ac.createScriptProcessor(4096,1,1),ch=[],z=ac.createGain();
  pr.onaudioprocess=e=>ch.push(new Float32Array(e.inputBuffer.getChannelData(0)));z.gain.value=0;src.connect(pr);pr.connect(z);z.connect(ac.destination);
  await new Promise(r=>{const t0=performance.now(),iv=setInterval(()=>{const p=Math.min(1,(performance.now()-t0)/CFG.recMs);onP&&onP(p);if(p>=1){clearInterval(iv);r()}},50)});
  st.getTracks().forEach(t=>t.stop());pr.disconnect();ac.close();const y=new Float32Array(ch.reduce((a,c)=>a+c.length,0));let o=0;ch.forEach(c=>{y.set(c,o);o+=c.length});ch.length=0;x=rs(y,sr)}
 LIVE.add(x);return x}
// ---- quality / voice-activity + replay-feature extraction ----
function checkAudioQuality(x){if(!LIVE.has(x))return{bad:'not-live'};let pk=0,cl=0,ss=0;for(const v of x){const a=Math.abs(v);if(a>pk)pk=a;if(a>=.99)cl++;ss+=v*v}
 if(pk<.01)return{bad:'silent'};if(pk<CFG.minPeak)return{bad:'quiet'};if(cl/x.length>CFG.maxClip)return{bad:'distorted'};
 const g=Math.min(20,.1/Math.sqrt(ss/x.length)),y=x.map(v=>v*g),L=logmel(y,40),s=[...L.en].sort((a,b)=>a-b),fl=s[Math.floor(s.length*.1)],voiced=L.en.map(e=>e>fl+10&&e>-55),nv=voiced.filter(Boolean).length;
 if(nv*10<CFG.minSpeechMs)return{bad:'short'};if(nv/voiced.length<CFG.minSpeechRatio)return{bad:'sparse'};const snr=L.en.filter((_,i)=>voiced[i]).reduce((a,b)=>a+b,0)/nv-fl;if(snr<CFG.minSnr)return{bad:'noisy'};
 const av=L.avg,mid=av.slice(5,128).reduce((a,b)=>a+b,0)/123,lf=(av[2]+av[3]+av[4])/3/mid,hf=av.slice(160,240).reduce((a,b)=>a+b,0)/80/mid,en=L.en,fp=norm(Array.from({length:64},(_,i)=>en[Math.floor(i*en.length/64)]-en.reduce((a,b)=>a+b,0)/en.length));
 return{x:y,raw:x,L,voiced,snr,fp,lf,hf,clip:cl/x.length}}
// ---- model (failure-safe, cached in Cache Storage, loaded lazily once) ----
const model={state:'not-loaded',code:'',reason:'',sha:'',sess:null};let initP=null;
class MErr extends Error{constructor(code,msg){super(msg||code);this.code=code}}
const loadScript=u=>new Promise((r,j)=>{if(typeof document=='undefined')return j(new Error('no document'));const s=document.createElement('script');s.src=u;s.onload=r;s.onerror=()=>j(new Error('could not load '+u));document.head.appendChild(s)});
const sha256hex=async b=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');
// Reads the embedding exactly the way extractSpeakerEmbedding does and refuses anything that is not a finite, non-zero vector of the pinned length.
function embOf(r,dim){const o=r&&Object.values(r)[0],d=o&&o.data;if(!d||d.length!==dim)throw new MErr('MODEL_OUTPUT_INVALID','embedding length '+(d?d.length:'none')+', expected '+dim);let nz=false;for(const x of d){if(!Number.isFinite(x))throw new MErr('MODEL_OUTPUT_INVALID','non-finite embedding value');if(x!==0)nz=true}if(!nz)throw new MErr('MODEL_OUTPUT_INVALID','all-zero embedding');return Array.from(d)}
function initializeVoiceSecurity(){return initP||(initP=(async()=>{const t0=tnow();try{
  if(!window.ort){try{await loadScript(CFG.ortUrl)}catch(e){throw new MErr('ORT_NOT_LOADED',e.message)}}
  if(!window.ort)throw new MErr('ORT_NOT_LOADED','onnxruntime-web (window.ort) not available');
  ort.env.wasm.wasmPaths=new URL('vendor/',location.href).href;ort.env.wasm.numThreads=1;
  const X=EXP(),c=window.caches?await caches.open('alisa-speaker-model'):null,good=async b=>b.byteLength===X.bytes&&await sha256hex(b)===X.sha256;let buf=null;
  const hit=c&&await c.match(CFG.modelUrl);   // a cached copy is trusted ONLY if it matches the pinned hash; otherwise it is dropped and re-fetched (stale-model protection)
  if(hit){const b=await hit.arrayBuffer();if(await good(b))buf=b;else{try{await c.delete(CFG.modelUrl)}catch(e){}ev('MODEL_CACHE_INVALIDATED')}}
  if(!buf){let r;try{r=await fetch(CFG.modelUrl,{cache:'no-store'})}catch(e){throw new MErr('MODEL_NOT_FOUND','model file '+CFG.modelUrl+' could not be fetched')}
   if(!r.ok)throw new MErr('MODEL_NOT_FOUND','model file '+CFG.modelUrl+' not found (HTTP '+r.status+')');
   const b=await r.arrayBuffer();if(!(await good(b)))throw new MErr('MODEL_HASH_MISMATCH','model file does not match the expected speaker model (size/SHA-256) and was rejected');
   buf=b;if(c&&typeof Response!='undefined')try{await c.put(CFG.modelUrl,new Response(b.slice(0)))}catch(e){}}
  let sess;try{sess=await ort.InferenceSession.create(buf,{executionProviders:['wasm']})}catch(e){throw new MErr('MODEL_LOAD_FAILED',e.message)}
  if(!sess.inputNames||sess.inputNames.length!==1||!sess.inputNames[0])throw new MErr('MODEL_INPUT_INVALID','model must have exactly one named input');
  if(!sess.outputNames||!sess.outputNames.length)throw new MErr('MODEL_OUTPUT_INVALID','model has no output');
  const T=200,d=new Float32Array(T*80);for(let i=0;i<d.length;i++)d[i]=Math.sin(i*.37)*1.5+Math.cos(i*.011);   // deterministic probe: proves [1,T,80] float32 is accepted and a valid embedding comes back
  let r;const t1=tnow();try{r=await sess.run({[sess.inputNames[0]]:new ort.Tensor('float32',d,[1,T,80])})}catch(e){throw new MErr(/shape|dims?\b|dimension|\btype\b|\binput\b/i.test(e.message||'')?'MODEL_INPUT_INVALID':'MODEL_INFERENCE_FAILED',e.message)}
  embOf(r,X.dim);perf.inferMs=Math.round(tnow()-t1);
  model.sess=sess;model.state='loaded';model.code='MODEL_READY';model.reason='';model.sha=X.sha256;perf.loadMs=Math.round(tnow()-t0);ev('MODEL_READY')}
 catch(e){model.sess=null;model.state='unavailable';model.code=e.code||'MODEL_LOAD_FAILED';model.reason=e.message;ev(model.code);fail('model',e)}return model})())}
const method=()=>model.sess?'neural':'fallback';
async function extractSpeakerEmbedding(a){const S=model.sess;if(S){const F=logmel(a.x,80).m,T=F.length,d=new Float32Array(T*80),mu=Array(80).fill(0);F.forEach(f=>f.forEach((v,b)=>mu[b]+=v/T));F.forEach((f,i)=>f.forEach((v,b)=>d[i*80+b]=v-mu[b]));
  const t1=tnow(),r=await S.run({[S.inputNames[0]]:new ort.Tensor('float32',d,[1,T,80])});perf.inferMs=Math.round(tnow()-t1);return norm(embOf(r,EXP().dim))}   // approximates Kaldi fbank; use the model's recommended front-end if you swap models
 const K=19,C=a.L.m.filter((_,i)=>a.voiced[i]).map(m=>{const c=[];for(let k=1;k<=K;k++){let s=0;for(let b=0;b<40;b++)s+=m[b]*Math.cos(Math.PI*k*(b+.5)/40);c.push(s/Math.sqrt(40))}return c}),mu=Array(K).fill(0),sd=Array(K).fill(0);
 C.forEach(c=>c.forEach((v,k)=>mu[k]+=v/C.length));C.forEach(c=>c.forEach((v,k)=>sd[k]+=(v-mu[k])**2/C.length));return norm([...mu,...sd.map(Math.sqrt)])}
function thresholdsFor(m){const t=CFG.thresholds[m],o=CFG.strictOffset[CFG.sens];return{high:t.HIGH_CONFIDENCE_THRESHOLD+o,unc:t.UNCERTAIN_THRESHOLD+o}}
function compareSpeaker(e,P){const{high,unc}=thresholdsFor(P.method);let score;
 if(P.method=='neural')score=cos(e,P.ref);else{const d=Math.sqrt(e.reduce((s,v,i)=>s+((v-P.ref[i])/P.sg[i])**2,0)/e.length);score=Math.exp(-d*d/18)}   // fallback: variance-normalised distance → (0,1]
 return{score,high,unc,status:score>=high?'verified':score>=unc?'uncertain':'not-recognized'}}
// ---- anti-replay heuristics (signals, not proof) ----
const recent=[];
function checkReplayRisk(a,P){const f=[];if(P&&P.fps.some(q=>cos(q,a.fp)>CFG.dupFp))f.push('matches-enrollment-recording');if(recent.some(q=>cos(q,a.fp)>CFG.dupFp))f.push('repeated-audio');
 if(a.lf<.002)f.push('low-frequency-deficit');if(a.hf<1e-5)f.push('band-limited');if(a.clip>CFG.flagClip)f.push('clipping');return{flags:f,suspicious:f.length>0}}
// ---- protected storage ----
let NS='alisa-sec',cache=null,session=null,grant=null,last=null,fails=0,lockUntil=0;
const db=()=>new Promise((r,j)=>{const o=indexedDB.open(NS,1);o.onupgradeneeded=()=>o.result.createObjectStore('s');o.onsuccess=()=>r(o.result);o.onerror=()=>j(o.error)});
const kv=async(m,f)=>{const d=await db();return new Promise((r,j)=>{const q=f(d.transaction('s',m).objectStore('s'));q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)})};
async function key(){let k=await kv('readonly',s=>s.get('k'));if(!k){k=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);await kv('readwrite',s=>s.put(k,'k'))}return k}
async function save(o){const iv=crypto.getRandomValues(new Uint8Array(12)),ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(),te.encode(JSON.stringify(o)));await kv('readwrite',s=>s.put({iv,ct},'p'));cache=o;try{if(navigator.storage&&navigator.storage.persist)navigator.storage.persist()}catch(e){}}
async function load(){if(cache)return cache;try{const r=await kv('readonly',s=>s.get('p'));if(!r)return null;return cache=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:r.iv},await key(),r.ct)))}catch(e){fail('profile unreadable',e);return null}}
const hash=async(p,s)=>[...new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt:s,iterations:150000,hash:'SHA-256'},await crypto.subtle.importKey('raw',te.encode(p),'PBKDF2',false,['deriveBits']),256))].join(',');
// Backup-passcode dialog. setup=true (choosing one): digits only, at least PIN_MIN digits — too short / non-numeric keeps the dialog open with a visible message.
// setup=false (entering an existing one): an all-digit entry is normalised exactly the same way; anything else is passed through untouched so a passcode created
// before this fix can never lock its owner out. The hashing/storage code (hash(), PBKDF2 150k, salt, AES-GCM profile) is unchanged and receives the same string as before.
const PIN_MIN=4;
function askPin(setup){if(CFG.devMode&&dev.pin)return Promise.resolve(dev.pin);return new Promise(res=>{const d=document.createElement('div');d.style.cssText='position:fixed;inset:0;z-index:99;display:grid;place-items:center;background:#02030acc;backdrop-filter:blur(10px)';
 d.innerHTML=`<div style="width:min(86vw,340px);padding:22px;border-radius:22px;background:linear-gradient(160deg,hsl(var(--c1)/.25),hsl(var(--c2)/.92));border:1px solid hsl(var(--c3)/.3);color:var(--txt);font:14px var(--ui);text-align:center;box-shadow:0 0 50px hsl(var(--c1)/.3)"><b style="letter-spacing:.16em;font-size:12px">${setup?'SET BACKUP PASSCODE':'ADDITIONAL AUTHENTICATION'}</b><p style="margin:10px 0;color:var(--dim);font-size:12px">${setup?'Needed for sensitive commands when voice verification is uncertain (min '+PIN_MIN+' digits).':'Voice verification alone isn’t enough for this action. Enter your passcode.'}</p><input type=password inputmode=numeric ${setup?'pattern="[0-9]*" maxlength=32 ':''}autocomplete=off aria-label="Passcode" style="width:100%;padding:11px;border-radius:12px;border:1px solid hsl(var(--c3)/.3);background:#0003;color:var(--txt);text-align:center;letter-spacing:.4em;font-size:18px"><div role=alert aria-live=polite style="min-height:15px;margin-top:8px;font-size:11px;letter-spacing:.02em;color:hsl(350 90% 76%)"></div><div class=chips style="justify-content:center"><button type=button>Cancel</button><button type=button class=on>Confirm</button></div></div>`;
 d.addEventListener('pointerdown',e=>e.stopPropagation());   // the page has a document-level pointerdown handler (orb / node picker): without this, tapping the field or the dialog body also poked the orb behind the dialog
 document.body.appendChild(d);
 const i=d.querySelector('input'),m=d.querySelector('[role=alert]'),b=d.querySelectorAll('button'),done=v=>{d.remove();res(v)},say=t=>{m.textContent=t},
  norm=v=>String(v).normalize('NFKC').replace(/\s+/g,''),   // trim + drop inner spaces; NFKC turns full-width digits into ASCII
  short='Passcode must be at least '+PIN_MIN+' digits.';
 i.focus();b[0].onclick=()=>done(null);
 b[1].onclick=()=>{const v=norm(i.value),num=/^[0-9]+$/.test(v);
  if(setup){if(!v||v.length<PIN_MIN&&num){say(short);return i.focus()}if(!num){say('Digits only (0–9).');return i.focus()}if(v.length<PIN_MIN){say(short);return i.focus()}return done(v)}
  if(!v){say('Enter your passcode.');return i.focus()}done(num?v:i.value)};
 i.oninput=()=>{if(!setup){say('');return}const v=norm(i.value),f=v.replace(/[^0-9]/g,'');if(f!==i.value)i.value=f;say(v!==f?'Digits only (0–9).':'')};   // setup: only digits can be typed or pasted
 i.onkeydown=e=>{if(e.key=='Enter'&&!e.isComposing){e.preventDefault();b[1].click()}}})}
// ---- verified session ----
function createVerifiedSession(r){session=r&&r.status=='verified'&&r.method=='neural'&&!r.lowAssurance&&!r.spoofFlags.length?{until:Date.now()+CFG.sessionMs}:null;return session}   // low-assurance results never open a session
const sessionActive=()=>!!session&&Date.now()<session.until,invalidateSession=()=>{session=null;grant=null};   // clears BOTH the legacy session and the Strict Voice Lock grant
// ---- Strict Voice Lock (Phase 3.1.1): ONE fresh neural speaker verification authorizes exactly ONE voice command. Fails closed. ----
// A grant exists only after a verified, NEURAL, high-assurance, replay-clean result. authorizeVoiceCommand() consumes it on first look (success or failure), so a second
// command always needs a new verification. Typed chat never calls this. The setting defaults to ON; only a correct backup passcode (same hash as reset) can turn it off.
const createVoiceGrant=r=>{grant=r&&r.status=='verified'&&r.method=='neural'&&method()=='neural'&&!r.lowAssurance&&!(r.spoofFlags&&r.spoofFlags.length)?{until:Date.now()+CFG.grantMs}:null;return !!grant};
const hasVoiceGrant=()=>!!grant&&Date.now()<grant.until,strictActive=()=>!(cache&&cache.strictOff===true);   // cache not loaded / profile unreadable → strict stays ON
async function authorizeVoiceCommand(){await load();const g=grant;grant=null;
 if(!strictActive())return{ok:true,how:'strict-off'};
 if(g&&Date.now()<g.until&&method()=='neural'){ev('GRANT_CONSUMED');return{ok:true,how:'voice-grant'}}
 if(g&&Date.now()>=g.until)ev('GRANT_EXPIRED');else ev('VOICE_AUTH_DENIED');
 return{ok:false,code:'VOICE_AUTH_REQUIRED',text:'I need to verify your voice first — command not executed.'}}
async function setStrictVoiceLock(on){const P=await load();
 if(on){if(P&&P.strictOff){const q={...P};delete q.strictOff;await save(q)}invalidateSession();return{ok:true,strict:true,text:'Strict Voice Lock is on.'}}
 if(!P)return{ok:false,strict:true,text:'Strict Voice Lock stays on — there is no voice profile or passcode to authorize turning it off.'};
 if(Date.now()<lockUntil)return{ok:false,strict:true,text:'Locked for a moment after too many wrong passcodes.'};
 const pin=await askPin(false);if(!pin)return{ok:false,strict:true,text:'Strict Voice Lock unchanged.'};
 if(await hash(pin,new Uint8Array(P.salt))!=P.ph){if(++fails>=CFG.maxPinFails){fails=0;lockUntil=Date.now()+CFG.lockMs}return{ok:false,strict:true,text:'Passcode incorrect — Strict Voice Lock stays on.'}}
 fails=0;await save({...P,strictOff:true});invalidateSession();return{ok:true,strict:false,text:'Strict Voice Lock is off.'}}
// ---- enrollment / verification ----
async function enrollVoice(o={}){const S=o.onState||(()=>{}),n=Math.max(4,CFG.enrollSamples);if(!crypto.subtle)return{ok:false,text:'Secure storage needs https or localhost.'};await initializeVoiceSecurity();const E=[],F=[];let bad=0;
 for(let i=0;i<n;){const ph=PH[i%PH.length];let a;try{S('listening',`Sample ${i+1} of ${n} — say: “${ph}”`);a=checkAudioQuality(await captureAudio(p=>o.onProgress&&o.onProgress(i,n,ph,p)))}catch(e){fail('enroll capture',e);return{ok:false,text:micMsg(e)}}
  if(a.bad){if(++bad>8)return{ok:false,text:'Too many unusable samples. '+MSG[a.bad]};S('retry',MSG[a.bad]);await sleep(1200);continue}
  if(F.some(q=>cos(q,a.fp)>CFG.dupFp)){S('retry','Identical audio rejected — speak each phrase live.');await sleep(1200);continue}
  S('verifying','Extracting speaker embedding');try{E.push(await extractSpeakerEmbedding(a))}catch(e){fail('enroll embedding',e);return{ok:false,text:'Voice model error ('+(e.code||'MODEL_INFERENCE_FAILED')+') — enrollment stopped.'}}F.push(a.fp);i++;await sleep(400)}
 const m=method(),ref=norm(E[0].map((_,j)=>E.reduce((s,v)=>s+v[j],0)/n)),sg=ref.map((_,j)=>Math.max(.004,Math.sqrt(E.reduce((s,v)=>s+(v[j]-ref[j])**2,0)/n)));
 if(Math.min(...E.map(e=>compareSpeaker(e,{method:m,ref,sg}).score))<CFG.enrollMinScore[m])return{ok:false,text:'Samples were too inconsistent (different speakers or noise). Please try again.'};
 const pin=await askPin(true);if(!pin)return{ok:false,text:'A backup passcode is required to finish enrolling.'};
 const salt=crypto.getRandomValues(new Uint8Array(16));await save({v:3,method:m,ref,sg,fps:F,t:Date.now(),n,salt:[...salt],ph:await hash(pin,salt),...(m=='neural'?{mid:EXP().id,mh:EXP().sha256,dim:ref.length}:{})});recent.length=0;invalidateSession();
 return{ok:true,text:'Voice profile created ('+m+' method'+(m=='neural'?'':' — LOW ASSURANCE')+').'}}
async function verifySpeaker(a,o={}){ev('VERIFICATION_STARTED');const S=o.onState||(()=>{}),R=(status,reason,x={})=>{const r={status,reason,text:reason,score:null,threshold:null,method:method(),lowAssurance:method()!='neural',spoofFlags:[],t:Date.now(),...x};last=r;createVerifiedSession(r);ev(status=='verified'?'VERIFICATION_SUCCESS':'VERIFICATION_REJECTED');if(createVoiceGrant(r))ev('GRANT_CREATED');S(status,status=='unavailable'||status=='uncertain'?reason:'');return r};
 const P=await load();session=null;grant=null;if(!P)return R('unavailable','No voice profile enrolled.');if(!a||a.bad||!a.raw||!LIVE.has(a.raw))return R('unavailable',a&&a.bad?MSG[a.bad]:MSG['not-live']);
 if(P.method!=method())return R('unavailable','Profile was made with the '+P.method+' model — please re-enroll.');
 if(P.method=='neural'&&(P.mid!==EXP().id||P.mh!==EXP().sha256||!P.ref||P.ref.length!==EXP().dim))return R('unavailable','Your voice profile was made with a different speaker model — please re-enroll your voice (Settings → My Voice).',{code:'PROFILE_MODEL_MISMATCH'});
 let e;try{e=await extractSpeakerEmbedding(a)}catch(err){fail('inference',err);return R('unavailable','Voice check could not run ('+(err.code||'MODEL_INFERENCE_FAILED')+') — command not executed.',{code:err.code||'MODEL_INFERENCE_FAILED'})}
 const c=compareSpeaker(e,P),rp=checkReplayRisk(a,P);recent.push(a.fp);if(recent.length>5)recent.shift();
 const x={score:c.score,threshold:c.high,spoofFlags:rp.flags};let st=c.status;
 if(st=='verified'&&rp.suspicious)return R('uncertain','Possible replay/playback ('+rp.flags.join(', ')+') — passcode needed for sensitive actions.',x);
 if(st=='verified')return R('verified',method()=='neural'?'Speaker verification passed (probabilistic).':'Matches enrolled voice, but LOW ASSURANCE (no neural model).',x);
 return R(st,st=='uncertain'?'Result uncertain — try again in a quieter place.':'Voice not recognized.',x)}
async function verify(o={}){const S=o.onState||(()=>{});await initializeVoiceSecurity();let x;try{S('listening');x=await captureAudio(o.onProgress)}catch(e){fail('capture',e);session=null;grant=null;last={status:'unavailable',reason:micMsg(e),text:micMsg(e),method:method(),lowAssurance:method()!='neural',spoofFlags:[],score:null,threshold:null,t:Date.now()};S('unavailable',last.reason);return last}
 S('verifying');const a=checkAudioQuality(x);return verifySpeaker(a,o)}
// ---- command security ----
const SENSITIVE=/^(?:(?:hey|ok|okay|please|alisa|can you|could you|would you|will you)[, ]+)*(?:send|message|text|email|call|dial|phone|unlock|lock|open|delete|erase|pay|buy|transfer|switch|turn (?:on|off)|change (?:my |the )?(?:settings?|password|passcode|pin)|enroll|log ?in|log in)\b|\b(?:my (?:password|passcode|pin|bank|account|voice profile)|voice profile|thermostat|front door)\b/i;
const isSensitiveCommand=t=>SENSITIVE.test(t||'');
// sv = speaker-verification result; permissions depend on it, never on the transcript alone. Fails closed.
async function requireAuthorization(sv,o={}){if(!(await load()))return{ok:false,text:'No voice profile — sensitive commands are unavailable.'};
 if(sessionActive())return{ok:true,how:'verified-session'};
 if(!sv||Date.now()-sv.t>CFG.sessionMs)sv=o.reverify===false?null:await verify(o);if(!sv)return{ok:false,text:'I couldn’t verify your voice.'};
 if(sessionActive())return{ok:true,how:'verified-session'};
 if(sv.status=='not-recognized')return{ok:false,text:'Voice not recognized — sensitive action denied.'};
 if(Date.now()<lockUntil)return{ok:false,text:'Passcode locked for a moment after too many failures.'};   // uncertain / unavailable / low-assurance → passcode
 const P=await load(),pin=await askPin(false);if(!pin)return{ok:false,text:'I couldn’t verify your voice. Please try again or use your security passcode.'};
 if(await hash(pin,new Uint8Array(P.salt))==P.ph){fails=0;return{ok:true,how:'passcode'}}if(++fails>=CFG.maxPinFails){fails=0;lockUntil=Date.now()+CFG.lockMs}return{ok:false,text:'Passcode incorrect.'}}
async function deleteVoiceProfile(){try{const d=await db();await new Promise((r,j)=>{const t=d.transaction('s','readwrite');t.objectStore('s').clear();t.oncomplete=r;t.onerror=()=>j(t.error)});d.close()}catch(e){fail('delete',e)}cache=null;recent.length=0;last=null;invalidateSession()}
// Full reset. If a usable profile exists, the backup passcode is required (3 tries share the normal lockout). If none exists (never enrolled / unreadable), there is nothing to protect, so it just cleans up.
async function resetSecurity(o={}){const P=await load();
 if(P){if(Date.now()<lockUntil)return{ok:false,text:'Locked for a moment after too many wrong passcodes.'};
  const pin=o.pin!=null?o.pin:await askPin(false);if(!pin)return{ok:false,text:'Reset cancelled.'};
  if(await hash(pin,new Uint8Array(P.salt))!=P.ph){if(++fails>=CFG.maxPinFails){fails=0;lockUntil=Date.now()+CFG.lockMs}return{ok:false,text:'Invalid password.'}}fails=0}
 await deleteVoiceProfile();lastError=null;
 try{await new Promise(r=>{const q=indexedDB.deleteDatabase(NS);q.onsuccess=q.onerror=q.onblocked=()=>r()})}catch(e){fail('reset db',e)}
 initP=null;model.state='not-loaded';model.reason='';model.sess=null;try{await initializeVoiceSecurity()}catch(e){}
 return{ok:true,text:'Voice security reset. You can enroll again.'}}
try{localStorage.removeItem('alisa_voiceprint')}catch(e){fail('legacy cleanup',e)}
async function info(){await initializeVoiceSecurity();const P=await load();return{method:method(),assurance:method()=='neural'?'HIGH':'LOW ASSURANCE',model:{state:model.state,code:model.code||'NOT_LOADED',reason:model.reason,sha:(model.sha||'').slice(0,12)},perf:{...perf},events:EV.slice(-20),enrolled:!!P,t:P&&P.t,n:P&&P.n,verified:sessionActive(),strict:strictActive(),until:session&&session.until,last,lastError,thresholds:thresholdsFor(method())}}
// ---- developer self-test: REAL code paths on SYNTHETIC audio / stubbed results (not human voices). Uses a separate storage namespace. ----
function synth(f0,{seed=1,dur=3.5,noise=.005,gain=.4,F=[700,1200],clip=0}={}){let q=seed*9301%2147483647||1;const r=()=>(q=q*16807%2147483647)/2147483647-.5,n=Math.floor(SR*dur),x=new Float32Array(n);
 for(let i=0;i<n;i++){const t=i/SR,f=f0*(1+.02*Math.sin(2*Math.PI*.7*t+seed)),env=Math.max(0,Math.sin(2*Math.PI*(2.5+seed*.07)*t))**.5;let v=0;for(let h=1;h<=25;h++){const fr=h*f;if(fr>7000)break;v+=Math.sin(2*Math.PI*h*f*t+h*seed)/h*(1/(1+((fr-F[0])/250)**2)+.8/(1+((fr-F[1])/300)**2)+.05)}x[i]=gain*env*v/3+noise*r()*2}
 if(clip)for(let i=0;i<n;i++)x[i]=Math.max(-1,Math.min(1,x[i]*clip));return x}
async function selfTest(){const prev={NS,cache,session,last,devMode:CFG.devMode,src:dev.audioSource,pin:dev.pin},out=[],T=(id,name,exp,act,ok)=>out.push({id,name,expected:exp,actual:act,pass:ok});
 NS='alisa-sec-test';cache=null;session=null;recent.length=0;CFG.devMode=true;dev.pin='4821';let next=null;dev.audioSource=async()=>{if(next instanceof Error)throw next;return next};
 try{await initializeVoiceSecurity();await deleteVoiceProfile();const A=s=>synth(120,{seed:s}),B=synth(210,{seed:9,F:[500,1800]}),run=async x=>{next=x;return verify()};
  let k=0;next=null;dev.audioSource=async()=>A(++k+1);const en=await enrollVoice();T('enroll','Enroll 4 synthetic samples',"ok",en.ok?'ok':en.text,en.ok);
  const enrolled=A(2);  // same as enrollment sample #1
  dev.audioSource=async()=>{if(next instanceof Error)throw next;return next};
  let r=await run(A(50));T('A','Same synthetic voice (new take)','verified',r.status+(r.lowAssurance?' (low assurance)':''),r.status=='verified');
  r=await run(B);T('B','Different synthetic voice','not-recognized|uncertain',r.status,r.status!='verified');
  r=await run(enrolled);T('C','Replay of an enrollment sample','uncertain + flag',r.status+' ['+r.spoofFlags.join(',')+']',r.status!='verified'&&r.spoofFlags.includes('matches-enrollment-recording'));
  r=await run(synth(120,{seed:60,noise:.6}));T('D','Very noisy audio','uncertain|unavailable',r.status+' — '+r.reason,r.status=='unavailable'||r.status=='uncertain');
  r=await run(Object.assign(new Error('denied'),{name:'NotAllowedError'}));T('E','No microphone permission','unavailable',r.status,r.status=='unavailable');
  T('F','No neural model → low assurance','lowAssurance=true',String(method()=='neural'?'neural model loaded':'lowAssurance=true'),method()=='neural'||r.lowAssurance);
  dev.pin=null;const p=()=>{dev.pin='4821'};const S=(status,m)=>({status,method:m,lowAssurance:m!='neural',spoofFlags:[],t:Date.now(),score:0,threshold:0});
  let a=await requireAuthorization(S('not-recognized','neural'),{reverify:false});T('G','Sensitive + NOT RECOGNIZED','denied',a.ok?'allowed':'denied',!a.ok);
  p();a=await requireAuthorization(S('uncertain','neural'),{reverify:false});T('H','Sensitive + UNCERTAIN (correct passcode)','passcode required → allowed',a.ok?'via '+a.how:'denied',a.ok&&a.how=='passcode');
  dev.pin='0000';a=await requireAuthorization(S('uncertain','neural'),{reverify:false});T('H2','Sensitive + UNCERTAIN (wrong passcode)','denied',a.ok?'allowed':'denied',!a.ok);p();
  a=await requireAuthorization(S('verified','fallback'),{reverify:false});T('F2','VERIFIED but fallback (low assurance)','passcode required',a.ok?'via '+a.how:'denied',a.ok&&a.how=='passcode');
  createVerifiedSession(S('verified','neural'));a=await requireAuthorization(S('verified','neural'),{reverify:false});T('I','Sensitive + VERIFIED (high assurance, stubbed result)','allowed (session)',a.ok?'via '+a.how:'denied',a.ok&&a.how=='verified-session');
  invalidateSession();a=await requireAuthorization(null,{reverify:false});T('S','Session invalidated','not allowed without verification',a.ok?'allowed':'denied',!a.ok)
 }catch(e){fail('selftest',e);T('err','Self-test crashed','no error',e.message,false)}
 finally{await deleteVoiceProfile();NS=prev.NS;cache=null;session=prev.session;last=prev.last;CFG.devMode=prev.devMode;dev.audioSource=prev.src;dev.pin=prev.pin}
 out.push({id:'A/B',name:'Real human voices (your voice vs another person)',expected:'—',actual:'MANUAL — not covered by synthetic audio',pass:null});return out}
window.ALISASecurity={config:CFG,dev,initializeVoiceSecurity,enrollVoice,verifySpeaker,verify,extractSpeakerEmbedding,checkAudioQuality,checkReplayRisk,compareSpeaker,createVerifiedSession,invalidateSession,isSensitiveCommand,requireAuthorization,authorizeVoiceCommand,hasVoiceGrant,strictActive,setStrictVoiceLock,invalidateVoiceAuth:invalidateSession,deleteVoiceProfile,info,selfTest,logout:invalidateSession,
 has:async()=>!!await load(),resetSecurity,reset:resetSecurity,enroll:enrollVoice,remove:deleteVoiceProfile,classify:t=>isSensitiveCommand(t)?'high':'low',invalidate:invalidateSession};
})();
