# VI pool: analysis and proposal (before implementation)

Status: **decided on 6 Oct 2026 and implemented** (live since 13 Oct 2026). The decisions are in §8, what was built in §9. The analysis below is kept as written; where the build differs from the proposal, §5, §6 and §9 say so.
Branch: `feature/multi-provider` (local only, nothing pushed).
Data used: the real VI exports in `D:\DBAI-SIM\vi-test-data`:

- SIM Group of 28 Sep 2026 (654 SIMs), plus the one from 25 Sep for history.
- Usage Summary of 27 Sep 2026, 21:35.
- Itemized of 27 Sep 2026 (days 22–26 Sep).
- Sep 2026 Itemized (22 Aug – 21 Sep).

All three VI sources are **CSV exports, not Excel workbooks**: one table each, no sheets. The other files in Downloads were checked as well:

- `ACTIVATION_*`, `CHANGE_*` and `BULK_DATA_USAGE*` are Airtel IoT files (ICCID 89919…).
- `invoice-summary-*.pdf` is a Jio invoice.

None of them carry VI data.

---

## 0. In one page

Most of the requirement is already built. The analysis found the following:

1. **`DATE_OF_ACTIVATION` is not the date a SIM went live.** All 387 Ready SIMs carry one too, and it is the day the SIM was loaded into the account.
   - Evidence: 15 SIMs were *Ready* on 25 Sep and *active* on 28 Sep. Their first data use was 25–26 Sep, yet their `DATE_OF_ACTIVATION` is 26 Aug or 8 Sep.
   - Pro-rating from that date gives them too much data. In the current cycle they get the full 85 GB instead of 68–76.5 GB, about 193 GB too much.
   - They are also counted in the closed Sep cycle, adding 779 GB they never had.
2. **Status eligibility is hard-coded** (Active + Dunning). Three shortcuts also break your "don't guess" rules:
   - a Ready SIM that used data is counted as Active at 85 GB;
   - a SIM missing from the SIM Group is counted as Active at 85 GB;
   - without a SIM Group, an *estimated* pool is shown.

   All three go. Unmatched and non-eligible usage becomes a flag, and the pool needs the SIM Group.
3. **Past cycles are recomputed with the latest SIM Group.** That is why Sep moved from 16,270 to 17,049 GB when the 28 Sep file arrived. The fix is to store one pool snapshot per cycle and freeze it at cycle end.
4. **The 100 GB plan is a different product.** Its deal `IOT_<account>_IOT_100GB_499_X_M2MISAFE_X` has no `_DP_` (Data Pool) tag, while the 85 GB deal does. Both 100 GB SIMs are Dunning/suspend and have no usage. They are probably not part of the pool.
5. **The current cycle should follow today's date, not the latest file.** Today (6 Oct) is day 15 of 22 Sep – 21 Oct, but the newest Itemized data stops at 26 Sep (10 days old). The dashboard should say so.
6. **Missing screens:**
   - status × pool table;
   - inventory ↔ usage reconciliation;
   - SIM-wise allocation table;
   - per-cycle trend of pool, used, remaining and utilisation;
   - new-activation tile;
   - alerts list;
   - upload checklist.

**Decisions needed before coding:** see §8, D1–D6. Each has a recommended default.

---

## 1. VI data structure

### 1A. SIM Group (the "SIM inventory"): `SIMGROUP_<id>_<account>_<YYYYMMDDHHMMSS>.csv`

There is one row per SIM: 654 rows, 654 unique ICCIDs and no duplicates. The export time exists **only in the file name** (`20260928135632` = 28 Sep 2026, 13:56:32).

