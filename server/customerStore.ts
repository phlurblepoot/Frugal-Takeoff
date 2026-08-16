import type Database from 'better-sqlite3';
import type { Customer, CustomerRoleEmails } from '../src/types';
import { billingSummary, listInvoices, paidCentsFor } from './billingStore';
import { listPayApps, computeG702 } from './aiaStore';
import { normalizeProjectStatus } from './projectStore';

export function createCustomerTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      contactName TEXT,
      notes TEXT,
      generalEmail TEXT,
      accountingEmail TEXT,
      estimatingEmail TEXT,
      pmEmail TEXT,
      emails TEXT,
      createdAt INTEGER,
      updatedAt INTEGER,
      attrs TEXT
    );
  `);
}

function buildEmailsFromLegacy(r: any): CustomerRoleEmails {
  const emails: CustomerRoleEmails = {};
  if (r.generalEmail) emails.general = { to: r.generalEmail };
  if (r.accountingEmail) emails.accounting = { to: r.accountingEmail };
  if (r.estimatingEmail) emails.estimating = { to: r.estimatingEmail };
  if (r.pmEmail) emails.pm = { to: r.pmEmail };
  return emails;
}

const rowToCustomer = (r: any): Customer => ({
  id: r.id, name: r.name, phone: r.phone ?? undefined, address: r.address ?? undefined,
  contactName: r.contactName ?? undefined, notes: r.notes ?? undefined,
  emails: r.emails ? (JSON.parse(r.emails) as CustomerRoleEmails) : buildEmailsFromLegacy(r),
  createdAt: r.createdAt ?? undefined, updatedAt: r.updatedAt ?? undefined,
  ...(r.attrs ? JSON.parse(r.attrs) : {}),
});

export function listCustomers(db: Database.Database): Customer[] {
  return (db.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE').all() as any[]).map(rowToCustomer);
}
export function getCustomer(db: Database.Database, id: string): Customer | null {
  const r = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as any;
  return r ? rowToCustomer(r) : null;
}
export function listProjectsForCustomer(db: Database.Database, id: string): any[] {
  return db.prepare('SELECT * FROM projects WHERE customerId = ? ORDER BY createdAt DESC').all(id) as any[];
}

export function saveCustomer(db: Database.Database, c: Customer): Customer {
  const now = Date.now();
  const emailsJson = JSON.stringify(c.emails || {});
  const exists = db.prepare('SELECT id FROM customers WHERE id = ?').get(c.id);
  if (exists) {
    db.prepare(`UPDATE customers SET name=?, phone=?, address=?, contactName=?, notes=?,
      emails=?, updatedAt=? WHERE id=?`)
      .run(c.name, c.phone ?? null, c.address ?? null, c.contactName ?? null, c.notes ?? null,
           emailsJson, now, c.id);
  } else {
    db.prepare(`INSERT INTO customers (id,name,phone,address,contactName,notes,
      emails,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(c.id, c.name, c.phone ?? null, c.address ?? null, c.contactName ?? null, c.notes ?? null,
           emailsJson, now, now);
  }
  return getCustomer(db, c.id)!;
}

export function deleteCustomer(db: Database.Database, id: string): void {
  if (id === 'customer-unassigned') throw new Error('The Unassigned customer cannot be deleted');
  const n = db.prepare('SELECT COUNT(*) n FROM projects WHERE customerId = ?').get(id) as { n: number };
  if (n.n > 0) throw new Error(`Customer still owns ${n.n} project(s); reassign or merge first`);
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
}

// YYYY-MM-DD for today in local time — comparable lexicographically against
// tasks.dueDate / project bidDueDate-derived strings without a Date parse.
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / 86400000));
}

interface ProjectRollupRow {
  id: string; name: string | null; status: string | null; contractor: string | null;
  bidDueDate: number | null; updatedAt: number | null; archived: number; lostBid: number;
}

function projectRowsForCustomer(db: Database.Database, customerId: string): ProjectRollupRow[] {
  return db.prepare(`
    SELECT id, name, status, contractor, bidDueDate, updatedAt,
           COALESCE(json_extract(meta, '$.archived'), 0) AS archived,
           COALESCE(json_extract(meta, '$.lostBid'), 0) AS lostBid
    FROM projects WHERE customerId = ?
  `).all(customerId) as ProjectRollupRow[];
}

