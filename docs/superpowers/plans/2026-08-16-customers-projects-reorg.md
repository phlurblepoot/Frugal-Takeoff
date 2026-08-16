# Customers & Projects Reorganization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two-stage project lifecycle (bidding / in_progress + archive flag), a three-tab Projects page, and a split-view Customers section with a tabbed per-customer pane (Overview / Projects / Tasks / Billing / Settings) fed by new customer-rollup endpoints.

**Architecture:** Server first: collapse `PROJECT_STATUSES`, add migration 21 (status rewrite + auto-archive + lostBid), then customer aggregation endpoints reusing per-project `billingSummary`. Client follows: ProjectsPage rewrite (3 tabs), stage control simplification, then the customers split view built in two passes (shell + data tabs). E2E last.

**Tech Stack:** React + TS (Vite), Express + better-sqlite3, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-16-customers-projects-reorg-design.md` — read it first. Mockups chosen: customers = split view C2; projects = three-tab P2.

## Global Constraints

- Branch `testing` (commit there; no pushes mid-plan, no PRs).
- Stage collapse mapping (exact): estimating→bidding, proposal_sent→bidding, awarded→in_progress, in_progress→in_progress, punch_list→in_progress, complete→in_progress+archived=true, lost→bidding+archived=true+lostBid=true, archived(legacy status value)→in_progress+archived=true, unknown→bidding.
- Migration 21 is DATA-TRANSFORMING: it must be non-destructive to everything except `projects.status`/meta flags, idempotent, and covered by unit tests. It will run supervised on real data later — the plan only ships + tests it.
- Money fields stay admin-gated exactly as today (`includeBilling`/`isAdmin` pattern in routes).
- Run `npx vitest run` (742 green at start) + `npx tsc --noEmit` before every commit.
- Never touch `data/` or live data. Never `git add` docs/*.pdf.
- Comments explain why; match file idioms.

---

### Task 1: Server lifecycle collapse + migration 21

**Files:**
- Modify: `server/projectStore.ts` (PROJECT_STATUSES ~line 13, `deriveStatus` ~135, `patchProject` ALLOWED/validation ~340-360)
- Modify: `server/migrationList.ts` (append migration 21)
- Test: `server/projectStore.test.ts`, `server/migrationList.test.ts` (append; read both first and mirror their fixture idioms)

**Interfaces:**
- Produces: `PROJECT_STATUSES = ['bidding', 'in_progress']`; `normalizeProjectStatus(s: unknown): 'bidding' | 'in_progress'` (exported — client tasks import the mapping semantics, not the function); patch field `lostBid` (boolean, stored in meta like `archived`); migration 21.

- [ ] **Step 1: Failing tests.** In `projectStore.test.ts` add (adapt to the file's existing db-fixture helpers):

```ts
describe('two-stage lifecycle', () => {
  it('normalizes every legacy status per the collapse table', () => {
    const cases: [string, string][] = [
      ['estimating', 'bidding'], ['proposal_sent', 'bidding'],
      ['awarded', 'in_progress'], ['in_progress', 'in_progress'],
      ['punch_list', 'in_progress'], ['complete', 'in_progress'],
      ['lost', 'bidding'], ['archived', 'in_progress'],
      ['garbage', 'bidding'],
    ];
    for (const [oldS, newS] of cases) expect(normalizeProjectStatus(oldS)).toBe(newS);
  });
  it('patchProject rejects legacy statuses and accepts the two live ones', () => { /* patch status:'bidding' ok, 'estimating' throws ValidationError */ });
  it('patchProject accepts lostBid boolean and stores it in meta', () => { /* patch lostBid:true → loadProject shows lostBid true; non-boolean throws */ });
});
```

In `migrationList.test.ts` add a migration-21 test: seed a db (using the file's existing harness) with one project per legacy status, run migrations, assert each row's `(status, meta.archived, meta.lostBid)` matches the collapse table — in particular `complete` → `('in_progress', true, undefined)` and `lost` → `('bidding', true, true)` — and that already-archived projects keep `archived: true`. Run twice → identical (idempotent).

- [ ] **Step 2: Verify RED** — `npx vitest run server/projectStore.test.ts server/migrationList.test.ts`.

- [ ] **Step 3: Implement.**

```ts
// projectStore.ts — replaces the 8-value list
export const PROJECT_STATUSES = ['bidding', 'in_progress'] as const;

