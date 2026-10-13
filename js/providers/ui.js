/* ============================================================
   providers/ui.js — provider-independent UI
   ------------------------------------------------------------
   Header selector, "Viewing" chip, provider-aware filters, the
   Providers (comparison) · Data Pool · Uploads panels, and the
   provider choice in the upload dialog. Nothing here names a
   provider: provider-specific UI registers hooks on its config
   (see providers/vi-ui.js):
     cfg.upload  { mount, render, canProcess, process }  upload form
     cfg.ui      { reconSection, rtInfo, rtControls, pickDay, vsumExtra, afterVsum,
                   statusRuleControl, poolHeaderExtra }
     cfg.boot()  load the provider's saved data at start-up
   A pool (ds.pool) brings its own sections: alerts, SIM status table,
   SIM Group ↔ usage reconciliation, billing-cycle trend (ds.trend) and
   the SIM-wise allocation table (search + CSV).

   Charts follow the dashboard's dataviz rules: identity colours
   from the provider registry (never status colours), thin columns
   with 4px rounded caps from one baseline, a 2px gap between bars,
   hairline grid, a legend for ≥2 series, selective direct labels,
   hover + keyboard-focus tooltips, and a table-view twin.
   ============================================================ */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n0 = v => Math.round(v || 0).toLocaleString();
  const gb = v => (v == null || !isFinite(v) ? '—' : (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 100) / 100).toLocaleString()) + ' GB');
  const inr = v => (v == null || !isFinite(v) ? '—' : '₹' + Math.round(v).toLocaleString());
  const pct = (v, d = 1) => (v == null || !isFinite(v) ? '—' : v.toFixed(d) + '%');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortDate = d => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${+m[3]} ${MON[+m[2] - 1]} ${m[1]}` : (d || '—'); };
  const PV = () => window.Providers;
  const provOf = r => (r && r.provider) || PV().legacyCode();
  const gf = r => (typeof window.gfMatch === 'function' ? window.gfMatch(r) : true);
  const hook = (code, name) => { const c = PV().get(code); return c && c.ui && typeof c.ui[name] === 'function' ? c.ui[name] : null; };

  /* ── tooltip (one element, textContent only) ───────────────── */
  let tipEl = null;
  function tip() {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'pv-tip'; tipEl.setAttribute('role', 'tooltip'); document.body.appendChild(tipEl); }
    return tipEl;
  }
  function showTip(bar, x, y) {
    const t = tip(); t.textContent = '';
    const v = document.createElement('b'); v.textContent = bar.dataset.v || ''; t.appendChild(v);
    const l = document.createElement('span');
    if (bar.dataset.c) { const k = document.createElement('i'); k.style.background = bar.dataset.c; l.appendChild(k); }
    l.appendChild(document.createTextNode(bar.dataset.l || '')); t.appendChild(l);
    t.style.display = 'block';
    const r = t.getBoundingClientRect();
    t.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x + 12)) + 'px';
    t.style.top = Math.max(8, y - r.height - 12) + 'px';
  }
  const hideTip = () => { if (tipEl) tipEl.style.display = 'none'; };
  const barAt = e => (e.target && e.target.closest ? e.target.closest('[data-tipbar]') : null);
  document.addEventListener('pointermove', e => { const b = barAt(e); if (b) showTip(b, e.clientX, e.clientY); else hideTip(); });
  document.addEventListener('focusin', e => { const b = barAt(e); if (b) { const r = b.getBoundingClientRect(); showTip(b, r.left + r.width / 2, r.top); } });
  document.addEventListener('focusout', hideTip);

  /* ── column chart + table view ─────────────────────────────── */
  function niceMax(v) {                      // round the axis top up to a clean number, without wasting height
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
    return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(s => m <= s) * p;
  }
  // series [{key,name,color}] · cats [{key,label,short}] · val(catKey, seriesKey)
  // dim(catKey) → faded bar (days after the "as of" day) · sel(catKey) → outlined bar
  // pick = provider code → bars are clickable / Enter-able and call that provider's ui.pickDay(catKey)
  function columnChart({ series, cats, val, height = 120, fmt = gb, label = 'last', width = 640, aria = '', dim = null, sel = null, pick = null }) {
    const vals = cats.map(c => series.map(s => +val(c.key, s.key) || 0));
    const top = niceMax(Math.max(0, ...vals.flat()));
    const bw = Math.max(3, Math.min(24, Math.floor(width / Math.max(1, cats.length) / series.length) - 4));
    let peak = null;
    if (label === 'peak') { let best = 0; vals.forEach((row, i) => row.forEach((v, j) => { if (v > best) { best = v; peak = [i, j]; } })); }
    const grid = [0.5, 1].map(f => `<div class="pv-grid" style="bottom:${f * height}px"><span>${esc(fmt(top * f))}</span></div>`).join('')
      + `<div class="pv-grid pv-base" style="bottom:0"><span>0</span></div>`;
    const groups = cats.map((c, i) => {
      const bars = series.map((s, j) => {
        const v = vals[i][j], h = v > 0 ? Math.max(2, Math.round(v / top * height)) : 0;
        const lbl = label === 'peak' ? !!(peak && peak[0] === i && peak[1] === j) : label === 'last' && i === cats.length - 1;
        const cls = 'pv-bar' + (dim && dim(c.key) ? ' pv-dim' : '') + (sel && sel(c.key) ? ' pv-sel' : '');
        const tipL = (series.length > 1 ? s.name + ' · ' : '') + c.label + (pick ? ' · click to view this day' : '');
        return `<div class="${cls}" tabindex="0" data-tipbar${pick ? ` data-k="${esc(c.key)}"` : ''} data-v="${esc(fmt(v))}" data-l="${esc(tipL)}" data-c="${s.color}" style="height:${h}px;width:${bw}px;background:${s.color}">${lbl && v > 0 ? `<span class="pv-cap">${esc(fmt(v))}</span>` : ''}</div>`;
      }).join('');
      return `<div class="pv-grp"><div class="pv-bars">${bars}</div><div class="pv-x">${esc(c.short != null ? c.short : c.label)}</div></div>`;
    }).join('');
    const legend = series.length > 1 ? `<div class="pv-legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
    return `${legend}<div class="pv-chart${pick ? ' pv-pick' : ''}"${pick ? ` data-pick="${esc(pick)}" role="group"` : ' role="img"'} aria-label="${esc(aria)}"><div class="pv-plot" style="height:${height}px">${grid}<div class="pv-groups">${groups}</div></div></div>`;
  }
  function tableView(head, rows, summary = 'Table view') {
    return `<details class="pv-tv"><summary>${esc(summary)}</summary><table class="pv-table"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
  }
  // Click / Enter / Space on a bar of a pickable chart → that provider's ui.pickDay(key)
  function pickBar(e) {
    const bar = e.target && e.target.closest ? e.target.closest('[data-pick] [data-k]') : null; if (!bar) return false;
    const f = hook(bar.closest('[data-pick]').dataset.pick, 'pickDay'); if (f) f(bar.dataset.k);
    return true;
  }
  document.addEventListener('click', pickBar);
  document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && pickBar(e)) e.preventDefault(); });

  /* ── provider bar + indicator ──────────────────────────────── */
  function simCount(code) { const ds = PV().raw(code); if (!ds.hasData) return 0; return ds.rtRows && ds.rtRows.length ? ds.rtRows.length : ds.CD.vehicles.length; }
  function renderBar() {
    const el = $('prov-bar'); if (!el) return;
    const codes = PV().viewCodes(), sel = PV().selected();
    const btn = (code, text, color, disabled, title, active) =>
      `<button class="prov-btn${active ? ' active' : ''}" ${disabled ? 'disabled' : ''} onclick="Providers.select('${code}')" title="${esc(title)}" aria-pressed="${active}">${color ? `<i style="background:${color}"></i>` : ''}${esc(text)}</button>`;
    el.innerHTML = `<span class="prov-lbl">Provider</span>`
      + btn('all', 'All Providers', null, false, 'Combined view of every active provider', codes.length > 1)
      + PV().list().map(p => p.status === 'active'
        ? btn(p.code, p.short, p.color, false, `${p.name} · ${simCount(p.code).toLocaleString()} SIMs loaded`, codes.length === 1 && sel === p.code)
        : btn(p.code, p.short + ' · soon', p.color, true, `${p.name} — not configured yet`, false)).join('');
  }
  function renderChip() {
    const el = $('prov-chip'); if (!el) return;
    const codes = PV().viewCodes(), withData = codes.filter(c => PV().raw(c).hasData);
    const one = codes.length === 1 ? PV().get(codes[0]) : null;
    const sub = one ? (PV().raw(one.code).hasData ? '' : 'no data yet') : (withData.map(c => PV().shortName(c)).join(' + ') || 'no data yet');
    const m = PV().selectedMonth();
    el.innerHTML = `<span class="prov-chip-k">Viewing</span>${one ? `<i style="background:${one.color}"></i>` : ''}<b>${esc(one ? one.name : 'All Providers')}</b>`
      + (sub ? `<span class="prov-chip-s">${esc(sub)}</span>` : '') + (m !== 'latest' ? `<span class="prov-chip-s">· ${esc(m)}</span>` : '');
  }

  /* ── filters that depend on the providers in view ──────────── */
  function beforeRender(view) {
    const ss = $('gf-simstatus');
    if (ss) {
      const cur = ss.value, set = new Set();
      // Each provider's original status options first (Airtel: the legacy four), then any status in the data
      const inView = view.codes.length ? view.codes : [PV().legacyCode()];
      inView.forEach(c => ((PV().get(c) || {}).legacyStatuses || []).forEach(s => set.add(s)));
      view.CD.vehicles.forEach(v => v.sim_status && v.sim_status !== 'N/A' && set.add(v.sim_status));
      view.rtRows.forEach(r => r.sim_status && r.sim_status !== 'N/A' && set.add(r.sim_status));
      const opts = [...set];
      ss.innerHTML = '<option value="">All SIM Statuses</option>' + opts.map(s => `<option value="${esc(s)}">${esc(s === 'DISCONNECTED' ? 'Disconnected' : s)}</option>`).join('');
      ss.value = opts.includes(cur) ? cur : '';
    }
    const gm = $('gf-month');
    if (gm) {
      const months = PV().monthsInView().slice().reverse(), cur = PV().selectedMonth();
      gm.innerHTML = '<option value="latest">Latest period</option>' + months.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
      gm.value = months.includes(cur) ? cur : 'latest';
      gm.style.display = months.length ? '' : 'none';
    }
  }

  /* ── Providers panel (comparison) ──────────────────────────── */
  function vehMetrics(veh) {
    const withPlan = veh.filter(v => v.plan);
    const used = veh.reduce((a, v) => a + (v.used_mb || 0), 0) / 1024, usedN = veh.filter(v => v.used_mb > 0).length;
    const alloc = withPlan.reduce((a, v) => a + (v.plan_gb || 0), 0);
    return { vehicles: veh.length, with_plan: withPlan.length, active: veh.filter(v => v.sim_status === 'Active').length,
      alloc, used, remaining: alloc - used, used_n: usedN, avg: usedN ? used / usedN : 0,
      high: veh.filter(v => v.usage_pct >= 90).length, exceeded: veh.filter(v => v.usage_pct >= 100).length,
      low: withPlan.filter(v => v.usage_pct < 5).length,
      cost: withPlan.filter(v => v.sim_status === 'Active').reduce((a, v) => a + (PV().priceFor(v) || 0), 0) };
  }
  function simMetrics(sims) {
    const alloc = sims.reduce((a, r) => a + (r.alloc_mb || 0), 0) / 1024, used = sims.reduce((a, r) => a + (r.used_mb || 0), 0) / 1024;
    return { sims: sims.length, active: sims.filter(r => r.sim_status === 'Active').length, alloc, used,
      avail: sims.reduce((a, r) => a + (r.avail_mb || 0), 0) / 1024, util: alloc > 0 ? used / alloc * 100 : 0,
      exceeded: sims.filter(r => r.flag === 'EXCEEDED').length, wasted: sims.filter(r => r.flag === 'WASTED').length,
      no_plan: sims.filter(r => r.flag === 'NO DATA').length };
  }
  function sumOf(list) {
    const t = {}; list.forEach(m => Object.keys(m).forEach(k => { t[k] = (t[k] || 0) + (m[k] || 0); }));
    if ('used_n' in t) t.avg = t.used_n ? t.used / t.used_n : 0;
    if ('util' in t) t.util = t.alloc > 0 ? t.used / t.alloc * 100 : 0;
    return t;
  }
  function metricTable(title, cols, data, total, rows) {
    const head = `<tr><th>${esc(title)}</th>${cols.map(c => `<th class="num"><i class="pv-key" style="background:${c.cfg.color}"></i>${esc(c.cfg.short)}</th>`).join('')}${total ? '<th class="num">Total</th>' : ''}</tr>`;
    const body = rows.map(([lbl, k, f]) => `<tr><td>${esc(lbl)}</td>${data.map((m, i) => `<td class="num">${cols[i].has ? f(m[k]) : '—'}</td>`).join('')}${total ? `<td class="num pv-tot">${f(total[k])}</td>` : ''}</tr>`).join('');
    return `<table class="pv-table pv-cmp"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }
  function renderComparison(view) {
    const el = $('pc-body'); if (!el) return;
    const cols = PV().activeList().filter(p => PV().inView(p.code)).map(p => ({ code: p.code, cfg: p, has: PV().raw(p.code).hasData }));
    // Vehicle-mapped = rows with a vehicle from the vehicle master; a provider's "No vehicle" rows are counted apart
    const A = cols.map(c => vehMetrics(view.CD.vehicles.filter(v => provOf(v) === c.code && !v.unmapped && gf(v))));
    const U = cols.map(c => view.CD.vehicles.filter(v => provOf(v) === c.code && v.unmapped && gf(v)).length);
    const B = cols.map(c => simMetrics(view.rtRows.filter(r => provOf(r) === c.code && gf(r))));
    const multi = cols.length > 1;
    const m = PV().selectedMonth();
    const rowsA = [['Vehicles', 'vehicles', n0], ['With an active plan', 'with_plan', n0], ['SIM status Active', 'active', n0],
      ['Allocated data', 'alloc', gb], ['Used data', 'used', gb], ['Remaining data', 'remaining', gb],
      ['Average use per SIM with usage', 'avg', gb], ['High usage (≥ 90%)', 'high', n0], ['Over plan (≥ 100%)', 'exceeded', n0],
      ['Low usage (< 5%)', 'low', n0], ['Monthly plan cost (active)', 'cost', inr]];
    const rowsB = [['SIMs', 'sims', n0], ['Active', 'active', n0], ['Allocated', 'alloc', gb], ['Used', 'used', gb],
      ['Available', 'avail', gb], ['Utilisation', 'util', v => pct(v)], ['Over allocation (100%)', 'exceeded', n0],
      ['Wasted (< 5% used)', 'wasted', n0], ['No plan / not active', 'no_plan', n0]];
    const withData = cols.filter(c => c.has);
    const sources = cols.filter(c => c.cfg.simSource).map(c => `${esc(c.cfg.short)}: ${esc(c.cfg.simSource)}`).join(' · ');
    let html = `<div class="pv-note">${multi ? 'Each provider keeps its own calculations — the Total column only adds them up.' : 'Select <b>All Providers</b> in the header to compare side by side.'}
      Fleet figures use vehicle-mapped SIMs for the ${m === 'latest' ? 'latest period' : esc(m)}; account figures use each provider's latest SIM-level data${sources ? ` (${sources})` : ''}.</div>`;
    // SIMs that no vehicle claims: the vehicle master is where SIM → vehicle mapping comes from
    cols.forEach((c, i) => {
      if (c.has && (B[i].sims > 0 || U[i] > 0) && A[i].vehicles === 0) html += `<div class="pv-warn">${esc(c.cfg.short)}: ${n0(Math.max(B[i].sims, U[i]))} SIMs, but none match a vehicle. SIM → vehicle mapping comes from the vehicle master — upload a vehicles file that contains these SIM numbers and push it (☁️ Cloud → Push Vehicle Master).</div>`;
      else if (c.has && U[i] > 0) html += `<div class="pv-warn">${esc(c.cfg.short)}: ${n0(U[i])} SIM(s) have no vehicle number in the vehicle master — the vehicle tabs list them as "No vehicle · mobile no."; the fleet figures below leave them out. Upload a vehicles file with these SIM numbers and push it (☁️ Cloud → Push Vehicle Master).</div>`;
    });
    html += `<div class="pv-2col"><div class="pv-card">${metricTable('Fleet · vehicle-mapped SIMs', cols, A, multi ? sumOf(A) : null, rowsA)}</div>`
      + `<div class="pv-card">${metricTable('Account · all SIMs', cols, B, multi ? sumOf(B) : null, rowsB)}</div></div>`;
    // Monthly usage (vehicle-mapped) — one axis, GB
    const months = PV().sortMonths([...new Set(view.trData.filter(v => !v.unmapped).flatMap(v => (v.months || []).map(x => x.label)))]);
    if (months.length && withData.length) {
      const tot = {};
      view.trData.forEach(v => { if (v.unmapped || !gf(v)) return; (v.months || []).forEach(x => { const k = x.label + '|' + provOf(v); tot[k] = (tot[k] || 0) + (x.used_mb || 0) / 1024; }); });
      const series = withData.map(c => ({ key: c.code, name: c.cfg.short, color: c.cfg.color }));
      const cats = months.map(l => ({ key: l, label: l, short: l.replace(/^(\w{3}) \d{2}(\d{2})$/, '$1 ’$2') }));
      html += `<div class="pv-card"><div class="pv-card-t">Monthly data used · vehicle-mapped SIMs</div>`
        + columnChart({ series, cats, val: (c, s) => tot[c + '|' + s] || 0, height: 130, width: 900, aria: 'Monthly data used per provider' })
        + tableView(['Month', ...series.map(s => s.name + ' (GB)')], months.map(l => [l, ...series.map(s => (Math.round((tot[l + '|' + s.key] || 0) * 100) / 100).toLocaleString())]))
        + withData.filter(c => c.cfg.cycle).map(c => `<div class="pv-muted">${esc(c.cfg.short)}: ${esc(c.cfg.cycle)}.</div>`).join('') + '</div>';
    }
    el.innerHTML = html;
  }

  /* ── Data Pool panel ───────────────────────────────────────── */
  function meter(p) {
    const f = Math.max(0, Math.min(100, p));
    const c = typeof window.barColor === 'function' ? window.barColor(p) : '#60a5fa';
    return `<div class="pv-meter" role="meter" aria-valuenow="${p.toFixed(1)}" aria-valuemin="0" aria-valuemax="100"><div style="width:${f}%;background:${c}"></div></div>`;
  }
  function tile(lbl, val, sub, cls) { return `<div class="dgr ${cls || ''}"><div class="dgr-lbl">${esc(lbl)}</div><div class="dgr-val">${val}</div><div class="dgr-sub">${sub}</div></div>`; }
  // Pool figures keep two decimals (85 ÷ 30 = 2.83 GB a day adds up to fractions of a GB)
  const g2 = v => (v == null || !isFinite(v) ? '—' : (Math.round(v * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' GB');
  const g2n = v => (v == null || !isFinite(v) ? '' : (Math.round(v * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  // "249 SIMs × 85 GB + 15 SIMs pro-rated (1,082.33 GB)"
  const sims = n => `${n0(n)} SIM${n === 1 ? '' : 's'}`;
  function mixText(pool) {
    const full = (pool.plan_mix || []).map(m => `${sims(m.sims)} × ${gb(m.gb)}`).join(' + ');
    const pr = pool.prorated && pool.prorated.sims ? `${sims(pool.prorated.sims)} pro-rated (${g2(pool.prorated.gb)})` : '';
    return [full, pr].filter(Boolean).join(' + ') || sims(pool.pooled_sims);
  }
  const SRC = { vi_date: 'activation date', detected: 'detected go-live' };
  // How the pool is built: full-cycle SIMs + each start day's pro-rated SIMs — shown even when every SIM
  // gets its full plan, so "85 GB → this cycle's data" is always visible
  function prorationTable(cfg, pool) {
    const pr = pool.prorated;
    if (!pr || !(pr.sims || (pool.plan_mix || []).length)) return '';
    const days = pool.days_total || (pool.cycle && pool.cycle.days) || '';
    const rows = (pool.plan_mix || []).map(m => `<tr><td>Full cycle · ${esc(gb(m.gb))} plan</td><td class="num">${n0(m.sims)}</td><td class="num">${days}</td><td class="num">${g2(m.gb)}</td><td class="num">${g2(m.gb * m.sims)}</td></tr>`)
      .concat(pr.groups.map(g => `<tr><td>${g.src === 'detected' ? 'Went live' : 'Activated'} ${esc(shortDate(g.from))} · ${esc(gb(g.plan_gb))} plan${g.src === 'detected' ? ' <span class="pv-muted">(detected)</span>' : ''}</td><td class="num">${n0(g.sims)}</td><td class="num">${g.days}</td><td class="num">${g.days} × ${g2(g.per_day_gb)} = ${g2(g.gb)}</td><td class="num">${g2(g.total_gb)}</td></tr>`)).join('');
    return `<div class="pv-card"><div class="pv-card-t">How the pool is built · ${esc(pool.cycle ? pool.cycle.label + ' cycle' : '')}${days ? ` (${days} days)` : ''} <span class="pv-muted">· started before the cycle = full plan; during the cycle = plan ÷ ${pr.divisor_days} per day left, start day included${pr.sims ? '' : ' — no SIM started during this cycle'}. Start = the SIM Group's activation date, or the detected go-live day of a SIM that was Ready in an older SIM Group file.</span></div>
      <div class="tw"><table class="pv-table"><thead><tr><th>SIMs</th><th class="num">Count</th><th class="num">Days in cycle</th><th class="num">Allocation per SIM</th><th class="num">Allocated</th></tr></thead>
      <tbody>${rows}<tr><td class="pv-tot">Total pool</td><td class="num pv-tot">${n0(pool.pooled_sims)}</td><td></td><td></td><td class="num pv-tot">${g2(pool.capacity_gb)}</td></tr></tbody></table></div></div>`;
  }
  const poolPeriod = (pool, ds) => (pool.period_start ? `${shortDate(pool.period_start)} – ${shortDate(pool.period_end)}` : (ds.currentMonth || ''));
  // Which day the figures describe, and when usage resets
  function poolDay(pool) {
    const bits = [];
    if (pool.as_of) bits.push(`day ${pool.days_elapsed} of ${pool.days_total}`);          // the date itself is on the "As of" chip
    else if (pool.complete) bits.push('cycle complete');
    else if (pool.days_elapsed) bits.push(`data to ${shortDate(pool.data_date)} · day ${pool.days_elapsed} of ${pool.days_total}`);
    if (pool.cycle && pool.cycle.resets) bits.push(`${pool.complete && !pool.as_of ? 'usage reset on' : 'resets on'} ${shortDate(pool.cycle.resets)}`);
    return bits.join(' · ');
  }
  const usedLbl = pool => (pool.as_of ? `Used by ${shortDate(pool.as_of)}` : 'Used this cycle');
  // "Data Usage Summary to 5 Oct 2026" — the pool's used figures come from whichever report reaches later
  const usedSrc = pool => (pool.usage_src_name ? `${pool.usage_src_name}${pool.data_date ? ' to ' + shortDate(pool.data_date) : ''}` : '');
  const latestBtn = code => `<button type="button" class="ps-link" onclick="ProvidersUI.pickLatest('${esc(code)}')" title="Back to the latest day with data">Latest day ↺</button>`;
  const ALERT = { critical: ['🔴', 'Critical'], warning: ['⚠️', 'Warning'], info: ['ℹ️', 'Info'] };

  /* ── VI Operations: level, risk, forecast, burn rate, zero / high SIMs, SIM detail ──────────────── */
  const LEVEL = { critical: ['🚨', 'Critical'], warning: ['⚠️', 'Warning'], healthy: ['✅', 'Healthy'], closed: ['🔒', 'Cycle closed'] };
  const lvlOf = l => LEVEL[l] || LEVEL.healthy;
  const lvlBadge = l => `<span class="ops-lvl ops-${esc(l || 'healthy')}">${lvlOf(l)[0]} ${lvlOf(l)[1]}</span>`;
  const days1 = v => (v == null || !isFinite(v) ? '—' : (Math.round(v * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' day' + (Math.round(v * 10) === 10 ? '' : 's'));
  const dDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const svgDays = (a, b) => { const out = []; if (!a || !b) return out; for (let t = Date.parse(a + 'T00:00:00Z'); t <= Date.parse(b + 'T00:00:00Z'); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
  const WDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayLbl = d => `${WDAY[new Date(d + 'T00:00:00Z').getUTCDay()]} ${shortDate(d)}`;
  const shortDay = d => { const m = String(d).match(/^\d{4}-(\d{2})-(\d{2})/); return m ? `${+m[2]} ${MON[+m[1] - 1]}` : d; };
  // One sentence for the operations banner — the shared pool, never a single SIM
  // "1.6 days" — or hours when under a day ("15 hours"), so "runs out 21 Oct, before the cycle ends 21 Oct" reads right
  const gapTxt = f => (f.gap_days < 1 ? `${Math.max(1, Math.round(f.gap_days * 24))} hours` : days1(f.gap_days));
  const ageTxt = f => (f.data_age_days == null ? '' : f.data_age_days === 0 ? 'today' : f.data_age_days === 1 ? '1 day old' : `${f.data_age_days} days old`);
  // The pool may already have run out: the run-out day is today or earlier and newer data has not been uploaded
  const mayHaveRunOut = (pool, f) => !!(f.exhaustion_date && pool.today && f.exhaustion_date <= pool.today && f.data_age_days > 0);
  function opsHeadline(pool) {
    const f = pool.forecast || {};
    if (pool.as_of) return `As of ${shortDate(pool.as_of)}: ${pct(f.projected_pct, 1)} of the pool projected by ${shortDate(f.cycle_end)}.`;
    if (f.ended) return `The ${pool.cycle ? pool.cycle.label + ' ' : ''}cycle ended on ${shortDate(f.cycle_end)} without its final usage report — usage has reset. Upload the new cycle's reports.`;
    const stale = mayHaveRunOut(pool, f) ? ` It may already have run out — the newest data is from ${shortDate(f.data_day)}; upload the newest report.` : '';
    if (pool.level === 'critical') return f.remaining_gb <= 0
      ? `Shared pool used up — devices may go offline until ${shortDate(pool.cycle && pool.cycle.resets)}. Arrange backup data now.`
      : `Shared pool runs out around ${shortDate(f.exhaustion_date)}${f.exhaustion_date === f.cycle_end ? ' — the last day of the cycle,' : ' —'} ${gapTxt(f)} before the cycle ends (${shortDate(f.cycle_end)}). Arrange at least ${n0(Math.ceil(f.shortfall_gb))} GB of backup data — ${n0(f.backup_gb)} GB with the ${f.backup_margin_pct}% margin.${stale}`;
    if (pool.level === 'warning') {
      const w = f.why || [];
      return `Tight — ${pct(f.projected_pct, 1)} of the pool projected by ${shortDate(f.cycle_end)}${f.exhaustion_date ? `; runs out around ${shortDate(f.exhaustion_date)}` : ''}${w.includes('projected_over_unconfirmed') ? ' — Critical if the next upload confirms it' : w.includes('new_sims_unmeasured') ? ' — counting new SIMs not measured yet' : w.includes('spike') ? ' — after one unusually heavy day' : ''}. Keep backup data ready.${stale}`;
    }
    if (pool.level === 'closed') return `Cycle closed — ${pct(pool.util_pct, 1)} of the pool used.`;
    return `Lasts the cycle — ${pct(f.projected_pct, 1)} of the pool projected by ${shortDate(f.cycle_end)}.`;
  }
  // "Since data to 26 Sep: runs out 21 Oct → 19 Oct · backup 620 → 2,460 GB" — what the newest upload changed
  function changeLine(pool, alert) {
    const f = pool.forecast || {}, pr = alert && alert.status === 'open' && alert.details ? alert.details.prev : null;
    if (!pr || !pr.data_day || pr.data_day === f.data_day || pool.as_of) return '';
    const bits = [];
    if ((pr.exhaustion_date || null) !== (f.exhaustion_date || null)) bits.push(`runs out ${pr.exhaustion_date ? shortDay(pr.exhaustion_date) : 'after the cycle'} → ${f.exhaustion_date ? shortDay(f.exhaustion_date) : 'after the cycle'}`);
    if (Math.round(pr.backup_gb || 0) !== Math.round(f.backup_gb || 0)) bits.push(`backup ${n0(pr.backup_gb || 0)} → ${n0(f.backup_gb || 0)} GB`);
    if (pr.projected_pct != null && Math.abs(pr.projected_pct - f.projected_pct) >= 0.1) bits.push(`${pct(pr.projected_pct, 1)} → ${pct(f.projected_pct, 1)} projected`);
    return bits.length ? `Since data to ${shortDate(pr.data_day)}: ${bits.join(' · ')}` : '';
  }
  const goPool = (code, section) => { if (typeof window.showTab === 'function') window.showTab('pool'); setTimeout(() => { const el = $(`pv-${section}-${code}`); if (el) { if (el.tagName === 'DETAILS') el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, 60); };

  /* operations block above every tab (one row per pooled provider in view) */
  function renderPoolStrip(view) {
    const el = $('pool-strip'); if (!el) return;
    const html = (view.parts || []).filter(p => p.ds.pool && p.ds.pool.hasPool).map(p => {
      const pool = p.ds.pool, cfg = PV().get(p.c), f = pool.forecast || {}, over = pool.remaining_gb < 0, z = pool.zero || {}, pc = f.pace;
      const lasts = f.lasts_days === Infinity ? 'no usage yet' : `${days1(f.lasts_days)} vs ${days1(f.days_left)} left`;
      const chg = changeLine(pool, p.ds.poolAlert), age = !pool.as_of && f.data_age_days > 1 ? ` <span class="ps-est" title="Upload the newest VI reports">data ${esc(ageTxt(f))}</span>` : '';
      const closed = pool.complete || f.ended;
      return `<div class="ops-row ops-r-${esc(pool.level)}" style="--pc:${cfg.color}" role="region" aria-label="${esc(cfg.short)} shared data pool">
        <div class="ops-h">${lvlBadge(pool.level)}<b>${esc(cfg.short)} shared data pool</b>${pool.as_of ? `<span class="ps-asof">📅 As of ${esc(shortDate(pool.as_of))}</span>` : ''}${pool.frozen ? '<span class="ps-frozen">🔒 Frozen</span>' : ''}${pool.provisional ? '<span class="ps-est">Provisional</span>' : ''}${age}<span class="ops-msg">${esc(opsHeadline(pool))}${chg ? `<span class="ops-chg">${esc(chg)}</span>` : ''}</span></div>
        <div class="ops-cells">
          <div class="ps-c"><div class="ps-k">Total pool</div><div class="ps-v">${g2(pool.capacity_gb)}</div><div class="ps-s">${n0(pool.eligible_sims)} of ${n0(pool.inventory_sims)} SIMs count</div></div>
          <div class="ps-c"><div class="ps-k">${esc(pool.as_of ? usedLbl(pool) : 'Used')}</div><div class="ps-v">${g2(pool.used_gb)}</div><div class="ps-s">${pct(pool.util_pct, 2)} · ${esc(usedSrc(pool))}${!pool.as_of && f.data_age_days != null ? ` (${esc(ageTxt(f))})` : ''}</div></div>
          <div class="ps-c"><div class="ps-k">${over ? 'Over the pool by' : 'Remaining'}</div><div class="ps-v">${g2(Math.abs(pool.remaining_gb))}</div><div class="ps-s">${closed ? 'cycle closed' : pc ? `${g2(pc.burn_gb_day)} a day now · ${g2(pc.gb_sim_day)} per SIM` : `${g2(f.avg_gb_day)} a day on average`}</div></div>
          ${closed ? '' : `<div class="ps-c ops-risk"><div class="ps-k">Pool lasts</div><div class="ps-v">${esc(f.exhaustion_date ? '~' + shortDay(f.exhaustion_date) : 'whole cycle')}</div><div class="ps-s">${esc(lasts)}${f.backup_gb ? ` · backup ${n0(f.backup_gb)} GB` : ''}</div></div>`}
          <div class="ps-m">${meter(pool.util_pct)}<div class="ps-s">${closed || !pool.days_elapsed ? '' : `${pct(pool.projected_pct, 0)} projected by ${esc(shortDay(f.cycle_end))}`}</div></div>
          ${z.count != null ? `<button type="button" class="ops-zero-btn" onclick="ProvidersUI.goPool('${esc(p.c)}','zero')" title="SIMs in the pool that used no data this cycle"><span class="ps-k">Zero usage</span><span class="ps-v">${n0(z.count)}</span><span class="ps-s">${n0(z.long_term)} for ${n0(z.long_days)}+ days</span></button>` : ''}
        </div>
        <div class="ops-act">${pool.as_of ? latestBtn(p.c) : ''}<button type="button" class="ps-link" onclick="ProvidersUI.goPool('${esc(p.c)}','forecast')">View pool forecast →</button></div>
      </div>`;
    }).join('');
    el.innerHTML = html;
    el.style.display = html ? '' : 'none';
  }

  /* one-time pop-up for a Critical shared-pool alert (per alert, per browser); the banner stays */
  const POP_KEY = 'dbai_pool_popups_seen';
  const seenPopups = () => { try { return JSON.parse(localStorage.getItem(POP_KEY) || '[]'); } catch (e) { return []; } };
  const markPopup = k => { try { localStorage.setItem(POP_KEY, JSON.stringify(seenPopups().filter(x => x !== k).concat(k).slice(-50))); } catch (e) { /* private window */ } };
  let pop = null;                                   // the open pop-up: { code, key, box }
  function maybePopup(view) {
    const parts = view.parts || [];
    const critical = p => p.ds.pool && p.ds.pool.hasPool && !p.ds.pool.as_of && p.ds.pool.level === 'critical' && p.ds.poolAlert && p.ds.poolAlert.level === 'critical';
    // one pop-up per announcement: a new Critical, an escalation, or a much worse forecast (details.seq counts them)
    // an alert that is not stored (no sql/003, a viewer, a failed write) is keyed by its cycle, so Dismiss holds across reloads
    const keyOf = p => { const al = p.ds.poolAlert; return `${p.c}|${al.persisted ? al.id : p.ds.poolMonth}|${(al.details && al.details.seq) || 1}`; };
    // dismissed before announcements were numbered (key "…|critical"): that is announcement 1
    const seen = (p, key) => { const s = seenPopups(), al = p.ds.poolAlert; return s.includes(key) || ((!al.details || (al.details.seq || 1) === 1) && s.includes(`${p.c}|${al.persisted ? al.id : p.ds.poolMonth}|critical`)); };
    // An open pop-up always shows the newest figures (dismissing it covers the newest announcement) — and goes away if
    // the pool is no longer Critical
    if (pop && document.body.contains(pop.box)) {
      const p = parts.find(x => x.c === pop.code);
      if (p && critical(p)) { pop.box.querySelector('.ops-pop-body').innerHTML = popupBody(PV().get(p.c), p.ds.pool, p.ds.poolAlert); pop.key = keyOf(p); }
      else if (p) { pop.box.remove(); pop = null; }
      return;
    }
    for (const p of parts) {
      if (!critical(p)) continue;                    // waits for the evaluated alert, so the key stays stable
      const al = p.ds.poolAlert, key = keyOf(p);
      if (seen(p, key)) continue;
      showPopup(PV().get(p.c), p.ds.pool, key, al);
      break;
    }
  }
  function popupBody(cfg, pool, alert) {
    const f = pool.forecast || {}, pc = f.pace, d = (alert && alert.details) || {};
    const row = (k, v) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`;
    const chg = changeLine(pool, alert), again = (d.seq || 1) > 1;
    return `<p id="ops-pop-d">${esc(f.remaining_gb <= 0 ? `The ${cfg.short} shared data pool is used up. Devices may go offline until the cycle resets.` : `The ${cfg.short} shared data pool is projected to run out before the next billing cycle. All devices on the pool may go offline.`)}</p>
      ${again ? `<p class="ops-chg"><b>Worse than the last alert.</b> ${esc(chg)}</p>` : chg ? `<p class="ops-chg">${esc(chg)}</p>` : ''}
      <table class="pv-table"><tbody>
        ${row('Total pool', g2(f.pool_gb))}${row('Used', `${g2(f.used_gb)} <span class="pv-muted">(${esc(usedSrc(pool))}${f.data_age_days != null ? ', ' + esc(ageTxt(f)) : ''})</span>`)}${row('Remaining', g2(f.remaining_gb))}
        ${pc ? row('Current pace', `${g2(pc.burn_gb_day)} / day <span class="pv-muted">(${esc(g2(pc.gb_sim_day))} per SIM × ${n0(pc.sims_now)} SIMs)</span>`) : ''}
        ${row('Cycle average', g2(f.avg_gb_day) + ' / day')}${row('Estimated exhaustion', esc(f.exhaustion_date ? shortDate(f.exhaustion_date) : 'now') + (mayHaveRunOut(pool, f) ? ' <span class="pv-muted">(may already have happened — upload the newest report)</span>' : ''))}
        ${row('Billing cycle ends', esc(shortDate(f.cycle_end)))}${row('Potential gap', esc(gapTxt(f)))}
        ${row('Recommended backup', `<b>${n0(f.backup_gb)} GB</b> <span class="pv-muted">(shortfall ${g2(f.shortfall_gb)} + ${f.backup_margin_pct}%, rounded up to ${f.backup_round_gb} GB)</span>`)}
      </tbody></table>
      <p class="pv-muted">Recommended action: arrange backup data / additional pool. This warning stays on the dashboard until the forecast is healthy again.</p>`;
  }
  function showPopup(cfg, pool, key, alert) {
    const box = document.createElement('div');
    box.id = 'ops-pop'; box.className = 'ops-pop';
    box.innerHTML = `<div class="ops-pop-card" role="alertdialog" aria-modal="true" aria-labelledby="ops-pop-t" aria-describedby="ops-pop-d">
      <div class="ops-pop-h" id="ops-pop-t">🚨 ${esc(cfg.short)} shared pool alert</div><div class="ops-pop-body">${popupBody(cfg, pool, alert)}</div>
      <div class="ops-pop-a"><button type="button" class="ps-link" data-pop="close">Dismiss</button><button type="button" class="vi-switch" data-pop="view">View pool analysis</button></div></div>`;
    document.body.appendChild(box);
    pop = { code: cfg.code, key, box };
    const close = view => { markPopup(pop ? pop.key : key); box.remove(); pop = null; document.removeEventListener('keydown', onKey); if (view) goPool(cfg.code, 'forecast'); };
    const onKey = e => { if (e.key === 'Escape') close(false); };
    box.addEventListener('click', e => { const b = e.target.closest('[data-pop]'); if (b) close(b.dataset.pop === 'view'); else if (e.target === box) close(false); });
    document.addEventListener('keydown', onKey);
    const first = box.querySelector('[data-pop="view"]'); if (first) first.focus();
  }

  /* SVG line / area chart in the dashboard's style — one axis, thin marks, dashed reference, hover + focus tooltips */
  function svgChart({ dates, series, ref = null, vlines = [], shade = null, height = 210, fmt = gb, aria = '', tip }) {
    // drawn at about the width it is shown at (phones: ~300 px) so the labels keep their size instead of shrinking
    const W = Math.round(Math.max(300, Math.min(760, (window.innerWidth || 760) - 72)));
    const H = height, L = 60, R = 14, T = 16, B = 26, iw = W - L - R, ih = H - T - B, n = dates.length;
    if (!n) return '';
    const xs = i => L + (n === 1 ? iw / 2 : i * iw / (n - 1));
    let max = ref ? ref.value : 0;
    series.forEach(s => dates.forEach(d => { const v = s.points[d]; if (v != null && v > max) max = v; }));
    const top = niceMax(max * 1.04 || 1), ys = v => T + ih - Math.max(0, v) / top * ih;
    const at = new Map(dates.map((d, i) => [d, i]));
    let g = '';
    if (shade) for (let i = 0; i < n;) {
      if (!shade(dates[i])) { i++; continue; }
      let j = i; while (j + 1 < n && shade(dates[j + 1])) j++;
      const x0 = i ? (xs(i - 1) + xs(i)) / 2 : L, x1 = j < n - 1 ? (xs(j) + xs(j + 1)) / 2 : L + iw;
      g += `<rect class="sv-nodata" x="${x0.toFixed(1)}" y="${T}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${ih}"/>`; i = j + 1;
    }
    [0, 0.5, 1].forEach(f => { const y = ys(top * f).toFixed(1); g += `<line class="sv-grid${f ? '' : ' sv-base'}" x1="${L}" x2="${L + iw}" y1="${y}" y2="${y}"/><text class="sv-yl" x="${L - 6}" y="${(+y + 3.5).toFixed(1)}">${esc(f ? fmt(top * f) : '0')}</text>`; });
    const step = Math.max(1, Math.ceil(n / Math.max(3, Math.min(7, Math.floor(iw / 64)))));
    dates.forEach((d, i) => { if ((i % step === 0 && n - 1 - i >= step / 2) || i === n - 1) g +=`<text class="sv-xl" x="${xs(i).toFixed(1)}" y="${H - 8}">${esc(shortDay(d))}</text>`; });
    vlines.forEach(v => { const i = at.get(v.date); if (i == null) return; const x = xs(i).toFixed(1); const left = +x > L + iw * 0.7;   // near the right edge: label on the left of the line
      g += `<line class="sv-v ${v.cls || ''}" x1="${x}" x2="${x}" y1="${T}" y2="${T + ih}"/><text class="sv-vl ${v.cls || ''}" x="${(+x + (left ? -4 : 4)).toFixed(1)}" y="${T + 10 + (v.row || 0) * 12}"${left ? ' text-anchor="end"' : ''}>${esc(v.label)}</text>`; });
    if (ref) { const y = ys(ref.value).toFixed(1); g += `<line class="sv-ref" x1="${L}" x2="${L + iw}" y1="${y}" y2="${y}"/><text class="sv-refl" x="${L + iw}" y="${(+y - 4).toFixed(1)}">${esc(ref.label)}</text>`; }
    series.forEach(s => {
      const segs = []; let cur = [];
      dates.forEach((d, i) => { const v = s.points[d]; if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([xs(i), ys(v), d, v]); });
      if (cur.length) segs.push(cur);
      segs.forEach(sg => {
        const path = sg.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
        if (s.area && sg.length > 1) g += `<path class="sv-area" d="${path}L${sg[sg.length - 1][0].toFixed(1)},${T + ih}L${sg[0][0].toFixed(1)},${T + ih}Z" style="fill:${s.color}"/>`;
        g += `<path class="sv-line${s.dash ? ' sv-dash' : ''}" d="${path}" style="stroke:${s.color}"/>`;
        if (s.markers) sg.forEach(p => { const m = s.mark ? s.mark(p[2], p[3]) : ''; g += `<circle class="sv-dot ${m}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${m === 'sv-high' ? 4.2 : m === 'sv-zero' || m === 'sv-up' ? 3.4 : 2.6}"${m === 'sv-zero' ? '' : m === 'sv-up' ? ` style="stroke:${s.color}"` : ` style="fill:${s.color}"`}/>`; });
      });
    });
    dates.forEach((d, i) => {
      const t = tip ? tip(d) : null; if (!t) return;
      const x0 = i ? (xs(i - 1) + xs(i)) / 2 : L, x1 = i < n - 1 ? (xs(i) + xs(i + 1)) / 2 : L + iw;
      g += `<rect class="sv-hit" tabindex="0" data-tipbar data-v="${esc(t.v)}" data-l="${esc(t.l)}" data-c="${esc(t.c || '')}" x="${x0.toFixed(1)}" y="${T}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${ih}"/>`;
    });
    const legend = `<div class="pv-legend">${series.map(s => `<span><i class="${s.dash ? 'lg-dash' : ''}" style="${s.dash ? `border-color:${s.color}` : `background:${s.color}`}"></i>${esc(s.name)}</span>`).join('')}${ref ? `<span><i class="lg-ref"></i>${esc(ref.legend || ref.label)}</span>` : ''}${shade ? '<span><i class="lg-nodata"></i>No data</span>' : ''}</div>`;
    return `${legend}<div class="pv-svg"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${g}</svg></div>`;
  }

  /* Data Pool tab: forecast, burn rate, zero usage, high usage, alert history */
  function forecastCard(cfg, pool) {
    const f = pool.forecast; if (!f) return '';
    const row = (k, v, how) => `<tr><td>${esc(k)}</td><td class="num">${v}</td><td class="pv-why">${how || ''}</td></tr>`;
    const T = f.thresholds, pc = f.pace, rq = f.req || {};
    const why = { used_up: 'the pool is used up', runs_out_soon: `the pool runs out within ${T.critical_lead_days} days`,
      projected_over: `projected use is above the pool on 2 data days in a row (after ${T.critical_min_days}+ days of data)`,
      projected_over_early: `projected use is above the pool, but Critical needs ${T.critical_min_days} days of data`,
      projected_over_unconfirmed: 'projected use is above the pool on this data day — Critical when the next upload confirms it',
      new_sims_unmeasured: 'over the pool only because SIMs with no data yet are assumed to use data like the rest',
      projected_high: `projected use ≥ ${T.warning_projected_pct}% of the pool`, average_over: 'the cycle average × cycle days is above the pool',
      spike: 'one unusually heavy day — not carried forward' };
    const backupHow = f.shortfall_gb > 0 ? `shortfall ${g2(f.shortfall_gb)} × ${(1 + f.backup_margin_pct / 100).toFixed(2)} = ${g2(f.shortfall_gb * (1 + f.backup_margin_pct / 100))}, rounded up to ${f.backup_round_gb} GB` : 'no shortfall at the current pace';
    const SRCN = { summary: 'Data Usage Summary', itemized: 'Itemized report' };
    const paceHow = !pc ? '' : pc.basis === 'jump'
      ? `the newest ${pc.jump.days} days (${shortDay(pc.jump.from)} – ${shortDay(pc.jump.to)}) all ran ≥ ${T.jump_pct}% above the ${T.recent_days}-day pace (${g2(pc.window_gb_sim_day)}) — a jump that lasts, so it is used`
      : pc.window ? `${n0(pc.window.days)} newest days (${shortDay(pc.window.from)} – ${shortDay(pc.window.to)}, ${SRCN[pool.usage_src] || 'usage report'}): ${g2(pc.window.gb)} ÷ ${n0(Math.round(pc.window.sd))} SIM-days${pc.basis === 'cycle' ? ' — the whole cycle so far' : ''}` : '';
    const sk = pc && pc.spike, skX = sk ? (sk.peak_x || sk.gb_sim_day / sk.median_gb_sim_day).toFixed(1) : '';
    const spikeHow = !sk ? '' : sk.days > 1
      ? `${shortDay(sk.from)} – ${shortDate(sk.date)} (one upload, ${sk.days} days): ${g2(sk.gb)} — one day up to ${skX}× a normal day; its extra ${g2(sk.excess_gb)} is counted once, not carried forward`
      : `${shortDate(sk.date)}: ${g2(sk.gb)} (${skX}× a normal day) — its extra ${g2(sk.excess_gb)} is counted once, not carried forward`;
    const confirmHow = f.prev ? `previous data day ${shortDate(f.prev.as_of)}: ${g2(f.prev.projected_gb)} projected of ${g2(f.prev.pool_gb)} — ${f.confirmed ? 'over the pool too' : 'within the pool'}` : 'no earlier data day in this cycle yet';
    const closed = pool.complete || f.ended;
    return `<div class="pv-card" id="pv-forecast-${esc(cfg.code)}"><div class="pv-card-t">Shared pool forecast ${lvlBadge(pool.level)} <span class="pv-muted">· the pool is the operational control: when it runs out, every device on it can go offline</span></div>
      <div class="ops-reason">${esc(opsHeadline(pool))}${f.why.length ? ` <span class="pv-muted">(${esc(f.why.map(w => why[w] || w).join('; '))})</span>` : ''}</div>
      <div class="tw"><table class="pv-table ops-fc"><thead><tr><th>Item</th><th class="num">Value</th><th>How</th></tr></thead><tbody>
        ${row('Total pool', g2(f.pool_gb), 'Σ allocations of the SIMs that count')}
        ${row('Used', g2(f.used_gb), esc(usedSrc(pool) + (f.data_age_days != null ? ` (${ageTxt(f)})` : '')))}
        ${row('Remaining', g2(f.remaining_gb), 'pool − used')}
        ${row('Days elapsed / left', `${f.days_elapsed} / ${f.days_left}`, `of ${f.days_total} days · data to ${esc(shortDate(f.data_day))}`)}
        ${closed || !pc ? '' : `
        <tr class="ops-fc-h"><td colspan="3">Per-SIM pace — decides the level, run-out day and backup</td></tr>
        ${row('SIMs counting now', n0(pc.sims_now), `${n0(Math.round(pc.sd_elapsed))} SIM-days so far · ${n0(Math.round(pc.sd_left))} to come (each SIM from max(22nd, its start))${pc.new_sims ? ` · ${n0(pc.new_sims)} start after the data day` : ''}`)}
        ${row('Pace per SIM a day', g2(pc.gb_sim_day), esc(paceHow))}
        ${row('Allowed per SIM a day', g2(pc.alloc_gb_sim_day), `pool ÷ SIM-days of the cycle · whole cycle so far ${esc(g2(pc.cycle_gb_sim_day))} per SIM a day`)}
        ${spikeHow ? row('Heavy day', '—', esc(spikeHow)) : ''}
        ${row('Current pace', g2(pc.burn_gb_day) + ' / day', `pace per SIM × ${n0(pc.sims_now)} SIMs`)}
        ${row('Projected use', `${g2(f.projected_gb)} · ${pct(f.projected_pct, 1)}`, 'used + pace per SIM × SIM-days to come')}
        ${row('Pool lasts', f.lasts_days === Infinity ? '—' : days1(f.lasts_days), 'remaining, day by day at the pace × SIMs live that day')}
        ${row('Expected exhaustion', esc(f.exhaustion_date ? shortDate(f.exhaustion_date) : 'after the cycle ends') + (mayHaveRunOut(pool, f) ? ' <span class="pv-muted">(may already have happened)</span>' : ''), f.exhaustion_date ? `data day + ${Math.ceil(f.lasts_days)} days; cycle ends ${esc(shortDate(f.cycle_end))}` : '')}
        ${row('Gap before the cycle ends', f.exhaustion_date ? esc(gapTxt(f)) : '—', 'days left − pool lasts')}
        ${row('Shortfall', g2(f.shortfall_gb), 'max(0, projected − pool)')}
        ${row('Recommended backup', `<b>${f.backup_gb ? n0(f.backup_gb) + ' GB' : '—'}</b>`, esc(backupHow))}
        ${row('Confirmation', f.confirmed ? 'yes' : 'no', esc(confirmHow))}
        <tr class="ops-fc-h"><td colspan="3">Cycle average — the requirement's figures, for reference</td></tr>
        ${row('Average a day', g2(rq.avg_gb_day), 'used ÷ days elapsed')}
        ${row('Projected use', `${g2(rq.projected_gb)} · ${pct(rq.projected_pct, 1)}`, 'average × cycle days')}
        ${row('Pool lasts', rq.lasts_days === Infinity ? '—' : days1(rq.lasts_days), `remaining ÷ average${rq.exhaustion_date ? ` → ${esc(shortDate(rq.exhaustion_date))}` : ''}`)}`}
      </tbody></table></div>
      <div class="pv-muted pv-foot">Levels: Critical = the pool is used up, runs out within ${T.critical_lead_days} days, or projected use is above it on 2 data days in a row (after ${T.critical_min_days} days of data) · Warning = projected over the pool on one data day, ≥ ${T.warning_projected_pct}% of it, the cycle average over it, or one unusually heavy day · Healthy otherwise. Recalculated on every upload from the newest data. The pace is per SIM, so SIMs that start later add both their allocation and their expected usage — the forecast holds whether the fleet grows or shrinks.</div>
      ${burnChart(cfg, pool)}</div>`;
  }
  function burnChart(cfg, pool) {
    const b = pool.burn; if (!b || !b.actual.length) return '';
    const dates = svgDays(b.start, b.end);
    const actual = {}; b.actual.forEach(x => { actual[x.date] = x.gb; });
    const pl = b.pool.slice().sort((x, y) => x.date.localeCompare(y.date)), poolPts = {};
    let k = 0, curPool = pl.length ? pl[0].gb : b.cap;
    dates.forEach(d => { while (k < pl.length && pl[k].date <= d) { curPool = pl[k].gb; k++; } poolPts[d] = curPool; });
    const proj = {};
    b.projection.forEach(x => { proj[x.date] = x.gb; });       // day by day: bends upward on days new SIMs start
    const today = window.ViProvider && ViProvider.localToday ? ViProvider.localToday() : null;
    const vl = [];
    if (b.exhaustion) vl.push({ date: b.exhaustion, label: `runs out ~${shortDay(b.exhaustion)}`, cls: 'crit' });
    if (today && today >= b.start && today <= b.end) vl.push({ date: today, label: 'today', row: b.exhaustion ? 1 : 0 });
    const src = { itemized: 'Itemized', summary: 'Summary', upload: 'upload' };
    const chart = svgChart({ dates, height: 230, aria: 'Shared pool: used so far, projection and pool size per day', vlines: vl,
      series: [{ name: 'Used so far', color: cfg.color, markers: true, points: actual, mark: d => (b.actual.find(x => x.date === d) || {}).src === 'itemized' ? '' : 'sv-up' },
        { name: 'Projected (per-SIM pace)', color: cfg.color, dash: true, points: proj },
        { name: 'Pool size', color: '#9a9a9a', points: poolPts }],
      tip: d => ({ v: actual[d] != null ? `${gb(actual[d])} used` : proj[d] != null ? `${gb(proj[d])} projected` : `pool ${gb(poolPts[d])}`,
        l: `${dayLbl(d)} · pool ${gb(poolPts[d])}${proj[d] != null && actual[d] != null ? ` · projected ${gb(proj[d])}` : ''}${actual[d] != null ? ` · ${src[(b.actual.find(x => x.date === d) || {}).src] || ''}` : ''}`, c: cfg.color }) });
    const rows = dates.filter(d => actual[d] != null || proj[d] != null).map(d => [shortDate(d), actual[d] != null ? g2n(actual[d]) : '', proj[d] != null ? g2n(proj[d]) : '', g2n(poolPts[d])]);
    return `<div class="pv-card-t" style="margin-top:12px">Burn rate · ${esc(shortDate(b.start))} – ${esc(shortDate(b.end))} <span class="pv-muted">· used so far (dots = Itemized days; rings = usage uploads) against the pool, and where the per-SIM pace leads with the SIMs counting each day</span></div>`
      + chart + tableView(['Date', 'Used so far (GB)', 'Projected (GB)', 'Pool (GB)'], rows, 'Burn rate — table');
  }
  const csvDownload = (name, head, rows, textCols = []) => {
    const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = [head.join(',')].concat(rows.map(r => r.map((c, i) => (textCols.includes(i) && c ? '="' + c + '"' : q(c))).join(','))).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  };
  const simBtn = (code, iccid) => `<button type="button" class="pv-linkbtn mono" onclick="ProvidersUI.openSim('${esc(code)}','${esc(iccid)}')" title="Open this SIM's daily history">${esc(iccid)}</button>`;
  // Big lists (a fleet of any size): filtered on the data, drawn 100 rows at a time — the CSV always has every row.
  // The page and the filter survive a redraw.
  const PAGE_ROWS = 100, pagers = {};
  function pager(id, rows, row, match) { const p = pagers[id] || (pagers[id] = { page: 0, q: '', cat: 'all' }); Object.assign(p, { rows, row, match }); return pagerView(id); }
  function pagerView(id) {
    const p = pagers[id], list = p.rows.filter(r => p.match(r, p));
    const pages = Math.max(1, Math.ceil(list.length / PAGE_ROWS)); if (p.page >= pages) p.page = pages - 1;
    const body = list.slice(p.page * PAGE_ROWS, (p.page + 1) * PAGE_ROWS).map(p.row).join('');
    const nav = list.length > PAGE_ROWS
      ? `<button type="button" class="ps-link" ${p.page ? '' : 'disabled'} onclick="ProvidersUI.pagerGo('${id}',-1)">‹ Previous</button> <span class="pv-muted">${n0(p.page * PAGE_ROWS + 1)}–${n0(Math.min(list.length, (p.page + 1) * PAGE_ROWS))} of ${n0(list.length)}</span> <button type="button" class="ps-link" ${p.page < pages - 1 ? '' : 'disabled'} onclick="ProvidersUI.pagerGo('${id}',1)">Next ›</button>`
      : (p.q || p.cat !== 'all' ? `<span class="pv-muted">${n0(list.length)} shown</span>` : '');
    return { body, nav, n: list.length };
  }
  function pagerDraw(id) { const v = pagerView(id), tb = $('pg-b-' + id), nv = $('pg-n-' + id); if (tb) tb.innerHTML = v.body; if (nv) nv.innerHTML = v.nav; }
  function pagerGo(id, d) { const p = pagers[id]; if (!p) return; p.page = Math.max(0, p.page + d); pagerDraw(id); }
  const opsTables = {};
  const ZCAT = { new: 'Newly activated', no_usage: 'No usage', long_term: 'Long-term no usage' };
  const ZERO_HEAD = ['ICCID', 'Mobile', 'Vehicle', 'Status', 'Activation (VI)', 'Counts from', 'Days since start', 'Last usage', 'Days without data', 'Category', 'Plan cost (₹/month)', 'Recommended action'];
  const zeroCells = z => [z.iccid, z.msisdn, z.reg, z.state, z.vi_date || '', z.start ? `${z.start}${z.src === 'detected' ? ' (detected)' : ''}` : '', z.days_since_start == null ? '' : z.days_since_start,
    z.last_use || 'None in uploaded reports', z.idle_days == null ? '' : z.idle_days, ZCAT[z.category], z.price == null ? '' : z.price, z.action];
  function zeroCard(cfg, pool) {
    const z = pool.zero; if (!z) return '';
    opsTables['zero|' + cfg.code] = { z, cycle: pool.cycle ? pool.cycle.label : '' };
    const id = 'zero-' + cfg.code;
    const v = pager(id, z.list, r => `<tr>${zeroCells(r).map((c, i) => i === 0 ? `<td>${simBtn(cfg.code, r.iccid)}</td>` : `<td${i === 1 ? ' class="mono"' : [6, 8, 10].includes(i) ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`,
      (r, p) => p.cat === 'all' || r.category === p.cat);
    const cur = pagers[id].cat;
    const chip = (cat, label, n) => `<button type="button" class="ops-chip${cat === cur ? ' on' : ''}" data-cat="${cat}" data-pager="${id}" onclick="ProvidersUI.zeroFilter(this)">${esc(label)} <b>${n0(n)}</b></button>`;
    const from = pool.cycle ? shortDate(pool.cycle.start) : '';
    return `<details class="pv-card ops-zero" id="pv-zero-${esc(cfg.code)}"${z.long_term ? ' open' : ''}><summary class="pv-card-t">Zero-usage SIMs · ${n0(z.count)} <span class="pv-muted">· in the pool, no data from ${esc(from)} (or their start) to ${esc(shortDate(z.data_day))} · ${inr(z.cost)}/month</span></summary>
      <div class="ops-chips">${chip('all', 'All', z.count)}${chip('new', `Newly activated (< ${z.new_days} days)`, z.new)}${chip('no_usage', 'No usage', z.no_usage)}${chip('long_term', `Long-term (${z.long_days}+ days)`, z.long_term)}<button type="button" class="ps-link" onclick="ProvidersUI.zeroCsv('${esc(cfg.code)}')">⬇ CSV</button><span id="pg-n-${id}">${v.nav}</span></div>
      <div class="pv-muted" style="margin-bottom:8px">${z.long_term ? `${n0(z.long_term)} SIM(s) have had no data for ${z.long_days}+ days (${inr(z.long_term_cost)}/month) — review them and consider stopping them before the next cycle${pool.cycle ? ` (starts ${esc(shortDate(pool.cycle.resets))})` : ''}. ` : ''}The dashboard never closes or changes a SIM. ${z.ready_sims ? `${n0(z.ready_sims)} Ready SIMs (not live, ₹0) are not listed. ` : ''}Last usage comes from every report uploaded so far.</div>
      ${z.count ? `<div class="tw pv-sims-tw"><table class="pv-table"><thead><tr>${ZERO_HEAD.map((h, i) => `<th${[6, 8, 10].includes(i) ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody id="pg-b-${id}">${v.body}</tbody></table></div>` : '<div class="pv-muted">✅ Every SIM in the pool used data this cycle.</div>'}</details>`;
  }
  function zeroFilter(btn) {
    const id = btn.dataset.pager, p = pagers[id]; if (!p) return;
    btn.closest('.ops-zero').querySelectorAll('.ops-chip').forEach(b => b.classList.toggle('on', b === btn));
    p.cat = btn.dataset.cat; p.page = 0; pagerDraw(id);
  }
  function zeroCsv(code) {
    const t = opsTables['zero|' + code]; if (!t) return;
    csvDownload(`${code}_zero_usage_${String(t.cycle).replace(/\s+/g, '-')}.csv`, ZERO_HEAD, t.z.list.map(zeroCells), [0, 1]);
  }
  const HIGH_HEAD = ['ICCID', 'Mobile', 'Vehicle', 'Used (GB)', 'Days', 'GB / day', 'Daily allocation (GB)', '% of daily allocation', 'Above own allocation'];
  const highCells = h => [h.iccid, h.msisdn, h.reg, g2n(h.used_gb), h.days, g2n(h.gb_day), g2n(h.per_day), Math.round(h.pct) + '%', h.over_alloc ? 'Yes' : ''];
  function highCard(cfg, pool) {
    const h = pool.high; if (!h) return '';
    opsTables['high|' + cfg.code] = { h, cycle: pool.cycle ? pool.cycle.label : '' };
    const body = h.list.slice(0, 50).map(r => `<tr>${highCells(r).map((c, i) => i === 0 ? `<td>${simBtn(cfg.code, r.iccid)}</td>` : `<td${i === 1 ? ' class="mono"' : i >= 3 && i <= 7 ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('');
    return `<details class="pv-card" id="pv-high-${esc(cfg.code)}"><summary class="pv-card-t">High-usage SIMs · ${n0(h.count)} <span class="pv-muted">· this cycle's pace ≥ ${h.pct}% of their daily allocation — an analytical flag; the shared pool covers them</span></summary>
      <div class="ops-chips"><button type="button" class="ps-link" onclick="ProvidersUI.highCsv('${esc(cfg.code)}')">⬇ CSV</button>${h.count > 50 ? `<span class="pv-muted">top 50 of ${n0(h.count)} shown — the CSV has all</span>` : ''}</div>
      ${h.count ? `<div class="tw pv-sims-tw"><table class="pv-table"><thead><tr>${HIGH_HEAD.map((x, i) => `<th${i >= 3 && i <= 7 ? ' class="num"' : ''}>${esc(x)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>` : '<div class="pv-muted">No SIM above the threshold.</div>'}</details>`;
  }
  function highCsv(code) {
    const t = opsTables['high|' + code]; if (!t) return;
    csvDownload(`${code}_high_usage_${String(t.cycle).replace(/\s+/g, '-')}.csv`, HIGH_HEAD, t.h.list.map(highCells), [0, 1]);
  }
  function alertHistoryCard(cfg) {
    const f = hook(cfg.code, 'alertHistory'); if (!f) return '';
    const list = f() || [];
    const when = t => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
    const rows = list.slice(0, 50).map(a => { const d = a.details || {};
      return `<tr><td>${esc(when(a.first_detected))}</td><td>${lvlBadge(a.level)}</td><td>${esc(a.status === 'open' ? 'Open' : 'Resolved')}</td><td>${esc(a.reporting_period || '')}</td>
        <td>${esc(d.projected_pct != null ? `${d.projected_pct}% projected` : '')}${d.exhaustion_date ? esc(` · runs out ~${shortDate(d.exhaustion_date)}`) : ''}${d.backup_gb ? esc(` · backup ${n0(d.backup_gb)} GB`) : ''}${d.data_day ? esc(` · data to ${shortDate(d.data_day)}`) : ''}${
          d.peak && (d.peak.exhaustion_date !== d.exhaustion_date || d.peak.backup_gb !== d.backup_gb) ? `<div class="pv-muted">${esc(`worst: ${d.peak.exhaustion_date ? `runs out ~${shortDate(d.peak.exhaustion_date)}` : ''}${d.peak.backup_gb ? ` · backup ${n0(d.peak.backup_gb)} GB` : ''}`)}</div>` : ''}${
          (d.seq || 0) > 1 ? `<div class="pv-muted">${esc(`announced ${d.seq} times (worse each time)`)}</div>` : ''}</td>
        <td>${esc(when(a.last_updated))}</td><td>${esc(a.resolved_at ? when(a.resolved_at) : '')}</td><td class="pv-why">${esc(a.resolution_reason || '')}</td></tr>`; }).join('');
    return `<details class="pv-card" id="pv-alerts-${esc(cfg.code)}"><summary class="pv-card-t">Shared-pool alert history · ${n0(list.length)} <span class="pv-muted">· one open alert at a time; it is updated, escalated or resolved as new data arrives</span></summary>
      ${rows ? `<div class="tw"><table class="pv-table"><thead><tr><th>Detected</th><th>Level</th><th>Status</th><th>Cycle</th><th>Figures</th><th>Last updated</th><th>Resolved</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="pv-muted">No shared-pool alert so far.</div>'}</details>`;
  }

  /* SIM detail page: header, allocation vs usage, daily chart (7 / 14 days, cycle, full history), summary, table, cycles */
  let simState = null;
  function simModal() {
    let m = $('pv-sim');
    if (!m) {
      m = document.createElement('div'); m.id = 'pv-sim'; m.className = 'ops-pop';
      m.innerHTML = `<div class="pv-sim-card" role="dialog" aria-modal="true" aria-label="SIM details"><button type="button" class="vi-x pv-sim-x" aria-label="Close" onclick="ProvidersUI.closeSim()">✕</button><div class="pv-sim-body"></div></div>`;
      m.addEventListener('click', e => { if (e.target === m) closeSim(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && m.style.display !== 'none') closeSim(); });
      document.body.appendChild(m);
    }
    return m;
  }
  function closeSim() { const m = $('pv-sim'); if (m) m.style.display = 'none'; simState = null; }
  async function openSim(code, iccid) {
    const f = hook(code, 'simModel'); if (!f) return;
    const m = simModal(); m.style.display = 'flex';
    m.querySelector('.pv-sim-body').innerHTML = '<div class="pv-muted" style="padding:20px">Loading the SIM\'s daily usage…</div>';
    let model = null; try { model = await f(iccid); } catch (e) { console.warn('[providers] SIM model', e); }
    if (!model) { m.querySelector('.pv-sim-body').innerHTML = '<div class="pv-warn">This SIM could not be loaded.</div>'; return; }
    simState = { code, model, label: model.current || (model.cycles[0] && model.cycles[0].label), range: 'cycle' };
    renderSim();
    const x = m.querySelector('.pv-sim-x'); if (x) x.focus();
  }
  const simSetCycle = l => { if (simState) { simState.label = l; simState.range = 'cycle'; renderSim(); } };
  const simSetRange = r => { if (simState) { simState.range = r; renderSim(); } };
  function statsOf(days) {
    const cov = days.filter(d => d.gb != null), act = cov.filter(d => d.gb > 0), total = cov.reduce((a, d) => a + d.gb, 0);
    return { total, covered: cov.length, active: act.length, zero: cov.length - act.length, high: cov.filter(d => d.status === 'high').length,
      avg_cal: cov.length ? total / cov.length : null, avg_act: act.length ? total / act.length : null,
      max: cov.reduce((m, d) => (!m || d.gb > m.gb ? d : m), null), min: cov.reduce((m, d) => (!m || d.gb < m.gb ? d : m), null) };
  }
  function renderSim() {
    const m = $('pv-sim'); if (!m || !simState) return;
    const { model: M, label, range, code } = simState, cfg = PV().get(code) || { color: '#d95926', short: code };
    const C = M.cycles.find(c => c.label === label) || M.cycles[0] || null;
    const a = C && C.alloc;
    const notFuture = d => !M.today || d.date <= M.today;   // days after today are not "no data" — they have not happened
    let days = C && C.stats ? C.stats.days.filter(notFuture) : [];
    const all = M.cycles.slice().reverse().flatMap(c => (c.stats ? c.stats.days : [])).filter(notFuture);
    if (range === 'full') days = all;
    else if (range === '7' || range === '14') {   // the last 7 / 14 days with data up to this cycle — may reach into the cycle before
      const upTo = all.filter(d => !C || d.date <= C.cycle.end), cov = upTo.filter(d => d.gb != null), end = cov.length ? cov[cov.length - 1].date : null;
      days = (end ? upTo.filter(d => d.date <= end) : upTo).slice(-(+range));
    }
    const S = statsOf(days), perDay = a && a.plan_gb ? a.plan_gb / (M.plan_days || 30) : (M.plan_gb ? M.plan_gb / (M.plan_days || 30) : null);
    const usedOf = c => (c.used_gb != null ? c.used_gb : c.stats && c.stats.covered_days ? c.stats.total_gb : c.summary_gb);
    const srcOf = c => (c.used_src ? `${c.used_src === 'summary' ? 'Summary' : 'Itemized'}${c.used_until ? ' to ' + shortDay(c.used_until) : ''}` : '');
    const used = C ? usedOf(C) : null;
    const itDays = C && C.stats ? C.stats.days.filter(d => d.gb != null) : [], itLast = itDays.length ? itDays[itDays.length - 1].date : null;
    // the cycle total comes from a newer Summary than the daily (Itemized) figures — say so, the two do not add up
    const gapNote = C && C.used_src === 'summary' && C.used_until && (!itLast || C.used_until > itLast)
      ? `<div class="pv-muted" style="margin:6px 0">Daily figures come only from the Itemized report${itLast ? ` (to ${esc(shortDate(itLast))})` : ' (none for this cycle yet)'}. Total used ${esc(g2(C.used_gb))} is from the newer Data Usage Summary (to ${esc(shortDate(C.used_until))}) — upload the newest Itemized report for the days after${itLast ? ' ' + esc(shortDate(itLast)) : ''}.</div>` : '';
    const alloc = a && a.eligible ? a.gb : null;
    const det = (k, v) => `<div class="vsum-detail-row"><span class="vsum-detail-label">${esc(k)}</span><span class="vsum-detail-val">${v}</span></div>`;
    const by = {}, st = {}; days.forEach(d => { by[d.date] = d.gb; st[d.date] = d; });
    const STAT = { zero: 'No usage', high: 'High', normal: 'Normal', no_data: 'No data' };
    const cycStarts = M.cycles.map(c => c.cycle.start).filter(s => days.length && s > days[0].date && s <= days[days.length - 1].date);
    const chart = days.length ? svgChart({ dates: days.map(d => d.date), height: 220, aria: `Daily data usage of SIM ${M.iccid}`,
      vlines: cycStarts.map(s => ({ date: s, label: `Cycle ${shortDay(s)}` })),
      series: [{ name: 'Daily usage', color: cfg.color, area: true, markers: true, points: by, mark: d => (st[d].status === 'zero' ? 'sv-zero' : st[d].status === 'high' ? 'sv-high' : '') }],
      ref: perDay ? { value: perDay, label: `${(Math.round(perDay * 100) / 100).toLocaleString()} GB/day`, legend: `Daily allocation (${M.plan_gb} GB ÷ ${M.plan_days || 30})` } : null,
      shade: d => st[d].status === 'no_data',
      tip: d => ({ v: st[d].gb == null ? 'No data' : gb(st[d].gb), l: `${dayLbl(d)}${st[d].pct != null ? ` · ${Math.round(st[d].pct)}% of the daily allocation` : ''}${st[d].status === 'high' ? ' · high' : st[d].status === 'zero' ? ' · no usage' : ''}${st[d].provisional ? ' · newest day, may still grow' : ''}`, c: cfg.color }) })
      : `<div class="pv-muted">No daily figures for this cycle — daily usage comes only from the Itemized report.${C && C.summary_gb != null ? ` The Data Usage Summary says ${gb(C.summary_gb)} for the cycle.` : ''}</div>`;
    const rb = (r, t) => `<button type="button" class="ops-chip${range === r ? ' on' : ''}" onclick="ProvidersUI.simSetRange('${r}')">${t}</button>`;
    const tr = C && C.stats && C.stats.trend;
    const trendTxt = range === 'cycle' && tr ? `${tr.dir === 'up' ? '↑ rising' : tr.dir === 'down' ? '↓ falling' : '→ steady'} (${tr.pct === Infinity ? 'from 0' : (tr.pct > 0 ? '+' : '') + Math.round(tr.pct) + '%'}: last 7 days ${g2(tr.last)}/day vs ${g2(tr.prev)}/day)` : '—';
    const tile2 = (k, v, s) => `<div class="dgr"><div class="dgr-lbl">${esc(k)}</div><div class="dgr-val">${v}</div><div class="dgr-sub">${s || ''}</div></div>`;
    const tableRows = days.slice().reverse().map(d => `<tr class="${d.status === 'high' ? 'pv-bad' : ''}"><td>${esc(dayLbl(d.date))}${d.provisional ? ' <span class="pv-muted">(may still grow)</span>' : ''}</td><td class="num">${d.gb == null ? '—' : g2n(d.gb)}</td><td class="num">${d.pct == null ? '—' : Math.round(d.pct) + '%'}</td><td>${esc(STAT[d.status])}</td></tr>`).join('');
    const cmp = M.cycles.map(c => { const s = c.stats, al = c.alloc, u = usedOf(c);
      return `<tr${c.label === label ? ' class="pv-tot"' : ''}><td><button type="button" class="pv-linkbtn" onclick="ProvidersUI.simSetCycle('${esc(c.label)}')">${esc(c.label)}</button></td><td class="num">${al && al.eligible ? g2n(al.gb) : '—'}</td><td class="num">${u == null ? '—' : g2n(u)}</td><td class="num">${al && al.eligible && al.gb > 0 && u != null ? pct(u / al.gb * 100, 1) : '—'}</td><td class="num">${s && s.covered_days ? g2n(s.avg_calendar) : '—'}</td><td class="num">${s && s.max ? `${g2n(s.max.gb)} <span class="pv-muted">${esc(shortDay(s.max.date))}</span>` : '—'}</td><td class="num">${s && s.covered_days ? n0(s.zero_days) : '—'}</td><td>${esc(srcOf(c) || (c.summary_gb != null ? 'Summary' : ''))}</td></tr>`; }).join('');
    m.querySelector('.pv-sim-body').innerHTML = `
      <div class="pv-sim-h"><i style="background:${cfg.color}"></i><div><div class="pv-sim-t">SIM ${esc(M.iccid)}</div><div class="pv-muted">${esc(M.msisdn ? 'Mobile ' + M.msisdn : '')}${M.reg ? ' · ' + esc(M.reg) : ''}${M.client ? ' · ' + esc(M.client) : ''}</div></div></div>
      <div class="vsum-detail-grid">
        ${det('SIM number', `<span class="mono">${esc(M.iccid)}</span>`)}${det('Mobile number', `<span class="mono">${esc(M.msisdn || '—')}</span>`)}${det('Provider', esc(cfg.name || cfg.short))}
        ${det('Status', esc(M.state || '—'))}${det('Activation date (VI)', esc(M.vi_date ? shortDate(M.vi_date) : '—'))}${det('Counts from', esc(a && a.start ? `${shortDate(a.start)}${a.src === 'detected' ? ' (detected go-live)' : ''}` : '—'))}
        ${det('Plan', esc(M.plan_gb ? `${M.plan_gb} GB / ${M.plan_days || 30} days${M.price != null ? ` · ₹${M.price}` : ''}${M.pooled ? ' · data pool' : ''}` : 'no data plan'))}
        ${det('Billing cycle', `<select class="fsel" onchange="ProvidersUI.simSetCycle(this.value)" aria-label="Billing cycle">${M.cycles.map(c => `<option value="${esc(c.label)}"${c.label === label ? ' selected' : ''}>${esc(shortDate(c.cycle.start))} → ${esc(shortDate(c.cycle.end))}</option>`).join('')}</select>`)}
        ${det('Eligible days', esc(a && a.eligible ? (a.days == null ? `${C.cycle.days} (full cycle)` : String(a.days)) : 'not in the pool'))}
        ${det('Eligible allocation', alloc != null ? g2(alloc) : '—')}${det('Total used', used != null ? `${g2(used)}${C.used_src ? ` <span class="pv-muted">(${esc(srcOf(C))})</span>` : ''}` : '—')}
        ${det('Remaining allocation', alloc != null && used != null ? g2(alloc - used) : '—')}${det('Usage %', alloc && used != null ? pct(used / alloc * 100, 2) : '—')}
      </div>
      <div class="pv-muted" style="margin:6px 0 12px">The shared pool is the billing and operational control: usage above this SIM's own allocation is covered by the pool — it is not a pool alert.</div>
      <div class="pv-card-t">Daily usage <span class="ops-chips" style="display:inline-flex;margin-left:8px">${rb('7', '7 days')}${rb('14', '14 days')}${rb('cycle', 'Cycle')}${rb('full', 'Full history')}</span></div>
      ${gapNote}${chart}
      <div class="dg-ribbon dg6" style="margin-top:12px">${tile2('Total', g2(S.total), `${n0(S.covered)} days with data`)}${tile2('Average / calendar day', S.avg_cal == null ? '—' : g2(S.avg_cal), 'zero days included')}
        ${tile2('Average / active day', S.avg_act == null ? '—' : g2(S.avg_act), `${n0(S.active)} days with usage`)}${tile2('Highest day', S.max ? g2(S.max.gb) : '—', S.max ? esc(dayLbl(S.max.date)) : '')}
        ${tile2('Lowest day', S.min ? g2(S.min.gb) : '—', S.min ? esc(dayLbl(S.min.date)) : '')}${tile2('Zero-usage days', n0(S.zero), `${n0(S.high)} high day(s) · trend ${esc(trendTxt)}`)}</div>
      <details class="pv-tv" open><summary>Day by day — table</summary><div class="tw pv-sims-tw" style="max-height:280px"><table class="pv-table"><thead><tr><th>Date</th><th class="num">Usage (GB)</th><th class="num">% of daily allocation</th><th>Status</th></tr></thead><tbody>${tableRows}</tbody></table></div></details>
      <div class="pv-card-t" style="margin-top:12px">Billing cycles</div>
      <div class="tw"><table class="pv-table"><thead><tr><th>Cycle</th><th class="num">Allocation</th><th class="num">Usage</th><th class="num">Usage %</th><th class="num">Avg / day</th><th class="num">Highest day</th><th class="num">Zero days</th><th>Source</th></tr></thead><tbody>${cmp}</tbody></table></div>
      <div class="pv-card-t" style="margin-top:12px">Status / activity</div>
      <div class="vsum-detail-grid">${det('Current status', esc(M.state || '—'))}${det('Last usage', esc(M.last_use ? shortDate(M.last_use) : 'None in uploaded reports'))}${det('Days since last usage', M.last_use && M.today ? n0(dDiff(M.last_use, M.today)) : '—')}</div>`;
  }

  /* ── pool sections ─────────────────────────────────────────── */
  // The cycle, the plan and how fresh the data is
  function cycleLine(cfg, pool) {
    const c = pool.cycle, bits = [];
    if (c) bits.push(`<b>Billing cycle ${esc(shortDate(c.start))} → ${esc(shortDate(c.end))}</b> (${c.days} days)`);
    if ((pool.plans || []).length) bits.push('Plan ' + pool.plans.map(p => `${esc(gb(p.gb))} / ${pool.rules.plan_days} days = ${esc(g2(p.per_day))} a day`).join(' · '));
    const tc = pool.today_cycle;
    if (tc && c && tc.label === c.label) bits.push(`Today ${esc(shortDate(pool.today))}: day ${pool.today_day} of ${tc.days}`);
    if (pool.data_date) bits.push(`Used data up to ${esc(shortDate(pool.data_date))} (${esc(pool.usage_src_name || 'usage report')})`);
    if (pool.snapshot_at) bits.push(`SIM Group of ${esc(shortDate(pool.snapshot_at))}${pool.frozen ? ` · 🔒 frozen ${esc(shortDate(String(pool.frozen.at).slice(0, 10)))}` : ''}`);
    let html = `<div class="pv-cyc">${bits.join(' · ')}</div>`;
    if (tc && c && tc.label !== c.label && pool.today > c.end && !pool.as_of)
      html += `<div class="pv-warn">Today (${esc(shortDate(pool.today))}) is in the ${esc(tc.label)} cycle (${esc(shortDate(tc.start))} – ${esc(shortDate(tc.end))}) — no ${esc(cfg.short)} Itemized data for it yet, so the ${esc(c.label)} cycle is shown. Upload the newest Itemized report.</div>`;
    return html;
  }
  function alertsCard(pool) {
    const list = pool.alerts || [];
    if (!list.length) return `<div class="pv-card"><div class="pv-card-t">Alerts</div><div class="pv-muted">✅ Nothing needs attention.</div></div>`;
    return `<div class="pv-card"><div class="pv-card-t">Alerts · ${n0(list.length)}</div><ul class="pv-alerts">${list.map(a => `<li class="pv-al pv-al-${a.level}"><span aria-hidden="true">${ALERT[a.level][0]}</span><b>${ALERT[a.level][1]}</b> ${esc(a.text)}</li>`).join('')}</ul></div>`;
  }
  // SIM status — the states exactly as the SIM Group file has them, the pool rule and what each adds
  function statusCard(cfg, pool) {
    const ctl = hook(cfg.code, 'statusRuleControl');
    const rows = (pool.status_table || []).map(r => `<tr><td>${esc(r.state)}</td><td class="num">${n0(r.sims)}</td><td>${ctl ? ctl(r) : esc(r.rule ? 'Yes' : r.rule === false ? 'No' : '—')}</td><td class="num">${n0(r.pool_sims)}</td><td class="num">${g2n(r.pool_gb)}</td><td class="num">${g2n(r.used_gb)}</td><td class="pv-why">${esc(r.reasons.map(x => (r.reasons.length > 1 ? n0(x.n) + ' × ' : '') + x.text).join(' · '))}</td></tr>`).join('');
    const tot = (pool.status_table || []).reduce((a, r) => ({ sims: a.sims + r.sims, pool_sims: a.pool_sims + r.pool_sims, pool_gb: a.pool_gb + r.pool_gb, used_gb: a.used_gb + r.used_gb }), { sims: 0, pool_sims: 0, pool_gb: 0, used_gb: 0 });
    return `<div class="pv-card"><div class="pv-card-t">SIM status &amp; pool <span class="pv-muted">· status exactly as in the SIM Group file of ${esc(shortDate(pool.snapshot_at))}</span></div>
      <div class="tw"><table class="pv-table"><thead><tr><th>Status</th><th class="num">SIMs</th><th>Counts in pool</th><th class="num">In pool</th><th class="num">Pool (GB)</th><th class="num">Used (GB)</th><th>Why</th></tr></thead>
      <tbody>${rows}<tr><td class="pv-tot">Total</td><td class="num pv-tot">${n0(tot.sims)}</td><td></td><td class="num pv-tot">${n0(tot.pool_sims)}</td><td class="num pv-tot">${g2n(tot.pool_gb)}</td><td class="num pv-tot">${g2n(tot.used_gb)}</td><td></td></tr></tbody></table></div>
      <div class="pv-muted pv-foot">A SIM counts when its status counts${pool.rules ? ` (now: ${esc(pool.rules.eligible_states.join(', ') || 'none')})` : ''} and its deal is a data-pool deal (${esc(pool.rules ? pool.rules.pool_tag : '')}).${ctl && typeof EDIT_MODE !== 'undefined' && EDIT_MODE ? ' Tick a status to count it — saved for everyone; frozen cycles keep their rules.' : ' An admin can change which statuses count.'}</div></div>`; // eslint-disable-line no-undef
  }
  // SIM Group ↔ usage report: what matches and what does not
  function reconCard(pool) {
    const r = pool.recon; if (!r) return '';
    const line = (k, v, sub, warn) => `<tr${warn ? ' class="pv-bad"' : ''}><td>${esc(k)}</td><td class="num">${v}</td><td class="pv-muted">${sub || ''}</td></tr>`;
    return `<div class="pv-card"><div class="pv-card-t">Reconciliation · SIM Group ↔ usage <span class="pv-muted">${pool.as_of ? '· as of ' + esc(shortDate(pool.as_of)) : '· this cycle'}</span></div>
      <table class="pv-table"><tbody>
        ${line('SIMs in the SIM Group', n0(r.inventory_sims), `file of ${esc(shortDate(pool.snapshot_at))}`)}
        ${line('SIMs in the usage report', n0(r.usage_sims), esc(pool.usage_src_name || ''))}
        ${line('Matched (in both)', n0(r.matched), 'joined by ICCID')}
        ${line('In the SIM Group, no usage', n0(r.inventory_no_usage), `${n0(r.eligible_no_usage)} of them count in the pool`)}
        ${line('Usage, not in the SIM Group', n0(r.usage_no_inventory), r.usage_no_inventory ? `${g2(r.usage_no_inventory_gb)} — not counted; upload a newer SIM Group` : 'none', r.usage_no_inventory > 0)}
        ${line('Usage by SIMs that do not count', n0(r.usage_non_eligible), r.usage_non_eligible ? `${g2(r.usage_non_eligible_gb)} — e.g. Ready SIMs that went live` : 'none', r.usage_non_eligible > 0)}
        ${line('Pool SIMs without a vehicle number', n0(r.no_vehicle || 0), r.no_vehicle ? 'listed as "No vehicle · mobile no." — add their SIM numbers to the vehicles file' : 'every pool SIM has a vehicle', r.no_vehicle > 0)}
      </tbody></table></div>`;
  }
  // Billing-cycle history: one row per cycle; closed cycles come from their frozen pool
  function trendCard(cfg, ds) {
    const t = ds.trend || [];
    if (!t.length) return '';
    const basis = r => (r.frozen ? '🔒 frozen' : r.provisional ? 'provisional' : 'live');
    const src = r => (r.source === 'summary' ? 'Summary' : r.source === 'itemized' ? 'Itemized' : '—') + (r.data_until ? ' · to ' + shortDate(r.data_until) : '');
    const rows = t.slice().reverse().map(r => [r.label, `${shortDate(r.cycle.start)} – ${shortDate(r.cycle.end)}`, n0(r.sims), g2n(r.pool_gb), g2n(r.used_gb), g2n(r.remaining_gb), pct(r.util_pct, 2), n0(r.new_activations), basis(r), src(r)]);
    const cats = t.map(r => ({ key: r.label, label: r.label, short: r.label.replace(/^(\w{3}) \d{2}(\d{2})$/, '$1 ’$2') }));
    const by = {}; t.forEach(r => { by[r.label] = r.util_pct; });
    return `<div class="pv-card"><div class="pv-card-t">Billing-cycle trend <span class="pv-muted">· utilisation = used ÷ pool; used = whichever report reaches later (Data Usage Summary or Itemized report; same day → Itemized) — see Usage source</span></div>
      ${t.length > 1 ? columnChart({ series: [{ key: 'u', name: cfg.short, color: cfg.color }], cats, val: c => by[c], fmt: v => pct(v, 1), height: 90, width: 700, label: 'last', aria: 'Pool utilisation per billing cycle' }) : ''}
      <div class="tw"><table class="pv-table"><thead><tr>${['Cycle', 'Dates', 'SIMs', 'Pool (GB)', 'Used (GB)', 'Remaining (GB)', 'Utilisation', 'New', 'Pool basis', 'Usage source'].map((h, i) => `<th${i > 1 && i < 8 ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td${i > 1 && i < 8 ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  }
  // SIM-wise allocation: every SIM of the cycle's SIM Group (+ SIMs with usage missing from it); search + CSV
  const simTables = {};
  const SIM_HEAD = ['ICCID', 'Mobile', 'Vehicle', 'Status', 'In pool', 'Activation (VI)', 'Counts from', 'Plan (GB)', 'Days', 'GB / day', 'Allocation (GB)', 'Used (GB)', 'Remaining (GB)', 'Usage %', 'Why not counted'];
  const simCells = r => [r.iccid, r.msisdn, r.reg, r.state, r.in_pool ? 'Yes' : 'No', r.vi_date || '', r.start ? `${r.start}${r.src === 'detected' ? ' (detected)' : ''}` : '',
    r.plan_gb || '', r.days == null ? '' : r.full ? `${r.days} (full)` : r.days, r.per_day == null ? '' : g2n(r.per_day), r.in_pool ? g2n(r.alloc_gb) : '0',
    g2n(r.used_gb), r.remaining_gb == null ? '' : g2n(r.remaining_gb), r.usage_pct == null ? '' : r.usage_pct.toFixed(1) + '%', r.in_pool ? '' : r.reason];
  function simCard(cfg, pool) {
    const list = pool.sim_table || [];
    if (!list.length) return '';
    simTables[cfg.code] = { rows: list, cycle: pool.cycle ? pool.cycle.label : '', as_of: pool.as_of };
    const id = 'sims-' + cfg.code;
    const v = pager(id, list, r => `<tr>${simCells(r).map((c, i) => i === 0 ? `<td>${simBtn(cfg.code, r.iccid)}</td>` : `<td${i === 1 ? ' class="mono"' : i >= 7 && i <= 13 ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`,
      (r, p) => !p.q || (r._find || (r._find = simCells(r).join(' ').toLowerCase())).includes(p.q));
    return `<details class="pv-card pv-sims"><summary class="pv-card-t">SIM-wise allocation · ${n0(list.length)} SIMs (${n0(list.filter(r => r.in_pool).length)} in the pool) <span class="pv-muted">· click to open</span></summary>
      <div class="pv-sims-bar"><input type="search" class="fsel" placeholder="Search ICCID, mobile, vehicle, status…" aria-label="Search SIMs" value="${esc(pagers[id].q)}" oninput="ProvidersUI.simFilter(this,'${id}')"><button type="button" class="ps-link" onclick="ProvidersUI.simCsv('${esc(cfg.code)}')">⬇ CSV</button><span class="pv-sims-n" id="pg-n-${id}">${v.nav}</span></div>
      <div class="tw pv-sims-tw"><table class="pv-table"><thead><tr>${SIM_HEAD.map((h, i) => `<th${i >= 7 && i <= 13 ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody id="pg-b-${id}">${v.body}</tbody></table></div></details>`;
  }
  let simFilterT = null;
  function simFilter(input, id) {
    const p = pagers[id]; if (!p) return;
    clearTimeout(simFilterT);
    simFilterT = setTimeout(() => { p.q = String(input.value || '').trim().toLowerCase(); p.page = 0; pagerDraw(id); }, 150);
  }
  function simCsv(code) {
    const t = simTables[code]; if (!t) return;
    const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    // ICCIDs and mobile numbers as text so spreadsheets keep every digit
    const csv = [SIM_HEAD.join(',')].concat(t.rows.map(r => simCells(r).map((c, i) => (i < 2 && c ? '="' + c + '"' : q(c))).join(','))).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${code}_sim_allocation_${String(t.cycle).replace(/\s+/g, '-')}${t.as_of ? '_as-of-' + t.as_of : ''}.csv`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function usageCards(pool) {
    const list = (rows, val, empty) => rows.length ? `<table class="pv-table"><tbody>${rows.map(t => `<tr><td class="mono">${esc(t.iccid)}</td><td>${esc(t.reg)}</td><td class="num">${val(t)}</td></tr>`).join('')}</tbody></table>` : `<div class="pv-muted">${empty}</div>`;
    return `<div class="pv-3col">
        <div class="pv-card"><div class="pv-card-t">SIMs with no usage</div><div class="pv-big">${n0(pool.idle.count)}</div><div class="pv-muted">pooled SIMs with no data ${pool.as_of ? 'by ' + esc(shortDate(pool.as_of)) : 'this cycle'} · ${inr(pool.idle.cost)}/month${pool.idle.recent ? ` · ${n0(pool.idle.recent)} started in the last 30 days` : ''}</div></div>
        <div class="pv-card"><div class="pv-card-t">Above their own allocation · ${n0(pool.over_share.count)}</div>${list(pool.above || [], t => `+${g2(t.excess_gb)}`, 'None')}<div class="pv-muted">${pool.over_share.count ? `${g2(pool.over_share.excess_gb)} beyond their own allocation — covered by the pool` : ''}</div></div>
        <div class="pv-card"><div class="pv-card-t">Lowest consumers (with usage)</div>${list(pool.low || [], t => g2(t.used_gb), 'No usage yet')}</div>
      </div>`;
  }

  function poolCard(cfg, pool, ds) {
    const period = poolPeriod(pool, ds);
    const recIcon = { oversized: '💡', at_risk: '🔴', healthy: '✅', empty: '⚠️' }[pool.rec.type] || 'ℹ️';
    const recLbl = { oversized: 'Pool oversized', at_risk: 'Pool at risk', healthy: 'Pool size healthy', empty: 'Nothing in the pool' }[pool.rec.type] || 'Pool';
    const daily = pool.daily || [], dd = pool.days || [];
    const tick = (list, i) => (i % 5 === 0 || i === list.length - 1) ? String(+list[i].date.slice(8, 10)) : '';
    // With an "as of" day: later days are faded, that day is outlined; every bar picks its day
    const marks = { dim: pool.as_of ? k => k > pool.as_of : null, sel: pool.as_of ? k => k === pool.as_of : null, pick: cfg.code };
    const dailyNote = pool.usage_src === 'summary' && !pool.as_of
      ? ` <span class="pv-muted">· daily figures from the Itemized report${pool.daily_until ? ' (to ' + esc(shortDate(pool.daily_until)) + ')' : ''}; the totals above use the newer Data Usage Summary (to ${esc(shortDate(pool.data_date))})</span>` : '';
    let chart = '';
    if (daily.length) {
      const cats = daily.map((d, i) => ({ key: d.date, label: shortDate(d.date), short: tick(daily, i) }));
      const by = {}; daily.forEach(d => { by[d.date] = d.gb; });
      chart = `<div class="pv-card"><div class="pv-card-t">Daily data used by the pool · ${esc(period)} <span class="pv-muted">· click a day to see the pool and every SIM as of that day</span>${dailyNote}</div>`
        + columnChart(Object.assign({ series: [{ key: 'u', name: cfg.short, color: cfg.color }], cats, val: c => by[c], height: 110, width: 900, label: 'peak', aria: 'Daily pool usage' }, marks))
        + tableView(['Date', 'Used (GB)'], daily.map(d => [shortDate(d.date), g2n(d.gb)])) + '</div>';
    } else chart = `<div class="pv-card pv-muted">Upload the ${esc(cfg.short)} Itemized report (Real-time mode) to see daily pool usage and track the pool day by day.</div>`;
    // Day by day: what the pool had at the end of each day (pool size grows as SIMs start)
    let track = '';
    if (dd.length) {
      const cats = dd.map((d, i) => ({ key: d.date, label: shortDate(d.date), short: tick(dd, i) }));
      const by = {}; dd.forEach(d => { by[d.date] = Math.max(0, d.avail_gb); });
      const grows = dd.some((d, i) => i && d.pool_gb > dd[i - 1].pool_gb);
      track = `<div class="pv-card"><div class="pv-card-t">Remaining at the end of each day · ${esc(period)}${grows ? ' <span class="pv-muted">· jumps up on days SIMs started</span>' : ''}${dailyNote}</div>`
        + columnChart(Object.assign({ series: [{ key: 'a', name: cfg.short, color: cfg.color }], cats, val: c => by[c], height: 110, width: 900, label: 'last', aria: 'Pool data remaining at the end of each day' }, marks))
        + tableView(['Date', 'Day', 'Used that day (GB)', 'Used so far (GB)', 'SIMs in pool', 'Pool size (GB)', 'Remaining (GB)', '% used'],
          dd.slice().reverse().map(d => [shortDate(d.date), String(d.day), g2n(d.used_gb), g2n(d.cum_gb), n0(d.sims), g2n(d.pool_gb), g2n(d.avail_gb), pct(d.pool_gb > 0 ? d.cum_gb / d.pool_gb * 100 : 0, 2)]), 'Day by day — table') + '</div>';
    }
    const top = pool.top.map((t, i) => `<tr><td>${i + 1}</td><td>${simBtn(cfg.code, t.iccid)}</td><td>${esc(t.reg)}</td><td>${esc(t.client)}</td><td class="num">${g2(t.used_gb)}</td><td class="num">${pct(t.share_pct)}</td></tr>`).join('');
    const day = poolDay(pool);
    const extra = hook(cfg.code, 'poolHeaderExtra');
    const states = (cfg.poolStates ? cfg.poolStates() : cfg.billableStates || []).join(', ') || 'active';
    const notCounted = (pool.status_table || []).filter(r => r.sims > r.pool_sims).sort((a, b) => (b.sims - b.pool_sims) - (a.sims - a.pool_sims)).slice(0, 3).map(r => `${n0(r.sims - r.pool_sims)} ${esc(r.state)}`).join(' · ');
    const nw = pool.new_activations || { count: 0, gb: 0 };
    return `<div class="pv-sec"><div class="pv-sec-h"><i style="background:${cfg.color}"></i><b>${esc(cfg.name)}</b> · shared data pool${pool.as_of ? ` <span class="ps-asof">📅 As of ${esc(shortDate(pool.as_of))}</span>` : ''}${pool.provisional ? ' <span class="ps-est">Provisional</span>' : ''} <span class="pv-muted">${esc(period)}${day ? ' · ' + esc(day) : ''}</span>${extra ? extra(pool, ds) : ''}${pool.as_of ? latestBtn(cfg.code) : ''}</div>
      ${cycleLine(cfg, pool)}
      <div class="dg-ribbon">${tile('SIM inventory', n0(pool.inventory_sims), `SIMs in the SIM Group file of ${esc(shortDate(pool.snapshot_at))}`)}
        ${tile('Eligible SIMs', n0(pool.eligible_sims), `count in the pool${pool.not_yet_active ? ` · ${n0(pool.not_yet_active)} more start later` : ''}`, 'orange')}
        ${tile('Not eligible', n0(pool.non_eligible_sims), notCounted || 'every SIM counts')}
        ${tile('New activations', n0(nw.count), nw.count ? `started this cycle · ${esc(g2(nw.gb))} of the pool` : 'none this cycle')}</div>
      <div class="dg-ribbon dg6">${tile('Full allocation', g2(pool.full_gb), `${n0(pool.prorated.full_sims)} SIMs × their full plan`)}
        ${tile('Pro-rated allocation', g2(pool.prorated_gb), pool.prorated.sims ? `${n0(pool.prorated.sims)} SIMs that started during the cycle` : 'no SIM started during the cycle')}
        ${tile('Total pool', g2(pool.capacity_gb), `${inr(pool.monthly_cost)}/month at full plan rates`, 'orange')}
        ${tile(usedLbl(pool), g2(pool.used_gb), `${pct(pool.util_pct, 2)} of the pool · ${esc(usedSrc(pool))}`)}
        ${tile(pool.remaining_gb < 0 ? 'Over the pool by' : 'Remaining', g2(Math.abs(pool.remaining_gb)), pool.remaining_gb < 0 ? 'beyond the total pool' : `${pct(Math.max(0, 100 - pool.util_pct), 2)} left to use`)}
        ${tile('Utilisation', pct(pool.util_pct, 2), pool.complete ? 'cycle closed' : `${pct(pool.projected_pct, 0)} projected · ${g2(pool.projected_gb)} at the current pace`)}</div>
      ${meter(pool.projected_pct)}
      <div class="pv-rec pv-rec-${pool.rec.type}"><b>${recIcon} ${recLbl}</b> — ${esc(pool.rec.text)}</div>
      ${forecastCard(cfg, pool)}
      ${alertsCard(pool)}
      ${zeroCard(cfg, pool)}
      ${highCard(cfg, pool)}
      ${alertHistoryCard(cfg)}
      <div class="pv-2col pv-2top">${statusCard(cfg, pool)}${reconCard(pool)}</div>
      ${prorationTable(cfg, pool)}
      ${chart}
      ${track}
      ${usageCards(pool)}
      <div class="pv-card"><div class="pv-card-t">Top 10 consumers · share of pool usage${pool.as_of ? ' · as of ' + esc(shortDate(pool.as_of)) : ''}</div><table class="pv-table"><thead><tr><th>#</th><th>ICCID</th><th>Vehicle</th><th>Client</th><th class="num">Used</th><th class="num">Share</th></tr></thead><tbody>${top}</tbody></table></div>
      ${trendCard(cfg, ds)}
      ${simCard(cfg, pool)}
      <div class="pv-muted pv-foot">Pool = ${esc(cfg.poolRule || 'SIMs on pooled plans')}. A SIM counts while its status is ${esc(states)}, from the day it starts. Total pool = Σ each SIM's allocation this cycle = ${esc(mixText(pool))} = ${g2(pool.capacity_gb)}${cfg.prorateRule ? `; ${esc(cfg.prorateRule)}` : ''}; Remaining = Total pool − Used; Utilisation = Used ÷ Total pool${cfg.cycle ? `; ${esc(cfg.cycle)}` : ''}.${pool.over_share.count ? ` ${n0(pool.over_share.count)} SIM(s) used more than their own share this cycle, drawing on the pool.` : ''}${cfg.poolAssumption ? ' ' + esc(cfg.poolAssumption) : ''}</div></div>`;
  }
  function allocationCard(cfg, ds) {
    const rows = ds.rtRows || [];
    if (!rows.length) return `<div class="pv-sec"><div class="pv-sec-h"><i style="background:${cfg.color}"></i><b>${esc(cfg.name)}</b> · allocation</div><div class="pv-card pv-muted">No pooled plans, and no SIM-level ${esc(cfg.short)} data loaded yet${cfg.legacyUpload ? ' — upload the real-time portal export to see account-level allocation' : ''}.</div></div>`;
    const m = simMetrics(rows);
    return `<div class="pv-sec"><div class="pv-sec-h"><i style="background:${cfg.color}"></i><b>${esc(cfg.name)}</b> · allocation <span class="pv-muted">per-SIM plans (not pooled)${cfg.simSource ? ' · ' + esc(cfg.simSource) : ''}</span></div>
      <div class="dg-ribbon">${tile('SIMs', n0(m.sims), 'on the latest SIM list', 'orange')}${tile('Allocated', gb(m.alloc), 'current cycle')}${tile('Used', gb(m.used), pct(m.util) + ' of allocated')}${tile('Available', gb(m.avail), 'left this cycle')}</div>${meter(m.util)}</div>`;
  }
  function renderPool(view) {
    const el = $('pool-body'); if (!el) return;
    const parts = view.parts || [];
    el.innerHTML = parts.length ? parts.map(p => {
      const cfg = PV().get(p.c);
      if (p.ds.pool && p.ds.pool.hasPool) return poolCard(cfg, p.ds.pool, p.ds);
      const empty = text => `<div class="pv-sec"><div class="pv-sec-h"><i style="background:${cfg.color}"></i><b>${esc(cfg.name)}</b> · shared data pool</div><div class="pv-card pv-muted">${esc(text)}</div>${trendCard(cfg, p.ds)}</div>`;
      // The pool needs a usage report and the SIM Group: without either there is nothing to size yet
      if (p.ds.pool && p.ds.pool.needsUsage) return empty(cfg.usageEmpty || cfg.rtEmpty || 'Upload usage data to see the pool.');
      if (p.ds.pool && p.ds.pool.needsInventory) return empty(cfg.invEmpty || 'Upload the SIM inventory to see the pool.');
      return allocationCard(cfg, p.ds);
    }).join('') : '<div class="pv-card pv-muted">No provider data loaded yet.</div>';
  }

  /* ── Uploads panel (history + reconciliation) ──────────────── */
  const typeName = (code, t) => { const c = PV().get(code); return (c && c.typeLabels && c.typeLabels[t]) || t; };
  function reconHtml(r) {
    if (!r) return '';
    if (r.status === 'summary_only') return `<div class="vi-recon">ℹ Monthly data only (Data Usage Summary). Upload the Itemized report in Real-time mode for real-time usage — the two are then compared here.</div>`;
    if (r.status === 'itemized_only') return `<div class="vi-recon">ℹ Real-time data only (Itemized report). Upload the Data Usage Summary in Monthly mode for the month-wise tabs — the two are then compared here.</div>`;
    if (r.status === 'empty') return '';
    const ok = r.status === 'matched';
    return `<div class="vi-recon ${ok ? 'ok' : 'warn'}"><b>${ok ? '✓ Reconciliation matched' : '⚠ Difference found'}</b> · Summary ${gb(r.summary_mb / 1024)} vs Itemized ${gb(r.itemized_mb / 1024)} · difference ${gb(Math.abs(r.diff_mb) / 1024)} · ${n0(r.rows_compared)} SIM × circle rows compared${r.mismatches && r.mismatches.length ? ` · <b>${n0(r.mismatches.length)}</b> row(s) differ` : ''}${r.only_summary ? ` · ${n0(r.only_summary)} only in Summary` : ''}${r.only_itemized ? ` · ${n0(r.only_itemized)} only in Itemized` : ''}${r.note ? `<br>ℹ ${esc(r.note)}` : ''}</div>`;
  }
  function renderUploads() {
    const el = $('up-body'); if (!el) return;
    const cs = window.ProviderCloud ? window.ProviderCloud.state : { ready: false, reason: '' };
    const hist = window.ProviderCloud ? window.ProviderCloud.history() : [];
    const ps = window.ProviderCloud ? window.ProviderCloud.pool : { ready: null };
    const os = window.ProviderCloud && window.ProviderCloud.ops ? window.ProviderCloud.ops : { ready: null };
    const ss = window.ProviderCloud && window.ProviderCloud.scale ? window.ProviderCloud.scale : { ready: null };
    const status = (cs.ready ? `<div class="pv-ok">☁️ Provider tables connected — uploads are saved for the whole team.</div>`
      : `<div class="pv-warn">⚠ ${esc(cs.reason || 'Cloud not connected')}. New-provider uploads stay in this browser session only. ${esc(PV().shortName(PV().legacyCode()))} is unaffected.</div>`)
      + (cs.ready && ps.ready === false ? `<div class="pv-warn">⚠ ${esc(ps.reason)} — until then SIM Group history and frozen cycles last for this browser session only.</div>` : '')
      + (cs.ready && os.ready === false ? `<div class="pv-warn">⚠ ${esc(os.reason)} — until then the pool alert and its 2-day confirmation last for this browser session only (Critical from the projection needs the next upload in the same session).</div>` : '')
      + (cs.ready && ss.ready === false ? `<div class="pv-warn">⚠ ${esc(ss.reason)}.</div>` : '');
    const rows = hist.map(b => {
      const cfg = PV().get(b.provider) || { short: b.provider, color: '#888' };
      const st = b.status === 'success' ? (b.saved === false && !cs.ready ? 'Session only' : b.cloud_error ? 'Not saved' : 'Success') : b.status === 'failed' ? 'Failed' : b.status === 'deleted' ? 'Deleted' : 'Skipped';
      return `<tr><td>${esc(new Date(b.uploaded_at).toLocaleString())}</td><td><i class="pv-key" style="background:${cfg.color}"></i>${esc(cfg.short)}</td><td>${esc(typeName(b.provider, b.source_type))}</td><td class="pv-fn" title="${esc(b.source_file)}">${esc(b.source_file || '—')}</td><td>${esc(b.reporting_period || (b.period_start ? shortDate(b.period_start) : '—'))}</td><td class="num">${n0(b.total_rows)}</td><td class="num">${n0(b.valid_rows)}</td><td class="num">${n0(b.duplicate_rows)}</td><td class="num">${n0(b.invalid_rows)}</td><td class="num">${b.total_mb != null ? gb(b.total_mb / 1024) : '—'}</td><td title="${esc(b.cloud_error || '')}">${esc(st)}</td><td>${esc(b.uploaded_by || '')}</td></tr>`;
    }).join('');
    const recon = PV().list().map(p => { const f = hook(p.code, 'reconSection'); return f ? f() : ''; }).join('');
    el.innerHTML = status + `<div class="pv-card"><div class="pv-card-t">Upload history</div>${rows ? `<div class="tw"><table class="pv-table"><thead><tr><th>When</th><th>Provider</th><th>Type</th><th>File</th><th>Period</th><th class="num">Rows</th><th class="num">Valid</th><th class="num">Duplicate</th><th class="num">Invalid</th><th class="num">Usage</th><th>Status</th><th>By</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="pv-muted">No uploads recorded yet.</div>'}</div>` + recon;
  }

  /* ── small hooks used by the legacy renderers ──────────────── */
  function excNote(v) { return v && v.pooled ? `<div class="exc-meta" style="color:var(--gr)">Pooled plan — the shared pool covers this</div>` : ''; }
  function planNote(p) { return p && p.pooled ? `<div class="plan-no-sug">🔗 Shared data pool — size it on the Data Pool tab, not per SIM.</div>` : ''; }
  function renderRtInfo(view) {
    const el = $('rt-prov-info'); if (!el) return;
    const bits = (view.parts || []).map(p => { const f = hook(p.c, 'rtInfo'); return f ? f(p.ds) : null; }).filter(Boolean);
    el.textContent = bits.join('  ·  ');
    el.style.display = bits.length ? '' : 'none';
    // Provider date pickers (e.g. VI "as of" day) next to the legacy snapshot picker
    const ctl = $('rt-prov-ctrl');
    if (ctl) {
      const html = (view.parts || []).map(p => { const f = hook(p.c, 'rtControls'); return f ? f(p.ds) : ''; }).join('');
      ctl.innerHTML = html; ctl.style.display = html ? '' : 'none';
    }
    // Empty real-time tab: a single provider in view says what to upload (Airtel keeps its original text)
    const nd = $('rt-no-data-text');
    if (nd) {
      if (nd.dataset.base == null) nd.dataset.base = nd.textContent;
      const sel = PV().viewCodes(), one = sel.length === 1 ? PV().get(sel[0]) : null;
      nd.textContent = one && one.rtEmpty ? one.rtEmpty : nd.dataset.base;
    }
    // The snapshot picker and date belong to the legacy (portal) snapshots: shown whenever that provider is in view
    const legacyInView = view.codes.includes(PV().legacyCode());
    const snap = $('rt-snapshot-sel'), info = $('rt-snapshot-info'), date = $('rt-snapshot-date');
    if (snap) snap.style.display = legacyInView && window._rtSnapshots && window._rtSnapshots.length ? '' : 'none';
    if (info) info.style.display = legacyInView && date && date.textContent && date.textContent !== '—' ? '' : 'none';
  }
  const pickLatest = code => { const f = hook(code, 'pickDay'); if (f) f(null); };
  function renderPriceNote(view) {
    const el = $('pr-pool-note'); if (!el) return;
    const notes = (view.parts || []).filter(p => p.ds.pool && p.ds.pool.hasPool).map(p => {
      const pool = p.ds.pool, cfg = PV().get(p.c);
      const unusedShare = pool.capacity_gb > 0 ? Math.max(0, pool.remaining_gb) / pool.capacity_gb : 0;
      return `${cfg.short}: pooled SIMs share ${gb(pool.capacity_gb)} — SIM-level wastage below is indicative. At pool level ${gb(Math.max(0, pool.remaining_gb))} is unused ≈ ${inr(unusedShare * pool.monthly_cost)} of ${inr(pool.monthly_cost)}/month (Data Pool tab).`;
    });
    el.innerHTML = notes.map(esc).join('<br>');
    el.style.display = notes.length ? '' : 'none';
  }
  const vsumExtra = v => { const f = hook(provOf(v), 'vsumExtra'); return f ? f(v) : ''; };
  const afterVsum = v => { const f = hook(provOf(v), 'afterVsum'); return f ? f(v) : null; };

  /* ── upload dialog: provider choice ────────────────────────── */
  const up = { provider: null };
  const defaultUploadProvider = () => { const c = PV().viewCodes(); return c.length === 1 ? c[0] : PV().legacyCode(); };
  const uploadProvider = () => up.provider || defaultUploadProvider();
  // The dialog's upload mode (Single / Multi-month / Real-time) also sets each provider's own mode
  const legacyMode = () => (typeof uploadMode !== 'undefined' ? uploadMode : 'single');   // eslint-disable-line no-undef -- index.html global
  function onUploadMode(m) { PV().list().forEach(p => { if (p.upload && typeof p.upload.syncMode === 'function') p.upload.syncMode(m); }); }
  function onOpenModal() { up.provider = defaultUploadProvider(); onUploadMode(legacyMode()); syncUpload(); }
  function setUploadProvider(code) { up.provider = code; syncUpload(); }
  function syncUpload() {
    const sel = $('up-provider'); if (!sel) return;
    const code = uploadProvider(), cfg = PV().get(code) || {};
    PV().list().forEach(p => { if (p.upload && p.upload.mount) p.upload.mount(); });
    sel.innerHTML = PV().list().map(p => `<option value="${p.code}"${p.status !== 'active' ? ' disabled' : ''}>${esc(p.name)}${p.status !== 'active' ? ' — coming soon' : ''}</option>`).join('');
    sel.value = code;
    const forms = { 'legacy-upload-ui': !!cfg.legacyUpload };
    PV().list().forEach(p => { if (p.uploadUi) forms[p.uploadUi] = p.code === code; });
    Object.entries(forms).forEach(([id, show]) => { const e = $(id); if (e) e.style.display = show ? '' : 'none'; });
    const na = $('prov-na-ui');
    if (na) { na.style.display = !cfg.legacyUpload && !cfg.uploadUi ? '' : 'none'; const nm = $('prov-na-name'); if (nm) nm.textContent = cfg.name || code; }
    const rb = $('reset-builtin-btn'); if (rb) rb.style.display = cfg.legacyUpload ? '' : 'none';
    const hint = $('up-prov-hint'); if (hint) hint.textContent = cfg.legacyUpload ? `Existing ${cfg.short} upload modes — unchanged` : cfg.uploadUi ? `Everything uploaded here is stored as ${cfg.short} data` : '';
    if (cfg.upload && cfg.upload.render) cfg.upload.render();
    if (typeof window.checkProcBtn === 'function') window.checkProcBtn();
  }
  const usesLegacyUpload = () => { const c = PV().get(uploadProvider()); return !c || !!c.legacyUpload; };
  const canProcess = () => { const c = PV().get(uploadProvider()); return !!(c && c.upload && c.upload.canProcess()); };
  function processUpload() { const c = PV().get(uploadProvider()); if (c && c.upload) c.upload.process(); }

  /* ── legacy upload history — best effort, never blocks ─────── */
  function recordLegacyUpload(sourceType, files, period) {
    try {
      (files || []).filter(f => f && f.name).forEach(f => window.ProviderCloud.recordBatch({ provider: PV().legacyCode(), source_type: sourceType,
        source_file: f.name, reporting_period: f.period || period || null, total_rows: f.rows, valid_rows: f.rows,
        duplicate_rows: 0, invalid_rows: 0, details: { mode: sourceType } }).then(renderUploads).catch(() => {}));
    } catch (e) { console.warn('[providers] legacy history', e); }
  }

  /* ── render + boot ─────────────────────────────────────────── */
  function renderPanels(view) {
    view = view || PV().currentView(); if (!view) return;
    renderPoolStrip(view); renderComparison(view); renderPool(view); renderUploads(); renderRtInfo(view); renderPriceNote(view);
    maybePopup(view);
  }
  function render(view) { renderBar(); renderChip(); renderPanels(view); }
  async function bootstrap() {
    const C = window.ProviderCloud;
    try {
      await C.probe();
      for (const p of PV().list()) if (typeof p.boot === 'function') { try { await p.boot(C); } catch (e) { console.warn('[providers] boot ' + p.code, e); } }
      if (C.state.ready) await C.loadHistory();
    } catch (e) { console.warn('[providers] cloud load failed:', e); C.state.reason = 'Cloud load failed: ' + e.message; }
    PV().refresh();
  }

  window.ProvidersUI = { render, renderPanels, beforeRender, bootstrap, onOpenModal, onUploadMode, setUploadProvider, uploadProvider,
    usesLegacyUpload, canProcess, processUpload, recordLegacyUpload, renderUploads, excNote, planNote, vsumExtra, afterVsum,
    columnChart, pickLatest, simFilter, simCsv, goPool, zeroFilter, zeroCsv, highCsv, pagerGo, openSim, closeSim, simSetCycle, simSetRange,
    // shared helpers for provider UI modules
    h: { esc, n0, gb, inr, pct, shortDate, MON, columnChart, tableView, reconHtml, svgChart } };
})();
