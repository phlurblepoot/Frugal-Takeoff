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

  it('a row with unparseable meta does not abort the migration: status is normalized, meta kept verbatim', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 20));

    db.prepare('INSERT INTO projects (id, status, meta, createdAt) VALUES (?, ?, ?, ?)')
      .run('p-corrupt', 'proposal_sent', '{not json', Date.now());
    seedProject(db, 'p-after-corrupt', 'awarded');

    runMigrations(db, tmpDir(), migrations);

    const corrupt = db.prepare('SELECT status, meta FROM projects WHERE id = ?').get('p-corrupt') as any;
    expect(corrupt.status).toBe('bidding');
    expect(corrupt.meta).toBe('{not json'); // untouched — nothing is lost
    // and the rest of the table still migrated
    expect(readRow(db, 'p-after-corrupt')).toEqual({ status: 'in_progress', archived: undefined, lostBid: undefined });

    db.close();
  });
});

describe('migration 22: payapp-released-retainage', () => {
  it('adds releasedRetainagePoints defaulting to 0 on existing pay apps, and re-runs as a no-op', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 21));
    expect(columnNames(db, 'aia_pay_apps')).not.toContain('releasedRetainagePoints');

    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
    db.prepare('INSERT INTO aia_pay_apps (id, projectId, number, createdAt) VALUES (?, ?, ?, ?)')
      .run('app1', 'p1', 1, 1);

    runMigrations(db, tmpDir(), migrations);

    expect(columnNames(db, 'aia_pay_apps')).toContain('releasedRetainagePoints');
    // ADDITIVE: every pre-existing app holds nothing released, so its numbers
    // are byte-identical to what they computed before the migration.
    const row = db.prepare('SELECT releasedRetainagePoints FROM aia_pay_apps WHERE id = ?').get('app1') as any;
    expect(row.releasedRetainagePoints).toBe(0);

    // Idempotent: replaying up() must not throw (duplicate column) or reset data.
    db.prepare('UPDATE aia_pay_apps SET releasedRetainagePoints = ? WHERE id = ?').run(5, 'app1');
    const mig22 = migrations.find(m => m.version === 22)!;
    expect(() => mig22.up({ db, dataDir: tmpDir() })).not.toThrow();
    const after = db.prepare('SELECT releasedRetainagePoints FROM aia_pay_apps WHERE id = ?').get('app1') as any;
    expect(after.releasedRetainagePoints).toBe(5);

    db.close();
  });
});

