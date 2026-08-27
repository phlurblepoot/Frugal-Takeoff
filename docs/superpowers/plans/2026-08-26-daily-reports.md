# Daily Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Daily Reports" project tab: one report per project per calendar date (crew counts, auto-fetched observed weather, notes, issues, photos), with a letterhead PDF (overflow-safe) and email send — cloned from the RFI vertical.

**Architecture:** New vertical mirroring RFIs: `daily_reports` + `daily_report_photos` tables (migration 27, additive), `server/dailyReportStore.ts` + routes in `server/routes.ts`, a server weather module (Nominatim geocode + Open-Meteo hourly observed data), client store helpers, a list page + editor modal under `src/pages/project/daily/`, jsPDF letterhead PDF, shared EmailComposer send.

**Tech Stack:** Express 4, better-sqlite3, socket.io change feed (`entity-changed`), React 19 + react-router 7, jsPDF, nodemailer (existing `registerEmailRoutes` infra), Node global `fetch` for weather, Vitest (server + ui projects).

**Spec:** `docs/superpowers/specs/2026-08-26-daily-reports-design.md`

## Global Constraints

- **One report per project per calendar date** — `UNIQUE(projectId, reportDate)`; duplicate date → `409 { error: 'date_taken', existingId }`.
- **NEVER use `crypto.randomUUID()` or any secure-context-only API** — use `import { v4 as uuidv4 } from 'uuid'`. (rfiStore.ts uses crypto.randomUUID — copy the pattern, NOT that line.)
- Migration 27 is **ADDITIVE only** (new tables + nothing else). No data transforms.
- Every mutation route publishes `deps.broadcastChange({ type: 'dailyReport', ... , ...requestMeta(req) })`; **never attach a version the mutation didn't bump** (deleted → no version; photo add/remove doesn't bump version → broadcast without version).
- `'dailyReport'` must be added to BOTH `EntityType` unions: `server/realtime/changeFeed.ts` AND `src/hooks/useLiveQuery.ts` (hand-duplicated unions).
- All routes `authenticateToken` only — **no admin gate** (field users author and send reports, like RFIs/Issues).
- `daily_report_photos` must be added to the photo-purge table array in `server/routes.ts` (search `'rfi_photos'`).
- File kinds/source: generated PDF `kind: 'daily-report'`, photos `kind: 'daily-report-photo'`, both with `sourceType: 'dailyReport'`, `sourceId: <report id>` (drives unified-Documents upsert-by-source).
- PDF: jsPDF, portrait/`'pt'`/`'letter'`, shared `drawLetterheadHeader`/`drawLetterheadFooter` from `src/utils/documentLetterhead.ts`, manual `if (y + h > bottom) newPage()` overflow checks; overflowing sections continue under a "<Section> (continued)" heading; nothing truncated.
- Tests: server tests import vitest explicitly, in-memory db + real migrations (rfiStore.test.ts pattern). UI tests = exported-pure-helper tests only (repo convention — no RTL renders, no jsPDF mocking).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Migration 27 + dailyReportStore

**Files:**
- Modify: `server/migrationList.ts` (append after the version-26 entry)
- Create: `server/dailyReportStore.ts`
- Test: `server/dailyReportStore.test.ts`, add a describe block to `server/migrationList.test.ts`

**Interfaces:**
- Consumes: `Migration` from `server/migrations.ts`; `uuid`'s `v4`.
- Produces (Task 2 relies on these exact names):
```ts
export class ValidationError extends Error {}
export class ConflictError extends Error {}      // version conflict
export class NotFoundError extends Error {}
export class DateTakenError extends Error { constructor(public existingId: string) { super('date_taken'); } }
export interface ManCountLine { type: string; count: number; }
export interface DailyWeatherHour { hour: string; tempF: number | null; condition: string; }
export interface DailyReportInput {
  reportDate?: string; jobName?: string; contractorName?: string;
  weatherSummary?: string; temperature?: string; weatherHourly?: DailyWeatherHour[];
  manCounts?: ManCountLine[]; fieldNotes?: string; issues?: string;
}
export function getDailyReport(db, id: string): any | null          // parses JSON cols, photos: [{id,fileId,sortOrder}]
export function listDailyReports(db, projectId: string): any[]      // date DESC; parsed manCounts; photoCount: number
export function createDailyReport(db, projectId: string, input: DailyReportInput, createdBy?: string): { id: string }
export function saveDailyReport(db, id: string, input: DailyReportInput & { version?: number }): { version: number }
export function deleteDailyReport(db, id: string): void
export function addPhoto(db, dailyReportId: string, fileId: string): void     // idempotent, sortOrder=MAX+1, does NOT bump version
export function removePhoto(db, dailyReportId: string, fileId: string): void  // does NOT bump version
```

- [ ] **Step 1: Append migration 27** to `server/migrationList.ts` after the version-26 (`sheet-sessions`) entry:

```ts
{
  version: 27,
  name: 'daily-reports',
  // ADDITIVE. Daily field reports: one row per project per calendar date
  // (UNIQUE below is the identity rule), plus an RFI-style photo join table.
  // weatherHourly/manCounts are JSON text columns (display-only lists, never
  // queried by content).
  up({ db }) {
    db.exec(`
      CREATE TABLE daily_reports (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        reportDate TEXT NOT NULL,
        jobName TEXT NOT NULL DEFAULT '',
        contractorName TEXT NOT NULL DEFAULT '',
        weatherSummary TEXT NOT NULL DEFAULT '',
        temperature TEXT NOT NULL DEFAULT '',
        weatherHourly TEXT NOT NULL DEFAULT '[]',
        manCounts TEXT NOT NULL DEFAULT '[]',
        fieldNotes TEXT NOT NULL DEFAULT '',
        issues TEXT NOT NULL DEFAULT '',
        createdBy TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(projectId, reportDate)
      );
      CREATE INDEX idx_daily_reports_project ON daily_reports(projectId);
      CREATE TABLE daily_report_photos (
        id TEXT PRIMARY KEY,
        dailyReportId TEXT NOT NULL,
        fileId TEXT NOT NULL,
        sortOrder INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL
      );
    `);
  },
},
```

- [ ] **Step 2: Add the migration test** — new describe block at the end of `server/migrationList.test.ts`, following the existing per-migration pattern (e.g. the migration-26 block):

