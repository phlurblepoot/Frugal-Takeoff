// server/billingStore.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export const INVOICE_STATUSES = ['draft', 'sent', 'paid'] as const;
export const CHANGE_ORDER_STATUSES = ['pending', 'approved', 'rejected'] as const;

// All money math is integer cents. Dollars are rounded to the nearest cent
// (half-up) BEFORE summing, so float artefacts (0.1+0.2) never accumulate.
export function toCents(dollars: number): number {
  return Math.round((Number(dollars) || 0) * 100);
}
export function sumCents(lines: { qty: number; unitPrice: number }[]): number {
  return lines.reduce((acc, l) => acc + toCents((Number(l.qty) || 0) * (Number(l.unitPrice) || 0)), 0);
}

function requireProject(db: Database.Database, projectId: string): void {
  const row = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!row) throw new NotFoundError('Project not found');
}

interface LineInput { description?: string; qty?: number; unitPrice?: number; }
interface InvoiceInput { number?: string; date?: number | null; terms?: string; status?: string; lines?: LineInput[]; }

function validateLines(lines: any): LineInput[] {
  if (lines === undefined) return [];
  if (!Array.isArray(lines)) throw new ValidationError('lines must be an array');
  for (const l of lines) {
    if (!l || typeof l !== 'object') throw new ValidationError('each line must be an object');
    if (l.qty !== undefined && (!Number.isFinite(l.qty) || l.qty < 0)) throw new ValidationError('line qty must be a non-negative number');
    if (l.unitPrice !== undefined && (!Number.isFinite(l.unitPrice) || l.unitPrice < 0)) throw new ValidationError('line unitPrice must be a non-negative number');
  }
  return lines;
}

export const PAYMENT_TARGET_TYPES = ['invoice', 'payapp'] as const;
export type PaymentTargetType = (typeof PAYMENT_TARGET_TYPES)[number];

export function paidCentsFor(db: Database.Database, targetType: PaymentTargetType, targetId: string): number {
  const rows = db.prepare('SELECT amount FROM payments WHERE targetType = ? AND targetId = ?').all(targetType, targetId) as { amount: number }[];
  return rows.reduce((acc, p) => acc + toCents(p.amount), 0);
}

function lineTotalsCents(db: Database.Database, invoiceId: string): number {
  const lines = db.prepare('SELECT qty, unitPrice FROM invoice_lines WHERE invoiceId = ?').all(invoiceId) as any[];
  return sumCents(lines);
}

function writeLines(db: Database.Database, invoiceId: string, lines: LineInput[]): void {
  db.prepare('DELETE FROM invoice_lines WHERE invoiceId = ?').run(invoiceId);
  const ins = db.prepare('INSERT INTO invoice_lines (id, invoiceId, description, qty, unitPrice, sortOrder) VALUES (?, ?, ?, ?, ?, ?)');
  lines.forEach((l, i) => ins.run(crypto.randomUUID(), invoiceId, l.description ?? '', Number(l.qty) || 0, Number(l.unitPrice) || 0, i));
}

export function getInvoice(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as any;
  if (!row) return null;
  const lines = db.prepare('SELECT id, description, qty, unitPrice, sortOrder FROM invoice_lines WHERE invoiceId = ? ORDER BY sortOrder').all(id);
  const totalCents = lineTotalsCents(db, id);
  const paidCents = paidCentsFor(db, 'invoice', id);
  const payments = db.prepare("SELECT id, date, amount, method, note FROM payments WHERE targetType = 'invoice' AND targetId = ? ORDER BY date").all(id);
  return { ...row, lines, payments, totalCents, paidCents, balanceCents: totalCents - paidCents };
}

export function listInvoices(db: Database.Database, projectId: string): any[] {
  const rows = db.prepare('SELECT * FROM invoices WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC').all(projectId) as any[];
  return rows.map(r => {
    const totalCents = lineTotalsCents(db, r.id);
    const paidCents = paidCentsFor(db, 'invoice', r.id);
    return { ...r, totalCents, paidCents, balanceCents: totalCents - paidCents };
  });
}

export function createInvoice(db: Database.Database, projectId: string, input: InvoiceInput): { id: string; version: number } {
  requireProject(db, projectId);
  const lines = validateLines(input.lines);
  if (input.status !== undefined && !(INVOICE_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError(`Invalid invoice status: ${input.status}`);
  }
  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO invoices (id, projectId, number, date, status, terms, version, createdAt) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .run(id, projectId, input.number ?? null, input.date ?? null, input.status ?? 'draft', input.terms ?? null, Date.now());
    writeLines(db, id, lines);
  });
  tx();
  return { id, version: 1 };
}

