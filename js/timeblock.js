// ===== My 5 Main Priorities =====
const prioritiesList = document.getElementById('priorities-list');
const priorityInput = document.getElementById('priority-input');
const btnAddPriority = document.getElementById('btn-add-priority');
const prioritiesInputGroup = document.getElementById('priorities-input-group');

let priorities = loadData('priorities', []);
let selectedPriorityIndex = null;
let priorityDragIndex = null;

function renderPriorities() {
    prioritiesList.innerHTML = priorities.map((p, i) => `
        <li class="priority-item${selectedPriorityIndex === i ? ' selected' : ''}" draggable="true" data-index="${i}">
            <span class="priority-number">${i + 1}</span>
            <span class="priority-text" data-index="${i}">${escapeHtml(p.text)}</span>
            <button class="btn-edit-priority" data-index="${i}" title="Edit">&#9998;</button>
            <button class="btn-remove-priority" data-index="${i}" title="Delete">&times;</button>
        </li>
    `).join('');

    if (priorities.length >= 5) {
        prioritiesInputGroup.style.display = 'none';
    } else {
        prioritiesInputGroup.style.display = 'flex';
    }

    prioritiesList.querySelectorAll('.priority-item').forEach(item => {
        const idx = parseInt(item.dataset.index);

        item.addEventListener('click', (e) => {
            if (e.target.closest('.btn-edit-priority') || e.target.closest('.btn-remove-priority')) return;
            selectedPriorityIndex = (selectedPriorityIndex === idx) ? null : idx;
            renderPriorities();
        });

        item.addEventListener('dragstart', () => {
            priorityDragIndex = idx;
            item.classList.add('dragging');
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            priorityDragIndex = null;
        });
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            item.classList.add('drag-over');
        });
        item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over');
        });
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('drag-over');
            if (priorityDragIndex === null || priorityDragIndex === idx) return;
            reorderPriorities(priorityDragIndex, idx);
        });
    });

    prioritiesList.querySelectorAll('.btn-remove-priority').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            priorities.splice(parseInt(btn.dataset.index), 1);
            selectedPriorityIndex = null;
            saveData('priorities', priorities);
            renderPriorities();
        });
    });

    prioritiesList.querySelectorAll('.btn-edit-priority').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            startEditPriority(parseInt(btn.dataset.index));
        });
    });
}

function reorderPriorities(from, to) {
    const [moved] = priorities.splice(from, 1);
    priorities.splice(to, 0, moved);
    selectedPriorityIndex = null;
    saveData('priorities', priorities);
    renderPriorities();
}

function startEditPriority(index) {
    const li = prioritiesList.querySelectorAll('.priority-item')[index];
    if (!li) return;
    li.setAttribute('draggable', 'false');
    const textSpan = li.querySelector('.priority-text');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'edit-input';
    input.value = priorities[index].text;
    textSpan.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
        const newText = input.value.trim();
        if (newText) {
            priorities[index].text = newText;
            saveData('priorities', priorities);
        }
        selectedPriorityIndex = null;
        renderPriorities();
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { commit(); }
        else if (e.key === 'Escape') { selectedPriorityIndex = null; renderPriorities(); }
    });
    input.addEventListener('blur', commit);
}

btnAddPriority.addEventListener('click', addPriority);
priorityInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addPriority();
});

function addPriority() {
    const text = priorityInput.value.trim();
    if (!text || priorities.length >= 5) return;
    priorities.push({ text, createdAt: new Date().toISOString() });
    saveData('priorities', priorities);
    renderPriorities();
    priorityInput.value = '';
}

renderPriorities();

// ===== To-Do List =====
const todoInput = document.getElementById('todo-input');
const todoPriority = document.getElementById('todo-priority');
const btnAddTodo = document.getElementById('btn-add-todo');
const btnAddBreak = document.getElementById('btn-add-break');
const todoList = document.getElementById('todo-list');
const completedSection = document.getElementById('completed-section');
const completedToggle = document.getElementById('completed-toggle');
const completedToggleLabel = document.getElementById('completed-toggle-label');
const completedList = document.getElementById('completed-list');

let todos = loadData('todos', []);
let selectedTodoIndex = null;
let completedExpanded = false;

// Collapsible toggle for completed tasks
if (completedToggle) {
    completedToggle.addEventListener('click', () => {
        completedExpanded = !completedExpanded;
        completedToggle.setAttribute('aria-expanded', String(completedExpanded));
        completedToggle.classList.toggle('open', completedExpanded);
        completedList.style.display = completedExpanded ? 'block' : 'none';
    });
}

function renderTodos() {
    // Split into active and completed, remembering each task's real index in `todos`
    const active = [];
    const completed = [];
    todos.forEach((t, i) => {
        if (t.completed) completed.push({ t, i });
        else active.push({ t, i });
    });

    // ----- Active tasks -----
    todoList.innerHTML = active.map(({ t, i }) => {
        const isBreak = t.type === 'break';
        return `
        <li class="todo-item${selectedTodoIndex === i ? ' selected' : ''}${isBreak ? ' is-break' : ''}" draggable="true" data-index="${i}">
            <input type="checkbox" class="todo-check" data-index="${i}" title="Mark complete">
            ${isBreak ? '<span class="break-icon">&#9749;</span>' : ''}
            <span class="todo-text" data-index="${i}">${escapeHtml(t.text)}</span>
            <span class="todo-priority ${isBreak ? 'break' : t.priority}">${isBreak ? 'break' : t.priority}</span>
            <button class="btn-edit-todo" data-index="${i}" title="Edit">&#9998;</button>
        </li>`;
    }).join('');

    todoList.querySelectorAll('.todo-item').forEach(item => {
        const idx = parseInt(item.dataset.index);

        item.addEventListener('click', (e) => {
            if (e.target.closest('.btn-edit-todo') || e.target.closest('.todo-check')) return;
            selectedTodoIndex = (selectedTodoIndex === idx) ? null : idx;
            renderTodos();
        });

        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', todos[idx].text);
            e.dataTransfer.setData('application/x-task-type', todos[idx].type || 'todo');
            item.classList.add('dragging');
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
        });
    });

    // Checkbox -> mark complete (saves)
    todoList.querySelectorAll('.todo-check').forEach(cb => {
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
            const idx = parseInt(cb.dataset.index);
            todos[idx].completed = true;
            todos[idx].completedAt = new Date().toISOString();
            selectedTodoIndex = null;
            saveData('todos', todos);
            renderTodos();
        });
    });

    todoList.querySelectorAll('.btn-edit-todo').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            startEditTodo(parseInt(btn.dataset.index));
        });
    });

    // ----- Completed archive -----
    renderCompleted(completed);
}

