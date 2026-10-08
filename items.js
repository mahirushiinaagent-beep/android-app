'use strict';
/* Validation + normalization for stored items (server side). Used by server.js and store.js.
   Memory metadata (all optional, backward compatible with schema 1 items):
     confidence 0..1 · lastUsedAt ISO · tags string[] · supersedes id|null · private boolean · schemaVersion int · updatedAt (SERVER-assigned) */
const CATS = ['preferences', 'importantFacts', 'goals', 'approvedMemories'], TYPES = ['document', 'note', 'imported'];
const ID = /^[A-Za-z0-9_-]{8,64}$/, SCHEMA_VERSION = 2;
const SECRET = [/\b(password|passcode|passphrase|pin|api[\s_-]?key|token|secret|cvv)\b\s*(is|are|=|:)/i, /\b(sk|pk|ghp|xox[bp]|AKIA)[-_A-Za-z0-9]{12,}/, /\bBearer\s+\S{10,}/i,
  /\b[A-Za-z0-9+\/_=-]{32,}\b/, /\b\d{13,19}\b/];                         // the last two are the browser's "loose" rules; memories are short text so they are safe to apply
const KNOWLEDGE_SECRET = SECRET.slice(0, 3);                              // long documents legitimately contain long tokens/numbers
const str = (v, max) => typeof v === 'string' && v.length <= max;
const iso = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const looksSecret = (t, store) => (store === 'knowledge' ? KNOWLEDGE_SECRET : SECRET).some(r => r.test(String(t)));

function validate(store, id, x) {
  if (!x || typeof x !== 'object' || x.id !== id) return 'id mismatch';
  if (!str(x.createdAt, 60) || !str(x.source, 60)) return 'bad metadata';
  if (store === 'memories') {
    if (!CATS.includes(x.category) || !str(x.content, 1000) || !x.content.trim() || x.approved !== true) return 'invalid memory';
    if (looksSecret(x.content, store)) return 'looks like a secret';
    if (x.confidence !== undefined && !(typeof x.confidence === 'number' && x.confidence >= 0 && x.confidence <= 1)) return 'bad confidence';
    if (x.lastUsedAt !== undefined && x.lastUsedAt !== null && !iso(x.lastUsedAt)) return 'bad lastUsedAt';
    if (x.tags !== undefined) {
      if (!Array.isArray(x.tags) || x.tags.length > 10 || !x.tags.every(t => str(t, 40) && t.trim())) return 'bad tags';
      if (x.tags.some(t => looksSecret(t, store))) return 'looks like a secret';
    }
    if (x.supersedes !== undefined && x.supersedes !== null && !(typeof x.supersedes === 'string' && ID.test(x.supersedes))) return 'bad supersedes';
    if (x.private !== undefined && typeof x.private !== 'boolean') return 'bad private flag';
    if (x.schemaVersion !== undefined && !(Number.isInteger(x.schemaVersion) && x.schemaVersion >= 1 && x.schemaVersion <= 99)) return 'bad schemaVersion';
  } else {
    if (!TYPES.includes(x.type) || !str(x.title, 200) || !x.title.trim() || !str(x.content, 2e6) || !x.content.trim()) return 'invalid knowledge item';
    if (looksSecret(x.title + ' ' + x.content, store)) return 'looks like a secret';
  }
  return null;
}

// Whitelist copy: unknown fields are dropped. updatedAt is NOT copied — the backend assigns it from the server clock.
function pick(store, x) {
  if (store === 'memories') {
    const o = { id: x.id, category: x.category, content: x.content, createdAt: x.createdAt, source: x.source, approved: true, private: x.private === true, schemaVersion: SCHEMA_VERSION };
    if (typeof x.confidence === 'number') o.confidence = x.confidence;
    if (x.lastUsedAt) o.lastUsedAt = x.lastUsedAt;
    if (Array.isArray(x.tags) && x.tags.length) o.tags = x.tags.map(t => t.trim());
    if (x.supersedes) o.supersedes = x.supersedes;
    return o;
  }
  return { id: x.id, type: x.type, title: x.title, content: x.content, createdAt: x.createdAt, source: x.source };
}

module.exports = { CATS, TYPES, ID, SECRET, SCHEMA_VERSION, validate, pick, looksSecret };
