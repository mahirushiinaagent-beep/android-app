/* ALISA EMBEDDINGS — on-device sentence embeddings (nothing is sent anywhere).
   Runtime : onnxruntime-web, the SAME vendor/ort.min.js that security.js already uses (not duplicated).
   Model   : a BERT-style sentence-embedding ONNX + its vocab.txt in models/embed/ (default: all-MiniLM-L6-v2, 384-dim, English).
             The files are NOT bundled: run `node setup-embedding-model.js` once. Until they exist the state is 'unavailable' and ALISA
             keeps using keyword retrieval — this module never pretends otherwise.
   State   : idle → loading → ready | unavailable. initialize() never throws; embed()/embedBatch() throw only if the provider is not ready,
             so callers (alisa-semantic.js) catch and fall back. Model bytes are kept in Cache Storage so it works offline after the first download.
   Works in the browser (window.ALISAEmbeddings) and in Node (require) so tests can exercise the tokenizer and the pooling maths. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.ALISAEmbeddings = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const CFG = { modelId: 'all-MiniLM-L6-v2-q8', modelUrl: 'models/embed/model.onnx', vocabUrl: 'models/embed/vocab.txt', ortUrl: 'vendor/ort.min.js',
    maxTokens: 128, batchSize: 16, retryAfterMs: 5 * 60 * 1000, cacheName: 'alisa-embed-model-v1' };

  /* ---------------- BERT (uncased) WordPiece tokenizer ---------------- */
  class WordPiece {
    constructor(vocabText, o = {}) {
      this.vocab = new Map(); String(vocabText).split(/\r?\n/).forEach((t, i) => { if (t) this.vocab.set(t, i); });
      for (const t of ['[CLS]', '[SEP]', '[UNK]', '[PAD]']) if (!this.vocab.has(t)) throw new Error('vocab.txt is missing ' + t + ' — not a BERT vocabulary');
      this.cls = this.vocab.get('[CLS]'); this.sep = this.vocab.get('[SEP]'); this.unk = this.vocab.get('[UNK]'); this.pad = this.vocab.get('[PAD]');
      this.maxWordLen = o.maxWordLen || 100;
    }
    basic(text) {                                              // lowercase, strip accents, split on whitespace and punctuation
      text = String(text == null ? '' : text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\u0000\ufffd]/g, '');
      const out = []; let cur = '';
      for (const ch of text) {
        if (/\s/.test(ch)) { if (cur) out.push(cur); cur = ''; }
        else if (/[!-\/:-@\[-`{-~\u2010-\u2027\u3000-\u303f]/.test(ch) || /\p{P}|\p{S}/u.test(ch)) { if (cur) out.push(cur); cur = ''; out.push(ch); }
        else cur += ch;
      }
      if (cur) out.push(cur); return out;
    }
    word(w) {                                                  // greedy longest-match-first
      if (w.length > this.maxWordLen) return [this.unk];
      const ids = []; let s = 0; const cs = [...w];
      while (s < cs.length) {
        let e = cs.length, hit = null;
        while (s < e) { let sub = cs.slice(s, e).join(''); if (s > 0) sub = '##' + sub; if (this.vocab.has(sub)) { hit = this.vocab.get(sub); break; } e--; }
        if (hit === null) return [this.unk];
        ids.push(hit); s = e;
      }
      return ids;
    }
    encode(text, maxLen = 128) {                               // → input ids with [CLS] … [SEP], truncated to maxLen
      const ids = [this.cls]; for (const w of this.basic(text)) for (const id of this.word(w)) { if (ids.length >= maxLen - 1) break; ids.push(id); }
      ids.push(this.sep); return ids;
    }
  }

  /* ---------------- pooling maths (exported for tests) ---------------- */
  function l2(v) { let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o; }
  // hidden: Float32Array [B,T,D], mask: number[][] (B×T of 0/1) → B normalized mean-pooled vectors
  function meanPool(hidden, B, T, D, mask) {
    const out = [];
    for (let b = 0; b < B; b++) {
      const v = new Float32Array(D); let n = 0;
      for (let t = 0; t < T; t++) { if (!mask[b][t]) continue; n++; const off = (b * T + t) * D; for (let d = 0; d < D; d++) v[d] += hidden[off + d]; }
      if (n) for (let d = 0; d < D; d++) v[d] /= n; out.push(l2(v));
    }
    return out;
  }
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

  /* ---------------- local ONNX provider ---------------- */
  const loadScript = u => new Promise((ok, no) => { if (typeof document === 'undefined') return no(new Error('no document')); const s = document.createElement('script'); s.src = u; const to = setTimeout(() => no(new Error('timed out loading ' + u)), 20000); s.onload = () => { clearTimeout(to); ok(); }; s.onerror = () => { clearTimeout(to); no(new Error('could not load ' + u)); }; document.head.appendChild(s); });

  class LocalEmbeddingProvider {
    constructor(cfg) { this.cfg = cfg; this.name = 'local-onnx:' + cfg.modelId; this.dim = 0; this.sess = null; this.tok = null; }
    async fetchCached(url, kind) {                             // Cache Storage first (works offline), network otherwise
      const c = root.caches ? await root.caches.open(this.cfg.cacheName).catch(() => null) : null, hit = c && await c.match(url).catch(() => null);
      if (hit) return kind === 'text' ? hit.text() : hit.arrayBuffer();
      const r = await root.fetch(url); if (!r.ok) throw new Error(url + ' not found (HTTP ' + r.status + ')');
      if (c) { try { await c.put(url, r.clone()); } catch (e) { /* quota: keep going without cache */ } }
      return kind === 'text' ? r.text() : r.arrayBuffer();
    }
    async load() {
      const ort = root.ort || (await loadScript(this.cfg.ortUrl), root.ort); if (!ort) throw new Error('onnxruntime-web (window.ort) not available');
      try { if (!ort.env.wasm.wasmPaths) ort.env.wasm.wasmPaths = new URL('vendor/', root.location.href).href; ort.env.wasm.numThreads = 1; } catch (e) {}
      this.tok = new WordPiece(await this.fetchCached(this.cfg.vocabUrl, 'text'));
      this.sess = await ort.InferenceSession.create(await this.fetchCached(this.cfg.modelUrl, 'buf'), { executionProviders: ['wasm'] }); this.ort = ort;
      const probe = await this.run(['test']); this.dim = probe[0].length;      // proves the model really runs before we report "ready"
    }
    async run(texts) {
      const enc = texts.map(t => this.tok.encode(t, this.cfg.maxTokens)), B = enc.length, T = Math.max(...enc.map(e => e.length));
      const ids = new BigInt64Array(B * T).fill(BigInt(this.tok.pad)), att = new BigInt64Array(B * T), tt = new BigInt64Array(B * T), mask = [];
      enc.forEach((e, b) => { mask.push([]); for (let t = 0; t < T; t++) { const on = t < e.length; mask[b].push(on ? 1 : 0); if (on) { ids[b * T + t] = BigInt(e[t]); att[b * T + t] = 1n; } } });
      const T_ = (a) => new this.ort.Tensor('int64', a, [B, T]), feeds = {}, names = this.sess.inputNames || ['input_ids', 'attention_mask', 'token_type_ids'];
      for (const n of names) feeds[n] = n === 'input_ids' ? T_(ids) : n === 'attention_mask' ? T_(att) : n === 'token_type_ids' ? T_(tt) : (() => { throw new Error('unsupported model input: ' + n); })();
      const out = await this.sess.run(feeds), o = out.last_hidden_state || out[(this.sess.outputNames || [])[0]] || Object.values(out)[0], d = o.dims;
      if (d.length === 2) return Array.from({ length: d[0] }, (_, b) => l2(o.data.slice(b * d[1], (b + 1) * d[1])));   // model already pools
      return meanPool(o.data, d[0], d[1], d[2], mask);
    }
    async embed(texts) { const out = []; for (let i = 0; i < texts.length; i += this.cfg.batchSize) out.push(...await this.run(texts.slice(i, i + this.cfg.batchSize))); return out; }
  }

  /* ---------------- public lifecycle ---------------- */
  const E = { state: 'idle', reason: '', modelId: CFG.modelId, provider: null, failedAt: 0, loadedAt: 0, cache: new Map(), config: CFG, _p: null, _listeners: new Set() };
  const fire = () => { for (const f of E._listeners) { try { f(E.status()); } catch (e) {} } try { root.dispatchEvent && root.dispatchEvent(new root.CustomEvent('alisaembeddings:status', { detail: E.status() })); } catch (e) {} };
  const set = (state, reason = '') => { E.state = state; E.reason = String(reason || '').slice(0, 200); fire(); };   // reason never contains user content

  E.status = () => ({ state: E.state, ready: E.state === 'ready', model: E.modelId, provider: E.provider ? E.provider.name : null, dim: E.provider ? E.provider.dim : 0, reason: E.reason, local: true });
  E.onStatus = f => { E._listeners.add(f); return () => E._listeners.delete(f); };
  E.isReady = () => E.state === 'ready' && !!E.provider;
  E.initialize = function (o = {}) {                            // idempotent; resolves to the status, NEVER rejects
    if (E.isReady()) return Promise.resolve(E.status());
    if (E._p) return E._p;
    if (E.state === 'unavailable' && !o.force && Date.now() - E.failedAt < CFG.retryAfterMs) return Promise.resolve(E.status());
    set('loading');
    E._p = (async () => {
      try {
        if (typeof root.fetch !== 'function' && !root.ort) throw new Error('no fetch available');
        const p = new LocalEmbeddingProvider(CFG); await p.load(); E.provider = p; E.loadedAt = Date.now(); E.cache.clear(); set('ready');
      } catch (e) {
        E.provider = null; E.failedAt = Date.now();
        const offline = root.navigator && root.navigator.onLine === false;
        set('unavailable', (offline ? 'offline and model not cached — ' : '') + (e && e.message || e));
        try { console.warn('[ALISA EMBEDDINGS] unavailable:', E.reason); } catch (_) {}
      } finally { E._p = null; }
      return E.status();
    })();
    return E._p;
  };
  /* Tests / alternative backends: install any object { name, dim, embed(texts[]) → Promise<Float32Array[] (L2-normalized)> }. */
  E.useProvider = function (p) { E.provider = p; E.modelId = p.modelId || p.name; E.cache.clear(); set(p ? 'ready' : 'idle'); };
  E.reset = function () { E.provider = null; E.modelId = CFG.modelId; E.failedAt = 0; E.cache.clear(); set('idle'); };
  E.embedBatch = async function (texts) {
    if (!E.isReady()) throw new Error('embedding model not ready');
    const clean = texts.map(t => String(t == null ? '' : t)), out = await E.provider.embed(clean);
    if (!Array.isArray(out) || out.length !== clean.length) throw new Error('embedding provider returned a wrong number of vectors');
    return out;
  };
  E.embed = async function (text) {                             // small LRU so repeated queries cost nothing
    const k = String(text); if (E.cache.has(k)) { const v = E.cache.get(k); E.cache.delete(k); E.cache.set(k, v); return v; }
    const v = (await E.embedBatch([k]))[0]; E.cache.set(k, v); if (E.cache.size > 64) E.cache.delete(E.cache.keys().next().value); return v;
  };
  E.WordPiece = WordPiece; E.meanPool = meanPool; E.l2 = l2; E.dot = dot; E.LocalEmbeddingProvider = LocalEmbeddingProvider;
  return E;
});
