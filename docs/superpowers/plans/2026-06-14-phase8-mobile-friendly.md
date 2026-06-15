# Phase 8 — Mobile-Friendly Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the whole Frugal-Takeoff app usable on phones (target ~375px) and tablets, including polish (touch targets, safe-area insets, touch-accessible affordances). The takeoff drawing canvas is **read-only on phones** (clean viewing + a notice) with **interactive drawing fixed for tablets**.

**Architecture:** Tailwind v4 (built-in breakpoints sm=640/md=768/lg=1024). The app shell renders a `position:fixed` sidebar and offsets content via inline `marginLeft`. `isMobile` = `max-width:767px` already detected in AppShell but only applied to the canvas route. The fix is mostly: (1) make the shell auto-hide the sidebar as an overlay drawer on ALL mobile routes; (2) clean up a set of layout/touch bugs across pages; (3) make the canvas phone-read-only + tablet-drawable. Reuse existing idioms: `flex flex-wrap`, `grid grid-cols-1 sm:grid-cols-2`, `overflow-x-auto`, `flex-col sm:flex-row`.

**Tech Stack:** React 19, react-router 7, Tailwind v4, Konva (`PdfCanvas`), the `src/components/ui` library.

**SAFETY INVARIANT:** `npx tsc --noEmit`, `npm run lint`, `npm test` (457), `npm run build` all green after every task. Canvas-touching tasks additionally must not regress the Playwright E2E suite (`npm run test:e2e`, needs Chromium libs already installed). Behavior on desktop must be preserved — these are additive responsive/touch changes, not redesigns of desktop layouts.

**Audit evidence:** issue IDs below (e.g. HIGH-1, M2) reference the three-part mobile audit performed 2026-06-14.

---

## Task 1: Mobile shell foundation (the systemic fix)

**Files:** `src/components/shell/AppShell.tsx`, `src/components/shell/Sidebar.tsx`, `src/index.css`, `index.html`.

This is the keystone — most pages become usable once the sidebar stops eating the screen.

- [ ] **Step 1 — `.no-scrollbar` utility (currently a dead class used app-wide).** In `src/index.css` add a Tailwind v4 utility so the many `overflow-x-auto no-scrollbar` tab/toolbar rows hide their scrollbar as intended:
```css
@utility no-scrollbar {
  scrollbar-width: none;
  &::-webkit-scrollbar { display: none; }
}
```
- [ ] **Step 2 — Safe-area + viewport.** In `index.html` set `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />`. In `src/index.css` expose safe-area helpers (used by sidebar footer, modal footer, canvas zoom bar):
```css
@utility pb-safe { padding-bottom: env(safe-area-inset-bottom); }
@utility pt-safe { padding-top: env(safe-area-inset-top); }
```
- [ ] **Step 3 — AppShell: sidebar as a mobile overlay drawer on ALL routes.** In `src/components/shell/AppShell.tsx` (currently `isMobile` only hides the sidebar when `isCanvasPage`):
  - On mobile (`isMobile`), the sidebar must NOT consume horizontal space on any route: force the content `marginLeft` to `0` whenever `isMobile`.
  - On mobile, the sidebar renders as a slide-in overlay (left drawer) ON TOP of content with a dimmed backdrop, default CLOSED. Add `mobileSidebarOpen` state (default false). Opening: a hamburger button (see Step 4). Backdrop click + route change + nav-item click close it.
  - Keep the existing desktop behavior (expanded/collapsed/hidden + inline marginLeft) untouched when `!isMobile`.
  - When the route changes (`useLocation`), close the mobile drawer.
