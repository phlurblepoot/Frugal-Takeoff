// server/billingStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  toCents, sumCents, listInvoices, getInvoice, createInvoice, saveInvoice,
  deleteInvoice, ValidationError, ConflictError, NotFoundError,
  recordPayment, deletePayment, setInvoiceStatus, listProjectPayments, paidCentsFor,
  listChangeOrders, getChangeOrder, createChangeOrder, saveChangeOrder, setChangeOrderStatus,
  deleteChangeOrder, addChangeOrderPhoto, removeChangeOrderPhoto, billingSummary,
  listBilledDocuments,
} from './billingStore';
import { createSovLine, listSovLines, createPayApp, savePayAppLines, setPayApp } from './aiaStore';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-bill-')), migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
});

describe('money helpers', () => {
  it('toCents rounds half-up to the nearest cent', () => {
    expect(toCents(10)).toBe(1000);
    expect(toCents(10.005)).toBe(1001); // 1000.5 → 1001
    expect(toCents(0.1 + 0.2)).toBe(30); // float 0.30000000000000004 → 30
  });
  it('sumCents adds line totals exactly with no float drift', () => {
    // 3 lines of 0.1 each → 0.30 exactly, not 0.30000000000000004
    expect(sumCents([{ qty: 1, unitPrice: 0.1 }, { qty: 1, unitPrice: 0.1 }, { qty: 1, unitPrice: 0.1 }])).toBe(30);
    expect(sumCents([{ qty: 2.5, unitPrice: 4 }])).toBe(1000); // 10.00
  });
});

describe('invoices', () => {
  it('createInvoice persists header + lines and computes totals in cents', () => {
    const r = createInvoice(db, 'p1', {
      number: 'INV-1', date: 100, terms: 'Net 30',
      lines: [{ description: 'A', qty: 2, unitPrice: 50 }, { description: 'B', qty: 1, unitPrice: 25.5 }],
    });
    expect(r.id).toBeTruthy();
    const inv = getInvoice(db, r.id)!;
    expect(inv.status).toBe('draft');
    expect(inv.version).toBe(1);
    expect(inv.lines).toHaveLength(2);
    expect(inv.totalCents).toBe(12550); // 100.00 + 25.50
    expect(inv.paidCents).toBe(0);
    expect(inv.balanceCents).toBe(12550);
  });

  it('saveInvoice is version-checked and replaces lines', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    const inv = getInvoice(db, id)!;
    const saved = saveInvoice(db, id, { ...inv, terms: 'Net 15', lines: [{ description: 'C', qty: 3, unitPrice: 5 }] });
    expect(saved.version).toBe(2);
    const reloaded = getInvoice(db, id)!;
    expect(reloaded.terms).toBe('Net 15');
    expect(reloaded.lines).toHaveLength(1);
    expect(reloaded.totalCents).toBe(1500);
  });

  it('saveInvoice rejects a stale version', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    const stale = getInvoice(db, id)!;
    saveInvoice(db, id, { ...stale }); // → v2
    expect(() => saveInvoice(db, id, { ...stale })).toThrow(ConflictError);
  });

  it('validates payloads', () => {
    expect(() => createInvoice(db, 'p1', { lines: 'nope' as any })).toThrow(ValidationError);
    expect(() => createInvoice(db, 'p1', { lines: [{ description: 'x', qty: -1, unitPrice: 1 }] })).toThrow(ValidationError);
    expect(() => createInvoice(db, 'nope', { lines: [] })).toThrow(NotFoundError);
  });

  it('rejects non-finite line amounts (Infinity from 1e400)', () => {
    expect(() => createInvoice(db, 'p1', { lines: [{ description: 'x', qty: 1e400, unitPrice: 1 }] })).toThrow(ValidationError);
    expect(() => createInvoice(db, 'p1', { lines: [{ description: 'x', qty: 1, unitPrice: Infinity }] })).toThrow(ValidationError);
  });

  it('listInvoices returns slim rows newest-first with totals', () => {
    createInvoice(db, 'p1', { number: 'INV-1', date: 1, lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    createInvoice(db, 'p1', { number: 'INV-2', date: 2, lines: [{ description: 'B', qty: 1, unitPrice: 20 }] });
    const list = listInvoices(db, 'p1');
    expect(list.map(i => i.number)).toEqual(['INV-2', 'INV-1']);
    expect(list[0].totalCents).toBe(2000);
    expect(list[0].lines).toBeUndefined(); // slim
  });

  it('deleteInvoice removes the invoice, its lines and payments', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    deleteInvoice(db, id);
    expect(getInvoice(db, id)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM invoice_lines').get() as any).c).toBe(0);
  });
});

