# Phase 3a: Cleanup, Lifecycle & Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the bid inbox / IMAP receiving entirely, make the project lifecycle real (stage control + granular writes + activity log), and replace the projects list + home screen with the spec's pipeline-grouped Projects page and Dashboard — with company routes aligned to the spec (`/dashboard`, `/projects`, `/tools/*`).

**Architecture:** Pure subtraction first: migration 6 drops `bids`/`email_accounts`, the IMAP poller and all bid routes/UI go away (SMTP *sending* stays). Then three small server additions on the Phase 1 data layer: `GET /api/projects/summary` (slim rows — the "dashboard slimming" Phase 1 deferred), `PATCH /api/projects/:id` (granular, version-checked field updates incl. lifecycle `status`), and an `activity` log (table exists since Phase 1; now it gets writes + `GET /api/activity`). The client gets two new pages built on the Phase 2 ui library — `ProjectsPage` (pipeline-grouped cards, replaces `ProjectsList` wholesale) and `Dashboard` — plus a stage dropdown in ProjectView's header and route/nav alignment.

**Tech Stack:** Express 4 + better-sqlite3 (JSON1 via `json_extract`), Vitest (server: node project; ui: jsdom project), Supertest, React 19 + react-router 7, Phase 2 ui library (`src/components/ui`), Tailwind 4 tokens.

**Spec:** `docs/superpowers/specs/2026-06-11-cohesive-app-design.md` (§2 decisions: bid inbox removed, lifecycle; §4.1 Dashboard + Projects; §9 Phase 3). This is sub-plan **3a** of Phase 3; sub-plan 3b (project sections, Documents, editors-as-components) follows after 3a ships.

**Branch:** all work on `testing` (per project CLAUDE.md — push directly to `testing`, no PRs).

---

## Context You Must Know Before Starting

1. **Phase 1 data layer:** `server/routes.ts` exposes `registerDataRoutes(app, deps)`; `server/projectStore.ts` has `loadProject/saveProject/createProject/deleteProject/listProjects` + `ValidationError`/`ConflictError` and optimistic concurrency (`projects.version`, HTTP 409 on stale writes). `server/migrationList.ts` holds migrations 1–5; the framework auto-backs-up the DB file before applying pending migrations.
2. **Express route-order pitfall:** `GET /api/projects/:id` is registered in `registerDataRoutes`. Any new literal route under `/api/projects/...` (e.g. `/api/projects/summary`) MUST be registered **before** the `:id` route or Express matches `summary` as an id.
3. **`req.user`:** `authenticateToken` puts the decoded JWT on `req.user` (`{ id, username, role }`). The routes test stubs it as `{ id: 'u1', role: 'admin' }`.
4. **`archived` is a flag, not a stage.** `project.archived` (boolean) lives inside the `projects.meta` JSON (legacy shape, spread by `loadProject`). The lifecycle `status` column is separate. This plan keeps them independent: the stage dropdown offers the 7 working stages (incl. `lost`, excl. `archived`); archiving stays its own explicit action. Read `archived` in SQL via `json_extract(meta, '$.archived')` (better-sqlite3 bundles SQLite with JSON1).
5. **`deriveStatus` edge:** whole-project saves run `deriveStatus(meta, payload.status)` (`server/projectStore.ts:119`) which keeps any non-`'estimating'` status. Consequence: a project moved *back* to `estimating` whose meta still has `submitted: true` will re-derive `proposal_sent` on its next full save. Known, accepted for 3a.
6. **Writes are never auto-retried** client-side (`fetchWithRetry` in `src/utils/store.ts` zeroes retries for non-GET). New write helpers must follow the same pattern: no retry, 409 → `ConflictError`.
7. **`bidDueDate` is a PROJECT field and STAYS everywhere.** When grep-sweeping for bid removal, never touch `bidDueDate`. The `BidEmail` type and `Project.email`/`Project.emails` fields also STAY (existing projects carry email threads; `POST /api/projects/:id/send-proposal` keeps using them). Only `Bid`, `BidStatus`, `EmailAccount`, the `bids`/`email_accounts` tables, IMAP, and bid UI go.
8. **SMTP sending stays.** `buildTransporter()`, `GET/POST /api/email/smtp`, `POST /api/email/test-smtp`, and `POST /api/projects/:id/send-proposal` in `server.ts` are kept. Only email *receiving* is removed.
9. **ui library (Phase 2):** import from `../components/ui` — `Button, Card, CardHeader, CardBody, StatusPill, ProjectStatusPill, PROJECT_STATUS_META, Field, Input, Select, Textarea, Checkbox, Modal, Table..., EmptyState, ProgressBar, Skeleton`. Toast API: `const { toast } = useToast(); toast(msg, { type: 'error' })`.
10. **Tests:** server tests live in `server/*.test.ts` (node project), ui tests in `src/**/*.test.tsx` (jsdom project, `globals: true`). Run all: `npm test`. Lint: `npm run lint` (tsc over the whole repo). Dev server: `STORAGE_PATH=$(mktemp -d) npm run dev`.
11. **🛑 Migration 6 drops real data.** On Nathan's testing instance the next boot after pulling will DROP `bids` and `email_accounts` (the framework backs the DB up first). Per his standing protocol he gets told before migrations run against real data — the final task includes that notice. Tests always use temp dirs.
12. **Line numbers below are approximate** — locate code by content/anchors, not line numbers. If an anchor can't be found, report NEEDS_CONTEXT.

## File Structure

```
server/migrationList.ts        # + migration 6 'remove-bid-inbox'
server/projectStore.ts         # + NotFoundError, PROJECT_STATUSES, patchProject(), listProjectSummaries()
server/activity.ts             # NEW: logActivity(), listActivity()
server/activity.test.ts        # NEW
server/routes.ts               # - bid search/storage refs; + summary, PATCH, activity routes + logging
server/routes.test.ts          # + describe blocks for new endpoints
server/migrationList.test.ts   # + migration 6 tests
server.ts                      # - bid CRUD, email_accounts, IMAP poller, bid proposal route; + proposal_sent activity
src/utils/store.ts             # - bid/IMAP fns; + ProjectSummary/ActivityItem/ProjectPatch/TimeEntryLite,
                               #   getProjectsSummary, patchProject, getActivity, getMyTimeEntries, clockIn, clockOut
src/types.ts                   # - Bid, BidStatus, EmailAccount (BidEmail + Project.email(s) STAY)
src/pages/ProjectsPage.tsx     # NEW: pipeline-grouped projects (replaces ProjectsList)
src/pages/ProjectsPage.test.tsx# NEW: groupSummaries() unit tests
src/pages/ProjectsList.tsx     # DELETED (bids tab, users tab, table view die with it)
src/pages/Dashboard.tsx        # NEW: deadlines / active / activity / my-hours
src/pages/Dashboard.test.tsx   # NEW: pure-helper tests
src/components/ProjectStageControl.tsx       # NEW: stage pill dropdown
src/components/ProjectStageControl.test.tsx  # NEW
src/pages/ProjectView.tsx      # + stage control in header; editor/nav path updates
src/pages/Settings.tsx         # - IMAP UI (ImapAccountForm, presets, accounts, polling); SMTP stays
src/pages/NewProject.tsx       # - fromBid conversion flow
src/components/CommandPalette.tsx  # - bid case; + clock in/out action; route updates
src/components/shell/Sidebar.tsx   # company nav: Dashboard + /projects + /tools/*
src/App.tsx                    # routes: /dashboard, /projects, /tools/pdf, /tools/sheets, redirects
package.json                   # - imapflow, mailparser, @types/mailparser
```

Lifecycle vocabulary used throughout (must stay consistent):

```ts
PROJECT_STATUSES = ['estimating', 'proposal_sent', 'awarded', 'in_progress',
                    'punch_list', 'complete', 'archived', 'lost']
```

Pipeline groups (ProjectsPage + Dashboard): **Estimating** = estimating, proposal_sent · **Active** = awarded, in_progress, punch_list · **Complete & Closed** = complete, lost · archived flag → Archived view only. Unknown status falls into Estimating.

---

### Task 1: Server — Remove Bid Inbox + IMAP, Migration 6

**Files:**
- Modify: `server/migrationList.ts` (append migration 6)
- Modify: `server/migrationList.test.ts` (append describe block)
- Modify: `server/routes.ts` (remove bid references)
- Modify: `server.ts` (remove bid CRUD, email accounts, poller)
- Modify: `package.json` (drop IMAP deps)

- [ ] **Step 1: Write the failing migration tests** (append to `server/migrationList.test.ts`)

```ts
describe('migration 6: remove-bid-inbox', () => {
  it('drops the bids and email_accounts tables', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    expect(tables).not.toContain('bids');
    expect(tables).not.toContain('email_accounts');
    db.close();
  });

  it('preserves bid attachment files rows', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 5));
    db.prepare(`INSERT INTO files (id, mime, size, sha256, kind, createdAt) VALUES ('att1','application/pdf',1,'x','document',1)`).run();
    runMigrations(db, dir, migrations);
    expect((db.prepare('SELECT COUNT(*) as c FROM files').get() as any).c).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/migrationList.test.ts`
Expected: FAIL — `bids` still present after running all migrations.

- [ ] **Step 3: Append migration 6 to the array in `server/migrationList.ts`**

```ts
  {
    version: 6,
    name: 'remove-bid-inbox',
    up({ db }) {
      // Bid inbox + IMAP receiving are removed in Phase 3 (spec §2). The
      // migration framework backs up the DB file before applying, so existing
      // bid data survives in backups/. Bid email attachments stay in files/
      // and become reclaimable via the explicit orphan-cleanup admin tool.
      db.exec('DROP TABLE IF EXISTS bids; DROP TABLE IF EXISTS email_accounts;');
    },
  },
```

