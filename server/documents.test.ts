// server/documents.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { registerDataRoutes } from './routes';
import { pathFor } from './fileStore';

let db: Database.Database;
let dir: string;
let app: express.Express;

const PROJECT = { id: 'p1', name: 'Test Project', createdAt: 1, pages: [], takeoffs: [] };

const buildApp = (role: 'admin' | 'user', userId = 'u1') => {
  const a = express();
  a.use(express.json({ limit: '50mb' }));
  registerDataRoutes(a, {
    db,
    dataDir: dir,
    dbFile: path.join(dir, 'app.db'),
    authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: userId, role }; next(); },
    requireAdmin: (req: any, res: any, next: any) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
    verifyToken: () => null,
  });
  return a;
};

// Uploads through the real POST /api/files/:id path so tests exercise the
// same code that production upload/generate call sites use.
const upload = async (
  id: string,
  opts: { projectId?: string; kind?: string; name?: string; customerId?: string; sourceType?: string; sourceId?: string } = {},
  body = 'x'
) => {
  const qs = Object.entries(opts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
  const res = await request(app).post(`/api/files/${id}${qs ? `?${qs}` : ''}`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from(body));
  expect(res.status).toBe(200);
  return res.body.fileId as string;
};

// Backdates createdAt so ordering/paging tests aren't racing the clock.
const setCreatedAt = (fileId: string, ts: number) => {
  db.prepare('UPDATE files SET createdAt = ? WHERE id = ?').run(ts, fileId);
};

beforeEach(async () => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-docs-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  app = buildApp('admin');
  await request(app).post('/api/projects').send(PROJECT);
});

describe('GET /api/documents — filters', () => {
  it('multi-project filter returns only files from the listed projects', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'p2' });
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'p3' });
    const a = await upload('a', { projectId: 'p1', kind: 'document', name: 'A.pdf' });
    const b = await upload('b', { projectId: 'p2', kind: 'document', name: 'B.pdf' });
    await upload('c', { projectId: 'p3', kind: 'document', name: 'C.pdf' });

    const res = await request(app).get('/api/documents?projectIds=p1,p2');
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: any) => r.id).sort()).toEqual([a, b].sort());
  });

  it('multi-kind filter returns only the listed kinds', async () => {
    await upload('d', { projectId: 'p1', kind: 'document', name: 'D.pdf' });
    await upload('s', { projectId: 'p1', kind: 'spreadsheet', name: 'S.xlsx' });
    await upload('o', { projectId: 'p1', kind: 'other', name: 'O.bin' });

    const res = await request(app).get('/api/documents?kinds=document,spreadsheet');
    expect(res.body.rows.map((r: any) => r.kind).sort()).toEqual(['document', 'spreadsheet']);
  });

  it('customer-only file (no project) is matched by customerIds', async () => {
    await request(app).post('/api/customers').send({ id: 'cust1', name: 'Acme' });
    const fid = await upload('cf1', { kind: 'document', name: 'Loose.pdf', customerId: 'cust1' });

    const res = await request(app).get('/api/documents?customerIds=cust1');
    expect(res.body.rows.map((r: any) => r.id)).toEqual([fid]);
    expect(res.body.rows[0].projectId).toBeNull();
    expect(res.body.rows[0].customerId).toBe('cust1');
  });

  it('customerIds also matches files attributed via the owning project', async () => {
    await request(app).post('/api/customers').send({ id: 'cust2', name: 'Beta Co' });
    // customerId isn't in patchProject's field whitelist — set it directly.
    db.prepare('UPDATE projects SET customerId = ? WHERE id = ?').run('cust2', 'p1');
    const fid = await upload('pf1', { projectId: 'p1', kind: 'document', name: 'ViaProject.pdf' });

    const res = await request(app).get('/api/documents?customerIds=cust2');
    expect(res.body.rows.map((r: any) => r.id)).toEqual([fid]);
    expect(res.body.rows[0].customerName).toBe('Beta Co');
  });

  it('q filters by case-insensitive name substring', async () => {
    const fid = await upload('q1', { projectId: 'p1', kind: 'document', name: 'Contract Final.pdf' });
    await upload('q2', { projectId: 'p1', kind: 'document', name: 'Unrelated.pdf' });

    const res = await request(app).get('/api/documents?q=contract');
    expect(res.body.rows.map((r: any) => r.id)).toEqual([fid]);
  });

  it('archived toggle is exclusive: default excludes archived, archived=1 shows ONLY archived', async () => {
    const live = await upload('live1', { projectId: 'p1', kind: 'document', name: 'Live.pdf' });
    const arch = await upload('arch1', { projectId: 'p1', kind: 'document', name: 'Archived.pdf' });
    await request(app).patch(`/api/files/${arch}`).send({ archived: true });

    const defaultRes = await request(app).get('/api/documents');
    expect(defaultRes.body.rows.map((r: any) => r.id)).toEqual([live]);

    const archivedRes = await request(app).get('/api/documents?archived=1');
    expect(archivedRes.body.rows.map((r: any) => r.id)).toEqual([arch]);
    expect(archivedRes.body.rows[0].archived).toBe(true);
  });

  it('paging respects limit/offset while total reflects the full filtered set', async () => {
    for (let i = 0; i < 5; i++) {
      const id = await upload(`p${i}`, { projectId: 'p1', kind: 'document', name: `Doc${i}.pdf` });
      setCreatedAt(id, 1000 + i); // ascending creation; DESC order expected
    }
    const res = await request(app).get('/api/documents?limit=2&offset=1');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.rows).toHaveLength(2);
    // newest-first: p4,p3,p2,p1,p0 -> offset 1, limit 2 => p3,p2
    expect(res.body.rows.map((r: any) => r.id)).toEqual(['p3', 'p2']);
  });

  it('always excludes plan and settings-asset kinds, and version rows', async () => {
    await upload('plan1', { projectId: 'p1', kind: 'plan', name: 'raster.png' });
    await upload('sa1', { kind: 'settings-asset', name: 'template.xlsx' });
    const live = await upload('v1', { projectId: 'p1', kind: 'document', name: 'V.pdf' });
    await request(app).post(`/api/files/${live}/versions`).set('Content-Type', 'application/octet-stream').send(Buffer.from('v2'));

    const res = await request(app).get('/api/documents');
    expect(res.body.rows.map((r: any) => r.id)).toEqual([live]);
  });
});

