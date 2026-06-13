// server/aiaStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  getSovLine, listSovLines, createSovLine, saveSovLine, deleteSovLine,
  seedSovLines, syncChangeOrders,
  ValidationError, ConflictError, NotFoundError,
} from './aiaStore';

let db: Database.Database;

function insertChangeOrder(id: string, projectId: string, number: string, description: string, amount: number, status: string) {
  db.prepare('INSERT INTO change_orders (id, projectId, number, description, amount, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, projectId, number, description, amount, status, Date.now());
}

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-aia-')), migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p2', 'Proj2', 1);
});

describe('createSovLine / getSovLine', () => {
  it('creates and reads a line with defaults', () => {
    const { id } = createSovLine(db, 'p1', { itemNo: '1', description: 'Framing', scheduledValueCents: 150000 });
    const line = getSovLine(db, id)!;
    expect(line.itemNo).toBe('1');
    expect(line.description).toBe('Framing');
    expect(line.scheduledValueCents).toBe(150000);
    expect(line.retainagePercent).toBeNull();
    expect(line.isChangeOrder).toBe(0);
    expect(line.changeOrderId).toBeNull();
    expect(line.sortOrder).toBe(0);
    expect(line.version).toBe(1);
  });

  it('stores retainagePercent when provided', () => {
    const { id } = createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 100, retainagePercent: 10 });
    expect(getSovLine(db, id)!.retainagePercent).toBe(10);
  });

  it('rejects unknown project (NotFoundError)', () => {
    expect(() => createSovLine(db, 'nope', { description: 'X', scheduledValueCents: 0 })).toThrow(NotFoundError);
  });

  it('getSovLine returns null for unknown id', () => {
    expect(getSovLine(db, 'no-such-id')).toBeNull();
  });
});

describe('listSovLines ordering', () => {
  it('orders by sortOrder ASC', () => {
    createSovLine(db, 'p1', { description: 'a', scheduledValueCents: 1 });
    createSovLine(db, 'p1', { description: 'b', scheduledValueCents: 1 });
    createSovLine(db, 'p1', { description: 'c', scheduledValueCents: 1 });
    const list = listSovLines(db, 'p1');
    expect(list.map(l => l.description)).toEqual(['a', 'b', 'c']);
    expect(list.map(l => l.sortOrder)).toEqual([0, 1, 2]);
  });

  it('scopes to the project', () => {
    createSovLine(db, 'p1', { description: 'a', scheduledValueCents: 1 });
    createSovLine(db, 'p2', { description: 'z', scheduledValueCents: 1 });
    expect(listSovLines(db, 'p1').map(l => l.description)).toEqual(['a']);
  });
});

describe('saveSovLine', () => {
  it('bumps version and updates fields with correct version', () => {
    const { id } = createSovLine(db, 'p1', { itemNo: '1', description: 'Old', scheduledValueCents: 100 });
    const line = getSovLine(db, id)!;
    const r = saveSovLine(db, id, { ...line, description: 'New', scheduledValueCents: 200, retainagePercent: 5 });
    expect(r.version).toBe(2);
    const reloaded = getSovLine(db, id)!;
    expect(reloaded.description).toBe('New');
    expect(reloaded.scheduledValueCents).toBe(200);
    expect(reloaded.retainagePercent).toBe(5);
    expect(reloaded.version).toBe(2);
  });

  it('throws ConflictError on stale version', () => {
    const { id } = createSovLine(db, 'p1', { description: 'Old', scheduledValueCents: 100 });
    const line = getSovLine(db, id)!;
    saveSovLine(db, id, { ...line, description: 'Updated' }); // -> v2
    expect(() => saveSovLine(db, id, { ...line, description: 'Stale' })).toThrow(ConflictError); // still v1
  });

  it('throws NotFoundError for missing id', () => {
    expect(() => saveSovLine(db, 'no-such-id', { description: 'X', scheduledValueCents: 0, version: 1 })).toThrow(NotFoundError);
  });
});

describe('validation', () => {
  it('rejects non-integer scheduledValueCents', () => {
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 10.5 })).toThrow(ValidationError);
  });

  it('rejects negative scheduledValueCents', () => {
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: -1 })).toThrow(ValidationError);
  });

  it('rejects non-finite scheduledValueCents', () => {
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: Infinity })).toThrow(ValidationError);
  });

  it('rejects out-of-range retainagePercent', () => {
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 0, retainagePercent: -1 })).toThrow(ValidationError);
    expect(() => createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 0, retainagePercent: 101 })).toThrow(ValidationError);
  });

  it('saveSovLine enforces the same validation', () => {
    const { id } = createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 100 });
    const line = getSovLine(db, id)!;
    expect(() => saveSovLine(db, id, { ...line, scheduledValueCents: 1.5 })).toThrow(ValidationError);
  });
});

