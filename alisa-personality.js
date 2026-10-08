/* ALISA PERSONALITY / MOOD FOUNDATION (Phase 3.1) — window.ALISAPersonality. A deliberately tiny interface so later phases can grow it safely.
   States: NEUTRAL · CALM · FOCUSED · CURIOUS · PLAYFUL · HAPPY · CONCERNED.
   Mood may only change HARMLESS PRESENTATION: a short lead-in phrase and an optional tone hint for wording.
   HARD BOUNDARIES (enforced by construction, covered by tests):
   - This module does not import, reference or call the risk gate, tool registry, security module or Agent Core. It has no way to run a tool, grant a permission,
     change a risk level, skip a confirmation or make a security decision. Safety Core always has priority.
   - decorate() never changes the status of a result, never removes or rewrites the factual text, and for any non-SUCCESS status it only ever ADDS a neutral/empathetic
     lead-in that contains no success wording — a failure can never be dressed up as success.
   - Mood text input is untrusted: it can only select one of the seven labels. */
(() => {
  'use strict';
  const STATES = Object.freeze(['NEUTRAL', 'CALM', 'FOCUSED', 'CURIOUS', 'PLAYFUL', 'HAPPY', 'CONCERNED']);
  // existing UI moods (index.html: calm, happy, playful, loving, focused, sleepy) → foundation states
  const LEGACY = Object.freeze({ calm: 'CALM', happy: 'HAPPY', playful: 'PLAYFUL', loving: 'HAPPY', focused: 'FOCUSED', sleepy: 'CALM' });
  const TONE = Object.freeze({ NEUTRAL: 'plain', CALM: 'soft', FOCUSED: 'brief', CURIOUS: 'inquisitive', PLAYFUL: 'light', HAPPY: 'warm', CONCERNED: 'gentle' });
  const LEAD = Object.freeze({   // lead-ins: [on SUCCESS, on any other outcome]. Non-success lead-ins never contain success words.
    NEUTRAL: ['', ''], CALM: ['', ''], FOCUSED: ['', ''], CURIOUS: ['', ''],
    PLAYFUL: ['Sure thing! ', 'Hmm, '], HAPPY: ['Happy to help! ', 'Oh no, '], CONCERNED: ['', 'I’m sorry — '],
  });
  let state = 'NEUTRAL', since = Date.now();
  const lang = () => { try { return localStorage.getItem('alisa-lang') || 'en'; } catch (e) { return 'en'; } };
  const api = {
    version: 1, STATES, LEGACY, TONE,
    get: () => state,
    tone: () => TONE[state],
    set(s, meta) { const k = String(s || '').toUpperCase(); if (!STATES.includes(k)) return false; state = k; since = Date.now(); try { window.dispatchEvent(new window.CustomEvent('alisapersonality:change', { detail: { state: k } })); } catch (e) {} return true; },
    fromLegacy(m) { const k = LEGACY[String(m || '').toLowerCase()]; return k ? api.set(k) : false; },
    info: () => ({ state, tone: TONE[state], since }),
    // Adds a harmless lead-in; returns the original text untouched for non-English output or anything that already starts with a lead-in.
    decorate(text, o = {}) {
      const t = String(text == null ? '' : text); if (!t || lang() !== 'en') return t;
      const ok = o.status === 'SUCCESS', lead = LEAD[state][ok ? 0 : 1]; if (!lead) return t;
      if (/^(?:sure thing|happy to help|oh no|hmm|i’m sorry)/i.test(t)) return t;
      return lead + (/^[A-Z]/.test(t) && !/^(?:I|I’|I')/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);
    },
  };
  window.ALISAPersonality = Object.freeze(api);
})();
