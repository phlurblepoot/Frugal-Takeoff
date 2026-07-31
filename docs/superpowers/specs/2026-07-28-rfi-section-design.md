# RFI Section — Design Spec

Date: 2026-07-28
Status: Approved by Nathan

## Purpose

A new project section for generating, sending, and tracking **RFIs** (Requests For
Information) — construction questions directed at the GC/architect. Modeled as an
independent vertical slice cloned from the Issues feature (the established
convention: Punch and Tasks were built the same way), reusing only the genuinely
shared utilities (letterhead, EmailComposer, recipient resolution, file storage,
UI kit).

Unlike Issues, RFIs track the **response**: usually an uploaded PDF, optionally
typed text.

## Decisions (from brainstorm)

- **Track responses**: response is a PDF upload (primary path) and/or free text.
- **Fields**: title, question, response-needed-by date, spec reference, drawing
  reference, to/attention, photos (same flow as Issues).
- **Lifecycle**: `open → sent → answered → closed`.
  - `sent` set automatically on email send (like Issues `markIssueSent`).
  - `answered` (+ `answeredAt`) set automatically when a response PDF is attached
    or response text is saved.
  - `closed` is manual (status pill click cycles open → sent → answered → closed).
  - **Overdue** is not a status: list shows a red hint when `responseNeededBy` is
    past and status is not answered/closed.
- **Numbering**: per-project `RFI-NNN` (zero-padded 3), mirroring `ISS-NNN`.
  Filename `RFI-003.pdf`.
- **Auth**: non-admin (any authenticated user), exactly like Issues.

## 1. Data model — migration 19 (`rfis`), ADDITIVE

```sql
CREATE TABLE rfis (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT,
  question TEXT,
  specRef TEXT,
  drawingRef TEXT,
  attention TEXT,
  responseNeededBy TEXT,        -- ISO date string, nullable
  responseText TEXT,            -- nullable
  responseFileId TEXT,          -- nullable, uploaded response PDF (files table)
  status TEXT NOT NULL DEFAULT 'open',   -- open|sent|answered|closed
  version INTEGER NOT NULL DEFAULT 1,
  sentAt INTEGER,
  answeredAt INTEGER,
  createdAt INTEGER NOT NULL
);
CREATE INDEX idx_rfis_projectId ON rfis(projectId);

CREATE TABLE rfi_photos (
  id TEXT PRIMARY KEY,
  rfiId TEXT NOT NULL,
  fileId TEXT NOT NULL,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);
CREATE INDEX idx_rfi_photos_rfiId ON rfi_photos(rfiId);
```

- Per-project numbering: `MAX(number)+1` scoped by projectId inside a
  `db.transaction` (same as `issueStore.createIssue`).
- Optimistic concurrency via `version` (save requires matching version → 409
  `version_conflict`).
- No FKs; manual cascade on project delete (add rfis + rfi_photos to
  `projectStore` delete cascade) and rfi delete cascades photo links.
- Response PDF is an ordinary shared-files row uploaded with `kind:
  'rfi-response'` (visible under Documents too). Photos use `kind: 'photo'`.
- Setting response (file or text) from empty → sets `answered` + `answeredAt`
  unless status is already `closed`. Clearing both response fields does not
  auto-revert status.

## 2. Server

`server/rfiStore.ts` (clone of `issueStore.ts`):
`RFI_STATUSES = ['open','sent','answered','closed']`, `getRfi`, `listRfis`
(with photoCount, newest-first), `createRfi`, `saveRfi` (version-checked),
`setRfiStatus`, `deleteRfi` (cascades photos), `addPhoto` (idempotent),
`removePhoto`, `markRfiSent`, `setRfiResponse({fileId?, text?})` (sets
answered/answeredAt), plus local `ValidationError/ConflictError/NotFoundError`.

Routes in `routes.ts` (`// ── RFI` block mirroring the issues block, all
`authenticateToken` only, shared error mapper):

