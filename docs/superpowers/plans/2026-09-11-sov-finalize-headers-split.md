# SOV Finalize, Header/Blank Lines, and Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock a project's schedule of values (manually or when its first pay application is created), let the SOV carry label-only header rows and blank spacer rows everywhere (editor, pay-app editor, Excel), and split one item line into percentage-valued children under the original as a header.

**Architecture:** A new `aia_sov_locks` table (row present = locked) is checked at the top of every SOV mutator in `server/aiaStore.ts`; `syncChangeOrders` is exempt. A `lineType` column on `aia_sov_lines` (`item` default) flows through `computeG703` rows so every consumer can render headers/blanks in position while every sum iterates item rows only. Reorder, insert-above, and split are new store functions with routes; the client SOV editor gains lock/unlock controls, two sections (contract vs change orders), row actions, and a split modal.

**Tech Stack:** TypeScript, Express + better-sqlite3 (server), React + Tailwind + vitest/testing-library (client), exceljs (export), Playwright (e2e). Money is INTEGER CENTS everywhere.

**Spec:** `docs/superpowers/specs/2026-09-11-sov-finalize-headers-split-design.md`

## Global Constraints

- All money is integer cents; never sum-then-round in a way that drifts (see the header comment of `server/aiaStore.ts`).
- Never use `crypto.randomUUID` in **client** code (plain-HTTP LAN deployment has no secure context). Server code may use Node's `crypto.randomUUID()` as `aiaStore.ts` already does.
- All AIA routes are `authenticateToken, requireAdmin`.
- Migration 35 is additive (one column, one table, lock backfill for projects that already have pay apps). Replaying `up()` must be a no-op.
- Lock error surfaces as HTTP 409 `{ error, code: 'sov_locked' }`; version conflicts stay 409 `{ code: 'version_conflict' }`.
- Existing route response shapes are unchanged (the SOV list stays a plain array).
- Run `npm test -- <paths>` for targeted vitest, `npm run lint` (tsc --noEmit) before every commit. Playwright: `npx playwright test <spec>`.
- Commit after every task; do not push until the whole plan is done.

---

## File map

| File | Responsibility |
|---|---|
| `server/migrationList.ts` | migration 35: `lineType` column, `aia_sov_locks` table, backfill |
| `server/migrationList.test.ts` | migration 35 tests |
| `server/aiaStore.ts` | lock primitives, `SovLockedError`, `lineType` validation, item-only sums, `reorderSovLines`, `insertBeforeId`, `splitSovLine` |
| `server/aiaStore.test.ts` | store tests for all of the above |
| `server/billingStore.ts` | contract base sums item rows only |
| `server/billingStore.test.ts` | one test for that |
| `server/routes.ts` | lock GET/POST/DELETE, order PUT, split POST, `aiaErr` mapping |
| `server/routes.test.ts` | route tests |
| `src/utils/store.ts` | client types + helpers (`getSovLock`, `lockSov`, `unlockSov`, `reorderSov`, `splitSovLine`, `SovLockedError`) |
| `src/pages/project/billing/aiaExcel.ts` | header/blank rows in G703 (default + template) |
| `src/pages/project/billing/aiaExcel.test.ts` | geometry test with header + blank |
| `src/pages/project/billing/aiaExportShared.ts` | carry `lineType` into the blank SOV context |
| `src/pages/project/billing/AiaPayAppEditor.tsx` (+test) | render header/blank rows without inputs |
| `src/pages/project/billing/AiaPayApplications.tsx` (+test) | "first application finalizes the SOV" note |
| `src/pages/project/billing/AiaScheduleOfValues.tsx` (+test) | lock chip/finalize/reopen, locked state, contract vs CO sections, line types, row actions |
| `src/pages/project/billing/SplitSovLineModal.tsx` (+test) | split modal |
| `e2e/aia-sov-finalize.spec.ts` | end-to-end flow |
| `src/pages/Settings.tsx` | changelog entry |

---

### Task 1: Migration 35 — `lineType` column, `aia_sov_locks`, lock backfill

**Files:**
- Modify: `server/migrationList.ts` (append after the `version: 34` entry, before the closing `];`)
- Test: `server/migrationList.test.ts` (append at end)

**Interfaces:**
- Produces: column `aia_sov_lines.lineType TEXT NOT NULL DEFAULT 'item'`; table `aia_sov_locks (projectId PK, lockedAt, lockedByUserId, reason)`.

- [ ] **Step 1: Write the failing tests**

Append to `server/migrationList.test.ts`:

```ts
describe('migration 35: sov-line-types-and-locks', () => {
  it('adds lineType (default item) and creates aia_sov_locks; re-runs as a no-op', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 34));
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p1', 'Job', 1, 1, 1, '{}')`).run();
    db.prepare(`INSERT INTO aia_sov_lines (id, projectId, itemNo, description, scheduledValueCents, retainagePercent, isChangeOrder, changeOrderId, sortOrder, version, createdAt)
                VALUES ('s1', 'p1', '1', 'Framing', 1000, NULL, 0, NULL, 0, 1, 1)`).run();
    runMigrations(db, dir, migrations.filter(m => m.version <= 35));
    expect(columnNames(db, 'aia_sov_lines')).toContain('lineType');
    expect((db.prepare('SELECT lineType FROM aia_sov_lines WHERE id = ?').get('s1') as any).lineType).toBe('item');
    expect(tableNames(db)).toContain('aia_sov_locks');
    // replay is a no-op
    const m35 = migrations.find(m => m.version === 35)!;
    expect(() => m35.up({ db, dataDir: dir } as any)).not.toThrow();
    expect(columnNames(db, 'aia_sov_lines').filter(c => c === 'lineType').length).toBe(1);
    db.close();
  });

  it('locks every project that already has a pay application, and leaves the rest unlocked', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 34));
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('billed', 'Billed', 1, 1, 1, '{}')`).run();
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('fresh', 'Fresh', 1, 1, 1, '{}')`).run();
    db.prepare(`INSERT INTO aia_pay_apps (id, projectId, number, periodTo, applicationDate, retainagePercent, storedRetainagePercent, status, version, createdAt, updatedAt)
                VALUES ('pa2', 'billed', 2, NULL, NULL, 10, 10, 'draft', 1, 5000, 5000)`).run();
    db.prepare(`INSERT INTO aia_pay_apps (id, projectId, number, periodTo, applicationDate, retainagePercent, storedRetainagePercent, status, version, createdAt, updatedAt)
                VALUES ('pa1', 'billed', 1, NULL, NULL, 10, 10, 'finalized', 1, 4000, 4000)`).run();
    runMigrations(db, dir, migrations.filter(m => m.version <= 35));
    const lock = db.prepare('SELECT * FROM aia_sov_locks WHERE projectId = ?').get('billed') as any;
    expect(lock).toBeTruthy();
    expect(lock.reason).toBe('pay-app');
    expect(lock.lockedByUserId).toBeNull();
    expect(lock.lockedAt).toBe(4000); // earliest pay app's createdAt
    expect(db.prepare('SELECT * FROM aia_sov_locks WHERE projectId = ?').get('fresh')).toBeUndefined();
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- server/migrationList.test.ts -t "migration 35"`
Expected: FAIL — `lineType` column missing / `aia_sov_locks` table missing.

- [ ] **Step 3: Add migration 35**

In `server/migrationList.ts`, after the `version: 34` object (just before the final `];`):

```ts
  {
    version: 35,
    name: 'sov-line-types-and-locks',
    // ADDITIVE. lineType ('item' | 'header' | 'blank') lets a schedule of
    // values carry label-only header rows and blank spacers; the default keeps
    // every existing row an item. aia_sov_locks (row present = locked) is what
    // stops SOV edits from silently rewriting prior pay applications — see
    // docs/superpowers/specs/2026-09-11-sov-finalize-headers-split-design.md.
    // Backfill: any project that already has a pay application is locked
    // (reason 'pay-app', lockedAt = its earliest app), so existing projects
    // follow the new rule from day one. An admin can reopen in one click.
    up({ db }) {
      const cols = (db.prepare(`PRAGMA table_info(aia_sov_lines)`).all() as any[]).map((c: any) => c.name);
      if (!cols.includes('lineType')) {
        db.exec(`ALTER TABLE aia_sov_lines ADD COLUMN lineType TEXT NOT NULL DEFAULT 'item';`);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS aia_sov_locks (
          projectId      TEXT PRIMARY KEY,
          lockedAt       INTEGER NOT NULL,
          lockedByUserId TEXT,
          reason         TEXT NOT NULL
        );
      `);
      const r = db.prepare(`
        INSERT OR IGNORE INTO aia_sov_locks (projectId, lockedAt, lockedByUserId, reason)
        SELECT projectId, MIN(createdAt), NULL, 'pay-app' FROM aia_pay_apps GROUP BY projectId
      `).run();
      if (r.changes > 0) console.log(`[migration 35] locked the schedule of values on ${r.changes} project(s) that already have pay applications`);
    },
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- server/migrationList.test.ts`
Expected: PASS (all migration tests, including the two new ones).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run lint
git add server/migrationList.ts server/migrationList.test.ts
git commit -m "feat(aia): migration 35 — SOV line types + lock table with pay-app backfill"
```

---

### Task 2: Lock primitives in `aiaStore` + enforcement + auto-lock on first pay app

**Files:**
- Modify: `server/aiaStore.ts` (top: error classes; after `touchProjectPayApps`; `createSovLine`, `saveSovLine`, `deleteSovLine`, `seedSovLines`, `createPayApp`)
- Test: `server/aiaStore.test.ts`

**Interfaces:**
- Produces:
  - `export class SovLockedError extends Error {}`
  - `export type SovLockReason = 'manual' | 'pay-app'`
  - `export interface SovLock { projectId: string; lockedAt: number; lockedByUserId: string | null; reason: SovLockReason }`
  - `export function getSovLock(db, projectId): SovLock | null`
  - `export function lockSov(db, projectId, opts: { userId: string | null; reason: SovLockReason }): SovLock` (idempotent: returns the existing lock untouched)
  - `export function unlockSov(db, projectId): void`
  - `export function assertSovEditable(db, projectId): void` (throws `SovLockedError`)

- [ ] **Step 1: Write the failing tests**

In `server/aiaStore.test.ts`, extend the import from `./aiaStore` to add `getSovLock, lockSov, unlockSov, assertSovEditable, SovLockedError`, then append:

```ts
describe('SOV lock', () => {
  it('lockSov / getSovLock / unlockSov round-trip; lock is idempotent and keeps the first cause', () => {
    expect(getSovLock(db, 'p1')).toBeNull();
    const first = lockSov(db, 'p1', { userId: 'u1', reason: 'manual' });
    expect(first.reason).toBe('manual');
    expect(first.lockedByUserId).toBe('u1');
    const again = lockSov(db, 'p1', { userId: null, reason: 'pay-app' });
    expect(again.reason).toBe('manual'); // untouched
    expect(getSovLock(db, 'p1')!.lockedAt).toBe(first.lockedAt);
    unlockSov(db, 'p1');
    expect(getSovLock(db, 'p1')).toBeNull();
  });

  it('lockSov rejects an unknown project', () => {
    expect(() => lockSov(db, 'nope', { userId: null, reason: 'manual' })).toThrow(NotFoundError);
  });

  it('every SOV mutator throws SovLockedError while locked; sync of approved COs still appends', () => {
    const { id } = createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 1000 });
    lockSov(db, 'p1', { userId: 'u1', reason: 'manual' });
    expect(() => assertSovEditable(db, 'p1')).toThrow(SovLockedError);
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 1 })).toThrow(SovLockedError);
    expect(() => saveSovLine(db, id, { description: 'Y', scheduledValueCents: 2, version: 1 })).toThrow(SovLockedError);
    expect(() => deleteSovLine(db, id)).toThrow(SovLockedError);
    expect(() => seedSovLines(db, 'p1', [{ description: 'Z', scheduledValueCents: 3 }])).toThrow(SovLockedError);
    // nothing changed
    expect(listSovLines(db, 'p1').map(l => l.description)).toEqual(['Framing']);
    insertChangeOrder('co1', 'p1', '1', 'Extra', 250, 'approved');
    expect(syncChangeOrders(db, 'p1').added).toBe(1);
    expect(listSovLines(db, 'p1').length).toBe(2);
  });

  it('unlock stamps the project pay apps so exports read out of date', () => {
    createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 1000 });
    const { id: appId } = createPayApp(db, 'p1', {});
    const before = (db.prepare('SELECT updatedAt FROM aia_pay_apps WHERE id = ?').get(appId) as any).updatedAt;
    db.prepare('UPDATE aia_pay_apps SET updatedAt = ? WHERE id = ?').run(before - 10_000, appId);
    unlockSov(db, 'p1');
    const after = (db.prepare('SELECT updatedAt FROM aia_pay_apps WHERE id = ?').get(appId) as any).updatedAt;
    expect(after).toBeGreaterThan(before - 10_000);
  });

  it('creating the first pay application locks the SOV with reason pay-app, and does not overwrite a manual lock', () => {
    createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 1000 });
    expect(getSovLock(db, 'p1')).toBeNull();
    createPayApp(db, 'p1', {});
    expect(getSovLock(db, 'p1')!.reason).toBe('pay-app');
    expect(getSovLock(db, 'p1')!.lockedByUserId).toBeNull();

    createSovLine(db, 'p2', { description: 'Roof', scheduledValueCents: 500 });
    lockSov(db, 'p2', { userId: 'u9', reason: 'manual' });
    createPayApp(db, 'p2', {});
    expect(getSovLock(db, 'p2')!.reason).toBe('manual');
    expect(getSovLock(db, 'p2')!.lockedByUserId).toBe('u9');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- server/aiaStore.test.ts -t "SOV lock"`
Expected: FAIL — `getSovLock is not a function` (import error).

- [ ] **Step 3: Implement the lock primitives**

In `server/aiaStore.ts`, after `export class NotFoundError extends Error {}` add:

```ts
// Thrown by every SOV mutator once the schedule of values is finalized.
// Routes map it to 409 { code: 'sov_locked' }.
export class SovLockedError extends Error {
  constructor() { super('Schedule of values is finalized — reopen it to make changes'); }
}

