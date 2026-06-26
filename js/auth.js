/* ============================================================
   auth.js — authentication helpers (Supabase Auth)
   ------------------------------------------------------------
   Wraps sign-in, magic link, password reset, sign-out, and the
   authorization check against the `authorized_users` table.
   ============================================================ */

const REDIRECT_BASE = window.location.origin + window.location.pathname.replace(/[^/]*$/, '');

const AUTH = {
  /* ---- session ---- */
  async getSession() {
    const { data } = await window.sb.auth.getSession();
    return data.session || null;
  },
  async getUser() {
    const { data } = await window.sb.auth.getUser();
    return data.user || null;
  },

  /* ---- email + password ---- */
  async signInWithPassword(email, password) {
    return window.sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  },

  /* ---- magic link (passwordless) ---- */
  async signInWithMagicLink(email) {
    return window.sb.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: REDIRECT_BASE + 'index.html', shouldCreateUser: true }
    });
  },

  /* ---- forgot / reset password ---- */
  async sendPasswordReset(email) {
    return window.sb.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: REDIRECT_BASE + 'reset.html'
    });
  },
  async updatePassword(newPassword) {
    return window.sb.auth.updateUser({ password: newPassword });
  },

  /* ---- logout ---- */
  async signOut() {
    await window.sb.auth.signOut();
    window.location.href = 'login.html';
  },

  /* ---- AUTHORIZATION: is this signed-in user allowed in? ----
     Returns { ok, row, reason }.
     Relies on RLS: an unauthorized user simply gets 0 rows back. */
  async getAuthorization() {
    const user = await this.getUser();
    if (!user) return { ok: false, reason: 'no-session' };

    const { data, error } = await window.sb
      .from('authorized_users')
      .select('id,email,role,status,created_at,added_by')
      .eq('email', user.email.toLowerCase())
      .maybeSingle();

    if (error)              return { ok: false, reason: 'query-error', error };
    if (!data)              return { ok: false, reason: 'not-authorized', user };
    if (data.status !== 'Active')
                            return { ok: false, reason: 'disabled', row: data, user };
    return { ok: true, row: data, user };
  }
};

window.AUTH = AUTH;
