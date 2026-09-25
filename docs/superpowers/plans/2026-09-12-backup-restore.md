# Backup and Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-managed, incremental, self-contained backups (local root + Google Drive) with a fresh-install restore screen that can rebuild a lost server.

**Architecture:** A content-addressed store (`objects/<sha256>` + `snapshots/<id>/{app.db,mail.key,manifest.json}`) behind a `BackupTarget`/`BackupSource` interface with two implementations (`LocalStore`, `DriveStore`). `takeSnapshot` copies the DB via SQLite's online backup API and uploads only hashes the target lacks; `restoreSnapshot` verifies every object into a fresh data dir and exits the process so the container restarts. Admin routes drive a Settings → Backup tab; unauthenticated-but-fresh-only setup routes drive `/restore`.

**Tech Stack:** TypeScript, Express, better-sqlite3 (`db.backup()`), Node `crypto`/`fs` streams, `archiver` (zip write), `yauzl` (zip read), raw `fetch` against Google Drive API v3, React + Tailwind, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-12-backup-restore-design.md`

## Global Constraints

- Backup root = `process.env.BACKUP_PATH`, else `<DATA_DIR>/backup-store` (and the tab warns "Backups are on the same disk as the data. Set BACKUP_PATH to a different volume.").
- Layout: `objects/<sha256>`, `snapshots/<YYYYMMDD-HHMMSS>/app.db`, `.../mail.key`, `.../manifest.json` (`manifest.json` is written LAST; a snapshot folder without one is ignored).
- Manifest `format: 1`; fields exactly: `createdAt, appVersion, schemaVersion, db {size, sha256}, mailKey {sha256} | {source:'env'}, files [{id, sha256, size}], counts {files, bytes}, warnings []`.
- Excluded: `<DATA_DIR>/tmp/**`, `<DATA_DIR>/backups/**`, `migration-manifest.json`, legacy `*_migrated*`.
- Settings keys `backup.*` are PRIVATE (add `'backup.'` to `SETTINGS_PRIVATE_PREFIXES` in `server.ts`). `backup.drive` is sealed with the mail crypto.
- Only one run per target at a time → 409 `{ code: 'backup_running' }`.
- Restore only while fresh (exactly one user, id `admin-id-123`, zero `projects`, zero `files`) → otherwise 409 `{ code: 'not_fresh' }`; restore routes also require a valid session whose `user.id === 'admin-id-123'`.
- Restore refuses a manifest with unknown `format` or `schemaVersion` greater than the server's latest migration (400).
- Restore writes every object (hash-verified) BEFORE touching the DB; then `mail.key`, then `app.db.restored` → responds `{ restarting: true }` → close db → rename → `exit(0)` (injectable).
- Drive scope: `https://www.googleapis.com/auth/drive.file` only; separate OAuth state `typ` `'backup_drive_state'`; root folder name `Frugal Takeoff Backups`.
- Client code never uses `crypto.randomUUID` or other secure-context-only APIs (use the `uuid` package).
- All backup admin routes: `authenticateToken, requireAdmin`. Errors logged with `[backup]` prefix.
- Run `npm run lint` (tsc) and the task's tests before every commit. Commit per task; never push. Commit messages end with:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01WF6n61LSmqp33JfxDs7oom`.

---

## File map

| File | Responsibility |
|---|---|
| `server/backup/types.ts` | `Manifest`, `ManifestFile`, `BackupTarget`, `BackupSource`, `SnapshotSummary` |
| `server/backup/store.ts` | `LocalStore` (filesystem layout) |
| `server/backup/snapshot.ts` | `takeSnapshot` + `backup_runs` bookkeeping + prune |
| `server/backup/zip.ts` | `streamSnapshotZip`, `unpackSnapshotZip` |
| `server/backup/restore.ts` | `restoreSnapshot` + `isFreshInstall` |
| `server/backup/settings.ts` | typed `backup.*` settings access |
| `server/backup/drive.ts` | `DriveStore` + `driveAuthUrl`/`driveExchange` |
| `server/backup/scheduler.ts` | `BackupScheduler` |
| `server/backup/routes.ts` | `registerBackupRoutes` (admin + setup routes) |
| `server/migrationList.ts` | migration 36 |
| `server.ts` | wiring: `BACKUP_PATH`, deps, parser bypass, scheduler start, private prefix |
| `src/utils/store.ts` | client helpers + types |
| `src/pages/settings/BackupTab.tsx` | admin tab |
| `src/pages/RestorePage.tsx` | fresh-install restore |
| `src/pages/Login.tsx`, `src/App.tsx`, `src/pages/Settings.tsx` | link, route, tab |
| `scripts/build-e2e-snapshot.ts`, `e2e/backup-restore.spec.ts` | fixture + e2e |

---

### Task 1: Dependencies, migration 36, private settings prefix, shared types

**Files:**
- Modify: `package.json` (deps), `server/migrationList.ts` (append), `server.ts:~470` (`SETTINGS_PRIVATE_PREFIXES`)
- Create: `server/backup/types.ts`
- Test: `server/migrationList.test.ts`, `server/routes.test.ts` (settings privacy — the settings routes live in `server.ts`, so test the prefix list by exporting it: see Step 3)

**Interfaces (produces):**

```ts
// server/backup/types.ts
export interface ManifestFile { id: string; sha256: string; size: number }
export interface Manifest {
  format: 1;
  createdAt: number;
  appVersion: string;
  schemaVersion: number;
  db: { size: number; sha256: string };
  mailKey: { sha256: string } | { source: 'env' };
  files: ManifestFile[];
  counts: { files: number; bytes: number };
  warnings: string[];
}
export interface SnapshotSummary { id: string; createdAt: number; appVersion: string; schemaVersion: number; counts: Manifest['counts']; warnings: number }
/** Where a snapshot is written. Both implementations must write manifest.json LAST. */
export interface BackupTarget {
  readonly kind: 'local' | 'drive';
  /** Called once per run; returns the set of sha256 already stored. */
  listObjects(): Promise<Set<string>>;
  putObject(sha256: string, source: () => NodeJS.ReadableStream, size: number): Promise<void>;
  writeSnapshot(id: string, files: { dbPath: string; mailKeyPath: string | null; manifest: Manifest }): Promise<void>;
  listSnapshots(): Promise<SnapshotSummary[]>;
  readManifest(id: string): Promise<Manifest>;
  deleteSnapshot(id: string): Promise<void>;
  deleteObject(sha256: string): Promise<void>;
}
/** Where a restore reads from. LocalStore and DriveStore implement both. */
export interface BackupSource {
  listSnapshots(): Promise<SnapshotSummary[]>;
  readManifest(id: string): Promise<Manifest>;
  openObject(sha256: string): Promise<NodeJS.ReadableStream>;
  openSnapshotFile(id: string, name: 'app.db' | 'mail.key'): Promise<NodeJS.ReadableStream>;
}
export const snapshotIdNow = (d = new Date()): string =>
  d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // YYYYMMDD-HHMMSS