| Column | Meaning | Type | Example (masked) | Used for |
|---|---|---|---|---|
| E_CODE | VI enterprise code | text, constant | S-<account code>-… (the account and company name) | check all files belong to one account |
| ACCOUNT_ID | VI account | int, constant | (the account number) | same check |
| SUB_PROFILE_ID / SUB_PROFILE_NAME | sub-account | constant | (the company name) | ignored |
| PRODUCT_TYPE | product | constant | M2M | ignored |
| MSISDN | mobile number (15 digits, unique) | text-number | 91575504xxxxxxx | display "Mobile number"; second key |
| IMSI | subscriber id (unique) | text-number | 40405112xxxxxxx | third key |
| **ICCID** | SIM number, prefixed `~` so Excel keeps all digits | text | ~89910582511303xxxxx (19 digits) | **primary key** (strip `~`, spaces, `'`, trailing `F`) |
| CIRCLE | home circle | constant | Gujarat | display |
| **DATE_OF_ACTIVATION** | date the SIM was added to the account; **filled for every SIM, Ready too** | datetime `YYYY-MM-DD hh:mm:ss.ffffff` | 2026-08-12 18:48:19.000000 | pro-rating start (see D1) |
| **SIM_LIFECYCLE_STATE** | state **as VI writes it** | text | `active` 264 · `Ready` 387 · `Dunning` 2 · `suspend` 1 | status (kept raw) + eligibility rule |
| **DEAL_NAME** | commercial plan | text | `CMP_VI_IOT_<company>_DP_100SMS_85GB_375R_GUJ` (265) · `CMP_Vi_IOT_READY_0_<company>_GUJ` (387) · `IOT_<account>_IOT_100GB_499_X_M2MISAFE_X` (2) | plan GB, price, `_DP_` = Data Pool |
| BASE_PLAN_NAME | base plan | text | `CMP_VI_IOT_<company>_DP_100SMS_85GB_375R` | fallback when DEAL_NAME is blank |
| GROUP_NAME, CONTRACT_START_DATE, CONTRACT_END_DATE, CONTRACT_NAME | — | **always empty** | — | ignored (if VI filled CONTRACT_START_DATE it could be the real plan start, see D1) |

Notes:
- **The state casing is mixed.** `active` and `suspend` are lower case, `Ready` and `Dunning` are capitalised. Today the screen shows "Active" and "Suspended". The database already keeps both forms (`provider_sims.lifecycle_state` raw, `status` normalised), but the UI shows only the normalised label. It must show the raw value.
- **Plan parsing:** GB is read with `(\d+)GB`, the price with `_(\d+)R` / `_(\d+)_`, and the pool tag with `_DP_`.
  - READY_0 means no plan and no price.
  - Nothing is hard-coded per SIM.

### 1B. Data Usage Summary: `SELFCARE_USAGE_SUMMARY_<id>_<account>_<YYYYMMDDHHMMSS>.csv`

There are 383 rows for **167 SIMs**. A SIM has one row per circle it used (1 to 10 rows), so repeated ICCIDs are expected and are **summed, never de-duplicated**.

| Column | Meaning | Type | Example | Used for |
|---|---|---|---|---|
| E_CODE, ACCOUNT_ID | account | constant | | account check |
| MSISDN, IMSI, ICCID | SIM keys | | | join to SIM Group |
| CIRCLE | circle code where data was used | int (18 codes) | 1130499 | row split, circle analysis |
| `TOTAL_USAGE:Data-kiloBytes/Voice-Seconds/SMS-Count` | data used **in kB** | decimal | 982.5674 | cycle-to-date usage per SIM |
| ORIGIN_CIRCLE | roaming label | text (249/383 filled) | GUJ_HOME, MP_GUJ | display |
| Last_Packet_Switched_Session_End | last data session | datetime | 2026-09-21 16:30:09 | which cycle the file belongs to; "data as of" |
| Packet_Switched_Session_Days | days with data in the cycle | int 1–6 | 2 | active days |

There is **no billing-period column**. The cycle is derived from the session dates; the export time comes from the file name.

### 1C. Itemized Data Summary: `SELFCARE_USAGE_ITEMIZED_<id>_<account>_<YYYYMMDDHHMMSS>.csv`

There are 372 rows for **162 SIMs**, again one row per SIM per circle.

| Column | Meaning | Type | Example | Used for |
|---|---|---|---|---|
| E_CODE, ACCOUNTID, MSISDN, IMSI, ICCID, CIRCLE | as above | | | join |
| `2026-09-22` … `2026-09-26` | one column per day; **bytes**, blank = no use | int | 382112931 | daily usage, pool used, as-of day |
| `TOTAL_USAGE:Data-KiloBytes/…` | row total in **kB** | decimal | 373157.1592 | check: Σ day columns ÷ 1024 = total, exact for all 162 SIMs |
| ORIGIN_CIRCLE, Last_Packet_Switched_Session_End, Packet_Switched_Session_Days | as above | | | display |

### 1D. Units, join and duplicates

- **Units:** day columns are in bytes, totals in kB. The dashboard uses **1 GB = 1024³ bytes = 1024² kB**.
  - The 27 Sep Summary is 4,608.82 GB in binary units, or 4,832.70 GB if VI uses decimal GB. That is a 5% difference (see D6).
