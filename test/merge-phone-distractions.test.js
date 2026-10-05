// Merge property + unit tests for the renderer phone-distraction merge
// (tasks 10.2 and 10.3, optional).
//
//   - Property 2 (idempotent, complete merge) — Requirements 5.1, 5.2, 5.3:
//       merging a batch places every event into the timeline (for the current
//       work session) and the daily log under its date key; merging the same
//       batch two+ times yields the same stores as merging it once; the merged
//       id set equals the union of previously-present ids and batch ids.
//   - Tag consistency (Property 5 desktop half) + backward compatibility —
//       Requirements 5.4, 5.5: merged daily-log entries carry tag "phone" and
//       source "ios"; entries lacking id/source are rendered/handled without
//       error and are never clobbered by the merge.
//
// Targets the pure module js/merge-phone-distractions.js, which is DOM/Electron
// free, so everything runs under node:test with injected fakes.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
    hasId,
    formatTime,
    mergeIntoTimeline,
    mergeIntoDailyLog,
    mergePhoneDistractions
} = require('../js/merge-phone-distractions');

// ---- fakes -----------------------------------------------------------------

// A minimal loadData/saveData pair backed by a plain object, mirroring the
// renderer's localStorage-backed helpers.
function makeStore(initial = {}) {
    const data = { ...initial };
    return {
        data,
        loadData: (key, fallback) => (key in data ? data[key] : fallback),
        saveData: (key, value) => { data[key] = value; }
    };
}

function makeBatch({ sessionId, dateKey = '2025-06-14', n = 3, startId = 0 } = {}) {
    const events = [];
    for (let i = 0; i < n; i++) {
        events.push({
            id: `evt-${startId + i}`,
            elapsed: (startId + i) * 30,
            occurredAt: new Date(1_700_000_000_000 + (startId + i) * 1000).toISOString(),
            tag: 'phone'
        });
    }
    return { type: 'distractionBatch', sessionId, dateKey, events };
}

// ---- Property 2: idempotent, complete merge (timeline) ---------------------

test('Property 2: timeline merge adds every event exactly once (idempotent)', () => {
    const sessionId = crypto.randomUUID();
    const batch = makeBatch({ sessionId, n: 5 });
    const timerState = { mode: 'work', currentSessionId: sessionId, distractionTimestamps: [] };
    const store = makeStore();
    const deps = { timerState, ...store, renderCalendar: () => {} };

    const first = mergePhoneDistractions(batch, deps);
    assert.strictEqual(first.timelineMerged, 5, 'all 5 events should enter the timeline');
    assert.strictEqual(timerState.distractionTimestamps.length, 5);

    // Merge the SAME batch again: no change (dedup by id).
    const second = mergePhoneDistractions(batch, deps);
    assert.strictEqual(second.timelineMerged, 0, 'second merge adds nothing');
    assert.strictEqual(timerState.distractionTimestamps.length, 5);

    // And a third time for good measure.
    mergePhoneDistractions(batch, deps);
    assert.strictEqual(timerState.distractionTimestamps.length, 5);

    // The merged id set equals the batch id set.
    const merged = new Set(timerState.distractionTimestamps.map(t => t.id));
    assert.deepStrictEqual([...merged].sort(), batch.events.map(e => e.id).sort());
});

// ---- Property 2: idempotent, complete merge (daily log) --------------------

test('Property 2: daily-log merge is complete and idempotent under batch date key', () => {
    const sessionId = crypto.randomUUID();
    const batch = makeBatch({ sessionId, dateKey: '2025-06-14', n: 4 });
    const timerState = { mode: 'work', currentSessionId: sessionId, distractionTimestamps: [] };
    const store = makeStore();
    const deps = { timerState, ...store };

    mergePhoneDistractions(batch, deps);
    let day = store.data.distractionDailyLog['2025-06-14'];
    assert.strictEqual(day.length, 4, 'all events land under the batch date key');

    // Merge the same batch twice more — still 4 entries.
    mergePhoneDistractions(batch, deps);
    mergePhoneDistractions(batch, deps);
    day = store.data.distractionDailyLog['2025-06-14'];
    assert.strictEqual(day.length, 4, 'idempotent: no duplicates on re-merge');

    // union property: previously-present ids ∪ batch ids
    const ids = new Set(day.map(e => e.id));
    assert.deepStrictEqual([...ids].sort(), batch.events.map(e => e.id).sort());
});

test('Property 2: union — a second, overlapping batch adds only the new ids', () => {
    const sessionId = crypto.randomUUID();
    const store = makeStore();
    const timerState = { mode: 'work', currentSessionId: sessionId, distractionTimestamps: [] };
    const deps = { timerState, ...store };

    const batchA = makeBatch({ sessionId, n: 3, startId: 0 });          // evt-0,1,2
    const batchB = makeBatch({ sessionId, n: 3, startId: 2 });          // evt-2,3,4 (evt-2 overlaps)

    mergePhoneDistractions(batchA, deps);
    const r = mergePhoneDistractions(batchB, deps);

    // Only evt-3 and evt-4 are new in both stores.
    assert.strictEqual(r.timelineMerged, 2);
    assert.strictEqual(r.dailyLogMerged, 2);

    const dayIds = store.data.distractionDailyLog['2025-06-14'].map(e => e.id).sort();
    assert.deepStrictEqual(dayIds, ['evt-0', 'evt-1', 'evt-2', 'evt-3', 'evt-4']);

    const tlIds = timerState.distractionTimestamps.map(t => t.id).sort();
    assert.deepStrictEqual(tlIds, ['evt-0', 'evt-1', 'evt-2', 'evt-3', 'evt-4']);
});

