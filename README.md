# DOT Enricher — FMCSA Lead Desk

Two ways to work the same FMCSA data:

* **Preview Leads** — search by date range and lead filters, review the result, download it. No
  file upload, no contacts created.
* **CSV enrichment** — upload a CSV of USDOT numbers, get the same list back with carrier contact
  details and current insurance from **FMCSA**.

Built to deploy on Vercel as-is.

## Preview Leads

The default tab. Pick a lead category, a date range and a limit, and the app reads the matching
carriers straight from FMCSA's public open data.

### Separate Effective Date and Expiry Date ranges

Preview Leads provides two independent `From` / `To` date-range filters — **Effective Date** and **Expiry Date** — so you can filter by either range on its own or combine both to narrow smartly:

| Populated filter(s) | Insurance: **Yes** / **Any** | Insurance: **No** (New Authority Leads) |
|---|---|---|
| **Effective Date** (`From` / `To`) only | Matches policies whose `effective_date` falls inside the Effective range (active policies with no cancellation filed are included). | Matches carriers whose census registration (`ADD_DATE`) falls inside the Effective range. |
| **Expiry Date** (`From` / `To`) only | Matches policies whose cancellation / expiring date (`cancl_effective_date`) falls inside the Expiry range, regardless of when the policy started. | Matches currently uninsured carriers whose policy expired inside the Expiry range. |
| **Both Effective Date & Expiry Date** | Smart `AND` filter: the **same policy filing** must sit inside both the Effective range **and** the Expiry range (both date columns are highlighted). | Census registration (`ADD_DATE`) inside the Effective range **and** policy expiring date inside the Expiry range. |

Either side (`From` or `To`) of an active range may also be left open-ended (`from` only or `up to` only). Registering dates come from the Company Census File; policy and cancellation dates come from Motus Insur / InsHist. Nothing is inferred: a blank expiring date means no insurer has filed a cancellation.

### MOTUS / FMCSA request-rate pacing & incomplete-batch protection

MOTUS (`data.transportation.gov`) and FMCSA QCMobile (`mobile.fmcsa.dot.gov`, fronted by Akamai WAF) enforce request-rate controls that return **HTTP 403 Access Denied** or **HTTP 429** on concurrent bursts. To prevent silent lead drops:

* **Per-host request pacing & automatic 403 cooldown** (`lib/http.ts`) — outbound requests are spaced (`UPSTREAM_MIN_INTERVAL_MS`, default `120ms`) and any rate-control `403` / `429` triggers an exponential host-wide cooldown (`UPSTREAM_403_COOLDOWN_MS`, default `1500ms`) with bounded automatic retries.
* **Incomplete batches are never marked complete** — carriers whose MOTUS lookup could not be validated are held in `Waiting for MOTUS enrichment` (`lookup_failed` in Preview Leads, `Needs retry` in CSV Enrichment) with `meta.complete = false`, never misclassified as uninsured or marked `Complete`.
* **Duplicate protection** — repeated USDOT numbers and overlapping `Motus Insur` / `Motus InsHist` filings are deduplicated before lookup and ranking.

#### Where the leads went

A search can match 1,424 census registrations and return 68 leads. Extra cards sit directly under the
four summary cards, one per filtering step, showing the count removed and how many were left. Every
carrier that enters the search is walked stage by stage and, if it does not become a row, is counted
against exactly one reason — so the reasons always add up to `checked − returned`.

Cards with a red edge removed carriers; blue carried them forward unchanged; gold means they matched
but fell outside the row limit.

| Reason | Means |
| --- | --- |
| No insurance filing on file | FMCSA returns no filings for the carrier, so no policy date can match |
| Policy dates outside the range | Policies exist, but no effective or expiring date lands inside the dates |
| Cover lapsed — search asked for live | The matching policy was cancelled, and the search asks for live cover |
| Cover expired before the end date | Registration search: cover ended before the range's `To` date |
| Has live cover — search asked for uninsured | The carrier is insured, and the search asks for carriers without insurance |
| Held back by the limit | Matched, but fell outside the row limit |

If the numbers ever fail to reconcile the panel says so rather than reporting a wrong total; that is
a counting bug, not a filter. `lib/leads/funnel.ts` holds the arithmetic and is unit-tested.