- **Join:** ICCID matches across all three files. The Summary has 167 of 167 SIMs matched and the Itemized 162 of 162. **No usage SIM is missing from the SIM Group.**
- **Duplicates:**
  - SIM Group: none (a duplicate ICCID will stop the upload).
  - Usage files: one row per circle, summed.
  - The same file uploaded twice is skipped by its SHA-256 hash, which already exists.

---

## 2. Data relationship

```text
SIM Group (1 row / SIM, latest export = current inventory; every export kept as history)
   │  ICCID  (MSISDN / IMSI as fallback keys)
   ├──────────────► Usage Summary   (rows per SIM × circle, kB, cycle-to-date)  → MONTH-WISE tabs
   └──────────────► Itemized        (rows per SIM × circle, bytes per day)      → REAL-TIME + POOL USED
                         │
SIM record = raw state + plan (from deal) + start date + usage
                         │
Billing cycle 22nd → 21st (label = month it ends: "Oct 2026" = 22 Sep – 21 Oct)
                         │
Eligibility (status rule × pool tag × start date in cycle) → SIM allocation
                         │
Pool = Σ allocation · Used = Σ Itemized bytes in cycle · Remaining · Utilisation · Forecast
                         │
Cycle snapshot (frozen at cycle end) → trend
```

**Primary vs detail source (point 32), already in place and kept:**

| Use | Source | Why |
|---|---|---|
| Month-wise tabs (vehicle, plan, trend) | Usage Summary | VI's own cycle total per SIM |
| Real-time tab, pool *used*, as-of day, forecast | Itemized | the only source with daily figures, so it can be cut at any day |
| Validation | Summary vs Itemized per SIM | gaps are explained by export time (Summary 27 Sep 21:35 vs Itemized to 26 Sep accounts for 472 GB) |

The two sources are never added together.

---

## 3. Formulas

Calculations keep full precision; the screen shows 2 decimals.

| # | Item | Formula |
|---|---|---|
| F1 | Cycle containing date *d* | if day(*d*) ≥ 22: 22 of this month → 21 of next month; else 22 of previous month → 21 of this month |
| F2 | Current cycle | F1(today, IST). Today, 6 Oct 2026 → **22 Sep – 21 Oct 2026**, day 15 of 30 |
| F3 | Cycle days | end − start + 1 (28–31) |
| F4 | Daily allocation | plan_GB ÷ plan_days, with plan_days = 30 from config. 85 ÷ 30 = 2.833333… |
| F5 | SIM start date | see D1 (VI date, or detected go-live) |
| F6 | Eligible days | start ≤ cycle start → **full cycle**; cycle start < start ≤ cycle end → cycle end − start + 1 (start day counts); start > cycle end → 0 |
| F7 | SIM allocation | full cycle → plan_GB (always the full plan, whether the cycle has 28 or 31 days); otherwise min(plan_GB, eligible days × F4); 0 if not eligible |
| F8 | Eligible | status rule says yes **and** plan_GB > 0 **and** pool tag (D3) **and** in SIM Group |
| F9 | Total pool | Σ F7 over eligible SIMs = **Full allocation** (start ≤ cycle start) + **Pro-rated allocation** (start in cycle) |
| F10 | New activations | eligible SIMs with start in the cycle: count and Σ F7 |
| F11 | Used | Σ Itemized bytes ÷ 1024³ for days in [cycle start, min(cycle end, as-of day)], eligible SIMs. Usage by non-eligible or unmatched SIMs is shown separately and flagged |
| F12 | Remaining | Pool − Used (can go below 0 = over the pool) |
| F13 | Utilisation % | Used ÷ Pool × 100 |
| F14 | Forecast | avg/day = Used ÷ days with data; projected = avg × cycle days; risk if projected > Pool; run-out day = cycle start + Pool ÷ avg |
| F15 | Per SIM | remaining = allocation − used; usage % = used ÷ allocation. Informational only, since any SIM may use the pool |

**Day-count convention (point 10):**

- The start day counts.
- The divisor is always 30.
- Allocation is capped at the plan.
- This is the rule you gave (85 ÷ 30 = 2.83 per day) and what runs today.

Examples for the 22 Sep – 21 Oct cycle:

| Start | Days | Allocation |
|---|---|---|
| 10 Sep | full | 85 GB |
| 22 Sep | 30 | 85 GB |
| 25 Sep | 27 | 76.50 GB |
| 10 Oct | 12 | 34.00 GB |
| 21 Oct | 1 | 2.83 GB |
| 25 Oct | 0 | 0 (counts in the next cycle) |

