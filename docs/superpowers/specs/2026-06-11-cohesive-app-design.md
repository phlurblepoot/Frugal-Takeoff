# Frugal Takeoff — Cohesive Application Redesign

**Date:** 2026-06-11
**Status:** Approved design, pending implementation planning

## 1. Problem & Goals

Frugal Takeoff currently behaves like five loosely-related apps behind one login: Estimating (projects/takeoffs/canvas), PDF Editor, Spreadsheet Editor, Checklists, and Time Keeping. They share a backend, auth, and database, but not navigation, data linkage, or visual identity. This makes daily use feel disjointed and blocks growth into post-award project management (invoicing, planning, documents).

**Goals:**

1. One cohesive, project-centric application: a project is the container from day one, moving through a lifecycle from estimating to closeout.
2. Keep everything that currently works — especially the takeoff canvas, measurement math, plan-set revisions, proposal generation, and collaboration.
3. Fix the structural data risks (data-loss-by-overwrite bug, base64 blobs in SQLite, whole-project JSON saves).
4. A professional, consistent design language with first-class light and dark themes.
5. Lay the data groundwork for AIA G702/G703 progress billing with change orders (future work, not built now — but nothing may preclude it).

**Non-goals (now):** AIA G702/G703 implementation; outside-party logins; email *receiving* (IMAP) of any kind; external integrations (QuickBooks, Stripe).

## 2. Key Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Organizing concept | Project-centric. All facets (documents, checklists, time, billing, issues, notes) available at **every** lifecycle stage; stage changes emphasis, not access. |
| Lifecycle | `estimating → proposal_sent → awarded → in_progress → punch_list → complete → archived`, with `lost` as an exit after proposal. |
| Bid inbox / email receiving | **Removed entirely** (bids table, email_accounts, IMAP poller). Email remains for **sending only** (proposals, issues, invoices). |
| Standalone editors | PDF & spreadsheet editors become components that open project documents in context; a global **Tools** section remains for one-off files. |
| Users | Internal only: `admin` (management — everything) and `member` (field — no pricing/billing/company settings). No outside-party logins; outsiders receive emails/share links. |
| Billing v1 | Invoices (line items, status draft/sent/paid, partial payments), change orders as first-class records feeding contract value. PDF + email via SMTP. No tax/retainage/AIA math yet. |
| Navigation shell | Contextual sidebar swap (Linear/Notion pattern): company-level sidebar; opening a project replaces it with that project's sections; "← All Projects" returns. |
| Design language | Hybrid: clean modern-SaaS structure (light surfaces, 1px borders, restrained type, soft status pills) + glow/gradient accents reserved for primary buttons, active nav, progress bars. Light and dark themes both first-class. Data surfaces (tables/forms) stay flat. |
| Storage | SQLite for structured data; file content on disk; metadata-only `files` table; versioned auto-migrations. |
| Rebuild strategy | Aggressive phased restructure on the testing branch; old version stays live untouched; one-time data import at cutover. |
| New facets | Issue reports (deficiencies/observations during In Progress) and area-based punch tracking (Punch List stage). |

## 3. Data Model & Storage

### 3.1 Principles

- **Normalize the hot data.** The single `projects.data` JSON blob is replaced by real tables. Saving a measurement writes one row, not the whole project.
- **Files on disk, metadata in DB.** The base64 `images` table is replaced by `data/files/<shard>/<uuid>` on disk plus a `files` metadata table. Files are streamed with HTTP range support and auth checks.
- **SQLite stays.** It comfortably handles this scale for structured data once blobs are out.

### 3.2 Tables

**Company-wide:** `users` (role: admin|member), `templates`, `settings`, `user_preferences`, `shares`, `schema_version` (migrations), `activity` (event log: who/what/when/projectId — powers feeds).

**Project core:**

- `projects` — id, name, status (lifecycle enum), contractor, address, bidDueDate, contractValue, version, createdAt, updatedAt
- `plan_sets` — id, projectId, name, revision metadata
- `pages` — id, projectId, planSetId, name, pageNumber, sourceFileId, sourcePdfPageNum, scaleConfig (JSON), legend fields, version
- `takeoffs` — id, projectId, name, type (scale|length|area|count), color, unit, cost configuration
- `measurements` — id, pageId, takeoffId, type, points (JSON — geometry stays JSON *within* the row), color, name, attrs, regionId, planSetId