describe('deleteSovLine', () => {
  it('deletes the line', () => {
    const { id } = createSovLine(db, 'p1', { description: 'X', scheduledValueCents: 0 });
    deleteSovLine(db, id);
    expect(getSovLine(db, id)).toBeNull();
  });
});

describe('seedSovLines', () => {
  it('inserts lines with sequential sortOrder and itemNo, returns count', () => {
    const r = seedSovLines(db, 'p1', [
      { description: 'Demo', scheduledValueCents: 1000 },
      { description: 'Framing', scheduledValueCents: 2000 },
      { description: 'Finish', scheduledValueCents: 3000, itemNo: 'F-1' },
    ]);
    expect(r.count).toBe(3);
    const list = listSovLines(db, 'p1');
    expect(list.map(l => l.description)).toEqual(['Demo', 'Framing', 'Finish']);
    expect(list.map(l => l.sortOrder)).toEqual([0, 1, 2]);
    expect(list.map(l => l.itemNo)).toEqual(['1', '2', 'F-1']);
    expect(list.every(l => l.isChangeOrder === 0 && l.version === 1)).toBe(true);
  });

  it('replaces existing estimate lines but keeps change-order lines, re-sorting them after', () => {
    // initial estimate
    seedSovLines(db, 'p1', [
      { description: 'Old1', scheduledValueCents: 100 },
      { description: 'Old2', scheduledValueCents: 200 },
    ]);
    // a change-order line (kept across reseed)
    createSovLine(db, 'p1', { description: 'CO line', scheduledValueCents: 500, isChangeOrder: 1, changeOrderId: 'co1' });
    // reseed with a different estimate
    const r = seedSovLines(db, 'p1', [
      { description: 'New1', scheduledValueCents: 111 },
    ]);
    expect(r.count).toBe(1);
    const list = listSovLines(db, 'p1');
    expect(list.map(l => l.description)).toEqual(['New1', 'CO line']);
    expect(list.map(l => l.sortOrder)).toEqual([0, 1]);
    expect(list.map(l => l.isChangeOrder)).toEqual([0, 1]);
  });

  it('validates each scheduledValueCents and aborts without writing', () => {
    expect(() => seedSovLines(db, 'p1', [
      { description: 'Good', scheduledValueCents: 100 },
      { description: 'Bad', scheduledValueCents: -5 },
    ])).toThrow(ValidationError);
    expect(listSovLines(db, 'p1')).toEqual([]);
  });
});

describe('syncChangeOrders', () => {
  it('appends only approved change orders, converts dollars to cents, idempotent on re-run', () => {
    insertChangeOrder('co1', 'p1', '1', 'Extra electrical', 2500.00, 'approved');
    insertChangeOrder('co2', 'p1', '2', 'Pending work', 1000.00, 'pending');
    insertChangeOrder('co3', 'p1', '3', 'Rejected work', 999.00, 'rejected');

    const first = syncChangeOrders(db, 'p1');
    expect(first.added).toBe(1);
    const list = listSovLines(db, 'p1');
    expect(list.length).toBe(1);
    expect(list[0].isChangeOrder).toBe(1);
    expect(list[0].changeOrderId).toBe('co1');
    expect(list[0].itemNo).toBe('CO-1');
    expect(list[0].description).toBe('Extra electrical');
    expect(list[0].scheduledValueCents).toBe(250000); // 2500.00 -> 250000 cents

    // idempotent
    const second = syncChangeOrders(db, 'p1');
    expect(second.added).toBe(0);
    expect(listSovLines(db, 'p1').length).toBe(1);
  });

  it('appends a newly-approved change order on a later run', () => {
    insertChangeOrder('co1', 'p1', '1', 'First', 100.00, 'approved');
    expect(syncChangeOrders(db, 'p1').added).toBe(1);
    insertChangeOrder('co2', 'p1', '2', 'Second', 200.00, 'approved');
    expect(syncChangeOrders(db, 'p1').added).toBe(1);
    expect(listSovLines(db, 'p1').map(l => l.changeOrderId)).toEqual(['co1', 'co2']);
  });

  it('appends CO lines after seeded estimate lines', () => {
    seedSovLines(db, 'p1', [
      { description: 'E1', scheduledValueCents: 1 },
      { description: 'E2', scheduledValueCents: 2 },
    ]);
    insertChangeOrder('co1', 'p1', '1', 'CO', 50.00, 'approved');
    syncChangeOrders(db, 'p1');
    const list = listSovLines(db, 'p1');
    expect(list.map(l => l.description)).toEqual(['E1', 'E2', 'CO']);
    expect(list.map(l => l.sortOrder)).toEqual([0, 1, 2]);
  });
});
