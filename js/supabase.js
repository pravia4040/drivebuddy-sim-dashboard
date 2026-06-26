/* ============================================================
   supabase.js — single shared Supabase client
   ------------------------------------------------------------
   Loaded by every page (login, dashboard, admin, unauthorized).
   Requires the Supabase SDK <script> to be loaded BEFORE this.
   ============================================================ */

// 🔑 Same project you already use for SIM data.
const SB_URL = 'https://uzfihzcixoxzlrrajluw.supabase.co';
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6ZmloemNpeG94emxycmFqbHV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0ODc5NjcsImV4cCI6MjA5NjA2Mzk2N30.GX7PZI6A3OVWoUdLM7xoVlePiFlLaxChd8yMe0Zs4K4';

// Persist + auto-refresh the session so a page refresh keeps the user logged in.
const supabaseClient = window.supabase.createClient(SB_URL, SB_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,   // needed for magic-link / recovery redirects
    storageKey: 'dbai_auth'
  }
});

// Make it globally reachable. The dashboard's existing cloud code can reuse
// THIS client instead of creating its own (see integration notes).
window.sb = supabaseClient;
window.SB_URL = SB_URL;
window.SB_ANON_KEY = SB_ANON_KEY;
