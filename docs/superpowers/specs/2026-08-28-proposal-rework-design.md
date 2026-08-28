# Proposal Rework — Design Spec

**Date:** 2026-08-28
**Status:** Approved by Nathan (brainstorm session), ready for implementation plan
**Migration:** 28 (data-transforming, SUPERVISED — see §7)

## 1. Goals

Turn proposals from a one-off client-side PDF with no record into a first-class,
numbered, versioned project entity, and fix the surrounding workflow:

1. Multi-line pricing that mixes takeoff-derived lines and manual (flat) lines, with an
   alternate flag and an optional grand total.
2. Every proposal's inputs are saved so it can be revised later from the same data.
3. Takeoff Print / Excel outputs leave the proposal page; they become `takeoff-print` /
   `takeoff-export` documents in the Documents page.
4. Takeoff selections on the Takeoffs tab carry into a new proposal.
5. Proposal photos are attached to the proposal record via a join table, like every other
   generated document type.
6. Existing-PDF attachments appended to the proposal; files can be uploaded or chosen from
   the server via a new reusable **FilePickerModal**.
7. Revise prompts whether to carry photos and attachments.

Plus the agreed additions: line library, inclusions/exclusions, signed copy on acceptance,
sent record, expiry awareness + dashboard card + activity entries, photo captions
(empty by default), optional payment schedule, legacy data migration,
`company-document` type.

## 2. Decisions (from brainstorm)

| Topic | Decision |
|---|---|
| Cardinality | Many proposals per project, per-project numbering `#1, #2…`, lineage via `revisedFromId`, list shows `#2 (rev. of #1)`. |
| Numbering visibility | Internal only. **Never** on the PDF or filename. Filename = `Proposal – <project> – <YYYY-MM-DD>.pdf`. |
| Pricing model | Unified line list; each line is `manual` or `takeoff`. Flat-price proposal = only manual lines. |
| Takeoff line | One takeoff per line; always shows measurement totals inline; description defaults to takeoff name, editable. "Include takeoff list" toggle removed; "include cost detail" kept. |
| Override | Takeoff line amount overridable after a confirmation dialog. Proposal-local only; never touches takeoff data. `derivedAmountCents` stored alongside; `amountCents !== derivedAmountCents` ⇒ overridden. Subtle-but-visible indicator on the line and on the list row (not on the PDF). |
| Alternates | `isAlternate` flag; excluded from grand total; printed on their own page, split takeoff/manual. |
| PDF layout | Grand total immediately after the pricing tables, before inclusions/notes; pricing split into takeoff vs manual tables; alternates on a separate page with the same split. |
| Page structure | `/project/:id/proposal` = list; `/project/:id/proposal/:proposalId` = full-page editor. |
| Takeoffs tab → Proposal | Always creates a **new** draft seeded with the selected takeoffs and opens the editor. |
| Lifecycle | `draft → sent → accepted \| declined`. Locks on send. Drafts only are deletable. Revise creates the next number pre-filled. |
| Accept | Offers to prefill the SOV from non-alternate lines; declining leaves the SOV as-is (blank if new). Optional signed-copy attach. |
| Takeoff prints | Print/Excel save as `takeoff-print` / `takeoff-export`, named `Takeoff Print – <project> – <date>` / `Takeoff Export – …`, then navigate to Documents pre-filtered (project + those kinds). Permanent "Takeoff prints" link on the Takeoffs tab to the same URL. |
| File picker | All files, with the Documents page's full filter bar (project, type, search, archived…). `accept` filter (pdf / image / any), multi-select. Same admin visibility as Documents. |
| Company documents | New direct-upload kind `company-document`, `projectId = null`. No new table. |
| Attachments in PDF | Appended after photos (and highlights), in arranged order, pages untouched (no letterhead, no page numbers). |
| Revise prompt | One dialog, two checkboxes default on: "Bring over photos (N)", "Bring over attachments (N)". Lines/notes/terms/options always carry. Photos carry by file reference. |
| Photos | Upload **or** choose existing (picker, images). Caption input under each, empty by default. |
| Visibility | Proposals are **admin-only** (page, routes, documents, activity), like invoices/COs. |
| Payment schedule | Optional per proposal (checkbox). Text-only, no billing linkage. |

