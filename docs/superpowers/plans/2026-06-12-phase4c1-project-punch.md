# Phase 4c-1 — Project Punch & Checklists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-scoped, area-grouped **Punch & Checklists** section: punch items grouped by area with per-area and overall progress, before/during/after photos, and a printable PDF report.

**Architecture:** Mirrors the just-shipped Issues module exactly. New migration 10 adds `punch_items` + `punch_photos` tables (project-scoped, no numbering — punch items aren't numbered like issues). A `server/punchStore.ts` provides version-checked CRUD + photo links + progress counts. Auth-only routes (NOT admin-gated — field use, like Issues). Project summary gains ungated `punchDone`/`punchTotal`. A new `ProjectPunch` section renders area-grouped items with progress bars; `PunchItemEditor` handles edit + done toggle + three photo galleries (before/during/after); `punchPdf.ts` builds a printable report reusing the billing accent helper. This plan is module 1 of two for Phase 4c (module 2 = the standalone collaborative Task List, a separate plan).

**Tech Stack:** Express 4 + better-sqlite3 (synchronous, transactions), React 19 + react-router 7 (nested project routes), Tailwind 4 tokens + Phase 2 ui library, jsPDF (client PDF), Vitest + Supertest.

**Pattern references (read these — the new code is a near-clone):**
- Store: `server/issueStore.ts` (full file — copy its shape)
- Routes: `server/routes.ts:255-303` (the Issues block, `issueErr` mapper, activity logging)
- Migration: `server/migrationList.ts:337-360` (migration 9 `issues`)
- Cascade + summary: `server/projectStore.ts:299-300` (cascade) and `:278` (`openIssueCount` on summary)
- Client store: `src/utils/store.ts:771-828` (Issue types + helpers)
- Status pill pattern: `src/components/ui/IssueStatusPill.tsx`
- Section + editor + pdf: `src/pages/project/ProjectIssues.tsx`, `src/pages/project/issues/IssueEditor.tsx`, `src/pages/project/issues/issuePdf.ts`
- Nav + route + overview: `src/components/shell/Sidebar.tsx` (PROJECT_NAV ~37-52, filter ~183), `src/App.tsx` (project route tree ~108-120), `src/pages/project/ProjectOverview.tsx:102` (openIssueCount stat)

**Key differences from Issues (do NOT blindly copy these bits):**
- **No per-project numbering.** Punch items have no `number`/`ISS-###`. Ordering is by `area`, then `sortOrder`, then `createdAt`.
- **Status is a boolean `done`, not a 3-state lifecycle.** No `sent`/email. PATCH toggles `done`.
- **Photos have a `stage`** (`before` | `during` | `after`). `punch_photos` carries a `stage` column; `addPunchPhoto` takes a stage.
- **No SMTP send.** The report is **Download-only** (printable PDF). (Spec §4.2: "printable report".)
- **Summary exposes a progress pair** `punchDone`/`punchTotal` (both ungated — all roles see punch progress, like `openIssueCount`).

---

## File Structure

**Create:**
- `server/punchStore.ts` — punch CRUD, photo links, progress counts
- `server/punchStore.test.ts` — unit tests for the store
- `src/components/ui/ProgressBar.tsx` — reusable progress bar (overall + per-area)
- `src/components/ui/ProgressBar.test.tsx`
- `src/pages/project/ProjectPunch.tsx` — area-grouped section page
- `src/pages/project/punch/PunchItemEditor.tsx` — edit modal (description, done, photo galleries)
- `src/pages/project/punch/punchPdf.ts` — printable PDF builder
- `src/pages/project/punch/punchPdf.test.ts` — unit test for `punchHeading`/grouping helper

**Modify:**
- `server/migrationList.ts` — append migration 10 `punch`
- `server/migrationList.test.ts` — assert punch tables exist
- `server/routes.ts` — add the punch routes block (after the Issues block, ~line 303)
- `server/projectStore.ts` — cascade delete punch rows; add `punchDone`/`punchTotal` to summaries
- `server/routes.test.ts` — punch route integration tests (incl. non-admin access + summary)
- `src/utils/store.ts` — PunchItem/PunchPhoto types + client helpers; `ProjectSummary` gains `punchDone`/`punchTotal`
- `src/App.tsx` — add `{ path: 'punch', element: <ProjectPunch /> }`
- `src/components/shell/Sidebar.tsx` — add "Punch & Checklists" to PROJECT_NAV (between Documents and Issues, NOT adminOnly)
- `src/pages/project/ProjectOverview.tsx` — add an ungated punch-progress stat

---

## Task 1: Migration 10 — punch tables + cascade

**Files:**
- Modify: `server/migrationList.ts` (append after migration 9, ~line 360)
- Modify: `server/migrationList.test.ts`
- Modify: `server/projectStore.ts` (deleteProject cascade ~line 299)

- [ ] **Step 1: Write the failing migration test**

In `server/migrationList.test.ts`, add (mirror the existing table-existence checks):

```ts
it('migration 10 creates punch tables', () => {
  const db = freshMigratedDb(); // however the suite builds a fully-migrated db
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
  expect(names).toContain('punch_items');
  expect(names).toContain('punch_photos');
});
```

If the suite has no `freshMigratedDb` helper, follow the exact construction the migration-9/`issues` test uses in this file.

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run server/migrationList.test.ts`
Expected: FAIL (tables don't exist / migration 10 missing).

- [ ] **Step 3: Append migration 10**

In `server/migrationList.ts`, after the migration 9 object (closes ~line 360), add:

```ts
  {
    version: 10,
    name: 'punch',
    up({ db }) {
      // Punch & Checklists (spec §4.2): project-scoped, area-grouped punch items
      // with per-area progress and before/during/after photos. Field-created by any
      // user (not admin-gated, like issues). No numbering, no email — printable only.
      // Photos are existing files rows linked via punch_photos with a stage.
      db.exec(`
        CREATE TABLE punch_items (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          area TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          done INTEGER NOT NULL DEFAULT 0,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_punch_items_projectId ON punch_items (projectId);

        CREATE TABLE punch_photos (
          id TEXT PRIMARY KEY,
          punchItemId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          stage TEXT NOT NULL DEFAULT 'before',
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_punch_photos_itemId ON punch_photos (punchItemId);
      `);
    },
  },
```

- [ ] **Step 4: Run migration test, expect PASS**

Run: `npx vitest run server/migrationList.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend deleteProject cascade**

In `server/projectStore.ts`, find the issue-photos/issues cascade (~line 299-300). Immediately before the `DELETE FROM files` step (and before/alongside the issues lines), add punch cleanup:

```ts
db.prepare('DELETE FROM punch_photos WHERE punchItemId IN (SELECT id FROM punch_items WHERE projectId = ?)').run(id);
db.prepare('DELETE FROM punch_items WHERE projectId = ?').run(id);
```

(Place it next to the analogous `issue_photos`/`issues` deletes so all child rows are gone before files are swept.)

- [ ] **Step 6: Commit**

```bash
git add server/migrationList.ts server/migrationList.test.ts server/projectStore.ts
git commit -m "feat: migration 10 punch tables + delete cascade"
```

---

## Task 2: punchStore — CRUD (create/get/list/save)

**Files:**
- Create: `server/punchStore.ts`
- Create: `server/punchStore.test.ts`

- [ ] **Step 1: Write failing tests**

`server/punchStore.test.ts` (mirror `issueStore`'s test setup — build an in-memory migrated db, insert a project row):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrationList'; // use the same bootstrap the issue store tests use
import { createPunchItem, getPunchItem, listPunchItems, savePunchItem, ValidationError, ConflictError, NotFoundError } from './punchStore';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db); // match however issueStore.test.ts migrates
  db.prepare("INSERT INTO projects (id, name, createdAt, version) VALUES ('p1','P1',1,1)").run(); // match real projects columns
});

