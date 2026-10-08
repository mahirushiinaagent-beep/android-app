# ALISA — cloud PWA deployment

## Environment variables
| Variable | Required | Meaning |
|---|---|---|
| `PORT` | no | Provided by the host. Default `8787` locally. |
| `HOST` | no | Default `0.0.0.0` (cloud). Use `127.0.0.1` to run localhost-only. |
| `NODE_ENV` | yes (cloud) | Set `production`. Makes `ALISA_TOKEN` mandatory. |
| `ALISA_TOKEN` | yes (cloud) | Your **access code**, ≥16 chars. You type it once in Settings → Sign in. Changing it signs out all devices. |
| `GEMINI_API_KEY` | yes for online AI | Google AI Studio key. Stays on the server; never sent to the browser. |
| `DATABASE_URL` | **yes for durable memory** | Neon (PostgreSQL) connection string. If unset, ALISA falls back to JSON files (lost on Render free restarts). Server-side only. |
| `ALISA_DATA` | no | Folder for the JSON fallback and for the one-time legacy import. Default `./data`. |
| `ALISA_SKIP_JSON_IMPORT` | no | `1` = do not import legacy JSON into the database. |
| `TOMBSTONE_DAYS` | no | Days deletion markers are kept (default 60, min 7). |
| `PG_POOL_MAX` | no | Max DB connections (default 5). |
| `TRUST_PROXY` | yes behind a host proxy | Set `1` so rate limiting sees real client IPs (otherwise everyone shares one bucket). |
| `GEMINI_MODEL` | no | Force a Gemini model to be tried first. |
| `ALLOW_DIRECT_GEMINI` | dev only | `1` lets the browser call Google directly (loosens CSP). Leave unset. |

## Build / start
- Build: `npm install` (installs `pg`, used only when `DATABASE_URL` is set)
- Tests: `npm test` (no database or network needed)
- Start: `npm start` (= `node server.js`)
- Local (PC only): `HOST=127.0.0.1 ALISA_TOKEN=some-long-code GEMINI_API_KEY=... node server.js` → http://localhost:8787
  (PowerShell: `$env:HOST="127.0.0.1"; $env:ALISA_TOKEN="..."; node server.js`)

## Deploy on Render (free)
1. Put the project in a **private** GitHub repo. `.gitignore` already excludes `data/`, `.env`, `*.log`. If `data/token` was ever committed anywhere, treat it as leaked.
2. Render dashboard → **New → Web Service** → connect the repo.
3. Runtime **Node**, Build Command `npm install`, Start Command `npm start`, Instance type **Free**, Health Check Path `/api/health`.
4. Add env vars: `NODE_ENV=production`, `TRUST_PROXY=1`, `ALISA_TOKEN=<your code>`, `GEMINI_API_KEY=<your key>`, and `DATABASE_URL=<Neon connection string>` (next section).
5. Deploy. Your URL is `https://<name>.onrender.com` (HTTPS is automatic). Check `https://<name>.onrender.com/api/health` → `{"ok":true,...}`.
(`render.yaml` is included if you prefer New → Blueprint.)

**Free-tier reality:** the service sleeps after 15 min idle (first request then takes ~1 min), and its filesystem is wiped on every sleep/restart/redeploy. That is why durable memory lives in Neon (below), not on Render's disk.

## Durable memory with Neon (PostgreSQL)
1. Create a free project at neon.com (check their current free-plan limits on their pricing page). Pick a region near your Render region.
2. Dashboard → **Connect** → enable **Connection pooling** → copy the connection string. It looks like `postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require`. Keep `sslmode=require`.
3. Render → your service → **Environment** → add `DATABASE_URL` = that string (secret; never commit it, never put it in the browser). Save → redeploy.
4. Check the Render log for `storage: PostgreSQL` and `https://<n>.onrender.com/api/health` → `"storage":"postgres"`.
5. Neon suspends idle compute; the first query after a pause can take a second or two. ALISA retries connection errors automatically.

**Tables** are created automatically on startup (`alisa_items`, `schema_migrations`). No manual SQL needed.

**Migrating existing server memory (one time, automatic):** on the first start with `DATABASE_URL`, if the database is empty and `ALISA_DATA` contains `memories.json` / `knowledge.json`, they are imported once in a single transaction and the fact is recorded in `schema_migrations` (`legacy-json-import-v1`). It never runs again, so deleted memories cannot reappear later. To skip it, set `ALISA_SKIP_JSON_IMPORT=1` before the first start. On Render's free tier the JSON files are usually already gone, and that is fine: your phone still has its own copy (below).

