// server/punchStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  listPunchItems, getPunchItem, createPunchItem, savePunchItem,
  ValidationError, ConflictError, NotFoundError,
} from './punchStore';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-punch-')), migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p2', 'Proj2', 1);
});

describe('punchItems', () => {
  it('creates and reads a punch item (area, description set; done===0; version===1; photos===[])', () => {
    const { id } = createPunchItem(db, 'p1', { area: 'Kitchen', description: 'Fix cabinet' });
    const item = getPunchItem(db, id)!;
    expect(item.area).toBe('Kitchen');
    expect(item.description).toBe('Fix cabinet');
    expect(item.done).toBe(0);
    expect(item.version).toBe(1);
    expect(item.photos).toEqual([]);
  });

  it('rejects empty/whitespace description (ValidationError)', () => {
    expect(() => createPunchItem(db, 'p1', { description: '' })).toThrow(ValidationError);
    expect(() => createPunchItem(db, 'p1', { description: '   ' })).toThrow(ValidationError);
    expect(() => createPunchItem(db, 'p1', {})).toThrow(ValidationError);
  });

  it('rejects unknown project (NotFoundError)', () => {
    expect(() => createPunchItem(db, 'nope', { description: 'X' })).toThrow(NotFoundError);
  });

  it('lists items ordered by area ASC then sortOrder', () => {
    createPunchItem(db, 'p1', { area: 'Bath', description: 'b1' });
    createPunchItem(db, 'p1', { area: 'Attic', description: 'a1' });
    createPunchItem(db, 'p1', { area: 'Attic', description: 'a2' });
    const list = listPunchItems(db, 'p1');
    expect(list.map(i => i.description)).toEqual(['a1', 'a2', 'b1']);
    expect(list[0].photoCount).toBe(0);
  });

  it('savePunchItem with correct version bumps version to 2 and updates fields', () => {
    const { id } = createPunchItem(db, 'p1', { area: 'Kitchen', description: 'Fix cabinet' });
    const item = getPunchItem(db, id)!;
    const r = savePunchItem(db, id, { ...item, area: 'Bath', description: 'Fix tub' });
    expect(r.version).toBe(2);
    const reloaded = getPunchItem(db, id)!;
    expect(reloaded.area).toBe('Bath');
    expect(reloaded.description).toBe('Fix tub');
  });

  it('savePunchItem with stale version throws ConflictError', () => {
    const { id } = createPunchItem(db, 'p1', { description: 'Original' });
    const item = getPunchItem(db, id)!;
    savePunchItem(db, id, { ...item, description: 'Updated' }); // advances to v2
    expect(() => savePunchItem(db, id, { ...item, description: 'Stale' })).toThrow(ConflictError); // still at v1
  });
});
