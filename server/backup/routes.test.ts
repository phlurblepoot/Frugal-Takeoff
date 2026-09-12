import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { putBuffer } from '../files';
import { MailCrypto } from '../mail/crypto';
import { registerBackupRoutes, type BackupRouteDeps } from './routes';
import { unpackSnapshotZip } from './zip';
import { LocalStore } from './store';

let db: Database.Database; let dataDir: string; let root: string; let app: express.Express; let events: any[];
const crypto = new MailCrypto(Buffer.alloc(32, 9));

const mkApp = (over: Partial<BackupRouteDeps> = {}, user: any = { id: 'u1', role: 'admin' }) => {
  const a = express(); a.use(express.json());
  registerBackupRoutes(a, {
    db, dataDir, backupRoot: root, backupRootIsDefault: false, appVersion: '3.2.0', env: {}, publicUrl: null, jwtSecret: 's',
    mailCrypto: crypto,
    authenticateToken: (req: any, _res: any, next: any) => { req.user = user; next(); },
    requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
    verifyToken: () => user, broadcastChange: e => events.push(e), closeDb: () => {}, exit: () => {}, ...over,
  });
  return a;
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-d-')); root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-r-'));
  db = openDb(path.join(dataDir, 'app.db')); runMigrations(db, dataDir, migrations);
  fs.writeFileSync(path.join(dataDir, 'mail.key'), 'k'.repeat(64) + '\n');
  db.prepare("INSERT INTO users (id, username, password, role) VALUES ('admin-id-123', 'admin', 'x', 'admin')").run();
  events = []; app = mkApp();
});

describe('backup admin routes', () => {
  it('status reports the root, defaults, no runs yet, and no drive', async () => {
    const r = await request(app).get('/api/backup/status');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ root: root, rootIsDefault: false, drive: { connected: false }, schedule: { enabled: false, hour: 2, minute: 0 }, keep: { local: 14, drive: 14 }, running: null });
    expect(r.body.lastRun).toEqual({ local: null, drive: null });
  });

  it('run → 202 then the run shows ok, a snapshot lists, and a backupRun event was broadcast', async () => {
    putBuffer(db, dataDir, 'f1', Buffer.from('x'), 'text/plain', { kind: 'document', name: 'x' });
    const r = await request(app).post('/api/backup/run').send({ target: 'local' });
    expect(r.status).toBe(202); expect(r.body.runId).toBeTruthy();
    await new Promise(res => setTimeout(res, 300));
    const runs = await request(app).get('/api/backup/runs');
    expect(runs.body[0]).toMatchObject({ status: 'ok', target: 'local', objectsAdded: 1 });
    const snaps = await request(app).get('/api/backup/snapshots?target=local');
    expect(snaps.body.length).toBe(1);
    expect(events.some(e => e.type === 'backupRun')).toBe(true);
  });

  it('a second run while one is running → 409 backup_running', async () => {
    db.prepare(`INSERT INTO backup_runs (id, target, trigger, startedAt, status) VALUES ('x', 'local', 'manual', ?, 'running')`).run(Date.now());
    const r = await request(app).post('/api/backup/run').send({ target: 'local' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('backup_running');
  });

  it('download streams a zip that unpacks to the same snapshot', async () => {
    putBuffer(db, dataDir, 'f1', Buffer.from('hello'), 'text/plain', { kind: 'document', name: 'x' });
    await request(app).post('/api/backup/run').send({ target: 'local' });
    await new Promise(res => setTimeout(res, 300));
    const id = (await request(app).get('/api/backup/snapshots?target=local')).body[0].id;
    const r = await request(app).get(`/api/backup/snapshots/${id}/download`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200); expect(r.headers['content-type']).toMatch(/zip/);
    const zipPath = path.join(root, 'dl.zip'); fs.writeFileSync(zipPath, r.body);
    const into = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-un-'));
    expect((await unpackSnapshotZip(zipPath, into)).snapshotId).toBe(id);
    expect((await new LocalStore(into).readManifest(id)).files.length).toBe(1);
  });

  it('settings round-trip with clamping; non-admin gets 403 everywhere', async () => {
    const r = await request(app).put('/api/backup/settings').send({ schedule: { enabled: true, hour: 23, minute: 30 }, keep: { local: 0, drive: 9999 } });
    expect(r.status).toBe(200);
    expect((await request(app).get('/api/backup/status')).body).toMatchObject({ schedule: { enabled: true, hour: 23, minute: 30 }, keep: { local: 1, drive: 365 } });
    const member = mkApp({}, { id: 'u2', role: 'user' });
    for (const [m, p] of [['get', '/api/backup/status'], ['post', '/api/backup/run'], ['get', '/api/backup/runs'], ['put', '/api/backup/settings']] as const) {
      expect((await (request(member) as any)[m](p).send({})).status).toBe(403);
    }
  });
});
