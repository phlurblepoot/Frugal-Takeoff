# Phase 4c-2 — Collaborative Task List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the legacy standalone Checklists feature into a company-level **collaborative Task List**: category-grouped tasks that can be assigned to any user, with a 3-state status, due dates, before/in-progress/after photos, and notes. Migrate existing legacy checklist data into the new model non-destructively.

**Architecture:** Mirrors the just-shipped Punch module (server `taskStore.ts`, auth-only routes, version-checked saves, staged photos, category grouping in the UI). NEW migration 11 creates `tasks` + `task_photos` and **transforms the legacy `checklists` JSON blob** into normalized task rows (legacy table retained as backup). A new non-admin `GET /api/users/list` powers the assignee picker (any user may assign any user — flat permissions). The legacy standalone Checklists UI (page, route, sidebar nav, command palette, `/api/checklists` routes, client helpers) is removed and replaced by a new `/tasks` page.

**Tech Stack:** Express 4 + better-sqlite3 (transactions, defensive per-record migration), React 19 + react-router 7, Tailwind 4 tokens + Phase 2 ui library, native `<input type="date">`, jsPDF not needed here, Vitest + Supertest.

**Pattern references (the new code is a near-clone of Punch):**
- Store: `server/punchStore.ts` (full file — copy its shape: error classes, transactions, version-checked save, staged photos, grouping)
- Routes: `server/routes.ts` punch block (the `punchErr` mapper + 8 auth-only routes)
- Migration (additive table): `server/migrationList.ts` migration 10 `punch` (~line 371)
- Migration (DEFENSIVE legacy import): look at migration 2 / migration 5 in `server/migrationList.ts` for the pattern of reading legacy rows, `JSON.parse` in a per-record try/catch, and inserting normalized rows without failing boot on one bad blob.
- Client store: `src/utils/store.ts` punch helpers (PunchItem types + helpers; `savePunchItem` 409→ConflictError; `getSettings`)
- Status pill: `src/components/ui/IssueStatusPill.tsx`
- Section/editor: `src/pages/project/ProjectPunch.tsx` (category grouping, create form, done checkbox, editor key remount) and `src/pages/project/punch/PunchItemEditor.tsx` (version-checked edit, staged photo galleries, dirty-guard)
- Company-level full page: `src/pages/TimeKeeping.tsx` (top-level page layout, not project-scoped)
- Legacy surface to remove: `src/pages/ChecklistEditor.tsx`, `src/App.tsx` `/checklist` route (~line 144), `src/components/shell/Sidebar.tsx` WORKSPACE_NAV checklists entry (~line 26), `src/components/CommandPalette.tsx` (~line 72), `src/utils/store.ts` getChecklists/saveChecklist/deleteChecklist (~lines 414-435), `server.ts` `/api/checklists` GET/PUT/DELETE (~lines 427-456).

