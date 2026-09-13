// ===== Pomodoro Timer =====
let DURATIONS = {
    work: 25 * 60,
    shortBreak: 5 * 60,
    longBreak: 15 * 60
};

// Load saved custom durations
const savedDurations = loadData('timerDurations', null);
if (savedDurations) {
    DURATIONS = savedDurations;
}

const MAX_SESSIONS = 8;
const REFLECTION_INTERVAL = 4; // Show reflection every 4 sessions

window.timerState = {
    mode: 'work',
    timeLeft: DURATIONS.work,
    isRunning: false,
    intervalId: null,
    session: 1,
    completedWorkSessions: 0,
    sessionDistractions: 0,
    distractionTimestamps: [],
    sessionDuration: DURATIONS.work,
    // Pause tracking
    pauseStartedAt: null,
    totalPauseTime: 0,
    pauseCount: 0
};

// ===== Midnight Session Reset =====
// Reset session count at 12:00 AM each day
(function initMidnightReset() {
    const lastResetDate = loadData('lastSessionResetDate', null);
    const todayStr = new Date().toDateString();

    // If app opens on a new day, reset immediately
    if (lastResetDate !== todayStr) {
        resetDailySessions();
    }

    // Schedule reset at next midnight
    scheduleMidnightReset();
})();

function resetDailySessions() {
    window.timerState.session = 1;
    window.timerState.completedWorkSessions = 0;
    saveData('lastSessionResetDate', new Date().toDateString());

    // Update display if session number element exists
    const sn = document.getElementById('session-number');
    if (sn) sn.textContent = '1';
}

function scheduleMidnightReset() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0); // next midnight
    const msUntilMidnight = midnight.getTime() - now.getTime();

    setTimeout(() => {
        resetDailySessions();
        // Then schedule again for the following midnight
        scheduleMidnightReset();
    }, msUntilMidnight);
}

const timerMinutes = document.getElementById('timer-minutes');
const timerSeconds = document.getElementById('timer-seconds');
const btnStart = document.getElementById('btn-start');
const btnPause = document.getElementById('btn-pause');
const btnReset = document.getElementById('btn-reset');
const btnMinimize = document.getElementById('btn-minimize');
const sessionNumber = document.getElementById('session-number');
const modeTabs = document.querySelectorAll('.mode-tab');
const miniTimerTime = document.getElementById('mini-timer-time');
const miniTimerToggle = document.getElementById('mini-btn-toggle');

// Check if running inside Electron
const isElectron = !!(window.electronAPI);

// ===== iOS Focus Companion session identity =====
// Tracks the current session so the desktop can emit sessionStarted /
// sessionStopped to a paired phone (see main.js task 8.3). The same sessionId
// is reused for a start/stop pair; a fresh one is minted per session start.
window.timerState.currentSessionId = null;
window.timerState.currentSessionStartedAt = null;

function generateSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
    }
    // Fallback for older runtimes: timestamp + random suffix.
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

// YYYY-MM-DD in local time, matching history.js getDateKey().
function currentDateKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// Build the sessionStarted info payload for the current run and remember the
// sessionId so timerStopped() can reference the same session.
function beginSyncSession() {
    const sessionId = generateSessionId();
    const startedAt = new Date().toISOString();
    window.timerState.currentSessionId = sessionId;
    window.timerState.currentSessionStartedAt = startedAt;
    return {
        sessionId,
        dateKey: currentDateKey(),
        mode: window.timerState.mode,
        startedAt,
        plannedDuration: DURATIONS[window.timerState.mode]
    };
}

// Info for sessionStopped; clears the tracked session id.
function endSyncSession(reason) {
    const sessionId = window.timerState.currentSessionId;
    window.timerState.currentSessionId = null;
    window.timerState.currentSessionStartedAt = null;
    return { sessionId: sessionId || '', reason: reason || 'stopped' };
}

