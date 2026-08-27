// server/realtime/sheetSessions.ts
import type Database from 'better-sqlite3';

export interface SheetSessionSnapshot { state: string | null; ops: string[]; seq: number }

interface SessionRow {
  fileId: string;
  state: string | null;
  stateSeq: number;
  dirty: number;
  sessionOpen: number;
  snapshotDone: number;
  updatedAt: number;
}

// Shared spreadsheet session store (WS5 migration 26): one sheet_sessions row
// per file holds the latest authoritative state plus stateSeq, the op batch
// it was folded up to. sheet_ops is the durable journal of everything
// appended since — SQLite IS the crash-recovery log, so the constructor does
// nothing: rows persist as-is, and any left dirty stay dirty for the flush
// engine (Task 4) to pick back up.
//
// Participants are tracked in an in-memory Map only (mirrors PresenceRegistry
// — sessions die with the process); every other flag is persisted.
export class SheetSessionStore {
  private participantsByFile = new Map<string, Set<string>>();

  constructor(private db: Database.Database) {}

  private getRow(fileId: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sheet_sessions WHERE fileId = ?').get(fileId) as SessionRow | undefined;
  }

  private ensureRow(fileId: string, now: number): SessionRow {
    const existing = this.getRow(fileId);
    if (existing) return existing;
    this.db.prepare(`
      INSERT INTO sheet_sessions (fileId, state, stateSeq, dirty, sessionOpen, snapshotDone, updatedAt)
      VALUES (?, NULL, 0, 0, 0, 0, ?)
    `).run(fileId, now);
    return this.getRow(fileId)!;
  }

  // Loads (or creates) the session row and registers the joining participant.
  // A brand-new row hydrates with state=null (client must import the file
  // itself and push the first state-sync) and an empty ops tail at seq 0.
  join(fileId: string, sessionId: string): SheetSessionSnapshot {
    const row = this.ensureRow(fileId, Date.now());

    const set = this.participantsByFile.get(fileId) ?? new Set<string>();
    if (set.size === 0) {
      this.db.prepare('UPDATE sheet_sessions SET sessionOpen = 1 WHERE fileId = ?').run(fileId);
    }
    set.add(sessionId);
    this.participantsByFile.set(fileId, set);

    const ops = (
      this.db.prepare('SELECT ops FROM sheet_ops WHERE fileId = ? AND seq > ? ORDER BY seq ASC')
        .all(fileId, row.stateSeq) as { ops: string }[]
    ).map(r => r.ops);

    return { state: row.state, ops, seq: row.stateSeq };
  }

  leave(fileId: string, sessionId: string): { lastParticipant: boolean } {
    const set = this.participantsByFile.get(fileId);
    if (!set || set.size === 0) return { lastParticipant: true };
    set.delete(sessionId);
    if (set.size === 0) {
      this.participantsByFile.delete(fileId);
      return { lastParticipant: true };
    }
    return { lastParticipant: false };
  }

  participants(fileId: string): string[] {
    return Array.from(this.participantsByFile.get(fileId) ?? []);
  }

  // Appends an opaque client op batch. seq is sourced from MAX(seq)+1 for the
  // file (falling back to the row's stateSeq when the journal is empty) —
  // one query per append is fine since these are batched client ops, not
  // per-keystroke writes.
  appendOps(fileId: string, opsJson: string): number {
    const now = Date.now();
    const row = this.ensureRow(fileId, now);
    const maxOp = this.db.prepare('SELECT MAX(seq) as m FROM sheet_ops WHERE fileId = ?').get(fileId) as { m: number | null };
    const seq = (maxOp.m ?? row.stateSeq) + 1;
    this.db.prepare('INSERT INTO sheet_ops (fileId, seq, ops) VALUES (?, ?, ?)').run(fileId, seq, opsJson);
    this.db.prepare('UPDATE sheet_sessions SET dirty = 1, updatedAt = ? WHERE fileId = ?').run(now, fileId);
    return seq;
  }