---

## 4. Edge cases

| # | Case | Rule | Today |
|---|---|---|---|
| 1 | Started before the cycle | full plan | ✅ |
| 2 | Started on the 22nd | full plan (30/31 days ≥ cap) | ✅ |
| 3 | Started mid-cycle | days × plan/30 | ✅ |
| 4 | Started on the 21st | 1 day = 2.83 GB | ✅ |
| 5 | Starts after the cycle end | 0 in this cycle | ✅ |
| 6 | `active` | eligible (config) | ✅ hard-coded → config |
| 7 | `Ready` | not eligible (deal READY_0 has no plan or price) | ✅ hard-coded → config; ❌ "Ready + used data → counted Active 85 GB" to be removed |
| 8 | `suspend` | **D2** | not eligible, hard-coded |
| 9 | Eligible SIM with no usage | used = 0, still in the pool (104 SIMs now) | ✅ |
| 10 | Usage SIM not in SIM Group | status "Not in SIM Group", **not** in the pool, flagged | ❌ today counted Active 85 GB (0 such SIMs in current files) |
| 11 | `Dunning` (payment overdue) | **D2** | eligible, hard-coded |
| 12 | Ready in an older SIM Group, active in a newer one | **D1**: VI date is too early | ❌ |
| 13 | Plan without `_DP_` (100 GB M2MISAFE) | **D3** | in the pool |
| 14 | SIM suspended or removed mid-cycle | only the state on the export day is known; the cycle's frozen snapshot keeps what was billed (D4) | ❌ |
| 15 | Cycle of 28/29/31 days | full plan, never days × 2.83 | ✅ |
| 16 | Several rows per SIM (circles) | sum | ✅ |
| 17 | Part-day export | "Data up to" cut-off on Itemized | ✅ |
| 18 | Summary newer than Itemized | reconciliation note | ✅ |
| 19 | Plan change mid-cycle | latest plan; VI gives no change date | note only |
| 20 | No SIM Group yet | **no pool**; usage tabs still work; card "Upload the SIM Group" | ❌ today an estimated pool is shown |
| 21 | SIM Group older than the cycle start | warning "SIM Group is N days old" | ❌ |
| 22 | Newest usage data older than 2 days | warning "Itemized data ends 26 Sep — upload a newer report" | 🟡 |
| 23 | Same SIM Group uploaded twice / an older one later | hash skip / kept as history, does not replace the latest | 🟡 |

---

## 5. Database changes

All changes are additive and go in a new `sql/002_vi_pool.sql`, with the same RLS pattern as 001. No Airtel table changes.

**Already in place (001):**

- `upload_batches`: `id`, `provider`, `source_type`, `source_file`, `file_hash`, `reporting_period`, `period_start`/`period_end`, `uploaded_by`, `uploaded_at`, `status`. This covers point 42.
- `provider_sims` keeps both `lifecycle_state` (raw) and `status` (normalised). This covers point 4.

**New:**

1. **`provider_sim_snapshots`** keeps every SIM Group export: `provider`, `snapshot_at` (export time from the file name), `upload_batch_id`, `iccid`, `msisdn`, `imsi`, `lifecycle_state`, `plan_name`, `plan_gb`, `plan_price`, `pooled`, `activated_at`. Primary key: (provider, snapshot_at, iccid).
   - Versioning (point 43): the newest `snapshot_at` is "current", and `provider_sims` mirrors it.
   - An older export is stored as history only.
   - The same export twice is skipped.
2. ~~New go-live columns on `provider_sims`~~ — **not needed**. The go-live day is derived on load from the SIM Group history (table 1) and the daily usage, so it can never go stale.
3. **`provider_cycle_pool`**, one row per cycle (points 33 and 34). Columns:
   - identity and bounds: `provider`, `reporting_period`, `cycle_start`, `cycle_end`;
   - SIM counts: `snapshot_at` (which SIM Group), `total_sims`, `eligible_sims`, `non_eligible_sims`;
   - pool: `full_gb`, `prorated_gb`, `pool_gb`;
   - usage: `used_gb`, `remaining_gb`, `utilisation_pct`, `data_until`;
   - activations: `new_activations`, `new_activation_gb`;
   - audit: `status_counts` jsonb, `rules` jsonb (status and plan config used);
   - state: `frozen`, `computed_at`, `computed_by`;
   - `sims` jsonb: each SIM's allocation as frozen (state, eligible, start, source, GB, days).
