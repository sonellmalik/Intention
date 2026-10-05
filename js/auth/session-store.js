// ===== Secure session store (main process) =====
//
// Persists the user's account session (Supabase access + refresh tokens) to
// disk, ENCRYPTED via Electron's safeStorage (OS keychain / DPAPI). The
// renderer never stores these tokens; it hands them here over IPC.
//
// Security rules enforced here:
//   - We only ever write ciphertext. If OS-level encryption is unavailable
//     (safeStorage.isEncryptionAvailable() === false), we REFUSE to write and
//     report it, rather than silently falling back to plaintext on disk.
//   - On read, anything we can't decrypt is treated as "no session" and the
//     file is cleared, so a corrupt/foreign blob can't wedge login.
//
// The Electron bits (safeStorage, fs, the file path) are INJECTED via
// createSessionStore(deps) so this module is unit-testable in plain Node with
// mocks. main.js builds a real instance from electron's safeStorage + node fs.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // A small on-disk envelope so we can recognize our own files and version
    // the format if it ever changes.
    const MAGIC = 'intention-session-v1';

    // Keep only the fields we need to restore + refresh a session. We avoid
    // persisting anything we don't use.
    function pickSessionFields(session) {
        if (!session || typeof session !== 'object') return null;
        const out = {
            access_token: session.access_token || null,
            refresh_token: session.refresh_token || null,
            expires_at: session.expires_at || null,
            token_type: session.token_type || 'bearer'
        };
        if (session.user && (session.user.email || session.user.id)) {
            out.user = { email: session.user.email || null, id: session.user.id || null };
        }
        if (!out.access_token || !out.refresh_token) return null;
        return out;
    }

    // deps: { safeStorage, fs, filePath }
    //   safeStorage: Electron safeStorage (isEncryptionAvailable, encryptString,
    //                decryptString)
    //   fs:          node:fs (existsSync, readFileSync, writeFileSync, unlinkSync)
    //   filePath:    absolute path of the encrypted session file
    function createSessionStore(deps) {
        deps = deps || {};
        const safeStorage = deps.safeStorage;
        const fs = deps.fs;
        const filePath = deps.filePath;

        function encryptionAvailable() {
            try {
                return !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());
            } catch (_) {
                return false;
            }
        }

        // Persist a session. Returns { ok, reason }. Refuses to write plaintext.
        function setSession(session) {
            const picked = pickSessionFields(session);
            if (!picked) {
                return { ok: false, reason: 'invalid-session' };
            }
            if (!encryptionAvailable()) {
                // Never write tokens in the clear. The caller surfaces this.
                return { ok: false, reason: 'encryption-unavailable' };
            }
            try {
                const envelope = JSON.stringify({ magic: MAGIC, session: picked });
                const cipher = safeStorage.encryptString(envelope); // Buffer
                fs.writeFileSync(filePath, cipher);
                return { ok: true };
            } catch (err) {
                return { ok: false, reason: 'write-failed', error: err && err.message };
            }
        }

        // Read + decrypt the stored session. Returns the session object or null.
        // A missing/corrupt/foreign file yields null (and is cleaned up).
        function getSession() {
            try {
                if (!fs.existsSync(filePath)) return null;
                if (!encryptionAvailable()) return null;
                const cipher = fs.readFileSync(filePath);
                const plain = safeStorage.decryptString(cipher);
                const parsed = JSON.parse(plain);
                if (!parsed || parsed.magic !== MAGIC) {
                    clearSession();
                    return null;
                }
                return pickSessionFields(parsed.session);
            } catch (_) {
                // Corrupt or undecryptable: clear it so login isn't stuck.
                clearSession();
                return null;
            }
        }

        // Remove the stored session (logout). Idempotent.
        function clearSession() {
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                return { ok: true };
            } catch (err) {
                return { ok: false, reason: 'delete-failed', error: err && err.message };
            }
        }

        return {
            setSession,
            getSession,
            clearSession,
            encryptionAvailable,
            // exposed for tests/diagnostics
            _pickSessionFields: pickSessionFields,
            _filePath: filePath
        };
    }

    return { createSessionStore, pickSessionFields, MAGIC };
});