## 3. Data model (migration 28, additive tables + data transform)

### `proposals`
```
id TEXT PK, projectId TEXT NOT NULL (→ projects), number INTEGER NOT NULL,
revisedFromId TEXT NULL (→ proposals.id),
status TEXT NOT NULL ('draft'|'sent'|'accepted'|'declined'),
legacy INTEGER NOT NULL DEFAULT 0,          -- migrated from project.printouts; read-only
title TEXT NULL, validUntil TEXT NULL, fontFamily TEXT NULL,
coverNotes TEXT NULL, terms TEXT NULL,
inclusions TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
exclusions TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
paymentSchedule TEXT NULL,                  -- JSON [{description, percent?|amountCents?}] or null = not included
showGrandTotal INTEGER NOT NULL DEFAULT 1,
includeCostDetail INTEGER NOT NULL DEFAULT 0,
includeSignature INTEGER NOT NULL DEFAULT 1,
highlightQuality TEXT NOT NULL DEFAULT 'print',   -- 'print'|'email'
fileId TEXT NULL (live generated PDF), signedFileId TEXT NULL,
sentAt TEXT NULL, sentTo TEXT NULL,          -- JSON {to, cc, subject}
acceptedAt TEXT NULL, declinedAt TEXT NULL,
version INTEGER NOT NULL DEFAULT 1, createdBy TEXT NULL,
createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
UNIQUE(projectId, number)
```
Index on `projectId`, on `status`.

### `proposal_lines`
```
id, proposalId (→ proposals, cascade), sortOrder INTEGER,
kind TEXT ('manual'|'takeoff'), takeoffId TEXT NULL,
description TEXT NOT NULL,
amountCents INTEGER NOT NULL,
derivedAmountCents INTEGER NULL,            -- takeoff total at last derive; null for manual
measurementSummary TEXT NULL,               -- e.g. "4,120 SF · 312 LF", snapshot for PDF + deleted-takeoff resilience
isAlternate INTEGER NOT NULL DEFAULT 0
```
Overridden ⇔ `kind='takeoff' AND derivedAmountCents IS NOT NULL AND amountCents != derivedAmountCents`.

### `proposal_photos`
`id, proposalId, fileId, sortOrder, caption TEXT NULL, createdAt` — unique `(proposalId, fileId)`.

### `proposal_attachments`
`id, proposalId, fileId, sortOrder, createdAt` — unique `(proposalId, fileId)`. Reference only; never copies bytes.

### Document kinds
Add to both `server/files.ts` `SYSTEM_KINDS` / `server/documents.ts` `KIND_LABELS` and `src/pages/documents/docTypes.ts`:
- `takeoff-print` (PDF), `takeoff-export` (Excel) — visible to non-admins (as `printout` is today); source href → project Takeoffs tab.
- `proposal-signed` — admin-only; source href → proposal editor.
- `company-document` — `DIRECT_UPLOAD_KINDS`, `projectId = null`; listed via existing `unassigned` support.
- `proposal` — unchanged kind, now `sourceType:'proposal', sourceId:<proposalId>` (one live document per proposal, versioned by upsert-by-source). Add `proposal-signed` to `NON_ADMIN_EXCLUDED_KINDS`.
- `printout` kind is retired after migration (label kept in `KIND_LABELS` for safety).

### Removed from `Project`
`printouts[]`, `proposalPhotoIds`, `proposalCoverNotes`, `proposalTerms`, `proposalFileId`, `proposalSentAt` (types + `projectStore.saveProject` cascade for these). `Printout` type removed.

