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
