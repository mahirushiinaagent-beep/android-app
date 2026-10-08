/* ALISA RISK + PERMISSION GATE (Phase 3.1) — the ONE place that decides whether a tool may run. window.ALISARiskGate
   Flow:  tool metadata → effective risk → enabled? → permissions? → confirmation (if required) → authentication (if required) → one-time GRANT → execution.
   Rules this module enforces:
   - Risk can only be RAISED by policy, never lowered by a tool: effective risk = max(tool's declared risk, floor of its category).
   - A tool cannot run without a one-time grant minted here (the registry refuses invoke() otherwise), so tools and the Agent Core cannot bypass the gate.
   - The Agent Core has no way to grant permissions, install providers or edit policy; request context is ignored for security decisions.
   - Confirmation / authentication are answered by HOST-installed providers (UI / ALISASecurity). With no provider installed the answer is
     REQUIRES_CONFIRMATION / REQUIRES_AUTHENTICATION and nothing runs. A provider must return exactly `true`; errors and anything else fail closed.
   - Personality / mood is never an input here.
   LIMITS (honest): this is an in-page JavaScript boundary. Same-origin scripts are trusted. Real enforcement for future Android control must live in native code. */
(() => {
  'use strict';
  const LEVELS = Object.freeze(['SAFE', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL']);
  const rank = l => LEVELS.indexOf(l);
  // What each level demands. CRITICAL is not executable at all in Phase 3.1 (no tool may run at CRITICAL, even confirmed + authenticated).
  const POLICY = Object.freeze({
    SAFE: Object.freeze({ confirm: false, auth: false, executable: true }),
    LOW: Object.freeze({ confirm: false, auth: false, executable: true }),
    MODERATE: Object.freeze({ confirm: true, auth: false, executable: true }),
    HIGH: Object.freeze({ confirm: true, auth: true, executable: true }),
    CRITICAL: Object.freeze({ confirm: true, auth: true, executable: false }),
  });
  // A tool in one of these categories cannot declare a lower risk than the floor (checked at registration AND at evaluation).
  const CATEGORY_FLOOR = Object.freeze({
    communication: 'HIGH', device: 'HIGH', android: 'HIGH', web_automation: 'HIGH', security: 'HIGH',
    finance: 'CRITICAL', account: 'CRITICAL', files_destructive: 'CRITICAL',
  });
  // Permissions granted by default in Phase 3.1: local, read-mostly capabilities only.
  const BASELINE = Object.freeze(['memory.read', 'memory.write.local', 'knowledge.read', 'time.read', 'math.compute', 'system.diagnostics.read', 'tasks.local']);
  const granted = new Set(BASELINE);
  const providers = { confirm: null, authenticate: null };
  const issued = new Map();   // grant object → {toolId, exp}
  const GRANT_MS = 30000;

  const effectiveRisk = meta => {
    const declared = rank(meta && meta.riskLevel) < 0 ? 'CRITICAL' : meta.riskLevel;   // unknown level → treated as the most dangerous
    const floor = CATEGORY_FLOOR[meta && meta.category];
    return floor && rank(floor) > rank(declared) ? floor : declared;
  };
  const requirements = meta => {
    const risk = effectiveRisk(meta), p = POLICY[risk];
    return { riskLevel: risk, requiresConfirmation: p.confirm || !!(meta && meta.requiresConfirmation), requiresAuthentication: p.auth || !!(meta && meta.requiresAuthentication), executable: p.executable };
  };
  const missing = meta => (meta && Array.isArray(meta.permissions) ? meta.permissions : []).filter(p => !granted.has(p));

  // Pure/synchronous pre-check. decision: ALLOW | REQUIRE_CONFIRMATION | REQUIRE_AUTHENTICATION | DENY
  function evaluate(meta, state = {}) {
    if (!meta) return { decision: 'DENY', reason: 'unknown_tool', riskLevel: 'CRITICAL', requiresConfirmation: true, requiresAuthentication: true, missingPermissions: [] };
    const r = requirements(meta), m = missing(meta), base = { riskLevel: r.riskLevel, requiresConfirmation: r.requiresConfirmation, requiresAuthentication: r.requiresAuthentication, missingPermissions: m };
    if (meta.enabled === false || state.enabled === false) return { ...base, decision: 'DENY', reason: 'tool_disabled' };
    if (!r.executable) return { ...base, decision: 'DENY', reason: 'risk_blocked' };
    if (m.length) return { ...base, decision: 'DENY', reason: 'permission_missing' };
    if (state.resourceBlocked) return { ...base, decision: 'DENY', reason: 'resource_limited' };   // resources can only restrict, never grant
    if (r.requiresConfirmation) return { ...base, decision: 'REQUIRE_CONFIRMATION', reason: 'confirmation_required' };
    if (r.requiresAuthentication) return { ...base, decision: 'REQUIRE_AUTHENTICATION', reason: 'authentication_required' };
    return { ...base, decision: 'ALLOW', reason: 'ok' };
  }
  async function ask(fn, summary) {
    try { return (await fn(summary)) === true; } catch (e) { return false; }   // fail closed
  }
  // Full authorization. Resolves {status, reason, decision, grant?}.
  // status: OK | DENIED | CANCELLED | REQUIRES_CONFIRMATION | REQUIRES_AUTHENTICATION
  async function authorize(meta, ctx = {}) {
    const ev = evaluate(meta, { enabled: ctx.enabled, resourceBlocked: ctx.resourceBlocked }), out = r => ({ decision: ev, ...r });
    if (ev.decision === 'DENY') return out({ status: 'DENIED', reason: ev.reason });
    const summary = Object.freeze({ toolId: meta.id, toolName: meta.name, riskLevel: ev.riskLevel });   // metadata only — no user text
    if (ev.requiresConfirmation) {
      if (!providers.confirm) return out({ status: 'REQUIRES_CONFIRMATION', reason: 'confirmation_required' });
      if (!(await ask(providers.confirm, summary))) return out({ status: 'CANCELLED', reason: 'confirmation_declined' });
    }
    if (ev.requiresAuthentication) {
      if (!providers.authenticate) return out({ status: 'REQUIRES_AUTHENTICATION', reason: 'authentication_required' });
      if (!(await ask(providers.authenticate, summary))) return out({ status: 'DENIED', reason: 'authentication_failed' });
    }
    const grant = Object.freeze({ toolId: meta.id, nonce: Math.random().toString(36).slice(2) + Date.now().toString(36) });
    issued.set(grant, { toolId: meta.id, exp: Date.now() + GRANT_MS });
    return out({ status: 'OK', reason: 'ok', grant });
  }
  // Called by the registry right before execute(). One use, short-lived, bound to one tool id.
  function consume(grant, toolId) {
    const g = grant && issued.get(grant); if (!g) return false;
    issued.delete(grant);
    return g.toolId === toolId && g.exp >= Date.now();
  }
  const EVIDENCE = new Set(['settings-ui', 'security-auth']);
  window.ALISARiskGate = {
    version: 1, LEVELS, POLICY, CATEGORY_FLOOR, BASELINE,
    rank, effectiveRisk, requirements, evaluate, authorize, consume,
    compare: (a, b) => rank(a) - rank(b),
    // Host-only wiring. NOT exposed through the Agent Core. Providers are installed once; they cannot be silently replaced.
    setProviders(p) { if (!p || typeof p !== 'object') return false; for (const k of ['confirm', 'authenticate']) if (typeof p[k] === 'function' && !providers[k]) providers[k] = p[k]; return true; },
    hasProvider: k => !!providers[k],
    // A permission outside the baseline can only be granted with explicit evidence that a human did it (settings UI or security authentication).
    grantPermission(name, evidence) { if (!evidence || evidence.by !== 'user' || !EVIDENCE.has(evidence.via) || typeof name !== 'string' || !/^[a-z][a-z0-9_.]{1,40}$/.test(name)) return false; granted.add(name); return true; },
    revokePermission(name) { if (BASELINE.includes(name)) return false; return granted.delete(name); },
    permissions: () => [...granted],
  };
})();