**Data model decisions:**
- **Flat tasks with a `category` text field** (NOT a separate lists table — YAGNI; grouped in the UI like punch areas). Legacy checklist `name` → task `category`.
- **Status** ∈ `todo | in_progress | done` (`TASK_STATUSES`). The "done" checkbox is shorthand for status `done` ↔ `todo`. Legacy `item.done === true` → `done`, else `todo`.
- **dueDate** stored as a TEXT ISO date `YYYY-MM-DD` (nullable) — date-only, avoids timezone off-by-one from ms timestamps. Overdue = `dueDate < today && status !== 'done'`.
- **assigneeUserId** nullable TEXT referencing `users.id` (no FK constraint — app-level, like the rest of the schema). Validated to exist on create/save when non-empty.
- **Photo stages** = `before | in_progress | after` (`TASK_PHOTO_STAGES`) — matches the legacy field names exactly so migration is a direct copy. Legacy `comments` → task `notes`.
- **Permissions:** all task routes auth-only (any user creates/edits/assigns/sees all tasks). No admin gating. No project → **no activity log** (the activity log is project-scoped).
- **Legacy `checklists` table is KEPT** (data backup); legacy printouts are NOT migrated (regenerable PDFs; their file rows remain referenced by the kept table so orphan-cleanup won't sweep them).

---

## File Structure

**Create:**
- `server/taskStore.ts` — task CRUD, staged photos, assignee validation
- `server/taskStore.test.ts`
- `src/components/ui/TaskStatusPill.tsx`
- `src/components/ui/TaskStatusPill.test.tsx`
- `src/pages/TasksPage.tsx` — company-level task list (category-grouped, filters, create)
- `src/pages/tasks/TaskEditor.tsx` — edit modal (assignee, status, due, staged photos, notes)

**Modify:**
- `server/migrationList.ts` — migration 11 `tasks` (+ legacy import)
- `server/migrationList.test.ts` — assert tables exist + legacy-blob transform works
- `server/routes.ts` — add `GET /api/users/list` + the task routes block; (note: the legacy `/api/checklists` routes live in `server.ts`, removed in Task 9)
- `server/routes.test.ts` — task route integration tests
- `src/utils/store.ts` — Task types + helpers + `getAssignableUsers`; remove checklist helpers (Task 9)
- `src/App.tsx` — replace `/checklist` route with `/tasks`
- `src/components/shell/Sidebar.tsx` — WORKSPACE_NAV "Checklists" → "Tasks"
- `src/components/CommandPalette.tsx` — checklist command → tasks
- `server.ts` — remove `/api/checklists` routes (Task 9)
- Delete `src/pages/ChecklistEditor.tsx` (Task 9)

---

## Task 1: Migration 11 — tasks tables + legacy checklist import

**Files:**
- Modify: `server/migrationList.ts` (append after migration 10, ~line 371)
- Modify: `server/migrationList.test.ts`

- [ ] **Step 1: Write failing tests** in `server/migrationList.test.ts`.

(a) Table-existence test (mirror the migration-10 test): after migrations, `tasks` and `task_photos` exist.

(b) **Legacy-transform test.** Build a db migrated only THROUGH migration 10 (so the legacy `checklists` table exists but migration 11 hasn't run), insert a legacy checklist blob, then run migration 11 and assert the transform. Use the suite's existing mechanism for running migrations up to a target version (check how other tests run a subset; if the runner always runs all, instead: run all migrations, then directly assert that a helper function transforms a sample blob — but prefer testing the real migration). Concretely:

```ts
it('migration 11 imports legacy checklists into tasks', () => {
  const db = freshDbMigratedThrough(10); // however the suite expresses "up to v10"
  db.prepare('INSERT INTO checklists (id, data, createdAt) VALUES (?, ?, ?)').run(
    'cl1',
    JSON.stringify({
      id: 'cl1', name: 'Shop Punchout', createdAt: 1000,
      items: [
        { id: 'it1', description: 'Fix door', location: 'Bay 2', done: true, order: 0, comments: 'use shims',
          beforePhotoIds: ['pa'], inProgressPhotoIds: [], afterPhotoIds: ['pb'], createdAt: 1001 },
        { id: 'it2', description: 'Sweep', location: '', done: false, order: 1, createdAt: 1002 },
      ],
      printouts: [],
    }),
    1000,
  );
  runMigration(db, 11); // however the suite triggers a single migration / the remaining ones

  const tasks = db.prepare('SELECT * FROM tasks ORDER BY sortOrder').all() as any[];
  expect(tasks.length).toBe(2);
  expect(tasks[0].title).toBe('Fix door');
  expect(tasks[0].category).toBe('Shop Punchout');
  expect(tasks[0].status).toBe('done');
  expect(tasks[0].notes).toBe('use shims');
  expect(tasks[1].status).toBe('todo');
  const photos = db.prepare('SELECT * FROM task_photos WHERE taskId = ? ORDER BY stage').all('it1') as any[];
  expect(photos.map(p => `${p.stage}:${p.fileId}`)).toEqual(['after:pb', 'before:pa']);
  // legacy table is retained (backup)
  expect(db.prepare('SELECT COUNT(*) c FROM checklists').get()).toEqual({ c: 1 });
});

it('migration 11 survives a malformed legacy blob', () => {
  const db = freshDbMigratedThrough(10);
  db.prepare('INSERT INTO checklists (id, data, createdAt) VALUES (?, ?, ?)').run('bad', '{not json', 1);
  expect(() => runMigration(db, 11)).not.toThrow();
  expect(db.prepare('SELECT COUNT(*) c FROM tasks').get()).toEqual({ c: 0 });
});
```

Adapt `freshDbMigratedThrough`/`runMigration` to the suite's real helpers — read `server/migrationList.test.ts` first and match how it already exercises individual migrations. If the runner only does "all at once", construct the legacy row BEFORE running migrations is impossible (table doesn't exist yet); in that case, refactor the migration's transform into an exported pure helper `importLegacyChecklists(db)` that migration 11 calls, and unit-test that helper directly against a hand-built db with both `checklists` and `tasks` tables. **Prefer the exported-helper approach if the runner can't target a version** — it's cleaner to test.

Run the migration test → confirm FAIL.

- [ ] **Step 2: Append migration 11** in `server/migrationList.ts`:

```ts
  {
    version: 11,
    name: 'tasks',
    up({ db }) {
      // Collaborative Task List (Phase 4c-2): company-level, category-grouped tasks
      // assignable to any user, with todo|in_progress|done status, due dates, staged
      // photos (before|in_progress|after), and notes. Field-created by any user
      // (not admin-gated). Mirrors punch but with assignee + dueDate + status.
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          assigneeUserId TEXT,
          status TEXT NOT NULL DEFAULT 'todo',
          dueDate TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL,
          createdBy TEXT
        );
        CREATE INDEX idx_tasks_assignee ON tasks (assigneeUserId);
        CREATE INDEX idx_tasks_status ON tasks (status);

        CREATE TABLE task_photos (
          id TEXT PRIMARY KEY,
          taskId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          stage TEXT NOT NULL DEFAULT 'before',
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_task_photos_taskId ON task_photos (taskId);
      `);

      // Non-destructive import of legacy standalone checklists. Each legacy item
      // becomes a task (category = checklist name). The legacy `checklists` table
      // is intentionally KEPT as a backup. One bad blob must not fail boot.
      let rows: { data: string }[] = [];
      try {
        rows = db.prepare('SELECT data FROM checklists ORDER BY createdAt ASC').all() as { data: string }[];
      } catch { rows = []; } // table may not exist on a brand-new db

      const insTask = db.prepare(`INSERT INTO tasks
        (id, category, title, notes, assigneeUserId, status, dueDate, sortOrder, version, createdAt, createdBy)
        VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, 1, ?, NULL)`);
      const insPhoto = db.prepare(`INSERT INTO task_photos
        (id, taskId, fileId, stage, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?, ?)`);

      let sort = 0;
      for (const r of rows) {
        let cl: any;
        try { cl = JSON.parse(r.data); } catch { continue; } // skip malformed blob
        if (!cl || !Array.isArray(cl.items)) continue;
        const category = typeof cl.name === 'string' ? cl.name : '';
        for (const it of cl.items) {
          if (!it || typeof it !== 'object') continue;
          const taskId = typeof it.id === 'string' && it.id ? it.id : crypto.randomUUID();
          const title = typeof it.description === 'string' ? it.description : '';
          const notes = typeof it.comments === 'string' ? it.comments : '';
          const status = it.done === true ? 'done' : 'todo';
          const createdAt = Number.isFinite(it.createdAt) ? it.createdAt : Date.now();
          try {
            insTask.run(taskId, category, title, notes, status, sort++, createdAt);
          } catch { continue; } // duplicate id etc. — skip, don't abort
          let pSort = 0;
          const stages: [string, any][] = [
            ['before', it.beforePhotoIds],
            ['in_progress', it.inProgressPhotoIds],
            ['after', it.afterPhotoIds],
          ];
          for (const [stage, ids] of stages) {
            if (!Array.isArray(ids)) continue;
            for (const fileId of ids) {
              if (typeof fileId !== 'string' || !fileId) continue;
              try { insPhoto.run(crypto.randomUUID(), taskId, fileId, stage, pSort++, createdAt); } catch { /* skip */ }
            }
          }
        }
      }
    },
  },