```ts
describe('migration 27: daily reports', () => {
  it('creates daily_reports with the unique date rule and the photos join table', () => {
    const db = openDb(':memory:');
    runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-m27-')), migrations);
    db.prepare(`INSERT INTO daily_reports (id, projectId, reportDate, createdAt, updatedAt) VALUES ('d1','p1','2026-08-26',1,1)`).run();
    expect(() =>
      db.prepare(`INSERT INTO daily_reports (id, projectId, reportDate, createdAt, updatedAt) VALUES ('d2','p1','2026-08-26',1,1)`).run(),
    ).toThrow(/UNIQUE/);
    // same date on a DIFFERENT project is fine
    db.prepare(`INSERT INTO daily_reports (id, projectId, reportDate, createdAt, updatedAt) VALUES ('d3','p2','2026-08-26',1,1)`).run();
    db.prepare(`INSERT INTO daily_report_photos (id, dailyReportId, fileId, sortOrder, createdAt) VALUES ('ph1','d1','f1',0,1)`).run();
    expect(db.prepare('SELECT COUNT(*) c FROM daily_report_photos').get()).toEqual({ c: 1 });
  });
});
```
(Reuse the imports/helpers already at the top of the file — do not re-import what exists.)

- [ ] **Step 3: Run it to see it pass** (migration test needs no store): `npx vitest run --project server migrationList` → the new block passes.

- [ ] **Step 4: Write the failing store tests** — `server/dailyReportStore.test.ts`, setup copied from `rfiStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  getDailyReport, listDailyReports, createDailyReport, saveDailyReport, deleteDailyReport,
  addPhoto, removePhoto, ValidationError, ConflictError, NotFoundError, DateTakenError,
} from './dailyReportStore';

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-daily-')), migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p2', 'Proj2', 1);
});

describe('createDailyReport', () => {
  it('creates with prefills and returns the id', () => {
    const r = createDailyReport(db, 'p1', { reportDate: '2026-08-26', jobName: 'Job', contractorName: 'GC' }, 'nathan');
    const row = getDailyReport(db, r.id);
    expect(row.reportDate).toBe('2026-08-26');
    expect(row.jobName).toBe('Job');
    expect(row.version).toBe(1);
    expect(row.createdBy).toBe('nathan');
    expect(row.photos).toEqual([]);
    expect(row.manCounts).toEqual([]);
    expect(row.weatherHourly).toEqual([]);
  });
  it('rejects a missing or malformed reportDate', () => {
    expect(() => createDailyReport(db, 'p1', {})).toThrow(ValidationError);
    expect(() => createDailyReport(db, 'p1', { reportDate: '8/26/2026' })).toThrow(ValidationError);
  });
  it('throws DateTakenError carrying the existing id on a duplicate date', () => {
    const r = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    try {
      createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DateTakenError);
      expect((e as DateTakenError).existingId).toBe(r.id);
    }
    // same date, other project: fine
    createDailyReport(db, 'p2', { reportDate: '2026-08-26' });
  });
  it('throws NotFoundError for a missing project', () => {
    expect(() => createDailyReport(db, 'nope', { reportDate: '2026-08-26' })).toThrow(NotFoundError);
  });
});

describe('saveDailyReport', () => {
  it('saves all fields, round-trips JSON columns, bumps version', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    const out = saveDailyReport(db, id, {
      version: 1, jobName: 'J', contractorName: 'C', weatherSummary: 'Sunny', temperature: '70–80°F',
      weatherHourly: [{ hour: '6 AM', tempF: 71, condition: 'Clear' }],
      manCounts: [{ type: 'Plasterer', count: 4 }, { type: 'Supervisor', count: 1 }],
      fieldNotes: 'notes', issues: 'none',
    });
    expect(out.version).toBe(2);
    const row = getDailyReport(db, id);
    expect(row.manCounts).toEqual([{ type: 'Plasterer', count: 4 }, { type: 'Supervisor', count: 1 }]);
    expect(row.weatherHourly[0].condition).toBe('Clear');
  });
  it('requires an integer version and throws ConflictError on mismatch', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    expect(() => saveDailyReport(db, id, { fieldNotes: 'x' })).toThrow(ValidationError);
    expect(() => saveDailyReport(db, id, { version: 99, fieldNotes: 'x' })).toThrow(ConflictError);
  });
  it('moves the report to a free date, and throws DateTakenError moving onto a taken one', () => {
    const a = createDailyReport(db, 'p1', { reportDate: '2026-08-25' });
    createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    saveDailyReport(db, a.id, { version: 1, reportDate: '2026-08-27' });
    expect(getDailyReport(db, a.id).reportDate).toBe('2026-08-27');
    expect(() => saveDailyReport(db, a.id, { version: 2, reportDate: '2026-08-26' })).toThrow(DateTakenError);
  });
  it('throws NotFoundError for a missing id', () => {
    expect(() => saveDailyReport(db, 'nope', { version: 1 })).toThrow(NotFoundError);
  });
});

describe('listDailyReports', () => {
  it('lists newest date first with photoCount and parsed manCounts', () => {
    const a = createDailyReport(db, 'p1', { reportDate: '2026-08-24' });
    const b = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    saveDailyReport(db, a.id, { version: 1, manCounts: [{ type: 'Plasterer', count: 3 }] });
    addPhoto(db, a.id, 'f1'); addPhoto(db, a.id, 'f2');
    const list = listDailyReports(db, 'p1');
    expect(list.map((r: any) => r.reportDate)).toEqual(['2026-08-26', '2026-08-24']);
    expect(list[1].photoCount).toBe(2);
    expect(list[1].manCounts).toEqual([{ type: 'Plasterer', count: 3 }]);
    expect(list[0].photoCount).toBe(0);
    expect(listDailyReports(db, 'p2')).toEqual([]);
  });
});

describe('photos', () => {
  it('adds idempotently with increasing sortOrder, removes, never bumps version', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    addPhoto(db, id, 'f1'); addPhoto(db, id, 'f1'); addPhoto(db, id, 'f2');
    let row = getDailyReport(db, id);
    expect(row.photos.map((p: any) => p.fileId)).toEqual(['f1', 'f2']);
    expect(row.photos[1].sortOrder).toBeGreaterThan(row.photos[0].sortOrder);
    expect(row.version).toBe(1);
    removePhoto(db, id, 'f1');
    row = getDailyReport(db, id);
    expect(row.photos.map((p: any) => p.fileId)).toEqual(['f2']);
    expect(row.version).toBe(1);
  });
});

describe('deleteDailyReport', () => {
  it('deletes the row and its photo joins, and frees the date', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    addPhoto(db, id, 'f1');
    deleteDailyReport(db, id);
    expect(getDailyReport(db, id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM daily_report_photos WHERE dailyReportId = ?').get(id)).toEqual({ c: 0 });
    createDailyReport(db, 'p1', { reportDate: '2026-08-26' }); // date reusable
  });
  it('throws NotFoundError for a missing id', () => {
    expect(() => deleteDailyReport(db, 'nope')).toThrow(NotFoundError);
  });
});
```

- [ ] **Step 5: Run to verify failure**: `npx vitest run --project server dailyReportStore` → FAIL (module not found).

- [ ] **Step 6: Implement `server/dailyReportStore.ts`.** Model on `server/rfiStore.ts` (read it first) with these specifics:

