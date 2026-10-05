// Unit tests for the secure session store (js/auth/session-store.js).
//
// safeStorage and fs are mocked so these run in plain Node with no Electron and
// no real disk. We verify:
//   - set then get round-trips the session fields
//   - what lands "on disk" is ciphertext, not readable plaintext tokens
//   - setSession refuses to write when encryption is unavailable (no plaintext)
//   - getSession returns null when encryption is unavailable
//   - clearSession removes the file; get after clear is null
//   - a corrupt/foreign blob yields null and is cleaned up
//   - invalid sessions (missing tokens) are rejected

const test = require('node:test');
const assert = require('node:assert');

const { createSessionStore, MAGIC } = require('../js/auth/session-store');

// A reversible "encryption" mock: prefixes the text so we can assert the stored
// bytes are transformed (not raw tokens) while still being decryptable. Toggle
// `available` to simulate an OS without encryption support.
function makeSafeStorageMock(available) {
    return {
        _available: available !== false,
        isEncryptionAvailable() { return this._available; },
        encryptString(str) {
            // Return a Buffer whose contents are NOT the plaintext (reversed +
            // tagged), to model opaque ciphertext.
            return Buffer.from('ENC:' + Buffer.from(str, 'utf8').toString('base64'), 'utf8');
        },
        decryptString(buf) {
            const s = buf.toString('utf8');
            if (!s.startsWith('ENC:')) throw new Error('cannot decrypt');
            return Buffer.from(s.slice(4), 'base64').toString('utf8');
        }
    };
}

// Minimal in-memory fs matching the subset the store uses.
function makeFsMock() {
    const files = new Map();
    return {
        files,
        existsSync(p) { return files.has(p); },
        readFileSync(p) {
            if (!files.has(p)) throw new Error('ENOENT');
            return files.get(p);
        },
        writeFileSync(p, data) { files.set(p, data); },
        unlinkSync(p) { files.delete(p); }
    };
}

const PATH = '/fake/userData/session.enc';
const SAMPLE = {
    access_token: 'at_abc',
    refresh_token: 'rt_def',
    expires_at: 1999999999,
    user: { email: 'user@example.com', id: 'uid_1' }
};

test('set then get round-trips the session fields', () => {
    const store = createSessionStore({ safeStorage: makeSafeStorageMock(), fs: makeFsMock(), filePath: PATH });
    assert.deepStrictEqual(store.setSession(SAMPLE), { ok: true });
    const got = store.getSession();
    assert.strictEqual(got.access_token, 'at_abc');
    assert.strictEqual(got.refresh_token, 'rt_def');
    assert.strictEqual(got.user.email, 'user@example.com');
});

test('bytes on disk are ciphertext, not readable plaintext tokens', () => {
    const fs = makeFsMock();
    const store = createSessionStore({ safeStorage: makeSafeStorageMock(), fs, filePath: PATH });
    store.setSession(SAMPLE);
    const onDisk = fs.files.get(PATH).toString('utf8');
    assert.ok(!onDisk.includes('at_abc'), 'access token must not appear in plaintext');
    assert.ok(!onDisk.includes('rt_def'), 'refresh token must not appear in plaintext');
    assert.ok(onDisk.startsWith('ENC:'), 'stored bytes should be the encrypted envelope');
});

test('refuses to write when encryption is unavailable (never plaintext)', () => {
    const fs = makeFsMock();
    const store = createSessionStore({ safeStorage: makeSafeStorageMock(false), fs, filePath: PATH });
    const res = store.setSession(SAMPLE);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'encryption-unavailable');
    assert.strictEqual(fs.files.has(PATH), false, 'nothing should be written');
});

test('getSession returns null when encryption is unavailable', () => {
    const fs = makeFsMock();
    // Pre-seed a file as if written earlier.
    fs.files.set(PATH, Buffer.from('ENC:whatever', 'utf8'));
    const store = createSessionStore({ safeStorage: makeSafeStorageMock(false), fs, filePath: PATH });
    assert.strictEqual(store.getSession(), null);
});

test('clearSession removes the file; get after clear is null', () => {
    const fs = makeFsMock();
    const store = createSessionStore({ safeStorage: makeSafeStorageMock(), fs, filePath: PATH });
    store.setSession(SAMPLE);
    assert.strictEqual(fs.files.has(PATH), true);
    assert.deepStrictEqual(store.clearSession(), { ok: true });
    assert.strictEqual(fs.files.has(PATH), false);
    assert.strictEqual(store.getSession(), null);
});

test('corrupt/foreign blob yields null and is cleaned up', () => {
    const fs = makeFsMock();
    // Decryptable but wrong magic -> treated as foreign.
    const safe = makeSafeStorageMock();
    fs.files.set(PATH, safe.encryptString(JSON.stringify({ magic: 'someone-else', session: SAMPLE })));
    const store = createSessionStore({ safeStorage: safe, fs, filePath: PATH });
    assert.strictEqual(store.getSession(), null);
    assert.strictEqual(fs.files.has(PATH), false, 'foreign blob should be cleared');
});

test('undecryptable bytes yield null and are cleaned up', () => {
    const fs = makeFsMock();
    fs.files.set(PATH, Buffer.from('not-our-prefix garbage', 'utf8'));
    const store = createSessionStore({ safeStorage: makeSafeStorageMock(), fs, filePath: PATH });
    assert.strictEqual(store.getSession(), null);
    assert.strictEqual(fs.files.has(PATH), false);
});

test('invalid session (missing tokens) is rejected and nothing is written', () => {
    const fs = makeFsMock();
    const store = createSessionStore({ safeStorage: makeSafeStorageMock(), fs, filePath: PATH });
    assert.strictEqual(store.setSession({ access_token: 'only_access' }).ok, false);
    assert.strictEqual(store.setSession(null).reason, 'invalid-session');
    assert.strictEqual(fs.files.size, 0);
});

test('MAGIC envelope is used (sanity)', () => {
    const fs = makeFsMock();
    const safe = makeSafeStorageMock();
    const store = createSessionStore({ safeStorage: safe, fs, filePath: PATH });
    store.setSession(SAMPLE);
    const decoded = JSON.parse(safe.decryptString(fs.files.get(PATH)));
    assert.strictEqual(decoded.magic, MAGIC);
});