test('Property 2: pure many-iteration idempotence over random shuffles', () => {
    // Merging events in any order, possibly repeated, always converges to the
    // same deduped set — mergeIntoDailyLog exercised directly.
    for (let iter = 0; iter < 100; iter++) {
        const n = 1 + (iter % 8);
        const events = [];
        for (let i = 0; i < n; i++) {
            events.push({ id: `e${i}`, occurredAt: new Date(1_700_000_000_000 + i).toISOString(), tag: 'phone' });
        }
        const day = [];
        // Merge once, then merge a shuffled + duplicated stream.
        mergeIntoDailyLog(day, events);
        const shuffled = events.concat(events).sort(() => (iter % 2 ? 1 : -1));
        mergeIntoDailyLog(day, shuffled);

        assert.strictEqual(day.length, n, `iter ${iter}: expected ${n} unique entries`);
        const ids = new Set(day.map(e => e.id));
        assert.strictEqual(ids.size, n);
    }
});

// ---- Task 10.3: tag consistency + backward compatibility -------------------

test('tag consistency: merged daily-log entries carry tag "phone" and source "ios"', () => {
    const sessionId = crypto.randomUUID();
    const batch = makeBatch({ sessionId, n: 3 });
    const store = makeStore();
    const deps = { timerState: { mode: 'work', currentSessionId: sessionId, distractionTimestamps: [] }, ...store };

    mergePhoneDistractions(batch, deps);
    for (const entry of store.data.distractionDailyLog['2025-06-14']) {
        assert.strictEqual(entry.tag, 'phone', 'phone-originated entry must be tagged phone');
        assert.strictEqual(entry.source, 'ios', 'phone-originated entry must be marked source ios');
        assert.strictEqual(entry.cause, null);
        assert.strictEqual(entry.duration, null);
    }
});

test('tag consistency: timeline entries default to the phone tag', () => {
    // An event missing a tag still merges as a phone distraction (📱).
    const timeline = [];
    mergeIntoTimeline(timeline, [{ id: 'a', elapsed: 10 }, { id: 'b', elapsed: 20, tag: '' }]);
    assert.strictEqual(timeline.length, 2);
    for (const t of timeline) {
        assert.strictEqual(t.tag, 'phone');
    }
});

test('backward compatibility: legacy entries without id/source survive a merge', () => {
    const sessionId = crypto.randomUUID();
    // Pre-existing daily log has legacy entries (no id, no source) — the shape
    // written by manual/quick-tap logging before the iOS feature existed.
    const legacy = [
        { time: '10:00:00 AM', cause: 'coffee', tag: null, duration: '5m' },
        { time: '10:15:00 AM', cause: null, tag: 'people', duration: null }
    ];
    const store = makeStore({ distractionDailyLog: { '2025-06-14': legacy.map(e => ({ ...e })) } });
    const timerState = { mode: 'work', currentSessionId: sessionId, distractionTimestamps: [] };
    const batch = makeBatch({ sessionId, n: 2 });

    const r = mergePhoneDistractions(batch, { timerState, ...store });
    const day = store.data.distractionDailyLog['2025-06-14'];

    // Both phone events added; the two legacy entries are untouched.
    assert.strictEqual(r.dailyLogMerged, 2);
    assert.strictEqual(day.length, 4);
    // Legacy entries still present, unchanged, and never gained an id/source.
    assert.deepStrictEqual(day[0], legacy[0]);
    assert.deepStrictEqual(day[1], legacy[1]);
    assert.strictEqual(day[0].id, undefined);
    assert.strictEqual(day[0].source, undefined);
});

test('backward compatibility: a legacy entry never blocks or matches a phone id', () => {
    // hasId ignores entries without an id, so dedup can't be fooled by legacy data.
    const legacy = [{ time: '9:00', cause: 'x' }];
    assert.strictEqual(hasId(legacy, undefined), false);
    assert.strictEqual(hasId(legacy, 'evt-0'), false);
});

// ---- guard rails -----------------------------------------------------------

test('timeline merge is skipped when the session id does not match', () => {
    const store = makeStore();
    const timerState = { mode: 'work', currentSessionId: 'session-A', distractionTimestamps: [] };
    const batch = makeBatch({ sessionId: 'session-B', n: 3 });
    const r = mergePhoneDistractions(batch, { timerState, ...store });
    assert.strictEqual(r.timelineMerged, 0, 'no timeline merge for a different session');
    // Daily log still records them (always merged, keyed by date).
    assert.strictEqual(r.dailyLogMerged, 3);
});

test('timeline merge is skipped outside a work session', () => {
    const store = makeStore();
    const sessionId = crypto.randomUUID();
    const timerState = { mode: 'shortBreak', currentSessionId: sessionId, distractionTimestamps: [] };
    const batch = makeBatch({ sessionId, n: 2 });
    const r = mergePhoneDistractions(batch, { timerState, ...store });
    assert.strictEqual(r.timelineMerged, 0);
});

test('formatTime tolerates bad input without throwing', () => {
    assert.strictEqual(formatTime(undefined), '');
    assert.strictEqual(formatTime('not-a-date'), '');
    assert.strictEqual(typeof formatTime(new Date()), 'string');
    assert.strictEqual(typeof formatTime(Date.now()), 'string');
});

test('empty / malformed batch is a no-op', () => {
    const store = makeStore();
    const deps = { timerState: { mode: 'work', currentSessionId: 'x', distractionTimestamps: [] }, ...store };
    assert.deepStrictEqual(mergePhoneDistractions(null, deps), { timelineMerged: 0, dailyLogMerged: 0 });
    assert.deepStrictEqual(mergePhoneDistractions({ events: [] }, deps), { timelineMerged: 0, dailyLogMerged: 0 });
});
