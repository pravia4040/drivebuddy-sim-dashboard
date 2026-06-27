/* ============================================================
   pw-toggle.js — password visibility toggle
   ------------------------------------------------------------
   Call attachPwToggle(inputId) for each password field.
   Wraps the input in a .pw-wrap div and injects an SVG toggle
   button. Zero changes to auth logic or existing layout.
   ============================================================ */

(function () {
  const EYE_SHOW = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>`;

  const EYE_HIDE = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8
             a18.45 18.45 0 0 1 5.06-5.94"/>
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8
             a18.5 18.5 0 0 1-2.16 3.19"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>`;

  function attachPwToggle(inputId) {
    const input = document.getElementById(inputId);
    if (!input || input.dataset.pwToggle) return;
    input.dataset.pwToggle = '1';

    // Wrap input
    const wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    // Button
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye';
    btn.setAttribute('aria-label', 'Show password');
    btn.setAttribute('tabindex', '-1');
    btn.innerHTML = EYE_SHOW;
    wrap.appendChild(btn);

    // Adjust input right padding so text never slides under icon
    input.style.paddingRight = '42px';

    btn.addEventListener('click', function () {
      const visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      btn.innerHTML = visible ? EYE_SHOW : EYE_HIDE;
      btn.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
    });
  }

  window.attachPwToggle = attachPwToggle;
})();
