# UI Rehaul — Wave 2 (Card System & Landing Pages) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Dashboard, Project Overview, and Customer Overview with a per-user customizable card system (registry of ~38 cards, drag/remove/add/width controls, responsive clamping) powered by two new aggregate endpoints plus extensions to existing ones — the approved "Command Center" / "Progress Story" / customer-pane defaults.

**Architecture:** A `src/cards/` module owns the system: `CardDef` registry, a glass `CardShell` (independent loading/empty/error per card), a responsive `CardGrid` with customize mode (native HTML5 drag, width 1–3 controls, add-tray, reset), and `useCardLayout` persisting per-page-type layouts to `user_preferences` (JSON value, localStorage mirror for instant paint, `app:prefs-sync` reconcile). Server gains `GET /api/dashboard/attention` + `GET /api/dashboard/money` (new, in server/routes.ts) and small extensions (aging buckets on customer overview, `customerId` filter on mail project-threads, happenings = existing activity). Money figures use the draft-excluding `listBilledDocuments` family — never the legacy invoice-only aliases.

**Tech Stack:** React 19, Tailwind v4, `motion` (count-up via `animate()`, wiggle/entrances), inline SVG sparklines (no chart lib), better-sqlite3 raw SQL, vitest (`server` + `ui` projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-04-ui-rehaul-design.md` — §5 card system, §5.2 card library, §6 landing-page defaults + endpoints, §2.2 foundation rules (hover law, glow ration), §10 testing. Wave 1's shipped primitives (glass-panel, soft-zoom, CountUp-less motion system, anim-tab-in) are available.

## Global Constraints

- **No migrations. No secure-context APIs in src/** (server-side `node:crypto` is fine; client ids via `uuid` package).
- **Money = integer cents from the ledger family**: `listBilledDocuments` / `projectOutstandingCents` / the `payApp*`+`invoice*Billed*` fields — NEVER `billingSummary.outstandingCents`/`invoiceTotalCents` legacy aliases (draft-inclusive, invoice-only).
- **Admin gating by field ABSENCE** (not null) in API payloads, and by card exclusion client-side (`adminOnly` cards never render or appear in the tray for non-admins). Client admin check: `JSON.parse(localStorage.getItem('user') || '{}').role === 'admin'` (app-wide pattern).
- **Express route ordering**: literal routes (`/api/dashboard/*`) must be registered BEFORE parameterized siblings; `/api/customers/:id/...` extensions ride existing handlers.
- **Card layout pref keys**: `cards-dashboard`, `cards-project`, `cards-customer`; value = `JSON.stringify({ version: 1, cards: [{ id, width }] })`. Mirror to localStorage under the same key for instant paint (projectsSort pattern, ProjectsPage.tsx:258-284); reconcile from server on load and on `app:prefs-sync`.
- **Responsive columns**: ≥1600px → 4 · ≥1024 → 3 · ≥640 → 2 · else 1. **Rendered span = min(user width, columns)**. Grid gap = `gap-3` (12px); soft-zoom growth (6px) stays under it (hover law, spec §2.2 rule 8 — attach `useSoftZoom` + `soft-zoom` to every card).
- **Glow ration** (spec rule 4): cards never glow; only existing primary buttons / active nav / progress bars (`glow-bar`) may.
- **Reduced motion**: every JS animation (count-up, chart draw-in, customize wiggle uses CSS — neutralized via `.motion-reduce`) checks `useTheme().reducedMotion` or is CSS covered by the global `.motion-reduce` override.
- **Live updates**: cards reuse `useLiveQuery` with the narrowest `types` filter that covers their data. `EntityType` additions (none planned) would need both src/hooks/useLiveQuery.ts:5 AND server/realtime/changeFeed.ts:9.
- **Preserved behaviors**: Dashboard greeting + "New Project" button; ProjectOverview's `ProjectStageControl`, legacy `?tab=` redirect, clock-in; CustomerPane tabs + `?tab=` + `data-testid` contracts (`customer-pane`, `customer-tab-*`, `customer-outstanding-slot`, `customer-attention-row` moves into the attention card), admin Billing gating.
- Tests: `npx vitest run --project server <file>` / `--project ui <file>`; full `npm test`; `npm run lint`; e2e `npm run test:e2e`.
- Commit per task; branch `testing`; push at Task 14.

---

### Task 1: Server — `/api/dashboard/attention` + `/api/dashboard/money`

**Files:**
- Create: `server/dashboardStore.ts`
- Create: `server/dashboardStore.test.ts`
- Modify: `server/routes.ts` (register both routes near the top of `registerDataRoutes`, before any `/api/projects/:id` route — see routes.ts:110 ordering comment)

**Interfaces:**
- Produces `GET /api/dashboard/attention` (authenticateToken): `{ items: AttentionItem[] }` where
  ```ts
  export interface AttentionItem {
    type: 'overdue_task' | 'bid_due' | 'aging_receivable' | 'stale_rfi' | 'draft_payapp';
    label: string;                 // human line, e.g. "Pay app #4 — Dania Beach"
    sub: string;                   // age/context line, e.g. "in draft 6 days · $32,400"
    projectId: string | null;
    projectName: string | null;
    itemId: string;                // task/rfi/payapp/doc id for deep links
    date: number;                  // epoch ms used for sorting (due date, sent date, doc date)
    severity: 'red' | 'amber';
    balanceCents?: number;         // admin money items only
  }
  ```
  Rules (mirroring server/customerStore.ts:174 attention where they exist): overdue_task = `tasks.status != 'done' AND dueDate < today` (dueDate ISO string, lexical compare); bid_due = projects `status='bidding'`, not archived (`json_extract(meta,'$.archived')` falsy), `bidDueDate <= now + 14d` (severity red when past); stale_rfi = `rfis.status='open' AND sentAt IS NOT NULL AND sentAt < now - 7d`; **admin-only** (omit entirely for non-admins): aging_receivable = each `listBilledDocuments` doc with `balanceCents > 0` older than 14 days (invoice date epoch; payapp `applicationDate` parsed `YYYY-MM-DD`; red at 30d), draft_payapp = `aia_pay_apps.status='draft' AND createdAt < now - 5d`. Sort: red before amber, then date asc. Cap 20.
- Produces `GET /api/dashboard/money` (authenticateToken + requireAdmin): 
  ```ts
  export interface DashboardMoney {
    outstandingCents: number;          // Σ projectOutstandingCents over non-archived projects
    contractTotalCents: number;        // Σ billingSummary(...).contractTotalCents (same docs pass)
    billedCents: number;               // Σ doc.totalCents over billed docs
    paidCents: number;                 // Σ doc.paidCents
    draftPayAppCount: number;
    recentPayments: { id: string; amount: number; date: number; method: string | null; projectId: string; projectName: string }[]; // last 5, payments joined via target doc → project
    trend: { month: string; paidCents: number }[]; // last 6 calendar months incl. current, oldest first, 'YYYY-MM'
  }
  ```
  Implementation: ONE pass — iterate non-archived projects, call `listBilledDocuments(db, id)` once each and feed the same array to `billingSummary(db, id, docs)` (billingStore.ts:441 accepts the docs param), accumulating totals (this respects the known computeG702 O(N²) concern by not recomputing docs). Trend from `payments` (`date` INTEGER epoch): `SELECT strftime('%Y-%m', date/1000, 'unixepoch') m, SUM(amount) a FROM payments WHERE date >= ? GROUP BY m` → cents via `toCents` per row sum (amount is REAL dollars). recentPayments resolve project via `targetType`: invoice → `invoices.projectId`, payapp → `aia_pay_apps.projectId`.

- [ ] **Step 1: Write failing tests** — `server/dashboardStore.test.ts`, following the harness style of `server/routes.test.ts` (in-memory db via the existing test helpers/migrations). Cases:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
// Use the same db-bootstrap helper pattern as server/customerStore.test.ts /
// server/billingStore.test.ts (open in-memory db, run migrations, insert rows).
import { dashboardAttention, dashboardMoney } from './dashboardStore';

describe('dashboardAttention', () => {
  it('flags an overdue task with red severity', /* seed task dueDate=yesterday, status todo → item {type:'overdue_task', severity:'red'} */);
  it('flags a bid due within 14 days as amber and a past-due bid as red', /* two bidding projects */);
  it('skips archived projects entirely', /* archived bidding project with past bidDueDate → no item */);
  it('flags an open RFI sent more than 7 days ago', /* rfi sentAt = now-8d */);
  it('omits money items for non-admins', /* seed unpaid sent invoice older than 14d; dashboardAttention(db,false) has no aging_receivable; (db,true) does with balanceCents */);
  it('flags a pay app sitting in draft more than 5 days (admin only)', /* draft payapp createdAt=now-6d */);
  it('sorts red before amber and caps at 20', /* … */);
});