// Collapse table for the two-stage lifecycle (spec 2026-08-16). Legacy values
// arrive from old full-document saves and pre-migration rows; anything
// unrecognized is treated as a bid so nothing vanishes.
const LEGACY_STATUS_MAP: Record<string, 'bidding' | 'in_progress'> = {
  estimating: 'bidding', proposal_sent: 'bidding', lost: 'bidding',
  awarded: 'in_progress', in_progress: 'in_progress',
  punch_list: 'in_progress', complete: 'in_progress', archived: 'in_progress',
};
export function normalizeProjectStatus(s: unknown): 'bidding' | 'in_progress' {
  if (s === 'bidding' || s === 'in_progress') return s;
  return LEGACY_STATUS_MAP[String(s)] ?? 'bidding';
}

// deriveStatus: full-document saves carry the client's status; normalize it.
// The archived flag no longer influences status (it is orthogonal).
export function deriveStatus(meta: any, existing?: string): string {
  if (existing) return normalizeProjectStatus(existing);
  if (meta.accepted) return 'in_progress';
  return 'bidding';
}
```

`patchProject`: add `'lostBid'` to `ALLOWED`; validate boolean like `archived`; persist it into meta the same way `archived` is persisted (READ the archived-handling code below the validation block first and mirror it exactly). Status validation now naturally accepts only the two live values.

Migration 21 (append in `migrationList.ts`, mirroring the file's `Migration` shape and comment style):

```ts
{
  id: 21,
  name: 'two-stage project lifecycle',
  // Collapses the 8 legacy stages to bidding|in_progress. complete/lost
  // auto-archive (lost also gets meta.lostBid for the Archive view's badge).
  // Only projects.status + meta.archived/meta.lostBid change — idempotent.
  up: (db) => {
    const rows = db.prepare('SELECT id, status, meta FROM projects').all() as any[];
    const upd = db.prepare('UPDATE projects SET status = ?, meta = ? WHERE id = ?');
    for (const r of rows) {
      const old = r.status ?? 'estimating';
      const meta = r.meta ? JSON.parse(r.meta) : {};
      let status: string;
      if (old === 'bidding' || old === 'in_progress') status = old; // re-run safe
      else if (['estimating', 'proposal_sent'].includes(old)) status = 'bidding';
      else if (['awarded', 'punch_list'].includes(old)) status = 'in_progress';
      else if (old === 'complete') { status = 'in_progress'; meta.archived = true; }
      else if (old === 'archived') { status = 'in_progress'; meta.archived = true; }
      else if (old === 'lost') { status = 'bidding'; meta.archived = true; meta.lostBid = true; }
      else status = 'bidding';
      upd.run(status, JSON.stringify(meta), r.id);
    }
  },
},
```

(Adapt the exact `up` signature to the file's existing migration entries — read a recent one, e.g. migration 20, first.)

- [ ] **Step 4: GREEN + full suites** — targeted tests pass, then `npx vitest run && npx tsc --noEmit`. Expect client-side failures ONLY if something imports removed status literals server-side — client constants are updated in Task 3; if a SHARED test (e.g. `src/components/ui/StatusPill.test.tsx` iterating `PROJECT_STATUSES`) breaks, note it in your report for Task 3 rather than fixing client files yourself — UNLESS the full suite cannot go green without it, in which case make the minimal client-constant edit and flag it prominently.

- [ ] **Step 5: Commit** — `feat(lifecycle): two-stage project statuses + migration 21 (auto-archive complete/lost)`

---

### Task 2: Customer rollup endpoints + contractor sync

**Files:**
- Modify: `server/customerStore.ts` (aggregation functions)
- Modify: `server/routes.ts` (two new GET routes near the existing customer routes; read how existing customer routes authenticate)
- Modify: `server/projectStore.ts` (`listProjectSummaries` billing tail ~line 297: add `outstandingCents`)
- Test: `server/customerStore.test.ts` (append), `server/routes.test.ts` (append if customer routes are tested there — read first)

**Interfaces:**
- Consumes: `billingSummary(db, projectId)` (`server/billingStore.ts:341` — returns `outstandingCents`, `contractTotalCents`, `invoiceCount` etc.), task rows (`tasks` table: status, dueDate `YYYY-MM-DD`, customerId), `normalizeProjectStatus` (Task 1).
- Produces:
  - `GET /api/customers/summary` (authenticated): `[{ id, name, contactName, phone, projectCounts: { bidding, inProgress, archived }, openTaskCount, overdueTaskCount, outstandingCents? }]` — `outstandingCents` only when the requester is admin (mirror the `includeBilling` gating used by `/api/projects/summary`, see `server/routes.ts:81-89`).
  - `GET /api/customers/:id/overview` (authenticated): `{ customer, projects: [{ id, name, status, archived, lostBid, bidDueDate, updatedAt, outstandingCents? }], billing?: { contractTotalCents, invoicedCents, paidCents, outstandingCents, ledger: [{ projectId, projectName, kind: 'invoice'|'payapp', number, date, status, totalCents, paidCents, balanceCents }] }, attention: [{ type: 'overdue_task'|'bid_due'|'outstanding_invoice', label, projectId?, taskId?, date?, ageDays?, balanceCents? }], taskCounts: { open, overdue } }` — `billing` present only for admins; `attention` money items only for admins.
  - `outstandingCents` added to project summary rows when `includeBilling` (from `billingSummary(db, r.id).outstandingCents`).

- [ ] **Step 1: Failing tests** — in `customerStore.test.ts` (mirror its db fixture): seed 1 customer with 3 projects (bidding w/ bidDueDate 10 days out; in_progress w/ a sent invoice of 100_00 cents unpaid; archived), plus 1 overdue task (dueDate yesterday, status 'todo') and 1 done task. Assert `customerSummaries(db)` returns projectCounts `{bidding:1, inProgress:1, archived:1}`, openTaskCount 1, overdueTaskCount 1, outstandingCents 100_00. Assert `customerOverview(db, id)` includes the invoice in `billing.ledger` with balanceCents 100_00, an `attention` array containing one `overdue_task`, one `bid_due`, one `outstanding_invoice`. Ledger/billing math reuses billingStore fixtures — READ `server/billingStore.test.ts` for how invoices are seeded and copy that idiom.

- [ ] **Step 2: RED**, then **Step 3: Implement.** In `customerStore.ts`:

```ts
export function customerSummaries(db: Database.Database, includeBilling: boolean): any[]
export function customerOverview(db: Database.Database, customerId: string, includeBilling: boolean): any | null
```

Implementation notes (follow, don't improvise): counts via `SELECT customerId, status, COALESCE(json_extract(meta,'$.archived'),0) AS archived FROM projects` grouped in JS; archived projects count under `archived` regardless of status; outstanding = Σ `billingSummary(db, p.id).outstandingCents` over NON-archived projects; task counts from `tasks WHERE customerId = ?` (status != 'done' = open; open AND dueDate < today = overdue; compare `YYYY-MM-DD` strings against today's local date string). `attention` for overview: overdue tasks (label = task title, project name if any); bidding projects with `bidDueDate` within the next 14 days (label = project name, date); `sent`-status invoices AND pay apps with `balanceCents > 0` (label = `Invoice #N — <project>`, ageDays from the document date). For pay-app rows read how `listProjectPayments`/aia summaries expose pay-app totals (`server/aiaStore.ts` / `billingStore.ts:152-168`) — if pay-app balance requires aiaStore internals, scope the ledger to invoices + pay apps ONLY IF aiaStore exposes totals cheaply; otherwise ship invoices-only ledger and SAY SO in your report (the reviewer decides). Contractor sync: in the customer-update route handler (find it in routes.ts), after a successful name change run `db.prepare('UPDATE projects SET contractor = ? WHERE customerId = ?').run(newName, id)` — add a test asserting a rename propagates.

