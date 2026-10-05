# Intention — Developer Handover
# Intention — Developer Handover

Last updated: for the state at commit `072673c`.

This document is for whoever picks up Intention next. It explains what the app is, how it's built, where everything lives, the non-obvious gotchas we hit, and what's still open. Pair it with `README.md` (user-facing) and `RELEASE_NOTES.md` (per-version changes).

---

## 1. What Intention is

A local-first desktop productivity app built with **Electron** and plain **HTML/CSS/JavaScript** (no UI framework, no bundler for the renderer). It pins to the left quarter of the screen and provides:

- Pomodoro timer with a transparent floating mini-timer
- System-wide greyscale Focus Mode (Windows)
- Distraction logging + end-of-session distraction timeline
- Reflection prompts every 4 work sessions
- A flexible, Teams-style time-blocking calendar (the "Scheduler" page)
- To-do list (tick boxes + completed archive) and a persistent "My 5 Priorities" list
- A History page: pomodoro heatmap + per-day distraction and schedule detail
- A small built-in article reader with text highlighting

All data lives in the renderer's `localStorage`. Nothing is sent anywhere.

---

## 2. Tech stack & how to run

- **Electron** (v31) desktop shell
- **electron-builder** for packaging (.exe via NSIS; .dmg config exists for macOS)
- **PowerShell helper scripts** for the Windows-only Focus Mode
- **GitHub Actions** (`.github/workflows/build.yml`) builds installers on tag push

```bash
npm install --legacy-peer-deps
npm start                 # run in dev
node build.js win         # build Windows .exe  -> dist/
node build.js mac         # build macOS .dmg (must run on macOS)
```

Node 18+ required. On Windows, PowerShell script execution must be allowed; the app launches the helpers with `-ExecutionPolicy Bypass`, so no machine-level change is needed.

---

## 3. File map

```
main.js                 Electron main process. Windows, IPC handlers, Focus Mode
                        orchestration (spawns the PowerShell helpers, polls the
                        foreground window).
preload.js              contextBridge API exposed to the renderer as window.electronAPI.
index.html              Single-page UI. All pages (Timer, Scheduler, History,
                        Articles) live here as .page sections toggled by nav.
mini.html               The transparent floating mini-timer window.
build.js                Build entry (node build.js [win|mac|all]); disables code signing.
package.json            Also holds the electron-builder "build" config.

greyscale-helper.ps1    Persistent PS process. Uses the Windows Magnification API
                        (MagSetFullscreenColorEffect) to greyscale the WHOLE screen.
                        Reads ON / OFF / EXIT on stdin.
foreground-title.ps1    Prints the active window's title (user32 GetForegroundWindow).
list-windows.ps1        Lists visible window TITLES only (user32 EnumWindows).
                        Replaced desktopCapturer to avoid the screen-capture permission.

css/
  style.css       Base, nav, layout, buttons, mini-timer
  timer.css       Timer card, focus mode, reflection modal, distraction timeline
  timeblock.css   To-do list, priorities, the calendar, assign modal, completed archive
  articles.css    Article cards + reader
  history.css     Calendar heatmap + day-detail panel

js/
  app.js          Nav/page switching, localStorage helpers (loadData/saveData),
                  mini-timer visibility, scroll-to-now trigger on the Scheduler page.
  timer.js        Pomodoro logic, focus-mode UI + IPC, distraction logging,
                  reflection, distraction timeline, timer settings, midnight session reset.
  timeblock.js    Priorities, to-do list (+completed archive), and the flexible
                  calendar (drag-select, blocks, assign modal, midnight clear + archive).
  history.js      Pomodoro heatmap, day detail, and the schedule/distraction logs.
  articles.js     Article content, reader, highlighting, quote rotation.
```

**Script load order matters** (set in `index.html`):
`app.js` → `history.js` → `timer.js` → `timeblock.js` → `articles.js`.
`history.js` must load before `timeblock.js` because timeblock's midnight-archive
calls `window.saveScheduleForDay` (defined in history.js). `app.js` must be first
because everything uses its `loadData`/`saveData`.