```ts
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class DateTakenError extends Error {
  constructor(public existingId: string) { super('date_taken'); }
}

export interface ManCountLine { type: string; count: number; }
export interface DailyWeatherHour { hour: string; tempF: number | null; condition: string; }
export interface DailyReportInput {
  reportDate?: string; jobName?: string; contractorName?: string;
  weatherSummary?: string; temperature?: string; weatherHourly?: DailyWeatherHour[];
  manCounts?: ManCountLine[]; fieldNotes?: string; issues?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const parseArr = (s: string | null): any[] => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

function requireProject(db: Database.Database, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('Project not found');
}
function takenBy(db: Database.Database, projectId: string, reportDate: string, excludeId?: string): string | undefined {
  const row = db.prepare('SELECT id FROM daily_reports WHERE projectId = ? AND reportDate = ?').get(projectId, reportDate) as any;
  return row && row.id !== excludeId ? row.id : undefined;
}
```
`getDailyReport`: `SELECT *`, null if missing; parse `weatherHourly`/`manCounts` via `parseArr`; attach `photos` from `daily_report_photos WHERE dailyReportId = ? ORDER BY sortOrder` (`{ id, fileId, sortOrder }`).
`listDailyReports`: `SELECT * FROM daily_reports WHERE projectId = ? ORDER BY reportDate DESC`; per row parse `manCounts`, drop `weatherHourly`/`fieldNotes`/`issues` from the summary (keep scalars), add `photoCount` via `SELECT COUNT(*)`.
`createDailyReport`: `requireProject`; validate `DATE_RE.test(input.reportDate)` else ValidationError; `const existing = takenBy(...); if (existing) throw new DateTakenError(existing);` insert with `id: uuidv4()`, defaults `''`/`'[]'`, `createdAt/updatedAt = Date.now()`, `version 1`; return `{ id }`.
`saveDailyReport`: read row (NotFoundError); `if (!Number.isInteger(input.version)) throw new ValidationError('version required')`; `if (row.version !== input.version) throw new ConflictError('daily report was modified')`; if `input.reportDate` present validate format + `takenBy(db, row.projectId, input.reportDate, id)` → DateTakenError; UPDATE all provided fields (JSON.stringify the arrays), `version = version + 1`, `updatedAt = Date.now()`; return `{ version: row.version + 1 }`.
`addPhoto`/`removePhoto`: copy rfiStore's idempotent pattern (existing pair no-op; `sortOrder = MAX+1`; no version bump).
`deleteDailyReport`: NotFoundError if missing; delete photos join rows then the report row.

- [ ] **Step 7: Run to verify pass**: `npx vitest run --project server dailyReportStore migrationList` → all pass.

- [ ] **Step 8: Commit**

```bash
git add server/migrationList.ts server/migrationList.test.ts server/dailyReportStore.ts server/dailyReportStore.test.ts
git commit -m "feat(daily): migration 27 + daily report store (one per date, photos join table)"
```

---

### Task 2: Routes + change feed + email send + purge list

**Files:**
- Modify: `server/routes.ts` (CRUD block near the RFI block ~line 597; send route inside `registerEmailRoutes` near the RFI send ~line 1757; photo-purge array ~line 1163)
- Modify: `server/realtime/changeFeed.ts` (EntityType union)
- Modify: `src/hooks/useLiveQuery.ts` (client EntityType union — same literal)
- Test: `server/routes.dailyReports.test.ts` (new file; copy the harness/bootstrapping style of the existing routes tests — read the top of `server/routes.test.ts` first and reuse its app-construction helper pattern)

**Interfaces:**
- Consumes (Task 1): everything exported from `./dailyReportStore`.
- Produces (Tasks 4/5 rely on): REST endpoints exactly as below; broadcast events `type: 'dailyReport'`.

- [ ] **Step 1: Add `'dailyReport'`** to the `EntityType` union in `server/realtime/changeFeed.ts` AND `src/hooks/useLiveQuery.ts` (insert after `'rfi'` in both).

