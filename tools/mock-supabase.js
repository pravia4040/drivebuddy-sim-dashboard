/* ============================================================
   tools/mock-supabase.js — LOCAL TESTING ONLY
   ------------------------------------------------------------
   Served in place of js/supabase.js by `tools/serve_local.py --mock`.
   An in-memory (localStorage-backed) stand-in for the Supabase
   client: signed-in mock Admin, the dashboard's legacy tables, the
   multi-provider tables + views + RPCs from sql/001_multi_provider.sql,
   the pool history tables from sql/002_vi_pool.sql and the alert / forecast
   history tables from sql/003_vi_operations.sql.
   Nothing here talks to the network. Never referenced by the live site.

   URL switches:  ?mockReset=1        start from an empty mock database
                  ?mockNoProvider=1   simulate "migration not run yet"
                  ?mockNo002=1        simulate "002_vi_pool.sql not run yet"
                  ?mockNo003=1        simulate "003_vi_operations.sql not run yet"
                  ?mockNo004=1        simulate "004_vi_scale.sql not run yet" (the 001–003 save / load paths)
                  ?mockNo005=1        simulate "005_sim_search.sql not run yet" (search runs over the SIMs in the browser)
                  ?mockMem=1          keep the mock database in memory only (big fleets do not fit localStorage)
                  ?mockFail=a,b       reads of these tables / calls of these functions fail with a statement
                                      time-out (a transient error, not a missing table) — e.g. provider_state_runs
   ============================================================ */
