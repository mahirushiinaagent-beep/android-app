/* ALISA INTENT UNDERSTANDING (Phase 3.1) — window.ALISAIntent.classify(text, context) → structured result
   {intent, confidence, requiresTool, tool, params, riskLevel, requiresConfirmation, requiresAuthentication, compound, alternatives[], source}
   intents: conversation · question · memory · knowledge · task · planning · calculation · time · diagnostics · tool_request · unknown
   HOW IT DECIDES (honest description — this is local scoring, not an LLM):
     1. Several independent detectors each score their intent 0..1. Structural detectors do real parsing (a text is only a "calculation" if the maths parser
        accepts it; a time question must match a time-question shape), not just "contains the word 'time'".
     2. The existing ALISA parsers are consulted as extra evidence (ALISAMind.commands.parse for memory/notes grammar).
     3. Specific intents outrank generic ones (question / conversation). Confidence = top score − 0.3 × runner-up. Below 0.6 → no tool is used and the request
        simply goes on to the ALISA Brain (the LLM) as before.
     4. The tool, risk level and confirmation requirement are NEVER taken from the text or from a classifier: the tool id comes from a fixed intent→tool mapping
        (or an explicit "use the X tool" request that must match a registered tool), and risk/confirmation are read from the registry + risk gate.
   An optional model classifier can be installed with setModelClassifier(fn). It is OFF by default (nothing is sent to any model by this module) and, if used, can
   only suggest an intent label from the list above — it can never choose a tool, change risk, or skip confirmation. */
