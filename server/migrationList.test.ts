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

  it('migration 14 adds CO columns + change_order_lines/photos (additive)', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    for (const t of ['change_order_lines', 'change_order_photos']) {
      expect(tables, `missing ${t}`).toContain(t);
    }
    const coCols = (db.prepare(`PRAGMA table_info(change_orders)`).all() as any[]).map(r => r.name);
    for (const c of ['version', 'lumpSumAmount', 'scheduleImpactDays', 'date']) {
      expect(coCols, `change_orders missing ${c}`).toContain(c);
    }
    const lineCols = (db.prepare(`PRAGMA table_info(change_order_lines)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'changeOrderId', 'description', 'qty', 'unitPrice', 'sortOrder']) {
      expect(lineCols, `change_order_lines missing ${c}`).toContain(c);
    }
    const photoCols = (db.prepare(`PRAGMA table_info(change_order_photos)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'changeOrderId', 'fileId', 'sortOrder', 'createdAt']) {
      expect(photoCols, `change_order_photos missing ${c}`).toContain(c);
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

describe('migration 11: tasks', () => {
  it('creates tasks and task_photos', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    expect(tables).toContain('tasks');
    expect(tables).toContain('task_photos');
    const taskCols = (db.prepare(`PRAGMA table_info(tasks)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'category', 'title', 'notes', 'assigneeUserId', 'status',
                     'dueDate', 'sortOrder', 'version', 'createdAt', 'createdBy']) {
      expect(taskCols, `tasks missing ${c}`).toContain(c);
    }
    const phCols = (db.prepare(`PRAGMA table_info(task_photos)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'taskId', 'fileId', 'stage', 'sortOrder', 'createdAt']) {
      expect(phCols, `task_photos missing ${c}`).toContain(c);
    }
    db.close();
  });

  it('imports legacy checklists into tasks', () => {
    const db = openDb(':memory:');
    // migrate through v10 so the legacy `checklists` table exists but v11 hasn't run
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 10));
    db.prepare('INSERT INTO checklists (id, data, createdAt) VALUES (?, ?, ?)').run(
      'cl1',
      JSON.stringify({
        id: 'cl1', name: 'Shop Punchout', createdAt: 1000,
        items: [
          { id: 'it1', description: 'Fix door', location: 'Bay 2', done: true, order: 0, comments: 'use shims',
            beforePhotoIds: ['pa'], inProgressPhotoIds: [], afterPhotoIds: ['pb'], createdAt: 1001 },
          { id: 'it2', description: 'Sweep', location: '', done: false, order: 1, createdAt: 1002 },
        ],
        printouts: [],
      }),
      1000,
    );

    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 11));

    const tasks = db.prepare('SELECT * FROM tasks ORDER BY sortOrder').all() as any[];
    expect(tasks.length).toBe(2);
    expect(tasks[0].title).toBe('Fix door');
    expect(tasks[0].category).toBe('Shop Punchout');
    expect(tasks[0].status).toBe('done');
    expect(tasks[0].notes).toBe('use shims');
    expect(tasks[1].title).toBe('Sweep');
    expect(tasks[1].category).toBe('Shop Punchout');
    expect(tasks[1].status).toBe('todo');
    expect(tasks[1].notes).toBe('');

    const photos = db.prepare('SELECT * FROM task_photos WHERE taskId = ? ORDER BY stage').all('it1') as any[];
    expect(photos.map(p => `${p.stage}:${p.fileId}`)).toEqual(['after:pb', 'before:pa']);

    // legacy table is retained (backup)
    expect(db.prepare('SELECT COUNT(*) c FROM checklists').get()).toEqual({ c: 1 });
    db.close();
  });

  it('survives a malformed legacy blob', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 10));
    db.prepare('INSERT INTO checklists (id, data, createdAt) VALUES (?, ?, ?)').run('bad', '{not json', 1);
    expect(() => runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 11))).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM tasks').get()).toEqual({ c: 0 });
    db.close();
  });
});

describe('migration 12: aia-billing', () => {
  it('creates aia_sov_lines, aia_pay_apps, aia_pay_app_lines', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    for (const t of ['aia_sov_lines', 'aia_pay_apps', 'aia_pay_app_lines']) {
      expect(tables, `missing ${t}`).toContain(t);
    }
    const sovCols = columnNames(db, 'aia_sov_lines');
    for (const c of ['id', 'projectId', 'itemNo', 'description', 'scheduledValueCents',
                     'retainagePercent', 'isChangeOrder', 'changeOrderId', 'sortOrder',
                     'version', 'createdAt']) {
      expect(sovCols, `aia_sov_lines missing ${c}`).toContain(c);
    }
    const appCols = columnNames(db, 'aia_pay_apps');
    for (const c of ['id', 'projectId', 'number', 'periodTo', 'applicationDate',
                     'retainagePercent', 'storedRetainagePercent', 'status',
                     'version', 'createdAt']) {
      expect(appCols, `aia_pay_apps missing ${c}`).toContain(c);
    }
    const lineCols = columnNames(db, 'aia_pay_app_lines');
    for (const c of ['id', 'payAppId', 'sovLineId', 'percentComplete',
                     'storedMaterialsCents', 'createdAt']) {
      expect(lineCols, `aia_pay_app_lines missing ${c}`).toContain(c);
    }
    db.close();
  });
});

