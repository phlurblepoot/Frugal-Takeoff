// server/mail/routes.ts  (spec §4.4)
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { MailContext } from './context';
import * as accounts from './accountStore';
import { upsertEnvelopes, rebuildThread, runBackfill } from './sync/engine';
import { sanitizeEmailHtml } from './sanitize';
import { htmlToText, newMessageIdHeader } from './mime';
import { send, MailSendError } from './sendService';
import { createLink, deleteLink, listLinksForItem, listLinksForThread, type ItemType } from './links';
import { stageUpload } from './uploads';
import { buildAuthUrl, createVerifier, challengeOf, signState, verifyState, exchangeCode, isOAuthProvider, redactGrant, redirectUri } from './oauth';
import { putBuffer } from '../files';
import { listCustomers } from '../customerStore';
import type { BodyCache } from './sync/bodyCache';
import type { AttachmentMeta, Addr, MailProvider, MoveResult } from './providers/types';
import { AuthExpiredError } from './providers/types';

export interface BodyPayload { html: string; text: string; blockedRemoteImages: number; attachments: AttachmentMeta[] }
export interface MailRouteDeps {
  ctx: MailContext;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  verifyToken: (token: string) => { id: string; role: string } | null;
  bodyCache: BodyCache<BodyPayload>;
  publicUrl: string | null;
  env: NodeJS.ProcessEnv;
  /** The app's own JWT secret — signs the OAuth `state` envelope. */
  jwtSecret: string;
  /** Injectable so route tests never reach a real provider. */
  oauthExchange?: typeof exchangeCode;
}

// The runtime twin of the ItemType union — typed as ItemType[] so a typo here is a compile error.
const ITEM_TYPES: readonly ItemType[] = ['proposal', 'invoice', 'changeOrder', 'payApp', 'issue', 'rfi', 'dailyReport', 'punch', 'task', 'project', 'customer'];
const isItemType = (v: unknown): v is ItemType => typeof v === 'string' && (ITEM_TYPES as readonly string[]).includes(v);

const ACTIONS = ['read', 'unread', 'star', 'unstar', 'archive', 'trash', 'move'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (v: unknown): v is Action => typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);

/* eslint-disable @typescript-eslint/no-explicit-any */
type MessageRowRaw = any;

// mail_messages row → client shape: JSON columns parsed, provider ids withheld.
const parseRow = (r: MessageRowRaw) => ({
  id: r.id, accountId: r.accountId, threadKey: r.threadKey, messageIdHeader: r.messageIdHeader, inReplyTo: r.inReplyTo,
  references: JSON.parse(r.referencesJson || '[]'),
  from: r.fromAddr ? { addr: r.fromAddr, name: r.fromName ?? undefined } : null,
  to: JSON.parse(r.toJson), cc: JSON.parse(r.ccJson), bcc: JSON.parse(r.bccJson),
  subject: r.subject, snippet: r.snippet, date: r.date,
  isRead: !!r.isRead, isStarred: !!r.isStarred, isDraft: !!r.isDraft, hasAttachments: !!r.hasAttachments,
  attachments: JSON.parse(r.attachmentsJson), sizeBytes: r.sizeBytes, folderIds: JSON.parse(r.folderIdsJson), sentFromApp: !!r.sentFromApp,
});

