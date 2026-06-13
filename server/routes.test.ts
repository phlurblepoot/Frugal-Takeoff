// server/routes.test.ts
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
import { createProject, loadProject } from './projectStore';
import { registerDataRoutes } from './routes';

let db: Database.Database;
let dir: string;
let app: express.Express;

const PROJECT = {
  id: 'p1', name: 'Test Project', createdAt: 1, contractor: 'GC Co',
  pages: [{ id: 'pg1', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
  takeoffs: [],
};

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-rt-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  app = express();
  app.use(express.json({ limit: '50mb' }));
  registerDataRoutes(app, {
    db,
    dataDir: dir,
    dbFile: path.join(dir, 'app.db'),
    // auth stubs: every request is an authenticated admin
    authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role: 'admin' }; next(); },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    verifyToken: (token: string) => (token === 'good-token' ? { id: 'u1', role: 'admin' } : null),
  });
});

describe('projects routes', () => {
  it('POST + GET round-trip', async () => {
    const post = await request(app).post('/api/projects').send(PROJECT);
    expect(post.status).toBe(200);
    expect(post.body.version).toBe(1);
    const get = await request(app).get('/api/projects/p1');
    expect(get.status).toBe(200);
    expect(get.body.name).toBe('Test Project');
    expect(get.body.version).toBe(1);
  });

  it('PUT bumps version; stale PUT gets 409 and changes nothing', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    const v1 = (await request(app).get('/api/projects/p1')).body;
    const ok = await request(app).put('/api/projects/p1').send({ ...v1, name: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    const stale = await request(app).put('/api/projects/p1').send({ ...v1, name: 'Clobber' });
    expect(stale.status).toBe(409);
    expect((await request(app).get('/api/projects/p1')).body.name).toBe('Renamed');
  });

  it('PUT with invalid payload gets 400', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    const v1 = (await request(app).get('/api/projects/p1')).body;
    const res = await request(app).put('/api/projects/p1').send({ ...v1, pages: 'broken' });
    expect(res.status).toBe(400);
  });

  it('GET list returns aggregates newest-first; DELETE removes', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    await request(app).post('/api/projects').send({
      ...PROJECT,
      id: 'p2',
      createdAt: 2,
      pages: [{ id: 'pg2', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
    });
    const list = await request(app).get('/api/projects');
    expect(list.body.map((p: any) => p.id)).toEqual(['p2', 'p1']);
    await request(app).delete('/api/projects/p1');
    expect((await request(app).get('/api/projects/p1')).status).toBe(404);
  });
});

describe('images compat routes', () => {
  const PNG = 'data:image/png;base64,' + Buffer.from('pngbytes').toString('base64');

  it('POST /api/images + GET /api/images/:id round-trips the dataURL', async () => {
    await request(app).post('/api/images').send({ id: 'i1', data: PNG }).expect(200);
    const res = await request(app).get('/api/images/i1');
    expect(res.body.data).toBe(PNG);
  });

  it('GET /api/images/:id/raw streams decoded bytes with mime', async () => {
    await request(app).post('/api/images').send({ id: 'i1', data: PNG });
    const res = await request(app).get('/api/images/i1/raw');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.body.toString()).toBe('pngbytes');
  });

  it('POST /api/files/:id accepts raw binary', async () => {
    const res = await request(app)
      .post('/api/files/f1')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('pdfbytes'));
    expect(res.status).toBe(200);
    const get = await request(app).get('/api/images/f1');
    expect(get.body.data).toBe('data:application/pdf;base64,' + Buffer.from('pdfbytes').toString('base64'));
  });

  it('404s for unknown ids', async () => {
    expect((await request(app).get('/api/images/nope')).status).toBe(404);
    expect((await request(app).get('/api/images/nope/raw')).status).toBe(404);
  });
});

