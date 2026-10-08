/* ALISA MIND — working memory · long-term memory · knowledge. Independent module: window.ALISAMind.
   Storage: long-term memory + knowledge → IndexedDB 'alisa-mind' (plain, UNENCRYPTED, on this device/browser only); working memory → RAM mirrored to sessionStorage (cleared with the tab).
   Nothing is sent to any server. No audio is ever stored. Secrets (passwords, tokens, API keys…) are refused by a pattern filter (best-effort, not perfect).
   Phase 2.5: alisa-memory-intelligence.js (optional, loaded before this file) classifies what is worth remembering, filters credentials before anything is stored, and handles duplicates / changed preferences; this file stays the single place memory is written.
   Long-term memory is only written by an explicit add() / "remember…" request or an Allow on a suggestion. Search is local keyword ranking (normalization, stemming, synonyms, tags, recency — see alisa-retrieval.js) — NOT semantic/vector search.
   Memory metadata (all optional; older items without them keep working): confidence, lastUsedAt, tags, supersedes, private, schemaVersion, updatedAt.
   Items with private:true are NEVER included in anything sent to the cloud AI, even when "Share memory with cloud AI" is on. */
(()=>{'use strict';
const CATS=['preferences','importantFacts','goals','approvedMemories'],TYPES=['document','note','imported'],SKEY='alisa-mind-working';
const uid=()=>crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2,10),now=()=>new Date().toISOString();
const warn=(w,e)=>{ALISAMind.lastError=w+': '+((e&&e.message)||e);console.warn('[ALISA MIND]',ALISAMind.lastError)},emit=(n,d)=>{try{window.dispatchEvent(new CustomEvent('alisamind:'+n,{detail:d}))}catch(e){}};
const STRICT=[/\b(password|passcode|passphrase|pin|api[\s_-]?key|token|secret|cvv)\b\s*(is|are|=|:)/i,/\b(sk|pk|ghp|xox[bp]|AKIA)[-_A-Za-z0-9]{12,}/,/\bBearer\s+\S{10,}/i],LOOSE=[...STRICT,/\b[A-Za-z0-9+\/_=-]{32,}\b/,/\b\d{13,19}\b/];
const looksSecret=(t,loose=true)=>(loose?LOOSE:STRICT).some(r=>r.test(String(t)));
const MI=()=>window.ALISAMemoryIntelligence,secretish=t=>looksSecret(t)||!!(MI()&&MI().isSensitive(t));   // Phase 2.5: stricter credential filter (backup codes, OTPs, JWTs, cookies…) when the intelligence module is loaded
const STOP=new Set('the a an i my me you your about for that this to of and is are was what do does did in on at it with be have has'.split(' '));
const tok=s=>(String(s).toLowerCase().match(/[a-z0-9\u00c0-\uffff]+/g)||[]).filter(w=>!STOP.has(w));
function score(q,fields){const qt=tok(q);if(!qt.length)return 0;const ph=String(q).toLowerCase().trim();let sc=0;
 for(const[t,w]of fields){const l=String(t).toLowerCase(),tk=[...new Set(tok(l))];if(l.includes(ph))sc+=w*3;
  for(const x of qt){if(tk.includes(x))sc+=w;else if(x.length>3&&tk.some(y=>y.length>3&&(y.startsWith(x.slice(0,4)))))sc+=w*.4}}return sc}
const snip=(t,q,n=160)=>{const l=t.toLowerCase(),k=tok(q).map(x=>l.indexOf(x)).filter(i=>i>=0).sort((a,b)=>a-b)[0]||0,s=Math.max(0,k-40);return(s?'…':'')+t.slice(s,s+n)+(s+n<t.length?'…':'')};
const RET=()=>window.ALISARetrieval,SV=2;
// rank a list of items for a query: new retrieval when loaded, old keyword scoring as a fallback
const rankItems=(q,items,limit)=>RET()?RET().rank(q,items,{limit}):items.map(m=>({...m,score:score(q,[[m.content,2],[m.category,.5]])})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,limit);
const tagsClean=t=>{if(t==null)return undefined;const out=[];for(let x of Array.isArray(t)?t:String(t).split(',')){x=String(x).trim().toLowerCase().slice(0,40);if(!x)continue;if(looksSecret(x))throw new Error('Refusing to store what looks like a secret in a tag.');if(!out.includes(x))out.push(x)}return out.slice(0,10)};
const confClean=c=>{if(c==null)return undefined;c=+c;if(!Number.isFinite(c))throw new Error('Confidence must be a number between 0 and 1.');return Math.min(1,Math.max(0,c))};
const supersededIds=()=>new Set([...M.values()].map(m=>m.supersedes).filter(Boolean));
const expired=m=>!!m.expiresAt&&Date.parse(m.expiresAt)<Date.now();
const liveMemories=()=>{const h=supersededIds();return[...M.values()].filter(m=>!h.has(m.id)&&!expired(m))};   // superseded (replaced) and expired memories are not active: hidden from search, context and the semantic index
// ---- storage abstraction: any object with open/all/put/del/clear can replace these (e.g. a backend client) via ALISAMind.setStorage(adapter) ----
class IDBStorage{constructor(n='alisa-mind'){this.n=n}
 open(){return this.d?Promise.resolve():new Promise((r,j)=>{if(typeof indexedDB=='undefined')return j(new Error('IndexedDB unavailable'));const o=indexedDB.open(this.n,1);o.onupgradeneeded=()=>{['memories','knowledge'].forEach(s=>o.result.createObjectStore(s,{keyPath:'id'}))};o.onsuccess=()=>{this.d=o.result;r()};o.onerror=()=>j(o.error)})}
 tx(s,m,f){return new Promise((r,j)=>{const t=this.d.transaction(s,m),q=f(t.objectStore(s));t.oncomplete=()=>r(q&&q.result);t.onerror=()=>j(t.error)})}
 all(s){return this.tx(s,'readonly',o=>o.getAll())}put(s,v){return this.tx(s,'readwrite',o=>o.put(v))}del(s,id){return this.tx(s,'readwrite',o=>o.delete(id))}clear(s){return this.tx(s,'readwrite',o=>o.clear())}}
class MemoryStorage{constructor(){this.m={memories:new Map(),knowledge:new Map()}}async open(){}async all(s){return[...this.m[s].values()]}async put(s,v){this.m[s].set(v.id,v)}async del(s,id){this.m[s].delete(id)}async clear(s){this.m[s].clear()}}
let storage=new IDBStorage();const M=new Map(),K=new Map(),P=new Map(),status={storage:'idle',persistent:false};
const wr=(p)=>p.catch(e=>warn('storage write failed',e));
let ready=(async()=>{try{await storage.open();for(const[s,m]of[['memories',M],['knowledge',K]])(await storage.all(s)).forEach(x=>m.set(x.id,x));status.storage='IndexedDB';status.persistent=true}
 catch(e){warn('persistent storage unavailable — memory-only for this session',e);storage=new MemoryStorage();status.storage='memory-only (not persistent)'}emit('change',{})})();
// ---- working memory (session only) ----
const W=new Map();try{const j=JSON.parse(sessionStorage.getItem(SKEY)||'{}');Object.keys(j).forEach(k=>W.set(k,j[k]))}catch(e){}
const flush=()=>{try{sessionStorage.setItem(SKEY,JSON.stringify(Object.fromEntries(W)))}catch(e){warn('session mirror failed',e)}emit('change',{})};
const working={set(k,v){if(!k)throw new Error('key required');if(secretish(JSON.stringify(v)+' '+k))throw new Error('Refusing to keep what looks like a secret in working memory.');W.set(String(k),v);flush();return v},
 get:k=>W.get(k),remove(k){const r=W.delete(k);flush();return r},clear(){W.clear();flush()},getAll:()=>Object.fromEntries(W),
 setTask(t,s='active'){working.set('task',t);working.set('taskStatus',s)},
 pushCommand(t){if(secretish(t))return false;const a=(W.get('recentCommands')||[]).concat({text:String(t).slice(0,200),at:now()}).slice(-10);W.set('recentCommands',a);flush();return true},
 pushTurn(role,t){if(secretish(t))return false;const a=(W.get('conversation')||[]).concat({role,text:String(t).slice(0,300)}).slice(-10);W.set('conversation',a);flush();return true}};
// ---- long-term memory ----
const clean=c=>{c=String(c==null?'':c).trim();if(!c)throw new Error('Content is empty.');if(c.length>1000)throw new Error('Memory too long (max 1000 characters).');if(secretish(c))throw new Error('Refusing to store what looks like a secret (password, token, key, card number).');return c};
const cat=c=>{if(!CATS.includes(c))throw new Error('Unknown category "'+c+'". Use: '+CATS.join(', '));return c};
const cp=x=>x&&JSON.parse(JSON.stringify(x));
const intelClean=m=>{if(!m||typeof m!='object')return undefined;const o={};if(typeof m.category=='string')o.category=m.category.slice(0,30);if(Number.isFinite(+m.confidence))o.confidence=Math.min(1,Math.max(0,+m.confidence));if(typeof m.persistence=='string')o.persistence=m.persistence.slice(0,20);if(typeof m.reason=='string'&&!secretish(m.reason))o.reason=m.reason.slice(0,200);return Object.keys(o).length?o:undefined};   // classification metadata only; never raw secrets
const memory={
 add(category,content,opts={}){cat(category);content=clean(content);const tags=tagsClean(opts.tags),conf=confClean(opts.confidence);
  if(opts.supersedes&&!M.has(opts.supersedes))throw new Error('Cannot supersede a memory that does not exist.');
  const dup=[...M.values()].find(m=>m.category==category&&m.content.toLowerCase()==content.toLowerCase());
  if(dup){dup.updatedAt=now();if(tags&&tags.length)dup.tags=[...new Set([...(dup.tags||[]),...tags])].slice(0,10);wr(storage.put('memories',dup));emit('change',{});return cp(dup)}
  const it={id:uid(),category,content,createdAt:now(),updatedAt:now(),source:opts.source||'user-request',approved:true,schemaVersion:SV,private:opts.private===true};
  if(conf!==undefined)it.confidence=conf;if(tags&&tags.length)it.tags=tags;if(opts.supersedes)it.supersedes=opts.supersedes;
  const im=intelClean(opts.meta);if(im)it.intel=im;if(opts.expiresAt&&Number.isFinite(Date.parse(opts.expiresAt)))it.expiresAt=new Date(opts.expiresAt).toISOString();
  M.set(it.id,it);wr(storage.put('memories',it));emit('change',{});return cp(it)},
 get:id=>cp(M.get(id))||null,
 live:()=>liveMemories().map(cp),
 async searchAsync(q,limit=10){const r=await semRun(S=>S.semanticSearch(q,{types:['memory'],limit}));   // semantic (hybrid) only when the model is really loaded and indexed; otherwise EXACTLY the Phase 1 keyword path
  if(!r)return memory.search(q,limit);return r.map(x=>{const m=M.get(x.id);return m?{...cp(m),score:x.relevance,relevance:x.relevance,similarity:x.similarity,mode:x.metadata.mode}:null}).filter(Boolean)},
 search(q,limit=10){return rankItems(q,liveMemories().map(cp),limit)},   // hides memories superseded by a newer one
 touch(ids){const t=now(),day=864e5;for(const id of ids){const m=M.get(id);if(m&&(!m.lastUsedAt||Date.parse(t)-Date.parse(m.lastUsedAt)>day)){m.lastUsedAt=t;wr(storage.put('memories',m))}}},   // updatedAt is NOT bumped; written at most once a day per memory
 getByCategory(c){cat(c);return[...M.values()].filter(m=>m.category==c).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(cp)},
 getAll:()=>[...M.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(cp),
 update(id,content,patch={}){const m=M.get(id);if(!m)return null;const next={...m};if(content!=null)next.content=clean(content);
  if(patch.tags!==undefined){const t=tagsClean(patch.tags);if(t&&t.length)next.tags=t;else delete next.tags}if(patch.private!==undefined)next.private=patch.private===true;
  if(patch.confidence!==undefined){const c=confClean(patch.confidence);if(c===undefined)delete next.confidence;else next.confidence=c}if(patch.category){cat(patch.category);next.category=patch.category}
  next.updatedAt=now();next.schemaVersion=SV;M.set(id,next);wr(storage.put('memories',next));emit('change',{});return cp(next)},
 remove(id){const r=M.delete(id);if(r){wr(storage.del('memories',id));emit('change',{})}return r},
 removeSmart(id){const m=M.get(id);if(!m)return false;const ids=[id];if(m.intel){let c=m,g=0;while(c&&c.supersedes&&M.has(c.supersedes)&&g++<20){ids.push(c.supersedes);c=M.get(c.supersedes)}}   // forgetting a replaced preference also forgets the older versions it replaced — they must not resurface
  for(const x of ids){M.delete(x);wr(storage.del('memories',x))}emit('change',{});return true},
 purgeExpired(){const ids=[...M.values()].filter(expired).map(m=>m.id);for(const id of ids){M.delete(id);wr(storage.del('memories',id))}if(ids.length)emit('change',{});return ids.length},
 clear(){M.clear();wr(storage.clear('memories'));emit('change',{})},
 // suggest(): NOT saved. Shows "ALISA wants to remember…" for the UI; only allow()/approve() stores it.
 suggest(content,category='approvedMemories',extra={}){cat(category);content=clean(content);const s={id:uid(),category,content,createdAt:now(),text:'ALISA wants to remember:\n'+content,label:typeof extra.label=='string'?extra.label.slice(0,60):'Needs approval',supersedes:extra.supersedes,meta:intelClean(extra.meta),confidence:extra.confidence,allow:()=>memory.approve(s.id),reject:()=>memory.reject(s.id)};P.set(s.id,s);emit('suggest',s);emit('change',{});return s},
 pending:()=>[...P.values()],
 approve(id){const s=P.get(id);if(!s)return null;P.delete(id);return memory.add(s.category,s.content,{source:'suggestion-approved',supersedes:s.supersedes&&M.has(s.supersedes)?s.supersedes:undefined,meta:s.meta,confidence:s.confidence})},
 reject(id){const r=P.delete(id);emit('change',{});return r}};
// ---- knowledge (documents / notes / imported) ----
const ktype=t=>{if(!TYPES.includes(t))throw new Error('Unknown type "'+t+'". Use: '+TYPES.join(', '));return t};
const kclean=(title,content)=>{title=String(title||'').trim();content=String(content==null?'':content);if(!title)throw new Error('Title is required.');if(!content.trim())throw new Error('Content is empty.');if(content.length>2e6)throw new Error('Content too large (max ~2 MB).');if(looksSecret(title+' '+content,false))throw new Error('Refusing to store what looks like a secret/credential.');return[title.slice(0,200),content]};
const knowledge={
 add(type,title,content,opts={}){ktype(type);[title,content]=kclean(title,content);const it={id:uid(),type,title,content,createdAt:now(),updatedAt:now(),source:opts.source||'user-added'};K.set(it.id,it);wr(storage.put('knowledge',it));emit('change',{});return cp(it)},
 get:id=>cp(K.get(id))||null,
 search(q,limit=10){return[...K.values()].map(k=>({id:k.id,type:k.type,title:k.title,source:k.source,updatedAt:k.updatedAt,snippet:snip(k.content,q),score:score(q,[[k.title,3],[k.content,1]])})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,limit)},
 getByType(t){ktype(t);return[...K.values()].filter(k=>k.type==t).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(cp)},
 getAll:()=>[...K.values()].map(cp),
 async searchAsync(q,limit=10){const r=await semRun(S=>S.semanticSearch(q,{types:['knowledge'],limit}));if(!r)return knowledge.search(q,limit);
  return r.map(x=>{const k=K.get(x.id);return k?{id:k.id,type:k.type,title:k.title,source:k.source,updatedAt:k.updatedAt,snippet:x.text.slice(k.title.length+2)||snip(k.content,q),score:x.relevance,similarity:x.similarity}:null}).filter(Boolean)},
 update(id,d){const k=K.get(id);if(!k)return null;const t=d.title!=null?d.title:k.title,c=d.content!=null?d.content:k.content;if(d.type)ktype(d.type);[k.title,k.content]=kclean(t,c);if(d.type)k.type=d.type;k.updatedAt=now();wr(storage.put('knowledge',k));emit('change',{});return cp(k)},
 remove(id){const r=K.delete(id);if(r){wr(storage.del('knowledge',id));emit('change',{})}return r},
 clear(){K.clear();wr(storage.clear('knowledge'));emit('change',{})}};
// ---- unified search / context ----
function search(q){const wm=W.size?[...W.entries()].map(([k,v])=>({key:k,value:v,score:score(q,[[k,2],[JSON.stringify(v),1]])})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score):[];
 return{query:q,workingMemory:wm,longTermMemory:memory.search(q),knowledge:knowledge.search(q)}}   // keyword-ranked, not semantic
// Runs fn(semanticInstance) ONLY if semantic retrieval is genuinely available (model loaded + something indexed); otherwise returns null so callers use Phase 1 keyword code. Never throws.
async function semRun(fn){try{const S=window.ALISASemantic,i=S&&S.instance;if(!i)return null;const st=i.getStatus();if(!st.semanticAvailable||!st.indexedItemCount)return null;
 const r=await fn(i);return r&&r.semantic?r:null}catch(e){warn('semantic search',e);return null}}
/* getContextAsync = getContext with semantic retrieval + a size budget. Without a loaded model it returns the Phase 1 context unchanged. It does NOT pad with unrelated
   "recent/goal" memories: weak matches are left out, and an empty memory list is a valid answer ("I don't have that"). */
const IMPORTANCE={goals:.9,preferences:.7,importantFacts:.6,approvedMemories:.5},meta4=m=>({confidence:m.confidence,importance:IMPORTANCE[m.category]||.5,updatedAt:m.updatedAt,active:true});   // useful metadata for the Brain; internal security/classification details are NOT passed on
async function getContextAsync(q='',o={}){
 const base=getContext(q,o),S=window.ALISASemantic,i=S&&S.instance;base.retrieval={mode:'keyword',semantic:false};
 if(!q||!i)return base;
 try{const st=i.getStatus();if(!st.semanticAvailable||!st.indexedItemCount)return base;
  const sel=await Promise.race([i.selectContext(q,{cloud:o.cloud,task:W.get('task')||null,maxMemories:o.maxMemories,maxKnowledge:o.maxKnowledge,maxLength:o.maxLength}),new Promise((_,no)=>setTimeout(()=>no(new Error('semantic context timed out')),i.cfg.CONTEXT_TIMEOUT_MS))]);
  if(!sel.semantic)return base;
  base.memories=sel.memories.map(r=>{const m=M.get(r.id)||{};return{id:r.id,category:r.category,content:r.text,private:r.metadata.private===true,relevance:r.relevance,...meta4(m)}});
  base.knowledge=sel.knowledge.map(r=>({id:r.id,type:r.category,title:r.metadata.title,snippet:r.text.slice((r.metadata.title||'').length+2)}));
  base.retrieval={mode:'hybrid',semantic:true,memories:base.memories.length,knowledge:base.knowledge.length,chars:sel.length};
  base.note='Ranked by meaning + keywords and size-capped; only relevant items are included. If nothing relevant is listed, ALISA has no stored memory about it. Long-term memory is private — only pass this to a processor after the user has been authorized.';
  return base}catch(e){warn('semantic context',e);return base}}
function getContext(q='',o={}){const nm=o.maxMemories||5,nk=o.maxKnowledge||3,pool=liveMemories().filter(m=>!secretish(m.content)).map(cp);let mem=q?rankItems(q,pool,nm):[];
 if(mem.length<nm){const have=new Set(mem.map(m=>m.id));pool.sort((a,b)=>(b.category=='goals')-(a.category=='goals')||b.updatedAt.localeCompare(a.updatedAt)).filter(m=>!have.has(m.id)&&m.category!='approvedMemories').slice(0,nm-mem.length).forEach(m=>mem.push(m))}
 if(o.cloud)mem=mem.filter(m=>m.private!==true&&!looksSecret(m.content));   // a processor outside this device never receives private memories
 const w={...Object.fromEntries(W)};['task','taskStatus','recentCommands','conversation'].forEach(k=>delete w[k]);
 return{generatedAt:now(),task:W.get('task')||null,taskStatus:W.get('taskStatus')||null,recentCommands:(W.get('recentCommands')||[]).slice(-5).map(c=>c.text),recentConversation:(W.get('conversation')||[]).slice(-4),working:w,
  memories:mem.slice(0,nm).map(m=>({id:m.id,category:m.category,content:m.content,private:m.private===true,...meta4(m)})),knowledge:q?knowledge.search(q,nk).map(k=>({id:k.id,type:k.type,title:k.title,snippet:k.snippet.slice(0,240)})):[],
  note:'Ranked locally and size-capped; not the whole database. Long-term memory is private — only pass this to a processor after the user has been authorized.'}}
// ---- privacy ----
const exportData=()=>({format:'alisa-mind',version:1,exportedAt:now(),encrypted:false,memories:memory.getAll(),knowledge:knowledge.getAll()});   // plain JSON, working memory excluded
function importData(d,o={}){if(typeof d=='string')d=JSON.parse(d);if(!d||d.format!='alisa-mind'||d.version!=1)throw new Error('Not an ALISA MIND export (format/version mismatch).');const r={memories:0,knowledge:0,skipped:0};if(o.replace){memory.clear();knowledge.clear()}
 for(const m of d.memories||[]){try{cat(m.category);const c=clean(m.content),it={id:M.has(m.id)?uid():(m.id||uid()),category:m.category,content:c,createdAt:m.createdAt||now(),updatedAt:m.updatedAt||now(),source:(m.source||'imported')+'',approved:true,schemaVersion:SV,private:m.private===true};
  try{const t=tagsClean(m.tags);if(t&&t.length)it.tags=t}catch(e){}try{const cf=confClean(m.confidence);if(cf!==undefined)it.confidence=cf}catch(e){}if(typeof m.lastUsedAt=='string')it.lastUsedAt=m.lastUsedAt;if(typeof m.supersedes=='string')it.supersedes=m.supersedes;const im=intelClean(m.intel);if(im)it.intel=im;if(typeof m.expiresAt=='string'&&Number.isFinite(Date.parse(m.expiresAt)))it.expiresAt=m.expiresAt;M.set(it.id,it);wr(storage.put('memories',it));r.memories++}catch(e){r.skipped++}}
 for(const k of d.knowledge||[]){try{ktype(k.type);const[t,c]=kclean(k.title,k.content),it={id:K.has(k.id)?uid():(k.id||uid()),type:k.type,title:t,content:c,createdAt:k.createdAt||now(),updatedAt:k.updatedAt||now(),source:(k.source||'imported')+''};K.set(it.id,it);wr(storage.put('knowledge',it));r.knowledge++}catch(e){r.skipped++}}emit('change',{});return r}
function clearAll(){memory.clear();knowledge.clear();P.clear();working.clear()}
// ---- memory TOOLS: remember · search_memory · update_memory · forget_memory ----
// One implementation shared by the voice grammar below and by the Gemini function-calling tools in commands.js.
// Every tool passes the same secret filter (inputs AND outputs). Results are {ok,status,text,...}; `text` is what ALISA says.
// A model-initiated update/forget NEVER changes anything by itself: it returns status 'needs-confirmation' + commit(), and commands.js only
// runs commit() after the USER says "yes". Ambiguous matches (several similar memories) change nothing and ask for more detail.
const MIN_UNIQUE=2,DOMINANCE=1.5,short=t=>t.length>70?t.slice(0,67)+'…':t,quote=t=>'“'+short(t)+'”';
const res=(status,text,extra={})=>({ok:['saved','found','updated','forgotten','needs-confirmation'].includes(status),status,text,...extra});
const cleanBrief=m=>({id:m.id,category:m.category,content:m.content,tags:m.tags||[],private:m.private===true,score:m.score});
function resolveTarget(a){a=a||{};
 if(a.id){const m=M.get(String(a.id));return m?{kind:'unique',item:cp(m),candidates:[cp(m)]}:{kind:'none',candidates:[]}}
 const q=String(a.query==null?'':a.query).trim();if(!q)return{kind:'empty',candidates:[]};if(looksSecret(q))return{kind:'secret',candidates:[]};
 const r=memory.search(q,5);if(!r.length)return{kind:'none',candidates:[]};
 const top=r[0].score,second=r[1]?r[1].score:0;
 if(top>=MIN_UNIQUE&&(!r[1]||top>=second*DOMINANCE))return{kind:'unique',item:r[0],candidates:r};
 return{kind:'ambiguous',candidates:r}}
const ambiguousText=(verb,c)=>c.length>1?'I found '+c.length+' similar memories — '+c.slice(0,3).map(m=>quote(m.content)).join('; ')+(c.length>3?'; and more':'')+'. I didn’t '+verb+' any. Please say which one, with a bit more detail.':
 'I found one possible match, '+quote(c[0].content)+', but I’m not sure it’s the one you mean, so I didn’t '+verb+' it. Please say it with a bit more detail.';
const tools={
 async remember(a,o={}){await ready;a=a||{};const voice=o.source==='voice';
  try{const raw=a.content!=null?a.content:a.text;if(looksSecret(raw))return res('refused','I can’t store passwords, tokens, keys or other secrets in memory.');
   const content=String(raw==null?'':raw).trim(),category=a.category&&CATS.includes(a.category)?a.category:guess(content);
   if(secretish(content))return res('refused','I can’t store passwords, tokens, keys or other secrets in memory.');
   const mi=MI();if(mi&&!a.supersedes&&!a.category){   // Phase 2.5: explicit request → duplicate / changed-preference handling + classification metadata, then the same memory.add() path
    const r=await mi.process(content,{explicit:true,source:voice?'voice-command':'model-tool',tags:a.tags,private:a.private===true,confidence:a.confidence!=null?a.confidence:(voice?1:.8)});
    if(r.action=='rejected')return res('refused','I can’t store passwords, tokens, keys or other secrets in memory.');
    if(r.item)return res('saved',r.action=='duplicate'?r.say:r.action=='updated'?r.say:'Okay, I’ll remember that: '+r.item.content+'.',{item:cleanBrief(r.item),action:r.action});
    if(r.action=='working')return res('invalid',r.say||'I couldn’t save that safely.')}
   const it=memory.add(category,up(content),{source:voice?'voice-command':'model-tool',tags:a.tags,private:a.private===true,confidence:a.confidence!=null?a.confidence:(voice?1:.8),supersedes:a.supersedes});
   return res('saved','Okay, I’ll remember that: '+it.content+'.',{item:cleanBrief(it)})}
  catch(e){return res(/secret/i.test(e.message)?'refused':'invalid','I couldn’t save that: '+e.message)}},
 async search(a,o={}){await ready;a=a||{};const q=String(a.query==null?'':a.query).trim();
  if(!q)return res('invalid','What should I look for in your memories?');if(looksSecret(q))return res('refused','I can’t search for passwords, tokens or keys — I don’t store them.');
  const lim=Math.min(Math.max(+a.limit||3,1),5),r=(await memory.searchAsync(q,lim*2)).filter(m=>!secretish(m.content)).slice(0,lim);   // output filter: legacy/imported rows that look like secrets are never read out
  if(!r.length)return res('none','I don’t have a memory about that.',{results:[]});memory.touch(r.map(m=>m.id));
  return res('found','I remember: '+r.map(m=>m.content.replace(/[.!?]+$/,'')).join('; ')+'.',{results:r.map(cleanBrief)})},
 async update(a,o={}){await ready;a=a||{};let content;
  try{content=clean(a.new_content!=null?a.new_content:a.content)}catch(e){return res(/secret/i.test(e.message)?'refused':'invalid','I couldn’t update that: '+e.message)}
  const t=resolveTarget(a);
  if(t.kind=='empty')return res('invalid','Which memory should I change?');if(t.kind=='secret')return res('refused','I can’t search for passwords, tokens or keys.');
  if(t.kind=='none')return res('not-found','I don’t have a memory matching that.');if(t.kind=='ambiguous')return res('ambiguous',ambiguousText('change',t.candidates),{candidates:t.candidates.map(cleanBrief)});
  const target=t.item,expected=target.updatedAt;
  const commit=async()=>{const cur=M.get(target.id);if(!cur)return res('not-found','That memory is gone, so I didn’t change it.');if(cur.updatedAt!==expected)return res('changed','That memory changed in the meantime, so I didn’t update it. Please ask again.');
   try{clean(content)}catch(e){return res('refused','I couldn’t update that: '+e.message)}const it=memory.update(target.id,content,{confidence:a.confidence,tags:a.tags});return res('updated','Updated. Now it says: '+it.content+'.',{item:cleanBrief(it)})};
  if(o.confirmed)return commit();
  return res('needs-confirmation','Change '+quote(target.content)+' to '+quote(content)+'?',{commit,item:cleanBrief(target)})},
 async forget(a,o={}){await ready;a=a||{};const t=resolveTarget(a);
  if(t.kind=='empty')return res('invalid','Which memory should I forget?');if(t.kind=='secret')return res('refused','I can’t search for passwords, tokens or keys.');
  if(t.kind=='none')return res('not-found','I don’t have a memory matching that.');if(t.kind=='ambiguous')return res('ambiguous',ambiguousText('delete',t.candidates),{candidates:t.candidates.map(cleanBrief)});
  const target=t.item,expected=target.updatedAt;
  const commit=async()=>{const cur=M.get(target.id);if(!cur)return res('not-found','That memory is already gone.');if(cur.updatedAt!==expected)return res('changed','That memory changed in the meantime, so I didn’t delete it. Please ask again.');memory.removeSmart(target.id);const mi=MI();if(mi&&mi.scrubContext)mi.scrubContext(target.content);return res('forgotten','Done — I’ve forgotten: '+target.content+'.',{item:cleanBrief(target)})};
  if(o.source==='voice'||o.confirmed)return commit();   // the user said "forget …" themselves and exactly one memory matched; a model-initiated call always needs a spoken yes
  return res('needs-confirmation','Forget '+quote(target.content)+'?',{commit,item:cleanBrief(target)})}};
// ---- natural-language memory commands (parse → host authorizes → execute) ----
const up=s=>s.charAt(0).toUpperCase()+s.slice(1),guess=c=>/\b(goal|aim|objective|plan to|want to (learn|build|become|achieve))\b/i.test(c)?'goals':/\b(prefer|like|love|favou?rite|dislike|hate|enjoy|theme)\b/i.test(c)?'preferences':'importantFacts';
const RX=[['recall',/^(?:please\s+)?what(?: do| did)? you (?:remember|know)(?: about me)?$/i,1],['goals',/^what(?:'s| is| are)? (?:my )?(?:current )?goals?$/i,1],['task-get',/^what(?:'s| is)? my (?:current )?task$/i,0],
 ['task-set',/^(?:set )?(?:my )?(?:current )?task (?:is|to) (.+)$/i,0],['clear-working',/^clear (?:my )?working memory$/i,0],['search-notes',/^search (?:my )?(?:notes|knowledge|documents) for (.+)$/i,1],
 ['approve',/^(?:yes[, ]*)?(?:please )?(?:remember|save|keep|store) (?:it|that|this)$/i,0],['reject',/^(?:(?:no|nope)[, ]*)?(?:please )?(?:don['’]?t|do not) (?:remember|save|keep|store)(?: it| that| this)?$/i,0],['forget',/^(?:please\s+)?forget(?: that)? (.+)$/i,1],['remember',/^(?:please\s+)?remember(?: that)? (.+)$/i,1]];
const commands={parse(text){const t=String(text||'').trim().replace(/^(?:hey |ok |okay )?alisa[, ]+/i,'').replace(/[.!?]+$/,'');for(const[intent,re,priv]of RX){const m=t.match(re);if(m)return{intent,arg:m[1]?m[1].trim():null,private:!!priv}}return null},
 async execute(c){await ready;const say=a=>a.join('; ');
  switch(c.intent){
   case'remember':return(await tools.remember({content:c.arg},{source:'voice'})).text;
   case'recall':{const a=memory.getAll().filter(m=>!secretish(m.content));return a.length?'I have '+a.length+' saved '+(a.length==1?'memory':'memories')+'. '+say(a.slice(0,5).map(m=>m.content))+(a.length>5?'; and more in Settings.':'.'):'I don’t have any saved memories yet.'}
   case'approve':{const p=memory.pending().slice(-1)[0];if(!p)return'There’s nothing waiting for your approval.';const it=memory.approve(p.id);return it?'Okay, I’ll remember that: '+it.content+'.':'I couldn’t save that.'}
   case'reject':{const p=memory.pending().slice(-1)[0];if(!p)return'There’s nothing waiting for your approval.';memory.reject(p.id);return'Okay, I won’t remember that.'}
   case'goals':{const a=memory.getByCategory('goals').filter(m=>!secretish(m.content));return a.length?'Your goals: '+say(a.map(m=>m.content))+'.':'You haven’t told me any goals yet.'}
   case'forget':return(await tools.forget({query:c.arg},{source:'voice'})).text;
   case'task-get':return working.get('task')?'Your current task is: '+working.get('task')+' ('+(working.get('taskStatus')||'active')+').':'You haven’t set a current task.';
   case'task-set':try{working.setTask(up(c.arg));return'Current task set: '+up(c.arg)+'.'}catch(e){return'I couldn’t set that: '+e.message}
   case'clear-working':working.clear();return'Working memory cleared.';
   case'search-notes':{const r=await knowledge.searchAsync(c.arg,3);return r.length?'I found '+r.length+(r.length==1?' item: ':' items: ')+say(r.map(x=>x.title))+'.':'I didn’t find anything about that in your knowledge.'}}
  return'I didn’t understand that memory command.'}};
// ---- Settings UI (mounts into an existing container; uses the app's CSS variables) ----
const semLine=()=>{const S=window.ALISASemantic;if(!S||!S.getStatus)return'○ Using fallback retrieval';const s=S.getStatus();
 if(s.enabled&&(s.embeddingState=='idle'||s.embeddingState=='loading'))return'○ Initializing…';
 if(s.semanticAvailable)return s.pendingItems>0?'○ Initializing… '+s.indexedItemCount+'/'+s.totalItems+' indexed':'● Ready · '+s.indexedItemCount+' indexed';
 return'○ Using fallback retrieval'+(s.initializationError?' ('+esc(String(s.initializationError).slice(0,48))+')':'')};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function mount(el){if(!el||typeof document=='undefined')return;
 if(!document.getElementById('mind-css')){const st=document.createElement('style');st.id='mind-css';st.textContent=`#mind{border:1px solid hsl(var(--c3)/.22);border-radius:18px;padding:14px;margin-top:12px;background:linear-gradient(150deg,hsl(263 70% 40%/.14),hsl(var(--c1)/.12));backdrop-filter:blur(14px);box-shadow:inset 0 0 24px hsl(var(--c3)/.06)}#mind h3{margin:0 0 6px!important;letter-spacing:.3em;font-size:13px!important}#mind .r{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid hsl(var(--c3)/.12);font:400 13px var(--ui)}#mind .r b{font-weight:600;color:#9ef;text-align:right;letter-spacing:.04em;max-width:60%;overflow-wrap:anywhere}#mind summary{font:500 11px var(--ui);color:var(--dim);cursor:pointer;padding:6px 0;letter-spacing:.06em}#mind .it{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;font:400 12px var(--ui);padding:5px 0;border-top:1px solid hsl(var(--c3)/.08)}#mind .it small{display:block;color:var(--dim);font-size:10px}#mind .it button{flex:none}#mind input{width:100%;box-sizing:border-box;margin:3px 0;padding:8px 10px;border-radius:10px;border:1px solid hsl(var(--c3)/.3);background:#0003;color:var(--txt);font:12px var(--ui)}#mind .sg{border:1px solid hsl(var(--c3)/.4);border-radius:12px;padding:10px;margin:8px 0;font:12px var(--ui);box-shadow:0 0 18px hsl(var(--c3)/.15)}#mind p{font:400 11px/1.5 var(--ui);color:var(--dim);margin:8px 0 0}#mind #mm{font:12px var(--ui);color:var(--dim);min-height:15px;margin-top:6px}`;document.head.appendChild(st)}
 el.innerHTML='<h3>🧠 ALISA MIND</h3><div id="mb"></div><div class="chips"><button data-a="st">Test semantic</button><button data-a="sw">Semantic on/off</button><button data-a="cw">Clear working</button><button data-a="cm">Clear memories</button><button data-a="ck">Clear knowledge</button><button data-a="ca">Clear all</button><button data-a="ex">Export</button><button data-a="im">Import</button></div><input type="file" accept="application/json,.json" hidden id="mi"><details><summary>Add a note to Knowledge</summary><input id="nt" placeholder="Title" maxlength="200"><input id="nc" placeholder="Note text"><div class="chips"><button data-a="an">Add note</button></div></details><div id="mm" aria-live="polite"></div><p>Stored in this browser (IndexedDB), unencrypted. It is copied to your ALISA server only if you press “Memory → server” in ALISA BRAIN settings. Tap 🔓/🔒 to mark a memory private — private memories are never sent to the cloud AI, even if sharing is on. Export files are plain JSON. Long-term memory is saved only when you ask ALISA to remember something or press Allow. Passwords, tokens and keys are refused (best-effort filter). Search is local keyword ranking (stemming, synonyms, tags, recency), not semantic.</p>';
 const $=s=>el.querySelector(s),msg=t=>$('#mm').textContent=t,item=(t,sm,a,id,x='')=>`<div class="it"><span>${esc(t)}<small>${esc(sm)}</small></span>${x}<button data-a="${a}" data-id="${esc(id)}">✕</button></div>`;
 function render(){const supSet=supersededIds(),mem=memory.getAll(),kn=knowledge.getAll(),pend=memory.pending(),w=working.getAll(),wk=Object.keys(w).length;
  $('#mb').innerHTML=pend.map(s=>`<div class="sg">ALISA wants to remember:<br><b>${esc(s.content)}</b><small style="display:block;color:var(--dim);font-size:10px">${esc(s.label||'Needs approval')}</small><div class="chips"><button class="on" data-a="al" data-id="${esc(s.id)}">Allow</button><button data-a="rj" data-id="${esc(s.id)}">Reject</button></div></div>`).join('')+
  `<div class="r"><span>Semantic Memory</span><b>${semLine()}</b></div><div class="r"><span>Working Memory</span><b>${wk} item${wk==1?'':'s'}</b></div><div class="r"><span>Current task</span><b>${w.task?esc(w.task):'none'}</b></div><div class="r"><span>Long-Term Memory</span><b>${mem.length} memor${mem.length==1?'y':'ies'}</b></div><div class="r"><span>Knowledge</span><b>${kn.length} item${kn.length==1?'':'s'}</b></div><div class="r"><span>Storage</span><b>${esc(status.storage)}</b></div>`+
  `<details><summary>View / delete memories</summary>${mem.map(m=>item(m.content,(m.private?'🔒 private · ':'')+m.category+(m.confidence!=null?' · '+Math.round(m.confidence*100)+'%':'')+' · '+m.source+' · '+m.updatedAt.slice(0,10)+(supSet.has(m.id)?' · replaced':'')+(m.expiresAt?' · expires '+m.expiresAt.slice(0,10):'')+(m.tags&&m.tags.length?' · #'+m.tags.join(' #'):''),'dm',m.id,`<button data-a="pm" data-id="${esc(m.id)}" title="Toggle private">${m.private?'🔒':'🔓'}</button>`)).join('')||'<small>None saved.</small>'}</details><details><summary>View / delete knowledge</summary>${kn.map(k=>item(k.title,k.type+' · '+k.content.length+' chars','dk',k.id)).join('')||'<small>None saved.</small>'}</details>`}
 el.addEventListener('click',e=>{const b=e.target.closest('button[data-a]');if(!b)return;const a=b.dataset.a,id=b.dataset.id;try{
  const SEM=window.ALISASemantic;if(a=='st'){msg('Testing semantic memory…');(SEM&&SEM.selfTest?SEM.selfTest():Promise.resolve({summary:'Semantic module not loaded.'})).then(r=>{msg(r.summary);console.info('[ALISA semantic self-test]',r)}).catch(e=>msg('Self-test failed: '+e.message));return}
  if(a=='sw'){if(SEM&&SEM.setEnabled){const on=!SEM.getStatus().enabled;SEM.setEnabled(on);msg(on?'Semantic memory on (loads in the background).':'Semantic memory off — keyword retrieval only.')}return}
  if(a=='dm')memory.removeSmart(id);else if(a=='pm'){const m=memory.get(id);if(m)memory.update(id,null,{private:!m.private})}else if(a=='dk')knowledge.remove(id);else if(a=='al'){memory.approve(id);msg('Memory saved.')}else if(a=='rj'){memory.reject(id);msg('Rejected — nothing saved.')}
  else if(a=='cw'){working.clear();msg('Working memory cleared.')}else if(a=='cm'){if(confirm('Delete ALL long-term memories?')){memory.clear();msg('Memories deleted.')}}else if(a=='ck'){if(confirm('Delete ALL knowledge items?')){knowledge.clear();msg('Knowledge deleted.')}}
  else if(a=='ca'){if(confirm('Delete working memory, memories and knowledge?')){clearAll();msg('Everything cleared.')}}
  else if(a=='ex'){const u=URL.createObjectURL(new Blob([JSON.stringify(exportData(),null,2)],{type:'application/json'})),l=document.createElement('a');l.href=u;l.download='alisa-mind-export.json';l.click();setTimeout(()=>URL.revokeObjectURL(u),2000);msg('Exported (plain, unencrypted JSON).')}
  else if(a=='im')$('#mi').click();else if(a=='an'){knowledge.add('note',$('#nt').value,$('#nc').value);$('#nt').value=$('#nc').value='';msg('Note added.')}}catch(err){msg(err.message)}});
 $('#mi').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;const r=importData(await f.text());msg('Imported '+r.memories+' memories, '+r.knowledge+' knowledge items'+(r.skipped?' ('+r.skipped+' skipped)':'')+'.')}catch(err){msg('Import failed: '+err.message)}e.target.value=''};
 window.addEventListener('alisamind:change',render);window.addEventListener('alisasemantic:status',render);window.addEventListener('alisamind:suggest',()=>msg('ALISA is asking permission to remember something.'));render()}
const ALISAMind={version:3,CATEGORIES:CATS,TYPES,working,memory,knowledge,tools,search,getContext,getContextAsync,isSecret:t=>secretish(t),export:exportData,import:importData,clearAll,commands,status,lastError:null,
 ready:()=>ready,setStorage(a){storage=a;status.storage=a.name||'custom';M.clear();K.clear();
  const reload=async()=>{for(const[n,m]of[['memories',M],['knowledge',K]]){const list=await(a.cached?a.cached(n):a.all(n));m.clear();list.forEach(x=>m.set(x.id,x))}emit('change',{})};   // after a background sync: re-read the phone's cache
  ready=(async()=>{await a.open();(await a.all('memories')).forEach(x=>M.set(x.id,x));(await a.all('knowledge')).forEach(x=>K.set(x.id,x));if(a.attach)a.attach(reload);emit('change',{})})();return ready},
 IDBStorage,MemoryStorage,ui:{mount}};
window.ALISAMind=ALISAMind;
})();
