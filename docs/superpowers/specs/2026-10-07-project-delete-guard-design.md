# Project Delete Guard — Design

Date: 2026-10-07
Status: Approved by Nathan (conversation)

## Problem

`DELETE /api/projects/:id` hard-deleted a project and everything under it —
plan pages, measurements, every project file, invoices, payments, change
orders, pay applications, RFIs, issues, punch items — from either the Projects
board's trash button or Project Settings' danger zone. One mistaken click (or a
typed "delete") destroyed a job's whole record. Nathan: "make it so you cannot
delete a project once it has documents, only archive it", and, asked about
merging instead, "the option to delete a project with data is to just archive
it."

## Decisions (agreed with Nathan)

- **Only a project with nothing in it can be deleted** (one created by
  mistake). A project with any data can only be archived. There is no override
  and no merge.
- **Who may delete is unchanged:** any signed-in user, as before.
- **Archiving is the existing archive** (`PATCH /api/projects/:id`
  `{ archived: true }`, the board's Archive tab). Nothing new is invented.
  Archiving does not make a project deletable.
- **"Data" is anything a person made or uploaded that a delete would destroy
  or cut loose from the job.** Every table with a `projectId`, or keyed
  through a project-owned parent, was decided:

  | Table | Counts as | Why |
  |---|---|---|
  | `files` (`projectId`, every kind but `task-photo`) | **documents** | Uploads, generated documents, photos, plan PDFs, attachments, including archived documents and old versions. A document and its versions count once. A plan page's image and thumbnail count as that **plan page**, not as two more documents. A page image whose page row is gone still counts as a document, because the delete would remove it. |
  | `pages` | **plan pages** | |
  | `measurements` | **measurements** | |
  | `proposals` (+ lines, photos, attachments) | **proposals** | |
  | `invoices` (+ lines, photos, attachments) | **invoices** | |
  | `payments` (+ attachments), via the project's invoices and pay apps | **payments** | |
  | `change_orders` (+ lines, photos, attachments) | **change orders** | |
  | `aia_pay_apps` (+ lines) | **pay applications** | |
  | `aia_sov_lines` | **schedule of values lines** | |
  | `rfis` (+ photos, attachments) | **RFIs** | |
  | `issues` (+ photos, attachments) | **issues** | |
  | `punch_items` (+ photos) | **punch items** | |
  | `daily_reports` (+ photos, attachments) | **daily reports** | A crew with reports counts through its reports. |
  | `time_entries` | **time entries** | Hours charged to the job. |
  | `notes` | **notes**, one per item on the board | The board saves on every pan and zoom, so a row alone means nothing; only what's on it counts. |
  | `mail_thread_links` | **linked emails**, one per thread | A person linked the thread to the job; it's lost with the project. |
  | `takeoffs`, `plan_sets` | not data | Scaffolding: a takeoff list or plan set with nothing measured or uploaded. Their measurements and pages count. |
  | `daily_report_crews` | not data | The Daily Reports page creates "Crew 1" just by opening; a crew with no reports holds nothing. |
  | `aia_sov_locks`, project meta (AIA settings, contact overrides) | not data | Settings-like rows. |
  | `activity` | not data | Log rows. |
  | `tasks`, `task_photos`, task-photo files | not data | Tasks are company-level and outlive the project they merely refer to. Delete has always spared them. |
  | `shares`, `drafts`, `editor_*`, `sheet_*` | not data | Keyed through files, which already count. |

## Design

**Server, authoritative** (`server/projectStore.ts`):

- `projectDataSummary(db, id)` returns `{ hasData, summary }`. The summary has
  one count per kind, and only the kinds the project has, e.g.
  `{ documents: 12, invoices: 2 }`. The data is one `COUNT` query per kind,
  listed in `PROJECT_DATA_QUERIES`.
- `deleteProject` runs the summary inside its transaction, so nothing can land
  between the check and the delete. It throws
  `ProjectHasDataError(summary)` when there is anything. Its cascade is kept
  whole, so an empty project's scaffolding (takeoffs, plan sets, the auto
  crew, the SOV lock) is removed exactly as before.
