# Daily Reports — Design

**Status:** Approved by Nathan 2026-08-26 (design presented in chat; "looks great, write it up and implement it").
**Pattern:** New project vertical cloned from the RFI/Issues pattern (own table + store + routes + tab + letterhead PDF + email send).

## 1. Purpose & decisions

A "Daily Reports" tab on every project where field users file one report per work day: crew counts, weather, notes, issues, photos — printable/emailable on the company letterhead.

| Decision | Choice |
|---|---|
| Reports per date | **One per project per calendar date.** The date is the identity. Creating on a taken date opens the existing report; changing the date in the form moves the report and is blocked (client-side message) if the target date is taken. |
| Header | The branded document letterhead (logo/company block, same as invoices/RFIs/proposals). Job name / Contractor / Date are the first **fields of the document body**, not part of the letterhead. |
| Prefills | Job name ← project name; Contractor ← `project.contractor` (fallback: company name from settings); Date ← today. All three editable; stored on the report as text so old PDFs stay stable. |
| Weather | **Auto-fetch actual observed hourly weather** for the report date from the project's saved `address` (editable afterward). No address → manual entry only. |
| Sending | Email + PDF via the shared email composer (per-user SMTP), like Issues/RFIs. Download/print always available. |
| Access | All authenticated users (same visibility as Issues/RFI/Punch — not admin-gated). |
| Lifecycle | None. A daily is a plain record — no draft/sent/status machine. |

## 2. Data model — migration 27 (ADDITIVE)

```sql
CREATE TABLE IF NOT EXISTS daily_reports (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  reportDate TEXT NOT NULL,          -- 'YYYY-MM-DD' (project-local calendar date)
  jobName TEXT NOT NULL DEFAULT '',
  contractorName TEXT NOT NULL DEFAULT '',
  weatherSummary TEXT NOT NULL DEFAULT '',   -- e.g. "Partly cloudy"
  temperature TEXT NOT NULL DEFAULT '',      -- e.g. "58–74°F" (free text)
  weatherHourly TEXT NOT NULL DEFAULT '[]',  -- JSON [{hour:"6 AM",tempF:71,condition:"Clear"}]
  manCounts TEXT NOT NULL DEFAULT '[]',      -- JSON [{type:"Plasterer",count:4}]
  fieldNotes TEXT NOT NULL DEFAULT '',
  issues TEXT NOT NULL DEFAULT '',
  createdBy TEXT,                            -- username
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(projectId, reportDate)
);
CREATE INDEX IF NOT EXISTS idx_daily_reports_project ON daily_reports(projectId);
CREATE TABLE daily_report_photos (           -- join table, same shape as rfi_photos/issue_photos
  id TEXT PRIMARY KEY,
  dailyReportId TEXT NOT NULL,
  fileId TEXT NOT NULL,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);
```

No existing tables touched. Photo bytes live in the existing file store (same as RFI/Issue photos); `daily_report_photos` must also be added to the hardcoded photo-purge table list in `server/routes.ts` (the `['issue_photos','punch_photos',…]` array) or bulk cleanup silently misses it.

## 3. Server

**`server/dailyReportStore.ts`** — CRUD mirroring `rfiStore.ts`: `listDailyReports(db, projectId)` (summaries, date desc), `getDailyReport(db, id)`, `createDailyReport`, `updateDailyReport` (optimistic version check → conflict error), `deleteDailyReport`. Unique-date violations surface as a typed error carrying the existing report's id.

**Routes** (in `server/routes.ts`, RFI-style, `authenticateToken`):
- `GET /api/projects/:pid/daily-reports` — list summaries
- `GET /api/daily-reports/:id` — full report
- `POST /api/projects/:pid/daily-reports` — create; on duplicate date → `409 { error: 'date_taken', existingId }`
- `PUT /api/daily-reports/:id` — update; stale version → 409
- `DELETE /api/daily-reports/:id`
- `GET /api/projects/:pid/daily-weather?date=YYYY-MM-DD` — weather fetch (below)
- Email send route added beside the existing issue/RFI send routes (`registerEmailRoutes` pattern): accepts the client-generated PDF + recipients/cc/bcc/subject/body, sends via the requesting user's SMTP.

All mutations publish on the realtime change feed (`entity-changed`, kind `dailyReport`, identity+version only) per the WS2 rule: never attach a version the mutation didn't bump.

