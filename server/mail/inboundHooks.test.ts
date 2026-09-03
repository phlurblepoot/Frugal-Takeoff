// server/mail/inboundHooks.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { createProject } from '../projectStore';
import { createRfi, getRfi, markRfiSent, setRfiStatus } from '../rfiStore';
import { MailCrypto } from './crypto';
import * as accounts from './accountStore';
import { FakeMailProvider } from './providers/fake';
import { createLink } from './links';
import type { MailContext } from './context';
import type { Envelope } from './providers/types';
import { upsertFolders, upsertEnvelopes, clearInboundHooks } from './sync/engine';
import { MailScheduler } from './sync/scheduler';
import { installInboundHooks, resetInboundHooks, rfiPendingReplyHook } from './inboundHooks';

let db: Database.Database; let ctx: MailContext; let acct: accounts.MailAccountRow;
let provider: FakeMailProvider; let events: any[]; let dir: string;
const crypto = new MailCrypto(Buffer.alloc(32, 9));

const THREAD = 'rfi-thread@bb.com';
const BODY_TEXT = "Corridor 9ft\n\nOn Aug 26 Nathan wrote:\n> RFI attached";

type Seeded = Envelope & { html?: string; text?: string };
const env = (id: string, o: Partial<Seeded> = {}): Seeded => ({
  providerMessageId: id, references: [THREAD], from: { addr: 'gc@teg.com', name: 'Mike' }, to: [{ addr: 'me@bb.com' }], cc: [], bcc: [],
  subject: 'Re: RFI-001', snippet: 'Corridor 9ft (snippet)', date: '2026-08-28T10:00:00.000Z',
  isRead: false, isStarred: false, isDraft: false, attachments: [], sizeBytes: 10,
  folderProviderIds: ['INBOX'], messageIdHeader: id + '@teg.com',
  // The "On … wrote:" marker has to survive htmlToText as its OWN line, the way
  // real clients emit it — stripQuotedReply cuts on lines, not on <blockquote>.
  text: BODY_TEXT, html: "<p>Corridor 9ft</p><div>On Aug 26 Nathan wrote:</div><blockquote><p>RFI attached</p></blockquote>", ...o,
});

/** Feeds one message through the engine exactly as a sync would: the provider
 *  must know the body, because the hook fetches it. */
function deliver(m: Seeded): void {
  provider.injectInbound(m);
  upsertEnvelopes(ctx, acct, [m]);
}

/** Lets the hook's fire-and-forget capture run to completion. */
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

function makeSentRfi(): string {
  const { id } = createRfi(db, 'p1', { title: 'Corridor height?' });
  markRfiSent(db, id);
  createLink(db, { threadKey: THREAD, itemType: 'rfi', itemId: id, linkedByUserId: 'u1' });
  return id;
}

beforeEach(() => {
  db = openDb(':memory:'); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ih-'));
  runMigrations(db, dir, migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','a','x','admin')`).run();
  createProject(db, { id: 'p1', name: 'Test Project', createdAt: 1, pages: [], takeoffs: [] });
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'me@bb.com', auth: { refreshToken: 'r' }, indexedSince: '2026-06-01T00:00:00.000Z' });
  provider = new FakeMailProvider(); provider.seed([]);
  events = [];
  ctx = { db, dataDir: dir, crypto, providerFactory: () => provider, broadcastChange: e => events.push(e) };
  ctx.scheduler = new MailScheduler(ctx);   // never started: only getProvider() is used
  upsertFolders(db, acct.id, provider.folders);
  clearInboundHooks(); resetInboundHooks();
  installInboundHooks();
});
afterEach(() => { clearInboundHooks(); resetInboundHooks(); db.close(); });