**Getting your phone's memories into the database:** open ALISA → Settings → ALISA BRAIN → sign in → **Memory → server**. This uploads what is on the phone and from then on keeps phone and server in sync. The phone keeps an offline IndexedDB copy; changes made offline are sent when you are back online.

**Rollback:** remove `DATABASE_URL` and redeploy → ALISA uses JSON files again (the phone's own copy is untouched). Data written to Neon is not copied back automatically. Tag `alisa-v10` is the last version before this feature.

**Privacy:** memories are stored unencrypted in your Neon database (Neon encrypts disks at rest; anyone with the connection string can read them). "Share memory with cloud AI" stays OFF by default, and memories marked 🔒 private are never sent to Gemini even when it is ON.

**Sync rules:** the server's clock decides `updatedAt`. If two devices edit the same memory, the server's version is kept and the other edit is saved as a new memory tagged `conflict`. A memory forgotten on one device is forgotten everywhere (deletion markers are kept `TOMBSTONE_DAYS`, default 60 days; a phone that stays offline longer than that and then edits a deleted memory could bring it back).

## Open ALISA on the Redmi Note 14
1. In **Chrome** (not Mi Browser), open your `https://<name>.onrender.com` URL. Wait up to a minute if it was asleep.
2. Allow the microphone when asked.
3. Open Settings (sliders icon) → **ALISA BRAIN** → type your access code → **Sign in**. The code is not stored; only an expiring session token is.
4. Say "Alisa online mode" if the brain is asleep, then talk to ALISA.

## Install as a PWA
Chrome ⋮ menu → **Install app** (or **Add to Home screen**) → Install. ALISA opens full-screen from the home-screen icon. Reload once online after the first visit so the service worker caches the shell.

## Memory
Default: memory lives on the phone (IndexedDB). Settings → **Memory → server** syncs it with the server (PostgreSQL if `DATABASE_URL` is set, otherwise JSON files); **Memory → this phone** switches back. Offline changes are queued and synced automatically.

## Optional: neural voice verification
`security.js` looks for `vendor/ort.min.js` (+ wasm) and `models/speaker.onnx`. They are not in the project. To enable: on a PC run `npm run setup:voice`, then commit `vendor/` and `models/` and redeploy, then re-enroll your voice. Without them ALISA runs in its built-in low-assurance mode (sensitive commands need your passcode) and the browser console shows one 404 for `vendor/ort.min.js`. This is never run at server startup.

## Developer-only direct-key mode
Run the server with `ALLOW_DIRECT_GEMINI=1`, then in the browser console `localStorage.setItem('alisa-dev-direct','1')` and reload. Settings shows the old Gemini-key box. Never do this on a public deployment.

## Semantic memory (Phase 2, optional)
ALISA can find memories and notes by *meaning* (e.g. "what UI style do I like?" → "I prefer midnight AMOLED interfaces") using a small embedding model that runs **on the phone** (onnxruntime-web). Nothing is sent anywhere to compute it.

Without the model files ALISA works exactly as in Phase 1: keyword search, with Settings → ALISA MIND showing "○ Using fallback retrieval". It never pretends otherwise.

To enable (same pattern as the voice model):
1. On a PC with internet, in the ALISA folder: `npm run setup:semantic` (downloads `vendor/ort*` if missing — shared with speaker verification — plus `models/embed/model.onnx` and `models/embed/vocab.txt`, ~23 MB; the default URLs are unverified, pass `--model <file> --vocab <file>` if one 404s).
2. Commit `vendor/` and `models/` and redeploy. (Nothing else changes on Render; no new env var.)
3. Reload ALISA twice. Settings → ALISA MIND shows "○ Initializing…" while the model loads and your memories are indexed in the background, then "● Ready".
4. Tap **Test semantic** there to run a built-in check of the real model (3 same-meaning queries + 2 unrelated ones). If it reports failures, the thresholds in `alisa-semantic.js` (`SEMANTIC_MIN` etc., see `ALISASemantic.configure`) need tuning for your model.

Notes: the first load downloads the model once and caches it (Cache Storage), so it then works offline. The index lives in the phone's IndexedDB (`alisa-semantic`), is never sent to the server or exported, and is rebuilt automatically after an import or a model change. The model is English-only (Hindi/Hinglish still rely on keyword + synonym matching). **Semantic on/off** in the same panel turns it off to save battery/data. Memories marked 🔒 private are indexed locally (vectors never leave the phone) and are still never sent to Gemini.