export const isSnapshotId = (s: string): boolean => /^\d{8}-\d{6}$/.test(s);
```

- [ ] **Step 1: Add dependencies**

```bash
npm install archiver@^7 yauzl@^3 && npm install -D @types/archiver @types/yauzl
```

- [ ] **Step 2: Write the failing migration test** — append to `server/migrationList.test.ts`:

```ts
describe('migration 36: backup-runs', () => {
  it('creates backup_runs with the expected columns and re-runs as a no-op', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 36));
    expect(tableNames(db)).toContain('backup_runs');
    for (const c of ['id', 'target', 'trigger', 'startedAt', 'finishedAt', 'status', 'snapshotId', 'objectsAdded', 'bytesWritten', 'warningsJson', 'error']) {
      expect(columnNames(db, 'backup_runs'), `missing ${c}`).toContain(c);
    }
    const m36 = migrations.find(m => m.version === 36)!;
    expect(() => m36.up({ db, dataDir: dir } as any)).not.toThrow();
    db.close();
  });
});
```

Run: `npm test -- server/migrationList.test.ts -t "migration 36"` → FAIL (table missing).

- [ ] **Step 3: Implement** — append to `server/migrationList.ts` before the closing `];`:

```ts
  {
    version: 36,
    name: 'backup-runs',
    // ADDITIVE: run history for the app-managed backups (spec
    // docs/superpowers/specs/2026-09-12-backup-restore-design.md).
    up({ db }) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS backup_runs (
          id            TEXT PRIMARY KEY,
          target        TEXT NOT NULL,
          trigger       TEXT NOT NULL,
          startedAt     INTEGER NOT NULL,
          finishedAt    INTEGER,
          status        TEXT NOT NULL,
          snapshotId    TEXT,
          objectsAdded  INTEGER NOT NULL DEFAULT 0,
          bytesWritten  INTEGER NOT NULL DEFAULT 0,
          warningsJson  TEXT NOT NULL DEFAULT '[]',
          error         TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_backup_runs_started ON backup_runs (startedAt);
      `);
    },
  },
```

Create `server/backup/types.ts` with the Interfaces block above verbatim.

In `server.ts` change `const SETTINGS_PRIVATE_PREFIXES = ['jwt.', 'smtp.', 'mail.', 'invoiceNumber'];` to include `'backup.'`, and move the list + `isPrivateSettingKey` into a new exported pair in `server/backup/settings.ts` is NOT required — keep it in `server.ts`, but add a one-line unit test in `server/backup/settings.test.ts` (Task 6 creates that file) is also not required. Instead, verify by the route behavior in Task 6's tests (a `backup.*` key never appears in `GET /api/settings`). For this task: just the prefix edit.

- [ ] **Step 4: Verify** — `npm test -- server/migrationList.test.ts && npm run lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json server/migrationList.ts server/migrationList.test.ts server/backup/types.ts server.ts
git commit -m "feat(backup): migration 36 backup_runs, shared types, zip deps, private backup.* settings"
```

---

### Task 2: `LocalStore`

**Files:**
- Create: `server/backup/store.ts`, `server/backup/store.test.ts`

**Interfaces (produces):** `export class LocalStore implements BackupTarget, BackupSource { constructor(root: string); readonly root: string; objectPath(sha): string; snapshotDir(id): string; ... }` plus `export async function sha256OfStream(s: NodeJS.ReadableStream): Promise<{ sha256: string; size: number }>`.

- [ ] **Step 1: Write the failing tests** — `server/backup/store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { LocalStore, sha256OfStream } from './store';
import type { Manifest } from './types';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-bk-')); });

const manifest = (files: Manifest['files'], createdAt = 1): Manifest => ({
  format: 1, createdAt, appVersion: '3.2.0', schemaVersion: 36,
  db: { size: 3, sha256: 'db' }, mailKey: { source: 'env' }, files,
  counts: { files: files.length, bytes: files.reduce((a, f) => a + f.size, 0) }, warnings: [],
});
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const bytes = (s: string) => () => Readable.from([Buffer.from(s)]);

describe('LocalStore objects', () => {
  it('putObject writes atomically under objects/<sha> and listObjects reports it', async () => {
    const st = new LocalStore(root);
    await st.putObject('aa11', bytes('hello'), 5);
    expect(fs.readFileSync(path.join(root, 'objects', 'aa11'), 'utf8')).toBe('hello');
    expect(fs.readdirSync(path.join(root, 'objects')).filter(f => f.endsWith('.tmp'))).toEqual([]);
    expect(await st.listObjects()).toEqual(new Set(['aa11']));
    const s = await st.openObject('aa11');
    expect((await sha256OfStream(s)).size).toBe(5);
  });

  it('putObject leaves no partial file when the source stream errors', async () => {
    const st = new LocalStore(root);
    const bad = () => { const r = new Readable({ read() { this.destroy(new Error('boom')); } }); return r; };
    await expect(st.putObject('bb22', bad, 1)).rejects.toThrow('boom');
    expect(fs.existsSync(path.join(root, 'objects', 'bb22'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'objects'))).toBe(true);
    expect(fs.readdirSync(path.join(root, 'objects'))).toEqual([]);
  });
});

describe('LocalStore snapshots', () => {
  it('writeSnapshot lays out app.db, mail.key, manifest.json (manifest last) and listSnapshots reads them newest first', async () => {
    const st = new LocalStore(root);
    const dbPath = path.join(root, 'tmp.db'); write(dbPath, 'DB!');
    const keyPath = path.join(root, 'k'); write(keyPath, 'KEY');
    await st.writeSnapshot('20260912-010203', { dbPath, mailKeyPath: keyPath, manifest: manifest([], 5) });
    await st.writeSnapshot('20260913-010203', { dbPath, mailKeyPath: null, manifest: manifest([], 9) });
    const dir = path.join(root, 'snapshots', '20260912-010203');
    expect(fs.readFileSync(path.join(dir, 'app.db'), 'utf8')).toBe('DB!');
    expect(fs.readFileSync(path.join(dir, 'mail.key'), 'utf8')).toBe('KEY');
    expect(fs.existsSync(path.join(root, 'snapshots', '20260913-010203', 'mail.key'))).toBe(false);
    const list = await st.listSnapshots();
    expect(list.map(s => s.id)).toEqual(['20260913-010203', '20260912-010203']);
    expect(list[1].createdAt).toBe(5);
    expect((await st.readManifest('20260912-010203')).createdAt).toBe(5);
  });

  it('a snapshot folder without manifest.json is ignored', async () => {
    const st = new LocalStore(root);
    write(path.join(root, 'snapshots', '20260901-000000', 'app.db'), 'x');
    expect(await st.listSnapshots()).toEqual([]);
  });

  it('deleteSnapshot and deleteObject remove exactly their paths', async () => {
    const st = new LocalStore(root);
    const dbPath = path.join(root, 'tmp.db'); write(dbPath, 'DB!');
    await st.writeSnapshot('20260912-010203', { dbPath, mailKeyPath: null, manifest: manifest([]) });
    await st.putObject('cc33', bytes('c'), 1);
    await st.deleteSnapshot('20260912-010203');
    await st.deleteObject('cc33');
    expect(fs.existsSync(path.join(root, 'snapshots', '20260912-010203'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'objects', 'cc33'))).toBe(false);
  });

  it('rejects ids that are not snapshot ids or hex hashes (no path traversal)', async () => {
    const st = new LocalStore(root);
    await expect(st.readManifest('../etc')).rejects.toThrow();
    await expect(st.openObject('../../x')).rejects.toThrow();
  });
});
```

Run: `npm test -- server/backup/store.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement** — `server/backup/store.ts`:

```ts
// server/backup/store.ts
//
// The on-disk backup layout (spec §Storage layout):
//   <root>/objects/<sha256>             one file per distinct content
//   <root>/snapshots/<id>/app.db|mail.key|manifest.json
// manifest.json is always written LAST, so a folder without one is an
// aborted run and every listing ignores it.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import type { BackupSource, BackupTarget, Manifest, SnapshotSummary } from './types';
import { isSnapshotId } from './types';

const isSha = (s: string): boolean => /^[0-9a-f]{64}$|^[0-9a-f]{4,}$/.test(s) && !s.includes('/') && !s.includes('..');

export async function sha256OfStream(s: NodeJS.ReadableStream): Promise<{ sha256: string; size: number }> {
  const h = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of s as AsyncIterable<Buffer>) { h.update(chunk); size += chunk.length; }
  return { sha256: h.digest('hex'), size };
}

export const summarize = (id: string, m: Manifest): SnapshotSummary => ({
  id, createdAt: m.createdAt, appVersion: m.appVersion, schemaVersion: m.schemaVersion,
  counts: m.counts, warnings: m.warnings.length,
});

export class LocalStore implements BackupTarget, BackupSource {
  readonly kind = 'local' as const;
  constructor(readonly root: string) {}

  objectPath(sha256: string): string {
    if (!isSha(sha256)) throw new Error('bad object id');
    return path.join(this.root, 'objects', sha256);
  }
  snapshotDir(id: string): string {
    if (!isSnapshotId(id)) throw new Error('bad snapshot id');
    return path.join(this.root, 'snapshots', id);
  }

  async listObjects(): Promise<Set<string>> {
    const dir = path.join(this.root, 'objects');
    if (!fs.existsSync(dir)) return new Set();
    return new Set(fs.readdirSync(dir).filter(f => !f.endsWith('.tmp')));
  }

  async putObject(sha256: string, source: () => NodeJS.ReadableStream, _size: number): Promise<void> {
    const dest = this.objectPath(sha256);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      await pipeline(source(), fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* not created */ }
      throw e;
    }
  }

  async writeSnapshot(id: string, files: { dbPath: string; mailKeyPath: string | null; manifest: Manifest }): Promise<void> {
    const dir = this.snapshotDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(files.dbPath, path.join(dir, 'app.db'));
    if (files.mailKeyPath) fs.copyFileSync(files.mailKeyPath, path.join(dir, 'mail.key'));
    const tmp = path.join(dir, 'manifest.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(files.manifest, null, 2));
    fs.renameSync(tmp, path.join(dir, 'manifest.json'));
  }

  async listSnapshots(): Promise<SnapshotSummary[]> {
    const dir = path.join(this.root, 'snapshots');
    if (!fs.existsSync(dir)) return [];
    const out: SnapshotSummary[] = [];
    for (const id of fs.readdirSync(dir)) {
      if (!isSnapshotId(id)) continue;
      const mp = path.join(dir, id, 'manifest.json');
      if (!fs.existsSync(mp)) continue;
      try { out.push(summarize(id, JSON.parse(fs.readFileSync(mp, 'utf8')) as Manifest)); }
      catch (e) { console.warn(`[backup] unreadable manifest in ${mp}:`, (e as Error).message); }
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  async readManifest(id: string): Promise<Manifest> {
    return JSON.parse(fs.readFileSync(path.join(this.snapshotDir(id), 'manifest.json'), 'utf8')) as Manifest;
  }

  async deleteSnapshot(id: string): Promise<void> {
    fs.rmSync(this.snapshotDir(id), { recursive: true, force: true });
  }

  async deleteObject(sha256: string): Promise<void> {
    fs.rmSync(this.objectPath(sha256), { force: true });
  }

  async openObject(sha256: string): Promise<NodeJS.ReadableStream> {
    return fs.createReadStream(this.objectPath(sha256));
  }

  async openSnapshotFile(id: string, name: 'app.db' | 'mail.key'): Promise<NodeJS.ReadableStream> {
    return fs.createReadStream(path.join(this.snapshotDir(id), name));
  }
}
```

- [ ] **Step 3: Verify** — `npm test -- server/backup/store.test.ts && npm run lint` → PASS.

- [ ] **Step 4: Commit** — `git add server/backup/store.ts server/backup/store.test.ts && git commit -m "feat(backup): LocalStore — content-addressed object + snapshot layout"`

---

### Task 3: `takeSnapshot` with run bookkeeping and prune

**Files:**
- Create: `server/backup/snapshot.ts`, `server/backup/snapshot.test.ts`

**Interfaces:**
- Consumes: `LocalStore`, `sha256OfStream` (Task 2); `pathFor(dataDir, id)` from `server/fileStore.ts`; `migrations` (latest version) from `server/migrationList.ts`.
- Produces:

```ts
export class BackupRunningError extends Error {}
export interface TakeSnapshotOpts {
  trigger: 'manual' | 'schedule';
  keep: number;                 // snapshots to retain on this target after the run
  appVersion: string;
  env?: NodeJS.ProcessEnv;      // MAIL_SECRET_KEY presence → mailKey {source:'env'}
  now?: () => Date;
}
export interface SnapshotResult { runId: string; snapshotId: string; objectsAdded: number; bytesWritten: number; warnings: string[] }
export function takeSnapshot(db: Database.Database, dataDir: string, target: BackupTarget, opts: TakeSnapshotOpts): Promise<SnapshotResult>
export function isRunActive(db: Database.Database, target: 'local' | 'drive'): boolean
export function listRuns(db: Database.Database, limit = 50): BackupRunRow[]
export function pruneTarget(target: BackupTarget, keep: number): Promise<{ snapshotsDeleted: number; objectsDeleted: number }>
```

- [ ] **Step 1: Write the failing tests** — `server/backup/snapshot.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { putBuffer } from '../files';
import { pathFor } from '../fileStore';
import { LocalStore } from './store';
import { takeSnapshot, listRuns, pruneTarget, BackupRunningError } from './snapshot';

let db: Database.Database; let dataDir: string; let root: string; let store: LocalStore;
const opts = { trigger: 'manual' as const, keep: 14, appVersion: '3.2.0', env: {} as NodeJS.ProcessEnv };

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-data-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-bk-'));
  db = openDb(path.join(dataDir, 'app.db'));
  runMigrations(db, dataDir, migrations);
  fs.writeFileSync(path.join(dataDir, 'mail.key'), 'a'.repeat(64) + '\n');
  store = new LocalStore(root);
});

const addFile = (name: string, content: string) => putBuffer(db, dataDir, `id-${name}`, Buffer.from(content), 'text/plain', { kind: 'document', name }).id;

describe('takeSnapshot', () => {
  it('first run writes every object, the db, the mail key and a manifest that matches the files table', async () => {
    addFile('a', 'AAA'); addFile('b', 'BBBB');
    const r = await takeSnapshot(db, dataDir, store, opts);
    expect(r.objectsAdded).toBe(2);
    expect(r.warnings).toEqual([]);
    const m = await store.readManifest(r.snapshotId);
    expect(m.format).toBe(1);
    expect(m.schemaVersion).toBe(migrations[migrations.length - 1].version);
    expect(m.files.map(f => f.id).sort()).toEqual(['id-a', 'id-b']);
    expect(m.counts).toEqual({ files: 2, bytes: 7 });
    expect('sha256' in m.mailKey).toBe(true);
    const dir = store.snapshotDir(r.snapshotId);
    expect(fs.existsSync(path.join(dir, 'app.db'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'mail.key'), 'utf8')).toBe('a'.repeat(64) + '\n');
    for (const f of m.files) expect(fs.existsSync(store.objectPath(f.sha256))).toBe(true);
    const runs = listRuns(db);
    expect(runs[0]).toMatchObject({ target: 'local', trigger: 'manual', status: 'ok', snapshotId: r.snapshotId, objectsAdded: 2 });
  });

  it('a second run with no changes adds zero objects; a rewritten file adds exactly one new object', async () => {
    addFile('a', 'AAA');
    await takeSnapshot(db, dataDir, store, opts);
    const r2 = await takeSnapshot(db, dataDir, store, { ...opts, now: () => new Date(Date.now() + 1000) });
    expect(r2.objectsAdded).toBe(0);
    putBuffer(db, dataDir, 'id-a', Buffer.from('CHANGED'), 'text/plain', { kind: 'document', name: 'a', mode: 'overwrite' });
    const r3 = await takeSnapshot(db, dataDir, store, { ...opts, now: () => new Date(Date.now() + 2000) });
    expect(r3.objectsAdded).toBe(1);
    const m = await store.readManifest(r3.snapshotId);
    expect(fs.readFileSync(store.objectPath(m.files[0].sha256), 'utf8')).toBe('CHANGED');
    expect((await store.listObjects()).size).toBe(2);
  });

  it('a file whose bytes on disk do not match its row is skipped with a warning, not an error', async () => {
    addFile('a', 'AAA');
    fs.writeFileSync(pathFor(dataDir, 'id-a'), 'TAMPERED');
    const r = await takeSnapshot(db, dataDir, store, opts);
    expect(r.objectsAdded).toBe(0);
    expect(r.warnings[0]).toMatch(/id-a/);
    expect((await store.readManifest(r.snapshotId)).files).toEqual([]);
    expect(listRuns(db)[0].status).toBe('ok');
  });

  it('mail key from the environment is recorded as source env and not written', async () => {
    const r = await takeSnapshot(db, dataDir, store, { ...opts, env: { MAIL_SECRET_KEY: 'b'.repeat(64) } });
    expect((await store.readManifest(r.snapshotId)).mailKey).toEqual({ source: 'env' });
    expect(fs.existsSync(path.join(store.snapshotDir(r.snapshotId), 'mail.key'))).toBe(false);
  });

  it('refuses a concurrent run on the same target and records a failed run on error', async () => {
    db.prepare(`INSERT INTO backup_runs (id, target, trigger, startedAt, status) VALUES ('x', 'local', 'manual', ?, 'running')`).run(Date.now());
    await expect(takeSnapshot(db, dataDir, store, opts)).rejects.toThrow(BackupRunningError);
    db.prepare('DELETE FROM backup_runs').run();
    const broken = { ...store, listObjects: async () => { throw new Error('disk gone'); } } as any;
    await expect(takeSnapshot(db, dataDir, broken, opts)).rejects.toThrow('disk gone');
    expect(listRuns(db)[0]).toMatchObject({ status: 'error', error: 'disk gone' });
  });

  it('prune keeps the newest N snapshots and only objects they reference', async () => {
    addFile('a', 'AAA');
    const r1 = await takeSnapshot(db, dataDir, store, { ...opts, keep: 99 });
    putBuffer(db, dataDir, 'id-a', Buffer.from('V2'), 'text/plain', { kind: 'document', name: 'a', mode: 'overwrite' });
    const r2 = await takeSnapshot(db, dataDir, store, { ...opts, keep: 99, now: () => new Date(Date.now() + 1000) });
    const res = await pruneTarget(store, 1);
    expect(res).toEqual({ snapshotsDeleted: 1, objectsDeleted: 1 });
    expect((await store.listSnapshots()).map(s => s.id)).toEqual([r2.snapshotId]);
    expect(fs.existsSync(store.snapshotDir(r1.snapshotId))).toBe(false);
    expect((await store.listObjects()).size).toBe(1);
  });
});
```

Run: `npm test -- server/backup/snapshot.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement** — `server/backup/snapshot.ts`:

```ts
// server/backup/snapshot.ts — one backup run (spec §Taking a snapshot).
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { pathFor } from '../fileStore';
import { migrations } from '../migrationList';
import type { BackupTarget, Manifest, ManifestFile } from './types';
import { snapshotIdNow } from './types';
import { sha256OfStream } from './store';

export class BackupRunningError extends Error { constructor() { super('A backup is already running for this target'); } }

export interface TakeSnapshotOpts {
  trigger: 'manual' | 'schedule';
  keep: number;
  appVersion: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}
export interface SnapshotResult { runId: string; snapshotId: string; objectsAdded: number; bytesWritten: number; warnings: string[] }
export interface BackupRunRow {
  id: string; target: 'local' | 'drive'; trigger: 'manual' | 'schedule'; startedAt: number; finishedAt: number | null;
  status: 'running' | 'ok' | 'error'; snapshotId: string | null; objectsAdded: number; bytesWritten: number;
  warningsJson: string; error: string | null;
}

export const latestSchemaVersion = (): number => migrations[migrations.length - 1].version;

export function isRunActive(db: Database.Database, target: 'local' | 'drive'): boolean {
  return !!db.prepare(`SELECT 1 FROM backup_runs WHERE target = ? AND status = 'running'`).get(target);
}

export function listRuns(db: Database.Database, limit = 50): BackupRunRow[] {
  return db.prepare('SELECT * FROM backup_runs ORDER BY startedAt DESC LIMIT ?').all(limit) as BackupRunRow[];
}

const fileSha = (p: string): Promise<{ sha256: string; size: number }> => sha256OfStream(fs.createReadStream(p));

export async function takeSnapshot(db: Database.Database, dataDir: string, target: BackupTarget, opts: TakeSnapshotOpts): Promise<SnapshotResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  // Claim the target atomically: the INSERT and the running-check are one statement.
  const runId = uuidv4();
  const claimed = db.prepare(`
    INSERT INTO backup_runs (id, target, trigger, startedAt, status)
    SELECT ?, ?, ?, ?, 'running' WHERE NOT EXISTS (SELECT 1 FROM backup_runs WHERE target = ? AND status = 'running')
  `).run(runId, target.kind, opts.trigger, startedAt.getTime(), target.kind);
  if (claimed.changes === 0) throw new BackupRunningError();

  const snapshotId = snapshotIdNow(startedAt);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-snap-'));
  const warnings: string[] = [];
  let objectsAdded = 0; let bytesWritten = 0;
  try {
    // 1. consistent database copy (online backup API)
    const dbCopy = path.join(tmpDir, 'app.db');
    await db.backup(dbCopy);
    const dbInfo = await fileSha(dbCopy);

    // 2. objects the target lacks
    const have = await target.listObjects();
    const rows = db.prepare('SELECT id, sha256, size FROM files').all() as ManifestFile[];
    const files: ManifestFile[] = [];
    for (const row of rows) {
      const p = pathFor(dataDir, row.id);
      if (!fs.existsSync(p)) { warnings.push(`file ${row.id} skipped: not on disk`); continue; }
      if (!have.has(row.sha256)) {
        let actual = await fileSha(p);
        if (actual.sha256 !== row.sha256) actual = await fileSha(p); // one retry: a regenerate may be mid-write
        if (actual.sha256 !== row.sha256) { warnings.push(`file ${row.id} skipped: on-disk hash did not match the row after retry`); continue; }
        await target.putObject(row.sha256, () => fs.createReadStream(p), actual.size);
        have.add(row.sha256);
        objectsAdded++; bytesWritten += actual.size;
      }
      files.push({ id: row.id, sha256: row.sha256, size: row.size });
    }

    // 3. mail key
    const keyPath = path.join(dataDir, 'mail.key');
    const mailKey: Manifest['mailKey'] = env.MAIL_SECRET_KEY
      ? { source: 'env' }
      : { sha256: crypto.createHash('sha256').update(fs.readFileSync(keyPath)).digest('hex') };

    const manifest: Manifest = {
      format: 1, createdAt: startedAt.getTime(), appVersion: opts.appVersion, schemaVersion: latestSchemaVersion(),
      db: dbInfo, mailKey, files,
      counts: { files: files.length, bytes: files.reduce((a, f) => a + f.size, 0) }, warnings,
    };
    await target.writeSnapshot(snapshotId, { dbPath: dbCopy, mailKeyPath: env.MAIL_SECRET_KEY ? null : keyPath, manifest });
    bytesWritten += dbInfo.size;

    // 4. retention
    await pruneTarget(target, opts.keep);

    db.prepare(`UPDATE backup_runs SET finishedAt = ?, status = 'ok', snapshotId = ?, objectsAdded = ?, bytesWritten = ?, warningsJson = ? WHERE id = ?`)
      .run(Date.now(), snapshotId, objectsAdded, bytesWritten, JSON.stringify(warnings), runId);
    if (warnings.length) console.warn(`[backup] ${target.kind} snapshot ${snapshotId} finished with ${warnings.length} warning(s)`);
    return { runId, snapshotId, objectsAdded, bytesWritten, warnings };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare(`UPDATE backup_runs SET finishedAt = ?, status = 'error', error = ?, warningsJson = ? WHERE id = ?`)
      .run(Date.now(), msg, JSON.stringify(warnings), runId);
    console.error(`[backup] ${target.kind} run failed:`, msg);
    throw e;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function pruneTarget(target: BackupTarget, keep: number): Promise<{ snapshotsDeleted: number; objectsDeleted: number }> {
  const snaps = await target.listSnapshots(); // newest first
  const doomed = snaps.slice(Math.max(1, keep));
  for (const s of doomed) await target.deleteSnapshot(s.id);
  const kept = snaps.slice(0, Math.max(1, keep));
  const referenced = new Set<string>();
  for (const s of kept) for (const f of (await target.readManifest(s.id)).files) referenced.add(f.sha256);
  let objectsDeleted = 0;
  for (const sha of await target.listObjects()) {
    if (!referenced.has(sha)) { await target.deleteObject(sha); objectsDeleted++; }
  }
  return { snapshotsDeleted: doomed.length, objectsDeleted };
}
```

(`keep` is floored at 1 so a misconfigured `0` can never delete the snapshot just written.)

- [ ] **Step 3: Verify** — `npm test -- server/backup && npm run lint` → PASS.

- [ ] **Step 4: Commit** — `git add server/backup/snapshot.ts server/backup/snapshot.test.ts && git commit -m "feat(backup): takeSnapshot — online db copy, hash-addressed incremental objects, run history, prune"`

---

### Task 4: Snapshot zip write/read

**Files:**
- Create: `server/backup/zip.ts`, `server/backup/zip.test.ts`

**Interfaces (produces):**
```ts
export function streamSnapshotZip(source: BackupSource, snapshotId: string, out: NodeJS.WritableStream): Promise<void>
/** Unpacks a snapshot zip into a LocalStore rooted at `intoRoot`; returns the snapshot id found. Rejects a zip with no manifest or with entries outside objects/ + snapshots/<id>/. */
export function unpackSnapshotZip(zipPath: string, intoRoot: string): Promise<{ snapshotId: string }>
```
Zip layout = the store layout for ONE snapshot: `snapshots/<id>/{app.db,mail.key,manifest.json}` + `objects/<sha>` for each referenced hash.

- [ ] **Step 1: Write the failing test** — `server/backup/zip.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { LocalStore } from './store';
import { streamSnapshotZip, unpackSnapshotZip } from './zip';
import type { Manifest } from './types';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-zip-'));

describe('snapshot zip', () => {
  it('round-trips a snapshot (db, key, manifest, referenced objects only)', async () => {
    const a = new LocalStore(tmp());
    await a.putObject('a'.repeat(64), () => Readable.from([Buffer.from('one')]), 3);
    await a.putObject('b'.repeat(64), () => Readable.from([Buffer.from('unreferenced')]), 12);
    const dbPath = path.join(a.root, 'db'); fs.writeFileSync(dbPath, 'DB');
    const keyPath = path.join(a.root, 'k'); fs.writeFileSync(keyPath, 'KEY');
    const manifest: Manifest = { format: 1, createdAt: 1, appVersion: '3.2.0', schemaVersion: 36, db: { size: 2, sha256: 'x' }, mailKey: { sha256: 'y' },
      files: [{ id: 'f1', sha256: 'a'.repeat(64), size: 3 }], counts: { files: 1, bytes: 3 }, warnings: [] };
    await a.writeSnapshot('20260912-000000', { dbPath, mailKeyPath: keyPath, manifest });

    const zipPath = path.join(tmp(), 's.zip');
    await streamSnapshotZip(a, '20260912-000000', fs.createWriteStream(zipPath));

    const bRoot = tmp();
    const { snapshotId } = await unpackSnapshotZip(zipPath, bRoot);
    const b = new LocalStore(bRoot);
    expect(snapshotId).toBe('20260912-000000');
    expect((await b.readManifest(snapshotId)).files[0].id).toBe('f1');
    expect(fs.readFileSync(b.objectPath('a'.repeat(64)), 'utf8')).toBe('one');
    expect(fs.existsSync(b.objectPath('b'.repeat(64)))).toBe(false);
    expect(fs.readFileSync(path.join(b.snapshotDir(snapshotId), 'app.db'), 'utf8')).toBe('DB');
    expect(fs.readFileSync(path.join(b.snapshotDir(snapshotId), 'mail.key'), 'utf8')).toBe('KEY');
  });

  it('rejects a zip without a manifest', async () => {
    const zipPath = path.join(tmp(), 'bad.zip');
    const archiver = (await import('archiver')).default;
    const out = fs.createWriteStream(zipPath);
    const ar = archiver('zip'); ar.pipe(out); ar.append('x', { name: 'objects/' + 'c'.repeat(64) }); await ar.finalize();
    await new Promise(r => out.on('close', r));
    await expect(unpackSnapshotZip(zipPath, tmp())).rejects.toThrow(/manifest/);
  });
});
```

Run: `npm test -- server/backup/zip.test.ts` → FAIL.

- [ ] **Step 2: Implement** — `server/backup/zip.ts`:

```ts
// server/backup/zip.ts — a snapshot as one portable archive (spec §Storage layout).
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import yauzl from 'yauzl';
import { pipeline } from 'stream/promises';
import type { BackupSource, Manifest } from './types';
import { isSnapshotId } from './types';

export async function streamSnapshotZip(source: BackupSource, snapshotId: string, out: NodeJS.WritableStream): Promise<void> {
  const manifest = await source.readManifest(snapshotId);
  const ar = archiver('zip', { zlib: { level: 1 } }); // blobs are mostly already-compressed; favor speed
  const done = new Promise<void>((resolve, reject) => { out.on('finish', () => resolve()); out.on('close', () => resolve()); ar.on('error', reject); out.on('error', reject); });
  ar.pipe(out);
  ar.append(JSON.stringify(manifest, null, 2), { name: `snapshots/${snapshotId}/manifest.json` });
  ar.append(await source.openSnapshotFile(snapshotId, 'app.db') as any, { name: `snapshots/${snapshotId}/app.db` });
  if ('sha256' in manifest.mailKey) ar.append(await source.openSnapshotFile(snapshotId, 'mail.key') as any, { name: `snapshots/${snapshotId}/mail.key` });
  for (const f of manifest.files) ar.append(await source.openObject(f.sha256) as any, { name: `objects/${f.sha256}` });
  await ar.finalize();
  await done;
}

const ENTRY = /^(objects\/[0-9a-f]{64}|snapshots\/(\d{8}-\d{6})\/(app\.db|mail\.key|manifest\.json))$/;

export function unpackSnapshotZip(zipPath: string, intoRoot: string): Promise<{ snapshotId: string }> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('cannot open zip'));
      let snapshotId: string | null = null; let sawManifest = false;
      zip.on('error', reject);
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        const m = ENTRY.exec(entry.fileName);
        if (!m) return reject(new Error(`unexpected entry in snapshot zip: ${entry.fileName}`));
        if (m[2]) { if (snapshotId && snapshotId !== m[2]) return reject(new Error('zip holds more than one snapshot')); snapshotId = m[2]; }
        if (m[3] === 'manifest.json') sawManifest = true;
        const dest = path.join(intoRoot, entry.fileName);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        zip.openReadStream(entry, (e, rs) => {
          if (e || !rs) return reject(e ?? new Error('bad entry'));
          pipeline(rs, fs.createWriteStream(dest)).then(() => zip.readEntry(), reject);
        });
      });
      zip.on('end', () => {
        if (!snapshotId || !sawManifest || !isSnapshotId(snapshotId)) return reject(new Error('zip is missing snapshots/<id>/manifest.json'));
        resolve({ snapshotId });
      });
      zip.readEntry();
    });
  });
}
```

- [ ] **Step 3: Verify** — `npm test -- server/backup/zip.test.ts && npm run lint` → PASS. (If `@types/archiver`'s `append` signature rejects the `as any` stream cast, type the streams as `Readable` from `'stream'` instead.)

- [ ] **Step 4: Commit** — `git add server/backup/zip.ts server/backup/zip.test.ts && git commit -m "feat(backup): stream a snapshot to zip and unpack one back into a store"`

---

### Task 5: `restoreSnapshot` and `isFreshInstall`

**Files:**
- Create: `server/backup/restore.ts`, `server/backup/restore.test.ts`

**Interfaces:**
- Consumes: `BackupSource`, `Manifest` (Task 1); `sha256OfStream` (Task 2); `latestSchemaVersion` (Task 3); `pathFor` (`server/fileStore.ts`).
- Produces:
```ts
export class RestoreRefusedError extends Error {}          // → 400
export function isFreshInstall(db: Database.Database): boolean
export interface RestoreDeps { dataDir: string; closeDb: () => void; exit: (code: number) => void; log?: (m: string) => void }
/** Verifies + copies objects, writes mail.key and app.db.restored, then finishes via `finish()`. */
export function restoreSnapshot(source: BackupSource, snapshotId: string, deps: RestoreDeps): Promise<{ finish: () => void; files: number; bytes: number }>
```
`finish()` is what the route calls AFTER responding: it closes the db, renames `app.db.restored` → `app.db`, and calls `deps.exit(0)`.

- [ ] **Step 1: Write the failing tests** — `server/backup/restore.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { putBuffer } from '../files';
import { pathFor } from '../fileStore';
import { LocalStore } from './store';
import { takeSnapshot } from './snapshot';
import { restoreSnapshot, isFreshInstall, RestoreRefusedError } from './restore';
import crypto from 'crypto';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const treeHashes = (dataDir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else out[path.relative(dataDir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
  walk(path.join(dataDir, 'files'));
  return out;
};

let srcDir: string; let srcDb: Database.Database; let store: LocalStore;
beforeEach(() => {
  srcDir = tmp('ft-src-'); srcDb = openDb(path.join(srcDir, 'app.db')); runMigrations(srcDb, srcDir, migrations);
  fs.writeFileSync(path.join(srcDir, 'mail.key'), 'k'.repeat(64) + '\n');
  srcDb.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Job', 1);
  putBuffer(srcDb, srcDir, 'f-1', Buffer.from('plan pdf'), 'application/pdf', { kind: 'document', name: 'plan.pdf', projectId: 'p1' });
  putBuffer(srcDb, srcDir, 'f-2', Buffer.from('photo'), 'image/png', { kind: 'photo', name: 'p.png', projectId: 'p1' });
  store = new LocalStore(tmp('ft-bk-'));
});

describe('isFreshInstall', () => {
  it('is true only for the default admin alone with no projects and no files', () => {
    const dir = tmp('ft-fresh-'); const db = openDb(path.join(dir, 'app.db')); runMigrations(db, dir, migrations);
    db.prepare("INSERT INTO users (id, username, password, role) VALUES ('admin-id-123', 'admin', 'x', 'admin')").run();
    expect(isFreshInstall(db)).toBe(true);
    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p', 'x', 1);
    expect(isFreshInstall(db)).toBe(false);
    db.prepare('DELETE FROM projects').run();
    db.prepare("INSERT INTO users (id, username, password, role) VALUES ('u2', 'bob', 'x', 'user')").run();
    expect(isFreshInstall(db)).toBe(false);
  });
});

describe('restoreSnapshot', () => {
  it('rebuilds files/ hash-for-hash, writes mail.key and app.db.restored, and finish() closes/renames/exits', async () => {
    const snap = await takeSnapshot(srcDb, srcDir, store, { trigger: 'manual', keep: 5, appVersion: '3.2.0', env: {} });
    const dst = tmp('ft-dst-');
    fs.writeFileSync(path.join(dst, 'mail.key'), 'fresh-key\n'); fs.writeFileSync(path.join(dst, 'app.db'), 'fresh-db');
    const closeDb = vi.fn(); const exit = vi.fn();
    const r = await restoreSnapshot(store, snap.snapshotId, { dataDir: dst, closeDb, exit });
    expect(r.files).toBe(2);
    expect(treeHashes(dst)).toEqual(treeHashes(srcDir));
    expect(fs.readFileSync(path.join(dst, 'mail.key'), 'utf8')).toBe('k'.repeat(64) + '\n');
    expect(fs.existsSync(path.join(dst, 'app.db.restored'))).toBe(true);
    expect(fs.readFileSync(path.join(dst, 'app.db'), 'utf8')).toBe('fresh-db'); // untouched until finish
    expect(closeDb).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled();
    r.finish();
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(fs.existsSync(path.join(dst, 'app.db.restored'))).toBe(false);
    const restored = openDb(path.join(dst, 'app.db'));
    expect((restored.prepare('SELECT COUNT(*) c FROM projects').get() as any).c).toBe(1);
    expect((restored.prepare('SELECT COUNT(*) c FROM files').get() as any).c).toBe(2);
  });

  it('refuses a newer schema and an unknown format before writing anything', async () => {
    const snap = await takeSnapshot(srcDb, srcDir, store, { trigger: 'manual', keep: 5, appVersion: '3.2.0', env: {} });
    const mp = path.join(store.snapshotDir(snap.snapshotId), 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8')); m.schemaVersion = 999; fs.writeFileSync(mp, JSON.stringify(m));
    const dst = tmp('ft-dst-');
    await expect(restoreSnapshot(store, snap.snapshotId, { dataDir: dst, closeDb: vi.fn(), exit: vi.fn() })).rejects.toThrow(RestoreRefusedError);
    expect(fs.existsSync(path.join(dst, 'files'))).toBe(false);
    m.schemaVersion = 1; m.format = 2; fs.writeFileSync(mp, JSON.stringify(m));
    await expect(restoreSnapshot(store, snap.snapshotId, { dataDir: dst, closeDb: vi.fn(), exit: vi.fn() })).rejects.toThrow(RestoreRefusedError);
  });

  it('a corrupt object aborts before the database is touched', async () => {
    const snap = await takeSnapshot(srcDb, srcDir, store, { trigger: 'manual', keep: 5, appVersion: '3.2.0', env: {} });
    const m = await store.readManifest(snap.snapshotId);
    fs.writeFileSync(store.objectPath(m.files[0].sha256), 'corrupt');
    const dst = tmp('ft-dst-'); fs.writeFileSync(path.join(dst, 'app.db'), 'fresh-db');
    await expect(restoreSnapshot(store, snap.snapshotId, { dataDir: dst, closeDb: vi.fn(), exit: vi.fn() })).rejects.toThrow(/hash/);
    expect(fs.existsSync(path.join(dst, 'app.db.restored'))).toBe(false);
    expect(fs.readFileSync(path.join(dst, 'app.db'), 'utf8')).toBe('fresh-db');
  });
});
```

Run: `npm test -- server/backup/restore.test.ts` → FAIL.

- [ ] **Step 2: Implement** — `server/backup/restore.ts`:

```ts
// server/backup/restore.ts — rebuild a data dir from one snapshot (spec §Setup mode and restore).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import type Database from 'better-sqlite3';
import { pathFor } from '../fileStore';
import { latestSchemaVersion } from './snapshot';
import type { BackupSource, Manifest } from './types';

export class RestoreRefusedError extends Error {}
export const DEFAULT_ADMIN_ID = 'admin-id-123';

export function isFreshInstall(db: Database.Database): boolean {
  const users = db.prepare('SELECT id FROM users').all() as { id: string }[];
  if (users.length !== 1 || users[0].id !== DEFAULT_ADMIN_ID) return false;
  const projects = (db.prepare('SELECT COUNT(*) c FROM projects').get() as { c: number }).c;
  const files = (db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c;
  return projects === 0 && files === 0;
}

export interface RestoreDeps { dataDir: string; closeDb: () => void; exit: (code: number) => void; log?: (m: string) => void }

/** Copies `src` to `dest` (tmp + rename) while hashing; throws if the hash differs from `expected`. */
async function copyVerified(src: NodeJS.ReadableStream, dest: string, expected: string): Promise<number> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.restore.tmp`;
  const h = crypto.createHash('sha256'); let size = 0;
  const tap = new Transform({ transform(chunk, _e, cb) { h.update(chunk); size += chunk.length; cb(null, chunk); } });
  try {
    await pipeline(src, tap, fs.createWriteStream(tmp));
    const got = h.digest('hex');
    if (got !== expected) throw new RestoreRefusedError(`object ${expected} failed its hash check (got ${got})`);
    fs.renameSync(tmp, dest);
    return size;
  } catch (e) { try { fs.unlinkSync(tmp); } catch { /* none */ } throw e; }
}

export async function restoreSnapshot(source: BackupSource, snapshotId: string, deps: RestoreDeps): Promise<{ finish: () => void; files: number; bytes: number }> {
  const log = deps.log ?? ((m: string) => console.log(`[backup] ${m}`));
  const manifest: Manifest = await source.readManifest(snapshotId);
  if (manifest.format !== 1) throw new RestoreRefusedError(`Unknown snapshot format ${String((manifest as any).format)}`);
  const latest = latestSchemaVersion();
  if (manifest.schemaVersion > latest) {
    throw new RestoreRefusedError(`This snapshot was made by a newer app (schema ${manifest.schemaVersion}); this server is at schema ${latest}. Update the app first.`);
  }
  // 1. every object, verified, before the database is touched
  let bytes = 0;
  for (const f of manifest.files) {
    bytes += await copyVerified(await source.openObject(f.sha256), pathFor(deps.dataDir, f.id), f.sha256);
  }
  log(`restore ${snapshotId}: ${manifest.files.length} file(s) verified`);
  // 2. mail key (the sealed credentials in the restored db need the original)
  if ('sha256' in manifest.mailKey) {
    await copyVerified(await source.openSnapshotFile(snapshotId, 'mail.key'), path.join(deps.dataDir, 'mail.key'), manifest.mailKey.sha256);
  }
  // 3. database, staged beside the live one
  const staged = path.join(deps.dataDir, 'app.db.restored');
  await copyVerified(await source.openSnapshotFile(snapshotId, 'app.db'), staged, manifest.db.sha256);
  const finish = () => {
    deps.closeDb();
    fs.renameSync(staged, path.join(deps.dataDir, 'app.db'));
    log(`restore ${snapshotId}: database in place — exiting for restart`);
    deps.exit(0);
  };
  return { finish, files: manifest.files.length, bytes };
}
```

- [ ] **Step 3: Verify** — `npm test -- server/backup && npm run lint` → PASS.

- [ ] **Step 4: Commit** — `git add server/backup/restore.ts server/backup/restore.test.ts && git commit -m "feat(backup): restoreSnapshot — verified object copy, staged db swap, injectable exit; isFreshInstall"`

---

### Task 6: Backup settings, admin routes, server wiring

**Files:**
- Create: `server/backup/settings.ts`, `server/backup/routes.ts`, `server/backup/routes.test.ts`
- Modify: `server.ts` (BACKUP_PATH, `registerBackupRoutes` call, parser bypass for the upload path — Task 7 uses it, add now)

**Interfaces:**
- Consumes: Tasks 2–5; `MailCrypto` (`server/mail/crypto.ts`); `requestMeta` and the `authenticateToken/requireAdmin/broadcastChange` deps shape from `server/routes.ts`.
- Produces:
```ts
// settings.ts
export interface BackupSchedule { enabled: boolean; hour: number; minute: number }
export interface DriveConnection { refreshToken: string; email: string; folderId: string; objectsFolderId: string; snapshotsFolderId: string; needsReconnect?: boolean }
export const readSchedule(db): BackupSchedule            // default { enabled:false, hour:2, minute:0 }
export const writeSchedule(db, s: BackupSchedule): void
export const readKeep(db): { local: number; drive: number } // default 14/14, clamped 1..365
export const writeKeep(db, k): void
export const readDrive(db, crypto: MailCrypto): DriveConnection | null
export const writeDrive(db, crypto, c: DriveConnection | null): void
// routes.ts
export interface BackupRouteDeps {
  db: Database.Database; dataDir: string; backupRoot: string; backupRootIsDefault: boolean;
  appVersion: string; env: NodeJS.ProcessEnv; publicUrl: string | null; jwtSecret: string;
  mailCrypto: MailCrypto; authenticateToken; requireAdmin; verifyToken: (t: string) => any;
  broadcastChange: (e: EntityChangedEvent) => void; closeDb: () => void; exit: (code: number) => void;
  fetch?: typeof fetch; scheduler?: { nextRunAt(): number | null };
  driveStore?: (conn: DriveConnection) => BackupTarget & BackupSource;   // injected in tests; Task 8 supplies the real one
}
export function registerBackupRoutes(app: express.Express, deps: BackupRouteDeps): void
```
Routes in this task: `GET /api/backup/status`, `POST /api/backup/run`, `GET /api/backup/runs`, `GET /api/backup/snapshots`, `GET /api/backup/snapshots/:id/download`, `PUT /api/backup/settings`. (Drive OAuth routes come in Task 8; setup routes in Task 7 — both live in this same file.)

- [ ] **Step 1: Write the failing tests** — `server/backup/routes.test.ts` (harness mirrors `server/routes.test.ts`):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { putBuffer } from '../files';
import { MailCrypto } from '../mail/crypto';
import { registerBackupRoutes, type BackupRouteDeps } from './routes';
import { unpackSnapshotZip } from './zip';
import { LocalStore } from './store';

let db: Database.Database; let dataDir: string; let root: string; let app: express.Express; let events: any[];
const crypto = new MailCrypto(Buffer.alloc(32, 9));

const mkApp = (over: Partial<BackupRouteDeps> = {}, user: any = { id: 'u1', role: 'admin' }) => {
  const a = express(); a.use(express.json());
  registerBackupRoutes(a, {
    db, dataDir, backupRoot: root, backupRootIsDefault: false, appVersion: '3.2.0', env: {}, publicUrl: null, jwtSecret: 's',
    mailCrypto: crypto,
    authenticateToken: (req: any, _res: any, next: any) => { req.user = user; next(); },
    requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
    verifyToken: () => user, broadcastChange: e => events.push(e), closeDb: () => {}, exit: () => {}, ...over,
  });
  return a;
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-d-')); root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-r-'));
  db = openDb(path.join(dataDir, 'app.db')); runMigrations(db, dataDir, migrations);
  fs.writeFileSync(path.join(dataDir, 'mail.key'), 'k'.repeat(64) + '\n');
  db.prepare("INSERT INTO users (id, username, password, role) VALUES ('admin-id-123', 'admin', 'x', 'admin')").run();
  events = []; app = mkApp();
});

describe('backup admin routes', () => {
  it('status reports the root, defaults, no runs yet, and no drive', async () => {
    const r = await request(app).get('/api/backup/status');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ root: root, rootIsDefault: false, drive: { connected: false }, schedule: { enabled: false, hour: 2, minute: 0 }, keep: { local: 14, drive: 14 }, running: null });
    expect(r.body.lastRun).toEqual({ local: null, drive: null });
  });

  it('run → 202 then the run shows ok, a snapshot lists, and a backupRun event was broadcast', async () => {
    putBuffer(db, dataDir, 'f1', Buffer.from('x'), 'text/plain', { kind: 'document', name: 'x' });
    const r = await request(app).post('/api/backup/run').send({ target: 'local' });
    expect(r.status).toBe(202); expect(r.body.runId).toBeTruthy();
    await new Promise(res => setTimeout(res, 300));
    const runs = await request(app).get('/api/backup/runs');
    expect(runs.body[0]).toMatchObject({ status: 'ok', target: 'local', objectsAdded: 1 });
    const snaps = await request(app).get('/api/backup/snapshots?target=local');
    expect(snaps.body.length).toBe(1);
    expect(events.some(e => e.type === 'backupRun')).toBe(true);
  });

  it('a second run while one is running → 409 backup_running', async () => {
    db.prepare(`INSERT INTO backup_runs (id, target, trigger, startedAt, status) VALUES ('x', 'local', 'manual', ?, 'running')`).run(Date.now());
    const r = await request(app).post('/api/backup/run').send({ target: 'local' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('backup_running');
  });

  it('download streams a zip that unpacks to the same snapshot', async () => {
    putBuffer(db, dataDir, 'f1', Buffer.from('hello'), 'text/plain', { kind: 'document', name: 'x' });
    await request(app).post('/api/backup/run').send({ target: 'local' });
    await new Promise(res => setTimeout(res, 300));
    const id = (await request(app).get('/api/backup/snapshots?target=local')).body[0].id;
    const r = await request(app).get(`/api/backup/snapshots/${id}/download`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200); expect(r.headers['content-type']).toMatch(/zip/);
    const zipPath = path.join(root, 'dl.zip'); fs.writeFileSync(zipPath, r.body);
    const into = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-un-'));
    expect((await unpackSnapshotZip(zipPath, into)).snapshotId).toBe(id);
    expect((await new LocalStore(into).readManifest(id)).files.length).toBe(1);
  });

  it('settings round-trip with clamping; non-admin gets 403 everywhere', async () => {
    const r = await request(app).put('/api/backup/settings').send({ schedule: { enabled: true, hour: 23, minute: 30 }, keep: { local: 0, drive: 9999 } });
    expect(r.status).toBe(200);
    expect((await request(app).get('/api/backup/status')).body).toMatchObject({ schedule: { enabled: true, hour: 23, minute: 30 }, keep: { local: 1, drive: 365 } });
    const member = mkApp({}, { id: 'u2', role: 'user' });
    for (const [m, p] of [['get', '/api/backup/status'], ['post', '/api/backup/run'], ['get', '/api/backup/runs'], ['put', '/api/backup/settings']] as const) {
      expect((await (request(member) as any)[m](p).send({})).status).toBe(403);
    }
  });
});
```

Run: `npm test -- server/backup/routes.test.ts` → FAIL.

- [ ] **Step 2: Implement `server/backup/settings.ts`**

```ts
// server/backup/settings.ts — typed access to the private backup.* settings keys.
import type Database from 'better-sqlite3';
import type { MailCrypto } from '../mail/crypto';

export interface BackupSchedule { enabled: boolean; hour: number; minute: number }
export interface DriveConnection { refreshToken: string; email: string; folderId: string; objectsFolderId: string; snapshotsFolderId: string; needsReconnect?: boolean }

const get = (db: Database.Database, key: string): string | null =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const set = (db: Database.Database, key: string, value: string | null): void => {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
};
const clamp = (n: unknown, lo: number, hi: number, dflt: number): number => {
  const v = Math.floor(Number(n)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

export function readSchedule(db: Database.Database): BackupSchedule {
  try { const s = JSON.parse(get(db, 'backup.schedule') ?? '') ; return { enabled: !!s.enabled, hour: clamp(s.hour, 0, 23, 2), minute: clamp(s.minute, 0, 59, 0) }; }
  catch { return { enabled: false, hour: 2, minute: 0 }; }
}
export function writeSchedule(db: Database.Database, s: BackupSchedule): void {
  set(db, 'backup.schedule', JSON.stringify({ enabled: !!s.enabled, hour: clamp(s.hour, 0, 23, 2), minute: clamp(s.minute, 0, 59, 0) }));
}
export function readKeep(db: Database.Database): { local: number; drive: number } {
  return { local: clamp(get(db, 'backup.keepLocal'), 1, 365, 14), drive: clamp(get(db, 'backup.keepDrive'), 1, 365, 14) };
}
export function writeKeep(db: Database.Database, k: { local?: unknown; drive?: unknown }): void {
  const cur = readKeep(db);
  set(db, 'backup.keepLocal', String(clamp(k.local ?? cur.local, 1, 365, 14)));
  set(db, 'backup.keepDrive', String(clamp(k.drive ?? cur.drive, 1, 365, 14)));
}
export function readDrive(db: Database.Database, crypto: MailCrypto): DriveConnection | null {
  const sealed = get(db, 'backup.drive'); if (!sealed) return null;
  try { return crypto.open<DriveConnection>(sealed); } catch { return null; }
}
export function writeDrive(db: Database.Database, crypto: MailCrypto, c: DriveConnection | null): void {
  set(db, 'backup.drive', c ? crypto.seal(c) : null);
}
```

- [ ] **Step 3: Implement `server/backup/routes.ts`** (admin routes; Tasks 7/8 add to this file):

```ts
// server/backup/routes.ts — admin backup routes + fresh-install restore routes
// (spec §Backup routes, §Setup mode and restore).
import express from 'express';
import type Database from 'better-sqlite3';
import type { MailCrypto } from '../mail/crypto';
import type { EntityChangedEvent } from '../realtime/changeFeed';
import { LocalStore } from './store';
import { takeSnapshot, listRuns, isRunActive, BackupRunningError } from './snapshot';
import { streamSnapshotZip } from './zip';
import { readSchedule, writeSchedule, readKeep, writeKeep, readDrive, type DriveConnection } from './settings';
import type { BackupSource, BackupTarget } from './types';
import { isSnapshotId } from './types';

export interface BackupRouteDeps {
  db: Database.Database; dataDir: string; backupRoot: string; backupRootIsDefault: boolean;
  appVersion: string; env: NodeJS.ProcessEnv; publicUrl: string | null; jwtSecret: string;
  mailCrypto: MailCrypto;
  authenticateToken: express.RequestHandler; requireAdmin: express.RequestHandler;
  verifyToken: (token: string) => any;
  broadcastChange: (e: EntityChangedEvent) => void;
  closeDb: () => void; exit: (code: number) => void;
  fetch?: typeof fetch;
  scheduler?: { nextRunAt(): number | null };
  driveStore?: (conn: DriveConnection) => BackupTarget & BackupSource;
}

const TARGETS = ['local', 'drive'] as const;
type Target = typeof TARGETS[number];
const isTarget = (v: unknown): v is Target => typeof v === 'string' && (TARGETS as readonly string[]).includes(v);

export function registerBackupRoutes(app: express.Express, deps: BackupRouteDeps): void {
  const { db, authenticateToken, requireAdmin } = deps;
  const local = new LocalStore(deps.backupRoot);
  const targetFor = (t: Target): (BackupTarget & BackupSource) | null => {
    if (t === 'local') return local;
    const conn = readDrive(db, deps.mailCrypto);
    if (!conn || !deps.driveStore) return null;
    return deps.driveStore(conn);
  };

  // Run in the background; the response is the run id, progress arrives via
  // the backupRun change-feed event and GET /runs.
  const startRun = (t: Target, trigger: 'manual' | 'schedule'): Promise<string> => {
    const target = targetFor(t);
    if (!target) throw new Error(t === 'drive' ? 'Google Drive is not connected' : 'no target');
    if (isRunActive(db, t)) throw new BackupRunningError();
    const keep = readKeep(db)[t];
    const p = takeSnapshot(db, deps.dataDir, target, { trigger, keep, appVersion: deps.appVersion, env: deps.env });
    p.then(r => deps.broadcastChange({ type: 'backupRun', id: r.runId, action: 'updated' } as EntityChangedEvent))
     .catch(() => deps.broadcastChange({ type: 'backupRun', id: t, action: 'updated' } as EntityChangedEvent));
    // The run id is minted inside takeSnapshot; read it back from the newest running row.
    return new Promise((resolve) => setImmediate(() => {
      const row = db.prepare(`SELECT id FROM backup_runs WHERE target = ? ORDER BY startedAt DESC LIMIT 1`).get(t) as { id: string } | undefined;
      resolve(row?.id ?? '');
    }));
  };

  app.get('/api/backup/status', authenticateToken, requireAdmin, async (_req, res) => {
    const lastRun = (t: Target) => db.prepare(`SELECT * FROM backup_runs WHERE target = ? AND status != 'running' ORDER BY startedAt DESC LIMIT 1`).get(t) ?? null;
    const running = db.prepare(`SELECT * FROM backup_runs WHERE status = 'running' ORDER BY startedAt DESC LIMIT 1`).get() ?? null;
    const snaps = await local.listSnapshots();
    const objects = await local.listObjects();
    const drive = readDrive(db, deps.mailCrypto);
    res.json({
      root: deps.backupRoot, rootIsDefault: deps.backupRootIsDefault,
      lastRun: { local: lastRun('local'), drive: lastRun('drive') }, running,
      totals: { snapshots: snaps.length, objects: objects.size, bytes: snaps[0]?.counts.bytes ?? 0 },
      nextRunAt: deps.scheduler?.nextRunAt() ?? null,
      schedule: readSchedule(db), keep: readKeep(db),
      drive: drive ? { connected: true, email: drive.email, needsReconnect: !!drive.needsReconnect } : { connected: false, configurable: !!deps.env.GOOGLE_OAUTH_CLIENT_ID },
    });
  });

  app.post('/api/backup/run', authenticateToken, requireAdmin, async (req, res) => {
    const t = req.body?.target;
    if (!isTarget(t)) return res.status(400).json({ error: 'target must be local or drive' });
    try { res.status(202).json({ runId: await startRun(t, 'manual') }); }
    catch (e) {
      if (e instanceof BackupRunningError) return res.status(409).json({ error: e.message, code: 'backup_running' });
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get('/api/backup/runs', authenticateToken, requireAdmin, (_req, res) => {
    res.json(listRuns(db).map(r => ({ ...r, warnings: JSON.parse(r.warningsJson || '[]') })));
  });

  app.get('/api/backup/snapshots', authenticateToken, requireAdmin, async (req, res) => {
    const t = req.query.target;
    if (!isTarget(t)) return res.status(400).json({ error: 'target must be local or drive' });
    const target = targetFor(t);
    if (!target) return res.json([]);
    try { res.json(await target.listSnapshots()); }
    catch (e) { console.error('[backup] list snapshots failed', e); res.status(502).json({ error: (e as Error).message }); }
  });

  app.get('/api/backup/snapshots/:id/download', authenticateToken, requireAdmin, async (req, res) => {
    if (!isSnapshotId(req.params.id)) return res.status(400).json({ error: 'bad snapshot id' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="frugal-takeoff-backup-${req.params.id}.zip"`);
    try { await streamSnapshotZip(local, req.params.id, res); }
    catch (e) { console.error('[backup] download failed', e); if (!res.headersSent) res.status(404).json({ error: 'Snapshot not found' }); else res.destroy(); }
  });

  app.put('/api/backup/settings', authenticateToken, requireAdmin, (req, res) => {
    if (req.body?.schedule) writeSchedule(db, req.body.schedule);
    if (req.body?.keep) writeKeep(db, req.body.keep);
    res.json({ schedule: readSchedule(db), keep: readKeep(db) });
  });

  // Exposed for the scheduler (Task 9) and tests.
  (app as any).__backupStartRun = startRun;
}
```

If `EntityChangedEvent['type']` (server/realtime/changeFeed.ts, mirrored on the client where `useLiveQuery`'s `types` option is typed) is a closed union, add `'backupRun'` to it in both places rather than casting — the client tab subscribes to that type in Task 10.

```ts
```

- [ ] **Step 4: Wire `server.ts`** — after `registerEmailRoutes(...)`:

```ts
  const BACKUP_PATH = process.env.BACKUP_PATH || path.join(DATA_DIR, 'backup-store');
  registerBackupRoutes(app, {
    db, dataDir: DATA_DIR, backupRoot: BACKUP_PATH, backupRootIsDefault: !process.env.BACKUP_PATH,
    appVersion: APP_VERSION, env: process.env, publicUrl: process.env.APP_PUBLIC_URL || null, jwtSecret: JWT_SECRET,
    mailCrypto, authenticateToken, requireAdmin, verifyToken, broadcastChange,
    closeDb: () => db.close(), exit: code => process.exit(code),
    driveStore: conn => createDriveStore(conn, { db, env: process.env, mailCrypto, fetch: globalThis.fetch }),
  });
