# Pay-App Balances + Per-Item Payments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Amount + Balance columns on the Pay Applications tab; read-only Payments sections in the invoice and pay-app editors.

**Architecture:** Additive server fields on the pay-apps list route (finalized figures from `listBilledDocuments`, draft amounts computed live) + `payments` on the pay-app GET (mirroring the invoice GET); two small display additions client-side. No migration.

**Spec:** `docs/superpowers/specs/2026-08-17-payapp-invoice-balances-design.md` — read it first.

## Global Constraints

- Branch `testing` (commit; no pushes/PRs mid-plan).
- Figures derive from the existing helpers only (`listBilledDocuments`, `computeG702`, `paidCentsFor`) — no new math.
- Existing fields/routes byte-compatible (additive); existing tests unmodified and green.
- `npx vitest run` (814 green at start) + `npx tsc --noEmit` before every commit; Playwright only in Task 2's final verification.
- Never touch `data/`.

---

### Task 1: Server — list figures + pay-app payments

**Files:**
- Modify: `server/aiaStore.ts` (`listPayApps` ~261, `getPayApp` ~266) OR the route layer (`server/routes.ts` — find the pay-apps list/get routes) — put the logic where the existing style dictates: `getInvoice` embeds payments in the STORE layer (server/billingStore.ts:63-71), so mirror that placement.
- Test: `server/aiaStore.test.ts` (append)

**Interfaces:**
- Produces (Task 2 consumes): list rows gain `totalCents: number`, `paidCents: number`, `balanceCents: number | null` (null for drafts); `getPayApp` result gains `payments` (same row shape `getInvoice` embeds — read it and match exactly, incl. field names).

- [ ] **Step 1: Failing tests** (mirror aiaStore.test.ts fixtures): project with a finalized app ($1,000 SOV, 100%, 10% retainage → L8 90000c) carrying a 25000c payment, and a draft app (50% → live L8 45000c, ignore retainage interplay — hand-compute per current math) with no payments. Assert list: finalized row `{totalCents: 90000, paidCents: 25000, balanceCents: 65000}`; draft row `{totalCents: <computed>, paidCents: 0, balanceCents: null}`. Assert `getPayApp(finalized).payments` has the one payment with the same field names as `getInvoice(...).payments` rows (write the assertion against those exact fields after reading getInvoice).
- [ ] **Step 2: RED → Step 3: Implement.** `listPayApps`: one `listBilledDocuments(db, projectId)` call → map finalized apps by id; drafts get `computeG702` L8 + `paidCentsFor` + null balance. `getPayApp`: add the payments query mirroring `getInvoice`'s. Check the routes serving these pass results through untouched (they should — SELECT-* passthrough).
- [ ] **Step 4: GREEN + full suites. Step 5: Commit** — `feat(billing): per-app amount/paid/balance on pay-app list + payments on pay-app GET`

---

### Task 2: Client — columns + editor payment sections + verification

**Files:**
- Modify: `src/pages/project/billing/AiaPayApplications.tsx` (table ~86-105)
- Modify: `src/pages/project/billing/InvoiceEditor.tsx`, `src/pages/project/billing/AiaPayAppEditor.tsx` (read both fully; add a Payments section per each file's card idiom)
- Modify: `src/utils/store.ts` (AiaPayApp type + payapp-GET type + payments row type reuse)
- Modify: e2e — extend the admin customers spec (or the most fitting existing billing-capable spec) with: Pay Applications tab shows Amount/Balance for the seeded finalized app (`withPayApp` seed from 2026-08-17 exists: L8 90000c, 25000c paid → $900.00 / $650.00... VERIFY the seed's actual figures — the customers seed used retainage 0% → L8 100000, payment 25000 → balance 75000; hand-check against seed.ts and assert those).

**Interfaces:** consumes Task 1's fields; `formatMoney` for rendering.

- [ ] **Step 1:** Pay-apps table: add `<TH>Amount</TH><TH>Balance</TH>` after Status; cells `formatMoney(app.totalCents)` and `app.balanceCents == null ? '—' : formatMoney(app.balanceCents)`.
- [ ] **Step 2:** Editors: "Payments" section — table/rows of date (fmt like the file's other dates) · note (muted, optional) · amount (right-aligned `formatMoney`); footer "Paid X · Balance Y"; empty state "No payments recorded". Invoice editor: data already on the loaded invoice (`payments`, `paidCents`, `balanceCents` — verify InvoiceEditor's invoice prop carries them; if the prop comes from `getInvoice` it does). Pay-app editor: from the GET payload's new `payments` + existing g702/app fields (balance for a draft: show "—" consistent with the list).
- [ ] **Step 3:** E2E addition per Files note. **Step 4:** Full verification: `npx vitest run`, `npx tsc --noEmit`, `npm run build`, `npx playwright test` (full suite green). **Step 5: Commit** — `feat(billing): pay-app amount/balance columns + payments lists in invoice/pay-app editors`

---

## Execution notes

- Waves: T1 → T2 → final whole-branch review → fix wave if needed → push. Two tasks; small.
