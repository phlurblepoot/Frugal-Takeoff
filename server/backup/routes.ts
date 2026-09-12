// server/backup/routes.ts — admin backup routes + fresh-install restore routes
// (spec §Backup routes, §Setup mode and restore).
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { MailCrypto } from '../mail/crypto';
import type { EntityChangedEvent } from '../realtime/changeFeed';
import { LocalStore } from './store';
import { takeSnapshot, listRuns, isRunActive, BackupRunningError } from './snapshot';
import { streamSnapshotZip, unpackSnapshotZip } from './zip';
import { isFreshInstall, restoreSnapshot, RestoreRefusedError, DEFAULT_ADMIN_ID } from './restore';
import { readSchedule, writeSchedule, readKeep, writeKeep, readDrive, type DriveConnection } from './settings';
import type { BackupSource, BackupTarget } from './types';
import { isSnapshotId } from './types';

export interface BackupRouteDeps {
  db: Database.Database; dataDir: string; backupRoot: string; backupRootIsDefault: boolean;
  appVersion: string; env: NodeJS.ProcessEnv; publicUrl: string | null; jwtSecret: string;
  mailCrypto: MailCrypto;
  authenticateToken: express.RequestHandler; requireAdmin: express.RequestHandler;
  verifyToken: (token: string) => any;
  broadcastChange: (e: EntityChangedEvent) => void;
  closeDb: () => void; exit: (code: number) => void;
  fetch?: typeof fetch;
  scheduler?: { nextRunAt(): number | null };
  driveStore?: (conn: DriveConnection) => BackupTarget & BackupSource;
}

const TARGETS = ['local', 'drive'] as const;
type Target = typeof TARGETS[number];
const isTarget = (v: unknown): v is Target => typeof v === 'string' && (TARGETS as readonly string[]).includes(v);

