-- =====================================================================
-- 004_vi_scale.sql — drivebuddyAI SIM dashboard: uploads and start-up at any
--                    fleet size (hundreds or many thousands of SIMs)
-- ---------------------------------------------------------------------
-- Run AFTER 001_multi_provider.sql, 002_vi_pool.sql and 003_vi_operations.sql.
-- ADDITIVE ONLY: no Airtel table, row or policy is touched. Re-runnable.
--
--   1. Row-level security: the same rules (read = active user, write =
--      Admin), checked once per statement instead of once per row — a big
--      upload no longer runs the check hundreds of thousands of times.
--   2. save_provider_daily: an Itemized upload is saved a few days at a time
--      (only the days that are new or may have grown), each call atomic —
--      never the whole cycle in one call.
--   3. stage_provider_rows + commit_provider_period / commit_provider_sims: the
--      per-SIM monthly rows and the SIM inventory of an upload are sent in
--      chunks, then swapped in one transaction (nobody sees half an upload).
--   4. Read-side summaries computed in the database instead of downloading
--      every row: the list of SIM Group exports, each SIM's state runs (for
--      go-live detection) and per-SIM totals up to a day ("as of" picker).
--   5. provider_pool_snapshots.counted: which SIMs each pool evaluation
--      counted (number + a hash of the ICCIDs started by its data day) — the
--      pace only compares uploads made over the same SIMs.
--
-- Without this script the dashboard still works the 001-003 way (fine for a
-- few hundred SIMs; slow, then failing, as the fleet grows).
-- Rollback: 004_vi_scale_rollback.sql
-- =====================================================================

