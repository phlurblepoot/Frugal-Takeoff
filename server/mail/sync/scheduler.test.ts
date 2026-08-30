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
  it('getProvider creates a provider for an account without a worker', () => {
    const s = new MailScheduler(ctx);
    expect(s.getProvider(acct.id)).toBe(provider);
  });
});
