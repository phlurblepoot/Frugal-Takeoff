# Phase 4b: Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-project Issue reports — numbered deficiency/observation records (ISS-001…) with photos, an open → sent → resolved lifecycle, and a "send" that emails a PDF report to the contractor and logs it. Field-usable (mobile photo capture), available to every authenticated user.

**Architecture:** Two tables (migration 9): `issues` (per-project sequential number, title, description, status, version, sentAt) and `issue_photos` (join from issue → existing `files` rows, so photos reuse the Phase 1 file store). A `server/issueStore.ts` owns numbering (MAX+1 per project in a transaction) and version-checked body saves. Routes are auth-only (NOT admin — field members file issues). The client gets a `ProjectIssues` section (list + editor with photo gallery and mobile camera capture), an `IssueStatusPill`, an issue-report PDF (reusing the Phase 4a accent/logo PDF helpers), and "send" via the shared `sendProjectEmail` helper. Open-issue count surfaces on the project summary + Overview (not pricing — visible to all).

**Tech Stack:** Express 4 + better-sqlite3, Vitest (server node + ui jsdom), Supertest, React 19 + react-router 7 nested routes, Phase 2 ui library, jsPDF, nodemailer (existing SMTP).

**Spec:** `docs/superpowers/specs/2026-06-11-cohesive-app-design.md` (§2 "New facets: Issue reports", §3.2 issues table, §4.2 Issues section, §4.3 mobile-first field use, §6 outbound email). This is sub-plan **4b** of Phase 4 (4a Billing shipped; 4c Punch follows).

**Branch:** all work on `testing` (per project CLAUDE.md — push directly, no PRs).

---

## Context You Must Know Before Starting

