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
  createPayApp, listPayApps, getPayApp, savePayAppLines, setPayApp, deletePayApp,
  computeG703, computeG702,
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

// ---------------------------------------------------------------------------
// Pay applications + G702/G703 computation — CHARACTERIZATION (exact cents).
// ---------------------------------------------------------------------------

// Helper: a project with two SOV lines: $100k and $50k.
function setupTwoLines(): { line1: string; line2: string } {
  const { id: line1 } = createSovLine(db, 'p1', { itemNo: '1', description: 'Line 1', scheduledValueCents: 10000000 });
  const { id: line2 } = createSovLine(db, 'p1', { itemNo: '2', description: 'Line 2', scheduledValueCents: 5000000 });
  return { line1, line2 };
}

describe('createPayApp', () => {
  it('numbers sequentially per project, defaults retainage to 10, seeds lines for each SOV line', () => {
    const { line1, line2 } = setupTwoLines();
    const a1 = createPayApp(db, 'p1', {});
    expect(a1.number).toBe(1);
    const app = getPayApp(db, a1.id)!;
    expect(app.status).toBe('draft');
    expect(app.version).toBe(1);
    expect(app.retainagePercent).toBe(10);
    expect(app.storedRetainagePercent).toBe(10);
    expect(app.lines.length).toBe(2);
    const sovIds = app.lines.map((l: any) => l.sovLineId).sort();
    expect(sovIds).toEqual([line1, line2].sort());
    expect(app.lines.every((l: any) => l.percentComplete === 0 && l.storedMaterialsCents === 0)).toBe(true);

    const a2 = createPayApp(db, 'p1', {});
    expect(a2.number).toBe(2);
  });

  it('carries forward the prior app percentComplete + storedMaterialsCents', () => {
    const { line1 } = setupTwoLines();
    const a1 = createPayApp(db, 'p1', {});
    savePayAppLines(db, a1.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 12345 },
    ], 1);
    const a2 = createPayApp(db, 'p1', {});
    const app2 = getPayApp(db, a2.id)!;
    const l1 = app2.lines.find((l: any) => l.sovLineId === line1);
    expect(l1.percentComplete).toBe(50);
    expect(l1.storedMaterialsCents).toBe(12345);
  });

  it('uses input retainage percents and validates them', () => {
    setupTwoLines();
    const a = createPayApp(db, 'p1', { retainagePercent: 5, storedRetainagePercent: 7.5 });
    const app = getPayApp(db, a.id)!;
    expect(app.retainagePercent).toBe(5);
    expect(app.storedRetainagePercent).toBe(7.5);
    expect(() => createPayApp(db, 'p1', { retainagePercent: 101 })).toThrow(ValidationError);
    expect(() => createPayApp(db, 'p1', { retainagePercent: Infinity })).toThrow(ValidationError);
    expect(() => createPayApp(db, 'p1', { storedRetainagePercent: -1 })).toThrow(ValidationError);
  });

  it('rejects unknown project', () => {
    expect(() => createPayApp(db, 'nope', {})).toThrow(NotFoundError);
  });
});

describe('listPayApps / getPayApp', () => {
  it('lists ordered by number ASC', () => {
    setupTwoLines();
    createPayApp(db, 'p1', {});
    createPayApp(db, 'p1', {});
    createPayApp(db, 'p1', {});
    expect(listPayApps(db, 'p1').map(a => a.number)).toEqual([1, 2, 3]);
  });

  it('getPayApp returns null for unknown id', () => {
    expect(getPayApp(db, 'no-such-id')).toBeNull();
  });
});

