/* ALISA MEMORY INTELLIGENCE (Phase 2.5) — decides WHAT is worth remembering. Independent module: window.ALISAMemoryIntelligence (also require()-able in Node).
   It never stores anything by itself except through the EXISTING ALISAMind API (memory.add / memory.suggest / working), so persistence, the semantic index
   (alisa-semantic.js, which re-indexes on every 'alisamind:change'), remote storage and export/import all keep working unchanged.

   Pipeline (process): input → sensitive filter (fail closed) → intent + classification → duplicate / update / contradiction check against
   existing memory (semantic search when available, lexical otherwise) → approval if needed → save → (existing) embedding + vector index.

   HONEST LIMITS: classification is rule-based and probabilistic, English-only, and will sometimes be wrong. When unsure it prefers
   "temporary" or "ask the user" over silently creating a permanent memory. The secret filter is best-effort pattern matching, not a guarantee. */
(() => {
'use strict';
const root = typeof window !== 'undefined' ? window : globalThis;
const REFUSAL = 'I won’t store passwords or security credentials.';
const DEFAULTS = {
  autoSaveThreshold: 0.85,       // confidence at/above which an IMPLICIT statement may be saved without asking (only if autoPersistImplicit)
  suggestThreshold: 0.5,         // at/above: ask "Would you like me to remember that?"; below: not long-term (temporary / ignored)
  autoPersistImplicit: false,    // false = Phase 2 policy preserved: long-term memory only on an explicit request or an Allow. Set true to auto-save high-confidence implicit preferences/goals.
  duplicateSimilarity: 0.8,      // lexical similarity (0..1) treated as "same memory"
  updateSimilarity: 0.5,         // lexical similarity treated as "same memory, refined" (goals)
  semanticDuplicate: 0.9,        // embedding similarity treated as a duplicate (when semantic search is loaded and nothing contradicts)
  workingTtlMs: 4 * 3600e3,      // working-memory focus lifetime
  temporaryMemoryTtlMs: 24 * 3600e3,   // explicitly-saved memories about "today / tonight / right now" expire after this
};
let cfg = { ...DEFAULTS };

/* ---------------------------------------------------------------- sensitive-content filter (runs BEFORE everything else) */
const KW = '(?:password|passcode|passphrase|pass phrase|pin|backup code|backup passcode|security code|(?:verification|login|auth|authentication|confirmation|2fa|mfa|one[- ]time) (?:code|password)|otp|api[ _-]?key|access key|secret key|client secret|secret|(?:access |auth |refresh |bearer |session |id )?token|private key|seed phrase|recovery (?:code|phrase|key)|cvv|cvc|cvv2|card number|debit card|credit card|session id|cookie)';
const BENIGN = new Set('required needed wrong incorrect invalid weak strong too not a an the expired working broken fine ok okay set saved stored safe secure long short missing empty case sensitive important private secret hard easy bad good very really still always never reset manager protected'.split(' '));
const NUMTAIL = '(?:\\s+(?:number|code|no\\.?|is\\s+the\\s+code))?';
const SENS = [
  ['credential', new RegExp('\\b' + KW + '\\b' + NUMTAIL + '\\s*(?:for [\\w.@-]+\\s+)?(?:is|are|was|=|:|-|—)\\s*(\\S+)', 'i'), 1],   // "my PIN is 1234" — value must not be a harmless word
  ['credential', new RegExp('\\b(?:otp|pin|cvv|cvc|passcode|password|backup code|passphrase|api[ _-]?key)\\b' + NUMTAIL + '\\s*[:=]?\\s*(?=\\S*\\d)\\S{4,}', 'i')],   // "OTP 482913", "password abc123"
  ['credential', /\b(?:set|change|changed|use|using|make|made)\s+(?:my\s+)?(?:\w+\s+)?(?:password|passcode|pin|passphrase)\s+(?:to|as)\s+\S+/i],
  ['key', /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|ASIA|AIza|glpat|npm)[-_A-Za-z0-9]{12,}/],
  ['key', /\bBearer\s+\S{10,}/i],
  ['key', /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/],                       // JWT
  ['key', /-----BEGIN [A-Z ]*(?:PRIVATE KEY|ENCRYPTED|PGP)[A-Z ]*-----/],
  ['key', /\bssh-(?:rsa|ed25519|dss)\s+\S{20,}/],
  ['token', /\b[A-Fa-f0-9]{32,}\b/], ['token', /\b[A-Za-z0-9+/_=-]{32,}\b/],
  ['card', /(?<![\d])(?:\d[ -]?){13,19}(?![\d])/],                          // any 13–19 digit run (card-like) — fail closed
  ['identity', /\b\d{3}-\d{2}-\d{4}\b/], ['identity', /\b\d{4}\s\d{4}\s\d{4}\b/],
  ['cookie', /\b(?:set-cookie|cookie|session[_ -]?(?:id|token))\b\s*[:=]\s*\S+/i],
  ['url-credentials', /:\/\/[^/\s:@]+:[^/\s@]+@/],
];
function inspect(text) {   // → { sensitive, kind } ; NEVER returns or logs the matched text. Fails closed on any error.
  try {
    const t = String(text == null ? '' : text);
    for (const [kind, re, checkValue] of SENS) {
      const m = t.match(re);
      if (!m) continue;
      if (checkValue && BENIGN.has(String(m[1] || '').toLowerCase().replace(/[^a-z]/g, ''))) continue;
      return { sensitive: true, kind };
    }
    return { sensitive: false, kind: null };
  } catch (e) { return { sensitive: true, kind: 'error' }; }
}
const isSensitive = text => inspect(text).sensitive;

/* ---------------------------------------------------------------- text helpers */
const STOP = new Set('the a an i my me we our you your about for that this to of and is are was were be been am it its with on in at as by from or so do does did have has had just really also actually now anymore still very quite pretty definitely always usually often sometimes lately recently currently these days then than too'.split(' '));
const VERBS = new Set('prefer like love enjoy hate dislike use using want choose favourite favorite rather would cant stand remember forget keep mind note dont not never'.split(' '));
const VALUES = new Set(('green blue red purple pink orange yellow teal cyan violet magenta white black grey gray brown gold silver dark light midnight amoled oled neon pastel minimal minimalist futuristic retro classic modern ' +
  'concise brief short long detailed verbose terse formal casual friendly serious funny').split(' '));
const stem = w => w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
const words = t => String(t).toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9'\s-]/g, ' ').split(/\s+/).filter(Boolean);
const clean = t => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().replace(/^(?:hey |ok |okay )?alisa[, ]+/i, '').replace(/[.!?\s]+$/, '');
const up = s => s.charAt(0).toUpperCase() + s.slice(1);
const jacc = (a, b) => { const A = new Set(a), B = new Set(b); if (!A.size && !B.size) return 1; let n = 0; for (const x of A) if (B.has(x)) n++; return n / (A.size + B.size - n); };

/* ---------------------------------------------------------------- intent + classification */
const EXPLICIT = /^(?:please\s+)?(?:(?:can|could|will|would) you\s+(?:please\s+)?)?(?:remember|memori[sz]e|don'?t forget|do not forget|keep in mind|make a note|note)\b(?:\s+that|\s+this)?\s*[:,-]?\s+(.+)$/i;
const GOAL = /^(?:my (?:main |long[- ]term |current )?(?:goal|aim|objective|ambition|plan) (?:is|was|now is)\b|i(?:'m| am)? (?:really )?(?:trying|aiming|planning|hoping|working to(?:wards?)?) to\b|i (?:plan|aim|intend|hope) to\b|i want to (?:learn|build|become|create|make|turn|launch|finish|start|write|develop|improve|master|achieve|publish|ship|get)\b)/i;
const PREF_STRONG = /^(?:i|we)\s+(?:(?:really|also|definitely|absolutely|personally|usually|generally|mostly|typically|normally|often|sometimes)\s+)*(?:prefer|like|love|enjoy|hate|dislike|can'?t stand)\b/i;
const PREF_OTHER = /^(?:i'?d rather\b|my (?:favou?rite|preferred)\b|i always (?:use|want|choose|pick)\b|i never (?:use|want)\b)/i;
const PREF_HABIT = /^i(?:'ve| have)\s+been\s+(?:using|liking|preferring|enjoying|going with)\b/i;
const NOT_PREF = /^i(?:'d| would)\s+like\b|^i like (?:you to|it if you)\b/i;
const HEDGED = /\b(?:usually|tend to|tends to|often|sometimes|generally|mostly|typically|normally)\b/i;
const RECENT = /\b(?:lately|recently|been|for now|these days|at the moment|currently|for a while)\b/i;
const TEMPORAL = /\b(?:today|tonight|right now|this (?:morning|afternoon|evening|week)|yesterday|tomorrow|later|in a (?:bit|moment|while)|just now|earlier)\b/i;
const WORKING = /^(?:i(?:'m| am) (?:currently |now |just )?(?:working on|editing|testing|fixing|debugging|building|writing|reading|reviewing|looking at|trying out|checking|doing)\b|let'?s\s+(?:fix|test|build|edit|debug|work|try|check|look|start|continue|review)\b|(?:i(?:'m| am) )?(?:about to|going to)\b)/i;
const FACT = /^(?:i\s+(?:use|own|have|drive|play|speak|live in|study|work (?:at|as|for|in)|am (?:a|an)|was born|go to|ride|run)\b|my\s+(?:phone|laptop|computer|car|name|job|city|school|college|company|language|device|bike|team)\s+(?:is|are)\b|i(?:'m| am) (?:from|based in|studying)\b)/i;
const SENSITIVE_ATTR = /\b(?:diagnos|disease|illness|medication|therapy|therapist|depress|anxiety|pregnan|religio|church|mosque|temple|muslim|christian|hindu|jewish|atheist|politic|vote|party member|gay|lesbian|bisexual|transgender|sexual|ethnic|race|caste|immigration|salary|income|debt|loan|bank account|criminal|arrest|home address|passport|license number)\b/i;
const QUESTION = /\?\s*$|^(?:what|when|where|who|why|how|which|is|are|do|does|did|can|could|will|would|should|tell me|show me|give me|find|search|set|open|play|call|turn)\b/i;

const MIND_CAT = { preference: 'preferences', importantFact: 'importantFacts', goal: 'goals', approvedMemory: 'approvedMemories' };
const FROM_MIND = { preferences: 'preference', importantFacts: 'importantFact', goals: 'goal', approvedMemories: 'approvedMemory' };
const result = (o) => ({ category: 'temporary', confidence: 0.3, persistence: 'none', requiresApproval: false, sensitive: false, reason: '', explicit: false, ...o });

function kindOf(t) {   // category of an already-extracted statement + base confidence + hints
  const hedged = HEDGED.test(t), recent = RECENT.test(t), temporal = TEMPORAL.test(t);
  if (GOAL.test(t)) { const strong = /^my .*(?:goal|aim|objective|ambition|plan)/i.test(t); return { cat: 'goal', conf: strong ? 0.92 : 0.8, why: strong ? 'The user stated a goal.' : 'The user expressed an intention that looks like a goal.', hedged, recent, temporal }; }
  if (!NOT_PREF.test(t) && (PREF_STRONG.test(t) || PREF_OTHER.test(t))) { const conf = hedged ? 0.65 : recent ? 0.55 : /^i (?:prefer|always)|^i(?:'d| would) rather/i.test(t) ? 0.93 : 0.88; return { cat: 'preference', conf, why: hedged ? 'A preference, but hedged ("usually / often").' : recent ? 'Possibly a recent habit rather than a stable preference.' : 'The user expressed a stable preference.', hedged, recent, temporal }; }
  if (PREF_HABIT.test(t)) return { cat: 'preference', conf: 0.55, why: 'Describes recent usage, not clearly a stable preference.', hedged, recent: true, temporal };
  if (WORKING.test(t)) return { cat: 'workingMemory', conf: 0.85, why: 'Describes what the user is doing right now (task context).', hedged, recent, temporal };
  if (FACT.test(t) && !temporal) return { cat: 'importantFact', conf: 0.72, why: 'A fact the user stated about themselves.', hedged, recent, temporal };
  return null;
}

function classify(input, context) {
  context = context || {};
  try {
    if (isSensitive(input)) return result({ category: 'sensitive', confidence: 0.99, persistence: 'reject', sensitive: true, reason: 'Looks like a password, key, code or other credential. Never stored.' });   // checked on the RAW text first (clean() strips trailing punctuation)
    let t = clean(input);
    if (!t) return result({ category: 'reject', persistence: 'reject', reason: 'Empty input.' });
    if (isSensitive(t)) return result({ category: 'sensitive', confidence: 0.99, persistence: 'reject', sensitive: true, reason: 'Looks like a password, key, code or other credential. Never stored.' });
    let explicit = context.explicit === true;
    if (!explicit) { const m = t.match(EXPLICIT); if (m) { explicit = true; t = clean(m[1]); } }
    if (explicit && !t) return result({ category: 'reject', persistence: 'reject', explicit, reason: 'Nothing to remember.' });
    if (isSensitive(t)) return result({ category: 'sensitive', confidence: 0.99, persistence: 'reject', sensitive: true, explicit, reason: 'Looks like a credential. Never stored.' });
    if (t.length > 1000 || t.split(/\n/).length > 6 || (!explicit && t.length > 500)) return result({ category: 'knowledge', confidence: 0.7, persistence: 'knowledge', requiresApproval: true, explicit, content: t, reason: 'Long text — better kept as a note in Knowledge than as a memory.' });
    const k = kindOf(t), content = up(t), attr = SENSITIVE_ATTR.test(t);
    const base = { explicit, content, sensitiveAttribute: attr };
    if (explicit) {   // an explicit request is a strong signal of intent: persist (long-term) with the best-fitting category
      const cat = k && k.cat !== 'workingMemory' ? k.cat : 'approvedMemory', temporal = TEMPORAL.test(t) || (k && k.temporal);
      return result({ ...base, category: cat, confidence: Math.max(0.95, k ? k.conf : 0), persistence: 'long-term', requiresApproval: false, expiresInMs: temporal ? cfg.temporaryMemoryTtlMs : null, reason: 'The user explicitly asked to remember this.' });
    }
    if (QUESTION.test(t)) return result({ ...base, category: 'temporary', confidence: 0.1, persistence: 'none', reason: 'A question or request, not a statement about the user.' });
    if (!k) return result({ ...base, category: 'temporary', confidence: 0.25, persistence: 'none', reason: 'Ordinary conversation — not a stable personal fact, preference or goal.' });
    if (k.cat === 'workingMemory' || (k.temporal && k.cat !== 'goal')) return result({ ...base, category: 'workingMemory', confidence: k.conf, persistence: 'session', expiresInMs: cfg.workingTtlMs, reason: k.cat === 'workingMemory' ? k.why : 'Time-bound statement — kept as working context only.' });
    const long = k.conf >= cfg.suggestThreshold, auto = cfg.autoPersistImplicit && k.conf >= cfg.autoSaveThreshold && !attr && !k.recent && !k.hedged;
    if (!long) return result({ ...base, category: 'temporary', confidence: k.conf, persistence: 'session', reason: 'Low confidence — not treated as long-term.' });
    return result({ ...base, category: k.cat, confidence: k.conf, persistence: 'long-term', requiresApproval: !auto, reason: k.why + (attr ? ' Touches a personal topic, so I will always ask first.' : '') });
  } catch (e) {   // classification failure → never long-term
    return result({ category: 'workingMemory', confidence: 0, persistence: 'session', reason: 'Classification failed; handled as temporary.', error: String(e && e.message || e).slice(0, 120) });
  }
}
const shouldPersist = r => !!r && r.persistence === 'long-term' && !r.sensitive && !r.requiresApproval && r.category !== 'reject';

/* ---------------------------------------------------------------- claims: duplicate / update / contradiction */
function claim(text, category) {
  const w = words(text), neg = /\b(?:hate|dislike|can't stand|cant stand|don't like|dont like|do not like|never|no longer)\b/i.test(String(text));
  const values = new Set(w.filter(x => VALUES.has(x)));
  let toks = w.filter(x => !STOP.has(x) && !VERBS.has(x) && !VALUES.has(x)).map(stem);
  if (category === 'goals' || category === 'goal') toks = toks.filter(x => !['goal', 'aim', 'objective', 'ambition', 'plan', 'try', 'trying', 'hope', 'intend', 'mine', 'main', 'term', 'long', 'current'].includes(x));
  if (category === 'preferences' || category === 'preference') toks = toks.filter(x => !['preference', 'favourite', 'favorite', 'preferred'].includes(x));
  return { topic: [...new Set(toks)], values, neg, all: [...new Set(w.filter(x => !STOP.has(x)).map(stem))] };
}
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
/* relation of a NEW statement to an EXISTING memory (same Mind category): 'duplicate' | 'update' (refines) | 'conflict' (contradicts / replaces) | 'none' */
function compare(newText, existing, category, semanticSim) {
  if (existing.category !== category) return { relation: 'none', similarity: 0 };
  const a = claim(newText, category), b = claim(existing.content, category), sim = jacc(a.topic, b.topic);
  if (category === 'preferences') {
    const topicSame = sim >= 0.6 || (a.topic.length && b.topic.length && (a.topic.every(x => b.topic.includes(x)) || b.topic.every(x => a.topic.includes(x))));
    if (topicSame) {
      if (a.neg !== b.neg && sameSet(a.values, b.values)) return { relation: 'conflict', similarity: sim };
      if (a.values.size && b.values.size && !sameSet(a.values, b.values) && ![...a.values].some(x => b.values.has(x))) return { relation: 'conflict', similarity: sim };
      if (sameSet(a.values, b.values) && a.neg === b.neg) return { relation: 'duplicate', similarity: Math.max(sim, 0.9) };
      if (a.values.size && !b.values.size) return { relation: 'update', similarity: sim };
      if (!a.values.size && b.values.size) return { relation: 'duplicate', similarity: sim };
    }
  } else if (category === 'goals') {
    const all = jacc(a.all, b.all), inOld = a.topic.length >= 2 && a.topic.every(x => b.topic.includes(x)), inNew = b.topic.length >= 2 && b.topic.every(x => a.topic.includes(x));
    if (all >= cfg.duplicateSimilarity || sim >= cfg.duplicateSimilarity || inOld) return { relation: 'duplicate', similarity: Math.max(all, sim) };   // new goal says nothing the stored one doesn't
    if (inNew || sim >= cfg.updateSimilarity) return { relation: 'update', similarity: sim };   // new goal refines / extends the stored one → update it, don't duplicate
  } else {
    if (jacc(a.all, b.all) >= cfg.duplicateSimilarity || sim >= cfg.duplicateSimilarity) return { relation: 'duplicate', similarity: sim };   // facts: duplicates only (no automatic contradiction handling)
  }
  if (semanticSim >= cfg.semanticDuplicate && sameSet(a.values, b.values) && a.neg === b.neg && (category !== 'goals' && category !== 'preferences' ? true : a.topic.length === 0 || sim >= 0.34)) return { relation: 'duplicate', similarity: semanticSim };
  return { relation: 'none', similarity: sim };
}
async function related(content, category) {   // → best match { relation, existing, similarity } over live memories; semantic search is used when loaded, else lexical only
  const M = root.ALISAMind; if (!M) return { relation: 'none' };
  await M.ready();
  const live = M.memory.live(), sem = new Map();
  try { for (const r of await M.memory.searchAsync(content, 8)) if (typeof r.similarity === 'number') sem.set(r.id, r.similarity); } catch (e) { /* lexical only */ }
  const rank = { conflict: 4, update: 3, duplicate: 2, none: 0 }; let best = { relation: 'none' };
  for (const m of live) {
    if (isSensitive(m.content)) continue;
    const c = compare(content, m, category, sem.get(m.id) || 0);
    if (rank[c.relation] > rank[best.relation] || (rank[c.relation] === rank[best.relation] && c.relation !== 'none' && c.similarity > best.similarity)) best = { ...c, existing: m };
  }
  return best;
}
async function checkDuplicate(input, category) {
  const r = classify(input), cat = category || MIND_CAT[r.category]; if (r.sensitive || !cat) return { relation: 'none' };
  const m = await related(r.content || clean(input), cat); return m.relation === 'duplicate' || m.relation === 'update' ? m : { relation: 'none' };
}
async function detectConflict(input, category) {
  const r = classify(input), cat = category || MIND_CAT[r.category]; if (r.sensitive || !cat) return { relation: 'none' };
  const m = await related(r.content || clean(input), cat); return m.relation === 'conflict' || m.relation === 'update' ? m : { relation: 'none' };
}

/* ---------------------------------------------------------------- working-memory helpers (use the existing ALISAMind.working API) */
function sweep() {   // remove expired working-memory focus + expired memories (never touches stable memories, which have no expiresAt)
  const M = root.ALISAMind; if (!M) return 0; let n = 0;
  try { const f = M.working.get('focus'); if (f && f.expiresAt && Date.parse(f.expiresAt) < Date.now()) { M.working.remove('focus'); n++; } } catch (e) {}
  try { if (M.memory.purgeExpired) n += M.memory.purgeExpired(); } catch (e) {}
  return n;
}
function scrubContext(content) {   // after "forget": drop cached working context that still repeats the forgotten statement
  const M = root.ALISAMind; if (!M) return; const a = claim(content).all;
  const hit = txt => { const b = claim(txt).all; return a.length && (jacc(a, b) >= 0.5 || a.every(x => b.includes(x))); };
  try {
    const f = M.working.get('focus'); if (f && hit(f.text || '')) M.working.remove('focus');
    for (const k of ['conversation', 'recentCommands']) { const v = M.working.get(k); if (Array.isArray(v)) { const keep = v.filter(x => !hit(x.text || '')); if (keep.length !== v.length) M.working.set(k, keep); } }
  } catch (e) {}
}

/* ---------------------------------------------------------------- the pipeline */
const label = { preference: 'preference', goal: 'goal', importantFact: 'fact', approvedMemory: 'memory' };
const meta = r => ({ category: r.category, confidence: r.confidence, persistence: r.persistence, reason: String(r.reason || '').slice(0, 200) });
async function process(input, context) {
  context = context || {};
  const M = root.ALISAMind;
  let r;
  try {
    r = classify(input, context);
    if (r.sensitive || r.category === 'sensitive') return { ok: false, action: 'rejected', say: REFUSAL, classification: r };   // nothing else runs: no memory, no embedding, no remote, no model
    if (r.error) return { ok: false, action: 'working', say: 'I couldn’t classify that safely, so I did not save it.', classification: r };
    if (!M) return { ok: false, action: 'unavailable', say: 'My memory isn’t available right now.', classification: r };
    await M.ready(); sweep();
    const cat = MIND_CAT[r.category], source = context.source || 'voice-command';

    if (r.category === 'workingMemory') {   // task context: working memory only (cleared with "clear my working memory"; never long-term)
      const text = r.content || clean(input);
      M.working.set('focus', { text: text.slice(0, 200), at: new Date().toISOString(), expiresAt: new Date(Date.now() + (r.expiresInMs || cfg.workingTtlMs)).toISOString() });
      return { ok: true, action: 'working', say: '', classification: r };
    }
    if (r.category === 'knowledge') return { ok: true, action: 'knowledge-suggested', say: 'That looks long — I’d keep it as a note. You can add it under “Add a note to Knowledge” in Settings.', classification: r };
    if (!cat || r.persistence !== 'long-term') return { ok: true, action: 'ignored', say: '', classification: r };   // ordinary conversation / questions / low confidence

    const content = r.content, rel = await related(content, cat);
    const save = (extra = {}) => M.memory.add(cat, content, { source, confidence: context.confidence != null ? context.confidence : (r.explicit ? 1 : r.confidence), tags: context.tags, private: context.private === true, meta: meta(r), expiresAt: r.expiresInMs ? new Date(Date.now() + r.expiresInMs).toISOString() : undefined, ...extra });
    if (rel.relation === 'duplicate') {   // confirm instead of duplicating (exact copies merge tags via the existing add() path)
      const ex = rel.existing, it = ex.content.toLowerCase() === content.toLowerCase() && ex.category === cat ? save() : M.memory.update(ex.id, null, { tags: [...new Set([...(ex.tags || []), ...(context.tags ? [].concat(context.tags) : [])])] });
      return { ok: true, action: 'duplicate', item: it, existing: ex, say: 'I already remember that: ' + ex.content.replace(/[.!?]+$/, '') + '.', classification: r };
    }
    if (rel.relation === 'conflict' || rel.relation === 'update') {   // newer statement replaces the active one; the old record is kept as hidden history (supersedes)
      const ex = rel.existing, verb = rel.relation === 'conflict' ? 'update' : 'refine';
      const apply = () => { const it = save({ supersedes: ex.id }); return it; };
      if (r.explicit || context.confirmed) { const it = apply(); return { ok: true, action: 'updated', item: it, replaced: ex, say: 'Okay, I’ve updated that. Now: ' + it.content.replace(/[.!?]+$/, '') + '.', classification: r }; }
      const s = M.memory.suggest(content, cat, { supersedes: ex.id, meta: meta(r), confidence: r.confidence, label: 'Needs approval · replaces an older ' + label[r.category] });
      return { ok: true, action: 'needs-approval', suggestion: s, replaces: ex, say: '', prompt: 'Would you like me to ' + verb + ' “' + ex.content.replace(/[.!?]+$/, '') + '” to “' + content.replace(/[.!?]+$/, '') + '”? Say yes remember it, or no.', classification: r };
    }
    if (shouldPersist(r) || r.explicit) { const it = save(); return { ok: true, action: 'saved', item: it, say: 'Okay, I’ll remember that: ' + it.content + '.', classification: r }; }
    const s = M.memory.suggest(content, cat, { meta: meta(r), confidence: r.confidence, label: 'Needs approval · ' + label[r.category] });
    return { ok: true, action: 'needs-approval', suggestion: s, say: '', prompt: 'Would you like me to remember that? “' + content.replace(/[.!?]+$/, '') + '” Say yes remember it, or no.', classification: r };
  } catch (e) {   // anything unexpected: fail safe — do not create a permanent memory
    const m = String(e && e.message || e);
    if (/secret|credential/i.test(m)) return { ok: false, action: 'rejected', say: REFUSAL, classification: r };
    return { ok: false, action: 'working', say: 'I couldn’t save that safely.', error: m.slice(0, 120), classification: r };
  }
}

const API = {
  version: 1, REFUSAL, defaults: { ...DEFAULTS },
  classify, isSensitive, inspect, shouldPersist, checkDuplicate, detectConflict, process,
  compare, claim, sweep, scrubContext,
  config: o => { if (o && typeof o === 'object') for (const k of Object.keys(DEFAULTS)) if (k in o && typeof o[k] === typeof DEFAULTS[k]) cfg[k] = o[k]; return { ...cfg }; },
  resetConfig: () => { cfg = { ...DEFAULTS }; return { ...cfg } },
  CATEGORIES: ['preference', 'importantFact', 'goal', 'approvedMemory', 'workingMemory', 'knowledge', 'temporary', 'sensitive', 'reject'],
};
root.ALISAMemoryIntelligence = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
