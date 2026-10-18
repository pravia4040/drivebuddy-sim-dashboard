# Multi-Provider SIM Dashboard — design, VI mapping, regression & test report

Status: **live** since 13 Oct 2026. Built on the local branch `feature/multi-provider` in the steps below and merged into `main` as one commit; `sql/001`–`005` were run on the live Supabase project the same day (final check passed).

| Step (local branch) | What |
|---|---|
| `feat: multi-provider architecture` | provider registry, VI parsers, UI, SQL migration |
| `chore: local dev server, mock Supabase and provider unit tests` | `tools/`, `tests/` — not used by the live pages |
| `fix: vehicle table Plan column and month-count badge` | two bugs that already exist on the live site, kept separate |
| `refactor: provider-specific UI behind hooks` + this document | VI UI moved to `vi-ui.js`, `ui.js` and `cloud.js` provider-generic |
| `feat(vi): pool from the SIM Group — status rules, go-live detection, frozen cycles` | the VI pool rules decided on 6 Oct 2026 (`docs/VI_POOL_PROPOSAL.md`), `sql/002_vi_pool.sql` |
| `feat(vi): pool uses the newest report; SIMs without a vehicle are listed` | second set of 6 Oct 2026 decisions (see D) |
| `feat(vi): operations — SIM daily history, pool exhaustion warning, zero-usage SIMs` | the operations requirement (`docs/VI_OPERATIONS_PROPOSAL.md`, decided 6 Oct 2026), `sql/003_vi_operations.sql` |
| `feat(vi): per-SIM pace forecast, 2-day Critical, re-alert when worse` | decided 7 Oct 2026 (`docs/VI_OPERATIONS_PROPOSAL.md` §M) |
| `feat(vi): uploads and start-up at any fleet size` + review fixes | `sql/004_vi_scale.sql`, the scale rehearsal (§M) |

---

## How to run it locally

```bash
python tools/serve_local.py --mock        # http://127.0.0.1:8790 — mock database, auto-login, no network
python tools/serve_local.py               # http://127.0.0.1:8790 — your real Supabase login
```

In the Claude desktop app the same two servers are in the workspace launch list as **sim-dashboard-mock** (port 8790) and **sim-dashboard-local** (port 8791).

* **Mock** is the safe way to click through everything: upload the VI files from the upload dialog (Provider → VI). Nothing leaves the browser. `?mockReset=1` empties the mock database, `?mockNoProvider=1` behaves as if the SQL migration had not been run.
* **Real** mode reads and writes your live Supabase project. Airtel uploads go to the same tables as the live site. VI saves need `sql/001_multi_provider.sql` first; without it VI works for the browser session only and says so.
* **VI test page (mock only): `http://127.0.0.1:8790/vi-test.html`** — the dashboard with a small "🧪 VI test page" panel. On first open it uploads the VI files in `D:\DBAI-SIM\vi-test-data\` through the normal upload dialog, the way a user would: Sep 2026 (Summary + SIM Group of 25 Sep, then Itemized), Oct 2026 (Summary of 27 Sep + SIM Group of 28 Sep, then Itemized of 27 Sep), then the 6 Oct Summary + SIM Group. It switches to VI and lists what to try, with the expected figures. "Reset test data" empties the mock database and loads the files again. The folder sits next to the repo on purpose — real SIM data never goes into git; `--fixtures DIR` points the server at another folder. In real mode the page does not exist.
* `/baseline.html` (both modes) serves `index.html` from `main`, for side-by-side comparison.
* `/tests/providers.test.html` runs the unit tests (337).
* `?mockNo002=1` behaves as if `sql/002_vi_pool.sql` had not been run (SIM Group history and frozen cycles then last for the session only, and the Uploads tab says so).
* `?mockNo003=1` behaves as if `sql/003_vi_operations.sql` had not been run (pool forecast history and the alert history then last for the session only).
* `?mockNo004=1` behaves as if `sql/004_vi_scale.sql` had not been run (the 001–003 save and load paths); `?mockNo005=1` behaves as if `sql/005_sim_search.sql` had not been run (the SIM search then runs over the SIMs loaded in the browser); `?mockMem=1` keeps the mock database in memory only; `?mockFail=provider_state_runs` (any tables or functions, comma-separated) makes those reads time out — the start-up then retries, warns and saves nothing worked out without them.
* **Scale rehearsal (mock only): `/vi-scale.html?mockMem=1&n=5000`** — a synthetic VI fleet of n SIMs (1K / 5K / 10K / 20K links on the page), shaped like the real exports, through the normal upload, save and load paths: timings, database calls, MB sent, and a check that the pool and used figures equal what the data was built to give.

### Go-live checklist (steps 1–2 done on 13 Oct 2026)
1. Supabase → SQL Editor → run `sql/001_multi_provider.sql`, then `sql/002_vi_pool.sql`, then `sql/003_vi_operations.sql`, then `sql/004_vi_scale.sql`, then `sql/005_sim_search.sql` (all additive; safe while the old version is live). Optional before go-live: run the 004 "Verify" queries, and time a large upload on the real project.
2. Merge `feature/multi-provider` into `main` and push → GitHub Actions deploys.
3. Upload the VI files once (Provider → VI) — they are saved for the team. Upload every SIM Group export you have, oldest first (they are kept as history: closed cycles are frozen with them and Ready → active SIMs get their real start day). From then on, upload the SIM Group on the 22nd each month and on any day you activate SIMs.
4. Make sure the vehicle master in the cloud contains the VI SIM numbers (☁️ Cloud → Push Vehicle Master after uploading the vehicles file). SIM → vehicle mapping comes only from the vehicle master.

### Cycle consistency fix (14 Oct 2026, branch `fix/vi-cycle-consistency`)
Found on the live data of 13 Oct 2026: the pool card (22 Sep – 21 Oct, Data Usage Summary to 12 Oct) and the Real-time tab (22 Aug – 21 Sep, Itemized) showed different billing cycles side by side, and the pool was 364 × 85 GB with no SIM pro-rated.
* **Why.** (1) The Itemized export of 13 Oct covers 22 Aug – 12 Oct; only its dominant cycle (Sep, 31 days) was kept and the current cycle's 21 days were dropped. (2) Only one SIM Group file (13 Oct) was loaded. VI's DATE_OF_ACTIVATION is the day a SIM was loaded on the account and does not change when it goes live (115 of the 364 active SIMs went live during this cycle, all with an August/September date), so without older SIM Group files every active SIM got its full 85 GB. (3) The closed Sep cycle was frozen with that 13 Oct file, 22 days after it ended.
* **Changed.** An Itemized report that crosses the 22nd fills every cycle it covers (the cycle of its "Data up to" day, and each earlier cycle it has every day of). A closed cycle is frozen only with a SIM Group file from within 7 days after its end (`ops.freeze_max_days`). New warnings: *Start days not verified* (no SIM Group file within 7 days of the cycle start, `ops.start_check_days`) and *Built from a late SIM Group*. One cycle context per provider dataset (`ds.context`): every label reads it. The pool card names its billing cycle and day; the Real-time tab says when it shows an older (historical) cycle, with the current cycle's pool beside it; All Providers real-time cards show each provider on its own when their periods differ; *🧮 Calculation details* lists every figure with its source, cycle, SIMs and formula. No business rule changed.
* **Live data after the deploy:** upload the SIM Group files of 25 Sep, 28 Sep and 6 Oct (they are kept as history; the 13 Oct file stays the current one), upload a fresh Itemized export (the 13 Oct file was already used and is skipped as a duplicate), then ↻ Recompute the Sep 2026 cycle on the Uploads tab. Expected on the 13 Oct files: pool 27,001.67 GB (249 × 85 + 115 SIMs pro-rated = 5,836.67 GB), used 18,683.48 GB (69.19%), Warning — 102.1% projected; Sep 2026 pool 16,084.83 GB (249 SIMs, SIM Group of 25 Sep).

### Start days from the newest files (18 Oct 2026, branch `fix/vi-start-from-data`)
When no SIM Group file from around the cycle start (±7 days) is loaded, a SIM that counts, was never seen Ready and has VI's date before the cycle gets its start from the usage data already uploaded: data in an earlier cycle → live before → full plan; no data before, first data this cycle → pro-rated from that day (src `estimated`); no data at all, or no earlier cycle loaded → VI's date, flagged. With SIM Group files from around the cycle start the exact history is used instead. On the 18 Oct files (13 Oct SIM Group only + Sep Itemized): pool 26,783.50 GB (exact with the older SIM Group files: 27,001.67), used 22,843.13 GB.

Rollback: revert the go-live commit on `main` — that alone brings the old site back, and it ignores the new tables. Only to remove the database part as well (this deletes the uploaded VI data): `sql/005_sim_search_rollback.sql`, then `sql/004_vi_scale_rollback.sql`, then `sql/003_vi_operations_rollback.sql`, then `sql/002_vi_pool_rollback.sql`, then `sql/001_multi_provider_rollback.sql`, remove the new tables (Airtel tables untouched).

---

## A. Architecture

### Before
One page (`index.html`). Airtel-only parsers fill three globals the renderers read — `CD` (vehicles + stats), `trData` (monthly history per vehicle), `rtRows` (portal SIM list). Supabase keeps month snapshots as JSON (`monthly_snapshots`, `vehicle_master`, `realtime_snapshots`).

### After

```
                      SIM DASHBOARD  (same tabs, filters, charts, exports)
                               │
                 Provider selector: All · Airtel · VI · Jio (soon)
                               │  Providers.refresh() → applyProviderView(view)
            ┌──────────────────┼───────────────────┐
         Airtel dataset     VI dataset        (Jio: registered, no parser yet)
     legacy parsers +     vi.js parsers +
     legacy tables        provider tables
            └──────────────────┼───────────────────┘
                      view = one provider, or all merged
                      (+ ownership rule, + Month filter)
                               │
       existing renderers: vehicles · exceeded · plans · downgrade · trends
       price · real-time   +  new: Providers · Data Pool · Uploads tabs
