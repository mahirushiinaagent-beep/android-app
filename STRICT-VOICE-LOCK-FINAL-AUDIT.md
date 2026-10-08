# ALISA Phase 3.1.1 — Strict Voice Lock: FINAL AUDIT

## Verdict: YELLOW
All automated tests and both browser suites pass, but (a) the neural speaker model files could NOT be obtained here, so Strict Voice Lock cannot grant anything until they are installed, and (b) no real-device owner-vs-other-speaker testing has been done.

## 1. Baseline
Your uploaded `alisa-pwa-phase3_1-agent-core.zip` (git `main` @ 4708233, "Phase 3.1: Agent Core foundation", version 11.1.0-phase3.1-dev). Committed on top as one commit and tagged `alisa-phase3.1.1` (earlier tags/history kept). `package.json` version string was intentionally left unchanged.

## 2. Files changed
- `security.js` (modified)
- `index.html` (modified)
- `test/strict-voice-lock.test.js` (new)
- `test/agent-wiring.test.js`, `test/command-processor.test.js` (one stub line each: `authorizeVoiceCommand` / `invalidateVoiceAuth` added to the `SEC` test double; no assertions changed or removed)
- `STRICT-VOICE-LOCK-FINAL-AUDIT.md` (this report)

## 3. Security behavior added
- `security.js`: `grantMs` (25 s); `createVoiceGrant` (only for verified + neural + not low-assurance + no replay flags); `hasVoiceGrant`; `strictActive` (default ON; stays ON if the profile can't be read); `authorizeVoiceCommand` (consumes the grant on first look; denies otherwise with code `VOICE_AUTH_REQUIRED`); `setStrictVoiceLock` (turning OFF requires the existing backup passcode with the existing lockout; impossible with no profile; turning ON needs nothing); `invalidateSession` also clears the grant; `verifySpeaker`/`verify` clear any grant at the start; `info()` reports `strict`; `invalidateVoiceAuth` exported. `askPin`, PIN hashing, thresholds, replay checks unchanged.
- `index.html`: `commandProcessor` = gate (`SEC.authorizeVoiceCommand()` → `try { commandProcessorInner } finally { SEC.invalidateVoiceAuth() }`); `commandProcessorInner` = the previous body, same ordering (credential stop → Brain control → ALISACommands → memory commands → sensitive gate → Agent → Brain); spoken requests to change voice security are refused deterministically before any Brain/Agent/tool/memory handler; `strictVoice0` replaces voice start (max 3 attempts, then Voice mode ends); `listenNow` refuses to listen without a grant; `stopVoice` clears authorization; new "Strict Voice Lock" Settings switch (off → passcode).

## 4. Test results
- `npm test`: **382 pass, 0 fail** (baseline 356; +26 in the new file / 1 file-level count).
- Syntax checks: all `.js` files and the inline script of `index.html` pass `node --check`.
- Your 15 required tests, by coverage in `test/strict-voice-lock.test.js`: 1 owner one-command (A); 2 second command denied (B + routing test); 3 unknown speaker (C); 4 low confidence (D); 5/15 no neural model (E); 6 failed verification clears grant ("a FAILED verification attempt clears…"); 7 cancellation (G) and command failure (F); 8 leaving Voice (stopVoice test); 9 voice cannot disable (H); 10 agent tools/modules cannot touch security (H2); 11 typed chat (I); 12 one-time consumption (B); 13 timeout (expiry test, simulated clock); 14 replay-flagged denied (K). Also: privacy (L), PIN recovery (J), no-profile can't disable.
- No test was weakened or removed.

## 5. Browser tests
Playwright/Chromium was available: `pin.test.py` 31/31, `agent-ui.test.py` 59/59. These do not exercise real microphone verification.

## 6. Neural model files present?
**No.** The upload contained no `models/` or `vendor/`.

## 7. `npm run setup:voice` succeeded?
**No.** This environment has no outbound network (HTTP 403 on onnxruntime-web and the speaker model). Nothing was fabricated; the ZIP has no placeholder model. Run `npm run setup:voice` on a PC with internet (or `node setup-voice-models.js --model <file>`), commit `vendor/` + `models/`, redeploy, reload twice, and re-enroll. Until then every voice command is denied (by design); typed chat still works.

## 8. Known limitation (retained)
Verification audio is separate from command audio. A different person may potentially speak the command immediately after the owner's successful verification, during the short authorization window (25 s). Strict Voice Lock does NOT give perfect protection against that. Command-audio speaker verification is a separate future phase and was not attempted.

## 9. Intentionally NOT changed
`sw.js` (network-first; no new files; cache version stays `alisa-v14`), `server.js`, Agent Core, Planner, Tool Registry, Risk Gate, Intent, Personality, Brain, Memory/Mind, retrieval/semantic, commands.js, `askPin`, thresholds, replay heuristics, typed-chat code path, all other tests.

## 10. Other notes
- Thresholds are still the original uncalibrated placeholders; neural-path tests use a stub embedding chosen by the test (real audio-quality, replay and threshold code runs).
- While Strict is ON, the older "Require speaker verification" switch has no effect on voice start.
- The existing "Phase 2.5 byte-identical" test skips itself (baseline folder not in the upload).
- Each voice command is preceded by a ~3.5 s verification.

## Manual real-device checklist
1. Install neural files, redeploy, re-enroll; Settings → My Voice shows Neural, Strict Voice Lock ON.
2. Owner verifies → one command works; the next command re-verifies first.
3. Other people speak the verification phrase → NOT RECOGNIZED, nothing runs.
4. Owner verifies, someone else speaks the command → record result (known limitation).
5. Recording of owner played from another phone → denied.
6. "Turn strict voice lock off" by voice → refused. Settings switch: wrong passcode stays ON; correct passcode turns OFF.
7. Time, calculator, memory recall, notes search, add task, diagnostics → each needs its own verification.
8. Typed chat works without verification. Tap away mid-command → fresh verification required.
