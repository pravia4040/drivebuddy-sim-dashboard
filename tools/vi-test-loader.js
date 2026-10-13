/* ============================================================
   tools/vi-test-loader.js — LOCAL TESTING ONLY
   ------------------------------------------------------------
   Added to the dashboard by `tools/serve_local.py --mock` at /vi-test.html.
   Uploads the VI files from the local test-data folder (served under
   /__fixtures/, kept outside the repo) through the normal upload dialog
   into the MOCK database, switches to the VI view and shows a checklist.
   Does nothing unless the mock database is loaded. Not part of the live site.
   ============================================================ */
(function () {
  'use strict';
  if (!window.sb || !window.sb.__mock) return;                  // never against a real database

  // Uploaded the way a user would, cycle by cycle: Monthly mode (Summary + SIM Group), then Real-time mode (Itemized).
  // Sep 2026 = the closed cycle, with the SIM Group of 25 Sep (→ frozen with it); Oct 2026 = the current one (exports of
  // 27 Sep) with the SIM Group of 28 Sep — 15 SIMs Ready on 25 Sep and active on 28 Sep get a detected go-live day —
  // then the account owner's 6 Oct upload: Summary (to 5 Oct) + SIM Group of 6 Oct (62 more SIMs Ready → active).
  // VI names its exports <TYPE>_<id>_<account code and company>_<YYYYMMDDHHMMSS>.csv. Those files are found by type
  // and export time ([prefix, suffix]) in the test-data folder, so no account code is written here.
  const SIMGROUP_25 = ['SIMGROUP_', '_20260925154840.csv'];
  const SIMGROUP_28 = ['SIMGROUP_', '_20260928135632.csv'];
  const SIMGROUP_06 = ['SIMGROUP_', '_20261006141243.csv'];
  const STEPS_UPLOAD = [
    ['monthly', ['VI_SUMMARY_Sep2026.csv', SIMGROUP_25], 'summary', 'Sep 2026'],
    ['realtime', ['VI_ITEMIZED_Sep2026.csv'], 'itemized', 'Sep 2026'],
    ['monthly', [['SELFCARE_USAGE_SUMMARY_', '_20260927213551.csv'], SIMGROUP_28], 'summary', 'Oct 2026'],
    ['realtime', [['SELFCARE_USAGE_ITEMIZED_', '_20260927213606.csv']], 'itemized', 'Oct 2026'],
    ['monthly', [['SELFCARE_USAGE_SUMMARY_', '_20261006141259.csv'], SIMGROUP_06], 'summary', 'Oct 2026'],
  ];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function until(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) { /* not ready yet */ } await sleep(150); }
    return false;
  }
  // a file name, or [prefix, suffix] → the one file in the test-data folder that matches it
  let listing = null;
  async function nameOf(spec) {
    if (typeof spec === 'string') return spec;
    if (!listing) {
      const r = await fetch('/__fixtures/', { cache: 'no-store' });
      listing = r.ok ? await r.json() : [];
    }
    const hit = listing.filter(n => n.startsWith(spec[0]) && n.endsWith(spec[1]));
    if (hit.length !== 1) throw new Error(`${hit.length ? 'more than one' : 'no'} ${spec[0]}…${spec[1]} file in the test-data folder (D:\\DBAI-SIM\\vi-test-data)`);
    return hit[0];
  }
  async function fileOf(name) {
    const r = await fetch('/__fixtures/' + encodeURIComponent(name), { cache: 'no-store' });
    if (!r.ok) throw new Error(`${name} is not in the test-data folder (D:\\DBAI-SIM\\vi-test-data)`);
    return new File([await r.text()], name, { type: 'text/csv' });
  }
  const gb = v => (v == null || !isFinite(v) ? '—' : (Math.round(v * 100) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' GB');

  /* ── panel ─────────────────────────────────────────────────── */
  let box, statusEl, liveEl, bodyEl;
  const STEPS = [
    ['Vehicle Wise → monthly (Summary)', 'Month-wise tabs use the Data Usage Summary only. The Month filter lists Summary months.', () => go('vehicles', 'panel-vehicles')],
    ['Real-time → pick a day (Itemized)', 'Real-time uses the Itemized report only: 📅 As of picker, used since the 22nd, pool and available at the end of any day.', () => go('realtime', 'vi-asof')],
    ['Data Pool → pool, status, alerts', 'Tiles, alerts, SIM status table (rules), reconciliation, “How the pool is built”, trend, SIM-wise table + CSV.', () => go('pool', 'pool-body')],
    ['Upload your 22–24 Sep file', 'Opens the upload window in Real-time mode. Pick 📅 Data up to (like Airtel’s Snapshot Date). The file lands in Oct 2026, and the picker then offers those days.', upload],
    ['Uploads → history', 'Upload history, frozen pools (↻ Recompute), Summary vs Itemized reconciliation, “Delete cycle”.', () => go('uploads', 'up-body')],
  ];
  function build() {
    const css = `
      #vi-test{position:fixed;left:16px;bottom:16px;z-index:400;width:320px;max-width:calc(100vw - 32px);background:#111;border:1px solid var(--or);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.55);font-family:'Mulish',sans-serif;color:var(--sl);}
      #vi-test .vt-h{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--b2);font-family:'Poppins',sans-serif;font-size:13px;font-weight:600;color:var(--wh);}
      #vi-test .vt-tag{font-family:'Mulish',sans-serif;font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--ink);background:var(--or);border-radius:4px;padding:1px 6px;}
      #vi-test .vt-x{margin-left:auto;background:transparent;border:1px solid var(--b2);color:var(--gr);border-radius:6px;padding:2px 8px;cursor:pointer;font-size:11px;}
      #vi-test .vt-b{padding:10px 12px;display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow:auto;}
      #vi-test .vt-s{font-size:11.5px;line-height:1.5;}
      #vi-test .vt-live{font-size:11px;color:var(--gr);line-height:1.5;}
      #vi-test ol{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;}
      #vi-test li{font-size:11px;color:var(--gr);line-height:1.45;}
      #vi-test li button{display:block;margin-bottom:2px;background:var(--dc);border:1px solid var(--b2);color:var(--wh);border-radius:6px;padding:4px 9px;font-family:'Poppins',sans-serif;font-size:11.5px;cursor:pointer;text-align:left;}
      #vi-test li button:hover,#vi-test li button:focus-visible,#vi-test .vt-x:hover{border-color:var(--or);color:var(--or);}
      #vi-test .vt-exp{font-size:11px;line-height:1.55;background:#141414;border:1px solid #1f1f1f;border-radius:8px;padding:7px 9px;}
      #vi-test .vt-exp b{color:var(--wh);font-weight:600;}
      #vi-test .vt-reset{align-self:flex-start;background:transparent;border:1px solid var(--b2);color:var(--gr);border-radius:6px;padding:4px 9px;font-size:11px;cursor:pointer;}
      #vi-test .vt-reset:hover{border-color:#ef4444;color:#ef4444;}
      #vi-test.min .vt-b{display:none;}`;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    box = document.createElement('section'); box.id = 'vi-test'; box.setAttribute('aria-label', 'VI test page');
    box.innerHTML = `<div class="vt-h">🧪 VI test page <span class="vt-tag">local only</span><button type="button" class="vt-x" aria-expanded="true">Hide</button></div>
      <div class="vt-b"><div class="vt-s" role="status" aria-live="polite"></div>
        <ol></ol>
        <div class="vt-exp">With these files — Oct 2026 cycle (22 Sep – 21 Oct), SIM Group of 6 Oct, Summary of 6 Oct (to 5 Oct) — newer than the Itemized report (to 26 Sep), so the pool's used data comes from the Summary; only <b>active</b> SIMs on <b>_DP_</b> deals count:<br>
          <b>654 SIMs · 326 count</b> (325 Ready, 2 Dunning, 1 suspend do not) · full 21,165.00 GB (249 × 85) + pro-rated 4,349.17 GB (77 SIMs that went live 25 Sep – 6 Oct) = <b>pool 25,514.17 GB</b> · used 12,166.18 GB · <b>remaining 13,347.99 GB</b> · 47.68% · on pace for 102%<br>
          Vehicle Wise (VI): SIMs without a vehicle number are listed as “No vehicle · mobile no.” (client “No vehicle mapped”).<br>
          Sep 2026 (closed): 🔒 frozen with the SIM Group of 25 Sep — 249 SIMs, 16,084.83 GB, used 9,543.99 GB.<br>
          Operations (data to 5 Oct, today 6 Oct): <b>🚨 Critical</b> (over the pool on 26 Sep and 5 Oct) — per-SIM pace 2.99 GB a day (Summary 27 Sep – 5 Oct: 7,557.36 GB ÷ 2,530 SIM-days; allowed 2.83) × 326 SIMs = 973.79 GB a day → projected 27,746.87 GB (108.75%) · runs out ~19 Oct, 2.3 days early · shortfall 2,232.71 GB → <b>backup 2,460 GB</b> (+10%, rounded up to 10 GB) · the requirement’s cycle average: 869.01 GB a day → 26,070.38 GB (102.2%), 21 Oct · zero usage <b>90 SIMs</b> (10 new, 36 no usage, 44 long-term 30+ days, counted to the data day) · high usage 88 SIMs (≥ 150% of 2.83 GB a day).</div>
        <div class="vt-live"></div>
        <button type="button" class="vt-reset">Reset test data</button></div>`;
    document.body.appendChild(box);
    statusEl = box.querySelector('.vt-s'); liveEl = box.querySelector('.vt-live'); bodyEl = box.querySelector('ol');
    STEPS.forEach(([label, hint, fn]) => {
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.addEventListener('click', fn);
      li.appendChild(b); li.appendChild(document.createTextNode(hint)); bodyEl.appendChild(li);
    });
    const x = box.querySelector('.vt-x');
    const setMin = min => { box.classList.toggle('min', min); x.textContent = min ? 'Show' : 'Hide'; x.setAttribute('aria-expanded', String(!min)); };
    x.addEventListener('click', () => setMin(!box.classList.contains('min')));
    if (window.innerWidth < 700) setMin(true);                     // small screens: start folded, one tap to open
    box.querySelector('.vt-reset').addEventListener('click', reset);
  }
  const setStatus = t => { if (statusEl) statusEl.textContent = t; };
  function live() {
    const ds = window.Providers && Providers.raw('vi'), p = ds && ds.pool;
    if (!liveEl) return;
    liveEl.textContent = p && p.hasPool
      ? `On screen now (${p.as_of ? 'as of ' + p.as_of : (ds.rtMonth || '') + ', latest day'}): ${p.eligible_sims} of ${p.inventory_sims} SIMs count · pool ${gb(p.capacity_gb)} · used ${gb(p.used_gb)} · remaining ${gb(p.remaining_gb)} · ${p.util_pct.toFixed(2)}%${p.level ? ` · ${p.level}` : ''}${p.forecast && p.forecast.backup_gb ? ` · backup ${gb(p.forecast.backup_gb)}` : ''}${p.zero ? ` · zero usage ${p.zero.count}` : ''}`
      : 'No VI pool on screen.';
  }

  /* ── actions ───────────────────────────────────────────────── */
  function go(tab, focusId) {
    if (window.Providers && !Providers.inView('vi')) Providers.select('vi');
    window.showTab(tab);
    const el = document.getElementById(focusId) || document.getElementById('panel-' + tab);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (el.tagName === 'SELECT') el.focus(); }
  }
  async function upload() {
    window.openModal(); await sleep(150);
    window.ProvidersUI.setUploadProvider('vi');
    window.setUploadMode('realtime');                                // the dialog's Real-time mode → VI Real-time (Itemized)
  }
  function reset() {
    if (!confirm('Reset the local test data? The mock database is cleared and your VI files (Sep + Oct 2026, up to the 6 Oct files) are loaded again.')) return;
    location.href = location.pathname + '?mockReset=1';
  }

  /* ── start ─────────────────────────────────────────────────── */
  async function start() {
    build();
    setStatus('Starting the dashboard…');
    const ok = await until(() => window.ViUI && window.ViProvider && window.ProviderCloud && ProviderCloud.state.ready !== null && !document.getElementById('__authveil'), 20000);
    if (/mockReset/.test(location.search)) history.replaceState(null, '', location.pathname);   // a reload must not reset again
    if (!ok) { setStatus('The dashboard did not finish starting — reload the page.'); return; }
    let steps;
    try { steps = await Promise.all(STEPS_UPLOAD.map(async ([mode, specs, source, label]) => [mode, await Promise.all(specs.map(nameOf)), source, label])); }
    catch (e) { setStatus('❌ Could not find the test files: ' + e.message); return; }
    await sleep(1200);                                              // saved VI data loads from the mock database first
    if (!Object.keys(ViProvider.state.months).length) {
      try {
        for (const [mode, names, source, label] of steps) {
          setStatus(`Uploading ${label} — ${mode === 'monthly' ? 'Monthly mode: Data Usage Summary' + (names.length > 1 ? ' + SIM Group' : '') : 'Real-time mode: Itemized report'}…`);
          const files = await Promise.all(names.map(fileOf));
          window.openModal(); await sleep(250);
          window.ProvidersUI.setUploadProvider('vi'); await sleep(150);
          ViUI.setMode(mode); await sleep(150);
          await ViUI.addFiles(files); await sleep(400);
          window.processUpload();
          const done = () => { const m = ViProvider.state.months[label], src = m && m.sources && m.sources[source]; return !!(src && src.file === names[0]) && !ViUI.state.busy; };
          if (!(await until(done, 20000))) throw new Error(`the ${label} ${mode} upload did not finish`);
          await sleep(500);
        }
      } catch (e) { setStatus('❌ Could not load the test files: ' + e.message); return; }
    }
    Providers.select('vi');                                         // switch back with the header's Provider buttons
    // Saved data from an older test run may not have the newest step — say so instead of claiming it was loaded
    // (months loaded from the database do not carry file names — the upload history does)
    const lastNames = steps[steps.length - 1][1];
    const lastLoaded = lastNames.every(n => ProviderCloud.history().some(b => b.source_file === n && b.status === 'success'));
    const stored = ProviderCloud.state.ready;
    setStatus(lastLoaded || !stored
      ? '✅ Loaded: your VI files — Sep 2026 (+ SIM Group of 25 Sep), Oct 2026 (+ SIM Group of 28 Sep), then your 6 Oct Summary + SIM Group. Summary in Monthly mode, Itemized in Real-time mode. Try the steps below.'
      : '⚠ Showing test data saved by an older version of this page — it does not have the newest files (6 Oct Summary + SIM Group), so the figures below will not match. Click “Reset test data”.');
    live(); setInterval(live, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
