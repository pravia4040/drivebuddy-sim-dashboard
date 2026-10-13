-- =====================================================================
-- 002_vi_pool.sql — drivebuddyAI SIM dashboard: VI pool history + rules
-- ---------------------------------------------------------------------
-- Run AFTER 001_multi_provider.sql. ADDITIVE ONLY: no Airtel table, no
-- existing column, policy or row is changed. Re-runnable.
--
--   provider_sim_snapshots  every SIM Group export (one row per SIM per
--                           export) — the SIM state history. A SIM seen
--                           "Ready" in an older export and "active" in a
--                           newer one started in between: VI keeps the
--                           day it was loaded as DATE_OF_ACTIVATION, so
--                           the dashboard detects its real start from
--                           this history.
--   provider_cycle_pool     one row per closed billing cycle: the pool
--                           frozen with the first SIM Group exported on
--                           or after the cycle's last day (per-SIM
--                           allocations in `sims`). Newer SIM Groups do
--                           not change it; an admin can recompute it.
--   provider_sim_usage_monthly + summary_session_days, summary_last_session_at
--                           the Summary's own session figures (go-live bound),
--                           and replace_provider_period() that saves them
--   providers.config        VI pool rules (which SIM states count, plan
--                           days, data-pool deal tag) — editable from the
--                           Data Pool tab by an admin.
--
-- Without this script the dashboard still works; SIM Group history and
-- frozen cycles are then kept for the browser session only.
-- Rollback: 002_vi_pool_rollback.sql
-- =====================================================================

-- ── SIM Group history ─────────────────────────────────────────────────
create table if not exists public.provider_sim_snapshots (
  provider         text not null references public.providers(code),
  snapshot_at      timestamp not null,     -- export time, from the file name (…_YYYYMMDDHHMMSS.csv)
  iccid            text not null,
  msisdn           text,
  imsi             text,
  lifecycle_state  text,                   -- exactly as VI writes it (active, Ready, Dunning, suspend …)
  plan_name        text,                   -- DEAL_NAME
  base_plan_name   text,
  plan_gb          numeric,
  plan_price       numeric,
  activated_at     timestamp,              -- DATE_OF_ACTIVATION (the day the SIM was loaded on the account)
  upload_batch_id  uuid references public.upload_batches(id) on delete set null,
  primary key (provider, snapshot_at, iccid)
);
create index if not exists provider_sim_snapshots_sim on public.provider_sim_snapshots (provider, iccid, snapshot_at);

-- ── frozen pools of closed cycles ─────────────────────────────────────
create table if not exists public.provider_cycle_pool (
  provider           text not null references public.providers(code),
  reporting_period   text not null,        -- VI: month the 22nd → 21st cycle ends in ('Sep 2026')
  cycle_start        date not null,
  cycle_end          date not null,
  snapshot_at        timestamp,            -- the SIM Group export it was built from
  total_sims         int,
  eligible_sims      int,
  non_eligible_sims  int,
  full_gb            numeric,
  prorated_gb        numeric,
  pool_gb            numeric,
  used_gb            numeric,              -- at the time it was frozen; the dashboard shows live usage
  remaining_gb       numeric,
  utilisation_pct    numeric,
  data_until         date,
  new_activations    int,
  new_activation_gb  numeric,
  status_counts      jsonb not null default '{}'::jsonb,   -- { "active": {sims, pool_sims, pool_gb}, … }
  rules              jsonb not null default '{}'::jsonb,   -- the rules it was computed with
  sims               jsonb not null default '{}'::jsonb,   -- { iccid: {state, eligible, start, gb, days, …} }
  frozen             boolean not null default true,
  computed_at        timestamptz not null default now(),
  computed_by        text default (auth.jwt() ->> 'email'),
  primary key (provider, reporting_period)
);

-- ── the Summary's own session figures per SIM × circle ────────────────
-- session_days / last_session_at hold the merged values (the Itemized report's day count when both reports
-- have the SIM). The go-live bound of a SIM that was Ready (last session − session days + 1) needs the
-- Summary's own pair, so it is kept apart.
alter table public.provider_sim_usage_monthly add column if not exists summary_session_days int;
alter table public.provider_sim_usage_monthly add column if not exists summary_last_session_at timestamp;

create or replace function public.replace_provider_period(
  p_provider text, p_period text, p_meta jsonb, p_monthly jsonb, p_daily jsonb default null)
