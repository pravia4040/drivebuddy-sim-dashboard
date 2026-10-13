/* ============================================================
   tools/vi-scale-bench.js — LOCAL TESTING ONLY
   ------------------------------------------------------------
   Served by `tools/serve_local.py --mock` at /vi-scale.html (in-memory mock database).
   A synthetic VI fleet of any size, shaped like the real exports (SIM Group exports
   with Ready → active go-lives, Data Usage Summaries, Itemized reports with a column
   per day), pushed through the normal upload dialog, save and load paths. Measures
   each step: browser time, database calls, MB sent, rows read — and checks the pool
   and the forecast against what the synthetic data was built to give.
   Never part of the live site.
   ============================================================ */
(function () {
  'use strict';
  if (!window.sb || !window.sb.__mock) return;
  const params = new URLSearchParams(location.search);
  const N = Math.max(10, +params.get('n') || 0);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) { /* not yet */ } await sleep(100); } return false; };
  const fmt = v => (Math.round(v * 100) / 100).toLocaleString('en-IN');

  /* ── panel ── */
  const box = document.createElement('section');
  box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9500;width:min(560px,calc(100vw - 24px));max-height:70vh;overflow:auto;background:#121212;border:1px solid #333;border-radius:10px;padding:10px 12px;font:12px/1.5 Mulish,sans-serif;color:#ddd';
  box.innerHTML = `<b style="font-family:Poppins,sans-serif">⚙ VI scale rehearsal</b> <span style="color:#888">local mock, in memory</span>
    <div style="margin:6px 0">${[1000, 5000, 10000, 20000].map(n => `<a href="/vi-scale.html?mockMem=1&n=${n}" style="color:#ff7b00;margin-right:10px">${n.toLocaleString('en-IN')} SIMs</a>`).join('')}</div>
    <div id="vsb-s">${N > 10 ? 'Starting…' : 'Pick a fleet size.'}</div><pre id="vsb-o" style="white-space:pre-wrap;margin:6px 0 0;font:11px/1.45 ui-monospace,Consolas,monospace"></pre>`;
  document.body.appendChild(box);
  const say = t => { document.getElementById('vsb-s').textContent = t; };
  const out = [];
  const log = line => { out.push(line); document.getElementById('vsb-o').textContent = out.join('\n'); console.log('[scale]', line); };
  if (!(N > 10)) return;
  if (params.get('mockMem') !== '1') { say('Open with ?mockMem=1 (the in-memory mock) — big fleets do not fit localStorage.'); return; }

  /* ── synthetic fleet (deterministic) ── */
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pad = (n, w) => String(n).padStart(w, '0');
  const E = 'S-TEST0001-0C0000-SCALE TEST', DP = 'CMP_VI_IOT_TEST_DP_100SMS_85GB_375R_GUJ', DPB = 'CMP_VI_IOT_TEST_DP_100SMS_85GB_375R';
  const sims = [];
  for (let i = 0; i < N; i++) {
    const r = rnd();
    // 70% live all along, 15% go live between the 25 Sep and 28 Sep exports, 10% between 28 Sep and 6 Oct, 5% stay Ready
    const kind = r < 0.70 ? 'live' : r < 0.85 ? 'g28' : r < 0.95 ? 'g06' : 'ready';
    const goDay = kind === 'g28' ? 25 + Math.floor(rnd() * 3) : kind === 'g06' ? 28 + Math.floor(rnd() * 8) : null;   // Sep 25–27 / Sep 28 – Oct 5
    sims.push({ iccid: '89910582' + pad(i, 11), msisdn: '9157' + pad(i, 11), imsi: '40405' + pad(i, 10), kind, goDay,
      circles: rnd() < 0.5 ? 1 : 2, rate: 2.2 + rnd() * 1.8 /* GB a day */, act: kind === 'live' ? '2026-08-01' : '2026-09-10' });
  }
  const dayStr = (m, d) => `2026-${pad(m, 2)}-${pad(d, 2)}`;
  const goDate = s => (s.goDay == null ? null : s.goDay <= 30 ? dayStr(9, s.goDay) : dayStr(10, s.goDay - 30));
  const stateAt = (s, at) => (s.kind === 'live' ? 'active' : s.kind === 'ready' ? 'Ready' : goDate(s) <= at ? 'active' : 'Ready');
  const GH = 'E_CODE,ACCOUNT_ID,SUB_PROFILE_ID,SUB_PROFILE_NAME,PRODUCT_TYPE,MSISDN,IMSI,ICCID,CIRCLE,DATE_OF_ACTIVATION,SIM_LIFECYCLE_STATE,DEAL_NAME,BASE_PLAN_NAME,GROUP_NAME,CONTRACT_START_DATE,CONTRACT_END_DATE,CONTRACT_NAME';
  const simGroup = (at, stamp) => new File([[GH].concat(sims.map(s => `${E},1,2,TEST,M2M,${s.msisdn},${s.imsi},~${s.iccid},Gujarat,${s.act} 10:00:00.000000,${stateAt(s, at)},${DP},${DPB},,,,NULL`)).join('\n')],
    `SIMGROUP_1${stamp}_S-SCALE_${stamp}.csv`, { type: 'text/csv' });
  // usage of a SIM on a day (GB): only when live that day; ±20% day to day
  const useOn = (s, d) => { if (s.kind === 'ready') return 0; const g = goDate(s); if (g && d < g) return 0; return s.rate * (0.8 + 0.4 * ((s.iccid.charCodeAt(18) * 31 + +d.slice(8)) % 97) / 97); };
  const days = (from, to) => { const o = []; for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) o.push(new Date(t).toISOString().slice(0, 10)); return o; };
  const SUMH = 'E_CODE,ACCOUNT_ID,MSISDN,IMSI,ICCID,CIRCLE,TOTAL_USAGE:Data-kiloBytes/Voice-Seconds/SMS-Count,ORIGIN_CIRCLE,Last_Packet_Switched_Session_End,Packet_Switched_Session_Days';
  function summary(from, to, stamp) {
    const ds = days(from, to), rows = [];
    sims.forEach(s => {
      const per = ds.map(d => useOn(s, d)), tot = per.reduce((a, v) => a + v, 0); if (!(tot > 0)) return;
      const used = per.filter(v => v > 0).length;
      for (let c = 0; c < s.circles; c++) rows.push(`${E},1,${s.msisdn},${s.imsi},~${s.iccid},11304${c}9,${(tot / s.circles * 1048576).toFixed(4)},GUJ_HOME,${to} 23:50:00,${used}`);
    });
    return new File([[SUMH].concat(rows).join('\n')], `SELFCARE_USAGE_SUMMARY_1${stamp}_S-SCALE_${stamp}.csv`, { type: 'text/csv' });
  }
  function itemized(from, to, stamp) {
    const ds = days(from, to), rows = [];
    sims.forEach(s => {
      const per = ds.map(d => useOn(s, d)); if (!per.some(v => v > 0)) return;
      for (let c = 0; c < s.circles; c++) {
        const cells = per.map(v => (v > 0 ? Math.round(v / s.circles * 1073741824) : '')), tot = per.reduce((a, v) => a + v, 0) / s.circles;
        rows.push(`${E},1,${s.msisdn},${s.imsi},~${s.iccid},11304${c}9,${cells.join(',')},${(tot * 1048576).toFixed(4)},GUJ_HOME,${to} 23:50:00,${per.filter(v => v > 0).length}`);
      }
    });
    const head = `E_CODE,ACCOUNTID,MSISDN,IMSI,ICCID,CIRCLE,${ds.join(',')},TOTAL_USAGE:Data-KiloBytes/Voice-Seconds/SMS-Count,ORIGIN_CIRCLE,Last_Packet_Switched_Session_End,Packet_Switched_Session_Days`;
    return new File([[head].concat(rows).join('\n')], `SELFCARE_USAGE_ITEMIZED_1${stamp}_S-SCALE_${stamp}.csv`, { type: 'text/csv' });
  }

  /* ── the run ── */
  const S = window.sb.__stats;
  const snap = () => ({ rpc: Object.values(S.rpc).reduce((a, v) => a + v, 0), selects: S.selects, rows: S.rows_out, bytes: S.bytes_in });
  const delta = (a, b) => ({ calls: b.rpc - a.rpc, selects: b.selects - a.selects, rows: b.rows - a.rows, mb: (b.bytes - a.bytes) / 1048576 });
  const results = [];
  async function upload(label, mode, files, source, cycle) {
    const s0 = snap(), t0 = performance.now();
    window.openModal(); await sleep(200);
    window.ProvidersUI.setUploadProvider('vi'); await sleep(100);
    ViUI.setMode(mode); await sleep(100);
    await ViUI.addFiles(files); await sleep(200);
    const tParsed = performance.now();
    window.processUpload();
    const ok = await until(() => { const m = ViProvider.state.months[cycle], src = m && m.sources && m.sources[source]; return !!(src && src.file === files[0].name) && !ViUI.state.busy; }, 600000);
    const t1 = performance.now(), d = delta(s0, snap());
    results.push({ step: label, ms: Math.round(t1 - t0), parse_ms: Math.round(tParsed - t0), db_calls: d.calls, mb_sent: fmt(d.mb), rows_read: d.rows, ok });
    log(`${label}: ${ok ? '' : '⚠ did not finish · '}${Math.round(t1 - t0)} ms (files read ${Math.round(tParsed - t0)} ms) · ${d.calls} database calls · ${fmt(d.mb)} MB sent`);
  }
  async function run() {
    const ok = await until(() => window.ViUI && window.ViProvider && window.ProviderCloud && ProviderCloud.state.ready !== null && !document.getElementById('__authveil'), 30000);
    if (!ok) { say('The dashboard did not start.'); return; }
    await sleep(800);
    say(`Building ${N.toLocaleString('en-IN')} synthetic SIMs…`);
    const f = {
      g25: simGroup('2026-09-25', '20260925154840'), g28: simGroup('2026-09-28', '20260928135632'), g06: simGroup('2026-10-06', '20261006141243'),
      sSep: summary('2026-08-22', '2026-09-21', '20260925154700'), iSep: itemized('2026-08-22', '2026-09-21', '20260925154800'),
      sOct1: summary('2026-09-22', '2026-09-26', '20260927213551'), iOct: itemized('2026-09-22', '2026-09-26', '20260927213606'),
      sOct2: summary('2026-09-22', '2026-10-05', '20261006141259'),
    };
    const size = Object.values(f).reduce((a, x) => a + x.size, 0) / 1048576;
    log(`${N.toLocaleString('en-IN')} SIMs · files ${fmt(size)} MB (Itemized Sep ${fmt(f.iSep.size / 1048576)} MB)`);
    say('Uploading through the normal dialog…');
    await upload('Sep Summary + SIM Group 25 Sep', 'monthly', [f.sSep, f.g25], 'summary', 'Sep 2026');
    await upload('Sep Itemized (31 days)', 'realtime', [f.iSep], 'itemized', 'Sep 2026');
    await upload('Oct Summary + SIM Group 28 Sep', 'monthly', [f.sOct1, f.g28], 'summary', 'Oct 2026');
    await upload('Oct Itemized (5 days)', 'realtime', [f.iOct], 'itemized', 'Oct 2026');
    await upload('Oct Summary 6 Oct + SIM Group 6 Oct', 'monthly', [f.sOct2, f.g06], 'summary', 'Oct 2026');
    // the dashboard's own work on this data
    let t0 = performance.now(); ViProvider.rebuild({ silent: true }); const tBuild = performance.now() - t0;
    t0 = performance.now(); window.showTab('pool'); window.Providers.refresh(); await sleep(50); const tPool = performance.now() - t0;
    window.showTab('vehicles');
    const ds = window.Providers.raw('vi'), p = ds.pool, fc = p.forecast;
    log(`Rebuild (pool, forecast, lists): ${Math.round(tBuild)} ms · Data Pool tab drawn: ${Math.round(tPool)} ms · page has ${document.querySelectorAll('#panel-pool tr').length} table rows`);
    // start-up: what a viewer's browser loads (newest 3 cycles, history summarised in the database)
    const C = window.ProviderCloud, s0 = snap(); t0 = performance.now();
    const [d, hist, ops] = await Promise.all([C.loadProvider('vi', { recent: 3 }), C.loadPoolHistory('vi', 150, ViProvider.rulesConfig().prelive_states), C.loadOps('vi')]);
    const tLoad = performance.now() - t0, dl = delta(s0, snap());
    log(`Start-up load: ${Math.round(tLoad)} ms · ${dl.selects} reads + ${dl.calls} database functions · ${dl.rows.toLocaleString('en-IN')} rows · ${hist && hist.runs ? hist.runs.size.toLocaleString('en-IN') + ' SIMs with state runs, ' + hist.snapshots.length + ' exports listed (not downloaded)' : 'full history'}`);
    // expected from the synthetic data
    const live = s => s.kind !== 'ready';
    const counted = sims.filter(s => live(s));
    const expUsed = counted.reduce((a, s) => a + days('2026-09-22', '2026-10-05').reduce((b, dd) => b + useOn(s, dd), 0), 0);
    log(`Pool ${fmt(p.capacity_gb)} GB · ${p.eligible_sims.toLocaleString('en-IN')} SIMs count (expected ${counted.length.toLocaleString('en-IN')}) · used ${fmt(p.used_gb)} GB (expected ${fmt(expUsed)}) · ${p.level} · ${fmt(fc.projected_pct)}% projected · runs out ${fc.exhaustion_date || '—'} · backup ${fmt(fc.backup_gb)} GB · pace ${fmt(fc.pace.gb_sim_day)} GB per SIM a day (${fc.pace.basis})`);
    window.__scale = { n: N, results, build_ms: tBuild, pool_ms: tPool, load_ms: tLoad, load: dl, pool: { cap: p.capacity_gb, used: p.used_gb, sims: p.eligible_sims, level: p.level, pct: fc.projected_pct, exh: fc.exhaustion_date, backup: fc.backup_gb },
      expected: { sims: counted.length, used: expUsed }, mem_mb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
    say(`Done — ${N.toLocaleString('en-IN')} SIMs.`);
    console.table(results);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
