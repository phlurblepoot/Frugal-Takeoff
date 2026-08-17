# Billing Totals Split (Contract vs Invoices) — Design

Date: 2026-08-17
Status: Approved by Nathan (conversation)

## Problem

The project Billing tab's Summary card shows Contract total and Invoiced but
nothing for what has been billed via AIA pay applications. The customer view
shows one blended outstanding figure. Nathan wants contract (pay-app) and
invoice figures separated everywhere they're summarized.

## Decisions (agreed with Nathan)

- **Contract line** (pay-app scoped): Contract total · Billed · Outstanding ·
  Paid. "Billed" is **net of retainage** — Σ finalized pay applications'
  payment-due (L8); retainage enters Billed only when released. Outstanding =
  Billed − pay-app payments.
- **Invoices line**: Invoiced · Paid (invoice-scoped; the old standalone
  "Invoice outstanding" stat is dropped from the card — derivable).
- **Customer view**: Billing tab rollup shows the same two-row split;
  Overview's Outstanding tile shows the combined total with a
  "contract $X · invoices $Y" breakdown line. Sidebar totals and the
  Projects-board outstanding column stay combined.
- No migration, no schema change.

## Server (`server/billingStore.ts`, `server/customerStore.ts`)

- `billingSummary(db, projectId)` gains (additive; existing fields unchanged):
  - `payAppBilledCents` — Σ `totalCents` of `kind === 'payapp'` docs from
    `listBilledDocuments(db, projectId)` (finalized apps' L8, net of
    retainage — the same population/figures the customer ledger uses).
  - `payAppOutstandingCents` — Σ `balanceCents` of those docs (equivalently
    billed − paid; per-doc figures already computed).
  Derive both from `listBilledDocuments` so there is one source of truth.
- `customerOverview(...).billing` gains a split (keeping the existing
  combined fields so current consumers don't break):
  - `contract: { billedCents, paidCents, outstandingCents }` (payapp docs)
  - `invoices: { invoicedCents, paidCents, outstandingCents }` (invoice docs)
  Summed across the customer's non-archived projects from the same ledger
  loop that already runs.

## Client

- **ProjectBilling Summary card**: replace the flat 5-stat list with two
  labeled rows —
  `Contract  | Contract total · Billed · Outstanding · Paid`
  `Invoices  | Invoiced · Paid`
  (styling per the card's existing stat idiom; responsive wrap on phones).
- **CustomerBillingTab rollup line**: two rows mirroring the same labels,
  from `billing.contract` / `billing.invoices`.
- **CustomerOverviewTab Outstanding tile**: combined total (unchanged
  number) + muted breakdown line "contract $X · invoices $Y" when both are
  present; omit the breakdown when either is zero.

## Testing

- Unit: `billingSummary` new fields on a mixed project (finalized pay apps
  incl. a release + sent/paid invoices + drafts excluded) — each leg lands in
  its bucket; combined legacy fields unchanged. `customerOverview` split sums
  across projects; combined fields still equal contract+invoices.
- E2E: extend the customers admin spec's Billing-tab assertions with the
  two-row labels/figures; extend the project billing coverage only if an
  existing spec asserts the summary card (check; else unit-level suffices).

## Out of scope

- Retainage-held display (Nathan chose net-of-retainage without a held
  figure).
- Sidebar/board figure changes (stay combined).
