# Daily Report Start Time — Design

Date: 2026-10-06
Status: Approved by Nathan (conversation)

## Problem

"Add start time to daily reports and adjust weather to match start time." A
daily report (spec 2026-08-26-daily-reports-design.md) has a date but no time,
and its weather is always a fixed 6 AM–6 PM window — wrong for a crew that
starts at 7, or works nights.

## Decisions (agreed with Nathan)

- **Each daily report gets a start time.**
- **Weather window:** the start time through start time + 12 hours — the same
  inclusive shape as today's 6 AM–6 PM (13 hourly readings, the start hour
  through start hour + 12). A window that runs past midnight takes the next
  day's early hours (two days are fetched).
- **New report's start time:** copied from the previous report's on the
  project; none earlier (or it has no start time) → 6:00 AM, which reproduces
  today's 6 AM–6 PM window exactly. A later feature will make this per crew, so
  the "previous report's start time" rule lives in one small function.
- **Changing the start time on a report that already has weather asks**
  "Update the weather to match the new start time?" — yes refetches for the new
  window, no keeps the stored weather.
- **Where it shows:** the report form, the generated PDF, and wherever a
  report's key facts are summarised if it fits naturally.
- **Implementer's calls (from existing behaviour):**
  - *Previous report:* the latest report dated before the new one that has a
    start time (reports from before this change, with none, are skipped). A
    day filled in before the project's first report has no earlier one, so it
    takes the latest-dated report that has a start time — the crew's current
    habit — rather than 6 AM. Else 6 AM. Only a create with no start time is
    filled; an explicit one wins.
  - *Minutes:* the window starts at the start time's hour, minutes dropped
    (7:30 → 7 AM–7 PM). Changing the start within the same hour therefore
    doesn't ask about the weather — it would fetch the same hours.
  - *Next-day hours* are labelled "+1" ("12 AM +1" … "6 AM +1"), short enough
    for the PDF's hourly strip, so the window never shows two "6 AM"s.
  - *Archive or forecast host:* picked by the newest day the window touches —
    the archive lags real time, so a window ending within the last week uses
    the forecast host, which serves the recent past too.
  - *Existing reports* keep NULL: their stored weather is untouched and was
    fetched for 6 AM–6 PM, which is also what a report without a start time
    fetches. Their PDF prints as before (no Start time row), and the list shows
    a dash. Clearing the field saves NULL again.
  - *When the question is asked:* when the start time field is left, not on
    every change (a time input changes on each keystroke). It is asked once per
    change; with no weather on the report nothing is asked (Fetch weather uses
    the field's start time). A new report's automatic fetch still in flight is
    simply redone for the new start, and only the latest fetch lands.
  - *Display:* "7:00 AM". Shown in the editor (next to the date), the PDF's
    header fields ("Start time:" under "Date:"), a Start column in the list
    view and "· started 7:00 AM" on the dashboard's Latest daily report card.
    The calendar's day cells are left as they are (no room).

## Design

**Migration 44 (`daily-report-start-time`, additive, idempotent):**
`ALTER TABLE daily_reports ADD COLUMN startTime TEXT` — 'HH:MM', 24-hour,
nullable. Same guarded pattern as migrations 24 and 33.

**Server:**

- `weather.ts`: `DEFAULT_START_TIME = '06:00'`, `WINDOW_HOURS = 12`,
  `isStartTime` (HH:MM, 00:00–23:59). `fetchDailyWeather(lat, lon, date,
  startTime = '06:00')`: window = start hour .. start hour + 12; `end_date` is
  the next day only when the window passes 11 PM; each reading is placed by
  its own date and hour, so the next day's hours count from 24. `summarize()`
  runs over the window, as before.
- `dailyReportStore.ts`: `startTime` on create/save (`undefined` keeps it,
  `null` clears it, anything but HH:MM → `ValidationError` → 400); get/list
  carry it. `previousStartTime(db, projectId, reportDate)` is the one-query
  default rule above.
- `GET /api/projects/:id/daily-weather?date=YYYY-MM-DD&start=HH:MM`: `start`
  defaults to 06:00; a malformed one → `400 { error: 'bad_start' }` (checked
  after the date, before the address).

**Client:**

- `store.ts`: `startTime: string | null` on `DailyReport` and
  `DailyReportListItem`; `getDailyWeather(projectId, date, startTime?)` adds
  `&start=` when given.
- `dailyReportForm.ts`: `formatStartTime` ("7:00 AM"; blank for none) and
  `weatherStartHour` (the hour the window starts; 6 without a start time).
- `DailyReportEditor`: a Start time `type="time"` field after Date (header
  grid now 2 columns on small screens, 4 from md); saved with the report and
  part of the dirty check. The new-report auto-fetch, Fetch and Refresh use
  the field's start time. Leaving the field after a change of hour on a report
  with weather asks through the app's confirm dialog ("Update the weather?",
  Update weather / Keep current).
- `dailyReportPdf.ts`: `dailyReportFieldRows` adds "Start time:" when the
  report has one.
- `ProjectDailyReports` list: a Start column. `pj-daily-latest` card:
  "N on site · started 7:00 AM".

## Tests

- `server/weather.test.ts`: `isStartTime`; the default start equals the old
  window (13 rows, one day requested, same summary); a 7:30 start covers
  7 AM–7 PM and summarizes only that; an 11 AM start stays on one day; an
  evening start requests two days and labels next-day hours "+1"; midnight
  start; month/year end; host choice by the window's newer day (Date faked).
- `server/dailyReportStore.test.ts`: round-trip through create/get/list/save
  (omitted keeps, null clears); validation on create and save; 6 AM default
  (no earlier report, only legacy ones); copies the latest earlier report,
  skipping legacy ones, ignoring later ones and other projects; an explicit
  start wins; a day before the first report copies the latest-dated one.
- `server/routes.dailyReports.test.ts`: `bad_start`; weather without a start
  (6 AM–6 PM, one day) and with an evening start (two days, "+1"), upstream
  mocked; POST fills the default/copy, GET and the list carry it; POST/PUT 400
  on a malformed start.
- `server/migrationList.test.ts`: migration 44 adds the column to a v43
  database, existing rows NULL with weather untouched, replay is a no-op.
- Client: `dailyReportForm.test.ts` (`formatStartTime`, `weatherStartHour`);
  `dailyReportPdf.test.ts` (`dailyReportFieldRows` with and without);
  `DailyReportEditor.test.tsx` (field + save, legacy null, auto-fetch with the
  start, Refresh uses the field, ask → refetch, no → keep and don't re-ask,
  same hour / no weather don't ask, in-flight fetch superseded);
  `ProjectDailyReports.test.tsx` (Start column); `libraryCards.test.tsx`
  (card line).
