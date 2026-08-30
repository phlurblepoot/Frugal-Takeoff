// server/mail/sync/scheduler.ts  (spec §4.2 freshness table; providers push via pokeAccount)
// Single-process assumption: workers, providers, and viewed/draining state all live in this
// process's memory. Running more than one server process against the same DB would double-sync.
import type { MailContext } from '../context';
import * as accounts from '../accountStore';
import type { MailProvider } from '../providers/types';
import { AuthExpiredError } from '../providers/types';
import { runBackfill, runIncremental } from './engine';

interface Worker {
  accountId: string; provider: MailProvider; timer: NodeJS.Timeout | null; failures: number;
  running: Promise<void> | null; stopped: boolean; pokeRequested: boolean;
}

export class MailScheduler {
  private workers = new Map<string, Worker>();
  private providers = new Map<string, MailProvider>();
  private viewedAt = new Map<string, number>();
  // Tracks a just-stopped worker's still-in-flight tick, keyed by accountId, so a rapid
  // stopAccount()+startAccount() for the same account doesn't run two ticks concurrently.
  private draining = new Map<string, Promise<void>>();
  private readonly fastMs: number; private readonly slowMs: number; private readonly backoffMaxMs: number; private readonly now: () => number;
  constructor(private ctx: MailContext, opts: { fastMs?: number; slowMs?: number; backoffMaxMs?: number; now?: () => number } = {}) {
    this.fastMs = opts.fastMs ?? 30_000; this.slowMs = opts.slowMs ?? 300_000; this.backoffMaxMs = opts.backoffMaxMs ?? 600_000; this.now = opts.now ?? (() => Date.now());
  }
  start(): void { for (const a of accounts.listActiveAccounts(this.ctx.db)) this.startAccount(a.id); }
  async stop(): Promise<void> { for (const id of [...this.workers.keys()]) this.stopAccount(id); await Promise.all([...this.workers.values()].map(w => w.running ?? Promise.resolve())); await Promise.all([...this.draining.values()]); }
  isRunning(accountId: string): boolean { const w = this.workers.get(accountId); return !!w && !w.stopped; }
  markViewed(accountIds: string[]): void {
    accountIds.forEach(id => {
      this.viewedAt.set(id, this.now());
      // A view mid-cycle should shorten an already-scheduled slow-interval
      // wait down to the fast interval, not wait out the stale delay.
      const w = this.workers.get(id);
      if (w && w.timer && !w.running) { clearTimeout(w.timer); this.schedule(w); }
    });
  }
  getProvider(accountId: string): MailProvider {
    let p = this.providers.get(accountId);
    if (!p) {
      const account = accounts.getAccountAny(this.ctx.db, accountId); if (!account) throw new Error('Account not found');
      const auth = accounts.readAuth(this.ctx.db, this.ctx.crypto, accountId)!;
      p = this.ctx.providerFactory(account, auth); this.providers.set(accountId, p);
    }
    return p;
  }
  dropProvider(accountId: string): void { this.providers.delete(accountId); }
  startAccount(accountId: string): void {
    if (this.workers.has(accountId)) return;
    const w: Worker = { accountId, provider: this.getProvider(accountId), timer: null, failures: 0, running: null, stopped: false, pokeRequested: false };
    this.workers.set(accountId, w);
    const prevDrain = this.draining.get(accountId);
    if (prevDrain) void prevDrain.then(() => { if (!w.stopped) void this.tick(w); });
    else void this.tick(w);
  }
  stopAccount(accountId: string): void {
    const w = this.workers.get(accountId); if (!w) return;
    w.stopped = true; if (w.timer) clearTimeout(w.timer); w.timer = null;
    this.workers.delete(accountId);
    if (w.running) {
      const p = w.running;
      this.draining.set(accountId, p);
      void p.finally(() => { if (this.draining.get(accountId) === p) this.draining.delete(accountId); });
    }
  }
  pokeAccount(accountId: string): void {
    const w = this.workers.get(accountId); if (!w) return;
    if (w.running) { w.pokeRequested = true; return; }   // queue: run again as soon as the in-flight tick finishes
    if (w.timer) clearTimeout(w.timer);
    void this.tick(w);
  }
  private schedule(w: Worker): void {
    if (w.stopped) return;
    const viewed = (this.now() - (this.viewedAt.get(w.accountId) ?? -Infinity)) < 60_000;
    const base = viewed ? this.fastMs : this.slowMs;
    // Clamp AFTER jitter, not before — otherwise a maxed-out failure count can still push the
    // delay up to backoffMaxMs * 1.2.
    const delay = w.failures ? Math.min(this.backoffMaxMs, base * 2 ** w.failures * (0.8 + Math.random() * 0.4)) : base;
    w.timer = setTimeout(() => void this.tick(w), delay);
  }
  private async tick(w: Worker): Promise<void> {
    if (w.stopped || w.running) return;
    w.running = (async () => {
      try {
        const account = accounts.getAccountAny(this.ctx.db, w.accountId);
        if (!account) { this.stopAccount(w.accountId); return; }
        // Gate on the DB's own syncState every tick (not just the worker's first tick) so a
        // transient backfill failure gets retried on the next tick instead of silently falling
        // through to runIncremental against a null syncState forever.
        if (!account.syncState) await runBackfill(this.ctx, account, w.provider); else await runIncremental(this.ctx, account, w.provider);
        w.failures = 0;
      } catch (e) {
        if (e instanceof AuthExpiredError) { this.stopAccount(w.accountId); this.providers.delete(w.accountId); return; }
        w.failures = Math.min(w.failures + 1, 6);
        console.error(`[mail] sync failed for ${w.accountId}:`, (e as Error).message);
      }
    })();   // never rejects: every throwable path above is caught, so `await w.running` below is safe.
    try { await w.running; } finally {
      w.running = null;
      if (w.pokeRequested) { w.pokeRequested = false; void this.tick(w); }
      else this.schedule(w);
    }
  }
}
