# PDF Attachments on Change Orders, RFIs, Issues and Daily Reports — Design

Date: 2026-10-06
Status: Approved by Nathan (conversation)

## Problem

"Allow adding PDF files as attachments/pages to CORs & similar items."
Invoices already carry PDF attachments (migration 34): picked or uploaded in
the editor, reordered, and appended to the end of the generated invoice. Change
orders, RFIs, issues and daily reports have photos but no way to send a spec
sheet, a sketch or a quote along with the document.

## Decisions (agreed with Nathan)

- **Which records:** change orders, RFIs, issues and daily reports all get PDF
  attachments, working exactly like the invoice's.
- **Page order in the generated PDF:** the record's own pages, then its photo
  pages, then each attached PDF's pages in attachment order (as invoices).
- **Email:** sending emails the generated PDF, so the attached pages ride along
  automatically. Every send path attaches the stored document built by the same
  `build()` (DocumentActionsBar reuses the stored file only when it is current,
  otherwise rebuilds), so there is no second path to change.
- **RFIs:** the GC's response file (`rfis.responseFileId`) is not an
  attachment and stays as it is.
- **Out-of-date rule (implementer's call, from existing behaviour):** an
  attachment change marks the record's generated PDF out of date the same way
  that record's photo changes do. Change orders bump version + updatedAt, like
  invoices. RFIs, issues and daily reports stamp `updatedAt` only — the clock
  the "up to date" chip and Send's reuse check compare against — and leave
  `version` alone, because their photo routes deliberately broadcast without a
  version so a dirty editor elsewhere isn't pushed into a 409.

## Design

**Migration 42 (`pdf-attachments`, additive):** four tables shaped like
`invoice_attachments` — `(id, <owner>, fileId, sortOrder, createdAt)` with
`UNIQUE(<owner>, fileId)` and an owner index:
`change_order_attachments(changeOrderId)`, `rfi_attachments(rfiId)`,
`issue_attachments(issueId)`, `daily_report_attachments(dailyReportId)` — the
same owner column as each record's photo table.

**Server — one implementation, `server/pdfAttachments.ts`:**
`listPdfAttachments` (joined to `files` for name/mime/size, ordered by
sortOrder), `addPdfAttachment` (record must exist, file must exist and be
`application/pdf`, re-adding is a no-op, appends at max sortOrder + 1),
`updatePdfAttachment` (integer sortOrder; 404 if not attached),
`removePdfAttachment`. Each store passes a `PdfAttachmentTable`: its table,
owner column, error classes (so each route's error mapper still applies) and a
`touch` that marks the PDF out of date. The invoice now uses it too.

- `billingStore`: `add/update/removeChangeOrderAttachment`; `getChangeOrder`
  returns `attachments`; `deleteChangeOrder` removes the rows.
- `rfiStore`, `issueStore`, `dailyReportStore`: `add/update/removeAttachment`;
  `getRfi`/`getIssue`/`getDailyReport` return `attachments`; each delete
  removes the rows.
- `deleteProject` deletes the four tables' rows before their records.
- Routes, mirroring the invoice's: `POST /api/<items>/:id/attachments {fileId}`,
  `PATCH …/attachments/:fileId {sortOrder}`, `DELETE …/attachments/:fileId` for
  `change-orders` (admin, like its photos; broadcasts the new version), `rfis`,
  `issues` and `daily-reports` (any signed-in user, like their photos;
  broadcast without a version).
- Storage cleanup's `FILE_ID_COLUMNS` lists the four tables, so an attached
  PDF filed under another project (or none) is never cleaned up as an orphan.

**Client:**

- `store.ts`: one `PdfAttachment` type (replaces `InvoiceAttachment`);
  `attachments` on `ChangeOrder`, `Rfi`, `Issue`, `DailyReport`; API functions
  `add/update/removeCOAttachment`, `…RfiAttachment`, `…IssueAttachment`,
  `…DailyReportAttachment`.
- `src/components/documents/PdfAttachmentsCard.tsx`: the invoice editor's
  attachments section lifted out unchanged — Add PDFs (shared picker, Upload
  tab first, all projects, filed as a project document), move up/down (two
  sequential sortOrder swaps, then resync), remove — plus `disabled`. The
  invoice, change order, issue, RFI and daily report editors mount it under
  their photos; RFI and daily report pass the same "Save your changes first"
  gate their photo card has.
- `src/utils/pdfAttachments.ts`: `appendPdfAttachments` (moved from
  `invoicePdf.ts`; skips a PDF that won't parse) and `appendAttachedPdfs`
  (fetches each attachment, skips one that won't load). All five editors'
  `build()` call it last, on the SAVED record's attachments.

## Tests

- `server/migrationList.test.ts`: migration 42 adds the four tables to a v41
  database with the invoice table's columns, UNIQUE per record, replay is a
  no-op; each index is on its owner column.
- Store tests (`billingStore`, `rfiStore`, `issueStore`, `dailyReportStore`):
  PDF-only / unknown file / unknown record / blank fileId refused; idempotent
  add in order; reorder; remove; change order bumps version + updatedAt, the
  field records updatedAt only; delete removes the rows; RFI attachments are
  separate from the response file.
- Routes (`routes.test.ts`, `routes.dailyReports.test.ts`,
  `routes.changefeed.test.ts`): change orders 403 for members and broadcast the
  bumped version; RFIs, issues and daily reports work for members and broadcast
  without a version; 400/404 cases; orphan cleanup spares files only these
  tables name; project delete removes the rows.
- `src/utils/pdfAttachments.test.ts`: pages merged after the base (including a
  jsPDF ArrayBuffer base with its photo page) in order; unreadable or
  unfetchable files skipped.
- `PdfAttachmentsCard.test.tsx`: order and sizes, empty state, picker adds,
  partial failure, reorder (and its failure), remove (and its failure),
  disabled.
- Editor tests (invoice, change order, RFI, issue, daily report): the card adds
  and removes through the record's API; `build()` appends the saved record's
  attachments to its own bytes and stores the result, and Send mails that file;
  RFI/daily refuse additions while dirty.
- E2E (`e2e/document-actions.spec.ts`): upload a 2-page PDF on an issue →
  generate → the stored report ends with those two pages → remove it → "PDF out
  of date".
