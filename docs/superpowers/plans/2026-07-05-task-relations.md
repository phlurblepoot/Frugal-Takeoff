# Task Relations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a task be *related to* a project and/or customer (setting a project auto-derives and locks its customer), make tasks reachable/pre-filtered from project & customer pages, and surface upcoming task deadlines on the dashboard and project home.

**Architecture:** Two nullable columns (`projectId`, `customerId`) added to `tasks` via migration 18. The derivation invariant ("project sets its customer") is enforced in one place — `taskStore` — on create/save. Reads join project/customer names for display. The client gains project/customer selects (with a client-side lock), global filter dropdowns driven by URL query params, and one reusable `UpcomingTasksCard` used by both the Dashboard and ProjectView.

**Tech Stack:** TypeScript, better-sqlite3, Express, React + react-router-dom, Vitest, Tailwind.

---

## File Structure

**Server**
- `server/migrationList.ts` — add migration 18 (columns + indexes).
- `server/taskStore.ts` — relation validation + derivation; joins on read; `listTasks` filters.
- `server/routes.ts` — `GET /api/tasks` reads `projectId`/`customerId` query params.

**Server tests**
- `server/migrationList.test.ts` — migration 18 adds the columns.
- `server/taskStore.test.ts` — derivation, validation, read joins, filters.
- `server/routes.test.ts` — query-param filtering (only if this file already covers `/api/tasks`; otherwise skip — the store tests cover the logic).

**Client**
- `src/utils/store.ts` — extend `Task`/`TaskListItem`; send + accept relation fields; `getTasks(params)`.
- `src/pages/tasks/TaskEditor.tsx` — project/customer selects with lock.
- `src/pages/TasksPage.tsx` — create-form fields, filter dropdowns, URL params, scope banner.
- `src/components/tasks/UpcomingTasksCard.tsx` — NEW reusable card + `upcomingTaskItems` helper.
- `src/pages/Dashboard.tsx` — upcoming-tasks card with my/all toggle.
- `src/pages/ProjectView.tsx` — "Tasks" link + project-scoped deadline card.
- `src/pages/CustomerDetail.tsx` — "Tasks" link.

**Client tests**
- `src/components/tasks/UpcomingTasksCard.test.tsx` — `upcomingTaskItems` sort/overdue/filter/slice.

---

## Task 1: Migration 18 — relation columns

**Files:**
- Modify: `server/migrationList.ts:868` (append a new entry before the closing `];` on line 869)
- Test: `server/migrationList.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/migrationList.test.ts`:

```ts
describe('migration 18: task relations', () => {
  it('adds projectId and customerId columns to tasks', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 18));
    const cols = (db.prepare('PRAGMA table_info(tasks)').all() as any[]).map(c => c.name);
    expect(cols).toContain('projectId');
    expect(cols).toContain('customerId');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/migrationList.test.ts -t "task relations"`
Expected: FAIL — `expect(cols).toContain('projectId')` fails (column absent).

- [ ] **Step 3: Add the migration**

In `server/migrationList.ts`, insert this entry immediately before the closing `];` (currently line 869):

```ts
  {
    version: 18,
    name: 'task-relations',
    // ADDITIVE. A task may relate to a project and/or customer as its SUBJECT
    // (not its doer). Setting a project derives+locks its customer; that
    // invariant is enforced in taskStore, not here. Existing tasks stay NULL.
    up({ db }) {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN projectId TEXT;
        ALTER TABLE tasks ADD COLUMN customerId TEXT;
        CREATE INDEX idx_tasks_projectId ON tasks (projectId);
        CREATE INDEX idx_tasks_customerId ON tasks (customerId);
      `);
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/migrationList.test.ts -t "task relations"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/migrationList.ts server/migrationList.test.ts
git commit -m "feat(tasks): migration 18 adds projectId/customerId to tasks"
```

---

## Task 2: taskStore — relation validation, derivation, and read joins

**Files:**
- Modify: `server/taskStore.ts`
- Test: `server/taskStore.test.ts`

The rule: if a valid `projectId` is provided, `customerId` is forced to that project's customer (client's customer value ignored). If no project, `customerId` is the validated client value (or null). Unknown project/customer ids are rejected.

- [ ] **Step 1: Write the failing tests**

Add to `server/taskStore.test.ts`. First extend the `beforeEach` seed (right after the users INSERT) so projects/customers exist:

```ts
  db.prepare("INSERT INTO customers (id, name, createdAt) VALUES ('c1','Acme',0),('c2','Globex',0)").run();
  db.prepare("INSERT INTO projects (id, name, customerId, version, createdAt) VALUES ('p1','Plaza','c1',1,0),('p2','Tower',NULL,1,0)").run();
