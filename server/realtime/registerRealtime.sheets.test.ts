import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import type ExcelJS from 'exceljs';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { putBuffer } from '../files';
import { readFileContent } from '../fileStore';
import { workbookToFortuneSheets } from '../../src/utils/sheetBridge';
import { SheetSessionStore } from './sheetSessions';
import { SheetFlushEngine } from './sheetFlush';
import { startRealtimeServer, connectClient, makeToken, waitFor, emitWithAck } from './testHarness';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEETS_PATH = '/tools/sheets';

async function loadExcelJS() {
  const { default: ExcelJSlib } = await import('exceljs');
  return ExcelJSlib;
}

async function buildFixtureXlsx(): Promise<Buffer> {
  const ExcelJSlib = await loadExcelJS();
  const wb = new ExcelJSlib.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.getCell('A1').value = 'Hello';
  ws.getCell('A2').value = 1234.5;
  const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
  return Buffer.from(buffer);
}

async function reload(bytes: Buffer): Promise<ExcelJS.Workbook> {
  const ExcelJSlib = await loadExcelJS();
  const wb = new ExcelJSlib.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return wb;
}

async function waitUntil(fn: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

let db: Database.Database;
let dir: string;
let store: SheetSessionStore;
let flush: SheetFlushEngine;
let srv: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeEach(async () => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-sheets-rt-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  store = new SheetSessionStore(db);
  flush = new SheetFlushEngine(db, store, dir);
  srv = await startRealtimeServer({ db, sheetStore: store, sheetFlush: flush });
});

afterEach(async () => {
  flush.stop();
  await srv.close();
  fsSync.rmSync(dir, { recursive: true, force: true });
});

async function seedSheetFile(): Promise<string> {
  const bytes = await buildFixtureXlsx();
  const id = 'sheet1';
  putBuffer(db, dir, id, bytes, XLSX_MIME, { kind: 'spreadsheet' });
  return id;
}

async function seedNonSheetFile(): Promise<string> {
  const id = 'doc1';
  putBuffer(db, dir, id, Buffer.from('%PDF-1.4'), 'application/pdf', { kind: 'document' });
  return id;
}

async function joinedClient(username: string, fileId: string, extraAuth: Record<string, unknown> = {}) {
  const c = connectClient(srv.port, makeToken({ id: username, username }), extraAuth);
  const snap = await waitFor<{ selfId: string }>(c, 'sessions-snapshot');
  c.emit('set-location', { path: SHEETS_PATH, fileId });
  await new Promise((r) => setTimeout(r, 100));
  return { c, selfId: snap.selfId };
}

