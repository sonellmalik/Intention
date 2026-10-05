// mergePhoneDistractions — merge phone-originated distraction events into the
// desktop's existing distraction stores (iOS Focus Companion spec, task 10.1).
//
// The desktop receives a `distractionBatch` from the paired phone (forwarded to
// the renderer over the `phone-distractions` IPC channel by DesktopSyncServer).
// Each event is merged into two places, deduplicated by its stable `id`:
//   1) the live in-memory timeline `timerState.distractionTimestamps` — only
//      while the current running session is a work session that matches the
//      batch's sessionId; and
//   2) the persisted `distractionDailyLog[dateKey]` history — always.
//
// Design references:
//   - "Renderer merge (timer.js / history.js)" -> Algorithm mergePhoneDistractions
//   - Property 2 (idempotent, complete merge), Property 5 (tag consistency).
//   - Requirements 5.1, 5.2, 5.3, 5.4, 5.5.
//
// This file is intentionally free of DOM/Electron/localStorage access so the
// pure dedup/merge logic can be exercised directly under `node:test`
// (tasks 10.2 / 10.3). The pure functions operate on plain values passed in;
// the small `mergePhoneDistractions(...)` orchestrator takes its side-effecting
// dependencies (loadData / saveData / renderCalendar / timerState) as arguments
// so it, too, can run under node with fakes. A thin browser wrapper
// (`installMergePhoneDistractions`) wires the real renderer dependencies and
// subscribes to `window.electronAPI.onPhoneDistractions`.
//
// Exposed both as a CommonJS module (for node tests) and as a browser global
// (`window.mergePhoneDistractionsModule`) via the UMD-style guard at the end.

