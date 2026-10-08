#!/usr/bin/env node
/* ALISA server — zero dependencies (Node 18+). Run: node server.js
   1) Serves the ALISA app (allow-listed files only).  2) Optional REST storage for ALISA MIND (memories + knowledge).
   - Binds to HOST (default 0.0.0.0) on PORT (default 8787). Set HOST=127.0.0.1 to run localhost-only. It has NO TLS itself: cloud hosts terminate HTTPS in front of it.
   - API needs a bearer token (env ALISA_TOKEN, or auto-generated into data/token on first run — dev only; ALISA_TOKEN is REQUIRED when NODE_ENV=production).
   - POST /api/login trades the access code (ALISA_TOKEN) for a 30-day signed session token, so the browser never stores the permanent secret.
   - POST /api/ai is the server-side Gemini proxy (env GEMINI_API_KEY never leaves the server). It only forwards chat text + registered tool *declarations*; tools run in the browser via ALISACommands.
   - Storage: PostgreSQL (Neon) when DATABASE_URL is set, otherwise PLAIN JSON in ./data (not encrypted — use disk encryption/permissions). See store.js. Deletes are tombstones; updatedAt is assigned by the server; stale writes get 409. No audio/voice endpoints exist; voice profiles never leave the browser. */
'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const{validate,pick,ID}=require('./items'),{createBackend,STORES}=require('./store');
const ROOT=__dirname,PORT=+process.env.PORT||8787,HOST=process.env.HOST||'0.0.0.0',DATA=process.env.ALISA_DATA||path.join(ROOT,'data');
const PROD=process.env.NODE_ENV=='production',TRUST_PROXY=process.env.TRUST_PROXY=='1',DIRECT=process.env.ALLOW_DIRECT_GEMINI=='1',GKEY=(process.env.GEMINI_API_KEY||'').trim(),GBASE=process.env.GEMINI_API_BASE||'https://generativelanguage.googleapis.com/v1beta/models/';
const MODELS=['gemini-flash-lite-latest','gemini-flash-latest','gemini-3.1-flash-lite','gemini-3.5-flash','gemini-3.5-flash-lite','gemini-2.5-flash-lite','gemini-2.5-flash'];let goodModel=null;
const FILES={'index.html':'text/html; charset=utf-8','security.js':'text/javascript; charset=utf-8','alisa-mind.js':'text/javascript; charset=utf-8','alisa-memory-intelligence.js':'text/javascript; charset=utf-8','alisa-brain.js':'text/javascript; charset=utf-8','commands.js':'text/javascript; charset=utf-8','sw.js':'text/javascript; charset=utf-8','manifest.json':'application/manifest+json','alisa.png':'image/png','alisa-192.png':'image/png','alisa-remote-storage.js':'text/javascript; charset=utf-8','alisa-retrieval.js':'text/javascript; charset=utf-8','alisa-embeddings.js':'text/javascript; charset=utf-8','alisa-vectors.js':'text/javascript; charset=utf-8','alisa-semantic.js':'text/javascript; charset=utf-8','alisa-agent-log.js':'text/javascript; charset=utf-8','alisa-risk-gate.js':'text/javascript; charset=utf-8','alisa-tool-registry.js':'text/javascript; charset=utf-8','alisa-agent-tools.js':'text/javascript; charset=utf-8','alisa-intent.js':'text/javascript; charset=utf-8','alisa-planner.js':'text/javascript; charset=utf-8','alisa-personality.js':'text/javascript; charset=utf-8','alisa-resources.js':'text/javascript; charset=utf-8','alisa-status.js':'text/javascript; charset=utf-8','alisa-agent-core.js':'text/javascript; charset=utf-8','alisa-agent-ui.js':'text/javascript; charset=utf-8','models/embed/model.onnx':'application/octet-stream','models/embed/vocab.txt':'text/plain; charset=utf-8','vendor/ort.min.js':'text/javascript; charset=utf-8','vendor/ort-wasm-simd-threaded.mjs':'text/javascript; charset=utf-8','vendor/ort-wasm-simd-threaded.wasm':'application/wasm','models/speaker.onnx':'application/octet-stream'};
fs.mkdirSync(DATA,{recursive:true,mode:0o700});
function token(){if(process.env.ALISA_TOKEN){if(process.env.ALISA_TOKEN.length<16)throw new Error('ALISA_TOKEN must be at least 16 characters');return process.env.ALISA_TOKEN}
 if(PROD)throw new Error('ALISA_TOKEN env var is required when NODE_ENV=production (a generated token on an ephemeral disk would change on every deploy)');
 const f=path.join(DATA,'token');try{return fs.readFileSync(f,'utf8').trim()}catch(e){if(e.code!='ENOENT')throw e}const t=crypto.randomBytes(24).toString('base64url');fs.writeFileSync(f,t,{mode:0o600});console.log('Generated API token (also saved to '+f+'):\n  '+t);return t}