describe('sheet socket layer: sheet-join / sheet-op / sheet-state-sync / sheet-snapshot / sheet-presence', () => {
  it('join on a fresh file returns null state, empty ops tail, seq 0, participants 1', async () => {
    const fileId = await seedSheetFile();
    const a = await joinedClient('a', fileId);

    const ack = await emitWithAck<any>(a.c, 'sheet-join', { fileId });
    expect(ack).toEqual({ ok: true, state: null, ops: [], seq: 0, participants: 1 });

    a.c.close();
  });

  it('A pushes an op; B (in the same sheet room) receives sheet-op-applied with the same opaque payload + seq', async () => {
    const fileId = await seedSheetFile();
    const a = await joinedClient('a', fileId);
    const b = await joinedClient('b', fileId);
    await emitWithAck(a.c, 'sheet-join', { fileId });
    await emitWithAck(b.c, 'sheet-join', { fileId });

    const applied = waitFor<any>(b.c, 'sheet-op-applied');
    const opsPayload = JSON.stringify([{ op: 'set-cell', r: 0, c: 0, v: 'x' }]);
    const ack = await emitWithAck<any>(a.c, 'sheet-op', { fileId, ops: opsPayload, clientTabId: 'tab-A' });
    expect(ack).toEqual({ ok: true, seq: 1 });

    const evt = await applied;
    expect(evt).toEqual({ fileId, ops: opsPayload, seq: 1, bySessionId: 'tab-A' });

    a.c.close(); b.c.close();
  });

  it('late joiner receives the current folded state plus the ops tail appended after it', async () => {
    const fileId = await seedSheetFile();
    const a = await joinedClient('a', fileId);
    await emitWithAck(a.c, 'sheet-join', { fileId });

    await emitWithAck(a.c, 'sheet-op', { fileId, ops: 'op1' });
    const foldState = 'fold-state-1';
    await emitWithAck(a.c, 'sheet-state-sync', { fileId, state: foldState, clientTabId: 'tab-A' });
    const ackOp2 = await emitWithAck<any>(a.c, 'sheet-op', { fileId, ops: 'op2' });
    expect(ackOp2).toEqual({ ok: true, seq: 2 });

    const c = await joinedClient('c', fileId);
    const ackJoin = await emitWithAck<any>(c.c, 'sheet-join', { fileId });
    expect(ackJoin).toEqual({ ok: true, state: foldState, ops: ['op2'], seq: 1, participants: 2 });

    a.c.close(); c.c.close();
  });

  it('state-sync folds the journal so a joiner right after sees no stale ops', async () => {
    const fileId = await seedSheetFile();
    const a = await joinedClient('a', fileId);
    await emitWithAck(a.c, 'sheet-join', { fileId });

    await emitWithAck(a.c, 'sheet-op', { fileId, ops: 'op1' });
    await emitWithAck(a.c, 'sheet-op', { fileId, ops: 'op2' });
    const foldState = 'fold-state-2';
    await emitWithAck(a.c, 'sheet-state-sync', { fileId, state: foldState });

    const c = await joinedClient('c', fileId);
    const ackJoin = await emitWithAck<any>(c.c, 'sheet-join', { fileId });
    expect(ackJoin).toEqual({ ok: true, state: foldState, ops: [], seq: 2, participants: 2 });

    a.c.close(); c.c.close();
  });

  it('a socket not located in the sheet room gets not_in_sheet', async () => {
    const fileId = await seedSheetFile();
    const outsider = connectClient(srv.port, makeToken({ id: 'x', username: 'x' }));
    await waitFor(outsider, 'sessions-snapshot');
    outsider.emit('set-location', { path: '/dashboard' });
    await new Promise((r) => setTimeout(r, 100));

    const ack = await emitWithAck<any>(outsider, 'sheet-join', { fileId });
    expect(ack).toEqual({ ok: false, error: 'not_in_sheet' });

    outsider.close();
  });

  it('joining on a non-spreadsheet file returns not_spreadsheet', async () => {
    const fileId = await seedNonSheetFile();
    const a = await joinedClient('a', fileId);

    const ack = await emitWithAck<any>(a.c, 'sheet-join', { fileId });
    expect(ack).toEqual({ ok: false, error: 'not_spreadsheet' });

    a.c.close();
  });

  it('last participant leaving triggers a flush (file bytes change on disk) and closes the session', async () => {
    const fileId = await seedSheetFile();
    const a = await joinedClient('a', fileId);
    await emitWithAck(a.c, 'sheet-join', { fileId });

    const original = readFileContent(dir, fileId)!;
    const { sheets } = await workbookToFortuneSheets(original);
    const a2 = sheets[0].celldata!.find((cd) => cd.r === 1 && cd.c === 0)!;
    a2.v!.v = 4242;
    a2.v!.m = '4242';
    const stateJson = JSON.stringify(sheets);

    const syncAck = await emitWithAck<any>(a.c, 'sheet-state-sync', { fileId, state: stateJson });
    expect(syncAck).toEqual({ ok: true });

    a.c.close();

    await waitUntil(() => {
      const bytes = readFileContent(dir, fileId);
      return !!bytes && !bytes.equals(original);
    });

    const outBytes = readFileContent(dir, fileId)!;
    const outWb = await reload(outBytes);
    expect(outWb.worksheets[0].getCell('A2').value).toBe(4242);

    // Session closed: a fresh join re-arms the first-flush session snapshot.
    store.join(fileId, 'probe-session');
    expect(store.needsSessionSnapshot(fileId)).toBe(true);
  });

  it('presence relay carries the sender\'s name/color, not client-supplied ones', async () => {
    const fileId = await seedSheetFile();
    const a = await joinedClient('a', fileId, { color: '#abcdef' });
    const b = await joinedClient('b', fileId);
    await emitWithAck(a.c, 'sheet-join', { fileId });
    await emitWithAck(b.c, 'sheet-join', { fileId });

    const presence = waitFor<any>(b.c, 'sheet-presence');
    a.c.emit('sheet-presence', { fileId, presence: { sheetId: 'sh1', r: 2, c: 3 } });

    const evt = await presence;
    expect(evt).toEqual({
      fileId,
      sessionId: a.selfId,
      name: 'a',
      color: '#abcdef',
      presence: { sheetId: 'sh1', r: 2, c: 3 },
    });

    a.c.close(); b.c.close();
  });

  // I7: sheet-state-sync and sheet-snapshot previously only checked room
  // membership — and ANY location carrying a fileId joins sheetRoom(fileId)
  // (roomsForLocation in registerRealtime.ts), so a socket could push state
  // or force an archive for a fileId it never actually sheet-joined,
  // including a non-spreadsheet file or a fileId that doesn't exist.
  it('sheet-state-sync on a non-spreadsheet file is rejected with not_spreadsheet, without creating a session row', async () => {
    const fileId = await seedNonSheetFile();
    const a = await joinedClient('a', fileId); // in the room via set-location only — never sheet-joins

    const ack = await emitWithAck<any>(a.c, 'sheet-state-sync', { fileId, state: '{"sheets":[]}' });
    expect(ack).toEqual({ ok: false, error: 'not_spreadsheet' });
    expect(store.getState(fileId)).toBeNull();

    a.c.close();
  });

  it('sheet-state-sync on a nonexistent fileId is rejected with file_not_found', async () => {
    const fileId = 'does-not-exist';
    const a = await joinedClient('a', fileId);

    const ack = await emitWithAck<any>(a.c, 'sheet-state-sync', { fileId, state: '{"sheets":[]}' });
    expect(ack).toEqual({ ok: false, error: 'file_not_found' });

    a.c.close();
  });

  it('sheet-snapshot on a non-spreadsheet file is rejected with not_spreadsheet', async () => {
    const fileId = await seedNonSheetFile();
    const a = await joinedClient('a', fileId);

    const ack = await emitWithAck<any>(a.c, 'sheet-snapshot', { fileId });
    expect(ack).toEqual({ ok: false, error: 'not_spreadsheet' });

    a.c.close();
  });

  it('sheet-snapshot on a nonexistent fileId is rejected with file_not_found', async () => {
    const fileId = 'also-does-not-exist';
    const a = await joinedClient('a', fileId);

    const ack = await emitWithAck<any>(a.c, 'sheet-snapshot', { fileId });
    expect(ack).toEqual({ ok: false, error: 'file_not_found' });

    a.c.close();
  });

  it('an oversized op payload is rejected with invalid_request', async () => {
    const fileId = await seedSheetFile();
    const a = await joinedClient('a', fileId);
    await emitWithAck(a.c, 'sheet-join', { fileId });

    const oversized = 'x'.repeat(1024 * 1024 + 1);
    const ack = await emitWithAck<any>(a.c, 'sheet-op', { fileId, ops: oversized });
    expect(ack).toEqual({ ok: false, error: 'invalid_request' });

    a.c.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Journal-replay-after-kill (WS5 task 9 / spec §7's "replay after kill",
// adapted to the opaque-op design — see task-9-report.md's Ruled Deviations
// for the full rationale): SQLite (not an in-memory-only structure) is the
// crash-recovery log. A "restart" is simulated by building a FRESH
// SheetSessionStore/SheetFlushEngine pair on the SAME `db`/`dir` — a real
// process restart does exactly this (the beforeEach's `store`/`flush` play
// the role of "the process that got killed"; the ones built inside this test
// play "the process that came back up"). Nothing here goes through the
// socket layer — direct store/engine calls are the more direct proof for a
// storage-durability claim than round-tripping it through sockets again
// (already covered by the tests above).
// ─────────────────────────────────────────────────────────────────────────────
describe('journal survives a simulated server restart', () => {
  it('a joiner after "restart" gets state+tail; flushAll folds the LAST state to disk; the tail stays in SQLite for the next joiner', async () => {
    const fileId = await seedSheetFile();
    const original = readFileContent(dir, fileId)!;

    // ── Pre-restart: join, ops appended, state synced, MORE ops appended ──
    store.join(fileId, 's1');
    store.appendOps(fileId, 'op1'); // seq 1 — folded away by the setState below

    const { sheets } = await workbookToFortuneSheets(original);
    const a2 = sheets[0].celldata!.find((cd) => cd.r === 1 && cd.c === 0)!;
    a2.v!.v = 9999;
    a2.v!.m = '9999';
    const stateJson = JSON.stringify(sheets);
    store.setState(fileId, stateJson); // folds op1; stateSeq -> 1; dirty=1

    store.appendOps(fileId, 'op2'); // seq 2 — the tail AFTER the fold, never folded

    // ── "Restart": a fresh store + flush engine on the SAME db/dir. The
    //    beforeEach's `store`/`flush` are deliberately never touched again
    //    below — they stand in for the killed process. ────────────────────
    const store2 = new SheetSessionStore(db);
    const flush2 = new SheetFlushEngine(db, store2, dir);

    // A new joiner (arriving after the "restart") receives the folded state
    // AND the untouched ops tail — nothing from SQLite was lost.
    const snap = store2.join(fileId, 's-recovered');
    expect(snap.state).toBe(stateJson);
    expect(snap.seq).toBe(1);
    expect(snap.ops).toEqual(['op2']);
    expect(store2.dirtyFiles()).toEqual([fileId]);

    // flushAll folds using the LAST STATE (stateJson, the post-fold value —
    // op2 is opaque and was never applied to it) onto the live xlsx bytes.
    await flush2.flushAll();
    expect(store2.dirtyFiles()).toEqual([]);

    const outBytes = readFileContent(dir, fileId)!;
    expect(outBytes.equals(original)).toBe(false);
    const outWb = await reload(outBytes);
    expect(outWb.worksheets[0].getCell('A2').value).toBe(9999);

    // The op2 tail is deliberately NOT consumed by the flush (see the ruled
    // deviation: opaque ops are only reconciled by the NEXT CLIENT's own
    // state-sync) — it must still be there, durable in sheet_ops, for
    // whoever joins next.
    const snapAfterFlush = store2.join(fileId, 's-another');
    expect(snapAfterFlush.state).toBe(stateJson);
    expect(snapAfterFlush.ops).toEqual(['op2']);
  });
});
