// ===== Supabase-backed auth client =====
//
// A thin adapter around the Supabase JS SDK that exposes exactly the small
// interface js/auth/auth-state.js expects:
//     requestOtp(email)        -> Promise
//     verifyOtp(email, code)   -> Promise<{ session, user }>
//     signOut()                -> Promise
// plus a couple of renderer-only helpers:
//     setSession(session)      -> adopt a restored session (launch)
//     onTokenRefresh(cb)       -> re-persist tokens after a silent refresh
//     isConfigured()           -> whether real Supabase config is present
//
// Design notes:
//   - We DISABLE Supabase's own session persistence (persistSession:false) and
//     URL detection. The main process owns the stored session (safeStorage), so
//     the SDK must not also stash tokens in localStorage. We keep
//     autoRefreshToken ON so long-lived sessions stay valid, and forward
//     refreshed tokens to the renderer via onTokenRefresh so they get re-saved.
//   - The SDK global comes from the vendored UMD build (js/vendor/supabase.js),
//     which exposes `window.supabase` with a createClient() factory.
//
// This file is renderer-only (it needs the browser SDK + window), so it does
// not export for Node. The pure state machine is what the tests exercise.

(function () {
    'use strict';

    const cfg = (typeof window !== 'undefined' && window.SupabaseConfig) || null;

    // Locate the UMD global. The vendored build sets window.supabase to an
    // object exposing createClient.
    function getSdk() {
        return (typeof window !== 'undefined' && window.supabase) || null;
    }

    let _client = null;        // the Supabase client instance (lazy)
    let _refreshCbs = [];       // onTokenRefresh subscribers

    function isConfigured() {
        return !!(cfg && cfg.isConfigured && cfg.isConfigured());
    }

    // Lazily build the client the first time it's needed. Returns null when the
    // project isn't configured or the SDK failed to load, so callers can show a
    // friendly message instead of throwing.
    function getClient() {
        if (_client) return _client;
        if (!isConfigured()) return null;
        const sdk = getSdk();
        if (!sdk || typeof sdk.createClient !== 'function') return null;

        _client = sdk.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
            auth: {
                // The main process owns the stored session; don't let the SDK
                // also persist to localStorage or parse the URL.
                persistSession: false,
                autoRefreshToken: true,
                detectSessionInUrl: false
            }
        });

        // Forward refreshed tokens so the renderer can re-persist them.
        _client.auth.onAuthStateChange((event, session) => {
            if (event === 'TOKEN_REFRESHED' && session) {
                _refreshCbs.forEach((cb) => {
                    try { cb(session); } catch (_) {}
                });
            }
        });

        return _client;
    }

    // Step 1: email a one-time code. shouldCreateUser:true means a brand-new
    // email becomes an account on first verified login (passwordless sign-up).
    async function requestOtp(email) {
        const client = getClient();
        if (!client) throw new Error(configErrorMessage());
        const { error } = await client.auth.signInWithOtp({
            email: email,
            options: { shouldCreateUser: true }
        });
        if (error) throw new Error(error.message || 'Could not send the code.');
        return true;
    }

    // Step 2: verify the 6-digit code. On success Supabase returns a session +
    // user; we hand both back in the shape auth-state expects.
    async function verifyOtp(email, code) {
        const client = getClient();
        if (!client) throw new Error(configErrorMessage());
        const { data, error } = await client.auth.verifyOtp({
            email: email,
            token: code,
            type: 'email'
        });
        if (error) throw new Error(error.message || 'That code didn\'t work.');
        return { session: data.session, user: data.user };
    }

    async function signOut() {
        const client = getClient();
        if (!client) return;
        try { await client.auth.signOut(); } catch (_) { /* best effort */ }
    }

    // Adopt a restored session (from the main process) so the SDK can refresh
    // it going forward. Safe to call with a partial/empty session.
    async function setSession(session) {
        const client = getClient();
        if (!client || !session || !session.access_token || !session.refresh_token) return null;
        const { data, error } = await client.auth.setSession({
            access_token: session.access_token,
            refresh_token: session.refresh_token
        });
        if (error) return null;
        return data && data.session ? data.session : null;
    }

    function onTokenRefresh(cb) {
        if (typeof cb === 'function') _refreshCbs.push(cb);
        return function off() {
            _refreshCbs = _refreshCbs.filter((fn) => fn !== cb);
        };
    }

    function configErrorMessage() {
        if (!getSdk()) {
            return 'The sign-in library failed to load. Please reinstall the app.';
        }
        return 'Accounts aren\'t set up yet. Add your Supabase project URL and anon key in js/auth/supabase-config.js.';
    }

    if (typeof window !== 'undefined') {
        window.SupabaseClient = {
            isConfigured,
            requestOtp,
            verifyOtp,
            signOut,
            setSession,
            onTokenRefresh
        };
    }
})();