describe('GET /api/files/:id/content streaming', () => {
  beforeEach(async () => {
    await request(app)
      .post('/api/files/f1')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('0123456789'));
  });

  it('streams full content with Accept-Ranges', async () => {
    const res = await request(app).get('/api/files/f1/content?token=good-token');
    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('10');
    expect(res.body.toString()).toBe('0123456789');
  });

  it('serves byte ranges with 206', async () => {
    const res = await request(app)
      .get('/api/files/f1/content?token=good-token')
      .set('Range', 'bytes=2-5');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.body.toString()).toBe('2345');
  });

  it('rejects missing/bad tokens', async () => {
    expect((await request(app).get('/api/files/f1/content')).status).toBe(401);
    expect((await request(app).get('/api/files/f1/content?token=bad')).status).toBe(401);
  });
});

describe('storage + search + orphans', () => {
  it('orphan cleanup deletes only unreferenced files', async () => {
    await request(app).post('/api/projects').send({
      ...PROJECT,
      pages: [{ id: 'pg1', name: 'A1', imageId: 'used1', measurements: [], scaleConfig: null }],
    });
    const PNG = 'data:image/png;base64,' + Buffer.from('x').toString('base64');
    await request(app).post('/api/images').send({ id: 'used1', data: PNG });
    await request(app).post('/api/images').send({ id: 'orphan1', data: PNG });
    const orphans = await request(app).get('/api/storage/orphans');
    expect(orphans.body.count).toBe(1);
    const cleanup = await request(app).post('/api/storage/orphans/cleanup');
    expect(cleanup.body.deleted).toBe(1);
    expect((await request(app).get('/api/images/used1')).status).toBe(200);
    expect((await request(app).get('/api/images/orphan1')).status).toBe(404);
  });

  it('orphan cleanup spares standalone project document uploads', async () => {
    await request(app).post('/api/projects').send(PROJECT); // id 'p1'
    // A Documents upload: referenced ONLY by files.projectId, not by any project JSON
    await request(app).post('/api/files/doc1?projectId=p1&kind=document&name=Contract.pdf')
      .set('Content-Type', 'application/pdf').send(Buffer.from('contract'));
    const orphans = await request(app).get('/api/storage/orphans');
    expect(orphans.body.count).toBe(0); // doc1 is NOT an orphan
    await request(app).post('/api/storage/orphans/cleanup');
    expect((await request(app).get('/api/files/doc1/meta')).status).toBe(200); // survived
  });

  it('search finds projects, pages, and takeoffs from normalized tables', async () => {
    await request(app).post('/api/projects').send({
      ...PROJECT,
      name: 'Maple Office',
      pages: [{ id: 'pg1', name: 'Lobby Plan', imageId: '', measurements: [], scaleConfig: null }],
      takeoffs: [{ id: 't1', name: 'Drywall', color: '#fff', type: 'area' }],
    });
    const res = await request(app).get('/api/search?q=maple');
    expect(res.body.results.some((r: any) => r.type === 'project')).toBe(true);
    const res2 = await request(app).get('/api/search?q=lobby');
    expect(res2.body.results.some((r: any) => r.type === 'page')).toBe(true);
    const res3 = await request(app).get('/api/search?q=drywall');
    expect(res3.body.results.some((r: any) => r.type === 'takeoff')).toBe(true);
  });

  it('project storage endpoint reports file bytes', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    const res = await request(app).get('/api/projects/p1/storage');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalBytes');
    expect(res.body).toHaveProperty('imageBytes');
  });
});

describe('GET /api/projects/summary', () => {
  it('returns slim rows with counts and pageIds, no page payloads', async () => {
    await request(app).post('/api/projects').send({
      ...PROJECT,
      pages: [
        { id: 'pg1', name: 'A1', imageId: '', measurements: [], scaleConfig: null },
        { id: 'pg2', name: 'A2', imageId: '', measurements: [], scaleConfig: null },
      ],
      takeoffs: [{ id: 't1', name: 'Drywall', color: '#fff', type: 'area' }],
    });
    const res = await request(app).get('/api/projects/summary');
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.id === 'p1');
    expect(row).toMatchObject({
      name: 'Test Project', status: 'estimating', version: 1, archived: false,
      pageCount: 2, takeoffCount: 1, contractor: 'GC Co',
    });
    expect(row.pageIds.sort()).toEqual(['pg1', 'pg2']);
    expect(row.pages).toBeUndefined(); // slim — no aggregates
  });

  it('reflects the archived meta flag', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'p2', archived: true });
    const res = await request(app).get('/api/projects/summary');
    expect(res.body.find((r: any) => r.id === 'p2').archived).toBe(true);
  });
});

