/* ============================================================
   providers/vi.js — VI (Vodafone Idea) M2M Self-Care exports
   ------------------------------------------------------------
   Three exports, detected from their HEADERS (never the file name):

   vi_usage_summary   SELFCARE_USAGE_SUMMARY_*.csv
                      1 row per ICCID × CIRCLE for the billing cycle.
                      TOTAL_USAGE:Data-kiloBytes/… = KB (1 KB = 1024 B)
   vi_usage_itemized  SELFCARE_USAGE_ITEMIZED_*.csv
                      the same ICCID × CIRCLE rows + one column per day
                      (2026-08-22 … 2026-09-21) in BYTES, then the same
                      TOTAL_USAGE (KB) column as the summary
   vi_sim_inventory   SIMGROUP_*.csv
                      1 row per SIM: lifecycle state, deal / base plan,
                      activation date — every SIM, including unused ones

   Summary and itemized overlap completely (verified on the Sep-2026
   exports: 466/466 rows, Σ daily bytes / 1024 = summary KB). So:
     • monthly totals come from the SUMMARY (primary source)
     • daily usage comes from the ITEMIZED file
     • itemized totals are used only when no summary was uploaded
     • both are compared in a reconciliation — never added together
   Internal unit: MB.

   Pool rules (decided with the account owner on 6 Oct 2026, see
   docs/VI_POOL_PROPOSAL.md) — defaults below, changeable by an admin:
     • the SIM Group file is required for the pool
     • a SIM counts when the rule for its state says so (only "active"
       by default) and its deal is a data-pool deal (_DP_). States are
       shown exactly as VI writes them.
     • pro-rating starts on VI's DATE_OF_ACTIVATION, except for a SIM an
       older SIM Group showed as Ready: VI keeps the day it was loaded,
       so its go-live day is detected — its first day with data after
       that file, else the date of the first file that shows it active
     • the pool's used data comes from whichever report reaches later —
       the Data Usage Summary or the Itemized report (6 Oct 2026); the
       Real-time tab and the daily charts always use the Itemized report
     • SIMs without a vehicle number are still listed in the month-wise
       tabs ("No vehicle · <mobile no.>") when they count or used data
     • a closed cycle is frozen with the first SIM Group exported on or
       after its last day; newer SIM Groups do not change it
   ============================================================ */
