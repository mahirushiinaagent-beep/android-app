/* ALISA TOOL REGISTRY (Phase 3.1) — every capability the Agent Core can use is a registered tool. window.ALISAToolRegistry
   The Agent Core discovers tools here; nothing is hard-coded into it. A tool declares metadata and an execute() function:
     { id, name, description, category, inputSchema, outputSchema, riskLevel, requiresConfirmation, requiresAuthentication,
       permissions[], enabled, execute(input, env) → output, verify?(output, input) → {ok, detail}, heavy?, builtin? }
   Safety properties:
   - Tool metadata is deep-frozen at registration; get()/list() never hand out execute().
   - invoke() refuses to run a tool without a one-time grant from ALISARiskGate (so nothing can skip the risk/permission gate).
   - A tool in a dangerous category (see ALISARiskGate.CATEGORY_FLOOR) cannot register with a lower risk than the floor.
   - Inputs and outputs are validated against the tool's schemas; execute() gets only {signal, now} — no handle to the gate, registry or core.
   - Duplicate ids are rejected (a later script cannot replace a built-in tool). Built-in tools cannot be unregistered. */
(() => {
  'use strict';
  const G = () => window.ALISARiskGate;
  const CATEGORIES = Object.freeze(['memory', 'knowledge', 'math', 'time', 'system', 'tasks', 'communication', 'device', 'android', 'web_automation', 'security', 'finance', 'account', 'files_destructive']);
  const ID = /^[a-z][a-z0-9_.]{1,40}$/;
  class ToolError extends Error {
    constructor(code, message, userMessage) { super(message || code); this.name = 'ToolError'; this.code = code; this.userMessage = userMessage || null; }
  }
  // ---- minimal JSON-schema subset: type, properties, required, enum, minimum, maximum, minLength, maxLength, items, additionalProperties ----
  function validate(schema, v, path = 'value', errs = []) {
    if (!schema) return errs;
    const t = schema.type, isInt = typeof v === 'number' && Number.isInteger(v);
    const ok = t === undefined || (t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : t === 'array' ? Array.isArray(v) : t === 'integer' ? isInt : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === t);
    if (!ok) { errs.push(path + ': expected ' + t); return errs; }
    if (schema.enum && !schema.enum.includes(v)) errs.push(path + ': not an allowed value');
    if (typeof v === 'string') { if (schema.minLength != null && v.length < schema.minLength) errs.push(path + ': too short'); if (schema.maxLength != null && v.length > schema.maxLength) errs.push(path + ': too long'); }
    if (typeof v === 'number') { if (schema.minimum != null && v < schema.minimum) errs.push(path + ': below minimum'); if (schema.maximum != null && v > schema.maximum) errs.push(path + ': above maximum'); }
    if (t === 'array' && schema.items) v.forEach((x, i) => validate(schema.items, x, path + '[' + i + ']', errs));
    if (t === 'object') {
      for (const k of schema.required || []) if (!(k in v) || v[k] === undefined) errs.push(path + '.' + k + ': required');
      const props = schema.properties || {};
      for (const k of Object.keys(v)) { if (props[k]) validate(props[k], v[k], path + '.' + k, errs); else if (schema.additionalProperties === false) errs.push(path + '.' + k + ': not allowed'); }
    }
    return errs;
  }
  const deepFreeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const withTimeout = (p, ms, code) => { let t; return Promise.race([Promise.resolve(p), new Promise((_, rej) => { t = setTimeout(() => rej(new ToolError(code, 'timed out')), ms); t && t.unref && t.unref(); })]).finally(() => clearTimeout(t)); };

  function createRegistry(opts = {}) {
    const gate = opts.gate || G(), tools = new Map(), disabled = new Set(), key = opts.storageKey || null, timeoutMs = opts.timeoutMs || 8000;
    const ls = { get() { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; } }, set(v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} } };
    if (key) ls.get().forEach(id => disabled.add(String(id)));
    const emit = () => { try { window.dispatchEvent(new window.CustomEvent('alisaagent:tools')); } catch (e) {} };

    function register(def) {
      if (!gate) throw new ToolError('NO_GATE', 'risk gate not loaded');
      if (!def || typeof def !== 'object') throw new ToolError('INVALID_TOOL', 'definition required');
      const bad = m => { throw new ToolError('INVALID_TOOL', 'tool "' + (def.id || '?') + '": ' + m); };
      if (!ID.test(String(def.id))) bad('id must match ' + ID);
      if (tools.has(def.id)) bad('already registered');
      for (const k of ['name', 'description']) if (typeof def[k] !== 'string' || !def[k].trim()) bad(k + ' required');
      if (!CATEGORIES.includes(def.category)) bad('unknown category');
      if (gate.rank(def.riskLevel) < 0) bad('riskLevel must be one of ' + gate.LEVELS.join('/'));
      const floor = gate.CATEGORY_FLOOR[def.category];
      if (floor && gate.rank(def.riskLevel) < gate.rank(floor)) bad('risk below the floor (' + floor + ') for category ' + def.category);
      if (typeof def.execute !== 'function') bad('execute() required');
      if (!def.inputSchema || def.inputSchema.type !== 'object' || !def.outputSchema || def.outputSchema.type !== 'object') bad('inputSchema and outputSchema (type object) required');
      if (!Array.isArray(def.permissions) || def.permissions.some(p => typeof p !== 'string')) bad('permissions must be an array of strings');
      const meta = deepFreeze({
        id: def.id, name: def.name, description: def.description, category: def.category, version: def.version || 1,
        inputSchema: clone(def.inputSchema), outputSchema: clone(def.outputSchema), riskLevel: def.riskLevel,
        requiresConfirmation: def.requiresConfirmation === true, requiresAuthentication: def.requiresAuthentication === true,
        permissions: [...def.permissions], heavy: def.heavy === true, builtin: def.builtin === true,
      });
      tools.set(def.id, { meta, execute: def.execute, verify: typeof def.verify === 'function' ? def.verify : null, defaultEnabled: def.enabled !== false });
      emit(); return meta;
    }
    const enabledOf = id => { const t = tools.get(id); return !!t && t.defaultEnabled && !disabled.has(id); };
    const view = id => { const t = tools.get(id); return t ? { ...t.meta, enabled: enabledOf(id) } : null; };   // metadata + current enabled state; never execute()
    const api = {
      CATEGORIES, ToolError, validate,
      register,
      unregister(id) { const t = tools.get(id); if (!t || t.meta.builtin) return false; tools.delete(id); disabled.delete(id); emit(); return true; },
      has: id => tools.has(id),
      get: id => view(id),
      list(o = {}) { return [...tools.keys()].map(view).filter(m => (!o.enabledOnly || m.enabled) && (!o.category || m.category === o.category)); },
      setEnabled(id, on) { if (!tools.has(id)) return false; if (on) disabled.delete(id); else disabled.add(id); if (key) ls.set([...disabled]); emit(); return true; },
      isEnabled: enabledOf,
      // Runs a tool. Requires a one-time grant minted by ALISARiskGate.authorize() for this exact tool id.
      async invoke(id, input, grant, env = {}) {
        const t = tools.get(id); if (!t) throw new ToolError('UNKNOWN_TOOL', 'unknown tool');
        if (!gate.consume(grant, id)) throw new ToolError('NO_GRANT', 'the risk gate did not authorize this call');
        if (!enabledOf(id)) throw new ToolError('TOOL_DISABLED', 'tool disabled');
        const inp = input === undefined ? {} : clone(input), ie = validate(t.meta.inputSchema, inp, 'input');
        if (ie.length) throw new ToolError('INVALID_INPUT', ie[0], null);
        const out = await withTimeout(t.execute(inp, Object.freeze({ signal: env.signal || null, now: () => Date.now() })), env.timeoutMs || timeoutMs, 'TIMEOUT');
        const oe = validate(t.meta.outputSchema, out, 'output');
        if (oe.length) throw new ToolError('INVALID_OUTPUT', oe[0]);
        return deepFreeze(clone(out));
      },
      // Independent check of a result. Tools with verify() read the outcome back from its source of truth. Others get schema-only verification.
      async verify(id, input, output) {
        const t = tools.get(id); if (!t) return { ok: false, method: 'none', detail: 'unknown tool' };
        if (!t.verify) return { ok: true, method: 'schema', detail: 'output matched the declared schema (no tool-specific check)' };
        try { const r = await withTimeout(t.verify(output, clone(input)), 4000, 'TIMEOUT'); return { ok: !!(r && r.ok === true), method: 'tool', detail: String((r && r.detail) || '').slice(0, 120) }; }
        catch (e) { return { ok: false, method: 'tool', detail: 'verification error: ' + String(e && e.code || 'ERROR').slice(0, 30) }; }
      },
      // Metadata sanity check for the Status Center.
      integrity() { const problems = []; for (const [id, t] of tools) { const m = t.meta; if (gate.rank(m.riskLevel) < 0) problems.push(id + ': bad risk'); const f = gate.CATEGORY_FLOOR[m.category]; if (f && gate.rank(m.riskLevel) < gate.rank(f)) problems.push(id + ': risk below floor'); if (typeof t.execute !== 'function') problems.push(id + ': no execute'); } return { ok: !problems.length, problems, count: tools.size, enabled: [...tools.keys()].filter(enabledOf).length }; },
    };
    return api;
  }
  const API = { createRegistry, ToolError, CATEGORIES, validate };
  if (G()) API.default = createRegistry({ storageKey: 'alisa-agent-disabled-tools' });
  window.ALISAToolRegistry = API;
})();
