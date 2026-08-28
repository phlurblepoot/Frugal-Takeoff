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
  patchProject, normalizeProjectStatus, listProjectSummaries,
  ValidationError, ConflictError,
} from './projectStore';
import { putBuffer } from './files';
import { readFileContent } from './fileStore';
import { createInvoice, setInvoiceStatus, recordPayment } from './billingStore';
import { createSovLine, listSovLines, createPayApp, savePayAppLines, setPayApp } from './aiaStore';

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

// migrationCap: leave undefined to run the full (latest) migrations array —
// the default for round-trip/saveProject tests. Pass 27 only for the
// "saveProject source-side file cascade" block below, which still exercises
// the pre-proposals p.printouts/proposalPhotoIds cascade in
// saveProject/loadProject (that logic — and these tests — are superseded
// once proposals become first-class rows, in a later task).
const seedLegacyAndNormalize = (blob: any, migrationCap?: number) => {
  db.prepare('INSERT INTO projects (id, data, createdAt) VALUES (?, ?, ?)')
    .run(blob.id, JSON.stringify(blob), blob.createdAt);
  // also seed referenced files so labeling has rows to update
  for (const fid of ['thumb1', 'pdf1', 'raster1', 'pofile1', 'prop1', 'att1']) {
    db.prepare(`INSERT INTO files (id, mime, size, sha256, kind, createdAt) VALUES (?, 'application/octet-stream', 1, 'x', 'other', 1)`).run(fid);
  }
  const set = migrationCap == null ? migrations : migrations.filter(m => m.version <= migrationCap);
  runMigrations(db, dir, set); // applies migration 5 (and, by default, everything after it)
};

