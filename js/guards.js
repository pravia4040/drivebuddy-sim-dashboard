/* ============================================================
   guards.js — route / page protection
   ------------------------------------------------------------
   Call ONE of these at the very top of a protected page, BEFORE
   rendering any sensitive content.

     guardPage()        → dashboard & general pages (any active user)
     guardPage('Admin') → admin-only pages

   It will:
     • show a loading screen,
     • verify there is a live session (else → login.html),
     • verify the user is Active in authorized_users (else → unauthorized.html),
     • verify the role if a minimum role is required (else → unauthorized.html),
     • resolve with the authorization row so the page can use it.

   Because the real data tables are protected by RLS, this JS gate is
   a UX convenience — even if someone bypassed it, Supabase returns
   no SIM rows to an unauthenticated / unauthorized user.
   ============================================================ */

function _guardOverlay() {
  if (document.getElementById('auth-loading')) return;
  const d = document.createElement('div');
  d.id = 'auth-loading';
  d.innerHTML = `
    <style>
      #auth-loading{position:fixed;inset:0;z-index:99999;background:#0E0E0E;
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        font-family:'Poppins',sans-serif;color:#fff;gap:18px;}
      #auth-loading .ring{width:42px;height:42px;border:3px solid #2a2a2a;
        border-top-color:#FF7B00;border-radius:50%;animation:authspin .8s linear infinite;}
      #auth-loading .t{font-size:13px;color:#757575;letter-spacing:.5px;}
      @keyframes authspin{to{transform:rotate(360deg)}}
    </style>
    <div class="ring"></div><div class="t">Verifying access…</div>`;
  document.body.appendChild(d);
  // Hide page body content until cleared, to avoid any flash of data.
  document.documentElement.style.visibility = 'visible';
}
function _clearOverlay() {
  const d = document.getElementById('auth-loading');
  if (d) d.remove();
}

async function guardPage(minRole /* undefined | 'Admin' */) {
  _guardOverlay();

  const session = await window.AUTH.getSession();
  if (!session) { window.location.replace('login.html'); return new Promise(()=>{}); }

  const auth = await window.AUTH.getAuthorization();

  if (!auth.ok) {
    if (auth.reason === 'no-session')      window.location.replace('login.html');
    else if (auth.reason === 'disabled')   window.location.replace('unauthorized.html?r=disabled');
    else                                   window.location.replace('unauthorized.html');
    return new Promise(()=>{});
  }

  if (minRole === 'Admin' && auth.row.role !== 'Admin') {
    window.location.replace('unauthorized.html?r=role');
    return new Promise(()=>{});
  }

  // React to logout / token loss in other tabs.
  window.sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') window.location.replace('login.html');
  });

  _clearOverlay();
  window.__AUTH_ROW__ = auth.row;   // { email, role, status, ... }

  // Start (or resume) the 60-minute session timeout
  if (window.SessionTimeout) window.SessionTimeout.start();

  return auth.row;
}

window.guardPage = guardPage;
