// server/backup/snapshot.ts — one backup run (spec §Taking a snapshot).
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { pathFor } from '../fileStore';
import { migrations } from '../migrationList';
import type { BackupTarget, Manifest, ManifestFile } from './types';
import { snapshotIdNow } from './types';
import { sha256OfStream } from './store';

export class BackupRunningError extends Error { constructor() { super('A backup is already running for this target'); } }

export interface TakeSnapshotOpts {
  trigger: 'manual' | 'schedule';
  keep: number;
  appVersion: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}
export interface SnapshotResult { runId: string; snapshotId: string; objectsAdded: number; bytesWritten: number; warnings: string[] }
export interface BackupRunRow {
  id: string; target: 'local' | 'drive'; trigger: 'manual' | 'schedule'; startedAt: number; finishedAt: number | null;
  status: 'running' | 'ok' | 'error'; snapshotId: string | null; objectsAdded: number; bytesWritten: number;
  warningsJson: string; error: string | null;
}

export const latestSchemaVersion = (): number => migrations[migrations.length - 1].version;

export function isRunActive(db: Database.Database, target: 'local' | 'drive'): boolean {
  return !!db.prepare(`SELECT 1 FROM backup_runs WHERE target = ? AND status = 'running'`).get(target);
}

export function listRuns(db: Database.Database, limit = 50): BackupRunRow[] {
  return db.prepare('SELECT * FROM backup_runs ORDER BY startedAt DESC LIMIT ?').all(limit) as BackupRunRow[];
}

const fileSha = (p: string): Promise<{ sha256: string; size: number }> => sha256OfStream(fs.createReadStream(p));

export async function takeSnapshot(db: Database.Database, dataDir: string, target: BackupTarget, opts: TakeSnapshotOpts): Promise<SnapshotResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  // Claim the target atomically: the INSERT and the running-check are one statement.
  const runId = uuidv4();
  const claimed = db.prepare(`
    INSERT INTO backup_runs (id, target, trigger, startedAt, status)
    SELECT ?, ?, ?, ?, 'running' WHERE NOT EXISTS (SELECT 1 FROM backup_runs WHERE target = ? AND status = 'running')
  `).run(runId, target.kind, opts.trigger, startedAt.getTime(), target.kind);
  if (claimed.changes === 0) throw new BackupRunningError();

  const snapshotId = snapshotIdNow(startedAt);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-snap-'));
  const warnings: string[] = [];
  let objectsAdded = 0; let bytesWritten = 0;
  try {
    // 1. consistent database copy (online backup API)
    const dbCopy = path.join(tmpDir, 'app.db');
    await db.backup(dbCopy);
    const dbInfo = await fileSha(dbCopy);

    // 2. objects the target lacks
    const have = await target.listObjects();
    const rows = db.prepare('SELECT id, sha256, size FROM files').all() as ManifestFile[];
    const files: ManifestFile[] = [];
    for (const row of rows) {
      const p = pathFor(dataDir, row.id);
      if (!fs.existsSync(p)) { warnings.push(`file ${row.id} skipped: not on disk`); continue; }
      if (!have.has(row.sha256)) {
        let actual = await fileSha(p);
        if (actual.sha256 !== row.sha256) actual = await fileSha(p); // one retry: a regenerate may be mid-write
        if (actual.sha256 !== row.sha256) { warnings.push(`file ${row.id} skipped: on-disk hash did not match the row after retry`); continue; }
        await target.putObject(row.sha256, () => fs.createReadStream(p), actual.size);
        have.add(row.sha256);
        objectsAdded++; bytesWritten += actual.size;
      }
      files.push({ id: row.id, sha256: row.sha256, size: row.size });
    }

    // 3. mail key
    const keyPath = path.join(dataDir, 'mail.key');
    const mailKey: Manifest['mailKey'] = env.MAIL_SECRET_KEY
      ? { source: 'env' }
      : { sha256: crypto.createHash('sha256').update(fs.readFileSync(keyPath)).digest('hex') };

    const manifest: Manifest = {
      format: 1, createdAt: startedAt.getTime(), appVersion: opts.appVersion, schemaVersion: latestSchemaVersion(),
      db: dbInfo, mailKey, files,
      counts: { files: files.length, bytes: files.reduce((a, f) => a + f.size, 0) }, warnings,
    };
    await target.writeSnapshot(snapshotId, { dbPath: dbCopy, mailKeyPath: env.MAIL_SECRET_KEY ? null : keyPath, manifest });
    bytesWritten += dbInfo.size;

    // 4. retention
    await pruneTarget(target, opts.keep, snapshotId);

    db.prepare(`UPDATE backup_runs SET finishedAt = ?, status = 'ok', snapshotId = ?, objectsAdded = ?, bytesWritten = ?, warningsJson = ? WHERE id = ?`)
      .run(Date.now(), snapshotId, objectsAdded, bytesWritten, JSON.stringify(warnings), runId);
    if (warnings.length) console.warn(`[backup] ${target.kind} snapshot ${snapshotId} finished with ${warnings.length} warning(s)`);
    return { runId, snapshotId, objectsAdded, bytesWritten, warnings };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare(`UPDATE backup_runs SET finishedAt = ?, status = 'error', error = ?, warningsJson = ? WHERE id = ?`)
      .run(Date.now(), msg, JSON.stringify(warnings), runId);
    console.error(`[backup] ${target.kind} run failed:`, msg);
    throw e;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function pruneTarget(target: BackupTarget, keep: number, currentSnapshotId?: string): Promise<{ snapshotsDeleted: number; objectsDeleted: number }> {
  const snaps = await target.listSnapshots(); // newest first
  const doomed = snaps.slice(Math.max(1, keep));
  for (const s of doomed) await target.deleteSnapshot(s.id);
  // A run that died before writing manifest.json leaves a folder holding a
  // whole app.db that no listing will ever show. Only sweep the ones older
  // than the run that just finished — anything newer is not ours to judge,
  // and the current run's own folder must never be touched.
  if (currentSnapshotId) {
    for (const id of (await target.listIncompleteSnapshots?.()) ?? []) {
      if (id < currentSnapshotId) await target.deleteSnapshot(id);
    }
  }
  const kept = snaps.slice(0, Math.max(1, keep));
  const referenced = new Set<string>();
  for (const s of kept) for (const f of (await target.readManifest(s.id)).files) referenced.add(f.sha256);
  let objectsDeleted = 0;
  for (const sha of await target.listObjects()) {
    if (!referenced.has(sha)) { await target.deleteObject(sha); objectsDeleted++; }
  }
  return { snapshotsDeleted: doomed.length, objectsDeleted };
}
