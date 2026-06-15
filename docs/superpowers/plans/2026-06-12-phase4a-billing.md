# Phase 4a: Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add invoices (line items, draft/sent/paid, partial payments), change orders (first-class records feeding contract value), and a per-project Billing section with PDF generation + SMTP send — admin-only, AIA-ready, no tax/retainage/AIA math yet.

**Architecture:** Four normalized tables (migration 8) on the Phase 1 data layer: `invoices` + `invoice_lines` (header/lines saved as a version-checked unit), `payments` (append/delete rows against an invoice), `change_orders` (independent status records). A `server/billingStore.ts` owns all money math in integer cents to avoid float drift. Routes are `requireAdmin`-gated. The client gets a `ProjectBilling` section (hidden from the sidebar and access-denied at the route for non-admins), invoice PDF generation via jsPDF, and a reusable SMTP send extracted from the existing send-proposal route. Contract value = base `projects.contractValue` + sum of approved change orders, surfaced on the project summary and Overview.

**Tech Stack:** Express 4 + better-sqlite3, Vitest (server node + ui jsdom projects), Supertest, React 19 + react-router 7 nested routes, Phase 2 ui library, jsPDF (already a dependency), nodemailer (existing SMTP).

**Spec:** `docs/superpowers/specs/2026-06-11-cohesive-app-design.md` (§2 Billing v1 decision, §3.2 billing tables + AIA-readiness constraint, §4.1/§4.3 admin-only / members-never-see-pricing, §6 outbound email). This is sub-plan **4a** of Phase 4 (4b Issues, 4c Punch follow as separate plans).

**Branch:** all work on `testing` (per project CLAUDE.md — push directly, no PRs).

---

## Context You Must Know Before Starting

1. **Data layer (Phases 1–3b):** `server/migrationList.ts` holds migrations 1–7 (latest = 7 `drafts`); the framework auto-backs-up the DB before applying. `server/routes.ts` exposes `registerDataRoutes(app, deps)` with `RouteDeps {db, dataDir, dbFile, authenticateToken, requireAdmin, verifyToken}`. `server/projectStore.ts` has `loadProject/saveProject/patchProject/deleteProject/listProjectSummaries/PROJECT_STATUSES/deriveStatus` + `ValidationError/ConflictError/NotFoundError`. `server/activity.ts` has `logActivity(db, {projectId?, userId?, type, message})` / `listActivity(db, limit?, projectId?)`. `server/files.ts` has `putBuffer(db, dataDir, id, buf, mime, opts?)`, `getDataUrlString(db, dataDir, id)`, `getMeta`.
2. **`projects.contractValue REAL` already exists** (migration 3 column) but is unused. Billing surfaces it as the BASE contract value; the rollup adds approved change orders.
3. **deleteProject cascade** (`projectStore.ts` `deleteProject`) currently deletes from measurements/pages/takeoffs/plan_sets, drafts, files, projects — all inside one `db.transaction`. New billing tables MUST be added to that cascade (Task 1).
4. **Money is handled in integer cents** inside `billingStore.ts` to avoid float drift, but stored in SQLite as REAL dollars (consistent with `contractValue REAL` and the app's existing float costs). Every total/balance is computed by rounding each amount to cents (`Math.round(x * 100)`), summing integers, and dividing by 100 at the boundary. Never sum raw floats.
5. **Admin-only (spec §4.1/§4.3):** all billing routes are `authenticateToken, requireAdmin`. `requireAdmin` returns 403 if `req.user.role !== 'admin'`. Client: the Billing sidebar entry is hidden for non-admins and the `/billing` route renders an access-denied panel for them (defense in depth — the server is the real gate). Estimate-cost-hiding for members is a broader §4.3 concern deferred to a later pass; this plan only gates Billing.
6. **Role detection client-side:** `JSON.parse(localStorage.getItem('user') || '{}').role === 'admin'`. Server: `requireAdmin` checks `req.user.role`.
7. **SMTP send pattern:** `server.ts` `POST /api/projects/:id/send-proposal` (~line 536) does buildTransporter → read `smtp.*` settings → decode a stored file's dataURL to a Buffer → `transport.sendMail({from, to, subject, text, attachments})` → `logActivity`. Task 11 extracts the reusable core into a `sendProjectEmail` helper and adds `POST /api/invoices/:id/send`.
8. **jsPDF** is a dependency; `src/pages/ChecklistEditor.tsx` (~line 825) shows the client-side generation pattern (`new jsPDF({orientation,unit,format})` → draw → output). Invoices generate the PDF client-side, upload it as a `files` row (kind `invoice`) via `uploadProjectFile`-style POST, then the server emails that file.
9. **ui library + patterns:** import from `../../components/ui` (Button, Card/CardHeader/CardBody, StatusPill, Field/Input/Select/Textarea/Checkbox, Modal, Table…, EmptyState, Skeleton). Toast: `const {toast}=useToast(); toast(msg,{type})`. Section pages use `useProjectOutlet()` ({summary, refreshSummary}) + `useParams`. Store helpers follow `fetchWithRetry`/`getAuthHeaders`/`handleResponse`/`ConflictError` (writes never auto-retry).
10. **Route registration order:** literal segments before `:param`. New `/api/invoices/:id/...` and `/api/projects/:id/invoices` don't collide with existing routes (distinct prefixes) but keep them grouped.
11. **Tests:** server `server/*.test.ts` (node), ui `src/**/*.test.tsx` (jsdom, globals:true). `npm test`, `npm run lint`, boot `STORAGE_PATH=$(mktemp -d) npm run dev` (kill stale `tsx server.ts` by PID — `pkill -f` matches your own shell, use `pgrep`/`kill <pid>`).
12. **🎨 DESIGN CHECKPOINT:** Task 10 (invoice PDF template) STOPS for Nathan to choose the layout from mockups before the generator is finalized. Do not autonomously pick a final invoice design.
13. **Line numbers are approximate** — anchor by content; NEEDS_CONTEXT over guessing.

## File Structure

```
server/migrationList.ts        # + migration 8 'billing' (invoices, invoice_lines, payments, change_orders)
server/projectStore.ts         # deleteProject cascade gains the 4 billing tables; listProjectSummaries gains contract rollup + invoiceCount
server/billingStore.ts         # NEW: invoice/line/payment/change-order CRUD + cents money math + rollups
server/billingStore.test.ts    # NEW
server/routes.ts               # + billing routes (requireAdmin) + activity logging; summary surfacing
server/routes.test.ts          # + billing route integration tests
server/migrationList.test.ts   # + migration 8 test
server.ts                      # extract sendProjectEmail helper from send-proposal; + POST /api/invoices/:id/send
src/utils/store.ts             # + Invoice/InvoiceLine/Payment/ChangeOrder/BillingSummary types + helpers;
                               #   ProjectSummary gains contractValue/invoiceCount
src/utils/money.ts             # NEW: formatMoney, centsOf, sumCents (shared client money helpers)
src/utils/money.test.ts        # NEW
src/components/ui/BillingPills.tsx       # NEW: InvoiceStatusPill, ChangeOrderStatusPill
src/components/ui/BillingPills.test.tsx  # NEW
src/pages/project/ProjectBilling.tsx     # NEW: section page (admin-gated)
src/pages/project/billing/InvoiceEditor.tsx   # NEW: invoice header + lines editor modal
src/pages/project/billing/invoicePdf.ts       # NEW: jsPDF invoice generator (Task 10, design-checkpointed)
src/pages/project/ProjectBilling.test.tsx     # NEW: rollup/helper tests
src/components/shell/Sidebar.tsx         # + Billing nav entry (admin-only)
src/components/shell/Sidebar.test.tsx    # admin-visibility test
src/App.tsx                    # + billing route under the project tree
src/pages/project/ProjectOverview.tsx    # contract value surfaced in Details (admin only)
```

Status vocabularies (locked in): **invoice** `draft | sent | paid` · **change_order** `pending | approved | rejected`. Activity event types added: `invoice_created`, `invoice_sent`, `payment_recorded`, `change_order_created`, `change_order_approved`.

---

### Task 1: Migration 8 — Billing Tables + Delete Cascade

**Files:**
- Modify: `server/migrationList.ts` (append migration 8)
- Modify: `server/projectStore.ts` (deleteProject cascade)
- Test: `server/migrationList.test.ts` (append)

- [ ] **Step 1: Write the failing migration test** (append to `server/migrationList.test.ts`)

```ts
describe('migration 8: billing', () => {
  it('creates invoices, invoice_lines, payments, change_orders', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    const tables = tableNames(db);
    for (const t of ['invoices', 'invoice_lines', 'payments', 'change_orders']) {
      expect(tables, `missing ${t}`).toContain(t);
    }
    // shape spot-checks
    const invCols = (db.prepare(`PRAGMA table_info(invoices)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'projectId', 'number', 'date', 'status', 'terms', 'version', 'createdAt']) {
      expect(invCols, `invoices missing ${c}`).toContain(c);
    }
    const coCols = (db.prepare(`PRAGMA table_info(change_orders)`).all() as any[]).map(r => r.name);
    for (const c of ['id', 'projectId', 'number', 'description', 'amount', 'status', 'createdAt']) {
      expect(coCols, `change_orders missing ${c}`).toContain(c);
    }
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/migrationList.test.ts`
Expected: FAIL — billing tables absent.

- [ ] **Step 3: Append migration 8 to `server/migrationList.ts`**

```ts
  {
    version: 8,
    name: 'billing',
    up({ db }) {
      // Billing v1 (spec §2, §3.2). Money stored as REAL dollars; all totals
      // are computed in integer cents in billingStore to avoid float drift.
      // Line-item identity is preserved (no totals-only invoices) so a future
      // AIA schedule-of-values can reference these rows (spec §3.2).
      db.exec(`
        CREATE TABLE invoices (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number TEXT,
          date INTEGER,
          status TEXT NOT NULL DEFAULT 'draft',
          terms TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_invoices_projectId ON invoices (projectId);

        CREATE TABLE invoice_lines (
          id TEXT PRIMARY KEY,
          invoiceId TEXT NOT NULL,
          description TEXT,
          qty REAL NOT NULL DEFAULT 1,
          unitPrice REAL NOT NULL DEFAULT 0,
          sortOrder INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_invoice_lines_invoiceId ON invoice_lines (invoiceId);

        CREATE TABLE payments (
          id TEXT PRIMARY KEY,
          invoiceId TEXT NOT NULL,
          date INTEGER,
          amount REAL NOT NULL DEFAULT 0,
          method TEXT,
          note TEXT,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_payments_invoiceId ON payments (invoiceId);

        CREATE TABLE change_orders (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number TEXT,
          description TEXT,
          amount REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_change_orders_projectId ON change_orders (projectId);
      `);
    },
  },
