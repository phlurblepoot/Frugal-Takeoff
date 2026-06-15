# Phase 7c — AIA Billing Polish (round 2 feedback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Address Nathan's round-2 AIA notes — all UI, no data-model change. (1) % column in the pay-app editor too small; (2) consolidate to ONE Change Orders section attached to the AIA Schedule of Values (with a "Change Orders" header); (3) show payment notes after entry; plus two adds: (4) SOV xlsx upload (col A=description, col B=value) with a "?" help button; (5) make the AIA Settings section a collapsible (collapsed by default).

**SAFETY INVARIANT:** tsc/lint/test/build green after every task. UI-only; no server/store/migration changes. No behavior change beyond the listed UX.

**Tech Stack:** React, the ui library, SheetJS `xlsx` (already a dep — used for reading the uploaded sheet), the existing AIA client helpers (seedSov, getSov, etc.).

**Key facts (read these):**
- `src/pages/project/ProjectBilling.tsx`: renders Summary → AiaSettingsForm (~137) → AiaScheduleOfValues (~139) → AiaPayApplications (~140) → Invoices (~144) → **Change orders card (~171)** → PaymentsSection (~209). The change-orders create/list/approve logic (addChangeOrder ~88, setChangeOrderStatus, deleteChangeOrder, the `changeOrders` state + table ~171-208) lives here.
- `src/pages/project/billing/AiaScheduleOfValues.tsx`: the SOV editor; has "Seed from estimate" + "Sync approved change orders" buttons; SOV table shows CO lines with a badge (isCo). seedSov(projectId, lines) replaces original (non-CO) lines.
- `src/pages/project/billing/AiaPayAppEditor.tsx`: G703 grid; the % cell is `<TD className="w-24">` (~299) with an `<Input type="number">` (~303) — too narrow; stored cell is `w-32` (~289).
- `src/pages/project/billing/PaymentsSection.tsx`: table header (~110) `Date | Applied to | Method | Amount | (delete)`; rows ~114-118; Total row colSpan={3} (~122). `p.note` is captured but not displayed.
- `src/pages/project/billing/AiaSettingsForm.tsx`: the settings form (retainage/owner/architect/etc.).
- money.ts formatMoney/dollarsToCents.

---

## Task 1: Pay-app % column width + payment notes column + Change Orders relocation

**Files:** `src/pages/project/billing/AiaPayAppEditor.tsx`, `src/pages/project/billing/PaymentsSection.tsx`, `src/pages/project/ProjectBilling.tsx` (+ maybe a new `src/pages/project/billing/ChangeOrdersSection.tsx`).

- [ ] **Step 1 (% column):** In AiaPayAppEditor, widen the % cell from `w-24` to at least `w-28` (match/approach the stored `w-32`) and ensure the `<Input>` shows its value — make the input `text-right` + full width of the cell, and if the number-spinner is eating space, it's fine, just give it room. Goal: a value like "66.67" or "100" is fully visible. (Bump the header `% (G/C)` TH width too if needed for alignment.)

- [ ] **Step 2 (payment notes):** In PaymentsSection, add a **Note** column to the payments table: add a `<TH>Note</TH>` (after Method, before Amount, or after Amount — place after Method) and a `<TD>{p.note || '—'}</TD>` in each row (muted, truncate if long). Update the Total row `colSpan` to account for the new column (was 3 → becomes 4 so "Total" still spans to the Amount column; verify the colSpan lines up with the new header count). The record-payment form already has the Note input — no change there.

- [ ] **Step 3 (Change Orders — one section, attached to the SOV/AIA area):** Move the Change Orders management UI so there's ONE change-orders section grouped with the AIA contract content (right AFTER AiaScheduleOfValues, BEFORE AiaPayApplications), with a clear "Change Orders" header. Cleanest: extract the change-orders card (the `changeOrders` state load + addChangeOrder/setChangeOrderStatus/deleteChangeOrder + the table) into a new `ChangeOrdersSection.tsx` (props: projectId, onChange to reload the summary), and render it in ProjectBilling between AiaScheduleOfValues and AiaPayApplications. REMOVE the old standalone Change orders card from its current position (after Invoices). Keep the header text "Change Orders". The SOV CO lines (badges) stay as-is (they're the billable CO lines); this just relocates the CO *management* section into the AIA grouping so COs aren't in two disconnected places. Wire onChange → reloadSummary (COs affect the contract total).
  - New section order in ProjectBilling: Summary → (AIA Settings) → Schedule of Values → **Change Orders** → Pay Applications → Invoices → Payments.