describe('GET /api/documents — role exclusion', () => {
  it('non-admin excludes invoice/payapp-export/change-order/proposal but keeps change-order-photo and printout', async () => {
    await upload('inv', { projectId: 'p1', kind: 'invoice', name: 'Inv.pdf' });
    await upload('pae', { projectId: 'p1', kind: 'payapp-export', name: 'PayApp.xlsx' });
    await upload('co', { projectId: 'p1', kind: 'change-order', name: 'CO.pdf' });
    await upload('prop', { projectId: 'p1', kind: 'proposal', name: 'Proposal.pdf' });
    const cop = await upload('cop', { projectId: 'p1', kind: 'change-order-photo', name: 'photo.jpg' });
    const po = await upload('po', { projectId: 'p1', kind: 'printout', name: 'Printout.pdf' });

    const adminRes = await request(app).get('/api/documents');
    expect(adminRes.body.rows.map((r: any) => r.id).sort()).toEqual(['co', 'cop', 'inv', 'pae', 'po', 'prop'].sort());

    const userApp = buildApp('user', 'u2');
    const userRes = await request(userApp).get('/api/documents');
    expect(userRes.body.rows.map((r: any) => r.id).sort()).toEqual([cop, po].sort());
  });
});

describe('GET /api/documents — source label resolution', () => {
  it('resolves invoice, payapp, change-order and task labels with hrefs', async () => {
    const inv = await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-12', lines: [] });
    const invFid = await upload('inv-f', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: inv.body.id, name: 'Invoice.pdf' });

    const co = await request(app).post('/api/projects/p1/change-orders').send({ number: 'CO-3', lumpSumAmount: 100 });
    const coFid = await upload('co-f', { projectId: 'p1', kind: 'change-order', sourceType: 'change-order', sourceId: co.body.id, name: 'CO.pdf' });

    const payApp = await request(app).post('/api/projects/p1/aia/pay-apps').send({});
    const payFid = await upload('pay-f', { projectId: 'p1', kind: 'payapp-export', sourceType: 'payapp', sourceId: payApp.body.id, name: 'PayApp.xlsx' });

    const task = await request(app).post('/api/tasks').send({ title: 'Order fixtures', projectId: 'p1' });
    const taskFid = await upload('task-f', { projectId: 'p1', kind: 'task-photo', sourceType: 'task', sourceId: task.body.id, name: 'task.jpg' });

    const res = await request(app).get('/api/documents');
    const byId = Object.fromEntries(res.body.rows.map((r: any) => [r.id, r]));

    expect(byId[invFid].source).toEqual({ type: 'invoice', id: inv.body.id, label: 'Invoice #INV-12', href: '/project/p1/billing?tab=invoices' });
    expect(byId[coFid].source).toEqual({ type: 'change-order', id: co.body.id, label: 'CO #CO-3', href: '/project/p1/billing?tab=change-orders' });
    expect(byId[payFid].source).toEqual({ type: 'payapp', id: payApp.body.id, label: `Pay App #${payApp.body.number}`, href: '/project/p1/billing?tab=pay-apps' });
    expect(byId[taskFid].source).toEqual({ type: 'task', id: task.body.id, label: 'Order fixtures', href: '/tasks?projectId=p1' });
  });

  it('resolves a printout label from project.printouts[] by its own id', async () => {
    const current = (await request(app).get('/api/projects/p1')).body;
    await request(app).put('/api/projects/p1').send({
      ...current, printouts: [{ id: 'po-1', name: 'Bid Set', fileId: 'po-f', createdAt: 1 }],
    });
    const fid = await upload('po-f', { projectId: 'p1', kind: 'printout', sourceType: 'printout', sourceId: 'po-1', name: 'Printout.pdf' });

    const res = await request(app).get('/api/documents');
    const row = res.body.rows.find((r: any) => r.id === fid);
    expect(row.source).toEqual({ type: 'printout', id: 'po-1', label: 'Bid Set', href: '/project/p1/proposal' });
  });

  it('falls back to a generic kind-based label with null href for a dangling sourceId', async () => {
    const fid = await upload('dangling', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'no-such-invoice', name: 'Ghost.pdf' });

    const res = await request(app).get('/api/documents');
    const row = res.body.rows.find((r: any) => r.id === fid);
    expect(row.source).toEqual({ type: 'invoice', id: 'no-such-invoice', label: 'Invoice', href: null });
  });

  it('a dangling printout sourceId also falls back generically', async () => {
    const fid = await upload('dangling-po', { projectId: 'p1', kind: 'printout', sourceType: 'printout', sourceId: 'no-such-printout', name: 'Ghost.pdf' });

    const res = await request(app).get('/api/documents');
    const row = res.body.rows.find((r: any) => r.id === fid);
    expect(row.source).toEqual({ type: 'printout', id: 'no-such-printout', label: 'Printout', href: null });
  });

  it('files with no sourceType have source: null', async () => {
    const fid = await upload('loose', { projectId: 'p1', kind: 'document', name: 'Loose.pdf' });
    const res = await request(app).get('/api/documents');
    expect(res.body.rows.find((r: any) => r.id === fid).source).toBeNull();
  });
});