export function registerBackupRoutes(app: express.Express, deps: BackupRouteDeps): void {
  const { db, authenticateToken, requireAdmin } = deps;
  const local = new LocalStore(deps.backupRoot);
  const targetFor = (t: Target): (BackupTarget & BackupSource) | null => {
    if (t === 'local') return local;
    const conn = readDrive(db, deps.mailCrypto);
    if (!conn || !deps.driveStore) return null;
    return deps.driveStore(conn);
  };

  // Run in the background; the response is the run id, progress arrives via
  // the backupRun change-feed event and GET /runs.
  const startRun = (t: Target, trigger: 'manual' | 'schedule'): Promise<string> => {
    const target = targetFor(t);
    if (!target) throw new Error(t === 'drive' ? 'Google Drive is not connected' : 'no target');
    if (isRunActive(db, t)) throw new BackupRunningError();
    const keep = readKeep(db)[t];
    const p = takeSnapshot(db, deps.dataDir, target, { trigger, keep, appVersion: deps.appVersion, env: deps.env });
    p.then(r => deps.broadcastChange({ type: 'backupRun', id: r.runId, action: 'updated' } as EntityChangedEvent))
     .catch(() => deps.broadcastChange({ type: 'backupRun', id: t, action: 'updated' } as EntityChangedEvent));
    // The run id is minted inside takeSnapshot; read it back from the newest running row.
    return new Promise((resolve) => setImmediate(() => {
      const row = db.prepare(`SELECT id FROM backup_runs WHERE target = ? ORDER BY startedAt DESC LIMIT 1`).get(t) as { id: string } | undefined;
      resolve(row?.id ?? '');
    }));
  };

  app.get('/api/backup/status', authenticateToken, requireAdmin, async (_req, res) => {
    const lastRun = (t: Target) => db.prepare(`SELECT * FROM backup_runs WHERE target = ? AND status != 'running' ORDER BY startedAt DESC LIMIT 1`).get(t) ?? null;
    const running = db.prepare(`SELECT * FROM backup_runs WHERE status = 'running' ORDER BY startedAt DESC LIMIT 1`).get() ?? null;
    const snaps = await local.listSnapshots();
    const objects = await local.listObjects();
    const drive = readDrive(db, deps.mailCrypto);
    res.json({
      root: deps.backupRoot, rootIsDefault: deps.backupRootIsDefault,
      lastRun: { local: lastRun('local'), drive: lastRun('drive') }, running,
      totals: { snapshots: snaps.length, objects: objects.size, bytes: snaps[0]?.counts.bytes ?? 0 },
      nextRunAt: deps.scheduler?.nextRunAt() ?? null,
      schedule: readSchedule(db), keep: readKeep(db),
      drive: drive ? { connected: true, email: drive.email, needsReconnect: !!drive.needsReconnect } : { connected: false, configurable: !!deps.env.GOOGLE_OAUTH_CLIENT_ID },
    });
  });

  app.post('/api/backup/run', authenticateToken, requireAdmin, async (req, res) => {
    const t = req.body?.target;
    if (!isTarget(t)) return res.status(400).json({ error: 'target must be local or drive' });
    try { res.status(202).json({ runId: await startRun(t, 'manual') }); }
    catch (e) {
      if (e instanceof BackupRunningError) return res.status(409).json({ error: e.message, code: 'backup_running' });
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get('/api/backup/runs', authenticateToken, requireAdmin, (_req, res) => {
    res.json(listRuns(db).map(r => ({ ...r, warnings: JSON.parse(r.warningsJson || '[]') })));
  });

  app.get('/api/backup/snapshots', authenticateToken, requireAdmin, async (req, res) => {
    const t = req.query.target;
    if (!isTarget(t)) return res.status(400).json({ error: 'target must be local or drive' });
    const target = targetFor(t);
    if (!target) return res.json([]);
    try { res.json(await target.listSnapshots()); }
    catch (e) { console.error('[backup] list snapshots failed', e); res.status(502).json({ error: (e as Error).message }); }
  });

  app.get('/api/backup/snapshots/:id/download', authenticateToken, requireAdmin, async (req, res) => {
    if (!isSnapshotId(req.params.id)) return res.status(400).json({ error: 'bad snapshot id' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="frugal-takeoff-backup-${req.params.id}.zip"`);
    try { await streamSnapshotZip(local, req.params.id, res); }
    catch (e) { console.error('[backup] download failed', e); if (!res.headersSent) res.status(404).json({ error: 'Snapshot not found' }); else res.destroy(); }
  });

  app.put('/api/backup/settings', authenticateToken, requireAdmin, (req, res) => {
    if (req.body?.schedule) writeSchedule(db, req.body.schedule);
    if (req.body?.keep) writeKeep(db, req.body.keep);
    res.json({ schedule: readSchedule(db), keep: readKeep(db) });
  });

  // Exposed for the scheduler (Task 9) and tests.
  (app as any).__backupStartRun = startRun;

  // ── Fresh-install restore (spec §Setup mode and restore) ─────────────────
  app.get('/api/setup/state', (_req, res) => res.json({ fresh: isFreshInstall(db) }));

  // Fresh + signed in as the bootstrap admin: the only identity a fresh
  // install can have, and it stops a LAN stranger restoring over an empty box.
  const setupOnly: express.RequestHandler[] = [authenticateToken, (req, res, next) => {
    if ((req as any).user?.id !== DEFAULT_ADMIN_ID) return res.status(403).json({ error: 'Only the initial admin account can restore' });
    if (!isFreshInstall(db)) return res.status(409).json({ error: 'This server already has data — restore is only offered on a fresh install', code: 'not_fresh' });
    next();
  }];

  const uploadsDir = path.join(os.tmpdir(), 'ft-restore-uploads');
  const uploadStore = (uploadId: string): LocalStore => {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new RestoreRefusedError('bad upload id');
    return new LocalStore(path.join(uploadsDir, uploadId));
  };
  // Setup-mode Drive grant lives here in memory only (Task 8 fills it).
  const setupDrive: { conn: DriveConnection | null } = { conn: null };

  app.get('/api/setup/restore/sources', ...setupOnly, async (_req, res) => {
    res.json({
      root: deps.backupRoot, local: await local.listSnapshots(),
      drive: { configurable: !!deps.env.GOOGLE_OAUTH_CLIENT_ID && !!deps.publicUrl, connected: !!setupDrive.conn, email: setupDrive.conn?.email ?? null },
    });
  });

  // Raw body streamed to disk (server.ts skips the JSON parser for this path).
  app.post('/api/setup/restore/upload', ...setupOnly, async (req, res) => {
    const uploadId = uuidv4();
    const dir = path.join(uploadsDir, uploadId); fs.mkdirSync(dir, { recursive: true });
    const zipPath = path.join(dir, 'upload.zip');
    try {
      await pipeline(req, fs.createWriteStream(zipPath));
      const { snapshotId } = await unpackSnapshotZip(zipPath, dir);
      fs.unlinkSync(zipPath);
      const summary = (await uploadStore(uploadId).listSnapshots())[0];
      res.json({ uploadId, snapshotId, summary });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      res.status(400).json({ error: `That file is not a snapshot zip: ${(e as Error).message}` });
    }
  });

  app.post('/api/setup/restore', ...setupOnly, async (req, res) => {
    const { source, snapshotId, uploadId } = req.body ?? {};
    if (!isSnapshotId(String(snapshotId))) return res.status(400).json({ error: 'bad snapshot id' });
    let src: BackupSource;
    try {
      if (source === 'local') src = local;
      else if (source === 'upload') src = uploadStore(String(uploadId));
      else if (source === 'drive') { if (!setupDrive.conn || !deps.driveStore) return res.status(400).json({ error: 'Google Drive is not connected' }); src = deps.driveStore(setupDrive.conn); }
      else return res.status(400).json({ error: 'source must be local, upload or drive' });
      const r = await restoreSnapshot(src, snapshotId, { dataDir: deps.dataDir, closeDb: deps.closeDb, exit: deps.exit });
      res.json({ restarting: true, files: r.files, bytes: r.bytes });
      // After the response is flushed: swap the db and exit for the restart.
      res.on('finish', () => setImmediate(() => { try { r.finish(); } catch (e) { console.error('[backup] restore finish failed', e); } }));
    } catch (e) {
      if (e instanceof RestoreRefusedError) return res.status(400).json({ error: e.message });
      console.error('[backup] restore failed', e);
      res.status(500).json({ error: 'Restore failed — the server was left as it was. See the server log.' });
    }
  });
  (app as any).__setupDrive = setupDrive; // Task 8 attaches the setup-mode Drive grant here
}
