# VI operations: SIM daily history, pool exhaustion warning, zero-usage SIMs

Status: **built** on 6 Oct 2026 after the analysis below (requirement §55) and the decisions in §K. Live since 13 Oct 2026.
What was built, and where it differs from this proposal, is in §L. **§M (7 Oct 2026) replaces the forecast basis and adds the any-fleet-size work** — read it first; where §D/§F differ from §M, §M applies. The sections before §L are the analysis as approved, with the decided values filled in.

Data used for this analysis is every VI export in Downloads:

- 8 Itemized reports, 10 Aug → 27 Sep;
- 10 Data Usage Summaries, 7 Aug → 6 Oct (plus one duplicate copy);
- 7 SIM Groups, 7 Aug → 6 Oct.

---

## 0. In one page

**What already exists** (built on 6 Oct; the gap table is in §J):

- Per-SIM daily usage from the Itemized report is stored and loaded on demand.
- The vehicle pop-up has a per-SIM daily bar chart.
- The pool shows the total, used, remaining, utilisation and a projected %.
- A critical alert fires when the projection exceeds the pool, with a run-out day.
- There is an idle-SIM count and an "above own allocation" list.

**What is new:**

1. A SIM detail page:
   - summary statistics;
   - an area chart with zero days and a 2.83 GB/day reference line;
   - a cycle picker;
   - a cycle comparison;
   - last usage date.
2. The pool forecast adds the shortfall, a backup recommendation and the gap in days.
3. Healthy / Warning / Critical levels with configurable thresholds.
4. A risk card, a persistent banner and a one-time pop-up.
5. Alert history without spam.
6. A burn-rate chart.
7. A zero-usage SIM list with categories, last usage and an advised action. Nothing is ever closed automatically.

**Facts from your files** (§A):

- **There are no session rows.** The Itemized report is already aggregated per SIM × circle × day, in bytes. A SIM's day = the sum over its circles.
- **Days are in Indian time (IST); no conversion is needed.** For 162 of 162 SIMs, the latest day with usage equals the date of the last session. The 6 SIMs whose last session ended between 00:00 and 05:59 also land on their own day, which would not happen if the day buckets were UTC.
- **An export stops at the day before it was taken.** That newest day is still about **0.3–0.4% low** (20 Sep: 608.59 → 610.93 GB; 24 Sep: 809.10 → 811.39 GB in the next export). Older days never change. The dashboard marks the newest day as "may still grow".

**Your situation today** (Oct cycle, data to 5 Oct) — per-SIM pace (§M), with the requirement's cycle-average figures beside it:

| | Per-SIM pace (decides) | Cycle average (requirement figures) |
|---|---|---|
| Pool | 25,514.17 GB | |
| Used | 12,166.18 GB (day 14 of 30) | |
| Pace | **2.99 GB per SIM a day × 326 SIMs = 973.79 GB a day** (Summary 27 Sep – 5 Oct: 7,557.36 GB ÷ 2,530 SIM-days; allowed 2.83) | 869.01 GB a day |
| Projected use | **27,746.87 GB (108.75%)** | 26,070.38 GB (102.2%) |
| Runs out | **~19 Oct**, 2.3 days before the cycle ends | 21 Oct |
| Shortfall → backup | **2,232.71 GB → 2,460 GB** (+10%, rounded up to 10 GB) | 556.21 GB → 620 GB |
| Level | **🚨 Critical** — over the pool on 26 Sep and on 5 Oct (2 data days in a row) | |

The pace compares like with like: for the same day (26 Sep) the Summary of 27 Sep says 4,608.82 GB and the Itemized report 4,136.57 GB, so mixing the two would distort it.

**Zero usage today:** 90 of 326 pool SIMs.

- 44 have had no usage for 30+ days (long-term — candidates to stop before the next cycle).
- 36 have had no usage for 3–29 days.
- 10 went live less than 3 days ago.
- At ₹375 each that is **₹33,750 a month**.

**High usage:** 88 pool SIMs run at ≥ 150% of 2.83 GB a day over the cycle. 54 SIMs have already used more than their own 85 GB. The shared pool covers this; it is analysis, not a pool alert.

**Decisions:** §K (taken 6 Oct 2026) and §M (7 Oct 2026).