**Files:** `files` — id, projectId (nullable for Tools one-offs), name, mime, size, sha256, kind (plan|document|photo|proposal|printout|spreadsheet|other), parentFileId + versionNumber (document versioning: saves create a new row pointing at the original), createdAt. Content at `data/files/`.

**Billing (AIA-ready):**

- `invoices` — id, projectId, number, date, status (draft|sent|paid), terms
- `invoice_lines` — id, invoiceId, description, qty, unitPrice, sort
- `payments` — id, invoiceId, date, amount, method, note
- `change_orders` — id, projectId, number, description, amount, status (pending|approved|rejected), createdAt

Future AIA work adds `schedule_of_values` and `pay_applications` tables that reference these same rows; takeoff/cost data must remain able to seed a schedule of values. Nothing in v1 may collapse line-item identity (e.g., totals-only invoices) in a way that blocks this.

**Field:**

- `checklists` / `checklist_items` — items gain an `area` field for area-based punch tracking; photos are `files` rows
- `issues` — id, projectId, number (per-project sequence), title, description, status (open|sent|resolved), createdAt; photos as `files`; sent reports logged with timestamp
- `time_entries` — unchanged shape (userId, projectId?, clockIn/Out, description)
- `notes` — existing per-project rich-note model unchanged

**Removed:** `bids`, `email_accounts`, IMAP poller, base64 `images` table.

### 3.3 Save safety (fixes the observed data-loss bug)

The current `PUT /api/projects/:id` overwrites the whole project with whatever the client sends and **deletes files not referenced by the payload** (`server.ts:469-513`). A stale/partial save therefore destroys data permanently. The new rules:

1. **Granular writes** — row-level endpoints; no whole-project overwrites in normal operation.
2. **Optimistic concurrency** — writes carry a `version`; stale writes get HTTP 409 + a "project changed, reload" UX, never silent clobber.
3. **Server-side validation** — structurally invalid payloads rejected with specific errors.
4. **No destructive side-effects** — file deletion only via explicit user/admin action (storage tab orphan cleanup stays as an explicit admin tool).
5. **No blind write-retries** — the client's auto-retry for non-idempotent writes is removed; writes are idempotent (keyed) or surfaced to the user on failure.

## 4. Navigation & Screens

### 4.1 Company level (persistent sidebar)

- **Dashboard** `/dashboard` — upcoming bid deadlines, active-project health, recent activity, my hours this week
- **Projects** `/projects` — pipeline-grouped cards (Estimating / Active / Complete groups; stage pills; stage-relevant card stats), filter/search, archive, templates, New Project wizard
- **Tools** `/tools/pdf`, `/tools/sheets` — PDF and spreadsheet editors for one-off files; drafts persist server-side
- **Time** `/time` — clock in/out (optional project), my entries, calendar; admin sees all users + exports
- **Settings** `/settings` (admin) — company/branding, users, SMTP sending, appearance, storage admin

### 4.2 Project level `/p/:id/…` (sidebar swaps to project context)

Overview · Takeoff & Estimate · Proposal · Documents · Punch & Checklists · Issues · Time · Billing (admin) · Notes · Project Settings (admin)

- **Overview** — stage-aware home: contract value, hours, open issues, punch progress, activity, next actions (e.g., "clock in to this project")
- **Takeoff & Estimate** — sheet grid (plan sets, revisions) → per-sheet canvas; takeoff items & cost table; templates
- **Proposal** — generate/preview/send; history of sent versions
- **Documents** — all project files by kind; click opens the right editor in context
- **Punch & Checklists** — area-grouped punch items with per-area progress; before/during/after photos; printable report
- **Issues** — numbered reports (ISS-001…) with photos; open → sent → resolved; "send" emails a PDF to the contractor and logs it
- **Time** — project hours by person/week; estimate vs. actual
- **Billing** — invoices, payments, change orders; contract rollup (base + approved COs)
- **Notes** — existing rich notes as a section; still available as canvas overlay

### 4.3 Cross-cutting

