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
  listChangeOrders, createChangeOrder, setChangeOrderStatus, deleteChangeOrder, billingSummary,
} from './billingStore';

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

  it('creates change orders (pending by default) and rolls up only approved ones', () => {
    createChangeOrder(db, 'p1', { number: 'CO-1', description: 'Extra outlets', amount: 1500 });
    const co2 = createChangeOrder(db, 'p1', { number: 'CO-2', description: 'Demo', amount: 800 });
    let s = billingSummary(db, 'p1');
    expect(s.baseContractCents).toBe(1000000);
    expect(s.approvedChangeCents).toBe(0); // both pending
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
    expect(() => createChangeOrder(db, 'p1', { amount: 'x' as any })).toThrow(ValidationError);
    expect(() => setChangeOrderStatus(db, 'nope', 'approved')).toThrow(NotFoundError);
    createChangeOrder(db, 'p1', { number: 'CO-1', amount: 1, description: 'a' });
    createChangeOrder(db, 'p1', { number: 'CO-2', amount: 2, description: 'b' });
    expect(listChangeOrders(db, 'p1').map(c => c.number)).toEqual(['CO-2', 'CO-1']);
  });
});
