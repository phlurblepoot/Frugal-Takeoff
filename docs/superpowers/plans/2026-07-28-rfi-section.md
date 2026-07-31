# RFI Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new project "RFIs" section — numbered Requests For Information with photos, a branded PDF, email send, and response tracking (uploaded PDF and/or text) — cloned from the Issues vertical slice.

**Architecture:** Independent vertical slice mirroring Issues (the established convention — Punch and Tasks were built the same way): `server/rfiStore.ts` + a `// ── RFI` block in `server/routes.ts` + `src/pages/project/ProjectRfis.tsx` / `rfi/RfiEditor.tsx` / `rfi/rfiPdf.ts`. Reuses shared leaf utilities only: `documentLetterhead`, `EmailComposer`, `recipients`, shared files storage, UI kit. Migration 19 is ADDITIVE.

**Tech Stack:** Express + better-sqlite3 (server), React + react-router + jsPDF (client), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-28-rfi-section-design.md`

## Global Constraints

- All work on branch `testing`; push to `testing` (per CLAUDE.md). Never create PRs unless asked.
- Migration 19 must be ADDITIVE only (new tables `rfis`, `rfi_photos`; no changes to existing tables).
- Numbering: per-project, `RFI-` + zero-padded 3 (`RFI-001`). PDF filename `RFI-003.pdf`.
- Statuses: exactly `['open','sent','answered','closed']`. Email send → `sent`+`sentAt`; setting a response (fileId or text) → `answered`+`answeredAt` unless status is already `closed`; `closed` is manual. Overdue is a UI display rule only (past `responseNeededBy` && status not answered/closed), never a status.
- All RFI routes use `authenticateToken` only (NOT `requireAdmin`) — field-created, like Issues.
- Test command: `npx vitest run <file>` for a single file; `npm test` for the full suite; `npm run lint` = `tsc --noEmit`.
- Commit after every task with a conventional-commit message ending in the Claude Code trailer.
- Existing suite has 630 passing tests — never break them.

---

### Task 1: Migration 19 + project-delete cascade

**Files:**
- Modify: `server/migrationList.ts` (append after migration 18, which ends at line 883 with `];` at line 884)
- Modify: `server/projectStore.ts` (~line 315 — add rfi cascade next to the issues cascade)
- Test: `server/migrations.test.ts` (only if it asserts a max-version — check; the migration list is otherwise exercised by every store test via the shared test-db helper)

**Interfaces:**
- Produces: tables `rfis` and `rfi_photos` (exact schema below) available to every later task's test DB.

- [ ] **Step 1: Look at how the existing test DB helper builds its schema**

Run: `grep -rn "migrationList\|runMigrations" server/issueStore.test.ts server/testDb.ts 2>/dev/null | head` and open whatever helper `issueStore.test.ts` imports at its top. Confirm new migrations are picked up automatically (they run in-order from the list). No code change needed here — just confirm.

- [ ] **Step 2: Append migration 19 to `server/migrationList.ts`**

Insert before the final `];` (currently line 884):

```ts
  {
    version: 19,
    name: 'rfis',
    // ADDITIVE. RFIs — numbered Requests For Information, like issues but with
    // header fields (spec/drawing ref, attention), a response-needed-by date,
    // and a tracked response (uploaded PDF and/or text). Photos mirror
    // issue_photos. No FKs (project convention); cascades are manual.
    up({ db }) {
      db.exec(`
        CREATE TABLE rfis (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number INTEGER NOT NULL,
          title TEXT,
          question TEXT,
          specRef TEXT,
          drawingRef TEXT,
          attention TEXT,
          responseNeededBy TEXT,
          responseText TEXT,
          responseFileId TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          version INTEGER NOT NULL DEFAULT 1,
          sentAt INTEGER,
          answeredAt INTEGER,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_rfis_projectId ON rfis (projectId);
        CREATE TABLE rfi_photos (
          id TEXT PRIMARY KEY,
          rfiId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_rfi_photos_rfiId ON rfi_photos (rfiId);
      `);
    },
  },
```

- [ ] **Step 3: Add the delete cascade in `server/projectStore.ts`**

Directly after the issues cascade block (the two lines deleting `issue_photos` then `issues`, ~line 316), add:

```ts
    // RFI rows — photos link to rfis, delete photos first.
    db.prepare('DELETE FROM rfi_photos WHERE rfiId IN (SELECT id FROM rfis WHERE projectId = ?)').run(id);
    db.prepare('DELETE FROM rfis WHERE projectId = ?').run(id);
```

- [ ] **Step 4: Run the server test suite to prove nothing broke**

Run: `npx vitest run server/`
Expected: all existing server tests PASS (migration 19 runs in every fresh test DB).

- [ ] **Step 5: Commit**

```bash
git add server/migrationList.ts server/projectStore.ts
git commit -m "feat(rfi): migration 19 — rfis + rfi_photos tables, project delete cascade

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `server/rfiStore.ts` (TDD)

**Files:**
- Create: `server/rfiStore.ts`
- Create: `server/rfiStore.test.ts`

**Interfaces:**
- Consumes: tables from Task 1.
- Produces (all take `db: Database.Database` first):
  - `RFI_STATUSES = ['open','sent','answered','closed'] as const`
  - `getRfi(db, id): any | null` — row + `photos: {id,fileId,sortOrder}[]`
  - `listRfis(db, projectId): any[]` — newest-first, each with `photoCount`
  - `createRfi(db, projectId, input): { id, number }` — input `{ title, question?, specRef?, drawingRef?, attention?, responseNeededBy?, status? }`
  - `saveRfi(db, id, input & { version }): { version }` — updates title/question/specRef/drawingRef/attention/responseNeededBy, version-checked
  - `setRfiStatus(db, id, status): { status }`
  - `deleteRfi(db, id): void` — cascades photos
  - `addPhoto(db, rfiId, fileId): void` (idempotent) / `removePhoto(db, rfiId, fileId): void`
  - `markRfiSent(db, id): void` — status `sent` + `sentAt`
  - `setRfiResponse(db, id, { fileId?, text? }): { status }` — requires at least one; sets `responseFileId`/`responseText` (only the provided ones); if current status ≠ `closed`, sets status `answered` + `answeredAt`
  - `ValidationError`, `ConflictError`, `NotFoundError` classes (own copies, project convention)

- [ ] **Step 1: Write the failing test file**

Open `server/issueStore.test.ts` first and copy its test-DB setup verbatim (same imports/helpers — likely a `makeDb`/`createTestDb` helper plus creating a project row). Then write `server/rfiStore.test.ts` with these cases (adapt assertion style to match the issue test file):

