const { app, BrowserWindow, ipcMain, screen, shell, safeStorage } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const { createSessionStore } = require('./js/auth/session-store');
// Note: `fs` is required once lower in this file (near the startup-pref store)
// and reused by the session store below; both run after module load.
const { autoUpdater } = require('electron-updater');
const { DesktopSyncServer, buildSessionStarted, buildSessionStopped } = require('./js/desktop-sync-server');

let mainWindow = null;
let miniWindow = null;
let calendarWindow = null;
let focusWindowPollingInterval = null;

// ===== iOS Focus Companion sync server =====
// Advertises a LAN WebSocket + Bonjour service so the iOS companion app can
// pair, then receive session lifecycle events and push distraction batches.
// The pure message-handling logic lives in js/desktop-sync-server.js so it
// stays unit-testable without booting Electron.
let syncServer = null;
// Remembers the sessionId emitted on the last sessionStarted so a
// timer-stopped that omits it (e.g. an older renderer) can still reference the
// session it is ending.
let lastSyncSessionId = null;

function startSyncServer() {
    if (syncServer) return;
    syncServer = new DesktopSyncServer({
        port: 0, // let the OS choose a free port; QR generation (task 9.2) reads it
        getMainWindow: () => mainWindow
    });
    syncServer.start();
}

function stopSyncServer() {
    if (syncServer) {
        syncServer.stop();
        syncServer = null;
    }
}

function createMainWindow() {
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

    // Main window takes left 1/4 of screen
    const winWidth = Math.round(screenWidth / 4);
    const winHeight = screenHeight;

    mainWindow = new BrowserWindow({
        width: winWidth,
        height: winHeight,
        x: 0,
        y: 0,
        maxWidth: winWidth,
        resizable: true,
        frame: true,
        titleBarStyle: 'hiddenInset',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // Keep timers/media running when the window is minimized so the
            // background YouTube audio doesn't stall during a focus session
            // (starting the timer minimizes this window).
            backgroundThrottling: false
        }
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (miniWindow) {
            miniWindow.close();
            miniWindow = null;
        }
        if (calendarWindow && !calendarWindow.isDestroyed()) {
            calendarWindow.close();
            calendarWindow = null;
        }
        // Always restore color on exit
        disableFocusMode();
        app.quit();
    });
}

function createMiniWindow() {
    if (miniWindow) return;

    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

    miniWindow = new BrowserWindow({
        width: 270,
        // Starts compact; the renderer measures its content and asks to resize
        // (grows upward from the bottom-left anchor) when a task line is shown.
        height: 100,
        x: 20,
        y: screenHeight - 130,
        resizable: false,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    miniWindow.loadFile('mini.html');
    miniWindow.setIgnoreMouseEvents(false);

    miniWindow.on('closed', () => {
        miniWindow = null;
    });
}

// ===== Standalone Calendar Window =====
// The full calendar opens as its OWN top-level window that fills the whole
// screen, independent of the narrow main Intention window. It can be closed on
// its own without affecting the main app. Because it loads from the same file
// origin, it shares localStorage (focusflow_ keys) with the main window, so
// events created here show up everywhere.
function createCalendarWindow() {
    try {
        // If it already exists, just focus/restore it instead of opening a second one.
        if (calendarWindow && !calendarWindow.isDestroyed()) {
            if (calendarWindow.isMinimized()) calendarWindow.restore();
            calendarWindow.show();
            calendarWindow.focus();
            return;
        }

        const primary = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primary.workAreaSize;

        calendarWindow = new BrowserWindow({
            width: screenWidth,
            height: screenHeight,
            x: 0,
            y: 0,
            title: 'Intention - Calendar',
            show: false,              // show once maximized to avoid a flash
            frame: true,
            resizable: true,
            // Do NOT inherit the main window's hiddenInset/maxWidth constraints.
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });

        calendarWindow.loadFile('calendar.html');

        // Fill the screen once the content is ready (keeps OS chrome so it's
        // still easy to close). ready-to-show fires on every fresh window.
        calendarWindow.once('ready-to-show', () => {
            if (!calendarWindow || calendarWindow.isDestroyed()) return;
            calendarWindow.maximize();
            calendarWindow.show();
            calendarWindow.focus();
        });

        calendarWindow.on('closed', () => {
            calendarWindow = null;
        });
    } catch (e) {
        console.error('Failed to open calendar window:', e);
        calendarWindow = null;
    }
}

// ===== System-Wide Greyscale via Windows Magnification API =====
// A persistent PowerShell helper (greyscale-helper.ps1) applies a grayscale
// color matrix to the ENTIRE screen using MagSetFullscreenColorEffect.
// We send "ON"/"OFF" over its stdin. If the helper dies, Windows restores
// color automatically, so the user can never get stuck in greyscale.

let greyscaleHelper = null;   // the spawned PowerShell process
let greyscaleActive = false;  // whether the whole screen is currently grey
let focusModeOn = false;      // whether focus mode is enabled at all
let focusTargetNames = [];    // window titles (one per display) that keep color

function startGreyscaleHelper() {
    if (greyscaleHelper) return;

    const scriptPath = path.join(__dirname, 'greyscale-helper.ps1');
    greyscaleHelper = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath
    ], { windowsHide: true });

    greyscaleHelper.on('error', (e) => {
        console.error('Greyscale helper failed to start:', e);
        greyscaleHelper = null;
    });

    greyscaleHelper.on('exit', () => {
        greyscaleHelper = null;
        greyscaleActive = false;
    });
}

