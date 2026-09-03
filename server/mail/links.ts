// server/mail/links.ts  (spec §3 mail_thread_links)
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Addr } from './providers/types';

export type ItemType = 'proposal' | 'invoice' | 'changeOrder' | 'payApp' | 'issue' | 'rfi' | 'dailyReport' | 'punch' | 'task' | 'project' | 'customer';
export interface LinkRow { id: string; threadKey: string; subjectSnapshot: string | null; firstDate: string | null; participantsJson: string; itemType: ItemType; itemId: string; projectId: string | null; customerId: string | null; linkedByUserId: string; createdAt: string }

const ITEM_TABLE: Partial<Record<ItemType, string>> = { proposal: 'proposals', invoice: 'invoices', changeOrder: 'change_orders', payApp: 'aia_pay_apps', issue: 'issues', rfi: 'rfis', dailyReport: 'daily_reports', task: 'tasks' };
const UNASSIGNED = 'customer-unassigned';

export function resolveChain(db: Database.Database, itemType: ItemType, itemId: string): { projectId: string | null; customerId: string | null } {
  let projectId: string | null = null; let customerId: string | null = null;
  if (itemType === 'customer') return { projectId: null, customerId: itemId };
  if (itemType === 'project' || itemType === 'punch') projectId = itemId;
  else if (itemType === 'task') {
    const t = db.prepare('SELECT projectId, customerId FROM tasks WHERE id = ?').get(itemId) as { projectId: string | null; customerId: string | null } | undefined;
    projectId = t?.projectId ?? null; customerId = t?.customerId ?? null;
  } else {
    // An itemType outside the map (a client typo that slipped past validation, or a
    // future type added to the union but not the map) must not interpolate `undefined`
    // into the SQL — it resolves to no chain at all.
    const table = ITEM_TABLE[itemType];
    if (!table) return { projectId: null, customerId: null };
    const r = db.prepare(`SELECT projectId FROM ${table} WHERE id = ?`).get(itemId) as { projectId: string } | undefined;
    projectId = r?.projectId ?? null;
  }
  if (projectId) {
    const p = db.prepare('SELECT customerId FROM projects WHERE id = ?').get(projectId) as { customerId: string | null } | undefined;
    if (!p) projectId = null; else if (p.customerId && p.customerId !== UNASSIGNED) customerId = customerId ?? p.customerId;
  }
  return { projectId, customerId };
}

// Capitalized fallback shown when the linked row is gone (deleted item) or the
// itemType has no resolver below — mirrors src/pages/mail/mailFormat.ts'
// ITEM_TYPE_LABELS, kept separate so server code doesn't reach into a client page.
const TYPE_FALLBACK: Record<ItemType, string> = {
  proposal: 'Proposal', invoice: 'Invoice', changeOrder: 'Change Order', payApp: 'Pay App',
  issue: 'Issue', rfi: 'RFI', dailyReport: 'Daily Report', punch: 'Punch', task: 'Task',
  project: 'Project', customer: 'Customer',
};

/** Human label for a linked item, in the app's own display conventions per
 *  type (RFI-012, ISS-004, CO-3, Invoice 104, Proposal #2, Pay App #1,
 *  project/customer name, task title, Daily Report <date>). A missing row
 *  (deleted item) or unmapped itemType falls back to the capitalized type name. */
