# Unified Documents Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Global /documents page (layout A: filter-bar table, multi-select filters, bulk bar, upload-labeling popup, archive/delete tiers, custom types) showing every document app-wide with canonical types + source attribution; generate flows persist via upsert-by-source versioning; project Documents tab becomes a filtered deep-link.

**Architecture:** Migration 23 (additive file columns + derived relabel/backfill) → new server surface (`GET /api/documents`, PATCH/DELETE guards, upsert-by-source on upload) → client save-site instrumentation (canonical kinds + source metadata + persist-on-generate) → the page UI in two passes → E2E.

**Spec:** `docs/superpowers/specs/2026-08-17-unified-documents-design.md` — READ IT FIRST; its Decisions and Data model sections are normative, including the upsert-by-source amendment.

## Global Constraints

- Branch `testing` (commit; no pushes/PRs mid-plan).
- Migration 23 is DERIVED-ONLY data transformation: fills nulls + requalifies `kind` labels from existing references; never deletes/moves bytes; idempotent; ⚠️ supervised-pull flag for Nathan at the end.
- Canonical kind vocabulary + non-admin exclusions exactly per spec (`invoice`, `payapp-export`, `change-order`, `proposal` hidden for non-admins; `plan` + `settings-asset` hidden for everyone; printouts visible to all).
- Delete allowed ONLY for rows with no sourceType AND direct-upload kinds (`document|spreadsheet|photo|other|custom:*`); kind changes same restriction. Archive allowed on anything visible.
- Run `npx vitest run` (818 green at start) + `npx tsc --noEmit` before every commit. Playwright only in the final task + controller.
- Never touch `data/` (migration rehearsal uses a scratch copy).

---

### Task 1: Server foundation — migration 23, canonical kinds, upload metadata, upsert-by-source

**Files:**
- Modify: `server/migrationList.ts` (append migration 23; read migration 21/22 idioms)
- Modify: `server/files.ts` (PutOpts + putBuffer/putDataUrl: `customerId`, `sourceType`, `sourceId`; new `DOC_KINDS` constants; upsert-by-source logic; `setFileFlags` for archived/kind)
- Modify: `server/routes.ts` (POST /api/files/:id passes the new query params)
- Test: `server/files.test.ts`, `server/migrationList.test.ts` (append)

**Interfaces:**
- Produces (Tasks 2/3 rely on exact names):
  - files columns `customerId TEXT`, `sourceType TEXT`, `sourceId TEXT`, `archived INTEGER NOT NULL DEFAULT 0` (PRAGMA-guarded ALTERs).
  - `putBuffer(db, dataDir, id, buf, mime, opts)` with `opts: { projectId?, kind?, name?, customerId?, sourceType?, sourceId? }`; **upsert-by-source**: when `sourceType && sourceId && kind` are all provided AND a live row (`parentFileId IS NULL`) exists with the same triple, archive-then-overwrite THAT row via the existing `saveNewVersion` machinery and return `{ id: existingId, versioned: true }`; else create normally, return `{ id, versioned: false }`. POST /api/files/:id responds `{ success, fileId, versioned }` (fileId may differ from the requested id!).
  - Exported `SYSTEM_KINDS` list + `DIRECT_UPLOAD_KINDS = ['document','spreadsheet','photo','other']` + `isDirectUploadKind(kind)` (true also for `custom:` prefix) in files.ts.
