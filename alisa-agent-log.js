/* ALISA AGENT LOG (Phase 3.1) — concise, structured, in-memory operational log for the Agent Core. window.ALISAAgentLog
   PRIVACY BY CONSTRUCTION: only allow-listed field names are kept, and only short identifier-like values (ids, enum tokens, numbers, booleans).
   Free text (what the user said, tool inputs/outputs, error messages) can NEVER enter the log: it is dropped, not redacted-in-place.
   Every kept string is also run through the Phase 2.5 credential filter. The log is RAM only (a page reload clears it) — nothing is persisted or sent anywhere. */
(() => {
  'use strict';
  const MAX = 200;
  // field name → kind. Anything not listed here is dropped.
  const FIELDS = {
    requestId: 'id', planId: 'id', stepId: 'id',
    intent: 'tok', tool: 'tok', riskLevel: 'tok', decision: 'tok', status: 'tok', reason: 'tok', source: 'tok', mood: 'tok',
    confidence: 'num', durationMs: 'num', inputChars: 'num', stepCount: 'num', completed: 'num',
    verified: 'bool', requiresTool: 'bool', requiresConfirmation: 'bool', requiresAuthentication: 'bool', compound: 'bool',
  };
  const TOK = /^[A-Za-z0-9_.:-]{1,40}$/, ID = /^[a-z]{1,3}_[a-z0-9]{6,16}$/, LONG_DIGITS = /\d{6,}/;
  const EVENTS = new Set(['request_received', 'intent_identified', 'plan_created', 'tool_selected', 'permission_checked', 'tool_executed',
    'result_received', 'verification_result', 'plan_finished', 'request_blocked', 'plan_cancelled', 'self_check']);
  const buf = []; let seq = 0, dropped = 0;

  function sensitive(s) {
    try { const MI = window.ALISAMemoryIntelligence; if (MI && MI.isSensitive(s)) return true; } catch (e) { return true; }   // fail closed
    try { const M = window.ALISAMind; if (M && M.isSecret(s)) return true; } catch (e) { return true; }
    return LONG_DIGITS.test(s);
  }
  function clean(kind, v) {
    if (kind === 'num') return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : undefined;
    if (kind === 'bool') return typeof v === 'boolean' ? v : undefined;
    if (typeof v !== 'string') return undefined;
    if (kind === 'id') return ID.test(v) ? v : undefined;
    return TOK.test(v) && !sensitive(v) ? v : undefined;
  }
  function sanitize(fields) {
    const out = {}; let d = 0;
    for (const k of Object.keys(fields || {})) {
      if (fields[k] === undefined || fields[k] === null) continue;   // absent optional field: not a drop
      const kind = FIELDS[k]; const v = kind ? clean(kind, fields[k]) : undefined;
      if (v === undefined) { d++; continue; }
      out[k] = v;
    }
    return { out, dropped: d };
  }
  function log(event, fields) {
    const ev = TOK.test(String(event)) && EVENTS.has(event) ? event : 'unknown_event';
    const { out, dropped: d } = sanitize(fields); dropped += d;
    const entry = Object.freeze({ seq: ++seq, t: Date.now(), event: ev, ...out, ...(d ? { droppedFields: d } : {}) });
    buf.push(entry); if (buf.length > MAX) buf.shift();
    try { window.dispatchEvent(new window.CustomEvent('alisaagent:log', { detail: { seq: entry.seq, event: ev } })); } catch (e) {}
    return entry;
  }
  window.ALISAAgentLog = {
    version: 1, MAX, EVENTS: [...EVENTS], log,
    recent: (n = 20) => buf.slice(-Math.max(0, n)),
    byRequest: id => buf.filter(e => e.requestId === id),
    clear: () => { buf.length = 0; },
    stats: () => ({ entries: buf.length, dropped, max: MAX }),
    _sanitize: sanitize,
  };
})();
