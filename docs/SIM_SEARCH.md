# Universal SIM search — every provider, one search bar

Status: requested 8 Oct 2026, **live** since 13 Oct 2026 (`sql/005_sim_search.sql` run on the live Supabase project the same day).

## What it does

A search bar in the header, on every tab: **🔍 Search SIM number, ICCID or mobile…** (press `/` from anywhere).

1. The input is normalised: spaces, hyphens, `+`, `~`, apostrophes and trailing `F`/`U` padding are ignored. The stored numbers are never changed.
2. Every provider's SIM list is searched at once, whatever the provider filter shows. The filter is never changed by a search. When the SIM belongs to another provider, the result says so: "Dashboard filter: VI · this SIM belongs to Airtel — the filter is unchanged."
3. The provider comes from the record the SIM is found in (`provider_sims.provider` → `providers`), never from the number's prefix.
4. The status is exactly the provider's own word ("Ready", "Dunning", "Safe Custody", "active" …). VI's normalised status is shown beside it, never instead of it. A SIM whose provider gives no status says so; nothing is invented.
5. The provider's own details follow, from its module (`cfg.ui.searchCard`):
   * **VI:** activation date, plan, billing cycle, used this cycle, eligible and remaining allocation, and the shared pool's state. A Critical or Warning pool shows a pool-level note ("This is the shared pool, not this SIM's own data"). A SIM above its own allocation reads "covered by the shared pool, not out of data".
   * **Airtel:** this month's usage against the SIM's own plan, its data status, and the real-time portal figures.
6. **Open full details:**
   * VI opens the existing SIM page (daily chart, cycles, zero-usage days, last use, high days).
   * Airtel opens the existing vehicle analysis, even while the filter is on VI. An Airtel SIM that is on no vehicle has no Airtel page; the result says so.

**Match order:**

| Rank | Match |
|---|---|
| 1 | Exact SIM number / ICCID |
| 2 | Exact mobile number: all its digits (M2M numbers run to 13–15 digits), or the last 10 digits for a 10–13 digit input |
| 3 | Exact IMSI |
| 4 | SIM number starts with |
| 5 | SIM number contains |
| 6 | Mobile number or IMSI contains |
| 7 | Vehicle number or device ID: exact only, looked up in the fleet |

Rules applied to the results:
* At least 4 letters or digits are needed.
* One exact match opens its details at once. Several matches give a list, and the user picks.
* The same number listed by two providers shows both rows, each with its own status. Neither is picked automatically.
* Mobile numbers and IMSIs are only searched when the input is a number, so the digits inside "GJ01AB1234" are never read as a phone number.

**On screen:**
* While typing: suggestions showing SIM, provider badge, status badge and vehicle.
* Results: up to 50 SIMs, with "type more digits" when there are more.
* No match: "SIM not found", and no provider is guessed.
* Waiting: "Searching SIMs…" while the search runs; the dashboard stays usable.
* Recent searches: kept in this browser only.
* Phones: the bar takes a full-width row and results stack as cards, with no sideways scrolling.

## What the inspection found (before coding)

| | Airtel | VI |
|---|---|---|
| Where the SIMs are | No SIM table. JSON in `realtime_snapshots` (portal export), `monthly_snapshots` (monthly file), `vehicle_master` | `provider_sims`, one row per SIM, key `(provider, iccid)`; `provider` → `providers.code` |
| Complete SIM list | Real-time portal export: every SIM on the account, its plan and mobile number. Until now the mobile number was read but not kept. | Newest SIM Group file |
| Status | Only the monthly file's SIM STATUS column (Active, Available, Safe Custody, DISCONNECTED). The portal export has none; the dashboard showed "Active" for display. | `lifecycle_state` as VI writes it, plus a normalised `status` |
| Identifiers | SIM number = ICCID (19–20 digits). No IMSI. | ICCID, MSISDN, IMSI |
| Indexes | — | Primary key `(provider, iccid)`, `(provider, msisdn)`, `(provider, status)`; nothing for a search across providers |

The fleet (vehicle master) is shared by all providers and lists VI SIMs too. So "a SIM on a vehicle" does not mean "an Airtel SIM": Airtel claims only the SIMs its own reports list.

## Design

* **The common SIM table is `provider_sims`.** It is already provider-independent: `providers → provider → provider_sims`.
  * VI writes it with every SIM Group upload.
  * Airtel's SIMs are written there under `provider = 'airtel'` by an Admin's dashboard (`js/providers/search.js`, `syncDirectory`), from Airtel's own reports. The rules:
    * only after Airtel's start-up load has finished;
    * never from the page's built-in sample data;
    * never while an older real-time snapshot is on screen;
    * only when the list differs from what is stored;
    * never an empty list over a stored one.
  * For Airtel rows, the status is the monthly file's. A SIM listed only in the portal export has none.