```

Ensure `crypto` is imported at the top of `migrationList.ts` (check — if not, add `import crypto from 'crypto';`). If migrations run inside a transaction already (check the framework), the per-record try/catch still protects parsing; if a single `insTask.run` throwing would poison an outer transaction, wrap each checklist's import in its own `db.transaction` savepoint — but better-sqlite3 + try/catch around individual `.run()` is fine as long as the migration framework doesn't wrap the whole `up()` in one transaction that aborts on any error. Verify how the framework runs `up()` and adapt (if it wraps in a transaction, the inner try/catch swallowing the error is enough to keep going).

If the transform is extracted as a helper for testability (Step 1 fallback), define `export function importLegacyChecklists(db)` with this body and call it from `up()`.

- [ ] **Step 3: Run migration tests → PASS.**

- [ ] **Step 4: Commit**

```bash
git add server/migrationList.ts server/migrationList.test.ts
git commit -m "feat: migration 11 tasks tables + non-destructive legacy checklist import"
```

---

## Task 2: taskStore — tasks CRUD (create/get/list/save)

**Files:**
- Create: `server/taskStore.ts`, `server/taskStore.test.ts`

Read `server/punchStore.ts` first — this is a near-clone with `category` instead of `area`, plus `assigneeUserId`, `status`, `dueDate`, `notes`, and an assignee-existence check.

- [ ] **Step 1: Failing tests** (`server/taskStore.test.ts`) — mirror `punchStore.test.ts` setup; also insert a couple `users` rows for assignee tests:

```ts
// setup: migrated in-memory db; insert users ('u1','alice','x','user'), ('u2','bob','x','admin')
it('creates and reads a task with assignee + due', () => {
  const { id } = createTask(db, { category: 'Shop', title: 'Fix door', assigneeUserId: 'u1', dueDate: '2026-07-01' });
  const t = getTask(db, id);
  expect(t.title).toBe('Fix door');
  expect(t.category).toBe('Shop');
  expect(t.status).toBe('todo');
  expect(t.assigneeUserId).toBe('u1');
  expect(t.assigneeUsername).toBe('alice'); // joined
  expect(t.dueDate).toBe('2026-07-01');
  expect(t.version).toBe(1);
  expect(t.photos).toEqual([]);
});
it('rejects empty title', () => { expect(() => createTask(db, { title: ' ' })).toThrow(ValidationError); });
it('rejects unknown assignee', () => { expect(() => createTask(db, { title: 'x', assigneeUserId: 'nope' })).toThrow(ValidationError); });
it('rejects invalid dueDate format', () => { expect(() => createTask(db, { title: 'x', dueDate: '07/01/2026' })).toThrow(ValidationError); });
it('lists tasks ordered by category then sortOrder, with assigneeUsername + photoCount', () => {
  createTask(db, { category: 'B', title: 'b1' });
  createTask(db, { category: 'A', title: 'a1', assigneeUserId: 'u2' });
  const list = listTasks(db);
  expect(list.map((t: any) => t.title)).toEqual(['a1', 'b1']);
  expect(list[0].assigneeUsername).toBe('bob');
  expect(list[0].photoCount).toBe(0);
});
it('saves with version check (bumps) and conflicts on stale', () => {
  const { id } = createTask(db, { title: 'x' });
  expect(saveTask(db, id, { title: 'y', category: '', notes: '', assigneeUserId: null, dueDate: null, version: 1 }).version).toBe(2);
  expect(() => saveTask(db, id, { title: 'z', version: 99 } as any)).toThrow(ConflictError);
});
```

Run → FAIL.

- [ ] **Step 2: Implement `server/taskStore.ts`:**

```ts
// server/taskStore.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const;
export const TASK_PHOTO_STAGES = ['before', 'in_progress', 'after'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function photoCount(db: Database.Database, taskId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM task_photos WHERE taskId = ?').get(taskId) as any).c;
}

function validateAssignee(db: Database.Database, assigneeUserId: unknown): string | null {
  if (assigneeUserId === undefined || assigneeUserId === null || assigneeUserId === '') return null;
  if (typeof assigneeUserId !== 'string') throw new ValidationError('Invalid assignee');
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(assigneeUserId)) throw new ValidationError('Assignee is not a known user');
  return assigneeUserId;
}

