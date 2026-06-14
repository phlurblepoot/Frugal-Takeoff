# Phase 7b — Billing Refinements (Nathan's AIA feedback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Address Nathan's 4 notes from testing AIA: (1) contract value derives from the AIA Schedule of Values + change orders; (2) AIA and invoices COEXIST (no mode switch) — invoices→invoice total, AIA+COs→contract total; (3) payments become a SEPARATE polymorphic system (a payment pays an invoice OR a pay application, with a chosen amount), not embedded in invoices; (4) the Application-for-Payment editor is too narrow — make it a full-width view with readable columns.

**Decisions (locked):**
- Contract total = (SOV original-lines Σ, `isChangeOrder=0`) when an SOV exists, else `projects.contractValue`; PLUS approved change orders. (Change orders counted once — from `change_orders`, not the CO SOV lines.)
- Invoices + AIA both always available per project (remove the `billingMode` switch). Two totals surfaced: **contract total** (SOV+COs) and **invoice total** (Σ invoices).
- Payments go **polymorphic**: `payments(id, targetType:'invoice'|'payapp', targetId, date, amount, method, note, createdAt)`. A unified **Payments** section (list + record with a target picker + amount). Payment entry REMOVED from InvoiceEditor (invoice still shows balance read-only).
- Pay-app editor → **full-width** (full-screen modal or dedicated panel), G703 columns sized to show values.

**SAFETY INVARIANT:** tsc/test/build green after every task. Integer cents. Migration 13 REBUILDS the payments table (non-destructive backfill: existing rows → `targetType='invoice', targetId=invoiceId`) — flag to Nathan before pull (data-transforming but nothing lost).

**Tech Stack:** Express + better-sqlite3, React, the existing billingStore/aiaStore, money.ts. Reuse patterns from Phase 4a/7.

**Key facts (from explore):**
- `payments` (migration 8): id, invoiceId NOT NULL, date, amount REAL, method, note, createdAt. Functions: recordPayment(invoiceId,...), deletePayment(id), paidCentsFor(invoiceId). billingSummary returns {baseContractCents, approvedChangeCents, contractValueCents, invoicedCents, paidCents, outstandingCents, invoiceCount, changeOrderCount}.
- `aia_sov_lines` (migration 12): scheduledValueCents, isChangeOrder. SOV original total = Σ where isChangeOrder=0.
- InvoiceEditor payment form: lines ~200-221; recordPayment(invoice.id,...) at ~67; read-only balance ~180-186.
- ProjectBilling: mode switch ~99-125; AIA block ~151-158; standard block ~160-226; summary card ~136.
- AiaPayAppEditor: Modal width="lg" ~224-237; 10-col G703 Table ~264-320. AiaPayApplications opens it as a modal.
- Routes: POST /api/invoices/:id/payments, DELETE /api/payments/:id (~238-248). deleteInvoice deletes its payments (billingStore ~115). deletePayApp must delete its payments (add). deleteProject cascade (projectStore ~298-300) deletes payments by invoice join — must also cover payapp-targeted payments.
- Client: recordPayment(invoiceId,...), deletePayment(id); BillingSummary type; Payment type; Invoice has payments[]/paidCents/balanceCents.
- Latest migration = 12. SQLite can't drop NOT NULL in place → rebuild table.

---

## Task 1: Migration 13 (polymorphic payments) + target-aware payment store + cascade

**Files:** `server/migrationList.ts`, `server/migrationList.test.ts`, `server/billingStore.ts`, `server/billingStore.test.ts`, `server/aiaStore.ts` (deletePayApp cascade), `server/projectStore.ts` (deleteProject cascade).