4. **`providers.config`** (the jsonb column already exists) holds the VI rules, so changing them needs no code change (points 15, 23, 38):

```json
{ "pool_rules": {
    "cycle_start_day": 22,
    "plan_days": 30,
    "pool_tag": "_DP_",
    "status_rules": { "active": true, "ready": false, "dunning": false, "suspend": false },
    "prelive_states": ["ready"] } }
```

As built: states are matched in any case ("active" = "Active"). The GB unit is fixed at 1024 (D6), so it is not a setting.

A new raw state that appears in a later file is shown as it is and treated as **not eligible** until an admin sets a rule. The dashboard flags it.

---

## 6. UI changes (VI only)

1. **Cycle header:** "Billing cycle 22 Sep 2026 → 21 Oct 2026 · day 15 of 30 · Plan 85 GB / 30 days = 2.83 GB/day · data up to 26 Sep (10 days old)".
2. **Pool summary** (Data Pool tab and the strip on Real-time):
   - Tiles: Inventory SIMs · Eligible · Not eligible · Full allocation · Pro-rated allocation · **Total pool** · Used · Remaining · Utilisation % (2 dp) · New activations (count + GB).
   - Each tile names the concept it shows, so inventory, eligible, allocated, used and remaining are never mixed.
3. **SIM status and pool table:** raw status exactly as in the file · SIMs · eligible? (rule) · pool GB · used GB · the reason.
4. **SIM-wise allocation table:**
   - Columns: ICCID, mobile number, vehicle, raw status, VI activation date, start date used (+ source), plan, eligible days, GB/day, allocation, used, remaining, usage %.
   - Search, filter, CSV export.
5. **Usage analysis:** top consumers, low consumers, SIMs above their allocation, eligible SIMs with no usage (partly there today).
6. **Billing-cycle trend:** table and bar chart per cycle with SIMs, pool, used, remaining and utilisation, taken from the frozen snapshots.
7. **Reconciliation:**
   - Inventory ↔ usage: inventory SIMs · usage SIMs · matched · inventory without usage · usage without inventory · usage on non-eligible SIMs.
   - Below it, the existing Summary ↔ Itemized check.
8. **Alerts:**
   - pool utilisation ≥ 80%;
   - projected over the pool;
   - remaining < 3 days of pace;
   - SIM above its allocation;
   - mid-cycle activations;
   - SIM not in the SIM Group;
   - usage on a non-eligible SIM;
   - new unknown status;
   - SIM Group or Itemized data stale.
9. **Upload dialog, VI checklist:**
   - Rows: SIM Group (**required for the pool**), Usage Summary (required for month-wise), Itemized (required for real-time and pool used).
   - Each row shows Required/Optional · Uploaded (date) · Missing.
   - The SIM Group can be uploaded on its own.
   - Missing ICCID, state, activation date, or usage columns stop the upload with the reason.
10. **Rules (admin):** as built, the "Counts in pool" column of the status table is a tick box for admins. It is saved to `providers.config` for everyone. Frozen cycles keep their rules; **↻ Recompute** (Data Pool header, Uploads tab) applies new rules to a closed cycle.

Figures with the current files, Oct 2026 cycle, with the decisions as taken (D2 = only `active`). These are verified on the test page and match an independent Python calculation:

| | Today on screen | After the change |
|---|---|---|
| Inventory / eligible / not eligible | — / 266 / — | 654 / 264 / 390 (387 Ready, 2 Dunning, 1 suspend) |
| Full allocation | 22,625 GB | 21,165.00 GB (249 × 85) |
| Pro-rated (new activations) | 0 SIMs | 15 SIMs · 1,082.33 GB (6 went live 25 Sep, 2 on 26 Sep, 7 on 28 Sep — detected) |
| **Total pool** | 22,625 GB | **22,247.33 GB** |
| Used (to 26 Sep) | 4,136.57 GB | 4,136.57 GB |
| Remaining | 18,488.43 GB | 18,110.77 GB |
| Utilisation | 18.28% | 18.59% (on pace for 112%, runs out around 18 Oct) |
| Sep 2026 (closed) | 17,049 GB | 16,084.83 GB, 249 SIMs, frozen with the 25 Sep SIM Group |

---

## 7. Airtel compatibility