describe('savePayAppLines', () => {
  it('upserts lines, bumps app version', () => {
    const { line1 } = setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    const r = savePayAppLines(db, a.id, [
      { sovLineId: line1, percentComplete: 25, storedMaterialsCents: 100 },
    ], 1);
    expect(r.version).toBe(2);
    const app = getPayApp(db, a.id)!;
    expect(app.version).toBe(2);
    const l1 = app.lines.find((l: any) => l.sovLineId === line1);
    expect(l1.percentComplete).toBe(25);
    expect(l1.storedMaterialsCents).toBe(100);
  });

  it('inserts a pay_app_line that did not exist yet', () => {
    setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    // a SOV line added AFTER the app was created has no seeded pay_app_line
    const { id: line3 } = createSovLine(db, 'p1', { description: 'Late', scheduledValueCents: 1000 });
    savePayAppLines(db, a.id, [{ sovLineId: line3, percentComplete: 10, storedMaterialsCents: 0 }], 1);
    const app = getPayApp(db, a.id)!;
    const l3 = app.lines.find((l: any) => l.sovLineId === line3);
    expect(l3.percentComplete).toBe(10);
  });

  it('throws ConflictError on stale version', () => {
    const { line1 } = setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: 10, storedMaterialsCents: 0 }], 1); // -> v2
    expect(() => savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: 20, storedMaterialsCents: 0 }], 1))
      .toThrow(ConflictError);
  });

  it('rejects bad percentComplete (>100 / non-finite)', () => {
    const { line1 } = setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    expect(() => savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: 101, storedMaterialsCents: 0 }], 1)).toThrow(ValidationError);
    expect(() => savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: Infinity, storedMaterialsCents: 0 }], 1)).toThrow(ValidationError);
    expect(() => savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: -1, storedMaterialsCents: 0 }], 1)).toThrow(ValidationError);
  });

  it('rejects bad storedMaterialsCents (non-integer / negative)', () => {
    const { line1 } = setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    expect(() => savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: 0, storedMaterialsCents: 1.5 }], 1)).toThrow(ValidationError);
    expect(() => savePayAppLines(db, a.id, [{ sovLineId: line1, percentComplete: 0, storedMaterialsCents: -1 }], 1)).toThrow(ValidationError);
  });
});

describe('setPayApp', () => {
  it('patches status + retainage and bumps version', () => {
    setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    const r = setPayApp(db, a.id, { status: 'submitted', retainagePercent: 5 });
    expect(r.version).toBe(2);
    const app = getPayApp(db, a.id)!;
    expect(app.status).toBe('submitted');
    expect(app.retainagePercent).toBe(5);
    expect(app.storedRetainagePercent).toBe(10); // unchanged
  });

  it('validates retainage', () => {
    setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    expect(() => setPayApp(db, a.id, { retainagePercent: 200 })).toThrow(ValidationError);
  });
});

