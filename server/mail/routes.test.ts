// server/mail/routes.test.ts  (spec §4.4)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { createProject } from '../projectStore';
import { saveCustomer } from '../customerStore';
import { MailCrypto } from './crypto';
import * as accounts from './accountStore';
import { FakeMailProvider } from './providers/fake';
import { getFakeProvider, resetFakes } from './providers/fakeRegistry';
import { registerMailRoutes, type MailRouteDeps } from './routes';
import { signState, verifyState } from './oauth';
import { BodyCache } from './sync/bodyCache';
import { MailScheduler } from './sync/scheduler';
import { upsertFolders, upsertEnvelopes } from './sync/engine';
import type { MailContext } from './context';

let db: Database.Database;
let dir: string;
let app: express.Express;
let ctx: MailContext;
let acct: accounts.MailAccountRow;
let provider: FakeMailProvider;
let routeEnv: NodeJS.ProcessEnv;
const JWT_SECRET = 'test-jwt-secret';
// Swapped per test so a callback never touches a real provider.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let oauthStub: MailRouteDeps['oauthExchange'];
const crypto = new MailCrypto(Buffer.alloc(32, 6));
let currentUser = { id: 'u1', role: 'admin' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env = (id: string, o: any = {}) => ({
  providerMessageId: id, references: [], from: { addr: 'gc@teg.com', name: 'Mike' }, to: [{ addr: 'me@bb.com' }], cc: [], bcc: [],
  subject: 'CO 4', snippet: 'hello', date: '2026-08-10T10:00:00.000Z',
  isRead: false, isStarred: false, isDraft: false,
  attachments: [{ attId: 'a1', name: 'cor.pdf', mime: 'application/pdf', size: 4 }],
  sizeBytes: 10, folderProviderIds: ['INBOX'], messageIdHeader: id + '@teg.com',
  html: '<p>Hi <img src="https://x/y.png"></p>', attachmentBytes: { a1: Buffer.from('%PDF') }, ...o,
});

const firstMessageId = () => (db.prepare('SELECT id FROM mail_messages').get() as { id: string }).id;

beforeEach(() => {
  resetFakes();
  currentUser = { id: 'u1', role: 'admin' };
  routeEnv = {};
  oauthStub = async () => ({ refreshToken: 'RT', accessToken: 'AT', email: 'oauth@bb.com', name: 'OAuth Nate' });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mr-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','a','x','admin'), ('u2','b','x','user')`).run();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createProject(db, { id: 'p1', name: 'P', createdAt: 1, pages: [], takeoffs: [] } as any);
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'me@bb.com', auth: { refreshToken: 'r' } });
  provider = getFakeProvider(acct.id);
  provider.seed([env('m1')]);
  ctx = { db, dataDir: dir, crypto, providerFactory: a => getFakeProvider(a.id), broadcastChange: () => {} };
  ctx.scheduler = new MailScheduler(ctx);
  upsertFolders(db, acct.id, provider.folders);
  upsertEnvelopes(ctx, acct, [env('m1')]);
  app = express();
  app.use(express.json({ limit: '50mb' }));
  registerMailRoutes(app, {
    ctx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authenticateToken: (req: any, _r, next) => { req.user = currentUser; next(); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requireAdmin: (req: any, res, next) => (req.user.role === 'admin' ? next() : res.status(403).end()),
    verifyToken: t => (t === 'tok' ? currentUser : null),
    bodyCache: new BodyCache({ maxBytes: 1e6, ttlMs: 1e5 }),
    publicUrl: 'https://app.test',
    env: routeEnv,
    jwtSecret: JWT_SECRET,
    oauthExchange: (...args) => oauthStub!(...args),
  });
});

afterEach(async () => {
  // Routes can start sync workers (POST /accounts/:id/test) and fire background
  // backfills (load-older); drain them so no timer outlives the test.
  await ctx.scheduler!.stop();
});

