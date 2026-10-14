/* ============================================================
   providers/registry.js — multi-provider core
   ------------------------------------------------------------
   One dashboard, many telecom providers.

     PROVIDERS  config per provider: plans, prices, tiers, statuses,
                pools, month rules, upload sources
     store      one dataset per provider  { CD, trData, rtRows, … }
     view       the provider selection (All / one provider) turned
                into a single dataset and handed to the existing
                renderers through applyProviderView() in index.html

   Adding a provider = register() a config (+ a parser module).
   The renderers, filters and exports need no changes.

   Airtel regression guarantee: when the view contains only Airtel
   data and nothing is moved to another provider, the exact same CD
   object is rendered — every legacy Airtel formula runs unchanged.
   ============================================================ */
(function () {
  'use strict';

  const VIEW_KEY = 'dbai_provider_view';
  const P = {};              // configs by code
  const store = {};          // datasets by code
  const PLAN_LABELS = {};    // plan string → display label (registered by provider modules)
  let selected = 'all';
  let selectedMonth = 'latest';
  let fleetCache = { src: null, list: [] };
  const listeners = { fleet: [], month: [], data: [] };

  try { const v = localStorage.getItem(VIEW_KEY); if (v) selected = v; } catch (e) {}

  /* ── registry ─────────────────────────────────────────────── */
  function register(cfg) {
    if (!cfg || !cfg.code || !cfg.name) throw new Error('Provider config needs code and name');
    const code = String(cfg.code).toLowerCase();
    P[code] = Object.assign({ status: 'active', order: 100, color: '#94a3b8', short: cfg.name,
      zeroAllocFlag: 'WASTED', fallbackForUnmatched: false, sources: [] }, cfg, { code });
    if (!store[code]) store[code] = emptyDataset();
    if (booted) refresh();
    return P[code];
  }
  function emptyStats() { return { total: 0, with_plan: 0, no_usage: 0, no_sim: 0, at_100: 0, critical: 0, warning: 0 }; }
  function emptyDataset() {
    return { CD: { vehicles: [], stats: emptyStats(), clients: [], plan_summary: [] },
      trData: [], rtRows: [], uploaded: false, hasData: false, months: [], simKeys: new Set() };
  }
  const get = code => P[code] || null;
  const list = () => Object.values(P).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const activeList = () => list().filter(p => p.status === 'active');
  const shortName = code => (P[code] && P[code].short) || code || '—';
  // The provider that owns the legacy upload modes / tables and unclaimed fleet vehicles (Airtel)
  const legacyCode = () => ((Object.values(P).find(p => p.legacyUpload) || {}).code) || 'airtel';

  /* ── selection ────────────────────────────────────────────── */
  function viewCodes() {
    if (selected !== 'all' && P[selected] && P[selected].status === 'active') return [selected];
    return activeList().map(p => p.code);
  }
  const isAllSelected = () => viewCodes().length > 1 || selected === 'all';
  const withData = codes => codes.filter(c => store[c] && store[c].hasData);
  // More than one provider actually contributes rows → show badges / Provider column
  const isMulti = () => withData(viewCodes()).length > 1;
  function select(code) {
    if (code !== 'all' && (!P[code] || P[code].status !== 'active')) return false;
    selected = code;
    try { localStorage.setItem(VIEW_KEY, code); } catch (e) {}
    // A month that the new view doesn't have makes no sense — fall back to latest
    if (selectedMonth !== 'latest' && !monthsInView().includes(selectedMonth)) selectedMonth = 'latest';
    refresh();
    return true;
  }
  function selectMonth(label) {
    selectedMonth = label && label !== 'latest' ? label : 'latest';
    listeners.month.forEach(fn => { try { fn(selectedMonth); } catch (e) { console.error('[providers] month listener', e); } });
    refresh();
  }
  function onMonthChange(fn) { listeners.month.push(fn); }

  /* ── SIM identifiers ──────────────────────────────────────── */
  // Same rule for every provider: strip spaces, apostrophes, the VI "~" text prefix, '+', trailing F/U padding
  function normKey(s) {
    return String(s == null ? '' : s).replace(/[\s'~+]/g, '').replace(/[UFf]+$/, '');
  }
  function isNoUsageRow(v) {
    if (typeof window.isNoUsage === 'function') return window.isNoUsage(v);
    const sim = String(v.sim_no || '').trim();
    return sim !== '' && sim !== 'nan' && !v.plan;
  }
  // SIM keys claimed by every provider except `code`
  function claimedByOthers(code) {
    const s = new Set();
    Object.keys(store).forEach(c => {
      if (c === code || !store[c].simKeys) return;
      store[c].simKeys.forEach(k => s.add(k));
    });
    return s;
  }

  /* ── fleet (vehicle master) — provider-independent ─────────── */
  // The vehicle master arrives through the legacy Airtel flows (vehicles file / vehicle_master
  // table / built-in data). Every provider maps its SIMs onto the same fleet.
  function fleet() {
    const src = store.airtel && store.airtel.CD;
    if (fleetCache.src !== src) {
      const vs = (src && src.vehicles) || [];
      fleetCache = { src, list: vs.map(v => ({ reg: v.reg, client: v.client, hw_id: v.hw_id,
        device_id: v.device_id, status: v.status, sim: v.sim_no })) };
    }
    return fleetCache.list;
  }
  function onFleetChange(fn) { listeners.fleet.push(fn); }
  // A provider's data changed (upload, cloud load, deleted period) — e.g. the SIM search keeps its index in step
  function onDataChange(fn) { listeners.data.push(fn); }
  const dataChanged = code => listeners.data.forEach(fn => { try { fn(code); } catch (e) { console.error('[providers] data listener', e); } });
  // A provider's start-up load has finished (Airtel: index.html cloudAutoLoad) — before that its data may be half loaded
  const ready = new Set();
  function setReady(code) { ready.add(code); dataChanged(code); }
  const isReady = code => ready.has(code);

  /* ── ingest ───────────────────────────────────────────────── */
  function monthLabelsOf(trData) {
    const s = new Set();
    (trData || []).forEach(v => (v.months || []).forEach(m => m.label && s.add(m.label)));
    return sortMonths([...s]);
  }
  function airtelKeys(ds) {
    const k = new Set();
    (ds.CD.vehicles || []).forEach(v => { if (v.plan && v.sim_no) k.add(normKey(v.sim_no)); });
    (ds.rtRows || []).forEach(r => { if (r.sim_no) k.add(normKey(r.sim_no)); });
    return k;
  }
  // Called by index.html loadData() for every legacy (Airtel) dataset
  function ingestAirtel(data, uploaded, tr) {
    const ds = store.airtel || (store.airtel = emptyDataset());
    (data.vehicles || []).forEach(v => { if (!v.provider) v.provider = 'airtel'; });
    (tr || []).forEach(v => { if (!v.provider) v.provider = 'airtel'; });
    const fleetChanged = ds.CD !== data;
    ds.CD = data; ds.trData = tr || []; ds.uploaded = !!uploaded; ds.hasData = true;
    ds.months = monthLabelsOf(ds.trData);
    ds.simKeys = airtelKeys(ds);
    if (fleetChanged) listeners.fleet.forEach(fn => { try { fn(); } catch (e) { console.error('[providers] fleet listener', e); } });
    refresh();
    dataChanged('airtel');
  }
  // Called by the legacy real-time flows (upload / saved snapshot). meta.latest === false: an older saved snapshot
  // picked on the Real-time tab — shown, but not Airtel's current SIM list
  function ingestAirtelRt(rows, meta) {
    const ds = store.airtel || (store.airtel = emptyDataset());
    (rows || []).forEach(r => { if (!r.provider) r.provider = 'airtel'; });
    ds.rtRows = rows || []; ds.hasData = true; ds.rtLatest = !(meta && meta.latest === false);
    ds.simKeys = airtelKeys(ds);
    refresh();
    dataChanged('airtel');
  }
  // Generic entry point for registry-driven providers (VI, and later Jio …)
  function setDataset(code, ds, opts) {
    store[code] = Object.assign(emptyDataset(), ds, { hasData: true });
    if (!(opts && opts.silent)) refresh();
    dataChanged(code);
  }
  // The provider has no data left (e.g. its last billing period was deleted)
  function clearDataset(code) { store[code] = emptyDataset(); refresh(); dataChanged(code); }
  const raw = code => store[code] || emptyDataset();

  /* ── months ───────────────────────────────────────────────── */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function monthKey(label) {
    const m = String(label).match(/(\w{3})\s+(\d{4})/);
    return m ? parseInt(m[2], 10) * 12 + MONTHS.indexOf(m[1]) : 0;
  }
  const sortMonths = labels => labels.slice().sort((a, b) => monthKey(a) - monthKey(b));
  function monthsInView() {
    const s = new Set();
    viewCodes().forEach(c => (store[c] && store[c].months || []).forEach(m => s.add(m)));
    return sortMonths([...s]);
  }

  /* ── view ─────────────────────────────────────────────────── */
  let booted = false;
  function providerVehicles(code, ds) {
    let vs = ds.CD.vehicles || [];
    if (P[code] && P[code].fallbackForUnmatched) {
      // Vehicles with no usage here whose SIM another provider claims belong to that provider
      const others = claimedByOthers(code);
      if (others.size) vs = vs.filter(v => !(isNoUsageRow(v) && others.has(normKey(v.sim_no))));
    }
    return vs;
  }
  function buildView() {
    const codes = withData(viewCodes());
    const parts = codes.map(c => {
      let ds = store[c];
      if (selectedMonth !== 'latest' && P[c] && typeof P[c].forMonth === 'function') ds = P[c].forMonth(ds, selectedMonth) || ds;
      return { c, ds, vehicles: providerVehicles(c, ds) };
    });
    const uploaded = parts.some(p => p.ds.uploaded);
    // Single provider, nothing moved out → render its own CD object untouched (legacy path)
    if (parts.length === 1 && parts[0].vehicles === parts[0].ds.CD.vehicles) {
      const p = parts[0];
      return { CD: p.ds.CD, trData: p.ds.trData || [], rtRows: p.ds.rtRows || [], uploaded, codes, parts };
    }
    const vehicles = [].concat(...parts.map(p => p.vehicles));
    const clients = [...new Set(vehicles.map(v => v.client).filter(c => c && c !== 'nan'))].sort();
    const stats = typeof window.buildStats === 'function' ? window.buildStats(vehicles) : emptyStats();
    return { CD: { vehicles, stats, clients, plan_summary: [] },
      trData: [].concat(...parts.map(p => p.ds.trData || [])),
      rtRows: [].concat(...parts.map(p => p.ds.rtRows || [])),
      uploaded, codes, parts };
  }
  let lastView = null;
  function refresh() {
    booted = true;
    if (typeof window.applyProviderView !== 'function') return;
    lastView = buildView();
    window.applyProviderView(lastView);
    if (window.ProvidersUI) window.ProvidersUI.render(lastView);
  }

  /* ── helpers used by the renderers ────────────────────────── */
  // TIERS / PLAN_PRICES are top-level `const`s in index.html: shared global bindings, not window properties
  const legacyTiers = () => (typeof TIERS !== 'undefined' ? TIERS : []);                 // eslint-disable-line no-undef
  const legacyPrices = () => (typeof PLAN_PRICES !== 'undefined' ? PLAN_PRICES : {});   // eslint-disable-line no-undef
  const cfgOf = row => P[(row && row.provider) || 'airtel'] || P.airtel;
  function tiers(code) { const c = P[code || 'airtel']; return c && c.tiers ? c.tiers() : legacyTiers(); }
  function priceFor(row) {
    const c = cfgOf(row);
    return c && c.price ? c.price(row) : (typeof window.extractPrice === 'function' ? window.extractPrice(row.plan) : null);
  }
  function rates() {
    const out = [];
    withData(viewCodes()).forEach(code => {
      const c = P[code];
      if (c && c.rates) c.rates().forEach(r => out.push(Object.assign({ provider: code }, r)));
    });
    return out;
  }
  const zeroAllocFlag = code => (P[code || 'airtel'] || {}).zeroAllocFlag || 'WASTED';
  function badge(row) {
    if (!isMulti() || !row) return '';
    const c = P[row.provider || 'airtel'];
    if (!c) return '';
    return `<span class="prov-badge" style="--pc:${c.color}" title="${c.name}">${c.short}</span>`;
  }
  function searchHit(row, q) {
    if (!q || !row) return false;
    const c = P[row.provider || 'airtel'];
    if (c && (c.code.includes(q) || String(c.short).toLowerCase().includes(q) || String(c.name).toLowerCase().includes(q))) return true;
    return ['iccid', 'msisdn', 'imsi'].some(k => row[k] && String(row[k]).includes(q));
  }
  // Exports: Provider column only when rows really come from several providers
  function exportPack(headers, rows, mapRow, simIdx) {
    if (!isMulti()) return { headers, rows: rows.map(mapRow), sim: simIdx };
    return { headers: ['Provider', ...headers],
      rows: rows.map(r => [shortName(r.provider || 'airtel'), ...mapRow(r)]),
      sim: simIdx.map(i => i + 1) };
  }
  function exportName(base, ext) {
    const codes = viewCodes();
    let suffix = '';
    if (codes.length > 1) suffix = isMulti() ? '_all-providers' : '';
    else if (codes[0] !== 'airtel') suffix = '_' + codes[0];
    const m = selectedMonth !== 'latest' ? '_' + selectedMonth.replace(/\s+/g, '-') : '';
    return base + suffix + m + '.' + ext;
  }
  // The day a provider's real-time figures are "as of" when it isn't the latest (VI day picker), else null
  const rtAsOf = () => ((lastView && lastView.parts) || []).map(p => p.ds.asOf).filter(Boolean)[0] || null;
  const rtExportTag = () => { const d = rtAsOf(); return d ? '_as-of-' + d : ''; };
  // The period each provider's real-time rows cover (14 Oct 2026). A provider's rtTitle hook names an older, historical
  // report (VI: an Itemized cycle before the pool's current one); without one the rows are its current figures.
  function rtPeriods(view) {
    const v = view || lastView;
    return ((v && v.parts) || []).filter(p => (p.ds.rtRows || []).length).map(p => {
      const cfg = P[p.c] || {}, ui = cfg.ui || {};
      const title = typeof ui.rtTitle === 'function' ? ui.rtTitle(p.ds) || null : null;
      const it = p.ds.context && p.ds.context.itemized;
      return { code: p.c, short: cfg.short || p.c, historical: !!title, title,
        period: it && it.label ? `${it.label} cycle${title ? ' (historical)' : ''}` : p.ds.rtLatest === false ? 'older saved snapshot' : 'latest snapshot' };
    });
  }
  function statusOptions() {
    const s = new Set();
    const v = lastView;
    if (v) { v.CD.vehicles.forEach(x => x.sim_status && s.add(x.sim_status)); v.rtRows.forEach(x => x.sim_status && s.add(x.sim_status)); }
    return [...s].filter(x => x && x !== 'N/A').sort();
  }
  function registerPlanLabel(plan, label) { if (plan) PLAN_LABELS[plan] = label; }
  const planLabel = plan => PLAN_LABELS[plan] || null;
  const currentView = () => lastView;

  window.Providers = {
    register, get, list, activeList, shortName, legacyCode,
    selected: () => selected, select, viewCodes, isAllSelected, isMulti, inView: c => viewCodes().includes(c),
    selectedMonth: () => selectedMonth, selectMonth, onMonthChange, monthsInView, monthKey, sortMonths,
    normKey, fleet, onFleetChange, onDataChange, setReady, isReady,
    ingestAirtel, ingestAirtelRt, setDataset, clearDataset, raw, refresh, buildView, currentView,
    tiers, priceFor, rates, zeroAllocFlag, badge, searchHit, exportPack, exportName, rtAsOf, rtExportTag, rtPeriods, statusOptions,
    registerPlanLabel, planLabel, claimedByOthers, emptyDataset,
  };

  /* ── built-in provider configs ────────────────────────────── */
  // Identity colours = validated categorical slots (dark steps), assigned in registry order and
  // never reused for status: 1 blue · 2 orange · 3 aqua. Always shown with the provider's name.
  // Airtel keeps every legacy rule; the functions point at the dashboard's own globals.
  register({
    code: 'airtel', name: 'Airtel', short: 'Airtel', color: '#3987e5', order: 1,
    fallbackForUnmatched: true,                 // fleet vehicles no provider claims stay here (legacy behaviour)
    legacyUpload: true,                         // uses the existing upload modes and tables
    legacyStatuses: ['Active', 'Available', 'Safe Custody', 'DISCONNECTED'],   // the status filter's original options
    zeroAllocFlag: 'WASTED',                    // legacy real-time rule, unchanged
    storage: { monthly: 'monthly_snapshots', realtime: 'realtime_snapshots', fleet: 'vehicle_master' },
    simSource: 'latest real-time portal snapshot',
    sources: ['airtel_monthly', 'airtel_multi_month', 'airtel_realtime', 'airtel_vehicles'],
    typeLabels: { airtel_monthly: 'Monthly usage', airtel_multi_month: 'Multi-month usage', airtel_realtime: 'Real-time portal', airtel_vehicles: 'Vehicles file (fleet)' },
    // ── universal SIM search ──
    // Airtel's SIMs = the SIMs its own reports list: the real-time portal export (every SIM on the account, plan,
    // mobile number) and the monthly files (SIM STATUS). The fleet's other SIMs are not Airtel's to claim. The status is
    // exactly the monthly file's; the portal export has no status column, so a SIM listed only there has none.
    // forSync: only this account's own data — never the page's built-in sample (opts.forSync, written to the cloud)
    directory(opts) {
      const ds = store.airtel; if (!ds || !ds.hasData) return [];
      const own = !(opts && opts.forSync) || ds.uploaded;
      const map = new Map();
      const add = (sim, f) => {
        const k = normKey(sim); if (!/^\d{10,22}$/.test(k)) return;          // ICCID-shaped only (no Excel-mangled numbers)
        const r = map.get(k) || { iccid: String(sim).trim(), seen_in: [] };       // the number as Airtel's files have it
        Object.keys(f).forEach(x => { if (f[x] != null && f[x] !== '' && (r[x] == null || x === 'lifecycle_state')) r[x] = f[x]; });
        map.set(k, r); return r;
      };
      (ds.rtRows || []).forEach(r => { if ((r.provider || 'airtel') !== 'airtel') return;
        const x = add(r.sim_no, { plan_name: r.plan || null, plan_gb: r.plan_gb || null, msisdn: r.msisdn || null });
        if (x && !x.seen_in.includes('portal')) x.seen_in.push('portal'); });
      if (own) (ds.CD.vehicles || []).forEach(v => {
        if ((v.provider || 'airtel') !== 'airtel' || !v.sim_no) return;
        const st = v.sim_status && v.sim_status !== 'N/A' ? v.sim_status : null;
        if (!v.plan && !st) return;                                             // not in Airtel's monthly file
        const x = add(v.sim_no, { lifecycle_state: st, plan_name: v.plan || null, plan_gb: v.plan_gb || null });
        if (x && !x.seen_in.includes(ds.uploaded ? 'monthly' : 'built-in')) x.seen_in.push(ds.uploaded ? 'monthly' : 'built-in');
      });
      return [...map.values()].map(r => Object.assign(r, { status: r.lifecycle_state || null }));
    },
    // Airtel's uploads keep its SIMs in the legacy tables, not in provider_sims: an Admin's dashboard writes them there
    // (the search's common SIM table) — only once Airtel's start-up load has finished, only from this account's own
    // data (never the page's built-in sample) and never while an older real-time snapshot is on screen
    directorySync() { const ds = store.airtel; return !!(ready.has('airtel') && ds && ds.hasData && ds.uploaded && ds.rtLatest !== false); },
    ui: {
      // Airtel's part of the search result: this month's usage against the SIM's own plan, the real-time portal figures,
      // and its vehicle analysis (per vehicle — index.html openVSum, whatever provider view is on screen)
      searchCard(rec) {
        const ds = store.airtel || emptyDataset(), k = normKey(rec.iccid);
        const v = (ds.CD.vehicles || []).find(x => x.sim_no && normKey(x.sim_no) === k && (x.plan || (x.sim_status && x.sim_status !== 'N/A')));
        const rt = (ds.rtRows || []).find(x => x.sim_no && normKey(x.sim_no) === k);
        const rows = [];
        if (v) rows.push(['Monthly usage', v.plan_gb ? `${v.used_gb} GB of ${v.plan_gb} GB (${v.usage_pct}%)` : `${v.used_gb} GB · no plan`]);
        if (v && v.flag) rows.push(['Data status', `${v.flag} — this SIM's own plan`]);
        if (rt) rows.push(['Real-time portal', `${rt.used_gb} GB used of ${rt.alloc_gb} GB · ${rt.avail_gb} GB left (${rt.used_pct}%)`]);
        if (!v && !rt) rows.push(['Usage', 'Not in the Airtel data loaded in this dashboard']);
        return { rows, notes: [], open: v && v.reg ? () => window.openVSum(v.reg, 'airtel') : null, openLabel: 'Open Airtel vehicle analysis',
          noOpen: 'This SIM is not on a vehicle — the Airtel analysis is per vehicle.' };
      },
    },
    tiers: () => legacyTiers(),
    price: row => window.extractPrice(row.plan),
    rates: () => Object.entries(legacyPrices()).map(([gb, price]) => ({ gb: +gb, price, label: gb + 'GB Plan' })),
    // Month filter: rebuild each vehicle's current-period fields from its stored month (mergeToVehicles rule)
    forMonth(ds, label) {
      const byReg = {};
      (ds.trData || []).forEach(v => { const m = (v.months || []).find(x => x.label === label); if (m) byReg[v.reg] = m; });
      if (!Object.keys(byReg).length) return Object.assign({}, ds, { CD: { vehicles: [], stats: emptyStats(), clients: [], plan_summary: [] }, trData: [] });
      const vehicles = ds.CD.vehicles.map(v => {
        const m = byReg[v.reg];
        if (!m) return Object.assign({}, v, { plan: '', plan_gb: 0, plan_mb: 0, used_mb: 0, used_gb: 0, usage_pct: 0, flag: 'NO DATA', suggested_gb: null, saving_pct: null, needed_gb: 0 });
        const plan = m.plan || v.plan, plan_gb = m.plan_gb || window.extractGB(plan), plan_mb = plan_gb * 1024;
        const used_mb = m.used_mb || 0, usage_pct = plan_mb > 0 ? Math.round(used_mb / plan_mb * 1000) / 10 : 0;
        const needed = Math.round(used_mb / 1024 * 1.2 * 100) / 100;
        const suggested_gb = (v.sim_status === 'Active' && plan_gb > 0 && used_mb > 0) ? legacyTiers().find(t => t >= needed && t < plan_gb) || null : null;
        return Object.assign({}, v, { plan, plan_gb, plan_mb, used_mb, used_gb: Math.round(used_mb / 1024 * 100) / 100,
          usage_pct, flag: window.getFlag(usage_pct), needed_gb: needed, suggested_gb,
          saving_pct: suggested_gb ? Math.round((1 - suggested_gb / plan_gb) * 100) : null });
      });
      return Object.assign({}, ds, { CD: { vehicles, stats: window.buildStats(vehicles), clients: ds.CD.clients, plan_summary: [] } });
    },
  });

  // Jio: registered so the architecture, selector and tables already know it — no parser yet.
  register({ code: 'jio', name: 'Jio', short: 'Jio', color: '#199e70', order: 3, status: 'planned', sources: [] });
})();
