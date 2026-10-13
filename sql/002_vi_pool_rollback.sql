-- =====================================================================
-- 002_vi_pool_rollback.sql — undo 002_vi_pool.sql
-- ---------------------------------------------------------------------
-- WARNING: permanently deletes the SIM Group history, the frozen pools of
-- closed cycles and the Summary's own session figures. Usage data (001)
-- and Airtel are not touched.
-- =====================================================================

drop table if exists public.provider_cycle_pool;
drop table if exists public.provider_sim_snapshots;
update public.providers set config = config - 'pool_rules' where code = 'vi';

-- replace_provider_period back to the 001 version (without the Summary's own session columns)
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

alter table public.provider_sim_usage_monthly drop column if exists summary_session_days;
alter table public.provider_sim_usage_monthly drop column if exists summary_last_session_at;
