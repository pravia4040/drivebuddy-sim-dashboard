-- =====================================================================
-- 003_vi_operations.sql — drivebuddyAI SIM dashboard: pool forecast history
--                         and shared-pool alerts
-- ---------------------------------------------------------------------
-- Run AFTER 001_multi_provider.sql and 002_vi_pool.sql. ADDITIVE ONLY:
-- no Airtel table, no existing column, policy or row is changed. Re-runnable.
--
--   provider_pool_snapshots  one row per pool evaluation (an upload, or the
--                            dashboard opening on new data): pool, used,
--                            daily average, projection, level. Gives the
--                            burn-rate chart its points between Itemized
--                            reports and the "recent pace" second signal.
--   provider_alerts          the shared-pool alert: at most ONE open alert
--                            per provider and condition (no repeats on every
--                            refresh), escalation, and resolution with its
--                            reason — the alert history.
--   providers.config         default operations thresholds (pool_rules.ops),
--                            decided with the account owner on 6 Oct 2026.
--
-- SIM daily history needs no new table: provider_sim_usage_daily (001) is
-- the Itemized report at its own grain (SIM × circle × day) and its primary
-- key (provider, iccid, circle, usage_date) already serves one SIM's history.
-- Without this script the dashboard still works; alerts and forecast
-- history then last for the browser session only.
-- Rollback: 003_vi_operations_rollback.sql
-- =====================================================================

-- ── pool evaluations ──────────────────────────────────────────────────
create table if not exists public.provider_pool_snapshots (
  provider          text not null references public.providers(code),
  reporting_period  text not null,          -- VI: month the 22nd → 21st cycle ends in ('Oct 2026')
  as_of             date not null,          -- the usage report's day the figures reach
  source            text not null,          -- 'summary' | 'itemized' (which report the used figure came from)
  pool_gb           numeric,
  used_gb           numeric,
  avg_gb_day        numeric,
  projected_gb      numeric,
  level             text,                   -- healthy | warning | critical | closed
  recorded_at       timestamptz not null default now(),
  primary key (provider, reporting_period, as_of, source)
);

-- ── shared-pool alerts ────────────────────────────────────────────────
create table if not exists public.provider_alerts (
  id                 uuid primary key,
  provider           text not null references public.providers(code),
  code               text not null,                   -- 'pool_exhaustion'
  reporting_period   text,
  level              text not null check (level in ('warning', 'critical')),
  status             text not null default 'open' check (status in ('open', 'resolved')),
  first_detected     timestamptz not null,
  last_updated       timestamptz not null,
  escalated_at       timestamptz,
  resolved_at        timestamptz,
  resolution_reason  text,
  details            jsonb not null default '{}'::jsonb  -- pool, used, remaining, average, projection, exhaustion date, gap, shortfall, backup
);
-- one open alert per provider and condition — the same condition never opens a second one
create unique index if not exists provider_alerts_one_open on public.provider_alerts (provider, code) where status = 'open';
create index if not exists provider_alerts_recent on public.provider_alerts (provider, first_detected desc);

-- ── default operations thresholds (an admin can change them later) ────
update public.providers
   set config = jsonb_set(config, '{pool_rules,ops}', jsonb_build_object(
         'warning_projected_pct', 90, 'critical_min_days', 3, 'backup_margin_pct', 10, 'backup_round_gb', 10,
         'recent_days', 7, 'zero_new_days', 3, 'zero_long_days', 30, 'high_pct', 150, 'trend_pct', 15), true)
 where code = 'vi' and config ? 'pool_rules' and not (config -> 'pool_rules' ? 'ops');

-- ── Row-level security: read = any active authorised user, write = Admin ──
do $$
declare t text;
begin
  foreach t in array array['provider_pool_snapshots', 'provider_alerts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "dbai read" on public.%I', t);
    execute format('create policy "dbai read" on public.%I for select to authenticated using (public.dbai_is_active_user())', t);
    execute format('drop policy if exists "dbai admin write" on public.%I', t);
    execute format('create policy "dbai admin write" on public.%I for all to authenticated using (public.dbai_is_admin()) with check (public.dbai_is_admin())', t);
  end loop;
end $$;

-- Done. Verify:
--   select level, status, first_detected, resolved_at, resolution_reason from public.provider_alerts order by first_detected desc;
--   select reporting_period, as_of, source, used_gb, projected_gb, level from public.provider_pool_snapshots order by recorded_at desc;