function validateDue(dueDate: unknown): string | null {
  if (dueDate === undefined || dueDate === null || dueDate === '') return null;
  if (typeof dueDate !== 'string' || !DATE_RE.test(dueDate)) throw new ValidationError('Due date must be YYYY-MM-DD');
  return dueDate;
}

interface TaskInput {
  category?: string; title?: string; notes?: string;
  assigneeUserId?: string | null; dueDate?: string | null;
}

export function getTask(db: Database.Database, id: string): any | null {
  const row = db.prepare(`
    SELECT t.*, u.username AS assigneeUsername
    FROM tasks t LEFT JOIN users u ON u.id = t.assigneeUserId
    WHERE t.id = ?`).get(id) as any;
  if (!row) return null;
  const photos = db.prepare('SELECT id, fileId, stage, sortOrder FROM task_photos WHERE taskId = ? ORDER BY stage, sortOrder, createdAt').all(id);
  return { ...row, photos };
}

export function listTasks(db: Database.Database): any[] {
  const rows = db.prepare(`
    SELECT t.*, u.username AS assigneeUsername
    FROM tasks t LEFT JOIN users u ON u.id = t.assigneeUserId
    ORDER BY t.category ASC, t.sortOrder ASC, t.createdAt ASC, t.rowid ASC`).all() as any[];
  return rows.map(r => ({ ...r, photoCount: photoCount(db, r.id) }));
}

export function createTask(db: Database.Database, input: TaskInput & { createdBy?: string | null }): { id: string } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('Task title is required');
  const assignee = validateAssignee(db, input.assigneeUserId);
  const due = validateDue(input.dueDate);
  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM tasks').get() as any).m;
    db.prepare(`INSERT INTO tasks (id, category, title, notes, assigneeUserId, status, dueDate, sortOrder, version, createdAt, createdBy)
      VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, 1, ?, ?)`)
      .run(id, (input.category ?? '').trim(), input.title!.trim(), (input.notes ?? '').trim(), assignee, due, max + 1, Date.now(), input.createdBy ?? null);
  });
  tx();
  return { id };
}

export function saveTask(db: Database.Database, id: string, input: TaskInput & { version?: number }): { version: number } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('Task title is required');
  if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new ValidationError('Missing or invalid version — reload the task');
  const assignee = validateAssignee(db, input.assigneeUserId);
  const due = validateDue(input.dueDate);
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM tasks WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('Task not found');
    if (row.version !== input.version) throw new ConflictError(`Task changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;
    db.prepare('UPDATE tasks SET category = ?, title = ?, notes = ?, assigneeUserId = ?, dueDate = ?, version = ? WHERE id = ?')
      .run((input.category ?? '').trim(), input.title!.trim(), (input.notes ?? '').trim(), assignee, due, newVersion, id);
  });
  tx();
  return { version: newVersion };
}
```

Run → PASS.

- [ ] **Step 3: tsc clean. Commit**

```bash
git add server/taskStore.ts server/taskStore.test.ts
git commit -m "feat: task store — CRUD with assignee + due date + version checks"
```

---

## Task 3: taskStore — status, staged photos, delete cascade

**Files:** Modify `server/taskStore.ts`, `server/taskStore.test.ts`

- [ ] **Step 1: Failing tests** for: `setTaskStatus` (valid status bumps version; invalid → ValidationError; unknown id → NotFoundError); `deleteTask` (cascade photos); `addTaskPhoto` (validates stage ∈ TASK_PHOTO_STAGES, idempotent on (taskId,fileId,stage), NotFound if task missing, ValidationError empty fileId); `removeTaskPhoto`; and a `countByStatus`/progress helper if used. Mirror `punchStore.test.ts` Task-3 tests.

- [ ] **Step 2: Implement (append to `server/taskStore.ts`):**

```ts
export function setTaskStatus(db: Database.Database, id: string, status: string): { status: string } {
  if (!(TASK_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Invalid task status: ${status}`);
  const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('Task not found');
  db.prepare('UPDATE tasks SET status = ?, version = version + 1 WHERE id = ?').run(status, id);
  return { status };
}

export function deleteTask(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM task_photos WHERE taskId = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  });
  tx();
}

export function addTaskPhoto(db: Database.Database, taskId: string, fileId: string, stage: string): void {
  if (!db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)) throw new NotFoundError('Task not found');
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  if (!(TASK_PHOTO_STAGES as readonly string[]).includes(stage)) throw new ValidationError(`Invalid photo stage: ${stage}`);
  if (db.prepare('SELECT id FROM task_photos WHERE taskId = ? AND fileId = ? AND stage = ?').get(taskId, fileId, stage)) return;
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM task_photos WHERE taskId = ?').get(taskId) as any).m;
  db.prepare('INSERT INTO task_photos (id, taskId, fileId, stage, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), taskId, fileId, stage, max + 1, Date.now());
}

