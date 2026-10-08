/* ALISA STATUS CENTER (Phase 3.1 foundation) — one place that reports the health of ALISA's parts. window.ALISAStatus
   Components: Brain · Memory · Retrieval · Semantic · Knowledge · Security · Agent Core · Tool Registry.
   States: HEALTHY (a real functional check passed) · READY (present and idle; nothing to exercise or only self-reported) · WARNING (works, degraded)
           ERROR (a check failed) · DISABLED (turned off / asleep by choice) · NOT_AVAILABLE (module or capability missing) · NOT_TESTED (could not be checked).
   `tested:true` means the probe actually ran something (read the store, ranked a fixture, ran the agent pipeline). `tested:false` means the state only
   repeats what the component says about itself. Nothing here is faked: a component that cannot be checked is reported NOT_TESTED, never HEALTHY.
   Probes are read-only (no memory/knowledge writes, no network calls, no model downloads). They run only when snapshot() is called — there is no timer. */
(() => {
  'use strict';
  const STATES = Object.freeze(['HEALTHY', 'READY', 'WARNING', 'ERROR', 'DISABLED', 'NOT_AVAILABLE', 'NOT_TESTED']);
  const SEVERITY = { DISABLED: 0, HEALTHY: 1, READY: 2, NOT_TESTED: 3, NOT_AVAILABLE: 4, WARNING: 5, ERROR: 6 };
  const worst = states => { let w = 'DISABLED'; for (const s of states) if ((SEVERITY[s] ?? 6) > SEVERITY[w]) w = s; return states.every(s => s === 'DISABLED') ? 'DISABLED' : w === 'DISABLED' ? 'HEALTHY' : w; };
  const probes = new Map(), order = [];
  let cache = null, cacheAt = 0, inflight = null;
  const short = (s, n = 100) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);
  const timeout = (p, ms) => { let t; return Promise.race([Promise.resolve(p), new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timed out'), { timedOut: true })), ms); t && t.unref && t.unref(); })]).finally(() => clearTimeout(t)); };
  const out = (state, detail, tested) => ({ state, detail: short(detail), tested: tested === true });

  function register(id, label, probe) { if (!probes.has(id)) order.push(id); probes.set(id, { id, label, probe }); }
  async function runOne(c, deep) {
    const t0 = Date.now(); let r;
    try { r = await timeout(c.probe({ deep }), deep ? 6000 : 2500); if (!r || !STATES.includes(r.state)) r = out('NOT_TESTED', 'probe returned no usable result', false); }
    catch (e) { r = e && e.timedOut ? out('NOT_TESTED', 'check timed out', false) : out('ERROR', 'check failed: ' + short(e && (e.code || e.message), 60), true); }
    return { id: c.id, label: c.label, ...r, checkedAt: Date.now(), durationMs: Date.now() - t0 };
  }
  async function snapshot(o = {}) {
    if (!o.force && !o.deep && cache && Date.now() - cacheAt < 3000) return cache;
    if (inflight && !o.deep) return inflight;
    const run = (async () => {
      const comps = await Promise.all(order.map(id => runOne(probes.get(id), o.deep === true)));
      let resources = null; try { const R = window.ALISAResources; if (R) resources = o.sampleResources === false ? R.current() : await R.sample(); } catch (e) {}
      let mood = null; try { mood = window.ALISAPersonality ? window.ALISAPersonality.get() : null; } catch (e) {}
      cache = { overall: worst(comps.map(c => c.state)), components: comps, resources, mood, checkedAt: Date.now(), deep: o.deep === true };
      cacheAt = Date.now(); try { window.dispatchEvent(new window.CustomEvent('alisastatus:update')); } catch (e) {}
      return cache;
    })();
    inflight = run.finally(() => { inflight = null; });
    return inflight;
  }
  // synchronous view for rendering: the last snapshot, or an all-NOT_TESTED placeholder (never a fake "healthy")
  const last = () => cache || { overall: 'NOT_TESTED', components: order.map(id => ({ id, label: probes.get(id).label, state: 'NOT_TESTED', detail: 'not checked yet', tested: false })), resources: null, mood: null, checkedAt: null, deep: false };

  /* ---------------- built-in probes ---------------- */
  register('brain', 'Brain', async () => {
    const B = window.ALISABrain; if (!B) return out('NOT_AVAILABLE', 'brain module not loaded');
    const aw = B.state && B.state.awake;
    if (!aw) return out('DISABLED', 'asleep — say “Alisa online mode” to wake it');
    if (aw === 'online') return B.state.lastError ? out('WARNING', 'online brain awake; last error: ' + short(B.state.lastError, 60), false) : out('READY', 'online brain awake (cloud not live-tested)', false);
    return out('READY', 'on-device brain awake (not live-tested)', false);
  });
  register('memory', 'Memory', async () => {
    const M = window.ALISAMind; if (!M) return out('NOT_AVAILABLE', 'ALISA MIND not loaded');
    await M.ready(); const n = M.memory.getAll().length, st = M.status || {};
    if (!st.persistent) return out('WARNING', 'memory-only for this session (not persistent) · ' + n + ' items', true);
    return M.lastError ? out('WARNING', n + ' memories readable; last warning: ' + short(M.lastError, 60), true) : out('HEALTHY', n + ' memories readable · ' + short(st.storage, 30), true);
  });
  register('retrieval', 'Retrieval', async () => {
    const R = window.ALISARetrieval; if (!R || typeof R.rank !== 'function') return out('NOT_AVAILABLE', 'retrieval module not loaded');
    const r = R.rank('tea', [{ id: 'a', content: 'I like tea', category: 'importantFacts' }, { id: 'b', content: 'The car is red', category: 'importantFacts' }], { limit: 2 });
    return r.length && r[0].id === 'a' ? out('HEALTHY', 'keyword ranking self-test passed', true) : out('ERROR', 'ranking self-test returned the wrong result', true);
  });
  register('semantic', 'Semantic search', async () => {
    const S = window.ALISASemantic, i = S && S.instance; if (!i) return out('NOT_AVAILABLE', 'semantic layer not loaded');
    const st = i.getStatus();
    if (!st.enabled) return out('DISABLED', 'turned off — keyword search is used', false);
    if (st.semanticAvailable) return out('HEALTHY', st.mode + ' · ' + st.indexedItemCount + '/' + st.totalItems + ' indexed', false);
    if (st.embeddingState === 'unavailable') return out('WARNING', 'keyword fallback — embedding model unavailable', false);
    return out('READY', 'keyword search active; embedding model ' + short(st.embeddingState, 20), false);
  });
  register('knowledge', 'Knowledge', async () => {
    const M = window.ALISAMind; if (!M) return out('NOT_AVAILABLE', 'ALISA MIND not loaded');
    await M.ready(); const n = M.knowledge.getAll().length; M.knowledge.search('status check', 1);
    return n ? out('HEALTHY', n + ' notes readable and searchable', true) : out('READY', 'no notes saved yet', true);
  });
  register('security', 'Security', async ({ deep }) => {
    const S = window.ALISASecurity; if (!S) return out('NOT_AVAILABLE', 'security.js did not load');
    const enrolled = await S.has();
    if (!deep) return enrolled ? out('READY', 'voice profile enrolled (speaker model not queried — run a full check)', false) : out('WARNING', 'no voice profile — sensitive commands are unavailable', true);
    const info = await S.info();   // explicit full check only: may initialise the speaker model
    if (info.lastError) return out('WARNING', 'security reported: ' + short(info.lastError, 60), true);
    if (!info.enrolled) return out('WARNING', 'no voice profile enrolled', true);
    return info.method === 'neural' ? out('HEALTHY', 'enrolled · neural speaker model loaded', true) : out('WARNING', 'enrolled but LOW ASSURANCE (no neural model)', true);
  });
  register('agent_core', 'Agent Core', async () => {
    const A = window.ALISAAgentCore; if (!A) return out('NOT_AVAILABLE', 'agent core not loaded');
    const r = await A.selfCheck(); return r.ok ? out('HEALTHY', r.detail, true) : out('ERROR', r.detail, true);
  });
  register('tool_registry', 'Tool Registry', async () => {
    const R = window.ALISAToolRegistry && window.ALISAToolRegistry.default; if (!R) return out('NOT_AVAILABLE', 'tool registry not loaded');
    const i = R.integrity();
    if (!i.ok) return out('ERROR', i.problems.slice(0, 2).join('; '), true);
    return i.enabled ? out('HEALTHY', i.count + ' tools · ' + i.enabled + ' enabled', true) : out('WARNING', i.count + ' tools registered, all disabled', true);
  });

  window.ALISAStatus = { version: 1, STATES, SEVERITY, worst, register, snapshot, last, ids: () => [...order] };
})();