```

* **`js/providers/registry.js`** — provider configs (plan tiers, prices, rate cards, status rules, zero-allocation rule, month rule, pool flag, storage), one dataset per provider, the provider/month selection, the view builder, provider-aware helpers (search, badges, export Provider column and file name).
* **`js/providers/vi.js`** — VI file detection, parsing, validation, month merge, reconciliation, dataset + pool building (no DOM).
* **`js/providers/cloud.js`** — provider-generic persistence: `savePeriod(provider, …)`, `saveInventory(provider, …)`, `loadProvider(provider)`, upload history, SHA-256 duplicate lookup, session-only mode when the tables are missing.
* **`js/providers/ui.js`** — provider-independent UI: header selector, "Viewing" chip, filters, the Providers / Data Pool / Uploads tabs, the provider choice in the upload dialog. It never names a provider; it calls hooks on the provider configs.
* **`js/providers/vi-ui.js`** — VI's UI, registered as hooks on the VI config: its upload form (mounted into the dialog), the reconciliation section, the real-time cycle line, the vehicle-popup details + daily chart, and its start-up cloud load.

Provider hooks (all optional): `upload { mount, render, canProcess, process, syncMode }` · `ui { reconSection, rtInfo, rtControls, pickDay, vsumExtra, afterVsum, statusRuleControl, poolHeaderExtra }` · `boot(cloud)` · plus data settings `tiers() price() rates() forMonth() poolStates() zeroAllocFlag poolRule simSource cycle typeLabels legacyStatuses rtEmpty invEmpty`.

**Airtel guarantee.** `loadData()` — the entry point of every Airtel flow — now stores the result as Airtel's dataset and asks for a refresh. When the view holds only Airtel data and nothing moves to another provider, the renderer receives *the same object* as before, so every legacy formula runs unchanged (verified: section F).

**Ownership rule (data isolation).** The vehicle master lists every vehicle with its SIM. A vehicle belongs to the provider whose data contains its SIM (ICCID, MSISDN or IMSI). Airtel keeps legacy behaviour for vehicles no provider claims. A vehicle that has no Airtel usage and whose SIM is in VI's data moves from the Airtel view to the VI view — it never appears in both. Provider is never guessed from the SIM prefix or the file name.

### Airtel-specific parts identified and isolated
| Airtel-specific | Where it lives now |
|---|---|
| HISTORICAL_DATA_USAGE / BULK_DATA_USAGE parsers, column hints | unchanged in `index.html`, used only for Airtel uploads |
| `TIERS` (2…200 GB) | Airtel config `tiers()`; VI tiers come from its inventory |
| `PLAN_PRICES`, `INR…PM` price rule | Airtel config `price()` / `rates()`; VI price from the deal name |
| SIM statuses Active / Available / Safe Custody / Disconnected | kept for Airtel; status filter now also lists the statuses of the providers in view |
| zero-allocation SIM = WASTED | Airtel `zeroAllocFlag`; VI uses NO DATA (Ready stock is inventory, not waste) |
| legacy tables | Airtel `storage`; VI uses the provider tables |

### Adding Jio later
1. `providers` row (already seeded as *planned*).
2. `js/providers/jio.js` like `vi.js`: detect → parse → build dataset, and `register()` its config (tiers, prices, statuses, zero-allocation rule, pool rule, month rule).
3. Optional `js/providers/jio-ui.js` like `vi-ui.js`: upload form + hooks; two `<script>` tags in `index.html`.
4. Map its columns to the common fields in section C; it saves through the same `cloud.js` functions and tables.
5. Set status `active`. Verified: a provider registered with a config object alone appears in the selector, the comparison table and the upload dialog, with no errors (test 10). `ui.js`, `cloud.js` and the renderers need no changes.

---

## B. Database changes (`sql/001_multi_provider.sql`)

**Existing (unchanged in structure):** `authorized_users`, `monthly_snapshots`, `vehicle_master`, `realtime_snapshots`, `realtime_snapshot`.
Change: `monthly_snapshots`, `realtime_snapshots`, `realtime_snapshot` get `provider text not null default 'airtel'` + FK to `providers(code)` + index. Every existing row becomes `airtel`; the live app keeps inserting without the column and gets `airtel`. `vehicle_master` is **not** tagged — the fleet is provider-independent.

**New**
| Table | Key | Purpose |
|---|---|---|
| `providers` | `code` (unique) | airtel, vi (active), jio (planned) |
| `upload_batches` | `id` uuid; unique `(provider, source_type, file_hash)` where success | upload history, SHA-256 duplicate guard, row counts, validation + reconciliation details, uploaded_by |
| `provider_periods` | `(provider, reporting_period)` | billing-cycle dates, which sources exist, totals, reconciliation |
| `provider_sims` | `(provider, iccid)` | SIM inventory: MSISDN, IMSI, lifecycle, plan, GB, price, pooled, activation |
| `provider_sim_usage_monthly` | `(provider, reporting_period, iccid, circle)` | `summary_mb`, `itemized_mb`, `used_mb`, session days, last session |
| `provider_sim_usage_daily` | `(provider, iccid, circle, usage_date)` | itemized daily usage |

**New in `sql/002_vi_pool.sql`** (run after 001; the app works without it, but then keeps the two below for the browser session only)
| Table | Key | Purpose |
|---|---|---|
| `provider_sim_snapshots` | `(provider, snapshot_at, iccid)` | every SIM Group export — the SIM state history (go-live detection, freezing). The newest export is the current inventory (`provider_sims`); an older one uploaded later is history only. |
| `provider_cycle_pool` | `(provider, reporting_period)` | a closed cycle's frozen pool: SIM counts, full / pro-rated / total GB, used, utilisation, new activations, status counts, the rules used, each SIM's allocation (`sims` jsonb), the SIM Group it was built from |
| `providers.config.pool_rules` | — | VI pool rules (which states count, plan days, data-pool deal tag) — changed by an admin on the Data Pool tab |

**New in `sql/004_vi_scale.sql`** (run after 003; any fleet size — without it the 001–003 paths are used): RLS checks once per statement (same rules); `save_provider_daily` (Itemized days in chunks, each atomic); `provider_upload_stage` + `stage_provider_rows` + `commit_provider_period` / `commit_provider_sims` (monthly rows and the SIM inventory staged in ~1 MB chunks, swapped in one transaction); `provider_snapshot_index`, `provider_state_runs`, `provider_sim_totals_asof` (export list, go-live state runs and as-of totals computed in the database, one result each); `provider_pool_snapshots.counted` (jsonb: which SIMs each pool evaluation counted — the pace compares only uploads over the same SIMs). See `docs/VI_OPERATIONS_PROPOSAL.md` §M.

**New in `sql/005_sim_search.sql`** (run after 001; the universal SIM search — without it the search runs over the SIMs loaded in the browser): `provider_sims` gets generated search keys (`iccid_key`, `msisdn_key`, `imsi_key` — the stored numbers never change), indexes (exact, last 10 mobile digits, pg_trgm for any part of a number) and `search_sims(q, limit)` (SECURITY INVOKER, so RLS applies; one ranked JSON result). Airtel's SIMs are written to `provider_sims` (provider `airtel`) by an Admin's dashboard from Airtel's own reports. See `docs/SIM_SEARCH.md`.

**New in `sql/003_vi_operations.sql`** (run after 002; without it the two below last for the browser session only)
| Table | Key | Purpose |
|---|---|---|
| `provider_pool_snapshots` | `(provider, reporting_period, as_of, source)` | one row per pool evaluation (pool, used, daily average, projection, level) — burn-rate points between Itemized reports and the recent pace |
| `provider_alerts` | `id`; unique `(provider, code)` where `status = 'open'` | the shared-pool alert and its history: at most one open alert per provider and condition, escalation, resolution with the reason |
| `providers.config.pool_rules.ops` | — | thresholds decided 6 Oct 2026: Warning 90% projected · Critical after 3 days of data · backup +10% rounded up to 10 GB · zero usage new < 3 days, long-term 30+ days · high day 150% · trend ±15% |

Indexes: `(provider, uploaded_at desc)`, `(provider, msisdn)`, `(provider, status)`, `(provider, iccid)`, `(provider, reporting_period, usage_date)`.
Relationships: every provider-data table → `providers(code)`; usage rows → `provider_periods` (cascade); periods/SIMs → `upload_batches` (set null).
Views (security invoker, RLS applies): `provider_daily_totals`, `provider_period_totals` — server-side aggregates for cards/charts.
RPCs (security invoker): `replace_provider_period(...)`, `replace_provider_sims(...)` — delete + insert in one transaction, which is what makes a re-upload replace instead of add. `delete_provider_period(provider, period)` removes one billing period (a wrong upload) in one transaction and marks its `upload_batches` rows `deleted` (the history stays; the duplicate guard only counts `success`, so the same files can be uploaded again).
RLS: read = active user in `authorized_users`; write = active Admin.

**Why VI is in new tables, not `monthly_snapshots`.** `monthly_snapshots` is unique on `month_label` alone, so VI "Sep 2026" would collide with Airtel "Sep 2026", and changing that constraint would break the live app's upsert. The new tables also keep VI invisible to the live Airtel-only app during testing. *Phase 2 (optional, later):* move Airtel's months into the provider tables with a one-off copy and switch Airtel's `storage` config — no renderer changes.

---

## C. VI data mapping

Verified on the Sep-2026 exports: Summary and Itemized hold the same 466 ICCID × CIRCLE rows (168 SIMs); Σ itemized daily bytes / 1024 = summary KB on 466/466 rows; SIM Group lists 654 SIMs.

### Data Usage Summary (`SELFCARE_USAGE_SUMMARY_*`) → `provider_sim_usage_monthly`
| VI column | Field | Used for |
|---|---|---|
| ICCID (`~` text prefix removed) | `iccid` | SIM key, vehicle mapping |
| MSISDN, IMSI | `msisdn`, `imsi` | vehicle mapping fallback, search |
| CIRCLE (numeric code) | `circle` | row key (usage is split per serving circle) |
| TOTAL_USAGE:Data-kiloBytes/… (KB) | `summary_mb` = KB / 1024 | **primary** monthly usage |
| ORIGIN_CIRCLE | `origin_circle` | roaming label (often NULL) |
| Last_Packet_Switched_Session_End | `last_session_at` | last activity; month suggestion |
| Packet_Switched_Session_Days | `session_days` | active days (per circle) |
| E_CODE, ACCOUNT_ID | — | account identifiers, not stored |

### Itemized Data Usage (`SELFCARE_USAGE_ITEMIZED_*`) → `provider_sim_usage_daily` (+ `itemized_mb`)
| VI column | Field | Used for |
|---|---|---|
| ICCID, MSISDN, IMSI, CIRCLE | as above | same keys as the summary |
| one column per date `YYYY-MM-DD` (22nd → 21st), **bytes**, NULL = no session | `usage_date`, `used_mb` = bytes / 1024² | daily charts, exact session days, cycle dates |
| TOTAL_USAGE:Data-KiloBytes/… (KB) | `itemized_mb` | reconciliation; total only when no summary exists |
| ORIGIN_CIRCLE, Last session, Session days | as in the summary | — |

### SIM Inventory (`SIMGROUP_*`) → `provider_sims`
| VI column | Field | Used for |
|---|---|---|
| ICCID, MSISDN, IMSI | keys | every SIM, including SIMs with no usage |
| SIM_LIFECYCLE_STATE (active, Ready, suspend, Dunning — mixed case) | `lifecycle_state` (shown everywhere, exactly as VI writes it), `status` (normalised: Active, Ready, Suspended, Dunning — cross-provider filter only) | pool rule, status table |
| DEAL_NAME / BASE_PLAN_NAME | `plan_name`, `base_plan_name` → `plan_gb`, `plan_price`, `pooled` | allocation, cost, pool |
| DATE_OF_ACTIVATION | `activated_at` | pro-rating start. It is the day the SIM was **loaded** on the account (all Ready SIMs have one), so a SIM seen Ready in an older SIM Group gets a detected go-live day instead (see D) |
| CIRCLE (home circle), PRODUCT_TYPE, GROUP_NAME | stored | reference |
| CONTRACT_* (empty in the export) | — | not used |

Deal names seen: `…_DP_100SMS_85GB_375R_…` → 85 GB · ₹375, data pool (`_DP_`); `…_IOT_100GB_499_X_M2MISAFE_X` → 100 GB · ₹499, its own plan (no `_DP_`, not pooled); `…_READY_0_…` → Ready stock, 0 GB. The export time of a SIM Group is only in its file name (`…_YYYYMMDDHHMMSS.csv`).

---

## D. VI calculation logic

* **Units:** internal MB. Summary KB ÷ 1024; itemized bytes ÷ 1024². The daily unit is not labelled in the export, so it is confirmed per row against TOTAL_USAGE (bytes on 466/466 rows).
* **One source per use, as for Airtel (confirmed by the account owner):** month-wise figures — Vehicle Wise, Exceeded, Plan Summary, Downgrade, Trends, Price Analysis and the Month filter — come **only from the Data Usage Summary**; the Real-time tab and the Data Pool come **only from the Itemized report**. A SIM's month = Σ over its circles of that source. When both reports of a cycle exist they are compared on the Uploads tab (reconciliation), never mixed or added. A Summary-only cycle has no real-time data; an Itemized-only cycle is not a Month-filter month.
* **Pool used = the newest report (decided 6 Oct 2026).** The Data Pool, the pool strip, the alerts and the billing-cycle trend take a cycle's used data from whichever report reaches later: the Data Usage Summary (VI's cycle-to-date total per SIM, up to its latest last-session day) or the Itemized report (up to its last day). Same day → the Itemized report. A past "as of" day always comes from the Itemized days. The pool shows the newest cycle with any usage. The Real-time tab and the daily pool charts stay on the Itemized report and say when the pool's totals come from a newer Summary. Why: the account owner uploads the Summary more often than the Itemized report — with the 6 Oct Summary (to 5 Oct) the pool shows 12,166.18 GB used instead of the Itemized report's 4,136.57 GB (to 26 Sep).
* **SIMs without a vehicle number (decided 6 Oct 2026).** SIM → vehicle mapping comes from the vehicle master. A VI SIM the vehicle master does not list is still shown in the month-wise tabs (Vehicle Wise, Exceeded, Trends, Price…) as **"No vehicle · <mobile no.>"** under the client **"No vehicle mapped"**, when it counts in the pool or used data in a Data Usage Summary. Ready SIMs with no usage stay in the Real-time tab and the SIM-wise table only. The Data Pool reconciliation counts pool SIMs without a vehicle and an alert says how to map them (vehicles file with their SIM or mobile numbers → ☁️ Cloud → Push Vehicle Master). 6 Oct files with the built-in vehicle master: 326 rows, 1 with a vehicle number.
* **Session days:** distinct dates with a session across circles (itemized); without itemized, the largest per-circle value.
* **Billing cycle (confirmed by the account owner): 22nd → 21st, usage resets on the 22nd.** A cycle is labelled with the month it ends in (22 Aug – 21 Sep = **Sep 2026**); any date on or after the 22nd belongs to the next month's cycle (22 Sep → Oct 2026). A cycle's dates always come from this rule, never from the dates a file happens to cover.
  * Itemized file: its dates decide the cycle and the upload dialog locks the month to it. A file that crosses the 22nd is flagged and only the main cycle's days are used (saved and counted); the other days are dropped, never added to the wrong cycle.
  * Summary file (no dates): the cycle is the one most last-session dates fall in; the dialog suggests it and asks you to confirm. A Summary and an Itemized file pointing to different cycles are flagged.
  * Days already saved under the wrong cycle (uploads made before this rule) are shown as a warning on the Uploads tab and not counted; delete that cycle and upload its files again.
* **"As of" a day (Real-time tab picker, Data Pool chart):** Used = Σ daily usage from the cycle start (22nd) to the end of that day; the pool holds only the SIMs activated by then, each with its allotment for the cycle (pro-rated, see below); Available = pool − used. The cycle's last day with data is the normal cycle total (Summary). Vehicle, plan, price and trend tabs keep the cycle totals. The per-SIM daily data of a saved cycle is loaded from the cloud on demand (≈ 3,000 rows per cycle).
* **Day by day (Data Pool tab):** for each day of the cycle: used that day, used so far, SIMs in the pool, pool size, available at the end of the day. (Sep 2026 figures for these rows are in the test report; with the 6 Oct 2026 rules the Sep pool is 16,084.83 GB.)
* **Pool advice timing:** idle-SIM ("oversized") advice only from two-thirds of the cycle onward and on the latest day — early in a cycle, or on a past day, only the pace is shown.
* **Pool rules (decided 6 Oct 2026, changeable by an admin):** a SIM counts in the pool when (1) it is in the SIM Group file, (2) the rule for its state says so — by default only `active`; `Ready`, `Dunning` and `suspend` do not count, and a state with no rule yet (a new one in a later file) does not count and is flagged — and (3) its deal is a data-pool deal (`_DP_`). Others have 0 allocation → flag NO DATA ("No plan"), not WASTED. Admins tick a state in the Data Pool tab's status table to change its rule; it is saved in `providers.config.pool_rules` for everyone. Open cycles follow at once; frozen cycles keep their rules until recomputed.
* **No SIM Group file → no pool.** Usage alone cannot size the pool (idle SIMs are only in the SIM Group). The usage tabs still work; the Data Pool says to upload the SIM Group. Nothing is assumed: a SIM with usage but missing from the SIM Group is "Not in SIM Group", not counted, and flagged.
* **Usage % / flags / downgrade candidates / smart recommendation:** the Airtel formulas unchanged, with VI's plan tiers (85, 100 GB). Smart recommendations need 3+ months, as for Airtel.
* **One shared data pool (confirmed by the account owner):** every SIM that counts (see the pool rules) adds its allowance to one account pool, and any SIM can use any part of it — 10 SIMs × 85 GB = 850 GB. Per-SIM up/downgrades are therefore replaced by pool advice. SIM "available" = allocation − used and may be negative (drawing on the pool), so Σ available = pool available, and the Real-time and Data Pool tabs always agree.
* **Pro-rated data (confirmed by the account owner; VI pool SIMs only, Airtel unchanged):** a pool SIM that starts during a cycle gets its plan ÷ 30 for each day left in the cycle, activation day included, never more than the plan — 85 GB ÷ 30 = 2.8333 GB a day. It is granted on the activation day for the rest of the cycle; from the next cycle the SIM gets the full plan. A SIM activated on or before the 22nd, or without an activation date, gets the full plan. Sep 2026 (31 days, SIM Group of 25 Sep, only `active` SIMs): 43 full-cycle SIMs = 3,655 GB + 206 SIMs pro-rated = 12,429.83 GB → **16,084.83 GB**, 9,543.99 GB used (59.34%), 6,540.84 GB remaining. The Data Pool tab shows this as "How the pool is built"; the Real-time tab's Allocated column, the vehicle popup and the day-by-day table use the same allotments. Plan (GB) on the vehicle tabs stays the plan size; costs stay at full monthly plan rates.
* **Data pool:** Total pool = Σ this cycle's allocation of the SIMs that count (full allocation + pro-rated allocation), shown as a breakdown (e.g. 249 SIMs × 85 GB + 15 SIMs pro-rated (1,082.33 GB) = 22,247.33 GB); Used; Remaining = Total pool − Used; Utilisation = Used ÷ Total pool; utilisation; days elapsed / cycle length → projected end-of-cycle use; idle pooled SIMs (0 usage) and their cost; SIMs above their share; top 10 consumers; daily pool usage. Advice: over 95% projected → at risk; under 60% with idle SIMs → how many can leave the pool while keeping 20% headroom (with a warning about recently activated SIMs). A strip above the tabs shows Total / Used / Remaining whenever VI is in view.
* **SIM counts.** Usage reports list only SIMs that used data in the cycle (27 Sep 2026 export: 167 SIMs in the Summary, 162 in the Itemized report). The full list and each SIM's state, plan and activation date come from the SIM Group file (28 Sep: 654 SIMs — 264 active, 387 Ready, 2 Dunning, 1 suspend). The Real-time tab lists the cycle's SIM Group SIMs + SIMs in that cycle's Itemized report (never SIMs known only from an older Summary). A Ready SIM that uses data is **not** assumed active: it is not counted and is flagged ("probably went live — upload a newer SIM Group file").
* **Go-live day (decided 6 Oct 2026).** VI's DATE_OF_ACTIVATION is the day a SIM was loaded on the account, and VI keeps it when a Ready SIM goes live (15 SIMs went Ready → active between the 25 and 28 Sep files with dates of 26 Aug / 8 Sep; they first used data on 25–26 Sep). So a SIM that an older SIM Group showed as Ready and a newer one shows as active starts on its **first day with data after the Ready file** (two upper bounds — the earliest day the Itemized daily figures show, and the latest day the Data Usage Summary allows: its own last session − its own session days + 1, never before the Ready file; the earlier one wins, since daily figures may not cover the earlier days), else on the export date of the first file that shows it active ("detected"). Otherwise the SIM Group's date is used. The SIM Group history (`provider_sim_snapshots`) and the per-SIM daily usage (loaded on demand) make this possible. Oct 2026 check: 249 full-cycle SIMs × 85 = 21,165 GB + 15 detected (6 from 25 Sep × 76.5, 2 from 26 Sep × 73.67, 7 from 28 Sep × 68) = 1,082.33 GB → **22,247.33 GB**, 4,136.57 GB used by 26 Sep, **18,110.77 GB remaining (18.59%)**; at ~827 GB a day the cycle is on pace for 112% and runs out around 18 Oct.
* **Frozen cycles (decided 6 Oct 2026).** A closed cycle with data is frozen with the first SIM Group exported on or after its last day (the 21st); its per-SIM allocations are saved (`provider_cycle_pool`) and newer SIM Groups never change it. Until such a file exists the closed cycle is "provisional" (built from the latest SIM Group) and says so. An admin can **↻ Recompute** a closed cycle (e.g. after a rule change or a better SIM Group). The open cycle is always computed live from the latest SIM Group.
* **Current cycle by today's date.** The Data Pool shows today's day in the cycle (6 Oct = day 15 of 22 Sep – 21 Oct) next to the data day, warns when the Itemized data is more than 2 days old, and says so when today's cycle has no Itemized data yet.
* **SIM Group ↔ usage reconciliation (Data Pool tab):** SIMs in the SIM Group · SIMs in the usage report · matched (ICCID) · in the SIM Group without usage (and how many of them count) · usage not in the SIM Group · usage by SIMs that do not count. 27/28 Sep files: 654 · 162 · 162 · 492 (102 count) · 0 · 0.
* **Alerts:** projected over the pool (with the run-out day) · pool used up / ≥ 80% · < 3 days left at the current pace · SIMs not in the SIM Group · usage by SIMs that do not count · new state without a rule · SIM Group older than the cycle · stale Itemized data · provisional closed cycle · SIMs above their own allocation · new activations · detected go-live days · SIMs without an activation date.
* **Summary vs Itemized differences from export times** are explained on the Uploads tab: a Summary exported after the Itemized report's last day includes later usage (27 Sep export: +472 GB).
* **Reconciliation:** per ICCID × CIRCLE, summary MB vs itemized MB (tolerance 0.001 MB) plus totals, rows only in one file. Status *matched*, *difference*, *summary only*, *itemized only*.
* **Validation per file:** total / valid / duplicate / invalid rows; invalid ICCID, missing or non-numeric usage, non-numeric daily cells, repeated SIM+circle (conflicting repeats flagged), unit check, file-name vs columns mismatch — with a "View errors" list.
* **Duplicate prevention:** same file again → SHA-256 match → skipped. Same month again → that month's source is replaced atomically. Row keys `(provider, period, iccid, circle)` and `(provider, iccid, circle, date)`.
* **Comparison (All Providers):** each provider keeps its own figures; Total only adds them. Fleet table uses vehicle-mapped SIMs; account table uses each provider's SIM list (Airtel: real-time portal snapshot · VI: inventory + cycle).

---

## E. UI changes

* Header: provider selector (All Providers · Airtel · VI · Jio soon); on screens under 1500 px it takes its own row in the sticky header.
* "Viewing: …" chip next to the tabs; global **Month** filter (Latest / each month in view).
* Tables, trend cards, plan cards, exceeded cards: small provider badge — only when rows from more than one provider are on screen.
* Search also matches provider name, ICCID, MSISDN, IMSI.
* Upload dialog: Provider selector; Airtel shows its existing modes unchanged. VI has modes like Airtel's: **📄 Monthly · Data Usage Summary** (month picker, cycle suggested from the last sessions) and **📡 Real-time · Itemized report** (cycle set by the report's dates, plus a **📅 Data up to** date like Airtel's Snapshot Date — limited to the days the report covers, default its last day with data; later days are left out, e.g. a part-day export; recorded in the upload history); the SIM Group file is optional in both, like Airtel's vehicles file. A file dropped in the wrong mode is shown as "for the other mode — not used here" with a Switch button. The dialog's own mode buttons carry over (Real-time portal → VI Real-time; Single / Multi-month → VI Monthly), so the Real-time tab's upload button opens VI in Real-time mode. Validation card per file, replace warning, reconciliation preview when the other report of the cycle is saved; not-configured providers say so.
* Real-time tab: VI SIM list (SIM Group + Itemized report); "No plan" chip when present; VI real-time line (cycle dates, day X of Y, when usage resets). **📅 As of** picker — like Airtel's snapshot picker and, like it, independent of the Month filter; every day of every cycle with an Itemized report is available (grouped by cycle, newest first); days after the newest report up to today are listed greyed out as "no Itemized data yet — upload a newer report". When a newer Data Usage Summary drives the pool, the first entry is "Latest · pool from the Data Usage Summary to <day>"; the newest Itemized day is then a normal pickable day ("last Itemized day") that shows that day's Itemized figures. The ribbon then reads "As of the end of <day>", and the export file name gets `_as-of-YYYY-MM-DD`. Without an Itemized report the tab shows the empty state asking for it.
* Pool strip and Data Pool tab follow the picked day ("📅 As of" chip, "Latest day ↺" button). Data Pool adds an "Available at the end of each day" chart and a day-by-day table; clicking (or Enter on) a day in either daily chart picks that day; later days are faded.
* Uploads tab: per VI cycle, "🗑 Delete cycle" (edit mode, Admin in the database) for a wrong upload, and a warning when a cycle holds days from another cycle.
* Price tab: rate cards of the providers in view; pool-adjusted wastage note for VI.
* Vehicle popup: VI SIM details (ICCID, MSISDN, IMSI, lifecycle, deal, pooled, activation) and a daily usage chart.
* New tabs: **Providers** (comparison + monthly chart), **Data Pool**, **Uploads** (history + VI reconciliation).
* Pool strip under the stat cards (VI: now the Operations block below), on every tab, whenever a pooled provider is in view: Total pool (with the SIMs × GB breakdown), Used, Remaining, a meter, "N of M SIMs count", a **🔒 Frozen** or **Provisional** badge, the critical alert if any, and a link to the Data Pool tab. Hidden in the Airtel view.
* Data Pool tab (VI): cycle line (dates, plan GB ÷ 30 per day, today's day, data day, SIM Group date) · tiles: SIM inventory, eligible, not eligible (by state), new activations · full allocation, pro-rated allocation, **total pool**, used, remaining, utilisation (2 decimals) · alerts · SIM status & pool table (states as in the file, rule tick boxes for admins, SIMs, pool GB, used GB, why) · SIM Group ↔ usage reconciliation · How the pool is built · daily charts · no usage / above allocation / lowest consumers · top 10 · billing-cycle trend (per cycle: SIMs, pool, used, remaining, utilisation, frozen/live, usage source) · SIM-wise allocation (every SIM: status, activation, counts-from date + source, days, GB/day, allocation, used, remaining, usage %, why not counted; search + CSV).
* **VI Operations block** (replaces the pool strip, every tab while VI is in view): level badge (Healthy / Warning / 🚨 Critical) and one-line forecast, total / used / remaining, "pool lasts N days" against the days left, meter, zero-usage count, "View pool forecast →". A **pop-up** for a new Critical (pool, used, remaining, average, exhaustion date, cycle end, gap, backup with its calculation, "View pool analysis"); dismissed once per alert per browser, the banner stays until the forecast is healthy again.
* Data Pool tab (VI) adds: **shared pool forecast** (every figure with how it is calculated, recent pace, levels) and a **burn-rate chart** (used so far, projection at the cycle average, pool size day by day, run-out day) · **zero-usage SIMs** (new / no usage / long-term, last usage, days idle, advice, cost, filter + CSV — never closed automatically) · **high-usage SIMs** (≥ 150% of the daily allocation, analytical) · **alert history**.
* **SIM detail page** (from any SIM number in the Data Pool lists, top consumers and the vehicle pop-up's "📈 Daily history"): identity, plan, billing-cycle picker, eligible days and allocation, total used (newest report), usage %; daily area chart from the Itemized report with zero days on the baseline, no-data days greyed, a 2.83 GB/day line, high days marked, tooltips; 7 days / 14 days / cycle / full history; total, averages per calendar and per active day, highest / lowest day, zero days, trend; day-by-day table; cycle comparison; last usage.
* Phones (375 px): no tab widens the page — the tab bar and wide cards scroll sideways, the header wraps, charts are drawn at the width they are shown.
* Upload dialog (VI): a checklist of the three files — needed for, Uploaded / Missing / old / in this upload, latest date. The SIM Group can be uploaded alone; one without SIM_LIFECYCLE_STATE, DATE_OF_ACTIVATION or a plan column is refused with the reason; an older export than the loaded one is kept as history only.
* Exports: Airtel view — unchanged file names and columns; VI view — `_vi` file names; All Providers with several providers — `_all-providers` and a Provider column. Trend exports match months by label.
* Charts use the validated categorical slots in registry order (Airtel #3987e5, VI #d95926, Jio #199e70): all-pairs CVD ΔE ≥ 9.4, normal-vision ΔE ≥ 20.9, ≥ 3:1 on every dashboard surface; legends, table views, hover + keyboard tooltips.

---

## F. Airtel regression report

Method: `/baseline.html` (= `main`) and `/index.html` (this branch) on the same mock database, fed identical Airtel files. Compared 19 outputs: the six stat cards and hint, data badge, client list, vehicle table rows, exceeded cards, plan ribbon and cards, downgrade badge/count/ribbon/rows, trend counts, price ribbon/count/rate cards/rows, real-time badge/ribbon/chips/count/rows, and the full contents of every export (vehicles, downgrade, price, trends, real-time).

| Scenario | Differences |
|---|---|
| A — built-in data | **0** |
| B — vehicles file + 3 monthly usage files (trends, smart recommendations) | **0** |
| C — + real-time portal file | **0** |
| D — reload from cloud (vehicle master + months + snapshot) | **0** |

Intended differences, by design:
* With VI data loaded, vehicles whose SIM belongs to VI leave the Airtel view (they were counted as "Without Usage" before). Measured: Airtel view 953 → 892; Without Usage 157 → 96; With Plan, Warning, Critical, Exceeded unchanged; All Providers = 953, the old total.
* The separate bug-fix commit changes exactly two outputs: the vehicle table gains its Plan cell, and the badge reads "3-Month Data" instead of "736-Month Data".

---

## G. Test report

| # | Test | Expected | Actual | Status |
|---|---|---|---|---|
| 1 | Provider = Airtel | only Airtel rows, exports, statuses | 892 vehicles / 690 SIMs, original export names, no Provider column | ✅ |
| 2 | Provider = VI | only VI rows | 61 vehicles / 654 SIMs; `_vi` exports; statuses Active/Ready/Dunning/Suspended | ✅ |
| 3 | Provider = All | Airtel + VI, each once | 953 vehicles = 892 + 61; stat cards add up; 1,344 SIMs | ✅ |
| 4 | VI upload (Summary + Itemized + SIM Group) | valid counts, correct units, reconciled | 466/466/654 valid, 0 duplicate, 0 invalid; 168 SIMs; 9,544 GB; reconciliation matched; matches an independent Python check | ✅ |
| 5 | Same VI files again | nothing counted twice | all three flagged "already uploaded", Process disabled, totals and DB rows unchanged | ✅ |
| 6 | Add an older cycle; reload | history kept | Aug 2026 added, Sep unchanged; both months, inventory and history reload from the cloud | ✅ |
| 7 | Exports per view | Airtel only / VI only / both + Provider column | as expected; combined trends align months by label | ✅ |
| 8 | Filters: provider · client · status · month · plan · search | combine correctly | client+status → 25 VI rows; Month switches VI cycle; ICCID / MSISDN / "airtel" search; a client missing from the new view resets (existing behaviour) | ✅ |
| 9 | Airtel regression vs `main` | identical numbers | 0 differences in 4 scenarios (section F) | ✅ |
| 10 | Future provider | add without dashboard changes | provider registered from a config object appears in selector, comparison and upload dialog; no errors | ✅ |
| — | Migration not run | VI session-only, Airtel unaffected | clear warning; VI works for the session; Airtel unchanged | ✅ |
| — | Pool without a SIM Group file | no pool, nothing assumed | Data Pool asks for the SIM Group; usage tabs work; SIMs with usage are "Not in SIM Group" with no plan (unit tests) | ✅ |
| — | Pro-rated pool on real files (Sep 2026) | matches an independent Python calculation (rules before 6 Oct 2026: Dunning counted, SIM Group of 25 Sep) | 16,269.83 GB allotted (3,840 full + 6,196.5 + 4,845 + 1,388.33 pro-rated) · 9,543.99 used · 6,725.84 available · 41 SIMs above their own allotment; as of 26 Aug: 10,036.5 / 657.76 / 9,378.74; as of 10 Sep: 16,269.83 / 4,727.71 / 11,542.13; Real-time totals = pool; Oct 2026 cycle back to full plans (21,350 GB) | ✅ |
| — | Day picker on real files (Sep 2026) | figures match an independent Python calculation (rules before 6 Oct 2026) | used by 22 Aug 100.15 GB, 3 Sep 2,172.38, 10 Sep 4,727.71 (top consumers identical); after reload the day's data loads from the cloud with the same figures | ✅ |
| — | New cycle (22nd reset) | a 22–24 Sep file goes to Oct 2026, Sep untouched | Oct 2026 = 22 Sep – 21 Oct, day 3 of 30, 379.81 GB, full 21,350 GB pool; Sep keeps 31 days / 9,544 GB, reconciled | ✅ |
| — | Wrong upload recovery | warn, delete, re-upload | misfiled days flagged and not counted; Delete cycle removes its rows, history shows Deleted, the same files upload again | ✅ |
| — | Monthly vs real-time sources | Summary → month-wise only, Itemized → real-time only | Summary-only: month-wise data, Real-time empty state, no pool; Itemized-only: real-time rows + pool, no Month-filter month; reports that disagree show Summary month-wise and Itemized real-time; Month filter on another month leaves real-time and pool unchanged; upload modes, wrong-mode card and Switch, Real-time button opens VI Real-time | ✅ |
| — | Real-time "Data up to" date | editable like Airtel's Snapshot Date | 22–24 Sep report: range 22–24 Sep, default 24 Sep; picking 23 Sep keeps 22–23 Sep in memory and in the database; picker's newest day 23 Sep plus a greyed "24–28 Sep: no Itemized data yet"; same after reload | ✅ |
| — | Pool rules on the real files (Oct 2026, SIM Groups of 25 + 28 Sep) | matches an independent Python calculation | 654 SIMs, 264 count (387 Ready, 2 Dunning, 1 suspend do not); 21,165 full + 1,082.33 pro-rated (15 detected go-live days 25/26/28 Sep) = 22,247.33 GB; used 4,136.57; remaining 18,110.77; 18.59%; on pace 112%; reconciliation 654 / 162 / 162 / 492 / 0 / 0; same after reload (go-live days rebuilt from the saved history + daily usage) | ✅ |
| — | Frozen cycles | a newer SIM Group does not change a closed cycle | Sep 2026 frozen with the 25 Sep SIM Group: 249 SIMs, 16,084.83 GB, used 9,543.99; unchanged after the 28 Sep file and after reload; Recompute overwrites it (admin); without 002 the freeze lasts for the session and the Uploads tab says so | ✅ |
| — | Status rules (admin) | change counts at once, saved, frozen cycles untouched | ticking "Dunning": 265 SIMs, 22,332.33 GB (the 100 GB Dunning SIM still not, no `_DP_`), saved to providers.config; Sep stays 16,084.83; unticking restores 264 / 22,247.33 | ✅ |
| — | Airtel vs `main` after the pool changes | identical numbers | stat cards, exceeded, plans, downgrade, trends, price identical; only the known Plan-cell bug fix and the existing "No plan" filter option differ | ✅ |
| — | 6 Oct 2026 uploads (Summary to 5 Oct + SIM Group of 6 Oct) | pool uses the newer Summary; SIMs without a vehicle visible | Oct 2026: 654 SIMs, 326 count (62 more went Ready → active); 21,165 full + 4,349.17 pro-rated (77 SIMs: 8 dated from Itemized first use, 57 from the Summary bound, 12 from the SIM Group date) = **25,514.17 GB**; used 12,166.18 GB (Summary to 5 Oct); remaining 13,347.99 GB; 47.68%; on pace 102%; Vehicle Wise 326 rows (325 "No vehicle · …"); matches an independent Python calculation; same after reload | ✅ |
| — | Airtel vs `main` after these changes | identical numbers | stat cards, exceeded, plans, downgrade, trends, price identical; only the known Plan-cell fix and the "No plan" filter option differ | ✅ |
| — | Adversarial review (4 reviewers + verifiers) of the 6 Oct changes | defects found and fixed | 15 findings, all fixed with a test each where testable: earlier go-live bound wins; the Summary's own session figures kept per row (new columns in 002); Providers tab leaves "No vehicle" rows out of the vehicle-mapped figures and says how many; unique row keys after a SIM swap; a VI row with usage but no plan is not "without usage"; the Real-time line only quotes the pool when it is the same cycle; a Summary with no session date takes its export date and never makes an open cycle "complete"; trend header; test page warns about stale saved data. The 8 new tests fail on the previous commit and pass now | ✅ |
| — | Operations on the 6 Oct files (forecast, alert, zero / high usage, SIM page) | matches an independent Python calculation | 🚨 Critical: 869.01 GB a day over 14 of 30 days → projected 26,070.38 GB (102.2%); pool lasts 15.36 days → runs out ~21 Oct, gap 0.64 day; shortfall 556.21 GB → backup 620 GB; recent pace 839.71 GB a day (Summary 26 Sep → 5 Oct, same in the session and after reload); zero usage 90 (10 new, 36 no usage, 44 long-term 30+ days); high usage 88; the highest-usage SIM: Summary 264.66 GB, daily 22–26 Sep 20.57 / 19.92 / 16.41 / 20.14 / 23.33, Sep 63.52 GB with 13 zero days | ✅ |
| — | Alert lifecycle on the test page (5 uploads, reloads) | one alert, no repeats | one open Critical alert, updated in place across uploads; pop-up once, refreshed with the newest figures while open; banner stays | ✅ |
| — | Phone width 375 px | no page-wide sideways scroll | every tab in the Airtel, VI and All views, the pop-up and the SIM page fit; tables and the tab bar scroll inside their cards | ✅ |
| — | Airtel vs `main` after the operations work | identical numbers | stat cards, exceeded, plans, downgrade, trends, price, real-time identical; only the known Plan-cell fix, the "No plan" filter option and the one vehicle whose SIM is a VI SIM differ. Fixed on the way: switching from VI to an Airtel view without real-time or trend data kept VI's SIM count, pages and plan options | ✅ |
| — | Per-SIM pace on the 6 Oct files | matches an independent Python calculation | 2.99 GB per SIM a day (Summary 27 Sep – 5 Oct: 7,557.36 GB ÷ 2,530 SIM-days) × 326 SIMs = 973.79 GB a day → 27,746.87 GB (108.75%), runs out ~19 Oct, backup 2,460 GB; Critical confirmed by the 26 Sep evaluation; requirement figures 869.01 GB a day / 26,070.38 GB / 21 Oct shown beside it; identical after reload, with and without 004 | ✅ |
| — | The account owner's example (869 → 4,000 GB a day) | forecast moves with each upload | one 4,000 GB day: runs out 19 → 13 Oct, backup 2,460 → 11,690 GB, pop-up again ('worse than the last alert'); a second such day: jump pace 12.27 GB per SIM a day = 4,000 GB a day, runs out 9 Oct, backup 55,780 GB | ✅ |
| — | Scale rehearsal 1K / 5K / 10K / 20K SIMs | exact pool and used figures at every size | exact; rebuild 34 / 144 / 297 / 623 ms; Data Pool tab 151–331 ms (paged lists); start-up 9 / 23 / 40 / 74 reads; every call ≤ 8,000 rows (~1 MB) | ✅ |
| — | Corrected Itemized re-upload | the cloud holds exactly the new file's days | 23 Sep doubled in the new file: cloud and browser equal day by day; 1 call (changed + newest days) | ✅ |
| — | Unit tests (`tests/providers.test.html`) | pass | 337/337 (incl. 41 for the operations work, 58 for the per-SIM pace, 2-day Critical, re-alert, cycle end, fleet growth, heavy day / jump rules and review fixes, 20 for the universal SIM search, and 26 for the cycle consistency fix and start days from the newest files) | ✅ |
| — | Colour palette validator | pass all-pairs, dark surfaces | pass on #141414, #111111, #0E0E0E | ✅ |

---

## Assumptions to confirm (with VI)
1. ~~DP deals are a shared data pool~~ — **confirmed**: the SIMs on data-pool deals (`_DP_`) share one account pool (SIMs × plan GB). The 100 GB M2MISAFE deal (no `_DP_`) is its own plan (decided 6 Oct 2026).
2. ~~Dunning SIMs hold a paid allocation~~ — **decided 6 Oct 2026: only `active` counts**; Dunning, suspend and Ready do not (an admin can change it). Still worth checking on a VI bill whether Dunning / suspended SIMs are charged.
2a. **Go-live day of a SIM that was Ready:** detected from the SIM Group history and its first data use (see D). Ask VI whether they can fill CONTRACT_START_DATE or send a state-change report — then no detection is needed.
2b. **1 GB = 1024 MB** (Summary 27 Sep = 4,608.82 GB this way, 4,832.70 GB with 1000). Compare one pool "used" figure on the VI portal once.
3. ~~Month label = month the cycle ends in~~ — **confirmed**: the cycle is 22nd → 21st and usage resets on the 22nd.
3a. ~~Full allowance on mid-cycle activation~~ — **confirmed: pro-rated**, plan ÷ 30 per day left (see D). Still to confirm with VI: that the divisor is always 30 (not the cycle's 28–31 days), that the activation day itself counts, and whether the charge is pro-rated too (the dashboard shows costs at full monthly rates).
4. **The vehicle master should contain VI SIM numbers** (ICCID or MSISDN) for vehicle numbers and clients — without them VI SIMs are listed as "No vehicle · <mobile no.>" (since 6 Oct 2026) and the Data Pool says how many.
5. CIRCLE codes are serving-circle codes; ORIGIN_CIRCLE labels appear on a minority of rows.

## Not changed / out of scope
* Data is still processed in the browser (as before) — comfortable for thousands of SIMs; the aggregate views are ready for server-side cards later.
* Airtel stays in its legacy tables (Phase 2 above).
* Provider-level user permissions — possible later with the same RLS helpers.
* Magic-link login on localhost needs `http://127.0.0.1:8791` added to Supabase redirect URLs; password login works as is.