```ts
// server/rfiStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
// ⬇ copy the exact db-setup imports used by server/issueStore.test.ts
import {
  RFI_STATUSES, getRfi, listRfis, createRfi, saveRfi, setRfiStatus,
  deleteRfi, addPhoto, removePhoto, markRfiSent, setRfiResponse,
  ValidationError, ConflictError, NotFoundError,
} from './rfiStore';

describe('rfiStore', () => {
  // beforeEach: fresh db + a project (id 'p1') — same pattern as issueStore.test.ts

  it('numbers RFIs sequentially per project', () => {
    // create 2 RFIs in p1 → numbers 1,2; create 1 in p2 → number 1
  });

  it('requires a title on create', () => {
    // createRfi(db,'p1',{}) throws ValidationError
  });

  it('rejects create for unknown project', () => {
    // createRfi(db,'nope',{title:'x'}) throws NotFoundError
  });

  it('stores header fields on create and save', () => {
    // create with specRef/drawingRef/attention/responseNeededBy/question
    // getRfi returns them; saveRfi (with version) updates them; version bumps
  });

  it('save is version-checked', () => {
    // saveRfi with stale version throws ConflictError
    // saveRfi without version throws ValidationError
    // saveRfi on unknown id throws NotFoundError
  });

  it('validates status', () => {
    // setRfiStatus(db,id,'bogus') throws ValidationError
    // every value in RFI_STATUSES is accepted
  });

  it('lists newest-first with photoCount', () => {
    // 2 rfis, add 2 photos to the first; listRfis order + photoCount
  });

  it('delete cascades photo links', () => {
    // addPhoto then deleteRfi → rfi gone AND its rfi_photos rows gone
  });

  it('addPhoto is idempotent and validates', () => {
    // duplicate fileId → single row; unknown rfi → NotFoundError; empty fileId → ValidationError
  });

  it('markRfiSent sets status sent + sentAt', () => {});

  describe('setRfiResponse', () => {
    it('requires fileId or text', () => {
      // setRfiResponse(db,id,{}) throws ValidationError
    });
    it('file response → answered + answeredAt + responseFileId', () => {});
    it('text response → answered + responseText', () => {});
    it('both can be set across calls without clobbering the other', () => {
      // set file, then set text: responseFileId still present
    });
    it('does not demote a closed RFI', () => {
      // status closed → setRfiResponse keeps status closed, still stores response
    });
    it('unknown rfi → NotFoundError', () => {});
  });
});
```

Fill in every body with real assertions (no empty `it`s left).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/rfiStore.test.ts`
Expected: FAIL — cannot resolve `./rfiStore`.

- [ ] **Step 3: Implement `server/rfiStore.ts`**

Clone `server/issueStore.ts` structure exactly (same style, own error classes):

```ts
// server/rfiStore.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export const RFI_STATUSES = ['open', 'sent', 'answered', 'closed'] as const;

function requireProject(db: Database.Database, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('Project not found');
}

interface RfiInput {
  title?: string; question?: string; specRef?: string; drawingRef?: string;
  attention?: string; responseNeededBy?: string; status?: string;
}

function photoCount(db: Database.Database, rfiId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM rfi_photos WHERE rfiId = ?').get(rfiId) as any).c;
}

export function getRfi(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM rfis WHERE id = ?').get(id) as any;
  if (!row) return null;
  const photos = db.prepare('SELECT id, fileId, sortOrder FROM rfi_photos WHERE rfiId = ? ORDER BY sortOrder, createdAt').all(id);
  return { ...row, photos };
}

export function listRfis(db: Database.Database, projectId: string): any[] {
  const rows = db.prepare('SELECT * FROM rfis WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC').all(projectId) as any[];
  return rows.map(r => ({ ...r, photoCount: photoCount(db, r.id) }));
}

export function createRfi(db: Database.Database, projectId: string, input: RfiInput): { id: string; number: number } {
  requireProject(db, projectId);
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('RFI title is required');
  if (input.status !== undefined && !(RFI_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError(`Invalid RFI status: ${input.status}`);
  }
  const id = crypto.randomUUID();
  let number = 0;
  const tx = db.transaction(() => {
    const max = (db.prepare('SELECT COALESCE(MAX(number), 0) m FROM rfis WHERE projectId = ?').get(projectId) as any).m;
    number = max + 1;
    db.prepare(`INSERT INTO rfis (id, projectId, number, title, question, specRef, drawingRef, attention, responseNeededBy,
                responseText, responseFileId, status, version, sentAt, answeredAt, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1, NULL, NULL, ?)`)
      .run(id, projectId, number, input.title!.trim(), input.question ?? null, input.specRef ?? null,
           input.drawingRef ?? null, input.attention ?? null, input.responseNeededBy ?? null,
           input.status ?? 'open', Date.now());
  });
  tx();
  return { id, number };
}

export function saveRfi(db: Database.Database, id: string, input: RfiInput & { version?: number }): { version: number } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('RFI title is required');
  if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new ValidationError('Missing or invalid version — reload the RFI');
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM rfis WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('RFI not found');
    if (row.version !== input.version) throw new ConflictError(`RFI changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;
    db.prepare('UPDATE rfis SET title = ?, question = ?, specRef = ?, drawingRef = ?, attention = ?, responseNeededBy = ?, version = ? WHERE id = ?')
      .run(input.title!.trim(), input.question ?? null, input.specRef ?? null, input.drawingRef ?? null,
           input.attention ?? null, input.responseNeededBy ?? null, newVersion, id);
  });
  tx();
  return { version: newVersion };
}

export function setRfiStatus(db: Database.Database, id: string, status: string): { status: string } {
  if (!(RFI_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Invalid RFI status: ${status}`);
  const row = db.prepare('SELECT id FROM rfis WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('RFI not found');
  db.prepare('UPDATE rfis SET status = ?, version = version + 1 WHERE id = ?').run(status, id);
  return { status };
}

export function deleteRfi(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM rfi_photos WHERE rfiId = ?').run(id);
    db.prepare('DELETE FROM rfis WHERE id = ?').run(id);
  });
  tx();
}

