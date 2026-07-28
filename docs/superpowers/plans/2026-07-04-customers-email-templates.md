# Customers Entity + Email Template Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Customer` a first-class entity that owns projects (contact + role emails), with merge and a supervised migration, then route template emails by role, add a per-user always-CC, and a header-email "From" dropdown — while mail always sends via the user's own SMTP.

**Architecture:** Phase A adds the `customers` table, a `customerStore`, REST routes, migration 16 (link projects; blanks → an "Unassigned" customer), and the Customer management UI. Phase B adds a pure recipient-resolution helper, per-user always-CC, and a header-email override wired into the `EmailComposer` and the five send sites/generators. `customerId` is a real indexed column; project-level role-email overrides (`contactEmails`) ride in the project `meta` JSON.

**Tech Stack:** Node/Express + better-sqlite3 (versioned auto-migrations), React 19 + Vite, Vitest, jsPDF generators, nodemailer per-user SMTP.

**Reference reading:**
- Spec: `docs/superpowers/specs/2026-07-04-customers-email-templates-design.md`
- Migration shape: `server/migrationList.ts` (see version 14/15), applied by `server/migrations.ts` with pre-backup.
- Store pattern: `server/projectStore.ts` (decompose/load; `loadProject` merges `row.meta`), `server/billingStore.ts` / `server/issueStore.ts` + their `*.test.ts` (in-memory db).
- Routes: `server/routes.ts` `registerDataRoutes({ db, dataDir, authenticateToken, requireAdmin, ... })`; wired in `server.ts`.
- Client store: `src/utils/store.ts`. Composer: `src/components/EmailComposer.tsx`. A send site: `src/pages/project/ProjectProposal.tsx` (EmailComposer usage ~line 615).
- Company contact settings: `companyName/companyPhone/companyEmail/companyAddress` (Settings.tsx); letterhead `company.email` (proposalGenerator.ts ~611).

**Conventions:** `npm test` = `vitest run`; colocated `*.test.ts`. Push to `testing` only; no PRs unless asked. Migration 16 is SUPERVISED — implement + test on testing; do NOT run against production data without Nathan watching.

---

## File Structure

