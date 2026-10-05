// ===== Auth State =====
//
// A tiny, framework-free state machine that is the single source of truth for
// whether the user is signed into their Intention account. The gating UI and
// login screen both subscribe to it, so they never disagree about the user's
// status.
//
// It is deliberately decoupled from Electron AND from the Supabase SDK: the
// auth client is INJECTED (see createAuthState), so this module can be unit
// tested in plain Node with a fake client. In the renderer we inject the real
// Supabase-backed client (js/auth/supabase-client.js).
//
// States:
//   loggedOut  - no account session
//   otpSent    - a one-time code has been emailed; waiting for the user to enter it
//   loggingIn  - verifying the entered code (transient)
//   loggedIn   - verified; a session exists (email is known)
//
// The client passed in must implement:
//   requestOtp(email)        -> Promise (sends the code email)
//   verifyOtp(email, code)   -> Promise<{ session, user }>  (throws on bad code)
//   signOut()                -> Promise (optional; best-effort)
//
// `onSessionPersist(session)` / `onSessionClear()` are optional hooks the
// renderer uses to push the session to the main process (safeStorage) and to
// clear it on logout. They are not called during tests unless provided.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api; // Node / tests
    }
    // Expose on window for the renderer (plain <script> include, no bundler).
    if (typeof window !== 'undefined') {
        window.AuthState = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const STATES = Object.freeze({
        LOGGED_OUT: 'loggedOut',
        OTP_SENT: 'otpSent',
        LOGGING_IN: 'loggingIn',
        LOGGED_IN: 'loggedIn'
    });

    function createAuthState(options) {
        options = options || {};
        const client = options.client || null;
        const onSessionPersist = typeof options.onSessionPersist === 'function'
            ? options.onSessionPersist
            : null;
        const onSessionClear = typeof options.onSessionClear === 'function'
            ? options.onSessionClear
            : null;

        // Internal state. `email` is the address a code was sent to / the
        // signed-in account. `session` holds the provider session when logged
        // in. `error` carries the last human-readable error (e.g. bad code).
        let state = STATES.LOGGED_OUT;
        let email = null;
        let session = null;
        let error = null;

        const listeners = new Set();

        function snapshot() {
            return {
                state,
                email,
                error,
                isLoggedIn: state === STATES.LOGGED_IN,
                // Expose a shallow copy so subscribers can't mutate internals.
                session: session ? Object.assign({}, session) : null
            };
        }

        function emit() {
            const snap = snapshot();
            listeners.forEach((fn) => {
                try { fn(snap); } catch (_) { /* a bad listener must not break others */ }
            });
        }

        function subscribe(fn) {
            if (typeof fn !== 'function') return function () {};
            listeners.add(fn);
            // Fire immediately so late subscribers get the current state.
            try { fn(snapshot()); } catch (_) {}
            return function unsubscribe() { listeners.delete(fn); };
        }

        // Normalize an email so "A@B.com " and "a@b.com" are treated the same.
        function normEmail(raw) {
            return String(raw == null ? '' : raw).trim().toLowerCase();
        }

        // Step 1: ask the provider to email a one-time code. On success we move
        // to otpSent and remember the email so verifyCode doesn't need it again.
        async function requestOtp(rawEmail) {
            const e = normEmail(rawEmail);
            if (!e || e.indexOf('@') === -1) {
                error = 'Enter a valid email address.';
                emit();
                throw new Error(error);
            }
            if (!client || typeof client.requestOtp !== 'function') {
                error = 'Auth client is not configured.';
                emit();
                throw new Error(error);
            }
            error = null;
            try {
                await client.requestOtp(e);
            } catch (err) {
                error = (err && err.message) ? err.message : 'Could not send the code. Try again.';
                emit();
                throw err;
            }
            email = e;
            state = STATES.OTP_SENT;
            emit();
            return true;
        }

        // Step 2: verify the entered code. Transitions through loggingIn, then
        // either loggedIn (success) or back to otpSent (failure, so the user can
        // retry or resend). On success we persist the session via the hook.
        async function verifyCode(rawCode) {
            const code = String(rawCode == null ? '' : rawCode).trim();
            if (state !== STATES.OTP_SENT && state !== STATES.LOGGING_IN) {
                error = 'Request a code first.';
                emit();
                throw new Error(error);
            }
            if (!code) {
                error = 'Enter the code from your email.';
                emit();
                throw new Error(error);
            }
            if (!client || typeof client.verifyOtp !== 'function') {
                error = 'Auth client is not configured.';
                emit();
                throw new Error(error);
            }

            error = null;
            state = STATES.LOGGING_IN;
            emit();

            let result;
            try {
                result = await client.verifyOtp(email, code);
            } catch (err) {
                // Bad/expired code: fall back to otpSent so the user can retry.
                error = (err && err.message) ? err.message : 'That code didn\'t work. Try again.';
                state = STATES.OTP_SENT;
                emit();
                throw err;
            }

            session = (result && result.session) ? result.session : null;
            if (!session) {
                error = 'Verification succeeded but no session was returned.';
                state = STATES.OTP_SENT;
                emit();
                throw new Error(error);
            }

            // Prefer the verified user's email from the provider if present.
            if (result.user && result.user.email) {
                email = normEmail(result.user.email);
            }

            state = STATES.LOGGED_IN;
            emit();

            if (onSessionPersist) {
                try { await onSessionPersist(session); } catch (_) { /* persistence is best-effort */ }
            }
            return snapshot();
        }

        // Restore a previously stored session (called on launch). Skips the OTP
        // flow entirely. A falsy/invalid session leaves us logged out.
        function restoreSession(restored) {
            if (!restored || !restored.access_token) {
                return false;
            }
            session = restored;
            email = normEmail(
                (restored.user && restored.user.email) || restored.email || email || ''
            ) || null;
            error = null;
            state = STATES.LOGGED_IN;
            emit();
            return true;
        }

        // Replace the current session in place (e.g. after a silent token
        // refresh). Only meaningful while logged in; re-persists via the hook.
        function updateSession(next) {
            if (state !== STATES.LOGGED_IN || !next) return false;
            session = next;
            emit();
            if (onSessionPersist) {
                try { onSessionPersist(session); } catch (_) {}
            }
            return true;
        }

        // Log out: clear local state and best-effort clear the provider +
        // stored session. Always ends in loggedOut even if remote clearing fails.
        async function logout() {
            if (client && typeof client.signOut === 'function') {
                try { await client.signOut(); } catch (_) { /* best effort */ }
            }
            state = STATES.LOGGED_OUT;
            email = null;
            session = null;
            error = null;
            emit();
            if (onSessionClear) {
                try { await onSessionClear(); } catch (_) {}
            }
            return true;
        }

        return {
            STATES,
            subscribe,
            snapshot,
            getState: function () { return state; },
            getEmail: function () { return email; },
            getSession: function () { return session ? Object.assign({}, session) : null; },
            requestOtp,
            verifyCode,
            restoreSession,
            updateSession,
            logout
        };
    }

    return { createAuthState, STATES };
});
