# Phase 9 — Change Order Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make Change Orders work like Invoices — an editor modal with line items, a description, photo attachments, a generated "Change Order Request" PDF (photos appended as pages), and email send — while preserving the existing contract-total and AIA SOV-sync behavior.

**Decisions (from Nathan):**
- CO total = Σ line items + a lump-sum amount (added together; no mode switch). Description is narrative text.
- Add: auto CO number (CO-001…, manual override), schedule impact (days), signature/acceptance block on the PDF. (No markup/O&P.)
- Lifecycle: Draft → Sent → Approved → Rejected. Only `approved` counts toward the contract total (unchanged).

**Architecture:** Mirror the invoice stack exactly. `change_orders` gains line items (a new `change_order_lines` table, like `invoice_lines`), photos (a new `change_order_photos` table, like `issue_photos`), a `version` column (optimistic concurrency), and new fields (lumpSumAmount, scheduleImpactDays, date). The canonical persisted total stays in `change_orders.amount` (dollars), written server-side on save = (Σ line cents + lump-sum cents)/100, so the existing `billingSummary` contract-total sum and `aiaStore.syncChangeOrders` (both read `amount`) keep working untouched. PDF is built client-side with jsPDF (new `changeOrderPdf.ts`, copying `invoicePdf.ts` + the issue-PDF photo-append loop). Send is the existing two-step flow (upload PDF → `POST /api/change-orders/:id/send` → `sendProjectEmail` SMTP attach).

**Tech Stack:** Express 4 + better-sqlite3 (versioned migrations), React 19, jsPDF, the `src/components/ui` library, integer-cents money math.

**SAFETY INVARIANT:** `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build` green after every task. NO change to how the contract total or AIA SOV sync are computed (they keep reading `change_orders.amount`). Migration v14 is PURELY ADDITIVE (new tables + new columns with defaults; NO UPDATE/data rewrite). Legacy `status='pending'` rows remain valid and render as draft-equivalent.

**Reference (current code, from the 2026-06-14 exploration):**
- Invoice template to copy: `src/pages/project/billing/InvoiceEditor.tsx` (modal, lines, `lineCents`/`draftTotalCents`, save/download/send), `src/pages/project/billing/InvoicesSection.tsx` (list + create→getById→edit), `src/pages/project/billing/invoicePdf.ts` (jsPDF, `buildInvoicePdf(ctx): Uint8Array`, `resolveAccentRgb()`), invoice routes `POST /api/invoices/:id/send` + `sendProjectEmail` in `server.ts:480`.
- Invoice storage: `invoices` + `invoice_lines` tables (migration v8, `migrationList.ts:292-312`), `billingStore.ts` (`toCents`, `sumCents`, `lineTotalsCents`, DELETE+INSERT lines, version concurrency).
- Photo pattern to copy: `issue_photos` table (migration v9, `migrationList.ts:360-367`), `server/issueStore.ts:83-95` (addPhoto/removePhoto), `IssueEditor.tsx:26-69` (upload→link→build bytes), `src/pages/project/issues/issuePdf.ts:68-79` (photo-append loop), routes `POST /api/issues/:id/photos`.
- CO today: `change_orders` table (migration v8, `migrationList.ts:325-334`: id, projectId, number TEXT, description TEXT, amount REAL, status TEXT, createdAt — NO version, NO lines/photos, only a status-PATCH endpoint). `billingStore.ts` listChangeOrders/createChangeOrder/setChangeOrderStatus/deleteChangeOrder; `CHANGE_ORDER_STATUSES` at `billingStore.ts:10`. Contract total: `billingSummary` sums `amount WHERE status='approved'` via `toCents`. SOV sync: `aiaStore.ts:134-168` reads approved COs' `amount`, inserts one SOV line `scheduledValueCents=round(amount*100)`, `itemNo='CO-'+number`, keyed on `changeOrderId`. Latest migration = **v13**; next = **v14**. Routes admin-gated in `server/routes.ts:252-272`.
- Client CO store: `src/utils/store.ts` ChangeOrder type (~679), getChangeOrders/createChangeOrder/setChangeOrderStatus/deleteChangeOrder (~751-764), syncChangeOrders (~1035).
- Pills: `src/components/ui/BillingPills.tsx` ChangeOrderStatusPill.