Routes: mirror auth/gating of neighboring customer routes; admin detection identical to `/api/projects/summary`'s `includeBilling` logic.

- [ ] **Step 4: GREEN + full suites**, **Step 5: Commit** — `feat(customers): rollup endpoints (summary + overview), summary outstandingCents, contractor rename sync`

---

### Task 3: Client lifecycle UI — three-tab Projects page, stage control, dashboard

**Files:**
- Modify: `src/pages/ProjectsPage.tsx` (STAGE_ORDER/GROUP_DEFS/tab logic — a substantial rewrite of the grouping layer; sort, search, customer filter, Recently-opened, ?stage= persistence all stay)
- Modify: `src/components/ProjectStageControl.tsx` (STAGE_OPTIONS → 2)
- Modify: `src/components/ui/StatusPill.tsx` + its test (PROJECT_STATUS_META for `bidding`/`in_progress`; keep legacy keys mapped or delete per how the pill resolves unknown statuses — read it first; add a `Lost` badge variant)
- Modify: `src/pages/Dashboard.tsx` (GROUP_DEFS consumption)
- Modify: `src/pages/project/ProjectSettings.tsx` (archive area gains "Mark as lost bid" when status is bidding — sets `lostBid: true` + `archived: true` via patchProject; read the existing archive control there first)
- Modify: `src/types.ts` if Project type carries status literals (check)

