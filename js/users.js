/* ============================================================
   users.js — data layer for the authorized_users table
   ------------------------------------------------------------
   Thin CRUD wrappers. All calls are subject to RLS: only an
   Admin can insert/update/delete; everyone else is read-blocked
   except for their own row.
   ============================================================ */

const USERS = {
  async list({ search = '' } = {}) {
    let q = window.sb.from('authorized_users')
      .select('id,email,role,status,created_at,added_by')
      .order('created_at', { ascending: false });
    if (search.trim()) q = q.ilike('email', `%${search.trim()}%`);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async add({ email, role = 'Viewer' }) {
    const me = await window.AUTH.getUser();
    const { data, error } = await window.sb.from('authorized_users').insert({
      email: email.trim().toLowerCase(),
      role,
      status: 'Active',
      added_by: me ? me.email : null
    }).select().single();
    if (error) throw error;
    return data;
  },

  async setStatus(id, status /* 'Active' | 'Disabled' */) {
    const { error } = await window.sb.from('authorized_users')
      .update({ status }).eq('id', id);
    if (error) throw error;
  },

  async setRole(id, role /* 'Admin' | 'Viewer' */) {
    const { error } = await window.sb.from('authorized_users')
      .update({ role }).eq('id', id);
    if (error) throw error;
  },

  async remove(id) {
    const { error } = await window.sb.from('authorized_users')
      .delete().eq('id', id);
    if (error) throw error;
  }
};

window.USERS = USERS;