describe('dashboardMoney', () => {
  it('aggregates outstanding/billed/paid from billed documents (draft-excluding)', /* seed: sent invoice $100 with $40 payment + draft invoice $999 (ignored) → outstanding 6000, billed 10000, paid 4000 */);
  it('returns last-6-month payment trend oldest-first', /* payments in two months */);
  it('lists the 5 most recent payments with project names', /* … */);
});
```

Write the seeds concretely using the same INSERT statements the existing store tests use (projects with `status`, `meta`; invoices + invoice_lines; payments with targetType/targetId; aia_pay_apps; tasks with ISO dueDate; rfis with sentAt).

- [ ] **Step 2: Run to verify failure** — `npx vitest run --project server server/dashboardStore.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `server/dashboardStore.ts`** — exports `dashboardAttention(db, isAdmin): AttentionItem[]` and `dashboardMoney(db): DashboardMoney` per the rules above. Reuse: `listBilledDocuments`, `billingSummary`, `projectOutstandingCents`, `toCents` from `./billingStore`; `todayStr()` pattern from customerStore (copy the one-liner if not exported). Labels: task → task title; bid → project name; rfi → `RFI #${number} — ${title}`; receivable → `${kind === 'payapp' ? `Pay app #${number}` : `Invoice ${number ?? ''}`}`; draft payapp → `Pay app #${number} in draft`. `sub` lines include age in days and `formatMoney`-ready cents left to the client (send raw cents; client formats).
- [ ] **Step 4: Register routes in `server/routes.ts`** (top of registerDataRoutes, with the ordering comment):

```ts
// Dashboard aggregates (Wave 2). Literal paths — MUST be registered before
// any parameterized sibling so Express doesn't swallow them as ids.
app.get('/api/dashboard/attention', authenticateToken, (req: any, res) => {
  const isAdmin = req.user?.role === 'admin';
  res.json({ items: dashboardAttention(db, isAdmin) });
});
app.get('/api/dashboard/money', authenticateToken, requireAdmin, (_req, res) => {
  res.json(dashboardMoney(db));
});
```

- [ ] **Step 5: Green + full server project** — `npx vitest run --project server` and `npm run lint`.
- [ ] **Step 6: Commit** — `git add server/dashboardStore.ts server/dashboardStore.test.ts server/routes.ts && git commit -m "feat(api): dashboard attention + money aggregates (wave 2)"`

---

### Task 2: Server — happenings, customer aging buckets, customer mail threads

**Files:**
- Modify: `server/routes.ts` (happenings route, before `/api/projects/:id`)
- Modify: `server/customerStore.ts` (`customerOverview` gains `billing.aging`)
- Modify: `server/mail/routes.ts` (project-threads accepts `customerId` alternative)
- Modify: `server/customerStore.test.ts` (aging cases) · Create/extend happenings tests in `server/dashboardStore.test.ts`