```
`APP_VERSION`: read once near the top of `server.ts` as `JSON.parse(fsSync.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version` — check whether a version constant already exists (grep `version` in `server.ts`); if not, add this. `createDriveStore` is defined in Task 8; until then wire `driveStore: undefined` and add the real line in Task 8. Also extend the parser bypass now: `const ownParser = (p: string) => p.startsWith('/api/mail/uploads') || p === '/api/setup/restore/upload' || p === WEBHOOK_PATH || p === GOOGLE_WEBHOOK_PATH;`.

- [ ] **Step 5: Verify** — `npm test -- server/backup && npm run lint` → PASS. Also `npm test -- server/routes.test.ts` (unchanged) → PASS.

- [ ] **Step 6: Commit** — `git add server/backup server.ts && git commit -m "feat(backup): settings, admin routes (status/run/runs/snapshots/download/settings), server wiring"`

---

### Task 7: Setup mode + restore routes

**Files:**
- Modify: `server/backup/routes.ts` (append inside `registerBackupRoutes`), `server/backup/routes.test.ts`

**Interfaces:**
- Consumes: `isFreshInstall`, `restoreSnapshot`, `RestoreRefusedError`, `DEFAULT_ADMIN_ID` (Task 5); `unpackSnapshotZip` (Task 4); `LocalStore` (Task 2).
- Produces routes: `GET /api/setup/state`; `GET /api/setup/restore/sources`; `POST /api/setup/restore/upload` (raw octet-stream body → `{ uploadId, snapshotId, summary }`); `POST /api/setup/restore` `{ source, snapshotId, uploadId? }` → `{ restarting: true, files, bytes }`. Drive-source routes are added in Task 8 using the same `setupOnly` guard.

- [ ] **Step 1: Write the failing tests** — append to `server/backup/routes.test.ts`:

```ts
describe('setup mode + restore', () => {
  const asDefaultAdmin = () => mkApp({}, { id: 'admin-id-123', role: 'admin' });

  it('GET /api/setup/state is public and flips once data exists', async () => {
    const pub = mkApp({}, null);
    expect((await request(pub).get('/api/setup/state')).body).toEqual({ fresh: true });
    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p', 'x', 1);
    expect((await request(pub).get('/api/setup/state')).body).toEqual({ fresh: false });
  });

  it('restore routes 409 not_fresh once data exists, and 403 for a non-default user even when fresh', async () => {
    const a = asDefaultAdmin();
    expect((await request(a).get('/api/setup/restore/sources')).status).toBe(200);
    expect((await request(mkApp({}, { id: 'u9', role: 'admin' })).get('/api/setup/restore/sources')).status).toBe(403);
    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p', 'x', 1);
    const r = await request(a).get('/api/setup/restore/sources');
    expect(r.status).toBe(409); expect(r.body.code).toBe('not_fresh');
  });

  it('sources lists local snapshots; upload unpacks a zip; restore rebuilds and calls finish (closeDb + exit) after responding', async () => {
    // Build a snapshot from a populated source db in another dir, then restore it into this fresh one.
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-src-')); const srcDb = openDb(path.join(srcDir, 'app.db')); runMigrations(srcDb, srcDir, migrations);
    fs.writeFileSync(path.join(srcDir, 'mail.key'), 'k'.repeat(64) + '\n');
    srcDb.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Job', 1);
    putBuffer(srcDb, srcDir, 'f-1', Buffer.from('plan'), 'application/pdf', { kind: 'document', name: 'plan.pdf', projectId: 'p1' });
    const { takeSnapshot } = await import('./snapshot');
    const snap = await takeSnapshot(srcDb, srcDir, new LocalStore(root), { trigger: 'manual', keep: 5, appVersion: '3.2.0', env: {} });

    const closeDb = vi.fn(); const exit = vi.fn();
    const a = mkApp({ closeDb, exit }, { id: 'admin-id-123', role: 'admin' });
    const sources = await request(a).get('/api/setup/restore/sources');
    expect(sources.body.local.map((s: any) => s.id)).toEqual([snap.snapshotId]);
    expect(sources.body.root).toBe(root);

    // upload path
    const zipPath = path.join(root, 'u.zip');
    const { streamSnapshotZip } = await import('./zip');
    await streamSnapshotZip(new LocalStore(root), snap.snapshotId, fs.createWriteStream(zipPath));
    await new Promise(r => setTimeout(r, 100));
    const up = await request(a).post('/api/setup/restore/upload').set('Content-Type', 'application/octet-stream').send(fs.readFileSync(zipPath));
    expect(up.status).toBe(200); expect(up.body.snapshotId).toBe(snap.snapshotId); expect(up.body.summary.counts.files).toBe(1);

    const r = await request(a).post('/api/setup/restore').send({ source: 'upload', uploadId: up.body.uploadId, snapshotId: snap.snapshotId });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ restarting: true, files: 1 });
    await new Promise(res => setTimeout(res, 50));
    expect(closeDb).toHaveBeenCalledTimes(1); expect(exit).toHaveBeenCalledWith(0);
    expect(fs.existsSync(pathFor(dataDir, 'f-1'))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'mail.key'), 'utf8')).toBe('k'.repeat(64) + '\n');
  });

  it('restore of a newer-schema snapshot → 400 with both versions named', async () => {
    const st = new LocalStore(root);
    const dir = st.snapshotDir('20260901-000000'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.db'), 'x');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: 1, createdAt: 1, appVersion: '9', schemaVersion: 999, db: { size: 1, sha256: 'x' }, mailKey: { source: 'env' }, files: [], counts: { files: 0, bytes: 0 }, warnings: [] }));
    const r = await request(asDefaultAdmin()).post('/api/setup/restore').send({ source: 'local', snapshotId: '20260901-000000' });
    expect(r.status).toBe(400); expect(r.body.error).toMatch(/999/);
  });
});
```
(Add `import { vi } from 'vitest'` and `import { pathFor } from '../fileStore'` at the top of the test file; the `mkApp(over, user)` helper must accept `user = null` meaning "no auth" — change its `authenticateToken` stub to `if (!user) return res.status(401).json({ error: 'Authentication required' }); req.user = user; next();`.)

Run: `npm test -- server/backup/routes.test.ts -t "setup mode"` → FAIL.

- [ ] **Step 2: Implement** — append inside `registerBackupRoutes` (imports: `isFreshInstall, restoreSnapshot, RestoreRefusedError, DEFAULT_ADMIN_ID` from `./restore`; `unpackSnapshotZip` from `./zip`; `fs`, `os`, `path`, `pipeline` from `'stream/promises'`, `v4 as uuidv4` from `'uuid'`):

```ts
  // ── Fresh-install restore (spec §Setup mode and restore) ─────────────────
  app.get('/api/setup/state', (_req, res) => res.json({ fresh: isFreshInstall(db) }));

  // Fresh + signed in as the bootstrap admin: the only identity a fresh
  // install can have, and it stops a LAN stranger restoring over an empty box.
  const setupOnly: express.RequestHandler[] = [authenticateToken, (req, res, next) => {
    if ((req as any).user?.id !== DEFAULT_ADMIN_ID) return res.status(403).json({ error: 'Only the initial admin account can restore' });
    if (!isFreshInstall(db)) return res.status(409).json({ error: 'This server already has data — restore is only offered on a fresh install', code: 'not_fresh' });
    next();
  }];

  const uploadsDir = path.join(os.tmpdir(), 'ft-restore-uploads');
  const uploadStore = (uploadId: string): LocalStore => {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new RestoreRefusedError('bad upload id');
    return new LocalStore(path.join(uploadsDir, uploadId));
  };
  // Setup-mode Drive grant lives here in memory only (Task 8 fills it).
  const setupDrive: { conn: DriveConnection | null } = { conn: null };

  app.get('/api/setup/restore/sources', ...setupOnly, async (_req, res) => {
    res.json({
      root: deps.backupRoot, local: await local.listSnapshots(),
      drive: { configurable: !!deps.env.GOOGLE_OAUTH_CLIENT_ID && !!deps.publicUrl, connected: !!setupDrive.conn, email: setupDrive.conn?.email ?? null },
    });
  });

  // Raw body streamed to disk (server.ts skips the JSON parser for this path).
  app.post('/api/setup/restore/upload', ...setupOnly, async (req, res) => {
    const uploadId = uuidv4();
    const dir = path.join(uploadsDir, uploadId); fs.mkdirSync(dir, { recursive: true });
    const zipPath = path.join(dir, 'upload.zip');
    try {
      await pipeline(req, fs.createWriteStream(zipPath));
      const { snapshotId } = await unpackSnapshotZip(zipPath, dir);
      fs.unlinkSync(zipPath);
      const summary = (await uploadStore(uploadId).listSnapshots())[0];
      res.json({ uploadId, snapshotId, summary });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      res.status(400).json({ error: `That file is not a snapshot zip: ${(e as Error).message}` });
    }
  });

  app.post('/api/setup/restore', ...setupOnly, async (req, res) => {
    const { source, snapshotId, uploadId } = req.body ?? {};
    if (!isSnapshotId(String(snapshotId))) return res.status(400).json({ error: 'bad snapshot id' });
    let src: BackupSource;
    try {
      if (source === 'local') src = local;
      else if (source === 'upload') src = uploadStore(String(uploadId));
      else if (source === 'drive') { if (!setupDrive.conn || !deps.driveStore) return res.status(400).json({ error: 'Google Drive is not connected' }); src = deps.driveStore(setupDrive.conn); }
      else return res.status(400).json({ error: 'source must be local, upload or drive' });
      const r = await restoreSnapshot(src, snapshotId, { dataDir: deps.dataDir, closeDb: deps.closeDb, exit: deps.exit });
      res.json({ restarting: true, files: r.files, bytes: r.bytes });
      // After the response is flushed: swap the db and exit for the restart.
      res.on('finish', () => setImmediate(() => { try { r.finish(); } catch (e) { console.error('[backup] restore finish failed', e); } }));
    } catch (e) {
      if (e instanceof RestoreRefusedError) return res.status(400).json({ error: e.message });
      console.error('[backup] restore failed', e);
      res.status(500).json({ error: 'Restore failed — the server was left as it was. See the server log.' });
    }
  });
  (app as any).__setupDrive = setupDrive; // Task 8 attaches the setup-mode Drive grant here
