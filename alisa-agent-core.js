/* ALISA AGENT CORE (Phase 3.1) — window.ALISAAgentCore.process(request, context) → structured result
   Pipeline:  request → credential check → Intent → (tool needed?) → Planner → for each step: Tool Registry lookup → Resource check → Risk/Permission Gate
              (confirmation / authentication when required) → grant → Tool execution → Result VERIFICATION → structured result → (caller hands text to the Brain/voice).
   If no tool is needed the result is {handled:false, status:'NO_ACTION'} and the caller continues exactly as before (ALISA Brain answers) — the Agent Core never
   replaces the Brain for ordinary conversation.
   RESULT STATUS: SUCCESS · FAILED · PARTIAL · CANCELLED · REQUIRES_CONFIRMATION · REQUIRES_AUTHENTICATION · DENIED · NO_ACTION
   HONESTY RULE: the user-facing message is built ONLY from steps whose result passed verification. A tool error, a timeout, an invalid output or a failed
   verification can never produce a success message.
   NOT in this module on purpose: no way to grant permissions, install gate providers, edit risk policy or bypass the gate. Fields such as `permissions`,
   `grant`, `authenticated`, `confirmed` in the request context are ignored. Not autonomous: it only acts on one request at a time, with a bounded plan, and never loops. */