function getTimeString() {
    const mins = Math.floor(window.timerState.timeLeft / 60);
    const secs = window.timerState.timeLeft % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function updateDisplay() {
    const mins = Math.floor(window.timerState.timeLeft / 60);
    const secs = window.timerState.timeLeft % 60;
    timerMinutes.textContent = String(mins).padStart(2, '0');
    timerSeconds.textContent = String(secs).padStart(2, '0');
    miniTimerTime.textContent = getTimeString();
    document.title = `${getTimeString()} - FocusFlow`;

    // Send tick to Electron mini window
    if (isElectron && window.timerState.isRunning) {
        window.electronAPI.timerTick(getTimeString());
        sendCurrentTimeBlockTask();
    }
}

// ===== Current scheduler time-block -> mini overlay =====
// Finds the calendar block that spans the current time and sends its title to
// the mini timer window so it shows what's planned right now, under the timer.
let _lastSentTaskTitle = null;

function getCurrentTimeBlockTitle() {
    const blocks = (typeof loadData === 'function') ? loadData('timeblocksV2', []) : [];
    if (!Array.isArray(blocks) || blocks.length === 0) return null;

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    // A block covers now when start <= now < end (minutes from midnight).
    const current = blocks.find(b =>
        typeof b.start === 'number' && typeof b.end === 'number' &&
        nowMin >= b.start && nowMin < b.end
    );

    return current ? current.task : null;
}

function sendCurrentTimeBlockTask() {
    if (!isElectron || !window.electronAPI.timerTaskChanged) return;
    const title = getCurrentTimeBlockTitle();
    // Only send when it changes to avoid needless IPC chatter every tick.
    if (title !== _lastSentTaskTitle) {
        _lastSentTaskTitle = title;
        window.electronAPI.timerTaskChanged(title || '');
    }
}

function tick() {
    if (window.timerState.timeLeft <= 0) {
        completeSession();
        return;
    }
    window.timerState.timeLeft--;
    updateDisplay();
}

function completeSession() {
    window.pauseTimer();
    playNotification();
    btnMinimize.style.display = 'none';

    // In Electron, stop the mini overlay on session complete
    if (isElectron) {
        window.electronAPI.timerStopped(endSyncSession('completed'));
    }

    if (window.timerState.mode === 'work') {
        window.timerState.completedWorkSessions++;

        // Log this pomodoro to history
        if (window.logCompletedPomodoro) {
            window.logCompletedPomodoro();
        }

        // Show distraction timeline if there were distractions or pauses
        if (window.timerState.distractionTimestamps.length > 0 || window.timerState.totalPauseTime > 0) {
            showDistractionTimeline();
            // Reflection will show after timeline is closed (if due)
        } else {
            // No distractions — show reflection directly if due
            if (window.timerState.completedWorkSessions % REFLECTION_INTERVAL === 0) {
                showReflection();
            }
        }

        if (window.timerState.session >= MAX_SESSIONS) {
            switchMode('longBreak');
            window.timerState.session = 1;
        } else {
            switchMode('shortBreak');
            window.timerState.session++;
        }
    } else {
        switchMode('work');
    }
    sessionNumber.textContent = window.timerState.session;
}

function playNotification() {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('FocusFlow', {
            body: window.timerState.mode === 'work'
                ? 'Work session complete! Take a break.'
                : 'Break over! Time to focus.'
        });
    }
    // Simple audio beep
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 800;
        gain.gain.value = 0.3;
        osc.start();
        setTimeout(() => { osc.stop(); ctx.close(); }, 200);
    } catch(e) {}
}

window.startTimer = function() {
    if (window.timerState.isRunning) return;
    window.timerState.isRunning = true;
    window.timerState.intervalId = setInterval(tick, 1000);

    // If resuming from a pause during a work session, record pause duration
    if (window.timerState.mode === 'work' && window.timerState.pauseStartedAt) {
        const pausedMs = Date.now() - window.timerState.pauseStartedAt;
        window.timerState.totalPauseTime += Math.round(pausedMs / 1000);
        window.timerState.pauseStartedAt = null;
    }

    // Reset distraction timestamps when a new work session starts fresh
    if (window.timerState.mode === 'work' && window.timerState.timeLeft === DURATIONS.work) {
        window.timerState.distractionTimestamps = [];
        window.timerState.sessionDuration = DURATIONS.work;
        window.timerState.totalPauseTime = 0;
        window.timerState.pauseCount = 0;
        window.timerState.pauseStartedAt = null;
    }

    btnStart.disabled = true;
    btnPause.disabled = false;
    if (isElectron) btnMinimize.style.display = 'inline-block';
    miniTimerToggle.textContent = '⏸';
    updateMiniTimerVisibility();

    // Electron: minimize main window, show mini overlay
    if (isElectron) {
        // Mint a fresh sync session only when starting one (not resuming a pause).
        const sessionInfo = window.timerState.currentSessionId
            ? null
            : beginSyncSession();
        window.electronAPI.timerStarted(sessionInfo);
        window.electronAPI.timerModeChanged(window.timerState.mode);
        // Push the current time-block title once the mini overlay has mounted.
        _lastSentTaskTitle = null;
        setTimeout(sendCurrentTimeBlockTask, 300);
    }
};