**Weather fetch** (server-side, so LAN clients need no internet):
1. Geocode `project.address` via OSM Nominatim (`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=…`, proper `User-Agent` header per usage policy). Cache lat/lon in-memory keyed by address string.
2. Hourly observed data from Open-Meteo (free, no key), `temperature_unit=fahrenheit&timezone=auto`, hourly `temperature_2m,weathercode`:
   - date within the last 7 days → forecast API with `past_days` (serves recent actuals),
   - older → archive API (`archive-api.open-meteo.com/v1/archive`).
3. Response: `{ hourly: [{hour, tempF, condition}], summary, temperature }` for work hours **6 AM–6 PM**; `condition` from a WMO weather-code → text map; `summary` = dominant condition; `temperature` = min–max range string.
4. No address → `400 { error: 'no_address' }`; upstream failure → `502 { error: 'weather_unavailable' }` (client falls back to manual entry, non-fatal).

Nothing is fetched automatically on a schedule — only when the user opens/refreshes the weather block; the result is stored on the report.

## 4. Client

**Tab:** "Daily Reports" added to the project section nav (same placement/visibility rules as Issues/RFI/Punch; not admin-gated). Route `/project/:id/daily-reports`. `locationInfo` gets a readable label for presence ("Daily Reports · <project>"). ⌘K palette gains a project-context "New daily report" action.

**`src/pages/project/ProjectDailyReports.tsx`** — list page: one row per date (date, man-count total, weather summary snippet, photo count), newest first, live-refreshing via `useLiveQuery`. "New report" defaults to today; if today exists it opens that report.

**`src/pages/project/daily/DailyReportEditor.tsx`** — an editor modal opened from the list (RFI pattern: rendered conditionally, keyed `${id}:${version}` so version bumps remount cleanly). Form top-to-bottom per Nathan's five sections:
1. Prefilled fields: Job name, Contractor, Date (date input; uniqueness conflict shows an inline message and blocks save).
2. Weather block: when the project has an address, fetch on first open of a new report (and via a Refresh button) → compact hourly strip (6 AM–6 PM) + editable Summary and Temperature fields. Without an address: the two editable fields only.
3. Man count: dynamic rows (`type` text + `count` number), add/remove, only entered rows exist; computed "Total: N men" line. Rendered side-by-side with…
4. Field notes: free text area (side-by-side on desktop, stacked on mobile).
5. Issues: full-width text area below.
Plus: photo attachments using the RFI pattern (immediate upload on file-input change, save-first guard, camera capture on mobile, thumbnail grid with delete); Save (explicit, versioned, 409 soft-handled); edit-presence banner + editing chip (`useCollabEditing`); PDF download; Email send card via the shared `EmailComposer`.

## 5. PDF — `src/pages/project/daily/dailyReportPdf.ts`

Letter size, shared branded letterhead/footer (`documentLetterhead` module, brand color, logo rules — identical to Issue/RFI PDFs). Title block: "DAILY REPORT" + report date.

Page 1 layout (all five sections fit when content is modest):
1. Fields block: Job name / Contractor / Date.
2. Weather: summary + temperature line, then the hourly strip as a compact one-row table (hours across, temp + condition under each).
3. Two columns: Man count (typed lines + total) | Field notes.
4. Issues section below.

**Overflow rule:** any section whose content exceeds its remaining page-1 space renders what fits, then continues on a following page under a "<Section> (continued)" heading — nothing is truncated. Photos append after all text pages, captioned grid like Issue PDFs. Filename `DailyReport-<project>-<date>.pdf`.

Generated/sent PDFs register in unified Documents under canonical type **"Daily Report"** with upsert-by-source versioning (source link to the report), same as other generated docs.

## 6. Testing

- `dailyReportStore.test.ts`: CRUD, unique-date conflict (with existing id), version conflict, list ordering.
- Route tests in the existing routes test style: endpoints incl. 409 shapes; weather endpoint with mocked `fetch` (geocode + both Open-Meteo paths + no-address + upstream-failure).
- `dailyReportPdf.test.ts`: per repo convention (rfiPdf.test.ts tests only exported pure helpers, never jsPDF) — test the exported heading/formatting/layout-math helpers; no jsPDF mocking.
- Editor/list tests: exported pure helpers (man-count total, date formatting/conflict predicate, weather summary derivation) — the repo's list/editor tests are pure-helper tests, not RTL renders.
- Migration 27 covered by the migration list test conventions.

## 7. Non-goals (v1)

- No report lifecycle/approval flow, no signatures.
- No scheduled/automatic weather capture — fetch happens on user action only.
- No per-cell collaborative editing of the form (standard WS2 edit-awareness banner is enough).
- No backfill of historical weather for existing projects.