describe('payments + status', () => {
  it('records and deletes payments; balance reflects them', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [{ description: 'A', qty: 1, unitPrice: 100 }] });
    const p1 = recordPayment(db, 'invoice', id, { date: 1, amount: 40, method: 'check', note: 'deposit' });
    recordPayment(db, 'invoice', id, { date: 2, amount: 25.5, method: 'card' });
    let inv = getInvoice(db, id)!;
    expect(inv.paidCents).toBe(6550);
    expect(inv.balanceCents).toBe(3450);
    deletePayment(db, p1.id);
    inv = getInvoice(db, id)!;
    expect(inv.paidCents).toBe(2550);
  });

  it('rejects invalid payment amounts and unknown invoices', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    expect(() => recordPayment(db, 'invoice', id, { amount: -5 })).toThrow(ValidationError);
    expect(() => recordPayment(db, 'invoice', 'nope', { amount: 5 })).toThrow(NotFoundError);
  });

  it('rejects non-finite payment amounts', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    expect(() => recordPayment(db, 'invoice', id, { amount: 1e400 })).toThrow(ValidationError);
  });

  it('rejects bad target type and missing pay-app targets', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    expect(() => recordPayment(db, 'galaxy' as any, id, { amount: 5 })).toThrow(ValidationError);
    expect(() => recordPayment(db, 'payapp', 'nope', { amount: 5 })).toThrow(NotFoundError);
  });

  it('records payments against an AIA pay application and sums them', () => {
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'p1', 3, 'draft', 1, 1)").run();
    recordPayment(db, 'payapp', 'app1', { date: 1, amount: 1000, method: 'wire' });
    recordPayment(db, 'payapp', 'app1', { date: 2, amount: 250.25 });
    expect(paidCentsFor(db, 'payapp', 'app1')).toBe(125025);
    // invoice payments are isolated from payapp payments
    const inv = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    recordPayment(db, 'invoice', inv.id, { amount: 10 });
    expect(paidCentsFor(db, 'invoice', inv.id)).toBe(1000);
    expect(paidCentsFor(db, 'payapp', 'app1')).toBe(125025);
  });

  it('getInvoice shows only its own invoice payments', () => {
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'p1', 1, 'draft', 1, 1)").run();
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    recordPayment(db, 'invoice', id, { amount: 10 });
    recordPayment(db, 'payapp', 'app1', { amount: 99 });
    expect(getInvoice(db, id)!.payments).toHaveLength(1);
    expect(getInvoice(db, id)!.paidCents).toBe(1000);
  });

  it('deletePayApp removes its payments', () => {
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'p1', 1, 'draft', 1, 1)").run();
    recordPayment(db, 'payapp', 'app1', { amount: 50 });
    db.prepare('DELETE FROM aia_pay_apps WHERE id = ?').run('app1'); // standalone; cascade tested in aiaStore
    // listProjectPayments still excludes orphan-target rows that no longer match a project pay-app
    expect(listProjectPayments(db, 'p1')).toHaveLength(0);
  });

  it('listProjectPayments returns invoice + payapp payments with labels, newest-first', () => {
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'p1', 7, 'draft', 1, 1)").run();
    const inv = createInvoice(db, 'p1', { number: 'INV-9', lines: [] });
    recordPayment(db, 'invoice', inv.id, { date: 10, amount: 100 });
    recordPayment(db, 'payapp', 'app1', { date: 20, amount: 200 });
    const list = listProjectPayments(db, 'p1');
    expect(list).toHaveLength(2);
    // date DESC → payapp (20) first
    expect(list[0].targetType).toBe('payapp');
    expect(list[0].targetLabel).toBe('Application #7');
    expect(list[0].amount).toBe(200);
    expect(list[1].targetType).toBe('invoice');
    expect(list[1].targetLabel).toBe('Invoice INV-9');
  });

  it('setInvoiceStatus validates the value and bumps version', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    const r = setInvoiceStatus(db, id, 'sent');
    expect(r.version).toBe(2);
    expect(getInvoice(db, id)!.status).toBe('sent');
    expect(() => setInvoiceStatus(db, id, 'galactic')).toThrow(ValidationError);
  });
});