- `visibleDataSummary(summary, isAdmin)`: people who aren't admins don't see
  billing, proposals or everyone's time elsewhere in the app. For them those
  kinds are folded into one `otherRecords` count, so they learn the project
  has records but not how many invoices.

**Routes** (`server/routes.ts`):

- `GET /api/projects/:id/delete-check` → `{ canDelete, summary }`, or 404 for
  an unknown project.
- `DELETE /api/projects/:id` on a project with data → **409**
  `{ error: 'project_has_data', message: 'This project has documents or records. Archive it instead.', summary }`.
  Nothing is deleted, logged or broadcast. Deleting an empty project behaves
  exactly as before: 200, activity logged, change broadcast.

**Client:**

- `src/utils/store.ts`: `getProjectDeleteCheck(id)`. `deleteProject` turns
  the 409 into `ProjectHasDataError` carrying the summary.
- `src/utils/projectDelete.ts`: the one-line reason, e.g. "Has 12 documents
  and 2 invoices — archive it instead." It names at most three kinds, the most
  recognizable first, then says "and more".
- **Projects board** (`ProjectsPage.tsx`; the same rows on desktop and phone):
  the trash button opens the delete dialog, which asks `delete-check` first
  and shows "Checking what's in this project…" meanwhile.
  - Empty project: the same type-"delete" confirmation as before.
  - Project with data: titled "Can't delete …", it gives the reason, and its
    only action is **Archive** (or just **Close** when the project is already
    archived).
  - If the server still answers 409 (something landed in between), the row
    comes back and the dialog reopens with the reason and Archive.
- **Project Settings** danger zone (`ProjectSettings.tsx`): the Delete row asks
  `delete-check` when the page loads.
  - With data: the row's description becomes the reason, Delete is disabled
    (with the reason as its tooltip). The Archive row directly above it in
    the same Danger zone card is the way out (no second Archive button).
  - Empty project: the same confirm as before.
  - A 409 updates the row and asks "Can't delete this project — <reason>" with
    Archive as the confirm button. If the project is already archived, it
    shows a warning toast instead.
  - If `delete-check` fails, Delete stays offered and the server still decides.
- No other place deletes projects (the command palette and project cards
  don't).

## Tests

- `server/projectStore.test.ts`:
  - The summary counts every kind and only the kinds present.
  - Each kind alone stops the delete, and nothing is removed.
  - Scaffolding isn't data: empty takeoffs and plan sets, the auto crew, an
    empty notes board, the SOV lock, activity, tasks and task photos.
  - Documents: archived ones count, versions count once, page images count as
    plan pages, a stray page image counts as a document.
  - Notes count per item.
  - Non-admin folding.
  - An empty project deletes and its scaffolding goes; task photos are spared.
  - The old cascade cases now refuse.
- `server/routes.test.ts`:
  - The 409 shape. Nothing is removed, logged or broadcast.
  - `delete-check` for an empty project, a project with data, and an unknown
    project (404).
  - An empty delete still returns 200, cleans up, logs and broadcasts.
  - Archived projects with data still refuse.
  - People who aren't admins can still delete empty projects and see
    `otherRecords`.
  - The former cascade tests (drafts, billing, payment attachments, record
    attachments, photos) now assert the refusal and that every row survives.
- `src/utils/projectDelete.test.ts` (wording) and `src/utils/store.test.ts`
  (409 → `ProjectHasDataError`, `delete-check`).
- `src/pages/project/ProjectSettings.test.tsx`:
  - The blocked row with Archive.
  - An archived project with data.
  - An empty delete with the same confirm.
  - A 409 race that offers Archive.
  - A failed check.
- `src/pages/ProjectsPage.test.tsx`:
  - The blocked dialog with Archive.
  - An archived project gets Close only.
  - An empty delete.
  - Waiting on the check.
  - A 409 race that reopens the dialog.
- `e2e/projects-board.spec.ts`: on the real board, a project with a document
  is refused by the API and offers Archive (and lands in the Archive tab). An
  empty project deletes through the type-"delete" dialog.
