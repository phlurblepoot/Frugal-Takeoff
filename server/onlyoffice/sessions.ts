// server/onlyoffice/sessions.ts — one row per file while an ONLYOFFICE
// editing session is open (table editor_sessions, migration 37).
//
// Two jobs:
//   * Everyone who opens a file during a session must get the SAME document
//     key, or ONLYOFFICE starts a second, separate session on the same file and
//     the two overwrite each other. The key is pinned here, because the file's
//     own version (which normally drives the key) moves when the session saves.
//   * The one-version-per-session rule (decision 2026-09-25): a session's first
//     save archives the pre-session bytes as a version; its later saves
//     overwrite in place. savedVersionNumber/savedSha256 record exactly what
//     this session last wrote, so a save only overwrites if nothing else has
//     changed the file since (a regenerate, an upload, a restore).
import type Database from 'better-sqlite3';

export interface EditorSession {
  fileId: string;
  docKey: string;
  /** The file's live version when the session started. */
  baseVersionNumber: number;
  /** The live version this session produced with its first save; null until then. */
  savedVersionNumber: number | null;
  /** The sha256 of the bytes this session last wrote. */
  savedSha256: string | null;
  startedAt: number;
  lastSavedAt: number | null;
  lastSavedBy: string | null;
}

export class EditorSessions {
  constructor(private readonly db: Database.Database) {}

  get(fileId: string): EditorSession | null {
    return (this.db.prepare('SELECT * FROM editor_sessions WHERE fileId = ?').get(fileId) as EditorSession | undefined) ?? null;
  }

  /** Starts a session unless one is already open, and returns whichever
   *  session is now open (two people opening at once both get the first). */
  start(fileId: string, docKey: string, baseVersionNumber: number): EditorSession {
    this.db.prepare(`INSERT OR IGNORE INTO editor_sessions (fileId, docKey, baseVersionNumber, startedAt) VALUES (?, ?, ?, ?)`)
      .run(fileId, docKey, baseVersionNumber, Date.now());
    return this.get(fileId)!;
  }

  recordSave(fileId: string, docKey: string, saved: { versionNumber: number; sha256: string; by: string | null }): void {
    this.db.prepare(`UPDATE editor_sessions SET savedVersionNumber = ?, savedSha256 = ?, lastSavedAt = ?, lastSavedBy = ?
                     WHERE fileId = ? AND docKey = ?`)
      .run(saved.versionNumber, saved.sha256, Date.now(), saved.by, fileId, docKey);
  }

  /** Ends the session with this key only: a late message from an old session
   *  must never close a newer one. */
  end(fileId: string, docKey: string): void {
    this.db.prepare('DELETE FROM editor_sessions WHERE fileId = ? AND docKey = ?').run(fileId, docKey);
  }
}