const TOKEN=Buffer.from(token());
// ---- sessions: browser logs in once with the access code and keeps only an expiring, HMAC-signed session token (rotating ALISA_TOKEN invalidates every session) ----
const SKEY=crypto.createHmac('sha256',TOKEN).update('alisa-session-v1').digest(),SESSION_MS=30*864e5;
const sign=p=>crypto.createHmac('sha256',SKEY).update(p).digest('base64url'),sha=x=>crypto.createHash('sha256').update(x).digest();
function mkSession(){const exp=Date.now()+SESSION_MS,p=Buffer.from(JSON.stringify({exp,n:crypto.randomBytes(8).toString('hex')})).toString('base64url');return{session:p+'.'+sign(p),expiresAt:exp}}
function goodSession(s){const i=s.indexOf('.');if(i<1)return false;const p=s.slice(0,i),a=Buffer.from(s.slice(i+1)),b=Buffer.from(sign(p));if(a.length!=b.length||!crypto.timingSafeEqual(a,b))return false;try{return JSON.parse(Buffer.from(p,'base64url').toString()).exp>Date.now()}catch(e){return false}}
let B=null;   // storage backend (JSON or PostgreSQL), created in start()
const TOMBSTONE_DAYS=Math.max(7,+process.env.TOMBSTONE_DAYS||60);
const HDR={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Permissions-Policy':'microphone=(self), camera=(), geolocation=()','Cache-Control':'no-store',
 'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://esm.run https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' "+(DIRECT?'https://generativelanguage.googleapis.com ':'')+"https://esm.run https://cdn.jsdelivr.net https://huggingface.co https://*.huggingface.co https://*.hf.co https://raw.githubusercontent.com; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'"};
const send=(r,c,b,t='application/json')=>{r.writeHead(c,{...HDR,...(r.req&&r.req.headers['x-forwarded-proto']=='https'?{'Strict-Transport-Security':'max-age=31536000'}:{}),'Content-Type':t});r.end(typeof b=='string'||Buffer.isBuffer(b)?b:JSON.stringify(b))};
const hits=new Map(),hitsL=new Map(),hitsA=new Map();setInterval(()=>{hits.clear();hitsL.clear();hitsA.clear()},60000).unref();
const limit=(m,ip,max)=>{const n=(m.get(ip)||0)+1;m.set(ip,n);return n>max};
// Behind a cloud proxy every request arrives from the proxy's IP, so with TRUST_PROXY=1 use the LAST x-forwarded-for entry (the one the platform's proxy appended; earlier ones are client-controlled).
const clientIp=q=>{if(TRUST_PROXY){const x=String(q.headers['x-forwarded-for']||'').split(',').pop().trim();if(x)return x}return q.socket.remoteAddress};
const isJson=q=>/^application\/json/.test(q.headers['content-type']||'');
const authed=q=>{const m=/^Bearer (.+)$/.exec(q.headers.authorization||'');if(!m)return false;const b=Buffer.from(m[1]);if(b.length==TOKEN.length&&crypto.timingSafeEqual(b,TOKEN))return true;return goodSession(m[1])};
const readBody=(q,max)=>new Promise((ok,no)=>{let n=0,big=false;const c=[];q.on('data',d=>{n+=d.length;if(big)return;if(n>max){big=true;c.length=0;no({s:413,m:'Body too large'})}else c.push(d)});q.on('end',()=>{if(big)return;try{ok(JSON.parse(Buffer.concat(c).toString()||'null'))}catch(e){no({s:400,m:'Invalid JSON'})}});q.on('error',()=>no({s:400,m:'Read error'}))});
const str=(v,max)=>typeof v=='string'&&v.length<=max;
// ---- /api/ai : Gemini proxy. Validates shape/size, adds the secret key server-side, fixed generation settings. Never executes tools. ----
const FN=/^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
function cleanAI(x){if(!x||typeof x!='object'||!str(x.system,20000))return null;const c=x.contents;if(!Array.isArray(c)||!c.length||c.length>12)return null;const contents=[];
 for(const t of c){if(!t||(t.role!='user'&&t.role!='model')||!Array.isArray(t.parts)||t.parts.length!=1||!t.parts[0]||!str(t.parts[0].text,8000)||!t.parts[0].text.trim())return null;contents.push({role:t.role,parts:[{text:t.parts[0].text}]})}
 if(contents[contents.length-1].role!='user')return null;let tools;
 if(x.tools!==undefined){if(!Array.isArray(x.tools)||x.tools.length>64)return null;const fd=[];for(const d of x.tools){if(!d||typeof d!='object'||!FN.test(d.name||'')||!str(d.description,1000)||JSON.stringify(d).length>4000)return null;fd.push({name:d.name,description:d.description,...(d.parameters&&typeof d.parameters=='object'?{parameters:d.parameters}:{})})}if(fd.length)tools=[{functionDeclarations:fd}]}
 return{system:x.system,contents,tools}}
async function ai(r,x){const v=cleanAI(x);if(!v)return send(r,400,{error:'Bad request'});
 const order=[...new Set([goodModel,process.env.GEMINI_MODEL,...MODELS].filter(Boolean))],end=Date.now()+8500,red=m=>String(m||'').split(GKEY).join('[redacted]').slice(0,200);let last=null;
 for(const m of order){const left=end-Date.now();if(left<400)break;const ac=new AbortController(),to=setTimeout(()=>ac.abort(),left);
  try{const g=await fetch(GBASE+encodeURIComponent(m)+':generateContent',{method:'POST',signal:ac.signal,headers:{'Content-Type':'application/json','x-goog-api-key':GKEY},
    body:JSON.stringify({systemInstruction:{parts:[{text:v.system}]},contents:v.contents,generationConfig:{maxOutputTokens:400,temperature:.7},...(v.tools?{tools:v.tools}:{})})});
   const d=await g.json().catch(()=>({}));
   if(!g.ok){last='Gemini '+g.status+': '+red((d.error&&d.error.message)||g.statusText);if(g.status==404){if(goodModel==m)goodModel=null;continue}console.warn('[ALISA AI]',m,g.status);return send(r,502,{error:last})}
   const parts=(((d.candidates||[])[0]||{}).content||{}).parts||[],fc=parts.find(p=>p.functionCall&&typeof p.functionCall.name=='string');goodModel=m;
   if(fc)return send(r,200,{functionCall:{name:fc.functionCall.name,args:fc.functionCall.args&&typeof fc.functionCall.args=='object'?fc.functionCall.args:{}}});
   const text=parts.map(p=>p.text||'').join('').trim();if(!text)return send(r,502,{error:'Gemini returned no text (possibly blocked by safety filters)'});
   return send(r,200,{text})}
  catch(e){if(e&&e.name=='AbortError')return send(r,504,{error:'Gemini timeout'});console.warn('[ALISA AI] upstream error:',e&&e.message);return send(r,502,{error:'Could not reach Gemini'})}
  finally{clearTimeout(to)}}
 return send(r,502,{error:last||'Gemini timeout'})}
async function api(q,r,u,ip){const[,,st,id]=u.pathname.split('/');if(u.pathname=='/api/health'&&q.method=='GET')return send(r,200,{ok:true,name:'alisa-server',storage:B?B.kind:'starting'});
 if(u.pathname=='/api/login'){if(q.method!='POST')return send(r,405,{error:'Method not allowed'});if(limit(hitsL,ip,8))return send(r,429,{error:'Too many attempts — wait a minute'});if(!isJson(q))return send(r,415,{error:'JSON only'});
  const x=await readBody(q,2e3),c=x&&typeof x.code=='string'?x.code:'';if(!crypto.timingSafeEqual(sha(c),sha(TOKEN)))return send(r,401,{error:'Wrong access code'});return send(r,200,mkSession())}
 if(u.pathname=='/api/ai'){if(q.method!='POST')return send(r,405,{error:'Method not allowed'});if(!authed(q))return send(r,401,{error:'Unauthorized'});if(limit(hitsA,ip,30))return send(r,429,{error:'Too many requests'});
  if(!GKEY)return send(r,503,{error:'AI_NOT_CONFIGURED'});if(!isJson(q))return send(r,415,{error:'JSON only'});return ai(r,await readBody(q,64e3))}
 if(!authed(q))return send(r,401,{error:'Unauthorized'});if(!STORES.includes(st))return send(r,404,{error:'Unknown store'});
 try{
  if(q.method=='GET'&&!id){const since=u.searchParams.get('since');if(since&&!Number.isFinite(Date.parse(since)))return send(r,400,{error:'Bad since'});return send(r,200,await B.list(st,{since:since||undefined}))}   // no ?since → live items only (legacy shape); ?since=ISO → live items + tombstone stubs changed since then
  if(q.method=='DELETE'&&!id){await B.clear(st);return send(r,200,{ok:true})}
  if(!id||!ID.test(id))return send(r,400,{error:'Bad id'});
  if(q.method=='GET'){const x=await B.get(st,id);return x?send(r,x.deleted?410:200,x):send(r,404,{error:'Not found'})}
  if(q.method=='DELETE'){await B.remove(st,id);return send(r,200,{ok:true})}
  if(q.method=='PUT'){if(!isJson(q))return send(r,415,{error:'JSON only'});const x=await readBody(q,st=='memories'?16e3:2.2e6),e=validate(st,id,x);if(e)return send(r,422,{error:e});
   const base=x&&typeof x.baseUpdatedAt=='string'&&Number.isFinite(Date.parse(x.baseUpdatedAt))?new Date(x.baseUpdatedAt).toISOString():undefined;
   const res=await B.put(st,pick(st,x),{base});if(res.conflict)return send(r,409,{error:'conflict',reason:res.reason,current:res.current});return send(r,200,{ok:true,item:res.item})}
 }catch(e){if(e&&e.s)throw e;console.error('[ALISA storage]',e&&(e.code||e.message));return send(r,503,{error:'Storage unavailable'})}
 send(r,405,{error:'Method not allowed'})}
const server=http.createServer(async(q,r)=>{try{const ip=clientIp(q);if(limit(hits,ip,300))return send(r,429,{error:'Too many requests'});
 const u=new URL(q.url,'http://x');if(u.pathname.startsWith('/api/'))return await api(q,r,u,ip);
 if(q.method!='GET'&&q.method!='HEAD')return send(r,405,{error:'Method not allowed'});
 const f=u.pathname=='/'?'index.html':u.pathname.slice(1);if(!Object.hasOwn(FILES,f))return send(r,404,'Not found','text/plain');   // allow-list: server.js, data/, etc. are never served
 let b;try{b=fs.readFileSync(path.join(ROOT,f))}catch(e){if(e.code=='ENOENT')return send(r,404,'Not found','text/plain');throw e}send(r,200,b,FILES[f])}catch(e){if(e&&e.s)return send(r,e.s,{error:e.m});console.error(e);send(r,500,{error:'Server error'})}});
async function start(o={}){B=o.backend||await createBackend(process.env,DATA);
 const purge=()=>B.purge(TOMBSTONE_DAYS).then(n=>{if(n)console.log('[ALISA] purged '+n+' tombstones older than '+TOMBSTONE_DAYS+' days')}).catch(e=>console.warn('[ALISA] tombstone purge failed:',e&&(e.code||e.message)));
 purge();setInterval(purge,864e5).unref();
 await new Promise((ok,no)=>{server.once('error',no);server.listen(o.port!=null?o.port:PORT,HOST,ok)});
 console.log('ALISA server → http://'+(HOST=='0.0.0.0'?'localhost':HOST)+':'+server.address().port+'   storage: '+(B.kind=='postgres'?'PostgreSQL':'JSON files in '+DATA)+'   gemini: '+(GKEY?'configured':'NOT configured (set GEMINI_API_KEY)')+'   proxy-trust: '+(TRUST_PROXY?'on':'off'));
 if(B.kind=='json'&&PROD)console.warn('NOTE: using JSON file storage. On Render\'s free tier the disk is wiped on every restart — set DATABASE_URL (see DEPLOY.md).');
 if(!['127.0.0.1','localhost','::1'].includes(HOST)&&!PROD)console.warn('NOTE: listening on '+HOST+' over plain HTTP. Fine behind an HTTPS host; on a LAN anyone on the network can reach it (set HOST=127.0.0.1 for localhost-only).');
 return server}
async function stop(){await new Promise(ok=>server.close(ok));if(B)await B.close()}
if(require.main===module){
 start().catch(e=>{console.error('[ALISA] startup failed:',e&&e.message);process.exit(1)});   // DATABASE_URL set but unreachable → fail loudly instead of silently using a disk that gets wiped
 for(const sg of['SIGINT','SIGTERM'])process.on(sg,()=>{(B?B.close():Promise.resolve()).catch(()=>{}).then(()=>process.exit(0))})}
module.exports={start,stop,server};
