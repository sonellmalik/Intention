# Intention

**A calm, all-in-one productivity companion for your desktop.**

Intention keeps your focus sessions, daily schedule, and progress in one tidy window that tucks into the left quarter of your screen. All core features stay **local** — no account needed, and your focus data never leaves your machine. An **optional account** unlocks online features (coming in stages); everything else works signed out.

---

## Features

### Pomodoro Timer
- Work / short / long break with customizable durations and an 8-session cycle
- Shrinks into a transparent floating widget with a one-tap distraction button
- Sound + desktop notification when a session ends

### Focus Mode *(Windows)*
- Turns your entire PC greyscale to kill visual temptation
- Pick the window(s) to keep in color; color returns only when they're active
- Multi-monitor aware, and color is always restored on exit

### Scheduler
- Flexible day calendar (Teams-style) — drag across any range to create a block
- **Resize blocks** by dragging their top or bottom edge
- Assign to-dos, priorities, scheduled breaks, or custom entries
- **My 5 Priorities** list, plus a to-do list with a collapsible Completed archive
- Live current-time line; clears each midnight and saves the day into History

### Distraction Tracking & Reflection
- Quick-tap counter and an end-of-session timeline to tag each distraction
- A short reflection check-in after every 4 sessions

### History
- Monthly heatmap of focus sessions per day
- Click any day for its sessions, distraction breakdown, and planned schedule

### Articles
- Small built-in library; highlight lines to rotate as inspiration on the Timer tab

### Startup *(new in 1.2.0)*
- Opens to the **Scheduler** with a "How would you like to plan the day?" prompt
- **Launch at startup** toggle in Timer settings

### Accounts *(optional)*
- All core features (Timer, Scheduler, Calendar, History, Read) work with **no account**
- Sign in with a passwordless **email one-time code** (no password to manage)
- Unlocks the **Online** area — the home for upcoming features like calendar
  import (Google / Microsoft / Apple), live status, group Pomodoros, and chat
- Your session is stored **encrypted** on your device (OS keychain / DPAPI), never
  in plain text, and stays signed in across restarts
- Signed-out users see online features clearly locked with a "Sign in to use" prompt

---

## Getting Started

**Windows:** Download `Intention Setup.exe` from [Releases](../../releases) and run it. If Windows warns, choose **More info → Run anyway** (the app isn't code-signed).

**macOS:** Download `Intention.dmg` from [Releases](../../releases) and drag Intention into Applications.

---

## For developers

Requires [Node.js](https://nodejs.org/) 18+.

```bash
git clone https://github.com/sonellmalik/Intention.git
cd Intention
npm install --legacy-peer-deps
npm start            # run in development
```

Build installers:

```bash
node build.js win   # Windows (.exe)
node build.js mac   # macOS (.dmg) — must run on macOS
node build.js       # auto-detect platform
```

Built files land in `dist/`. Focus Mode uses standard `Magnification.dll` / `user32.dll` calls on Windows — no screen capture, no elevated privileges.

### Enabling accounts (optional)

Accounts are powered by [Supabase](https://supabase.com) (free tier) using
passwordless email one-time codes. The app runs fine without this; the sign-in
screen just shows a friendly "not set up yet" message until you configure it.

1. Create a free project at [supabase.com](https://supabase.com).
2. In the dashboard, open **Project Settings → API** and copy:
   - the **Project URL**
   - the **anon public** key (this one is safe to ship in the app — it is public
     by design; never use the `service_role` key here)
3. Enable email codes: **Authentication → Providers → Email**, turn on **Email OTP**.
   (You can disable password sign-up if you only want passwordless codes.)
4. Paste both values into [`js/auth/supabase-config.js`](js/auth/supabase-config.js),
   replacing the `YOUR_SUPABASE_PROJECT_URL` / `YOUR_SUPABASE_ANON_KEY` placeholders.
5. Restart the app. Click **Sign in** (top-right of the nav), enter your email,
   then type the 6-digit code from your inbox.

Session tokens are stored encrypted via Electron's `safeStorage` in the app's
`userData` folder (not in `localStorage`), and refreshed automatically.

The Supabase browser SDK is vendored at `js/vendor/supabase.js` so it loads via a
plain `<script>` tag (the app has no bundler). To update it, run
`npm install @supabase/supabase-js@latest` and copy
`node_modules/@supabase/supabase-js/dist/umd/supabase.js` to `js/vendor/supabase.js`.

**Built with:** Electron, plain HTML/CSS/JavaScript, electron-builder, and GitHub Actions.

---

## License

[MIT License](LICENSE) — free to use, modify, and share.

## Author

**Sonell Malik** — [github.com/sonellmalik](https://github.com/sonellmalik)
