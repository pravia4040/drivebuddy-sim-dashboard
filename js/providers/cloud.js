/* ============================================================
   providers/cloud.js — Supabase persistence for registry-driven
   providers (VI now, Jio later). Tables: sql/001_multi_provider.sql
   ------------------------------------------------------------
   • probe()           are the provider tables there? (else session-only)
   • sha256()          file fingerprint for the duplicate-upload guard
   • findBatch()       has this exact file been ingested before?
   • recordBatch()     upload history row (any provider, incl. Airtel)
   • savePeriod()      atomic replace of one provider billing period
   • deletePeriod()    remove a wrong period; its files may be uploaded again
   • saveInventory()   atomic replace of a provider's SIM inventory
   • loadProvider()    periods + usage + daily totals + inventory, paginated
   • loadPeriodDaily() one period's per-SIM daily usage, on demand ("as of" day)
   sql/002_vi_pool.sql (optional — without it the app works, but nothing below is kept):
   • saveSnapshot()    keep a SIM Group export (SIM state history)
   • saveCyclePool()   keep a closed cycle's frozen pool
   • loadPoolHistory() recent SIM Group exports + frozen pools
   • loadRules() / saveRules()   pool rules in providers.config.pool_rules
   sql/003_vi_operations.sql (optional — without it alerts and pool history last for the session):
   • loadOps()         recent pool evaluations + alert history
   • savePoolSnapshot() one pool evaluation (burn-rate history, recent pace)
   • saveAlert()       open / update / resolve the shared-pool alert
   • loadSimHistory()  one SIM's daily usage across every stored cycle (SIM detail page)
   • deletePoolSnapshots() a deleted cycle's pool evaluations
   sql/004_vi_scale.sql (optional — any fleet size; without it the 001–003 paths are used):
   • savePeriod()      Itemized days a few at a time (only new days), monthly rows staged + swapped in one call
   • loadPoolHistory() export list + each pre-live SIM's state runs + frozen pools without SIM lists
   • loadSnapshot() / loadFrozenSims()  those pieces on demand · loadTotalsAsOf() per-SIM totals to a day
   • loadProvider({ recent }) newest cycles first; loadPeriods() the rest in the background
   All take the provider code — any provider on the common SIM-level
   model (VI now, Jio later) uses the same tables and functions.
   Airtel keeps its legacy tables and code paths — nothing here
   touches monthly_snapshots / realtime_snapshots / vehicle_master.
   ============================================================ */