**Phase A:**
- `src/types.ts` — MODIFY: `Customer`, `CustomerRoleEmails`; `Project.customerId`, `Project.contactEmails`.
- `server/customerStore.ts` — NEW: CRUD, merge, list-projects-for-customer.
- `server/customerStore.test.ts` — NEW.
- `server/migrationList.ts` — MODIFY: migration 16.
- `server/migrationList.test.ts` (or a dedicated `server/customerMigration.test.ts`) — NEW fixtures.
- `server/projectStore.ts` — MODIFY: decompose/load `customerId`.
- `server/projectStore.test.ts` — MODIFY: assert `customerId` round-trips.
- `server/routes.ts` — MODIFY: customer routes.
- `server/routes.test.ts` — MODIFY: smoke the customer routes (or test the store directly).
- `src/utils/store.ts` — MODIFY: client customer API helpers.
- `src/utils/recipients.ts` + `.test.ts` — NEW: pure role/resolution helpers (used in Phase B; created here since it's model-level).
- `src/pages/CustomersPage.tsx`, `src/pages/CustomerDetail.tsx` — NEW: management UI.
- `src/App.tsx`, nav component — MODIFY: route + nav entry.
- `src/pages/NewProject.tsx`, project Settings — MODIFY: Customer picker + overrides.

**Phase B:**
- `src/components/EmailComposer.tsx` — MODIFY: `defaultCc`, header-email dropdown.
- `src/pages/Settings.tsx` — MODIFY: Email tab "Always CC" field.
- `src/utils/store.ts` — MODIFY: always-CC pref get/set (if not via existing prefs).
- The five send sites — MODIFY: `defaultTo` via `resolveRecipient`, `defaultCc`, header-email regeneration:
  `ProjectProposal.tsx`, `billing/InvoiceEditor.tsx` (or its send path), `billing/ChangeOrderEditor.tsx`, `issues/IssueEditor.tsx`, `punch/*` send.
- The five generators — MODIFY: accept a `headerEmail` override for `company.email`.

---

# PHASE A — Customer entity

## Task A1: Types

**Files:** Modify `src/types.ts`

- [ ] **Step 1: Add the types**

```ts
export interface CustomerRoleEmails {
  general?: string;
  accounting?: string;
  estimating?: string;
  pm?: string;
}

export interface Customer {
  id: string;
  name: string;
  phone?: string;
  address?: string;
  contactName?: string;
  notes?: string;
  emails: CustomerRoleEmails;
  createdAt?: number;
  updatedAt?: number;
}
```

Add to `Project` (near `contractor?`):
```ts
  customerId?: string;
  /** Optional project-specific role-email overrides (rides in project meta). */
  contactEmails?: CustomerRoleEmails;
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit` → no errors.
- [ ] **Step 3: Commit** — `git commit -m "feat(customers): types"`

---

## Task A2: Customer store

**Files:** Create `server/customerStore.ts`, `server/customerStore.test.ts`

**Context:** Mirror `issueStore`/`billingStore`. Store role emails as columns
(`generalEmail` etc.); round-trip unknown fields via an `attrs` JSON column.
Assume the `customers` table + `projects.customerId` exist (migration 16 creates
them; tests create them inline via a helper).

- [ ] **Step 1: Write the failing tests**

```ts
// server/customerStore.test.ts
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
    expect(t.phone).toBe('999');                 // blank target field filled from source
    expect(t.emails.accounting).toBe('ap@acme.com'); // non-blank target kept
    expect(t.emails.general).toBe('info@acme.com');  // blank target role filled
  });
});
```

- [ ] **Step 2: Run — fails** (`npx vitest run server/customerStore.test.ts`).

- [ ] **Step 3: Implement `server/customerStore.ts`**

```ts
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
      // Fill blank target scalar fields + role emails from the source.
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
```

- [ ] **Step 4: Run — passes.** **Step 5: Commit** `feat(customers): store with CRUD + merge`.

---

## Task A3: Migration 16 — `customers-from-contractor` (SUPERVISED)

**Files:** Modify `server/migrationList.ts`; create `server/customerMigration.test.ts`

- [ ] **Step 1: Write the failing fixture test**

```ts
// server/customerMigration.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrations } from './migrationList';

const m16 = migrations.find(m => m.version === 16)!;

function seed() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, contractor TEXT, meta TEXT);`);
  const ins = db.prepare('INSERT INTO projects (id, contractor) VALUES (?, ?)');
  ins.run('p1', 'Acme');
  ins.run('p2', ' acme ');   // same normalized name -> same customer
  ins.run('p3', 'Beta Co');
  ins.run('p4', '');         // blank -> Unassigned
  ins.run('p5', null);       // null -> Unassigned
  return db;
}