describe('PATCH /api/projects/:id', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT);
  });

  it('updates status and bumps version', async () => {
    const res = await request(app).patch('/api/projects/p1').send({ version: 1, status: 'awarded' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, version: 2, status: 'awarded' });
    const get = await request(app).get('/api/projects/p1');
    expect(get.body.status).toBe('awarded');
    expect(get.body.version).toBe(2);
  });

  it('updates name and archived flag', async () => {
    const res = await request(app).patch('/api/projects/p1')
      .send({ version: 1, name: 'Renamed', archived: true });
    expect(res.body.version).toBe(2);
    const get = await request(app).get('/api/projects/p1');
    expect(get.body.name).toBe('Renamed');
    expect(get.body.archived).toBe(true);
  });

  it('un-archiving removes the meta key entirely', async () => {
    await request(app).patch('/api/projects/p1').send({ version: 1, archived: true });
    await request(app).patch('/api/projects/p1').send({ version: 2, archived: false });
    const get = await request(app).get('/api/projects/p1');
    expect(get.body.archived).toBeUndefined(); // legacy shape omits the key
  });

  it('rejects stale versions with 409 and changes nothing', async () => {
    await request(app).patch('/api/projects/p1').send({ version: 1, name: 'First' });
    const stale = await request(app).patch('/api/projects/p1').send({ version: 1, name: 'Clobber' });
    expect(stale.status).toBe(409);
    expect((await request(app).get('/api/projects/p1')).body.name).toBe('First');
  });

  it('rejects invalid payloads with 400', async () => {
    expect((await request(app).patch('/api/projects/p1').send({ version: 1, status: 'galactic' })).status).toBe(400);
    expect((await request(app).patch('/api/projects/p1').send({ version: 1, nonsense: true })).status).toBe(400);
    expect((await request(app).patch('/api/projects/p1').send({ status: 'awarded' })).status).toBe(400); // no version
    expect((await request(app).patch('/api/projects/p1').send({ version: 1, name: '' })).status).toBe(400);
  });

  it('404s for unknown projects', async () => {
    expect((await request(app).patch('/api/projects/nope').send({ version: 1, name: 'X' })).status).toBe(404);
  });
});

describe('GET /api/activity', () => {
  it('records project create and status change events', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    await request(app).patch('/api/projects/p1').send({ version: 1, status: 'awarded' });
    const res = await request(app).get('/api/activity');
    expect(res.status).toBe(200);
    const types = res.body.items.map((i: any) => i.type);
    expect(types).toContain('project_created');
    expect(types).toContain('status_changed');
    const statusItem = res.body.items.find((i: any) => i.type === 'status_changed');
    expect(statusItem.projectName).toBe('Test Project');
  });
});