export function removeTaskPhoto(db: Database.Database, taskId: string, fileId: string): void {
  db.prepare('DELETE FROM task_photos WHERE taskId = ? AND fileId = ?').run(taskId, fileId);
}
```

Run → PASS. tsc clean.

- [ ] **Step 3: Commit**

```bash
git add server/taskStore.ts server/taskStore.test.ts
git commit -m "feat: task store — status, staged photos, delete cascade"
```

---

## Task 4: Users-list endpoint + task routes (auth-only)

**Files:** Modify `server/routes.ts` (import taskStore with aliased errors, add routes after the punch block), `server/routes.test.ts`.

- [ ] **Step 1: Failing integration tests** in `server/routes.test.ts`:
- `GET /api/users/list` with a NON-admin token → 200 and an array of `{id, username, role}` (NO `password` field present on any row).
- `POST /api/tasks` (non-admin) `{title:'x', category:'Shop'}` → 200 `{id}`.
- `GET /api/tasks` (non-admin) → 200 array including the created task with `assigneeUsername` field.
- `POST /api/tasks` with `assigneeUserId` of a real user → 200; with a bogus assignee → 400.
- `PUT /api/tasks/:id` stale version 99 → 409 `code:'version_conflict'`.
- `PATCH /api/tasks/:id` `{status:'in_progress'}` → 200; `{status:'nope'}` → 400; missing status → 400.
- `POST /api/tasks/:id/photos` `{fileId:'f1', stage:'before'}` → 200; bad stage → 400.

- [ ] **Step 2: Implement.** Top of `server/routes.ts`, import taskStore (aliased like punch):

```ts
import {
  getTask, listTasks, createTask, saveTask, setTaskStatus, deleteTask, addTaskPhoto, removeTaskPhoto,
  ValidationError as TaskValidationError,
  ConflictError as TaskConflictError,
  NotFoundError as TaskNotFoundError,
} from './taskStore';
```

After the punch routes block, add the users-list route + task routes (ALL `authenticateToken` only):

```ts
  // ── Users roster (any authenticated user — for assignee pickers) ───────────
  app.get('/api/users/list', authenticateToken, (req, res) => {
    try { res.json(db.prepare('SELECT id, username, role FROM users ORDER BY username').all()); }
    catch (e) { console.error('Users list error:', e); res.status(500).json({ error: 'Failed to list users' }); }
  });

  // ── Tasks (collaborative task list — any authenticated user, Phase 4c-2) ───
  const taskErr = (e: unknown, res: express.Response) => {
    if (e instanceof TaskNotFoundError) return res.status(404).json({ error: e.message });
    if (e instanceof TaskConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
    if (e instanceof TaskValidationError) return res.status(400).json({ error: e.message });
    console.error('Task error:', e);
    return res.status(500).json({ error: 'Task operation failed' });
  };

  app.get('/api/tasks', authenticateToken, (req, res) => {
    try { res.json(listTasks(db)); } catch (e) { taskErr(e, res); }
  });
  app.post('/api/tasks', authenticateToken, (req, res) => {
    try { res.json(createTask(db, { ...req.body, createdBy: (req as any).user?.id ?? null })); } catch (e) { taskErr(e, res); }
  });
  app.get('/api/tasks/:id', authenticateToken, (req, res) => {
    try { const t = getTask(db, req.params.id); if (!t) return res.status(404).json({ error: 'Task not found' }); res.json(t); } catch (e) { taskErr(e, res); }
  });
  app.put('/api/tasks/:id', authenticateToken, (req, res) => {
    try { res.json({ success: true, ...saveTask(db, req.params.id, req.body) }); } catch (e) { taskErr(e, res); }
  });
  app.patch('/api/tasks/:id', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      res.json({ success: true, ...setTaskStatus(db, req.params.id, req.body.status) });
    } catch (e) { taskErr(e, res); }
  });
  app.delete('/api/tasks/:id', authenticateToken, (req, res) => {
    try { deleteTask(db, req.params.id); res.json({ success: true }); } catch (e) { taskErr(e, res); }
  });
  app.post('/api/tasks/:id/photos', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      addTaskPhoto(db, req.params.id, req.body.fileId, req.body?.stage ?? 'before');
      res.json({ success: true });
    } catch (e) { taskErr(e, res); }
  });
  app.delete('/api/tasks/:id/photos/:fileId', authenticateToken, (req, res) => {
    try { removeTaskPhoto(db, req.params.id, req.params.fileId); res.json({ success: true }); } catch (e) { taskErr(e, res); }
  });
```

Run → PASS. tsc clean.

- [ ] **Step 3: Commit**

```bash
git add server/routes.ts server/routes.test.ts
git commit -m "feat: users-list endpoint + task routes (auth, assignee/status/photos)"
```

---

## Task 5: Client store — task types + helpers + assignable users

**Files:** Modify `src/utils/store.ts`.

- [ ] **Step 1:** Read the punch helpers + `punchJson`/`ConflictError` handling. Add task types + helpers, mirroring exactly:

```ts
export interface TaskPhoto { id: string; fileId: string; stage: string; sortOrder: number; }
export interface AssignableUser { id: string; username: string; role: string; }
export interface Task {
  id: string; category: string; title: string; notes: string;
  assigneeUserId: string | null; assigneeUsername: string | null;
  status: string; dueDate: string | null; sortOrder: number;
  version: number; createdAt: number; createdBy: string | null;
  photos: TaskPhoto[];
}
export interface TaskListItem {
  id: string; category: string; title: string; notes: string;
  assigneeUserId: string | null; assigneeUsername: string | null;
  status: string; dueDate: string | null; sortOrder: number;
  version: number; createdAt: number; createdBy: string | null;
  photoCount: number;
}