// Rollup counts + open/overdue task counts for every customer. outstandingCents
// (admin-only) sums billingSummary(...).outstandingCents over each customer's
// NON-archived projects.
export function customerSummaries(db: Database.Database, includeBilling: boolean): any[] {
  const customers = listCustomers(db);
  const today = todayStr();

  const projRows = db.prepare(`
    SELECT id, customerId, status, COALESCE(json_extract(meta, '$.archived'), 0) AS archived
    FROM projects WHERE customerId IS NOT NULL
  `).all() as { id: string; customerId: string; status: string | null; archived: number }[];
  const projectsByCustomer = new Map<string, typeof projRows>();
  for (const r of projRows) {
    if (!projectsByCustomer.has(r.customerId)) projectsByCustomer.set(r.customerId, []);
    projectsByCustomer.get(r.customerId)!.push(r);
  }

  const taskRows = db.prepare(`
    SELECT customerId, status, dueDate FROM tasks WHERE customerId IS NOT NULL
  `).all() as { customerId: string; status: string; dueDate: string | null }[];
  const tasksByCustomer = new Map<string, typeof taskRows>();
  for (const t of taskRows) {
    if (!tasksByCustomer.has(t.customerId)) tasksByCustomer.set(t.customerId, []);
    tasksByCustomer.get(t.customerId)!.push(t);
  }

  return customers.map(c => {
    const projects = projectsByCustomer.get(c.id) ?? [];
    const projectCounts = { bidding: 0, inProgress: 0, archived: 0 };
    for (const p of projects) {
      if (Number(p.archived)) { projectCounts.archived++; continue; }
      if (normalizeProjectStatus(p.status) === 'bidding') projectCounts.bidding++;
      else projectCounts.inProgress++;
    }

    const tasks = tasksByCustomer.get(c.id) ?? [];
    let openTaskCount = 0;
    let overdueTaskCount = 0;
    for (const t of tasks) {
      if (t.status === 'done') continue;
      openTaskCount++;
      if (t.dueDate && t.dueDate < today) overdueTaskCount++;
    }

    const row: any = {
      id: c.id, name: c.name, contactName: c.contactName ?? null, phone: c.phone ?? null,
      projectCounts, openTaskCount, overdueTaskCount,
    };
    if (includeBilling) {
      row.outstandingCents = projects
        .filter(p => !Number(p.archived))
        .reduce((sum, p) => sum + billingSummary(db, p.id).outstandingCents, 0);
    }
    return row;
  });
}