- ⌘K command palette everywhere: navigation + actions ("clock in", "new issue")
- Stage changes emphasis, never access
- Roles: members never see pricing (estimate costs, billing) or company settings
- Canvas is full-bleed: opening a sheet collapses the sidebar to a thin rail
- Time, Punch, Issues are mobile-first (field use, camera capture); estimating is desktop-optimized
- The standalone Checklists tab is removed — checklists always belong to a project

## 5. Design Language

Hybrid of modern-SaaS structure and glow accents ("the rules of the hybrid"):

1. **Structure:** consistent spacing scale, subtle 1px borders, restrained type scale (Inter, falling back to system UI fonts), soft color-tinted status pills, generous whitespace
2. **Glow:** gradients + soft shadows on primary buttons, active nav items, and progress bars **only**
3. **Theming:** every token (surface, border, text, accent) defined per-theme; light and dark are both first-class
4. **Data stays flat:** tables, takeoff lists, and forms never get glass or glow — readability first

Implemented as a design-token layer (CSS variables on top of Tailwind 4) plus a small component library: Button, Card, StatusPill, Table, Modal, Form controls, EmptyState, Skeleton. All screens consume the library; no ad-hoc styling of these primitives.

## 6. Feature Integration Details

- **PDF editor** — component, not destination. Opens any PDF `files` row in project context. Annotations autosave as server-side drafts (crash/refresh safe); "Save" creates a new **version** of the document (history kept). Same component powers `/tools/pdf`.
- **Spreadsheet editor** — same model; server drafts replace IndexedDB-only cache; save-as-version. Powers `/tools/sheets`.
- **Outbound email** — one module used by proposals, issues, invoices: compose → PDF attachment → SMTP → logged to `activity` (what/to whom/when).
- **Collaboration** — Socket.io stays: presence + cursors per sheet; sync events align to granular model (a measurement change broadcasts that row, not the project).
- **Search** — existing full-text search extends across documents, issues, invoices.

## 7. Error Handling

- One consistent API error envelope; UI shows failures as toasts with retry; no silent failures, no native dialogs
- 409 version conflicts → "changed since you loaded it" reload prompt
- Server validates all writes; rejections carry specifics
- Backup story: admin button + documented command snapshotting `data/` (DB + files together)

## 8. Testing

- **Unit (Vitest):** measurement math, scale conversion, cost calculation, plan-set revision logic — written *before* refactoring to lock in current behavior
- **API integration:** every new endpoint, especially conflict/validation paths
- **Migration:** mechanical verification (row counts, file hashes, spot checks) + observed run on testing-branch data
- **Manual:** short smoke checklist per phase for canvas/takeoff workflows (weakest automated coverage)

## 9. Build Phases

Work happens on the `testing` branch. The live production instance stays untouched until final cutover. Each phase ends with the app running.

1. **Data foundation** — new schema + migrations framework; files to disk; rewritten API layer with save-safety; thin aggregation layer keeps existing UI working against the new API; write auto-retry removed
2. **Shell & design system** — tokens, component library, contextual-sidebar shell, light/dark; existing pages mounted in the shell
3. **Project unification** — project sections (Overview, Documents, editors-as-components, Notes, Time), lifecycle + pipeline dashboard, bid/IMAP removal, ⌘K actions
4. **New modules** — Billing (invoices/payments/change orders), Issues, punch areas
5. **Refactor & polish** — split ProjectView (5,619 LOC) / CanvasView (3,380 LOC) monoliths, dedupe shared components (e.g., CustomCostRow), accessibility + print-quality pass
6. **Migration & cutover** — one-time importer (old DB → disk files + normalized tables) with verification and original-DB backup. **Tested first on the testing-branch data with Nathan observing**, then production cutover.

Each phase gets its own implementation plan; this spec is the umbrella. Phase 1 is planned first.

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Silent regressions in takeoff/canvas math during normalization | Unit tests locked in before refactor; per-phase manual smoke checklist |
| Migration misses edge-case data in old JSON blobs | Mechanical verification + observed test run on real testing data before production |
| Design system churn (restyling twice) | Structure-before-cosmetics ordering; tokens/components land before screens are rebuilt |
| Scope creep (AIA, integrations) | Explicit non-goals; AIA constrained to "data model must not preclude" |
