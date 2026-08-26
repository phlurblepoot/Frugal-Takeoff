// server/realtime/sheetFlush.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import type ExcelJS from 'exceljs';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { putBuffer, getMeta, listVersions } from '../files';
import { readFileContent } from '../fileStore';
import { workbookToFortuneSheets } from '../../src/utils/sheetBridge';
import { SheetSessionStore } from './sheetSessions';
import { SheetFlushEngine } from './sheetFlush';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

let db: Database.Database;
let dir: string;

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-sheetflush-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
});

afterEach(() => {
  fsSync.rmSync(dir, { recursive: true, force: true });
});

// Seeds a live xlsx file in the file store and returns its id.
async function seedFile(): Promise<string> {
  const bytes = await buildFixtureXlsx();
  const id = 'sheet1';
  putBuffer(db, dir, id, bytes, XLSX_MIME);
  return id;
}

// Builds a folded state string with A2 changed to 9999, from the file's
// current on-disk bytes (mirrors how a real client would derive it via
// workbookToFortuneSheets after joining a session).
async function stateWithA2Changed(fileId: string): Promise<string> {
  const original = readFileContent(dir, fileId)!;
  const { sheets } = await workbookToFortuneSheets(original);
  const a2 = sheets[0].celldata!.find((cd) => cd.r === 1 && cd.c === 0)!;
  a2.v!.v = 9999;
  a2.v!.m = '9999';
  return JSON.stringify(sheets);
}

