// ===== Auth UI (renderer) =====
//
// Wires everything together for the user-facing account experience:
//   - builds the single shared authState (js/auth/auth-state.js), injecting the
//     Supabase client (js/auth/supabase-client.js) and the main-process session
//     persistence hooks (window.electronAPI.authSetSession / authClearSession).
//   - renders the two-step email-OTP login modal (email -> code), with resend,
//     error states, and a signed-in view (shows email + Log out).
//   - keeps the nav "Account" button and the "Online" tab label in sync.
//
// The shared authState is published as window.intentionAuth so the gate module
// (js/auth/gate.js) and anything else can subscribe to the same source of truth.
// Session RESTORE on launch + token-refresh re-persistence are added in a later
// step; this file focuses on the interactive sign-in/out flow.

(function () {
    'use strict';

    const client = window.SupabaseClient || null;

    // Persist the session to the main process (encrypted via safeStorage).
    // No-op outside Electron (plain browser) so the UI still works for demos.
    async function persistSession(session) {
        if (window.electronAPI && typeof window.electronAPI.authSetSession === 'function') {
            try { return await window.electronAPI.authSetSession(session); }
            catch (_) { /* best effort */ }
        }
    }
    async function clearStoredSession() {
        if (window.electronAPI && typeof window.electronAPI.authClearSession === 'function') {
            try { return await window.electronAPI.authClearSession(); }
            catch (_) {}
        }
    }

    // Build the one shared auth state for the whole renderer.
    const authState = window.AuthState.createAuthState({
        client: client,
        onSessionPersist: persistSession,
        onSessionClear: clearStoredSession
    });

    // Publish it so other modules (gate, future online features) share it.
    window.intentionAuth = authState;

    // Keep the signed-in email from the SDK's refreshed tokens persisted too.
    if (client && typeof client.onTokenRefresh === 'function') {
        client.onTokenRefresh((session) => {
            authState.updateSession(session);
        });
    }

    // ----- Nav button + Online label sync -----
    const navAccountBtn = document.getElementById('nav-account');
    const navAccountLabel = document.getElementById('nav-account-label');

    function renderNav(snap) {
        if (navAccountLabel) {
            navAccountLabel.textContent = snap.isLoggedIn
                ? (snap.email || 'Account')
                : 'Sign in';
        }
        if (navAccountBtn) {
            navAccountBtn.classList.toggle('is-signed-in', snap.isLoggedIn);
        }
    }
    authState.subscribe(renderNav);

    // ----- Login modal -----
    let modalEl = null;

    function closeModal() {
        if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
        modalEl = null;
    }

    // Open the account modal. If already signed in, it shows the account view;
    // otherwise it starts at the email step (or the code step if a code was
    // already sent in this session).
    function openModal() {
        closeModal();
        modalEl = document.createElement('div');
        modalEl.className = 'cw-modal auth-modal';
        document.body.appendChild(modalEl);

        // Dismiss on backdrop click / Escape.
        modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
        modalEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

        renderModal(authState.snapshot());
    }

    // Re-render the modal body for the current snapshot. Subscribing while the
    // modal is open keeps it reactive (e.g. loggingIn spinner -> loggedIn).
    function renderModal(snap) {
        if (!modalEl) return;

        if (!client || !client.isConfigured || !client.isConfigured()) {
            modalEl.innerHTML = notConfiguredHtml();
            modalEl.querySelector('#auth-close').addEventListener('click', closeModal);
            return;
        }

        if (snap.isLoggedIn) {
            modalEl.innerHTML = signedInHtml(snap);
            modalEl.querySelector('#auth-close').addEventListener('click', closeModal);
            modalEl.querySelector('#auth-logout').addEventListener('click', async () => {
                await authState.logout();
                closeModal();
            });
            return;
        }

        const atCodeStep = snap.state === window.AuthState.STATES.OTP_SENT
            || snap.state === window.AuthState.STATES.LOGGING_IN;

        if (atCodeStep) {
            renderCodeStep(snap);
        } else {
            renderEmailStep(snap);
        }
    }

    // Step 1: email entry.
    function renderEmailStep(snap) {
        modalEl.innerHTML = `
            <div class="cw-modal-content auth-content">
                <h3>Sign in to Intention</h3>
                <p class="auth-hint">We'll email you a one-time code. No password needed.</p>
                <div class="cw-field">
                    <label for="auth-email">Email</label>
                    <input type="email" id="auth-email" placeholder="you@example.com" autocomplete="email"
                           value="${escapeAttr(snap.email || '')}">
                </div>
                ${errorHtml(snap.error)}
                <div class="cw-modal-actions">
                    <button class="btn btn-ghost btn-small" id="auth-cancel">Cancel</button>
                    <button class="btn btn-primary btn-small" id="auth-send">Send code</button>
                </div>
            </div>`;
        const emailInput = modalEl.querySelector('#auth-email');
        setTimeout(() => emailInput.focus(), 0);

        const send = async () => {
            const btn = modalEl.querySelector('#auth-send');
            btn.disabled = true;
            try { await authState.requestOtp(emailInput.value); }
            catch (_) { /* error shown via snapshot */ }
            finally { if (btn) btn.disabled = false; }
            renderModal(authState.snapshot());
        };
        modalEl.querySelector('#auth-send').addEventListener('click', send);
        modalEl.querySelector('#auth-cancel').addEventListener('click', closeModal);
        emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    }

    // Step 2: code entry.
    function renderCodeStep(snap) {
        const verifying = snap.state === window.AuthState.STATES.LOGGING_IN;
        modalEl.innerHTML = `
            <div class="cw-modal-content auth-content">
                <h3>Enter your code</h3>
                <p class="auth-hint">We sent a 6-digit code to <strong>${escapeHtml(snap.email || '')}</strong>.</p>
                <div class="cw-field">
                    <label for="auth-code">6-digit code</label>
                    <input type="text" id="auth-code" inputmode="numeric" autocomplete="one-time-code"
                           maxlength="6" placeholder="123456" ${verifying ? 'disabled' : ''}>
                </div>
                ${errorHtml(snap.error)}
                <div class="cw-modal-actions auth-actions-code">
                    <button class="btn btn-ghost btn-small" id="auth-back">Back</button>
                    <button class="btn btn-ghost btn-small" id="auth-resend">Resend</button>
                    <button class="btn btn-primary btn-small" id="auth-verify" ${verifying ? 'disabled' : ''}>
                        ${verifying ? 'Verifying…' : 'Verify'}
                    </button>
                </div>
            </div>`;
        const codeInput = modalEl.querySelector('#auth-code');
        if (codeInput && !verifying) setTimeout(() => codeInput.focus(), 0);

        const verify = async () => {
            try { await authState.verifyCode(codeInput.value); }
            catch (_) { /* error shown via snapshot */ }
            renderModal(authState.snapshot());
        };
        modalEl.querySelector('#auth-verify').addEventListener('click', verify);
        modalEl.querySelector('#auth-resend').addEventListener('click', async () => {
            try { await authState.requestOtp(snap.email); } catch (_) {}
            renderModal(authState.snapshot());
        });
        modalEl.querySelector('#auth-back').addEventListener('click', () => {
            // Return to the email step without losing the typed address.
            renderEmailStep(authState.snapshot());
        });
        if (codeInput) {
            codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });
        }
    }

    function signedInHtml(snap) {
        return `
            <div class="cw-modal-content auth-content">
                <h3>Your account</h3>
                <p class="auth-hint">Signed in as <strong>${escapeHtml(snap.email || '')}</strong>.</p>
                <p class="auth-hint">Online features are unlocked. Local features work with or without an account.</p>
                <div class="cw-modal-actions">
                    <button class="btn btn-ghost btn-small cw-delete" id="auth-logout">Log out</button>
                    <button class="btn btn-primary btn-small" id="auth-close">Done</button>
                </div>
            </div>`;
    }

    function notConfiguredHtml() {
        return `
            <div class="cw-modal-content auth-content">
                <h3>Accounts aren't set up yet</h3>
                <p class="auth-hint">
                    To enable sign-in, add your Supabase project URL and anon key in
                    <code>js/auth/supabase-config.js</code>, then enable Email OTP in your
                    Supabase project. Local features work without an account.
                </p>
                <div class="cw-modal-actions">
                    <button class="btn btn-primary btn-small" id="auth-close">Got it</button>
                </div>
            </div>`;
    }

    function errorHtml(err) {
        if (!err) return '';
        return `<p class="auth-error" role="alert">${escapeHtml(err)}</p>`;
    }

    // While the modal is open, keep it reactive to state changes.
    authState.subscribe((snap) => { if (modalEl) renderModal(snap); });

    // Nav "Account" button opens the modal.
    if (navAccountBtn) {
        navAccountBtn.addEventListener('click', openModal);
    }

    // Expose openModal so the gate's "Sign in to use" button can call it.
    window.openAuthModal = openModal;

    // ----- Restore a stored session on launch -----
    // Ask the main process (safeStorage) for any previously stored session. If
    // present, adopt it into the Supabase client so it can auto-refresh, then
    // flip authState to loggedIn. If the stored refresh token is stale/revoked,
    // adopting it fails and we stay logged out (and clear the dead session).
    async function restoreSessionOnLaunch() {
        if (!(window.electronAPI && typeof window.electronAPI.authGetSession === 'function')) {
            return; // not in Electron (e.g. plain-browser demo)
        }
        let stored = null;
        try {
            const res = await window.electronAPI.authGetSession();
            stored = res && res.session ? res.session : null;
        } catch (_) {
            return;
        }
        if (!stored || !stored.access_token || !stored.refresh_token) return;

        // Let the SDK adopt the tokens so future refreshes work. If the client
        // isn't configured, we still restore the UI state optimistically.
        if (client && typeof client.setSession === 'function') {
            try {
                const refreshed = await client.setSession(stored);
                // Prefer the (possibly refreshed) session the SDK hands back.
                if (refreshed && refreshed.access_token) {
                    authState.restoreSession(refreshed);
                    // Re-persist in case the token was refreshed during adopt.
                    persistSession(refreshed);
                    return;
                }
            } catch (_) {
                // Adoption failed (stale/revoked). Clear and stay logged out.
                clearStoredSession();
                return;
            }
        }
        // Fallback: restore from the stored session as-is.
        authState.restoreSession(stored);
    }

    // Kick off restore after the current tick so all subscribers are wired.
    restoreSessionOnLaunch();

    // ----- small escaping helpers -----
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }
    function escapeAttr(str) {
        return escapeHtml(str).replace(/"/g, '&quot;');
    }
})();