(() => {
  'use strict';
  const STATUSES = Object.freeze(['SUCCESS', 'FAILED', 'PARTIAL', 'CANCELLED', 'REQUIRES_CONFIRMATION', 'REQUIRES_AUTHENTICATION', 'DENIED', 'NO_ACTION']);
  const MAX_TEXT = 2000, HIST_MAX = 50;
  const history = [], active = new Map();
  const rid = () => 'r_' + Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  const LOG = () => window.ALISAAgentLog, REG = () => window.ALISAToolRegistry && window.ALISAToolRegistry.default;
  const REFUSAL = 'I won’t store or act on passwords or security credentials.';
  const FALLBACK_SECRET = /\b(?:password|passcode|passphrase|pin|otp|cvv|api[\s_-]?key|secret|token)\b\s*(?:is|are|=|:)|\b(?:sk|pk|ghp|xox[bp])[-_A-Za-z0-9]{12,}|\bBearer\s+\S{10,}|\b\d{13,19}\b/i;
  function isSensitive(text) {
    let checked = false;
    try { const MI = window.ALISAMemoryIntelligence; if (MI) { checked = true; if (MI.isSensitive(text)) return true; } } catch (e) { return true; }   // fail closed
    try { const M = window.ALISAMind; if (M) { checked = true; if (M.isSecret(text)) return true; } } catch (e) { return true; }
    return !checked && FALLBACK_SECRET.test(text);
  }
  const decorate = (msg, status) => { try { const P = window.ALISAPersonality; return P ? P.decorate(msg, { status }) : msg; } catch (e) { return msg; } };   // presentation only

  function blockedMessage(step, meta, reason) {
    const n = meta ? meta.name : 'that';
    switch (reason) {
      case 'tool_disabled': return 'The ' + n + ' tool is turned off.';
      case 'permission_missing': return 'I don’t have permission to use the ' + n + ' tool.';
      case 'risk_blocked': return 'That kind of action isn’t available yet.';
      case 'resource_limited': return 'I’m holding off on that for now to save power.';
      case 'confirmation_declined': return 'Okay, I won’t do that.';
      case 'authentication_failed': return 'I couldn’t verify you, so I didn’t do that.';
      default: return 'I wasn’t allowed to do that.';
    }
  }
  function failMessage(step, meta) {
    const n = meta ? meta.name : 'tool';
    if (step.reason === 'verification_failed') return 'I ran the ' + n + ' tool, but I couldn’t confirm the result, so I won’t say it worked.';
    if (step.userMessage) return step.userMessage;
    if (step.reason === 'TIMEOUT') return 'I couldn’t complete that because the ' + n + ' tool took too long.';
    if (step.reason === 'INVALID_INPUT') return 'I need a bit more detail to use the ' + n + ' tool.';
    return 'I couldn’t complete that because the ' + n + ' tool failed.';
  }

  async function process(request, context = {}) {
    const t0 = Date.now(), requestId = rid(), lg = (e, f) => { if (!context.internal) { try { LOG().log(e, { requestId, ...f }); } catch (x) {} } };
    const res = r => ({ requestId, durationMs: Date.now() - t0, ...r });
    const text = typeof request === 'string' ? request : request && typeof request.text === 'string' ? request.text : null;
    const source = ['voice', 'chat', 'api', 'selfcheck'].includes(context.source) ? context.source : 'api';
    if (text === null || !text.trim()) return res({ ok: false, status: 'NO_ACTION', handled: false, message: '', intent: 'unknown', confidence: 0, steps: [], completed: 0 });
    lg('request_received', { inputChars: text.length, source });
    if (text.length > MAX_TEXT) return res({ ok: false, status: 'NO_ACTION', handled: false, message: '', intent: 'unknown', confidence: 0, steps: [], completed: 0 });
    if (isSensitive(text)) { lg('request_blocked', { reason: 'sensitive_input', status: 'DENIED' }); return res({ ok: false, status: 'DENIED', handled: true, message: decorate(REFUSAL, 'DENIED'), intent: 'unknown', confidence: 1, riskLevel: 'SAFE', steps: [], completed: 0 }); }

    const reg = REG(), I = window.ALISAIntent, P = window.ALISAPlanner, G = window.ALISARiskGate;
    if (!reg || !I || !P || !G) return res({ ok: false, status: 'NO_ACTION', handled: false, message: '', intent: 'unknown', confidence: 0, steps: [], completed: 0 });
    let intent; try { intent = I.classify(text, { mindParse: context.mindParse }); } catch (e) { return res({ ok: false, status: 'NO_ACTION', handled: false, message: '', intent: 'unknown', confidence: 0, steps: [], completed: 0 }); }
    lg('intent_identified', { intent: intent.intent, confidence: intent.confidence, requiresTool: intent.requiresTool, tool: intent.tool || undefined, riskLevel: intent.riskLevel, requiresConfirmation: intent.requiresConfirmation, requiresAuthentication: intent.requiresAuthentication, compound: intent.compound });
    const base = { intent: intent.intent, confidence: intent.confidence, riskLevel: intent.riskLevel, requiresConfirmation: intent.requiresConfirmation, requiresAuthentication: intent.requiresAuthentication, steps: [], completed: 0, ...(context.debug ? { trace: { classification: intent } } : {}) };

    if (intent.unknownTool) { lg('result_received', { status: 'FAILED', reason: 'unknown_tool' }); return res({ ...base, ok: false, status: 'FAILED', handled: true, message: decorate('I don’t have a tool by that name. You can see what I can use in the Agent Center.', 'FAILED') }); }
    if (intent.unsupported) { lg('request_blocked', { reason: 'unsupported_capability', status: 'DENIED' }); return res({ ...base, ok: false, status: 'DENIED', handled: true, message: decorate('That kind of action isn’t something I can do through my agent tools yet.', 'DENIED') }); }
    if (!intent.requiresTool) { lg('result_received', { status: 'NO_ACTION' }); return res({ ...base, ok: true, status: 'NO_ACTION', handled: false, message: '' }); }

    const plan = P.plan(intent, text);
    if (!plan) return res({ ...base, ok: false, status: 'NO_ACTION', handled: false, message: '' });
    lg('plan_created', { planId: plan.id, stepCount: plan.steps.length, compound: intent.compound });
    active.set(requestId, plan);
    const aborted = () => plan.cancelled || !!(context.signal && context.signal.aborted);
    plan.status = 'RUNNING';
    try {
      for (const step of plan.steps) {
        if (aborted()) { plan.cancelled = true; break; }
        const meta = reg.get(step.tool);
        lg('tool_selected', { planId: plan.id, stepId: step.id, tool: step.tool });
        if (!meta) { step.status = 'FAILED'; step.reason = 'UNKNOWN_TOOL'; break; }
        let input; try { input = P.resolve(step.input, plan.steps); } catch (e) { step.status = 'FAILED'; step.reason = 'UNRESOLVED_REFERENCE'; break; }
        let resourceBlocked = false; try { const RS = window.ALISAResources; resourceBlocked = !!(meta.heavy && RS && !RS.policy().allowHeavyTools); } catch (e) {}
        const auth = await G.authorize(meta, { enabled: reg.isEnabled(meta.id), resourceBlocked });   // the ONLY door to execution
        lg('permission_checked', { planId: plan.id, stepId: step.id, tool: meta.id, riskLevel: auth.decision.riskLevel, decision: auth.decision.decision, status: auth.status, reason: auth.reason });
        if (auth.status !== 'OK') { step.status = 'BLOCKED'; step.block = auth.status; step.reason = auth.reason; break; }
        if (aborted()) { plan.cancelled = true; break; }
        step.status = 'RUNNING'; const ts = Date.now();
        let output;
        try { output = await reg.invoke(meta.id, input, auth.grant, { signal: context.signal }); }
        catch (e) { step.status = 'FAILED'; step.reason = String((e && e.code) || 'ERROR'); step.userMessage = e && e.userMessage || null; lg('tool_executed', { planId: plan.id, stepId: step.id, tool: meta.id, status: 'FAILED', reason: step.reason.slice(0, 40), durationMs: Date.now() - ts }); break; }
        lg('tool_executed', { planId: plan.id, stepId: step.id, tool: meta.id, status: 'SUCCESS', durationMs: Date.now() - ts });
        const v = await reg.verify(meta.id, input, output);   // never trust the tool's own say-so
        lg('verification_result', { planId: plan.id, stepId: step.id, tool: meta.id, verified: v.ok });
        if (!v.ok) { step.status = 'FAILED'; step.reason = 'verification_failed'; break; }
        step.status = 'SUCCESS'; step.verified = true; step.output = output;
        if (aborted()) { plan.cancelled = true; break; }
      }
      for (const s of plan.steps) if (s.status === 'PENDING') s.status = plan.cancelled ? 'CANCELLED' : 'SKIPPED';
    } finally { active.delete(requestId); }

    plan.status = P.summarize(plan);
    const done = plan.steps.filter(s => s.status === 'SUCCESS'), stop = plan.steps.find(s => !['SUCCESS', 'SKIPPED', 'CANCELLED'].includes(s.status));
    const stopMeta = stop ? reg.get(stop.tool) : null, doneText = done.map(s => s.output.text).filter(Boolean).join(' ');
    let message;
    switch (plan.status) {
      case 'SUCCESS': message = doneText; break;
      case 'CANCELLED': message = 'Okay, I stopped.' + (doneText ? ' Before that I finished: ' + doneText : ''); break;
      case 'REQUIRES_CONFIRMATION': message = 'I need your confirmation before I use the ' + (stopMeta ? stopMeta.name : 'that') + ' tool, so I haven’t done anything yet.' + (doneText ? ' Finished so far: ' + doneText : ''); break;
      case 'REQUIRES_AUTHENTICATION': message = 'That needs you to authenticate first, so I haven’t done it.' + (doneText ? ' Finished so far: ' + doneText : ''); break;
      case 'DENIED': message = blockedMessage(stop, stopMeta, stop && stop.reason); break;
      case 'PARTIAL': message = 'I only finished part of that (' + done.length + ' of ' + plan.steps.length + ' steps). ' + (doneText ? doneText + ' ' : '') + (stop && stop.status === 'BLOCKED' ? blockedMessage(stop, stopMeta, stop.reason) : 'The next step didn’t work: ' + failMessage(stop, stopMeta)); break;
      default: message = stop && stop.status === 'BLOCKED' ? blockedMessage(stop, stopMeta, stop.reason) : failMessage(stop || {}, stopMeta);
    }
    lg('plan_finished', { planId: plan.id, status: plan.status, completed: done.length, stepCount: plan.steps.length, durationMs: Date.now() - t0 });
    if (plan.cancelled) lg('plan_cancelled', { planId: plan.id, completed: done.length });
    lg('result_received', { planId: plan.id, status: plan.status });
    if (!context.internal) { history.push({ t: Date.now(), requestId, intent: intent.intent, tools: plan.steps.map(s => s.tool), status: plan.status, riskLevel: intent.riskLevel }); if (history.length > HIST_MAX) history.shift(); }
    return res({
      ...base, ok: plan.status === 'SUCCESS', status: plan.status, handled: true, planId: plan.id, completed: done.length,
      message: decorate(message, plan.status),
      steps: plan.steps.map(s => ({ tool: s.tool, status: s.status, verified: s.verified === true, ...(s.reason ? { reason: s.reason } : {}) })),
      ...(plan.status === 'SUCCESS' ? { data: Object.fromEntries(done.map(s => [s.tool, s.output])) } : {}),
      ...(context.debug ? { trace: { classification: intent, plan: { id: plan.id, status: plan.status } } } : {}),
    });
  }
  function cancel(requestId) { const p = active.get(requestId); if (!p) return false; p.cancelled = true; return true; }

  // End-to-end self-test through the REAL pipeline (time tool: read-only, no side effects) + proof that the gate cannot be bypassed.
  async function selfCheck() {
    try {
      const reg = REG(); if (!reg || !window.ALISARiskGate || !window.ALISAIntent || !window.ALISAPlanner) return { ok: false, detail: 'a required module is missing' };
      let bypass = false; try { await reg.invoke('time.now', {}, null); bypass = true; } catch (e) { bypass = e && e.code !== 'NO_GRANT'; }
      if (bypass) return { ok: false, detail: 'tool ran without a gate grant' };
      if (!reg.has('time.now') || !reg.isEnabled('time.now')) return { ok: true, detail: 'pipeline modules loaded; time tool disabled so no end-to-end run' };
      const r = await process('what time is it', { source: 'selfcheck', internal: true });
      const ok = r.status === 'SUCCESS' && r.steps.length === 1 && r.steps[0].verified === true;
      try { LOG().log('self_check', { status: ok ? 'SUCCESS' : 'FAILED' }); } catch (e) {}
      return ok ? { ok: true, detail: 'end-to-end check passed · gate refuses ungranted calls' } : { ok: false, detail: 'end-to-end check returned ' + r.status };
    } catch (e) { return { ok: false, detail: 'self-check crashed: ' + String(e && (e.code || e.message)).slice(0, 50) }; }
  }
  function describeTools() {
    const reg = REG(), G = window.ALISARiskGate; if (!reg || !G) return [];
    return reg.list().map(m => { const ev = G.evaluate(m, { enabled: m.enabled }), rq = G.requirements(m); return { id: m.id, name: m.name, description: m.description, category: m.category, riskLevel: rq.riskLevel, permissions: [...m.permissions], enabled: m.enabled, requiresConfirmation: rq.requiresConfirmation, requiresAuthentication: rq.requiresAuthentication, runsAutomatically: ev.decision === 'ALLOW', builtin: m.builtin }; });
  }
  window.ALISAAgentCore = Object.freeze({
    version: 1, STATUSES, process, cancel, selfCheck, describeTools,
    active: () => [...active.keys()],
    history: () => history.map(h => ({ ...h, tools: [...h.tools] })),
  });
})();