```

- [ ] **Step 3: Verify** — `npm test -- server/backup && npm run lint` → PASS.

- [ ] **Step 4: Commit** — `git add server/backup && git commit -m "feat(backup): fresh-install setup state, upload, and restore routes"`

---

### Task 8: `DriveStore` + Drive OAuth (admin and setup mode)

**Files:**
- Create: `server/backup/drive.ts`, `server/backup/drive.test.ts`
- Modify: `server/backup/routes.ts` (Drive routes), `server/backup/routes.test.ts`, `server.ts` (`driveStore` dep)

**Interfaces:**
- Consumes: `TokenSource` (`server/mail/providers/tokenSource.ts`), `googleRefresh` (`server/mail/providers/google.ts`), `createVerifier/challengeOf` (`server/mail/oauth.ts`), `DriveConnection`/`readDrive`/`writeDrive` (Task 6), `jsonwebtoken`.
- Produces:
```ts
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_STATE_TYP = 'backup_drive_state';
export const ROOT_FOLDER_NAME = 'Frugal Takeoff Backups';
export function driveRedirectUri(publicUrl: string, mode: 'admin' | 'setup'): string   // /api/backup/drive/callback | /api/setup/restore/drive/callback
export function driveAuthUrl(env, publicUrl, mode, state, codeChallenge): string
export function signDriveState(jwtSecret, payload: { mode: 'admin' | 'setup'; verifier: string }): string
export function verifyDriveState(jwtSecret, state): { mode: 'admin' | 'setup'; verifier: string }
export function driveExchange(env, publicUrl, mode, code, verifier, fetchFn): Promise<{ refreshToken: string; email: string }>
/** Finds-or-creates the root, objects/ and snapshots/ folders. */
export function ensureDriveFolders(access: () => Promise<string>, fetchFn): Promise<{ folderId; objectsFolderId; snapshotsFolderId }>
export class DriveStore implements BackupTarget, BackupSource { constructor(conn: DriveConnection, opts: { env; fetch; onRotate?: (t: string) => void; onAuthExpired?: () => void }) }
export function createDriveStore(conn: DriveConnection, opts: { db; env; mailCrypto; fetch }): DriveStore  // wires onRotate/onAuthExpired to writeDrive
```

- [ ] **Step 1: Write the failing tests** — `server/backup/drive.test.ts` (a fake Drive over an injected fetch that keeps files in a Map; model the fake on how `server/mail/providers/google.test.ts` fakes Gmail):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { DriveStore, ensureDriveFolders, driveAuthUrl, signDriveState, verifyDriveState, DRIVE_SCOPE } from './drive';
import type { Manifest } from './types';

// Minimal Drive v3 fake: folders + files with parents, list with q, media
// download, resumable upload (initiate → PUT chunks), delete. Pages at 2.
class FakeDrive {
  files = new Map<string, { name: string; parents: string[]; mime: string; data?: Buffer }>();
  next = 1; failNextUploadWith: number | null = null; calls: string[] = [];
  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url); this.calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    if (u.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'AT', expires_in: 3600 });
    if (u.pathname === '/drive/v3/files' && (init.method ?? 'GET') === 'GET') {
      const q = u.searchParams.get('q') ?? ''; const parent = /'([^']+)' in parents/.exec(q)?.[1]; const name = /name = '([^']+)'/.exec(q)?.[1];
      const all = [...this.files].filter(([, f]) => (!parent || f.parents.includes(parent)) && (!name || f.name === name)).map(([id, f]) => ({ id, name: f.name, mimeType: f.mime }));
      const start = Number(u.searchParams.get('pageToken') ?? 0); const page = all.slice(start, start + 2);
      return Response.json({ files: page, nextPageToken: start + 2 < all.length ? String(start + 2) : undefined });
    }
    if (u.pathname === '/drive/v3/files' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)); const id = `id${this.next++}`;
      this.files.set(id, { name: body.name, parents: body.parents ?? [], mime: body.mimeType ?? 'application/octet-stream' });
      return Response.json({ id });
    }
    if (u.pathname === '/upload/drive/v3/files' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)); const id = `id${this.next++}`;
      this.files.set(id, { name: body.name, parents: body.parents ?? [], mime: 'application/octet-stream', data: Buffer.alloc(0) });
      return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/session/${id}` } });
    }
    if (u.pathname.startsWith('/upload/session/') && init.method === 'PUT') {
      if (this.failNextUploadWith) { const s = this.failNextUploadWith; this.failNextUploadWith = null; return new Response('busy', { status: s }); }
      const id = u.pathname.split('/').pop()!; const f = this.files.get(id)!;
      f.data = Buffer.concat([f.data!, Buffer.from(init.body as ArrayBuffer)]);
      const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(String((init.headers as any)['Content-Range']))!;
      return Number(range[2]) + 1 === Number(range[3]) ? Response.json({ id }) : new Response(null, { status: 308 });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (m && init.method === 'DELETE') { this.files.delete(m[1]); return new Response(null, { status: 204 }); }
    if (m && u.searchParams.get('alt') === 'media') return new Response(this.files.get(m[1])!.data);
    return new Response('nope', { status: 404 });
  };
}

