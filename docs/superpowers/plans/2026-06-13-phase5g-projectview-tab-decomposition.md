# Phase 5g — ProjectView Tab Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Decompose the now-E2E-covered stateful core of ProjectView — extract the **Pages tab**, the **takeoff Edit/Delete modals**, and the **Takeoffs tab** into focused controlled components. Behavior-preserving verbatim moves, gated by the Phase 5f Playwright suite + tsc + review.

**Architecture:** Each piece becomes a CONTROLLED presentational component (the AddPagesModal/EmailTab pattern from 5e): the JSX moves verbatim into `src/pages/project/...`, but ALL state + handlers + computed values STAY in ProjectView and are passed as props. No state-machine rewrites, no logic changes. This shrinks ProjectView from ~3,335 LOC to ~2,000 (a thin shell: header + tab bar + `<ProjectPagesTab/>` + `<ProjectTakeoffsTab/>` + `<EmailTab/>` + root modals).

**SAFETY INVARIANT — the regression gate is the E2E suite (the whole point of 5f):** after EVERY task, `npx tsc --noEmit` clean, `npm test` (unit, 352) green, `npm run build` succeeds, AND `npm run test:e2e` (the full 19-spec suite) green. Run E2E 2× on the riskiest extractions to confirm no flake. These are verbatim moves; tsc catches type mismatches, the E2E catches the happy-path interactions, and the opus wiring review catches same-typed prop mis-wires (tsc's blind spot).

**Tech Stack:** React 19, the ui library, Playwright (5f suite). No server/data changes.

**Pattern references:** `src/components/AddPagesModal.tsx` + `src/pages/project/EmailTab.tsx` (5e) are the exact model — controlled components, props for every state slice + handler, verbatim JSX, state stays in the parent.

**Current targets (from the 5g explore; line ranges are approximate — LOCATE by `activeTab === '...'` and by name, the file shifts as you edit):**
- Pages tab JSX: the `activeTab === 'pages'` block (~1958–2497, ~540 LOC). Pages-tab-only state: searchTerm, pagesViewMode, pagesSortMode, pageContextMenu, favoritePageIds, pageSearchInputRef, pagesScrollRef, editingPageId/Number/Description, filteredPages, visiblePages. Handlers: toggleFavorite, handleStartRenamePage/handleSaveRenamePage/handleCancelRenamePage, handleSharePage (also used elsewhere — keep in parent, pass as prop), handleDeletePage, handleShareSelectedPages, handleOptimizeThumbnails, handleOpenNamePages. Shared: project, selectedPageIds, revisionModel.
- Takeoff modals: delete-all confirm (~3016–3043), single-delete confirm (~3045–3073), NewTakeoffModal (~3075–3089, leave at root or move — it's shared-ish), edit-takeoff modal (~3091–3280). State: editingTakeoff + edit* fields, takeoffToDelete, showDeleteConfirm, showDeleteAllConfirm. Handlers: handleEditTakeoff, handleSaveEditTakeoff, handleDeleteTakeoff, confirmDeleteTakeoff, confirmDeleteAllTakeoffs.
- Takeoffs tab JSX: the `activeTab === 'takeoffs'` block (~2498–3009, ~512 LOC). Takeoffs-tab-only state: selectedTakeoffIds, expandedTakeoffs, expandedTakeoffPages, isPrinting, isExportingExcel, progressMessage, showTakeoffModal. Handlers: toggleTakeoffSelection, toggleTakeoffExpanded, toggleTakeoffPageExpanded, handlePrint, handleExportExcel, handleEditTakeoff, handleDeleteTakeoff, confirmDeleteAllTakeoffs. Computed: getTakeoffTotals (uses shared revisionModel), allocateSubsetCost/Details (imported). Shared: project, highlightQuality, revisionModel.

**E2E coverage protecting these (run `npm run test:e2e` to confirm green after each):**
- pages.spec: render, search, view toggle, rename round-trip. (NOT covered, moving verbatim: favorites, context menu, multi-select, revisions — rely on faithful move + tsc + review.)
- takeoffs.spec: create, edit, advanced-cost, delete. export.spec: select-row → Excel + Print → printout in /proposal. (NOT covered: cost-breakdown expand rows, mobile cards — render-only, preserved by verbatim move.)

**DEFERRED to a future 5h (NOT in this phase):** the CanvasView right-sidebar (bidirectional selectedTakeoffId/selectedMeasurementId/multiSelectedIds with the canvas) and the draw/history/collaboration handlers (`updateMeasurement`, history/redo, socket sync) — these need expanded canvas-sidebar E2E (filter, multi-select merge, current-page-only, heights) before they can be safely extracted. Note this in the wrap-up.

---

## File Structure

**Create:**
- `src/pages/project/ProjectPagesTab.tsx` — the pages tab (search/sort/view toolbar + grid + list + context menu)
- `src/pages/project/TakeoffEditModal.tsx` — the edit-takeoff modal (controlled) [if cleaner, keep delete-confirms inline or in a small `TakeoffDeleteModals.tsx`]
- `src/pages/project/ProjectTakeoffsTab.tsx` — the takeoffs tab (toolbar + desktop table + mobile cards)

**Modify:** `src/pages/ProjectView.tsx` (render the extracted components, delete the inline JSX; ALL state/handlers stay).

---

## Task 1: Extract ProjectPagesTab (controlled component)

**Files:** Create `src/pages/project/ProjectPagesTab.tsx`; modify `src/pages/ProjectView.tsx`.

- [ ] **Step 1: Read** the full `activeTab === 'pages'` block in ProjectView + every state/handler/computed it references (enumerate the COMPLETE list — getting one prop wrong silently breaks an interaction tsc can't catch). Note the pages-tab-only effects (scroll memory, search-focus shortcut, context-menu close) — those EFFECTS stay in ProjectView (they're keyed on activeTab); only the JSX moves. The component receives state + setters + handlers as props.

- [ ] **Step 2: Create `ProjectPagesTab.tsx`** — a controlled component. Props interface = every value + setter + handler + computed the JSX uses (project, filteredPages, visiblePages, searchTerm+setter, pagesViewMode+setter, pagesSortMode+setter, pageContextMenu+setter, favoritePageIds, selectedPageIds+setter, editingPageId/Number/Description+setters, revisionModel, the refs pageSearchInputRef/pagesScrollRef, and handlers toggleFavorite/handleStartRenamePage/handleSaveRenamePage/handleCancelRenamePage/handleSharePage/handleDeletePage/handleShareSelectedPages/handleOptimizeThumbnails/handleOpenNamePages/onAddPages). MOVE the JSX VERBATIM (search toolbar + empty state + list view + grid view + context menu), wiring each to props. Keep ALL classes, the data-testids (pages-list, page-row, page-search, view-grid, view-list, btn-add-pages, page-rename-input), favorites, context menu, and rename logic identical. Pass refs through as props (forward them).

- [ ] **Step 3: Wire ProjectView** — replace the inline `activeTab === 'pages'` JSX with `{activeTab === 'pages' && <ProjectPagesTab ...all props... />}`. Keep every state declaration, effect, and handler in ProjectView. Remove now-dead imports only if truly unused (tsc flags).

- [ ] **Step 4: Verify** — `npx tsc --noEmit` clean; `npm run lint`; `npm test` (352) green; `npm run build`; **`npm run test:e2e`** → all 19 green (pages.spec especially). RE-READ the prop wiring against the original (tsc won't catch same-typed swaps).

- [ ] **Step 5: Commit**

```bash
git add src/pages/project/ProjectPagesTab.tsx src/pages/ProjectView.tsx
git commit -m "refactor: extract ProjectPagesTab (controlled) from ProjectView"
```

---

## Task 2: Extract the takeoff Edit + Delete modals

**Files:** Create `src/pages/project/TakeoffEditModal.tsx` (and optionally `TakeoffDeleteModals.tsx`); modify `src/pages/ProjectView.tsx`.

NOTE: the inline edit-takeoff modal here is the SAME divergent one from 5e (it has the math-expression cost input + dark mode, OR the price-package variant — this is the ProjectView copy). We are NOT deduping with CanvasView (5e proved they diverged). We're just MOVING ProjectView's copy into its own file as a controlled component. Verbatim.

- [ ] **Step 1: Read** the edit-takeoff modal JSX (`editingTakeoff && (...)`), the two delete-confirm modals (single + all), and their state/handlers. These render at the component root (outside the tab conditionals).

- [ ] **Step 2: Create `TakeoffEditModal.tsx`** — controlled: props = editingTakeoff + every edit* field + setter + handleSaveEditTakeoff + onClose + price-package options + project (whatever the JSX reads). MOVE the modal JSX verbatim (keep the testids edit-takeoff-name, toggle-advanced-cost, btn-save-takeoff, CustomCostRow usage, all classes). Optionally also create a tiny `TakeoffDeleteModals.tsx` for the two confirms (props: showDeleteConfirm/takeoffToDelete/confirmDeleteTakeoff/onCloseDelete + showDeleteAllConfirm/confirmDeleteAllTakeoffs/onCloseAll, keep `btn-confirm-delete` testids) — OR leave the confirms inline if extraction adds churn. Prefer extracting the edit modal (the big one) for sure.

- [ ] **Step 3: Wire ProjectView** — replace the inline modal JSX with the component(s). State + handlers stay in ProjectView. NewTakeoffModal already a component — leave it.

- [ ] **Step 4: Verify** — tsc clean; lint; unit (352); build; **`npm run test:e2e`** → 19 green (takeoffs.spec edit/delete especially). Re-read wiring.

- [ ] **Step 5: Commit**

```bash
git add src/pages/project/TakeoffEditModal.tsx src/pages/ProjectView.tsx
git commit -m "refactor: extract TakeoffEditModal (+ delete confirms) from ProjectView"
```

---

## Task 3: Extract ProjectTakeoffsTab (controlled component)

**Files:** Create `src/pages/project/ProjectTakeoffsTab.tsx`; modify `src/pages/ProjectView.tsx`.

This is the largest/most prop-heavy (the table + mobile cards + cost-breakdown expand rows). Verbatim controlled move. The cost-breakdown rendering uses `allocateSubsetCost`/`allocateSubsetDetails` (already a shared util) + `getTakeoffTotals` — pass `getTakeoffTotals` (or the totals array) as a prop; import the allocate utils directly in the new component (they're pure).

- [ ] **Step 1: Read** the full `activeTab === 'takeoffs'` block + every state/handler/computed it reads (enumerate completely — this one has ~15+ deps). Note: the toolbar buttons (btn-print, btn-export-excel, btn-new-takeoff) + per-row (btn-edit-takeoff, btn-delete-takeoff) + table (takeoffs-table, takeoff-row) testids must be preserved; the export buttons only render when selectedTakeoffIds.size > 0 (preserve that gating exactly — the E2E depends on it).

- [ ] **Step 2: Create `ProjectTakeoffsTab.tsx`** — controlled: props = project, getTakeoffTotals (or precomputed totals), selectedTakeoffIds+toggleTakeoffSelection, expandedTakeoffs+toggle, expandedTakeoffPages+toggle, highlightQuality+setter, isPrinting, isExportingExcel, onPrint (handlePrint), onExportExcel (handleExportExcel), onNewTakeoff (open NewTakeoffModal), onEditTakeoff (handleEditTakeoff), onDeleteTakeoff (handleDeleteTakeoff), onDeleteAll (open delete-all confirm), onOpenProposal (navigate), revisionModel/currentPageIds if the rows need it. Import `allocateSubsetCost`/`allocateSubsetDetails`/`computeTakeoffTotals` from their utils directly. MOVE the toolbar + desktop table + mobile cards + empty state VERBATIM, wiring to props. Keep ALL cost-breakdown logic, expand rows, mobile cards, classes, testids, and the export-button gating identical.

- [ ] **Step 3: Wire ProjectView** — replace the inline `activeTab === 'takeoffs'` JSX with `{activeTab === 'takeoffs' && <ProjectTakeoffsTab ...props... />}`. State + handlers stay. Remove dead imports if any.

- [ ] **Step 4: Verify** — tsc clean; lint; unit (352); build; **`npm run test:e2e` run 2×** → 19 green BOTH times (takeoffs.spec + export.spec are the gate; export-button gating must still work). Carefully re-read the wiring (this is the most prop-heavy — a same-typed swap is the risk).

- [ ] **Step 5: Commit**

```bash
git add src/pages/project/ProjectTakeoffsTab.tsx src/pages/ProjectView.tsx
git commit -m "refactor: extract ProjectTakeoffsTab (controlled) from ProjectView"
```

---

## Task 4: Full verification + final review + push

- [ ] **Step 1: Full gate** — `npm run lint && npm test && npm run build` green; **`npm run test:e2e` green run 2× consecutively** (no flake). Report ProjectView's new LOC (target ~2,000) and the test counts.

- [ ] **Step 2: Final review** — dispatch an opus code-review over the 5g range. Focus: (1) each extraction is a VERBATIM move — diff each new component against the pre-commit inline JSX (no class/logic/testid/gating drift); (2) PROP WIRING fidelity — trace the trickiest same-typed props at each call site (the pages tab's many setters; the takeoffs tab's selectedTakeoffIds/expanded* and the onPrint/onExportExcel/onEdit/onDelete callbacks; confirm none crossed); (3) the export-button `selectedTakeoffIds.size > 0` gating is preserved (E2E depends on it); (4) the cost-breakdown allocate logic is unchanged; (5) effects/refs that stayed in ProjectView still work (scroll memory, search focus, context-menu close); (6) no dangling refs; tsc/unit/e2e green. Fix Critical/Important, re-review.

- [ ] **Step 3: Push**

```bash
git push origin testing
```

- [ ] **Step 4: Memory** — record 5g shipped: ProjectView decomposed into ProjectPagesTab + ProjectTakeoffsTab + TakeoffEditModal (controlled components, behavior-preserving, E2E-gated); ProjectView ~3,335 → ~N LOC. Note what's STILL deferred to 5h: the CanvasView right-sidebar + draw/history/collaboration handlers (need expanded canvas-sidebar E2E — filter, multi-select merge, current-page-only, heights — before safe extraction). Note the uncovered-but-moved-verbatim interactions (favorites, context menu, page multi-select, cost-breakdown rows, mobile cards) for Nathan's manual smoke.

---

## Self-Review Notes (author)

- **Why these three, not the canvas:** they're E2E-covered on the happy paths (pages render/search/rename; takeoffs create/edit/delete/export) and are controlled-component moves (state stays in parent) — mechanical and tsc/E2E/review-verifiable. The canvas sidebar + draw handlers have bidirectional state + collaboration sync and the weakest coverage; extracting them now would be refactoring blind → deferred to 5h after canvas-sidebar E2E expansion.
- **Verbatim discipline:** uncovered interactions (favorites, context menu, multi-select, cost-breakdown rows, mobile cards) move byte-for-byte, so a faithful move preserves them; the opus wiring review + tsc guard against prop mis-wires, and `npm run test:e2e` is the regression gate after every task (the payoff of 5f).
- **No dedup:** TakeoffEditModal is ProjectView's copy only — NOT unified with CanvasView's (5e proved they diverged). Just a move.
- **Manual smoke** still matters for the uncovered interactions — flag them.