```

- [ ] **Step 4: Extend the deleteProject cascade in `server/projectStore.ts`**

In `deleteProject`, inside the existing `db.transaction(() => {...})`, before the `DELETE FROM files` line, add billing cleanup (payments first — they reference invoices; then invoice_lines; then invoices; then change_orders):

```ts
    // Billing rows (Phase 4a) — payments/lines reference invoices, delete first.
    db.prepare('DELETE FROM payments WHERE invoiceId IN (SELECT id FROM invoices WHERE projectId = ?)').run(id);
    db.prepare('DELETE FROM invoice_lines WHERE invoiceId IN (SELECT id FROM invoices WHERE projectId = ?)').run(id);
    db.prepare('DELETE FROM invoices WHERE projectId = ?').run(id);
    db.prepare('DELETE FROM change_orders WHERE projectId = ?').run(id);
```

- [ ] **Step 5: Add a delete-cascade test** (append to `server/routes.test.ts` in a billing-adjacent or existing delete describe — uses HTTP)

```ts
describe('deleteProject billing cascade', () => {
  it('removes invoices, lines, payments, change orders for the project', async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
    const inv = await request(app).post('/api/projects/p1/invoices')
      .send({ number: 'INV-1', date: 1, terms: 'Net 30', lines: [{ description: 'Work', qty: 1, unitPrice: 100 }] });
    const invoiceId = inv.body.id;
    await request(app).post(`/api/invoices/${invoiceId}/payments`).send({ date: 1, amount: 50, method: 'check' });
    await request(app).post('/api/projects/p1/change-orders').send({ number: 'CO-1', description: 'Extra', amount: 200 });
    await request(app).delete('/api/projects/p1');
    // all billing rows gone
    for (const sql of [
      'SELECT COUNT(*) c FROM invoices WHERE projectId = ?',
      'SELECT COUNT(*) c FROM change_orders WHERE projectId = ?',
    ]) {
      expect((db.prepare(sql).get('p1') as any).c).toBe(0);
    }
    expect((db.prepare('SELECT COUNT(*) c FROM payments').get() as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM invoice_lines').get() as any).c).toBe(0);
  });
});
```

(This test depends on the routes from Tasks 2–5; it will go red until those land — that's expected. Run it at the end of Task 5. For THIS task, only the migration test must pass.)

- [ ] **Step 6: Run the migration test + lint**

Run: `npx vitest run server/migrationList.test.ts && npm run lint`
Expected: migration test PASS; lint clean. (The cascade HTTP test is red until Task 5 — leave it; do not delete it.)

- [ ] **Step 7: Commit**

```bash
git add server/migrationList.ts server/migrationList.test.ts server/projectStore.ts server/routes.test.ts
git commit -m "feat: migration 8 billing tables + delete cascade"
```

---

### Task 2: billingStore — Money Math + Invoice CRUD

**Files:**
- Create: `server/billingStore.ts`
- Test: `server/billingStore.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/billingStore.test.ts`
Expected: FAIL — `Cannot find module './billingStore'`

- [ ] **Step 3: Implement `server/billingStore.ts`** (invoices + money helpers; payments and change orders are Tasks 3–4)

```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/billingStore.test.ts && npm run lint`
Expected: PASS (money + invoice tests), clean.

- [ ] **Step 5: Commit**

```bash
git add server/billingStore.ts server/billingStore.test.ts
git commit -m "feat: billing store — cents money math + invoice CRUD"
```

---

### Task 3: billingStore — Payments + Invoice Status Transitions

**Files:**
- Modify: `server/billingStore.ts` (append)
- Test: `server/billingStore.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append to `server/billingStore.test.ts`; add `recordPayment, deletePayment, setInvoiceStatus` to the import)

```ts
describe('payments + status', () => {
  it('records and deletes payments; balance reflects them', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [{ description: 'A', qty: 1, unitPrice: 100 }] });
    const p1 = recordPayment(db, id, { date: 1, amount: 40, method: 'check', note: 'deposit' });
    recordPayment(db, id, { date: 2, amount: 25.5, method: 'card' });
    let inv = getInvoice(db, id)!;
    expect(inv.paidCents).toBe(6550);
    expect(inv.balanceCents).toBe(3450);
    deletePayment(db, p1.id);
    inv = getInvoice(db, id)!;
    expect(inv.paidCents).toBe(2550);
  });

  it('rejects invalid payment amounts and unknown invoices', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    expect(() => recordPayment(db, id, { amount: -5 })).toThrow(ValidationError);
    expect(() => recordPayment(db, 'nope', { amount: 5 })).toThrow(NotFoundError);
  });

  it('setInvoiceStatus validates the value and bumps version', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    const r = setInvoiceStatus(db, id, 'sent');
    expect(r.version).toBe(2);
    expect(getInvoice(db, id)!.status).toBe('sent');
    expect(() => setInvoiceStatus(db, id, 'galactic')).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/billingStore.test.ts`
Expected: FAIL — `recordPayment` not exported.

- [ ] **Step 3: Append to `server/billingStore.ts`**

```ts
interface PaymentInput { date?: number | null; amount?: number; method?: string; note?: string; }

export function recordPayment(db: Database.Database, invoiceId: string, input: PaymentInput): { id: string } {
  const inv = db.prepare('SELECT id FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv) throw new NotFoundError('Invoice not found');
  if (!Number.isFinite(input.amount) || (input.amount as number) <= 0) throw new ValidationError('Payment amount must be a positive number');
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/billingStore.test.ts && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add server/billingStore.ts server/billingStore.test.ts
git commit -m "feat: billing store — payments and invoice status transitions"
```

---

### Task 4: billingStore — Change Orders + Contract Rollup

**Files:**
- Modify: `server/billingStore.ts` (append)
- Test: `server/billingStore.test.ts` (append)

The contract rollup is the spec §4.1 "contract value (base + approved COs)" that feeds the project Overview and summary.

- [ ] **Step 1: Write the failing tests** (append; add `listChangeOrders, createChangeOrder, setChangeOrderStatus, deleteChangeOrder, billingSummary` to the import)

```ts
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
    recordPayment(db, inv.id, { amount: 200 });
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/billingStore.test.ts`
Expected: FAIL — change-order exports missing.

- [ ] **Step 3: Append to `server/billingStore.ts`**

```ts
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
export function billingSummary(db: Database.Database, projectId: string): {
  baseContractCents: number; approvedChangeCents: number; contractValueCents: number;
  invoicedCents: number; paidCents: number; outstandingCents: number;
  invoiceCount: number; changeOrderCount: number;
} {
  const proj = db.prepare('SELECT contractValue FROM projects WHERE id = ?').get(projectId) as { contractValue: number | null } | undefined;
  const baseContractCents = toCents(proj?.contractValue ?? 0);
  const approvedRows = db.prepare(`SELECT amount FROM change_orders WHERE projectId = ? AND status = 'approved'`).all(projectId) as { amount: number }[];
  const approvedChangeCents = approvedRows.reduce((a, r) => a + toCents(r.amount), 0);

  const invoices = listInvoices(db, projectId);
  const invoicedCents = invoices.reduce((a, i) => a + i.totalCents, 0);
  const paidCents = invoices.reduce((a, i) => a + i.paidCents, 0);
  const changeOrderCount = (db.prepare('SELECT COUNT(*) c FROM change_orders WHERE projectId = ?').get(projectId) as any).c;

  return {
    baseContractCents,
    approvedChangeCents,
    contractValueCents: baseContractCents + approvedChangeCents,
    invoicedCents,
    paidCents,
    outstandingCents: invoicedCents - paidCents,
    invoiceCount: invoices.length,
    changeOrderCount,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/billingStore.test.ts && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add server/billingStore.ts server/billingStore.test.ts
git commit -m "feat: billing store — change orders and contract rollup summary"
```

---

### Task 5: Billing Routes (Admin-Gated) + Activity

