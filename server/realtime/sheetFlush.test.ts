// server/realtime/sheetFlush.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { workbookToFortuneSheets, patchWorkbookFromFortuneSheets } from '../../src/utils/sheetBridge';
import { SheetSessionStore } from './sheetSessions';
import { SheetFlushEngine } from './sheetFlush';

// I4's test below needs to delay the bridge patch call so it can mutate
// session state WHILE a flush is in flight — vi.mock (with the real module
// passed through for everything else) is the cleanest way to gate just that
// one call without touching production code.
vi.mock('../../src/utils/sheetBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/sheetBridge')>();
  return { ...actual, patchWorkbookFromFortuneSheets: vi.fn(actual.patchWorkbookFromFortuneSheets) };
});

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

  // I4: a setState landing WHILE a flush's bridge-patch call is in flight
  // must not have its dirty flag wiped by that flush's (stale) markFlushed —
  // it needs to survive for the NEXT flush to pick up.
  it('a setState arriving during an in-flight flush keeps dirty set for the next flush to pick up', async () => {
    const fileId = await seedFile();
    const store = new SheetSessionStore(db);
    const engine = new SheetFlushEngine(db, store, dir);

    store.join(fileId, 's1');
    store.setState(fileId, await stateWithA2Changed(fileId));

    const mocked = vi.mocked(patchWorkbookFromFortuneSheets);
    const realImpl = mocked.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocked.mockImplementationOnce(async (...args) => {
      await gate;
      return realImpl(...args);
    });

    const flushPromise = engine.flushFile(fileId);
    // Let the flush read its state snapshot and reach the (now-gated) patch call.
    await new Promise((r) => setImmediate(r));

    // A newer edit's state-sync "arrives" while the flush above is still
    // awaiting the gated patch call. An op must land first: setState's
    // stateSeq is sourced from MAX(seq) in sheet_ops (see setState), so two
    // setStates with no op in between leave stateSeq unchanged — exactly
    // what a real client does (state-sync only ever follows a local op; see
    // localDirtyRef in SpreadsheetEditor.tsx), and exactly what's needed
    // here to actually advance stateSeq past what the flush captured.
    store.appendOps(fileId, '[{"op":"noop"}]');
    const { sheets } = await workbookToFortuneSheets(readFileContent(dir, fileId)!);
    sheets[0].celldata!.find((cd) => cd.r === 1 && cd.c === 0)!.v!.v = 5555;
    sheets[0].celldata!.find((cd) => cd.r === 1 && cd.c === 0)!.v!.m = '5555';
    store.setState(fileId, JSON.stringify(sheets));

    release();
    const result = await flushPromise;
    expect(result.ok).toBe(true);

    // The in-flight flush's own markFlushed must NOT have cleared the dirty
    // flag the mid-flush setState just set.
    expect(store.dirtyFiles()).toContain(fileId);

    // The next flush picks up the newer (5555) state.
    await engine.flushFile(fileId);
    expect(store.dirtyFiles()).not.toContain(fileId);
    const outWb = await reload(readFileContent(dir, fileId)!);
    expect(outWb.worksheets[0].getCell('A2').value).toBe(5555);
  });

  // I5: flush failures must be observable via the `notify` callback —
  // previously every failure path was console-only. Repeated failures for
  // the same file only report the initial "failed" edge, not every retry.
  // N2 regression (micro-fix round — found by the re-review of the I4 fix):
  // a BARE setState (no `appendOps` in between) during an in-flight flush
  // used to slip past the stateSeq-based compare-and-clear, because
  // setState's own `newSeq` is sourced from MAX(seq) in sheet_ops — a second
  // setState with nothing newer in the journal leaves stateSeq unchanged.
  // This is exactly I8's dirty-reconnect push shape (sendSheetState with no
  // preceding sendSheetOp). The generation-counter fix bumps unconditionally
  // on every setState, so it can't miss this.
  it('a bare setState (no intervening appendOps) during an in-flight flush also keeps dirty set', async () => {
    const fileId = await seedFile();
    const store = new SheetSessionStore(db);
    const engine = new SheetFlushEngine(db, store, dir);

    store.join(fileId, 's1');
    store.setState(fileId, await stateWithA2Changed(fileId));

    const mocked = vi.mocked(patchWorkbookFromFortuneSheets);
    const realImpl = mocked.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocked.mockImplementationOnce(async (...args) => {
      await gate;
      return realImpl(...args);
    });

    const flushPromise = engine.flushFile(fileId);
    await new Promise((r) => setImmediate(r));

    // A bare setState — NO appendOps call before it — while the flush above
    // is still awaiting the gated patch call.
    const { sheets } = await workbookToFortuneSheets(readFileContent(dir, fileId)!);
    sheets[0].celldata!.find((cd) => cd.r === 1 && cd.c === 0)!.v!.v = 7777;
    sheets[0].celldata!.find((cd) => cd.r === 1 && cd.c === 0)!.v!.m = '7777';
    store.setState(fileId, JSON.stringify(sheets));

    release();
    const result = await flushPromise;
    expect(result.ok).toBe(true);

    // Must still be dirty — a stateSeq-based compare would have wrongly
    // cleared this (stateSeq didn't move), but generation did.
    expect(store.dirtyFiles()).toContain(fileId);

    await engine.flushFile(fileId);
    expect(store.dirtyFiles()).not.toContain(fileId);
    const outWb = await reload(readFileContent(dir, fileId)!);
    expect(outWb.worksheets[0].getCell('A2').value).toBe(7777);
  });

  it('notify fires "failed" once for a flush error, not again on a repeated failure', async () => {
    const store = new SheetSessionStore(db);
    const events: { fileId: string; event: 'failed' | 'recovered' }[] = [];
    const engine = new SheetFlushEngine(db, store, dir, {
      notify: (fileId, event) => events.push({ fileId, event }),
    });

    store.setState('missing-file', '[]'); // no such file — flush will fail
    const failResult = await engine.flushFile('missing-file');
    expect(failResult.ok).toBe(false);
    expect(events).toEqual([{ fileId: 'missing-file', event: 'failed' }]);

    // A second failure for the same file must not re-fire "failed" again —
    // only the failed->recovered EDGE is reported.
    store.setState('missing-file', '[]');
    await engine.flushFile('missing-file');
    expect(events).toEqual([{ fileId: 'missing-file', event: 'failed' }]);
  });

  it('a file that never failed produces no notify events on a normal successful flush', async () => {
    const fileId = await seedFile();
    const store = new SheetSessionStore(db);
    const events: { fileId: string; event: 'failed' | 'recovered' }[] = [];
    const engine = new SheetFlushEngine(db, store, dir, {
      notify: (fid, event) => events.push({ fileId: fid, event }),
    });

    store.join(fileId, 's1');
    store.setState(fileId, await stateWithA2Changed(fileId));
    const result = await engine.flushFile(fileId);
    expect(result.ok).toBe(true);
    expect(events).toEqual([]);
  });

  it('notify reports recovery specifically for a fileId that had previously failed', async () => {
    const fileId = await seedFile();
    const store = new SheetSessionStore(db);
    const events: { fileId: string; event: 'failed' | 'recovered' }[] = [];
    const engine = new SheetFlushEngine(db, store, dir, {
      notify: (fid, event) => events.push({ fileId: fid, event }),
    });

    // Force a failure for this fileId: dirty with a state, but no on-disk
    // content (simulate by clearing the file's bytes via a mocked parse error).
    const mocked = vi.mocked(patchWorkbookFromFortuneSheets);
    mocked.mockImplementationOnce(async () => { throw new Error('boom'); });
    store.join(fileId, 's1');
    store.setState(fileId, await stateWithA2Changed(fileId));
    const failResult = await engine.flushFile(fileId);
    expect(failResult.ok).toBe(false);
    expect(events).toEqual([{ fileId, event: 'failed' }]);

    // Next flush succeeds (mock no longer throws) — must report "recovered".
    store.setState(fileId, await stateWithA2Changed(fileId));
    const okResult = await engine.flushFile(fileId);
    expect(okResult.ok).toBe(true);
    expect(events).toEqual([
      { fileId, event: 'failed' },
      { fileId, event: 'recovered' },
    ]);
  });
});
