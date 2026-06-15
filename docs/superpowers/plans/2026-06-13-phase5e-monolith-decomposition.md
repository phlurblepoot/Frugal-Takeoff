# Phase 5e — ProjectView / CanvasView Monolith Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Decompose the ProjectView (~3,743 LOC) and CanvasView (~3,380 LOC) monoliths via BEHAVIOR-PRESERVING extractions — prioritizing the cross-file DEDUPLICATIONS (shared EditTakeoffModal, shared delete-confirm, shared cost-allocation logic) and clean self-contained pieces. Each extraction is tsc/build-verified.

**Architecture & scope boundary (IMPORTANT):** The canvas/takeoff UI has NO automated test coverage (only `math.ts` is tested, from 5a). Therefore this phase extracts ONLY the **low-coupling, tsc-verifiable seams** and the **duplications**. The deeply-stateful core — CanvasView's drawing/measurement engine, ProjectView's pages grid/list and the takeoffs table — is **DEFERRED** to a future pass that first builds E2E/UI test coverage; extracting it blind would risk the core estimating workflow (spec §10 risk). This is a deliberate, honest boundary, not incompleteness.

**SAFETY INVARIANT:** tsc-clean + `npm test` green + `npm run build` succeed after EVERY task. Every extraction is a verbatim MOVE of JSX/logic into a component/module with explicit props — no behavior, styling, class, or number changes. Where a piece is duplicated across both files, extract ONCE and import in both, parametrizing only genuine differences.

**Tech Stack:** React 19, TypeScript, the ui component library, Vitest. Reuse `math.ts`/`store.ts`.

**Pattern references:** the proposal extraction (5b) is the model for behavior-preserving moves; `CustomCostRow` (5a) is the model for shared-component dedup with a prop for the one difference.

**Deferred (NOT in this phase — needs UI tests first):** Pages grid/list render (~290 LOC, ~18 state deps), Takeoffs table + mobile cards (~600 LOC, ~20 deps), CanvasView drawing core (startMeasurement/addPoint/finishMeasurement + canvas overlay, 40+ deps), the big inline upload handlers (handleAddPages/handleRetryFailedPages). These stay in place.

---

## File Structure

**Create:**
- `src/components/EditTakeoffModal.tsx` (+ `.test.tsx`) — shared, replaces the duplicated modal in both files
- `src/components/DeleteConfirmModal.tsx` — generic confirm dialog
- `src/utils/costAllocation.ts` (+ `.test.ts`) — shared cost-breakdown helpers (dedup Excel export ↔ takeoffs table)
- `src/pages/project/EmailTab.tsx` — the ProjectView email tab
- `src/components/canvas/ScaleCalibrationModal.tsx`, `KeyboardShortcutsModal.tsx`, `ToolDisabledModal.tsx` — CanvasView small modals
- `src/components/AddPagesModal.tsx` — ProjectView add-pages modal (inline → component)

**Modify:** `src/pages/ProjectView.tsx`, `src/pages/CanvasView.tsx` (import the extracted pieces, delete the inline copies).

---

## Task 1: Shared EditTakeoffModal (dedup ProjectView + CanvasView)

