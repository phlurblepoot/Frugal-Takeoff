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
});