---

## A. Itemized report analysis

File: `SELFCARE_USAGE_ITEMIZED_<id>_<account>_<YYYYMMDDHHMMSS>.csv`.

- The export time in the file name is IST: the file of 14:12 was saved at 14:16 IST.
- 27 Sep export: 372 rows, 162 SIMs, up to 10 circle rows per SIM. The Sep export had up to 14.

| Column | Meaning | Example | Type | Used for |
|---|---|---|---|---|
| E_CODE, ACCOUNTID | account | (the VI account number) | text / int | account check |
| MSISDN | mobile number | 91575504xxxxxxx | text | display, vehicle match |
| IMSI | subscriber id | 40405112xxxxxxx | text | vehicle match |
| ICCID | SIM number (`~` prefix) | ~89910582511303xxxxx | text | **SIM key** |
| CIRCLE | circle code where data was used | 1130499 | int | row key (one row per circle) |
| `YYYY-MM-DD` (one per day) | data used that day in that circle, **bytes**; empty = none (no explicit 0s) | 382112931 | int | **daily usage** |
| TOTAL_USAGE:Data-KiloBytes/… | row total, **kB** (= Σ days ÷ 1024 on every row) | 373157.1592 | decimal | check |
| ORIGIN_CIRCLE | roaming label | MP_GUJ | text | display |
| Last_Packet_Switched_Session_End | last session end, `YYYY-MM-DD hh:mm:ss`, IST, no zone | 2026-09-26 23:41:07 | datetime | last-use time, timezone check |
| Packet_Switched_Session_Days | days with sessions (per circle) | 5 | int | active days |

What the file is and is not:

- **No session-level data and no per-session timestamps.** The per-day values are VI's own daily totals. "Sessions" cannot be shown, and the session example in requirement §5 does not occur in this export.
- **Duplicates:** the same SIM + circle appears once per file. A repeated row is flagged and skipped (already in place).
- **Overlap with the Summary:**
  - Exported minutes apart (25 Sep 15:47 / 15:48), the two match exactly: 168 SIMs, 9,543.99 GB, every SIM equal.
  - Exported at different times, the Summary is cycle-to-date at its export time, while the Itemized report stops at the previous day.
  - They are never added together. The pool uses the newer one (decided 6 Oct).
- **Timezone:** IST, as explained in §0. No conversion. The dashboard's own "today" is computed in Asia/Kolkata as well (not the browser's clock), so a viewer outside India sees the same day.
- **Late data:** the newest day of an export is provisional (+0.3–0.4% later). Older days are final. Re-uploading a newer report replaces the days, so nothing is added twice.

## B. Daily usage per SIM: formula

```text
daily_GB(SIM, day) = Σ over the SIM's circle rows of bytes(day) ÷ 1024³
```

- An empty cell is 0.
- A day of the cycle that is not in any report is **no data**, not 0. The chart shows it greyed.
- A day the report covers but where the SIM is empty is **0 GB**, and it is shown.
- Unit: 1 GB = 1024 MB (decided).

**Daily figures come only from the Itemized report.** A cycle that has only a Summary has no daily chart; the page says so, and no daily values are made up from totals.

Per-SIM statistics for the selected cycle, using days from max(cycle start, SIM start) to the last day with data:

| Item | Formula |
|---|---|
| Total | Σ daily_GB |
| Average per calendar day | total ÷ days covered (zero days included) |
| Average per active day | total ÷ days with usage |
| Highest day | max daily_GB, with its date |
| Lowest day | min daily_GB, with its date. A 0 is shown as such |
| Days with usage / zero-usage days | count > 0 / count = 0, over days covered |
| Trend | average of the last 7 covered days vs the 7 before: ↑ above +15%, ↓ below −15%, otherwise → (thresholds configurable) |
| Allocation | the SIM's eligible allocation (pro-rated, as on the Data Pool tab) |
| Remaining allocation | allocation − total. Informational: the pool is shared |
| % of daily allocation (per day) | daily_GB ÷ (plan ÷ 30) |
| High-usage day | % of daily allocation ≥ 150% (configurable) — an analytical flag, **not** a pool alert |
| Last usage | latest day with usage in any stored report (Itemized days; Summary last session for cycles without daily data). "Never used" if none |