describe('migration 16 customers-from-contractor', () => {
  it('creates a customer per distinct contractor, links projects, routes blanks to Unassigned, keeps contractor', () => {
    const db = seed();
    m16.up({ db } as any);
    const cust = db.prepare('SELECT id, name FROM customers ORDER BY name').all() as any[];
    // Acme, Beta Co, Unassigned
    expect(cust.map(c => c.name).sort()).toEqual(['Acme', 'Beta Co', 'Unassigned']);
    const cid = (pid: string) => (db.prepare('SELECT customerId FROM projects WHERE id = ?').get(pid) as any).customerId;
    expect(cid('p1')).toBe(cid('p2'));                 // deduped
    expect(cid('p1')).not.toBe(cid('p3'));
    expect(cid('p4')).toBe('customer-unassigned');
    expect(cid('p5')).toBe('customer-unassigned');
    // contractor preserved (non-destructive)
    expect((db.prepare('SELECT contractor FROM projects WHERE id = ?').get('p1') as any).contractor).toBe('Acme');
  });

  it('is safe to run when a projects.customerId already exists (idempotent columns)', () => {
    const db = seed();
    m16.up({ db } as any);
    expect(() => m16.up({ db } as any)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run — fails** (no migration 16).

- [ ] **Step 3: Implement migration 16** (append to the `migrations` array in `server/migrationList.ts`, after version 15)

```ts
  {
    version: 16,
    name: 'customers-from-contractor',
    // SUPERVISED, data-transforming, NON-DESTRUCTIVE. Creates the customers table
    // + projects.customerId, then makes one Customer per distinct (trimmed,
    // lower-cased) contractor string and links its projects. Projects with a
    // blank/null contractor go to a single well-known "Unassigned" customer so
    // they remain reachable. `contractor` is left untouched.
    up({ db }) {
      // Columns/tables — guard so a re-run can't fail on "duplicate column".
      const cols = (db.prepare(`PRAGMA table_info(projects)`).all() as any[]).map(c => c.name);
      if (!cols.includes('customerId')) db.exec(`ALTER TABLE projects ADD COLUMN customerId TEXT;`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS customers (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, address TEXT,
          contactName TEXT, notes TEXT, generalEmail TEXT, accountingEmail TEXT,
          estimatingEmail TEXT, pmEmail TEXT, createdAt INTEGER, updatedAt INTEGER, attrs TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_projects_customerId ON projects (customerId);
      `);
      const now = Date.now();
      const ensure = db.prepare(`INSERT OR IGNORE INTO customers (id,name,createdAt,updatedAt) VALUES (?,?,?,?)`);
      ensure.run('customer-unassigned', 'Unassigned', now, now);

      const rows = db.prepare(`SELECT id, contractor FROM projects`).all() as any[];
      const byNorm = new Map<string, string>(); // normalized -> customerId
      let seq = 0;
      const link = db.prepare(`UPDATE projects SET customerId = ? WHERE id = ?`);
      for (const r of rows) {
        const raw = (r.contractor ?? '').trim();
        if (!raw) { link.run('customer-unassigned', r.id); continue; }
        const norm = raw.toLowerCase();
        let cid = byNorm.get(norm);
        if (!cid) {
          cid = `customer-mig-${now}-${seq++}`;
          db.prepare(`INSERT INTO customers (id,name,createdAt,updatedAt) VALUES (?,?,?,?)`).run(cid, raw, now, now);
          byNorm.set(norm, cid);
        }
        link.run(cid, r.id);
      }
    },
  },
```

- [ ] **Step 4: Run — passes.** Also run `npx vitest run server/migrations.test.ts server/customerMigration.test.ts`.
- [ ] **Step 5: Commit** `feat(customers): migration 16 — link projects to customers`.

---

## Task A4: projectStore `customerId` round-trip

**Files:** Modify `server/projectStore.ts`; modify `server/projectStore.test.ts`

- [ ] **Step 1: Add a failing assertion** to `projectStore.test.ts` (an existing round-trip test): after decompose/load, `expect(loaded.customerId).toBe('c1')`. Seed the payload with `customerId: 'c1'`.

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement.** In `loadProject` (after the `bidDueDate` put):
```ts
  put(project, 'customerId', row.customerId);
```
In `decomposeProject`, add `customerId` to the destructure and the UPDATE:
```ts
  const { id, name, createdAt, contractor, customerId, address, bidDueDate,
          planSets, pages, takeoffs, version: _v, status: _s, ...meta } = payload;
```
Add `customerId = ?` to the `UPDATE projects SET ...` column list and bind
`customerId ?? null` in the correct position. (`contactEmails` needs no change —
it stays in `...meta` and is merged back by `Object.assign(project, meta)`.)

- [ ] **Step 4: Run — passes** (`npx vitest run server/projectStore.test.ts`).
- [ ] **Step 5: Commit** `feat(customers): round-trip project.customerId`.

---

## Task A5: Customer REST routes

**Files:** Modify `server/routes.ts` (inside `registerDataRoutes`), `server.ts` (import `createCustomerTables` only if needed — the migration creates tables, so no runtime create needed). Optionally extend `server/routes.test.ts`.

- [ ] **Step 1: Implement the routes** (add near the other `/api/...` routes in `registerDataRoutes`, using the in-scope `db`):

```ts
  app.get('/api/customers', authenticateToken, (_req, res) => res.json(listCustomers(db)));
  app.get('/api/customers/:id', authenticateToken, (req, res) => {
    const c = getCustomer(db, req.params.id);
    return c ? res.json(c) : res.status(404).json({ error: 'not found' });
  });
  app.get('/api/customers/:id/projects', authenticateToken, (req, res) =>
    res.json(listProjectsForCustomer(db, req.params.id)));
  app.post('/api/customers', authenticateToken, (req, res) => {
    const id = req.body.id || `customer-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    res.json(saveCustomer(db, { ...req.body, id }));
  });
  app.put('/api/customers/:id', authenticateToken, (req, res) =>
    res.json(saveCustomer(db, { ...req.body, id: req.params.id })));
  app.delete('/api/customers/:id', authenticateToken, (req, res) => {
    try { deleteCustomer(db, req.params.id); res.json({ success: true }); }
    catch (e: any) { res.status(409).json({ error: String(e?.message ?? e) }); }
  });
  app.post('/api/customers/merge', authenticateToken, (req, res) => {
    try { mergeCustomers(db, req.body.targetId, req.body.sourceIds || []); res.json({ success: true }); }
    catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
  });
```
Add the import at the top of `routes.ts`:
```ts
import { listCustomers, getCustomer, saveCustomer, deleteCustomer, mergeCustomers, listProjectsForCustomer } from './customerStore';
```
(`Math.random()`/`Date.now()` are fine in server runtime.)

- [ ] **Step 2: Verify** — `npx tsc --noEmit`; server starts (`registerDataRoutes` compiles). If `routes.test.ts` exercises routes, add a smoke test creating + listing a customer.
- [ ] **Step 3: Commit** `feat(customers): REST routes`.

---

## Task A6: Client customer API + recipient helper

**Files:** Modify `src/utils/store.ts`; create `src/utils/recipients.ts` + `src/utils/recipients.test.ts`

- [ ] **Step 1: Write the failing recipients test**

```ts
// src/utils/recipients.test.ts
import { describe, it, expect } from 'vitest';
import { roleForTemplate, resolveRecipient } from './recipients';

describe('roleForTemplate', () => {
  it('maps templates to roles', () => {
    expect(roleForTemplate('proposal')).toBe('estimating');
    expect(roleForTemplate('invoice')).toBe('accounting');
    expect(roleForTemplate('changeOrder')).toBe('accounting');
    expect(roleForTemplate('issue')).toBe('pm');
    expect(roleForTemplate('punch')).toBe('pm');
  });
});

describe('resolveRecipient', () => {
  const cust = { estimating: 'est@c.com', accounting: 'ap@c.com', general: 'info@c.com' };
  it('prefers the project override for the role', () => {
    expect(resolveRecipient('proposal', { estimating: 'proj@x.com' }, cust)).toBe('proj@x.com');
  });
  it('falls back to the customer role', () => {
    expect(resolveRecipient('proposal', {}, cust)).toBe('est@c.com');
  });
  it('falls back to project general, then customer general', () => {
    expect(resolveRecipient('issue', { general: 'pg@x.com' }, cust)).toBe('pg@x.com');
    expect(resolveRecipient('issue', undefined, cust)).toBe('info@c.com');
  });
  it('returns empty when nothing is set', () => {
    expect(resolveRecipient('invoice', undefined, undefined)).toBe('');
  });
});
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement `src/utils/recipients.ts`**

```ts
import type { CustomerRoleEmails } from '../types';

export type TemplateType = 'proposal' | 'invoice' | 'changeOrder' | 'issue' | 'punch';

export function roleForTemplate(t: TemplateType): keyof CustomerRoleEmails {
  switch (t) {
    case 'proposal': return 'estimating';
    case 'invoice':
    case 'changeOrder': return 'accounting';
    case 'issue':
    case 'punch': return 'pm';
  }
}

/** project[role] → customer[role] → project.general → customer.general → ''. */
export function resolveRecipient(
  t: TemplateType,
  projectEmails: CustomerRoleEmails | undefined,
  customerEmails: CustomerRoleEmails | undefined,
): string {
  const role = roleForTemplate(t);
  return (
    projectEmails?.[role] || customerEmails?.[role] ||
    projectEmails?.general || customerEmails?.general || ''
  ).trim();
}
```

- [ ] **Step 4: Run — passes.**

- [ ] **Step 5: Add client API helpers** to `src/utils/store.ts` (mirror existing fetch helpers + `getAuthHeaders`):
```ts
export const getCustomers = async () => (await fetch('/api/customers', { headers: getAuthHeaders() })).json();
export const getCustomer = async (id: string) => (await fetch('/api/customers/' + id, { headers: getAuthHeaders() })).json();
export const getCustomerProjects = async (id: string) => (await fetch(`/api/customers/${id}/projects`, { headers: getAuthHeaders() })).json();
export const saveCustomer = async (c: any) => {
  const res = await fetch(c.id ? '/api/customers/' + c.id : '/api/customers', {
    method: c.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(c),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'save failed');
  return res.json();
};
export const deleteCustomer = async (id: string) => {
  const res = await fetch('/api/customers/' + id, { method: 'DELETE', headers: getAuthHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'delete failed');
};
export const mergeCustomers = async (targetId: string, sourceIds: string[]) => {
  const res = await fetch('/api/customers/merge', { method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify({ targetId, sourceIds }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'merge failed');
};
```

- [ ] **Step 6: Verify** `npx tsc --noEmit && npx vitest run src/utils/recipients.test.ts`. **Commit** `feat(customers): client API + recipient resolution helper`.

---

## Task A7: Customers management UI

**Files:** Create `src/pages/CustomersPage.tsx`, `src/pages/CustomerDetail.tsx`; modify `src/App.tsx` + the sidebar/nav.

**Context:** Follow the styling of existing pages (e.g. `ProjectsPage`, `Settings` sections). This task is UI — verify with `tsc` + build + manual.

- [ ] **Step 1: Route + nav.** Add routes `customers` → `<CustomersPage />` and `customers/:id` → `<CustomerDetail />` in `src/App.tsx` (sibling of `projects`). Add a "Customers" nav link in the sidebar component (next to Projects), matching existing nav item markup.

- [ ] **Step 2: `CustomersPage`.** Fetch `getCustomers()`. Render a searchable list (name, contactName, phone, and a project count — from a `getCustomerProjects` count or a count field). A "New customer" button opens the create form (modal or inline) with fields: name, phone, address, contactName, notes, and the 4 role emails (General/Accounting/Estimating/Project Management). Save via `saveCustomer`. Each row links to `/customers/:id`. Provide a "Merge" action (see Step 4).

- [ ] **Step 3: `CustomerDetail`.** Fetch `getCustomer(id)` + `getCustomerProjects(id)`. Show/edit all fields + role emails (save via `saveCustomer`). List the customer's projects (link to each). A "Delete" button (disabled for `customer-unassigned`; on 409 show the returned message).

- [ ] **Step 4: Merge UI.** A "Merge into…" control: pick a target customer (typeahead over `getCustomers()`), confirm dialog listing the source's projects that will move, then call `mergeCustomers(targetId, [sourceId])` and refresh.

- [ ] **Step 5: Verify** `npx tsc --noEmit && npm run build`. Manual: create two customers, add projects (after Task A8), merge one into the other, confirm projects moved and blanks filled.
- [ ] **Step 6: Commit** `feat(customers): management UI (list/detail/merge)`.

---

## Task A8: Project ↔ Customer linking in Project create + Settings

**Files:** Modify `src/pages/NewProject.tsx`, the project Settings section (`src/pages/project/*Settings*`), and any project display currently showing `contractor`.

- [ ] **Step 1: Customer picker.** Replace the contractor text input in `NewProject` with a customer typeahead (`getCustomers()`), plus "＋ New customer" inline create (`saveCustomer`). On submit, set `project.customerId`; also set `project.contractor` = the chosen customer's `name` (keeps the denormalized fallback in sync).

- [ ] **Step 2: Project-specific contacts.** In project Settings, add a "Project contacts (override customer)" panel with the 4 role-email fields bound to `project.contactEmails` (rides in meta; saved via the normal project save). Also allow changing the linked customer there.

- [ ] **Step 3: Displays.** Where the UI showed `project.contractor`, show the linked customer's name (look up from a customers cache; fall back to `project.contractor`).

- [ ] **Step 4: Verify** `npx tsc --noEmit && npm run build`; manual: create a project, pick/create a customer, confirm it appears under that customer.
- [ ] **Step 5: Commit** `feat(customers): project↔customer linking + project contact overrides`.

---

# PHASE B — Email integration (depends on Phase A)

## Task B1: Per-user Always-CC setting

**Files:** Modify `src/pages/Settings.tsx` (Email tab), and the prefs read/write path in `src/utils/store.ts` if needed.

**Context:** Per-user prefs already persist (`getUserPreferences`/`saveUserPreferences`). Add an `emailAlwaysCc` key (a comma/semicolon list). It is a normal pref (not `smtp.*`), so it flows through the existing prefs blob.

- [ ] **Step 1:** In the Email settings tab, add an "Always CC" text field bound to the `emailAlwaysCc` pref, with help text ("added to CC on every template you send"). Save with the other prefs.
- [ ] **Step 2:** Add a small reader `getAlwaysCc(): string` (from cached prefs) usable by send sites, or read the pref directly in each send site.
- [ ] **Step 3: Verify** `tsc` + build. **Commit** `feat(email): per-user always-CC setting`.

---

## Task B2: EmailComposer — defaultCc + header-email dropdown

**Files:** Modify `src/components/EmailComposer.tsx`

- [ ] **Step 1: Props.** Add:
```ts
  defaultCc?: string;
  /** Header/contact email options for the generated document letterhead. */
  headerEmailOptions?: { label: string; value: string }[];
  defaultHeaderEmail?: string;
```
Add `headerEmail` to the `onSend` payload type.

- [ ] **Step 2: State.** Seed `cc` from `defaultCc` (merged/de-duped with any existing). Add a `headerEmail` state defaulting to `defaultHeaderEmail`. Render a small "Document shows email:" `<select>` from `headerEmailOptions` when provided (2 options: "My email" / "Company default"). Include `headerEmail` in the `onSend(...)` payload.

- [ ] **Step 3: Verify** `tsc` + build. **Commit** `feat(email): composer defaultCc + header-email selector`.

---

## Task B3: Generators — header-email override

**Files:** Modify the five generators (`invoicePdf.ts`, `changeOrderPdf.ts`, `issuePdf.ts`, `punchPdf.ts`, `proposalGenerator.ts`).

- [ ] **Step 1:** Each already builds a `LetterheadContext` with `company.email = settings.companyEmail`. Add an optional `headerEmail?: string` param to each generator's options; when set, use it for `company.email` (falling back to `settings.companyEmail`). Keep the default behavior (company email) unchanged when not passed.
- [ ] **Step 2: Verify** `tsc` + build + existing generator tests still pass. **Commit** `feat(email): header-email override in document generators`.

---

## Task B4: Wire the five send sites

**Files:** `ProjectProposal.tsx`, `billing/InvoiceEditor.tsx` (+ its send path), `billing/ChangeOrderEditor.tsx`, `issues/IssueEditor.tsx`, punch send site.

**Context:** Each opens `EmailComposer`. For each, resolve the customer for the project (`getCustomer(project.customerId)` — cache it), compute `defaultTo`, `defaultCc`, and the header-email options, and regenerate the primary attachment with the chosen header email on send.

- [ ] **Step 1 (per site): defaultTo + defaultCc.**
```ts
const customer = project.customerId ? await getCustomer(project.customerId) : null;
const defaultTo = resolveRecipient('proposal' /* or the site's type */, project.contactEmails, customer?.emails)
  || project.email?.from || '';
const defaultCc = getAlwaysCc();
```
Pass `defaultTo`, `defaultCc` to `EmailComposer`.

- [ ] **Step 2 (per site): header-email options.**
```ts
const headerEmailOptions = [
  { label: 'Company default', value: settings.companyEmail || '' },
  { label: 'My email', value: mySmtpFromAddress || '' },
].filter(o => o.value);
```
Pass `headerEmailOptions` + `defaultHeaderEmail = settings.companyEmail`.

- [ ] **Step 3 (per site): regenerate on send.** In `onSend`, if `m.headerEmail` differs from the company default, regenerate the document with `{ headerEmail: m.headerEmail }`, upload it, and send that attachment; otherwise send the existing one. Keep the rest of the existing `onSend` logic (cc/bcc/subject/body/attachmentFileIds).

- [ ] **Step 4: Verify** `tsc` + build; manual smoke on each of the five sends (SMTP): recipient prefilled from the customer's role email, CC prefilled from always-CC, and the header email toggles on the generated PDF.
- [ ] **Step 5: Commit** `feat(email): route template recipients + header email across all send sites`.

---

## Task B5: Final review + push

- [ ] **Step 1:** `npx tsc --noEmit && npm test && npm run build` — all green.
- [ ] **Step 2:** Dispatch a `code-reviewer` over the whole change set. Focus: migration 16 non-destructive + idempotent; merge is transactional and can't strand projects; `customerId` round-trips; recipient resolution order correct; mail still always sends via the user's SMTP (header-email only affects the printed contact email).
- [ ] **Step 3:** Push to `testing`. Do NOT run migration 16 against production without Nathan watching. Do NOT open a PR unless asked.

---

## Self-Review notes (author)

- **Spec coverage:** Customer entity + role emails (A1/A2), migration + Unassigned (A3), project link + overrides (A4/A8), CRUD + merge (A2/A5/A7), recipient auto-fill (A6/B4), per-user always-CC (B1/B4), header-email dropdown that never changes the SMTP sender (B2/B3/B4). All spec sections map to a task.
- **Type consistency:** `Customer.emails: CustomerRoleEmails` used identically in store, routes, resolver, and UI; `roleForTemplate`/`resolveRecipient` signatures match between definition (A6) and use (B4); `customerId` column name identical across migration 16, projectStore, and customerStore.
- **Supervised migration:** 16 is data-transforming; implement + test on testing, flag before production (matches the spec + Nathan's protocol).
- **Phase independence:** Phase A ships working software (projects gain customers; email unchanged). Phase B layers on top.
