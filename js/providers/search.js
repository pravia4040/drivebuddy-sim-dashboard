/* ============================================================
   providers/search.js — universal SIM search (every provider)
   ------------------------------------------------------------
   One search bar in the header finds a SIM whatever provider the
   dashboard is filtered to — the filter is never changed by a search.

     search  normalise the input (spaces, hyphens, "+", "~", trailing
             F/U padding) → look the SIM up in every provider's SIM list
             → the provider comes from the record it is found in (never
             from the number) → the status exactly as that provider
             reports it → that provider's own details (cfg.ui.searchCard)
             and full view (its SIM page or vehicle analysis).

   Where it looks:
     database  search_sims() — sql/005_sim_search.sql — over provider_sims,
               the common SIM table (provider → providers). Indexed; RLS
               applies, so a user finds only SIMs they may read.
     browser   every provider's directory() — the SIMs this dashboard has
               already loaded (nothing extra is downloaded). Used when 005
               is not run, and for SIMs not in the database yet.

   Keeping the common table complete: a provider whose own uploads do not
   write provider_sims (Airtel — its SIMs live in the real-time portal
   snapshot and monthly files) declares directorySync(); an Admin's
   dashboard writes its directory() there whenever its data changes.

   A new provider (Jio …) is found as soon as its SIMs are in provider_sims
   (or it has a directory() hook). Nothing here names a provider.
   ============================================================ */
