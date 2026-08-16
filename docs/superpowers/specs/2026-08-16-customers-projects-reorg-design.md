# Customers & Projects Reorganization — Design

Date: 2026-08-16
Status: Approved by Nathan (conversation, with visual mockup selection: split-view C2 for customers, three-tab P2 for projects)

## Problem

- The Customers page is a bare card list; clicking a customer lands on an edit
  form (CustomerDetail) with only bare project links. No billing, tasks, or
  status context ever reaches the customer level.
- The Projects page splits work across 7 stage tabs — too fragmented. Nathan
  wants exactly two live stages (Bidding, In Progress) with finished work
  behind the existing archive function.
- Customers and projects share data (billing, tasks) but feel disjoint: a
  project's due invoices and tasks are invisible from its customer.

## Decisions (agreed with Nathan)

- Lifecycle collapses to **two stored stages**: `bidding`, `in_progress`.
  Archived stays the existing independent boolean — any project (even a
  never-won bid) can archive. Migration auto-archives finished work.
- Customer area becomes a **split view** (persistent customer list left,
  tabbed detail pane right) — mockup option C2.
- Projects page becomes **three tabs**: Bidding / In progress / Archive —
  mockup option P2.
- Billing figures remain **admin-only** everywhere (same gate as today);
  non-admins see the customer pane minus money.
- The customer pane includes a **Settings** tab carrying today's full edit
  form (Nathan explicitly asked for the settings tab).

## 1. Lifecycle simplification

**Data:** `PROJECT_STATUSES = ['bidding', 'in_progress']`. New optional
project flag `lostBid?: boolean` (set when archiving from bidding via a
"Mark lost" affordance; used only for the Archive view's Lost badge).

**Migration (data-transforming — SUPERVISED; Nathan watches, backup first,
per standing protocol):**

| old status | new status | archived | lostBid |
|---|---|---|---|
| estimating, proposal_sent (+ unknown/legacy) | bidding | unchanged | — |
| awarded, in_progress, punch_list | in_progress | unchanged | — |
| complete | in_progress | **true** | — |
| lost | bidding | **true** | true |

**UI:** `ProjectStageControl` becomes a two-option Bidding ⇄ In Progress
control. `deriveStatus()` on legacy saves maps into the two-stage model.
Dashboard `GROUP_DEFS` semantics: bid deadlines ← `bidding` with a
`bidDueDate`; active projects ← `in_progress`; closed ← archived.

## 2. Projects page (P2 — three tabs)

- Tabs **Bidding (n) / In progress (n) / Archive** replace the 7-tab bar AND
  the separate Active/Archived toggle. `?stage=` param persists.
- Full-width rows: project name, customer name, last-updated; plus bid due
  date pill on Bidding, outstanding balance (admin-only) on In progress.
  Requires extending `listProjectSummaries(includeBilling)` with an
  `outstandingCents` field (it already joins billing data for contract
  value/invoice count; add the invoice+payapp balance sum).
- Per-tab default sort: Bidding → bid-due-date, In progress → updated;
  user's explicit sort choice still persists (localStorage + user prefs) per
  tab. Search, customer filter dropdown, and Recently-opened row stay.
- Archive tab: searchable, shows a **Lost** badge on `lostBid` projects,
  offers Unarchive (existing capability).

## 3. Customers split view (C2)

Route `/customers` renders the split view; `/customers/:id` selects that
customer in it (deep-linkable; old links keep working). Phone: list is
full-screen; tapping opens the pane full-screen with a back affordance.

**Left sidebar:** search box, New Customer button, one row per customer
(name, contact name, project count). Sorted by name. The special
`customer-unassigned` bucket appears last, styled muted.

**Right pane header:** customer name, phone/contact shortcuts, admin-only
outstanding-balance figure, [+ Project] (opens NewProject pre-linked to this
customer).

**Tabs:**
- **Overview** — stat tiles: Bidding count, In-progress count, Outstanding $
  (admin-only), Open tasks (with overdue count). Then **Needs attention**:
  overdue tasks (dueDate < today, status ≠ done), bids due within 14 days,
  and sent invoices/pay apps with outstanding balance, aged by document date
  ("outstanding 14d" — invoices have no due-date field, so we age rather
  than claim overdue). Each item links to its project section.
- **Projects** — grouped Bidding / In progress lists (same row style as the
  Projects page) + collapsed Archived group.
- **Tasks** — the existing TasksPage list component embedded, filtered by
  customerId (covers project tasks too: a project task always carries its
  project's customer server-side).
- **Billing** (admin-only tab, hidden for non-admins) — cross-project
  ledger: every invoice and AIA pay app across the customer's projects
  (project, number, date, status, total, paid, balance), plus rollup line:
  contract total, invoiced, paid, outstanding.
- **Settings** — today's CustomerDetail form relocated unchanged: contact
  fields, role emails, notes, Merge, Delete (still blocked while projects
  exist; disabled for `customer-unassigned`).

CustomersPage + CustomerDetail are replaced by the split view (old files
retired); shared form/merge components are reused.

## 4. Server work

No schema changes beyond §1 (status collapse + `lostBid` in project attrs).

- `GET /api/customers/summary` — per-customer rollup for the sidebar/list:
  `{ id, name, contactName, projectCounts: { bidding, inProgress, archived },
  openTaskCount, overdueTaskCount, outstandingCents? }`. `outstandingCents`
  only when admin (same gate as `includeBilling` on project summaries).
- `GET /api/customers/:id/overview` — everything Overview + Billing tabs
  need: per-project billing summaries (reusing `billingSummary()` per
  project, admin-gated), open invoice/pay-app rows with balances, task
  attention items, bid-due items. Non-admin gets the money fields stripped.
- **`contractor` becomes derived:** setting/changing a project's customer
  writes the customer's name to `contractor` (as today), AND renaming a
  customer updates `contractor` on all its linked projects. The manual-sync
  wart dies; the field itself stays (documents/PDFs read it).

## 5. Testing

- Unit: stage mapping table (every old status → expected status/archived/
  lostBid), migration idempotency, customer rollup aggregation math
  (counts, outstanding sums, attention-item selection), contractor rename
  propagation.
- E2E: three-tab Projects board (tab counts, per-tab sort defaults, archive
  + Lost badge); customer split view (select customer → tabs render; overdue
  task and outstanding invoice appear in Needs attention; Settings tab edits
  save; non-admin sees no money and no Billing tab).
- Migration: rehearsed on a copy of testing data first, then run SUPERVISED
  with Nathan watching (backup retained).

## Out of scope

- Kanban drag between stages (P1 was not chosen).
- Smart sidebar badges/attention sorting from mockup C3 (possible later).
- Invoice due dates / true "overdue invoice" semantics (no due-date field).
- Customer-level documents, notes, or email history views.