The edit-takeoff modal is ~98% duplicated between the two files (~174 LOC in ProjectView, ~156 in CanvasView; ProjectView's version has an extra `pricePackage` field). Extract once.

**Files:** Create `src/components/EditTakeoffModal.tsx` (+ test); modify both pages.

- [ ] **Step 1: Read** both modal bodies (ProjectView: the `editingTakeoff && (...)` modal block; CanvasView: same). Diff them mentally — confirm the ONLY structural difference is ProjectView's price-package input (+ its `editTakeoffPricePackage` state). Note every state slice + setter + handler each reads (editingTakeoff, editTakeoffName/Color/Unit/CostPerUnit, isEditTakeoffAdvanced, editTakeoffCustomCosts + setters, onSave handler, CustomCostRow, UNIT_LABELS, project).

- [ ] **Step 2: Create `src/components/EditTakeoffModal.tsx`** — a controlled component taking ALL the state slices + setters + `onSave`/`onClose` as props (the parents keep owning the state; this is a presentational extraction). Props (adjust to real types):
  ```ts
  interface EditTakeoffModalProps {
    editingTakeoff: MeasurementTakeoff | null;
    name: string; setName: (v: string) => void;
    color: string; setColor: (v: string) => void;
    unit: string; setUnit: (v: string) => void;
    costPerUnit: number | ''; setCostPerUnit: (v: number | '') => void;
    isAdvanced: boolean; setIsAdvanced: (v: boolean) => void;
    customCosts: any[]; setCustomCosts: (v: any[]) => void;
    onSave: () => void | Promise<void>;
    onClose: () => void;
    // ProjectView-only:
    pricePackage?: string; setPricePackage?: (v: string) => void;
    showPricePackage?: boolean;   // render the price-package field + datalist
    pricePackageOptions?: string[];
  }
  ```
  Paste the ProjectView modal JSX VERBATIM (it's the superset), wiring each value/onChange to the props instead of the local state/setters. Guard the price-package field behind `showPricePackage`. Keep `CustomCostRow` usage identical (import it). Keep all classes/structure.

- [ ] **Step 3: Wire ProjectView** — delete the inline modal JSX; render `<EditTakeoffModal editingTakeoff={editingTakeoff} name={editTakeoffName} setName={setEditTakeoffName} ... showPricePackage pricePackage={editTakeoffPricePackage} setPricePackage={setEditTakeoffPricePackage} pricePackageOptions={...the existing options...} onSave={handleSaveEditTakeoff} onClose={() => setEditingTakeoff(null)} />`. Keep the state in ProjectView. Remove now-dead imports if any.

- [ ] **Step 4: Wire CanvasView** — same, WITHOUT the price-package props (`showPricePackage` omitted/false). Keep CanvasView's state.

- [ ] **Step 5: Add `EditTakeoffModal.test.tsx`** — a light render test: renders when `editingTakeoff` set, shows the name value, calls `onSave` when the save button clicked, shows the price-package field only when `showPricePackage`. (jsdom + the ui kit.)

- [ ] **Step 6: Verify** — `npx tsc --noEmit` clean; `npm run lint`; `npm test` green; `npm run build`. Grep both pages: the inline edit-takeoff modal JSX is gone; `EditTakeoffModal` imported in both.

- [ ] **Step 7: Commit**

```bash
git add src/components/EditTakeoffModal.tsx src/components/EditTakeoffModal.test.tsx src/pages/ProjectView.tsx src/pages/CanvasView.tsx
git commit -m "refactor: extract shared EditTakeoffModal, dedupe from ProjectView + CanvasView"
```

---

## Task 2: Generic DeleteConfirmModal (dedup the confirm dialogs)

ProjectView has delete-takeoff + delete-all-takeoffs confirms; CanvasView has delete-measurement + delete-takeoff confirms. They're near-identical simple yes/no modals.

**Files:** Create `src/components/DeleteConfirmModal.tsx`; modify both pages.

- [ ] **Step 1: Read** the confirm-modal blocks in both files. Create `src/components/DeleteConfirmModal.tsx`:
  ```ts
  interface DeleteConfirmModalProps {
    open: boolean; title: string; message: React.ReactNode;
    confirmLabel?: string;            // default 'Delete'
    onConfirm: () => void | Promise<void>;
    onClose: () => void;
    busy?: boolean;
  }
  ```
  Use the existing Modal/Button ui primitives (match the markup the inline confirms use — copy one of them as the template; use the app's danger-button styling).

- [ ] **Step 2: Replace** each inline confirm in ProjectView (delete-takeoff, delete-all-takeoffs) and CanvasView (delete-measurement, delete-takeoff) with `<DeleteConfirmModal open={...} title="..." message={...} onConfirm={...} onClose={...} />`, preserving each one's exact title/message/confirm action. Remove the now-dead inline JSX.

- [ ] **Step 3: Verify** — tsc/lint/test/build green.

- [ ] **Step 4: Commit**

```bash
git add src/components/DeleteConfirmModal.tsx src/pages/ProjectView.tsx src/pages/CanvasView.tsx
git commit -m "refactor: shared DeleteConfirmModal, dedupe confirm dialogs"
```

---

## Task 3: costAllocation utility (dedup + tests)

ProjectView's Excel export and the takeoffs-table render BOTH compute per-takeoff cost breakdowns (allocate a subset value → cost, build cost-detail rows). This logic (~140 LOC) is duplicated. Extract to a tested pure module.

**Files:** Create `src/utils/costAllocation.ts` (+ test); modify `src/pages/ProjectView.tsx`.

- [ ] **Step 1: Read** the Excel-export cost logic (in `handleExportExcel`) and the takeoffs-table cost logic (the inline `allocateSubsetCost`/`allocateSubsetDetails`/`buildUnitCost` or equivalent). Identify the shared pure functions. They build on `calculateTakeoffTotalCost`/`calculateTakeoffCostDetails` from `math.ts`.

- [ ] **Step 2: Create `src/utils/costAllocation.ts`** exporting the shared pure helpers (e.g. `allocateSubsetCost(takeoff, subsetValue): number`, `allocateSubsetDetails(takeoff, subsetValue): CostDetail[]`, `buildUnitCostLabel(...)`). MOVE the logic verbatim; do not change the math. If the two call sites differ slightly, parametrize — but keep each call site's numeric output identical.

- [ ] **Step 3: Replace** both call sites in ProjectView to use the module functions. (Both Excel export AND the takeoffs table now call the single impl.)

- [ ] **Step 4: Tests** `src/utils/costAllocation.test.ts` — characterization tests deriving expected values from the real functions (cover flat/yield/unit/amount_per_units allocations and a multi-cost takeoff). This EXTENDS the math safety net.

- [ ] **Step 5: Verify** — tsc/lint/test/build green; the takeoffs table + Excel export still produce the same numbers (verify by reading, since output is data not asserted in-app).

- [ ] **Step 6: Commit**

```bash
git add src/utils/costAllocation.ts src/utils/costAllocation.test.ts src/pages/ProjectView.tsx
git commit -m "refactor: extract shared costAllocation utility (dedup excel/table) + tests"
```

---

## Task 4: Extract EmailTab from ProjectView

The email tab (~92 LOC) is a clean seam with isolated state (`expandedThreadKeys`).

**Files:** Create `src/pages/project/EmailTab.tsx`; modify `src/pages/ProjectView.tsx`.

- [ ] **Step 1: Read** the `activeTab === 'email'` block. Create `src/pages/project/EmailTab.tsx` as a component taking `{ project: Project; onOpenProposal: () => void }` (or `projectId` for navigation). MOVE the JSX verbatim; lift `expandedThreadKeys` state INTO the new component (it's used only here). Keep the proposal-sent badge + thread expand/iframe rendering identical.

- [ ] **Step 2: Replace** the inline block in ProjectView with `<EmailTab project={project} onOpenProposal={() => navigate(\`/project/${projectId}/proposal\`)} />`. Remove the now-unused `expandedThreadKeys` state from ProjectView.

- [ ] **Step 3: Verify** — tsc/lint/test/build green.

- [ ] **Step 4: Commit**

```bash
git add src/pages/project/EmailTab.tsx src/pages/ProjectView.tsx
git commit -m "refactor: extract EmailTab from ProjectView"
```

---

## Task 5: Extract CanvasView small modals

Extract the three self-contained CanvasView modals: ScaleCalibrationModal (~100 LOC), KeyboardShortcutsModal (~51), ToolDisabledModal (~25).

**Files:** Create `src/components/canvas/ScaleCalibrationModal.tsx`, `KeyboardShortcutsModal.tsx`, `ToolDisabledModal.tsx`; modify `src/pages/CanvasView.tsx`.

- [ ] **Step 1:** For each modal, create a component taking its few props (state values + setters + close/apply callbacks), moving the JSX verbatim. ScaleCalibrationModal props: open, pixelDistance, scaleInput+setter, scaleUnit+setter, calibratingRegionId, onApply, onClose. KeyboardShortcutsModal: open, onClose (+ the shortcut list — keep it inside the component). ToolDisabledModal: message, onClose.

- [ ] **Step 2:** Replace the inline blocks in CanvasView with the components, keeping the state in CanvasView. Remove dead JSX.

- [ ] **Step 3: Verify** — tsc/lint/test/build green.

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas/ src/pages/CanvasView.tsx
git commit -m "refactor: extract CanvasView scale/shortcuts/tool-disabled modals"
```

---

## Task 6: Extract AddPagesModal from ProjectView

The add-pages modal is ~213 LOC of inline JSX (a multi-step form). Extract to a component; the handlers (handleAddPages/handleConfirmAddPages) stay in ProjectView and are passed as props.

**Files:** Create `src/components/AddPagesModal.tsx`; modify `src/pages/ProjectView.tsx`.

- [ ] **Step 1: Read** the add-pages modal block + the state it reads (showAddPagesModal, addPagesStep, newPlanSet*, useExistingPlanSet, targetPlanSetId, pendingPages/Thumbnails, isAddingPages, addProgress, selectedPlanSetId) + the handlers + `PageNamingStep` + `orderedPlanSets`. Create `src/components/AddPagesModal.tsx` taking all those as props (controlled — state stays in ProjectView). MOVE the JSX verbatim, wiring to props. Keep `PageNamingStep` usage identical.

- [ ] **Step 2: Replace** the inline modal with `<AddPagesModal ...all props... />`. Remove the dead JSX.

- [ ] **Step 3: Verify** — tsc/lint/test/build green.

- [ ] **Step 4: Commit**

```bash
git add src/components/AddPagesModal.tsx src/pages/ProjectView.tsx
git commit -m "refactor: extract AddPagesModal from ProjectView"
```

---

## Task 7: Full verification + push

- [ ] **Step 1: Full gate** — `npm run lint && npm test && npm run build` green. Report the new LOC of ProjectView + CanvasView and the test count.

- [ ] **Step 2: Smoke (note for Nathan — manual/browser, since canvas/takeoff UI has no automated coverage):** the riskiest checks are the moved modals — edit a takeoff (advanced costs, save) from BOTH the takeoff list (ProjectView) and the canvas sidebar (CanvasView); delete a takeoff/measurement; calibrate scale on the canvas; add pages; view the email tab; download the Excel export and confirm the cost numbers match the takeoffs table. These exercise every extraction.

- [ ] **Step 3: Final review** — dispatch an opus code-review over the 5e range. Focus: (1) every extraction is a verbatim move — diff each new component against the pre-commit inline JSX (no class/number/logic drift); (2) the shared EditTakeoffModal preserves BOTH call sites' behavior (price-package only in ProjectView; custom-cost rows work in both); (3) costAllocation produces identical numbers at both call sites (Excel + table); (4) no state was accidentally dropped or duplicated; (5) no dangling refs; tsc/test/build green. Fix Critical/Important.

- [ ] **Step 4: Push**

```bash
git push origin testing
```

- [ ] **Step 5: Memory** — record 5e shipped: safe decomposition done (shared EditTakeoffModal + DeleteConfirmModal + costAllocation dedups, EmailTab + CanvasView modals + AddPagesModal extracted); ProjectView/CanvasView LOC reduced by ~N. **Explicitly note the DEFERRED core** (pages grid, takeoffs table, drawing engine) needs E2E/UI test coverage before it can be safely decomposed — that's the next refactor pass. Phase 5 (pragmatic scope) is then complete; a11y/print pass also still deferred.

---

## Self-Review Notes (author)

- **Honest boundary:** This phase does the SAFE ~half of the decomposition (dedups + clean seams, tsc-verifiable) and DEFERS the stateful core (drawing/grid/table) because there's no UI test coverage to catch regressions and the canvas can't be smoke-tested here. Pushing further blind would risk the core estimating workflow — the exact thing spec §2/§10 says to protect.
- **Dedup-first:** the highest-value tasks (1–3) eliminate real cross-file duplication (~525 LOC) and add tests (EditTakeoffModal, costAllocation), strengthening the safety net rather than just moving code.
- **Controlled extractions:** modals are extracted as controlled components (state stays in the parent), so the move is behavior-preserving and low-risk; no state-machine rewrites.
- **Manual smoke is the real gate** for the moved canvas/takeoff modals — flagged clearly for Nathan, consistent with spec §8 (canvas/takeoff = weakest automated coverage).
