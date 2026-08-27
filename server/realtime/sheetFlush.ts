// server/realtime/sheetFlush.ts
//
// Autosave engine for the shared spreadsheet-editing session (WS5 Task 4):
// periodically scans SheetSessionStore for files with a pending (dirty)
// state and folds that state back onto the file's live xlsx bytes on disk,
// via the exceljs<->FortuneSheet bridge (Task 2). The first flush of a given
// editing session additionally snapshots (archives) the pre-session bytes
// as a version, so a session's edits are always recoverable as a unit;
// every flush after that overwrites the live file in place until the next
// session opens (see SheetSessionStore.needsSessionSnapshot/closeSession).
//
// Import-path decision: patchWorkbookFromFortuneSheets lives in
// src/utils/sheetBridge.ts (deliberately isomorphic — the browser editor
// imports it too), not under server/. Precedent for server -> src/ imports
// already exists (server/customerStore.ts imports a TYPE from ../src/types),
// and this app has no separate server build step — package.json's "dev"
// script runs `tsx server.ts` directly and that's also how it runs in
// production, so tsx resolves any .ts file in the repo at runtime regardless
// of directory. A plain relative VALUE import therefore works with no
// bundling/dist-path concerns, so we import directly rather than
// duplicating or relocating the bridge into a new shared/ folder.
//
// Interface note: the task brief's sketched constructor
// (`db, store, opts?`) has no way to reach the file store, which every flush
// needs to read/write bytes — `dataDir` is added as an explicit required
// parameter, matching the convention used throughout files.ts/fileStore.ts
// where dataDir always travels alongside db.

import type Database from 'better-sqlite3';
import type { Sheet as FortuneSheetData } from '@fortune-sheet/core';
import { patchWorkbookFromFortuneSheets } from '../../src/utils/sheetBridge';
import { readFileContent, writeFileContent } from '../fileStore';
import { getMeta, saveNewVersion } from '../files';
import type { SheetSessionStore } from './sheetSessions';

export interface SheetFlushOptions {
  intervalMs?: number;
  // I5: the engine's only way to surface a flush failure/recovery to a
  // user — every failure path below was previously console-only, so the
  // client's autosave chip had no way to ever show "autosave is failing".
  // Deliberately a plain callback (not an `io: Server` dependency) so this
  // module stays decoupled from socket.io and easy to unit-test; server.ts
  // wires it to `io.to(sheetRoom(fileId)).emit(...)`.
  notify?: (fileId: string, event: 'failed' | 'recovered') => void;
}

export interface FlushResult { ok: boolean; error?: string }
export interface SnapshotResult { ok: boolean; version?: number; error?: string }

const DEFAULT_INTERVAL_MS = 15_000;