- [ ] **Step 1:** Failing migration test: after migration 13, `payments` has columns (id, targetType, targetId, date, amount, method, note, createdAt) and NOT `invoiceId`; an existing payment row (seed pre-13 via running through 12, insert a payment with invoiceId) is rebuilt with targetType='invoice', targetId=that invoiceId. (If the test runner can target a version, seed-then-migrate; else test the rebuild logic.)
- [ ] **Step 2:** Append migration 13 `payments-polymorphic` — REBUILD the table (SQLite-safe):
  ```sql
  CREATE TABLE payments_new (id TEXT PRIMARY KEY, targetType TEXT NOT NULL, targetId TEXT NOT NULL, date INTEGER, amount REAL NOT NULL DEFAULT 0, method TEXT, note TEXT, createdAt INTEGER NOT NULL);
  INSERT INTO payments_new (id,targetType,targetId,date,amount,method,note,createdAt) SELECT id,'invoice',invoiceId,date,amount,method,note,createdAt FROM payments;
  DROP TABLE payments;
  ALTER TABLE payments_new RENAME TO payments;
  CREATE INDEX idx_payments_target ON payments (targetType, targetId);
  ```
  (Guard: only if `payments` exists. Runs inside the framework transaction.)
- [ ] **Step 3:** Update `server/billingStore.ts` payment functions to be target-aware:
  - `recordPayment(db, targetType, targetId, input)` — validate targetType ∈ {'invoice','payapp'}, target exists (invoice or aia_pay_app), amount finite >0 (toCents). Insert with targetType/targetId.
  - `deletePayment(db, id)` — unchanged.
  - `paidCentsFor(db, targetType, targetId)` — Σ payments where targetType+targetId.
  - `listProjectPayments(db, projectId)` — all payments for the project: targetType='invoice' AND targetId IN (invoices of project) UNION targetType='payapp' AND targetId IN (aia_pay_apps of project). Return each with a resolved label (invoice number / "App #N") for the UI. 
  - `getInvoice` payment fetch → payments WHERE targetType='invoice' AND targetId=invoice.id. `deleteInvoice` → delete payments WHERE targetType='invoice' AND targetId=id.
- [ ] **Step 4:** `aiaStore.deletePayApp` → also delete payments WHERE targetType='payapp' AND targetId=id (in its transaction). `projectStore.deleteProject` cascade → delete payments for the project's invoices AND pay-apps (replace the invoice-join-only delete).
- [ ] **Step 5:** Tests: migration rebuild + backfill; recordPayment to an invoice and to a payapp; paidCentsFor both; listProjectPayments returns both with labels; reject bad targetType / missing target / non-positive amount; deletePayApp removes its payments; deleteInvoice removes its payments.
- [ ] **Step 6:** tsc clean; server tests green. Commit `feat: migration 13 polymorphic payments + target-aware payment store + cascade`.

---

## Task 2: billingSummary — contract total (SOV+COs) + invoice total + paid splits

**Files:** `server/billingStore.ts`, `server/billingStore.test.ts`.

- [ ] **Step 1:** Failing tests for the new summary.
- [ ] **Step 2:** Rework `billingSummary(db, projectId)` to return (keep names back-compatible where used):
  - `sovOriginalCents` = Σ aia_sov_lines.scheduledValueCents WHERE projectId AND isChangeOrder=0.
  - `baseContractCents` = sovOriginalCents if there are ANY aia_sov_lines for the project, else toCents(projects.contractValue).
  - `approvedChangeCents` = Σ approved change_orders (unchanged).
  - `contractValueCents` = baseContractCents + approvedChangeCents (this stays the field ProjectOverview/old UI read; now SOV-derived when an SOV exists). Also expose `contractTotalCents` as an explicit alias.
  - `invoiceTotalCents` (= the existing invoicedCents; keep both names) = Σ invoice line totals.
  - `paid: { invoicesCents, payAppsCents }` — invoicesCents = Σ payments targetType='invoice' for this project; payAppsCents = Σ payments targetType='payapp'. Keep `paidCents` = invoicesCents (back-compat) or = both? Set `paidCents = invoicesCents + payAppsCents` (total paid) — but verify ProjectOverview's usage; if it shows "paid against invoices" keep invoicesCents there. Document the choice.
  - `invoiceOutstandingCents` = invoiceTotalCents − paid.invoicesCents.
  - Keep invoiceCount, changeOrderCount.
- [ ] **Step 3:** Tests: with an SOV (original $150k) + approved CO ($10k) → contractTotal=$160k even if projects.contractValue is 0; without SOV → falls back to contractValue+COs; paid splits correct (a payment on an invoice vs on a payapp land in the right bucket).
- [ ] **Step 4:** tsc clean; tests green. Commit `feat: billing summary — contract total from SOV + change orders, invoice total, paid splits`.

