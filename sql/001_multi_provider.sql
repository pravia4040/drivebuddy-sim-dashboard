-- =====================================================================
-- 001_multi_provider.sql — drivebuddyAI SIM dashboard: multi-provider
-- ---------------------------------------------------------------------
-- ADDITIVE ONLY. Safe to run while the current (Airtel-only) dashboard is
-- live: no existing column, constraint, policy or row is changed or removed,
-- and the live app keeps reading and writing exactly as before. New provider
-- data (VI, later Jio) lives in NEW tables the old app never reads, so it
-- cannot leak into the live Airtel view.
--
--   providers                   master list: airtel, vi, jio (planned) …
--   upload_batches              every uploaded file — provider, source type,
--                               SHA-256 (duplicate-upload guard), row counts,
--                               validation + reconciliation details
--   provider_periods            one row per provider × billing period
--                               (dates, which sources exist, reconciliation)
--   provider_sims               SIM inventory per provider
--   provider_sim_usage_monthly  usage per provider × period × SIM × circle
--   provider_sim_usage_daily    usage per provider × SIM × circle × day
--   provider_daily_totals       view — daily totals (dashboard cards)
--   provider_period_totals      view — period totals (comparison chart)
--   replace_provider_period()   atomic replace of one provider-period →
--   replace_provider_sims()     re-uploading never double counts
--   legacy Airtel tables get a `provider` tag column, default 'airtel'
--
-- Run in Supabase → SQL Editor. Re-runnable (IF NOT EXISTS everywhere).
-- Rollback: 001_multi_provider_rollback.sql
-- =====================================================================

