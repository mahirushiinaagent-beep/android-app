/* ALISA INITIAL SAFE TOOLS (Phase 3.1) — local-only tools registered in window.ALISAToolRegistry.default
     memory.search      SAFE   search long-term memory (existing ALISAMind search; private memories are never returned)
     memory.save        LOW    save one memory through the existing ALISAMind remember path (secret filter + dedupe still apply)
     knowledge.search   SAFE   search saved notes/documents (existing retrieval: semantic when really available, otherwise keyword)
     calculator.evaluate SAFE  arithmetic with a hand-written parser — NO eval(), NO Function()
     time.now           SAFE   current date/time from the device clock (Intl) — optional IANA time zone
     diagnostics.report SAFE   module health from ALISAStatus (read-only)
     tasks.local        LOW    create / list / complete tasks on the EXISTING to-do list (localStorage 'alisa-lists' → 'to-do'; done tasks archived in 'alisa-agent-tasks-done')
   Every tool: validates input, returns structured output, and provides verify() that re-checks the outcome from its source of truth. */
(() => {
  'use strict';
  const R = window.ALISAToolRegistry; if (!R) { console.warn('[ALISA AGENT TOOLS] registry not loaded'); return; }
  const { ToolError } = R;
  const MIND = () => window.ALISAMind;
  const need = (x, name) => { if (!x) throw new ToolError('TOOL_UNAVAILABLE', name + ' is not loaded', 'That part of ALISA isn’t available right now.'); return x; };
  const REFUSAL = 'I can’t store passwords, tokens, keys or other secrets.';
  const looksSecret = t => { try { const MI = window.ALISAMemoryIntelligence, M = MIND(); return !!((MI && MI.isSensitive(t)) || (M && M.isSecret(t))); } catch (e) { return true; } };   // fail closed

  /* ================= safe math (two independent evaluators) ================= */
  const FN = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil };
  const CONST = { pi: Math.PI, e: Math.E };
  function normalizeMath(s) {
    s = String(s == null ? '' : s).toLowerCase().replace(/[’]/g, "'").replace(/×/g, '*').replace(/÷/g, '/').replace(/[−–—]/g, '-').trim();
    s = s.replace(/^(?:what(?:'s| is)|whats|calculate|compute|how much is|work out|solve|evaluate)\s+/, '').replace(/[\s?=!.]+$/, '');
    s = s.replace(/(\d),(\d{3})(?!\d)/g, '$1$2').replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
    s = s.replace(/square root of\s*(\d+(?:\.\d+)?)/g, 'sqrt($1)').replace(/\bto the power of\b|\braised to\b|\*\*/g, '^').replace(/\bsquared\b/g, '^2').replace(/\bcubed\b/g, '^3')
      .replace(/\bmultiplied by\b|\btimes\b/g, '*').replace(/\bdivided by\b|\bover\b/g, '/').replace(/\bplus\b/g, '+').replace(/\bminus\b/g, '-')
      .replace(/\s*(?:percent|per cent)\s+of\b/g, '% *').replace(/\bpercent\b|\bper cent\b/g, '%').replace(/%\s*of\b/g, '% *')
      .replace(/(\d|\))\s*x\s*(?=\d|\()/g, '$1*');
    return s.replace(/\s+/g, ' ').trim();
  }
  function tokenize(s) {
    const t = []; let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ') { i++; continue; }
      let m;
      if ((m = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(s.slice(i)))) { t.push({ k: 'num', v: parseFloat(m[0]) }); i += m[0].length; }
      else if ('+-*/^%(),'.includes(c)) { t.push({ k: c }); i++; }
      else if ((m = /^[a-z]+/.exec(s.slice(i)))) {
        const w = m[0]; if (w in FN) t.push({ k: 'fn', v: w }); else if (w in CONST) t.push({ k: 'num', v: CONST[w] }); else return null; i += w.length;
      } else return null;
      if (t.length > 120) return null;
    }
    return t;
  }
  const bad = () => new ToolError('INVALID_INPUT', 'syntax', 'I couldn’t understand that calculation.');
  const mathErr = m => new ToolError('MATH_ERROR', m, m === 'div0' ? 'I can’t divide by zero.' : m === 'sqrtneg' ? 'I can’t take the square root of a negative number.' : 'That result is too large or isn’t a real number.');
  const finite = v => { if (!Number.isFinite(v)) throw mathErr('range'); return v; };
  const pow = (a, b) => { if (Math.abs(b) > 1000) throw mathErr('range'); const r = Math.pow(a, b); if (Number.isNaN(r)) throw mathErr('range'); return finite(r); };
  const div = (a, b) => { if (b === 0) throw mathErr('div0'); return finite(a / b); };
  const fcall = (f, x) => { if (f === 'sqrt' && x < 0) throw mathErr('sqrtneg'); return finite(FN[f](x)); };
  // evaluator 1: recursive descent.  expr = term (+|- term)* ; term = unary (*|/ unary)* ; unary = (+|-) unary | power ; power = postfix (^ unary)? ; postfix = primary %*
  function evalRD(tokens) {
    let p = 0, depth = 0; const peek = () => (tokens[p] || {}).k;
    const expr = () => { let v = term(); while (peek() === '+' || peek() === '-') { const o = tokens[p++].k, r = term(); v = finite(o === '+' ? v + r : v - r); } return v; };
    const term = () => { let v = unary(); while (peek() === '*' || peek() === '/') { const o = tokens[p++].k, r = unary(); v = o === '*' ? finite(v * r) : div(v, r); } return v; };
    const unary = () => { if (peek() === '-') { p++; return -unary(); } if (peek() === '+') { p++; return unary(); } return power(); };
    const power = () => { const b = postfix(); if (peek() === '^') { p++; return pow(b, unary()); } return b; };
    const postfix = () => { let v = primary(); while (peek() === '%') { p++; v /= 100; } return v; };
    const primary = () => {
      const t = tokens[p++]; if (!t) throw bad();
      if (t.k === 'num') return t.v;
      if (t.k === '(') { if (++depth > 30) throw bad(); const v = expr(); if (peek() !== ')') throw bad(); p++; depth--; return v; }
      if (t.k === 'fn') { if (peek() !== '(') throw bad(); p++; if (++depth > 30) throw bad(); const v = expr(); if (peek() !== ')') throw bad(); p++; depth--; return fcall(t.v, v); }
      throw bad();
    };
    const v = expr(); if (p !== tokens.length) throw bad(); return v;
  }
  // evaluator 2: shunting-yard → RPN → stack machine (independent implementation, used to cross-check evaluator 1)
  function evalSY(tokens) {
    const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, neg: 3, '^': 4 }, RIGHT = { '^': true, neg: true };
    const out = [], ops = []; let prev = null;   // prev = previous token kind, to tell unary minus from binary
    for (const t of tokens) {
      const k = t.k;
      if (k === 'num') out.push(t);
      else if (k === 'fn') ops.push(t);
      else if (k === '%') out.push({ k: 'pct' });
      else if (k === '(') ops.push(t);
      else if (k === ')') { while (ops.length && ops[ops.length - 1].k !== '(') out.push(ops.pop()); if (!ops.length) throw bad(); ops.pop(); if (ops.length && ops[ops.length - 1].k === 'fn') out.push(ops.pop()); }
      else if (k === ',') throw bad();
      else {
        let op = k; const unary = prev === null || ['+', '-', '*', '/', '^', '('].includes(prev);
        if (unary) { if (k === '+') { prev = k; continue; } if (k !== '-') throw bad(); op = 'neg'; }
        // a prefix operator has no left operand, so it never pops anything off the stack
        while (op !== 'neg' && ops.length) { const top = ops[ops.length - 1].k; if (top === '(' || top === 'fn') break; if (PREC[top] > PREC[op] || (PREC[top] === PREC[op] && !RIGHT[op])) out.push(ops.pop()); else break; }
        ops.push({ k: op });
      }
      prev = k;
    }
    while (ops.length) { const o = ops.pop(); if (o.k === '(' || o.k === 'fn') throw bad(); out.push(o); }
    const st = [];
    for (const t of out) {
      if (t.k === 'num') st.push(t.v);
      else if (t.k === 'pct') { if (!st.length) throw bad(); st.push(st.pop() / 100); }
      else if (t.k === 'neg') { if (!st.length) throw bad(); st.push(-st.pop()); }
      else if (t.k === 'fn') { if (!st.length) throw bad(); st.push(fcall(t.v, st.pop())); }
      else { if (st.length < 2) throw bad(); const b = st.pop(), a = st.pop(); st.push(t.k === '+' ? finite(a + b) : t.k === '-' ? finite(a - b) : t.k === '*' ? finite(a * b) : t.k === '/' ? div(a, b) : pow(a, b)); }
    }
    if (st.length !== 1) throw bad(); return st[0];
  }
  function prepare(text) {
    const raw = String(text == null ? '' : text); if (raw.length > 200) throw bad();
    const norm = normalizeMath(raw), tokens = tokenize(norm);
    if (!tokens || !tokens.length || !tokens.some(t => t.k === 'num')) throw bad();
    return { norm, tokens };
  }
  const math = {
    normalize: normalizeMath,
    evaluate: text => evalRD(prepare(text).tokens),
    evaluateAlt: text => evalSY(prepare(text).tokens),
    // Does this text look like arithmetic (not just a number or ordinary prose)? Returns {ok, expr}. Valid-but-undefined maths (1/0) still counts as an expression.
    looksLikeExpression(text) {
      try { const { norm, tokens } = prepare(text); if (!tokens.some(t => ['+', '-', '*', '/', '^', '%', 'fn'].includes(t.k))) return { ok: false }; try { evalRD(tokens); } catch (e) { if (!(e instanceof ToolError) || e.code !== 'MATH_ERROR') return { ok: false }; } return { ok: true, expr: norm }; }
      catch (e) { return { ok: false }; }
    },
  };
  const fmtNum = n => { const s = String(+n.toPrecision(12)); if (/e/i.test(s)) return s; const [i, d] = s.split('.'); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? '.' + d : ''); };

  /* ================= tool definitions ================= */
  const S = (type, extra = {}) => ({ type, ...extra });
  const tools = [];

  tools.push({
    id: 'memory.search', name: 'Memory search', description: 'Search ALISA’s long-term memory for things you asked it to remember. Private memories are never returned.',
    category: 'memory', riskLevel: 'SAFE', permissions: ['memory.read'],
    inputSchema: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: S('string', { minLength: 1, maxLength: 200 }), limit: S('integer', { minimum: 1, maximum: 5 }) } },
    outputSchema: { type: 'object', required: ['found', 'count', 'results', 'text'], properties: { found: S('boolean'), count: S('number'), withheldPrivate: S('number'), results: S('array'), text: S('string') } },
    async execute(input) {
      const M = need(MIND(), 'ALISA MIND'); await M.ready();
      const limit = input.limit || 3, r = await M.tools.search({ query: input.query, limit: 5 });
      if (r.status === 'refused') throw new ToolError('REFUSED', 'secret-like query', r.text);
      if (r.status === 'invalid') throw new ToolError('INVALID_INPUT', 'invalid query', r.text);
      const all = Array.isArray(r.results) ? r.results : [], pub = all.filter(m => m.private !== true).slice(0, limit), withheld = all.length - all.filter(m => m.private !== true).length;
      const results = pub.map(m => ({ id: String(m.id), content: String(m.content), category: String(m.category || ''), tags: Array.isArray(m.tags) ? m.tags.map(String) : [] }));
      const text = results.length ? 'I remember: ' + results.map(m => m.content.replace(/[.!?]+$/, '')).join('; ') + '.' : withheld ? 'I found something, but it’s marked private, so I won’t read it out here.' : 'I don’t have a memory about that.';
      return { found: results.length > 0, count: results.length, withheldPrivate: withheld, results, text };
    },
    async verify(out) {   // every returned memory must still exist, be public, and match what was returned
      const M = MIND(); if (!M) return { ok: false, detail: 'memory module missing' };
      for (const r of out.results) { const m = M.memory.get(r.id); if (!m || m.private === true || m.content !== r.content) return { ok: false, detail: 'a returned memory did not match the store' }; }
      return { ok: out.count === out.results.length && out.found === (out.count > 0), detail: 'results matched the memory store' };
    },
  });

  tools.push({
    id: 'memory.save', name: 'Memory save', description: 'Save one thing to long-term memory (same safe path as “remember that…”: credentials are refused, duplicates are merged).',
    category: 'memory', riskLevel: 'LOW', permissions: ['memory.write.local'],
    inputSchema: { type: 'object', required: ['content'], additionalProperties: false, properties: { content: S('string', { minLength: 1, maxLength: 1000 }) } },
    outputSchema: { type: 'object', required: ['saved', 'id', 'content', 'text'], properties: { saved: S('boolean'), id: S('string'), content: S('string'), action: S('string'), text: S('string') } },
    async execute(input) {
      const M = need(MIND(), 'ALISA MIND'); await M.ready();
      if (looksSecret(input.content)) throw new ToolError('REFUSED', 'secret-like content', REFUSAL);
      const r = await M.tools.remember({ content: input.content }, { source: 'agent' });
      if (r.status === 'refused') throw new ToolError('REFUSED', 'refused by memory filter', r.text || REFUSAL);
      if (r.status !== 'saved' || !r.item || !r.item.id) throw new ToolError('SAVE_FAILED', 'memory not saved', 'I couldn’t save that to memory.');
      return { saved: true, id: String(r.item.id), content: String(r.item.content), action: String(r.action || 'saved'), text: 'Okay, I’ll remember that: ' + r.item.content.replace(/[.!?]+$/, '') + '.' };
    },
    async verify(out) {   // read it back from the memory store
      const M = MIND(); if (!M) return { ok: false, detail: 'memory module missing' };
      const m = M.memory.get(out.id); return m && m.content === out.content ? { ok: true, detail: 'found in the memory store' } : { ok: false, detail: 'not found in the memory store' };
    },
  });

  tools.push({
    id: 'knowledge.search', name: 'Knowledge search', description: 'Search your saved notes and documents using ALISA’s retrieval system (semantic when available, keyword otherwise).',
    category: 'knowledge', riskLevel: 'SAFE', permissions: ['knowledge.read'],
    inputSchema: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: S('string', { minLength: 1, maxLength: 200 }), limit: S('integer', { minimum: 1, maximum: 5 }) } },
    outputSchema: { type: 'object', required: ['count', 'results', 'mode', 'text'], properties: { count: S('number'), mode: S('string', { enum: ['semantic', 'keyword'] }), results: S('array'), text: S('string') } },
    async execute(input) {
      const M = need(MIND(), 'ALISA MIND'); await M.ready();
      if (looksSecret(input.query)) throw new ToolError('REFUSED', 'secret-like query', 'I can’t search for passwords, tokens or keys — I don’t store them.');
      const limit = input.limit || 3;
      let semantic = false; try { const i = window.ALISASemantic && window.ALISASemantic.instance, st = i && i.getStatus(); semantic = !!(st && st.semanticAvailable && st.indexedItemCount); } catch (e) {}
      const rows = (await M.knowledge.searchAsync(input.query, limit * 2)).filter(k => !looksSecret(k.title + ' ' + (k.snippet || ''))).slice(0, limit);
      const results = rows.map(k => ({ id: String(k.id), title: String(k.title), type: String(k.type || ''), snippet: String(k.snippet || '').slice(0, 160) }));
      return { count: results.length, mode: semantic ? 'semantic' : 'keyword', results, text: results.length ? 'I found ' + results.length + (results.length === 1 ? ' item: ' : ' items: ') + results.map(r => r.title).join(', ') + '.' : 'I didn’t find anything about that in your knowledge.' };
    },
    async verify(out) {
      const M = MIND(); if (!M) return { ok: false, detail: 'memory module missing' };
      for (const r of out.results) { const k = M.knowledge.get(r.id); if (!k || k.title !== r.title) return { ok: false, detail: 'a returned item did not match the knowledge store' }; }
      return { ok: out.count === out.results.length, detail: 'results matched the knowledge store' };
    },
  });

  tools.push({
    id: 'calculator.evaluate', name: 'Calculator', description: 'Safe arithmetic: + − × ÷ ^ %, parentheses, sqrt/abs/round/floor/ceil, pi, e. Never uses eval.',
    category: 'math', riskLevel: 'SAFE', permissions: ['math.compute'],
    inputSchema: { type: 'object', required: ['expression'], additionalProperties: false, properties: { expression: S('string', { minLength: 1, maxLength: 200 }) } },
    outputSchema: { type: 'object', required: ['value', 'expression', 'text'], properties: { value: S('number'), expression: S('string'), text: S('string') } },
    async execute(input) { const { norm } = prepare(input.expression), value = math.evaluate(input.expression); return { value, expression: norm, text: 'That’s ' + fmtNum(value) + '.' }; },
    async verify(out) {   // recompute with the second, independently written evaluator and compare
      const alt = math.evaluateAlt(out.expression), tol = 1e-9 * Math.max(1, Math.abs(alt));
      return Math.abs(alt - out.value) <= tol ? { ok: true, detail: 'second evaluator agrees' } : { ok: false, detail: 'second evaluator disagrees' };
    },
  });

  tools.push({
    id: 'time.now', name: 'Date & time', description: 'Current date and time from this device’s clock, optionally in another IANA time zone.',
    category: 'time', riskLevel: 'SAFE', permissions: ['time.read'],
    inputSchema: { type: 'object', additionalProperties: false, properties: { timezone: S('string', { maxLength: 40 }), label: S('string', { maxLength: 40 }) } },
    outputSchema: { type: 'object', required: ['epochMs', 'iso', 'timezone', 'date', 'time', 'weekday', 'text'], properties: { epochMs: S('number'), iso: S('string'), timezone: S('string'), date: S('string'), time: S('string'), weekday: S('string'), text: S('string') } },
    async execute(input, env) {
      const now = env.now();
      let tz = input.timezone; if (!tz) { try { tz = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { tz = 'UTC'; } }
      let f; try { f = (o) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(now); f({ year: 'numeric' }); } catch (e) { throw new ToolError('INVALID_INPUT', 'bad time zone', 'I don’t know that time zone.'); }
      const date = f({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), time = f({ hour: 'numeric', minute: '2-digit' }), weekday = f({ weekday: 'long' });
      const where = input.label ? ' in ' + String(input.label).replace(/[^\p{L}\p{N} .'-]/gu, '').trim() : '';
      return { epochMs: now, iso: new Date(now).toISOString(), timezone: tz, date, time, weekday, text: 'It’s ' + time + where + ' on ' + date + '.' };
    },
    async verify(out) { const d = Date.parse(out.iso); return Number.isFinite(d) && d === out.epochMs && Math.abs(d - Date.now()) < 5 * 60000 ? { ok: true, detail: 'timestamp is consistent and current' } : { ok: false, detail: 'timestamp inconsistent' }; },
  });

  const STATES = ['HEALTHY', 'READY', 'WARNING', 'ERROR', 'DISABLED', 'NOT_AVAILABLE', 'NOT_TESTED'];
  tools.push({
    id: 'diagnostics.report', name: 'System diagnostics', description: 'Reports the real health of ALISA’s modules. Read-only; components that cannot be tested are shown as not tested.',
    category: 'system', riskLevel: 'SAFE', permissions: ['system.diagnostics.read'],
    inputSchema: { type: 'object', additionalProperties: false, properties: { deep: S('boolean') } },
    outputSchema: { type: 'object', required: ['overall', 'components', 'text'], properties: { overall: S('string'), components: S('array'), text: S('string') } },
    async execute(input) {
      const St = need(window.ALISAStatus, 'Status Center'), snap = await St.snapshot({ deep: input.deep === true });
      const comps = snap.components.map(c => ({ id: c.id, label: c.label, state: c.state, detail: String(c.detail || '').slice(0, 120), tested: c.tested === true }));
      const bad = comps.filter(c => ['WARNING', 'ERROR'].includes(c.state)), ok = comps.filter(c => ['HEALTHY', 'READY'].includes(c.state)).length;
      let text = 'Diagnostics: ' + ok + ' of ' + comps.length + ' systems are healthy or ready.';
      if (bad.length) text += ' Needs attention: ' + bad.slice(0, 3).map(c => c.label + ' (' + c.state.toLowerCase() + ')').join(', ') + '.';
      const nt = comps.filter(c => c.state === 'NOT_TESTED').length; if (nt) text += ' ' + nt + ' could not be tested.';
      return { overall: snap.overall, components: comps, text };
    },
    async verify(out) { const St = window.ALISAStatus; const okShape = out.components.length > 0 && out.components.every(c => STATES.includes(c.state)); return { ok: okShape && (!St || out.overall === St.worst(out.components.map(c => c.state))), detail: okShape ? 'states are valid and the overall state matches' : 'invalid component states' }; },
  });

  /* ---- tasks: ADAPTER over the existing to-do list (Phase 2.5 commands.js stores it in localStorage 'alisa-lists' → {"to-do":[strings]}).
         "add a task …" / "list my tasks" (commands.js) and this tool therefore share ONE list. Completed tasks are moved to an archive key so completion leaves a record. ---- */
  const LK = 'alisa-lists', LIST = 'to-do', DK = 'alisa-agent-tasks-done', MAXT = 200;
  const lsRead = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsWrite = (k, v) => {
    const s = JSON.stringify(v);
    try { localStorage.setItem(k, s); } catch (e) { throw new ToolError('STORAGE_FAILED', 'localStorage write failed', 'I couldn’t save tasks on this device.'); }
    let back = null; try { back = localStorage.getItem(k); } catch (e) {}
    if (back !== s) throw new ToolError('STORAGE_FAILED', 'read-back mismatch', 'I couldn’t save tasks on this device.');
  };
  const readLists = () => { const o = lsRead(LK, {}); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; };
  const readTasks = () => { const a = readLists()[LIST]; return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; };
  const writeTasks = arr => { const o = readLists(); if (arr.length) o[LIST] = arr; else delete o[LIST]; lsWrite(LK, o); try { window.dispatchEvent(new window.CustomEvent('alisacommands:change')); } catch (e) {} };   // same event commands.js emits, so open UI refreshes
  const readDone = () => { const a = lsRead(DK, []); return Array.isArray(a) ? a : []; };
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  function resolveRef(list, ref) {
    const r = String(ref || '').trim().toLowerCase(); if (!r) throw new ToolError('INVALID_INPUT', 'ref required', 'Which task do you mean?');
    if (/^\d+$/.test(r)) { const i = +r - 1; if (!list[i]) throw new ToolError('NOT_FOUND', 'no such number', 'I couldn’t find task number ' + r + '.'); return i; }
    const ex = list.map((t, i) => same(t, r) ? i : -1).filter(i => i >= 0); if (ex.length === 1) return ex[0];
    const part = list.map((t, i) => t.toLowerCase().includes(r) ? i : -1).filter(i => i >= 0);
    if (part.length === 1) return part[0];
    if (part.length > 1) throw new ToolError('AMBIGUOUS', 'several matches', 'That matches ' + part.length + ' tasks. Say the task number instead.');
    throw new ToolError('NOT_FOUND', 'no match', 'I couldn’t find a task like that.');
  }
  tools.push({
    id: 'tasks.local', name: 'Local tasks', description: 'Create, list and complete tasks on your to-do list. Stored only on this device (the same list as “add a task…”).',
    category: 'tasks', riskLevel: 'LOW', permissions: ['tasks.local'],
    inputSchema: { type: 'object', required: ['action'], additionalProperties: false, properties: { action: S('string', { enum: ['create', 'list', 'complete'] }), title: S('string', { minLength: 1, maxLength: 120 }), ref: S('string', { minLength: 1, maxLength: 120 }) } },
    outputSchema: { type: 'object', required: ['action', 'count', 'text'], properties: { action: S('string'), count: S('number'), text: S('string'), task: S('object'), tasks: S('array'), duplicate: S('boolean') } },
    async execute(input) {
      const list = readTasks(), a = input.action;
      if (a === 'list') return { action: 'list', count: list.length, tasks: list.slice(0, 20).map((t, i) => ({ number: i + 1, title: t })), text: list.length ? 'You have ' + list.length + (list.length === 1 ? ' task: ' : ' tasks: ') + list.slice(0, 5).map((t, i) => (i + 1) + ', ' + t).join('; ') + (list.length > 5 ? '; and more.' : '.') : 'You have no tasks.' };
      if (a === 'create') {
        const title = String(input.title || '').replace(/\s+/g, ' ').trim(); if (!title) throw new ToolError('INVALID_INPUT', 'title required', 'What should the task be?');
        if (looksSecret(title)) throw new ToolError('REFUSED', 'secret-like task', REFUSAL);
        const at = list.findIndex(t => same(t, title)); if (at >= 0) return { action: 'create', count: list.length, task: { number: at + 1, title: list[at] }, duplicate: true, text: 'That’s already on your list.' };
        if (list.length >= MAXT) throw new ToolError('LIMIT', 'too many tasks', 'Your task list is full. Complete some first.');
        list.push(title); writeTasks(list);
        return { action: 'create', count: list.length, task: { number: list.length, title }, text: 'Task added: ' + title + '.' };
      }
      const i = resolveRef(list, input.ref), title = list[i]; list.splice(i, 1); writeTasks(list);
      const done = readDone(); done.push({ title, completedAt: new Date().toISOString() }); lsWrite(DK, done.slice(-MAXT));
      return { action: 'complete', count: list.length, task: { title }, text: 'Marked done: ' + title + '.' };
    },
    async verify(out) {   // re-read localStorage — the source of truth — instead of trusting the tool's own return value
      const list = readTasks();
      if (out.action === 'list') return { ok: list.length === out.count, detail: 'task count matches storage' };
      if (out.action === 'create') return { ok: list.some(t => same(t, out.task.title)), detail: 'task present in storage' };
      return { ok: !list.some(t => same(t, out.task.title)) && readDone().some(d => same(d.title, out.task.title)), detail: 'task removed from the list and archived' };
    },
  });

  function install(reg) { for (const t of tools) if (!reg.has(t.id)) reg.register({ ...t, builtin: true }); return reg.list().length; }
  window.ALISAAgentTools = { version: 1, install, math, fmtNum, ids: tools.map(t => t.id), tasks: { read: readTasks, listKey: LK, doneKey: DK } };
  if (R.default) install(R.default);
})();