## C. SIM history data model

**Already stored:** `provider_sim_usage_daily` (provider, reporting_period, iccid, circle, usage_date, used_mb).

- It is exactly the Itemized grain, so it is the raw audit data.
- Primary key: (provider, iccid, circle, usage_date). This already serves "one SIM's history" through its provider + iccid prefix.
- Index: (provider, reporting_period, usage_date).

**New, as views (no copies of the data):**

- `provider_sim_daily` — circles summed: provider, iccid, usage_date, reporting_period, used_mb. Feeds the SIM page.
- `provider_sim_last_use` — one row per SIM: last day with usage (daily table), else last session (Summary rows). Feeds zero-usage and activity.

**Loading:** opening a SIM loads only that SIM's daily rows for the chosen cycle or range, which is about 30 rows. Nothing else is fetched.

## D. Pool forecast formulas

All figures come from the pool of the cycle (decided rules) and from the newest usage report.

| Item | Formula | Today |
|---|---|---|
| Total pool | Σ allocations of the SIMs that count | 25,514.17 GB |
| Used | newest report, cycle-to-date | 12,166.18 GB |
| Remaining | pool − used | 13,347.99 GB |
| Days elapsed | data day − cycle start + 1 | 14 (to 5 Oct) |
| Days remaining in the cycle | cycle end − data day | 16 |
| Average per day | used ÷ days elapsed (**whole cycle, so one spike does not decide**) | 869.01 GB |
| Projected use | average × cycle days | 26,070.38 GB (102.2%) |
| Days the pool lasts | remaining ÷ average | 15.36 |
| Exhaustion date | data day + ceil(days it lasts); only if ≤ cycle end | 21 Oct |
| Gap | days remaining in the cycle − days it lasts | 0.64 day |
| Shortfall | max(0, projected − pool) | 556.21 GB |
| Recommended backup | shortfall × (1 + margin), rounded up to 10 GB; the calculation is shown | 620 GB (10%) |
| Recent pace (secondary) | the average of the last 7 Itemized days when they are current; else the change since the previous upload of the same report ÷ days between them | 839.71 GB/day |

**Updates on every upload; nothing is stored as "the" date.** Each evaluation is also saved as a pool snapshot (§G), so the burn-rate history and the alert trail show how the forecast moved.

**Assumption shown on screen:** SIMs that go live later add allocation *and* usage. The forecast uses today's pool and today's pace.

## E. Zero usage

**Definition** (requirement §30):

```text
A SIM that counts in the current cycle's pool (active, _DP_, started on or before the data day)
with exactly 0 bytes from max(cycle start, its start) to the data day of the newest report.
```

**Categories:** thresholds are configurable (`ops.zero_new_days`, `ops.zero_long_days`); decided values below (§K).

| Category | Rule | Today |
|---|---|---|
| Newly activated — no usage | days since start < **3** | 10 |
| No usage | started 3+ days ago, no usage for less than **30** days (since last usage, or since start if never used) | 36 |
| Long-term no usage | no usage for **30+** days: since last usage, or since start if never used — "stop it before the next cycle" | 44 |

**Columns:**

- SIM, mobile no., vehicle, status as in the file, VI activation date, counts-from date;
- days since start, usage (0), last usage (date or "Never");
- days since last usage, category, plan cost.

**Action:** "Review — consider closure if the device is no longer needed". The dashboard **never** closes or changes a SIM.

**Cost:** zero-usage SIMs × their plan price from the deal name (₹375). The price is reliable because it is in the deal. Today: ₹33,750 a month.

**Edge cases:**

- **Ready SIMs** do not count in the pool, so they are not zero-usage SIMs. Ready ones are inventory with ₹0, and they get a separate count.
- **SIMs missing from the SIM Group** are not listed (no status).
- **A Summary lag** means a SIM that used data only after the report's day shows as zero "to 5 Oct". The data day is printed.
- **Near-zero usage** (for example 10 KB) is **not** zero, as the requirement asks. It can optionally be listed as "below 1 MB".
- **SIMs that start later in the cycle** are judged from their start, not from the 22nd.

## F. Alert logic

The alert is for the **shared pool only**. A SIM above its own allocation is a "high usage SIM" in the SIM analytics, never a pool alert.