window.pauseTimer = function() {
    window.timerState.isRunning = false;
    clearInterval(window.timerState.intervalId);
    window.timerState.intervalId = null;

    // Track pause start if mid-work-session
    if (window.timerState.mode === 'work' && window.timerState.timeLeft < DURATIONS.work && window.timerState.timeLeft > 0) {
        window.timerState.pauseStartedAt = Date.now();
        window.timerState.pauseCount++;
    }

    btnStart.disabled = false;
    btnPause.disabled = true;
    miniTimerToggle.textContent = '▶';
    updateMiniTimerVisibility();

    if (isElectron) {
        window.electronAPI.timerPaused();
    }
};

function resetTimer() {
    window.pauseTimer();
    window.timerState.timeLeft = DURATIONS[window.timerState.mode];
    window.timerState.distractionTimestamps = [];
    window.timerState.totalPauseTime = 0;
    window.timerState.pauseCount = 0;
    window.timerState.pauseStartedAt = null;
    btnMinimize.style.display = 'none';
    updateDisplay();

    // Electron: bring back main window
    if (isElectron) {
        window.electronAPI.timerStopped(endSyncSession('stopped'));
    }
}

function switchMode(mode) {
    window.timerState.mode = mode;
    window.timerState.timeLeft = DURATIONS[mode];
    modeTabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.mode === mode);
    });
    updateDisplay();

    if (isElectron) {
        window.electronAPI.timerModeChanged(mode);
    }
}

btnStart.addEventListener('click', window.startTimer);
btnPause.addEventListener('click', window.pauseTimer);
btnReset.addEventListener('click', resetTimer);

// Minimize to overlay button (Electron only, but works mid-pomodoro)
btnMinimize.addEventListener('click', () => {
    if (isElectron && window.timerState.isRunning) {
        // Re-minimizing an already-running session: no new sync session.
        window.electronAPI.timerStarted(null);
        window.electronAPI.timerModeChanged(window.timerState.mode);
        _lastSentTaskTitle = null;
        setTimeout(sendCurrentTimeBlockTask, 300);
    }
});

modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        window.pauseTimer();
        switchMode(tab.dataset.mode);
    });
});

// Listen for toggle from mini window (Electron IPC)
if (isElectron) {
    window.electronAPI.onToggleTimer(() => {
        if (window.timerState.isRunning) {
            window.pauseTimer();
        } else {
            window.startTimer();
        }
    });

    // Listen for distraction clicks from mini window
    window.electronAPI.onDistractionLogged((count) => {
        window.timerState.sessionDistractions = count;
        // Record elapsed work time (not wall-clock)
        if (window.timerState.mode === 'work') {
            const elapsed = window.timerState.sessionDuration - window.timerState.timeLeft;
            window.timerState.distractionTimestamps.push({ elapsed, tag: null });
        }
        // Log to daily history
        if (window.logDailyDistraction) {
            window.logDailyDistraction({ cause: null, duration: null, tag: null });
        }
    });
}

// Request notification permission
if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
}

// ===== Reflection Prompt =====
const reflectionModal = document.getElementById('reflection-modal');
const reflectionDistractionCount = document.getElementById('reflection-distraction-count');
const btnSaveReflection = document.getElementById('btn-save-reflection');
const btnSkipReflection = document.getElementById('btn-skip-reflection');
const energyBtns = document.querySelectorAll('.energy-btn');

let selectedEnergy = 'high';

energyBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        energyBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedEnergy = btn.dataset.energy;
    });
});

function showReflection() {
    // Combine logged distractions + quick distraction clicks
    const totalDistractions = distractions.length + window.timerState.sessionDistractions;
    reflectionDistractionCount.textContent = totalDistractions;

    // Show pause time
    const reflectionPauseTime = document.getElementById('reflection-pause-time');
    reflectionPauseTime.textContent = window.timerState.totalPauseTime > 0
        ? formatPauseTime(window.timerState.totalPauseTime)
        : '0s';

    reflectionModal.style.display = 'flex';
}

