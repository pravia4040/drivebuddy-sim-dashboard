-- =====================================================================
-- 004_vi_scale_rollback.sql — undo 004_vi_scale.sql
-- ---------------------------------------------------------------------
-- Removes the chunked-save and read-summary functions and the staging table,
-- and puts the row-level security policies back in their 001-003 form (same
-- rules, checked per row). No usage, SIM Group, alert or Airtel data is lost
-- (the pool evaluations lose only `counted`, which SIMs each one counted).
-- =====================================================================

do $$
begin
  if to_regclass('public.provider_pool_snapshots') is not null then
    alter table public.provider_pool_snapshots drop column if exists counted;
  end if;
end $$;

drop function if exists public.save_provider_daily(text, text, date[], jsonb);
drop function if exists public.stage_provider_rows(uuid, int, text, jsonb);
drop function if exists public.commit_provider_period(uuid, text, text, jsonb);
drop function if exists public.commit_provider_sims(uuid, text, uuid, timestamp);
drop function if exists public.provider_snapshot_index(text, timestamp);
drop function if exists public.provider_state_runs(text, timestamp, text[]);
drop function if exists public.provider_sim_totals_asof(text, text, date);
drop function if exists public.provider_sim_totals_asof(text, text, date, date);
drop table if exists public.provider_upload_stage;

do $$
declare t text;
begin
  foreach t in array array['providers', 'upload_batches', 'provider_periods', 'provider_sims', 'provider_sim_usage_monthly',
                           'provider_sim_usage_daily', 'provider_sim_snapshots', 'provider_cycle_pool',
                           'provider_pool_snapshots', 'provider_alerts'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists "dbai read" on public.%I', t);
    execute format('create policy "dbai read" on public.%I for select to authenticated using (public.dbai_is_active_user())', t);
    execute format('drop policy if exists "dbai admin write" on public.%I', t);
    execute format('create policy "dbai admin write" on public.%I for all to authenticated using (public.dbai_is_admin()) with check (public.dbai_is_admin())', t);
  end loop;
end $$;