describe('migration 23: document source attribution', () => {
  // One seeded file per backfill class, plus the rows that attribute them.
  // Everything is inserted at schema v22 so migration 23 sees a realistic
  // pre-migration database.
  const seed = (db: any) => {
    const file = (id: string, kind = 'other', projectId: string | null = null) =>
      db.prepare(`INSERT INTO files (id, projectId, name, mime, size, sha256, kind, versionNumber, createdAt)
                  VALUES (?, ?, ?, 'application/pdf', 1, 'sha', ?, 1, 1)`).run(id, projectId, id, kind);

    db.prepare('INSERT INTO projects (id, name, meta, createdAt) VALUES (?, ?, ?, ?)').run(
      'p1', 'Proj One',
      JSON.stringify({
        printouts: [{ id: 'po1', name: 'Bid set', fileId: 'f-printout' }],
        proposalFileId: 'f-proposal',
        proposalPhotoIds: ['f-proposal-photo'],
      }),
      1,
    );

    // 1. join-table photos (kinds as the live app writes them today)
    file('f-issue-photo', 'photo', 'p1');
    db.prepare(`INSERT INTO issue_photos (id, issueId, fileId, createdAt) VALUES ('ip1','issue-1','f-issue-photo',1)`).run();
    file('f-punch-photo', 'punch', 'p1');
    db.prepare(`INSERT INTO punch_photos (id, punchItemId, fileId, createdAt) VALUES ('pp1','punch-1','f-punch-photo',1)`).run();
    file('f-rfi-photo', 'photo', 'p1');
    db.prepare(`INSERT INTO rfi_photos (id, rfiId, fileId, createdAt) VALUES ('rp1','rfi-1','f-rfi-photo',1)`).run();
    file('f-co-photo', 'change-order', 'p1');
    db.prepare(`INSERT INTO change_order_photos (id, changeOrderId, fileId, createdAt) VALUES ('cp1','co-1','f-co-photo',1)`).run();
    // task photo: uploaded via POST /api/images, so projectId is NULL
    file('f-task-photo', 'other', null);
    db.prepare('INSERT INTO tasks (id, projectId, createdAt) VALUES (?, ?, ?)').run('task-1', 'p1', 1);
    db.prepare(`INSERT INTO task_photos (id, taskId, fileId, createdAt) VALUES ('tp1','task-1','f-task-photo',1)`).run();
    // task photo whose task has no project — stays unattributed
    file('f-task-photo-noproj', 'other', null);
    db.prepare('INSERT INTO tasks (id, projectId, createdAt) VALUES (?, ?, ?)').run('task-2', null, 1);
    db.prepare(`INSERT INTO task_photos (id, taskId, fileId, createdAt) VALUES ('tp2','task-2','f-task-photo-noproj',1)`).run();

    // the CO ambiguity: a generated CO PDF carries the same legacy kind but is
    // in no join table
    file('f-co-pdf', 'change-order', 'p1');

    // 2. page/plan assets (plan sources upload with no projectId)
    file('f-plan-source', 'plan', null);
    file('f-plan-image', 'other', 'p1');
    file('f-plan-thumb', 'other', 'p1');
    db.prepare(`INSERT INTO pages (id, projectId, planSetId, imageId, thumbnailId, sourcePdfFileId)
                VALUES ('pg1','p1','set1','f-plan-image','f-plan-thumb','f-plan-source')`).run();
    // a second page split out of the SAME upload shares its source PDF
    db.prepare(`INSERT INTO pages (id, projectId, planSetId, sourcePdfFileId)
                VALUES ('pg1b','p1','set1','f-plan-source')`).run();
    file('f-plan-source-noset', 'other', null);
    db.prepare(`INSERT INTO pages (id, projectId, planSetId, sourcePdfFileId)
                VALUES ('pg2','p1',NULL,'f-plan-source-noset')`).run();

    // 3. project JSON fields
    file('f-printout', 'printout', 'p1');
    file('f-proposal', 'proposal', 'p1');
    file('f-proposal-photo', 'proposal-photo', 'p1');

    // 4. rfi response
    file('f-rfi-response', 'rfi-response', 'p1');
    db.prepare('INSERT INTO rfis (id, projectId, number, responseFileId, createdAt) VALUES (?,?,?,?,?)')
      .run('rfi-1', 'p1', 1, 'f-rfi-response', 1);

    // 5. settings asset
    file('f-aia-template', 'other', null);
    db.prepare(`INSERT INTO settings (key, value) VALUES ('aiaTemplateFileId','f-aia-template')`).run();

    // 6. rows migration 23 must leave alone
    file('f-upload', 'document', 'p1');
    file('f-loose-photo', 'photo', 'p1');   // in no join table — stays a plain photo
    file('f-invoice', 'invoice', 'p1');
    file('f-issue-pdf', 'issue', 'p1');   // legacy kind — renamed to issue-report
    file('f-email-att', 'email-attachment', 'p1');
  };

  const rowOf = (db: any, id: string) =>
    db.prepare('SELECT kind, sourceType, sourceId, projectId FROM files WHERE id = ?').get(id) as any;

  const migrated = () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 22));
    seed(db);
    runMigrations(db, dir, migrations);
    return { db, dir };
  };

  it('adds the additive columns with archived defaulting to 0', () => {
    const { db } = migrated();
    const cols = columnNames(db, 'files');
    for (const c of ['customerId', 'sourceType', 'sourceId', 'archived']) {
      expect(cols, `files missing ${c}`).toContain(c);
    }
    expect((db.prepare('SELECT COUNT(*) c FROM files WHERE archived = 0').get() as any).c)
      .toBe((db.prepare('SELECT COUNT(*) c FROM files').get() as any).c);
    db.close();
  });

  it('requalifies join-table photos and attributes them to their entity', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-issue-photo')).toEqual({ kind: 'issue-photo', sourceType: 'issue', sourceId: 'issue-1', projectId: 'p1' });
    expect(rowOf(db, 'f-punch-photo')).toEqual({ kind: 'punch-photo', sourceType: 'punch', sourceId: 'punch-1', projectId: 'p1' });
    expect(rowOf(db, 'f-rfi-photo')).toEqual({ kind: 'rfi-photo', sourceType: 'rfi', sourceId: 'rfi-1', projectId: 'p1' });
    expect(rowOf(db, 'f-co-photo')).toEqual({ kind: 'change-order-photo', sourceType: 'change-order', sourceId: 'co-1', projectId: 'p1' });
    db.close();
  });

  it('backfills a task photo projectId from its task, leaving projectless tasks alone', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-task-photo')).toEqual({ kind: 'task-photo', sourceType: 'task', sourceId: 'task-1', projectId: 'p1' });
    expect(rowOf(db, 'f-task-photo-noproj')).toEqual({ kind: 'task-photo', sourceType: 'task', sourceId: 'task-2', projectId: null });
    db.close();
  });

  it('leaves generated change-order PDFs as change-order (join-table pass runs first)', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-co-pdf')).toEqual({ kind: 'change-order', sourceType: null, sourceId: null, projectId: 'p1' });
    db.close();
  });

  it('labels page assets: plan sources carry a plan-set source, rasters become plan', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-plan-source')).toEqual({ kind: 'plan-source', sourceType: 'plan-set', sourceId: 'set1', projectId: 'p1' });
    // a page with no plan set falls back to the project as its source id
    expect(rowOf(db, 'f-plan-source-noset')).toEqual({ kind: 'plan-source', sourceType: 'plan-set', sourceId: 'p1', projectId: 'p1' });
    expect(rowOf(db, 'f-plan-image')).toMatchObject({ kind: 'plan', sourceType: null });
    expect(rowOf(db, 'f-plan-thumb')).toMatchObject({ kind: 'plan', sourceType: null });
    db.close();
  });

  it('labels printouts, proposals and proposal photos from the project JSON', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-printout')).toEqual({ kind: 'printout', sourceType: 'printout', sourceId: 'po1', projectId: 'p1' });
    expect(rowOf(db, 'f-proposal')).toEqual({ kind: 'proposal', sourceType: 'proposal', sourceId: 'p1', projectId: 'p1' });
    expect(rowOf(db, 'f-proposal-photo')).toEqual({ kind: 'proposal-photo', sourceType: 'proposal', sourceId: 'p1', projectId: 'p1' });
    db.close();
  });

  it('labels the RFI response file and the AIA settings template', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-rfi-response')).toEqual({ kind: 'rfi-response', sourceType: 'rfi', sourceId: 'rfi-1', projectId: 'p1' });
    expect(rowOf(db, 'f-aia-template')).toEqual({ kind: 'settings-asset', sourceType: null, sourceId: null, projectId: null });
    db.close();
  });

  it('leaves direct uploads and already-canonical generated documents untouched', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-upload')).toEqual({ kind: 'document', sourceType: null, sourceId: null, projectId: 'p1' });
    expect(rowOf(db, 'f-loose-photo')).toEqual({ kind: 'photo', sourceType: null, sourceId: null, projectId: 'p1' });
    expect(rowOf(db, 'f-invoice')).toMatchObject({ kind: 'invoice', sourceType: null });
    expect(rowOf(db, 'f-email-att')).toMatchObject({ kind: 'email-attachment', sourceType: null });
    db.close();
  });

  it('renames the legacy issue kind to issue-report without touching issue photos', () => {
    const { db } = migrated();
    expect(rowOf(db, 'f-issue-pdf')).toMatchObject({ kind: 'issue-report', sourceType: null });
    // the photo pass ran first, so no issue photo is left carrying `issue`
    expect(rowOf(db, 'f-issue-photo')).toMatchObject({ kind: 'issue-photo' });
    expect((db.prepare(`SELECT COUNT(*) c FROM files WHERE kind = 'issue'`).get() as any).c).toBe(0);
    db.close();
  });

  it('re-running up() is byte-identical (idempotent by construction)', () => {
    const { db, dir } = migrated();
    const snapshot = () =>
      JSON.stringify(db.prepare('SELECT * FROM files ORDER BY id').all());
    const before = snapshot();
    migrations.find(m => m.version === 23)!.up({ db, dataDir: dir });
    expect(snapshot()).toBe(before);
    db.close();
  });

  it('a project with unparseable meta does not abort the migration', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 22));
    seed(db);
    db.prepare('INSERT INTO projects (id, name, meta, createdAt) VALUES (?, ?, ?, ?)')
      .run('p-bad', 'Broken', '{not json', 1);

    expect(() => runMigrations(db, dir, migrations)).not.toThrow();
    // the rest of the portfolio still migrated
    expect(rowOf(db, 'f-printout')).toMatchObject({ kind: 'printout', sourceId: 'po1' });
    expect(db.prepare('SELECT meta FROM projects WHERE id = ?').get('p-bad')).toEqual({ meta: '{not json' });
    db.close();
  });
});

describe('migration 24: change-order-title', () => {
  it('adds title (nullable) to change_orders, and re-runs as a no-op', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations.filter(m => m.version <= 23));
    expect(columnNames(db, 'change_orders')).not.toContain('title');

    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
    db.prepare('INSERT INTO change_orders (id, projectId, number, description, amount, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('co1', 'p1', '1', 'Extra electrical', 100, 'draft', 1);

    runMigrations(db, tmpDir(), migrations);

    expect(columnNames(db, 'change_orders')).toContain('title');
    const row = db.prepare('SELECT title FROM change_orders WHERE id = ?').get('co1') as any;
    expect(row.title).toBeNull();

    // Idempotent: replaying up() must not throw (duplicate column) or reset data.
    db.prepare('UPDATE change_orders SET title = ? WHERE id = ?').run('Kitchen electrical add', 'co1');
    const mig24 = migrations.find(m => m.version === 24)!;
    expect(() => mig24.up({ db, dataDir: tmpDir() })).not.toThrow();
    const after = db.prepare('SELECT title FROM change_orders WHERE id = ?').get('co1') as any;
    expect(after.title).toBe('Kitchen electrical add');

    db.close();
  });
});

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
