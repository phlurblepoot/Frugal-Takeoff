// server/mail/sync/engine.ts  (spec §4.2, §3.1, §3 reply-state rule)
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { MailContext } from '../context';
import type { MailAccountRow } from '../accountStore';
import * as accounts from '../accountStore';
import type { Envelope, MailProvider, ProviderFolder } from '../providers/types';
import { AuthExpiredError } from '../providers/types';
import { deriveThreadKey, mergeThreadKeys, normalizeMessageId, stripSubjectPrefixes } from '../threadKey';
import { snippetOf } from '../mime';

export type InboundHook = (ctx: MailContext, ev: { threadKey: string; messageId: string; account: MailAccountRow }) => void;
const inboundHooks: InboundHook[] = [];
export function registerInboundHook(fn: InboundHook): void { inboundHooks.push(fn); }
export function clearInboundHooks(): void { inboundHooks.length = 0; }   // tests

export function upsertFolders(db: Database.Database, accountId: string, folders: ProviderFolder[]): Map<string, string> {
  const map = new Map<string, string>();
  const tx = db.transaction(() => {
    folders.forEach((f, i) => {
      const existing = db.prepare('SELECT id FROM mail_folders WHERE accountId = ? AND providerId = ?').get(accountId, f.providerId) as { id: string } | undefined;
      const id = existing?.id ?? uuidv4();
      if (existing) db.prepare('UPDATE mail_folders SET name = ?, role = ?, unreadCount = COALESCE(?, unreadCount), totalCount = COALESCE(?, totalCount), sortOrder = ? WHERE id = ?')
        .run(f.name, f.role, f.unreadCount ?? null, f.totalCount ?? null, f.sortOrder ?? i, id);
      else db.prepare('INSERT INTO mail_folders (id, accountId, providerId, name, role, unreadCount, totalCount, sortOrder) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, accountId, f.providerId, f.name, f.role, f.unreadCount ?? 0, f.totalCount ?? 0, f.sortOrder ?? i);
      map.set(f.providerId, id);
    });
  });
  tx();
  return map;
}

function folderMap(db: Database.Database, accountId: string): Map<string, string> {
  const m = new Map<string, string>();
  (db.prepare('SELECT id, providerId FROM mail_folders WHERE accountId = ?').all(accountId) as { id: string; providerId: string }[]).forEach(r => m.set(r.providerId, r.id));
  return m;
}

export function isInbound(db: Database.Database, env: Envelope): boolean {
  const own = db.prepare('SELECT 1 FROM mail_accounts WHERE LOWER(emailAddress) = ?').get((env.from?.addr || '').trim().toLowerCase());
  return !own;
}

export function rebuildThread(db: Database.Database, accountId: string, threadKey: string): void {
  const rows = db.prepare('SELECT * FROM mail_messages WHERE accountId = ? AND threadKey = ? ORDER BY date').all(accountId, threadKey) as any[];
  if (!rows.length) { db.prepare('DELETE FROM mail_threads WHERE accountId = ? AND threadKey = ?').run(accountId, threadKey); return; }
  const participants = new Map<string, { addr: string; name?: string }>();
  const folders = new Set<string>();
  let hasAtt = 0, starred = 0, unread = 0;
  let subject = '';
  for (const r of rows) {
    const addrs = [{ addr: r.fromAddr, name: r.fromName }, ...JSON.parse(r.toJson), ...JSON.parse(r.ccJson)];
    addrs.forEach((a: any) => { if (a?.addr && !participants.has(a.addr)) participants.set(a.addr, a.name ? { addr: a.addr, name: a.name } : { addr: a.addr }); });
    JSON.parse(r.folderIdsJson).forEach((f: string) => folders.add(f));
    if (r.hasAttachments) hasAtt = 1; if (r.isStarred) starred = 1; if (!r.isRead) unread++;
    if (!subject && r.subject) subject = stripSubjectPrefixes(r.subject);
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO mail_threads (id, accountId, threadKey, subject, firstDate, lastDate, messageCount, unreadCount, hasAttachments, isStarred, participantsJson, folderIdsJson, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(accountId, threadKey) DO UPDATE SET subject=excluded.subject, firstDate=excluded.firstDate, lastDate=excluded.lastDate, messageCount=excluded.messageCount,
                unreadCount=excluded.unreadCount, hasAttachments=excluded.hasAttachments, isStarred=excluded.isStarred, participantsJson=excluded.participantsJson, folderIdsJson=excluded.folderIdsJson, updatedAt=excluded.updatedAt`)
    .run(uuidv4(), accountId, threadKey, subject, rows[0].date, rows[rows.length - 1].date, rows.length, unread, hasAtt, starred, JSON.stringify([...participants.values()]), JSON.stringify([...folders]), now);
}

// opts.sessionId: when this upsert is the direct result of a request (a send),
// the originating tab's x-session-id rides along on the broadcasts so it does
// not refetch a change it already applied locally.
export function upsertEnvelopes(ctx: MailContext, account: MailAccountRow, envelopes: Envelope[], opts: { sentFromApp?: boolean; sessionId?: string } = {}): { messageIds: string[]; threadKeys: string[] } {
  const { db } = ctx;
  const fmap = folderMap(db, account.id);
  const touched = new Set<string>();
  const mergedAway = new Set<string>();
  const messageIds: string[] = [];
  const inboundEvents: { threadKey: string; messageId: string }[] = [];

  // Prepared once per call, reused across every envelope/candidate in the loop below.
  const lookupStmt = db.prepare('SELECT threadKey FROM mail_messages WHERE accountId = ? AND messageIdHeader = ?');
  const lookup = (mid: string) => (lookupStmt.get(account.id, mid) as { threadKey: string } | undefined)?.threadKey ?? null;
  const orphanStmt = db.prepare('SELECT 1 FROM mail_messages WHERE accountId = ? AND threadKey = ?');
  const existingStmt = db.prepare('SELECT id, threadKey FROM mail_messages WHERE accountId = ? AND providerMessageId = ?');
  const ownAddressStmt = db.prepare('SELECT 1 FROM mail_accounts WHERE LOWER(emailAddress) = ?');
  const updateStmt = db.prepare(`UPDATE mail_messages SET accountId=?, providerMessageId=?, providerThreadId=?, messageIdHeader=?, inReplyTo=?, referencesJson=?, threadKey=?, fromAddr=?, fromName=?, toJson=?, ccJson=?, bccJson=?,
    subject=?, snippet=?, date=?, isRead=?, isStarred=?, isDraft=?, hasAttachments=?, attachmentsJson=?, sizeBytes=?, folderIdsJson=?, sentFromApp=MAX(sentFromApp, ?), updatedAt=? WHERE id=?`);
  const insertStmt = db.prepare(`INSERT INTO mail_messages (accountId, providerMessageId, providerThreadId, messageIdHeader, inReplyTo, referencesJson, threadKey, fromAddr, fromName, toJson, ccJson, bccJson,
    subject, snippet, date, isRead, isStarred, isDraft, hasAttachments, attachmentsJson, sizeBytes, folderIdsJson, sentFromApp, id, createdAt, updatedAt) VALUES (${Array.from({ length: 23 }, () => '?').join(',')}, ?, ?, ?)`);
  const linkedStmt = db.prepare('SELECT 1 FROM mail_thread_links WHERE threadKey = ? LIMIT 1');
  const insertReplyStateStmt = db.prepare('INSERT OR IGNORE INTO mail_thread_reply_state (threadKey, updatedAt) VALUES (?, ?)');
  const updateInboundStmt = db.prepare(`UPDATE mail_thread_reply_state SET lastInboundDate = MAX(COALESCE(lastInboundDate, ''), ?), updatedAt = ? WHERE threadKey = ?`);
  const updateOutboundStmt = db.prepare(`UPDATE mail_thread_reply_state SET lastOutboundDate = MAX(COALESCE(lastOutboundDate, ''), ?), updatedAt = ? WHERE threadKey = ?`);

  const tx = db.transaction(() => {
    for (const env of envelopes) {
      const mid = normalizeMessageId(env.messageIdHeader);
      const { threadKey } = deriveThreadKey(lookup, { messageIdHeader: mid, inReplyTo: env.inReplyTo ?? null, references: env.references ?? [], fallbackSeed: account.id + ':' + env.providerMessageId });

      // Bridge merge (spec §3.1 step 7): fold in ANY existing thread that this
      // message's own chain (references, in-reply-to, or its own id) points
      // at but which didn't resolve to `threadKey` — covers a late-arriving
      // root AND a late-arriving mid-chain message that finally links two
      // previously-separate, independently-keyed groups.
      const candidates = new Set<string>((env.references || []).map(normalizeMessageId).filter((x): x is string => !!x));
      const irt = normalizeMessageId(env.inReplyTo);
      if (irt) candidates.add(irt);
      if (mid) candidates.add(mid);
      for (const c of candidates) {
        if (c === threadKey) continue;
        if (orphanStmt.get(account.id, c)) { mergeThreadKeys(db, account.id, c, threadKey); touched.delete(c); mergedAway.add(c); touched.add(threadKey); }
      }

      const existing = existingStmt.get(account.id, env.providerMessageId) as { id: string; threadKey: string } | undefined;
      const id = existing?.id ?? uuidv4();
      const now = new Date().toISOString();
      const folderIds = (env.folderProviderIds || []).map(p => fmap.get(p)).filter((x): x is string => !!x);
      const values = [account.id, env.providerMessageId, env.providerThreadId ?? null, mid, normalizeMessageId(env.inReplyTo), JSON.stringify((env.references || []).map(normalizeMessageId).filter(Boolean)), threadKey,
        env.from?.addr?.toLowerCase() ?? null, env.from?.name ?? null, JSON.stringify(env.to || []), JSON.stringify(env.cc || []), JSON.stringify(env.bcc || []),
        env.subject || '', snippetOf(env.snippet || ''), env.date, env.isRead ? 1 : 0, env.isStarred ? 1 : 0, env.isDraft ? 1 : 0,
        env.attachments?.length ? 1 : 0, JSON.stringify(env.attachments || []), env.sizeBytes || 0, JSON.stringify(folderIds), opts.sentFromApp ? 1 : 0];
      if (existing) {
        updateStmt.run(...values, now, id);
        if (existing.threadKey !== threadKey) touched.add(existing.threadKey);
      } else {
        insertStmt.run(...values, id, now, now);
        // Reply-state + hooks only for NEW messages on linked threads.
        const linked = linkedStmt.get(threadKey);
        if (linked) {
          const inbound = !ownAddressStmt.get((env.from?.addr || '').trim().toLowerCase());
          insertReplyStateStmt.run(threadKey, now);
          (inbound ? updateInboundStmt : updateOutboundStmt).run(env.date, now, threadKey);
          if (inbound) inboundEvents.push({ threadKey, messageId: id });
        }
      }
      messageIds.push(id); touched.add(threadKey);
    }
    for (const key of touched) rebuildThread(db, account.id, key);
  });
  tx();
  for (const key of touched) ctx.broadcastChange({ type: 'mailThread', id: key, action: 'updated', byUserId: account.userId, bySessionId: opts.sessionId });
  for (const key of mergedAway) ctx.broadcastChange({ type: 'mailThread', id: key, action: 'deleted', byUserId: account.userId, bySessionId: opts.sessionId });
  for (const ev of inboundEvents) for (const h of inboundHooks) { try { h(ctx, { ...ev, account }); } catch (e) { console.error('[mail] inbound hook failed', e); } }
  return { messageIds, threadKeys: [...touched] };
}

export function removeMessages(ctx: MailContext, account: MailAccountRow, providerMessageIds: string[]): void {
  const { db } = ctx; const touched = new Set<string>();
  db.transaction(() => {
    for (const pid of providerMessageIds) {
      const row = db.prepare('SELECT threadKey FROM mail_messages WHERE accountId = ? AND providerMessageId = ?').get(account.id, pid) as { threadKey: string } | undefined;
      if (!row) continue;
      db.prepare('DELETE FROM mail_messages WHERE accountId = ? AND providerMessageId = ?').run(account.id, pid);
      touched.add(row.threadKey);
    }
    for (const key of touched) rebuildThread(db, account.id, key);
  })();
  for (const key of touched) ctx.broadcastChange({ type: 'mailThread', id: key, action: 'updated', byUserId: account.userId });
}

async function guarded(ctx: MailContext, account: MailAccountRow, fn: () => Promise<void>): Promise<void> {
  try { await fn(); accounts.updateAccount(ctx.db, account.id, { status: 'ok', lastSyncAt: new Date().toISOString(), lastError: null }); }
  catch (e: any) {
    if (e instanceof AuthExpiredError) accounts.updateAccount(ctx.db, account.id, { status: 'auth_error', lastError: e.message });
    else accounts.updateAccount(ctx.db, account.id, { lastError: e?.message || String(e) });
    throw e;
  } finally { ctx.broadcastChange({ type: 'mailAccount', id: account.id, action: 'updated', byUserId: account.userId }); }
}

export async function runBackfill(ctx: MailContext, account: MailAccountRow, provider: MailProvider, since?: Date): Promise<void> {
  await guarded(ctx, account, async () => {
    accounts.updateAccount(ctx.db, account.id, { status: 'syncing' });
    upsertFolders(ctx.db, account.id, await provider.listFolders());
    let cursor: string | undefined; const from = since ?? new Date(account.indexedSince);
    do {
      const page = await provider.backfill({ since: from, cursor });
      upsertEnvelopes(ctx, account, page.messages);
      cursor = page.cursor; if (page.done) break;
    } while (cursor);
    // Establish the incremental baseline so history starts "now".
    const r = await provider.incremental(JSON.parse(account.syncState || '{}'));
    upsertEnvelopes(ctx, account, r.upserts);
    accounts.updateAccount(ctx.db, account.id, { syncState: JSON.stringify(r.state) });
  });
}

export async function runIncremental(ctx: MailContext, account: MailAccountRow, provider: MailProvider): Promise<void> {
  await guarded(ctx, account, async () => {
    const fresh = accounts.getAccountAny(ctx.db, account.id)!;
    const r = await provider.incremental(JSON.parse(fresh.syncState || '{}'));
    if (r.upserts.length) { upsertFolders(ctx.db, account.id, await provider.listFolders()); upsertEnvelopes(ctx, account, r.upserts); }
    if (r.deletes.length) removeMessages(ctx, account, r.deletes);
    accounts.updateAccount(ctx.db, account.id, { syncState: JSON.stringify(r.state) });
  });
}