**Interfaces:**
- `GET /api/projects/:id/happenings?limit=12` (authenticateToken): `{ items: HappeningItem[] }` — a merge of (a) `listActivity(db, limit, projectId)` rows mapped to `{ kind:'activity', id, type, message, username, createdAt }` and (b) project mail threads with a reply newer than the last outbound (`mail_thread_links` joined `mail_thread_reply_state`, same rule as mail/routes.ts:1035 reply-flags) mapped to `{ kind:'mail', id: threadKey, message: `Reply on "${subjectSnapshot}"`, createdAt: Date.parse(lastInboundDate) }` — merged, sorted `createdAt` desc, capped at `limit`.
- `customerOverview(...).billing.aging = { current: number; days31to60: number; days61plus: number }` (cents; bucket by `now - docDate` over ledger entries with `balanceCents > 0`; payapp `applicationDate` parsed as local date). Additive field — existing consumers unaffected.
- `GET /api/mail/project-threads?customerId=<id>` — same handler, same response shape; exactly one of `projectId`/`customerId` required (400 otherwise); filters `mail_thread_links.customerId` (indexed) instead of projectId.

- [ ] **Step 1: Failing tests** — aging buckets in `server/customerStore.test.ts` (seed sent invoices dated now-10d/now-45d/now-90d with balances → three buckets); happenings merge in `server/dashboardStore.test.ts` (activity row + a mail_thread_links+reply_state row with newer inbound → mail item present, sorted).
- [ ] **Step 2: RED** — run both files.
- [ ] **Step 3: Implement** the three changes. Happenings can live in `server/dashboardStore.ts` as `projectHappenings(db, projectId, limit)`.
- [ ] **Step 4: GREEN + full server suite + lint.**
- [ ] **Step 5: Commit** — `feat(api): project happenings, customer aging buckets, customer mail-thread filter`

---

### Task 3: Client — card system core (types, registry, CardShell, layout persistence, fetchers)

**Files:**
- Create: `src/cards/types.ts`, `src/cards/registry.tsx` (skeleton — populated by Tasks 6-11), `src/cards/CardShell.tsx`, `src/cards/useCardLayout.ts`
- Create: `src/cards/useCardLayout.test.tsx`, `src/cards/CardShell.test.tsx`
- Modify: `src/utils/store.ts` (new fetchers + types)

**Interfaces (consumed by every later task):**

```ts
// src/cards/types.ts
import React from 'react';
export type CardPage = 'dashboard' | 'project' | 'customer';
export type CardWidth = 1 | 2 | 3;
export interface CardContext {
  isAdmin: boolean;
  projectId?: string;
  customerId?: string;
}
export interface CardDef {
  id: string;                       // stable, e.g. 'dash-attention'
  title: string;
  icon: React.FC<{ size?: number; className?: string }>;  // lucide
  page: CardPage;
  widths: CardWidth[];              // supported widths
  defaultWidth: CardWidth;
  adminOnly?: boolean;
  Component: React.FC<{ width: CardWidth; ctx: CardContext }>;
}
export interface CardLayoutEntry { id: string; width: CardWidth }
export interface CardLayout { version: 1; cards: CardLayoutEntry[] }
```

```ts
// src/cards/registry.tsx — skeleton this task; entries added by Tasks 6-11
import { CardDef, CardPage, CardLayout, CardContext } from './types';
export const CARD_REGISTRY: CardDef[] = [];   // populated via registerCards()
export function registerCards(defs: CardDef[]): void { CARD_REGISTRY.push(...defs); }
export function cardsForPage(page: CardPage, ctx: CardContext): CardDef[] {
  return CARD_REGISTRY.filter(c => c.page === page && (!c.adminOnly || ctx.isAdmin));
}
export const DEFAULT_LAYOUTS: Record<CardPage, CardLayout> = {
  dashboard: { version: 1, cards: [
    { id: 'dash-attention', width: 2 }, { id: 'dash-deck', width: 1 },
    { id: 'dash-money', width: 2 }, { id: 'dash-activity', width: 1 },
  ]},
  project: { version: 1, cards: [
    { id: 'pj-financial-band', width: 3 },
    { id: 'pj-open-items', width: 1 }, { id: 'pj-happenings', width: 2 },
  ]},
  customer: { version: 1, cards: [
    { id: 'cu-rollup', width: 3 },
    { id: 'cu-projects', width: 2 }, { id: 'cu-correspondence', width: 1 },
  ]},
};
// Sanitize a stored layout against the registry + ctx: drop unknown/ungated
// ids, clamp widths to each card's supported list, fall back to default.
export function resolveLayout(stored: CardLayout | null, page: CardPage, ctx: CardContext): CardLayout;
```

```ts
// src/cards/useCardLayout.ts
export function useCardLayout(page: CardPage, ctx: CardContext): {
  layout: CardLayout;                       // resolved, instant (localStorage mirror or default)
  setLayout: (l: CardLayout) => void;       // saves: state + localStorage + saveUserPreferences
  reset: () => void;                        // back to DEFAULT_LAYOUTS[page]
};
```
Persistence key `cards-${page}`. Behavior: seed from `localStorage.getItem(key)` (JSON.parse guarded); on mount call `getUserPreferences()` and reconcile (server wins if different); listen for `window 'app:prefs-sync'` and re-reconcile (cross-device gap — the accent-picker lesson); every `setLayout` writes localStorage + `saveUserPreferences({ [key]: JSON.stringify(l) }).catch(() => {})` when a token exists.

```tsx
// src/cards/CardShell.tsx — the standard card chrome: glass, soft-zoom,
// header, and the loading/empty plumbing every card shares.
export const CardShell: React.FC<{
  title: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;      // e.g. "View all" link
  loading?: boolean;              // -> body replaced by 2 Skeleton rows
  empty?: boolean;                // -> body replaced by <CardEmpty>
  emptyTitle?: string;
  emptyIllustration?: EmptyKind;  // Task 12 wires real art; until then icon circle
  flush?: boolean;                // p-0 body for row lists
  children: React.ReactNode;
}>;
```
Rendering: outer `<section ref={softZoomRef} className="soft-zoom glass-panel rounded-xl border border-edge overflow-hidden flex flex-col">` (uses `useSoftZoom` — spec rule 8), header row (px-4 py-2.5, `text-[11px] font-semibold uppercase tracking-wider text-ink-faint` title + actions), body `flex-1` with `px-4 py-3` unless `flush`.