describe('migration 5 + loadProject round-trip', () => {
  it('reassembles the legacy JSON shape exactly (plus version/status)', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    const loaded = loadProject(db, 'proj1');
    // Migration 15 (plan-set sheet identity) backfills a durable sheetId onto
    // every page; assert it was assigned, then strip it for the exact-shape
    // comparison against the original legacy blob.
    for (const pg of loaded.pages) {
      expect(typeof pg.sheetId).toBe('string');
      expect(pg.sheetId).toBeTruthy();
      delete pg.sheetId;
    }
    // Migration 16 backfills customerId from contractor; strip it for the
    // legacy-shape comparison (it was never in the original blob).
    expect(typeof loaded.customerId).toBe('string');
    expect(loaded.customerId).toBeTruthy();
    delete loaded.customerId;
    // Two-stage lifecycle (spec 2026-08-16): full-document saves normalize to
    // bidding|in_progress; meta.accepted drives in_progress, everything else
    // (including this fixture's submitted:true) is a bid.
    // Migration 28 converts the legacy printouts/proposalFileId into
    // first-class proposal rows and strips both keys from meta — they were
    // never re-surfaced onto the loaded project shape (that's a later task),
    // so exclude them from the exact-shape comparison too.
    const { printouts: _printouts, proposalFileId: _proposalFileId, ...expectedRest } = LEGACY_PROJECT;
    expect(loaded).toEqual({ ...expectedRest, version: 1, status: 'bidding' });
  });

  it('nulls out the legacy data blob', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    const row = db.prepare('SELECT data FROM projects WHERE id = ?').get('proj1') as { data: string | null };
    expect(row.data).toBeNull();
  });

  it('labels referenced files with projectId and kind', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    const kind = (id: string) => (db.prepare('SELECT projectId, kind FROM files WHERE id = ?').get(id) as any);
    // Migration 23 requalifies the uploaded PDF behind a page as `plan-source`
    // (the page raster + thumbnail stay `plan`) and gives it a plan-set source.
    expect(kind('pdf1')).toEqual({ projectId: 'proj1', kind: 'plan-source' });
    expect(db.prepare('SELECT sourceType, sourceId FROM files WHERE id = ?').get('pdf1'))
      .toEqual({ sourceType: 'plan-set', sourceId: 'ps1' });
    expect(kind('thumb1')).toEqual({ projectId: 'proj1', kind: 'plan' });
    expect(kind('raster1')).toEqual({ projectId: 'proj1', kind: 'plan' });
    // Migration 23 first labels pofile1 `printout`; migration 28 then relabels
    // this non-proposal-named printout as a `takeoff-print` document (prop1's
    // `proposal` kind is unaffected — 28 only repoints its sourceId, which
    // this assertion doesn't check).
    expect(kind('pofile1')).toEqual({ projectId: 'proj1', kind: 'takeoff-print' });
    expect(kind('prop1')).toEqual({ projectId: 'proj1', kind: 'proposal' });
    expect(kind('att1')).toEqual({ projectId: 'proj1', kind: 'document' });
  });

  it('derives status from legacy flags (archived no longer drives status — it is orthogonal)', () => {
    seedLegacyAndNormalize({ ...LEGACY_PROJECT, id: 'p2', submitted: false, archived: true });
    const loaded = loadProject(db, 'p2')!;
    expect(loaded.status).toBe('bidding');
    expect(loaded.archived).toBe(true);
  });

  it('derives in_progress status from meta.accepted', () => {
    seedLegacyAndNormalize({ ...LEGACY_PROJECT, id: 'p3', submitted: false, accepted: true });
    expect(loadProject(db, 'p3')!.status).toBe('in_progress');
  });

  it('skips non-object blobs without failing the migration (data preserved)', () => {
    const ins = db.prepare('INSERT INTO projects (id, data, createdAt) VALUES (?, ?, ?)');
    ins.run('badNull', 'null', 1);
    ins.run('badArr', '[1,2]', 2);
    ins.run(LEGACY_PROJECT.id, JSON.stringify(LEGACY_PROJECT), LEGACY_PROJECT.createdAt);
    expect(() => runMigrations(db, dir, migrations)).not.toThrow();
    // the valid project normalized
    expect(loadProject(db, 'proj1')!.name).toBe('Maple St Office');
    expect((db.prepare('SELECT data FROM projects WHERE id = ?').get('proj1') as any).data).toBeNull();
    // the bad rows' data preserved, not nulled
    expect((db.prepare('SELECT data FROM projects WHERE id = ?').get('badNull') as any).data).toBe('null');
    expect((db.prepare('SELECT data FROM projects WHERE id = ?').get('badArr') as any).data).toBe('[1,2]');
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

  it('round-trips an aiaSettings object through the meta column', () => {
    const aiaSettings = {
      billingMode: 'aia',
      retainagePercent: 10,
      storedRetainagePercent: 10,
      ownerName: 'City of Springfield',
      ownerAddress: '100 Main St',
      architectName: 'Wright & Assoc',
      architectAddress: '200 Oak Ave',
      contractDate: '2024-03-01',
      ownerProjectNumber: 'OPN-42',
      architectProjectNumber: 'APN-7',
      contractFor: 'General Construction',
    };
    const p = loadProject(db, 'proj1')!;
    p.aiaSettings = aiaSettings;
    saveProject(db, 'proj1', p);
    const reloaded = loadProject(db, 'proj1')!;
    expect(reloaded.aiaSettings).toEqual(aiaSettings);
  });

  it('never touches the files table on save', () => {
    const before = db.prepare('SELECT COUNT(*) as c FROM files').get() as any;
    const p = loadProject(db, 'proj1')!;
    p.pages = [p.pages[1]]; // drop page1 and all its file references
    saveProject(db, 'proj1', p);
    const after = db.prepare('SELECT COUNT(*) as c FROM files').get() as any;
    expect(after.c).toBe(before.c); // orphaned, NOT deleted
  });

  it('round-trips customerId through the dedicated column (not the meta blob)', () => {
    const p = loadProject(db, 'proj1')!;
    p.customerId = 'c1';
    saveProject(db, 'proj1', p);
    // Verify the value is stored in the dedicated column, not the meta JSON blob
    const row = db.prepare('SELECT customerId, meta FROM projects WHERE id = ?').get('proj1') as any;
    expect(row.customerId).toBe('c1');
    const meta = JSON.parse(row.meta);
    expect(meta.customerId).toBeUndefined(); // must NOT be leaked into meta
    const reloaded = loadProject(db, 'proj1')!;
    expect(reloaded.customerId).toBe('c1');
  });
});