describe('PATCH /api/files/:id', () => {
  it('archives and un-archives any visible row, including a system-generated one', async () => {
    const fid = await upload('gen', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-x', name: 'Inv.pdf' });
    const on = await request(app).patch(`/api/files/${fid}`).send({ archived: true });
    expect(on.status).toBe(200);
    expect(on.body.archived).toBe(true); // normalized to boolean, matching GET /api/documents
    const off = await request(app).patch(`/api/files/${fid}`).send({ archived: false });
    expect(off.body.archived).toBe(false);
  });

  it('404s a billing-kind row for a non-admin (not 409 — must not confirm existence)', async () => {
    const fid = await upload('gen-billing', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-role', name: 'Inv.pdf' });
    const userApp = buildApp('user', 'u2');
    const res = await request(userApp).patch(`/api/files/${fid}`).send({ archived: true });
    expect(res.status).toBe(404);
    // untouched — the admin app still sees it un-archived
    expect((await request(app).get(`/api/files/${fid}/meta`)).body.archived).toBe(0);
  });

  it('a non-admin can still archive a visible (non-billing) row', async () => {
    const fid = await upload('up-visible', { projectId: 'p1', kind: 'document', name: 'X.pdf' });
    const userApp = buildApp('user', 'u2');
    const res = await request(userApp).patch(`/api/files/${fid}`).send({ archived: true });
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);
  });

  it('409s a kind change on a system-generated row', async () => {
    const fid = await upload('gen2', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-y', name: 'Inv.pdf' });
    const res = await request(app).patch(`/api/files/${fid}`).send({ kind: 'document' });
    expect(res.status).toBe(409);
  });

  it('allows kind changes between direct-upload kinds', async () => {
    const fid = await upload('up1', { projectId: 'p1', kind: 'document', name: 'X.pdf' });
    const res = await request(app).patch(`/api/files/${fid}`).send({ kind: 'other' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('other');
  });

  it('validates a custom:<id> kind against settings.documentTypes', async () => {
    const fid = await upload('up2', { projectId: 'p1', kind: 'document', name: 'X.pdf' });

    const bad = await request(app).patch(`/api/files/${fid}`).send({ kind: 'custom:warranty' });
    expect(bad.status).toBe(400);

    // /api/settings is registered at the app root (server.ts), not by
    // registerDataRoutes — write the key directly, same shape the real
    // POST /api/settings handler would persist.
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('documentTypes', JSON.stringify([{ id: 'warranty', label: 'Warranty' }]));
    const good = await request(app).patch(`/api/files/${fid}`).send({ kind: 'custom:warranty' });
    expect(good.status).toBe(200);
    expect(good.body.kind).toBe('custom:warranty');
  });

  it('404s for an unknown file', async () => {
    const res = await request(app).patch('/api/files/nope').send({ archived: true });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/files/:id', () => {
  it('409s a sourced (generated/attached) row', async () => {
    const fid = await upload('gen3', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-z', name: 'Inv.pdf' });
    const res = await request(app).delete(`/api/files/${fid}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
    expect((await request(app).get(`/api/files/${fid}/meta`)).status).toBe(200); // untouched
  });

  it('409s a non-direct-upload kind even without a source (defensive)', async () => {
    const fid = await upload('plan-src', { projectId: 'p1', kind: 'plan-source', name: 'raw.pdf' });
    const res = await request(app).delete(`/api/files/${fid}`);
    expect(res.status).toBe(409);
  });

  it('404s a billing-kind row for a non-admin (uniform with PATCH; the row would 409 for admin)', async () => {
    const fid = await upload('gen-del', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-del', name: 'Inv.pdf' });
    const userApp = buildApp('user', 'u2');
    const res = await request(userApp).delete(`/api/files/${fid}`);
    expect(res.status).toBe(404);
    expect((await request(app).get(`/api/files/${fid}/meta`)).status).toBe(200); // untouched
  });

  it('deletes a loose direct upload and wipes its version rows + bytes', async () => {
    const fid = await upload('loose2', { projectId: 'p1', kind: 'document', name: 'D.pdf' }, 'v1');
    await request(app).post(`/api/files/${fid}/versions`).set('Content-Type', 'application/octet-stream').send(Buffer.from('v2'));
    const versionsBefore = await request(app).get(`/api/files/${fid}/versions`);
    expect(versionsBefore.body).toHaveLength(2);
    const historicalId = versionsBefore.body[1].id;

    const res = await request(app).delete(`/api/files/${fid}`);
    expect(res.status).toBe(200);
    expect((await request(app).get(`/api/files/${fid}/meta`)).status).toBe(404);
    expect((await request(app).get(`/api/files/${historicalId}/meta`)).status).toBe(404);
    expect(fsSync.existsSync(pathFor(dir, fid))).toBe(false);
    expect(fsSync.existsSync(pathFor(dir, historicalId))).toBe(false);
  });

  it('404s for an unknown file', async () => {
    const res = await request(app).delete('/api/files/nope');
    expect(res.status).toBe(404);
  });
});