export function saveInvoice(db: Database.Database, id: string, input: InvoiceInput & { version?: number }): { version: number } {
  const lines = validateLines(input.lines);
  if (!Number.isInteger(input.version) || (input.version as number) < 1) {
    throw new ValidationError('Missing or invalid version — reload the invoice');
  }
  if (input.status !== undefined && !(INVOICE_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError(`Invalid invoice status: ${input.status}`);
  }
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM invoices WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('Invoice not found');
    if (row.version !== input.version) throw new ConflictError(`Invoice changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;
    db.prepare('UPDATE invoices SET number = ?, date = ?, status = ?, terms = ?, version = ? WHERE id = ?')
      .run(input.number ?? null, input.date ?? null, input.status ?? 'draft', input.terms ?? null, newVersion, id);
    writeLines(db, id, lines);
  });
  tx();
  return { version: newVersion };
}

export function deleteInvoice(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM payments WHERE targetType = 'invoice' AND targetId = ?").run(id);
    db.prepare('DELETE FROM invoice_lines WHERE invoiceId = ?').run(id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  });
  tx();
}

interface PaymentInput { date?: number | null; amount?: number; method?: string; note?: string; }

// A payment targets an invoice OR an AIA pay application (polymorphic, migration 13).
export function recordPayment(db: Database.Database, targetType: string, targetId: string, input: PaymentInput): { id: string } {
  if (!(PAYMENT_TARGET_TYPES as readonly string[]).includes(targetType)) {
    throw new ValidationError(`Invalid payment target type: ${targetType}`);
  }
  const table = targetType === 'invoice' ? 'invoices' : 'aia_pay_apps';
  const target = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(targetId);
  if (!target) throw new NotFoundError(targetType === 'invoice' ? 'Invoice not found' : 'Pay application not found');
  if (!Number.isFinite(input.amount) || (input.amount as number) <= 0) throw new ValidationError('Payment amount must be a positive number');
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO payments (id, targetType, targetId, date, amount, method, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, targetType, targetId, input.date ?? Date.now(), input.amount, input.method ?? null, input.note ?? null, Date.now());
  return { id };
}

export function deletePayment(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM payments WHERE id = ?').run(id);
}

// All payments across a project's invoices AND pay applications, with a resolved
// human label per target. Money fields are passed through (amount REAL dollars).
export function listProjectPayments(db: Database.Database, projectId: string): any[] {
  return db.prepare(`
    SELECT p.id, p.targetType, p.targetId, p.date, p.amount, p.method, p.note, p.createdAt,
           CASE
             WHEN p.targetType = 'invoice' THEN
               CASE WHEN i.number IS NOT NULL AND i.number <> '' THEN 'Invoice ' || i.number ELSE 'Invoice' END
             WHEN p.targetType = 'payapp' THEN 'Application #' || a.number
             ELSE NULL
           END AS targetLabel
    FROM payments p
    LEFT JOIN invoices i ON p.targetType = 'invoice' AND p.targetId = i.id
    LEFT JOIN aia_pay_apps a ON p.targetType = 'payapp' AND p.targetId = a.id
    WHERE (p.targetType = 'invoice' AND p.targetId IN (SELECT id FROM invoices WHERE projectId = ?))
       OR (p.targetType = 'payapp' AND p.targetId IN (SELECT id FROM aia_pay_apps WHERE projectId = ?))
    ORDER BY p.date DESC, p.createdAt DESC, p.rowid DESC
  `).all(projectId, projectId) as any[];
}

// Status-only change (draft→sent→paid or back). Version-checked like saveInvoice
// but leaves lines untouched.
export function setInvoiceStatus(db: Database.Database, id: string, status: string): { version: number; status: string } {
  if (!(INVOICE_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Invalid invoice status: ${status}`);
  let out = { version: 0, status };
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM invoices WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('Invoice not found');
    const newVersion = row.version + 1;
    db.prepare('UPDATE invoices SET status = ?, version = ? WHERE id = ?').run(status, newVersion, id);
    out = { version: newVersion, status };
  });
  tx();
  return out;
}

interface ChangeOrderInput { number?: string; description?: string; amount?: number; status?: string; }

export function listChangeOrders(db: Database.Database, projectId: string): any[] {
  return db.prepare('SELECT * FROM change_orders WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC').all(projectId) as any[];
}