btnSaveReflection.addEventListener('click', () => {
    const goingWell = document.getElementById('reflection-going-well').value.trim();
    const improve = document.getElementById('reflection-improve').value.trim();

    const totalDistractions = distractions.length + window.timerState.sessionDistractions;

    // Save reflection
    const reflections = loadData('reflections', []);
    reflections.unshift({
        date: new Date().toLocaleString(),
        goingWell,
        improve,
        energy: selectedEnergy,
        distractions: totalDistractions,
        sessionsCompleted: window.timerState.completedWorkSessions
    });
    saveData('reflections', reflections);

    // Reset session distraction counter
    window.timerState.sessionDistractions = 0;
    closeReflection();
});

btnSkipReflection.addEventListener('click', closeReflection);

function closeReflection() {
    reflectionModal.style.display = 'none';
    document.getElementById('reflection-going-well').value = '';
    document.getElementById('reflection-improve').value = '';
    // Reset session distraction counter after reflection
    window.timerState.sessionDistractions = 0;
}

// ===== Timer Settings =====
const btnToggleSettings = document.getElementById('btn-toggle-settings');
const timerSettingsPanel = document.getElementById('timer-settings');
const btnSaveSettings = document.getElementById('btn-save-settings');
const settingWork = document.getElementById('setting-work');
const settingShortBreak = document.getElementById('setting-short-break');
const settingLongBreak = document.getElementById('setting-long-break');

// Populate inputs from current durations
settingWork.value = Math.round(DURATIONS.work / 60);
settingShortBreak.value = Math.round(DURATIONS.shortBreak / 60);
settingLongBreak.value = Math.round(DURATIONS.longBreak / 60);

btnToggleSettings.addEventListener('click', () => {
    const isVisible = timerSettingsPanel.style.display !== 'none';
    timerSettingsPanel.style.display = isVisible ? 'none' : 'block';
});

btnSaveSettings.addEventListener('click', () => {
    const workMin = parseInt(settingWork.value) || 25;
    const shortMin = parseInt(settingShortBreak.value) || 5;
    const longMin = parseInt(settingLongBreak.value) || 15;

    DURATIONS.work = Math.max(1, Math.min(120, workMin)) * 60;
    DURATIONS.shortBreak = Math.max(1, Math.min(30, shortMin)) * 60;
    DURATIONS.longBreak = Math.max(1, Math.min(60, longMin)) * 60;

    saveData('timerDurations', DURATIONS);

    // Reset timer to new duration if not running
    if (!window.timerState.isRunning) {
        window.timerState.timeLeft = DURATIONS[window.timerState.mode];
        updateDisplay();
    }

    timerSettingsPanel.style.display = 'none';
});

// ===== Launch at Startup toggle (Electron only) =====
const startupSettingRow = document.getElementById('startup-setting-row');
const settingLaunchStartup = document.getElementById('setting-launch-startup');

if (isElectron && startupSettingRow && settingLaunchStartup
    && window.electronAPI.getLaunchAtStartup) {
    // Only meaningful in the desktop app; reveal the row and sync its state
    startupSettingRow.style.display = 'flex';

    // Reflect the current OS-level setting
    window.electronAPI.getLaunchAtStartup()
        .then((enabled) => { settingLaunchStartup.checked = !!enabled; })
        .catch(() => {});

    // Flip the OS setting on toggle; re-sync to the confirmed result
    settingLaunchStartup.addEventListener('change', async () => {
        try {
            const confirmed = await window.electronAPI.setLaunchAtStartup(settingLaunchStartup.checked);
            settingLaunchStartup.checked = !!confirmed;
        } catch (e) {
            // Revert the checkbox if the change failed
            settingLaunchStartup.checked = !settingLaunchStartup.checked;
        }
    });
}

// ===== Focus Mode =====
const focusToggle = document.getElementById('focus-toggle');
const focusSelector = document.getElementById('focus-window-selector');
const systemWindowsSection = document.getElementById('system-windows-section');
const systemWindowsList = document.getElementById('system-windows-list');
const btnRefreshWindows = document.getElementById('btn-refresh-windows');
const btnApplyWindows = document.getElementById('btn-apply-windows');
const displayHint = document.getElementById('display-hint');