---

## Task 1: Data layer — migration v14, server store, routes

**Files:** `server/migrationList.ts`, `server/billingStore.ts`, `server/routes.ts`, `server/billingStore.test.ts` (or the existing CO test file). Use an **opus** implementer (money + concurrency + downstream invariants) and an **opus** reviewer.

- [ ] **Step 1 — Migration v14 (additive only).** Append a migration `{ version: 14, name: 'change-order-line-items-photos', ... }` to `migrationList.ts` that:
  - `ALTER TABLE change_orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1;`
  - `ALTER TABLE change_orders ADD COLUMN lumpSumAmount REAL NOT NULL DEFAULT 0;` (dollars)
  - `ALTER TABLE change_orders ADD COLUMN scheduleImpactDays INTEGER;` (nullable)
  - `ALTER TABLE change_orders ADD COLUMN date INTEGER;` (nullable epoch ms)
  - Create `change_order_lines (id TEXT PRIMARY KEY, changeOrderId TEXT NOT NULL, description TEXT, qty REAL NOT NULL DEFAULT 1, unitPrice REAL NOT NULL DEFAULT 0, sortOrder INTEGER NOT NULL DEFAULT 0)` + `CREATE INDEX idx_change_order_lines_changeOrderId ON change_order_lines (changeOrderId);` (mirror `invoice_lines`).
  - Create `change_order_photos (id TEXT PRIMARY KEY, changeOrderId TEXT NOT NULL, fileId TEXT NOT NULL, sortOrder INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL)` + index on changeOrderId (mirror `issue_photos`).
  - NO `UPDATE` statements. Existing `amount`/`status` columns untouched. (Each `ALTER ... ADD COLUMN` is one statement; follow how prior migrations run multiple statements — see how v12/v13 are written.)
- [ ] **Step 2 — `CHANGE_ORDER_STATUSES`.** Change `billingStore.ts:10` to `['draft','sent','approved','rejected']`. Keep `'pending'` accepted as a legacy-tolerant read (do NOT reject reads of pending rows; only the new transitions use the new set). New COs default to `'draft'` (createChangeOrder).
- [ ] **Step 3 — Server store functions** in `billingStore.ts`, mirroring the invoice equivalents:
  - `getChangeOrder(db, id)` → `{ ...co_row, lines: COLine[], photos: {id,fileId,sortOrder}[], totalCents, lumpSumCents }`. `lineTotalsCents` = `sumCents(lines)`; `totalCents = sumCents(lines) + toCents(co.lumpSumAmount)`. (Reuse the invoice `toCents`/`sumCents`.)
  - Extend `listChangeOrders` to also return `totalCents` per row (so the list shows the real total, = lines + lump sum), not just `amount`.
  - `createChangeOrder(db, projectId, input)` → inserts a draft: auto-assign `number` = next sequence per project (max integer parsed from existing `change_orders.number` for this project, +1, zero-padded to 3 e.g. `'001'`; if input.number provided, use it). status `'draft'`, version 1, amount 0. Return `{ id, version }`.
  - `saveChangeOrder(db, id, input, expectedVersion)` → **version-checked** (throw a 409 conflict the route maps, like `saveInvoice`). Updates number/date/description/lumpSumAmount/scheduleImpactDays; replaces `change_order_lines` (DELETE+INSERT with sortOrder by index); recomputes and writes `amount` = `(sumCents(lines) + toCents(lumpSumAmount)) / 100` (dollars — exact for integer cents); bumps `version`. Status is NOT changed here (separate PATCH). Return `{ version }`.
  - `setChangeOrderStatus(db, id, status)` → validate against the new set; bump `version`.
  - `addChangeOrderPhoto(db, coId, fileId)` / `removeChangeOrderPhoto(db, coId, fileId)` (mirror `issueStore` addPhoto/removePhoto; idempotent insert; bump CO version on photo change so the editor re-key stays correct — match how issues handle it, but a version bump is safest).
  - `deleteChangeOrder(db, id)` → delete `change_order_lines` + `change_order_photos` for the CO, then the CO row. ALSO delete the synced AIA SOV line for this CO: `DELETE FROM aia_sov_lines WHERE changeOrderId = ?` (prevents an orphan SOV line — a correctness improvement; note it in the report). Photos' underlying `files` rows: leave as-is (matches issues/invoices behavior; project delete handles file cleanup).
