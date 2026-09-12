// server/backup/scheduler.ts — daily backups (spec §Scheduler). Polls the
// schedule setting each minute so a settings change needs no restart.
import type Database from 'better-sqlite3';
import { readSchedule } from './settings';
import { isRunActive } from './snapshot';

export function nextOccurrence(now: number, hour: number, minute: number): number {
  const d = new Date(now); d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export interface SchedulerDeps {
  db: Database.Database;
  run: (target: 'local' | 'drive', trigger: 'schedule') => Promise<unknown>;
  hasDrive: () => boolean;
  now?: () => number; setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout;
}
const POLL_MS = 60_000;

export class BackupScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private due: number | null = null;
  private lastFired: number | null = null;
  private readonly now: () => number;
  constructor(private deps: SchedulerDeps) { this.now = deps.now ?? (() => Date.now()); }

  nextRunAt(): number | null { return this.due; }

  start(): void { this.arm(); }
  stop(): void { if (this.timer) (this.deps.clearTimeout ?? clearTimeout)(this.timer); this.timer = null; }
  private arm(): void {
    const st = this.deps.setTimeout ?? setTimeout;
    this.timer = st(() => { this.tick().catch(e => console.error('[backup] scheduler tick failed', e)); }, POLL_MS);
    (this.timer as any).unref?.();
  }

  async tick(): Promise<void> {
    try {
      const s = readSchedule(this.deps.db);
      if (!s.enabled) { this.due = null; return; }
      const now = this.now();
      if (this.due === null || (this.lastFired !== null && this.due <= this.lastFired)) this.due = nextOccurrence(now, s.hour, s.minute);
      // schedule changed → recompute
      const expected = nextOccurrence(this.due - 1, s.hour, s.minute);
      if (expected !== this.due) this.due = nextOccurrence(now, s.hour, s.minute);
      if (now < this.due) return;
      if (isRunActive(this.deps.db, 'local') || isRunActive(this.deps.db, 'drive')) { console.warn('[backup] scheduled run skipped: a backup is still in progress'); return; }
      this.lastFired = now;
      this.due = nextOccurrence(now, s.hour, s.minute);
      try { await this.deps.run('local', 'schedule'); } catch (e) { console.error('[backup] scheduled local backup failed', e); }
      if (this.deps.hasDrive()) { try { await this.deps.run('drive', 'schedule'); } catch (e) { console.error('[backup] scheduled Drive backup failed', e); } }
    } finally { this.arm(); }
  }
}