- All VI logic stays in `js/providers/vi*.js` behind the provider registry. The Airtel code in `index.html` is not touched.
- The new tables are VI/provider tables only. Airtel's tables and RPCs do not change.
- "All providers" view:
  - It adds up SIM counts and usage only.
  - Pools, cycles and plans stay per provider: Airtel keeps its calendar month and plan cards, and VI keeps its 22nd–21st pool.
  - A VI pool figure is never added to Airtel figures.
- Regression: the existing harness compares Airtel output with `main` (today only the two known bug-fix differences) and must stay that way. As built: 165/165 unit tests pass. The Airtel comparison with `main` shows only the two known bug-fix differences.

---

## 8. Decisions (taken 6 Oct 2026)

Answers: **D1** VI date + detect Ready → active · **D2** only `active` counts (Dunning, suspend, Ready do not) · **D3** only `_DP_` deals · **D4** freeze at cycle end · **D5** no pool without a SIM Group · **D6** 1 GB = 1024 MB.

Later the same day (after the 6 Oct Summary + SIM Group uploads): **D7** the pool's used data comes from the **newest** report (Summary or Itemized; the Real-time tab stays on the Itemized report) · **D8** SIMs without a vehicle number are listed in the month-wise tabs as "No vehicle · <mobile no.>" when they count or used data. With the 6 Oct files: pool 25,514.17 GB (326 SIMs), used 12,166.18 GB, remaining 13,347.99 GB (47.68%).

| # | Question | What the data shows | Before | Recommended |
|---|---|---|---|---|
| **D1** | Which date starts pro-rating? | `DATE_OF_ACTIVATION` is set when the SIM is loaded (all Ready SIMs have one). 15 SIMs went Ready → active between 25 and 28 Sep, but their date says 26 Aug / 8 Sep. | VI date as is | VI date, **except** for a SIM the dashboard saw as Ready in an earlier SIM Group: then use its first day with usage after that file, or the export date of the first file showing it active. Mark it "detected". Ask VI whether they can fill `CONTRACT_START_DATE` or provide a state-change report. Upload the SIM Group **on the 22nd each month** and on any day you activate SIMs. |
| **D2** | Which raw states are in the pool? | `active` 264 · `Ready` 387 (deal READY_0, ₹0) · `Dunning` 2 · `suspend` 1 | active + Dunning | active ✅, Dunning ✅ (still billed), Ready ❌, suspend ❌, unknown ❌. Confirm on the next VI bill whether Dunning or suspended SIMs are charged ₹375. |
| **D3** | Is the 100 GB plan pooled? | Its deal has no `_DP_` tag and is a different product (M2MISAFE, ₹499). Both SIMs are Dunning/suspend with 0 usage. | pooled | not pooled: only deals tagged `_DP_` join the pool (configurable) |
| **D4** | Closed cycles | A newer SIM Group re-dates old SIMs (Sep +779 GB) | recomputed | **freeze** each cycle at its end with the SIM Group nearest the 21st; an admin can recompute on purpose |
| **D5** | No SIM Group uploaded | — | estimated pool (SIMs in usage × 85) | **no pool**: show "Upload the SIM Group"; usage tabs still work |
| **D6** | GB unit | Summary = 4,608.82 GB (1024) or 4,832.70 GB (1000) | 1024 | 1024. Please compare one pool "used" figure on the VI portal with the dashboard once. |

## 9. Implementation (done)

1. **Logic (`vi.js`):**
   - status rules from config, with the raw status shown;
   - remove the late, assumed and estimate shortcuts;
   - unmatched-SIM handling;
   - start-date rule (D1);
   - pool tag (D3);
   - current cycle by today;
   - full, pro-rated and new-activation figures;
   - inventory ↔ usage reconciliation;
   - per-SIM allocation rows;
   - alerts.

   New unit tests cover the edge cases.
2. **Database:**
   - `sql/002_vi_pool.sql` (SIM Group history, frozen cycle pools, VI rules in `providers.config`) plus `002_vi_pool_rollback.sql`;
   - mock database and `cloud.js` support;
   - SIM-Group-only upload and versioning.
3. **UI:** cycle line, pool tiles, alerts, status table with rule tick boxes, SIM Group ↔ usage reconciliation, billing-cycle trend, usage analysis, SIM-wise table (search + CSV), upload checklist, frozen chip + Recompute.
4. **Test page, regression and docs:** update the test page, run the Airtel regression and update the docs, then commit locally. **No push until you confirm.**