---

## Task 3: Routes — unified project payments + summary shape

**Files:** `server/routes.ts`, `server/routes.test.ts`.

- [ ] **Step 1:** Failing tests.
- [ ] **Step 2:** Add (admin-gated): `GET /api/projects/:id/payments` → listProjectPayments; `POST /api/projects/:id/payments` body { targetType, targetId, amount, date?, method?, note? } → recordPayment; keep `DELETE /api/payments/:id`. Remove or keep `POST /api/invoices/:id/payments` — REMOVE it (payments are unified now); update any caller. The summary route already returns billingSummary (now the new shape) — no route change beyond the type.
- [ ] **Step 3:** Tests: admin can list/create/delete payments for invoice + payapp targets; non-admin → 403; bad target → 400; created payment appears in the project list + affects the summary paid splits.
- [ ] **Step 4:** tsc clean; tests green. Commit `feat: unified project payment routes (invoice or pay-app targets)`.

---

## Task 4: Client store — payment helpers + summary/payment types

**Files:** `src/utils/store.ts`.

- [ ] **Step 1:** Update `Payment` type → { id, targetType, targetId, date, amount, method, note, createdAt, targetLabel? }. Update `BillingSummary` type → add sovOriginalCents, contractTotalCents, invoiceTotalCents, paid:{invoicesCents,payAppsCents}, invoiceOutstandingCents (keep existing fields). 
- [ ] **Step 2:** Helpers: `getProjectPayments(projectId)` → Payment[]; `recordPayment(targetType, targetId, { amount, date?, method?, note? })` (REPLACES the old invoiceId signature — update the InvoiceEditor caller in Task 5); `deletePayment(id)` (unchanged). Remove the old `recordPayment(invoiceId,...)` signature.
- [ ] **Step 3:** tsc clean; `npm test` green (fix any now-broken caller — InvoiceEditor handled in Task 5; if tsc flags it now, stub minimally or do Task 5 next). Commit `feat: client store — unified payment helpers + summary types`.

---

## Task 5: UI — coexist invoices+AIA, contract/invoice totals, unified Payments section

**Files:** `src/pages/project/ProjectBilling.tsx`; create `src/pages/project/billing/PaymentsSection.tsx`; modify `src/pages/project/billing/InvoiceEditor.tsx`.

