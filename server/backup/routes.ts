// server/backup/routes.ts — admin backup routes + fresh-install restore routes
// (spec §Backup routes, §Setup mode and restore).
import express from 'express';
import type Database from 'better-sqlite3';
import type { MailCrypto } from '../mail/crypto';
import type { EntityChangedEvent } from '../realtime/changeFeed';
import { LocalStore } from './store';
import { takeSnapshot, listRuns, isRunActive, BackupRunningError } from './snapshot';
import { streamSnapshotZip } from './zip';
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
}