export function resolveLinkLabel(db: Database.Database, itemType: ItemType, itemId: string): string {
  const fallback = TYPE_FALLBACK[itemType] ?? itemType;
  switch (itemType) {
    case 'proposal': {
      const r = db.prepare('SELECT number FROM proposals WHERE id = ?').get(itemId) as { number: number } | undefined;
      return r ? `Proposal #${r.number}` : fallback;
    }
    case 'invoice': {
      // InvoiceEditor's own modal title is `Invoice ${number}` (no #) — the
      // number is a free-text field the user sets, not an auto sequence.
      const r = db.prepare('SELECT number FROM invoices WHERE id = ?').get(itemId) as { number: string | null } | undefined;
      if (!r) return fallback;
      return r.number && r.number.trim() ? `Invoice ${r.number.trim()}` : fallback;
    }
    case 'changeOrder': {
      const r = db.prepare('SELECT number, title FROM change_orders WHERE id = ?').get(itemId) as { number: string | null; title: string | null } | undefined;
      if (!r) return fallback;
      const base = `CO-${r.number ?? '?'}`;
      return r.title && r.title.trim() ? `${base} — ${r.title.trim()}` : base;
    }
    case 'payApp': {
      const r = db.prepare('SELECT number FROM aia_pay_apps WHERE id = ?').get(itemId) as { number: number } | undefined;
      return r ? `Pay App #${r.number}` : fallback;
    }
    case 'issue': {
      const r = db.prepare('SELECT number, title FROM issues WHERE id = ?').get(itemId) as { number: number; title: string | null } | undefined;
      if (!r) return fallback;
      const base = `ISS-${String(r.number).padStart(3, '0')}`;
      return r.title && r.title.trim() ? `${base} — ${r.title.trim()}` : base;
    }
    case 'rfi': {
      const r = db.prepare('SELECT number, title FROM rfis WHERE id = ?').get(itemId) as { number: number; title: string | null } | undefined;
      if (!r) return fallback;
      const base = `RFI-${String(r.number).padStart(3, '0')}`;
      return r.title && r.title.trim() ? `${base} — ${r.title.trim()}` : base;
    }
    case 'dailyReport': {
      const r = db.prepare('SELECT reportDate FROM daily_reports WHERE id = ?').get(itemId) as { reportDate: string } | undefined;
      return r ? `Daily Report — ${r.reportDate}` : fallback;
    }
    case 'punch':
    case 'project': {
      const r = db.prepare('SELECT name FROM projects WHERE id = ?').get(itemId) as { name: string | null } | undefined;
      return r && r.name && r.name.trim() ? r.name.trim() : fallback;
    }
    case 'task': {
      const r = db.prepare('SELECT title FROM tasks WHERE id = ?').get(itemId) as { title: string | null } | undefined;
      return r && r.title && r.title.trim() ? r.title.trim() : fallback;
    }
    case 'customer': {
      const r = db.prepare('SELECT name FROM customers WHERE id = ?').get(itemId) as { name: string | null } | undefined;
      return r && r.name && r.name.trim() ? r.name.trim() : fallback;
    }
    default:
      return fallback;
  }
}

export function createLink(db: Database.Database, input: { threadKey: string; itemType: ItemType; itemId: string; linkedByUserId: string; subjectSnapshot?: string | null; firstDate?: string | null; participants?: Addr[] }): LinkRow {
  const existing = db.prepare('SELECT * FROM mail_thread_links WHERE threadKey = ? AND itemType = ? AND itemId = ?').get(input.threadKey, input.itemType, input.itemId) as LinkRow | undefined;
  if (existing) return existing;
  const chain = resolveChain(db, input.itemType, input.itemId);
  const id = uuidv4();
  db.prepare(`INSERT INTO mail_thread_links (id, threadKey, subjectSnapshot, firstDate, participantsJson, itemType, itemId, projectId, customerId, linkedByUserId, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, input.threadKey, input.subjectSnapshot ?? null, input.firstDate ?? null, JSON.stringify(input.participants ?? []), input.itemType, input.itemId, chain.projectId, chain.customerId, input.linkedByUserId, new Date().toISOString());
  return db.prepare('SELECT * FROM mail_thread_links WHERE id = ?').get(id) as LinkRow;
}
export function listLinksForItem(db: Database.Database, itemType: ItemType, itemId: string): LinkRow[] {
  return db.prepare('SELECT * FROM mail_thread_links WHERE itemType = ? AND itemId = ? ORDER BY createdAt').all(itemType, itemId) as LinkRow[];
}
export function listLinksForThread(db: Database.Database, threadKey: string): LinkRow[] {
  return db.prepare('SELECT * FROM mail_thread_links WHERE threadKey = ? ORDER BY createdAt').all(threadKey) as LinkRow[];
}
export function deleteLink(db: Database.Database, id: string): void { db.prepare('DELETE FROM mail_thread_links WHERE id = ?').run(id); }