### Per-user history (user prefs, existing `pushHistory`)
`proposal-coverNotes-history`, `proposal-terms-history` (existing), new `proposal-inclusions-history`, `proposal-exclusions-history`, `proposal-manualLine-history` (line library: `{description, amountCents}`, max 10). Option defaults (`font`, `highlightQuality`, `includeCostDetail`, `includeSignature`, `showGrandTotal`) remain per-user prefs used only to seed a **new** proposal; `proposal-priceMode` / `proposal-fixedPrice` prefs are deleted.

## 4. Server

New files: `server/proposalStore.ts` (pattern: `changeOrderStore.ts`), `server/proposalRoutes.ts` (registered from `routes.ts`). All routes `authenticateToken + requireAdmin`.

```
GET    /api/projects/:id/proposals        → ProposalSummary[] (number, revisedFromNumber, status, title, totalCents
                                             (non-alt), alternateCount, hasOverride, validUntil, sentAt, sentTo,
                                             photoCount, attachmentCount, fileId, signedFileId, legacy)
POST   /api/projects/:id/proposals        body { takeoffIds?: string[] } | { revisedFromId, carryPhotos, carryAttachments }
                                            → creates draft (number = MAX+1 in txn), seeds lines / copies source
GET    /api/proposals/:id                 → full Proposal { ...row, lines[], photos[], attachments[] }
PUT    /api/proposals/:id                 body full editable fields + lines[] (replaced wholesale), version
                                            409 if status != draft or version mismatch or legacy
DELETE /api/proposals/:id                 draft only, non-legacy; deletes its generated file
POST   /api/proposals/:id/photos          { fileId } (file already uploaded with kind 'proposal-photo' or picked)
PATCH  /api/proposals/:id/photos/:fileId  { caption?, sortOrder? }
DELETE /api/proposals/:id/photos/:fileId
POST   /api/proposals/:id/attachments     { fileId }        (file must be a PDF mime)
PATCH  /api/proposals/:id/attachments/:fileId { sortOrder }
DELETE /api/proposals/:id/attachments/:fileId
POST   /api/proposals/:id/status          { status: 'accepted'|'declined', signedFileId? }   (from 'sent' only)
POST   /api/proposals/:id/send            SendBody (as today's send-proposal) → on SMTP success sets
                                            status 'sent', sentAt, sentTo; logs activity; broadcasts
```
- Photo/attachment writes allowed only on drafts (except none on sent). `signedFileId` may be set on sent/accepted.
- Takeoff line amounts are computed client-side (`computeTakeoffTotals`, pure) and saved as a snapshot; server validates shape/ints only.
- `deleteDocument` guard extended: refuse deleting a file referenced by `proposal_photos` / `proposal_attachments` / `proposals.fileId|signedFileId`.
- Activity types: `proposal_created`, `proposal_sent`, `proposal_accepted`, `proposal_declined` → link `/project/:pid/proposal/:id`, admin-only.
- Documents resolvers: `proposal` + `proposal-signed` → editor href; `takeoff-print` / `takeoff-export` → the project Takeoffs tab (the same href the Takeoffs sidebar entry uses).
- Realtime: proposals broadcast on the project channel like COs so the list live-refreshes.
- Removed: `POST /api/projects/:id/send-proposal`.

## 5. Client

### Routes / gating
`App.tsx`: `proposal` → `ProposalsList`, `proposal/:proposalId` → `ProposalEditor`. Sidebar + command palette entries admin-only; non-admin navigation redirects to the project overview.

