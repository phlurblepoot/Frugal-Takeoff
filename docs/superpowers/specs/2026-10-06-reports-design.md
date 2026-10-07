# Reports Page and Automatic Paid Status — Design

Date: 2026-10-06
Status: Approved by Nathan (conversation)

## Problem

"Add report generation for things like open invoices in a new reports tab."
Billing lives per project (Billing tab) and as a few dashboard rollups; there
is nowhere to see, say, everything owed across all jobs, or the change orders
still waiting on a GC, or to hand a list like that to a bookkeeper. Invoice
status is also set only by hand, so a paid-up invoice keeps saying "Sent".

## Decisions (agreed with Nathan)

- **A top-level Reports page** in the main sidebar, **admin-only** (billing is
  admin-only everywhere), covering **all projects**, with **project and
  customer filters**.
- **Four reports** in the first version:
  1. **Open invoices / AR aging** — every non-draft invoice and AIA pay
     application with a balance over $0, whatever its status says: customer,
     project, document ("Invoice 1001" / "Pay App #3"), date, days outstanding
     (from the document date — there are no due dates), total, paid, balance,
     aging bucket; totals and per-bucket subtotals. Buckets are the
     dashboard's (≤30 / 31–60 / 61+ days) so the numbers agree.
  2. **Payments received** in a date range (presets; default this month):
     date, customer, project, what it paid, method, note, amount; total.
     **No payment attachments** (they belong on the payment only).
  3. **Change orders by status** (draft / sent / approved / rejected; legacy
     `pending` counts as draft): project, CO number, title, status, date,
     amount, schedule impact; totals per status. "Waiting on approval" = sent.
  4. **Retainage held** — per project, the latest non-draft pay app: contract
     sum, completed & stored to date, retainage held and released, as the
     G702 computes them (reusing aiaStore's maths).
- **Output:** an on-screen table each, and an **Excel (.xlsx) download** of
  the report as currently filtered. No PDF, no email.
- **Invoices are marked paid automatically:** status becomes `paid` once
  payments cover the total; a `paid` invoice whose balance opens up again
  (payment deleted or reduced, lines grown) goes back to `sent`. No due dates.
  Existing fully-paid `sent` invoices are marked paid once, on upgrade.
- **Implementer's calls (from existing behaviour):**
  - *Archived projects are included by default* — money owed on a closed job
    is still owed — with an **Include archived projects** toggle. Unticked,
    the open-invoice totals and buckets equal the dashboard's (which skips
    archived projects).
  - *No sortable columns:* the app has no sortable-table pattern, so each
    report has a fixed order (open invoices oldest first; payments newest
    first like the Payments tab; change orders by project then number;
    retainage by project). The Excel sheet has filter buttons, so it sorts
    in Excel.
  - *Undated documents* (an invoice or pay app with no date) have no age and
    no dated bucket — the dashboard leaves them out of its buckets but not
    out of Outstanding — so the report shows them under **No date**.
  - *Calendar days:* invoice, change-order and payment dates are stored as
    the UTC midnight of the day picked in the editor, so reports read them as
    that UTC day (as the editors do); pay apps' `applicationDate` is already a
    day. The payments range compares those days; presets use the local
    calendar.
  - *Change-order amount* is the canonical `change_orders.amount` (what the
    contract total adds for an approved CO); it equals lines + lump sum for
    every saved CO, and is the only value a pre-line-item legacy row has.
  - *Retainage released* is reported in dollars: line 5 as the same lines
    would hold it with no release, less line 5 as it is. Releases are entered
    as percentage points; the rate column shows base % and points released.
  - *A fully-paid draft* is marked paid too: the customer has paid it, and as
    a draft it would stay out of every billed figure.
  - *Manual status picks* (the status click, `setInvoiceStatus`) are not run
    through the rule; a hand-set status stands until the next payment change
    or line edit.

## Design

**Automatic paid status (`server/billingStore.ts`):**

- `autoInvoiceStatus(status, totalCents, paidCents)`: draft/sent with
  total > 0 and paid ≥ total → `paid`; `paid` with balance > 0 → `sent`;
  otherwise unchanged.
- `syncInvoicePaidStatus(db, invoiceId)` applies it to the stored invoice
  inside the caller's transaction and returns `{invoiceId, status}` when it
  moved. Called by `recordPayment` (invoice targets), `updatePayment` (on an
  amount change) and `deletePayment`; they return that change.
- **Version:** the automatic change bumps neither `version` nor `updatedAt`.
  A payment never bumped the invoice's version, and bumping it for the status
  it implies would fail the next save of an invoice editor open elsewhere
  with a conflict over a change its user can't see. Instead `saveInvoice`
  resolves the status it writes through the same rule (against the new lines
  and current payments) — which also covers "lines grew → back to sent" — so
  the stale status the editor echoes back cannot overwrite the automatic one,
  and a notes-only save still leaves the PDF current. `updatedAt` is already
  stamped by the payment change wherever Paid/Balance moved; the PDF's PAID
  stamp comes from the amounts, not the status. (Known edge: a draft that is
  paid in full and then reopened becomes `sent`; an editor opened while it
  was a draft would save it back as a draft.)
- **Broadcast:** the payment routes broadcast `{type: 'invoice', action:
  'updated'}` — with no version, so every listener refetches — when the
  payment moved its invoice's status. `POST /payments` still answers `{id}`.

**Migration 46 (`invoices-auto-paid`, DATA-TRANSFORMING, supervised):** every
`sent` invoice whose total (Σ line qty × unitPrice rounded to cents) is over
$0 and whose payments (each rounded to cents) reach it becomes `paid`. The
maths is inlined so later store changes can't alter it. Only the status
changes; replay finds nothing to do.

