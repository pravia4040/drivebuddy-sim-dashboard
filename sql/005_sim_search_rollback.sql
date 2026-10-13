-- =====================================================================
-- 005_sim_search_rollback.sql — undo 005_sim_search.sql
-- ---------------------------------------------------------------------
-- Removes the search function, the search indexes and the generated search
-- keys. No SIM, usage, alert or Airtel data is lost (the keys are derived
-- from the stored numbers). pg_trgm stays installed — other objects may use it.
-- The dashboard then searches the SIMs loaded in the browser instead.
-- =====================================================================

drop function if exists public.search_sims(text, int);
drop index if exists public.provider_sims_iccid_trgm;
drop index if exists public.provider_sims_msisdn_trgm;
drop index if exists public.provider_sims_imsi_trgm;
drop index if exists public.provider_sims_iccid_key;
drop index if exists public.provider_sims_imsi_key;
drop index if exists public.provider_sims_msisdn_key;
drop index if exists public.provider_sims_msisdn_10;
do $$
begin
  if to_regclass('public.provider_sims') is not null then
    alter table public.provider_sims drop column if exists iccid_key;
    alter table public.provider_sims drop column if exists msisdn_key;
    alter table public.provider_sims drop column if exists imsi_key;
  end if;
end $$;