- [ ] **Step 4 — Mobile top bar / hamburger.** On mobile, non-canvas routes currently have NO way to open nav. Add a slim mobile top bar (only `md:hidden`, only when `!isCanvasPage` — the canvas already has its own mobile top bar) containing: a hamburger button (opens `mobileSidebarOpen`), the app/section title or logo, and a search/command-palette trigger button (so the palette is reachable on touch — fixes MEDIUM-3). Ensure it uses `pt-safe`. The canvas route keeps its existing mobile chrome; do not double up.
- [ ] **Step 5 — Sidebar touch polish.** In `Sidebar.tsx`: bump the toggle/hide/reopen icon buttons to a ≥44px touch target on touch (e.g. `p-2.5` → larger, or add `min-h-11 min-w-11` at base with tighter desktop). Add `active:` feedback to NavRows. Apply `pb-safe` to the sidebar footer (logout) so the home-bar doesn't cover it. Hide the `⌘K` kbd badge on mobile (`hidden md:inline-flex`).
- [ ] **Step 6:** `npx tsc --noEmit && npm run lint && npm test && npm run build` green. Manual note: on a 375px viewport every non-canvas page now uses full width; the hamburger opens/closes the drawer; backdrop + nav click close it; palette reachable from the top bar. Commit `feat(mobile): sidebar drawer + mobile top bar + no-scrollbar/safe-area utilities`.

---

## Task 2: Global UI primitives (Modal, Button, ConfirmDialog)

**Files:** `src/components/ui/Modal.tsx`, `src/components/ui/Button.tsx`, `src/components/ConfirmDialog.tsx`.

These render everywhere, so fixing them fixes many screens at once.

- [ ] **Step 1 — Modal body scroll + footer wrap + safe area.** In `Modal.tsx`:
  - Ensure the scrollable content region has `overflow-y-auto` and the panel is height-capped so it never exceeds the viewport even when the soft keyboard is up (e.g. panel `max-h-[90vh]` / `max-h-[100dvh]` aware; content area scrolls). (HIGH-3)
  - Footer (`flex justify-end`) → add `flex-wrap` so multi-button footers (the AIA pay-app editor has 4) never clip; add `gap-2`, and `pb-safe`. (HIGH-3, MEDIUM-7)
  - On mobile, prefer a near-full-width panel (the overlay `p-4` already does this; verify `w-full` + the `max-w-*` works down to 320px). Make the close affordance ≥44px.
- [ ] **Step 2 — Button touch targets + active state.** In `Button.tsx` raise the minimum tap height on touch without changing desktop density much: e.g. keep `sm: h-8`, `md: h-9` visually but add `min-h-[40px]` (or a touch-only bump) and ensure `active:` styling exists for tactile feedback. (LOW-1) Verify no E2E selectors depend on exact heights.
- [ ] **Step 3 — ConfirmDialog footer wrap.** `ConfirmDialog.tsx` footer → `flex-wrap` + `pb-safe` to match Modal.
- [ ] **Step 4:** gates green. Commit `feat(mobile): modal scroll/footer-wrap/safe-area, button touch targets`.

---

## Task 3: Auth / Dashboard / Projects / Settings / NewProject

**Files:** `src/pages/Dashboard.tsx`, `src/pages/ProjectsPage.tsx`, `src/pages/Settings.tsx`, `src/pages/NewProject.tsx`, `src/components/ShareLinkModal.tsx`, `src/pages/Login.tsx`.

- [ ] **Step 1 — Header rows wrap.** `Dashboard.tsx:75` and `ProjectsPage.tsx:248` header rows `flex items-center justify-between gap-3` → add `flex-wrap` (or `flex-col sm:flex-row sm:items-center`) so the title + "New Project" button never overflow. (HIGH-2)
- [ ] **Step 2 — ProjectCard action buttons.** `ProjectsPage.tsx:123-127` Rename/Archive/Delete icon buttons: bump hit area to ≥40px (`p-2` + slightly larger icon, or `min-h`/`min-w`), add `active:` feedback. (MEDIUM-2)
- [ ] **Step 3 — Settings SMTP grid.** `Settings.tsx:593` `grid-cols-3` → `grid-cols-1 sm:grid-cols-3` (keep the `col-span-2` for the server field at `sm:` and up). (HIGH-4)
- [ ] **Step 4 — Settings tab list.** `Settings.tsx:1225-1227`: on mobile turn the vertical `<aside>` tab list into a horizontal scrollable tab bar (`flex overflow-x-auto no-scrollbar` + `whitespace-nowrap`) above content, switching to the vertical `md:w-64` rail at `md:`. (MEDIUM-5)
- [ ] **Step 5 — NewProject footer + ShareLinkModal + Login.** `NewProject.tsx:839` footer row → `flex-wrap`. (MEDIUM-4) `ShareLinkModal.tsx:86` QR `w-[180px] h-[180px]` → responsive (`w-44 h-44` max with `max-w-full`, or `w-[min(180px,60vw)]`). (MEDIUM-6) `Login.tsx` — ensure the card scrolls on short viewports (the `min-h-screen flex items-center` + `p-4` is fine; verify no clipping; add `overflow-y-auto`). (LOW-2)
- [ ] **Step 6:** gates green. Commit `feat(mobile): responsive dashboard/projects/settings/new-project headers, forms, share modal`.