- [ ] **Step 4 — `ChangeOrderInput` type** in `billingStore.ts`: `{ number?, date?, description?, lumpSumAmount?, scheduleImpactDays?, lines?: {description, qty, unitPrice}[] }`.
- [ ] **Step 5 — Routes** in `server/routes.ts` (all `authenticateToken, requireAdmin`, in the billing block):
  - `GET /api/change-orders/:id` → `getChangeOrder` (NEW single-fetch).
  - `PUT /api/change-orders/:id` → `saveChangeOrder` with `If-Match`/body `version`; map conflict to **409** with `{ error, code:'version_conflict' }` (copy the invoice PUT handler exactly).
  - `POST /api/change-orders/:id/photos` `{ fileId }` → addChangeOrderPhoto; `DELETE /api/change-orders/:id/photos/:fileId` → removeChangeOrderPhoto.
  - `POST /api/change-orders/:id/send` `{ to, fileId }` → call `sendProjectEmail({ to, subject: 'Change Order Request ' + number, text: message ?? 'Please find the attached change order request.', fileId, attachmentName: 'CO-' + number + '.pdf' })`; then best-effort `setChangeOrderStatus(db, id, 'sent')` (only if not already approved/rejected); `logActivity('change_order_sent')`. (Copy `POST /api/invoices/:id/send`.)
  - Keep existing GET list, POST create, PATCH status, DELETE. Ensure PATCH still maps the new status set.
- [ ] **Step 6 — Tests** (`server/billingStore.test.ts` or the CO test file): CO total = Σ lines + lump sum (with the qty×unitPrice round-per-line rule); `amount` persisted equals totalCents/100 and `round(amount*100) === totalCents` (so contract total + SOV sync stay exact); version increments + a stale-version save throws conflict; auto-number sequence (001, 002, …, and override); status validation accepts new set + tolerates reading legacy `'pending'`; deleteChangeOrder removes lines/photos/SOV line. Run the FULL `npm test` (schema change — per the Phase 7b lesson, run everything, not just the touched file; watch verify-migration FK checks for the new tables — add the change_order_lines/photos FK relations if that tool enumerates tables).
- [ ] **Step 7:** gates green. Commit `feat: change order line items + photos + versioned edit (migration 14, server)`.

---

## Task 2: Client store + Change Order Request PDF

**Files:** `src/utils/store.ts`, `src/pages/project/billing/changeOrderPdf.ts` (new), `src/pages/project/billing/changeOrderPdf.test.ts` (new).

- [ ] **Step 1 — Client store** (`src/utils/store.ts`), mirroring the invoice helpers:
  - Types: `ChangeOrderLine { id?: string; description: string; qty: number; unitPrice: number }`; `COPhoto { id: string; fileId: string; sortOrder: number }`; extend `ChangeOrder` to a full type `{ id, projectId, number, date, description, lumpSumAmount, scheduleImpactDays, status, version, createdAt, lines: ChangeOrderLine[], photos: COPhoto[], totalCents, lumpSumCents }`; a `ChangeOrderListItem` (no lines/photos, includes totalCents); `ChangeOrderInput`.
  - Functions: `getChangeOrder(id)` (GET single); `saveChangeOrder(id, input)` (PUT, throw `ConflictError` on 409 — copy `saveInvoice`); `createChangeOrder(projectId, input?)` (returns `{id,version}`); `setChangeOrderStatus(id, status)`; `deleteChangeOrder(id)`; `addCOPhoto(coId, fileId)`; `removeCOPhoto(coId, fileId)`; `sendChangeOrder(id, { to, fileId, message? })`. Keep `getChangeOrders(projectId)` (list) and `syncChangeOrders`.
