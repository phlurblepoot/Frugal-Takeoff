# UI Rehaul — Wave 3 (Propagate & Delight) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle every remaining raw-slate surface onto the token/glass/motion system, wire the tab tier + scroll polish everywhere it belongs, ship the remaining polish-pack features (⌘K glow-up, lightbox, celebrations, reveals, breathing progress, presence cursors, shortcut overlay expansion), and land the deferred card-system features (touch reorder, edge resize) plus accumulated chores/bug fixes.

**Architecture:** Mechanical slate→token sweeps guided by a canonical class map (below), with ui-kit adoption (Card/Input/Table) where pages hand-roll the same idioms; delight features build on existing primitives (motion springs, IntersectionObserver, Konva lerp, long-press + pointer-resize patterns already in the repo). Two real bug fixes ride along (phantom `bg-surface-2`; TimeKeeping's Sunday-anchored week). No data changes.

**Tech Stack:** React 19, Tailwind v4, `motion` v12, Konva (canvas chrome only), vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-09-04-ui-rehaul-design.md` §9 Wave 3, §7.2 polish pack, §2.2 foundation rules. Exploration facts (file/line references used throughout) were verified 2026-09-05 against HEAD 1dfb98f.

## Global Constraints

- **Canonical slate→token map** (apply verbatim; judgment only where a mapping is ambiguous, note choices):
  `bg-white dark:bg-slate-800` → `bg-raised` · `bg-slate-50 dark:bg-slate-900` → `bg-sunken` (page-section wells) or delete (page backdrops — see next rule) · `border-slate-200 dark:border-slate-700` → `border-edge` · `border-slate-300 dark:border-slate-600` → `border-edge-strong` · `text-slate-900 dark:text-white` → `text-ink` · `text-slate-700 dark:text-slate-300` → `text-ink` (labels) or `text-ink-soft` · `text-slate-600/500 dark:text-slate-400` → `text-ink-soft` · `text-slate-400 dark:text-slate-500` → `text-ink-faint` · `hover:bg-slate-100 dark:hover:bg-slate-700` → `hover:bg-hover` · hand-rolled `bg-white dark:bg-slate-800 border … rounded-xl shadow-sm` card idiom → ui `Card`/`CardHeader`/`CardBody`.
- **DELETE, don't translate, opaque page backdrops**: any `min-h-screen bg-slate-*` wrapper inside AppShell (Settings.tsx:1796, TimeKeeping.tsx:383) is removed so the ambient scene shows. `bg-black/50` modal scrims stay.
- **Canvas internals untouched**: Konva drawing behavior, tools, measurement ops are off-limits; only chrome (toolbars, sidebars, modals, cursor presentation layer). ANY canvas-adjacent change is verified with a real Playwright click-drag + screenshot (standing rule).
- **Reduced motion**: every new JS-driven animation checks `useTheme().reducedMotion`; every new CSS animation gets a `.motion-reduce` neutralizer.
- **Glow ration** unchanged (primary buttons, active nav, progress bars). Glass for chrome/overlays; dense data tables stay `bg-raised` flat.
- **Contracts that must survive**: ProjectTabBar labels; `glow-accent` on active nav/tabs; all existing `data-testid`s; CommandPalette's ⌘K/Escape/arrow behavior and its `open-command-palette` CustomEvent; Modal focus-trap stack (nested modals); e2e suite (33 specs) green.
- **Zero tests assert slate classnames** (verified) — restyles are proven by `npm test` + `npm run lint` + targeted e2e + screenshots, not test rewrites.
- No secure-context APIs. No migrations. Commit per task; push to `testing` at the gate (Task 14) — intermediate pushes are fine (project convention).
- Commands: `npx vitest run --project ui [file]` / `npm test` / `npm run lint` / `npm run test:e2e [-- file]`.

---

### Task 1: Time utilities consolidation + two real bug fixes

**Files:**
- Create: `src/utils/time.ts`, `src/utils/time.test.ts`
- Modify: `src/pages/Dashboard.tsx` (re-export from utils for back-compat), `src/cards/dashboard/coreCards.tsx`, `src/cards/project/coreCards.tsx`, `src/cards/customer/coreCards.tsx`, `src/cards/dashboard/libraryCards.tsx`, `src/cards/project/libraryCards.tsx` (delete private copies, import from utils — src/utils is cycle-safe), `src/pages/TimeKeeping.tsx` (BUG: lines ~360-363 inline a Sunday-anchored `startOfWeek` shadowing the canonical Monday-anchored one — replace with the utils import; "this week" hours then agree with Dashboard/ProjectTime), `server/customerStore.ts` (unify day-count: `daysBetween` uses Math.round while dashboardStore's `ageDays` uses Math.floor — the SAME invoice can land in different aging buckets on the two pages; change `daysBetween` to floor semantics `Math.max(0, Math.floor(...))` and update any customerStore tests pinning round behavior).

**Interfaces:** `src/utils/time.ts` exports `DAY` (86_400_000), `timeAgo(ms)`, `startOfWeek(now?)` (Monday-anchored — copy Dashboard.tsx:20-36 verbatim incl. comments), `hoursThisWeek(entries: {clockIn:number; clockOut:number|null}[], now?)`, `fmtDate(v: number | string | null | undefined): string` (epoch or ISO → toLocaleDateString, nullish → '—'). Dashboard.tsx re-exports `timeAgo/startOfWeek/hoursThisWeek` from utils so ProjectOverview/ProjectTime imports keep working.

- [ ] Steps: TDD utils (timeAgo buckets; Monday anchoring incl. Sunday input; hoursThisWeek week-started-in rule; fmtDate epoch/ISO/null) → RED → implement + swap all six card/page copies + TimeKeeping fix + server floor unification → focused tests + `npx vitest run --project server server/customerStore.test.ts` + FULL `npm test` + lint → commit `fix(time): shared time utils; TimeKeeping Monday week; unified aging day-count`.

---

### Task 2: Fetch dedupe + phantom-class fix

**Files:**
- Create: `src/utils/dedupeFetch.ts` + test
- Modify: `src/utils/store.ts` (wrap `getCustomerOverview` and `getBillingSummary`), `src/components/FilePickerModal.tsx` (BUG: lines 332 & 411 use nonexistent `bg-surface-2`/`hover:bg-surface-2` — render transparent; replace with `bg-sunken` / `hover:bg-hover`).

**Interfaces:** `dedupeInFlight<T>(key: string, fn: () => Promise<T>, ttlMs = 1500): Promise<T>` — module-level map; concurrent callers with the same key share one promise; resolved values cached for ttlMs then evicted; rejections evict immediately. Wrap: `getCustomerOverview(id)` key `customer-overview:${id}`, `getBillingSummary(pid)` key `billing-summary:${pid}` (opening a customer currently fires the same request up to 6×; ProjectOverview fires billing-summary 3×). `useLiveQuery`-triggered refetches after the TTL still hit the server — freshness unchanged in practice.

- [ ] Steps: TDD dedupe (concurrent share; post-TTL refetch; rejection not cached) → RED → implement + wrap + FilePicker fix → FULL ui suite + lint → commit `perf(store): dedupe concurrent overview/billing fetches; fix phantom bg-surface-2`.

---

### Task 3: Settings restyle + two-way tab persistence

**Files:** `src/pages/Settings.tsx` (2012 lines, 308 slate + 29 bg-white — the largest offender).

Work items (explorer-verified locations):
1. Delete the `min-h-screen bg-slate-50 dark:bg-slate-900` wrapper (L1796) — ambient scene shows through; keep inner max-width container.
2. Kill the shared consts `inputCls`/`labelCls` (L1036-1037) by adopting ui `Field`/`Input`/`Select`/`Textarea` (~60 hits in one move); sweep the rest per the canonical map, tab by tab (PreferencesTab L668-1033, ChangelogTab L1041-1070, StorageTab L1071-1260, AiaTemplateTab L1331-1512, DocumentTypesCard L1513-1676, shell L1688-2012). Hand-rolled card idioms → ui `Card`.
3. BUG-ish: `?tab=` is read once on mount (L1712-1714) but `setActiveTab` (L1826) never writes back — reload/back loses the tab. Make it two-way (searchParams pattern from CustomerPane.tsx:52-62, replace:true).
4. Tab tier: wrap the 8 content branches (L1841-2007) in `<div key={activeTab} className="anim-tab-in">`.
5. Sidebar nav rows: token classes; active row keeps its current affordance (glow-accent if it's nav-like today — match the app pattern).

- [ ] Steps: sweep + adopt + persistence + keyed wrapper → `npx vitest run --project ui src/pages/Settings.test.tsx` + FULL ui + lint → dev-server visual pass (all 8 tabs, light+dark, reload keeps tab) with 2 screenshots saved to .superpowers/ → commit `refactor(settings): tokenized restyle, ui-kit forms, two-way tab URL, tab-tier animation`.

---

### Task 4: Tool & public pages restyle (TimeKeeping, UsersView, TemplatesView, ShareView)

**Files:** `src/pages/TimeKeeping.tsx` (698 L; delete L383 backdrop; card idiom → `Card`; keep heatmap accent-opacity buckets), `src/pages/UsersView.tsx` (241 L; wrapper L124 → `Card`; `<table>` L181 → ui `Table/THead/TBody/TR/TH/TD`), `src/pages/TemplatesView.tsx` (598 L; card grid L345, modals ~L406/L436, `CustomCostRow` wrapper L15 → tokens/Card — note it also renders inside Settings' takeoff-templates tab, verify there too), `src/pages/ShareView.tsx` (144 L; all slate strings at L19-134 → tokens; being outside AppShell it inherits the global `body` ambient scene automatically once the opaque `bg-slate-100 dark:bg-slate-950` wrappers go — public share pages get the app's ambience deliberately; sticky header → `glass-panel border-b border-edge`).

- [ ] Steps: sweep per map → focused tests where they exist + FULL ui + lint → dev screenshots (TimeKeeping light/dark; ShareView via an actual share link) → `npm run test:e2e -- documents.spec.ts` if ShareView is exercised there (check; else skip) → commit `refactor(ui): tokenize TimeKeeping, Users, Templates, ShareView (ambient share pages)`.

---

### Task 5: Project section chrome restyle + tab tier

**Files:** `src/pages/ProjectView.tsx` (59 slate: tab bar L2003-2044 → token/glow pattern from ProjectTabBar; content ternary L2046-2115 wrapped `<div key={activeTab} className="anim-tab-in">` — EXCEPT keep the wrapper transform-free or restore scroll AFTER animation for the 'pages' tab: L133-150 does sessionStorage scroll memory; simplest: `onAnimationEnd`-gated restore or skip the anim class when restoring), `src/pages/project/ProjectPagesTab.tsx` (141 slate), `src/pages/project/ProjectTakeoffsTab.tsx` (133), `src/components/TakeoffEditModal.tsx` (31), `src/components/NewTakeoffModal.tsx` (118), `src/pages/project/TakeoffDeleteModals.tsx` (16), `src/pages/project/EmailTab.tsx` (25), `src/pages/project/ProjectBilling.tsx` (6: tab bar L146-161 → tokens; content L163-188 wrapped keyed anim-tab-in), `src/pages/customers/CustomerPane.tsx` (4: tab bar L141 → tokens; content wrapper L154 gains `key={activeTab} className="anim-tab-in"`), `src/pages/ProjectsPage.tsx` (already tokenized: just wrap `renderRows` output L474 in keyed anim div).

- [ ] Steps: sweep + keyed wrappers → FULL ui + lint → `npm run test:e2e -- customers.spec.ts collab-follow.spec.ts` (tab-bar contracts) → dev screenshots (project pages/takeoffs tabs, billing tabs) → commit `refactor(project): tokenize section chrome; tab-tier animation on all tab hosts`.

---

### Task 6: Canvas chrome restyle (NO drawing-internals changes)

**Files:** `src/pages/CanvasView.tsx` (319 slate + 17 bg-white — toolbars/panels/modals JSX only; do NOT touch measurement ops, Konva handlers, sockets), `src/components/canvas/MeasurementSidebar.tsx` (91), `src/components/canvas/ScaleCalibrationModal.tsx` (26), `src/components/canvas/ToolDisabledModal.tsx` (6), `src/components/canvas/KeyboardShortcutsModal.tsx` (15 — restyle only here; Task 8 may fold its content into the global overlay, keep the component), `src/components/canvas/MeasurementItem.tsx` (12 — LIST-ROW styling only; its Konva props untouched), `src/components/PdfCanvas.tsx` (45 slate — ONLY non-Konva JSX chrome, e.g. HTML overlays/menus; Konva fill/stroke color strings that happen to contain 'slate' names stay), `src/components/NotesBoard.tsx`/`NotesOverlay.tsx` (Konva-string-heavy; change ONLY real Tailwind classNames on HTML elements).

**MANDATORY verification (standing rule):** after the sweep, run the canvas e2e specs (`npm run test:e2e -- canvas-drawing.spec.ts collab-canvas-sync.spec.ts` — use the actual spec filenames from e2e/) AND a manual Playwright click-drag: draw one measurement, drag a vertex, screenshot before/after saved to .superpowers/. Zero drawing-behavior drift.

- [ ] Steps: sweep (HTML chrome only) → FULL ui + lint → canvas e2e + click-drag proof → commit `refactor(canvas): tokenize chrome — toolbars, sidebars, modals (drawing internals untouched)`.

---

### Task 7: Editors/modals/global crumbs sweep (everything left)

**Files (explorer inventory, tier 2-3 remainder):** `src/pages/PdfEditor.tsx` (166), `src/pages/SpreadsheetEditor.tsx` (42 — frame only, Fortune Sheet internals stay), `src/pages/NewProject.tsx` (82), `src/components/PageNamingStep.tsx` (144), `src/components/AddPagesModal.tsx` (29), `src/components/UploadFailuresModal.tsx` (36), `src/components/PlanSetManager.tsx` (35), `src/components/PlanSetRevisions.tsx` (22), `src/components/PlanSetCompare.tsx` (22), `src/components/ShareLinkModal.tsx` (18), `src/components/ConfirmDialog.tsx` (14), `src/components/Skeleton.tsx` (12), `src/components/CustomCostRow.tsx` (31), `src/components/RoleEmailsEditor.tsx` (6), `src/components/AddressAutocomplete.tsx` (4), `src/components/ui/StatusPill.tsx` (6 — its neutral tone classes), `src/components/Toast.tsx` (1), `src/pages/mail/ThreadList.tsx` (1), `src/components/FollowPill.tsx` (1), `src/pages/customers/CustomerSidebar.tsx` (1), `src/components/shell/AppShell.tsx` (3), `src/pages/documents/DocumentsBulkBar.tsx` (5), `src/pages/documents/DocumentsFilterBar.tsx` (1), `src/pages/UsersView.tsx` leftovers if any. After this task: `grep -rn "slate-" src/ --include="*.tsx"` returns ONLY Konva color-string literals (document each remaining hit in the report) — target ~0 real classNames.

- [ ] Steps: sweep per map (batch, mechanical) → FULL ui + lint → grep proof in report → spot dev screenshots (PdfEditor, NewProject upload, a PlanSet modal) → commit `refactor(ui): complete slate→token sweep across editors, modals, and shell crumbs`.

---

### Task 8: ⌘K palette glow-up + expanded shortcut overlay

**Files:** `src/components/CommandPalette.tsx` (326 L) + its test if present.

Work items (explorer-verified):
1. Glass restyle: panel L233 → `glass-panel border-edge rounded-2xl` (lighten scrim L228 to `bg-black/30` so glass reads); all slate → tokens.
2. Spring entrance (`type:'spring', stiffness 380, damping 30` like PageTransition) + per-item cascade — CSS `animation-delay: calc(var(--i)*18ms)` on rows (cheap, no AnimatePresence-per-row); respect `useTheme().reducedMotion` (palette currently ignores it — gate entrance + cascade).
3. Grouped results with section headers (Actions / This project / Search results / Recent) — PRESERVE flat keyboard index semantics: keep one flat `items` array for selection math (L157-160, L186-188); headers are render-only interleaves keyed off group boundaries. Add tests for arrow-nav across group boundaries.
4. Recents: localStorage `palette-recents` (last 6 executed action ids/titles, ProjectsPage recents shape precedent), shown when query is empty, merged at top; executing any item records it.
5. Expand the existing `?` overlay (L288-323): restyle to glass + tokens, add the undocumented shortcuts (/, canvas tool keys, ⌘Z/⌘Y, canvas ←/→, ⌘C/⌘V measurements — copy content from canvas/KeyboardShortcutsModal.tsx so the two agree; keep that modal for canvas context).

- [ ] Steps: TDD (grouping keeps flat nav; recents record/merge; reducedMotion gates) → RED → implement → FULL ui + lint → dev check (⌘K feel, cascade, dark/light) → commit `feat(palette): glass command palette — springs, cascading groups, recents; expanded ? overlay`.

---

### Task 9: Springy photo lightbox (net-new viewer, app-wide)

**Files:**
- Create: `src/components/Lightbox.tsx` + test
- Modify: `src/components/documents/PhotoDropCard.tsx` (thumbnails L81 get onClick → opens lightbox over the editor modal — nested-trap supported by Modal's trap stack), `src/pages/project/proposal/ProposalPhotosCard.tsx` (PhotoTile img L36 clickable; lightbox receives ordered list + captions), `src/cards/project/libraryCards.tsx` (photo-strip thumbs L264 clickable), `src/pages/documents/DocumentViewerModal.tsx` (image branch L132-139: replace inline img with the shared viewer surface OR keep modal and just normalize to `getImageUrl` — implementer judgment, disclose; do not regress PDF branch).

**Interfaces:** `Lightbox: React.FC<{ items: { src: string; caption?: string }[]; index: number; onClose: () => void }>` — portal, `bg-black/80` backdrop, springy zoom-in from center (`initial scale 0.9 → 1`, spring 380/30; NOT a shared-element morph — keep it simple), ←/→ + swipe (pointer events; reuse drag-threshold idiom) navigation, pinch-zoom via two-pointer distance (basic scale clamp 1-4, double-tap toggles 1↔2 — long-press idiom exists for touch), Escape closes, caption bar when present, counter "2 / 8". reducedMotion → no spring (instant). No secure-context APIs.

- [ ] Steps: TDD (renders item/caption/counter; arrows navigate + clamp; Escape onClose; reducedMotion path) → RED → implement + wire 4 sites → FULL ui + lint → dev check incl. nested-over-editor case + touch emulation → commit `feat(ui): springy photo lightbox across issues/punch/daily/RFI/CO/task/proposal photos`.

---

### Task 10: Celebration moments

**Files:**
- Create: `src/components/motion/Celebration.tsx` (+ test) — confetti burst component: ~14 absolutely-positioned pieces, CSS keyframe fly-out (Wave-mockup pattern), fires once then self-removes (~1s); plus `useCelebration()` via a tiny provider or window CustomEvent `'celebrate'` with `{x?,y?}` (simplest: CustomEvent listener component mounted in App Layout next to ThemeWipe — follow that exact pattern).
- Modify: `src/App.tsx` (mount `<CelebrationOverlay/>`), `src/components/ProjectStageControl.tsx` (in `pick` L36-56: when `current==='bidding' && next==='in_progress'`, dispatch celebrate before the toast — 1-line predicate, explorer-verified), `src/pages/project/billing/PaymentsSection.tsx` (`record` success L51: dispatch a GREEN GLOW PULSE variant — not confetti; add a `pulse` variant to the event detail that flashes a soft green radial at the click origin), `src/pages/project/billing/AiaPayAppEditor.tsx` (`handleFinalize` success L200: same green pulse).

Rules: confetti ONLY for bid-won (rare + earned); payments/finalize get the subtle pulse; `useTheme().reducedMotion` → nothing fires; `.motion-reduce` CSS neutralizer for the keyframes; zero layout impact (pointer-events-none, fixed, z below toasts' 10000).

- [ ] Steps: TDD (event renders overlay, self-removes on timer — fake timers; reducedMotion no-op; variant selection) → RED → implement + 3 trigger wires → FULL ui + lint → dev check (mark a bid won on a test project) → commit `feat(ui): celebration moments — confetti on bid won, glow pulse on payment/finalize`.

---

### Task 11: Scroll reveals + breathing progress + scroll-fade adoption

**Files:**
- Create: `src/hooks/useReveal.ts` (+ test) — IntersectionObserver (jsdom-guarded), adds `reveal-in` class once when ≥15% visible, disconnects after fire (once per mount); returns ref. CSS: `@keyframes reveal-in` (opacity 0→1, translateY 14px→0, 0.45s cubic-bezier(0.22,1,0.36,1)) + `.motion-reduce` neutralizer.
- Modify: apply reveals to `src/pages/ProjectsPage.tsx` row groups (renderRows), `src/pages/TasksPage.tsx` list sections, `src/pages/project/ProjectPunch.tsx` area groups (L182 region), `src/cards/CardGrid.tsx` items (NOTE: wrapper already has masonry span + wiggle — put the reveal class on the INNER measured div's parent? No: attach to the OUTER wrapper's className, animation is transform+opacity and completes once; must not conflict with wiggle (editing) — skip reveal when editing). Explicitly NOT ThreadList (virtualized — flicker).
- Breathing: add `.breathing` utility (slow 2.4s brightness pulse on the element's existing glow, from the approved mockup) + `.motion-reduce` off; apply to `src/pages/NewProject.tsx:964` indeterminate upload bar; add a mini draft-completion bar to `src/pages/project/billing/AiaPayApplications.tsx` rows for `status==='draft'` (Σ percentComplete×scheduledValueCents / Σ scheduled — data per explorer L245-247 pattern; ProgressBar + `.breathing`).
- `.scroll-fade` adoption (currently used nowhere): sidebar nav already has it (verify), add to CommandPalette results list and MeasurementSidebar list.

- [ ] Steps: TDD (useReveal fires once, jsdom guard; draft-completion math) → RED → implement → FULL ui + lint → dev scroll-through check → commit `feat(ui): scroll reveals, breathing progress on live bars, scroll-fade rails`.

---

### Task 12: Presence cursor personality (canvas)

**Files:** `src/components/PdfCanvas.tsx` (cursor layer L2483-2521 ONLY) + `src/utils/presence.ts` (optional shared color/name helpers).

Work: interpolate remote cursors toward their latest target in a rAF lerp loop (factor ~0.25/frame, snap under 0.5px) instead of binding x/y directly — Konva Group refs + manual lerp (motion can't drive Konva); nicer name tag (rounded pill, measured via Konva Text width instead of `name.length*7+8`, subtle shadow); fade-out cursors idle >30s (lastActive exists). Sender throttle unchanged. reducedMotion → skip lerp (bind directly, as today). NO changes to cursor-move emit/protocol.

**MANDATORY verification:** Playwright two-context session — context A moves the mouse on a canvas page, context B screenshots showing A's cursor + name tag; assert the cursor Group exists and moved between two samples. Plus the canvas drawing e2e specs stay green.

- [ ] Steps: implement (small, contained) → unit where feasible (lerp function pure-tested) → canvas e2e + two-context proof → FULL ui + lint → commit `feat(canvas): smoothed presence cursors with polished name tags`.

---

### Task 13: Card system — touch reorder, edge resize, small card adds

**Files:** `src/cards/CardGrid.tsx` + `CardGrid.test.tsx`, `src/cards/customer/libraryCards.tsx` (+test), `src/cards/customer/coreCards.tsx` (correspondence links).

Work items:
1. **Touch reorder** (spec §5.1 debt): in Customize mode on touch devices (detection idiom `'ontouchstart' in window || navigator.maxTouchPoints > 0`), long-press (~500ms, longPressTimerRef idiom from DocumentsTable.tsx:175-217) arms a move mode on a card: the card lifts (scale 1.05 + shadow via class), subsequent `pointermove` tracks which wrapper the pointer is over (elementFromPoint on `[data-card-id]`), pointer-up drops before that target using the SAME splice logic as `handleDrop` (extract a shared `reorderBefore(draggedId, targetId)` used by both paths). Must not disturb useMasonrySpan's inner-div measurement (lift class on the OUTER wrapper only). Scroll suppression while armed (`touch-action: none` on the grid during move mode only).
2. **Desktop edge resize**: in Customize mode, a right-edge handle strip on each card (`role="separator"`, keyboard ←/→ parity) using the MailPage.tsx:205-276 pointer pattern (window-bound events, widthsRef anti-stale-closure); dragging snaps to whole columns: compute hovered width = clamp(round((pointerX - cardLeft) / colWidth), supported widths) and preview via the existing width classes; release persists via the same setLayout path as the [1][2][3] buttons (which remain).
3. **cu-open-tasks** card (adminOnly: false, [1], d1): overview.taskCounts {open, overdue} tiles — restores the count the old Overview tile had (Nathan's product note).
4. **cu-correspondence**: rows + a "View all" get an href fallback to `/mail` (final-review minor).

- [ ] Steps: TDD (reorderBefore shared logic; resize snap math pure fn; cu-open-tasks render) → RED → implement → FULL ui + lint → e2e `cards.spec.ts` green + ADD one touch-reorder e2e (Playwright touch emulation: long-press, move, drop, persisted) and one edge-resize e2e → dev check on a real narrow viewport → commit `feat(cards): touch long-press reorder, edge drag-resize, open-tasks card, mail links`.

---

### Task 14: Wave gate — full verification + changelog + push

- [ ] 1. `npm test` (full unit) — flake protocol as before (DocumentActionsBar/CountUp isolate-rerun once if sole failure).
- [ ] 2. `npm run lint`.
- [ ] 3. FULL `npm run test:e2e` (all specs incl. the two new card e2e) — stale-locator fixes only for intentionally restyled surfaces (class-based locators should be rare — zero specs asserted slate; investigate any failure honestly; real regression → BLOCKED).
- [ ] 4. Final slate audit: `grep -rn "slate-\|bg-white" src/ --include="*.tsx"` — report every remaining hit with justification (Konva strings, deliberate exceptions).
- [ ] 5. Changelog v2.14.0 "UI Rehaul Wave 3 — Propagate & Delight" in src/pages/Settings.tsx (style-matching; honest coverage: every screen on the new theme, animated tab switches, command palette upgrade, photo lightbox, celebrations, scroll reveals, smoother collaborator cursors, cards reorderable by touch + edge-resizable, plus the week-alignment fix in Time Keeping).
- [ ] 6. Commit `feat(ui): UI Rehaul Wave 3 — propagate & delight (v2.14.0)` + `git push origin testing`.
- [ ] 7. Report with Nathan's smoke checklist (all 8 Settings tabs, canvas draw+chrome, share link, palette, lightbox, win a bid, phone reorder).

---

## Self-Review Notes (completed)

- **Spec §9 Wave 3 coverage**: every named section restyled (T3-T7 cover the full 47-file slate inventory) ✓ · ⌘K ✓T8 · peek hover cards — **deliberately DESCOPED this wave**: DocumentHoverPreview exists for documents; app-wide link peeks need a data-fetch-per-hover design that deserves its own pass; ledger as descoped, surface to Nathan · lightbox ✓T9 · celebrations ✓T10 · reveals ✓T11 · breathing ✓T11 · presence cursors ✓T12 · shortcut overlay ✓T8 · empty states everywhere — cards done in W2; EmptyState component is already token-clean and used app-wide; illustrated art beyond cards = descoped with peek cards (same ledger note).
- **Backlog seeds folded in**: time.ts ✓T1 · TimeKeeping week bug ✓T1 · day-count unify ✓T1 · shared fetch ✓T2 · bg-surface-2 ✓T2 · Settings ?tab= ✓T3 · touch reorder + edge resize ✓T13 · cu-open-tasks ✓T13 · /mail links ✓T13 · scroll-fade adoption ✓T11.
- **Type consistency**: reorderBefore/dedupeInFlight/useReveal/Lightbox interfaces defined once in their tasks; time.ts consumers enumerated with exact current copy locations.
- **Placeholder scan**: restyle tasks carry the canonical map + exact file/line inventories; feature tasks carry full interfaces + verified integration points. No TBDs.
