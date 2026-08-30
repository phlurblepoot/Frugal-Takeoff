// server/mail/sync/engine.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../../db';
import { runMigrations } from '../../migrations';
import { migrations } from '../../migrationList';
import { MailCrypto } from '../crypto';
import * as accounts from '../accountStore';
import { FakeMailProvider } from '../providers/fake';
import type { MailContext } from '../context';
import type { Envelope } from '../providers/types';
import { upsertFolders, upsertEnvelopes, runBackfill, runIncremental, registerInboundHook, clearInboundHooks, removeMessages } from './engine';

let db: Database.Database; let ctx: MailContext; let acct: accounts.MailAccountRow; let provider: FakeMailProvider; let events: any[];
const crypto = new MailCrypto(Buffer.alloc(32, 9));
const env = (id: string, o: Partial<Envelope> = {}): Envelope => ({ providerMessageId: id, references: [], from: { addr: 'gc@teg.com', name: 'Mike' }, to: [{ addr: 'me@bb.com' }], cc: [], bcc: [],
  subject: 'Re: CO 4', snippet: 'ok', date: '2026-08-10T10:00:00.000Z', isRead: false, isStarred: false, isDraft: false, attachments: [], sizeBytes: 10, folderProviderIds: ['INBOX'], messageIdHeader: id + '@teg.com', ...o });

beforeEach(() => {
  db = openDb(':memory:'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-se-'));
  runMigrations(db, dir, migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','a','x','admin')`).run();
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'me@bb.com', auth: { refreshToken: 'r' }, indexedSince: '2026-06-01T00:00:00.000Z' });
  provider = new FakeMailProvider(); provider.seed([]);
  events = [];
  ctx = { db, dataDir: dir, crypto, providerFactory: () => provider, broadcastChange: e => events.push(e) };
  clearInboundHooks();
});