```

Then add a new describe block:

```ts
describe('task relations', () => {
  it('derives customer from project on create (client customer ignored)', () => {
    const { id } = createTask(db, { title: 'T', projectId: 'p1', customerId: 'c2' });
    const t = getTask(db, id)!;
    expect(t.projectId).toBe('p1');
    expect(t.customerId).toBe('c1'); // derived from p1, not the passed c2
    expect(t.projectName).toBe('Plaza');
    expect(t.customerName).toBe('Acme');
  });

  it('allows a customer-only task (no project)', () => {
    const { id } = createTask(db, { title: 'T', customerId: 'c2' });
    const t = getTask(db, id)!;
    expect(t.projectId).toBeNull();
    expect(t.customerId).toBe('c2');
    expect(t.customerName).toBe('Globex');
  });

  it('project with null customer yields null customerId', () => {
    const { id } = createTask(db, { title: 'T', projectId: 'p2' });
    const t = getTask(db, id)!;
    expect(t.projectId).toBe('p2');
    expect(t.customerId).toBeNull();
  });

  it('rejects unknown project or customer', () => {
    expect(() => createTask(db, { title: 'T', projectId: 'nope' })).toThrow(ValidationError);
    expect(() => createTask(db, { title: 'T', customerId: 'nope' })).toThrow(ValidationError);
  });

  it('clearing the project on save clears the derived customer', () => {
    const { id } = createTask(db, { title: 'T', projectId: 'p1' });
    const v = getTask(db, id)!.version;
    saveTask(db, id, { title: 'T', projectId: null, customerId: null, version: v });
    const t = getTask(db, id)!;
    expect(t.projectId).toBeNull();
    expect(t.customerId).toBeNull();
  });

  it('save can set a customer-only relation', () => {
    const { id } = createTask(db, { title: 'T' });
    const v = getTask(db, id)!.version;
    saveTask(db, id, { title: 'T', customerId: 'c1', version: v });
    expect(getTask(db, id)!.customerId).toBe('c1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/taskStore.test.ts -t "task relations"`
Expected: FAIL — `t.projectId` is `undefined` (not selected/derived yet).

- [ ] **Step 3: Add validation + derivation helpers**

In `server/taskStore.ts`, add these helpers after `validateDue` (around line 29):

```ts
function validateCustomerId(db: Database.Database, customerId: unknown): string | null {
  if (customerId === undefined || customerId === null || customerId === '') return null;
  if (typeof customerId !== 'string') throw new ValidationError('Invalid customer');
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) throw new ValidationError('Customer is not a known customer');
  return customerId;
}

// Resolve the (projectId, customerId) pair, enforcing the invariant that a
// project always dictates its own customer. Client-supplied customerId is only
// honored when no project is set.
function resolveRelations(db: Database.Database, projectId: unknown, customerId: unknown): { projectId: string | null; customerId: string | null } {
  if (projectId !== undefined && projectId !== null && projectId !== '') {
    if (typeof projectId !== 'string') throw new ValidationError('Invalid project');
    const row = db.prepare('SELECT customerId FROM projects WHERE id = ?').get(projectId) as { customerId: string | null } | undefined;
    if (!row) throw new ValidationError('Project is not a known project');
    return { projectId, customerId: row.customerId ?? null };
  }
  return { projectId: null, customerId: validateCustomerId(db, customerId) };
}
```

- [ ] **Step 4: Extend `TaskInput`, `createTask`, and `saveTask`**

Change the `TaskInput` interface (line 31-34) to add relation fields:

```ts
interface TaskInput {
  category?: string; title?: string; notes?: string;
  assigneeUserId?: string | null; dueDate?: string | null;
  projectId?: string | null; customerId?: string | null;
}
```

In `createTask`, after `const due = validateDue(input.dueDate);` add:

```ts
  const rel = resolveRelations(db, input.projectId, input.customerId);
```

Then change the INSERT to include the two columns. Replace the existing INSERT statement inside the transaction with:

```ts
    db.prepare(`INSERT INTO tasks (id, category, title, notes, assigneeUserId, status, dueDate, projectId, customerId, sortOrder, version, createdAt, createdBy)
      VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, (input.category ?? '').trim(), input.title!.trim(), (input.notes ?? '').trim(), assignee, due, rel.projectId, rel.customerId, max + 1, Date.now(), input.createdBy ?? null);
```

In `saveTask`, after `const due = validateDue(input.dueDate);` add:

```ts
  const rel = resolveRelations(db, input.projectId, input.customerId);
```

Then replace the UPDATE inside the transaction with:

```ts
    db.prepare('UPDATE tasks SET category = ?, title = ?, notes = ?, assigneeUserId = ?, dueDate = ?, projectId = ?, customerId = ?, version = ? WHERE id = ?')
      .run((input.category ?? '').trim(), input.title!.trim(), (input.notes ?? '').trim(), assignee, due, rel.projectId, rel.customerId, newVersion, id);
```

- [ ] **Step 5: Add the read joins**

Replace the SELECT in `getTask` (lines 37-40) with:

```ts
  const row = db.prepare(`
    SELECT t.*, u.username AS assigneeUsername, p.name AS projectName, c.name AS customerName
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigneeUserId
    LEFT JOIN projects p ON p.id = t.projectId
    LEFT JOIN customers c ON c.id = t.customerId
    WHERE t.id = ?`).get(id) as any;
```

Replace the SELECT in `listTasks` (lines 47-50) with:

```ts
  const rows = db.prepare(`
    SELECT t.*, u.username AS assigneeUsername, p.name AS projectName, c.name AS customerName
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigneeUserId
    LEFT JOIN projects p ON p.id = t.projectId
    LEFT JOIN customers c ON c.id = t.customerId
    ORDER BY t.category ASC, t.sortOrder ASC, t.createdAt ASC, t.rowid ASC`).all() as any[];
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run server/taskStore.test.ts`
Expected: PASS (all existing task tests + the new relations block).

- [ ] **Step 7: Commit**

```bash
git add server/taskStore.ts server/taskStore.test.ts
git commit -m "feat(tasks): derive+lock customer from project, join names on read"
```

---

## Task 3: taskStore — `listTasks` filters

**Files:**
- Modify: `server/taskStore.ts`
- Test: `server/taskStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a describe block to `server/taskStore.test.ts` (the seed from Task 2 already provides p1/p2/c1/c2):

```ts
describe('listTasks filters', () => {
  beforeEach(() => {
    createTask(db, { title: 'onP1', projectId: 'p1' });   // customer c1
    createTask(db, { title: 'onC2', customerId: 'c2' });
    createTask(db, { title: 'mineU2', assigneeUserId: 'u2' });
  });

  it('filters by projectId', () => {
    expect(listTasks(db, { projectId: 'p1' }).map(t => t.title)).toEqual(['onP1']);
  });
  it('filters by customerId (includes project-derived customers)', () => {
    expect(listTasks(db, { customerId: 'c1' }).map(t => t.title)).toEqual(['onP1']);
    expect(listTasks(db, { customerId: 'c2' }).map(t => t.title)).toEqual(['onC2']);
  });
  it('filters by assigneeUserId', () => {
    expect(listTasks(db, { assigneeUserId: 'u2' }).map(t => t.title)).toEqual(['mineU2']);
  });
  it('no filter returns all', () => {
    expect(listTasks(db).length).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/taskStore.test.ts -t "listTasks filters"`
Expected: FAIL — `listTasks` ignores the argument (returns all 3 every time).

- [ ] **Step 3: Add the filter argument**

Replace the `listTasks` signature and query construction (lines 46-52) with:

```ts
export function listTasks(db: Database.Database, filter: { projectId?: string; customerId?: string; assigneeUserId?: string } = {}): any[] {
  const where: string[] = [];
  const params: any[] = [];
  if (filter.projectId) { where.push('t.projectId = ?'); params.push(filter.projectId); }
  if (filter.customerId) { where.push('t.customerId = ?'); params.push(filter.customerId); }
  if (filter.assigneeUserId) { where.push('t.assigneeUserId = ?'); params.push(filter.assigneeUserId); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT t.*, u.username AS assigneeUsername, p.name AS projectName, c.name AS customerName
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigneeUserId
    LEFT JOIN projects p ON p.id = t.projectId
    LEFT JOIN customers c ON c.id = t.customerId
    ${whereSql}
    ORDER BY t.category ASC, t.sortOrder ASC, t.createdAt ASC, t.rowid ASC`).all(...params) as any[];
  return rows.map(r => ({ ...r, photoCount: photoCount(db, r.id) }));
}
```

(This replaces the whole `listTasks` body written in Task 2 Step 5 — the joins are preserved, filters added.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/taskStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/taskStore.ts server/taskStore.test.ts
git commit -m "feat(tasks): listTasks project/customer/assignee filters"
```

---

## Task 4: routes — `GET /api/tasks` query params

**Files:**
- Modify: `server/routes.ts:501-502`

- [ ] **Step 1: Update the route**

Replace the existing GET handler (lines 501-503) with one that forwards query params:

```ts
  app.get('/api/tasks', authenticateToken, (req, res) => {
    try {
      const { projectId, customerId, assigneeUserId } = req.query as Record<string, string | undefined>;
      res.json(listTasks(db, {
        ...(projectId ? { projectId } : {}),
        ...(customerId ? { customerId } : {}),
        ...(assigneeUserId ? { assigneeUserId } : {}),
      }));
    } catch (e) { taskErr(e, res); }
  });
```

- [ ] **Step 2: Verify the server type-checks and tests still pass**

Run: `npx vitest run server/routes.test.ts server/taskStore.test.ts`
Expected: PASS (no regression). The `POST`/`PUT` handlers already spread `req.body`, so `projectId`/`customerId` flow through automatically.

- [ ] **Step 3: Commit**

```bash
git add server/routes.ts
git commit -m "feat(tasks): GET /api/tasks accepts project/customer/assignee filters"
```

---

## Task 5: client store — types + relation fields + `getTasks(params)`

**Files:**
- Modify: `src/utils/store.ts:972-985` (interfaces), `:998-1021` (getTasks/createTask/saveTask)

- [ ] **Step 1: Extend the interfaces**

In `src/utils/store.ts`, add four fields to BOTH `Task` (line 972) and `TaskListItem` (line 979). For `Task` change it to:

```ts
export interface Task {
  id: string; category: string; title: string; notes: string;
  assigneeUserId: string | null; assigneeUsername: string | null;
  status: string; dueDate: string | null; sortOrder: number;
  projectId: string | null; customerId: string | null;
  projectName: string | null; customerName: string | null;
  version: number; createdAt: number; createdBy: string | null;
  photos: TaskPhoto[];
}
```

For `TaskListItem` change it to:

```ts
export interface TaskListItem {
  id: string; category: string; title: string; notes: string;
  assigneeUserId: string | null; assigneeUsername: string | null;
  status: string; dueDate: string | null; sortOrder: number;
  projectId: string | null; customerId: string | null;
  projectName: string | null; customerName: string | null;
  version: number; createdAt: number; createdBy: string | null;
  photoCount: number;
}
```

- [ ] **Step 2: Add filter params to `getTasks`**

Replace `getTasks` (lines 998-1001) with:

```ts
export const getTasks = async (params?: { projectId?: string; customerId?: string; assigneeUserId?: string }): Promise<TaskListItem[]> => {
  const qs = new URLSearchParams();
  if (params?.projectId) qs.set('projectId', params.projectId);
  if (params?.customerId) qs.set('customerId', params.customerId);
  if (params?.assigneeUserId) qs.set('assigneeUserId', params.assigneeUserId);
  const url = qs.toString() ? `/api/tasks?${qs.toString()}` : '/api/tasks';
  const res = await fetchWithRetry(url, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
```

- [ ] **Step 3: Send relation fields on create/save**

Replace `createTask` input type (line 1006) so it accepts the relations:

```ts
export const createTask = async (input: { category?: string; title: string; assigneeUserId?: string | null; dueDate?: string | null; notes?: string; projectId?: string | null; customerId?: string | null }): Promise<{ id: string }> => {
  const res = await taskJson('POST', '/api/tasks', input);
  await handleResponse(res); return res.json();
};
```

In `saveTask` (lines 1010-1021), add the two fields to the PUT body:

```ts
export const saveTask = async (id: string, task: Task): Promise<{ version: number }> => {
  const res = await taskJson('PUT', `/api/tasks/${id}`, {
    category: task.category,
    title: task.title,
    notes: task.notes,
    assigneeUserId: task.assigneeUserId,
    dueDate: task.dueDate,
    projectId: task.projectId,
    customerId: task.customerId,
    version: task.version,
  });
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
```

- [ ] **Step 4: Verify type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors from the store change).

- [ ] **Step 5: Commit**

```bash
git add src/utils/store.ts
git commit -m "feat(tasks): client store relation fields + getTasks filters"
```

---

## Task 6: TaskEditor — project/customer selects with lock

**Files:**
- Modify: `src/pages/tasks/TaskEditor.tsx`

The editor receives the projects & customers lists as props (the parent already loads them — see Task 7). Selecting a project locks the customer to that project's `customerId`.

- [ ] **Step 1: Extend props + imports**

In `src/pages/tasks/TaskEditor.tsx`, change the import from `../../utils/store` to also pull the summary types, and update `Props`:

```ts
import {
  Task, AssignableUser, ProjectSummary, saveTask, setTaskStatus, addTaskPhoto, removeTaskPhoto,
  saveFile, getImageUrl,
} from '../../utils/store';
```

```ts
interface Props {
  task: Task;
  users: AssignableUser[];
  projects: ProjectSummary[];
  customers: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}
```

Update the component signature: `export const TaskEditor: React.FC<Props> = ({ task, users, projects, customers, onClose, onSaved }) => {`

- [ ] **Step 2: Add relation state + derivation**

After the `dueDate` state (line 47), add:

```ts
  const [projectId, setProjectId] = useState<string | null>(task.projectId ?? null);
  const [customerId, setCustomerId] = useState<string | null>(task.customerId ?? null);

  // Selecting a project locks the customer to that project's customer.
  const onProjectChange = (next: string) => {
    if (next) {
      const p = projects.find(pr => pr.id === next);
      setProjectId(next);
      setCustomerId(p?.customerId ?? null);
    } else {
      setProjectId(null); // customer stays as-is; user may set it directly
    }
  };
```

Extend `dirty` (line 52-57) to include the relations:

```ts
  const dirty =
    category !== (task.category ?? '') ||
    title !== (task.title ?? '') ||
    notes !== (task.notes ?? '') ||
    assigneeUserId !== (task.assigneeUserId ?? null) ||
    dueDate !== (task.dueDate ?? '') ||
    projectId !== (task.projectId ?? null) ||
    customerId !== (task.customerId ?? null);
```

Update `handleSave` (line 62) to pass the relations:

```ts
      await saveTask(task.id, { ...task, category, title, notes, assigneeUserId, dueDate: dueDate || null, projectId, customerId });
```

- [ ] **Step 3: Render the two selects**

Insert this block right after the Assignee `<div>` (after line 125, before the Due date block):

```tsx
      <div className="mt-3">
        <Field label="Project" htmlFor="task-project">
          <Select id="task-project" value={projectId ?? ''} onChange={e => onProjectChange(e.target.value)}>
            <option value="">— none —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Customer" htmlFor="task-customer">
          <Select id="task-customer" value={customerId ?? ''} disabled={!!projectId}
            onChange={e => setCustomerId(e.target.value || null)}>
            <option value="">— none —</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          {projectId && <p className="mt-1 text-xs text-ink-faint">Set by the selected project.</p>}
        </Field>
      </div>
```

- [ ] **Step 4: Verify type-check**

Run: `npx tsc --noEmit`
Expected: FAIL only at `TasksPage.tsx` (it doesn't pass the new `projects`/`customers` props yet). The editor file itself must be error-free. If `TaskEditor.tsx` has its own errors, fix them. The `TasksPage` errors are resolved in Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/pages/tasks/TaskEditor.tsx
git commit -m "feat(tasks): project/customer selects with customer lock in editor"
```

---

## Task 7: TasksPage — create fields, filter dropdowns, URL params, banner

**Files:**
- Modify: `src/pages/TasksPage.tsx`

- [ ] **Step 1: Load projects & customers; add imports**

In `src/pages/TasksPage.tsx`, extend the store import (lines 5-8) to add loaders:

```ts
import {
  Task, TaskListItem, AssignableUser, ProjectSummary,
  getTasks, getTask, createTask, setTaskStatus, getAssignableUsers,
  getProjectsSummary, getCustomers,
} from '../utils/store';
```

Add state after `users` (line 35):

```ts
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
```

Add relation state to the create form after `newDue` (line 41):

```ts
  const [newProjectId, setNewProjectId] = useState<string>('');
  const [newCustomerId, setNewCustomerId] = useState<string>('');
```

In the mount `useEffect` (lines 49-52), also load projects/customers:

```ts
  useEffect(() => {
    reload();
    getAssignableUsers().then(setUsers).catch(() => setUsers([]));
    getProjectsSummary().then(ps => setProjects(ps.filter(p => !p.archived))).catch(() => setProjects([]));
    getCustomers().then((cs: any[]) => setCustomers(cs.map(c => ({ id: c.id, name: c.name })))).catch(() => setCustomers([]));
  }, []);
```

- [ ] **Step 2: Read project/customer from the URL and reload filtered**

Replace `reload` (line 47) so it honors URL scope, and add a scope memo. First change `reload`:

```ts
  const reload = () => {
    const projectId = searchParams.get('projectId') || undefined;
    const customerId = searchParams.get('customerId') || undefined;
    getTasks({ projectId, customerId }).then(setTasks).catch(() => setTasks([]));
  };
```

Note: `searchParams`/`setSearchParams` are declared lower down (line 55). Move that declaration ABOVE `reload` — cut the line `const [searchParams, setSearchParams] = useSearchParams();` from line 55 and paste it just after the `useToast()`/state declarations (before `reload` on line 47).

Make `reload` re-run when the scope changes — replace the mount effect dependency by adding a second effect after it:

```ts
  // Re-fetch when the project/customer scope in the URL changes.
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [searchParams.get('projectId'), searchParams.get('customerId')]);
```

Add derived scope values (after the `list` const, line 65):

```ts
  const scopeProjectId = searchParams.get('projectId') || '';
  const scopeCustomerId = searchParams.get('customerId') || '';
  const scopeProjectName = projects.find(p => p.id === scopeProjectId)?.name;
  const scopeCustomerName = customers.find(c => c.id === scopeCustomerId)?.name;

  const setScope = (key: 'projectId' | 'customerId', value: string) => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      // project and customer scope are mutually exclusive in the filter bar
      p.delete('projectId'); p.delete('customerId');
      if (value) p.set(key, value);
      return p;
    }, { replace: true });
  };