function renderCompleted(completed) {
    if (!completedSection) return;

    if (completed.length === 0) {
        completedSection.style.display = 'none';
        completedList.innerHTML = '';
        return;
    }

    completedSection.style.display = 'block';
    completedToggleLabel.textContent = `Completed (${completed.length})`;

    // Newest completed first
    const ordered = completed.slice().reverse();
    completedList.innerHTML = ordered.map(({ t, i }) => {
        const isBreak = t.type === 'break';
        return `
        <li class="completed-item" data-index="${i}">
            <input type="checkbox" class="todo-check" data-index="${i}" checked title="Mark not done">
            <span class="completed-text">${isBreak ? '&#9749; ' : ''}${escapeHtml(t.text)}</span>
            <button class="btn-remove-completed" data-index="${i}" title="Delete">&times;</button>
        </li>`;
    }).join('');

    // Uncheck -> move back to active (saves)
    completedList.querySelectorAll('.todo-check').forEach(cb => {
        cb.addEventListener('change', () => {
            const idx = parseInt(cb.dataset.index);
            todos[idx].completed = false;
            delete todos[idx].completedAt;
            saveData('todos', todos);
            renderTodos();
        });
    });

    // Delete a completed task permanently
    completedList.querySelectorAll('.btn-remove-completed').forEach(btn => {
        btn.addEventListener('click', () => {
            todos.splice(parseInt(btn.dataset.index), 1);
            saveData('todos', todos);
            renderTodos();
        });
    });

    // Keep expanded/collapsed state consistent
    completedList.style.display = completedExpanded ? 'block' : 'none';
    completedToggle.classList.toggle('open', completedExpanded);
}

function startEditTodo(index) {
    const li = todoList.querySelectorAll('.todo-item')[index];
    if (!li) return;
    li.setAttribute('draggable', 'false');
    const textSpan = li.querySelector('.todo-text');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'edit-input';
    input.value = todos[index].text;
    textSpan.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
        const newText = input.value.trim();
        if (newText) {
            todos[index].text = newText;
            saveData('todos', todos);
        }
        selectedTodoIndex = null;
        renderTodos();
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { commit(); }
        else if (e.key === 'Escape') { selectedTodoIndex = null; renderTodos(); }
    });
    input.addEventListener('blur', commit);
}

btnAddTodo.addEventListener('click', addTodo);
todoInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addTodo();
});

function addTodo() {
    const text = todoInput.value.trim();
    if (!text) return;
    todos.push({ text, priority: todoPriority.value, type: 'todo', completed: false });
    saveData('todos', todos);
    renderTodos();
    todoInput.value = '';
}

// Add an item to the To-Do list from the scheduler/calendar "Also add to To-Do
// list" checkbox. Skips duplicates of an existing active to-do. `type` 'break'
// creates a break task; anything else a normal task.
function addToTodoList(text, type) {
    const t = (text || '').trim();
    if (!t) return;
    const exists = todos.some(x => x && !x.completed && (x.text || '').trim().toLowerCase() === t.toLowerCase());
    if (exists) return;
    todos.push({
        text: t,
        priority: 'normal',
        type: type === 'break' ? 'break' : 'todo',
        completed: false
    });
    saveData('todos', todos);
    renderTodos();
}

// ===== Shared break types =====
// The list of break kinds is shared between the To-Do "Break" menu and the
// calendar's assign modal, and is persisted so user-added kinds survive reloads.
const DEFAULT_BREAK_TYPES = [
    'Squat break',
    'Humming break',
    'No-phone break',
    'Stare out the window break',
    'Music break'
];
let breakTypes = loadData('breakTypes', null);
if (!Array.isArray(breakTypes) || breakTypes.length === 0) {
    breakTypes = DEFAULT_BREAK_TYPES.slice();
    saveData('breakTypes', breakTypes);
}

// Add a new break kind (from a user prompt). Returns the trimmed name if added,
// or null if empty/duplicate. Re-renders any open break menus on success.
function addBreakType(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return null;
    const exists = breakTypes.some(b => b.toLowerCase() === trimmed.toLowerCase());
    if (!exists) {
        breakTypes.push(trimmed);
        saveData('breakTypes', breakTypes);
    }
    renderBreakMenu();
    return trimmed;
}

// Prompt the user for a new break kind, add it, and return the added name.
function promptNewBreakType() {
    const name = window.prompt('Name your new break type:');
    return addBreakType(name);
}

// "Break" is a collapsible menu of break types. Clicking the header toggles the
// list of options; picking an option adds it to the to-do list as a break task.
const breakOptions = document.getElementById('break-options');
let breakMenuExpanded = false;

function setBreakMenuExpanded(expanded) {
    breakMenuExpanded = expanded;
    btnAddBreak.setAttribute('aria-expanded', String(expanded));
    breakOptions.style.display = expanded ? 'block' : 'none';
}

// (Re)build the to-do Break menu from the shared break-types list, plus a
// trailing "add new break type" action.
function renderBreakMenu() {
    if (!breakOptions) return;
    breakOptions.innerHTML = breakTypes.map(b => `
        <li><button class="break-option" data-break="${escapeHtml(b)}">${escapeHtml(b)}</button></li>
    `).join('') + `
        <li><button class="break-option break-option-add" data-action="add-break-type">&#43; Add new break type</button></li>`;

    breakOptions.querySelectorAll('.break-option').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.action === 'add-break-type') {
                const added = promptNewBreakType();
                if (added) {
                    todos.push({ text: added, priority: 'normal', type: 'break', completed: false });
                    saveData('todos', todos);
                    renderTodos();
                    setBreakMenuExpanded(false);
                }
                return;
            }
            todos.push({ text: btn.dataset.break, priority: 'normal', type: 'break', completed: false });
            saveData('todos', todos);
            renderTodos();
            setBreakMenuExpanded(false);
        });
    });
}

btnAddBreak.addEventListener('click', () => {
    setBreakMenuExpanded(!breakMenuExpanded);
});

renderBreakMenu();

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

renderTodos();