let displayCount = 1;              // number of connected monitors
let selectedWindowNames = new Set(); // titles the user has picked

focusToggle.addEventListener('change', async () => {
    if (focusToggle.checked) {
        document.body.classList.add('focus-mode');
        focusSelector.style.display = 'block';

        if (isElectron) {
            systemWindowsSection.style.display = 'block';

            // Detect how many displays are connected
            try {
                displayCount = await window.electronAPI.getDisplayCount();
            } catch (e) {
                displayCount = 1;
            }
            updateDisplayHint();

            await loadSystemWindows();

            // Start whole-screen greyscale immediately with no windows chosen yet.
            selectedWindowNames.clear();
            window.electronAPI.setFocusWindow([]);
        }
    } else {
        document.body.classList.remove('focus-mode');
        focusSelector.style.display = 'none';

        if (isElectron) {
            window.electronAPI.disableFocusMode();
            systemWindowsSection.style.display = 'none';
            selectedWindowNames.clear();
        }
    }
});

if (btnRefreshWindows) {
    btnRefreshWindows.addEventListener('click', loadSystemWindows);
}

if (btnApplyWindows) {
    btnApplyWindows.addEventListener('click', () => {
        if (!isElectron) return;
        // Commit the current selection; color returns for these windows
        window.electronAPI.updateFocusWindows(Array.from(selectedWindowNames));
        btnApplyWindows.textContent = 'Applied ✓';
        setTimeout(() => { btnApplyWindows.textContent = 'Apply'; }, 1500);
    });
}

function updateDisplayHint() {
    if (!displayHint) return;
    if (displayCount > 1) {
        displayHint.textContent = `${displayCount} displays detected. Pick one window per screen (up to ${displayCount}), then press Apply.`;
    } else {
        displayHint.textContent = 'Pick the window you want to keep in color, then press Apply.';
    }
}

// System window enumeration (Electron only)
async function loadSystemWindows() {
    if (!isElectron) return;
    try {
        const windows = await window.electronAPI.getOpenWindows();
        renderSystemWindows(windows);
    } catch(e) {
        systemWindowsList.innerHTML = '<p class="focus-desc">Could not load system windows.</p>';
    }
}

function renderSystemWindows(windows) {
    if (!windows || windows.length === 0) {
        systemWindowsList.innerHTML = '<p class="focus-desc">No windows detected.</p>';
        return;
    }

    systemWindowsList.innerHTML = windows.map(win => {
        const isSel = selectedWindowNames.has(win.name);
        return `
        <div class="system-window-item${isSel ? ' selected' : ''}" data-window-name="${escapeAttr(win.name)}">
            <span class="window-name">${escapeHtmlText(win.name)}</span>
            <span class="window-check">✓</span>
        </div>`;
    }).join('');

    systemWindowsList.querySelectorAll('.system-window-item').forEach(item => {
        item.addEventListener('click', () => {
            const name = item.dataset.windowName;
            if (selectedWindowNames.has(name)) {
                // Toggle off
                selectedWindowNames.delete(name);
                item.classList.remove('selected');
            } else {
                // Enforce the max = number of displays
                if (selectedWindowNames.size >= displayCount) {
                    // If at the limit, replace the oldest selection (simple + friendly)
                    const first = selectedWindowNames.values().next().value;
                    selectedWindowNames.delete(first);
                    const firstEl = systemWindowsList.querySelector(`.system-window-item[data-window-name="${cssEscape(first)}"]`);
                    if (firstEl) firstEl.classList.remove('selected');
                }
                selectedWindowNames.add(name);
                item.classList.add('selected');
            }
        });
    });
}

