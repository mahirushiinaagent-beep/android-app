/* ALISA SEMANTIC — hybrid retrieval (embeddings + keyword + recency + importance + context) with an automatic keyword fallback.

   Honesty rules baked into the design:
   • "hybrid" mode is used ONLY when the embedding model is really loaded AND the query could be embedded. Otherwise mode is "keyword" and the
     results are exactly what Phase 1 retrieval would give. Results carry .mode so callers (and the status API) can tell which one ran.
   • Retrieval is probabilistic. Items must clear a similarity (or keyword) gate to be returned at all; recency/importance/context can re-order
     results but can never pull an unrelated memory in. Weak matches are dropped, so "no relevant memory" is a normal outcome.
   • Index failures never affect saving/reading memories. Indexing runs in the background, in small batches, retries with backoff, and re-embeds
     only content whose hash (text + model id) changed.
   Final score = Σ wᵢ·componentᵢ / Σ wᵢ with components semantic (rescaled cosine), keyword, recency, importance, context — all in [0,1]; weights are configurable. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.ALISASemantic = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const DEFAULTS = {
    weights: { semantic: 0.55, keyword: 0.25, recency: 0.08, importance: 0.07, context: 0.05 },   // SEMANTIC/KEYWORD/RECENCY/IMPORTANCE/CONTEXT_WEIGHT
    MAX_MEMORY_RESULTS: 5, MAX_KNOWLEDGE_RESULTS: 3, MAX_CONTEXT_LENGTH: 1500, CONTEXT_TIMEOUT_MS: 1500,
    // Gates. UNCALIBRATED starting points for MiniLM-class models — run ALISASemantic.selfTest() on a device with the model installed and tune.
    SEMANTIC_MIN: 0.30, SEMANTIC_FLOOR: 0.15, SEMANTIC_CEIL: 0.60, KEYWORD_MIN: 0.45, MIN_RELEVANCE: 0.15,
    BATCH_SIZE: 16, DEBOUNCE_MS: 400, RETRY_BASE_MS: 30000, RETRY_MAX_MS: 600000, CHUNK_CHARS: 700, MAX_CHUNKS: 6, RECENCY_HALF_DAYS: 90,
  };
  const CAT_IMPORTANCE = { goals: 1, importantFacts: 0.9, preferences: 0.8, approvedMemories: 0.7 };
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const yieldUI = () => new Promise(r => setTimeout(r, 0));   // lets the UI breathe between index batches

  function fnv(str, seed) { let h = seed >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); }
  const hashOf = (model, text) => fnv(model + '\u0001' + text, 2166136261) + fnv(text + '\u0001' + model, 0x9747b28c);   // 64-bit-ish; detects content OR model change

  function create(deps) {
    const R = deps.R, emb = deps.emb, V = deps.vectors, cfg = JSON.parse(JSON.stringify(DEFAULTS)), now = deps.now || Date.now;
    const S = { store: null, vecs: new Map(), byItem: new Map(), running: false, dirty: false, runP: null, failures: 0, lastError: null, indexError: null, lastIndexUpdate: 0,
      stats: { items: 0, indexed: 0, pending: 0 }, timer: null, retry: null, disabled: false, started: false, queryFailures: 0 };

    /* ----- what gets embedded ----- */
    const chunks = (type, it) => {
      if (type === 'memory') return [String(it.content || '') + (it.tags && it.tags.length ? '. ' + it.tags.join(', ') : '')];
      const body = String(it.content || '').slice(0, cfg.CHUNK_CHARS * cfg.MAX_CHUNKS), out = [];
      for (let i = 0; i < body.length && out.length < cfg.MAX_CHUNKS;) {
        let e = Math.min(body.length, i + cfg.CHUNK_CHARS); if (e < body.length) { const sp = body.lastIndexOf(' ', e); if (sp > i + cfg.CHUNK_CHARS / 2) e = sp; }
        out.push(String(it.title || '') + '. ' + body.slice(i, e).trim()); i = e;
      }
      return out.length ? out : [String(it.title || '')];
    };
    const rebuildByItem = () => { S.byItem.clear(); for (const e of S.vecs.values()) { const k = e.type + ':' + e.id; (S.byItem.get(k) || S.byItem.set(k, []).get(k)).push(e); } };
    function desired() {                                       // key → {type,id,chunk,text,hash}; secrets are never indexed
      const model = emb.modelId, want = new Map(), { memories = [], knowledge = [] } = deps.getItems() || {};
      for (const [type, list] of [['memory', memories], ['knowledge', knowledge]]) for (const it of list) {
        if (!it || !it.id || it.deleted) continue;
        if (deps.isSecret && deps.isSecret(type === 'memory' ? it.content : (it.title + ' ' + String(it.content).slice(0, cfg.CHUNK_CHARS * cfg.MAX_CHUNKS)))) continue;
        chunks(type, it).forEach((text, i) => { const key = V.keyOf(type, it.id, i); want.set(key, { key, type, id: it.id, chunk: i, text, hash: hashOf(model, text) }); });
      }
      return want;
    }
    function progress(want) {
      const items = new Map();
      for (const w of want.values()) { const k = w.type + ':' + w.id, e = S.vecs.get(w.key), ok = !!e && e.hash === w.hash; const r = items.get(k) || { all: true }; r.all = r.all && ok; items.set(k, r); }
      let indexed = 0; for (const r of items.values()) if (r.all) indexed++;
      S.stats = { items: items.size, indexed, pending: items.size - indexed };
    }

    /* ----- store + background reconcile ----- */
    async function ensureStore() {
      if (S.store) return;
      S.store = await V.openStore(deps.indexedDB === undefined ? root.indexedDB : deps.indexedDB);
      try { for (const e of await S.store.all()) if (e && e.key && e.vec) S.vecs.set(e.key, { ...e, vec: e.vec instanceof Float32Array ? e.vec : new Float32Array(e.vec) }); }
      catch (e) { S.indexError = 'could not read saved index: ' + (e && e.message); S.store = new V.MemoryVectorStore(); }
      rebuildByItem();
    }
    async function persist(entries) {
      try { await S.store.putMany(entries); S.indexError = S.store.persistent ? null : S.indexError; }
      catch (e) { S.indexError = 'index not persisted: ' + (e && e.message); S.store = new V.MemoryVectorStore(); await S.store.putMany([...S.vecs.values(), ...entries]); }   // keep working in memory
    }
    function fail(e) {
      S.failures++; S.lastError = String(e && e.message || e).slice(0, 200);
      const wait = Math.min(cfg.RETRY_MAX_MS, cfg.RETRY_BASE_MS * Math.pow(2, S.failures - 1)); clearTimeout(S.retry);
      S.retry = setTimeout(() => api.reconcile(), wait); S.retry && S.retry.unref && S.retry.unref(); announce();
    }
    async function pass() {
      if (S.disabled || !emb.isReady()) { try { await ensureStore(); progress(desired()); } catch (e) {} return; }
      await ensureStore();
      const want = desired(), stale = [];
      for (const k of S.vecs.keys()) if (!want.has(k)) stale.push(k);                    // deleted / now-secret / fewer chunks
      if (stale.length) { try { await S.store.deleteKeys(stale); } catch (e) { S.indexError = 'could not prune index: ' + (e && e.message); } stale.forEach(k => S.vecs.delete(k)); rebuildByItem(); S.lastIndexUpdate = now(); }
      const todo = [...want.values()].filter(w => { const e = S.vecs.get(w.key); return !e || e.hash !== w.hash; });   // hash includes the model id
      progress(want); announce();
      for (let i = 0; i < todo.length; i += cfg.BATCH_SIZE) {
        const batch = todo.slice(i, i + cfg.BATCH_SIZE); let vs;
        try { vs = await emb.embedBatch(batch.map(b => b.text)); } catch (e) { fail(e); return; }
        const entries = batch.map((b, j) => ({ key: b.key, type: b.type, id: b.id, chunk: b.chunk, hash: b.hash, model: emb.modelId, dim: vs[j].length, vec: vs[j] instanceof Float32Array ? vs[j] : new Float32Array(vs[j]), at: new Date(now()).toISOString() }));
        await persist(entries); entries.forEach(e => S.vecs.set(e.key, e)); rebuildByItem(); S.lastIndexUpdate = now(); progress(want); announce(); await yieldUI();
      }
      S.failures = 0; S.lastError = null; progress(want); announce();
    }

    /* ----- ranking ----- */
    const ageDays = it => { const t = Date.parse(it.lastUsedAt && it.lastUsedAt > (it.updatedAt || '') ? it.lastUsedAt : (it.updatedAt || it.createdAt || '')); return Number.isFinite(t) ? Math.max(0, (now() - t) / 864e5) : 365; };
    function candidates(types, opts) {
      const { memories = [], knowledge = [] } = deps.getItems() || {}, c = [];
      if (types.includes('memory')) for (const m of memories) {
        if (!m || m.deleted || (deps.isSecret && deps.isSecret(m.content))) continue;      // never return secret-looking text
        if (opts.cloud && m.private === true) continue;
        c.push({ type: 'memory', it: m, category: m.category, text: m.content, fields: [[m.content, 2], [(m.tags || []).join(' '), 3], [m.category, 0.5]], imp: (CAT_IMPORTANCE[m.category] || 0.7) * (typeof m.confidence === 'number' ? clamp(m.confidence) : 1) });
      }
      if (types.includes('knowledge')) for (const k of knowledge) {
        if (!k || k.deleted || (deps.isSecret && deps.isSecret(k.title + ' ' + String(k.content).slice(0, 4000)))) continue;
        c.push({ type: 'knowledge', it: k, category: k.type, text: k.title, fields: [[k.title, 3], [String(k.content).slice(0, 4000), 1.2]], imp: 0.6 });
      }
      return c;
    }
    function ctxScore(task, c) { if (!task) return 0; const t = R.terms(task); if (!t.length) return 0; return clamp(R.textScore(t, '', c.fields) / (2 * t.length)); }

    async function semanticSearch(query, opts = {}) {
      const q = String(query == null ? '' : query).trim(), out = []; out.mode = 'keyword'; out.semantic = false;
      if (!q) return out;
      const types = opts.types || ['memory', 'knowledge'], limit = opts.limit || 10, w = Object.assign({}, cfg.weights, opts.weights), cands = candidates(types, opts);
      const qTerms = R.terms(q), nT = Math.max(1, qTerms.length), phrase = R.normalize(q), phr = phrase.includes(' ') ? phrase : '';
      let qv = null;
      if (!S.disabled && opts.semantic !== false && emb.isReady() && S.vecs.size) { try { qv = await emb.embed(q); S.queryFailures = 0; } catch (e) { S.queryFailures++; S.lastError = 'query embedding failed: ' + String(e && e.message).slice(0, 120); qv = null; } }
      const hybrid = !!qv; out.mode = hybrid ? 'hybrid' : 'keyword'; out.semantic = hybrid;
      const model = emb.modelId, scored = [];
      for (const c of cands) {
        const kw = clamp(R.textScore(qTerms, phr, c.fields) / (2 * nT));
        let sim = null, best = null;
        if (hybrid) {
          const ents = S.byItem.get(c.type + ':' + c.it.id) || [], tx = chunks(c.type, c.it);
          for (const e of ents) { if (e.vec.length !== qv.length || !tx[e.chunk] || e.hash !== hashOf(model, tx[e.chunk])) continue; const s = emb.dot(qv, e.vec); if (sim === null || s > sim) { sim = s; best = tx[e.chunk]; } }   // stale/missing vectors are ignored, not trusted
        }
        const pass = hybrid ? ((sim !== null && sim >= cfg.SEMANTIC_MIN) || kw >= cfg.KEYWORD_MIN) : kw > 0;
        if (!pass) continue;
        const rec = Math.exp(-ageDays(c.it) / cfg.RECENCY_HALF_DAYS), ctx = ctxScore(opts.task, c);
        const semN = sim === null ? 0 : clamp((sim - cfg.SEMANTIC_FLOOR) / (cfg.SEMANTIC_CEIL - cfg.SEMANTIC_FLOOR));
        const parts = [[w.keyword, kw], [w.recency, rec], [w.importance, c.imp], [w.context, ctx]]; if (hybrid) parts.unshift([w.semantic, semN]);
        const wsum = parts.reduce((a, p) => a + p[0], 0) || 1, relevance = parts.reduce((a, p) => a + p[0] * p[1], 0) / wsum;
        if (hybrid && relevance < cfg.MIN_RELEVANCE) continue;
        const it = c.it, text = c.type === 'memory' ? it.content : it.title + ': ' + (best ? best.slice(it.title.length + 2) : String(it.content).slice(0, 240)).slice(0, 300);
        scored.push({ id: it.id, type: c.type, text, category: c.category, similarity: sim === null ? null : Math.round(sim * 1000) / 1000, relevance: Math.round(relevance * 1000) / 1000, source: it.source || null, timestamp: it.updatedAt || it.createdAt || null,
          metadata: { title: c.type === 'knowledge' ? it.title : undefined, tags: it.tags || [], private: it.private === true, confidence: typeof it.confidence === 'number' ? it.confidence : null, keyword: Math.round(kw * 1000) / 1000, mode: out.mode } });
      }
      scored.sort((a, b) => b.relevance - a.relevance || String(b.timestamp).localeCompare(String(a.timestamp)) || String(a.id).localeCompare(String(b.id)));
      scored.slice(0, limit).forEach(r => out.push(r)); return out;
    }

    /* Compact, budgeted context selection for the Brain. */
    async function selectContext(query, o = {}) {
      const nm = o.maxMemories || cfg.MAX_MEMORY_RESULTS, nk = o.maxKnowledge || cfg.MAX_KNOWLEDGE_RESULTS, budget = o.maxLength || cfg.MAX_CONTEXT_LENGTH;
      const all = await semanticSearch(query, { types: ['memory', 'knowledge'], limit: 50, cloud: o.cloud, task: o.task });
      const mem = all.filter(r => r.type === 'memory').slice(0, nm), kn = all.filter(r => r.type === 'knowledge').slice(0, nk);
      let used = 0; const m2 = [], k2 = [];
      for (const r of mem) { if (used + r.text.length > budget && m2.length) break; used += r.text.length; m2.push(r); }
      for (const r of kn) { const room = budget - used; if (room < 80) break; const text = r.text.slice(0, Math.min(240, room)); used += text.length; k2.push({ ...r, text }); }
      return { memories: m2, knowledge: k2, mode: all.mode, semantic: all.semantic, length: used };
    }

    function getStatus() {
      const es = emb.status(), avail = !S.disabled && es.ready;
      return { enabled: !S.disabled, semanticAvailable: avail, embeddingModel: es.model, embeddingState: S.disabled ? 'disabled' : es.state, vectorIndexAvailable: !!S.store, vectorStore: S.store ? S.store.kind : null, vectorStorePersistent: !!(S.store && S.store.persistent),
        indexedItemCount: S.stats.indexed, totalItems: S.stats.items, pendingItems: S.stats.pending, failedAttempts: S.failures, lastIndexUpdate: S.lastIndexUpdate ? new Date(S.lastIndexUpdate).toISOString() : null,
        fallbackActive: !avail, mode: avail && S.vecs.size ? 'hybrid' : 'keyword', initializationError: S.disabled ? 'disabled by user' : (es.reason || null), indexError: S.indexError, lastError: S.lastError };   // counts and technical messages only — never memory text
    }
    function announce() { try { root.dispatchEvent && root.dispatchEvent(new root.CustomEvent('alisasemantic:status', { detail: getStatus() })); } catch (e) {} }

    const api = {
      cfg, DEFAULTS, getStatus, semanticSearch, selectContext, announce,
      configure(o = {}) { for (const k of Object.keys(o)) { if (k === 'weights') Object.assign(cfg.weights, o.weights); else if (k in cfg) cfg[k] = o[k]; } return JSON.parse(JSON.stringify(cfg)); },
      reconcile() { if (S.running) { S.dirty = true; return S.runP; } S.running = true; S.runP = (async () => { try { do { S.dirty = false; try { await pass(); } catch (e) { fail(e); } } while (S.dirty); } finally { S.running = false; } })(); return S.runP; },
      schedule() { if (S.disabled) return; clearTimeout(S.timer); S.timer = setTimeout(() => api.reconcile(), cfg.DEBOUNCE_MS); S.timer && S.timer.unref && S.timer.unref(); },
      async start(o = {}) { if (S.started || S.disabled) return; S.started = true; emb.onStatus(s => { if (s.ready) api.reconcile(); announce(); });
        const go = () => emb.initialize().then(() => api.reconcile()).catch(() => {}); if (o.immediate) return go(); const t = setTimeout(go, o.delayMs == null ? 1500 : o.delayMs); t && t.unref && t.unref(); },
      setEnabled(on) { S.disabled = !on; if (on) { S.started = false; api.start({ immediate: true }); } announce(); },
      _state: S, _chunks: chunks, _desired: desired,
    };
    return api;
  }

  /* ----- real-model check, runnable on a device (button in ALISA MIND settings or console). Uses a private in-memory index; touches no user data. ----- */
  async function selfTest(R, emb, V) {
    const st = await emb.initialize({ force: true });
    if (!st.ready) return { ok: false, available: false, summary: 'Semantic model not available (' + (st.reason || st.state) + '). Keyword retrieval is in use. Run: node setup-embedding-model.js', cases: [] };
    const mems = ['I prefer midnight AMOLED interfaces.', 'My goal is to build ALISA into a personal AI assistant.', 'I am learning JavaScript and web development.', 'My favourite food is paneer butter masala.', 'I have a dentist appointment next Tuesday.']
      .map((content, i) => ({ id: 'selftest' + i, category: 'importantFacts', content, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: 'selftest' }));
    const inst = create({ R, emb, vectors: { keyOf: V.keyOf, MemoryVectorStore: V.MemoryVectorStore, openStore: async () => new V.MemoryVectorStore() }, getItems: () => ({ memories: mems, knowledge: [] }) });
    await inst.reconcile();
    const probes = [['What kind of interface do I like?', 0], ['What am I working toward?', 1], ['What programming topics am I studying?', 2], ['What is the capital of France?', -1], ['How do I bake sourdough bread?', -1]], cases = [];
    for (const [q, want] of probes) {
      const r = await inst.semanticSearch(q, { types: ['memory'] }), top = r[0], got = top ? mems.findIndex(m => m.id === top.id) : -1;
      cases.push({ query: q, expected: want < 0 ? 'nothing' : mems[want].content, top: top ? top.text : null, similarity: top ? top.similarity : null, passed: got === want, returned: r.length });
    }
    const passed = cases.filter(c => c.passed).length;
    return { ok: passed === cases.length, available: true, model: st.model, summary: 'Semantic self-test: ' + passed + '/' + cases.length + ' passed (model ' + st.model + ').' + (passed < cases.length ? ' Thresholds may need tuning — see ALISASemantic.configure().' : ''), cases };
  }

  /* ----- browser glue: attach to ALISAMind ----- */
  const API = { create, DEFAULTS, hashOf, selfTest, instance: null };
  API.attach = function (M, o = {}) {
    const R = root.ALISARetrieval, emb = root.ALISAEmbeddings, V = root.ALISAVectors; if (!M || !R || !emb || !V) return null;
    const inst = create({ R, emb, vectors: V, getItems: () => ({ memories: M.memory.live(), knowledge: M.knowledge.getAll() }), isSecret: M.isSecret, indexedDB: o.indexedDB });
    let off = false; try { off = root.localStorage && root.localStorage.getItem('alisa-semantic') === '0'; } catch (e) {}
    if (off) inst._state.disabled = true;
    API.instance = inst;
    Object.assign(R, { semanticSearch: (q, op) => inst.semanticSearch(q, op), getStatus: () => inst.getStatus(), configure: c => inst.configure(c) });   // ALISARetrieval.getStatus() etc.
    Object.assign(API, { getStatus: inst.getStatus, semanticSearch: inst.semanticSearch, selectContext: inst.selectContext, reconcile: () => inst.reconcile(), configure: inst.configure, setEnabled: on => { try { root.localStorage.setItem('alisa-semantic', on ? '1' : '0'); } catch (e) {} inst.setEnabled(on); }, selfTest: () => selfTest(R, emb, V) });
    if (root.addEventListener) { root.addEventListener('alisamind:change', () => inst.schedule()); root.addEventListener('online', () => { if (emb.state === 'unavailable') emb.initialize({ force: true }); }); }
    Promise.resolve(M.ready()).then(() => inst.start(o)).catch(() => {});
    return inst;
  };
  if (root && root.ALISAMind && root.ALISARetrieval && root.ALISAEmbeddings && root.ALISAVectors && typeof document !== 'undefined') API.attach(root.ALISAMind);
  return API;
});