// ===== Flexible Time Block Calendar (Teams-style) =====
const timeblockCalendar = document.getElementById('timeblock-calendar');

// Config
const CAL_START_HOUR = 6;   // 6 AM
const CAL_END_HOUR = 23;    // 11 PM
const SLOT_MINUTES = 5;     // 5-minute granularity (drag-select + resize snapping)
const SLOT_HEIGHT = 7;      // px per 5-min slot (keeps the same overall scale)

// blocks: array of { id, start: minutesFromMidnight, end: minutesFromMidnight, task: string, type: 'todo'|'break' }
let blocks = loadData('timeblocksV2', []);

// Migrate old hourly timeblocks if present (one-time). Previously this ran on
// every launch with an empty calendar, so a leftover legacy `timeblocks` key
// kept re-seeding phantom blocks after Clear All or on a new day. We now remove
// the legacy key after migrating so it can only ever happen once.
const oldTimeblocks = loadData('timeblocks', null);
if (oldTimeblocks) {
    if (blocks.length === 0) {
        Object.keys(oldTimeblocks).forEach(key => {
            const hour = parseInt(key.replace('hour_', ''));
            if (!isNaN(hour)) {
                blocks.push({ start: hour * 60, end: (hour + 1) * 60, task: oldTimeblocks[key], type: 'todo' });
            }
        });
        if (blocks.length > 0) saveData('timeblocksV2', blocks);
    }
    // Drop the legacy key regardless, so it never re-seeds the calendar again.
    removeData('timeblocks');
}

// Ensure every block has a stable unique id
let _blockIdCounter = Date.now();
function newBlockId() {
    return 'blk_' + (_blockIdCounter++);
}
let _blocksChanged = false;
blocks.forEach(b => {
    if (!b.id) { b.id = newBlockId(); _blocksChanged = true; }
});
if (_blocksChanged) saveData('timeblocksV2', blocks);

// Calendar interaction/selection state (declared early so functions defined
// below — including the midnight reset that runs on load — can safely use them)
let dragSelecting = false;
let dragStartSlot = null;
let dragEndSlot = null;
let selectedBlockId = null; // which calendar block is selected (by id)

// ===== Midnight Calendar Reset =====
// Clear all time blocks at 12:00 AM each day
// Convert a Date to the YYYY-MM-DD key used by the history calendar
function toDateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// Archive the current blocks into history under the given date key, then clear.
function archiveAndClear(dateKeyForArchive) {
    if (blocks.length > 0 && typeof window.saveScheduleForDay === 'function') {
        window.saveScheduleForDay(blocks, dateKeyForArchive);
    }
    blocks = [];
    selectedBlockId = null;
    dragSelecting = false;
    dragStartSlot = null;
    dragEndSlot = null;
    saveData('timeblocksV2', blocks);
}

(function initCalendarMidnightReset() {
    const lastClear = loadData('lastCalendarClearDate', null);
    const todayStr = new Date().toDateString();

    // If the app opens on a new day, archive leftover blocks under the day they
    // belonged to (the last day the calendar was active), then clear.
    if (lastClear !== todayStr) {
        if (blocks.length > 0) {
            const archiveKey = lastClear ? toDateKey(new Date(lastClear)) : toDateKey(new Date());
            archiveAndClear(archiveKey);
        }
        saveData('lastCalendarClearDate', todayStr);
    }

    scheduleCalendarMidnightClear();
})();

function clearCalendarForNewDay() {
    // The blocks belong to the day that just ended (yesterday relative to now)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    archiveAndClear(toDateKey(yesterday));

    saveData('lastCalendarClearDate', new Date().toDateString());
    if (typeof renderTimeBlockCalendar === 'function') {
        renderTimeBlockCalendar();
    }
}

function scheduleCalendarMidnightClear() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0); // next midnight
    const msUntilMidnight = midnight.getTime() - now.getTime();

    setTimeout(() => {
        clearCalendarForNewDay();
        scheduleCalendarMidnightClear(); // reschedule for the following midnight
    }, msUntilMidnight);
}

const totalSlots = ((CAL_END_HOUR - CAL_START_HOUR) * 60) / SLOT_MINUTES;

// Event delegation for block edit/remove clicks (survives re-renders)

function removeBlockById(id) {
    if (id === undefined || id === null) return;
    // Remove ALL blocks matching this id (guards against any duplicate ids)
    const before = blocks.length;
    blocks = blocks.filter(b => String(b.id) !== String(id));
    if (blocks.length !== before) {
        selectedBlockId = null;
        saveData('timeblocksV2', blocks);
        renderTimeBlockCalendar();
    }
}

// Clear all time blocks from the calendar
const btnClearBlocks = document.getElementById('btn-clear-blocks');
if (btnClearBlocks) {
    btnClearBlocks.addEventListener('click', () => {
        if (blocks.length === 0) return;
        if (!confirm('Clear all tasks from the calendar? This cannot be undone.')) return;
        blocks = [];
        selectedBlockId = null;
        // Reset any lingering drag/selection state so adding works right after
        dragSelecting = false;
        dragStartSlot = null;
        dragEndSlot = null;
        saveData('timeblocksV2', blocks);
        renderTimeBlockCalendar();
    });
}

// A single click selects a scheduler block; a double click opens the editor.
// We debounce the single-click's re-render so a quick second click can cancel
// it (otherwise the first click would re-render and swallow the dblclick).
let _blockClickTimer = null;

// Double-click a block (scheduler OR calendar) to open the editor.
timeblockCalendar.addEventListener('dblclick', (e) => {
    const blockEl = e.target.closest('.cal-block');
    if (!blockEl) return;
    e.preventDefault();
    e.stopPropagation();
    if (_blockClickTimer) { clearTimeout(_blockClickTimer); _blockClickTimer = null; }
    if (blockEl.classList.contains('calendar-block')) {
        startEditCalendarBlock(blockEl.dataset.calKey, blockEl.dataset.calId);
    } else {
        startEditBlock(blockEl.dataset.blockId);
    }
});