let fake: FakeDrive;
beforeEach(() => { fake = new FakeDrive(); });
const env = { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'sec' } as NodeJS.ProcessEnv;
const manifest = (files: Manifest['files']): Manifest => ({ format: 1, createdAt: 1, appVersion: '3.2.0', schemaVersion: 36, db: { size: 2, sha256: 'd' }, mailKey: { source: 'env' }, files, counts: { files: files.length, bytes: 0 }, warnings: [] });

describe('drive oauth helpers', () => {
  it('auth url carries only the drive.file scope and the mode-specific redirect; state round-trips and rejects a mail state', async () => {
    const url = new URL(driveAuthUrl(env, 'https://app.example', 'admin', 'S', 'C'));
    expect(url.searchParams.get('scope')).toBe(DRIVE_SCOPE);
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/api/backup/drive/callback');
    expect(new URL(driveAuthUrl(env, 'https://app.example', 'setup', 'S', 'C')).searchParams.get('redirect_uri')).toBe('https://app.example/api/setup/restore/drive/callback');
    const s = signDriveState('secret', { mode: 'setup', verifier: 'v' });
    expect(verifyDriveState('secret', s)).toEqual({ mode: 'setup', verifier: 'v' });
    const { signState } = await import('../mail/oauth');
    expect(() => verifyDriveState('secret', signState('secret', { userId: 'u', provider: 'google', verifier: 'v' }))).toThrow();
  });
});

describe('DriveStore', () => {
  const mk = async () => {
    const folders = await ensureDriveFolders(async () => 'AT', fake.fetch as any);
    return new DriveStore({ refreshToken: 'r', email: 'a@b', ...folders }, { env, fetch: fake.fetch as any });
  };
  it('ensureDriveFolders creates root/objects/snapshots once and finds them next time', async () => {
    const a = await ensureDriveFolders(async () => 'AT', fake.fetch as any);
    const b = await ensureDriveFolders(async () => 'AT', fake.fetch as any);
    expect(a).toEqual(b); expect([...fake.files.values()].filter(f => f.name === 'Frugal Takeoff Backups').length).toBe(1);
  });
  it('listObjects pages through objects/; putObject is resumable and retries once on 503', async () => {
    const st = await mk();
    for (const n of ['a', 'b', 'c']) await st.putObject(n.repeat(64), () => Readable.from([Buffer.from(n)]), 1);
    expect(await st.listObjects()).toEqual(new Set(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]));
    fake.failNextUploadWith = 503;
    await st.putObject('d'.repeat(64), () => Readable.from([Buffer.from('dd')]), 2);
    expect([...fake.files.values()].find(f => f.name === 'd'.repeat(64))!.data!.toString()).toBe('dd');
  });
  it('writeSnapshot uploads app.db, mail.key, then manifest last; listSnapshots/readManifest/openObject round-trip; prune deletes', async () => {
    const st = await mk();
    const fs = await import('fs'); const os = await import('os'); const path = await import('path');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-dr-')); fs.writeFileSync(path.join(d, 'db'), 'DB'); fs.writeFileSync(path.join(d, 'k'), 'K');
    await st.putObject('e'.repeat(64), () => Readable.from([Buffer.from('E')]), 1);
    await st.writeSnapshot('20260912-000000', { dbPath: path.join(d, 'db'), mailKeyPath: path.join(d, 'k'), manifest: manifest([{ id: 'f', sha256: 'e'.repeat(64), size: 1 }]) });
    const names = fake.calls.filter(c => c.startsWith('POST /upload')).length; expect(names).toBeGreaterThanOrEqual(4);
    const uploadOrder = [...fake.files.values()].map(f => f.name);
    expect(uploadOrder.indexOf('manifest.json')).toBeGreaterThan(uploadOrder.indexOf('app.db'));
    expect((await st.listSnapshots()).map(s => s.id)).toEqual(['20260912-000000']);
    expect((await st.readManifest('20260912-000000')).files[0].id).toBe('f');
    const chunks: Buffer[] = []; for await (const c of (await st.openObject('e'.repeat(64))) as any) chunks.push(c);
    expect(Buffer.concat(chunks).toString()).toBe('E');
    await st.deleteSnapshot('20260912-000000'); await st.deleteObject('e'.repeat(64));
    expect(await st.listSnapshots()).toEqual([]); expect((await st.listObjects()).size).toBe(0);
  });
});
```

Run: `npm test -- server/backup/drive.test.ts` → FAIL.

- [ ] **Step 2: Implement `server/backup/drive.ts`**

```ts
// server/backup/drive.ts — Google Drive as a backup target/source (spec §Drive specifics).
// Raw fetch + the mail subsystem's TokenSource, exactly like the Gmail provider.
import fs from 'fs';
import { Readable } from 'stream';
import { randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import type Database from 'better-sqlite3';
import { TokenSource } from '../mail/providers/tokenSource';
import { googleRefresh } from '../mail/providers/google';
import { AuthExpiredError } from '../mail/providers/types';
import type { MailCrypto } from '../mail/crypto';
import { readDrive, writeDrive, type DriveConnection } from './settings';
import type { BackupSource, BackupTarget, Manifest, SnapshotSummary } from './types';
import { isSnapshotId } from './types';
import { summarize } from './store';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_STATE_TYP = 'backup_drive_state';
export const ROOT_FOLDER_NAME = 'Frugal Takeoff Backups';
const API = 'https://www.googleapis.com/drive/v3/';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const CHUNK = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
type Mode = 'admin' | 'setup';

export const driveRedirectUri = (publicUrl: string, mode: Mode): string =>
  `${publicUrl.replace(/\/+$/, '')}${mode === 'admin' ? '/api/backup/drive/callback' : '/api/setup/restore/drive/callback'}`;

export function driveAuthUrl(env: NodeJS.ProcessEnv, publicUrl: string, mode: Mode, state: string, codeChallenge: string): string {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set');
  const q = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID, redirect_uri: driveRedirectUri(publicUrl, mode), response_type: 'code',
    scope: DRIVE_SCOPE, access_type: 'offline', prompt: 'consent', state, code_challenge: codeChallenge, code_challenge_method: 'S256',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}
export function signDriveState(jwtSecret: string, p: { mode: Mode; verifier: string }): string {
  return jwt.sign({ ...p, nonce: randomBytes(8).toString('hex'), typ: DRIVE_STATE_TYP }, jwtSecret, { algorithm: 'HS256', expiresIn: 600 });
}
export function verifyDriveState(jwtSecret: string, state: string): { mode: Mode; verifier: string } {
  const c = jwt.verify(state, jwtSecret, { algorithms: ['HS256'] }) as any;
  if (c?.typ !== DRIVE_STATE_TYP || (c.mode !== 'admin' && c.mode !== 'setup') || typeof c.verifier !== 'string') throw new Error('not a Drive connect state');
  return { mode: c.mode, verifier: c.verifier };
}
export async function driveExchange(env: NodeJS.ProcessEnv, publicUrl: string, mode: Mode, code: string, verifier: string, fetchFn: typeof fetch): Promise<{ refreshToken: string; email: string }> {
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID!, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: driveRedirectUri(publicUrl, mode) }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !body.access_token) throw new Error(`${body.error || res.status}: Google rejected the Drive sign-in`);
  if (!body.refresh_token) throw new Error("No refresh token returned — remove the app from your Google account's third-party access and try again");
  const info = await fetchFn('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: `Bearer ${body.access_token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const about = (await info.json().catch(() => ({}))) as any;
  return { refreshToken: String(body.refresh_token), email: String(about?.user?.emailAddress ?? '') };
}