-- ── Access helpers (mirror the dashboard's authorized_users model) ────
create or replace function public.dbai_is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.authorized_users au
                 where lower(au.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
                   and au.status = 'Active');
$$;
create or replace function public.dbai_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.authorized_users au
                 where lower(au.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
                   and au.status = 'Active' and au.role = 'Admin');
$$;
revoke all on function public.dbai_is_active_user() from public, anon;
revoke all on function public.dbai_is_admin()       from public, anon;
grant execute on function public.dbai_is_active_user() to authenticated;
grant execute on function public.dbai_is_admin()       to authenticated;

-- ── providers ─────────────────────────────────────────────────────────
create table if not exists public.providers (
  id          smallserial primary key,
  code        text not null unique check (code ~ '^[a-z0-9_]+$'),
  name        text not null,
  status      text not null default 'active' check (status in ('active', 'planned', 'disabled')),
  config      jsonb not null default '{}'::jsonb,
  sort_order  int  not null default 100,
  created_at  timestamptz not null default now()
);
insert into public.providers (code, name, status, sort_order) values
  ('airtel', 'Airtel',             'active',  1),
  ('vi',     'VI (Vodafone Idea)', 'active',  2),
  ('jio',    'Jio',                'planned', 3)
on conflict (code) do nothing;

-- ── upload_batches (upload history + duplicate guard) ─────────────────
create table if not exists public.upload_batches (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null references public.providers(code),
  source_type      text not null,   -- vi_usage_summary | vi_usage_itemized | vi_sim_inventory | airtel_monthly | airtel_realtime …
  source_file      text,
  file_hash        text,            -- SHA-256 of the file content
  reporting_period text,            -- 'Sep 2026'
  period_start     date,
  period_end       date,
  total_rows       int,
  valid_rows       int,
  duplicate_rows   int,
  invalid_rows     int,
  total_mb         numeric,
  -- deleted = an admin removed the period; the history row stays and the file may be uploaded again
  status           text not null default 'success' check (status in ('success', 'skipped_duplicate', 'failed', 'deleted')),
  details          jsonb not null default '{}'::jsonb,
  uploaded_by      text default (auth.jwt() ->> 'email'),
  uploaded_at      timestamptz not null default now()
);
-- same rule for a table created by an earlier draft of this script
alter table public.upload_batches drop constraint if exists upload_batches_status_check;
alter table public.upload_batches add constraint upload_batches_status_check
  check (status in ('success', 'skipped_duplicate', 'failed', 'deleted'));
-- the same file can only be ingested once per provider + type
create unique index if not exists upload_batches_one_success_per_file
  on public.upload_batches (provider, source_type, file_hash)
  where status = 'success' and file_hash is not null;
create index if not exists upload_batches_provider_time on public.upload_batches (provider, uploaded_at desc);

-- ── provider_periods (one row per provider × billing period) ──────────
create table if not exists public.provider_periods (
  provider          text not null references public.providers(code),
  reporting_period  text not null,        -- VI: month the 22nd→21st cycle ends in
  period_start      date,
  period_end        date,
  last_data_date    date,
  has_summary       boolean not null default false,
  has_itemized      boolean not null default false,
  summary_batch_id  uuid references public.upload_batches(id) on delete set null,
  itemized_batch_id uuid references public.upload_batches(id) on delete set null,
  summary_mb        numeric,
  itemized_mb       numeric,
  reconciliation    jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now(),
  primary key (provider, reporting_period)
);

-- ── provider_sims (inventory) ─────────────────────────────────────────
create table if not exists public.provider_sims (
  provider         text not null references public.providers(code),
  iccid            text not null,
  msisdn           text,
  imsi             text,
  circle           text,
  lifecycle_state  text,                  -- as reported (active, Ready, suspend, Dunning …)
  status           text,                  -- normalised (Active, Ready, Suspended, Dunning …)
  plan_name        text,
  base_plan_name   text,
  plan_gb          numeric,
  plan_price       numeric,
  pooled           boolean not null default false,
  group_name       text,
  activated_at     timestamp,
  product_type     text,
  upload_batch_id  uuid references public.upload_batches(id) on delete set null,
  as_of            timestamp,
  updated_at       timestamptz not null default now(),
  primary key (provider, iccid)
);
create index if not exists provider_sims_msisdn on public.provider_sims (provider, msisdn);
create index if not exists provider_sims_status on public.provider_sims (provider, status);

-- ── provider_sim_usage_monthly (provider × period × SIM × circle) ─────
create table if not exists public.provider_sim_usage_monthly (
  provider         text not null references public.providers(code),
  reporting_period text not null,
  iccid            text not null,
  circle           text not null default '',
  msisdn           text,
  imsi             text,
  origin_circle    text,
  summary_mb       numeric,               -- from the usage summary (primary)
  itemized_mb      numeric,               -- from the itemized file (reconciliation)
  used_mb          numeric not null default 0,   -- value the dashboard uses
  session_days     int,
  last_session_at  timestamp,
  updated_at       timestamptz not null default now(),
  primary key (provider, reporting_period, iccid, circle),
  foreign key (provider, reporting_period) references public.provider_periods (provider, reporting_period) on delete cascade
);
create index if not exists provider_usage_monthly_sim on public.provider_sim_usage_monthly (provider, iccid);

-- ── provider_sim_usage_daily (provider × SIM × circle × day) ──────────
create table if not exists public.provider_sim_usage_daily (
  provider         text not null references public.providers(code),
  reporting_period text not null,
  iccid            text not null,
  circle           text not null default '',
  usage_date       date not null,
  used_mb          numeric not null,
  primary key (provider, iccid, circle, usage_date),
  foreign key (provider, reporting_period) references public.provider_periods (provider, reporting_period) on delete cascade
);
create index if not exists provider_usage_daily_period on public.provider_sim_usage_daily (provider, reporting_period, usage_date);

-- ── aggregate views (RLS of the base tables applies) ──────────────────
create or replace view public.provider_daily_totals with (security_invoker = true) as
  select provider, reporting_period, usage_date, sum(used_mb) as used_mb, count(distinct iccid) as sims
  from public.provider_sim_usage_daily
  group by provider, reporting_period, usage_date;

create or replace view public.provider_period_totals with (security_invoker = true) as
  select provider, reporting_period, count(distinct iccid) as sims,
         sum(used_mb) as used_mb, sum(summary_mb) as summary_mb, sum(itemized_mb) as itemized_mb
  from public.provider_sim_usage_monthly
  group by provider, reporting_period;

-- ── atomic replace RPCs (security invoker → RLS still applies) ────────
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
         summary_mb, itemized_mb, used_mb, session_days, last_session_at)
  select p_provider, p_period, x.iccid, coalesce(x.circle, ''), x.msisdn, x.imsi, x.origin_circle,
         x.summary_mb, x.itemized_mb, coalesce(x.used_mb, 0), x.session_days, x.last_session_at
  from jsonb_to_recordset(coalesce(p_monthly, '[]'::jsonb)) as x(
         iccid text, circle text, msisdn text, imsi text, origin_circle text, summary_mb numeric,
         itemized_mb numeric, used_mb numeric, session_days int, last_session_at timestamp);

  if p_daily is not null then
    delete from provider_sim_usage_daily where provider = p_provider and reporting_period = p_period;
    insert into provider_sim_usage_daily (provider, reporting_period, iccid, circle, usage_date, used_mb)
    select p_provider, p_period, x.iccid, coalesce(x.circle, ''), x.usage_date, x.used_mb
    from jsonb_to_recordset(p_daily) as x(iccid text, circle text, usage_date date, used_mb numeric);
  end if;
