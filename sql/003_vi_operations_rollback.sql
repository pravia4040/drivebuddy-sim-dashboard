-- =====================================================================
-- 003_vi_operations_rollback.sql — undo 003_vi_operations.sql
-- ---------------------------------------------------------------------
-- WARNING: permanently deletes the shared-pool alert history and the pool
-- forecast history. Usage data, SIM Group history and Airtel are not touched.
-- =====================================================================

drop table if exists public.provider_alerts;
drop table if exists public.provider_pool_snapshots;
update public.providers set config = config #- '{pool_rules,ops}' where code = 'vi';