---

## Task 4: Project section forms, tables, and touch affordances

**Files:** `src/pages/project/ProjectIssues.tsx`, `src/pages/project/ProjectPunch.tsx`, `src/pages/project/issues/IssueEditor.tsx`, `src/pages/project/punch/PunchItemEditor.tsx`, `src/pages/project/billing/ChangeOrdersSection.tsx`, `src/pages/project/ProjectOverview.tsx`, `src/pages/project/ProjectDocuments.tsx`, `src/pages/project/billing/PaymentsSection.tsx`.

- [ ] **Step 1 — Off-screen form inputs.** `ProjectIssues.tsx:68-76` new-issue row: add `flex-wrap`, change the title `Input` from `w-80` to `flex-1 min-w-[12rem] w-full sm:w-auto` so the "Add issue" button never gets pushed off-screen. (HIGH-5) Same treatment for `ProjectPunch.tsx` add-item form `w-80` description input. (Punch HIGH-7)
- [ ] **Step 2 — Hover-only photo delete (touch bug).** `IssueEditor.tsx:157-160` and `PunchItemEditor.tsx:109` photo-remove buttons are `opacity-0 group-hover:opacity-100` — invisible/untappable on touch. Make them visible on touch and hover-reveal only on devices that hover: `opacity-100 sm:opacity-0 sm:group-hover:opacity-100` plus `focus-visible:opacity-100`. (CRITICAL-6) Confirm the delete button itself is ≥40px.
- [ ] **Step 3 — ChangeOrders approve/reject + Punch checkbox touch targets.** `ChangeOrdersSection.tsx:72-74` Approve/Reject `px-2 py-0.5 text-xs` → larger tap target (`min-h-[36px]`/`py-1.5 px-3`). `ProjectPunch.tsx:172` checkbox `size-4` → `size-5` and/or ensure the whole row is the tap target. (HIGH-8, MEDIUM-12)
- [ ] **Step 4 — Overview + Payments density.** `ProjectOverview.tsx:99` 4-stat `flex items-center gap-4` → `flex-wrap gap-x-6 gap-y-2` so stats wrap instead of overflow. (LOW-13) `PaymentsSection.tsx:73-101` add-form: confirm `flex-wrap` already wraps; make the leading `w-56` select `w-full sm:w-56` so it doesn't dominate a narrow row. (MEDIUM-10)
- [ ] **Step 5 — Documents mobile card view (polish).** `ProjectDocuments.tsx:178` 6-column table is scroll-only on phone. Add a `md:hidden` stacked card list (name + kind/size/version/date + actions) mirroring the table data, and keep the table at `hidden md:block`. Follow the pattern `ProjectTakeoffsTab` already uses (table `hidden md:block` + mobile cards). (LOW-14)
- [ ] **Step 6:** gates green. Commit `feat(mobile): responsive issues/punch forms, touch photo-delete, doc cards, touch targets`.

---

## Task 5: AIA billing grids (Schedule of Values + Pay-App G703 editor)

**Files:** `src/pages/project/billing/AiaScheduleOfValues.tsx`, `src/pages/project/billing/AiaPayAppEditor.tsx`. (High-risk math-adjacent UI — use an opus implementer + opus reviewer. Behavior/math MUST be preserved; this is layout only.)

