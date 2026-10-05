// Property 8: Ack mirrors batch ids — task 8.4 (optional).
//
// Validates Requirement 4.7: for any distractionBatch the desktop receives, the
// acknowledgement it returns contains EXACTLY the set of event ids present in
// that batch (same members, same order — no more, no less).
//
// These exercise the pure `buildAck` / `batchEventIds` / `handleMessage`
// helpers exported from js/desktop-sync-server.js, so the property runs under
// node:test without booting Electron, ws, or Bonjour.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
    buildAck,
    batchEventIds,
    handleMessage
} = require('../js/desktop-sync-server');

// A tiny deterministic PRNG so the generated cases are reproducible across runs.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Build a distractionBatch with `n` events, each carrying a stable uuid id.
function makeBatch(n) {
    const events = [];
    for (let i = 0; i < n; i++) {
        events.push({
            id: crypto.randomUUID(),
            elapsed: i * 7,
            occurredAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
            tag: 'phone'
        });
    }
    return { type: 'distractionBatch', sessionId: crypto.randomUUID(), dateKey: '2025-06-14', events };
}

test('Property 8: ack event ids equal the batch event ids in order (fixed sample)', () => {
    const batch = makeBatch(3);
    const ack = buildAck(batch);
    assert.strictEqual(ack.type, 'ack');
    assert.deepStrictEqual(ack.eventIds, batch.events.map(e => e.id));
});

test('Property 8: holds across many generated batch sizes', () => {
    const rand = mulberry32(0x0F0C5);
    for (let iter = 0; iter < 200; iter++) {
        const n = Math.floor(rand() * 12); // batches of 0..11 events
        const batch = makeBatch(n);
        const expected = batch.events.map(e => e.id);

        // via buildAck
        const ack = buildAck(batch);
        assert.strictEqual(ack.type, 'ack');
        assert.deepStrictEqual(ack.eventIds, expected, `buildAck mismatch at n=${n}`);

        // via batchEventIds
        assert.deepStrictEqual(batchEventIds(batch), expected, `batchEventIds mismatch at n=${n}`);

        // The ack is EXACT: same length (no extras) and every id is a batch id.
        assert.strictEqual(ack.eventIds.length, expected.length);
        const batchIdSet = new Set(expected);
        for (const id of ack.eventIds) {
            assert.ok(batchIdSet.has(id), 'ack contained an id not in the batch');
        }
    }
});

test('Property 8: handleMessage routes a distractionBatch to an id-mirroring ack', () => {
    const batch = makeBatch(4);
    const result = handleMessage(batch, { fingerprint: 'fp', pairingToken: null });
    assert.ok(result.reply, 'expected a reply');
    assert.strictEqual(result.reply.type, 'ack');
    assert.deepStrictEqual(result.reply.eventIds, batch.events.map(e => e.id));
    // The batch is also forwarded to the renderer unchanged for merge.
    assert.strictEqual(result.forwardToRenderer, batch);
});

test('Property 8: empty batch yields an empty ack (vacuously exact)', () => {
    const batch = { type: 'distractionBatch', sessionId: 'x', dateKey: '2025-06-14', events: [] };
    assert.deepStrictEqual(buildAck(batch), { type: 'ack', eventIds: [] });
});

test('Property 8: malformed batch (no events array) acks with no ids rather than throwing', () => {
    assert.deepStrictEqual(buildAck({ type: 'distractionBatch' }), { type: 'ack', eventIds: [] });
    assert.deepStrictEqual(batchEventIds(undefined), []);
    assert.deepStrictEqual(batchEventIds({ events: null }), []);
});