export type SovLockReason = 'manual' | 'pay-app';
export interface SovLock { projectId: string; lockedAt: number; lockedByUserId: string | null; reason: SovLockReason }
```

After `touchProjectPayApps` add:

```ts
// ---------------------------------------------------------------------------
// SOV lock (spec 2026-09-11 §Lock). A row in aia_sov_locks = finalized. Every
// mutator below calls assertSovEditable first; syncChangeOrders deliberately
// does NOT (an approved change order appends a CO line — that is how a G703
// grows — and it never touches existing lines).
// ---------------------------------------------------------------------------
export function getSovLock(db: Database.Database, projectId: string): SovLock | null {
  const row = db.prepare('SELECT projectId, lockedAt, lockedByUserId, reason FROM aia_sov_locks WHERE projectId = ?').get(projectId) as SovLock | undefined;
  return row ?? null;
}

// Idempotent: an existing lock is returned untouched so the FIRST cause
// (manual vs pay-app) is what the UI reports.
export function lockSov(db: Database.Database, projectId: string, opts: { userId: string | null; reason: SovLockReason }): SovLock {
  requireProject(db, projectId);
  const existing = getSovLock(db, projectId);
  if (existing) return existing;
  const lock: SovLock = { projectId, lockedAt: Date.now(), lockedByUserId: opts.userId ?? null, reason: opts.reason };
  db.prepare('INSERT INTO aia_sov_locks (projectId, lockedAt, lockedByUserId, reason) VALUES (?, ?, ?, ?)')
    .run(lock.projectId, lock.lockedAt, lock.lockedByUserId, lock.reason);
  return lock;
}

// Reopening makes every stored export potentially stale — the admin was warned.
export function unlockSov(db: Database.Database, projectId: string): void {
  requireProject(db, projectId);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM aia_sov_locks WHERE projectId = ?').run(projectId);
    touchProjectPayApps(db, projectId, Date.now());
  });
  tx();
}

export function assertSovEditable(db: Database.Database, projectId: string): void {
  if (getSovLock(db, projectId)) throw new SovLockedError();
}
```

Then add the guard to each mutator:

- `createSovLine`: after `requireProject(db, projectId);` add `assertSovEditable(db, projectId);`
- `saveSovLine`: inside the transaction, right after the `if (!row) throw new NotFoundError('SOV line not found');` line add `assertSovEditable(db, row.projectId);`
- `deleteSovLine`: inside the transaction, after reading `row`, add `if (row) assertSovEditable(db, row.projectId);` (before the DELETE)
- `seedSovLines`: after `requireProject(db, projectId);` add `assertSovEditable(db, projectId);`
- `createPayApp`: inside `tx`, as the first statement, add:

```ts
    // Spec: the first application finalizes the SOV. Idempotent, so a manual
    // lock keeps its cause.
    lockSov(db, projectId, { userId: null, reason: 'pay-app' });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- server/aiaStore.test.ts`
Expected: PASS. If any existing test fails because it edits the SOV after creating a pay app, that test now documents the old unsafe behavior — read it; if it is only exercising math (not the lock), insert `unlockSov(db, 'p1')` right after its `createPayApp` call and keep the assertion. Note every such edit in the commit message.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run lint
git add server/aiaStore.ts server/aiaStore.test.ts
git commit -m "feat(aia): SOV lock primitives, mutator guards, auto-lock on first pay app"
```

---

### Task 3: Lock routes + `aiaErr` mapping

**Files:**
- Modify: `server/routes.ts` (import block ~54-60; `aiaErr` ~458; after the `sync-change-orders` route ~509)
- Test: `server/routes.test.ts` (inside the AIA describe, after the `PUT SOV line is version-checked` test)

**Interfaces:**
- Produces routes:
  - `GET /api/projects/:id/aia/sov/lock` → `{ locked: false, payAppCount }` or `{ locked: true, lockedAt, lockedByUserId, lockedByName, reason, payAppCount }`
  - `POST /api/projects/:id/aia/sov/lock` → same state shape (locked)
  - `DELETE /api/projects/:id/aia/sov/lock` → same state shape (unlocked)

- [ ] **Step 1: Write the failing tests**

```ts
  it('SOV lock: GET state, POST locks (manual, by caller), mutations 409 sov_locked, DELETE reopens', async () => {
    const line = await request(app).post('/api/projects/p1/aia/sov').send({ description: 'D', scheduledValueCents: 1000 });
    const unlocked = await request(app).get('/api/projects/p1/aia/sov/lock');
    expect(unlocked.status).toBe(200);
    expect(unlocked.body).toEqual({ locked: false, payAppCount: 0 });

    const lock = await request(app).post('/api/projects/p1/aia/sov/lock').send({});
    expect(lock.status).toBe(200);
    expect(lock.body.locked).toBe(true);
    expect(lock.body.reason).toBe('manual');
    expect(lock.body.lockedByUserId).toBe('u1');
    expect(lock.body.lockedByName).toBeNull(); // no users row in this harness

    const blocked = await request(app).put(`/api/aia/sov/${line.body.id}`).send({ description: 'E', scheduledValueCents: 1, version: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('sov_locked');
    expect((await request(app).post('/api/projects/p1/aia/sov').send({ description: 'X', scheduledValueCents: 1 })).status).toBe(409);
    expect((await request(app).delete(`/api/aia/sov/${line.body.id}`)).status).toBe(409);
    expect((await request(app).post('/api/projects/p1/aia/sov/seed').send({ lines: [] })).status).toBe(409);

    const reopen = await request(app).delete('/api/projects/p1/aia/sov/lock');
    expect(reopen.status).toBe(200);
    expect(reopen.body.locked).toBe(false);
    expect((await request(app).put(`/api/aia/sov/${line.body.id}`).send({ description: 'E', scheduledValueCents: 1, version: 1 })).status).toBe(200);
  });

  it('SOV lock: creating the first pay app locks it and payAppCount is reported', async () => {
    await request(app).post('/api/projects/p1/aia/sov').send({ description: 'D', scheduledValueCents: 1000 });
    await request(app).post('/api/projects/p1/aia/pay-apps').send({});
    const state = await request(app).get('/api/projects/p1/aia/sov/lock');
    expect(state.body.locked).toBe(true);
    expect(state.body.reason).toBe('pay-app');
    expect(state.body.payAppCount).toBe(1);
  });

  it('SOV lock: 404 for an unknown project', async () => {
    expect((await request(app).get('/api/projects/nope/aia/sov/lock')).status).toBe(404);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- server/routes.test.ts -t "SOV lock"`
Expected: FAIL — 404 from the unknown route.

- [ ] **Step 3: Implement**

In the `./aiaStore` import in `server/routes.ts` add `getSovLock, lockSov, unlockSov, requireProject as requireAiaProject, SovLockedError,`.

In `aiaErr`, add as the first line inside: 
```ts
    if (e instanceof SovLockedError) return res.status(409).json({ error: e.message, code: 'sov_locked' });
```

After the `sync-change-orders` route add:

```ts
  // SOV lock (spec 2026-09-11). Reported shape is stable for the client chip;
  // the locker's name is resolved here so the client never joins users.
  const sovLockState = (projectId: string) => {
    requireAiaProject(db, projectId);
    const payAppCount = (db.prepare('SELECT COUNT(*) c FROM aia_pay_apps WHERE projectId = ?').get(projectId) as { c: number }).c;
    const lock = getSovLock(db, projectId);
    if (!lock) return { locked: false, payAppCount };
    const user = lock.lockedByUserId
      ? db.prepare('SELECT username FROM users WHERE id = ?').get(lock.lockedByUserId) as { username: string } | undefined
      : undefined;
    return {
      locked: true, lockedAt: lock.lockedAt, lockedByUserId: lock.lockedByUserId,
      lockedByName: user?.username ?? null, reason: lock.reason, payAppCount,
    };
  };
  app.get('/api/projects/:id/aia/sov/lock', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(sovLockState(req.params.id)); } catch (e) { aiaErr(e, res); }
  });
  app.post('/api/projects/:id/aia/sov/lock', authenticateToken, requireAdmin, (req, res) => {
    try {
      lockSov(db, req.params.id, { userId: req.user?.id ?? null, reason: 'manual' });
      deps.broadcastChange({ type: 'aiaSov', id: req.params.id, projectId: req.params.id, action: 'updated', ...requestMeta(req) });
      res.json(sovLockState(req.params.id));
    } catch (e) { aiaErr(e, res); }
  });
  app.delete('/api/projects/:id/aia/sov/lock', authenticateToken, requireAdmin, (req, res) => {
    try {
      unlockSov(db, req.params.id);
      deps.broadcastChange({ type: 'aiaSov', id: req.params.id, projectId: req.params.id, action: 'updated', ...requestMeta(req) });
      res.json(sovLockState(req.params.id));
    } catch (e) { aiaErr(e, res); }
  });
```

(`req.user` is already typed on the request in this file — line ~102 reads `req.user?.role`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- server/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run lint
git add server/routes.ts server/routes.test.ts
git commit -m "feat(aia): SOV lock routes (state/lock/reopen) and sov_locked 409 mapping"
```

---

### Task 4: `lineType` on lines; item-only sums in G703/G702/billing; pay-app lines for items only

**Files:**
- Modify: `server/aiaStore.ts` (`SovLineInput`, `createSovLine`, `saveSovLine`, `G703Row`, `computeG703`, `computeG702`, `createPayApp`, `savePayAppLines`)
- Modify: `server/billingStore.ts` (~568 `sovOriginalCents`)
- Test: `server/aiaStore.test.ts`, `server/billingStore.test.ts`

**Interfaces:**
- Produces: `export type SovLineType = 'item' | 'header' | 'blank'`; `SovLineInput.lineType?: SovLineType`; `G703Row.lineType: SovLineType`. Routes need no change (they pass `req.body` straight through).

- [ ] **Step 1: Write the failing tests**

Append to `server/aiaStore.test.ts`:

```ts
describe('SOV line types (header / blank)', () => {
  it('creates a header with zero value and null retainage; rejects money on a header or blank', () => {
    const { id } = createSovLine(db, 'p1', { lineType: 'header', description: 'Drywall', itemNo: '5' });
    const h = getSovLine(db, id)!;
    expect(h.lineType).toBe('header');
    expect(h.scheduledValueCents).toBe(0);
    expect(h.retainagePercent).toBeNull();
    expect(h.itemNo).toBe('5');
    expect(() => createSovLine(db, 'p1', { lineType: 'header', description: 'H', scheduledValueCents: 100 })).toThrow(ValidationError);
    expect(() => createSovLine(db, 'p1', { lineType: 'header', description: 'H', retainagePercent: 5 })).toThrow(ValidationError);
    expect(() => createSovLine(db, 'p1', { lineType: 'header', description: '   ' })).toThrow(ValidationError);
    expect(() => createSovLine(db, 'p1', { lineType: 'blank', scheduledValueCents: 1 })).toThrow(ValidationError);
    expect(() => createSovLine(db, 'p1', { lineType: 'bogus' as any, description: 'x', scheduledValueCents: 0 })).toThrow(ValidationError);
  });

  it('creates a blank with empty fields; default lineType is item', () => {
    const { id } = createSovLine(db, 'p1', { lineType: 'blank' });
    const b = getSovLine(db, id)!;
    expect(b.lineType).toBe('blank');
    expect(b.description).toBe('');
    expect(b.itemNo).toBeNull();
    expect(b.scheduledValueCents).toBe(0);
    const { id: itemId } = createSovLine(db, 'p1', { description: 'Item', scheduledValueCents: 10 });
    expect(getSovLine(db, itemId)!.lineType).toBe('item');
  });

  it('saveSovLine keeps the type when omitted, can convert item → header (value dropped to 0 only if sent as 0)', () => {
    const { id } = createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 1000 });
    saveSovLine(db, id, { description: 'Framing', scheduledValueCents: 2000, version: 1 });
    expect(getSovLine(db, id)!.lineType).toBe('item');
    expect(() => saveSovLine(db, id, { lineType: 'header', description: 'Framing', scheduledValueCents: 2000, version: 2 })).toThrow(ValidationError);
    saveSovLine(db, id, { lineType: 'header', description: 'Framing', scheduledValueCents: 0, version: 2 });
    const h = getSovLine(db, id)!;
    expect(h.lineType).toBe('header');
    expect(h.scheduledValueCents).toBe(0);
  });

  it('header and blank rows stay in position in G703 with zero money, and every G702 line is unchanged by them', () => {
    createSovLine(db, 'p1', { itemNo: '1', description: 'Mobilization', scheduledValueCents: 100000 });
    createSovLine(db, 'p1', { lineType: 'header', description: 'Interior' });
    createSovLine(db, 'p1', { itemNo: '2', description: 'Framing', scheduledValueCents: 500000 });
    createSovLine(db, 'p1', { lineType: 'blank' });
    const { id: appId } = createPayApp(db, 'p1', { retainagePercent: 10 });
    const app = getPayApp(db, appId)!;
    // pay-app lines are seeded for items only
    expect(app.lines.length).toBe(2);
    const items = listSovLines(db, 'p1').filter(l => l.lineType === 'item');
    savePayAppLines(db, appId, [
      { sovLineId: items[0].id, percentComplete: 100, storedMaterialsCents: 0 },
      { sovLineId: items[1].id, percentComplete: 50, storedMaterialsCents: 20000 },
    ], 1);
    const g703 = computeG703(db, appId);
    expect(g703.map(r => r.lineType)).toEqual(['item', 'header', 'item', 'blank']);
    expect(g703[1].description).toBe('Interior');
    expect(g703[1].scheduledValueCents).toBe(0);
    expect(g703[1].totalToDateCents).toBe(0);
    expect(g703[1].retainageCents).toBe(0);
    const g702 = computeG702(db, appId);
    expect(g702.L1originalContractCents).toBe(600000);
    expect(g702.L4totalCompletedStoredCents).toBe(100000 + 250000 + 20000);
    expect(g702.L5aRetainageWorkCents).toBe(10000 + 25000);
    expect(g702.L5bRetainageStoredCents).toBe(2000);
  });

  it('savePayAppLines ignores input for non-item lines', () => {
    createSovLine(db, 'p1', { itemNo: '1', description: 'Work', scheduledValueCents: 100000 });
    const { id: headerId } = createSovLine(db, 'p1', { lineType: 'header', description: 'H' });
    const { id: appId } = createPayApp(db, 'p1', {});
    savePayAppLines(db, appId, [{ sovLineId: headerId, percentComplete: 100, storedMaterialsCents: 5 }], 1);
    expect(db.prepare('SELECT COUNT(*) c FROM aia_pay_app_lines WHERE payAppId = ? AND sovLineId = ?').get(appId, headerId)).toEqual({ c: 0 });
    expect(computeG702(db, appId).L4totalCompletedStoredCents).toBe(0);
  });
});
```

Append to `server/billingStore.test.ts` (find its existing `billingSummary` describe and follow its setup; if the file builds projects via `createProject`, use that):

```ts
  it('contract base from the SOV counts item lines only (headers/blanks are zero and excluded)', () => {
    createSovLine(db, 'p1', { description: 'Work', scheduledValueCents: 100000 });
    createSovLine(db, 'p1', { lineType: 'header', description: 'Section' });
    createSovLine(db, 'p1', { lineType: 'blank' });
    expect(billingSummary(db, 'p1').contractTotalCents).toBe(100000);
  });
