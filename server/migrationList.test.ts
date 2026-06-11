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