  // Debounced-authoritative full state from a client: folds the journal.
  // Sets state, advances stateSeq to the current max op seq, and DELETEs the
  // now-folded sheet_ops rows (seq <= stateSeq) inside one transaction.
  setState(fileId: string, stateJson: string): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const existing = this.getRow(fileId);
      const maxOp = this.db.prepare('SELECT MAX(seq) as m FROM sheet_ops WHERE fileId = ?').get(fileId) as { m: number | null };
      const newSeq = maxOp.m ?? existing?.stateSeq ?? 0;
      if (existing) {
        this.db.prepare('UPDATE sheet_sessions SET state = ?, stateSeq = ?, dirty = 1, updatedAt = ? WHERE fileId = ?')
          .run(stateJson, newSeq, now, fileId);
      } else {
        this.db.prepare(`
          INSERT INTO sheet_sessions (fileId, state, stateSeq, dirty, sessionOpen, snapshotDone, updatedAt)
          VALUES (?, ?, ?, 1, 0, 0, ?)
        `).run(fileId, stateJson, newSeq, now);
      }
      this.db.prepare('DELETE FROM sheet_ops WHERE fileId = ? AND seq <= ?').run(fileId, newSeq);
    });
    tx();
  }

  dirtyFiles(): string[] {
    return (this.db.prepare('SELECT fileId FROM sheet_sessions WHERE dirty = 1').all() as { fileId: string }[])
      .map(r => r.fileId);
  }

  // I4 fix: `expectedStateSeq`, when given, makes this a compare-and-clear —
  // dirty is only cleared if stateSeq is STILL what it was when the caller
  // started its (awaited) flush. A `setState` landing mid-flush bumps
  // stateSeq (see setState above), so this correctly leaves dirty=1 for a
  // state that arrived after the in-flight flush already read its snapshot,
  // instead of the flush's unconditional clear silently discarding it.
  // Omitted (existing behavior, kept for callers/tests that don't care about
  // the race) clears unconditionally.
  markFlushed(fileId: string, expectedStateSeq?: number): void {
    if (expectedStateSeq === undefined) {
      this.db.prepare('UPDATE sheet_sessions SET dirty = 0 WHERE fileId = ?').run(fileId);
      return;
    }
    this.db.prepare('UPDATE sheet_sessions SET dirty = 0 WHERE fileId = ? AND stateSeq = ?').run(fileId, expectedStateSeq);
  }

  // I4: lets a flush capture stateSeq BEFORE its (awaited) bridge patch, so
  // it can later compare-and-clear via markFlushed instead of clearing dirty
  // unconditionally after an arbitrarily long await.
  getStateSeq(fileId: string): number {
    return this.getRow(fileId)?.stateSeq ?? 0;
  }

  needsSessionSnapshot(fileId: string): boolean {
    const row = this.getRow(fileId);
    return !!row && row.sessionOpen === 1 && row.snapshotDone === 0;
  }

  markSessionSnapshotDone(fileId: string): void {
    this.db.prepare('UPDATE sheet_sessions SET snapshotDone = 1 WHERE fileId = ?').run(fileId);
  }

  // Resets sessionOpen + snapshotDone so the NEXT session re-arms the
  // first-flush snapshot.
  closeSession(fileId: string): void {
    this.db.prepare('UPDATE sheet_sessions SET sessionOpen = 0, snapshotDone = 0 WHERE fileId = ?').run(fileId);
  }

  getState(fileId: string): string | null {
    return this.getRow(fileId)?.state ?? null;
  }

  // I6 fix: invalidates a persisted session for a file whose on-disk bytes
  // changed OUTSIDE the flush engine — a version-replace POST or a file
  // delete. Without this: (a) the next sheet-join would hydrate the OLD
  // working copy over the replaced bytes, and the first flush would revert
  // the replacement; (b) a deleted file's dirty row would error-loop the
  // flush engine every 15s forever (persisted across restarts, since dirty
  // rows are durable). Also drops in-memory participant tracking so a stale
  // participant set can't linger for a fileId whose session no longer exists.
  clearSession(fileId: string): void {
    this.db.prepare('DELETE FROM sheet_ops WHERE fileId = ?').run(fileId);
    this.db.prepare('DELETE FROM sheet_sessions WHERE fileId = ?').run(fileId);
    this.participantsByFile.delete(fileId);
  }
}
