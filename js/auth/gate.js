// ===== Online-feature gate =====
//
// Declarative gating: any element marked [data-requires-auth] is "locked" while
// the user is signed OUT and revealed when signed IN. Locking overlays a small
// "Sign in to use" panel (clicking it opens the login modal) and visually dims
// the content behind it (see css/auth.css: .auth-gated / .auth-lock-overlay).
//
// Local features are never marked, so they always work regardless of login.
//
// The pure lock/unlock DECISION lives in shouldLock(snapshot) so it can be unit
// tested without a DOM. applyGate() does the DOM mutation. installGate() wires
// everything to a shared authState and returns a teardown function.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api; // Node / tests
    }
    if (typeof window !== 'undefined') {
        window.AuthGate = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // The single source of truth for the gate decision: lock when NOT logged in.
    // Accepts an authState snapshot ({ isLoggedIn, state, ... }).
    function shouldLock(snapshot) {
        return !(snapshot && snapshot.isLoggedIn === true);
    }

    // Build the lock overlay element. `onSignIn` is called when its button is
    // clicked. Kept as a factory so tests can inject a fake document.
    function buildOverlay(doc, onSignIn) {
        const overlay = doc.createElement('div');
        overlay.className = 'auth-lock-overlay';
        overlay.innerHTML =
            '<div class="auth-lock-icon" aria-hidden="true">&#128274;</div>' +
            '<div class="auth-lock-text">Sign in to use this</div>' +
            '<button type="button" class="btn btn-primary btn-small auth-lock-btn">Sign in</button>';
        const btn = overlay.querySelector('.auth-lock-btn');
        if (btn && typeof onSignIn === 'function') {
            btn.addEventListener('click', onSignIn);
        }
        return overlay;
    }

    // Lock or unlock a single element to match `locked`. Idempotent: adds the
    // overlay once, removes it when unlocked.
    function applyGateToEl(doc, el, locked, onSignIn) {
        if (!el) return;
        const existing = el.querySelector(':scope > .auth-lock-overlay');
        if (locked) {
            el.classList.add('auth-gated');
            if (!existing) {
                el.appendChild(buildOverlay(doc, onSignIn));
            }
        } else {
            el.classList.remove('auth-gated');
            if (existing && existing.parentNode === el) {
                el.removeChild(existing);
            }
        }
    }

    // Apply the gate to all [data-requires-auth] elements for a given snapshot.
    function applyGate(doc, snapshot, onSignIn) {
        const locked = shouldLock(snapshot);
        const els = doc.querySelectorAll('[data-requires-auth]');
        els.forEach((el) => applyGateToEl(doc, el, locked, onSignIn));
        return locked;
    }

    // Wire the gate to a shared authState. `deps`:
    //   authState: the shared auth state (must expose subscribe())
    //   doc:       document (defaults to window.document)
    //   onSignIn:  called when a lock's Sign in button is clicked
    //              (defaults to window.openAuthModal)
    // Returns a teardown function that unsubscribes.
    function installGate(deps) {
        deps = deps || {};
        const authState = deps.authState;
        const doc = deps.doc || (typeof document !== 'undefined' ? document : null);
        const onSignIn = deps.onSignIn || (typeof window !== 'undefined' ? window.openAuthModal : null);
        if (!authState || !doc) return function () {};

        const unsubscribe = authState.subscribe((snap) => {
            applyGate(doc, snap, onSignIn);
        });
        return unsubscribe;
    }

    return { shouldLock, applyGate, applyGateToEl, buildOverlay, installGate };
});
