// ===== Full Calendar & Scheduling (Teams-style week/day view) =====
//
// A full-width calendar that lets you add events on ANY day, not just today.
// Week view shows all 7 days across the full window width; Day view zooms into
// a single day. Events are stored per-day and are unified with the app's
// existing schedule data so today's Scheduler blocks and past archived days
// show up here too.
//
// Data sources (all keyed by YYYY-MM-DD):
//   - focusflow_calendarEvents : events the user creates here (editable)
//   - focusflow_scheduleLog    : archived past-day schedules (read-only mirror)
//   - focusflow_timeblocksV2   : today's live Scheduler blocks (read-only mirror)
//
// Events created/edited in this view live in calendarEvents. The scheduler/
// history mirrors are shown for context so the calendar reflects everything.

(function initCalendar() {
    const root = document.getElementById('cw-calendar');
    if (!root) return; // page not present

    // Storage helpers. In the main app these come from app.js; in the
    // standalone calendar window app.js isn't loaded, so fall back to a local
    // implementation using the SAME focusflow_ localStorage keys/origin, which
    // means both windows read and write the same events.
    const loadData = (typeof window.loadData === 'function')
        ? window.loadData
        : function (key, fallback) {
            const d = localStorage.getItem(`focusflow_${key}`);
            return d ? JSON.parse(d) : fallback;
        };
    const saveData = (typeof window.saveData === 'function')
        ? window.saveData
        : function (key, data) {
            localStorage.setItem(`focusflow_${key}`, JSON.stringify(data));
        };

    // ----- Config -----
    const START_HOUR = 6;    // 6 AM
    const END_HOUR = 23;     // 11 PM
    const SLOT_MINUTES = 15; // snap granularity
    const HOUR_HEIGHT = 48;  // px per hour
    const GUTTER_WIDTH = 56; // px for the time labels column
    const PX_PER_MIN = HOUR_HEIGHT / 60;
    const TOTAL_MINUTES = (END_HOUR - START_HOUR) * 60;
    const GRID_HEIGHT = TOTAL_MINUTES * PX_PER_MIN;

    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    // ----- State -----
    let view = loadData('calendarView', 'week'); // 'week' | 'day'
    if (view !== 'week' && view !== 'day') view = 'week';
    let anchor = new Date(); // any date within the currently viewed period
    anchor.setHours(0, 0, 0, 0);

    // Drag-to-create state
    let dragging = false;
    let dragDayKey = null;
    let dragStartMin = null;
    let dragEndMin = null;
    let dragColEl = null;
    let dragHighlightEl = null;

    // ----- Date helpers -----
    function dateKey(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function parseKey(key) {
        const [y, m, d] = key.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    function startOfWeek(d) {
        // Week starts on Monday (matches the History calendar labels)
        const copy = new Date(d);
        copy.setHours(0, 0, 0, 0);
        const day = copy.getDay();          // 0 = Sun
        const offset = (day === 0) ? 6 : day - 1;
        copy.setDate(copy.getDate() - offset);
        return copy;
    }

    function addDays(d, n) {
        const copy = new Date(d);
        copy.setDate(copy.getDate() + n);
        return copy;
    }

    function isSameDay(a, b) {
        return a.getFullYear() === b.getFullYear()
            && a.getMonth() === b.getMonth()
            && a.getDate() === b.getDate();
    }

    // The list of Date objects for the current period (7 for week, 1 for day)
    function periodDays() {
        if (view === 'day') return [new Date(anchor)];
        const start = startOfWeek(anchor);
        return Array.from({ length: 7 }, (_, i) => addDays(start, i));
    }

    // ----- Formatting -----
    function fmtTime(mins) {
        let h = Math.floor(mins / 60);
        const m = mins % 60;
        const ampm = h >= 12 ? 'PM' : 'AM';
        let dh = h % 12;
        if (dh === 0) dh = 12;
        return `${dh}:${String(m).padStart(2, '0')} ${ampm}`;
    }

    function fmtHourLabel(h) {
        const ampm = h >= 12 ? 'PM' : 'AM';
        let dh = h % 12;
        if (dh === 0) dh = 12;
        return `${dh} ${ampm}`;
    }

    function escapeHtmlLocal(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    function toHHMM(mins) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    function fromHHMM(str) {
        const [h, m] = String(str).split(':').map(Number);
        if (isNaN(h) || isNaN(m)) return null;
        return h * 60 + m;
    }

    // ----- Event store -----
    // User-created events (editable). Shape: { [dateKey]: [{id,start,end,task,type}] }
    function getEvents() {
        return loadData('calendarEvents', {}) || {};
    }

    function saveEvents(store) {
        saveData('calendarEvents', store);
    }

    // Add an item to the shared To-Do list (focusflow_todos), unless an active
    // to-do with the same text already exists. `type` maps 'break' -> break
    // task, everything else -> a normal todo. Used by the "Also add to To-Do
    // list" checkbox. Writing localStorage notifies the main app via `storage`.
    function addToTodoList(text, type) {
        const t = (text || '').trim();
        if (!t) return;
        const todos = loadData('todos', []) || [];
        const arr = Array.isArray(todos) ? todos : [];
        const exists = arr.some(x => x && !x.completed && (x.text || '').trim().toLowerCase() === t.toLowerCase());
        if (exists) return;
        arr.push({
            text: t,
            priority: 'normal',
            type: type === 'break' ? 'break' : 'todo',
            completed: false
        });
        saveData('todos', arr);
    }

    let _idc = Date.now();
    function newId() {
        return 'ev_' + (_idc++);
    }

    // Read-only mirrors from the rest of the app, so the calendar shows the
    // full picture. These are tagged readOnly so we don't let them be edited
    // here (editing them belongs to the Scheduler page / history is immutable).
    function mirrorBlocksForDay(key) {
        const out = [];
        const todayKey = dateKey(new Date());

        // Today's live Scheduler blocks
        if (key === todayKey) {
            const live = loadData('timeblocksV2', []) || [];
            live.forEach(b => out.push({
                id: 'live_' + b.id,
                start: b.start, end: b.end, task: b.task,
                type: b.type || 'todo', readOnly: true, source: 'scheduler'
            }));
        } else {
            // Archived schedule for a past/other day
            const log = loadData('scheduleLog', {}) || {};
            const arr = log[key] || [];
            arr.forEach((b, i) => out.push({
                id: 'arch_' + key + '_' + i,
                start: b.start, end: b.end, task: b.task,
                type: b.type || 'todo', readOnly: true, source: 'history'
            }));
        }
        return out;
    }

    // All events to render for a given day = user events + read-only mirrors
    function eventsForDay(key) {
        const store = getEvents();
        const own = (store[key] || []).map(e => ({ ...e, readOnly: false }));
        return own.concat(mirrorBlocksForDay(key)).sort((a, b) => a.start - b.start);
    }

    function addEvent(key, ev) {
        const store = getEvents();
        if (!store[key]) store[key] = [];
        store[key].push(ev);
        store[key].sort((a, b) => a.start - b.start);
        saveEvents(store);
    }

    function updateEvent(key, id, patch) {
        const store = getEvents();
        const arr = store[key] || [];
        const idx = arr.findIndex(e => String(e.id) === String(id));
        if (idx === -1) return;
        arr[idx] = { ...arr[idx], ...patch };
        arr.sort((a, b) => a.start - b.start);
        saveEvents(store);
    }

    function deleteEvent(key, id) {
        const store = getEvents();
        const arr = store[key] || [];
        store[key] = arr.filter(e => String(e.id) !== String(id));
        saveEvents(store);
    }

    // ----- Layout: overlap columns -----
    // Given a day's events, assign each a column index + column count so
    // overlapping events sit side by side (Teams-style).
    function layoutColumns(events) {
        const items = events.map(e => ({ ...e }));
        let i = 0;
        while (i < items.length) {
            // Gather a cluster of mutually-overlapping events
            let clusterEnd = items[i].end;
            const cluster = [items[i]];
            let j = i + 1;
            while (j < items.length && items[j].start < clusterEnd) {
                cluster.push(items[j]);
                clusterEnd = Math.max(clusterEnd, items[j].end);
                j++;
            }
            // Assign columns greedily within the cluster
            const cols = []; // each col holds the end time of its last event
            cluster.forEach(ev => {
                let placed = false;
                for (let c = 0; c < cols.length; c++) {
                    if (ev.start >= cols[c]) {
                        ev._col = c;
                        cols[c] = ev.end;
                        placed = true;
                        break;
                    }
                }
                if (!placed) {
                    ev._col = cols.length;
                    cols.push(ev.end);
                }
            });
            const colCount = cols.length;
            cluster.forEach(ev => { ev._cols = colCount; });
            i = j;
        }
        return items;
    }

    // ----- Rendering -----
    const rangeLabel = document.getElementById('cw-range');

    function updateRangeLabel() {
        if (view === 'day') {
            const d = anchor;
            rangeLabel.textContent = `${DAY_NAMES[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
            return;
        }
        const days = periodDays();
        const s = days[0];
        const e = days[6];
        if (s.getMonth() === e.getMonth()) {
            rangeLabel.textContent = `${MONTHS[s.getMonth()]} ${s.getDate()} – ${e.getDate()}, ${s.getFullYear()}`;
        } else if (s.getFullYear() === e.getFullYear()) {
            rangeLabel.textContent = `${MONTHS[s.getMonth()]} ${s.getDate()} – ${MONTHS[e.getMonth()]} ${e.getDate()}, ${s.getFullYear()}`;
        } else {
            rangeLabel.textContent = `${MONTHS[s.getMonth()]} ${s.getDate()}, ${s.getFullYear()} – ${MONTHS[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
        }
    }

    function minutesToTop(mins) {
        return (mins - START_HOUR * 60) * PX_PER_MIN;
    }

    function render() {
        const days = periodDays();
        const now = new Date();

        root.className = 'cw-calendar ' + (view === 'day' ? 'view-day' : 'view-week');
        updateRangeLabel();

        const colTemplate = `${GUTTER_WIDTH}px repeat(${days.length}, 1fr)`;

        // Header row (day names + dates)
        let headHtml = `<div class="cw-header-row" style="grid-template-columns:${colTemplate}">`;
        headHtml += `<div class="cw-corner"></div>`;
        days.forEach(d => {
            const isToday = isSameDay(d, now);
            headHtml += `
                <div class="cw-day-head${isToday ? ' is-today' : ''}" data-key="${dateKey(d)}" title="Switch to this day">
                    <span class="cw-day-name">${DAY_NAMES[d.getDay()]}</span>
                    <span class="cw-day-num">${d.getDate()}</span>
                </div>`;
        });
        headHtml += `</div>`;

        // Scrollable grid: time gutter + day columns
        let gridHtml = `<div class="cw-scroll"><div class="cw-grid" style="grid-template-columns:${colTemplate};height:${GRID_HEIGHT}px">`;

        // Time gutter
        gridHtml += `<div class="cw-time-gutter">`;
        for (let h = START_HOUR; h <= END_HOUR; h++) {
            const top = minutesToTop(h * 60);
            gridHtml += `<span class="cw-hour-label" style="top:${top}px">${fmtHourLabel(h)}</span>`;
        }
        gridHtml += `</div>`;

        // Day columns
        days.forEach(d => {
            const key = dateKey(d);
            const isToday = isSameDay(d, now);
            gridHtml += `<div class="cw-daycol${isToday ? ' is-today' : ''}" data-key="${key}">`;

            // Hour + half-hour lines
            for (let h = START_HOUR; h <= END_HOUR; h++) {
                const top = minutesToTop(h * 60);
                gridHtml += `<div class="cw-hourline" style="top:${top}px"></div>`;
                if (h < END_HOUR) {
                    const halfTop = minutesToTop(h * 60 + 30);
                    gridHtml += `<div class="cw-halfline" style="top:${halfTop}px"></div>`;
                }
            }

            // Events
            const laidOut = layoutColumns(eventsForDay(key));
            laidOut.forEach(ev => {
                const top = minutesToTop(ev.start);
                const height = Math.max(14, (ev.end - ev.start) * PX_PER_MIN - 2);
                const colCount = ev._cols || 1;
                const col = ev._col || 0;
                const widthPct = 100 / colCount;
                const leftPct = widthPct * col;
                const typeClass = ev.type === 'break' ? ' break-event' : (ev.type === 'event' ? ' plain-event' : '');
                // Editable events get top/bottom resize handles (drag to change
                // start/end time), like the scheduler. Read-only mirrors don't.
                const handles = ev.readOnly ? '' : `
                        <div class="cw-event-resize cw-event-resize-top" data-edge="top" title="Drag to change start time"></div>
                        <div class="cw-event-resize cw-event-resize-bottom" data-edge="bottom" title="Drag to change end time"></div>`;
                gridHtml += `
                    <div class="cw-event${typeClass}"
                         data-key="${key}" data-id="${ev.id}" data-readonly="${ev.readOnly ? '1' : '0'}"
                         style="top:${top}px;height:${height}px;left:calc(${leftPct}% + 2px);width:calc(${widthPct}% - 4px)"
                         title="${escapeHtmlLocal(ev.task)} (${fmtTime(ev.start)}–${fmtTime(ev.end)})${ev.readOnly ? ' — from ' + (ev.source === 'scheduler' ? 'Scheduler' : 'History') : ''}">
                        ${handles}
                        <span class="cw-event-title">${ev.type === 'break' ? '&#9749; ' : ''}${escapeHtmlLocal(ev.task)}</span>
                        <span class="cw-event-time">${fmtTime(ev.start)} – ${fmtTime(ev.end)}</span>
                    </div>`;
            });

            gridHtml += `</div>`; // .cw-daycol
        });

        gridHtml += `</div></div>`; // .cw-grid .cw-scroll

        root.innerHTML = headHtml + gridHtml;

        wireDayHeaders();
        wireColumns();
        renderNowLine();
    }

    // Click a day header to jump into Day view for that date
    function wireDayHeaders() {
        root.querySelectorAll('.cw-day-head').forEach(head => {
            head.addEventListener('click', () => {
                anchor = parseKey(head.dataset.key);
                anchor.setHours(0, 0, 0, 0);
                setView('day');
            });
        });
    }

    // Position of a pointer event within a day column, snapped to slot grid
    function minutesFromPointer(colEl, clientY) {
        const rect = colEl.getBoundingClientRect();
        let offsetY = clientY - rect.top;
        offsetY = Math.max(0, Math.min(offsetY, GRID_HEIGHT));
        let mins = START_HOUR * 60 + offsetY / PX_PER_MIN;
        mins = Math.round(mins / SLOT_MINUTES) * SLOT_MINUTES;
        return Math.max(START_HOUR * 60, Math.min(mins, END_HOUR * 60));
    }

    function wireColumns() {
        root.querySelectorAll('.cw-daycol').forEach(colEl => {
            colEl.addEventListener('mousedown', (e) => {
                // Pressing a resize handle starts a resize gesture, NOT the editor
                // and NOT a new-selection drag.
                const handle = e.target.closest('.cw-event-resize');
                if (handle) {
                    const hEvEl = handle.closest('.cw-event');
                    e.stopPropagation();
                    e.preventDefault();
                    if (hEvEl && hEvEl.dataset.readonly !== '1') {
                        startEventResize(hEvEl.dataset.key, hEvEl.dataset.id, handle.dataset.edge, e, hEvEl);
                    }
                    return;
                }

                // Clicking an existing event opens the editor instead of dragging
                const evEl = e.target.closest('.cw-event');
                if (evEl) {
                    e.stopPropagation();
                    if (evEl.dataset.readonly === '1') {
                        // Read-only mirror: show a gentle note, no edit
                        openReadonlyNote(evEl);
                    } else {
                        openEditor(evEl.dataset.key, evEl.dataset.id);
                    }
                    return;
                }

                dragging = true;
                dragColEl = colEl;
                dragDayKey = colEl.dataset.key;
                dragStartMin = minutesFromPointer(colEl, e.clientY);
                dragEndMin = dragStartMin;

                dragHighlightEl = document.createElement('div');
                dragHighlightEl.className = 'cw-select-highlight';
                colEl.appendChild(dragHighlightEl);
                updateDragHighlight();
                e.preventDefault();
            });
        });
    }

    function updateDragHighlight() {
        if (!dragHighlightEl) return;
        const lo = Math.min(dragStartMin, dragEndMin);
        const hi = Math.max(dragStartMin, dragEndMin);
        dragHighlightEl.style.top = minutesToTop(lo) + 'px';
        dragHighlightEl.style.height = Math.max(2, (hi - lo) * PX_PER_MIN) + 'px';
    }

    // ----- Scheduler-style event resizing -----
    // Drag an event's top or bottom edge to change its start/end time. Snaps to
    // the SLOT_MINUTES grid, keeps a minimum one-slot duration, and stays within
    // the calendar's visible hours. Persists via updateEvent + re-renders.
    let resizingEvent = false;

    function startEventResize(key, id, edge, e, el) {
        const store = getEvents();
        const ev = (store[key] || []).find(x => String(x.id) === String(id));
        if (!ev) return;

        resizingEvent = true;

        const gridStartMin = START_HOUR * 60;
        const gridEndMin = END_HOUR * 60;
        const startY = e.clientY;
        const origStart = ev.start;
        const origEnd = ev.end;

        // Working copy so we don't persist until mouseup.
        let curStart = origStart;
        let curEnd = origEnd;

        const snap = (mins) => Math.round(mins / SLOT_MINUTES) * SLOT_MINUTES;

        document.body.classList.add('cw-resizing');
        el.classList.add('resizing');

        const timeLabel = el.querySelector('.cw-event-time');

        function onMove(ev2) {
            const deltaMin = (ev2.clientY - startY) / PX_PER_MIN;
            if (edge === 'top') {
                let ns = snap(origStart + deltaMin);
                ns = Math.max(gridStartMin, Math.min(ns, origEnd - SLOT_MINUTES));
                curStart = ns;
            } else {
                let ne = snap(origEnd + deltaMin);
                ne = Math.min(gridEndMin, Math.max(ne, origStart + SLOT_MINUTES));
                curEnd = ne;
            }
            // Live-update position/size + time label without a full re-render.
            el.style.top = minutesToTop(curStart) + 'px';
            el.style.height = Math.max(14, (curEnd - curStart) * PX_PER_MIN - 2) + 'px';
            if (timeLabel) timeLabel.textContent = `${fmtTime(curStart)} – ${fmtTime(curEnd)}`;
        }

        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.classList.remove('cw-resizing');
            // Defer clearing so the trailing click (if any) is still suppressed.
            setTimeout(() => { resizingEvent = false; }, 0);

            if (curStart !== origStart || curEnd !== origEnd) {
                updateEvent(key, id, { start: curStart, end: curEnd });
            }
            render();
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', (e) => {
        if (!dragging || !dragColEl) return;
        dragEndMin = minutesFromPointer(dragColEl, e.clientY);
        updateDragHighlight();
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;

        const lo = Math.min(dragStartMin, dragEndMin);
        let hi = Math.max(dragStartMin, dragEndMin);
        // A plain click (no real drag) defaults to a 60-min event
        if (hi - lo < SLOT_MINUTES) hi = Math.min(END_HOUR * 60, lo + 60);

        const key = dragDayKey;
        if (dragHighlightEl && dragHighlightEl.parentNode) {
            dragHighlightEl.parentNode.removeChild(dragHighlightEl);
        }
        dragHighlightEl = null;
        dragColEl = null;
        dragDayKey = null;

        if (key && hi > lo) {
            openEditor(key, null, lo, hi);
        }
    });

    // ----- Current-time line -----
    // Draw the "now" line on render. Delegates to updateNowLine so the same
    // positioning logic is used whether we're first drawing it or moving it.
    function renderNowLine() {
        updateNowLine();
    }

    // Position (or reposition) the current-time line so it moves with the clock.
    // Called on render and on a short interval so it visibly ticks down, like the
    // scheduler's now-line. Removes the line when today isn't in view or the
    // time is outside the calendar's visible hours.
    function updateNowLine() {
        // Remove any existing line first so it never lingers in the wrong column.
        const existing = root.querySelector('.cw-now-line');
        if (existing) existing.remove();

        const now = new Date();
        // Include seconds so the line advances smoothly between minute ticks.
        const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
        if (nowMin < START_HOUR * 60 || nowMin > END_HOUR * 60) return;

        const days = periodDays();
        const todayIdx = days.findIndex(d => isSameDay(d, now));
        if (todayIdx === -1) return; // today not in view (e.g. viewing another week)

        const cols = root.querySelectorAll('.cw-daycol');
        const colEl = cols[todayIdx];
        if (!colEl) return;

        const line = document.createElement('div');
        line.className = 'cw-now-line';
        line.style.top = minutesToTop(nowMin) + 'px';
        colEl.appendChild(line);
    }

    // ----- Editor modal -----
    function openEditor(key, id, presetStart, presetEnd) {
        const store = getEvents();
        const existing = id ? (store[key] || []).find(e => String(e.id) === String(id)) : null;

        const startMin = existing ? existing.start : (presetStart != null ? presetStart : 9 * 60);
        const endMin = existing ? existing.end : (presetEnd != null ? presetEnd : startMin + 60);
        const task = existing ? existing.task : '';
        const type = existing ? (existing.type || 'event') : 'event';
        const d = parseKey(key);
        const dateStr = `${DAY_NAMES[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;

        const modal = document.createElement('div');
        modal.className = 'cw-modal';
        modal.innerHTML = `
            <div class="cw-modal-content">
                <h3>${existing ? 'Edit event' : 'New event'} · ${dateStr}</h3>
                <div class="cw-field">
                    <label for="cw-ev-title">Title</label>
                    <input type="text" id="cw-ev-title" placeholder="What's happening?" value="${escapeHtmlLocal(task)}">
                </div>
                <div class="cw-field-row">
                    <div class="cw-field">
                        <label for="cw-ev-start">Start</label>
                        <input type="time" id="cw-ev-start" value="${toHHMM(startMin)}" step="300">
                    </div>
                    <div class="cw-field">
                        <label for="cw-ev-end">End</label>
                        <input type="time" id="cw-ev-end" value="${toHHMM(endMin)}" step="300">
                    </div>
                </div>
                <div class="cw-field">
                    <label for="cw-ev-type">Type</label>
                    <select id="cw-ev-type">
                        <option value="event"${type === 'event' ? ' selected' : ''}>Event</option>
                        <option value="todo"${type === 'todo' ? ' selected' : ''}>Task</option>
                        <option value="break"${type === 'break' ? ' selected' : ''}>Break</option>
                    </select>
                </div>
                <label class="add-to-todo-row">
                    <input type="checkbox" id="cw-ev-add-todo">
                    Also add to To-Do list
                </label>
                <div class="cw-modal-actions">
                    ${existing ? '<button class="btn btn-ghost btn-small cw-delete" id="cw-ev-delete">Delete</button>' : ''}
                    <button class="btn btn-ghost btn-small" id="cw-ev-cancel">Cancel</button>
                    <button class="btn btn-primary btn-small" id="cw-ev-save">Save</button>
                </div>
            </div>`;
        document.body.appendChild(modal);

        const titleInput = modal.querySelector('#cw-ev-title');
        const startInput = modal.querySelector('#cw-ev-start');
        const endInput = modal.querySelector('#cw-ev-end');
        const typeInput = modal.querySelector('#cw-ev-type');
        const addTodoCheck = modal.querySelector('#cw-ev-add-todo');

        // Typeahead: suggest priorities + active to-dos by word overlap, and
        // infer the type when a suggestion is picked (keep the UI uncluttered —
        // suggestions only appear while typing).
        let suggestCtl = null;
        if (window.taskSuggest && typeof window.taskSuggest.attach === 'function') {
            suggestCtl = window.taskSuggest.attach({
                input: titleInput,
                onPick: (item) => {
                    if (item.type === 'break') typeInput.value = 'break';
                    else if (typeInput.value === 'break') typeInput.value = 'todo';
                }
            });
        }

        setTimeout(() => titleInput.focus(), 0);

        function close() {
            if (suggestCtl) suggestCtl.destroy();
            modal.remove();
        }

        function save() {
            const t = titleInput.value.trim();
            let s = fromHHMM(startInput.value);
            let en = fromHHMM(endInput.value);
            if (!t) { titleInput.focus(); return; }
            if (s == null || en == null) return;
            if (en <= s) en = s + SLOT_MINUTES;

            const chosenType = typeInput.value;

            if (existing) {
                updateEvent(key, id, { task: t, start: s, end: en, type: chosenType });
            } else {
                addEvent(key, { id: newId(), task: t, start: s, end: en, type: chosenType });
            }

            // Optionally mirror the item onto the To-Do list.
            if (addTodoCheck && addTodoCheck.checked) {
                addToTodoList(t, chosenType);
            }

            close();
            render();
        }

        modal.querySelector('#cw-ev-save').addEventListener('click', save);
        modal.querySelector('#cw-ev-cancel').addEventListener('click', close);
        const delBtn = modal.querySelector('#cw-ev-delete');
        if (delBtn) {
            delBtn.addEventListener('click', () => {
                deleteEvent(key, id);
                close();
                render();
            });
        }

        titleInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') save();
        });
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close();
        });
    }

    // Read-only mirror events (from Scheduler / History) can't be edited here.
    function openReadonlyNote(evEl) {
        const key = evEl.dataset.key;
        const isToday = key === dateKey(new Date());
        const where = isToday ? 'the Scheduler page' : 'History (archived)';
        const modal = document.createElement('div');
        modal.className = 'cw-modal';
        modal.innerHTML = `
            <div class="cw-modal-content">
                <h3>${evEl.querySelector('.cw-event-title').textContent.trim()}</h3>
                <p class="cw-hint" style="margin-bottom:0.8rem">This block comes from ${where} and is shown here for context. Edit it on ${isToday ? 'the Scheduler page' : 'the day it happened'}.</p>
                <div class="cw-modal-actions">
                    <button class="btn btn-primary btn-small" id="cw-ro-ok">Got it</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.querySelector('#cw-ro-ok').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    }

    // ----- Navigation & view controls -----
    function step(dir) {
        if (view === 'day') {
            anchor = addDays(anchor, dir);
        } else {
            anchor = addDays(anchor, dir * 7);
        }
        render();
    }

    function goToday() {
        anchor = new Date();
        anchor.setHours(0, 0, 0, 0);
        render();
        scrollToNow();
    }

    function setView(v) {
        view = v;
        saveData('calendarView', view);
        document.querySelectorAll('#cw-view-toggle .cw-view-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.view === v);
        });
        render();
        scrollToNow();
    }

    function scrollToNow() {
        const scroller = root.querySelector('.cw-scroll');
        if (!scroller) return;
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const clamped = Math.max(START_HOUR * 60, Math.min(nowMin, END_HOUR * 60));
        const target = minutesToTop(clamped) - scroller.clientHeight / 2;
        scroller.scrollTop = Math.max(0, target);
    }

    // Toolbar wiring
    const btnPrev = document.getElementById('cw-prev');
    const btnNext = document.getElementById('cw-next');
    const btnToday = document.getElementById('cw-today');
    const btnAdd = document.getElementById('cw-add-event');
    const viewToggle = document.getElementById('cw-view-toggle');

    if (btnPrev) btnPrev.addEventListener('click', () => step(-1));
    if (btnNext) btnNext.addEventListener('click', () => step(1));
    if (btnToday) btnToday.addEventListener('click', goToday);
    if (btnAdd) btnAdd.addEventListener('click', () => {
        // Default new event to today (or the first day in view) at 9 AM
        const days = periodDays();
        const now = new Date();
        const target = days.find(d => isSameDay(d, now)) || days[0];
        openEditor(dateKey(target), null, 9 * 60, 10 * 60);
    });
    if (viewToggle) {
        viewToggle.querySelectorAll('.cw-view-btn').forEach(btn => {
            btn.addEventListener('click', () => setView(btn.dataset.view));
        });
    }

    // Keep the now-line moving with the clock. Runs every 30s regardless of
    // whether this is the in-app page or the standalone calendar window — the
    // update is cheap and no-ops when today isn't in the current view.
    setInterval(updateNowLine, 30000);

    // Expose a hook so navigation (app.js) can refresh + scroll on open
    window.onCalendarPageShown = function () {
        render();
        scrollToNow();
    };

    // Initial paint (in case the page is shown first)
    setView(view);
})();