- [ ] **Step 4:** tsc/lint/test/build green. Commit `fix: AIA % column width, payment notes column, change-orders attached to SOV section`.

---

## Task 2: SOV xlsx upload (col A=description, col B=value) + help

**Files:** `src/pages/project/billing/AiaScheduleOfValues.tsx`.

- [ ] **Step 1:** Add an **"Upload sheet"** button next to "Seed from estimate" / "Sync change orders", and a small **"?" help button** beside it. The help button toggles a short inline note (or a small popover/tooltip): *"Upload an .xlsx where column A is the line description and column B is the scheduled value (dollars). The first row may be a header. Existing original lines will be replaced; change-order lines are kept."* (accessible: a button with aria-label; click toggles a visible help paragraph).

- [ ] **Step 2:** Implement the upload: a hidden `<input type="file" accept=".xlsx,.xls">`; on change, read the file as ArrayBuffer; parse with SheetJS — `import * as XLSX from 'xlsx'` (already a dep), `const wb = XLSX.read(buf, { type: 'array' })`, `const ws = wb.Sheets[wb.SheetNames[0]]`, `const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false }) as any[][]`. Build lines: for each row, description = String(row[0] ?? '').trim(), rawVal = row[1]; parse value as a number (strip $ , and whitespace if it's a string: `Number(String(rawVal).replace(/[$,\s]/g,''))`). SKIP rows where description is empty OR value isn't a finite number (this naturally skips a header row like ["Description","Value"]). `scheduledValueCents = Math.round(value * 100)`. If 0 valid rows → toast "No valid rows (need column A description + column B value)". Else: if existing original (non-CO) SOV lines exist, `useConfirm("Replace the schedule of values with N lines from the sheet?")`; then `seedSov(projectId, lines)` → reload + toast "Imported N line(s)". Reset the file input value so re-uploading the same file fires onChange.

- [ ] **Step 3:** tsc/lint/test/build green. (Manual: upload a 2-col sheet → SOV populates.) Commit `feat: AIA schedule-of-values xlsx upload (col A description, col B value) + help`.

---

## Task 3: Collapsible AIA Settings section

**Files:** `src/pages/project/billing/AiaSettingsForm.tsx` (or `ProjectBilling.tsx`).

- [ ] **Step 1:** Make the AIA Settings section a COLLAPSIBLE disclosure, **collapsed by default**. Cleanest: inside AiaSettingsForm, render a Card whose header is a button ("AIA Settings" + a chevron that rotates) toggling a local `open` state (default false); the form body renders only when `open`. (Or use a `<details>/<summary>` for built-in a11y.) Keep the Save behavior unchanged. The header should make clear it's the one-time owner/architect/retainage setup. Ensure it still loads/saves settings correctly when opened.

- [ ] **Step 2:** tsc/lint/test/build green. Commit `feat: collapsible AIA settings section (collapsed by default)`.

---

## Task 4: Verify + push

- [ ] **Step 1:** `npm run lint && npm test && npm run build` green.
- [ ] **Step 2:** Quick review (sonnet) over the 7c range: confirm UI-only (no store/route/migration change), the % input shows values, payment notes display + Total colSpan correct, Change Orders is a single section in the AIA grouping (header "Change Orders") with no duplicate, the xlsx upload parses col A/B + skips header/blank rows + seeds (replace-with-confirm), AIA settings collapsed-by-default + still saves. Fix any issue.
- [ ] **Step 3:** Push to testing. (No migration; no data risk.)
- [ ] **Step 4:** Memory — 7c polish shipped (UI). Manual-smoke: % values visible, payment notes shown, single Change Orders section under SOV, upload a 2-col xlsx to populate the SOV, AIA settings collapsed by default.

---

## Self-Review Notes (author)

- **UI-only:** no server/store/migration/exceljs changes; uses the existing seedSov + SheetJS `xlsx` (already a dep) for the upload.
- **Change Orders:** relocated (not duplicated) into the AIA contract grouping with a "Change Orders" header; SOV CO badge-lines remain (billable). onChange reloads the summary since COs affect the contract total.
- **xlsx upload:** col A=description, col B=value(dollars→cents); skips header/blank/non-numeric rows; replace-original-with-confirm (keeps CO lines, matching seedSov semantics); "?" help explains the format.
- **Settings collapsible:** collapsed by default (one-time setup), still saves when opened.