(function () {
  'use strict';

  const T = { batches: 'upload_batches', periods: 'provider_periods', sims: 'provider_sims',
    monthly: 'provider_sim_usage_monthly', daily: 'provider_sim_usage_daily', dailyTotals: 'provider_daily_totals',
    snapshots: 'provider_sim_snapshots', cyclePool: 'provider_cycle_pool', providers: 'providers',
    poolSnaps: 'provider_pool_snapshots', alerts: 'provider_alerts' };
  const POOL_COLS = ['cycle_start', 'cycle_end', 'snapshot_at', 'total_sims', 'eligible_sims', 'non_eligible_sims', 'full_gb', 'prorated_gb',
    'pool_gb', 'used_gb', 'remaining_gb', 'utilisation_pct', 'data_until', 'new_activations', 'new_activation_gb', 'status_counts', 'rules', 'sims', 'frozen'];
  const BATCH_COLS = ['id', 'provider', 'source_type', 'source_file', 'file_hash', 'reporting_period', 'period_start',
    'period_end', 'total_rows', 'valid_rows', 'duplicate_rows', 'invalid_rows', 'total_mb', 'status', 'details'];
  const st = { ready: null, reason: 'Not checked yet', session: [], cloudHistory: [] };
  const client = () => window.sb || null;
  const isMissing = e => /42P01|42883|PGRST20[0-9]|does not exist|Could not find the (table|function)|schema cache/i
    .test(((e && e.message) || '') + ' ' + ((e && e.code) || ''));
  const nz = v => (v === '' || v === undefined ? null : v);
  const ts = s => (s ? String(s).replace('T', ' ').replace(/(\.\d+)?([+-]\d\d:?\d\d|Z)?$/, '').slice(0, 19) : '');
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }

  async function probe() {
    const sb = client();
    if (!sb) { st.ready = false; st.reason = 'Supabase client not available'; return false; }
    try {
      const { error } = await sb.from(T.batches).select('id').limit(1);
      if (error) {
        st.ready = false;
        st.reason = isMissing(error) ? 'Provider tables not found — run sql/001_multi_provider.sql in Supabase to save provider data'
          : 'Cloud error: ' + error.message;
        return false;
      }
      st.ready = true; st.reason = '';
      return true;
    } catch (e) { st.ready = false; st.reason = 'Cloud unreachable: ' + e.message; return false; }
  }

  // PostgREST returns at most max_rows (1000 by default) per request — page through with range(). The first page
  // sets the real page size (a server with a lower max_rows must not end the load early); stop on an empty page.
  async function selectAll(make, size = 1000) {
    const out = [];
    let page = null;
    for (let from = 0; ; from += page || size) {
      const { data, error } = await make().range(from, from + (page || size) - 1);
      if (error) throw error;
      const n = (data || []).length;
      out.push(...(data || []));
      if (page === null) page = n || size;
      if (!n || n < page) break;
    }
    return out;
  }
  // Large reads: the row count first, then several pages at a time (a cycle of a big fleet is hundreds of pages)
  async function fetchAll({ table, cols, where, order, parallel = 6 }) {
    const q = opt => { let x = client().from(table).select(cols, opt); x = where ? where(x) : x; (order || []).forEach(c => { x = x.order(c); }); return x; };
    const first = await q({ count: 'exact' }).range(0, 999);
    if (first.error) throw first.error;
    const out = [...(first.data || [])], page = (first.data || []).length;
    if (!page) return out;
    if (first.count == null) return selectAll(() => q());       // no row count from the server: one page after another
    const starts = []; for (let from = page; from < first.count; from += page) starts.push(from);
    for (let i = 0; i < starts.length; i += parallel) {
      const res = await Promise.all(starts.slice(i, i + parallel).map(f => q().range(f, f + page - 1)));
      for (const r of res) { if (r.error) throw r.error; out.push(...(r.data || [])); }
    }
    return out;
  }
  // A set-returning function, paged the same way
  async function rpcAll(name, args) {
    const head = client().rpc(name, args);
    if (typeof head.range !== 'function') { const r = await head; if (r.error) throw r.error; return r.data || []; }   // the local mock
    return selectAll(() => client().rpc(name, args));
  }

  async function sha256(text) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {                       // non-secure context (file://): FNV-1a pair, for duplicate detection only
      let a = 0x811c9dc5, b = 0x01000193;
      for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 16777619) >>> 0; b = Math.imul(b ^ c, 2246822519) >>> 0; }
      return 'fnv' + a.toString(16) + b.toString(16) + text.length.toString(16);
    }
  }

  async function findBatch(provider, sourceType, hash) {
    const s = st.session.find(b => b.provider === provider && b.source_type === sourceType && b.file_hash === hash && b.status === 'success');
    if (s) return s;
    if (!st.ready) return null;
    const { data, error } = await client().from(T.batches).select('id,uploaded_at,uploaded_by,reporting_period,source_file')
      .eq('provider', provider).eq('source_type', sourceType).eq('file_hash', hash).eq('status', 'success').limit(1);
    if (error) { console.warn('[provider-cloud] duplicate lookup failed:', error.message); return null; }
    return (data && data[0]) || null;
  }

  async function recordBatch(b) {
    const rec = Object.assign({ id: uuid(), status: 'success' }, b, { uploaded_at: new Date().toISOString(), saved: false });
    st.session.unshift(rec);
    if (!st.ready) return rec;
    const row = {}; BATCH_COLS.forEach(k => { if (rec[k] !== undefined) row[k] = rec[k]; });
    const { error } = await client().from(T.batches).insert(row);
    if (error) rec.cloud_error = error.message; else rec.saved = true;
    return rec;
  }
  async function markBatches(ids, status, detail) {
    st.session.forEach(r => { if (ids.includes(r.id)) { r.status = status; r.details = Object.assign({}, r.details, detail); } });
    if (!st.ready || !ids.length) return;
    const { error } = await client().from(T.batches).update({ status }).in('id', ids);
    if (error) console.warn('[provider-cloud] could not mark batches', status, error.message);
  }

  async function savePeriod(provider, month, parts, onProgress) {
    if (!st.ready) return { saved: false, reason: st.reason };
    const useSummary = !!(month.sources && month.sources.summary);
    const monthly = month.rows.map(r => ({ iccid: r.iccid, circle: r.circle || '', msisdn: nz(r.msisdn), imsi: nz(r.imsi),
      origin_circle: nz(r.origin), summary_mb: r.summary_mb, itemized_mb: r.itemized_mb,
      used_mb: useSummary ? (r.summary_mb || 0) : (r.itemized_mb || 0),
      session_days: r.session_days == null ? null : Math.round(r.session_days), last_session_at: nz(r.last_session),
      // the Summary's own figures (sql/002_vi_pool.sql columns; ignored by the 001 function)
      summary_session_days: r.summary_days == null ? null : Math.round(r.summary_days), summary_last_session_at: nz(r.summary_last) }));
    let daily = null;
    if (parts && parts.itemized) {
      // Only the period's own days — a file that crosses the cycle start must not add days to it — and none
      // after the report's "data up to" day
      const inPeriod = d => (!month.period_start || !month.period_end || (d >= month.period_start && d <= month.period_end))
        && (!month.itemized_until || d <= month.itemized_until);
      daily = [];
      parts.itemized.rows.forEach(r => Object.entries(r.daily).forEach(([d, mb]) => { if (inPeriod(d)) daily.push({ iccid: r.iccid, circle: r.circle || '', usage_date: d, used_mb: mb }); }));
    }
    const rc = month.recon || {};
    const meta = { period_start: month.period_start, period_end: month.period_end, last_data_date: month.last_data_date || null,
      has_summary: useSummary, has_itemized: !!(month.sources && month.sources.itemized),
      summary_batch_id: (month.sources.summary && month.sources.summary.batch_id) || null,
      itemized_batch_id: (month.sources.itemized && month.sources.itemized.batch_id) || null,
      summary_mb: useSummary ? rc.summary_mb : null, itemized_mb: month.sources.itemized ? rc.itemized_mb : null,
      reconciliation: { status: rc.status, summary_mb: rc.summary_mb, itemized_mb: rc.itemized_mb, diff_mb: rc.diff_mb,
        rows_compared: rc.rows_compared, mismatches: (rc.mismatches || []).slice(0, 50), mismatch_count: (rc.mismatches || []).length,
        only_summary: rc.only_summary, only_itemized: rc.only_itemized,
        // the last Itemized day this save commits: daily rows after it (a save that stopped half-way) are not shown
        itemized_last: month.sources && month.sources.itemized ? (month.itemized_last || null) : null } };
    if (scale.ready !== false) {
      const r = await savePeriodChunked(provider, month, monthly, daily, meta, onProgress);
      if (!r.missing) return r;
    }
    // 001-003 way (sql/004_vi_scale.sql not run): the whole cycle in one call — fine for a few hundred SIMs
    const { error } = await client().rpc('replace_provider_period', { p_provider: provider, p_period: month.label, p_meta: meta, p_monthly: monthly, p_daily: daily });
    return error ? { saved: false, error } : { saved: true };
  }

  /* ── any fleet size (sql/004_vi_scale.sql) ──────────────────── */
  const scale = { ready: null, reason: '' };
  const noScale = e => { if (isMissing(e)) { scale.ready = false; scale.reason = 'Run sql/004_vi_scale.sql in Supabase for large fleets (uploads in chunks, faster start-up)'; return true; } return false; };
  // rows per call, about 1 MB of JSON each — well inside request-size and statement-time limits
  const CHUNK = 8000, CHUNK_WIDE = 3000;          // daily rows are small; monthly / inventory rows are wider
  const addDay = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  // Itemized: the cloud must end up with exactly this upload's days (as the browser does — an upload replaces the cycle's
  // daily figures), without re-sending what it already holds. Days with the same total and SIM count are skipped; changed
  // or missing days are sent (a few days per call, each call atomic); the last stored day (it may still grow) is always
  // re-sent; stored days this upload does not have are cleared. Monthly rows: staged in chunks, then the period row and
  // every row swapped in one call — the period row also records the upload's last Itemized day, so a save that stops
  // half-way never shows newer daily figures next to older totals (periodsWithRows).
  async function savePeriodChunked(provider, month, monthly, daily, meta, onProgress) {
    const sb = client(), period = month.label;
    const calls = [];
    if (daily) {
      const { data: had, error: e0 } = await sb.from(T.dailyTotals).select('usage_date,used_mb,sims').eq('provider', provider).eq('reporting_period', period);
      if (e0) return { saved: false, error: e0 };
      const stored = new Map((had || []).map(r => [String(r.usage_date).slice(0, 10), { mb: +r.used_mb, sims: +r.sims }]));
      const mine = new Map();
      daily.forEach(r => { let x = mine.get(r.usage_date); if (!x) mine.set(r.usage_date, x = { mb: 0, sims: new Set() }); x.mb += r.used_mb; x.sims.add(r.iccid); });
      const days = [...mine.keys()].sort(), lastStored = [...stored.keys()].sort().pop() || null;
      const same = d => { const a = stored.get(d), b = mine.get(d); return !!(a && b && Math.abs(a.mb - b.mb) <= 0.01 && a.sims === b.sims.size); };
      const send = days.filter(d => !same(d) || (lastStored && d >= addDay(lastStored, -1)));
      const extra = [...stored.keys()].filter(d => !mine.has(d)).sort();
      const byDay = new Map(send.map(d => [d, []])); daily.forEach(r => { const l = byDay.get(r.usage_date); if (l) l.push(r); });
      let cur = { clear: extra, rows: [] };
      for (const d of send) {
        const list = byDay.get(d);
        if (cur.rows.length && cur.rows.length + list.length > CHUNK) { calls.push(cur); cur = { clear: [], rows: [] }; }
        cur.clear.push(d);
        for (let i = 0; i < list.length; i += CHUNK) {            // a day bigger than a chunk: its first call clears it
          if (i > 0) { calls.push(cur); cur = { clear: [], rows: [] }; }
          cur.rows.push(...list.slice(i, i + CHUNK));
        }
      }
      if (cur.rows.length || cur.clear.length) calls.push(cur);
    }
    const stage = []; for (let i = 0; i < monthly.length; i += CHUNK_WIDE) stage.push(monthly.slice(i, i + CHUNK_WIDE));
    const total = calls.length + stage.length + 1;
    let done = 0;
    const step = () => { done++; if (onProgress) onProgress(done, total); };
    for (const c of calls) {
      const { error } = await sb.rpc('save_provider_daily', { p_provider: provider, p_period: period, p_clear_days: c.clear, p_rows: c.rows });
      if (error) { if (noScale(error)) return { missing: true }; return { saved: false, error }; }
      scale.ready = true; step();
    }
    const batch = uuid();
    for (let i = 0; i < stage.length; i++) {
      const { error } = await sb.rpc('stage_provider_rows', { p_batch: batch, p_seq: i, p_provider: provider, p_rows: stage[i] });
      if (error) { if (noScale(error)) return { missing: true }; return { saved: false, error }; }
      scale.ready = true; step();
    }
    const { error } = await sb.rpc('commit_provider_period', { p_batch: batch, p_provider: provider, p_period: period, p_meta: meta });
    if (error) { if (noScale(error)) return { missing: true }; return { saved: false, error }; }
    scale.ready = true; step();
    return { saved: true, calls: total, daily_rows: calls.reduce((a, c) => a + c.rows.length, 0), monthly_rows: monthly.length };
  }

  // Remove a whole billing period (a wrong upload). The upload-history rows stay, marked 'deleted',
  // which also lifts the duplicate guard so the same files can be uploaded again.
  async function deletePeriod(provider, period) {
    const mark = list => list.forEach(b => { if (b.provider === provider && b.reporting_period === period && b.status === 'success') b.status = 'deleted'; });
    if (!st.ready) { mark(st.session); return { deleted: true, local: true }; }
    const { error } = await client().rpc('delete_provider_period', { p_provider: provider, p_period: period });
    if (error) return { deleted: false, error };
    mark(st.session); mark(st.cloudHistory);
    return { deleted: true };
  }

  async function saveInventory(provider, inv, batchId) {
    if (!st.ready) return { saved: false, reason: st.reason };
    const rows = inv.sims.map(x => ({ iccid: x.iccid, msisdn: nz(x.msisdn), imsi: nz(x.imsi), circle: nz(x.circle),
      lifecycle_state: nz(x.lifecycle_state), status: nz(x.status), plan_name: nz(x.deal_name), base_plan_name: nz(x.base_plan_name),
      plan_gb: x.plan_gb, plan_price: x.plan_price, pooled: !!x.pooled, group_name: nz(x.group_name),
      activated_at: nz(x.activated_at), product_type: nz(x.product_type) }));
    // any fleet size (sql/004_vi_scale.sql): staged in chunks, replaced in one transaction
    if (scale.ready !== false) {
      const sb = client(), stageId = uuid();
      let missing = false, err = null;
      for (let i = 0, seq = 0; i < rows.length && !err; i += CHUNK_WIDE, seq++) {
        const { error } = await sb.rpc('stage_provider_rows', { p_batch: stageId, p_seq: seq, p_provider: provider, p_rows: rows.slice(i, i + CHUNK_WIDE) });
        if (error) { if (noScale(error)) missing = true; else err = error; break; }
      }
      if (!missing && !err) {
        const { error } = await sb.rpc('commit_provider_sims', { p_batch: stageId, p_provider: provider, p_upload_batch: batchId || null, p_as_of: nz(inv.as_of) });
        if (error) { if (noScale(error)) missing = true; else err = error; }
      }
      if (err) return { saved: false, error: err };
      if (!missing) { scale.ready = true; return { saved: true }; }
    }
    const { error } = await client().rpc('replace_provider_sims', { p_provider: provider, p_rows: rows, p_batch: batchId || null, p_as_of: nz(inv.as_of) });
    return error ? { saved: false, error } : { saved: true };
  }

  /* ── universal SIM search (sql/005_sim_search.sql) ──────────── */
  // search.ready: null = not checked, false = 005 not run (the dashboard then searches the SIMs loaded in the browser)
  const search = { ready: null, reason: '' };
  const noSearch = e => { if (isMissing(e)) { search.ready = false; search.reason = 'Run sql/005_sim_search.sql in Supabase so the SIM search runs in the database (until then it searches the SIMs loaded in this browser)'; return true; } return false; };
  // Every provider's SIMs at once — { results, more, too_short }; null when the function is not there
  async function searchSims(q, limit) {
    if (!st.ready || search.ready === false) return null;
    const { data, error } = await client().rpc('search_sims', { p_q: q, p_limit: limit || 20 });
    if (error) { if (noSearch(error)) return null; throw error; }
    search.ready = true; search.reason = '';
    return data || { results: [], more: false, too_short: false };
  }
  // A provider's SIMs in the common SIM table — compared before a provider whose SIMs live elsewhere (Airtel) is
  // written there (js/providers/search.js); null when they cannot be read
  async function loadDirectory(provider) {
    if (!st.ready) return null;
    try {
      return await fetchAll({ table: T.sims, cols: 'iccid,msisdn,lifecycle_state,plan_name', where: x => x.eq('provider', provider), order: ['iccid'] });
    } catch (e) { console.warn('[provider-cloud] SIM list read failed:', e.message || e); return null; }
  }

  /* ── pool history (sql/002_vi_pool.sql) ─────────────────────── */
  // pool.ready: null = not checked, false = 002 not run (history is kept for this session only)
  const pool = { ready: null, reason: '' };
  const noPool = e => { if (isMissing(e)) { pool.ready = false; pool.reason = 'Run sql/002_vi_pool.sql in Supabase to keep SIM Group history and frozen cycles'; return true; } return false; };
  // Every SIM Group export is kept (one row per SIM per export); the same export twice changes nothing
  async function saveSnapshot(provider, inv, batchId) {
    if (!st.ready || pool.ready === false) return { saved: false, reason: pool.reason || st.reason };
    const rows = inv.sims.map(x => ({ provider, snapshot_at: inv.as_of, iccid: x.iccid, msisdn: nz(x.msisdn), imsi: nz(x.imsi),
      lifecycle_state: nz(x.lifecycle_state), plan_name: nz(x.deal_name), base_plan_name: nz(x.base_plan_name), plan_gb: x.plan_gb,
      plan_price: x.plan_price, activated_at: nz(x.activated_at), upload_batch_id: batchId || null }));
    // 2,000 rows per request, three requests at a time (an export of a large fleet is tens of thousands of rows)
    const parts = []; for (let i = 0; i < rows.length; i += 2000) parts.push(rows.slice(i, i + 2000));
    for (let i = 0; i < parts.length; i += 3) {
      const res = await Promise.all(parts.slice(i, i + 3).map(p => client().from(T.snapshots).upsert(p, { onConflict: 'provider,snapshot_at,iccid', ignoreDuplicates: true })));
      const bad = res.find(r => r.error);
      if (bad) { noPool(bad.error); return { saved: false, error: bad.error }; }
    }
    pool.ready = true;
    return { saved: true };
  }
  // A closed cycle's pool: written once (force = an admin's recompute overwrites it)
  async function saveCyclePool(provider, rec, force) {
    if (!st.ready || pool.ready === false) return { saved: false, reason: pool.reason || st.reason };
    const row = { provider, reporting_period: rec.reporting_period, computed_at: rec.computed_at };
    POOL_COLS.forEach(k => { row[k] = rec[k] == null ? null : rec[k]; });
    const { error } = await client().from(T.cyclePool).upsert(row, { onConflict: 'provider,reporting_period', ignoreDuplicates: !force });
    if (error) { noPool(error); return { saved: false, error }; }
    pool.ready = true;
    return { saved: true };
  }
  // SIM Group exports of the last `days` days (go-live detection needs only recent ones) + every frozen pool
  async function loadPoolHistory(provider, days = 150, prelive = ['ready']) {
    if (!st.ready) return null;
    const sb = client(), since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const frozenOf = rows => {
      const frozen = {};
      rows.forEach(r => {
        const rec = { provider, reporting_period: r.reporting_period, computed_at: r.computed_at, computed_by: r.computed_by || null };
        POOL_COLS.forEach(k => { if (k in r) rec[k] = r[k]; });
        ['total_sims', 'eligible_sims', 'non_eligible_sims', 'full_gb', 'prorated_gb', 'pool_gb', 'used_gb', 'remaining_gb', 'utilisation_pct', 'new_activations', 'new_activation_gb']
          .forEach(k => { rec[k] = rec[k] == null ? null : +rec[k]; });
        rec.snapshot_at = ts(rec.snapshot_at); rec.cycle_start = String(rec.cycle_start).slice(0, 10); rec.cycle_end = String(rec.cycle_end).slice(0, 10);
        if (!('sims' in r)) rec.sims = null;                           // its SIM list loads when a view needs it
        frozen[r.reporting_period] = rec;
      });
      return frozen;
    };
    // Any fleet size (sql/004_vi_scale.sql): the list of exports and each pre-live SIM's state runs — computed in the
    // database — instead of every row of every export; frozen pools without their SIM lists
    if (scale.ready !== false) {
      try {
        const one = (name, args) => client().rpc(name, args).then(r => { if (r.error) throw r.error; return r.data; });
        const [idx, runRows, poolRows] = await Promise.all([
          rpcAll('provider_snapshot_index', { p_provider: provider, p_since: since }),
          one('provider_state_runs', { p_provider: provider, p_since: since, p_prelive: prelive.map(s => String(s).trim().toLowerCase()) }),   // one JSON array
          fetchAll({ table: T.cyclePool, cols: 'provider,reporting_period,computed_at,computed_by,' + POOL_COLS.filter(k => k !== 'sims').join(','), where: x => x.eq('provider', provider), order: ['reporting_period'] }),
        ]);
        scale.ready = true; pool.ready = true; pool.reason = '';
        const runs = new Map();
        (runRows || []).forEach(([iccid, state, first, last]) => { const l = runs.get(iccid) || []; l.push({ state: state || '', first: ts(first), last: ts(last) }); runs.set(iccid, l); });
        return { snapshots: idx.map(r => ({ as_of: ts(r.snapshot_at), light: true, count: +r.sims, fromCloud: true })), frozen: frozenOf(poolRows), runs };
      } catch (e) {
        if (!noScale(e)) { if (!noPool(e)) console.warn('[provider-cloud] pool history load failed:', e.message || e); return null; }
      }
    }
    try {
      const [snapRows, poolRows] = await Promise.all([
        selectAll(() => sb.from(T.snapshots).select('snapshot_at,iccid,msisdn,imsi,lifecycle_state,plan_name,base_plan_name,plan_gb,plan_price,activated_at')
          .eq('provider', provider).gte('snapshot_at', since).order('snapshot_at').order('iccid')),
        selectAll(() => sb.from(T.cyclePool).select('*').eq('provider', provider).order('reporting_period')),
      ]);
      pool.ready = true; pool.reason = '';
      const by = new Map();
      snapRows.forEach(r => {
        const k = ts(r.snapshot_at), s = by.get(k) || { as_of: k, fromCloud: true, sims: [] };
        s.sims.push(snapSim(r));
        by.set(k, s);
      });
      return { snapshots: [...by.values()], frozen: frozenOf(poolRows) };
    } catch (e) {
      if (!noPool(e)) console.warn('[provider-cloud] pool history load failed:', e.message || e);
      return null;
    }
  }
  const snapSim = r => ({ iccid: r.iccid, msisdn: r.msisdn || '', imsi: r.imsi || '', lifecycle_state: r.lifecycle_state || '', deal_name: r.plan_name || '',
    base_plan_name: r.base_plan_name || '', plan_gb: +r.plan_gb || 0, plan_price: r.plan_price == null ? null : +r.plan_price, activated_at: ts(r.activated_at) });
  // One SIM Group export in full (a closed cycle that is frozen with it, or shown provisionally from it)
  async function loadSnapshot(provider, asOf) {
    if (!st.ready) return null;
    const rows = await fetchAll({ table: T.snapshots, cols: 'snapshot_at,iccid,msisdn,imsi,lifecycle_state,plan_name,base_plan_name,plan_gb,plan_price,activated_at',
      where: x => x.eq('provider', provider).eq('snapshot_at', asOf), order: ['iccid'] });
    return rows.length ? { as_of: asOf, fromCloud: true, sims: rows.map(snapSim) } : null;
  }
  // A frozen cycle's per-SIM allocations (left out of the start-up load)
  async function loadFrozenSims(provider, period) {
    if (!st.ready) return null;
    const { data, error } = await client().from(T.cyclePool).select('sims').eq('provider', provider).eq('reporting_period', period).maybeSingle();
    if (error) { console.warn('[provider-cloud] frozen pool load failed:', error.message); return null; }
    return (data && data.sims) || null;
  }
  async function loadRules(provider) {
    if (!st.ready) return null;
    const { data, error } = await client().from(T.providers).select('config').eq('code', provider).maybeSingle();
    if (error) { console.warn('[provider-cloud] rules load failed:', error.message); return null; }
    return (data && data.config && data.config.pool_rules) || null;
  }
  async function saveRules(provider, rules) {
    if (!st.ready) return { saved: false, reason: st.reason };
    const { data, error: e1 } = await client().from(T.providers).select('config').eq('code', provider).maybeSingle();
    if (e1) return { saved: false, error: e1 };
    const config = Object.assign({}, (data && data.config) || {}, { pool_rules: rules });
    const { error } = await client().from(T.providers).update({ config }).eq('code', provider);
    return error ? { saved: false, error } : { saved: true };
  }

  /* ── operations (sql/003_vi_operations.sql) ─────────────────── */
  const ops = { ready: null, reason: '' };
  const noOps = e => { if (isMissing(e)) { ops.ready = false; ops.reason = 'Run sql/003_vi_operations.sql in Supabase to keep the pool alert history and forecast history'; return true; } return false; };
  async function loadOps(provider, limit = 200) {
    if (!st.ready) return null;
    const sb = client();
    try {
      // the newest `limit` of each — a single request each, however long the history grows
      const newest = (table, col) => sb.from(table).select('*').eq('provider', provider).order(col, { ascending: false }).limit(limit)
        .then(r => { if (r.error) throw r.error; return r.data || []; });
      const [snaps, alerts] = await Promise.all([newest(T.poolSnaps, 'recorded_at'), newest(T.alerts, 'first_detected')]);
      ops.ready = true; ops.reason = '';
      const num = v => (v == null ? null : +v);
      return {
        snaps: snaps.map(r => ({ provider, reporting_period: r.reporting_period, as_of: String(r.as_of).slice(0, 10), source: r.source, pool_gb: num(r.pool_gb),
          used_gb: num(r.used_gb), avg_gb_day: num(r.avg_gb_day), projected_gb: num(r.projected_gb), level: r.level, recorded_at: r.recorded_at,
          counted: r.counted && r.counted.n != null ? { n: +r.counted.n, h: +r.counted.h } : null })),     // sql/004
        alerts: alerts.map(r => Object.assign({}, r, { details: r.details || {} })),
      };
    } catch (e) {
      if (!noOps(e)) console.warn('[provider-cloud] operations load failed:', e.message || e);
      return null;
    }
  }
  // `counted` (which SIMs the evaluation counted) has its column from sql/004 — without it the row is saved without
  async function savePoolSnapshot(row) {
    if (!st.ready || ops.ready === false || !row) return { saved: false, reason: ops.reason || st.reason };
    const rec = { recorded_at: new Date().toISOString() };
    ['provider', 'reporting_period', 'as_of', 'source', 'pool_gb', 'used_gb', 'avg_gb_day', 'projected_gb', 'level'].forEach(k => { rec[k] = row[k] === undefined ? null : row[k]; });
    if (scale.ready !== false) rec.counted = row.counted || null;
    const put = r => client().from(T.poolSnaps).upsert(r, { onConflict: 'provider,reporting_period,as_of,source' });
    let { error } = await put(rec);
    if (error && 'counted' in rec && /counted/.test(error.message || '')) {      // the column is not there: 004 not run
      noScale({ code: 'PGRST204', message: 'schema cache' }); delete rec.counted; ({ error } = await put(rec));
    }
    if (error) { noOps(error); return { saved: false, error }; }
    ops.ready = true;
    return { saved: true };
  }
  // Several admin tabs may evaluate the alert: a write only goes through when the stored row is still the one this tab
  // last saw (compare-and-swap on last_updated — `expected`, null for a new alert). A stored resolved alert is never
  // reopened, and a new one is not opened while another is open. Otherwise { stale, stored } — the tab adopts the stored
  // row. force: an admin's explicit action (e.g. deleting the cycle the alert belongs to).
  const sameTime = (a, b) => (a == null && b == null) || (a != null && b != null && Date.parse(a) === Date.parse(b));
  async function saveAlert(alert, opts) {
    if (!st.ready || ops.ready === false || !alert || !alert.id) return { saved: false, reason: ops.reason || st.reason };
    if (!(opts && opts.force)) {
      const { data: had, error: e0 } = await client().from(T.alerts).select('*').eq('id', alert.id).maybeSingle();
      if (e0) { if (noOps(e0)) return { saved: false, reason: ops.reason }; return { saved: false, error: e0 }; }
      if (had) {
        if (opts && 'expected' in opts && !sameTime(had.last_updated, opts.expected)) return { saved: false, stale: true, stored: had };
        if (had.status === 'resolved' && alert.status === 'open') return { saved: false, stale: true, stored: had };
      } else if (alert.status === 'open') {
        const { data: other, error: e1 } = await client().from(T.alerts).select('*').eq('provider', alert.provider).eq('code', alert.code).eq('status', 'open').limit(1);
        if (e1) { if (noOps(e1)) return { saved: false, reason: ops.reason }; return { saved: false, error: e1 }; }
        if (other && other.length && other[0].id !== alert.id) return { saved: false, stale: true, stored: other[0] };
      }
    }
    const row = {}; ['id', 'provider', 'code', 'reporting_period', 'level', 'status', 'first_detected', 'last_updated', 'escalated_at', 'resolved_at', 'resolution_reason', 'details']
      .forEach(k => { row[k] = alert[k] === undefined ? null : alert[k]; });
    const { error } = await client().from(T.alerts).upsert(row, { onConflict: 'id' });
    if (error) { noOps(error); return { saved: false, error }; }
    ops.ready = true;
    return { saved: true };
  }
  // A deleted cycle's pool evaluations go with it (they would skew the pace and the burn-rate chart)
  async function deletePoolSnapshots(provider, period) {
    if (!st.ready || ops.ready === false) return { deleted: false, reason: ops.reason || st.reason };
    const { error } = await client().from(T.poolSnaps).delete().eq('provider', provider).eq('reporting_period', period);
    if (error) { noOps(error); return { deleted: false, error }; }
    return { deleted: true };
  }
  // One SIM's daily usage in every stored cycle: { period: { 'YYYY-MM-DD': MB } } (circles summed). Indexed by (provider, iccid, …).
  async function loadSimHistory(provider, iccid) {
    if (!st.ready) return null;
    const rows = await selectAll(() => client().from(T.daily).select('reporting_period,usage_date,used_mb')
      .eq('provider', provider).eq('iccid', iccid).order('usage_date'));
    const out = {};
    rows.forEach(r => { const d = out[r.reporting_period] || (out[r.reporting_period] = {}), k = String(r.usage_date).slice(0, 10); d[k] = (d[k] || 0) + (+r.used_mb); });
    return out;
  }

  async function loadProvider(provider, opts) {
    if (!st.ready) return null;
    const recent = opts && opts.recent;           // only the newest N cycles' rows now — the rest with loadPeriods()
    const [allPeriods, sims] = await Promise.all([
      fetchAll({ table: T.periods, cols: '*', where: x => x.eq('provider', provider), order: ['reporting_period'] }),
      fetchAll({ table: T.sims, cols: '*', where: x => x.eq('provider', provider), order: ['iccid'] }),
    ]);
    // a bare period row (no report committed — a save that stopped after its daily rows) is not a cycle with data
    const periods = allPeriods.filter(p => p.has_summary || p.has_itemized);
    const sort = window.Providers && window.Providers.sortMonths ? window.Providers.sortMonths : l => l.slice().sort();
    const labels = sort(periods.map(p => p.reporting_period));
    const now = recent ? labels.slice(-recent) : labels, later = recent ? labels.slice(0, Math.max(0, labels.length - recent)) : [];
    const months = await periodsWithRows(provider, periods.filter(p => now.includes(p.reporting_period)));
    periods.filter(p => later.includes(p.reporting_period)).forEach(p => { months[p.reporting_period] = monthShell(p, true); });
    const asOf = sims.reduce((a, s) => (ts(s.as_of) > a ? ts(s.as_of) : a), '');
    const inventory = sims.length ? { as_of: asOf, fromCloud: true, sims: sims.map(s => ({ iccid: s.iccid, msisdn: s.msisdn || '', imsi: s.imsi || '',
      circle: s.circle || '', lifecycle_state: s.lifecycle_state || '', status: s.status || s.lifecycle_state || 'N/A',
      deal_name: s.plan_name || '', base_plan_name: s.base_plan_name || '', group_name: s.group_name || '',
      activated_at: ts(s.activated_at), product_type: s.product_type || '', plan_gb: +s.plan_gb || 0,
      plan_price: s.plan_price == null ? null : +s.plan_price, pooled: !!s.pooled })) } : null;
    return { months, inventory, later };
  }
  // Older cycles, loaded in the background after start-up
  async function loadPeriods(provider, labels) {
    if (!st.ready || !labels || !labels.length) return { months: {} };
    const periods = await fetchAll({ table: T.periods, cols: '*', where: x => x.eq('provider', provider).in('reporting_period', labels), order: ['reporting_period'] });
    return { months: await periodsWithRows(provider, periods) };
  }
  const monthShell = (p, light) => ({ label: p.reporting_period, period_start: p.period_start, period_end: p.period_end,
    last_data_date: p.last_data_date, rows: [], daily: null, dailyTotals: null, fromCloud: true, light: !!light,
    sources: { summary: p.has_summary ? { batch_id: p.summary_batch_id, total_mb: +p.summary_mb || 0 } : null,
      itemized: p.has_itemized ? { batch_id: p.itemized_batch_id, total_mb: +p.itemized_mb || 0 } : null } });
  // Months come back without reconciliation — the provider module computes it (it owns the rules)
  async function periodsWithRows(provider, periods) {
    const months = {}, labels = periods.map(p => p.reporting_period);
    periods.forEach(p => { months[p.reporting_period] = monthShell(p, false); });
    if (!labels.length) return months;
    const MCOLS = 'reporting_period,iccid,circle,msisdn,imsi,origin_circle,summary_mb,itemized_mb,session_days,last_session_at';
    const monthlyRows = cols => fetchAll({ table: T.monthly, cols, where: x => x.eq('provider', provider).in('reporting_period', labels), order: ['reporting_period', 'iccid', 'circle'] });
    const [monthly, totals] = await Promise.all([
      // the Summary's own session figures come with sql/002_vi_pool.sql — without it, the columns of 001
      monthlyRows(MCOLS + ',summary_session_days,summary_last_session_at').catch(e => { if (isMissing(e)) return monthlyRows(MCOLS); throw e; }),
      fetchAll({ table: T.dailyTotals, cols: 'reporting_period,usage_date,used_mb', where: x => x.eq('provider', provider).in('reporting_period', labels), order: ['reporting_period', 'usage_date'] }),
    ]);
    monthly.forEach(r => {
      const m = months[r.reporting_period]; if (!m) return;
      m.rows.push({ iccid: r.iccid, circle: r.circle || '', msisdn: r.msisdn || '', imsi: r.imsi || '', origin: r.origin_circle || '',
        summary_mb: r.summary_mb == null ? null : +r.summary_mb, itemized_mb: r.itemized_mb == null ? null : +r.itemized_mb,
        session_days: r.session_days, last_session: ts(r.last_session_at),
        summary_days: r.summary_session_days == null ? null : r.summary_session_days, summary_last: r.summary_last_session_at ? ts(r.summary_last_session_at) : null });
    });
    // daily figures only up to the Itemized day the period row committed (a save that stopped half-way may have left
    // newer days; older periods have no such day recorded — all their days count)
    const cap = {}; periods.forEach(p => { const d = p.reconciliation && p.reconciliation.itemized_last; if (d) cap[p.reporting_period] = String(d).slice(0, 10); });
    totals.forEach(r => {
      const m = months[r.reporting_period], k = String(r.usage_date).slice(0, 10); if (!m) return;
      if (cap[r.reporting_period] && k > cap[r.reporting_period]) return;
      (m.dailyTotals || (m.dailyTotals = {}))[k] = +r.used_mb;
    });
    return months;
  }

  async function loadSimDaily(provider, iccid, period) {
    if (!st.ready) return null;
    const { data, error } = await client().from(T.daily).select('usage_date,used_mb,circle')
      .eq('provider', provider).eq('iccid', iccid).eq('reporting_period', period).order('usage_date');
    if (error) return null;
    const d = {}; (data || []).forEach(r => { const k = String(r.usage_date).slice(0, 10); d[k] = (d[k] || 0) + (+r.used_mb); });
    return d;
  }

  // Daily usage for one period, circles summed: { iccid: { 'YYYY-MM-DD': mb } } — every SIM (the 001 way), or only
  // the SIMs asked for (go-live detection needs a few SIMs, not the whole fleet)
  async function loadPeriodDaily(provider, period, iccids) {
    if (!st.ready) return null;
    const out = {};
    const add = rows => rows.forEach(r => { const d = out[r.iccid] || (out[r.iccid] = {}), k = String(r.usage_date).slice(0, 10); d[k] = (d[k] || 0) + (+r.used_mb); });
    if (iccids) {
      // 150 SIMs per request, 3 requests at a time (a growing fleet can have thousands of SIMs to look up)
      const parts = []; for (let i = 0; i < iccids.length; i += 150) parts.push(iccids.slice(i, i + 150));
      for (let i = 0; i < parts.length; i += 3) {
        (await Promise.all(parts.slice(i, i + 3).map(part => fetchAll({ table: T.daily, cols: 'iccid,circle,usage_date,used_mb',
          where: x => x.eq('provider', provider).eq('reporting_period', period).in('iccid', part), order: ['iccid', 'circle', 'usage_date'] })))).forEach(add);
      }
      return out;
    }
    add(await fetchAll({ table: T.daily, cols: 'iccid,circle,usage_date,used_mb', where: x => x.eq('provider', provider).eq('reporting_period', period), order: ['usage_date', 'iccid', 'circle'] }));
    return out;
  }
  // Each SIM's usage from the cycle start to the end of `date`, summed in the database (sql/004_vi_scale.sql):
  // { iccid: { used_mb, days } } — null when 004 is not there (the caller then loads the daily rows)
  async function loadTotalsAsOf(provider, period, from, date) {
    if (!st.ready || scale.ready === false) return null;
    const { data, error } = await client().rpc('provider_sim_totals_asof', { p_provider: provider, p_period: period, p_from: from, p_date: date });
    if (error) { if (!noScale(error)) console.warn('[provider-cloud] as-of totals failed:', error.message || error); return null; }
    scale.ready = true;
    const out = {};
    Object.entries(data || {}).forEach(([iccid, [mb, days]]) => { out[iccid] = { used_mb: +mb || 0, days: +days || 0 }; });
    return out;
  }
  async function loadHistory(limit = 200) {
    if (st.ready) {
      const { data, error } = await client().from(T.batches).select('*').order('uploaded_at', { ascending: false }).limit(limit);
      if (!error) st.cloudHistory = data || [];
    }
    return history();
  }
  // Cloud rows + this session's rows that never reached the cloud
  function history() {
    const ids = new Set(st.cloudHistory.map(r => r.id));
    return st.session.filter(r => !ids.has(r.id)).concat(st.cloudHistory)
      .sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
  }

  window.ProviderCloud = { probe, sha256, findBatch, recordBatch, markBatches, savePeriod, deletePeriod, saveInventory,
    saveSnapshot, saveCyclePool, loadPoolHistory, loadRules, saveRules, loadOps, savePoolSnapshot, saveAlert, deletePoolSnapshots, loadSimHistory, ops,
    loadProvider, loadPeriods, loadSimDaily, loadPeriodDaily, loadTotalsAsOf, loadSnapshot, loadFrozenSims, loadHistory, history, uuid,
    searchSims, loadDirectory, state: st, pool, scale, search, tables: T };
})();
