// Unit tests for the online-feature gate (js/auth/gate.js).
//
// We test the pure decision (shouldLock) and the DOM-apply logic against a
// tiny fake document/element so no browser is needed. We also drive it through
// the shared authState to confirm it locks when logged out and unlocks when
// logged in (and re-locks on logout).

const test = require('node:test');
const assert = require('node:assert');

const gate = require('../js/auth/gate');
const { createAuthState } = require('../js/auth/auth-state');

// ----- Minimal fake DOM -----
// Enough of the Element/Document surface for gate.js: classList, children,
// querySelector(':scope > .auth-lock-overlay'), querySelectorAll, appendChild,
// removeChild, createElement, innerHTML (parsed shallowly as one overlay node).
function makeEl(attrs) {
    attrs = attrs || {};
    const classSet = new Set();
    const el = {
        _attrs: attrs,
        children: [],
        parentNode: null,
        className: '',
        _innerHTML: '',
        classList: {
            add: (c) => { classSet.add(c); el._syncClass(); },
            remove: (c) => { classSet.delete(c); el._syncClass(); },
            contains: (c) => classSet.has(c)
        },
        _syncClass() { this.className = Array.from(classSet).join(' '); },
        set innerHTML(v) { this._innerHTML = v; },
        get innerHTML() { return this._innerHTML; },
        appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
        removeChild(child) {
            const i = el.children.indexOf(child);
            if (i >= 0) { el.children.splice(i, 1); child.parentNode = null; }
            return child;
        },
        // Only the overlay query is used by gate.js.
        querySelector(sel) {
            if (sel.indexOf('auth-lock-overlay') !== -1) {
                return el.children.find((c) => c.className && c.className.indexOf('auth-lock-overlay') !== -1) || null;
            }
            if (sel.indexOf('auth-lock-btn') !== -1) {
                return el._btn || null;
            }
            return null;
        },
        hasClass(c) { return classSet.has(c); }
    };
    return el;
}

function makeDoc(gatedEls) {
    return {
        createElement() {
            const node = makeEl();
            // The overlay's innerHTML includes a button; expose a fake button
            // that supports addEventListener so buildOverlay can wire it.
            node._btn = { addEventListener() {} };
            return node;
        },
        querySelectorAll(sel) {
            if (sel.indexOf('data-requires-auth') !== -1) return gatedEls;
            return [];
        }
    };
}

test('shouldLock: locked when logged out, unlocked when logged in', () => {
    assert.strictEqual(gate.shouldLock({ isLoggedIn: false }), true);
    assert.strictEqual(gate.shouldLock({ isLoggedIn: true }), false);
    assert.strictEqual(gate.shouldLock(null), true); // defensive default
});

test('applyGate locks a gated element when logged out (adds overlay + class)', () => {
    const el = makeEl({ 'data-requires-auth': true });
    const doc = makeDoc([el]);
    const locked = gate.applyGate(doc, { isLoggedIn: false });
    assert.strictEqual(locked, true);
    assert.strictEqual(el.hasClass('auth-gated'), true);
    assert.strictEqual(el.children.length, 1, 'overlay added once');
    assert.ok(el.children[0].className.indexOf('auth-lock-overlay') !== -1);
});

test('applyGate unlocks when logged in (removes overlay + class)', () => {
    const el = makeEl({ 'data-requires-auth': true });
    const doc = makeDoc([el]);
    gate.applyGate(doc, { isLoggedIn: false }); // lock first
    gate.applyGate(doc, { isLoggedIn: true });  // then unlock
    assert.strictEqual(el.hasClass('auth-gated'), false);
    assert.strictEqual(el.children.length, 0, 'overlay removed');
});

test('applyGate is idempotent: locking twice adds only one overlay', () => {
    const el = makeEl({ 'data-requires-auth': true });
    const doc = makeDoc([el]);
    gate.applyGate(doc, { isLoggedIn: false });
    gate.applyGate(doc, { isLoggedIn: false });
    assert.strictEqual(el.children.length, 1);
});

test('installGate wires authState: locks logged out, unlocks on login, re-locks on logout', async () => {
    const el = makeEl({ 'data-requires-auth': true });
    const doc = makeDoc([el]);

    // Fake auth client for the real authState.
    const client = {
        async requestOtp() {},
        async verifyOtp(email) {
            return { session: { access_token: 'a', refresh_token: 'r' }, user: { email } };
        },
        async signOut() {}
    };
    const auth = createAuthState({ client });

    const teardown = gate.installGate({ authState: auth, doc, onSignIn: null });

    // Immediately after install (logged out) -> locked.
    assert.strictEqual(el.hasClass('auth-gated'), true);

    // Log in -> unlocked.
    await auth.requestOtp('user@example.com');
    await auth.verifyCode('123456');
    assert.strictEqual(el.hasClass('auth-gated'), false);

    // Log out -> re-locked.
    await auth.logout();
    assert.strictEqual(el.hasClass('auth-gated'), true);

    teardown();
});