describe('SheetFlushEngine', () => {
  it('flushFile patches the changed cell into the stored xlsx bytes', async () => {
    const fileId = await seedFile();
    const store = new SheetSessionStore(db);
    const engine = new SheetFlushEngine(db, store, dir);

    store.join(fileId, 's1');
    store.setState(fileId, await stateWithA2Changed(fileId));

    const result = await engine.flushFile(fileId);
    expect(result).toEqual({ ok: true });

    const outBytes = readFileContent(dir, fileId)!;
    const outWb = await reload(outBytes);
    expect(outWb.worksheets[0].getCell('A2').value).toBe(9999);
    // Untouched cell still intact.
    expect(outWb.worksheets[0].getCell('A1').value).toBe('Hello');
  });

  it('first flush of a session archives a version; second flush does not', async () => {
    const fileId = await seedFile();
    const store = new SheetSessionStore(db);
    const engine = new SheetFlushEngine(db, store, dir);

    store.join(fileId, 's1');
    expect(store.needsSessionSnapshot(fileId)).toBe(true);

    store.setState(fileId, await stateWithA2Changed(fileId));
    await engine.flushFile(fileId);

    // First flush: archived the pre-session bytes as a version.
    const versionsAfterFirst = listVersions(db, fileId);
    expect(versionsAfterFirst).toHaveLength(2); // live + one archived
    expect(store.needsSessionSnapshot(fileId)).toBe(false);

    // Second edit within the same session.
    store.setState(fileId, JSON.stringify((await workbookToFortuneSheets(readFileContent(dir, fileId)!)).sheets));
    await engine.flushFile(fileId);

    const versionsAfterSecond = listVersions(db, fileId);
    expect(versionsAfterSecond).toHaveLength(2); // unchanged — no second archive
  });

  it('snapshotNow always archives, even when needsSessionSnapshot is already false', async () => {
    const fileId = await seedFile();
    const store = new SheetSessionStore(db);
    const engine = new SheetFlushEngine(db, store, dir);

    store.join(fileId, 's1');
    store.setState(fileId, await stateWithA2Changed(fileId));
    await engine.flushFile(fileId); // consumes the session snapshot slot
    expect(store.needsSessionSnapshot(fileId)).toBe(false);
    expect(listVersions(db, fileId)).toHaveLength(2);

    const beforeVersion = getMeta(db, fileId)!.versionNumber;
    const result = await engine.snapshotNow(fileId);
    expect(result.ok).toBe(true);
    expect(result.version).toBe(beforeVersion + 1);
    expect(listVersions(db, fileId)).toHaveLength(3);
  });

  it('crash-sim: dirty state left by a dead engine is recovered by a fresh instance', async () => {
    const fileId = await seedFile();
    const store = new SheetSessionStore(db);
    store.join(fileId, 's1');
    store.setState(fileId, await stateWithA2Changed(fileId));
    // No engine ever flushed — simulate the process dying with dirty=1 left
    // in the (durable, on-disk) db.

    const revivedStore = new SheetSessionStore(db);
    const revivedEngine = new SheetFlushEngine(db, revivedStore, dir);
    await revivedEngine.flushAll();

    expect(revivedStore.dirtyFiles()).toEqual([]);
    const outBytes = readFileContent(dir, fileId)!;
    const outWb = await reload(outBytes);
    expect(outWb.worksheets[0].getCell('A2').value).toBe(9999);
  });

  it('a null-state dirty row is skipped without error and cleared', async () => {
    const fileId = await seedFile();
    const versionBefore = getMeta(db, fileId)!.versionNumber;
    const store = new SheetSessionStore(db);
    const engine = new SheetFlushEngine(db, store, dir);

    // join() marks the row dirty=0 but appendOps would flip it dirty with a
    // still-null state — mirror that directly against the store.
    store.join(fileId, 's1');
    store.appendOps(fileId, '[{"op":"noop"}]');
    expect(store.getState(fileId)).toBeNull();
    expect(store.dirtyFiles()).toContain(fileId);

    const result = await engine.flushFile(fileId);
    expect(result).toEqual({ ok: true });
    expect(store.dirtyFiles()).not.toContain(fileId);

    // File on disk is untouched (no patch attempted, no version bump).
    const meta = getMeta(db, fileId)!;
    expect(meta.versionNumber).toBe(versionBefore);
  });

  it('flushFile leaves a file dirty on error (missing file id)', async () => {
    const store = new SheetSessionStore(db);
    const engine = new SheetFlushEngine(db, store, dir);
    store.setState('missing-file', '[]');

    const result = await engine.flushFile('missing-file');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(store.dirtyFiles()).toContain('missing-file');
  });

  it('concurrent flushFile calls for the same file join instead of racing', async () => {
    const fileId = await seedFile();
    const store = new SheetSessionStore(db);
    const engine = new SheetFlushEngine(db, store, dir);

    store.join(fileId, 's1');
    store.setState(fileId, await stateWithA2Changed(fileId));

    // Called back-to-back, neither awaited yet: the second call must join
    // the first's in-flight promise rather than starting its own run (which
    // would read the same not-yet-updated bytes and could win the write
    // last, silently reverting the flush with dirty cleared).
    const p1 = engine.flushFile(fileId);
    const p2 = engine.flushFile(fileId);
    expect(p2).toBe(p1); // literally the same in-flight promise — proof of joining, not racing

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toBe(r1);

    const outWb = await reload(readFileContent(dir, fileId)!);
    expect(outWb.worksheets[0].getCell('A2').value).toBe(9999);
    // Only one archive happened even though flushFile was "called twice".
    expect(listVersions(db, fileId)).toHaveLength(2);
  });

  it('snapshotNow joins a racing flush by waiting for it, then performs its own archive exactly once', async () => {
    const fileId = await seedFile();
    const store = new SheetSessionStore(db);
    const engine = new SheetFlushEngine(db, store, dir);

    store.join(fileId, 's1');
    store.setState(fileId, await stateWithA2Changed(fileId));
    await engine.flushFile(fileId); // consumes the session snapshot slot
    expect(store.needsSessionSnapshot(fileId)).toBe(false);
    const versionsBefore = listVersions(db, fileId).length;

    // A second edit dirties the file again. This flush will be a plain write
    // (no archive) since the session snapshot slot is already spent.
    const { sheets: secondSheets } = await workbookToFortuneSheets(readFileContent(dir, fileId)!);
    secondSheets[0].celldata!.find((cd) => cd.r === 1 && cd.c === 0)!.v!.v = 42;
    store.setState(fileId, JSON.stringify(secondSheets));

    const pFlush = engine.flushFile(fileId); // starts running, not yet awaited
    const pSnap = engine.snapshotNow(fileId); // must wait for pFlush to settle, then archive
    const [flushResult, snapResult] = await Promise.all([pFlush, pSnap]);

    expect(flushResult.ok).toBe(true);
    expect(snapResult.ok).toBe(true);
    expect(snapResult.version).toBeDefined();

    // Exactly one NEW archive: the racing flush contributed none (session
    // slot already spent), snapshotNow contributed exactly one forced archive.
    expect(listVersions(db, fileId)).toHaveLength(versionsBefore + 1);
  });

  it('start/stop schedules flushAll on an interval and can be stopped', async () => {
    const fileId = await seedFile();
    const store = new SheetSessionStore(db);
    const engine = new SheetFlushEngine(db, store, dir, { intervalMs: 10 });

    store.join(fileId, 's1');
    store.setState(fileId, await stateWithA2Changed(fileId));

    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    engine.stop();

    expect(store.dirtyFiles()).not.toContain(fileId);
  });
});