describe('rfi pending-reply inbound hook', () => {
  it('captures a quote-stripped reply on a sent, linked RFI and broadcasts it', async () => {
    const rfiId = makeSentRfi();
    deliver(env('m1', { attachments: [{ attId: 'a1', name: 'answer.pdf', mime: 'application/pdf', size: 12 }] }));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    const rfi = getRfi(db, rfiId);
    expect(rfi.pendingReply.text).toBe('Corridor 9ft');
    expect(rfi.status).toBe('sent');                       // stays pending review
    expect(rfi.pendingReply.threadKey).toBe(THREAD);
    expect(rfi.pendingReply.accountId).toBe(acct.id);
    expect(rfi.pendingReply.messageIdHeader).toBe('m1@teg.com');
    expect(rfi.pendingReply.from).toEqual({ addr: 'gc@teg.com', name: 'Mike' });
    expect(rfi.pendingReply.date).toBe('2026-08-28T10:00:00.000Z');
    expect(rfi.pendingReply.attachments).toEqual([{ attId: 'a1', name: 'answer.pdf', mime: 'application/pdf', size: 12 }]);
    expect(rfi.pendingReply.receivedAt).toBeTruthy();
    expect(rfi.pendingReply.mailMessageId).toBe((db.prepare(`SELECT id FROM mail_messages WHERE providerMessageId = 'm1'`).get() as any).id);
    expect(events.filter(e => e.type === 'rfi')).toEqual([{ type: 'rfi', id: rfiId, projectId: 'p1', version: rfi.version, action: 'updated' }]);
  });

  it('falls back to the html body when the provider has no text part', async () => {
    const rfiId = makeSentRfi();
    deliver(env('m1', { text: undefined }));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    expect(getRfi(db, rfiId).pendingReply.text).toBe('Corridor 9ft');
  });

  it('a second reply replaces the first', async () => {
    const rfiId = makeSentRfi();
    deliver(env('m1'));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    deliver(env('m2', { text: 'Make it 8ft', date: '2026-08-29T10:00:00.000Z' }));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply.text).toBe('Make it 8ft'));
    expect(getRfi(db, rfiId).pendingReply.date).toBe('2026-08-29T10:00:00.000Z');
  });

  it('re-running the hook for the same message does not capture twice', async () => {
    const rfiId = makeSentRfi();
    deliver(env('m1'));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    const { version } = getRfi(db, rfiId);
    const messageId = (db.prepare(`SELECT id FROM mail_messages WHERE providerMessageId = 'm1'`).get() as any).id;
    rfiPendingReplyHook(ctx, { threadKey: THREAD, messageId, account: acct });
    await settle();
    expect(getRfi(db, rfiId).version).toBe(version);
    expect(events.filter(e => e.type === 'rfi')).toHaveLength(1);
  });

  it('ignores an outbound message from one of our own addresses', async () => {
    const rfiId = makeSentRfi();
    deliver(env('m1', { from: { addr: 'me@bb.com' } }));
    await settle();
    expect(getRfi(db, rfiId).pendingReply).toBeNull();
    expect(events.filter(e => e.type === 'rfi')).toHaveLength(0);
  });

  it.each(['open', 'answered', 'closed'])('ignores a reply when the RFI is %s', async status => {
    const { id } = createRfi(db, 'p1', { title: 'Q' });
    createLink(db, { threadKey: THREAD, itemType: 'rfi', itemId: id, linkedByUserId: 'u1' });
    if (status !== 'open') setRfiStatus(db, id, status);
    deliver(env('m1'));
    await settle();
    expect(getRfi(db, id).pendingReply).toBeNull();
  });

  it('ignores a thread linked to something that is not an RFI', async () => {
    createLink(db, { threadKey: THREAD, itemType: 'project', itemId: 'p1', linkedByUserId: 'u1' });
    deliver(env('m1'));
    await settle();
    expect(events.filter(e => e.type === 'rfi')).toHaveLength(0);
  });

  it('captures onto every sent RFI linked to the thread', async () => {
    const a = makeSentRfi(); const b = makeSentRfi();
    deliver(env('m1'));
    await vi.waitFor(() => {
      expect(getRfi(db, a).pendingReply).toBeTruthy();
      expect(getRfi(db, b).pendingReply).toBeTruthy();
    });
    expect(getRfi(db, b).pendingReply.text).toBe('Corridor 9ft');
  });

  it('falls back to the indexed snippet when the body fetch fails', async () => {
    const rfiId = makeSentRfi();
    const m = env('m1');
    provider.injectInbound(m);
    provider.failNextWith(new Error('provider down'));
    upsertEnvelopes(ctx, acct, [m]);
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    expect(getRfi(db, rfiId).pendingReply.text).toBe('Corridor 9ft (snippet)');
  });

  it('installInboundHooks is idempotent', async () => {
    installInboundHooks(); installInboundHooks();
    const rfiId = makeSentRfi();
    deliver(env('m1'));
    await vi.waitFor(() => expect(getRfi(db, rfiId).pendingReply).toBeTruthy());
    expect(events.filter(e => e.type === 'rfi')).toHaveLength(1);
  });

  it('never throws out of the synchronous hook call', () => {
    const broken = { ...ctx, db: { prepare: () => { throw new Error('db gone'); } } } as unknown as MailContext;
    expect(() => rfiPendingReplyHook(broken, { threadKey: THREAD, messageId: 'x', account: acct })).not.toThrow();
  });
});