describe('createProject / listProjects / deleteProject', () => {
  it('creates with version 1 and round-trips', () => {
    const result = createProject(db, { ...LEGACY_PROJECT, id: 'new1' });
    expect(result.version).toBe(1);
    expect(loadProject(db, 'new1')!.name).toBe('Maple St Office');
  });

  it('lists newest-first', () => {
    const bare = (id: string, createdAt: number) =>
      ({ ...LEGACY_PROJECT, id, createdAt, planSets: undefined, pages: [], takeoffs: [] });
    createProject(db, bare('a', 1));
    createProject(db, bare('b', 2));
    expect(listProjects(db).map((p: any) => p.id)).toEqual(['b', 'a']);
  });

  it('fails loudly when two projects share child ids (collision = data bug, never silent theft)', () => {
    createProject(db, { ...LEGACY_PROJECT, id: 'a' });
    expect(() => createProject(db, { ...LEGACY_PROJECT, id: 'b' })).toThrow();
    // transaction rolled back: project b does not half-exist
    expect(loadProject(db, 'b')).toBeNull();
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

  it('delete spares task photos — a task outlives the project it merely refers to', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    db.prepare('INSERT INTO tasks (id, title, projectId, createdAt) VALUES (?, ?, ?, ?)')
      .run('task1', 'Order material', 'proj1', 1);
    // migration 23 attributes task photos to their task's project, which put
    // them in reach of the project-owned file sweep for the first time
    putBuffer(db, dir, 'tphoto1', Buffer.from('photobytes'), 'image/jpeg', { projectId: 'proj1', kind: 'task-photo' });
    db.prepare('INSERT INTO task_photos (id, taskId, fileId, createdAt) VALUES (?, ?, ?, ?)')
      .run('tp1', 'task1', 'tphoto1', 1);

    deleteProject(db, dir, 'proj1');

    expect(db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE id = 'task1'`).get()).toEqual({ c: 1 });
    expect(db.prepare(`SELECT COUNT(*) as c FROM task_photos WHERE id = 'tp1'`).get()).toEqual({ c: 1 });
    expect(db.prepare(`SELECT COUNT(*) as c FROM files WHERE id = 'tphoto1'`).get()).toEqual({ c: 1 });
    expect(readFileContent(dir, 'tphoto1')!.toString()).toBe('photobytes'); // bytes survive too
    // every other project-owned file still went
    expect((db.prepare(`SELECT COUNT(*) as c FROM files WHERE projectId = 'proj1' AND kind != 'task-photo'`).get() as any).c).toBe(0);
  });

  it('delete cascades AIA billing rows', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    db.prepare(`INSERT INTO aia_sov_lines (id, projectId, description, scheduledValueCents, sortOrder, version, createdAt) VALUES ('sov1', 'proj1', 'Line', 100000, 0, 1, 1)`).run();
    db.prepare(`INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'proj1', 1, 'draft', 1, 1)`).run();
    db.prepare(`INSERT INTO aia_pay_app_lines (id, payAppId, sovLineId, percentComplete, storedMaterialsCents, createdAt) VALUES ('pl1', 'app1', 'sov1', 50, 0, 1)`).run();
    deleteProject(db, dir, 'proj1');
    expect((db.prepare(`SELECT COUNT(*) as c FROM aia_sov_lines WHERE projectId = 'proj1'`).get() as any).c).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) as c FROM aia_pay_apps WHERE projectId = 'proj1'`).get() as any).c).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) as c FROM aia_pay_app_lines WHERE id = 'pl1'`).get() as any).c).toBe(0);
  });

  it('delete cascades polymorphic payments for both invoices and pay-apps', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    db.prepare(`INSERT INTO invoices (id, projectId, status, version, createdAt) VALUES ('inv1', 'proj1', 'draft', 1, 1)`).run();
    db.prepare(`INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'proj1', 1, 'draft', 1, 1)`).run();
    db.prepare(`INSERT INTO payments (id, targetType, targetId, amount, createdAt) VALUES ('payi', 'invoice', 'inv1', 10, 1)`).run();
    db.prepare(`INSERT INTO payments (id, targetType, targetId, amount, createdAt) VALUES ('paya', 'payapp', 'app1', 20, 1)`).run();
    deleteProject(db, dir, 'proj1');
    expect((db.prepare(`SELECT COUNT(*) as c FROM payments`).get() as any).c).toBe(0);
  });
});

describe('two-stage lifecycle', () => {
  it('normalizes every legacy status per the collapse table', () => {
    const cases: [string, string][] = [
      ['estimating', 'bidding'], ['proposal_sent', 'bidding'],
      ['awarded', 'in_progress'], ['in_progress', 'in_progress'],
      ['punch_list', 'in_progress'], ['complete', 'in_progress'],
      ['lost', 'bidding'], ['archived', 'in_progress'],
      ['garbage', 'bidding'],
    ];
    for (const [oldS, newS] of cases) expect(normalizeProjectStatus(oldS)).toBe(newS);
  });

  it('patchProject rejects legacy statuses and accepts the two live ones', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    const v1 = loadProject(db, 'proj1')!.version;
    const result = patchProject(db, 'proj1', { version: v1, status: 'bidding' });
    expect(result.status).toBe('bidding');
    expect(loadProject(db, 'proj1')!.status).toBe('bidding');
    const v2 = result.version;
    expect(() => patchProject(db, 'proj1', { version: v2, status: 'estimating' })).toThrow(ValidationError);
  });

  it('patchProject accepts lostBid boolean and stores it in meta', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    const v1 = loadProject(db, 'proj1')!.version;
    patchProject(db, 'proj1', { version: v1, lostBid: true });
    expect(loadProject(db, 'proj1')!.lostBid).toBe(true);
    const v2 = loadProject(db, 'proj1')!.version;
    expect(() => patchProject(db, 'proj1', { version: v2, lostBid: 'yes' })).toThrow(ValidationError);
  });

  it('surfaces lostBid on summary rows so the Archive tab can badge it', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);
    expect(listProjectSummaries(db, 'proj1')[0].lostBid).toBe(false);

    const v = loadProject(db, 'proj1')!.version;
    patchProject(db, 'proj1', { version: v, archived: true, lostBid: true });
    const row = listProjectSummaries(db, 'proj1')[0];
    expect([row.archived, row.lostBid]).toEqual([true, true]);
  });

  it('summary outstandingCents spans invoices AND finalized pay applications', () => {
    seedLegacyAndNormalize(LEGACY_PROJECT);

    const inv = createInvoice(db, 'proj1', { number: 'INV-1', lines: [{ description: 'Work', qty: 1, unitPrice: 100 }] });
    setInvoiceStatus(db, inv.id, 'sent');
    expect(listProjectSummaries(db, 'proj1')[0].outstandingCents).toBe(10000);

    // An AIA pay app the board used to be blind to: $1,000 billed, $250 paid.
    createSovLine(db, 'proj1', { description: 'Framing', scheduledValueCents: 100000 });
    const app = createPayApp(db, 'proj1', { retainagePercent: 0, storedRetainagePercent: 0 });
    const sov = listSovLines(db, 'proj1');
    savePayAppLines(db, app.id, [{ sovLineId: sov[0].id, percentComplete: 100, storedMaterialsCents: 0 }], 1);
    setPayApp(db, app.id, { status: 'finalized' });
    recordPayment(db, 'payapp', app.id, { amount: 250 });

    expect(listProjectSummaries(db, 'proj1')[0].outstandingCents).toBe(85000);
  });
});
