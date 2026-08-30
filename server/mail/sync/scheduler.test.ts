import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { openDb } from '../../db'; import { runMigrations } from '../../migrations'; import { migrations } from '../../migrationList';
import { MailCrypto } from '../crypto'; import * as accounts from '../accountStore';
import { FakeMailProvider } from '../providers/fake'; import { AuthExpiredError } from '../providers/types';
import { MailScheduler } from './scheduler';
import type { MailContext } from '../context';

const crypto = new MailCrypto(Buffer.alloc(32, 4));
let ctx: MailContext; let provider: FakeMailProvider; let acct: accounts.MailAccountRow;
const env = (id: string) => ({ providerMessageId: id, references: [], from: { addr: 'x@y' }, to: [], cc: [], bcc: [], subject: 's', snippet: '', date: new Date().toISOString(), isRead: false, isStarred: false, isDraft: false, attachments: [], sizeBytes: 1, folderProviderIds: ['INBOX'], messageIdHeader: id + '@y' });
beforeEach(() => {
  const db = openDb(':memory:'); runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sc-')), migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','a','x','admin')`).run();
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'me@bb.com', auth: { refreshToken: 'r' } });
  provider = new FakeMailProvider(); provider.seed([env('seeded')]);
  ctx = { db, dataDir: '', crypto, providerFactory: () => provider, broadcastChange: () => {} };
});

describe('MailScheduler', () => {
  it('backfills on start, then polls incrementally on the slow timer', async () => {
    vi.useFakeTimers();
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    provider.injectInbound(env('later'));
    await vi.advanceTimersByTimeAsync(5001);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 2 });
    await s.stop(); vi.useRealTimers();
  });
  it('uses the fast timer while viewed and poke runs immediately', async () => {
    vi.useFakeTimers();
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    s.markViewed([acct.id]); provider.injectInbound(env('fast'));
    await vi.advanceTimersByTimeAsync(1001);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 2 });
    provider.injectInbound(env('poked')); s.pokeAccount(acct.id); await vi.runOnlyPendingTimersAsync();
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 3 });
    await s.stop(); vi.useRealTimers();
  });
  it('stops the worker and flags auth_error on AuthExpiredError', async () => {
    vi.useFakeTimers();
    provider.failNextWith(new AuthExpiredError('expired'));
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    expect(accounts.getAccountAny(ctx.db, acct.id)!.status).toBe('auth_error');
    expect(s.isRunning(acct.id)).toBe(false);
    await s.stop(); vi.useRealTimers();
  });
  it('start() survives an account whose provider cannot be built: it is parked in auth_error, the rest still sync', async () => {
    vi.useFakeTimers();
    const events: { type: string; id: string }[] = [];
    ctx.broadcastChange = ev => { events.push(ev as { type: string; id: string }); };
    const bad = accounts.createAccount(ctx.db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'bad@bb.com', auth: { refreshToken: 'r' } });
    ctx.providerFactory = (a) => { if (a.id === bad.id) throw new Error('auth blob unreadable'); return provider; };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    expect(() => s.start()).not.toThrow();
    await vi.runOnlyPendingTimersAsync();
    const parked = accounts.getAccountAny(ctx.db, bad.id)!;
    expect(parked.status).toBe('auth_error');
    expect(parked.lastError).toBe('auth blob unreadable');
    expect(s.isRunning(bad.id)).toBe(false);
    expect(events.some(e => e.type === 'mailAccount' && e.id === bad.id)).toBe(true);
    // the healthy account's worker still ran its backfill
    expect(s.isRunning(acct.id)).toBe(true);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    errSpy.mockRestore();
    await s.stop(); vi.useRealTimers();
  });
  it('getProvider creates a provider for an account without a worker', () => {
    const s = new MailScheduler(ctx);
    expect(s.getProvider(acct.id)).toBe(provider);
  });
  it('clamps the backoff delay after applying jitter, never scheduling past backoffMaxMs', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);   // worst-case jitter multiplier: 1.2x
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    provider.listFolders = async () => { throw new Error('listFolders down'); };   // fails every backfill attempt
    // slowMs alone (1000) already exceeds backoffMaxMs (100) once doubled for a single failure,
    // so a pre-jitter clamp (buggy) would yield 100 * 1.2 = 120; a post-jitter clamp caps at 100.
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 1000, backoffMaxMs: 100 });
    s.start();
    await vi.runOnlyPendingTimersAsync();
    const delays = setTimeoutSpy.mock.calls.map(c => c[1] as number).filter((d): d is number => typeof d === 'number');
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(100);
    await s.stop();
    randomSpy.mockRestore(); setTimeoutSpy.mockRestore(); vi.useRealTimers();
  });
  it('retries backfill on the next tick after a transient failure, instead of switching to incremental against a null syncState', async () => {
    vi.useFakeTimers();
    provider.failNextWith(new Error('net blip'));
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 1000, backoffMaxMs: 5000 });
    s.start();
    // Settle only the microtask-only first attempt (no macrotask boundary needed for it to fail),
    // without also racing ahead into the just-scheduled retry timer.
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 0 });
    expect(accounts.getAccountAny(ctx.db, acct.id)!.syncState).toBeNull();
    await vi.advanceTimersByTimeAsync(2500);   // past the single-failure backoff (max 1000*2*1.2 = 2400ms)
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    expect(accounts.getAccountAny(ctx.db, acct.id)!.syncState).not.toBeNull();
    await s.stop(); vi.useRealTimers();
  });
  it('an account deleted between ticks stops the worker without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 1000 });
    s.start();
    await vi.runOnlyPendingTimersAsync();   // first backfill completes successfully
    expect(s.isRunning(acct.id)).toBe(true);
    accounts.deleteAccount(ctx.db, acct.id);   // account vanishes before the next tick's DB read
    await vi.advanceTimersByTimeAsync(1001);
    expect(s.isRunning(acct.id)).toBe(false);
    await s.stop(); vi.useRealTimers();
  });
  it('pokeAccount mid-tick queues a re-run instead of dropping it, and does not start a second concurrent tick', async () => {
    vi.useFakeTimers();
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });

    let resolveDeferred: () => void = () => {};
    const deferred = new Promise<void>(res => { resolveDeferred = res; });
    const origIncremental = provider.incremental.bind(provider);
    let calls = 0;
    provider.incremental = async (state: any) => {
      calls++;
      if (calls === 1) await deferred;
      return origIncremental(state);
    };

    provider.injectInbound(env('during'));
    s.pokeAccount(acct.id);                 // starts tick #2, blocks inside incremental on `deferred`
    expect(calls).toBe(1);
    provider.injectInbound(env('after'));
    s.pokeAccount(acct.id);                 // mid-tick poke: must queue, not start a second concurrent call
    expect(calls).toBe(1);

    resolveDeferred();
    await vi.advanceTimersByTimeAsync(0);   // settle the queued re-run's microtask chain without also firing the next real poll timer
    expect(calls).toBe(2);                  // the queued poke ran once tick #2 finished
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 3 });
    await s.stop(); vi.useRealTimers();
  });
});