### `src/pages/project/proposal/`
| File | Responsibility |
|---|---|
| `ProposalsList.tsx` | Table (#, rev-of, title, status badge, total, "alternates: N", subtle override dot with tooltip, expiry text on sent rows, sent-to tooltip, created/sent). Actions: New, Revise (ReviseDialog), Open PDF, Send, Accept/Decline (AcceptDialog), Delete draft. Legacy rows: Open PDF + Revise only. |
| `ProposalEditor.tsx` | Loads proposal; owns dirty state, Save / Generate / Send bar; read-only mode when status != draft or legacy. Generate = save draft → render → `persistGeneratedDocument` (kind `proposal`, source `proposal/<id>`) → set `fileId`. |
| `PricingLinesCard.tsx` | Takeoff lines group + Manual lines group, drag reorder within group; per-line description, amount, Alternate toggle; "Add takeoff" (project takeoffs not on a line), "Add manual line" (type-ahead from line library). Takeoff line shows `measurementSummary` + derived amount; editing amount opens confirm "Override $X → $Y for this proposal only?"; overridden shows "overridden (was $X)" + Reset. Grand-total toggle. Totals footer (non-alt total, alternates subtotal). |
| `InclusionsExclusionsCard.tsx` | Two bullet-list editors, each with HistoryMenu. |
| `PaymentScheduleCard.tsx` | "Include payment schedule" checkbox; rows description + (% or $). |
| `ProposalPhotosCard.tsx` | Upload (kind `proposal-photo`, source `proposal/<id>`) + "Choose existing" (FilePickerModal, accept image); caption input under each; reorder/remove. |
| `ProposalAttachmentsCard.tsx` | "Upload PDF" (kind `document`, project-scoped) + "Choose existing" (FilePickerModal, accept pdf); ordered list showing name + page count; remove. |
| `ProposalOptionsCard.tsx` | Title, valid-until, font, include cost detail, signature block, highlight quality. |
| `ReviseDialog.tsx`, `AcceptDialog.tsx` | As decided. AcceptDialog: optional signed copy (upload/pick) + "Prefill SOV from N lines?" → yes writes one SOV line per non-alternate line via existing SOV save; no does nothing. |
| `proposalGenerator.ts` | Refactored signature `generateProposalPdf(proposal, project, settings, assets, onProgress)`; existing pure helpers kept. |
| `proposalPdfSections/*.ts` (optional split) | cover, pricing tables, alternates, inclusions, notes, terms, photos, attachments append. |

Delete `ProjectProposal.tsx`.

### Shared `src/components/FilePickerModal.tsx`
Props `{ open, accept?: 'pdf'|'image'|'any', multi?: boolean, excludeFileIds?: string[], initialFilters?, onPick(files: DocumentRow[]), onClose }`. Composes `DocumentsFilterBar` + document row list + hover preview from the Documents page; uses `getDocuments`. `accept` maps to kind/mime filtering server-side (`GET /api/documents` gains a `mimes` filter).

### Takeoffs tab (`ProjectTakeoffsTab.tsx` / `ProjectView.tsx`)
- Proposal button: `POST /api/projects/:id/proposals { takeoffIds: [...selected] }` → `navigate(/project/:id/proposal/:newId)`. Disabled/hidden for non-admins.
- Print → `takeoff-print`, Excel → `takeoff-export`, names per §2, then `navigate('/documents?projectIds=<id>&kinds=takeoff-print,takeoff-export')`.
- "Takeoff prints" link to the same URL, always visible.

### Dashboard
Admin-only "Outstanding proposals" card: status `sent`, sorted by `validUntil` asc (expired flagged), link to editor. Backed by `GET /api/proposals/outstanding` (admin; registered before `/api/proposals/:id`).

### Documents page
`docTypes.ts` adds the four kinds (labels/tones); `company-document` in `DIRECT_UPLOAD_KINDS`; upload modal allows no-project when kind is `company-document`.

## 6. PDF layout

jsPDF body + pdf-lib merges, Letter portrait, letterhead on generated pages.

1. Cover — letterhead, title, customer/address, date, valid-until. No number.
2. Pricing (continues from cover if room):
   - **Takeoff pricing** table: description / measurement summary / amount.
   - **Additional pricing** table: manual lines.
   - **Grand total** box (if `showGrandTotal`) — sum of non-alternate lines, immediately after the tables.
   - Payment schedule table (if `paymentSchedule` non-null), under the grand total.
3. Inclusions / Exclusions — two columns of bullets (omitted when both empty).
4. Notes — free-flowing across pages.
5. Alternates page (only if any alternate line) — "Alternates" heading, takeoff / additional split, subtotal each, no grand total.
6. Cost detail (if enabled) — takeoff lines only.
7. Terms + signature block (if enabled).
8. Photos — 2-up grid, caption under each when present.
9. Page numbers on 1–8.
10. Highlights merge (existing) → Attachments: each attachment's pages via pdf-lib `copyPages`, untouched.
11. Email-quality shrink if selected (attachments count toward the 18 MB budget).

Overridden amounts print as plain amounts.

## 7. Migration 28 (data-transforming, supervised, non-destructive)

1. Create the four tables (§3).
2. For every project row, parse `meta`:
   - `printouts[]` entries whose file row `kind='proposal'` **or** whose name starts with `Proposal` → one `proposals` row each, ordered by `createdAt` (numbers 1..n), `legacy=1`, `status='sent'` + `sentAt=proposalSentAt` when `fileId === proposalFileId`, else `status='draft'`; `coverNotes/terms` copied from the project; the file row's `sourceType/sourceId` re-pointed to `proposal/<newId>`; `proposals.fileId` set.
   - `proposalPhotoIds[]` → `proposal_photos` on the **latest** legacy proposal (or dropped to unassigned `proposal-photo` files if the project has none).
   - Remaining `printouts[]`: `type='excel'` → file `kind='takeoff-export'`; else → `kind='takeoff-print'`; file `name` rewritten to `Takeoff Print – <project> – <YYYY-MM-DD>` from the entry's `createdAt`; `sourceType='takeoff-print'`, `sourceId` = original printout id.
   - Strip the six legacy keys from `meta`.
3. Log counts per step; idempotent (skips projects with no legacy keys). Files/bytes untouched; standard backup before pull per the migration protocol.

## 8. Edge cases

- Takeoff deleted → line keeps snapshot; editor flags "takeoff no longer exists" with Remove.
- Takeoff changed while draft → on editor load, non-overridden takeoff lines re-derive; overridden keep amount, "was $X" updates. Sent never re-derives.
- File referenced by a proposal cannot be deleted (server guard); archived files still render.
- Version conflict on PUT → 409 → reload toast.
- Send: status flips only after SMTP success.
- Revise from a draft allowed. Legacy proposals: read-only, Revise allowed.
- Generate always saves the draft first.
- Non-admin → page redirect + API 403.

## 9. Testing

- Vitest server: `proposalStore.test.ts` (numbering, revise/carry, lock 409s, delete guards, cascade), `proposalRoutes.test.ts` (auth, send flips status only on success, status transitions), `migrationList.test.ts` (28 against seeded legacy project: proposals, photos, prints relabeled, meta stripped, idempotent), `documents.test.ts` (new kinds, visibility, `mimes` filter, source hrefs).
- Vitest ui: generator (grouping, alternates, grand-total excludes alternates, payment schedule, attachment append page counts), `PricingLinesCard.test.tsx` (override confirm/indicator/reset, alternate toggle), `FilePickerModal.test.tsx`, `ReviseDialog`/`AcceptDialog`.
- Playwright: update `export.spec.ts` + `documents.spec.ts`; new `proposal.spec.ts` (select takeoffs → Proposal → seeded editor → manual + alternate line → generate → list → revise carries photos → send locks).
- Manual: PDF eyeball, SMTP send, migration on a copy of testing data (supervised).

## 10. Out of scope

Customer e-signature, proposal templates beyond per-user history, linking payment schedule to billing, captions on other document types.
