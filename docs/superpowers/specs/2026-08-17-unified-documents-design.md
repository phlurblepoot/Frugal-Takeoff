# Unified Documents Page — Design

Date: 2026-08-17
Status: Approved by Nathan (conversation + visual mockups: layout A refined — filter-bar table with multi-select filters, bulk bar, upload popup)

## Problem

Documents are scattered: each project has a Documents tab showing only its own
uploads; generated artifacts (proposals, printouts, CO/issue/punch/RFI PDFs,
invoices) are findable only inside their feature areas; pay-app Excel exports
and plain PDF downloads are never stored at all; photos live behind their
entities; types (`kind`) are free-text and ambiguous (`photo` = issue AND RFI
photos; `change-order` = CO photos AND CO PDFs); nothing is filterable
app-wide.

## Decisions (agreed with Nathan)

- New top-level **Documents** tab (sidebar, next to Tasks). The per-project
  Documents nav entry remains but navigates to
  `/documents?projectId=<id>` (global page pre-filtered).
- **Every document appears** — original plan-set PDFs, proposals, printouts,
  invoice/CO/issue/punch/RFI PDFs, pay-app spreadsheets, photos, uploads —
  EXCEPT per-page plan assets (page rasters/thumbnails stay hidden).
- **Store on every generate**: Download buttons and pay-app Excel export now
  persist the artifact (as a new version of that entity's stable document,
  so regeneration never clutters).
- **Auto-typing + source attribution**: program-created files get canonical
  types and a `source` reference (which invoice/CO/pay app/etc.), shown as a
  clickable link.
- **Direct uploads** open a labeling popup: multi-file batch, Type +
  Customer + Project (project optional; picking a project locks its
  customer, same rule as tasks) + per-file type disclosure.
- **Filters are multi-select** (projects, customers, types) + search + sort
  + Archived toggle.
- **Row multi-select + bulk bar**: Download (always), Archive (always,
  reversible soft-hide), Delete (only the deletable subset; bar shows
  "Delete (N of M)").
- **Safe deletion tiers**: plan-set sources = view-only (managed in plan-set
  management); attached/generated files = Archive here, delete at the source
  entity (the source link is the path); direct uploads/loose files = real
  delete with confirm.
- **Role visibility**: billing-priced types (invoice, pay-app export,
  change-order PDF, proposal) are excluded server-side for non-admins;
  printouts (quantities only, no dollars) and everything else visible to
  all.
- **Custom types**: admin-managed list in Settings ("Document types" card):
  add/rename custom types (files store the type id; labels live in
  settings); deletion blocked while in use (shows count). System types are
  locked. Custom types available in the upload popup, type filters, and a
  per-file "change type" action (direct uploads only).

## Data model (migration 23 — additive columns + derived relabeling)

`files` table gains (all nullable/additive):
- `customerId TEXT` — set on customer-scoped uploads; derived from
  `projects.customerId` at query time when projectId present (no dual-write).
- `sourceType TEXT` / `sourceId TEXT` — the owning entity
  (`invoice|payapp|change-order|issue|punch|rfi|task|proposal|printout|plan-set`
  + its id). Written going forward at upload/generate time.
- `archived INTEGER NOT NULL DEFAULT 0`.

Canonical `kind` vocabulary going forward (kind column reused, values
requalified): `plan-source`, `plan` (page assets, hidden), `proposal`,
`proposal-photo`, `printout`, `invoice`, `change-order`,
`change-order-photo`, `issue-report`, `issue-photo`, `punch-report`,
`punch-photo`, `rfi`, `rfi-photo`, `rfi-response`, `task-photo`,
`payapp-export`, `email-attachment`, `settings-asset` (AIA template;
excluded from the page), `document`, `spreadsheet`, `photo`, `other`, plus
`custom:<id>` for admin-defined types.

Migration 23 derived backfill (data-transforming but purely derived —
rewrites kind labels + fills sourceType/sourceId/projectId from existing
references; ⚠️ flag to Nathan on pull per protocol):
- join tables → requalify photos (`issue_photos`→`issue-photo`+source, etc.
  for punch/task/CO/RFI) and backfill task photos' missing projectId from
  their task.
- direct fields → `pages.sourcePdfFileId`→`plan-source`+plan-set source;
  `pages.imageId/thumbnailId`→`plan`; `project.printouts[]`→`printout`
  +source; `proposalFileId`→`proposal`; `proposalPhotoIds`→`proposal-photo`;
  `rfis.responseFileId`→`rfi-response`+source.