**Clicking a step card opens the carriers behind it.** The list uses the same columns as the lead
table and exports with the same CSV builder, so the question "who did this rule remove?" is answered
in the fields you already know. The file is named after the reason
(`fmcsa-leads-no-filings-20261105-1830.csv`) so a rejected list cannot be mistaken for the lead list.

The count on a card is always exact. The list behind it is capped per reason to keep the response
small, and when it is cut short the panel says so — it never implies the list is complete when it
is not.

#### Filtering the table by column

Every column heading carries a small filter button, like a spreadsheet. It narrows **what is already
on screen** — no FMCSA round trip — so a filter applies instantly.

| Operator | Use |
| --- | --- |
| Contains / Is exactly / Is not | Text, case-insensitive |
| Is any of / Is none of | Tick values that actually exist in the column, with row counts |
| Is blank / Is not blank | Finds rows missing a phone, an MC, an expiring date |
| Is on or after / before / between | Dates, offered only on date columns |
| Is between | Ranges (coverage amounts compare numerically, not as text) |

Details that matter in use:

* An unfinished rule is **inert**. Typing one character into an empty operator never blanks the table —
  it would look identical to "there are no such carriers".
* The **Download CSV** button exports what the table is showing, not the full result, and the file is
  named `fmcsa-leads-filtered-…csv` so a narrowed export is recognisable.
* Applied filters appear as removable chips above the table, and the row count reads
  `12 of 1,432 rows` so a narrowed view is never mistaken for a small result set.
* Clearing a filter restores the rows; starting a new search clears every column filter.

These are display filters only. The report-level filters (states, cargo, insurance, authority) still
run server-side and change which carriers FMCSA returns at all.

#### Company rep, first and last name

FMCSA publishes exactly one person per carrier — `company_officer_1` on the census (MCS-150) record,
e.g. `KULWINDER SINGH`. There is no separate first/last field anywhere in the open data, so the
`First Name` / `Last Name` columns are split from that one string:

| Filed as | First Name | Last Name |
| --- | --- | --- |
| `KULWINDER SINGH` | Kulwinder | Singh |
| `TIMOTHY W REYNOLDS` | Timothy W | Reynolds |
| `PAUL PRITCHARD BRIGGS JR` | Paul Pritchard | Briggs JR |
| `JOSE DE LA CRUZ` | Jose | De La Cruz |

Middle names and initials stay with the first name, and particles (`De`, `Van`, `Del`) plus
generational suffixes (`JR`, `III`) stay with the last name. A single-word name goes entirely into
`First Name` rather than guessing a surname.

Known limitation: a compound Hispanic surname (`FLORES ALVARADO`) splits as `Flores` in the first
name and `Alvarado` in the last. Working out which of two words is paternal versus maternal from a
single string is not reliable, and guessing would silently mis-name a lead, so the rule stays
deterministic and the caveat is documented.

#### About a blank MC

`MC` is the `docket1` prefix + number. About **half** of newly registered carriers have no docket at
all yet — authority pending, or a USDOT-only operation — so the column is legitimately blank for
them. Measured on the census: 11,477 of 22,934 carriers registered 2025-11-01 → 2026-01-01 have
`docket1` null. Those rows carry a note saying so rather than showing an empty cell with no
explanation.

#### The dates shown are the dates that matched

A carrier can have a dozen filings across many years, so a search has one rule: **the filing
displayed in `Carrier 1` / `Policy Number 1` / `Effective Date 1` / `Expiring Date 1` is the filing
that put the row in the result.** The matching cell is tinted in the table and spelled out in the
row detail ("Matched on").

* A policy qualifies when its **effective date** is inside the range, or its **expiring date** is.
* When several qualify, the **earliest** wins — the range is the selection criterion, so a Nov 2025
  start shows the 2025 policy even if the carrier also renewed in 2026.
* Rows are ordered by that same matching date, oldest first, so the list begins at `From` rather
  than wherever the newest registration happens to sit.
* Only a registration search (**Insurance: No**) may fall back to the carrier's current filing,
  and then the row says so in Notes. A policy search never shows an out-of-range date.

### Filters

* **Include States** — the state search. One code (`TX`), several (`TX, OK, NM`) or full names
  (`Texas; New Mexico`). Blank means every state. Unknown values are listed as ignored, and a state
  box with nothing usable in it returns an error instead of quietly searching all 50 states.
