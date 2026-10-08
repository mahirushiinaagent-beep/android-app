# ALISA 3.1.1 VOICE MODEL TEST BUILD — STATUS: 🟡 YELLOW

Branch `voice-model-test` @ `c44c9e9` (base = frozen 3.1.1 `b3f17de`, untouched). No commit made this step: `models/` and `vendor/` are untracked working-tree files. NOT DEPLOYED.

## ORT (supplied by you in Ort_run.zip; installed into vendor/ only)
| file | bytes | SHA-256 |
|---|---|---|
| ort.min.js | 446,284 | be6e560b64c03c99252eedc0e1989e9e51e44d9f191e7655c9bf011bf9f576c8 |
| ort-wasm-simd-threaded.wasm | 11,246,032 | 207d02be4591c156b0a98f024f3d58005b5b04c92274d759fb390338c63559ea |
| ort-wasm-simd-threaded.mjs | 24,618 | 745eb7c0ce6f18a6aa521971b2877babc7ffb27eecb58ab3bc6e5ef4692672e8 |
Version evidence: `ort.min.js` banner "ONNX Runtime Web v1.20.1" and two embedded constants `"1.20.1"`; the WASM has valid magic and embeds the version string `1.20.1`; the MJS is a real Emscripten ES-module loader (not HTML). At runtime in Chromium `ort.env.versions.common` reported `1.20.1`. I could not compare the hashes with the official npm package (no network), so identity rests on these indicators plus the working run, not on a checksum match.
Config confirmed (unchanged): `wasmPaths = <origin>/vendor/`, `numThreads = 1`, `executionProviders:['wasm']`.

## Model — verified: `models/speaker.onnx`, 26,530,309 bytes, SHA-256 7bb2f06e…ec068 (`--verify`: model OK, vendor OK).

## Tests
- `npm test`: 410 tests, **410 pass, 0 fail, 0 skipped** (same as before; no regression). Syntax checks OK. Chromium suites: PIN 31/31, Agent UI 59/59.
- Server (real `server.js`): all four files 200, correct Content-Type (`application/octet-stream`, `text/javascript; charset=utf-8` ×2, `application/wasm`), sizes/hashes identical to the files on disk, none are HTML.

## Real Chromium (headless, desktop CPU) with the real model and ORT 1.20.1 — the app's own loader
- ORT loaded from /vendor: YES. Model loaded + validated: YES (`MODEL_READY`, method neural). First load ≈ 3.4 s (download + SHA-256 + session + probe); with a valid cached copy ≈ 1.5 s.
- Inference on float32 [1,T,80] (random-normal features): T=100 / 200 / 347 / 600 → output [1,256], finite, non-zero, L2-normalises to 1.0, ≈ 0.28 / 0.35 / 0.61 / 1.04 s. No NaN/Inf, no WASM-load error, no unsupported-operator error.
- Console: only the unrelated, pre-existing 404 for `models/embed/vocab.txt` (semantic-search embedder model, not installed; it reports itself unavailable).
- Responsiveness: ORT runs on the main thread (1 thread, no worker): the page was blocked for the whole inference (≈ 0.6 s at T≈347). This is desktop; the Redmi will be slower. NOT measured on the phone. No obvious memory error observed.
- Pipeline (synthetic audio, NOT a microphone) → ALISA JS fbank → speaker.onnx → 256-d → L2 → enroll → verify: executes end to end (profile created "neural", `VERIFIED`, grant created). Informational only: a second synthetic tone with different pitch/formants scored 0.58 vs threshold 0.55 and was held back only by the replay heuristic (status `uncertain`). Synthetic tones are not voices, so this proves nothing about accuracy either way — but if real *other* speakers score near/above 0.55 on the phone, the thresholds/front end need calibration (separate task). Thresholds untouched.

## Cache / enrollment
- Stale-model protection, tested in the browser: a same-size wrong model put into `alisa-speaker-model` was detected (`MODEL_CACHE_INVALIDATED`), dropped and replaced by the exact model (cache hash = pinned hash).
- Binding: enrollment stores model id + SHA + 256; verification in the browser did not raise `PROFILE_MODEL_MISMATCH`; the profile survived reload.
- **Finding (pre-existing, not changed):** `sw.js` `activate` deletes every cache except `alisa-v14`, including `alisa-speaker-model` (and the embedder cache). Effect observed: the first load's cache entry is wiped, so the 26 MB model is downloaded on the first TWO page loads (and again after any service-worker version bump), then served from cache. Not a security issue (the hash is checked on every load; fails closed) but a mobile-data/time cost. Suggested separate fix: whitelist those two cache names in `sw.js` activate.
- Your phone's existing voice profile (if any) was not made with this model → expect "re-enroll your voice" on first use. Nothing was re-enrolled or invalidated by me.

## Security / deployment
Thresholds, Strict Voice Lock, replay logic, PIN logic, `security.js`, model: unchanged this step. NOT DEPLOYED.

## Remaining blockers / NOT TESTED
Real Android: model load in the phone browser, timing/heat/battery, owner / other speakers / replay, microphone quality, one-time grant on device, calibration of 0.55/0.40. No claim of speaker-verification accuracy or security validation is made.

## Next safe step
Deploy this test build to a PRIVATE test URL only when you decide, open it twice, confirm Settings → My Voice shows MODEL_READY, re-enroll, and collect owner / other-person / replay scores with the Android checklist in `VOICE-MODEL-TEST-BUILD.md`.