| Route | Purpose |
|---|---|
| `GET /api/projects/:id/rfis` | list |
| `POST /api/projects/:id/rfis` | create (logs `rfi_created`) |
| `GET /api/rfis/:id` | fetch |
| `PUT /api/rfis/:id` | save (version-checked) |
| `PATCH /api/rfis/:id` | status change (logs `rfi_closed` when closed) |
| `DELETE /api/rfis/:id` | delete |
| `POST /api/rfis/:id/photos` | `{fileId}` |
| `DELETE /api/rfis/:id/photos/:fileId` | remove photo |
| `POST /api/rfis/:id/response` | `{fileId?, text?}` — at least one; logs `rfi_answered` |
| `POST /api/rfis/:id/send` | email; in `registerEmailRoutes`, mirrors issue send: validates `to` + `fileId`, default subject `RFI RFI-003 — <title>`, attachment name `RFI-003.pdf`, `markRfiSent`, logs `rfi_sent` |

## 3. Client

Registration (3 touch points, same as Issues):
1. `App.tsx`: `{ path: 'rfis', element: <ProjectRfis /> }` under `project/:projectId`.
2. `Sidebar.tsx` `PROJECT_NAV`: **RFIs** entry between Issues and Punch (not adminOnly).
3. `CommandPalette.tsx`: "New RFI" (`?new=1`) + "RFIs" nav entries.

Files:
- `src/pages/project/ProjectRfis.tsx` — list + create + delete page (clone of
  `ProjectIssues.tsx`). Table: #, Title, Status pill, Response needed (red text
  when overdue per the rule above), Photos, delete. `?new=1` focuses create
  input. Exports `rfiNo()` (zero-pad 3).
- `src/pages/project/rfi/RfiEditor.tsx` — detail modal (clone of
  `IssueEditor.tsx`, keyed `${id}:${version}`): title, question textarea,
  spec ref / drawing ref / attention inputs, response-needed-by date input,
  photo grid (immediate upload, same flow), **Response section** (upload-PDF
  button storing `kind:'rfi-response'` → `POST /response`; text area saved via
  `POST /response`; shows answered date and a link/download for the response
  file), status pill click cycles open → sent → answered → closed, save-first
  guard before email, PDF download, EmailComposer send (regenerates PDF with
  chosen header email, uploads as `kind:'rfi'`, then send route).
- `src/pages/project/rfi/rfiPdf.ts` — jsPDF Letter portrait with
  `drawLetterheadHeader/Footer`, brand 20pt "REQUEST FOR INFORMATION" title +
  created date; **two-column header block**: RFI no, date, response needed by,
  attention, spec ref, drawing ref (skip empty rows); project/contractor lines;
  brand heading `RFI-NNN · Title` + rule + status; wrapped question; Response
  section (response text if present; if a response PDF is attached, a note
  "Response received — see attached response document" with answered date);
  photos 2-up grid with page-break handling. Exports `rfiHeading()`.
- `src/components/ui/RfiStatusPill.tsx` — STATUS_META map over `StatusPill`
  (open=warn/amber-ish, sent=info, answered=ok, closed=neutral — match existing
  pill tones).
- `src/utils/store.ts` — `Rfi`, `RfiListItem` types + API client fns
  (`getRfis`, `getRfi`, `createRfi`, `saveRfi`, `setRfiStatus`, `deleteRfi`,
  `addRfiPhoto`, `removeRfiPhoto`, `setRfiResponse`, `sendRfi`).
- `src/utils/recipients.ts` — add `'rfi'` to `TemplateType`, role → `pm`
  (same as issue/punch).

## 4. Testing (mirror Issues pattern)

- `server/rfiStore.test.ts`: per-project sequential numbering, version-checked
  save + conflict, status validation, response setting (file/text/both → answered
  + answeredAt; closed not demoted), list ordering + photoCount, delete cascade,
  photo add/remove idempotency, `markRfiSent`.
- `server/routes.test.ts`: `describe('rfi routes')` — CRUD, 409, photos,
  response route validation (400 when neither fileId nor text), project delete
  cascade, send route (non-admin allowed, default subject/attachment name,
  marks sent).
- Thin pure tests: `rfiNo()` padding, `rfiHeading()`.

## Out of scope

- No dashboard/overview open-RFI count (can add later like `openIssueCount`).
- No photo staging before save (matches Issues).
- No response versioning/threading — one response slot per RFI.