it('creates and reads a punch item', () => {
  const { id } = createPunchItem(db, 'p1', { area: 'Kitchen', description: 'Touch up paint' });
  const item = getPunchItem(db, id);
  expect(item.area).toBe('Kitchen');
  expect(item.description).toBe('Touch up paint');
  expect(item.done).toBe(0);
  expect(item.version).toBe(1);
  expect(item.photos).toEqual([]);
});

it('rejects an empty description', () => {
  expect(() => createPunchItem(db, 'p1', { area: 'Kitchen', description: '  ' })).toThrow(ValidationError);
});

it('rejects unknown project', () => {
  expect(() => createPunchItem(db, 'nope', { area: 'A', description: 'x' })).toThrow(NotFoundError);
});

it('lists items grouped by area then sortOrder', () => {
  createPunchItem(db, 'p1', { area: 'Bath', description: 'b1' });
  createPunchItem(db, 'p1', { area: 'Attic', description: 'a1' });
  createPunchItem(db, 'p1', { area: 'Attic', description: 'a2' });
  const list = listPunchItems(db, 'p1');
  expect(list.map((i: any) => i.description)).toEqual(['a1', 'a2', 'b1']); // area ASC, then sortOrder
  expect(list[0].photoCount).toBe(0);
});

it('saves with version check and bumps version', () => {
  const { id } = createPunchItem(db, 'p1', { area: 'A', description: 'x' });
  const r = savePunchItem(db, id, { area: 'A2', description: 'y', version: 1 });
  expect(r.version).toBe(2);
  expect(getPunchItem(db, id).area).toBe('A2');
});

it('throws ConflictError on stale version', () => {
  const { id } = createPunchItem(db, 'p1', { area: 'A', description: 'x' });
  expect(() => savePunchItem(db, id, { area: 'A', description: 'y', version: 99 })).toThrow(ConflictError);
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run server/punchStore.test.ts` (module not found).

- [ ] **Step 3: Implement `server/punchStore.ts`**

```ts
// server/punchStore.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export const PUNCH_STAGES = ['before', 'during', 'after'] as const;

function requireProject(db: Database.Database, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('Project not found');
}

function photoCount(db: Database.Database, itemId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM punch_photos WHERE punchItemId = ?').get(itemId) as any).c;
}

interface PunchInput { area?: string; description?: string; }

export function getPunchItem(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM punch_items WHERE id = ?').get(id) as any;
  if (!row) return null;
  const photos = db.prepare('SELECT id, fileId, stage, sortOrder FROM punch_photos WHERE punchItemId = ? ORDER BY stage, sortOrder, createdAt').all(id);
  return { ...row, photos };
}

export function listPunchItems(db: Database.Database, projectId: string): any[] {
  const rows = db.prepare('SELECT * FROM punch_items WHERE projectId = ? ORDER BY area ASC, sortOrder ASC, createdAt ASC, rowid ASC').all(projectId) as any[];
  return rows.map(r => ({ ...r, photoCount: photoCount(db, r.id) }));
}

export function createPunchItem(db: Database.Database, projectId: string, input: PunchInput): { id: string } {
  requireProject(db, projectId);
  if (typeof input.description !== 'string' || !input.description.trim()) throw new ValidationError('Punch item description is required');
  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM punch_items WHERE projectId = ?').get(projectId) as any).m;
    db.prepare('INSERT INTO punch_items (id, projectId, area, description, done, sortOrder, version, createdAt) VALUES (?, ?, ?, ?, 0, ?, 1, ?)')
      .run(id, projectId, (input.area ?? '').trim(), input.description!.trim(), max + 1, Date.now());
  });
  tx();
  return { id };
}