export function createChangeOrder(db: Database.Database, projectId: string, input: ChangeOrderInput): { id: string } {
  requireProject(db, projectId);
  if (input.amount !== undefined && !Number.isFinite(input.amount)) throw new ValidationError('amount must be a finite number');
  if (input.status !== undefined && !(CHANGE_ORDER_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError(`Invalid change order status: ${input.status}`);
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO change_orders (id, projectId, number, description, amount, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, projectId, input.number ?? null, input.description ?? null, Number(input.amount) || 0, input.status ?? 'pending', Date.now());
  return { id };
}

export function setChangeOrderStatus(db: Database.Database, id: string, status: string): { status: string } {
  if (!(CHANGE_ORDER_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Invalid change order status: ${status}`);
  const row = db.prepare('SELECT id FROM change_orders WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('Change order not found');
  db.prepare('UPDATE change_orders SET status = ? WHERE id = ?').run(status, id);
  return { status };
}

export function deleteChangeOrder(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM change_orders WHERE id = ?').run(id);
}

// Contract rollup + invoice aggregates for a project (spec §4.1). All cents.
//
// CONTRACT TOTAL = baseContractCents + approvedChangeCents, where the base is
// the AIA Schedule of Values original lines (isChangeOrder=0) when an SOV
// exists, else the legacy projects.contractValue. Approved change orders are
// added ONCE via change_orders — the CO SOV lines (isChangeOrder=1) are NOT
// summed into the base, so there is no double-count.
export function billingSummary(db: Database.Database, projectId: string): {
  sovOriginalCents: number; hasSov: boolean;
  baseContractCents: number; approvedChangeCents: number;
  contractTotalCents: number; contractValueCents: number;
  invoiceTotalCents: number; invoicedCents: number;
  paid: { invoicesCents: number; payAppsCents: number };
  paidCents: number;
  invoiceOutstandingCents: number; outstandingCents: number;
  invoiceCount: number; changeOrderCount: number;
} {
  const proj = db.prepare('SELECT contractValue FROM projects WHERE id = ?').get(projectId) as { contractValue: number | null } | undefined;

  // SOV original (non-CO) lines drive the base when an SOV exists.
  const sovOriginalCents = (db.prepare(
    'SELECT COALESCE(SUM(scheduledValueCents), 0) v FROM aia_sov_lines WHERE projectId = ? AND isChangeOrder = 0'
  ).get(projectId) as { v: number }).v;
  const sovCount = (db.prepare('SELECT COUNT(*) c FROM aia_sov_lines WHERE projectId = ?').get(projectId) as { c: number }).c;
  const hasSov = sovCount > 0;
  const baseContractCents = hasSov ? sovOriginalCents : toCents(proj?.contractValue ?? 0);

  const approvedRows = db.prepare(`SELECT amount FROM change_orders WHERE projectId = ? AND status = 'approved'`).all(projectId) as { amount: number }[];
  const approvedChangeCents = approvedRows.reduce((a, r) => a + toCents(r.amount), 0);
  const contractTotalCents = baseContractCents + approvedChangeCents;

  const invoices = listInvoices(db, projectId);
  const invoiceTotalCents = invoices.reduce((a, i) => a + i.totalCents, 0);
  const changeOrderCount = (db.prepare('SELECT COUNT(*) c FROM change_orders WHERE projectId = ?').get(projectId) as any).c;

  // Paid splits: payments scoped to this project's invoices vs its pay-apps.
  // amount is REAL dollars, so each row is rounded to cents before summing.
  const invoicePayments = db.prepare(
    `SELECT amount FROM payments WHERE targetType = 'invoice' AND targetId IN (SELECT id FROM invoices WHERE projectId = ?)`
  ).all(projectId) as { amount: number }[];
  const payAppPayments = db.prepare(
    `SELECT amount FROM payments WHERE targetType = 'payapp' AND targetId IN (SELECT id FROM aia_pay_apps WHERE projectId = ?)`
  ).all(projectId) as { amount: number }[];
  const paid = {
    invoicesCents: invoicePayments.reduce((a, p) => a + toCents(p.amount), 0),
    payAppsCents: payAppPayments.reduce((a, p) => a + toCents(p.amount), 0),
  };

  const invoiceOutstandingCents = invoiceTotalCents - paid.invoicesCents;

  return {
    sovOriginalCents,
    hasSov,
    baseContractCents,
    approvedChangeCents,
    contractTotalCents,
    contractValueCents: contractTotalCents, // back-compat (SOV-derived total)
    invoiceTotalCents,
    invoicedCents: invoiceTotalCents, // back-compat
    paid,
    paidCents: paid.invoicesCents, // back-compat (payments against invoices)
    invoiceOutstandingCents,
    outstandingCents: invoiceOutstandingCents, // back-compat
    invoiceCount: invoices.length,
    changeOrderCount,
  };
}