(function () {
  'use strict';

  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const DMY = /^(\d{2})[-/](\d{2})[-/](\d{4})$/;
  const NULLS = new Set(['', 'NULL', 'null', 'NA', 'N/A', '-']);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MAX_ERRORS = 500;
  const TYPE_LABELS = {
    vi_usage_summary: 'Data Usage Summary',
    vi_usage_itemized: 'Itemized Data Usage (daily)',
    vi_sim_inventory: 'SIM Inventory (SIM Group)',
  };
  const DEFAULT_TIERS = [85, 100];            // VI deals seen on this account (Sep 2026)
  const DEFAULT_RULES = {
    cycle_start_day: 22,                      // VI bills 22nd → 21st: usage resets on the 22nd (confirmed by the account owner)
    // A pool SIM that starts during a cycle gets plan GB ÷ 30 for each day left in the cycle, start day included,
    // never more than the plan (85 GB ÷ 30 = 2.83 GB a day) — confirmed by the account owner
    plan_days: 30,
    pool_tag: '_DP_',                         // data-pool deals: CMP_VI_IOT_…_DP_100SMS_85GB_375R_GUJ
    // SIM_LIFECYCLE_STATE as VI writes it (any case) → counts in the pool? A state not listed is not counted and is flagged.
    status_rules: { active: true, ready: false, dunning: false, suspend: false },
    prelive_states: ['ready'],                // loaded on the account, not live yet
    // Operations thresholds (decided with the account owner on 6 Oct 2026; an admin can change them)
    ops: {
      warning_projected_pct: 90,              // Warning: projected use ≥ 90% of the pool
      critical_min_days: 3,                   // Critical from the projection only after 3 days of data (a used-up pool is always Critical)
      backup_margin_pct: 10,                  // backup = shortfall + 10%, rounded up to backup_round_gb
      backup_round_gb: 10,
      // Per-SIM pace (decided 6 Oct 2026): GB per SIM per day over the newest 7+ days of the same report type
      recent_days: 7,
      sustain_days: 2,                        // a pace jump counts when the newest 2+ days all run ≥ jump_pct above it
      jump_pct: 25,
      spike_factor: 2,                        // one day at ≥ 2× the median day is a spike: its excess is not carried forward
      critical_lead_days: 3,                  // Critical at once when the pool runs out within 3 days
      realert_days: 2,                        // pop-up again when the run-out day moves 2+ days earlier …
      realert_backup_pct: 50,                 // … or the backup needed grows 50%+ (or the pool is used up)
      zero_new_days: 3,                       // zero usage: "newly activated" under 3 days since the SIM started
      zero_long_days: 30,                     // "long-term no usage" after 30+ days without data — candidates to stop next cycle
      high_pct: 150,                          // high-usage day / SIM: ≥ 150% of its daily allocation (analytical only)
      trend_pct: 15,                          // SIM trend: last 7 days vs the 7 before, ±15%
    },
  };
  const STATUS = { active: 'Active', ready: 'Ready', suspend: 'Suspended', suspended: 'Suspended',
    dunning: 'Dunning', deactivated: 'Deactivated', terminated: 'Terminated', retired: 'Retired' };
  let RULES, CYCLE_START_DAY, PRORATE_DAYS;
  function setRules(cfg) {
    const c = cfg || {}, sr = {};
    Object.entries(Object.assign({}, DEFAULT_RULES.status_rules, c.status_rules || {}))
      .forEach(([k, v]) => { sr[String(k).trim().toLowerCase()] = !!(v && typeof v === 'object' ? v.eligible : v); });
    RULES = { cycle_start_day: +c.cycle_start_day || DEFAULT_RULES.cycle_start_day, plan_days: +c.plan_days || DEFAULT_RULES.plan_days,
      pool_tag: c.pool_tag != null ? String(c.pool_tag) : DEFAULT_RULES.pool_tag, status_rules: sr,
      prelive_states: (c.prelive_states || DEFAULT_RULES.prelive_states).map(s => String(s).trim().toLowerCase()),
      ops: Object.assign({}, DEFAULT_RULES.ops, c.ops || {}) };
    Object.keys(RULES.ops).forEach(k => { RULES.ops[k] = +RULES.ops[k]; if (!Number.isFinite(RULES.ops[k])) RULES.ops[k] = DEFAULT_RULES.ops[k]; });
    CYCLE_START_DAY = RULES.cycle_start_day; PRORATE_DAYS = RULES.plan_days;
    return RULES;
  }
  setRules(null);
  const rulesConfig = () => JSON.parse(JSON.stringify(RULES));
  // true / false = the rule for that state; null = no rule yet
  const ruleFor = raw => { const k = String(raw || '').trim().toLowerCase(); return k in RULES.status_rules ? RULES.status_rules[k] : null; };
  const isPrelive = raw => RULES.prelive_states.includes(String(raw || '').trim().toLowerCase());
  const eligibleStates = () => Object.keys(RULES.status_rules).filter(k => RULES.status_rules[k]);

  /* ── low-level parsing ─────────────────────────────────────── */
  function parseCsvText(text) {
    text = String(text || '').replace(/^﻿/, '');
    const out = []; let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
        continue;
      }
      if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; }
      else if (ch !== '\r') field += ch;
    }
    if (field !== '' || row.length) { row.push(field); out.push(row); }
    return out.filter(r => r.some(c => String(c).trim() !== ''));
  }
  function table(text) {
    const rows = parseCsvText(text);
    const headers = (rows.shift() || []).map(h => String(h).trim());
    const idx = {}; headers.forEach((h, i) => { idx[h.toUpperCase()] = i; });
    return { headers, rows, idx };
  }
  const col = (t, ...names) => { for (const n of names) { const i = t.idx[n.toUpperCase()]; if (i !== undefined) return i; } return -1; };
  const usageCol = t => t.headers.findIndex(h => /^TOTAL_USAGE/i.test(h));
  const isNull = v => NULLS.has(String(v == null ? '' : v).trim());
  function num(v) {
    if (isNull(v)) return null;
    const n = Number(String(v).replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }
  const cell = (r, i) => (i >= 0 && i < r.length ? String(r[i]).trim() : '');
  // VI prefixes ICCIDs with "~" so Excel keeps them as text; some tools add a trailing F
  const cleanIccid = s => String(s || '').replace(/[\s'~]/g, '').replace(/[Ff]+$/, '');
  const validIccid = s => /^\d{18,22}$/.test(s);
  function isoDate(h) {
    h = String(h).trim();
    if (ISO.test(h)) return h;
    const m = h.match(DMY); return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }
  function unitFactorToMb(header) {           // multiply a value by this to get MB
    const h = String(header || '').toLowerCase();
    if (/kilo|\bkb\b/.test(h)) return 1 / 1024;
    if (/mega|\bmb\b/.test(h)) return 1;
    if (/giga|\bgb\b/.test(h)) return 1024;
    if (/byte/.test(h)) return 1 / (1024 * 1024);
    return 1 / 1024;                          // VI default: kilobytes
  }
  function exportedAtFromName(name) {         // VI names end with _YYYYMMDDHHMMSS
    const m = String(name || '').match(/_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\w+$/);
    return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : null;
  }
  /* ── billing cycles: 22nd → 21st, labelled by the month they end in ── */
  const pad2 = n => String(n).padStart(2, '0');
  const nth = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
  // UTC arithmetic on 'YYYY-MM-DD' strings — no time-zone drift. Month is 0-based and may overflow.
  const ymd = (y, m, d) => { const t = new Date(Date.UTC(y, m, d)); return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`; };
  const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  // "Today" in India (Asia/Kolkata) — VI's days are Indian days, whatever the viewer's own clock says
  const localToday = (now = new Date()) => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
    catch (e) { return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`; }
  };
  // The cycle ending on the 21st of month m: 22 Aug – 21 Sep = "Sep 2026"; it resets on 22 Sep
  function cycleEndingIn(y, m) {
    const e = new Date(Date.UTC(y, m, 1));
    const start = ymd(y, m - 1, CYCLE_START_DAY), end = ymd(y, m, CYCLE_START_DAY - 1);
    return { label: MONTHS[e.getUTCMonth()] + ' ' + e.getUTCFullYear(), start, end, days: dayDiff(start, end) + 1, resets: addDays(end, 1) };
  }
  // A date on or after the 22nd belongs to the cycle that ends next month
  function cycleForDate(d) {
    const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? cycleEndingIn(+m[1], +m[2] - 1 + (+m[3] >= CYCLE_START_DAY ? 1 : 0)) : null;
  }
  function cycleForLabel(label) {
    const m = String(label || '').match(/^(\w{3})\s+(\d{4})$/), i = m ? MONTHS.indexOf(m[1]) : -1;
    return i < 0 ? null : cycleEndingIn(+m[2], i);
  }
  const monthLabelForDate = d => { const c = cycleForDate(d); return c ? c.label : null; };
  // The cycle most of the dates fall in (a tie goes to the later cycle)
  function dominantCycle(dates) {
    const n = new Map(); dates.forEach(d => { const l = monthLabelForDate(d); if (l) n.set(l, (n.get(l) || 0) + 1); });
    const best = [...n.entries()].sort((a, b) => b[1] - a[1] || window.Providers.monthKey(b[0]) - window.Providers.monthKey(a[0]))[0];
    return best ? best[0] : null;
  }
  // Normalised status for cross-provider logic and filters ("active" → "Active"); the raw state is kept beside it
  function normStatus(s) {
    const k = String(s || '').trim();
    if (!k) return 'N/A';
    return STATUS[k.toLowerCase()] || k.charAt(0).toUpperCase() + k.slice(1).toLowerCase();
  }

  /* ── plans ─────────────────────────────────────────────────── */
  // CMP_VI_IOT_<company>_DP_100SMS_85GB_375R_GUJ → 85 GB · ₹375 · data pool (_DP_)
  // IOT_<account>_IOT_100GB_499_X_M2MISAFE_X    → 100 GB · ₹499 · its own plan (no _DP_)
  // CMP_Vi_IOT_READY_0_<company>_GUJ            → Ready state, 0 GB, ₹0
  function planInfo(deal, base) {
    const s = String(deal || base || '');
    const gb = s.match(/(\d+(?:\.\d+)?)\s*GB/i);
    const plan_gb = gb ? parseFloat(gb[1]) : 0;
    let price = null, m;
    if ((m = s.match(/_(\d+)R(?:_|$)/i))) price = +m[1];
    else if ((m = s.match(/GB_(\d+)(?:_|$)/i))) price = +m[1];
    else if ((m = String(base || '').match(/GB_(\d+)(?:_|$)/i))) price = +m[1];
    const ready = /READY/i.test(s) && plan_gb === 0;
    if (ready) price = 0;
    const tag = String(RULES.pool_tag || '').toUpperCase();
    const dp = !!tag && ('_' + s + '_').toUpperCase().includes(tag);
    const pooled = dp && plan_gb > 0;               // only data-pool deals share the account pool
    const label = !s ? 'VI · plan unknown' : ready ? 'VI Ready (not active)' : `VI ${plan_gb}GB${pooled ? ' Pool' : ''}`;
    return { plan: s, plan_gb, price, pooled, dp, ready, label };
  }
  const NO_PLAN = { plan: '', plan_gb: 0, price: null, pooled: false, dp: false, ready: false, label: 'VI · not in the SIM Group' };
  // A SIM the vehicle master has no vehicle for: listed as "No vehicle · <mobile no.>" under this client
  const NO_VEHICLE = 'No vehicle', NO_VEHICLE_CLIENT = 'No vehicle mapped';
  // Does this SIM count in the pool? From its state's rule and its deal — never guessed
  function eligibility(x, pi) {
    const raw = String((x && x.lifecycle_state) || '').trim(), r = ruleFor(raw);
    if (!x) return { ok: false, code: 'not_in_group', reason: 'Not in the SIM Group file — not counted' };
    if (!raw) return { ok: false, code: 'no_state', reason: 'No lifecycle state in the SIM Group file' };
    if (r === null) return { ok: false, code: 'unknown_state', reason: `"${raw}" has no pool rule yet — not counted` };
    if (!r) return { ok: false, code: 'state', reason: `"${raw}" is not counted in the pool` };
    if (!(pi.plan_gb > 0)) return { ok: false, code: 'no_plan', reason: 'No data plan in the deal' };
    if (!pi.pooled) return { ok: false, code: 'not_pool_plan', reason: `Not a data-pool deal (no ${RULES.pool_tag})` };
    return { ok: true, code: 'eligible', reason: 'Counted in the pool' };
  }

  /* ── file detection ────────────────────────────────────────── */
  function detect(headers) {
    const H = headers.map(h => String(h).trim().toUpperCase());
    if (!H.includes('ICCID')) return null;
    if (H.includes('SIM_LIFECYCLE_STATE') || H.includes('DEAL_NAME')) return 'vi_sim_inventory';
    if (headers.some(h => isoDate(h))) return 'vi_usage_itemized';
    if (H.some(h => h.startsWith('TOTAL_USAGE'))) return 'vi_usage_summary';
    return null;
  }
  const nameHint = n => /ITEMIZED/i.test(n) ? 'vi_usage_itemized' : /SUMMARY/i.test(n) ? 'vi_usage_summary' : /SIMGROUP/i.test(n) ? 'vi_sim_inventory' : null;

  function newResult(type, fileName, t) {
    return { type, typeLabel: TYPE_LABELS[type] || type, fileName, headers: t.headers, rows: [], errors: [], warnings: [],
      exportedAt: exportedAtFromName(fileName),
      stats: { total: t.rows.length, valid: 0, duplicates: 0, invalid: 0, unique_sims: 0, total_mb: 0 } };
  }
  function addError(res, line, field, value, reason) {
    res.stats.invalid++;
    if (res.errors.length < MAX_ERRORS) res.errors.push({ line, field, value: String(value).slice(0, 60), reason });
  }
  function addDup(res, line, key, conflicting) {
    res.stats.duplicates++;
    if (conflicting && res.warnings.length < MAX_ERRORS) res.warnings.push({ line, field: 'ICCID+CIRCLE', value: key, reason: 'Repeated SIM+circle with different usage — first row kept' });
  }

  /* ── usage summary ─────────────────────────────────────────── */
  function parseSummary(t, fileName) {
    const res = newResult('vi_usage_summary', fileName, t);
    const c = { iccid: col(t, 'ICCID'), msisdn: col(t, 'MSISDN'), imsi: col(t, 'IMSI'), circle: col(t, 'CIRCLE'),
      use: usageCol(t), origin: col(t, 'ORIGIN_CIRCLE'), last: col(t, 'Last_Packet_Switched_Session_End'),
      days: col(t, 'Packet_Switched_Session_Days') };
    if (c.use < 0) { res.fatal = 'Missing TOTAL_USAGE column'; return res; }
    if (c.last < 0) res.warnings.push({ line: '-', field: 'Last_Packet_Switched_Session_End', value: '', reason: 'No last-session column — the billing cycle cannot be suggested; choose it below' });
    const f = unitFactorToMb(t.headers[c.use]);
    res.unit = f === 1 / 1024 ? 'KB' : f === 1 ? 'MB' : f === 1024 ? 'GB' : 'bytes';
    const seen = new Map(); const sims = new Set(); let maxLast = '';
    t.rows.forEach((r, i) => {
      const line = i + 2;
      const iccid = cleanIccid(cell(r, c.iccid));
      if (!validIccid(iccid)) return addError(res, line, 'ICCID', cell(r, c.iccid), 'Invalid or missing ICCID');
      const v = num(cell(r, c.use));
      if (v === null) return addError(res, line, 'TOTAL_USAGE', '', 'Missing usage value');
      if (Number.isNaN(v) || v < 0) return addError(res, line, 'TOTAL_USAGE', cell(r, c.use), 'Usage is not a valid non-negative number');
      const circle = cell(r, c.circle);
      const key = iccid + '|' + circle;
      const mb = v * f;
      if (seen.has(key)) { addDup(res, line, key, Math.abs(seen.get(key) - mb) > 1e-9); return; }
      seen.set(key, mb);
      const last = isNull(cell(r, c.last)) ? '' : cell(r, c.last);
      if (last > maxLast) maxLast = last;
      const days = num(cell(r, c.days));
      res.rows.push({ iccid, msisdn: cell(r, c.msisdn), imsi: cell(r, c.imsi), circle,
        origin: isNull(cell(r, c.origin)) ? '' : cell(r, c.origin), mb, last_session: last,
        session_days: Number.isFinite(days) ? days : null });
      sims.add(iccid); res.stats.valid++; res.stats.total_mb += mb;
    });
    res.stats.unique_sims = sims.size;
    res.stats.max_last_session = maxLast || null;
    res.stats.data_asof = maxLast ? maxLast.slice(0, 10) : null;
    // The Summary has no dates: its cycle is the one most last sessions fall in (22nd → 21st)
    res.suggestedMonth = dominantCycle(res.rows.map(r => r.last_session).filter(Boolean)) || monthLabelForDate(maxLast);
    return res;
  }

  /* ── itemized (daily) ──────────────────────────────────────── */
  function parseItemized(t, fileName) {
    const res = newResult('vi_usage_itemized', fileName, t);
    const c = { iccid: col(t, 'ICCID'), msisdn: col(t, 'MSISDN'), imsi: col(t, 'IMSI'), circle: col(t, 'CIRCLE'),
      use: usageCol(t), origin: col(t, 'ORIGIN_CIRCLE'), last: col(t, 'Last_Packet_Switched_Session_End'),
      days: col(t, 'Packet_Switched_Session_Days') };
    const dcols = []; t.headers.forEach((h, i) => { const d = isoDate(h); if (d) dcols.push({ i, d }); });
    dcols.sort((a, b) => a.d.localeCompare(b.d));
    if (!dcols.length) { res.fatal = 'No daily date columns found'; return res; }
    const totF = c.use >= 0 ? unitFactorToMb(t.headers[c.use]) : null;

    // Day-cell unit: the export doesn't label it. Verify against TOTAL_USAGE on every row:
    // bytes if Σday/1024 ≈ total KB, kilobytes if Σday ≈ total KB.
    let asBytes = 0, asKb = 0;
    t.rows.forEach(r => {
      if (c.use < 0) return;
      const tot = num(cell(r, c.use)); if (!Number.isFinite(tot) || tot <= 0) return;
      let s = 0; dcols.forEach(({ i }) => { const v = num(cell(r, i)); if (Number.isFinite(v)) s += v; });
      const totKb = tot * totF * 1024;
      if (Math.abs(s / 1024 - totKb) <= Math.max(0.01, totKb * 1e-6)) asBytes++;
      else if (Math.abs(s - totKb) <= Math.max(0.01, totKb * 1e-6)) asKb++;
    });
    const dayF = asKb > asBytes ? 1 / 1024 : 1 / (1024 * 1024);
    res.unit = dayF === 1 / 1024 ? 'KB per day' : 'bytes per day';
    res.unitCheck = { rows_checked: asBytes + asKb, bytes: asBytes, kb: asKb };
    if (c.use >= 0 && asBytes + asKb === 0) res.warnings.push({ line: '-', field: 'daily unit', value: '', reason: 'Could not confirm the daily unit against TOTAL_USAGE — assumed bytes' });

    const seen = new Map(); const sims = new Set(); let maxLast = '', lastDataDate = '';
    t.rows.forEach((r, i) => {
      const line = i + 2;
      const iccid = cleanIccid(cell(r, c.iccid));
      if (!validIccid(iccid)) return addError(res, line, 'ICCID', cell(r, c.iccid), 'Invalid or missing ICCID');
      const daily = {}; let sum = 0, bad = null, active = 0;
      for (const { i: ci, d } of dcols) {
        const v = num(cell(r, ci));
        if (v === null) continue;
        if (Number.isNaN(v) || v < 0) { bad = { d, v: cell(r, ci) }; break; }
        const mb = v * dayF; daily[d] = (daily[d] || 0) + mb; sum += mb; active++;
        if (v > 0 && d > lastDataDate) lastDataDate = d;
      }
      if (bad) return addError(res, line, bad.d, bad.v, 'Daily usage is not a valid non-negative number');
      const circle = cell(r, c.circle);
      const key = iccid + '|' + circle;
      if (seen.has(key)) { addDup(res, line, key, Math.abs(seen.get(key) - sum) > 1e-9); return; }
      seen.set(key, sum);
      let totalMb = sum;
      if (c.use >= 0) {
        const tot = num(cell(r, c.use));
        if (Number.isFinite(tot)) {
          totalMb = tot * totF;
          if (Math.abs(totalMb - sum) > Math.max(0.001, totalMb * 1e-6) && res.warnings.length < MAX_ERRORS)
            res.warnings.push({ line, field: 'TOTAL_USAGE', value: iccid, reason: `Row total ${totalMb.toFixed(3)} MB ≠ Σ daily ${sum.toFixed(3)} MB` });
        }
      }
      const last = isNull(cell(r, c.last)) ? '' : cell(r, c.last);
      if (last > maxLast) maxLast = last;
      const days = num(cell(r, c.days));
      res.rows.push({ iccid, msisdn: cell(r, c.msisdn), imsi: cell(r, c.imsi), circle,
        origin: isNull(cell(r, c.origin)) ? '' : cell(r, c.origin), mb: totalMb, daily_sum_mb: sum, daily,
        last_session: last, session_days: Number.isFinite(days) ? days : active });
      sims.add(iccid); res.stats.valid++; res.stats.total_mb += totalMb;
    });
    res.stats.unique_sims = sims.size;
    res.stats.period_start = dcols[0].d;
    res.stats.period_end = dcols[dcols.length - 1].d;
    res.stats.dates = dcols.map(x => x.d);
    res.stats.last_data_date = lastDataDate || null;
    res.stats.max_last_session = maxLast || null;
    // The dates decide the billing cycle. Usage resets on the 22nd, so a file that crosses it
    // spans two cycles: only the days of the main cycle are used, and the upload says so.
    const cyc = new Map(); dcols.forEach(({ d }) => { const l = monthLabelForDate(d); cyc.set(l, (cyc.get(l) || 0) + 1); });
    res.stats.cycles = [...cyc.entries()].map(([label, days]) => ({ label, days }));
    res.suggestedMonth = dominantCycle(res.stats.dates);
    if (cyc.size > 1) res.warnings.unshift({ line: '-', field: 'dates', value: `${res.stats.period_start} → ${res.stats.period_end}`,
      reason: `The dates cover ${cyc.size} billing cycles (${res.stats.cycles.map(c => `${c.label}: ${c.days} days`).join(', ')}). VI resets usage on the ${nth(CYCLE_START_DAY)}, so only the ${cyc.get(res.suggestedMonth)} days of ${res.suggestedMonth} are used — upload one file per billing cycle.` });
    return res;
  }

  /* ── SIM inventory (SIMGROUP) ──────────────────────────────── */
  function parseInventory(t, fileName) {
    const res = newResult('vi_sim_inventory', fileName, t);
    const c = { iccid: col(t, 'ICCID'), msisdn: col(t, 'MSISDN'), imsi: col(t, 'IMSI'), circle: col(t, 'CIRCLE'),
      state: col(t, 'SIM_LIFECYCLE_STATE'), deal: col(t, 'DEAL_NAME'), base: col(t, 'BASE_PLAN_NAME'),
      group: col(t, 'GROUP_NAME'), act: col(t, 'DATE_OF_ACTIVATION'), product: col(t, 'PRODUCT_TYPE') };
    // The pool is built from these columns — without them the file cannot be used
    if (c.state < 0) { res.fatal = 'Missing SIM_LIFECYCLE_STATE column — the pool needs each SIM\'s status'; return res; }
    if (c.act < 0) { res.fatal = 'Missing DATE_OF_ACTIVATION column — needed to pro-rate SIMs that start during a cycle'; return res; }
    if (c.deal < 0 && c.base < 0) { res.fatal = 'Missing DEAL_NAME and BASE_PLAN_NAME columns — each SIM\'s plan is read from them'; return res; }
    const seen = new Set(); const states = {};
    t.rows.forEach((r, i) => {
      const line = i + 2;
      const iccid = cleanIccid(cell(r, c.iccid));
      if (!validIccid(iccid)) return addError(res, line, 'ICCID', cell(r, c.iccid), 'Invalid or missing ICCID');
      if (seen.has(iccid)) { addDup(res, line, iccid, false); return; }
      seen.add(iccid);
      const state = cell(r, c.state);
      if (!state) res.warnings.push({ line, field: 'SIM_LIFECYCLE_STATE', value: iccid, reason: 'Missing lifecycle state — this SIM is not counted in the pool' });
      const deal = isNull(cell(r, c.deal)) ? '' : cell(r, c.deal);
      const base = isNull(cell(r, c.base)) ? '' : cell(r, c.base);
      const act = isNull(cell(r, c.act)) ? '' : cell(r, c.act).replace(/\.0+$/, '');
      if (!act && res.warnings.length < MAX_ERRORS) res.warnings.push({ line, field: 'DATE_OF_ACTIVATION', value: iccid, reason: 'Missing activation date — if counted, it gets the full plan' });
      const pi = planInfo(deal, base);
      const key = state || '(blank)';
      states[key] = (states[key] || 0) + 1;     // as VI writes it
      res.rows.push({ iccid, msisdn: cell(r, c.msisdn), imsi: cell(r, c.imsi), circle: cell(r, c.circle),
        lifecycle_state: state, status: normStatus(state), deal_name: deal, base_plan_name: base,
        group_name: isNull(cell(r, c.group)) ? '' : cell(r, c.group),
        activated_at: act, product_type: cell(r, c.product), plan_gb: pi.plan_gb, plan_price: pi.price, pooled: pi.pooled, ready: pi.ready });
      res.stats.valid++;
    });
    res.stats.unique_sims = seen.size;
    res.stats.states = states;
    return res;
  }

  /* ── one entry point ───────────────────────────────────────── */
  function parseFile(text, fileName) {
    const t = table(text);
    const type = detect(t.headers);
    if (!type) return { type: null, fileName, headers: t.headers, fatal: 'Not a recognised VI export — expected ICCID plus TOTAL_USAGE, daily date columns, or SIM_LIFECYCLE_STATE', stats: { total: t.rows.length } };
    const res = type === 'vi_usage_summary' ? parseSummary(t, fileName)
      : type === 'vi_usage_itemized' ? parseItemized(t, fileName) : parseInventory(t, fileName);
    const hint = nameHint(fileName);
    if (hint && hint !== type) res.warnings.unshift({ line: '-', field: 'file name', value: fileName, reason: `Name looks like ${TYPE_LABELS[hint]}, but the columns are a ${TYPE_LABELS[type]} — treated as ${TYPE_LABELS[type]}` });
    return res;
  }

  /* ── months ────────────────────────────────────────────────── */
  const rowKey = r => r.iccid + '|' + (r.circle || '');
  // Merge a new upload into a month. Replace semantics per source: a new summary replaces the
  // old summary figures, a new itemized file replaces the old daily figures. Nothing is added twice.
  // opts.until: the Itemized report's "data up to" day (the upload's date, like Airtel's snapshot date) —
  // later days are left out, e.g. a part-day export
  function mergeMonth(prev, parts, label, metas, opts) {
    const until = (opts && opts.until) || null;
    // The billing cycle comes from the label (22nd → 21st), not from whatever dates a file happens to cover
    const cyc = cycleForLabel(label);
    const m = { label, period_start: cyc ? cyc.start : (prev ? prev.period_start : null), period_end: cyc ? cyc.end : (prev ? prev.period_end : null),
      rows: [], daily: prev && prev.daily ? Object.assign({}, prev.daily) : null,
      dailyTotals: prev && prev.dailyTotals ? Object.assign({}, prev.dailyTotals) : null,
      summary_asof: prev ? prev.summary_asof || null : null,
      // a month loaded from the cloud only knows last_data_date — it came from the itemized days when there were any
      itemized_last: prev ? prev.itemized_last || (prev.sources && prev.sources.itemized ? prev.last_data_date : null) || null : null,
      itemized_until: prev ? prev.itemized_until || null : null,
      sources: Object.assign({ summary: null, itemized: null }, prev ? prev.sources : {}) };
    const inCycle = d => !cyc || (d >= cyc.start && d <= cyc.end);
    const clamp = d => (!d || !cyc ? d || null : d < cyc.start ? cyc.start : d > cyc.end ? cyc.end : d);
    const map = new Map();
    (prev ? prev.rows : []).forEach(r => map.set(rowKey(r), Object.assign({}, r)));
    if (parts.summary) {
      map.forEach(r => { r.summary_mb = null; r.summary_days = null; r.summary_last = null; });
      parts.summary.rows.forEach(s => {
        const r = map.get(rowKey(s)) || { iccid: s.iccid, circle: s.circle, itemized_mb: null };
        Object.assign(r, { msisdn: s.msisdn || r.msisdn, imsi: s.imsi || r.imsi, origin: s.origin, summary_mb: s.mb,
          last_session: s.last_session || r.last_session, session_days: r.itemized_mb != null && r.session_days != null ? r.session_days : s.session_days,
          // the Summary's own figures, kept apart from the merged ones (go-live bound: last session − session days + 1)
          summary_days: s.session_days, summary_last: s.last_session || null });
        map.set(rowKey(s), r);
      });
      // No dates in the Summary: its last session is how far into the cycle it reaches
      // (no last-session column: the export date from the file name)
      m.summary_asof = clamp(parts.summary.stats.data_asof || (parts.summary.exportedAt ? String(parts.summary.exportedAt).slice(0, 10) : null));
      m.sources.summary = Object.assign({ rows: parts.summary.stats.valid, total_mb: parts.summary.stats.total_mb, asof: m.summary_asof,
        exported_at: parts.summary.exportedAt || null }, metas && metas.summary);
    }
    if (parts.itemized) {
      map.forEach(r => { r.itemized_mb = null; });
      m.daily = {}; m.dailyTotals = {};
      const dropped = new Set(); let droppedMb = 0, lastUse = '', total = 0;
      const keep = d => inCycle(d) && (!until || d <= until);
      parts.itemized.rows.forEach(s => {
        // Only this cycle's days count — usage resets on the 22nd — and none after the "data up to" day
        const days = {}; let inMb = 0, active = 0, cut = false;
        Object.entries(s.daily).forEach(([day, mb]) => {
          if (!keep(day)) { cut = true; dropped.add(day); droppedMb += mb; return; }
          days[day] = mb; inMb += mb; active++;
          if (mb > 0 && day > lastUse) lastUse = day;
        });
        if (cut && !active) return;                    // this row has no usage inside the cycle
        const r = map.get(rowKey(s)) || { iccid: s.iccid, circle: s.circle, summary_mb: null };
        // A cut row's TOTAL_USAGE covers other cycles' days too, so its in-cycle days are the total
        Object.assign(r, { msisdn: s.msisdn || r.msisdn, imsi: s.imsi || r.imsi, origin: r.origin || s.origin,
          itemized_mb: cut ? inMb : s.mb, session_days: cut ? active : s.session_days, last_session: r.last_session || s.last_session });
        map.set(rowKey(s), r);
        total += r.itemized_mb;
        const d = m.daily[s.iccid] || (m.daily[s.iccid] = {});
        Object.entries(days).forEach(([day, mb]) => { d[day] = (d[day] || 0) + mb; m.dailyTotals[day] = (m.dailyTotals[day] || 0) + mb; });
      });
      const inDates = (parts.itemized.stats.dates || []).filter(keep);
      m.data_start = inDates[0] || null;
      m.itemized_last = lastUse || inDates[inDates.length - 1] || null;
      m.itemized_until = until;
      m.sources.itemized = Object.assign({ rows: parts.itemized.stats.valid, total_mb: total, dropped_days: dropped.size, dropped_mb: droppedMb, until }, metas && metas.itemized);
    }
    map.forEach(r => { if (r.summary_mb != null || r.itemized_mb != null) m.rows.push(r); });
    // The last day the data covers: the later of the itemized days and the Summary's last session
    m.last_data_date = [m.itemized_last, m.summary_asof].filter(Boolean).sort().pop() || (prev ? prev.last_data_date : null) || null;
    m.recon = reconcile(m);
    return m;
  }
  // The last day an Itemized report covers: its latest in-cycle day with usage
  function itemizedLast(m) {
    if (!m || !m.sources || !m.sources.itemized) return null;
    if (m.itemized_last) return m.itemized_last;
    const days = Object.keys(m.dailyTotals || {}).filter(d => m.dailyTotals[d] > 0 && (!m.period_start || (d >= m.period_start && d <= m.period_end))).sort();
    return days.length ? days[days.length - 1] : m.last_data_date || null;
  }
  // Cumulative usage per SIM from the cycle start (22nd) to the end of `date` — from the daily data
  function simTotalsAsOf(m, date) {
    const out = new Map();
    // totals up to the day computed in the database (sql/004_vi_scale.sql) — no per-SIM daily rows in the browser
    if (!m.daily && m.asOfTotals && m.asOfTotals.date === date) {
      simTotals(m, 'itemized').forEach((x, iccid) => {
        const t = m.asOfTotals.sims[iccid] || { used_mb: 0, days: 0 };
        out.set(iccid, Object.assign({}, x, { used_mb: t.used_mb, session_days: t.days }));
      });
      return out;
    }
    simTotals(m, 'itemized').forEach((x, iccid) => {
      let used = 0, days = 0;
      Object.entries((m.daily && m.daily[iccid]) || {}).forEach(([day, mb]) => {
        if (day <= date && (!m.period_start || day >= m.period_start)) { used += mb; days++; }
      });
      out.set(iccid, Object.assign({}, x, { used_mb: used, session_days: days }));
    });
    return out;
  }
  // One source per use, as for Airtel: month-wise figures = Data Usage Summary, real-time = Itemized report.
  // Rows without that source are left out — the two are compared (reconciliation), never mixed or added.
  const SRC = { summary: 'summary_mb', itemized: 'itemized_mb' };
  function simTotals(m, src = 'summary') {
    const t = new Map(), k = SRC[src] || SRC.summary;
    (m ? m.rows : []).forEach(r => {
      if (r[k] == null) return;
      const x = t.get(r.iccid) || { iccid: r.iccid, msisdn: r.msisdn, imsi: r.imsi, used_mb: 0, circles: 0, session_days: 0, last_session: '' };
      x.used_mb += r[k]; x.circles++;
      x.session_days = Math.max(x.session_days, r.session_days || 0);
      if ((r.last_session || '') > x.last_session) x.last_session = r.last_session;
      if (!x.msisdn && r.msisdn) x.msisdn = r.msisdn;
      if (!x.imsi && r.imsi) x.imsi = r.imsi;
      t.set(r.iccid, x);
    });
    // Itemized gives exact session days across circles (a day counts once even if the SIM roamed)
    if (m && m.daily) Object.entries(m.daily).forEach(([iccid, d]) => { const x = t.get(iccid); if (x) x.session_days = Object.keys(d).length || x.session_days; });
    return t;
  }
  function reconcile(m) {
    const s = m.sources || {};
    const out = { status: s.summary && s.itemized ? 'matched' : s.summary ? 'summary_only' : s.itemized ? 'itemized_only' : 'empty',
      summary_mb: 0, itemized_mb: 0, diff_mb: 0, rows_compared: 0, mismatches: [], only_summary: 0, only_itemized: 0 };
    m.rows.forEach(r => {
      if (r.summary_mb != null) out.summary_mb += r.summary_mb;
      if (r.itemized_mb != null) out.itemized_mb += r.itemized_mb;
      if (!(s.summary && s.itemized)) return;
      if (r.summary_mb != null && r.itemized_mb != null) {
        out.rows_compared++;
        const d = r.summary_mb - r.itemized_mb;
        if (Math.abs(d) > 0.001 && out.mismatches.length < MAX_ERRORS) out.mismatches.push({ iccid: r.iccid, circle: r.circle, summary_mb: r.summary_mb, itemized_mb: r.itemized_mb, diff_mb: d });
      } else if (r.summary_mb != null) out.only_summary++;
      else out.only_itemized++;
    });
    out.diff_mb = out.summary_mb - out.itemized_mb;
    if (out.status === 'matched' && (out.mismatches.length || out.only_summary || out.only_itemized || Math.abs(out.diff_mb) > 0.01)) out.status = 'difference';
    // Different cut-offs, not an error: the Summary counts up to its export time, the Itemized report to its last day
    const exp = s.summary && s.summary.exported_at, last = itemizedLast(m);
    if (out.status === 'difference' && exp && last && String(exp).slice(0, 10) > last)
      out.note = `The Summary was exported on ${fmtDate(exp)} at ${String(exp).slice(11, 16)} and includes usage after the Itemized report's last day (${fmtDate(last)}) — a difference is expected.`;
    return out;
  }

  /* ── allocations: SIM Group × rules × cycle ────────────────── */
  function tiersFrom(inv) {
    const s = new Set(DEFAULT_TIERS);
    (inv ? inv.sims : []).forEach(x => { if (x.plan_gb > 0) s.add(x.plan_gb); });
    return [...s].sort((a, b) => a - b);
  }
  // A SIM's allocation in one cycle: the full plan when it started on or before the cycle start (or has no
  // date); plan ÷ 30 × days from its start to the cycle end when it started during the cycle (start day
  // included, never more than the plan); nothing when it starts after the cycle.
  function allotment(s, cyc) {
    const plan = s.pi.plan_gb;
    if (!cyc || !s.activated || s.activated <= cyc.start) return { gb: plan, days: null, per_day: null };
    if (s.activated > cyc.end) return { gb: 0, days: 0, per_day: plan / PRORATE_DAYS };
    const days = dayDiff(s.activated, cyc.end) + 1;
    return { gb: Math.min(plan, plan / PRORATE_DAYS * days), days, per_day: plan / PRORATE_DAYS };
  }
  const clampToCycle = (m, d) => (!d || !m || !m.period_start ? d || null : d < m.period_start ? m.period_start : d > m.period_end ? m.period_end : d);

  /* SIM Group history: each export = { as_of: 'YYYY-MM-DD hh:mm:ss', source_file, sims: [...] } (or light: no sims) */
  const dayOf = s => String((s && s.as_of) || s || '').slice(0, 10);
  // Every known SIM Group export, oldest first, the current inventory included once. An export loaded from the
  // cloud may be "light" (time and SIM count only — its rows load when a cycle needs them; go-live detection uses
  // the state runs computed in the database instead, sql/004_vi_scale.sql)
  function snapshotsWith(snapshots, inventory) {
    const list = (snapshots || []).filter(s => s && s.as_of && (s.sims || s.light));
    if (inventory && inventory.sims && inventory.as_of) {
      const i = list.findIndex(s => s.as_of === inventory.as_of);
      if (i < 0) list.push(inventory); else if (!list[i].sims) list[i] = inventory;
    }
    return list.slice().sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)));
  }
  // Each SIM's state over time: [{ at, state }] sorted — from the full exports in memory plus the state runs
  // from the cloud (a run = the first and the last export showing that state). Only SIMs ever pre-live matter.
  function stateHistory(snaps, runs) {
    const h = new Map(), add = (k, at, st) => { let l = h.get(k); if (!l) h.set(k, l = []); l.push({ at, st }); };
    if (runs) runs.forEach((list, k) => list.forEach(r => { add(k, r.first, r.state); if (r.last !== r.first) add(k, r.last, r.state); }));
    const pre = new Set(runs ? runs.keys() : []);
    snaps.forEach(s => { if (s.sims) s.sims.forEach(x => { if (isPrelive(x.lifecycle_state || '')) pre.add(x.iccid); }); });
    snaps.forEach(s => { if (s.sims) s.sims.forEach(x => { if (pre.has(x.iccid)) add(x.iccid, s.as_of, x.lifecycle_state || ''); }); });
    h.forEach(l => l.sort((a, b) => String(a.at).localeCompare(String(b.at))));
    return h;
  }
  // The SIM Group a cycle is built from: the latest one for the open cycle; for a closed cycle the first one
  // exported on or after its last day — "provisional" when there is none yet
  function cycleSnapshot(cyc, snaps, today) {
    const latest = snaps[snaps.length - 1] || null;
    if (!cyc || !latest || cyc.end >= today) return { snap: latest, provisional: false };
    const after = snaps.find(s => dayOf(s) >= cyc.end);
    return after ? { snap: after, provisional: false } : { snap: latest, provisional: true };
  }
  // Summary rows per SIM: its latest session day and session days (several circles: the largest) — cached per month
  const sumIdx = new WeakMap();
  function summaryIndex(m) {
    let idx = sumIdx.get(m);
    if (!idx) {
      idx = new Map();
      (m.rows || []).forEach(r => {
        if (!(r.summary_mb > 0)) return;
        // The Summary's own last session and session days; a row merged with an Itemized row before these were kept
        // separately has the Itemized day count — not usable for the bound
        const own = r.summary_days != null || r.summary_last != null;
        if (!own && r.itemized_mb != null) return;
        const last = String((own ? r.summary_last : r.last_session) || '').slice(0, 10), days = +(own ? r.summary_days : r.session_days) || 0;
        if (!last) return;
        const x = idx.get(r.iccid) || { last: '', days: 0 };
        if (last > x.last) x.last = last;
        x.days = Math.max(x.days, days);
        idx.set(r.iccid, x);
      });
      sumIdx.set(m, idx);
    }
    return idx;
  }
  // First day with data in [from, to]. Two upper bounds on it: the earliest day the per-SIM daily usage (Itemized) shows,
  // and from the Summary — a SIM with n session days up to its last session started no later than last − n + 1 (a Ready
  // SIM cannot use data, so never before `from`). The earlier one wins: daily figures may not cover the earlier days
  // (a Summary-only cycle, a part-range Itemized export). Months whose daily data is not loaded are noted.
  // missing: Map label → Set of SIMs whose daily figures that cycle are not loaded (vi-ui loads just those SIMs)
  const simDaily = (m, iccid) => (m.daily ? m.daily[iccid] || {} : m.dailySims && m.dailySims[iccid] !== undefined ? m.dailySims[iccid] || {} : null);
  function firstUseFn(months, missing) {
    return (iccid, from, to) => {
      let best = null, est = null;
      Object.values(months || {}).forEach(m => {
        if (!m || !m.period_start || m.period_end < from || m.period_start > to) return;
        const d1 = simDaily(m, iccid);
        if (d1) Object.entries(d1).forEach(([d, mb]) => { if (mb > 0 && d >= from && d <= to && (!best || d < best)) best = d; });
        else if (m.sources && m.sources.itemized && missing && !m.dailyFailed) { if (!missing.has(m.label)) missing.set(m.label, new Set()); missing.get(m.label).add(iccid); }
        const x = m.sources && m.sources.summary ? summaryIndex(m).get(iccid) : null;
        if (x && x.days > 0 && x.last >= from) {
          const e = addDays(x.last, -(x.days - 1)), c = e < from ? from : e > to ? to : e;
          if (!est || c < est) est = c;
        }
      });
      if (best && (!est || best <= est)) return { date: best, how: 'first_use' };
      return est ? { date: est, how: 'summary' } : null;
    };
  }
  // When does a SIM start counting? VI's DATE_OF_ACTIVATION is the day it was loaded on the account (Ready SIMs
  // have one too), so a SIM seen Ready in an older SIM Group and active in a later one started in between:
  // its first day with data after the Ready file (Itemized; else bounded by the Summary), else the date of the file
  // that first shows it active.
  // points = the SIM's state history (stateHistory), up to and including the export `until`
  function goLive(x, points, until, firstUse, cyc) {
    const vi = x.activated_at ? String(x.activated_at).slice(0, 10) : null;
    let readyAt = null, activeAt = null;
    (points || []).forEach(p => {
      if (until && String(p.at) > String(until)) return;
      if (isPrelive(p.st)) { readyAt = p.at; activeAt = null; }
      else if (readyAt && !activeAt && ruleFor(p.st)) activeAt = p.at;
    });
    if (!readyAt || !activeAt) return { date: vi, src: 'vi_date' };
    const rd = dayOf(readyAt), ad = dayOf(activeAt);
    if (vi && vi > rd) return { date: vi, src: 'vi_date' };          // VI's own date is already after the Ready file
    // live by the cycle start anyway (full plan): no need for its daily figures from an older cycle
    if (cyc && ad < cyc.start) return { date: ad, src: 'detected', how: 'sim_group', ready_at: rd, active_at: ad };
    const fu = firstUse ? firstUse(x.iccid, rd, ad) : null;
    return { date: fu ? fu.date : ad, src: 'detected', how: fu ? fu.how : 'sim_group', ready_at: rd, active_at: ad };
  }
  const reasonOf = (code, state, start) => ({ eligible: 'Counted in the pool', later: `Starts ${fmtDate(start)} — after this cycle`,
    not_in_group: 'Not in the SIM Group file — not counted', no_state: 'No lifecycle state in the SIM Group file',
    unknown_state: `"${state}" has no pool rule yet — not counted`, state: `"${state}" is not counted in the pool`,
    no_plan: 'No data plan in the deal', not_pool_plan: `Not a data-pool deal (no ${RULES.pool_tag})` }[code] || '');
  // Every SIM of one SIM Group export → its allocation in one cycle
  function allocations(cyc, snap, snaps, firstUse, hist) {
    const out = new Map();
    if (!snap || !snap.sims) return out;
    const h = hist || stateHistory(snaps, state.runs);
    snap.sims.forEach(x => {
      const pi = planInfo(x.deal_name, x.base_plan_name), el = eligibility(x, pi);
      const gl = el.ok ? goLive(x, h.get(x.iccid), snap.as_of, firstUse, cyc) : { date: x.activated_at ? String(x.activated_at).slice(0, 10) : null, src: 'vi_date' };
      const a = el.ok ? allotment({ pi, activated: gl.date }, cyc) : { gb: 0, days: null, per_day: null };
      const later = el.ok && !!(cyc && gl.date && gl.date > cyc.end);
      const code = later ? 'later' : el.code;
      out.set(x.iccid, { iccid: x.iccid, msisdn: x.msisdn || '', state: x.lifecycle_state || '', eligible: el.ok && !later, code,
        reason: reasonOf(code, x.lifecycle_state || '', gl.date), deal: pi.plan, plan_gb: pi.plan_gb, price: pi.price, pooled: pi.pooled,
        vi_date: x.activated_at ? String(x.activated_at).slice(0, 10) : null, start: gl.date || null, src: gl.src, how: gl.how || null,
        ready_at: gl.ready_at || null, active_at: gl.active_at || null, gb: later ? 0 : a.gb, days: a.days, per_day: a.per_day });
    });
    return out;
  }
  // A frozen cycle keeps each SIM's allocation as it was computed; stored compactly (nulls left out)
  const FROZEN_KEYS = ['msisdn', 'state', 'eligible', 'code', 'deal', 'plan_gb', 'price', 'vi_date', 'start', 'src', 'how', 'ready_at', 'active_at', 'gb', 'days', 'per_day'];
  function allocFromFrozen(rec) {
    const out = new Map();
    Object.entries(rec.sims || {}).forEach(([iccid, s]) => {
      const a = { iccid }; FROZEN_KEYS.forEach(k => { a[k] = s[k] == null ? null : s[k]; });
      a.eligible = !!a.eligible; a.pooled = !!a.eligible || planInfo(a.deal).pooled; a.state = a.state || '';
      a.reason = reasonOf(a.code, a.state, a.start);
      out.set(iccid, a);
    });
    return out;
  }
  // A cycle's usage per SIM for the pool (decided with the account owner, 6 Oct 2026): whichever report reaches later —
  // the Data Usage Summary (VI's cycle-to-date total, up to its last session day) or the Itemized report (up to its
  // last day). Same day → the Itemized report (it also has the days). `other` = the other report's day, if any.
  const summaryDay = m => (m && m.sources && m.sources.summary ? m.summary_asof || m.last_data_date || null : null);
  function usageSrc(m) {
    if (!m || !m.sources) return null;
    const it = m.sources.itemized ? itemizedLast(m) : null, su = summaryDay(m);
    if (m.sources.summary && (!m.sources.itemized || (!!su && (!it || su > it)))) return 'summary';
    return m.sources.itemized ? 'itemized' : null;
  }
  function cycleUsage(m) {
    const src = usageSrc(m), it = m && m.sources && m.sources.itemized ? itemizedLast(m) : null, su = summaryDay(m);
    if (src === 'summary') return { src, t: simTotals(m, 'summary'), until: su, other: it };
    if (src === 'itemized') return { src, t: simTotals(m, 'itemized'), until: it, other: su };
    return { src: null, t: new Map(), until: null, other: null };
  }
  // The newest cycle with usage and where its used data comes from — what the latest view shows
  function latestUsage(months) {
    months = months || state.months;
    const labels = window.Providers.sortMonths(Object.keys(months)).filter(l => usageSrc(months[l]));
    const label = labels[labels.length - 1] || null, m = label ? months[label] : null, src = usageSrc(m);
    return label ? { label, src, until: src === 'summary' ? summaryDay(m) : itemizedLast(m) } : null;
  }
  // missing: Map label → Set of SIMs whose daily figures the go-live days need but are not loaded (see firstUseFn)
  function freezeRecord(label, snap, snaps, months, missing) {
    const cyc = cycleForLabel(label), map = allocations(cyc, snap, snaps, firstUseFn(months, missing));
    const sims = {}, status = {};
    let eligible = 0, full = 0, pro = 0, newN = 0, newGb = 0;
    map.forEach(a => {
      const s = {}; FROZEN_KEYS.forEach(k => { if (a[k] != null && a[k] !== '' && a[k] !== false) s[k] = a[k]; }); sims[a.iccid] = s;
      const st = status[a.state || '(blank)'] || (status[a.state || '(blank)'] = { sims: 0, pool_sims: 0, pool_gb: 0 });
      st.sims++;
      if (!a.eligible) return;
      eligible++; st.pool_sims++; st.pool_gb += a.gb;
      if (a.days == null) full += a.gb; else pro += a.gb;
      if (a.start && cyc && a.start >= cyc.start) { newN++; newGb += a.gb; }
    });
    const u = cycleUsage(months[label]);
    let used = 0; u.t.forEach((x, k) => { const a = map.get(k); if (a && a.eligible) used += x.used_mb / 1024; });
    const pool = full + pro;
    return { provider: 'vi', reporting_period: label, cycle_start: cyc.start, cycle_end: cyc.end, snapshot_at: snap.as_of,
      total_sims: map.size, eligible_sims: eligible, non_eligible_sims: map.size - eligible, full_gb: full, prorated_gb: pro, pool_gb: pool,
      used_gb: used, remaining_gb: pool - used, utilisation_pct: pool > 0 ? used / pool * 100 : 0, data_until: u.until || null,
      new_activations: newN, new_activation_gb: newGb, status_counts: status, rules: rulesConfig(), sims, frozen: true,
      computed_at: new Date().toISOString() };
  }

  // Each cycle's allocations: its frozen record, or its SIM Group under the current rules (cached per call site)
  // want = { snaps: Set of export times whose rows are needed, frozen: Set of cycles whose frozen SIM list is needed }
  // — loaded from the cloud on demand (until then: the latest full SIM Group, marked provisional)
  function allocResolver({ months, frozen, snaps, today, missing, want }) {
    const firstUse = firstUseFn(months, missing), cache = new Map();
    let hist = null;
    const histNow = () => hist || (hist = stateHistory(snaps, state.runs));
    const latestFull = () => { for (let i = snaps.length - 1; i >= 0; i--) if (snaps[i].sims) return snaps[i]; return null; };
    // totalsOnly: the caller needs only the cycle's totals (the billing-cycle trend) — a frozen SIM list is not fetched for it
    return (label, totalsOnly) => {
      if (!label) return null;
      if (cache.has(label)) { const r = cache.get(label); if (r && r.light && !totalsOnly && want) want.frozen.add(label); return r; }
      const c = cycleForLabel(label), fr = frozen && frozen[label];
      let res = null;
      if (fr && fr.sims) res = { map: allocFromFrozen(fr), frozen: fr, snapshot_at: fr.snapshot_at, provisional: false };
      else if (fr) {                                   // a frozen pool loaded without its SIM list: totals now, SIMs on demand
        if (want && !totalsOnly) want.frozen.add(label);
        res = { map: new Map(), frozen: fr, snapshot_at: fr.snapshot_at, provisional: false, light: true };
      } else {
        let pick = cycleSnapshot(c, snaps, today);
        if (pick.snap && !pick.snap.sims) { if (want) want.snaps.add(pick.snap.as_of); pick = { snap: latestFull(), provisional: true }; }
        if (pick.snap) res = { map: allocations(c, pick.snap, snaps, firstUse, histNow()), frozen: null, snapshot_at: pick.snap.as_of, provisional: pick.provisional };
      }
      cache.set(label, res);
      return res;
    };
  }
  // Each SIM's last day with data in any loaded report: Itemized days, else the reports' last session
  function lastUseMap(months) {
    const out = new Map();
    const seen = (k, d) => { if (d && (!out.has(k) || d > out.get(k))) out.set(k, d); };
    Object.values(months || {}).forEach(m => {
      (m.rows || []).forEach(r => { if ((r.summary_mb || 0) > 0 || (r.itemized_mb || 0) > 0) seen(r.iccid, String(r.summary_last || r.last_session || '').slice(0, 10) || null); });
      [m.daily, m.dailySims].forEach(dd => { if (dd) Object.entries(dd).forEach(([k, d]) => Object.entries(d || {}).forEach(([day, mb]) => { if (mb > 0) seen(k, day); })); });
    });
    return out;
  }

  /* ── dataset for the dashboard ─────────────────────────────── */
  // inventory = the latest SIM Group; snapshots = every SIM Group kept (history); frozen = closed cycles' pools;
  // poolSnaps = earlier pool evaluations (recent pace, burn-rate points); alert = the open pool alert, if any
  function buildDataset({ inventory, months, fleet, month, asOf, snapshots, frozen, today, poolSnaps, alert, issues }) {
    const P = window.Providers;
    months = months || {}; frozen = frozen || {}; today = today || localToday();
    const snaps = snapshotsWith(snapshots, inventory);
    const all = P.sortMonths(Object.keys(months));
    const has = (l, src) => !!(l && months[l] && months[l].sources && months[l].sources[src]);
    // Month-wise (vehicle, plan, price, trend tabs and the Month filter) = Data Usage Summary only
    const labels = all.filter(l => has(l, 'summary'));
    const cur = !month || month === 'latest' ? labels[labels.length - 1] || null : (labels.includes(month) ? month : null);
    const curM = cur ? months[cur] : null;
    const curT = simTotals(curM, 'summary');
    // Real-time tab = Itemized report only, with its own day picker — like Airtel's real-time snapshots,
    // independent of the Month filter. Latest = the newest cycle's last Itemized day. (The pool: see poolLabel below.)
    const rtLabels = all.filter(l => has(l, 'itemized'));
    const latestRt = rtLabels[rtLabels.length - 1] || null;
    const rtLabel = asOf && has(monthLabelForDate(asOf), 'itemized') ? monthLabelForDate(asOf) : latestRt;
    const rtM = rtLabel ? months[rtLabel] : null;
    const rtLast = itemizedLast(rtM);
    // A day before the cycle's last Itemized day needs the per-SIM daily data; the last day is the Itemized totals
    const pickOk = !!(asOf && rtM && monthLabelForDate(asOf) === rtLabel && (asOf >= (rtLast || '') || rtM.daily || (rtM.asOfTotals && rtM.asOfTotals.date === asOf)));
    const rtDay = pickOk ? (rtLast && asOf > rtLast ? rtLast : asOf) : rtLast;
    const rtT = !rtM ? new Map() : rtDay && rtLast && rtDay < rtLast ? simTotalsAsOf(rtM, rtDay) : simTotals(rtM, 'itemized');
    // null = the latest view. The newest Itemized day is the latest view only when the pool's newest data is that
    // same day of the Itemized report — with a newer Summary, picking it shows that day (Itemized) instead
    const lu = latestUsage(months);
    const latestIsRtLast = !!(lu && lu.label === latestRt && lu.src === 'itemized');
    const asOfDate = pickOk && !(rtLabel === latestRt && rtDay === rtLast && latestIsRtLast) ? rtDay : null;
    const invBy = new Map(); (inventory ? inventory.sims : []).forEach(x => invBy.set(x.iccid, x));
    const monthT = labels.map(l => [l, months[l], simTotals(months[l], 'summary')]);
    const tiers = tiersFrom(inventory);
    const cyc = cur ? cycleForLabel(cur) : null;             // month-wise allocations against this cycle
    const rtCyc = rtLabel ? cycleForLabel(rtLabel) : null;   // real-time allocations against this one

    // Each cycle's allocations: its frozen record, or its SIM Group under the current rules
    const missingDaily = new Map(), want = { snaps: new Set(), frozen: new Set() };
    const allocFor = allocResolver({ months, frozen, snaps, today, missing: missingDaily, want });
    // The pool: the newest cycle with usage of either kind (a past "as of" day: that day's Itemized cycle). Its used
    // figure comes from whichever report reaches later (cycleUsage); a past day can only come from the Itemized days.
    const usageLabels = all.filter(l => has(l, 'summary') || has(l, 'itemized'));
    const poolLabel = asOfDate ? rtLabel : usageLabels[usageLabels.length - 1] || null;
    const pm = poolLabel ? months[poolLabel] : null;
    let poolUse = null;
    if (pm) {
      poolUse = asOfDate ? { src: 'itemized', t: rtT, until: rtDay, other: summaryDay(pm) } : cycleUsage(pm);
      if (!asOfDate && poolUse.src === 'itemized' && poolLabel === rtLabel) poolUse = Object.assign({}, poolUse, { t: rtT, until: rtDay });
    }
    const curAlloc = allocFor(cur), rtAlloc = allocFor(rtLabel), poolAlloc = allocFor(poolLabel);
    // Membership day: SIMs starting after it were not in the pool yet. Latest view = the last day the usage
    // report or the cycle's SIM Group reaches, kept inside the cycle.
    const memberDay = (m, al, use) => { const sd = al && al.snapshot_at ? dayOf(al.snapshot_at) : null; return m ? clampToCycle(m, [use, sd].filter(Boolean).sort().pop()) : sd; };
    const poolDate = asOfDate || memberDay(pm, poolAlloc, poolUse && poolUse.until);
    const rtDate = asOfDate || memberDay(rtM, rtAlloc, rtLast);

    // Fleet lookup by every identifier VI gives us
    const fIdx = new Map();
    (fleet || []).forEach(v => { const k = P.normKey(v.sim); if (k && k !== 'nan' && !fIdx.has(k)) fIdx.set(k, v); });
    const findVeh = (iccid, msisdn, imsi) => fIdx.get(iccid) || (msisdn && (fIdx.get(P.normKey(msisdn)) || fIdx.get(P.normKey(msisdn).replace(/^91/, '')))) || (imsi && fIdx.get(P.normKey(imsi))) || null;

    const allSims = new Set(invBy.keys());
    monthT.forEach(([, , t]) => t.forEach((_, k) => allSims.add(k)));
    rtT.forEach((_, k) => allSims.add(k));
    [rtAlloc, poolAlloc].forEach(al => { if (al) al.map.forEach((_, k) => allSims.add(k)); });
    if (poolUse) poolUse.t.forEach((_, k) => allSims.add(k));
    const usageTables = [rtT, ...monthT.map(x => x[2])];
    const simKeys = new Set();
    const info = new Map();                  // iccid → identity + plan + status (latest SIM Group)
    allSims.forEach(iccid => {
      const inv = invBy.get(iccid);
      let msisdn = inv && inv.msisdn, imsi = inv && inv.imsi;
      if (!msisdn || !imsi) for (const t of usageTables) { const x = t.get(iccid); if (x) { msisdn = msisdn || x.msisdn; imsi = imsi || x.imsi; } }
      for (const al of [rtAlloc, poolAlloc]) if (!msisdn && al && al.map.has(iccid)) msisdn = al.map.get(iccid).msisdn;
      const pi = inv ? planInfo(inv.deal_name, inv.base_plan_name) : NO_PLAN;
      if (pi.plan) P.registerPlanLabel(pi.plan, pi.label);
      // The state exactly as VI writes it; a SIM with usage but missing from the SIM Group is never assumed active
      const state = inv ? inv.lifecycle_state || '' : 'Not in SIM Group';
      info.set(iccid, { iccid, msisdn: msisdn || '', imsi: imsi || '', inv, pi, state, status: inv ? normStatus(inv.lifecycle_state) : 'N/A',
        veh: findVeh(iccid, msisdn, imsi) });
      [iccid, msisdn, imsi].forEach(k => { if (k) simKeys.add(P.normKey(k)); });
    });

    // Vehicle rows — same shape the legacy renderers use. A SIM without a vehicle number in the vehicle master is
    // listed too ("No vehicle · <mobile no.>") when it counts in the pool or used data in a month-wise report — the
    // vehicle master only adds the vehicle number (decided with the account owner, 6 Oct 2026)
    const vehicles = [];
    // reg is the row's key (it opens the vehicle popup): the mobile no., plus the ICCID when two SIMs share it (a swap)
    const noVehIds = new Map(); info.forEach(s => { if (!s.veh && s.msisdn) noVehIds.set(s.msisdn, (noVehIds.get(s.msisdn) || 0) + 1); });
    info.forEach(s => {
      let v = s.veh;
      if (!v) {
        const counts = !!(s.inv && eligibility(s.inv, s.pi).ok);
        if (!counts && !monthT.some(([, , t]) => ((t.get(s.iccid) || {}).used_mb || 0) > 0)) return;
        const id = s.msisdn && noVehIds.get(s.msisdn) === 1 ? s.msisdn : (s.msisdn ? s.msisdn + ' · ' : '') + s.iccid;
        v = { reg: NO_VEHICLE + ' · ' + id, client: NO_VEHICLE_CLIENT, hw_id: '', device_id: '', status: '', sim: s.iccid, unmapped: true };
      }
      const pi = s.pi, a = curAlloc ? curAlloc.map.get(s.iccid) : null;
      const used_mb = (curT.get(s.iccid) || {}).used_mb || 0;
      const plan_gb = pi.plan_gb, plan_mb = plan_gb * 1024;
      const plan = plan_gb > 0 ? pi.plan : '';
      const usage_pct = plan_mb > 0 ? Math.round(used_mb / plan_mb * 1000) / 10 : 0;
      const needed = Math.round(used_mb / 1024 * 1.2 * 100) / 100;
      const suggested_gb = (!pi.pooled && s.status === 'Active' && plan_gb > 0 && used_mb > 0) ? tiers.find(t => t >= needed && t < plan_gb) || null : null;
      const monthsArr = [];
      monthT.forEach(([l, mo, t]) => {
        const x = t.get(s.iccid); if (!x) return;
        monthsArr.push({ label: l, used_mb: Math.round(x.used_mb * 10) / 10, used_gb: Math.round(x.used_mb / 1024 * 100) / 100,
          usage_pct: plan_mb > 0 ? Math.round(x.used_mb / plan_mb * 1000) / 10 : 0, plan_gb, plan,
          period_start: mo.period_start, period_end: mo.period_end });
      });
      const row = { provider: 'vi', reg: v.reg, client: v.client, hw_id: v.hw_id, device_id: v.device_id, status: v.status,
        plan, plan_gb, plan_mb, used_mb: Math.round(used_mb * 10) / 10, used_gb: Math.round(used_mb / 1024 * 100) / 100,
        usage_pct, flag: window.getFlag(usage_pct), sim_status: s.status, sim_state: s.state, sim_no: v.sim, unmapped: !!v.unmapped,
        iccid: s.iccid, msisdn: s.msisdn, imsi: s.imsi, deal_name: s.inv ? s.inv.deal_name : '', pooled: pi.pooled,
        activated_at: s.inv ? s.inv.activated_at : '', start_date: a ? a.start : null, start_src: a ? a.src : null, suggested_gb,
        // this cycle's allocation (pro-rated when the SIM started during the cycle); Plan (GB) stays the plan size
        in_pool: !!(a && a.eligible), alloc_gb: a ? Math.round(a.gb * 100) / 100 : null, prorated_days: a ? a.days : null,
        saving_pct: suggested_gb ? Math.round((1 - suggested_gb / plan_gb) * 100) : null, needed_gb: needed, months: monthsArr };
      if (monthsArr.length >= 3 && typeof window.smartRecommend === 'function') {
        const sr = window.smartRecommend(row, tiers);
        if (pi.pooled && sr.rec_type !== 'insufficient') {
          // A pool absorbs heavy SIMs and every pooled SIM contributes the same allocation:
          // per-SIM up/downgrades don't apply — the lever is pool size (Data Pool tab).
          sr.rec_type = 'keep'; sr.suggested_gb = null; sr.saving_pct = null; sr.upgrade_gb = null;
          sr.rec_reason = `Pooled plan — average ${sr.avg_gb} GB over ${sr.months_analyzed} months is covered by the shared pool. Optimise at pool level (Data Pool tab).`;
        }
        Object.assign(row, sr);
      }
      vehicles.push(row);
    });

    // SIM-level rows for the Real-time tab: every SIM of the cycle's SIM Group + any SIM in the Itemized report.
    // No Itemized report yet → no real-time rows (as for Airtel before a real-time upload).
    const simRows = [];
    const listSims = rtM ? new Set([...(rtAlloc ? rtAlloc.map.keys() : invBy.keys()), ...rtT.keys()]) : new Set();
    listSims.forEach(iccid => {
      const s = info.get(iccid); if (!s) return;
      const a = rtAlloc ? rtAlloc.map.get(iccid) : null;
      const live = !!(a && a.eligible && (!rtDate || !a.start || a.start <= rtDate));   // not started yet on that day → no allocation
      const alloc_mb = live ? a.gb * 1024 : 0;
      const used_mb = (rtT.get(iccid) || {}).used_mb || 0;
      const pi = a ? planInfo(a.deal) : s.pi;
      simRows.push({ provider: 'vi', sim_no: iccid, iccid, msisdn: s.msisdn, imsi: s.imsi,
        reg: s.veh ? s.veh.reg : '—', client: s.veh ? s.veh.client : '—', hw_id: s.veh ? s.veh.hw_id : '',
        plan: pi.plan, plan_gb: pi.plan_gb, alloc_mb, used_mb,
        // pool member: negative = drawing on other SIMs' share, so Σ available = pool available
        avail_mb: live ? alloc_mb - used_mb : 0, in_pool: live,
        sim_status: a ? normStatus(a.state) : s.status, sim_state: a ? a.state : s.state, pooled: pi.pooled,
        deal_name: pi.plan, activated_at: s.inv ? s.inv.activated_at : '', start_date: a ? a.start : null, start_src: a ? a.src : null,
        prorated_days: a ? a.days : null });
    });
    const rtRows = typeof window.rtFinalize === 'function' ? window.rtFinalize(simRows).rows : simRows;

    const clients = [...new Set(vehicles.map(v => v.client).filter(c => c && c !== 'nan'))].sort();
    const CD = { vehicles, stats: window.buildStats(vehicles), clients, plan_summary: [] };
    const states = {}; (poolAlloc ? [...poolAlloc.map.values()] : (inventory ? inventory.sims.map(x => ({ state: x.lifecycle_state })) : []))
      .forEach(x => { const k = x.state || '(blank)'; states[k] = (states[k] || 0) + 1; });
    let pool;
    if (!pm) pool = { hasPool: false, states, needsUsage: true };
    else if (!poolAlloc) pool = { hasPool: false, states, needsInventory: true };
    else pool = computePool({ info, alloc: poolAlloc, curT: poolUse.t, curM: pm, asOfDate, poolDate, day: poolUse.until, today,
      invAsOf: inventory ? inventory.as_of : null, usage: poolUse, lastUse: lastUseMap(months),
      snaps: (poolSnaps || []).filter(x => x.reporting_period === poolLabel), issues, missing: missingDaily });
    const trend = cycleTrend(all, months, allocFor);
    const todayCycle = cycleForDate(today);
    return { CD, trData: vehicles.filter(v => v.months.length > 0), rtRows, uploaded: true,
      // month-wise (Summary): the Month filter lists these
      months: labels, currentMonth: cur, cycle: cyc,
      // real-time (Itemized): the Real-time tab's day picker and the pool
      rtMonths: rtLabels, rtMonth: rtLabel, rtCycle: rtCyc, rtDay, asOf: asOfDate, dataDate: rtDay,
      pool, poolMonth: poolLabel, poolAlert: alert || null, trend, today, todayCycle,
      // loaded on demand from the cloud: some SIMs' daily figures (go-live detection), SIM Group exports, frozen SIM lists
      needsDaily: [...missingDaily.keys()], needsDailySims: [...(mergeWant(missingDaily, state.wantDaily || new Map()), missingDaily)].map(([label, s]) => ({ label, iccids: [...s] })),
      needsSnapshots: [...new Set([...want.snaps, ...state.wantSnaps])], needsFrozen: [...want.frozen],
      simKeys, tiers, recon: curM ? curM.recon : null, inventoryAsOf: inventory ? inventory.as_of : null, simCount: listSims.size };
  }
  // Pool, used and utilisation of every cycle with data — the billing-cycle trend
  function cycleTrend(labels, months, allocFor) {
    return labels.map(label => {
      const al = allocFor(label, true), c = cycleForLabel(label);
      if (!al || !c) return null;
      const u = cycleUsage(months[label]);
      let sims = 0, pool = 0, newN = 0, used = 0;
      // a frozen cycle without its SIM list in memory: its stored totals. Used: the figure stored when it was frozen
      // while the cycle's report has not moved since; otherwise its SIM list is fetched (counted SIMs only)
      if (al.light) {
        sims = al.frozen.eligible_sims || 0; pool = al.frozen.pool_gb || 0; newN = al.frozen.new_activations || 0;
        used = al.frozen.used_gb || 0;
        if (u.until && (!al.frozen.data_until || String(u.until) > String(al.frozen.data_until).slice(0, 10))) allocFor(label);
      }
      al.map.forEach(a => { if (a.eligible) { sims++; pool += a.gb; if (a.start && a.start >= c.start) newN++; } });
      if (!al.light) u.t.forEach((x, k) => { const a = al.map.get(k); if (a && a.eligible) used += x.used_mb / 1024; });
      return { label, cycle: c, sims, pool_gb: pool, used_gb: used, remaining_gb: pool - used, util_pct: pool > 0 ? used / pool * 100 : 0,
        source: u.src, data_until: u.until, new_activations: newN, frozen: !!al.frozen, provisional: !!al.provisional, snapshot_at: al.snapshot_at };
    }).filter(Boolean);
  }
  // Days the Real-time "as of" picker offers: every day of each cycle that has an Itemized report, up to its
  // last Itemized day, newest first. Summary-only cycles are month-wise data and are not offered.
  function asOfOptions() {
    return window.Providers.sortMonths(Object.keys(state.months)).reverse().map(label => {
      const m = state.months[label], cycle = cycleForLabel(label), last = itemizedLast(m);
      const hasDaily = !!(last && m.dailyTotals && Object.keys(m.dailyTotals).length);
      const dates = [];
      if (hasDaily && cycle) for (let d = clampToCycle(m, last); d >= cycle.start; d = addDays(d, -1)) dates.push(d);
      return { label, cycle, hasDaily, latest: last, dates };
    }).filter(o => o.hasDaily);
  }

  /* ── data pool ─────────────────────────────────────────────── */
  const fmtDate = d => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : ''; };
  const r2 = v => (Math.round(v * 100) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  // backup = shortfall + margin, rounded UP to the step (toFixed: 451,000 × 1.1 must give 496,100, not 496,110)
  const backupFor = (shortfall, O) => (shortfall > 0 ? Math.ceil(+(shortfall * (1 + O.backup_margin_pct / 100)).toFixed(6) / O.backup_round_gb) * O.backup_round_gb : 0);
  const median = list => { const s = list.slice().sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

  /* ── per-SIM pace (decided with the account owner, 6 Oct 2026) ──
     The pool grows with every SIM that starts (plan ÷ 30 a day from its start), so usage is measured the same way:
     GB per SIM per day. Each counting SIM is live from max(cycle start, its start); SIM-days = live SIMs summed over days.
     projected = used + pace × the SIM-days still to come for the SIMs counting now — right whether the fleet stays,
     grows (324 → thousands) or shrinks during the cycle. Nothing here depends on how many SIMs there are. */
  // A SIM's ICCID as a 32-bit number (FNV-1a); summed over a set it identifies the set whatever the order
  const simHash = id => { let h = 0x811c9dc5; const s = String(id || ''); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
  const H32 = 4294967296;
  function liveIndex(pooled, ps, pe) {
    const T = dayDiff(ps, pe) + 1, add = new Array(T + 1).fill(0), addGb = new Array(T + 1).fill(0), addH = new Array(T + 1).fill(0);
    pooled.forEach(s => {
      const f = s.start && s.start > ps ? s.start : ps; if (f > pe) return;
      const i = dayDiff(ps, f); add[i]++; addGb[i] += s.gb || 0; addH[i] = (addH[i] + simHash(s.iccid)) % H32;
    });
    const live = new Array(T), cum = new Array(T), gbBy = new Array(T), hBy = new Array(T);
    let n = 0, c = 0, g = 0, h = 0;
    for (let i = 0; i < T; i++) { n += add[i]; live[i] = n; c += n; cum[i] = c; g += addGb[i]; gbBy[i] = g; h = (h + addH[i]) % H32; hBy[i] = h; }
    const at = d => { const i = dayDiff(ps, d); return i < 0 ? -1 : Math.min(i, T - 1); };
    return {
      days: T, sdCycle: c,
      live: d => { const i = dayDiff(ps, d); return i < 0 || i >= T ? 0 : live[i]; },
      sdTo: d => { const i = at(d); return i < 0 ? 0 : cum[i]; },          // SIM-days from the 22nd to the end of d
      allocTo: d => { const i = at(d); return i < 0 ? 0 : gbBy[i]; },      // allocation of the SIMs started by d
      counted: d => { const i = at(d); return i < 0 ? { n: 0, h: 0 } : { n: live[i], h: hBy[i] }; },   // which SIMs had started by d
    };
  }
  // Usage points of this cycle, like with like: the pool's own report only. Itemized → one point a day (scaled to the
  // pool's share of the account's usage); Summary → one point per upload of that report (pool evaluations), from the
  // cycle start (0 used) to the data day. A later upload with less used (a correction) drops the earlier point.
  // An upload evaluated over another set of SIMs (one left the pool, a status rule changed, an older SIM Group missed
  // one) is left out too: its used figure would put that set's usage into the next interval. Each evaluation keeps
  // which SIMs it counted that had started by its data day (count + order-free hash — `counted`; later SIMs had no usage
  // before it): it must be today's SIMs started by that day. A row stored without it (sql/004 not run): its pool must
  // fit today's SIMs — at least those started by its data day, at most all; a row without a pool cannot be checked.
  // outDaily = { day: MB } of the SIMs that do not count (null: not known — the share of the cycle scales every day)
  function pacePoints({ curM, dataDay, used, src, snaps, L, ps, pe, outDaily }) {
    if (src === 'itemized' && curM && curM.dailyTotals && dataDay) {
      const dayGb = d => Math.max(0, (curM.dailyTotals[d] || 0) - ((outDaily && outDaily[d]) || 0)) / 1024;
      let tot = 0;
      for (let d = ps; d <= dataDay; d = addDays(d, 1)) tot += dayGb(d);
      const share = tot > 0 ? Math.min(1, used / tot) : 1, pts = [];
      for (let d = ps; d <= dataDay; d = addDays(d, 1)) pts.push({ from: d, to: d, days: 1, gb: dayGb(d) * share, sd: L.sdTo(d) - L.sdTo(addDays(d, -1)) });
      return { basis: 'itemized', pts };
    }
    const sameSet = x => {
      if (x.counted && x.counted.n != null) { const c = L.counted(x.as_of); return c.n === +x.counted.n && c.h === +x.counted.h; }
      if (x.pool_gb != null) return L.allocTo(x.as_of) - 0.01 <= +x.pool_gb && +x.pool_gb <= L.allocTo(pe) + 0.01;
      return true;
    };
    const best = new Map();
    (snaps || []).forEach(x => {
      if (x.source !== src || !x.as_of || x.as_of < ps || x.as_of >= dataDay || x.used_gb == null || !sameSet(x)) return;
      if (!best.has(x.as_of) || +x.used_gb > best.get(x.as_of)) best.set(x.as_of, +x.used_gb);
    });
    let marks = [[addDays(ps, -1), 0]].concat([...best.entries()].sort((a, b) => a[0].localeCompare(b[0])), [[dataDay, used]]);
    const kept = []; let floor = Infinity;            // keep a non-decreasing series, newest first
    for (let i = marks.length - 1; i >= 0; i--) if (marks[i][1] <= floor + 1e-9) { kept.unshift(marks[i]); floor = marks[i][1]; }
    marks = kept;
    const pts = [];
    for (let i = 1; i < marks.length; i++) {
      const [a, ua] = marks[i - 1], [b, ub] = marks[i];
      pts.push({ from: addDays(a, 1), to: b, days: dayDiff(a, b), gb: ub - ua, sd: L.sdTo(b) - L.sdTo(a) });
    }
    return { basis: pts.length > 1 ? 'uploads' : 'cycle', pts };
  }
  function simPace({ pooled, curM, dataDay, used, cap, src, snaps, O, outDaily }) {
    const ps = curM.period_start, pe = curM.period_end, L = liveIndex(pooled, ps, pe);
    const { basis, pts } = pacePoints({ curM, dataDay, used, src, snaps, L, ps, pe, outDaily });
    const usable = pts.filter(p => p.sd > 0), rate = p => p.gb / p.sd;
    // The newest window of at least recent_days days (whole points); early in the cycle: everything so far
    let wStart = usable.length;
    for (let d = 0; wStart > 0 && d < O.recent_days;) { wStart--; d += usable[wStart].days; }
    const win = usable.slice(wStart);
    // One heavy day (≥ spike_factor × the median day; the median of the cycle's single-day points, 3+ of them): its
    // excess is counted once (it is in `used`) but never carried forward — requirement §28. The heaviest day INSIDE the
    // window is the one left out. An upload covering several days can hide one: when the excess of those days over the
    // median, put on one of them, makes it a spike_factor× day, it is treated the same way (if the usage stays up, the
    // next upload shows it — a jump needs 2 separate points).
    let spike = null;
    const one = usable.filter(p => p.days === 1);
    if (one.length >= 3 && win.length) {
      const med = median(one.map(rate));
      const peak = p => 1 + (p.gb - med * p.sd) * p.days / (med * p.sd);   // its heaviest possible day, × the median day
      const top = med > 0 ? win.reduce((m, p) => (!m || peak(p) > peak(m) ? p : m), null) : null;
      if (top && peak(top) >= O.spike_factor) spike = { date: top.to, from: top.from, days: top.days, gb: top.gb, excess_gb: top.gb - med * top.sd,
        gb_sim_day: rate(top), peak_x: peak(top), median_gb_sim_day: med };
    }
    const exOf = p => (spike && p.to === spike.date && p.from === spike.from ? spike.excess_gb : 0);
    let wGb = 0, wRaw = 0, wSd = 0, wDays = 0;
    win.forEach(p => { wGb += p.gb - exOf(p); wRaw += p.gb; wSd += p.sd; wDays += p.days; });
    const wFrom = win.length ? win[0].from : null;
    const rWindow = wSd > 0 ? Math.max(0, wGb) / wSd : 0, rRaw = wSd > 0 ? wRaw / wSd : 0;
    // A jump that lasts: the newest 2+ separate points, covering sustain_days+ days, ALL run ≥ jump_pct above the
    // window (one heavy day — or one upload interval holding it — can never do it; the next upload must confirm it)
    let jump = null;
    { const last = []; let d = 0;
      for (let i = usable.length - 1; i >= 0 && (d < O.sustain_days || last.length < 2); i--) { last.push(usable[i]); d += usable[i].days; }
      if (d >= O.sustain_days && last.length >= 2) {
        const low = Math.min(...last.map(rate));
        if (rWindow > 0 && low >= (1 + O.jump_pct / 100) * rWindow) jump = { gb_sim_day: low, from: last[last.length - 1].from, to: last[0].to, days: d };
      } }
    const r = jump ? jump.gb_sim_day : rWindow;
    const sdEl = L.sdTo(dataDay), sdLeft = Math.max(0, L.sdCycle - sdEl);
    // SIMs that start after the data day: their SIM-days and their own allocation (the "new SIMs not measured" check
    // compares the measured SIMs' projection with the pool WITHOUT the new SIMs' share)
    let newSims = 0, newLeft = 0, newAlloc = 0;
    pooled.forEach(s => { const f = s.start && s.start > ps ? s.start : ps; if (f > dataDay && f <= pe) { newSims++; newLeft += dayDiff(f, pe) + 1; newAlloc += s.gb || 0; } });
    const projected = used + r * sdLeft, projectedMeasured = used + r * (sdLeft - newLeft), projectedRaw = used + rRaw * sdLeft;
    // Run-out day: walk forward with the SIMs live each day
    let rem = cap - used, lasts = Infinity, exhaustion = null, k = 0;
    const curve = [{ date: dataDay, gb: used }];
    if (rem <= 0) { lasts = 0; exhaustion = dataDay; }
    for (let d = addDays(dataDay, 1), cum = used; d <= pe; d = addDays(d, 1)) {
      k++; const burn = r * L.live(d); cum += burn; curve.push({ date: d, gb: cum });
      if (exhaustion === null && rem > 0 && burn > 0 && burn >= rem) { lasts = k - 1 + rem / burn; exhaustion = d; }
      if (exhaustion === null) rem -= burn;
    }
    if (exhaustion === null && rem > 0) { const b = r * L.live(pe); lasts = b > 0 ? k + rem / b : Infinity; }
    return { basis: jump ? 'jump' : basis === 'itemized' ? 'itemized' : wFrom && wFrom > ps ? 'uploads' : 'cycle',
      gb_sim_day: r, window_gb_sim_day: rWindow, cycle_gb_sim_day: sdEl > 0 ? used / sdEl : 0, alloc_gb_sim_day: L.sdCycle > 0 ? cap / L.sdCycle : 0,
      window: wSd > 0 ? { from: wFrom, to: dataDay, days: wDays, sd: wSd, gb: wGb } : null, spike, jump,
      sd_elapsed: sdEl, sd_left: sdLeft, sd_cycle: L.sdCycle, sims_now: L.live(addDays(dataDay, 1)) || L.live(dataDay),
      burn_gb_day: r * (L.live(addDays(dataDay, 1)) || L.live(dataDay)), new_sims: newSims, new_sd_left: newLeft, new_alloc_gb: newAlloc, counted: L.counted(dataDay),
      projected_gb: projected, projected_measured_gb: projectedMeasured, projected_raw_gb: projectedRaw, lasts_days: lasts, exhaustion_date: exhaustion, curve };
  }
  // Real-time pool. curM = the Itemized cycle; curT = usage per SIM up to `day` (the day shown); alloc = the
  // cycle's allocations (frozen, or its SIM Group under the current rules); poolDate = pool membership day
  // usage = { src: 'summary' | 'itemized', until, other } — which report the used figures come from (cycleUsage)
  // lastUse = each SIM's last day with data (all loaded reports); snaps = earlier pool evaluations of this cycle
  // issues = what did not load from the cloud this session (listed first among the alerts); missing = Map label → Set
  // of SIMs whose daily figures are asked for (firstUseFn)
  function computePool({ info, alloc, curT, curM, asOfDate, poolDate, day, today, invAsOf, usage, lastUse, snaps, issues, missing }) {
    const O = RULES.ops;
    const cyc = curM ? cycleForLabel(curM.label) : null;
    const A = [...alloc.map.values()];
    const planned = A.filter(a => a.eligible);                                   // in the pool at some point this cycle
    const member = a => a.eligible && (!poolDate || !a.start || a.start <= poolDate);
    const pooled = planned.filter(member);
    const useOf = k => ((curT.get(k) || {}).used_mb || 0) / 1024;
    const vehOf = k => { const s = info.get(k); return s && s.veh ? s.veh : null; };
    // Pool total = Σ each SIM's allocation this cycle (pro-rated when it started during the cycle)
    const cap = pooled.reduce((a, s) => a + s.gb, 0);
    const used = pooled.reduce((a, s) => a + useOf(s.iccid), 0);
    const freq = new Map(); pooled.forEach(s => { if (s.price != null) freq.set(s.price, (freq.get(s.price) || 0) + 1); });
    const price = freq.size ? [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;   // most common pooled price
    const cost = pooled.reduce((a, s) => a + (s.price || 0), 0);
    const idle = pooled.filter(s => useOf(s.iccid) === 0);
    const refDate = day || (curM && curM.period_end) || null;
    const recent = refDate ? idle.filter(s => s.start && dayDiff(s.start, refDate) <= 30).length : 0;
    const over = pooled.filter(s => useOf(s.iccid) > s.gb + 1e-9);
    // Usage outside the pool: SIMs missing from the SIM Group, or in it but not counted (e.g. Ready)
    const unmatched = [...curT.values()].filter(x => !alloc.map.has(x.iccid));
    const nonEligibleUse = [...curT.values()].filter(x => { const a = alloc.map.get(x.iccid); return a && !member(a) && x.used_mb > 0; });
    const gbOf = list => list.reduce((a, x) => a + x.used_mb / 1024, 0);
    const nonPoolUse = gbOf(unmatched) + gbOf(nonEligibleUse);
    let daysTotal = null, daysElapsed = null, complete = null, reqProjected = used, dataDay = null, ended = false;
    if (curM && curM.period_start && curM.period_end) {
      daysTotal = dayDiff(curM.period_start, curM.period_end) + 1;
      // the usage report's day; unknown → today while the cycle is open (never "complete" by default)
      const last = day || (today && today >= curM.period_start && today < curM.period_end ? today : curM.period_end);
      dataDay = clampToCycle(curM, last);
      daysElapsed = Math.min(daysTotal, Math.max(1, dayDiff(curM.period_start, last) + 1));
      complete = daysElapsed >= daysTotal;
      reqProjected = complete ? used : used / daysElapsed * daysTotal;
      // the cycle is over (today is past its last day) but its final usage was never uploaded: usage has reset —
      // no forecast or alert for it any more
      ended = !complete && !asOfDate && !!today && today > curM.period_end;
    }
    const simLine = s => { const v = vehOf(s.iccid); return { iccid: s.iccid, msisdn: s.msisdn || (info.get(s.iccid) || {}).msisdn || '', reg: v ? v.reg : '—', client: v ? v.client : '—', used_gb: useOf(s.iccid), alloc_gb: s.gb }; };
    const top = pooled.map(simLine).sort((a, b) => b.used_gb - a.used_gb).slice(0, 10).map(x => Object.assign(x, { share_pct: used > 0 ? x.used_gb / used * 100 : 0 }));
    const low = pooled.map(simLine).filter(x => x.used_gb > 0).sort((a, b) => a.used_gb - b.used_gb).slice(0, 10);
    const above = over.map(simLine).map(x => Object.assign(x, { excess_gb: x.used_gb - x.alloc_gb })).sort((a, b) => b.excess_gb - a.excess_gb).slice(0, 10);
    const inCyc = d => !curM.period_start || (d >= curM.period_start && d <= curM.period_end);
    const daily = curM && curM.dailyTotals ? Object.entries(curM.dailyTotals).filter(([d]) => inCyc(d)).sort(([a], [b]) => a.localeCompare(b)).map(([date, mb]) => ({ date, gb: mb / 1024 })) : [];
    const util = cap > 0 ? used / cap * 100 : 0;
    // ── Shared-pool forecast (the operational control — never a single SIM's allocation) ──
    // Requirement figures, shown as they are: average = used ÷ days elapsed; projected = average × cycle days
    const pace = daysElapsed ? used / daysElapsed : 0;
    const remaining = cap - used;
    const daysLeft = daysTotal != null && daysElapsed != null ? daysTotal - daysElapsed : null;     // after the data day
    const reqLasts = pace > 0 ? Math.max(0, remaining) / pace : Infinity;
    const reqExhaustion = cap > 0 && dataDay && !complete ? (remaining <= 0 ? dataDay : (daysLeft != null && reqLasts < daysLeft ? addDays(dataDay, Math.ceil(reqLasts)) : null)) : null;
    const req = { avg_gb_day: pace, projected_gb: reqProjected, projected_pct: cap > 0 ? reqProjected / cap * 100 : 0, lasts_days: reqLasts, exhaustion_date: reqExhaustion };
    // Decisions — level, run-out day, shortfall, backup — use the per-SIM pace (decided 6 Oct 2026)
    const src = (usage && usage.src) || 'itemized';
    // The pool's own usage day by day (Itemized): the account's daily totals less the SIMs that do not count, from their
    // daily figures (asked for when not loaded yet; until then each day is scaled by the pool's share of the cycle)
    let outDaily = null;
    const outside = unmatched.concat(nonEligibleUse);
    if (src === 'itemized' && curM && curM.dailyTotals && outside.length) {
      const per = outside.map(x => simDaily(curM, x.iccid));
      if (per.every(Boolean)) { outDaily = {}; per.forEach(d => Object.entries(d).forEach(([k, mb]) => { outDaily[k] = (outDaily[k] || 0) + (+mb || 0); })); }
      else if (missing && !curM.dailyFailed) outside.forEach((x, i) => { if (!per[i]) { if (!missing.has(curM.label)) missing.set(curM.label, new Set()); missing.get(curM.label).add(x.iccid); } });
    }
    const sp = curM && curM.period_start && dataDay && !complete ? simPace({ pooled, curM, dataDay, used, cap, src, snaps, O, outDaily }) : null;
    const projected = complete || !sp ? reqProjected : sp.projected_gb, projUtil = cap > 0 ? projected / cap * 100 : 0;
    const lasts = sp ? sp.lasts_days : reqLasts;
    const exhaustion = cap > 0 && dataDay && !complete && !ended ? (remaining <= 0 ? dataDay : sp && sp.exhaustion_date && daysLeft != null && lasts < daysLeft ? sp.exhaustion_date : null) : null;
    const gapDays = exhaustion ? Math.max(0, daysLeft - lasts) : 0;
    const shortfall = complete || ended ? Math.max(0, used - cap) : Math.max(0, projected - cap);
    const backup = complete || ended ? 0 : backupFor(shortfall, O);
    // Critical from the projection needs it confirmed: the previous evaluation of this cycle (an earlier data day) was
    // over the pool too — 2 data days in a row (decided 6 Oct 2026)
    let prev = null;
    (snaps || []).forEach(x => {
      if (!x.as_of || !dataDay || x.as_of >= dataDay || x.projected_gb == null || x.pool_gb == null) return;
      if (!prev || x.as_of > prev.as_of || (x.as_of === prev.as_of && x.source === src && prev.source !== src)) prev = x;
    });
    const prevOver = !!(prev && +prev.projected_gb > +prev.pool_gb + 1e-9);
    // Level: Critical = used up · runs out within critical_lead_days · projected over the pool on 2 data days in a row
    // (after critical_min_days of data, and not only because of SIMs with no data yet). Warning = any sign short of that.
    let level = 'healthy'; const levelWhy = [];
    const overPool = cap > 0 && projected > cap;
    // over only because SIMs with no data yet are counted at the fleet pace: the measured SIMs fit their own share
    const onlyNew = !!(sp && sp.new_sims && sp.projected_measured_gb <= cap - sp.new_alloc_gb);
    if (complete || ended) level = 'closed';
    else if (cap > 0 && remaining <= 0) { level = 'critical'; levelWhy.push('used_up'); }
    else if (cap > 0 && exhaustion && daysElapsed >= O.critical_min_days && dayDiff(dataDay, exhaustion) <= O.critical_lead_days) { level = 'critical'; levelWhy.push('runs_out_soon'); }
    else if (overPool && daysElapsed >= O.critical_min_days && prevOver && !onlyNew) { level = 'critical'; levelWhy.push('projected_over'); }
    else if (cap > 0) {
      if (overPool && daysElapsed < O.critical_min_days) levelWhy.push('projected_over_early');
      else if (overPool && onlyNew) levelWhy.push('new_sims_unmeasured');
      else if (overPool) levelWhy.push('projected_over_unconfirmed');
      if (projUtil >= O.warning_projected_pct && !overPool) levelWhy.push('projected_high');
      if (req.projected_gb > cap && !overPool) levelWhy.push('average_over');
      if (sp && sp.spike && sp.projected_raw_gb > cap && !overPool && dayDiff(sp.spike.date, dataDay) < O.sustain_days) levelWhy.push('spike');
      if (levelWhy.length) level = 'warning';
    }
    const forecast = { level, why: levelWhy, pool_gb: cap, used_gb: used, remaining_gb: remaining, avg_gb_day: pace, days_total: daysTotal,
      days_elapsed: daysElapsed, days_left: daysLeft, data_day: dataDay, lasts_days: lasts, exhaustion_date: exhaustion, gap_days: gapDays,
      cycle_end: curM ? curM.period_end : null, projected_gb: projected, projected_pct: projUtil, shortfall_gb: shortfall, backup_gb: backup,
      backup_margin_pct: O.backup_margin_pct, backup_round_gb: O.backup_round_gb, req, pace: sp ? Object.assign({}, sp, { curve: undefined }) : null,
      ended, confirmed: prevOver, prev: prev ? { as_of: prev.as_of, source: prev.source, projected_gb: +prev.projected_gb, pool_gb: +prev.pool_gb } : null,
      data_age_days: dataDay && today && !asOfDate ? Math.max(0, dayDiff(dataDay, today)) : null,
      thresholds: { warning_projected_pct: O.warning_projected_pct, critical_min_days: O.critical_min_days, critical_lead_days: O.critical_lead_days, recent_days: O.recent_days, sustain_days: O.sustain_days, jump_pct: O.jump_pct, spike_factor: O.spike_factor } };
    // Pool breakdown: full-cycle SIMs by plan size ("249 SIMs × 85 GB"), SIMs that started during the cycle by
    // start day ("6 SIMs went live 25 Sep × 76.5 GB = 27 days × 2.83 GB")
    const mix = new Map(), pro = new Map();
    pooled.forEach(s => {
      if (s.days == null) { mix.set(s.plan_gb, (mix.get(s.plan_gb) || 0) + 1); return; }
      const k = s.start + '|' + s.plan_gb + '|' + s.src;
      const g = pro.get(k) || { from: s.start, plan_gb: s.plan_gb, src: s.src, days: s.days, per_day_gb: s.per_day, gb: s.gb, sims: 0 };
      g.sims++; pro.set(k, g);
    });
    const planMix = [...mix.entries()].map(([g, n]) => ({ gb: g, sims: n })).sort((a, b) => b.sims - a.sims || a.gb - b.gb);
    const proGroups = [...pro.values()].sort((a, b) => a.from.localeCompare(b.from) || a.plan_gb - b.plan_gb)
      .map(g => Object.assign(g, { total_gb: g.gb * g.sims }));
    const prorated = { sims: proGroups.reduce((a, g) => a + g.sims, 0), gb: proGroups.reduce((a, g) => a + g.total_gb, 0),
      full_sims: planMix.reduce((a, m) => a + m.sims, 0), full_gb: planMix.reduce((a, m) => a + m.gb * m.sims, 0),
      divisor_days: PRORATE_DAYS, groups: proGroups };
    const fresh = cyc ? pooled.filter(s => s.start && s.start >= cyc.start) : [];
    const detected = pooled.filter(s => s.src === 'detected');
    // Day by day through the cycle: used that day, used so far, pool size (SIMs started by then), remaining
    const days = [];
    if (curM && curM.period_start && curM.dailyTotals && Object.keys(curM.dailyTotals).length) {
      const lastDay = clampToCycle(curM, itemizedLast(curM) || curM.period_end);
      let cum = 0;
      for (let d = curM.period_start; d <= lastDay; d = addDays(d, 1)) {
        const use = (curM.dailyTotals[d] || 0) / 1024; cum += use;
        let size = 0, n = 0; planned.forEach(s => { if (!s.start || s.start <= d) { size += s.gb; n++; } });
        days.push({ date: d, day: dayDiff(curM.period_start, d) + 1, used_gb: use, cum_gb: cum, sims: n, pool_gb: size, avail_gb: size - cum });
      }
    }
    // SIM status table — states exactly as in the SIM Group file, with the rule and what each adds
    const stMap = new Map();
    const stRow = k => stMap.get(k) || (stMap.set(k, { state: k, rule: k === 'Not in SIM Group' ? null : ruleFor(k), sims: 0, pool_sims: 0, pool_gb: 0, used_gb: 0, with_usage: 0, reasons: {} }), stMap.get(k));
    A.forEach(a => {
      const r = stRow(a.state || '(blank)'); r.sims++;
      if (member(a)) { r.pool_sims++; r.pool_gb += a.gb; }
      const u = useOf(a.iccid); r.used_gb += u; if (curT.has(a.iccid)) r.with_usage++;
      const why = member(a) ? 'Counted in the pool' : a.eligible ? `Starts ${fmtDate(a.start)} — after ${fmtDate(poolDate)}` : a.reason;
      r.reasons[why] = (r.reasons[why] || 0) + 1;
    });
    unmatched.forEach(x => { const r = stRow('Not in SIM Group'); r.sims++; r.used_gb += x.used_mb / 1024; r.with_usage++; r.reasons['Used data but is not in the SIM Group file — not counted'] = (r.reasons['Used data but is not in the SIM Group file — not counted'] || 0) + 1; });
    const statusTable = [...stMap.values()].sort((a, b) => b.pool_sims - a.pool_sims || b.sims - a.sims)
      .map(r => Object.assign(r, { reasons: Object.entries(r.reasons).sort((a, b) => b[1] - a[1]).map(([text, n]) => ({ text, n })) }));
    // Inventory ↔ usage reconciliation
    const usageIds = [...curT.keys()];
    const recon = { inventory_sims: A.length, usage_sims: usageIds.length, matched: usageIds.filter(k => alloc.map.has(k)).length,
      eligible_sims: pooled.length, eligible_no_usage: idle.length,
      usage_no_inventory: unmatched.length, usage_no_inventory_gb: gbOf(unmatched),
      usage_non_eligible: nonEligibleUse.length, usage_non_eligible_gb: gbOf(nonEligibleUse),
      // SIMs that count but have no vehicle number in the vehicle master (listed as "No vehicle · <mobile no.>")
      no_vehicle: pooled.filter(a => !vehOf(a.iccid)).length };
    recon.inventory_no_usage = recon.inventory_sims - recon.matched;
    // SIM-wise allocation — every SIM of the cycle's SIM Group plus SIMs with usage missing from it
    const simTable = A.map(a => {
      const u = useOf(a.iccid), live = member(a), v = vehOf(a.iccid);
      return { iccid: a.iccid, msisdn: a.msisdn || (info.get(a.iccid) || {}).msisdn || '', reg: v ? v.reg : '', client: v ? v.client : '',
        state: a.state, in_pool: live, reason: live ? 'Counted in the pool' : a.eligible ? `Starts ${fmtDate(a.start)}` : a.reason,
        vi_date: a.vi_date, start: a.start, src: a.src, how: a.how, ready_at: a.ready_at, active_at: a.active_at,
        plan_gb: a.plan_gb, deal: a.deal, days: live ? (a.days == null ? (cyc ? cyc.days : null) : a.days) : null, full: live && a.days == null,
        per_day: live && a.plan_gb ? a.plan_gb / PRORATE_DAYS : null, alloc_gb: live ? a.gb : 0, used_gb: u,
        remaining_gb: live ? a.gb - u : null, usage_pct: live && a.gb > 0 ? u / a.gb * 100 : null };
    }).concat(unmatched.map(x => ({ iccid: x.iccid, msisdn: x.msisdn || '', reg: (vehOf(x.iccid) || {}).reg || '', client: (vehOf(x.iccid) || {}).client || '',
      state: 'Not in SIM Group', in_pool: false, reason: 'Not in the SIM Group file — not counted', vi_date: null, start: null, src: null,
      plan_gb: 0, deal: '', days: null, full: false, per_day: null, alloc_gb: 0, used_gb: x.used_mb / 1024, remaining_gb: null, usage_pct: null })))
      .sort((a, b) => (b.in_pool - a.in_pool) || b.used_gb - a.used_gb || String(a.iccid).localeCompare(String(b.iccid)));
    // ── Zero-usage SIMs: count in this cycle's pool, 0 bytes from max(cycle start, their start) to the data day ──
    // Categories (configurable): newly activated (< zero_new_days since start) · long-term (no data for
    // zero_long_days+, since the last use or — never used — since the start) · no usage (the rest). Never closed here.
    // days are counted to the newest report's day (a stale report must not make a SIM look idle for longer)
    const refDay = asOfDate || dataDay || today;
    const zeroList = idle.map(s => {
      const v = vehOf(s.iccid), from = s.start || s.vi_date || (cyc && cyc.start);
      const sinceStart = from ? Math.max(0, dayDiff(from, refDay)) : null;
      const last = (lastUse && lastUse.get(s.iccid)) || null;
      const idleDays = last ? Math.max(0, dayDiff(last, refDay)) : sinceStart;
      const category = sinceStart != null && sinceStart < O.zero_new_days ? 'new' : idleDays != null && idleDays >= O.zero_long_days ? 'long_term' : 'no_usage';
      const action = category === 'new' ? 'Newly active — give it time'
        : category === 'long_term' ? `No data for ${idleDays} days — review; consider stopping it before the next cycle${cyc ? ` (starts ${fmtDate(cyc.resets)})` : ''}`
        : `No data for ${idleDays} days — keep watching`;
      return { iccid: s.iccid, msisdn: s.msisdn || (info.get(s.iccid) || {}).msisdn || '', reg: v ? v.reg : '', client: v ? v.client : '', state: s.state,
        vi_date: s.vi_date, start: s.start, src: s.src, days_since_start: sinceStart, last_use: last, idle_days: idleDays, category, action,
        price: s.price, alloc_gb: s.gb };
    }).sort((a, b) => (b.idle_days || 0) - (a.idle_days || 0) || String(a.iccid).localeCompare(String(b.iccid)));
    const zcount = c => zeroList.filter(z => z.category === c).length, zcost = list => list.reduce((a, z) => a + (z.price || 0), 0);
    const zero = { count: zeroList.length, new: zcount('new'), no_usage: zcount('no_usage'), long_term: zcount('long_term'), cost: zcost(zeroList),
      long_term_cost: zcost(zeroList.filter(z => z.category === 'long_term')), data_day: dataDay, new_days: O.zero_new_days, long_days: O.zero_long_days,
      ready_sims: A.filter(a => isPrelive(a.state)).length, list: zeroList };
    // ── High-usage SIMs (analytical): cycle pace ≥ high_pct of their daily allocation — the shared pool covers them ──
    const highList = pooled.map(s => {
      const u = useOf(s.iccid); if (!(u > 0) || !dataDay || !cyc) return null;
      const from = s.start && s.start > cyc.start ? s.start : cyc.start;
      const days = Math.max(1, dayDiff(from, dataDay) + 1), perDay = s.plan_gb / PRORATE_DAYS, gbDay = u / days;
      const v = vehOf(s.iccid);
      return { iccid: s.iccid, msisdn: s.msisdn || (info.get(s.iccid) || {}).msisdn || '', reg: v ? v.reg : '', client: v ? v.client : '', used_gb: u, days,
        gb_day: gbDay, per_day: perDay, pct: perDay > 0 ? gbDay / perDay * 100 : null, alloc_gb: s.gb, over_alloc: u > s.gb + 1e-9 };
    }).filter(x => x && x.pct != null && x.pct >= O.high_pct).sort((a, b) => b.gb_day - a.gb_day);
    const high = { count: highList.length, pct: O.high_pct, gb: highList.reduce((a, x) => a + x.used_gb, 0), list: highList };
    // ── Burn-rate data: cumulative used (Itemized days + earlier usage uploads + the current figure), pool line, projection ──
    const burnPts = new Map();
    days.forEach(d => burnPts.set(d.date, { date: d.date, gb: d.cum_gb, src: 'itemized' }));
    (snaps || []).forEach(x => { if (x.as_of && x.used_gb != null && !burnPts.has(x.as_of)) burnPts.set(x.as_of, { date: x.as_of, gb: +x.used_gb, src: x.source || 'upload' }); });
    if (dataDay) burnPts.set(dataDay, { date: dataDay, gb: used, src: (usage && usage.src) || 'itemized' });
    // pool size each day of the cycle: the SIMs that had started by then (from the pool's day on: the pool)
    const poolLine = [];
    if (cyc) for (let d = cyc.start; d <= cyc.end; d = addDays(d, 1)) {
      let size = 0;
      if (poolDate && d >= poolDate) size = cap; else planned.forEach(s => { if (!s.start || s.start <= d) size += s.gb; });
      poolLine.push({ date: d, gb: size });
    }
    const burn = cyc ? { start: cyc.start, end: cyc.end, actual: [...burnPts.values()].filter(x => x.date >= cyc.start && x.date <= cyc.end).sort((a, b) => a.date.localeCompare(b.date)),
      pool: poolLine,
      // where the per-SIM pace leads, day by day (bends upward on days new SIMs start)
      projection: !complete && !ended && sp ? sp.curve : [], cap, exhaustion } : null;
    // Plans in the pool, with the daily rate each pro-rates at
    const plans = [...new Set(pooled.map(s => s.plan_gb))].sort((a, b) => a - b).map(g => ({ gb: g, per_day: g / PRORATE_DAYS, sims: pooled.filter(s => s.plan_gb === g).length }));
    // Recommendation: keep 20% headroom over the projected cycle usage
    let rec;
    const gb2 = v => r2(v) + ' GB';
    const paceTxt = sp ? `${gb2(sp.burn_gb_day)} a day (${r2(sp.gb_sim_day)} GB per SIM × ${sp.sims_now.toLocaleString('en-IN')} SIMs)` : `${gb2(pace)} a day`;
    const pct1 = v => `${(Math.round(v * 10) / 10).toFixed(1)}%`;
    if (ended && pooled.length) rec = { type: 'ended', text: `The ${curM.label} cycle ended on ${fmtDate(cyc && cyc.end)} and usage reset on ${fmtDate(cyc && cyc.resets)}. Its final usage was never uploaded (data to ${fmtDate(dataDay)}), so there is no forecast for it any more — upload the new cycle's reports.` };
    else if (pooled.length && !asOfDate && level === 'critical') rec = { type: 'at_risk', text: remaining <= 0
      ? `The shared pool is used up: ${gb2(used)} of ${gb2(cap)}. Devices may go offline until the cycle resets on ${fmtDate(cyc && cyc.resets)} — arrange backup data now.`
      : `At the current pace of ${paceTxt} the shared pool runs out around ${fmtDate(exhaustion)} — about ${gapDays.toFixed(1)} day(s) before the cycle ends (${fmtDate(cyc && cyc.end)}). Projected use ${gb2(projected)} vs pool ${gb2(cap)}: short by ${gb2(shortfall)}. Arrange at least ${gb2(shortfall)} of backup data — ${backup.toLocaleString('en-IN')} GB with the ${O.backup_margin_pct}% margin — to avoid devices going offline.` };
    else if (pooled.length && !asOfDate && level === 'warning') rec = { type: 'at_risk', text: levelWhy.includes('projected_over_early')
      ? `Early in the cycle (day ${daysElapsed}) the pace already points past the pool (${projUtil.toFixed(0)}% projected). Critical is decided after ${O.critical_min_days} days of data — watch the next uploads.`
      : levelWhy.includes('projected_over_unconfirmed')
        ? `At ${paceTxt} the pool runs out around ${fmtDate(exhaustion)} (${pct1(projUtil)} projected, short by ${gb2(shortfall)}). This is the first data day over the pool — Critical when the next upload confirms it. Keep ${backup.toLocaleString('en-IN')} GB of backup data ready.`
        : levelWhy.includes('new_sims_unmeasured')
          ? `${pct1(projUtil)} projected only because ${sp.new_sims.toLocaleString('en-IN')} SIM(s) that start after ${fmtDate(dataDay)} are assumed to use data like the rest; the SIMs with data use ${pct1(sp.projected_measured_gb / Math.max(1e-9, cap - sp.new_alloc_gb) * 100)} of their own share. The next upload measures them.`
          : levelWhy.includes('spike')
            ? `One unusually heavy day (${sp.spike.days > 1 ? `in the ${sp.spike.days} days ${fmtDate(sp.spike.from)} – ${fmtDate(sp.spike.date)} of one upload: ${gb2(sp.spike.gb)}, one day up to ${sp.spike.peak_x.toFixed(1)}× a normal day` : `${fmtDate(sp.spike.date)}: ${gb2(sp.spike.gb)}, ${sp.spike.peak_x.toFixed(1)}× a normal day`}) is counted but not carried forward: ${pct1(projUtil)} projected; ${pct1(sp.projected_raw_gb / cap * 100)} if it continued. Watch the next upload.`
            : levelWhy.includes('average_over') && projUtil < O.warning_projected_pct
              ? `The cycle average (${gb2(pace)} a day × ${daysTotal} days = ${gb2(req.projected_gb)}) is above the pool; the current per-SIM pace (${paceTxt}) gives ${pct1(projUtil)}. Keep backup data ready.`
              : `The pool is tight: ${pct1(projUtil)} projected by the cycle end (${gb2(projected)} of ${gb2(cap)}) at ${paceTxt}. It still lasts the cycle — keep backup data ready.` };
    else if (!pooled.length) rec = { type: 'empty', text: `No SIM counts in the pool${poolDate ? ' on ' + fmtDate(poolDate) : ''} — check the SIM status table: which states count is a rule an admin can change.` };
    else if (asOfDate) rec = { type: projUtil > 95 ? 'at_risk' : 'healthy',     // a past day: pace only — idle-SIM advice needs the latest day
      text: `As of ${fmtDate(asOfDate)}: ${util.toFixed(0)}% of the pool used after ${daysElapsed} of ${daysTotal} days — on pace for ${projUtil.toFixed(0)}% by the cycle end. Pick the latest day for pool-size advice.` };
    else if (!complete && daysElapsed && daysTotal && daysElapsed < Math.ceil(daysTotal * 2 / 3) && projUtil <= 95) {
      // Early in a cycle a SIM with no data yet is not "idle" — pace only until two thirds of the cycle have passed
      rec = { type: 'healthy', text: `Day ${daysElapsed} of ${daysTotal}: ${util.toFixed(1)}% of the pool used, on pace for ${projUtil.toFixed(0)}% by the cycle end. Idle-SIM advice starts on day ${Math.ceil(daysTotal * 2 / 3)} — too early to call a SIM idle.` };
    } else if (projUtil > 95) rec = { type: 'at_risk', text: `Projected ${projUtil.toFixed(0)}% of the pool by cycle end — add capacity or review the top consumers.` };
    else if (projUtil < 60 && idle.length) {
      const capAfter = cap - idle.reduce((a, s) => a + s.gb, 0);
      const utilAfter = capAfter > 0 ? projected / capAfter * 100 : Infinity;
      const saving = idle.reduce((a, s) => a + (s.price || 0), 0);
      rec = utilAfter <= 83
        ? { type: 'oversized', saving, text: `${idle.length} pooled SIM(s) used no data this cycle (₹${saving.toLocaleString('en-IN')}/month). Moving them out of the pool leaves ${Math.round(capAfter).toLocaleString('en-IN')} GB — ${utilAfter.toFixed(0)}% utilised with 20% headroom.${recent ? ` ${recent} of them started in the last 30 days — check before moving.` : ''}` }
        : { type: 'oversized', saving: 0, text: `Pool is ${projUtil.toFixed(0)}% used. Removing all ${idle.length} idle SIMs would leave too little headroom (${utilAfter.toFixed(0)}%) — remove fewer.` };
    } else rec = { type: 'healthy', text: `Pool utilisation ${projUtil.toFixed(0)}% projected — size is appropriate.` };
    // Alerts: what needs attention, most severe first
    const alerts = [];
    const add = (lvl, code, text) => alerts.push({ level: lvl, code, text });
    // The shared-pool level is the operational alert; everything else is supporting information
    if (level === 'critical') add('critical', 'pool_critical', remaining <= 0
      ? `Shared pool used up: ${r2(used)} GB of ${r2(cap)} GB. Devices may go offline until ${fmtDate(cyc && cyc.resets)}.`
      : `Shared pool projected to run out around ${fmtDate(exhaustion)}, ${gapDays.toFixed(1)} day(s) before the cycle ends (${fmtDate(cyc && cyc.end)}) — ${paceTxt}; short by ${r2(shortfall)} GB → backup ${backup.toLocaleString('en-IN')} GB (incl. ${O.backup_margin_pct}%).`);
    else if (level === 'warning') add('warning', 'pool_warning', `Shared pool tight: ${pct1(projUtil)} projected by ${fmtDate(cyc && cyc.end)} at ${paceTxt}${exhaustion ? ` — runs out around ${fmtDate(exhaustion)}` : ''}.`);
    (issues || []).forEach(t => add('warning', 'load_failed', t));
    if (ended) add('warning', 'cycle_ended', `The ${curM.label} cycle ended on ${fmtDate(cyc && cyc.end)} without its final usage report (data to ${fmtDate(dataDay)}). Usage has reset — upload the new cycle's reports.`);
    if (cap > 0 && util >= 80 && level !== 'critical' && !ended) add('info', 'high_util', `Pool utilisation ${util.toFixed(2)}% — ${r2(cap - used)} GB left.`);
    const burnNow = sp ? sp.burn_gb_day : pace;
    if (!complete && !ended && burnNow > 0 && cap - used > 0 && (cap - used) / burnNow < 3) add('warning', 'low_remaining', `${r2(cap - used)} GB left = about ${((cap - used) / burnNow).toFixed(1)} days at the current pace.`);
    if (unmatched.length) add('warning', 'not_in_group', `${unmatched.length} SIM(s) used ${r2(gbOf(unmatched))} GB but are not in the SIM Group file — not counted in the pool. Upload a newer SIM Group file.`);
    if (nonEligibleUse.length) {
      const byState = {}; nonEligibleUse.forEach(x => { const s = alloc.map.get(x.iccid).state || '(blank)'; byState[s] = (byState[s] || 0) + 1; });
      add('warning', 'non_eligible_usage', `${nonEligibleUse.length} SIM(s) not counted in the pool used ${r2(gbOf(nonEligibleUse))} GB (${Object.entries(byState).map(([k, n]) => `${n} "${k}"`).join(', ')}).${Object.keys(byState).some(isPrelive) ? ' A Ready SIM that uses data has probably gone live — upload a newer SIM Group file.' : ''}`);
    }
    const unknown = statusTable.filter(r => r.rule === null && r.state !== 'Not in SIM Group');
    if (unknown.length) add('warning', 'unknown_state', `New SIM state${unknown.length > 1 ? 's' : ''} ${unknown.map(r => `"${r.state}" (${r.sims})`).join(', ')} — no pool rule yet, not counted. An admin can set the rule in the SIM status table.`);
    if (invAsOf && cyc && today >= cyc.start && dayOf(invAsOf) < cyc.start && !alloc.frozen) add('warning', 'stale_group', `The SIM Group file is from ${fmtDate(invAsOf)}, before this cycle started — upload a newer one so new and removed SIMs are counted.`);
    const SRC_NAME = { summary: 'Data Usage Summary', itemized: 'Itemized report' };
    const itLast = itemizedLast(curM);
    if (cyc && today >= cyc.start && today <= cyc.end && !asOfDate && day && dayDiff(day, today) > 2)
      add('warning', 'stale_usage', `The newest usage report (${SRC_NAME[src]}) ends ${fmtDate(day)} — ${dayDiff(day, today)} days ago. Upload newer VI reports.`);
    // The pool's totals come from the newer Summary: the day-by-day figures and the Real-time tab need the Itemized report
    if (src === 'summary' && !asOfDate) add('info', 'daily_older', itLast
      ? `Used = the Data Usage Summary${day ? ` (to ${fmtDate(day)})` : ''}, newer than the Itemized report (to ${fmtDate(itLast)}). The daily charts and the Real-time tab show the Itemized report — upload the newest one to update them.`
      : `Used = the Data Usage Summary${day ? ` (to ${fmtDate(day)})` : ''}. There is no Itemized report for this cycle yet — the daily charts and the Real-time tab need it.`);
    if (recon.no_vehicle) add('info', 'no_vehicle', `${recon.no_vehicle} SIM(s) in this pool have no vehicle number in the vehicle master — the vehicle tabs show SIMs without one as "No vehicle · <mobile no.>". Upload the vehicles file with their SIM or mobile numbers and push it (☁️ Cloud → Push Vehicle Master) to map them.`);
    if (alloc.provisional) add('info', 'provisional', `This cycle has closed but no SIM Group file exported on or after ${fmtDate(cyc && cyc.end)} has been uploaded — the pool is provisional (built from the latest SIM Group). Upload one to freeze it.`);
    if (over.length) add('info', 'above_allocation', `${over.length} SIM(s) used more than their own allocation (${r2(over.reduce((a, s) => a + useOf(s.iccid) - s.gb, 0))} GB beyond it) — covered by the shared pool.`);
    if (fresh.length) add('info', 'new_activations', `${fresh.length} SIM(s) started this cycle and add ${r2(fresh.reduce((a, s) => a + s.gb, 0))} GB (pro-rated from their start day).`);
    if (detected.length) {
      const est = detected.filter(s => s.how === 'summary').length;
      add('info', 'detected', `${detected.length} SIM(s) were Ready in an older SIM Group file — VI keeps the day they were loaded, so their go-live day is taken from their first data use (or the SIM Group that first shows them active).${est ? ` For ${est} of them there are no daily figures yet: the start is the latest day the Data Usage Summary allows (last session − session days + 1) — the Itemized report makes it exact.` : ''}`);
    }
    const noDate = pooled.filter(s => !s.start).length;
    if (noDate) add('info', 'no_date', `${noDate} pooled SIM(s) have no activation date in the SIM Group file — counted at the full plan.`);
    const order = { critical: 0, warning: 1, info: 2 };
    // what failed to load comes first — it qualifies every figure below it
    alerts.sort((a, b) => (b.code === 'load_failed') - (a.code === 'load_failed') || order[a.level] - order[b.level]);
    const todayCycle = cycleForDate(today);
    return { hasPool: true, inventory_loaded: true, snapshot_at: alloc.snapshot_at, provisional: !!alloc.provisional,
      frozen: alloc.frozen ? { at: alloc.frozen.computed_at, snapshot_at: alloc.frozen.snapshot_at, by: alloc.frozen.computed_by || null } : null,
      as_of: asOfDate || null, pool_date: poolDate || null, data_date: day || itLast || null, daily_until: itLast || null,
      usage_src: src, usage_src_name: SRC_NAME[src], usage_other_day: (usage && usage.other) || null,
      cycle: cyc, not_yet_active: planned.length - pooled.length, days, plans, rules: { eligible_states: eligibleStates(), pool_tag: RULES.pool_tag, plan_days: PRORATE_DAYS },
      states: Object.fromEntries(statusTable.filter(r => r.state !== 'Not in SIM Group').map(r => [r.state, r.sims])),
      inventory_sims: A.length, eligible_sims: pooled.length, non_eligible_sims: A.length - planned.length,
      pooled_sims: pooled.length, plan_mix: planMix, prorated, full_gb: prorated.full_gb, prorated_gb: prorated.gb,
      new_activations: { count: fresh.length, gb: fresh.reduce((a, s) => a + s.gb, 0) }, detected_sims: detected.length,
      capacity_gb: cap, price_per_sim: price, monthly_cost: cost,
      used_gb: used, remaining_gb: cap - used, util_pct: util, projected_gb: projected, projected_pct: projUtil, pace_gb: pace,
      level, forecast, zero, high, burn,
      period_start: curM ? curM.period_start : null, period_end: curM ? curM.period_end : null,
      days_total: daysTotal, days_elapsed: daysElapsed, complete,
      today, today_cycle: todayCycle, today_day: todayCycle ? dayDiff(todayCycle.start, today) + 1 : null,
      idle: { count: idle.length, cost: idle.reduce((a, s) => a + (s.price || 0), 0), recent },
      over_share: { count: over.length, excess_gb: over.reduce((a, s) => a + useOf(s.iccid) - s.gb, 0) },
      non_pool_usage_gb: nonPoolUse, top, low, above, daily, rec, alerts, status_table: statusTable, recon, sim_table: simTable };
  }

  /* ── one SIM, day by day (SIM detail page) ─────────────────── */
  // daily = { 'YYYY-MM-DD': MB } for one SIM (circles summed, Itemized report only); from..to = the days shown;
  // covered = the last day the Itemized report reaches (later days are "no data", never 0); perDay = plan ÷ 30.
  // Averages are given both ways: per calendar day (zero days included) and per day with usage.
  function simDailyStats({ daily, from, to, covered, perDay, provisionalDay }) {
    const O = RULES.ops, out = [];
    for (let d = from; d && to && d <= to; d = addDays(d, 1)) {
      if (!covered || d > covered) { out.push({ date: d, gb: null, pct: null, status: 'no_data' }); continue; }
      const gb = ((daily && daily[d]) || 0) / 1024, pct = perDay > 0 ? gb / perDay * 100 : null;
      out.push({ date: d, gb, pct, status: gb === 0 ? 'zero' : pct != null && pct >= O.high_pct ? 'high' : 'normal', provisional: d === provisionalDay });
    }
    const cov = out.filter(x => x.gb != null), act = cov.filter(x => x.gb > 0);
    const total = cov.reduce((a, x) => a + x.gb, 0);
    const max = cov.reduce((m, x) => (!m || x.gb > m.gb ? x : m), null), min = cov.reduce((m, x) => (!m || x.gb < m.gb ? x : m), null);
    // Trend: average of the last 7 covered days vs the (up to) 7 before — needs at least 10 covered days
    let trend = null;
    if (cov.length >= 10) {
      const l7 = cov.slice(-7), p7 = cov.slice(-14, -7), avg = l => l.reduce((a, x) => a + x.gb, 0) / l.length;
      const a = avg(l7), b = avg(p7), ch = b > 0 ? (a - b) / b * 100 : a > 0 ? Infinity : 0;
      trend = { last: a, prev: b, pct: ch, dir: ch >= O.trend_pct ? 'up' : ch <= -O.trend_pct ? 'down' : 'flat', prev_days: p7.length };
    }
    return { days: out, total_gb: total, covered_days: cov.length, active_days: act.length, zero_days: cov.length - act.length,
      high_days: cov.filter(x => x.status === 'high').length, avg_calendar: cov.length ? total / cov.length : null,
      avg_active: act.length ? total / act.length : null, max, min, trend, high_pct: O.high_pct, per_day: perDay };
  }
  // A SIM's allocation in any cycle (frozen record, or the cycle's SIM Group under the current rules)
  // one resolver per data version (cleared on every rebuild) — opening SIM after SIM does not redo the whole fleet
  let simResolver = null;
  function simCycleAllocation(label, iccid) {
    const resolve = simResolver || (simResolver = allocResolver({ months: state.months, frozen: state.frozen, snaps: snapshotsWith(state.snapshots, state.inventory), today: todayStr() }));
    const al = resolve(label);
    return al ? al.map.get(iccid) || null : null;
  }

  /* ── shared-pool alert: one open alert per provider; re-evaluated on every upload and open ── */
  const ALERT_CODE = 'pool_exhaustion';
  const rnd = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
  function alertDetails(pool) {
    const f = pool.forecast || {}, p = f.pace || {};
    return { pool_gb: rnd(f.pool_gb), used_gb: rnd(f.used_gb), remaining_gb: rnd(f.remaining_gb), avg_gb_day: rnd(f.avg_gb_day),
      pace_gb_sim_day: rnd(p.gb_sim_day), burn_gb_day: rnd(p.burn_gb_day), sims: p.sims_now != null ? p.sims_now : null,
      projected_gb: rnd(f.projected_gb), projected_pct: rnd(f.projected_pct), exhaustion_date: f.exhaustion_date || null, gap_days: rnd(f.gap_days),
      shortfall_gb: rnd(f.shortfall_gb), backup_gb: rnd(f.backup_gb), data_day: f.data_day || null, cycle_end: f.cycle_end || null,
      source: pool.usage_src || null, why: (f.why || []).join(',') };
  }
  // Kept on the alert besides its current figures: first (when it opened), peak (the worst so far), announced (what the
  // last pop-up said), prev (the figures of the previous data day — the "since last upload" line), seq (pop-up number)
  const META = ['first', 'peak', 'announced', 'prev', 'seq'];
  const core = d => { const o = Object.assign({}, d || {}); META.forEach(k => delete o[k]); return o; };
  // field by field — the database (jsonb) returns the keys in its own order
  const differs = (a, b) => [...new Set(Object.keys(a).concat(Object.keys(b)))].some(k => JSON.stringify(a[k] === undefined ? null : a[k]) !== JSON.stringify(b[k] === undefined ? null : b[k]));
  const brief = d => ({ data_day: d.data_day, exhaustion_date: d.exhaustion_date, backup_gb: d.backup_gb, projected_pct: d.projected_pct, remaining_gb: d.remaining_gb });
  function peakOf(old, now, level) {
    const p = Object.assign({ level }, old || {});
    if (level === 'critical') p.level = 'critical';
    if (now.backup_gb != null && (p.backup_gb == null || now.backup_gb > p.backup_gb)) p.backup_gb = now.backup_gb;
    if (now.exhaustion_date && (!p.exhaustion_date || now.exhaustion_date < p.exhaustion_date)) p.exhaustion_date = now.exhaustion_date;
    if (now.projected_pct != null && (p.projected_pct == null || now.projected_pct > p.projected_pct)) p.projected_pct = now.projected_pct;
    return p;
  }
  // A Critical alert that got much worse since its last pop-up is announced again (decided 6 Oct 2026)
  function worseThan(now, ann) {
    if (!ann) return false;
    const O = RULES.ops;
    if (now.remaining_gb != null && now.remaining_gb <= 0 && !(ann.remaining_gb <= 0)) return true;
    if (now.exhaustion_date && ann.exhaustion_date && dayDiff(now.exhaustion_date, ann.exhaustion_date) >= O.realert_days) return true;
    return !!(ann.backup_gb > 0 && now.backup_gb >= ann.backup_gb * (1 + O.realert_backup_pct / 100));
  }
  function resolveReason(old, now, level, f) {
    if (level === 'closed') return f && f.ended
      ? `The billing cycle ended (${fmtDate(f.cycle_end)}) without its final usage report — data to ${fmtDate(f.data_day)}; usage has reset.`
      : 'The billing cycle ended.';
    const bits = [];
    if (old && now && now.pool_gb - old.pool_gb > 0.5) bits.push(`the pool grew by ${r2(now.pool_gb - old.pool_gb)} GB (${r2(old.pool_gb)} → ${r2(now.pool_gb)} GB)`);
    if (old && now && old.avg_gb_day - now.avg_gb_day > 0.5) bits.push(`the daily average fell from ${r2(old.avg_gb_day)} to ${r2(now.avg_gb_day)} GB`);
    const head = bits.length ? bits.join(' and ') : 'the usage trend changed';
    return `${head.charAt(0).toUpperCase() + head.slice(1)} — now ${now ? r2(now.projected_pct) : '?'}% of the pool projected.`;
  }
  // pool = this view's pool; period = its cycle; open = the open alert (or null); now = ISO time.
  // Returns the changes to save: [{ op: 'open' | 'update' | 'resolve', alert, popup }]. A past "as of" day changes nothing.
  function evaluatePoolAlert(pool, period, open, now) {
    const ops = [];
    const lvl = pool && pool.hasPool && !pool.as_of ? pool.level : null;
    const det = lvl ? alertDetails(pool) : null;
    let cur = open && open.status === 'open' ? open : null;
    if (cur && lvl && period && cur.reporting_period && cur.reporting_period !== period) {
      const c = cycleForLabel(cur.reporting_period);
      ops.push({ op: 'resolve', alert: Object.assign({}, cur, { status: 'resolved', resolved_at: now, last_updated: now,
        resolution_reason: `The ${cur.reporting_period} billing cycle ended${c ? ` — usage reset on ${fmtDate(c.resets)}` : ''}.` }) });
      cur = null;
    }
    if (!lvl) return ops;
    const active = lvl === 'critical' || lvl === 'warning';
    if (!cur) {
      if (active) {
        const crit = lvl === 'critical';
        ops.push({ op: 'open', popup: crit, alert: { provider: 'vi', code: ALERT_CODE, reporting_period: period, level: lvl,
          status: 'open', first_detected: now, last_updated: now, escalated_at: null, resolved_at: null, resolution_reason: null,
          details: Object.assign({}, det, { first: brief(det), peak: peakOf(null, det, lvl), announced: crit ? brief(det) : null, prev: null, seq: crit ? 1 : 0 }) } });
      }
      return ops;
    }
    const old = cur.details || {};
    // the previous data day's figures (kept while the data day stays the same)
    const prev = old.data_day && det.data_day && old.data_day !== det.data_day ? brief(old) : old.prev || null;
    const meta = { first: old.first || brief(old), peak: peakOf(old.peak, det, lvl), announced: old.announced || null, prev, seq: old.seq || 0 };
    if (!active) {
      ops.push({ op: 'resolve', alert: Object.assign({}, cur, { status: 'resolved', resolved_at: now, last_updated: now, details: Object.assign({}, det, meta),
        resolution_reason: resolveReason(old, det, lvl, pool.forecast) }) });
      return ops;
    }
    const escalated = cur.level === 'warning' && lvl === 'critical';
    // an alert that was already Critical before announcements were kept: take its figures as announced, no new pop-up
    if (lvl === 'critical' && cur.level === 'critical' && !meta.announced) meta.announced = brief(det);
    const worse = lvl === 'critical' && !escalated && worseThan(det, meta.announced);
    if (escalated || worse) { meta.announced = brief(det); meta.seq += 1; }
    if (escalated || worse || cur.level !== lvl || differs(core(old), det) || differs(old.prev || {}, prev || {}))
      ops.push({ op: 'update', popup: escalated || worse, worse, alert: Object.assign({}, cur, { level: lvl, last_updated: now, details: Object.assign({}, det, meta),
        escalated_at: escalated ? now : cur.escalated_at || null }) });
    return ops;
  }
  // One evaluation of the pool, kept for the burn-rate history and the recent pace. counted = the SIMs it counted that
  // had started by its data day (count + hash) — a later upload's pace uses it only over the same SIMs (pacePoints)
  function poolSnapshotRow(ds) {
    const p = ds && ds.pool, f = p && p.forecast;
    if (!p || !p.hasPool || p.as_of || !f || !f.data_day || !ds.poolMonth) return null;
    const c = f.pace && f.pace.counted;
    return { provider: 'vi', reporting_period: ds.poolMonth, as_of: f.data_day, source: p.usage_src || 'itemized', pool_gb: rnd(f.pool_gb),
      used_gb: rnd(f.used_gb), avg_gb_day: rnd(f.avg_gb_day), projected_gb: rnd(f.projected_gb), level: p.level, counted: c ? { n: c.n, h: c.h } : null };
  }
  const snapKey = x => [x.reporting_period, x.as_of, x.source].join('|');
  // a row stored without `counted` (sql/004 not run) is not rewritten for it alone
  const sameCounted = (a, b) => !a || !b || (+a.n === +b.n && +a.h === +b.h);
  // true when the evaluation is new or changed (the projection counts: the next day's confirmation reads it).
  // `saved` marks a row stored in the cloud (rows loaded from it are; a new one is not until written).
  function addPoolSnapshot(row) {
    if (!row) return false;
    const old = state.poolSnaps.find(x => snapKey(x) === snapKey(row));
    if (old && old.used_gb === row.used_gb && old.pool_gb === row.pool_gb && old.level === row.level && old.projected_gb === row.projected_gb && sameCounted(old.counted, row.counted)) return false;
    state.poolSnaps = state.poolSnaps.filter(x => snapKey(x) !== snapKey(row)).concat(Object.assign({}, row, { saved: false }));
    return true;
  }
  const findPoolSnapshot = row => state.poolSnaps.find(x => snapKey(x) === snapKey(row)) || null;

  /* ── state + provider registration ─────────────────────────── */
  // asOf: the day the Real-time tab and the pool show ('YYYY-MM-DD'), or null = the latest data
  // snapshots: SIM Group history (each export); frozen: closed cycles' pools; pendingFreeze: frozen records not saved yet
  // poolSnaps: earlier pool evaluations; alert: the open pool alert; alertHistory: recent alerts (newest first)
  // runs: each pre-live SIM's state runs from the cloud (Map iccid → [{ state, first, last }]); wantSnaps: export times
  // whose rows a closed cycle needs (loaded on demand)
  // canLoadDaily: a cloud can provide missing per-SIM daily figures (freezes wait for them); wantDaily: those a freeze waits for
  // loadIssues: what failed to load from the cloud this session, or cannot be stored (texts, listed first among the alerts)
  const state = { inventory: null, months: {}, asOf: null, snapshots: [], frozen: {}, pendingFreeze: [], today: null, poolSnaps: [], alert: null, alertHistory: [],
    runs: null, wantSnaps: new Set(), wantDaily: new Map(), canLoadDaily: false, loadIssues: [] };
  const hasData = () => !!(state.inventory || Object.keys(state.months).length);
  const todayStr = () => state.today || localToday();
  // Freeze every closed cycle with data that has a SIM Group exported on or after its last day
  // A freeze is permanent: when the go-live days need daily figures the cloud can still provide, it waits for them
  // (state.canLoadDaily — set by the UI when a cloud is there; a cycle whose daily figures failed to load is not waited for)
  const mergeWant = (into, miss) => miss.forEach((s, l) => { if (!into.has(l)) into.set(l, new Set()); s.forEach(k => into.get(l).add(k)); });
  function autoFreeze() {
    const today = todayStr(), snaps = snapshotsWith(state.snapshots, state.inventory), out = [];
    state.wantSnaps = new Set(); state.wantDaily = new Map();
    Object.keys(state.months).forEach(label => {
      if (state.frozen[label] || state.months[label].light) return;     // a month not loaded yet waits for its rows
      const cyc = cycleForLabel(label); if (!cyc || cyc.end >= today) return;
      const snap = snaps.find(s => dayOf(s) >= cyc.end); if (!snap) return;
      if (!snap.sims) { state.wantSnaps.add(snap.as_of); return; }      // that export's rows load first
      const miss = state.canLoadDaily ? new Map() : null;
      const rec = freezeRecord(label, snap, snaps, state.months, miss);
      if (miss && miss.size) { mergeWant(state.wantDaily, miss); return; }   // freeze once those SIMs' days are here
      state.frozen[label] = rec; out.push(rec);
    });
    out.forEach(r => state.pendingFreeze.push({ rec: r, force: false }));
    return out;
  }
  // Admin: build a closed cycle again from its SIM Group under the current rules (e.g. after a rule change)
  function recomputeCycle(label) {
    const cyc = cycleForLabel(label), snaps = snapshotsWith(state.snapshots, state.inventory);
    if (!cyc || !state.months[label]) return { ok: false, reason: 'No data for ' + label };
    if (cyc.end >= todayStr()) return { ok: false, reason: `${label} is still open — it is computed live` };
    const snap = snaps.find(s => dayOf(s) >= cyc.end);
    if (!snap) return { ok: false, reason: `No SIM Group exported on or after ${fmtDate(cyc.end)} — upload one first` };
    if (!snap.sims) return { ok: false, reason: `The SIM Group of ${fmtDate(snap.as_of)} is still loading — try again in a moment`, needs: snap.as_of };
    if (state.months[label].light) return { ok: false, reason: `${label} is still loading — try again in a moment` };
    const miss = state.canLoadDaily ? new Map() : null;
    const rec = freezeRecord(label, snap, snaps, state.months, miss);
    if (miss && miss.size) return { ok: false, reason: `Loading the daily figures ${label} needs — try again in a moment`, needsDaily: [...miss].map(([l, s]) => ({ label: l, iccids: [...s] })) };
    state.frozen[label] = rec; state.pendingFreeze.push({ rec, force: true });
    rebuild();
    return { ok: true, rec };
  }
  const takePendingFreeze = () => state.pendingFreeze.splice(0);
  const buildArgs = extra => Object.assign({ inventory: state.inventory, months: state.months, fleet: window.Providers.fleet(), asOf: state.asOf,
    snapshots: state.snapshots, frozen: state.frozen, today: todayStr(), poolSnaps: state.poolSnaps, alert: state.alert, issues: state.loadIssues }, extra);
  function rebuild(opts) {
    simResolver = null;
    if (!hasData()) return null;
    autoFreeze();
    const ds = buildDataset(buildArgs());
    window.Providers.setDataset('vi', ds, opts);
    return ds;
  }
  // Keep a SIM Group export in the history (one per export time)
  function addSnapshot(inv) {
    if (!inv || !inv.as_of) return;
    state.snapshots = state.snapshots.filter(s => s.as_of !== inv.as_of).concat(inv)
      .sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)));
  }
  // parts: { summary?, itemized?, inventory? } (results of parseFile); label: month for usage files;
  // opts.until: the Itemized report's "data up to" day
  function applyUpload(parts, label, metas, opts) {
    let month = null, inventoryOlder = false, inventory = null;
    state.asOf = null;                        // new data → show the latest day
    if (parts.inventory) {
      inventory = { as_of: parts.inventory.exportedAt || new Date().toISOString().slice(0, 19).replace('T', ' '),
        source_file: parts.inventory.fileName, batch_id: metas && metas.inventory && metas.inventory.batch_id, sims: parts.inventory.rows };
      addSnapshot(inventory);
      // An export older than the current SIM Group is history only — it never replaces the newer one
      inventoryOlder = !!(state.inventory && String(inventory.as_of) < String(state.inventory.as_of));
      if (!inventoryOlder) state.inventory = inventory;
    }
    if (parts.summary || parts.itemized) {
      month = mergeMonth(state.months[label] || null, { summary: parts.summary, itemized: parts.itemized }, label, metas, opts);
      state.months[label] = month;
    }
    const before = Object.keys(state.frozen).length;
    rebuild();
    return { month, inventory: inventory || state.inventory, inventoryOlder, frozenNow: Object.keys(state.frozen).length - before };
  }
  // A cycle loaded from the cloud: the same 22nd → 21st bounds whatever dates its files covered (days saved under the
  // wrong cycle — uploads made before the 22nd rule — are flagged, not counted)
  function prepCloudMonth(m) {
    const c = cycleForLabel(m.label); if (!c) return;
    m.period_start = c.start; m.period_end = c.end;
    m.outside_days = Object.keys(m.dailyTotals || {}).filter(d => d < c.start || d > c.end).sort();
    m.last_data_date = clampToCycle(m, m.last_data_date);
    m.itemized_last = null; m.itemized_last = itemizedLast(m);    // from the saved daily totals
    // How far the Summary reaches (its latest last-session day) — decides which report the pool uses
    if (m.sources && m.sources.summary && !m.summary_asof && !m.light)
      m.summary_asof = clampToCycle(m, m.rows.filter(r => r.summary_mb != null).map(r => String(r.last_session || '').slice(0, 10)).filter(Boolean).sort().pop() || null);
  }
  // runs: Map iccid → [{ state, first, last }] (sql/004_vi_scale.sql) — SIM Group history without every row
  function setFromCloud({ inventory, months, snapshots, frozen, rules, runs }, opts) {
    if (rules) setRules(rules);
    if (inventory) state.inventory = inventory;
    if (snapshots) snapshots.forEach(addSnapshot);
    if (frozen) Object.assign(state.frozen, frozen);
    if (runs) state.runs = runs;
    if (months) { Object.values(months).forEach(prepCloudMonth); Object.assign(state.months, months); }
    if (!(opts && opts.noRebuild)) rebuild();
  }
  // Older cycles loaded in the background after start-up (their rows, daily totals) — replace the light ones
  function addMonths(months) {
    // only fills a cycle that is still a light shell (one deleted meanwhile, or already loaded, is left alone)
    Object.values(months || {}).forEach(m => { const old = state.months[m.label]; if (!old || !old.light) return; prepCloudMonth(m); state.months[m.label] = m; });
    rebuild();
  }
  // On-demand pieces from the cloud
  function addLoadedSnapshot(snap) { if (snap && snap.sims) { addSnapshot(snap); state.wantSnaps.delete(snap.as_of); } }
  function setFrozenSims(label, sims) { const fr = state.frozen[label]; if (fr && sims) { fr.sims = sims; simResolver = null; } }
  // frozen cycles whose SIM list was left out at start-up (the Month filter and the SIM page load them when shown)
  const lightFrozen = () => Object.keys(state.frozen).filter(l => state.frozen[l] && !state.frozen[l].sims);
  function setDailySims(label, bySim, iccids) {
    const m = state.months[label]; if (!m) return;
    m.dailySims = m.dailySims || {};
    (iccids || Object.keys(bySim || {})).forEach(k => { m.dailySims[k] = (bySim && bySim[k]) || null; });   // null = loaded, no usage
  }
  function setAsOfTotals(label, date, sims) { const m = state.months[label]; if (m) m.asOfTotals = { date, sims }; }
  // A billing period deleted by an admin (a wrong upload)
  // The latest view, whatever "as of" day is on screen — the shared-pool alert is always decided on it
  function latestDataset() {
    if (!hasData()) return null;
    return state.asOf ? buildDataset(buildArgs({ asOf: null })) : (window.Providers.raw('vi').hasData ? window.Providers.raw('vi') : buildDataset(buildArgs()));
  }
  function removeMonth(label) {
    delete state.months[label];
    state.poolSnaps = state.poolSnaps.filter(x => x.reporting_period !== label);   // evaluations of data that is gone
    if (state.asOf && monthLabelForDate(state.asOf) === label) state.asOf = null;
    if (hasData()) rebuild(); else window.Providers.clearDataset('vi');
  }
  // Admin: change the pool rules (e.g. whether a state counts). Open cycles follow at once; frozen ones keep theirs.
  function updateRules(patch) {
    const next = rulesConfig();
    if (patch && patch.status_rules) Object.entries(patch.status_rules).forEach(([k, v]) => { next.status_rules[String(k).trim().toLowerCase()] = !!v; });
    ['plan_days', 'pool_tag', 'cycle_start_day'].forEach(k => { if (patch && patch[k] != null) next[k] = patch[k]; });
    if (patch && patch.ops) Object.assign(next.ops, patch.ops);
    setRules(next);
    rebuild();
    return rulesConfig();
  }

  window.ViProvider = { TYPE_LABELS, DEFAULT_RULES, get CYCLE_START_DAY() { return CYCLE_START_DAY; }, get PRORATE_DAYS() { return PRORATE_DAYS; },
    allotment, allocations, goLive, eligibility, ruleFor, setRules, rulesConfig, updateRules, eligibleStates, parseCsvText, detect, parseFile, planInfo, normStatus,
    monthLabelForDate, cycleForDate, cycleForLabel, dayDiff, addDays, mergeMonth, reconcile, simTotals, simTotalsAsOf, itemizedLast,
    buildDataset, computePool, freezeRecord, latestUsage, usageSrc, summaryDay, simDailyStats, simCycleAllocation, evaluatePoolAlert, poolSnapshotRow,
    addPoolSnapshot, ALERT_CODE, localToday, cycleSnapshot, snapshotsWith, asOfOptions, state, hasData, rebuild, applyUpload, setFromCloud,
    removeMonth, recomputeCycle, takePendingFreeze, cleanIccid, exportedAtFromName, fmtDate, simPace, liveIndex, latestDataset, backupFor, findPoolSnapshot,
    stateHistory, addMonths, addLoadedSnapshot, setFrozenSims, setDailySims, setAsOfTotals, lightFrozen };

  window.Providers.register({
    code: 'vi', name: 'VI (Vodafone Idea)', short: 'VI', color: '#d95926', order: 2,
    zeroAllocFlag: 'NO DATA',                  // Ready / no-bundle SIMs are inventory, not wasted data
    // Universal SIM search: the newest SIM Group's SIMs exactly as VI reports them (VI's own uploads write the common
    // SIM table), plus SIMs VI's usage reports list that the SIM Group does not — with no status: VI gave none
    directory() {
      const out = [], seen = new Set(), inv = state.inventory;
      (inv ? inv.sims : []).forEach(s => {
        if (!s.iccid || seen.has(s.iccid)) return; seen.add(s.iccid);
        out.push({ iccid: s.iccid, msisdn: s.msisdn || null, imsi: s.imsi || null, circle: s.circle || null, lifecycle_state: s.lifecycle_state || null,
          status: s.status || null, plan_name: s.deal_name || null, plan_gb: s.plan_gb || null, plan_price: s.plan_price == null ? null : s.plan_price,
          pooled: !!s.pooled, activated_at: s.activated_at || null, as_of: inv.as_of || null });
      });
      Object.values(state.months).forEach(m => (m.rows || []).forEach(r => {
        if (!r.iccid || seen.has(r.iccid)) return; seen.add(r.iccid);
        out.push({ iccid: r.iccid, msisdn: r.msisdn || null, imsi: r.imsi || null, circle: r.circle || null, lifecycle_state: null, status: null,
          note: `In VI's usage reports (${m.label}) but not in the SIM Group file` });
      }));
      return out;
    },
    poolStates: () => eligibleStates(),
    poolAssumption: 'Which SIM states count is a rule an admin can change in the SIM status table (only "active" by default — Ready, Dunning and suspend do not count).',
    get prorateRule() { return `a SIM that starts during the cycle adds its plan ÷ ${PRORATE_DAYS} for each day left in the cycle, start day included, up to the full plan (85 GB ÷ ${PRORATE_DAYS} = ${(85 / PRORATE_DAYS).toFixed(2)} GB a day)`; },
    poolRule: 'every VI SIM on a data-pool deal (_DP_) whose state counts — each adds its plan allowance (e.g. 85 GB) to one shared account pool, and any SIM can use any part of it (10 SIMs × 85 GB = 850 GB)',
    sources: Object.keys(TYPE_LABELS),
    typeLabels: TYPE_LABELS,
    storage: { sims: 'provider_sims', monthly: 'provider_sim_usage_monthly', daily: 'provider_sim_usage_daily', batches: 'upload_batches',
      snapshots: 'provider_sim_snapshots', cyclePool: 'provider_cycle_pool' },
    cycleStartDay: CYCLE_START_DAY,
    cycle: `months are billing cycles (${nth(CYCLE_START_DAY)} → ${nth(CYCLE_START_DAY - 1)}, usage resets on the ${nth(CYCLE_START_DAY)}), labelled with the month they end in (22 Aug – 21 Sep = Sep)`,
    simSource: 'SIM Group + Itemized report (real-time)',
    // shown when no Itemized report is loaded: the real-time tab and the pool need it
    rtEmpty: 'Upload the VI Itemized report (SELFCARE_USAGE_ITEMIZED) in Real-time mode to see allocated, used and remaining data for every SIM, day by day.',
    invEmpty: 'Upload the VI SIM Group file (SIMGROUP*.csv) — the pool is built from it: each SIM\'s status, plan and activation date. Usage alone cannot size the pool.',
    usageEmpty: 'Upload a VI usage report — the Data Usage Summary (Monthly mode) or the Itemized report (Real-time mode). The pool\'s used data comes from whichever reaches later.',
    tiers: () => tiersFrom(state.inventory),
    price: row => planInfo(row.deal_name || row.plan).price,
    rates() {
      const seen = new Map();
      (state.inventory ? state.inventory.sims : []).forEach(x => {
        const pi = planInfo(x.deal_name, x.base_plan_name);
        if (pi.plan_gb > 0 && pi.price != null && !seen.has(pi.label)) seen.set(pi.label, { gb: pi.plan_gb, price: pi.price, label: pi.label });
      });
      return [...seen.values()].sort((a, b) => a.gb - b.gb);
    },
    // Month filter = month-wise (Summary) data only. Real-time rows and the pool keep their own day, as for Airtel.
    forMonth: (ds, label) => (ds.months || []).includes(label)
      ? buildDataset(buildArgs({ month: label }))
      : Object.assign({}, ds, { CD: { vehicles: [], stats: window.buildStats([]), clients: [], plan_summary: [] }, trData: [], currentMonth: null, cycle: null }),
  });
  window.Providers.onFleetChange(() => rebuild({ silent: true }));
})();