// Single-customer detail: project list (with per-project outstandingCents when
// admin), a billing ledger (admin-only, invoices + finalized AIA pay apps with
// balanceCents > 0), and an "attention" feed (overdue tasks always; upcoming
// bid-due dates and outstanding invoices/pay-apps admin-only for the money bits).
export function customerOverview(db: Database.Database, customerId: string, includeBilling: boolean): any | null {
  const customer = getCustomer(db, customerId);
  if (!customer) return null;

  const now = Date.now();
  const today = todayStr();
  const projRows = projectRowsForCustomer(db, customerId);
  const projNameById = new Map(projRows.map(p => [p.id, p.name ?? 'Untitled']));

  const projects = projRows.map(p => {
    const out: any = {
      id: p.id, name: p.name ?? 'Untitled', status: normalizeProjectStatus(p.status),
      archived: !!Number(p.archived), lostBid: !!Number(p.lostBid),
      bidDueDate: p.bidDueDate ?? null, updatedAt: p.updatedAt ?? null,
    };
    if (includeBilling) out.outstandingCents = billingSummary(db, p.id).outstandingCents;
    return out;
  });

  const attention: any[] = [];

  const taskRows = db.prepare(`
    SELECT id, title, status, dueDate, projectId FROM tasks WHERE customerId = ?
  `).all(customerId) as { id: string; title: string; status: string; dueDate: string | null; projectId: string | null }[];
  let openTaskCount = 0;
  let overdueTaskCount = 0;
  for (const t of taskRows) {
    if (t.status === 'done') continue;
    openTaskCount++;
    if (t.dueDate && t.dueDate < today) {
      overdueTaskCount++;
      attention.push({
        type: 'overdue_task',
        label: t.title,
        projectId: t.projectId ?? undefined,
        taskId: t.id,
        date: t.dueDate,
      });
    }
  }

  // Bidding projects with a bidDueDate in the next 14 days (archived excluded).
  const in14Days = now + 14 * 86400000;
  for (const p of projRows) {
    if (Number(p.archived)) continue;
    if (normalizeProjectStatus(p.status) !== 'bidding') continue;
    if (p.bidDueDate == null) continue;
    if (p.bidDueDate >= now && p.bidDueDate <= in14Days) {
      attention.push({ type: 'bid_due', label: p.name ?? 'Untitled', projectId: p.id, date: p.bidDueDate });
    }
  }

  let billing: any = undefined;
  if (includeBilling) {
    let contractTotalCents = 0, invoicedCents = 0, paidCents = 0, outstandingCents = 0;
    const ledger: any[] = [];
    const activeProjects = projRows.filter(p => !Number(p.archived));

    for (const p of activeProjects) {
      const bs = billingSummary(db, p.id);
      contractTotalCents += bs.contractTotalCents;
      invoicedCents += bs.invoicedCents;
      paidCents += bs.paid.invoicesCents + bs.paid.payAppsCents;
      outstandingCents += bs.outstandingCents;
      const projectName = projNameById.get(p.id) ?? 'Untitled';

      for (const inv of listInvoices(db, p.id)) {
        if (inv.status !== 'sent') continue;
        ledger.push({
          projectId: p.id, projectName, kind: 'invoice',
          number: inv.number, date: inv.date, status: inv.status,
          totalCents: inv.totalCents, paidCents: inv.paidCents, balanceCents: inv.balanceCents,
        });
        if (inv.balanceCents > 0) {
          attention.push({
            type: 'outstanding_invoice',
            label: `Invoice #${inv.number ?? ''} — ${projectName}`,
            projectId: p.id,
            date: inv.date ?? undefined,
            ageDays: inv.date ? daysBetween(inv.date, now) : undefined,
            balanceCents: inv.balanceCents,
          });
        }
      }

      // Pay apps: 'finalized' is the pay-app analog of an invoice's 'sent' —
      // 'draft' apps aren't billed yet. Balance = this app's current-payment-due
      // (G702 L8) minus payments recorded against it — both cheap, already-exported
      // aiaStore/billingStore reads (no new aggregate needed).
      for (const app of listPayApps(db, p.id)) {
        if (app.status !== 'finalized') continue;
        const g702 = computeG702(db, app.id);
        const totalCents = g702.L8currentPaymentDueCents;
        const appPaidCents = paidCentsFor(db, 'payapp', app.id);
        const balanceCents = totalCents - appPaidCents;
        ledger.push({
          projectId: p.id, projectName, kind: 'payapp',
          number: app.number, date: app.applicationDate, status: app.status,
          totalCents, paidCents: appPaidCents, balanceCents,
        });
        if (balanceCents > 0) {
          attention.push({
            type: 'outstanding_invoice',
            label: `Application #${app.number} — ${projectName}`,
            projectId: p.id,
            date: app.applicationDate ?? undefined,
            balanceCents,
          });
        }
      }
    }

    billing = { contractTotalCents, invoicedCents, paidCents, outstandingCents, ledger };
  }

  return {
    customer, projects, billing, attention,
    taskCounts: { open: openTaskCount, overdue: overdueTaskCount },
  };
}

export function mergeCustomers(db: Database.Database, targetId: string, sourceIds: string[]): void {
  const target = getCustomer(db, targetId);
  if (!target) throw new Error('Target customer not found');
  const tx = db.transaction(() => {
    for (const sid of sourceIds) {
      if (sid === targetId) continue;
      const src = getCustomer(db, sid);
      if (!src) continue;
      const merged: Customer = { ...target };
      for (const k of ['phone', 'address', 'contactName', 'notes'] as const)
        if (!merged[k] && src[k]) (merged as any)[k] = src[k];
      merged.emails = { ...target.emails };
      for (const k of ['general', 'accounting', 'estimating', 'pm'] as const)
        if (!merged.emails[k] && src.emails[k]) merged.emails[k] = src.emails[k];
      saveCustomer(db, merged);
      Object.assign(target, merged);
      db.prepare('UPDATE projects SET customerId = ? WHERE customerId = ?').run(targetId, sid);
      db.prepare('DELETE FROM customers WHERE id = ?').run(sid);
    }
  });
  tx();
}