* **`sql/005_sim_search.sql`** (run after 001, additive, re-runnable; rollback `005_sim_search_rollback.sql`):
  * Generated search keys `iccid_key`, `msisdn_key`, `imsi_key`, so the stored numbers stay as they are.
  * Indexes: exact SIM, mobile and IMSI; the last 10 mobile digits; and pg_trgm GIN indexes for any part of a number. If pg_trgm is missing, the partial search still works, scanning the table.
  * `search_sims(q, limit)`: one call returns at most 100 rows. It is `SECURITY INVOKER`, so the row-level security of `provider_sims` applies and a user finds only SIMs they may read. There is no separate search endpoint that bypasses it.
* **Browser fallback:** each provider module has a `directory()` hook listing the SIMs the dashboard has already loaded; nothing extra is downloaded. It is used:
  * when 005 is not run, and the result then says so;
  * for SIMs the database does not have yet (an upload not saved, a list not yet written by an Admin). These are added after the database results and marked "Found in the data loaded in this dashboard — not in the database SIM list yet".
* **Future providers:** a provider becomes searchable as soon as its SIMs are in `provider_sims`, or its module has a `directory()` hook.
  * Its name comes from `providers`.
  * Its own details appear if it adds `cfg.ui.searchCard`; otherwise the result says it has no detail view yet.
  * The search code names no provider.
* **Files:**
  * new: `js/providers/search.js` (engine, UI, Airtel sync), `sql/005_sim_search.sql` + rollback;
  * hooks: `registry.js` (Airtel `directory` / `directorySync` / `ui.searchCard`, `onDataChange`, `setReady`), `vi.js` (VI `directory`), `vi-ui.js` (VI `searchCard`), `cloud.js` (`searchSims`, `loadDirectory`);
  * `index.html`: the header slot, styles, the portal mobile number kept, `openVSum(reg, provider)`, and the start-up "Airtel loaded" signal.

## Not built / limits

* **Search audit log:** the dashboard has no audit log to add searches to, so none is written. Recent searches stay in the browser.
* **Vehicle number / device ID:** exact matches only, looked up in the fleet. These are not SIM fields.
* **Airtel SIMs before the first Admin visit:** they reach the database list once an Admin opens the dashboard after 005 is run, or uploads Airtel data. Until then a search still finds them in the browser data.
* **Real Postgres not yet tested:** `search_sims` and its indexes have only run against the local mock, because there is no PostgreSQL on this machine. Run its "Verify" queries on Supabase after applying it.

## Tests

* **Unit tests (`tests/providers.test.html`, 20 new, 311/311 in total):**
  * input normalising, and the number-only rule for mobile numbers and IMSIs;
  * Airtel claiming only its own SIMs, statuses as reported, none for portal-only SIMs;
  * when Airtel's SIMs may be written (not before its start-up load, not with an older snapshot on screen);
  * VI statuses kept ("Ready", "Dunning");
  * every match rank;
  * partial and contains matches, not found, too short;
  * vehicle lookup;
  * a new provider found with no change to the search;
  * the same number under two providers;
  * database-first merge, and the fallback without 005.
* **In the browser (mock database, real 6 Oct VI files plus Airtel data run through the real Airtel upload code):**

| # | Case | Result |
|---|---|---|
| 1 | Airtel SIM | Found · Airtel · "Active" / "Safe Custody" as Airtel's file says · vehicle, plan, monthly and portal usage |
| 2 | VI SIM | Found · VI · "Ready" · allocation, cycle, pool Critical note |
| 3 | Jio SIM added to the database only | Found · Jio, with no Jio code |
| 4 | Filter VI, Airtel SIM | Found, filter unchanged, note shown; vehicle analysis opens with Airtel's data |
| 5 | Filter Airtel, VI SIM | Found |
| 6 | Partial "8991" | List of 50, "type more digits" |
| 7 | Unknown number | "SIM not found" |
| 8 | Status | Exactly as stored ("Dunning", "active" + normalised "Active") |
| 9 | Same ICCID under two providers | Both listed, none opened |
| 10 | 20,000 SIMs | At most 50 rows reach the browser; mock timings: exact 28 ms, partial 68 ms. Postgres timings still to be measured on Supabase. |

Also checked:
* The VI pool figures are unchanged (25,514.17 GB, backup 2,460 GB).
* The Airtel view matches `main` apart from the documented VI-SIM vehicle move.
* Phone width (375 px): no sideways scroll.
