/* Optional: store ALISA MIND on the ALISA server (PostgreSQL on Neon, or JSON files) while this phone keeps an IndexedDB copy for offline use.
   OFF by default — nothing is sent anywhere until you press "Memory → server" in Settings (or call ALISAConnectServer(sessionToken) in the console).
   The token is kept in memory only. HTTPS is required when the server is not on localhost.

   SYNC MODEL
   • The server assigns every item's updatedAt (server clock; phone clocks are never trusted) and remembers deletions as tombstones.
   • Each local item remembers the server updatedAt it was last synced at (its "base"). A push sends that base; if the server copy changed since, it answers 409.
   • 409 "deleted"        → the item was forgotten elsewhere: the local copy is dropped (deletion wins; a stale phone cannot bring it back).
   • 409 "stale"/"exists" → the server copy is kept for that id and YOUR version is saved as a new item tagged "conflict" — nothing is silently lost.
   • Offline changes wait in an outbox (localStorage) and are pushed when the connection returns. Pull uses GET ?since=<cursor> so deletions arrive too. */
(()=>{'use strict';
const SYNC_KEY='alisa-sync-v1',STORES=['memories','knowledge'];
const uid=()=>crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2,10);

class ALISARemoteStorage{constructor(base,token,fetchFn){this.base=base;this.t=token;this.name='ALISA server';this.f=fetchFn||((...a)=>fetch(...a))}
 async call(m,p,b){const r=await this.f(this.base+p,{method:m,headers:{Authorization:'Bearer '+this.t,...(b?{'Content-Type':'application/json'}:{})},body:b?JSON.stringify(b):undefined});
  if(!r.ok){const body=await r.json().catch(()=>({})),e=new Error('Server '+r.status+': '+(body.error||r.statusText));e.status=r.status;e.body=body;throw e}return r.json()}
 async open(){const h=await this.f(this.base+'/health');if(!h.ok)throw new Error('ALISA server not reachable');await this.call('GET','/memories')}   // also validates the token
 all(s){return this.call('GET','/'+s)}
 changes(s,since){return this.call('GET','/'+s+'?since='+encodeURIComponent(since))}   // live items + tombstone stubs ({id,deleted:true}) changed since the cursor
 put(s,v,baseUpdatedAt){return this.call('PUT','/'+s+'/'+v.id,baseUpdatedAt?{...v,baseUpdatedAt}:v)}
 del(s,id){return this.call('DELETE','/'+s+'/'+id)}clear(s){return this.call('DELETE','/'+s)}}

class CachedRemoteStorage{
 /* remote: ALISARemoteStorage · local: IDBStorage/MemoryStorage (the offline cache) · opts.state: {get(),set(v)} (default: localStorage) */
 constructor(remote,local,opts={}){this.remote=remote;this.local=local;this.name='ALISA server (cached on this phone)';this.online=false;this.lastError=null;this.conflicts=0;this.onChange=null;this.busy=null;this.lastSync=0;
  const ls=opts.state||{get(){try{return JSON.parse(localStorage.getItem(SYNC_KEY)||'null')}catch(e){return null}},set(v){try{localStorage.setItem(SYNC_KEY,JSON.stringify(v))}catch(e){}}};
  this.ls=ls;const st=ls.get()||{};this.st={bases:{memories:{},knowledge:{},...(st.bases||{})},since:{memories:null,knowledge:null,...(st.since||{})},outbox:Array.isArray(st.outbox)?st.outbox:[]};
  if(!opts.noEvents&&typeof window!=='undefined'&&window.addEventListener&&typeof document!=='undefined'){window.addEventListener('online',()=>this.sync().catch(()=>{}));
   document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&Date.now()-this.lastSync>15000)this.sync().catch(()=>{})})}}
 save(){this.ls.set(this.st)}
 attach(fn){this.onChange=fn}
 pending(){return this.st.outbox.length}
 status(){return{online:this.online,pending:this.pending(),lastError:this.lastError,conflicts:this.conflicts}}
 queue(op,s,id){this.st.outbox=this.st.outbox.filter(e=>!(e.s===s&&e.id===id));this.st.outbox.push({op,s,id});this.save()}
 isPending(s,id){return this.st.outbox.some(e=>e.s===s&&e.id===id)}
 pendingFor(s){return this.st.outbox.some(e=>e.s===s)}
 cached(s){return this.local.all(s)}
 async open(){await this.local.open();try{await this.remote.open();this.online=true}catch(e){this.online=false;this.lastError=e.message;this.openError=e}}
 // ---- StorageAdapter API used by ALISAMind ----
 async all(s){if(this.online||this.pending()){try{await this.sync(s)}catch(e){}}return this.local.all(s)}
 async put(s,v){await this.local.put(s,v);this.queue('put',s,v.id);this.kick()}
 async del(s,id){await this.local.del(s,id);if(this.st.bases[s][id])this.queue('del',s,id);else{this.st.outbox=this.st.outbox.filter(e=>!(e.s===s&&e.id===id));this.save()}this.kick()}   // never reached the server → nothing to delete there
 async clear(s){if(this.online){try{await this.sync(s)}catch(e){}}const ids=(await this.local.all(s)).map(x=>x.id);await this.local.clear(s);
  for(const id of ids){if(this.st.bases[s][id])this.queue('del',s,id);else this.st.outbox=this.st.outbox.filter(e=>!(e.s===s&&e.id===id))}this.save();this.kick()}
 kick(){if(this.pending()||this.online)this.sync().catch(()=>{})}
 // ---- sync: push the outbox, then pull changes (including tombstones) ----
 sync(only){if(this.busy)return this.busy.catch(()=>{}).then(()=>this.sync(only));   // never reuse an in-flight pass: items queued (or connectivity restored) after it started need a fresh one
  this.busy=(async()=>{let changed=false;try{
   for(const s of(only?[only]:STORES)){if(await this.flush(s))changed=true;if(!this.pendingFor(s)&&await this.pull(s))changed=true}
   this.online=true;this.lastError=null;this.lastSync=Date.now()}
  catch(e){this.lastError=e&&e.status===401?'Session expired — sign in again':(e&&e.message);if(!(e&&e.status&&e.status<500&&e.status!==401))this.online=false;throw e}
  finally{this.busy=null;this.save();if(changed&&this.onChange){try{await this.onChange()}catch(e){}}}})();return this.busy}
 drop(e){this.st.outbox=this.st.outbox.filter(x=>!(x.s===e.s&&x.id===e.id&&x.op===e.op))}
 async flush(s){let changed=false;const items=new Map((await this.local.all(s)).map(x=>[x.id,x]));
  for(const e of this.st.outbox.filter(x=>x.s===s)){
   if(e.op==='del'){try{await this.remote.del(s,e.id)}catch(err){if(err.status&&err.status<500&&err.status!==401&&err.status!==429){this.drop(e);continue}throw err}delete this.st.bases[s][e.id];this.drop(e);continue}
   const it=items.get(e.id);if(!it){this.drop(e);continue}
   try{const r=await this.remote.put(s,it,this.st.bases[s][e.id]);this.st.bases[s][e.id]=r.item.updatedAt;this.drop(e)}
   catch(err){
    if(err.status===409){changed=true;await this.resolve(s,it,err.body||{});this.drop(e);continue}
    if(err.status&&err.status>=400&&err.status<500&&err.status!==401&&err.status!==429){this.lastError='Server rejected an item ('+(err.body&&err.body.error||err.status)+')';this.drop(e);continue}   // invalid item: don't block the queue forever
    throw err}}
  this.save();return changed}
 async resolve(s,mine,body){const cur=body.current;this.conflicts++;
  if(body.reason==='deleted'||!cur||cur.deleted){await this.local.del(s,mine.id);delete this.st.bases[s][mine.id];return}   // forgotten elsewhere → the deletion wins
  const same=s==='memories'?mine.content===cur.content:(mine.title===cur.title&&mine.content===cur.content);
  if(!same){const now=new Date().toISOString(),copy={...mine,id:uid(),createdAt:now,updatedAt:now};   // keep the losing edit as a NEW item
   if(s==='memories')copy.tags=[...new Set([...(mine.tags||[]),'conflict'])].slice(0,10);else copy.title=(mine.title+' (conflict copy)').slice(0,200);
   await this.local.put(s,copy);this.queue('put',s,copy.id)}
  await this.local.put(s,cur);this.st.bases[s][mine.id]=cur.updatedAt}
 async pull(s){let changed=false,max=null;const since=this.st.since[s],bump=u=>{if(u&&(!max||u>max))max=u},B=this.st.bases[s];
  if(!since){const live=await this.remote.all(s),have=new Map((await this.local.all(s)).map(x=>[x.id,x])),seen=new Set();
   for(const it of live){seen.add(it.id);bump(it.updatedAt);if(this.isPending(s,it.id))continue;if(B[it.id]!==it.updatedAt){await this.local.put(s,it);B[it.id]=it.updatedAt;changed=true}}
   for(const[id]of have){if(seen.has(id)||this.isPending(s,id))continue;
    if(B[id]){await this.local.del(s,id);delete B[id];changed=true}   // synced before, gone now → forgotten elsewhere
    else this.queue('put',s,id)}                                        // never synced → the first connect uploads it
   if(this.pendingFor(s)){this.save();if(await this.flush(s))changed=true}}
  else{for(const r of await this.remote.changes(s,since)){bump(r.updatedAt);if(this.isPending(s,r.id))continue;
    if(r.deleted){await this.local.del(s,r.id);if(B[r.id]){delete B[r.id];changed=true}}   // idempotent
    else if(B[r.id]!==r.updatedAt){await this.local.put(s,r);B[r.id]=r.updatedAt;changed=true}}}
  if(max)this.st.since[s]=max;this.save();return changed}}

window.ALISARemoteStorage=ALISARemoteStorage;window.ALISACachedStorage=CachedRemoteStorage;
window.ALISAConnectServer=async(token,o={})=>{const M=window.ALISAMind;if(!M)throw new Error('ALISA MIND not loaded');
 const remote=new ALISARemoteStorage(o.base||'/api',token);let local;try{local=new M.IDBStorage();await local.open()}catch(e){local=new M.MemoryStorage()}
 const a=new CachedRemoteStorage(remote,local);await a.open();
 if(!a.online&&a.openError&&a.openError.status)throw a.openError;   // the server answered but refused (bad/expired token…) → don't switch; plain "offline" is fine: the phone cache keeps working
 await M.setStorage(a);return{server:a.name,online:a.online,uploaded:a.pending()}};
})();
