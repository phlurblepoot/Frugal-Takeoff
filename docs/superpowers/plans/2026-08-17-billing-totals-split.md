# Billing Totals Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate contract (pay-app) and invoice figures in the project Billing summary card and the customer view — Contract: total/billed/outstanding/paid; Invoices: invoiced/paid — all derived from `listBilledDocuments` (one source of truth).

**Architecture:** Additive server fields (`billingSummary.payAppBilledCents/payAppOutstandingCents`; `customerOverview.billing.contract/.invoices`), then display changes in three components. No migration.

**Spec:** `docs/superpowers/specs/2026-08-17-billing-totals-split-design.md` — read it first.

## Global Constraints

- Branch `testing` (commit; no pushes/PRs mid-plan).
- "Billed" = net of retainage = Σ finalized pay apps' `totalCents` from `listBilledDocuments` (which is L8). NO new math — derive from that function only.
- All existing `billingSummary`/`customerOverview` fields keep their exact values (additive change; existing tests unmodified and green).
- `npx vitest run` (812 green at start) + `npx tsc --noEmit` before every commit. Playwright: only Task 3 runs it.
- Never touch `data/`.

---

### Task 1: Server — summary + rollup split fields

**Files:**
- Modify: `server/billingStore.ts` (`billingSummary` ~341-400; `listBilledDocuments`/`projectBillingTotals` already exist ~404-472)
- Modify: `server/customerStore.ts` (`customerOverview`'s billing loop — it already iterates `listBilledDocuments(db, p.id)` per project)
- Test: `server/billingStore.test.ts`, `server/customerStore.test.ts` (append)

**Interfaces:**
- Produces (Task 2 consumes these exact names):
  - `billingSummary(...)` gains `payAppBilledCents: number`, `payAppOutstandingCents: number` — Σ `totalCents` / Σ `balanceCents` over `listBilledDocuments(db, projectId).filter(d => d.kind === 'payapp')`.
  - `customerOverview(...).billing` gains `contract: { billedCents, paidCents, outstandingCents }` (payapp docs) and `invoices: { invoicedCents, paidCents, outstandingCents }` (invoice docs), summed in the SAME ledger loop that builds the existing combined figures; combined fields unchanged and must equal the sum of the two splits (assert in test).

- [ ] **Step 1: Failing tests.** In `billingStore.test.ts` (mirror existing billingSummary fixtures — read how invoices/pay apps/payments are seeded; the aiaStore fixtures show pay-app seeding): mixed project — one finalized pay app ($1,000 SOV, 100% complete, 10% retainage → L8 90000c) with a $250 payment (25000c), one sent invoice 20000c with 5000c paid, one draft invoice (excluded). Assert `payAppBilledCents = 90000`, `payAppOutstandingCents = 65000`, and legacy fields (`invoiceTotalCents = 20000`, `invoiceOutstandingCents = 15000`, `paid.payAppsCents = 25000`) unchanged. In `customerStore.test.ts`: extend an existing overview fixture (or add one) so a customer has both kinds; assert `billing.contract = { billedCents, paidCents, outstandingCents }` and `billing.invoices = {...}` with hand-computed values AND `billing.invoicedCents/paidCents/outstandingCents` (combined) each equal contract+invoices legs summed appropriately (note: combined `invoicedCents` today includes pay-app L8 amounts per the 2026-08-16 rework — verify against the current implementation and assert consistency, not a changed value).
- [ ] **Step 2: RED**, **Step 3: Implement** (derive from `listBilledDocuments` only; in customerStore, accumulate the split inside the existing per-doc loop with a `doc.kind` branch — do not run the ledger twice), **Step 4: GREEN + full suites** (`npx vitest run && npx tsc --noEmit`).
- [ ] **Step 5: Commit** — `feat(billing): pay-app billed/outstanding in billingSummary + contract/invoice split in customer rollup`

---

### Task 2: Client — two-row summary card, customer split display

**Files:**
- Modify: `src/pages/project/ProjectBilling.tsx` (Summary card ~97-115: the 5-entry stat array)
- Modify: `src/pages/customers/CustomerBillingTab.tsx` (rollup line)
- Modify: `src/pages/customers/CustomerOverviewTab.tsx` (Outstanding tile breakdown)
- Modify: `src/utils/store.ts` (extend `BillingSummary` + `CustomerBilling` types to match Task 1)

**Interfaces:**
- Consumes: Task 1's fields. Money formatting via the existing `formatMoney` helper (already used in these files).
- Produces:
  - ProjectBilling Summary card: two labeled rows replacing the flat list —
    row "Contract": Contract total (`contractTotalCents`) · Billed (`payAppBilledCents`) · Outstanding (`payAppOutstandingCents`) · Paid (`paid.payAppsCents`); row "Invoices": Invoiced (`invoiceTotalCents`) · Paid (`paid.invoicesCents`). Match the card's existing stat styling; rows wrap on phones. The old "Invoice outstanding" stat is removed.
  - CustomerBillingTab rollup: two rows with the same labels from `billing.contract` / `billing.invoices` (keep the ledger table unchanged).
  - CustomerOverviewTab Outstanding tile: combined number unchanged; add a muted sub-line `contract $X · invoices $Y` only when BOTH `billing.contract.outstandingCents > 0` AND `billing.invoices.outstandingCents > 0`; omit otherwise. (Non-admin: `billing` absent — everything already guards on its presence; keep it that way.)
- [ ] **Step 1:** Implement (read each component's current markup first; keep testids stable — the customers E2E asserts Billing-tab content). **Step 2:** `npx vitest run && npx tsc --noEmit` green. **Step 3: Commit** — `feat(billing): two-row contract/invoice summary displays (project card + customer view)`

---

### Task 3: E2E + full verification

**Files:**
- Modify: `e2e/customers.spec.ts` (admin flow's Billing-tab assertions — extend with the two-row labels and at least one figure per row; the seeded portfolio has an invoice; check whether it seeds a pay app — if not, extend `seedCustomerWithPortfolio` in `e2e/fixtures/seed.ts` with a finalized single-line pay app so the Contract row has real numbers, using the API endpoints the AIA editor uses)
- Check: grep e2e/ for any spec asserting the ProjectBilling summary card's old stats ("Invoice outstanding" etc.) and update if present.

**Interfaces:** consumes Tasks 1-2.

- [ ] **Step 1:** Implement spec changes. **Step 2:** Full verification: `npx vitest run` green, `npx tsc --noEmit` clean, `npx playwright test` (full suite, 35+ green; build takes minutes). **Step 3: Commit** — `test(e2e): contract/invoice split billing assertions`

---

## Execution notes

- Waves: T1 → T2 → T3 (small feature; T2 needs T1's types, T3 needs both). Single implementer per wave, standard reviews, final whole-branch review + fix wave, then push.
