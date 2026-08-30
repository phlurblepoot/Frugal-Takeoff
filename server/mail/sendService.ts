// server/mail/sendService.ts  (spec §4.5)
import type { MailContext } from './context';
import * as accounts from './accountStore';
import { getMeta } from '../files';
import { readFileContent } from '../fileStore';
import type { Addr, OutgoingAttachment, OutgoingMessage } from './providers/types';
import { htmlToText, newMessageIdHeader, snippetOf } from './mime';
import { upsertEnvelopes } from './sync/engine';
import { createLink, type ItemType } from './links';
import { applySendEffects } from './itemSendEffects';
import { readUpload, discardUpload } from './uploads';
import type { EntityChangedEvent } from '../realtime/changeFeed';

export class MailSendError extends Error { constructor(msg: string, public status = 400) { super(msg); } }
export interface SendRequest {
  accountId?: string; to: Addr[]; cc?: Addr[]; bcc?: Addr[]; subject: string; html: string;
  attachments: Array<{ fileId: string; name?: string; itemType?: ItemType; itemId?: string } | { uploadId: string }>;
  replyTo?: { accountId: string; threadKey: string };
  links?: Array<{ itemType: ItemType; itemId: string }>;
  draftProviderId?: string;
  /** The caller's x-session-id, so the tab that sent doesn't refetch its own change. */
  sessionId?: string;
}
export interface SendResult { messageId: string; threadKey: string; accountId: string; effectsSkipped: ItemType[] }

function fileAttachment(ctx: MailContext, fileId: string, name?: string): OutgoingAttachment {
  const meta = getMeta(ctx.db, fileId); const buf = readFileContent(ctx.dataDir, fileId);
  if (!meta || !buf) throw new MailSendError(`Attachment ${fileId} not found`, 400);
  return { name: name || meta.name || 'attachment', mime: meta.mime || 'application/octet-stream', content: buf };
}