- [ ] **Step 2: Write failing route tests** — `server/routes.dailyReports.test.ts`. Follow the existing routes-test bootstrap (in-memory db, real migrations, express app via the exported route registrar with a stub `broadcastChange` you capture into an array, authenticated via the test-token helper the file's siblings use). Cover:
  - `GET /api/projects/:id/daily-reports` → `[]` then the created rows (date DESC, photoCount).
  - `POST /api/projects/:id/daily-reports` with `{ reportDate, jobName, contractorName }` → `{ id }`, and a broadcast `{ type: 'dailyReport', action: 'created', projectId, version: 1 }`.
  - duplicate date POST → `409` body `{ error: 'date_taken', existingId }`.
  - `GET /api/daily-reports/:id` → full row incl. `photos`; 404 for missing.
  - `PUT /api/daily-reports/:id` happy path (broadcast `action:'updated'` with the NEW version); stale version → `409 { error: ..., code: 'version_conflict' }`; date collision → `409 { error: 'date_taken', existingId }`.
  - `DELETE /api/daily-reports/:id` → broadcast `action:'deleted'` with NO version field.
  - `POST /api/daily-reports/:id/photos` `{ fileId }` and `DELETE /api/daily-reports/:id/photos/:fileId` → broadcasts `action:'updated'` with NO version field.

- [ ] **Step 3: Run to verify failure**: `npx vitest run --project server routes.dailyReports` → FAIL (404s).

- [ ] **Step 4: Implement the CRUD routes** in `server/routes.ts`, directly below the RFI block. Import from `./dailyReportStore` with aliased error names (the file already aliases RFI errors the same way). Error mapper:

```ts
const dailyErr = (e: unknown, res: express.Response) => {
  if (e instanceof DailyDateTakenError) return res.status(409).json({ error: 'date_taken', existingId: e.existingId });
  if (e instanceof DailyNotFoundError) return res.status(404).json({ error: e.message });
  if (e instanceof DailyConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
  if (e instanceof DailyValidationError) return res.status(400).json({ error: e.message });
  console.error('Daily report error:', e);
  return res.status(500).json({ error: 'Daily report operation failed' });
};
```

Routes (each wrapped in try/catch → `dailyErr`; copy the RFI block's structure verbatim, changing names):

```ts
app.get('/api/projects/:id/daily-reports', authenticateToken, ...);   // listDailyReports
app.post('/api/projects/:id/daily-reports', authenticateToken, ...);  // createDailyReport(db, id, req.body, (req as any).user?.username)
  // → logActivity({ type: 'daily_report_created', message: `Daily report ${req.body?.reportDate ?? ''} created` })
  // → broadcastChange({ type: 'dailyReport', id, projectId, version: 1, action: 'created', ...requestMeta(req) })
app.get('/api/daily-reports/:id', authenticateToken, ...);            // getDailyReport, 404 if null
app.put('/api/daily-reports/:id', authenticateToken, ...);            // saveDailyReport → broadcast action:'updated' with returned version
app.delete('/api/daily-reports/:id', authenticateToken, ...);         // read `before` first for projectId; broadcast action:'deleted', NO version
app.post('/api/daily-reports/:id/photos', authenticateToken, ...);    // addPhoto; broadcast action:'updated', NO version (photo ops don't bump version)
app.delete('/api/daily-reports/:id/photos/:fileId', authenticateToken, ...); // removePhoto; same broadcast shape
```

- [ ] **Step 5: Add `'daily_report_photos'`** to the photo-purge table array at routes.ts~1163 (`['issue_photos','punch_photos','task_photos','change_order_photos','rfi_photos']`).

- [ ] **Step 6: Add the send route** inside `registerEmailRoutes`, modeled verbatim on the RFI send route (no admin gate):

```ts
// Send a daily report PDF via SMTP (any authenticated user — field members file dailies)
app.post('/api/daily-reports/:id/send', authenticateToken, async (req, res) => {
  try {
    const report = getDailyReport(db, req.params.id);
    if (!report) return res.status(404).json({ error: 'Daily report not found' });
    const { to, fileId, message, cc, bcc, subject, body, attachmentFileIds } = req.body as SendBody;
    if (!to || !fileId) return res.status(400).json({ error: 'to and fileId are required' });
    await send((req as any).user.id, {
      to, cc, bcc,
      subject: subject?.trim() || `Daily Report — ${report.reportDate}${report.jobName ? ` — ${report.jobName}` : ''}`,
      text: body ?? message ?? 'Please find the attached daily report.',
      attachments: buildSendAttachments(db, { fileId, attachmentName: `DailyReport-${report.reportDate}.pdf` }, attachmentFileIds),
    });
    logActivity(db, { projectId: report.projectId, userId: (req as any).user?.id, type: 'daily_report_sent', message: `Daily report ${report.reportDate} emailed to ${to}` });
    res.json({ success: true });
  } catch (e: any) {
    console.error('Error sending daily report:', e);
    res.status(500).json({ error: e.message || 'Failed to send daily report' });
  }
});
```
(No broadcast needed — sending doesn't mutate the report row; there is no `sentAt` state for dailies.)

- [ ] **Step 7: Run to verify pass**: `npx vitest run --project server routes.dailyReports` then the full server project (`npx vitest run --project server`) to catch collateral. `npm run lint`.

- [ ] **Step 8: Commit**

```bash
git add server/routes.ts server/realtime/changeFeed.ts src/hooks/useLiveQuery.ts server/routes.dailyReports.test.ts
git commit -m "feat(daily): daily report routes, change-feed type, email send, purge-list entry"
```

---

### Task 3: Weather module + endpoint

**Files:**
- Create: `server/weather.ts`
- Modify: `server/routes.ts` (one GET route beside the daily-reports block)
- Test: `server/weather.test.ts` (+ extend `server/routes.dailyReports.test.ts` with 2 endpoint cases)

**Interfaces:**
- Produces:
```ts
export interface DailyWeatherResult { hourly: { hour: string; tempF: number | null; condition: string }[]; summary: string; temperature: string; }
export function conditionForCode(code: number | null | undefined): string
export function summarize(hourly: DailyWeatherResult['hourly']): { summary: string; temperature: string }
export async function geocodeAddress(address: string): Promise<{ lat: number; lon: number } | null>
export async function fetchDailyWeather(lat: number, lon: number, date: string): Promise<DailyWeatherResult>
```
- Endpoint (Task 5 consumes): `GET /api/projects/:id/daily-weather?date=YYYY-MM-DD` → `DailyWeatherResult`, or `400 { error: 'no_address' }` / `400 { error: 'bad_date' }` / `502 { error: 'weather_unavailable' }`.

- [ ] **Step 1: Write failing tests** — `server/weather.test.ts`. Mock the network with `vi.stubGlobal('fetch', vi.fn())` (restore in `afterEach` via `vi.unstubAllGlobals()`):
  - `conditionForCode`: `0 → 'Clear'`, `2 → 'Partly cloudy'`, `63 → 'Rain'`, `95 → 'Thunderstorm'`, `undefined/unknown → '—'`.
  - `summarize`: dominant condition wins (`[Clear, Clear, Rain] → 'Clear'`); temperature is `'58–74°F'` from min/max rounding; all-null temps → `temperature: ''`; empty array → `{ summary: '', temperature: '' }`.
  - `geocodeAddress`: returns `{lat, lon}` parsed from a mocked Nominatim array response; sends a `User-Agent` header (assert on the mock's call args); returns null on `[]` and on `!res.ok`; second call for the same address does NOT hit fetch again (in-memory cache).
  - `fetchDailyWeather`: mocked Open-Meteo payload `{ hourly: { time: [...], temperature_2m: [...], weather_code: [...] } }` → returns only the 6 AM–6 PM rows, hour labels `'6 AM' … '6 PM'`, rounded temps; picks the ARCHIVE host (`archive-api.open-meteo.com`) for a date ≥ 8 days ago and the FORECAST host (`api.open-meteo.com`) for a recent date (assert on the mocked URL); tolerates the legacy `weathercode` key.
  - Endpoint tests (in routes.dailyReports.test.ts): project without address → `400 no_address`; missing/malformed `date` → `400 bad_date`. (Do not test the live-fetch path at the route level — the module tests cover it; stub `weather.ts` exports if the route test imports would otherwise hit the network.)

- [ ] **Step 2: Run to verify failure**: `npx vitest run --project server weather` → FAIL.

- [ ] **Step 3: Implement `server/weather.ts`**:

```ts
// Daily observed weather for daily reports. Server-side so plain-LAN clients
// need no internet. Free/no-key providers: OSM Nominatim (geocode, usage
// policy requires a UA header) + Open-Meteo (hourly observed temps/conditions).
const geocodeCache = new Map<string, { lat: number; lon: number } | null>();

const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
  56: 'Frz drizzle', 57: 'Frz drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Frz rain', 67: 'Frz rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};
export const conditionForCode = (code: number | null | undefined): string =>
  code == null ? '—' : (WMO[code] ?? '—');
```
`summarize(hourly)`: count conditions (ignore `'—'`), pick the most frequent (ties: first seen); temps = non-null `tempF`s → `` `${Math.min(…)}–${Math.max(…)}°F` `` or `''`.
`geocodeAddress`: cache check (cache nulls too); `fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(address), { headers: { 'User-Agent': 'Frugal-Takeoff/2.7 (daily-report weather)' }, signal: AbortSignal.timeout(10_000) })`; on `!res.ok` or empty array → cache+return null; else `{ lat: Number(row.lat), lon: Number(row.lon) }`.
`fetchDailyWeather(lat, lon, date)`: `daysAgo = Math.floor((Date.now() - new Date(date + 'T12:00:00').getTime()) / 86_400_000)`; host = `daysAgo >= 8 ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast'`; query `?latitude=&longitude=&hourly=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto&start_date=${date}&end_date=${date}` (+ `&past_days=7` only on the forecast host, harmless and covers timezone edges); `AbortSignal.timeout(15_000)`; throw on `!res.ok`. Parse: `const codes = data.hourly.weather_code ?? data.hourly.weathercode ?? []`; for indices where `data.hourly.time[i]` ends in `T06:00`…`T18:00` **and starts with `date`**, push `{ hour: hourLabel(h), tempF: t == null ? null : Math.round(t), condition: conditionForCode(codes[i]) }` (`hourLabel`: 6→'6 AM', 12→'12 PM', 13→'1 PM', 18→'6 PM'). Return `{ hourly, ...summarize(hourly) }`.

- [ ] **Step 4: Add the route** in `server/routes.ts` (beside the daily-reports block):

```ts
app.get('/api/projects/:id/daily-weather', authenticateToken, async (req, res) => {
  const date = String(req.query.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad_date' });
  const row = db.prepare('SELECT address FROM projects WHERE id = ?').get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'Project not found' });
  if (!row.address) return res.status(400).json({ error: 'no_address' });
  try {
    const geo = await geocodeAddress(row.address);
    if (!geo) return res.status(502).json({ error: 'weather_unavailable' });
    res.json(await fetchDailyWeather(geo.lat, geo.lon, date));
  } catch (e) {
    console.error('Daily weather fetch failed:', e);
    res.status(502).json({ error: 'weather_unavailable' });
  }
});
```

- [ ] **Step 5: Run to verify pass**: `npx vitest run --project server weather routes.dailyReports` → pass; `npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add server/weather.ts server/weather.test.ts server/routes.ts server/routes.dailyReports.test.ts
git commit -m "feat(daily): observed-weather endpoint (Nominatim geocode + Open-Meteo hourly)"
```

---

### Task 4: Client store helpers + list page + nav wiring

**Files:**
- Modify: `src/utils/store.ts` (types + helpers, placed after the RFI section)
- Modify: `src/App.tsx` (child route), `src/components/shell/Sidebar.tsx` (PROJECT_NAV), `src/components/CommandPalette.tsx` (PROJECT_NAV + two ⌘K actions)
- Create: `src/pages/project/ProjectDailyReports.tsx`
- Test: `src/pages/project/ProjectDailyReports.test.tsx`

**Interfaces:**
- Consumes: Task 2 endpoints; `useLiveQuery`; `EditingChip`; `useProjectOutlet()` from ProjectLayout; `useConfirm()`.
- Produces (Task 5 consumes): store helpers below; page exports pure helpers `manCountTotal`, `formatReportDate`; the page renders `DailyReportEditor` (Task 5) keyed `${editing.id}:${editing.version}` with props `{ report, projectId, projectName, contractor, onClose, onSaved }`.

- [ ] **Step 1: Add store types + helpers** to `src/utils/store.ts`, mirroring the RFI section exactly (same `rfiJson`-style wrapper — reuse or clone as `dailyJson`):

```ts
export interface DailyReportPhoto { id: string; fileId: string; sortOrder: number; }
export interface ManCountLine { type: string; count: number; }
export interface DailyWeatherHour { hour: string; tempF: number | null; condition: string; }
export interface DailyReport {
  id: string; projectId: string; reportDate: string; jobName: string; contractorName: string;
  weatherSummary: string; temperature: string; weatherHourly: DailyWeatherHour[];
  manCounts: ManCountLine[]; fieldNotes: string; issues: string;
  createdBy: string | null; createdAt: number; updatedAt: number; version: number;
  photos: DailyReportPhoto[];
}
export interface DailyReportListItem {
  id: string; projectId: string; reportDate: string; jobName: string; contractorName: string;
  weatherSummary: string; temperature: string; manCounts: ManCountLine[];
  createdBy: string | null; createdAt: number; updatedAt: number; version: number; photoCount: number;
}
export class DateTakenError extends Error { constructor(public existingId: string) { super('date taken'); this.name = 'DateTakenError'; } }

export const getDailyReports = async (projectId: string): Promise<DailyReportListItem[]>
export const getDailyReport = async (id: string): Promise<DailyReport>
export const createDailyReport = async (projectId: string, input: { reportDate: string; jobName?: string; contractorName?: string }): Promise<{ id: string }>
  // 409 → parse body: error==='date_taken' → throw DateTakenError(body.existingId); else ConflictError
export const saveDailyReport = async (id: string, report: Partial<DailyReport> & { version: number }): Promise<{ version: number }>
  // 409 → same body-discriminated throw as createDailyReport
export const deleteDailyReport = async (id: string): Promise<void>
export const addDailyReportPhoto = async (id: string, fileId: string): Promise<void>
export const removeDailyReportPhoto = async (id: string, fileId: string): Promise<void>
export const sendDailyReport = async (id: string, payload: { to: string; cc?: string; bcc?: string; subject?: string; body?: string; fileId: string; attachmentFileIds?: string[] }): Promise<void>
export const getDailyWeather = async (projectId: string, date: string): Promise<{ hourly: DailyWeatherHour[]; summary: string; temperature: string }>
  // 400 no_address → throw new Error('no_address'); other non-OK → throw new Error('weather_unavailable')
```
Implement each like its RFI twin (`fetchWithRetry`, `getAuthHeaders()`, `handleResponse`). For the 409-discriminating helpers: `if (res.status === 409) { const b = await res.json().catch(() => ({} as any)); if (b?.error === 'date_taken' && b.existingId) throw new DateTakenError(b.existingId); throw new ConflictError(id); }`.

- [ ] **Step 2: Write failing pure-helper tests** — `src/pages/project/ProjectDailyReports.test.tsx` (repo convention: pure helpers only):

```tsx
import { describe, it, expect } from 'vitest';
import { manCountTotal, formatReportDate } from './ProjectDailyReports';

describe('manCountTotal', () => {
  it('sums counts', () => { expect(manCountTotal([{ type: 'Plasterer', count: 4 }, { type: 'Supervisor', count: 1 }])).toBe(5); });
  it('ignores non-finite/negative counts and empty lists', () => {
    expect(manCountTotal([])).toBe(0);
    expect(manCountTotal([{ type: 'x', count: NaN as any }, { type: 'y', count: -2 }, { type: 'z', count: 3 }])).toBe(3);
  });
});
describe('formatReportDate', () => {
  it('renders YYYY-MM-DD as a readable local date without timezone drift', () => {
    expect(formatReportDate('2026-08-26')).toBe('Aug 26, 2026');   // must NOT show Aug 25 in negative-offset timezones
  });
  it('falls back to the raw string when malformed', () => { expect(formatReportDate('garbage')).toBe('garbage'); });
});
```

- [ ] **Step 3: Run to verify failure**: `npx vitest run --project ui ProjectDailyReports` → FAIL.

- [ ] **Step 4: Implement `src/pages/project/ProjectDailyReports.tsx`.** Clone `ProjectRfis.tsx`'s structure (read it first); differences:
  - Exported pure helpers:
    ```ts
    export const manCountTotal = (lines: ManCountLine[]): number =>
      lines.reduce((s, l) => s + (Number.isFinite(l.count) && l.count > 0 ? l.count : 0), 0);
    export const formatReportDate = (d: string): string => {
      const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return d;
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
        .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };
    ```
  - `useLiveQuery(load, { types: ['dailyReport'], projectId })`.
  - "New report" flow (replaces RFI's title quick-create): a date input defaulting to today (`new Date().toLocaleDateString('en-CA')` gives local YYYY-MM-DD — do NOT use `toISOString`, it drifts a day in negative offsets) + "New report" button. On submit: `createDailyReport(projectId, { reportDate, jobName: summary?.name ?? '', contractorName: summary?.contractor ?? '' })` then open the editor with `getDailyReport(id)`. Catch `DateTakenError` → open the existing report (`getDailyReport(e.existingId)`) instead — that IS the create-on-taken-date-opens-it rule; no error toast.
    (Prefill source: the project summary from `useProjectOutlet()`; if it lacks `contractor`, fetch `getProject(projectId)` once for it, falling back to `settings.companyName` — load settings lazily only if needed.)
  - `?new=1` handling identical to ProjectRfis (focus the date input, strip the param).
  - Table columns: Date (`formatReportDate`, + `EditingChip type="dailyReport" id={r.id}`), Crew (`manCountTotal(r.manCounts)` + " men", em-dash when 0), Weather (`r.weatherSummary` + `r.temperature` joined, truncated), Photos (count), delete (confirm + `deleteDailyReport`).
  - Editor rendering, keyed like RFIs: `{editing && <DailyReportEditor key={`${editing.id}:${editing.version}`} report={editing} projectId={projectId} projectName={summary?.name ?? ''} contractor={summary?.contractor} onClose={() => setEditing(null)} onSaved={() => { load(); openReport(editing.id); }} />}` — `openReport(id)` refetches and re-seats `editing`.
  - Until Task 5 lands, import `DailyReportEditor` from `./daily/DailyReportEditor` and create that file as a minimal placeholder modal (title + Close button) so this task compiles and is reviewable on its own; Task 5 replaces it.
- [ ] **Step 5: Wire navigation** (all three spots):
  - `src/App.tsx`: `{ path: 'daily-reports', element: <ProjectDailyReports /> }` after `rfis` + import.
  - `src/components/shell/Sidebar.tsx` PROJECT_NAV, after the RFIs entry: `{ id: 'daily-reports', label: 'Daily Reports', Icon: CalendarDays, path: '/daily-reports', match: (p, b) => p.startsWith(`${b}/daily-reports`) }` (import `CalendarDays` from lucide-react; no `adminOnly`).
  - `src/components/CommandPalette.tsx`: same PROJECT_NAV entry; plus actions `{ id: 'ctx:new-daily-report', title: 'New daily report', run: () => navigate(`/project/${projectId}/daily-reports?new=1`) }` and `{ id: 'ctx:daily-reports', title: 'Daily Reports', run: () => navigate(`/project/${projectId}/daily-reports`) }`, icons `CalendarDays`, `subtitle: 'Project'`, matching the existing action-object shape exactly.

- [ ] **Step 6: Run to verify pass**: `npx vitest run --project ui ProjectDailyReports` → pass; `npm run lint` clean; `npx vitest run` (both projects) green.

- [ ] **Step 7: Commit**

```bash
git add src/utils/store.ts src/App.tsx src/components/shell/Sidebar.tsx src/components/CommandPalette.tsx src/pages/project/ProjectDailyReports.tsx src/pages/project/ProjectDailyReports.test.tsx src/pages/project/daily/DailyReportEditor.tsx
git commit -m "feat(daily): client API, Daily Reports tab + list page, nav + palette wiring"
```

---

### Task 5: Editor modal

**Files:**
- Replace: `src/pages/project/daily/DailyReportEditor.tsx` (the Task-4 placeholder)
- Create: `src/pages/project/daily/dailyReportForm.ts` (pure form helpers, testable)
- Test: `src/pages/project/daily/dailyReportForm.test.ts`

**Interfaces:**
- Consumes: Task 4 store helpers; `useCollabEditing` + `EditPresenceBanner`; `uploadProjectFile`, `getImageUrl`, `fetchFileBlob`; `getDailyWeather`; UI kit components used by RfiEditor (read RfiEditor.tsx and reuse the same `Field`/`Input`/`Textarea`/`Button`/modal wrappers).
- Produces (Task 6 consumes): the editor exposes internal `buildPdfBytes` wiring points — specifically state getters for a complete `DailyReport`-shaped object — and a `Download PDF` + `Send` button pair whose handlers Task 6 fills in (Task 5 stubs them with a disabled state and `// wired in the PDF task` comment).

Props (fixed by Task 4): `{ report: DailyReport; projectId: string; projectName: string; contractor?: string | null; onClose: () => void; onSaved: () => void; }`

- [ ] **Step 1: Write failing pure-helper tests** — `src/pages/project/daily/dailyReportForm.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeManCounts, manCountLabel, weatherLine } from './dailyReportForm';

describe('normalizeManCounts', () => {
  it('drops empty-type lines and clamps counts to non-negative integers', () => {
    expect(normalizeManCounts([
      { type: ' Plasterer ', count: 4.7 }, { type: '', count: 3 }, { type: 'Sup', count: -1 },
    ])).toEqual([{ type: 'Plasterer', count: 4 }, { type: 'Sup', count: 0 }]);
  });
  it('keeps zero-count typed lines (a named crew with 0 men is meaningful)', () => {
    expect(normalizeManCounts([{ type: 'Laborer', count: 0 }])).toEqual([{ type: 'Laborer', count: 0 }]);
  });
});
describe('manCountLabel', () => {
  it('pluralizes', () => {
    expect(manCountLabel({ type: 'Plasterer', count: 4 })).toBe('Plasterer — 4 men');
    expect(manCountLabel({ type: 'Supervisor', count: 1 })).toBe('Supervisor — 1 man');
  });
});
describe('weatherLine', () => {
  it('joins summary and temperature, omitting empties', () => {
    expect(weatherLine('Partly cloudy', '58–74°F')).toBe('Partly cloudy · 58–74°F');
    expect(weatherLine('', '58–74°F')).toBe('58–74°F');
    expect(weatherLine('', '')).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure**: `npx vitest run --project ui dailyReportForm` → FAIL.

- [ ] **Step 3: Implement `dailyReportForm.ts`**:

```ts
import type { ManCountLine } from '../../../utils/store';

export const normalizeManCounts = (lines: ManCountLine[]): ManCountLine[] =>
  lines
    .map(l => ({ type: l.type.trim(), count: Number.isFinite(l.count) ? Math.max(0, Math.floor(l.count)) : 0 }))
    .filter(l => l.type !== '');
export const manCountLabel = (l: ManCountLine): string => `${l.type} — ${l.count} ${l.count === 1 ? 'man' : 'men'}`;
export const weatherLine = (summary: string, temperature: string): string =>
  [summary, temperature].filter(Boolean).join(' · ');
```

- [ ] **Step 4: Run to verify pass**: `npx vitest run --project ui dailyReportForm` → PASS.

- [ ] **Step 5: Implement the editor modal**, cloning RfiEditor.tsx's skeleton (modal chrome, header with close, footer with Save; read it fully first). Specifics:
  - **State**: `reportDate, jobName, contractorName, weatherSummary, temperature, weatherHourly, manCounts (ManCountLine[]), fieldNotes, issues` seeded from `props.report`; `isDirty()` compares each against the prop (manCounts/weatherHourly via `JSON.stringify`).
  - **Collab**: `const collab = useCollabEditing({ type: 'dailyReport', id: report.id, isDirty, onFresh: onSaved });` + `<EditPresenceBanner state={collab} />` at the top of the modal body.
  - **Section 1 — prefilled fields**: Job name (Input), Contractor (Input), Date (`<input type="date">`). No fetching here — values came in on the report row (create-time prefill is Task 4's job).
  - **Section 2 — weather**: "Fetch weather" button (label "Refresh weather" when `weatherHourly.length > 0`) → `getDailyWeather(projectId, reportDate)` → set `weatherHourly/weatherSummary/temperature` (marks dirty). Error `'no_address'` → inline muted text "Add a project address to auto-fill weather."; `'weather_unavailable'` → toast, fields stay manual. Auto-fetch once on mount ONLY when `report.weatherHourly.length === 0 && report.version === 1` (fresh report) — never clobber saved data. Hourly strip renders as a horizontal scroll row of small cells (hour / temp° / condition, text-xs); below it, editable `Weather` (Input, value `weatherSummary`) and `Temperature` (Input) fields.
  - **Section 3+4 — split**: `grid grid-cols-1 md:grid-cols-2 gap-4`. Left: "Man count" — one row per line (`Input` type text w/ placeholder "Trade / role" + `Input` type number min 0 + remove ×), "Add line" button appends `{ type: '', count: 1 }`; footer line `Total: {manCountTotal(normalizeManCounts(manCounts))} men` (import `manCountTotal` from `../ProjectDailyReports`). Right: "Field notes" Textarea (min-h ~10 rows).
  - **Section 5 — issues**: full-width Textarea below the grid.
  - **Photos**: copy RfiEditor's `handlePhotos` verbatim-with-renames — `isDirty()` save-first guard, `uploadProjectFile(projectId, f, 'daily-report-photo', { sourceType: 'dailyReport', sourceId: report.id })` → `addDailyReportPhoto(report.id, fileId)` → `onSaved()`; same `<input type="file" accept="image/*" capture="environment" multiple>`, same thumbnail grid + delete via `removeDailyReportPhoto`.
  - **Save**: `saveDailyReport(report.id, { version: collab.keepMineVersion ?? report.version, reportDate, jobName: jobName.trim(), contractorName: contractorName.trim(), weatherSummary, temperature, weatherHourly, manCounts: normalizeManCounts(manCounts), fieldNotes, issues })` → `toast('Saved')`, `onSaved()`. Catch: `DateTakenError` → inline message under the date field "A report for this date already exists." (no toast, keep editing); client `ConflictError` → toast "Report changed elsewhere — reopen it".
  - **Footer**: Save (primary) + "Download PDF" and "Send…" buttons rendered but disabled with title "Coming in this feature's PDF step" (Task 6 enables).
- [ ] **Step 6: Full-suite check**: `npx vitest run` green, `npm run lint` clean.

- [ ] **Step 7: Commit**

```bash
git add src/pages/project/daily/DailyReportEditor.tsx src/pages/project/daily/dailyReportForm.ts src/pages/project/daily/dailyReportForm.test.ts
git commit -m "feat(daily): daily report editor (weather fetch, man-count lines, notes/issues, photos)"
```

---

### Task 6: PDF + download + email send wiring

**Files:**
- Create: `src/pages/project/daily/dailyReportPdf.ts`
- Modify: `src/pages/project/daily/DailyReportEditor.tsx` (enable Download/Send)
- Test: `src/pages/project/daily/dailyReportPdf.test.ts`

**Interfaces:**
- Consumes: `drawLetterheadHeader`, `drawLetterheadFooter`, `hexToRgb`, `LetterheadContext` from `src/utils/documentLetterhead.ts`; jsPDF; `weatherLine`/`manCountLabel` from `./dailyReportForm`; `EmailComposer` (props interface in reference — clone RfiEditor's invocation); `persistGeneratedDocument`, `uploadProjectFile`, `fetchFileBlob`, `sendDailyReport`, `getSettings` etc. from store.ts; `resolveRecipient` from `src/utils/recipients.ts`.
- Produces:
```ts
export const dailyReportHeading = (r: { reportDate: string; jobName: string }): string
export const dailyReportFileName = (r: { reportDate: string }): string   // `DailyReport-${reportDate}.pdf`
export function buildDailyReportPdf(ctx: {
  report: DailyReport; projectName: string;
  photoDataUrls: string[];
  letterhead: LetterheadContext; headerEmail?: string;
}): ArrayBuffer
```

- [ ] **Step 1: Write failing pure-helper tests** — `src/pages/project/daily/dailyReportPdf.test.ts` (repo convention — pure helpers only, no jsPDF):

```ts
import { describe, it, expect } from 'vitest';
import { dailyReportHeading, dailyReportFileName } from './dailyReportPdf';

describe('dailyReportHeading', () => {
  it('joins title and date', () => {
    expect(dailyReportHeading({ reportDate: '2026-08-26', jobName: 'Dania Beach' })).toBe('Daily Report — Aug 26, 2026 · Dania Beach');
  });
  it('omits a blank job name', () => {
    expect(dailyReportHeading({ reportDate: '2026-08-26', jobName: '' })).toBe('Daily Report — Aug 26, 2026');
  });
});
describe('dailyReportFileName', () => {
  it('names by date', () => { expect(dailyReportFileName({ reportDate: '2026-08-26' })).toBe('DailyReport-2026-08-26.pdf'); });
});
```
(`dailyReportHeading` reuses `formatReportDate` — import it from `../ProjectDailyReports`.)

- [ ] **Step 2: Run to verify failure**, then **Step 3: implement `dailyReportPdf.ts`.** Structure copied from `rfiPdf.ts` (jsPDF portrait/pt/letter; `top`/`bottom`/`newPage()`/`paragraph()`/`sectionLabel()` helpers exactly as the reference shows). Content order:
  1. Title: `dailyReportHeading(report)` (bold, 16pt), thin brand-color rule under it.
  2. **Fields block**: three label/value rows — `Job name:`, `Contractor:`, `Date:` (`formatReportDate`), 11pt, label in gray.
  3. **Weather**: `sectionLabel('Weather')`; `weatherLine(report.weatherSummary, report.temperature)` as a paragraph; if `weatherHourly.length`, a strip: for each hour a fixed-width cell (`(W - 2*M) / hourly.length`, min 36pt — if narrower than 36pt, render only every 2nd hour) drawing three centered lines (hour 7pt gray / `${tempF}°` 9pt bold / condition 6pt, truncated with `doc.splitTextToSize(...)[0]`). Bottom-check the whole strip height (~34pt) once before drawing; page-break first if needed.
  4. **Man count | Field notes, two columns**: `colW = (W - 2*M - 24) / 2`. Track `yL`/`yR` from the same start Y. Left: `Man count` label; one line per `manCountLabel(line)` (12pt leading); then `Total: N men` bold. Right: `Field notes` label; wrapped lines via `doc.splitTextToSize(fieldNotes, colW)`. **Overflow rule:** render each column only while `y < bottom`; collect UNRENDERED remainder lines of each column into a `continued: { label: string; lines: string[] }[]` queue. After the columns, set `y = max(yL, yR) + 16`.
  5. **Issues**: `sectionLabel('Issues')` + wrapped paragraph, same continuation collection if the page runs out mid-section (the shared `paragraph` helper already page-breaks inline — for issues, inline page-breaking IS the continuation: prefix the post-break page with `Issues (continued)` via a `newPage` wrapper that remembers the current section label).
  6. **Continuation pages**: after issues, for each queued `continued` entry: `newPage()` if `y` near bottom else continue on the current page — heading `` `${label} (continued)` `` + its lines (full width, inline page-breaking allowed).
  7. **Photos**: exactly rfiPdf's 2-per-row grid (`cellH = 150`, `'FAST'`, try/catch per image).
  Return `doc.output('arraybuffer')`.
  Implementation note: make `paragraph`/`sectionLabel` accept-and-restore font state as rfiPdf does; keep every layout constant local (this module owns its own flow, per repo pattern).
- [ ] **Step 4: Wire the editor.** Clone RfiEditor's `buildRfiBytes`/`handleDownload`/`EmailComposer` block with renames:
  - `buildBytes(headerEmail?)`: `getSettings()` → letterhead `{ brandRgb: hexToRgb(settings.companyBrandColor || '#99CB38'), company: { name: settings.companyName || settings.appName, phone: settings.companyPhone, email: headerEmail ?? settings.companyEmail, address: settings.companyAddress }, logoDataUrl }` (logo resolution + `invertImageDataUrl` handling copied from RfiEditor lines 136-171); photos via `fetchFileBlob` → dataURLs; `buildDailyReportPdf({...})`.
  - `handleDownload`: bytes → Blob → `persistGeneratedDocument(blob, { projectId, kind: 'daily-report', name: dailyReportFileName(report), sourceType: 'dailyReport', sourceId: report.id })` best-effort → `<a download>` click.
  - Send: `EmailComposer` with `title="Send daily report"`, `primaryAttachmentName={dailyReportFileName(report)}`, `defaultSubject={`Daily Report — ${formatReportDate(report.reportDate)} — ${projectName}`}`, `defaultBody` short cover note, defaults via the same `resolveRecipient('dailyReport', …)` pattern RfiEditor uses (pass `'issue'`-style role key: check `src/utils/recipients.ts` for the accepted keys and use the closest existing one — if it takes arbitrary strings add `'dailyReport'`; if a fixed union, use the general/fallback role and note it in the report). `onSend`: build bytes with chosen headerEmail → `File` → `uploadProjectFile(projectId, file, 'daily-report', { sourceType: 'dailyReport', sourceId: report.id })` → `sendDailyReport(report.id, { …, fileId })` → toast + `onSaved()`. Both buttons keep the `isDirty()` save-first guard.
- [ ] **Step 5: Verify**: `npx vitest run` (both projects) green; `npm run lint` clean; `npm run build` succeeds (jsPDF import path sanity).

- [ ] **Step 6: Commit**

```bash
git add src/pages/project/daily/dailyReportPdf.ts src/pages/project/daily/dailyReportPdf.test.ts src/pages/project/daily/DailyReportEditor.tsx
git commit -m "feat(daily): letterhead PDF with overflow continuation, download + email send"
```

---

### Task 7: Changelog + spec checklist tick

**Files:**
- Modify: `src/pages/Settings.tsx` (CHANGELOG array)

- [ ] **Step 1**: Add a `2.7.1` entry dated today at the TOP of `CHANGELOG` in `src/pages/Settings.tsx`:

```ts
{
  version: '2.7.1',
  date: 'August 26, 2026',
  changes: [
    'New: Daily Reports tab on every project — one report per work day with crew man-counts, field notes, and issues; weather auto-fills with the actual hourly conditions for the day when the project has an address (editable). Reports print/email on the company letterhead with photos attached, and long sections continue cleanly onto a second page.',
  ],
},
```
- [ ] **Step 2**: `npm run lint` clean. Commit:

```bash
git add src/pages/Settings.tsx
git commit -m "docs: changelog v2.7.1 (daily reports)"
```

---

## Self-Review (done at authoring)

- **Spec coverage**: §2 data model → Task 1; §3 server/routes/weather/send → Tasks 2–3; §4 tab/list/editor/palette → Tasks 4–5; §5 PDF/documents-registration/email → Task 6; §6 testing → embedded per task; changelog → Task 7. Presence label (§4) needs zero code (locationInfo's generic regex covers `/project/:id/daily-reports`) — no task needed, verified in reference §9.
- **Placeholder scan**: Task 5 Step 5 and Task 6 Steps 3–4 reference RfiEditor/rfiPdf as the pattern source with the deltas spelled out — the referenced code is in-repo, readable by the implementer, and the reference file paths + line ranges are given; no TBDs remain.
- **Type consistency**: `ManCountLine`/`DailyWeatherHour` defined server-side (Task 1) and client-side (Task 4) with identical shapes; `DateTakenError.existingId` consistent across store/server/client; editor props fixed in Task 4 and consumed verbatim in Task 5; `manCountTotal`/`formatReportDate` exported in Task 4, imported in Tasks 5–6.