-- ── 1. RLS checked once per statement (initplan), same rules ──────────
do $$
declare t text;
begin
  foreach t in array array['providers', 'upload_batches', 'provider_periods', 'provider_sims', 'provider_sim_usage_monthly',
                           'provider_sim_usage_daily', 'provider_sim_snapshots', 'provider_cycle_pool',
                           'provider_pool_snapshots', 'provider_alerts'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists "dbai read" on public.%I', t);
    execute format('create policy "dbai read" on public.%I for select to authenticated using ((select public.dbai_is_active_user()))', t);
    execute format('drop policy if exists "dbai admin write" on public.%I', t);
    execute format('create policy "dbai admin write" on public.%I for all to authenticated using ((select public.dbai_is_admin())) with check ((select public.dbai_is_admin()))', t);
  end loop;
end $$;

-- ── 2. daily rows, a few days per call ────────────────────────────────
-- p_clear_days: the days this call replaces (their old rows go first — a SIM with no usage that day must not
-- keep an old figure); p_rows: [{iccid, circle, usage_date, used_mb}]. A day split over several calls is
-- cleared by its first call only.
create or replace function public.save_provider_daily(p_provider text, p_period text, p_clear_days date[], p_rows jsonb)
returns int language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  -- daily rows reference the period; a new cycle gets a bare row here, filled in by commit_provider_period
  insert into provider_periods (provider, reporting_period) values (p_provider, p_period) on conflict do nothing;
  if p_clear_days is not null and cardinality(p_clear_days) > 0 then
    delete from provider_sim_usage_daily
     where provider = p_provider and reporting_period = p_period and usage_date = any(p_clear_days);
  end if;
  insert into provider_sim_usage_daily (provider, reporting_period, iccid, circle, usage_date, used_mb)
  select p_provider, p_period, x.iccid, coalesce(x.circle, ''), x.usage_date, x.used_mb
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(iccid text, circle text, usage_date date, used_mb numeric)
  on conflict (provider, iccid, circle, usage_date) do update
     set used_mb = excluded.used_mb, reporting_period = excluded.reporting_period;
  get diagnostics n = row_count;
  return n;
end $$;

-- ── 3. monthly rows: staged in chunks, swapped in one transaction ─────
create table if not exists public.provider_upload_stage (
  batch_id    uuid not null,
  seq         int  not null,
  provider    text not null references public.providers(code),
  rows        jsonb not null,
  created_at  timestamptz not null default now(),
  created_by  text default (auth.jwt() ->> 'email'),
  primary key (batch_id, seq)
);
alter table public.provider_upload_stage enable row level security;
drop policy if exists "dbai admin write" on public.provider_upload_stage;
create policy "dbai admin write" on public.provider_upload_stage for all to authenticated
  using ((select public.dbai_is_admin())) with check ((select public.dbai_is_admin()));

create or replace function public.stage_provider_rows(p_batch uuid, p_seq int, p_provider text, p_rows jsonb)
returns int language plpgsql security invoker set search_path = public as $$
begin
  insert into provider_upload_stage (batch_id, seq, provider, rows) values (p_batch, p_seq, p_provider, coalesce(p_rows, '[]'::jsonb))
  on conflict (batch_id, seq) do update set rows = excluded.rows, created_at = now();
  delete from provider_upload_stage where created_at < now() - interval '1 day';   -- leftovers of uploads that never committed
  return jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
end $$;

-- The period row (cycle dates, sources, totals, reconciliation) and every staged monthly row, in one transaction
create or replace function public.commit_provider_period(p_batch uuid, p_provider text, p_period text, p_meta jsonb)
returns int language plpgsql security invoker set search_path = public as $$
declare n int;
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
    from provider_upload_stage s,
         jsonb_to_recordset(s.rows) as x(iccid text, circle text, msisdn text, imsi text, origin_circle text,
           summary_mb numeric, itemized_mb numeric, used_mb numeric, session_days int, last_session_at timestamp,
           summary_session_days int, summary_last_session_at timestamp)
   where s.batch_id = p_batch and s.provider = p_provider;
  get diagnostics n = row_count;
  delete from provider_upload_stage where batch_id = p_batch;
  return n;
end $$;

-- The SIM inventory (the newest SIM Group) the same way: staged in chunks, replaced in one transaction
create or replace function public.commit_provider_sims(p_batch uuid, p_provider text, p_upload_batch uuid, p_as_of timestamp)
returns int language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  delete from provider_sims where provider = p_provider;
  insert into provider_sims (provider, iccid, msisdn, imsi, circle, lifecycle_state, status, plan_name,
         base_plan_name, plan_gb, plan_price, pooled, group_name, activated_at, product_type, upload_batch_id, as_of)
  select p_provider, x.iccid, x.msisdn, x.imsi, x.circle, x.lifecycle_state, x.status, x.plan_name,
         x.base_plan_name, x.plan_gb, x.plan_price, coalesce(x.pooled, false), nullif(x.group_name, ''),
         x.activated_at, x.product_type, p_upload_batch, p_as_of
    from provider_upload_stage s,
         jsonb_to_recordset(s.rows) as x(iccid text, msisdn text, imsi text, circle text, lifecycle_state text, status text,
           plan_name text, base_plan_name text, plan_gb numeric, plan_price numeric, pooled boolean, group_name text,
           activated_at timestamp, product_type text)
   where s.batch_id = p_batch and s.provider = p_provider;
  get diagnostics n = row_count;
  delete from provider_upload_stage where batch_id = p_batch;
  return n;
end $$;

-- ── 4. read-side summaries ────────────────────────────────────────────
-- SIM Group exports kept since p_since (time + number of SIMs) — the rows themselves load only when needed
create or replace function public.provider_snapshot_index(p_provider text, p_since timestamp)
returns table (snapshot_at timestamp, sims bigint) language sql stable security invoker set search_path = public as $$
  select snapshot_at, count(*) from provider_sim_snapshots
   where provider = p_provider and snapshot_at >= p_since
   group by snapshot_at order by snapshot_at;
$$;

-- Go-live detection needs, for each SIM that was pre-live (e.g. Ready) in some export, its runs of the same state:
-- [iccid, state, first export, last export]. SIMs never pre-live in the window are left out (VI's own date is used).
-- One JSON result — one execution, however many SIMs (no paging that re-runs the function).
drop function if exists public.provider_state_runs(text, timestamp, text[]);
create or replace function public.provider_state_runs(p_provider text, p_since timestamp, p_prelive text[])
returns jsonb language sql stable security invoker set search_path = public as $$
  with s as (
    select x.iccid, coalesce(x.lifecycle_state, '') as state, lower(trim(coalesce(x.lifecycle_state, ''))) as st, x.snapshot_at
      from provider_sim_snapshots x
     where x.provider = p_provider and x.snapshot_at >= p_since
  ), p as (                                   -- one scan: keep the SIMs that were pre-live in some export
    select *, bool_or(st = any(p_prelive)) over (partition by iccid) as was_pre from s
  ), g as (
    select iccid, state, st, snapshot_at,
           row_number() over (partition by iccid order by snapshot_at)
         - row_number() over (partition by iccid, st order by snapshot_at) as grp
      from p where was_pre
  ), r as (
    select iccid, min(state) as state, min(snapshot_at) as first_seen, max(snapshot_at) as last_seen
      from g group by iccid, st, grp
  )
  select coalesce(jsonb_agg(jsonb_build_array(iccid, state, first_seen, last_seen) order by iccid, first_seen), '[]'::jsonb) from r;
$$;

-- Each SIM's usage from the cycle start (p_from) to the end of p_date, circles summed, and its days with data —
-- the Real-time "as of" picker. One JSON object { iccid: [used_mb, days] } — one execution, no paging.
drop function if exists public.provider_sim_totals_asof(text, text, date);
create or replace function public.provider_sim_totals_asof(p_provider text, p_period text, p_from date, p_date date)
returns jsonb language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_object_agg(iccid, jsonb_build_array(used_mb, days)), '{}'::jsonb)
    from (select iccid, sum(used_mb) as used_mb, count(distinct usage_date)::int as days
            from provider_sim_usage_daily
           where provider = p_provider and reporting_period = p_period and usage_date between p_from and p_date
           group by iccid) t;
$$;

-- ── 5. pool evaluations: which SIMs each one counted ──────────────────
-- { "n": SIMs counted that had started by the evaluation's data day, "h": the sum of their ICCIDs' 32-bit hashes }.
-- A later upload's pace leaves out an evaluation made over other SIMs (one left the pool, a rule changed).
do $$
begin
  if to_regclass('public.provider_pool_snapshots') is not null then
    alter table public.provider_pool_snapshots add column if not exists counted jsonb;
  end if;
end $$;

revoke all on function public.save_provider_daily(text, text, date[], jsonb)            from public, anon;
revoke all on function public.stage_provider_rows(uuid, int, text, jsonb)               from public, anon;
revoke all on function public.commit_provider_period(uuid, text, text, jsonb)           from public, anon;
revoke all on function public.commit_provider_sims(uuid, text, uuid, timestamp)         from public, anon;
grant execute on function public.commit_provider_sims(uuid, text, uuid, timestamp)      to authenticated;
revoke all on function public.provider_snapshot_index(text, timestamp)                  from public, anon;
revoke all on function public.provider_state_runs(text, timestamp, text[])              from public, anon;
revoke all on function public.provider_sim_totals_asof(text, text, date, date)          from public, anon;
grant execute on function public.save_provider_daily(text, text, date[], jsonb)         to authenticated;
grant execute on function public.stage_provider_rows(uuid, int, text, jsonb)            to authenticated;
grant execute on function public.commit_provider_period(uuid, text, text, jsonb)        to authenticated;
grant execute on function public.provider_snapshot_index(text, timestamp)               to authenticated;
grant execute on function public.provider_state_runs(text, timestamp, text[])           to authenticated;
grant execute on function public.provider_sim_totals_asof(text, text, date, date)       to authenticated;

-- Done. Verify:
--   select * from public.provider_snapshot_index('vi', now()::timestamp - interval '150 days');
--   select jsonb_array_length(public.provider_state_runs('vi', now()::timestamp - interval '150 days', array['ready']));
--   select policyname, qual from pg_policies where tablename = 'provider_sim_usage_daily';
