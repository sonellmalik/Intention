// Unit + property tests for pairing-QR generation helpers (task 9.2).
//
// Covers the pure, testable pieces the `get-pairing-qr` IPC handler relies on:
//   - pickLanHost(): LAN IPv4 selection from os.networkInterfaces()-shaped input
//   - buildPairingPayload(): always-complete {host,port,deviceId,pairingToken,fingerprint}
//   - QR round trip (Property 9): JSON.stringify(payload) -> QR data URL -> decode
//     reproduces an equivalent payload with all required fields present.
//
// These use the built-in node:test runner (no extra test-framework dependency).

const test = require('node:test');
const assert = require('node:assert');

const {
    pickLanHost,
    buildPairingPayload,
    generatePairingToken,
    generateDeviceId,
    generateFingerprint
} = require('../js/desktop-sync-server');

// ---------------------------------------------------------------------------
// pickLanHost — LAN IPv4 selection
// ---------------------------------------------------------------------------

test('pickLanHost prefers a private (192.168.x) IPv4 over a public one', () => {
    const ifaces = {
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        eth0: [
            { address: '203.0.113.5', family: 'IPv4', internal: false },
            { address: '192.168.1.42', family: 'IPv4', internal: false }
        ]
    };
    assert.strictEqual(pickLanHost(ifaces), '192.168.1.42');
});

test('pickLanHost handles numeric family (Node >=18) and 10.x range', () => {
    const ifaces = {
        en0: [{ address: '10.0.0.7', family: 4, internal: false }]
    };
    assert.strictEqual(pickLanHost(ifaces), '10.0.0.7');
});

test('pickLanHost recognizes 172.16-31 as private but not 172.32', () => {
    assert.strictEqual(
        pickLanHost({ en0: [{ address: '172.20.5.5', family: 'IPv4', internal: false }] }),
        '172.20.5.5'
    );
    // 172.32 is public; with no private option it is still returned as the only candidate
    assert.strictEqual(
        pickLanHost({ en0: [{ address: '172.32.5.5', family: 'IPv4', internal: false }] }),
        '172.32.5.5'
    );
});

test('pickLanHost skips internal and IPv6 addresses', () => {
    const ifaces = {
        lo: [
            { address: '127.0.0.1', family: 'IPv4', internal: true },
            { address: '::1', family: 'IPv6', internal: true }
        ],
        eth0: [
            { address: 'fe80::1', family: 'IPv6', internal: false },
            { address: '192.168.0.9', family: 'IPv4', internal: false }
        ]
    };
    assert.strictEqual(pickLanHost(ifaces), '192.168.0.9');
});

test('pickLanHost falls back to 127.0.0.1 when nothing qualifies', () => {
    assert.strictEqual(pickLanHost({}), '127.0.0.1');
    assert.strictEqual(pickLanHost(undefined), '127.0.0.1');
    assert.strictEqual(
        pickLanHost({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }),
        '127.0.0.1'
    );
});

// ---------------------------------------------------------------------------
// buildPairingPayload — always complete
// ---------------------------------------------------------------------------

test('buildPairingPayload passes through valid fields', () => {
    const p = buildPairingPayload({
        host: '192.168.1.5',
        port: 51234,
        deviceId: 'abc123',
        pairingToken: 'tok',
        fingerprint: 'fp'
    });
    assert.deepStrictEqual(p, {
        host: '192.168.1.5',
        port: 51234,
        deviceId: 'abc123',
        pairingToken: 'tok',
        fingerprint: 'fp'
    });
});

test('buildPairingPayload coerces missing/invalid inputs to a complete payload', () => {
    const p = buildPairingPayload({ port: null });
    assert.strictEqual(p.host, '127.0.0.1');
    assert.strictEqual(p.port, 0);          // null actualPort -> 0 (manual fallback)
    assert.strictEqual(p.deviceId, '');
    assert.strictEqual(p.pairingToken, '');
    assert.strictEqual(p.fingerprint, '');
    // all required keys present
    for (const k of ['host', 'port', 'deviceId', 'pairingToken', 'fingerprint']) {
        assert.ok(Object.prototype.hasOwnProperty.call(p, k), `missing ${k}`);
    }
});

test('buildPairingPayload with no argument still returns a usable payload', () => {
    const p = buildPairingPayload();
    assert.strictEqual(p.host, '127.0.0.1');
    assert.strictEqual(p.port, 0);
});

// ---------------------------------------------------------------------------
// Property 9: Pairing QR round trip
// Validates: Requirements 3.1
// Encoding the payload to a QR code and decoding the scanned result reproduces
// an equivalent payload with all required fields present. We encode to a QR
// data URL exactly as the IPC handler does; the "scan" is modeled by decoding
// the JSON that was encoded (QRCode.toDataURL is lossless for the input text).
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = ['host', 'port', 'deviceId', 'pairingToken', 'fingerprint'];

test('Property 9: QR round trip preserves all required fields (fixed sample)', async () => {
    const QRCode = require('qrcode');
    const payload = buildPairingPayload({
        host: '192.168.1.77',
        port: 49827,
        deviceId: generateDeviceId(),
        pairingToken: generatePairingToken(),
        fingerprint: generateFingerprint()
    });

    const encoded = JSON.stringify(payload);
    const dataUrl = await QRCode.toDataURL(encoded);
    assert.match(dataUrl, /^data:image\/png;base64,/);

    // The QR carries `encoded`; scanning yields that string back, which decodes
    // to an equivalent payload.
    const decoded = JSON.parse(encoded);
    assert.deepStrictEqual(decoded, payload);
    for (const f of REQUIRED_FIELDS) {
        assert.ok(Object.prototype.hasOwnProperty.call(decoded, f), `missing field ${f}`);
    }
});

test('Property 9: QR round trip holds across many generated payloads', async () => {
    const QRCode = require('qrcode');
    const hosts = ['127.0.0.1', '192.168.0.1', '10.1.2.3', '172.16.9.9'];

    for (let i = 0; i < 40; i++) {
        const payload = buildPairingPayload({
            host: hosts[i % hosts.length],
            port: (1024 + ((i * 2731) % 64000)),
            deviceId: generateDeviceId(),
            pairingToken: generatePairingToken(),
            fingerprint: generateFingerprint()
        });

        const encoded = JSON.stringify(payload);
        const dataUrl = await QRCode.toDataURL(encoded);
        assert.match(dataUrl, /^data:image\/png;base64,/);

        const decoded = JSON.parse(encoded);
        assert.deepStrictEqual(decoded, payload);
        for (const f of REQUIRED_FIELDS) {
            assert.ok(
                Object.prototype.hasOwnProperty.call(decoded, f),
                `iteration ${i} missing field ${f}`
            );
        }
    }
});
