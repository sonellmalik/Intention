// Unit tests for the session-lifecycle wire-message builders (task 8.3).
// These pure functions back main.js's timer-started/timer-stopped handlers,
// which emit sessionStarted/sessionStopped to the paired iOS companion.
// _Requirements: 2.1, 2.5_
const test = require('node:test');
const assert = require('node:assert');
const { buildSessionStarted, buildSessionStopped } = require('../js/desktop-sync-server');

test('buildSessionStarted produces the design wire format', () => {
  const msg = buildSessionStarted({
    sessionId: 'abc-123',
    dateKey: '2025-06-14',
    mode: 'work',
    startedAt: '2025-06-14T10:30:00.000Z',
    plannedDuration: 1500
  });
  assert.deepStrictEqual(msg, {
    type: 'sessionStarted',
    sessionId: 'abc-123',
    dateKey: '2025-06-14',
    mode: 'work',
    startedAt: '2025-06-14T10:30:00.000Z',
    plannedDuration: 1500
  });
});

test('buildSessionStarted normalizes startedAt from a Date and number', () => {
  const d = new Date('2025-01-02T03:04:05.000Z');
  assert.strictEqual(buildSessionStarted({ startedAt: d }).startedAt, d.toISOString());
  assert.strictEqual(
    buildSessionStarted({ startedAt: d.getTime() }).startedAt,
    d.toISOString()
  );
});

test('buildSessionStarted defaults missing fields safely', () => {
  const msg = buildSessionStarted();
  assert.strictEqual(msg.type, 'sessionStarted');
  assert.strictEqual(msg.sessionId, '');
  assert.strictEqual(msg.dateKey, '');
  assert.strictEqual(msg.mode, 'work');
  assert.strictEqual(typeof msg.startedAt, 'string');
  // A valid ISO string round-trips through Date.
  assert.ok(!isNaN(new Date(msg.startedAt).getTime()));
  assert.strictEqual(msg.plannedDuration, 0);
});

test('buildSessionStarted coerces plannedDuration to a non-negative integer', () => {
  assert.strictEqual(buildSessionStarted({ plannedDuration: -10 }).plannedDuration, 0);
  assert.strictEqual(buildSessionStarted({ plannedDuration: 149.6 }).plannedDuration, 150);
  assert.strictEqual(buildSessionStarted({ plannedDuration: 'nope' }).plannedDuration, 0);
});

test('buildSessionStarted preserves non-work modes', () => {
  assert.strictEqual(buildSessionStarted({ mode: 'shortBreak' }).mode, 'shortBreak');
  assert.strictEqual(buildSessionStarted({ mode: 'longBreak' }).mode, 'longBreak');
});

test('buildSessionStopped produces the design wire format', () => {
  assert.deepStrictEqual(
    buildSessionStopped({ sessionId: 'abc-123', reason: 'completed' }),
    { type: 'sessionStopped', sessionId: 'abc-123', reason: 'completed' }
  );
});

test('buildSessionStopped defaults reason and sessionId', () => {
  assert.deepStrictEqual(buildSessionStopped(), {
    type: 'sessionStopped',
    sessionId: '',
    reason: 'stopped'
  });
  assert.deepStrictEqual(buildSessionStopped({ sessionId: 'x' }), {
    type: 'sessionStopped',
    sessionId: 'x',
    reason: 'stopped'
  });
});