```

(Import `createSovLine` from `./aiaStore` in that test file if it is not already imported; `billingSummary` is the function whose signature starts at `server/billingStore.ts:~555` — check the exact exported name in the file header before writing the test and use it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- server/aiaStore.test.ts -t "line types" ; npm test -- server/billingStore.test.ts -t "item lines only"`
Expected: FAIL — `lineType` undefined / `ValidationError` not thrown.

- [ ] **Step 3: Implement in `server/aiaStore.ts`**

Replace `SovLineInput` and add the type + normalizer:

```ts
export const SOV_LINE_TYPES = ['item', 'header', 'blank'] as const;
export type SovLineType = typeof SOV_LINE_TYPES[number];

interface SovLineInput {
  lineType?: SovLineType;
  itemNo?: string | null;
  description?: string;
  scheduledValueCents?: number;
  retainagePercent?: number | null;
  isChangeOrder?: boolean | number;
  changeOrderId?: string | null;
  // Contract-line id to insert in front of (Task 5). Ignored on save.
  insertBeforeId?: string | null;
}

// One place decides what each line type may carry. Headers/blanks are
// rejected — not silently zeroed — when money or retainage is sent, so a
// client bug cannot smuggle value into a row every total ignores.
function normalizeLineInput(input: SovLineInput, lineType: SovLineType): {
  lineType: SovLineType; itemNo: string | null; description: string; cents: number; retainage: number | null;
} {
  if (!(SOV_LINE_TYPES as readonly string[]).includes(lineType)) throw new ValidationError('lineType must be item, header or blank');
  if (lineType === 'item') {
    if (typeof input.description !== 'string') throw new ValidationError('description is required');
    return {
      lineType, itemNo: input.itemNo ?? null, description: input.description,
      cents: validateScheduledValueCents(input.scheduledValueCents),
      retainage: validateRetainagePercent(input.retainagePercent),
    };
  }
  if (input.scheduledValueCents !== undefined && input.scheduledValueCents !== 0) throw new ValidationError(`a ${lineType} line cannot carry a scheduled value`);
  if (input.retainagePercent !== undefined && input.retainagePercent !== null) throw new ValidationError(`a ${lineType} line cannot carry retainage`);
  if (input.isChangeOrder) throw new ValidationError(`a ${lineType} line cannot be a change order`);
  if (lineType === 'header') {
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description) throw new ValidationError('a header line needs a description');
    return { lineType, itemNo: input.itemNo ?? null, description, cents: 0, retainage: null };
  }
  return { lineType, itemNo: null, description: '', cents: 0, retainage: null };
}
```

Rewrite `createSovLine` (Task 5 extends this same function with `insertBeforeId`; write it now without that branch):

```ts
export function createSovLine(db: Database.Database, projectId: string, input: SovLineInput): { id: string } {
  requireProject(db, projectId);
  assertSovEditable(db, projectId);
  const n = normalizeLineInput(input, input.lineType ?? 'item');
  const isCO = input.isChangeOrder ? 1 : 0;
  const id = crypto.randomUUID();
  const now = Date.now();
  const tx = db.transaction(() => {
    const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM aia_sov_lines WHERE projectId = ?').get(projectId) as any).m;
    db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, itemNo, description, scheduledValueCents, retainagePercent, isChangeOrder, changeOrderId, sortOrder, version, createdAt, lineType) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(id, projectId, n.itemNo, n.description, n.cents, n.retainage, isCO, input.changeOrderId ?? null, max + 1, now, n.lineType);
    touchProjectPayApps(db, projectId, now);
  });
  tx();
  return { id };
}
```

Rewrite `saveSovLine`:

```ts
export function saveSovLine(db: Database.Database, id: string, input: SovLineInput & { version?: number }): { version: number } {
  if (!Number.isInteger(input.version) || (input.version as number) < 1) {
    throw new ValidationError('Missing or invalid version — reload the line');
  }
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version, projectId, lineType FROM aia_sov_lines WHERE id = ?').get(id) as { version: number; projectId: string; lineType: SovLineType } | undefined;
    if (!row) throw new NotFoundError('SOV line not found');
    assertSovEditable(db, row.projectId);
    if (row.version !== input.version) throw new ConflictError(`SOV line changed since it was loaded (server v${row.version}, payload v${input.version})`);
    const n = normalizeLineInput(input, input.lineType ?? row.lineType ?? 'item');
    newVersion = row.version + 1;
    db.prepare('UPDATE aia_sov_lines SET itemNo = ?, description = ?, scheduledValueCents = ?, retainagePercent = ?, lineType = ?, version = ? WHERE id = ?')
      .run(n.itemNo, n.description, n.cents, n.retainage, n.lineType, newVersion, id);
    touchProjectPayApps(db, row.projectId, Date.now());
  });
  tx();
  return { version: newVersion };
}
```

`G703Row`: add `lineType: SovLineType;` after `isChangeOrder: number;`.

`computeG703`: in `rows.push({ ... })` add `lineType: (sov.lineType ?? 'item') as SovLineType,` after `isChangeOrder: sov.isChangeOrder,`. Non-item rows already compute to zero (value 0, no pay-app line) but make it explicit: at the top of the loop body add

```ts
    if (sov.lineType && sov.lineType !== 'item') {
      rows.push({
        sovLineId: sov.id, itemNo: sov.itemNo, description: sov.description, isChangeOrder: sov.isChangeOrder,
        lineType: sov.lineType, scheduledValueCents: 0, previousCents: 0, thisPeriodCents: 0, storedCents: 0,
        totalToDateCents: 0, percentComplete: 0, balanceToFinishCents: 0, retainageCents: 0,
      });
      continue;
    }
```

`computeG702`: first line inside `for (const sov of sovLines) {` add `if (sov.lineType && sov.lineType !== 'item') continue;`.

`createPayApp`: change the seeding query to `SELECT id FROM aia_sov_lines WHERE projectId = ? AND lineType = 'item' ORDER BY ...`.

`savePayAppLines` (~330-365): inside the transaction, the upsert loop is `for (const p of prepared) { const r = upd.run(...); if (r.changes === 0) { ins.run(...) } }`. Add a type lookup as the first statement of that loop body:

```ts
    const typeOf = db.prepare('SELECT lineType FROM aia_sov_lines WHERE id = ?');
    for (const p of prepared) {
      // Header/blank rows have no inputs; a payload that names one is ignored.
      const sov = typeOf.get(p.sovLineId) as { lineType: SovLineType } | undefined;
      if (sov && sov.lineType !== 'item') continue;
      const r = upd.run(p.percentComplete, p.storedMaterialsCents, payAppId, p.sovLineId);
      if (r.changes === 0) {
        ins.run(crypto.randomUUID(), payAppId, p.sovLineId, p.percentComplete, p.storedMaterialsCents, now);
      }
    }
```

(`typeOf` is prepared once, before the loop, next to `upd` and `ins`.)

`server/billingStore.ts` ~568: change the SQL to
`'SELECT COALESCE(SUM(scheduledValueCents), 0) v FROM aia_sov_lines WHERE projectId = ? AND isChangeOrder = 0 AND lineType = \'item\''`.