**Reports (`server/reportsStore.ts`, read-only, all cents):** one function per
report taking `{projectId?, customerId?, includeArchived?, from?, to?,
status?}` plus `reportFilterOptions`:

- `openInvoicesReport` — `listBilledDocuments` per project in scope, balance
  > 0; `billedDocDateMs` + `ageDays` + `agingBucket` from `dashboardStore`
  (both now exported; `dashboardMoney` uses `agingBucket` too). Rows, totals,
  `buckets {current, days31to60, days61plus, undated}`.
- `paymentsReport` — payments joined to their invoice / pay app for the
  project; `from`/`to` validated as `YYYY-MM-DD` (400 otherwise).
- `changeOrdersReport` — `listChangeOrders`; `statusGroup` normalizes legacy
  statuses to draft; `byStatus` for all four plus `totals` (count, cents,
  schedule-impact days); an unknown `status` filter is a 400.
- `retainageReport` — latest non-draft pay app per project; `computeG702`
  lines 3/4/5 and `retainage.{mode, baseWorkPercent,
  cumulativeReleasedPoints}`, plus the new `aiaStore.retainageReleasedCents`.
  computeG702's line-5 sum moved into a shared `retainageTotals(ctx)` that
  both use, so they can't disagree.

**Routes (`server/reportRoutes.ts`, all `authenticateToken` + `requireAdmin`):**
`GET /api/reports/options`, `/open-invoices`, `/payments`, `/change-orders`,
`/retainage`; filters as query parameters (`includeArchived=0` leaves
archived out; blank or repeated parameters are ignored).

**Client:**

- `src/utils/reportsApi.ts` — types mirroring the server and fetchers.
- `src/pages/reports/ReportsPage.tsx` — admin gate (non-admins get a notice,
  nothing fetched), tabs in `?tab=` (as Billing), filter card (customer,
  project narrowed by customer and the archived toggle, archived toggle;
  Payments adds a preset picker and From/To; Change orders a status picker),
  latest-request-wins loading, live refresh on billing/project/customer
  changes, error state with Try again, **Download Excel**.
- `ReportTables.tsx` — per report: summary tiles (open invoices: outstanding
  + bucket tiles in the dashboard's colours; change orders: a clickable tile
  per status that toggles the filter) and a `Table` with a totals row (and
  per-status subtotals when change-order statuses are mixed). Documents link
  to the project's Billing tab, opening the invoice / payment / change order.
- `reportsExcel.ts` — pure `*Sheet()` builders (cents, days) → `SheetSpec`;
  `buildReportWorkbook` (exceljs, lazy) writes title, the filters used, a
  frozen header row with auto-filter over the data, dollars with a currency
  format, real dates, and bold totals; `downloadReportXlsx` uses
  `downloadBlob`. `reportDates.ts` (presets, day formatting) and
  `reportLabels.ts` (bucket labels, rate wording) are shared by both.
- Navigation: `/reports` route; Sidebar `NavEntry.adminOnly` (mirrors
  `ProjectSection.adminOnly`) with Reports after Time; an admin-only
  **Reports** action in the command palette.

## Tests

- `server/billingStore.test.ts`: `autoInvoiceStatus` table; record full →
  paid (returned change), partial → sent (cents, no drift), delete → sent,
  amount down → sent and back up → paid, note edit → no change; lines grown
  on save → sent, shrunk → paid; fully-paid draft → paid, partly paid stays
  draft; a manual pick stands until the next change; pay-app payments never
  touch invoices; version/updatedAt untouched and a stale editor save is
  accepted without writing its stale status (both directions);
  `syncInvoicePaidStatus` no-ops.
- `server/migrationList.test.ts`: migration 46 marks only fully-covered
  `sent` invoices with a total over $0 (overpaid included; partly paid, $0,
  draft, already paid and pay-app-payment cases untouched), changes nothing
  but status, replays as a no-op, runs on a fresh install.
- `server/aiaStore.test.ts`: `retainageReleasedCents` (no release → 0, a
  release on a later app, stored materials, per-line mode).
  `server/dashboardStore.test.ts`: `ageDays`, `agingBucket`.
- `server/reportsStore.test.ts`: each report's population and filtering
  (project, customer, archived), cents sums, oldest-first aging with
  per-bucket subtotals and undated docs, agreement with `dashboardMoney`
  when archived are left out, pay apps included, payments' inclusive and
  open-ended ranges and bad dates, change-order ordering, legacy pending as
  draft, per-status totals and approved = `billingSummary.approvedChangeCents`,
  retainage from the latest non-draft app's G702 with released dollars,
  filter options.
- `server/reportRoutes.test.ts`: every route 403s for non-admins; query
  filters reach each report; 400s; query parsing.
  `server/routes.changefeed.test.ts`: a status-moving payment create / amount
  edit / delete also broadcasts the invoice (no version); a note edit doesn't.
- Client: `ReportsPage.test.tsx` (admin gate, default tab and filters,
  customer/project/archived filtering, payments presets and custom dates,
  change-order status tiles, retainage, `?tab=`, live refresh, Excel download
  of the filtered report, error + retry); `reportsExcel.test.ts` (each sheet
  builder, the written workbook's layout, formats and totals, download);
  `reportDates.test.ts`; `Sidebar.test.tsx` (Reports admin-only, after Time,
  active); `CommandPalette.test.tsx` (Reports admin-only).
- e2e `e2e/reports.spec.ts`: seed a project, a sent invoice and a partial
  payment via the API; open Reports and find the invoice with its balance;
  record the rest of the payment and see the invoice marked Paid and gone
  from Open invoices.