export function registerMailRoutes(app: express.Express, deps: MailRouteDeps): void {
  const { ctx, authenticateToken, requireAdmin } = deps;
  const { db } = ctx;
  const userOf = (req: express.Request) => (req as any).user as { id: string; role: string };
  const owned = (req: express.Request, accountId: string) => accounts.getOwned(db, userOf(req).id, accountId);
  const providerFor = (accountId: string): MailProvider => ctx.scheduler
    ? ctx.scheduler.getProvider(accountId)
    : ctx.providerFactory(accounts.getAccountAny(db, accountId)!, accounts.readAuth(db, ctx.crypto, accountId)!);
  const ownedMessage = (req: express.Request, id: string): MessageRowRaw | undefined =>
    db.prepare('SELECT m.* FROM mail_messages m JOIN mail_accounts a ON a.id = m.accountId WHERE m.id = ? AND a.userId = ?').get(id, userOf(req).id);

  // Mirrors /api/files/:id/content: <img>/<a download> can't set an Authorization header.
  const authOrQueryToken: express.RequestHandler = (req, res, next) => {
    const t = typeof req.query.token === 'string' ? req.query.token : null;
    if (t) {
      const u = deps.verifyToken(t);
      if (!u) return res.status(401).json({ error: 'Invalid token' });
      (req as any).user = u;
      return next();
    }
    return authenticateToken(req, res, next);
  };

  const fail = (res: express.Response, e: any, fallback: string) => {
    if (e instanceof MailSendError) return res.status(e.status).json({ error: e.message });
    if (e instanceof AuthExpiredError) return res.status(409).json({ error: 'Mail account needs to be reconnected', code: 'auth_error' });
    // Spec §7: a provider's raw error can carry hosts, credentials or internal
    // detail. The client gets a fixed string; the detail stays in the log.
    console.error(fallback, e);
    return res.status(502).json({ error: 'Mail provider request failed' });
  };

  // NodeJS.ReadableStream has no destroy() in its type; provider streams are
  // real Readables, so release the socket when we stop reading early.
  const endStream = (stream: NodeJS.ReadableStream) => { (stream as { destroy?: () => void }).destroy?.(); };
  const itemError = (e: unknown) =>
    e instanceof MailSendError ? e.message
      : e instanceof AuthExpiredError ? 'Mail account needs to be reconnected'
        : 'Could not save this attachment';

  // ── accounts ──
  app.get('/api/mail/accounts', authenticateToken, (req, res) => {
    const unread = db.prepare(`SELECT COALESCE(SUM(t.unreadCount), 0) n FROM mail_threads t
      JOIN mail_folders f ON f.accountId = t.accountId AND f.role = 'inbox'
      WHERE t.accountId = ? AND instr(t.folderIdsJson, '"' || f.id || '"') > 0`);
    res.json(accounts.listAccounts(db, userOf(req).id).map(a => ({ ...a, unreadCount: (unread.get(a.id) as { n: number }).n })));
  });

  app.post('/api/mail/accounts/imap', authenticateToken, (req, res) => {
    const b = req.body ?? {};
    for (const k of ['emailAddress', 'imapHost', 'smtpHost', 'username']) {
      if (typeof b[k] !== 'string' || !b[k].trim()) return res.status(400).json({ error: `${k} is required` });
    }
    const auth: accounts.ImapAuth = {
      imapHost: b.imapHost.trim(), imapPort: Number(b.imapPort) || 993, imapSecure: b.imapSecure !== false,
      smtpHost: b.smtpHost.trim(), smtpPort: Number(b.smtpPort) || 587, smtpSecure: !!b.smtpSecure,
      username: b.username.trim(), password: String(b.password ?? ''),
    };
    if (typeof b.id === 'string') {
      const a = owned(req, b.id);
      if (!a) return res.status(404).json({ error: 'Account not found' });
      const prev = accounts.readAuth(db, ctx.crypto, a.id) as accounts.ImapAuth | null;
      if (!auth.password) auth.password = prev?.password ?? '';   // blank on update = keep the stored one
      accounts.updateAuth(db, ctx.crypto, a.id, auth);
      accounts.updateAccount(db, a.id, { emailAddress: b.emailAddress.trim().toLowerCase(), displayName: b.displayName ?? a.displayName, status: 'needs_review' });
      ctx.scheduler?.stopAccount(a.id);
      ctx.scheduler?.dropProvider(a.id);
      return res.json(accounts.getAccountAny(db, a.id));
    }
    if (!auth.password) return res.status(400).json({ error: 'password is required' });
    const a = accounts.createAccount(db, ctx.crypto, {
      userId: userOf(req).id, provider: deps.env.MAIL_FAKE_PROVIDER === '1' ? 'fake' : 'imap',
      emailAddress: b.emailAddress, displayName: b.displayName ?? null, auth, status: 'needs_review',
    });
    res.json(a);
  });

  app.post('/api/mail/accounts/:id/test', authenticateToken, async (req, res) => {
    const a = owned(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'Account not found' });
    try {
      ctx.scheduler?.dropProvider(a.id);   // re-read the credentials just written
      await providerFor(a.id).listFolders();
      accounts.updateAccount(db, a.id, { status: 'ok', lastError: null });
      ctx.scheduler?.startAccount(a.id);
      ctx.broadcastChange({ type: 'mailAccount', id: a.id, action: 'updated', byUserId: a.userId });
      res.json({ ok: true });
    } catch (e: any) {
      accounts.updateAccount(db, a.id, { lastError: e?.message || 'Connection failed' });
      res.status(400).json({ error: e?.message || 'Connection failed' });
    }
  });

  app.patch('/api/mail/accounts/:id', authenticateToken, (req, res) => {
    const a = owned(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'Account not found' });
    const b = req.body ?? {};
    const patch: Parameters<typeof accounts.updateAccount>[2] = {};
    if (typeof b.displayName === 'string') patch.displayName = b.displayName;
    if (typeof b.signatureHtml === 'string') patch.signatureHtml = b.signatureHtml;
    if (b.status === 'disabled') { patch.status = 'disabled'; ctx.scheduler?.stopAccount(a.id); }
    else if (b.status === 'ok' && a.status === 'disabled') { patch.status = 'ok'; }
    accounts.updateAccount(db, a.id, patch);
    if (patch.status === 'ok') ctx.scheduler?.startAccount(a.id);   // only after the row says 'ok'
    if (b.isDefault === true) accounts.setDefault(db, a.userId, a.id);
    ctx.broadcastChange({ type: 'mailAccount', id: a.id, action: 'updated', byUserId: a.userId });
    res.json(accounts.getAccountAny(db, a.id));
  });

  app.delete('/api/mail/accounts/:id', authenticateToken, (req, res) => {
    const a = owned(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'Account not found' });
    // Stop the worker and drop the cached provider BEFORE the row goes away —
    // a live worker would otherwise tick against a deleted account.
    ctx.scheduler?.stopAccount(a.id);
    ctx.scheduler?.dropProvider(a.id);
    accounts.deleteAccount(db, a.id);
    ctx.broadcastChange({ type: 'mailAccount', id: a.id, action: 'deleted', byUserId: a.userId });
    res.json({ ok: true });
  });

  app.post('/api/mail/accounts/:id/load-older', authenticateToken, (req, res) => {
    const a = owned(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'Account not found' });
    const months = Math.min(60, Math.max(1, Number(req.body?.months) || 6));
    const newSince = new Date(new Date(a.indexedSince).getTime() - months * 30 * 86400000).toISOString();
    accounts.updateAccount(db, a.id, { indexedSince: newSince });
    // Resolve the account row and provider BEFORE responding: a throw here after
    // res.json() would be an unhandled error on an already-sent response.
    const fresh = accounts.getAccountAny(db, a.id)!;
    let provider: MailProvider;
    try { provider = providerFor(a.id); } catch (e) { return fail(res, e, 'Could not reach the mail account'); }
    res.json({ indexedSince: newSince });
    // Backfill only the newly opened window, in the background.
    runBackfill(ctx, fresh, provider, new Date(newSince)).catch(e => console.error('[mail] load-older backfill failed', e));
  });

  // ── OAuth connect (see oauth.ts for why state is a signed JWT) ──
  // The browser NAVIGATES here, so it cannot send an Authorization header —
  // ?token= is accepted exactly as the attachment routes do.
  app.get('/api/mail/oauth/:provider/start', authOrQueryToken, (req, res) => {
    const provider = req.params.provider;
    if (!isOAuthProvider(provider)) return res.status(400).json({ error: 'Unknown mail provider' });
    // Without a public origin there is no redirect URI to register or return to.
    if (!deps.publicUrl) return res.status(503).json({ error: 'APP_PUBLIC_URL is not set — see Settings → Mail → Server setup guide' });
    const verifier = createVerifier();
    let url: string;
    try {
      url = buildAuthUrl(provider, deps.env, deps.publicUrl, signState(deps.jwtSecret, { userId: userOf(req).id, provider, verifier }), challengeOf(verifier));
    } catch (e: any) {
      // A missing client id/secret is a deployment gap, not a request error.
      return res.status(503).json({ error: e?.message || 'This mail provider is not configured' });
    }
    // The ?token= above sits in THIS url, and a browser sends the redirecting
    // url as the Referer of the hop it takes next — which would hand the app's
    // session token to the provider. Suppress it for this response only.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(url);
  });

  // No auth middleware: the browser arrives from the provider. The signed state
  // is what says who started the flow — and it is the ONLY thing trusted here.
  app.get('/api/mail/oauth/:provider/callback', async (req, res) => {
    const settings = (params: string) => res.redirect(`/settings?tab=mail&${params}`);
    // Never let a provider's text (or ours) carry a grant back into the URL bar.
    const failed = (message: string) => settings(`error=${encodeURIComponent(message.slice(0, 300))}`);
    const provider = req.params.provider;
    if (!isOAuthProvider(provider)) return failed('Unknown mail provider');
    if (!deps.publicUrl) return failed('APP_PUBLIC_URL is not set on this server');
    // Consent was declined or the provider bailed: its own error code is not
    // reflected back, only that it did not complete.
    if (req.query.error) return failed('The mail provider did not complete the sign-in — please try again');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const rawState = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !rawState) return failed('That sign-in did not come back with everything we need — please try again');
    let state: ReturnType<typeof verifyState>;
    try { state = verifyState(deps.jwtSecret, rawState); }
    catch { return failed('That sign-in link expired or was not issued by this app — please try connecting again'); }
    // A Google grant must never be filed as a Microsoft account.
    if (state.provider !== provider) return failed('That sign-in did not match the provider it started from');

    try {
      const exchange = deps.oauthExchange ?? exchangeCode;
      const r = await exchange(provider, deps.env, deps.publicUrl, code, state.verifier, undefined);
      const { refreshToken, name } = r;
      // createAccount stores addresses folded; fold here too or a reconnect
      // whose provider answered with different casing would miss and duplicate.
      const email = r.email.trim().toLowerCase();
      // Reconnecting the SAME mailbox updates the account in place — a second
      // row would double every sync and split the user's threads.
      const existing = accounts.listAccounts(db, state.userId)
        .find(a => a.provider === provider && a.emailAddress === email);
      let id: string;
      if (existing) {
        accounts.updateAuth(db, ctx.crypto, existing.id, { refreshToken });
        accounts.updateAccount(db, existing.id, { status: 'ok', lastError: null });
        // A live worker captured its provider — holding the OLD refresh token —
        // when it started, and startAccount() no-ops while that worker exists.
        // Stop it and drop the cache, or the reconnect changes nothing and the
        // next AuthExpiredError stops the worker for good.
        ctx.scheduler?.stopAccount(existing.id);
        ctx.scheduler?.dropProvider(existing.id);
        id = existing.id;
      } else {
        id = accounts.createAccount(db, ctx.crypto, {
          userId: state.userId, provider, emailAddress: email, displayName: name ?? null,
          auth: { refreshToken }, status: 'ok',
        }).id;
      }
      ctx.scheduler?.startAccount(id);
      ctx.broadcastChange({ type: 'mailAccount', id, action: existing ? 'updated' : 'created', byUserId: state.userId });
      settings(`connected=${encodeURIComponent(id)}`);
    } catch (e: any) {
      // The detail (which may name the grant) stays in the log; the user gets
      // the provider's own summary with the code and verifier already scrubbed.
      console.error('[mail] oauth callback failed', e);
      // redactGrant again (not only inside exchangeCode) so ANY thrower —
      // including a provider client we swap in later — is covered.
      failed(redactGrant(e?.message || 'Could not connect that mailbox', code, state.verifier));
    }
  });

  // Which OAuth providers the deployment has credentials for (never the values).
  app.get('/api/mail/providers', authenticateToken, (_req, res) => res.json({
    google: !!(deps.env.GOOGLE_OAUTH_CLIENT_ID && deps.env.GOOGLE_OAUTH_CLIENT_SECRET),
    microsoft: !!(deps.env.MS_OAUTH_CLIENT_ID && deps.env.MS_OAUTH_CLIENT_SECRET),
  }));

  // ── folders / threads / messages ──
  app.get('/api/mail/folders', authenticateToken, (req, res) => {
    const a = owned(req, String(req.query.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    res.json(db.prepare('SELECT * FROM mail_folders WHERE accountId = ? ORDER BY sortOrder, name').all(a.id));
  });

  const linksFor = (keys: string[]): Map<string, any[]> => {
    const out = new Map<string, any[]>();
    if (!keys.length) return out;
    const rows = db.prepare(`SELECT id, threadKey, itemType, itemId, projectId, customerId FROM mail_thread_links WHERE threadKey IN (${keys.map(() => '?').join(',')})`).all(...keys) as any[];
    for (const l of rows) { const arr = out.get(l.threadKey) ?? []; arr.push(l); out.set(l.threadKey, arr); }
    return out;
  };
  const lastSnippet = db.prepare('SELECT snippet FROM mail_messages WHERE accountId = ? AND threadKey = ? ORDER BY date DESC LIMIT 1');
  const threadRow = (t: any, links: Map<string, any[]>) => ({
    threadKey: t.threadKey, subject: t.subject, firstDate: t.firstDate, lastDate: t.lastDate,
    messageCount: t.messageCount, unreadCount: t.unreadCount, hasAttachments: t.hasAttachments, isStarred: t.isStarred,
    participants: JSON.parse(t.participantsJson), folderIds: JSON.parse(t.folderIdsJson),
    snippet: (lastSnippet.get(t.accountId, t.threadKey) as { snippet: string } | undefined)?.snippet ?? '',
    links: links.get(t.threadKey) ?? [],
  });

  app.get('/api/mail/threads', authenticateToken, (req, res) => {
    const a = owned(req, String(req.query.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    const folderId = typeof req.query.folderId === 'string' ? req.query.folderId : null;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const where = ['t.accountId = ?'];
    const params: unknown[] = [a.id];
    // Folder ids are uuids inside a JSON array, so matching the QUOTED id is exact.
    if (folderId) { where.push('instr(t.folderIdsJson, ?) > 0'); params.push(`"${folderId}"`); }
    if (before) { where.push('t.lastDate < ?'); params.push(before); }
    if (q) {
      where.push(`EXISTS (SELECT 1 FROM mail_messages m WHERE m.accountId = t.accountId AND m.threadKey = t.threadKey
        AND (lower(m.subject) LIKE ? OR lower(COALESCE(m.fromAddr, '')) LIKE ? OR lower(COALESCE(m.fromName, '')) LIKE ? OR lower(m.snippet) LIKE ? OR lower(m.toJson) LIKE ?))`);
      params.push(...Array(5).fill(`%${q}%`));
    }
    const rows = db.prepare(`SELECT * FROM mail_threads t WHERE ${where.join(' AND ')} ORDER BY t.lastDate DESC LIMIT ?`).all(...params, limit + 1) as any[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const links = linksFor(page.map(p => p.threadKey));
    res.json({ threads: page.map(t => threadRow(t, links)), hasMore, indexedSince: a.indexedSince });
  });

  app.get('/api/mail/threads/:accountId/:threadKey', authenticateToken, (req, res) => {
    const a = owned(req, req.params.accountId);
    if (!a) return res.status(404).json({ error: 'Account not found' });
    const t = db.prepare('SELECT * FROM mail_threads WHERE accountId = ? AND threadKey = ?').get(a.id, req.params.threadKey) as any;
    if (!t) return res.status(404).json({ error: 'Thread not found' });
    const messages = (db.prepare('SELECT * FROM mail_messages WHERE accountId = ? AND threadKey = ? ORDER BY date').all(a.id, t.threadKey) as any[]).map(parseRow);
    res.json({ thread: threadRow(t, linksFor([t.threadKey])), messages, links: listLinksForThread(db, t.threadKey) });
  });

  // A message the provider could not name yet (see Envelope.replacesProviderMessageId):
  // the send went out, but the copy has not been filed where we can read it
  // back, so asking the provider for it would 404 on the user's OWN message.
  const isPending = (m: MessageRowRaw): boolean => String(m.providerMessageId || '').startsWith('sent:');

  app.get('/api/mail/messages/:id/body', authenticateToken, async (req, res) => {
    const m = ownedMessage(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'Message not found' });
    // 202, not an error: this resolves itself on the next sync, and the client
    // shows "Sending…" rather than a failure.
    if (isPending(m)) return res.status(202).json({ pending: true });
    const allowImages = req.query.images === '1';
    const key = `${m.id}:${allowImages ? 1 : 0}`;
    const hit = deps.bodyCache.get(key);
    if (hit) return res.json(hit);
    try {
      const raw = await providerFor(m.accountId).getBody(m.providerMessageId);
      const attachmentUrl = (cid: string) => {
        const att = raw.attachments.find(x => (x.contentId || '').replace(/^<|>$/g, '') === cid);
        return att ? `/api/mail/messages/${m.id}/attachments/${encodeURIComponent(att.attId)}?inline=1` : null;
      };
      const escaped = (raw.text || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
      const html = raw.html
        ? sanitizeEmailHtml(raw.html, { attachmentUrl, allowRemoteImages: allowImages })
        : { html: `<pre style="white-space:pre-wrap;font-family:inherit">${escaped}</pre>`, blockedRemoteImages: 0 };
      const payload: BodyPayload = { html: html.html, text: raw.text ?? htmlToText(raw.html ?? ''), blockedRemoteImages: html.blockedRemoteImages, attachments: raw.attachments };
      deps.bodyCache.set(key, payload, payload.html.length + payload.text.length);
      res.json(payload);
    } catch (e) { fail(res, e, 'Failed to load message'); }
  });

  app.get('/api/mail/messages/:id/attachments/:attId', authOrQueryToken, async (req, res) => {
    const m = ownedMessage(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'Message not found' });
    if (isPending(m)) return res.status(404).json({ error: 'This message is still being filed by the mail server — its attachments will be available in a minute' });
    try {
      const att = await providerFor(m.accountId).getAttachment(m.providerMessageId, req.params.attId);
      res.setHeader('Content-Type', att.mime || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (att.size) res.setHeader('Content-Length', String(att.size));
      res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${(att.name || 'attachment').replace(/["\r\n]/g, '')}"`);
      att.stream.on('error', err => { console.error('[mail] attachment stream failed', err); res.destroy(); });
      // A client that navigates away mid-download closes the response; without
      // this the provider stream keeps pulling bytes nobody will ever read.
      res.on('close', () => { if (!res.writableEnded) endStream(att.stream); });
      att.stream.pipe(res);
    } catch (e) { fail(res, e, 'Failed to load attachment'); }
  });

  app.post('/api/mail/messages/:id/attachments/save', authenticateToken, async (req, res) => {
    const m = ownedMessage(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'Message not found' });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'items required' });
    const metas: AttachmentMeta[] = JSON.parse(m.attachmentsJson);
    // Per item, not all-or-nothing: one bad attachment used to abort the whole
    // request with a 502, leaving the items already written to Documents saved
    // and broadcast but invisible to a client that got no fileIds back.
    const fileIds: string[] = [];
    const saved: Array<{ attId: string; fileId: string }> = [];
    const failed: Array<{ attId: string; error: string }> = [];
    for (const it of items) {
      const meta = metas.find(x => x.attId === it.attId);
      if (!meta) { failed.push({ attId: String(it?.attId ?? ''), error: 'That attachment is not on this message' }); continue; }
      try {
        const att = await providerFor(m.accountId).getAttachment(m.providerMessageId, it.attId);
        const chunks: Buffer[] = [];
        let total = 0;
        try {
          for await (const c of att.stream as AsyncIterable<Buffer>) {
            total += c.length;
            if (total > 100 * 1024 * 1024) throw new MailSendError('Attachment exceeds 100 MB', 413);
            chunks.push(c);
          }
        } catch (e) { endStream(att.stream); throw e; }
        // 'email-attachment' is a MULTI_INSTANCE kind, so several attachments off
        // one message stay separate documents instead of versioning each other.
        const r = putBuffer(db, ctx.dataDir, uuidv4(), Buffer.concat(chunks), att.mime, {
          projectId: it.projectId || undefined, customerId: it.customerId || undefined,
          kind: typeof it.kind === 'string' && it.kind ? it.kind : 'email-attachment',
          name: it.name || meta.name, sourceType: 'mailMessage', sourceId: m.id,
        });
        fileIds.push(r.id);
        saved.push({ attId: meta.attId, fileId: r.id });
        ctx.broadcastChange({ type: 'file', id: r.id, projectId: it.projectId || undefined, action: 'created', byUserId: userOf(req).id });
      } catch (e) {
        console.error('[mail] could not save attachment', meta.attId, e);
        failed.push({ attId: meta.attId, error: itemError(e) });
      }
    }
    res.json({ fileIds, saved, failed });
  });

  // ── actions (optimistic local write, provider call, revert on failure) ──
  async function applyAction(req: express.Request, rows: MessageRowRaw[], action: Action, folderId?: string): Promise<void> {
    if (!rows.length) return;
    const byAccount = new Map<string, MessageRowRaw[]>();
    for (const r of rows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);
    for (const [accountId, list] of byAccount) {
      const snapshot = list.map(r => ({ id: r.id, isRead: r.isRead, isStarred: r.isStarred, folderIdsJson: r.folderIdsJson }));
      const roleFolder = (role: string) => db.prepare('SELECT id, providerId FROM mail_folders WHERE accountId = ? AND role = ?').get(accountId, role) as { id: string; providerId: string } | undefined;
      const target = action === 'archive' ? roleFolder('archive')
        : action === 'trash' ? roleFolder('trash')
          : action === 'move' ? db.prepare('SELECT id, providerId FROM mail_folders WHERE id = ? AND accountId = ?').get(folderId, accountId) as { id: string; providerId: string } | undefined
            : null;
      if ((action === 'archive' || action === 'trash' || action === 'move') && !target) throw new MailSendError('Folder not found', 400);
      const keys = new Set<string>(list.map(r => r.threadKey));
      db.transaction(() => {
        for (const r of list) {
          if (action === 'read' || action === 'unread') db.prepare('UPDATE mail_messages SET isRead = ? WHERE id = ?').run(action === 'read' ? 1 : 0, r.id);
          else if (action === 'star' || action === 'unstar') db.prepare('UPDATE mail_messages SET isStarred = ? WHERE id = ?').run(action === 'star' ? 1 : 0, r.id);
          else db.prepare('UPDATE mail_messages SET folderIdsJson = ? WHERE id = ?').run(JSON.stringify([target!.id]), r.id);
        }
        for (const k of keys) rebuildThread(db, accountId, k);
      })();
      try {
        const p = providerFor(accountId);
        const ids = list.map(r => r.providerMessageId);
        let moved: MoveResult[] | null = null;
        if (action === 'read' || action === 'unread') await p.setFlags(ids, { read: action === 'read' });
        else if (action === 'star' || action === 'unstar') await p.setFlags(ids, { starred: action === 'star' });
        else if (action === 'archive') moved = await p.archive(ids);
        else if (action === 'trash') moved = await p.trash(ids);
        else moved = await p.move(ids, target!.providerId);
        // A moved message usually has a NEW provider id (an IMAP MOVE re-numbers
        // it). Re-key the row now, or the next poll indexes the moved copy as a
        // second message and the old row points at nothing.
        if (moved?.length) {
          const byFrom = new Map(list.map(r => [r.providerMessageId, r]));
          try {
            db.transaction(() => {
              for (const m of moved!) {
                const row = byFrom.get(m.from);
                if (!row || m.to === m.from) continue;
                if (m.to) db.prepare('UPDATE mail_messages SET providerMessageId = ?, folderIdsJson = ? WHERE id = ?').run(m.to, JSON.stringify([target!.id]), row.id);
                // Trashed and untraceable: the server copy can no longer be
                // addressed, so keeping a local row would only ever be a ghost.
                else if (action === 'trash') db.prepare('DELETE FROM mail_messages WHERE id = ?').run(row.id);
              }
              for (const k of keys) rebuildThread(db, accountId, k);
            })();
          } catch (e) {
            // The move itself succeeded — never unwind it over bookkeeping.
            console.error('[mail] could not re-key moved messages', e);
          }
        }
      } catch (e) {
        db.transaction(() => {
          for (const s of snapshot) db.prepare('UPDATE mail_messages SET isRead = ?, isStarred = ?, folderIdsJson = ? WHERE id = ?').run(s.isRead, s.isStarred, s.folderIdsJson, s.id);
          for (const k of keys) rebuildThread(db, accountId, k);
        })();
        throw e;
      } finally {
        for (const k of keys) ctx.broadcastChange({ type: 'mailThread', id: k, action: 'updated', byUserId: userOf(req).id });
      }
    }
  }

  app.post('/api/mail/messages/actions', authenticateToken, async (req, res) => {
    if (!isAction(req.body?.action)) return res.status(400).json({ error: 'Unknown action' });
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const rows = ids.map(id => ownedMessage(req, id)).filter((r): r is MessageRowRaw => !!r);
    if (ids.length && !rows.length) return res.status(404).json({ error: 'Message not found' });
    try { await applyAction(req, rows, req.body.action, req.body?.folderId); res.json({ ok: true }); }
    catch (e) { fail(res, e, 'Action failed'); }
  });

  app.post('/api/mail/threads/actions', authenticateToken, async (req, res) => {
    if (!isAction(req.body?.action)) return res.status(400).json({ error: 'Unknown action' });
    const a = owned(req, String(req.body?.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    const keys: string[] = Array.isArray(req.body?.threadKeys) ? req.body.threadKeys : [];
    const rows = keys.length
      ? db.prepare(`SELECT * FROM mail_messages WHERE accountId = ? AND threadKey IN (${keys.map(() => '?').join(',')})`).all(a.id, ...keys) as MessageRowRaw[]
      : [];
    try { await applyAction(req, rows, req.body.action, req.body?.folderId); res.json({ ok: true }); }
    catch (e) { fail(res, e, 'Action failed'); }
  });

  // ── send / drafts / uploads / provider search ──
  app.post('/api/mail/send', authenticateToken, async (req, res) => {
    const b = req.body ?? {};
    // Validate the item tags BEFORE the provider is handed the message: an unknown
    // itemType reaches resolveChain/applySendEffects only after the mail is already
    // irretrievably sent, so rejecting it here is the only place it costs nothing.
    if (!Array.isArray(b.to) || !b.to.length) return res.status(400).json({ error: 'At least one recipient is required' });
    const tagged: unknown[] = [
      ...(Array.isArray(b.links) ? b.links : []).map((l: any) => l?.itemType),
      ...(Array.isArray(b.attachments) ? b.attachments : []).map((a: any) => a?.itemType).filter((t: unknown) => t !== undefined && t !== null),
    ];
    if (tagged.some(t => !isItemType(t))) return res.status(400).json({ error: 'Invalid itemType' });
    // sessionId comes from the header, never the body — the sender's own tab is
    // identified by the request, not by what it claims.
    try { res.json(await send(ctx, userOf(req), { ...b, sessionId: req.get('x-session-id') || undefined })); }
    catch (e) { fail(res, e, 'Send failed'); }
  });

  const draftMsg = (a: accounts.MailAccountRow, b: any) => ({
    from: a.displayName ? { addr: a.emailAddress, name: a.displayName } : { addr: a.emailAddress },
    to: b.to ?? [], cc: b.cc ?? [], bcc: b.bcc ?? [], subject: b.subject ?? '', html: b.html ?? '', text: htmlToText(b.html ?? ''),
    attachments: [], messageIdHeader: newMessageIdHeader(a.emailAddress.split('@')[1] || 'localhost'),
  });
  app.post('/api/mail/drafts', authenticateToken, async (req, res) => {
    const a = owned(req, String(req.body?.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    try { const r = await providerFor(a.id).saveDraft(draftMsg(a, req.body)); res.json({ draftId: r.providerMessageId }); }
    catch (e) { fail(res, e, 'Draft save failed'); }
  });
  app.put('/api/mail/drafts/:id', authenticateToken, async (req, res) => {
    const a = owned(req, String(req.body?.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    try { const r = await providerFor(a.id).saveDraft(draftMsg(a, req.body), req.params.id); res.json({ draftId: r.providerMessageId }); }
    catch (e) { fail(res, e, 'Draft save failed'); }
  });
  app.delete('/api/mail/drafts/:id', authenticateToken, async (req, res) => {
    const a = owned(req, String(req.query.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    try { await providerFor(a.id).deleteDraft(req.params.id); res.json({ ok: true }); }
    catch (e) { fail(res, e, 'Draft delete failed'); }
  });

  app.post('/api/mail/uploads', authenticateToken, express.raw({ type: () => true, limit: '100mb' }), (req, res) => {
    const name = typeof req.query.name === 'string' && req.query.name ? req.query.name : 'attachment';
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty upload body' });
    const { uploadId } = stageUpload(ctx.dataDir, name, req.get('content-type') || 'application/octet-stream', req.body as Buffer);
    res.json({ uploadId });
  });

  // Server-side search for mail older than the local index window.
  app.get('/api/mail/search', authenticateToken, async (req, res) => {
    const a = owned(req, String(req.query.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    try {
      const hits = await providerFor(a.id).search(String(req.query.q || ''), {
        before: typeof req.query.before === 'string' ? new Date(req.query.before) : new Date(a.indexedSince), limit: 50,
      });
      upsertEnvelopes(ctx, a, hits);
      res.json({ count: hits.length });
    } catch (e) { fail(res, e, 'Search failed'); }
  });

  // ── misc ──
  app.get('/api/mail/recipients', authenticateToken, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const out: Array<Addr & { source: string; customerId?: string; role?: string }> = [];
    for (const c of listCustomers(db)) {
      const emails = (c.emails ?? {}) as Record<string, { to?: string; cc?: string; bcc?: string } | undefined>;
      for (const role of ['general', 'accounting', 'estimating', 'pm']) {
        for (const field of ['to', 'cc'] as const) {
          const raw = emails?.[role]?.[field] ?? '';
          for (const addr of raw.split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
            if (q && !addr.toLowerCase().includes(q) && !c.name.toLowerCase().includes(q)) continue;
            out.push({ addr: addr.toLowerCase(), name: c.contactName || c.name, source: `${c.name} · ${role}`, customerId: c.id, role });
          }
        }
      }
    }
    const recent = db.prepare(`SELECT m.fromAddr addr, MAX(m.fromName) name, MAX(m.date) lastDate FROM mail_messages m
      JOIN mail_accounts a ON a.id = m.accountId
      WHERE a.userId = ? AND m.fromAddr IS NOT NULL AND (lower(m.fromAddr) LIKE ? OR lower(COALESCE(m.fromName, '')) LIKE ?)
      GROUP BY m.fromAddr ORDER BY lastDate DESC LIMIT 20`).all(userOf(req).id, `%${q}%`, `%${q}%`) as { addr: string; name: string | null }[];
    for (const r of recent) if (!out.some(o => o.addr === r.addr)) out.push({ addr: r.addr, name: r.name ?? undefined, source: 'recent' });
    res.json(out.slice(0, 25));
  });

  app.get('/api/mail/unread-count', authenticateToken, (req, res) => {
    const rows = db.prepare(`SELECT t.accountId, SUM(t.unreadCount) n FROM mail_threads t
      JOIN mail_accounts a ON a.id = t.accountId
      JOIN mail_folders f ON f.accountId = t.accountId AND f.role = 'inbox'
      WHERE a.userId = ? AND instr(t.folderIdsJson, '"' || f.id || '"') > 0 GROUP BY t.accountId`).all(userOf(req).id) as { accountId: string; n: number }[];
    const byAccount: Record<string, number> = {};
    let total = 0;
    for (const r of rows) { byAccount[r.accountId] = r.n; total += r.n; }
    res.json({ total, byAccount });
  });

  app.post('/api/mail/heartbeat', authenticateToken, (req, res) => {
    const ids: string[] = Array.isArray(req.body?.accountIds) ? req.body.accountIds : [];
    ctx.scheduler?.markViewed(ids.filter(id => owned(req, id)));
    res.status(204).end();
  });

  // The engine only maintains reply state for threads that were ALREADY linked when
  // a message arrived, so a thread linked after the fact needs its state seeded from
  // the messages it already has.
  const backfillReplyState = (accountId: string, threadKey: string) => {
    const rows = db.prepare('SELECT fromAddr, date FROM mail_messages WHERE accountId = ? AND threadKey = ?').all(accountId, threadKey) as { fromAddr: string | null; date: string }[];
    if (!rows.length) return;
    const own = new Set((db.prepare('SELECT LOWER(emailAddress) e FROM mail_accounts').all() as { e: string }[]).map(r => r.e));
    let inbound: string | null = null;
    let outbound: string | null = null;
    for (const r of rows) {
      if (own.has((r.fromAddr || '').trim().toLowerCase())) { if (!outbound || r.date > outbound) outbound = r.date; }
      else if (!inbound || r.date > inbound) inbound = r.date;
    }
    const now = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO mail_thread_reply_state (threadKey, updatedAt) VALUES (?, ?)').run(threadKey, now);
    db.prepare(`UPDATE mail_thread_reply_state SET
        lastInboundDate = NULLIF(MAX(COALESCE(lastInboundDate, ''), COALESCE(?, '')), ''),
        lastOutboundDate = NULLIF(MAX(COALESCE(lastOutboundDate, ''), COALESCE(?, '')), ''),
        updatedAt = ? WHERE threadKey = ?`).run(inbound, outbound, now, threadKey);
  };

  // Does this user own an account whose index holds that thread? Links themselves are
  // item data everyone on the job can see, but the thread's subject line and participant
  // list are mailbox content — only the mailbox's owner gets those.
  const seesThread = (userId: string, threadKey: string): boolean =>
    !!db.prepare(`SELECT 1 FROM mail_threads t JOIN mail_accounts a ON a.id = t.accountId
                  WHERE t.threadKey = ? AND a.userId = ? LIMIT 1`).get(threadKey, userId);

  app.get('/api/mail/links', authenticateToken, (req, res) => {
    const { itemType, itemId } = req.query;
    if (!isItemType(itemType)) return res.status(400).json({ error: 'Unknown itemType' });
    if (typeof itemId !== 'string' || !itemId) return res.status(400).json({ error: 'itemId is required' });
    const uid = userOf(req).id;
    const visible = new Map<string, boolean>();
    res.json(listLinksForItem(db, itemType, itemId).map(l => {
      let ok = visible.get(l.threadKey);
      if (ok === undefined) { ok = seesThread(uid, l.threadKey); visible.set(l.threadKey, ok); }
      return ok ? l : { ...l, subjectSnapshot: null, participantsJson: null };
    }));
  });

  app.post('/api/mail/links', authenticateToken, (req, res) => {
    const b = req.body ?? {};
    if (!b.threadKey || !b.itemId) return res.status(400).json({ error: 'threadKey, itemType, itemId required' });
    if (!isItemType(b.itemType)) return res.status(400).json({ error: 'Unknown itemType' });
    const t = db.prepare('SELECT t.* FROM mail_threads t JOIN mail_accounts a ON a.id = t.accountId WHERE t.threadKey = ? AND a.userId = ? LIMIT 1').get(b.threadKey, userOf(req).id) as any;
    const link = createLink(db, {
      threadKey: b.threadKey, itemType: b.itemType, itemId: b.itemId, linkedByUserId: userOf(req).id,
      subjectSnapshot: t?.subject ?? null, firstDate: t?.firstDate ?? null, participants: t ? JSON.parse(t.participantsJson) : [],
    });
    if (t) backfillReplyState(t.accountId, b.threadKey);
    res.json(link);
  });

  app.delete('/api/mail/links/:id', authenticateToken, (req, res) => {
    // Anyone could see a link id from the app-wide GET; only the person who made the
    // link (or an admin) may remove it. A link outside that scope is a 404, not a 403,
    // so the route never confirms an id exists to someone who can't touch it.
    const u = userOf(req);
    const row = db.prepare('SELECT linkedByUserId FROM mail_thread_links WHERE id = ?').get(req.params.id) as { linkedByUserId: string } | undefined;
    if (!row || (row.linkedByUserId !== u.id && u.role !== 'admin')) return res.status(404).json({ error: 'Link not found' });
    deleteLink(db, req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/mail/setup-info', authenticateToken, requireAdmin, (_req, res) => {
    // The URIs shown here are the ones an admin pastes into the provider console,
    // so they MUST come from the same builder the real redirect uses.
    const base = deps.publicUrl?.replace(/\/+$/, '') ?? null;
    res.json({
      publicUrl: base,
      google: { configured: !!(deps.env.GOOGLE_OAUTH_CLIENT_ID && deps.env.GOOGLE_OAUTH_CLIENT_SECRET), redirectUri: base ? redirectUri(base, 'google') : null },
      microsoft: {
        configured: !!(deps.env.MS_OAUTH_CLIENT_ID && deps.env.MS_OAUTH_CLIENT_SECRET),
        redirectUri: base ? redirectUri(base, 'microsoft') : null,
        webhookUrl: base ? `${base}/api/mail/ms/webhook` : null,
        tenant: deps.env.MS_OAUTH_TENANT || 'common',
      },
      secretKey: deps.env.MAIL_SECRET_KEY ? 'env' : 'file',
    });
  });
}