export const getAssignableUsers = async (): Promise<AssignableUser[]> => { /* GET /api/users/list */ };
export const getTasks = async (): Promise<TaskListItem[]> => { /* GET /api/tasks */ };
export const getTask = async (id: string): Promise<Task> => { /* GET /api/tasks/:id */ };
export const createTask = async (input: { category?: string; title: string; assigneeUserId?: string | null; dueDate?: string | null; notes?: string }): Promise<{ id: string }> => { /* POST /api/tasks */ };
export const saveTask = async (id: string, task: Task): Promise<{ version: number }> => {
  // PUT /api/tasks/:id body { category, title, notes, assigneeUserId, dueDate, version } — map 409 -> ConflictError like savePunchItem
};
export const setTaskStatus = async (id: string, status: string): Promise<void> => { /* PATCH /api/tasks/:id { status } */ };
export const deleteTask = async (id: string): Promise<void> => { /* DELETE /api/tasks/:id */ };
export const addTaskPhoto = async (taskId: string, fileId: string, stage: string): Promise<void> => { /* POST /api/tasks/:id/photos { fileId, stage } */ };
export const removeTaskPhoto = async (taskId: string, fileId: string): Promise<void> => { /* DELETE /api/tasks/:id/photos/:fileId */ };
```

Use the file's real request helpers (the punch helpers are the template). `saveTask` MUST throw `ConflictError` on 409 exactly like `savePunchItem`, sending only `{ category, title, notes, assigneeUserId, dueDate, version }`.

- [ ] **Step 2:** tsc clean. Commit

```bash
git add src/utils/store.ts
git commit -m "feat: client store — task types, helpers, assignable users"
```

---

## Task 6: TaskStatusPill component

**Files:** Create `src/components/ui/TaskStatusPill.tsx`, `src/components/ui/TaskStatusPill.test.tsx`.

- [ ] **Step 1:** Read `src/components/ui/IssueStatusPill.tsx`. Write a failing test (renders label for each status; prototype-safe fallback for unknown).

- [ ] **Step 2:** Implement mirroring IssueStatusPill:

```tsx
export const TASK_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  todo:        { label: 'To do',       tone: 'slate' },
  in_progress: { label: 'In progress', tone: 'blue' },
  done:        { label: 'Done',        tone: 'emerald' },
};
export const TaskStatusPill: React.FC<{ status?: string | null }> = ({ status }) => { /* Object.hasOwn fallback to slate */ };
```

Use the same `PillTone`/Pill primitive IssueStatusPill uses. Test → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/TaskStatusPill.tsx src/components/ui/TaskStatusPill.test.tsx
git commit -m "feat: task status pill"
```

---

## Task 7: TasksPage — company-level grouped list + filters + create

**Files:** Create `src/pages/TasksPage.tsx`. Stub `src/pages/tasks/TaskEditor.tsx` (real one in Task 8).

Read `src/pages/project/ProjectPunch.tsx` (grouping/create pattern) and `src/pages/TimeKeeping.tsx` (top-level page chrome). This page is COMPANY-level (no projectId).

- [ ] **Step 1: Implement TasksPage** (no unit test — covered by build + Task 10 smoke):
- On mount: load `getTasks()` and `getAssignableUsers()`. Expose `reload()`.
- **Current user**: read from `localStorage.getItem('user')` (`{id, username, role}`) — same as Sidebar — for the "My tasks" filter.
- **Filters** (a small toolbar): `All | My tasks | To do | In progress | Done | Overdue`. Apply client-side to the loaded list. "My tasks" = `assigneeUserId === currentUser.id`. "Overdue" = `dueDate && dueDate < todayISO && status !== 'done'`. `todayISO = new Date().toISOString().slice(0,10)`.
- **Group filtered tasks by `category`** (empty → "Uncategorized", shown last — reuse the punch grouping approach: Map preserving first-seen order, push the empty bucket last).
- Per category: heading + the rows. Each task row:
  - done checkbox = `status === 'done'`; toggling calls `setTaskStatus(id, status === 'done' ? 'todo' : 'done')` then reload.
  - title (strike-through when done).
  - assignee chip (`assigneeUsername` or "Unassigned").
  - `<TaskStatusPill status={status} />`.
  - due date, shown red/warning when overdue (helper `isOverdue(task)`).
  - photo-count badge when `photoCount > 0`.
  - clicking the row body opens the editor.
- **Create form**: `category` input (with a `<datalist>` of existing categories), `title` input, an **assignee `<select>`** (options from `getAssignableUsers()`, plus an "Unassigned" option), an optional `dueDate` `<input type="date">`, and an Add button (disabled when title blank). Add calls `createTask({ category, title, assigneeUserId, dueDate })` then clears + reloads.
- Editor: `<TaskEditor key={`${editing.id}:${editing.version}`} task={fullTask} users={users} onClose={...} onSaved={() => reload()/refetch} />`; fetch full task via `getTask(id)` when opening.
- Use `TimeKeeping`-style page chrome (title bar "Tasks"); design tokens consistent with the app.

Create a minimal `TaskEditor` stub (named export) so this compiles (props: `{ task: Task; users: AssignableUser[]; onClose: () => void; onSaved: () => void }`).

- [ ] **Step 2:** tsc clean, lint pass, `npm test` green. Commit

