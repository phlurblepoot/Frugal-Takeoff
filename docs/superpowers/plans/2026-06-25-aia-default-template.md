# Default AIA Workbook → Match "AIA SOV.xlsx" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rewrite the DEFAULT AIA Excel export (`buildAiaWorkbook` in `src/pages/project/billing/aiaExcel.ts`) so the generated G702/G703 workbook matches Nathan's template `docs/AIA SOV.xlsx`, with the **contract line-item section and the change-order section on G703 dynamically scaling** to the actual number of lines, and the **G702 sheet carrying the GC, project name, app number and period dates**. Keep formulas LIVE (inputs + formulas, not pre-computed values) like the template.

**Keep unchanged:** the admin "upload your own template" path (`buildAiaWorkbookFromTemplate`) and the download plumbing (`exportAiaXlsx`). The AIA data model + `computeG702`/`computeG703` in `aiaStore.ts`. Only the default workbook *layout* changes.

**Tech Stack:** exceljs (lazy-loaded), integer-cents money (write `cents/100` with `$#,##0.00`), the existing `AiaExportCtx`.

**SAFETY INVARIANT:** `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build` green. No DB/migration. `buildAiaWorkbookFromTemplate` + `aiaExcelTemplate.test.ts` untouched. The new workbook's totals/grand-total/G702 figures must reconcile to the app's computed `g702`/`g703` (verify numerically).

**Available data (`AiaExportCtx`):** `projectName`; `company {name,address,phone,email}`; `aiaSettings {retainagePercent, ownerName, ...}`; `app: AiaPayApp {number, periodTo, applicationDate, retainagePercent, storedRetainagePercent}`; `sovLines: AiaSovLine[]`; `g702: AiaG702 {L1..L9 cents, changeOrders{additions,deductions,net}}`; `g703: AiaG703Row[] {sovLineId, itemNo, description, isChangeOrder, scheduledValueCents, previousCents, thisPeriodCents, storedCents, totalToDateCents, percentComplete, balanceToFinishCents, retainageCents}`. Split `g703` by `isChangeOrder` (0 = contract, 1 = change order). Use a single retainage rate `R = (app.retainagePercent ?? aiaSettings.retainagePercent ?? 10) / 100`.

---

## TEMPLATE SPEC (from `docs/AIA SOV.xlsx`, verified via exceljs)

### G703 (Continuation Sheet) — columns A..J
A=item no · B=description · C=scheduled value · D=previous applications (D+E) · E=this period · F=materials stored · G=total completed&stored (`=D+E+F`) · H=% (`=G/C`, fmt `0.00%`) · I=balance to finish (`=C-G`) · J=retainage (`=SUM(D:E)*'G702'!$G$22`). Money fmt `$#,##0.00`.