describe('mail routes', () => {
  it('GET /api/mail/accounts lists own accounts without secrets', async () => {
    const r = await request(app).get('/api/mail/accounts');
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ id: acct.id, emailAddress: 'me@bb.com', isDefault: 1, unreadCount: 1 });
    expect(r.body[0].authBlob).toBeUndefined();
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get('/api/mail/accounts')).body).toEqual([]);
  });

  it('POST /api/mail/accounts/imap creates a needs_review→ok account after test', async () => {
    const r = await request(app).post('/api/mail/accounts/imap').send({ emailAddress: 'n@x.com', displayName: 'N', imapHost: 'imap.x', imapPort: 993, imapSecure: true, smtpHost: 'smtp.x', smtpPort: 587, smtpSecure: false, username: 'n', password: 'p' });
    expect(r.status).toBe(200);
    expect(r.body.provider).toBe('imap');
    expect(r.body.status).toBe('needs_review');
    const t = await request(app).post(`/api/mail/accounts/${r.body.id}/test`);
    expect(t.status).toBe(200);   // fake factory → always passes
    expect(accounts.getAccountAny(db, r.body.id)!.status).toBe('ok');
  });

  it('POST /api/mail/accounts/imap rejects a missing field and keeps the password on update', async () => {
    expect((await request(app).post('/api/mail/accounts/imap').send({ emailAddress: 'n@x.com' })).status).toBe(400);
    const created = (await request(app).post('/api/mail/accounts/imap').send({ emailAddress: 'n@x.com', imapHost: 'imap.x', smtpHost: 'smtp.x', username: 'n', password: 'secret' })).body;
    const upd = await request(app).post('/api/mail/accounts/imap').send({ id: created.id, emailAddress: 'n2@x.com', imapHost: 'imap.x', smtpHost: 'smtp.x', username: 'n' });
    expect(upd.status).toBe(200);
    expect(upd.body.emailAddress).toBe('n2@x.com');
    expect((accounts.readAuth(db, crypto, created.id) as accounts.ImapAuth).password).toBe('secret');
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).post('/api/mail/accounts/imap').send({ id: created.id, emailAddress: 'n3@x.com', imapHost: 'i', smtpHost: 's', username: 'n', password: 'p' })).status).toBe(404);
  });

  it('threads list + detail, scoped by owner', async () => {
    const folders = (await request(app).get('/api/mail/folders').query({ accountId: acct.id })).body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inbox = folders.find((f: any) => f.role === 'inbox');
    const list = await request(app).get('/api/mail/threads').query({ accountId: acct.id, folderId: inbox.id });
    expect(list.status).toBe(200);
    expect(list.body.threads.length).toBe(1);
    expect(list.body.threads[0]).toMatchObject({ threadKey: 'm1@teg.com', unreadCount: 1, hasAttachments: 1, snippet: 'hello' });
    const detail = await request(app).get(`/api/mail/threads/${acct.id}/${encodeURIComponent('m1@teg.com')}`);
    expect(detail.body.messages[0]).toMatchObject({ subject: 'CO 4', from: { addr: 'gc@teg.com' } });
    expect(detail.body.messages[0].providerMessageId).toBeUndefined();
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id })).status).toBe(404);
    expect((await request(app).get('/api/mail/folders').query({ accountId: acct.id })).status).toBe(404);
    expect((await request(app).get(`/api/mail/threads/${acct.id}/${encodeURIComponent('m1@teg.com')}`)).status).toBe(404);
  });

  it('the folderId filter matches whole ids, not id prefixes', async () => {
    const inbox = db.prepare(`SELECT id FROM mail_folders WHERE accountId = ? AND role = 'inbox'`).get(acct.id) as { id: string };
    const prefix = inbox.id.slice(0, 8);
    expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id, folderId: prefix })).body.threads.length).toBe(0);
    expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id, folderId: inbox.id })).body.threads.length).toBe(1);
  });

  it('search filters by subject/from/snippet', async () => {
    expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id, q: 'mike' })).body.threads.length).toBe(1);
    expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id, q: 'zzz' })).body.threads.length).toBe(0);
  });

  it('GET /api/mail/search indexes provider hits older than the local window', async () => {
    provider.injectInbound(env('old1', { subject: 'ancient CO', date: '2020-01-01T00:00:00.000Z', messageIdHeader: 'old1@teg.com' }));
    const r = await request(app).get('/api/mail/search').query({ accountId: acct.id, q: 'ancient' });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(1);
    expect(db.prepare('SELECT 1 FROM mail_messages WHERE messageIdHeader = ?').get('old1@teg.com')).toBeTruthy();
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get('/api/mail/search').query({ accountId: acct.id, q: 'x' })).status).toBe(404);
  });

  it('body is sanitized with remote images blocked, cached, and images=1 allows them', async () => {
    const id = firstMessageId();
    const r = await request(app).get(`/api/mail/messages/${id}/body`);
    expect(r.status).toBe(200);
    expect(r.body.blockedRemoteImages).toBe(1);
    expect(r.body.html).toContain('data-blocked-src');
    provider.failNextWith(new Error('should not be called — cached'));
    expect((await request(app).get(`/api/mail/messages/${id}/body`)).status).toBe(200);
    provider.failNextWith(new Error('x'));
    await provider.listFolders().catch(() => {});   // clear the pending failure
    expect((await request(app).get(`/api/mail/messages/${id}/body`).query({ images: 1 })).body.blockedRemoteImages).toBe(0);
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get(`/api/mail/messages/${id}/body`)).status).toBe(404);
  });

  it('a message the provider has not filed yet is pending, not an error', async () => {
    // A send whose Sent Items read-back lost the race is indexed under a
    // "sent:" placeholder; asking the provider for it would 404 on the user's
    // own message.
    upsertEnvelopes(ctx, acct, [env('sent:out-9@bb.com', { messageIdHeader: 'out-9@bb.com', from: { addr: 'me@bb.com' }, subject: 'Pending one' })], { sentFromApp: true });
    const id = (db.prepare('SELECT id FROM mail_messages WHERE providerMessageId = ?').get('sent:out-9@bb.com') as { id: string }).id;

    const b = await request(app).get(`/api/mail/messages/${id}/body`);
    expect(b.status).toBe(202);
    expect(b.body).toEqual({ pending: true });

    const a = await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'tok' });
    expect(a.status).toBe(404);
    expect(a.body.error).toMatch(/still being filed/);
  });

  it('attachment streams with token auth and content-disposition; save persists to Documents', async () => {
    const id = firstMessageId();
    const r = await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'tok' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('cor.pdf');
    expect((await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'bad' })).status).toBe(401);
    const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1', name: 'COR-4 signed.pdf', kind: 'document', projectId: 'p1' }] });
    expect(s.status).toBe(200);
    expect(s.body.fileIds.length).toBe(1);
    const f = db.prepare('SELECT name, kind, projectId, sourceType, sourceId FROM files WHERE id = ?').get(s.body.fileIds[0]);
    expect(f).toMatchObject({ name: 'COR-4 signed.pdf', kind: 'document', projectId: 'p1', sourceType: 'mailMessage', sourceId: id });
  });

  it('saved attachments default to the multi-instance email-attachment kind so two do not version each other', async () => {
    provider.seed([env('m1', { attachments: [{ attId: 'a1', name: 'one.pdf', mime: 'application/pdf', size: 4 }, { attId: 'a2', name: 'two.pdf', mime: 'application/pdf', size: 4 }], attachmentBytes: { a1: Buffer.from('%PDF'), a2: Buffer.from('%PDF') } })]);
    upsertEnvelopes(ctx, acct, [env('m1', { attachments: [{ attId: 'a1', name: 'one.pdf', mime: 'application/pdf', size: 4 }, { attId: 'a2', name: 'two.pdf', mime: 'application/pdf', size: 4 }] })]);
    const id = firstMessageId();
    const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1' }, { attId: 'a2' }] });
    expect(s.status).toBe(200);
    expect(s.body.fileIds.length).toBe(2);
    expect(new Set(s.body.fileIds).size).toBe(2);
    const rows = db.prepare('SELECT name, kind FROM files WHERE parentFileId IS NULL ORDER BY name').all();
    expect(rows).toEqual([{ name: 'one.pdf', kind: 'email-attachment' }, { name: 'two.pdf', kind: 'email-attachment' }]);
  });

  it('attachment save is per item: one failure does not discard the others', async () => {
    const twoAtts = [{ attId: 'a1', name: 'one.pdf', mime: 'application/pdf', size: 4 }, { attId: 'a2', name: 'two.pdf', mime: 'application/pdf', size: 4 }];
    provider.seed([env('m1', { attachments: twoAtts, attachmentBytes: { a1: Buffer.from('%PDF'), a2: Buffer.from('%PDF') } })]);
    upsertEnvelopes(ctx, acct, [env('m1', { attachments: twoAtts })]);
    const id = firstMessageId();
    provider.failNextWith(new Error('provider blew up on the first fetch'));
    const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1' }, { attId: 'a2' }] });
    expect(s.status).toBe(200);
    expect(s.body.fileIds.length).toBe(1);
    expect(s.body.saved).toEqual([{ attId: 'a2', fileId: s.body.fileIds[0] }]);
    expect(s.body.failed).toEqual([{ attId: 'a1', error: 'Could not save this attachment' }]);
    // The one that worked really landed in Documents; the raw provider message never leaks.
    expect((db.prepare('SELECT name FROM files WHERE id = ?').get(s.body.fileIds[0]) as { name: string }).name).toBe('two.pdf');
    expect(JSON.stringify(s.body)).not.toContain('blew up');
  });

  it('attachment save reports an attId that is not on the message instead of skipping it', async () => {
    const id = firstMessageId();
    const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'nope' }, { attId: 'a1' }] });
    expect(s.status).toBe(200);
    expect(s.body.saved.length).toBe(1);
    expect(s.body.failed).toEqual([{ attId: 'nope', error: 'That attachment is not on this message' }]);
  });

  it('the attachment stream is released when the client goes away mid-download', async () => {
    const id = firstMessageId();
    const endless = new Readable({ read() { this.push(Buffer.alloc(64 * 1024)); } });
    const destroyed = new Promise<void>(resolve => { endless.on('close', () => resolve()); });
    vi.spyOn(provider, 'getAttachment').mockResolvedValue({ stream: endless, mime: 'application/pdf', size: 0, name: 'endless.pdf' });
    const pending = request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'tok' });
    pending.end(() => {});   // superagent is lazy — actually put the request on the wire
    // Let the response start flowing, then hang up the way a navigating browser does.
    await new Promise(r => setTimeout(r, 50));
    pending.abort();
    await expect(destroyed).resolves.toBeUndefined();
    expect(endless.destroyed).toBe(true);
  });

  it('another user cannot read or save a message they do not own', async () => {
    const id = firstMessageId();
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'tok' })).status).toBe(404);
    expect((await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1' }] })).status).toBe(404);
  });

  it('actions apply locally + to the provider and revert on provider failure', async () => {
    const id = firstMessageId();
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'read' })).status).toBe(200);
    expect((db.prepare('SELECT isRead FROM mail_messages').get() as { isRead: number }).isRead).toBe(1);
    provider.failNextWith(new Error('down'));
    const r = await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'star' });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('Mail provider request failed');   // §7: never echo the provider's raw message
    expect(JSON.stringify(r.body)).not.toContain('down');
    expect((db.prepare('SELECT isStarred FROM mail_messages').get() as { isStarred: number }).isStarred).toBe(0);
    expect((await request(app).post('/api/mail/threads/actions').send({ accountId: acct.id, threadKeys: ['m1@teg.com'], action: 'archive' })).status).toBe(200);
    expect(JSON.parse((db.prepare('SELECT folderIdsJson FROM mail_messages').get() as { folderIdsJson: string }).folderIdsJson))
      .toEqual([(db.prepare(`SELECT id FROM mail_folders WHERE role='archive'`).get() as { id: string }).id]);
  });

  // An IMAP MOVE re-numbers the message. If the row kept the old provider id it
  // would resolve to nothing and the next poll would index the moved copy again.
  it('archive re-keys the row to the provider id the message now has', async () => {
    const id = firstMessageId();
    provider.archive = async (ids: string[]) => ids.map(from => ({ from, to: 'Archive 9 77' }));
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'archive' })).status).toBe(200);
    const row = db.prepare('SELECT providerMessageId, folderIdsJson FROM mail_messages WHERE id = ?').get(id) as { providerMessageId: string; folderIdsJson: string };
    expect(row.providerMessageId).toBe('Archive 9 77');
    expect(JSON.parse(row.folderIdsJson)).toEqual([(db.prepare(`SELECT id FROM mail_folders WHERE role='archive'`).get() as { id: string }).id]);
  });

  it('trash drops the row when the provider cannot say where the message went', async () => {
    const id = firstMessageId();
    provider.trash = async (ids: string[]) => ids.map(from => ({ from, to: null }));
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'trash' })).status).toBe(200);
    expect(db.prepare('SELECT id FROM mail_messages WHERE id = ?').get(id)).toBeUndefined();
    // the thread rollup is rebuilt, not left pointing at a message that is gone
    expect(db.prepare('SELECT id FROM mail_threads').get()).toBeUndefined();
  });

  it('an unchanged mapping leaves the row alone', async () => {
    const id = firstMessageId();
    const before = (db.prepare('SELECT providerMessageId FROM mail_messages WHERE id = ?').get(id) as { providerMessageId: string }).providerMessageId;
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'archive' })).status).toBe(200);
    expect((db.prepare('SELECT providerMessageId FROM mail_messages WHERE id = ?').get(id) as { providerMessageId: string }).providerMessageId).toBe(before);
  });

  it('actions reject an unknown action and a message the caller does not own', async () => {
    const id = firstMessageId();
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'bogus' })).status).toBe(400);
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'move' })).status).toBe(400);
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'read' })).status).toBe(404);
    expect((await request(app).post('/api/mail/threads/actions').send({ accountId: acct.id, threadKeys: ['m1@teg.com'], action: 'read' })).status).toBe(404);
  });

  it('send + drafts + links + unread + recipients + heartbeat + setup-info', async () => {
    const s = await request(app).post('/api/mail/send').send({ to: [{ addr: 'gc@teg.com' }], subject: 'Hi', html: '<p>x</p>', attachments: [] });
    expect(s.status).toBe(200);
    expect(s.body.threadKey).toBeTruthy();
    expect(provider.sent.length).toBe(1);
    const d = await request(app).post('/api/mail/drafts').send({ accountId: acct.id, to: [], subject: 'draft', html: '' });
    expect(d.status).toBe(200);
    expect(d.body.draftId).toBeTruthy();
    expect((await request(app).put(`/api/mail/drafts/${d.body.draftId}`).send({ accountId: acct.id, to: [], subject: 'draft2', html: '' })).status).toBe(200);
    expect((await request(app).delete(`/api/mail/drafts/${d.body.draftId}`).query({ accountId: acct.id })).status).toBe(200);
    const l = await request(app).post('/api/mail/links').send({ threadKey: s.body.threadKey, itemType: 'project', itemId: 'p1' });
    expect(l.status).toBe(200);
    expect((await request(app).get('/api/mail/links').query({ itemType: 'project', itemId: 'p1' })).body.length).toBe(1);
    expect((await request(app).delete(`/api/mail/links/${l.body.id}`)).status).toBe(200);
    expect((await request(app).get('/api/mail/unread-count')).body).toEqual({ total: 1, byAccount: { [acct.id]: 1 } });
    const rc = await request(app).get('/api/mail/recipients').query({ q: 'teg' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(rc.body.some((x: any) => x.addr === 'gc@teg.com')).toBe(true);
    expect((await request(app).post('/api/mail/heartbeat').send({ accountIds: [acct.id] })).status).toBe(204);
    const si = await request(app).get('/api/mail/setup-info');
    expect(si.body).toMatchObject({ google: { configured: false, redirectUri: 'https://app.test/api/mail/oauth/google/callback' } });
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get('/api/mail/setup-info')).status).toBe(403);
  });

  it('drafts routes are scoped to the caller\'s own account', async () => {
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).post('/api/mail/drafts').send({ accountId: acct.id, to: [], subject: 'x', html: '' })).status).toBe(404);
    expect((await request(app).put('/api/mail/drafts/d1').send({ accountId: acct.id, to: [], subject: 'x', html: '' })).status).toBe(404);
    expect((await request(app).delete('/api/mail/drafts/d1').query({ accountId: acct.id })).status).toBe(404);
  });

  it('recipients include customer role addresses with the customer name and role', async () => {
    saveCustomer(db, { id: 'c1', name: 'TEG Builders', contactName: 'Mike', emails: { accounting: { to: 'ap@tegbuilders.com, ap2@tegbuilders.com' }, general: { to: 'info@other.com' } } });
    const r = await request(app).get('/api/mail/recipients').query({ q: 'tegbuilders' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hit = r.body.find((x: any) => x.addr === 'ap@tegbuilders.com');
    expect(hit).toMatchObject({ customerId: 'c1', role: 'accounting' });
    expect(hit.source).toContain('TEG Builders');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(r.body.some((x: any) => x.addr === 'ap2@tegbuilders.com')).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(r.body.some((x: any) => x.addr === 'info@other.com')).toBe(false);
  });

  it('POST /api/mail/links validates itemType and backfills reply state from existing messages', async () => {
    expect((await request(app).post('/api/mail/links').send({ threadKey: 'm1@teg.com', itemType: 'nope', itemId: 'p1' })).status).toBe(400);
    expect((await request(app).post('/api/mail/links').send({ threadKey: 'm1@teg.com', itemId: 'p1' })).status).toBe(400);
    // Thread has one inbound message (from gc@teg.com) and one outbound (from the app account).
    upsertEnvelopes(ctx, acct, [env('m2', { messageIdHeader: 'm2@bb.com', inReplyTo: 'm1@teg.com', from: { addr: 'ME@bb.com', name: 'Me' }, date: '2026-08-11T10:00:00.000Z', folderProviderIds: ['SENT'] })]);
    const l = await request(app).post('/api/mail/links').send({ threadKey: 'm1@teg.com', itemType: 'project', itemId: 'p1' });
    expect(l.status).toBe(200);
    expect(l.body).toMatchObject({ itemType: 'project', itemId: 'p1', projectId: 'p1' });
    expect(db.prepare('SELECT lastInboundDate, lastOutboundDate FROM mail_thread_reply_state WHERE threadKey = ?').get('m1@teg.com'))
      .toEqual({ lastInboundDate: '2026-08-10T10:00:00.000Z', lastOutboundDate: '2026-08-11T10:00:00.000Z' });
  });

  it('links are app-wide but thread snapshots are not, and only the linker or an admin can unlink', async () => {
    const l = await request(app).post('/api/mail/links').send({ threadKey: 'm1@teg.com', itemType: 'project', itemId: 'p1' });
    expect(l.status).toBe(200);
    expect(l.body.subjectSnapshot).toBe('CO 4');

    // u1 owns the account the thread lives in, so u1 keeps the snapshot fields
    const owner = await request(app).get('/api/mail/links').query({ itemType: 'project', itemId: 'p1' });
    expect(owner.body[0].subjectSnapshot).toBe('CO 4');
    expect(JSON.parse(owner.body[0].participantsJson)).toBeInstanceOf(Array);

    currentUser = { id: 'u2', role: 'user' };
    const other = await request(app).get('/api/mail/links').query({ itemType: 'project', itemId: 'p1' });
    expect(other.body.length).toBe(1);                       // the link itself is item data: still visible
    expect(other.body[0].id).toBe(l.body.id);
    expect(other.body[0].subjectSnapshot).toBeNull();        // mailbox content: withheld
    expect(other.body[0].participantsJson).toBeNull();

    const denied = await request(app).delete(`/api/mail/links/${l.body.id}`);
    expect(denied.status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_thread_links').get()).toEqual({ c: 1 });

    currentUser = { id: 'u2', role: 'admin' };               // an admin who did not create it still may
    expect((await request(app).delete(`/api/mail/links/${l.body.id}`)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_thread_links').get()).toEqual({ c: 0 });
  });

  it('POST /api/mail/send rejects an unknown itemType and an empty recipient list before anything is sent', async () => {
    const base = { to: [{ addr: 'gc@teg.com' }], subject: 's', html: '<p>h</p>', attachments: [] };
    const badLink = await request(app).post('/api/mail/send').send({ ...base, links: [{ itemType: 'nope', itemId: 'p1' }] });
    expect(badLink.status).toBe(400);
    expect(badLink.body.error).toBe('Invalid itemType');

    const badAtt = await request(app).post('/api/mail/send')
      .send({ ...base, attachments: [{ fileId: 'f1', itemType: 'nope', itemId: 'p1' }] });
    expect(badAtt.status).toBe(400);
    expect(badAtt.body.error).toBe('Invalid itemType');

    const noTo = await request(app).post('/api/mail/send').send({ ...base, to: [] });
    expect(noTo.status).toBe(400);

    expect(provider.sent.length).toBe(0);
  });

  it('GET /api/mail/links validates itemType and requires itemId', async () => {
    expect((await request(app).get('/api/mail/links').query({ itemType: 'nope', itemId: 'p1' })).status).toBe(400);
    expect((await request(app).get('/api/mail/links').query({ itemType: 'project' })).status).toBe(400);
    expect((await request(app).get('/api/mail/links').query({ itemType: 'project', itemId: 'p1' })).status).toBe(200);
  });

  it('GET /api/mail/providers reports which OAuth providers the env configures', async () => {
    expect((await request(app).get('/api/mail/providers')).body).toEqual({ google: false, microsoft: false });
    routeEnv.GOOGLE_OAUTH_CLIENT_ID = 'gid';
    routeEnv.GOOGLE_OAUTH_CLIENT_SECRET = 'gsec';
    routeEnv.MS_OAUTH_CLIENT_ID = 'mid';
    currentUser = { id: 'u2', role: 'user' };   // any authenticated user, not just admins
    expect((await request(app).get('/api/mail/providers')).body).toEqual({ google: true, microsoft: false });
  });

  it('POST /api/mail/uploads rejects a body the raw parser never saw', async () => {
    // The app-level express.json() claims application/json bodies, so req.body
    // arrives as an object rather than a Buffer.
    expect((await request(app).post('/api/mail/uploads').query({ name: 'a.json' }).send({ not: 'a buffer' })).status).toBe(400);
    expect((await request(app).post('/api/mail/uploads').query({ name: 'a.jpg' }).set('Content-Type', 'image/jpeg').send(Buffer.alloc(0))).status).toBe(400);
  });

  it('staged uploads: POST /api/mail/uploads returns uploadId usable by send', async () => {
    const u = await request(app).post('/api/mail/uploads').query({ name: 'a.jpg' }).set('Content-Type', 'image/jpeg').send(Buffer.from('jpg'));
    expect(u.status).toBe(200);
    const s = await request(app).post('/api/mail/send').send({ to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [{ uploadId: u.body.uploadId }] });
    expect(s.status).toBe(200);
    expect(provider.sent[0].attachments[0].name).toBe('a.jpg');
  });

  it('send surfaces MailSendError status codes', async () => {
    const r = await request(app).post('/api/mail/send').send({ to: [], subject: 's', html: 'h', attachments: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('recipient');
  });

  it('load-older moves indexedSince back and PATCH/DELETE account work', async () => {
    const before = acct.indexedSince;
    expect((await request(app).post(`/api/mail/accounts/${acct.id}/load-older`).send({ months: 6 })).status).toBe(200);
    expect(accounts.getAccountAny(db, acct.id)!.indexedSince < before).toBe(true);
    expect((await request(app).patch(`/api/mail/accounts/${acct.id}`).send({ signatureHtml: '<p>sig</p>', displayName: 'Nate' })).status).toBe(200);
    expect(accounts.getAccountAny(db, acct.id)!.signatureHtml).toBe('<p>sig</p>');
    expect((await request(app).delete(`/api/mail/accounts/${acct.id}`)).status).toBe(200);
    expect(accounts.getAccountAny(db, acct.id)).toBeNull();
  });

  it('DELETE /api/mail/accounts/:id stops the worker and drops the cached provider first', async () => {
    const created = (await request(app).post('/api/mail/accounts/imap').send({ emailAddress: 'n@x.com', imapHost: 'imap.x', smtpHost: 'smtp.x', username: 'n', password: 'p' })).body;
    await request(app).post(`/api/mail/accounts/${created.id}/test`);
    expect(ctx.scheduler!.isRunning(created.id)).toBe(true);
    const dropSpy = vi.spyOn(ctx.scheduler!, 'dropProvider');
    expect((await request(app).delete(`/api/mail/accounts/${created.id}`)).status).toBe(200);
    expect(ctx.scheduler!.isRunning(created.id)).toBe(false);
    expect(dropSpy).toHaveBeenCalledWith(created.id);
    dropSpy.mockRestore();
  });

  it('account mutation routes reject another user\'s account', async () => {
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).patch(`/api/mail/accounts/${acct.id}`).send({ displayName: 'x' })).status).toBe(404);
    expect((await request(app).delete(`/api/mail/accounts/${acct.id}`)).status).toBe(404);
    expect((await request(app).post(`/api/mail/accounts/${acct.id}/test`)).status).toBe(404);
    expect((await request(app).post(`/api/mail/accounts/${acct.id}/load-older`).send({ months: 6 })).status).toBe(404);
    expect(accounts.getAccountAny(db, acct.id)).not.toBeNull();
  });

  it('PATCH isDefault + disable/enable drive the scheduler', async () => {
    const second = (await request(app).post('/api/mail/accounts/imap').send({ emailAddress: 'n@x.com', imapHost: 'imap.x', smtpHost: 'smtp.x', username: 'n', password: 'p' })).body;
    expect((await request(app).patch(`/api/mail/accounts/${second.id}`).send({ isDefault: true })).status).toBe(200);
    expect(accounts.getAccountAny(db, second.id)!.isDefault).toBe(1);
    expect(accounts.getAccountAny(db, acct.id)!.isDefault).toBe(0);
    expect((await request(app).patch(`/api/mail/accounts/${acct.id}`).send({ status: 'disabled' })).status).toBe(200);
    expect(accounts.getAccountAny(db, acct.id)!.status).toBe('disabled');
    expect((await request(app).patch(`/api/mail/accounts/${acct.id}`).send({ status: 'ok' })).status).toBe(200);
    expect(accounts.getAccountAny(db, acct.id)!.status).toBe('ok');
    expect(ctx.scheduler!.isRunning(acct.id)).toBe(true);
  });

  it('heartbeat ignores account ids the caller does not own', async () => {
    const spy = vi.spyOn(ctx.scheduler!, 'markViewed');
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).post('/api/mail/heartbeat').send({ accountIds: [acct.id] })).status).toBe(204);
    expect(spy).toHaveBeenCalledWith([]);
    spy.mockRestore();
  });
  // ── OAuth connect flow ──
  const oauthApp = (over: Partial<MailRouteDeps> = {}) => {
    const a = express();
    a.use(express.json());
    registerMailRoutes(a, {
      ctx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authenticateToken: (req: any, _r, next) => { req.user = currentUser; next(); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requireAdmin: (req: any, res, next) => (req.user.role === 'admin' ? next() : res.status(403).end()),
      verifyToken: t => (t === 'tok' ? currentUser : null),
      bodyCache: new BodyCache({ maxBytes: 1e6, ttlMs: 1e5 }),
      publicUrl: 'https://app.test',
      env: routeEnv,
      jwtSecret: JWT_SECRET,
      oauthExchange: (...args) => oauthStub!(...args),
      ...over,
    });
    return a;
  };

  it('GET /api/mail/oauth/:provider/start redirects to consent with PKCE state', async () => {
    routeEnv.GOOGLE_OAUTH_CLIENT_ID = 'gid';
    routeEnv.GOOGLE_OAUTH_CLIENT_SECRET = 'gs';
    const r = await request(app).get('/api/mail/oauth/google/start').query({ token: 'tok' });
    expect(r.status).toBe(302);
    const url = new URL(r.headers.location);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(r.headers.location).toContain('state=');
    // The state is a signed envelope carrying the caller and the PKCE verifier.
    expect(verifyState(JWT_SECRET, url.searchParams.get('state')!)).toMatchObject({ userId: 'u1', provider: 'google' });
    // The verifier itself never leaves in the clear alongside its challenge.
    expect(url.searchParams.get('code_challenge')).not.toBe(verifyState(JWT_SECRET, url.searchParams.get('state')!).verifier);
    // Nothing here may carry the client secret.
    expect(r.headers.location).not.toContain('gs');
  });

  it('start rejects an unknown provider, a bad token, a missing publicUrl and missing env', async () => {
    expect((await request(app).get('/api/mail/oauth/aol/start').query({ token: 'tok' })).status).toBe(400);
    expect((await request(app).get('/api/mail/oauth/google/start').query({ token: 'nope' })).status).toBe(401);
    // env not configured for microsoft
    const noEnv = await request(app).get('/api/mail/oauth/microsoft/start').query({ token: 'tok' });
    expect(noEnv.status).toBe(503);
    expect(noEnv.body.error).toContain('MS_OAUTH_CLIENT_ID');
    routeEnv.GOOGLE_OAUTH_CLIENT_ID = 'gid';
    routeEnv.GOOGLE_OAUTH_CLIENT_SECRET = 'gs';
    const noUrl = await request(oauthApp({ publicUrl: null })).get('/api/mail/oauth/google/start').query({ token: 'tok' });
    expect(noUrl.status).toBe(503);
    expect(noUrl.body.error).toContain('APP_PUBLIC_URL');
  });

  it('callback exchanges the code, creates the account and starts the worker', async () => {
    const state = signState(JWT_SECRET, { userId: 'u1', provider: 'google', verifier: 'v1' });
    const seen: Array<{ provider: string; code: string; verifier: string }> = [];
    oauthStub = async (provider, _env, _url, code, verifier) => { seen.push({ provider, code, verifier }); return { refreshToken: 'RT', accessToken: 'AT', email: 'New@BB.com', name: 'Nate' }; };
    const startSpy = vi.spyOn(ctx.scheduler!, 'startAccount');
    const r = await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c1', state });
    expect(r.status).toBe(302);
    const created = accounts.listAccounts(db, 'u1').find(a => a.emailAddress === 'new@bb.com')!;
    expect(created).toBeTruthy();
    expect(created.provider).toBe('google');
    expect(created.status).toBe('ok');
    expect(created.displayName).toBe('Nate');
    expect(accounts.readAuth(db, crypto, created.id)).toEqual({ refreshToken: 'RT' });
    expect(r.headers.location).toBe(`/settings?tab=mail&connected=${created.id}`);
    // code + verifier reached the exchange; the refresh token never reaches the browser.
    expect(seen[0]).toEqual({ provider: 'google', code: 'c1', verifier: 'v1' });
    expect(r.headers.location).not.toContain('RT');
    expect(startSpy).toHaveBeenCalledWith(created.id);
    startSpy.mockRestore();
  });

  it('a second callback for the same address reconnects instead of duplicating', async () => {
    const state = () => signState(JWT_SECRET, { userId: 'u1', provider: 'google', verifier: 'v' });
    await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c1', state: state() });
    const first = accounts.listAccounts(db, 'u1').find(a => a.emailAddress === 'oauth@bb.com')!;
    accounts.updateAccount(db, first.id, { status: 'auth_error', lastError: 'expired' });
    const dropSpy = vi.spyOn(ctx.scheduler!, 'dropProvider');
    oauthStub = async () => ({ refreshToken: 'RT2', accessToken: 'AT', email: 'oauth@bb.com', name: 'OAuth Nate' });
    const r = await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c2', state: state() });
    expect(r.headers.location).toBe(`/settings?tab=mail&connected=${first.id}`);
    expect(accounts.listAccounts(db, 'u1').filter(a => a.emailAddress === 'oauth@bb.com')).toHaveLength(1);
    const after = accounts.getAccountAny(db, first.id)!;
    expect(after.status).toBe('ok');
    expect(after.lastError).toBeNull();
    expect(accounts.readAuth(db, crypto, first.id)).toEqual({ refreshToken: 'RT2' });
    expect(dropSpy).toHaveBeenCalledWith(first.id);
    dropSpy.mockRestore();
  });

  it('another user connecting the same address gets their own account', async () => {
    await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c', state: signState(JWT_SECRET, { userId: 'u1', provider: 'google', verifier: 'v' }) });
    await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c', state: signState(JWT_SECRET, { userId: 'u2', provider: 'google', verifier: 'v' }) });
    expect(accounts.listAccounts(db, 'u1').filter(a => a.emailAddress === 'oauth@bb.com')).toHaveLength(1);
    expect(accounts.listAccounts(db, 'u2').filter(a => a.emailAddress === 'oauth@bb.com')).toHaveLength(1);
  });

  it('callback redirects with a safe error and creates nothing when anything is wrong', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM mail_accounts').get() as { n: number };
    const bad = await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c', state: 'garbage' });
    expect(bad.status).toBe(302);
    expect(bad.headers.location).toMatch(/^\/settings\?tab=mail&error=/);

    // A state signed with another secret is rejected the same way.
    expect((await request(app).get('/api/mail/oauth/google/callback')
      .query({ code: 'c', state: signState('other-secret', { userId: 'u1', provider: 'google', verifier: 'v' }) }))
      .headers.location).toMatch(/error=/);

    // The state's provider must match the URL's, or a Google grant could be filed as Microsoft.
    expect((await request(app).get('/api/mail/oauth/microsoft/callback')
      .query({ code: 'c', state: signState(JWT_SECRET, { userId: 'u1', provider: 'google', verifier: 'v' }) }))
      .headers.location).toMatch(/error=/);

    // A denied consent comes back with no code at all.
    expect((await request(app).get('/api/mail/oauth/google/callback')
      .query({ error: 'access_denied', state: signState(JWT_SECRET, { userId: 'u1', provider: 'google', verifier: 'v' }) }))
      .headers.location).toMatch(/error=/);

    // A failed exchange must not leak the code, and must not leave a half-made account.
    oauthStub = async () => { throw new Error('invalid_grant for code c-secret'); };
    const failed = await request(app).get('/api/mail/oauth/google/callback')
      .query({ code: 'c-secret', state: signState(JWT_SECRET, { userId: 'u1', provider: 'google', verifier: 'v' }) });
    expect(failed.headers.location).toMatch(/error=/);
    expect(failed.headers.location).not.toContain('c-secret');
    expect((db.prepare('SELECT COUNT(*) n FROM mail_accounts').get() as { n: number }).n).toBe(before.n);
  });
});
