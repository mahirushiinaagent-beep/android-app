'use strict';
/* ALISA storage backends. Same async interface, two implementations:
     JsonBackend  — ./data/*.json (default when DATABASE_URL is not set; also the rollback path)
     PgBackend    — PostgreSQL via the `pg` package (Neon). `pg` is required lazily, so JSON mode stays zero-dependency.

   Semantics (identical in both, covered by test/parity.test.js):
   • updatedAt is assigned by the SERVER clock and is strictly increasing per item. Client clocks are never trusted.
   • put(store, item, {base}): create needs no base; update needs base === the item's current updatedAt, otherwise a conflict is returned
     ('exists' | 'stale' | 'deleted') together with the current server copy. Nothing is silently overwritten.
   • remove() writes a TOMBSTONE (deleted_at set, content wiped). A tombstoned id can never be re-created by a stale client.
   • list(store, {since}) returns changes (live items + tombstone stubs) with updatedAt >= since, so devices can sync deletions.
   • purge(days) hard-deletes tombstones older than the retention window.
   • Migration of legacy JSON into Postgres is recorded in schema_migrations and runs at most once. */
const fs = require('fs'), path = require('path');
const { validate, pick } = require('./items');

const STORES = ['memories', 'knowledge'];
const ms = v => (v instanceof Date ? v.getTime() : Date.parse(v));
const isoOf = v => new Date(ms(v)).toISOString();
const nextTs = prev => { let t = Date.now(); const p = prev ? ms(prev) : NaN; if (Number.isFinite(p) && t <= p) t = p + 1; return new Date(t).toISOString(); };
const stub = (id, deletedAt, updatedAt) => ({ id, deleted: true, deletedAt, updatedAt });
const conflict = (reason, current) => ({ conflict: true, reason, current: current || null });

/* ============================ JSON backend ============================ */
class JsonBackend {
  constructor(dir) { this.kind = 'json'; this.dir = dir; this.m = { memories: new Map(), knowledge: new Map() }; this.t = {}; }
  file(s) { return path.join(this.dir, s + '.json'); }
  async init() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const s of STORES) {
      try { for (const x of JSON.parse(fs.readFileSync(this.file(s), 'utf8'))) { if (x && x.id) this.m[s].set(x.id, x.deleted ? x : Object.assign({ updatedAt: x.updatedAt || x.createdAt }, x)); } }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  save(s) { clearTimeout(this.t[s]); this.t[s] = setTimeout(() => this.flush(s), 100); this.t[s].unref && this.t[s].unref(); }
  flush(s) {
    for (const k of s ? [s] : STORES) {
      clearTimeout(this.t[k]); const f = this.file(k), tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...this.m[k].values()]), { mode: 0o600 }); fs.renameSync(tmp, f);   // atomic replace
    }
  }
  async list(s, { since } = {}) {
    const all = [...this.m[s].values()];
    const rows = since ? all.filter(x => ms(x.updatedAt) >= ms(since)) : all.filter(x => !x.deleted);
    return rows.sort((a, b) => ms(a.updatedAt) - ms(b.updatedAt)).map(x => ({ ...x }));
  }
  async get(s, id) { const x = this.m[s].get(id); return x ? { ...x } : null; }
  async put(s, item, { base } = {}) {
    const cur = this.m[s].get(item.id);
    if (cur && cur.deleted) return conflict('deleted', cur);
    if (cur && !base) return conflict('exists', cur);
    if (cur && base !== cur.updatedAt) return conflict('stale', cur);
    if (!cur && base) return conflict('deleted', stub(item.id, null, null));   // base but no row: tombstone was purged → the item was deleted
    const rec = { ...item, createdAt: cur ? cur.createdAt : item.createdAt, updatedAt: nextTs(cur && cur.updatedAt) };
    this.m[s].set(item.id, rec); this.save(s); return { ok: true, item: { ...rec } };
  }
  async remove(s, id) {
    const cur = this.m[s].get(id); if (!cur || cur.deleted) return { ok: true, existed: false };
    const t = nextTs(cur.updatedAt); this.m[s].set(id, stub(id, t, t)); this.save(s); return { ok: true, existed: true };
  }
  async clear(s) { let n = 0; for (const [id, x] of this.m[s]) if (!x.deleted) { const t = nextTs(x.updatedAt); this.m[s].set(id, stub(id, t, t)); n++; } if (n) this.save(s); return n; }
  async purge(days) {
    const cut = Date.now() - days * 864e5; let n = 0;
    for (const s of STORES) for (const [id, x] of this.m[s]) if (x.deleted && ms(x.deletedAt) < cut) { this.m[s].delete(id); n++; }
    if (n) this.flush(); return n;
  }
  async close() { this.flush(); }
}

