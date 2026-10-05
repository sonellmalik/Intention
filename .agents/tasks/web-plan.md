# Implementation Plan — Intention web deliverables

Two deliverables inside the existing repo (no worktree, no build tooling, plain static files):
1. A functional web app = the existing renderer (`index.html` + `css/` + `js/`) made full-width + responsive in the browser, with sign-in reachable, WITHOUT breaking the Electron narrow-column layout.
2. A responsive marketing landing page at `web/index.html` that matches the existing visual identity and links into the web app + GitHub Releases + sign-in.

## Design decisions (made during exploration, grounded in the code)

- **Browser detection = absence of `window.electronAPI`.** `preload.js` exposes `window.electronAPI` in Electron only; every renderer call already guards on it (confirmed in `js/app.js`, `js/auth/auth-ui.js`, `index.html` inline scripts). So "no `electronAPI`" is the reliable browser signal.
- **web-mode class on `<html>`, set by a tiny inline script in `<head>` BEFORE stylesheets paint.** Inline (not a separate file) avoids a flash of narrow layout. It adds `web-mode` to `document.documentElement` when `window.electronAPI` is undefined. All browser-only CSS is scoped under `html.web-mode`, leaving Electron defaults untouched.
- **New `css/web.css`, linked LAST in `index.html`** so its scoped rules win by source order without `!important`. It only widens/relayouts for `html.web-mode`; it adds nothing to Electron.
- **Keep placeholder/real Supabase config as-is.** `js/auth/supabase-config.js` already holds a real project URL + anon key (anon key is public by design), so `isConfigured()` is true and the browser auth modal runs the real email-OTP flow. Do NOT change credentials. Note: `supabase-client.js` sets `persistSession:false` (main process owns persistence in Electron). In the browser there is no cross-reload session persistence; this is acceptable per the task ("reachable and functional") and we do NOT change it to avoid altering Electron behavior.
- **Reuse the existing renderer; do not duplicate app logic.** Marketing "Launch the web app" CTA links to `../index.html`. A `?signin=1` (or `#signin`) deep-link opens the auth modal on load.
- **Responsive breakpoints:** mobile `<=600px`, tablet `601–1024px`, desktop `>1024px`. Web-mode container max-width ~1200px centered; timer + scheduler relayout to multi-column grid at `>=1025px`. The calendar page is already full-width (`css/calendar.css #page-calendar { width:100% }`).
- **No screenshots exist in `assets/`** — marketing visuals use inline SVG / CSS-drawn preview cards only. No `<img src>` to missing files.

## Verification tooling
Static server: `python -m http.server 8080` from repo root (Python 3.14 present). Open `http://localhost:8080/web/` and `http://localhost:8080/index.html`.
Logic regression: `npm test` (61 node:test unit tests, currently green) must stay green.
Electron check (manual, if Electron runnable): `npm start` must still open in the left-quarter narrow column.

---

- [ ] 1. Add browser detection + web-mode class and link `css/web.css`.
      Add a tiny inline script in the `<head>` of `index.html` (before the stylesheet links) that does: `if (!window.electronAPI) document.documentElement.classList.add('web-mode');`. Add `<link rel="stylesheet" href="css/web.css">` as the LAST stylesheet link. Create `css/web.css` (empty shell with a header comment for now).
      Files: `index.html`, `css/web.css`
      Verify: `python -m http.server 8080`, open `http://localhost:8080/index.html`, confirm in DevTools that `<html>` has class `web-mode` and `css/web.css` loads 200. `npm test` still green.

- [ ] 2. Full-width web layout (drop the quarter-screen constraint) in `css/web.css`, scoped to `html.web-mode`.
      Widen the app content: center `.page` with `max-width: 1200px; margin: 0 auto;` and larger padding; let the nav sit in a matching centered max-width band. Do NOT touch Electron defaults (everything scoped under `html.web-mode`). Confirm the calendar page stays full-width.
      Files: `css/web.css`
      Verify: at 1440px width the app content is a centered wide column (not the ~360px quarter), nav aligns with it, calendar fills width. Toggle off web-mode class in DevTools and confirm layout returns to the narrow Electron look.

- [ ] 3. Multi-column relayout for timer + scheduler on wide viewports (web-mode only).
      Under `html.web-mode` at `min-width:1025px`, lay out `.timer-layout` and `.timeblock-layout` as responsive grids (e.g. two columns) so wide space is used sensibly instead of one tall column. Keep single-column below.
      Files: `css/web.css`
      Verify: at 1440px the Timer and Scheduler pages use multi-column layout; at 800px they collapse to one column; no overflow/clipping.

