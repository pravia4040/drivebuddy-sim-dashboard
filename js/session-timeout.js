/* ============================================================
   session-timeout.js — automatic session expiry
   ------------------------------------------------------------
   • 60-minute hard timeout from login time
   • Warning modal at 55 minutes
   • Timer survives page refreshes (stored in localStorage)
   • "Continue Session" refreshes Supabase token + resets timer
   • Expired logout clears all auth state → login.html?expired=1
   ============================================================ */

(function () {
  const TIMEOUT_MS  = 60 * 60 * 1000;   // 60 minutes
  const WARNING_MS  = 55 * 60 * 1000;   // 55 minutes
  const LS_KEY      = 'dbai_session_start';

  let _warnTimer   = null;
  let _logoutTimer = null;
  let _modalOpen   = false;

  /* ── public API ────────────────────────────────────────── */
  window.SessionTimeout = {
    start   : _start,
    reset   : _reset,
    clear   : _clearTimers,
  };

  /* ── init ───────────────────────────────────────────────── */
  function _start() {
    let loginAt = parseInt(localStorage.getItem(LS_KEY), 10);
    if (!loginAt || isNaN(loginAt)) {
      loginAt = Date.now();
      localStorage.setItem(LS_KEY, loginAt);
    }

    const elapsed = Date.now() - loginAt;

    if (elapsed >= TIMEOUT_MS) {
      _expiredLogout();
      return;
    }

    _clearTimers();

    const toWarn   = WARNING_MS  - elapsed;
    const toLogout = TIMEOUT_MS  - elapsed;

    if (toWarn > 0) {
      _warnTimer = setTimeout(_showWarningModal, toWarn);
    } else {
      // Past warning point but not yet expired — show immediately
      _showWarningModal();
    }
    _logoutTimer = setTimeout(_expiredLogout, toLogout);
  }

  /* ── reset (Continue Session) ───────────────────────────── */
  function _reset() {
    _closeModal();
    localStorage.setItem(LS_KEY, Date.now());
    // Refresh Supabase token so it doesn't expire independently
    if (window.sb) window.sb.auth.refreshSession().catch(() => {});
    _start();
  }

  /* ── timers ─────────────────────────────────────────────── */
  function _clearTimers() {
    clearTimeout(_warnTimer);
    clearTimeout(_logoutTimer);
    _warnTimer   = null;
    _logoutTimer = null;
  }

  /* ── warning modal ──────────────────────────────────────── */
  function _showWarningModal() {
    if (_modalOpen) return;
    _modalOpen = true;

    const overlay = document.createElement('div');
    overlay.id = 'st-overlay';
    overlay.innerHTML = `
      <div id="st-modal">
        <div id="st-icon">⏱</div>
        <div id="st-title">Session Expiring Soon</div>
        <div id="st-body">
          Your session will expire in <strong>5 minutes</strong> due to security reasons.
          <br>Would you like to continue?
        </div>
        <div id="st-countdown"></div>
        <div id="st-actions">
          <button id="st-btn-continue" onclick="SessionTimeout.reset()">Continue Session</button>
          <button id="st-btn-logout"   onclick="SessionTimeout.logoutNow()">Logout Now</button>
        </div>
      </div>`;

    _injectStyles();
    document.body.appendChild(overlay);
    _startCountdown(overlay);
  }

  function _closeModal() {
    _modalOpen = false;
    const el = document.getElementById('st-overlay');
    if (el) el.remove();
  }

  function _startCountdown(overlay) {
    const loginAt  = parseInt(localStorage.getItem(LS_KEY), 10);
    const expiresAt = loginAt + TIMEOUT_MS;

    const tick = () => {
      const rem = Math.max(0, expiresAt - Date.now());
      const m   = Math.floor(rem / 60000);
      const s   = Math.floor((rem % 60000) / 1000);
      const el  = document.getElementById('st-countdown');
      if (el) el.textContent = `Time remaining: ${m}:${s.toString().padStart(2,'0')}`;
      if (rem > 0 && document.getElementById('st-overlay')) setTimeout(tick, 1000);
    };
    tick();
  }

  /* ── logout helpers ─────────────────────────────────────── */
  window.SessionTimeout.logoutNow = function () {
    _clearTimers();
    _clearAuthStorage();
    if (window.sb) {
      window.sb.auth.signOut().finally(() => {
        window.location.replace('login.html');
      });
    } else {
      window.location.replace('login.html');
    }
  };

  function _expiredLogout() {
    _clearTimers();
    _clearAuthStorage();
    if (window.sb) {
      window.sb.auth.signOut().finally(() => {
        window.location.replace('login.html?expired=1');
      });
    } else {
      window.location.replace('login.html?expired=1');
    }
  }

  function _clearAuthStorage() {
    // Remove session timer key
    localStorage.removeItem(LS_KEY);
    // Remove edit-unlock
    try { sessionStorage.removeItem('dbai_edit_unlock'); } catch(e) {}
    // Clear all Supabase / drivebuddyAI auth keys
    const killKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('sb-') || k.includes('supabase') || k.startsWith('dbai'))) {
        killKeys.push(k);
      }
    }
    killKeys.forEach(k => localStorage.removeItem(k));
  }

  /* ── styles (injected once) ─────────────────────────────── */
  function _injectStyles() {
    if (document.getElementById('st-styles')) return;
    const s = document.createElement('style');
    s.id = 'st-styles';
    s.textContent = `
      #st-overlay {
        position: fixed; inset: 0; z-index: 999999;
        background: rgba(0,0,0,0.75); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        font-family: 'Poppins', sans-serif;
        animation: st-fadein .2s ease;
      }
      @keyframes st-fadein { from { opacity:0 } to { opacity:1 } }
      #st-modal {
        background: #1a1a1a; border: 1px solid #2a2a2a;
        border-radius: 16px; padding: 36px 32px; max-width: 420px; width: 90%;
        text-align: center; box-shadow: 0 24px 64px rgba(0,0,0,.6);
        animation: st-slidein .25s ease;
      }
      @keyframes st-slidein { from { transform:translateY(16px);opacity:0 } to { transform:translateY(0);opacity:1 } }
      #st-icon {
        font-size: 40px; margin-bottom: 12px;
      }
      #st-title {
        font-size: 18px; font-weight: 600; color: #fff; margin-bottom: 12px;
      }
      #st-body {
        font-size: 14px; color: #DADADA; line-height: 1.6; margin-bottom: 16px;
      }
      #st-body strong { color: #FF7B00; }
      #st-countdown {
        font-family: 'Roboto', monospace; font-size: 13px;
        color: #ef4444; margin-bottom: 24px; letter-spacing: .5px;
      }
      #st-actions {
        display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;
      }
      #st-btn-continue {
        flex: 1; min-width: 130px; padding: 10px 20px;
        background: #FF7B00; color: #fff; border: none;
        border-radius: 8px; font-size: 14px; font-weight: 600;
        font-family: 'Poppins', sans-serif; cursor: pointer;
        transition: background .15s;
      }
      #st-btn-continue:hover { background: #e06d00; }
      #st-btn-logout {
        flex: 1; min-width: 130px; padding: 10px 20px;
        background: transparent; color: #757575;
        border: 1px solid #2a2a2a; border-radius: 8px;
        font-size: 14px; font-family: 'Poppins', sans-serif;
        cursor: pointer; transition: color .15s, border-color .15s;
      }
      #st-btn-logout:hover { color: #ef4444; border-color: #ef4444; }
    `;
    document.head.appendChild(s);
  }
})();
