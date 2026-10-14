/* ============================================================
   providers/vi-ui.js — VI's UI, registered as hooks on its config
   ------------------------------------------------------------
   cfg.upload  { mount, render, canProcess, process, syncMode }  upload form
   cfg.ui      { reconSection, rtInfo, rtControls, pickDay, vsumExtra, afterVsum,
                 statusRuleControl, poolHeaderExtra, simModel, alertHistory, searchCard,
                 rtTitle, rtBanner, calcRows }
   cfg.boot()  load saved VI data at start-up
   Upload modes follow Airtel's: Monthly = Data Usage Summary (month-wise tabs),
   Real-time = Itemized report (Real-time tab + pool). The SIM Group file can go
   with either, or alone — the pool needs it.
   A future provider (Jio …) adds its own <code>-ui.js the same way —
   the shared UI (ui.js) and index.html do not change.
   ============================================================ */
(function () {
  'use strict';
  const P = window.Providers, V = window.ViProvider, UI = window.ProvidersUI;
  const cfg = P && P.get('vi');
  if (!cfg || !V || !UI) return;
  const { esc, n0, gb, shortDate, MON, columnChart, tableView, reconHtml } = UI.h;
  const $ = id => document.getElementById(id);
  const C = () => window.ProviderCloud;
  const check = () => { if (typeof window.checkProcBtn === 'function') window.checkProcBtn(); };
  const canEdit = () => typeof EDIT_MODE !== 'undefined' && !!EDIT_MODE;   // eslint-disable-line no-undef -- index.html global

  /* ── upload form: two modes, like Airtel's upload modes ──────── */
  const INV = 'vi_sim_inventory';
  const MODES = {
    monthly: { usage: 'vi_usage_summary', source: 'summary', other: 'realtime', btn: '📄 Monthly · Data Usage Summary', slot: 'Data Usage Summary', file: 'SELFCARE_USAGE_SUMMARY*.csv',
      info: 'Upload the <b>Data Usage Summary</b> (SELFCARE_USAGE_SUMMARY*.csv): one total per SIM for the billing cycle. It feeds the <b>month-wise</b> tabs — Vehicle Wise, Exceeded, Plan Summary, Downgrade, Trends and Price Analysis — and the <b>Data Pool</b>\'s used data when it is newer than the Itemized report. Add the <b>SIM Group</b> file (status, plan and activation date of every SIM) whenever you have a new one — the pool is built from it. SIMs without a vehicle number are listed as “No vehicle · mobile no.”. Re-uploading a month replaces it.' },
    realtime: { usage: 'vi_usage_itemized', source: 'itemized', other: 'monthly', btn: '📡 Real-time · Itemized report', slot: 'Itemized report', file: 'SELFCARE_USAGE_ITEMIZED*.csv',
      info: 'Upload the <b>Itemized report</b> (SELFCARE_USAGE_ITEMIZED*.csv): usage per SIM for every day of the billing cycle. It feeds the <b>Real-time Usage</b> tab (pick any day of the cycle), the daily pool charts, and the <b>Data Pool</b>\'s used data unless the Data Usage Summary is newer. The pool size comes from the <b>SIM Group</b> file — add it whenever you have a new one. Re-uploading a cycle replaces it.' },
  };
  const modeOf = type => (type === 'vi_usage_summary' ? 'monthly' : type === 'vi_usage_itemized' ? 'realtime' : null);
  function mount() {
    const host = $('provider-upload-forms');
    if (!host || $('vi-upload-ui')) return;
    host.insertAdjacentHTML('beforeend', `
      <div id="vi-upload-ui" style="display:none">
        <div class="mode-toggle">${Object.entries(MODES).map(([k, m]) => `<button type="button" class="mode-btn" id="vi-mode-${k}" onclick="ViUI.setMode('${k}')">${m.btn}</button>`).join('')}</div>
        <div id="vi-checklist"></div>
        <div class="info-box" id="vi-mode-info"></div>
        <div class="slot vi-drop" id="slot-vi" onclick="document.getElementById('fi-vi').click()" ondragover="dov(event,'slot-vi')" ondragleave="dlv('slot-vi')" ondrop="ViUI.drop(event)">
          <input type="file" id="fi-vi" class="slot-file-input" accept=".csv,.xlsx,.xls" multiple onchange="ViUI.pick(event)">
          <div class="slot-icon">📡</div>
          <div class="slot-title" id="vi-slot-title"></div>
          <div class="slot-hint" id="vi-slot-hint"></div>
        </div>
        <div id="vi-file-cards" class="vi-cards"></div>
        <div id="vi-month-row" class="vi-month" style="display:none"></div>
        <div id="vi-recon-preview"></div>
      </div>`);
  }

  // until: Real-time mode's "Data up to" day (like Airtel's snapshot date); null = the report's last day with data
  // noHistory: the SIM Group history or the pool evaluations failed to load at start-up — nothing derived is saved
  const st = { mode: 'monthly', files: {}, unknown: [], month: null, monthTouched: false, until: null, busy: false, noHistory: false };
  const HINT = { vi_usage_summary: 'SELFCARE_USAGE_SUMMARY*.csv — one total per SIM for the billing cycle',
    vi_usage_itemized: 'SELFCARE_USAGE_ITEMIZED*.csv — usage per SIM per day',
    vi_sim_inventory: 'SIMGROUP*.csv — status, plan and activation date of every SIM, including unused ones. Keep VI\'s file name: its export time is read from it.' };
  async function readFileText(file) {
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
      return window.XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]], { blankrows: false });
    }
    return await file.text();
  }
  // A usage file counts only in its own mode; the SIM Group file counts in both
  const usable = t => { const e = st.files[t]; return e && (t === INV || modeOf(t) === st.mode) && e.parsed && e.parsed.type && !e.parsed.fatal && !e.error && !e.duplicateOf ? e : null; };
  function monthOptions(selected, existing) {
    const now = new Date(), set = new Set(existing);
    for (let i = -1; i < 24; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); set.add(MON[d.getMonth()] + ' ' + d.getFullYear()); }
    if (selected) set.add(selected);
    return P.sortMonths([...set]).reverse().map(l => `<option value="${esc(l)}"${l === selected ? ' selected' : ''}>${esc(l)}${existing.includes(l) ? ' · has VI data' : ''}</option>`).join('');
  }
  const today = () => V.state.today || (() => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; })();
  function suggestedMonth() {
    const e = st.files[MODES[st.mode].usage];
    return (e && e.parsed && e.parsed.suggestedMonth) || V.monthLabelForDate(today());
  }
  async function addFiles(list) {
    for (const f of [...(list || [])]) {
      const e = { name: f.name, size: f.size };
      try {
        const text = await readFileText(f);
        e.parsed = V.parseFile(text, f.name);
        e.hash = await C().sha256(text);
        if (e.parsed.type) e.duplicateOf = await C().findBatch('vi', e.parsed.type, e.hash);
      } catch (err) { e.error = err.message; }
      if (e.parsed && e.parsed.type) { st.files[e.parsed.type] = e; st.unknown = st.unknown.filter(u => u.name !== e.name); if (e.parsed.type === 'vi_usage_itemized') st.until = null; }
      else st.unknown = st.unknown.filter(u => u.name !== e.name).concat(e);
    }
    if (!st.monthTouched) st.month = suggestedMonth();
    render(); check();
  }
  function card(type) {
    const e = st.files[type], label = V.TYPE_LABELS[type];
    if (!e) return `<div class="vi-card vi-missing"><div class="vi-card-h"><span class="vi-ic">○</span><b>${esc(label)}</b><span class="vi-opt">${type === INV ? (V.state.inventory ? 'add a newer one when you have it' : 'required for the pool') : 'required'}</span></div><div class="vi-card-s">${esc(HINT[type])}</div></div>`;
    const p = e.parsed || {}, s = p.stats || {};
    const state = e.error || p.fatal ? 'bad' : e.duplicateOf ? 'dup' : (s.invalid || s.duplicates || (p.warnings || []).length) ? 'warn' : 'ok';
    const out = [];
    if (e.error || p.fatal) out.push(`<div class="vi-err">${esc(e.error || p.fatal)}</div>`);
    else {
      out.push(`<div class="vi-stats"><span><b>${n0(s.total)}</b> rows</span><span><b>${n0(s.valid)}</b> valid</span><span class="${s.duplicates ? 'vi-w' : ''}"><b>${n0(s.duplicates)}</b> duplicate</span><span class="${s.invalid ? 'vi-e' : ''}"><b>${n0(s.invalid)}</b> invalid</span><span><b>${n0(s.unique_sims)}</b> SIMs</span>${type !== INV ? `<span><b>${gb(s.total_mb / 1024)}</b></span>` : ''}</div>`);
      if (type === 'vi_usage_itemized') out.push(`<div class="vi-card-s">Days ${shortDate(s.period_start)} – ${shortDate(s.period_end)} → ${esc((s.cycles || []).length > 1 ? s.cycles.map(c => c.label).join(' + ') + ' cycles' : (p.suggestedMonth || '—') + ' cycle')} · daily values in ${esc(p.unit)}${p.unitCheck ? ` (confirmed on ${n0(p.unitCheck.bytes + p.unitCheck.kb)} rows)` : ''}</div>`);
      if (type === 'vi_usage_summary') out.push(`<div class="vi-card-s">Usage unit ${esc(p.unit)} · last session ${esc(s.max_last_session || '—')} → ${esc(p.suggestedMonth || '—')} cycle</div>`);
      if (type === INV) {
        // States exactly as VI writes them, and which of them count in the pool
        out.push(`<div class="vi-card-s">${Object.entries(s.states || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${n0(v)}${V.ruleFor(k) ? ' (counts)' : ''}`).join(' · ')}</div>`);
        const cur = V.state.inventory, older = cur && p.exportedAt && String(p.exportedAt) < String(cur.as_of);
        out.push(`<div class="vi-card-s">${p.exportedAt ? `Exported ${esc(shortDate(p.exportedAt))} ${esc(p.exportedAt.slice(11, 16))} (from the file name)` : '⚠ No export date in the file name — taken as today. Keep VI\'s original file name (…_YYYYMMDDHHMMSS.csv): the export date decides which cycle the file describes and when Ready SIMs went live.'}</div>`);
        if (older) out.push(`<div class="vi-note">This export is older than the SIM Group already loaded (${esc(shortDate(cur.as_of))}). It is kept as history — it helps date SIMs that were Ready — and does not replace the newer one.</div>`);
      }
      if (e.duplicateOf) out.push(`<div class="vi-dup">↺ This exact file was already uploaded${e.duplicateOf.uploaded_at ? ' on ' + esc(new Date(e.duplicateOf.uploaded_at).toLocaleString()) : ''} — it will be skipped, nothing is counted twice.${type === 'vi_usage_itemized' ? ` To load it with a different “Data up to” date, delete its cycle${e.duplicateOf.reporting_period ? ` (${esc(e.duplicateOf.reporting_period)})` : ''} on the Uploads tab first.` : ''}</div>`);
      const issues = (p.errors || []).map(x => Object.assign({ kind: 'Error' }, x)).concat((p.warnings || []).map(x => Object.assign({ kind: 'Warning' }, x)));
      if (issues.length) out.push(`<details class="vi-issues"><summary>View errors & warnings (${issues.length})</summary><table><thead><tr><th>Type</th><th>Line</th><th>Field</th><th>Value</th><th>Reason</th></tr></thead><tbody>${issues.slice(0, 200).map(x => `<tr><td>${x.kind}</td><td>${esc(x.line)}</td><td>${esc(x.field)}</td><td class="mono">${esc(x.value)}</td><td>${esc(x.reason)}</td></tr>`).join('')}</tbody></table></details>`);
    }
    const icon = { ok: '✅', warn: '⚠️', bad: '❌', dup: '↺' }[state];
    return `<div class="vi-card vi-${state}"><div class="vi-card-h"><span class="vi-ic">${icon}</span><b>${esc(label)}</b><span class="vi-fn" title="${esc(e.name)}">${esc(e.name)}</span><button type="button" class="vi-x" onclick="ViUI.remove('${type}')" title="Remove this file" aria-label="Remove ${esc(label)}">✕</button></div>${out.join('')}</div>`;
  }
  // A usage file dropped in the other mode: not used here — offer to switch
  function wrongCard(type) {
    const e = st.files[type]; if (!e) return '';
    const to = modeOf(type), m = MODES[to];
    return `<div class="vi-card vi-warn"><div class="vi-card-h"><span class="vi-ic">↔</span><b>${esc(V.TYPE_LABELS[type])}</b><span class="vi-fn" title="${esc(e.name)}">${esc(e.name)}</span><button type="button" class="vi-x" onclick="ViUI.remove('${type}')" title="Remove this file" aria-label="Remove ${esc(V.TYPE_LABELS[type])}">✕</button></div>`
      + `<div class="vi-note">This file is for <b>${esc(m.btn)}</b> mode — it is not used in this mode.</div><button type="button" class="vi-switch" onclick="ViUI.setMode('${to}')">Switch to ${esc(m.btn)}</button></div>`;
  }
  // What VI needs, what is already loaded and what is missing — for every upload
  function checklist() {
    const months = V.state.months, labels = P.sortMonths(Object.keys(months));
    const lastWith = src => labels.filter(l => months[l].sources && months[l].sources[src]).pop() || null;
    const ls = lastWith('summary'), li = lastWith('itemized'), inv = V.state.inventory, now = today();
    const tc = V.cycleForDate(now);
    const row = (type, name, need, have, sub, stale) => {
      const adding = !!usable(type);
      const tag = adding ? '<span class="vi-ck-tag add">In this upload</span>' : have ? `<span class="vi-ck-tag ${stale ? 'old' : 'ok'}">${stale ? 'Uploaded · old' : 'Uploaded'}</span>` : '<span class="vi-ck-tag miss">Missing</span>';
      return `<tr><td>${esc(name)}</td><td>${esc(need)}</td><td>${tag}</td><td class="vi-ck-s">${esc(sub)}</td></tr>`;
    };
    const invStale = !!(inv && tc && String(inv.as_of).slice(0, 10) < tc.start);
    const itLast = li ? V.itemizedLast(months[li]) : null;
    return `<table class="vi-ck" aria-label="VI files"><thead><tr><th>VI file</th><th>Needed for</th><th>Status</th><th>Latest</th></tr></thead><tbody>`
      + row(INV, 'SIM Group', 'Required — the pool (status, plan, activation date)', !!inv, inv ? `exported ${shortDate(inv.as_of)}${invStale ? ' · before this cycle started — upload a newer one' : ''}` : 'upload SIMGROUP*.csv', invStale)
      + row('vi_usage_summary', 'Data Usage Summary', 'Required — month-wise tabs; pool used when newest (Monthly mode)', !!ls, ls ? `${ls} cycle${months[ls].summary_asof ? ' · to ' + shortDate(months[ls].summary_asof) : ''}` : 'upload in Monthly mode')
      + row('vi_usage_itemized', 'Itemized report', 'Required — Real-time tab, daily charts; pool used when newest (Real-time mode)', !!li, li ? `${li} cycle${itLast ? ' · to ' + shortDate(itLast) : ''}` : 'upload in Real-time mode',
        !!(itLast && tc && li === tc.label && V.dayDiff(itLast, now) > 2))
      + '</tbody></table>';
  }
  function render() {
    const el = $('vi-file-cards'); if (!el) return;
    const M = MODES[st.mode];
    Object.keys(MODES).forEach(k => { const b = $('vi-mode-' + k); if (b) { b.classList.toggle('active', k === st.mode); b.setAttribute('aria-pressed', String(k === st.mode)); } });
    const ck = $('vi-checklist'); if (ck) ck.innerHTML = checklist();
    const info = $('vi-mode-info'); if (info) info.innerHTML = M.info;
    const ttl = $('vi-slot-title'); if (ttl) ttl.textContent = `Drop the ${M.slot} and/or the SIM Group file here`;
    const hint = $('vi-slot-hint'); if (hint) hint.textContent = `${M.file} · SIMGROUP*.csv · .csv or .xlsx`;
    const unknown = st.unknown.map(e => `<div class="vi-card vi-bad"><div class="vi-card-h"><span class="vi-ic">❌</span><b>Not a VI export</b><span class="vi-fn">${esc(e.name)}</span></div><div class="vi-err">${esc(e.error || (e.parsed && e.parsed.fatal) || 'Unrecognised columns')}</div></div>`).join('');
    el.innerHTML = [M.usage, INV].map(card).join('') + wrongCard(MODES[M.other].usage) + unknown;
    const U = usable(M.usage);
    // Real-time: the date to choose is the "Data up to" day — like Airtel's snapshot date, within the days the report
    // covers. Its billing cycle (22nd → 21st) is the one this upload brings up to date; earlier cycles the report has
    // every day of are filled too (itemizedCycles)
    const isRt = st.mode === 'realtime' && !!U;
    const r = isRt ? untilRange(U) : null;
    if (r && (!st.until || st.until < r.first || st.until > r.last)) st.until = r.def;
    const lock = isRt ? V.monthLabelForDate(st.until) || U.parsed.suggestedMonth : null;
    if (lock) st.month = lock;
    const plan = isRt ? V.itemizedCycles(U.parsed, st.until) : null;
    const mr = $('vi-month-row');
    if (mr) {
      if (lock || (st.mode === 'monthly' && st.files[M.usage])) {
        const existing = Object.keys(V.state.months);
        const has = l => { const ex = V.state.months[l]; return !!(U && ex && ex.sources[M.source]); };
        const replacing = [st.month].concat(plan ? plan.extra : []).filter(has);
        const cyc = V.cycleForLabel(st.month), range = cyc ? `${shortDate(cyc.start)} – ${shortDate(cyc.end)}` : '';
        const multi = plan && (U.parsed.stats.cycles || []).length > 1;
        const list = ls => ls.map(l => `<b>${esc(l)}</b>`).join(', ');
        mr.style.display = '';
        mr.innerHTML = (lock
          ? `<label class="sec-ey" for="vi-until">📅 Data up to</label><input type="date" id="vi-until" class="fsel" style="padding:8px 12px;font-family:'Roboto',monospace;color-scheme:dark" min="${r.first}" max="${r.last}" value="${st.until}" onchange="ViUI.setUntil(this.value)">`
            + `<span class="vi-card-s">The date this report's data runs to — like Airtel's snapshot date. The report covers <b>${esc(shortDate(r.first))} – ${esc(shortDate(r.last))}</b>; days after the date you pick are left out (pick the day before if the export was taken during the day). Billing cycle <b>${esc(st.month)}</b> = ${esc(range)}, the cycle of that date. Usage resets on the 22nd.</span>`
          : `<label class="sec-ey" for="vi-month">Billing cycle</label><select id="vi-month" class="gf-select" onchange="ViUI.setMonth(this.value)">${monthOptions(st.month, existing)}</select>`
            + `<span class="vi-card-s">The Summary has no dates — cycle suggested from its last sessions: ${esc(range)}. Please confirm. Usage resets on the 22nd.</span>`)
          + (multi ? `<div class="vi-note">ℹ The Itemized report crosses the 22nd (${U.parsed.stats.cycles.map(c => `${esc(c.label)}: ${c.days} days${c.complete ? ', complete' : ''}`).join(' · ')}). Each billing cycle gets its own days: ${list([st.month])} up to the date above${plan.extra.length ? `, and ${list(plan.extra)} as ${plan.extra.length > 1 ? 'closed cycles' : 'a closed cycle'} (every day is in the file)` : ''}.${plan.skipped.length ? ` ${list(plan.skipped)}: only part of the cycle is in the file — not used.` : ''}${plan.later.length ? ` ${list(plan.later)}: after the date above — left out.` : ''}</div>` : '')
          + (replacing.length ? `<div class="vi-note">⚠ ${list(replacing)} already ${replacing.length > 1 ? 'have' : 'has'} a ${esc(M.slot)} — processing <b>replaces</b> it, never adds it twice.</div>` : '');
      } else { mr.style.display = 'none'; mr.innerHTML = ''; }
    }
    const rp = $('vi-recon-preview');
    // The pool is built from the SIM Group file: without one there is usage but no pool size
    const warn = U && !usable(INV) && !V.state.inventory
      ? `<div class="vi-recon warn"><b>⚠ No SIM Group file yet</b> · usage is loaded, but the pool needs the SIM Group file (SIMGROUP*.csv): each SIM's status, plan and activation date. Add it here or in a later upload.</div>` : '';
    // When the other report of the same cycle is already saved, the two are compared — never added
    const parts = {}; if (U) parts[M.source] = U.parsed;
    const recon = U ? reconHtml(V.mergeMonth(V.state.months[st.month] || null, parts, st.month || 'preview', null, { until: lock ? st.until : null }).recon) : '';
    if (rp) rp.innerHTML = warn + recon;
  }
  // The days an Itemized report covers (every cycle in it); default "data up to" = its last day with data
  function untilRange(U) {
    const days = U.parsed.stats.dates || [];
    const first = days[0] || null, last = days[days.length - 1] || null, lu = U.parsed.stats.last_data_date;
    return { first, last, def: lu && first && lu >= first && lu <= last ? lu : last };
  }
  function setUntil(v) { st.until = /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null; render(); check(); }
  function canProcess() {
    const U = usable(MODES[st.mode].usage);
    return !st.busy && !!(U || usable(INV)) && (!U || !!st.month);
  }
  // Closed cycles frozen since the last save → the cloud (an admin's recompute overwrites). Not while this session
  // lacks the SIM Group history (a freeze built without it would be stored for good).
  async function savePending() {
    if (st.noHistory) return { saved: 0, total: 0 };
    const list = V.takePendingFreeze();
    if (!list.length || !C().state.ready || !canEdit()) return { saved: 0, total: list.length };
    let saved = 0;
    for (const { rec, force } of list) { const r = await C().saveCyclePool('vi', rec, force); if (r.saved) saved++; }
    return { saved, total: list.length };
  }
  // After new data (upload, start-up, a rule change): keep this pool evaluation and update the shared-pool alert —
  // open, update, escalate or resolve the ONE open alert; only an Admin saves (viewers evaluate in memory)
  // Always on the latest view: a past "as of" day on screen must not decide (or skip) the alert. `unsaved`: this
  // tab's data did not reach the cloud (a failed save) — evaluate it here, but write nothing others would read.
  // The same while the start-up history failed to load (st.noHistory): figures built without it are not recorded.
  async function syncOps(opts) {
    const ds = V.latestDataset(); if (!ds || !ds.pool || !ds.pool.hasPool) return;
    const cloud = C(), now = new Date().toISOString();
    // data that did not reach the cloud: show its alert, but keep nothing — no evaluation or alert is recorded from it
    if ((opts && opts.unsaved) || st.noHistory) {
      const raw = P.raw('vi'); if (!raw || !raw.hasData) return;
      // history missing: the stored alert (worked out with all of it) stays on screen rather than this tab's figures
      if (st.noHistory && V.state.alert && V.state.alert.persisted) { if (raw.poolAlert !== V.state.alert) { raw.poolAlert = V.state.alert; P.refresh(); } return; }
      const res = V.evaluatePoolAlert(ds.pool, ds.poolMonth, V.state.alert, now).map(o => o.alert);
      if (res.length) {                                 // opened / updated → shown; resolved → no banner
        const shown = res.filter(a => a.status === 'open').pop();
        raw.poolAlert = shown ? Object.assign({ id: 'unsaved' }, shown) : null; P.refresh();
      }
      return;
    }
    const save = cloud.state.ready && canEdit();
    let snapChanged = false, alertChanged = false;
    const row = V.poolSnapshotRow(ds);
    if (row && V.addPoolSnapshot(row)) snapChanged = true;
    // an evaluation kept here but not stored yet (this one, or one from before a failed write) is stored now
    const kept = row && V.findPoolSnapshot(row);
    if (save && kept && !kept.saved) { const r = await cloud.savePoolSnapshot(kept); if (r.saved) kept.saved = true; }
    // the snapshot feeds the forecast (pace points, confirmation): evaluate the alert on the rebuilt figures
    const cur = snapChanged ? (V.rebuild({ silent: true }), V.latestDataset()) : ds;
    const adopt = stored => {                         // another tab moved the alert on: take the stored row
      const s = Object.assign({}, stored, { details: stored.details || {}, persisted: true });
      V.state.alertHistory = [s].concat(V.state.alertHistory.filter(x => x.id !== s.id));
      V.state.alert = s.status === 'open' ? s : (V.state.alert && V.state.alert.id === s.id ? null : V.state.alert);
      alertChanged = true;
    };
    let stale = false;
    for (const o of V.evaluatePoolAlert(cur.pool, cur.poolMonth, V.state.alert, now)) {
      const a = o.alert, before = V.state.alert && V.state.alert.id === a.id ? V.state.alert : null;
      if (!a.id) a.id = cloud.uuid();
      if (save) {
        const r = await cloud.saveAlert(a, before && before.persisted ? { expected: before.last_updated } : {});
        if (r.saved) a.persisted = true;
        else if (r.stale) { console.info('[vi] the stored alert changed in another tab — using it:', r.stored); adopt(r.stored); stale = true; break; }
      }
      V.state.alertHistory = [a].concat(V.state.alertHistory.filter(x => x.id !== a.id));
      V.state.alert = a.status === 'open' ? a : (V.state.alert && V.state.alert.id === a.id ? null : V.state.alert);
      alertChanged = true;
    }
    // an open alert kept here but never stored (a failed write before) is stored now
    const al = V.state.alert;
    if (save && !stale && al && !al.persisted) {
      const r = await cloud.saveAlert(al, {});
      if (r.saved) al.persisted = true; else if (r.stale) adopt(r.stored);
    }
    // one redraw: the dataset on screen was rebuilt silently above (if needed); give it the evaluated alert
    if (snapChanged || alertChanged) { const raw = P.raw('vi'); if (raw && raw.hasData) raw.poolAlert = V.state.alert; P.refresh(); }
  }
  // Pieces the dataset asked for that load on demand: the daily figures of just the SIMs whose go-live day needs them
  // (never a whole cycle), a SIM Group export a closed cycle is built from, a frozen cycle's SIM list. Up to 3 rounds
  // (a loaded piece can reveal the next one).
  async function loadNeededDaily() {
    if (!C().state.ready) return false;
    let any = false;
    for (let round = 0; round < 3; round++) {
      const ds = P.raw('vi'); if (!ds || !ds.hasData) break;
      let got = false;
      for (const { label, iccids } of ds.needsDailySims || []) {
        const m = V.state.months[label]; if (!m || m.daily) continue;
        const want = iccids.filter(k => !(m.dailySims && k in m.dailySims)); if (!want.length) continue;
        // a failed load is not retried this session: go-live days then fall back to the Summary bound / export date
        try { const d = await C().loadPeriodDaily('vi', label, want); if (d) { V.setDailySims(label, d, want); got = true; } }
        catch (e) { console.warn('[vi] daily usage load failed', e); m.dailyFailed = true; got = true; }
      }
      for (const asOf of ds.needsSnapshots || []) {
        try { const s = await C().loadSnapshot('vi', asOf); if (s) { V.addLoadedSnapshot(s); got = true; } } catch (e) { console.warn('[vi] SIM Group export load failed', e); }
      }
      for (const label of ds.needsFrozen || []) {
        try { const sims = await C().loadFrozenSims('vi', label); if (sims) { V.setFrozenSims(label, sims); got = true; } } catch (e) { console.warn('[vi] frozen pool load failed', e); }
      }
      if (!got) break;
      any = true; V.rebuild();
    }
    return any;
  }
  async function process() {
    if (!canProcess()) {
      if (Object.values(st.files).some(e => e && e.duplicateOf)) window.showToast('Nothing new — every selected file was already uploaded', 'info');
      return;
    }
    st.busy = true;
    const mode = st.mode, M = MODES[mode];
    const U = usable(M.usage), Inv = usable(INV);
    const label = U ? st.month : null, cloud = C();
    const until = mode === 'realtime' && U ? st.until : null;
    // An Itemized report that crosses the 22nd also fills every earlier cycle it has every day of (itemizedCycles)
    const extra = mode === 'realtime' && U ? V.itemizedCycles(U.parsed, until).extra : [];
    try {
      // A cycle still loading in the background (only its period row is here): load it first — merging into an empty
      // shell would replace the other report's per-SIM figures in the cloud. Before anything is recorded.
      for (const l of [label].concat(extra)) {
        if (!l || !V.state.months[l] || !V.state.months[l].light) continue;
        window.setProgress(15, `Loading ${l} from the cloud…`);
        const r = cloud.state.ready ? await cloud.loadPeriods('vi', [l]).catch(() => null) : null;
        const m = r && r.months[l];
        if (!m) throw new Error(`${l} has not finished loading from the cloud — try again in a moment`);
        m.recon = V.reconcile(m); V.addMonths(r.months);
      }
      window.setProgress(25, 'Recording upload…');
      const ids = { usage: U && cloud.uuid(), inventory: Inv && cloud.uuid() };
      const batches = [];
      for (const [k, e] of [['usage', U], ['inventory', Inv]]) {
        if (!e) continue;
        const p = e.parsed, s = p.stats;
        batches.push(await cloud.recordBatch({ id: ids[k], provider: 'vi', source_type: p.type, source_file: e.name, file_hash: e.hash,
          reporting_period: k === 'inventory' ? null : label, period_start: s.period_start || null, period_end: s.period_end || null,
          total_rows: s.total, valid_rows: s.valid, duplicate_rows: s.duplicates, invalid_rows: s.invalid,
          total_mb: s.total_mb != null ? Math.round(s.total_mb * 10000) / 10000 : null,
          details: { mode, data_up_to: k === 'usage' ? until : null, cycles: k === 'usage' && extra.length ? [label].concat(extra) : null, unit: p.unit, unique_sims: s.unique_sims, exported_at: p.exportedAt, states: s.states || null,
            errors: (p.errors || []).slice(0, 50), warnings: (p.warnings || []).slice(0, 50) } }));
      }
      window.setProgress(60, 'Building VI dataset…');
      const parts = { inventory: Inv && Inv.parsed }, metas = { inventory: Inv && { batch_id: ids.inventory } };
      if (U) { parts[M.source] = U.parsed; metas[M.source] = { batch_id: ids.usage, file: U.name, hash: U.hash }; }
      // the cycle of the "Data up to" day with the SIM Group file first (a closed cycle freezes with the history it brings),
      // then each earlier cycle the report has every day of — its own days only
      const res = V.applyUpload(parts, label, metas, { until });
      const extraRes = extra.map(l => V.applyUpload({ itemized: U.parsed }, l, { itemized: metas.itemized }, { until: null }));
      const extraMonths = extraRes.map(r => r.month).filter(Boolean);
      res.frozenNow += extraRes.reduce((a, r) => a + (r.frozenNow || 0), 0);
      let cloudMsg = cloud.state.ready ? 'saved to cloud' : 'this session only — run the SQL migration to save';
      let saveFailed = false;
      if (cloud.state.ready) {
        window.setProgress(85, 'Saving to cloud…');
        let err = null;
        for (const m of extraMonths) {
          if (err) break;
          const r = await cloud.savePeriod('vi', m, { itemized: U.parsed });
          if (!r.saved) err = r.error || r.reason;
        }
        if (!err && res.month) {
          const r = await cloud.savePeriod('vi', res.month, { itemized: mode === 'realtime' && U ? U.parsed : null },
            (i, n) => window.setProgress(85 + Math.round(i / n * 10), `Saving to cloud… ${i} of ${n}`));
          if (!r.saved) err = r.error || r.reason;
        }
        if (!err && Inv) {
          // Every export goes to the history; only the newest is the current SIM inventory
          const sn = await cloud.saveSnapshot('vi', res.inventory, ids.inventory);
          if (!sn.saved && sn.error) console.warn('[vi] SIM Group history not saved:', sn.error.message || sn.error);
          if (!res.inventoryOlder) { const r = await cloud.saveInventory('vi', res.inventory, ids.inventory); if (!r.saved) err = r.error || r.reason; }
        }
        if (err) { saveFailed = true; await cloud.markBatches(batches.map(b => b.id), 'failed', { error: String(err.message || err) }); cloudMsg = 'NOT saved to cloud: ' + (err.message || err); }
      }
      if (!saveFailed) await savePending();          // a freeze built on data that did not save waits for the next good save
      $('proc-bar').style.display = 'none';
      if (typeof window.closeModal === 'function') window.closeModal();
      reset();
      if (!P.inView('vi')) P.select('vi'); else P.refresh();
      // Like Airtel: a real-time upload opens the Real-time tab
      if (mode === 'realtime' && res.month && typeof window.showTab === 'function') window.showTab('realtime');
      const m = res.month, sims = m ? V.simTotals(m, M.source) : null;
      const usage = sims ? [...sims.values()].reduce((a, x) => a + x.used_mb, 0) / 1024 : 0;
      const recon = m && m.recon && m.recon.status === 'matched' ? ' · matches the other report ✓' : m && m.recon && m.recon.status === 'difference' ? ' · ⚠ differs from the other report (Uploads tab)' : '';
      const what = mode === 'monthly' ? 'monthly (Summary)' : `real-time (Itemized, data up to ${shortDate(until || (m && m.itemized_last))})`;
      const invTxt = Inv ? (res.inventoryOlder ? `SIM Group of ${shortDate(Inv.parsed.exportedAt)} kept as history (older than the loaded one)` : `${n0(res.inventory.sims.length)} SIMs in the SIM Group`) : '';
      const frozeTxt = res.frozenNow ? ` · ${n0(res.frozenNow)} closed cycle(s) frozen` : '';
      const extraTxt = extraMonths.length ? ` · also ${extraMonths.map(x => x.label).join(', ')} (every day of the cycle)` : '';
      window.showToast(`✅ VI ${U ? what : ''}${label ? ' ' + label : ''}${m ? ': ' + n0(sims.size) + ' SIMs · ' + gb(usage) : ''}${extraTxt}${invTxt ? (U ? ' · ' : '') + invTxt : ''}${recon}${frozeTxt} · ${cloudMsg}`, cloudMsg.startsWith('NOT') ? 'error' : 'success');
      UI.renderUploads();
      await loadNeededDaily();
      await syncOps({ unsaved: saveFailed });
    } catch (e) {
      console.error('[vi-upload]', e);
      $('proc-bar').style.display = 'none';
      window.showToast('❌ VI upload failed: ' + e.message, 'error');
    } finally { st.busy = false; check(); }
  }
  function reset() { st.files = {}; st.unknown = []; st.month = null; st.monthTouched = false; st.until = null; const i = $('fi-vi'); if (i) i.value = ''; render(); }
  function setMode(m) {
    if (!MODES[m]) return;
    if (st.mode !== m) { st.mode = m; st.monthTouched = false; st.until = null; st.month = suggestedMonth(); }
    render(); check();
  }
  // The dialog's (Airtel) upload mode → VI's: Real-time portal → Real-time, Single / Multi-month → Monthly
  const syncMode = legacy => setMode(legacy === 'realtime' ? 'realtime' : 'monthly');

  /* ── panel hooks ───────────────────────────────────────────── */
  function reconSection() {
    const months = P.sortMonths(Object.keys(V.state.months)).reverse();
    if (!months.length) return '';
    return `<div class="pv-card-t" style="margin:14px 0 8px">VI data reconciliation</div>` + months.map(l => {
      const m = V.state.months[l], r = m.recon || {}, out = m.outside_days || [], fr = V.state.frozen[l];
      const rows = (r.mismatches || []).slice(0, 200).map(x => `<tr><td class="mono">${esc(x.iccid)}</td><td>${esc(x.circle)}</td><td class="num">${x.summary_mb.toFixed(3)}</td><td class="num">${x.itemized_mb.toFixed(3)}</td><td class="num">${x.diff_mb.toFixed(3)}</td></tr>`).join('');
      // Days saved under the wrong cycle (uploaded before the 22nd rule): not counted — fix by deleting + re-uploading
      const wrong = out.length ? `<div class="vi-recon warn"><b>⚠ ${out.length} day(s) from another billing cycle</b> · ${esc(shortDate(out[0]))}${out.length > 1 ? ' – ' + esc(shortDate(out[out.length - 1])) : ''} belong to the ${esc(V.monthLabelForDate(out[0]))} cycle, but were saved under ${esc(l)} before the 22nd reset rule. They are not counted. Delete this cycle and upload its files again — each file then goes to its own cycle.</div>` : '';
      const del = canEdit() ? `<button type="button" class="vi-del" onclick="ViUI.deleteCycle('${esc(l)}')" title="Remove this cycle's usage (for a wrong upload) — its files can then be uploaded again">🗑 Delete cycle</button>` : '';
      const pool = fr ? `<div class="vi-recon ok"><b>🔒 Pool frozen</b> · ${gb(fr.pool_gb)} from ${n0(fr.eligible_sims)} SIMs · built from the SIM Group of ${esc(shortDate(fr.snapshot_at))} on ${esc(shortDate(String(fr.computed_at).slice(0, 10)))}${fr.computed_by ? ' by ' + esc(fr.computed_by) : ''}. Newer SIM Group files do not change it.${canEdit() ? ` <button type="button" class="vi-del" style="margin-left:6px" onclick="ViUI.recomputeCycle('${esc(l)}')" title="Build this cycle's pool again from its SIM Group under the current rules">↻ Recompute</button>` : ''}</div>` : '';
      return `<div class="pv-card"><div class="pv-card-t">VI · ${esc(l)} <span class="pv-muted">${m.period_start ? esc(shortDate(m.period_start) + ' – ' + shortDate(m.period_end)) : 'cycle dates unknown'} · Monthly (Summary) ${m.sources.summary ? '✓' : '—'} · Real-time (Itemized) ${m.sources.itemized ? '✓' : '—'}</span>${del}</div>${wrong}${pool}${reconHtml(r)}${rows ? `<details class="vi-issues"><summary>View differing rows (${r.mismatches.length})</summary><table><thead><tr><th>ICCID</th><th>Circle</th><th>Summary MB</th><th>Itemized MB</th><th>Diff MB</th></tr></thead><tbody>${rows}</tbody></table></details>` : ''}</div>`;
    }).join('');
  }
  async function deleteCycle(label) {
    const c = V.cycleForLabel(label);
    if (!V.state.months[label]) return;
    if (!confirm(`Delete the VI ${label} cycle${c ? ` (${shortDate(c.start)} – ${shortDate(c.end)})` : ''}?\n\nIts usage is removed for everyone. The upload history keeps a record, and the same files can be uploaded again.`)) return;
    // the uploads that filled it — one Itemized report can fill two cycles but is recorded under one of them
    const src = V.state.months[label].sources || {};
    const ids = [src.summary, src.itemized].map(s => s && s.batch_id).filter(Boolean);
    const r = await C().deletePeriod('vi', label);
    if (!r.deleted) { window.showToast('❌ Could not delete: ' + ((r.error && r.error.message) || r.reason || 'unknown error'), 'error'); return; }
    if (ids.length) await C().markBatches(ids, 'deleted', { deleted_cycle: label });   // so the same file can be uploaded again
    if (P.selectedMonth() === label) P.selectMonth('latest');
    V.removeMonth(label);                              // also drops that cycle's pool evaluations
    if (C().state.ready && canEdit()) await C().deletePoolSnapshots('vi', label);
    // its open alert was about data that no longer exists
    const al = V.state.alert;
    if (al && al.reporting_period === label) {
      const now = new Date().toISOString();
      const a = Object.assign({}, al, { status: 'resolved', resolved_at: now, last_updated: now, resolution_reason: `The ${label} usage was deleted (wrong upload) — the alert no longer applies.` });
      if (C().state.ready && canEdit()) await C().saveAlert(a, { force: true });
      V.state.alertHistory = [a].concat(V.state.alertHistory.filter(x => x.id !== a.id));
      V.state.alert = null;
    }
    await loadNeededDaily();                           // the pool may now be another cycle: the daily figures it needs
    await syncOps();
    if (C().state.ready) await C().loadHistory();
    UI.renderUploads();
    window.showToast(`🗑 VI ${label} deleted — its files can be uploaded again`, 'success');
  }
  async function recomputeCycle(label) {
    if (!canEdit()) return;
    if (st.noHistory) { window.showToast('❌ The SIM Group history did not load at start-up — reload the page, then recompute', 'error'); return; }
    if (!confirm(`Recompute the VI ${label} pool?\n\nIt is built again from its SIM Group file under the current rules, for everyone. Use this after changing a rule or uploading a better SIM Group file for that cycle.`)) return;
    let r = V.recomputeCycle(label);
    if (!r.ok && r.needs && C().state.ready) {                       // its SIM Group export was not loaded yet — load it, try again
      const s = await C().loadSnapshot('vi', r.needs);
      if (s) { V.addLoadedSnapshot(s); r = V.recomputeCycle(label); }
    }
    if (!r.ok && r.needsDaily && C().state.ready) {                  // daily figures its go-live days need — load them, try again
      for (const { label: l, iccids } of r.needsDaily) {
        const m = V.state.months[l];
        try { V.setDailySims(l, await C().loadPeriodDaily('vi', l, iccids), iccids); } catch (e) { if (m) m.dailyFailed = true; }
      }
      r = V.recomputeCycle(label);
    }
    if (!r.ok) { window.showToast('❌ ' + r.reason, 'error'); return; }
    const s = await savePending();
    await syncOps();
    UI.renderUploads();
    window.showToast(`↻ VI ${label} pool recomputed: ${gb(r.rec.pool_gb)} from ${n0(r.rec.eligible_sims)} SIMs${C().state.ready ? (s.saved ? ' · saved' : ' · ⚠ not saved — ' + (C().pool.reason || 'cloud error')) : ''}`, 'success');
  }
  // Admin: whether a SIM state counts in the pool — saved for everyone; frozen cycles keep their own rules
  async function setStatusRule(stateName, on) {
    if (!canEdit()) return;
    if (!confirm(`${on ? 'Count' : 'Stop counting'} "${stateName}" SIMs in the VI pool?\n\nThe open cycle's pool changes for everyone. Closed (frozen) cycles keep the rules they were frozen with — use Recompute on the Uploads tab to apply it there.`)) { UI.renderPanels(); return; }
    const rules = V.updateRules({ status_rules: { [stateName]: !!on } });
    // the rule first; the alert and the pool evaluation are recorded only under a rule everyone else also uses
    let msg = 'this session only', saved = !C().state.ready;
    if (C().state.ready) { const r = await C().saveRules('vi', rules); saved = !!r.saved; msg = r.saved ? 'saved for everyone' : '⚠ not saved: ' + ((r.error && r.error.message) || r.reason); }
    await loadNeededDaily();                       // SIMs that now count may need their daily figures (go-live days)
    await syncOps({ unsaved: !saved });
    window.showToast(`"${stateName}" ${on ? 'now counts' : 'no longer counts'} in the VI pool · ${msg}`, msg.startsWith('⚠') ? 'error' : 'success');
  }
  function statusRuleControl(row) {
    if (row.state === 'Not in SIM Group') return '<span class="pv-muted">never</span>';
    const label = row.rule === true ? 'Yes' : row.rule === false ? 'No' : 'No rule yet';
    if (!canEdit()) return `<span class="${row.rule ? 'vi-yes' : 'pv-muted'}">${label}</span>`;
    return `<label class="vi-rule" title="Admin: count SIMs in this state in the pool"><input type="checkbox" data-state="${esc(row.state)}" ${row.rule ? 'checked' : ''} onchange="ViUI.setStatusRule(this.dataset.state,this.checked)"> ${label}</label>`;
  }
  // Pool header: frozen cycles say so (admin: recompute)
  function poolHeaderExtra(pool) {
    if (!pool.frozen || !pool.cycle) return '';
    return `<span class="vi-frozen" title="Built from the SIM Group of ${esc(shortDate(pool.frozen.snapshot_at))} on ${esc(shortDate(String(pool.frozen.at).slice(0, 10)))} — newer SIM Group files do not change it">🔒 Frozen</span>`
      + (canEdit() ? `<button type="button" class="ps-link" onclick="ViUI.recomputeCycle('${esc(pool.cycle.label)}')">↻ Recompute</button>` : '');
  }
  // Real-time line: the Itemized cycle and day on screen (independent of the Month filter, as for Airtel)
  function rtInfo(ds) {
    const m = ds.rtMonth && V.state.months[ds.rtMonth], c = ds.rtCycle;
    if (!m || !c) return null;
    const at = ds.rtDay;
    const bits = [`VI real-time (Itemized report) · cycle ${shortDate(c.start)} – ${shortDate(c.end)}`];
    if (at) bits.push(`${ds.asOf ? 'as of' : 'data to'} the end of ${shortDate(at)} (day ${V.dayDiff(c.start, at) + 1} of ${c.days})`);
    bits.push(at && at >= c.end ? `cycle complete — usage reset on ${shortDate(c.resets)}` : `usage resets on ${shortDate(c.resets)}`);
    const p = ds.pool || {};
    // The pool may belong to a newer cycle (a Summary ahead of the Itemized report): its figures only describe this
    // cycle when both are the same — otherwise the line counts the rows shown here
    const same = !ds.poolMonth || ds.poolMonth === ds.rtMonth || !!ds.asOf;
    if (same && p.new_activations && p.new_activations.count) bits.push(`${n0(p.new_activations.count)} SIM(s) started this cycle: pro-rated (plan ÷ ${V.PRORATE_DAYS} × days left)`);
    if (same && p.hasPool) {
      // States exactly as VI writes them, and how many SIMs count
      const byState = Object.entries(p.states || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n0(n)} ${k}`).join(', ');
      bits.push(`SIM Group of ${shortDate(p.snapshot_at)}${p.frozen ? ' (frozen)' : ''}: ${byState} · ${n0(p.eligible_sims)} SIMs in the pool`);
    } else if (!same) bits.push(`${n0((ds.rtRows || []).filter(r => r.in_pool).length)} SIMs in the pool on ${shortDate(at)}`);
    else if (p.needsInventory) bits.push('no SIM Group file yet — usage only; upload SIMGROUP*.csv for the pool');
    // The pool may already use a newer Data Usage Summary of the same cycle — this tab stays on the Itemized report
    // (a newer cycle: the banner above the cards says so)
    if (same && p.hasPool && p.usage_src === 'summary' && !ds.asOf) bits.push(`the Data Pool's used data comes from the newer Data Usage Summary (to ${shortDate(p.data_date)}) — upload the newest Itemized report to bring this tab up to date`);
    return bits.join(' · ');
  }
  // The Real-time tab when its Itemized cycle is not the pool's (current) cycle: a historical report, said in its title
  // and in a banner with the current cycle's pool next to it — never shown as "current" (14 Oct 2026)
  const range = c => (c ? `${shortDate(c.start)} – ${shortDate(c.end)}` : '');
  const g2 = v => (v == null || !isFinite(v) ? '—' : (Math.round(v * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' GB');
  const pc2 = v => (v == null || !isFinite(v) ? '—' : (Math.round(v * 100) / 100).toFixed(2) + '%');
  const historical = ds => { const it = ds && ds.context && ds.context.itemized; return !!(it && !it.same_as_pool); };
  function rtTitle(ds) {
    const it = ds && ds.context && ds.context.itemized;
    return historical(ds) ? `Latest Itemized data — ${range(it.cycle)} (${it.complete ? 'historical' : 'older cycle'})` : null;
  }
  function rtBanner(ds) {
    const ctx = ds && ds.context; if (!ctx || !ctx.itemized) return '';
    const it = ctx.itemized, pc = ctx.pool, p = ds.pool || {}, out = [];
    if (historical(ds)) {
      const head = `📜 <b>Latest Itemized data: ${esc(it.label)} cycle, ${esc(range(it.cycle))}</b>${it.complete ? ' — complete' : ` — data to ${esc(shortDate(it.data_through))}`}. This is <b>not the current billing cycle</b>: the cards and the table below describe ${esc(it.label)} only.`;
      // the pool's cycle is the current one unless it has ended (no data of the new cycle yet)
      const isCur = !!(pc && ctx.current && pc.label === ctx.current.label);
      const why = pc ? `${isCur ? 'The current cycle' : 'The newest cycle with usage'} (${esc(pc.label)}: ${esc(range(pc.cycle))}${isCur ? '' : ', closed'}) has no Itemized report yet${pc.source ? ` — its usage comes from the ${esc(pc.source)}` : ''}. Upload the newest Itemized report to see each SIM's ${isCur ? 'current ' : ''}usage here.` : '';
      const cur = p.hasPool && pc ? `<div class="rt-b-cur"><span class="rt-b-k">${isCur ? 'Current cycle' : 'Newest cycle with usage (closed)'} · ${esc(pc.label)} · shared pool</span>
          <span><b>${g2(p.capacity_gb)}</b> pool</span><span><b>${g2(p.used_gb)}</b> used (${pc2(p.util_pct)})</span><span><b>${g2(Math.abs(p.remaining_gb))}</b> ${p.remaining_gb < 0 ? 'over the pool' : 'remaining'}</span>
          <span class="rt-b-src">${esc(pc.source || '')}${pc.data_through ? ' to ' + esc(shortDate(pc.data_through)) : ''}${pc.day ? ` · day ${n0(pc.day)} of ${n0(pc.cycle ? pc.cycle.days : '')}` : ''}</span>
          <button type="button" class="ps-link" onclick="ProvidersUI.openCalc('vi')">🧮 Calculation details</button></div>` : '';
      out.push(`<div class="rt-b-h">${head}</div>${why ? `<div class="rt-b-s">${why}</div>` : ''}${cur}`);
    }
    if (it.late_group_days) out.push(`<div class="rt-b-warn">⚠ The ${esc(it.label)} allocations below come from the SIM Group file of ${esc(shortDate(it.sim_group))} — ${n0(it.late_group_days)} days after the cycle ended — so SIMs that went live after ${esc(shortDate(it.cycle && it.cycle.end))} are counted in it. Upload the SIM Group file nearest ${esc(shortDate(it.cycle && it.cycle.end))}${it.frozen ? ', then ↻ Recompute the cycle on the Uploads tab' : ' — it is used at once'}.</div>`);
    return out.length ? `<div class="rt-banner${historical(ds) ? ' rt-b-hist' : ''}" role="note">${out.join('')}</div>` : '';
  }
  // Calculation details: every figure on screen with its source, billing cycle, SIMs and formula, side by side
  function calcRows(ds) {
    const ctx = ds && ds.context; if (!ctx) return null;
    const p = ds.pool || {}, f = p.forecast || {}, pc = ctx.pool, it = ctx.itemized, rows = [], notes = [];
    const row = (metric, value, source, cycle, sims, calc) => rows.push({ metric, value, source, cycle, sims, calc });
    if (ctx.current) row('Current billing cycle', `${ctx.current.label}`, 'VI bills 22nd → 21st (usage resets on the 22nd)', range(ctx.current), '—', `Today ${shortDate(ctx.today)} = day ${ctx.current.day} of ${ctx.current.days}`);
    if (p.hasPool && pc) {
      const cy = range(pc.cycle), notCounted = n0(p.inventory_sims - p.eligible_sims), closed = !!(p.complete || f.ended);
      const states = Object.entries(p.states || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n0(n)} ${k}`).join(', ');
      const full = (p.plan_mix || []).map(m => `${n0(m.sims)} × ${n0(m.gb)} GB`).join(' + ');
      const pro = p.prorated && p.prorated.sims ? `${n0(p.prorated.sims)} SIMs started during the cycle: plan ÷ ${V.PRORATE_DAYS} × days left = ${g2(p.prorated.gb)}` : 'no SIM started during the cycle';
      // a frozen cycle counts with the rules it was frozen with
      const est = (p.frozen && p.frozen.eligible_states) || (p.rules && p.rules.eligible_states) || [];
      row('Total pool', g2(p.capacity_gb), `SIM Group file of ${shortDate(p.snapshot_at)}${p.frozen ? ' (frozen)' : ''} + pool rules`, cy, `${n0(p.eligible_sims)} counted of ${n0(p.inventory_sims)} (${states})`,
        `Σ each counted SIM's allocation this cycle. Full cycle: ${full || '—'}; ${pro}. Counts: state "${est.join('", "')}"${p.frozen ? ' (the rules it was frozen with)' : ''} on a data-pool deal (${(p.rules && p.rules.pool_tag) || ''}); the other ${notCounted} do not.`);
      row('Used', g2(p.used_gb), `${pc.source || '—'}${pc.data_through ? ' to ' + shortDate(pc.data_through) : ''}`, cy, `${n0(p.eligible_sims)} counted SIMs`,
        `Σ usage of the counted SIMs, cycle to date. Usage by SIMs that do not count (${g2(p.non_pool_usage_gb)}) is not in it — it is flagged separately.`);
      row('Remaining', g2(p.remaining_gb), '—', cy, '—', `Total pool − Used = ${g2(p.capacity_gb)} − ${g2(p.used_gb)}`);
      row('Used %', pc2(p.util_pct), '—', cy, '—', `Used ÷ Total pool`);
      if (f.pace) row('Pace', `${g2(f.pace.burn_gb_day)} a day`, pc.source || '—', cy, `${n0(f.pace.sims_now)} SIMs`, `${g2(f.pace.gb_sim_day)} per SIM per day × ${n0(f.pace.sims_now)} SIMs${f.pace.basis === 'cycle' ? ` — the average since ${shortDate(pc.cycle && pc.cycle.start)} (no earlier upload of this cycle to compare)` : ''}`);
      else if (f.avg_gb_day != null) row('Pace', `${g2(f.avg_gb_day)} a day`, pc.source || '—', cy, '—', `Used ÷ ${n0(p.days_elapsed)} days`);
      if (closed) row('Cycle closed', p.remaining_gb < 0 ? `over the pool by ${g2(-p.remaining_gb)}` : `${g2(p.remaining_gb)} left unused`, '—', cy, '—', 'Total pool − Used at the end of the cycle');
      else {
        if (f.projected_gb != null) row('Projected by the cycle end', `${g2(f.projected_gb)} (${pc2(f.projected_pct)})`, '—', cy, '—', `Used + pace × the SIM-days left after ${shortDate(f.data_day || pc.data_through)} (${n0(f.days_left)} days)`);
        row('Pool lasts', f.exhaustion_date ? `until ~${shortDate(f.exhaustion_date)}` : 'the whole cycle', '—', cy, '—', f.lasts_days === Infinity ? 'no usage yet' : `Remaining ÷ pace = ${(Math.round(f.lasts_days * 10) / 10)} days vs ${n0(f.days_left)} days left`);
      }
      const sc = pc.start_check, win = sc ? `${shortDate(sc.from)} – ${shortDate(sc.limit)}` : '';
      if (sc) row('Start days', sc.verified ? 'verified' : `${n0(sc.sims)} SIMs not verified`, `SIM Group files: ${n0(ctx.sim_groups.count)} (oldest ${shortDate(ctx.sim_groups.oldest)})`, cy, sc.verified ? '—' : `${n0(sc.sims)} SIMs · ${g2(sc.gb)}`,
        sc.verified ? (sc.near_export ? `The SIM Group file of ${shortDate(sc.near_export)} (${win}) is loaded: a SIM Ready in one file and active in a later one starts on its first day with data.` : 'Every counted SIM starts after the cycle start or has a detected go-live day.')
          : `VI's DATE_OF_ACTIVATION is the day a SIM was loaded on the account and does not change when it goes live. No SIM Group file from ${win} is loaded, so these SIMs get their full plan; any that went live after ${shortDate(pc.cycle && pc.cycle.start)} are over-counted.`);
    }
    if (it) {
      // the whole VI Itemized report — the Real-time tab's client, status, plan and search filters are not applied here
      const rt = (ds.rtRows || []), sum = k => rt.reduce((a, r) => a + (r[k] || 0), 0) / 1024, withAlloc = rt.filter(r => r.alloc_mb > 0).length;
      const cy = range(it.cycle), tag = it.same_as_pool ? '' : ' — not the current cycle';
      row('Real-time · Allocated (all VI SIMs)', g2(sum('alloc_mb')), `SIM Group file of ${shortDate(it.sim_group)}${it.frozen ? ' (frozen)' : ''}${it.late_group_days ? ` — ${n0(it.late_group_days)} days after the cycle` : ''}`, cy + tag, `${n0(withAlloc)} with an allocation of ${n0(rt.length)} listed`,
        `Σ each SIM's allocation in the ${it.label} cycle (full plan, or plan ÷ ${V.PRORATE_DAYS} × days from its start). A SIM-level figure — not the shared pool.`);
      row('Real-time · Used (all VI SIMs)', g2(sum('used_mb')), `Itemized report${it.data_through ? ' to ' + shortDate(it.data_through) : ''}`, cy + tag, `${n0(rt.length)} SIMs in the report — Real-time filters not applied`, `Σ each SIM's daily usage ${cy}`);
      row('Real-time · Available (all VI SIMs)', g2(sum('avail_mb')), '—', cy + tag, '—', 'Allocated − Used (counted SIMs only)');
      notes.push('The Real-time rows above are for every VI SIM in the report; the cards on the Real-time tab follow its client, status, plan and search filters.');
      if (!it.same_as_pool) notes.push(`The Real-time tab shows the ${it.label} cycle; the pool shows ${pc ? pc.label : 'another cycle'}. Their figures are different cycles and reports — they are never added together or compared.`);
    }
    if (ctx.monthly) row('Month-wise tabs', ctx.monthly.label, `Data Usage Summary${ctx.monthly.data_through ? ' to ' + shortDate(ctx.monthly.data_through) : ''}`, range(ctx.monthly.cycle), '—', 'Vehicle Wise, Exceeded, Plan Summary, Downgrade, Trends and Price Analysis use the Month filter\'s cycle (Latest = this one).');
    notes.push('The Data Usage Summary and the Itemized report are never added: the pool uses whichever reaches the later day; the Real-time tab uses the Itemized report only.');
    return { title: 'VI — calculation details', rows, notes };
  }

  /* ── "as of" day: the Real-time tab's date picker (Airtel has dated snapshots; VI has every day) ── */
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = d => WD[new Date(d + 'T00:00:00Z').getUTCDay()];
  let loadingDaily = false;
  function rtControls(ds) {
    const opts = V.asOfOptions();                    // cycles with an Itemized report only
    if (!opts.length) return '';
    // Days after the newest report are not in any file yet — say so instead of leaving them out silently
    const next = V.addDays(opts[0].dates[0], 1), now = today();
    const later = now >= next ? `<option disabled>${esc(shortDate(next))}${now > next ? ' – ' + esc(shortDate(now)) : ''}: no Itemized data yet — upload a newer report</option>` : '';
    // A newer Data Usage Summary drives the latest pool view: it gets its own entry; the Itemized days stay pickable
    const lu = V.latestUsage(), sumLatest = !!(lu && lu.src === 'summary');
    const top = sumLatest ? `<option value=""${ds.asOf ? '' : ' selected'}>Latest · pool from the Data Usage Summary to ${esc(shortDate(lu.until))} (${esc(lu.label)})</option>` : '';
    const html = top + later + opts.map(o => {
      const range = `${shortDate(o.cycle.start)} – ${shortDate(o.cycle.end)}`;
      return `<optgroup label="${esc(o.label)} cycle · ${esc(range)}">` + o.dates.map((d, i) => {
        const on = ds.asOf ? d === ds.asOf : (!sumLatest && o.label === ds.rtMonth && i === 0);
        const tag = i === 0 ? (d >= o.cycle.end ? ' · cycle end' : sumLatest ? ' · last Itemized day' : ' · latest') : d === o.cycle.start ? ' · cycle start' : '';
        return `<option value="${d}"${on ? ' selected' : ''}>${dayName(d)} ${esc(shortDate(d))} · day ${V.dayDiff(o.cycle.start, d) + 1} of ${o.cycle.days}${tag}</option>`;
      }).join('') + '</optgroup>';
    }).join('');
    return `<label class="rt-asof" title="${esc(cfg.short)} real-time usage (Itemized report) at the end of any day of the billing cycle — ${esc(cfg.cycle || '')}">`
      + (P.isMulti() ? `<span class="prov-badge" style="--pc:${cfg.color}">${esc(cfg.short)}</span>` : '')
      + `<span class="rt-asof-k">📅 As of</span><select class="fsel" id="vi-asof" onchange="ViUI.setAsOf(this.value)" aria-label="${esc(cfg.short)} data as of the end of"${loadingDaily ? ' disabled' : ''}>${html}</select>`
      + (loadingDaily ? '<span class="pv-muted">Loading daily usage…</span>' : '') + '</label>';
  }
  // value: 'YYYY-MM-DD' (end of that day) or '' (the newest Itemized day). The Month filter is not touched.
  async function setAsOf(value) {
    value = String(value || '');
    const opts = V.asOfOptions(), newest = opts.length ? opts[0].dates[0] : null;
    // The newest Itemized day is the latest view only while no newer Summary drives the pool
    const lu = V.latestUsage();
    const newestIsLatest = !!(lu && lu.src === 'itemized' && opts.length && lu.label === opts[0].label);
    if (!value || (value === newest && newestIsLatest)) { V.state.asOf = null; V.rebuild(); return; }
    const label = V.monthLabelForDate(value), m = label && V.state.months[label];
    if (!m || !m.sources.itemized) return;
    if (value < (V.itemizedLast(m) || '') && !m.daily && !(m.asOfTotals && m.asOfTotals.date === value)) {   // from the cloud, on demand
      if (!C().state.ready) { window.showToast(`No daily data for ${label} — upload its Itemized report`, 'error'); UI.renderPanels(); return; }
      loadingDaily = true; UI.renderPanels();
      // each SIM's total to that day, summed in the database (sql/004_vi_scale.sql); else every SIM's daily rows
      let ok = false;
      try {
        const t = await C().loadTotalsAsOf('vi', label, m.period_start || (V.cycleForLabel(label) || {}).start, value);
        if (t) { V.setAsOfTotals(label, value, t); ok = true; }
        else { m.daily = await C().loadPeriodDaily('vi', label); ok = !!(m.daily && Object.keys(m.daily).length); if (!ok) m.daily = null; }
      } catch (e) { console.warn('[vi] daily usage load failed', e); m.daily = null; }
      loadingDaily = false;
      if (!ok) { window.showToast(`❌ Could not load the daily usage for ${label}`, 'error'); UI.renderPanels(); return; }
    }
    V.state.asOf = value;
    V.rebuild();
  }
  const pickDay = d => setAsOf(d || '');
  const SRC_TXT = { vi_date: 'VI activation date', detected: 'detected go-live' };
  function vsumExtra(v) {
    const start = v.start_date ? `${shortDate(v.start_date)} (${SRC_TXT[v.start_src] || v.start_src || ''})` : '';
    const rows = [['Provider', cfg.name], ['ICCID', v.iccid], ['MSISDN', v.msisdn], ['IMSI', v.imsi], ['Lifecycle state', v.sim_state || v.sim_status],
      ['Deal / plan', v.deal_name || (v.sim_state === 'Not in SIM Group' ? 'Not in the SIM Group file — no plan known, not counted in the pool' : '')],
      ['Data pool', v.pooled ? (v.in_pool ? 'Yes — counted in the shared pool' : 'Data-pool deal, but its state does not count') : 'No'],
      ['VI activation date', v.activated_at], ['Counts from', start],
      ['Allocation this cycle', v.alloc_gb == null ? '' : !v.in_pool ? '0 GB (not in the pool)' : v.prorated_days != null
        ? `${v.alloc_gb} GB — pro-rated: ${v.prorated_days} days × ${(v.plan_gb / V.PRORATE_DAYS).toFixed(2)} GB (${v.plan_gb} GB ÷ ${V.PRORATE_DAYS})`
        : `${v.alloc_gb} GB (full plan)`]];
    return `<div class="vsum-section"><div class="vsum-section-title">📡 ${esc(cfg.short)} SIM details <button type="button" class="ps-link" style="margin-left:8px" onclick="ProvidersUI.openSim('vi','${esc(v.iccid)}')">📈 Daily history</button></div><div class="vsum-detail-grid">${rows.map(([k, val]) => `<div class="vsum-detail-row"><span class="vsum-detail-label">${esc(k)}</span><span class="vsum-detail-val" style="font-family:'Roboto',monospace;font-size:11px">${esc(val || '—')}</span></div>`).join('')}</div><div id="vsum-daily"></div></div>`;
  }
  async function afterVsum(v) {
    const el = $('vsum-daily'); if (!el) return;
    const label = P.selectedMonth() !== 'latest' ? P.selectedMonth() : P.raw('vi').currentMonth;
    const m = label && V.state.months[label];
    if (!m) return;
    let d = m.daily && m.daily[v.iccid];
    if (!d && m.sources.itemized && C().state.ready) { el.innerHTML = '<div class="pv-muted">Loading daily usage…</div>'; d = await C().loadSimDaily('vi', v.iccid, label); }
    if (!d || !Object.keys(d).length) { el.innerHTML = `<div class="pv-muted">${m.sources.itemized ? 'No daily usage for this SIM in ' + esc(label) + '.' : 'Upload the Itemized report (Real-time) for daily usage.'}</div>`; return; }
    const days = [];
    if (m.period_start && m.period_end) { for (let t = Date.parse(m.period_start + 'T00:00:00Z'); t <= Date.parse(m.period_end + 'T00:00:00Z'); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10)); }
    else days.push(...Object.keys(d).sort());
    const cats = days.map((x, i) => ({ key: x, label: shortDate(x), short: (i % 5 === 0 || i === days.length - 1) ? String(+x.slice(8, 10)) : '' }));
    el.innerHTML = `<div class="vsum-section-title" style="margin-top:12px">Daily usage · ${esc(label)} (Itemized report)</div>`
      + columnChart({ series: [{ key: 'u', name: cfg.short, color: cfg.color }], cats, val: c => (d[c] || 0) / 1024, height: 70, width: 560, label: 'peak', aria: 'Daily usage for this SIM' })
      + tableView(['Date', 'Used (GB)'], days.filter(x => d[x] != null).map(x => [shortDate(x), (Math.round(d[x] / 1024 * 1000) / 1000).toLocaleString()]));
  }
  // SIM detail page: identity, every cycle's allocation, its daily usage (Itemized only) and the Summary total
  // Frozen cycles whose SIM list was left out at start-up — loaded when a view needs their per-SIM allocations
  async function loadFrozenLists(labels) {
    if (!C().state.ready) return false;
    const res = await Promise.all(labels.map(l => C().loadFrozenSims('vi', l).then(sims => { if (sims) { V.setFrozenSims(l, sims); return true; } return false; })
      .catch(e => { console.warn('[vi] frozen pool load failed', e); return false; })));
    return res.some(Boolean);
  }
  // The Month filter on a closed cycle: its per-SIM allocations come from the frozen SIM list
  P.onMonthChange(label => {
    if (!label || label === 'latest' || !V.state.frozen[label] || V.state.frozen[label].sims) return;
    loadFrozenLists([label]).then(got => { if (got) V.rebuild(); });
  });
  async function simModel(iccid) {
    await loadFrozenLists(V.lightFrozen().filter(l => V.state.months[l]));   // every cycle on the SIM page
    const ds = P.raw('vi'), months = V.state.months;
    const hist = {};
    Object.values(months).forEach(m => { if (m.daily && m.daily[iccid]) hist[m.label] = Object.assign({}, m.daily[iccid]); });
    // cycles loaded from the cloud keep only daily totals in memory — fetch this SIM's days (one indexed query)
    if (Object.values(months).some(m => m.sources && m.sources.itemized && !m.daily) && C().state.ready) {
      try { const h = await C().loadSimHistory('vi', iccid); Object.entries(h || {}).forEach(([l, d]) => { if (!hist[l]) hist[l] = d; }); } catch (e) { console.warn('[vi] SIM history load failed', e); }
    }
    const inv = (V.state.inventory ? V.state.inventory.sims : []).find(x => x.iccid === iccid) || null;
    const veh = (ds.CD ? ds.CD.vehicles : []).find(v => v.iccid === iccid) || null;
    const rt = (ds.rtRows || []).find(r => r.iccid === iccid) || null;
    const pi = V.planInfo(inv ? inv.deal_name : '', inv ? inv.base_plan_name : '');
    const labels = P.sortMonths(Object.keys(months)).reverse();
    let lastUse = null;
    const cycles = labels.map(l => {
      const m = months[l], c = V.cycleForLabel(l); if (!c) return null;
      const al = V.simCycleAllocation(l, iccid);
      const sumT = m.sources && m.sources.summary ? V.simTotals(m, 'summary').get(iccid) : null;
      const daily = hist[l] || null, covered = m.sources && m.sources.itemized ? V.itemizedLast(m) : null;
      const planGb = (al && al.plan_gb) || pi.plan_gb;
      const from = al && al.eligible && al.start && al.start > c.start ? al.start : c.start;
      const stats = covered ? V.simDailyStats({ daily: daily || {}, from, to: c.end, covered, perDay: planGb ? planGb / V.PRORATE_DAYS : null, provisionalDay: covered }) : null;
      Object.entries(daily || {}).forEach(([d, mb]) => { if (mb > 0 && (!lastUse || d > lastUse)) lastUse = d; });
      if (sumT && sumT.used_mb > 0) { const ls = String(sumT.last_session || '').slice(0, 10); if (ls && (!lastUse || ls > lastUse)) lastUse = ls; }
      if (!stats && !sumT && !(al && al.eligible)) return null;
      // Used = the newest report, as for the pool (a SIM missing from that report used nothing)
      const src = V.usageSrc(m), itT = src === 'itemized' ? V.simTotals(m, 'itemized').get(iccid) : null;
      const used = src === 'summary' ? (sumT ? sumT.used_mb / 1024 : 0) : src === 'itemized' ? (itT ? itT.used_mb / 1024 : 0) : null;
      return { label: l, cycle: c, alloc: al, stats, summary_gb: sumT ? sumT.used_mb / 1024 : null,
        used_gb: used, used_src: src, used_until: src === 'summary' ? V.summaryDay(m) : src === 'itemized' ? covered : null };
    }).filter(Boolean);
    if (!cycles.length) return null;
    const current = ds.poolMonth && cycles.some(c => c.label === ds.poolMonth) ? ds.poolMonth : cycles[0].label;
    return { iccid, msisdn: (inv && inv.msisdn) || (veh && veh.msisdn) || (rt && rt.msisdn) || '', reg: veh && !veh.unmapped ? veh.reg : '', client: veh && !veh.unmapped ? veh.client : '',
      state: inv ? inv.lifecycle_state : 'Not in SIM Group', vi_date: inv && inv.activated_at ? String(inv.activated_at).slice(0, 10) : null,
      plan_gb: pi.plan_gb, plan_days: V.PRORATE_DAYS, price: pi.price, pooled: pi.pooled, cycles, current, last_use: lastUse, today: ds.today };
  }
  const alertHistory = () => V.state.alertHistory;
  // Universal SIM search — VI's part of a result: the SIM in the current cycle's pool and the shared pool's state.
  // The pool is the operational control: its warning is about the pool, never "this SIM is out of data".
  function searchCard(rec) {
    const ds = V.latestDataset(), p = ds && ds.pool && ds.pool.hasPool ? ds.pool : null, k = P.normKey(rec.iccid);
    const row = p ? (p.sim_table || []).find(r => P.normKey(r.iccid) === k) : null;
    const rows = [], notes = [], pc = v => `${(Math.round(v * 10) / 10).toFixed(1)}%`;
    if (row && row.vi_date) rows.push(['Activation date (VI)', shortDate(row.vi_date)]);
    if (row && row.plan_gb) rows.push(['Plan', `${row.plan_gb} GB / ${V.PRORATE_DAYS} days${row.deal && /_DP_/i.test(row.deal) ? ' · shared data pool' : ''}`]);
    if (p && p.cycle) rows.push(['Billing cycle', `${shortDate(p.cycle.start)} → ${shortDate(p.cycle.end)}`]);
    if (row) {
      rows.push(['Used this cycle', `${gb(row.used_gb)}${p.data_date ? ` (${p.usage_src_name || 'usage report'} to ${shortDate(p.data_date)})` : ''}`]);
      if (row.in_pool) {
        rows.push(['Eligible allocation', `${gb(row.alloc_gb)}${row.full ? ' (full cycle)' : row.days != null ? ` (${row.days} days from ${shortDate(row.start)})` : ''}`]);
        rows.push(['Remaining allocation', row.remaining_gb < 0
          ? `${gb(-row.remaining_gb)} above its own allocation (${pc(row.usage_pct)}) — covered by the shared pool, not out of data`
          : `${gb(row.remaining_gb)}${row.usage_pct != null ? ` · ${pc(row.usage_pct)} used` : ''}`]);
      } else rows.push(['In the pool', `No — ${row.reason}`]);
    } else rows.push(['This cycle', p ? `Not in the ${ds.poolMonth || 'current'} cycle's SIM Group or usage` : 'No VI cycle loaded']);
    if (p && p.forecast) {
      const f = p.forecast, L = { healthy: 'Healthy', warning: 'Warning', critical: 'Critical', closed: 'Cycle closed' };
      rows.push(['Shared pool', `${L[p.level] || p.level} · ${gb(f.remaining_gb)} left of ${gb(f.pool_gb)} · ${pc(f.projected_pct)} projected`]);
      const when = f.exhaustion_date ? `projected to run out around ${shortDate(f.exhaustion_date)}, before the cycle ends (${shortDate(f.cycle_end)})` : 'projected above the pool by the cycle end';
      if (p.level === 'critical') notes.push({ level: 'critical', text: `🚨 VI shared pool Critical — ${f.remaining_gb <= 0 ? 'the pool is used up' : when}. This is the shared pool, not this SIM's own data.` });
      else if (p.level === 'warning') notes.push({ level: 'warning', text: `⚠️ VI shared pool warning — ${f.exhaustion_date ? when : `${pc(f.projected_pct)} of the pool projected by the cycle end`}. A pool-level warning, not about this SIM alone.` });
    }
    return { rows, notes, open: () => UI.openSim('vi', rec.iccid), openLabel: 'Open VI SIM details' };
  }
  async function boot(cloud) {
    if (!cloud.state.ready) return;
    // the rules first (which states are pre-live decides the go-live history the database summarises), then the
    // newest 3 cycles — what the pool, the forecast and the alert need; older cycles follow in the background
    const rules = await cloud.loadRules('vi');
    if (rules) V.setRules(rules);
    V.state.canLoadDaily = true;                 // freezes wait for the per-SIM daily figures the cloud can still provide
    const prelive = V.rulesConfig().prelive_states;
    const [d, hist0, ops0] = await Promise.all([cloud.loadProvider('vi', { recent: 3 }), cloud.loadPoolHistory('vi', 150, prelive), cloud.loadOps('vi')]);
    let hist = hist0, ops = ops0;
    // History that failed to load (a network error or a time-out — not a table that does not exist yet) is tried twice
    // more. Still missing: the figures are shown with a warning, and nothing derived from them is saved this session
    // (pool evaluations, the alert, frozen cycles) — without it go-live days, the pace and the confirmation are off.
    const histFailed = () => !hist && cloud.pool.ready !== false, opsFailed = () => !ops && cloud.ops.ready !== false;
    for (let i = 1; i <= 2 && (histFailed() || opsFailed()); i++) {
      await new Promise(r => setTimeout(r, 1500 * i));
      [hist, ops] = await Promise.all([histFailed() ? cloud.loadPoolHistory('vi', 150, prelive) : hist, opsFailed() ? cloud.loadOps('vi') : ops]);
    }
    const issues = [];
    if (histFailed()) issues.push('The SIM Group history did not load from the cloud (network error or time-out): go-live days, pro-rated allocations and closed cycles may be off. Nothing is saved from these figures — reload the page to try again.');
    if (opsFailed()) issues.push('The earlier pool evaluations and alerts did not load from the cloud (network error or time-out): the pace and the 2-day confirmation may be off. Nothing is saved from these figures — reload the page to try again.');
    st.noHistory = issues.length > 0;
    if (st.noHistory) window.showToast('⚠ VI history did not load — figures may be off and are not saved. Reload the page to try again.', 'error');
    // not a failure — a migration not run yet: nothing can be stored, so the confirmation lasts for this session only
    if (cloud.ops.ready === false) issues.push('Pool evaluations and alerts are not stored — run sql/003_vi_operations.sql in Supabase. Until then the alert and its 2-day confirmation last for this browser session only.');
    V.state.loadIssues = issues;
    if (ops) {
      V.state.poolSnaps = ops.snaps.map(s => Object.assign(s, { saved: true }));
      V.state.alertHistory = ops.alerts.map(a => Object.assign(a, { persisted: true }));
      V.state.alert = V.state.alertHistory.find(a => a.status === 'open' && a.code === V.ALERT_CODE) || null;
    }
    if (!d || !(d.inventory || Object.keys(d.months).length)) { if (rules) V.setRules(rules); return; }
    Object.values(d.months).forEach(m => { m.recon = V.reconcile(m); });                       // VI's reconciliation rules
    if (d.inventory) d.inventory.sims.forEach(s => { s.status = V.normStatus(s.lifecycle_state || s.status); });
    V.setFromCloud(Object.assign(d, { snapshots: hist ? hist.snapshots : null, frozen: hist ? hist.frozen : null, runs: hist ? hist.runs : null, rules }));
    // The current SIM Group is history too — keep it there (an inventory saved before 002_vi_pool.sql existed)
    if (hist && d.inventory && !hist.snapshots.some(s => s.as_of === d.inventory.as_of) && canEdit()) cloud.saveSnapshot('vi', d.inventory, null);
    await loadNeededDaily();
    await savePending();
    await syncOps();
    // Older cycles: month-wise history and trends (the pool and the alert do not need them)
    if (d.later && d.later.length) loadOlder(cloud, d.later);
  }
  // In the background, 3 tries. Still missing: a warning says so (their figures show 0 until a reload); an upload into
  // one of them loads it first (process).
  async function loadOlder(cloud, labels) {
    const shells = () => labels.filter(l => V.state.months[l] && V.state.months[l].light);   // not loaded, not deleted
    for (let i = 0; i < 3 && shells().length; i++) {
      if (i) await new Promise(r => setTimeout(r, 5000 * i));
      try {
        const r = await cloud.loadPeriods('vi', shells());
        Object.values(r.months).forEach(m => { m.recon = V.reconcile(m); });
        V.addMonths(r.months);
        await loadNeededDaily();
        await savePending();
      } catch (e) { console.warn('[vi] older cycles did not load:', e.message || e); }
    }
    const left = shells();
    if (!left.length) return;
    V.state.loadIssues = V.state.loadIssues.concat(`Older cycles did not load from the cloud (${left.join(', ')}): their month-wise figures and trend show 0 until the page is reloaded.`);
    V.rebuild();
    window.showToast(`⚠ VI: ${left.length} older cycle(s) did not load — reload the page to try again`, 'error');
  }

  // Register with the shared UI — nothing else needs to know VI exists
  cfg.uploadUi = 'vi-upload-ui';
  cfg.upload = { mount, render, canProcess, process, syncMode };
  cfg.ui = { reconSection, rtInfo, rtControls, pickDay, vsumExtra, afterVsum, statusRuleControl, poolHeaderExtra, simModel, alertHistory, searchCard,
    rtTitle, rtBanner, calcRows };
  cfg.boot = boot;
  window.ViUI = { pick: e => addFiles(e.target.files), drop: e => { e.preventDefault(); const s = $('slot-vi'); if (s) s.classList.remove('drag-over'); addFiles(e.dataTransfer.files); },
    addFiles, remove: t => { delete st.files[t]; render(); check(); }, setMonth: l => { st.month = l; st.monthTouched = true; render(); check(); },
    setMode, setUntil, setAsOf, deleteCycle, recomputeCycle, setStatusRule, syncOps, state: st };
})();
