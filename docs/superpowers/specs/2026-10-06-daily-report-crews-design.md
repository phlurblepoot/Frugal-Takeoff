# Daily Report Crews — Design

Date: 2026-10-06
Status: Approved by Nathan (conversation)

## Problem

"Upgrade Daily reports to allow multiple crews (perhaps adding crew tabs on the
daily report page)." A daily report (spec 2026-08-26-daily-reports-design.md)
is one per project per date, so two crews on site the same day — the company's
own and a sub's, or a day and a night crew — can't each file theirs.

## Decisions (agreed with Nathan)

- **A crew is a named tab** on the project's Daily Reports page — the company's
  own crew or a subcontractor, it's just a name. "The user would just click to
  add a new crew, creating a new tab with its own daily report calendar. The
  crews should be able to be named."
- **A crew is its own full set of daily reports** with its own calendar: "1 per
  day per crew". Every field (date, start time, weather, man counts, notes,
  issues, photos, PDF attachments) is per report, so per crew.
- **Crews are per project.** Names are typed when the crew is added (no saved
  company list, no suggestions); a crew can be renamed.
- **Existing reports move into a default crew "Crew 1"** (renamable).
- **A crew can be deleted only if it has no reports**; one with reports can be
  renamed, not deleted.
- **"All crews"**: a combined calendar that is simply for viewing — every
  crew's reports on one calendar, no creating reports from it; opening an
  existing report to look at it is fine.
- **A new report's start time** is copied from that crew's last report.
- **Anywhere a report is named by its date, the crew name goes with it.**
- **Implementer's calls (from existing behaviour):**
  - *A project with no crew yet* (new, or no reports when migration 45 ran):
    listing its crews makes "Crew 1". The insert is one
    `INSERT … WHERE NOT EXISTS` statement, so two pages opening at once can't
    make two. Creating a report then always names its crew (`crewId` required).
  - *The last crew can't be deleted* either — the page always keeps a tab, and
    deleting the only crew would only have it come back as "Crew 1".
  - *Names:* trimmed, required, at most 80 characters, unique within the
    project ignoring case (a crew may change the case of its own name).
  - *Tab order:* by creation (new crews go at the end); "All crews" comes last.
    No reordering. A report can't be moved to another crew.
  - *The open tab is in the URL* (`?crew=<id>`, `?crew=all`); none, or a crew
    that is gone, opens the first crew.
  - *All crews* opens a report in place (the tab stays on All crews) and has a
    list view too, with a Crew column; neither offers create or delete. On a
    phone a day's entries show the crew name only (the man count joins it from
    `sm` up), matching the crew calendar, which hides its men/photos there too.
  - *Label format:* `Daily Report — <date> — <crew>`; the activity feed says
    `Daily report <date> (<crew>) created/emailed to …`; the PDF heading is
    `Daily Report — <date> · <crew> · <job>` with a "Crew:" row after
    Contractor; file name `DailyReport-<project>-<crew>-<date>.pdf` (each name
    part left out when blank). A report whose crew is gone (a deleted
    project's) is named by its date alone.
  - *Renaming a crew* stamps its reports' `updatedAt` (not `version`, as for
    photos), so a PDF printed with the old name reads out of date.
  - The list view's man-count column, headed "Crew", is now "Men".

## Design

**Migration 45 (`daily-report-crews`, DATA-TRANSFORMING, supervised):**

- `daily_report_crews (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT
  NOT NULL, sortOrder INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL)` + `idx_daily_report_crews_project`.
- `daily_reports` is rebuilt — `UNIQUE(projectId, reportDate)` is a table
  constraint SQLite can't alter: one "Crew 1" per project that has reports
  (including a deleted project's leftovers, so no row is lost to the new NOT
  NULL); `daily_reports_new` with `crewId TEXT NOT NULL` and
  `UNIQUE(projectId, crewId, reportDate)`, every existing column and default;
  rows copied by column name (a column the new table lacks aborts the
  migration); row counts compared; drop, rename, and the table's indexes and
  triggers (read from `sqlite_master` before the drop) recreated. Ids are
  unchanged, so photos, attachments, `files.sourceId` and mail links still
  resolve. No table declares a foreign key to `daily_reports`.
- Runs in the framework's transaction after its backup copy; replay-safe
  (`IF NOT EXISTS`, no second crew, no rebuild once `crewId` exists).