```bash
git add src/pages/TasksPage.tsx src/pages/tasks/TaskEditor.tsx
git commit -m "feat: tasks page — category-grouped list, filters, create"
```

---

## Task 8: TaskEditor — assignee, status, due date, staged photos, notes

**Files:** Create/replace `src/pages/tasks/TaskEditor.tsx`.

Read `src/pages/project/punch/PunchItemEditor.tsx` first — mirror it (Modal, seed-once, version-checked save, dirty-guard on status change, staged photo galleries, getImageUrl thumbnails, uploadProjectFile). Differences: tasks aren't project-scoped, so photos upload WITHOUT a projectId — check `uploadProjectFile`'s signature; if it REQUIRES a projectId, use the same generic image upload the legacy ChecklistEditor used (`saveFile(id, dataUrl)` → `POST /api/images`, with `getImageUrl(id)` for display) OR a projectId-less variant. Report which upload path you used. (The legacy checklist photos used `saveFile`/`getFile` = `/api/images` — that path needs no project and is the safe choice here.)

- [ ] **Step 1: Implement** props `{ task: Task; users: AssignableUser[]; onClose: () => void; onSaved: () => void }`:
- Seed `category`, `title`, `notes`, `assigneeUserId`, `dueDate` from `task` once. `dirty` = any changed vs seed.
- **Save** → `saveTask(task.id, { ...task, category, title, notes, assigneeUserId, dueDate })`; success → `onSaved()`; `ConflictError` (`e.name === 'ConflictError'`) → toast "changed elsewhere — reload".
- **Assignee** `<select>` from `users` (+ "Unassigned" → null).
- **Status** control (a `<select>` todo/in_progress/done, or three buttons): on change, GUARD against unsaved edits (if `dirty` → toast "Save your changes first" + bail), else `setTaskStatus(task.id, next)` then `onSaved()`.
- **Due date** `<input type="date">` bound to `dueDate` (string or '').
- **Notes** `<textarea>`.
- **Three staged photo galleries** (Before / In progress / After → stages `before`/`in_progress`/`after`): file input `accept="image/*" capture="environment" multiple`; per file upload via the chosen image path → `addTaskPhoto(task.id, fileId, stage)`; aggregate toast; thumbnails via `getImageUrl(fileId)` filtered by stage; remove → `removeTaskPhoto` + `onSaved()`. Mirror PunchItemEditor's gallery exactly (use the same `STAGES.map` const-destructure to avoid a stage capture bug).
- Footer: Close + Save.

- [ ] **Step 2:** tsc clean, lint pass, `npm test` green. Commit

```bash
git add src/pages/tasks/TaskEditor.tsx
git commit -m "feat: task editor — assignee, status, due date, staged photos, notes"
```

---

## Task 9: Remove legacy standalone Checklists; wire the new /tasks surface

**Files:**
- Delete: `src/pages/ChecklistEditor.tsx`
- Modify: `src/App.tsx`, `src/components/shell/Sidebar.tsx`, `src/components/CommandPalette.tsx`, `src/utils/store.ts`, `server.ts`
- Modify any test referencing the company "Checklists" nav.

- [ ] **Step 1: Route.** In `src/App.tsx`, replace the `{ path: 'checklist', element: <ChecklistEditor /> }` route with `{ path: 'tasks', element: <TasksPage /> }` and swap the import (`ChecklistEditor` → `TasksPage` from `./pages/TasksPage`). Remove the now-unused `ChecklistEditor` import.

