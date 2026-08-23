// server/routes.changefeed.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { registerDataRoutes } from './routes';
import { createChangeFeed, ENTITY_CHANGED, type EntityChangedEvent } from './realtime/changeFeed';
import { startRealtimeServer, connectClient, makeToken, waitFor } from './realtime/testHarness';

describe('route mutations broadcast entity-changed', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>>;
  let app: express.Express;
  let db: ReturnType<typeof openDb>;
  let dataDir: string;

  beforeEach(async () => {
    srv = await startRealtimeServer();
    db = openDb(':memory:');
    dataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cf-test-'));
    runMigrations(db, dataDir, migrations, { dbFile: ':memory:', vacuum: false });
    app = express();
    app.use(express.json());
    registerDataRoutes(app, {
      db, dataDir, dbFile: ':memory:',
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', username: 'test', role: 'admin' }; next(); },
      requireAdmin: (_req: any, _res: any, next: any) => next(),
      verifyToken: () => ({ id: 'u1', username: 'test', role: 'admin' }),
      broadcastChange: createChangeFeed(srv.io),
    });
  });
  afterEach(async () => { await srv.close(); db.close(); fsSync.rmSync(dataDir, { recursive: true, force: true }); });

  async function connectedClient() {
    const c = connectClient(srv.port, makeToken());
    await waitFor(c, 'sessions-snapshot');
    return c;
  }

  it('POST /api/projects/:id/issues broadcasts issue created with projectId and session meta', async () => {
    await request(app).post('/api/projects').send({ id: 'p1', name: 'P1', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p1/issues')
      .set('X-Session-Id', 'tab-A').send({ title: 'crack' }).expect(200);
    const e = await evt;
    expect(e.type).toBe('issue');
    expect(e.id).toBe(res.body.id);
    expect(e.projectId).toBe('p1');
    expect(e.action).toBe('created');
    expect(e.bySessionId).toBe('tab-A');
    expect(e.byUserId).toBe('u1');
    c.close();
  });

  it('DELETE /api/issues/:id captures projectId BEFORE deleting', async () => {
    await request(app).post('/api/projects').send({ id: 'p1', name: 'P1', pages: [], takeoffs: [] }).expect(200);
    const created = await request(app).post('/api/projects/p1/issues').send({ title: 'x' }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).delete(`/api/issues/${created.body.id}`).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'issue', id: created.body.id, projectId: 'p1', action: 'deleted' });
    c.close();
  });

  it('PUT /api/projects/:id broadcasts project updated with the new version', async () => {
    await request(app).post('/api/projects').send({ id: 'p2', name: 'P2', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).put('/api/projects/p2').send({ id: 'p2', name: 'P2 renamed', pages: [], takeoffs: [], version: 1 }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'project', id: 'p2', action: 'updated' });
    expect(typeof e.version).toBe('number');
    c.close();
  });

  it('POST /api/projects broadcasts project created', async () => {
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).post('/api/projects').send({ id: 'p3', name: 'P3', pages: [], takeoffs: [] }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'project', id: 'p3', projectId: 'p3', action: 'created', version: 1 });
    c.close();
  });

  it('DELETE /api/projects/:id broadcasts project deleted', async () => {
    await request(app).post('/api/projects').send({ id: 'p4', name: 'P4', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).delete('/api/projects/p4').expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'project', id: 'p4', action: 'deleted' });
    c.close();
  });

  it('PATCH /api/projects/:id broadcasts project updated', async () => {
    const created = await request(app).post('/api/projects').send({ id: 'p5', name: 'P5', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).patch('/api/projects/p5').send({ version: created.body.version, status: 'in_progress' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'project', id: 'p5', action: 'updated' });
    c.close();
  });

  it('POST /api/projects/:id/rfis broadcasts rfi created', async () => {
    await request(app).post('/api/projects').send({ id: 'p6', name: 'P6', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p6/rfis').send({ title: 'question' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'rfi', id: res.body.id, projectId: 'p6', action: 'created' });
    c.close();
  });

  it('POST /api/projects/:id/punch broadcasts punch created', async () => {
    await request(app).post('/api/projects').send({ id: 'p7', name: 'P7', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p7/punch').send({ description: 'fix trim' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'punch', id: res.body.id, projectId: 'p7', action: 'created' });
    c.close();
  });

  it('PATCH /api/punch/:id (done) broadcasts punch updated', async () => {
    await request(app).post('/api/projects').send({ id: 'p7b', name: 'P7b', pages: [], takeoffs: [] }).expect(200);
    const created = await request(app).post('/api/projects/p7b/punch').send({ description: 'fix trim' }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).patch(`/api/punch/${created.body.id}`).send({ done: true }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'punch', id: created.body.id, projectId: 'p7b', action: 'updated' });
    c.close();
  });

  it('POST /api/projects/:id/invoices broadcasts invoice created (admin)', async () => {
    await request(app).post('/api/projects').send({ id: 'p8', name: 'P8', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p8/invoices').send({ number: 'INV-1', lines: [] }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'invoice', id: res.body.id, projectId: 'p8', action: 'created' });
    c.close();
  });

  it('POST /api/projects/:id/payments broadcasts payment created against an invoice', async () => {
    await request(app).post('/api/projects').send({ id: 'p9', name: 'P9', pages: [], takeoffs: [] }).expect(200);
    const inv = await request(app).post('/api/projects/p9/invoices').send({ number: 'INV-9', lines: [{ description: 'work', qty: 1, unitPrice: 100 }] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p9/payments')
      .send({ targetType: 'invoice', targetId: inv.body.id, amount: 50 }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'payment', id: res.body.id, projectId: 'p9', action: 'created' });
    c.close();
  });

  it('DELETE /api/payments/:id resolves projectId via the invoice target before deleting', async () => {
    await request(app).post('/api/projects').send({ id: 'p10', name: 'P10', pages: [], takeoffs: [] }).expect(200);
    const inv = await request(app).post('/api/projects/p10/invoices').send({ number: 'INV-10', lines: [{ description: 'work', qty: 1, unitPrice: 100 }] }).expect(200);
    const pay = await request(app).post('/api/projects/p10/payments')
      .send({ targetType: 'invoice', targetId: inv.body.id, amount: 25 }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).delete(`/api/payments/${pay.body.id}`).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'payment', id: pay.body.id, projectId: 'p10', action: 'deleted' });
    c.close();
  });

  it('POST /api/projects/:id/change-orders broadcasts changeOrder created', async () => {
    await request(app).post('/api/projects').send({ id: 'p11', name: 'P11', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p11/change-orders').send({ number: 'CO-1', title: 'extra work' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'changeOrder', id: res.body.id, projectId: 'p11', action: 'created' });
    c.close();
  });

  it('POST /api/projects/:id/aia/sov broadcasts aiaSov created', async () => {
    await request(app).post('/api/projects').send({ id: 'p12', name: 'P12', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p12/aia/sov').send({ description: 'sitework', scheduledValueCents: 10000 }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'aiaSov', id: res.body.id, projectId: 'p12', action: 'created' });
    c.close();
  });

  it('POST /api/projects/:id/aia/pay-apps broadcasts aiaPayApp created', async () => {
    await request(app).post('/api/projects').send({ id: 'p13', name: 'P13', pages: [], takeoffs: [] }).expect(200);
    await request(app).post('/api/projects/p13/aia/sov').send({ description: 'sitework', scheduledValueCents: 10000 }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p13/aia/pay-apps').send({}).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'aiaPayApp', id: res.body.id, projectId: 'p13', action: 'created' });
    c.close();
  });
});