(function () {
  'use strict';
  const KEY = 'dbai_mock_db_v1';
  const params = new URLSearchParams(location.search);
  if (params.get('mockReset') === '1') { try { localStorage.removeItem(KEY); } catch (e) {} }
  const noProvider = params.get('mockNoProvider') === '1';
  const no002 = noProvider || params.get('mockNo002') === '1';
  const no003 = no002 || params.get('mockNo003') === '1';
  const no004 = no003 || params.get('mockNo004') === '1';
  const no005 = noProvider || params.get('mockNo005') === '1';
  const memOnly = params.get('mockMem') === '1';
  const failing = new Set(String(params.get('mockFail') || '').split(',').map(s => s.trim()).filter(Boolean));
  const timeout = () => ({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } });
  const stats = { rpc: {}, selects: 0, rows_out: 0, bytes_in: 0, failed: 0 };     // what the app asked of the database (scale tests)
  const PROVIDER_TABLES = ['providers', 'upload_batches', 'provider_periods', 'provider_sims', 'provider_sim_usage_monthly', 'provider_sim_usage_daily'];
  const POOL_TABLES = ['provider_sim_snapshots', 'provider_cycle_pool'];       // sql/002_vi_pool.sql
  const OPS_TABLES = ['provider_pool_snapshots', 'provider_alerts'];            // sql/003_vi_operations.sql
  const PK = {
    provider_periods: ['provider', 'reporting_period'], provider_sims: ['provider', 'iccid'],
    provider_sim_usage_monthly: ['provider', 'reporting_period', 'iccid', 'circle'],
    provider_sim_usage_daily: ['provider', 'iccid', 'circle', 'usage_date'],
    provider_sim_snapshots: ['provider', 'snapshot_at', 'iccid'], provider_cycle_pool: ['provider', 'reporting_period'],
    provider_pool_snapshots: ['provider', 'reporting_period', 'as_of', 'source'], provider_alerts: ['id'],
    monthly_snapshots: ['month_label'], realtime_snapshot: ['id'], authorized_users: ['email'],
  };
  const USER = { id: 'mock-user', email: 'mock.admin@local.test' };

  let db;
  try { db = memOnly ? null : JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { db = null; }
  if (!db) db = { seq: 1, tables: {} };
  const T = name => (db.tables[name] || (db.tables[name] = []));
  let version = 0;                                        // bumped on every write — read caches use it
  function save() { version++; if (memOnly) return; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { console.warn('[mock] could not persist', e.message); } }
  if (!T('authorized_users').length) T('authorized_users').push({ id: 'mock', email: USER.email, role: 'Admin', status: 'Active', created_at: new Date().toISOString(), added_by: 'mock' });
  if (!noProvider && !T('providers').length) {
    [['airtel', 'Airtel', 'active', 1], ['vi', 'VI (Vodafone Idea)', 'active', 2], ['jio', 'Jio', 'planned', 3]]
      .forEach(([code, name, status, sort_order], i) => T('providers').push({ id: i + 1, code, name, status, sort_order, config: {} }));
  }
  save();

  const missing = name => ({ message: `Could not find the table 'public.${name}' in the schema cache`, code: 'PGRST205' });
  const isProviderTable = n => PROVIDER_TABLES.includes(n) || n === 'provider_daily_totals' || n === 'provider_period_totals';
  const clone = x => JSON.parse(JSON.stringify(x));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'm' + (db.seq++) + '-' + Date.now());

  function viewRows(name) {
    if (name === 'provider_daily_totals') {
      const m = new Map();
      T('provider_sim_usage_daily').forEach(r => {
        const k = [r.provider, r.reporting_period, r.usage_date].join('|');
        const x = m.get(k) || { provider: r.provider, reporting_period: r.reporting_period, usage_date: r.usage_date, used_mb: 0, sims: new Set() };
        x.used_mb += +r.used_mb; x.sims.add(r.iccid); m.set(k, x);
      });
      return [...m.values()].map(x => Object.assign(x, { sims: x.sims.size }));
    }
    if (name === 'provider_period_totals') {
      const m = new Map();
      T('provider_sim_usage_monthly').forEach(r => {
        const k = r.provider + '|' + r.reporting_period;
        const x = m.get(k) || { provider: r.provider, reporting_period: r.reporting_period, sims: new Set(), used_mb: 0, summary_mb: 0, itemized_mb: 0 };
        x.sims.add(r.iccid); x.used_mb += +r.used_mb || 0; x.summary_mb += +r.summary_mb || 0; x.itemized_mb += +r.itemized_mb || 0; m.set(k, x);
      });
      return [...m.values()].map(x => Object.assign(x, { sims: x.sims.size }));
    }
    return T(name);
  }

  const readCache = new Map();                            // (version, query) → sorted rows: paging a big table sorts once
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.sig = []; this.orders = []; this.lim = null; this.rng = null; this.op = 'select'; this.one = null; }
    select(cols, opt) { if (this.op === 'select') { this.cols = cols; this.count = !!(opt && opt.count); } return this; }
    eq(c, v) { this.sig.push(`eq ${c}=${v}`); this.filters.push(r => String(r[c]) === String(v)); return this; }
    gte(c, v) { this.sig.push(`gte ${c}=${v}`); this.filters.push(r => r[c] != null && String(r[c]) >= String(v)); return this; }
    lte(c, v) { this.sig.push(`lte ${c}=${v}`); this.filters.push(r => r[c] != null && String(r[c]) <= String(v)); return this; }
    in(c, vs) { this.sig.push(`in ${c}=${vs.join('\u0001')}`); const s = new Set(vs.map(String)); this.filters.push(r => s.has(String(r[c]))); return this; }
    order(c, o) { this.orders.push([c, !(o && o.ascending === false)]); return this; }
    limit(n) { this.lim = n; return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    single() { this.one = 'one'; return this; }
    insert(rows) { this.op = 'insert'; this.payload = [].concat(rows); return this; }
    upsert(rows, opt) { this.op = 'upsert'; this.payload = [].concat(rows); this.conflict = opt && opt.onConflict; this.ignoreDup = !!(opt && opt.ignoreDuplicates); return this; }
    update(v) { this.op = 'update'; this.payload = v; return this; }
    delete() { this.op = 'delete'; return this; }
    then(res, rej) { return Promise.resolve().then(() => this.exec()).then(res, rej); }
    exec() {
      if (noProvider && isProviderTable(this.table)) return { data: null, error: missing(this.table) };
      if (no002 && POOL_TABLES.includes(this.table)) return { data: null, error: missing(this.table) };
      if (no003 && OPS_TABLES.includes(this.table)) return { data: null, error: missing(this.table) };
      if (failing.has(this.table) && this.op === 'select') { stats.failed++; return timeout(); }
      // provider_pool_snapshots.counted is a column of sql/004_vi_scale.sql
      if (no004 && this.table === 'provider_pool_snapshots' && (this.op === 'insert' || this.op === 'upsert') && this.payload.some(r => 'counted' in r))
        return { data: null, error: { message: "Could not find the 'counted' column of 'provider_pool_snapshots' in the schema cache", code: 'PGRST204' } };
      const tbl = this.table;
      const match = r => this.filters.every(f => f(r));
      if (this.op === 'insert' || this.op === 'upsert') {
        const keys = this.conflict ? this.conflict.split(',').map(s => s.trim()) : (PK[tbl] || ['id']);
        const kOf = x => keys.map(k => String(x[k])).join('\u0001');
        const idx = this.op === 'upsert' ? new Map(T(tbl).map((x, i) => [kOf(x), i])) : null;     // one pass, not one per row
        for (const row of this.payload) {
          const r = clone(row);
          if (!('id' in r) && !PK[tbl]) r.id = tbl === 'upload_batches' ? uuid() : db.seq++;
          if (tbl === 'upload_batches') {
            r.uploaded_at = r.uploaded_at || new Date().toISOString(); r.uploaded_by = r.uploaded_by || USER.email;
            if (r.status === 'success' && r.file_hash && T(tbl).some(x => x.status === 'success' && x.provider === r.provider && x.source_type === r.source_type && x.file_hash === r.file_hash))
              return { data: null, error: { message: 'duplicate key value violates unique constraint "upload_batches_one_success_per_file"', code: '23505' } };
          }
          const i = idx && idx.has(kOf(r)) ? idx.get(kOf(r)) : -1;
          if (i >= 0 && this.ignoreDup) continue;                        // upsert … ignoreDuplicates: keep the existing row
          if (i >= 0) T(tbl)[i] = Object.assign(T(tbl)[i], r); else { T(tbl).push(r); if (idx) idx.set(kOf(r), T(tbl).length - 1); }
        }
        save(); return { data: null, error: null };
      }
      if (this.op === 'update') { T(tbl).filter(match).forEach(r => Object.assign(r, clone(this.payload))); save(); return { data: null, error: null }; }
      if (this.op === 'delete') { db.tables[tbl] = T(tbl).filter(r => !match(r)); save(); return { data: null, error: null }; }
      const ck = [version, tbl, this.sig.join('|'), this.orders.map(o => o.join(':')).join(',')].join('#');
      let all = readCache.get(ck);
      if (!all) {
        all = viewRows(tbl).filter(match);
        if (this.orders.length) all = all.slice().sort((a, b) => { for (const [c, asc] of this.orders) { const x = a[c], y = b[c]; if (x < y) return asc ? -1 : 1; if (x > y) return asc ? 1 : -1; } return 0; });
        if (readCache.size > 50) readCache.clear();
        readCache.set(ck, all);
      }
      let rows = all;
      if (this.rng) rows = rows.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim != null) rows = rows.slice(0, this.lim);
      rows = clone(rows);
      // only the columns asked for, as PostgREST does (a column list without '*')
      const cols = this.cols && this.cols !== '*' ? String(this.cols).split(',').map(s => s.trim()).filter(Boolean) : null;
      if (cols && !cols.includes('*')) rows = rows.map(r => { const o = {}; cols.forEach(c => { if (c in r) o[c] = r[c]; }); return o; });
      stats.selects++; stats.rows_out += rows.length;
      if (this.one === 'maybe') return { data: rows[0] || null, error: null };
      if (this.one === 'one') return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } };
      return { data: rows, error: null, count: this.count ? all.length : null };
    }
  }

  // replace_provider_period (001/002) and commit_provider_period (004): the period row + its monthly rows (+ daily rows)
  function replacePeriod(provider, period, m, monthly, daily) {
    m = m || {};
    const per = T('provider_periods'); const i = per.findIndex(x => x.provider === provider && x.reporting_period === period);
    const row = { provider, reporting_period: period, period_start: m.period_start || null, period_end: m.period_end || null,
      last_data_date: m.last_data_date || null, has_summary: !!m.has_summary, has_itemized: !!m.has_itemized,
      summary_batch_id: m.summary_batch_id || null, itemized_batch_id: m.itemized_batch_id || null,
      summary_mb: m.summary_mb, itemized_mb: m.itemized_mb, reconciliation: m.reconciliation || {}, updated_at: new Date().toISOString() };
    if (i >= 0) per[i] = row; else per.push(row);
    db.tables.provider_sim_usage_monthly = T('provider_sim_usage_monthly').filter(x => !(x.provider === provider && x.reporting_period === period));
    (monthly || []).forEach(x => T('provider_sim_usage_monthly').push(Object.assign({ provider, reporting_period: period }, x, { circle: x.circle || '' })));
    if (daily) {
      db.tables.provider_sim_usage_daily = T('provider_sim_usage_daily').filter(x => !(x.provider === provider && x.reporting_period === period));
      daily.forEach(x => T('provider_sim_usage_daily').push(Object.assign({ provider, reporting_period: period }, x, { circle: x.circle || '' })));
    }
    return (monthly || []).length;
  }
  const SCALE_RPCS = ['save_provider_daily', 'stage_provider_rows', 'commit_provider_period', 'commit_provider_sims', 'provider_snapshot_index', 'provider_state_runs', 'provider_sim_totals_asof'];
  const noFn = name => ({ data: null, error: { message: `Could not find the function public.${name} in the schema cache`, code: 'PGRST202' } });
  const day = v => String(v || '').slice(0, 10);
  const dailyIdx = { arr: null, map: null };
  function rpc(name, a) {
    return Promise.resolve().then(() => {
      stats.rpc[name] = (stats.rpc[name] || 0) + 1;
      try { stats.bytes_in += JSON.stringify(a || {}).length; } catch (e) { /* ignore */ }
      if (noProvider) return noFn(name);
      if (failing.has(name)) { stats.failed++; return timeout(); }
      if (SCALE_RPCS.includes(name)) {                       // sql/004_vi_scale.sql
        if (no004) return noFn(name);
        if (name === 'save_provider_daily') {
          if (!T('provider_periods').some(x => x.provider === a.p_provider && x.reporting_period === a.p_period))
            T('provider_periods').push({ provider: a.p_provider, reporting_period: a.p_period, has_summary: false, has_itemized: false, reconciliation: {}, updated_at: new Date().toISOString() });
          const clear = new Set((a.p_clear_days || []).map(day));
          if (clear.size) db.tables.provider_sim_usage_daily = T('provider_sim_usage_daily').filter(x => !(x.provider === a.p_provider && x.reporting_period === a.p_period && clear.has(day(x.usage_date))));
          // primary-key index kept between calls while the table array is the same (rebuilt after a clear)
          const k = x => [x.provider, x.iccid, x.circle || '', day(x.usage_date)].join('|'), arr = T('provider_sim_usage_daily');
          if (dailyIdx.arr !== arr) { dailyIdx.arr = arr; dailyIdx.map = new Map(); arr.forEach((x, i) => dailyIdx.map.set(k(x), i)); }
          (a.p_rows || []).forEach(x => {
            const r = Object.assign({ provider: a.p_provider, reporting_period: a.p_period }, x, { circle: x.circle || '' });
            const i = dailyIdx.map.get(k(r)); if (i != null) arr[i] = r; else { arr.push(r); dailyIdx.map.set(k(r), arr.length - 1); }
          });
          save(); return { data: (a.p_rows || []).length, error: null };
        }
        if (name === 'stage_provider_rows') {
          const st = T('provider_upload_stage').filter(x => !(x.batch_id === a.p_batch && x.seq === a.p_seq));
          st.push({ batch_id: a.p_batch, seq: a.p_seq, provider: a.p_provider, rows: a.p_rows || [] }); db.tables.provider_upload_stage = st;
          save(); return { data: (a.p_rows || []).length, error: null };
        }
        if (name === 'commit_provider_period') {
          const staged = T('provider_upload_stage').filter(x => x.batch_id === a.p_batch && x.provider === a.p_provider).sort((x, y) => x.seq - y.seq);
          const res = replacePeriod(a.p_provider, a.p_period, a.p_meta, staged.flatMap(x => x.rows), null);
          db.tables.provider_upload_stage = T('provider_upload_stage').filter(x => x.batch_id !== a.p_batch);
          save(); return { data: res, error: null };
        }
        if (name === 'commit_provider_sims') {
          const staged = T('provider_upload_stage').filter(x => x.batch_id === a.p_batch && x.provider === a.p_provider).sort((x, y) => x.seq - y.seq);
          const rows = staged.flatMap(x => x.rows);
          db.tables.provider_sims = T('provider_sims').filter(x => x.provider !== a.p_provider);
          rows.forEach(x => T('provider_sims').push(Object.assign({ provider: a.p_provider, upload_batch_id: a.p_upload_batch, as_of: a.p_as_of }, x)));
          db.tables.provider_upload_stage = T('provider_upload_stage').filter(x => x.batch_id !== a.p_batch);
          save(); return { data: rows.length, error: null };
        }
        if (name === 'provider_snapshot_index') {
          const m = new Map(); T('provider_sim_snapshots').forEach(x => { if (x.provider === a.p_provider && String(x.snapshot_at) >= String(a.p_since)) m.set(x.snapshot_at, (m.get(x.snapshot_at) || 0) + 1); });
          return { data: [...m.entries()].sort((x, y) => String(x[0]).localeCompare(String(y[0]))).map(([snapshot_at, sims]) => ({ snapshot_at, sims })), error: null };
        }
        if (name === 'provider_state_runs') {
          const pre = new Set((a.p_prelive || []).map(s => String(s).trim().toLowerCase())), by = new Map();
          T('provider_sim_snapshots').forEach(x => { if (x.provider === a.p_provider && String(x.snapshot_at) >= String(a.p_since)) { const l = by.get(x.iccid) || []; l.push(x); by.set(x.iccid, l); } });
          const out = [];
          by.forEach((l, iccid) => {
            if (!l.some(x => pre.has(String(x.lifecycle_state || '').trim().toLowerCase()))) return;
            l.sort((x, y) => String(x.snapshot_at).localeCompare(String(y.snapshot_at)));
            let run = null;
            l.forEach(x => {
              const s = String(x.lifecycle_state || '').trim().toLowerCase();
              if (run && run.st === s) run.last_seen = x.snapshot_at;
              else { if (run) out.push(run); run = { iccid, state: x.lifecycle_state || '', st: s, first_seen: x.snapshot_at, last_seen: x.snapshot_at }; }
            });
            if (run) out.push(run);
          });
          // one JSON array [iccid, state, first, last], as the function returns it
          return { data: out.sort((x, y) => x.iccid.localeCompare(y.iccid) || String(x.first_seen).localeCompare(String(y.first_seen))).map(r => [r.iccid, r.state, r.first_seen, r.last_seen]), error: null };
        }
        if (name === 'provider_sim_totals_asof') {
          const m = new Map();
          T('provider_sim_usage_daily').forEach(x => {
            const d = day(x.usage_date);
            if (x.provider !== a.p_provider || x.reporting_period !== a.p_period || d < day(a.p_from) || d > day(a.p_date)) return;
            const r = m.get(x.iccid) || { mb: 0, days: new Set() }; r.mb += +x.used_mb; r.days.add(d); m.set(x.iccid, r);
          });
          const o = {}; m.forEach((r, k) => { o[k] = [r.mb, r.days.size]; });
          return { data: o, error: null };
        }
      }
      if (name === 'replace_provider_period') {
        replacePeriod(a.p_provider, a.p_period, a.p_meta, a.p_monthly, a.p_daily);
        save(); return { data: null, error: null };
      }
      if (name === 'delete_provider_period') {
        const same = x => x.provider === a.p_provider && x.reporting_period === a.p_period;
        const n = T('provider_sim_usage_daily').filter(same).length + T('provider_sim_usage_monthly').filter(same).length;
        ['provider_sim_usage_daily', 'provider_sim_usage_monthly', 'provider_periods'].forEach(t => { db.tables[t] = T(t).filter(x => !same(x)); });
        T('upload_batches').filter(x => same(x) && x.status === 'success').forEach(x => { x.status = 'deleted'; x.details = Object.assign({}, x.details, { deleted_at: new Date().toISOString(), deleted_by: USER.email }); });
        save(); return { data: n, error: null };
      }
      if (name === 'replace_provider_sims') {
        db.tables.provider_sims = T('provider_sims').filter(x => x.provider !== a.p_provider);
        (a.p_rows || []).forEach(x => T('provider_sims').push(Object.assign({ provider: a.p_provider, upload_batch_id: a.p_batch, as_of: a.p_as_of }, x)));
        save(); return { data: (a.p_rows || []).length, error: null };
      }
      if (name === 'search_sims') {                          // sql/005_sim_search.sql — same keys, ranks and limits
        if (no005) return noFn(name);
        const kOf = v => String(v == null ? '' : v).replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/[UF]+$/, '');
        const dOf = v => String(v == null ? '' : v).replace(/[^0-9]/g, '');
        const k = kOf(a.p_q), d = /^[0-9]+$/.test(kOf(a.p_q)) ? dOf(a.p_q) : '', lim = Math.min(Math.max(+a.p_limit || 20, 1), 100);
        if (k.length < 4) return { data: { results: [], more: false, too_short: true }, error: null };
        const best = new Map();
        const put = (s, rank) => { const key = s.provider + '|' + s.iccid, o = best.get(key); if (!o || rank < o.rank) best.set(key, { s, rank }); };
        // partial branches: the first lim + 1 by SIM number, as the SQL orders them
        const branch = (rank, test, cap) => { let hits = T('provider_sims').filter(test); if (cap) hits = hits.sort((x, y) => kOf(x.iccid).localeCompare(kOf(y.iccid))).slice(0, lim + 1); hits.forEach(s => put(s, rank)); };
        branch(1, s => kOf(s.iccid) === k);
        branch(2, s => { const m = dOf(s.msisdn); return m !== '' && ((d.length >= 4 && m === d) || (d.length >= 10 && d.length <= 13 && m.slice(-10) === d.slice(-10))); });
        branch(3, s => d.length >= 4 && dOf(s.imsi) === d);
        branch(4, s => kOf(s.iccid).startsWith(k) && kOf(s.iccid) !== k, true);
        branch(5, s => kOf(s.iccid).includes(k) && !kOf(s.iccid).startsWith(k), true);
        branch(6, s => d.length >= 4 && (dOf(s.msisdn).includes(d) || dOf(s.imsi).includes(d)), true);
        const pName = c => { const p = T('providers').find(x => x.code === c); return p ? p.name : c; };
        const all = [...best.values()].sort((x, y) => x.rank - y.rank || String(x.s.provider).localeCompare(String(y.s.provider)) || String(x.s.iccid).localeCompare(String(y.s.iccid)));
        const results = all.slice(0, lim).map(({ s, rank }) => ({ provider: s.provider, provider_name: pName(s.provider), iccid: s.iccid, msisdn: s.msisdn || null,
          imsi: s.imsi || null, circle: s.circle || null, lifecycle_state: s.lifecycle_state || null, status: s.status || null, plan_name: s.plan_name || null,
          plan_gb: s.plan_gb == null ? null : +s.plan_gb, plan_price: s.plan_price == null ? null : +s.plan_price, pooled: !!s.pooled,
          activated_at: s.activated_at || null, as_of: s.as_of || null, rank }));
        return { data: { results, more: all.length > lim, too_short: false }, error: null };
      }
      return { data: null, error: { message: 'Unknown mock RPC ' + name } };
    });
  }

  const session = { access_token: 'mock', user: USER };
  const auth = {
    getSession: async () => ({ data: { session }, error: null }),
    getUser: async () => ({ data: { user: USER }, error: null }),
    signInWithPassword: async () => ({ data: { session, user: USER }, error: null }),
    signInWithOtp: async () => ({ data: {}, error: null }),
    resetPasswordForEmail: async () => ({ data: {}, error: null }),
    updateUser: async () => ({ data: { user: USER }, error: null }),
    refreshSession: async () => ({ data: { session }, error: null }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  const client = { from: t => new Query(t), rpc, auth, __mock: true, __db: db, __stats: stats, __reset() { localStorage.removeItem(KEY); } };

  window.supabase = window.supabase || {};
  window.supabase.createClient = () => client;   // index.html's own createClient() fallback also gets the mock
  window.sb = client;
  window.SB_URL = 'mock://supabase'; window.SB_ANON_KEY = 'mock';
  console.info('%c[mock-supabase] LOCAL MOCK DATABASE — nothing is sent to Supabase', 'color:#FF7B00;font-weight:bold');
})();