- [ ] **Step 1 — SOV header actions wrap.** `AiaScheduleOfValues.tsx:191-200` CardHeader action bar ("Seed from estimate" / "Sync approved change orders" / "Upload sheet" / help) has no wrap and clips on mobile. Make the actions wrap (`flex flex-wrap gap-2`) and/or stack the header (`flex-col sm:flex-row`). The SOV add-line form `flex-wrap` already works — just make its inputs `w-full sm:w-auto` where they currently overflow. (CRITICAL-4)
- [ ] **Step 2 — Pay-app editor footer + scroll container.** `AiaPayAppEditor.tsx`: the 4-button footer overflows — relies on the Modal footer `flex-wrap` from Task 2; verify it wraps cleanly. Fix the nested scroll: the G703 `overflow-x-auto` table is inside the modal's `overflow-y-auto` body, which breaks horizontal touch-scroll on iOS. Give the G703 its own bounded scroll region (`overflow-x-auto` with the modal body NOT also scrolling that axis) so horizontal swipe works. (CRITICAL-2, CRITICAL-3)
- [ ] **Step 3 — Pay-app G703 mobile stacked layout.** On phones the 10-column G703 (~1100px) is unusable even with scroll. Add a `md:hidden` per-line stacked/card editor: each SOV line becomes a card showing Description + the editable fields (Scheduled, Previous, This period, Stored %, Work %) as labeled stacked inputs, plus the computed To-date/%/Balance/Retainage read-outs. Keep the existing `hidden md:block` table for desktop UNCHANGED. **Both layouts must bind to the SAME state/handlers** (no duplicated math) — extract shared row state if needed so the card and table edit identically. Verify the G702 summary (L1–L9) still reconciles after edits made via the card layout. (CRITICAL-2/3)
- [ ] **Step 4:** gates green INCLUDING any aiaStore characterization tests (the math is untouched but confirm). Commit `feat(mobile): responsive AIA SOV header + pay-app editor (stacked G703 on phones)`.

---

## Task 6: Canvas — read-only on phone, drawing fixed for tablet

**Files:** `src/pages/CanvasView.tsx`, `src/components/PdfCanvas.tsx`, `src/pages/project/TakeoffEditModal.tsx`, `src/components/CustomCostRow.tsx`, `src/components/AddPagesModal.tsx`, `src/pages/project/ProjectPagesTab.tsx`, `src/components/canvas/MeasurementSidebar.tsx`, `src/components/canvas/MeasurementItem.tsx`. (Use an opus implementer; this is the most stateful area. Run Playwright E2E after.)