function sendGreyscaleCommand(cmd) {
    if (!greyscaleHelper || !greyscaleHelper.stdin.writable) return;
    try {
        greyscaleHelper.stdin.write(cmd + '\n');
    } catch (e) {
        console.error('Failed to write to greyscale helper:', e);
    }
}

function applyGreyscale() {
    if (greyscaleActive) return;
    startGreyscaleHelper();
    sendGreyscaleCommand('ON');
    greyscaleActive = true;
}

function removeGreyscale() {
    if (!greyscaleActive) return;
    sendGreyscaleCommand('OFF');
    greyscaleActive = false;
}

function stopGreyscaleHelper() {
    if (greyscaleHelper) {
        sendGreyscaleCommand('EXIT');
        try { greyscaleHelper.stdin.end(); } catch (e) {}
        // Give it a moment to restore color, then force-kill if still alive
        const proc = greyscaleHelper;
        setTimeout(() => {
            if (proc && !proc.killed) {
                try { proc.kill(); } catch (e) {}
            }
        }, 500);
        greyscaleHelper = null;
    }
    greyscaleActive = false;
}

// Called when the user turns focus mode ON (with zero or more chosen windows).
// `names` is an array of window titles that should keep color when active.
function enableFocusMode(names) {
    focusModeOn = true;
    focusTargetNames = Array.isArray(names)
        ? names.filter(n => n && n.trim().length > 0)
        : (names ? [names] : []);
    startGreyscaleHelper();
    applyGreyscale(); // grey everything to start; polling adjusts from here
    startFocusWindowPolling();
}

// Update the chosen work windows without tearing down greyscale (used by Apply/Refresh)
function updateFocusTargets(names) {
    focusTargetNames = Array.isArray(names)
        ? names.filter(n => n && n.trim().length > 0)
        : (names ? [names] : []);
    // Re-evaluate immediately so color returns/leaves right away
    checkFocusWindowState();
}

// Called when the user turns focus mode OFF
function disableFocusMode() {
    focusModeOn = false;
    focusTargetNames = [];
    stopFocusWindowPolling();
    removeGreyscale();
    stopGreyscaleHelper();
}

// ===== Focus Window Polling =====
// While focus mode is on: if the chosen work window is the foreground window,
// show color; otherwise keep the whole screen greyscale.

function startFocusWindowPolling() {
    stopFocusWindowPolling();
    // Run one immediate check, then poll
    checkFocusWindowState();
    focusWindowPollingInterval = setInterval(checkFocusWindowState, 1200);
}

