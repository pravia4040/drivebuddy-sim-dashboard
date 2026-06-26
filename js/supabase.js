/* ============================================================
   supabase.js — single shared Supabase client
   ------------------------------------------------------------
   Loaded by every page (login, dashboard, admin, unauthorized).
   Requires the Supabase SDK <script> to be loaded BEFORE this.

   NOTE: We attach everything to window.* only. We do NOT declare
   top-level `const SB_URL` here, because index.html already
   declares its own SB_URL/SB_KEY for the existing cloud code,
   and two top-level `const`s with the same name on one page
   would crash with "Identifier 'SB_URL' has already been declared".
   ============================================================ */
(function () {
  var URL = 'https://uzfihzcixoxzlrrajluw.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6ZmloemNpeG94emxycmFqbHV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0ODc5NjcsImV4cCI6MjA5NjA2Mzk2N30.GX7PZI6A3OVWoUdLM7xoVlePiFlLaxChd8yMe0Zs4K4';

  // Persist + auto-refresh the session so a page refresh keeps the user logged in.
  window.sb = window.supabase.createClient(URL, ANON, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'dbai_auth'
    }
  });

  // Expose on window for any page that needs them (no top-level const → no clash)
  window.SB_URL = URL;
  window.SB_ANON_KEY = ANON;
})();