```

- [ ] **Step 3: Pre-fill the create form from the active scope**

Add an effect after the scope block so creating a task from a scoped view links it:

```ts
  useEffect(() => {
    setNewProjectId(scopeProjectId);
    setNewCustomerId(scopeProjectId ? '' : scopeCustomerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeProjectId, scopeCustomerId]);
```

Update `addTask` (lines 114-129) to send relations and honor the project→customer lock:

```ts
  const addTask = async () => {
    if (!newTitle.trim()) { toast('Enter a title', { type: 'warning' }); return; }
    try {
      await createTask({
        category: newCategory.trim(),
        title: newTitle.trim(),
        assigneeUserId: newAssignee || null,
        dueDate: newDue || null,
        projectId: newProjectId || null,
        customerId: newProjectId ? null : (newCustomerId || null), // project derives its own customer server-side
      });
      setNewCategory(''); setNewTitle(''); setNewAssignee(''); setNewDue('');
      reload();
    } catch { toast('Failed to create task', { type: 'error' }); }
  };
```

- [ ] **Step 4: Render the scope banner + filter dropdowns**

Immediately after the filter toolbar `</div>` (line 154), insert the scope banner + filter row:

```tsx
      {(scopeProjectName || scopeCustomerName) && (
        <div className="mb-4 flex items-center justify-between gap-2 rounded-lg bg-accent-50 px-3 py-2 text-sm dark:bg-accent-950/30">
          <span className="text-ink-soft">
            Showing tasks for <span className="font-semibold text-ink">{scopeProjectName ?? scopeCustomerName}</span>
          </span>
          <button type="button" onClick={() => setScope('projectId', '')}
            className="shrink-0 text-xs font-medium text-accent-600 hover:underline">Clear</button>
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-end gap-2">
        <Field label="Project" htmlFor="filter-project">
          <Select id="filter-project" value={scopeProjectId} onChange={e => setScope('projectId', e.target.value)} className="w-48">
            <option value="">All projects</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Customer" htmlFor="filter-customer">
          <Select id="filter-customer" value={scopeCustomerId} onChange={e => setScope('customerId', e.target.value)} className="w-48">
            <option value="">All customers</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      </div>
```

- [ ] **Step 5: Add project/customer to the create form**

Inside the create-form `<div className="flex flex-wrap items-end gap-2">` (after the Due `Field`, before the Add `Button` on line 185), insert:

```tsx
            <Field label="Project" htmlFor="new-task-project">
              <Select id="new-task-project" value={newProjectId}
                onChange={e => { setNewProjectId(e.target.value); if (e.target.value) setNewCustomerId(''); }} className="w-44">
                <option value="">— none —</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Customer" htmlFor="new-task-customer">
              <Select id="new-task-customer" value={newProjectId ? (projects.find(p => p.id === newProjectId)?.customerId ?? '') : newCustomerId}
                disabled={!!newProjectId}
                onChange={e => setNewCustomerId(e.target.value)} className="w-44">
                <option value="">— none —</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
```

- [ ] **Step 6: Show the relation on each task row + pass props to editor**

In the task row, add a chip after the assignee span (after line 218, before `<TaskStatusPill>` on line 219):

```tsx
                          {(t.projectName || t.customerName) && (
                            <span className="shrink-0 truncate text-xs text-accent-600 dark:text-accent-400" title={t.projectName ?? t.customerName ?? ''}>
                              {t.projectName ?? t.customerName}
                            </span>
                          )}
```

Update the `<TaskEditor>` render (lines 242-248) to pass the new props:

```tsx
        <TaskEditor
          key={`${editing.id}:${editing.version}`}
          task={editing}
          users={users}
          projects={projects}
          customers={customers}
          onClose={() => setEditing(null)}
          onSaved={async () => { try { setEditing(await getTask(editing.id)); } catch { setEditing(null); } reload(); }}
        />
```

- [ ] **Step 7: Verify type-check + run tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (all tests green, no type errors).

- [ ] **Step 8: Commit**

```bash
git add src/pages/TasksPage.tsx
git commit -m "feat(tasks): project/customer create fields, filter dropdowns, scope banner"
```

---

## Task 8: UpcomingTasksCard — reusable component + helper

**Files:**
- Create: `src/components/tasks/UpcomingTasksCard.tsx`
- Test: `src/components/tasks/UpcomingTasksCard.test.tsx`

- [ ] **Step 1: Write the failing test for the helper**

Create `src/components/tasks/UpcomingTasksCard.test.tsx`:

```ts
import { describe, it, expect } from 'vitest';
import { upcomingTaskItems } from './UpcomingTasksCard';

const mk = (id: string, dueDate: string | null, status = 'todo') =>
  ({ id, title: id, dueDate, status } as any);

describe('upcomingTaskItems', () => {
  it('keeps only dated, not-done tasks, sorted soonest first', () => {
    const out = upcomingTaskItems([
      mk('c', '2026-08-01'),
      mk('a', '2026-06-01'),
      mk('nodate', null),
      mk('done', '2026-05-01', 'done'),
      mk('b', '2026-07-01'),
    ]);
    expect(out.map(t => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('limits to the given count', () => {
    const items = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'].map((d, i) => mk(`t${i}`, d));
    expect(upcomingTaskItems(items, 2).map(t => t.id)).toEqual(['t0', 't1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/tasks/UpcomingTasksCard.test.tsx`
Expected: FAIL — module `./UpcomingTasksCard` does not exist.

- [ ] **Step 3: Create the component + helper**

Create `src/components/tasks/UpcomingTasksCard.tsx`:

```tsx
import React from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { Card, CardHeader, CardBody, EmptyState, Skeleton } from '../ui';

export interface UpcomingTaskItem {
  id: string;
  title: string;
  dueDate: string | null;
  status: string;
  projectName?: string | null;
  customerName?: string | null;
}

// Pure: dated + not-done, soonest first, capped. Dates are ISO 'YYYY-MM-DD'
// so lexical comparison equals chronological comparison.
export function upcomingTaskItems<T extends UpcomingTaskItem>(tasks: T[], limit = 5): T[] {
  return tasks
    .filter(t => !!t.dueDate && t.status !== 'done')
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : 0))
    .slice(0, limit);
}

const todayISO = () => new Date().toISOString().slice(0, 10);

interface Props {
  items: UpcomingTaskItem[];
  loading: boolean;
  title?: string;
  headerActions?: React.ReactNode;
  showContext?: boolean;
  emptyDescription?: string;
  to?: string; // where a row/"view" link points; defaults to /tasks
}

export const UpcomingTasksCard: React.FC<Props> = ({
  items, loading, title = 'Upcoming task deadlines', headerActions,
  showContext = false, emptyDescription = 'Tasks with due dates show up here.', to = '/tasks',
}) => {
  const today = todayISO();
  return (
    <Card>
      <CardHeader title={title} actions={headerActions ?? <CalendarClock size={15} className="text-ink-faint" />} />
      <CardBody className="p-0">
        {loading ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
        ) : items.length === 0 ? (
          <EmptyState title="No upcoming tasks" description={emptyDescription} />
        ) : (
          <ul className="divide-y divide-edge">
            {items.map(t => {
              const overdue = !!t.dueDate && t.dueDate < today;
              const context = t.projectName ?? t.customerName;
              return (
                <li key={t.id}>
                  <Link to={to} className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-hover">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{t.title || '(untitled)'}</span>
                      {showContext && context && <span className="block truncate text-xs text-ink-faint">{context}</span>}
                    </span>
                    <span className={`shrink-0 text-xs font-medium tabular-nums ${overdue ? 'text-red-600 dark:text-red-400' : 'text-ink-soft'}`}>
                      {t.dueDate}{overdue ? ' · overdue' : ''}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/tasks/UpcomingTasksCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/tasks/UpcomingTasksCard.tsx src/components/tasks/UpcomingTasksCard.test.tsx
git commit -m "feat(tasks): reusable UpcomingTasksCard + upcomingTaskItems helper"
```

---

## Task 9: Dashboard — upcoming tasks card with my/all toggle

**Files:**
- Modify: `src/pages/Dashboard.tsx`

- [ ] **Step 1: Add imports + state**

In `src/pages/Dashboard.tsx`, extend the store import (lines 5-8) to add tasks:

```ts
import {
  ProjectSummary, ActivityItem, TimeEntryLite, TaskListItem,
  getProjectsSummary, getActivity, getMyTimeEntries, getTasks,
} from '../utils/store';
```

Add the card import after the ui import block (after line 11):

```ts
import { UpcomingTasksCard, upcomingTaskItems } from '../components/tasks/UpcomingTasksCard';
```

Add state after `hours` (line 52):

```ts
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const [taskScope, setTaskScope] = useState<'mine' | 'all'>('mine');
```

Load tasks in the mount effect (after line 58):

```ts
    getTasks().then(setTasks).catch(() => setTasks([]));
```

- [ ] **Step 2: Compute the items**

After the `activeProjects` block (line 69), add:

```ts
  const taskList = tasks ?? [];
  const scopedTasks = taskScope === 'mine' ? taskList.filter(t => t.assigneeUserId === user.id) : taskList;
  const upcomingTasks = upcomingTaskItems(scopedTasks);
```

- [ ] **Step 3: Render the card**

Add this card inside the grid, right after the "Upcoming bid deadlines" `</Card>` (after line 113):

```tsx
        {/* Upcoming task deadlines */}
        <UpcomingTasksCard
          items={upcomingTasks}
          loading={tasks === null}
          showContext
          emptyDescription={taskScope === 'mine' ? 'Tasks assigned to you with due dates show up here.' : 'Tasks with due dates show up here.'}
          headerActions={
            <div className="flex rounded-lg bg-sunken p-0.5 text-xs">
              {(['mine', 'all'] as const).map(s => (
                <button key={s} type="button" onClick={() => setTaskScope(s)}
                  className={`rounded-md px-2 py-1 font-medium transition-colors ${taskScope === s ? 'bg-raised text-ink shadow-sm' : 'text-ink-faint hover:text-ink'}`}>
                  {s === 'mine' ? 'Mine' : 'All'}
                </button>
              ))}
            </div>
          }
        />
```

- [ ] **Step 4: Verify type-check + tests**

Run: `npx tsc --noEmit && npx vitest run src/pages/Dashboard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Dashboard.tsx
git commit -m "feat(tasks): dashboard upcoming-tasks card with mine/all toggle"
```

---

## Task 10: ProjectView — Tasks link + project deadline card

**Files:**
- Modify: `src/pages/ProjectView.tsx`

- [ ] **Step 1: Add imports + state**

In `src/pages/ProjectView.tsx`, add to the lucide import a suitable icon (find the existing `lucide-react` import and add `ListChecks`). Add to the store import: `TaskListItem, getTasks`. Add the card import near the other component imports (e.g. after the ProjectTakeoffsTab import on line 39):

```ts
import { UpcomingTasksCard, upcomingTaskItems } from '../components/tasks/UpcomingTasksCard';
```

Add state near the other `useState` hooks in the component (alongside `project`):

```ts
  const [projectTasks, setProjectTasks] = useState<TaskListItem[] | null>(null);
```

- [ ] **Step 2: Load this project's tasks**

Add an effect (place it near the other data-loading effects that key off `projectId`):

```ts
  useEffect(() => {
    if (!projectId) return;
    getTasks({ projectId }).then(setProjectTasks).catch(() => setProjectTasks([]));
  }, [projectId]);
```

- [ ] **Step 3: Add the "Tasks" button**

In the button row containing "Notes Board" (lines 1873-1881), add a second button right after the Notes Board `</button>`:

```tsx
              <button
                onClick={() => navigate(`/tasks?projectId=${projectId}`)}
                className="px-3 py-1 rounded-full text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all border bg-white text-accent-600 border-accent-200 hover:border-accent-400 hover:bg-accent-50 flex items-center gap-1.5 shadow-sm"
              >
                <ListChecks size={14} />
                Tasks
              </button>
```

- [ ] **Step 4: Render the project deadline card**

Place a project-scoped card just below the header metadata grid (after the closing `</div>` of the `grid ... text-slate-500` block that starts on line 1883 — locate its matching close, which is before the tab bar). Insert:

```tsx
            <div className="mt-4 md:mt-6 max-w-md">
              <UpcomingTasksCard
                items={upcomingTaskItems(projectTasks ?? [])}
                loading={projectTasks === null}
                title="Upcoming tasks"
                to={`/tasks?projectId=${projectId}`}
                emptyDescription="Tasks linked to this project with due dates show up here."
                headerActions={
                  <Link to={`/tasks?projectId=${projectId}`} className="text-xs font-medium text-accent-600 hover:underline">View all</Link>
                }
              />
            </div>
```

If a `Link` import is not already present in this file, note that line 2 imports from `react-router-dom` — confirm `Link` is in that import list; it is (see line 2). If not, add it.

- [ ] **Step 5: Verify type-check + tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. Manually confirm the card renders under the header and the Tasks button navigates to `/tasks?projectId=…`.

- [ ] **Step 6: Commit**

```bash
git add src/pages/ProjectView.tsx
git commit -m "feat(tasks): project Tasks link + upcoming-tasks card on project home"
```

---

## Task 11: CustomerDetail — Tasks link

**Files:**
- Modify: `src/pages/CustomerDetail.tsx`

- [ ] **Step 1: Add a Tasks button in the header actions**

In `src/pages/CustomerDetail.tsx`, the header action buttons live near line 284-301 (the edit/merge/delete `Button`s). Add a Tasks button that navigates to the filtered task list. Add `ListChecks` to the `lucide-react` import, then add this button alongside the existing header buttons (e.g. right before the merge/delete buttons around line 284):

```tsx
            <Button variant="secondary" size="sm" onClick={() => navigate(`/tasks?customerId=${customer.id}`)}>
              <ListChecks size={15} />
              Tasks
            </Button>
```

(`navigate` is already available from `useNavigate()` — see line 3 import and its use at line 251. `customer` is the loaded record used for `customer.name` at line 274.)

- [ ] **Step 2: Verify type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/pages/CustomerDetail.tsx
git commit -m "feat(tasks): customer Tasks link to filtered task list"
```

---

## Task 12: Full verification + push

- [ ] **Step 1: Run the whole test suite + type-check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All green.

- [ ] **Step 2: Manual smoke (dev server)**

Start the app, then verify:
1. Create a task with a Project selected → Customer auto-fills and is disabled.
2. From a Project page, click "Tasks" → the list is scoped, banner shows, a new task there is pre-linked to the project.
3. From a Customer page, click "Tasks" → scoped to that customer.
4. Dashboard shows "Upcoming task deadlines" with a Mine/All toggle; overdue in red, soonest first.
5. Project home shows "Upcoming tasks" scoped to that project.

- [ ] **Step 3: Push to testing**

```bash
git push origin testing
```

---

## Notes for the implementer

- **Money/dates:** task `dueDate` is an ISO `YYYY-MM-DD` string (not epoch ms like `bidDueDate`). The `UpcomingTasksCard` compares strings lexically — do not convert to `Date` for sorting.
- **Derivation lives on the server.** The client lock/pre-fill is a convenience; even if the client sent a mismatched `customerId` alongside a `projectId`, `resolveRelations` overrides it. Never duplicate the derivation as the source of truth on the client.
- **`getProjectsSummary()`** returns archived projects too — filter `!p.archived` for the selects (already done in Task 7 Step 1).
- **Follow existing patterns:** `Field`/`Select`/`Card`/`CardHeader`/`EmptyState` from `../components/ui`; toast via `useToast`.