| Level | Condition (decided, §K) |
|---|---|
| **Critical** | Remaining ≤ 0, **or** (at least **3** days of data **and** projected use > pool, i.e. it runs out before the cycle ends) |
| **Warning** | Not critical **and** (projected use ≥ **90%** of the pool, **or** the recent pace — last 7 Itemized days, or the last two uploads of the same report — would run out before the cycle ends, **or** projected use > pool with fewer than 3 days of data) |
| **Healthy** | Otherwise |

**Spikes:**

- The level uses the whole-cycle average.
- One heavy day cannot make it Critical on its own. The recent pace can at most raise a Warning.
- The first 2 days never raise Critical from the projection.

**Lifecycle:** one open alert per provider and condition, stored in `provider_alerts` with these fields:

- `first_detected`, `last_updated`, level;
- the figures behind it;
- `resolved_at`, `resolution_reason`.

**How it behaves:**

- **Re-evaluation:** on every upload and every dashboard open.
- **Same condition again:** `last_updated` is updated; no new alert and no new pop-up.
- **Escalation** (Warning → Critical) is recorded and shows the pop-up once.
- **Back to Healthy:** the alert is closed. The reason is "pool increased / usage pace changed", with the old and new figures.

**Pop-up:**

- It opens once for each newly opened or escalated alert, for each person.
- The "dismissed" state is remembered per alert in that browser.
- The **banner stays visible** until the alert is resolved.

**Limitation:** the dashboard has no server. Alerts are evaluated when someone opens the dashboard or uploads data. An email or WhatsApp alert while nobody has it open would need a scheduled server job (a Supabase scheduled function). That is not part of this proposal (§K, question 4).

## G. Database changes

New script `sql/003_vi_operations.sql`:

- additive;
- same row-level security as before (read = active users, write = Admin);
- with a rollback script.

| Object | Purpose | Key / index |
|---|---|---|
| table `provider_pool_snapshots` | one row per evaluation: period, data day, source, pool, used, average, projected, level | (provider, reporting_period, as_of, source) |
| table `provider_alerts` | alert history and the one open alert | id; unique (provider, code) where status = 'open'; index (provider, first_detected desc) |
| `providers.config.pool_rules.ops` | thresholds: warning % (90), minimum days (3), backup margin (10%), rounding (10 GB), recent days (7), zero-usage days (3 / 30), high day (150%), trend (±15%) | editable by an admin |

The two proposed views (`provider_sim_daily`, `provider_sim_last_use`) were **not needed**: the SIM page reads one SIM's rows straight from `provider_sim_usage_daily` (its primary key starts with provider + iccid), and the last usage day is taken from the cycles already loaded (Itemized days, else the Summary's last session).

**Not needed**, because the existing structures already cover them:

- `billing_cycles` (computed from the 22nd rule);
- `plans` (read from the deal names);
- `sim_inventory` (`provider_sims` + `provider_sim_snapshots`);
- `usage_records` / `daily_sim_usage` (`provider_sim_usage_daily` is that table);
- `upload_batches` (exists).

## H. UI / UX

**1. VI Operations block** at the top of every tab whenever VI is in view. It replaces today's pool strip.

- A level badge (Healthy / Warning / Critical) and the banner sentence. Example: "🚨 Shared pool runs out around 21 Oct — 0.6 day before the cycle ends. Arrange ≥ 620 GB backup."
- **Pool risk card**, the most visible: remaining, average per day, days the pool lasts vs days left in the cycle, exhaustion date, risk.
- Total / used / remaining / utilisation, and SIM inventory / counted / zero usage.
- "View pool forecast" button.
- A **one-time pop-up** for a new Critical, with the requirement §21 content: pool, used, remaining, average, exhaustion date, cycle end, gap, backup with its calculation, and "View pool analysis".

**2. Data Pool tab additions:**

- **Burn-rate chart.** X axis: the cycle days.
  - Cumulative used: actual from the Itemized days, plus points from each Summary upload.
  - Projection: a dashed line from the latest point at the cycle-average pace.
  - Pool limit: a step line, rising when SIMs start.
  - The exhaustion day marked.
  - Table view; tooltips with the date, GB and % of the pool.
