import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createCustomerTables, listCustomers, getCustomer, saveCustomer, deleteCustomer, mergeCustomers, listProjectsForCustomer } from './customerStore';

function db() {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, contractor TEXT, customerId TEXT, meta TEXT, createdAt INTEGER, updatedAt INTEGER, version INTEGER, status TEXT);`);
  createCustomerTables(d);
  return d;
}

describe('customerStore', () => {
  let d: Database.Database;
  beforeEach(() => { d = db(); });

  it('creates, reads, updates, lists', () => {
    saveCustomer(d, { id: 'c1', name: 'Acme', phone: '555', emails: { accounting: 'ap@acme.com', estimating: 'est@acme.com' } });
    const c = getCustomer(d, 'c1');
    expect(c!.name).toBe('Acme');
    expect(c!.emails.accounting).toBe('ap@acme.com');
    saveCustomer(d, { id: 'c1', name: 'Acme LLC', emails: { general: 'info@acme.com' } });
    expect(getCustomer(d, 'c1')!.name).toBe('Acme LLC');
    expect(listCustomers(d).length).toBe(1);
  });

  it('blocks deleting a customer that still owns projects', () => {
    saveCustomer(d, { id: 'c1', name: 'Acme', emails: {} });
    d.prepare('INSERT INTO projects (id, customerId) VALUES (?, ?)').run('p1', 'c1');
    expect(() => deleteCustomer(d, 'c1')).toThrow(/project/i);
    d.prepare('UPDATE projects SET customerId = NULL WHERE id = ?').run('p1');
    expect(() => deleteCustomer(d, 'c1')).not.toThrow();
  });

  it('merges: moves projects, fills blank target fields, deletes sources', () => {
    saveCustomer(d, { id: 'target', name: 'Acme', emails: { accounting: 'ap@acme.com' } });
    saveCustomer(d, { id: 'dup', name: 'Acme Inc', phone: '999', emails: { general: 'info@acme.com', accounting: 'other@x.com' } });
    d.prepare('INSERT INTO projects (id, customerId) VALUES (?, ?)').run('p1', 'dup');
    mergeCustomers(d, 'target', ['dup']);
    expect(getCustomer(d, 'dup')).toBeNull();
    expect(listProjectsForCustomer(d, 'target').map((p: any) => p.id)).toContain('p1');
    const t = getCustomer(d, 'target')!;
    expect(t.phone).toBe('999');
    expect(t.emails.accounting).toBe('ap@acme.com');
    expect(t.emails.general).toBe('info@acme.com');
  });
});