export class SheetFlushEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  // Per-fileId in-flight guard: flushFile and snapshotNow both read-then-write
  // the same on-disk bytes for a file with an await in between (the bridge
  // patch call), so two concurrent runs for the SAME file can interleave —
  // whichever read the (now-stale) original bytes last would win the write,
  // silently reverting the other run's change with dirty cleared and no
  // retry. This map serializes per-file access: flushFile joins whatever is
  // already running for that id instead of racing it; snapshotNow always
  // waits for anything in-flight to settle first (so its archive captures
  // settled bytes), then performs its own guaranteed archive. See flushFile/
  // snapshotNow below for the exact join rules.
  private inflight = new Map<string, Promise<FlushResult>>();
  // I5: fileIds currently in a failing streak, so a later success can be
  // reported as a "recovered" transition (not just silence).
  private readonly failingFiles = new Set<string>();
  private readonly notify?: (fileId: string, event: 'failed' | 'recovered') => void;

  constructor(
    private db: Database.Database,
    private store: SheetSessionStore,
    private dataDir: string,
    opts: SheetFlushOptions = {}
  ) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.notify = opts.notify;
  }

  private reportFailure(fileId: string): void {
    if (this.failingFiles.has(fileId)) return; // already reported — only the edge fires
    this.failingFiles.add(fileId);
    this.notify?.(fileId, 'failed');
  }

  private reportRecoveryIfNeeded(fileId: string): void {
    if (this.failingFiles.delete(fileId)) this.notify?.(fileId, 'recovered');
  }

  start(): void {
    if (this.timer) return; // already running
    this.timer = setInterval(() => { void this.flushAll(); }, this.intervalMs);
    // unref() so a leaked handle can never keep the process (or vitest) alive
    // — matches the sweepTimer precedent in registerRealtime.ts.
    this.timer?.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Parses the session's current folded state; returns null (bridge left
  // untouched) when there's nothing to parse, or throws with a descriptive
  // message on bad JSON.
  private parseState(fileId: string, stateJson: string): FortuneSheetData[] {
    try {
      return JSON.parse(stateJson) as FortuneSheetData[];
    } catch (e) {
      throw new Error(`bad state JSON for ${fileId}: ${(e as Error).message}`);
    }
  }

  // Public entry point: joins an already-running flush/snapshot for this
  // fileId instead of racing it (see the `inflight` field comment above).
  // Deliberately NOT declared `async` — an async function wraps its return
  // value in a fresh promise even when returning an existing one, which
  // would defeat the join (callers could no longer tell they got the same
  // in-flight run). Returning the stored promise directly keeps it identical.
  flushFile(fileId: string): Promise<FlushResult> {
    const existing = this.inflight.get(fileId);
    if (existing) return existing;

    const run = this.doFlushFile(fileId);
    this.inflight.set(fileId, run);
    const clear = () => {
      if (this.inflight.get(fileId) === run) this.inflight.delete(fileId);
    };
    // NOT `run.finally(clear)`: .finally() re-throws whatever `run` settled
    // with into the promise IT returns, so that derived promise still needs
    // its own rejection handler — `void`-ing it away doesn't attach one, and
    // an unhandled rejection there crashes the process under Node's default
    // --unhandled-rejections=throw even though the caller handles `run` (the
    // one we actually returned) correctly. `.then(clear, clear)` handles
    // both outcomes right here, so the derived promise it returns always
    // fulfills and never needs further handling.
    void run.then(clear, clear);
    return run;
  }

  private async doFlushFile(fileId: string): Promise<FlushResult> {
    // I4/N2: captured BEFORE the await below (patchWorkbookFromFortuneSheets
    // can take hundreds of ms) so markFlushed can compare-and-clear instead
    // of clearing dirty unconditionally after ANY mutation (setState OR
    // appendOps) may have landed mid-flush. Generation, not stateSeq — see
    // SheetSessionStore's generation()/markFlushed comments for why a bare
    // setState (no intervening appendOps) doesn't reliably move stateSeq.
    const flushGeneration = this.store.generation(fileId);
    const stateJson = this.store.getState(fileId);
    if (stateJson === null) {
      // Dirty with no folded state yet means there's nothing to flush (the
      // client hasn't pushed a state-sync) — a dirty flag in that shape is
      // meaningless, so clear it rather than retry-looping forever.
      this.store.markFlushed(fileId, flushGeneration);
      this.reportRecoveryIfNeeded(fileId);
      return { ok: true };
    }

    const meta = getMeta(this.db, fileId);
    if (!meta) {
      const error = `unknown file ${fileId}`;
      console.error(`[sheetFlush] flushFile: ${error}`);
      this.reportFailure(fileId);
      return { ok: false, error };
    }

    const original = readFileContent(this.dataDir, fileId);
    if (!original) {
      const error = `no on-disk content for ${fileId}`;
      console.error(`[sheetFlush] flushFile: ${error}`);
      this.reportFailure(fileId);
      return { ok: false, error };
    }

    let buf: Buffer;
    try {
      const sheets = this.parseState(fileId, stateJson);
      buf = Buffer.from(await patchWorkbookFromFortuneSheets(original, sheets));
    } catch (e) {
      const error = (e as Error).message;
      console.error(`[sheetFlush] flushFile: ${error}`);
      this.reportFailure(fileId);
      return { ok: false, error };
    }

    if (this.store.needsSessionSnapshot(fileId)) {
      saveNewVersion(this.db, this.dataDir, fileId, buf, meta.mime);
      this.store.markSessionSnapshotDone(fileId);
    } else {
      writeFileContent(this.dataDir, fileId, buf);
    }

    this.store.markFlushed(fileId, flushGeneration);
    this.reportRecoveryIfNeeded(fileId);
    return { ok: true };
  }

  // Manual "Snapshot version": forces an immediate archive regardless of
  // needsSessionSnapshot/snapshotDone. Folds in whatever state is pending
  // (same as flushFile); with no pending state, archives the file's current
  // live bytes as-is (a plain checkpoint of what's already saved).
  //
  // Join ordering: unlike flushFile (which joins an in-flight run outright),
  // a snapshot must always perform its OWN archive — joining someone else's
  // result could return a stale/no-op version. So if a flush (or another
  // snapshot) is already running for this fileId, we AWAIT it first (letting
  // its write settle onto disk), then start our own — never overlapping the
  // disk read/write with the other run. We still register ourselves in the
  // same `inflight` map for the duration, so a flushFile call that arrives
  // while we're mid-snapshot joins us instead of racing.
  async snapshotNow(fileId: string): Promise<SnapshotResult> {
    const racingRun = this.inflight.get(fileId);
    if (racingRun) await racingRun;

    const run = this.doSnapshotNow(fileId);
    this.inflight.set(fileId, run);
    const clear = () => {
      if (this.inflight.get(fileId) === run) this.inflight.delete(fileId);
    };
    // See the matching comment in flushFile: `.then(clear, clear)` rather
    // than `.finally(clear)`, so the derived cleanup promise always fulfills
    // and can't become an unhandled rejection.
    void run.then(clear, clear);
    return run;
  }

  private async doSnapshotNow(fileId: string): Promise<SnapshotResult> {
    const meta = getMeta(this.db, fileId);
    if (!meta) {
      const error = `unknown file ${fileId}`;
      console.error(`[sheetFlush] snapshotNow: ${error}`);
      return { ok: false, error };
    }

    const original = readFileContent(this.dataDir, fileId);
    if (!original) {
      const error = `no on-disk content for ${fileId}`;
      console.error(`[sheetFlush] snapshotNow: ${error}`);
      return { ok: false, error };
    }

    // I4/N2: same compare-and-clear reasoning as doFlushFile — captured
    // before the same kind of long-running await below.
    const flushGeneration = this.store.generation(fileId);
    const stateJson = this.store.getState(fileId);
    let buf: Buffer;
    try {
      buf = stateJson === null
        ? Buffer.from(original)
        : Buffer.from(await patchWorkbookFromFortuneSheets(original, this.parseState(fileId, stateJson)));
    } catch (e) {
      const error = (e as Error).message;
      console.error(`[sheetFlush] snapshotNow: ${error}`);
      return { ok: false, error };
    }

    const { versionNumber } = saveNewVersion(this.db, this.dataDir, fileId, buf, meta.mime);
    this.store.markSessionSnapshotDone(fileId);
    if (stateJson !== null) this.store.markFlushed(fileId, flushGeneration);
    return { ok: true, version: versionNumber };
  }

  // For last-leave + shutdown: flush every currently-dirty file. Failures are
  // logged by flushFile itself and left dirty for the next tick/instance —
  // this never throws.
  async flushAll(): Promise<void> {
    for (const fileId of this.store.dirtyFiles()) {
      await this.flushFile(fileId);
    }
  }
}