- [ ] **Step 4: Remove bid references from `server/routes.ts`** (the routes tests run all migrations, so the search route would now crash querying a dropped table — this step and Step 3 must land together)

1. In `GET /api/search`: delete the whole `// bids stay JSON blobs until Phase 3 removes them` block (the `bidRows` loop pushing `type: 'bid'` results).
2. In `collectReferencedFileIds`: change the table list `['bids', 'checklists', 'notes']` to `['checklists', 'notes']`.
3. In `GET /api/storage/stats`: delete the `bids:` line from the `breakdown` object.

- [ ] **Step 5: Remove the bid/IMAP system from `server.ts`** (locate by anchor, delete whole blocks)

Delete entirely:
1. Bid CRUD routes: `app.get("/api/bids"...)`, `app.post("/api/bids"...)`, `app.put("/api/bids/:id"...)`, `app.delete("/api/bids/:id"...)` (~lines 296-342).
2. Email account routes: `app.get('/api/email/accounts'...)` through `app.post('/api/email/test-imap/:id'...)` (~584-645). **Keep** the SMTP routes (`/api/email/smtp`, `/api/email/test-smtp`) and `buildTransporter()`.
3. IMAP machinery: `normalizeSubject()`, `pollImapAccount()`, `app.post('/api/email/poll'...)`, `startImapPoller()` and its call site near server startup (~647-777, ~915-929, call ~1157).
4. Email-import + bid proposal routes: `app.post('/api/bids/import-email'...)` and `app.post('/api/bids/:id/send-proposal'...)` (~780-857). **Keep** `app.post('/api/projects/:id/send-proposal'...)`.
5. The now-unused imports: `ImapFlow` (imapflow) and `simpleParser` (mailparser). Leave nodemailer.

- [ ] **Step 6: Drop the dependencies**

```bash
npm uninstall imapflow mailparser @types/mailparser
```

- [ ] **Step 7: Verify**

Run: `npm test && npm run lint`
Expected: all suites green (migration 6 tests now pass), no type errors, no remaining references:

```bash
grep -rn "imapflow\|mailparser\|ImapFlow\|simpleParser\|api/bids\|email_accounts\|email/accounts\|test-imap\|email/poll" server.ts server/ && echo "FOUND LEFTOVERS" || echo "clean"
```