function stopFocusWindowPolling() {
    if (focusWindowPollingInterval) {
        clearInterval(focusWindowPollingInterval);
        focusWindowPollingInterval = null;
    }
}

function checkFocusWindowState() {
    if (!focusModeOn) return;

    // If no windows were chosen yet, keep the whole screen grey.
    if (!focusTargetNames || focusTargetNames.length === 0) {
        applyGreyscale();
        return;
    }

    // Get the current foreground window title via a dedicated helper script
    const titleScript = path.join(__dirname, 'foreground-title.ps1');
    exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${titleScript}"`,
        { windowsHide: true },
        (err, stdout) => {
            if (!focusModeOn) return;
            if (err || stdout == null) return;

            const foregroundTitle = stdout.trim().toLowerCase();
            if (foregroundTitle.length === 0) { applyGreyscale(); return; }

            // Color returns if the active window matches ANY chosen work window.
            // Match is bidirectional (either title may be a substring of the other)
            // to handle apps that append/trim suffixes to their window titles.
            const isTargetFocused = focusTargetNames.some(name => {
                const target = (name || '').toLowerCase().trim();
                if (target.length === 0) return false;
                if (foregroundTitle.includes(target) || target.includes(foregroundTitle)) return true;
                // Also match on the app-name portion after the last " - " separator
                const targetApp = target.split(' - ').pop().trim();
                const fgApp = foregroundTitle.split(' - ').pop().trim();
                return targetApp.length > 1 && targetApp === fgApp;
            });

            if (isTargetFocused) {
                removeGreyscale(); // a chosen work window is active -> show color
            } else {
                applyGreyscale();  // anything else -> grey
            }
        });
}

// ===== IPC Handlers =====

// Timer controls
ipcMain.on('timer-started', (event, sessionInfo) => {
    if (mainWindow) {
        mainWindow.minimize();
    }
    createMiniWindow();

    // Emit sessionStarted to the paired iOS companion (task 8.3). sessionInfo is
    // only present when a fresh session begins; re-minimizing an already-running
    // session sends null, so we skip the notification then.
    if (syncServer && sessionInfo) {
        const msg = buildSessionStarted(sessionInfo);
        lastSyncSessionId = msg.sessionId;
        syncServer.sendToPaired(msg);
    }
});

ipcMain.on('timer-paused', () => {
    // Keep mini window visible
});

ipcMain.on('timer-tick', (event, timeString) => {
    if (miniWindow && !miniWindow.isDestroyed()) {
        miniWindow.webContents.send('update-time', timeString);
    }
});

ipcMain.on('timer-mode-changed', (event, mode) => {
    if (miniWindow && !miniWindow.isDestroyed()) {
        miniWindow.webContents.send('update-mode', mode);
    }
});

// Relay the current scheduler time-block title to the mini overlay so it can
// show what the user planned to be doing right now (under the timer).
ipcMain.on('timer-task-changed', (event, task) => {
    if (miniWindow && !miniWindow.isDestroyed()) {
        miniWindow.webContents.send('update-task', task);
    }
});

// The mini overlay's content height varies (0, 1, or 2 task lines). It measures
// its own content and asks us to resize so nothing is clipped and there's no
// wasted transparent space. We keep the window's BOTTOM edge fixed so it grows
// upward from its bottom-left anchor near the taskbar.
ipcMain.on('resize-mini-window', (event, contentHeight) => {
    if (!miniWindow || miniWindow.isDestroyed()) return;

    const MIN_H = 100;
    const MAX_H = 180;
    const newHeight = Math.max(MIN_H, Math.min(MAX_H, Math.round(contentHeight)));

    const [w] = miniWindow.getSize();
    const [x, y] = miniWindow.getPosition();
    const currentHeight = miniWindow.getSize()[1];
    if (newHeight === currentHeight) return;

    // Keep the bottom edge in place: adjust y by the height delta.
    const newY = y + (currentHeight - newHeight);
    miniWindow.setBounds({ x, y: newY, width: w, height: newHeight });
});