- [ ] **Step 1 — Phone = read-only canvas + notice.** Define a "phone" check (e.g. `max-width: 767px` matching `isMobile`). On phones: keep pan / pinch-zoom / tap-to-select / view; DISABLE drawing tool selection (Length/Area/Count/Region/Scale-draw) and show a dismissible banner: "Viewing only on small screens — open this page on a tablet or computer to draw takeoffs." Do NOT disable on tablets/desktop. Keep measurement viewing + the sidebar fully functional.
- [ ] **Step 2 — Tablet drawing: finish-on-touch.** `PdfCanvas.tsx` — the Enter-key finish (`~947`) is keyboard-only. Wire the Stage background `onDblTap` to finalize the in-progress length/area segment (call the same path as Enter / `finalizeSegment`). Verify double-tap on the empty stage finishes a length measurement on touch. (H1)
- [ ] **Step 3 — Tablet drawing: long-press context menu.** Add a long-press (setTimeout ~500ms on touchstart, cancel on move/up) on measurement groups that opens the existing context menu (delete/copy/paste) at the touch point — the menu DOM already exists, only the open trigger is mouse/right-click. (H2)
- [ ] **Step 4 — Toolbar overflow + touch labels + instruction wording.** `CanvasView.tsx:1692` floating toolbar (~14 items, ~504px) overflows invisibly: now that `.no-scrollbar` exists, add a subtle scroll affordance OR wrap to two rows on small screens so all tools are discoverable. Tool buttons use `title` (invisible on touch) — add small visible labels or `aria-label` + a visible text label on touch. Instruction overlay `CanvasView.tsx:1929-1934` "Double-click or press Enter to finish" → touch-aware copy ("Double-tap to finish"). Also reconsider `M4`: the toolbar is hidden when a sidebar is open — ensure tools remain reachable in the drawing workflow on tablet. (M5, M7, L2, M4)
- [ ] **Step 5 — TakeoffEditModal scroll + CustomCostRow wrap.** `TakeoffEditModal.tsx:57-62` (ProjectView copy) is missing `max-h`/`overflow-y-auto` on its body — add `max-h-[85vh] overflow-y-auto` to match the CanvasView/NewTakeoff copies. (H3) `CustomCostRow.tsx` horizontal `flex gap-2` input rows (`w-24`/`w-20`) overflow on phones — add `flex-wrap` / make inputs `w-full sm:w-auto`. (H4)
- [ ] **Step 6 — Page/takeoff/sidebar touch affordances.** `ProjectPagesTab.tsx` grid action buttons (share/rename/star/select, `opacity-0 group-hover:opacity-100`, lines ~385/395/402/465/478/542) — invisible on ALL touch; make them visible on touch (`opacity-100 sm:opacity-0 sm:group-hover:opacity-100` + `focus-visible`). (M2) `MeasurementSidebar.tsx:308/318` and `MeasurementItem.tsx:174` use `md:opacity-0 md:group-hover:opacity-100` — broken on tablets (≥md, touch): switch the hover-reveal to a hover-capable media query so touch tablets keep them visible (e.g. gate behind `@media (hover:hover)` via a `can-hover:` utility, or simply keep visible at all sizes). (M1)
- [ ] **Step 7 — AddPagesModal sizing.** `AddPagesModal.tsx:78` `max-w-4xl` is fine with `w-full`; verify the modal fits 320px and scrolls. PageNamingStep region-select drag is mouse-only (`onMouseDown/Move/Up`) — out of scope for phone (read-only) but add pointer/touch support if low-effort for tablet; otherwise leave a code comment noting it's desktop/tablet-mouse only. (L4)
- [ ] **Step 8:** gates green. Then run `npm run test:e2e` and confirm the canvas/takeoff specs still pass (no drawing regressions on desktop). Commit `feat(mobile): canvas read-only on phones + tablet touch drawing (finish/long-press/toolbar), takeoff modal fixes`.

---

## Task 7: Verify + push + memory

- [ ] **Step 1:** Full gates: `npx tsc --noEmit && npm run lint && npm test && npm run build`, plus `npm run test:e2e` for the canvas regression gate.
- [ ] **Step 2:** Final review pass (opus) over the whole Phase 8 diff: confirm desktop layouts/behavior unchanged (additive responsive only), no math/store/route/migration changes, the sidebar drawer works and doesn't break the canvas route's own mobile chrome, no duplicated state in the AIA card/table or canvas read-only gating, touch affordances reachable. Fix any issue.
- [ ] **Step 3:** Push to `testing`. (No migration; no data risk.)
- [ ] **Step 4:** Memory — Phase 8 mobile pass shipped (UI/touch only). Record the canvas policy (phone read-only, tablet drawable), the shell drawer pattern, and a manual-smoke checklist for Nathan (phone: sidebar drawer + every section full-width + forms don't push buttons off-screen + photo delete tappable + AIA pay-app stacked editor; tablet: finish a length measurement by double-tap + long-press delete).

---

## Self-Review Notes (author)

- **Keystone first:** Task 1 (shell drawer) unblocks ~80% of perceived breakage; everything after is cleanup on top of full-width content.
- **Additive, not redesign:** every change adds responsive/touch behavior while preserving desktop. Tables get mobile card siblings (`md:hidden` + `hidden md:block`) rather than being rewritten — same data, same handlers.
- **No duplicated logic:** the AIA G703 card layout and the canvas read-only gating must share state/handlers with the existing desktop code (call out in implementer prompts; opus reviewer verifies).
- **Canvas scope honored:** phone = read-only + notice; tablet = real drawing (finish-on-double-tap, long-press menu, discoverable toolbar). Precise phone drawing intentionally NOT attempted.
- **Polish included:** 44px touch targets, safe-area insets, touch-visible affordances, dead `.no-scrollbar` defined, touch-aware instruction copy.
- **Regression gate:** canvas-touching tasks run Playwright E2E; everything runs the 457 unit tests + tsc/lint/build.
