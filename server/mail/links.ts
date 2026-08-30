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
