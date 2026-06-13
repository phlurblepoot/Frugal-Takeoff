# Phase 5h — CanvasView Decomposition (final monolith slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Complete the monolith split (Phase 5's last slice) by decomposing CanvasView to the SAFE boundary: extract the undo/redo history into a `useMeasurementHistory` hook and the right-sidebar measurement/takeoff list into a controlled `MeasurementSidebar` component — first EXPANDING the canvas E2E to cover the sidebar interactions being refactored. The measurement-persistence/collaboration handlers stay in CanvasView (extracting them is an architecture change — project/page→context + multi-user test infra — out of scope; documented as the honest boundary).

**Architecture:** Same proven pattern: behavior-preserving moves gated by Playwright E2E + tsc + opus review. The history hook is pure state+handlers (no collaboration coupling — undo/redo intentionally don't broadcast). The sidebar is a controlled component (all state via props, bidirectional selection state passed both ways). CanvasView keeps every persistence handler, the collaboration wiring, the draw orchestration, and PdfCanvas.

**SAFETY INVARIANT:** after EVERY task: `npx tsc --noEmit` clean, `npm test` (352 unit) green, `npm run build` succeeds, AND `npm run test:e2e` (the full suite) green. Run E2E 2× on the sidebar extraction. Verbatim moves; tsc + the (expanded) E2E + the opus wiring review are the three guards.

**Tech Stack:** React 19, Playwright. No server/data change.

**Pattern references:** the 5g ProjectView tab extractions (controlled components, state stays in parent, char-for-char JSX) are the exact model for the sidebar. `useMeasurementHistory` is a standard custom-hook extraction.

**Current targets (from the 5h explore — LOCATE by name, lines shift as you edit):**
- History: `history`/`redoStack` state (~108-109), `HistoryAction` type (~103-106), `pushToHistory` (~151-154), `applyAction` (~156-175), `handleUndo` (~221-228), `handleRedo` (~230-237). `applyAction` calls `savePageUpdates` (which updates page+project). NO collaboration in undo/redo. Callers of `pushToHistory`: addMeasurement, handlePaste, confirmNewMeasurement, updateMeasurement, confirmDeleteMeasurement, deleteSegment. Keyboard: Ctrl+Z / Ctrl+Shift+Z. testids btn-undo/btn-redo.
- Sidebar: the `measurement-sidebar` block (~1993-2370). Sub-ranges: header+filter (~1993-2055), multi-select merge banner (~2063-2099), takeoff-totals loop (~2101-2309), ungrouped measurements (~2311-2364). Sidebar-only state: isRightSidebarOpen, showCurrentPageOnly, measurementFilter, expandedTakeoffs. BIDIRECTIONAL (canvas+sidebar): selectedTakeoffId, selectedMeasurementId, multiSelectedIds. Read-only: aggregatedMeasurements, takeoffTotals, project, page. Handlers it calls: selectMeasurement, updateMeasurement, deleteMeasurement, setHeightsModalMeasurementId, handleEditTakeoff, setTakeoffToDelete, openNewMeasurementModal, handleMergeSelected, toggleTakeoffExpanded, goToPage. Sub-components MeasurementItem (~2806-3005) + ToolButton (already in-file function components).
- E2E gaps (NOT covered, to add in T1): measurement filter (input ~2048-2054), "current page only" toggle (checkbox ~2024-2028 — add `data-testid="toggle-current-page-only"`), expand/collapse takeoff chevron (~2182-2189), heights modal for area (opens via setHeightsModalMeasurementId), multi-select merge (needs `data-testid="btn-multi-select-toggle"` on the toggle ~1833). Covered already: scale, length/area/count draw, sidebar row appears, delete, undo/redo.

**STAYS in CanvasView (explicit honest boundary — NOT extracted):** updateMeasurement/deleteMeasurement/confirmDeleteMeasurement/addMeasurement/confirmNewMeasurement (they mutate project/page + saveProject + sendMeasurementUpdate socket broadcast); the collaboration wiring (useCollaboration, onMeasurementSync, presence cursors); the draw orchestration + PdfCanvas. Extracting these is a future architectural effort (move project/page to context; build multi-user test coverage) — beyond the monolith-split scope and not safely a behavior-preserving move.

---

## File Structure

**Create:**
- `src/hooks/useMeasurementHistory.ts` — undo/redo history hook
- `src/components/canvas/MeasurementSidebar.tsx` — the right-sidebar controlled component
- (maybe) `src/components/canvas/MeasurementItem.tsx` — if cleaner to move the MeasurementItem helper alongside the sidebar (optional)

**Modify:**
- `src/pages/CanvasView.tsx` — use the hook; render `<MeasurementSidebar/>`; keep all persistence/collab/draw
- `e2e/canvas.spec.ts` — add sidebar-interaction specs
- A couple of `data-testid`s in CanvasView (multi-select toggle, current-page-only) — additive

---

## Task 1: Extract useMeasurementHistory hook

**Files:** Create `src/hooks/useMeasurementHistory.ts`; modify `src/pages/CanvasView.tsx`.

The cleanest extraction (no collaboration coupling; gated by existing undo/redo E2E).

- [ ] **Step 1: Read** the history code in CanvasView: the `HistoryAction` type, `history`/`redoStack` state, `pushToHistory`, `applyAction`, `handleUndo`, `handleRedo`, and every call site of `pushToHistory` (addMeasurement, handlePaste, confirmNewMeasurement, updateMeasurement, confirmDeleteMeasurement, deleteSegment). Note what `applyAction` needs (`page`, `selectedMeasurementId`, and `savePageUpdates` to persist).

- [ ] **Step 2: Create `src/hooks/useMeasurementHistory.ts`:**
  ```ts
  export type HistoryAction = /* move the exact type from CanvasView */;
  export function useMeasurementHistory(args: {
    page: ProjectPage | null;
    selectedMeasurementId: string | null;
    savePageUpdates: (measurements: Measurement[], targetPageId?: string) => void; // the exact signature CanvasView's savePageUpdates has
    toast: ...; // if handleUndo/Redo toast
  }) {
    const [history, setHistory] = useState<HistoryAction[]>([]);
    const [redoStack, setRedoStack] = useState<HistoryAction[]>([]);
    const pushToHistory = (action: HistoryAction) => { /* verbatim: append, cap 50, clear redo */ };
    const applyAction = (action, dir) => { /* verbatim, using args.page/selectedMeasurementId/savePageUpdates */ };
    const undo = () => { /* verbatim handleUndo */ };
    const redo = () => { /* verbatim handleRedo */ };
    return { history, redoStack, pushToHistory, undo, redo };
  }
  ```
  MOVE the logic verbatim (cap-50, the add/delete/update reconstruction in applyAction, the toasts). Export `HistoryAction`.

- [ ] **Step 3: Wire CanvasView** — replace the inline history state+functions with `const { history, redoStack, pushToHistory, undo, redo } = useMeasurementHistory({ page, selectedMeasurementId, savePageUpdates, toast });`. Update the call sites (`pushToHistory(...)` calls stay the same name; `handleUndo`→`undo`, `handleRedo`→`redo` at the buttons + keyboard shortcuts). Keep `savePageUpdates` in CanvasView (it mutates page/project). Import `HistoryAction` from the hook where the type is referenced.

- [ ] **Step 4: Verify** — tsc clean; lint; unit (352); build; `npm run test:e2e` → 19 green (canvas undo/redo spec is the gate). 

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useMeasurementHistory.ts src/pages/CanvasView.tsx
git commit -m "refactor: extract useMeasurementHistory hook from CanvasView"
```

---

## Task 2: Expand canvas E2E for sidebar interactions

**Files:** Modify `e2e/canvas.spec.ts`; add 2 `data-testid`s in `src/pages/CanvasView.tsx`.

Lock in the sidebar behaviors BEFORE extracting the sidebar (Task 3).

- [ ] **Step 1: Add testids** (additive) in CanvasView: `data-testid="toggle-current-page-only"` on the current-page-only checkbox; `data-testid="btn-multi-select-toggle"` on the multi-select mode toggle button. (The filter input + expand chevron + heights opener may already be reachable; add a testid only if needed.)

- [ ] **Step 2: Add E2E specs** to `e2e/canvas.spec.ts` (reuse the fixtures + the `parseValue` helper). Drive each against the real browser, characterize current behavior:
  - **Measurement filter**: draw 2 measurements with distinguishable takeoff names; type a filter that matches one → assert the sidebar shows the matching takeoff/measurement and hides the other; clear → both return.
  - **Current-page-only toggle**: (single page seeded, so this is light) toggle it and assert the sidebar still renders the current page's measurements (and the toggle reflects state). If multi-page is needed to see a real difference and that's heavy, assert the toggle flips + measurements remain — note the limitation.
  - **Expand/collapse takeoff in sidebar**: click the takeoff card chevron → assert its measurement rows show/hide.
  - **Heights modal (area)**: draw an area measurement, open its heights editor (the edit-heights affordance), assert the heights modal opens; (optionally set a height + save, assert no crash). If the gesture is fiddly, assert open/close.
  - **Multi-select merge** (if drivable): enable multi-select toggle, select 2 measurements of the same takeoff, assert the merge banner appears with a count; (optionally merge + assert count drops). If too fiddly, assert the banner appears and CUT the merge assertion (report).
  - Add testids only as needed; prefer existing selectors.

- [ ] **Step 3: Run** `npm run test:e2e e2e/canvas.spec.ts` → iterate to green; then full suite. Stabilize or cut+report any flaky sub-check.

- [ ] **Step 4: Commit**

```bash
git add e2e/canvas.spec.ts src/pages/CanvasView.tsx
git commit -m "test(e2e): expand canvas sidebar coverage (filter, page-only, expand, heights, merge)"
```

---

## Task 3: Extract MeasurementSidebar controlled component

**Files:** Create `src/components/canvas/MeasurementSidebar.tsx` (+ optionally move MeasurementItem); modify `src/pages/CanvasView.tsx`.

- [ ] **Step 1: Read** the full `measurement-sidebar` JSX block + every state/handler/computed it references (enumerate completely — ~15+ deps; same-typed prop swaps are the risk). Note MeasurementItem + ToolButton usage (if ToolButton is used in the sidebar header; if it's only the floating toolbar, leave it).

- [ ] **Step 2: Create `MeasurementSidebar.tsx`** — controlled component. Props = every value/setter/handler/computed: isRightSidebarOpen+setter, showCurrentPageOnly+setter, measurementFilter+setter, selectedTakeoffId+setter, selectedMeasurementId+setter, expandedTakeoffs+setter, multiSelectedIds+setter, project, page, takeoffTotals, aggregatedMeasurements, and callbacks selectMeasurement, updateMeasurement, deleteMeasurement, setHeightsModalMeasurementId, handleEditTakeoff, setTakeoffToDelete, openNewMeasurementModal, handleMergeSelected, toggleTakeoffExpanded, goToPage (+ scaleConfig/projectId/planSet data MeasurementItem needs). MOVE the JSX VERBATIM, wiring to props. Keep ALL classes, the data-testids (measurement-sidebar, measurement-row, measurement-value, toggle-current-page-only, btn-multi-select-toggle), filter, merge banner, takeoff cards, count badges, ungrouped section. Import MeasurementItem (move it to its own file `src/components/canvas/MeasurementItem.tsx` if cleaner, or import from CanvasView if it stays — prefer moving it alongside the sidebar so CanvasView shrinks). Preserve MeasurementItem behavior exactly.

- [ ] **Step 3: Wire CanvasView** — replace the inline sidebar JSX with `<MeasurementSidebar ...props... />`. Keep ALL state + handlers in CanvasView (the bidirectional selection state lives in CanvasView and is passed both ways). Remove now-dead imports.

- [ ] **Step 4: Verify** — tsc clean; lint; unit (352); build; `npm run test:e2e` run **2×** → full suite green BOTH times (the expanded canvas spec is the gate). Re-read the prop wiring (verify the moved JSX is char-for-char vs the original minus prop renames; trace the bidirectional Set/string state + the same-typed callbacks).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/MeasurementSidebar.tsx src/components/canvas/MeasurementItem.tsx src/pages/CanvasView.tsx
git commit -m "refactor: extract MeasurementSidebar (controlled) from CanvasView"
```

---

## Task 4: Full verification + final review + push (Phase 5 complete)

- [ ] **Step 1: Full gate** — `npm run lint && npm test && npm run build` green; `npm run test:e2e` green run 2×. Report CanvasView's new LOC + the test counts (unit + e2e).

- [ ] **Step 2: Final review** — opus over the 5h range. Focus: (1) useMeasurementHistory is a verbatim move (cap-50, applyAction reconstruction, undo/redo) — diff vs original; the call sites still push correctly; undo/redo E2E green; (2) MeasurementSidebar JSX is verbatim (char-for-char vs the inline block minus prop renames); (3) prop wiring — trace the bidirectional state (selectedTakeoffId/selectedMeasurementId/multiSelectedIds) and same-typed callbacks for crossings; (4) the persistence/collab handlers + draw orchestration STAYED in CanvasView (collaboration sync untouched — confirm sendMeasurementUpdate/onMeasurementSync not moved); (5) the new sidebar E2E specs assert real behavior; (6) no dangling refs; tsc/unit/e2e green. Fix Critical/Important.

- [ ] **Step 3: Push**

```bash
git push origin testing
```

- [ ] **Step 4: Memory + declare Phase 5 COMPLETE** — record 5h shipped (useMeasurementHistory + MeasurementSidebar extracted; CanvasView ~3,099 → ~N LOC). Then a milestone note: **Phase 5 (Refactor & polish) is COMPLETE** — 5a tests+CustomCostRow, 5b Proposal, 5c Settings, 5d ⌘K, 5e safe dedups, 5f E2E suite, 5g ProjectView tabs, 5h CanvasView sidebar+history. EXPLICITLY DOCUMENT the two intentional remainders: (a) the CanvasView measurement-persistence + collaboration handlers stay in CanvasView (a future context-refactor + multi-user test effort, not a behavior-preserving move); (b) the a11y/print-quality pass remains deferred per Nathan's pragmatic-scope choice. List the manual-smoke items for the new sidebar/canvas extractions.

---

## Self-Review Notes (author)

- **Honest "complete":** Phase 5 = the monolith decomposed to the SAFE boundary. The two remainders (collaboration-coupled persistence core; a11y/print) are intentional and documented — the first is an architecture change needing multi-user test infra (not a refactor-and-polish move), the second was explicitly deferred by Nathan. Calling these out is the honest definition of done, not a gap.
- **E2E-first for the sidebar:** Task 2 expands coverage BEFORE Task 3 touches the sidebar — the same lock-in-then-refactor discipline that made 5g safe.
- **Verbatim + controlled:** the hook and sidebar are behavior-preserving moves (state stays in CanvasView for the bidirectional selection); the opus wiring review + tsc + the expanded E2E are the three guards.
- **Collaboration untouched:** sendMeasurementUpdate/onMeasurementSync stay in CanvasView — single-user E2E can't test multi-user sync, so we must not move that code blind.