/* ============================ PostgreSQL backend ============================ */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), detail jsonb NOT NULL DEFAULT '{}'::jsonb)`,
  `CREATE TABLE IF NOT EXISTS alisa_items (
     store      text        NOT NULL CHECK (store IN ('memories','knowledge')),
     id         text        NOT NULL,
     data       jsonb       NOT NULL,
     created_at timestamptz NOT NULL,
     updated_at timestamptz NOT NULL,
     deleted_at timestamptz,
     PRIMARY KEY (store, id))`,
  `CREATE INDEX IF NOT EXISTS alisa_items_sync_idx ON alisa_items (store, updated_at)`,
  `CREATE INDEX IF NOT EXISTS alisa_items_tombstone_idx ON alisa_items (deleted_at) WHERE deleted_at IS NOT NULL`,
];
// Every statement the backend runs is listed here (the fake driver in test/ dispatches on these exact strings).
const SQL = {
  list: `SELECT id, data, created_at, updated_at, deleted_at FROM alisa_items WHERE store = $1 AND deleted_at IS NULL ORDER BY updated_at`,
  since: `SELECT id, data, created_at, updated_at, deleted_at FROM alisa_items WHERE store = $1 AND updated_at >= $2 ORDER BY updated_at`,
  get: `SELECT id, data, created_at, updated_at, deleted_at FROM alisa_items WHERE store = $1 AND id = $2`,
  insert: `INSERT INTO alisa_items (store, id, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (store, id) DO NOTHING RETURNING id, data, created_at, updated_at, deleted_at`,
  update: `UPDATE alisa_items SET data = $3::jsonb || jsonb_build_object('createdAt', data->'createdAt'), updated_at = $4 WHERE store = $1 AND id = $2 AND deleted_at IS NULL AND updated_at = $5 RETURNING id, data, created_at, updated_at, deleted_at`,
  remove: `UPDATE alisa_items SET data = jsonb_build_object('id', id), updated_at = GREATEST($3::timestamptz, updated_at + interval '1 millisecond'), deleted_at = GREATEST($3::timestamptz, updated_at + interval '1 millisecond') WHERE store = $1 AND id = $2 AND deleted_at IS NULL`,
  clear: `UPDATE alisa_items SET data = jsonb_build_object('id', id), updated_at = GREATEST($2::timestamptz, updated_at + interval '1 millisecond'), deleted_at = GREATEST($2::timestamptz, updated_at + interval '1 millisecond') WHERE store = $1 AND deleted_at IS NULL`,
  purge: `DELETE FROM alisa_items WHERE deleted_at IS NOT NULL AND deleted_at < $1`,
  count: `SELECT count(*)::int AS n FROM alisa_items`,
  migGet: `SELECT detail FROM schema_migrations WHERE name = $1`,
  migMark: `INSERT INTO schema_migrations (name, detail) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING name`,
  migDetail: `UPDATE schema_migrations SET detail = $2 WHERE name = $1`,
  importRow: `INSERT INTO alisa_items (store, id, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (store, id) DO NOTHING`,
  lock: `SELECT pg_advisory_xact_lock(727001)`,
};
const TRANSIENT = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', '57P01', '57P03', '08000', '08003', '08006', '08001', '53300']);
const sleep = t => new Promise(r => setTimeout(r, t));
const MIGRATION = 'legacy-json-import-v1';

class PgBackend {
  /* opts: { url, legacyDir, skipImport, poolMax, driver } — `driver` lets tests inject a fake with the `pg` Pool API. */
  constructor(opts) {
    this.kind = 'postgres'; this.o = opts;
    const pg = opts.driver || require('pg');                 // lazy: JSON mode never needs the dependency
    const local = /@(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(opts.url);
    const ssl = /[?&]sslmode=disable\b/.test(opts.url) || local ? undefined : (/[?&]sslmode=/.test(opts.url) ? undefined : { rejectUnauthorized: true });
    this.pool = new pg.Pool({ connectionString: opts.url, ssl, max: opts.poolMax || 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 });
    this.pool.on('error', e => console.warn('[ALISA DB] idle client error:', e && e.code || e && e.message));   // Neon suspends idle compute: don't crash on it
  }
  async q(text, values, tries = 3) {                          // retry transient connection errors (Neon cold start / suspended compute)
    for (let i = 1; ; i++) {
      try { return await this.pool.query(text, values); }
      catch (e) { if (i >= tries || !(e && (TRANSIENT.has(e.code) || /timeout|terminated|ECONNRESET/i.test(e.message || '')))) throw e; await sleep(400 * i); }
    }
  }
  async withTx(fn) {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  async init() {
    for (let i = 1; ; i++) {                                  // wait out a cold start before giving up
      try { await this.q('SELECT 1'); break; } catch (e) { if (i >= 4) throw new Error('Cannot reach PostgreSQL (' + (e.code || e.message) + ')'); await sleep(1000 * i); }
    }
    await this.withTx(async c => { await c.query(SQL.lock); for (const ddl of SCHEMA) await c.query(ddl); });
    await this.migrateLegacy();
  }
  // One-time import of ./data/*.json. The flag row is inserted FIRST inside the transaction, so a second run (or a second instance) inserts nothing.
  async migrateLegacy() {
    if (!this.o.legacyDir) return { skipped: 'no legacy dir' };
    return this.withTx(async c => {
      await c.query(SQL.lock);
      const mark = await c.query(SQL.migMark, [MIGRATION, JSON.stringify({ status: 'running' })]);
      if (!mark.rows.length) return { skipped: 'already recorded' };
      const detail = { status: 'done', imported: 0, skipped: 0 };
      const n = (await c.query(SQL.count)).rows[0].n;
      if (this.o.skipImport) detail.status = 'skipped: ALISA_SKIP_JSON_IMPORT';
      else if (n > 0) detail.status = 'skipped: database not empty';
      else for (const s of STORES) {
        let arr = []; try { arr = JSON.parse(fs.readFileSync(path.join(this.o.legacyDir, s + '.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        for (const x of Array.isArray(arr) ? arr : []) {
          if (!x || x.deleted || validate(s, x.id, x) || !x.id) { detail.skipped++; continue; }   // tombstones and invalid rows are never imported
          const it = pick(s, x), u = Number.isFinite(ms(x.updatedAt)) ? isoOf(x.updatedAt) : isoOf(x.createdAt);
          await c.query(SQL.importRow, [s, it.id, JSON.stringify(it), Number.isFinite(ms(it.createdAt)) ? isoOf(it.createdAt) : u, u]); detail.imported++;
        }
      }
      await c.query(SQL.migDetail, [MIGRATION, JSON.stringify(detail)]);
      return detail;
    });
  }
  row(r) {
    if (r.deleted_at) return stub(r.id, isoOf(r.deleted_at), isoOf(r.updated_at));
    return Object.assign({}, r.data, { id: r.id, createdAt: r.data.createdAt || isoOf(r.created_at), updatedAt: isoOf(r.updated_at) });
  }
  async list(s, { since } = {}) { const r = since ? await this.q(SQL.since, [s, isoOf(since)]) : await this.q(SQL.list, [s]); return r.rows.map(x => this.row(x)); }
  async get(s, id) { const r = await this.q(SQL.get, [s, id]); return r.rows[0] ? this.row(r.rows[0]) : null; }
  async put(s, item, { base } = {}) {
    const data = JSON.stringify(item);
    if (!base) {                                              // create
      const t = nextTs(null), r = await this.q(SQL.insert, [s, item.id, data, isoOf(item.createdAt), t]);
      if (r.rows[0]) return { ok: true, item: this.row(r.rows[0]) };
    } else {                                                  // compare-and-set on updated_at
      const b = isoOf(base), r = await this.q(SQL.update, [s, item.id, data, nextTs(b), b]);
      if (r.rows[0]) return { ok: true, item: this.row(r.rows[0]) };
    }
    const cur = await this.get(s, item.id);                   // nothing written → classify why
    if (cur && cur.deleted) return conflict('deleted', cur);
    if (cur) return conflict(base ? 'stale' : 'exists', cur);
    return conflict('deleted', stub(item.id, null, null));    // base given but row gone: tombstone already purged
  }
  async remove(s, id) { const r = await this.q(SQL.remove, [s, id, new Date().toISOString()]); return { ok: true, existed: r.rowCount > 0 }; }
  async clear(s) { const r = await this.q(SQL.clear, [s, new Date().toISOString()]); return r.rowCount; }
  async purge(days) { const r = await this.q(SQL.purge, [new Date(Date.now() - days * 864e5).toISOString()]); return r.rowCount; }
  async close() { await this.pool.end(); }
}

async function createBackend(env = process.env, dataDir) {
  const url = (env.DATABASE_URL || '').trim();
  if (!url) { const b = new JsonBackend(dataDir); await b.init(); return b; }
  const b = new PgBackend({ url, legacyDir: dataDir, skipImport: env.ALISA_SKIP_JSON_IMPORT === '1', poolMax: +env.PG_POOL_MAX || 5 });
  await b.init(); return b;
}

module.exports = { JsonBackend, PgBackend, createBackend, SQL, SCHEMA, STORES, MIGRATION };
