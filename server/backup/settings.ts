// server/backup/settings.ts — typed access to the private backup.* settings keys.
import type Database from 'better-sqlite3';
import type { MailCrypto } from '../mail/crypto';

export interface BackupSchedule { enabled: boolean; hour: number; minute: number }
export interface DriveConnection { refreshToken: string; email: string; folderId: string; objectsFolderId: string; snapshotsFolderId: string; needsReconnect?: boolean }

const get = (db: Database.Database, key: string): string | null =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const set = (db: Database.Database, key: string, value: string | null): void => {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
};
const clamp = (n: unknown, lo: number, hi: number, dflt: number): number => {
  const v = Math.floor(Number(n)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

export function readSchedule(db: Database.Database): BackupSchedule {
  try { const s = JSON.parse(get(db, 'backup.schedule') ?? '') ; return { enabled: !!s.enabled, hour: clamp(s.hour, 0, 23, 2), minute: clamp(s.minute, 0, 59, 0) }; }
  catch { return { enabled: false, hour: 2, minute: 0 }; }
}
export function writeSchedule(db: Database.Database, s: BackupSchedule): void {
  set(db, 'backup.schedule', JSON.stringify({ enabled: !!s.enabled, hour: clamp(s.hour, 0, 23, 2), minute: clamp(s.minute, 0, 59, 0) }));
}
export function readKeep(db: Database.Database): { local: number; drive: number } {
  const local = get(db, 'backup.keepLocal');
  const drive = get(db, 'backup.keepDrive');
  return {
    local: local === null ? 14 : clamp(local, 1, 365, 14),
    drive: drive === null ? 14 : clamp(drive, 1, 365, 14),
  };
}
export function writeKeep(db: Database.Database, k: { local?: unknown; drive?: unknown }): void {
  const cur = readKeep(db);
  set(db, 'backup.keepLocal', String(clamp(k.local ?? cur.local, 1, 365, 14)));
  set(db, 'backup.keepDrive', String(clamp(k.drive ?? cur.drive, 1, 365, 14)));
}
export function readDrive(db: Database.Database, crypto: MailCrypto): DriveConnection | null {
  const sealed = get(db, 'backup.drive'); if (!sealed) return null;
  try { return crypto.open<DriveConnection>(sealed); } catch { return null; }
}
export function writeDrive(db: Database.Database, crypto: MailCrypto, c: DriveConnection | null): void {
  set(db, 'backup.drive', c ? crypto.seal(c) : null);
}
