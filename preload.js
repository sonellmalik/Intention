const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Timer IPC
    // sessionInfo (optional) carries { sessionId, dateKey, mode, startedAt, plannedDuration }
    // so main.js can emit a complete sessionStarted to the paired iOS companion.
    timerStarted: (sessionInfo) => ipcRenderer.send('timer-started', sessionInfo),
    timerPaused: () => ipcRenderer.send('timer-paused'),
    // sessionInfo (optional) carries { sessionId, reason } for sessionStopped.
    timerStopped: (sessionInfo) => ipcRenderer.send('timer-stopped', sessionInfo),
    timerTick: (timeString) => ipcRenderer.send('timer-tick', timeString),
    timerModeChanged: (mode) => ipcRenderer.send('timer-mode-changed', mode),
    // Current scheduler time-block title to show under the mini timer.
    timerTaskChanged: (task) => ipcRenderer.send('timer-task-changed', task),
    // Mini overlay asks main to resize its window to fit its content height.
    resizeMiniWindow: (height) => ipcRenderer.send('resize-mini-window', height),
    showMainWindow: () => ipcRenderer.send('show-main-window'),
    // Open the full calendar as its own separate, full-screen window.
    openCalendarWindow: () => ipcRenderer.send('open-calendar-window'),
    miniPauseToggle: () => ipcRenderer.send('mini-pause-toggle'),
    // Close just the mini overlay; the timer keeps running in the main window.
    closeMini: () => ipcRenderer.send('close-mini'),
    // "Refocus": mini overlay asks main to open the box-breathing overlay.
    openRefocus: () => ipcRenderer.send('open-refocus'),
    onOpenRefocus: (callback) => ipcRenderer.on('open-refocus', () => callback()),
    // "Yap Sheet": mini overlay asks main to open the thoughts log.
    openYapSheet: () => ipcRenderer.send('open-yap-sheet'),
    onOpenYapSheet: (callback) => ipcRenderer.on('open-yap-sheet', () => callback()),
    onUpdateTime: (callback) => ipcRenderer.on('update-time', (event, time) => callback(time)),
    onUpdateMode: (callback) => ipcRenderer.on('update-mode', (event, mode) => callback(mode)),
    onUpdateTask: (callback) => ipcRenderer.on('update-task', (event, task) => callback(task)),
    onToggleTimer: (callback) => ipcRenderer.on('toggle-timer', () => callback()),

    // Distraction counter
    logDistraction: () => ipcRenderer.send('log-distraction'),
    onDistractionLogged: (callback) => ipcRenderer.on('distraction-logged', (event, count) => callback(count)),
    onDistractionCountUpdate: (callback) => ipcRenderer.on('distraction-count-update', (event, count) => callback(count)),

    // Focus Mode - System Window Enumeration
    getOpenWindows: () => ipcRenderer.invoke('get-open-windows'),
    getDisplayCount: () => ipcRenderer.invoke('get-display-count'),
    setFocusWindow: (windowNames) => ipcRenderer.send('set-focus-window', windowNames),
    updateFocusWindows: (windowNames) => ipcRenderer.send('update-focus-windows', windowNames),
    disableFocusMode: () => ipcRenderer.send('disable-focus-mode'),

    // iOS Focus Companion - phone sync
    onPhoneDistractions: (callback) => ipcRenderer.on('phone-distractions', (event, msg) => callback(msg)),
    getPairingQR: () => ipcRenderer.invoke('get-pairing-qr'),

    // Launch at device startup
    getLaunchAtStartup: () => ipcRenderer.invoke('get-launch-at-startup'),
    setLaunchAtStartup: (enabled) => ipcRenderer.invoke('set-launch-at-startup', enabled),

    // Account session persistence (optional user accounts). Tokens are stored
    // encrypted in the main process via safeStorage, never in localStorage.
    authGetSession: () => ipcRenderer.invoke('auth:getSession'),
    authSetSession: (session) => ipcRenderer.invoke('auth:setSession', session),
    authClearSession: () => ipcRenderer.invoke('auth:clearSession'),

    // Auto-update
    checkForUpdates: () => ipcRenderer.send('check-for-updates'),
    installUpdate: () => ipcRenderer.send('install-update'),
    openReleasePage: () => ipcRenderer.send('open-release-page'),
    onUpdateDownloading: (cb) => ipcRenderer.on('update-downloading', (e, info) => cb(info)),
    onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (e, info) => cb(info)),
    onUpdateReady: (cb) => ipcRenderer.on('update-ready', (e, info) => cb(info)),
    onUpdateAvailableManual: (cb) => ipcRenderer.on('update-available-manual', (e, info) => cb(info)),
    onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', () => cb())
});