timeblockCalendar.addEventListener('click', (e) => {
    // Ignore clicks that originate on a resize handle (they belong to a resize gesture)
    if (e.target.closest('.cal-block-resize')) {
        e.stopPropagation();
        return;
    }

    // Single click on a scheduler block body selects it (shows the resize
    // affordance/outline). Editing happens on double-click, so defer the
    // selection re-render briefly and let a dblclick cancel it.
    const blockEl = e.target.closest('.cal-block');
    if (blockEl && !blockEl.classList.contains('calendar-block')) {
        e.stopPropagation();
        const id = blockEl.dataset.blockId;
        if (_blockClickTimer) clearTimeout(_blockClickTimer);
        _blockClickTimer = setTimeout(() => {
            _blockClickTimer = null;
            selectedBlockId = (selectedBlockId === id) ? null : id;
            renderTimeBlockCalendar();
        }, 220);
    }
});

// Right-click a block to open a context menu with Edit / Remove
timeblockCalendar.addEventListener('contextmenu', (e) => {
    const blockEl = e.target.closest('.cal-block');
    if (!blockEl) return;
    // Read-only calendar mirrors have no context menu (can't edit/remove here).
    if (blockEl.classList.contains('calendar-block')) return;
    e.preventDefault();
    e.stopPropagation();
    openBlockContextMenu(blockEl.dataset.blockId, e.clientX, e.clientY);
});

function openBlockContextMenu(id, x, y) {
    // Remove any existing menu
    closeBlockContextMenu();

    const menu = document.createElement('div');
    menu.className = 'block-context-menu';
    menu.id = 'block-context-menu';
    menu.innerHTML = `
        <button class="ctx-item" data-action="edit">&#9998; Edit</button>
        <button class="ctx-item ctx-danger" data-action="remove">&times; Remove</button>
    `;
    document.body.appendChild(menu);

    // Position, keeping it on-screen
    const menuW = menu.offsetWidth;
    const menuH = menu.offsetHeight;
    const px = Math.min(x, window.innerWidth - menuW - 8);
    const py = Math.min(y, window.innerHeight - menuH - 8);
    menu.style.left = px + 'px';
    menu.style.top = py + 'px';

    menu.querySelector('[data-action="edit"]').addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeBlockContextMenu();
        selectedBlockId = id;
        renderTimeBlockCalendar();
        // Defer so the current mouse gesture finishes before we focus the input,
        // otherwise the trailing mouseup steals focus and blur-commits immediately.
        setTimeout(() => startEditBlock(id), 0);
    });

    menu.querySelector('[data-action="remove"]').addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeBlockContextMenu();
        removeBlockById(id);
    });

    // Dismiss on any outside click / scroll / escape (deferred so this open gesture doesn't close it)
    setTimeout(() => {
        document.addEventListener('mousedown', outsideMenuHandler);
        document.addEventListener('contextmenu', outsideMenuHandler);
        window.addEventListener('scroll', closeBlockContextMenu, true);
        document.addEventListener('keydown', escMenuHandler);
    }, 0);
}

function outsideMenuHandler(e) {
    const menu = document.getElementById('block-context-menu');
    if (menu && !menu.contains(e.target)) {
        closeBlockContextMenu();
    }
}

function escMenuHandler(e) {
    if (e.key === 'Escape') closeBlockContextMenu();
}

function closeBlockContextMenu() {
    const menu = document.getElementById('block-context-menu');
    if (menu) menu.remove();
    document.removeEventListener('mousedown', outsideMenuHandler);
    document.removeEventListener('contextmenu', outsideMenuHandler);
    window.removeEventListener('scroll', closeBlockContextMenu, true);
    document.removeEventListener('keydown', escMenuHandler);
}

function slotToMinutes(slot) {
    return CAL_START_HOUR * 60 + slot * SLOT_MINUTES;
}