describe('GET /api/projects/:id/summary', () => {
  it('returns the single slim row', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    const res = await request(app).get('/api/projects/p1/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'p1', name: 'Test Project', status: 'estimating', version: 1 });
    expect(res.body.pages).toBeUndefined();
  });

  it('404s for unknown projects', async () => {
    expect((await request(app).get('/api/projects/nope/summary')).status).toBe(404);
  });

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

  it('omits billing fields for non-admins', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'pm' });
    // build a member-role app sharing the same db
    const memberApp = express();
    memberApp.use(express.json());
    registerDataRoutes(memberApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'm1', role: 'user' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
    });
    const res = await request(memberApp).get('/api/projects/pm/summary');
    expect(res.status).toBe(200);
    expect(res.body.contractValueCents).toBeUndefined();
    expect(res.body.invoiceCount).toBeUndefined();
    expect(res.body.name).toBe(PROJECT.name); // non-pricing fields still present
  });

  it('includes openIssueCount (visible to all roles)', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'pi' });
    await request(app).post('/api/projects/pi/issues').send({ title: 'A' });
    const i2 = await request(app).post('/api/projects/pi/issues').send({ title: 'B' });
    await request(app).patch(`/api/issues/${i2.body.id}`).send({ status: 'resolved' });
    const res = await request(app).get('/api/projects/pi/summary');
    expect(res.body.openIssueCount).toBe(1); // one open, one resolved
  });

  it('includes punchDone/punchTotal for non-admin users (ungated)', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'pp' });
    const punch = await request(app).post('/api/projects/pp/punch').send({ description: 'Fix crack', area: 'Kitchen' });
    await request(app).patch(`/api/punch/${punch.body.id}`).send({ done: true });

    // non-admin 'user' app sharing the same db
    const userApp = express();
    userApp.use(express.json());
    registerDataRoutes(userApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u3', role: 'user' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
    });

    const res = await request(userApp).get('/api/projects/pp/summary');
    expect(res.status).toBe(200);
    expect(res.body.punchDone).toBe(1);
    expect(res.body.punchTotal).toBe(1);
  });
});

describe('GET /api/activity?projectId=', () => {
  it('filters the feed to one project', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'p2', name: 'Other' });
    await request(app).patch('/api/projects/p1').send({ version: 1, status: 'awarded' });
    const res = await request(app).get('/api/activity?projectId=p1');
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) expect(item.projectId).toBe('p1');
  });
});

describe('project files', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT);
  });

  it('POST /api/files/:id labels uploads via query params', async () => {
    const res = await request(app)
      .post('/api/files/doc1?projectId=p1&kind=document&name=Contract.pdf')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('pdfbytes'));
    expect(res.status).toBe(200);
    const meta = await request(app).get('/api/files/doc1/meta');
    expect(meta.status).toBe(200);
    expect(meta.body).toMatchObject({
      id: 'doc1', projectId: 'p1', kind: 'document', name: 'Contract.pdf',
      mime: 'application/pdf', versionNumber: 1, parentFileId: null,
    });
  });

  it('GET /api/projects/:id/files lists live files newest-first, no version rows', async () => {
    await request(app).post('/api/files/doc1?projectId=p1&kind=document&name=A.pdf')
      .set('Content-Type', 'application/pdf').send(Buffer.from('a'));
    await request(app).post('/api/files/doc2?projectId=p1&kind=spreadsheet&name=B.xlsx')
      .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(Buffer.from('b'));
    const res = await request(app).get('/api/projects/p1/files');
    expect(res.status).toBe(200);
    expect(res.body.map((f: any) => f.id).sort()).toEqual(['doc1', 'doc2']);
    expect(res.body[0].sha256).toBeUndefined(); // slim listing
  });

  it('GET /api/files/:id/meta 404s for unknown files', async () => {
    expect((await request(app).get('/api/files/nope/meta')).status).toBe(404);
  });
});

describe('file versions over HTTP', () => {
  beforeEach(async () => {
    await request(app).post('/api/files/f1?projectId=p1&kind=printout&name=Bid.pdf')
      .set('Content-Type', 'application/pdf').send(Buffer.from('v1'));
  });

  it('POST /versions archives and bumps; content endpoint serves the new bytes', async () => {
    const res = await request(app).post('/api/files/f1/versions')
      .set('Content-Type', 'application/pdf').send(Buffer.from('v2'));
    expect(res.status).toBe(200);
    expect(res.body.versionNumber).toBe(2);
    const content = await request(app).get('/api/files/f1/content?token=good-token');
    expect(content.body.toString()).toBe('v2');
    const versions = await request(app).get('/api/files/f1/versions');
    expect(versions.body).toHaveLength(2);
    expect(versions.body[1].versionNumber).toBe(1);
  });

  it('404s when versioning an unknown file', async () => {
    expect((await request(app).post('/api/files/nope/versions')
      .set('Content-Type', 'application/pdf').send(Buffer.from('x'))).status).toBe(404);
  });

  it('orphan cleanup spares version history of referenced files', async () => {
    // reference f1 from a project printout
    await request(app).post('/api/projects').send({
      ...PROJECT, printouts: [{ id: 'po1', name: 'Bid set', fileId: 'f1', createdAt: 1 }],
    });
    await request(app).post('/api/files/f1/versions')
      .set('Content-Type', 'application/pdf').send(Buffer.from('v2'));
    const cleanup = await request(app).post('/api/storage/orphans/cleanup');
    expect(cleanup.status).toBe(200);
    const versions = await request(app).get('/api/files/f1/versions');
    expect(versions.body).toHaveLength(2); // history survived
  });
});