(function (root, factory) {
    const api = factory();
    // CommonJS / node:test
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    // Browser / Electron renderer global
    if (root) {
        root.mergePhoneDistractionsModule = api;
    }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {

    // ---- pure helpers ------------------------------------------------------

    /**
     * True when `list` already contains an entry whose `id` equals `id`.
     * Entries without an `id` (legacy manual/quick-tap entries) never match,
     * so they neither block nor get overwritten by phone merges. A phone event
     * without an `id` is treated as un-dedupable and will always be added.
     *
     * @param {Array<{id?: any}>} list
     * @param {any} id
     * @returns {boolean}
     */
    function hasId(list, id) {
        if (!Array.isArray(list)) return false;
        if (id === undefined || id === null) return false;
        for (const entry of list) {
            if (entry && entry.id === id) return true;
        }
        return false;
    }

    /**
     * Format an event's wall-clock time for display in the daily log, matching
     * the shape existing entries use (`new Date().toLocaleTimeString()`).
     * Accepts an ISO string, a Date, or a number (epoch ms). Falls back to an
     * empty string when the value cannot be parsed, so a malformed `occurredAt`
     * never throws during merge.
     *
     * @param {string|number|Date} occurredAt
     * @returns {string}
     */
    function formatTime(occurredAt) {
        let d;
        if (occurredAt instanceof Date) {
            d = occurredAt;
        } else if (typeof occurredAt === 'number' && Number.isFinite(occurredAt)) {
            d = new Date(occurredAt);
        } else if (typeof occurredAt === 'string' && occurredAt.length > 0) {
            d = new Date(occurredAt);
        } else {
            return '';
        }
        if (isNaN(d.getTime())) return '';
        return d.toLocaleTimeString();
    }

    /**
     * Merge phone events into the live timeline array, deduping by `id`.
     * Mutates and returns `timestamps`. Each new event is pushed as
     * `{ id, elapsed, tag }` — the shape the timeline renderer expects, with a
     * phone `tag` so it shows the 📱 icon. `elapsed` is coerced to a finite
     * number (defaulting to 0) so a missing/invalid value can't break rendering.
     *
     * @param {Array<{id?: any, elapsed?: number, tag?: string}>} timestamps
     * @param {Array<{id?: any, elapsed?: number, tag?: string}>} events
     * @returns {Array} the same `timestamps` array (for chaining/tests)
     */
    function mergeIntoTimeline(timestamps, events) {
        if (!Array.isArray(timestamps)) timestamps = [];
        if (!Array.isArray(events)) return timestamps;
        for (const e of events) {
            if (!e) continue;
            if (hasId(timestamps, e.id)) continue;
            const elapsed = Number.isFinite(e.elapsed) ? e.elapsed : 0;
            const tag = typeof e.tag === 'string' && e.tag.length > 0 ? e.tag : 'phone';
            timestamps.push({ id: e.id, elapsed, tag });
        }
        return timestamps;
    }

    /**
     * Merge phone events into a single day's distraction-log array, deduping by
     * `id`. Mutates and returns `dayEntries`. Each new event is stored in the
     * existing daily-log shape plus the additive `id` and `source` fields:
     *   { id, time, cause: null, tag: "phone", duration: null, source: "ios" }
     * Backward-compatible: pre-existing entries without `id`/`source` are left
     * untouched and never match the dedup check.
     *
     * @param {Array} dayEntries
     * @param {Array<{id?: any, occurredAt?: string|number|Date}>} events
     * @returns {Array} the same `dayEntries` array
     */
    function mergeIntoDailyLog(dayEntries, events) {
        if (!Array.isArray(dayEntries)) dayEntries = [];
        if (!Array.isArray(events)) return dayEntries;
        for (const e of events) {
            if (!e) continue;
            if (hasId(dayEntries, e.id)) continue;
            dayEntries.push({
                id: e.id,
                time: formatTime(e.occurredAt),
                cause: null,
                tag: 'phone',
                duration: null,
                source: 'ios'
            });
        }
        return dayEntries;
    }

    // ---- orchestrator (side effects injected) ------------------------------

    /**
     * Merge a received `distractionBatch` message into the desktop stores.
     * All side-effecting collaborators are injected via `deps` so this runs
     * unchanged in the Electron renderer (real deps) and under node tests
     * (fakes). Idempotent: merging the same batch twice yields the same stores
     * as merging it once (dedup by `id`).
     *
     * @param {object} msg - the distractionBatch:
     *   { type, sessionId, dateKey, events: [{ id, elapsed, occurredAt, tag }] }
     * @param {object} deps
     * @param {object} deps.timerState - the live timer state (needs `mode`,
     *   `currentSessionId`, `distractionTimestamps`).
     * @param {(key: string, fallback: any) => any} deps.loadData
     * @param {(key: string, data: any) => void} deps.saveData
     * @param {() => void} [deps.renderCalendar] - refresh the heatmap/counts.
     * @returns {{ timelineMerged: number, dailyLogMerged: number }} counts of
     *   events actually added (useful for tests/telemetry).
     */
    function mergePhoneDistractions(msg, deps) {
        const result = { timelineMerged: 0, dailyLogMerged: 0 };
        if (!msg || !Array.isArray(msg.events) || msg.events.length === 0) {
            return result;
        }
        deps = deps || {};
        const timerState = deps.timerState || {};
        const loadData = typeof deps.loadData === 'function' ? deps.loadData : null;
        const saveData = typeof deps.saveData === 'function' ? deps.saveData : null;
        const renderCalendar = typeof deps.renderCalendar === 'function' ? deps.renderCalendar : null;

        // 1) Live timeline — only for the current running WORK session.
        if (timerState.mode === 'work' && msg.sessionId && msg.sessionId === timerState.currentSessionId) {
            if (!Array.isArray(timerState.distractionTimestamps)) {
                timerState.distractionTimestamps = [];
            }
            const before = timerState.distractionTimestamps.length;
            mergeIntoTimeline(timerState.distractionTimestamps, msg.events);
            result.timelineMerged = timerState.distractionTimestamps.length - before;
        }

        // 2) Daily history log — always, deduped by id, keyed by batch dateKey.
        if (loadData && saveData && typeof msg.dateKey === 'string' && msg.dateKey.length > 0) {
            const dLog = loadData('distractionDailyLog', {}) || {};
            const dayEntries = Array.isArray(dLog[msg.dateKey]) ? dLog[msg.dateKey] : [];
            const before = dayEntries.length;
            mergeIntoDailyLog(dayEntries, msg.events);
            result.dailyLogMerged = dayEntries.length - before;
            dLog[msg.dateKey] = dayEntries;
            saveData('distractionDailyLog', dLog);
            if (renderCalendar) renderCalendar();
        }

        return result;
    }

    /**
     * Browser-only wiring: subscribe to phone distraction batches and merge
     * them using the renderer's real dependencies. No-ops outside a renderer
     * that exposes `window.electronAPI.onPhoneDistractions`. Safe to call once
     * during startup.
     *
     * @param {object} [win] - defaults to the global `window`.
     * @returns {boolean} true when a subscription was installed.
     */
    function installMergePhoneDistractions(win) {
        const w = win || (typeof window !== 'undefined' ? window : undefined);
        if (!w || !w.electronAPI || typeof w.electronAPI.onPhoneDistractions !== 'function') {
            return false;
        }
        w.electronAPI.onPhoneDistractions((msg) => {
            mergePhoneDistractions(msg, {
                timerState: w.timerState,
                loadData: w.loadData,
                saveData: w.saveData,
                renderCalendar: w.renderCalendar
            });
        });
        return true;
    }

    return {
        hasId,
        formatTime,
        mergeIntoTimeline,
        mergeIntoDailyLog,
        mergePhoneDistractions,
        installMergePhoneDistractions
    };
});