- **Forecast panel** with the §D table, the backup recommendation and its calculation, the assumptions, and the recent pace.
- **Alert history:** date, level, figures, status, resolved reason.
- **Zero-usage SIMs:** a card with the category counts (click to open), then a list with category filter, search and CSV.
- **High-usage SIMs:** pace above the daily allocation, sorted by pace. An analytical list.

**3. SIM detail page.** A large dialog that opens from any SIM: vehicle rows, the SIM-wise table, the zero and high lists, Real-time rows.

- **Header:** SIM no., mobile no., vehicle, provider, status as in the file, VI activation date, counts from (source), plan, billing cycle.
- **Allocation and usage:** eligible days, eligible allocation, used, remaining, usage %. This is labelled "the shared pool covers usage above this".
- **Daily usage chart:**
  - an SVG area/line chart, hand-made in the same style as the dashboard (no new library);
  - zero days on the baseline, highlighted;
  - no-data days greyed;
  - a dashed 2.83 GB/day reference line;
  - high days marked;
  - hover/tap tooltips with the exact date and GB;
  - range buttons: 7 days · 14 days · cycle · full history;
  - responsive for desktop and phone.
- **Usage summary:** total, average per calendar day and per active day, highest and lowest day, zero days, days with usage, trend.
- **Daily table:** date, GB, % of the daily allocation, status (Normal / High / No usage / No data).
- **Cycle picker:** every cycle that has Itemized data for the SIM.
- **Comparison:** per cycle — allocation, usage, usage %, average per day, highest day, zero days.
- **Activity:** last usage, days since last usage, current status.

Every chart follows the dashboard's existing data-visualisation rules: the validated provider colour, thin marks, tooltips, keyboard focus, a table view, and status colours only with an icon and a label.

## I. Performance

| Concern | Approach |
|---|---|
| Itemized size | stored at its natural grain (SIM × circle × day). Rough size: 1,000 SIMs × 365 days × 2 circles ≈ 0.7 M rows a year — normal for Postgres with the existing indexes |
| Browser load | the start-up load changes from "all cycles' monthly rows" to **the last 3 cycles + period totals** (the existing `provider_period_totals` view); older cycles load when picked |
| Pool and charts | daily totals from the `provider_daily_totals` view (aggregated in the database) |
| SIM page | one indexed query per SIM and range; never the whole table |
| Last usage / zero usage | the `provider_sim_last_use` view, one row per SIM |
| Paging | all list queries already page in 1,000-row blocks; SIM lists render in pages |
| Raw audit | `provider_sim_usage_daily` keeps every Itemized row; `upload_batches` keeps each file's hash, counts and errors |

## J. What exists vs what is new

| Requirement | Today | Plan |
|---|---|---|
| Daily per SIM from Itemized (§2–7) | stored; pop-up bar chart for the selected month; zero days shown | SIM page with area chart, statistics, table, provisional newest day |
| SIM detail page (§9, 38) | vehicle pop-up + VI details | dedicated SIM page from every SIM list |
| Usage summary and trend (§10) | — | new |
| Allocation vs actual (§11) | in the SIM-wise table | on the SIM page, labelled informational |
| Daily reference line, high days (§12, 41) | — | new |
| Forecast (§13–18) | projected %, run-out day | + days left, shortfall, gap, recent pace, burn-rate chart |
| Levels / configurable thresholds (§20) | a fixed critical alert | Healthy / Warning / Critical from `ops` config |
| Pop-up, banner (§21–22) | the strip shows the critical alert | pop-up once per alert + persistent banner |
| Recommendation, backup (§23–24) | text "add capacity" | dynamic text with the calculation |
| Risk card (§25), burn chart (§26) | — | new |
| No alert on spikes (§28) | whole-cycle pace already | + minimum days, recent pace → Warning only |
| Zero usage (§29–37) | idle count + cost | list, categories, last usage, days since start, action, cost |
| Cycle history for a SIM (§42–43) | — | cycle picker + comparison |
| Alert history, no spam, resolution (§49–51) | — | `provider_alerts` |
| Operations top block (§52) | pool strip | VI Operations block |
| Performance (§47–48) | on-demand daily loads | + views, 3-cycle start-up load |

## K. Decisions (6 Oct 2026)