- `scripts/` and `server/backup/`: no table lists to extend (the backup copies
  the whole database; the verify tool's lists are the cutover-era tables).

**Server:**

- `dailyReportStore.ts`: `listCrews` (makes "Crew 1" if none; tab order;
  `reportCount`), `createCrew`, `renameCrew`, `deleteCrew`, `getCrew`;
  `CrewConflictError` with code `crew_name_taken | crew_has_reports |
  last_crew`. Reports: `createDailyReport` requires a `crewId` of that project
  (`ValidationError` / `NotFoundError`); the date rule (`takenBy`) and
  `previousStartTime(db, projectId, crewId, reportDate)` are per crew;
  `getDailyReport` / `listDailyReports(db, projectId, crewId?)` carry `crewId`
  and `crewName` (one date's reports in tab order). `dailyReportActivityName`.
- Routes (same `authenticateToken` gate as the report routes):
  `GET/POST /api/projects/:id/daily-report-crews`,
  `PUT/DELETE /api/daily-report-crews/:id`; crew conflicts → `409 { error,
  code }`; changes broadcast `dailyReportCrew` (new change-feed type, server and
  client). `GET /api/projects/:id/daily-reports?crewId=` narrows to one crew.
  Create still answers `409 date_taken` with `existingId`.
- Labels with the crew: `documents.ts` (label, and the href opens the crew's
  tab — `SimpleResolver.href` now also gets the matched row), `mail/links.ts`,
  the send route's attachment name and default subject, activity on create and
  on send (`itemSendEffects.ts`).
- `deleteProject` deletes the project's crews (it still leaves its daily
  reports, as before).

**Client:**

- `store.ts`: `DailyReportCrew`; `crewId`/`crewName` on `DailyReport` and
  `DailyReportListItem`; `getDailyReportCrews`, `createDailyReportCrew`,
  `renameDailyReportCrew`, `deleteDailyReportCrew`; `createDailyReport` takes
  `crewId`.
- `ProjectDailyReports`: crew tabs (horizontally scrolling) + All crews; the
  ⋯ menu (Rename crew…, Delete crew — disabled with the reason) and Add crew
  sit outside the scroller; `CrewNameModal` is the name prompt for both (blank
  caught locally, the server's refusal shown under the field). Loads the crews
  and every crew's reports, filtering per tab, and live-refreshes on
  `dailyReport` and `dailyReportCrew`. The create form is labelled with the
  crew and files under it.
- `DailyReportsCalendar`: `onCreate` optional — without it, the read-only All
  crews mode lists each crew's report on its day (crew name · N men), each
  opening its own.
- `DailyReportEditor`: title, email subject/body and the "date taken" message
  name the crew. `dailyReportPdf.ts`: heading, "Crew:" row, file name.
  `dailyReportForm.ts`: `dailyReportTitle`.
- `pj-daily-latest` card: "Aug 5, 2026 · Crew 1" (on a date several crews
  filed, the last-filed one). Mail link picker: `Daily Report — <date> —
  <crew>`.

## Tests

- `server/migrationList.test.ts`: migration 45 on a seeded v44 database —
  every row, id and column value kept with photos/attachments still joined and
  defaults intact; one "Crew 1" per project with reports (incl. a deleted
  project's), none for a project without; uniqueness per crew, NOT NULL crewId,
  indexes; replay is a no-op; fresh install; an unknown column aborts with the
  v44 table untouched. Migration 27's test now stops at v27.
- `server/dailyReportStore.test.ts`: crew CRUD (default "Crew 1" once, order,
  counts, name rules, rename stamps updatedAt, delete only when empty and not
  the last), create requires a crew of the project, one per date per crew,
  moves within a crew only, crew-scoped `previousStartTime`, list carries and
  filters by crew, activity name.
- `server/routes.dailyReports.test.ts`: crew endpoints, 400/404/409s and
  broadcasts, per-crew `date_taken`, `?crewId=`, per-crew start time, activity
  messages. `server/routes.test.ts`: send subject/attachment name and activity
  with the crew; project delete removes crews. `server/documents.test.ts`,
  `server/mail/links.test.ts`: labels with the crew (and without, crew gone).
- Client: `ProjectDailyReports.test.tsx` (tabs, URL, per-crew lists, create
  under the crew, All crews list/calendar read-only and opening, add/rename/
  delete rules, live refresh), `DailyReportsCalendar.test.tsx` (All crews
  mode), `DailyReportEditor.test.tsx` (title, email subject/body, file name,
  date-taken message), `dailyReportPdf.test.ts`, `dailyReportForm.test.ts`,
  `libraryCards.test.tsx`, `LinkPickerModal.test.tsx`.
- e2e `e2e/daily-report-crews.spec.ts`: a project gets "Crew 1"; Add crew;
  the same date filed in both crews; Crew 1 (with a report) can't be deleted;
  All crews shows both reports on today's cell, offers no create, and opens
  the clicked crew's report in place.