// Open (or focus) the full calendar as its own separate, full-screen window.
ipcMain.on('open-calendar-window', () => {
    console.log('[calendar] open-calendar-window received');
    createCalendarWindow();
});

ipcMain.on('show-main-window', () => {
    if (miniWindow) {
        miniWindow.close();
        miniWindow = null;
    }
    if (mainWindow) {
        mainWindow.restore();
        mainWindow.focus();
    }
});

ipcMain.on('mini-pause-toggle', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('toggle-timer');
    }
});

// Close just the mini overlay (the ✕ button on it). The timer keeps running in
// the main window; the user can reopen the overlay via the ▼ button on the
// timer page, which re-runs createMiniWindow().
ipcMain.on('close-mini', () => {
    if (miniWindow) {
        miniWindow.close();
        miniWindow = null;
    }
});

// "Refocus" from the mini overlay: the box-breathing overlay lives in the main
// window (full-screen, minimalistic), so restore/show the main window and ask
// it to open the overlay. Closing the mini keeps the overlay unobstructed.
ipcMain.on('open-refocus', () => {
    if (miniWindow) {
        miniWindow.close();
        miniWindow = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.restore();
        mainWindow.focus();
        mainWindow.webContents.send('open-refocus');
    }
});

// "Yap Sheet" from the mini overlay: the thoughts-log overlay lives in the main
// window, so restore/show it and ask it to open the sheet.
ipcMain.on('open-yap-sheet', () => {
    if (miniWindow) {
        miniWindow.close();
        miniWindow = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.restore();
        mainWindow.focus();
        mainWindow.webContents.send('open-yap-sheet');
    }
});

// ===== Distraction Counter =====
let sessionDistractionCount = 0;

ipcMain.on('log-distraction', () => {
    sessionDistractionCount++;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('distraction-logged', sessionDistractionCount);
    }
});

ipcMain.on('timer-stopped', (event, sessionInfo) => {
    sessionDistractionCount = 0;
    if (miniWindow) {
        miniWindow.close();
        miniWindow = null;
    }
    if (mainWindow) {
        mainWindow.restore();
        mainWindow.focus();
    }

    // Emit sessionStopped to the paired iOS companion (task 8.3). Prefer the
    // sessionId the renderer supplies; fall back to the last started session.
    if (syncServer && lastSyncSessionId) {
        const info = sessionInfo && typeof sessionInfo === 'object' ? sessionInfo : {};
        const msg = buildSessionStopped({
            sessionId: info.sessionId || lastSyncSessionId,
            reason: info.reason
        });
        syncServer.sendToPaired(msg);
        lastSyncSessionId = null;
    }
});

// ===== Focus Mode - Window Enumeration =====
// Titles ONLY, via user32.dll EnumWindows (see list-windows.ps1).
// No screen capture, no thumbnails, no window content is read.
ipcMain.handle('get-open-windows', () => {
    return new Promise((resolve) => {
        const listScript = path.join(__dirname, 'list-windows.ps1');
        exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${listScript}"`,
            { windowsHide: true, maxBuffer: 1024 * 1024 },
            (err, stdout) => {
                if (err || !stdout) {
                    resolve([]);
                    return;
                }
                const ownTitle = (mainWindow && !mainWindow.isDestroyed())
                    ? (mainWindow.getTitle() || '').trim()
                    : 'Intention';

                const titles = stdout
                    .split(/\r?\n/)
                    .map(t => t.trim())
                    .filter(t => t.length > 0)
                    // Hide Intention's own window from the picker
                    .filter(t => t !== ownTitle && !t.toLowerCase().includes('intention'));

                // De-duplicate while preserving order
                const seen = new Set();
                const unique = [];
                for (const t of titles) {
                    if (!seen.has(t)) { seen.add(t); unique.push({ name: t }); }
                }
                resolve(unique);
            });
    });
});

// How many displays are connected (so the UI can ask for one window per screen)
ipcMain.handle('get-display-count', () => {
    try {
        return screen.getAllDisplays().length;
    } catch (e) {
        return 1;
    }
});