describe('change orders + contract rollup', () => {
  beforeEach(() => {
    db.prepare('UPDATE projects SET contractValue = ? WHERE id = ?').run(10000, 'p1'); // $10k base
  });

  it('creates change orders (draft by default) and rolls up only approved ones', () => {
    createChangeOrder(db, 'p1', { number: 'CO-1', description: 'Extra outlets', lumpSumAmount: 1500 });
    const co2 = createChangeOrder(db, 'p1', { number: 'CO-2', description: 'Demo', lumpSumAmount: 800 });
    expect(getChangeOrder(db, co2.id)!.status).toBe('draft'); // new lifecycle default
    let s = billingSummary(db, 'p1');
    expect(s.baseContractCents).toBe(1000000);
    expect(s.approvedChangeCents).toBe(0); // both draft
    expect(s.contractValueCents).toBe(1000000);

    setChangeOrderStatus(db, co2.id, 'approved');
    s = billingSummary(db, 'p1');
    expect(s.approvedChangeCents).toBe(80000);
    expect(s.contractValueCents).toBe(1080000); // base + approved CO
  });

  it('summary aggregates invoiced + paid + balance across invoices', () => {
    const inv = createInvoice(db, 'p1', { number: 'INV-1', status: 'sent', lines: [{ description: 'A', qty: 1, unitPrice: 500 }] });
    recordPayment(db, 'invoice', inv.id, { amount: 200 });
    const s = billingSummary(db, 'p1');
    expect(s.invoicedCents).toBe(50000);
    expect(s.paidCents).toBe(20000);
    expect(s.outstandingCents).toBe(30000);
    expect(s.invoiceCount).toBe(1);
  });

  it('validates and lists change orders newest-first', () => {
    expect(() => createChangeOrder(db, 'p1', { lumpSumAmount: 'x' as any })).toThrow(ValidationError);
    expect(() => setChangeOrderStatus(db, 'nope', 'approved')).toThrow(NotFoundError);
    createChangeOrder(db, 'p1', { number: 'CO-1', lumpSumAmount: 1, description: 'a' });
    createChangeOrder(db, 'p1', { number: 'CO-2', lumpSumAmount: 2, description: 'b' });
    expect(listChangeOrders(db, 'p1').map(c => c.number)).toEqual(['CO-2', 'CO-1']);
  });
});

