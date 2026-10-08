# ALISA Phase 4.1 — Android Foundation

**Status: FOUNDATION ONLY. NOT COMPILED. NOT RUN. NOT TESTED ON A DEVICE. NOT production-ready.**
The authoring environment had no Kotlin compiler, Gradle, Android SDK or network, so none of the Kotlin below has been compiled or executed.
Only static checks were possible (brace balance, forbidden-API/loop/permission greps, core-purity grep). First real compile = the optional CI job (see "How to build from a phone").

Baseline: **ALISA 3.1.1 (PWA) is frozen.** Phase 4.1 adds `android/`, `.github/workflows/android-ci.yml` and this file. No PWA file was edited by this phase.
Branch: `phase4.1-android-foundation` (copy of the voice-model-test build; `sw.js` model-cache fix and untracked `models/`, `vendor/` are carried over unchanged from the 3.1.1 test build).

## Layers
```
CURRENT WEB/PWA LAYER (unchanged)            NEW ANDROID LAYER (android/)
 index.html, security.js, alisa-*.js          :app  Compose UI, ViewModels, Android implementations
 Brain / Agent Core / Memory / Knowledge      :core pure Kotlin/JVM: state, security, permissions, resources,
                                                    bridge interfaces, voice/intelligence interfaces, status, personality
        └────────── ALISA Intelligence ──────────┘   (Android reaches it ONLY via AlisaApplicationInterface — NOT connected in 4.1)
```
Two Gradle modules instead of seven: `:core` (no Android types, JVM-testable) and `:app`. The suggested names map to packages (`core.security`, `core.resources`, `core.bridge`, `core.data`; Android implementations in `app/.../bridge`, `app/.../data`). Split into more modules later if needed.

## What exists
| Area | Implementation |
|---|---|
| State | `AlisaState` Idle/Listening/Thinking/Speaking/Error + `Extension(id)`; `AlisaStateMachine` with a pure reducer. UI only observes. |
| Navigation | `AlisaDestinations.all` registry (Home, Chat, Memory, Knowledge, Agents, Vision, Status, Settings). Add a screen = add one line. Memory/Knowledge/Agents/Vision are honest "Not implemented" placeholders. |
| Android bridge | Interfaces `AndroidBridge{permissions, microphone, lifecycle, notifications, deviceCapabilities}`; read-only/diagnostic. No action surface. |
| Permissions | `PermissionManager`: NOT_REQUESTED / GRANTED / DENIED / PERMANENTLY_DENIED (+ NOT_AVAILABLE for undeclared). Requests only on an explicit "Allow" tap in Settings. |
| Security | `SecurityManager`, `SensitiveActionGate` (exhaustive, fail-closed), `LockCapability` LOCKED/UNLOCKED/RESTRICTED_VOICE_MODE/FULL_INTERACTION_MODE, `AuthenticationProvider` seam (Phase 4.1 = `NoAuthenticationProvider`, permanently NOT_AUTHENTICATED). |
| Resources | `ResourceMonitor` (event-driven: battery broadcast, network callback, thermal listener API 29+, onTrimMemory, storage sampled once per start) → `OperatingModePolicy` → ACTIVE/BACKGROUND/LOW_POWER/CRITICAL/MAINTENANCE. Mode is only reported; nothing is throttled yet. |
| Lifecycle | Monitor starts in `onStart`, stops in `onStop`; auth cleared on background/lock. No service, no loop. |
| Data | `LocalStore` (SharedPreferences, `allowBackup=false`). Stores permission-request flags and personality profile only. Web memory is not read or migrated. |
| Intelligence bridge | `AlisaApplicationInterface` + `NotConnectedIntelligence` (returns NOT_AVAILABLE; never invents an answer). |
| Voice | `VoiceInput`, `VoiceOutput`, `WakeManager`, `SpeakerAuthentication` interfaces; all `NotImplemented*`. |
| Personality | Same 7 moods as web; presentation hints only; package never imports security/permissions/bridge/intelligence (unit-tested). Stored locally, not applied yet. |
| Status | `StatusReporter` builds from real inputs; unbuilt features report `NOT_IMPLEMENTED`, intelligence `NOT_CONFIGURED`. |
| Settings | Security, Voice, Permissions (functional), Appearance, Personality, Resources, Notifications, Privacy, About. Unbuilt rows say "Not implemented in Phase 4.1". |
| Errors | `AlisaResult` Success/Failed/Cancelled/RequiresPermission/RequiresAuthentication/NotAvailable; `safeCall` never propagates exception text. |

## Security boundaries (what 4.1 deliberately cannot do)
Declared permissions: `RECORD_AUDIO`, `POST_NOTIFICATIONS` (neither requested at startup), `ACCESS_NETWORK_STATE` (normal, read-only; needed to observe network availability). No INTERNET, location, contacts, SMS/phone, exact alarms, foreground service, overlay, accessibility, device-admin, keyguard APIs. `isKeyguardLocked` is read-only. No lock-screen bypass, no automation, no calls/SMS/finance, no Salah/Zikr/Quran, no autonomous or background behaviour.
Typed chat is `PUBLIC` (no voice verification) but still refuses on a locked device. Anything `SENSITIVE` needs authentication that cannot be obtained in 4.1, so it fails closed. `FORBIDDEN` is always denied.
Android Strict Voice Lock / PIN are **not implemented** and not claimed. The web versions are untouched.

## Tests (written, NOT executed)
`:core` JVM unit tests (`gradle :core:test`): state machine, results/error-leak, permissions, security gate/manager, resource policy/manager, status honesty, personality, bridge surface, local store, placeholders.
`:app` instrumented Compose tests (`androidTest`): start screen/orb, navigation, placeholders, chat "not connected", stateless Home states. Need an emulator/device.
No static analysis tool (ktlint/detekt) is configured; Android lint runs in CI.

## How to build from a phone (no PC)
Push the repo to a **separate** GitHub repo (not the production repo) from Termux; the workflow `android-foundation-ci` runs `:core:test`, `:app:assembleDebug`, `:app:lintDebug`, compiles the instrumented tests and uploads the debug APK + reports. The Gradle wrapper JAR could not be generated offline, so CI uses `gradle-version: 8.9`; locally run `gradle wrapper` once. Expect first-compile fixes: this code has never been through a compiler.

## Known limitations
1. Never compiled/run; dependency versions (AGP 8.7.3, Kotlin 2.0.21, Compose BOM 2024.12.01, Navigation 2.8.5, Lifecycle 2.8.7, Activity 1.9.3, Coroutines 1.9.0) were chosen from memory, unverified.
2. No Gradle wrapper JAR.
3. Chat has no brain; nothing is answered. 4. Voice/wake/speaker auth/TTS absent. 5. Android lock/PIN absent.
6. `shouldShowRationale` needs a live Activity; PERMANENTLY_DENIED is inferred (requested before + no rationale), which also covers "revoked later".
7. Resource thresholds (battery 15/5 %, 256 MB storage) are untuned placeholders. 8. Launcher icon reuses `alisa-192.png` unadapted.
9. No real-device testing of any kind.

## Future integration points
`AlisaApplicationInterface` (embedded web runtime vs local service vs remote API — undecided), `AuthenticationProvider` (port of Strict Voice Lock one-time 25 s grant), `SpeakerAuthentication`, `WakeManager`, `ResourceManager.mode` consumers, `AlisaDestinations.all`.
