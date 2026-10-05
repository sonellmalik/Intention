// ===== Box Breathing "Refocus" Overlay =====
// A full-screen 4-4-4-4 box-breathing guide. Opened by the "Refocus" button on
// the timer page (and, in Electron, from the mini overlay via the main window).
//
// Flow:
//   - Four 4-second phases per cycle: Breathe in -> Hold -> Breathe out -> Hold.
//   - A dot travels one edge of a box per phase.
//   - "Stop at 5 cycles" checked (default): auto-finishes after 5 cycles.
//   - Unchecked: keeps cycling until the user presses "End".
//   - On finish: shows "Now, let's get into it:" plus the current time-block
//     task (if any), then closes the overlay after 3 seconds.
(function () {
    const PHASE_MS = 4000;            // 4 seconds per phase
    const PHASES = ['Breathe in', 'Hold', 'Breathe out', 'Hold'];
    const STOP_CYCLES = 5;
    const OUTRO_MS = 3000;            // auto-close delay after finishing

    // Box path: the dot moves between these corners, one edge per phase.
    // Coordinates are relative to the box's top-left (matches the 240px box).
    const BOX = 240;
    const CORNERS = [
        { x: 0,   y: 0 },     // start (top-left)
        { x: BOX, y: 0 },     // after phase 1 -> top-right
        { x: BOX, y: BOX },   // after phase 2 -> bottom-right
        { x: 0,   y: BOX },   // after phase 3 -> bottom-left
        { x: 0,   y: 0 }      // after phase 4 -> back to top-left
    ];

    let overlay = null;
    let phaseEl, boxWrap, dotEl, countEl, controlsEl, checkEl, endBtn, outroEl, outroLeadEl, outroTaskEl;

    let running = false;
    let phaseIndex = 0;
    let cyclesDone = 0;
    let phaseTimer = null;
    let outroTimer = null;

    function buildOverlay() {
        if (overlay) return;

        overlay = document.createElement('div');
        overlay.className = 'breathing-overlay';
        overlay.innerHTML = `
            <div class="breathing-phase" id="breathing-phase"></div>
            <div class="breathing-box-wrap" id="breathing-box-wrap">
                <div class="breathing-box"></div>
                <div class="breathing-dot" id="breathing-dot"></div>
            </div>
            <div class="breathing-count" id="breathing-count"></div>
            <div class="breathing-controls">
                <label class="breathing-check">
                    <input type="checkbox" id="breathing-stop-check" checked>
                    Stop at ${STOP_CYCLES} breathing cycles
                </label>
                <button class="breathing-end-btn hidden" id="breathing-end-btn">End</button>
            </div>
            <div class="breathing-outro" id="breathing-outro">
                <div class="breathing-outro-lead">Now, let's get into it:</div>
                <div class="breathing-outro-task" id="breathing-outro-task"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        phaseEl = overlay.querySelector('#breathing-phase');
        boxWrap = overlay.querySelector('#breathing-box-wrap');
        dotEl = overlay.querySelector('#breathing-dot');
        countEl = overlay.querySelector('#breathing-count');
        controlsEl = overlay.querySelector('.breathing-controls');
        checkEl = overlay.querySelector('#breathing-stop-check');
        endBtn = overlay.querySelector('#breathing-end-btn');
        outroEl = overlay.querySelector('#breathing-outro');
        outroLeadEl = overlay.querySelector('.breathing-outro-lead');
        outroTaskEl = overlay.querySelector('#breathing-outro-task');

        // Toggling the checkbox shows/hides the End button live.
        checkEl.addEventListener('change', syncEndButton);
        endBtn.addEventListener('click', finish);

        // Escape ends the session too (a gentle escape hatch).
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') finish();
        });
    }

    function syncEndButton() {
        // End button is only needed when NOT auto-stopping at 5 cycles.
        endBtn.classList.toggle('hidden', checkEl.checked);
    }

    function moveDotTo(cornerIndex) {
        const c = CORNERS[cornerIndex];
        dotEl.style.transform = `translate(${c.x}px, ${c.y}px)`;
    }

    function startPhase(index) {
        phaseIndex = index;
        phaseEl.textContent = PHASES[index];
        // Move the dot to the corner reached at the END of this phase.
        moveDotTo(index + 1);

        phaseTimer = setTimeout(() => {
            const nextIndex = index + 1;
            if (nextIndex >= PHASES.length) {
                // Completed a full cycle.
                cyclesDone++;
                updateCount();
                if (checkEl.checked && cyclesDone >= STOP_CYCLES) {
                    finish();
                    return;
                }
                startPhase(0);
            } else {
                startPhase(nextIndex);
            }
        }, PHASE_MS);
    }

    function updateCount() {
        if (checkEl.checked) {
            countEl.textContent = `Cycle ${Math.min(cyclesDone + 1, STOP_CYCLES)} of ${STOP_CYCLES}`;
        } else {
            countEl.textContent = `Cycle ${cyclesDone + 1}`;
        }
    }

    // Resolve the task name for the current time block, if any.
    function getCurrentTaskName() {
        if (typeof getCurrentTimeBlockTitle === 'function') {
            const t = getCurrentTimeBlockTitle();
            return (t && t.trim()) ? t.trim() : null;
        }
        return null;
    }

    function finish() {
        if (!running) return;
        clearTimeout(phaseTimer);
        phaseTimer = null;

        // Swap to the outro screen.
        overlay.classList.add('showing-outro');
        const task = getCurrentTaskName();
        if (task) {
            outroTaskEl.textContent = task;
            outroTaskEl.style.display = '';
        } else {
            // No task planned: just show the lead line.
            outroTaskEl.textContent = '';
            outroTaskEl.style.display = 'none';
        }
        outroEl.classList.add('active');

        outroTimer = setTimeout(() => {
            close();
        }, OUTRO_MS);
    }

    function close() {
        clearTimeout(phaseTimer);
        clearTimeout(outroTimer);
        phaseTimer = null;
        outroTimer = null;
        running = false;
        if (overlay) {
            overlay.classList.remove('active', 'showing-outro');
            outroEl.classList.remove('active');
        }
    }

    // Public entry point: open and start a fresh breathing session.
    function open() {
        buildOverlay();
        if (running) return;

        running = true;
        phaseIndex = 0;
        cyclesDone = 0;

        overlay.classList.remove('showing-outro');
        outroEl.classList.remove('active');
        overlay.classList.add('active');

        // Reset the dot to the start corner without animating the reset itself.
        dotEl.style.transition = 'none';
        moveDotTo(0);
        // Force reflow so the next transform animates from the reset position.
        void dotEl.offsetWidth;
        dotEl.style.transition = `transform ${PHASE_MS}ms linear`;

        syncEndButton();
        updateCount();
        overlay.setAttribute('tabindex', '-1');
        overlay.focus();

        startPhase(0);
    }

    // Expose for buttons and IPC.
    window.startRefocusBreathing = open;

    // In Electron, the mini overlay's Refocus button asks the main window to
    // open the breathing overlay here.
    if (window.electronAPI && typeof window.electronAPI.onOpenRefocus === 'function') {
        window.electronAPI.onOpenRefocus(() => open());
    }
})();