**Files:**
- Modify: `server/routes.ts`
- Test: `server/routes.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append to `server/routes.test.ts`)

```ts
describe('billing routes', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
  });

  it('invoice create → get → status → list', async () => {
    const create = await request(app).post('/api/projects/p1/invoices')
      .send({ number: 'INV-1', date: 1, terms: 'Net 30', lines: [{ description: 'Work', qty: 2, unitPrice: 100 }] });
    expect(create.status).toBe(200);
    const id = create.body.id;
    const get = await request(app).get(`/api/invoices/${id}`);
    expect(get.body.totalCents).toBe(20000);
    expect(get.body.balanceCents).toBe(20000);
    const status = await request(app).patch(`/api/invoices/${id}`).send({ status: 'sent' });
    expect(status.status).toBe(200);
    const list = await request(app).get('/api/projects/p1/invoices');
    expect(list.body[0].status).toBe('sent');
  });

  it('save invoice is version-checked (409 on stale)', async () => {
    const create = await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-1', lines: [] });
    const id = create.body.id;
    const inv = (await request(app).get(`/api/invoices/${id}`)).body;
    const ok = await request(app).put(`/api/invoices/${id}`).send({ ...inv, terms: 'Net 15' });
    expect(ok.status).toBe(200);
    const stale = await request(app).put(`/api/invoices/${id}`).send({ ...inv, terms: 'Clobber' });
    expect(stale.status).toBe(409);
  });

  it('payments round-trip and affect balance', async () => {
    const id = (await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-1', lines: [{ description: 'A', qty: 1, unitPrice: 100 }] })).body.id;
    const pay = await request(app).post(`/api/invoices/${id}/payments`).send({ amount: 40, method: 'check' });
    expect(pay.status).toBe(200);
    expect((await request(app).get(`/api/invoices/${id}`)).body.balanceCents).toBe(6000);
    await request(app).delete(`/api/payments/${pay.body.id}`).expect(200);
    expect((await request(app).get(`/api/invoices/${id}`)).body.balanceCents).toBe(10000);
  });

  it('change orders + project billing summary rollup', async () => {
    // set a base contract value via PATCH project
    await request(app).patch('/api/projects/p1').send({ version: 1, /* contractValue not in patch — set directly */ });
    db.prepare('UPDATE projects SET contractValue = 10000 WHERE id = ?').run('p1');
    const co = await request(app).post('/api/projects/p1/change-orders').send({ number: 'CO-1', description: 'Extra', amount: 2000 });
    await request(app).patch(`/api/change-orders/${co.body.id}`).send({ status: 'approved' });
    const summary = await request(app).get('/api/projects/p1/billing-summary');
    expect(summary.body.contractValueCents).toBe(1200000); // 10000 + 2000
  });

  it('rejects non-admins with 403', async () => {
    // re-register routes with a requireAdmin that denies — simulate a member
    const memberApp = express();
    memberApp.use(express.json());
    registerDataRoutes(memberApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'm1', role: 'member' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
    });
    expect((await request(memberApp).get('/api/projects/p1/invoices')).status).toBe(403);
    expect((await request(memberApp).post('/api/projects/p1/invoices').send({ lines: [] })).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes.test.ts`
Expected: FAIL — billing routes missing.

- [ ] **Step 3: Implement the routes in `server/routes.ts`**

Add to the `./billingStore` import at the top:

```ts
import {
  listInvoices, getInvoice, createInvoice, saveInvoice, deleteInvoice,
  recordPayment, deletePayment, setInvoiceStatus,
  listChangeOrders, createChangeOrder, setChangeOrderStatus, deleteChangeOrder,
  billingSummary,
  ValidationError as BillingValidationError, ConflictError as BillingConflictError, NotFoundError as BillingNotFoundError,
} from './billingStore';
```

Add a shared error mapper and the routes (place them together, e.g. after the project routes block). Every route is `authenticateToken, requireAdmin`:

```ts
  // ── Billing (admin only, spec §4.1/§4.3) ──────────────────────────────────
  const billingErr = (e: unknown, res: express.Response) => {
    if (e instanceof BillingNotFoundError) return res.status(404).json({ error: e.message });
    if (e instanceof BillingConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
    if (e instanceof BillingValidationError) return res.status(400).json({ error: e.message });
    console.error('Billing error:', e);
    return res.status(500).json({ error: 'Billing operation failed' });
  };

  app.get('/api/projects/:id/invoices', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(listInvoices(db, req.params.id)); } catch (e) { billingErr(e, res); }
  });
  app.post('/api/projects/:id/invoices', authenticateToken, requireAdmin, (req, res) => {
    try {
      const r = createInvoice(db, req.params.id, req.body);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'invoice_created', message: `Invoice ${req.body?.number ?? ''} created` });
      res.json(r);
    } catch (e) { billingErr(e, res); }
  });
  app.get('/api/invoices/:id', authenticateToken, requireAdmin, (req, res) => {
    try { const inv = getInvoice(db, req.params.id); if (!inv) return res.status(404).json({ error: 'Invoice not found' }); res.json(inv); } catch (e) { billingErr(e, res); }
  });
  app.put('/api/invoices/:id', authenticateToken, requireAdmin, (req, res) => {
    try { res.json({ success: true, ...saveInvoice(db, req.params.id, req.body) }); } catch (e) { billingErr(e, res); }
  });
  app.patch('/api/invoices/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      const r = setInvoiceStatus(db, req.params.id, req.body.status);
      res.json({ success: true, ...r });
    } catch (e) { billingErr(e, res); }
  });
  app.delete('/api/invoices/:id', authenticateToken, requireAdmin, (req, res) => {
    try { deleteInvoice(db, req.params.id); res.json({ success: true }); } catch (e) { billingErr(e, res); }
  });

  app.post('/api/invoices/:id/payments', authenticateToken, requireAdmin, (req, res) => {
    try {
      const r = recordPayment(db, req.params.id, req.body);
      logActivity(db, { userId: (req as any).user?.id, type: 'payment_recorded', message: `Payment of $${Number(req.body?.amount ?? 0).toFixed(2)} recorded` });
      res.json(r);
    } catch (e) { billingErr(e, res); }
  });
  app.delete('/api/payments/:id', authenticateToken, requireAdmin, (req, res) => {
    try { deletePayment(db, req.params.id); res.json({ success: true }); } catch (e) { billingErr(e, res); }
  });

  app.get('/api/projects/:id/change-orders', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(listChangeOrders(db, req.params.id)); } catch (e) { billingErr(e, res); }
  });
  app.post('/api/projects/:id/change-orders', authenticateToken, requireAdmin, (req, res) => {
    try {
      const r = createChangeOrder(db, req.params.id, req.body);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'change_order_created', message: `Change order ${req.body?.number ?? ''} created` });
      res.json(r);
    } catch (e) { billingErr(e, res); }
  });
  app.patch('/api/change-orders/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      const r = setChangeOrderStatus(db, req.params.id, req.body.status);
      if (req.body.status === 'approved') logActivity(db, { userId: (req as any).user?.id, type: 'change_order_approved', message: 'Change order approved' });
      res.json({ success: true, ...r });
    } catch (e) { billingErr(e, res); }
  });
  app.delete('/api/change-orders/:id', authenticateToken, requireAdmin, (req, res) => {
    try { deleteChangeOrder(db, req.params.id); res.json({ success: true }); } catch (e) { billingErr(e, res); }
  });

  app.get('/api/projects/:id/billing-summary', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(billingSummary(db, req.params.id)); } catch (e) { billingErr(e, res); }
  });
```

(`logActivity` and `express` are already imported in routes.ts. The `billing_summary`/invoice/CO routes use `:id` literal-vs-param ordering that doesn't clash with existing routes — distinct path heads.)

- [ ] **Step 4: Run to verify pass** (this also turns Task 1's cascade HTTP test green)

Run: `npx vitest run server/routes.test.ts server/billingStore.test.ts && npm run lint`
Expected: PASS — billing routes + the deferred delete-cascade test from Task 1 now green.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/routes.test.ts
git commit -m "feat: billing routes (admin-gated) with activity logging"
```

---

### Task 6: Surface Contract Value on Project Summary + Overview

**Files:**
- Modify: `server/projectStore.ts` (`listProjectSummaries` adds contractValue + invoiceCount)
- Modify: `server/routes.test.ts` (extend a summary test)
- Modify: `src/utils/store.ts` (ProjectSummary type)
- Modify: `src/pages/project/ProjectOverview.tsx` (show contract value, admin only)

- [ ] **Step 1: Extend the summary test** (append to the existing `GET /api/projects/:id/summary` describe in `server/routes.test.ts`)

```ts
  it('includes contractValueCents (base + approved COs) and invoiceCount', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'pc' });
    db.prepare('UPDATE projects SET contractValue = 5000 WHERE id = ?').run('pc');
    const co = await request(app).post('/api/projects/pc/change-orders').send({ number: 'CO-1', amount: 1000 });
    await request(app).patch(`/api/change-orders/${co.body.id}`).send({ status: 'approved' });
    await request(app).post('/api/projects/pc/invoices').send({ number: 'INV-1', lines: [] });
    const res = await request(app).get('/api/projects/pc/summary');
    expect(res.body.contractValueCents).toBe(600000); // 5000 + 1000
    expect(res.body.invoiceCount).toBe(1);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes.test.ts`
Expected: FAIL — summary lacks the fields.

- [ ] **Step 3: Extend `listProjectSummaries` in `server/projectStore.ts`**

Add `import { billingSummary } from './billingStore';` at the top. In the `.map(r => ({...}))` return, add two fields computed from a per-row billingSummary call:

```ts
  return rows.map(r => {
    const bs = billingSummary(db, r.id);
    return {
      id: r.id,
      name: r.name ?? 'Untitled',
      // ...all existing fields unchanged...
      pageCount: pageIdsByProject.get(r.id)?.length ?? 0,
      takeoffCount: takeoffCounts.get(r.id) ?? 0,
      pageIds: pageIdsByProject.get(r.id) ?? [],
      contractValueCents: bs.contractValueCents,
      invoiceCount: bs.invoiceCount,
    };
  });
```

(Keep every existing field; only the two new lines are added. This adds a few cheap queries per project — fine at this scale; the single-id summary path is the common one.)

- [ ] **Step 4: Add the fields to the client `ProjectSummary` type** (`src/utils/store.ts`)

In the `ProjectSummary` interface, add:

```ts
  contractValueCents: number;
  invoiceCount: number;
```

- [ ] **Step 5: Surface contract value in the Overview Details card** (`src/pages/project/ProjectOverview.tsx`)

Add `import { formatMoney } from '../../utils/money';` (created in Task 7). Determine admin once near the top of the component:

```ts
  const isAdmin = (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';
```

In the Details card `<dl>`, after the page/takeoff counts row, add (admin only — members never see pricing):

```tsx
                {isAdmin && summary.contractValueCents > 0 && (
                  <div className="flex items-center gap-2 pt-1 text-ink">
                    <DollarSign size={14} className="text-ink-faint" />
                    Contract value: <span className="font-semibold">{formatMoney(summary.contractValueCents)}</span>
                  </div>
                )}
```