describe('change orders — line items, lump sum, version, photos (Phase 9)', () => {
  beforeEach(() => {
    db.prepare('UPDATE projects SET contractValue = ? WHERE id = ?').run(10000, 'p1');
  });

  it('CO total = Σ lines (round-per-line) + lump sum; amount = totalCents/100 (exact)', () => {
    const { id } = createChangeOrder(db, 'p1', {
      number: '001',
      lumpSumAmount: 25.5,
      lines: [
        { description: 'A', qty: 2, unitPrice: 50 },     // 100.00
        { description: 'B', qty: 1, unitPrice: 25.5 },    // 25.50
        { description: 'C', qty: 3, unitPrice: 0.1 },     // 0.30 (round-per-line)
      ],
    });
    const co = getChangeOrder(db, id)!;
    expect(co.lumpSumCents).toBe(2550);
    expect(co.totalCents).toBe(10000 + 2550 + 30 + 2550); // lines 12580 + lump 2550 = 15130
    // amount is the canonical rolled-up dollars read by billingSummary + SOV sync.
    expect(co.amount).toBe(co.totalCents / 100);
    // The invariant: zero cents drift round-tripping dollars→cents.
    expect(Math.round(co.amount * 100)).toBe(co.totalCents);
  });

  it('approved CO amount flows into the contract total with no drift', () => {
    const { id } = createChangeOrder(db, 'p1', {
      lumpSumAmount: 0,
      lines: [{ description: 'X', qty: 3, unitPrice: 33.33 }], // 99.99
    });
    setChangeOrderStatus(db, id, 'approved');
    const co = getChangeOrder(db, id)!;
    expect(co.totalCents).toBe(9999);
    const s = billingSummary(db, 'p1');
    expect(s.approvedChangeCents).toBe(9999); // exact — billingSummary reads amount
    expect(s.contractTotalCents).toBe(1000000 + 9999);
  });

  it('saveChangeOrder is version-checked, replaces lines, recomputes amount, bumps version', () => {
    const { id } = createChangeOrder(db, 'p1', { number: '001', lumpSumAmount: 0, lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    const co = getChangeOrder(db, id)!;
    expect(co.version).toBe(1);
    const saved = saveChangeOrder(db, id, {
      version: co.version,
      number: 'CO-001',
      description: 'updated',
      lumpSumAmount: 100,
      scheduleImpactDays: 5,
      lines: [{ description: 'B', qty: 2, unitPrice: 5 }], // 10.00
    });
    expect(saved.version).toBe(2);
    const reloaded = getChangeOrder(db, id)!;
    expect(reloaded.number).toBe('CO-001');
    expect(reloaded.description).toBe('updated');
    expect(reloaded.scheduleImpactDays).toBe(5);
    expect(reloaded.lines).toHaveLength(1);
    expect(reloaded.totalCents).toBe(1000 + 10000); // lines 10.00 + lump 100.00
    expect(reloaded.amount).toBe(reloaded.totalCents / 100);
    expect(Math.round(reloaded.amount * 100)).toBe(reloaded.totalCents);
  });

  it('title round-trips through create and save, and blank/whitespace normalizes to null', () => {
    const { id } = createChangeOrder(db, 'p1', { number: '001', title: '  Kitchen electrical add  ', lumpSumAmount: 0 });
    let co = getChangeOrder(db, id)!;
    expect(co.title).toBe('Kitchen electrical add');

    const saved = saveChangeOrder(db, id, { version: co.version, title: '   ', lumpSumAmount: 0 });
    co = getChangeOrder(db, id)!;
    expect(saved.version).toBe(2);
    expect(co.title).toBeNull();

    const untitled = createChangeOrder(db, 'p1', { number: '002', lumpSumAmount: 0 });
    expect(getChangeOrder(db, untitled.id)!.title).toBeNull();
  });

  it('saveChangeOrder throws ConflictError on a stale version', () => {
    const { id } = createChangeOrder(db, 'p1', { lumpSumAmount: 0 });
    saveChangeOrder(db, id, { version: 1, lumpSumAmount: 1 }); // now v2
    expect(() => saveChangeOrder(db, id, { version: 1, lumpSumAmount: 2 })).toThrow(ConflictError);
  });

  it('saveChangeOrder does NOT change status', () => {
    const { id } = createChangeOrder(db, 'p1', { lumpSumAmount: 0 });
    setChangeOrderStatus(db, id, 'approved'); // v2, approved
    const v = getChangeOrder(db, id)!.version;
    saveChangeOrder(db, id, { version: v, lumpSumAmount: 50 });
    expect(getChangeOrder(db, id)!.status).toBe('approved');
  });

  it('auto-numbers per project (001, 002, …) and honors an explicit override', () => {
    const a = createChangeOrder(db, 'p1', {});
    const b = createChangeOrder(db, 'p1', {});
    expect(getChangeOrder(db, a.id)!.number).toBe('001');
    expect(getChangeOrder(db, b.id)!.number).toBe('002');
    const c = createChangeOrder(db, 'p1', { number: 'CO-99' });
    expect(getChangeOrder(db, c.id)!.number).toBe('CO-99');
    // next sequence parses the max int across all numbers (99) → 100
    const d = createChangeOrder(db, 'p1', {});
    expect(getChangeOrder(db, d.id)!.number).toBe('100');
  });

  it('status validation accepts the new set and tolerates reading legacy pending rows', () => {
    const { id } = createChangeOrder(db, 'p1', {});
    expect(() => setChangeOrderStatus(db, id, 'sent')).not.toThrow();
    expect(() => setChangeOrderStatus(db, id, 'approved')).not.toThrow();
    expect(() => setChangeOrderStatus(db, id, 'rejected')).not.toThrow();
    expect(() => setChangeOrderStatus(db, id, 'pending')).toThrow(ValidationError); // not a valid new transition
    // A legacy pending row (written directly) must still READ without throwing.
    db.prepare("UPDATE change_orders SET status = 'pending' WHERE id = ?").run(id);
    expect(getChangeOrder(db, id)!.status).toBe('pending');
    expect(listChangeOrders(db, 'p1').find(c => c.id === id)!.status).toBe('pending');
  });

  it('photos: idempotent add bumps version, remove bumps version', () => {
    const { id } = createChangeOrder(db, 'p1', {});
    addChangeOrderPhoto(db, id, 'file-1');
    addChangeOrderPhoto(db, id, 'file-1'); // idempotent — no second row, no extra bump
    let co = getChangeOrder(db, id)!;
    expect(co.photos).toHaveLength(1);
    expect(co.version).toBe(2); // 1 → +1 on the first add only
    addChangeOrderPhoto(db, id, 'file-2');
    co = getChangeOrder(db, id)!;
    expect(co.photos).toHaveLength(2);
    expect(co.version).toBe(3);
    removeChangeOrderPhoto(db, id, 'file-1');
    co = getChangeOrder(db, id)!;
    expect(co.photos.map((p: any) => p.fileId)).toEqual(['file-2']);
    expect(co.version).toBe(4);
  });

  it('deleteChangeOrder cascades lines, photos, and the synced SOV line', () => {
    const { id } = createChangeOrder(db, 'p1', { lumpSumAmount: 0, lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    addChangeOrderPhoto(db, id, 'file-1');
    // Simulate a synced AIA SOV line keyed on this CO.
    db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, description, scheduledValueCents, isChangeOrder, changeOrderId, sortOrder, version, createdAt) VALUES (?, ?, ?, ?, 1, ?, 0, 1, 1)'
    ).run('sov-co', 'p1', 'CO', 1000, id);
    deleteChangeOrder(db, id);
    expect(getChangeOrder(db, id)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM change_order_lines WHERE changeOrderId = ?').get(id) as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM change_order_photos WHERE changeOrderId = ?').get(id) as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM aia_sov_lines WHERE changeOrderId = ?').get(id) as any).c).toBe(0);
  });
});

describe('billingSummary — SOV-derived contract total', () => {
  const insSov = (id: string, valueCents: number, isCO = 0) =>
    db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, description, scheduledValueCents, isChangeOrder, sortOrder, version, createdAt) VALUES (?, ?, ?, ?, ?, ?, 1, 1)'
    ).run(id, 'p1', id, valueCents, isCO, 0);
  const insApprovedCO = (num: string, dollars: number) => {
    const co = createChangeOrder(db, 'p1', { number: num, lumpSumAmount: dollars });
    setChangeOrderStatus(db, co.id, 'approved');
  };

  it('derives base + total from the SOV when one exists, even if contractValue=0', () => {
    db.prepare('UPDATE projects SET contractValue = 0 WHERE id = ?').run('p1');
    insSov('s1', 10000000);
    insSov('s2', 5000000);
    insApprovedCO('CO-1', 10000); // $10,000 → 1,000,000 cents
    const s = billingSummary(db, 'p1');
    expect(s.hasSov).toBe(true);
    expect(s.sovOriginalCents).toBe(15000000);
    expect(s.baseContractCents).toBe(15000000);
    expect(s.approvedChangeCents).toBe(1000000);
    expect(s.contractTotalCents).toBe(16000000);
    expect(s.contractValueCents).toBe(16000000); // back-compat mirror
  });

  it('falls back to projects.contractValue when no SOV lines exist', () => {
    db.prepare('UPDATE projects SET contractValue = 200000 WHERE id = ?').run('p1'); // $200k
    insApprovedCO('CO-1', 10000); // $10k
    const s = billingSummary(db, 'p1');
    expect(s.hasSov).toBe(false);
    expect(s.sovOriginalCents).toBe(0);
    expect(s.baseContractCents).toBe(20000000);
    expect(s.contractTotalCents).toBe(21000000);
    expect(s.contractValueCents).toBe(21000000);
  });

  it('CO SOV lines (isChangeOrder=1) do not inflate the base or double-count', () => {
    db.prepare('UPDATE projects SET contractValue = 0 WHERE id = ?').run('p1');
    insSov('s1', 10000000); // original
    insSov('s2', 5000000); // original
    insSov('co-sov', 1000000, 1); // CO SOV line — must be ignored by base
    insApprovedCO('CO-1', 10000); // $10k via change_orders — the single source for the CO
    const s = billingSummary(db, 'p1');
    expect(s.sovOriginalCents).toBe(15000000); // CO SOV line excluded
    expect(s.baseContractCents).toBe(15000000);
    expect(s.approvedChangeCents).toBe(1000000);
    // total = original + approved change_orders ONCE (no +1,000,000 from co-sov)
    expect(s.contractTotalCents).toBe(16000000);
  });

  it('splits paid amounts across invoices vs pay-apps', () => {
    const inv = createInvoice(db, 'p1', { number: 'INV-1', status: 'sent', lines: [{ description: 'A', qty: 1, unitPrice: 5000 }] });
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'p1', 1, 'draft', 1, 1)").run();
    recordPayment(db, 'invoice', inv.id, { amount: 2000 }); // $2,000
    recordPayment(db, 'payapp', 'app1', { amount: 1000 }); // $1,000
    const s = billingSummary(db, 'p1');
    expect(s.paid.invoicesCents).toBe(200000);
    expect(s.paid.payAppsCents).toBe(100000);
    expect(s.paidCents).toBe(200000); // back-compat = invoice payments
    expect(s.invoiceTotalCents).toBe(500000);
    expect(s.invoiceOutstandingCents).toBe(300000); // 500000 - 200000
    expect(s.outstandingCents).toBe(300000);
  });
});