* **Excluded States** — the opposite list (`AK, CA, HI, NY, UT` by default).
* **Freight motor carrier only** — census operating class contains `AUTHORIZED FOR HIRE`.
* **Private** — exclude, include, or private-fleets-only.
* **Require truck tractor** — at least one owned or term-leased tractor on the census record.
* **Operation / For Hire / Authority Status** — interstate (code `A`) vs intrastate (`B`/`C`) and
  active / pending / inactive authority.
* **Insurance** — answered from FMCSA filing dates: `Yes` means cover is live today, `No` means no
  live filing on record.
* **Excluded Cargo Types** — the 30 MCS-150 cargo boxes, stored one `crgo_*` column each.
* **Excluded Authority Keywords** — case-insensitive phrases kept out of the legal and DBA names.
* **Include rejected** — keeps records whose census status is inactive or whose docket is revoked.

**Save** stores the profile in this browser and uses it for every later preview; **Reset** returns to
the shipped new-authority profile.

### Columns (and where they come from)

| Export column | FMCSA field | Dataset |
|---|---|---|
| **DOT** | `dot_number` | census |
| **MC** | `docket1prefix` + `docket1` | census |
| **Business Name** | `legal_name` | census |
| **State** | `phy_state` | census |
| **Phone Number** | `phone` | census |
| **Email** | `email_address` | census |
| **Street address** | `carrier_mailing_street`, falling back to `phy_street` | census |
| **City** | `carrier_mailing_city`, falling back to `phy_city` | census |
| **Postal Code** | `carrier_mailing_zip`, falling back to `phy_zip` | census |
| **Carrier 1** | `insurance_company_name` of the best filing | Motus Insur / InsHist |
| **Policy Number 1** | `policy_no` | Motus Insur / InsHist |
| **Effective Date 1** | `effective_date` | Motus Insur / InsHist |
| **Expiring Date 1** | `cancl_effective_date` (InsHist only) | Motus InsHist |
| **Active** | `docket1_status_code`, falling back to census `status_code` | census |
| **Interstate or Intrastate** | `carrier_operation` (`A` → Interstate, `B`/`C` → Intrastate) | census |
| **Commodities** | the `crgo_*` flags answered `X`, in MCS-150 order | census |
| **Truck Trailers** | tractors (`owntract` + `trmtract`), trailers (`owntrail` + `trmtrail`) and straight trucks (`truck_units`) | census |

Supporting columns follow one blank column (DBA, physical address, mailing state, coverage, policy
type, live-cover flag, operating class, power units, census added date, MCS-150 date, sources,
notes).

### Which policy becomes "Carrier 1"

1. a filing that is live today beats one whose cancellation date has passed;
2. then the most recent effective date.

If the only filing on record carries a cancellation date, it is still shown — with a note saying
cover has lapsed — because knowing the insurer and the end date is what a lead list is for.


| # | Column | Where it comes from |
|---|--------|---------------------|
| 1 | **DOT Number** | your file (normalised, leading zeros removed) |
| 2 | **Contact name** | QCMobile `companyOfficer1`, falling back to the census officer, then the legal name |
| 3 | **Business name** | QCMobile `legalName`, falling back to the census legal name |
| 4 | **Phone** | QCMobile `telephone`, falling back to the census `phone` |
| 5 | **Email** | QCMobile `emailAddress`, falling back to census `email_address` |
| 6 | **Created (EDT)** | census `add_date` (registration date), rendered in `America/New_York` with the explicit UTC offset |
| 7 | **Policy Number** | Motus Insur `policy_no` (the best-ranked active policy) |
| 8 | **Effective Date** | Motus Insur `effective_date` |
| 9 | **Expiration Date** | Motus InsHist `cancl_effective_date` — only when the insurer filed a cancellation |
| 10 | **Enrichment Status** | computed: `Enriched` / `Partial` / `Not found at FMCSA` / `Invalid DOT number` / `Needs retry` |

Supporting columns (DBA, E.164 phone, insurer, coverage, USDOT status, MCS-150 date, address,
power units, data sources, missing fields, notes) follow after one blank column, so they can be
deleted in a single drag without disturbing the ten required ones.

## Deploy to Vercel

```bash
npm i -g vercel
vercel link
vercel env add FMCSA_WEB_KEY production    # paste your FMCSA QCMobile webKey
vercel --prod
```

Or connect the repository in the Vercel dashboard — the defaults are detected automatically
(Framework: Next.js, no build settings to change).

### Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `FMCSA_WEB_KEY` | **yes** | FMCSA QCMobile webKey. Also accepted: `FMCSA_WEBKEY`, `FMCSA_API_KEY`, `FMCSA_KEY`, `QCMOBILE_WEB_KEY`, `WEBKEY`. |
| `SOCRATA_APP_TOKEN` | no | Raises the data.transportation.gov rate limit. Also accepted: `MOTUS_APP_TOKEN`, `FMCSA_APP_TOKEN`. |
| `MAX_ROWS_PER_FILE` | no | Rows accepted per run (default `5000`). |
| `MAX_FILE_BYTES` | no | Upload size limit (default `2097152` = 2 MB). |
| `ENRICH_CONCURRENCY` | no | Parallel DOT lookups per request (default `8`). |
| `MOCK_FMCSA` | no | `1` generates local demo records instead of calling FMCSA. Never set this in production. |

Get the webKey free: sign in at <https://mobile.fmcsa.dot.gov> with Login.gov → *My WebKeys* →
request a key. Vercel redeploys are required after adding a variable.

Open **`/api/status`** after deploying. It reports which environment variable was found, the last
four characters of the key (never the key itself) and, with `?probe=1`, one live call to each
provider.

## How the lookups work

```
CSV ──► browser (DOT column only) ──► POST /api/enrich ──► ┬─ FMCSA QCMobile   /carriers/{dot}
                                                          ├─ Census File       az4n-8mr2
                                                          └─ Motus Insur/Hist  c5y8-a4uz, 3uet-3z4i
                                                                    │
                                              merged, ranked  ◄──────┘
                                                                    │
                                          NDJSON progress ──► results table ──► enriched CSV
```

