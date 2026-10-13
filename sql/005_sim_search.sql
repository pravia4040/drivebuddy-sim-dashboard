-- =====================================================================
-- 005_sim_search.sql — drivebuddyAI SIM dashboard: universal SIM search
-- ---------------------------------------------------------------------
-- Run AFTER 001_multi_provider.sql (002-004 first if you use them).
-- ADDITIVE ONLY: no Airtel table, row or policy is touched. Re-runnable.
--
-- One search over every provider's SIM inventory. provider_sims is the
-- common SIM table (provider → providers.code): VI writes it from each SIM
-- Group, Airtel from its real-time portal snapshot, a future provider from
-- its own inventory. The provider of a result comes from its row — never
-- from the number.
--
--   1. provider_sims gets normalised search keys. Generated columns: the
--      stored numbers are never changed.
--        iccid_key   SIM number / ICCID: letters and digits only, upper-case,
--                    no trailing F/U padding (the app's own SIM-key rule)
--        msisdn_key  mobile number: digits only
--        imsi_key    IMSI: digits only
--   2. Indexes: exact SIM and IMSI, the last 10 digits of the mobile number,
--      and (with pg_trgm) any part of the SIM, mobile or IMSI.
--   3. search_sims(q, limit): one JSON result, best match first —
--      exact SIM → exact mobile (all its digits, or the last 10 for an input of 10-13 digits) → exact IMSI → SIM starting
--      with → SIM containing → mobile / IMSI containing. SECURITY INVOKER:
--      the row-level security of provider_sims applies (active users read),
--      so a search never shows a SIM its user could not read anyway.
--
-- Rollback: 005_sim_search_rollback.sql
-- =====================================================================

-- ── 1. normalised search keys ─────────────────────────────────────────
alter table public.provider_sims add column if not exists iccid_key text
  generated always as (regexp_replace(upper(regexp_replace(iccid, '[^0-9A-Za-z]', '', 'g')), '[UF]+$', '')) stored;
alter table public.provider_sims add column if not exists msisdn_key text
  generated always as (regexp_replace(coalesce(msisdn, ''), '[^0-9]', '', 'g')) stored;
alter table public.provider_sims add column if not exists imsi_key text
  generated always as (regexp_replace(coalesce(imsi, ''), '[^0-9]', '', 'g')) stored;

-- ── 2. indexes ────────────────────────────────────────────────────────
create index if not exists provider_sims_iccid_key on public.provider_sims (iccid_key);
create index if not exists provider_sims_imsi_key  on public.provider_sims (imsi_key);
create index if not exists provider_sims_msisdn_key on public.provider_sims (msisdn_key);
create index if not exists provider_sims_msisdn_10 on public.provider_sims (right(msisdn_key, 10));
-- any part of a number: trigram indexes. Without pg_trgm the partial search still works, by scanning the table.
do $$
declare sch text;
begin
  begin
    create extension if not exists pg_trgm with schema extensions;
  exception when others then
    raise notice 'pg_trgm not available (%): partial SIM search will scan provider_sims', sqlerrm;
  end;
  select n.nspname into sch from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm';
  if sch is not null then
    execute format('create index if not exists provider_sims_iccid_trgm  on public.provider_sims using gin (iccid_key %I.gin_trgm_ops)', sch);
    execute format('create index if not exists provider_sims_msisdn_trgm on public.provider_sims using gin (msisdn_key %I.gin_trgm_ops)', sch);
    execute format('create index if not exists provider_sims_imsi_trgm   on public.provider_sims using gin (imsi_key %I.gin_trgm_ops)', sch);
  end if;
end $$;

-- ── 3. the search ─────────────────────────────────────────────────────
-- { results: [{ provider, provider_name, iccid, msisdn, imsi, circle, lifecycle_state, status, plan_name, plan_gb,
--               plan_price, pooled, activated_at, as_of, rank }], more, too_short }
-- rank: 1 exact SIM · 2 exact mobile · 3 exact IMSI · 4 SIM starts with · 5 SIM contains · 6 mobile / IMSI contains.
-- M2M mobile numbers run to 13-15 digits: an exact mobile match is all its digits, or — for an input of 10-13 digits
-- (a mobile number with or without its country code) — its last 10 digits.
-- At least 4 letters or digits. A SIM listed by two providers comes back twice — one row each, never merged.
create or replace function public.search_sims(p_q text, p_limit int default 20)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  k   text := regexp_replace(upper(regexp_replace(coalesce(p_q, ''), '[^0-9A-Za-z]', '', 'g')), '[UF]+$', '');
  d   text := regexp_replace(coalesce(p_q, ''), '[^0-9]', '', 'g');
  lim int  := least(greatest(coalesce(p_limit, 20), 1), 100);
begin
  if length(k) < 4 then
    return jsonb_build_object('results', '[]'::jsonb, 'more', false, 'too_short', true);
  end if;
  -- mobile numbers and IMSIs are searched only when the input is a number (not the digits inside "GJ01AB1234")
  if k !~ '^[0-9]+$' then d := ''; end if;
  return (
    with hit as (
      (select s.provider, s.iccid, 1 as rank from provider_sims s where s.iccid_key = k)
      union all
      (select s.provider, s.iccid, 2 from provider_sims s where length(d) >= 4 and s.msisdn_key = d)
      union all
      (select s.provider, s.iccid, 2 from provider_sims s where length(d) between 10 and 13 and right(s.msisdn_key, 10) = right(d, 10))
      union all
      (select s.provider, s.iccid, 3 from provider_sims s where length(d) >= 4 and s.imsi_key = d)
      union all
      (select s.provider, s.iccid, 4 from provider_sims s where s.iccid_key like k || '%' and s.iccid_key <> k order by s.iccid_key limit lim + 1)
      union all
      (select s.provider, s.iccid, 5 from provider_sims s where s.iccid_key like '%' || k || '%' and s.iccid_key not like k || '%' order by s.iccid_key limit lim + 1)
      union all
      (select s.provider, s.iccid, 6 from provider_sims s
        where length(d) >= 4 and (s.msisdn_key like '%' || d || '%' or s.imsi_key like '%' || d || '%') order by s.iccid_key limit lim + 1)
    ), best as (
      select h.provider, h.iccid, min(h.rank) as rank from hit h group by h.provider, h.iccid
    ), top as (
      select b.provider, b.iccid, b.rank, row_number() over (order by b.rank, b.provider, b.iccid) as rn, count(*) over () as n from best b
    )
    select jsonb_build_object(
      'results', coalesce(jsonb_agg(jsonb_build_object(
          'provider', s.provider, 'provider_name', coalesce(p.name, s.provider), 'iccid', s.iccid, 'msisdn', s.msisdn,
          'imsi', s.imsi, 'circle', s.circle, 'lifecycle_state', s.lifecycle_state, 'status', s.status,
          'plan_name', s.plan_name, 'plan_gb', s.plan_gb, 'plan_price', s.plan_price, 'pooled', s.pooled,
          'activated_at', s.activated_at, 'as_of', s.as_of, 'rank', t.rank) order by t.rn) filter (where t.rn <= lim), '[]'::jsonb),
      'more', coalesce(max(t.n), 0) > lim,
      'too_short', false)
    from top t
    join provider_sims s on s.provider = t.provider and s.iccid = t.iccid
    left join providers p on p.code = t.provider
  );
end $$;

revoke all on function public.search_sims(text, int) from public, anon;
grant execute on function public.search_sims(text, int) to authenticated;

-- Done. Verify:
--   select iccid, iccid_key, msisdn_key, imsi_key from public.provider_sims limit 5;
--   select public.search_sims('<a SIM number you know>', 5);
--   select indexname from pg_indexes where tablename = 'provider_sims' order by 1;