end $$;

create or replace function public.replace_provider_sims(
  p_provider text, p_rows jsonb, p_batch uuid default null, p_as_of timestamp default null)
returns int language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  delete from provider_sims where provider = p_provider;
  insert into provider_sims (provider, iccid, msisdn, imsi, circle, lifecycle_state, status, plan_name,
         base_plan_name, plan_gb, plan_price, pooled, group_name, activated_at, product_type, upload_batch_id, as_of)
  select p_provider, x.iccid, x.msisdn, x.imsi, x.circle, x.lifecycle_state, x.status, x.plan_name,
         x.base_plan_name, x.plan_gb, x.plan_price, coalesce(x.pooled, false), nullif(x.group_name, ''),
         x.activated_at, x.product_type, p_batch, p_as_of
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
         iccid text, msisdn text, imsi text, circle text, lifecycle_state text, status text, plan_name text,
         base_plan_name text, plan_gb numeric, plan_price numeric, pooled boolean, group_name text,
         activated_at timestamp, product_type text);
  get diagnostics n = row_count;
  return n;
end $$;

-- Remove one billing period (a wrong upload): its usage rows go, its upload-history rows are kept but
-- marked 'deleted' so the same files can be uploaded again. Returns the number of usage rows removed.
create or replace function public.delete_provider_period(p_provider text, p_period text)
returns int language plpgsql security invoker set search_path = public as $$
declare n int; m int;
begin
  delete from provider_sim_usage_daily where provider = p_provider and reporting_period = p_period;
  get diagnostics n = row_count;
  delete from provider_sim_usage_monthly where provider = p_provider and reporting_period = p_period;
  get diagnostics m = row_count;
  delete from provider_periods where provider = p_provider and reporting_period = p_period;
  update upload_batches set status = 'deleted',
         details = details || jsonb_build_object('deleted_at', now(), 'deleted_by', auth.jwt() ->> 'email')
   where provider = p_provider and reporting_period = p_period and status = 'success';
  return n + m;
end $$;

revoke all on function public.replace_provider_period(text, text, jsonb, jsonb, jsonb) from public, anon;
revoke all on function public.replace_provider_sims(text, jsonb, uuid, timestamp)    from public, anon;
revoke all on function public.delete_provider_period(text, text)                     from public, anon;
grant execute on function public.replace_provider_period(text, text, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.replace_provider_sims(text, jsonb, uuid, timestamp)    to authenticated;
grant execute on function public.delete_provider_period(text, text)                     to authenticated;

-- ── Row-level security: read = any active authorised user, write = Admin ──
do $$
declare t text;
begin
  foreach t in array array['providers', 'upload_batches', 'provider_periods', 'provider_sims',
                           'provider_sim_usage_monthly', 'provider_sim_usage_daily'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "dbai read" on public.%I', t);
    execute format('create policy "dbai read" on public.%I for select to authenticated using (public.dbai_is_active_user())', t);
    execute format('drop policy if exists "dbai admin write" on public.%I', t);
    execute format('create policy "dbai admin write" on public.%I for all to authenticated using (public.dbai_is_admin()) with check (public.dbai_is_admin())', t);
  end loop;
end $$;

-- ── Tag the legacy Airtel tables (existing rows become provider = 'airtel') ──
-- vehicle_master is intentionally NOT tagged: the fleet is provider-independent.
do $$
declare t text;
begin
  foreach t in array array['monthly_snapshots', 'realtime_snapshots', 'realtime_snapshot'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I add column if not exists provider text not null default ''airtel''', t);
      if not exists (select 1 from pg_constraint where conname = t || '_provider_fk') then
        execute format('alter table public.%I add constraint %I foreign key (provider) references public.providers(code) not valid', t, t || '_provider_fk');
        execute format('alter table public.%I validate constraint %I', t, t || '_provider_fk');
      end if;
      execute format('create index if not exists %I on public.%I (provider)', t || '_provider_idx', t);
    end if;
  end loop;
end $$;

-- Done. Verify:
--   select code, name, status from public.providers order by sort_order;
--   select provider, count(*) from public.monthly_snapshots group by provider;
