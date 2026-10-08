/* ALISA PLANNER (Phase 3.1) — turns a classified request into a small, bounded, linear plan. window.ALISAPlanner
   - Single-step plans for every tool intent.  - ONE multi-step template today: "<calculation> and remember the result" → calculator → memory.save.
   - Hard limits: MAX_STEPS steps, strictly sequential, no loops, no recursion, no plan can create another plan. A tool result can never add steps.
   - Steps may reference EARLIER step outputs with "${steps.N.output.field}" placeholders, resolved by a safe dotted-path lookup (no eval, no code).
   - Plan status: PLANNED → RUNNING → SUCCESS | FAILED | PARTIAL | CANCELLED | REQUIRES_CONFIRMATION | REQUIRES_AUTHENTICATION | DENIED. Step status: PENDING → RUNNING → SUCCESS | FAILED | SKIPPED | CANCELLED | BLOCKED. */
(() => {
  'use strict';
  const MAX_STEPS = 5;
  const rid = p => p + '_' + Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  const step = (i, tool, input) => ({ id: rid('s'), index: i, tool, input, status: 'PENDING' });

  function plan(intent, text) {
    if (!intent || !intent.requiresTool || !intent.tool) return null;
    const steps = [step(0, intent.tool, intent.params || {})];
    if (intent.compound && intent.tool === 'calculator.evaluate') steps.push(step(1, 'memory.save', { content: '${steps.0.output.expression} = ${steps.0.output.value}' }));   // "…and remember the result"
    if (steps.length > MAX_STEPS) return null;
    return { id: rid('p'), status: 'PLANNED', createdAt: Date.now(), steps, cancelled: false };
  }
  // Safe placeholder resolution: only "${steps.<n>.output.<path>}" against already-completed steps.
  const PH = /\$\{steps\.(\d+)\.output\.([A-Za-z0-9_.]+)\}/g;
  function resolve(input, completed) {
    const sub = s => s.replace(PH, (_, n, path) => {
      const st = completed[+n]; if (!st || st.status !== 'SUCCESS' || !st.output) throw new Error('UNRESOLVED_REFERENCE');
      let v = st.output; for (const k of path.split('.')) { if (v == null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, k)) throw new Error('UNRESOLVED_REFERENCE'); v = v[k]; }
      if (typeof v === 'object') throw new Error('UNRESOLVED_REFERENCE');
      return typeof v === 'number' ? String(+v.toPrecision(15)) : String(v);
    });
    const walk = v => typeof v === 'string' ? sub(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
    return walk(input);
  }
  // Overall plan status from step statuses.
  function summarize(p) {
    const done = p.steps.filter(s => s.status === 'SUCCESS').length, total = p.steps.length;
    if (p.cancelled) return 'CANCELLED';
    if (done === total) return 'SUCCESS';
    const stop = p.steps.find(s => !['SUCCESS', 'SKIPPED'].includes(s.status)) || null;
    if (stop && (stop.status === 'BLOCKED') && stop.block) return done > 0 && stop.block === 'DENIED' ? 'PARTIAL' : stop.block;
    return done > 0 ? 'PARTIAL' : 'FAILED';
  }
  window.ALISAPlanner = { version: 1, MAX_STEPS, plan, resolve, summarize };
})();