**Interfaces:**
- Consumes: server statuses `bidding | in_progress`, patch field `lostBid` (Task 1); summary field `outstandingCents` (Task 2, admin-only — render conditionally on its presence).
- Produces: Projects page tabs `data-testid="stage-tab-bidding" | "stage-tab-in_progress" | "stage-tab-archive"`; row testid stays whatever it is today (read the file; keep existing testids stable for e2e).

- [ ] **Step 1:** Read ProjectsPage fully. Replace `STAGE_ORDER` with the two live stages; replace the archived Active/Archived toggle with the third tab (`archive`). `GROUP_DEFS` becomes `[{ id: 'bidding', statuses: ['bidding'] }, { id: 'active', statuses: ['in_progress'] }]` (Dashboard: bid deadlines from bidding+bidDueDate, active list from in_progress; archived projects excluded from both as today). Unknown statuses fold into bidding. `?stage=` accepts the three tab ids. Per-tab default sort: bidding → `bidDue`, in_progress → `updated`, archive → `updated`; an explicit user sort choice still overrides + persists as today. Rows gain: customer name (already resolvable via the page's customerMap), bid-due pill on bidding tab, `outstandingCents` (formatted $, only when present) on in_progress tab, `Lost` badge on archive tab when `lostBid`.
- [ ] **Step 2:** ProjectStageControl: `STAGE_OPTIONS = ['bidding', 'in_progress']`. StatusPill: add meta for the two new ids (labels "Bidding" / "In Progress"); handle legacy ids gracefully (map through the same collapse semantics client-side so a stale summary can't crash the pill); update its test accordingly (and un-break it if Task 1 left it red).
- [ ] **Step 3:** ProjectSettings: in the archive section, when the project is `bidding` and not archived, add a "Mark as lost bid" action → `patchProject(id, { version, archived: true, lostBid: true })` with a confirm; label the existing archive action unchanged.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit` green/clean. Do NOT run Playwright (Task 6 owns it) — but note in your report any e2e specs that reference old stage tabs (grep `e2e/` for `stage` and old status ids) so Task 6 knows.
- [ ] **Step 5: Commit** — `feat(lifecycle): three-tab Projects board, two-stage controls, lost-bid marker`

---

### Task 4: Customers split view — shell, sidebar, Projects + Settings tabs

**Files:**
- Create: `src/pages/customers/CustomersSplitView.tsx` (route component: sidebar + pane shell + tab host)
- Create: `src/pages/customers/CustomerPane.tsx` (header + tabs; Projects + Settings tabs implemented here or in small sibling files — one file per tab if any tab exceeds ~150 LOC)
- Modify: `src/App.tsx` (routes `/customers` + `/customers/:id` → split view; keep both paths working)
- Modify: `src/pages/NewProject.tsx` (accept `?customerId=` and preselect the dropdown)
- Delete: `src/pages/CustomersPage.tsx`, `src/pages/CustomerDetail.tsx` — but FIRST extract their reused pieces (`CustomerForm`, `CreateCustomerModal`, merge modal) into `src/pages/customers/` modules and update imports. Nothing else may import the deleted files afterward (`grep` to confirm).

**Interfaces:**
- Consumes: `GET /api/customers/summary` (Task 2) for the sidebar; existing customer CRUD store functions (`src/utils/store.ts` — read the customer section); project summaries for the Projects tab (reuse the page-level summaries fetch or the overview endpoint — prefer `customerOverview` since Task 5 needs it anyway; fetch once in the pane, share via context/props).
- Produces: route behavior: `/customers` (no selection → empty-state pane on desktop, list-only on phone), `/customers/:id` (selected), `?tab=overview|projects|tasks|billing|settings` persistence (default overview). Testids: `customer-sidebar-row`, `customer-tab-<name>`, `customer-pane`. Phone: `<md` breakpoint shows list OR pane with a back button (match how ProjectBilling's tab host + the app's responsive idioms work — read `src/pages/project/ProjectBilling.tsx` for the tab-host pattern and reuse its style).
- Tab CONTENT in this task: **Projects** (grouped Bidding / In progress rows + collapsed Archived group, linking to `/project/:id/takeoff`; reuse StatusPill + the row style from ProjectsPage) and **Settings** (the relocated CustomerForm + role emails + notes + Merge + Delete, feature-identical to old CustomerDetail incl. `customer-unassigned` guards). **Overview / Tasks / Billing tabs render placeholder cards** ("coming in the next task" — literally a `<Card>` with a muted line; Task 5 replaces them).
- Header: name, contact/phone, `[+ Project]` → `/new?customerId=<id>`; admin outstanding figure comes in Task 5 (leave a slot).

- [ ] **Step 1:** Build it (read ProjectBilling.tsx tab host + Sidebar.tsx patterns first; keep files focused). **Step 2:** `npx vitest run && npx tsc --noEmit`; grep confirms no imports of deleted files; note e2e specs referencing old customers pages for Task 6. **Step 3: Commit** — `feat(customers): split-view customers section (shell, projects + settings tabs)`

---

### Task 5: Customer pane data tabs — Overview, Tasks, Billing

**Files:**
- Create: `src/pages/customers/CustomerOverviewTab.tsx`, `CustomerBillingTab.tsx`
- Modify: `src/pages/customers/CustomerPane.tsx` (swap placeholders; wire `customerOverview` data + header outstanding figure)
- Modify: `src/pages/TasksPage.tsx` ONLY IF list extraction is needed for the Tasks tab (prefer extracting its list+filter body into `src/components/tasks/TaskListPanel.tsx` consumed by both the page and the tab; if TasksPage is already cleanly embeddable via a prop, use that — read it first and pick the smaller change)

**Interfaces:**
- Consumes: `GET /api/customers/:id/overview` (Task 2 — shapes in Task 2's Produces block), Task 4's pane/tab shell.
- Produces: **Overview tab** — 4 stat tiles (Bidding, In progress, Outstanding $ admin-only, Open tasks w/ overdue count) + "Needs attention" list per the spec (each row links: task → `/tasks?customerId=`, bid → the project, invoice → `/project/:id/billing`); empty state "Nothing needs attention". **Tasks tab** — embedded task list filtered by customerId (full functionality of the global page's list: status pills, assignee, due dates). **Billing tab** — admin-only (hidden entirely for non-admins, as is the Billing entry in the tab bar): rollup line (contract total / invoiced / paid / outstanding) + ledger table (project, kind, number, date, status, total, paid, balance) sorted newest-first; renders whatever the endpoint provides (invoices-only if Task 2 scoped pay apps out — check Task 2's report/ledger shape).
- Money formatting: match existing billing UI helpers (grep `formatCents` / money util in the billing components; reuse, don't reinvent).

- [ ] **Step 1:** Implement; **Step 2:** `npx vitest run && npx tsc --noEmit`; **Step 3: Commit** — `feat(customers): overview/tasks/billing tabs with needs-attention rollups`

---

### Task 6: E2E + full verification

**Files:**
- Modify/Create: `e2e/customers.spec.ts` (new), `e2e/projects-board.spec.ts` (new or extend existing board spec — grep e2e/ for existing projects-page coverage first), fix any existing specs broken by the stage collapse (Tasks 3/4 reports list candidates; also grep e2e/ for old status ids/customer-page selectors)
- Consult: `e2e/fixtures/seed.ts` — extend with a `seedCustomerWithPortfolio(request, token)` helper (customer + bidding project w/ bidDueDate + in_progress project w/ sent unpaid invoice + overdue task) if no equivalent exists.

**Interfaces:** consumes everything above; testids from Tasks 3/4.

- [ ] **Step 1:** Projects board spec: seed projects in both stages + one archived-lost; assert three tabs with counts, per-tab content, Lost badge in archive, `?stage=` deep link.
- [ ] **Step 2:** Customers spec: seed portfolio; `/customers` → click sidebar row → Overview tiles show counts; Needs-attention lists the overdue task + outstanding invoice (admin session); Tasks tab shows the task; Billing tab shows the ledger row + rollup; Settings tab edits + saves a field; non-admin session (seed.ts has user helpers — check; if only admin auth exists, add a non-admin fixture) sees no Billing tab and no $ tiles.
- [ ] **Step 3:** Migration smoke: a vitest already covers mapping (Task 1); additionally run the server against a COPY of `data/app.db` (stale June snapshot — fine for a rehearsal): `cp data/app.db /tmp/mig-rehearsal.db` + point a scratch STORAGE_PATH at a copied dir, boot `tsx server.ts`, confirm it migrates cleanly and `/api/projects/summary` returns only two-stage statuses. Report the before/after status counts. DO NOT touch `data/` itself.
- [ ] **Step 4:** Full verification: `npx vitest run`, `npx tsc --noEmit`, `npx playwright test` (whole suite incl. your new specs; expect prior 31 + new ones green; the gated 60MB spec runs if the fixture exists).
- [ ] **Step 5: Commit** — `test(e2e): customers split view + three-tab board coverage; migration rehearsal notes`

---

## Execution notes

- Waves: T1 → (T2 ∥ T3) → T4 → T5 → T6 → final whole-branch review → one fix wave → push to `testing`.
- T2 and T3 are disjoint (server-only vs client-only) EXCEPT both may touch nothing shared; T2 owns `server/projectStore.ts` in wave 2 — T3 must not edit server files, and T1 must not edit client files (except the narrowly-flagged StatusPill escape hatch).
- The REAL data migration (Unraid) happens outside this plan, supervised by Nathan — the push itself must be flagged to him since the container pull auto-runs migrations.