function formatMinutes(mins) {
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    let dh = h % 12;
    if (dh === 0) dh = 12;
    return `${dh}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Today's key in YYYY-MM-DD form (matches the full Calendar's keys)
function todayCalendarKey() {
    return toDateKey(new Date());
}

// Read the events the user created for TODAY on the full Calendar page. These
// are mirrored (read-only) onto the scheduler so a task/event scheduled for
// today shows up here as a time block. Shape: {id,start,end,task,type}.
function getTodayCalendarEvents() {
    const store = loadData('calendarEvents', {}) || {};
    const arr = store[todayCalendarKey()] || [];
    return arr
        .filter(e => typeof e.start === 'number' && typeof e.end === 'number' && e.end > e.start)
        .map(e => ({
            id: 'cal_' + e.id,
            start: e.start,
            end: e.end,
            task: e.task,
            type: e.type || 'event',   // 'event' | 'todo' | 'break'
            source: 'calendar',        // marks it read-only here
            readOnly: true
        }));
}

// Build the combined, positioned list of items to draw: the scheduler's own
// blocks (editable) plus today's calendar events (read-only mirror). Each item
// gets _col / _cols for side-by-side placement and _overlap when it shares time
// with any other item, so overlaps can be visually distinguished.
function computeCalendarLayout() {
    const own = blocks.map(b => ({
        id: b.id,
        start: b.start,
        end: b.end,
        task: b.task,
        type: b.type || 'todo',
        source: 'scheduler',
        readOnly: false,
        _ref: b
    }));
    const cal = getTodayCalendarEvents();

    const items = own.concat(cal).sort((a, b) => a.start - b.start || a.end - b.end);

    // Cluster mutually-overlapping items, then assign greedy columns within each
    // cluster (Teams-style). Mark every item that overlaps another.
    let i = 0;
    while (i < items.length) {
        let clusterEnd = items[i].end;
        const cluster = [items[i]];
        let j = i + 1;
        while (j < items.length && items[j].start < clusterEnd) {
            cluster.push(items[j]);
            clusterEnd = Math.max(clusterEnd, items[j].end);
            j++;
        }

        const cols = []; // end time of the last event placed in each column
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
        cluster.forEach(ev => {
            ev._cols = colCount;
            ev._overlap = cluster.length > 1; // more than one item sharing this span
        });
        i = j;
    }

    return items;
}

function renderTimeBlockCalendar() {
    timeblockCalendar.innerHTML = '';

    // Build the grid column
    const grid = document.createElement('div');
    grid.className = 'cal-grid';

    // Hour labels + slot cells
    for (let slot = 0; slot < totalSlots; slot++) {
        const mins = slotToMinutes(slot);
        const isHourStart = mins % 60 === 0;

        const row = document.createElement('div');
        row.className = 'cal-slot' + (isHourStart ? ' hour-start' : '');
        row.dataset.slot = slot;
        row.style.height = SLOT_HEIGHT + 'px';

        if (isHourStart) {
            const label = document.createElement('span');
            label.className = 'cal-hour-label';
            label.textContent = formatMinutes(mins).replace(':00', '');
            row.appendChild(label);
        }

        grid.appendChild(row);
    }

    timeblockCalendar.appendChild(grid);

    // Attach drag-select on the grid (delegated, robust against re-renders)
    attachGridSelection(grid);

    // Render scheduler blocks + today's calendar events, positioned so overlaps
    // sit side by side and are visually distinguished.
    const laidOut = computeCalendarLayout();
    laidOut.forEach((item) => {
        renderBlock(item, grid);
    });

    // Current-time indicator line
    const nowLine = document.createElement('div');
    nowLine.className = 'cal-now-line';
    nowLine.id = 'cal-now-line';
    nowLine.innerHTML = '<span class="cal-now-dot"></span><span class="cal-now-label"></span>';
    grid.appendChild(nowLine);
    updateNowLine();

    // Keep the mini timer overlay's "current task" label in sync with any
    // scheduler/calendar change made in THIS window (storage events only fire
    // in other windows).
    if (typeof window.syncMiniTask === 'function') {
        window.syncMiniTask();
    }
}

// Position the "current time" indicator; hides it if outside the calendar range
function updateNowLine() {
    const nowLine = document.getElementById('cal-now-line');
    if (!nowLine) return;

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const startMin = CAL_START_HOUR * 60;
    const endMin = CAL_END_HOUR * 60;

    if (nowMin < startMin || nowMin > endMin) {
        nowLine.style.display = 'none';
        return;
    }

    nowLine.style.display = 'block';
    const top = ((nowMin - startMin) / SLOT_MINUTES) * SLOT_HEIGHT;
    nowLine.style.top = top + 'px';

    const label = nowLine.querySelector('.cal-now-label');
    if (label) label.textContent = formatMinutes(now.getHours() * 60 + now.getMinutes());
}

// Keep the current-time line updated every 30 seconds
setInterval(updateNowLine, 30000);

// Robust drag-to-select using pointer position over the grid
function attachGridSelection(grid) {
    function slotFromEvent(e) {
        // Find which slot the pointer is over
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const slotEl = el && el.closest ? el.closest('.cal-slot') : null;
        if (slotEl) return parseInt(slotEl.dataset.slot);
        return null;
    }

    grid.addEventListener('mousedown', (e) => {
        // Ignore if pressing on an existing block
        if (e.target.closest('.cal-block')) return;
        const slot = slotFromEvent(e);
        if (slot === null) return;
        dragSelecting = true;
        dragStartSlot = slot;
        dragEndSlot = slot;
        updateSelectionHighlight();
        e.preventDefault();
    });

    grid.addEventListener('mousemove', (e) => {
        if (!dragSelecting) return;
        const slot = slotFromEvent(e);
        if (slot === null) return;
        dragEndSlot = slot;
        updateSelectionHighlight();
    });
}

// Human label for a block/event type shown as a small badge.
function typeLabel(type) {
    if (type === 'break') return 'Break';
    if (type === 'event') return 'Event';
    return 'Task';
}

// `item` is a positioned entry from computeCalendarLayout():
//   { id, start, end, task, type, source, readOnly, _col, _cols, _overlap, _ref }
// source 'scheduler' items are editable/resizable; source 'calendar' items are
// read-only mirrors of today's full-Calendar events.
function renderBlock(item, grid) {
    const startSlot = (item.start - CAL_START_HOUR * 60) / SLOT_MINUTES;
    const endSlot = (item.end - CAL_START_HOUR * 60) / SLOT_MINUTES;
    const top = startSlot * SLOT_HEIGHT;
    const height = (endSlot - startSlot) * SLOT_HEIGHT;

    const isCalendar = item.source === 'calendar';
    const isBreak = item.type === 'break';
    const isEvent = item.type === 'event';

    // Guarantee scheduler blocks have an id so they can always be removed
    if (!isCalendar && !item.id && item._ref) {
        item._ref.id = newBlockId();
        item.id = item._ref.id;
        saveData('timeblocksV2', blocks);
    }

    const colCount = item._cols || 1;
    const col = item._col || 0;
    const widthPct = 100 / colCount;
    const leftPct = widthPct * col;

    const el = document.createElement('div');
    el.className = 'cal-block'
        + (isBreak ? ' break-block' : '')
        + (isEvent ? ' event-block' : '')
        + (isCalendar ? ' calendar-block' : '')
        + (item._overlap ? ' overlapping' : '')
        + ((!isCalendar && selectedBlockId === item.id) ? ' selected' : '');

    el.style.top = top + 'px';
    el.style.height = (height - 2) + 'px';
    // Horizontal placement: full width when alone, side-by-side when overlapping.
    // Uses a small gutter (from CSS left var) plus a right inset per column.
    el.style.left = `calc(54px + (100% - 58px) * ${leftPct / 100})`;
    el.style.width = `calc((100% - 58px) * ${widthPct / 100} - 2px)`;
    el.dataset.blockId = item.id;

    const badge = `<span class="cal-block-type type-${isBreak ? 'break' : (isEvent ? 'event' : 'todo')}">${typeLabel(item.type)}</span>`;
    const icon = isBreak ? '&#9749; ' : '';

    // Editing is via double-click (opens the modal). No inline edit/delete
    // buttons on the block itself, for a cleaner look.
    el.title = 'Double-click to edit';

    if (isCalendar) {
        // Mirror of a full-Calendar event scheduled for today. It's now editable
        // here too (double-click), with changes written back to the Calendar.
        // The real calendar id (without our 'cal_' prefix) + today's key let the
        // editor persist to focusflow_calendarEvents.
        el.dataset.calId = String(item.id).replace(/^cal_/, '');
        el.dataset.calKey = todayCalendarKey();
        el.innerHTML = `
            <div class="cal-block-inner">
                <div class="cal-block-head">
                    ${badge}
                    <span class="cal-block-source" title="Scheduled on the Calendar for today">&#128197;</span>
                </div>
                <span class="cal-block-task">${icon}${escapeHtml(item.task)}</span>
                <span class="cal-block-time">${formatMinutes(item.start)} – ${formatMinutes(item.end)}</span>
            </div>`;
        // Don't let a press start a drag-select on the grid behind it.
        el.addEventListener('mousedown', (e) => e.stopPropagation());
        grid.appendChild(el);
        return;
    }

    el.innerHTML = `
        <div class="cal-block-resize cal-block-resize-top" data-edge="top" title="Drag to change start time"></div>
        <div class="cal-block-inner">
            <div class="cal-block-head">${badge}</div>
            <span class="cal-block-task">${icon}${escapeHtml(item.task)}</span>
            <span class="cal-block-time">${formatMinutes(item.start)} – ${formatMinutes(item.end)}</span>
        </div>
        <div class="cal-block-resize cal-block-resize-bottom" data-edge="bottom" title="Drag to change end time"></div>
    `;

    // Prevent starting a drag-select when pressing on a block
    el.addEventListener('mousedown', (e) => {
        e.stopPropagation();
    });

    // Teams-style resizing via the top/bottom edge handles
    el.querySelectorAll('.cal-block-resize').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            startBlockResize(item.id, handle.dataset.edge, e, el);
        });
    });

    grid.appendChild(el);
}

// ===== Teams-style block resizing =====
// Drag a block's top or bottom edge to change its start/end time. Snaps to the
// 5-minute slot grid and enforces a minimum one-slot duration.
let resizing = false;

function startBlockResize(id, edge, e, el) {
    const block = blocks.find(b => b.id === id);
    if (!block) return;

    resizing = true;
    selectedBlockId = id;

    const gridStartMin = CAL_START_HOUR * 60;
    const gridEndMin = CAL_END_HOUR * 60;
    const pxPerMinute = SLOT_HEIGHT / SLOT_MINUTES;

    const startY = e.clientY;
    const origStart = block.start;
    const origEnd = block.end;

    // Snap an arbitrary minute value to the nearest slot boundary
    const snap = (mins) => Math.round(mins / SLOT_MINUTES) * SLOT_MINUTES;

    document.body.classList.add('cal-resizing');
    el.classList.add('resizing');

    const timeLabel = el.querySelector('.cal-block-time');

    function onMove(ev) {
        const deltaMin = (ev.clientY - startY) / pxPerMinute;

        if (edge === 'top') {
            let newStart = snap(origStart + deltaMin);
            // Keep at least one slot of duration and stay within the grid
            newStart = Math.max(gridStartMin, Math.min(newStart, origEnd - SLOT_MINUTES));
            block.start = newStart;
        } else {
            let newEnd = snap(origEnd + deltaMin);
            newEnd = Math.min(gridEndMin, Math.max(newEnd, origStart + SLOT_MINUTES));
            block.end = newEnd;
        }

        // Live-update position/size + time label without a full re-render
        const startSlot = (block.start - gridStartMin) / SLOT_MINUTES;
        const endSlot = (block.end - gridStartMin) / SLOT_MINUTES;
        el.style.top = (startSlot * SLOT_HEIGHT) + 'px';
        el.style.height = ((endSlot - startSlot) * SLOT_HEIGHT - 2) + 'px';
        if (timeLabel) timeLabel.textContent = `${formatMinutes(block.start)} – ${formatMinutes(block.end)}`;
    }

    function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('cal-resizing');
        resizing = false;

        // Only persist + re-render if something actually changed
        if (block.start !== origStart || block.end !== origEnd) {
            blocks.sort((a, b) => a.start - b.start);
            saveData('timeblocksV2', blocks);
        }
        renderTimeBlockCalendar();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// Convert minutes-from-midnight to/from an <input type="time"> "HH:MM" value.
function minsToHHMM(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function hhmmToMins(str) {
    const [h, m] = String(str).split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
}

// Shared editor modal for a time block. Works for both scheduler blocks and
// mirrored Calendar events; the caller supplies the initial values, a heading,
// and onSave/onDelete callbacks that persist to the correct store.
//
// config: {
//   heading, task, start, end, type,
//   onSave({ task, start, end, type, addToTodo }),
//   onDelete()
// }
function openBlockEditor(config) {
    const gridStartMin = CAL_START_HOUR * 60;
    const gridEndMin = CAL_END_HOUR * 60;

    const modal = document.createElement('div');
    modal.className = 'assign-modal';
    modal.innerHTML = `
        <div class="assign-modal-content block-edit-modal">
            <h3>${escapeHtml(config.heading || 'Edit time block')}</h3>
            <div class="block-edit-field">
                <label for="block-edit-title">Title</label>
                <input type="text" id="block-edit-title" placeholder="What's happening?">
            </div>
            <div class="block-edit-row">
                <div class="block-edit-field">
                    <label for="block-edit-start">Start</label>
                    <input type="time" id="block-edit-start" step="60">
                </div>
                <div class="block-edit-field">
                    <label for="block-edit-end">End</label>
                    <input type="time" id="block-edit-end" step="60">
                </div>
            </div>
            <div class="block-edit-field">
                <label for="block-edit-type">Type</label>
                <select id="block-edit-type">
                    <option value="todo">Task</option>
                    <option value="event">Event</option>
                    <option value="break">Break</option>
                </select>
            </div>
            <label class="add-to-todo-row">
                <input type="checkbox" id="block-edit-add-todo">
                Also add to To-Do list
            </label>
            <p class="block-edit-error" id="block-edit-error" style="display:none;"></p>
            <div class="assign-modal-actions">
                <button class="btn btn-ghost btn-small block-edit-delete" id="block-edit-delete">Delete</button>
                <button class="btn btn-ghost btn-small" id="block-edit-cancel">Cancel</button>
                <button class="btn btn-primary btn-small" id="block-edit-save">Save</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    const titleInput = modal.querySelector('#block-edit-title');
    const startInput = modal.querySelector('#block-edit-start');
    const endInput = modal.querySelector('#block-edit-end');
    const typeInput = modal.querySelector('#block-edit-type');
    const addTodoCheck = modal.querySelector('#block-edit-add-todo');
    const errorEl = modal.querySelector('#block-edit-error');

    // Prefill
    titleInput.value = config.task || '';
    startInput.value = minsToHHMM(config.start);
    endInput.value = minsToHHMM(config.end);
    typeInput.value = config.type || 'todo';

    // Keep modal interactions from reaching the calendar's drag-select handlers
    modal.addEventListener('mousedown', (e) => e.stopPropagation());

    // Typeahead over priorities + active to-dos (word-overlap matching).
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

    setTimeout(() => { titleInput.focus(); titleInput.select(); }, 0);

    function showError(msg) {
        errorEl.textContent = msg;
        errorEl.style.display = 'block';
    }

    function finish() {
        if (suggestCtl) suggestCtl.destroy();
        modal.remove();
        selectedBlockId = null;
        renderTimeBlockCalendar();
    }

    function save() {
        const t = titleInput.value.trim();
        const s = hhmmToMins(startInput.value);
        const en = hhmmToMins(endInput.value);

        if (!t) { showError('Please enter a title.'); titleInput.focus(); return; }
        if (s == null || en == null) { showError('Please enter valid start and end times.'); return; }
        if (en <= s) { showError('End time must be after the start time.'); return; }
        if (s < gridStartMin || en > gridEndMin) {
            showError(`Times must be between ${formatMinutes(gridStartMin)} and ${formatMinutes(gridEndMin)}.`);
            return;
        }

        config.onSave({
            task: t,
            start: s,
            end: en,
            type: typeInput.value,
            addToTodo: !!(addTodoCheck && addTodoCheck.checked)
        });
        finish();
    }

    modal.querySelector('#block-edit-save').addEventListener('click', save);
    modal.querySelector('#block-edit-cancel').addEventListener('click', finish);
    modal.querySelector('#block-edit-delete').addEventListener('click', () => {
        if (suggestCtl) suggestCtl.destroy();
        modal.remove();
        if (typeof config.onDelete === 'function') config.onDelete();
        else renderTimeBlockCalendar();
    });

    titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
    });
    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(); }
    });

    // Backdrop-dismiss, but ignore the opening gesture's trailing click
    const openedAt = Date.now();
    modal.addEventListener('click', (e) => {
        if (e.target === modal && Date.now() - openedAt > 300) finish();
    });
}

