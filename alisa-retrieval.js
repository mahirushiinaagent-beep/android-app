/* ALISA RETRIEVAL — local, dependency-free memory ranking (NO embeddings, nothing leaves the device).
   Pipeline: normalize → tokenize → stopwords → light stemming → synonym groups → weighted match over
   content / tags / category → recency + confidence + usage boosts → stable sort.
   Works in the browser (window.ALISARetrieval) and in Node (require) so the tests exercise the real code. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ALISARetrieval = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STOP = new Set(('the a an i my me you your about for that this to of and is are was were what which who do does did in on at it its ' +
    'with be been have has had am will can could would should tell remember know please any some there their they them he she we our us ' +
    'from as by or but not so if then than too very just also hey alisa').split(' '));

  // Groups of words that mean (roughly) the same thing. The first entry is the canonical form.
  // Hinglish forms are included because ALISA supports Hindi / Hinglish.
  const GROUPS = [
    ['mother', 'mom', 'mum', 'mummy', 'mama', 'maa', 'mataji'],
    ['father', 'dad', 'daddy', 'papa', 'pita', 'pitaji'],
    ['spouse', 'wife', 'husband', 'partner', 'patni', 'pati'],
    ['sibling', 'brother', 'sister', 'bhai', 'behen', 'didi'],
    ['child', 'kid', 'son', 'daughter', 'beta', 'beti', 'baby'],
    ['car', 'vehicle', 'automobile', 'gaadi', 'bike', 'scooter'],
    ['phone', 'mobile', 'cellphone', 'smartphone', 'number'],
    ['job', 'work', 'career', 'profession', 'occupation', 'office', 'employer', 'company'],
    ['home', 'house', 'address', 'live', 'resid', 'ghar', 'flat', 'apartment'],
    ['birthday', 'bday', 'born', 'birth', 'janamdin'],
    ['food', 'eat', 'meal', 'dish', 'cuisine', 'dinner', 'lunch', 'breakfast', 'khana'],
    ['drink', 'beverage', 'coffee', 'tea', 'chai', 'juice'],
    ['favorite', 'favourite', 'fav', 'prefer', 'like', 'love', 'enjoy', 'pasand'],
    ['dislike', 'hate', 'avoid', 'napasand'],
    ['allergy', 'allergic', 'allergen', 'intolerance'],
    ['medicine', 'medication', 'pill', 'tablet', 'drug', 'dawai', 'dawa'],
    ['doctor', 'physician', 'dr', 'clinic', 'hospital'],
    ['music', 'song', 'singer', 'playlist', 'band', 'gaana'],
    ['movie', 'film', 'cinema', 'show', 'series'],
    ['exercise', 'workout', 'gym', 'training', 'run', 'yoga', 'fitness'],
    ['goal', 'aim', 'objective', 'target', 'plan', 'ambition', 'lakshya'],
    ['learn', 'study', 'course', 'class', 'exam', 'school', 'college', 'padhai'],
    ['meeting', 'appointment', 'call', 'schedule'],
    ['money', 'salary', 'budget', 'income', 'paisa', 'pay'],
    ['trip', 'travel', 'vacation', 'holiday', 'journey', 'visit'],
    ['pet', 'dog', 'cat', 'puppy', 'kitten'],
    ['name', 'called', 'named'],
    ['friend', 'buddy', 'dost', 'mitra'],
    ['language', 'speak', 'hindi', 'english', 'bhasha'],
  ];
  const CANON = new Map();   // stemmed word → canonical group id (the stemmed first member)

  // Conservative suffix stripping. It only needs to be CONSISTENT (same function for stored text and queries).
  const RULES = [[/ies$/, 'y', 5], [/(ss|us|is)$/, null, 0], [/(ch|sh|x|z|ss)es$/, '$1', 5], [/s$/, '', 4],
    [/ing$/, '', 6], [/ed$/, '', 5], [/ly$/, '', 5], [/er$/, '', 6], [/ment$/, '', 7], [/ness$/, '', 7]];
  function stem(w) {
    if (w.length <= 3 || /^\d+$/.test(w) || /[^\x00-\x7f]/.test(w)) return w;
    let r = w;
    for (const [re, rep, min] of RULES) {
      if (!re.test(w)) continue;
      if (rep === null) break;
      if (w.length < min) continue;
      r = w.replace(re, rep); break;
    }
    if (r.length > 3 && r.endsWith('e')) r = r.slice(0, -1);              // make/making → mak, love/loved/loving → lov
    if (r.length > 3 && /([^aeiouls])\1$/.test(r)) r = r.slice(0, -1);   // running → runn → run
    return r;
  }
  for (const g of GROUPS) { const c = stem(g[0]); for (const m of g) CANON.set(stem(m), c); }

  function normalize(s) {
    return String(s == null ? '' : s).toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')      // strip Latin accents (Devanagari etc. survive: the range only covers combining marks U+0300–036F)
      .replace(/[’‘`´]/g, "'").replace(/'s\b/g, '').replace(/'/g, '')
      .replace(/[^a-z0-9\u0900-\u097f\u00c0-\uffff]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function tokens(s, { keepStop = false } = {}) {
    return normalize(s).split(' ').filter(w => w && (keepStop || !STOP.has(w)));
  }
  // → [{ stem, canon }]
  function terms(s) {
    return tokens(s).map(w => { const st = stem(w); return { stem: st, canon: CANON.get(st) || st, raw: w }; });
  }

  const W_CONTENT = 2, W_TAG = 3, W_CAT = 0.5, SYN = 0.7, PREFIX = 0.35;

  function textScore(qTerms, phrase, fields) {
    let sc = 0;
    for (const [text, w] of fields) {
      if (!text) continue;
      const ft = terms(text), stems = new Set(ft.map(t => t.stem)), canons = new Set(ft.map(t => t.canon));
      if (phrase && normalize(text).includes(phrase)) sc += w * 2;
      for (const q of qTerms) {
        if (stems.has(q.stem)) sc += w;
        else if (canons.has(q.canon)) sc += w * SYN;
        else if (q.stem.length > 3 && ft.some(t => t.stem.length > 3 && t.stem.slice(0, 4) === q.stem.slice(0, 4))) sc += w * PREFIX;
      }
    }
    return sc;
  }

  function ageDays(it, now) {
    const t = Date.parse(it.lastUsedAt && it.lastUsedAt > (it.updatedAt || '') ? it.lastUsedAt : (it.updatedAt || it.createdAt || ''));
    return Number.isFinite(t) ? Math.max(0, (now - t) / 864e5) : 365;
  }

  /* rank(query, items, opts) → items with .score, best first. Only items with a real text match are returned.
     Items superseded by another LIVE item (item.supersedes === their id) are hidden. */
  function rank(query, items, opts = {}) {
    const now = opts.now || Date.now(), limit = opts.limit || 10, qTerms = terms(query), phrase = normalize(query);
    if (!qTerms.length) return [];
    const hidden = new Set(); for (const it of items) if (it.supersedes) hidden.add(it.supersedes);
    const out = [];
    for (const it of items) {
      if (hidden.has(it.id) || it.deleted) continue;
      const text = textScore(qTerms, phrase.includes(' ') ? phrase : '', [[it.content, W_CONTENT], [(it.tags || []).join(' '), W_TAG], [it.category, W_CAT]]);
      if (text <= 0) continue;
      const conf = typeof it.confidence === 'number' ? Math.min(1, Math.max(0, it.confidence)) : 1;
      const recency = 1 + 0.25 * Math.exp(-ageDays(it, now) / 90);
      const score = text * recency * (0.6 + 0.4 * conf);
      out.push(Object.assign({}, it, { score: Math.round(score * 1000) / 1000, textScore: text }));
    }
    out.sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.id).localeCompare(String(b.id)));
    return out.slice(0, limit);
  }

  return { normalize, tokens, terms, stem, rank, textScore, STOP, GROUPS };
});