- [ ] **Step 2 — PDF engine** `changeOrderPdf.ts`: copy `invoicePdf.ts` structure. `buildChangeOrderPdf(ctx: ChangeOrderPdfContext): Uint8Array` where ctx = `{ changeOrder, projectName, contractor?, address?, company:{name,address?,phone?,email?,logoDataUrl?}, accentRgb?, photoDataUrls: string[] }`. jsPDF letter/portrait/pt. Sections in order:
  1. Header: logo + company (left), title **"CHANGE ORDER REQUEST"** in accent (right), then No (`CO-`+number) / Date / Schedule impact (`+N days` if set).
  2. Bill To: contractor / projectName / address.
  3. Description block (narrative text, wrapped, if present).
  4. Line-item table (DESCRIPTION | QTY | UNIT | AMOUNT) if any lines — reuse the invoice row helper shape.
  5. Lump sum line (if `lumpSumCents > 0`): a labeled row.
  6. Total (bold): `formatMoney(totalCents)`.
  7. **Signature/acceptance block**: "Accepted by (Owner): ____  Date: ____" and "Submitted by (Contractor): ____  Date: ____" lines.
  8. **Photos appended as pages**: copy the `issuePdf.ts:68-79` loop — 2-up grid, `cellH≈150pt`, `doc.addImage(url,'JPEG',x,y,cellW,cellH,undefined,'FAST')` in try/catch, `doc.addPage()` overflow. (Photos start on a fresh page after the signature block.)
  Return `doc.output('arraybuffer') as unknown as Uint8Array`. Export pure helpers (`coRows(lines)`, `coTotalsBlock(...)`) for unit tests, like `invoiceRows`/`invoiceTotalsBlock`.