describe('deletePayApp', () => {
  it('cascades its pay_app_lines', () => {
    setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    expect(getPayApp(db, a.id)!.lines.length).toBe(2);
    deletePayApp(db, a.id);
    expect(getPayApp(db, a.id)).toBeNull();
    const remaining = db.prepare('SELECT COUNT(*) c FROM aia_pay_app_lines WHERE payAppId = ?').get(a.id) as any;
    expect(remaining.c).toBe(0);
  });

  it('cascades its payments', () => {
    setupTwoLines();
    const a = createPayApp(db, 'p1', {});
    db.prepare('INSERT INTO payments (id, targetType, targetId, amount, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run('pay1', 'payapp', a.id, 500, 1);
    deletePayApp(db, a.id);
    const remaining = db.prepare("SELECT COUNT(*) c FROM payments WHERE targetType = 'payapp' AND targetId = ?").get(a.id) as any;
    expect(remaining.c).toBe(0);
  });
});

describe('computeG703 / computeG702 — exact cents', () => {
  it('app #1: 50% line1, 0% line2, retainage 10/10', () => {
    const { line1 } = setupTwoLines();
    const a1 = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 10 });
    savePayAppLines(db, a1.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 0 },
      // line2 left at 0%
    ], 1);

    const g703 = computeG703(db, a1.id);
    const r1 = g703[0];
    expect(r1.scheduledValueCents).toBe(10000000);   // C
    expect(r1.previousCents).toBe(0);                 // D
    expect(r1.thisPeriodCents).toBe(5000000);         // E
    expect(r1.storedCents).toBe(0);                   // F
    expect(r1.totalToDateCents).toBe(5000000);        // G
    expect(r1.balanceToFinishCents).toBe(5000000);
    expect(r1.retainageCents).toBe(500000);

    const g702 = computeG702(db, a1.id);
    expect(g702.L1originalContractCents).toBe(15000000);
    expect(g702.L2changeOrdersCents).toBe(0);
    expect(g702.L3contractSumToDateCents).toBe(15000000);
    expect(g702.L4totalCompletedStoredCents).toBe(5000000);
    expect(g702.L5aRetainageWorkCents).toBe(500000);
    expect(g702.L5bRetainageStoredCents).toBe(0);
    expect(g702.L5retainageCents).toBe(500000);
    expect(g702.L6earnedLessRetainageCents).toBe(4500000);
    expect(g702.L7lessPreviousCents).toBe(0);
    expect(g702.L8currentPaymentDueCents).toBe(4500000);
    expect(g702.L9balanceToFinishCents).toBe(10500000);
  });

  it('app #2: carry-forward, 75%/200000 stored on line1, 40% on line2; L7 pulls prior L6', () => {
    const { line1, line2 } = setupTwoLines();
    const a1 = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 10 });
    savePayAppLines(db, a1.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 0 },
    ], 1);

    const a2 = createPayApp(db, 'p1', {});
    savePayAppLines(db, a2.id, [
      { sovLineId: line1, percentComplete: 75, storedMaterialsCents: 200000 },
      { sovLineId: line2, percentComplete: 40, storedMaterialsCents: 0 },
    ], 1);

    const g703 = computeG703(db, a2.id);
    const r1 = g703[0];
    expect(r1.scheduledValueCents).toBe(10000000);  // C
    expect(r1.previousCents).toBe(5000000);         // D (prior 50%)
    expect(r1.thisPeriodCents).toBe(2500000);       // E (75% - 50%)
    expect(r1.storedCents).toBe(200000);            // F
    expect(r1.totalToDateCents).toBe(7700000);      // G
    expect(r1.retainageCents).toBe(770000);         // round(7500000*10%)=750000 + round(200000*10%)=20000

    const r2 = g703[1];
    expect(r2.scheduledValueCents).toBe(5000000);
    expect(r2.previousCents).toBe(0);
    expect(r2.thisPeriodCents).toBe(2000000);       // 40%
    expect(r2.totalToDateCents).toBe(2000000);
    expect(r2.retainageCents).toBe(200000);

    const g702 = computeG702(db, a2.id);
    expect(g702.L4totalCompletedStoredCents).toBe(9700000);  // 7700000 + 2000000
    expect(g702.L5aRetainageWorkCents).toBe(950000);         // 750000 + 200000
    expect(g702.L5bRetainageStoredCents).toBe(20000);        // round(200000*10%)
    expect(g702.L5retainageCents).toBe(970000);
    expect(g702.L6earnedLessRetainageCents).toBe(8730000);
    expect(g702.L7lessPreviousCents).toBe(4500000);          // app#1 L6
    expect(g702.L8currentPaymentDueCents).toBe(4230000);     // 8730000 - 4500000
  });

  it('per-line retainage override uses the line percent not the app percent', () => {
    const { line1, line2 } = setupTwoLines();
    // override line2 to 5% retainage
    const l2 = getSovLine(db, line2)!;
    saveSovLine(db, line2, { ...l2, retainagePercent: 5 });

    const a1 = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 10 });
    savePayAppLines(db, a1.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 0 },
      { sovLineId: line2, percentComplete: 100, storedMaterialsCents: 0 },
    ], 1);

    const g703 = computeG703(db, a1.id);
    const r1 = g703[0]; // 10% app default
    expect(r1.retainageCents).toBe(500000); // round(5000000*10%)
    const r2 = g703[1]; // 5% override on a fully complete $50k line
    // completed = 5000000; retainage = round(5000000*5%) = 250000  (would be 500000 at 10%)
    expect(r2.retainageCents).toBe(250000);

    const g702 = computeG702(db, a1.id);
    // L5a = round(5000000*10%) + round(5000000*5%) = 500000 + 250000 = 750000
    expect(g702.L5aRetainageWorkCents).toBe(750000);
  });

  it('change-order line: L1 unchanged, L2 / L3 include it, changeOrders.additions set', () => {
    setupTwoLines();
    createSovLine(db, 'p1', { description: 'CO', scheduledValueCents: 1000000, isChangeOrder: 1 });
    const a1 = createPayApp(db, 'p1', {});
    const g702 = computeG702(db, a1.id);
    expect(g702.L1originalContractCents).toBe(15000000);  // unchanged
    expect(g702.L2changeOrdersCents).toBe(1000000);
    expect(g702.L3contractSumToDateCents).toBe(16000000);
    expect(g702.changeOrders.additionsCents).toBe(1000000);
    expect(g702.changeOrders.deductionsCents).toBe(0);
    expect(g702.changeOrders.netCents).toBe(1000000);
  });

  it('rounds per line (Math.round): 333 @ 33% => 110 cents', () => {
    const { id: line } = createSovLine(db, 'p1', { description: 'Tiny', scheduledValueCents: 333 });
    const a1 = createPayApp(db, 'p1', { retainagePercent: 0, storedRetainagePercent: 0 });
    savePayAppLines(db, a1.id, [{ sovLineId: line, percentComplete: 33, storedMaterialsCents: 0 }], 1);
    const g703 = computeG703(db, a1.id);
    // Math.round(333 * 33 / 100) = Math.round(109.89) = 110
    expect(g703[0].totalToDateCents).toBe(110);
    expect(g703[0].thisPeriodCents).toBe(110);
  });

  it('computeG702 throws NotFoundError for unknown pay app', () => {
    expect(() => computeG702(db, 'no-such-id')).toThrow(NotFoundError);
  });

  // Characterization: prior-application stored materials do NOT roll into column D.
  // AIA G703 col D = prior application's (D+E) = work only; stored (col F) is a
  // current snapshot, separate from D. D must be 5000000, NOT 5100000.
  it('col D excludes prior stored materials (AIA G703 correct: D = work only)', () => {
    const { id: line1 } = createSovLine(db, 'p1', { itemNo: '1', description: 'Work', scheduledValueCents: 10000000 });

    // App #1: 50% work complete, $1000 in stored materials.
    const a1 = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 10 });
    savePayAppLines(db, a1.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 100000 },
    ], 1);
    // (app#1 completedToDate = 5000000; stored = 100000)

    // App #2: same 50% work (no new work this period), more stored materials on hand.
    const a2 = createPayApp(db, 'p1', {});
    savePayAppLines(db, a2.id, [
      { sovLineId: line1, percentComplete: 50, storedMaterialsCents: 200000 },
    ], 1);

    const g703 = computeG703(db, a2.id);
    const r = g703[0];

    // D = prior WORK only: round(10000000 * 50 / 100) = 5000000
    // If prior stored were included, D would be 5100000 — that is AIA-incorrect.
    expect(r.previousCents).toBe(5000000);    // D: prior work only, NOT 5100000
    expect(r.thisPeriodCents).toBe(0);        // E: no new work this period
    expect(r.storedCents).toBe(200000);       // F: current stored snapshot
    expect(r.totalToDateCents).toBe(5200000); // G: completedToDate(5000000) + storedCents(200000)

    // G702 internal consistency: L4 == sum of col G.
    const g702 = computeG702(db, a2.id);
    expect(g702.L4totalCompletedStoredCents).toBe(5200000); // matches col G sum
  });
});