1. **Alert thresholds:** Warning at projected ≥ **90%** (or the recent pace runs out before the cycle end); Critical when projected > 100% after at least **3** days of data, or remaining ≤ 0.
2. **Backup safety margin:** **10%**, rounded up to 10 GB. Today that is 556.21 → **620 GB**.
3. **Zero usage:** "newly activated" below **3** days since start; "long-term" at **30+** days without usage — "last one month, so I can stop this connection for next month".
4. **Alert reach:** in the dashboard only — banner, pop-up and history. Email or WhatsApp while the dashboard is closed would need a scheduled server job; that would be a separate step.

All four are in `providers.config.pool_rules.ops` (defaults in `js/providers/vi.js`, `DEFAULT_RULES.ops`).

## L. As built

| Part | Where | Notes |
|---|---|---|
| Forecast, levels, backup, recent pace | `vi.js` `computePool` → `pool.forecast`, `pool.level` | recent pace compares like with like (a Summary point for a Summary figure), so the load order cannot change it |
| Alert lifecycle | `vi.js` `evaluatePoolAlert`; `vi-ui.js` `syncOps` | one open alert per provider + code: open → update in place → escalate (Warning → Critical) → resolve with a reason; a new cycle resolves the old cycle's alert. Runs after every upload, recompute, rule change and start-up; only an Admin saves |
| Pop-up | `ui.js` `maybePopup` | once per alert per browser, for a new Critical or an escalation to Critical; refreshes with the newest figures while open; the banner stays until resolved |
| Pool snapshots | `vi.js` `poolSnapshotRow` / `addPoolSnapshot`; `cloud.js` `savePoolSnapshot` | burn-rate points between Itemized reports and the recent pace |
| Zero / high usage | `vi.js` `computePool` → `pool.zero`, `pool.high` | categories 3 / 30 days; advice only — nothing is closed or changed |
| SIM detail page | `ui.js` `openSim`; `vi-ui.js` `simModel`; `vi.js` `simDailyStats` | opens from the SIM-wise table, top consumers, zero / high lists and the vehicle pop-up ("📈 Daily history"). Total used = the newest report (as the pool); daily figures = Itemized only, and the page says when the Summary is newer. 7 / 14-day ranges may reach into the cycle before |
| Burn-rate chart | `ui.js` `burnChart` | pool line rises day by day as SIMs start |
| Database | `sql/003_vi_operations.sql` (+ rollback); `cloud.js` `loadOps`, `saveAlert`, `loadSimHistory` | without 003 the dashboard still works; alerts and history then last for the session only |
| "Today" | `vi.js` `localToday` | Asia/Kolkata |
| Tests | `tests/providers.test.html` | 233 checks, 41 of them for this work (forecast levels, spike rule, backup rounding, recent pace, alert lifecycle, zero / high usage, daily statistics, IST) |
| Phones | `index.html` CSS | no page-wide sideways scroll at 375 px on any tab; charts are drawn at the width they are shown |

**Not built:** the two database views of §G (not needed). The "last 3 cycles" start-up load of §I was built on 7 Oct with the rest of the scale work (§M).

**Verified** on the real files of 6 Oct against an independent Python calculation: pool, used, remaining, average, projection, exhaustion date, gap, shortfall, backup, recent pace, zero-usage counts per category, high-usage count, and one SIM's daily figures (Sep and Oct cycles). Airtel compared with `main` on the same data: unchanged apart from the known Plan-cell fix, the "No plan / not active" filter option, and the one vehicle whose SIM is a VI SIM moving to the VI view.

**Data note:** a Summary seems to include part of its export day. The 27 Sep Summary (last session 26 Sep) is 472 GB above the Itemized report to 26 Sep. The forecast takes the Summary as reaching its last-session day, so the average can be slightly high — the safe side for a run-out warning.

## M. Follow-up 7 Oct 2026: per-SIM pace, alerts that keep up, any fleet size

**Why.** The forecast already recalculated on every upload, but "average = used ÷ days elapsed" assumes the same SIM count all cycle. SIMs that go live mid-cycle add their pro-rated allocation at once but almost no usage yet, so the average lags. A test with 326 SIMs + 4,674 going live on day 15 showed Healthy (11%) and closed the open Critical alert; Critical came back only 2 days before the pool ran out. The fleet size is not fixed (fewer or many more than 5K), so nothing may depend on it.

