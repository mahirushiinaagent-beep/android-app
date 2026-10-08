# 🟡 ALISA 3.1.1 — VOICE MODEL TEST BUILD (implementation report)

**Status: TEST BUILD. NOT green. NOT production-validated.**
**READY FOR ANDROID TESTING: NOT YET.** The code is ready, but this ZIP contains **neither the speaker model nor the ONNX Runtime files** (see §3). Install them first (steps below), then run the Android checklist.

Separate build: git branch `voice-model-test` (tag `alisa-phase3.1.1-voice-model-test`) on top of the frozen 3.1.1 commit `b3f17de`. The frozen 3.1.1 project/ZIP was not modified.

## 1. Inspection findings (before changes)
- `security.js` loaded `vendor/ort.min.js` lazily, set `wasmPaths=<origin>/vendor/`, `numThreads=1`, WASM provider, fetched `models/speaker.onnx`, and cached it **permanently** in Cache Storage `alisa-speaker-model` (never re-validated). The model was **not** hash-checked; nothing validated its input/output; a "neural" profile carried no model identity.
- `server.js` already allow-listed `models/speaker.onnx`, the three `vendor/` runtime files, with `application/octet-stream` / `text/javascript` / `application/wasm`; CSP already has `'wasm-unsafe-eval'`. `sw.js` ignores `/models/`; `/vendor/` is cached network-first. No COOP/COEP is sent.
- `setup-voice-models.js` did no integrity/size/compat check.

## 2. Files
**Changed:** `security.js`, `index.html` (2 text strings), `setup-voice-models.js`, `package.json` (version `11.1.1-voice-model-test`), `test/strict-voice-lock.test.js` (synthetic stub now declares its fake model identity + `outputNames`).
**Added:** `test/voice-model.test.js`, `VOICE-MODEL-TEST-BUILD.md`.
**Not changed:** `sw.js`, `server.js`, thresholds, ALISA front end (log-mel), enrollment sample logic, replay checks, PIN/hash code, Strict Voice Lock/grant logic, Agent Core, Risk Gate, Brain, Memory, typed chat.

## 3. Model / runtime installation — what could and could not be done here
- **Model SHA-256 verified? NO (not here).** The file `voxceleb_resnet34_LM.onnx` was not in my environment and I have no network. The pinned values (`7bb2f06e…ec068`, 26,530,309 bytes) are taken from your instruction; I could not confirm they belong to the official file. The code enforces them.
- **ONNX Runtime 1.20.1 files: NOT installed here** (no network). No placeholders were created.
- Install on a PC (inside the project folder):
  ```
  node setup-voice-models.js --model "C:\path\voxceleb_resnet34_LM.onnx"
  node setup-voice-models.js --verify
  ```
  The script now **refuses and writes nothing** unless size = 26,530,309 and SHA-256 = the pinned value, then downloads the three ORT 1.20.1 files (sanity-checked only: no pinned hash is known for them). `--verify` re-checks what is installed. Then commit `models/` + `vendor/`, redeploy, open the app twice, Settings → My Voice must show **MODEL_READY**, then **re-enroll**.
- Optional offline check first: the earlier `inspect_speaker_model.py`.

## 4. What the code now does
- **Pinned model:** every load checks size + SHA-256 (WebCrypto) of the bytes actually used — from network *and* from cache.
- **Validation before "ready":** ORT present → session created → exactly one named input → ≥1 output → a deterministic probe run with `[1,200,80]` float32 → output must be exactly **256** finite, non-zero values. Only then `state='loaded'`, `MODEL_READY`. Otherwise one of `MODEL_NOT_FOUND`, `MODEL_HASH_MISMATCH`, `ORT_NOT_LOADED`, `MODEL_LOAD_FAILED`, `MODEL_INPUT_INVALID`, `MODEL_INFERENCE_FAILED`, `MODEL_OUTPUT_INVALID`; the method stays `fallback`, so **no grant can ever be created → Strict Voice Lock stays locked**. The embedding is re-validated on every enrollment/verification call; a model error stops enrollment / returns "unavailable" (no crash, no pass).
- **Cache handling (only change):** a cached model whose hash differs is deleted (that single entry) and re-fetched with `cache:'no-store'`; a network file that fails the hash is never cached. No other cache/storage is touched. No cache-name bump needed.
- **Enrollment binding:** new profiles record model id, SHA and dimension. A profile with a different/missing model identity or wrong length is rejected with `PROFILE_MODEL_MISMATCH` ("please re-enroll your voice"); voice mode exits immediately with RE-ENROLL VOICE (no pointless retries). Profiles are never compared across models. *Unchanged behavior:* with no neural model, enrollment still creates the old low-assurance fallback profile (Phase 2.5 behavior); under Strict Voice Lock it can never authorize voice commands.
- **Thresholds untouched** (neural 0.55 / 0.40, uncalibrated placeholders). **Front end untouched.**
- **Diagnostics/logging:** in-memory ring of codes + timestamps only (`MODEL_READY`, model failure codes, `MODEL_CACHE_INVALIDATED`, `VERIFICATION_STARTED/REJECTED/SUCCESS`, `GRANT_CREATED/CONSUMED/EXPIRED`, `VOICE_AUTH_DENIED`), plus model-load and last-inference timings, shown in Settings → My Voice (also the first 12 hex chars of the model SHA). No audio, embeddings, transcripts, PIN or tokens. Nothing persisted.
- **Safety of the test hook:** the model-identity override (`dev.model`) is honoured only when `CFG.devMode` is true (default false; a test asserts it).

