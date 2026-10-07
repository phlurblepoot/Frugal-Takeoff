# Payment Attachments and the Payment Detail View — Design

Date: 2026-10-06
Status: Approved by Nathan (conversation)

## Problem

"Add photo attachments to payments." A payment (Billing → Payments) is a row
of date, amount, method and note against an invoice or a pay application.
There is nowhere to keep the evidence that comes with it — the check, the
receipt, the remittance advice, the ACH confirmation — and a payment recorded
with a typo can only be deleted and recorded again.

## Decisions (agreed with Nathan)

- **What can be attached:** photos AND PDFs (check images, receipts, remittance
  advice, ACH confirmations). Nothing else.
- **When:** while recording a payment (in the existing record form), and
  afterwards from the payment itself.
- **Payment detail view:** clicking a payment row opens it — its attachments
  (view, add more, remove) and its date, amount, method and note, which can now
  be **edited**, and a Delete.
- **Where they show:** ONLY on the payment. Not in the invoice editor's
  payment list, not on invoice/pay app PDFs or their emails, not in any report.
- **Implementer's calls (from existing behaviour):**
  - *Who sees them:* billing is admin-only, and a check image carries the
    customer's bank details, so the new file kind is admin-only everywhere the
    billing kinds already are (Documents, by-source lookups, PATCH/DELETE on
    files, shares, the document editor).
  - *What an edit changes:* the target (what the payment paid) is fixed —
    paying a different record is a delete and a new payment. An omitted or
    empty date keeps the stored one.
  - *Out-of-date rule:* the invoice PDF prints Paid and Balance, which come
    from the amounts alone, so an **amount** edit stamps the target's
    `updatedAt` exactly as recording/deleting a payment does. A date, method or
    note fix leaves its PDF current — the same reasoning as `saveInvoice`'s
    notes-only exemption. Attachments never touch the target.
  - *Removing an attachment* unlinks it; the file stays in Documents (admin
    only), as a record's removed photo does. Deleting a payment likewise
    removes its attachment rows, not the files.
  - *Phone camera:* no `capture` attribute, as `PhotoDropCard`: the native
    picker for `image/*,application/pdf` offers the camera as one source
    without skipping the photo library and files.
  - *No reordering:* attachments keep the order they were added in; nothing
    consumes an order, so there is no PATCH.

## Design

**Migration 43 (`payment-attachments`, additive):** `payment_attachments
(id, paymentId, fileId, sortOrder, createdAt, UNIQUE(paymentId, fileId))` and
`idx_payment_attachments_payment`. One table for photos and PDFs — the file's
mime tells them apart. Existing payments simply have none.

