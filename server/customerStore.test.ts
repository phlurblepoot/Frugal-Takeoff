import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  listCustomers, getCustomer, saveCustomer, deleteCustomer, mergeCustomers, listProjectsForCustomer,
  customerSummaries, customerOverview,
} from './customerStore';
import { createInvoice, setInvoiceStatus } from './billingStore';

function db(): Database.Database {
  const d = openDb(':memory:');
  runMigrations(d, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-cust-')), migrations);
  return d;
}

describe('customerStore', () => {
  let d: Database.Database;
  beforeEach(() => { d = db(); });

  it('creates, reads, updates, lists', () => {
    saveCustomer(d, { id: 'c1', name: 'Acme', phone: '555', emails: { accounting: { to: 'ap@acme.com' }, estimating: { to: 'est@acme.com', cc: 'boss@acme.com' } } });
    const c = getCustomer(d, 'c1');
    expect(c!.name).toBe('Acme');
    expect(c!.emails.accounting!.to).toBe('ap@acme.com');
    expect(c!.emails.estimating!.cc).toBe('boss@acme.com');
    saveCustomer(d, { id: 'c1', name: 'Acme LLC', emails: { general: { to: 'info@acme.com' } } });
    expect(getCustomer(d, 'c1')!.name).toBe('Acme LLC');
    // migrations seed an "Unassigned" customer; we added one more
    expect(listCustomers(d).map(c2 => c2.id)).toContain('c1');
  });

  it('blocks deleting a customer that still owns projects', () => {
    saveCustomer(d, { id: 'c1', name: 'Acme', emails: {} as any });
    d.prepare('INSERT INTO projects (id, customerId) VALUES (?, ?)').run('p1', 'c1');
    expect(() => deleteCustomer(d, 'c1')).toThrow(/project/i);
    d.prepare('UPDATE projects SET customerId = NULL WHERE id = ?').run('p1');
    expect(() => deleteCustomer(d, 'c1')).not.toThrow();
  });

  it('merges: moves projects, fills blank target fields, deletes sources', () => {
    saveCustomer(d, { id: 'target', name: 'Acme', emails: { accounting: { to: 'ap@acme.com' } } });
    saveCustomer(d, { id: 'dup', name: 'Acme Inc', phone: '999', emails: { general: { to: 'info@acme.com' }, accounting: { to: 'other@x.com' } } });
    d.prepare('INSERT INTO projects (id, customerId) VALUES (?, ?)').run('p1', 'dup');
    mergeCustomers(d, 'target', ['dup']);
    expect(getCustomer(d, 'dup')).toBeNull();
    expect(listProjectsForCustomer(d, 'target').map((p: any) => p.id)).toContain('p1');
    const t = getCustomer(d, 'target')!;
    expect(t.phone).toBe('999');
    expect(t.emails.accounting!.to).toBe('ap@acme.com');
    expect(t.emails.general!.to).toBe('info@acme.com');
  });
});

describe('customerSummaries / customerOverview', () => {
  let d: Database.Database;
  let cid: string;
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    d = db();
    const c = saveCustomer(d, { id: 'cust-1', name: 'Acme', contactName: 'Jo', phone: '555-1', emails: {} as any });
    cid = c.id;

    // bidding project with bidDueDate 10 days out
    d.prepare(`INSERT INTO projects (id, name, customerId, status, bidDueDate, version, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run('p-bid', 'Bid Project', cid, 'bidding', Date.now() + 10 * DAY, Date.now());

    // in_progress project with a sent, unpaid $100 invoice
    d.prepare(`INSERT INTO projects (id, name, customerId, status, version, createdAt) VALUES (?, ?, ?, ?, 1, ?)`)
      .run('p-prog', 'Active Project', cid, 'in_progress', Date.now());
    const inv = createInvoice(d, 'p-prog', { number: 'INV-1', date: Date.now(), lines: [{ description: 'Work', qty: 1, unitPrice: 100 }] });
    setInvoiceStatus(d, inv.id, 'sent');

    // archived project — also carries a sent, unpaid invoice, which must NOT
    // leak into outstanding totals / ledger / attention for non-archived rollups.
    d.prepare(`INSERT INTO projects (id, name, customerId, status, meta, version, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run('p-arch', 'Archived Project', cid, 'in_progress', JSON.stringify({ archived: true }), Date.now());
    const archInv = createInvoice(d, 'p-arch', { number: 'INV-ARCH', date: Date.now(), lines: [{ description: 'Old work', qty: 1, unitPrice: 50 }] });
    setInvoiceStatus(d, archInv.id, 'sent');

    // tasks: one overdue (yesterday, todo), one done (should not count as open)
    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    d.prepare(`INSERT INTO tasks (id, title, status, dueDate, customerId, version, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run('t-overdue', 'Call back', 'todo', yesterday, cid, Date.now());
    d.prepare(`INSERT INTO tasks (id, title, status, dueDate, customerId, version, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run('t-done', 'Finished', 'done', yesterday, cid, Date.now());
  });

  it('customerSummaries rolls up project counts, task counts, and outstanding cents (archived excluded)', () => {
    const rows = customerSummaries(d, true);
    const row = rows.find(r => r.id === cid)!;
    expect(row.projectCounts).toEqual({ bidding: 1, inProgress: 1, archived: 1 });
    expect(row.openTaskCount).toBe(1);
    expect(row.overdueTaskCount).toBe(1);
    expect(row.outstandingCents).toBe(10000); // only p-prog's $100 — archived $50 excluded
  });

  it('customerSummaries omits outstandingCents when includeBilling is false', () => {
    const rows = customerSummaries(d, false);
    const row = rows.find(r => r.id === cid)!;
    expect(row.outstandingCents).toBeUndefined();
  });

  it('overdue comparison crosses month boundaries correctly (not a same-month fluke)', () => {
    // 40 days always crosses at least one month boundary, whatever "today" is.
    const old = new Date(Date.now() - 40 * DAY).toISOString().slice(0, 10);
    d.prepare(`INSERT INTO tasks (id, title, status, dueDate, customerId, version, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run('t-old', 'Old overdue', 'todo', old, cid, Date.now());
    const row = customerSummaries(d, false).find(r => r.id === cid)!;
    expect(row.overdueTaskCount).toBe(2); // t-overdue (yesterday) + t-old (40 days ago)
  });

  it('customerOverview returns projects, billing ledger, attention, and task counts (admin)', () => {
    const ov = customerOverview(d, cid, true)!;
    expect(ov.customer.id).toBe(cid);
    expect(ov.projects.map((p: any) => p.id).sort()).toEqual(['p-arch', 'p-bid', 'p-prog']);
    expect(ov.taskCounts).toEqual({ open: 1, overdue: 1 });

    // billing rollup + ledger exclude the archived project's invoice
    expect(ov.billing.outstandingCents).toBe(10000);
    expect(ov.billing.ledger).toHaveLength(1);
    expect(ov.billing.ledger[0]).toMatchObject({ projectId: 'p-prog', kind: 'invoice', balanceCents: 10000 });

    const types = ov.attention.map((a: any) => a.type).sort();
    expect(types).toEqual(['bid_due', 'outstanding_invoice', 'overdue_task']);
    expect(ov.attention.find((a: any) => a.type === 'outstanding_invoice')!.projectId).toBe('p-prog');
  });

  it('customerOverview omits billing and money-attention for non-admin', () => {
    const ov = customerOverview(d, cid, false)!;
    expect(ov.billing).toBeUndefined();
    const types = ov.attention.map((a: any) => a.type);
    expect(types).not.toContain('outstanding_invoice');
    expect(types).toContain('overdue_task');
    expect(types).toContain('bid_due');
  });

  it('returns null for an unknown customer', () => {
    expect(customerOverview(d, 'nope', true)).toBeNull();
  });
});
