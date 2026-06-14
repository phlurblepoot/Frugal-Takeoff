# Phase 7d — Tabbed Billing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the long stacked Billing page with a tabbed layout: the summary totals stay always-visible at the top; the sections (Schedule of Values, Change Orders, Pay Applications, Invoices, Payments, Settings) each live behind a tab so the page isn't cramped. UI-only.

**SAFETY INVARIANT:** tsc/lint/test/build green per task. UI-only — no server/store/migration/behavior changes; each section keeps its existing behavior, just rendered one-at-a-time under tabs.

**Tech Stack:** React + react-router (useSearchParams for tab persistence), the ui library. Existing section components: `AiaSettingsForm`, `AiaScheduleOfValues`, `ChangeOrdersSection`, `AiaPayApplications`, `PaymentsSection`. The Invoices section is still inline in ProjectBilling (extract it in Task 1).

**Key facts:** `src/pages/project/ProjectBilling.tsx` (post-7c) renders, admin-gated: Summary card → AiaSettingsForm (collapsible) → AiaScheduleOfValues → ChangeOrdersSection → AiaPayApplications → **inline Invoices section** (state `invoices`, `newInvoice`, the table + InvoiceEditor modal `editing`) → PaymentsSection. `reloadSummary()` reloads getBillingSummary; ChangeOrdersSection/PaymentsSection already call onChange→reloadSummary. Loads summary + invoices + aiaSettings. Sidebar nav for billing is adminOnly.

---

## Task 1: Extract InvoicesSection component

**Files:** create `src/pages/project/billing/InvoicesSection.tsx`; modify `src/pages/project/ProjectBilling.tsx`.

- [ ] **Step 1:** Read ProjectBilling's inline Invoices block: the `invoices` state + load (getInvoices), `newInvoice` (createInvoice), the invoices table (with InvoiceStatusPill, status cycle setInvoiceStatus, delete deleteInvoice, open→InvoiceEditor), and the `editing`/InvoiceEditor modal usage.
- [ ] **Step 2:** Create `InvoicesSection.tsx` (named export, props `{ projectId: string; onChange?: () => void }`) — move the invoices state/load/handlers + table + InvoiceEditor modal VERBATIM into it (self-loads via getInvoices; calls onChange after create/status/delete/save so the parent can reloadSummary). Reuse InvoiceEditor (it takes projectId etc.). Keep the read-only behavior from 7b (payment entry already removed).
- [ ] **Step 3:** In ProjectBilling, remove the inline invoices block + its state/handlers/imports now unused; render `<InvoicesSection projectId onChange={reloadSummary} />` in its place (will be tab-gated in Task 2).
- [ ] **Step 4:** tsc/lint/test/build green. Commit `refactor: extract InvoicesSection from ProjectBilling`.

---

## Task 2: Tabbed ProjectBilling

**Files:** `src/pages/project/ProjectBilling.tsx` (+ optional small AiaSettingsForm `defaultOpen` prop).

- [ ] **Step 1:** Keep the admin gate + the **Summary card ALWAYS visible at the top** (the contract/invoice/paid stat row). Below it, add a **tab bar** with: `Schedule of Values | Change Orders | Pay Applications | Invoices | Payments | Settings`. Use the app's existing tab/segmented styling if there's a shared pattern (check how ProjectView's tab bar or Sidebar nav styles active tabs — reuse tokens/classes for consistency: active = accent, etc.). 
- [ ] **Step 2:** Track the active tab in the URL via `useSearchParams` (`tab` param; values e.g. `sov|change-orders|pay-apps|invoices|payments|settings`), defaulting to `sov` when absent/unknown. Switching a tab updates the param (replace). This makes it linkable + survive reload.
- [ ] **Step 3:** Render only the active section:
  - `sov` → `<AiaScheduleOfValues projectId onChange?... />` (if it accepts onChange; if not, that's fine — SOV changes affect contract total, so reload the summary on tab switch anyway).
  - `change-orders` → `<ChangeOrdersSection projectId onChange={reloadSummary} />`
  - `pay-apps` → `<AiaPayApplications projectId />`
  - `invoices` → `<InvoicesSection projectId onChange={reloadSummary} />`
  - `payments` → `<PaymentsSection projectId onChange={reloadSummary} />`
  - `settings` → `<AiaSettingsForm projectId settings onSaved defaultOpen />` (in its own tab the collapsible isn't needed — pass an optional `defaultOpen` prop so it renders expanded; add that prop to AiaSettingsForm defaulting to false to preserve other usages — there are none others, so simple).
- [ ] **Step 4:** Reload the billing summary whenever the active tab changes (a `useEffect` on the tab value calling reloadSummary) so the always-visible totals stay current after edits in any tab (covers SOV which has no onChange). Keep the existing onChange→reloadSummary wirings too.
- [ ] **Step 5:** tsc/lint/test/build green. (Manual: tabs switch sections; summary stays on top; reload keeps the tab; pay-app editor modal still opens over the Pay Applications tab.) Commit `feat: tabbed billing page (SOV / change orders / pay apps / invoices / payments / settings)`.

---

## Task 3: Verify + push

- [ ] **Step 1:** `npm run lint && npm test && npm run build` green.
- [ ] **Step 2:** Quick review (sonnet): UI-only; summary always visible; all 6 tabs render their section; tab persists in URL + sensible default; each section still self-loads + behaves (create/edit/delete, pay-app editor modal, payment record, xlsx upload); summary refreshes on tab switch + on section onChange; no duplicate/missing sections; admin gate intact. Fix any issue.
- [ ] **Step 3:** Push to testing. (No migration; no data risk.)
- [ ] **Step 4:** Memory — 7d tabbed billing shipped (UI). Manual-smoke: tabs across the top, summary on top, each section under its tab, URL tab persistence.

---

## Self-Review Notes (author)

- **UI-only:** sections are the same components/behavior, just rendered one-at-a-time under tabs; Invoices extracted to a component so ProjectBilling is a clean tab host. Summary stays always-visible for at-a-glance totals.
- **Tab persistence:** `?tab=` via useSearchParams (linkable, survives reload), default `sov`.
- **Summary freshness:** reloadSummary on tab change + existing onChange wirings, so the always-visible totals reflect edits made in any tab (incl. SOV/COs which change the contract total).
- **Settings:** moved into its own tab (expanded via defaultOpen); the 7c collapsible behavior is preserved for any other usage (there are none).