New fetchers in `src/utils/store.ts` (+ exported types mirroring Task 1/2 server shapes verbatim): `getDashboardAttention(): Promise<AttentionItem[]>` (unwraps `.items`), `getDashboardMoney(): Promise<DashboardMoney>`, `getProjectHappenings(projectId, limit = 12): Promise<HappeningItem[]>`, `getCustomerThreads(customerId): Promise<ProjectThread[]>` (reuse the existing project-threads response type — find its client type near the mail fetchers; add if absent).

- [ ] **Step 1: Failing tests.** `useCardLayout.test.tsx`: mock `../utils/store` `getUserPreferences`/`saveUserPreferences`; cases — (a) returns default layout when nothing stored; (b) seeds instantly from localStorage mirror; (c) reconciles to the server value after mount (waitFor); (d) `setLayout` persists to both localStorage and saveUserPreferences with key `cards-dashboard`; (e) `resolveLayout` drops an id not in the registry and clamps width 3 → card's max when unsupported; (f) admin-only card ids are dropped for `ctx.isAdmin === false`. `CardShell.test.tsx`: renders title + children; `loading` shows skeletons and hides children; `empty` shows emptyTitle.
- [ ] **Step 2: RED** — both files.
- [ ] **Step 3: Implement** all four files + store fetchers. Register two throwaway test-only cards inside the test file via `registerCards` for resolveLayout cases (do NOT ship dummy cards in registry.tsx).
- [ ] **Step 4: GREEN + full ui project + lint.**
- [ ] **Step 5: Commit** — `feat(cards): card registry, shell, and per-user layout persistence`

---

### Task 4: Client — CardGrid with customize mode

**Files:**
- Create: `src/cards/CardGrid.tsx`, `src/cards/CardGrid.test.tsx`
- Modify: `src/index.css` (wiggle keyframes for edit mode)