The billing test file already imports `createSovLine` from `./aiaStore` (line 20) and the exported function is `billingSummary(db, projectId)` (`server/billingStore.ts:552`); its `beforeEach` inserts project `p1`, so the test above needs no extra setup.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- server/aiaStore.test.ts server/billingStore.test.ts server/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run lint
git add server/aiaStore.ts server/aiaStore.test.ts server/billingStore.ts server/billingStore.test.ts
git commit -m "feat(aia): header/blank SOV line types; item-only sums in G703/G702/billing"
```

---

### Task 5: Reorder + insert-above

**Files:**
- Modify: `server/aiaStore.ts` (`createSovLine` insert branch; new `reorderSovLines`)
- Modify: `server/routes.ts` (new `PUT /api/projects/:id/aia/sov/order`; import)
- Test: `server/aiaStore.test.ts`, `server/routes.test.ts`

**Interfaces:**
- Produces: `export function reorderSovLines(db, projectId, ids: string[]): void`; `createSovLine` honors `input.insertBeforeId`.

- [ ] **Step 1: Write the failing tests**

Append to `server/aiaStore.test.ts` (add `reorderSovLines` to the import):

```ts
describe('SOV ordering', () => {
  const descs = () => listSovLines(db, 'p1').map(l => l.description);

  it('reorderSovLines assigns 0..n-1 in the given order and keeps CO lines after the contract block', () => {
    const a = createSovLine(db, 'p1', { description: 'A', scheduledValueCents: 1 }).id;
    const b = createSovLine(db, 'p1', { description: 'B', scheduledValueCents: 1 }).id;
    insertChangeOrder('co1', 'p1', '1', 'Extra', 10, 'approved');
    syncChangeOrders(db, 'p1');
    const c = createSovLine(db, 'p1', { description: 'C', scheduledValueCents: 1 }).id;
    reorderSovLines(db, 'p1', [c, a, b]);
    expect(descs()).toEqual(['C', 'A', 'B', 'Extra']);
    expect(listSovLines(db, 'p1').map(l => l.sortOrder)).toEqual([0, 1, 2, 3]);
  });

  it('reorderSovLines rejects a partial, duplicate, or foreign id list', () => {
    const a = createSovLine(db, 'p1', { description: 'A', scheduledValueCents: 1 }).id;
    const b = createSovLine(db, 'p1', { description: 'B', scheduledValueCents: 1 }).id;
    const other = createSovLine(db, 'p2', { description: 'Z', scheduledValueCents: 1 }).id;
    expect(() => reorderSovLines(db, 'p1', [a])).toThrow(ValidationError);
    expect(() => reorderSovLines(db, 'p1', [a, a, b])).toThrow(ValidationError);
    expect(() => reorderSovLines(db, 'p1', [a, other])).toThrow(ValidationError);
    expect(descs()).toEqual(['A', 'B']);
  });

  it('reorderSovLines is refused while locked', () => {
    const a = createSovLine(db, 'p1', { description: 'A', scheduledValueCents: 1 }).id;
    lockSov(db, 'p1', { userId: null, reason: 'manual' });
    expect(() => reorderSovLines(db, 'p1', [a])).toThrow(SovLockedError);
  });

  it('createSovLine with insertBeforeId places the new line in front of the target and shifts the rest', () => {
    createSovLine(db, 'p1', { description: 'A', scheduledValueCents: 1 });
    const b = createSovLine(db, 'p1', { description: 'B', scheduledValueCents: 1 }).id;
    createSovLine(db, 'p1', { description: 'C', scheduledValueCents: 1 });
    createSovLine(db, 'p1', { lineType: 'header', description: 'Section', insertBeforeId: b });
    expect(descs()).toEqual(['A', 'Section', 'B', 'C']);
  });

  it('createSovLine rejects insertBeforeId that is a CO line or belongs to another project', () => {
    insertChangeOrder('co1', 'p1', '1', 'Extra', 10, 'approved');
    syncChangeOrders(db, 'p1');
    const co = listSovLines(db, 'p1')[0].id;
    const other = createSovLine(db, 'p2', { description: 'Z', scheduledValueCents: 1 }).id;
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 1, insertBeforeId: co })).toThrow(ValidationError);
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 1, insertBeforeId: other })).toThrow(ValidationError);
  });
});
```

Append to `server/routes.test.ts` (AIA describe):

```ts
  it('PUT /aia/sov/order reorders contract lines; 400 on an incomplete list', async () => {
    const a = (await request(app).post('/api/projects/p1/aia/sov').send({ description: 'A', scheduledValueCents: 1 })).body.id;
    const b = (await request(app).post('/api/projects/p1/aia/sov').send({ description: 'B', scheduledValueCents: 1 })).body.id;
    expect((await request(app).put('/api/projects/p1/aia/sov/order').send({ ids: [b, a] })).status).toBe(200);
    expect((await request(app).get('/api/projects/p1/aia/sov')).body.map((l: any) => l.description)).toEqual(['B', 'A']);
    expect((await request(app).put('/api/projects/p1/aia/sov/order').send({ ids: [a] })).status).toBe(400);
  });

  it('POST /aia/sov with insertBeforeId inserts in front of the target', async () => {
    await request(app).post('/api/projects/p1/aia/sov').send({ description: 'A', scheduledValueCents: 1 });
    const b = (await request(app).post('/api/projects/p1/aia/sov').send({ description: 'B', scheduledValueCents: 1 })).body.id;
    expect((await request(app).post('/api/projects/p1/aia/sov').send({ lineType: 'header', description: 'H', insertBeforeId: b })).status).toBe(200);
    expect((await request(app).get('/api/projects/p1/aia/sov')).body.map((l: any) => l.description)).toEqual(['A', 'H', 'B']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- server/aiaStore.test.ts -t "SOV ordering" ; npm test -- server/routes.test.ts -t "sov/order"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `server/aiaStore.ts`, add after `seedSovLines`:

```ts
// The complete order of the project's CONTRACT lines (every non-CO line
// exactly once). CO lines always follow the contract block, in their existing
// order — the editor and export partition on isChangeOrder anyway, this just
// keeps sortOrder honest.
export function reorderSovLines(db: Database.Database, projectId: string, ids: unknown): void {
  requireProject(db, projectId);
  assertSovEditable(db, projectId);
  if (!Array.isArray(ids) || ids.some(x => typeof x !== 'string')) throw new ValidationError('ids must be an array of line ids');
  const ordered = ids as string[];
  const tx = db.transaction(() => {
    const contract = db.prepare('SELECT id FROM aia_sov_lines WHERE projectId = ? AND isChangeOrder = 0').all(projectId) as { id: string }[];
    const expected = new Set(contract.map(c => c.id));
    if (ordered.length !== expected.size || new Set(ordered).size !== ordered.length || ordered.some(id => !expected.has(id))) {
      throw new ValidationError('ids must list every contract line exactly once');
    }
    renumberContract(db, projectId, ordered);
    touchProjectPayApps(db, projectId, Date.now());
  });
  tx();
}

// Assign sortOrder 0..n-1 to the given contract ids, then the CO lines after
// them in their existing order. Callers hold the transaction.
function renumberContract(db: Database.Database, projectId: string, orderedContractIds: string[]): void {
  const upd = db.prepare('UPDATE aia_sov_lines SET sortOrder = ? WHERE id = ?');
  orderedContractIds.forEach((id, i) => upd.run(i, id));
  let next = orderedContractIds.length;
  const cos = db.prepare('SELECT id FROM aia_sov_lines WHERE projectId = ? AND isChangeOrder = 1 ORDER BY sortOrder ASC, createdAt ASC, rowid ASC').all(projectId) as { id: string }[];
  for (const co of cos) upd.run(next++, co.id);
}

// Contract line ids in canonical order (same ORDER BY as listSovLines).
function contractIdsInOrder(db: Database.Database, projectId: string): string[] {
  return (db.prepare('SELECT id FROM aia_sov_lines WHERE projectId = ? AND isChangeOrder = 0 ORDER BY sortOrder ASC, createdAt ASC, rowid ASC').all(projectId) as { id: string }[]).map(r => r.id);
}
```

In `createSovLine`, replace the body of `tx` with:

```ts
  const tx = db.transaction(() => {
    const before = input.insertBeforeId ?? null;
    if (before) {
      const target = db.prepare('SELECT projectId, isChangeOrder FROM aia_sov_lines WHERE id = ?').get(before) as { projectId: string; isChangeOrder: number } | undefined;
      if (!target || target.projectId !== projectId || target.isChangeOrder) throw new ValidationError('insertBeforeId must be a contract line of this project');
    }
    const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM aia_sov_lines WHERE projectId = ?').get(projectId) as any).m;
    db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, itemNo, description, scheduledValueCents, retainagePercent, isChangeOrder, changeOrderId, sortOrder, version, createdAt, lineType) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(id, projectId, n.itemNo, n.description, n.cents, n.retainage, isCO, input.changeOrderId ?? null, max + 1, now, n.lineType);
    if (before) {
      // Renumber from the canonical order with the new id moved in front of
      // the target — robust to existing sortOrder ties.
      const ids = contractIdsInOrder(db, projectId).filter(x => x !== id);
      ids.splice(ids.indexOf(before), 0, id);
      renumberContract(db, projectId, ids);
    }
    touchProjectPayApps(db, projectId, now);
  });
```

In `server/routes.ts`: add `reorderSovLines` to the aiaStore import and, after the `DELETE .../aia/sov/lock` route:

```ts
  app.put('/api/projects/:id/aia/sov/order', authenticateToken, requireAdmin, (req, res) => {
    try {
      reorderSovLines(db, req.params.id, req.body?.ids);
      deps.broadcastChange({ type: 'aiaSov', id: req.params.id, projectId: req.params.id, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { aiaErr(e, res); }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- server/aiaStore.test.ts server/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run lint
git add server/aiaStore.ts server/aiaStore.test.ts server/routes.ts server/routes.test.ts
git commit -m "feat(aia): SOV reorder route and insert-above on create"
```

---

### Task 6: Split a line by percentage

**Files:**
- Modify: `server/aiaStore.ts` (new `splitSovLine` after `reorderSovLines`)
- Modify: `server/routes.ts` (new `POST /api/aia/sov/:lineId/split`)
- Test: `server/aiaStore.test.ts`, `server/routes.test.ts`

**Interfaces:**
- Produces: `export interface SovSplitPart { description: string; percent: number }`; `export function splitSovLine(db, id, input: { version: number; parts: SovSplitPart[] }): { headerId: string; childIds: string[] }`.

- [ ] **Step 1: Write the failing tests**

Append to `server/aiaStore.test.ts` (add `splitSovLine` to the import):

```ts
describe('splitSovLine', () => {
  it('60/40 of $10,000.00 → header + $6,000.00 + $4,000.00, item numbers 5.1/5.2, retainage copied, later lines shifted', () => {
    const { id } = createSovLine(db, 'p1', { itemNo: '5', description: 'Drywall', scheduledValueCents: 1000000, retainagePercent: 5 });
    createSovLine(db, 'p1', { itemNo: '6', description: 'Paint', scheduledValueCents: 100 });
    const r = splitSovLine(db, id, { version: 1, parts: [{ description: 'Level 1', percent: 60 }, { description: 'Level 2', percent: 40 }] });
    expect(r.headerId).toBe(id);
    expect(r.childIds.length).toBe(2);
    const lines = listSovLines(db, 'p1');
    expect(lines.map(l => [l.description, l.lineType, l.scheduledValueCents, l.itemNo])).toEqual([
      ['Drywall', 'header', 0, '5'],
      ['Level 1', 'item', 600000, '5.1'],
      ['Level 2', 'item', 400000, '5.2'],
      ['Paint', 'item', 100, '6'],
    ]);
    expect(lines.map(l => l.sortOrder)).toEqual([0, 1, 2, 3]);
    expect(lines[0].retainagePercent).toBeNull();
    expect(lines[1].retainagePercent).toBe(5);
    expect(lines[2].retainagePercent).toBe(5);
    expect(lines[0].version).toBe(2);
  });

  it('three-way split of $100.01 gives 33.34 / 33.33 / 33.34 — the last child absorbs the remainder', () => {
    const { id } = createSovLine(db, 'p1', { description: 'Odd', scheduledValueCents: 10001 });
    splitSovLine(db, id, { version: 1, parts: [
      { description: 'a', percent: 33.34 }, { description: 'b', percent: 33.33 }, { description: 'c', percent: 33.33 },
    ] });
    const cents = listSovLines(db, 'p1').filter(l => l.lineType === 'item').map(l => l.scheduledValueCents);
    expect(cents).toEqual([3334, 3333, 3334]);
    expect(cents.reduce((a, b) => a + b, 0)).toBe(10001);
  });

  it('no item number on the parent → children have none', () => {
    const { id } = createSovLine(db, 'p1', { description: 'NoNo', scheduledValueCents: 100 });
    splitSovLine(db, id, { version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] });
    expect(listSovLines(db, 'p1').map(l => l.itemNo)).toEqual([null, null, null]);
  });

  it('rejects: percents not 100, one part, empty description, non-positive percent', () => {
    const { id } = createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 100 });
    const bad = (parts: any[]) => expect(() => splitSovLine(db, id, { version: 1, parts })).toThrow(ValidationError);
    bad([{ description: 'a', percent: 60 }, { description: 'b', percent: 39.99 }]);
    bad([{ description: 'a', percent: 60 }, { description: 'b', percent: 40.01 }]);
    bad([{ description: 'a', percent: 100 }]);
    bad([{ description: '', percent: 50 }, { description: 'b', percent: 50 }]);
    bad([{ description: 'a', percent: 0 }, { description: 'b', percent: 100 }]);
    expect(listSovLines(db, 'p1').length).toBe(1);
  });

  it('rejects: header target, CO target, stale version, locked SOV', () => {
    const { id: h } = createSovLine(db, 'p1', { lineType: 'header', description: 'H' });
    expect(() => splitSovLine(db, h, { version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] })).toThrow(ValidationError);
    insertChangeOrder('co1', 'p1', '1', 'Extra', 10, 'approved');
    syncChangeOrders(db, 'p1');
    const co = listSovLines(db, 'p1').find(l => l.isChangeOrder)!.id;
    expect(() => splitSovLine(db, co, { version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] })).toThrow(ValidationError);
    const { id } = createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 100 });
    expect(() => splitSovLine(db, id, { version: 7, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] })).toThrow(ConflictError);
    lockSov(db, 'p1', { userId: null, reason: 'manual' });
    expect(() => splitSovLine(db, id, { version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] })).toThrow(SovLockedError);
    expect(() => splitSovLine(db, 'missing', { version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] })).toThrow(NotFoundError);
  });
});
```

Append to `server/routes.test.ts` (AIA describe):

```ts
  it('POST /aia/sov/:id/split returns the header and children; 400 on bad percents; 409 version_conflict on stale', async () => {
    const id = (await request(app).post('/api/projects/p1/aia/sov').send({ itemNo: '1', description: 'Drywall', scheduledValueCents: 1000 })).body.id;
    const bad = await request(app).post(`/api/aia/sov/${id}/split`).send({ version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 49 }] });
    expect(bad.status).toBe(400);
    const stale = await request(app).post(`/api/aia/sov/${id}/split`).send({ version: 3, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    const ok = await request(app).post(`/api/aia/sov/${id}/split`).send({ version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.header.lineType).toBe('header');
    expect(ok.body.children.map((c: any) => c.scheduledValueCents)).toEqual([500, 500]);
    expect((await request(app).get('/api/projects/p1/aia/sov')).body.length).toBe(3);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- server/aiaStore.test.ts -t "splitSovLine" ; npm test -- server/routes.test.ts -t "split"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `server/aiaStore.ts`, after `reorderSovLines`:

```ts
export interface SovSplitPart { description: string; percent: number }

// Turn one item line into a header with N item children whose values are
// percentages of the original. Percents are compared in basis points (2 dp)
// and must total exactly 100.00; cents are rounded per child with the LAST
// child taking the remainder so the children always sum to the original.
export function splitSovLine(db: Database.Database, id: string, input: { version?: number; parts?: unknown }): { headerId: string; childIds: string[] } {
  if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new ValidationError('Missing or invalid version — reload the line');
  if (!Array.isArray(input.parts) || input.parts.length < 2 || input.parts.length > 50) throw new ValidationError('Provide between 2 and 50 parts');
  const parts = (input.parts as any[]).map((p, i) => {
    const description = typeof p?.description === 'string' ? p.description.trim() : '';
    if (!description) throw new ValidationError(`Part ${i + 1} needs a description`);
    const percent = Number(p?.percent);
    if (!Number.isFinite(percent) || percent <= 0) throw new ValidationError(`Part ${i + 1} needs a percentage above 0`);
    return { description, bp: Math.round(percent * 100) };
  });
  const totalBp = parts.reduce((a, p) => a + p.bp, 0);
  if (totalBp !== 10000) throw new ValidationError('Percentages must add up to exactly 100');

  const childIds: string[] = [];
  const now = Date.now();
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM aia_sov_lines WHERE id = ?').get(id) as any;
    if (!row) throw new NotFoundError('SOV line not found');
    assertSovEditable(db, row.projectId);
    if (row.version !== input.version) throw new ConflictError(`SOV line changed since it was loaded (server v${row.version}, payload v${input.version})`);
    if (row.isChangeOrder) throw new ValidationError('Change-order lines cannot be split');
    if ((row.lineType ?? 'item') !== 'item') throw new ValidationError('Only item lines can be split');

    const original: number = row.scheduledValueCents;
    let allocated = 0;
    const ins = db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, itemNo, description, scheduledValueCents, retainagePercent, isChangeOrder, changeOrderId, sortOrder, version, createdAt, lineType) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 0, 1, ?, ?)'
    );
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const cents = last ? original - allocated : Math.round(original * p.bp / 10000);
      allocated += cents;
      const childId = crypto.randomUUID();
      childIds.push(childId);
      ins.run(childId, row.projectId, row.itemNo ? `${row.itemNo}.${i + 1}` : null, p.description, cents, row.retainagePercent, now + i, 'item');
    });
    db.prepare("UPDATE aia_sov_lines SET lineType = 'header', scheduledValueCents = 0, retainagePercent = NULL, version = ? WHERE id = ?")
      .run(row.version + 1, id);

    // Children directly after the parent; everything else keeps its order.
    const ids = contractIdsInOrder(db, row.projectId).filter(x => !childIds.includes(x));
    ids.splice(ids.indexOf(id) + 1, 0, ...childIds);
    renumberContract(db, row.projectId, ids);
    touchProjectPayApps(db, row.projectId, now);
  });
  tx();
  return { headerId: id, childIds };
}
```

In `server/routes.ts`: add `splitSovLine` to the import; after the `DELETE /api/aia/sov/:lineId` route add:

```ts
  app.post('/api/aia/sov/:lineId/split', authenticateToken, requireAdmin, (req, res) => {
    try {
      const r = splitSovLine(db, req.params.lineId, req.body ?? {});
      const header = getSovLine(db, r.headerId);
      deps.broadcastChange({ type: 'aiaSov', id: header.projectId, projectId: header.projectId, action: 'updated', ...requestMeta(req) });
      res.json({ header, children: r.childIds.map(cid => getSovLine(db, cid)) });
    } catch (e) { aiaErr(e, res); }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- server/aiaStore.test.ts server/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run lint
git add server/aiaStore.ts server/aiaStore.test.ts server/routes.ts server/routes.test.ts
git commit -m "feat(aia): split an SOV line by percentage into a header with item children"
```

---

### Task 7: Client store — types, lock helpers, reorder, split

**Files:**
- Modify: `src/utils/store.ts` (~1631 `AiaSovLine`, ~1661 `AiaG703Row`, ~1721-1750 SOV helpers)

**Interfaces:**
- Produces:
  - `export type SovLineType = 'item' | 'header' | 'blank'`
  - `AiaSovLine.lineType?: SovLineType` and `AiaG703Row.lineType?: SovLineType` (optional on the client: rows from fixtures/older payloads read as items)
  - `export const lineTypeOf = (l: { lineType?: SovLineType | null }): SovLineType => l.lineType ?? 'item'`
  - `export interface SovLockState { locked: boolean; lockedAt?: number; lockedByUserId?: string | null; lockedByName?: string | null; reason?: 'manual' | 'pay-app'; payAppCount: number }`
  - `export class SovLockedError extends Error` (name `'SovLockedError'`)
  - `getSovLock(projectId)`, `lockSov(projectId)`, `unlockSov(projectId)`, `reorderSov(projectId, ids)`, `splitSovLine(lineId, version, parts)`
  - `createSovLine(projectId, input)` input gains `lineType?`, `insertBeforeId?`; `saveSovLine` sends `lineType`.
  - `handleSovResponse(res, id)` — 409 `sov_locked` → `SovLockedError`, other 409 → `ConflictError`.

- [ ] **Step 1: Add the types and helpers**

Replace the `AiaSovLine` interface:

```ts
export type SovLineType = 'item' | 'header' | 'blank';
// Absent = item: fixtures and payloads from before migration 35 carry no type.
export const lineTypeOf = (l: { lineType?: SovLineType | null }): SovLineType => l.lineType ?? 'item';

export interface AiaSovLine {
  id: string; projectId: string; itemNo: string | null; description: string;
  scheduledValueCents: number; retainagePercent: number | null;
  isChangeOrder: number; changeOrderId: string | null;
  sortOrder: number; version: number; createdAt: number;
  lineType?: SovLineType;
}
```

In `AiaG703Row` add `lineType?: SovLineType;` after `isChangeOrder: number;`.

After `resolveRetainageMode`, add:

```ts
export interface SovLockState {
  locked: boolean; payAppCount: number;
  lockedAt?: number; lockedByUserId?: string | null; lockedByName?: string | null;
  reason?: 'manual' | 'pay-app';
}
export class SovLockedError extends Error { constructor() { super('Schedule of values is finalized'); this.name = 'SovLockedError'; } }
// 409s on SOV routes carry a code: sov_locked (finalized) vs version_conflict.
const handleSovResponse = async (res: Response, id: string) => {
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    if (body?.code === 'sov_locked') throw new SovLockedError();
    throw new ConflictError(id);
  }
  await handleResponse(res);
};
```

Replace the SOV helper block (`getSov` … `syncChangeOrders`) with:

```ts
// Schedule of Values
export const getSov = async (projectId: string): Promise<AiaSovLine[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/aia/sov`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getSovLock = async (projectId: string): Promise<SovLockState> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/aia/sov/lock`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const lockSov = async (projectId: string): Promise<SovLockState> => {
  const res = await aiaJson('POST', `/api/projects/${projectId}/aia/sov/lock`, {});
  await handleResponse(res); return res.json();
};
export const unlockSov = async (projectId: string): Promise<SovLockState> => {
  const res = await aiaJson('DELETE', `/api/projects/${projectId}/aia/sov/lock`);
  await handleResponse(res); return res.json();
};
export interface SovLineCreateInput {
  lineType?: SovLineType; itemNo?: string | null; description?: string;
  scheduledValueCents?: number; retainagePercent?: number | null; insertBeforeId?: string | null;
}
export const createSovLine = async (projectId: string, input: SovLineCreateInput): Promise<{ id: string }> => {
  const res = await aiaJson('POST', `/api/projects/${projectId}/aia/sov`, input);
  await handleSovResponse(res, projectId); return res.json();
};
export const saveSovLine = async (id: string, line: AiaSovLine): Promise<{ version: number }> => {
  const res = await aiaJson('PUT', `/api/aia/sov/${id}`, {
    lineType: lineTypeOf(line), itemNo: line.itemNo, description: line.description,
    scheduledValueCents: line.scheduledValueCents, retainagePercent: line.retainagePercent,
    version: line.version,
  });
  await handleSovResponse(res, id); return res.json();
};
export const deleteSovLine = async (id: string): Promise<void> => {
  const res = await aiaJson('DELETE', `/api/aia/sov/${id}`); await handleSovResponse(res, id);
};
export const reorderSov = async (projectId: string, ids: string[]): Promise<void> => {
  const res = await aiaJson('PUT', `/api/projects/${projectId}/aia/sov/order`, { ids });
  await handleSovResponse(res, projectId);
};
export interface SovSplitPart { description: string; percent: number }
export const splitSovLine = async (lineId: string, version: number, parts: SovSplitPart[]): Promise<{ header: AiaSovLine; children: AiaSovLine[] }> => {
  const res = await aiaJson('POST', `/api/aia/sov/${lineId}/split`, { version, parts });
  await handleSovResponse(res, lineId); return res.json();
};
export const seedSov = async (projectId: string, lines: { description: string; scheduledValueCents: number; itemNo?: string }[]): Promise<{ count: number }> => {
  const res = await aiaJson('POST', `/api/projects/${projectId}/aia/sov/seed`, { lines });
  await handleSovResponse(res, projectId); return res.json();
};
export const syncChangeOrders = async (projectId: string): Promise<{ added: number }> => {
  const res = await aiaJson('POST', `/api/projects/${projectId}/aia/sov/sync-change-orders`);
  await handleResponse(res); return res.json();
};
```

- [ ] **Step 2: Typecheck and run the existing client billing tests**

Run: `npm run lint && npm test -- src/pages/project/billing src/utils`
Expected: PASS (types are optional, nothing else changed behavior). If `saveSovLine`'s caller in `AiaScheduleOfValues.tsx` catches `e.name === 'ConflictError'`, that still works.

- [ ] **Step 3: Commit**

```bash
git add src/utils/store.ts
git commit -m "feat(aia): client store — SOV line types, lock state, reorder and split helpers"
```

---

### Task 8: Excel export — header and blank rows

**Files:**
- Modify: `src/pages/project/billing/aiaExcel.ts` (`writeItemRow` ~265; template writer ~574-598)
- Modify: `src/pages/project/billing/aiaExportShared.ts` (`buildBlankSovContext` map ~102)
- Test: `src/pages/project/billing/aiaExcel.test.ts`, `src/pages/project/billing/aiaExportShared.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/pages/project/billing/aiaExcel.test.ts` (uses the file's existing `ctx`, `formulaOf`, `buildAiaWorkbook`):

```ts
describe('header and blank rows (spec 2026-09-11)', () => {
  // item, header, item, blank, then a CO — the header/blank sit INSIDE the
  // contract block, so every anchor moves by 2 and every item formula must
  // still point at its own row.
  const header: AiaG703Row = { sovLineId: 'h1', itemNo: null, description: 'Interior', isChangeOrder: 0, lineType: 'header', scheduledValueCents: 0, previousCents: 0, thisPeriodCents: 0, storedCents: 0, totalToDateCents: 0, percentComplete: 0, balanceToFinishCents: 0, retainageCents: 0 };
  const blank: AiaG703Row = { ...header, sovLineId: 'b1', description: '', lineType: 'blank' };
  const mixed: AiaExportCtx = { ...ctx, g703: [g703[0], header, g703[1], blank, g703[2]] };

  it('writes a header as a bold description with no money/formula cells, and a blank as an empty row', async () => {
    const wb = await buildAiaWorkbook(mixed);
    const ws = wb.getWorksheet('G703')!;
    const headerRow = 12; // contractStart 11 + 1
    expect(ws.getCell(`B${headerRow}`).value).toBe('Interior');
    expect(ws.getCell(`B${headerRow}`).font?.bold).toBe(true);
    for (const col of ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
      expect(formulaOf(ws.getCell(`${col}${headerRow}`).value)).toBeUndefined();
      expect(ws.getCell(`${col}${headerRow}`).value ?? '').toBe('');
    }
    const blankRow = 14;
    for (const col of ['A', 'B', 'C', 'G', 'J']) expect(ws.getCell(`${col}${blankRow}`).value ?? '').toBe('');
  });

  it('keeps item formulas on their own rows and moves the totals/CO/grand anchors by the two extra rows', async () => {
    const wb = await buildAiaWorkbook(mixed);
    const ws = wb.getWorksheet('G703')!;
    expect(formulaOf(ws.getCell('G13').value)).toBe('D13+E13+F13'); // Framing now on row 13
    const contractTotalRow = CONTRACT_TOTAL_ROW + 2;
    expect(ws.getCell(`B${contractTotalRow}`).value).toBe('TOTALS');
    expect(formulaOf(ws.getCell(`C${contractTotalRow}`).value)).toBe(`SUM(C11:C${contractTotalRow - 1})`);
    expect(ws.getCell(`B${GRAND_ROW + 2}`).value).toBe('GRAND TOTAL');
    // G702 line 5 ("TOTAL EARNED LESS RETAINAGE") is written by buildG702 as
    // 'G703'!G<grand>-'G703'!J<grand> — it must point at the MOVED grand row.
    const g702ws = wb.getWorksheet('G702')!;
    let found = false;
    g702ws.eachRow(row => row.eachCell(cell => {
      const f = formulaOf(cell.value);
      if (f === `'G703'!G${GRAND_ROW + 2}-'G703'!J${GRAND_ROW + 2}`) found = true;
    }));
    expect(found).toBe(true);
  });
});
```

Append to `src/pages/project/billing/aiaExportShared.test.ts` (uses its existing helpers for `AiaSovLine` fixtures):

```ts
  it('buildBlankSovContext carries lineType through and sums only items into L1', () => {
    const lines: AiaSovLine[] = [
      { id: 'a', projectId: 'p', itemNo: '1', description: 'Work', scheduledValueCents: 1000, retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 0, version: 1, createdAt: 0, lineType: 'item' },
      { id: 'h', projectId: 'p', itemNo: null, description: 'Section', scheduledValueCents: 0, retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 1, version: 1, createdAt: 0, lineType: 'header' },
    ];
    const blank = buildBlankSovContext(lines, {}, 'p');
    expect(blank.g703.map(r => r.lineType)).toEqual(['item', 'header']);
    expect(blank.g702.L1originalContractCents).toBe(1000);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/pages/project/billing/aiaExcel.test.ts src/pages/project/billing/aiaExportShared.test.ts`
Expected: FAIL — header row has money cells / `lineType` missing on blank context rows.

- [ ] **Step 3: Implement**

In `aiaExcel.ts`, import `lineTypeOf` from `'../../../utils/store'` (alongside the existing type imports). Replace `writeItemRow` with:

```ts
  const writeItemRow = (rowNum: number, row: AiaG703Row, seq: number): void => {
    const type = lineTypeOf(row);
    if (type === 'blank') {
      for (const col of G703_COLS) setCell(ws, `${col}${rowNum}`, '', { border: true });
      return;
    }
    if (type === 'header') {
      // Label only: description in bold, every money/formula column empty.
      // The section SUMs skip empty cells, so anchors and G702 refs are unchanged.
      setCell(ws, `A${rowNum}`, row.itemNo ?? '', { border: true, align: 'center' });
      setCell(ws, `B${rowNum}`, row.description, { border: true, wrap: true, bold: true });
      for (const col of ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) setCell(ws, `${col}${rowNum}`, '', { border: true });
      return;
    }
    setCell(ws, `A${rowNum}`, row.itemNo ?? seq, { border: true, align: 'center' });
    setCell(ws, `B${rowNum}`, row.description, { border: true, wrap: true });
    setCell(ws, `C${rowNum}`, dollars(row.scheduledValueCents), { money: true, border: true });
    setCell(ws, `D${rowNum}`, dollars(row.previousCents), { money: true, border: true });
    setCell(ws, `E${rowNum}`, dollars(row.thisPeriodCents), { money: true, border: true });
    setCell(ws, `F${rowNum}`, dollars(row.storedCents), { money: true, border: true });
    setCell(ws, `G${rowNum}`, { formula: `D${rowNum}+E${rowNum}+F${rowNum}` }, { money: true, border: true });
    setCell(ws, `H${rowNum}`, { formula: `IFERROR(G${rowNum}/C${rowNum},0)` }, { border: true, align: 'center' }).numFmt = '0.00%';
    setCell(ws, `I${rowNum}`, { formula: `C${rowNum}-G${rowNum}` }, { money: true, border: true });
    if (perLine) {
      // A single rate cell can't represent per-line rates — write the row's
      // already-correct effective retainage (computed server-side) as a
      // literal instead of deriving it from 'G702'!$G$22.
      setCell(ws, `J${rowNum}`, dollars(row.retainageCents), { money: true, border: true });
    } else {
      setCell(ws, `J${rowNum}`, { formula: `SUM(D${rowNum}:E${rowNum})*'G702'!$G$22` }, { money: true, border: true });
    }
  };
```

(The item body is the existing code, unchanged.) Item `seq` numbering: pass `seq` as the running count of ITEM rows so far rather than `i + 1` — in the two `forEach` calls, replace `writeItemRow(contractStart + i, row, i + 1)` with a counter:

```ts
  let itemSeq = 0;
  contract.forEach((row, i) => writeItemRow(contractStart + i, row, lineTypeOf(row) === 'item' ? ++itemSeq : 0));
```
and the same pattern for `cos` (CO rows are always items; `++itemSeq` is fine there too — reset `itemSeq = 0` before the CO loop so CO fallbacks number from 1 as before).

Template writer (`buildAiaWorkbookFromTemplate`, the `ctx.g703.forEach` loop): at the top of the callback add

```ts
    if (lineTypeOf(row) !== 'item') {
      setMapped(g703ws, at(cols.itemNo), row.itemNo ?? '');
      setMapped(g703ws, at(cols.description), lineTypeOf(row) === 'header' ? row.description : '');
      for (const key of ['scheduledValue', 'previous', 'thisPeriod', 'stored', 'total', 'percent', 'balance', 'retainage'] as const) {
        setMapped(g703ws, at(cols[key]), '');
      }
      return;
    }
```

In `aiaExportShared.ts` `buildBlankSovContext`: in the `.map(l => ({ ... }))` add `lineType: lineTypeOf(l),` and change the `L1` reducer to `g703.filter(r => !r.isChangeOrder && lineTypeOf(r) === 'item')` (import `lineTypeOf` from the store). Header rows have value 0 so the sum is unaffected either way; the filter makes the exclusion explicit.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/pages/project/billing`
Expected: PASS (including `aiaExcelTemplate.test.ts`).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run lint
git add src/pages/project/billing/aiaExcel.ts src/pages/project/billing/aiaExcel.test.ts src/pages/project/billing/aiaExportShared.ts src/pages/project/billing/aiaExportShared.test.ts
git commit -m "feat(aia): header and blank SOV rows in the G703 export (default + template)"
```

---

### Task 9: Pay-app editor renders header/blank rows; create form notes the auto-lock

**Files:**
- Modify: `src/pages/project/billing/AiaPayAppEditor.tsx` (desktop table ~375-415; mobile cards ~429-490)
- Modify: `src/pages/project/billing/AiaPayApplications.tsx` (create modal ~170-180)
- Test: `src/pages/project/billing/AiaPayAppEditor.test.tsx`, `src/pages/project/billing/AiaPayApplications.test.tsx`

- [ ] **Step 1: Write the failing tests**

`AiaPayAppEditor.test.tsx` already hoists `getPayApp` (a `vi.fn`), has fixtures `app`, `g702()`, `g703Row(over)`, `load()`, a `beforeEach` that sets `getPayApp.mockResolvedValue(load())`, and a `renderEditor()` helper. Append a new describe at the end of the file:

```ts
describe('AiaPayAppEditor — header and blank SOV rows', () => {
  it('renders a header as a full-width label and a blank as a spacer, with no inputs for either', async () => {
    getPayApp.mockResolvedValue({
      ...load(),
      g703: [
        g703Row(),
        g703Row({ sovLineId: 'h1', itemNo: null, description: 'Interior', lineType: 'header', scheduledValueCents: 0, balanceToFinishCents: 0 }),
        g703Row({ sovLineId: 'b1', itemNo: null, description: '', lineType: 'blank', scheduledValueCents: 0, balanceToFinishCents: 0 }),
      ],
    });
    renderEditor();
    expect(await screen.findByTestId('g703-header-row-h1')).toHaveTextContent('Interior');
    expect(screen.getByTestId('g703-blank-row-b1')).toBeInTheDocument();
    // the item row still has its percent input; the header/blank have none
    expect(screen.getByTestId('pa-pct-sov1')).toBeInTheDocument();
    expect(screen.queryByTestId('pa-pct-h1')).toBeNull();
    expect(screen.queryByTestId('pa-pct-b1')).toBeNull();
  });
});
```

Add `data-testid={`pa-pct-${row.sovLineId}`}` to the existing desktop percent `<Input>` (the one bound to `e.percentComplete` in the `<TD className="w-32">`) so the assertions above are meaningful.

`AiaPayApplications.test.tsx` hoists an `h` object and mocks the store from it, and has `mount()`; it uses `fireEvent`, not user-event. Add `getSovLock: vi.fn(async () => ({ locked: true, payAppCount: 1 }))` to the `h` object and `getSovLock: h.getSovLock,` to the `vi.mock('../../../utils/store', …)` factory (default = locked, so every existing test is unaffected). Then append:

```ts
describe('AiaPayApplications — first application finalizes the SOV', () => {
  it('shows the note in the create form while the SOV is unlocked', async () => {
    h.getPayApps.mockResolvedValue([]);
    h.getDocumentsBySource.mockResolvedValue({});
    h.getSovLock.mockResolvedValueOnce({ locked: false, payAppCount: 0 });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /new application/i }));
    expect(await screen.findByText(/finalizes the schedule of values/i)).toBeInTheDocument();
  });

  it('shows no note once the SOV is locked', async () => {
    h.getPayApps.mockResolvedValue([]);
    h.getDocumentsBySource.mockResolvedValue({});
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /new application/i }));
    await screen.findByLabelText('Period to');
    expect(screen.queryByText(/finalizes the schedule of values/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/pages/project/billing/AiaPayAppEditor.test.tsx src/pages/project/billing/AiaPayApplications.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`AiaPayAppEditor.tsx` — import `lineTypeOf` from the store. In the desktop `data.g703.map(row => { ... })`, before `const e = edits[...]` add:

```tsx
                    const type = lineTypeOf(row);
                    if (type === 'header') {
                      return (
                        <TR key={row.sovLineId} data-testid={`g703-header-row-${row.sovLineId}`}>
                          <TD className="text-ink-soft">{row.itemNo || ''}</TD>
                          <TD colSpan={9} className="font-semibold text-ink">{row.description}</TD>
                        </TR>
                      );
                    }
                    if (type === 'blank') {
                      return <TR key={row.sovLineId} data-testid={`g703-blank-row-${row.sovLineId}`}><TD colSpan={10} className="h-8" /></TR>;
                    }
```

Mobile cards: same guard at the top of the map callback:

```tsx
                const type = lineTypeOf(row);
                if (type === 'header') return <div key={row.sovLineId} data-testid={`g703-header-card-${row.sovLineId}`} className="px-1 pt-2 text-sm font-semibold text-ink">{row.description}</div>;
                if (type === 'blank') return <div key={row.sovLineId} data-testid={`g703-blank-card-${row.sovLineId}`} className="h-3" />;
```

Also guard the `seed` callback (~79-90) and any `previewG` computation so they skip non-item rows (`if (lineTypeOf(row) !== 'item') continue;`) — they would otherwise create edit entries for rows with no inputs, which `savePayAppLines` ignores anyway but the payload should not carry them.

`AiaPayApplications.tsx` — import `getSovLock` and `SovLockState`; add state `const [sovLock, setSovLock] = useState<SovLockState | null>(null);` and load it in `startCreate`:

```ts
  const startCreate = () => {
    setNPeriodTo('');
    setNAppDate(today());
    setSovLock(null);
    getSovLock(projectId).then(setSovLock).catch(() => setSovLock(null));
    setCreating(true);
  };
```

In the create `<Modal>` body, after the two fields:

```tsx
          {sovLock && !sovLock.locked && (
            <p className="text-xs text-ink-faint">Creating the first application finalizes the schedule of values. Lines can't change afterwards until an admin reopens it from the SOV tab.</p>
          )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/pages/project/billing`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run lint
git add src/pages/project/billing/AiaPayAppEditor.tsx src/pages/project/billing/AiaPayAppEditor.test.tsx src/pages/project/billing/AiaPayApplications.tsx src/pages/project/billing/AiaPayApplications.test.tsx
git commit -m "feat(aia): pay-app editor shows header/blank SOV rows; create form notes the auto-lock"
```

---

### Task 10: SOV editor — lock chip, finalize/reopen, sections, line types, row actions

**Files:**
- Modify: `src/pages/project/billing/AiaScheduleOfValues.tsx` (whole component)
- Test: `src/pages/project/billing/AiaScheduleOfValues.test.tsx`

**Interfaces:**
- Consumes: `getSovLock`, `lockSov`, `unlockSov`, `reorderSov`, `createSovLine` (with `lineType`/`insertBeforeId`), `SovLockedError`, `lineTypeOf` from Task 7.
- Produces testids: `sov-lock-chip`, `sov-finalize`, `sov-reopen`, `sov-contract-section`, `sov-co-section`, `sov-row-<id>`, `sov-move-up-<id>`, `sov-move-down-<id>`, `sov-insert-header-<id>`, `sov-insert-blank-<id>`, `sov-split-<id>` (button only; modal in Task 11), `sov-new-type` (select).

- [ ] **Step 1: Write the failing tests**

Extend the store mock in `AiaScheduleOfValues.test.tsx` with `getSovLock`, `lockSov`, `unlockSov`, `reorderSov`, `createSovLine`, `deleteSovLine` (all `vi.fn`), defaulting `getSovLock` to `{ locked: false, payAppCount: 0 }`. Add a `line()` fixture helper:

```ts
const line = (over: Partial<any>): any => ({
  id: 'l1', projectId: 'p1', itemNo: '1', description: 'Framing', scheduledValueCents: 100000,
  retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 0, version: 1, createdAt: 0, lineType: 'item', ...over,
});
```

Tests:

```ts
describe('AiaScheduleOfValues — lock, sections, line types, row actions', () => {
  it('draft: shows Draft chip + Finalize; Finalize confirms then locks', async () => {
    h.getSov.mockResolvedValue([line({})]);
    mount();
    expect(await screen.findByTestId('sov-lock-chip')).toHaveTextContent(/draft/i);
    await userEvent.click(screen.getByTestId('sov-finalize'));
    await userEvent.click(await screen.findByRole('button', { name: /finalize/i })); // confirm dialog
    await waitFor(() => expect(h.lockSov).toHaveBeenCalledWith('p1'));
  });

  it('locked: chip shows cause + date, edit/delete/add/import/seed/split/move are gone, sync stays, Reopen confirms with the pay-app count', async () => {
    h.getSov.mockResolvedValue([line({}), line({ id: 'co', itemNo: 'CO-1', description: 'Extra', isChangeOrder: 1, changeOrderId: 'c1', sortOrder: 1 })]);
    h.getSovLock.mockResolvedValue({ locked: true, lockedAt: Date.UTC(2026, 8, 11), lockedByUserId: null, lockedByName: null, reason: 'pay-app', payAppCount: 3 });
    mount();
    expect(await screen.findByTestId('sov-lock-chip')).toHaveTextContent(/locked/i);
    expect(screen.getByTestId('sov-lock-chip')).toHaveTextContent(/first pay application/i);
    expect(screen.queryByTitle('Edit')).toBeNull();
    expect(screen.queryByTitle('Delete')).toBeNull();
    expect(screen.queryByRole('button', { name: /add line/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /seed from estimate/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /upload sheet/i })).toBeNull();
    expect(screen.queryByTestId('sov-split-l1')).toBeNull();
    expect(screen.queryByTestId('sov-move-up-l1')).toBeNull();
    expect(screen.getByRole('button', { name: /sync approved change orders/i })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('sov-reopen'));
    expect(await screen.findByText(/3 pay applications will recompute/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /reopen/i }));
    await waitFor(() => expect(h.unlockSov).toHaveBeenCalledWith('p1'));
  });

  it('contract lines and change-order lines render in separate sections; CO section has no edit controls even when unlocked', async () => {
    h.getSov.mockResolvedValue([line({}), line({ id: 'co', itemNo: 'CO-1', description: 'Extra', isChangeOrder: 1, changeOrderId: 'c1', sortOrder: 1 })]);
    mount();
    const contract = await screen.findByTestId('sov-contract-section');
    const cos = screen.getByTestId('sov-co-section');
    expect(within(contract).getByText('Framing')).toBeInTheDocument();
    expect(within(cos).getByText('Extra')).toBeInTheDocument();
    expect(within(cos).queryByTitle('Edit')).toBeNull();
  });

  it('header and blank rows render without money; add form can create a header and a blank', async () => {
    h.getSov.mockResolvedValue([line({}), line({ id: 'h', lineType: 'header', description: 'Interior', itemNo: null, scheduledValueCents: 0, sortOrder: 1 }), line({ id: 'b', lineType: 'blank', description: '', itemNo: null, scheduledValueCents: 0, sortOrder: 2 })]);
    mount();
    const hRow = await screen.findByTestId('sov-row-h');
    expect(hRow).toHaveTextContent('Interior');
    expect(within(hRow).queryByText('$0.00')).toBeNull();
    expect(screen.getByTestId('sov-row-b')).toHaveTextContent(/blank/i);
    await userEvent.selectOptions(screen.getByTestId('sov-new-type'), 'header');
    await userEvent.type(screen.getByLabelText('Description'), 'Exterior');
    await userEvent.click(screen.getByRole('button', { name: /add line/i }));
    await waitFor(() => expect(h.createSovLine).toHaveBeenCalledWith('p1', expect.objectContaining({ lineType: 'header', description: 'Exterior' })));
    await userEvent.selectOptions(screen.getByTestId('sov-new-type'), 'blank');
    await userEvent.click(screen.getByRole('button', { name: /add line/i }));
    await waitFor(() => expect(h.createSovLine).toHaveBeenLastCalledWith('p1', { lineType: 'blank' }));
  });

  it('move down sends the full new order; insert header above sends insertBeforeId', async () => {
    h.getSov.mockResolvedValue([line({ id: 'a', description: 'A' }), line({ id: 'b', description: 'B', sortOrder: 1 })]);
    mount();
    await userEvent.click(await screen.findByTestId('sov-move-down-a'));
    await waitFor(() => expect(h.reorderSov).toHaveBeenCalledWith('p1', ['b', 'a']));
    await userEvent.click(screen.getByTestId('sov-insert-header-b'));
    await waitFor(() => expect(h.createSovLine).toHaveBeenCalledWith('p1', { lineType: 'header', description: 'New section', insertBeforeId: 'b' }));
  });

  it('a sov_locked rejection toasts and refetches the lock state', async () => {
    h.getSov.mockResolvedValue([line({})]);
    h.deleteSovLine.mockRejectedValueOnce(Object.assign(new Error('locked'), { name: 'SovLockedError' }));
    mount();
    await userEvent.click(await screen.findByTitle('Delete'));
    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    expect(await screen.findByText(/schedule of values is finalized/i)).toBeInTheDocument();
    await waitFor(() => expect(h.getSovLock).toHaveBeenCalledTimes(2));
  });
});
```

(`@testing-library/user-event` is installed. Add `import userEvent from '@testing-library/user-event';` and add `within` to the existing `@testing-library/react` import; the file's `mount()` wraps the component in `ToastProvider` + `ConfirmProvider`, which is what the confirm-dialog assertions rely on.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/pages/project/billing/AiaScheduleOfValues.test.tsx`
Expected: FAIL — testids missing.

- [ ] **Step 3: Implement**

Rewrite `AiaScheduleOfValues.tsx` following this structure (keep every existing behavior: download, seed, sync, import, inline edit, add, totals, live refresh, presence banner):

```tsx
// imports: add ArrowUp, ArrowDown, Heading, Minus, Scissors, Lock, Unlock from 'lucide-react';
// add getSovLock, lockSov, unlockSov, reorderSov, SovLockState, SovLineType, lineTypeOf, SovLockedError to the store import;
// add Select, StatusPill to the ui import.

const [lock, setLock] = useState<SovLockState | null>(null);
const loadLock = () => getSovLock(projectId).then(setLock).catch(() => setLock(null));
const reload = () => { getSov(projectId).then(setLines).catch(() => setLines([])); loadLock(); };
// useLiveQuery(reload, ...) unchanged — lock/unlock broadcast aiaSov so this refetches both.

const locked = !!lock?.locked;
const contract = (lines ?? []).filter(l => !isCo(l));
const cos = (lines ?? []).filter(isCo);

// Every mutation funnels its error through this, so a lock raised elsewhere
// (another admin, or the first pay app just created) is explained and the
// controls disappear on the refetch.
const onMutationError = (e: unknown, fallback: string) => {
  if (e instanceof Error && e.name === 'SovLockedError') { toast('Schedule of values is finalized', { type: 'error' }); loadLock(); return; }
  if (e instanceof Error && e.name === 'ConflictError') { toast('Line changed elsewhere — reload', { type: 'error' }); return; }
  toast(fallback, { type: 'error' });
};

const finalize = async () => {
  const ok = await confirm({ title: 'Finalize schedule of values?', message: "Lines can't be changed until an admin reopens it. Approved change orders can still be synced.", confirmLabel: 'Finalize' });
  if (!ok) return;
  try { setLock(await lockSov(projectId)); toast('Schedule of values finalized', { type: 'success' }); }
  catch { toast('Failed to finalize', { type: 'error' }); }
};
const reopen = async () => {
  const n = lock?.payAppCount ?? 0;
  const ok = await confirm({ title: 'Reopen schedule of values?', tone: 'danger', confirmLabel: 'Reopen',
    message: `${n} pay application${n === 1 ? '' : 's'} will recompute from any values you change. Exports will be marked out of date.` });
  if (!ok) return;
  try { setLock(await unlockSov(projectId)); toast('Schedule of values reopened', { type: 'warning' }); }
  catch { toast('Failed to reopen', { type: 'error' }); }
};

const move = async (l: AiaSovLine, dir: -1 | 1) => {
  const ids = contract.map(x => x.id);
  const i = ids.indexOf(l.id); const j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try { await reorderSov(projectId, ids); reload(); } catch (e) { onMutationError(e, 'Failed to move line'); }
};
const insertAbove = async (l: AiaSovLine, lineType: 'header' | 'blank') => {
  try {
    await createSovLine(projectId, lineType === 'header' ? { lineType, description: 'New section', insertBeforeId: l.id } : { lineType, insertBeforeId: l.id });
    reload();
  } catch (e) { onMutationError(e, 'Failed to insert line'); }
};

// add form: const [nType, setNType] = useState<SovLineType>('item');
const addLine = async () => {
  try {
    if (nType === 'blank') await createSovLine(projectId, { lineType: 'blank' });
    else if (nType === 'header') { if (!nDesc.trim()) { toast('Enter a description', { type: 'warning' }); return; } await createSovLine(projectId, { lineType: 'header', description: nDesc.trim(), itemNo: nItemNo.trim() || null }); }
    else {
      if (!nDesc.trim()) { toast('Enter a description', { type: 'warning' }); return; }
      const retNum = nRetainage.trim() === '' ? null : parseFloat(nRetainage);
      await createSovLine(projectId, {
        lineType: 'item',
        itemNo: nItemNo.trim() || null,
        description: nDesc.trim(),
        scheduledValueCents: dollarsToCents(nValue),
        retainagePercent: retNum != null && Number.isFinite(retNum) ? retNum : null,
      });
    }
    setNItemNo(''); setNDesc(''); setNValue(''); setNRetainage('');
    reload();
  } catch (e) { onMutationError(e, 'Failed to add line'); }
};
```

Rendering:

- `CardHeader` actions: prepend the chip:
  ```tsx
  <span data-testid="sov-lock-chip">
    {lock === null ? null : locked
      ? <StatusPill tone="amber"><Lock size={12} /> Locked · {new Date(lock.lockedAt!).toLocaleDateString()} · {lock.reason === 'pay-app' ? 'first pay application' : `by ${lock.lockedByName ?? 'admin'}`}</StatusPill>
      : <StatusPill tone="slate">Draft</StatusPill>}
  </span>
  {lock !== null && (locked
    ? <Button size="sm" variant="secondary" data-testid="sov-reopen" onClick={reopen}><Unlock size={14} />Reopen</Button>
    : <Button size="sm" variant="secondary" data-testid="sov-finalize" onClick={finalize} disabled={busy}><Lock size={14} />Finalize SOV</Button>)}
  ```
  (`PillTone` in `StatusPill.tsx` is `'slate' | 'blue' | 'violet' | 'green' | 'emerald' | 'amber' | 'orange' | 'red'`.)
- Wrap Seed / Upload / Import / help in `{!locked && (...)}`. Download and Sync stay.
- Locked note under the header: `{locked && <p className="border-b border-edge px-4 py-2 text-xs text-ink-faint">Finalized — reopen to edit lines. Approved change orders can still be synced.</p>}`.
- **Contract section** `<div data-testid="sov-contract-section">` with the existing table over `contract`:
  - row `data-testid={`sov-row-${l.id}`}`.
  - header row: item no cell, description cell `font-semibold` (no CO badge), value cell empty (`—`), retainage cell empty.
  - blank row: `<TD colSpan={perLine ? 4 : 3} className="text-xs italic text-ink-faint">— blank —</TD>` then actions.
  - action cell (only when `!locked`): Edit (items + headers), Delete, then `sov-move-up-<id>` / `sov-move-down-<id>` (ArrowUp/ArrowDown, disabled at the ends), `sov-insert-header-<id>` (Heading icon, title "Insert header above"), `sov-insert-blank-<id>` (Minus icon, title "Insert blank above"), and for items only `sov-split-<id>` (Scissors, title "Split…") which calls `setSplitTarget(l)` — state consumed in Task 11 (declare `const [splitTarget, setSplitTarget] = useState<AiaSovLine | null>(null);` now; render nothing for it yet).
  - inline edit for a header: item no + description inputs only; `saveEdit` sends `scheduledValueCents: 0, retainagePercent: null` for headers.
- **Change-orders section** `<div data-testid="sov-co-section">` rendered when `cos.length > 0`: a small heading "Change orders" + read-only table (Item no, Description, Amount) and the Sync button moved here (keep it in the header actions as well is fine; the test only needs it present).
- Add-line form (`!locked` only): prepend `<Field label="Type" htmlFor="sov-type"><Select id="sov-type" data-testid="sov-new-type" value={nType} onChange={e => setNType(e.target.value as SovLineType)}><option value="item">Item</option><option value="header">Header</option><option value="blank">Blank</option></Select></Field>`; hide value/retainage inputs when `nType !== 'item'`, hide description/item no when `nType === 'blank'`.
- Totals: `originalCents` over `contract.filter(l => lineTypeOf(l) === 'item')`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/pages/project/billing/AiaScheduleOfValues.test.tsx`
Expected: PASS (new + the 3 existing import tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run lint
git add src/pages/project/billing/AiaScheduleOfValues.tsx src/pages/project/billing/AiaScheduleOfValues.test.tsx
git commit -m "feat(aia): SOV editor — finalize/reopen, contract vs change-order sections, header/blank lines, row actions"
```

---

### Task 11: Split modal

**Files:**
- Create: `src/pages/project/billing/SplitSovLineModal.tsx`
- Create: `src/pages/project/billing/SplitSovLineModal.test.tsx`
- Modify: `src/pages/project/billing/AiaScheduleOfValues.tsx` (render the modal for `splitTarget`)

**Interfaces:**
- Produces: `export const SplitSovLineModal: React.FC<{ line: AiaSovLine | null; onClose: () => void; onSplit: () => void }>`; `export function allocateCents(originalCents: number, percents: number[]): number[]` (same rounding as the server: per-part `Math.round(original * bp / 10000)`, last part takes the remainder).

- [ ] **Step 1: Write the failing tests**

`src/pages/project/billing/SplitSovLineModal.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../../components/Toast';

const h = vi.hoisted(() => ({ splitSovLine: vi.fn(async () => ({ header: {}, children: [] })) }));
vi.mock('../../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../../utils/store')>()),
  splitSovLine: h.splitSovLine,
}));

import { SplitSovLineModal, allocateCents } from './SplitSovLineModal';

const line: any = { id: 'l1', projectId: 'p1', itemNo: '5', description: 'Drywall', scheduledValueCents: 1000000, retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 0, version: 3, createdAt: 0, lineType: 'item' };

const mount = (onSplit = vi.fn(), onClose = vi.fn()) => {
  render(<ToastProvider><SplitSovLineModal line={line} onClose={onClose} onSplit={onSplit} /></ToastProvider>);
  return { onSplit, onClose };
};

beforeEach(() => vi.clearAllMocks());

describe('allocateCents', () => {
  it('rounds per part and gives the remainder to the last part', () => {
    expect(allocateCents(1000000, [60, 40])).toEqual([600000, 400000]);
    expect(allocateCents(10001, [33.34, 33.33, 33.33])).toEqual([3334, 3333, 3334]);
  });
});

describe('SplitSovLineModal', () => {
  it('starts with two 50/50 parts, previews dollars, and enables Split only at exactly 100%', async () => {
    mount();
    expect(screen.getByText('Drywall')).toBeInTheDocument();
    expect(screen.getByText('$10,000.00')).toBeInTheDocument();
    expect(screen.getAllByTestId('split-part-percent')).toHaveLength(2);
    expect(screen.getAllByText('$5,000.00')).toHaveLength(2);
    expect(screen.getByTestId('split-remaining')).toHaveTextContent('0.00%');
    const [p1] = screen.getAllByTestId('split-part-percent');
    await userEvent.clear(p1); await userEvent.type(p1, '60');
    expect(screen.getByTestId('split-remaining')).toHaveTextContent('-10.00%');
    expect(screen.getByTestId('split-submit')).toBeDisabled();
    const [, p2] = screen.getAllByTestId('split-part-percent');
    await userEvent.clear(p2); await userEvent.type(p2, '40');
    expect(screen.getByTestId('split-submit')).toBeEnabled();
  });

  it('Even split distributes to 2 dp with the last part absorbing the remainder; Add part appends a row', async () => {
    mount();
    await userEvent.click(screen.getByTestId('split-add-part'));
    await userEvent.click(screen.getByTestId('split-even'));
    const pcts = screen.getAllByTestId('split-part-percent').map(i => (i as HTMLInputElement).value);
    expect(pcts).toEqual(['33.33', '33.33', '33.34']);
    expect(screen.getByTestId('split-remaining')).toHaveTextContent('0.00%');
  });

  it('submits descriptions + percents with the line version, then calls onSplit and onClose', async () => {
    const { onSplit, onClose } = mount();
    const [d1, d2] = screen.getAllByTestId('split-part-description');
    await userEvent.clear(d1); await userEvent.type(d1, 'Level 1');
    await userEvent.clear(d2); await userEvent.type(d2, 'Level 2');
    await userEvent.click(screen.getByTestId('split-submit'));
    await waitFor(() => expect(h.splitSovLine).toHaveBeenCalledWith('l1', 3, [{ description: 'Level 1', percent: 50 }, { description: 'Level 2', percent: 50 }]));
    expect(onSplit).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('blocks submit when a description is empty', async () => {
    mount();
    const [d1] = screen.getAllByTestId('split-part-description');
    await userEvent.clear(d1);
    expect(screen.getByTestId('split-submit')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/pages/project/billing/SplitSovLineModal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the modal**

`src/pages/project/billing/SplitSovLineModal.tsx`:

```tsx
// src/pages/project/billing/SplitSovLineModal.tsx
//
// Split one SOV item line into percentage-valued children under the original
// as a header (spec 2026-09-11 §Split). Percent math mirrors the server:
// basis points, last part takes the rounding remainder.
import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { AiaSovLine, splitSovLine } from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { Button, Input, Modal } from '../../../components/ui';

interface Part { description: string; percent: string }

const bpOf = (percent: string): number => {
  const n = Number(percent);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export function allocateCents(originalCents: number, percents: number[]): number[] {
  let allocated = 0;
  return percents.map((p, i) => {
    const last = i === percents.length - 1;
    const cents = last ? originalCents - allocated : Math.round(originalCents * Math.round(p * 100) / 10000);
    allocated += cents;
    return cents;
  });
}

const evenSplit = (n: number): string[] => {
  const each = Math.floor(10000 / n); // basis points
  const parts = Array.from({ length: n }, () => each);
  parts[n - 1] = 10000 - each * (n - 1);
  return parts.map(bp => (bp / 100).toFixed(2));
};

export const SplitSovLineModal: React.FC<{ line: AiaSovLine | null; onClose: () => void; onSplit: () => void }> = ({ line, onClose, onSplit }) => {
  const { toast } = useToast();
  const [parts, setParts] = useState<Part[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (line) setParts([{ description: 'Part 1', percent: '50' }, { description: 'Part 2', percent: '50' }]);
  }, [line?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalBp = parts.reduce((a, p) => a + bpOf(p.percent), 0);
  const remainingBp = 10000 - totalBp;
  const cents = useMemo(() => line ? allocateCents(line.scheduledValueCents, parts.map(p => Number(p.percent) || 0)) : [], [line, parts]);
  const valid = !!line && parts.length >= 2 && remainingBp === 0
    && parts.every(p => p.description.trim() !== '' && bpOf(p.percent) > 0);

  const setPart = (i: number, patch: Partial<Part>) => setParts(ps => ps.map((p, j) => j === i ? { ...p, ...patch } : p));

  const submit = async () => {
    if (!line || !valid) return;
    setBusy(true);
    try {
      await splitSovLine(line.id, line.version, parts.map(p => ({ description: p.description.trim(), percent: Number(p.percent) })));
      toast(`Split into ${parts.length} lines`, { type: 'success' });
      onSplit();
      onClose();
    } catch (e) {
      toast(e instanceof Error && e.name === 'SovLockedError' ? 'Schedule of values is finalized'
        : e instanceof Error && e.name === 'ConflictError' ? 'Line changed elsewhere — reload'
        : 'Failed to split line', { type: 'error' });
    } finally { setBusy(false); }
  };

  return (
    <Modal open={!!line} onClose={onClose} title="Split line" width="md"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button data-testid="split-submit" onClick={submit} disabled={!valid || busy}>{busy ? 'Splitting…' : 'Split'}</Button>
      </>}>
      {line && (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <div className="font-medium text-ink">{line.description}</div>
            <div className="tabular-nums text-ink-soft">{formatMoney(line.scheduledValueCents)}</div>
          </div>
          <p className="text-xs text-ink-faint">The original becomes a header; each part below becomes an item line under it.</p>
          <div className="space-y-2">
            {parts.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input data-testid="split-part-description" value={p.description} onChange={e => setPart(i, { description: e.target.value })} className="flex-1" aria-label={`Part ${i + 1} description`} />
                <Input data-testid="split-part-percent" type="number" step="0.01" min="0" value={p.percent} onChange={e => setPart(i, { percent: e.target.value })} className="w-24 text-right" aria-label={`Part ${i + 1} percent`} />
                <span className="w-6 text-ink-faint">%</span>
                <span className="w-28 text-right tabular-nums text-ink-soft">{formatMoney(cents[i] ?? 0)}</span>
                <button onClick={() => setParts(ps => ps.filter((_, j) => j !== i))} disabled={parts.length <= 2} title="Remove part"
                  className="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600 disabled:opacity-40"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" data-testid="split-add-part" onClick={() => setParts(ps => [...ps, { description: `Part ${ps.length + 1}`, percent: '0' }])}><Plus size={14} />Add part</Button>
              <Button size="sm" variant="ghost" data-testid="split-even" onClick={() => setParts(ps => evenSplit(ps.length).map((pct, i) => ({ ...ps[i], percent: pct })))}>Even split</Button>
            </div>
            <div data-testid="split-remaining" className={`text-sm tabular-nums ${remainingBp === 0 ? 'text-green-600' : 'text-red-600'}`}>
              Remaining: {(remainingBp / 100).toFixed(2)}%
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};
```

In `AiaScheduleOfValues.tsx`, import `SplitSovLineModal` and render after the closing `</CardBody>`:

```tsx
      <SplitSovLineModal line={splitTarget} onClose={() => setSplitTarget(null)} onSplit={reload} />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/pages/project/billing`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run lint
git add src/pages/project/billing/SplitSovLineModal.tsx src/pages/project/billing/SplitSovLineModal.test.tsx src/pages/project/billing/AiaScheduleOfValues.tsx
git commit -m "feat(aia): split-by-percentage modal for SOV lines"
```

---

### Task 12: End-to-end spec, changelog, full verification

**Files:**
- Create: `e2e/aia-sov-finalize.spec.ts`
- Modify: `src/pages/Settings.tsx` (CHANGELOG top entry)

- [ ] **Step 1: Write the Playwright spec**

Model login/seeding on `e2e/document-actions.spec.ts` (`test`, `expect`, `seedProjectWithPage` from `./fixtures/test`; `apiToken` gives a bearer token; `authedPage` is logged in as admin). The billing page is `/project/<id>/billing?tab=sov`.

```ts
import { test, expect, seedProjectWithPage } from './fixtures/test';

// Spec docs/superpowers/specs/2026-09-11-sov-finalize-headers-split-design.md:
// build an SOV with a header and a split, create pay app #1 (auto-lock),
// prove the lock, reopen, edit — the warned recompute.
test('SOV: header + split, first pay app locks, reopen restores editing', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const { projectId } = await seedProjectWithPage(request, token);
  const mk = async (body: Record<string, unknown>) => {
    const r = await request.post(`/api/projects/${projectId}/aia/sov`, { headers: auth, data: body });
    expect(r.ok()).toBeTruthy();
    return (await r.json()).id as string;
  };
  const drywall = await mk({ itemNo: '1', description: 'Drywall', scheduledValueCents: 1000000 });
  const paint = await mk({ itemNo: '2', description: 'Paint', scheduledValueCents: 200000 });

  await authedPage.goto(`/project/${projectId}/billing?tab=sov`);
  await expect(authedPage.getByTestId('sov-lock-chip')).toHaveText(/draft/i);

  // Insert a header above Paint, split Drywall 60/40.
  await authedPage.getByTestId(`sov-insert-header-${paint}`).click();
  await expect(authedPage.getByTestId('sov-contract-section')).toContainText('New section');
  await authedPage.getByTestId(`sov-split-${drywall}`).click();
  const dialog = authedPage.getByRole('dialog', { name: /split line/i });
  const descs = dialog.getByTestId('split-part-description');
  const pcts = dialog.getByTestId('split-part-percent');
  await descs.nth(0).fill('Level 1'); await pcts.nth(0).fill('60');
  await descs.nth(1).fill('Level 2'); await pcts.nth(1).fill('40');
  await dialog.getByTestId('split-submit').click();
  await expect(authedPage.getByTestId('sov-contract-section')).toContainText('Level 1');
  await expect(authedPage.getByTestId('sov-contract-section')).toContainText('$6,000.00');
  await expect(authedPage.getByTestId('sov-contract-section')).toContainText('$4,000.00');

  // First pay application → auto-lock.
  const pa = await request.post(`/api/projects/${projectId}/aia/pay-apps`, { headers: auth, data: {} });
  expect(pa.ok()).toBeTruthy();
  await authedPage.reload();
  await expect(authedPage.getByTestId('sov-lock-chip')).toHaveText(/locked/i);
  await expect(authedPage.getByTestId('sov-lock-chip')).toHaveText(/first pay application/i);
  await expect(authedPage.getByTitle('Edit')).toHaveCount(0);
  await expect(authedPage.getByTestId(`sov-split-${drywall}`)).toHaveCount(0);
  await expect(authedPage.getByRole('button', { name: /sync approved change orders/i })).toBeVisible();
  // server refuses too
  const blocked = await request.post(`/api/projects/${projectId}/aia/sov`, { headers: auth, data: { description: 'X', scheduledValueCents: 1 } });
  expect(blocked.status()).toBe(409);

  // Reopen (warned) → controls are back.
  await authedPage.getByTestId('sov-reopen').click();
  await expect(authedPage.getByText(/1 pay application will recompute/i)).toBeVisible();
  await authedPage.getByRole('button', { name: /^reopen$/i }).click();
  await expect(authedPage.getByTestId('sov-lock-chip')).toHaveText(/draft/i);
  await expect(authedPage.getByTitle('Edit').first()).toBeVisible();

  // The G703 for pay app #1 shows the header row and both children.
  const g703 = await (await request.get(`/api/aia/pay-apps/${(await pa.json()).id}`, { headers: auth })).json();
  expect(g703.g703.map((r: any) => r.lineType)).toEqual(['header', 'item', 'item', 'header', 'item']);
});
```

- [ ] **Step 2: Run the spec**

Run: `rm -rf .e2e-data && npx playwright test e2e/aia-sov-finalize.spec.ts`
Expected: 1 passed. If a locator differs from the implementation, fix the spec to the real testids (the testids are listed in Task 10/11 Interfaces).

- [ ] **Step 3: Changelog**

In `src/pages/Settings.tsx`, insert a new first entry in `CHANGELOG`:

```ts
  {
    version: '3.2.0',
    date: 'September 12, 2026',
    changes: [
      'Schedule of values can be finalized: from the SOV tab, or automatically when the first pay application is created. A finalized SOV refuses line edits (server-enforced) so earlier pay applications never change under you; approved change orders can still be synced in. Admins can reopen it with a warning.',
      'SOV supports header lines (label-only section titles) and blank spacer lines. They show in the SOV editor, the pay-app G703, and the Excel export, and never count toward any total.',
      'Split an SOV line by percentage: the original becomes a header and each part becomes an item line under it (e.g. 60/40), with item numbers like 5.1, 5.2. Cents always add up to the original.',
      'SOV editor: contract lines and change-order lines are now separate sections; move lines up/down, insert a header or blank above any line.',
    ],
  },
```

- [ ] **Step 4: Full verification**

```bash
npm run lint
npm test
rm -rf .e2e-data && npx playwright test e2e/aia-sov-finalize.spec.ts e2e/document-actions.spec.ts
```
Expected: tsc clean; all vitest files pass; the two specs pass.

- [ ] **Step 5: Commit**

```bash
git add e2e/aia-sov-finalize.spec.ts src/pages/Settings.tsx
git commit -m "test(aia): SOV finalize/header/split e2e; changelog 3.2.0"
```

Do **not** push. The coordinator pushes to `testing` after review, and flags migration 35's lock backfill to Nathan before the Unraid pull.