describe('migration 13: payments-polymorphic', () => {
  it('rebuilds payments to targetType/targetId and backfills existing rows to invoice targets', () => {
    const db = openDb(':memory:');
    // migrate through 12 so the old (invoiceId-keyed) payments table exists
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 12));
    const preCols = columnNames(db, 'payments');
    expect(preCols).toContain('invoiceId');
    db.prepare('INSERT INTO payments (id, invoiceId, date, amount, method, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('pay1', 'inv-A', 100, 40, 'check', 'deposit', 500);

    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 13));

    const cols = columnNames(db, 'payments');
    for (const c of ['id', 'targetType', 'targetId', 'date', 'amount', 'method', 'note', 'createdAt']) {
      expect(cols, `payments missing ${c}`).toContain(c);
    }
    expect(cols).not.toContain('invoiceId');

    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get('pay1') as any;
    expect(row.targetType).toBe('invoice');
    expect(row.targetId).toBe('inv-A');
    expect(row.amount).toBe(40);
    expect(row.method).toBe('check');
    expect(row.note).toBe('deposit');
    expect(row.date).toBe(100);
    expect(row.createdAt).toBe(500);
    db.close();
  });
});

describe('migration 18: task relations', () => {
  it('adds projectId and customerId columns to tasks', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 18));
    const cols = (db.prepare('PRAGMA table_info(tasks)').all() as any[]).map(c => c.name);
    expect(cols).toContain('projectId');
    expect(cols).toContain('customerId');
  });
});

describe('migration 21: two-stage project lifecycle', () => {
  const seedProject = (db: any, id: string, status: string, meta: any = {}) => {
    db.prepare('INSERT INTO projects (id, status, meta, createdAt) VALUES (?, ?, ?, ?)')
      .run(id, status, JSON.stringify(meta), Date.now());
  };

  const readRow = (db: any, id: string) => {
    const row = db.prepare('SELECT status, meta FROM projects WHERE id = ?').get(id) as any;
    const meta = row.meta ? JSON.parse(row.meta) : {};
    return { status: row.status, archived: meta.archived, lostBid: meta.lostBid };
  };

  it('collapses every legacy status per the collapse table and auto-archives complete/lost', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 20));

    seedProject(db, 'p-estimating', 'estimating');
    seedProject(db, 'p-proposal', 'proposal_sent');
    seedProject(db, 'p-awarded', 'awarded');
    seedProject(db, 'p-inprogress', 'in_progress');
    seedProject(db, 'p-punch', 'punch_list');
    seedProject(db, 'p-complete', 'complete');
    seedProject(db, 'p-archived', 'archived');
    seedProject(db, 'p-lost', 'lost');
    // a project already flagged archived under a legacy stage must keep archived:true
    seedProject(db, 'p-already-archived', 'punch_list', { archived: true });

    runMigrations(db, tmpDir(), migrations);

    expect(readRow(db, 'p-estimating')).toEqual({ status: 'bidding', archived: undefined, lostBid: undefined });
    expect(readRow(db, 'p-proposal')).toEqual({ status: 'bidding', archived: undefined, lostBid: undefined });
    expect(readRow(db, 'p-awarded')).toEqual({ status: 'in_progress', archived: undefined, lostBid: undefined });
    expect(readRow(db, 'p-inprogress')).toEqual({ status: 'in_progress', archived: undefined, lostBid: undefined });
    expect(readRow(db, 'p-punch')).toEqual({ status: 'in_progress', archived: undefined, lostBid: undefined });
    expect(readRow(db, 'p-complete')).toEqual({ status: 'in_progress', archived: true, lostBid: undefined });
    expect(readRow(db, 'p-archived')).toEqual({ status: 'in_progress', archived: true, lostBid: undefined });
    expect(readRow(db, 'p-lost')).toEqual({ status: 'bidding', archived: true, lostBid: true });
    expect(readRow(db, 'p-already-archived')).toEqual({ status: 'in_progress', archived: true, lostBid: undefined });

    // re-running the migration's up() directly (simulating a replay) must be a no-op
    const mig21 = migrations.find(m => m.version === 21)!;
    const before = ['p-estimating', 'p-proposal', 'p-awarded', 'p-inprogress', 'p-punch',
      'p-complete', 'p-archived', 'p-lost', 'p-already-archived'].map(id => readRow(db, id));
    mig21.up({ db, dataDir: tmpDir() });
    const after = ['p-estimating', 'p-proposal', 'p-awarded', 'p-inprogress', 'p-punch',
      'p-complete', 'p-archived', 'p-lost', 'p-already-archived'].map(id => readRow(db, id));
    expect(after).toEqual(before);

    db.close();
  });
});