Add `DollarSign` to the lucide import in ProjectOverview.

- [ ] **Step 6: Verify** (money.ts lands in Task 7 — so build the import now but expect a missing-module until Task 7; do Task 7 BEFORE re-running lint here. To keep this task self-contained, create a minimal `src/utils/money.ts` stub now with `formatMoney` only, which Task 7 expands + tests.)

Create `src/utils/money.ts`:

```ts
// Cents → display dollars. Full helpers + tests land in Task 7.
export const formatMoney = (cents: number): string =>
  (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
```

Run: `npx vitest run server/routes.test.ts && npm run lint`
Expected: server summary test PASS; lint clean.

- [ ] **Step 7: Commit**

```bash
git add server/projectStore.ts server/routes.test.ts src/utils/store.ts src/pages/project/ProjectOverview.tsx src/utils/money.ts
git commit -m "feat: surface contract value + invoice count on project summary and overview"
```

---

### Task 7: Client Money Helpers + Store Helpers

**Files:**
- Modify: `src/utils/money.ts` (expand the Task 6 stub)
- Create: `src/utils/money.test.ts`
- Modify: `src/utils/store.ts` (billing types + helpers)

- [ ] **Step 1: Write the failing money tests**

```ts
// src/utils/money.test.ts
import { describe, it, expect } from 'vitest';
import { formatMoney, dollarsToCents, centsToDollars } from './money';

describe('money helpers', () => {
  it('formatMoney renders cents as USD', () => {
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(12550)).toBe('$125.50');
    expect(formatMoney(-3450)).toBe('-$34.50');
  });
  it('dollarsToCents rounds half-up and tolerates strings', () => {
    expect(dollarsToCents(10)).toBe(1000);
    expect(dollarsToCents('10.005')).toBe(1001);
    expect(dollarsToCents('')).toBe(0);
    expect(dollarsToCents(0.1 + 0.2)).toBe(30);
  });
  it('centsToDollars returns a number for form fields', () => {
    expect(centsToDollars(12550)).toBe(125.5);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/utils/money.test.ts`
Expected: FAIL — `dollarsToCents`/`centsToDollars` not exported.

- [ ] **Step 3: Expand `src/utils/money.ts`**

```ts
// src/utils/money.ts
// Money helpers — the server is the source of truth for totals (cents); these
// format for display and convert form input. Never sum dollar floats in the UI.

export const formatMoney = (cents: number): string =>
  (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });

export const dollarsToCents = (dollars: number | string): number => {
  const n = typeof dollars === 'string' ? parseFloat(dollars) : dollars;
  return Math.round((Number.isFinite(n) ? n : 0) * 100);
};

export const centsToDollars = (cents: number): number => cents / 100;
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/utils/money.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Append billing types + helpers to `src/utils/store.ts`**

```ts
// ── Phase 4a: billing ────────────────────────────────────────────────────────

export interface InvoiceLine {
  id?: string;
  description: string;
  qty: number;
  unitPrice: number;
}
export interface Payment {
  id: string;
  date: number | null;
  amount: number;
  method: string | null;
  note: string | null;
}
export interface Invoice {
  id: string;
  projectId: string;
  number: string | null;
  date: number | null;
  status: string; // draft | sent | paid
  terms: string | null;
  version: number;
  createdAt: number;
  lines: InvoiceLine[];
  payments: Payment[];
  totalCents: number;
  paidCents: number;
  balanceCents: number;
}
export interface InvoiceListItem {
  id: string; projectId: string; number: string | null; date: number | null;
  status: string; terms: string | null; version: number; createdAt: number;
  totalCents: number; paidCents: number; balanceCents: number;
}
export interface ChangeOrder {
  id: string; projectId: string; number: string | null; description: string | null;
  amount: number; status: string; createdAt: number; // pending | approved | rejected
}
export interface BillingSummary {
  baseContractCents: number; approvedChangeCents: number; contractValueCents: number;
  invoicedCents: number; paidCents: number; outstandingCents: number;
  invoiceCount: number; changeOrderCount: number;
}
export interface InvoiceInput {
  number?: string; date?: number | null; terms?: string; status?: string;
  lines: { description: string; qty: number; unitPrice: number }[];
}

const billingJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getInvoices = async (projectId: string): Promise<InvoiceListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/invoices`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getInvoice = async (id: string): Promise<Invoice> => {
  const res = await fetchWithRetry(`/api/invoices/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createInvoice = async (projectId: string, input: InvoiceInput): Promise<{ id: string; version: number }> => {
  const res = await billingJson('POST', `/api/projects/${projectId}/invoices`, input);
  await handleResponse(res); return res.json();
};
export const saveInvoice = async (id: string, invoice: Invoice): Promise<{ version: number }> => {
  const res = await billingJson('PUT', `/api/invoices/${id}`, invoice);
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setInvoiceStatus = async (id: string, status: string): Promise<{ version: number }> => {
  const res = await billingJson('PATCH', `/api/invoices/${id}`, { status });
  await handleResponse(res); return res.json();
};
export const deleteInvoice = async (id: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/invoices/${id}`); await handleResponse(res);
};
export const recordPayment = async (invoiceId: string, p: { amount: number; date?: number; method?: string; note?: string }): Promise<{ id: string }> => {
  const res = await billingJson('POST', `/api/invoices/${invoiceId}/payments`, p);
  await handleResponse(res); return res.json();
};
export const deletePayment = async (id: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/payments/${id}`); await handleResponse(res);
};
export const getChangeOrders = async (projectId: string): Promise<ChangeOrder[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/change-orders`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createChangeOrder = async (projectId: string, co: { number?: string; description?: string; amount: number }): Promise<{ id: string }> => {
  const res = await billingJson('POST', `/api/projects/${projectId}/change-orders`, co);
  await handleResponse(res); return res.json();
};
export const setChangeOrderStatus = async (id: string, status: string): Promise<void> => {
  const res = await billingJson('PATCH', `/api/change-orders/${id}`, { status }); await handleResponse(res);
};
export const deleteChangeOrder = async (id: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/change-orders/${id}`); await handleResponse(res);
};
export const getBillingSummary = async (projectId: string): Promise<BillingSummary> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/billing-summary`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
```

- [ ] **Step 6: Verify and commit**

Run: `npm run lint && npm test`
Expected: clean / green.

```bash
git add src/utils/money.ts src/utils/money.test.ts src/utils/store.ts
git commit -m "feat: client money helpers and billing store helpers"
```

---

### Task 8: Billing Status Pills

**Files:**
- Create: `src/components/ui/BillingPills.tsx`
- Test: `src/components/ui/BillingPills.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/ui/BillingPills.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InvoiceStatusPill, ChangeOrderStatusPill, INVOICE_STATUS_META, CO_STATUS_META } from './BillingPills';

describe('billing pills', () => {
  it('maps every invoice + change-order status', () => {
    for (const s of ['draft', 'sent', 'paid']) expect(INVOICE_STATUS_META[s], s).toBeDefined();
    for (const s of ['pending', 'approved', 'rejected']) expect(CO_STATUS_META[s], s).toBeDefined();
  });
  it('renders labels', () => {
    render(<><InvoiceStatusPill status="sent" /><ChangeOrderStatusPill status="approved" /></>);
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });
  it('falls back to slate for unknown statuses (prototype-safe)', () => {
    render(<InvoiceStatusPill status="constructor" />);
    expect(screen.getByText('constructor').className).toContain('slate');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/ui/BillingPills.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```tsx
// src/components/ui/BillingPills.tsx
import React from 'react';
import { StatusPill, PillTone } from './StatusPill';

export const INVOICE_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  draft: { label: 'Draft', tone: 'slate' },
  sent:  { label: 'Sent',  tone: 'blue' },
  paid:  { label: 'Paid',  tone: 'emerald' },
};

export const CO_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  pending:  { label: 'Pending',  tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
};

const pillFrom = (
  meta: Record<string, { label: string; tone: PillTone }>,
  status?: string | null,
  className?: string
) => {
  const entry = status != null && Object.hasOwn(meta, status) ? meta[status] : null;
  const m = entry ?? { label: status || 'Unknown', tone: 'slate' as PillTone };
  return <StatusPill tone={m.tone} className={className}>{m.label}</StatusPill>;
};

export const InvoiceStatusPill: React.FC<{ status?: string | null; className?: string }> = ({ status, className }) =>
  pillFrom(INVOICE_STATUS_META, status, className);

export const ChangeOrderStatusPill: React.FC<{ status?: string | null; className?: string }> = ({ status, className }) =>
  pillFrom(CO_STATUS_META, status, className);
```

(`PillTone` is exported from `StatusPill.tsx` — confirm; it is per Phase 2. `Object.hasOwn` guards prototype keys, matching the StatusPill fix from Phase 2.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/ui/BillingPills.test.tsx && npm run lint`
Expected: PASS (3 tests), clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/BillingPills.tsx src/components/ui/BillingPills.test.tsx
git commit -m "feat: invoice and change-order status pills"
```

---

### Task 9: ProjectBilling Section Page + Invoice Editor

**Files:**
- Create: `src/pages/project/ProjectBilling.tsx`
- Create: `src/pages/project/billing/InvoiceEditor.tsx`
- Create: `src/pages/project/ProjectBilling.test.tsx` (pure-helper test)
- Modify: `src/App.tsx` (route)
- Modify: `src/components/shell/Sidebar.tsx` (admin-only nav)
- Modify: `src/components/shell/Sidebar.test.tsx`

This is the admin-only Billing section: contract rollup header, invoices list (open the editor), change orders list with approve/reject, and an invoice editor modal (header + line items + payments). The invoice PDF + send buttons are wired in Tasks 10–11.

- [ ] **Step 1: Write the failing helper test** (the page extracts a small pure helper for line-total display so it's unit-testable without rendering the FortuneSheet-free modal)

```tsx
// src/pages/project/ProjectBilling.test.tsx
import { describe, it, expect } from 'vitest';
import { lineCents, draftTotalCents } from './ProjectBilling';