// Edit a scheduler block (persists to timeblocksV2). Opened by double-click.
function startEditBlock(id) {
    const block = blocks.find(b => b.id === id);
    if (!block) return;

    openBlockEditor({
        heading: 'Edit time block',
        task: block.task,
        start: block.start,
        end: block.end,
        type: block.type || 'todo',
        onSave: ({ task, start, end, type, addToTodo }) => {
            block.task = task;
            block.start = start;
            block.end = end;
            block.type = type;
            blocks.sort((a, b) => a.start - b.start);
            saveData('timeblocksV2', blocks);
            if (addToTodo) addToTodoList(task, type);
        },
        onDelete: () => removeBlockById(id)
    });
}

// Edit a Calendar event that's mirrored onto today's scheduler. Persists back
// to focusflow_calendarEvents so the change shows on the Calendar too. Opened
// by double-click on a `.calendar-block`.
function startEditCalendarBlock(key, calId) {
    if (!key || !calId) return;
    const store = loadData('calendarEvents', {}) || {};
    const arr = store[key] || [];
    const ev = arr.find(e => String(e.id) === String(calId));
    if (!ev) return;

    openBlockEditor({
        heading: 'Edit calendar item',
        task: ev.task,
        start: ev.start,
        end: ev.end,
        type: ev.type || 'event',
        onSave: ({ task, start, end, type, addToTodo }) => {
            const s = loadData('calendarEvents', {}) || {};
            const list = s[key] || [];
            const idx = list.findIndex(e => String(e.id) === String(calId));
            if (idx !== -1) {
                list[idx] = { ...list[idx], task, start, end, type };
                list.sort((a, b) => a.start - b.start);
                s[key] = list;
                saveData('calendarEvents', s);
            }
            if (addToTodo) addToTodoList(task, type);
        },
        onDelete: () => {
            const s = loadData('calendarEvents', {}) || {};
            s[key] = (s[key] || []).filter(e => String(e.id) !== String(calId));
            saveData('calendarEvents', s);
            renderTimeBlockCalendar();
        }
    });
}