1. **Data layer (Phases 1–4a):** `server/migrationList.ts` holds migrations 1–8 (latest = 8 `billing`); the framework auto-backs-up the DB before applying. `registerDataRoutes(app, deps)` with `RouteDeps {db, dataDir, dbFile, authenticateToken, requireAdmin, verifyToken}`. `server/projectStore.ts` has `loadProject/listProjectSummaries/deleteProject` + errors; `server/activity.ts` has `logActivity`; `server/files.ts` has `putBuffer/getMeta/getDataUrlString`. The 4a `billingStore.ts` + `sendProjectEmail` helper (in `server.ts`) are the closest patterns to copy.
2. **Issues are NOT admin-only.** Every authenticated user (field members included) can create/edit/send issues — routes use `authenticateToken` only, no `requireAdmin`. (Contrast: billing is admin-gated.)
3. **Per-project numbering:** `issues.number` is an INTEGER sequence per project (1, 2, 3…). Compute `MAX(number)+1 WHERE projectId` inside the create transaction to avoid races. Display as `ISS-001` (zero-padded to 3) client-side.
4. **Photos reuse the files store.** The client uploads each photo via the existing `uploadProjectFile(projectId, file, 'photo')` → returns a fileId; then links it with `POST /api/issues/:id/photos {fileId}`. Photos render via the PUBLIC `getImageUrl(fileId)` = `/api/images/:id/raw` (used in `<img src>`). An `issue_photos` join table links issue→file. On photo unlink we do NOT delete the file (orphan cleanup handles it; it stays project-attributed so 3b's orphan guard spares it while the project lives).
5. **deleteProject cascade** (`projectStore.ts` `deleteProject`, inside its `db.transaction`) currently cleans measurements/pages/takeoffs/plan_sets, drafts, billing rows, files, projects. Add `issue_photos` (via issue subquery) then `issues` (Task 1).
6. **Version-checked body saves:** issue title/description edits carry a `version` (optimistic concurrency like invoices/projects); status changes and photo add/remove are simpler operations that don't need the version handshake (low contention). 409 on stale body save.
7. **SMTP send:** reuse `sendProjectEmail({to, subject, text, fileId, attachmentName})` extracted in 4a (`server.ts`). The client builds the issue-report PDF, uploads it as a `files` row (kind `issue`), then `POST /api/issues/:id/send {to, fileId, message?}` emails it, marks `sentAt` + status `sent`, logs `issue_sent`.
8. **PDF:** reuse the Phase 4a PDF helpers pattern — `resolveAccentRgb()` (reads `--color-accent-600` → rgb) and the logo-inlining from `src/pages/project/billing/invoicePdf.ts`. The issue report uses the SAME visual language (logo + company block, accent title) for consistency. Photos are embedded via `doc.addImage` (fetch each photo as a dataURL first).
9. **ui library + section pattern:** import from `../../components/ui`; section pages use `useParams` + `useProjectOutlet()`; `uploadProjectFile`/`fetchFileBlob`/`getImageUrl` in store.ts. Toast `const {toast}=useToast()`; `useConfirm`. Mobile camera capture: `<input type="file" accept="image/*" capture="environment" multiple>`.
10. **Overview** Details card (`src/pages/project/ProjectOverview.tsx`) shows pageCount/takeoffCount; add an "open issues" stat (visible to all — not gated). The project summary gains `openIssueCount` (ungated, unlike the admin-only billing fields).
11. **Tests:** server `server/*.test.ts` (node), ui `src/**/*.test.tsx` (jsdom, globals:true). `npm test`, `npm run lint`, boot `STORAGE_PATH=$(mktemp -d) npm run dev` (kill stale servers by the real port-3000 PID via `ss -tlnp | grep :3000` → `kill`; `pkill -f`/`pgrep -f "tsx server"` match your own shell).
12. **Line numbers are approximate** — anchor by content; NEEDS_CONTEXT over guessing.

## File Structure

```
server/migrationList.ts        # + migration 9 'issues' (issues, issue_photos)
server/projectStore.ts         # deleteProject cascade + issue tables; listProjectSummaries + openIssueCount
server/issueStore.ts           # NEW: numbering, issue CRUD, version-checked body, status, photos, markSent
server/issueStore.test.ts      # NEW
server/routes.ts               # + issue routes (auth only) + activity
server/routes.test.ts          # + issue route integration tests
server/migrationList.test.ts   # + migration 9 test
server.ts                      # + POST /api/issues/:id/send (reuses sendProjectEmail)
src/utils/store.ts             # + Issue/IssueListItem/IssuePhoto types + helpers; ProjectSummary.openIssueCount
src/components/ui/IssueStatusPill.tsx       # NEW
src/components/ui/IssueStatusPill.test.tsx  # NEW
src/pages/project/ProjectIssues.tsx         # NEW: section page (list + create)
src/pages/project/issues/IssueEditor.tsx    # NEW: body + status + photo gallery + send
src/pages/project/issues/issuePdf.ts        # NEW: jsPDF issue report (reuses 4a accent/logo helpers)
src/pages/project/issues/issuePdf.test.ts   # NEW
src/components/shell/Sidebar.tsx            # + Issues nav entry (NOT adminOnly)
src/components/shell/Sidebar.test.tsx       # Issues-visible test
src/App.tsx                    # + issues route under the project tree
src/pages/project/ProjectOverview.tsx       # open-issues stat in Details
```

Status vocabulary (locked in): **issue** `open | sent | resolved`. Activity events added: `issue_created`, `issue_sent`, `issue_resolved`.

---

### Task 1: Migration 9 — Issue Tables + Delete Cascade

**Files:**
- Modify: `server/migrationList.ts` (append migration 9)
- Modify: `server/projectStore.ts` (deleteProject cascade)
- Test: `server/migrationList.test.ts` (append)

- [ ] **Step 1: Write the failing migration test** (append to `server/migrationList.test.ts`)

```ts
describe('migration 9: issues', () => {
  it('creates issues and issue_photos', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    expect(tables).toContain('issues');
    expect(tables).toContain('issue_photos');
    const issCols = (db.prepare(`PRAGMA table_info(issues)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'projectId', 'number', 'title', 'description', 'status', 'version', 'sentAt', 'createdAt']) {
      expect(issCols, `issues missing ${c}`).toContain(c);
    }
    const phCols = (db.prepare(`PRAGMA table_info(issue_photos)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'issueId', 'fileId', 'sortOrder', 'createdAt']) {
      expect(phCols, `issue_photos missing ${c}`).toContain(c);
    }
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/migrationList.test.ts`
Expected: FAIL — issue tables absent.

- [ ] **Step 3: Append migration 9 to `server/migrationList.ts`**

```ts
  {
    version: 9,
    name: 'issues',
    up({ db }) {
      // Issue reports (spec §2 new facets, §3.2): numbered deficiency/observation
      // records with photos and an open→sent→resolved lifecycle. Field-created by
      // any user (not admin-gated). number is a per-project sequence (MAX+1).
      // Photos are existing files rows linked via issue_photos.
      db.exec(`
        CREATE TABLE issues (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number INTEGER NOT NULL,
          title TEXT,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          version INTEGER NOT NULL DEFAULT 1,
          sentAt INTEGER,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_issues_projectId ON issues (projectId);

        CREATE TABLE issue_photos (
          id TEXT PRIMARY KEY,
          issueId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_issue_photos_issueId ON issue_photos (issueId);
      `);
    },
  },
```

- [ ] **Step 4: Extend the deleteProject cascade in `server/projectStore.ts`**

In `deleteProject`, inside the existing `db.transaction(() => {...})`, before the `DELETE FROM files` line (and near the billing deletes from 4a), add:

```ts
    // Issue rows (Phase 4b) — photos link to issues, delete photos first.
    db.prepare('DELETE FROM issue_photos WHERE issueId IN (SELECT id FROM issues WHERE projectId = ?)').run(id);
    db.prepare('DELETE FROM issues WHERE projectId = ?').run(id);
```

- [ ] **Step 5: Add a delete-cascade test** (append to `server/routes.test.ts`; goes meaningfully green after Task 4)

```ts
describe('deleteProject issues cascade', () => {
  it('removes issues and issue_photos for the project', async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
    const iss = await request(app).post('/api/projects/p1/issues').send({ title: 'Crack', description: 'Wall crack' });
    await request(app).post('/api/files/ph1?projectId=p1&kind=photo&name=p.jpg')
      .set('Content-Type', 'image/jpeg').send(Buffer.from('img'));
    await request(app).post(`/api/issues/${iss.body.id}/photos`).send({ fileId: 'ph1' });
    await request(app).delete('/api/projects/p1');
    expect((db.prepare('SELECT COUNT(*) c FROM issues WHERE projectId = ?').get('p1') as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM issue_photos WHERE issueId IN (SELECT id FROM issues WHERE projectId = ?)').get('p1') as any).c).toBe(0);
  });
});
```

(Depends on Tasks 2-4 routes — vacuously passes until then, meaningful after Task 4.)

- [ ] **Step 6: Run the migration test + lint**

Run: `npx vitest run server/migrationList.test.ts && npm run lint`
Expected: migration test PASS; lint clean.

- [ ] **Step 7: Commit**

```bash
git add server/migrationList.ts server/migrationList.test.ts server/projectStore.ts server/routes.test.ts
git commit -m "feat: migration 9 issue tables + delete cascade"
```

---

### Task 2: issueStore — Numbering + Issue CRUD

**Files:**
- Create: `server/issueStore.ts`
- Test: `server/issueStore.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// server/issueStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  listIssues, getIssue, createIssue, saveIssue, setIssueStatus, deleteIssue,
  ValidationError, ConflictError, NotFoundError,
} from './issueStore';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-iss-')), migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p2', 'Proj2', 1);
});

describe('issues', () => {
  it('numbers issues sequentially per project starting at 1', () => {
    const a = createIssue(db, 'p1', { title: 'A' });
    const b = createIssue(db, 'p1', { title: 'B' });
    const c = createIssue(db, 'p2', { title: 'C' }); // separate project sequence
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
    expect(c.number).toBe(1);
    expect(getIssue(db, a.id)!.status).toBe('open');
    expect(getIssue(db, a.id)!.version).toBe(1);
  });

  it('saveIssue is version-checked and updates the body', () => {
    const { id } = createIssue(db, 'p1', { title: 'A', description: 'first' });
    const iss = getIssue(db, id)!;
    const r = saveIssue(db, id, { ...iss, title: 'A2', description: 'second' });
    expect(r.version).toBe(2);
    const reloaded = getIssue(db, id)!;
    expect(reloaded.title).toBe('A2');
    expect(reloaded.description).toBe('second');
    expect(() => saveIssue(db, id, { ...iss })).toThrow(ConflictError); // stale
  });

  it('setIssueStatus validates and updates', () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    setIssueStatus(db, id, 'resolved');
    expect(getIssue(db, id)!.status).toBe('resolved');
    expect(() => setIssueStatus(db, id, 'galactic')).toThrow(ValidationError);
  });

  it('validates create + unknown project + unknown issue', () => {
    expect(() => createIssue(db, 'nope', { title: 'X' })).toThrow(NotFoundError);
    expect(() => createIssue(db, 'p1', { title: '' })).toThrow(ValidationError);
    expect(() => saveIssue(db, 'nope', { version: 1, title: 'X' } as any)).toThrow(NotFoundError);
  });

  it('listIssues returns newest-first with photoCount', () => {
    createIssue(db, 'p1', { title: 'A' });
    createIssue(db, 'p1', { title: 'B' });
    const list = listIssues(db, 'p1');
    expect(list.map(i => i.title)).toEqual(['B', 'A']);
    expect(list[0].photoCount).toBe(0);
  });

  it('deleteIssue removes the issue and its photo links', () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    db.prepare('INSERT INTO issue_photos (id, issueId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)').run('ph', id, 'f1', 0, 1);
    deleteIssue(db, id);
    expect(getIssue(db, id)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM issue_photos').get() as any).c).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/issueStore.test.ts`
Expected: FAIL — `Cannot find module './issueStore'`

- [ ] **Step 3: Implement `server/issueStore.ts`** (numbering + CRUD; photos + markSent are Task 3)

```ts
// server/issueStore.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export const ISSUE_STATUSES = ['open', 'sent', 'resolved'] as const;

function requireProject(db: Database.Database, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('Project not found');
}

interface IssueInput { title?: string; description?: string; status?: string; }

function photoCount(db: Database.Database, issueId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM issue_photos WHERE issueId = ?').get(issueId) as any).c;
}

export function getIssue(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as any;
  if (!row) return null;
  const photos = db.prepare('SELECT id, fileId, sortOrder FROM issue_photos WHERE issueId = ? ORDER BY sortOrder, createdAt').all(id);
  return { ...row, photos };
}

export function listIssues(db: Database.Database, projectId: string): any[] {
  const rows = db.prepare('SELECT * FROM issues WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC').all(projectId) as any[];
  return rows.map(r => ({ ...r, photoCount: photoCount(db, r.id) }));
}

export function createIssue(db: Database.Database, projectId: string, input: IssueInput): { id: string; number: number } {
  requireProject(db, projectId);
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('Issue title is required');
  if (input.status !== undefined && !(ISSUE_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError(`Invalid issue status: ${input.status}`);
  }
  const id = crypto.randomUUID();
  let number = 0;
  const tx = db.transaction(() => {
    const max = (db.prepare('SELECT COALESCE(MAX(number), 0) m FROM issues WHERE projectId = ?').get(projectId) as any).m;
    number = max + 1;
    db.prepare('INSERT INTO issues (id, projectId, number, title, description, status, version, sentAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?)')
      .run(id, projectId, number, input.title.trim(), input.description ?? null, input.status ?? 'open', Date.now());
  });
  tx();
  return { id, number };
}

export function saveIssue(db: Database.Database, id: string, input: IssueInput & { version?: number }): { version: number } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('Issue title is required');
  if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new ValidationError('Missing or invalid version — reload the issue');
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM issues WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('Issue not found');
    if (row.version !== input.version) throw new ConflictError(`Issue changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;
    db.prepare('UPDATE issues SET title = ?, description = ?, version = ? WHERE id = ?')
      .run(input.title.trim(), input.description ?? null, newVersion, id);
  });
  tx();
  return { version: newVersion };
}

export function setIssueStatus(db: Database.Database, id: string, status: string): { status: string } {
  if (!(ISSUE_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Invalid issue status: ${status}`);
  const row = db.prepare('SELECT id FROM issues WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('Issue not found');
  db.prepare('UPDATE issues SET status = ?, version = version + 1 WHERE id = ?').run(status, id);
  return { status };
}

export function deleteIssue(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM issue_photos WHERE issueId = ?').run(id);
    db.prepare('DELETE FROM issues WHERE id = ?').run(id);
  });
  tx();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/issueStore.test.ts && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add server/issueStore.ts server/issueStore.test.ts
git commit -m "feat: issue store — per-project numbering and issue CRUD"
```

---

### Task 3: issueStore — Photos + Mark Sent

**Files:**
- Modify: `server/issueStore.ts` (append)
- Test: `server/issueStore.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append; add `addPhoto, removePhoto, markIssueSent, countOpenIssues` to the import)

```ts
describe('photos + sent', () => {
  it('adds and removes photo links (newest sortOrder appended)', () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    addPhoto(db, id, 'f1');
    addPhoto(db, id, 'f2');
    let iss = getIssue(db, id)!;
    expect(iss.photos.map((p: any) => p.fileId)).toEqual(['f1', 'f2']);
    removePhoto(db, id, 'f1');
    iss = getIssue(db, id)!;
    expect(iss.photos.map((p: any) => p.fileId)).toEqual(['f2']);
  });

  it('addPhoto throws for an unknown issue and is idempotent on duplicate fileId', () => {
    expect(() => addPhoto(db, 'nope', 'f1')).toThrow(NotFoundError);
    const { id } = createIssue(db, 'p1', { title: 'A' });
    addPhoto(db, id, 'f1');
    addPhoto(db, id, 'f1'); // duplicate ignored
    expect(getIssue(db, id)!.photos).toHaveLength(1);
  });

  it('markIssueSent sets sentAt + status sent', () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    markIssueSent(db, id);
    const iss = getIssue(db, id)!;
    expect(iss.status).toBe('sent');
    expect(typeof iss.sentAt).toBe('number');
  });

  it('countOpenIssues counts only open issues for a project', () => {
    const a = createIssue(db, 'p1', { title: 'A' });
    createIssue(db, 'p1', { title: 'B' });
    setIssueStatus(db, a.id, 'resolved');
    expect(countOpenIssues(db, 'p1')).toBe(1);
    expect(countOpenIssues(db, 'p2')).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/issueStore.test.ts`
Expected: FAIL — `addPhoto` not exported.

- [ ] **Step 3: Append to `server/issueStore.ts`**

```ts
export function addPhoto(db: Database.Database, issueId: string, fileId: string): void {
  if (!db.prepare('SELECT id FROM issues WHERE id = ?').get(issueId)) throw new NotFoundError('Issue not found');
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  const exists = db.prepare('SELECT id FROM issue_photos WHERE issueId = ? AND fileId = ?').get(issueId, fileId);
  if (exists) return; // idempotent
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM issue_photos WHERE issueId = ?').get(issueId) as any).m;
  db.prepare('INSERT INTO issue_photos (id, issueId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), issueId, fileId, max + 1, Date.now());
}

export function removePhoto(db: Database.Database, issueId: string, fileId: string): void {
  db.prepare('DELETE FROM issue_photos WHERE issueId = ? AND fileId = ?').run(issueId, fileId);
}

export function markIssueSent(db: Database.Database, id: string): void {
  db.prepare("UPDATE issues SET status = 'sent', sentAt = ?, version = version + 1 WHERE id = ?").run(Date.now(), id);
}

export function countOpenIssues(db: Database.Database, projectId: string): number {
  return (db.prepare("SELECT COUNT(*) c FROM issues WHERE projectId = ? AND status = 'open'").get(projectId) as any).c;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/issueStore.test.ts && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add server/issueStore.ts server/issueStore.test.ts
git commit -m "feat: issue store — photo links, mark-sent, open-issue count"
```

---

### Task 4: Issue Routes (Auth) + Activity

**Files:**
- Modify: `server/routes.ts`
- Test: `server/routes.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append to `server/routes.test.ts`)

```ts
describe('issue routes', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
  });

  it('create → list (ISS number) → get → status', async () => {
    const create = await request(app).post('/api/projects/p1/issues').send({ title: 'Crack', description: 'Wall crack near door' });
    expect(create.status).toBe(200);
    expect(create.body.number).toBe(1);
    const list = await request(app).get('/api/projects/p1/issues');
    expect(list.body[0].number).toBe(1);
    const get = await request(app).get(`/api/issues/${create.body.id}`);
    expect(get.body.title).toBe('Crack');
    expect(get.body.status).toBe('open');
    const patch = await request(app).patch(`/api/issues/${create.body.id}`).send({ status: 'resolved' });
    expect(patch.status).toBe(200);
    expect((await request(app).get(`/api/issues/${create.body.id}`)).body.status).toBe('resolved');
  });

  it('save body is version-checked (409 on stale)', async () => {
    const id = (await request(app).post('/api/projects/p1/issues').send({ title: 'A' })).body.id;
    const iss = (await request(app).get(`/api/issues/${id}`)).body;
    expect((await request(app).put(`/api/issues/${id}`).send({ ...iss, title: 'A2' })).status).toBe(200);
    expect((await request(app).put(`/api/issues/${id}`).send({ ...iss, title: 'Clobber' })).status).toBe(409);
  });

  it('photos: link → appears in get → unlink', async () => {
    const id = (await request(app).post('/api/projects/p1/issues').send({ title: 'A' })).body.id;
    await request(app).post('/api/files/ph1?projectId=p1&kind=photo&name=p.jpg').set('Content-Type', 'image/jpeg').send(Buffer.from('x'));
    await request(app).post(`/api/issues/${id}/photos`).send({ fileId: 'ph1' }).expect(200);
    expect((await request(app).get(`/api/issues/${id}`)).body.photos.map((p: any) => p.fileId)).toEqual(['ph1']);
    await request(app).delete(`/api/issues/${id}/photos/ph1`).expect(200);
    expect((await request(app).get(`/api/issues/${id}`)).body.photos).toHaveLength(0);
  });

  it('validates and 404s', async () => {
    expect((await request(app).post('/api/projects/p1/issues').send({ title: '' })).status).toBe(400);
    expect((await request(app).get('/api/issues/nope')).status).toBe(404);
    expect((await request(app).patch('/api/issues/nope').send({ status: 'open' })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes.test.ts`
Expected: FAIL — issue routes missing.

- [ ] **Step 3: Implement the routes in `server/routes.ts`**

Add the import:

```ts
import {
  listIssues, getIssue, createIssue, saveIssue, setIssueStatus, deleteIssue,
  addPhoto, removePhoto,
  ValidationError as IssueValidationError, ConflictError as IssueConflictError, NotFoundError as IssueNotFoundError,
} from './issueStore';
```

Add a shared error mapper + the routes (auth only — NO requireAdmin; place them together, e.g. after the billing block):

```ts
  // ── Issues (any authenticated user — field-created, spec §4.3) ────────────
  const issueErr = (e: unknown, res: express.Response) => {
    if (e instanceof IssueNotFoundError) return res.status(404).json({ error: e.message });
    if (e instanceof IssueConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
    if (e instanceof IssueValidationError) return res.status(400).json({ error: e.message });
    console.error('Issue error:', e);
    return res.status(500).json({ error: 'Issue operation failed' });
  };

  app.get('/api/projects/:id/issues', authenticateToken, (req, res) => {
    try { res.json(listIssues(db, req.params.id)); } catch (e) { issueErr(e, res); }
  });
  app.post('/api/projects/:id/issues', authenticateToken, (req, res) => {
    try {
      const r = createIssue(db, req.params.id, req.body);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'issue_created', message: `Issue ISS-${String(r.number).padStart(3, '0')} opened: ${req.body?.title ?? ''}` });
      res.json(r);
    } catch (e) { issueErr(e, res); }
  });
  app.get('/api/issues/:id', authenticateToken, (req, res) => {
    try { const iss = getIssue(db, req.params.id); if (!iss) return res.status(404).json({ error: 'Issue not found' }); res.json(iss); } catch (e) { issueErr(e, res); }
  });
  app.put('/api/issues/:id', authenticateToken, (req, res) => {
    try { res.json({ success: true, ...saveIssue(db, req.params.id, req.body) }); } catch (e) { issueErr(e, res); }
  });
  app.patch('/api/issues/:id', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      const r = setIssueStatus(db, req.params.id, req.body.status);
      if (req.body.status === 'resolved') {
        const iss = getIssue(db, req.params.id);
        logActivity(db, { projectId: iss?.projectId, userId: (req as any).user?.id, type: 'issue_resolved', message: `Issue ISS-${String(iss?.number ?? 0).padStart(3, '0')} resolved` });
      }
      res.json({ success: true, ...r });
    } catch (e) { issueErr(e, res); }
  });
  app.delete('/api/issues/:id', authenticateToken, (req, res) => {
    try { deleteIssue(db, req.params.id); res.json({ success: true }); } catch (e) { issueErr(e, res); }
  });
  app.post('/api/issues/:id/photos', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      addPhoto(db, req.params.id, req.body.fileId);
      res.json({ success: true });
    } catch (e) { issueErr(e, res); }
  });
  app.delete('/api/issues/:id/photos/:fileId', authenticateToken, (req, res) => {
    try { removePhoto(db, req.params.id, req.params.fileId); res.json({ success: true }); } catch (e) { issueErr(e, res); }
  });
```

- [ ] **Step 4: Run to verify pass** (also greens Task 1's deferred cascade test)

Run: `npx vitest run server/routes.test.ts server/issueStore.test.ts && npm run lint`
Expected: PASS — issue routes + the Task 1 issues-cascade test now green.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/routes.test.ts
git commit -m "feat: issue routes (auth) with activity logging"
```

---

### Task 5: Surface Open-Issue Count on Summary + Overview

**Files:**
- Modify: `server/projectStore.ts` (`listProjectSummaries` adds openIssueCount)
- Modify: `server/routes.test.ts` (extend a summary test)
- Modify: `src/utils/store.ts` (ProjectSummary type)
- Modify: `src/pages/project/ProjectOverview.tsx` (open-issues stat)

- [ ] **Step 1: Extend the summary test** (append to the existing `GET /api/projects/:id/summary` describe)

```ts
  it('includes openIssueCount (visible to all roles)', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'pi' });
    await request(app).post('/api/projects/pi/issues').send({ title: 'A' });
    const i2 = await request(app).post('/api/projects/pi/issues').send({ title: 'B' });
    await request(app).patch(`/api/issues/${i2.body.id}`).send({ status: 'resolved' });
    const res = await request(app).get('/api/projects/pi/summary');
    expect(res.body.openIssueCount).toBe(1); // one open, one resolved
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes.test.ts`
Expected: FAIL — summary lacks openIssueCount.

- [ ] **Step 3: Add to `listProjectSummaries` in `server/projectStore.ts`**

Add `import { countOpenIssues } from './issueStore';` at the top. In the `base` object (the one returned for ALL callers regardless of `includeBilling` — open-issue count is NOT pricing, so it's visible to everyone), add the field. Concretely, where the map builds `base`:

```ts
    const base = {
      id: r.id,
      // ...all existing non-billing fields unchanged...
      pageIds: pageIdsByProject.get(r.id) ?? [],
      openIssueCount: countOpenIssues(db, r.id),
    };
```

(`openIssueCount` lives on `base` so members get it too — only the billing fields stay admin-gated.)

- [ ] **Step 4: Add the field to the client `ProjectSummary` type** (`src/utils/store.ts`)

```ts
  openIssueCount: number;
```

(Required — every summary now carries it. Update the `mk()` mock in `src/pages/ProjectsPage.test.tsx` to add `openIssueCount: 0` if a TS error appears there.)

- [ ] **Step 5: Surface it in the Overview Details card** (`src/pages/project/ProjectOverview.tsx`)

Add `AlertCircle` to the lucide import. In the Details card's stats row (next to pages/takeoffs counts), add (visible to all — no admin gate):

```tsx
                  <span className="flex items-center gap-1.5"><AlertCircle size={14} className="text-ink-faint" />{summary.openIssueCount} open issue{summary.openIssueCount === 1 ? '' : 's'}</span>
```

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run server/routes.test.ts && npm run lint && npm test`
Expected: server summary test PASS; lint clean; all green.

```bash
git add server/projectStore.ts server/routes.test.ts src/utils/store.ts src/pages/project/ProjectOverview.tsx src/pages/ProjectsPage.test.tsx
git commit -m "feat: surface open-issue count on project summary and overview"
```

---

### Task 6: Client Store Helpers + Types

**Files:**
- Modify: `src/utils/store.ts` (append)

No unit tests (thin fetch wrappers, file pattern); lint + the page consumers verify.

- [ ] **Step 1: Append the issue types + helpers to `src/utils/store.ts`**

```ts
// ── Phase 4b: issues ─────────────────────────────────────────────────────────

export interface IssuePhoto { id: string; fileId: string; sortOrder: number; }
export interface Issue {
  id: string;
  projectId: string;
  number: number;
  title: string | null;
  description: string | null;
  status: string; // open | sent | resolved
  version: number;
  sentAt: number | null;
  createdAt: number;
  photos: IssuePhoto[];
}
export interface IssueListItem {
  id: string; projectId: string; number: number; title: string | null;
  description: string | null; status: string; version: number; sentAt: number | null;
  createdAt: number; photoCount: number;
}

const issueJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getIssues = async (projectId: string): Promise<IssueListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/issues`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getIssue = async (id: string): Promise<Issue> => {
  const res = await fetchWithRetry(`/api/issues/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createIssue = async (projectId: string, input: { title: string; description?: string }): Promise<{ id: string; number: number }> => {
  const res = await issueJson('POST', `/api/projects/${projectId}/issues`, input);
  await handleResponse(res); return res.json();
};
export const saveIssue = async (id: string, issue: Issue): Promise<{ version: number }> => {
  const res = await issueJson('PUT', `/api/issues/${id}`, issue);
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setIssueStatus = async (id: string, status: string): Promise<void> => {
  const res = await issueJson('PATCH', `/api/issues/${id}`, { status }); await handleResponse(res);
};
export const deleteIssue = async (id: string): Promise<void> => {
  const res = await issueJson('DELETE', `/api/issues/${id}`); await handleResponse(res);
};
export const addIssuePhoto = async (issueId: string, fileId: string): Promise<void> => {
  const res = await issueJson('POST', `/api/issues/${issueId}/photos`, { fileId }); await handleResponse(res);
};
export const removeIssuePhoto = async (issueId: string, fileId: string): Promise<void> => {
  const res = await issueJson('DELETE', `/api/issues/${issueId}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const sendIssue = async (id: string, payload: { to: string; fileId: string; message?: string }): Promise<void> => {
  const res = await issueJson('POST', `/api/issues/${id}/send`, payload); await handleResponse(res);
};
```

- [ ] **Step 2: Verify and commit**

Run: `npm run lint && npm test`
Expected: clean / green.

```bash
git add src/utils/store.ts
git commit -m "feat: client store — issue helpers and types"
```

---

### Task 7: Issue Status Pill

**Files:**
- Create: `src/components/ui/IssueStatusPill.tsx`
- Test: `src/components/ui/IssueStatusPill.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/ui/IssueStatusPill.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IssueStatusPill, ISSUE_STATUS_META } from './IssueStatusPill';

describe('IssueStatusPill', () => {
  it('maps every issue status', () => {
    for (const s of ['open', 'sent', 'resolved']) expect(ISSUE_STATUS_META[s], s).toBeDefined();
  });
  it('renders labels', () => {
    render(<IssueStatusPill status="resolved" />);
    expect(screen.getByText('Resolved')).toBeInTheDocument();
  });
  it('falls back to slate for unknown statuses (prototype-safe)', () => {
    render(<IssueStatusPill status="constructor" />);
    expect(screen.getByText('constructor').className).toContain('slate');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/ui/IssueStatusPill.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```tsx
// src/components/ui/IssueStatusPill.tsx
import React from 'react';
import { StatusPill, PillTone } from './StatusPill';

export const ISSUE_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  open:     { label: 'Open',     tone: 'amber' },
  sent:     { label: 'Sent',     tone: 'blue' },
  resolved: { label: 'Resolved', tone: 'emerald' },
};

export const IssueStatusPill: React.FC<{ status?: string | null; className?: string }> = ({ status, className }) => {
  const entry = status != null && Object.hasOwn(ISSUE_STATUS_META, status) ? ISSUE_STATUS_META[status] : null;
  const m = entry ?? { label: status || 'Unknown', tone: 'slate' as PillTone };
  return <StatusPill tone={m.tone} className={className}>{m.label}</StatusPill>;
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/ui/IssueStatusPill.test.tsx && npm run lint`
Expected: PASS (3 tests), clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/IssueStatusPill.tsx src/components/ui/IssueStatusPill.test.tsx
git commit -m "feat: issue status pill"
```

---

### Task 8: ProjectIssues Section + Issue Editor (Body, Status, Photos)

**Files:**
- Create: `src/pages/project/ProjectIssues.tsx`
- Create: `src/pages/project/issues/IssueEditor.tsx`
- Create: `src/pages/project/ProjectIssues.test.tsx` (pure-helper test)
- Modify: `src/App.tsx` (route)
- Modify: `src/components/shell/Sidebar.tsx` (nav — NOT adminOnly)
- Modify: `src/components/shell/Sidebar.test.tsx`

- [ ] **Step 1: Write the failing helper test** (the page exports a small pure `issueNo` formatter)

```tsx
// src/pages/project/ProjectIssues.test.tsx
import { describe, it, expect } from 'vitest';
import { issueNo } from './ProjectIssues';

describe('issueNo', () => {
  it('zero-pads to ISS-NNN', () => {
    expect(issueNo(1)).toBe('ISS-001');
    expect(issueNo(42)).toBe('ISS-042');
    expect(issueNo(123)).toBe('ISS-123');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/project/ProjectIssues.test.tsx`
Expected: FAIL — module/export missing.

- [ ] **Step 3: Implement `src/pages/project/issues/IssueEditor.tsx`** (body + status; photos + send wire in Tasks 9-10 — leave a `{/* photos: Task 9 */}` and `{/* send: Task 10 */}` placeholder region this task fills minimally so it compiles)

```tsx
// src/pages/project/issues/IssueEditor.tsx
import React, { useState } from 'react';
import { Issue, saveIssue, setIssueStatus } from '../../../utils/store';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, Textarea } from '../../../components/ui';
import { IssueStatusPill, ISSUE_STATUS_META } from '../../../components/ui/IssueStatusPill';

export const IssueEditor: React.FC<{
  issue: Issue;
  projectId: string;
  projectName: string;
  contractor?: string | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ issue, projectId, onClose, onSaved }) => {
  const { toast } = useToast();
  const [title, setTitle] = useState(issue.title ?? '');
  const [description, setDescription] = useState(issue.description ?? '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!title.trim()) { toast('A title is required', { type: 'warning' }); return; }
    setSaving(true);
    try {
      await saveIssue(issue.id, { ...issue, title: title.trim(), description: description || null });
      toast('Issue saved', { type: 'success' });
      onSaved();
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'Issue changed elsewhere — reopen it' : 'Save failed', { type: 'error' });
    } finally { setSaving(false); }
  };

  const cycleStatus = async () => {
    const next = issue.status === 'open' ? 'sent' : issue.status === 'sent' ? 'resolved' : 'open';
    try { await setIssueStatus(issue.id, next); onSaved(); } catch { toast('Status update failed', { type: 'error' }); }
  };

  return (
    <Modal open onClose={onClose} title={`ISS-${String(issue.number).padStart(3, '0')}`} width="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <div className="mb-3 flex items-center gap-2">
        <button onClick={cycleStatus} title="Click to advance status"><IssueStatusPill status={issue.status} /></button>
        <span className="text-xs text-ink-faint">{Object.keys(ISSUE_STATUS_META).join(' → ')}</span>
      </div>
      <Field label="Title" htmlFor="iss-title"><Input id="iss-title" value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <div className="mt-3">
        <Field label="Description" htmlFor="iss-desc"><Textarea id="iss-desc" value={description} onChange={e => setDescription(e.target.value)} rows={4} /></Field>
      </div>
      {/* photos: Task 9 (rendered below the description) */}
      {/* send: Task 10 (recipient + Send report) */}
    </Modal>
  );
};
```

- [ ] **Step 4: Implement `src/pages/project/ProjectIssues.tsx`**

```tsx
// src/pages/project/ProjectIssues.tsx
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, Plus, Trash2, ImageIcon } from 'lucide-react';
import {
  Issue, IssueListItem, getIssues, getIssue, createIssue, deleteIssue,
} from '../../utils/store';
import { useProjectOutlet } from './ProjectLayout';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import {
  Button, Card, CardBody, EmptyState, Field, Input, Skeleton, Table, TBody, TD, TH, THead, TR,
} from '../../components/ui';
import { IssueStatusPill } from '../../components/ui/IssueStatusPill';
import { IssueEditor } from './issues/IssueEditor';

export const issueNo = (n: number): string => `ISS-${String(n).padStart(3, '0')}`;

export const ProjectIssues: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { summary } = useProjectOutlet();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [issues, setIssues] = useState<IssueListItem[] | null>(null);
  const [editing, setEditing] = useState<Issue | null>(null);
  const [newTitle, setNewTitle] = useState('');

  const load = () => {
    if (!projectId) return;
    getIssues(projectId).then(setIssues).catch(() => setIssues([]));
  };
  useEffect(load, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openIssue = async (id: string) => {
    try { setEditing(await getIssue(id)); } catch { toast('Failed to open issue', { type: 'error' }); }
  };
  const addIssue = async () => {
    if (!projectId || !newTitle.trim()) { toast('Enter a title', { type: 'warning' }); return; }
    try {
      const r = await createIssue(projectId, { title: newTitle.trim() });
      setNewTitle('');
      setEditing(await getIssue(r.id));
      load();
    } catch { toast('Failed to create issue', { type: 'error' }); }
  };
  const removeIssue = async (id: string) => {
    if (!(await confirm({ title: 'Delete issue?', message: 'This permanently removes the issue.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try { await deleteIssue(id); load(); } catch { toast('Delete failed', { type: 'error' }); }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <h1 className="mb-4 text-xl font-bold text-ink">Issues</h1>

      <Card className="mb-5">
        <CardBody>
          <div className="flex items-end gap-2">
            <Field label="New issue" htmlFor="new-iss">
              <Input id="new-iss" value={newTitle} onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addIssue(); }}
                placeholder="Short description of the deficiency" className="w-80" />
            </Field>
            <Button onClick={addIssue}><Plus size={15} />Add issue</Button>
          </div>
        </CardBody>
      </Card>

      {issues === null ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}</div>
      ) : issues.length === 0 ? (
        <EmptyState icon={<AlertCircle size={22} />} title="No issues yet"
          description="Log deficiencies or observations here — add photos and send a report to the contractor." />
      ) : (
        <Table>
          <THead><TR><TH>#</TH><TH>Title</TH><TH>Status</TH><TH>Photos</TH><TH></TH></TR></THead>
          <TBody>
            {issues.map(iss => (
              <TR key={iss.id} interactive onClick={() => openIssue(iss.id)}>
                <TD className="font-mono text-xs text-ink-soft">{issueNo(iss.number)}</TD>
                <TD className="font-medium text-ink">{iss.title || '(untitled)'}</TD>
                <TD><IssueStatusPill status={iss.status} /></TD>
                <TD className="text-ink-soft">{iss.photoCount > 0 ? <span className="inline-flex items-center gap-1"><ImageIcon size={13} />{iss.photoCount}</span> : '—'}</TD>
                <TD onClick={e => e.stopPropagation()}>
                  <button onClick={() => removeIssue(iss.id)} title="Delete" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {editing && (
        <IssueEditor
          key={`${editing.id}:${editing.version}`}
          issue={editing}
          projectId={projectId ?? ''}
          projectName={summary?.name ?? ''}
          contractor={summary?.contractor}
          onClose={() => setEditing(null)}
          onSaved={async () => { try { setEditing(await getIssue(editing.id)); } catch { setEditing(null); } load(); }}
        />
      )}
    </div>
  );
};
```

- [ ] **Step 5: Run the helper test**

Run: `npx vitest run src/pages/project/ProjectIssues.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 6: Add the route + sidebar nav (NOT adminOnly)**

In `src/App.tsx`: import `ProjectIssues`; add `{ path: 'issues', element: <ProjectIssues /> }` under the project tree (after `time`, before `billing`).

In `src/components/shell/Sidebar.tsx`: add `AlertCircle` to the lucide import; add to PROJECT_NAV (after `time`, before the adminOnly `billing` entry — NO adminOnly flag):

```tsx
  { id: 'issues',  label: 'Issues',  Icon: AlertCircle, path: '/issues', match: (p, b) => p.startsWith(`${b}/issues`) },
```

- [ ] **Step 7: Update Sidebar tests** (`src/components/shell/Sidebar.test.tsx`)

In the project-mode "swaps to project nav" test, add `'Issues'` to the expected label list. Add one test:

```tsx
  it('shows Issues for non-admins (not admin-gated)', () => {
    localStorage.setItem('user', JSON.stringify({ username: 'm', role: 'user' }));
    renderProject('/project/p1');
    expect(screen.getByRole('button', { name: /Issues/ })).toBeInTheDocument();
  });
```

- [ ] **Step 8: Verify and commit**

Run: `npx vitest run src/pages/project src/components/shell && npm run lint && npm test`
Expected: all green. Boot check: Issues in the sidebar (for everyone); create an issue (gets ISS-001), edit title/description (saves, version-checked), cycle status; the Overview Details shows the open-issue count.

```bash
git add src/pages/project/ProjectIssues.tsx src/pages/project/issues/IssueEditor.tsx src/pages/project/ProjectIssues.test.tsx src/App.tsx src/components/shell/Sidebar.tsx src/components/shell/Sidebar.test.tsx
git commit -m "feat: project issues section — list, create, edit, status"
```

---

### Task 9: Photo Capture + Gallery in the Issue Editor

**Files:**
- Modify: `src/pages/project/issues/IssueEditor.tsx`

- [ ] **Step 1: Add photo upload + gallery to `IssueEditor.tsx`**

Add imports: `import { useRef } from 'react';` (merge into the existing react import), `import { Camera, Trash2 } from 'lucide-react';`, and from store: `addIssuePhoto, removeIssuePhoto, uploadProjectFile, getImageUrl`.

Add state + handlers inside the component:

```tsx
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handlePhotos = async (list: FileList | null) => {
    if (!list || !list.length) return;
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(list)) {
      try {
        const fileId = await uploadProjectFile(projectId, f, 'photo');
        await addIssuePhoto(issue.id, fileId);
        ok++;
      } catch { /* keep going */ }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    if (ok < list.length) toast(`Uploaded ${ok} of ${list.length} photos`, { type: ok ? 'warning' : 'error' });
    onSaved(); // reload the issue → photos appear
  };

  const dropPhoto = async (fileId: string) => {
    try { await removeIssuePhoto(issue.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };
```

Replace the `{/* photos: Task 9 ... */}` placeholder with the gallery + upload control:

```tsx
      <div className="mt-4 border-t border-edge pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Photos</h4>
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            <Camera size={14} />{uploading ? 'Uploading…' : 'Add photos'}
          </Button>
          {/* capture="environment" opens the rear camera on mobile (spec §4.3 field use) */}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple className="hidden"
            onChange={e => handlePhotos(e.target.files)} />
        </div>
        {issue.photos.length === 0 ? (
          <p className="text-xs text-ink-faint">No photos. Add before/during/after shots from the field.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {issue.photos.map(p => (
              <div key={p.id} className="group relative">
                <img src={getImageUrl(p.fileId)} alt="" className="h-24 w-full rounded-lg border border-edge object-cover" />
                <button onClick={() => dropPhoto(p.fileId)} title="Remove"
                  className="absolute right-1 top-1 rounded-md bg-black/50 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
```

(`Trash2` may already be imported via the ui usage — ensure a single import. `getImageUrl` is a public-path helper, no auth needed in `<img src>`.)

- [ ] **Step 2: Verify and commit**

Run: `npm run lint && npm test`
Expected: clean / green (no automated test for the photo UI — jsdom can't do file capture; verified manually).

Boot check: open an issue → Add photos (desktop file picker; on a phone the camera opens) → thumbnails appear → reload persists → remove a photo. The photo count shows on the issues list + Overview.

```bash
git add src/pages/project/issues/IssueEditor.tsx
git commit -m "feat: issue photo capture and gallery (mobile camera)"
```

---

### Task 10: Issue Report PDF + Send via SMTP

**Files:**
- Create: `src/pages/project/issues/issuePdf.ts`
- Test: `src/pages/project/issues/issuePdf.test.ts`
- Modify: `src/pages/project/issues/IssueEditor.tsx` (Send report)
- Modify: `server.ts` (`POST /api/issues/:id/send`)

The issue report PDF reuses the Phase 4a visual language (logo + company block, accent title) for consistency. It's a simpler internal/contractor deficiency report — number, title, description, project/contractor, embedded photos.

- [ ] **Step 1: Write the failing data-shaping test**

```ts
// src/pages/project/issues/issuePdf.test.ts
import { describe, it, expect } from 'vitest';
import { issueHeading } from './issuePdf';

describe('issue pdf data shaping', () => {
  it('issueHeading formats the issue number + title', () => {
    expect(issueHeading({ number: 7, title: 'Cracked drywall' } as any)).toBe('ISS-007 · Cracked drywall');
    expect(issueHeading({ number: 1, title: null } as any)).toBe('ISS-001 · (untitled)');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/project/issues/issuePdf.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/pages/project/issues/issuePdf.ts`** (reuses resolveAccentRgb from the invoice PDF)

```ts
// src/pages/project/issues/issuePdf.ts
import { jsPDF } from 'jspdf';
import { Issue } from '../../../utils/store';
import { resolveAccentRgb } from '../billing/invoicePdf';

export const issueHeading = (issue: Pick<Issue, 'number' | 'title'>): string =>
  `ISS-${String(issue.number).padStart(3, '0')} · ${issue.title || '(untitled)'}`;

export interface IssuePdfContext {
  issue: Issue;
  projectName: string;
  contractor?: string | null;
  company: { name: string; address?: string; phone?: string; email?: string; logoDataUrl?: string };
  photoDataUrls: string[]; // pre-fetched (caller resolves each fileId → dataURL)
  accentRgb?: [number, number, number];
}

// Builds the issue report PDF and returns the bytes. Reuses the Layout-A header
// treatment (logo + company left, accent title right) for visual consistency
// with invoices; body is the issue number/title/description; photos grid follows.
export function buildIssuePdf(ctx: IssuePdfContext): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const Hp = doc.internal.pageSize.getHeight();
  const M = 48;
  const [ar, ag, ab] = ctx.accentRgb ?? [37, 99, 235];
  let y = M;

  // Header: logo + company (left), ISSUE REPORT title (right)
  let leftY = y;
  if (ctx.company.logoDataUrl) {
    try { doc.addImage(ctx.company.logoDataUrl, 'PNG', M, leftY, 110, 44); leftY += 52; } catch { /* skip */ }
  }
  doc.setFont('helvetica', 'bold').setFontSize(13).setTextColor(20, 20, 20);
  doc.text(ctx.company.name || 'Issue Report', M, leftY + 4); leftY += 16;
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(90, 90, 90);
  for (const line of [ctx.company.address, [ctx.company.phone, ctx.company.email].filter(Boolean).join('  ·  ')].filter(Boolean)) {
    doc.text(String(line), M, leftY); leftY += 12;
  }
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(ar, ag, ab);
  doc.text('ISSUE REPORT', W - M, y + 16, { align: 'right' });
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(60, 60, 60);
  doc.text(new Date(ctx.issue.createdAt).toLocaleDateString(), W - M, y + 34, { align: 'right' });
  y = Math.max(leftY, y + 50) + 16;

  // Project / contractor
  doc.setFontSize(10).setTextColor(30, 30, 30);
  for (const line of [`Project: ${ctx.projectName}`, ctx.contractor ? `Contractor: ${ctx.contractor}` : null].filter(Boolean)) {
    doc.text(String(line), M, y); y += 14;
  }
  y += 8;

  // Issue heading + status
  doc.setFont('helvetica', 'bold').setFontSize(14).setTextColor(ar, ag, ab);
  doc.text(issueHeading(ctx.issue), M, y); y += 8;
  doc.setDrawColor(ar, ag, ab).setLineWidth(1).line(M, y, W - M, y); y += 18;
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(120, 120, 120);
  doc.text(`Status: ${ctx.issue.status}`, M, y); y += 18;

  // Description
  if (ctx.issue.description) {
    doc.setFontSize(11).setTextColor(30, 30, 30);
    const lines = doc.splitTextToSize(ctx.issue.description, W - 2 * M);
    doc.text(lines, M, y); y += lines.length * 14 + 12;
  }

  // Photos grid (2 per row)
  if (ctx.photoDataUrls.length) {
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(60, 60, 60);
    doc.text('Photos', M, y); y += 14;
    const cellW = (W - 2 * M - 12) / 2, cellH = 150;
    let col = 0;
    for (const url of ctx.photoDataUrls) {
      if (y + cellH > Hp - M) { doc.addPage(); y = M; col = 0; }
      const x = M + col * (cellW + 12);
      try { doc.addImage(url, 'JPEG', x, y, cellW, cellH, undefined, 'FAST'); } catch { /* skip bad image */ }
      col++;
      if (col === 2) { col = 0; y += cellH + 12; }
    }
  }

  return doc.output('arraybuffer') as unknown as Uint8Array;
}
```

- [ ] **Step 4: Run to verify the data-shaping test passes**

Run: `npx vitest run src/pages/project/issues/issuePdf.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Add `POST /api/issues/:id/send` to `server.ts`**

Reuse `sendProjectEmail` (4a). Import `getIssue, markIssueSent` from `./server/issueStore`. Register it where send-proposal / invoice-send live (authenticateToken — NOT admin):

```ts
  app.post('/api/issues/:id/send', authenticateToken, async (req, res) => {
    try {
      const iss = getIssue(db, req.params.id);
      if (!iss) return res.status(404).json({ error: 'Issue not found' });
      const { to, fileId, message } = req.body as { to: string; fileId: string; message?: string };
      if (!to || !fileId) return res.status(400).json({ error: 'to and fileId are required' });
      await sendProjectEmail({
        to,
        subject: `Issue ISS-${String(iss.number).padStart(3, '0')}${iss.title ? ` — ${iss.title}` : ''}`,
        text: message || 'Please find the attached issue report.',
        fileId,
        attachmentName: `ISS-${String(iss.number).padStart(3, '0')}.pdf`,
      });
      try { markIssueSent(db, req.params.id); } catch { /* best effort */ }
      logActivity(db, { projectId: iss.projectId, userId: (req as any).user?.id, type: 'issue_sent', message: `Issue ISS-${String(iss.number).padStart(3, '0')} emailed to ${to}` });
      res.json({ success: true });
    } catch (e: any) {
      console.error('Error sending issue:', e);
      res.status(500).json({ error: e.message || 'Failed to send issue' });
    }
  });
```

- [ ] **Step 6: Wire the Send button in `IssueEditor.tsx`**

Add imports: `import { buildIssuePdf } from './issuePdf';`, `import { resolveAccentRgb } from '../billing/invoicePdf';`, and from store: `getSettings, uploadProjectFile, fetchFileBlob, sendIssue`. Add `sendTo`/`sending` state and a `handleSend`:

```tsx
  const buildIssueBytes = async (): Promise<Uint8Array> => {
    const settings = await getSettings();
    let logoDataUrl: string | undefined = settings.logoUrl || undefined;
    if (logoDataUrl && !logoDataUrl.startsWith('data:')) {
      const blob = await (await fetch(logoDataUrl)).blob();
      logoDataUrl = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); });
    }
    // fetch each photo as a dataURL (authenticated content endpoint)
    const photoDataUrls: string[] = [];
    for (const p of issue.photos) {
      try {
        const blob = await fetchFileBlob(p.fileId);
        photoDataUrls.push(await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); }));
      } catch { /* skip */ }
    }
    return buildIssuePdf({
      issue,
      projectName: props.projectName,
      contractor: props.contractor,
      company: { name: settings.appName || 'Issue Report', address: settings.companyAddress, phone: settings.companyPhone, email: settings.companyEmail, logoDataUrl },
      photoDataUrls,
      accentRgb: resolveAccentRgb(),
    });
  };

  const handleDownload = async () => {
    try {
      const bytes = await buildIssueBytes();
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a'); a.href = url; a.download = `ISS-${String(issue.number).padStart(3, '0')}.pdf`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { toast('Failed to generate report', { type: 'error' }); }
  };

  const [sendTo, setSendTo] = useState('');
  const [sending, setSending] = useState(false);
  const handleSend = async () => {
    if (!sendTo.trim() || !/\S+@\S+\.\S+/.test(sendTo.trim())) { toast('Enter a valid email address', { type: 'warning' }); return; }
    setSending(true);
    try {
      const bytes = await buildIssueBytes();
      const file = new File([bytes], `ISS-${String(issue.number).padStart(3, '0')}.pdf`, { type: 'application/pdf' });
      // Uploaded as a project document before sending; a failed send leaves it in
      // Documents (project-attributed), and a retry uploads another — fine for v1.
      const fileId = await uploadProjectFile(projectId, file, 'issue');
      await sendIssue(issue.id, { to: sendTo.trim(), fileId });
      toast('Issue report sent', { type: 'success' });
      onSaved();
    } catch { toast('Failed to send report', { type: 'error' }); }
    finally { setSending(false); }
  };
```

Note: the component currently destructures `{ issue, projectId, onClose, onSaved }` — switch to taking `props` (or add `projectName`/`contractor` to the destructure) so `props.projectName`/`props.contractor` resolve. The component already receives `projectName`/`contractor` props from ProjectIssues (Task 8). Add the Download + Send UI in the footer / a send row, replacing the `{/* send: Task 10 */}` placeholder:

```tsx
      <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-edge pt-3">
        <Field label="Send report to" htmlFor="iss-to"><Input id="iss-to" type="email" value={sendTo} onChange={e => setSendTo(e.target.value)} placeholder="contractor@example.com" className="w-64" /></Field>
        <Button variant="secondary" onClick={handleSend} disabled={sending}>{sending ? 'Sending…' : 'Send report'}</Button>
        <Button variant="ghost" onClick={handleDownload}>Download PDF</Button>
      </div>
```

(Ensure `Field`/`Input` are imported — they already are. The component signature change from destructure to `props.` access: keep `issue`/`projectId`/`onClose`/`onSaved` destructured and ALSO destructure `projectName`/`contractor`, OR reference them as `props.projectName`. Pick one consistently.)

- [ ] **Step 7: Verify and commit**

Run: `npm run lint && npm test`
Expected: clean / green.

Manual (SMTP configured): open an issue with photos → Download PDF (report renders: header, project/contractor, issue heading, description, photo grid) → enter a recipient → Send report → email arrives with the PDF; issue flips to "sent" with sentAt; activity logs `issue_sent`; the report PDF appears under Documents (kind `issue`).

```bash
git add src/pages/project/issues/issuePdf.ts src/pages/project/issues/issuePdf.test.ts src/pages/project/issues/IssueEditor.tsx server.ts
git commit -m "feat: issue report PDF and SMTP send"
```

---

### Task 11: Full Verification + Push

**Files:** none (verification only)

- [ ] **Step 1: Full automated pass**

Run: `npm run lint && npm test && npm run build`
Expected: zero type errors, all suites green, build succeeds.

- [ ] **Step 2: Live API smoke** (boot a temp dir, login admin/admin)

- [ ] Migrations 1-9 apply; second boot applies nothing
- [ ] Create issue → number 1; second → number 2; separate project → number 1 (per-project sequence)
- [ ] PUT body version-checked (409 on stale); PATCH status; photo link/unlink; DELETE
- [ ] `/api/projects/:id/summary` → openIssueCount reflects open issues; resolving one decrements it
- [ ] Issues routes work for a NON-admin token (create + get + patch) — issues are NOT admin-gated (contrast billing 403)

- [ ] **Step 3: Browser smoke**

- [ ] Issues section in the sidebar for everyone (admin + member); create issue (ISS-001), edit body, cycle status
- [ ] Add photos (desktop picker; phone camera) → gallery → remove; photo count on list + Overview
- [ ] Download PDF report (header/project/issue/description/photos) — eyeball the layout; tell Nathan it's ready to tweak if he wants changes
- [ ] Send report (SMTP) → email + status sent + Documents shows the report
- [ ] Overview Details shows the open-issue count; resolving an issue decrements it

- [ ] **Step 4: Tell Nathan, then push**

Migration 9 is **additive** (two new empty issue tables — no data risk). Say so when pushing. Mention the issue-report PDF is ready for him to eyeball and request tweaks (he asked to be involved in document templates — the invoice got a full checkpoint; the issue report reused that visual language, so it's a lighter "review and adjust" rather than a pre-build pick). Then:

```bash
git push origin testing
```

---

## Plan Self-Review Notes (already applied)

1. **Spec coverage (§2 issue reports, §3.2 issues table, §4.2 Issues section, §4.3 mobile/field, §6 email):** numbered reports ISS-001… per project ✅ (Task 2 numbering) · deficiencies/observations with title+description ✅ · photos ✅ (Tasks 3, 9 — files rows via issue_photos, mobile `capture="environment"`) · open→sent→resolved ✅ (status + markSent) · "send emails a PDF to the contractor and logs it" ✅ (Task 10 — sendProjectEmail + issue_sent activity + sentAt) · open-issue count on Overview ✅ (Task 5) · field-usable / not admin-only ✅ (auth-only routes; Issues nav has no adminOnly).
2. **Deliberate choices:** issues are NOT admin-gated (field members file them — contrast billing) · photos reuse the existing file store (no new blob handling) · the issue PDF reuses the 4a accent/logo helpers (visual consistency; lighter design touch than the invoice since Nathan only requested an invoice checkpoint — offered as review-and-adjust) · version-checked body saves but simple status/photo ops (low contention) · unlinking a photo doesn't delete the file (orphan cleanup handles it; project-attributed so 3b's guard spares it while the project lives).
3. **Type consistency:** `ISSUE_STATUSES`=['open','sent','resolved'] matches between issueStore (server) and IssueStatusPill META (client) · `Issue`/`IssueListItem`/`IssuePhoto` client types mirror server shapes (number, version, sentAt, photos/photoCount) · `issueNo`/`issueHeading` formatters consistent (ISS-NNN zero-pad) · `openIssueCount` on ProjectSummary is ungated (on `base`, unlike admin-only billing fields) · `sendIssue` client matches the route ({to, fileId, message?}).
4. **Ordering & integration:** migration 9 + deleteProject cascade land together (Task 1); cascade HTTP test green after Task 4 · issueStore (2-3) before routes (4) before client (6-10) · the IssueEditor is built incrementally (Task 8 body/status → Task 9 photos → Task 10 PDF/send) with placeholder regions so each task compiles · openIssueCount on `base` (Task 5) so it survives the 4a admin-gating split · issue send reuses sendProjectEmail (4a) — no new SMTP code.
5. **Security/correctness:** issues are intentionally not admin-gated (spec §4.3 field use); the only gated thing remains billing. No money in issues (simpler validation). Photo `<img src>` uses the public `/api/images/:id/raw` (deliberately public since Phase 1 for image rendering). Send reuses the audited email path.