**File kind `payment-attachment`** (files uploaded from a payment): in
`SYSTEM_KINDS`, `MULTI_INSTANCE_KINDS` (a payment holds many, so a second
upload must not become a version of the first) and `NON_ADMIN_EXCLUDED_KINDS`.
Uploaded with the project the payment's target belongs to, `sourceType
'payment'`, `sourceId` = the payment. Labelled "Payment Attachment" (server
`KIND_LABELS`, client `docTypes`); its Documents source reads "Payment —
Invoice #1001" / "Payment — Pay App #3" and links to
`/project/:id/billing?tab=payments&open=<paymentId>`, which opens that payment.
A file picked from Documents is only linked, keeping its own kind.

**Server (`billingStore`):**

- `getPayment(id)` — the payment, `targetLabel`, `projectId` (resolved
  through the target; payments have no column of their own) and
  `attachments` joined to `files` for name/mime/size/kind/createdAt/
  versionNumber (nulls for a file deleted since).
- `updatePayment(id, {date, amount, method, note})` — validated like
  `recordPayment` (amount finite and > 0; a date, when given, a timestamp);
  blank method/note → NULL; stamps the target only when the amount's cents
  change.
- `addPaymentAttachment` (payment and file must exist; `image/*` or
  `application/pdf` only; re-adding is a no-op; appends at max sortOrder + 1)
  and `removePaymentAttachment` (no-op if not attached; NotFound for an unknown
  payment).
- `listProjectPayments` adds `attachmentCount`; `paymentProjectId(id)`.
- `deletePayment`, `deleteInvoice`, `aiaStore.deletePayApp` and
  `deleteProject` delete the attachment rows before the payments.

**Routes (all `requireAdmin`, errors through `billingErr`):**
`GET /api/payments/:id` (404 unknown), `PUT /api/payments/:id`,
`POST /api/payments/:id/attachments {fileId}`,
`DELETE /api/payments/:id/attachments/:fileId`. Each mutation broadcasts
`{type: 'payment', action: 'updated'}` with the resolved projectId, as the
delete already did (now via `paymentProjectId`). `payment_attachments` joins
storage cleanup's `FILE_ID_COLUMNS`.

**Client:**

- Shared picker: a new `accept` value `'image-pdf'` (`useDropZone`,
  `FilePickerModal`'s mime filter and input accept, `AddFilesButton`), and
  `onPickFiles` on `FilePickerModal`/`AddFilesButton` — the Upload tab hands
  the chosen files back **unstored**, for a record that doesn't exist yet.
- `store.ts`: `PaymentAttachment`, `PaymentDetail`, `attachmentCount` on
  `Payment`; `getPayment`, `updatePayment`, `addPaymentAttachment`,
  `removePaymentAttachment`; `recordPayment` returns `{ id }`.
- `PaymentsSection`: refreshes live (`useLiveQuery` on payment, invoice and
  pay app changes). Under the record form, **Attach** (`AddFilesButton`,
  photos or PDFs, Upload tab first) and a drop zone stage files as removable
  chips; Record creates the payment, then uploads each staged file under it
  (`payment-attachment`, source = the new payment) and links it — and links a
  document picked from the Existing tab. A partial failure says how many made
  it (the payment is already recorded). Rows open the detail view (the delete
  button doesn't), show a paperclip + count when there are attachments, and
  print the method's label. `?open=<id>` opens a payment.
- `PaymentDetailModal`: "Applied to" (read-only), editable date / amount /
  method / note with Save and Cancel (both idle until something changed; a
  method stored some other way stays selectable), Delete payment (confirm),
  and the attachments — photo thumbnails opening the `Lightbox`, PDFs by name
  and size opening the document viewer, **Add photos or PDFs** (shared picker,
  Upload tab first, filed under the payment) plus drag-and-drop, and remove
  (confirm). It follows the change feed for its own payment: a refresh lands
  in a pristine form but never overwrites an edit in progress, and a payment
  deleted elsewhere closes it with a note.
- The invoice editor's read-only payment list is unchanged.

## Tests

- `server/migrationList.test.ts`: migration 43 adds the table to a v42
  database with the attachment-table columns, UNIQUE per payment, replay is a
  no-op; the index is on paymentId; existing payments untouched.
- `server/billingStore.test.ts`: `getPayment` (invoice and pay app targets,
  unknown → null); photos and PDFs attach in order, idempotently; other types /
  unknown file / blank fileId / unknown payment refused; remove (and no-op);
  attachments never touch the target; `attachmentCount`; `updatePayment`
  edits, keeps omitted fields, normalizes blanks, validates, 404s, stamps the
  target (invoice and pay app) only on an amount change; deleting the payment,
  its invoice or its pay app removes the rows but not the files.
- `server/routes.test.ts`: every payment route 403s for members; GET 200/404
  with attachments and the list's count; PUT edits + broadcasts, 400/404
  broadcast nothing; attachment POST/DELETE broadcast, 400 (no fileId, wrong
  type) / 404 (unknown payment or file); DELETE removes the rows and
  broadcasts with the project; orphan cleanup spares a file only
  `payment_attachments` names; project delete removes the rows.
  `routes.changefeed.test.ts`: PUT and attachment changes reach the feed with
  the target's projectId.
- `server/documents.test.ts`: payment attachments hidden from non-admins
  (list, by-source, PATCH/DELETE); source label + `?open=` link for invoice and
  pay app payments, generic label for a deleted one. `server/files.test.ts`: a
  photo and a PDF on one payment are two documents.
- Client: `useDropZone`, `FilePickerModal` (mime filter; `onPickFiles` stages
  picks and drops without storing; Existing tab unchanged), `AddFilesButton`
  pass-through, `docTypes` label;
  `PaymentsSection.test.tsx` (paperclip counts, row opens the view, delete
  doesn't, `?open=`, picker config, staging and removing, record then upload +
  link, drop staging, nothing staged, failed record keeps the chips, partial
  failure); `PaymentDetailModal.test.tsx` (fields, Save/Cancel, untouched date
  sent as stored, validation, odd methods, delete with/without confirm,
  deleted elsewhere, thumbnails/Lightbox/viewer, picker config, drop upload,
  remove with/without confirm, missing file, live refresh vs. an edit in
  progress).