export function savePunchItem(db: Database.Database, id: string, input: PunchInput & { version?: number }): { version: number } {
  if (typeof input.description !== 'string' || !input.description.trim()) throw new ValidationError('Punch item description is required');
  if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new ValidationError('Missing or invalid version — reload the item');
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM punch_items WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('Punch item not found');
    if (row.version !== input.version) throw new ConflictError(`Punch item changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;
    db.prepare('UPDATE punch_items SET area = ?, description = ?, version = ? WHERE id = ?')
      .run((input.area ?? '').trim(), input.description!.trim(), newVersion, id);
  });
  tx();
  return { version: newVersion };
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run server/punchStore.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add server/punchStore.ts server/punchStore.test.ts
git commit -m "feat: punch store — area-ordered CRUD with version checks"
```

---

## Task 3: punchStore — done toggle, photos (by stage), progress

**Files:**
- Modify: `server/punchStore.ts`
- Modify: `server/punchStore.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
import { setPunchDone, deletePunchItem, addPunchPhoto, removePunchPhoto, punchProgress } from './punchStore';

it('toggles done and bumps version', () => {
  const { id } = createPunchItem(db, 'p1', { area: 'A', description: 'x' });
  const r = setPunchDone(db, id, true);
  expect(r.done).toBe(true);
  const item = getPunchItem(db, id);
  expect(item.done).toBe(1);
  expect(item.version).toBe(2);
});

it('adds a staged photo idempotently', () => {
  const { id } = createPunchItem(db, 'p1', { area: 'A', description: 'x' });
  addPunchPhoto(db, id, 'f1', 'before');
  addPunchPhoto(db, id, 'f1', 'before'); // idempotent (same item+file+stage)
  const item = getPunchItem(db, id);
  expect(item.photos.length).toBe(1);
  expect(item.photos[0].stage).toBe('before');
});

it('rejects an invalid photo stage', () => {
  const { id } = createPunchItem(db, 'p1', { area: 'A', description: 'x' });
  expect(() => addPunchPhoto(db, id, 'f1', 'sideways')).toThrow(ValidationError);
});

it('removes a photo', () => {
  const { id } = createPunchItem(db, 'p1', { area: 'A', description: 'x' });
  addPunchPhoto(db, id, 'f1', 'after');
  removePunchPhoto(db, id, 'f1');
  expect(getPunchItem(db, id).photos.length).toBe(0);
});

it('deletes an item and its photos', () => {
  const { id } = createPunchItem(db, 'p1', { area: 'A', description: 'x' });
  addPunchPhoto(db, id, 'f1', 'before');
  deletePunchItem(db, id);
  expect(getPunchItem(db, id)).toBeNull();
  expect((db.prepare('SELECT COUNT(*) c FROM punch_photos WHERE punchItemId = ?').get(id) as any).c).toBe(0);
});

it('counts progress', () => {
  const a = createPunchItem(db, 'p1', { area: 'A', description: '1' });
  createPunchItem(db, 'p1', { area: 'A', description: '2' });
  setPunchDone(db, a.id, true);
  expect(punchProgress(db, 'p1')).toEqual({ done: 1, total: 2 });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement (append to `server/punchStore.ts`)**

```ts
export function setPunchDone(db: Database.Database, id: string, done: boolean): { done: boolean } {
  const row = db.prepare('SELECT id FROM punch_items WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('Punch item not found');
  db.prepare('UPDATE punch_items SET done = ?, version = version + 1 WHERE id = ?').run(done ? 1 : 0, id);
  return { done };
}

export function deletePunchItem(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM punch_photos WHERE punchItemId = ?').run(id);
    db.prepare('DELETE FROM punch_items WHERE id = ?').run(id);
  });
  tx();
}

export function addPunchPhoto(db: Database.Database, itemId: string, fileId: string, stage: string): void {
  if (!db.prepare('SELECT id FROM punch_items WHERE id = ?').get(itemId)) throw new NotFoundError('Punch item not found');
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  if (!(PUNCH_STAGES as readonly string[]).includes(stage)) throw new ValidationError(`Invalid photo stage: ${stage}`);
  const exists = db.prepare('SELECT id FROM punch_photos WHERE punchItemId = ? AND fileId = ? AND stage = ?').get(itemId, fileId, stage);
  if (exists) return; // idempotent
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM punch_photos WHERE punchItemId = ?').get(itemId) as any).m;
  db.prepare('INSERT INTO punch_photos (id, punchItemId, fileId, stage, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), itemId, fileId, stage, max + 1, Date.now());
}

export function removePunchPhoto(db: Database.Database, itemId: string, fileId: string): void {
  db.prepare('DELETE FROM punch_photos WHERE punchItemId = ? AND fileId = ?').run(itemId, fileId);
}

export function punchProgress(db: Database.Database, projectId: string): { done: number; total: number } {
  const total = (db.prepare('SELECT COUNT(*) c FROM punch_items WHERE projectId = ?').get(projectId) as any).c;
  const done = (db.prepare('SELECT COUNT(*) c FROM punch_items WHERE projectId = ? AND done = 1').get(projectId) as any).c;
  return { done, total };
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add server/punchStore.ts server/punchStore.test.ts
git commit -m "feat: punch store — done toggle, staged photos, progress counts"
```

---

## Task 4: Punch routes (auth-only) + activity logging

**Files:**
- Modify: `server/routes.ts` (add block after the Issues block, ~line 303)
- Modify: `server/routes.test.ts`

- [ ] **Step 1: Add failing integration tests** in `server/routes.test.ts` (mirror the issue route tests):

```ts
it('punch is NOT admin-gated — a normal user can create and list', async () => {
  // log in as a non-admin 'user' token (see how issue tests obtain one)
  const create = await request(app).post('/api/projects/p1/punch').set(userAuth).send({ area: 'Kitchen', description: 'Caulk gaps' });
  expect(create.status).toBe(200);
  const list = await request(app).get('/api/projects/p1/punch').set(userAuth);
  expect(list.status).toBe(200);
  expect(list.body.length).toBe(1);
});

it('PUT punch returns 409 on stale version', async () => {
  const { body } = await request(app).post('/api/projects/p1/punch').set(adminAuth).send({ area: 'A', description: 'x' });
  const stale = await request(app).put(`/api/punch/${body.id}`).set(adminAuth).send({ area: 'A', description: 'y', version: 99 });
  expect(stale.status).toBe(409);
  expect(stale.body.code).toBe('version_conflict');
});

it('PATCH toggles done', async () => {
  const { body } = await request(app).post('/api/projects/p1/punch').set(adminAuth).send({ area: 'A', description: 'x' });
  const r = await request(app).patch(`/api/punch/${body.id}`).set(adminAuth).send({ done: true });
  expect(r.status).toBe(200);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Wire imports + add the routes block**

At the top of `server/routes.ts`, import the punch store (alias the shared error classes to avoid collision with the issue aliases — follow how `IssueNotFoundError` etc. are aliased):

```ts
import {
  getPunchItem, listPunchItems, createPunchItem, savePunchItem,
  setPunchDone, deletePunchItem, addPunchPhoto, removePunchPhoto,
  ValidationError as PunchValidationError,
  ConflictError as PunchConflictError,
  NotFoundError as PunchNotFoundError,
} from './punchStore';
```

After the Issues routes block (closes ~line 303), add:

```ts
  // ── Punch & Checklists (any authenticated user — field-created, spec §4.2) ──
  const punchErr = (e: unknown, res: express.Response) => {
    if (e instanceof PunchNotFoundError) return res.status(404).json({ error: e.message });
    if (e instanceof PunchConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
    if (e instanceof PunchValidationError) return res.status(400).json({ error: e.message });
    console.error('Punch error:', e);
    return res.status(500).json({ error: 'Punch operation failed' });
  };

  app.get('/api/projects/:id/punch', authenticateToken, (req, res) => {
    try { res.json(listPunchItems(db, req.params.id)); } catch (e) { punchErr(e, res); }
  });
  app.post('/api/projects/:id/punch', authenticateToken, (req, res) => {
    try {
      const r = createPunchItem(db, req.params.id, req.body);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'punch_created', message: `Punch item added${req.body?.area ? ` (${req.body.area})` : ''}: ${req.body?.description ?? ''}` });
      res.json(r);
    } catch (e) { punchErr(e, res); }
  });
  app.get('/api/punch/:id', authenticateToken, (req, res) => {
    try { const it = getPunchItem(db, req.params.id); if (!it) return res.status(404).json({ error: 'Punch item not found' }); res.json(it); } catch (e) { punchErr(e, res); }
  });
  app.put('/api/punch/:id', authenticateToken, (req, res) => {
    try { res.json({ success: true, ...savePunchItem(db, req.params.id, req.body) }); } catch (e) { punchErr(e, res); }
  });
  app.patch('/api/punch/:id', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.done !== 'boolean') return res.status(400).json({ error: 'done (boolean) is required' });
      const before = getPunchItem(db, req.params.id); // read once, before the change
      const r = setPunchDone(db, req.params.id, req.body.done);
      if (req.body.done && before) {
        logActivity(db, { projectId: before.projectId, userId: (req as any).user?.id, type: 'punch_done', message: `Punch item done${before.area ? ` (${before.area})` : ''}: ${before.description ?? ''}` });
      }
      res.json({ success: true, ...r });
    } catch (e) { punchErr(e, res); }
  });
  app.delete('/api/punch/:id', authenticateToken, (req, res) => {
    try { deletePunchItem(db, req.params.id); res.json({ success: true }); } catch (e) { punchErr(e, res); }
  });
  app.post('/api/punch/:id/photos', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      addPunchPhoto(db, req.params.id, req.body.fileId, req.body?.stage ?? 'before');
      res.json({ success: true });
    } catch (e) { punchErr(e, res); }
  });
  app.delete('/api/punch/:id/photos/:fileId', authenticateToken, (req, res) => {
    try { removePunchPhoto(db, req.params.id, req.params.fileId); res.json({ success: true }); } catch (e) { punchErr(e, res); }
  });
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run server/routes.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/routes.test.ts
git commit -m "feat: punch routes (auth) with done + photo endpoints and activity"
```

---

## Task 5: Surface punch progress on project summary + overview

**Files:**
- Modify: `server/projectStore.ts` (listProjectSummaries `base` object ~line 278; getProjectSummary single)
- Modify: `server/routes.test.ts`

- [ ] **Step 1: Add failing test** — punch progress appears on summary for ANY role:

```ts
it('summary exposes punchDone/punchTotal to non-admins (ungated)', async () => {
  const { body } = await request(app).post('/api/projects/p1/punch').set(adminAuth).send({ area: 'A', description: 'x' });
  await request(app).patch(`/api/punch/${body.id}`).set(adminAuth).send({ done: true });
  const sum = await request(app).get('/api/projects/p1/summary').set(userAuth); // non-admin
  expect(sum.body.punchDone).toBe(1);
  expect(sum.body.punchTotal).toBe(1);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Wire it in `server/projectStore.ts`**

Import `punchProgress` at the top alongside `countOpenIssues`. In `listProjectSummaries`, where the ungated `base` object is built (the same object that carries `openIssueCount`, ~line 278), add both fields:

```ts
const pp = punchProgress(db, r.id);
// ...inside the base object:
openIssueCount: countOpenIssues(db, r.id),
punchDone: pp.done,
punchTotal: pp.total,
```

Apply the identical addition wherever the single-project summary is assembled (so `GET /api/projects/:id/summary` returns them too). **Both fields are ungated** — placed in `base`, not behind the `includeBilling`/admin gate.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add server/projectStore.ts server/routes.test.ts
git commit -m "feat: surface punch progress (done/total) on project summary, ungated"
```

---

## Task 6: Client store — punch types + helpers

**Files:**
- Modify: `src/utils/store.ts` (add near the Issue block ~771-828; extend `ProjectSummary`)

- [ ] **Step 1: Extend `ProjectSummary`**

Add two **required** numeric fields to the `ProjectSummary` interface (mirror how `openIssueCount` is declared):

```ts
punchDone: number;
punchTotal: number;
```

- [ ] **Step 2: Add types + helpers** (mirror the Issue helpers exactly — same fetch wrapper, same 409→ConflictError mapping the issue helpers use):

```ts
export interface PunchPhoto { id: string; fileId: string; stage: string; sortOrder: number; }
export interface PunchItem {
  id: string; projectId: string; area: string; description: string;
  done: number; sortOrder: number; version: number; createdAt: number;
  photos: PunchPhoto[];
}
export interface PunchListItem {
  id: string; projectId: string; area: string; description: string;
  done: number; sortOrder: number; version: number; createdAt: number;
  photoCount: number;
}

export const getPunchItems = async (projectId: string): Promise<PunchListItem[]> =>
  apiGet(`/api/projects/${projectId}/punch`);             // use the same helper getIssues uses
export const getPunchItem = async (id: string): Promise<PunchItem> =>
  apiGet(`/api/punch/${id}`);
export const createPunchItem = async (projectId: string, input: { area: string; description: string }): Promise<{ id: string }> =>
  apiPost(`/api/projects/${projectId}/punch`, input);
export const savePunchItem = async (id: string, item: PunchItem): Promise<{ version: number }> =>
  apiPut(`/api/punch/${id}`, { area: item.area, description: item.description, version: item.version }); // map 409→ConflictError as saveIssue does
export const setPunchDone = async (id: string, done: boolean): Promise<void> =>
  apiPatch(`/api/punch/${id}`, { done });
export const deletePunchItem = async (id: string): Promise<void> =>
  apiDelete(`/api/punch/${id}`);
export const addPunchPhoto = async (itemId: string, fileId: string, stage: string): Promise<void> =>
  apiPost(`/api/punch/${itemId}/photos`, { fileId, stage });
export const removePunchPhoto = async (itemId: string, fileId: string): Promise<void> =>
  apiDelete(`/api/punch/${itemId}/photos/${fileId}`);
```

**Important:** use the exact request helpers and the exact 409→`ConflictError` mechanism the Issue helpers use (read `saveIssue` in this file — match it; `savePunchItem` must throw `ConflictError` on 409 so the editor can detect a stale save).

- [ ] **Step 3: Typecheck** — `npx tsc --noEmit`. Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/utils/store.ts
git commit -m "feat: client store — punch item types and helpers; summary punch fields"
```

---

## Task 7: ProgressBar ui component

**Files:**
- Create: `src/components/ui/ProgressBar.tsx`
- Create: `src/components/ui/ProgressBar.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { ProgressBar } from './ProgressBar';

it('shows done/total and a percent label', () => {
  render(<ProgressBar done={3} total={4} />);
  expect(screen.getByText('3 / 4')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75');
});

it('handles zero total without NaN', () => {
  render(<ProgressBar done={0} total={0} />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/components/ui/ProgressBar.test.tsx`.

- [ ] **Step 3: Implement** (use Phase 2 design tokens — `bg-surface-3`, `bg-accent-600`, `text-ink-faint`; match the rounded/height conventions of existing ui components):

```tsx
import React from 'react';

export const ProgressBar: React.FC<{ done: number; total: number; className?: string }> = ({ done, total, className = '' }) => {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-full rounded-full bg-accent-600 transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-ink-faint">{done} / {total}</span>
    </div>
  );
};
```

(If the project's token class names differ, match the names used in existing `src/components/ui/*` files.)

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/ProgressBar.tsx src/components/ui/ProgressBar.test.tsx
git commit -m "feat: ProgressBar ui component"
```

---

## Task 8: ProjectPunch section — area-grouped list, progress, create

**Files:**
- Create: `src/pages/project/ProjectPunch.tsx`

Read `src/pages/project/ProjectIssues.tsx` first and mirror its scaffolding (uses `useProjectOutlet()`/`useParams` for projectId, loads on mount, create form, table, opens an editor modal keyed `id:version`).

- [ ] **Step 1: Implement the section**

Requirements (no separate unit test — covered by the Task 12 build + smoke; keep logic thin):
- Load via `getPunchItems(projectId)` on mount and after any editor save (re-fetch).
- **Group items by `area`** (empty area → an "Unassigned" group). Within a group, keep server order.
- Render an **overall `<ProgressBar done total />`** at the top (compute from the loaded list: `done = items.filter(i => i.done).length`).
- For each area group: a heading with the area name + a per-area `<ProgressBar>` (done/total within that area), then the group's items.
- Each item row: a **done checkbox** (calls `setPunchDone(id, !done)` then re-fetches — optimistic or refetch, match how issue status updates are applied), the description, area (omit inside group), and a photo-count badge. Clicking the row (not the checkbox) opens `PunchItemEditor`.
- **Create form:** an `area` text input (with a `<datalist>` of existing area names for quick reuse) + a `description` input + Add button → `createPunchItem(projectId, { area, description })` then re-fetch. Disable Add when description is blank.
- A **"Download report"** button in the header → calls the punch PDF (wire in Task 10; leave a button that imports `buildPunchPdf` once it exists, or add the button in Task 10).
- Open editor with `key={`${editing.id}:${editing.version}`}` so it re-seeds after version-bumping saves (mirror `ProjectIssues.tsx:763`).
- Export a helper if useful, but **no numbering** (punch items are not numbered).

- [ ] **Step 2: Typecheck + lint** — `npx tsc --noEmit && npm run lint`. (The editor import will be unresolved until Task 9 — either stub the import or implement Task 9 first; to keep commits green, create a minimal `PunchItemEditor` stub now and flesh it out in Task 9, OR reorder so Task 9's file exists. Prefer: create the stub file in this task.)

- [ ] **Step 3: Commit**

```bash
git add src/pages/project/ProjectPunch.tsx src/pages/project/punch/PunchItemEditor.tsx
git commit -m "feat: project punch section — area-grouped list, progress, create"
```

---

## Task 9: PunchItemEditor — edit, done, staged photo galleries

**Files:**
- Create/replace: `src/pages/project/punch/PunchItemEditor.tsx`

Read `src/pages/project/issues/IssueEditor.tsx` first and mirror it (Modal, seed-from-props-once, version-checked Save, `ConflictError` handling by `e.name === 'ConflictError'`, photo upload via `uploadProjectFile(projectId, file, 'punch')` then `addPunchPhoto`, `getImageUrl` thumbnails, unsaved-edits guard before the done-toggle).

- [ ] **Step 1: Implement**

Props: `{ item: PunchItem; projectId: string; onClose: () => void; onSaved: () => void }`.
- Seed local `area`, `description` from `item` once. Track `dirty` (changed vs. seeded).
- **Save** → `savePunchItem(item.id, { ...item, area, description })`; on success call `onSaved()` (which re-fetches and remounts via the key). On `ConflictError` (`e.name === 'ConflictError'`) toast "This item changed elsewhere — reload."
- **Done toggle:** a checkbox/button. **Guard against unsaved edits** — if `dirty`, toast "Save your changes first" and bail (mirror `IssueEditor` status-cycle guard). Otherwise `setPunchDone(item.id, !item.done)` then `onSaved()`.
- **Three photo galleries**, one per stage (`before` / `during` / `after`). Each:
  - A labeled section ("Before" / "During" / "After").
  - `<input type="file" accept="image/*" capture="environment" multiple>` — on change, for each file: `uploadProjectFile(projectId, file, 'punch')` → `addPunchPhoto(item.id, fileId, stage)`; then `onSaved()` to refresh. Surface an aggregate "Uploaded X of Y" toast; swallow individual failures (match IssueEditor).
  - Thumbnails of that stage's photos via `getImageUrl(fileId)`; each with a remove (×) → `removePunchPhoto(item.id, fileId)` then `onSaved()`.
  - Filter `item.photos` by `stage` for each gallery.
- **Download PDF** button → builds the project punch report (Task 10's `buildPunchPdf`) — same as the section's download; acceptable to keep download only on the section header and omit here. (Decide: keep it on the section header only to avoid duplication.)

- [ ] **Step 2: Typecheck + lint** — `npx tsc --noEmit && npm run lint`.

- [ ] **Step 3: Commit**

```bash
git add src/pages/project/punch/PunchItemEditor.tsx
git commit -m "feat: punch item editor — version-checked edit, done guard, staged photos"
```

---

## Task 10: Punch PDF — printable area-grouped report

**Files:**
- Create: `src/pages/project/punch/punchPdf.ts`
- Create: `src/pages/project/punch/punchPdf.test.ts`
- Modify: `src/pages/project/ProjectPunch.tsx` (wire the "Download report" button)

Read `src/pages/project/issues/issuePdf.ts` first. Reuse `resolveAccentRgb` (import from `../billing/invoicePdf`) and the company/logo header approach.

- [ ] **Step 1: Write a failing unit test for the pure helper**

```ts
import { describe, it, expect } from 'vitest';
import { groupByArea } from './punchPdf';

it('groups items by area, Unassigned last', () => {
  const groups = groupByArea([
    { area: 'Bath', description: 'b', done: 0 } as any,
    { area: '', description: 'u', done: 1 } as any,
    { area: 'Bath', description: 'b2', done: 1 } as any,
  ]);
  expect(groups.map(g => g.area)).toEqual(['Bath', 'Unassigned']);
  expect(groups[0].items.length).toBe(2);
  expect(groups[0].done).toBe(1);
  expect(groups[0].total).toBe(2);
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/pages/project/punch/punchPdf.test.ts`.

- [ ] **Step 3: Implement `punchPdf.ts`**

```ts
import { jsPDF } from 'jspdf';
import { resolveAccentRgb } from '../billing/invoicePdf';

export interface PunchReportItem { area: string; description: string; done: number | boolean; }
export interface PunchAreaGroup { area: string; items: PunchReportItem[]; done: number; total: number; }

export function groupByArea(items: PunchReportItem[]): PunchAreaGroup[] {
  const map = new Map<string, PunchReportItem[]>();
  for (const it of items) {
    const key = (it.area ?? '').trim() || ' '; // sentinel for Unassigned, sorted last
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(it);
  }
  return [...map.keys()].sort().map(key => {
    const list = map.get(key)!;
    return {
      area: key === ' ' ? 'Unassigned' : key,
      items: list,
      done: list.filter(i => !!i.done).length,
      total: list.length,
    };
  });
}

export interface PunchPdfContext {
  items: PunchReportItem[];
  projectName: string;
  company?: { name?: string; logoDataUrl?: string };
  photoDataUrls?: Record<string, string>; // fileId -> dataUrl (optional; pass {} if not embedding photos)
  accentRgb?: [number, number, number];
}

export function buildPunchPdf(ctx: PunchPdfContext): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const accent = ctx.accentRgb ?? resolveAccentRgb();
  // Header: optional logo + company name left; "PUNCH LIST" accent title right.
  // Project name + overall progress (sum of group done/total) line.
  // For each group from groupByArea(ctx.items): area heading + "(done/total)",
  //   then each item as "[x]"/"[ ]" + description. Page-break when y exceeds margin.
  //   Wrap long descriptions with doc.splitTextToSize.
  // If ctx.photoDataUrls has entries, render a small 2-per-row grid under items;
  //   wrap every doc.addImage in try/catch (corrupt/oversized images must not throw).
  // Mirror the layout/margins/try-catch discipline of issuePdf.ts.
  return doc;
}
```

Flesh out the body following `issuePdf.ts` (same margins, accent title, `splitTextToSize`, page-break math, and **all `addImage` in try/catch**). Photo embedding is optional for v1 — if simpler, render the checklist text-only and pass `photoDataUrls: {}`; keep the parameter so photos can be added without an API change.

- [ ] **Step 4: Run, expect PASS** (the `groupByArea` test).

- [ ] **Step 5: Wire the button** in `ProjectPunch.tsx`: "Download report" gathers the loaded list, optionally pre-fetches photo dataUrls (or passes `{}`), reads company/logo from settings the way `IssueEditor`/`invoicePdf` does, calls `buildPunchPdf(...)`, and `doc.save(`${projectName}-punch-list.pdf`)`.

- [ ] **Step 6: Commit**

```bash
git add src/pages/project/punch/punchPdf.ts src/pages/project/punch/punchPdf.test.ts src/pages/project/ProjectPunch.tsx
git commit -m "feat: printable punch list PDF (area-grouped, accent header)"
```

---

## Task 11: Navigation, route, and Overview stat

**Files:**
- Modify: `src/components/shell/Sidebar.tsx` (PROJECT_NAV ~37-52)
- Modify: `src/App.tsx` (project route tree ~108-120)
- Modify: `src/pages/project/ProjectOverview.tsx` (~line 102, near the openIssueCount stat)
- Modify: `src/components/shell/Sidebar.test.tsx` (assert the new nav item)

- [ ] **Step 1: Add the nav entry** to `PROJECT_NAV`, **between Documents and Issues** (spec §4.2 order: Documents · Punch & Checklists · Issues), NOT adminOnly:

```ts
{ id: 'punch', label: 'Punch & Checklists', Icon: ClipboardCheck, path: '/punch', match: (p: string) => p.endsWith('/punch'), adminOnly: false },
```

Import `ClipboardCheck` from `lucide-react` (match the existing icon import style). Match the exact `match` predicate shape the other entries use.

- [ ] **Step 2: Add a Sidebar test** asserting "Punch & Checklists" renders for a project route for a non-admin (mirror the Issues visibility assertion in `Sidebar.test.tsx`).

- [ ] **Step 3: Register the route** in `src/App.tsx`, as a sibling under `project/:projectId` (before `issues` to match nav order):

```tsx
{ path: 'punch', element: <ProjectPunch /> },
```

Add the import: `import { ProjectPunch } from './pages/project/ProjectPunch';` (match the existing import style — default vs named per how `ProjectIssues` is imported).

- [ ] **Step 4: Add the Overview stat** in `ProjectOverview.tsx` near the `openIssueCount` stat (~line 102), **ungated**:

```tsx
<span className="flex items-center gap-1.5">
  <ClipboardCheck size={14} className="text-ink-faint" />
  {summary.punchDone}/{summary.punchTotal} punch
</span>
```

Import `ClipboardCheck` and guard against `summary` being null exactly as the surrounding stats do.

- [ ] **Step 5: Typecheck + lint + targeted test**

Run: `npx tsc --noEmit && npm run lint && npx vitest run src/components/shell/Sidebar.test.tsx`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/components/shell/Sidebar.tsx src/components/shell/Sidebar.test.tsx src/App.tsx src/pages/project/ProjectOverview.tsx
git commit -m "feat: punch nav entry, route, and overview progress stat"
```

---

## Task 12: Full verification + push

- [ ] **Step 1: Full automated gate**

```bash
npm run lint
npm test
npm run build
```
Expected: lint clean, all tests pass (new punch store/route/component tests included), build succeeds.

- [ ] **Step 2: Live API smoke** (boot a temp dir, login admin/admin):

```bash
# kill any port-3000 listener first:
#   ss -tlnp | grep ':3000' | grep -oP 'pid=\K[0-9]+' | xargs -r kill
STORAGE_PATH=/tmp/ftpunch npm run dev   # background; confirm "[migrations] applied 10: punch"
```
Then verify with curl (login admin/admin → token):
- Create a project; `POST /api/projects/:id/punch` ×3 across two areas → all 200, items returned.
- `GET /api/projects/:id/punch` → ordered by area then sortOrder; `photoCount` present.
- `PATCH /api/punch/:id {done:true}` → 200; `GET /:id/summary` → `punchDone` increments, `punchTotal` correct.
- Stale `PUT /api/punch/:id {version:99}` → **409** `version_conflict`.
- `POST /api/punch/:id/photos {fileId, stage:'before'}` → 200; item's `photos` shows the staged photo; invalid stage → 400.
- Create a **non-admin 'user'** token → can create + list punch (200); confirm **billing still 403** (punch is NOT admin-gated).
- Delete the project → punch rows gone (no orphans).

- [ ] **Step 3: Browser smoke** (optional, note for Nathan): Punch & Checklists nav visible to non-admins; create items in areas; per-area + overall progress bars; toggle done; add before/during/after photos (mobile camera); Download report PDF; Overview shows punch progress.

- [ ] **Step 4: Final whole-phase review** — dispatch a code-review subagent (opus) over the 4c-1 commit range with the same focus areas used for Issues: access control (NOT admin-gated; punch progress ungated), concurrency (version-checked save → 409; create sortOrder in a transaction), cascade (punch_photos before punch_items), editor stale-state (done-toggle guarded against unsaved edits; `key={id:version}` remount), PDF (all addImage in try/catch), SQL parameterization, list ordering. Fix any Critical/Important findings and re-review.

- [ ] **Step 5: Tell Nathan, then push**

Migration 10 is **ADDITIVE** (two new empty punch tables — no data risk). Per the standing protocol, tell Nathan before he pulls, but nothing is dropped. Then:

```bash
git push origin testing
```

- [ ] **Step 6: Record memory** — write `phase4c1-project-punch-complete.md` (commit range, what shipped, migration 10 additive, key correctness pins, manual-smoke-pending list, deferred items) and add the MEMORY.md index line. Note that Phase 4c module 2 (collaborative Task List) is the remaining piece.

---

## Self-Review Notes (author)

- **Spec coverage:** §4.2 "Punch & Checklists — area-grouped punch items with per-area progress; before/during/after photos; printable report" → Tasks 8 (area groups + progress), 9 (staged photos), 10 (printable report). §4.3 field-use/not-gated → Tasks 4/5 (auth-only, ungated summary). Overview "punch progress" (§4.2 Overview bullet) → Task 11.
- **Type consistency:** `done` is stored as INTEGER (0/1) and surfaces as a number in `PunchItem`/`PunchListItem`; the API PATCH takes a boolean (`setPunchDone(done: boolean)`), server maps to 0/1. UI must compare `!!item.done`. `savePunchItem` sends only `{area, description, version}` (not `done`) — done is changed only via PATCH, matching how issues separate status from body saves.
- **No numbering:** unlike Issues, intentionally — verified no `ISS-###`/`number` leaked into punch code.
- **Photos stage** validated against `PUNCH_STAGES` on the server; client passes one of `before|during|after`.