// Turn focus mode ON. `windowNames` is an array of chosen window titles.
ipcMain.on('set-focus-window', (event, windowNames) => {
    enableFocusMode(windowNames);
});

// Update the chosen windows while focus mode is already on (Apply/Refresh button)
ipcMain.on('update-focus-windows', (event, windowNames) => {
    if (focusModeOn) {
        updateFocusTargets(windowNames);
    } else {
        enableFocusMode(windowNames);
    }
});

ipcMain.on('disable-focus-mode', () => {
    disableFocusMode();
});

// ===== iOS Focus Companion - Pairing QR =====
// Builds a fresh one-time pairing payload {host, port, deviceId, pairingToken,
// fingerprint} and returns it alongside a QR-code data URL. The renderer shows
// the QR for the phone to scan, and can display host:port for manual fallback
// when mDNS discovery is blocked (design: Requirement 4.8 / 8.3).
ipcMain.handle('get-pairing-qr', async () => {
    // Ensure the sync server is running so actualPort is available before we
    // embed it in the payload.
    startSyncServer();
    await syncServer.whenListening();

    const payload = syncServer.buildPairingPayload();

    let qrDataUrl = null;
    try {
        const QRCode = require('qrcode');
        qrDataUrl = await QRCode.toDataURL(JSON.stringify(payload));
    } catch (e) {
        console.error('Failed to generate pairing QR:', e);
    }

    // Always return the payload (even if QR rendering failed) so the renderer
    // can fall back to displaying host:port for manual entry.
    return { qrDataUrl, payload };
});

// ===== Launch at Device Startup =====
// Register (or unregister) Intention to open automatically when the user logs
// in. Uses Electron's cross-platform login-item API (Windows registry / macOS
// login items). `openAsHidden` is a no-op on Windows but keeps the launch quiet
// on macOS. The OS itself is the source of truth for whether it's enabled.
function setLaunchAtStartup(enabled) {
    try {
        app.setLoginItemSettings({
            openAtLogin: !!enabled,
            openAsHidden: false,
            path: process.execPath,
            args: []
        });
    } catch (e) {
        console.error('Failed to set login item settings:', e);
    }
}

function isLaunchAtStartupEnabled() {
    try {
        return app.getLoginItemSettings().openAtLogin === true;
    } catch (e) {
        console.error('Failed to read login item settings:', e);
        return false;
    }
}

// Renderer asks whether launch-at-startup is currently on (to sync the toggle)
ipcMain.handle('get-launch-at-startup', () => isLaunchAtStartupEnabled());

// Renderer flips the toggle; returns the resulting state so the UI can confirm
ipcMain.handle('set-launch-at-startup', (event, enabled) => {
    setLaunchAtStartup(enabled);
    return isLaunchAtStartupEnabled();
});

// ===== Account session store (optional user accounts) =====
// The renderer runs the Supabase email-OTP flow, but the resulting session
// (access + refresh tokens) is persisted HERE, encrypted via safeStorage, so it
// never touches localStorage. On launch the renderer asks for the stored
// session to restore login. See js/auth/session-store.js for the (tested) logic.
let sessionStore = null;
function getSessionStore() {
    if (!sessionStore) {
        sessionStore = createSessionStore({
            safeStorage,
            fs,
            filePath: path.join(app.getPath('userData'), 'account-session.enc')
        });
    }
    return sessionStore;
}

// Return the stored session (or null). Also reports whether OS encryption is
// available so the UI can explain if accounts can't be kept signed in.
ipcMain.handle('auth:getSession', () => {
    const store = getSessionStore();
    return {
        session: store.getSession(),
        encryptionAvailable: store.encryptionAvailable()
    };
});

// Persist a session handed up from the renderer after a successful verify or a
// silent token refresh. Returns { ok, reason } so the UI can surface failures
// (e.g. encryption unavailable -> can't stay signed in across restarts).
ipcMain.handle('auth:setSession', (event, session) => {
    return getSessionStore().setSession(session);
});