describe('engine', () => {
  it('upsertFolders maps provider ids to local ids and is idempotent', () => {
    const m1 = upsertFolders(db, acct.id, [{ providerId: 'INBOX', name: 'Inbox', role: 'inbox' }]);
    const m2 = upsertFolders(db, acct.id, [{ providerId: 'INBOX', name: 'Inbox!', role: 'inbox' }]);
    expect(m1.get('INBOX')).toBe(m2.get('INBOX'));
    expect(db.prepare('SELECT name FROM mail_folders').get()).toEqual({ name: 'Inbox!' });
  });
  it('indexes envelopes into one thread via References and rolls up the thread row', () => {
    upsertFolders(db, acct.id, provider.folders);
    upsertEnvelopes(ctx, acct, [env('a', { messageIdHeader: 'root@bb.com', from: { addr: 'me@bb.com' }, isRead: true, date: '2026-08-01T00:00:00.000Z' }),
      env('b', { references: ['root@bb.com'], inReplyTo: 'root@bb.com', attachments: [{ attId: 'x', name: 'f.pdf', mime: 'application/pdf', size: 3 }] })]);
    const t = db.prepare('SELECT * FROM mail_threads').all() as any[];
    expect(t.length).toBe(1);
    expect(t[0]).toMatchObject({ threadKey: 'root@bb.com', messageCount: 2, unreadCount: 1, hasAttachments: 1, subject: 'CO 4', firstDate: '2026-08-01T00:00:00.000Z', lastDate: '2026-08-10T10:00:00.000Z' });
    expect(JSON.parse(t[0].participantsJson).map((p: any) => p.addr).sort()).toEqual(['gc@teg.com', 'me@bb.com']);
    expect(events.filter(e => e.type === 'mailThread').map(e => e.id)).toEqual(['root@bb.com']);
  });
  it('merges keys when the root arrives after the child', () => {
    upsertEnvelopes(ctx, acct, [env('child', { references: ['root@bb.com'] })]);
    expect((db.prepare('SELECT threadKey FROM mail_messages').get() as any).threadKey).toBe('root@bb.com');
    upsertEnvelopes(ctx, acct, [env('root', { messageIdHeader: 'root@bb.com', date: '2026-08-01T00:00:00.000Z' })]);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_threads').get()).toEqual({ c: 1 });
    expect(db.prepare(`SELECT COUNT(*) c FROM mail_messages WHERE threadKey='root@bb.com'`).get()).toEqual({ c: 2 });
  });
  it('bridges a mid-chain orphan when the true root arrives after both branches', () => {
    // child only has In-Reply-To=x (no References) → provisionally keyed 'x@bb.com'.
    upsertEnvelopes(ctx, acct, [env('child', { inReplyTo: 'x@bb.com', references: [] })]);
    // mid references [r, x] but neither exists yet as a messageIdHeader → falls back to refs[0]='r@bb.com',
    // and must bridge the orphan group keyed 'x@bb.com' into 'r@bb.com' via the In-Reply-To/References candidate scan.
    upsertEnvelopes(ctx, acct, [env('mid2', { references: ['r@bb.com', 'x@bb.com'] })]);
    // the true root finally arrives with its own id = r@bb.com.
    upsertEnvelopes(ctx, acct, [env('root3', { messageIdHeader: 'r@bb.com', date: '2026-08-01T00:00:00.000Z' })]);
    const threads = db.prepare('SELECT * FROM mail_threads').all() as any[];
    expect(threads.length).toBe(1);
    expect(threads[0]).toMatchObject({ threadKey: 'r@bb.com', messageCount: 3 });
    expect(db.prepare(`SELECT COUNT(*) c FROM mail_messages WHERE threadKey='r@bb.com'`).get()).toEqual({ c: 3 });
  });
  it('merges two independently-keyed groups when a later message references both', () => {
    upsertEnvelopes(ctx, acct, [env('a', { references: ['x@bb.com'] })]);
    upsertEnvelopes(ctx, acct, [env('b', { references: ['r@bb.com'] })]);
    upsertEnvelopes(ctx, acct, [env('c', { references: ['r@bb.com', 'x@bb.com'] })]);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_threads').get()).toEqual({ c: 1 });
    expect(db.prepare(`SELECT COUNT(*) c FROM mail_messages WHERE threadKey='r@bb.com'`).get()).toEqual({ c: 3 });
  });
  it('re-upserting the same provider id updates flags instead of duplicating', () => {
    upsertEnvelopes(ctx, acct, [env('a')]);
    upsertEnvelopes(ctx, acct, [env('a', { isRead: true, isStarred: true })]);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT isRead, isStarred FROM mail_messages').get()).toEqual({ isRead: 1, isStarred: 1 });
    expect(db.prepare('SELECT unreadCount FROM mail_threads').get()).toEqual({ unreadCount: 0 });
  });
  it('writes reply-state and fires inbound hooks only for linked threads', () => {
    const seen: string[] = [];
    registerInboundHook((_c, ev) => seen.push(ev.threadKey));
    db.prepare(`INSERT INTO mail_thread_links (id, threadKey, itemType, itemId, linkedByUserId, createdAt) VALUES ('l','linked@bb.com','rfi','r1','u1','t')`).run();
    upsertEnvelopes(ctx, acct, [env('x', { references: ['linked@bb.com'] }), env('y', { messageIdHeader: 'other@bb.com' })]);
    expect(seen).toEqual(['linked@bb.com']);
    expect(db.prepare(`SELECT lastInboundDate FROM mail_thread_reply_state WHERE threadKey='linked@bb.com'`).get()).toEqual({ lastInboundDate: '2026-08-10T10:00:00.000Z' });
    expect(db.prepare(`SELECT COUNT(*) c FROM mail_thread_reply_state WHERE threadKey='other@bb.com'`).get()).toEqual({ c: 0 });
  });
  it('outbound (own address) messages update lastOutboundDate, not inbound', () => {
    db.prepare(`INSERT INTO mail_thread_links (id, threadKey, itemType, itemId, linkedByUserId, createdAt) VALUES ('l','k@bb.com','rfi','r1','u1','t')`).run();
    upsertEnvelopes(ctx, acct, [env('o', { messageIdHeader: 'k@bb.com', from: { addr: 'me@bb.com' } })]);
    expect(db.prepare(`SELECT lastInboundDate, lastOutboundDate FROM mail_thread_reply_state WHERE threadKey='k@bb.com'`).get()).toEqual({ lastInboundDate: null, lastOutboundDate: '2026-08-10T10:00:00.000Z' });
  });
  it('runBackfill honours indexedSince, folders, status transitions', async () => {
    provider.seed([env('old', { date: '2026-01-01T00:00:00.000Z' }), env('new')]);
    await runBackfill(ctx, acct, provider);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM mail_folders').get()).toEqual({ c: 5 });
    const a = accounts.getAccountAny(db, acct.id)!; expect(a.status).toBe('ok'); expect(a.lastSyncAt).toBeTruthy();
    expect(events.some(e => e.type === 'mailAccount' && e.id === acct.id)).toBe(true);
  });
  it('runIncremental applies upserts/deletes and persists state', async () => {
    await runBackfill(ctx, acct, provider);
    provider.injectInbound(env('n1'));
    await runIncremental(ctx, acct, provider);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    expect(JSON.parse(accounts.getAccountAny(db, acct.id)!.syncState!)).toEqual({ cursor: 1 });
    removeMessages(ctx, acct, ['n1']);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM mail_threads').get()).toEqual({ c: 0 });
  });
});
