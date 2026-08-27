// server/routes.dailyReports.test.ts
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
import { createProject } from './projectStore';
import { registerDataRoutes } from './routes';
import type { EntityChangedEvent } from './realtime/changeFeed';

let db: Database.Database;
let dir: string;
let app: express.Express;
let broadcasts: EntityChangedEvent[];

const PROJECT = {
  id: 'p1', name: 'Test Project', createdAt: 1, contractor: 'GC Co',
  pages: [{ id: 'pg1', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
  takeoffs: [],
};

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-rt-daily-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  broadcasts = [];
  app = express();
  app.use(express.json({ limit: '50mb' }));
  registerDataRoutes(app, {
    db,
    dataDir: dir,
    dbFile: path.join(dir, 'app.db'),
    authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role: 'admin' }; next(); },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    verifyToken: (token: string) => (token === 'good-token' ? { id: 'u1', role: 'admin' } : null),
    broadcastChange: (ev) => { broadcasts.push(ev); },
  });
  createProject(db, PROJECT);
});

describe('daily reports routes', () => {
  it('GET list is empty, then returns created rows date DESC with photoCount', async () => {
    const empty = await request(app).get('/api/projects/p1/daily-reports');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    await request(app).post('/api/projects/p1/daily-reports')
      .send({ reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' })
      .expect(200);
    await request(app).post('/api/projects/p1/daily-reports')
      .send({ reportDate: '2026-08-22', jobName: 'Job B', contractorName: 'GC Co' })
      .expect(200);

    const list = await request(app).get('/api/projects/p1/daily-reports');
    expect(list.status).toBe(200);
    expect(list.body.map((r: any) => r.reportDate)).toEqual(['2026-08-22', '2026-08-20']);
    expect(list.body[0].photoCount).toBe(0);
  });

  it('POST creates a report and broadcasts created with version 1', async () => {
    const res = await request(app).post('/api/projects/p1/daily-reports')
      .send({ reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'dailyReport', action: 'created', projectId: 'p1', id: res.body.id, version: 1,
    }));
  });

  it('POST with duplicate date on same project returns 409 date_taken', async () => {
    const first = await request(app).post('/api/projects/p1/daily-reports')
      .send({ reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    const dup = await request(app).post('/api/projects/p1/daily-reports')
      .send({ reportDate: '2026-08-20', jobName: 'Job A2', contractorName: 'GC Co' });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: 'date_taken', existingId: first.body.id });
  });

  it('GET /api/daily-reports/:id returns full row incl photos; 404 for missing', async () => {
    const created = await request(app).post('/api/projects/p1/daily-reports')
      .send({ reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    const get = await request(app).get(`/api/daily-reports/${created.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body.reportDate).toBe('2026-08-20');
    expect(get.body.photos).toEqual([]);

    const missing = await request(app).get('/api/daily-reports/nope');
    expect(missing.status).toBe(404);
  });

  it('PUT happy path bumps version and broadcasts updated with new version', async () => {
    const created = await request(app).post('/api/projects/p1/daily-reports')
      .send({ reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    const put = await request(app).put(`/api/daily-reports/${created.body.id}`)
      .send({ version: 1, jobName: 'Job A Updated' });
    expect(put.status).toBe(200);
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'dailyReport', action: 'updated', projectId: 'p1', id: created.body.id, version: 2,
    }));
  });

  it('PUT with stale version returns 409 version_conflict', async () => {
    const created = await request(app).post('/api/projects/p1/daily-reports')
      .send({ reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    await request(app).put(`/api/daily-reports/${created.body.id}`).send({ version: 1, jobName: 'v2' });
    const stale = await request(app).put(`/api/daily-reports/${created.body.id}`).send({ version: 1, jobName: 'stale' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('PUT onto a taken date returns 409 date_taken', async () => {
    await request(app).post('/api/projects/p1/daily-reports')
      .send({ reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    const second = await request(app).post('/api/projects/p1/daily-reports')
      .send({ reportDate: '2026-08-21', jobName: 'Job B', contractorName: 'GC Co' });
    const put = await request(app).put(`/api/daily-reports/${second.body.id}`)
      .send({ version: 1, reportDate: '2026-08-20' });
    expect(put.status).toBe(409);
    expect(put.body.error).toBe('date_taken');
    expect(put.body.existingId).toBeTruthy();
  });

  it('DELETE removes the report and broadcasts deleted with no version', async () => {
    const created = await request(app).post('/api/projects/p1/daily-reports')
      .send({ reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    const del = await request(app).delete(`/api/daily-reports/${created.body.id}`);
    expect(del.status).toBe(200);
    const broadcast = broadcasts.find(b => b.action === 'deleted');
    expect(broadcast).toEqual(expect.objectContaining({ type: 'dailyReport', id: created.body.id, projectId: 'p1', action: 'deleted' }));
    expect(broadcast).not.toHaveProperty('version');
    expect((await request(app).get(`/api/daily-reports/${created.body.id}`)).status).toBe(404);
  });

  it('photo add/remove broadcast updated with no version field', async () => {
    const created = await request(app).post('/api/projects/p1/daily-reports')
      .send({ reportDate: '2026-08-20', jobName: 'Job A', contractorName: 'GC Co' });
    const add = await request(app).post(`/api/daily-reports/${created.body.id}/photos`).send({ fileId: 'file1' });
    expect(add.status).toBe(200);
    const addBroadcast = broadcasts.find(b => b.action === 'updated' && !('version' in b));
    expect(addBroadcast).toEqual(expect.objectContaining({ type: 'dailyReport', id: created.body.id, projectId: 'p1', action: 'updated' }));
    expect(addBroadcast).not.toHaveProperty('version');

    const getAfterAdd = await request(app).get(`/api/daily-reports/${created.body.id}`);
    expect(getAfterAdd.body.photos).toHaveLength(1);

    broadcasts.length = 0;
    const remove = await request(app).delete(`/api/daily-reports/${created.body.id}/photos/file1`);
    expect(remove.status).toBe(200);
    const removeBroadcast = broadcasts.find(b => b.action === 'updated');
    expect(removeBroadcast).toEqual(expect.objectContaining({ type: 'dailyReport', id: created.body.id, projectId: 'p1', action: 'updated' }));
    expect(removeBroadcast).not.toHaveProperty('version');

    const getAfterRemove = await request(app).get(`/api/daily-reports/${created.body.id}`);
    expect(getAfterRemove.body.photos).toHaveLength(0);
  });
});

describe('GET /api/projects/:id/daily-weather', () => {
  it('returns 400 no_address when the project has no address', async () => {
    const res = await request(app).get('/api/projects/p1/daily-weather').query({ date: '2026-08-20' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'no_address' });
  });

  it('returns 400 bad_date for a missing or malformed date', async () => {
    const missing = await request(app).get('/api/projects/p1/daily-weather');
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: 'bad_date' });

    const malformed = await request(app).get('/api/projects/p1/daily-weather').query({ date: 'not-a-date' });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'bad_date' });
  });
});