**Interfaces:**
```tsx
export const CardGrid: React.FC<{ page: CardPage; ctx: CardContext }>;
```
Owns: `useCardLayout(page, ctx)`; column count from a window-resize listener (`matchMedia` breakpoints 1600/1024/640 — mirror AppShell's pattern); `editing` state.

Render contract (test contract — keep these testids/labels):
- Toolbar row: `<button data-testid="cards-customize">⚙ Customize</button>` toggling to `✓ Done`; while editing also `<button data-testid="cards-reset">Reset to default</button>`.
- Grid: `<div data-testid="card-grid" className="grid gap-3" style={{ gridTemplateColumns: \`repeat(${cols}, minmax(0, 1fr)) \` }}>`. Each card wrapper: `<div data-card-id={id} style={{ gridColumn: \`span ${Math.min(width, cols)}\` }}>`; renders `def.Component({ width: effectiveWidth, ctx })` inside `CardShell`-based cards (cards render their own shell).
- Editing decorations per wrapper: `animate-[card-wiggle_.4s_ease-in-out_infinite_alternate]` class on the wrapper (CSS added this task; `.motion-reduce` neutralizer too), a remove button `aria-label={\`Remove ${def.title}\`}`, a width control `<div role="group" aria-label={\`${def.title} width\`}>` with buttons `1|2|3` (only the card's supported widths; active gets `glow-accent` — allowed: it's a control, not a card), and native drag: wrapper `draggable` with `onDragStart` (store id in a ref), `onDragOver` preventDefault, `onDrop` reorder-before-target via `setLayout`.
- Add tray (editing only): `<div data-testid="cards-tray">` listing `cardsForPage(page, ctx)` not in the layout as `+ {title}` buttons appending `{ id, width: defaultWidth }`.
- Empty layout (all removed): tray still reachable; grid shows a small hint.

- [ ] **Step 1: Failing tests** (register 3 fake cards for page 'dashboard' in-test via `registerCards`, widths [1,2,3]/[1]/[1,2], one adminOnly): (a) renders layout cards in order with span style; (b) span clamps: width-3 card at cols=2 → `span 2` (drive cols by mocking matchMedia — the setup.ts stub returns non-matching; override per-test); (c) Customize reveals remove/width/tray; (d) width button 2 updates layout (assert saveUserPreferences called with width 2); (e) remove moves card to tray; tray click re-adds; (f) adminOnly card absent from tray for non-admin ctx; (g) reset restores defaults; (h) drag: fire dragstart on card A, drop on card C → order [B?…] assert new order persisted (fireEvent.dragStart/dragOver/drop).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** + CSS: `@keyframes card-wiggle { from { transform: rotate(-0.35deg); } to { transform: rotate(0.35deg); } }` at file scope; `.motion-reduce [class*='card-wiggle'] { animation: none; }` next to the motion-reduce rules.
- [ ] **Step 4: GREEN + full ui + lint.**
- [ ] **Step 5: Commit** — `feat(cards): responsive clamping grid with customize mode (drag/remove/width/tray/reset)`

---

### Task 5: Client — CountUp + Sparkline motion primitives

**Files:**
- Create: `src/components/motion/CountUp.tsx`, `src/components/motion/CountUp.test.tsx`
- Create: `src/components/charts/Sparkline.tsx`, `src/components/charts/Sparkline.test.tsx`

**Interfaces:**
```tsx
// CountUp: animated number. Formats via the caller's formatter so money uses
// formatMoney(cents) and plain counts use toLocaleString.
export const CountUp: React.FC<{ value: number; format?: (v: number) => string; className?: string; durationMs?: number }>;
// Behavior: on mount and when `value` changes, animate displayed value from
// previous → new using motion's animate(from, to, { duration, ease: 'easeOut',
// onUpdate }) rounding each frame. useTheme().reducedMotion → render final
// value immediately, no animation. Cleanup stops the animation on unmount.

// Sparkline: inline-SVG line + soft area fill from the accent color.
export const Sparkline: React.FC<{
  points: number[];                // y values, evenly spaced
  height?: number;                 // default 36
  className?: string;              // width via container (svg width 100%, preserveAspectRatio none)
  'data-testid'?: string;
}>;
// Path from normalized points (guard: <2 points or flat range → straight
// mid-line). Stroke oklch(0.62 0.18 var(--accent-h)) width 1.5, area fill via
// a <linearGradient> to transparent. Draw-in: animate stroke-dashoffset via a
// CSS class `chart-draw` (add tiny CSS in the component file? No — add the
// keyframes to src/index.css in this task) — skipped when reducedMotion.
```

- [ ] **Step 1: Failing tests.** CountUp: reducedMotion (`localStorage['theme-motion']='reduced'` + ThemeProvider) renders the exact formatted final value synchronously; normal mode eventually shows final value (use vi.useFakeTimers + advance, or waitFor real timers; motion's animate uses rAF — stub rAF to run callbacks with increasing timestamps, the repo has no rAF helpers so drive with `vi.stubGlobal`). Format prop applied (`formatMoney(148200)` style). Sparkline: renders an `<svg>` with one `<path>` whose `d` starts with `M`; flat/short input doesn't NaN (d contains no 'NaN').
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** (+ `@keyframes chart-draw` + `.chart-draw` + motion-reduce neutralizer in index.css).
- [ ] **Step 4: GREEN + full ui + lint.**
- [ ] **Step 5: Commit** — `feat(motion): CountUp ticker + accent Sparkline with draw-in`

---

### Task 6: Dashboard — four default cards + page rewrite

**Files:**
- Create: `src/cards/dashboard/coreCards.tsx` (the 4 defaults), `src/cards/dashboard/coreCards.test.tsx`
- Modify: `src/pages/Dashboard.tsx` (full rewrite), `src/pages/Dashboard.test.tsx` (exists — update)
- Modify: `src/cards/registry.tsx` (import + registerCards side-effect module `./dashboard/coreCards`)

**Interfaces:** registers card ids `dash-attention` (widths [1,2,3], default 2), `dash-money` (adminOnly, [1,2,3], default 2), `dash-deck` ([1,2], default 1), `dash-activity` ([1,2], default 1). Keep helper exports `timeAgo`, `startOfWeek`, `hoursThisWeek` in Dashboard.tsx (ProjectOverview imports them).

Card specs (each its own `CardShell`, own fetch, own `useLiveQuery`):
- **dash-attention** "⚡ Needs your attention" — `getDashboardAttention()`; `useLiveQuery(load, { types: ['task','project','rfi','invoice','aiaPayApp','payment'] })`. Rows: severity dot (`bg-red-400`/`bg-amber-400`, no glow), label + sub, deep link per type: overdue_task → `/tasks`, bid_due → `/project/${projectId}`, aging_receivable/draft_payapp → `/project/${projectId}/billing`, stale_rfi → `/project/${projectId}/rfis`. Count badge in header. Width 1 renders top 4 rows, width 2-3 up to 8. Empty: "Nothing needs you — enjoy it."
- **dash-money** "Money pulse" (adminOnly) — `getDashboardMoney()`; types `['invoice','payment','aiaPayApp','changeOrder','project']`. `CountUp value={outstandingCents} format={formatMoney}` headline; `Sparkline points={trend.map(t => t.paidCents)}`; sub-row: billed vs contract % + `draftPayAppCount` chip + last payment line. Width 1: number + sparkline only.
- **dash-deck** "📅 On deck" — composes existing data: `getTasks()` scoped like today's mine/all toggle (keep the segmented toggle in the card header via `headerActions`-style actions; scope state LOCAL to card, default 'mine') via `upcomingTaskItems`, PLUS bid deadlines from `getProjectsSummary()` (BIDDING + bidDueDate, soonest 3, chip style). Reuse `UpcomingTasksCard`'s item shape, not the component (shell differs).
- **dash-activity** "Team activity" — `getActivity(10)` rendered as today's rows (reuse `activityTarget`).

Dashboard.tsx becomes:
```tsx
// header (greeting + New Project button, unchanged copy) then:
<CardGrid page="dashboard" ctx={{ isAdmin }} />
```
inside the existing `mx-auto max-w-6xl px-4 py-6 md:px-8` wrapper. Delete the six inline Card sections (their non-default content returns as library cards in Task 7 — bid deadlines & proposals & hours live on in those).

- [ ] **Step 1: Failing tests** — coreCards.test.tsx (mock store fetchers; per card: renders rows from mocked data; attention deep-link hrefs; money hidden path = registry `adminOnly` flag asserted; deck's mine/all toggle filters). Update Dashboard.test.tsx to assert: greeting renders, `card-grid` present, default card titles visible (mock fetchers), and for non-admin the money card is absent.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** (registry.tsx gains `import './dashboard/coreCards';` — side-effect registration at module load; Dashboard imports CardGrid which imports registry).
- [ ] **Step 4: GREEN (focused + FULL ui suite — Dashboard rewrite can ripple) + lint.**
- [ ] **Step 5: Commit** — `feat(dashboard): command-center card grid with attention/money/deck/activity defaults`

---

### Task 7: Dashboard — remaining 8 library cards

**Files:**
- Create: `src/cards/dashboard/libraryCards.tsx`, `src/cards/dashboard/libraryCards.test.tsx`
- Modify: `src/cards/registry.tsx` (side-effect import)

**Interfaces:** registers: `dash-project-health` ([2,3], d2) — `getProjectsSummary()` ACTIVE projects as mini rows: name, stage pill, open-items count (`openIssueCount + (punchTotal - punchDone)`), admin adds billed % (`outstandingCents`/`contractValueCents` guarded); `dash-mail-peek` ([1,2], d1) — `getMailUnreadCount`-style: reuse `useMailUnread()` hook + `getCustomerThreads`? NO — inbox peek uses the existing mail unread endpoint via `useMailUnread` for the count plus link to `/mail` (keep it simple: count + CTA; threads list needs account context that lives in MailPage); `dash-proposals` (adminOnly, [1,2], d1) — `getOutstandingProposals()`, rows like today's card incl. `expiryText`; `dash-my-hours` ([1], d1) — `getMyTimeEntries()` + `hoursThisWeek`, `CountUp` on the number; `dash-payments` (adminOnly, [1,2], d1) — `getDashboardMoney().recentPayments` rows; `dash-aging` (adminOnly, [1,2], d1) — derive buckets client-side from `getDashboardAttention()` aging_receivable items (sum balanceCents by ageDays 0-30/31-60/61+; three tiles like the customer band); `dash-quick-actions` ([1], d1) — buttons: New Project → `/new`, New Task → `/tasks?new=1`, Clock in (calls `clockIn()` w/ toast); `dash-recent-docs` ([1,2], d1) — `getDocuments({ limit: 6 })` newest, rows linking `/documents`.

Bid deadlines note: `dash-deck` covers them; ALSO register `dash-bid-deadlines` ([1,2], d1) with exactly today's card content (5 rows, overdue red) so users who liked the standalone card can add it. (That makes 9 in this task, 13 dashboard cards total — supersedes the "12" figure; ledger it, spec said build them all.)

- [ ] **Step 1: Failing tests** — one render test per card with mocked fetchers (rows appear; links correct; adminOnly flags on the right ids; aging bucket math: 3 seeded items land in 3 buckets).
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN + full ui + lint.**
- [ ] **Step 5: Commit** — `feat(dashboard): full card library (9 optional cards)`

---

### Task 8: Project — defaults (financial band, open items, happenings) + Overview rewrite

**Files:**
- Create: `src/cards/project/coreCards.tsx`, `src/cards/project/coreCards.test.tsx`
- Modify: `src/pages/project/ProjectOverview.tsx` (rewrite), its test if present
- Modify: `src/cards/registry.tsx` (side-effect import)

**Interfaces:** cards receive `ctx.projectId` (required on this page — CardGrid passes it). Registers:
- **pj-financial-band** (adminOnly, [2,3], d3) "Financial progress" — `getBillingSummary(projectId)` (admin route): segmented bar built from ledger-family fields: paid = `paid.invoicesCents + payAppPaidCents`, awaiting = `invoiceOutstandingBilledCents + payAppOutstandingCents`, remaining = `max(0, contractTotalCents - billed)` where billed = `invoiceBilledCents + payAppBilledCents`; percentages of `contractTotalCents` (guard 0). Bar: three flex segments (emerald gradient / accent gradient `glow-bar`-style allowed? NO — only the progress bar element itself may glow: use one wrapping `rounded-full overflow-hidden` with plain gradient segments and NO glow shadow except… keep it simple: plain gradient segments, no glow — the ration allows progress bars, but multi-segment: apply `glow-bar` ONLY if visually needed; default plain). Legend chips + `CountUp` on contract total + "Next: Pay app #N in draft · $X" callout from `getPayApps(projectId)` newest draft. Width 2 hides the legend.
- **pj-open-items** ([1,2], d1) "Open items" — `useProjectOutlet` is NOT available inside cards (cards are generic); fetch `getProjectSummary(projectId)` → tiles: open issues, punch left (`punchTotal - punchDone`), plus `getRfis(projectId)` open count, `getTasks({ projectId })` overdue count. 2×2 tile grid at width 1, 4-across at 2.
- **pj-happenings** ([1,2,3], d2) "Recent happenings" — `getProjectHappenings(projectId)`; icon per kind/type (mail ✉, payment 💰 style lucide icons: Mail, DollarSign, ClipboardCheck, CalendarDays, FileText fallback), `timeAgo` stamps, activity rows link via `activityTarget`.

ProjectOverview.tsx rewrite — PRESERVE: legacy `?tab=` redirect (lines 41-42 verbatim, first thing after hooks); header block with `summary.name` skeleton + `ProjectStageControl` exactly as today (:63-79); THEN `<CardGrid page="project" ctx={{ isAdmin, projectId: summary?.id }} />` — but CardGrid needs a real projectId: render the grid only when `summary` is loaded (skeleton grid otherwise), and `key={summary.id}` on CardGrid (per-project state isolation gotcha from memory). Details/Actions/Activity/Hours content returns as library cards in Task 9.

- [ ] **Step 1: Failing tests** — coreCards: band math from a mocked BillingSummary (seed numbers → segment widths as style percentages; draft payapp callout), open-items counts render, happenings rows with kind icons. Overview test: redirect still fires for `?tab=x`; stage control present; card-grid present when summary given.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN + FULL ui + lint.**
- [ ] **Step 5: Commit** — `feat(project): progress-story overview with financial band + open items + happenings`

---

### Task 9: Project — remaining 15 library cards

**Files:**
- Create: `src/cards/project/libraryCards.tsx`, `src/cards/project/libraryCards.test.tsx`
- Modify: `src/cards/registry.tsx` (side-effect import)

**Interfaces:** registers (all take `ctx.projectId`; data via existing per-project fetchers; each spec row = title · widths/default · data → render):
`pj-billed-ring` (adminOnly, [1], 1) — getBillingSummary → SVG donut (billed% of contract; stroke `oklch(0.62 0.18 var(--accent-h))`, track `var(--edge)`), center CountUp %.
`pj-payapp-nudge` (adminOnly, [1,2], 1) — getPayApps newest `status='draft'` → amber callout card w/ amount (`totalCents` null-safe: compute via balance? use listPayApps' totalCents) + Link to billing; empty state "No draft pay apps".
`pj-plan-set` ([1,2], 1) — getProjectSummary → `pageCount` pages chip + Link to `takeoff`; label "Current plan set".
`pj-takeoff-totals` ([1,2], 1) — getProjectSummary → takeoffCount + Link.
`pj-punch-ring` ([1], 1) — summary punchDone/punchTotal → donut + `ProgressBar` fallback at width 1? Use ProgressBar (existing, glows legitimately).
`pj-photo-strip` ([2,3], 2) — `getIssues` + `getPunchItems` photo ids (first 8): thumbnails via the existing image URL pattern (`/api/images/:id` — confirm exact helper in store.ts and reuse; if a helper like `imageUrl(id)` exists use it, else construct as DocumentsPage does).
`pj-change-orders` (adminOnly, [1,2], 1) — `getChangeOrders(projectId)` → approved total, pending count, latest CO status pill.
`pj-daily-latest` ([1,2], 1) — `getDailyReports(projectId)` newest → date, weatherSummary, manCounts total, notes preview.
`pj-mail-threads` ([1,2], 1) — existing project-threads fetcher (same one ProjectMail uses — locate in store.ts/mail utils) → top 4 by lastActivity, reply-needed chip when `lastInboundDate > lastOutboundDate`.
`pj-key-dates` ([1], 1) — summary createdAt / bidDueDate w/ countdown text.
`pj-contacts` ([1], 1) — summary contractor + customer name via `getCustomerOverview(summary.customerId)` guarded; mailto links where emails exist (customer emails JSON).
`pj-proposal-status` (adminOnly, [1,2], 1) — `getProposals(projectId)` newest → status pill + total + sentAt.
`pj-docs-shortcuts` ([1,2], 1) — `getDocuments({ projectIds: [projectId], limit: 5 })` rows → project documents tab links.
`pj-actions` ([1,2], 1) — today's Actions card verbatim as a card (clock-in + 3 links).
`pj-my-hours` ([1], 1) — today's hours card content (total + week) with CountUp.

- [ ] **Step 1: Failing tests** — render test per card w/ mocked fetchers (focus: math — ring %, CO totals; link targets; adminOnly ids).
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN + full ui + lint.**
- [ ] **Step 5: Commit** — `feat(project): full project card library (15 optional cards)`

---

### Task 10: Customer — independent scrolling + card-grid Overview tab

**Files:**
- Modify: `src/pages/customers/CustomersSplitView.tsx` (bounded-height fix)
- Modify: `src/pages/customers/CustomerPane.tsx` (Overview tab → CardGrid; keep everything else)
- Create: `src/cards/customer/coreCards.tsx`, `src/cards/customer/coreCards.test.tsx`
- Modify: `src/cards/registry.tsx` (side-effect import)
- Modify: `src/pages/customers/CustomerOverviewTab.tsx` → DELETED (content becomes cards; `AttentionRow`/`attentionHref` move into coreCards.tsx keeping `data-testid="customer-attention-row"`)

**The scroll fix (exact):** in CustomersSplitView.tsx line 64, `min-h-full` → a bounded box: `className="flex bg-surface h-[calc(100dvh)] md:h-screen"` is WRONG under the mobile top bar — use: `h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] md:h-dvh` matching AppShell's mobile `paddingTop: calc(3.5rem + env(safe-area-inset-top))` (desktop has no top bar → full dvh). With the parent bounded, the existing `CustomerSidebar` `overflow-y-auto` (its :51) and `CustomerPane` `overflow-y-auto` (:90/191) become independent scrollers and the pane's sticky header engages. Verify both columns scroll independently in the dev server.

**Cards** (ctx.customerId): 
- **cu-rollup** (adminOnly, [2,3], d3) "Financials" — `getCustomerOverview(customerId)` → band: CountUp outstanding + oldest-age note (max ageDays over attention aging items), lifetime billed/paid (`billing.invoicedCents/paidCents`), aging buckets from `billing.aging` (Task 2) as three tiles (emerald/amber/red-muted).
- **cu-projects** ([1,2,3], d2) "Their projects" — overview.projects rows: name, status pill, admin billed-% mini-bar (`outstandingCents` guarded), archived dimmed, Link `/project/:id`.
- **cu-correspondence** ([1,2], d1) "Correspondence" — `getCustomerThreads(customerId)` top 5: subjectSnapshot, reply chip, lastActivity `timeAgo`.
- **cu-attention** ([1,2], d1) "Needs attention" — overview.attention via the migrated `AttentionRow` (testid preserved). In DEFAULT_LAYOUTS.customer add it: update Task 3's default customer layout to `[cu-rollup 3, cu-projects 2, cu-attention 1, cu-correspondence 1]` — note this ADJUSTS the Task 3 skeleton (do it here; Task 3's literal had a 3-card placeholder).

CustomerPane change: the `activeTab === 'overview'` branch renders `<CardGrid page="customer" ctx={{ isAdmin: admin, customerId: customer.id }} key={customer.id} />`; pass nothing else — cards fetch their own overview (accept the duplicate fetch; CustomerPane still fetches for the header slot). Non-admin default resolution drops cu-rollup automatically (resolveLayout).

- [ ] **Step 1: Failing tests** — coreCards: rollup buckets/labels from mocked overview; projects rows; attention rows keep testid + hrefs (`overdue_task → /tasks?customerId=…` etc. verbatim from old attentionHref); correspondence rows. Pane test (customers e2e covers most — add/keep a ui test that Overview tab renders card-grid).
- [ ] **Step 2: RED.** **Step 3: Implement + delete CustomerOverviewTab.tsx.** **Step 4: GREEN + full ui + lint. Dev-server check of the two independent scrollbars (desktop + narrow).**
- [ ] **Step 5: Commit** — `feat(customers): independent-scroll split view + card-grid overview`

---

### Task 11: Customer — remaining library cards

**Files:**
- Create: `src/cards/customer/libraryCards.tsx` + test
- Modify: `src/cards/registry.tsx`

**Interfaces:** `cu-payments` (adminOnly, [1,2], 1) — ledger entries from `getCustomerOverview().billing.ledger` with paidCents > 0 newest 5 (or payments via docs — use ledger rows, they carry kind/number/date/paidCents); `cu-open-items` ([1,2], 1) — Σ over overview.projects of open issues etc. — projects rows lack issue counts → use `getProjectsSummary()` filtered to customerId for openIssueCount/punch (fields exist there); `cu-tasks` ([1,2], 1) — `getTasks({ customerId })` via `upcomingTaskItems`; `cu-notes` ([1,2], 1) — overview.customer.notes rendered (read-only, Link to settings tab to edit).

- [ ] Steps: failing tests → RED → implement → GREEN + full ui + lint → commit `feat(customers): customer card library (4 optional cards)`.

---

### Task 12: Illustrated empty states

**Files:**
- Create: `src/components/illustrations/EmptyArt.tsx` + `EmptyArt.test.tsx`
- Modify: `src/cards/CardShell.tsx` (wire `emptyIllustration`)

**Interfaces:**
```tsx
export type EmptyKind = 'clear' | 'inbox' | 'money' | 'checklist' | 'photos' | 'blueprint';
export const EmptyArt: React.FC<{ kind: EmptyKind; className?: string }>;
```
Six inline-SVG illustrations (~96×72 viewBox), blueprint/construction motifs, stroked in `oklch(0.62 0.12 var(--accent-h))` with a soft `oklch(0.62 0.18 var(--accent-h) / 0.12)` fill accent and `var(--ink-faint)` secondary strokes — theme- and accent-reactive by construction. Draw each concretely: `clear` = sun over a ruled horizon; `inbox` = open envelope + sheet; `money` = coin stack + rising tick; `checklist` = clipboard with two checked rows; `photos` = two overlapping photo frames w/ mountain glyph; `blueprint` = rolled plan + grid corner. Keep each `<path>` set simple (5-10 elements). CardShell: `empty` renders `<EmptyArt kind={emptyIllustration ?? 'clear'} className="mb-2 h-16" />` above the title. Cards pick kinds (attention→clear, correspondence/mail→inbox, money/aging/payments→money, deck/tasks/punch→checklist, photo-strip→photos, plan-set/docs→blueprint) — update the card files' `emptyIllustration` props in this task.

- [ ] Steps: failing test (renders svg per kind; unknown-safe) → RED → implement + wire → GREEN + full ui + lint → commit `feat(ui): illustrated empty states for cards`.

---

### Task 13: E2E — customize/persist/clamp + hover law on cards + customer scroll

**Files:**
- Create: `e2e/cards.spec.ts`
- Modify: `e2e/shell-rehaul.spec.ts` (extend to 3 card sizes)
- Modify: `e2e/customers.spec.ts` ONLY if its Overview-tab assertions target removed markup (attention rows keep their testid; stat tiles are gone → update those assertions to the new card equivalents, preserving the behavior contract: counts/amounts derived from `seedCustomerWithPortfolio` still visible on the Overview tab)

**e2e/cards.spec.ts** (use `authedPage` + `seedCustomerWithPortfolio`):
1. *customize persists*: /dashboard → `cards-customize` → remove `dash-activity` (aria-label) → set `dash-deck` width 2 → Done → `page.reload()` → activity card absent, deck spans 2 (assert via `data-card-id` element's `gridColumn` style or boundingBox width ≈ 2 cols).
2. *clamping*: `page.setViewportSize({ width: 1280, height: 900 })` → 3 cols, attention (width 2) spans 2; `{ width: 800 }` → 2 cols; `{ width: 500 }` → 1 col, every card boundingBox width ≈ container width.
3. *tray restore*: re-add removed card; reset-to-default restores 4 defaults.
4. *hover law on cards* (extends shell-rehaul or here): for a 1-wide card, a 2-wide card, and the 3-wide financial band (project page of seeded in-progress project, admin): boundingBox before/after hover → width growth > 0 (proves soft-zoom attached) AND < 11 (proves the law) at each size.
5. *customer scroll independence*: /customers/:id (seeded) → measure `customer-pane` scrollTop after `mouse.wheel` over the pane → sidebar's list scrollTop unchanged.
6. *non-admin gating*: `loginAsNewUser` context → /dashboard shows no Money pulse and tray lacks it.

- [ ] Steps: write specs → `npm run test:e2e -- cards.spec.ts shell-rehaul.spec.ts customers.spec.ts` until green (fix spec locators, never app behavior without reporting) → commit `test(e2e): card system coverage — persistence, clamping, hover law, scroll independence`.

---

### Task 14: Wave verification + changelog + push

- [ ] **Step 1:** `npm test` (both projects) — all green (known DocumentActionsBar flake protocol: isolate-rerun once).
- [ ] **Step 2:** `npm run lint`.
- [ ] **Step 3:** FULL `npm run test:e2e` — all specs (81 + new). Stale-locator fixes allowed for intentionally changed surfaces (old dashboard cards, customer overview tab); any app regression → BLOCKED.
- [ ] **Step 4:** Changelog entry v2.13.0 "UI Rehaul Wave 2 — Command Center" in src/pages/Settings.tsx CHANGELOG array (match prose style; cover: customizable cards on dashboard/project/customer, the defaults, attention feed, money pulse, aging buckets, independent customer scrolling, illustrated empty states).
- [ ] **Step 5:** `git add -A && git commit -m "feat(ui): UI Rehaul Wave 2 — card system & landing pages (v2.13.0)" && git push origin testing`.
- [ ] **Step 6:** Report with Nathan's smoke checklist: customize each page type + reload + second browser (cross-device sync), non-admin login, phone width, customer pane scroll, attention deep links, money figures vs Billing tab.

---

## Self-Review Notes (completed)

- **Spec coverage (§9 Wave 2)**: registry+customize ✓ T3/T4 · responsive clamping ✓ T4 · Command Center ✓ T6 · Progress Story ✓ T8 · customer pane + scroll fix ✓ T10 · aggregate endpoints ✓ T1/T2 (rollup implemented as overview extension; happenings merges activity+mail — deviation from four literal new routes, ledgered) · skeletons/tickers/charts ✓ T3/T5 · illustrated empty states ✓ T12 · hover-law e2e made meaningful ✓ T13 (closes Wave 1's deferral).
- **Card count**: 13 dashboard + 18 project + 8 customer = 39 ("build them all" honored; counts drifted +3 from spec §5.2 by preserving today's bid-deadlines/actions/hours content as cards — additive, ledgered).
- **Type consistency**: `CardDef/CardContext/CardLayout` defined once (T3), consumed T4/T6-T11; `AttentionItem/DashboardMoney/HappeningItem` defined server-side T1/T2 and mirrored in store.ts T3; `EmptyKind` T12 referenced as optional prop from T3 (prop exists from T3, art lands T12 — interim renders icon circle, no forward reference breakage).
- **Placeholder scan**: card batch tasks specify per-card data source, widths, and render content; test steps name concrete cases. Server tasks carry full route code and rule tables. No TBDs.