export function addPhoto(db: Database.Database, rfiId: string, fileId: string): void {
  if (!db.prepare('SELECT id FROM rfis WHERE id = ?').get(rfiId)) throw new NotFoundError('RFI not found');
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  const exists = db.prepare('SELECT id FROM rfi_photos WHERE rfiId = ? AND fileId = ?').get(rfiId, fileId);
  if (exists) return; // idempotent
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM rfi_photos WHERE rfiId = ?').get(rfiId) as any).m;
  db.prepare('INSERT INTO rfi_photos (id, rfiId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), rfiId, fileId, max + 1, Date.now());
}

export function removePhoto(db: Database.Database, rfiId: string, fileId: string): void {
  db.prepare('DELETE FROM rfi_photos WHERE rfiId = ? AND fileId = ?').run(rfiId, fileId);
}

export function markRfiSent(db: Database.Database, id: string): void {
  db.prepare("UPDATE rfis SET status = 'sent', sentAt = ?, version = version + 1 WHERE id = ?").run(Date.now(), id);
}

// Records the answer. Usually the response arrives as a PDF (fileId of an
// uploaded shared file, kind 'rfi-response'); text covers phone/verbal answers.
// Only the provided fields are written, so a file and text can coexist.
// Auto-advances to 'answered' unless the RFI was already closed.
export function setRfiResponse(db: Database.Database, id: string, input: { fileId?: string; text?: string }): { status: string } {
  const row = db.prepare('SELECT status FROM rfis WHERE id = ?').get(id) as { status: string } | undefined;
  if (!row) throw new NotFoundError('RFI not found');
  const hasFile = typeof input.fileId === 'string' && input.fileId.trim() !== '';
  const hasText = typeof input.text === 'string' && input.text.trim() !== '';
  if (!hasFile && !hasText) throw new ValidationError('A response file or response text is required');
  const nextStatus = row.status === 'closed' ? 'closed' : 'answered';
  const tx = db.transaction(() => {
    if (hasFile) db.prepare('UPDATE rfis SET responseFileId = ? WHERE id = ?').run(input.fileId!.trim(), id);
    if (hasText) db.prepare('UPDATE rfis SET responseText = ? WHERE id = ?').run(input.text!.trim(), id);
    db.prepare('UPDATE rfis SET status = ?, answeredAt = COALESCE(answeredAt, ?), version = version + 1 WHERE id = ?')
      .run(nextStatus, Date.now(), id);
  });
  tx();
  return { status: nextStatus };
}
```

- [ ] **Step 4: Run tests until green**

Run: `npx vitest run server/rfiStore.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/rfiStore.ts server/rfiStore.test.ts
git commit -m "feat(rfi): rfiStore — numbered RFIs, versioned saves, response tracking

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: RFI CRUD/photos/response routes (TDD)

**Files:**
- Modify: `server/routes.ts` (import block ~line 21-25 area; new route block after the issues block which ends at line 434)
- Modify: `server/routes.test.ts` (new `describe('rfi routes')` — model on `describe('issue routes')` at ~line 784)

**Interfaces:**
- Consumes: Task 2's store functions.
- Produces HTTP API (all `authenticateToken` only):
  - `GET /api/projects/:id/rfis` → list
  - `POST /api/projects/:id/rfis` → `{id, number}`; logs activity `rfi_created`
  - `GET /api/rfis/:id` → full rfi (404 when missing)
  - `PUT /api/rfis/:id` → `{success, version}` (409 on conflict, code `version_conflict`)
  - `PATCH /api/rfis/:id` body `{status}` → `{success, status}`; logs `rfi_closed` when set to closed
  - `DELETE /api/rfis/:id` → `{success}`
  - `POST /api/rfis/:id/photos` body `{fileId}` / `DELETE /api/rfis/:id/photos/:fileId`
  - `POST /api/rfis/:id/response` body `{fileId?, text?}` → `{success, status}` (400 when neither); logs `rfi_answered`

- [ ] **Step 1: Write failing route tests**

In `server/routes.test.ts`, find `describe('issue routes')` (~line 784) and clone it as `describe('rfi routes', ...)` using the same app/db/auth setup helpers that file already uses. Cover:

- create → number 1, then 2 (per project); 400 with no title; 404 unknown project
- create stores `specRef`/`drawingRef`/`attention`/`responseNeededBy` (GET returns them)
- GET unknown id → 404
- PUT round-trip bumps version; stale version → 409 with `code: 'version_conflict'`
- PATCH status → `answered` ok; `bogus` → 400; PATCH to `closed` succeeds
- DELETE removes; photos: POST without fileId → 400, POST+DELETE round-trip, photoCount in list
- `POST /api/rfis/:id/response`:
  - `{}` → 400
  - `{text: 'Per detail 5/A-501'}` → 200, GET shows status `answered`, `answeredAt` set, `responseText` stored
  - `{fileId: 'file-1'}` → 200, `responseFileId` stored
  - on a `closed` RFI → 200 but status stays `closed`
  - unknown id → 404
- project DELETE cascades rfis + rfi_photos (mirror the issues cascade test at ~line 771)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes.test.ts -t 'rfi routes'`
Expected: FAIL (404s — routes don't exist).

- [ ] **Step 3: Implement the routes**

In `server/routes.ts` add the import block after the issueStore import (line 25):

```ts
import {
  listRfis, getRfi, createRfi, saveRfi, setRfiStatus, deleteRfi,
  addPhoto as addRfiPhoto, removePhoto as removeRfiPhoto, markRfiSent, setRfiResponse,
  ValidationError as RfiValidationError, ConflictError as RfiConflictError, NotFoundError as RfiNotFoundError,
} from './rfiStore';
```

After the issues route block (line 434, before the Punch comment) add:

```ts
  // ── RFIs (any authenticated user — field-created, like issues) ─────────────
  const rfiErr = (e: unknown, res: express.Response) => {
    if (e instanceof RfiNotFoundError) return res.status(404).json({ error: e.message });
    if (e instanceof RfiConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
    if (e instanceof RfiValidationError) return res.status(400).json({ error: e.message });
    console.error('RFI error:', e);
    return res.status(500).json({ error: 'RFI operation failed' });
  };
  const rfiNo = (n: number) => `RFI-${String(n).padStart(3, '0')}`;

  app.get('/api/projects/:id/rfis', authenticateToken, (req, res) => {
    try { res.json(listRfis(db, req.params.id)); } catch (e) { rfiErr(e, res); }
  });
  app.post('/api/projects/:id/rfis', authenticateToken, (req, res) => {
    try {
      const r = createRfi(db, req.params.id, req.body);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'rfi_created', message: `RFI ${rfiNo(r.number)} opened: ${req.body?.title ?? ''}` });
      res.json(r);
    } catch (e) { rfiErr(e, res); }
  });
  app.get('/api/rfis/:id', authenticateToken, (req, res) => {
    try { const rfi = getRfi(db, req.params.id); if (!rfi) return res.status(404).json({ error: 'RFI not found' }); res.json(rfi); } catch (e) { rfiErr(e, res); }
  });
  app.put('/api/rfis/:id', authenticateToken, (req, res) => {
    try { res.json({ success: true, ...saveRfi(db, req.params.id, req.body) }); } catch (e) { rfiErr(e, res); }
  });
  app.patch('/api/rfis/:id', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      const before = getRfi(db, req.params.id); // read once, before the change
      const r = setRfiStatus(db, req.params.id, req.body.status);
      if (req.body.status === 'closed' && before) {
        logActivity(db, { projectId: before.projectId, userId: (req as any).user?.id, type: 'rfi_closed', message: `RFI ${rfiNo(before.number)} closed` });
      }
      res.json({ success: true, ...r });
    } catch (e) { rfiErr(e, res); }
  });
  app.delete('/api/rfis/:id', authenticateToken, (req, res) => {
    try { deleteRfi(db, req.params.id); res.json({ success: true }); } catch (e) { rfiErr(e, res); }
  });
  app.post('/api/rfis/:id/photos', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      addRfiPhoto(db, req.params.id, req.body.fileId);
      res.json({ success: true });
    } catch (e) { rfiErr(e, res); }
  });
  app.delete('/api/rfis/:id/photos/:fileId', authenticateToken, (req, res) => {
    try { removeRfiPhoto(db, req.params.id, req.params.fileId); res.json({ success: true }); } catch (e) { rfiErr(e, res); }
  });
  // Record the answer — usually an uploaded response PDF, optionally text.
  app.post('/api/rfis/:id/response', authenticateToken, (req, res) => {
    try {
      const before = getRfi(db, req.params.id);
      const r = setRfiResponse(db, req.params.id, { fileId: req.body?.fileId, text: req.body?.text });
      if (before) {
        logActivity(db, { projectId: before.projectId, userId: (req as any).user?.id, type: 'rfi_answered', message: `RFI ${rfiNo(before.number)} answered` });
      }
      res.json({ success: true, ...r });
    } catch (e) { rfiErr(e, res); }
  });
