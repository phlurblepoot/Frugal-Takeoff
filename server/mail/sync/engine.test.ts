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
import type { Envelope, MailProvider, SyncState } from '../providers/types';
import { upsertFolders, upsertEnvelopes, runBackfill, runIncremental, registerInboundHook, clearInboundHooks, removeMessages, sweepSentPlaceholders } from './engine';

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
  it('re-keys a sent: placeholder when the provider finally reports the real sent message', () => {
    // Graph cannot tell us the id of what it sent, so a send whose Sent Items
    // read-back came up empty indexes under "sent:<our Message-ID>".
    upsertEnvelopes(ctx, acct, [env('sent:out-1@bb.com', { messageIdHeader: 'out-1@bb.com', from: { addr: 'me@bb.com' }, isRead: true, folderProviderIds: ['SENT'] })], { sentFromApp: true });
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });

    // The next delta pass finds the same message under its real provider id.
    upsertEnvelopes(ctx, acct, [env('AAMkRealSentId', { messageIdHeader: 'out-1@bb.com', from: { addr: 'me@bb.com' }, isRead: true, folderProviderIds: ['SENT'] })]);
    expect(db.prepare('SELECT providerMessageId, sentFromApp FROM mail_messages').all())
      .toEqual([{ providerMessageId: 'AAMkRealSentId', sentFromApp: 1 }]);   // re-keyed, not duplicated
    expect(db.prepare('SELECT COUNT(*) c FROM mail_threads').get()).toEqual({ c: 1 });
  });
  it('re-keys the placeholder the provider names, even though the provider rewrote the Message-ID', () => {
    upsertEnvelopes(ctx, acct, [env('sent:out-2@bb.com', { messageIdHeader: 'out-2@bb.com', from: { addr: 'me@bb.com' }, isRead: true })], { sentFromApp: true });
    // Graph stamped its own Message-ID on the wire, so nothing about the real
    // envelope's header matches the row we wrote — only the id it names does.
    upsertEnvelopes(ctx, acct, [env('AAMkGraphId', { messageIdHeader: 'rewritten@outlook.com', from: { addr: 'me@bb.com' }, isRead: true, replacesProviderMessageId: 'sent:out-2@bb.com' })]);
    expect(db.prepare('SELECT providerMessageId, messageIdHeader, sentFromApp FROM mail_messages').all())
      .toEqual([{ providerMessageId: 'AAMkGraphId', messageIdHeader: 'rewritten@outlook.com', sentFromApp: 1 }]);
  });
  it('ignores replacesProviderMessageId when it does not name a sent: placeholder', () => {
    upsertEnvelopes(ctx, acct, [env('real-a', { messageIdHeader: 'a@bb.com' })]);
    upsertEnvelopes(ctx, acct, [env('real-b', { messageIdHeader: 'b@bb.com', replacesProviderMessageId: 'real-a' })]);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 2 });
  });
  it('threads two headerless messages by the provider conversation they share', () => {
    // A Microsoft 365 tenant that omits internetMessageHeaders from its delta
    // projection gives us nothing but the conversationId to thread on.
    upsertEnvelopes(ctx, acct, [env('g1', { messageIdHeader: undefined, providerThreadId: 'CONV-1', date: '2026-08-10T10:00:00.000Z' })]);
    upsertEnvelopes(ctx, acct, [env('g2', { messageIdHeader: undefined, providerThreadId: 'CONV-1', date: '2026-08-10T11:00:00.000Z' })]);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_threads').get()).toEqual({ c: 1 });
    expect((db.prepare('SELECT messageCount FROM mail_threads').get() as any).messageCount).toBe(2);
    // A different conversation stays its own thread.
    upsertEnvelopes(ctx, acct, [env('g3', { messageIdHeader: undefined, providerThreadId: 'CONV-2' })]);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_threads').get()).toEqual({ c: 2 });
  });
  it('a message WITH headers still threads on the header chain, not the conversation', () => {
    upsertEnvelopes(ctx, acct, [env('h1', { messageIdHeader: 'root@bb.com', providerThreadId: 'CONV-A' })]);
    // Same conversation, but its References name the root — the header wins,
    // and the two agree here anyway. The point is the key is the header's.
    upsertEnvelopes(ctx, acct, [env('h2', { messageIdHeader: 'child@bb.com', references: ['root@bb.com'], providerThreadId: 'CONV-A' })]);
    expect(db.prepare('SELECT DISTINCT threadKey FROM mail_messages').all()).toEqual([{ threadKey: 'root@bb.com' }]);
  });
  it('re-keys a sent: placeholder that the provider could not name, by conversation and by subject+time', () => {
    upsertFolders(db, acct.id, [{ providerId: 'SENT', name: 'Sent', role: 'sent' }]);
    const mine = { from: { addr: 'me@bb.com' }, isRead: true, folderProviderIds: ['SENT'] };
    // A Graph REPLY carries no correlation header, so the real copy names nothing.
    upsertEnvelopes(ctx, acct, [env('sent:c-1@bb.com', { ...mine, messageIdHeader: 'c-1@bb.com', providerThreadId: 'CONV-R' })], { sentFromApp: true });
    upsertEnvelopes(ctx, acct, [env('AAMkByConv', { ...mine, messageIdHeader: 'graph-1@outlook.com', providerThreadId: 'CONV-R' })]);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    expect((db.prepare('SELECT providerMessageId FROM mail_messages').get() as any).providerMessageId).toBe('AAMkByConv');

    // No conversation to match on either: same subject, minutes apart.
    upsertEnvelopes(ctx, acct, [env('sent:c-2@bb.com', { ...mine, messageIdHeader: 'c-2@bb.com', subject: 'Change Order 9', date: '2026-08-10T10:00:00.000Z' })], { sentFromApp: true });
    upsertEnvelopes(ctx, acct, [env('AAMkBySubject', { ...mine, messageIdHeader: 'graph-2@outlook.com', subject: 'Change Order 9', date: '2026-08-10T10:02:00.000Z' })]);
    expect(db.prepare(`SELECT COUNT(*) c FROM mail_messages WHERE providerMessageId LIKE 'sent:%'`).get()).toEqual({ c: 0 });
  });
  it('never re-keys a placeholder onto an INBOUND message that merely shares the subject', () => {
    upsertFolders(db, acct.id, [{ providerId: 'SENT', name: 'Sent', role: 'sent' }, { providerId: 'INBOX', name: 'Inbox', role: 'inbox' }]);
    upsertEnvelopes(ctx, acct, [env('sent:c-3@bb.com', { from: { addr: 'me@bb.com' }, messageIdHeader: 'c-3@bb.com', subject: 'Change Order 9', date: '2026-08-10T10:00:00.000Z', folderProviderIds: ['SENT'] })], { sentFromApp: true });
    // normalizeSubject strips "Re:", so this reply looks identical by subject
    // and lands two minutes later — matching it would destroy the sent row.
    upsertEnvelopes(ctx, acct, [env('inbound-1', { from: { addr: 'gc@teg.com' }, messageIdHeader: 'reply@teg.com', subject: 'Re: Change Order 9', date: '2026-08-10T10:02:00.000Z' })]);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 2 });
    expect(db.prepare(`SELECT COUNT(*) c FROM mail_messages WHERE providerMessageId = 'sent:c-3@bb.com'`).get()).toEqual({ c: 1 });
  });
  it('sweeps a stale placeholder once the real message is in its thread, but never the last copy', () => {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    const mine = { from: { addr: 'me@bb.com' }, isRead: true, references: ['root@bb.com'] };
    // Every reconciliation rule misses this one: the provider named nothing, it
    // rewrote the Message-ID, there is no conversation id, and the real copy
    // only reached the index three hours later — well past the subject window.
    // References still put both rows in the one thread, so the user sees their
    // own sent message twice.
    upsertEnvelopes(ctx, acct, [env('sent:s-1@bb.com', { ...mine, messageIdHeader: 's-1@bb.com', date: '2026-08-10T10:00:00.000Z' })], { sentFromApp: true });
    upsertEnvelopes(ctx, acct, [env('AAMkReal', { ...mine, messageIdHeader: 'graph-s1@outlook.com', date: '2026-08-10T13:00:00.000Z' })]);
    db.prepare(`UPDATE mail_messages SET createdAt = ? WHERE providerMessageId LIKE 'sent:%'`).run(old);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 2 });
    expect(db.prepare('SELECT COUNT(DISTINCT threadKey) c FROM mail_messages').get()).toEqual({ c: 1 });

    expect(sweepSentPlaceholders(ctx, acct)).toBe(1);
    expect(db.prepare('SELECT providerMessageId FROM mail_messages').all()).toEqual([{ providerMessageId: 'AAMkReal' }]);

    // A placeholder that is the ONLY record of the message is kept: a stale row
    // beats the user losing a message they know they sent.
    upsertEnvelopes(ctx, acct, [env('sent:s-2@bb.com', { from: { addr: 'me@bb.com' }, isRead: true, messageIdHeader: 's-2@bb.com' })], { sentFromApp: true });
    db.prepare(`UPDATE mail_messages SET createdAt = ? WHERE providerMessageId = 'sent:s-2@bb.com'`).run(old);
    expect(sweepSentPlaceholders(ctx, acct)).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) c FROM mail_messages WHERE providerMessageId = 'sent:s-2@bb.com'`).get()).toEqual({ c: 1 });
  });
  it('only the sent: placeholder is re-keyed — two real ids sharing a Message-ID stay separate rows', () => {
    upsertEnvelopes(ctx, acct, [env('real-1', { messageIdHeader: 'dup@bb.com' })]);
    upsertEnvelopes(ctx, acct, [env('real-2', { messageIdHeader: 'dup@bb.com' })]);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 2 });
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
  it("runBackfill's closing incremental gets a fresh state, never the stale cursor", async () => {
    accounts.updateAccount(db, acct.id, { syncState: JSON.stringify({ cursor: 41 }) });
    const seen: SyncState[] = [];
    const inner = provider.incremental.bind(provider);
    provider.incremental = (state: SyncState) => { seen.push(state); return inner(state); };
    await runBackfill(ctx, acct, provider);
    expect(seen).toEqual([{}]);
  });
  it('runIncremental restarts with a backfill when the provider says its history expired', async () => {
    // A provider whose change log no longer reaches our cursor: the first poll
    // reports reset, every later call behaves normally. It delegates to the
    // fake rather than subclassing it — only the interface's return type
    // carries `reset`, the fake's own narrower one does not.
    const inner = new FakeMailProvider();
    let backfills = 0;
    let resetPending = true;
    const p: MailProvider = {
      kind: 'fake',
      listFolders: () => inner.listFolders(),
      backfill: o => { backfills++; return inner.backfill(o); },
      incremental: async (state: SyncState) => {
        if (!resetPending) return inner.incremental(state);
        resetPending = false;
        return { upserts: [], deletes: [], state: { historyId: null }, reset: true };
      },
      getBody: id => inner.getBody(id),
      getAttachment: (id, attId) => inner.getAttachment(id, attId),
      send: m => inner.send(m),
      setFlags: (ids, f) => inner.setFlags(ids, f),
      move: (ids, f) => inner.move(ids, f),
      archive: ids => inner.archive(ids),
      trash: ids => inner.trash(ids),
      saveDraft: (d, existing) => inner.saveDraft(d, existing),
      deleteDraft: id => inner.deleteDraft(id),
      search: (q, o) => inner.search(q, o),
    };
    inner.seed([env('old', { date: '2026-01-01T00:00:00.000Z' }), env('new')]);
    accounts.updateAccount(db, acct.id, { syncState: JSON.stringify({ historyId: 'stale' }) });

    await runIncremental(ctx, acct, p);

    expect(backfills).toBe(1);
    expect(db.prepare('SELECT providerMessageId FROM mail_messages').all()).toEqual([{ providerMessageId: 'new' }]);
    // The dead cursor is replaced by the one the fresh backfill established.
    expect(JSON.parse(accounts.getAccountAny(db, acct.id)!.syncState!)).toEqual({ cursor: 0 });
    expect(accounts.getAccountAny(db, acct.id)!.status).toBe('ok');
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
