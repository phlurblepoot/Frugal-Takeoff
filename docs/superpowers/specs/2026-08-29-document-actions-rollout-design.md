# Document Actions & File Picker Rollout — Design Spec

**Date:** 2026-08-29 · **Status:** approved by Nathan (brainstorm) · **Migrations:** 30 (additive — `updatedAt` on invoices, change_orders, issues, rfis, aia_pay_apps; ruled in during planning because the up-to-date check needs it)

## 1. Goals
Roll two patterns from the proposal rework across every document-producing area of the app:
1. **Generate → Open/Download → Send** (store server-side without downloading; Open/Download once a file exists; Send reuses the current file when up to date).
2. **Choose existing files** (`FilePickerModal`) beside every upload, unified into one "Add files" button with an Upload tab.
Plus: an up-to-date status chip, list-row Open actions, AIA Excel under the same pattern, drag-and-drop onto photo/attachment cards.

## 2. Decisions
| Topic | Decision |
|---|---|
| Button set (every editor) | `Save` · `Generate` (always available) · `Open` + `Download` (only when a file exists) · `Send`. Old "Download PDF" buttons removed. |
| Regenerate when a file exists | Dialog: **Save as new version** (file versioning, default) / **Overwrite** (replace bytes in place, no history) / Cancel. |
| Send | Reuse the current file if **up to date** (file `createdAt` ≥ entity `updatedAt` AND the chosen header email equals the default). Otherwise generate first (same dialog if a stale file exists), then send. Emailed PDF always matches the record. |
| Dirty rule | Generate/Send save first; a failed save aborts. Invoice/CO PDFs are built from saved state (fixes local-state drift). |
| Current-file discovery | `GET /api/documents/by-source` (lookup by `sourceType/sourceId/kind`), no new columns. Proposals keep `fileId` in sync via an `onGenerated` hook. |
| Open | `DocumentViewerModal` everywhere (editors + list rows), with its "Open in editor" link. |
| Status chip | "No PDF yet" / "PDF up to date" / "PDF out of date" in editor bars and list rows (Excel wording for pay apps). |
| List rows | Invoices, Change orders, Pay apps, Issues, RFIs, Daily reports: Open + chip when a file exists (batched lookup). |
| Picker | `FilePickerModal` gains an **Upload** tab (drag-drop + input) and `returnBlobs`; `AddFilesButton` = one button opening it. Project filter defaults to the current project when opened inside a project; global for EmailComposer / RFI response. |
| Picker sites in scope | Photos: Issue, RFI, Change order, Daily, Punch (per stage), Task (per stage). EmailComposer attachments. RFI response (single, any). Plan-set upload (AddPagesModal, New Project; pdf multi → bytes into the split pipeline). PDF editor (open → navigate `?fileId=`; import pages / insert image → bytes). Spreadsheet editor open. AIA SOV import (`returnBlobs`). **Out:** company logo, note images (not in the file store). |
| AIA Excel | `exportAiaXlsx` split into build (→ Blob) and deliver; pay-app editor gets Generate Excel / Open in spreadsheet editor / Download; Finalize unchanged. |
| Takeoff prints/exports | Unchanged (each print is its own artifact; random sourceId, not versioned). |
| Drag-and-drop | Photo/attachment cards accept dropped files → same upload path. |
| Sent record per entity | Out of scope (Nathan has a separate plan). |

