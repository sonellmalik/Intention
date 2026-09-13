// ===== Pomodoro History & Calendar =====
const calendarGrid = document.getElementById('calendar-grid');
const calendarMonth = document.getElementById('calendar-month');
const btnCalPrev = document.getElementById('btn-cal-prev');
const btnCalNext = document.getElementById('btn-cal-next');
const todayCountEl = document.getElementById('today-count');
const historyStats = document.getElementById('history-stats');
const dayDetail = document.getElementById('day-detail');
const dayDetailDate = document.getElementById('day-detail-date');
const dayDetailPomodoros = document.getElementById('day-detail-pomodoros');
const dayDetailDistractions = document.getElementById('day-detail-distractions');
const dayDetailList = document.getElementById('day-detail-list');
const dayDetailSchedule = document.getElementById('day-detail-schedule');
const btnCloseDetail = document.getElementById('btn-close-detail');

let calendarDate = new Date();
// The calendar day ("YYYY-MM-DD") the History UI was last rendered for. Used to
// detect a date rollover (e.g. after midnight or waking from sleep).
let _lastRenderedDayKey = getTodayKey();

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Get date key in YYYY-MM-DD format
function getDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getTodayKey() {
    return getDateKey(new Date());
}

// ===== Pomodoro Log =====
function getPomodoroLog() {
    return loadData('pomodoroLog', {});
}

window.logCompletedPomodoro = function() {
    const log = getPomodoroLog();
    const today = getTodayKey();
    log[today] = (log[today] || 0) + 1;
    saveData('pomodoroLog', log);
    updateTodayCount();
};

// ===== Schedule (time-block) Log =====
// Stores each day's calendar blocks, keyed by the same YYYY-MM-DD as pomodoros.
function getScheduleLog() {
    return loadData('scheduleLog', {});
}

// Save a day's schedule into history. `dateKey` is YYYY-MM-DD; if omitted, uses today.
// `blocksForDay` is the array of { start, end, task, type } to archive.
window.saveScheduleForDay = function(blocksForDay, dateKey) {
    if (!blocksForDay || blocksForDay.length === 0) return;
    const key = dateKey || getTodayKey();
    const log = getScheduleLog();
    // Store a lean copy (no ids needed for history)
    log[key] = blocksForDay.map(b => ({
        start: b.start,
        end: b.end,
        task: b.task,
        type: b.type || 'todo'
    }));
    saveData('scheduleLog', log);
};

// ===== Distraction Log (per day) =====
function getDistractionLog() {
    return loadData('distractionDailyLog', {});
}

// Log a distraction with cause and tag (called from timer.js)
window.logDailyDistraction = function(info) {
    const log = getDistractionLog();
    const today = getTodayKey();
    if (!log[today]) log[today] = [];
    log[today].push({
        time: new Date().toLocaleTimeString(),
        cause: info.cause || null,
        tag: info.tag || null,
        duration: info.duration || null
    });
    saveData('distractionDailyLog', log);
};

// ===== Calendar =====
function getLevel(count) {
    if (count === 0) return 0;
    if (count <= 2) return 1;
    if (count <= 4) return 2;
    if (count <= 6) return 3;
    return 4;
}

function updateTodayCount() {
    const log = getPomodoroLog();
    const today = getTodayKey();
    todayCountEl.textContent = log[today] || 0;
}

function renderCalendar() {
    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();
    const log = getPomodoroLog();
    const dLog = getDistractionLog();

    calendarMonth.textContent = `${MONTH_NAMES[month]} ${year}`;

    const firstDay = new Date(year, month, 1).getDay();
    const startOffset = (firstDay === 0) ? 6 : firstDay - 1;
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    let html = '<div class="calendar-day-labels">';
    DAY_LABELS.forEach(d => { html += `<span class="day-label">${d}</span>`; });
    html += '</div><div class="calendar-cells">';

    for (let i = 0; i < startOffset; i++) {
        html += '<div class="cal-cell empty"></div>';
    }

    const todayKey = getTodayKey();

    for (let day = 1; day <= daysInMonth; day++) {
        const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const count = log[dateKey] || 0;
        const dCount = (dLog[dateKey] || []).length;
        const level = getLevel(count);
        const isToday = dateKey === todayKey;

        html += `<div class="cal-cell level-${level}${isToday ? ' today' : ''}" data-date="${dateKey}" title="${count} poms, ${dCount} distractions">
            <span class="cal-day">${day}</span>
        </div>`;
    }

    html += '</div>';
    calendarGrid.innerHTML = html;

    // Click to view day detail
    calendarGrid.querySelectorAll('.cal-cell:not(.empty)').forEach(cell => {
        cell.addEventListener('click', () => showDayDetail(cell.dataset.date));
    });

    renderMonthStats(year, month, log);
}