// Small helpers for safe rendering
function escapeHtmlText(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}
function escapeAttr(str) {
    return String(str).replace(/"/g, '&quot;');
}
function cssEscape(str) {
    return String(str).replace(/"/g, '\\"');
}

// ===== Distraction Logging =====
const btnAddDistraction = document.getElementById('btn-add-distraction');
const distractionForm = document.getElementById('distraction-form');
const btnSaveDistraction = document.getElementById('btn-save-distraction');
const btnCancelDistraction = document.getElementById('btn-cancel-distraction');
const distractionList = document.getElementById('distraction-list');
const distractionDuration = document.getElementById('distraction-duration');
const distractionCause = document.getElementById('distraction-cause');
const distractionHistory = document.getElementById('distraction-history');
const distractionToggle = document.getElementById('distraction-toggle');
const distractionToggleLabel = document.getElementById('distraction-toggle-label');

let distractions = loadData('distractions', []);
let distractionListExpanded = false;

// Collapsible toggle for previous entries
if (distractionToggle) {
    distractionToggle.addEventListener('click', () => {
        distractionListExpanded = !distractionListExpanded;
        distractionToggle.setAttribute('aria-expanded', String(distractionListExpanded));
        distractionToggle.classList.toggle('open', distractionListExpanded);
        distractionList.style.display = distractionListExpanded ? 'block' : 'none';
    });
}

renderDistractions();

btnAddDistraction.addEventListener('click', () => {
    distractionForm.style.display = 'block';
    distractionDuration.focus();
});

btnCancelDistraction.addEventListener('click', () => {
    distractionForm.style.display = 'none';
    distractionDuration.value = '';
    distractionCause.value = '';
});

btnSaveDistraction.addEventListener('click', () => {
    const duration = distractionDuration.value.trim();
    const cause = distractionCause.value.trim();
    if (!duration || !cause) return;

    const now = new Date();
    distractions.unshift({
        duration,
        cause,
        time: now.toLocaleTimeString(),
        date: now.toLocaleDateString()
    });
    saveData('distractions', distractions);
    renderDistractions();
    distractionForm.style.display = 'none';
    distractionDuration.value = '';
    distractionCause.value = '';

    // Log to daily history
    if (window.logDailyDistraction) {
        window.logDailyDistraction({ cause, duration, tag: null });
    }

    // Also record timestamp for the timeline
    if (window.timerState.mode === 'work' && window.timerState.isRunning) {
        const elapsed = window.timerState.sessionDuration - window.timerState.timeLeft;
        window.timerState.distractionTimestamps.push({ elapsed, tag: null });
    }
});

function renderDistractions() {
    // Show/hide the whole collapsible section based on whether there are entries
    if (distractionHistory) {
        distractionHistory.style.display = distractions.length > 0 ? 'block' : 'none';
    }
    if (distractionToggleLabel) {
        distractionToggleLabel.textContent = `Previous entries (${distractions.length})`;
    }

    distractionList.innerHTML = distractions.slice(0, 10).map(d => {
        // Older entries may not have a date; show date + time when available
        const when = d.date ? `${d.date}, ${d.time}` : (d.time || '');
        return `
        <li>
            <span class="distraction-duration">${d.duration}</span>${when ? ` at ${when}` : ''}
            <span class="distraction-cause">${d.cause}</span>
        </li>`;
    }).join('');

    // Respect the current expanded/collapsed state
    distractionList.style.display = distractionListExpanded ? 'block' : 'none';
}

// Initial display
updateDisplay();

// ===== Distraction Timeline =====
const timelineModal = document.getElementById('timeline-modal');
const timelineBar = document.getElementById('timeline-bar');
const timelineTagPanel = document.getElementById('timeline-tag-panel');
const btnTimelineDone = document.getElementById('btn-timeline-done');
const btnTimelineSkip = document.getElementById('btn-timeline-skip');

let activeTimelineDot = null;

function showDistractionTimeline() {
    const timestamps = window.timerState.distractionTimestamps;
    const hasPauses = window.timerState.totalPauseTime > 0;

    if (timestamps.length === 0 && !hasPauses) return;

    const totalDuration = window.timerState.sessionDuration;
    const totalMin = Math.round(totalDuration / 60);

    // Show pause stats
    const pauseStatsEl = document.getElementById('timeline-pause-stats');
    if (hasPauses) {
        pauseStatsEl.innerHTML = `
            <div class="pause-summary">
                <span class="pause-icon">⏸</span>
                <span class="pause-text">Paused ${window.timerState.pauseCount} time${window.timerState.pauseCount > 1 ? 's' : ''} for ${formatPauseTime(window.timerState.totalPauseTime)}</span>
            </div>
        `;
    } else {
        pauseStatsEl.innerHTML = '';
    }

    // Build the timeline (only if there are dots)
    if (timestamps.length > 0) {
        timelineBar.innerHTML = `
            <div class="timeline-track">
                <div class="timeline-line"></div>
                ${timestamps.map((t, i) => {
                    const pct = Math.min((t.elapsed / totalDuration) * 100, 100);
                    return `<div class="timeline-dot" data-index="${i}" style="left:${pct}%;" title="${formatSeconds(t.elapsed)}">
                        <span class="dot-icon">${t.tag ? getTagIcon(t.tag) : ''}</span>
                    </div>`;
                }).join('')}
                <span class="timeline-start">0:00</span>
                <span class="timeline-end">${totalMin}:00</span>
            </div>
        `;
    } else {
        timelineBar.innerHTML = '<p class="no-data" style="text-align:center; margin:0.8rem 0;">No distraction taps this session.</p>';
    }

    timelineModal.style.display = 'flex';
    timelineTagPanel.style.display = 'none';
    activeTimelineDot = null;

    // Add click listeners to dots
    timelineBar.querySelectorAll('.timeline-dot').forEach(dot => {
        dot.addEventListener('click', () => {
            // Highlight this dot
            timelineBar.querySelectorAll('.timeline-dot').forEach(d => d.classList.remove('active'));
            dot.classList.add('active');
            activeTimelineDot = parseInt(dot.dataset.index);
            timelineTagPanel.style.display = 'block';
        });
    });
}

function formatSeconds(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatPauseTime(totalSecs) {
    if (totalSecs < 60) return `${totalSecs}s`;
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    if (secs === 0) return `${mins}m`;
    return `${mins}m ${secs}s`;
}

function getTagIcon(tag) {
    switch(tag) {
        case 'phone': return '&#128241;';
        case 'people': return '&#128101;';
        case 'thought': return '&#128173;';
        case 'other': return '&#10067;';
        default: return '';
    }
}

// Tag button clicks
document.querySelectorAll('.tag-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (activeTimelineDot === null) return;
        const tag = btn.dataset.tag;
        window.timerState.distractionTimestamps[activeTimelineDot].tag = tag;

        // Update the dot visually
        const dot = timelineBar.querySelector(`.timeline-dot[data-index="${activeTimelineDot}"]`);
        if (dot) {
            dot.querySelector('.dot-icon').innerHTML = getTagIcon(tag);
            dot.classList.add('tagged');
            dot.classList.remove('active');
        }

        timelineTagPanel.style.display = 'none';
        activeTimelineDot = null;
    });
});