function updateSelectionHighlight() {
    const slots = timeblockCalendar.querySelectorAll('.cal-slot');
    const lo = Math.min(dragStartSlot, dragEndSlot);
    const hi = Math.max(dragStartSlot, dragEndSlot);
    slots.forEach(s => {
        const idx = parseInt(s.dataset.slot);
        s.classList.toggle('selecting', idx >= lo && idx <= hi);
    });
}

// End drag selection anywhere
document.addEventListener('mouseup', () => {
    if (!dragSelecting) return;
    dragSelecting = false;

    if (dragStartSlot === null || dragEndSlot === null) {
        dragStartSlot = null;
        dragEndSlot = null;
        return;
    }

    const lo = Math.min(dragStartSlot, dragEndSlot);
    const hi = Math.max(dragStartSlot, dragEndSlot) + 1; // inclusive end slot
    const startMin = slotToMinutes(lo);
    const endMin = slotToMinutes(hi);

    // Clear highlight
    timeblockCalendar.querySelectorAll('.cal-slot.selecting').forEach(s => s.classList.remove('selecting'));

    dragStartSlot = null;
    dragEndSlot = null;

    // Open assignment for the selected range
    openAssignModal(startMin, endMin);
});

function openAssignModal(startMin, endMin) {
    const allTasks = [
        ...priorities.map(p => ({ text: p.text, type: 'priority' })),
        ...todos.filter(t => !t.completed).map(t => ({ text: t.text, type: t.type || 'todo' }))
    ];

    const modal = document.createElement('div');
    modal.className = 'assign-modal';
    modal.innerHTML = `
        <div class="assign-modal-content">
            <h3>Assign to ${formatMinutes(startMin)} – ${formatMinutes(endMin)}</h3>
            ${allTasks.length === 0 ? '<p class="no-data">No tasks yet. Add some to your list first.</p>' : ''}
            ${allTasks.map(t => `
                <div class="task-option ${t.type === 'priority' ? 'is-priority' : ''} ${t.type === 'break' ? 'is-break-option' : ''}" data-task="${escapeHtml(t.text)}" data-type="${t.type}">
                    ${t.type === 'priority' ? '<span class="task-badge">Priority</span>' : ''}
                    ${t.type === 'break' ? '&#9749; ' : ''}${escapeHtml(t.text)}
                </div>
            `).join('')}
            <div class="break-menu assign-break-menu">
                <button class="btn btn-ghost btn-small btn-add-break" id="assign-break-toggle" aria-expanded="false" aria-controls="assign-break-options" type="button">
                    <span>&#9749; Break</span>
                    <span class="break-menu-arrow">&#9662;</span>
                </button>
                <ul class="break-options" id="assign-break-options" style="display:none;"></ul>
            </div>
            <div class="assign-custom">
                <input type="text" id="assign-custom-input" placeholder="Or type a custom entry...">
            </div>
            <label class="add-to-todo-row">
                <input type="checkbox" id="assign-add-todo">
                Also add to To-Do list
            </label>
            <div class="assign-modal-actions">
                <button class="btn btn-primary btn-small" id="assign-confirm">Add</button>
                <button class="btn btn-ghost btn-small" id="assign-cancel">Cancel</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const customInput = modal.querySelector('#assign-custom-input');
    const assignAddTodoCheck = modal.querySelector('#assign-add-todo');

    // Make sure interactions inside the modal never reach the calendar's
    // global drag-select handlers (which can steal focus from the input).
    modal.addEventListener('mousedown', (e) => e.stopPropagation());
    if (customInput) {
        ['mousedown', 'mouseup', 'click', 'keydown', 'keypress', 'keyup'].forEach(evt => {
            customInput.addEventListener(evt, (e) => e.stopPropagation());
        });
    }

    // Typeahead on the custom-entry field: suggest priorities + active to-dos by
    // word overlap so a similarly-worded existing task surfaces even here. When
    // a break-type suggestion is picked, remember to commit it as a break.
    let assignCustomType = 'todo';
    let assignSuggestCtl = null;
    if (customInput && window.taskSuggest && typeof window.taskSuggest.attach === 'function') {
        assignSuggestCtl = window.taskSuggest.attach({
            input: customInput,
            onPick: (item) => { assignCustomType = (item.type === 'break') ? 'break' : 'todo'; }
        });
    }
    // Typing after a pick reverts to a normal task type.
    if (customInput) {
        customInput.addEventListener('input', () => { assignCustomType = 'todo'; });
    }

    function commitBlock(task, type) {
        if (!task || !task.trim()) return;
        const finalType = type || 'todo';
        blocks.push({ id: newBlockId(), start: startMin, end: endMin, task: task.trim(), type: finalType });
        blocks.sort((a, b) => a.start - b.start);
        saveData('timeblocksV2', blocks);
        if (assignAddTodoCheck && assignAddTodoCheck.checked) {
            addToTodoList(task, finalType);
        }
        if (assignSuggestCtl) assignSuggestCtl.destroy();
        renderTimeBlockCalendar();
        modal.remove();
    }

    modal.querySelectorAll('.task-option').forEach(opt => {
        opt.addEventListener('click', () => {
            commitBlock(opt.dataset.task, opt.dataset.type === 'break' ? 'break' : 'todo');
        });
    });

    // Collapsible Break menu inside the assign modal: same break types as the
    // To-Do list, plus an "add new break type" action. Picking one creates a
    // break block for the selected time range.
    const assignBreakToggle = modal.querySelector('#assign-break-toggle');
    const assignBreakOptions = modal.querySelector('#assign-break-options');
    let assignBreakExpanded = false;

    function setAssignBreakExpanded(expanded) {
        assignBreakExpanded = expanded;
        assignBreakToggle.setAttribute('aria-expanded', String(expanded));
        assignBreakOptions.style.display = expanded ? 'block' : 'none';
    }

    function renderAssignBreakOptions() {
        // Only existing break types are selectable here. New break kinds can
        // only be created from the To-Do list's Break menu on the scheduler page.
        assignBreakOptions.innerHTML = breakTypes.map(b => `
            <li><button class="break-option" type="button" data-break="${escapeHtml(b)}">${escapeHtml(b)}</button></li>
        `).join('');

        assignBreakOptions.querySelectorAll('.break-option').forEach(btn => {
            btn.addEventListener('click', () => {
                commitBlock(btn.dataset.break, 'break');
            });
        });
    }

    assignBreakToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        setAssignBreakExpanded(!assignBreakExpanded);
    });
    renderAssignBreakOptions();

    modal.querySelector('#assign-confirm').addEventListener('click', () => {
        commitBlock(customInput.value, assignCustomType);
    });
    // keydown (not keypress) so the typeahead's Enter-to-pick can suppress this
    // via stopImmediatePropagation when a suggestion is highlighted.
    customInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commitBlock(customInput.value, assignCustomType);
    });

    modal.querySelector('#assign-cancel').addEventListener('click', () => modal.remove());

    // Backdrop-dismiss: ignore any clicks in the first 300ms so the same
    // gesture that opened the modal can't immediately close it
    const openedAt = Date.now();
    modal.addEventListener('click', (e) => {
        if (e.target === modal && Date.now() - openedAt > 300) {
            modal.remove();
        }
    });

    // Focus the custom input for quick typing
    if (customInput) setTimeout(() => customInput.focus(), 0);
}

// Scroll the calendar so the current time is visible (centered)
window.scrollTimeBlockToNow = function() {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    // Clamp within calendar range
    const startMin = CAL_START_HOUR * 60;
    const endMin = CAL_END_HOUR * 60;
    const clamped = Math.max(startMin, Math.min(nowMin, endMin));

    const slotIndex = (clamped - startMin) / SLOT_MINUTES;
    const targetTop = slotIndex * SLOT_HEIGHT;

    // Center the current time in the visible area
    const scrollTo = Math.max(0, targetTop - timeblockCalendar.clientHeight / 2);
    timeblockCalendar.scrollTop = scrollTo;
};

renderTimeBlockCalendar();
// Scroll to now on initial load
setTimeout(() => window.scrollTimeBlockToNow(), 0);

// ===== Keep the scheduler in sync with the full Calendar =====
// The Calendar can run in a separate window; when it writes today's events to
// localStorage, this window receives a `storage` event and re-renders so newly
// scheduled tasks/events appear here immediately.
window.addEventListener('storage', (e) => {
    if (e.key === 'focusflow_calendarEvents') {
        renderTimeBlockCalendar();
    }
});

// Also re-read on focus/visibility, in case the storage event was missed (e.g.
// the calendar window wrote while this one was fully backgrounded).
window.addEventListener('focus', () => renderTimeBlockCalendar());
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) renderTimeBlockCalendar();
});

// Public hook so app.js can force a refresh when the Scheduler page is shown.
window.refreshTimeBlockCalendar = renderTimeBlockCalendar;