## 3. Server
- `GET /api/documents/by-source?sourceType=&sourceId=&kind=` → `{ id, name, mime, size, createdAt, versionNumber }` or 404. `sourceIds=a,b,c` batch form → `{ [sourceId]: file | null }`. Applies `NON_ADMIN_EXCLUDED_KINDS` (non-admin → 404 / null). Implemented in `server/documents.ts` (`findLiveBySource` already exists in files.ts) + route in `routes.ts`.
- Upload `mode` query param on `POST /api/files/:id`: `version` (default, archive-then-replace as today) | `overwrite` (replace the live row's bytes/mime/size/sha256/createdAt in place, delete old bytes, no version row). Only meaningful when the source triple matches a live row; otherwise a normal create. `saveBinaryFile`/`persistGeneratedDocument`/`uploadProjectFile` accept `mode`.
- `saveNewVersion` and overwrite both set the live row's `createdAt = now` (generated-at semantics).
- PDF editor drafts for an overwritten/versioned file are cleared (`deleteDraft`) so a stale draft can't resurrect old content — check existing `saveFileVersion` behavior and match it.

## 4. Shared client
- `src/hooks/useGeneratedDocument.ts`: `useGeneratedDocument({ sourceType, sourceId, kind, updatedAt, enabled })` → `{ file, upToDate: boolean | null, loading, refresh }`; subscribes to change-feed `file` events (by id) and refetches. `useGeneratedDocuments(sourceType, kind, ids, updatedAtById)` batch variant for lists.
- `src/components/documents/DocumentActionsBar.tsx`: props `{ source: {sourceType, sourceId}, kind, fileName, format: 'pdf'|'xlsx', projectId, build: (opts: { headerEmail?: string }) => Promise<Blob>, dirty, save: () => Promise<boolean>, updatedAt, onGenerated?: (fileId) => void, send?: { enabled, blockedReason?, composerDefaults, sendFn: (fileId, m) => Promise<void> }, readOnly?, size?: 'sm' }`. Renders chip + buttons; owns `VersionOrOverwriteDialog`, `DocumentViewerModal`, `EmailComposer`; implements save-first, reuse-if-up-to-date, header-email regenerate, download via `downloadBlob(fetchFileBlob)`.
- `src/components/documents/DocumentStatusChip.tsx` (used by bar + list rows).
- `src/components/FilePickerModal.tsx`: new `upload?: { kind, projectId?, sourceType?, sourceId?, accept?: string, multi? }` → Upload tab (drag-drop + input, progress, partial-failure toast) that resolves to `DocumentRow[]` via `GET /api/files/:id/meta`; `returnBlobs?: boolean` → `onPickBlobs(files: { row, blob }[])`. Existing tab unchanged.
- `src/components/documents/AddFilesButton.tsx`: `{ label, accept, multi, upload, initialProjectIds, excludeFileIds, onPick | onPickBlobs }` — one button that opens the modal; `defaultTab` chooses the starting tab — photo cards pass `'upload'` (new photos are the common case), EmailComposer / attachments / RFI response pass `'existing'`.
- `src/hooks/useDropZone.ts`: small hook for card-level drag-and-drop → same upload path.

## 5. Rollout (per editor)
Invoice, Change order, Issue, RFI, Daily report, Punch (project-level bar on the page header), AIA pay app (xlsx), Proposal (adopt shared bar; `onGenerated` → `setProposalFile`; Send reuse-if-up-to-date replaces always-regenerate; the empty-lines guard becomes `send.blockedReason`). Each editor: remove its Download/regenerate-on-send code; expose `build()` from saved state; list view gets Open + chip via the batch hook.

## 6. Edge cases
- Header email override → always regenerate (no reuse); the generated file replaces per the dialog choice.
- Overwrite when the file is referenced elsewhere (proposal attachment, email): allowed — same id, new bytes.
- Non-admin: bars/rows for admin-only kinds hidden as today; by-source 404s.
- Up-to-date null when no file; a proposal/entity with no `updatedAt` treats any file as up to date.
- Batch lookup capped at 200 ids per request.

## 7. Tests
Server: by-source (hit, 404, admin exclusion, batch), overwrite mode (same id, no version row, bytes replaced, createdAt refreshed, old bytes gone), version mode unchanged. UI: hook (upToDate math, refresh on file event), bar (dialog paths, reuse vs regenerate, save-first abort, header-email regenerate, download), chip states, picker Upload tab + returnBlobs, AddFilesButton, drop zone, one test per editor (bar wired, download button gone, build uses saved state), list-row Open + chip, AIA build/deliver split. Playwright: invoice generate → up-to-date → edit+save → out-of-date → send prompts and regenerates; picker Upload tab from a photo card.

## 8. Out of scope
Sent-record columns; logo/note-image storage; takeoff print versioning; per-item punch reports.