* **QCMobile** (<https://mobile.fmcsa.dot.gov/qc/services>) — needs the webKey. Freshest registration
  record: legal/DBA name, phone, email, officer, added date, MCS-150 date.
* **Motor Carrier Census File** (`az4n-8mr2`) — public DOT data, no key. The only FMCSA file that
  carries an email address and the registration date for every carrier.
* **Motus Insur / InsHist** (`c5y8-a4uz`, `3uet-3z4i`) — public DOT data, no key. Policy number,
  insurer, coverage and effective date; InsHist adds the cancellation date that becomes the
  Expiration Date column.

FMCSA's QCMobile API does **not** expose insurance. Policy data therefore comes from the Motus
Licensing & Insurance datasets, which are the same records FMCSA shows in Motus and which replaced
the L&I site in 2026. Everything in the export is published FMCSA data — nothing is scraped from
HTML and nothing is estimated.

## Sorting the results table

Every column heading is a button. Click cycles **ascending → descending → back to upload order**, with
the active column marked by a gold arrow and `aria-sort` set for screen readers.

Two rules that matter for this kind of list:

* **Blanks always sink to the bottom**, in both directions. Sorting by Policy Number puts the carriers
  that actually have a policy on top instead of burying 300 real rows under empty ones.
* **Values sort by meaning, not text.** DOT numbers compare numerically (999 before 1000), dates compare
  chronologically regardless of the timezone suffix, and Enrichment Status sorts worst-first
  (invalid → not found → needs retry → partial → enriched) rather than alphabetically.

Use the **No policy** filter to isolate carriers with no insurance filing, and **More columns** to sort
by insurer, coverage, USDOT status or fleet size.

### Which policy wins

When a carrier has several filings, the export shows one policy in the required columns:

1. active before terminated (a filed cancellation date in the past = terminated);
2. BIPD before cargo / surety / trust (the liability policy that factoring and insurance teams ask for);
3. larger coverage first;
4. most recent effective date first.

Every filing, with its form code and source dataset, is listed in the row detail panel and in the
`Policies on file` supporting column.

### Missing data is reported, not invented

* Email fields that hold a bare domain (FMCSA really does contain values like `EARTHNWOOD.COM`) are
  left blank, flagged `needs correction` and explained in Notes. The app never guesses `info@…`.
* Expiration Date is only filled when FMCSA publishes a cancellation date. It is never derived from
  the effective date.
* Unmatched, invalid and failed DOT numbers stay in the file with an Enrichment Status so the row
  count always matches the upload.

## When a whole upload fails

A 315-row run where every row fails is an infrastructure problem, not 315 bad records. Rather than
printing the same "lookup failed" note on every row, the app diagnoses the run and names the cause:

| Diagnosis | Usual fix |
|---|---|
| No API key on the server | Add `FMCSA_WEB_KEY` in Vercel, then **redeploy** — env vars do not apply to existing deployments |
| FMCSA rejected the key (401/403) | Confirm the key is active on mobile.fmcsa.dot.gov and matches the deployed value |
| Rate limited (429) | Lower `ENRICH_CONCURRENCY` to 3–4 |
| Could not reach FMCSA (timeout / connection reset) | Outbound HTTPS to `mobile.fmcsa.dot.gov` is blocked from the function |
| FMCSA returned 5xx | FMCSA-side outage; retry later |
| Carriers found, no insurance published | Nothing to fix — FMCSA only lists coverages an insurer has filed |

Nothing in the diagnosis blames your file when the cause is upstream. `GET /api/status?probe=1` returns
the same diagnosis plus the env var name and last four characters of the key.

## Local development

```bash
npm install
npm test            # 168 unit tests: parsing, dates, policy ranking, name splitting, CSV, sorting, filters, column filters, date window, funnel, rejected lists, diagnosis
MOCK_FMCSA=1 npm run dev   # demo data, no key needed
# or, against the live API:
FMCSA_WEB_KEY=your-key npm run dev
```

Other scripts: `npm run typecheck`, `npm run build`.

## API

```bash
# Single-shot JSON
curl -X POST http://localhost:3000/api/enrich \
  -H 'Content-Type: application/json' \
  -d '{"dots":["1515240","12873"]}'

# Or send a raw CSV and let the server find the DOT column
curl -X POST http://localhost:3000/api/enrich \
  -H 'Content-Type: application/json' \
  -d '{"csv":"DOT,Company\n1515240,Acme\n"}'

# Streaming progress (newline-delimited JSON)
curl -N -X POST http://localhost:3000/api/enrich \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"dots":["1515240"]}'
```

`GET /api/status` returns configuration; `GET /api/status?probe=1` also tests both providers.

## Limits and privacy

* 5,000 rows / 2 MB per file by default; duplicates are looked up once.
* Serverless functions end at 60 s on Vercel Hobby. ~500 DOTs per run is comfortable; lower
  `ENRICH_CONCURRENCY` if you see 429s, raise it on Pro.
* Only DOT numbers leave the browser. The webKey is read server-side and never appears in a
  response, a log line or the client bundle. No carrier list is stored anywhere by this app.

## Project layout

```
app/
  page.tsx              server-rendered shell (shows a missing key before any run)
  api/leads/route.ts    POST — lead preview (filters + date range)
  api/enrich/route.ts   POST — JSON or NDJSON streaming, parses CSV server-side too
  api/status/route.ts   GET — configuration + optional live probe
  globals.css           design tokens and layout
components/
  Enricher.tsx          app shell: tabs, upload, run, progress, results, connection panel
  previewLeads.tsx      date range, lead filters, lead table, CSV download
  fileDrop.tsx resultsTable.tsx rowDetail.tsx icons.tsx
lib/
  enrich.ts             merge pipeline and per-row status
  providers/fmcsa.ts    QCMobile client
  providers/motus.ts    census + Motus insurance client
  normalize.ts          DOT/date/phone/email/policy rules
  csv.ts export.ts      CSV read/write
  mock.ts               deterministic demo data
lib/leads/
  window.ts             which filing matched the date range, and row ordering
  funnel.ts             stage-by-stage accounting of where carriers were filtered out
  filters.ts            filter model, lead categories, SoQL predicates
  cargo.ts              MCS-150 cargo columns + equipment summary
  states.ts             state parsing and validation
  search.ts             census + insurance join, row mapping, demo data
  export.ts             the 17 requested lead columns
lib/sortRows.ts         column sorting (blanks last, numeric/date-aware)
lib/diagnoseRun.ts      run-level failure diagnosis
tests/                  168 vitest cases
```

## Lead search API

```bash
curl -X POST http://localhost:3000/api/leads \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "2025-11-01",
    "to": "2026-11-01",
    "limit": 250,
    "includeRejected": false,
    "filters": { "states": ["TX"], "insurance": "no", "authorityStatus": "active" }
  }'
```

`limit: 0` means "no limit", capped at 2,000. A state code that is not a US state returns `422`
instead of being dropped.

Data source: U.S. Department of Transportation / FMCSA public data. This app is not affiliated with
or endorsed by FMCSA.
