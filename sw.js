// ALISA service worker: network-first (always fresh code when online), cache fallback so the app opens offline.
// Bump CACHE when you publish a new version. Every file in SHELL must exist on the server (and in server.js's FILES allow-list).
// activate keeps 'alisa-speaker-model' (owned by security.js, hash-verified on every load) so a SW update does not force a 26 MB re-download.
// Never cached: /api/* (memories, knowledge, AI, login), non-GET requests, /models/ (security.js caches the speaker model itself), non-OK responses.
const CACHE='alisa-v14',SHELL=['./','./index.html','./security.js','./alisa-retrieval.js','./alisa-embeddings.js','./alisa-vectors.js','./alisa-memory-intelligence.js','./alisa-mind.js','./alisa-semantic.js','./alisa-brain.js','./commands.js','./alisa-agent-log.js','./alisa-risk-gate.js','./alisa-tool-registry.js','./alisa-agent-tools.js','./alisa-intent.js','./alisa-planner.js','./alisa-personality.js','./alisa-resources.js','./alisa-status.js','./alisa-agent-core.js','./alisa-agent-ui.js','./alisa-remote-storage.js','./manifest.json','./alisa.png','./alisa-192.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>Promise.all(SHELL.map(u=>c.add(new Request(u,{cache:'reload'})).catch(()=>{})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE&&x!=='alisa-speaker-model').map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
// WebLLM library (CDN) is cached so the offline brain can start without internet. Model weights are cached by WebLLM itself.
const CDN=['esm.run','cdn.jsdelivr.net'];
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);
 if(e.request.method==='GET'&&CDN.includes(u.hostname)){e.respondWith(caches.open(CACHE).then(c=>c.match(e.request).then(hit=>hit||fetch(e.request).then(r=>{if(r.ok)c.put(e.request,r.clone());return r}))));return}
 if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/')||u.pathname.startsWith('/models/'))return;   // API + private data are never cached here
 e.respondWith(fetch(e.request).then(r=>{if(r.ok&&r.type==='basic'){const k=r.clone();caches.open(CACHE).then(c=>c.put(e.request,k))}return r}).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(hit=>hit||(e.request.mode==='navigate'?caches.match('./index.html'):undefined))))});

self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>l.length?l[0].focus():self.clients.openWindow('./')))});