// Clear the stored session on logout. Idempotent.
ipcMain.handle('auth:clearSession', () => {
    return getSessionStore().clearSession();
});

// ===== App Lifecycle =====
app.whenReady().then(() => {
    // Default to enabled on first run only. If the user has already turned it
    // off, respect that choice on subsequent launches.
    if (!store_hasSeenStartupPref()) {
        setLaunchAtStartup(true);
        store_markSeenStartupPref();
    }
    createMainWindow();
    startSyncServer();
    initAutoUpdater();
});

// Tiny persistence for the "has the app configured startup at least once" flag,
// so we only force-enable on the very first launch. Stored next to userData.
const fs = require('fs');
function store_prefPath() {
    return path.join(app.getPath('userData'), 'startup-pref.json');
}
function store_hasSeenStartupPref() {
    try {
        return fs.existsSync(store_prefPath());
    } catch (e) {
        return false;
    }
}
function store_markSeenStartupPref() {
    try {
        fs.writeFileSync(store_prefPath(), JSON.stringify({ initialized: true }));
    } catch (e) {
        console.error('Failed to persist startup preference flag:', e);
    }
}

// ===== Auto-Update (electron-updater + GitHub Releases) =====
// On launch, the packaged app checks GitHub Releases for a newer version.
// Windows (NSIS) can download and install in-place on restart. macOS builds are
// unsigned, so silent install isn't possible there — we instead notify the user
// and point them to the download page. In dev (unpackaged) we skip entirely.
let updateDownloaded = false;

function sendToRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
}

function initAutoUpdater() {
    // Only meaningful for packaged builds; `electron .` has no update feed.
    if (!app.isPackaged) return;

    // We drive download/install from our own UI, so don't auto-download blindly.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
        // macOS is unsigned here: electron-updater can't install it, so just
        // tell the renderer a new version exists and let it link to Releases.
        if (process.platform === 'darwin') {
            sendToRenderer('update-available-manual', {
                version: info.version,
                url: 'https://github.com/sonellmalik/Intention/releases/latest'
            });
            return;
        }
        // Windows: start downloading in the background.
        sendToRenderer('update-downloading', { version: info.version });
        autoUpdater.downloadUpdate().catch((err) => {
            console.error('Update download failed:', err);
        });
    });

    autoUpdater.on('update-not-available', () => {
        sendToRenderer('update-not-available');
    });

    autoUpdater.on('download-progress', (progress) => {
        sendToRenderer('update-progress', { percent: Math.round(progress.percent) });
    });

    autoUpdater.on('update-downloaded', (info) => {
        updateDownloaded = true;
        sendToRenderer('update-ready', { version: info.version });
    });

    autoUpdater.on('error', (err) => {
        console.error('Auto-updater error:', err);
        // Non-fatal: the app keeps running on the current version.
    });

    // Kick off a check shortly after startup so it doesn't compete with launch.
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch((err) => {
            console.error('Update check failed:', err);
        });
    }, 4000);
}

// Renderer asks to install the downloaded update now (Windows).
ipcMain.on('install-update', () => {
    if (updateDownloaded) {
        autoUpdater.quitAndInstall();
    }
});

// Renderer asks to open the Releases page (macOS manual-update fallback).
ipcMain.on('open-release-page', () => {
    shell.openExternal('https://github.com/sonellmalik/Intention/releases/latest');
});

// Manual "check for updates" trigger from the UI.
ipcMain.on('check-for-updates', () => {
    if (!app.isPackaged) {
        sendToRenderer('update-not-available');
        return;
    }
    autoUpdater.checkForUpdates().catch((err) => {
        console.error('Manual update check failed:', err);
    });
});

app.on('window-all-closed', () => {
    disableFocusMode();
    stopSyncServer();
    app.quit();
});

app.on('before-quit', () => {
    disableFocusMode();
    stopSyncServer();
});

app.on('activate', () => {
    if (mainWindow === null) {
        createMainWindow();
    }
});