btnTimelineDone.addEventListener('click', closeTimeline);
btnTimelineSkip.addEventListener('click', closeTimeline);

function closeTimeline() {
    timelineModal.style.display = 'none';
    // Save tagged distractions
    const tagged = loadData('taggedDistractions', []);
    tagged.push({
        date: new Date().toLocaleString(),
        session: window.timerState.completedWorkSessions,
        distractions: window.timerState.distractionTimestamps.slice()
    });
    saveData('taggedDistractions', tagged);

    // Update daily log with tags that were assigned
    if (window.logDailyDistraction) {
        const dLog = loadData('distractionDailyLog', {});
        const today = new Date();
        const y = today.getFullYear();
        const m = String(today.getMonth() + 1).padStart(2, '0');
        const d = String(today.getDate()).padStart(2, '0');
        const todayKey = `${y}-${m}-${d}`;
        const todayEntries = dLog[todayKey] || [];

        // Back-fill tags onto the most recent untagged entries
        const untaggedCount = todayEntries.filter(e => !e.tag).length;
        const timestamps = window.timerState.distractionTimestamps;
        let tagIndex = 0;
        for (let i = todayEntries.length - 1; i >= 0 && tagIndex < timestamps.length; i--) {
            if (!todayEntries[i].tag && timestamps[tagIndex] && timestamps[tagIndex].tag) {
                todayEntries[i].tag = timestamps[tagIndex].tag;
            }
            tagIndex++;
        }
        dLog[todayKey] = todayEntries;
        saveData('distractionDailyLog', dLog);
    }

    window.timerState.distractionTimestamps = [];

    // Show reflection if it's due (after timeline is dismissed)
    if (window.timerState.completedWorkSessions % REFLECTION_INTERVAL === 0) {
        showReflection();
    }
}
