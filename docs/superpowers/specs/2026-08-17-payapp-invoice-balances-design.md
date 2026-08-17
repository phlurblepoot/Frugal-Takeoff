# Pay-App List Balances + Per-Item Payment Lists — Design

Date: 2026-08-17
Status: Approved by Nathan (conversation)

## Problem

When recording payments there is no way to see an individual application's or
invoice's balance. The Invoices tab already shows Total/Balance columns; the
Pay Applications tab shows no money at all. Neither editor lists the payments
recorded against the open item.

## Decisions (agreed with Nathan)

- **Pay Applications tab** gains **Amount** and **Balance** columns.
  - Amount = the application's payment-due (G702 L8). Drafts show their LIVE
    computed amount (useful while drafting).
  - Balance = amount − payments against the app; finalized apps only; drafts
    show "—" (not yet billed).
- **Invoices tab unchanged** (already has Total + Balance).
- **Both editors** (InvoiceEditor, AiaPayAppEditor) gain a read-only
  **Payments** section: each payment against the item (date, amount, note)
  plus a paid / balance summary line. Recording/deleting payments stays in
  the Payments tab.
- No migration, no schema change.

## Server

- Pay-apps LIST endpoint (`GET /api/aia/pay-apps` for a project — find the
  actual route; it serves `listPayApps`) gains per-app `totalCents`,
  `paidCents`, `balanceCents`:
  - Finalized apps: from `listBilledDocuments(db, projectId)` (same figures
    the summaries/ledger use; one call for the whole list).
  - Draft apps: `totalCents = computeG702(db, app.id).L8currentPaymentDueCents`
    (live), `paidCents` from `paidCentsFor` (a payment against a draft is
    technically recordable today), `balanceCents = null` (drafts aren't
    billed — the UI renders "—").
- Pay-app GET (`/api/aia/pay-apps/:id`) response gains `payments`: the
  payment rows against that app (same shape the invoice GET already embeds —
  match `getInvoice`'s payments field exactly).

## Client

- `AiaPayApplications.tsx` table: columns App # / Period to / Application
  date / Status / **Amount** / **Balance** / actions. Amount always
  `formatMoney(totalCents)`; Balance `formatMoney(balanceCents)` when
  non-null else "—".
- `InvoiceEditor.tsx` + `AiaPayAppEditor.tsx`: a "Payments" card/section
  (match each editor's existing section idiom): rows of date · note ·
  amount; footer line "Paid $X · Balance $Y" (invoice: from its existing
  paidCents/balanceCents; pay app: from the new fields / g702-derived).
  Empty state: a muted "No payments recorded" line. Read-only.
- Types extended in `src/utils/store.ts`.

## Testing

- Unit: pay-apps list figures (finalized app with payment → correct
  balance; draft → live amount + null balance); pay-app GET payments array.
- E2E: extend the existing customers/billing coverage minimally — after the
  seeded finalized pay app, assert the Pay Applications tab shows the Amount
  and Balance figures (the admin billing spec already navigates near there;
  if not, a small addition to the existing project-billing-capable spec).

## Out of scope

- Recording payments from within the editors.
- Invoice tab changes.