export async function send(ctx: MailContext, user: { id: string; role: string }, req: SendRequest): Promise<SendResult> {
  const { db } = ctx;
  if (!req.to?.length) throw new MailSendError('At least one recipient is required');
  // The server picks the account, not the client: an explicit accountId is
  // honoured (scoped to this user), and otherwise we take the first USABLE
  // account preferring the default one. Falling back to the default even when
  // it is auth_error/needs_review is what let the client and the server
  // disagree about who was sending.
  const usable = (a: accounts.MailAccountRow) => a.status === 'ok' || a.status === 'syncing';
  const account = req.accountId
    ? accounts.getOwned(db, user.id, req.accountId)
    : (() => { const ok = accounts.listAccounts(db, user.id).filter(usable); return ok.find(a => a.isDefault) ?? ok[0] ?? null; })();
  if (!account) throw new MailSendError('No usable mail account — connect or activate one in Settings → Mail', 409);
  if (!usable(account)) throw new MailSendError(`Mail account ${account.emailAddress} is ${account.status.replace('_', ' ')} — fix it in Settings → Mail`, 409);
  const provider = ctx.scheduler ? ctx.scheduler.getProvider(account.id) : ctx.providerFactory(account, accounts.readAuth(db, ctx.crypto, account.id)!);

  const attachments: OutgoingAttachment[] = []; const usedUploads: string[] = []; const tagged: Array<{ itemType: ItemType; itemId: string }> = [...(req.links ?? [])];
  for (const a of req.attachments ?? []) {
    if ('uploadId' in a) { const u = readUpload(ctx.dataDir, a.uploadId); if (!u) throw new MailSendError('Staged upload expired — re-attach the file'); attachments.push({ name: u.name, mime: u.mime, content: u.buf }); usedUploads.push(a.uploadId); }
    else { attachments.push(fileAttachment(ctx, a.fileId, a.name)); if (a.itemType && a.itemId) tagged.push({ itemType: a.itemType, itemId: a.itemId }); }
  }

  let inReplyTo: string | undefined; let references: string[] | undefined;
  if (req.replyTo) {
    // The reply target's accountId comes straight from the request — scope it to an
    // account this user owns, or a user could probe another account's threads (IDOR).
    const replyAccount = accounts.getOwned(db, user.id, req.replyTo.accountId);
    if (!replyAccount) throw new MailSendError('Reply target not found', 404);
    const last = db.prepare('SELECT messageIdHeader, referencesJson FROM mail_messages WHERE accountId = ? AND threadKey = ? AND messageIdHeader IS NOT NULL ORDER BY date DESC LIMIT 1').get(req.replyTo.accountId, req.replyTo.threadKey) as { messageIdHeader: string; referencesJson: string } | undefined;
    if (last) { inReplyTo = last.messageIdHeader; references = [...JSON.parse(last.referencesJson || '[]'), last.messageIdHeader].filter((x, i, arr) => arr.indexOf(x) === i); }
  }
  const domain = account.emailAddress.split('@')[1] || 'localhost';
  const msg: OutgoingMessage = {
    from: account.displayName ? { addr: account.emailAddress, name: account.displayName } : { addr: account.emailAddress },
    to: req.to, cc: req.cc ?? [], bcc: req.bcc ?? [], subject: req.subject || '(no subject)', html: req.html || '', text: htmlToText(req.html || ''),
    attachments, inReplyTo, references, messageIdHeader: newMessageIdHeader(domain),
  };
  const sent = await provider.send(msg);

  // Everything below is local bookkeeping AFTER the provider has already accepted
  // the message — it must never look like the send itself failed. If any of it
  // throws, the message is irretrievably sent but not indexed locally; surface a
  // distinct error telling the caller not to resend rather than letting a DB/link
  // error masquerade as a send failure (which would invite a duplicate send).
  try {
    if (req.draftProviderId) { try { await provider.deleteDraft(req.draftProviderId); } catch { /* best effort */ } }

    const { messageIds, threadKeys } = upsertEnvelopes(ctx, account, [{
      providerMessageId: sent.providerMessageId, providerThreadId: sent.providerThreadId, messageIdHeader: msg.messageIdHeader, inReplyTo, references: references ?? [],
      from: msg.from, to: msg.to, cc: msg.cc, bcc: msg.bcc, subject: msg.subject, snippet: snippetOf(msg.text), date: new Date().toISOString(),
      isRead: true, isStarred: false, isDraft: false, attachments: attachments.map((a, i) => ({ attId: 'out' + i, name: a.name, mime: a.mime, size: a.content.length })), sizeBytes: msg.html.length,
      folderProviderIds: ['SENT'],
    }], { sentFromApp: true, sessionId: req.sessionId });
    const messageId = messageIds[0];
    const threadKey = (db.prepare('SELECT threadKey FROM mail_messages WHERE id = ?').get(messageId) as { threadKey: string }).threadKey;

    const effectsSkipped: ItemType[] = []; const to = req.to.map(a => a.addr).join(', ');
    // The proposal's sentTo snapshot records who it went to AND what it said —
    // carry cc/subject through so the rewired routes keep that record intact.
    const cc = (req.cc ?? []).map(a => a.addr).join(', ') || undefined;
    const seen = new Set<string>();
    const broadcasts: EntityChangedEvent[] = [];
    db.transaction(() => {
      for (const t of tagged) {
        const key = t.itemType + ':' + t.itemId; if (seen.has(key)) continue; seen.add(key);
        createLink(db, { threadKey, itemType: t.itemType, itemId: t.itemId, linkedByUserId: user.id, subjectSnapshot: msg.subject, firstDate: new Date().toISOString(), participants: [msg.from, ...msg.to] });
        const eff = applySendEffects(db, { itemType: t.itemType, itemId: t.itemId, userId: user.id, role: user.role, to, cc, subject: msg.subject, threadKey });
        if (eff.skipped === 'role') effectsSkipped.push(t.itemType);
        if (eff.broadcast) broadcasts.push({ ...eff.broadcast, action: 'updated', byUserId: user.id, bySessionId: req.sessionId });
      }
    })();
    broadcasts.forEach(b => ctx.broadcastChange(b));

    // Reply-state for a thread that only became linked by this send.
    const now = new Date().toISOString();
    if (tagged.length) {
      db.prepare('INSERT OR IGNORE INTO mail_thread_reply_state (threadKey, updatedAt) VALUES (?, ?)').run(threadKey, now);
      db.prepare(`UPDATE mail_thread_reply_state SET lastOutboundDate = MAX(COALESCE(lastOutboundDate,''), ?), updatedAt = ? WHERE threadKey = ?`).run(now, now, threadKey);
    }

    // Only discard staged uploads once the send is fully recorded — on failure the
    // sweeper still reaps them within the hour, but they stay around for diagnosis.
    usedUploads.forEach(id => discardUpload(ctx.dataDir, id));
    void threadKeys;
    return { messageId, threadKey, accountId: account.id, effectsSkipped };
  } catch (e) {
    console.error('[mail] sent but not recorded', e);
    throw new MailSendError('Message was sent but could not be recorded locally — do not resend; it will appear after the next sync', 502);
  }
}
