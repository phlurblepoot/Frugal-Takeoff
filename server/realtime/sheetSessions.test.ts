// server/realtime/sheetSessions.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { SheetSessionStore } from './sheetSessions';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-sheetsessions-')), migrations);
});

describe('SheetSessionStore', () => {
  it('join on an empty file creates a fresh row: null state, empty ops, seq 0', () => {
    const store = new SheetSessionStore(db);
    const snap = store.join('f1', 's1');
    expect(snap).toEqual({ state: null, ops: [], seq: 0 });

    const row = db.prepare('SELECT * FROM sheet_sessions WHERE fileId = ?').get('f1') as any;
    expect(row).toMatchObject({ fileId: 'f1', state: null, stateSeq: 0, dirty: 0, sessionOpen: 1, snapshotDone: 0 });
  });

  it('appendOps bumps seq monotonically and a second joiner gets the journal tail', () => {
    const store = new SheetSessionStore(db);
    store.join('f1', 's1');

    const seq1 = store.appendOps('f1', '[{"op":"a"}]');
    const seq2 = store.appendOps('f1', '[{"op":"b"}]');
    expect(seq1).toBe(1);
    expect(seq2).toBe(2);

    const snap = store.join('f1', 's2');
    expect(snap.state).toBeNull();
    expect(snap.seq).toBe(0);
    expect(snap.ops).toEqual(['[{"op":"a"}]', '[{"op":"b"}]']);

    const row = db.prepare('SELECT dirty FROM sheet_sessions WHERE fileId = ?').get('f1') as any;
    expect(row.dirty).toBe(1);
  });

  it('setState folds the journal: ops rows deleted, stateSeq advanced, later joiner only sees newer ops', () => {
    const store = new SheetSessionStore(db);
    store.join('f1', 's1');
    store.appendOps('f1', '[{"op":"a"}]'); // seq 1
    store.appendOps('f1', '[{"op":"b"}]'); // seq 2

    store.setState('f1', '{"sheets":["folded-a-b"]}');

    const row = db.prepare('SELECT * FROM sheet_sessions WHERE fileId = ?').get('f1') as any;
    expect(row.state).toBe('{"sheets":["folded-a-b"]}');
    expect(row.stateSeq).toBe(2);
    expect(row.dirty).toBe(1);

    const remainingOps = db.prepare('SELECT COUNT(*) c FROM sheet_ops WHERE fileId = ?').get('f1') as any;
    expect(remainingOps.c).toBe(0);

    // A batch appended AFTER the fold must survive and be the only tail entry.
    store.appendOps('f1', '[{"op":"c"}]'); // seq 3

    const snap = store.join('f1', 's2');
    expect(snap.state).toBe('{"sheets":["folded-a-b"]}');
    expect(snap.seq).toBe(2);
    expect(snap.ops).toEqual(['[{"op":"c"}]']);
  });

  it('setState works on a file with no prior join/appendOps (creates the row)', () => {
    const store = new SheetSessionStore(db);
    store.setState('f-fresh', '{"sheets":[]}');
    const row = db.prepare('SELECT * FROM sheet_sessions WHERE fileId = ?').get('f-fresh') as any;
    expect(row).toMatchObject({ state: '{"sheets":[]}', stateSeq: 0, dirty: 1, sessionOpen: 0, snapshotDone: 0 });
  });

  it('leave reports lastParticipant bookkeeping', () => {
    const store = new SheetSessionStore(db);
    store.join('f1', 's1');
    store.join('f1', 's2');

    expect(store.participants('f1').sort()).toEqual(['s1', 's2']);
    expect(store.leave('f1', 's1')).toEqual({ lastParticipant: false });
    expect(store.participants('f1')).toEqual(['s2']);
    expect(store.leave('f1', 's2')).toEqual({ lastParticipant: true });
    expect(store.participants('f1')).toEqual([]);

    // Leaving again (already empty) is a no-op that still reports last-participant.
    expect(store.leave('f1', 's2')).toEqual({ lastParticipant: true });
  });

  it('dirty lifecycle: appendOps/setState mark dirty, markFlushed clears it, dirtyFiles lists only dirty rows', () => {
    const store = new SheetSessionStore(db);
    store.join('f1', 's1');
    store.join('f2', 's1');
    expect(store.dirtyFiles()).toEqual([]);

    store.appendOps('f1', '[{"op":"a"}]');
    expect(store.dirtyFiles().sort()).toEqual(['f1']);

    store.markFlushed('f1');
    expect(store.dirtyFiles()).toEqual([]);

    store.setState('f2', '{"sheets":[]}');
    expect(store.dirtyFiles()).toEqual(['f2']);

    store.markFlushed('f2');
    expect(store.dirtyFiles()).toEqual([]);
  });

  it('snapshot arm/re-arm across two sessions', () => {
    const store = new SheetSessionStore(db);

    // Session 1: join arms sessionOpen; snapshot not yet done.
    store.join('f1', 's1');
    expect(store.needsSessionSnapshot('f1')).toBe(true);

    store.markSessionSnapshotDone('f1');
    expect(store.needsSessionSnapshot('f1')).toBe(false);

    // s1 leaves (last participant) and the caller (flush engine) closes the
    // session, resetting both flags for the next one.
    expect(store.leave('f1', 's1')).toEqual({ lastParticipant: true });
    store.closeSession('f1');
    expect(store.needsSessionSnapshot('f1')).toBe(false); // sessionOpen is 0 now

    // Session 2 re-arms the snapshot requirement.
    store.join('f1', 's2');
    expect(store.needsSessionSnapshot('f1')).toBe(true);
  });

  it('needsSessionSnapshot is false for a file with no row yet', () => {
    const store = new SheetSessionStore(db);
    expect(store.needsSessionSnapshot('nope')).toBe(false);
  });

  it('getState returns the persisted state, or null when absent', () => {
    const store = new SheetSessionStore(db);
    expect(store.getState('nope')).toBeNull();
    store.join('f1', 's1');
    expect(store.getState('f1')).toBeNull();
    store.setState('f1', '{"sheets":["x"]}');
    expect(store.getState('f1')).toBe('{"sheets":["x"]}');
  });

  // N2 regression (micro-fix round — found by the re-review of the I4 fix):
  // the persisted `stateSeq` column only advances when setState's own query
  // finds a NEWER row in sheet_ops than what's already recorded — a second
  // setState with no appendOps in between leaves it completely unchanged.
  // A flush's compare-and-clear keyed on stateSeq would then spuriously
  // "match" and wrongly clear dirty for state it never actually flushed.
  // The in-memory generation counter bumps on EVERY setState/appendOps
  // unconditionally, so it can't miss this.
  it('generation bumps on appendOps AND a bare setState, even when stateSeq itself does not move', () => {
    const store = new SheetSessionStore(db);
    store.join('f1', 's1');
    const g0 = store.generation('f1');

    store.appendOps('f1', '[{"op":"a"}]');
    const g1 = store.generation('f1');
    expect(g1).not.toBe(g0);

    store.setState('f1', '{"sheets":["folded"]}');
    const stateSeqAfterFirstSetState = (db.prepare('SELECT stateSeq FROM sheet_sessions WHERE fileId = ?').get('f1') as any).stateSeq;
    const g2 = store.generation('f1');
    expect(g2).not.toBe(g1);

    // A SECOND setState with no appendOps in between — exactly I8's
    // dirty-reconnect push shape (an authoritative sendSheetState with
    // nothing recorded server-side during the outage).
    store.setState('f1', '{"sheets":["folded-again"]}');
    const stateSeqAfterSecondSetState = (db.prepare('SELECT stateSeq FROM sheet_sessions WHERE fileId = ?').get('f1') as any).stateSeq;
    expect(stateSeqAfterSecondSetState).toBe(stateSeqAfterFirstSetState); // stateSeq alone missed this
    const g3 = store.generation('f1');
    expect(g3).not.toBe(g2); // generation still caught it
  });

  it('markFlushed(fileId, expectedGeneration) only clears dirty when the generation is unchanged', () => {
    const store = new SheetSessionStore(db);
    store.join('f1', 's1');
    store.setState('f1', '{"sheets":["a"]}');
    const gen = store.generation('f1');

    // Nothing mutated since — clears as expected.
    store.markFlushed('f1', gen);
    expect(store.dirtyFiles()).not.toContain('f1');

    // Something mutates AFTER the caller captured `gen` (simulating a
    // flush's in-flight window) — the stale generation must not clear it.
    store.setState('f1', '{"sheets":["b"]}');
    store.markFlushed('f1', gen);
    expect(store.dirtyFiles()).toContain('f1');

    // A fresh capture succeeds.
    store.markFlushed('f1', store.generation('f1'));
    expect(store.dirtyFiles()).not.toContain('f1');
  });

  it('crash recovery: a second store built on the same db sees dirty files and journal intact', () => {
    const store1 = new SheetSessionStore(db);
    store1.join('f1', 's1');
    store1.appendOps('f1', '[{"op":"a"}]');
    store1.appendOps('f1', '[{"op":"b"}]');

    // Simulate a crash: no clean shutdown, no explicit teardown — the rows
    // just sit in the db exactly as they were left.
    const store2 = new SheetSessionStore(db);
    expect(store2.dirtyFiles()).toEqual(['f1']);

    // Participants are in-memory only, so store2 starts with none registered
    // for f1 — a fresh join is required after a crash.
    expect(store2.participants('f1')).toEqual([]);

    const snap = store2.join('f1', 's-recovered');
    expect(snap.state).toBeNull();
    expect(snap.seq).toBe(0);
    expect(snap.ops).toEqual(['[{"op":"a"}]', '[{"op":"b"}]']);
  });
});