```

- [ ] **Step 4: Run tests until green**

Run: `npx vitest run server/routes.test.ts`
Expected: PASS — new rfi tests AND every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/routes.test.ts
git commit -m "feat(rfi): CRUD + photos + response routes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: RFI send route (TDD)

**Files:**
- Modify: `server/routes.ts` — inside `registerEmailRoutes` (issue send route ends at line 1270; add the RFI send route after it, before the closing `}` at line 1271)
- Modify: `server/routes.test.ts` — extend the email-route describe block (issue send coverage is at ~line 1176; it stubs `buildTransporter` via `EmailRouteDeps`)

**Interfaces:**
- Consumes: `getRfi`, `markRfiSent` (Task 2 imports already added in Task 3).
- Produces: `POST /api/rfis/:id/send` — body `{to, fileId, cc?, bcc?, subject?, body?, message?, attachmentFileIds?}`; default subject `` `RFI ${rfiNo}${title ? ` — ${title}` : ''}` ``; primary attachment named `RFI-NNN.pdf`; marks sent; logs `rfi_sent`.

- [ ] **Step 1: Write failing send-route tests**

Clone the issue-send tests (~line 1176) as RFI variants in the same describe that wires `registerEmailRoutes` with the stub transporter:

- non-admin authenticated user allowed
- 400 when `to` or `fileId` missing; 404 unknown rfi
- default subject is `RFI RFI-001 — <title>` and primary attachment name `RFI-001.pdf` (assert on the stub transporter's captured `sendMail` args, same as the issue tests do)
- explicit subject/cc/bcc/body pass through; extra `attachmentFileIds` appended
- after send: rfi status is `sent` and `sentAt` set

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes.test.ts -t 'rfi'`
Expected: send tests FAIL with 404.

- [ ] **Step 3: Implement the route**

After the issue send route (line 1270) add:

```ts
  // Send an RFI PDF via SMTP (any authenticated user — field members send RFIs)
  app.post('/api/rfis/:id/send', authenticateToken, async (req, res) => {
    try {
      const rfi = getRfi(db, req.params.id);
      if (!rfi) return res.status(404).json({ error: 'RFI not found' });
      const { to, fileId, message, cc, bcc, subject, body, attachmentFileIds } = req.body as SendBody;
      if (!to || !fileId) return res.status(400).json({ error: 'to and fileId are required' });
      const padded = String(rfi.number).padStart(3, '0');
      await send((req as any).user.id, {
        to,
        cc,
        bcc,
        subject: subject?.trim() || `RFI RFI-${padded}${rfi.title ? ` — ${rfi.title}` : ''}`,
        text: body ?? message ?? 'Please find the attached RFI.',
        attachments: buildSendAttachments(db, { fileId, attachmentName: `RFI-${padded}.pdf` }, attachmentFileIds),
      });
      try { markRfiSent(db, req.params.id); } catch { /* best effort */ }
      logActivity(db, { projectId: rfi.projectId, userId: (req as any).user?.id, type: 'rfi_sent', message: `RFI RFI-${padded} emailed to ${to}` });
      res.json({ success: true });
    } catch (e: any) {
      console.error('Error sending RFI:', e);
      res.status(500).json({ error: e.message || 'Failed to send RFI' });
    }
  });
```

Note: `getRfi`/`markRfiSent` must be visible inside `registerEmailRoutes` — it lives in the same `routes.ts` module, so the Task 3 top-level imports cover it.

- [ ] **Step 4: Run tests until green**

Run: `npx vitest run server/routes.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/routes.test.ts
git commit -m "feat(rfi): email send route (default subject, RFI-NNN.pdf attachment, marks sent)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Client API + recipients + status pill

**Files:**
- Modify: `src/utils/store.ts` — new `// ── RFIs` section after the issues section (issues API ends ~line 912)
- Modify: `src/utils/recipients.ts` — add `'rfi'` to `TemplateType` (line 3) and to `roleForTemplate` (map to `'pm'`, alongside issue/punch at line 16-17)
- Create: `src/components/ui/RfiStatusPill.tsx`