(function () {
  'use strict';
  const P = window.Providers;
  if (!P) return;
  const C = () => window.ProviderCloud || null;
  const canEdit = () => typeof EDIT_MODE !== 'undefined' && !!EDIT_MODE;   // eslint-disable-line no-undef -- index.html global

  /* ── normalising: the same rule as sql/005_sim_search.sql ──── */
  const key = v => String(v == null ? '' : v).replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/[UF]+$/, '');
  const digits = v => String(v == null ? '' : v).replace(/[^0-9]/g, '');
  const MIN = 4;
  const MATCH = { 1: 'Exact SIM number', 2: 'Exact mobile number', 3: 'Exact IMSI', 4: 'SIM number starts with', 5: 'SIM number contains',
    6: 'Mobile / IMSI contains', 7: 'Vehicle or device' };
  // the numeric part searches mobile numbers and IMSIs only when the input is a number (not inside "GJ01AB1234")
  const queryOf = q => { const k = key(q); return { k, d: /^[0-9]+$/.test(k) ? digits(q) : '' }; };
  function rankOf(e, k, d) {
    if (e.ik === k) return 1;
    // the whole mobile number (M2M numbers run to 13–15 digits), or a 10-13 digit one by its last 10 digits (± country code)
    if (e.md && d.length >= MIN && (e.md === d || (d.length >= 10 && d.length <= 13 && e.md.slice(-10) === d.slice(-10)))) return 2;
    if (d.length >= MIN && e.id && e.id === d) return 3;
    if (e.ik.startsWith(k)) return 4;
    if (e.ik.includes(k)) return 5;
    if (d.length >= MIN && ((e.md && e.md.includes(d)) || (e.id && e.id.includes(d)))) return 6;
    return 0;
  }
  const order = (a, b) => a.rank - b.rank || String(a.provider).localeCompare(String(b.provider)) || key(a.iccid).localeCompare(key(b.iccid));

  /* ── the SIMs this browser holds (each provider's directory) ── */
  const dirCache = new Map();
  function entriesOf(cfg) {
    const ds = P.raw(cfg.code), sig = [ds, ds.CD, ds.rtRows];
    const c = dirCache.get(cfg.code);
    if (c && c.sig.every((x, i) => x === sig[i])) return c.entries;
    let list = [];
    try { list = cfg.directory() || []; } catch (e) { console.warn('[sim-search] directory of ' + cfg.code, e); }
    const entries = list.filter(r => r && r.iccid).map(r => ({ r, ik: key(r.iccid), md: digits(r.msisdn), id: digits(r.imsi) }));
    dirCache.set(cfg.code, { sig, entries });
    return entries;
  }
  function memorySearch(q, limit) {
    const { k, d } = queryOf(q), lim = limit || 20;
    if (k.length < MIN) return { results: [], more: false, too_short: true };
    const best = new Map();
    P.list().forEach(cfg => {
      if (typeof cfg.directory !== 'function') return;
      entriesOf(cfg).forEach(e => {
        const rank = rankOf(e, k, d); if (!rank) return;
        const id = cfg.code + '|' + e.ik, o = best.get(id);
        if (!o || rank < o.rank) best.set(id, Object.assign({}, e.r, { provider: cfg.code, provider_name: cfg.name, rank, src: 'browser' }));
      });
    });
    const all = [...best.values()].sort(order);
    return { results: all.slice(0, lim), more: all.length > lim, too_short: false };
  }

  /* ── vehicles: the fleet (vehicle master) is provider-independent ── */
  let fleetIdx = { src: null, map: new Map() };
  function fleetIndex() {
    const list = P.fleet();
    if (fleetIdx.src !== list) {
      const m = new Map(); list.forEach(v => { const k = key(v.sim); if (k && !m.has(k)) m.set(k, v); });
      fleetIdx = { src: list, map: m };
    }
    return fleetIdx.map;
  }
  // the vehicle a SIM is fitted to: by SIM number, mobile number (with or without 91) or IMSI
  function vehicleOf(rec) {
    const m = fleetIndex(), md = digits(rec.msisdn);
    return m.get(key(rec.iccid)) || (md && (m.get(md) || (md.length === 12 && md.startsWith('91') ? m.get(md.slice(2)) : null)))
      || (rec.imsi ? m.get(key(rec.imsi)) : null) || null;
  }
  // a vehicle number or device ID typed in: exact matches only (never a broad search)
  function fleetHits(q) {
    const k = key(q); if (k.length < MIN) return [];
    return P.fleet().filter(v => v.sim && [v.reg, v.hw_id, v.device_id].some(x => x && key(x) === k)).slice(0, 5);
  }

  /* ── the search ──────────────────────────────────────────── */
  // { results, more, too_short, source: 'database' | 'browser', reason, unlisted: [{ reg, sim }] }
  async function search(q, opts) {
    const limit = Math.min(Math.max((opts && opts.limit) || 20, 1), 100);
    if (queryOf(q).k.length < MIN) return { results: [], more: false, too_short: true, source: 'none', unlisted: [] };
    const run = async (text, lim) => {
      let db = null;
      const c = C();
      if (c && c.searchSims) { try { db = await c.searchSims(text, lim); } catch (e) { console.warn('[sim-search] database search failed — using the SIMs in this browser', e); } }
      const mem = memorySearch(text, lim);
      if (!db) return { results: mem.results, more: mem.more, source: 'browser' };
      // the database first; SIMs this browser holds that the database has not (an upload not saved, an index not
      // brought up to date yet) are added — all of them when the database list is complete, else exact matches only
      const seen = new Set(db.results.map(r => r.provider + '|' + key(r.iccid)));
      const extra = mem.results.filter(r => !seen.has(r.provider + '|' + key(r.iccid)) && (!db.more || r.rank <= 3));
      const all = db.results.map(r => Object.assign({}, r, { src: 'database' })).concat(extra).sort(order);
      return { results: all.slice(0, lim), more: db.more || mem.more || all.length > lim, source: 'database' };
    };
    const res = await run(q, limit);
    // a vehicle number / device ID: that vehicle's SIM, in whichever provider lists it
    const unlisted = [];
    for (const v of fleetHits(q)) {
      if (res.results.some(r => key(r.iccid) === key(v.sim))) continue;
      const hit = (await run(v.sim, 5)).results.filter(r => r.rank === 1);
      if (!hit.length) { unlisted.push({ reg: v.reg, sim: v.sim }); continue; }
      hit.forEach(r => res.results.push(Object.assign(r, { rank: 7, via: v.reg })));
    }
    res.unlisted = unlisted;
    res.too_short = false;
    res.reason = res.source === 'browser' ? ((C() && C().search && C().search.reason) || 'The database search is not available — searching the SIMs loaded in this dashboard') : '';
    return res;
  }

  /* ── keeping the common SIM table complete (Admin) ───────── */
  // A provider that declares directorySync(): its directory({ forSync }) is written to provider_sims when it differs
  // from what is stored there. Only an Admin's dashboard writes (RLS: admin write); never an empty list over a stored one.
  const syncTimers = {}, syncState = {};
  const sig = r => [key(r.iccid), r.lifecycle_state || '', digits(r.msisdn), r.plan_name || ''].join('|');
  const localStamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  async function syncDirectory(code) {
    const cfg = P.get(code), c = C();
    if (!cfg || typeof cfg.directorySync !== 'function' || typeof cfg.directory !== 'function' || !cfg.directorySync()) return { synced: false, reason: 'no sync' };
    if (!canEdit() || !c || !c.state || !c.state.ready || !c.loadDirectory || !c.saveInventory) return { synced: false, reason: 'not an admin session with a cloud' };
    const list = cfg.directory({ forSync: true }) || [];
    if (!list.length) return { synced: false, reason: 'empty' };
    const stored = await c.loadDirectory(code);
    if (!stored) return { synced: false, reason: 'could not read the stored list' };
    const mine = new Set(list.map(sig));
    if (stored.length === mine.size && stored.every(r => mine.has(sig(r)))) { syncState[code] = { at: localStamp(), n: list.length, changed: false }; return { synced: true, changed: false }; }
    const r = await c.saveInventory(code, { as_of: localStamp(), sims: list.map(x => ({ iccid: x.iccid, msisdn: x.msisdn || null, imsi: x.imsi || null,
      circle: x.circle || null, lifecycle_state: x.lifecycle_state || null, status: x.status || null, deal_name: x.plan_name || null,
      plan_gb: x.plan_gb == null ? null : x.plan_gb, plan_price: x.plan_price == null ? null : x.plan_price, pooled: !!x.pooled,
      activated_at: x.activated_at || null })) }, null);
    if (!r.saved) { console.warn('[sim-search] ' + code + ' SIM list not saved for the search:', (r.error && r.error.message) || r.reason); return { synced: false, reason: 'save failed' }; }
    syncState[code] = { at: localStamp(), n: list.length, changed: true };
    console.info(`[sim-search] ${cfg.name}: ${list.length} SIMs written to the common SIM table for the search`);
    return { synced: true, changed: true };
  }
  P.onDataChange(code => {
    dirCache.delete(code);
    clearTimeout(syncTimers[code]);
    syncTimers[code] = setTimeout(() => { syncDirectory(code).catch(e => console.warn('[sim-search] sync ' + code, e)); }, 4000);
  });

  /* ── UI ──────────────────────────────────────────────────── */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortDate = s => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${+m[3]} ${MON[+m[2] - 1]} ${m[1]}` : ''; };
  const cfgOf = rec => P.get(rec.provider) || { code: rec.provider, name: rec.provider_name || rec.provider, short: rec.provider_name || rec.provider, color: '#94a3b8', ui: null };
  const nameOf = rec => rec.provider_name || cfgOf(rec).name;
  const shortOf = rec => { const c = P.get(rec.provider); return c ? c.short : nameOf(rec); };
  const statusOf = rec => rec.lifecycle_state || rec.status || null;
  // colour only — the words are always the provider's own
  const stCls = s => !s ? 'none' : /^(active|activated|live|connected)$/i.test(s) ? 'ok' : /ready|available|inventory|test/i.test(s) ? 'info'
    : /safe|dunning|suspend|hold|grace|pending/i.test(s) ? 'warn' : /disconnect|deactiv|terminat|block|barr|cancel|closed|churn/i.test(s) ? 'bad' : 'none';
  const provBadge = rec => `<span class="ss-pb" style="--pc:${esc(cfgOf(rec).color || '#94a3b8')}"><i aria-hidden="true"></i>${esc(shortOf(rec))}</span>`;
  const stBadge = rec => { const s = statusOf(rec); return `<span class="ss-st ${stCls(s)}">${esc(s || 'No status')}</span>`; };
  const RECENT = 'dbai_sim_search_recent';
  const recentList = () => { try { return JSON.parse(localStorage.getItem(RECENT) || '[]') || []; } catch (e) { return []; } };
  function remember(rec) {
    try {
      const l = recentList().filter(x => !(x.provider === rec.provider && key(x.iccid) === key(rec.iccid)));
      l.unshift({ iccid: rec.iccid, provider: rec.provider, provider_name: nameOf(rec), status: statusOf(rec) });
      localStorage.setItem(RECENT, JSON.stringify(l.slice(0, 6)));
    } catch (e) { /* private window: no recent list */ }
  }

  const ui = { root: null, input: null, panel: null, mode: 'idle', q: '', res: null, items: [], sel: -1, cur: null, seq: 0, timer: null, fromList: false };
  const $p = () => ui.panel;
  // the panel stays inside the window: shifted left when the search box sits near the right edge
  function place() {
    if (!ui.panel || !ui.root) return;
    const vw = document.documentElement.clientWidth, r = ui.root.getBoundingClientRect(), w = ui.panel.offsetWidth;
    ui.panel.style.left = Math.min(0, vw - 16 - r.left - w) + 'px';
  }
  function open() { if (!ui.panel) return; ui.panel.hidden = false; ui.input.setAttribute('aria-expanded', 'true'); place(); }
  function close() { if (!ui.panel) return; ui.panel.hidden = true; ui.input.setAttribute('aria-expanded', 'false'); ui.sel = -1; ui.input.removeAttribute('aria-activedescendant'); }
  const sourceLine = res => (!res ? '' : res.source === 'database'
    ? 'Searched every provider’s SIM list in the database'
    : `Searched the SIMs loaded in this dashboard — ${esc(res.reason || '')}`);
  const filterNote = rec => {
    const sel = P.selected();
    if (!sel || sel === 'all' || sel === rec.provider) return '';
    const fc = P.get(sel);
    return `<div class="ss-fnote">Dashboard filter: <b>${esc(fc ? fc.short : sel)}</b> · this SIM belongs to <b>${esc(shortOf(rec))}</b> — the filter is unchanged.</div>`;
  };

  function itemHtml(rec, i, compact) {
    const v = vehicleOf(rec);
    return `<button type="button" class="ss-item${ui.sel === i ? ' on' : ''}" role="option" id="ss-o${i}" aria-selected="${ui.sel === i}" data-i="${i}">
      <span class="ss-main"><span class="ss-sim">${esc(rec.iccid)}</span>
      <span class="ss-meta">${provBadge(rec)} ${stBadge(rec)}${v && v.reg ? ` <span>🚚 ${esc(v.reg)}</span>` : ''}${rec.via ? ` <span>via ${esc(rec.via)}</span>` : ''}</span></span>
      ${compact ? '' : `<span class="ss-why">${esc(MATCH[rec.rank] || '')}</span>`}</button>`;
  }
  function render() {
    const p = $p(); if (!p) return;
    const q = esc(ui.input.value.trim());
    let html = '';
    if (ui.mode === 'recent') {
      const l = recentList();
      html = l.length ? `<div class="ss-h">Recent SIM searches</div><div role="listbox" aria-label="Recent SIM searches">${l.map((r, i) => itemHtml(r, i, true)).join('')}</div>
        <div class="ss-foot"><button type="button" class="ss-link" data-act="clear-recent">Clear recent searches</button></div>`
        : `<div class="ss-hint">Search any SIM — Airtel, VI or any other provider — by SIM number / ICCID, mobile number or IMSI. Press <kbd>/</kbd> to search from anywhere.</div>`;
      ui.items = l;
    } else if (ui.mode === 'short') {
      html = `<div class="ss-hint">Type at least ${MIN} digits of the SIM number, ICCID or mobile number.</div>`; ui.items = [];
    } else if (ui.mode === 'loading') {
      html = `<div class="ss-load" role="status"><span class="ss-spin" aria-hidden="true"></span> Searching SIMs…</div>`; ui.items = [];
    } else if (ui.mode === 'list') {
      const r = ui.res, n = r.results.length;
      ui.items = r.results;
      html = `<div class="ss-h" role="status">${r.more ? `First ${n} SIMs matching “${q}” — type more digits to narrow it` : `${n} SIM${n === 1 ? '' : 's'} match “${q}”`}</div>
        <div role="listbox" aria-label="Matching SIMs">${r.results.map((x, i) => itemHtml(x, i, false)).join('')}</div>
        ${unlistedHtml(r)}<div class="ss-foot">${sourceLine(r)}</div>`;
    } else if (ui.mode === 'empty') {
      ui.items = [];
      html = `<div class="ss-empty" role="status"><div class="ss-empty-t">SIM not found</div>No SIM matching <b class="mono">${q}</b> in any provider’s SIM list.<br>Please check the SIM number and try again.</div>
        ${unlistedHtml(ui.res)}<div class="ss-foot">${sourceLine(ui.res)}</div>`;
    } else if (ui.mode === 'card' && ui.cur) {
      ui.items = [];
      html = cardHtml(ui.cur);
    }
    p.innerHTML = html;
    if (ui.sel >= 0 && ui.items.length) ui.input.setAttribute('aria-activedescendant', 'ss-o' + ui.sel); else ui.input.removeAttribute('aria-activedescendant');
  }
  const unlistedHtml = r => (r && r.unlisted && r.unlisted.length ? r.unlisted.map(u =>
    `<div class="ss-fnote">Vehicle <b>${esc(u.reg)}</b> has SIM <span class="mono">${esc(u.sim)}</span> in the vehicle master — no provider’s SIM list has this SIM, so its provider is not known.</div>`).join('') : '');

  function cardHtml(rec) {
    const cfg = cfgOf(rec), v = vehicleOf(rec), st = statusOf(rec);
    let card = null;
    const f = cfg.ui && typeof cfg.ui.searchCard === 'function' ? cfg.ui.searchCard : null;
    if (f) { try { card = f(rec); } catch (e) { console.warn('[sim-search] ' + cfg.code + ' details', e); } }
    // a provider's own row replaces the common row of the same name (its words are the more precise ones)
    const own = new Map(card ? card.rows.map(r => [r[0], r[1]]) : []);
    const row = (k, v2) => (own.has(k) ? '' : `<dt>${esc(k)}</dt><dd>${v2}</dd>`);
    const stTxt = st ? `${stBadge(rec)} <span class="ss-dim">as ${esc(nameOf(rec))} reports it${rec.status && rec.lifecycle_state && rec.status !== rec.lifecycle_state ? ` · normalised: ${esc(rec.status)}` : ''}</span>`
      : `${stBadge(rec)} <span class="ss-dim">${esc(rec.seen_in && rec.seen_in.length === 1 && rec.seen_in[0] === 'portal'
        ? `${nameOf(rec)}’s real-time portal export has no status column` : `${nameOf(rec)}’s files give no status for this SIM`)}</span>`;
    const plan = rec.plan_name || rec.plan_gb ? `${esc(rec.plan_name || '')}${rec.plan_gb ? `${rec.plan_name ? ' · ' : ''}${esc(rec.plan_gb)} GB` : ''}` : '';
    const veh = v ? `${esc(v.reg || '—')}${v.client ? ` · ${esc(v.client)}` : ''}` : '<span class="ss-dim">No vehicle in the vehicle master</span>';
    const src = rec.src === 'database'
      ? `In the common SIM list${rec.as_of ? ` · ${esc(cfg.short || nameOf(rec))} list of ${esc(shortDate(rec.as_of))}` : ''}`
      : rec.src === 'browser' && ui.res && ui.res.source === 'database' ? 'Found in the data loaded in this dashboard — not in the database SIM list yet' : 'Found in the data loaded in this dashboard';
    const back = ui.fromList && ui.res && ui.res.results.length > 1 ? `<button type="button" class="ss-link" data-act="back">← ${ui.res.results.length} results</button>` : '';
    const others = !ui.fromList && ui.res && ui.res.results.length > 1 ? `<button type="button" class="ss-link" data-act="back">${ui.res.results.length - 1} other match${ui.res.results.length > 2 ? 'es' : ''} →</button>` : '';
    const acts = [];
    if (card && card.open) acts.push(`<button type="button" class="or-btn ss-open" data-act="full">${esc(card.openLabel || `Open ${shortOf(rec)} SIM details`)}</button>`);
    acts.push('<button type="button" class="ss-btn" data-act="copy">Copy SIM number</button>');
    return `<div class="ss-card" role="region" aria-label="SIM details">
      <div class="ss-card-top"><span class="ss-found">SIM found</span>${back}${others}</div>
      <div class="ss-card-h"><span class="ss-sim ss-big">${esc(rec.iccid)}</span><span class="ss-meta">${provBadge(rec)} ${stBadge(rec)}</span></div>
      <dl class="ss-dl">
        ${row('SIM number', `<span class="mono">${esc(rec.iccid)}</span>`)}
        ${row('Provider', `${provBadge(rec)} <span class="ss-dim">from its SIM record</span>`)}
        ${row('Status', stTxt)}
        ${rec.msisdn ? row('Mobile number', `<span class="mono">${esc(rec.msisdn)}</span>`) : ''}
        ${rec.imsi ? row('IMSI', `<span class="mono">${esc(rec.imsi)}</span>`) : ''}
        ${plan ? row('Plan', plan) : ''}
        ${rec.activated_at && !(card && card.rows.some(r => /^activation/i.test(r[0]))) ? row('Activation date', esc(shortDate(rec.activated_at))) : ''}
        ${row('Vehicle', veh)}
        ${v && v.hw_id ? row('Device', `<span class="mono">${esc(v.hw_id)}</span>`) : ''}
        ${rec.via ? row('Found via', `vehicle / device ${esc(rec.via)}`) : ''}
        ${rec.note ? row('Note', esc(rec.note)) : ''}
        ${card ? card.rows.map(r => `<dt>${esc(r[0])}</dt><dd>${esc(r[1])}</dd>`).join('') : ''}
      </dl>
      ${card ? (card.notes || []).map(n => `<div class="ss-note ${esc(n.level)}" role="alert">${esc(n.text)}</div>`).join('') : ''}
      ${filterNote(rec)}
      <div class="ss-acts">${acts.join('')}</div>
      ${card && !card.open && card.noOpen ? `<div class="ss-dim ss-small">${esc(card.noOpen)}</div>` : ''}
      ${!card ? `<div class="ss-dim ss-small">${esc(nameOf(rec))} has no detail view in this dashboard yet.</div>` : ''}
      <div class="ss-foot">${src}</div></div>`;
  }

  function showCard(rec, fromList) {
    ui.cur = rec; ui.fromList = !!fromList; ui.mode = 'card'; ui.sel = -1;
    remember(rec); render(); open();
  }
  async function run(q, limit, how) {
    const my = ++ui.seq;
    ui.mode = 'loading'; ui.sel = -1; render(); open();
    let res;
    try { res = await search(q, { limit }); } catch (e) { console.warn('[sim-search]', e); res = { results: [], more: false, source: 'browser', reason: 'The search failed — ' + (e.message || e), unlisted: [] }; }
    if (my !== ui.seq) return;                       // a newer search has started
    ui.res = res;
    const exact = res.results.filter(r => r.rank <= 3);
    if (res.too_short) ui.mode = 'short';
    else if (!res.results.length) ui.mode = 'empty';
    // one exact match → its details at once (never when two providers list the same number — the user picks)
    else if (exact.length === 1 && (res.results.length === 1 || how === 'enter')) { showCard(exact[0], false); return; }
    else ui.mode = 'list';
    render(); open();
  }
  function onInput() {
    clearTimeout(ui.timer);
    const q = ui.input.value.trim();
    if (!q) { ui.seq++; ui.mode = 'recent'; render(); open(); return; }
    if (queryOf(q).k.length < MIN) { ui.seq++; ui.mode = 'short'; render(); open(); return; }
    ui.timer = setTimeout(() => run(q, 8, 'type'), 250);
  }
  function pick(i) {
    const rec = ui.items[i]; if (!rec) return;
    if (ui.mode === 'recent') { ui.input.value = rec.iccid; run(rec.iccid, 20, 'enter'); return; }
    showCard(rec, true);
  }
  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!ui.items.length) return;
      e.preventDefault();
      ui.sel = e.key === 'ArrowDown' ? Math.min(ui.items.length - 1, ui.sel + 1) : Math.max(0, ui.sel - 1);
      render(); open();
      const el = document.getElementById('ss-o' + ui.sel); if (el) el.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (ui.sel >= 0 && ui.items[ui.sel]) { pick(ui.sel); return; }
      const q = ui.input.value.trim(); clearTimeout(ui.timer);
      if (q) run(q, 50, 'enter');
    }
  }
  function onPanelClick(e) {
    const it = e.target.closest('.ss-item');
    if (it) { pick(+it.dataset.i); return; }
    const a = e.target.closest('[data-act]'); if (!a) return;
    const act = a.dataset.act;
    if (act === 'clear-recent') { try { localStorage.removeItem(RECENT); } catch (x) { /* ignore */ } render(); return; }
    if (act === 'back') { ui.mode = 'list'; ui.sel = -1; render(); return; }
    if (act === 'copy' && ui.cur) {
      const t = ui.cur.iccid, done = () => { a.textContent = 'Copied ✓'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, () => {}); else done();
      return;
    }
    if (act === 'full' && ui.cur) {
      const cfg = cfgOf(ui.cur), card = cfg.ui && cfg.ui.searchCard ? cfg.ui.searchCard(ui.cur) : null;
      close();
      if (card && card.open) card.open();
    }
  }

  function mount() {
    const host = document.getElementById('sim-search');
    if (!host || ui.root) return;
    host.innerHTML = `<div class="ss-box"><span class="ss-ico" aria-hidden="true">🔍</span>
        <input type="search" class="ss-in" id="ss-input" placeholder="Search SIM number, ICCID or mobile…" autocomplete="off" spellcheck="false"
          role="combobox" aria-expanded="false" aria-controls="ss-panel" aria-autocomplete="list" aria-label="Search any SIM across all providers">
        <kbd class="ss-kbd" aria-hidden="true">/</kbd></div>
      <div class="ss-panel" id="ss-panel" hidden></div>`;
    ui.root = host; ui.input = host.querySelector('#ss-input'); ui.panel = host.querySelector('#ss-panel');
    ui.input.addEventListener('input', onInput);
    ui.input.addEventListener('keydown', onKey);
    ui.input.addEventListener('focus', () => { if (!ui.input.value.trim()) { ui.mode = 'recent'; render(); } open(); });
    ui.panel.addEventListener('click', onPanelClick);
    document.addEventListener('mousedown', e => { if (ui.root && !ui.root.contains(e.target)) close(); });
    window.addEventListener('resize', () => { if (ui.panel && !ui.panel.hidden) place(); });
    // "/" searches from any page (not while typing somewhere else)
    document.addEventListener('keydown', e => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target, tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      e.preventDefault(); ui.input.focus(); ui.input.select();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  // search(q) → results; find(q) shows them in the header search (for links elsewhere)
  function find(q) { if (!ui.input) return; ui.input.value = q; ui.input.focus(); run(q, 50, 'enter'); }
  window.SimSearch = { key, digits, rankOf, queryOf, memorySearch, search, vehicleOf, fleetHits, syncDirectory, syncState, find, MATCH, MIN };
})();
