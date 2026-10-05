// ===== Yap Sheet =====
// A running document for stray thoughts that pop up mid-work. The user types a
// thought, hits Add (or Ctrl/Cmd+Enter), and it's timestamped and stored. The
// log is grouped by the date each thought was written, newest day first, and
// persisted in localStorage so it survives restarts.
//
// Opened via window.openYapSheet() — from the "Yap Sheet" button in the big
// window's Focus Mode section, and (in Electron) from the mini overlay window
// which asks the main window to open it over IPC.
(function () {
    const STORAGE_KEY = 'yapSheetEntries';

    // Persistence uses the same focusflow_ helpers as the rest of the app when
    // available, with a direct-localStorage fallback so this module is robust
    // even if load order changes.
    function readEntries() {
        if (typeof loadData === 'function') {
            const v = loadData(STORAGE_KEY, []);
            return Array.isArray(v) ? v : [];
        }
        try {
            const raw = localStorage.getItem('focusflow_' + STORAGE_KEY);
            const v = raw ? JSON.parse(raw) : [];
            return Array.isArray(v) ? v : [];
        } catch (e) {
            return [];
        }
    }

    function writeEntries(entries) {
        if (typeof saveData === 'function') {
            saveData(STORAGE_KEY, entries);
        } else {
            try {
                localStorage.setItem('focusflow_' + STORAGE_KEY, JSON.stringify(entries));
            } catch (e) { /* ignore quota errors */ }
        }
    }

    // Each entry: { id, ts (ISO string), text }
    let entries = readEntries();

    let overlay = null;
    let composerEl, logEl;

    // ----- Date helpers -----
    function dateKey(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function formatDayLabel(key) {
        const [y, m, d] = key.split('-').map(Number);
        const date = new Date(y, m - 1, d);
        const today = new Date();
        const todayKey = dateKey(today);
        const yest = new Date(today);
        yest.setDate(today.getDate() - 1);
        const yestKey = dateKey(yest);

        if (key === todayKey) return 'Today';
        if (key === yestKey) return 'Yesterday';
        return date.toLocaleDateString(undefined, {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
        });
    }

    function formatTime(iso) {
        const d = new Date(iso);
        return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ----- Rendering -----
    function render() {
        if (!logEl) return;

        if (entries.length === 0) {
            logEl.innerHTML = '<p class="yapsheet-empty">No thoughts yet. Jot one down when it pops up so you can stay in flow.</p>';
            return;
        }

        // Group entries by their local date, newest day first, newest entry
        // within a day last (so a day reads top-to-bottom chronologically).
        const groups = {};
        entries.forEach(e => {
            const key = dateKey(new Date(e.ts));
            (groups[key] = groups[key] || []).push(e);
        });

        const dayKeys = Object.keys(groups).sort().reverse();

        logEl.innerHTML = dayKeys.map(key => {
            const dayEntries = groups[key]
                .slice()
                .sort((a, b) => new Date(a.ts) - new Date(b.ts));
            const rows = dayEntries.map(e => `
                <div class="yapsheet-entry" data-id="${escapeHtml(String(e.id))}">
                    <span class="yapsheet-entry-time">${escapeHtml(formatTime(e.ts))}</span>
                    <span class="yapsheet-entry-text">${escapeHtml(e.text)}</span>
                    <button class="yapsheet-entry-delete" data-id="${escapeHtml(String(e.id))}" title="Delete">&times;</button>
                </div>
            `).join('');
            return `
                <div class="yapsheet-day">
                    <div class="yapsheet-day-label">${escapeHtml(formatDayLabel(key))}</div>
                    ${rows}
                </div>
            `;
        }).join('');

        logEl.querySelectorAll('.yapsheet-entry-delete').forEach(btn => {
            btn.addEventListener('click', () => deleteEntry(btn.dataset.id));
        });
    }

    function addEntry(text) {
        const trimmed = (text || '').trim();
        if (!trimmed) return;
        entries.push({
            id: 'yap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            ts: new Date().toISOString(),
            text: trimmed
        });
        writeEntries(entries);
        render();
    }

    function deleteEntry(id) {
        entries = entries.filter(e => String(e.id) !== String(id));
        writeEntries(entries);
        render();
    }

    // ----- Overlay lifecycle -----
    function build() {
        if (overlay) return;

        overlay = document.createElement('div');
        overlay.className = 'yapsheet-overlay';
        overlay.innerHTML = `
            <div class="yapsheet-header">
                <div class="yapsheet-title">
                    <h2>Yap Sheet</h2>
                    <p>Dump a thought, keep your flow.</p>
                </div>
                <button class="yapsheet-close" id="yapsheet-close" title="Close">&times;</button>
            </div>
            <div class="yapsheet-composer">
                <textarea id="yapsheet-input" placeholder="What's on your mind? (Ctrl+Enter to add)"></textarea>
                <button class="yapsheet-add-btn" id="yapsheet-add">Add</button>
            </div>
            <div class="yapsheet-log" id="yapsheet-log"></div>
        `;
        document.body.appendChild(overlay);

        composerEl = overlay.querySelector('#yapsheet-input');
        logEl = overlay.querySelector('#yapsheet-log');
        const addBtn = overlay.querySelector('#yapsheet-add');
        const closeBtn = overlay.querySelector('#yapsheet-close');

        function commit() {
            addEntry(composerEl.value);
            composerEl.value = '';
            composerEl.focus();
        }

        addBtn.addEventListener('click', commit);

        composerEl.addEventListener('keydown', (e) => {
            // Ctrl/Cmd+Enter adds the thought quickly without leaving the keyboard.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                commit();
            }
        });

        closeBtn.addEventListener('click', close);

        // Escape closes the sheet.
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
        });
    }

    function open() {
        build();
        entries = readEntries(); // pick up anything written elsewhere
        render();
        overlay.classList.add('active');
        overlay.setAttribute('tabindex', '-1');
        // Focus the composer so the user can start typing immediately.
        setTimeout(() => composerEl && composerEl.focus(), 0);
    }

    function close() {
        if (overlay) overlay.classList.remove('active');
    }

    // Expose for buttons.
    window.openYapSheet = open;
    window.closeYapSheet = close;

    // In Electron, the mini overlay's Yap Sheet button asks the main window to
    // open the sheet here.
    if (window.electronAPI && typeof window.electronAPI.onOpenYapSheet === 'function') {
        window.electronAPI.onOpenYapSheet(() => open());
    }
})();