describe('drafts', () => {
  it('PUT/GET/DELETE round-trip scoped to the user', async () => {
    const put = await request(app).put('/api/drafts/f1')
      .send({ kind: 'pdf', data: JSON.stringify({ annotations: [] }) });
    expect(put.status).toBe(200);
    const get = await request(app).get('/api/drafts/f1');
    expect(get.status).toBe(200);
    expect(get.body.kind).toBe('pdf');
    expect(JSON.parse(get.body.data)).toEqual({ annotations: [] });
    expect(typeof get.body.updatedAt).toBe('number');
    await request(app).delete('/api/drafts/f1').expect(200);
    expect((await request(app).get('/api/drafts/f1')).status).toBe(404);
  });

  it('rejects invalid payloads', async () => {
    expect((await request(app).put('/api/drafts/f1').send({ kind: 'pdf' })).status).toBe(400);
    expect((await request(app).put('/api/drafts/f1').send({ kind: 'nope', data: '{}' })).status).toBe(400);
  });

  it('deleteProject removes drafts for its files', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    await request(app).post('/api/files/df1?projectId=p1&kind=document&name=D.pdf')
      .set('Content-Type', 'application/pdf').send(Buffer.from('x'));
    await request(app).put('/api/drafts/df1').send({ kind: 'pdf', data: '{}' });
    await request(app).delete('/api/projects/p1');
    expect((await request(app).get('/api/drafts/df1')).status).toBe(404);
  });
});

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
    expect((db.prepare('SELECT COUNT(*) c FROM payments WHERE invoiceId IN (SELECT id FROM invoices WHERE projectId = ?)').get('p1') as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM invoice_lines WHERE invoiceId IN (SELECT id FROM invoices WHERE projectId = ?)').get('p1') as any).c).toBe(0);
  });
});

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

describe('deleteProject issues cascade', () => {
  it('removes issues and issue_photos for the project', async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
    const iss = await request(app).post('/api/projects/p1/issues').send({ title: 'Crack', description: 'Wall crack' });
    await request(app).post('/api/files/ph1?projectId=p1&kind=photo&name=p.jpg')
      .set('Content-Type', 'image/jpeg').send(Buffer.from('img'));
    await request(app).post(`/api/issues/${iss.body.id}/photos`).send({ fileId: 'ph1' });
    await request(app).delete('/api/projects/p1');
    expect((db.prepare('SELECT COUNT(*) c FROM issues WHERE projectId = ?').get('p1') as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM issue_photos WHERE issueId IN (SELECT id FROM issues WHERE projectId = ?)').get('p1') as any).c).toBe(0);
  });
});

describe('issue routes', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
  });

  it('create → list (ISS number) → get → status', async () => {
    const create = await request(app).post('/api/projects/p1/issues').send({ title: 'Crack', description: 'Wall crack near door' });
    expect(create.status).toBe(200);
    expect(create.body.number).toBe(1);
    const list = await request(app).get('/api/projects/p1/issues');
    expect(list.body[0].number).toBe(1);
    const get = await request(app).get(`/api/issues/${create.body.id}`);
    expect(get.body.title).toBe('Crack');
    expect(get.body.status).toBe('open');
    const patch = await request(app).patch(`/api/issues/${create.body.id}`).send({ status: 'resolved' });
    expect(patch.status).toBe(200);
    expect((await request(app).get(`/api/issues/${create.body.id}`)).body.status).toBe('resolved');
  });

  it('save body is version-checked (409 on stale)', async () => {
    const id = (await request(app).post('/api/projects/p1/issues').send({ title: 'A' })).body.id;
    const iss = (await request(app).get(`/api/issues/${id}`)).body;
    expect((await request(app).put(`/api/issues/${id}`).send({ ...iss, title: 'A2' })).status).toBe(200);
    expect((await request(app).put(`/api/issues/${id}`).send({ ...iss, title: 'Clobber' })).status).toBe(409);
  });

  it('photos: link → appears in get → unlink', async () => {
    const id = (await request(app).post('/api/projects/p1/issues').send({ title: 'A' })).body.id;
    await request(app).post('/api/files/ph1?projectId=p1&kind=photo&name=p.jpg').set('Content-Type', 'image/jpeg').send(Buffer.from('x'));
    await request(app).post(`/api/issues/${id}/photos`).send({ fileId: 'ph1' }).expect(200);
    expect((await request(app).get(`/api/issues/${id}`)).body.photos.map((p: any) => p.fileId)).toEqual(['ph1']);
    await request(app).delete(`/api/issues/${id}/photos/ph1`).expect(200);
    expect((await request(app).get(`/api/issues/${id}`)).body.photos).toHaveLength(0);
  });

  it('validates and 404s', async () => {
    expect((await request(app).post('/api/projects/p1/issues').send({ title: '' })).status).toBe(400);
    expect((await request(app).get('/api/issues/nope')).status).toBe(404);
    expect((await request(app).patch('/api/issues/nope').send({ status: 'open' })).status).toBe(404);
  });
});

