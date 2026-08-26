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

export interface SheetFlushOptions { intervalMs?: number }

export interface FlushResult { ok: boolean; error?: string }
export interface SnapshotResult { ok: boolean; version?: number; error?: string }

const DEFAULT_INTERVAL_MS = 15_000;

export class SheetFlushEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;

  constructor(
    private db: Database.Database,
    private store: SheetSessionStore,
    private dataDir: string,
    opts: SheetFlushOptions = {}
  ) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
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

  async flushFile(fileId: string): Promise<FlushResult> {
    const stateJson = this.store.getState(fileId);
    if (stateJson === null) {
      // Dirty with no folded state yet means there's nothing to flush (the
      // client hasn't pushed a state-sync) — a dirty flag in that shape is
      // meaningless, so clear it rather than retry-looping forever.
      this.store.markFlushed(fileId);
      return { ok: true };
    }

    const meta = getMeta(this.db, fileId);
    if (!meta) {
      const error = `unknown file ${fileId}`;
      console.error(`[sheetFlush] flushFile: ${error}`);
      return { ok: false, error };
    }

    const original = readFileContent(this.dataDir, fileId);
    if (!original) {
      const error = `no on-disk content for ${fileId}`;
      console.error(`[sheetFlush] flushFile: ${error}`);
      return { ok: false, error };
    }

    let buf: Buffer;
    try {
      const sheets = this.parseState(fileId, stateJson);
      buf = Buffer.from(await patchWorkbookFromFortuneSheets(original, sheets));
    } catch (e) {
      const error = (e as Error).message;
      console.error(`[sheetFlush] flushFile: ${error}`);
      return { ok: false, error };
    }

    if (this.store.needsSessionSnapshot(fileId)) {
      saveNewVersion(this.db, this.dataDir, fileId, buf, meta.mime);
      this.store.markSessionSnapshotDone(fileId);
    } else {
      writeFileContent(this.dataDir, fileId, buf);
    }

    this.store.markFlushed(fileId);
    return { ok: true };
  }

  // Manual "Snapshot version": forces an immediate archive regardless of
  // needsSessionSnapshot/snapshotDone. Folds in whatever state is pending
  // (same as flushFile); with no pending state, archives the file's current
  // live bytes as-is (a plain checkpoint of what's already saved).
  async snapshotNow(fileId: string): Promise<SnapshotResult> {
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
    if (stateJson !== null) this.store.markFlushed(fileId);
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