**Decisions (account owner, 7 Oct 2026):**

1. The level, run-out day, shortfall and backup use the **per-SIM pace**; the requirement's cycle-average figures stay on screen for reference.
2. **Critical** from the projection needs **2 data days in a row** over the pool (after 3 days of data). Used up, or running out within 3 days, is Critical at once.
3. A Critical alert that gets **much worse** pops up again: run-out day 2+ days earlier, backup +50%, or the pool used up.
4. **No fixed fleet size**: uploads, start-up and lists must work for any number of SIMs.

**Model** (`vi.js` `simPace`, `liveIndex`, `pacePoints`; thresholds in `pool_rules.ops`):

| Item | Formula |
|---|---|
| SIM-days | each counting SIM is live from max(cycle start, its start); SIM-days = live SIMs summed over days |
| Pace per SIM a day | usage ÷ SIM-days over the newest window of ≥ 7 days (`recent_days`), from the pool's own report: Itemized days, or the change between uploads of the same report (Summary to Summary) **over the same SIMs** — each evaluation keeps which SIMs it counted that had started by its data day (`counted`: number + a hash of their ICCIDs); one made over other SIMs (a SIM left the pool, a status rule changed, an older SIM Group missed one) is left out |
| SIMs that do not count | Itemized: their own days are taken out of the account's daily totals (their daily figures load on demand, so every viewer gets the same pace); until they are here, each day is scaled by the pool's share of the cycle |
| Heavy day | the heaviest day **inside the window**, if ≥ 2× the median day (`spike_factor`): its excess is counted once (it is in used) but not carried forward — requirement §28. An upload covering several days can hide one: when its extra over the median, put on one of its days, makes that day ≥ 2×, it is treated the same way |
| Jump that lasts | the newest **2+ separate points**, covering ≥ 2 days (`sustain_days`), all ≥ 25% (`jump_pct`) above the window → that pace is used. One upload interval alone is never a jump |
| Projected | used + pace × SIM-days still to come for the SIMs counting now (SIMs starting later included from their start) |
| Run-out day | walk forward day by day: pace × SIMs live that day, until the remaining pool is gone |
| Shortfall, backup | max(0, projected − pool); backup = shortfall × 1.10 rounded up to 10 GB (exact multiples stay: 451,000 → 496,100) |
| Critical | used up · runs out within 3 days (`critical_lead_days`) · projected over the pool on this and the previous data day (after 3 days of data), and not only because of SIMs with no data yet |
| Warning | first data day over · over only because new SIMs with no data are counted at the fleet pace (the measured SIMs fit their own share) · ≥ 90% · the cycle average over the pool · a heavy day in the last 2 days that would push it over |
| Closed | the cycle ended (today past its last day) without its final report: no forecast, the alert resolves with that reason |

A steady fleet gives exactly the requirement's figure (average × cycle days); only a fleet that changes size gives a different one.

**Alerts:** one open alert, updated in place. It also keeps:
- **first**: the figures when it opened;
- **peak**: the worst so far;
- **announced** and **seq**: what the last pop-up said, and which pop-up that was;
- **prev**: the previous data day's figures, for the "Since data to 26 Sep: runs out 21 Oct → 19 Oct · backup 620 → 2,460 GB" line in the banner and pop-up.

Saving is compare-and-swap on `last_updated`: a tab with older data adopts the stored alert instead of overwriting it, and a resolved alert is never reopened. The banner shows the data's age, and "may already have run out" when the run-out day has passed without newer data.

**Any fleet size** (`sql/004_vi_scale.sql` + rollback, additive; without it the 001–003 paths are used):