type Access = () => Promise<string>;
async function api<T>(access: Access, fetchFn: typeof fetch, path: string, init: RequestInit & { query?: Record<string, string | undefined> } = {}): Promise<T> {
  const { query, ...rest } = init;
  const url = new URL(path.startsWith('http') ? path : API + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetchFn(url.toString(), { ...rest, headers: { ...(rest.headers as any), Authorization: `Bearer ${await access()}`, ...(rest.body && !(rest.body instanceof ArrayBuffer) ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 401) throw new AuthExpiredError('Google rejected the Drive token');
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  if (res.status === 204) return undefined as T;
  const text = await res.text(); return (text ? JSON.parse(text) : undefined) as T;
}
const listAll = async (access: Access, fetchFn: typeof fetch, q: string, fields = 'files(id,name,mimeType)'): Promise<{ id: string; name: string; mimeType: string }[]> => {
  const out: any[] = []; let pageToken: string | undefined;
  do {
    const r = await api<{ files: any[]; nextPageToken?: string }>(access, fetchFn, 'files', { query: { q, fields: `nextPageToken,${fields}`, pageSize: '1000', pageToken, spaces: 'drive' } });
    out.push(...(r.files ?? [])); pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
};
const findOrCreateFolder = async (access: Access, fetchFn: typeof fetch, name: string, parent: string | null): Promise<string> => {
  const q = `name = '${name}' and mimeType = '${FOLDER}' and trashed = false` + (parent ? ` and '${parent}' in parents` : '');
  const found = await listAll(access, fetchFn, q);
  if (found[0]) return found[0].id;
  const r = await api<{ id: string }>(access, fetchFn, 'files', { method: 'POST', body: JSON.stringify({ name, mimeType: FOLDER, parents: parent ? [parent] : undefined }) });
  return r.id;
};
export async function ensureDriveFolders(access: Access, fetchFn: typeof fetch): Promise<{ folderId: string; objectsFolderId: string; snapshotsFolderId: string }> {
  const folderId = await findOrCreateFolder(access, fetchFn, ROOT_FOLDER_NAME, null);
  return { folderId, objectsFolderId: await findOrCreateFolder(access, fetchFn, 'objects', folderId), snapshotsFolderId: await findOrCreateFolder(access, fetchFn, 'snapshots', folderId) };
}

export class DriveStore implements BackupTarget, BackupSource {
  readonly kind = 'drive' as const;
  private tokens: TokenSource;
  private access: Access;
  constructor(private conn: DriveConnection, private opts: { env: NodeJS.ProcessEnv; fetch: typeof fetch; onRotate?: (t: string) => void; onAuthExpired?: () => void }) {
    this.tokens = new TokenSource({ refreshToken: conn.refreshToken, refresh: t => googleRefresh(opts.env, t, opts.fetch), onRotate: opts.onRotate });
    this.access = async () => { try { return await this.tokens.get(); } catch (e) { if (e instanceof AuthExpiredError) opts.onAuthExpired?.(); throw e; } };
  }
  private call<T>(path: string, init?: RequestInit & { query?: Record<string, string | undefined> }): Promise<T> { return api<T>(this.access, this.opts.fetch, path, init); }

  async listObjects(): Promise<Set<string>> {
    return new Set((await listAll(this.access, this.opts.fetch, `'${this.conn.objectsFolderId}' in parents and trashed = false`, 'files(name)')).map(f => f.name));
  }
  private async upload(name: string, parent: string, source: () => NodeJS.ReadableStream, size: number): Promise<void> {
    const attempt = async (): Promise<void> => {
      const init = await this.opts.fetch(`${UPLOAD}?uploadType=resumable`, {
        method: 'POST', headers: { Authorization: `Bearer ${await this.access()}`, 'Content-Type': 'application/json', 'X-Upload-Content-Length': String(size) },
        body: JSON.stringify({ name, parents: [parent] }), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (init.status === 401) throw new AuthExpiredError('Google rejected the Drive token');
      const session = init.headers.get('Location'); if (!init.ok || !session) throw new Error(`Drive upload init ${init.status}`);
      let offset = 0; let buf = Buffer.alloc(0);
      const flush = async (final: boolean) => {
        if (!buf.length && !final) return;
        const end = offset + buf.length - 1;
        const r = await this.opts.fetch(session, { method: 'PUT', headers: { 'Content-Length': String(buf.length), 'Content-Range': `bytes ${offset}-${end}/${size}` }, body: buf as any, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`Drive upload ${r.status}`), { retryable: true });
        if (!r.ok && r.status !== 308) throw new Error(`Drive upload ${r.status}`);
        offset += buf.length; buf = Buffer.alloc(0);
      };
      for await (const chunk of source() as AsyncIterable<Buffer>) { buf = Buffer.concat([buf, chunk]); if (buf.length >= CHUNK) await flush(false); }
      await flush(true);
    };
    try { await attempt(); }
    catch (e: any) { if (!e?.retryable) throw e; await new Promise(r => setTimeout(r, 1000)); await attempt(); }
  }
  async putObject(sha256: string, source: () => NodeJS.ReadableStream, size: number): Promise<void> { await this.upload(sha256, this.conn.objectsFolderId, source, size); }
  async writeSnapshot(id: string, files: { dbPath: string; mailKeyPath: string | null; manifest: Manifest }): Promise<void> {
    const folder = await findOrCreateFolder(this.access, this.opts.fetch, id, this.conn.snapshotsFolderId);
    const up = (name: string, p: string) => this.upload(name, folder, () => fs.createReadStream(p), fs.statSync(p).size);
    await up('app.db', files.dbPath);
    if (files.mailKeyPath) await up('mail.key', files.mailKeyPath);
    const m = Buffer.from(JSON.stringify(files.manifest, null, 2));
    await this.upload('manifest.json', folder, () => Readable.from([m]), m.length); // LAST
  }
  private async snapshotFolder(id: string): Promise<string | null> {
    if (!isSnapshotId(id)) throw new Error('bad snapshot id');
    return (await listAll(this.access, this.opts.fetch, `name = '${id}' and '${this.conn.snapshotsFolderId}' in parents and trashed = false`))[0]?.id ?? null;
  }
  private async fileIn(folderId: string, name: string): Promise<string | null> {
    return (await listAll(this.access, this.opts.fetch, `name = '${name}' and '${folderId}' in parents and trashed = false`))[0]?.id ?? null;
  }
  private async download(fileId: string): Promise<NodeJS.ReadableStream> {
    const r = await this.opts.fetch(`${API}files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${await this.access()}` }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!r.ok || !r.body) throw new Error(`Drive download ${r.status}`);
    return Readable.fromWeb(r.body as any);
  }
  async readManifest(id: string): Promise<Manifest> {
    const folder = await this.snapshotFolder(id); const fid = folder && await this.fileIn(folder, 'manifest.json');
    if (!fid) throw new Error('Snapshot not found on Drive');
    const chunks: Buffer[] = []; for await (const c of (await this.download(fid)) as AsyncIterable<Buffer>) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Manifest;
  }
  async listSnapshots(): Promise<SnapshotSummary[]> {
    const folders = await listAll(this.access, this.opts.fetch, `'${this.conn.snapshotsFolderId}' in parents and mimeType = '${FOLDER}' and trashed = false`);
    const out: SnapshotSummary[] = [];
    for (const f of folders) { if (!isSnapshotId(f.name)) continue; try { out.push(summarize(f.name, await this.readManifest(f.name))); } catch { /* incomplete snapshot: no manifest */ } }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }
  async deleteSnapshot(id: string): Promise<void> { const f = await this.snapshotFolder(id); if (f) await this.call(`files/${f}`, { method: 'DELETE' }); }
  async deleteObject(sha256: string): Promise<void> { const f = await this.fileIn(this.conn.objectsFolderId, sha256); if (f) await this.call(`files/${f}`, { method: 'DELETE' }); }
  async openObject(sha256: string): Promise<NodeJS.ReadableStream> { const f = await this.fileIn(this.conn.objectsFolderId, sha256); if (!f) throw new Error(`object ${sha256} missing on Drive`); return this.download(f); }
  async openSnapshotFile(id: string, name: 'app.db' | 'mail.key'): Promise<NodeJS.ReadableStream> { const folder = await this.snapshotFolder(id); const f = folder && await this.fileIn(folder, name); if (!f) throw new Error(`${name} missing on Drive`); return this.download(f); }
}

export function createDriveStore(conn: DriveConnection, o: { db: Database.Database; env: NodeJS.ProcessEnv; mailCrypto: MailCrypto; fetch: typeof fetch }): DriveStore {
  return new DriveStore(conn, {
    env: o.env, fetch: o.fetch,
    onRotate: t => { const c = readDrive(o.db, o.mailCrypto); if (c) writeDrive(o.db, o.mailCrypto, { ...c, refreshToken: t }); },
    onAuthExpired: () => { const c = readDrive(o.db, o.mailCrypto); if (c) writeDrive(o.db, o.mailCrypto, { ...c, needsReconnect: true }); },
  });
}
```
(The `FakeDrive` test's `q` parser expects the exact `name = '...'` / `'<id>' in parents` phrasing used above — keep them in sync.)

- [ ] **Step 3: Drive routes** — append inside `registerBackupRoutes` (imports from `./drive`: `driveAuthUrl, signDriveState, verifyDriveState, driveExchange, ensureDriveFolders`; from `../mail/oauth`: `createVerifier, challengeOf`; from `./settings`: `writeDrive`):

```ts
  // ── Google Drive connect (admin) and setup-mode connect ─────────────────
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const authOrQueryToken: express.RequestHandler = (req, res, next) => {
    const t = typeof req.query.token === 'string' ? req.query.token : null;
    if (t) { const u = deps.verifyToken(t); if (!u) return res.status(401).json({ error: 'Invalid token' }); (req as any).user = u; return next(); }
    return authenticateToken(req, res, next);
  };
  const startDrive = (mode: 'admin' | 'setup'): express.RequestHandler => (_req, res) => {
    if (!deps.publicUrl) return res.status(503).json({ error: 'APP_PUBLIC_URL is not set — see Settings → Mail → Server setup guide' });
    const verifier = createVerifier();
    try {
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.redirect(driveAuthUrl(deps.env, deps.publicUrl, mode, signDriveState(deps.jwtSecret, { mode, verifier }), challengeOf(verifier)));
    } catch (e: any) { res.status(503).json({ error: e?.message || 'Google Drive is not configured' }); }
  };
  const callbackDrive = (mode: 'admin' | 'setup'): express.RequestHandler => async (req, res) => {
    const back = (params: string) => res.redirect(mode === 'admin' ? `/settings?tab=backup&${params}` : `/restore?${params}`);
    const failed = (m: string) => back(`error=${encodeURIComponent(m.slice(0, 300))}`);
    if (!deps.publicUrl) return failed('APP_PUBLIC_URL is not set on this server');
    if (req.query.error) return failed('Google did not complete the sign-in — please try again');
    const code = typeof req.query.code === 'string' ? req.query.code : ''; const raw = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !raw) return failed('That sign-in did not come back with everything we need — please try again');
    let st: { mode: 'admin' | 'setup'; verifier: string };
    try { st = verifyDriveState(deps.jwtSecret, raw); } catch { return failed('That sign-in link expired or was not issued by this app'); }
    if (st.mode !== mode) return failed('That sign-in was started from a different screen');
    if (mode === 'setup' && !isFreshInstall(db)) return failed('This server already has data');
    try {
      const { refreshToken, email } = await driveExchange(deps.env, deps.publicUrl, mode, code, st.verifier, fetchFn);
      const tokens = new TokenSource({ refreshToken, refresh: t => googleRefresh(deps.env, t, fetchFn) });
      const folders = await ensureDriveFolders(() => tokens.get(), fetchFn);
      const conn: DriveConnection = { refreshToken, email, ...folders };
      if (mode === 'admin') writeDrive(db, deps.mailCrypto, conn); else setupDrive.conn = conn;
      back('drive=connected');
    } catch (e) { console.error('[backup] drive connect failed', e); failed((e as Error).message); }
  };
  app.get('/api/backup/drive/start', authOrQueryToken, requireAdmin, startDrive('admin'));
  app.get('/api/backup/drive/callback', callbackDrive('admin'));
  app.delete('/api/backup/drive', authenticateToken, requireAdmin, (_req, res) => { writeDrive(db, deps.mailCrypto, null); res.json({ ok: true }); });
  app.get('/api/setup/restore/drive/start', authOrQueryToken, ...setupOnly.slice(1), startDrive('setup'));
  app.get('/api/setup/restore/drive/callback', callbackDrive('setup'));
  app.get('/api/setup/restore/drive/snapshots', ...setupOnly, async (_req, res) => {
    if (!setupDrive.conn || !deps.driveStore) return res.status(400).json({ error: 'Google Drive is not connected' });
    try { res.json(await deps.driveStore(setupDrive.conn).listSnapshots()); } catch (e) { res.status(502).json({ error: (e as Error).message }); }
  });
```
(imports: `TokenSource` from `../mail/providers/tokenSource`, `googleRefresh` from `../mail/providers/google`.) The `setupOnly` array from Task 7 must be declared BEFORE this block — place this block after Task 7's code. In `server.ts` set `driveStore: conn => createDriveStore(conn, { db, env: process.env, mailCrypto, fetch: globalThis.fetch })` (import from `./server/backup/drive`).

- [ ] **Step 4: Route tests** — append to `server/backup/routes.test.ts`:

```ts
describe('drive routes', () => {
  it('start redirects to Google with the drive.file scope; disconnect clears the connection; setup start requires fresh', async () => {
    const a = mkApp({ publicUrl: 'https://app.example', env: { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 's' } });
    const r = await request(a).get('/api/backup/drive/start');
    expect(r.status).toBe(302); expect(r.headers.location).toMatch(/drive\.file/); expect(r.headers.location).toMatch(/backup%2Fdrive%2Fcallback/);
    expect((await request(a).delete('/api/backup/drive')).status).toBe(200);
    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p', 'x', 1);
    expect((await request(mkApp({ publicUrl: 'https://app.example', env: { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 's' } }, { id: 'admin-id-123', role: 'admin' })).get('/api/setup/restore/drive/start')).status).toBe(409);
  });
  it('callback with a mail-oauth state is refused (redirects with error)', async () => {
    const { signState } = await import('../mail/oauth');
    const a = mkApp({ publicUrl: 'https://app.example' });
    const r = await request(a).get(`/api/backup/drive/callback?code=c&state=${signState('s', { userId: 'u', provider: 'google', verifier: 'v' })}`);
    expect(r.status).toBe(302); expect(r.headers.location).toMatch(/tab=backup&error=/);
  });
});
```

- [ ] **Step 5: Verify** — `npm test -- server/backup && npm run lint` → PASS.

- [ ] **Step 6: Commit** — `git add server/backup server.ts && git commit -m "feat(backup): Google Drive store (resumable uploads, listing, prune) and Drive connect for admin + setup mode"`

---

### Task 9: Scheduler

**Files:**
- Create: `server/backup/scheduler.ts`, `server/backup/scheduler.test.ts`
- Modify: `server.ts` (start it; pass `scheduler` into `registerBackupRoutes` deps), `server/backup/routes.ts` (export `startRun` via a returned handle instead of `(app as any).__backupStartRun`)

**Interfaces (produces):**
```ts
export interface SchedulerDeps {
  db: Database.Database;
  run: (target: 'local' | 'drive', trigger: 'schedule') => Promise<unknown>;  // routes' startRun
  hasDrive: () => boolean;
  now?: () => number; setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout;
}
export class BackupScheduler { constructor(deps); start(): void; stop(): void; nextRunAt(): number | null; /** for tests */ tick(): Promise<void> }
export function nextOccurrence(now: number, hour: number, minute: number): number  // local time, today if still ahead else tomorrow
```
`registerBackupRoutes` now returns `{ startRun }` (change its signature to `: { startRun: (t, trigger) => Promise<string> }` and drop the `__backupStartRun` hack; update Task 6's test file if it referenced it — it did not).

- [ ] **Step 1: Write the failing tests** — `server/backup/scheduler.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { writeSchedule } from './settings';
import { BackupScheduler, nextOccurrence } from './scheduler';
import fs from 'fs'; import os from 'os'; import path from 'path';

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:'); runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-s-')), migrations); });

