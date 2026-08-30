// server/mail/sync/scheduler.ts  (spec §4.2 freshness table; providers push via pokeAccount)
import type { MailContext } from '../context';
import * as accounts from '../accountStore';
import type { MailProvider } from '../providers/types';
import { AuthExpiredError } from '../providers/types';
import { runBackfill, runIncremental } from './engine';

interface Worker { accountId: string; provider: MailProvider; timer: NodeJS.Timeout | null; failures: number; running: Promise<void> | null; stopped: boolean }

export class MailScheduler {
  private workers = new Map<string, Worker>();
  private providers = new Map<string, MailProvider>();
  private viewedAt = new Map<string, number>();
  private readonly fastMs: number; private readonly slowMs: number; private readonly backoffMaxMs: number; private readonly now: () => number;
  constructor(private ctx: MailContext, opts: { fastMs?: number; slowMs?: number; backoffMaxMs?: number; now?: () => number } = {}) {
    this.fastMs = opts.fastMs ?? 30_000; this.slowMs = opts.slowMs ?? 300_000; this.backoffMaxMs = opts.backoffMaxMs ?? 600_000; this.now = opts.now ?? (() => Date.now());
  }
  start(): void { for (const a of accounts.listActiveAccounts(this.ctx.db)) this.startAccount(a.id); }
  async stop(): Promise<void> { for (const id of [...this.workers.keys()]) this.stopAccount(id); await Promise.all([...this.workers.values()].map(w => w.running ?? Promise.resolve())); }
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
    const w: Worker = { accountId, provider: this.getProvider(accountId), timer: null, failures: 0, running: null, stopped: false };
    this.workers.set(accountId, w);
    void this.tick(w, true);
  }
  stopAccount(accountId: string): void {
    const w = this.workers.get(accountId); if (!w) return;
    w.stopped = true; if (w.timer) clearTimeout(w.timer); w.timer = null;
    this.workers.delete(accountId);
  }
  pokeAccount(accountId: string): void { const w = this.workers.get(accountId); if (w && !w.running) { if (w.timer) clearTimeout(w.timer); void this.tick(w, false); } }
  private schedule(w: Worker): void {
    if (w.stopped) return;
    const viewed = (this.now() - (this.viewedAt.get(w.accountId) ?? -Infinity)) < 60_000;
    let delay = viewed ? this.fastMs : this.slowMs;
    if (w.failures) delay = Math.min(this.backoffMaxMs, delay * 2 ** w.failures) * (0.8 + Math.random() * 0.4);
    w.timer = setTimeout(() => void this.tick(w, false), delay);
  }
  private async tick(w: Worker, first: boolean): Promise<void> {
    if (w.stopped || w.running) return;
    w.running = (async () => {
      const account = accounts.getAccountAny(this.ctx.db, w.accountId);
      if (!account) { this.stopAccount(w.accountId); return; }
      try {
        if (first && !account.syncState) await runBackfill(this.ctx, account, w.provider); else await runIncremental(this.ctx, account, w.provider);
        w.failures = 0;
      } catch (e) {
        if (e instanceof AuthExpiredError) { this.stopAccount(w.accountId); this.providers.delete(w.accountId); return; }
        w.failures = Math.min(w.failures + 1, 6);
        console.error(`[mail] sync failed for ${w.accountId}:`, (e as Error).message);
      }
    })();
    try { await w.running; } finally { w.running = null; this.schedule(w); }
  }
}
