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
import { registerDataRoutes, registerEmailRoutes } from './routes';

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
    broadcastChange: () => {},
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

  it('orphan cleanup spares a project-less task photo', async () => {
    // Task photos are deliberately project-less (a task outlives the project it
    // merely refers to), so files.projectId cannot vouch for them — only the
    // join table can.
    await request(app).post('/api/files/tphoto1?kind=task-photo&name=Photo.jpg')
      .set('Content-Type', 'image/jpeg').send(Buffer.from('photo'));
    db.prepare('INSERT INTO task_photos (id, taskId, fileId, createdAt) VALUES (?, ?, ?, ?)')
      .run('tp1', 'task1', 'tphoto1', 1);

    expect((await request(app).get('/api/storage/orphans')).body.count).toBe(0);
    await request(app).post('/api/storage/orphans/cleanup');
    expect((await request(app).get('/api/files/tphoto1/meta')).status).toBe(200);
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
      name: 'Test Project', status: 'bidding', version: 1, archived: false,
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
    const res = await request(app).patch('/api/projects/p1').send({ version: 1, status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, version: 2, status: 'in_progress' });
    const get = await request(app).get('/api/projects/p1');
    expect(get.body.status).toBe('in_progress');
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
    expect((await request(app).patch('/api/projects/p1').send({ status: 'in_progress' })).status).toBe(400); // no version
    expect((await request(app).patch('/api/projects/p1').send({ version: 1, name: '' })).status).toBe(400);
  });

  it('404s for unknown projects', async () => {
    expect((await request(app).patch('/api/projects/nope').send({ version: 1, name: 'X' })).status).toBe(404);
  });
});

describe('GET /api/activity', () => {
  it('records project create and status change events', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    await request(app).patch('/api/projects/p1').send({ version: 1, status: 'in_progress' });
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
    expect(res.body).toMatchObject({ id: 'p1', name: 'Test Project', status: 'bidding', version: 1 });
    expect(res.body.pages).toBeUndefined();
  });

  it('404s for unknown projects', async () => {
    expect((await request(app).get('/api/projects/nope/summary')).status).toBe(404);
  });

  it('includes contractValueCents (base + approved COs) and invoiceCount', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'pc' });
    db.prepare('UPDATE projects SET contractValue = 5000 WHERE id = ?').run('pc');
    const co = await request(app).post('/api/projects/pc/change-orders').send({ number: 'CO-1', lumpSumAmount: 1000 });
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
      broadcastChange: () => {},
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
      broadcastChange: () => {},
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
    await request(app).patch('/api/projects/p1').send({ version: 1, status: 'in_progress' });
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
    expect(res.body).toMatchObject({ success: true, fileId: 'doc1', versioned: false });
  });

  it('POST /api/files/:id versions the source document instead of adding a second row', async () => {
    const qs = 'projectId=p1&kind=invoice&sourceType=invoice&sourceId=inv-1&customerId=c1&name=Invoice%2012.pdf';
    const first = await request(app).post(`/api/files/gen1?${qs}`)
      .set('Content-Type', 'application/pdf').send(Buffer.from('v1'));
    expect(first.body).toMatchObject({ fileId: 'gen1', versioned: false });

    // a regenerate mints a new id client-side; it must land on the same document
    const second = await request(app).post(`/api/files/gen2?${qs}`)
      .set('Content-Type', 'application/pdf').send(Buffer.from('v2'));
    expect(second.body).toMatchObject({ fileId: 'gen1', versioned: true });
    expect((await request(app).get('/api/files/gen2/meta')).status).toBe(404);

    const meta = await request(app).get('/api/files/gen1/meta');
    expect(meta.body).toMatchObject({ versionNumber: 2, sourceType: 'invoice', sourceId: 'inv-1', customerId: 'c1' });
    const versions = await request(app).get('/api/files/gen1/versions');
    expect(versions.body.map((v: any) => v.versionNumber)).toEqual([2, 1]);
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
    await request(app).post('/api/projects/p1/payments').send({ targetType: 'invoice', targetId: invoiceId, date: 1, amount: 50, method: 'check' });
    await request(app).post('/api/projects/p1/change-orders').send({ number: 'CO-1', description: 'Extra', lumpSumAmount: 200 });
    await request(app).delete('/api/projects/p1');
    // all billing rows gone
    for (const sql of [
      'SELECT COUNT(*) c FROM invoices WHERE projectId = ?',
      'SELECT COUNT(*) c FROM change_orders WHERE projectId = ?',
    ]) {
      expect((db.prepare(sql).get('p1') as any).c).toBe(0);
    }
    expect((db.prepare("SELECT COUNT(*) c FROM payments WHERE targetType = 'invoice' AND targetId IN (SELECT id FROM invoices WHERE projectId = ?)").get('p1') as any).c).toBe(0);
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
    const pay = await request(app).post('/api/projects/p1/payments').send({ targetType: 'invoice', targetId: id, amount: 40, method: 'check' });
    expect(pay.status).toBe(200);
    expect((await request(app).get(`/api/invoices/${id}`)).body.balanceCents).toBe(6000);
    await request(app).delete(`/api/payments/${pay.body.id}`).expect(200);
    expect((await request(app).get(`/api/invoices/${id}`)).body.balanceCents).toBe(10000);
  });

  it('change orders + project billing summary rollup', async () => {
    // set a base contract value via PATCH project
    await request(app).patch('/api/projects/p1').send({ version: 1, /* contractValue not in patch — set directly */ });
    db.prepare('UPDATE projects SET contractValue = 10000 WHERE id = ?').run('p1');
    const co = await request(app).post('/api/projects/p1/change-orders').send({ number: 'CO-1', description: 'Extra', lumpSumAmount: 2000 });
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
      broadcastChange: () => {},
    });
    expect((await request(memberApp).get('/api/projects/p1/invoices')).status).toBe(403);
    expect((await request(memberApp).post('/api/projects/p1/invoices').send({ lines: [] })).status).toBe(403);
  });
});