---

## 4. Data model (localStorage keys)

| Key | Shape | Written by |
|-----|-------|-----------|
| `timerDurations` | `{work, shortBreak, longBreak}` (seconds) | timer.js settings |
| `distractions` | `[{duration, cause, time, date}]` (form log, newest first) | timer.js |
| `reflections` | `[{date, goingWell, improve, energy, distractions, sessionsCompleted}]` | timer.js |
| `taggedDistractions` | `[{date, session, distractions:[{elapsed, tag}]}]` | timer.js timeline |
| `priorities` | `[{text, createdAt}]` (max 5) | timeblock.js |
| `todos` | `[{text, priority, type:'todo'|'break', completed, completedAt?}]` | timeblock.js |
| `timeblocksV2` | `[{id, start, end, task, type}]` (start/end = minutes from midnight) | timeblock.js |
| `pomodoroLog` | `{ 'YYYY-MM-DD': count }` | history.js |
| `distractionDailyLog` | `{ 'YYYY-MM-DD': [{time, cause, tag, duration}] }` | history.js |
| `scheduleLog` | `{ 'YYYY-MM-DD': [{start, end, task, type}] }` | history.js (archived schedule) |
| `lastSessionResetDate` | `toDateString()` | timer.js midnight reset |
| `lastCalendarClearDate` | `toDateString()` | timeblock.js midnight clear |

Note the two date formats in use: history logs use `YYYY-MM-DD` keys; the
"last reset" guards use JS `toDateString()`. Keep them consistent within each feature.

---

## 5. Focus Mode — how the whole-PC greyscale works

This is the most intricate part. Read this before touching it.