returns void language plpgsql security invoker set search_path = public as $$
begin
  insert into provider_periods as pp (provider, reporting_period, period_start, period_end, last_data_date,
         has_summary, has_itemized, summary_batch_id, itemized_batch_id, summary_mb, itemized_mb, reconciliation, updated_at)
  values (p_provider, p_period,
         nullif(p_meta ->> 'period_start', '')::date, nullif(p_meta ->> 'period_end', '')::date,
         nullif(p_meta ->> 'last_data_date', '')::date,
         coalesce((p_meta ->> 'has_summary')::boolean, false), coalesce((p_meta ->> 'has_itemized')::boolean, false),
         nullif(p_meta ->> 'summary_batch_id', '')::uuid, nullif(p_meta ->> 'itemized_batch_id', '')::uuid,
         nullif(p_meta ->> 'summary_mb', '')::numeric, nullif(p_meta ->> 'itemized_mb', '')::numeric,
         coalesce(p_meta -> 'reconciliation', '{}'::jsonb), now())
  on conflict (provider, reporting_period) do update set
         period_start = excluded.period_start, period_end = excluded.period_end,
         last_data_date = excluded.last_data_date, has_summary = excluded.has_summary,
         has_itemized = excluded.has_itemized, summary_batch_id = excluded.summary_batch_id,
         itemized_batch_id = excluded.itemized_batch_id, summary_mb = excluded.summary_mb,
         itemized_mb = excluded.itemized_mb, reconciliation = excluded.reconciliation, updated_at = now();

  delete from provider_sim_usage_monthly where provider = p_provider and reporting_period = p_period;
  insert into provider_sim_usage_monthly (provider, reporting_period, iccid, circle, msisdn, imsi, origin_circle,
         summary_mb, itemized_mb, used_mb, session_days, last_session_at, summary_session_days, summary_last_session_at)
  select p_provider, p_period, x.iccid, coalesce(x.circle, ''), x.msisdn, x.imsi, x.origin_circle,
         x.summary_mb, x.itemized_mb, coalesce(x.used_mb, 0), x.session_days, x.last_session_at,
         x.summary_session_days, x.summary_last_session_at
  from jsonb_to_recordset(coalesce(p_monthly, '[]'::jsonb)) as x(
         iccid text, circle text, msisdn text, imsi text, origin_circle text, summary_mb numeric,
         itemized_mb numeric, used_mb numeric, session_days int, last_session_at timestamp,
         summary_session_days int, summary_last_session_at timestamp);

  if p_daily is not null then
    delete from provider_sim_usage_daily where provider = p_provider and reporting_period = p_period;
    insert into provider_sim_usage_daily (provider, reporting_period, iccid, circle, usage_date, used_mb)
    select p_provider, p_period, x.iccid, coalesce(x.circle, ''), x.usage_date, x.used_mb
    from jsonb_to_recordset(p_daily) as x(iccid text, circle text, usage_date date, used_mb numeric);
  end if;
end $$;
revoke all on function public.replace_provider_period(text, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.replace_provider_period(text, text, jsonb, jsonb, jsonb) to authenticated;

-- ── default VI pool rules (decided with the account owner, 6 Oct 2026) ─
-- Only "active" SIMs on data-pool deals (_DP_) count. Not overwritten when already set.
update public.providers
   set config = config || jsonb_build_object('pool_rules', jsonb_build_object(
         'cycle_start_day', 22, 'plan_days', 30, 'pool_tag', '_DP_',
         'status_rules', jsonb_build_object('active', true, 'ready', false, 'dunning', false, 'suspend', false),
         'prelive_states', jsonb_build_array('ready')))
 where code = 'vi' and not (config ? 'pool_rules');

-- ── Row-level security: read = any active authorised user, write = Admin ──
do $$
declare t text;
begin
  foreach t in array array['provider_sim_snapshots', 'provider_cycle_pool'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "dbai read" on public.%I', t);
    execute format('create policy "dbai read" on public.%I for select to authenticated using (public.dbai_is_active_user())', t);
    execute format('drop policy if exists "dbai admin write" on public.%I', t);
    execute format('create policy "dbai admin write" on public.%I for all to authenticated using (public.dbai_is_admin()) with check (public.dbai_is_admin())', t);
  end loop;
end $$;

-- Done. Verify:
--   select config -> 'pool_rules' from public.providers where code = 'vi';
--   select snapshot_at, count(*) from public.provider_sim_snapshots group by 1 order by 1;
--   select reporting_period, pool_gb, eligible_sims, snapshot_at from public.provider_cycle_pool order by 1;