- [ ] **Step 2: Sidebar nav.** In `src/components/shell/Sidebar.tsx` WORKSPACE_NAV, change the checklists entry to:
```ts
{ id: 'tasks', label: 'Tasks', Icon: ListTodo, path: '/tasks', match: p => p.startsWith('/tasks') },
```
Import `ListTodo` from lucide-react (or keep `ClipboardList` if `ListTodo` isn't available — check the lucide version). Remove the old `ClipboardList` import only if now unused.

- [ ] **Step 3: Command palette.** In `src/components/CommandPalette.tsx`, change the checklist action to navigate to `/tasks` with title "Tasks" (and a fitting icon). Add a `New task` action if trivial (optional).

- [ ] **Step 4: Client store cleanup.** In `src/utils/store.ts`, remove `getChecklists`, `saveChecklist`, `deleteChecklist` (now unused). Grep the repo for any remaining importers — there should be none after ChecklistEditor is deleted. If something still imports them, it's dead too; resolve it.

- [ ] **Step 5: Server routes.** In `server.ts`, remove the three `/api/checklists` routes (GET/PUT/DELETE, ~lines 427-456). **Do NOT drop the `checklists` table** (migration 11 kept it as a backup; leaving the table dormant is intentional).

- [ ] **Step 6: Delete** `src/pages/ChecklistEditor.tsx`.

- [ ] **Step 7: Tests.** Update/keep any test asserting the company "Checklists" nav. If a Sidebar test references "Checklists", retarget it to "Tasks". Add (or adjust) an assertion that the "Tasks" workspace nav renders.

- [ ] **Step 8:** `npx tsc --noEmit` (clean — this will surface any dangling references), `npm run lint`, `npm test` (all green). Grep to confirm no remaining references: `grep -rn "ChecklistEditor\|getChecklists\|/api/checklists\|/checklist\b" src server.ts server` should return nothing meaningful (the migration's `SELECT ... FROM checklists` import in migrationList.ts is expected to remain).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: replace standalone Checklists with the collaborative Tasks page"
```

---

## Task 10: Full verification + push

- [ ] **Step 1: Full gate** — `npm run lint`, `npm test`, `npm run build` (all green).

- [ ] **Step 2: Live API smoke** (boot a temp dir, login admin/admin):

```bash
#   ss -tlnp | grep ':3000' | grep -oP 'pid=\K[0-9]+' | xargs -r kill
STORAGE_PATH=/tmp/fttasks npm run dev   # background; confirm "[migrations] applied 11: tasks"
```
Verify with curl (admin token + a created non-admin 'user' token):
- `GET /api/users/list` (non-admin) → 200, array of `{id,username,role}`, NO `password` field.
- `POST /api/tasks` (non-admin) `{category:'Shop', title:'Fix door', assigneeUserId:<admin id>, dueDate:'2026-07-01'}` → 200; `GET /api/tasks` shows it with `assigneeUsername`.
- Bogus assignee → 400; bad dueDate `'07/01/2026'` → 400.
- `PATCH {status:'in_progress'}` → 200; `{status:'nope'}` → 400.
- Stale `PUT {version:99}` → 409 `version_conflict`.
- `POST /tasks/:id/photos {fileId, stage:'before'}` → 200; invalid stage → 400; `GET /tasks/:id` shows the staged photo.
- Confirm a non-admin can do ALL of the above (no admin gating); `/api/users` (the admin roster) still 403 for non-admin, but `/api/users/list` is 200.

- [ ] **Step 3: Legacy-import smoke (IMPORTANT — this is the data-migration check).** On a SCRATCH copy of representative data (do NOT mutate Nathan's real DB): seed a legacy `checklists` row via the old shape, run migrations, and confirm `GET /api/tasks` returns the imported tasks with categories = checklist names, done→status, and photos preserved (and that `getImageUrl(fileId)` still resolves the migrated photos). If no representative legacy data is available locally, rely on the migration unit test from Task 1 and note that the real import runs on Nathan's pull.

- [ ] **Step 4: Browser smoke** (note for Nathan): Tasks nav appears; create a task with assignee + due; group-by-category; toggle done; set status; overdue highlight; before/in-progress/after photos; "My tasks" filter; migrated legacy checklists appear as task categories with their items + photos.

- [ ] **Step 5: Final whole-phase review** — dispatch a code-review subagent (opus) over the 4c-2 commit range. Focus: (1) access control — every task route + `/api/users/list` is auth-only and leaks no `password`; (2) the legacy migration is non-destructive (legacy table kept), defensive (bad blob can't fail boot), and faithful (category/status/photos/notes mapped correctly); (3) assignee + dueDate validation (unknown user → 400, bad date → 400); (4) version-checked save → 409; (5) editor stale-state guard; (6) staged-photo stage capture; (7) the photo upload path works WITHOUT a project; (8) no dangling references to the removed checklist surface; (9) parameterized SQL. Fix Critical/Important and re-review.

- [ ] **Step 6: TELL NATHAN, then push.** ⚠️ **Migration 11 is NOT purely additive — it reads and transforms Nathan's existing legacy checklist data into the new `tasks` tables.** It is non-destructive (the legacy `checklists` table is retained untouched as a backup), but per the standing migration protocol Nathan wants to watch data migrations. Flag this explicitly before he pulls: "Migration 11 converts your existing checklists into the new Tasks list; nothing is deleted (the old checklist table is kept as a backup), but verify the imported tasks look right." Then:

```bash
git push origin testing
```

- [ ] **Step 7: Record memory** — `phase4c2-task-list-complete.md` (commit range; what shipped; **migration 11 transforms legacy data, non-destructive, legacy table kept**; assignee/status/due/photos/notes; anyone-assigns-anyone; new `/api/users/list`; legacy Checklists surface removed; deferred items: printouts not migrated, no separate named-lists CRUD, no task email/PDF). Update MEMORY.md. Note Phase 4c is now COMPLETE (both modules) and the next milestone item per the spec.

---

## Self-Review Notes (author)

- **Spec coverage:** Nathan's decisions — "build both" (Punch shipped in 4c-1; this is the standalone Task List), fields = assignee + status/done + due date + photos/notes (Tasks 2/3/8), anyone-assigns-anyone (auth-only routes + non-admin `/api/users/list`, Task 4), "keep the standalone list, convert it" (migration 11 imports legacy data non-destructively, Task 1; the standalone slot becomes `/tasks`, Task 9).
- **Type consistency:** `status` ∈ TASK_STATUSES everywhere (server validate + client pill + editor); `done` is NOT a column — it's `status === 'done'` (checkbox shorthand). `dueDate` is a `YYYY-MM-DD` string (TEXT), nullable, validated by `DATE_RE` on the server and a native date input on the client. `assigneeUserId` nullable, validated to exist; `assigneeUsername` is a read-only JOIN field (never written back — `saveTask` sends only the id).
- **Migration safety:** legacy import is per-record try/catch (bad blob skipped), inserts use fresh-or-existing ids with a try/catch around each `.run()` so a duplicate can't abort the batch, and the legacy table is retained. Empty legacy checklists (no items) produce no tasks — acceptable, noted as minor data omission. Printouts intentionally not migrated.
- **No project coupling:** tasks are company-level; routes carry no projectId; the photo upload path must be projectId-free (use the `/api/images` `saveFile` path the legacy checklist used). Confirmed there is no activity-log call (the log is project-scoped).
