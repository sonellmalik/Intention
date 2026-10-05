// ===== Supabase configuration =====
//
// Fill these in with the values from YOUR Supabase project:
//   Supabase dashboard -> Project Settings -> API (or "Data API")
//     - Project URL  -> SUPABASE_URL
//     - anon public key -> SUPABASE_ANON_KEY
//
// Both of these are SAFE to ship inside the desktop app. The anon key is
// designed to be public (it only grants whatever your Row Level Security
// policies allow); it is NOT a secret. Never put the `service_role` key here.
//
// Also enable email OTP sign-in for the project:
//   Supabase dashboard -> Authentication -> Providers -> Email
//     - turn ON "Email OTP" (and you can turn OFF "Confirm email" / password
//       sign-up if you only want passwordless codes).
//
// Until these are filled in, the auth UI will show a friendly "not configured"
// message instead of trying (and failing) to reach Supabase.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.SupabaseConfig = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Project ref qahwgwhwcsavxgiuehav. Note the API URL is <ref>.supabase.co,
    // NOT the dashboard URL (supabase.com/dashboard/project/<ref>).
    const SUPABASE_URL = 'https://qahwgwhwcsavxgiuehav.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFhaHdnd2h3Y3NhdnhnaXVlaGF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExNDE2NzgsImV4cCI6MjEwNjcxNzY3OH0.4cx1dEYNvtmSBwIrfzK7-JyzxoRNGbL55Vh-Ybx4j7M';

    // True only when both values have been replaced with real-looking ones.
    function isConfigured() {
        return (
            typeof SUPABASE_URL === 'string' &&
            typeof SUPABASE_ANON_KEY === 'string' &&
            SUPABASE_URL.startsWith('http') &&
            SUPABASE_URL.indexOf('YOUR_') === -1 &&
            SUPABASE_ANON_KEY.indexOf('YOUR_') === -1 &&
            SUPABASE_ANON_KEY.length > 20
        );
    }

    return { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured };
});