- [ ] **Step 1:** ProjectBilling: REMOVE the billing-mode switch. Always render: a summary row showing **Contract total** (contractTotalCents) and **Invoice total** (invoiceTotalCents) + paid (invoices / pay-apps) + balances; the AIA sections (AiaSettingsForm + AiaScheduleOfValues + AiaPayApplications) AND the Invoices section AND the Change Orders section AND the new Payments section — all visible together (sensible order: contract summary → AIA (SOV + pay apps) → Invoices → Change orders → Payments). The AIA section can show a light "set up AIA / seed from estimate" empty state when no SOV. Keep `aiaSettings` load for the settings form (billingMode no longer gates anything — can drop it or leave it unused).
- [ ] **Step 2:** Create `PaymentsSection.tsx` (props { projectId }): load getProjectPayments; a table (date, target [Invoice #/App #N], amount, method, note, delete); a "Record payment" form — a target picker (dropdown listing the project's invoices AND pay-apps, each labeled) + amount ($) + date + method + optional note → recordPayment(targetType, targetId, {...}) → reload. Show totals.
- [ ] **Step 3:** InvoiceEditor: REMOVE the payment entry form (the Amount/Method/Record-payment block + the payments list with delete). KEEP the read-only balance/paid display (it reads invoice.paidCents/balanceCents, still computed server-side from target-aware payments). Remove the now-unused recordPayment/deletePayment imports + payAmount/payMethod state. Add a small note/link "Record payments in the Payments section."
- [ ] **Step 4:** tsc/lint/test/build green. Commit `feat: billing UI — invoices+AIA coexist, contract/invoice totals, unified Payments section`.

---

## Task 6: UI — full-width Application-for-Payment editor

**Files:** `src/pages/project/billing/AiaPayAppEditor.tsx`, `src/pages/project/billing/AiaPayApplications.tsx`.

- [ ] **Step 1:** Convert the pay-app editor from a `width="lg"` Modal to a FULL-WIDTH view. Options (pick the cleaner): (a) a full-screen Modal (`width="full"` / max-w-[95vw] with the body using the full width), or (b) an inline full-width panel that replaces the applications list while editing (a back button to return). Prefer whichever the codebase supports cleanly — a full-screen modal/panel that uses the available width.
- [ ] **Step 2:** The G703 grid: give it room — the 10 columns (Item, Description, Scheduled C, Previous D, This period E, Stored F [editable], % G/C, Total G, Balance, Retainage) must be readable; the **Stored ($) and % inputs must be wide enough to show their values** (min width on those inputs/cells; don't let them collapse). Use a wide table with sensible per-column widths; allow horizontal scroll only as a last resort, but on a full-width layout most columns should fit. Keep the G702 summary panel + the editable app fields + Save/Finalize/Export. Preserve all behavior (version-checked save, live recompute, export).
- [ ] **Step 3:** tsc/lint/test/build green; (manual: the editor now shows all columns + the stored/% values are visible). Commit `fix: full-width Application-for-Payment editor with readable G703 columns`.

---

## Task 7: Full verification + review + push

- [ ] **Step 1:** `npm run lint && npm test && npm run build` green.
- [ ] **Step 2:** Live API smoke (temp dir): seed SOV ($150k) + approved CO ($10k) → summary contractTotal=$160k (with projects.contractValue=0). Create an invoice ($5k) → invoiceTotal=$5k. Record a payment on the invoice ($2k) and a payment on a pay-app ($1k) → paid.invoicesCents=$2k, paid.payAppsCents=$1k, listProjectPayments shows both with labels. Delete a pay-app → its payments gone. Non-admin → 403 on payments routes.
- [ ] **Step 3:** Final review (opus) over the Phase 7b range. Focus: (1) migration 13 rebuild preserves existing payments (backfill targetType='invoice'), idempotent/safe; (2) payment functions target-aware, paid splits correct, no double-count of COs in contract total (COs counted from change_orders, not CO SOV lines); (3) every payment route admin-gated; (4) cascades (payapp+invoice+project) remove the right payments — no orphans; (5) InvoiceEditor no longer records payments but still shows correct balance from target-aware payments; (6) integer cents, finite guards; (7) the existing AIA math/G702-G703 untouched. Fix Critical/Important.
- [ ] **Step 4:** Push. Migration 13 REBUILDS payments (non-destructive backfill) — TELL NATHAN before pull (data-transforming; existing payments preserved as invoice-targeted; nothing lost).
- [ ] **Step 5:** Memory — Phase 7b shipped: contract total from SOV+COs; invoices+AIA coexist; polymorphic payments (separate Payments section, invoice|payapp targets); full-width pay-app editor. Note migration 13 rebuilt payments. Manual-smoke list.

---

## Self-Review Notes (author)

- **Note 1** → contract total = SOV-original + approved COs (fallback contractValue); COs counted once (from change_orders). **Note 2** → mode switch removed; invoices + AIA coexist with separate totals. **Note 3** → payments rebuilt polymorphic (invoice|payapp), unified section, removed from InvoiceEditor. **Note 4** → full-width pay-app editor with readable columns.
- **Migration 13 safety:** table rebuild copies all rows (backfill targetType='invoice', targetId=invoiceId) — non-destructive; flag to Nathan. SQLite can't drop NOT NULL in place, hence the rebuild.
- **No double-count:** contract total sums SOV-original (isChangeOrder=0) + approved change_orders; the CO SOV lines (isChangeOrder=1, from sync) are NOT added again. The AIA G702 L3 (= Σ all SOV lines incl CO lines) reconciles with contract total when COs are synced.
- **Back-compat:** keep contractValueCents/invoicedCents/paidCents fields (redefined sensibly) so ProjectOverview + any reader keep working; add the new explicit fields alongside.
- **Money:** integer cents, finite guards on payment amounts; round at cents boundary.
