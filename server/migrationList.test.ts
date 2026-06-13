import { describe, it, expect } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { getDataUrlString } from './files';
import { readFileContent } from './fileStore';

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

  it('preserves non-canonical dataURL prefixes through migration', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 3));
    const url = 'data:text/plain;charset=utf-8;base64,' + Buffer.from('hello').toString('base64');
    db.prepare('INSERT INTO images (id, data) VALUES (?, ?)').run('txt1', url);
    runMigrations(db, dir, migrations.filter(m => m.version <= 4));
    expect(getDataUrlString(db, dir, 'txt1')).toBe(url);
    db.close();
  });
});

describe('migration 6: remove-bid-inbox', () => {
  it('drops the bids and email_accounts tables', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    expect(tables).not.toContain('bids');
    expect(tables).not.toContain('email_accounts');
    db.close();
  });

  it('preserves bid attachment files rows', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 5));
    db.prepare(`INSERT INTO files (id, mime, size, sha256, kind, createdAt) VALUES ('att1','application/pdf',1,'x','document',1)`).run();
    runMigrations(db, dir, migrations);
    expect((db.prepare('SELECT COUNT(*) as c FROM files').get() as any).c).toBe(1);
    db.close();
  });
});

describe('migration 7: drafts', () => {
  it('creates the drafts table keyed by user+file', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    expect(tableNames(db)).toContain('drafts');
    db.prepare(`INSERT INTO drafts (userId, fileId, kind, data, updatedAt) VALUES ('u1','f1','pdf','{}',1)`).run();
    // same key replaces, different user coexists
    db.prepare(`INSERT OR REPLACE INTO drafts (userId, fileId, kind, data, updatedAt) VALUES ('u1','f1','pdf','{"a":1}',2)`).run();
    db.prepare(`INSERT INTO drafts (userId, fileId, kind, data, updatedAt) VALUES ('u2','f1','pdf','{}',1)`).run();
    expect((db.prepare('SELECT COUNT(*) AS c FROM drafts').get() as any).c).toBe(2);
    db.close();
  });
});

describe('migration 8: billing', () => {
  it('creates invoices, invoice_lines, payments, change_orders', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    for (const t of ['invoices', 'invoice_lines', 'payments', 'change_orders']) {
      expect(tables, `missing ${t}`).toContain(t);
    }
    // shape spot-checks
    const invCols = (db.prepare(`PRAGMA table_info(invoices)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'projectId', 'number', 'date', 'status', 'terms', 'version', 'createdAt']) {
      expect(invCols, `invoices missing ${c}`).toContain(c);
    }
    const coCols = (db.prepare(`PRAGMA table_info(change_orders)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'projectId', 'number', 'description', 'amount', 'status', 'createdAt']) {
      expect(coCols, `change_orders missing ${c}`).toContain(c);
    }
    db.close();
  });
});

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

describe('migration 10: punch', () => {
  it('creates punch_items and punch_photos', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    expect(tables).toContain('punch_items');
    expect(tables).toContain('punch_photos');
    const itemCols = (db.prepare(`PRAGMA table_info(punch_items)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'projectId', 'area', 'description', 'done', 'sortOrder', 'version', 'createdAt']) {
      expect(itemCols, `punch_items missing ${c}`).toContain(c);
    }
    const phCols = (db.prepare(`PRAGMA table_info(punch_photos)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'punchItemId', 'fileId', 'stage', 'sortOrder', 'createdAt']) {
      expect(phCols, `punch_photos missing ${c}`).toContain(c);
    }
    db.close();
  });
});
