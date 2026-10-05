// Unit tests for the auth state machine (js/auth/auth-state.js).
//
// These are pure, no-network tests: a fake auth client is injected so we can
// drive every transition deterministically.
//   - request OTP -> otpSent
//   - verify success -> loggedIn (+ session persisted via hook)
//   - verify failure -> back to otpSent (so the user can retry)
//   - logout -> loggedOut (+ session cleared via hook)
//   - restoreSession -> loggedIn without the OTP flow
//
// Uses the built-in node:test runner (no extra dependency).

const test = require('node:test');
const assert = require('node:assert');

const { createAuthState, STATES } = require('../js/auth/auth-state');

// A controllable fake auth client. Each method resolves by default; set
// `failVerify` to make verifyOtp reject (simulating a bad/expired code).
function makeFakeClient(opts) {
    opts = opts || {};
    const calls = { requestOtp: [], verifyOtp: [], signOut: 0 };
    return {
        calls,
        async requestOtp(email) {
            calls.requestOtp.push(email);
            if (opts.failRequest) throw new Error('send failed');
        },
        async verifyOtp(email, code) {
            calls.verifyOtp.push({ email, code });
            if (opts.failVerify) throw new Error('invalid code');
            return {
                session: { access_token: 'at_123', refresh_token: 'rt_456' },
                user: { email: email }
            };
        },
        async signOut() {
            calls.signOut++;
        }
    };
}

test('starts logged out', () => {
    const auth = createAuthState({ client: makeFakeClient() });
    assert.strictEqual(auth.getState(), STATES.LOGGED_OUT);
    assert.strictEqual(auth.snapshot().isLoggedIn, false);
});

test('requestOtp transitions loggedOut -> otpSent and records the email', async () => {
    const client = makeFakeClient();
    const auth = createAuthState({ client });
    await auth.requestOtp('  User@Example.com ');
    assert.strictEqual(auth.getState(), STATES.OTP_SENT);
    // Email is normalized (trimmed + lowercased).
    assert.strictEqual(auth.getEmail(), 'user@example.com');
    assert.deepStrictEqual(client.calls.requestOtp, ['user@example.com']);
});

test('requestOtp rejects an invalid email without calling the client', async () => {
    const client = makeFakeClient();
    const auth = createAuthState({ client });
    await assert.rejects(() => auth.requestOtp('not-an-email'));
    assert.strictEqual(auth.getState(), STATES.LOGGED_OUT);
    assert.strictEqual(client.calls.requestOtp.length, 0);
    assert.match(auth.snapshot().error, /valid email/i);
});

test('verify success -> loggedIn and persists the session via the hook', async () => {
    let persisted = null;
    const client = makeFakeClient();
    const auth = createAuthState({
        client,
        onSessionPersist: (s) => { persisted = s; }
    });
    await auth.requestOtp('user@example.com');
    const snap = await auth.verifyCode('123456');
    assert.strictEqual(auth.getState(), STATES.LOGGED_IN);
    assert.strictEqual(snap.isLoggedIn, true);
    assert.strictEqual(auth.getSession().access_token, 'at_123');
    assert.ok(persisted, 'onSessionPersist should have been called');
    assert.strictEqual(persisted.refresh_token, 'rt_456');
});

test('verify failure -> back to otpSent so the user can retry', async () => {
    const client = makeFakeClient({ failVerify: true });
    const auth = createAuthState({ client });
    await auth.requestOtp('user@example.com');
    await assert.rejects(() => auth.verifyCode('000000'));
    assert.strictEqual(auth.getState(), STATES.OTP_SENT);
    assert.match(auth.snapshot().error, /invalid code/i);
});

test('verifyCode before requesting a code is rejected', async () => {
    const auth = createAuthState({ client: makeFakeClient() });
    await assert.rejects(() => auth.verifyCode('123456'));
    assert.strictEqual(auth.getState(), STATES.LOGGED_OUT);
});

test('logout -> loggedOut, clears session and calls both client.signOut and the clear hook', async () => {
    let cleared = false;
    const client = makeFakeClient();
    const auth = createAuthState({
        client,
        onSessionClear: () => { cleared = true; }
    });
    await auth.requestOtp('user@example.com');
    await auth.verifyCode('123456');
    assert.strictEqual(auth.getState(), STATES.LOGGED_IN);

    await auth.logout();
    assert.strictEqual(auth.getState(), STATES.LOGGED_OUT);
    assert.strictEqual(auth.getEmail(), null);
    assert.strictEqual(auth.getSession(), null);
    assert.strictEqual(client.calls.signOut, 1);
    assert.strictEqual(cleared, true);
});

test('restoreSession -> loggedIn without the OTP flow', () => {
    const auth = createAuthState({ client: makeFakeClient() });
    const ok = auth.restoreSession({
        access_token: 'stored_at',
        refresh_token: 'stored_rt',
        user: { email: 'restored@example.com' }
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(auth.getState(), STATES.LOGGED_IN);
    assert.strictEqual(auth.getEmail(), 'restored@example.com');
});

test('restoreSession with no valid token stays logged out', () => {
    const auth = createAuthState({ client: makeFakeClient() });
    assert.strictEqual(auth.restoreSession(null), false);
    assert.strictEqual(auth.restoreSession({}), false);
    assert.strictEqual(auth.getState(), STATES.LOGGED_OUT);
});

test('updateSession replaces the session while logged in and re-persists', async () => {
    const persists = [];
    const auth = createAuthState({
        client: makeFakeClient(),
        onSessionPersist: (s) => persists.push(s)
    });
    await auth.requestOtp('user@example.com');
    await auth.verifyCode('123456');
    const ok = auth.updateSession({ access_token: 'new_at', refresh_token: 'new_rt' });
    assert.strictEqual(ok, true);
    assert.strictEqual(auth.getSession().access_token, 'new_at');
    // persisted once on verify, once on update.
    assert.strictEqual(persists.length, 2);
});

test('subscribe fires immediately and on every change; unsubscribe stops it', async () => {
    const auth = createAuthState({ client: makeFakeClient() });
    const seen = [];
    const unsub = auth.subscribe((snap) => seen.push(snap.state));
    assert.deepStrictEqual(seen, [STATES.LOGGED_OUT]); // immediate fire
    await auth.requestOtp('user@example.com');
    assert.strictEqual(seen[seen.length - 1], STATES.OTP_SENT);
    unsub();
    await auth.verifyCode('123456');
    // No new entries after unsubscribe.
    assert.strictEqual(seen[seen.length - 1], STATES.OTP_SENT);
});
