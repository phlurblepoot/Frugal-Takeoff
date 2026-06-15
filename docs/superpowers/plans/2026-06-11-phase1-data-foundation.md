# Phase 1: Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the base64-blobs-in-SQLite + whole-project-JSON storage with normalized tables, files on disk, versioned auto-migrations, and a save-safe API layer — while every existing screen keeps working unchanged.

**Architecture:** A new `server/` module layer (db, migrations, fileStore, files, projectStore, routes) replaces the inline data code in `server.ts`. Migrations transform existing databases in place (with automatic backup). A thin aggregation layer reassembles the legacy `Project` JSON shape from normalized rows so the existing UI keeps its current contracts (`GET/PUT /api/projects/:id`, `/api/images/*`). Saves gain optimistic concurrency (`version` column, HTTP 409 on staleness) and lose all destructive side-effects.

**Tech Stack:** Express 4 + better-sqlite3 (synchronous SQLite), TypeScript via tsx, Vitest + Supertest for tests. Frontend only changes in `src/utils/store.ts`, `src/types.ts`, plus one small new component.

**Spec:** `docs/superpowers/specs/2026-06-11-cohesive-app-design.md` (§3 Data Model & Storage, §9 Phase 1)

**Branch:** all work on `testing` (per project CLAUDE.md — push directly to `testing`, no PRs).

---

## Context You Must Know Before Starting

1. **Current storage:** every binary (PDF/image/thumbnail/proposal) is a dataURL string in the `images` table (`server.ts:124-127`). Every project is one JSON blob in `projects.data` (`server.ts:119-123`).
2. **The bug this fixes:** `PUT /api/projects/:id` (`server.ts:469-513`) overwrites the whole project with whatever arrives AND deletes images not referenced by the payload. A stale save destroys data permanently.
3. **Write path quirk:** `POST /api/files/:id` (`server.ts:641-662`) accepts raw binary and converts to a dataURL before storing — so *all* rows in `images` are dataURL-format (`data:<mime>;base64,<b64>`).
4. **Public read path:** `GET /api/images/:id/raw` (`server.ts:600-622`) is **unauthenticated** (used in `<img src>` and pdf.js); keep it public.
5. **DB pragma:** `journal_mode = DELETE`, not WAL — required for Unraid FUSE mounts. Never change it.
6. **tsconfig has no `include`** — everything in the repo root compiles, so new `server/*.ts` files are type-checked by `npm run lint` (which runs `tsc --noEmit`).
7. **Client `Project` type:** `src/types.ts:181-202`. `bidDueDate` is `number | null`. `ProjectPage.pageNumber` is a **string**. `ProjectPage.imageId` is required but may be `''` for vector pages.
8. **48 call sites** invoke `saveProject(...)` — conflict handling must be centralized in `store.ts`, not per-call-site.
9. **Run the dev server:** `npm run dev` (tsx runs `server.ts`, which embeds Vite middleware). Tests: `npx vitest run` after Task 1.
10. **NEVER run migrations against `./data/` containing real data without telling Nathan first** — he wants to watch migration runs. Use throwaway temp dirs in all tests.

## File Structure

```
server/
  db.ts                  # openDb(): connection + pragmas only — no schema
  migrations.ts          # framework: schema_version table, backup, ordered transactional apply
  migrationList.ts       # the 5 migrations (base schema, legacy import, core tables, images→disk, normalize)
  fileStore.ts           # disk content ops: sharded paths, atomic write, read, delete
  files.ts               # file metadata layer: files table + disk, dataURL compat helpers
  projectStore.ts        # aggregate load/save/create/delete/list + validation + version conflict
  routes.ts              # registerDataRoutes(app, deps): all rewritten HTTP endpoints
  *.test.ts              # vitest tests colocated per module
server.ts                # slimmed: startup, auth, vite, socket.io, email-send, remaining routes
src/utils/store.ts       # no write retries; 409 handling; version bookkeeping
src/types.ts             # Project gains version?: number; status?: string
src/components/ProjectConflictListener.tsx   # global 409 toast + reload
vitest.config.ts
```

Schema versions: 1 `base-schema`, 2 `legacy-dir-import`, 3 `core-tables`, 4 `images-to-disk`, 5 `normalize-projects`.

---

### Task 1: Test Infrastructure

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `server/sanity.test.ts`

- [ ] **Step 1: Install dev dependencies**

```bash
npm install -D vitest supertest @types/supertest
```

- [ ] **Step 2: Create vitest config**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Add test script to package.json**

In `package.json` `"scripts"`, after `"lint": "tsc --noEmit"` add:

```json
    "test": "vitest run"
```

- [ ] **Step 4: Write a sanity test proving better-sqlite3 works under vitest**

```ts
// server/sanity.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

describe('test infrastructure', () => {
  it('runs better-sqlite3 in-memory', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER)');
    db.prepare('INSERT INTO t (id) VALUES (?)').run(42);
    const row = db.prepare('SELECT id FROM t').get() as { id: number };
    expect(row.id).toBe(42);
    db.close();
  });
});
```

- [ ] **Step 5: Run it**

Run: `npm test`
Expected: PASS (1 test). If better-sqlite3 fails to load due to Node ABI mismatch, run `npm rebuild better-sqlite3` and retry.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts server/sanity.test.ts
git commit -m "test: add vitest + supertest infrastructure"
```

---

### Task 2: Database Connection Module

**Files:**
- Create: `server/db.ts`
- Test: `server/db.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/db.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from './db';