- [ ] **Step 3 — Tests** `changeOrderPdf.test.ts`: the pure helpers — row mapping (desc/qty/unit/amount strings), totals block reflects lines + lump sum, schedule-impact formatting. (Don't render jsPDF in tests; test the helpers, like `invoicePdf.test.ts`.)
- [ ] **Step 4:** gates green. Commit `feat: change order request PDF engine + client store helpers`.

---

## Task 3: UI — ChangeOrderEditor modal + ChangeOrdersSection rework

**Files:** `src/pages/project/billing/ChangeOrderEditor.tsx` (new), `src/pages/project/billing/ChangeOrdersSection.tsx` (rework).

- [ ] **Step 1 — ChangeOrderEditor.tsx** (copy `InvoiceEditor.tsx` and extend). Props `{ changeOrder, onClose, onSaved, projectName, contractor, address, projectId }`. Draft state: number, date, description (textarea), lines (ChangeOrderLine[]), lumpSumAmount (number), scheduleImpactDays (number). Layout:
  - Header fields: CO number (text), date (date input), schedule impact days (number).
  - Description: a `<Textarea>` (narrative).
  - Line items: the invoice table (description/qty/unit price/computed amount via `lineCents`) + "Add line".
  - Lump sum: a labeled money `<Input>` (the description's lump-sum amount).
  - **Total** display = `draftTotalCents(lines) + Math.round((lumpSumAmount||0)*100)` (reuse `lineCents`/`draftTotalCents` from InvoiceEditor — import them; do NOT duplicate the math).
  - Photos: a photo upload control + thumbnail grid reusing the Issues pattern (`uploadProjectFile(projectId, f, 'change-order')` → `addCOPhoto(co.id, fileId)` → reload), with the **touch-friendly delete** affordance from Phase 8 (`opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100`, ≥40px). Thumbnails via `getImageUrl(fileId)`.
  - Footer: Close / Download PDF / Save change order (version-checked save → on 409 show "Change order changed elsewhere — reopen it"). PDF build mirrors `InvoiceEditor.buildBytes()` (fetch settings logo/company, `resolveAccentRgb()`, fetch each photo via `fetchFileBlob`→dataURL, call `buildChangeOrderPdf`).
  - Send panel: email `<Input>` + "Send request" → buildBytes → `uploadProjectFile(projectId, file, 'change-order')` → `sendChangeOrder(co.id, { to, fileId })` → onSaved.
  - Status + Approve/Reject controls: show the current status pill; provide Approve / Reject buttons (call `setChangeOrderStatus`) — since lifecycle is draft→sent→approved/rejected and only approved affects the contract total. Re-key the editor on `${co.id}:${co.version}` like the invoice editor.
- [ ] **Step 2 — ChangeOrdersSection.tsx rework** to mirror `InvoicesSection.tsx`: a list + a "New change order" button that `createChangeOrder(projectId)` → `getChangeOrder(id)` → opens the editor. List columns: Number (CO-###) | Status (ChangeOrderStatusPill) | Amount (totalCents) | Date | actions (open, delete-with-confirm). Keep `onChange={reloadSummary}` firing after every mutation (create/save/status/delete/send) so the contract total stays current. Remove the old inline create form (number/desc/amount) — creation now happens through the editor. Approve/Reject can stay as quick list actions too (optional) but must also be in the editor.
- [ ] **Step 3 — Pills:** ensure `ChangeOrderStatusPill` (`BillingPills.tsx`) handles `draft` (gray) and `sent` (blue) in addition to approved/rejected, and renders legacy `pending` as a gray "Draft"/"Pending" pill (tolerant).
- [ ] **Step 4:** gates green. (Manual: create a CO → add lines + lump sum + description + photos → total = lines+lump → Download PDF shows "Change Order Request" with photos appended → Send → status Sent → Approve → contract total includes it → "Sync change orders" in SOV still creates the CO line.) Commit `feat: change order editor modal (line items, description, lump sum, photos, PDF, send)`.

---

## Task 4: Verify + push + memory

- [ ] **Step 1:** Full gates: `npx tsc --noEmit && npm run lint && npm test && npm run build`.
- [ ] **Step 2:** Final review (opus): confirm the contract-total + AIA SOV sync are unchanged (still read `change_orders.amount`, which now equals lines+lump rolled up); `round(amount*100)===totalCents` so no cents drift in the contract total or the synced SOV line; version concurrency works; migration v14 is additive-only; admin gating intact on all new routes; PDF titled "Change Order Request" with photos appended; no duplicated money math (editor imports `lineCents`/`draftTotalCents`). Fix any issue.
- [ ] **Step 3:** Push to `testing`. ⚠️ **Flag migration 14 to Nathan before he pulls** (per the migration protocol): it's ADDITIVE (new change_order_lines + change_order_photos tables + new change_orders columns with defaults; no data rewrite), so existing change orders are preserved — their amount becomes the CO total automatically and they read as draft/pending. He wants to watch migrations on real data.
- [ ] **Step 4:** Memory — Phase 9 CO upgrade shipped; record the model (lines + lump sum → amount rollup keeps contract total/SOV sync working), the new lifecycle, the additive migration 14, and a manual-smoke checklist. Note invoices improvements are the next round ("to start" was COs).

---

## Self-Review Notes (author)

- **Invariant preserved:** the contract total and AIA SOV sync both read `change_orders.amount`. We keep `amount` as the canonical rolled-up total (= (Σ line cents + lump-sum cents)/100), written server-side on save. Exact for integer cents (`round(amount*100)===totalCents`), so zero drift downstream. No edits to `billingSummary` or `aiaStore.syncChangeOrders` math.
- **Additive migration:** v14 only adds tables/columns with defaults — no data rewrite, low risk, existing COs keep working (their single `amount` is already the total; empty lines + 0 lump sum = same total). Legacy `pending` tolerated.
- **DRY:** the editor imports `lineCents`/`draftTotalCents` from the invoice editor; the PDF copies the invoice + issue-photo structure; photos reuse the issue upload/link/build pattern and the Phase 8 touch-delete affordance.
- **Lifecycle safety:** adding draft/sent doesn't change the contract-total rule (still only `approved`), so an unsent/unapproved request never inflates the contract.
- **Correctness bonus:** deleteChangeOrder now also removes the orphan synced SOV line (`WHERE changeOrderId=?`), fixing a pre-existing dangling-line gap.
- **Scope:** Change Orders only this round (Nathan said "to start"); invoice improvements are a follow-up.
