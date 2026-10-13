-- =====================================================================
-- 001_multi_provider_rollback.sql — undo 001_multi_provider.sql
-- ---------------------------------------------------------------------
-- WARNING: permanently deletes all VI / non-legacy provider data and the
-- upload history. Airtel data in monthly_snapshots, realtime_snapshots,
-- realtime_snapshot and vehicle_master is NOT touched.
-- Export anything you need first.
-- =====================================================================

drop function if exists public.replace_provider_period(text, text, jsonb, jsonb, jsonb);
drop function if exists public.replace_provider_sims(text, jsonb, uuid, timestamp);
drop function if exists public.delete_provider_period(text, text);

drop view if exists public.provider_period_totals;
drop view if exists public.provider_daily_totals;

drop table if exists public.provider_sim_usage_daily;
drop table if exists public.provider_sim_usage_monthly;
drop table if exists public.provider_sims;
drop table if exists public.provider_periods;
drop table if exists public.upload_batches;

-- Legacy tags: drop only the foreign keys (needed before `providers` can go).
-- The provider columns themselves are harmless and keep every row intact.
do $$
declare t text;
begin
  foreach t in array array['monthly_snapshots', 'realtime_snapshots', 'realtime_snapshot'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I drop constraint if exists %I', t, t || '_provider_fk');
      -- execute format('alter table public.%I drop column if exists provider', t);   -- optional
    end if;
  end loop;
end $$;

drop table if exists public.providers;
drop function if exists public.dbai_is_admin();
drop function if exists public.dbai_is_active_user();
