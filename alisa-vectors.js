/* ALISA VECTORS — the semantic index, kept SEPARATE from memory/knowledge records.
   One entry per (type, item id, chunk):  { key, type, id, chunk, hash, model, dim, vec:Float32Array, at }
   It references the original item by id and stores only a vector + a content hash — never the text itself.
   Backends: IDBVectorStore (persistent, IndexedDB db "alisa-semantic") and MemoryVectorStore (used automatically if IndexedDB is unavailable or fails).
   Vectors are LOCAL ONLY: they are never synced to the server and never exported; they are regenerated per device/model. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.ALISAVectors = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const keyOf = (type, id, chunk) => type + ':' + id + ':' + (chunk | 0);

  class MemoryVectorStore {
    constructor() { this.kind = 'memory'; this.persistent = false; this.m = new Map(); }
    async open() {}
    async all() { return [...this.m.values()]; }
    async putMany(es) { for (const e of es) this.m.set(e.key, e); }
    async deleteKeys(ks) { for (const k of ks) this.m.delete(k); }
    async clear() { this.m.clear(); }
    async close() {}
  }

  class IDBVectorStore {
    constructor(idb, name = 'alisa-semantic') { this.kind = 'indexeddb'; this.persistent = true; this.idb = idb; this.name = name; this.d = null; }
    open() {
      return new Promise((ok, no) => {
        const r = this.idb.open(this.name, 1);
        r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('vectors')) d.createObjectStore('vectors', { keyPath: 'key' }); };
        r.onsuccess = () => { this.d = r.result; this.d.onversionchange = () => { try { this.d.close(); } catch (e) {} this.d = null; }; ok(); };
        r.onerror = () => no(r.error || new Error('IndexedDB open failed')); r.onblocked = () => no(new Error('IndexedDB blocked'));
      });
    }
    tx(mode, fn) {
      if (!this.d) return Promise.reject(new Error('IndexedDB not open'));
      return new Promise((ok, no) => { let t, q; try { t = this.d.transaction('vectors', mode); q = fn(t.objectStore('vectors')); } catch (e) { return no(e); } t.oncomplete = () => ok(q && q.result); t.onerror = () => no(t.error); t.onabort = () => no(t.error || new Error('IndexedDB aborted')); });
    }
    all() { return this.tx('readonly', s => s.getAll()).then(a => a || []); }
    putMany(es) { return this.tx('readwrite', s => { es.forEach(e => s.put(e)); }); }
    deleteKeys(ks) { return this.tx('readwrite', s => { ks.forEach(k => s.delete(k)); }); }
    clear() { return this.tx('readwrite', s => s.clear()); }
    async close() { try { this.d && this.d.close(); } catch (e) {} this.d = null; }
  }

  /* open(): try IndexedDB, fall back to memory. Never throws. Returns the store. */
  async function openStore(idb = root.indexedDB, name) {
    if (idb) { try { const s = new IDBVectorStore(idb, name); await s.open(); return s; } catch (e) { try { console.warn('[ALISA VECTORS] IndexedDB unavailable, using memory:', e && e.message); } catch (_) {} } }
    return new MemoryVectorStore();
  }
  return { keyOf, MemoryVectorStore, IDBVectorStore, openStore };
});
