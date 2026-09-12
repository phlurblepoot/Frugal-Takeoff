import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { writeSchedule } from './settings';
import { BackupScheduler, nextOccurrence } from './scheduler';
import fs from 'fs'; import os from 'os'; import path from 'path';

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:'); runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-s-')), migrations); });

describe('nextOccurrence', () => {
  it('is today at hh:mm when still ahead, else tomorrow', () => {
    const base = new Date(2026, 8, 12, 1, 0, 0).getTime();
    expect(new Date(nextOccurrence(base, 2, 0)).getHours()).toBe(2);
    expect(nextOccurrence(base, 2, 0) - base).toBe(60 * 60_000);
    const later = new Date(2026, 8, 12, 3, 0, 0).getTime();
    expect(nextOccurrence(later, 2, 0) - later).toBe(23 * 60 * 60_000);
  });
});

describe('BackupScheduler', () => {
  it('does nothing while disabled; when enabled runs local then drive at the configured time and reschedules', async () => {
    let now = new Date(2026, 8, 12, 1, 0, 0).getTime();
    const timers: { fn: () => void; at: number }[] = [];
    const run = vi.fn(async (_t: 'local' | 'drive') => {});
    const s = new BackupScheduler({ db, run, hasDrive: () => true, now: () => now, setTimeout: ((fn: any, ms: number) => { timers.push({ fn, at: now + ms }); return { unref() {} } as any; }) as any, clearTimeout: (() => {}) as any });
    s.start();
    expect(s.nextRunAt()).toBeNull(); expect(timers.length).toBe(1); // a poll timer, not a run
    writeSchedule(db, { enabled: true, hour: 2, minute: 0 });
    await s.tick();
    expect(s.nextRunAt()).toBe(new Date(2026, 8, 12, 2, 0, 0).getTime());
    now = new Date(2026, 8, 12, 2, 0, 1).getTime();
    await s.tick();
    expect(run.mock.calls.map(c => c[0])).toEqual(['local', 'drive']);
    expect(s.nextRunAt()).toBe(new Date(2026, 8, 13, 2, 0, 0).getTime());
  });

  it('skips a tick while a run is in progress, and a failing local run still lets drive run', async () => {
    let now = new Date(2026, 8, 12, 1, 59, 59).getTime();
    writeSchedule(db, { enabled: true, hour: 2, minute: 0 });
    const run = vi.fn(async (t: string) => { if (t === 'local') throw new Error('disk'); });
    const s = new BackupScheduler({ db, run, hasDrive: () => true, now: () => now, setTimeout: (() => ({ unref() {} })) as any, clearTimeout: (() => {}) as any });
    await s.tick(); // sets due = today 02:00, not yet due
    const due = s.nextRunAt();
    expect(due).toBe(new Date(2026, 8, 12, 2, 0, 0).getTime());

    db.prepare(`INSERT INTO backup_runs (id, target, trigger, startedAt, status) VALUES ('x', 'local', 'manual', ?, 'running')`).run(now);
    now = new Date(2026, 8, 12, 2, 0, 1).getTime();
    await s.tick();
    expect(run).not.toHaveBeenCalled();
    expect(s.nextRunAt()).toBe(due); // skipped: due is unchanged, not consumed

    db.prepare('DELETE FROM backup_runs').run();
    await s.tick();
    expect(run.mock.calls.map(c => c[0])).toEqual(['local', 'drive']);
  });

  it('does not fire a catch-up run when first ticked well after the configured time', async () => {
    const now = new Date(2026, 8, 12, 3, 0, 0).getTime();
    writeSchedule(db, { enabled: true, hour: 2, minute: 0 });
    const run = vi.fn(async () => {});
    const s = new BackupScheduler({ db, run, hasDrive: () => true, now: () => now, setTimeout: (() => ({ unref() {} })) as any, clearTimeout: (() => {}) as any });
    s.start();
    await s.tick();
    expect(run).not.toHaveBeenCalled();
    expect(s.nextRunAt()).toBe(new Date(2026, 8, 13, 2, 0, 0).getTime());
  });
});