describe('openDb', () => {
  it('opens an in-memory db with DELETE journal mode', () => {
    const db = openDb(':memory:');
    // in-memory dbs report 'memory'; the pragma call must not throw
    const mode = db.pragma('journal_mode', { simple: true });
    expect(['delete', 'memory']).toContain(mode);
    db.close();
  });

  it('enables foreign keys', () => {
    const db = openDb(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/db.test.ts`
Expected: FAIL — `Cannot find module './db'`

- [ ] **Step 3: Implement**

```ts
// server/db.ts
import Database from 'better-sqlite3';

// Opens the SQLite database and applies connection pragmas. Schema creation
// happens exclusively through migrations (see server/migrationList.ts).
export function openDb(file: string): Database.Database {
  const db = new Database(file);
  // DELETE journal mode (not WAL): WAL requires mmap, which fails on Unraid
  // FUSE mounts (/mnt/user) where this app is commonly deployed.
  db.pragma('journal_mode = DELETE');
  db.pragma('foreign_keys = ON');
  return db;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/db.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add server/db.ts server/db.test.ts
git commit -m "feat: add db connection module with pragmas"
```

---

### Task 3: Migration Framework

**Files:**
- Create: `server/migrations.ts`
- Test: `server/migrations.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// server/migrations.test.ts
import { describe, it, expect } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from './db';
import { runMigrations, currentVersion, type Migration } from './migrations';

const tmpDir = () => fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-mig-'));

const m = (version: number, sql: string): Migration => ({
  version,
  name: `m${version}`,
  up: ({ db }) => { db.exec(sql); },
});

describe('runMigrations', () => {
  it('applies pending migrations in order and records them', () => {
    const db = openDb(':memory:');
    const result = runMigrations(db, tmpDir(), [
      m(1, 'CREATE TABLE a (id INTEGER)'),
      m(2, 'CREATE TABLE b (id INTEGER)'),
    ]);
    expect(result.from).toBe(0);
    expect(result.to).toBe(2);
    expect(result.applied).toEqual(['m1', 'm2']);
    expect(currentVersion(db)).toBe(2);
    // both tables exist
    db.prepare('SELECT * FROM a').all();
    db.prepare('SELECT * FROM b').all();
    db.close();
  });

  it('is idempotent — second run applies nothing', () => {
    const db = openDb(':memory:');
    const migs = [m(1, 'CREATE TABLE a (id INTEGER)')];
    runMigrations(db, tmpDir(), migs);
    const second = runMigrations(db, tmpDir(), migs);
    expect(second.applied).toEqual([]);
    db.close();
  });

  it('rolls back a failing migration and stops', () => {
    const db = openDb(':memory:');
    const bad: Migration = {
      version: 2,
      name: 'bad',
      up: ({ db }) => {
        db.exec('CREATE TABLE partial (id INTEGER)');
        throw new Error('boom');
      },
    };
    expect(() =>
      runMigrations(db, tmpDir(), [m(1, 'CREATE TABLE a (id INTEGER)'), bad])
    ).toThrow('boom');
    expect(currentVersion(db)).toBe(1); // m1 applied, bad rolled back
    expect(() => db.prepare('SELECT * FROM partial').all()).toThrow(); // rolled back
    db.close();
  });

  it('backs up the db file before applying when dbFile is given', () => {
    const dir = tmpDir();
    const dbFile = path.join(dir, 'app.db');
    let db = openDb(dbFile);
    runMigrations(db, dir, [m(1, 'CREATE TABLE a (id INTEGER)')], { dbFile });
    db.prepare('INSERT INTO a (id) VALUES (1)').run();
    db.close();

    db = openDb(dbFile);
    runMigrations(db, dir, [
      m(1, 'CREATE TABLE a (id INTEGER)'),
      m(2, 'CREATE TABLE b (id INTEGER)'),
    ], { dbFile });
    db.close();

    const backups = fsSync.readdirSync(path.join(dir, 'backups'));
    // one backup per run that had pending migrations (run 1 had no file yet to back up
    // before schema_version existed is fine either way; assert at least the v1 backup)
    expect(backups.some(f => f.startsWith('app-v1-'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/migrations.test.ts`
Expected: FAIL — `Cannot find module './migrations'`

- [ ] **Step 3: Implement**

```ts
// server/migrations.ts
import type Database from 'better-sqlite3';
import fsSync from 'fs';
import path from 'path';

export interface MigrationCtx {
  db: Database.Database;
  dataDir: string;
}

export interface Migration {
  version: number;
  name: string;
  up: (ctx: MigrationCtx) => void;
}

export function currentVersion(db: Database.Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL,
      name TEXT,
      appliedAt INTEGER NOT NULL
    )
  `);
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  return row?.v ?? 0;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

// Applies all migrations with version > current, each in its own transaction.
// If opts.dbFile points at an existing database file, a copy is made into
// <dataDir>/backups/ before anything is touched. Disk side-effects inside a
// migration (e.g. writing extracted files) are NOT transactional — migrations
// must be written so that re-running them after a mid-way crash is safe.
export function runMigrations(
  db: Database.Database,
  dataDir: string,
  migrations: Migration[],
  opts: { dbFile?: string } = {}
): MigrationResult {
  const from = currentVersion(db);
  const pending = migrations
    .filter(mig => mig.version > from)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return { from, to: from, applied: [] };

  if (opts.dbFile && fsSync.existsSync(opts.dbFile)) {
    const backupDir = path.join(dataDir, 'backups');
    fsSync.mkdirSync(backupDir, { recursive: true });
    const dest = path.join(backupDir, `app-v${from}-${Date.now()}.db`);
    // Safe at startup: journal_mode=DELETE and no concurrent writers yet.
    fsSync.copyFileSync(opts.dbFile, dest);
    console.log(`[migrations] backed up database to ${dest}`);
  }

  const applied: string[] = [];
  for (const mig of pending) {
    const tx = db.transaction(() => {
      mig.up({ db, dataDir });
      db.prepare('INSERT INTO schema_version (version, name, appliedAt) VALUES (?, ?, ?)')
        .run(mig.version, mig.name, Date.now());
    });
    tx();
    applied.push(mig.name);
    console.log(`[migrations] applied ${mig.version}: ${mig.name}`);
  }
  return { from, to: pending[pending.length - 1].version, applied };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/migrations.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/migrations.ts server/migrations.test.ts
git commit -m "feat: add versioned migration framework with backup"
```

---

### Task 4: Disk File Store

**Files:**
- Create: `server/fileStore.ts`
- Test: `server/fileStore.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// server/fileStore.test.ts
import { describe, it, expect } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { pathFor, writeFileContent, readFileContent, deleteFileContent, statFile } from './fileStore';

const tmpDir = () => fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-fs-'));

describe('fileStore', () => {
  it('shards paths by first two id chars', () => {
    const dir = tmpDir();
    const p = pathFor(dir, 'ab12cd34');
    expect(p).toBe(path.join(dir, 'files', 'ab', 'ab12cd34'));
  });

  it('sanitizes hostile ids so they cannot escape the files root', () => {
    const dir = tmpDir();
    const p = pathFor(dir, '../../etc/passwd');
    expect(p.startsWith(path.join(dir, 'files'))).toBe(true);
    expect(p).not.toContain('..');
  });

  it('writes, reads, stats, and deletes content', () => {
    const dir = tmpDir();
    const buf = Buffer.from('hello world');
    const { size, sha256 } = writeFileContent(dir, 'testid01', buf);
    expect(size).toBe(11);
    expect(sha256).toHaveLength(64);
    expect(readFileContent(dir, 'testid01')!.toString()).toBe('hello world');
    expect(statFile(dir, 'testid01')!.size).toBe(11);
    deleteFileContent(dir, 'testid01');
    expect(readFileContent(dir, 'testid01')).toBeNull();
    expect(statFile(dir, 'testid01')).toBeNull();
  });

  it('overwrites atomically on repeated writes', () => {
    const dir = tmpDir();
    writeFileContent(dir, 'x1', Buffer.from('one'));
    writeFileContent(dir, 'x1', Buffer.from('two'));
    expect(readFileContent(dir, 'x1')!.toString()).toBe('two');
    const shard = path.dirname(pathFor(dir, 'x1'));
    expect(fsSync.readdirSync(shard).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/fileStore.test.ts`
Expected: FAIL — `Cannot find module './fileStore'`

- [ ] **Step 3: Implement**

```ts
// server/fileStore.ts
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';

// File content lives at <dataDir>/files/<shard>/<id> where shard is the first
// two characters of the (sanitized) id. Ids are uuids in practice; sanitizing
// defends against any client-supplied id reaching the filesystem.
export function filesRoot(dataDir: string): string {
  return path.join(dataDir, 'files');
}

export function pathFor(dataDir: string, id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\./g, '__');
  const shard = safe.slice(0, 2).padEnd(2, '_');
  return path.join(filesRoot(dataDir), shard, safe);
}

export function writeFileContent(
  dataDir: string,
  id: string,
  buf: Buffer
): { size: number; sha256: string } {
  const p = pathFor(dataDir, id);
  fsSync.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fsSync.writeFileSync(tmp, buf);
  fsSync.renameSync(tmp, p); // atomic replace on same filesystem
  return {
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

export function readFileContent(dataDir: string, id: string): Buffer | null {
  try {
    return fsSync.readFileSync(pathFor(dataDir, id));
  } catch {
    return null;
  }
}

export function statFile(dataDir: string, id: string): { size: number } | null {
  try {
    return { size: fsSync.statSync(pathFor(dataDir, id)).size };
  } catch {
    return null;
  }
}

export function deleteFileContent(dataDir: string, id: string): void {
  try {
    fsSync.unlinkSync(pathFor(dataDir, id));
  } catch {
    /* already gone */
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/fileStore.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/fileStore.ts server/fileStore.test.ts
git commit -m "feat: add sharded on-disk file content store"
```

---

### Task 5: Migrations 1-3 (Base Schema, Legacy Import, Core Tables)

**Files:**
- Create: `server/migrationList.ts`
- Test: `server/migrationList.test.ts`

Migration 1 reproduces the legacy `CREATE TABLE IF NOT EXISTS` bootstrap from `server.ts:118-190` (no-op on existing DBs). Migration 2 absorbs the old `migrateOldData()` directory import from `server.ts:217-272` (now runs once instead of every boot — acceptable; all live installs are already SQLite-based). Migration 3 adds the new columns and tables from spec §3.2.

- [ ] **Step 1: Write the failing tests**

```ts
// server/migrationList.test.ts
import { describe, it, expect } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';

const tmpDir = () => fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-ml-'));

const tableNames = (db: any): string[] =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r: any) => r.name);

const columnNames = (db: any, table: string): string[] =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((r: any) => r.name);

describe('migrations 1-3 on a fresh database', () => {
  it('creates legacy and new tables', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 3));
    const tables = tableNames(db);
    for (const t of ['projects', 'images', 'templates', 'bids', 'users', 'notes',
                     'settings', 'user_preferences', 'shares', 'checklists',
                     'email_accounts', 'time_entries',
                     'files', 'plan_sets', 'pages', 'takeoffs', 'measurements', 'activity']) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
    db.close();
  });

  it('adds the new project columns', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 3));
    const cols = columnNames(db, 'projects');
    for (const c of ['id', 'data', 'createdAt', 'name', 'status', 'contractor',
                     'address', 'bidDueDate', 'contractValue', 'version', 'updatedAt', 'meta']) {
      expect(cols, `missing column ${c}`).toContain(c);
    }
    db.close();
  });

  it('is a no-op on a database that already has the legacy tables', () => {
    const db = openDb(':memory:');
    // simulate a live db created by the old initDb()
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
             CREATE TABLE images (id TEXT PRIMARY KEY, data TEXT);`);
    db.prepare('INSERT INTO projects (id, data, createdAt) VALUES (?, ?, ?)')
      .run('p1', '{"id":"p1"}', 123);
    expect(() => runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 3))).not.toThrow();
    const row = db.prepare('SELECT data FROM projects WHERE id = ?').get('p1') as { data: string };
    expect(row.data).toBe('{"id":"p1"}');
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/migrationList.test.ts`
Expected: FAIL — `Cannot find module './migrationList'`

- [ ] **Step 3: Implement migrations 1-3**

```ts
// server/migrationList.ts
import fsSync from 'fs';
import path from 'path';
import type { Migration } from './migrations';
import { writeFileContent } from './fileStore';

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'base-schema',
    up({ db }) {
      // Mirrors the legacy initDb() bootstrap so fresh installs and old
      // databases converge on the same starting point. IF NOT EXISTS makes
      // this a no-op for existing installs.
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE IF NOT EXISTS bids (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT);
        CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, projectId TEXT, data TEXT, createdAt INTEGER, updatedAt INTEGER);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS user_preferences (userId TEXT NOT NULL, key TEXT NOT NULL, value TEXT, UNIQUE(userId, key));
        CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, type TEXT NOT NULL, resourceId TEXT NOT NULL, name TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS checklists (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS email_accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL, createdAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS time_entries (
          id TEXT PRIMARY KEY, userId TEXT NOT NULL, projectId TEXT,
          clockIn INTEGER NOT NULL, clockOut INTEGER, description TEXT, createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_time_entries_userId ON time_entries (userId);
        CREATE INDEX IF NOT EXISTS idx_notes_projectId ON notes (projectId);
        CREATE INDEX IF NOT EXISTS idx_projects_createdAt ON projects (createdAt);
        CREATE INDEX IF NOT EXISTS idx_bids_createdAt ON bids (createdAt);
      `);
    },
  },
  {
    version: 2,
    name: 'legacy-dir-import',
    up({ db, dataDir }) {
      // Absorbs the old migrateOldData() (server.ts:217-272): pre-SQLite
      // installs kept JSON files in data/projects + data/images. Runs once;
      // renames the dirs after import so they are never re-read.
      const PROJECTS_DIR = path.join(dataDir, 'projects');
      const IMAGES_DIR = path.join(dataDir, 'images');
      const TEMPLATES_FILE = path.join(dataDir, 'templates.json');
      try {
        if (fsSync.existsSync(PROJECTS_DIR)) {
          const insert = db.prepare('INSERT OR IGNORE INTO projects (id, data, createdAt) VALUES (?, ?, ?)');
          for (const f of fsSync.readdirSync(PROJECTS_DIR)) {
            if (!f.endsWith('.json')) continue;
            const data = fsSync.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8');
            const p = JSON.parse(data);
            insert.run(p.id, data, p.createdAt || Date.now());
          }
          fsSync.renameSync(PROJECTS_DIR, path.join(dataDir, 'projects_migrated'));
        }
        if (fsSync.existsSync(IMAGES_DIR)) {
          const insert = db.prepare('INSERT OR IGNORE INTO images (id, data) VALUES (?, ?)');
          for (const f of fsSync.readdirSync(IMAGES_DIR)) {
            if (!f.endsWith('.txt')) continue;
            insert.run(f.replace('.txt', ''), fsSync.readFileSync(path.join(IMAGES_DIR, f), 'utf-8'));
          }
          fsSync.renameSync(IMAGES_DIR, path.join(dataDir, 'images_migrated'));
        }
        if (fsSync.existsSync(TEMPLATES_FILE)) {
          const insert = db.prepare('INSERT OR IGNORE INTO templates (id, data) VALUES (?, ?)');
          for (const t of JSON.parse(fsSync.readFileSync(TEMPLATES_FILE, 'utf-8'))) {
            insert.run(t.id, JSON.stringify(t));
          }
          fsSync.renameSync(TEMPLATES_FILE, path.join(dataDir, 'templates_migrated.json'));
        }
      } catch (e) {
        console.error('[migrations] legacy dir import failed (continuing):', e);
      }
    },
  },
  {
    version: 3,
    name: 'core-tables',
    up({ db }) {
      db.exec(`
        ALTER TABLE projects ADD COLUMN name TEXT;
        ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'estimating';
        ALTER TABLE projects ADD COLUMN contractor TEXT;
        ALTER TABLE projects ADD COLUMN address TEXT;
        ALTER TABLE projects ADD COLUMN bidDueDate INTEGER;
        ALTER TABLE projects ADD COLUMN contractValue REAL;
        ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE projects ADD COLUMN updatedAt INTEGER;
        ALTER TABLE projects ADD COLUMN meta TEXT;

        CREATE TABLE files (
          id TEXT PRIMARY KEY,
          projectId TEXT,
          name TEXT,
          mime TEXT NOT NULL DEFAULT 'application/octet-stream',
          size INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'other',
          parentFileId TEXT,
          versionNumber INTEGER NOT NULL DEFAULT 1,
          legacyFormat TEXT,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_files_projectId ON files (projectId);

        CREATE TABLE plan_sets (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          name TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          attrs TEXT
        );
        CREATE INDEX idx_plan_sets_projectId ON plan_sets (projectId);

        CREATE TABLE pages (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          planSetId TEXT,
          name TEXT,
          pageNumber TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          imageId TEXT,
          thumbnailId TEXT,
          sourcePdfFileId TEXT,
          sourcePdfPageNum INTEGER,
          attrs TEXT
        );
        CREATE INDEX idx_pages_projectId ON pages (projectId);

        CREATE TABLE takeoffs (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          name TEXT,
          type TEXT,
          color TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          attrs TEXT
        );
        CREATE INDEX idx_takeoffs_projectId ON takeoffs (projectId);

        CREATE TABLE measurements (
          id TEXT PRIMARY KEY,
          pageId TEXT NOT NULL,
          projectId TEXT NOT NULL,
          takeoffId TEXT,
          type TEXT NOT NULL,
          name TEXT,
          color TEXT,
          points TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          attrs TEXT
        );
        CREATE INDEX idx_measurements_pageId ON measurements (pageId);
        CREATE INDEX idx_measurements_projectId ON measurements (projectId);

        CREATE TABLE activity (
          id TEXT PRIMARY KEY,
          projectId TEXT,
          userId TEXT,
          type TEXT NOT NULL,
          message TEXT,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_activity_projectId ON activity (projectId);
      `);
    },
  },
];
```

**Design notes locked in here (do not deviate):**
- `pages`/`takeoffs`/`plan_sets`/`measurements` get **columns only for identity, joins, ordering, and search** — everything else goes in the `attrs` JSON column. This makes the legacy-JSON round-trip lossless (booleans like `isAdvancedCost` keep their exact present/absent semantics).
- `pages.pageNumber` is TEXT (it's a string in `src/types.ts:96`). `projects.bidDueDate` is INTEGER (epoch ms).
- `scaleConfig` lives in `pages.attrs` — nothing queries it in Phase 1.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/migrationList.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/migrationList.ts server/migrationList.test.ts
git commit -m "feat: add migrations 1-3 (base schema, legacy import, core tables)"
```

---

### Task 6: File Metadata Layer

**Files:**
- Create: `server/files.ts`
- Test: `server/files.test.ts`

Pairs `files` table rows with disk content and provides the **dataURL compatibility helpers** the legacy `/api/images` contract needs. Key invariant: `getDataUrlString` must return a byte-identical string to what the old `images.data` column held.

- [ ] **Step 1: Write the failing tests**

```ts
// server/files.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { putDataUrl, putBuffer, getMeta, getDataUrlString, removeFile } from './files';
import { readFileContent } from './fileStore';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-files-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations.filter(m => m.version <= 3));
});

const PNG_DATAURL = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');

describe('files layer', () => {
  it('putDataUrl stores content on disk and metadata in db', () => {
    putDataUrl(db, dir, 'img1', PNG_DATAURL);
    const meta = getMeta(db, 'img1')!;
    expect(meta.mime).toBe('image/png');
    expect(meta.size).toBe(7);
    expect(meta.kind).toBe('other');
    expect(readFileContent(dir, 'img1')!.toString()).toBe('fakepng');
  });

  it('getDataUrlString round-trips byte-identically', () => {
    putDataUrl(db, dir, 'img1', PNG_DATAURL);
    expect(getDataUrlString(db, dir, 'img1')).toBe(PNG_DATAURL);
  });

  it('putBuffer reproduces the dataURL the old raw-upload path built', () => {
    putBuffer(db, dir, 'pdf1', Buffer.from('fakepdf'), 'application/pdf');
    // legacy POST /api/files/:id built: data:<mime>;base64,<b64> (server.ts:653)
    expect(getDataUrlString(db, dir, 'pdf1'))
      .toBe('data:application/pdf;base64,' + Buffer.from('fakepdf').toString('base64'));
  });

  it('overwriting an id replaces content and mime', () => {
    putDataUrl(db, dir, 'img1', PNG_DATAURL);
    putBuffer(db, dir, 'img1', Buffer.from('newcontent'), 'image/jpeg');
    expect(getMeta(db, 'img1')!.mime).toBe('image/jpeg');
    expect(readFileContent(dir, 'img1')!.toString()).toBe('newcontent');
  });

  it('preserves projectId/kind/name labels across overwrite', () => {
    putBuffer(db, dir, 'img1', Buffer.from('a'), 'image/png', { projectId: 'p1', kind: 'plan', name: 'Sheet A1' });
    putBuffer(db, dir, 'img1', Buffer.from('b'), 'image/png');
    const meta = getMeta(db, 'img1')!;
    expect(meta.projectId).toBe('p1');
    expect(meta.kind).toBe('plan');
    expect(meta.name).toBe('Sheet A1');
  });

  it('removeFile deletes row and disk content', () => {
    putDataUrl(db, dir, 'img1', PNG_DATAURL);
    removeFile(db, dir, 'img1');
    expect(getMeta(db, 'img1')).toBeNull();
    expect(readFileContent(dir, 'img1')).toBeNull();
  });

  it('returns null for unknown ids', () => {
    expect(getMeta(db, 'nope')).toBeNull();
    expect(getDataUrlString(db, dir, 'nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/files.test.ts`
Expected: FAIL — `Cannot find module './files'`

- [ ] **Step 3: Implement**

```ts
// server/files.ts
import type Database from 'better-sqlite3';
import { writeFileContent, readFileContent, deleteFileContent } from './fileStore';

// Matches the legacy dataURL format used everywhere in the old images table.
// Keep in sync with the regex previously at server.ts:608.
export const DATA_URL_RE = /^data:([A-Za-z0-9.+\/-]+)(?:;[^;,]+)*;base64,(.+)$/s;

export interface FileMeta {
  id: string;
  projectId: string | null;
  name: string | null;
  mime: string;
  size: number;
  sha256: string;
  kind: string;
  parentFileId: string | null;
  versionNumber: number;
  legacyFormat: string | null; // 'dataurl' | 'base64' | null
  createdAt: number;
}

export interface PutOpts {
  projectId?: string;
  kind?: string;
  name?: string;
}

function upsertRow(
  db: Database.Database,
  id: string,
  mime: string,
  size: number,
  sha256: string,
  legacyFormat: string | null,
  opts: PutOpts
): void {
  const existing = db.prepare('SELECT projectId, kind, name FROM files WHERE id = ?').get(id) as
    | { projectId: string | null; kind: string; name: string | null }
    | undefined;
  db.prepare(`
    INSERT OR REPLACE INTO files (id, projectId, name, mime, size, sha256, kind, legacyFormat, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.projectId ?? existing?.projectId ?? null,
    opts.name ?? existing?.name ?? null,
    mime,
    size,
    sha256,
    opts.kind ?? existing?.kind ?? 'other',
    legacyFormat,
    Date.now()
  );
}

// Stores a legacy dataURL string (the only format the old /api/images wrote).
// Non-dataURL strings are treated as bare base64 — getDataUrlString restores
// the original string shape either way.
export function putDataUrl(db: Database.Database, dataDir: string, id: string, data: string, opts: PutOpts = {}): FileMeta {
  const m = data.match(DATA_URL_RE);
  let mime = 'application/octet-stream';
  let legacyFormat = 'base64';
  let buf: Buffer;
  if (m) {
    mime = m[1];
    legacyFormat = 'dataurl';
    buf = Buffer.from(m[2], 'base64');
  } else {
    buf = Buffer.from(data, 'base64');
  }
  const { size, sha256 } = writeFileContent(dataDir, id, buf);
  upsertRow(db, id, mime, size, sha256, legacyFormat, opts);
  return getMeta(db, id)!;
}

export function putBuffer(db: Database.Database, dataDir: string, id: string, buf: Buffer, mime: string, opts: PutOpts = {}): FileMeta {
  const { size, sha256 } = writeFileContent(dataDir, id, buf);
  // Raw uploads were converted to dataURLs by the old code, so reads expect
  // a dataURL back — mark accordingly.
  upsertRow(db, id, mime || 'application/octet-stream', size, sha256, 'dataurl', opts);
  return getMeta(db, id)!;
}

export function getMeta(db: Database.Database, id: string): FileMeta | null {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileMeta | undefined;
  return row ?? null;
}

// Reconstructs the exact string the legacy images.data column held.
export function getDataUrlString(db: Database.Database, dataDir: string, id: string): string | null {
  const meta = getMeta(db, id);
  if (!meta) return null;
  const buf = readFileContent(dataDir, id);
  if (!buf) return null;
  const b64 = buf.toString('base64');
  if (meta.legacyFormat === 'base64') return b64;
  return `data:${meta.mime};base64,${b64}`;
}

export function removeFile(db: Database.Database, dataDir: string, id: string): void {
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  deleteFileContent(dataDir, id);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/files.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add server/files.ts server/files.test.ts
git commit -m "feat: add file metadata layer with legacy dataURL compatibility"
```

---

### Task 7: Migration 4 — Images to Disk

**Files:**
- Modify: `server/migrationList.ts` (append migration 4 to the array)
- Test: `server/migrationList.test.ts` (append describe block)

- [ ] **Step 1: Write the failing tests** (append to `server/migrationList.test.ts`; add the two imports to the top of the file)

```ts
import { getDataUrlString } from './files';
import { readFileContent } from './fileStore';

describe('migration 4: images-to-disk', () => {
  it('moves dataURL rows to disk, creates files rows, drops images table', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 3));
    const png = 'data:image/png;base64,' + Buffer.from('imgbytes').toString('base64');
    db.prepare('INSERT INTO images (id, data) VALUES (?, ?)').run('imgA', png);
    db.prepare('INSERT INTO images (id, data) VALUES (?, ?)').run('imgB', 'bm90LWEtZGF0YXVybA==');

    runMigrations(db, dir, migrations.filter(m => m.version <= 4));

    expect(tableNames(db)).not.toContain('images');
    expect(getDataUrlString(db, dir, 'imgA')).toBe(png);
    expect(readFileContent(dir, 'imgA')!.toString()).toBe('imgbytes');
    // non-dataURL row round-trips as the same bare-base64 string
    expect(getDataUrlString(db, dir, 'imgB')).toBe('bm90LWEtZGF0YXVybA==');
    const metaA = db.prepare('SELECT mime, kind, legacyFormat FROM files WHERE id = ?').get('imgA') as any;
    expect(metaA.mime).toBe('image/png');
    expect(metaA.kind).toBe('other');
    expect(metaA.legacyFormat).toBe('dataurl');
    db.close();
  });

  it('skips empty rows without failing', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 3));
    db.prepare('INSERT INTO images (id, data) VALUES (?, ?)').run('empty1', null);
    expect(() => runMigrations(db, dir, migrations.filter(m => m.version <= 4))).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) as c FROM files').get() as any).c).toBe(0);
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/migrationList.test.ts`
Expected: FAIL — migration 4 doesn't exist yet (`images` table still present).

- [ ] **Step 3: Append migration 4 to the array in `server/migrationList.ts`**

Add to imports: `import { DATA_URL_RE } from './files';`

```ts
  {
    version: 4,
    name: 'images-to-disk',
    up({ db, dataDir }) {
      // Walks every legacy base64 blob out of the images table onto disk.
      // Disk writes are idempotent (same id → same path, atomic overwrite),
      // so a crash mid-migration is safe: the DB transaction rolls back and
      // the next boot redoes the walk.
      const insert = db.prepare(`
        INSERT OR REPLACE INTO files (id, projectId, name, mime, size, sha256, kind, legacyFormat, createdAt)
        VALUES (?, NULL, NULL, ?, ?, ?, 'other', ?, ?)
      `);
      let count = 0;
      for (const row of db.prepare('SELECT id, data FROM images').iterate() as Iterable<{ id: string; data: string | null }>) {
        if (!row.data) continue;
        const m = row.data.match(DATA_URL_RE);
        let mime = 'application/octet-stream';
        let legacyFormat = 'base64';
        let buf: Buffer;
        if (m) {
          mime = m[1];
          legacyFormat = 'dataurl';
          buf = Buffer.from(m[2], 'base64');
        } else {
          buf = Buffer.from(row.data, 'base64');
        }
        const { size, sha256 } = writeFileContent(dataDir, row.id, buf);
        insert.run(row.id, mime, size, sha256, legacyFormat, Date.now());
        count++;
      }
      db.exec('DROP TABLE images');
      console.log(`[migrations] moved ${count} blobs from images table to disk`);
    },
  },
```

**Note:** better-sqlite3 forbids structural writes on a table while iterating it — here we only *read* `images` while writing to `files` and disk, which is fine. `DROP TABLE` happens after the loop.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/migrationList.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/migrationList.ts server/migrationList.test.ts
git commit -m "feat: add migration 4 — move image blobs from SQLite to disk"
```

---

### Task 8: Project Store — Assemble/Decompose + Migration 5

**Files:**
- Create: `server/projectStore.ts`
- Modify: `server/migrationList.ts` (append migration 5)
- Test: `server/projectStore.test.ts`

The heart of the aggregation layer. **The legacy JSON shape is the contract**: `loadProject` must reassemble exactly what the old `projects.data` blob contained (plus new `version`/`status` fields), or the UI breaks.

**Round-trip rules (locked in):**
- Normalized columns: project `id/name/createdAt/contractor/address/bidDueDate`; page `id/planSetId/name/pageNumber/imageId/thumbnailId/sourcePdfFileId/sourcePdfPageNum`; measurement `id/takeoffId/type/name/color/points`; takeoff `id/name/type/color`; plan_set `id/name`. **Everything else** lands in `attrs` (or project `meta`) verbatim via rest-spread.
- On assembly, a NULL column is **omitted** from the JSON (legacy objects simply lacked the key); `''` is a real value and survives (vector pages have `imageId: ''`).
- Array order is preserved via `sortOrder`.
- `pages`/`takeoffs` are always emitted as arrays (required by `Project` type); `planSets` is emitted only when rows exist. `measurements` is always an array on every page.
- Known acceptable drift: a project that stored `bidDueDate: null` or `planSets: []` round-trips with the key omitted — every consumer treats these identically (checked: all access is `p.bidDueDate` truthiness / `project.planSets || []`).

- [ ] **Step 1: Write the failing round-trip + store tests**

```ts
// server/projectStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  listProjects, loadProject, createProject, saveProject, deleteProject,
  ValidationError, ConflictError,
} from './projectStore';

let db: Database.Database;
let dir: string;

// A realistic legacy project blob exercising every normalization path.
const LEGACY_PROJECT = {
  id: 'proj1',
  name: 'Maple St Office',
  createdAt: 1700000000000,
  contractor: 'Hensel Phelps',
  address: '1 Maple St',
  bidDueDate: 1710000000000,
  planSets: [{ id: 'ps1', name: 'Rev A', date: '2024-01-01', createdAt: 1700000000001 }],
  pages: [
    {
      id: 'page1', name: 'A1.0', pageNumber: 'A1.0', description: 'Floor plan',
      imageId: '', thumbnailId: 'thumb1', imageWidth: 3000, imageHeight: 2000,
      sourcePdfFileId: 'pdf1', sourcePdfPageNum: 1, searchTextIndexed: true,
      extractedText: 'lobby corridor', planSetId: 'ps1',
      scaleConfig: { pixelDistance: 100, realWorldDistance: 10, unit: 'ft' },
      showLegend: true, legendPosition: { x: 5, y: 5 },
      measurements: [
        {
          id: 'm1', type: 'area', name: 'Lobby', color: '#ff0000', takeoffId: 't1',
          points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
          heights: [9], isTwoSided: false, regionId: 'r1', planSetId: 'ps1',
        },
        { id: 'm2', type: 'count', name: 'Outlets', color: '#00ff00', points: [{ x: 5, y: 5 }] },
      ],
    },
    {
      id: 'page2', name: 'A2.0', imageId: 'raster1', imageWidth: 1500, imageHeight: 1000,
      measurements: [], scaleConfig: null,
    },
  ],
  takeoffs: [
    {
      id: 't1', name: 'Drywall', color: '#ff0000', type: 'area', unit: 'sqft',
      isAdvancedCost: true,
      customCosts: [{ id: 'c1', name: 'Board', type: 'yield', cost: 12, yield: 32 }],
    },
  ],
  printouts: [{ id: 'po1', name: 'Bid set', fileId: 'pofile1', createdAt: 1705000000000 }],
  submitted: true,
  legendOnAllPages: true,
  proposalFileId: 'prop1',
  emails: [{ from: 'gc@example.com', subject: 'plans', body: 'see attached', receivedAt: 1, attachmentIds: ['att1'] }],
};

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-ps-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations.filter(m => m.version <= 4));
});

const seedLegacyAndNormalize = (blob: any) => {
  db.prepare('INSERT INTO projects (id, data, createdAt) VALUES (?, ?, ?)')
    .run(blob.id, JSON.stringify(blob), blob.createdAt);
  // also seed referenced files so labeling has rows to update
  for (const fid of ['thumb1', 'pdf1', 'raster1', 'pofile1', 'prop1', 'att1']) {
    db.prepare(`INSERT INTO files (id, mime, size, sha256, kind, createdAt) VALUES (?, 'application/octet-stream', 1, 'x', 'other', 1)`).run(fid);
  }
  runMigrations(db, dir, migrations); // applies migration 5
};

describe('migration 5 + loadProject round-trip', () => {
  it('reassembles the legacy JSON shape exactly (plus version/status)', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    const loaded = loadProject(db, 'proj1');
    expect(loaded).toEqual({ ...LEGACY_PROJECT, version: 1, status: 'proposal_sent' });
  });

  it('nulls out the legacy data blob', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    const row = db.prepare('SELECT data FROM projects WHERE id = ?').get('proj1') as { data: string | null };
    expect(row.data).toBeNull();
  });

  it('labels referenced files with projectId and kind', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    const kind = (id: string) => (db.prepare('SELECT projectId, kind FROM files WHERE id = ?').get(id) as any);
    expect(kind('pdf1')).toEqual({ projectId: 'proj1', kind: 'plan' });
    expect(kind('thumb1')).toEqual({ projectId: 'proj1', kind: 'plan' });
    expect(kind('raster1')).toEqual({ projectId: 'proj1', kind: 'plan' });
    expect(kind('pofile1')).toEqual({ projectId: 'proj1', kind: 'printout' });
    expect(kind('prop1')).toEqual({ projectId: 'proj1', kind: 'proposal' });
    expect(kind('att1')).toEqual({ projectId: 'proj1', kind: 'document' });
  });

  it('derives status from legacy flags', () => {
    seedLegacyAndNormalize({ ...LEGACY_PROJECT, id: 'p2', submitted: false, archived: true });
    expect(loadProject(db, 'p2')!.status).toBe('archived');
  });
});

describe('saveProject', () => {
  beforeEach(() => seedLegacyAndNormalize(LEGACY_PROJECT));

  it('persists changes and bumps version', () => {
    const p = loadProject(db, 'proj1')!;
    p.name = 'Renamed';
    p.pages[0].measurements.push({ id: 'm3', type: 'length', name: 'Wall', color: '#0000ff', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    const result = saveProject(db, 'proj1', p);
    expect(result.version).toBe(2);
    const reloaded = loadProject(db, 'proj1')!;
    expect(reloaded.name).toBe('Renamed');
    expect(reloaded.version).toBe(2);
    expect(reloaded.pages[0].measurements).toHaveLength(3);
  });

  it('rejects a stale version with ConflictError', () => {
    const stale = loadProject(db, 'proj1')!;
    const fresh = loadProject(db, 'proj1')!;
    saveProject(db, 'proj1', fresh); // bumps to 2
    expect(() => saveProject(db, 'proj1', stale)).toThrow(ConflictError);
    // and the stale payload changed nothing
    expect(loadProject(db, 'proj1')!.version).toBe(2);
  });

  it('rejects payloads with missing version', () => {
    const p = loadProject(db, 'proj1')!;
    delete p.version;
    expect(() => saveProject(db, 'proj1', p)).toThrow(ValidationError);
  });

  it('rejects structurally invalid payloads', () => {
    const p = loadProject(db, 'proj1')!;
    expect(() => saveProject(db, 'proj1', { ...p, pages: undefined })).toThrow(ValidationError);
    expect(() => saveProject(db, 'proj1', { ...p, pages: 'nope' })).toThrow(ValidationError);
    expect(() => saveProject(db, 'proj1', { ...p, id: 'other' })).toThrow(ValidationError);
    expect(() => saveProject(db, 'proj1', { ...p, name: 42 })).toThrow(ValidationError);
  });

  it('never touches the files table on save', () => {
    const before = db.prepare('SELECT COUNT(*) as c FROM files').get() as any;
    const p = loadProject(db, 'proj1')!;
    p.pages = [p.pages[1]]; // drop page1 and all its file references
    saveProject(db, 'proj1', p);
    const after = db.prepare('SELECT COUNT(*) as c FROM files').get() as any;
    expect(after.c).toBe(before.c); // orphaned, NOT deleted
  });
});

describe('createProject / listProjects / deleteProject', () => {
  it('creates with version 1 and round-trips', () => {
    const result = createProject(db, { ...LEGACY_PROJECT, id: 'new1' });
    expect(result.version).toBe(1);
    expect(loadProject(db, 'new1')!.name).toBe('Maple St Office');
  });

  it('lists newest-first', () => {
    createProject(db, { ...LEGACY_PROJECT, id: 'a', createdAt: 1 });
    createProject(db, { ...LEGACY_PROJECT, id: 'b', createdAt: 2 });
    expect(listProjects(db).map((p: any) => p.id)).toEqual(['b', 'a']);
  });

  it('delete removes all child rows and project-owned files', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    deleteProject(db, dir, 'proj1');
    expect(loadProject(db, 'proj1')).toBeNull();
    for (const t of ['pages', 'measurements', 'takeoffs', 'plan_sets']) {
      expect((db.prepare(`SELECT COUNT(*) as c FROM ${t} WHERE projectId = 'proj1'`).get() as any).c).toBe(0);
    }
    expect((db.prepare(`SELECT COUNT(*) as c FROM files WHERE projectId = 'proj1'`).get() as any).c).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/projectStore.test.ts`
Expected: FAIL — `Cannot find module './projectStore'`

- [ ] **Step 3: Implement `server/projectStore.ts`**

```ts
// server/projectStore.ts
import type Database from 'better-sqlite3';
import { deleteFileContent } from './fileStore';

export class ValidationError extends Error {}
export class ConflictError extends Error {}

const parse = (s: string | null): any => (s == null ? undefined : JSON.parse(s));

// Adds key: value only when value is not null/undefined — assembly must omit
// keys the legacy JSON never had, but keep '' and 0 and false.
const put = (obj: any, key: string, value: any) => {
  if (value !== null && value !== undefined) obj[key] = value;
};

export function loadProject(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
  if (!row) return null;
  // Pre-normalization fallback (should not occur after migration 5, but a
  // legacy-dir import racing ahead of a re-run must not crash the API).
  if (row.data) {
    try { return { ...JSON.parse(row.data), version: row.version ?? 1, status: row.status ?? 'estimating' }; }
    catch { return null; }
  }

  const meta = parse(row.meta) ?? {};
  const project: any = { id: row.id };
  put(project, 'name', row.name);
  put(project, 'createdAt', row.createdAt);
  put(project, 'contractor', row.contractor);
  put(project, 'address', row.address);
  put(project, 'bidDueDate', row.bidDueDate);
  Object.assign(project, meta);

  const planSetRows = db.prepare('SELECT * FROM plan_sets WHERE projectId = ? ORDER BY sortOrder').all(id) as any[];
  if (planSetRows.length > 0) {
    project.planSets = planSetRows.map(ps => {
      const obj: any = { id: ps.id };
      put(obj, 'name', ps.name);
      Object.assign(obj, parse(ps.attrs) ?? {});
      return obj;
    });
  }

  const measByPage = new Map<string, any[]>();
  const measRows = db.prepare('SELECT * FROM measurements WHERE projectId = ? ORDER BY sortOrder').all(id) as any[];
  for (const m of measRows) {
    const obj: any = { id: m.id };
    put(obj, 'takeoffId', m.takeoffId);
    put(obj, 'type', m.type);
    put(obj, 'name', m.name);
    put(obj, 'color', m.color);
    obj.points = parse(m.points) ?? [];
    Object.assign(obj, parse(m.attrs) ?? {});
    if (!measByPage.has(m.pageId)) measByPage.set(m.pageId, []);
    measByPage.get(m.pageId)!.push(obj);
  }

  const pageRows = db.prepare('SELECT * FROM pages WHERE projectId = ? ORDER BY sortOrder').all(id) as any[];
  project.pages = pageRows.map(pg => {
    const obj: any = { id: pg.id };
    put(obj, 'name', pg.name);
    put(obj, 'pageNumber', pg.pageNumber);
    put(obj, 'planSetId', pg.planSetId);
    put(obj, 'imageId', pg.imageId);
    put(obj, 'thumbnailId', pg.thumbnailId);
    put(obj, 'sourcePdfFileId', pg.sourcePdfFileId);
    put(obj, 'sourcePdfPageNum', pg.sourcePdfPageNum);
    Object.assign(obj, parse(pg.attrs) ?? {});
    obj.measurements = measByPage.get(pg.id) ?? [];
    return obj;
  });

  const takeoffRows = db.prepare('SELECT * FROM takeoffs WHERE projectId = ? ORDER BY sortOrder').all(id) as any[];
  project.takeoffs = takeoffRows.map(t => {
    const obj: any = { id: t.id };
    put(obj, 'name', t.name);
    put(obj, 'color', t.color);
    put(obj, 'type', t.type);
    Object.assign(obj, parse(t.attrs) ?? {});
    return obj;
  });

  project.version = row.version;
  project.status = row.status;
  return project;
}

export function listProjects(db: Database.Database): any[] {
  const ids = db.prepare('SELECT id FROM projects ORDER BY createdAt DESC').all() as { id: string }[];
  return ids.map(r => loadProject(db, r.id)).filter(Boolean);
}

function validate(payload: any, id?: string): void {
  if (!payload || typeof payload !== 'object') throw new ValidationError('Payload must be an object');
  if (typeof payload.id !== 'string' || !payload.id) throw new ValidationError('Missing project id');
  if (id !== undefined && payload.id !== id) throw new ValidationError('Project id mismatch');
  if (payload.name !== undefined && typeof payload.name !== 'string') throw new ValidationError('name must be a string');
  if (!Array.isArray(payload.pages)) throw new ValidationError('pages must be an array');
  if (!Array.isArray(payload.takeoffs)) throw new ValidationError('takeoffs must be an array');
  if (payload.planSets !== undefined && !Array.isArray(payload.planSets)) throw new ValidationError('planSets must be an array');
  for (const pg of payload.pages) {
    if (!pg || typeof pg.id !== 'string' || !pg.id) throw new ValidationError('Every page needs an id');
    if (pg.measurements !== undefined && !Array.isArray(pg.measurements)) throw new ValidationError('measurements must be an array');
    for (const m of pg.measurements ?? []) {
      if (!m || typeof m.id !== 'string' || !m.id) throw new ValidationError('Every measurement needs an id');
      if (!Array.isArray(m.points)) throw new ValidationError('measurement points must be an array');
    }
  }
  for (const t of payload.takeoffs) {
    if (!t || typeof t.id !== 'string' || !t.id) throw new ValidationError('Every takeoff needs an id');
  }
}

export function deriveStatus(meta: any, existing?: string): string {
  if (existing && existing !== 'estimating') return existing;
  if (meta.archived) return 'archived';
  if (meta.accepted) return 'awarded';
  if (meta.submitted) return 'proposal_sent';
  return 'estimating';
}

// Splits a validated legacy-shaped payload into rows. Caller wraps in a
// transaction. Never touches the files table (spec §3.3 rule 4).
export function decomposeProject(db: Database.Database, payload: any, version: number): void {
  const {
    id, name, createdAt, contractor, address, bidDueDate,
    planSets, pages, takeoffs, version: _v, status: _s, ...meta
  } = payload;

  db.prepare(`
    UPDATE projects SET name = ?, status = ?, contractor = ?, address = ?, bidDueDate = ?,
                        version = ?, updatedAt = ?, meta = ?, data = NULL
    WHERE id = ?
  `).run(
    name ?? 'Untitled',
    deriveStatus(meta, _s),
    contractor ?? null,
    address ?? null,
    typeof bidDueDate === 'number' ? bidDueDate : null,
    version,
    Date.now(),
    JSON.stringify(meta),
    id
  );

  for (const t of ['measurements', 'pages', 'takeoffs', 'plan_sets']) {
    db.prepare(`DELETE FROM ${t} WHERE projectId = ?`).run(id);
  }

  const insPlanSet = db.prepare('INSERT INTO plan_sets (id, projectId, name, sortOrder, attrs) VALUES (?, ?, ?, ?, ?)');
  (planSets ?? []).forEach((ps: any, i: number) => {
    const { id: psId, name: psName, ...rest } = ps;
    insPlanSet.run(psId, id, psName ?? null, i, JSON.stringify(rest));
  });

  const insTakeoff = db.prepare('INSERT INTO takeoffs (id, projectId, name, type, color, sortOrder, attrs) VALUES (?, ?, ?, ?, ?, ?, ?)');
  (takeoffs ?? []).forEach((t: any, i: number) => {
    const { id: tId, name: tName, type, color, ...rest } = t;
    insTakeoff.run(tId, id, tName ?? null, type ?? null, color ?? null, i, JSON.stringify(rest));
  });

  const insPage = db.prepare(`
    INSERT INTO pages (id, projectId, planSetId, name, pageNumber, sortOrder, imageId, thumbnailId, sourcePdfFileId, sourcePdfPageNum, attrs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insMeas = db.prepare(`
    INSERT INTO measurements (id, pageId, projectId, takeoffId, type, name, color, points, sortOrder, attrs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  (pages ?? []).forEach((pg: any, i: number) => {
    const {
      id: pgId, planSetId, name: pgName, pageNumber,
      imageId, thumbnailId, sourcePdfFileId, sourcePdfPageNum,
      measurements, ...rest
    } = pg;
    insPage.run(
      pgId, id, planSetId ?? null, pgName ?? null, pageNumber ?? null, i,
      imageId ?? null, thumbnailId ?? null, sourcePdfFileId ?? null, sourcePdfPageNum ?? null,
      JSON.stringify(rest)
    );
    (measurements ?? []).forEach((m: any, j: number) => {
      const { id: mId, takeoffId, type, name: mName, color, points, ...mrest } = m;
      insMeas.run(mId, pgId, id, takeoffId ?? null, type ?? null, mName ?? null, color ?? null,
        JSON.stringify(points ?? []), j, JSON.stringify(mrest));
    });
  });
}

export function createProject(db: Database.Database, payload: any): { version: number } {
  validate(payload);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO projects (id, createdAt) VALUES (?, ?)')
      .run(payload.id, payload.createdAt ?? Date.now());
    decomposeProject(db, payload, 1);
  });
  tx();
  return { version: 1 };
}

export function saveProject(db: Database.Database, id: string, payload: any): { version: number } {
  validate(payload, id);
  if (!Number.isInteger(payload.version) || payload.version < 1) {
    throw new ValidationError('Missing or invalid version — reload the project and try again');
  }
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM projects WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new ValidationError('Project not found');
    if (row.version !== payload.version) {
      throw new ConflictError(`Project changed since it was loaded (server v${row.version}, payload v${payload.version})`);
    }
    newVersion = row.version + 1;
    decomposeProject(db, payload, newVersion);
  });
  tx();
  return { version: newVersion };
}

// Explicit user action — the one place project-owned files are deleted.
export function deleteProject(db: Database.Database, dataDir: string, id: string): void {
  const fileIds = (db.prepare('SELECT id FROM files WHERE projectId = ?').all(id) as { id: string }[]).map(r => r.id);
  const tx = db.transaction(() => {
    for (const t of ['measurements', 'pages', 'takeoffs', 'plan_sets']) {
      db.prepare(`DELETE FROM ${t} WHERE projectId = ?`).run(id);
    }
    db.prepare('DELETE FROM files WHERE projectId = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  });
  tx();
  for (const fid of fileIds) deleteFileContent(dataDir, fid);
}
```

- [ ] **Step 4: Append migration 5 to `server/migrationList.ts`**

Add to imports: `import { decomposeProject, deriveStatus } from './projectStore';`

```ts
  {
    version: 5,
    name: 'normalize-projects',
    up({ db }) {
      const labelFile = db.prepare('UPDATE files SET projectId = ?, kind = ?, name = COALESCE(?, name) WHERE id = ?');
      const label = (projectId: string, kind: string, name: string | null, fileId: any) => {
        if (typeof fileId === 'string' && fileId) labelFile.run(projectId, kind, name, fileId);
      };
      const rows = db.prepare('SELECT id, data FROM projects').all() as { id: string; data: string | null }[];
      for (const row of rows) {
        if (!row.data) continue;
        let p: any;
        try { p = JSON.parse(row.data); } catch {
          console.warn(`[migrations] skipping unparseable project ${row.id} (data preserved)`);
          continue;
        }
        p.id = row.id; // trust the row key over the blob
        decomposeProject(db, p, 1);

        // Label this project's files so Documents/storage views can attribute them.
        for (const pg of p.pages ?? []) {
          label(row.id, 'plan', pg.name ?? null, pg.imageId);
          label(row.id, 'plan', pg.name ?? null, pg.thumbnailId);
          label(row.id, 'plan', pg.name ?? null, pg.sourcePdfFileId);
        }
        for (const po of p.printouts ?? []) label(row.id, 'printout', po.name ?? null, po.fileId);
        label(row.id, 'proposal', 'Proposal', p.proposalFileId);
        const emails = [...(p.email ? [p.email] : []), ...(p.emails ?? [])];
        for (const e of emails) for (const aid of e?.attachmentIds ?? []) label(row.id, 'document', null, aid);
      }
      console.log(`[migrations] normalized ${rows.length} projects`);
    },
  },
```

**Note:** `decomposeProject` validates nothing here on purpose — migration must accept whatever shape old blobs have. It only destructures and inserts; missing arrays become empty. If a blob is so broken that `decomposeProject` throws, the whole migration transaction rolls back and nothing is lost — fix forward from the error message.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run server/projectStore.test.ts && npx vitest run`
Expected: PASS — all project store tests AND all previous suites still green.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run lint`
Expected: no errors.

```bash
git add server/projectStore.ts server/projectStore.test.ts server/migrationList.ts
git commit -m "feat: add project aggregation store + migration 5 (normalize projects)"
```

---

### Task 9: HTTP Routes Module

**Files:**
- Create: `server/routes.ts`
- Test: `server/routes.test.ts`

All rewritten endpoints live in `registerDataRoutes(app, deps)`. `server.ts` will call it (Task 10) and **delete its own copies** of these routes. Contracts are identical to the legacy routes except: PUT/POST projects return `{ success, version }`, PUT can return 400/409, and there is a new `GET /api/files/:id/content` streaming endpoint.

- [ ] **Step 1: Write the failing tests**

```ts
// server/routes.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { createProject, loadProject } from './projectStore';
import { registerDataRoutes } from './routes';

let db: Database.Database;
let dir: string;
let app: express.Express;

const PROJECT = {
  id: 'p1', name: 'Test Project', createdAt: 1, contractor: 'GC Co',
  pages: [{ id: 'pg1', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
  takeoffs: [],
};

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-rt-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  app = express();
  app.use(express.json({ limit: '50mb' }));
  registerDataRoutes(app, {
    db,
    dataDir: dir,
    dbFile: path.join(dir, 'app.db'),
    // auth stubs: every request is an authenticated admin
    authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role: 'admin' }; next(); },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    verifyToken: (token: string) => (token === 'good-token' ? { id: 'u1', role: 'admin' } : null),
  });
});

describe('projects routes', () => {
  it('POST + GET round-trip', async () => {
    const post = await request(app).post('/api/projects').send(PROJECT);
    expect(post.status).toBe(200);
    expect(post.body.version).toBe(1);
    const get = await request(app).get('/api/projects/p1');
    expect(get.status).toBe(200);
    expect(get.body.name).toBe('Test Project');
    expect(get.body.version).toBe(1);
  });

  it('PUT bumps version; stale PUT gets 409 and changes nothing', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    const v1 = (await request(app).get('/api/projects/p1')).body;
    const ok = await request(app).put('/api/projects/p1').send({ ...v1, name: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    const stale = await request(app).put('/api/projects/p1').send({ ...v1, name: 'Clobber' });
    expect(stale.status).toBe(409);
    expect((await request(app).get('/api/projects/p1')).body.name).toBe('Renamed');
  });

  it('PUT with invalid payload gets 400', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    const v1 = (await request(app).get('/api/projects/p1')).body;
    const res = await request(app).put('/api/projects/p1').send({ ...v1, pages: 'broken' });
    expect(res.status).toBe(400);
  });

  it('GET list returns aggregates newest-first; DELETE removes', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'p2', createdAt: 2 });
    const list = await request(app).get('/api/projects');
    expect(list.body.map((p: any) => p.id)).toEqual(['p2', 'p1']);
    await request(app).delete('/api/projects/p1');
    expect((await request(app).get('/api/projects/p1')).status).toBe(404);
  });
});

describe('images compat routes', () => {
  const PNG = 'data:image/png;base64,' + Buffer.from('pngbytes').toString('base64');

  it('POST /api/images + GET /api/images/:id round-trips the dataURL', async () => {
    await request(app).post('/api/images').send({ id: 'i1', data: PNG }).expect(200);
    const res = await request(app).get('/api/images/i1');
    expect(res.body.data).toBe(PNG);
  });

  it('GET /api/images/:id/raw streams decoded bytes with mime', async () => {
    await request(app).post('/api/images').send({ id: 'i1', data: PNG });
    const res = await request(app).get('/api/images/i1/raw');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.body.toString()).toBe('pngbytes');
  });

  it('POST /api/files/:id accepts raw binary', async () => {
    const res = await request(app)
      .post('/api/files/f1')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('pdfbytes'));
    expect(res.status).toBe(200);
    const get = await request(app).get('/api/images/f1');
    expect(get.body.data).toBe('data:application/pdf;base64,' + Buffer.from('pdfbytes').toString('base64'));
  });

  it('404s for unknown ids', async () => {
    expect((await request(app).get('/api/images/nope')).status).toBe(404);
    expect((await request(app).get('/api/images/nope/raw')).status).toBe(404);
  });
});

describe('GET /api/files/:id/content streaming', () => {
  beforeEach(async () => {
    await request(app)
      .post('/api/files/f1')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('0123456789'));
  });

  it('streams full content with Accept-Ranges', async () => {
    const res = await request(app).get('/api/files/f1/content?token=good-token');
    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('10');
    expect(res.body.toString()).toBe('0123456789');
  });

  it('serves byte ranges with 206', async () => {
    const res = await request(app)
      .get('/api/files/f1/content?token=good-token')
      .set('Range', 'bytes=2-5');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.body.toString()).toBe('2345');
  });

  it('rejects missing/bad tokens', async () => {
    expect((await request(app).get('/api/files/f1/content')).status).toBe(401);
    expect((await request(app).get('/api/files/f1/content?token=bad')).status).toBe(401);
  });
});

describe('storage + search + orphans', () => {
  it('orphan cleanup deletes only unreferenced files', async () => {
    await request(app).post('/api/projects').send({
      ...PROJECT,
      pages: [{ id: 'pg1', name: 'A1', imageId: 'used1', measurements: [], scaleConfig: null }],
    });
    const PNG = 'data:image/png;base64,' + Buffer.from('x').toString('base64');
    await request(app).post('/api/images').send({ id: 'used1', data: PNG });
    await request(app).post('/api/images').send({ id: 'orphan1', data: PNG });
    const orphans = await request(app).get('/api/storage/orphans');
    expect(orphans.body.count).toBe(1);
    const cleanup = await request(app).post('/api/storage/orphans/cleanup');
    expect(cleanup.body.deleted).toBe(1);
    expect((await request(app).get('/api/images/used1')).status).toBe(200);
    expect((await request(app).get('/api/images/orphan1')).status).toBe(404);
  });

  it('search finds projects, pages, and takeoffs from normalized tables', async () => {
    await request(app).post('/api/projects').send({
      ...PROJECT,
      name: 'Maple Office',
      pages: [{ id: 'pg1', name: 'Lobby Plan', imageId: '', measurements: [], scaleConfig: null }],
      takeoffs: [{ id: 't1', name: 'Drywall', color: '#fff', type: 'area' }],
    });
    const res = await request(app).get('/api/search?q=maple');
    expect(res.body.results.some((r: any) => r.type === 'project')).toBe(true);
    const res2 = await request(app).get('/api/search?q=lobby');
    expect(res2.body.results.some((r: any) => r.type === 'page')).toBe(true);
    const res3 = await request(app).get('/api/search?q=drywall');
    expect(res3.body.results.some((r: any) => r.type === 'takeoff')).toBe(true);
  });

  it('project storage endpoint reports file bytes', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    const res = await request(app).get('/api/projects/p1/storage');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalBytes');
    expect(res.body).toHaveProperty('imageBytes');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes.test.ts`
Expected: FAIL — `Cannot find module './routes'`

- [ ] **Step 3: Implement `server/routes.ts`**

```ts
// server/routes.ts
import express from 'express';
import fsSync from 'fs';
import type Database from 'better-sqlite3';
import {
  listProjects, loadProject, createProject, saveProject, deleteProject,
  ValidationError, ConflictError,
} from './projectStore';
import { putDataUrl, putBuffer, getMeta, getDataUrlString } from './files';
import { pathFor, statFile, deleteFileContent } from './fileStore';

export interface RouteDeps {
  db: Database.Database;
  dataDir: string;
  dbFile: string;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  // Verifies a JWT from a query parameter (for streaming URLs that can't set
  // headers). Returns the decoded user or null.
  verifyToken: (token: string) => unknown | null;
}

export function registerDataRoutes(app: express.Express, deps: RouteDeps): void {
  const { db, dataDir, dbFile, authenticateToken, requireAdmin, verifyToken } = deps;

  // ── Projects ──────────────────────────────────────────────────────────────

  app.get('/api/projects', authenticateToken, (_req, res) => {
    try {
      res.json(listProjects(db));
    } catch (e) {
      console.error('Error fetching projects:', e);
      res.status(500).json({ error: 'Failed to fetch projects' });
    }
  });

  app.get('/api/projects/:id', authenticateToken, (req, res) => {
    try {
      const project = loadProject(db, req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      res.json(project);
    } catch (e) {
      console.error('Error fetching project:', e);
      res.status(500).json({ error: 'Failed to fetch project' });
    }
  });

  app.post('/api/projects', authenticateToken, (req, res) => {
    try {
      const result = createProject(db, req.body);
      res.json({ success: true, version: result.version });
    } catch (e) {
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      console.error('Error creating project:', e);
      res.status(500).json({ error: 'Failed to create project' });
    }
  });

  app.put('/api/projects/:id', authenticateToken, (req, res) => {
    try {
      const result = saveProject(db, req.params.id, req.body);
      res.json({ success: true, version: result.version });
    } catch (e) {
      if (e instanceof ConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      console.error('Error updating project:', e);
      res.status(500).json({ error: 'Failed to update project' });
    }
  });

  app.delete('/api/projects/:id', authenticateToken, (req, res) => {
    try {
      deleteProject(db, dataDir, req.params.id);
      res.json({ success: true });
    } catch (e) {
      console.error('Error deleting project:', e);
      res.status(500).json({ error: 'Failed to delete project' });
    }
  });

  app.get('/api/projects/:id/storage', authenticateToken, (req, res) => {
    try {
      const project = loadProject(db, req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const { version, status, ...legacyShape } = project;
      const dataBytes = Buffer.byteLength(JSON.stringify(legacyShape), 'utf8');
      const img = db.prepare(
        'SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM files WHERE projectId = ?'
      ).get(req.params.id) as { count: number; bytes: number };
      const noteRow = db.prepare(
        'SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) as bytes FROM notes WHERE projectId = ?'
      ).get(req.params.id) as { bytes: number };
      res.json({
        totalBytes: dataBytes + img.bytes + noteRow.bytes,
        dataBytes,
        imageBytes: img.bytes,
        noteBytes: noteRow.bytes,
        imageCount: img.count,
      });
    } catch (e) {
      console.error('Error computing project storage:', e);
      res.status(500).json({ error: 'Failed to compute project storage' });
    }
  });

  // ── Images (legacy compat) + files ────────────────────────────────────────

  app.get('/api/images/:id', authenticateToken, (req, res) => {
    try {
      const data = getDataUrlString(db, dataDir, req.params.id);
      if (data == null) return res.status(404).json({ error: 'Image not found' });
      res.json({ data });
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch image' });
    }
  });

  // Public (used in <img src> / pdf.js URLs) — kept public deliberately.
  app.get('/api/images/:id/raw', (req, res) => {
    try {
      const meta = getMeta(db, req.params.id);
      const st = statFile(dataDir, req.params.id);
      if (!meta || !st) return res.status(404).send('Image not found');
      res.set('Content-Type', meta.mime);
      res.set('Content-Length', String(st.size));
      res.set('Cache-Control', 'public, max-age=31536000');
      fsSync.createReadStream(pathFor(dataDir, req.params.id)).pipe(res);
    } catch (e) {
      res.status(500).send('Failed to fetch image');
    }
  });

  app.post('/api/images', authenticateToken, (req, res) => {
    try {
      const { id, data } = req.body;
      if (typeof id !== 'string' || !id || typeof data !== 'string' || !data) {
        return res.status(400).json({ error: 'id and data are required' });
      }
      putDataUrl(db, dataDir, id, data);
      res.json({ success: true });
    } catch (e) {
      console.error('Error saving image:', e);
      res.status(500).json({ error: 'Failed to save image' });
    }
  });

  app.post(
    '/api/files/:id',
    express.raw({ limit: '100mb', type: () => true }),
    authenticateToken,
    (req, res) => {
      try {
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return res.status(400).json({ error: 'Empty body' });
        }
        const mime = (req.get('Content-Type') || 'application/octet-stream').split(';')[0].trim();
        putBuffer(db, dataDir, req.params.id, body, mime);
        res.json({ success: true });
      } catch (e) {
        console.error('Error saving file:', e);
        res.status(500).json({ error: 'Failed to save file' });
      }
    }
  );

  // Streaming read with HTTP Range support. Auth via Authorization header or
  // ?token= (media elements and pdf.js can't always set headers).
  app.get('/api/files/:id/content', (req, res) => {
    try {
      const header = req.headers['authorization'];
      const bearer = header && header.split(' ')[1];
      const token = bearer || String(req.query.token || '');
      if (!token || !verifyToken(token)) return res.status(401).json({ error: 'Authentication required' });

      const meta = getMeta(db, req.params.id);
      const st = statFile(dataDir, req.params.id);
      if (!meta || !st) return res.status(404).json({ error: 'File not found' });

      const filePath = pathFor(dataDir, req.params.id);
      res.set('Accept-Ranges', 'bytes');
      res.set('Content-Type', meta.mime);

      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m) return res.status(416).set('Content-Range', `bytes */${st.size}`).end();
        let start = m[1] === '' ? NaN : parseInt(m[1], 10);
        let end = m[2] === '' ? NaN : parseInt(m[2], 10);
        if (Number.isNaN(start)) { start = st.size - end; end = st.size - 1; } // suffix range
        if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
        if (Number.isNaN(start) || start < 0 || start > end) {
          return res.status(416).set('Content-Range', `bytes */${st.size}`).end();
        }
        res.status(206);
        res.set('Content-Range', `bytes ${start}-${end}/${st.size}`);
        res.set('Content-Length', String(end - start + 1));
        fsSync.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.set('Content-Length', String(st.size));
        fsSync.createReadStream(filePath).pipe(res);
      }
    } catch (e) {
      console.error('Error streaming file:', e);
      res.status(500).json({ error: 'Failed to stream file' });
    }
  });

  // ── Storage admin ─────────────────────────────────────────────────────────

  // Conservative reference walk: serialize every project aggregate plus every
  // remaining JSON blob (bids, checklists, notes) and shares, collect every
  // string and every /api/images|files/<id> URL. A file is an orphan only if
  // its id appears nowhere.
  const collectReferencedFileIds = (): Set<string> => {
    const referenced = new Set<string>();
    const urlRe = /\/api\/(?:images|files)\/([^/"'?\s]+)/g;
    const addString = (s: string) => {
      referenced.add(s);
      let m: RegExpExecArray | null;
      urlRe.lastIndex = 0;
      while ((m = urlRe.exec(s)) !== null) {
        try { referenced.add(decodeURIComponent(m[1])); } catch { referenced.add(m[1]); }
      }
    };
    const walk = (v: any) => {
      if (v == null) return;
      if (typeof v === 'string') { addString(v); return; }
      if (Array.isArray(v)) { for (const x of v) walk(x); return; }
      if (typeof v === 'object') { for (const k in v) walk(v[k]); return; }
    };
    for (const p of listProjects(db)) walk(p);
    for (const table of ['bids', 'checklists', 'notes']) {
      let rows: { data: string }[] = [];
      try { rows = db.prepare(`SELECT data FROM ${table}`).all() as { data: string }[]; } catch { continue; }
      for (const r of rows) {
        if (!r.data) continue;
        try { walk(JSON.parse(r.data)); } catch { addString(r.data); }
      }
    }
    // shares reference files directly (single-file shares) or via JSON page lists
    const shareRows = db.prepare('SELECT resourceId FROM shares').all() as { resourceId: string }[];
    for (const r of shareRows) {
      addString(r.resourceId);
      try { walk(JSON.parse(r.resourceId)); } catch { /* plain id */ }
    }
    return referenced;
  };

  app.get('/api/storage/stats', authenticateToken, requireAdmin, (_req, res) => {
    try {
      let databaseBytes = 0;
      try { databaseBytes = fsSync.statSync(dbFile).size; } catch { /* ignore */ }
      const sumLen = (sql: string): number => {
        try { return (db.prepare(sql).get() as { bytes: number }).bytes; } catch { return 0; }
      };
      const breakdown = {
        images: sumLen('SELECT COALESCE(SUM(size), 0) as bytes FROM files'),
        projects: sumLen(`SELECT COALESCE(SUM(length(CAST(coalesce(meta,'') AS BLOB))), 0) as bytes FROM projects`)
          + sumLen(`SELECT COALESCE(SUM(length(CAST(coalesce(attrs,'') AS BLOB))), 0) as bytes FROM pages`)
          + sumLen(`SELECT COALESCE(SUM(length(CAST(points AS BLOB)) + length(CAST(coalesce(attrs,'') AS BLOB))), 0) as bytes FROM measurements`)
          + sumLen(`SELECT COALESCE(SUM(length(CAST(coalesce(attrs,'') AS BLOB))), 0) as bytes FROM takeoffs`),
        templates: sumLen('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) as bytes FROM templates'),
        bids: sumLen('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) as bytes FROM bids'),
        notes: sumLen('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) as bytes FROM notes'),
        checklists: sumLen('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) as bytes FROM checklists'),
      };
      const imageCount = (db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c;
      const fileBytesByProject = new Map<string, number>(
        (db.prepare('SELECT projectId, SUM(size) as bytes FROM files WHERE projectId IS NOT NULL GROUP BY projectId').all() as any[])
          .map(r => [r.projectId, r.bytes])
      );
      const projects = (db.prepare('SELECT id, name FROM projects').all() as { id: string; name: string | null }[])
        .map(r => ({ id: r.id, name: r.name || 'Untitled', totalBytes: fileBytesByProject.get(r.id) ?? 0 }))
        .sort((a, b) => b.totalBytes - a.totalBytes);
      res.json({ databaseBytes, breakdown, imageCount, projectCount: projects.length, projects });
    } catch (e) {
      console.error('Error computing storage stats:', e);
      res.status(500).json({ error: 'Failed to compute storage stats' });
    }
  });

  app.get('/api/storage/orphans', authenticateToken, requireAdmin, (_req, res) => {
    try {
      const referenced = collectReferencedFileIds();
      const rows = db.prepare('SELECT id, size FROM files').all() as { id: string; size: number }[];
      let count = 0, bytes = 0;
      for (const r of rows) if (!referenced.has(r.id)) { count++; bytes += r.size; }
      res.json({ count, bytes });
    } catch (e) {
      console.error('Error finding orphaned files:', e);
      res.status(500).json({ error: 'Failed to find orphaned files' });
    }
  });

  app.post('/api/storage/orphans/cleanup', authenticateToken, requireAdmin, (_req, res) => {
    try {
      const referenced = collectReferencedFileIds();
      const rows = db.prepare('SELECT id, size FROM files').all() as { id: string; size: number }[];
      const orphans = rows.filter(r => !referenced.has(r.id));
      const bytesFreed = orphans.reduce((a, r) => a + r.size, 0);
      const tx = db.transaction(() => {
        const stmt = db.prepare('DELETE FROM files WHERE id = ?');
        for (const o of orphans) stmt.run(o.id);
      });
      tx();
      for (const o of orphans) deleteFileContent(dataDir, o.id);
      res.json({ deleted: orphans.length, bytesFreed });
    } catch (e) {
      console.error('Error cleaning up orphaned files:', e);
      res.status(500).json({ error: 'Failed to clean up orphaned files' });
    }
  });

  // ── Search (normalized) ───────────────────────────────────────────────────

  app.get('/api/search', authenticateToken, (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      if (q.length < 2) return res.json({ results: [] });
      const like = `%${q}%`;
      const results: any[] = [];

      const projRows = db.prepare(`
        SELECT id, name, contractor, address FROM projects
        WHERE lower(coalesce(name,'') || ' ' || coalesce(contractor,'') || ' ' || coalesce(address,'')) LIKE ?
        LIMIT 6
      `).all(like) as any[];
      for (const p of projRows) {
        results.push({ type: 'project', id: `project:${p.id}`, title: p.name || 'Untitled', subtitle: p.contractor || p.address || '', projectId: p.id });
      }

      const pageRows = db.prepare(`
        SELECT pg.id, pg.projectId, pg.name, pg.pageNumber, pr.name as projectName
        FROM pages pg JOIN projects pr ON pr.id = pg.projectId
        WHERE lower(coalesce(pg.pageNumber,'') || ' ' || coalesce(pg.name,'') || ' ' || coalesce(pg.attrs,'')) LIKE ?
        LIMIT 12
      `).all(like) as any[];
      for (const pg of pageRows) {
        results.push({
          type: 'page',
          id: `page:${pg.projectId}:${pg.id}`,
          title: [pg.pageNumber, pg.name].filter(Boolean).join(' — ') || 'Page',
          subtitle: pg.projectName || 'Untitled',
          projectId: pg.projectId,
          pageId: pg.id,
        });
      }

      const takeoffRows = db.prepare(`
        SELECT t.id, t.projectId, t.name, pr.name as projectName
        FROM takeoffs t JOIN projects pr ON pr.id = t.projectId
        WHERE lower(coalesce(t.name,'')) LIKE ?
        LIMIT 6
      `).all(like) as any[];
      for (const t of takeoffRows) {
        results.push({ type: 'takeoff', id: `takeoff:${t.projectId}:${t.id}`, title: t.name, subtitle: t.projectName || 'Untitled', projectId: t.projectId });
      }

      // bids stay JSON blobs until Phase 3 removes them
      const bidRows = db.prepare('SELECT data FROM bids').all() as { data: string }[];
      let bidHits = 0;
      for (const r of bidRows) {
        if (bidHits >= 6) break;
        let b: any;
        try { b = JSON.parse(r.data); } catch { continue; }
        const hay = [b.name, b.contractor, b.address].filter(Boolean).join(' ').toLowerCase();
        if (hay.includes(q)) {
          results.push({ type: 'bid', id: `bid:${b.id}`, title: b.name || b.contractor || 'Bid', subtitle: b.contractor || '', bidId: b.id });
          bidHits++;
        }
      }
      res.json({ results });
    } catch (e) {
      console.error('Error running search:', e);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // ── Public share file serving (metadata share routes stay in server.ts) ──

  const sendFileById = (res: express.Response, id: string, cacheSeconds: number) => {
    const meta = getMeta(db, id);
    const st = statFile(dataDir, id);
    if (!meta || !st) return res.status(404).send('File not found');
    res.set('Content-Type', meta.mime);
    res.set('Content-Length', String(st.size));
    res.set('Cache-Control', `public, max-age=${cacheSeconds}`);
    fsSync.createReadStream(pathFor(dataDir, id)).pipe(res);
  };

  app.get('/api/share/:shareId/image/:index', (req, res) => {
    try {
      const share = db.prepare('SELECT type, resourceId FROM shares WHERE id = ?').get(req.params.shareId) as { type: string; resourceId: string } | undefined;
      if (!share || share.type !== 'pages') return res.status(404).send('Share not found');
      const pages = JSON.parse(share.resourceId) as { imageId: string }[];
      const idx = parseInt(req.params.index, 10);
      if (isNaN(idx) || idx < 0 || idx >= pages.length) return res.status(404).send('Page not found');
      sendFileById(res, pages[idx].imageId, 3600);
    } catch {
      res.status(500).send('Server error');
    }
  });

  app.get('/api/share/:shareId', (req, res) => {
    try {
      const share = db.prepare('SELECT resourceId FROM shares WHERE id = ?').get(req.params.shareId) as { resourceId: string } | undefined;
      if (!share) return res.status(404).send('Share not found');
      sendFileById(res, share.resourceId, 3600);
    } catch {
      res.status(500).send('Server error');
    }
  });
}
```

**Route-ordering note:** `GET /api/share/:shareId` cannot shadow `GET /api/share/:shareId/info` or `/page-info/:index` — `:shareId` matches exactly one path segment, so `/api/share/abc/info` never matches the shorter route regardless of registration order. The `/info` and `/page-info` metadata routes stay in server.ts unchanged.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/routes.test.ts && npm run lint`
Expected: PASS (all route tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/routes.test.ts
git commit -m "feat: add rewritten data routes with save-safety and streaming"
```

---

### Task 10: Rewire server.ts

**Files:**
- Modify: `server.ts`

No new tests in this task — `server.ts` becomes a thin shell over already-tested modules; verification is the running app + existing suites. Make these changes **in one commit** since the file won't run half-converted.

- [ ] **Step 1: Replace imports and startup**

At the top of `server.ts`, add:

```ts
import { openDb } from './server/db';
import { runMigrations } from './server/migrations';
import { migrations } from './server/migrationList';
import { registerDataRoutes } from './server/routes';
import { loadProject, saveProject as storeSaveProject } from './server/projectStore';
import { getDataUrlString, getMeta } from './server/files';
```

Replace the body of `initDb()` (`server.ts:80-215`): keep the directory/permission checks (`server.ts:82-110`) verbatim, then replace everything from `db = new Database(DB_FILE)` through the end of the function with:

```ts
    db = openDb(DB_FILE);
    runMigrations(db, DATA_DIR, migrations, { dbFile: DB_FILE });

    // Initialize default settings
    const settingsCount = db.prepare('SELECT COUNT(*) as count FROM settings').get() as { count: number };
    if (settingsCount.count === 0) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('appName', 'Takeoff Pro');
    }

    // Create default admin user if no users exist
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    if (userCount.count === 0) {
      const hash = bcrypt.hashSync('admin', 10);
      db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run(
        'admin-id-123', 'admin', hash, 'admin'
      );
    }
```

Keep the surrounding try/catch + fatal-error logging. Note the pragma now lives in `openDb`.

- [ ] **Step 2: Delete superseded code from server.ts**

Delete entirely:
- `collectProjectImageIds()` (`server.ts:29-42`) and `collectAllReferencedImageIds()` (`server.ts:48-74`)
- `migrateOldData()` (`server.ts:217-272`) and its call site
- Projects routes: GET list, GET one, POST, PUT, DELETE, GET storage (`server.ts:432-585`)
- Images routes: GET, GET raw, POST, POST /api/files/:id (`server.ts:587-662`)
- Storage routes: stats, orphans, orphans/cleanup (`server.ts:817-902`)
- Search route (`server.ts:908-978`)
- Share file-serving routes: `GET /api/share/:shareId/image/:index` and `GET /api/share/:shareId` (`server.ts:1015-1049`)
- The unused `import Database from "better-sqlite3"` if nothing else references it (the `let db: Database.Database` type annotation still needs the type import: change to `import type Database from "better-sqlite3"`)

Keep: `/api/share/:shareId/info`, `/api/share/:shareId/page-info/:index`, shares POST/DELETE, templates, bids, notes, settings, users, auth, time entries, email routes, socket handlers — all unchanged.

- [ ] **Step 3: Register the new routes**

In `startServer()`, immediately after the `authenticateToken`/`requireAdmin` definitions (`server.ts:317-339`), add:

```ts
  registerDataRoutes(app, {
    db,
    dataDir: DATA_DIR,
    dbFile: DB_FILE,
    authenticateToken,
    requireAdmin,
    verifyToken: (token: string) => {
      try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
    },
  });
```

- [ ] **Step 4: Rewire the two send-proposal endpoints**

In `POST /api/bids/:id/send-proposal` (`server.ts:1413`) and `POST /api/projects/:id/send-proposal` (`server.ts:1466`), the attachment is currently read from the images table. Replace each `db.prepare('SELECT data FROM images WHERE id = ?')...` read with:

```ts
      const fileData = getDataUrlString(db, DATA_DIR, fileId);
      if (!fileData) return res.status(404).json({ error: 'Proposal file not found' });
      // (then parse fileData with the existing dataURL regex exactly as before)
```

In the projects variant, replace the whole-project load + `INSERT OR REPLACE INTO projects` write (`server.ts:~1470-1510`) with the version-safe store:

```ts
      const project = loadProject(db, req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      // ...existing email-sending logic unchanged...
      const updatedProject = { ...project, proposalFileId: fileId, proposalSentAt: Date.now() };
      storeSaveProject(db, req.params.id, updatedProject); // server-side load→save: version is current
      res.json(loadProject(db, req.params.id));
```

- [ ] **Step 5: Boot and smoke-test against a fresh data dir**

```bash
STORAGE_PATH=/tmp/ft-smoke-$$ npm run dev
```

Expected in logs: `[migrations] applied 1: base-schema` … `applied 5: normalize-projects`. Then in a browser at the printed port: log in (admin/admin on fresh data), create a project from a small PDF, draw a measurement, reload — everything persists. `/tmp/ft-smoke-*/files/` contains sharded content; `app.db` stays small. Stop the server.

- [ ] **Step 6: Typecheck, full test run, commit**

Run: `npm run lint && npm test`
Expected: clean.

```bash
git add server.ts
git commit -m "refactor: rewire server.ts onto migration framework and new data layer"
```

---

### Task 11: Client — Write Safety + Conflict Handling

**Files:**
- Modify: `src/utils/store.ts`
- Modify: `src/types.ts:181-202`
- Create: `src/components/ProjectConflictListener.tsx`
- Modify: `src/App.tsx` (mount the listener inside the providers)

- [ ] **Step 1: Add `version`/`status` to the Project type**

In `src/types.ts`, inside `interface Project` (after line 201, `proposalSentAt?: number;`):

```ts
  // Optimistic-concurrency version — echoed back on save; the server rejects
  // stale saves with 409. Assigned by the server (1 on create).
  version?: number;
  // Lifecycle stage (estimating | proposal_sent | awarded | in_progress |
  // punch_list | complete | archived | lost). Server-derived in Phase 1.
  status?: string;
```

- [ ] **Step 2: Stop retrying writes in `fetchWithRetry`**

In `src/utils/store.ts:22-54`, at the top of `fetchWithRetry` replace the `const { timeoutMs = 60_000, retries = 3 } = opts;` line with:

```ts
  // Writes are never auto-retried: a retried PUT can carry a stale body and
  // the version handshake would reject it confusingly (and POSTs aren't
  // idempotent). Reads stay retried for flaky connections.
  const method = (init.method || 'GET').toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD';
  const { timeoutMs = 60_000, retries: requestedRetries = 3 } = opts;
  const retries = isWrite ? 0 : requestedRetries;
```

- [ ] **Step 3: Add ConflictError + 409 handling to `saveProject` and `createProject`**

In `src/utils/store.ts`, add after the `handleResponse` function (line 68):

```ts
export class ConflictError extends Error {
  constructor(public projectId: string) {
    super('Project was changed elsewhere');
    this.name = 'ConflictError';
  }
}
```

Replace `saveProject` (`src/utils/store.ts:102-109`) with:

```ts
export const saveProject = async (project: Project): Promise<void> => {
  const res = await fetchWithRetry('/api/projects/' + project.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(project)
  });
  if (res.status === 409) {
    window.dispatchEvent(new CustomEvent('project-conflict', { detail: { projectId: project.id } }));
    throw new ConflictError(project.id);
  }
  await handleResponse(res);
  // Adopt the server's new version so the next save isn't stale. Callers keep
  // this same object (or spreads of it) in state, so mutating is sufficient.
  const body = await res.json().catch(() => null);
  if (body && typeof body.version === 'number') project.version = body.version;
};
```

Replace `createProject` (`src/utils/store.ts:111-118`) with:

```ts
export const createProject = async (project: Project): Promise<void> => {
  const res = await fetchWithRetry('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(project)
  });
  await handleResponse(res);
  const body = await res.json().catch(() => null);
  project.version = body && typeof body.version === 'number' ? body.version : 1;
};
```

- [ ] **Step 4: Create the global conflict listener**

```tsx
// src/components/ProjectConflictListener.tsx
import { useEffect, useRef } from 'react';
import { useToast } from './Toast';

// One global handler for project version conflicts (48 saveProject call
// sites — centralizing beats wiring every one). A conflict means this tab's
// copy is stale: tell the user, then reload so they continue from fresh data.
export default function ProjectConflictListener() {
  const toast = useToast();
  const reloading = useRef(false);

  useEffect(() => {
    const onConflict = () => {
      if (reloading.current) return;
      reloading.current = true;
      toast.error('This project was changed elsewhere — reloading to get the latest…');
      setTimeout(() => window.location.reload(), 2000);
    };
    window.addEventListener('project-conflict', onConflict);
    return () => window.removeEventListener('project-conflict', onConflict);
  }, [toast]);

  return null;
}
```

**Check the actual `useToast` API before writing this** — open `src/components/Toast.tsx` and match its real export names and method shape (`toast.error(...)` vs `showToast('...', 'error')`). Use whatever the codebase actually exposes.

- [ ] **Step 5: Mount it in App.tsx**

In `src/App.tsx`, find the Layout/provider tree (where `ToastProvider` wraps the routes) and render `<ProjectConflictListener />` as a child **inside** `ToastProvider`, alongside the routes. Import it at the top.

- [ ] **Step 6: Typecheck and manually verify the conflict path**

Run: `npm run lint`
Expected: clean.

Manual check (dev server from Task 10 still works): open the same project in two browser tabs, rename it in tab A (saves, version bumps), then change anything in tab B (stale version) — tab B must show the conflict toast and reload with tab A's change intact. **This exact scenario silently destroyed data before Phase 1.**

- [ ] **Step 7: Commit**

```bash
git add src/utils/store.ts src/types.ts src/components/ProjectConflictListener.tsx src/App.tsx
git commit -m "feat: client write safety — no write retries, 409 conflict handling"
```

---

### Task 12: Full Verification + Observed Migration Run

**Files:** none (verification only)

- [ ] **Step 1: Full automated pass**

Run: `npm run lint && npm test`
Expected: zero type errors, all suites green.

- [ ] **Step 2: Fresh-install boot**

```bash
STORAGE_PATH=/tmp/ft-fresh-$$ npm run dev
```

Expected: migrations 1-5 apply on an empty dir; login works; project create/draw/save/reload works; PDF upload works (file lands under `files/`, not in the DB).

- [ ] **Step 3: 🛑 CHECKPOINT — Nathan observes the real-data migration**

**STOP. Do not run this step autonomously.** Tell Nathan the migration is ready to test against his testing-branch data and wait for him to be present (he explicitly asked to watch). Then, together:

1. Copy his testing instance's data directory to a scratch location (never migrate the original): `cp -r <testing-data-dir> /tmp/ft-migration-test`
2. Run `STORAGE_PATH=/tmp/ft-migration-test npm run dev` and watch the migration log lines (backup path, blobs moved, projects normalized).
3. Verify together in the browser: projects list intact, a takeoff-heavy project opens with all measurements/scales/legends, plan pages render, a proposal PDF still opens, checklists/time entries untouched.
4. Confirm `backups/app-v0-*.db` exists and `app.db` shrank dramatically while `files/` holds the content.
5. Re-run the server a second time — migrations apply nothing, app works (idempotency on real data).

- [ ] **Step 4: Smoke checklist for the takeoff workflow** (the code with the most to lose — from spec §8)

- [ ] Upload a multi-page PDF plan set; pages detected and named
- [ ] Set scale on a page; draw length, area, and count measurements
- [ ] Measurements persist across reload; totals correct in ProjectView
- [ ] Add a takeoff with advanced costs; cost table computes
- [ ] Generate a proposal PDF; it stores and opens
- [ ] Plan-set revision flow still works (upload revision, compare)
- [ ] Two-tab conflict test from Task 11 step 6
- [ ] PDF editor opens a printout; spreadsheet editor opens a printout
- [ ] Share link for a page set still serves images

- [ ] **Step 5: Push**

```bash
git push origin testing
```

---

## Plan Self-Review Notes (already applied)

1. **Spec coverage (§3, §9 Phase 1):** normalized tables ✅ (Tasks 5, 8) · files on disk ✅ (Tasks 4, 6, 7) · metadata-only files table ✅ · versioned auto-migrations with backup ✅ (Task 3) · granular-write *foundation* ✅ (rows exist; granular endpoints intentionally deferred to Phase 3 when the UI consumes them — the aggregate save is now transactional, validated, version-checked) · optimistic concurrency ✅ (Tasks 8, 9, 11) · no destructive side-effects ✅ (save never touches files; orphan cleanup explicit; Task 8 test pins this) · no write auto-retry ✅ (Task 11) · aggregation layer keeps UI working ✅ (Tasks 8, 9) · streaming with range support ✅ (Task 9).
2. **Known deliberate deferrals:** `GET /api/projects` still returns full aggregates (dashboard slimming is Phase 3); files uploaded via legacy compat endpoints carry `projectId = NULL` until Phase 3 passes project context (they're protected from cleanup by the reference walk); socket.io collaboration unchanged.
3. **Type consistency check:** `registerDataRoutes` deps match between Task 9 implementation and tests; `decomposeProject(db, payload, version)` signature matches both call sites (projectStore + migration 5); `getDataUrlString(db, dataDir, id)` matches all call sites; `ConflictError` exists in both server (`projectStore.ts`) and client (`store.ts`) — they are separate classes by design.
4. **Circular-import check:** `migrationList.ts` imports from `projectStore.ts` (migration 5) and `files.ts`/`fileStore.ts`; none of those import `migrationList.ts`. No cycle.