## 5. Tests
| | Count |
|---|---|
| `npm test` | **410 tests: 409 pass, 0 fail, 1 skipped** (baseline 382; +28 in `voice-model.test.js`) |
| skipped | "REAL FILE" test — runs only when `models/speaker.onnx` is installed |
| Browser (Chromium) | `pin.test.py` 31/31, `agent-ui.test.py` 59/59 |
| Syntax | all JS + inline script of `index.html` OK |
| Mutation check | removing the hash check, profile binding, finite check, or stale-cache drop each makes the new tests fail (4 / 2 / 3 / 1 failures) |
| HTTP check | on a throwaway copy with dummy files: model → 200 `application/octet-stream`; ORT `.js`/`.mjs` → `text/javascript`; `.wasm` → `application/wasm`; unknown `/models/x` → 404 |

Your 17 requested tests: 1–2 hash accept/reject · 3 missing · 4 ORT missing · 5 load failure · 6 input mismatch · 7 output mismatch · 8 NaN · 9 Infinity · 10 256-d embedding · 11 stale cache · 12 incompatible enrollment · 13–15 grant success/consumed/expired · 16 voice can't disable lock and 17 typed chat unaffected (existing `strict-voice-lock.test.js` routing tests + a new source check).
**All model tests are SYNTHETIC**: ONNX Runtime and the "model" are stubs. They test ALISA's code paths, not the real model, not biometrics.

## 6. Automated vs. real
**AUTOMATED (done):** code paths, fail-closed behavior, hash/cache/enrollment logic, grant handling, privacy of events.
**NOT DONE — requires the real model on the real Android phone:** model loads in the browser WASM runtime (and in 1.20.1 without SharedArrayBuffer/COOP-COEP — untested), op support, ALISA front end vs the model's training front end (approximate Kaldi fbank — unverified), score distributions vs the placeholder thresholds, owner/other-speaker accuracy, replay behavior, microphone quality, load time, inference time, memory, heat/battery. **Model load/inference time and memory were NOT measured** (no device); the build now *displays* load/inference times for you to read off.

## 7. Android test procedure (≈20 min)
Prereq: files installed per §3, deployed, app opened twice, Settings → My Voice shows `MODEL_READY` (note load ms), Strict Voice Lock ON, **re-enroll** (quiet room, 5 phrases). Write down scores shown under "Last verification" each time.
- **A Owner:** Voice → say the phrase → VERIFIED; then one command (e.g. "what time is it") runs. Repeat 5×; note scores and any rejection (a high owner-reject rate means thresholds/front end need work — report, don't loosen).
- **B Other speaker:** 3 different people try → each NOT RECOGNIZED, no command runs. Note their scores.
- **C Replay:** play a recording of yourself from another phone near the mic → must NOT give a grant (note result/score/flags; replay heuristics are not proof).
- **D One-time grant:** verify, run one command (works); immediately speak another → ALISA re-verifies first; it must never answer on the old check.
- **E Leave Voice:** verify, exit Voice, re-enter and speak → fresh verification required.
- **F Typed chat:** works with no verification.
- **G Model failure:** on the deployed server temporarily rename `models/speaker.onnx` (or block the URL in Chrome DevTools), reload → My Voice shows `MODEL_NOT_FOUND` (not "ready"); Voice says VOICE LOCKED; no command runs; typed chat still fine. Also try enrolling with the wrong file name/content: setup must reject it. Restore afterwards.
- **H Re-enroll rule:** (if you ever swap the model) old profile → RE-ENROLL VOICE.
- **Performance:** note model load ms, last-check ms, battery/heat after ~20 verifications, any browser slowdown. There are no background loops; the model runs only during a verification.
- Chrome DevTools (remote debugging) → Application → Cache Storage `alisa-speaker-model` should hold exactly one ~25 MB entry.

## 8. Known limitations / warnings
1. Verification audio ≠ command audio: another person could speak the command right after the owner passes, within the 25 s grant window. Unchanged; future phase.
2. Thresholds (0.55/0.40) are placeholders and may not suit this model; possible front-end mismatch. If owner verification fails, report the scores — calibrate in a separate task.
3. ORT files have no pinned hash (only the model does).
4. Hashing the 26 MB model happens once per page load (WebCrypto); cost unmeasured on the phone.
5. `PROFILE_MODEL_MISMATCH` also applies to any neural profile created before this build.
6. The "fails on input/inference" distinction uses keywords in the runtime's error text (heuristic); either way it fails closed.

## 9. Final
🟡 **ALISA 3.1.1 — VOICE MODEL TEST BUILD.** Becomes 🟢 only after the real-device results above are in and acceptable.