describe('billingSummary — payAppBilledCents / payAppOutstandingCents (contract split)', () => {
  it('mixed project: finalized pay app (net of retainage) + sent invoice + draft invoice excluded', () => {
    // Pay app: $1,000 SOV line, 100% complete, 10% retainage, no prior app.
    //   completedToDateCents = 100000; retainage = round(100000*10%) = 10000
    //   L8 = (100000 - 10000) - previous(0) = 90000c
    createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 100000 });
    const app = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 10 });
    const sov = listSovLines(db, 'p1');
    savePayAppLines(db, app.id, [{ sovLineId: sov[0].id, percentComplete: 100, storedMaterialsCents: 0 }], 1);
    setPayApp(db, app.id, { status: 'finalized' });
    recordPayment(db, 'payapp', app.id, { amount: 250 }); // 25000c of the 90000c billed

    // Sent invoice: $200 (20000c), $50 (5000c) paid.
    const inv = createInvoice(db, 'p1', { number: 'INV-1', status: 'sent', lines: [{ description: 'A', qty: 1, unitPrice: 200 }] });
    recordPayment(db, 'invoice', inv.id, { amount: 50 });

    // Draft invoice — not billed (excluded from listBilledDocuments/payApp
    // figures), but billingSummary's legacy invoiceTotalCents pre-existingly
    // sums ALL invoices including drafts, so it DOES land here — that's
    // existing behavior, unrelated to this change.
    createInvoice(db, 'p1', { number: 'INV-DRAFT', lines: [{ description: 'B', qty: 1, unitPrice: 999 }] });

    const s = billingSummary(db, 'p1');
    expect(s.payAppBilledCents).toBe(90000);
    expect(s.payAppOutstandingCents).toBe(65000); // 90000 - 25000
    expect(s.payAppPaidCents).toBe(25000);

    // Legacy invoice-only fields are unchanged by the new pay-app fields —
    // draft-INCLUSIVE (pre-existing behavior).
    expect(s.invoiceTotalCents).toBe(119900); // 20000 sent + 99900 draft (pre-existing behavior)
    expect(s.invoiceOutstandingCents).toBe(114900); // 119900 - 5000 paid
    expect(s.paid.payAppsCents).toBe(25000);

    // New invoice-leg fields are draft-EXCLUSIVE — only the sent invoice
    // counts, mirroring listBilledDocuments/the customer ledger.
    expect(s.invoiceBilledCents).toBe(20000);
    expect(s.invoicePaidCents).toBe(5000);
    expect(s.invoiceOutstandingBilledCents).toBe(15000); // 20000 - 5000

    // A caller that already fetched listBilledDocuments (customerOverview,
    // listProjectSummaries) can pass it in and get identical figures back,
    // without billingSummary re-querying the same rows.
    const docs = listBilledDocuments(db, 'p1');
    const s2 = billingSummary(db, 'p1', docs);
    expect(s2).toEqual(s);
  });

  it('is zero when the project has no finalized pay apps (draft apps excluded)', () => {
    createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 100000 });
    createPayApp(db, 'p1', {}); // stays draft
    const s = billingSummary(db, 'p1');
    expect(s.payAppBilledCents).toBe(0);
    expect(s.payAppOutstandingCents).toBe(0);
  });
});
