import type Database from 'better-sqlite3';
import type { Customer } from '../src/types';

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
      createdAt INTEGER,
      updatedAt INTEGER,
      attrs TEXT
    );
  `);
}

const rowToCustomer = (r: any): Customer => ({
  id: r.id, name: r.name, phone: r.phone ?? undefined, address: r.address ?? undefined,
  contactName: r.contactName ?? undefined, notes: r.notes ?? undefined,
  emails: { general: r.generalEmail ?? undefined, accounting: r.accountingEmail ?? undefined,
            estimating: r.estimatingEmail ?? undefined, pm: r.pmEmail ?? undefined },
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
  const e = c.emails || {};
  const exists = db.prepare('SELECT id FROM customers WHERE id = ?').get(c.id);
  if (exists) {
    db.prepare(`UPDATE customers SET name=?, phone=?, address=?, contactName=?, notes=?,
      generalEmail=?, accountingEmail=?, estimatingEmail=?, pmEmail=?, updatedAt=? WHERE id=?`)
      .run(c.name, c.phone ?? null, c.address ?? null, c.contactName ?? null, c.notes ?? null,
           e.general ?? null, e.accounting ?? null, e.estimating ?? null, e.pm ?? null, now, c.id);
  } else {
    db.prepare(`INSERT INTO customers (id,name,phone,address,contactName,notes,
      generalEmail,accountingEmail,estimatingEmail,pmEmail,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(c.id, c.name, c.phone ?? null, c.address ?? null, c.contactName ?? null, c.notes ?? null,
           e.general ?? null, e.accounting ?? null, e.estimating ?? null, e.pm ?? null, now, now);
  }
  return getCustomer(db, c.id)!;
}

export function deleteCustomer(db: Database.Database, id: string): void {
  if (id === 'customer-unassigned') throw new Error('The Unassigned customer cannot be deleted');
  const n = db.prepare('SELECT COUNT(*) n FROM projects WHERE customerId = ?').get(id) as { n: number };
  if (n.n > 0) throw new Error(`Customer still owns ${n.n} project(s); reassign or merge first`);
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
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
