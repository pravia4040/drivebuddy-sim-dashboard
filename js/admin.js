/* ============================================================
   admin.js — Admin Panel controller
   ------------------------------------------------------------
   Renders the user table and wires up add / role / status / remove
   / search. Expects guardPage('Admin') to have already run.
   ============================================================ */

const Admin = {
  el(id){ return document.getElementById(id); },

  async init() {
    this.el('admin-who').textContent = window.__AUTH_ROW__?.email || '';
    this.el('add-btn').addEventListener('click', () => this.addUser());
    this.el('search').addEventListener('input', () => this.refresh());
    this.el('logout-btn').addEventListener('click', () => window.AUTH.signOut());
    await this.refresh();
  },

  async refresh() {
    const tbody = this.el('user-rows');
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Loading…</td></tr>`;
    try {
      const rows = await window.USERS.list({ search: this.el('search').value });
      if (!rows.length) { tbody.innerHTML = `<tr><td colspan="6" class="muted">No users found.</td></tr>`; return; }
      const me = window.__AUTH_ROW__?.email;
      tbody.innerHTML = rows.map(r => this.rowHtml(r, me)).join('');
      tbody.querySelectorAll('[data-act]').forEach(b =>
        b.addEventListener('click', () => this.handle(b.dataset.act, b.dataset.id, b.dataset.val)));
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="err">${this.esc(e.message)}</td></tr>`;
    }
  },

  rowHtml(r, me) {
    const self = r.email === me;
    const date = new Date(r.created_at).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    const statusPill = r.status === 'Active'
      ? `<span class="pill ok">Active</span>` : `<span class="pill off">Disabled</span>`;
    const rolePill = `<span class="pill ${r.role==='Admin'?'adm':'vw'}">${r.role}</span>`;
    return `<tr>
      <td><div class="em">${this.esc(r.email)}</div><div class="sub">${this.esc(r.added_by||'—')}</div></td>
      <td>${rolePill}</td>
      <td>${statusPill}</td>
      <td class="muted">${date}</td>
      <td class="acts">
        ${r.status==='Active'
          ? `<button class="mini" data-act="disable" data-id="${r.id}">Disable</button>`
          : `<button class="mini ok" data-act="enable" data-id="${r.id}">Enable</button>`}
        ${r.role==='Admin'
          ? `<button class="mini" data-act="role" data-id="${r.id}" data-val="Viewer">Make Viewer</button>`
          : `<button class="mini" data-act="role" data-id="${r.id}" data-val="Admin">Make Admin</button>`}
        ${self ? '' : `<button class="mini del" data-act="remove" data-id="${r.id}">Remove</button>`}
      </td>
    </tr>`;
  },

  async handle(act, id, val) {
    try {
      if (act === 'disable')      await window.USERS.setStatus(id, 'Disabled');
      else if (act === 'enable')  await window.USERS.setStatus(id, 'Active');
      else if (act === 'role')    await window.USERS.setRole(id, val);
      else if (act === 'remove') {
        if (!confirm('Remove this user permanently?')) return;
        await window.USERS.remove(id);
      }
      await this.refresh();
    } catch (e) { alert('Action failed: ' + e.message); }
  },

  async addUser() {
    const email = this.el('add-email').value.trim().toLowerCase();
    const role  = this.el('add-role').value;
    const msg   = this.el('add-msg');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = 'Enter a valid email.'; msg.className='add-msg err'; return; }
    this.el('add-btn').disabled = true;
    try {
      await window.USERS.add({ email, role });
      msg.textContent = `✓ ${email} can now sign in as ${role}.`;
      msg.className = 'add-msg ok';
      this.el('add-email').value = '';
      await this.refresh();
    } catch (e) {
      msg.textContent = e.message.includes('duplicate') ? 'That email is already authorized.' : e.message;
      msg.className = 'add-msg err';
    } finally { this.el('add-btn').disabled = false; }
  },

  esc(s){ return String(s??'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
};

window.addEventListener('DOMContentLoaded', async () => {
  await guardPage('Admin');
  Admin.init();
});