- Migration 23 relabel/backfill (each pass wrapped so a malformed row is skipped with a warn, not a crash — mirror migration 21's meta guard):
  1. Join tables first: `issue_photos`→kind `issue-photo`, source (`issue`, issueId); `punch_photos`→`punch-photo`/(`punch`, punchItemId); `task_photos`→`task-photo`/(`task`, taskId) AND backfill files.projectId from the task's projectId when null; `change_order_photos`→`change-order-photo`/(`change-order`, changeOrderId); `rfi_photos`→`rfi-photo`/(`rfi`, rfiId).
  2. Page/plan assets: for every project page — `sourcePdfFileId`→kind `plan-source` + source (`plan-set`, planSetId or projectId when null); `imageId`/`thumbnailId`→kind `plan`. (Pages live in the `pages` table with attrs — read how migration 5's backfill walked them and mirror.)
  3. Project JSON fields: `printouts[]`→kind `printout` + source (`printout`, printout.id); `proposalFileId`→`proposal` + (`proposal`, projectId); `proposalPhotoIds[]`→`proposal-photo` + (`proposal`, projectId).
  4. `rfis.responseFileId`→`rfi-response` + (`rfi`, rfiId).
  5. `settings.aiaTemplateFileId` (read from the settings table) → kind `settings-asset`.
  6. Legacy generic kinds left alone (`document`/`spreadsheet`/`photo`/`other` rows not matched above keep their kind; remaining `photo`-kind rows matched by NO join table stay plain `photo`). `punch-report`/`issue`/`invoice`/`rfi`/`change-order`(-remaining)/`email-attachment` keep kind, gain source only where derivable (they aren't — leave sourceType null).
  All passes set kind/source ONLY when the current value differs/is null — idempotent by construction; migration test runs `up()` twice and diffs.

- [ ] **Step 1: Failing tests** — migrationList.test.ts: seed one file per class above (join-table photo, task photo w/ null projectId, page assets, printout, proposalFileId, rfi response, aia template, an untouched generic upload), run migrations, assert each row's (kind, sourceType, sourceId, projectId) lands per the table; re-run idempotent. files.test.ts: upsert-by-source (two putBuffers with same source triple → one live row, versionNumber 2, listVersions has the archived first payload; different kind same source → two rows; missing sourceId → normal create); new opts persist columns.
- [ ] **Step 2: RED → Step 3: Implement → Step 4: GREEN + full suites.**
- [ ] **Step 5: Commit** — `feat(documents): migration 23 canonical kinds/source backfill + upsert-by-source uploads`

---

### Task 2: Server API — /api/documents list, PATCH/DELETE guards

**Files:**
- Create: `server/documents.ts` (query/aggregation + source-label resolution)
- Modify: `server/routes.ts` (register GET /api/documents, PATCH /api/files/:id, DELETE /api/files/:id)
- Test: `server/documents.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 columns/kinds/helpers.
- Produces:
  - `GET /api/documents?projectIds=a,b&customerIds=c&kinds=x,y&q=&archived=0|1&limit=&offset=` (authenticated) → `{ rows: [{ id, name, mime, size, kind, createdAt, versionNumber, archived, projectId, projectName, customerId, customerName, source: { type, id, label, href } | null }], total }`. customerId filter matches `files.customerId` OR `projects.customerId` via join. Always excludes `plan` + `settings-asset` + version rows; excludes archived unless `archived=1` (then ONLY archived); non-admin additionally excludes `invoice`, `payapp-export`, `change-order`, `proposal` (kind `change-order-photo` stays visible). Sort createdAt DESC. `total` = count under the same filters.
  - Source labels resolved in `server/documents.ts` per sourceType: invoice→`Invoice #<number>` href `/project/:pid/billing?tab=invoices`; payapp→`Pay App #<number>` href billing payapps tab (read ProjectBilling's ?tab= values); change-order→`CO #<number>`; issue→`Issue #<number>`; punch→`Punch item` (title if cheap); rfi→`RFI #<number>`; task→task title href `/tasks?projectId=`; proposal→`Proposal` href `/project/:pid/proposal`; printout→printout name href proposal section; plan-set→plan-set name href `/project/:pid/takeoff`. Missing referent (deleted entity) → label from kind, href null. Resolve with batched queries per type, not per-row lookups.
  - `PATCH /api/files/:id` `{ archived?, kind? }` — archived: boolean, any visible row; kind: only when `isDirectUploadKind(current) && isDirectUploadKind(new)` (custom:* validated against settings.documentTypes ids), else 409.
  - `DELETE /api/files/:id` — only `sourceType IS NULL && isDirectUploadKind(kind)`; deletes version rows + bytes (reuse removeFile + version cleanup); else 409 with a reason string.
- [ ] **Step 1: Failing tests** — filter matrix (multi-project, multi-kind, customer-only file, q, archived toggle exclusivity, paging+total), role exclusion (admin vs user stub — mirror routes.test.ts's two-app pattern), source-label resolution for at least invoice/payapp/CO/task/printout incl. a dangling sourceId, PATCH guards (archive ok on generated row; kind change 409 on generated; custom kind validated), DELETE guards (409 on sourced row; success wipes versions+bytes).
- [ ] **Step 2: RED → 3: Implement → 4: GREEN + suites → 5: Commit** — `feat(documents): global documents API — filtered listing w/ source labels, archive/kind patch, guarded delete`

---

### Task 3: Client instrumentation — canonical kinds, source metadata, persist-on-generate

**Files:**
- Modify: `src/utils/store.ts` (`uploadProjectFile`/`saveBinaryFile` gain `customerId`/`sourceType`/`sourceId` opts; both must return the server's `{ fileId, versioned }` so callers use the CANONICAL id; new `persistGeneratedDocument(blob, { projectId, kind, name, sourceType, sourceId })` helper wrapping upload+return-id)
- Modify (photo/report call sites — exact anchors from the exploration; READ each): `IssueEditor.tsx:75` photos→kind `issue-photo`+source; `:235` report→source (`issue`, id); `RfiEditor.tsx:87`→`rfi-photo`+source; `:111` response + source; `:327` rfi pdf + source; `PunchItemEditor.tsx:40`→`punch-photo`+source; `ProjectPunch.tsx:294` report→(`punch-report` kind stays; source (`punch`, projectId)); `ChangeOrderEditor.tsx:119` photos→`change-order-photo`+source; `:313` pdf→(`change-order`, id); `ProjectProposal.tsx:379` proposal-photo + source; printout saves (ProjectView + ProjectProposal) add source (`printout`, printout.id); `TaskEditor.tsx:102` SWITCH from unattributed saveFile to attributed upload (kind `task-photo`, source (`task`, taskId), projectId from the task) — verify the read path (getImageUrl) still works (same files store — it does).
- Persist-on-generate (each Download handler: build blob as today → `persistGeneratedDocument` → then trigger the browser download from the same blob; failures to persist must NOT block the download — toast a warning): `InvoiceEditor.tsx:146` (kind `invoice`, source invoice id), `ChangeOrderEditor` download, `IssueEditor` download, `ProjectPunch` download, `RfiEditor` download, AIA export (`AiaPayApplications`/export button in the payapp editor — kind `payapp-export`, source (`payapp`, appId), name `Pay App #N — G702.xlsx`); blank-SOV download EXCLUDED (template, not a document).
- Test: extend any existing editor tests whose fixtures now need the new upload shape (vitest will surface them).

**Interfaces:**
- Consumes: Task 1's upload params + upsert semantics (send flows and download flows both upload with the same source triple → server versions the same document; callers must use the RETURNED fileId when recording references, e.g. send-flow attachment ids).
- Produces: every new file row born attributed; Task 5's page shows real data.
- [ ] **Step 1:** store.ts helpers (typed, returned-id contract). **Step 2:** sweep the call sites (grep `uploadProjectFile(` and `saveFile(`/`saveImage(` in src/ to confirm none missed beyond plan-page assets + AIA template which stay as-is). **Step 3:** persist-on-generate wiring. **Step 4:** `npx vitest run && npx tsc --noEmit && npm run build`. **Step 5: Commit** — `feat(documents): attributed uploads everywhere + persist-on-generate via upsert-by-source`

---

### Task 4: Documents page — shell, table, filters, deep links

**Files:**
- Create: `src/pages/documents/DocumentsPage.tsx`, `DocumentsFilterBar.tsx`, `DocumentsTable.tsx`, `MultiSelectDropdown.tsx` (generic checkbox dropdown w/ count summary), `src/pages/documents/docTypes.ts` (kind→label/badge-tone map incl. custom types from settings)
- Modify: `src/App.tsx` (route `/documents`; `/project/:projectId/documents` → redirect component preserving projectId), `src/components/shell/Sidebar.tsx` (WORKSPACE_NAV entry, FolderOpen icon between Tasks and Time), `src/components/CommandPalette.tsx` (global Documents entry)
- Delete: `src/pages/project/ProjectDocuments.tsx` AFTER extracting `openTargetFor` + version-history row UI into `src/pages/documents/` modules (grep confirms no remaining importers)
- Modify: `src/utils/store.ts` (getDocuments fetch + types)

**Interfaces:**
- Consumes: `GET /api/documents` (Task 2 shape); settings.documentTypes for custom labels.
- Produces (Task 5 builds on): page renders table per mockup A — columns select-checkbox / Name (icon by mime) / Type badge / Project / Source link / Date / row actions slot; URL params `?projectId=&customerId=&kind=&q=&archived=` (comma lists) drive the filters (deep-linkable; project Documents nav lands filtered); search debounced; "Filtered: N of TOTAL" footer; paging (Load more, 100/page); version-history expandable row (from retired component); open-on-click via openTargetFor. Testids: `documents-row`, `doc-filter-project`, `doc-filter-customer`, `doc-filter-type`, `doc-filter-archived`, `documents-upload`.
- Row actions THIS task: open + version history only (bulk bar/upload/archive/delete are Task 5 — leave a slot).
- [ ] Implement; `npx vitest run && npx tsc --noEmit && npm run build`; grep no imports of the deleted file; note e2e specs referencing old project-documents selectors for Task 6. Commit — `feat(documents): global documents page — filterable table, deep links, project tab redirect`

---

### Task 5: Upload popup, bulk bar, archive/delete, custom types settings

**Files:**
- Create: `src/pages/documents/UploadDocumentsModal.tsx`, `DocumentsBulkBar.tsx`
- Modify: `DocumentsPage.tsx`/`DocumentsTable.tsx` (row checkboxes, bulk state, per-row archive/delete affordances, change-type action, drag-drop), `src/pages/Settings.tsx` (admin "Document types" card: list/add/rename/delete with in-use count guard via a `GET /api/documents?kinds=custom:<id>&limit=1` total probe or a dedicated count param — implementer's choice, state it), `src/utils/store.ts` (patchFile/deleteFile/documentTypes helpers)
- Test: unit-test the pure selection-policy helper (see below) in a small `documentsPolicy.test.ts`

**Interfaces:**
- Consumes: Tasks 2 + 4.
- Produces per mockups: upload popup (multi-file chips, shared Type ▾ [system direct-upload kinds + custom types] + Customer ▾ + optional Project ▾ with project→locks customer, per-file type disclosure; uploads via Task 3 helpers with customerId); bulk bar (N selected · Download [sequential fetch of raw streams] · Archive · Delete "(N of M)" enabled per policy · clear); per-row: archive icon on attached rows (tooltip "manage at source"), delete icon on deletable rows (confirm), "Change type" in a row menu for direct uploads; Archived filter shows archived rows w/ Restore. **Pure policy helper** `selectionPolicy(rows) → { downloadable: all, archivable: all, deletable: subset }` (deletable = !sourceType && direct-upload kind) — unit-tested; plan-source rows additionally excluded from archive per spec (view-only).
- [ ] Implement; suites + build green; commit — `feat(documents): upload labeling popup, bulk actions, archive/delete tiers, custom types settings`

---

### Task 6: E2E + migration rehearsal + full verification

**Files:**
- Create: `e2e/documents.spec.ts`; extend `e2e/fixtures/seed.ts` (portfolio gains a couple of typed docs if needed — reuse withPayApp etc.)
- Fix any specs broken by the ProjectDocuments retirement (Task 4's report lists candidates; grep e2e/ for `/documents` + old selectors).

- [ ] Specs: (1) global page lists seeded docs with type badges + source links; multi-select two projects + two kinds via the dropdowns; search narrows; (2) upload popup: batch of 2 files typed+attributed → rows appear; change-type on one; delete it (confirm) — while a generated/attached row shows NO delete affordance and archive instead; (3) archive → row leaves default view, appears under Archived, restore returns it; (4) project Documents nav → lands on /documents pre-filtered; (5) non-admin session: billing kinds absent, printout visible.
- [ ] Migration rehearsal on a SCRATCH COPY of data/app.db (never data/ itself): boot, confirm 7→23 chain clean; report before/after kind distribution counts.
- [ ] Full verification: `npx vitest run`, `npx tsc --noEmit`, `npx playwright test` (full suite green).
- [ ] Commit — `test(e2e): unified documents coverage + migration 23 rehearsal notes`

---

## Execution notes

- Waves: T1 → (T2 ∥ T3) → T4 → T5 → T6 → final whole-branch review (most capable model) → one fix wave → controller full-suite verify → push (⚠️ push summary must flag migration 23 as supervised-pull: derived relabeling of real file rows).
- T2 (server) and T3 (client) are disjoint. T4 and T5 share the new page files — sequential.
- The e2e task must use LOCAL-date helpers for any dates (UTC rollover bit twice before).