describe('punch routes', () => {
  let userApp: express.Express;

  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1

    // A second app wired with a non-admin 'user' role — proves punch is NOT admin-gated
    userApp = express();
    userApp.use(express.json());
    registerDataRoutes(userApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u2', role: 'user' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
    });
  });

  it('non-admin user CAN POST and GET punch items (not admin-gated)', async () => {
    const create = await request(userApp).post('/api/projects/p1/punch')
      .send({ description: 'Touch up paint', area: 'Kitchen' });
    expect(create.status).toBe(200);
    expect(create.body.id).toBeTruthy();
    const list = await request(userApp).get('/api/projects/p1/punch');
    expect(list.status).toBe(200);
    expect(list.body.some((item: any) => item.description === 'Touch up paint')).toBe(true);
  });

  it('PUT with stale version returns 409 with code version_conflict', async () => {
    const id = (await request(app).post('/api/projects/p1/punch').send({ description: 'Fix door', area: 'Entry' })).body.id;
    const res = await request(app).put(`/api/punch/${id}`).send({ description: 'Updated', version: 99 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('version_conflict');
  });

  it('PATCH with done:true marks item done (200)', async () => {
    const id = (await request(app).post('/api/projects/p1/punch').send({ description: 'Caulk tub', area: 'Bath' })).body.id;
    const res = await request(app).patch(`/api/punch/${id}`).send({ done: true });
    expect(res.status).toBe(200);
    expect((await request(app).get(`/api/punch/${id}`)).body.done).toBe(1);
  });

  it('PATCH without done boolean returns 400', async () => {
    const id = (await request(app).post('/api/projects/p1/punch').send({ description: 'Sand walls' })).body.id;
    const res = await request(app).patch(`/api/punch/${id}`).send({ area: 'Hall' });
    expect(res.status).toBe(400);
  });

  it('POST /api/punch/:id/photos links photo; GET shows it; invalid stage → 400', async () => {
    const id = (await request(app).post('/api/projects/p1/punch').send({ description: 'Install fixture' })).body.id;
    const add = await request(app).post(`/api/punch/${id}/photos`).send({ fileId: 'f1', stage: 'before' });
    expect(add.status).toBe(200);
    const get = await request(app).get(`/api/punch/${id}`);
    expect(get.body.photos.some((p: any) => p.fileId === 'f1')).toBe(true);
    const bad = await request(app).post(`/api/punch/${id}/photos`).send({ fileId: 'f2', stage: 'invalid' });
    expect(bad.status).toBe(400);
  });
});