describe('invoice draft math', () => {
  it('lineCents rounds a single line to cents', () => {
    expect(lineCents({ description: 'x', qty: 2.5, unitPrice: 4 })).toBe(1000);
    expect(lineCents({ description: 'x', qty: 1, unitPrice: 25.5 })).toBe(2550);
  });
  it('draftTotalCents sums lines with no float drift', () => {
    expect(draftTotalCents([
      { description: 'a', qty: 1, unitPrice: 0.1 },
      { description: 'b', qty: 1, unitPrice: 0.1 },
      { description: 'c', qty: 1, unitPrice: 0.1 },
    ])).toBe(30);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/project/ProjectBilling.test.tsx`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Implement `src/pages/project/billing/InvoiceEditor.tsx`**

```tsx
// src/pages/project/billing/InvoiceEditor.tsx
import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Invoice, InvoiceLine, recordPayment, deletePayment, saveInvoice } from '../../../utils/store';
import { dollarsToCents, formatMoney } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, Select, Table, TBody, TD, TH, THead, TR } from '../../../components/ui';

export const lineCents = (l: { qty: number; unitPrice: number }): number =>
  Math.round((Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * 100);
export const draftTotalCents = (lines: { qty: number; unitPrice: number }[]): number =>
  lines.reduce((a, l) => a + lineCents(l), 0);

export const InvoiceEditor: React.FC<{
  invoice: Invoice;
  onClose: () => void;
  onSaved: () => void;
}> = ({ invoice, onClose, onSaved }) => {
  const { toast } = useToast();
  const [number, setNumber] = useState(invoice.number ?? '');
  const [terms, setTerms] = useState(invoice.terms ?? '');
  const [date, setDate] = useState(invoice.date ? new Date(invoice.date).toISOString().slice(0, 10) : '');
  const [lines, setLines] = useState<InvoiceLine[]>(invoice.lines.length ? invoice.lines : []);
  const [saving, setSaving] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('check');

  const total = draftTotalCents(lines);
  const paid = invoice.paidCents;
  const balance = total - paid;

  const setLine = (i: number, patch: Partial<InvoiceLine>) =>
    setLines(prev => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines(prev => [...prev, { description: '', qty: 1, unitPrice: 0 }]);
  const removeLine = (i: number) => setLines(prev => prev.filter((_, idx) => idx !== i));

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveInvoice(invoice.id, {
        ...invoice,
        number: number || null,
        terms: terms || null,
        date: date ? new Date(date).getTime() : null,
        lines: lines.map(l => ({ description: l.description, qty: Number(l.qty) || 0, unitPrice: Number(l.unitPrice) || 0 })),
      });
      toast('Invoice saved', { type: 'success' });
      onSaved();
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'Invoice changed elsewhere — reopen it' : 'Save failed', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleAddPayment = async () => {
    const amount = parseFloat(payAmount);
    if (!(amount > 0)) { toast('Enter a positive amount', { type: 'warning' }); return; }
    try {
      await recordPayment(invoice.id, { amount, method: payMethod });
      toast('Payment recorded', { type: 'success' });
      setPayAmount('');
      onSaved(); // reloads the invoice (parent refetches)
    } catch { toast('Failed to record payment', { type: 'error' }); }
  };

  return (
    <Modal open onClose={onClose} title={`Invoice ${invoice.number ?? ''}`} width="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save invoice'}</Button>
      </>}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Number" htmlFor="inv-num"><Input id="inv-num" value={number} onChange={e => setNumber(e.target.value)} /></Field>
        <Field label="Date" htmlFor="inv-date"><Input id="inv-date" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label="Terms" htmlFor="inv-terms"><Input id="inv-terms" value={terms} onChange={e => setTerms(e.target.value)} placeholder="Net 30" /></Field>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Line items</h4>
          <Button variant="ghost" size="sm" onClick={addLine}><Plus size={14} />Add line</Button>
        </div>
        <Table>
          <THead><TR><TH>Description</TH><TH>Qty</TH><TH>Unit price</TH><TH>Amount</TH><TH></TH></TR></THead>
          <TBody>
            {lines.map((l, i) => (
              <TR key={i}>
                <TD><Input value={l.description} onChange={e => setLine(i, { description: e.target.value })} /></TD>
                <TD className="w-20"><Input type="number" value={String(l.qty)} onChange={e => setLine(i, { qty: parseFloat(e.target.value) || 0 })} /></TD>
                <TD className="w-28"><Input type="number" value={String(l.unitPrice)} onChange={e => setLine(i, { unitPrice: parseFloat(e.target.value) || 0 })} /></TD>
                <TD className="text-ink-soft">{formatMoney(lineCents(l))}</TD>
                <TD><button onClick={() => removeLine(i)} title="Remove" className="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>

      <div className="mt-4 flex justify-end gap-6 border-t border-edge pt-3 text-sm">
        <div className="text-right">
          <div className="text-ink-soft">Total <span className="ml-2 font-semibold text-ink">{formatMoney(total)}</span></div>
          <div className="text-ink-soft">Paid <span className="ml-2 font-semibold text-ink">{formatMoney(paid)}</span></div>
          <div className="text-ink-soft">Balance <span className="ml-2 font-semibold text-ink">{formatMoney(balance)}</span></div>
        </div>
      </div>

      <div className="mt-4 border-t border-edge pt-3">
        <h4 className="mb-2 text-sm font-semibold text-ink">Payments</h4>
        {invoice.payments.length > 0 && (
          <ul className="mb-2 space-y-1 text-sm">
            {invoice.payments.map(p => (
              <li key={p.id} className="flex items-center justify-between text-ink-soft">
                <span>{formatMoney(Math.round(p.amount * 100))}{p.method ? ` · ${p.method}` : ''}{p.date ? ` · ${new Date(p.date).toLocaleDateString()}` : ''}</span>
                <button onClick={async () => { await deletePayment(p.id); onSaved(); }} title="Delete payment" className="text-ink-faint hover:text-red-600"><Trash2 size={13} /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <Field label="Amount" htmlFor="pay-amt"><Input id="pay-amt" type="number" value={payAmount} onChange={e => setPayAmount(e.target.value)} placeholder="0.00" /></Field>
          <Field label="Method" htmlFor="pay-method">
            <Select id="pay-method" value={payMethod} onChange={e => setPayMethod(e.target.value)}>
              <option value="check">Check</option><option value="card">Card</option><option value="cash">Cash</option><option value="ach">ACH</option><option value="other">Other</option>
            </Select>
          </Field>
          <Button variant="secondary" onClick={handleAddPayment}>Record payment</Button>
        </div>
      </div>
    </Modal>
  );
};
```

- [ ] **Step 4: Implement `src/pages/project/ProjectBilling.tsx`** (re-exports lineCents/draftTotalCents for the test)

```tsx
// src/pages/project/ProjectBilling.tsx
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { DollarSign, FileText, Plus, Trash2, ShieldAlert } from 'lucide-react';
import {
  BillingSummary, ChangeOrder, Invoice, InvoiceListItem,
  getBillingSummary, getInvoices, getInvoice, createInvoice, deleteInvoice, setInvoiceStatus,
  getChangeOrders, createChangeOrder, setChangeOrderStatus, deleteChangeOrder,
} from '../../utils/store';
import { dollarsToCents, formatMoney } from '../../utils/money';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../components/ui';
import { InvoiceStatusPill, ChangeOrderStatusPill } from '../../components/ui/BillingPills';
import { InvoiceEditor } from './billing/InvoiceEditor';

export { lineCents, draftTotalCents } from './billing/InvoiceEditor';

const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';

export const ProjectBilling: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [invoices, setInvoices] = useState<InvoiceListItem[] | null>(null);
  const [changeOrders, setChangeOrders] = useState<ChangeOrder[] | null>(null);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [coNumber, setCoNumber] = useState('');
  const [coDesc, setCoDesc] = useState('');
  const [coAmount, setCoAmount] = useState('');

  const admin = isAdmin();

  const load = () => {
    if (!projectId || !admin) return;
    getBillingSummary(projectId).then(setSummary).catch(() => setSummary(null));
    getInvoices(projectId).then(setInvoices).catch(() => setInvoices([]));
    getChangeOrders(projectId).then(setChangeOrders).catch(() => setChangeOrders([]));
  };
  useEffect(load, [projectId, admin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!admin) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 md:px-8">
        <EmptyState icon={<ShieldAlert size={22} />} title="Billing is admin-only"
          description="Ask an administrator for access to invoices and change orders." />
      </div>
    );
  }

  const openInvoice = async (id: string) => {
    try { setEditing(await getInvoice(id)); } catch { toast('Failed to open invoice', { type: 'error' }); }
  };
  const newInvoice = async () => {
    if (!projectId) return;
    try {
      const r = await createInvoice(projectId, { number: '', lines: [] });
      const inv = await getInvoice(r.id);
      setEditing(inv);
      load();
    } catch { toast('Failed to create invoice', { type: 'error' }); }
  };
  const removeInvoice = async (id: string) => {
    if (!(await confirm({ title: 'Delete invoice?', message: 'This permanently removes the invoice and its payments.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try { await deleteInvoice(id); load(); } catch { toast('Delete failed', { type: 'error' }); }
  };
  const cycleStatus = async (inv: InvoiceListItem) => {
    const next = inv.status === 'draft' ? 'sent' : inv.status === 'sent' ? 'paid' : 'draft';
    try { await setInvoiceStatus(inv.id, next); load(); } catch { toast('Status update failed', { type: 'error' }); }
  };
  const addChangeOrder = async () => {
    if (!projectId) return;
    const amount = parseFloat(coAmount);
    if (!Number.isFinite(amount)) { toast('Enter an amount', { type: 'warning' }); return; }
    try {
      await createChangeOrder(projectId, { number: coNumber || undefined, description: coDesc || undefined, amount });
      setCoNumber(''); setCoDesc(''); setCoAmount(''); load();
    } catch { toast('Failed to add change order', { type: 'error' }); }
  };
  const coStatus = async (id: string, status: string) => {
    try { await setChangeOrderStatus(id, status); load(); } catch { toast('Update failed', { type: 'error' }); }
  };
  const removeCo = async (id: string) => {
    try { await deleteChangeOrder(id); load(); } catch { toast('Delete failed', { type: 'error' }); }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <h1 className="mb-4 text-xl font-bold text-ink">Billing</h1>

      {/* Contract rollup */}
      <Card className="mb-5">
        <CardHeader title="Contract" actions={<DollarSign size={15} className="text-ink-faint" />} />
        <CardBody>
          {summary === null ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              {[
                ['Contract value', summary.contractValueCents],
                ['Invoiced', summary.invoicedCents],
                ['Paid', summary.paidCents],
                ['Outstanding', summary.outstandingCents],
              ].map(([label, cents]) => (
                <div key={label as string}>
                  <div className="text-ink-faint">{label}</div>
                  <div className="text-lg font-bold text-ink">{formatMoney(cents as number)}</div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Invoices */}
      <Card className="mb-5">
        <CardHeader title="Invoices" actions={<Button size="sm" onClick={newInvoice}><Plus size={14} />New invoice</Button>} />
        <CardBody className="p-0">
          {invoices === null ? (
            <div className="space-y-2 p-4">{[0, 1].map(i => <Skeleton key={i} className="h-9" />)}</div>
          ) : invoices.length === 0 ? (
            <EmptyState icon={<FileText size={20} />} title="No invoices yet" description="Create an invoice to bill against this project." />
          ) : (
            <Table>
              <THead><TR><TH>Number</TH><TH>Status</TH><TH>Total</TH><TH>Balance</TH><TH></TH></TR></THead>
              <TBody>
                {invoices.map(inv => (
                  <TR key={inv.id} interactive onClick={() => openInvoice(inv.id)}>
                    <TD className="font-medium text-ink">{inv.number || '(untitled)'}</TD>
                    <TD onClick={e => { e.stopPropagation(); cycleStatus(inv); }}><InvoiceStatusPill status={inv.status} /></TD>
                    <TD className="text-ink-soft">{formatMoney(inv.totalCents)}</TD>
                    <TD className="text-ink-soft">{formatMoney(inv.balanceCents)}</TD>
                    <TD onClick={e => e.stopPropagation()}><button onClick={() => removeInvoice(inv.id)} title="Delete" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {/* Change orders */}
      <Card>
        <CardHeader title="Change orders" />
        <CardBody>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <Field label="Number" htmlFor="co-num"><Input id="co-num" value={coNumber} onChange={e => setCoNumber(e.target.value)} className="w-28" /></Field>
            <Field label="Description" htmlFor="co-desc"><Input id="co-desc" value={coDesc} onChange={e => setCoDesc(e.target.value)} className="w-56" /></Field>
            <Field label="Amount" htmlFor="co-amt"><Input id="co-amt" type="number" value={coAmount} onChange={e => setCoAmount(e.target.value)} className="w-28" placeholder="0.00" /></Field>
            <Button variant="secondary" onClick={addChangeOrder}><Plus size={14} />Add</Button>
          </div>
          {changeOrders === null ? (
            <Skeleton className="h-9" />
          ) : changeOrders.length === 0 ? (
            <p className="text-sm text-ink-faint">No change orders. Approved change orders increase the contract value.</p>
          ) : (
            <Table>
              <THead><TR><TH>Number</TH><TH>Description</TH><TH>Amount</TH><TH>Status</TH><TH></TH></TR></THead>
              <TBody>
                {changeOrders.map(co => (
                  <TR key={co.id}>
                    <TD className="font-medium text-ink">{co.number || '—'}</TD>
                    <TD className="text-ink-soft">{co.description || '—'}</TD>
                    <TD className="text-ink-soft">{formatMoney(Math.round(co.amount * 100))}</TD>
                    <TD><ChangeOrderStatusPill status={co.status} /></TD>
                    <TD>
                      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                        {co.status !== 'approved' && <button onClick={() => coStatus(co.id, 'approved')} className="rounded px-2 py-0.5 text-xs text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20">Approve</button>}
                        {co.status !== 'rejected' && <button onClick={() => coStatus(co.id, 'rejected')} className="rounded px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20">Reject</button>}
                        <button onClick={() => removeCo(co.id)} title="Delete" className="rounded p-1 text-ink-faint hover:text-red-600"><Trash2 size={13} /></button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {editing && (
        <InvoiceEditor
          invoice={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            // reload the open invoice (payments/lines) and the lists
            try { setEditing(await getInvoice(editing.id)); } catch { setEditing(null); }
            load();
          }}
        />
      )}
    </div>
  );
};
```

- [ ] **Step 5: Run the helper test**

Run: `npx vitest run src/pages/project/ProjectBilling.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Add the route + admin-only sidebar nav**

In `src/App.tsx`, import `ProjectBilling` and add a child route under the project tree, after `time`:

```tsx
            { path: 'billing', element: <ProjectBilling /> },
```

In `src/components/shell/Sidebar.tsx`: add `DollarSign` to the lucide import. The PROJECT_NAV is currently a static array — to hide Billing from members, compute the visible list inside the component from the user's role. Replace the `PROJECT_NAV.map(...)` consumption so it filters by an `adminOnly` flag. Add this entry to PROJECT_NAV:

```tsx
  { id: 'billing', label: 'Billing', Icon: DollarSign, path: '/billing', match: (p, b) => p.startsWith(`${b}/billing`), adminOnly: true },
```

Extend the PROJECT_NAV item type with `adminOnly?: boolean`, and where the component maps PROJECT_NAV, gate it:

```tsx
  const isAdmin = (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';
  // ...
              {PROJECT_NAV.filter(item => !item.adminOnly || isAdmin).map(item => {
                const base = `/project/${projectId}`;
                // ...existing NavRow render...
              })}
```

- [ ] **Step 7: Update Sidebar tests** (`src/components/shell/Sidebar.test.tsx`)

The project-mode helper seeds `localStorage.user`. Add two tests:

```tsx
  it('shows Billing for admins', () => {
    localStorage.setItem('user', JSON.stringify({ username: 'a', role: 'admin' }));
    renderProject('/project/p1');
    expect(screen.getByRole('button', { name: /Billing/ })).toBeInTheDocument();
  });

  it('hides Billing for members', () => {
    localStorage.setItem('user', JSON.stringify({ username: 'm', role: 'member' }));
    renderProject('/project/p1');
    expect(screen.queryByRole('button', { name: /Billing/ })).not.toBeInTheDocument();
  });
```

(If the existing project-mode `beforeEach` sets `user` with no role, these explicit sets override it for the two cases. Confirm the other project-mode tests still pass — they don't assert on Billing.)

- [ ] **Step 8: Verify and commit**

Run: `npx vitest run src/pages/project src/components/shell && npm run lint && npm test`
Expected: all green. Boot check: as admin, open a project → Billing in the sidebar → create an invoice, add lines (totals update), record a payment (balance drops), cycle status, add+approve a change order (contract value rises). Log in as a member (or flip localStorage user.role) → Billing hidden from nav; visiting `/project/:id/billing` shows the access-denied panel; the API returns 403.

```bash
git add src/pages/project/ProjectBilling.tsx src/pages/project/billing/InvoiceEditor.tsx src/pages/project/ProjectBilling.test.tsx src/App.tsx src/components/shell/Sidebar.tsx src/components/shell/Sidebar.test.tsx
git commit -m "feat: project billing section — invoices, payments, change orders (admin only)"
```

---

### Task 10: Invoice PDF Generator 🎨 (Design Checkpoint)

**Files:**
- Create: `src/pages/project/billing/invoicePdf.ts`
- Modify: `src/pages/project/billing/InvoiceEditor.tsx` (Download PDF button)

> **🎨 CONTROLLER CHECKPOINT — DO THIS BEFORE DISPATCHING THE IMPLEMENTER.**
> The invoice PDF is a visual artifact Nathan asked to decide on together. The controller (orchestrator) MUST, before any code:
> 1. Present Nathan with 2–3 invoice-layout options via `AskUserQuestion` (single-select, with `preview` ASCII mockups showing header/logo placement, the bill-to/from block, the line-item table, the totals block, and the terms/footer). Cover at least: **(A) Classic top-logo + right-aligned totals**, **(B) Left sidebar accent band with company block**, **(C) Minimal centered header**. Pull real fields into the mockups: company name/logo from `settings` (`appName`, `logoUrl`), project name/contractor/address, invoice number/date/terms, line items, total/paid/balance.
> 2. Ask any open specifics surfaced by his choice (accent color usage, whether to show "Paid"/"Balance Due" stamp, page size Letter vs A4).
> 3. Pass the chosen layout + answers verbatim into the implementer's prompt as the concrete spec for `invoicePdf.ts`. The code block below is the STRUCTURE/skeleton; the visual specifics come from Nathan's pick.
>
> **✅ CHECKPOINT RESOLVED (2026-06-12):** Nathan chose **Layout A (Classic top-left logo + company block, INVOICE + meta top-right, BILL TO block, full-width line table, totals stacked bottom-right with bold Balance Due)**. Specifics: **PAID stamp** (green) overlaid when balance is $0 and total > 0; **Letter** size (8.5×11); **accent color follows the app theme** (resolved live from the `--color-accent-600` CSS var → RGB) for the INVOICE title, table-header underline, and totals rule. Company contact (name/address/phone/email) comes from `getSettings()` (`appName`, `companyAddress`, `companyPhone`, `companyEmail`, `logoUrl`). The generator below is the FINAL Layout-A spec.

**Settings note:** company branding comes from `getSettings()` (`appName`, `logoUrl`). `logoUrl` may be a dataURL or an `/api/images/:id/raw` path — jsPDF `addImage` accepts a dataURL; for a URL, fetch→dataURL first (the generator handles both).

- [ ] **Step 1: Write a failing test for the pure layout helper** (the money/line formatting used by the PDF is unit-testable even though jsPDF drawing isn't)

```ts
// src/pages/project/billing/invoicePdf.test.ts
import { describe, it, expect } from 'vitest';
import { invoiceRows, invoiceTotalsBlock } from './invoicePdf';

describe('invoice pdf data shaping', () => {
  it('invoiceRows maps lines to [desc, qty, unit, amount] display strings', () => {
    const rows = invoiceRows([{ description: 'Drywall', qty: 2, unitPrice: 50 }]);
    expect(rows[0]).toEqual(['Drywall', '2', '$50.00', '$100.00']);
  });
  it('invoiceTotalsBlock formats total/paid/balance from cents', () => {
    expect(invoiceTotalsBlock(12550, 5000)).toEqual([
      ['Total', '$125.50'], ['Paid', '$50.00'], ['Balance Due', '$75.50'],
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/project/billing/invoicePdf.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/pages/project/billing/invoicePdf.ts`** (skeleton — the DRAWING follows Nathan's chosen layout from the checkpoint; the data-shaping helpers below are fixed)

```ts
// src/pages/project/billing/invoicePdf.ts
import { jsPDF } from 'jspdf';
import { Invoice } from '../../../utils/store';
import { formatMoney } from '../../../utils/money';

const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : String(n));

// Pure data-shaping (unit-tested). Drawing uses these.
export const invoiceRows = (lines: Invoice['lines']): string[][] =>
  lines.map(l => [
    l.description || '',
    fmtQty(Number(l.qty) || 0),
    formatMoney(Math.round((Number(l.unitPrice) || 0) * 100)),
    formatMoney(Math.round((Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * 100)),
  ]);

export const invoiceTotalsBlock = (totalCents: number, paidCents: number): [string, string][] => [
  ['Total', formatMoney(totalCents)],
  ['Paid', formatMoney(paidCents)],
  ['Balance Due', formatMoney(totalCents - paidCents)],
];

export interface InvoicePdfContext {
  invoice: Invoice;
  projectName: string;
  contractor?: string | null;
  address?: string | null;
  company: { name: string; logoDataUrl?: string };
}

// Generates the invoice PDF and returns the bytes. LAYOUT per Nathan's
// checkpoint choice — fill in the drawing per the selected option. This is the
// skeleton: page setup, the data via invoiceRows/invoiceTotalsBlock, and the
// return. Implementer fills the draw calls to match the chosen mockup.
export function buildInvoicePdf(ctx: InvoicePdfContext): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const M = 48; // margin
  let y = M;

  // --- HEADER (per chosen layout: logo/company block placement) ---
  if (ctx.company.logoDataUrl) {
    try { doc.addImage(ctx.company.logoDataUrl, 'PNG', M, y, 120, 48); } catch { /* skip bad logo */ }
  }
  doc.setFontSize(20).setFont('helvetica', 'bold');
  doc.text('INVOICE', doc.internal.pageSize.getWidth() - M, y + 16, { align: 'right' });
  doc.setFontSize(10).setFont('helvetica', 'normal');
  doc.text(ctx.company.name, doc.internal.pageSize.getWidth() - M, y + 34, { align: 'right' });
  y += 80;

  // --- META (number / date / terms) + BILL-TO (project/contractor/address) ---
  doc.setFontSize(10);
  doc.text(`Invoice #: ${ctx.invoice.number ?? ''}`, M, y);
  if (ctx.invoice.date) doc.text(`Date: ${new Date(ctx.invoice.date).toLocaleDateString()}`, M, y + 14);
  if (ctx.invoice.terms) doc.text(`Terms: ${ctx.invoice.terms}`, M, y + 28);
  doc.setFont('helvetica', 'bold').text('Bill To:', doc.internal.pageSize.getWidth() / 2, y);
  doc.setFont('helvetica', 'normal');
  [ctx.contractor, ctx.projectName, ctx.address].filter(Boolean).forEach((line, i) =>
    doc.text(String(line), doc.internal.pageSize.getWidth() / 2, y + 14 + i * 14));
  y += 64;

  // --- LINE ITEMS TABLE ---
  const rows = invoiceRows(ctx.invoice.lines);
  doc.setFont('helvetica', 'bold').setFontSize(10);
  doc.text('Description', M, y); doc.text('Qty', 330, y); doc.text('Unit', 400, y);
  doc.text('Amount', doc.internal.pageSize.getWidth() - M, y, { align: 'right' });
  y += 6; doc.line(M, y, doc.internal.pageSize.getWidth() - M, y); y += 16;
  doc.setFont('helvetica', 'normal');
  for (const [desc, qty, unit, amount] of rows) {
    doc.text(desc, M, y, { maxWidth: 270 });
    doc.text(qty, 330, y); doc.text(unit, 400, y);
    doc.text(amount, doc.internal.pageSize.getWidth() - M, y, { align: 'right' });
    y += 18;
  }
  y += 8; doc.line(M, y, doc.internal.pageSize.getWidth() - M, y); y += 18;

  // --- TOTALS ---
  for (const [label, value] of invoiceTotalsBlock(ctx.invoice.totalCents, ctx.invoice.paidCents)) {
    doc.setFont('helvetica', label === 'Balance Due' ? 'bold' : 'normal');
    doc.text(label, 400, y);
    doc.text(value, doc.internal.pageSize.getWidth() - M, y, { align: 'right' });
    y += 16;
  }

  return doc.output('arraybuffer') as unknown as Uint8Array;
}
```

- [ ] **Step 4: Run to verify the data-shaping test passes**

Run: `npx vitest run src/pages/project/billing/invoicePdf.test.ts`
Expected: PASS (2 tests). (The drawing isn't unit-tested — verified visually in Step 6.)

- [ ] **Step 5: Wire a "Download PDF" button into `InvoiceEditor.tsx`**

Add imports: `import { buildInvoicePdf } from './invoicePdf';`, `import { getSettings } from '../../../utils/store';`, and the outlet/summary for project name/contractor/address (pass them as props from ProjectBilling, OR fetch via `useProjectOutlet` — simplest: add `projectName`, `contractor`, `address` props to InvoiceEditor and have ProjectBilling pass them from its `useProjectOutlet().summary`). Add a footer button:

```tsx
        <Button variant="secondary" onClick={handleDownloadPdf}>Download PDF</Button>
```

with:

```tsx
  const handleDownloadPdf = async () => {
    try {
      const settings = await getSettings();
      let logoDataUrl: string | undefined = settings.logoUrl || undefined;
      if (logoDataUrl && !logoDataUrl.startsWith('data:')) {
        // logoUrl is a path — fetch and inline it
        const blob = await (await fetch(logoDataUrl)).blob();
        logoDataUrl = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); });
      }
      const bytes = buildInvoicePdf({
        invoice,
        projectName: props.projectName,
        contractor: props.contractor,
        address: props.address,
        company: { name: settings.appName || 'Invoice', logoDataUrl },
      });
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a'); a.href = url; a.download = `${invoice.number || 'invoice'}.pdf`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { toast('Failed to generate PDF', { type: 'error' }); }
  };
```

(Add `projectName`/`contractor`/`address` to InvoiceEditor's props interface and thread them from ProjectBilling's `useProjectOutlet().summary` — `summary.name`, `summary.contractor`, `summary.address`.)

- [ ] **Step 6: Verify and commit**

Run: `npm run lint && npm test`
Expected: clean / green. Boot check: open an invoice → Download PDF → the generated PDF matches Nathan's chosen layout (number, bill-to, line items, totals; logo if configured). Compare to the approved mockup.

```bash
git add src/pages/project/billing/invoicePdf.ts src/pages/project/billing/invoicePdf.test.ts src/pages/project/billing/InvoiceEditor.tsx src/pages/project/ProjectBilling.tsx
git commit -m "feat: invoice PDF generator (layout per design checkpoint)"
```

---

### Task 11: Send Invoice via SMTP (Reusable Email Helper)

**Files:**
- Modify: `server.ts` (extract `sendProjectEmail` helper; add `POST /api/invoices/:id/send`)
- Modify: `src/pages/project/billing/InvoiceEditor.tsx` (Send button: generate PDF → upload → POST send)
- Modify: `src/utils/store.ts` (sendInvoice helper)
- Test: none new server-side beyond a smoke (SMTP requires config) — the route is exercised in the manual check; the helper extraction must not regress send-proposal (existing behavior).

- [ ] **Step 1: Extract `sendProjectEmail` in `server.ts`**

The `POST /api/projects/:id/send-proposal` handler (~line 536) inlines: buildTransporter → read `smtp.*` settings → decode a file's dataURL → `transport.sendMail`. Extract the reusable core ABOVE the route definitions (near `buildTransporter`):

```ts
// Sends a stored file as a PDF attachment via SMTP. Returns nothing; throws on
// misconfiguration/failure. Shared by proposal + invoice + (later) issue sends.
async function sendProjectEmail(opts: {
  to: string;
  subject: string;
  text: string;
  fileId: string;
  attachmentName: string;
  inReplyTo?: string;
}): Promise<void> {
  const transport = buildTransporter();
  if (!transport) throw new Error('SMTP not configured');
  const smtpRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'smtp.%'").all() as { key: string; value: string }[];
  const smtpCfg: Record<string, string> = {};
  smtpRows.forEach(r => { smtpCfg[r.key.replace('smtp.', '')] = r.value; });
  const dataUrl = getDataUrlString(db, DATA_DIR, opts.fileId);
  if (!dataUrl) throw new Error('Attachment file not found');
  const base64Data = dataUrl.split(',')[1];
  const mimeType = dataUrl.split(';')[0].replace('data:', '');
  const fileBuffer = Buffer.from(base64Data, 'base64');
  const mailOptions: nodemailer.SendMailOptions = {
    from: smtpCfg.fromAddress ? `"${smtpCfg.fromName || ''}" <${smtpCfg.fromAddress}>` : undefined,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    attachments: [{ filename: opts.attachmentName, content: fileBuffer, contentType: mimeType }],
  };
  if (opts.inReplyTo) { mailOptions.inReplyTo = opts.inReplyTo; mailOptions.references = opts.inReplyTo; }
  await transport.sendMail(mailOptions);
}
```

Then refactor `send-proposal` to use it (its `to`/`subject`/`inReplyTo` come from `project.email`; the `logActivity` + reload-and-save stay in the route). Confirm the proposal flow's behavior is unchanged (same to/subject/attachment).

- [ ] **Step 2: Add `POST /api/invoices/:id/send`** (admin-gated; reuses the helper)

Place near the other invoice routes in `server.ts` (it needs `db`, `DATA_DIR`, and the billing store — import `getInvoice` from `./server/billingStore` and `logActivity`). The client uploads the freshly generated PDF as a `files` row first, then calls this with `{ to, fileId, message? }`:

```ts
  app.post('/api/invoices/:id/send', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const inv = getInvoice(db, req.params.id);
      if (!inv) return res.status(404).json({ error: 'Invoice not found' });
      const { to, fileId, message } = req.body as { to: string; fileId: string; message?: string };
      if (!to || !fileId) return res.status(400).json({ error: 'to and fileId are required' });
      await sendProjectEmail({
        to,
        subject: `Invoice ${inv.number ?? ''}`.trim(),
        text: message || 'Please find the attached invoice.',
        fileId,
        attachmentName: `${inv.number || 'invoice'}.pdf`,
      });
      // mark sent (best effort) + log
      try { db.prepare("UPDATE invoices SET status = 'sent', version = version + 1 WHERE id = ?").run(req.params.id); } catch { /* ignore */ }
      logActivity(db, { projectId: inv.projectId, userId: (req as any).user?.id, type: 'invoice_sent', message: `Invoice ${inv.number ?? ''} emailed to ${to}` });
      res.json({ success: true });
    } catch (e: any) {
      console.error('Error sending invoice:', e);
      res.status(500).json({ error: e.message || 'Failed to send invoice' });
    }
  });
```

(Import `getInvoice` from `./server/billingStore` at the top of server.ts. `getDataUrlString`, `logActivity`, `requireAdmin`, `authenticateToken` are already in scope where the other routes live — verify; the invoice send route must be registered where those middleware are available, same place send-proposal is.)

- [ ] **Step 3: Client `sendInvoice` helper** (`src/utils/store.ts`)

```ts
export const sendInvoice = async (id: string, payload: { to: string; fileId: string; message?: string }): Promise<void> => {
  const res = await billingJson('POST', `/api/invoices/${id}/send`, payload);
  await handleResponse(res);
};
```

- [ ] **Step 4: Wire the Send button in `InvoiceEditor.tsx`**

Add a "Send invoice" footer button that: prompts for a recipient email (a small inline input or a `Modal`/`window.prompt` is acceptable for v1 — use a controlled input in the editor with a "To" field), generates the PDF (reuse `handleDownloadPdf`'s build), uploads it via `uploadProjectFile`-style POST (`saveFileVersion` is for existing files; for a fresh invoice PDF use the existing `uploadProjectFile(projectId, file, 'invoice')` from store.ts — it returns the new file id), then calls `sendInvoice(invoice.id, { to, fileId, message })`. On success toast and `onSaved()` (the status flips to sent). Pull `projectId` from props.

```tsx
  const handleSend = async (to: string) => {
    try {
      const settings = await getSettings();
      // ...build bytes exactly as handleDownloadPdf (extract a buildBytes() to share)...
      const file = new File([bytes], `${invoice.number || 'invoice'}.pdf`, { type: 'application/pdf' });
      const fileId = await uploadProjectFile(props.projectId, file, 'invoice');
      await sendInvoice(invoice.id, { to, fileId, message: 'Please find the attached invoice.' });
      toast('Invoice sent', { type: 'success' });
      onSaved();
    } catch { toast('Failed to send invoice', { type: 'error' }); }
  };
```

(Extract the PDF-bytes building from `handleDownloadPdf` into a shared `buildBytes()` so download and send don't duplicate. Add `projectId` to InvoiceEditor props; ProjectBilling passes `projectId` from `useParams`.)

- [ ] **Step 5: Verify and commit**

Run: `npm run lint && npm test`
Expected: clean / green. Manual (requires SMTP configured in Settings → Email): open an invoice → enter a recipient → Send → email arrives with the PDF; invoice flips to "sent"; activity logs `invoice_sent`; the sent PDF appears under Documents (kind `invoice`). Also confirm the proposal-send flow still works (regression of the helper extraction).

```bash
git add server.ts src/pages/project/billing/InvoiceEditor.tsx src/utils/store.ts
git commit -m "feat: send invoice via SMTP using shared email helper"
```

---

### Task 12: Full Verification + Push

**Files:** none (verification only)

- [ ] **Step 1: Full automated pass**

Run: `npm run lint && npm test && npm run build`
Expected: zero type errors, all suites green, build succeeds.

- [ ] **Step 2: Live API smoke** (boot a temp dir, login admin/admin)

- [ ] Migrations 1-8 apply; second boot applies nothing
- [ ] Create invoice with lines → GET shows totalCents; PUT version-checked (409 on stale); PATCH status; payments change balance; DELETE
- [ ] Change order create → approve → `billing-summary.contractValueCents` rises by the approved amount; project `/summary` shows contractValueCents + invoiceCount
- [ ] A member-role token gets 403 on every billing route (simulate by minting a member JWT or asserting via the routes test's member app)

- [ ] **Step 3: Browser smoke (admin)**

- [ ] Billing section visible in the sidebar; contract rollup card; create/edit invoice (lines + totals live); record + delete payment; cycle invoice status; add/approve/reject/delete change order; contract value updates
- [ ] Download PDF matches the approved layout
- [ ] Send invoice (if SMTP configured) → email + status flips + Documents shows the invoice PDF
- [ ] Overview Details shows contract value (admin)

- [ ] **Step 4: Browser smoke (member)** — flip `localStorage.user.role` to `member` (or log in as a member)

- [ ] Billing hidden from the project sidebar; `/project/:id/billing` shows the access-denied panel; Overview does NOT show contract value; the API returns 403 for billing calls (check the network tab / console has no uncaught errors)

- [ ] **Step 5: Tell Nathan, then push**

Migration 8 is **additive** (four new empty billing tables — no data risk). Say so when pushing. Then:

```bash
git push origin testing
```

---

## Plan Self-Review Notes (already applied)

1. **Spec coverage (§2 Billing v1, §3.2, §4.1/§4.3, §6):** invoices with line items + draft/sent/paid + partial payments ✅ (Tasks 2-3, 9) · change orders as first-class records feeding contract value ✅ (Tasks 4, 9) · PDF via jsPDF + email via SMTP ✅ (Tasks 10-11) · no tax/retainage/AIA math ✅ (simple cent sums only) · line-item identity preserved so AIA schedule-of-values can later reference these rows ✅ (invoice_lines are real rows, never totals-only — §3.2 constraint) · admin-only, members never see pricing ✅ (requireAdmin on every route + nav hide + access-denied panel + Overview gating; Task 5 has a member-403 test) · contract value = base + approved COs surfaced on Overview + summary ✅ (Tasks 4, 6).
2. **Deliberate deferrals (per spec non-goals / scope):** AIA G702/G703 math, tax, retainage — explicitly out (spec §2) · estimate-cost-hiding for members across the takeoff UI is a broader §4.3 pass deferred (this plan gates only Billing; noted in Context #5) · invoice numbering is manual (no auto-sequence) for v1 · `schedule_of_values`/`pay_applications` tables are future AIA work the spec says these rows must not preclude — they don't (line-item identity kept).
3. **Money-correctness (the highest-risk area):** all sums in integer cents via `toCents`/`sumCents` (server) and `dollarsToCents`/`lineCents`/`draftTotalCents` (client), each rounding to cents BEFORE summing so float artefacts never accumulate — pinned by tests (Tasks 2, 7, 9). Storage is REAL dollars (consistent with `contractValue`), never summed as raw floats.
4. **Type consistency:** `INVOICE_STATUSES`=['draft','sent','paid'] and `CHANGE_ORDER_STATUSES`=['pending','approved','rejected'] match between billingStore (server) and BillingPills META (client) · `Invoice`/`InvoiceLine`/`Payment`/`ChangeOrder`/`BillingSummary` client types mirror the server shapes (cents fields: totalCents/paidCents/balanceCents, contractValueCents/etc.) · `billingSummary` return shape matches the client `BillingSummary` interface and the `/billing-summary` + `/summary` consumers · `lineCents`/`draftTotalCents` re-exported from InvoiceEditor through ProjectBilling for the test.
5. **Ordering & integration:** migration 8 + deleteProject cascade land together (Task 1); the cascade HTTP test is written in Task 1 but goes green only after Task 5's routes (noted) · billingStore (Tasks 2-4) before routes (5) before client (6-9) · money.ts stub created in Task 6, expanded+tested in Task 7 · the send helper extraction (Task 11) must not regress send-proposal (explicit regression check) · PROJECT_NAV gains an `adminOnly` flag consumed in the Sidebar map.
6. **Security:** server is the real gate (requireAdmin on all billing routes, member-403 test); client hiding is defense-in-depth, not the control. PDF generation is client-side (no server PDF dep added). SMTP send reuses the audited proposal path.