describe('unified project payment routes (admin-gated)', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
  });

  it('rejects non-admins with 403 on GET + POST', async () => {
    const memberApp = express();
    memberApp.use(express.json());
    registerDataRoutes(memberApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'm1', role: 'member' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: () => {},
    });
    expect((await request(memberApp).get('/api/projects/p1/payments')).status).toBe(403);
    expect((await request(memberApp).post('/api/projects/p1/payments').send({ targetType: 'invoice', targetId: 'x', amount: 1 })).status).toBe(403);
  });

  it('records payments against invoice and pay-app targets; lists both with labels', async () => {
    const invId = (await request(app).post('/api/projects/p1/invoices')
      .send({ number: 'INV-1', lines: [{ description: 'A', qty: 1, unitPrice: 100 }] })).body.id;
    await request(app).post('/api/projects/p1/aia/sov').send({ description: 'Work', scheduledValueCents: 100000 });
    const appId = (await request(app).post('/api/projects/p1/aia/pay-apps').send({})).body.id;

    const payInv = await request(app).post('/api/projects/p1/payments')
      .send({ targetType: 'invoice', targetId: invId, amount: 40, method: 'check' });
    expect(payInv.status).toBe(200);
    const payApp = await request(app).post('/api/projects/p1/payments')
      .send({ targetType: 'payapp', targetId: appId, amount: 75, method: 'ach' });
    expect(payApp.status).toBe(200);

    const list = await request(app).get('/api/projects/p1/payments');
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(2);
    const labels = list.body.map((p: any) => p.targetLabel);
    expect(labels.some((l: string) => /INV-1/.test(l))).toBe(true);
    expect(labels.some((l: string) => /Application #1/.test(l))).toBe(true);
  });

  it('bad targetType → 400', async () => {
    const invId = (await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-1', lines: [] })).body.id;
    const res = await request(app).post('/api/projects/p1/payments')
      .send({ targetType: 'bogus', targetId: invId, amount: 10 });
    expect(res.status).toBe(400);
  });

  it('missing/unknown targetId → 404', async () => {
    const res = await request(app).post('/api/projects/p1/payments')
      .send({ targetType: 'invoice', targetId: 'does-not-exist', amount: 10 });
    expect(res.status).toBe(404);
  });

  it('amount <= 0 → 400', async () => {
    const invId = (await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-1', lines: [] })).body.id;
    const res = await request(app).post('/api/projects/p1/payments')
      .send({ targetType: 'invoice', targetId: invId, amount: 0 });
    expect(res.status).toBe(400);
  });

  it('DELETE /api/payments/:id removes it', async () => {
    const invId = (await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-1', lines: [] })).body.id;
    const pay = await request(app).post('/api/projects/p1/payments')
      .send({ targetType: 'invoice', targetId: invId, amount: 25 });
    expect(pay.status).toBe(200);
    await request(app).delete(`/api/payments/${pay.body.id}`).expect(200);
    expect((await request(app).get('/api/projects/p1/payments')).body.length).toBe(0);
  });

  it('billing summary reflects paid splits (invoicesCents / payAppsCents)', async () => {
    const invId = (await request(app).post('/api/projects/p1/invoices')
      .send({ number: 'INV-1', lines: [{ description: 'A', qty: 1, unitPrice: 1000 }] })).body.id;
    await request(app).post('/api/projects/p1/aia/sov').send({ description: 'Work', scheduledValueCents: 100000 });
    const appId = (await request(app).post('/api/projects/p1/aia/pay-apps').send({})).body.id;

    await request(app).post('/api/projects/p1/payments').send({ targetType: 'invoice', targetId: invId, amount: 300 });
    await request(app).post('/api/projects/p1/payments').send({ targetType: 'payapp', targetId: appId, amount: 125 });

    const summary = await request(app).get('/api/projects/p1/billing-summary');
    expect(summary.status).toBe(200);
    expect(summary.body.paid.invoicesCents).toBe(30000);
    expect(summary.body.paid.payAppsCents).toBe(12500);
  });
});

describe('AIA billing routes (admin-gated)', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
  });

  it('rejects non-admins with 403 (requireAdmin)', async () => {
    const memberApp = express();
    memberApp.use(express.json());
    registerDataRoutes(memberApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u2', role: 'user' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: () => {},
    });
    expect((await request(memberApp).get('/api/projects/p1/aia/sov')).status).toBe(403);
    expect((await request(memberApp).post('/api/projects/p1/aia/sov').send({ description: 'X', scheduledValueCents: 1 })).status).toBe(403);
    expect((await request(memberApp).get('/api/projects/p1/aia/settings')).status).toBe(403);
  });

  it('SOV create → list', async () => {
    const create = await request(app).post('/api/projects/p1/aia/sov')
      .send({ description: 'Drywall', scheduledValueCents: 50000 });
    expect(create.status).toBe(200);
    expect(create.body.id).toBeTruthy();
    const list = await request(app).get('/api/projects/p1/aia/sov');
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect(list.body[0].description).toBe('Drywall');
    expect(list.body[0].scheduledValueCents).toBe(50000);
  });

  it('SOV seed replaces estimate lines', async () => {
    const seed = await request(app).post('/api/projects/p1/aia/sov/seed')
      .send({ lines: [
        { description: 'Framing', scheduledValueCents: 100000 },
        { description: 'Paint', scheduledValueCents: 25000 },
      ] });
    expect(seed.status).toBe(200);
    expect(seed.body.count).toBe(2);
    const list = await request(app).get('/api/projects/p1/aia/sov');
    expect(list.body.length).toBe(2);
    expect(list.body.map((l: any) => l.description)).toEqual(['Framing', 'Paint']);
  });

  it('SOV sync-change-orders appends approved COs as SOV lines', async () => {
    const co = await request(app).post('/api/projects/p1/change-orders')
      .send({ number: '1', description: 'Extra scope', lumpSumAmount: 300 });
    await request(app).patch(`/api/change-orders/${co.body.id}`).send({ status: 'approved' });
    const sync = await request(app).post('/api/projects/p1/aia/sov/sync-change-orders').send({});
    expect(sync.status).toBe(200);
    expect(sync.body.added).toBe(1);
    const list = await request(app).get('/api/projects/p1/aia/sov');
    const coLine = list.body.find((l: any) => l.isChangeOrder);
    expect(coLine).toBeTruthy();
    expect(coLine.scheduledValueCents).toBe(30000); // 300 * 100
    // idempotent
    const again = await request(app).post('/api/projects/p1/aia/sov/sync-change-orders').send({});
    expect(again.body.added).toBe(0);
  });

  it('PUT SOV line is version-checked (409 version_conflict on stale)', async () => {
    const id = (await request(app).post('/api/projects/p1/aia/sov')
      .send({ description: 'D', scheduledValueCents: 1000 })).body.id;
    const ok = await request(app).put(`/api/aia/sov/${id}`)
      .send({ description: 'D2', scheduledValueCents: 2000, version: 1 });
    expect(ok.status).toBe(200);
    const stale = await request(app).put(`/api/aia/sov/${id}`)
      .send({ description: 'Clobber', scheduledValueCents: 3000, version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('pay app create → get returns app, lines, g702, g703', async () => {
    await request(app).post('/api/projects/p1/aia/sov')
      .send({ description: 'Work', scheduledValueCents: 100000 });
    const create = await request(app).post('/api/projects/p1/aia/pay-apps').send({});
    expect(create.status).toBe(200);
    expect(create.body.id).toBeTruthy();
    expect(create.body.number).toBe(1);
    const list = await request(app).get('/api/projects/p1/aia/pay-apps');
    expect(list.body.length).toBe(1);
    const get = await request(app).get(`/api/aia/pay-apps/${create.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body.app).toBeTruthy();
    expect(Array.isArray(get.body.lines)).toBe(true);
    expect(Array.isArray(get.body.g703)).toBe(true);
    expect(get.body.g702).toHaveProperty('L1originalContractCents');
    expect(get.body.g702.L1originalContractCents).toBe(100000);
  });

  it('GET unknown pay app → 404', async () => {
    expect((await request(app).get('/api/aia/pay-apps/nope')).status).toBe(404);
  });

  it('PUT pay app lines is version-checked (200 then 409 on stale)', async () => {
    const sovId = (await request(app).post('/api/projects/p1/aia/sov')
      .send({ description: 'Work', scheduledValueCents: 100000 })).body.id;
    const appId = (await request(app).post('/api/projects/p1/aia/pay-apps').send({})).body.id;
    const ok = await request(app).put(`/api/aia/pay-apps/${appId}/lines`)
      .send({ version: 1, lines: [{ sovLineId: sovId, percentComplete: 50, storedMaterialsCents: 0 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
    const stale = await request(app).put(`/api/aia/pay-apps/${appId}/lines`)
      .send({ version: 1, lines: [{ sovLineId: sovId, percentComplete: 75, storedMaterialsCents: 0 }] });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('new pay app defaults storedRetainagePercent to retainagePercent, ignoring legacy stored settings', async () => {
    // Legacy projects still carry a distinct storedRetainagePercent in
    // aiaSettings from the two-rate era; the single-rate world must not let
    // that leak into new apps — they should snapshot 15/15, not 15/10.
    await request(app).put('/api/projects/p1/aia/settings')
      .send({ retainagePercent: 15, storedRetainagePercent: 10 });
    const create = await request(app).post('/api/projects/p1/aia/pay-apps').send({});
    expect(create.status).toBe(200);
    const get = await request(app).get(`/api/aia/pay-apps/${create.body.id}`);
    expect(get.body.app.retainagePercent).toBe(15);
    expect(get.body.app.storedRetainagePercent).toBe(15);
  });

  it('aia/settings round-trips via project meta', async () => {
    const empty = await request(app).get('/api/projects/p1/aia/settings');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({});
    const put = await request(app).put('/api/projects/p1/aia/settings')
      .send({ retainagePercent: 5, storedRetainagePercent: 0, architect: 'AOR Inc' });
    expect(put.status).toBe(200);
    const get = await request(app).get('/api/projects/p1/aia/settings');
    expect(get.body.retainagePercent).toBe(5);
    expect(get.body.storedRetainagePercent).toBe(0);
    expect(get.body.architect).toBe('AOR Inc');
    // survives a project reload
    expect(loadProject(db, 'p1').aiaSettings.retainagePercent).toBe(5);
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

describe('deleteProject rfis cascade', () => {
  it('removes rfis and rfi_photos for the project', async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
    const rfi = await request(app).post('/api/projects/p1/rfis').send({ title: 'Detail question', question: 'Which finish?' });
    await request(app).post('/api/files/ph1?projectId=p1&kind=photo&name=p.jpg')
      .set('Content-Type', 'image/jpeg').send(Buffer.from('img'));
    await request(app).post(`/api/rfis/${rfi.body.id}/photos`).send({ fileId: 'ph1' });
    await request(app).delete('/api/projects/p1');
    expect((db.prepare('SELECT COUNT(*) c FROM rfis WHERE projectId = ?').get('p1') as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM rfi_photos WHERE rfiId IN (SELECT id FROM rfis WHERE projectId = ?)').get('p1') as any).c).toBe(0);
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

describe('rfi routes', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
  });

  it('create → number 1, then 2 (per project); 400 with no title; 404 unknown project', async () => {
    const c1 = await request(app).post('/api/projects/p1/rfis').send({ title: 'First question' });
    expect(c1.status).toBe(200);
    expect(c1.body.number).toBe(1);
    const c2 = await request(app).post('/api/projects/p1/rfis').send({ title: 'Second question' });
    expect(c2.status).toBe(200);
    expect(c2.body.number).toBe(2);
    expect((await request(app).post('/api/projects/p1/rfis').send({ title: '' })).status).toBe(400);
    expect((await request(app).post('/api/projects/nope/rfis').send({ title: 'X' })).status).toBe(404);
  });

  it('create stores specRef/drawingRef/attention/responseNeededBy (GET returns them)', async () => {
    const create = await request(app).post('/api/projects/p1/rfis').send({
      title: 'Finish clarification',
      specRef: '09 30 00',
      drawingRef: 'A-501',
      attention: 'Architect',
      responseNeededBy: '2026-08-01',
    });
    expect(create.status).toBe(200);
    const get = await request(app).get(`/api/rfis/${create.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body.specRef).toBe('09 30 00');
    expect(get.body.drawingRef).toBe('A-501');
    expect(get.body.attention).toBe('Architect');
    expect(get.body.responseNeededBy).toBe('2026-08-01');
  });

  it('GET unknown id → 404', async () => {
    expect((await request(app).get('/api/rfis/nope')).status).toBe(404);
  });

  it('PUT round-trip bumps version; stale version → 409 with code version_conflict', async () => {
    const id = (await request(app).post('/api/projects/p1/rfis').send({ title: 'A' })).body.id;
    const rfi = (await request(app).get(`/api/rfis/${id}`)).body;
    const ok = await request(app).put(`/api/rfis/${id}`).send({ ...rfi, title: 'A2' });
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
    expect(ok.body.version).toBe(rfi.version + 1);
    const stale = await request(app).put(`/api/rfis/${id}`).send({ ...rfi, title: 'Clobber' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('PATCH status → answered ok; bogus → 400; PATCH to closed succeeds', async () => {
    const id = (await request(app).post('/api/projects/p1/rfis').send({ title: 'A' })).body.id;
    const answered = await request(app).patch(`/api/rfis/${id}`).send({ status: 'answered' });
    expect(answered.status).toBe(200);
    expect((await request(app).get(`/api/rfis/${id}`)).body.status).toBe('answered');
    const bogus = await request(app).patch(`/api/rfis/${id}`).send({ status: 'bogus' });
    expect(bogus.status).toBe(400);
    const closed = await request(app).patch(`/api/rfis/${id}`).send({ status: 'closed' });
    expect(closed.status).toBe(200);
    expect((await request(app).get(`/api/rfis/${id}`)).body.status).toBe('closed');
  });

  it('DELETE removes; photos: POST without fileId → 400, POST+DELETE round-trip, photoCount in list', async () => {
    const id = (await request(app).post('/api/projects/p1/rfis').send({ title: 'A' })).body.id;
    const badPhoto = await request(app).post(`/api/rfis/${id}/photos`).send({});
    expect(badPhoto.status).toBe(400);
    await request(app).post('/api/files/ph1?projectId=p1&kind=photo&name=p.jpg').set('Content-Type', 'image/jpeg').send(Buffer.from('x'));
    await request(app).post(`/api/rfis/${id}/photos`).send({ fileId: 'ph1' }).expect(200);
    let list = await request(app).get('/api/projects/p1/rfis');
    expect(list.body.find((r: any) => r.id === id).photoCount).toBe(1);
    await request(app).delete(`/api/rfis/${id}/photos/ph1`).expect(200);
    list = await request(app).get('/api/projects/p1/rfis');
    expect(list.body.find((r: any) => r.id === id).photoCount).toBe(0);
    await request(app).delete(`/api/rfis/${id}`).expect(200);
    expect((await request(app).get(`/api/rfis/${id}`)).status).toBe(404);
  });

  it('POST /api/rfis/:id/response handles missing input, text, file, closed RFI, and unknown id', async () => {
    const id = (await request(app).post('/api/projects/p1/rfis').send({ title: 'A' })).body.id;

    expect((await request(app).post(`/api/rfis/${id}/response`).send({})).status).toBe(400);

    const textRes = await request(app).post(`/api/rfis/${id}/response`).send({ text: 'Per detail 5/A-501' });
    expect(textRes.status).toBe(200);
    const afterText = (await request(app).get(`/api/rfis/${id}`)).body;
    expect(afterText.status).toBe('answered');
    expect(afterText.answeredAt).toBeTruthy();
    expect(afterText.responseText).toBe('Per detail 5/A-501');

    const fileRes = await request(app).post(`/api/rfis/${id}/response`).send({ fileId: 'file-1' });
    expect(fileRes.status).toBe(200);
    expect((await request(app).get(`/api/rfis/${id}`)).body.responseFileId).toBe('file-1');

    await request(app).patch(`/api/rfis/${id}`).send({ status: 'closed' });
    const closedRes = await request(app).post(`/api/rfis/${id}/response`).send({ text: 'Additional note' });
    expect(closedRes.status).toBe(200);
    expect((await request(app).get(`/api/rfis/${id}`)).body.status).toBe('closed');

    expect((await request(app).post('/api/rfis/nope/response').send({ text: 'x' })).status).toBe(404);
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
      broadcastChange: () => {},
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

describe('users-list + task routes (auth-only, not admin-gated)', () => {
  let userApp: express.Express;

  beforeEach(() => {
    // Seed real users so /api/users/list and assignee validation have rows
    db.prepare("INSERT INTO users (id, username, password, role) VALUES ('u1','alice','secret','admin'),('u2','bob','hunter2','user')").run();

    // Non-admin 'user' app — every task route must work here (NOT admin-gated)
    userApp = express();
    userApp.use(express.json());
    registerDataRoutes(userApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u2', role: 'user' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: () => {},
    });
  });

  it('GET /api/users/list (non-admin) returns roster with no password leaked', async () => {
    const res = await request(userApp).get('/api/users/list');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body) {
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('username');
      expect(row).toHaveProperty('role');
      expect(row).not.toHaveProperty('password');
    }
  });

  it('POST /api/tasks (non-admin) creates a task — not admin-gated', async () => {
    const res = await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Fix door' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();
  });

  it('GET /api/tasks (non-admin) lists tasks with assigneeUsername (null when unassigned)', async () => {
    const create = await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Fix door' });
    const list = await request(userApp).get('/api/tasks');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    const row = list.body.find((t: any) => t.id === create.body.id);
    expect(row).toBeTruthy();
    expect(row.assigneeUsername).toBeNull();
  });

  it('POST /api/tasks with a real assignee → 200; bogus assignee → 400', async () => {
    const ok = await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Assigned', assigneeUserId: 'u1' });
    expect(ok.status).toBe(200);
    const get = await request(userApp).get(`/api/tasks/${ok.body.id}`);
    expect(get.body.assigneeUsername).toBe('alice');
    const bad = await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Bad', assigneeUserId: 'nope' });
    expect(bad.status).toBe(400);
  });

  it('POST /api/tasks with a projectId derives+returns the project customer + names', async () => {
    db.prepare("INSERT INTO customers (id, name, createdAt) VALUES ('c1','Acme',0)").run();
    db.prepare("INSERT INTO projects (id, name, customerId, version, createdAt) VALUES ('pr1','Plaza','c1',1,0)").run();
    // A mismatched client customerId must be ignored — the project dictates the customer.
    const ok = await request(userApp).post('/api/tasks').send({ title: 'On project', projectId: 'pr1', customerId: 'bogus' });
    expect(ok.status).toBe(200);
    const get = await request(userApp).get(`/api/tasks/${ok.body.id}`);
    expect(get.body.projectId).toBe('pr1');
    expect(get.body.customerId).toBe('c1');
    expect(get.body.projectName).toBe('Plaza');
    expect(get.body.customerName).toBe('Acme');
    // Unknown project id is rejected at the route.
    const bad = await request(userApp).post('/api/tasks').send({ title: 'Bad', projectId: 'nope' });
    expect(bad.status).toBe(400);
  });

  it('GET /api/tasks?projectId= and ?customerId= filter the list', async () => {
    db.prepare("INSERT INTO customers (id, name, createdAt) VALUES ('c1','Acme',0),('c2','Globex',0)").run();
    db.prepare("INSERT INTO projects (id, name, customerId, version, createdAt) VALUES ('pr1','Plaza','c1',1,0)").run();
    await request(userApp).post('/api/tasks').send({ title: 'onPr1', projectId: 'pr1' });
    await request(userApp).post('/api/tasks').send({ title: 'onC2', customerId: 'c2' });
    await request(userApp).post('/api/tasks').send({ title: 'unlinked' });
    const byProject = await request(userApp).get('/api/tasks?projectId=pr1');
    expect(byProject.body.map((t: any) => t.title)).toEqual(['onPr1']);
    const byCustomer = await request(userApp).get('/api/tasks?customerId=c1');
    expect(byCustomer.body.map((t: any) => t.title)).toEqual(['onPr1']); // derived from pr1
    const byCustomer2 = await request(userApp).get('/api/tasks?customerId=c2');
    expect(byCustomer2.body.map((t: any) => t.title)).toEqual(['onC2']);
  });

  it('PUT /api/tasks/:id with stale version 99 → 409 version_conflict', async () => {
    const id = (await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Door' })).body.id;
    const res = await request(userApp).put(`/api/tasks/${id}`).send({ title: 'Door', version: 99 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('version_conflict');
  });

  it('PATCH /api/tasks/:id status: valid → 200; bad → 400; missing → 400', async () => {
    const id = (await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Door' })).body.id;
    expect((await request(userApp).patch(`/api/tasks/${id}`).send({ status: 'in_progress' })).status).toBe(200);
    expect((await request(userApp).patch(`/api/tasks/${id}`).send({ status: 'nope' })).status).toBe(400);
    expect((await request(userApp).patch(`/api/tasks/${id}`).send({})).status).toBe(400);
  });

  it('POST /api/tasks/:id/photos: valid stage → 200, appears in GET; bad stage → 400', async () => {
    const id = (await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Door' })).body.id;
    const add = await request(userApp).post(`/api/tasks/${id}/photos`).send({ fileId: 'f1', stage: 'before' });
    expect(add.status).toBe(200);
    const bad = await request(userApp).post(`/api/tasks/${id}/photos`).send({ fileId: 'f1', stage: 'sideways' });
    expect(bad.status).toBe(400);
    const get = await request(userApp).get(`/api/tasks/${id}`);
    expect(get.body.photos.some((p: any) => p.fileId === 'f1')).toBe(true);
  });
});

describe('email send routes', () => {
  // Records every mailOptions passed to the stubbed transporter.
  let sent: any[];
  // When true, buildTransporter returns null → SMTP-absent no-op path.
  let smtpAbsent: boolean;
  let emailApp: express.Express;

  const buildEmailApp = (role: 'admin' | 'member', userId = 'u1') => {
    const a = express();
    a.use(express.json({ limit: '50mb' }));
    registerEmailRoutes(a, {
      db,
      dataDir: dir,
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: userId, role }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      buildTransporter: (_userId: string) => smtpAbsent ? null : ({ sendMail: async (opts: any) => { sent.push(opts); return { messageId: 'stub' }; }, verify: async () => true } as any),
      // From header now comes from the SENDING user's per-user SMTP config.
      getUserSmtp: (_userId: string) => ({ fromAddress: 'noreply@example.com', fromName: 'Frugal' }),
      broadcastChange: () => {},
    });
    return a;
  };

  beforeEach(async () => {
    sent = [];
    smtpAbsent = false;
    emailApp = buildEmailApp('admin');
    // emailApp only has the email routes; create the project + files via the data-routes app (shared db).
    await request(app).post('/api/projects').send(PROJECT);
    // Primary PDF + two extra attachments, stored with metadata
    await request(app).post('/api/files/primary?projectId=p1&kind=invoice&name=primary.pdf').set('Content-Type', 'application/pdf').send(Buffer.from('PDFPRIMARY'));
    await request(app).post('/api/files/extra1?projectId=p1&kind=email-attachment&name=Spec.pdf').set('Content-Type', 'application/pdf').send(Buffer.from('SPECBYTES'));
    await request(app).post('/api/files/extra2?projectId=p1&kind=email-attachment&name=Photo.jpg').set('Content-Type', 'image/jpeg').send(Buffer.from('JPEGBYTES'));
  });

  const makeInvoice = async () =>
    (await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-1', lines: [{ description: 'Work', qty: 1, unitPrice: 100 }] })).body.id;

  // Per-user SMTP config save/read/isolation: these exercise the REAL
  // user_preferences-backed getUserSmtp (not the From-header stub used elsewhere),
  // so each app gets a real reader scoped to its own userId.
  const buildRealSmtpApp = (userId: string) => {
    const getUserSmtp = (uid: string): Record<string, string> => {
      const rows = db.prepare("SELECT key, value FROM user_preferences WHERE userId = ? AND key LIKE 'smtp.%'").all(uid) as { key: string; value: string }[];
      const cfg: Record<string, string> = {};
      rows.forEach(r => { cfg[r.key.replace('smtp.', '')] = r.value; });
      return cfg;
    };
    const a = express();
    a.use(express.json({ limit: '50mb' }));
    registerEmailRoutes(a, {
      db,
      dataDir: dir,
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: userId, role: 'member' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      buildTransporter: (uid: string) => { const c = getUserSmtp(uid); return (c.host && c.username) ? ({ verify: async () => true } as any) : null; },
      getUserSmtp,
      broadcastChange: () => {},
    });
    return a;
  };

  it('smtp save: coerces boolean/number values to strings; reads back per-user', async () => {
    // The client sends `secure` as a boolean and `port` as a number; SQLite can
    // only bind strings/numbers/null, so the route must coerce before binding.
    const u1App = buildRealSmtpApp('smtp-u1');
    const res = await request(u1App).post('/api/email/smtp').send({
      host: 'smtp.example.com', port: 465, secure: true, username: 'u', password: 'p',
    });
    expect(res.status).toBe(200);
    const saved = (await request(u1App).get('/api/email/smtp')).body;
    expect(saved.secure).toBe('true');
    expect(saved.port).toBe('465');
    expect(saved.host).toBe('smtp.example.com');
  });

  it('smtp save: is isolated per-user — a second user does not see the first user\'s config', async () => {
    const u1App = buildRealSmtpApp('iso-u1');
    const u2App = buildRealSmtpApp('iso-u2');
    await request(u1App).post('/api/email/smtp').send({ host: 'u1.smtp', username: 'u1', password: 'p1' });
    // u2 has saved nothing → empty config, never u1's
    expect((await request(u2App).get('/api/email/smtp')).body).toEqual({});
    // u2 saves its own; the two stay distinct
    await request(u2App).post('/api/email/smtp').send({ host: 'u2.smtp', username: 'u2', password: 'p2' });
    expect((await request(u1App).get('/api/email/smtp')).body.host).toBe('u1.smtp');
    expect((await request(u2App).get('/api/email/smtp')).body.host).toBe('u2.smtp');
  });

  it('invoice send: accepts cc/bcc/subject/body + multiple attachments; forwards them; marks sent', async () => {
    const id = await makeInvoice();
    const res = await request(emailApp).post(`/api/invoices/${id}/send`).send({
      to: 'client@example.com',
      cc: ' cc@example.com ',
      bcc: 'bcc@example.com',
      subject: 'Custom Subject',
      body: 'Custom body text',
      fileId: 'primary',
      attachmentFileIds: ['extra1', 'extra2'],
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const m = sent[0];
    expect(m.to).toBe('client@example.com');
    expect(m.cc).toBe('cc@example.com');   // trimmed
    expect(m.bcc).toBe('bcc@example.com');
    expect(m.subject).toBe('Custom Subject');
    expect(m.text).toBe('Custom body text');
    expect(m.from).toContain('noreply@example.com');
    // primary + two extras, named from metadata
    expect(m.attachments.map((a: any) => a.filename)).toEqual(['INV-1.pdf', 'Spec.pdf', 'Photo.jpg']);
    expect(m.attachments[0].content.toString()).toBe('PDFPRIMARY');
    expect(m.attachments[1].contentType).toBe('application/pdf');
    expect(m.attachments[2].contentType).toBe('image/jpeg');
    // status side-effect fired
    expect((await request(app).get(`/api/invoices/${id}`)).body.status).toBe('sent');
  });

  it('invoice send: omits cc/bcc when blank; falls back to default subject/body; single attachment', async () => {
    const id = await makeInvoice();
    const res = await request(emailApp).post(`/api/invoices/${id}/send`).send({
      to: 'client@example.com', cc: '   ', bcc: '', subject: '   ', body: undefined, fileId: 'primary',
    });
    expect(res.status).toBe(200);
    const m = sent[0];
    expect('cc' in m).toBe(false);
    expect('bcc' in m).toBe(false);
    expect(m.subject).toBe('Invoice INV-1');
    expect(m.text).toBe('Please find the attached invoice.');
    expect(m.attachments).toHaveLength(1);
  });

  it('invoice send: legacy "message" still works as the body alias', async () => {
    const id = await makeInvoice();
    await request(emailApp).post(`/api/invoices/${id}/send`).send({ to: 'a@b.com', fileId: 'primary', message: 'legacy body' });
    expect(sent[0].text).toBe('legacy body');
  });

  it('invoice send: unresolved attachment ids are skipped silently', async () => {
    const id = await makeInvoice();
    await request(emailApp).post(`/api/invoices/${id}/send`).send({
      to: 'a@b.com', fileId: 'primary', attachmentFileIds: ['extra1', 'does-not-exist', 'extra2'],
    });
    expect(sent[0].attachments.map((a: any) => a.filename)).toEqual(['INV-1.pdf', 'Spec.pdf', 'Photo.jpg']);
  });

  it('invoice send: requires to + fileId', async () => {
    const id = await makeInvoice();
    expect((await request(emailApp).post(`/api/invoices/${id}/send`).send({ fileId: 'primary' })).status).toBe(400);
    expect((await request(emailApp).post(`/api/invoices/${id}/send`).send({ to: 'a@b.com' })).status).toBe(400);
  });

  it('invoice send: non-admin gets 403', async () => {
    const id = await makeInvoice();
    const memberApp = buildEmailApp('member');
    expect((await request(memberApp).post(`/api/invoices/${id}/send`).send({ to: 'a@b.com', fileId: 'primary' })).status).toBe(403);
  });

  it('SMTP-absent: send throws "SMTP not configured" → 500, no side-effect', async () => {
    const id = await makeInvoice();
    smtpAbsent = true;
    const res = await request(emailApp).post(`/api/invoices/${id}/send`).send({ to: 'a@b.com', fileId: 'primary' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/SMTP not configured/);
    expect(sent).toHaveLength(0);
    expect((await request(app).get(`/api/invoices/${id}`)).body.status).not.toBe('sent');
  });

  it('change-order send: default subject/name + cc/bcc + extras; admin-gated', async () => {
    const co = (await request(app).post('/api/projects/p1/change-orders').send({ number: 'CO-9', description: 'Extra work', lumpSumAmount: 100 })).body;
    const res = await request(emailApp).post(`/api/change-orders/${co.id}/send`).send({
      to: 'gc@example.com', cc: 'pm@example.com', fileId: 'primary', attachmentFileIds: ['extra1'],
    });
    expect(res.status).toBe(200);
    const m = sent[0];
    expect(m.subject).toBe('Change Order Request CO-9');
    expect(m.cc).toBe('pm@example.com');
    expect(m.attachments.map((a: any) => a.filename)).toEqual(['CO-CO-9.pdf', 'Spec.pdf']);
    expect((await request(app).get(`/api/change-orders/${co.id}`)).body.status).toBe('sent');
    // non-admin blocked
    const memberApp = buildEmailApp('member');
    expect((await request(memberApp).post(`/api/change-orders/${co.id}/send`).send({ to: 'a@b.com', fileId: 'primary' })).status).toBe(403);
  });

  it('issue send: authenticated non-admin allowed; default ISS subject/name; cc/bcc + extras', async () => {
    const iss = (await request(app).post('/api/projects/p1/issues').send({ title: 'Crack' })).body;
    const memberApp = buildEmailApp('member'); // NOT admin-gated
    const res = await request(memberApp).post(`/api/issues/${iss.id}/send`).send({
      to: 'gc@example.com', bcc: 'log@example.com', fileId: 'primary', attachmentFileIds: ['extra2'],
    });
    expect(res.status).toBe(200);
    const m = sent[0];
    expect(m.subject).toBe('Issue ISS-001 — Crack');
    expect(m.bcc).toBe('log@example.com');
    expect(m.attachments.map((a: any) => a.filename)).toEqual(['ISS-001.pdf', 'Photo.jpg']);
  });

  it('rfi send: authenticated non-admin allowed; default RFI subject/name; cc/bcc + extras', async () => {
    const rfi = (await request(app).post('/api/projects/p1/rfis').send({ title: 'Ceiling height' })).body;
    const memberApp = buildEmailApp('member'); // NOT admin-gated
    const res = await request(memberApp).post(`/api/rfis/${rfi.id}/send`).send({
      to: 'gc@example.com', bcc: 'log@example.com', fileId: 'primary', attachmentFileIds: ['extra2'],
    });
    expect(res.status).toBe(200);
    const m = sent[0];
    expect(m.subject).toBe('RFI RFI-001 — Ceiling height');
    expect(m.bcc).toBe('log@example.com');
    expect(m.attachments.map((a: any) => a.filename)).toEqual(['RFI-001.pdf', 'Photo.jpg']);
  });

  it('rfi send: requires to + fileId; 404 for unknown rfi', async () => {
    const rfi = (await request(app).post('/api/projects/p1/rfis').send({ title: 'Ceiling height' })).body;
    expect((await request(emailApp).post(`/api/rfis/${rfi.id}/send`).send({ fileId: 'primary' })).status).toBe(400);
    expect((await request(emailApp).post(`/api/rfis/${rfi.id}/send`).send({ to: 'a@b.com' })).status).toBe(400);
    expect((await request(emailApp).post('/api/rfis/nope/send').send({ to: 'a@b.com', fileId: 'primary' })).status).toBe(404);
  });

  it('rfi send: explicit subject/cc/bcc/body pass through; extra attachmentFileIds appended', async () => {
    const rfi = (await request(app).post('/api/projects/p1/rfis').send({ title: 'Ceiling height' })).body;
    const res = await request(emailApp).post(`/api/rfis/${rfi.id}/send`).send({
      to: 'client@example.com',
      cc: ' cc@example.com ',
      bcc: 'bcc@example.com',
      subject: 'Custom Subject',
      body: 'Custom body text',
      fileId: 'primary',
      attachmentFileIds: ['extra1', 'extra2'],
    });
    expect(res.status).toBe(200);
    const m = sent[0];
    expect(m.to).toBe('client@example.com');
    expect(m.cc).toBe('cc@example.com');
    expect(m.bcc).toBe('bcc@example.com');
    expect(m.subject).toBe('Custom Subject');
    expect(m.text).toBe('Custom body text');
    expect(m.attachments.map((a: any) => a.filename)).toEqual(['RFI-001.pdf', 'Spec.pdf', 'Photo.jpg']);
  });

  it('rfi send: marks rfi sent with sentAt set after send', async () => {
    const rfi = (await request(app).post('/api/projects/p1/rfis').send({ title: 'Ceiling height' })).body;
    expect((await request(app).get(`/api/rfis/${rfi.id}`)).body.status).toBe('open');
    const res = await request(emailApp).post(`/api/rfis/${rfi.id}/send`).send({ to: 'a@b.com', fileId: 'primary' });
    expect(res.status).toBe(200);
    const after = (await request(app).get(`/api/rfis/${rfi.id}`)).body;
    expect(after.status).toBe('sent');
    expect(typeof after.sentAt).toBe('number');
  });

  it('proposal send: to override + custom subject/body + extras; inReplyTo threaded; sets proposalSentAt', async () => {
    // project with an associated email to reply to
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pe', createdAt: 5,
      pages: [{ id: 'pgE', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
      email: { from: 'reply@example.com', fromName: 'Owner', subject: 'Bid request', messageId: '<msg-1@x>' },
    });
    const res = await request(emailApp).post('/api/projects/pe/send-proposal').send({
      to: 'override@example.com', cc: 'cc@example.com', subject: 'Our Proposal', body: 'See attached.',
      fileId: 'primary', attachmentFileIds: ['extra1'],
    });
    expect(res.status).toBe(200);
    const m = sent[0];
    expect(m.to).toBe('override@example.com');
    expect(m.cc).toBe('cc@example.com');
    expect(m.subject).toBe('Our Proposal');
    expect(m.text).toBe('See attached.');
    expect(m.inReplyTo).toBe('<msg-1@x>');
    expect(m.references).toBe('<msg-1@x>');
    expect(m.attachments.map((a: any) => a.filename)).toEqual(['Proposal.pdf', 'Spec.pdf']);
    // proposal side-effects persisted
    const fresh = loadProject(db, 'pe');
    expect(fresh.proposalFileId).toBe('primary');
    expect(typeof fresh.proposalSentAt).toBe('number');
  });

  it('proposal send: falls back to project email "from" + Re: subject when no overrides', async () => {
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pe2', createdAt: 6,
      pages: [{ id: 'pgE2', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
      email: { from: 'reply@example.com', subject: 'Bid request', messageId: '<msg-2@x>' },
    });
    await request(emailApp).post('/api/projects/pe2/send-proposal').send({ fileId: 'primary' });
    const m = sent[0];
    expect(m.to).toBe('reply@example.com');
    expect(m.subject).toBe('Re: Bid request');
    expect(m.text).toBe('Please find the attached proposal.');
    expect(m.attachments.map((a: any) => a.filename)).toEqual(['Proposal.pdf']);
  });

  it('proposal send: project WITHOUT email sends with an explicit "to" (no 400); cc/bcc/subject/body forwarded; proposalSentAt persisted', async () => {
    // A manually-created project — no inbound bid email at all.
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pe3', name: 'Manual Job', createdAt: 7,
      pages: [{ id: 'pgE3', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
    });
    const res = await request(emailApp).post('/api/projects/pe3/send-proposal').send({
      to: ' client@new.com ', cc: 'cc@new.com', bcc: 'bcc@new.com',
      subject: 'Your Proposal', body: 'Attached for review.',
      fileId: 'primary', attachmentFileIds: ['extra1'],
    });
    expect(res.status).toBe(200);
    const m = sent[0];
    expect(m.to).toBe('client@new.com'); // trimmed
    expect(m.cc).toBe('cc@new.com');
    expect(m.bcc).toBe('bcc@new.com');
    expect(m.subject).toBe('Your Proposal');
    expect(m.text).toBe('Attached for review.');
    // no bid email → not threaded
    expect(m.inReplyTo).toBeUndefined();
    expect(m.attachments.map((a: any) => a.filename)).toEqual(['Proposal.pdf', 'Spec.pdf']);
    // proposal side-effects persisted
    const fresh = loadProject(db, 'pe3');
    expect(fresh.proposalFileId).toBe('primary');
    expect(typeof fresh.proposalSentAt).toBe('number');
  });

  it('proposal send: project WITHOUT email defaults subject to "Proposal — <name>"', async () => {
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pe4', name: 'Manual Job', createdAt: 8,
      pages: [{ id: 'pgE4', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
    });
    await request(emailApp).post('/api/projects/pe4/send-proposal').send({ to: 'client@new.com', fileId: 'primary' });
    expect(sent[0].subject).toBe('Proposal — Manual Job');
  });

  it('proposal send: project WITHOUT email AND no "to" → 400, no send', async () => {
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pe5', name: 'Manual Job', createdAt: 9,
      pages: [{ id: 'pgE5', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
    });
    const res = await request(emailApp).post('/api/projects/pe5/send-proposal').send({ fileId: 'primary' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No recipient address');
    expect(sent).toHaveLength(0);
  });
});

describe('customers routes', () => {
  it('POST creates a customer, GET list returns it, GET by id works', async () => {
    const post = await request(app).post('/api/customers').send({
      name: 'Acme Corp', phone: '555-1234',
      emails: { general: 'info@acme.com' },
    });
    expect(post.status).toBe(200);
    expect(post.body.name).toBe('Acme Corp');
    const id = post.body.id;

    const list = await request(app).get('/api/customers');
    expect(list.status).toBe(200);
    // migrations seed an "Unassigned" customer; we added one more
    const names = list.body.map((c: any) => c.name);
    expect(names).toContain('Acme Corp');

    const get = await request(app).get(`/api/customers/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.emails.general).toBe('info@acme.com');
  });

  it('PUT updates a customer', async () => {
    const post = await request(app).post('/api/customers').send({ name: 'Old Name' });
    const id = post.body.id;
    const put = await request(app).put(`/api/customers/${id}`).send({ name: 'New Name', emails: {} });
    expect(put.status).toBe(200);
    expect(put.body.name).toBe('New Name');
  });

  it('DELETE removes a customer with no projects', async () => {
    const post = await request(app).post('/api/customers').send({ name: 'To Delete' });
    const id = post.body.id;
    const del = await request(app).delete(`/api/customers/${id}`);
    expect(del.status).toBe(200);
    expect((await request(app).get(`/api/customers/${id}`)).status).toBe(404);
  });

  it('DELETE customer with projects returns 409', async () => {
    const post = await request(app).post('/api/customers').send({ name: 'Has Projects' });
    const cid = post.body.id;
    // createProject stores customerId when it is in the payload
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pc1', customerId: cid,
    });
    const del = await request(app).delete(`/api/customers/${cid}`);
    expect(del.status).toBe(409);
  });

  it('PUT rename propagates to every owned project.contractor', async () => {
    const post = await request(app).post('/api/customers').send({ name: 'Old Co' });
    const cid = post.body.id;
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pc-rn-1', customerId: cid,
      pages: [{ id: 'pg-rn-1', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
    });
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pc-rn-2', customerId: cid, contractor: 'Stale Name',
      pages: [{ id: 'pg-rn-2', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
    });

    const put = await request(app).put(`/api/customers/${cid}`).send({ name: 'New Co Name', emails: {} });
    expect(put.status).toBe(200);

    expect((await request(app).get('/api/projects/pc-rn-1')).body.contractor).toBe('New Co Name');
    expect((await request(app).get('/api/projects/pc-rn-2')).body.contractor).toBe('New Co Name');
  });

  it('PUT without a name change leaves project.contractor alone', async () => {
    const post = await request(app).post('/api/customers').send({ name: 'Same Co' });
    const cid = post.body.id;
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pc-nc-1', customerId: cid, contractor: 'Hand-typed GC',
      pages: [{ id: 'pg-nc-1', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
    });

    // A phone edit is not a rename — contractor must survive it verbatim.
    const put = await request(app).put(`/api/customers/${cid}`).send({ name: 'Same Co', phone: '555-0100', emails: {} });
    expect(put.status).toBe(200);
    expect((await request(app).get('/api/projects/pc-nc-1')).body.contractor).toBe('Hand-typed GC');
  });

  it('PUT on the Unassigned bucket never stamps its name onto project.contractor', async () => {
    // The migration seeds customer-unassigned; its name is a placeholder, not a
    // company, and it must never reach a project (contractor feeds document PDFs).
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pc-un-1', customerId: 'customer-unassigned', contractor: '',
      pages: [{ id: 'pg-un-1', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
    });

    const put = await request(app).put('/api/customers/customer-unassigned').send({ name: 'Unassigned Renamed', emails: {} });
    expect(put.status).toBe(200);
    expect((await request(app).get('/api/projects/pc-un-1')).body.contractor).toBe('');
  });

  describe('GET /api/customers/summary and /:id/overview', () => {
    let userApp: express.Express;

    beforeEach(() => {
      // A second app wired with a non-admin 'user' role — proves money fields are gated.
      userApp = express();
      userApp.use(express.json());
      registerDataRoutes(userApp, {
        db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
        authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u2', role: 'user' }; next(); },
        requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
        verifyToken: () => null,
        broadcastChange: () => {},
      });
    });

    it('summary includes outstandingCents for admin, omits it for non-admin', async () => {
      const post = await request(app).post('/api/customers').send({ name: 'Billed Co' });
      const cid = post.body.id;
      await request(app).post('/api/projects').send({ ...PROJECT, id: 'pc-sum-1', customerId: cid });
      await request(app).post('/api/projects/pc-sum-1/invoices').send({ number: 'INV-1', status: 'sent', lines: [{ description: 'Work', qty: 1, unitPrice: 40 }] });

      const admin = await request(app).get('/api/customers/summary');
      expect(admin.status).toBe(200);
      const adminRow = admin.body.find((r: any) => r.id === cid);
      expect(adminRow.outstandingCents).toBe(4000);
      expect(adminRow.projectCounts).toEqual({ bidding: 1, inProgress: 0, archived: 0 });

      const nonAdmin = await request(userApp).get('/api/customers/summary');
      expect(nonAdmin.status).toBe(200);
      const nonAdminRow = nonAdmin.body.find((r: any) => r.id === cid);
      expect(nonAdminRow.outstandingCents).toBeUndefined();
    });

    it('overview includes billing/attention money items for admin, omits them for non-admin; 404 for unknown id', async () => {
      const post = await request(app).post('/api/customers').send({ name: 'Overview Co' });
      const cid = post.body.id;
      await request(app).post('/api/projects').send({ ...PROJECT, id: 'pc-ov-1', customerId: cid });
      await request(app).post('/api/projects/pc-ov-1/invoices').send({ number: 'INV-1', status: 'sent', lines: [{ description: 'Work', qty: 1, unitPrice: 40 }] });

      const admin = await request(app).get(`/api/customers/${cid}/overview`);
      expect(admin.status).toBe(200);
      expect(admin.body.customer.id).toBe(cid);
      expect(admin.body.billing.outstandingCents).toBe(4000);
      expect(admin.body.billing.ledger).toHaveLength(1);

      const nonAdmin = await request(userApp).get(`/api/customers/${cid}/overview`);
      expect(nonAdmin.status).toBe(200);
      expect(nonAdmin.body.billing).toBeUndefined();
      expect(nonAdmin.body.attention.some((a: any) => a.type === 'outstanding_invoice')).toBe(false);

      expect((await request(app).get('/api/customers/does-not-exist/overview')).status).toBe(404);
    });
  });
});