**Interfaces:**
- Produces (client):
  - Types `RfiPhoto {id,fileId,sortOrder}`, `Rfi {id,projectId,number,title,question,specRef,drawingRef,attention,responseNeededBy,responseText,responseFileId,status,version,sentAt,answeredAt,createdAt,photos}`, `RfiListItem` (same scalars + `photoCount`, no `photos`)
  - `getRfis(projectId)`, `getRfi(id)`, `createRfi(projectId, {title, question?})`, `saveRfi(id, rfi)` (throws `ConflictError` on 409), `setRfiStatus(id, status)`, `deleteRfi(id)`, `addRfiPhoto(rfiId, fileId)`, `removeRfiPhoto(rfiId, fileId)`, `setRfiResponse(id, {fileId?, text?})`, `sendRfi(id, payload)` (same payload shape as `sendIssue`)
  - `RfiStatusPill` + `RFI_STATUS_META` (open=amber, sent=blue, answered=emerald, closed=slate — but check `PillTone` union in `src/components/ui/StatusPill.tsx` first; if `slate` isn't a member, use the tone the union offers for neutral)

- [ ] **Step 1: Add types + API client to `src/utils/store.ts`**

Clone the issues section (lines 853-912) as a new section directly after `sendIssue`; string fields that can be empty are `string | null`:

```ts
// ── RFIs ─────────────────────────────────────────────────────────────────────

export interface RfiPhoto { id: string; fileId: string; sortOrder: number; }
export interface Rfi {
  id: string;
  projectId: string;
  number: number;
  title: string | null;
  question: string | null;
  specRef: string | null;
  drawingRef: string | null;
  attention: string | null;
  responseNeededBy: string | null; // ISO date (yyyy-mm-dd)
  responseText: string | null;
  responseFileId: string | null;
  status: string; // open | sent | answered | closed
  version: number;
  sentAt: number | null;
  answeredAt: number | null;
  createdAt: number;
  photos: RfiPhoto[];
}
export interface RfiListItem {
  id: string; projectId: string; number: number; title: string | null;
  question: string | null; specRef: string | null; drawingRef: string | null;
  attention: string | null; responseNeededBy: string | null;
  responseText: string | null; responseFileId: string | null;
  status: string; version: number; sentAt: number | null; answeredAt: number | null;
  createdAt: number; photoCount: number;
}

const rfiJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getRfis = async (projectId: string): Promise<RfiListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/rfis`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getRfi = async (id: string): Promise<Rfi> => {
  const res = await fetchWithRetry(`/api/rfis/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createRfi = async (projectId: string, input: { title: string; question?: string }): Promise<{ id: string; number: number }> => {
  const res = await rfiJson('POST', `/api/projects/${projectId}/rfis`, input);
  await handleResponse(res); return res.json();
};
export const saveRfi = async (id: string, rfi: Rfi): Promise<{ version: number }> => {
  const res = await rfiJson('PUT', `/api/rfis/${id}`, rfi);
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setRfiStatus = async (id: string, status: string): Promise<void> => {
  const res = await rfiJson('PATCH', `/api/rfis/${id}`, { status }); await handleResponse(res);
};
export const deleteRfi = async (id: string): Promise<void> => {
  const res = await rfiJson('DELETE', `/api/rfis/${id}`); await handleResponse(res);
};
export const addRfiPhoto = async (rfiId: string, fileId: string): Promise<void> => {
  const res = await rfiJson('POST', `/api/rfis/${rfiId}/photos`, { fileId }); await handleResponse(res);
};
export const removeRfiPhoto = async (rfiId: string, fileId: string): Promise<void> => {
  const res = await rfiJson('DELETE', `/api/rfis/${rfiId}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const setRfiResponse = async (id: string, input: { fileId?: string; text?: string }): Promise<void> => {
  const res = await rfiJson('POST', `/api/rfis/${id}/response`, input); await handleResponse(res);
};
export const sendRfi = async (id: string, payload: { to: string; cc?: string; bcc?: string; subject?: string; body?: string; fileId: string; attachmentFileIds?: string[]; message?: string }): Promise<void> => {
  const res = await rfiJson('POST', `/api/rfis/${id}/send`, payload); await handleResponse(res);
};
```

- [ ] **Step 2: Add `'rfi'` to recipients**

In `src/utils/recipients.ts`: change line 3 to include `'rfi'` in `TemplateType`, and in `roleForTemplate` add `case 'rfi':` alongside `case 'issue': case 'punch': return 'pm';`.

- [ ] **Step 3: Create `src/components/ui/RfiStatusPill.tsx`**

First open `src/components/ui/StatusPill.tsx` to confirm the `PillTone` union members; then:

```tsx
// src/components/ui/RfiStatusPill.tsx
import React from 'react';
import { StatusPill, PillTone } from './StatusPill';

export const RFI_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  open:     { label: 'Open',     tone: 'amber' },
  sent:     { label: 'Sent',     tone: 'blue' },
  answered: { label: 'Answered', tone: 'emerald' },
  closed:   { label: 'Closed',   tone: 'slate' },
};

export const RfiStatusPill: React.FC<{ status?: string | null; className?: string }> = ({ status, className }) => {
  const entry = status != null && Object.hasOwn(RFI_STATUS_META, status) ? RFI_STATUS_META[status] : null;
  const m = entry ?? { label: status || 'Unknown', tone: 'slate' as PillTone };
  return <StatusPill tone={m.tone} className={className}>{m.label}</StatusPill>;
};
```

(`IssueStatusPill` already uses tones `amber`/`blue`/`emerald` and falls back to `'slate'`, so `slate` is a valid tone.)

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: clean (no TS errors).

- [ ] **Step 5: Commit**

```bash
git add src/utils/store.ts src/utils/recipients.ts src/components/ui/RfiStatusPill.tsx
git commit -m "feat(rfi): client API, rfi recipient role, status pill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: RFI PDF builder (TDD on pure helpers)

**Files:**
- Create: `src/pages/project/rfi/rfiPdf.ts`
- Create: `src/pages/project/rfi/rfiPdf.test.ts`

**Interfaces:**
- Consumes: `Rfi` type (Task 5), `LetterheadContext`/`drawLetterheadHeader`/`drawLetterheadFooter` from `src/utils/documentLetterhead.ts`.
- Produces:
  - `rfiHeading(rfi: Pick<Rfi,'number'|'title'>): string` → `RFI-007 · Title`
  - `buildRfiPdf(ctx: RfiPdfContext): Uint8Array` — `RfiPdfContext { rfi: Rfi; projectName: string; contractor?: string | null; photoDataUrls: string[]; letterhead: LetterheadContext; headerEmail?: string }`

- [ ] **Step 1: Write the failing pure-helper test** (mirror `issuePdf.test.ts`)

```ts
// src/pages/project/rfi/rfiPdf.test.ts
import { describe, it, expect } from 'vitest';
import { rfiHeading } from './rfiPdf';

describe('rfiHeading', () => {
  it('pads the number and joins the title', () => {
    expect(rfiHeading({ number: 7, title: 'Finish at column 5' })).toBe('RFI-007 · Finish at column 5');
  });
  it('handles a missing title', () => {
    expect(rfiHeading({ number: 12, title: null })).toBe('RFI-012 · (untitled)');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/project/rfi/rfiPdf.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `rfiPdf.ts`**

Clone `issuePdf.ts` scaffold (same jsPDF setup, letterhead redraw on `newPage`, photos grid) with these body changes: title "REQUEST FOR INFORMATION"; a two-column info block; a Question section; a Response section.

```ts
// src/pages/project/rfi/rfiPdf.ts
import { jsPDF } from 'jspdf';
import { Rfi } from '../../../utils/store';
import {
  LetterheadContext,
  drawLetterheadHeader,
  drawLetterheadFooter,
} from '../../../utils/documentLetterhead';

export const rfiHeading = (rfi: Pick<Rfi, 'number' | 'title'>): string =>
  `RFI-${String(rfi.number).padStart(3, '0')} · ${rfi.title || '(untitled)'}`;

export interface RfiPdfContext {
  rfi: Rfi;
  projectName: string;
  contractor?: string | null;
  photoDataUrls: string[]; // pre-fetched (caller resolves each fileId → dataURL)
  letterhead: LetterheadContext;
  headerEmail?: string;
}

// Builds the RFI PDF and returns the bytes. Shared branded letterhead on every
// page; body is a two-column info block, the question, the response (when
// answered), then a photos grid.
export function buildRfiPdf(ctx: RfiPdfContext): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const M = 48;
  const lc: LetterheadContext = ctx.headerEmail
    ? { ...ctx.letterhead, company: { ...ctx.letterhead.company, email: ctx.headerEmail } }
    : ctx.letterhead;
  const [ar, ag, ab] = lc.brandRgb;

  const top = drawLetterheadHeader(doc, lc);
  const bottom = drawLetterheadFooter(doc, lc);
  let y = top;
  const newPage = () => {
    doc.addPage();
    drawLetterheadHeader(doc, lc);
    drawLetterheadFooter(doc, lc);
    y = top;
  };

  // Title + date
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(ar, ag, ab);
  doc.text('REQUEST FOR INFORMATION', M, y + 8);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(60, 60, 60);
  doc.text(new Date(ctx.rfi.createdAt).toLocaleDateString(), W - M, y, { align: 'right' });
  y += 28;

  // Two-column info block (skip empty rows). Left/right pairs.
  const fmtDate = (iso: string | null) => {
    if (!iso) return '';
    const d = new Date(`${iso}T00:00:00`);
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  };
  const rows: Array<[string, string]> = [
    ['RFI No.', `RFI-${String(ctx.rfi.number).padStart(3, '0')}`],
    ['Project', ctx.projectName],
    ...(ctx.contractor ? [['Contractor', ctx.contractor] as [string, string]] : []),
    ...(ctx.rfi.attention ? [['Attention', ctx.rfi.attention] as [string, string]] : []),
    ...(ctx.rfi.responseNeededBy ? [['Response needed by', fmtDate(ctx.rfi.responseNeededBy)] as [string, string]] : []),
    ...(ctx.rfi.specRef ? [['Spec reference', ctx.rfi.specRef] as [string, string]] : []),
    ...(ctx.rfi.drawingRef ? [['Drawing reference', ctx.rfi.drawingRef] as [string, string]] : []),
  ];
  const colW = (W - 2 * M) / 2;
  doc.setFontSize(10);
  rows.forEach((row, i) => {
    const col = i % 2, x = M + col * colW;
    doc.setFont('helvetica', 'bold').setTextColor(120, 120, 120);
    doc.text(`${row[0]}:`, x, y);
    doc.setFont('helvetica', 'normal').setTextColor(30, 30, 30);
    doc.text(doc.splitTextToSize(row[1], colW - 110)[0] ?? '', x + 105, y);
    if (col === 1 || i === rows.length - 1) y += 15;
  });
  y += 8;

  // Heading + rule + status
  doc.setFont('helvetica', 'bold').setFontSize(14).setTextColor(ar, ag, ab);
  doc.text(rfiHeading(ctx.rfi), M, y); y += 8;
  doc.setDrawColor(ar, ag, ab).setLineWidth(1).line(M, y, W - M, y); y += 18;
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(120, 120, 120);
  doc.text(`Status: ${ctx.rfi.status}`, M, y); y += 18;

  // Wrapped-paragraph helper with page breaks
  const paragraph = (text: string, size = 11) => {
    doc.setFont('helvetica', 'normal').setFontSize(size).setTextColor(30, 30, 30);
    const lines = doc.splitTextToSize(text, W - 2 * M) as string[];
    for (const line of lines) {
      if (y + 14 > bottom) { newPage(); doc.setFont('helvetica', 'normal').setFontSize(size).setTextColor(30, 30, 30); }
      doc.text(line, M, y); y += 14;
    }
    y += 12;
  };
  const sectionLabel = (label: string) => {
    if (y + 28 > bottom) newPage();
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(60, 60, 60);
    doc.text(label, M, y); y += 14;
  };

  // Question
  if (ctx.rfi.question) {
    sectionLabel('Question');
    paragraph(ctx.rfi.question);
  }

  // Response (only when answered)
  if (ctx.rfi.responseText || ctx.rfi.responseFileId) {
    sectionLabel('Response');
    if (ctx.rfi.answeredAt) {
      doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(120, 120, 120);
      doc.text(`Answered ${new Date(ctx.rfi.answeredAt).toLocaleDateString()}`, M, y); y += 14;
    }
    if (ctx.rfi.responseText) paragraph(ctx.rfi.responseText);
    if (ctx.rfi.responseFileId) paragraph('Response received — see attached response document.', 10);
  }

  // Photos grid (2 per row)
  if (ctx.photoDataUrls.length) {
    sectionLabel('Photos');
    const cellW = (W - 2 * M - 12) / 2, cellH = 150;
    let col = 0;
    for (const url of ctx.photoDataUrls) {
      if (y + cellH > bottom) { newPage(); col = 0; }
      const x = M + col * (cellW + 12);
      try { doc.addImage(url, 'JPEG', x, y, cellW, cellH, undefined, 'FAST'); } catch { /* skip bad image */ }
      col++;
      if (col === 2) { col = 0; y += cellH + 12; }
    }
  }

  return doc.output('arraybuffer') as unknown as Uint8Array;
}
```

- [ ] **Step 4: Run test until green + typecheck**

Run: `npx vitest run src/pages/project/rfi/rfiPdf.test.ts && npm run lint`
Expected: PASS, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/project/rfi/rfiPdf.ts src/pages/project/rfi/rfiPdf.test.ts
git commit -m "feat(rfi): branded RFI PDF (info block, question, response, photos)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: RfiEditor modal

**Files:**
- Create: `src/pages/project/rfi/RfiEditor.tsx`

**Interfaces:**
- Consumes: Task 5 client API + `RfiStatusPill`/`RFI_STATUS_META`; Task 6 `buildRfiPdf`/`rfiHeading`; shared `EmailComposer`, `resolveRecipient('rfi', …)`, `uploadProjectFile`, `getImageUrl`, `fetchFileBlob`, `hexToRgb`, `invertImageDataUrl`.
- Produces: `RfiEditor: React.FC<{ rfi: Rfi; projectId: string; projectName: string; contractor?: string | null; onClose: () => void; onSaved: () => void }>` — Task 8's list page mounts it keyed `${id}:${version}`.

- [ ] **Step 1: Implement `RfiEditor.tsx`**

Clone `src/pages/project/issues/IssueEditor.tsx` (lines 1-243) with these exact deltas — keep everything else identical in structure (email-defaults effect, photo upload flow, letterhead assembly, save-first guards, EmailComposer wiring):

1. Imports: swap issue API for `Rfi, saveRfi, setRfiStatus, addRfiPhoto, removeRfiPhoto, setRfiResponse, sendRfi` (+ same shared imports); `RfiStatusPill, RFI_STATUS_META`; `buildRfiPdf` from `./rfiPdf`.
2. Local state: `title`, `question` (was description), plus `specRef`, `drawingRef`, `attention`, `responseNeededBy`, and `responseDraft` (text response input, initialized from `rfi.responseText ?? ''`).
3. `resolveRecipient('rfi', …)` in the defaults effect.
4. `padded` uses `rfi.number`; all `ISS-` strings become `RFI-`; download filename `RFI-${padded}.pdf`; Modal title `RFI-${padded}`; composer title "Send RFI"; default subject `` `RFI RFI-${padded} — ${projectName}` ``; default body `` `Hello,\n\nPlease find attached RFI-${padded}${rfi.title ? ' — ' + rfi.title : ''} for ${projectName}.\n\nPlease respond${rfi.responseNeededBy ? ` by ${rfi.responseNeededBy}` : ' at your earliest convenience'}.\n\nThank you.` ``; upload kind for the sent PDF is `'rfi'`; send call is `sendRfi(...)`.
5. Dirty check (save-first guard, used before composer AND status change) compares all editable fields:

```ts
const isDirty = () =>
  title.trim() !== (rfi.title ?? '') ||
  question !== (rfi.question ?? '') ||
  specRef !== (rfi.specRef ?? '') ||
  drawingRef !== (rfi.drawingRef ?? '') ||
  attention !== (rfi.attention ?? '') ||
  (responseNeededBy || '') !== (rfi.responseNeededBy ?? '');
```

6. `handleSave` sends all fields:

```ts
await saveRfi(rfi.id, { ...rfi, title: title.trim(), question: question || null, specRef: specRef || null, drawingRef: drawingRef || null, attention: attention || null, responseNeededBy: responseNeededBy || null });
```

7. Status cycle: `open → sent → answered → closed → open`:

```ts
const next = rfi.status === 'open' ? 'sent' : rfi.status === 'sent' ? 'answered' : rfi.status === 'answered' ? 'closed' : 'open';
```

8. Form fields (after Title, before Photos): Question `Textarea rows={4}`; then a responsive two-column grid:

```tsx
<div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
  <Field label="Attention" htmlFor="rfi-att"><Input id="rfi-att" value={attention} onChange={e => setAttention(e.target.value)} placeholder="e.g. GC project manager" /></Field>
  <Field label="Response needed by" htmlFor="rfi-due"><Input id="rfi-due" type="date" value={responseNeededBy} onChange={e => setResponseNeededBy(e.target.value)} /></Field>
  <Field label="Spec reference" htmlFor="rfi-spec"><Input id="rfi-spec" value={specRef} onChange={e => setSpecRef(e.target.value)} placeholder="e.g. 09 24 00" /></Field>
  <Field label="Drawing reference" htmlFor="rfi-dwg"><Input id="rfi-dwg" value={drawingRef} onChange={e => setDrawingRef(e.target.value)} placeholder="e.g. A-501" /></Field>
</div>
```

9. **Response section** (new, between Photos and the send/download row), bordered like the Photos section:

```tsx
<div className="mt-4 border-t border-edge pt-3">
  <div className="mb-2 flex items-center justify-between">
    <h4 className="text-sm font-semibold text-ink">Response</h4>
    <Button variant="secondary" size="sm" onClick={() => responseFileRef.current?.click()} disabled={uploadingResponse}>
      <FileUp size={14} />{uploadingResponse ? 'Uploading…' : rfi.responseFileId ? 'Replace response PDF' : 'Upload response PDF'}
    </Button>
    <input ref={responseFileRef} type="file" accept="application/pdf,image/*" className="hidden"
      onChange={e => handleResponseFile(e.target.files)} />
  </div>
  {rfi.answeredAt && <p className="mb-2 text-xs text-ink-faint">Answered {new Date(rfi.answeredAt).toLocaleDateString()}</p>}
  {rfi.responseFileId && (
    <p className="mb-2 text-xs">
      <button className="text-accent underline" onClick={downloadResponseFile}>Download response document</button>
    </p>
  )}
  <Field label="Response text (for non-PDF answers)" htmlFor="rfi-resp">
    <Textarea id="rfi-resp" value={responseDraft} onChange={e => setResponseDraft(e.target.value)} rows={3} />
  </Field>
  <div className="mt-2">
    <Button variant="secondary" size="sm" onClick={saveResponseText} disabled={!responseDraft.trim() || responseDraft.trim() === (rfi.responseText ?? '')}>Save response text</Button>
  </div>
</div>
```

with handlers:

```ts
const responseFileRef = useRef<HTMLInputElement>(null);
const [uploadingResponse, setUploadingResponse] = useState(false);
const handleResponseFile = async (list: FileList | null) => {
  if (!list || !list.length) return;
  setUploadingResponse(true);
  try {
    const fileId = await uploadProjectFile(projectId, list[0], 'rfi-response');
    await setRfiResponse(rfi.id, { fileId });
    toast('Response attached', { type: 'success' });
    onSaved();
  } catch { toast('Failed to attach response', { type: 'error' }); }
  finally { setUploadingResponse(false); if (responseFileRef.current) responseFileRef.current.value = ''; }
};
const saveResponseText = async () => {
  try { await setRfiResponse(rfi.id, { text: responseDraft.trim() }); toast('Response saved', { type: 'success' }); onSaved(); }
  catch { toast('Failed to save response', { type: 'error' }); }
};
const downloadResponseFile = async () => {
  if (!rfi.responseFileId) return;
  try {
    const blob = await fetchFileBlob(rfi.responseFileId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `RFI-${padded}-response`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { toast('Failed to download response', { type: 'error' }); }
};
```

(`FileUp` comes from `lucide-react`, added to the existing `Camera, Trash2` import.)

10. `buildRfiBytes(headerEmail?)` mirrors `buildIssueBytes` but calls `buildRfiPdf({ rfi, projectName, contractor, photoDataUrls, letterhead, headerEmail })`.
11. Button labels: "Send RFI" / "Download PDF".

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/pages/project/rfi/RfiEditor.tsx
git commit -m "feat(rfi): editor modal — fields, photos, response upload/text, PDF, email

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: List page, registration, full verification

**Files:**
- Create: `src/pages/project/ProjectRfis.tsx`
- Create: `src/pages/project/ProjectRfis.test.tsx`
- Modify: `src/App.tsx` (import + route at line 123 area)
- Modify: `src/components/shell/Sidebar.tsx` (PROJECT_NAV, line 54 area)
- Modify: `src/components/CommandPalette.tsx` (contextual actions, lines 100/108 area)

**Interfaces:**
- Consumes: Task 5 API + pill, Task 7 `RfiEditor`.
- Produces: route `/project/:projectId/rfis` with `?new=1` focus support; exports `rfiNo(n: number): string` and `isRfiOverdue(rfi: {responseNeededBy: string|null; status: string}, now?: Date): boolean`.

- [ ] **Step 1: Write the failing pure-helper test**

```tsx
// src/pages/project/ProjectRfis.test.tsx
import { describe, it, expect } from 'vitest';
import { rfiNo, isRfiOverdue } from './ProjectRfis';

describe('rfiNo', () => {
  it('pads to three digits', () => {
    expect(rfiNo(1)).toBe('RFI-001');
    expect(rfiNo(42)).toBe('RFI-042');
    expect(rfiNo(1234)).toBe('RFI-1234');
  });
});

describe('isRfiOverdue', () => {
  const now = new Date('2026-07-28T12:00:00');
  it('true when past due and not answered/closed', () => {
    expect(isRfiOverdue({ responseNeededBy: '2026-07-27', status: 'sent' }, now)).toBe(true);
    expect(isRfiOverdue({ responseNeededBy: '2026-07-27', status: 'open' }, now)).toBe(true);
  });
  it('false when answered, closed, not due yet, or dateless', () => {
    expect(isRfiOverdue({ responseNeededBy: '2026-07-27', status: 'answered' }, now)).toBe(false);
    expect(isRfiOverdue({ responseNeededBy: '2026-07-27', status: 'closed' }, now)).toBe(false);
    expect(isRfiOverdue({ responseNeededBy: '2026-07-29', status: 'sent' }, now)).toBe(false);
    expect(isRfiOverdue({ responseNeededBy: '2026-07-28', status: 'sent' }, now)).toBe(false); // due today ≠ overdue
    expect(isRfiOverdue({ responseNeededBy: null, status: 'sent' }, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/project/ProjectRfis.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ProjectRfis.tsx`**

Clone `ProjectIssues.tsx` (lines 1-116) with these deltas:

- Imports: rfi API/types, `RfiStatusPill`, `RfiEditor` from `./rfi/RfiEditor`, icon `MessageCircleQuestion` (lucide) instead of `AlertCircle`.
- Exports:

```ts
export const rfiNo = (n: number): string => `RFI-${String(n).padStart(3, '0')}`;

// Overdue is a display rule, not a status: past the response-needed date and
// still awaiting an answer. Due-today is not overdue.
export const isRfiOverdue = (rfi: { responseNeededBy: string | null; status: string }, now: Date = new Date()): boolean => {
  if (!rfi.responseNeededBy || rfi.status === 'answered' || rfi.status === 'closed') return false;
  const due = new Date(`${rfi.responseNeededBy}T23:59:59`);
  return !isNaN(due.getTime()) && due.getTime() < now.getTime();
};
```

- Heading "RFIs"; create field id `new-rfi`, label "New RFI", placeholder "What do you need answered?"; EmptyState title "No RFIs yet", description "Ask the design team or GC a formal question — attach photos, send a branded PDF, and track the response."
- Table columns: `#`, `Title`, `Status`, `Response needed`, `Photos`, delete. Response-needed cell:

```tsx
<TD className={isRfiOverdue(rfi) ? 'font-medium text-red-600' : 'text-ink-soft'}>
  {rfi.responseNeededBy ? new Date(`${rfi.responseNeededBy}T00:00:00`).toLocaleDateString() : '—'}
  {isRfiOverdue(rfi) ? ' · overdue' : ''}
</TD>
```

- Delete confirm copy: title "Delete RFI?", message "This permanently removes the RFI."
- Mount `RfiEditor` keyed `${editing.id}:${editing.version}` with the same props shape as `IssueEditor` (`rfi=` instead of `issue=`).

- [ ] **Step 4: Register route, sidebar, palette**

1. `src/App.tsx`: add `import { ProjectRfis } from './pages/project/ProjectRfis';` next to the ProjectIssues import, and after `{ path: 'issues', ... }` (line 123) add:

```tsx
            { path: 'rfis', element: <ProjectRfis /> },
```

2. `src/components/shell/Sidebar.tsx`: import `MessageCircleQuestion` from lucide-react; after the `issues` entry (line 54) add:

```ts
  { id: 'rfis',      label: 'RFIs',               Icon: MessageCircleQuestion, path: '/rfis', match: (p, b) => p.startsWith(`${b}/rfis`) },
```

3. `src/components/CommandPalette.tsx`: import `MessageCircleQuestion`; after `ctx:new-issue` (line 100) add:

```tsx
      { id: 'ctx:new-rfi', type: 'action' as const, title: 'New RFI', subtitle: 'Project', icon: <MessageCircleQuestion size={16} />, run: () => navigate(`/project/${projectId}/rfis?new=1`) },
```

and after `ctx:issues` (line 108):

```tsx
      { id: 'ctx:rfis', type: 'action' as const, title: 'RFIs', subtitle: 'Project', icon: <MessageCircleQuestion size={16} />, run: () => navigate(`/project/${projectId}/rfis`) },
```

(If `MessageCircleQuestion` doesn't exist in the installed lucide-react version, use `HelpCircle` in all three spots.)

- [ ] **Step 5: Full verification**

Run: `npx vitest run src/pages/project/ProjectRfis.test.tsx` → PASS
Run: `npm run lint` → clean
Run: `npm test` → full suite PASS (630 pre-existing + all new)
Run: `npm run build` → succeeds

- [ ] **Step 6: Commit**

```bash
git add src/pages/project/ProjectRfis.tsx src/pages/project/ProjectRfis.test.tsx src/App.tsx src/components/shell/Sidebar.tsx src/components/CommandPalette.tsx
git commit -m "feat(rfi): RFIs project section — list page, route, sidebar, command palette

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
