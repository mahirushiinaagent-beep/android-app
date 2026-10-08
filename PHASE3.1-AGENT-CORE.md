# ALISA Phase 3.1 — Agent Core Foundation

**Status: DEVELOPMENT BUILD — not stable.** All automated tests pass; real-device validation has **not** been done yet (see the checklist at the end). The baseline `alisa-pwa-phase2.5-fixed.zip` was not modified; this is a separate copy.

## Architecture

```
User (voice / chat)
 ↓  existing Phase 2.5 handlers run FIRST and are unchanged:
 ↓  credential stop → Brain control ("online mode") → ALISACommands → Memory commands → voice-security gate
 ↓  only if none of them claimed the request:
Intent Understanding   alisa-intent.js
 ↓
Agent Core             alisa-agent-core.js      process(request, context)
 ↓
Planner                alisa-planner.js         bounded, linear, ≤5 steps, no loops
 ↓
Tool Registry          alisa-tool-registry.js   tools discovered here, never hard-coded in the core
 ↓
Risk / Permission Gate alisa-risk-gate.js       the ONLY door to execution (one-time grants)
 ↓
Tool execution         alisa-agent-tools.js     validated input/output, timeout
 ↓
Result verification    independent re-check of the outcome (read-back / second evaluator)
 ↓
structured result → spoken / shown.  If no tool applies → {handled:false} → ALISA Brain answers exactly as in Phase 2.5.
```

Supporting modules: `alisa-agent-log.js` (privacy-safe log), `alisa-status.js` (Status Center), `alisa-personality.js` (mood foundation), `alisa-resources.js` (resource foundation), `alisa-agent-ui.js` (Agent Center + status rows).

## Files

**New modules (11):** alisa-agent-log, alisa-risk-gate, alisa-tool-registry, alisa-agent-tools, alisa-intent, alisa-planner, alisa-personality, alisa-resources, alisa-status, alisa-agent-core, alisa-agent-ui (`.js`).
**New tests:** `test/agent-env.js`, `risk-gate`, `tool-registry`, `agent-tools`, `agent-core`, `agent-log-privacy`, `agent-status`, `personality`, `agent-wiring` (`.test.js`), `test/agent-ui.test.py`.
**Modified (3):** `index.html` (script tags; Agent Center + Status wiring; agent route; mood sync), `sw.js` (cache `alisa-v13`→`v14`, 11 files added), `server.js` (allow-list +11 files). `package.json`: version + a `test:browser` script only.
**All other Phase 2.5 files are byte-identical** (a test enforces this in the build workspace).

## Agent Core API

`await ALISAAgentCore.process(text, {source:'voice'|'chat'|'api', signal?, debug?})` →

```
{ requestId, status, ok, handled, intent, confidence, riskLevel, requiresConfirmation, requiresAuthentication,
  message, steps:[{tool,status,verified,reason?}], completed, data?, durationMs }
```
`status`: SUCCESS · FAILED · PARTIAL · CANCELLED · REQUIRES_CONFIRMATION · REQUIRES_AUTHENTICATION · DENIED · NO_ACTION.
Also `cancel(requestId)`, `selfCheck()`, `describeTools()`, `history()` (tool ids + outcome only). The object is frozen and exposes **no** way to grant permissions, install gate providers or edit policy.

**Honesty rule:** `message` is built only from steps that passed verification. A tool error, timeout, malformed output or failed verification can never produce a success message (tested in every mood too).

**Intents:** conversation · question · memory · knowledge · task · planning · calculation · time · diagnostics · tool_request · unknown. Layered scoring plus real parsing (a "calculation" must parse as maths; "what time did Rome fall" is not a time request) with the existing Mind grammar as extra evidence. Confidence < 0.6 ⇒ no tool, request continues to the Brain. The tool, risk and confirmation come from a fixed intent→tool map and the registry/gate — never from the text. An optional model hint (`setModelClassifier`, **off by default**) may only relabel an uncertain request; it cannot pick a tool, choose memory/task/tool_request, or change risk.

**Planner:** one multi-step template today — "*calculate … and remember the result*" → calculator → verify → memory.save (result passed by a safe `${steps.N.output.field}` lookup, no code). Hard limit 5 steps, strictly sequential; tool output can never add steps. Cancellation via abort signal / `cancel()` between steps.

## Tool Registry

`ALISAToolRegistry.default` — `register(def)`, `get/list` (metadata only, frozen, never `execute`), `setEnabled` (persisted in `alisa-agent-disabled-tools`), `invoke(id,input,grant)` (requires a gate grant), `verify`, `integrity`.
Definition: `id, name, description, category, inputSchema, outputSchema, riskLevel, requiresConfirmation, requiresAuthentication, permissions[], enabled, heavy?, execute(input,{signal,now}), verify?(output,input)`.
Rules: ids unique (built-ins cannot be replaced or unregistered); categories communication/device/android/web_automation/security have a HIGH floor and finance/account/files_destructive a CRITICAL floor — a tool cannot register below its floor; `execute()` gets no handle to the gate, registry or core.