- `settings.aiaTemplateFileId` → `settings-asset`.
- Generated PDFs already labeled (`invoice`, `issue`, `rfi`, `punch-report`,
  `change-order`) keep their kind (CO photo/PDF ambiguity resolved by the
  join-table pass first: rows in `change_order_photos` become
  `change-order-photo`; remaining `change-order` rows are PDFs); their
  specific sourceId stays unknown for historical rows (acceptable — project
  attribution remains).

Stable documents per entity — **upsert-by-source** (amended during planning;
replaces the earlier per-entity `pdfFileId` columns, same behavior with no
entity schema changes): when an upload arrives with `sourceType`+`sourceId`+
`kind` matching an existing live file row, the server stores it as a new
VERSION of that row (returning the existing id) instead of creating a new
file. Generate/Download/Send flows therefore just upload with source
metadata every time; regeneration versions, never duplicates. Photo kinds
never collide with document kinds on the same entity (distinct `kind`
values), and printouts keep one file per printout entry (each has its own
sourceId).

Custom types: `settings.documentTypes` JSON `[{ id, label }]` (admin-gated
save path as other settings).

## Server

- `GET /api/documents` (authenticated): filters `projectIds`, `customerIds`
  (via join on projects for project-attributed files + files.customerId for
  customer-only), `kinds`, `q` (name substring), `archived` (default
  excludes), sort (`createdAt` default desc), paging (limit/offset,
  default 100). Response rows: file meta + `projectName`, `customerName`,
  `source: { type, id, label, href } | null` (labels resolved server-side:
  "Invoice #12", "COR-3", "Pay App #9", "Issue #4", task title, etc.; href
  is the client route to the owning surface). Excludes `plan` +
  `settings-asset` always; excludes billing-priced kinds for non-admins
  (invoice, payapp-export, change-order, proposal — printouts stay
  visible: quantities only).
- `PATCH /api/files/:id` (new): `{ archived?: boolean, kind?: string }` —
  kind changes allowed only on direct-upload kinds (document/spreadsheet/
  photo/other/custom:*), never on system-generated rows.
- `DELETE /api/files/:id` (new): allowed only when the row has no
  sourceType AND kind is a direct-upload kind; 409 otherwise. Removes
  version rows + bytes.
- Upload: existing `POST /api/files/:id` gains `customerId` + `sourceType`/
  `sourceId` query params.

## Client

- `src/pages/documents/DocumentsPage.tsx` (+ focused child components:
  filter bar, table, bulk bar, upload modal): layout A per mockup. Multi-
  select dropdown component (checkbox list w/ count summary — reuse/extend
  the board's customer-filter idiom). Open targets reuse
  `openTargetFor` semantics from ProjectDocuments. Version history stays
  (expandable row). Drag-drop + picker both open the labeling popup.
- Sidebar: Documents entry in WORKSPACE_NAV; command palette global entry.
- `/project/:id/documents` route → `<Navigate to="/documents?projectId=…">`;
  old ProjectDocuments.tsx retired (its upload/version/open logic moves to
  the global page's components).
- Settings: "Document types" admin card (list, add, rename inline, delete
  w/ in-use guard showing count).
- Generate flows updated to persist: invoice/CO/issue/punch/RFI download
  buttons, AIA export button, proposal generation (already stores), with
  stable-id versioning per the data model.
- Editors (PdfEditor/SpreadsheetEditor) unchanged.

## Testing

- Unit: migration 23 relabel/backfill matrix (every join table + direct
  field case; idempotent); /api/documents filtering (multi-project, multi-
  kind, customer-only files, role exclusion, archived, paging, q); delete/
  patch guards (409 on attached; kind-change guard); stable-id versioning
  (two generates → one row, version 2).
- E2E: global page loads with seeded portfolio (docs from several classes);
  multi-select filters; upload popup batch flow; archive + restore;
  delete guard (attached file's delete absent, upload's present); project
  Documents nav lands filtered.
- Manual (Nathan): eyeball the migrated real data's type labels; one
  download-persists check per document class he uses most (invoice, pay
  app export).

## Out of scope

- Regenerating historical source links for pre-existing sent PDFs (project
  attribution only).
- Logo/settings image management (stays in Settings).
- Email-composer attachment picker choosing from Documents.
- Retention/auto-cleanup policies.
