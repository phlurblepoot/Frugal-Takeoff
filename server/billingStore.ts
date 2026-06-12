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

function paidCentsFor(db: Database.Database, invoiceId: string): number {
  const rows = db.prepare('SELECT amount FROM payments WHERE invoiceId = ?').all(invoiceId) as { amount: number }[];
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
  const paidCents = paidCentsFor(db, id);
  const payments = db.prepare('SELECT id, date, amount, method, note FROM payments WHERE invoiceId = ? ORDER BY date').all(id);
  return { ...row, lines, payments, totalCents, paidCents, balanceCents: totalCents - paidCents };
}

export function listInvoices(db: Database.Database, projectId: string): any[] {
  const rows = db.prepare('SELECT * FROM invoices WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC').all(projectId) as any[];
  return rows.map(r => {
    const totalCents = lineTotalsCents(db, r.id);
    const paidCents = paidCentsFor(db, r.id);
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
    db.prepare('DELETE FROM payments WHERE invoiceId = ?').run(id);
    db.prepare('DELETE FROM invoice_lines WHERE invoiceId = ?').run(id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  });
  tx();
}

interface PaymentInput { date?: number | null; amount?: number; method?: string; note?: string; }

export function recordPayment(db: Database.Database, invoiceId: string, input: PaymentInput): { id: string } {
  const inv = db.prepare('SELECT id FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv) throw new NotFoundError('Invoice not found');
  if (typeof input.amount !== 'number' || !(input.amount > 0)) throw new ValidationError('Payment amount must be a positive number');
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO payments (id, invoiceId, date, amount, method, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, invoiceId, input.date ?? Date.now(), input.amount, input.method ?? null, input.note ?? null, Date.now());
  return { id };
}

export function deletePayment(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM payments WHERE id = ?').run(id);
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