function showDayDetail(dateKey) {
    const log = getPomodoroLog();
    const dLog = getDistractionLog();
    const pomodoros = log[dateKey] || 0;
    const distractions = dLog[dateKey] || [];

    // Format date nicely
    const parts = dateKey.split('-');
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    const options = { weekday: 'short', month: 'short', day: 'numeric' };
    dayDetailDate.textContent = d.toLocaleDateString('en-US', options);

    dayDetailPomodoros.textContent = pomodoros;
    dayDetailDistractions.textContent = distractions.length;

    if (distractions.length === 0) {
        dayDetailList.innerHTML = '<p class="no-data">No distractions logged.</p>';
    } else {
        dayDetailList.innerHTML = distractions.map(dist => {
            const tagIcon = dist.tag ? getTagEmoji(dist.tag) : '';
            const causeText = dist.cause || (dist.tag ? getTagLabel(dist.tag) : 'Quick tap');
            const durationText = dist.duration ? ` (${dist.duration})` : '';
            return `<li class="detail-item">
                <span class="detail-time">${dist.time}</span>
                <span class="detail-cause">${tagIcon} ${causeText}${durationText}</span>
            </li>`;
        }).join('');
    }

    // Saved schedule for the day
    const schedule = getScheduleLog()[dateKey] || [];
    if (dayDetailSchedule) {
        if (schedule.length === 0) {
            dayDetailSchedule.innerHTML = '<h4 class="detail-subhead">Schedule</h4><p class="no-data">No schedule saved.</p>';
        } else {
            const rows = schedule
                .slice()
                .sort((a, b) => a.start - b.start)
                .map(b => `
                    <li class="detail-item">
                        <span class="detail-time">${fmtMin(b.start)}–${fmtMin(b.end)}</span>
                        <span class="detail-cause">${b.type === 'break' ? '☕ ' : ''}${escapeText(b.task)}</span>
                    </li>`).join('');
            dayDetailSchedule.innerHTML = `<h4 class="detail-subhead">Schedule</h4><ul class="day-detail-list">${rows}</ul>`;
        }
    }

    dayDetail.style.display = 'block';
}

// Format minutes-from-midnight as h:mm AM/PM
function fmtMin(mins) {
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    let dh = h % 12; if (dh === 0) dh = 12;
    return `${dh}:${String(m).padStart(2, '0')} ${ampm}`;
}

function escapeText(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
}

function getTagEmoji(tag) {
    switch(tag) {
        case 'phone': return '📱';
        case 'people': return '👥';
        case 'thought': return '💭';
        case 'other': return '❓';
        default: return '';
    }
}

function getTagLabel(tag) {
    switch(tag) {
        case 'phone': return 'Phone';
        case 'people': return 'People';
        case 'thought': return 'Internal thought';
        case 'other': return 'Other';
        default: return 'Unknown';
    }
}

btnCloseDetail.addEventListener('click', () => {
    dayDetail.style.display = 'none';
});

function renderMonthStats(year, month, log) {
    const dLog = getDistractionLog();
    let totalPomodoros = 0;
    let totalDistractions = 0;
    let activeDays = 0;
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let day = 1; day <= daysInMonth; day++) {
        const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const count = log[dateKey] || 0;
        const dCount = (dLog[dateKey] || []).length;
        totalDistractions += dCount;
        if (count > 0) {
            totalPomodoros += count;
            activeDays++;
        }
    }

    const avg = activeDays > 0 ? (totalPomodoros / activeDays).toFixed(1) : '0';

    historyStats.innerHTML = `
        <div class="stat-row">
            <span class="stat-label-sm">Pomodoros</span>
            <span class="stat-value">${totalPomodoros}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label-sm">Active days</span>
            <span class="stat-value">${activeDays}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label-sm">Avg/day</span>
            <span class="stat-value">${avg}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label-sm">Distractions</span>
            <span class="stat-value">${totalDistractions}</span>
        </div>
    `;
}

// Navigation
btnCalPrev.addEventListener('click', () => {
    calendarDate.setMonth(calendarDate.getMonth() - 1);
    renderCalendar();
});

btnCalNext.addEventListener('click', () => {
    calendarDate.setMonth(calendarDate.getMonth() + 1);
    renderCalendar();
});

// ===== Daily Date Rollover =====
// "Today" is derived from new Date() at render time. If the app stays open past
// midnight, the highlighted day and today-count would otherwise stay stuck on
// the previous day. This refreshes the date-dependent UI right at 12:00 AM and
// reschedules itself for the next midnight.
function refreshHistoryForNewDay() {
    const now = new Date();

    // If the calendar is showing what was "this month" before midnight, keep it
    // following the current day so the new "today" highlight stays visible
    // (this also handles month/year boundaries like Jan 31 -> Feb 1).
    const viewingCurrentPeriod =
        calendarDate.getFullYear() === now.getFullYear() &&
        calendarDate.getMonth() === now.getMonth();

    if (viewingCurrentPeriod) {
        calendarDate = new Date();
    }

    _lastRenderedDayKey = getTodayKey();
    updateTodayCount();
    renderCalendar();
}

function scheduleHistoryMidnightRefresh() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0); // next midnight
    // Add a 1s cushion so we're safely into the new day when it fires.
    const msUntilMidnight = midnight.getTime() - now.getTime() + 1000;

    setTimeout(() => {
        refreshHistoryForNewDay();
        scheduleHistoryMidnightRefresh(); // reschedule for the following midnight
    }, msUntilMidnight);
}

// Safety net for machine sleep/hibernate: a long setTimeout may not fire on
// time if the device slept through midnight. Whenever the window regains focus
// or becomes visible, check whether the calendar day changed since the last
// render and refresh if so.
function checkDayRolloverOnWake() {
    if (getTodayKey() !== _lastRenderedDayKey) {
        refreshHistoryForNewDay();
    }
}

window.addEventListener('focus', checkDayRolloverOnWake);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkDayRolloverOnWake();
});

// Initialize
updateTodayCount();
renderCalendar();
scheduleHistoryMidnightRefresh();