| Tool | Risk | Permission | What it does | Verified by |
|---|---|---|---|---|
| memory.search | SAFE | memory.read | existing ALISAMind search; private memories never returned | each result re-read from the store |
| memory.save | LOW | memory.write.local | existing `remember` path (credential filter, dedupe) | read-back from the store |
| knowledge.search | SAFE | knowledge.read | existing retrieval (semantic only when really available, else keyword; says which) | results re-read from the store |
| calculator.evaluate | SAFE | math.compute | hand-written parser, **no eval / Function** | second, independently written evaluator |
| time.now | SAFE | time.read | device clock via Intl, optional IANA zone | timestamp consistency |
| diagnostics.report | SAFE | system.diagnostics.read | real module health (Status Center) | state validity, overall = worst |
| tasks.local | LOW | tasks.local | create/list/complete on the **existing** to-do list (`alisa-lists`→`to-do`); done tasks archived in `alisa-agent-tasks-done` | localStorage re-read |

## Risk / permission model

SAFE < LOW < MODERATE < HIGH < CRITICAL. SAFE/LOW run automatically; MODERATE needs confirmation; HIGH needs confirmation **and** authentication; CRITICAL is not executable in 3.1. Effective risk = max(declared, category floor); an unknown level counts as CRITICAL. Order: enabled? → permissions granted? → resource limits (can only restrict) → confirmation → authentication → one-time, 30 s, tool-bound grant. Confirmation/authentication come from host-installed providers (none installed in 3.1 ⇒ `REQUIRES_CONFIRMATION` / `REQUIRES_AUTHENTICATION`, nothing runs). Providers must return exactly `true` (anything else fails closed), receive metadata only (never user text), and can be installed only once. Permissions beyond the baseline need evidence that a human granted them. Personality/mood is not an input to the gate (its source cannot reference it).

## Status Center

`ALISAStatus.snapshot({deep?})` covers Brain, Memory, Retrieval, Semantic, Knowledge, Security, Agent Core, Tool Registry. States: HEALTHY · READY · WARNING · ERROR · DISABLED · NOT_AVAILABLE · NOT_TESTED. `tested:true` only when a probe actually exercised something; otherwise the row is labelled self-reported. Nothing runs on a timer — a check happens when the Status screen opens or "Run full check" is tapped. The default check does not wake the speaker model; the full check may.

## Tests

`npm test` → **356/356** (211 Phase 2.5 + 145 new). `python3 test/pin.test.py . code` → 31/31. `python3 test/agent-ui.test.py .` → 59/59 (real Chromium, 393×851 phone viewport). Mutation-checked: 8 deliberate regressions (log accepting free text, skipped verification, skipped grant check, failure dressed as success, MODERATE without confirmation, secret check off, category floor removed, faked HEALTHY) are each caught by the suite.

## Limitations and warnings

1. **Real-device validation is outstanding.** Do not call this stable until the checklist below passes.
2. **The gate is an in-page JavaScript boundary.** Same-origin scripts are trusted. Real enforcement for Android control must live in native code (a later phase).
3. **No confirmation/authentication UI yet.** The gate supports it; with no provider installed any MODERATE+ tool refuses. No such tool exists in 3.1.
4. **Intent understanding is local rules/scoring, English-centric** (plus a few Hindi time phrases) — not an LLM. Anything unrecognised goes to the Brain as before.
5. **Routing:** on voice, existing commands (timers, lists, calculator, time) still run first, so the agent mainly adds memory/knowledge search, diagnostics, explicit tool use and multi-step plans. In typed chat the agent also answers time/calculation/task requests directly (Phase 2.5 only sent those to the Brain, which says "asleep" when signed out). Kill switch: `localStorage['alisa-agent']='0'`.
6. The agent log is RAM-only, bounded to 200 entries; free text can never enter it.
7. The Agent Center only toggles tools; there are no dangerous controls. The orb labels for "Agents" and the dock caption changed (the old hard-coded "All systems active" claim is gone).
8. Other pre-existing demo panels (Daily Report, Memory Network "2.4M", Communications…) are still static placeholder visuals from earlier phases — untouched and not real data.
9. The Phase 2.5 popup panels visually overlap an open sheet (existing behaviour).

## Device test checklist

Start app · voice works · memory commands work · semantic retrieval · PIN/security · then in chat/voice: "what time is it", "calculate 25 times 18 and remember the result", "what do you remember about 450", "search my notes for …", "add task …" / "list my tasks" / "complete task 1", "run diagnostics" · Settings → Quick access → Agents, toggle a tool off/on · taskbar Status shows the health rows, "Run full check" · no heat/battery drain after 10 min idle · close and reopen (service worker `alisa-v14` installs; if the old UI shows, clear site data once).
