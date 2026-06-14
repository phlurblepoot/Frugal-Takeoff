# Phase 7 — AIA Progress Billing (G702/G703) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add AIA-style progress billing: a per-project Schedule of Values (seeded from the estimate, editable), a monthly sequence of Pay Applications (% complete + stored materials per line), correct G702/G703 math (retainage, previous certificates, current payment due), and a faithful **G702 + G703 Excel export** for sending with each month's billing. New per-project AIA mode alongside the existing Phase 4a invoices; reuses approved change orders.

**Decisions (locked with Nathan):**
- Export = faithful G702 + G703 **recreation** (one `.xlsx` workbook per pay application, two sheets) via **exceljs** (borders/merges/number formats; SheetJS free build can't do borders). Existing takeoff xlsx export stays on `xlsx` — do not disturb it.
- Schedule of Values = **seeded from the estimate** (takeoffs grouped by `pricePackage`, cost computed CLIENT-side via `computeTakeoffTotals` + `calculateTakeoffTotalCost`), then fully editable.
- Retainage = project default % + a **separate stored-materials %**, with a **per-SOV-line override**; the pay-app's retainage %s default from the project but are **editable per application** (so the final app can drop retainage to release held amounts).
- Progress entry = **% complete to date per line** → compute completed $; derive "this period" = to-date − previous app; + **stored materials $** per line.
- Change orders = **approved COs append as their own SOV lines** (`isChangeOrder`); G702 L1 = original lines, L2 = CO lines, L3 = total.
- Billing model = **new AIA mode per project, alongside invoices** (mode stored on the project; the existing invoices stay for non-AIA projects). Reuse the existing `change_orders`.

**Architecture:** Server `aiaStore.ts` (integer-cents money, version-checked saves, the G702/G703 computation), admin-gated routes (like billingStore), three new tables (migration 12), project AIA settings in `projects.meta.aiaSettings`. Client store helpers + a client-side SOV-seed computation. UI inside the admin Billing section: a mode switch (Standard | AIA) → SOV editor + Pay Applications + the Excel export.

**SAFETY INVARIANT:** tsc/test/build green after every task. Money is INTEGER CENTS end-to-end (round per line; `!Number.isFinite` guards on inputs, like Phase 4a). The G702/G703 math is the correctness core → thorough characterization tests (Phase 5a/costAllocation style). Migration 12 is ADDITIVE (3 empty tables + meta round-trip) — no data risk; flag to Nathan before pull per protocol but nothing dropped.

**Tech Stack:** Express + better-sqlite3 (integer cents), React 19, exceljs (new dep), reuse `src/utils/costAllocation.ts` + `src/pages/project/proposal/proposalGenerator.ts` `computeTakeoffTotals` + `src/utils/math.ts` `calculateTakeoffTotalCost`. Vitest + Supertest.

**Pattern references:** `server/billingStore.ts` (cents helpers `toCents`/`sumCents`, error classes, version-checked save, admin routes), `server/issueStore.ts`/`punchStore.ts` (CRUD shape), `src/pages/project/ProjectBilling.tsx` (admin gate + section layout), `src/pages/project/billing/InvoiceEditor.tsx` (settings/company for the document), `src/utils/store.ts` punch/task helpers (409→ConflictError), migration 11 (additive table pattern), `projectStore.ts` loadProject/decomposeProject (meta JSON round-trip — `meta.archived` is the existing example).

**Key facts (from explore):**
- `change_orders` (migration 8): id, projectId, number, description, amount REAL, status ('pending'|'approved'|'rejected'), createdAt. Approved = `status='approved'`. billingStore `billingSummary` already rolls base `projects.contractValue` + approved COs.
- Takeoff COST is CLIENT-ONLY: `computeTakeoffTotals(project, currentPageIds)` (proposalGenerator) → quantities; `calculateTakeoffTotalCost(takeoff, totalValue)` (math) → dollars. Group by `takeoff.pricePackage`. The server does NOT compute cost → SOV seed is computed client-side + POSTed as cents.
- `projects.meta` JSON round-trips via projectStore loadProject (`Object.assign(project, meta)` ~line 46) + decomposeProject (stringify ~line 162). Add `meta.aiaSettings`.
- Company for "From Contractor": `getSettings()` keys `companyName||appName`, `companyAddress`, `companyPhone`, `companyEmail`, `logoUrl`.
- Latest migration = 11. Billing routes are `requireAdmin`. Tests baseline ~376.

---

## Data Model (migration 12, integer cents)

```sql
CREATE TABLE aia_sov_lines (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  itemNo TEXT,                       -- G703 col A (display label; e.g. '1','2','CO-1')
  description TEXT NOT NULL DEFAULT '',
  scheduledValueCents INTEGER NOT NULL DEFAULT 0,   -- G703 col C
  retainagePercent REAL,             -- per-line override (NULL = use pay-app/project %)
  isChangeOrder INTEGER NOT NULL DEFAULT 0,
  changeOrderId TEXT,                -- links to change_orders.id when isChangeOrder
  sortOrder INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL
);
CREATE INDEX idx_aia_sov_projectId ON aia_sov_lines (projectId);

CREATE TABLE aia_pay_apps (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  number INTEGER NOT NULL,           -- application no (1,2,3…) per project
  periodTo TEXT,                     -- 'YYYY-MM-DD'
  applicationDate TEXT,              -- 'YYYY-MM-DD'
  retainagePercent REAL NOT NULL DEFAULT 10,          -- on completed work, this app
  storedRetainagePercent REAL NOT NULL DEFAULT 10,    -- on stored materials, this app
  status TEXT NOT NULL DEFAULT 'draft',               -- draft | finalized
  version INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL
);
CREATE INDEX idx_aia_pay_apps_projectId ON aia_pay_apps (projectId);

CREATE TABLE aia_pay_app_lines (
  id TEXT PRIMARY KEY,
  payAppId TEXT NOT NULL,
  sovLineId TEXT NOT NULL,
  percentComplete REAL NOT NULL DEFAULT 0,            -- 0..100, to-date
  storedMaterialsCents INTEGER NOT NULL DEFAULT 0,    -- G703 col F (presently stored)
  createdAt INTEGER NOT NULL
);
CREATE INDEX idx_aia_pay_app_lines_payAppId ON aia_pay_app_lines (payAppId);
```

`meta.aiaSettings` (project): `{ billingMode: 'standard'|'aia', retainagePercent, storedRetainagePercent, ownerName, ownerAddress, architectName, architectAddress, contractDate, ownerProjectNumber, architectProjectNumber, contractFor }`.

**Computation (all integer cents, round per line):**
- Per SOV line, for a pay app: `completedToDateCents = Math.round(scheduledValueCents * line.percentComplete / 100)`; `presentlyStoredCents = line.storedMaterialsCents`; `totalCompletedAndStored (col G) = completedToDateCents + presentlyStoredCents`; `previousCents (col D) = the prior app's completedToDate for this sovLine (0 if app #1 or line absent)`; `thisPeriodCents (col E) = completedToDateCents - previousCents`; `balanceToFinish = scheduledValueCents - totalCompletedAndStored`; `lineRetainage% = sovLine.retainagePercent ?? payApp.retainagePercent`.
- G702: L1 = Σ scheduledValue (isChangeOrder=0); L2 = Σ scheduledValue (isChangeOrder=1); L3 = L1+L2; L4 = Σ col G; L5a = Σ round(completedToDateCents × lineRetainage%/100); L5b = Σ round(presentlyStoredCents × payApp.storedRetainagePercent/100); L5 = L5a+L5b; L6 = L4−L5; L7 = prior app's L6 (0 for #1); L8 = L6−L7 (current payment due); L9 = L3−L6 (balance to finish incl retainage). Change-order summary box: additions = Σ approved CO amounts > 0, deductions = Σ < 0, net = L2.

---

## Task 1: Migration 12 + project AIA settings round-trip

**Files:** `server/migrationList.ts`, `server/migrationList.test.ts`, `server/projectStore.ts` (meta.aiaSettings load/save), `server/projectStore.test.ts` (if present), `server/projectStore.ts` cascade (delete aia rows on project delete).

- [ ] **Step 1:** Failing migration test: after migrations, `aia_sov_lines`, `aia_pay_apps`, `aia_pay_app_lines` exist with the right columns.
- [ ] **Step 2:** Append migration 12 `aia-billing` with the three CREATE TABLEs + indexes above (additive). Ensure `crypto` import (already present).
- [ ] **Step 3:** projectStore: confirm `meta` round-trips arbitrary keys (it does via Object.assign + stringify). Add `aiaSettings` to the meta that loadProject merges + decomposeProject persists (if meta is whitelisted, add `aiaSettings`; if it's pass-through, no change — verify). Add a test that a project's `meta.aiaSettings` survives save→load.
- [ ] **Step 4:** Extend `deleteProject` cascade: delete `aia_pay_app_lines` (subquery on this project's pay apps) → `aia_pay_apps` → `aia_sov_lines`, alongside the existing issue/punch cascades.
- [ ] **Step 5:** Run migration + projectStore tests → green. tsc clean.
- [ ] **Step 6:** Commit `feat: migration 12 AIA billing tables + project aiaSettings + cascade`.

---

## Task 2: aiaStore — Schedule of Values (CRUD, seed, sync change orders)

**Files:** Create `server/aiaStore.ts`, `server/aiaStore.test.ts`.

- [ ] **Step 1:** Failing tests (mirror billingStore/punchStore test setup; seed a project + a couple change_orders):
  - createSovLine / listSovLines (ordered by sortOrder, isChangeOrder last? — original lines first, CO lines after; use sortOrder with CO lines appended) / getSovLine.
  - saveSovLine (version-checked → ConflictError; validates scheduledValueCents is a finite integer ≥0; retainagePercent 0..100 or null).
  - deleteSovLine.
  - seedSovLines(projectId, lines[]) — bulk insert `[{ description, scheduledValueCents, itemNo? }]` (from the client estimate computation); REPLACES existing NON-changeorder lines (or appends — decide: replace original lines, keep CO lines) — document the behavior; assign sortOrder + itemNo sequentially.
  - syncChangeOrders(projectId) — for each `change_orders` row with status='approved' that has no aia_sov_line with changeOrderId=that id, append an SOV line { isChangeOrder:1, changeOrderId, description: co.description, scheduledValueCents: toCents(co.amount), itemNo: 'CO-'+co.number }. Idempotent (re-run adds nothing new). Returns count added.
- [ ] **Step 2:** Implement `server/aiaStore.ts`: error classes (ValidationError/ConflictError/NotFoundError), integer-cents helpers, `requireProject`, the SOV functions above. Money as integer cents (the column is INTEGER). Use `Number.isFinite`/`Number.isInteger` guards.
- [ ] **Step 3:** Tests green; tsc clean. Commit `feat: aia store — schedule of values CRUD, seed, change-order sync`.

---

## Task 3: aiaStore — Pay Applications + G702/G703 computation (the correctness core)

**Files:** modify `server/aiaStore.ts`, `server/aiaStore.test.ts`.

- [ ] **Step 1:** Failing tests covering pay-app CRUD + the MATH (characterization — assert exact cents):
  - createPayApp(projectId, { periodTo, applicationDate }) — assigns next `number` (MAX+1 per project, in a transaction), defaults retainage %s from the project's aiaSettings (passed in or read), and seeds `aia_pay_app_lines` for every current SOV line carrying forward the PRIOR app's percentComplete + storedMaterials (so each month starts from last month's position). Returns {id, number}.
  - listPayApps / getPayApp (returns the app + its lines).
  - savePayAppLines(payAppId, lines[], version) — version-checked on the pay app; updates percentComplete (0..100, finite) + storedMaterialsCents (finite int ≥0) per line.
  - setPayAppStatus(id, status), deletePayApp(id) (cascade its lines).
  - `computeG703(db, payAppId)` → per-line rows { sovLineId, itemNo, description, scheduledValueCents, previousCents(D), thisPeriodCents(E), storedCents(F), totalToDateCents(G), percent, balanceToFinishCents, retainageCents }. `previousCents` from the prior app (number−1) line for the same sovLine.
  - `computeG702(db, payAppId)` → { L1originalContract, L2changeOrders, L3contractSumToDate, L4totalCompletedStored, L5aRetainageWork, L5bRetainageStored, L5retainage, L6earnedLessRetainage, L7lessPrevious, L8currentPaymentDue, L9balanceToFinish, changeOrders:{additions,deductions,net} } — all integer cents.
  - **Math test cases (assert exact):** a 2-line SOV (e.g. 100000¢ + 50000¢), app#1 at 50%/0% with 0 stored → verify D/E/G, retainage at 10%, L1-L9. App#2 at 75%/100% with some stored → verify previous(D)=app#1 toDate, thisPeriod(E)=delta, L7=app#1 L6, L8 current due. A per-line retainage override. A CO line included → L2/L3. Round-per-line (use values that expose rounding). These tests LOCK IN the AIA math.
- [ ] **Step 2:** Implement. The compute functions are pure-ish (read db, return cents). createPayApp's carry-forward + number sequencing in a transaction (no collision). Reuse toCents only where converting CO dollars; SOV/stored are already cents.
- [ ] **Step 3:** Tests green; tsc clean. Commit `feat: aia store — pay applications + G702/G703 computation`.

---

## Task 4: Routes (admin-gated) + tests

**Files:** `server/routes.ts`, `server/routes.test.ts`.

- [ ] **Step 1:** Failing integration tests (admin token; confirm requireAdmin → 403 for non-admin, matching billing):
  - SOV: `GET/POST /api/projects/:id/aia/sov`, `PUT/DELETE /api/aia/sov/:lineId`, `POST /api/projects/:id/aia/sov/seed`, `POST /api/projects/:id/aia/sov/sync-change-orders`.
  - Pay apps: `GET/POST /api/projects/:id/aia/pay-apps`, `GET /api/aia/pay-apps/:id` (with lines + computed G702/G703), `PUT /api/aia/pay-apps/:id/lines` (version-checked → 409), `PATCH /api/aia/pay-apps/:id` (status/retainage), `DELETE /api/aia/pay-apps/:id`.
  - AIA settings: `GET/PUT /api/projects/:id/aia/settings` (reads/writes meta.aiaSettings).
- [ ] **Step 2:** Implement: import aiaStore (aliased errors), an `aiaErr` mapper (NotFound→404, Conflict→409 code 'version_conflict', Validation→400), all routes `authenticateToken, requireAdmin`. The pay-app GET returns `{ app, lines, g703, g702 }` (computed). Settings routes read/write the project meta via projectStore.
- [ ] **Step 3:** Tests green; tsc clean. Commit `feat: AIA billing routes (admin-gated) + settings`.

---

## Task 5: Client store helpers + SOV-seed computation

**Files:** `src/utils/store.ts`.

- [ ] **Step 1:** Types: `AiaSovLine`, `AiaPayApp`, `AiaPayAppLine`, `AiaG702`, `AiaG703Row`, `AiaSettings`. Helpers (mirror punch/task helpers + 409→ConflictError on the version-checked ones): getSov, saveSovLine, createSovLine, deleteSovLine, seedSov, syncChangeOrders, getPayApps, createPayApp, getPayApp (returns app+lines+g702+g703), savePayAppLines, setPayAppStatus, deletePayApp, getAiaSettings, saveAiaSettings.
- [ ] **Step 2:** A client-side seed computation `computeSovSeedFromEstimate(project): { description, scheduledValueCents }[]` — uses `computeTakeoffTotals(project, allCurrentPageIds)` + `calculateTakeoffTotalCost(takeoff, totalRealValue)`, groups by `takeoff.pricePackage` ('Uncategorized' when blank), sums cost per package → `Math.round(dollars*100)` cents per group. (Put it where it can import those utils; if circular, inline the grouping.) The SOV editor calls this then `seedSov(projectId, lines)`.
- [ ] **Step 3:** tsc clean; `npm test` green. Commit `feat: client store — AIA types, helpers, estimate-seed computation`.

---

## Task 6: UI — Billing mode switch + AIA settings + Schedule of Values editor

**Files:** `src/pages/project/ProjectBilling.tsx`; create `src/pages/project/billing/aia/AiaScheduleOfValues.tsx`, `src/pages/project/billing/aia/AiaSettingsForm.tsx`.

- [ ] **Step 1:** In ProjectBilling (admin), add a **billing-mode switch** (Standard | AIA) bound to `aiaSettings.billingMode` (load/save via getAiaSettings/saveAiaSettings). When AIA: render the AIA UI (settings form + SOV + pay-apps); when Standard: the existing invoices UI. Keep both reachable.
- [ ] **Step 2:** `AiaSettingsForm` — edit retainagePercent, storedRetainagePercent, owner name/address, architect name/address, contract date, owner/architect project numbers, contract-for. Save to meta.aiaSettings.
- [ ] **Step 3:** `AiaScheduleOfValues` — load getSov; a "Seed from estimate" button (computeSovSeedFromEstimate → seedSov → reload; confirm if it replaces existing original lines); a "Sync approved change orders" button (syncChangeOrders → reload); a table of SOV lines (itemNo, description, scheduled value $, per-line retainage % override, CO badge); add/edit/delete/reorder lines (version-checked saves; money entered in dollars, stored as cents). Show the total scheduled value (= contract sum to date) + the original/CO split.
- [ ] **Step 4:** tsc/lint/test/build green. Commit `feat: AIA billing UI — mode switch, settings, schedule of values`.

---

## Task 7: UI — Pay Applications list + editor

**Files:** create `src/pages/project/billing/aia/AiaPayApplications.tsx`, `src/pages/project/billing/aia/AiaPayAppEditor.tsx`; wire into `AiaScheduleOfValues`/ProjectBilling AIA view.

- [ ] **Step 1:** `AiaPayApplications` — list pay apps (App #, period to, status, current payment due from g702.L8); "New application" (createPayApp with period/date) → opens the editor; open/delete.
- [ ] **Step 2:** `AiaPayAppEditor` — load getPayApp ({app, lines, g702, g703}). Per SOV line: editable **% complete** (0-100) + **stored materials $**; show computed D/E/F/G/%/balance/retainage live (recompute on change, or save→reload). Editable retainage % + stored retainage % + period/date for the app. A G702 totals summary panel (L1–L9 + current payment due, change-order box). Version-checked Save (savePayAppLines). Finalize (setPayAppStatus). An **"Export AIA Excel"** button (wired in Task 8). key={id:version} remount after save.
- [ ] **Step 3:** tsc/lint/test/build green. Commit `feat: AIA pay applications list + editor (G702/G703 live totals)`.

---

## Task 8: AIA Excel export (exceljs G702 + G703)

**Files:** `package.json` (+exceljs), create `src/pages/project/billing/aia/aiaExcel.ts` (+ a test); wire the export button in `AiaPayAppEditor`.

- [ ] **Step 1:** `npm i exceljs`. Create `aiaExcel.ts` exporting `buildAiaWorkbook(ctx): ExcelJS.Workbook` and `exportAiaXlsx(ctx)` (writes + triggers browser download `AIA-<project>-App<N>.xlsx`). `ctx = { project, settings(company), sovLines, app, g702, g703Rows, priorAppNumber }`.
- [ ] **Step 2:** Build TWO worksheets with proper layout (borders, merged cells, column widths, `$#,##0.00` number formats, `0%` for percent):
  - **G702** (Application and Certificate for Payment): header block (To Owner, Project, From Contractor [company from settings], Via Architect, Contract For, Contract Date, Application No [app.number], Period To, Application Date, Owner/Architect Project Nos); the certificate body lines **1–9** with labels + values (use g702.L1..L9); the Change Order summary box (additions/deductions/net this period + to date); contractor's certification + architect's certification blocks with blank signature/date lines; "Amount Certified" line. Match the standard AIA G702 layout closely (boxed, two-column figures on the right).
  - **G703** (Continuation Sheet / Schedule of Values): header (same project/app/date refs); the columns **A Item No | B Description of Work | C Scheduled Value | D Work Completed From Previous Application | E This Period | F Materials Presently Stored | G Total Completed and Stored to Date | (G/C)% | Balance to Finish | Retainage**; one row per g703Row; a **Grand Totals** row (sums = the G702 figures, must reconcile). Bordered grid, right-aligned money, repeated header.
  - Money cells: store as dollars number with `$#,##0.00` format (convert cents→dollars: `cents/100`). Percent as fraction with `0%` or as a number with `%` — match the form.
- [ ] **Step 3:** Wire the "Export AIA Excel" button in AiaPayAppEditor → `exportAiaXlsx({...})`.
- [ ] **Step 4:** Test `aiaExcel.test.ts` — call buildAiaWorkbook with a known ctx; assert it has 2 worksheets named G702/G703, the G703 has the right number of data rows + a totals row, and a couple of key cells (e.g. the grand-total scheduled value, current-payment-due) hold the expected values. (Don't assert pixel layout; assert structure + key numbers reconcile with g702/g703.)
- [ ] **Step 5:** tsc/lint/test/build green. Commit `feat: AIA G702/G703 Excel export (exceljs)`.

---

## Task 9: Full verification + push

- [ ] **Step 1:** `npm run lint && npm test && npm run build` green. (E2E unaffected; the AIA UI is new — optional to add an e2e later.)
- [ ] **Step 2:** Live API smoke (temp dir, admin/admin): create a project + a couple takeoffs; POST seed SOV; create an approved change order + sync → CO line appears; create pay app #1, set line %s + stored, GET pay app → verify g702 L1-L9 + g703 cents are correct (cross-check by hand for one case); create app #2 → previous(D)=app1 toDate, L7=app1 L6; non-admin → 403 on AIA routes. Note: the Excel visual must be eyeballed by Nathan (open the .xlsx).
- [ ] **Step 3:** Final review — opus over the Phase 7 range. Focus: (1) the G702/G703 MATH is correct (L1-L9, retainage with per-line override + stored %, previous-from-prior-app, round-per-line, integer cents — no float drift; verify against the characterization tests); (2) admin gating on every AIA route; (3) version-checked saves → 409; (4) seed/sync-COs idempotency + cents conversion; (5) the Excel workbook reconciles (G703 grand totals == G702 figures); (6) cascade delete; (7) no disturbance to the existing invoices/takeoff-xlsx export. Fix Critical/Important.
- [ ] **Step 4:** Push to testing. Migration 12 is ADDITIVE (3 empty tables) — tell Nathan before pull, nothing dropped.
- [ ] **Step 5:** Memory — Phase 7 AIA progress billing shipped; the model (sov_lines/pay_apps/pay_app_lines + meta.aiaSettings), the math, the exceljs export; manual-smoke list (seed SOV, sync COs, pay-app %/stored, G702/G703 totals, **eyeball the exported .xlsx layout**, non-admin gating). Note deferred: retainage release UX beyond per-app %, tax, multi-currency.

---

## Self-Review Notes (author)

- **Money correctness is the #1 risk** (Phase 4a hit float bugs): AIA is integer cents end-to-end, round-per-line, `Number.isFinite` guards; Task 3's characterization tests lock in L1-L9 + retainage + this-period derivation. The Excel export converts cents→dollars only at the cell.
- **Reuse, not fork:** approved change orders feed both L2 and (via sync) SOV CO-lines; the SOV seed reuses computeTakeoffTotals + calculateTakeoffTotalCost; settings/company reuse getSettings; admin gating + section layout reuse ProjectBilling.
- **Coexist:** AIA is a per-project mode; the Phase 4a invoices are untouched for non-AIA projects. The existing takeoff xlsx export stays on SheetJS; exceljs is added only for the styled AIA forms.
- **Additive migration:** 3 new empty tables + meta round-trip; no data transform → no data risk (flag-before-pull only).
- **Deferred (note for Nathan):** retainage release as an explicit workflow (handled for now via per-app retainage %); sales tax; the official AIA-licensed form file (we ship a faithful recreation — if he later wants his exact template filled, that's an additive export mode).