Rows (template's fixed layout — we make these dynamic, see algorithm):
- **1-5:** header. A2=company name, A3/A4=company address lines; C2 "PROJECT:" D2=`='G702'!D3`; C3 "GC:" D3=`='G702'!D6`; H3 "Application #:" I3=`='G702'!H3`; H4 "Period From:" I4=`='G702'!H5`; H5 "Period To:" I5=`='G702'!H6`.
- **6:** column-letter row `A C D E F G H I J K` (decorative AIA col labels).
- **7-10:** tall merged column header (ITEM NO. / DESCRIPTION OF WORK / SCHEDULED VALUES / PREVIOUS APPLICATIONS (D+E) / THIS PERIOD / MATERIALS PRESENTLY STORED / TOTAL COMPLETED AND STORED / % / BALANCE TO FINISH / RETAINAGE). (A 4-row merged header; a 1-row header is acceptable if it reads cleanly — match the look reasonably.)
- **11-35:** contract line items. Per row: A=item, B=desc, C/D/E/F inputs, G `=D{r}+E{r}+F{r}`, H `=G{r}/C{r}`, I `=C{r}-G{r}`, J `=SUM(D{r}:E{r})*'G702'!$G$22`.
- **36:** contract TOTALS: B "TOTALS", C..G = `SUM(col11:col35)`, H `=G36/C36`, I/J = SUM.
- **~39:** "Change Orders" label.
- **~40:** column-letter row again; **41-44:** CO column header (same as 7-10).
- **45-61:** change-order line items (same per-row formulas).
- **62:** CO TOTALS (`SUM(col45:col61)`; G `=D62+E62+F62`; H `=G62/C62`).
- **63:** GRAND TOTAL: C..J = `={contractTotalRow}+{coTotalRow}` per column; H `=G63/C63`.

### G702 (Application & Certificate for Payment)
- A1 "APPLICATION AND CERTIFICATE FOR PAYMENT".
- A3 "TO (Owner):"; C3 "PROJECT:" **D3 = project name (input)**; G3 "APPLICATION NO:" **H3 = app number (input)**.
- G5 "PERIOD FROM:" **H5 (input, blank — not tracked)**; C6 "G. C. :" **D6 = GC/contractor (input)**; G6 "TO:" **H6 = period to (input)**.
- A7 "FROM:" B7=company name; G7 "TERMS:"; B8/B9 = company address lines.
- A11 "CONTRACTOR'S APPLICATION FOR PAYMENT".
- **Change Order Summary block** (A13 "CHANGE ORDER SUMMARY"; A14 NUMBER / B14 ADDITIONS / C14 DEDUCTIONS): list CO lines — number + addition referencing each CO scheduled value cell on G703; TOTALS row B=`SUM(additions)`, C=`SUM(deductions)`; "Net by Change Orders" = additions−deductions. (May reference the dynamic G703 CO `C` cells, or just write the additions from `g703` CO rows — either is fine as long as it reconciles.)
- **9 G702 lines** (label col D "1.".."9.", desc col E, amount col H, fmt `$#,##0.00`):
  1. ORIGINAL CONTRACT SUM = `='G703'!C{contractTotalRow}`
  2. NET CHANGE BY CHANGE ORDERS = CO additions − deductions (`='G703'!C{coTotalRow}` if no deductions, else the CO-summary net)
  3. CONTRACT SUM TO DATE = `=H{L1row}+H{L2row}`
  4. TOTAL COMPLETED & STORED TO DATE = `='G703'!G{contractTotalRow}+'G703'!G{coTotalRow}`
  5. RETAINAGE = `='G703'!J{contractTotalRow}+'G703'!J{coTotalRow}` (with G22 = retainage rate beside it)
  6. TOTAL EARNED LESS RETAINAGE = `='G703'!G{grand}-'G703'!J{grand}`
  7. LESS PREVIOUS CERTIFICATES = `='G703'!D{grand}-('G703'!D{grand}*'G702'!G22)`
  8. CURRENT PAYMENT DUE = `=H{L6row}-H{L7row}`
  9. BALANCE TO FINISH PLUS RETAINAGE = `='G703'!I{contractTotalRow}+'G703'!J{contractTotalRow}+'G703'!I{coTotalRow}+'G703'!J{coTotalRow}`
- **G22 = R** (retainage rate, fmt `0%`) — referenced by every J formula and lines 5/7.

---

## Task 1: Rewrite `buildAiaWorkbook` to the template layout (dynamic)

**Files:** `src/pages/project/billing/aiaExcel.ts` (rewrite `buildAiaWorkbook` only). Use an **opus** implementer.

- [ ] **Step 1 — Build G703 first (it's referenced by G702).** Lay out header rows 1-10 (company block + cross-refs to G702 + column-letter row + the tall column header), then:
  - `contract = g703.filter(r => !r.isChangeOrder)`, `cos = g703.filter(r => r.isChangeOrder)`.
  - Contract items start at row `C0 = 11`. Write one row per contract line: A=itemNo||sequence, B=description, C=`scheduledValueCents/100`, D=`previousCents/100`, E=`thisPeriodCents/100`, F=`storedCents/100`; G/H/I/J = the per-row FORMULAS (referencing that row). `contractTotalRow = C0 + contract.length`.
  - Contract TOTALS row at `contractTotalRow`: SUM formulas over `C0..contractTotalRow-1`.
  - Then a blank row, a "Change Orders" label row, a column-letter row, and the CO column header (mirror rows 7-10), then CO items starting at `K0`. `coTotalRow = K0 + cos.length`; CO TOTALS = SUM over the CO rows.
  - `grandRow = coTotalRow + 1`: GRAND TOTAL = contractTotalRow + coTotalRow per column.
  - Compute ALL these row numbers from the actual list lengths (never hardcode 36/62/63). Keep references to G702 cells (`'G702'!$G$22`, `'G702'!D3`, etc.) — those G702 cells are fixed.
- [ ] **Step 2 — Build G702** using the computed G703 row numbers in its formulas (lines 1-9 above), the inputs (D3=projectName, D6=ctx GC, H3=app.number, H6=app.periodTo, H5 blank), the FROM company block, G22=R, and the Change-Order Summary block listing the CO lines. Money fmt `$#,##0.00`; G22 fmt `0%`.
- [ ] **Step 3 — Styling/format parity:** column widths (G703 A≈11,B≈37,C≈16,D≈14,E≈13,F≈16,G≈16,H≈9,I≈14,J≈12; G702 A≈12,B≈35,C≈18,E≈20,H≈18), thin borders on the item grid + totals, bold headers/totals, wrap on the tall header, right-align money/%, sheet names exactly `G702` and `G703`, G702 first. Reasonable parity — not pixel-exact.
- [ ] **Step 4 — Reconcile:** the workbook's resolved figures must equal the app's `ctx.g702`/`ctx.g703` (e.g. contract TOTALS C = sum of contract scheduled = relates to g702.L1; grand totals reconcile). Since formulas are live, set each input cell from the matching `g703` row so the formulas resolve to the computed values. (Where the app's per-line retainage differs from the single-rate model, the single rate `R` governs — document this in a code comment.)
- [ ] **Step 5 — Update `aiaExcel.test.ts`** to assert the NEW structure: sheets `G702`/`G703` exist; given N contract + M change-order lines, the contract TOTALS row is at `11+N`, the CO TOTALS + grand-total rows are at the expected dynamic positions; spot-check key formulas reference the right dynamic rows (e.g. G702 line-1 = `'G703'!C{11+N}`); item input cells hold `cents/100`. Keep the test's spirit (it currently asserts the old layout — rewrite those assertions for the new one). Do NOT touch `aiaExcelTemplate.test.ts`.
- [ ] **Step 6 — Self-QA render:** write a TEMP node script (exceljs, like /tmp/inspect2.mjs) that calls `buildAiaWorkbook` with a stub ctx for (a) 3 contract + 2 CO lines and (b) 30 contract + 10 CO lines, writes the .xlsx, re-reads it, and prints the contract/CO/grand total rows + a few formulas — confirm the dynamic rows + formula refs are correct in both cases and nothing overlaps. DELETE the temp script before committing.
- [ ] **Step 7:** gates green. Commit `feat(aia): default G702/G703 export matches the Big Bear template (dynamic SOV + change-order sections)`.

---

## Task 2: Verify + push + memory

- [ ] **Step 1:** Full gates `npx tsc --noEmit && npm run lint && npm test && npm run build`.
- [ ] **Step 2:** Review (opus): the workbook matches the template's G702/G703 layout; contract + CO sections scale with line count; ALL totals/grand-total/G702 formulas re-anchor to the dynamic rows (no hardcoded 36/62/63); figures reconcile to ctx.g702/g703; G702 carries project/GC/app#/periodTo + retainage rate; `buildAiaWorkbookFromTemplate` + its test untouched; money is cents/100 with `$#,##0.00`. Fix issues.
- [ ] **Step 3:** Push to `testing`. (No migration.)
- [ ] **Step 4:** Memory — default AIA export now matches the Big Bear template (dynamic contract + CO sections, live formulas, single retainage rate from the pay app, G702 inputs) + manual-smoke (export a pay app with a few SOV + CO lines, open in Excel, confirm layout + formulas + totals) + note the single-rate decision.

---

## Self-Review Notes (author)

- **Dynamic = compute every row number from list lengths.** The template hardcodes 36/62/63 and `C45:C72`; the rewrite derives `contractTotalRow`, `coTotalRow`, `grandRow` and writes every SUM range + G702 reference against them. This is the whole point and the main risk — self-QA renders both small and large line counts.
- **Live formulas, inputs in C/D/E/F.** Matches the template (a GC can tweak in Excel and it recomputes), and the inputs come straight from the computed `g703` rows so the resolved values equal the app's numbers.
- **Single retainage rate** at G702!G22 to match the template (the app's per-line / stored-retainage nuance is collapsed to one rate in this export) — documented in code + memory.
- **Scope:** only `buildAiaWorkbook`. The admin upload-your-own-template path and download plumbing are untouched.