Expected: `clean`. Boot check: `STORAGE_PATH=$(mktemp -d) timeout 25 npm run dev 2>&1 | head -25` — migrations 1-6 apply, server starts. (Client bid UI now hits 404s — expected mid-phase; it's removed in Tasks 6-7.)

- [ ] **Step 8: Commit**

```bash
git add server.ts server/migrationList.ts server/migrationList.test.ts server/routes.ts package.json package-lock.json
git commit -m "feat: remove bid inbox and IMAP receiving (server + migration 6)"
```

---

### Task 2: Server — Projects Summary Endpoint

**Files:**
- Modify: `server/projectStore.ts` (append `listProjectSummaries`)
- Modify: `server/routes.ts` (add route — ORDER MATTERS)
- Test: `server/routes.test.ts` (append describe block)

- [ ] **Step 1: Write the failing test** (append to `server/routes.test.ts`)

```ts
describe('GET /api/projects/summary', () => {
  it('returns slim rows with counts and pageIds, no page payloads', async () => {
    await request(app).post('/api/projects').send({
      ...PROJECT,
      pages: [
        { id: 'pg1', name: 'A1', imageId: '', measurements: [], scaleConfig: null },
        { id: 'pg2', name: 'A2', imageId: '', measurements: [], scaleConfig: null },
      ],
      takeoffs: [{ id: 't1', name: 'Drywall', color: '#fff', type: 'area' }],
    });
    const res = await request(app).get('/api/projects/summary');
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.id === 'p1');
    expect(row).toMatchObject({
      name: 'Test Project', status: 'estimating', version: 1, archived: false,
      pageCount: 2, takeoffCount: 1, contractor: 'GC Co',
    });
    expect(row.pageIds.sort()).toEqual(['pg1', 'pg2']);
    expect(row.pages).toBeUndefined(); // slim — no aggregates
  });

  it('reflects the archived meta flag', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'p2', archived: true });
    const res = await request(app).get('/api/projects/summary');
    expect(res.body.find((r: any) => r.id === 'p2').archived).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes.test.ts`
Expected: FAIL — 404 on `/api/projects/summary` (it matches the `:id` route and the project 'summary' doesn't exist).

- [ ] **Step 3: Implement `listProjectSummaries` in `server/projectStore.ts`** (append at the end of the file)

```ts
// Slim project rows for list/dashboard views — no page/measurement payloads.
// pageIds are included so the client can keep its "page is being edited"
// deletion guard without loading full aggregates.
export function listProjectSummaries(db: Database.Database): any[] {
  const rows = db.prepare(`
    SELECT id, name, status, contractor, address, bidDueDate, version, createdAt, updatedAt,
           COALESCE(json_extract(meta, '$.archived'), 0) AS archived
    FROM projects ORDER BY createdAt DESC
  `).all() as any[];

  const countBy = (table: string): Map<string, number> =>
    new Map(
      (db.prepare(`SELECT projectId, COUNT(*) AS c FROM ${table} GROUP BY projectId`).all() as any[])
        .map(r => [r.projectId, r.c])
    );
  const pageCounts = countBy('pages');
  const takeoffCounts = countBy('takeoffs');

  const pageIdsByProject = new Map<string, string[]>();
  for (const r of db.prepare('SELECT id, projectId FROM pages').all() as any[]) {
    if (!pageIdsByProject.has(r.projectId)) pageIdsByProject.set(r.projectId, []);
    pageIdsByProject.get(r.projectId)!.push(r.id);
  }

  return rows.map(r => ({
    id: r.id,
    name: r.name ?? 'Untitled',
    status: r.status ?? 'estimating',
    contractor: r.contractor ?? null,
    address: r.address ?? null,
    bidDueDate: r.bidDueDate ?? null,
    version: r.version ?? 1,
    createdAt: r.createdAt ?? 0,
    updatedAt: r.updatedAt ?? null,
    archived: !!r.archived,
    pageCount: pageCounts.get(r.id) ?? 0,
    takeoffCount: takeoffCounts.get(r.id) ?? 0,
    pageIds: pageIdsByProject.get(r.id) ?? [],
  }));
}
```

- [ ] **Step 4: Register the route in `server/routes.ts`**

Add `listProjectSummaries` to the existing `./projectStore` import. Then insert the route **between** `app.get('/api/projects', ...)` and `app.get('/api/projects/:id', ...)`:

```ts
  // NOTE: must be registered before '/api/projects/:id' or Express matches
  // 'summary' as a project id.
  app.get('/api/projects/summary', authenticateToken, (_req, res) => {
    try {
      res.json(listProjectSummaries(db));
    } catch (e) {
      console.error('Error fetching project summaries:', e);
      res.status(500).json({ error: 'Failed to fetch project summaries' });
    }
  });
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run server/routes.test.ts && npm run lint`
Expected: PASS (all routes tests incl. the 2 new ones), lint clean.

- [ ] **Step 6: Commit**

```bash
git add server/projectStore.ts server/routes.ts server/routes.test.ts
git commit -m "feat: slim projects summary endpoint for list and dashboard views"
```

---

### Task 3: Server — Granular PATCH with Lifecycle Status

**Files:**
- Modify: `server/projectStore.ts` (NotFoundError, PROJECT_STATUSES, patchProject)
- Modify: `server/routes.ts` (PATCH route)
- Test: `server/routes.test.ts` (append describe block)

- [ ] **Step 1: Write the failing tests** (append to `server/routes.test.ts`)

```ts
describe('PATCH /api/projects/:id', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT);
  });

  it('updates status and bumps version', async () => {
    const res = await request(app).patch('/api/projects/p1').send({ version: 1, status: 'awarded' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, version: 2, status: 'awarded' });
    const get = await request(app).get('/api/projects/p1');
    expect(get.body.status).toBe('awarded');
    expect(get.body.version).toBe(2);
  });

  it('updates name and archived flag', async () => {
    const res = await request(app).patch('/api/projects/p1')
      .send({ version: 1, name: 'Renamed', archived: true });
    expect(res.body.version).toBe(2);
    const get = await request(app).get('/api/projects/p1');
    expect(get.body.name).toBe('Renamed');
    expect(get.body.archived).toBe(true);
  });

  it('un-archiving removes the meta key entirely', async () => {
    await request(app).patch('/api/projects/p1').send({ version: 1, archived: true });
    await request(app).patch('/api/projects/p1').send({ version: 2, archived: false });
    const get = await request(app).get('/api/projects/p1');
    expect(get.body.archived).toBeUndefined(); // legacy shape omits the key
  });

  it('rejects stale versions with 409 and changes nothing', async () => {
    await request(app).patch('/api/projects/p1').send({ version: 1, name: 'First' });
    const stale = await request(app).patch('/api/projects/p1').send({ version: 1, name: 'Clobber' });
    expect(stale.status).toBe(409);
    expect((await request(app).get('/api/projects/p1')).body.name).toBe('First');
  });

  it('rejects invalid payloads with 400', async () => {
    expect((await request(app).patch('/api/projects/p1').send({ version: 1, status: 'galactic' })).status).toBe(400);
    expect((await request(app).patch('/api/projects/p1').send({ version: 1, nonsense: true })).status).toBe(400);
    expect((await request(app).patch('/api/projects/p1').send({ status: 'awarded' })).status).toBe(400); // no version
    expect((await request(app).patch('/api/projects/p1').send({ version: 1, name: '' })).status).toBe(400);
  });

  it('404s for unknown projects', async () => {
    expect((await request(app).patch('/api/projects/nope').send({ version: 1, name: 'X' })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes.test.ts`
Expected: FAIL — PATCH returns 404 (no route).

- [ ] **Step 3: Implement in `server/projectStore.ts`**

Below the existing `export class ConflictError extends Error {}` add:

```ts
export class NotFoundError extends Error {}

// Project lifecycle stages (spec §2). 'archived' is reachable via the
// archived flag rather than the stage dropdown, but remains a valid value.
export const PROJECT_STATUSES = [
  'estimating', 'proposal_sent', 'awarded', 'in_progress',
  'punch_list', 'complete', 'archived', 'lost',
] as const;
```

Append at the end of the file:

```ts
// Granular, version-checked field updates — the first of the spec §3.3
// "granular writes". Touches only columns + the meta.archived flag; never
// touches child tables or files.
export function patchProject(
  db: Database.Database,
  id: string,
  patch: any
): { version: number; status: string } {
  if (!patch || typeof patch !== 'object') throw new ValidationError('Payload must be an object');
  if (!Number.isInteger(patch.version) || patch.version < 1) {
    throw new ValidationError('Missing or invalid version — reload the project and try again');
  }
  const ALLOWED = ['version', 'name', 'status', 'archived', 'contractor', 'address', 'bidDueDate'];
  for (const k of Object.keys(patch)) {
    if (!ALLOWED.includes(k)) throw new ValidationError(`Unknown field: ${k}`);
  }
  if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim())) {
    throw new ValidationError('name must be a non-empty string');
  }
  if (patch.status !== undefined && !(PROJECT_STATUSES as readonly string[]).includes(patch.status)) {
    throw new ValidationError(`Invalid status: ${patch.status}`);
  }
  if (patch.archived !== undefined && typeof patch.archived !== 'boolean') {
    throw new ValidationError('archived must be a boolean');
  }
  for (const k of ['contractor', 'address'] as const) {
    if (patch[k] !== undefined && patch[k] !== null && typeof patch[k] !== 'string') {
      throw new ValidationError(`${k} must be a string or null`);
    }
  }
  if (patch.bidDueDate !== undefined && patch.bidDueDate !== null && typeof patch.bidDueDate !== 'number') {
    throw new ValidationError('bidDueDate must be a number or null');
  }

  let out = { version: 0, status: '' };
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version, status, meta FROM projects WHERE id = ?').get(id) as
      | { version: number; status: string; meta: string | null }
      | undefined;
    if (!row) throw new NotFoundError('Project not found');
    if (row.version !== patch.version) {
      throw new ConflictError(`Project changed since it was loaded (server v${row.version}, payload v${patch.version})`);
    }
    const newVersion = row.version + 1;
    const sets: string[] = ['version = ?', 'updatedAt = ?'];
    const vals: any[] = [newVersion, Date.now()];
    for (const k of ['name', 'status', 'contractor', 'address', 'bidDueDate'] as const) {
      if (patch[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(patch[k]);
      }
    }
    if (patch.archived !== undefined) {
      let meta: any = {};
      try { meta = JSON.parse(row.meta || '{}'); } catch { /* keep {} */ }
      if (patch.archived) meta.archived = true;
      else delete meta.archived; // legacy shape omits the key when not archived
      sets.push('meta = ?');
      vals.push(JSON.stringify(meta));
    }
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    out = { version: newVersion, status: patch.status ?? row.status ?? 'estimating' };
  });
  tx();
  return out;
}
```

- [ ] **Step 4: Register the route in `server/routes.ts`**

Add `patchProject, NotFoundError` to the `./projectStore` import. Insert directly after the existing `app.put('/api/projects/:id', ...)` route:

```ts
  app.patch('/api/projects/:id', authenticateToken, (req, res) => {
    try {
      const result = patchProject(db, req.params.id, req.body);
      res.json({ success: true, ...result });
    } catch (e) {
      if (e instanceof NotFoundError) return res.status(404).json({ error: e.message });
      if (e instanceof ConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      console.error('Error patching project:', e);
      res.status(500).json({ error: 'Failed to update project' });
    }
  });
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run server/routes.test.ts && npm run lint`
Expected: PASS (all, incl. 6 new), lint clean.

- [ ] **Step 6: Commit**

```bash
git add server/projectStore.ts server/routes.ts server/routes.test.ts
git commit -m "feat: granular PATCH project endpoint with lifecycle status"
```

---

### Task 4: Server — Activity Log

**Files:**
- Create: `server/activity.ts`
- Test: `server/activity.test.ts`
- Modify: `server/routes.ts` (GET /api/activity + log create/delete/status)
- Modify: `server.ts` (log proposal_sent)
- Test: `server/routes.test.ts` (append describe block)

The `activity` table has existed since Phase 1 (`id, projectId, userId, type, message, createdAt`) but nothing writes to it. Event types used in 3a: `project_created`, `project_deleted`, `status_changed`, `proposal_sent`.

- [ ] **Step 1: Write the failing unit tests**

```ts
// server/activity.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { logActivity, listActivity } from './activity';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-act-')), migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Maple', 1);
  db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run('u1', 'nathan', 'x', 'admin');
});

describe('activity log', () => {
  it('logs and lists newest-first with project and user names joined', () => {
    logActivity(db, { projectId: 'p1', userId: 'u1', type: 'status_changed', message: 'Stage changed to awarded' });
    logActivity(db, { type: 'project_created', message: 'Project "Other" created' });
    const items = listActivity(db, 10);
    expect(items).toHaveLength(2);
    expect(items[0].message).toBe('Project "Other" created');
    expect(items[0].projectName).toBeNull();
    expect(items[1]).toMatchObject({
      type: 'status_changed', projectId: 'p1', projectName: 'Maple', username: 'nathan',
    });
  });

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) logActivity(db, { type: 't', message: `m${i}` });
    expect(listActivity(db, 3)).toHaveLength(3);
  });

  it('never throws on logging failure', () => {
    db.exec('DROP TABLE activity');
    expect(() => logActivity(db, { type: 't', message: 'm' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/activity.test.ts`
Expected: FAIL — `Cannot find module './activity'`

- [ ] **Step 3: Implement**

```ts
// server/activity.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export interface ActivityEvent {
  projectId?: string | null;
  userId?: string | null;
  type: string;
  message: string;
}

// Best-effort event log powering the dashboard feed. Logging must never break
// the operation it decorates — failures are swallowed (and logged to stderr).
export function logActivity(db: Database.Database, e: ActivityEvent): void {
  try {
    db.prepare(
      'INSERT INTO activity (id, projectId, userId, type, message, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), e.projectId ?? null, e.userId ?? null, e.type, e.message, Date.now());
  } catch (err) {
    console.error('[activity] failed to log event:', err);
  }
}

export function listActivity(db: Database.Database, limit = 30): any[] {
  const capped = Math.max(1, Math.min(100, Math.floor(limit) || 30));
  return db.prepare(`
    SELECT a.id, a.projectId, a.userId, a.type, a.message, a.createdAt,
           p.name AS projectName, u.username AS username
    FROM activity a
    LEFT JOIN projects p ON p.id = a.projectId
    LEFT JOIN users u ON u.id = a.userId
    ORDER BY a.createdAt DESC, a.rowid DESC
    LIMIT ?
  `).all(capped);
}
```

- [ ] **Step 4: Wire into `server/routes.ts`**

1. Add `import { logActivity, listActivity } from './activity';`
2. In `app.post('/api/projects', ...)` after the successful `createProject` call (before `res.json`):

```ts
      logActivity(db, {
        projectId: req.body?.id, userId: (req as any).user?.id,
        type: 'project_created', message: `Project "${req.body?.name ?? 'Untitled'}" created`,
      });
```

3. In `app.delete('/api/projects/:id', ...)`, load the name before deleting and log after:

```ts
      const name = (db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.id) as any)?.name;
      deleteProject(db, dataDir, req.params.id);
      logActivity(db, {
        userId: (req as any).user?.id,
        type: 'project_deleted', message: `Project "${name ?? 'Untitled'}" deleted`,
      });
```

(replace the existing bare `deleteProject(...)` call; note `projectId` is intentionally omitted — the project row is gone.)

4. In `app.patch('/api/projects/:id', ...)` after the successful `patchProject` call:

```ts
      if (req.body?.status !== undefined) {
        logActivity(db, {
          projectId: req.params.id, userId: (req as any).user?.id,
          type: 'status_changed', message: `Stage changed to ${req.body.status}`,
        });
      }
```

5. Add the feed route (anywhere after the projects routes):

```ts
  app.get('/api/activity', authenticateToken, (req, res) => {
    try {
      res.json({ items: listActivity(db, Number(req.query.limit) || 30) });
    } catch (e) {
      console.error('Error fetching activity:', e);
      res.status(500).json({ error: 'Failed to fetch activity' });
    }
  });
```

- [ ] **Step 5: Wire `proposal_sent` into `server.ts`**

Add `import { logActivity } from './server/activity';` to the server.ts imports. In `app.post('/api/projects/:id/send-proposal', ...)`, directly after the email is successfully sent (anchor: after the `await transporter.sendMail(...)` call / before the project is re-saved and the response is sent), add:

```ts
      logActivity(db, {
        projectId: req.params.id, userId: (req as any).user?.id,
        type: 'proposal_sent', message: `Proposal emailed for "${project.name ?? 'Untitled'}"`,
      });
```

(Use the in-scope `project` variable; if the variable name differs, adapt — the message needs the project name.)

- [ ] **Step 6: Integration tests** (append to `server/routes.test.ts`)

```ts
describe('GET /api/activity', () => {
  it('records project create and status change events', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    await request(app).patch('/api/projects/p1').send({ version: 1, status: 'awarded' });
    const res = await request(app).get('/api/activity');
    expect(res.status).toBe(200);
    const types = res.body.items.map((i: any) => i.type);
    expect(types).toContain('project_created');
    expect(types).toContain('status_changed');
    const statusItem = res.body.items.find((i: any) => i.type === 'status_changed');
    expect(statusItem.projectName).toBe('Test Project');
  });
});
```

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run server/activity.test.ts server/routes.test.ts && npm run lint`
Expected: PASS, lint clean.

- [ ] **Step 8: Commit**

```bash
git add server/activity.ts server/activity.test.ts server/routes.ts server/routes.test.ts server.ts
git commit -m "feat: activity log — writes on create/delete/status/proposal, feed endpoint"
```

---

### Task 5: Client Store — Summary, Patch, Activity, Time Helpers

**Files:**
- Modify: `src/utils/store.ts` (append; no removals yet)

No unit tests — these are thin fetch wrappers following the file's existing untested pattern; they're exercised through the pages that consume them and verified by lint here.

- [ ] **Step 1: Append types and functions to `src/utils/store.ts`**

```ts
// ── Phase 3a: summaries, granular patches, activity, time ────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  contractor: string | null;
  address: string | null;
  bidDueDate: number | null;
  version: number;
  createdAt: number;
  updatedAt: number | null;
  archived: boolean;
  pageCount: number;
  takeoffCount: number;
  pageIds: string[];
}

export interface ProjectPatch {
  version: number;
  name?: string;
  status?: string;
  archived?: boolean;
  contractor?: string | null;
  address?: string | null;
  bidDueDate?: number | null;
}

export interface ActivityItem {
  id: string;
  projectId: string | null;
  userId: string | null;
  type: string;
  message: string;
  createdAt: number;
  projectName: string | null;
  username: string | null;
}

export interface TimeEntryLite {
  id: string;
  projectId: string | null;
  clockIn: number;
  clockOut: number | null;
  description: string;
}

export const getProjectsSummary = async (): Promise<ProjectSummary[]> => {
  const res = await fetchWithRetry('/api/projects/summary', { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

// Granular field update with optimistic concurrency. Unlike saveProject, a
// 409 here does NOT dispatch the global project-conflict event — callers
// decide (list views refetch; ProjectView dispatches it themselves).
export const patchProject = async (
  id: string,
  patch: ProjectPatch
): Promise<{ version: number; status: string }> => {
  const res = await fetchWithRetry(`/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(patch),
  });
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res);
  return await res.json();
};

export const getActivity = async (limit = 20): Promise<ActivityItem[]> => {
  const res = await fetchWithRetry(`/api/activity?limit=${limit}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return (await res.json()).items;
};

export const getMyTimeEntries = async (): Promise<TimeEntryLite[]> => {
  const res = await fetchWithRetry('/api/time-entries', { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

export const clockIn = async (projectId?: string): Promise<void> => {
  const res = await fetchWithRetry('/api/time-entries/clock-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ projectId: projectId ?? null }),
  });
  await handleResponse(res);
};

export const clockOut = async (): Promise<void> => {
  const res = await fetchWithRetry('/api/time-entries/clock-out', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({}),
  });
  await handleResponse(res);
};
```

- [ ] **Step 2: Verify and commit**

Run: `npm run lint && npm test`
Expected: clean / green.

```bash
git add src/utils/store.ts
git commit -m "feat: client store — summaries, patchProject, activity, clock helpers"
```

---

### Task 6: ProjectsPage — Pipeline-Grouped Projects (replaces ProjectsList)

**Files:**
- Create: `src/pages/ProjectsPage.tsx`
- Test: `src/pages/ProjectsPage.test.tsx`
- Modify: `src/App.tsx` (swap the index route element)
- Delete: `src/pages/ProjectsList.tsx`

This page replaces ProjectsList wholesale — the bids tab, the duplicate Users tab (Settings → User Management already exists), the 6-field sort UI, and the table view die with it (deliberate simplifications; spec §4.1 wants pipeline-grouped cards). Templates stay as a sub-tab. It mounts at `/` for now; Task 10 moves it to `/projects`.

- [ ] **Step 1: Write the failing grouping tests**

```tsx
// src/pages/ProjectsPage.test.tsx
import { describe, it, expect } from 'vitest';
import { groupSummaries } from './ProjectsPage';
import type { ProjectSummary } from '../utils/store';

const mk = (over: Partial<ProjectSummary>): ProjectSummary => ({
  id: 'x', name: 'P', status: 'estimating', contractor: null, address: null,
  bidDueDate: null, version: 1, createdAt: 1, updatedAt: null, archived: false,
  pageCount: 0, takeoffCount: 0, pageIds: [], ...over,
});

describe('groupSummaries', () => {
  it('buckets statuses into the three pipeline groups', () => {
    const groups = groupSummaries([
      mk({ id: 'a', status: 'estimating' }),
      mk({ id: 'b', status: 'proposal_sent' }),
      mk({ id: 'c', status: 'awarded' }),
      mk({ id: 'd', status: 'in_progress' }),
      mk({ id: 'e', status: 'punch_list' }),
      mk({ id: 'f', status: 'complete' }),
      mk({ id: 'g', status: 'lost' }),
    ]);
    expect(groups.map(g => g.id)).toEqual(['estimating', 'active', 'closed']);
    expect(groups[0].projects.map(p => p.id).sort()).toEqual(['a', 'b']);
    expect(groups[1].projects.map(p => p.id).sort()).toEqual(['c', 'd', 'e']);
    expect(groups[2].projects.map(p => p.id).sort()).toEqual(['f', 'g']);
  });

  it('drops archived projects and folds unknown statuses into Estimating', () => {
    const groups = groupSummaries([
      mk({ id: 'a', status: 'awarded', archived: true }),
      mk({ id: 'b', status: 'something_weird' }),
    ]);
    expect(groups[1].projects).toHaveLength(0);
    expect(groups[0].projects.map(p => p.id)).toEqual(['b']);
  });

  it('sorts Estimating by due date (undated last) and Active by recency', () => {
    const groups = groupSummaries([
      mk({ id: 'late', status: 'estimating', bidDueDate: 200 }),
      mk({ id: 'none', status: 'estimating', bidDueDate: null }),
      mk({ id: 'soon', status: 'estimating', bidDueDate: 100 }),
      mk({ id: 'old', status: 'awarded', updatedAt: 10 }),
      mk({ id: 'new', status: 'awarded', updatedAt: 20 }),
    ]);
    expect(groups[0].projects.map(p => p.id)).toEqual(['soon', 'late', 'none']);
    expect(groups[1].projects.map(p => p.id)).toEqual(['new', 'old']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/ProjectsPage.test.tsx`
Expected: FAIL — `Cannot find module './ProjectsPage'`

- [ ] **Step 3: Implement the page**

```tsx
// src/pages/ProjectsPage.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus, Calendar, Building2, MapPin, Archive, ArchiveRestore,
  Trash2, Edit2, Check, X, FileText, Ruler, FolderOpen, Layout as LayoutIcon,
} from 'lucide-react';
import {
  ProjectSummary, getProjectsSummary, patchProject, deleteProject,
  getActivePages, ConflictError,
} from '../utils/store';
import { TemplatesView } from './TemplatesView';
import { useToast } from '../components/Toast';
import {
  Button, Card, EmptyState, Input, Modal, ProjectStatusPill, Select, Skeleton,
} from '../components/ui';

type Tab = 'projects' | 'templates';

export interface PipelineGroup {
  id: string;
  label: string;
  projects: ProjectSummary[];
}

const GROUP_DEFS: { id: string; label: string; statuses: string[] }[] = [
  { id: 'estimating', label: 'Estimating', statuses: ['estimating', 'proposal_sent'] },
  { id: 'active', label: 'Active', statuses: ['awarded', 'in_progress', 'punch_list'] },
  { id: 'closed', label: 'Complete & Closed', statuses: ['complete', 'lost'] },
];

const KNOWN_STATUSES = GROUP_DEFS.flatMap(g => g.statuses);

// Buckets non-archived summaries into the three pipeline groups (spec §4.1).
// Unknown statuses land in Estimating so nothing ever vanishes from the board.
export function groupSummaries(summaries: ProjectSummary[]): PipelineGroup[] {
  const visible = summaries.filter(s => !s.archived);
  return GROUP_DEFS.map(def => {
    const projects = visible.filter(s =>
      def.statuses.includes(s.status) ||
      (def.id === 'estimating' && !KNOWN_STATUSES.includes(s.status))
    );
    // Estimating: soonest bid due date first, undated last.
    // Other groups: most recently touched first.
    projects.sort((a, b) =>
      def.id === 'estimating'
        ? (a.bidDueDate ?? Infinity) - (b.bidDueDate ?? Infinity)
        : (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)
    );
    return { id: def.id, label: def.label, projects };
  });
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

const ProjectCard: React.FC<{
  p: ProjectSummary;
  overdueHighlight: boolean;
  onOpen: () => void;
  onRename: (name: string) => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
}> = ({ p, overdueHighlight, onOpen, onRename, onArchiveToggle, onDelete }) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const overdue = overdueHighlight && p.bidDueDate !== null && p.bidDueDate < Date.now();

  const commitRename = () => {
    setEditing(false);
    const trimmed = name.trim();
    if (trimmed && trimmed !== p.name) onRename(trimmed);
    else setName(p.name);
  };

  return (
    <Card
      className="cursor-pointer p-4 transition-colors hover:border-edge-strong"
      onClick={() => !editing && onOpen()}
    >
      <div className="flex items-start justify-between gap-2">
        {editing ? (
          <div className="flex flex-1 items-center gap-1" onClick={e => e.stopPropagation()}>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') { setEditing(false); setName(p.name); }
              }}
              autoFocus
              className="h-8 py-1 text-sm"
            />
            <Button variant="ghost" size="sm" onClick={commitRename} aria-label="Save name"><Check size={14} /></Button>
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setName(p.name); }} aria-label="Cancel rename"><X size={14} /></Button>
          </div>
        ) : (
          <h3 className="flex-1 truncate text-sm font-semibold text-ink" title={p.name}>{p.name}</h3>
        )}
        <ProjectStatusPill status={p.archived ? 'archived' : p.status} />
      </div>

      <div className="mt-2 space-y-1 text-xs text-ink-soft">
        {p.contractor && (
          <p className="flex items-center gap-1.5 truncate"><Building2 size={12} className="shrink-0 text-ink-faint" />{p.contractor}</p>
        )}
        {p.address && (
          <p className="flex items-center gap-1.5 truncate"><MapPin size={12} className="shrink-0 text-ink-faint" />{p.address}</p>
        )}
        {p.bidDueDate !== null && (
          <p className={`flex items-center gap-1.5 ${overdue ? 'font-medium text-red-600 dark:text-red-400' : ''}`}>
            <Calendar size={12} className="shrink-0 text-ink-faint" />
            Due {fmtDate(p.bidDueDate)}{overdue ? ' — overdue' : ''}
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-edge pt-2">
        <div className="flex items-center gap-3 text-xs text-ink-faint">
          <span className="flex items-center gap-1"><FileText size={12} />{p.pageCount}</span>
          <span className="flex items-center gap-1"><Ruler size={12} />{p.takeoffCount}</span>
        </div>
        <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
          <button onClick={() => setEditing(true)} title="Rename" className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"><Edit2 size={13} /></button>
          <button onClick={onArchiveToggle} title={p.archived ? 'Restore' : 'Archive'} className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink">
            {p.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
          </button>
          <button onClick={onDelete} title="Delete" className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"><Trash2 size={13} /></button>
        </div>
      </div>
    </Card>
  );
};

export const ProjectsPage: React.FC = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: Tab = searchParams.get('tab') === 'templates' ? 'templates' : 'projects';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(searchParams);
    if (t === 'projects') next.delete('tab'); else next.set('tab', t);
    setSearchParams(next, { replace: true });
  };

  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [search, setSearch] = useState('');
  const [contractor, setContractor] = useState('all');
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [deleteText, setDeleteText] = useState('');

  const load = async () => {
    try {
      setSummaries(await getProjectsSummary());
    } catch {
      toast('Failed to load projects', { type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const contractors = useMemo(
    () => Array.from(new Set(summaries.map(s => s.contractor).filter(Boolean))).sort() as string[],
    [summaries]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return summaries.filter(s => {
      if (contractor !== 'all' && s.contractor !== contractor) return false;
      if (!q) return true;
      return [s.name, s.contractor, s.address].some(v => v && v.toLowerCase().includes(q));
    });
  }, [summaries, search, contractor]);

  const groups = useMemo(() => groupSummaries(filtered), [filtered]);
  const archivedProjects = useMemo(
    () => filtered.filter(s => s.archived).sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)),
    [filtered]
  );

  // Applies a granular patch and reconciles the local row. A 409 means our
  // summary is stale — refetch rather than reloading the page.
  const applyPatch = async (p: ProjectSummary, patch: Partial<ProjectSummary> & Record<string, unknown>) => {
    try {
      const r = await patchProject(p.id, { version: p.version, ...patch } as any);
      setSummaries(prev => prev.map(s => (s.id === p.id ? { ...s, ...patch, version: r.version } : s)));
    } catch (e) {
      if (e instanceof ConflictError) {
        toast('Project changed elsewhere — refreshing', { type: 'warning' });
        load();
      } else {
        toast('Update failed', { type: 'error' });
      }
    }
  };

  const handleDeleteClick = async (p: ProjectSummary) => {
    try {
      const active = await getActivePages();
      if (p.pageIds.some(id => active.includes(id))) {
        toast('This project has pages currently being viewed by other users and cannot be deleted.', { type: 'warning' });
        return;
      }
    } catch { /* active-pages check is best-effort */ }
    setDeleteText('');
    setDeleteTarget(p);
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleteText.toLowerCase() !== 'delete') return;
    const removed = deleteTarget;
    setDeleteTarget(null);
    setSummaries(prev => prev.filter(s => s.id !== removed.id)); // optimistic
    try {
      await deleteProject(removed.id);
      toast('Project deleted', { type: 'success' });
    } catch {
      setSummaries(prev => [removed, ...prev]);
      toast('Failed to delete project', { type: 'error' });
    }
  };

  const renderCards = (projects: ProjectSummary[], overdueHighlight: boolean) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map(p => (
        <ProjectCard
          key={p.id}
          p={p}
          overdueHighlight={overdueHighlight}
          onOpen={() => navigate(`/project/${p.id}`)}
          onRename={name => applyPatch(p, { name })}
          onArchiveToggle={() => applyPatch(p, { archived: !p.archived })}
          onDelete={() => handleDeleteClick(p)}
        />
      ))}
    </div>
  );

  const totalVisible = groups.reduce((n, g) => n + g.projects.length, 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink">Projects</h1>
        <Button onClick={() => navigate('/new')}><Plus size={16} />New Project</Button>
      </div>

      {/* Tabs: Projects | Templates */}
      <div className="mb-4 flex items-center gap-1 border-b border-edge">
        {(['projects', 'templates'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t ? 'border-accent-500 text-ink' : 'border-transparent text-ink-soft hover:text-ink'
            }`}
          >
            {t === 'projects' ? <FolderOpen size={15} /> : <LayoutIcon size={15} />}
            {t === 'projects' ? 'Projects' : 'Templates'}
          </button>
        ))}
      </div>

      {tab === 'templates' ? (
        <TemplatesView />
      ) : (
        <>
          {/* Controls */}
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search projects…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-9 max-w-xs"
            />
            <Select value={contractor} onChange={e => setContractor(e.target.value)} className="h-9 w-auto">
              <option value="all">All contractors</option>
              {contractors.map(c => <option key={c} value={c}>{c}</option>)}
            </Select>
            <div className="ml-auto flex rounded-lg border border-edge p-0.5">
              {(['active', 'archived'] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    view === v ? 'bg-sunken text-ink' : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  {v === 'active' ? 'Active' : 'Archived'}
                </button>
              ))}
            </div>
          </div>

          {isLoading ? (
            <div className="space-y-6">
              <Skeleton className="h-5 w-32" />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
              </div>
            </div>
          ) : view === 'archived' ? (
            archivedProjects.length === 0 ? (
              <EmptyState icon={<Archive size={22} />} title="No archived projects" description="Archived projects appear here and can be restored anytime." />
            ) : (
              renderCards(archivedProjects, false)
            )
          ) : totalVisible === 0 ? (
            <EmptyState
              icon={<FolderOpen size={22} />}
              title="No projects yet"
              description="Create your first project to start estimating."
              action={<Button onClick={() => navigate('/new')}><Plus size={16} />New Project</Button>}
            />
          ) : (
            <div className="space-y-7">
              {groups.filter(g => g.projects.length > 0).map(g => (
                <section key={g.id}>
                  <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                    {g.label} · {g.projects.length}
                  </h2>
                  {renderCards(g.projects, g.id === 'estimating')}
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {/* Delete confirmation */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete "${deleteTarget?.name}"?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" disabled={deleteText.toLowerCase() !== 'delete'} onClick={confirmDelete}>
              Delete project
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-ink-soft">
          This permanently deletes the project, its pages, measurements, and files. Type <strong>delete</strong> to confirm.
        </p>
        <Input value={deleteText} onChange={e => setDeleteText(e.target.value)} placeholder="delete" autoFocus />
      </Modal>
    </div>
  );
};
```

- [ ] **Step 4: Run to verify the grouping tests pass**

Run: `npx vitest run src/pages/ProjectsPage.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Swap the route and delete ProjectsList**

In `src/App.tsx`:
1. Replace `import { ProjectsList } from './pages/ProjectsList';` with `import { ProjectsPage } from './pages/ProjectsPage';`
2. Replace the index route element `<ProjectsList appName={appName} logoUrl={logoUrl} />` with `<ProjectsPage />`.

Then:

```bash
grep -rn "ProjectsList" src/ --include=*.tsx --include=*.ts
```

Expected: no remaining references (if any besides App.tsx exist, fix them first). Then:

```bash
git rm src/pages/ProjectsList.tsx
```

- [ ] **Step 6: Verify**

Run: `npm run lint && npm test`
Expected: clean / green. Boot the dev server, log in: `/` shows pipeline groups (existing projects land in Estimating via their derived status), rename/archive/delete work from cards, Templates tab renders, archived view shows archived projects.

- [ ] **Step 7: Commit**

```bash
git add src/pages/ProjectsPage.tsx src/pages/ProjectsPage.test.tsx src/App.tsx
git commit -m "feat: pipeline-grouped Projects page replaces ProjectsList"
```

---

### Task 7: Client — Remove Bid/IMAP Plumbing

**Files:**
- Modify: `src/utils/store.ts`
- Modify: `src/types.ts`
- Modify: `src/pages/Settings.tsx`
- Modify: `src/pages/NewProject.tsx`
- Modify: `src/components/CommandPalette.tsx`

ProjectsList (the main consumer) is already gone. **Remember:** `bidDueDate`, `BidEmail`, and `Project.email`/`Project.emails` STAY. SMTP UI STAYS.

- [ ] **Step 1: `src/utils/store.ts` removals**

Delete these exported functions (locate by name): `getBids`, `saveBid`, `updateBid`, `deleteBid`, `getEmailAccounts`, `createEmailAccount`, `updateEmailAccount`, `deleteEmailAccount`, `testImapAccount`, `pollEmailNow`, `importEmailAsBid`, `sendProposal` (the **bid** variant posting to `/api/bids/:id/send-proposal` — KEEP `sendProjectProposal`). Keep `getSmtpSettings`, `saveSmtpSettings`, `testSmtpConnection`.

In the `SearchResult` interface (~line 439): remove `'bid'` from the `type` union and the `bidId?` field.

Remove the now-unused `Bid`/`EmailAccount` imports from the file's import of `../types`.

- [ ] **Step 2: `src/types.ts` removals**

Delete the `Bid` interface, the `BidStatus` type, and the `EmailAccount` interface. KEEP `BidEmail` (used by `Project.email`/`Project.emails`) — update its doc comment to say it's the email thread attached to a project. Keep `Project.email`, `Project.emails`, `Project.proposalFileId`, `Project.proposalSentAt`.

- [ ] **Step 3: `src/pages/Settings.tsx` — remove IMAP, keep SMTP**

In the email tab region:
1. Delete the `ImapAccountForm` component (anchor: `const ImapAccountForm` ~line 548) and the `IMAP_PRESETS` map + provider help text block (~650-704).
2. In `EmailTab` (~line 716): delete the accounts/polling state (`accounts`, `editingAccount`, `showAddAccount`, `pollInterval`, `testingAccount`, `testResults`, `polling`, `pollResult`) and handlers (`handleAddAccount`, `handleUpdateAccount`, `handleDeleteAccount`, `handleTestAccount`, `handleSavePollInterval`, `handlePollNow`). Adjust the mount-fetch `Promise.all` to fetch only SMTP settings.
3. Delete the "Inbound Email Monitoring (IMAP)" JSX section (~884-1025) — accounts list, add-account form, polling controls. Keep the SMTP section (~825-880) intact; retitle it "Outbound Email (SMTP)" if it isn't already labeled as outbound.
4. Remove the deleted store imports (`getEmailAccounts, createEmailAccount, updateEmailAccount, deleteEmailAccount, testImapAccount, pollEmailNow`) from the import line.
5. In `StorageTab`: remove the `bids` row from the storage-breakdown display (grep `bids` within Settings.tsx).

- [ ] **Step 4: `src/pages/NewProject.tsx` — remove bid conversion**

1. Remove `deleteBid` and `getBids` from the store import; change the load `Promise.all([getAllProjects(), getBids()])` (~line 65) to just `await getAllProjects()` (keep whatever the projects result is used for).
2. Delete the `fromBid*` location-state block (~608-622): the typed state read and the post-create `deleteBid(fromBidId)` call, plus any spreading of `fromBidEmail/fromBidEmails/fromBidProposalFileId/fromBidProposalSentAt` into the new project.

- [ ] **Step 5: `src/components/CommandPalette.tsx` — remove the bid result type**

1. Remove the `'bid'` icon/type-label entries and the `case 'bid': navigate('/?tab=bids'); break;` branch.
2. Update the search placeholder to `"Search projects, pages, takeoffs…"`.

- [ ] **Step 6: Verify no leftovers and commit**

```bash
grep -rn "\bBid\b\|BidStatus\|EmailAccount\|getBids\|saveBid\|updateBid\|deleteBid\|importEmailAsBid\|testImap\|pollEmail\|api/bids" src/ && echo "FOUND LEFTOVERS" || echo "clean"
```

Expected: `clean` — except `BidEmail` occurrences (allowed) and `bidDueDate` (allowed; the grep above won't match it). Inspect any hits before deciding.

Run: `npm run lint && npm test`
Expected: clean / green. Boot check: Settings → Email shows only SMTP; New Project works.

```bash
git add src/utils/store.ts src/types.ts src/pages/Settings.tsx src/pages/NewProject.tsx src/components/CommandPalette.tsx
git commit -m "feat: remove bid inbox and IMAP plumbing from the client"
```

---

### Task 8: ProjectView Stage Control

**Files:**
- Create: `src/components/ProjectStageControl.tsx`
- Test: `src/components/ProjectStageControl.test.tsx`
- Modify: `src/pages/ProjectView.tsx` (one import + one JSX insertion)

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/ProjectStageControl.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectStageControl } from './ProjectStageControl';
import { ToastProvider } from './Toast';

const patchProject = vi.hoisted(() => vi.fn());
vi.mock('../utils/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/store')>();
  return { ...actual, patchProject };
});

beforeEach(() => patchProject.mockReset());

const renderControl = (onChanged = vi.fn()) =>
  render(
    <ToastProvider>
      <ProjectStageControl projectId="p1" version={3} status="estimating" onChanged={onChanged} />
    </ToastProvider>
  );

describe('ProjectStageControl', () => {
  it('shows the current stage pill and opens the stage menu', () => {
    renderControl();
    expect(screen.getByText('Estimating')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Change project stage'));
    for (const label of ['Proposal Sent', 'Awarded', 'In Progress', 'Punch List', 'Complete', 'Lost']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Archived' })).not.toBeInTheDocument();
  });

  it('patches the stage and reports the new version', async () => {
    patchProject.mockResolvedValue({ version: 4, status: 'awarded' });
    const onChanged = vi.fn();
    renderControl(onChanged);
    fireEvent.click(screen.getByTitle('Change project stage'));
    fireEvent.click(screen.getByRole('button', { name: 'Awarded' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(4, 'awarded'));
    expect(patchProject).toHaveBeenCalledWith('p1', { version: 3, status: 'awarded' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/ProjectStageControl.test.tsx`
Expected: FAIL — `Cannot find module './ProjectStageControl'`

- [ ] **Step 3: Implement**

```tsx
// src/components/ProjectStageControl.tsx
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { patchProject, ConflictError } from '../utils/store';
import { ProjectStatusPill, PROJECT_STATUS_META } from './ui';
import { useToast } from './Toast';

// Stage options exclude 'archived' — archiving is its own explicit action.
const STAGE_OPTIONS = [
  'estimating', 'proposal_sent', 'awarded', 'in_progress',
  'punch_list', 'complete', 'lost',
];

export const ProjectStageControl: React.FC<{
  projectId: string;
  version: number | undefined;
  status: string | undefined;
  onChanged: (version: number, status: string) => void;
}> = ({ projectId, version, status, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = async (next: string) => {
    setOpen(false);
    if (next === status || saving) return;
    setSaving(true);
    try {
      const r = await patchProject(projectId, { version: version ?? 1, status: next });
      onChanged(r.version, r.status);
      toast(`Stage set to ${PROJECT_STATUS_META[next]?.label ?? next}`, { type: 'success' });
    } catch (e) {
      if (e instanceof ConflictError) {
        // Our copy of the project is stale — hand off to the global reload UX.
        window.dispatchEvent(new CustomEvent('project-conflict', { detail: { projectId } }));
      } else {
        toast('Failed to change stage', { type: 'error' });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={saving}
        title="Change project stage"
        className="inline-flex items-center gap-1 disabled:opacity-50"
      >
        <ProjectStatusPill status={status} />
        <ChevronDown size={14} className="text-ink-faint" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-44 rounded-lg border border-edge bg-raised py-1 shadow-lg">
          {STAGE_OPTIONS.map(s => (
            <button
              key={s}
              onClick={() => pick(s)}
              className={`w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-hover ${
                s === status ? 'font-medium text-ink' : 'text-ink-soft'
              }`}
            >
              {PROJECT_STATUS_META[s]?.label ?? s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/ProjectStageControl.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Mount it in ProjectView's header**

In `src/pages/ProjectView.tsx`:
1. Add `import { ProjectStageControl } from '../components/ProjectStageControl';`
2. Locate the header block that renders/edits the project name (anchor: the JSX using `isEditingProjectName` — header region ~line 3430s). Insert, immediately after the name display/edit cluster (as a sibling on the same header row):

```tsx
              <ProjectStageControl
                projectId={project.id}
                version={project.version}
                status={project.status}
                onChanged={(version, status) => setProject(p => (p ? { ...p, version, status } : p))}
              />
```

If the surrounding layout needs a flex wrapper to sit the pill next to the name, add minimal classes only (`flex items-center gap-2`). If the anchor is ambiguous, report NEEDS_CONTEXT rather than guessing.

- [ ] **Step 6: Verify and commit**

Run: `npm run lint && npm test`
Expected: clean / green. Boot check: open a project → stage pill with chevron next to the name; change stage → toast, pill updates; the pipeline group on `/` reflects it after reload; the activity feed (Task 4) gets a row.

```bash
git add src/components/ProjectStageControl.tsx src/components/ProjectStageControl.test.tsx src/pages/ProjectView.tsx
git commit -m "feat: project stage dropdown in ProjectView header"
```

---

### Task 9: Dashboard Page

**Files:**
- Create: `src/pages/Dashboard.tsx`
- Test: `src/pages/Dashboard.test.tsx`
- Modify: `src/App.tsx` (add the `/dashboard` route — index stays ProjectsPage until Task 10)

- [ ] **Step 1: Write the failing helper tests**

```tsx
// src/pages/Dashboard.test.tsx
import { describe, it, expect } from 'vitest';
import { hoursThisWeek, startOfWeek, timeAgo } from './Dashboard';

describe('startOfWeek', () => {
  it('returns the preceding Monday at 00:00', () => {
    // Wed 2026-06-10 15:30 local → Mon 2026-06-08 00:00 local
    const wed = new Date(2026, 5, 10, 15, 30);
    const start = new Date(startOfWeek(wed));
    expect(start.getDay()).toBe(1); // Monday
    expect([start.getHours(), start.getMinutes()]).toEqual([0, 0]);
    expect(start.getDate()).toBe(8);
  });
});

describe('hoursThisWeek', () => {
  it('sums only entries clocked in this week, counting open entries to now', () => {
    const now = new Date(2026, 5, 10, 12, 0).getTime(); // Wed noon
    const monday = startOfWeek(new Date(now));
    const entries = [
      { id: '1', projectId: null, clockIn: monday + 3_600_000, clockOut: monday + 3 * 3_600_000, description: '' }, // 2h
      { id: '2', projectId: null, clockIn: now - 1_800_000, clockOut: null, description: '' },                      // 0.5h open
      { id: '3', projectId: null, clockIn: monday - 24 * 3_600_000, clockOut: monday - 20 * 3_600_000, description: '' }, // last week
    ];
    expect(hoursThisWeek(entries, now)).toBeCloseTo(2.5, 5);
  });
});

describe('timeAgo', () => {
  it('formats rough relative times', () => {
    const now = Date.now();
    expect(timeAgo(now - 30_000)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000)).toBe('5m ago');
    expect(timeAgo(now - 3 * 3_600_000)).toBe('3h ago');
    expect(timeAgo(now - 2 * 86_400_000)).toBe('2d ago');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/Dashboard.test.tsx`
Expected: FAIL — `Cannot find module './Dashboard'`

- [ ] **Step 3: Implement**

```tsx
// src/pages/Dashboard.tsx
import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity as ActivityIcon, Calendar, Clock, FolderKanban, Plus } from 'lucide-react';
import {
  ProjectSummary, ActivityItem, TimeEntryLite,
  getProjectsSummary, getActivity, getMyTimeEntries,
} from '../utils/store';
import {
  Button, Card, CardBody, CardHeader, EmptyState, ProjectStatusPill, Skeleton,
} from '../components/ui';

const DAY = 86_400_000;

export const timeAgo = (ms: number): string => {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
};

// Monday 00:00 local time of the week containing `now`.
export const startOfWeek = (now: Date = new Date()): number => {
  const d = new Date(now);
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setHours(0, 0, 0, 0);
  return d.getTime() - dow * DAY;
};

export const hoursThisWeek = (entries: TimeEntryLite[], now: number = Date.now()): number => {
  const start = startOfWeek(new Date(now));
  let ms = 0;
  for (const e of entries) {
    if (e.clockIn >= start) ms += (e.clockOut ?? now) - e.clockIn;
  }
  return ms / 3_600_000;
};

const ESTIMATING = ['estimating', 'proposal_sent'];
const ACTIVE = ['awarded', 'in_progress', 'punch_list'];

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [hours, setHours] = useState<number | null>(null);
  const user = JSON.parse(localStorage.getItem('user') || '{}');

  useEffect(() => {
    getProjectsSummary().then(setSummaries).catch(() => setSummaries([]));
    getActivity(10).then(setActivity).catch(() => setActivity([]));
    getMyTimeEntries().then(e => setHours(hoursThisWeek(e))).catch(() => setHours(0));
  }, []);

  const visible = (summaries ?? []).filter(s => !s.archived);
  const upcoming = visible
    .filter(s => ESTIMATING.includes(s.status) && s.bidDueDate !== null)
    .sort((a, b) => (a.bidDueDate! - b.bidDueDate!))
    .slice(0, 5);
  const activeProjects = visible
    .filter(s => ACTIVE.includes(s.status))
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, 5);

  const loading = summaries === null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Dashboard</h1>
          <p className="text-sm text-ink-faint">Welcome back{user.username ? `, ${user.username}` : ''}.</p>
        </div>
        <Button onClick={() => navigate('/new')}><Plus size={16} />New Project</Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Upcoming bid deadlines */}
        <Card>
          <CardHeader title="Upcoming bid deadlines" actions={<Calendar size={15} className="text-ink-faint" />} />
          <CardBody className="p-0">
            {loading ? (
              <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
            ) : upcoming.length === 0 ? (
              <EmptyState title="No upcoming deadlines" description="Estimating projects with bid due dates show up here." />
            ) : (
              <ul className="divide-y divide-edge">
                {upcoming.map(p => {
                  const overdue = p.bidDueDate! < Date.now();
                  return (
                    <li key={p.id}>
                      <Link to={`/project/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-hover">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-ink">{p.name}</span>
                          {p.contractor && <span className="block truncate text-xs text-ink-faint">{p.contractor}</span>}
                        </span>
                        <span className={`shrink-0 text-xs font-medium ${overdue ? 'text-red-600 dark:text-red-400' : 'text-ink-soft'}`}>
                          {new Date(p.bidDueDate!).toLocaleDateString()}{overdue ? ' · overdue' : ''}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Active projects */}
        <Card>
          <CardHeader
            title="Active projects"
            actions={<Link to="/projects" className="text-xs font-medium text-accent-600 hover:underline">View all</Link>}
          />
          <CardBody className="p-0">
            {loading ? (
              <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
            ) : activeProjects.length === 0 ? (
              <EmptyState icon={<FolderKanban size={20} />} title="Nothing in progress" description="Projects move here once they're awarded." />
            ) : (
              <ul className="divide-y divide-edge">
                {activeProjects.map(p => (
                  <li key={p.id}>
                    <Link to={`/project/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-hover">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">{p.name}</span>
                        {p.contractor && <span className="block truncate text-xs text-ink-faint">{p.contractor}</span>}
                      </span>
                      <ProjectStatusPill status={p.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Recent activity */}
        <Card>
          <CardHeader title="Recent activity" actions={<ActivityIcon size={15} className="text-ink-faint" />} />
          <CardBody className="p-0">
            {activity === null ? (
              <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8" />)}</div>
            ) : activity.length === 0 ? (
              <EmptyState title="No activity yet" description="Project events show up here as your team works." />
            ) : (
              <ul className="divide-y divide-edge">
                {activity.map(a => (
                  <li key={a.id} className="px-4 py-2.5">
                    <p className="text-sm text-ink">{a.message}</p>
                    <p className="text-xs text-ink-faint">
                      {a.username ? `${a.username} · ` : ''}{timeAgo(a.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* My hours this week */}
        <Card>
          <CardHeader
            title="My hours this week"
            actions={<Link to="/time" className="text-xs font-medium text-accent-600 hover:underline">Time tracking</Link>}
          />
          <CardBody>
            {hours === null ? (
              <Skeleton className="h-12 w-28" />
            ) : (
              <div className="flex items-baseline gap-2">
                <Clock size={20} className="self-center text-ink-faint" />
                <span className="text-3xl font-bold text-ink">{hours.toFixed(1)}</span>
                <span className="text-sm text-ink-soft">hours since Monday</span>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/pages/Dashboard.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Add the route**

In `src/App.tsx`: add `import { Dashboard } from './pages/Dashboard';` and a child route (next to the other children):

```tsx
        {
          path: 'dashboard',
          element: <Dashboard />,
        },
```

- [ ] **Step 6: Verify and commit**

Run: `npm run lint && npm test`
Expected: clean / green. Boot check: `/dashboard` renders all four cards with real data (deadlines from estimating projects, activity from Task 4 events, hours from time entries).

```bash
git add src/pages/Dashboard.tsx src/pages/Dashboard.test.tsx src/App.tsx
git commit -m "feat: dashboard — deadlines, active projects, activity feed, weekly hours"
```

---

### Task 10: Route & Navigation Alignment

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/shell/Sidebar.tsx`
- Modify: `src/components/shell/Sidebar.test.tsx`
- Modify: `src/components/CommandPalette.tsx`
- Modify: `src/pages/Login.tsx`, `src/pages/CanvasView.tsx`, `src/pages/ProjectView.tsx`, `src/pages/NewProject.tsx`, `src/pages/ServerSettings.tsx`, `src/pages/ChecklistEditor.tsx` (navigation targets only)

Aligns company-level URLs with spec §4.1: `/dashboard`, `/projects`, `/tools/pdf`, `/tools/sheets`. The project namespace stays `/project/:projectId` (deliberate deviation from the spec's `/p/:id` — renaming is pure churn across ~20 call sites with no user value; 3b adds section routes under the existing prefix).

- [ ] **Step 1: Restructure routes in `src/App.tsx`**

1. Add `Navigate` to the react-router-dom import.
2. Replace the children array entries as follows (Login/NewProject/ProjectView/CanvasView/Settings/checklist/time/share entries stay):
   - index route: `{ index: true, element: <Navigate to="/dashboard" replace /> }`
   - keep `{ path: 'dashboard', element: <Dashboard /> }`
   - add `{ path: 'projects', element: <ProjectsPage /> }`
   - change `pdf-editor` → `{ path: 'tools/pdf', element: <PdfEditor /> }`
   - change `spreadsheet-editor` → `{ path: 'tools/sheets', element: <SpreadsheetEditor /> }`
   - add legacy redirects (bookmarks): `{ path: 'pdf-editor', element: <Navigate to="/tools/pdf" replace /> }` and `{ path: 'spreadsheet-editor', element: <Navigate to="/tools/sheets" replace /> }`

- [ ] **Step 2: Update in-app navigation targets** (search each file for the old target)

| File | Old | New |
|---|---|---|
| `src/pages/Login.tsx` (~33) | `navigate('/')` | `navigate('/dashboard')` |
| `src/pages/CanvasView.tsx` (~653) | `navigate('/')` | `navigate('/projects')` |
| `src/pages/ProjectView.tsx` (~1118) | `navigate('/')` | `navigate('/projects')` |
| `src/pages/ProjectView.tsx` (~3213) | `<Link to="/"` | `<Link to="/projects"` |
| `src/pages/ProjectView.tsx` (~2618) | `navigate('/spreadsheet-editor', { state... })` | `navigate('/tools/sheets', { state... })` |
| `src/pages/ProjectView.tsx` (~2629) | `navigate('/pdf-editor', { state... })` | `navigate('/tools/pdf', { state... })` |
| `src/pages/NewProject.tsx` (~663, ~862) | `<Link to="/"` / `to="/"` | `to="/projects"` |
| `src/pages/ServerSettings.tsx` (~159, ~225) | `navigate('/')` | `navigate('/dashboard')` |
| `src/pages/ChecklistEditor.tsx` (~1087) | `navigate('/pdf-editor'...)` | `navigate('/tools/pdf'...)` |

(Do NOT touch logout redirects to `/login` or `window.location.href` usages.)

- [ ] **Step 3: Update the Sidebar company nav** (`src/components/shell/Sidebar.tsx`)

1. Add `LayoutDashboard` to the lucide import.
2. Replace `WORKSPACE_NAV` with:

```tsx
const WORKSPACE_NAV: NavEntry[] = [
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard, path: '/dashboard', match: p => p === '/' || p.startsWith('/dashboard') },
  { id: 'projects', label: 'Projects', Icon: FolderKanban, path: '/projects', match: p => p.startsWith('/projects') || p === '/new' || p.startsWith('/project') },
  { id: 'checklists', label: 'Checklists', Icon: ClipboardList, path: '/checklist', match: p => p.startsWith('/checklist') },
  { id: 'time', label: 'Time', Icon: Clock, path: '/time', match: p => p.startsWith('/time') },
];
```

3. Update `TOOLS_NAV` paths/matches to `/tools/pdf` and `/tools/sheets`:

```tsx
const TOOLS_NAV: NavEntry[] = [
  { id: 'pdf-editor', label: 'PDF Editor', Icon: FileEdit, path: '/tools/pdf', match: p => p.startsWith('/tools/pdf') || p.startsWith('/pdf-editor') },
  { id: 'spreadsheet-editor', label: 'Spreadsheet', Icon: Sheet, path: '/tools/sheets', match: p => p.startsWith('/tools/sheets') || p.startsWith('/spreadsheet-editor') },
];
```

4. In project mode, change the "All Projects" row's onClick from `navigate('/')` to `navigate('/projects')`.

- [ ] **Step 4: Update Sidebar tests** (`src/components/shell/Sidebar.test.tsx`)

1. In the company-mode "shows workspace and tools nav groups" test, add `'Dashboard'` to the label list.
2. Add a test to the company-mode describe block:

```tsx
  it('marks Dashboard active on /dashboard and Projects active on /projects', () => {
    renderAt('/dashboard');
    expect(screen.getByRole('button', { name: /Dashboard/ }).className).toContain('glow-accent');
    cleanup();
    localStorage.setItem('token', 'test-token');
    renderAt('/projects');
    expect(screen.getByRole('button', { name: /Projects/ }).className).toContain('glow-accent');
  });
```

(Add `cleanup` to the `@testing-library/react` import.)

- [ ] **Step 5: Update CommandPalette** (`src/components/CommandPalette.tsx`)

1. Update the actions array: `a:home` runs `navigate('/dashboard')`; add `{ id: 'a:projects', type: 'action', title: 'Projects', icon: <FolderOpen size={16} />, run: () => navigate('/projects') }` (import `FolderOpen` from lucide); `a:pdf` → `navigate('/tools/pdf')`; `a:sheet` → `navigate('/tools/sheets')`.
2. Add the clock toggle action (imports: `getMyTimeEntries, clockIn, clockOut` from `../utils/store`, `useToast` from `./Toast` if not already imported):

```tsx
    {
      id: 'a:clock', type: 'action', title: 'Clock in / out', icon: <Clock size={16} />,
      run: async () => {
        try {
          const entries = await getMyTimeEntries();
          const open = entries.find(e => e.clockOut === null);
          if (open) { await clockOut(); toast('Clocked out', { type: 'success' }); }
          else { await clockIn(); toast('Clocked in', { type: 'success' }); }
        } catch { toast('Clock action failed', { type: 'error' }); }
      },
    },
```

(`Clock` is in the lucide import already or add it. If `useToast` isn't already used in the component, call it at the top: `const { toast } = useToast();` and add it to the actions `useMemo` deps.)

- [ ] **Step 6: Verify and commit**

Run: `npm run lint && npm test`
Expected: clean / green (incl. updated Sidebar tests).

Boot check: `/` redirects to `/dashboard`; sidebar shows Dashboard/Projects/Checklists/Time + Tools; old `/pdf-editor` URL redirects; opening a printout in the PDF editor from a project still works (state survives direct navigation); ⌘K → "Clock in / out" toggles with toasts (verify on `/time` afterwards).

```bash
git add src/App.tsx src/components/shell/Sidebar.tsx src/components/shell/Sidebar.test.tsx src/components/CommandPalette.tsx src/pages/Login.tsx src/pages/CanvasView.tsx src/pages/ProjectView.tsx src/pages/NewProject.tsx src/pages/ServerSettings.tsx src/pages/ChecklistEditor.tsx
git commit -m "feat: align company routes — /dashboard, /projects, /tools/*"
```

---

### Task 11: Full Verification + Push

**Files:** none (verification only)

- [ ] **Step 1: Full automated pass**

Run: `npm run lint && npm test && npm run build`
Expected: zero type errors, all suites green, build succeeds.

- [ ] **Step 2: Fresh-install boot + smoke** (`STORAGE_PATH=$(mktemp -d) npm run dev`)

- [ ] Migrations 1-6 apply on an empty dir; login works
- [ ] `/` → `/dashboard`: four cards render (empty states on fresh data)
- [ ] Create a project (with a bid due date) → appears under Estimating with a stage pill; Dashboard shows the deadline; activity shows "Project created"
- [ ] Open the project → stage dropdown next to the name; set to Awarded → toast; `/projects` shows it under Active; activity row appears
- [ ] Card actions: rename, archive (moves to Archived view), restore, delete (type-delete)
- [ ] Two-browser-tab stale patch: change stage in tab A, then rename the same project from tab B's `/projects` (stale version) → "changed elsewhere — refreshing" toast, list refetches
- [ ] Settings → Email: SMTP only, no IMAP section; Storage tab has no bids row
- [ ] `/pdf-editor` redirects to `/tools/pdf`; printout → PDF editor flow from a project works; checklist PDF export works
- [ ] ⌘K: Dashboard/Projects/editors navigate; Clock in / out round-trips (check `/time`)
- [ ] Search (⌘K): projects/pages/takeoffs return; no bid results, no errors in server log

- [ ] **Step 3: 🛑 Tell Nathan before he pulls**

Migration 6 **drops the `bids` and `email_accounts` tables**. On his testing instance, the next container boot after pulling will apply it (with an automatic DB backup to `backups/` first). Per his standing protocol, tell him explicitly before/when pushing: any bid-inbox data on the testing instance is about to be removed by design (spec §2 "Removed entirely"), recoverable only from the backup file. Do not run anything against his real data yourself.

- [ ] **Step 4: Push**

```bash
git push origin testing
```

---

## Plan Self-Review Notes (already applied)

1. **Spec coverage (§2 decisions, §4.1, §9 Phase 3 — 3a slice):** bid inbox/IMAP removed entirely ✅ (Tasks 1, 6, 7 — server, migration, UI, deps) · email send-only kept ✅ (SMTP + project send-proposal untouched, pinned in Task 1) · lifecycle stages real ✅ (Tasks 3, 8 — PATCH + stage dropdown; statuses match spec §2 exactly) · pipeline-grouped Projects with stage pills + filter/search + archive + templates + New Project ✅ (Task 6) · Dashboard with deadlines / project health / activity / my-hours ✅ (Tasks 4, 9) · granular writes begin ✅ (PATCH; spec §3.3 rule 1) · company nav at `/dashboard`, `/projects`, `/tools/*` ✅ (Task 10) · ⌘K "clock in" action ✅ (Task 10).
2. **Deliberate deviations/deferrals (do not "fix"):** project URLs stay `/project/:id` (not `/p/:id`) — churn without value; section routes come in 3b under the same prefix · standalone Checklists tab stays until Phase 4 delivers project checklists (spec §4.3 removal would orphan the feature) · role-gating of pricing/nav is deferred (3b/Phase 4) · ProjectsList's table view / 6-field sort / duplicate Users tab dropped (Settings → User Management is the canonical one) · "new issue" ⌘K action is Phase 4 (issues don't exist yet) · `deriveStatus` re-derivation edge (Context #5) accepted.
3. **Type consistency:** `PROJECT_STATUSES` (server) matches `PROJECT_STATUS_META` keys (client, Phase 2) — 8 values · `ProjectSummary` fields match `listProjectSummaries` output incl. `pageIds` · `patchProject` client signature `{version, name?, status?, archived?, contractor?, address?, bidDueDate?}` matches server `ALLOWED` list · `getActivity` unwraps `{items}` · `groupSummaries` exported for tests; group ids `estimating/active/closed` used consistently · `ProjectStageControl` props `(projectId, version, status, onChanged)` match the ProjectView insertion and tests.
4. **Ordering constraints encoded:** migration 6 + routes.ts bid-block removal land in one task (search would crash on the dropped table) · `/api/projects/summary` registered before `/api/projects/:id` · ProjectsPage (Task 6) lands before store/type removals (Task 7) so ProjectsList's imports never dangle · Dashboard route (Task 9) precedes the index redirect (Task 10).
5. **Placeholder scan:** all code steps carry complete code; removal steps carry exact anchors + verification greps; no TBDs.