describe('nextOccurrence', () => {
  it('is today at hh:mm when still ahead, else tomorrow', () => {
    const base = new Date(2026, 8, 12, 1, 0, 0).getTime();
    expect(new Date(nextOccurrence(base, 2, 0)).getHours()).toBe(2);
    expect(nextOccurrence(base, 2, 0) - base).toBe(60 * 60_000);
    const later = new Date(2026, 8, 12, 3, 0, 0).getTime();
    expect(nextOccurrence(later, 2, 0) - later).toBe(23 * 60 * 60_000);
  });
});

describe('BackupScheduler', () => {
  it('does nothing while disabled; when enabled runs local then drive at the configured time and reschedules', async () => {
    let now = new Date(2026, 8, 12, 1, 0, 0).getTime();
    const timers: { fn: () => void; at: number }[] = [];
    const run = vi.fn(async () => {});
    const s = new BackupScheduler({ db, run, hasDrive: () => true, now: () => now, setTimeout: ((fn: any, ms: number) => { timers.push({ fn, at: now + ms }); return { unref() {} } as any; }) as any, clearTimeout: (() => {}) as any });
    s.start();
    expect(s.nextRunAt()).toBeNull(); expect(timers.length).toBe(1); // a poll timer, not a run
    writeSchedule(db, { enabled: true, hour: 2, minute: 0 });
    await s.tick();
    expect(s.nextRunAt()).toBe(new Date(2026, 8, 12, 2, 0, 0).getTime());
    now = new Date(2026, 8, 12, 2, 0, 1).getTime();
    await s.tick();
    expect(run.mock.calls.map(c => c[0])).toEqual(['local', 'drive']);
    expect(s.nextRunAt()).toBe(new Date(2026, 8, 13, 2, 0, 0).getTime());
  });

  it('skips a tick while a run is in progress, and a failing local run still lets drive run', async () => {
    let now = new Date(2026, 8, 12, 2, 0, 1).getTime();
    writeSchedule(db, { enabled: true, hour: 2, minute: 0 });
    db.prepare(`INSERT INTO backup_runs (id, target, trigger, startedAt, status) VALUES ('x', 'local', 'manual', ?, 'running')`).run(now);
    const run = vi.fn(async (t: string) => { if (t === 'local') throw new Error('disk'); });
    const s = new BackupScheduler({ db, run, hasDrive: () => true, now: () => now, setTimeout: (() => ({ unref() {} })) as any, clearTimeout: (() => {}) as any });
    await s.tick();
    expect(run).not.toHaveBeenCalled();
    db.prepare('DELETE FROM backup_runs').run();
    await s.tick();
    expect(run.mock.calls.map(c => c[0])).toEqual(['local', 'drive']);
  });
});
```

Run: `npm test -- server/backup/scheduler.test.ts` → FAIL.

- [ ] **Step 2: Implement** — `server/backup/scheduler.ts`:

```ts
// server/backup/scheduler.ts — daily backups (spec §Scheduler). Polls the
// schedule setting each minute so a settings change needs no restart.
import type Database from 'better-sqlite3';
import { readSchedule } from './settings';
import { isRunActive } from './snapshot';

export function nextOccurrence(now: number, hour: number, minute: number): number {
  const d = new Date(now); d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export interface SchedulerDeps {
  db: Database.Database;
  run: (target: 'local' | 'drive', trigger: 'schedule') => Promise<unknown>;
  hasDrive: () => boolean;
  now?: () => number; setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout;
}
const POLL_MS = 60_000;

export class BackupScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private due: number | null = null;
  private lastFired: number | null = null;
  private readonly now: () => number;
  constructor(private deps: SchedulerDeps) { this.now = deps.now ?? (() => Date.now()); }

  nextRunAt(): number | null { return this.due; }

  start(): void { this.arm(); }
  stop(): void { if (this.timer) (this.deps.clearTimeout ?? clearTimeout)(this.timer); this.timer = null; }
  private arm(): void {
    const st = this.deps.setTimeout ?? setTimeout;
    this.timer = st(() => { this.tick().catch(e => console.error('[backup] scheduler tick failed', e)); }, POLL_MS);
    (this.timer as any).unref?.();
  }

  async tick(): Promise<void> {
    try {
      const s = readSchedule(this.deps.db);
      if (!s.enabled) { this.due = null; return; }
      const now = this.now();
      if (this.due === null || (this.lastFired !== null && this.due <= this.lastFired)) this.due = nextOccurrence(now, s.hour, s.minute);
      // schedule changed → recompute
      const expected = nextOccurrence(this.due - 1, s.hour, s.minute);
      if (expected !== this.due) this.due = nextOccurrence(now, s.hour, s.minute);
      if (now < this.due) return;
      if (isRunActive(this.deps.db, 'local') || isRunActive(this.deps.db, 'drive')) { console.warn('[backup] scheduled run skipped: a backup is still in progress'); return; }
      this.lastFired = now;
      this.due = nextOccurrence(now, s.hour, s.minute);
      try { await this.deps.run('local', 'schedule'); } catch (e) { console.error('[backup] scheduled local backup failed', e); }
      if (this.deps.hasDrive()) { try { await this.deps.run('drive', 'schedule'); } catch (e) { console.error('[backup] scheduled Drive backup failed', e); } }
    } finally { this.arm(); }
  }
}
```

(In the first test the "poll timer" expectation counts the timer `start()` arms; `tick()` re-arms each time — the fake `setTimeout` just records, so counts grow; only the first assertion checks `length === 1`.) If the skip-while-running test's second `tick` re-fires at the same `now`, that is intended: `lastFired` is only set when a run actually starts.

In `server/backup/routes.ts`: change `registerBackupRoutes` to `return { startRun };` and remove the `__backupStartRun` line; the `startRun` signature used by the scheduler is `(t: Target, trigger: 'manual' | 'schedule') => Promise<string>`, and a scheduled run must AWAIT completion (the routes version returns after starting). Add a second export from the same closure: `runAndWait: (t, trigger) => Promise<SnapshotResult>` that calls `takeSnapshot` directly and broadcasts, and return `{ startRun, runAndWait }`; the scheduler uses `runAndWait`.

In `server.ts`:
```ts
  const backupRoutes = registerBackupRoutes(app, { ...deps, scheduler: undefined });
  const backupScheduler = new BackupScheduler({ db, run: (t, trigger) => backupRoutes.runAndWait(t, trigger), hasDrive: () => !!readDrive(db, mailCrypto) });
  backupRoutes.setScheduler(backupScheduler);   // registerBackupRoutes returns { startRun, runAndWait, setScheduler }
  backupScheduler.start();
```
(`setScheduler` stores the instance in a closure variable inside `registerBackupRoutes`; change the status route to read `nextRunAt` from that variable instead of `deps.scheduler`, and delete the `scheduler` field from `BackupRouteDeps`.)

- [ ] **Step 3: Verify** — `npm test -- server/backup && npm run lint` → PASS.

- [ ] **Step 4: Commit** — `git add server/backup server.ts && git commit -m "feat(backup): daily scheduler (local then Drive), skip-while-running, live schedule changes"`

---

### Task 10: Client store helpers + Backup tab

**Files:**
- Modify: `src/utils/store.ts` (append after the storage helpers ~line 495), `src/pages/Settings.tsx` (TAB_IDS, ADMIN_ONLY_TAB_IDS, allTabs, render switch)
- Create: `src/pages/settings/BackupTab.tsx`, `src/pages/settings/BackupTab.test.tsx`

**Interfaces (produces, `src/utils/store.ts`):**
```ts
export interface BackupRun { id: string; target: 'local' | 'drive'; trigger: 'manual' | 'schedule'; startedAt: number; finishedAt: number | null; status: 'running' | 'ok' | 'error'; snapshotId: string | null; objectsAdded: number; bytesWritten: number; warnings: string[]; error: string | null }
export interface BackupSnapshot { id: string; createdAt: number; appVersion: string; schemaVersion: number; counts: { files: number; bytes: number }; warnings: number }
export interface BackupStatus {
  root: string; rootIsDefault: boolean;
  lastRun: { local: BackupRun | null; drive: BackupRun | null }; running: BackupRun | null;
  totals: { snapshots: number; objects: number; bytes: number }; nextRunAt: number | null;
  schedule: { enabled: boolean; hour: number; minute: number }; keep: { local: number; drive: number };
  drive: { connected: true; email: string; needsReconnect: boolean } | { connected: false; configurable: boolean };
}
export const getSetupState = async (): Promise<{ fresh: boolean }>
export const getBackupStatus = async (): Promise<BackupStatus>
export const runBackup = async (target: 'local' | 'drive'): Promise<{ runId: string }>      // 409 → BackupRunningError
export class BackupRunningError extends Error { name = 'BackupRunningError' }
export const getBackupRuns = async (): Promise<BackupRun[]>
export const getBackupSnapshots = async (target: 'local' | 'drive'): Promise<BackupSnapshot[]>
export const backupDownloadUrl = (id: string): string   // `/api/backup/snapshots/${id}/download?token=${token}` — the download route must accept ?token like the mail attachment routes: add `authOrQueryToken` to it in routes.ts (one-line change, covered by the BackupTab e2e in Task 12)
export const saveBackupSettings = async (s: { schedule?: BackupStatus['schedule']; keep?: BackupStatus['keep'] }): Promise<void>
export const disconnectBackupDrive = async (): Promise<void>
export const backupDriveStartUrl = (): string           // `/api/backup/drive/start?token=${token}`
// restore (Task 11 uses these)
export const getRestoreSources = async (): Promise<{ root: string; local: BackupSnapshot[]; drive: { configurable: boolean; connected: boolean; email: string | null } }>
export const uploadRestoreZip = (file: File, onProgress: (pct: number) => void): Promise<{ uploadId: string; snapshotId: string; summary: BackupSnapshot }>  // XMLHttpRequest for progress, Authorization header, Content-Type application/octet-stream
export const getRestoreDriveSnapshots = async (): Promise<BackupSnapshot[]>
export const restoreDriveStartUrl = (): string
export const restoreSnapshot = async (p: { source: 'local' | 'upload' | 'drive'; snapshotId: string; uploadId?: string }): Promise<{ restarting: true; files: number; bytes: number }>
```
All use `fetchWithRetry`/`getAuthHeaders`/`handleResponse` like `getStorageStats`; `runBackup` throws `BackupRunningError` on a 409 whose body `code === 'backup_running'`.

- [ ] **Step 1: Write the failing BackupTab tests** — `src/pages/settings/BackupTab.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ToastProvider } from '../../components/Toast';
import { ConfirmProvider } from '../../components/ConfirmDialog';

const h = vi.hoisted(() => ({
  getBackupStatus: vi.fn(), runBackup: vi.fn(async () => ({ runId: 'r' })), getBackupRuns: vi.fn(async () => []),
  getBackupSnapshots: vi.fn(async () => []), saveBackupSettings: vi.fn(async () => {}), disconnectBackupDrive: vi.fn(async () => {}),
}));
vi.mock('../../utils/store', async (orig) => ({ ...(await orig<typeof import('../../utils/store')>()), ...h }));
vi.mock('../../context/CollaborationContext', () => ({ useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }) }));
import { BackupTab } from './BackupTab';

const status = (over: Partial<any> = {}) => ({
  root: '/mnt/user/backups', rootIsDefault: false, lastRun: { local: null, drive: null }, running: null,
  totals: { snapshots: 0, objects: 0, bytes: 0 }, nextRunAt: null, schedule: { enabled: false, hour: 2, minute: 0 }, keep: { local: 14, drive: 14 },
  drive: { connected: false, configurable: true }, ...over,
});
const mount = () => render(<ToastProvider><ConfirmProvider><BackupTab /></ConfirmProvider></ToastProvider>);
beforeEach(() => { vi.clearAllMocks(); h.getBackupStatus.mockResolvedValue(status()); });