(() => {
  'use strict';
  const INTENTS = Object.freeze(['conversation', 'question', 'memory', 'knowledge', 'task', 'planning', 'calculation', 'time', 'diagnostics', 'tool_request', 'unknown']);
  const THRESHOLD = 0.6;
  let modelClassifier = null;
  const ZONES = { london: 'Europe/London', paris: 'Europe/Paris', berlin: 'Europe/Berlin', 'new york': 'America/New_York', 'los angeles': 'America/Los_Angeles', chicago: 'America/Chicago', tokyo: 'Asia/Tokyo', dubai: 'Asia/Dubai', delhi: 'Asia/Kolkata', mumbai: 'Asia/Kolkata', india: 'Asia/Kolkata', kolkata: 'Asia/Kolkata', karachi: 'Asia/Karachi', dhaka: 'Asia/Dhaka', riyadh: 'Asia/Riyadh', singapore: 'Asia/Singapore', sydney: 'Australia/Sydney', beijing: 'Asia/Shanghai', moscow: 'Europe/Moscow', utc: 'UTC', gmt: 'UTC' };

  const norm = t => { let s = String(t == null ? '' : t).toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim(), p;
    do { p = s; s = s.replace(/^(?:hey|hi|hello|ok|okay|alisa|alissa|alisha|please|so|um|uh)\b[\s,]*/, ''); } while (p !== s);
    s = s.replace(/^(?:(?:can|could|would|will) you(?: please)?|i want you to|i need you to|i would like you to|i'd like you to|go ahead and)\s+/, '');
    return s.replace(/[\s,]+(?:please|for me|thanks|thank you|now)$/, '').replace(/[.!\s]+$/, '').trim(); };

  // "calculate 25*18 and remember the result" → {head:'calculate 25*18', tail:'remember the result'}
  const COMPOUND = /^(.*?)[\s,]+(?:and|then|and then)\s+(?:also\s+)?((?:remember|save|store|note|keep)\b.*)$/;
  function splitCompound(s) { const m = COMPOUND.exec(s); return m ? { head: m[1].trim(), tail: m[2].trim() } : null; }
  const RESULT_REF = /^(?:remember|save|store|note|keep)(?: down)?(?: (?:the|that|this|its|it))?(?: (?:result|answer|number|total|value|output))?(?: (?:as|in|to) (?:a )?(?:memory|note))?$/;

  const AP = {   // each returns {intent, score, tool?, params?, compound?} or null
    calculation(s) {
      const MATH = window.ALISAAgentTools && window.ALISAAgentTools.math; if (!MATH) return null;
      const sp = splitCompound(s), head = sp ? sp.head : s;
      const m = MATH.looksLikeExpression(head); if (!m.ok) return null;
      const lead = /^(?:what(?:'s| is)|whats|calculate|compute|how much is|work out|solve|evaluate)\b/.test(head), bare = /^[\d\s.+\-*/^()%x×÷,]+$/.test(head);
      let score = lead ? 0.92 : bare ? 0.78 : 0.7;
      const compound = !!(sp && RESULT_REF.test(sp.tail));
      if (sp && !compound) return { intent: 'calculation', score: Math.min(score, 0.55), tool: 'calculator.evaluate', params: { expression: m.expr }, ambiguousTail: true };   // unknown second request: do not guess
      return { intent: 'calculation', score, tool: 'calculator.evaluate', params: { expression: m.expr }, compound };
    },
    time(s) {
      const re = /^(?:what(?:'s| is)?(?: the)?(?: current)? (?:time|date|day)(?: (?:is it|it is|now|today|right now))?|what time is it|what day is it|what(?:'s| is) today(?:'s date)?|tell me the (?:time|date)|current (?:time|date)|time now|today's date|what is the date today|what's the date)(?:\s+(?:in|at)\s+([a-z .'-]{2,30}))?$/.exec(s);
      if (!m0(re)) return /^(?:abhi )?(?:kitne baje|time kya hai|samay kya hai|aaj ki (?:tarikh|date))\b/.test(s) ? { intent: 'time', score: 0.8, tool: 'time.now', params: {} } : null;
      const place = re[1] && re[1].trim(), tz = place && ZONES[place];
      if (place && !tz && /^(?:my|your|our|the|a|an|his|her|their|this|that)\b/.test(place)) return null;   // "…in my heart" is not a place
      if (place && !tz) return { intent: 'time', score: 0.9, tool: 'time.now', params: { timezone: place.replace(/\s+/g, '_').slice(0, 40) } };   // unknown place → the tool will fail honestly
      return { intent: 'time', score: 0.93, tool: 'time.now', params: tz ? { timezone: tz, label: place.replace(/\b\w/g, c => c.toUpperCase()) } : {} };
    },
    diagnostics(s) {
      const deep = /\b(?:full|deep|complete)\b/.test(s);
      if (/\b(?:run|do|perform|start|give me)\s+(?:a\s+|an\s+|the\s+|your\s+)?(?:full\s+|deep\s+|system\s+)*(?:diagnostics?|health ?check|self[- ]?(?:check|test))\b/.test(s)) return { intent: 'diagnostics', score: 0.93, tool: 'diagnostics.report', params: deep ? { deep: true } : {} };
      if (/^(?:system|agent|alisa|your)\s+(?:status|health|diagnostics?)$/.test(s) || /^(?:status|health) (?:report|check)$/.test(s)) return { intent: 'diagnostics', score: 0.88, tool: 'diagnostics.report', params: {} };
      if (/\b(?:check|show|report|tell me)\s+(?:on\s+)?(?:the\s+|your\s+|all\s+)?(?:health|status)\s+of\s+(?:the\s+|your\s+|all\s+)?(?:systems?|modules?|components?)\b/.test(s) || /\bare (?:all )?(?:your )?(?:systems|modules) (?:working|ok|okay|healthy|fine)\b/.test(s)) return { intent: 'diagnostics', score: 0.86, tool: 'diagnostics.report', params: {} };
      return /^status$/.test(s) ? { intent: 'diagnostics', score: 0.5, tool: 'diagnostics.report', params: {} } : null;   // a bare "status" is too vague to act on
    },
    memory(s, ctx) {
      let m;
      if ((m = /^(?:what do you (?:remember|know) about|do you remember|what did i (?:tell|say to) you about|recall|search (?:my )?memor(?:y|ies) for|look up in (?:my )?memor(?:y|ies))\s+(.+)$/.exec(s)) || (m = /^(?:find|look up|search for) (.+?) in (?:my )?memor(?:y|ies)$/.exec(s)))
        return { intent: 'memory', score: 0.9, tool: 'memory.search', params: { query: m[1].replace(/\?+$/, '').trim().slice(0, 200) } };
      if ((m = /^(?:(?:remember|memorize|note down|save to memory)\s+that|(?:remember|memorize|note down|save to memory)\s*:|(?:remember|memorize)(?=\s+(?:i|i'm|i am|i'd|i've|my|we|our|me)\b))\s*(.+)$/.exec(s)) && !RESULT_REF.test(s))
        return { intent: 'memory', score: 0.8, tool: 'memory.save', params: { content: m[1].trim().slice(0, 1000) } };
      const mc = ctx && ctx.mindParse; if (mc && ['forget', 'update', 'approve', 'reject', 'recall', 'goals'].includes(mc.intent)) return { intent: 'memory', score: 0.85 };   // existing Mind grammar owns these (no agent tool): the request is left to it
      return null;
    },
    knowledge(s, ctx) {
      let m;
      if ((m = /^(?:search|look(?: ?up)?|find|check)\s+(?:my |the )?(?:notes?|knowledge(?: base)?|documents?|docs?)\s+(?:for|about|on)\s+(.+)$/.exec(s)) || (m = /^what (?:do|does) my (?:notes?|documents?|knowledge)\s+(?:say|have|contain)\s+(?:about|on)\s+(.+)$/.exec(s)) || (m = /^(?:search|find|look up) (.+?) in (?:my )?(?:notes?|knowledge(?: base)?|documents?)$/.exec(s)))
        return { intent: 'knowledge', score: 0.9, tool: 'knowledge.search', params: { query: m[1].replace(/\?+$/, '').trim().slice(0, 200) } };
      const mc = ctx && ctx.mindParse; return mc && mc.intent === 'search-notes' ? { intent: 'knowledge', score: 0.9, tool: 'knowledge.search', params: { query: String(mc.arg || '').slice(0, 200) } } : null;
    },
    task(s) {
      let m;
      if ((m = /^(?:add|create|make|new)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:task|to-?do)(?:\s+(?:called|named|to)\b|\s*[:-])\s*(.+)$/.exec(s)) || (m = /^(?:add|create|make|new)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:task|to-?do)\s+(?!(?:manager|management|list|lists|board|app|feature|tracker|system|view|queue|scheduler|planner|module|screen|page|tab)\b)(.+)$/.exec(s)) || (m = /^new task\s*[:-]?\s*(.+)$/.exec(s)))
        return { intent: 'task', score: 0.9, tool: 'tasks.local', params: { action: 'create', title: m[1].trim().slice(0, 120) } };
      if (/^(?:list|show|read|what(?:'s| are| is)?)(?: me)?(?: all)?(?: my| the)?\s*(?:open |pending |current )?(?:tasks|to-?dos?)(?: list)?(?: (?:i have|i've got))?$/.test(s) || /^what do i have to do$/.test(s))
        return { intent: 'task', score: 0.9, tool: 'tasks.local', params: { action: 'list' } };
      if ((m = /^(?:complete|finish|done with|check off|tick off)\s+task\s+(.+)$/.exec(s)) || (m = /^mark\s+(?:task\s+)?(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)$/.exec(s)) || (m = /^i (?:finished|completed|did)\s+task\s+(.+)$/.exec(s)))
        return { intent: 'task', score: 0.9, tool: 'tasks.local', params: { action: 'complete', ref: m[1].replace(/^(?:number|no\.?|#)\s*/, '').trim().slice(0, 120) } };
      return null;
    },
    planning(s) {
      return /\b(?:plan|schedule|organi[sz]e|prioriti[sz]e|map out)\b/.test(s) && /\b(?:my|the|a|our)\b.*\b(?:day|week|morning|evening|weekend|trip|project|study|work|month|tomorrow)\b/.test(s) ? { intent: 'planning', score: 0.78 } : /^(?:help me plan|make a plan|create a plan)\b/.test(s) ? { intent: 'planning', score: 0.78 } : null;
    },
    tool_request(s, ctx) {
      const R = window.ALISAToolRegistry && window.ALISAToolRegistry.default;
      const m = /^(?:use|run|call|invoke|execute|open)\s+(?:the\s+)?(?:tool\s+)?([a-z0-9_. -]{2,40}?)\s+tool\b/.exec(s) || /^(?:use|run|invoke|execute) tool\s+([a-z0-9_. -]{2,40})$/.exec(s);
      if (m) {
        const want = m[1].trim(), found = R && R.list().find(t => t.id === want || t.name.toLowerCase() === want || t.id.split('.')[0] === want);
        return found ? { intent: 'tool_request', score: 0.85, tool: found.id, params: {}, explicit: true } : { intent: 'tool_request', score: 0.85, tool: null, unknownTool: true };
      }
      // capabilities that do not exist in this phase: recognised so they are not mistaken for chat, never routed to a tool
      const r = /^(?:send (?:an? |my |the )?(?:message|text|sms|email|e-mail|whatsapp|telegram)|call |dial |pay |transfer |buy |delete (?:(?:all|my|of|the) )*(?:files?|photos?|data|messages|contacts|accounts?)|install |uninstall |unlock |log ?in|post to |tweet )/.exec(s);
      return r ? { intent: 'tool_request', score: 0.7, tool: null, unsupported: true } : null;
    },
    question(s) { return /\?$/.test(s) || /^(?:what|who|whom|whose|where|when|why|how|which|is|are|was|were|do|does|did|can|could|should|would|will|tell me|explain|define)\b/.test(s) ? { intent: 'question', score: 0.55, generic: true } : null; },
    conversation(s) { return /^(?:hi|hello|hey|namaste|good (?:morning|afternoon|evening|night)|thanks?|thank you|how are you|how's it going|who are you|what's up|bye|goodbye|good night|i feel\b|i'm (?:so |very )?(?:happy|sad|tired|bored)|lol|haha)\b/.test(s) ? { intent: 'conversation', score: 0.7, generic: true } : null; },
  };
  const m0 = x => x;

  function classify(text, context = {}) {
    const raw = String(text == null ? '' : text), s = norm(raw), ctx = { ...context };
    if (!s) { const g = AP.conversation(raw.toLowerCase().replace(/[.!?\s]+$/, '').trim()); return result(g ? { intent: 'conversation', score: g.score } : { intent: 'unknown', score: 0.2 }, [], 'rules'); }   // e.g. a bare "hello" is stripped to nothing by norm()
    try { const M = window.ALISAMind; if (M && M.commands && ctx.mindParse === undefined) ctx.mindParse = M.commands.parse(raw) || null; } catch (e) { ctx.mindParse = null; }   // existing grammar as extra evidence
    const cands = [];
    for (const k of Object.keys(AP)) { let c = null; try { c = AP[k](s, ctx); } catch (e) { c = null; } if (c && c.score > 0) cands.push(c); }
    const specific = cands.filter(c => !c.generic), hasSpecific = specific.some(c => c.score >= 0.5);
    for (const c of cands) if (c.generic && hasSpecific) c.score *= 0.5;   // specific beats generic
    cands.sort((a, b) => b.score - a.score);
    let top = cands[0] || { intent: 'unknown', score: 0.2 };
    if (modelClassifier && (!top || top.score < THRESHOLD)) {   // optional, off by default: may only relabel an UNCERTAIN request, never pick a tool
      try { const r = modelClassifier(raw, { ...ctx }); if (r && INTENTS.includes(r.intent) && !['tool_request', 'memory', 'task'].includes(r.intent) && Number.isFinite(r.confidence)) top = { intent: r.intent, score: Math.min(0.59, Math.max(0, r.confidence)), model: true }; } catch (e) {}
    }
    return result(top, cands.slice(1, 4), top.model ? 'rules+model-hint' : 'rules+context');
  }
  function result(top, others, source) {
    const second = others.length ? others[0].score : 0, conf = Math.max(0, Math.min(1, top.score - 0.3 * second));
    const R = window.ALISAToolRegistry && window.ALISAToolRegistry.default, G = window.ALISARiskGate;
    const meta = top.tool && R ? R.get(top.tool) : null;
    const confident = conf >= THRESHOLD;
    const req = meta && G ? G.requirements(meta) : null;
    return {
      intent: INTENTS.includes(top.intent) ? top.intent : 'unknown', confidence: Math.round(conf * 100) / 100,
      requiresTool: !!(confident && meta), tool: meta ? meta.id : null, params: confident && meta ? (top.params || {}) : {},
      riskLevel: req ? req.riskLevel : 'SAFE', requiresConfirmation: req ? req.requiresConfirmation : false, requiresAuthentication: req ? req.requiresAuthentication : false,
      compound: !!top.compound, unknownTool: !!top.unknownTool, unsupported: !!top.unsupported,
      alternatives: others.map(o => ({ intent: o.intent, confidence: Math.round(o.score * 100) / 100 })), source,
    };
  }
  window.ALISAIntent = {
    version: 1, INTENTS, THRESHOLD, classify, splitCompound, norm,
    setModelClassifier(fn) { modelClassifier = typeof fn === 'function' ? fn : null; },
  };
})();