- The **whole screen** greyscale uses the Windows **Magnification API** via `greyscale-helper.ps1`, spawned as a long-lived process from `main.js`. The renderer never greyscales itself with CSS (an earlier version did, which only greyed the app — that CSS was removed).
- `main.js` sends `ON`/`OFF` to the helper over stdin. On `EXIT` or if the helper dies, Windows restores color automatically — a deliberate fail-safe so you can never get stuck in grey.
- **Which windows keep color:** the user picks one or more windows (up to one per display; display count comes from Electron's `screen.getAllDisplays()`), then presses **Apply**. `main.js` polls the foreground window title (via `foreground-title.ps1`) roughly once a second; if the active title matches any chosen window it sends `OFF` (color), otherwise `ON` (grey).
- **Window list** comes from `list-windows.ps1` (EnumWindows, titles only). We intentionally do NOT use Electron `desktopCapturer` anymore — it is screen-capture-capable and looked invasive. Titles-only keeps the permission surface minimal.
- **Matching** is bidirectional substring + an app-name-after-last-" - " fallback. Known limitation: switching between two windows of the *same app* (e.g. two Edge windows) can keep color because their titles share a suffix. A stricter exact-match was tried and reverted because it broke when a window's own title changed (e.g. browser tab switches).
- **Hard platform limit:** the Magnification color effect is global to all monitors. You cannot grey one monitor while another stays in color. "One window per display" just means color returns when any chosen window is active.

### Permissions summary (important for trust)
No admin/elevation, no registry writes, no screen capture, no network, no input hooks. Only: Magnification color effect + reading window titles. The one cosmetic caveat is that the app spawns `powershell.exe`, which some antivirus heuristically flags. Compiling the helpers into a tiny native `.exe` would remove that optic (not done yet).

---

## 6. Gotchas & lessons already learned (don't re-break these)

1. **Terminal output in this environment mangles PowerShell.** When scripting git/PS,
   the visible echo is garbled but commands run. Prefer `.ps1` files over long inline
   PowerShell strings — inline here-strings joined onto one line break PowerShell parsing
   (this caused a real bug in the foreground check; it now lives in its own file).

2. **Temporal Dead Zone bugs.** `timeblock.js` runs a midnight-reset IIFE at load that
   calls functions using `selectedBlockId`, `dragSelecting`, etc. Those `let`s must be
   declared ABOVE that code or the whole script throws `ReferenceError` and the calendar
   never renders. This exact bug hit us (commit `072673c`). Keep state declarations near
   the top of the calendar section.

3. **Two functions named `renderCalendar`.** history.js and timeblock.js both load into
   the same global scope. They previously both defined `renderCalendar`, and history's
   (loaded last at the time) clobbered timeblock's, so removing/clearing blocks did nothing
   visible. Timeblock's is now `renderTimeBlockCalendar`. Watch for global-name collisions
   between the JS files — they share one scope.

4. **Modal input focus.** The assign-task modal's custom input needs `stopPropagation` on
   its mouse/key events, otherwise the calendar's global drag-select handlers steal focus
   and you can't type. Same pattern for inline edit inputs.

5. **Modal backdrop dismiss.** The assign modal ignores backdrop clicks for the first
   300ms so the same click that opened it doesn't immediately close it.

6. **Block identity.** Calendar blocks are matched by a stable `id` (`blk_...`), never by
   array index — sorting/re-render reindexes them, and index-based removal deleted the
   wrong block before.

7. **Midnight logic runs both on a timer and on app open.** If the app was closed over
   midnight, the "new day" branch runs on next launch (archive-then-clear). If open, a
   scheduled `setTimeout` fires at 00:00. Both paths archive the day's schedule into
   `scheduleLog` before clearing.

---

## 7. Current repo state

- Branch: `main`. Remote: `https://github.com/sonellmalik/Intention` (public).
- At handover, local `main` was **3 commits ahead of `origin/main`** — these are NOT pushed yet:
  - `bf82777` Updated greyscale focus-mode
  - `99a215a` Add to-do checkboxes with completed archive and save daily schedule to history
  - `072673c` Fix calendar not rendering after midnight reset (TDZ error)
- **Action for next dev:** review and `git push` these. Consider cutting a `v1.2.0`
  release afterward (last published tag is `v1.1.0`).
- Released via GitHub Releases + `gh` CLI. `package.json` version is `1.1.0`; bump it
  before the next installer build so the .exe name matches.
- `dist/` and `node_modules/` are gitignored. `install-log.txt` in the repo root is a
  stray build artifact and can be deleted.

---

## 8. Known limitations / open ideas

- **Focus Mode is Windows-only** (Magnification + PowerShell). macOS/Linux have no
  equivalent wired up. The rest of the app is cross-platform.
- **Same-app window matching** in Focus Mode is fuzzy (see section 5).
- **Not code-signed** — users get a SmartScreen warning; documented in the README.
- **Future direction discussed (not built):** an iOS companion that tracks phone
  pickups via Apple's Screen Time / DeviceActivity APIs, an optional cloud sync
  (Supabase/Firebase) for cross-device data, and a co-working "avatars in the corner"
  presence feature. These would require moving from pure local storage to an optional
  account-based sync (local-first with opt-in cloud was the recommended model).

---

## 9. Quick task recipes

- **Add a new page:** add a `.page` section + a `.nav-link[data-page=...]` in
  `index.html`; page switching is handled generically in `app.js`.
- **Add a persisted setting:** use `saveData(key, value)` / `loadData(key, fallback)`
  from `app.js`; add the key to the table in section 4.
- **Change timer durations/behavior:** `js/timer.js` (`DURATIONS`, session logic).
- **Change calendar hours/granularity:** constants at the top of the calendar section
  in `js/timeblock.js` (`CAL_START_HOUR`, `CAL_END_HOUR`, `SLOT_MINUTES`, `SLOT_HEIGHT`).
- **Touch Focus Mode:** `main.js` (orchestration + polling) and the three `.ps1` helpers.
  Test the helpers standalone first: `powershell -ExecutionPolicy Bypass -File list-windows.ps1`.

---

## 10. Accounts & gating (optional user accounts)

Added as the foundation for future online features (calendar import, live status,
group Pomodoros, chat). **All core features still work with no account** — this
layer is purely additive and the app degrades gracefully when it isn't configured.

### What it does
- Passwordless sign-in via **Supabase email OTP** (a 6-digit code emailed to the user).
- The signed-in session (Supabase access + refresh tokens) is persisted
  **encrypted** by the main process via Electron `safeStorage`, in
  `userData/account-session.enc` — **never** in `localStorage`.
- A declarative gate locks any `[data-requires-auth]` element while signed out
  (dims it + overlays a "Sign in to use" panel) and reveals it when signed in.
- The **Online** nav tab / `#page-online` is the one placeholder gated section today.

### Files
| File | Role |
|------|------|
| `js/vendor/supabase.js` | Vendored Supabase browser SDK (UMD; loads via `<script>`, no bundler). Exposes global `supabase`. |
| `js/auth/supabase-config.js` | **Placeholders** for `SUPABASE_URL` + `SUPABASE_ANON_KEY` (fill these in). `isConfigured()` gates the UI. |
| `js/auth/supabase-client.js` | Thin SDK adapter → `requestOtp` / `verifyOtp` / `signOut` / `setSession` / `onTokenRefresh`. SDK persistence is OFF (we own the session); `autoRefreshToken` ON. `window.SupabaseClient`. |
| `js/auth/auth-state.js` | Pure state machine (loggedOut/otpSent/loggingIn/loggedIn). Client is injected → unit-testable. `window.AuthState` + `module.exports`. |
| `js/auth/session-store.js` | Main-process encrypted session store (`safeStorage` + `fs` injected). **Refuses to write plaintext** if encryption is unavailable. `module.exports`. |
| `js/auth/auth-ui.js` | Builds the shared `authState` (`window.intentionAuth`), the two-step login modal, nav Account button, launch-time session restore. Exposes `window.openAuthModal`. |
| `js/auth/gate.js` | `shouldLock` / `applyGate` / `installGate` for `[data-requires-auth]`. `window.AuthGate` + `module.exports`. |
| `css/auth.css` | Account button, auth modal, Online page, and `.auth-gated` / `.auth-lock-overlay` styles. |

### Main-process IPC (in `main.js`, exposed via `preload.js` `electronAPI`)
- `auth:getSession` → `{ session, encryptionAvailable }` (restore on launch)
- `auth:setSession(session)` → `{ ok, reason }` (persist after verify / refresh)
- `auth:clearSession` → clear on logout
Backed by `createSessionStore({ safeStorage, fs, filePath })`.

### Load order (bottom of `index.html`)
SDK → config → client → auth-state load **before** `app.js`; `auth-ui.js` then
`gate.js` load after the feature scripts (they need the nav DOM + `window.intentionAuth`).
The inline script calls `AuthGate.installGate({ authState: window.intentionAuth })`.

### Setup (to actually enable sign-in)
See README → "Enabling accounts (optional)". In short: create a Supabase project,
enable **Email OTP**, paste the Project URL + anon key into
`js/auth/supabase-config.js`. The anon key is public by design — safe to ship;
never put the `service_role` key in the app.

### Tests
- `test/auth-state.test.js` — state transitions (fake client, no network).
- `test/session-store.test.js` — encrypt round-trip, plaintext refusal, corrupt-blob handling (mocked `safeStorage` + in-memory fs).
- `test/auth-gate.test.js` — lock/unlock decisions + authState wiring (fake DOM).
All run under `npm test` (Node's built-in runner), no Electron/Supabase needed.

### Gotchas
- `fs` is already `require`d once lower in `main.js` (startup-pref store); the
  session store reuses it. Don't add a second top-level `const fs` — it throws
  "Identifier 'fs' has already been declared" at load.
- Session tokens must stay out of `localStorage`. If you add new auth storage,
  route it through the main-process session store, not `saveData`.
- The vendored SDK must be refreshed manually when bumping the dependency
  (copy `dist/umd/supabase.js` → `js/vendor/supabase.js`).

### Scope / what's NOT here yet
Only accounts + the gating boundary. Calendar import (Google/Microsoft/Apple),
live status, group Pomodoros, and chat are future rounds that plug into the
`[data-requires-auth]` gate and the signed-in session built here.