describe('BackupTab', () => {
  it('shows the root, the same-disk warning only when default, and Connect Google Drive when configurable', async () => {
    mount();
    expect(await screen.findByText('/mnt/user/backups')).toBeInTheDocument();
    expect(screen.queryByText(/same disk as the data/i)).toBeNull();
    expect(screen.getByRole('link', { name: /connect google drive/i })).toBeInTheDocument();
    h.getBackupStatus.mockResolvedValue(status({ rootIsDefault: true, drive: { connected: true, email: 'me@x.com', needsReconnect: false } }));
    mount();
    expect(await screen.findByText(/same disk as the data/i)).toBeInTheDocument();
    expect(screen.getByText(/connected as me@x.com/i)).toBeInTheDocument();
  });

  it('Back up now calls runBackup(local) and is disabled while a run is in progress', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^back up now$/i }));
    await waitFor(() => expect(h.runBackup).toHaveBeenCalledWith('local'));
    h.getBackupStatus.mockResolvedValue(status({ running: { id: 'r', target: 'local', trigger: 'manual', startedAt: 1, finishedAt: null, status: 'running', snapshotId: null, objectsAdded: 0, bytesWritten: 0, warnings: [], error: null } }));
    mount();
    await screen.findByText(/backing up/i);
    expect(screen.getAllByRole('button', { name: /^back up now$/i }).at(-1)).toBeDisabled();
  });

  it('shows the last error and lists snapshots with a download link', async () => {
    h.getBackupStatus.mockResolvedValue(status({ lastRun: { local: { id: 'r', target: 'local', trigger: 'schedule', startedAt: 1, finishedAt: 2, status: 'error', snapshotId: null, objectsAdded: 0, bytesWritten: 0, warnings: [], error: 'disk full' }, drive: null } }));
    h.getBackupSnapshots.mockResolvedValue([{ id: '20260912-020000', createdAt: 1, appVersion: '3.2.0', schemaVersion: 36, counts: { files: 12, bytes: 5000 }, warnings: 0 }]);
    mount();
    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(await screen.findByText('20260912-020000')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download zip/i })).toHaveAttribute('href', expect.stringContaining('/api/backup/snapshots/20260912-020000/download'));
  });

  it('saves schedule and keep counts', async () => {
    mount();
    fireEvent.click(await screen.findByLabelText(/run every day/i));
    fireEvent.change(screen.getByLabelText(/keep local/i), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /save schedule/i }));
    await waitFor(() => expect(h.saveBackupSettings).toHaveBeenCalledWith({ schedule: { enabled: true, hour: 2, minute: 0 }, keep: { local: 30, drive: 14 } }));
  });
});
```

Run: `npm test -- src/pages/settings/BackupTab.test.tsx` → FAIL.

- [ ] **Step 2: Implement store helpers** (append to `src/utils/store.ts`; `token()` = `localStorage.getItem('token') ?? ''`):

```ts
// ── Backup & restore (spec docs/superpowers/specs/2026-09-12-backup-restore-design.md) ──
export interface BackupRun { id: string; target: 'local' | 'drive'; trigger: 'manual' | 'schedule'; startedAt: number; finishedAt: number | null; status: 'running' | 'ok' | 'error'; snapshotId: string | null; objectsAdded: number; bytesWritten: number; warnings: string[]; error: string | null }
export interface BackupSnapshot { id: string; createdAt: number; appVersion: string; schemaVersion: number; counts: { files: number; bytes: number }; warnings: number }
export interface BackupStatus {
  root: string; rootIsDefault: boolean;
  lastRun: { local: BackupRun | null; drive: BackupRun | null }; running: BackupRun | null;
  totals: { snapshots: number; objects: number; bytes: number }; nextRunAt: number | null;
  schedule: { enabled: boolean; hour: number; minute: number }; keep: { local: number; drive: number };
  drive: { connected: true; email: string; needsReconnect: boolean } | { connected: false; configurable: boolean };
}
export class BackupRunningError extends Error { constructor() { super('A backup is already running'); this.name = 'BackupRunningError'; } }
const backupJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, { method, headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const tokenParam = () => `token=${encodeURIComponent(localStorage.getItem('token') ?? '')}`;

export const getSetupState = async (): Promise<{ fresh: boolean }> => { const r = await fetch('/api/setup/state'); return r.ok ? r.json() : { fresh: false }; };
export const getBackupStatus = async (): Promise<BackupStatus> => { const r = await fetchWithRetry('/api/backup/status', { headers: getAuthHeaders() }); await handleResponse(r); return r.json(); };
export const runBackup = async (target: 'local' | 'drive'): Promise<{ runId: string }> => {
  const r = await backupJson('POST', '/api/backup/run', { target });
  if (r.status === 409) { const b = await r.json().catch(() => ({})); if (b?.code === 'backup_running') throw new BackupRunningError(); }
  await handleResponse(r); return r.json();
};
export const getBackupRuns = async (): Promise<BackupRun[]> => { const r = await fetchWithRetry('/api/backup/runs', { headers: getAuthHeaders() }); await handleResponse(r); return r.json(); };
export const getBackupSnapshots = async (target: 'local' | 'drive'): Promise<BackupSnapshot[]> => { const r = await fetchWithRetry(`/api/backup/snapshots?target=${target}`, { headers: getAuthHeaders() }); await handleResponse(r); return r.json(); };
export const backupDownloadUrl = (id: string): string => `/api/backup/snapshots/${encodeURIComponent(id)}/download?${tokenParam()}`;
export const saveBackupSettings = async (s: { schedule?: BackupStatus['schedule']; keep?: BackupStatus['keep'] }): Promise<void> => { await handleResponse(await backupJson('PUT', '/api/backup/settings', s)); };
export const disconnectBackupDrive = async (): Promise<void> => { await handleResponse(await backupJson('DELETE', '/api/backup/drive')); };
export const backupDriveStartUrl = (): string => `/api/backup/drive/start?${tokenParam()}`;
export const getRestoreSources = async () => { const r = await fetchWithRetry('/api/setup/restore/sources', { headers: getAuthHeaders() }); await handleResponse(r); return r.json(); };
export const getRestoreDriveSnapshots = async (): Promise<BackupSnapshot[]> => { const r = await fetchWithRetry('/api/setup/restore/drive/snapshots', { headers: getAuthHeaders() }); await handleResponse(r); return r.json(); };
export const restoreDriveStartUrl = (): string => `/api/setup/restore/drive/start?${tokenParam()}`;
export const restoreSnapshot = async (p: { source: 'local' | 'upload' | 'drive'; snapshotId: string; uploadId?: string }): Promise<{ restarting: true; files: number; bytes: number }> => {
  const r = await backupJson('POST', '/api/setup/restore', p); await handleResponse(r); return r.json();
};
export const uploadRestoreZip = (file: File, onProgress: (pct: number) => void): Promise<{ uploadId: string; snapshotId: string; summary: BackupSnapshot }> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/setup/restore/upload');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const t = localStorage.getItem('token'); if (t) xhr.setRequestHeader('Authorization', `Bearer ${t}`);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round(100 * e.loaded / e.total)); };
    xhr.onload = () => { try { const b = JSON.parse(xhr.responseText); xhr.status < 300 ? resolve(b) : reject(new Error(b.error || `Upload failed (${xhr.status})`)); } catch { reject(new Error('Upload failed')); } };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
```
In `server/backup/routes.ts` change the download route's middleware to `authOrQueryToken, requireAdmin` (declare `authOrQueryToken` before the admin routes; Task 8 already defined it — move it up).

- [ ] **Step 3: Implement `src/pages/settings/BackupTab.tsx`** (follow `MailAccountsTab.tsx`'s structure and the `StorageTab` in `Settings.tsx` for card styling; use `Card, CardHeader, CardBody, Button, Field, Input, Checkbox, Select, Table, THead, TBody, TR, TH, TD, StatusPill, Skeleton` from `'../../components/ui'`, `formatBytes` from the store, `useToast`, `useConfirm`, `useLiveQuery(reload, { types: ['backupRun'] })`):

- Status card: root path in a `<code>`; when `rootIsDefault` an amber `<p>` "Backups are on the same disk as the data. Set BACKUP_PATH to a different volume."; last local / last Drive run (time via `toLocaleString()`, `StatusPill` ok=green / error=red with the `error` text, objects added, `formatBytes(bytesWritten)`); totals; `nextRunAt` or "Not scheduled"; while `running` show "Backing up… (local)" and disable both run buttons.
- Drive block: `drive.connected` → "Connected as {email}" (+ amber "Reconnect" link to `backupDriveStartUrl()` when `needsReconnect`) and a Disconnect button (confirm) → `disconnectBackupDrive` → reload; else if `configurable` → `<a href={backupDriveStartUrl()}>` "Connect Google Drive"; else a note "Set GOOGLE_OAUTH_CLIENT_ID / SECRET and APP_PUBLIC_URL to enable Drive".
- Actions: "Back up now" → `runBackup('local')`; "Back up to Drive now" (only when connected) → `runBackup('drive')`; `BackupRunningError` → toast "A backup is already running".
- Schedule card: `Checkbox` labelled "Run every day at", hour/minute `Select`s (00–23 / 00,15,30,45), `Input type=number` labelled "Keep local snapshots" and "Keep Drive snapshots", button "Save schedule" → `saveBackupSettings({ schedule, keep })` → toast + reload.
- Snapshots table with a local/Drive segmented toggle; columns Date (`id`), Version, Files, Size, Warnings; local rows get `<a href={backupDownloadUrl(id)} download>Download zip</a>`.
- Run history: collapsed `<details>` listing `getBackupRuns()`.
- One line at the bottom: "Restore is only offered on a fresh install — see the login page of an empty server."
- On mount and on every `backupRun` event: `Promise.all([getBackupStatus(), getBackupSnapshots(view)])`. Handle `?drive=connected` / `?error=` search params from the OAuth redirect with a toast (read via `useSearchParams`, clear after showing).

`src/pages/Settings.tsx`: add `'backup'` to `TAB_IDS` (after `'storage'`), to `ADMIN_ONLY_TAB_IDS`, to `allTabs` as `{ id: 'backup', label: 'Backup', icon: <DatabaseBackup size={18} />, adminOnly: true }` (import `DatabaseBackup` from lucide-react), and render `{activeTab === 'backup' && isAdmin && <BackupTab />}`.

- [ ] **Step 4: Verify** — `npm test -- src/pages/settings src/pages/Settings && npm run lint` → PASS.

- [ ] **Step 5: Commit** — `git add src/utils/store.ts src/pages/settings/BackupTab.tsx src/pages/settings/BackupTab.test.tsx src/pages/Settings.tsx server/backup/routes.ts && git commit -m "feat(backup): Settings → Backup tab (status, run, schedule, snapshots, Drive connect) + client helpers"`

---

### Task 11: Fresh-install restore screen

**Files:**
- Create: `src/pages/RestorePage.tsx`, `src/pages/RestorePage.test.tsx`
- Modify: `src/pages/Login.tsx` (restore link when fresh), `src/App.tsx` (route `restore`)

**Interfaces:** consumes Task 10's `getSetupState, getRestoreSources, uploadRestoreZip, getRestoreDriveSnapshots, restoreDriveStartUrl, restoreSnapshot`. Produces testids: `restore-source-local`, `restore-source-upload`, `restore-source-drive`, `restore-snapshot-<id>`, `restore-upload-input`, `restore-confirm`, `restore-progress`.

- [ ] **Step 1: Write the failing tests** — `src/pages/RestorePage.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { ConfirmProvider } from '../components/ConfirmDialog';

const h = vi.hoisted(() => ({
  getSetupState: vi.fn(async () => ({ fresh: true })),
  getRestoreSources: vi.fn(async () => ({ root: '/bk', local: [{ id: '20260912-020000', createdAt: 1, appVersion: '3.2.0', schemaVersion: 36, counts: { files: 3, bytes: 900 }, warnings: 0 }], drive: { configurable: false, connected: false, email: null } })),
  uploadRestoreZip: vi.fn(), getRestoreDriveSnapshots: vi.fn(async () => []), restoreSnapshot: vi.fn(async () => ({ restarting: true, files: 3, bytes: 900 })),
}));
vi.mock('../utils/store', async (orig) => ({ ...(await orig<typeof import('../utils/store')>()), ...h }));
import { RestorePage } from './RestorePage';

const mount = () => render(<MemoryRouter><ToastProvider><ConfirmProvider><RestorePage /></ConfirmProvider></ToastProvider></MemoryRouter>);
beforeEach(() => { vi.clearAllMocks(); localStorage.setItem('token', 't'); localStorage.setItem('user', JSON.stringify({ id: 'admin-id-123', username: 'admin', role: 'admin' })); });

describe('RestorePage', () => {
  it('lists local snapshots, shows a summary on pick, and after confirm polls until the server is back then routes to login', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.getSetupState.mockResolvedValueOnce({ fresh: true }).mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ fresh: false });
    mount();
    fireEvent.click(await screen.findByTestId('restore-snapshot-20260912-020000'));
    expect(screen.getByText(/3 files/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('restore-confirm'));
    fireEvent.click(await screen.findByRole('button', { name: /^restore$/i })); // confirm dialog
    await waitFor(() => expect(h.restoreSnapshot).toHaveBeenCalledWith({ source: 'local', snapshotId: '20260912-020000' }));
    expect(await screen.findByTestId('restore-progress')).toHaveTextContent(/restarting/i);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await waitFor(() => expect(screen.getByTestId('restore-progress')).toHaveTextContent(/restored/i));
    vi.useRealTimers();
  });

  it('refuses to render when the install is not fresh', async () => {
    h.getSetupState.mockResolvedValue({ fresh: false });
    mount();
    expect(await screen.findByText(/already has data/i)).toBeInTheDocument();
  });

  it('upload source shows progress and the uploaded summary', async () => {
    h.uploadRestoreZip.mockImplementation(async (_f: File, onP: (n: number) => void) => { onP(50); return { uploadId: 'u1', snapshotId: '20260901-000000', summary: { id: '20260901-000000', createdAt: 1, appVersion: '3.1.0', schemaVersion: 35, counts: { files: 7, bytes: 1 }, warnings: 1 } }; });
    mount();
    fireEvent.click(await screen.findByTestId('restore-source-upload'));
    const input = screen.getByTestId('restore-upload-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['zip'], 's.zip')] } });
    expect(await screen.findByText(/7 files/)).toBeInTheDocument();
    expect(screen.getByText(/1 warning/)).toBeInTheDocument();
  });
});
```

Run: `npm test -- src/pages/RestorePage.test.tsx` → FAIL.

- [ ] **Step 2: Implement `src/pages/RestorePage.tsx`**

State machine: `phase: 'loading' | 'not-fresh' | 'pick' | 'restoring' | 'restarting' | 'done' | 'gone'`. On mount: `getSetupState()`; if not fresh → `not-fresh` ("This server already has data — restore is only offered on a fresh install."); if no token or `user.id !== 'admin-id-123'` → render the same username/password form as Login (reuse by extracting nothing: a small inline form that POSTs `/api/auth/login` and stores token/user, then continues). Then `getRestoreSources()`.

Layout: three source tabs (`restore-source-local` "Backup folder", `restore-source-upload` "Upload a snapshot zip", `restore-source-drive` "Google Drive"). Local: table of snapshots (`restore-snapshot-<id>` buttons) with date/version/files/size. Upload: `<input type="file" accept=".zip" data-testid="restore-upload-input">` + drag-drop zone, progress bar during `uploadRestoreZip`, then the summary. Drive: if `!configurable` a note; if not connected an `<a href={restoreDriveStartUrl()}>Connect Google Drive</a>`; if connected (`?drive=connected` in the URL or `sources.drive.connected`) list `getRestoreDriveSnapshots()`. Picking a snapshot renders a summary card: `{counts.files} files`, `formatBytes(bytes)`, version, `{warnings} warning(s)` when > 0, and the button `restore-confirm` "Restore this snapshot". Confirm dialog: title "Restore from backup?", message "This replaces the empty database on this server. The server restarts when done.", `confirmLabel: 'Restore'`, tone danger. Then `restoreSnapshot(...)` → phase `restarting` with `restore-progress` text "Restarting the server…"; poll `getSetupState()` every 2 s (a rejected fetch = still down; keep going) for up to 5 minutes; when it resolves `{ fresh: false }` → phase `done` with text "Restored. Sign in with your usual account." and after 1.5 s `navigate('/login')`; on timeout phase `gone`: "The server has not come back. Start the container again, then sign in." Clear `token`/`user` from localStorage on `done` (they were the fresh-install admin's).

`src/pages/Login.tsx`: on mount call `getSetupState()`; when fresh render under the form: `<p className="mt-6 text-center text-sm text-ink-faint">New server? <Link to="/restore" className="text-accent-600 hover:underline">Restore from backup</Link></p>` (import `Link`). `src/App.tsx`: add `{ path: 'restore', element: <RestorePage /> }` next to `login`, and treat `/restore` like `/login` for the `isLoginPage` check (`const isLoginPage = location.pathname === '/login' || location.pathname === '/restore'`).

- [ ] **Step 3: Verify** — `npm test -- src/pages/RestorePage.test.tsx src/pages/Login && npm run lint` → PASS.

- [ ] **Step 4: Commit** — `git add src/pages/RestorePage.tsx src/pages/RestorePage.test.tsx src/pages/Login.tsx src/App.tsx && git commit -m "feat(backup): fresh-install restore screen (local / upload / Drive) with restart polling"`

---

### Task 12: e2e, fixture snapshot, docs, changelog, full verification

**Files:**
- Create: `scripts/build-e2e-snapshot.ts`, `e2e/fixtures/assets/snapshot-fixture.zip`, `e2e/backup-restore.spec.ts`
- Modify: `src/pages/Settings.tsx` (changelog 3.3.0), `docker-compose.yml` (commented `BACKUP_PATH` env + second volume example), `docs/mail-setup.md` (enable the Drive API; add the two Drive redirect URIs), `.env.example` (`BACKUP_PATH`)

- [ ] **Step 1: Fixture builder** — `scripts/build-e2e-snapshot.ts` (`npx tsx scripts/build-e2e-snapshot.ts`): creates a temp data dir, runs migrations, inserts one project `e2e-restored` with one `files` row (a 1-KB text blob via `putBuffer`), writes a `mail.key`, `takeSnapshot` into a temp `LocalStore`, `streamSnapshotZip` to `e2e/fixtures/assets/snapshot-fixture.zip`, prints the snapshot id. Commit the produced zip (a few KB). Note in the script header that it must be re-run whenever a migration changes the schema the fixture carries (the restore refuses only NEWER schemas, so an older fixture keeps working).

- [ ] **Step 2: e2e spec** — `e2e/backup-restore.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, expect, seedProjectWithPage } from './fixtures/test';
import yauzl from 'yauzl';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'assets', 'snapshot-fixture.zip');

// Runs FIRST (serial): the e2e server starts on a fresh .e2e-data, so the
// setup-mode screen is reachable before any spec seeds data. It stops at the
// confirm — the process exit is proven at unit level (see the spec).
test.describe.configure({ mode: 'serial' });

test('fresh install: /restore lists sources and an uploaded snapshot zip shows its summary', async ({ page, request }) => {
  const state = await (await request.get('/api/setup/state')).json();
  test.skip(!state.fresh, 'another spec already seeded this server');
  await page.goto('/login');
  await page.getByRole('link', { name: /restore from backup/i }).click();
  await page.getByPlaceholder('Enter your username').fill('admin');
  await page.getByPlaceholder('Enter your password').fill('admin');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.getByTestId('restore-source-upload').click();
  await page.getByTestId('restore-upload-input').setInputFiles(FIXTURE);
  await expect(page.getByText(/1 file/)).toBeVisible();
  await expect(page.getByTestId('restore-confirm')).toBeEnabled();
});

test('Backup tab: back up now, snapshot appears, downloaded zip carries the seeded file', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithPage(request, token);
  await authedPage.goto('/settings?tab=backup');
  await authedPage.getByRole('button', { name: /^back up now$/i }).click();
  await expect(authedPage.getByText(/backing up/i)).toBeVisible();
  await expect(authedPage.getByRole('link', { name: /download zip/i })).toBeVisible({ timeout: 30_000 });
  const href = await authedPage.getByRole('link', { name: /download zip/i }).getAttribute('href');
  const zip = await (await request.get(href!)).body();
  const names = await new Promise<string[]>((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, z) => { if (err || !z) return reject(err); const out: string[] = []; z.on('entry', e => { out.push(e.fileName); z.readEntry(); }); z.on('end', () => resolve(out)); z.readEntry(); });
  });
  expect(names.some(n => n.endsWith('/manifest.json'))).toBe(true);
  expect(names.filter(n => n.startsWith('objects/')).length).toBeGreaterThan(0);
  void projectId;
});
```
(`yauzl` is a runtime dep after Task 1, so the spec can import it. The e2e data dir is fresh per `npm run test:e2e`; `BACKUP_PATH` unset → `.e2e-data/backup-store`.) Playwright's default is parallel across FILES; this file's first test skips itself if another file already seeded the server, so it is not order-dependent.

- [ ] **Step 3: Changelog + docs** — new first `CHANGELOG` entry in `src/pages/Settings.tsx`:

```ts
  {
    version: '3.3.0',
    date: 'September 12, 2026',
    changes: [
      'Backups, managed by the app: Settings → Backup takes a complete snapshot (database, every file and document, and the mail encryption key) into a backup folder, and after the first one only new or changed files are copied. Set BACKUP_PATH to a second volume; run on a daily schedule or on demand; keep as many snapshots as you like; download any snapshot as one zip.',
      'Google Drive backup: connect a Google account once (Drive access only) and the same snapshots are pushed to a "Frugal Takeoff Backups" folder on Drive, incrementally.',
      'Disaster recovery: on a fresh install the login page offers "Restore from backup" — pick a snapshot from the backup folder, upload a snapshot zip, or connect Google Drive, and the server rebuilds itself from it and restarts.',
    ],
  },
```
`docker-compose.yml`: under the service add a commented `# - BACKUP_PATH=/backups` env line and a commented `# - /mnt/user/frugal-backups:/backups` volume line with a one-line comment. `.env.example`: `# BACKUP_PATH=/path/on/another/disk`. `docs/mail-setup.md`: a "Google Drive backups" section — enable the Google Drive API in the same Cloud project, add `https://<host>/api/backup/drive/callback` and `https://<host>/api/setup/restore/drive/callback` as authorized redirect URIs.

- [ ] **Step 4: Full verification**

```bash
npm run lint
npm test
rm -rf .e2e-data && npx playwright test e2e/backup-restore.spec.ts e2e/auth.spec.ts
```
Expected: tsc clean; all vitest pass; e2e pass.

- [ ] **Step 5: Commit** — `git add scripts/build-e2e-snapshot.ts e2e/fixtures/assets/snapshot-fixture.zip e2e/backup-restore.spec.ts src/pages/Settings.tsx docker-compose.yml .env.example docs/mail-setup.md && git commit -m "test(backup): e2e for Backup tab + fresh-install restore screen; docs; changelog 3.3.0"`

Do **not** push. The coordinator pushes after the final whole-branch review and tells Nathan that Drive needs the Drive API enabled plus two new redirect URIs before "Connect Google Drive" works.