| Part | How |
|---|---|
| RLS | the same rules, checked once per statement (`(select fn())`), not once per row |
| Itemized save | the cloud ends up with exactly the upload's days: days with the same total and SIM count are skipped, changed or missing days are sent (≤ 8,000 rows per call, each atomic), the last stored day is always re-sent, stored days the upload lacks are cleared |
| Monthly rows, SIM inventory | staged in ~1 MB chunks, swapped in one transaction (`commit_provider_period`, `commit_provider_sims`) |
| Half-finished save | the period row records the last Itemized day it committed; daily rows after it are ignored on load, and bare period rows are skipped |
| Start-up | newest 3 cycles first (older ones in the background); the SIM Group export list instead of every export; each pre-live SIM's state runs computed in the database (one JSON result); frozen pools without their SIM lists (loaded when the Month filter or the SIM page needs them); only the detected SIMs' daily rows |
| "As of" picker | per-SIM totals to the day computed in the database (one JSON result) |
| Freezes | wait for the daily figures their go-live days need (when the cloud can provide them) |
| Pool evaluations | `provider_pool_snapshots.counted` (new column): which SIMs each one counted. Without 004 a row is saved without it, and the pace checks its pool size instead (at least the SIMs started by its data day, at most all of today's) |
| Start-up failures | SIM Group history or earlier evaluations that fail to load (network, time-out — not a missing table) are tried 3 times. Still missing: a warning heads the pool alerts, the stored alert stays on screen, and nothing worked out from the incomplete figures is saved that session (evaluations, alert, frozen cycles). Older cycles: 3 tries in the background, then a warning |
| Lists | SIM-wise and zero-usage lists drawn 100 rows at a time; the CSV has every row |

**Rehearsal** (`/vi-scale.html?mockMem=1&n=…`): a synthetic fleet shaped like the real exports, run through the normal upload, save and load paths. In-memory mock, so the timings are browser-side only, not Supabase.

| SIMs | Counted / used | Rebuild | Data Pool tab | Start-up |
|---|---|---|---|---|
| 1,000 | exact | 34 ms | 151 ms | 9 reads |
| 5,000 | exact | 144 ms | 247 ms | 23 reads |
| 10,000 | exact | 297 ms | 274 ms | 40 reads |
| 20,000 | exact | 623 ms | 331 ms | 74 reads |

Every database call carries ≤ 8,000 rows (about 1 MB). A full 31-day Itemized upload at 20K SIMs is about 100 calls, once per cycle; a daily upload is a few calls.

Re-run at 5,000 SIMs after the review fixes: counted and used still exact, start-up 23 reads + 2 database functions, the stored `counted` of every evaluation equal to the SIMs worked out again. Rebuild 214–473 ms (median 285 ms) on a busier machine than the table above; the new checks add about 1 ms.

**Checked:**
- Unit tests: 291/291.
- Real files: identical figures in the session and after a reload, with and without 004 (pace 2.99 GB per SIM a day from the 27 Sep – 5 Oct uploads, 27,746.87 GB = 108.75%, runs out 19 Oct, backup 2,460 GB, zero usage 90, high usage 88).
- A corrected Itemized re-upload leaves the cloud and the browser day for day equal.
- The user's example: one 4,000 GB day moves the run-out day 19 → 13 Oct (pop-up again). A second such day switches to the jump pace: 4,000 GB a day, runs out 9 Oct.
- Start-up with the history function timing out (`?mockFail=provider_state_runs`): 3 tries, the warning heads the alerts, the stored Critical stays on screen, nothing written. Older cycles failing: 3 tries, then a warning; failing once: loaded on the second try.
- Airtel compared with `main` (19 outputs on the same data): unchanged apart from the known differences. The review fixes touch no Airtel code; the stat cards were compared again and are identical.
- An independent multi-agent review (forecast, save, load, SQL + UI) confirmed every finding it raised and listed some it had missed. All are fixed. The main ones:
  - an upload into a cycle still loading;
  - a corrected re-upload keeping old days;
  - a half-finished save showing newer days than its totals;
  - the "new SIMs" check;
  - spike and jump edge cases, including a heavy day hidden in a multi-day upload;
  - uploads evaluated over another set of SIMs feeding the pace;
  - SIMs that do not count inflating the Itemized pace;
  - pop-up keys;
  - stale-tab alert writes;
  - per-page re-runs of database functions;
  - a start-up whose history failed to load saving figures worked out without it.

**Known limit:** without `sql/003_vi_operations.sql` the evaluations are not stored, so the 2-day confirmation lasts for one browser session. The Uploads tab and the pool alerts say so. 003 is part of the go-live order.

**Still to verify on the real Supabase project:** statement times of the 004 functions at full size (the local mock has no time limits).