- [ ] 4. Responsive media queries for mobile (web-mode) covering nav, timer, scheduler, calendar, history, and modals.
      Under `html.web-mode` add `@media (max-width:600px)` rules: nav wraps/stacks and stays tappable, timer controls wrap, scheduler inputs stack full-width, calendar remains horizontally usable (scroll if needed), history heatmap scales, and all modals (`.cw-modal-content`, `.reflection-content`, `.timeline-content`, timer modals, `.auth-modal`) fit within a 375px viewport with `max-width` and safe padding.
      Files: `css/web.css`
      Verify: at 375px width every page is usable, no horizontal overflow, modals fit on screen; open the auth modal, reflection modal, and a calendar event editor and confirm each fits.

- [ ] 5. Verify sign-in works in the browser and hide any Electron-only dead controls.
      Confirm the nav `#nav-account` "Sign in" button opens the auth modal in the browser (code already client-side). Audit for any control that would be a dead/broken button when `window.electronAPI` is undefined (the renderer already hides `#system-windows-section` and `#startup-setting-row`); add web-mode CSS to hide anything else that is Electron-only and otherwise visible (e.g. minimize-to-overlay). Make no logic changes unless a dead control is found; prefer guarded/CSS-scoped changes.
      Files: `css/web.css` (and only if a genuine dead control exists, a guarded tweak in the relevant `js/*.js`)
      Verify: in the browser, click "Sign in" → auth modal opens with the real email step (config is set); DevTools console shows NO uncaught errors from missing `electronAPI` across Timer/Scheduler/Calendar/History/Read navigation. `npm test` green.

- [ ] 6. Create the marketing landing page `web/index.html` + `web/marketing.css` + `web/marketing.js`.
      Build a semantic, responsive single page reusing the design tokens from `css/style.css` (`--bg #f8f9fa`, `--surface #fff`, `--text #1a1a2e`, `--primary #4361ee`, `--accent #f72585`, `--border`, `--radius`, shadows, Segoe UI font stack). Sections: hero (name "Intention", tagline, primary CTA "Launch the web app" → `../index.html`, secondary CTA "Download for desktop" → `https://github.com/sonellmalik/Intention/releases/latest`, and a "Sign in" entry → `../index.html?signin=1`); features (Pomodoro timer, Focus Mode, Scheduler, Distraction tracking & reflection, History heatmap, Articles, optional accounts/Online); "How it works" steps; a desktop-only note (greyscale Focus Mode, floating overlay, iOS companion); footer with GitHub link + MIT license. Visuals are inline SVG / CSS-drawn preview cards only — NO `<img>` to missing files. Marketing nav includes a "Sign in" link. `marketing.js` is optional (e.g. mobile nav toggle, smooth-scroll).
      Files: `web/index.html`, `web/marketing.css`, `web/marketing.js`
      Verify: `python -m http.server 8080`, open `http://localhost:8080/web/`; at 375px and 1440px the page is clean and responsive, no broken-image icons, CTAs are keyboard-focusable; "Launch the web app" navigates to the working app; "Download" points at the Releases URL.

- [ ] 7. Wire the sign-in deep-link in the web app.
      In `index.html` inline script (browser-only, guarded by `!window.electronAPI` or presence of the param), detect `?signin=1`/`#signin` on load and call `window.openAuthModal()` after auth-ui.js has initialized. `openAuthModal` is already exposed on `window` by `js/auth/auth-ui.js`.
      Files: `index.html`
      Verify: open `http://localhost:8080/index.html?signin=1` → auth modal opens automatically; open `http://localhost:8080/index.html` (no param) → modal does NOT auto-open. From the marketing page, the "Sign in" link lands on the app with the modal open.

- [ ] 8. Full regression + cross-deliverable verification.
      Serve the repo and manually exercise: nav between Timer/Scheduler/Calendar/History/Read; timer start/pause/reset; add priority/todo/time block; create a calendar event; history heatmap renders; article highlighting; box-breathing "Refocus"; background audio toggle; Yap Sheet; Sign in opens the modal. Confirm NO uncaught console errors. Re-run `npm test` (expect 61 passing). If Electron is runnable, `npm start` and confirm the narrow left-quarter layout is unchanged.
      Files: none (verification only; fix regressions in the files above if found)
      Verify: all flows above work in the browser at both 375px and 1440px with a clean console; `npm test` green; Electron narrow-column layout intact.

## Gaps / assumptions
- Supabase config contains real-looking credentials already committed in the repo; task says keep config as-is and not commit real creds. We make NO change to it. Browser sign-in therefore uses the live project per-session (no cross-reload persistence because `persistSession:false`); documented, not changed.
- Electron cannot necessarily be launched in this environment; the Electron narrow-column check is "do not regress" and is verified by scoping ALL changes under `html.web-mode` / browser-only inline guards, plus manual `npm start` where possible.
