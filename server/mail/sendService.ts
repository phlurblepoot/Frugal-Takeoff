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

export class MailSendError extends Error { constructor(msg: string, public status = 400) { super(msg); } }
export interface SendRequest {
  accountId?: string; to: Addr[]; cc?: Addr[]; bcc?: Addr[]; subject: string; html: string;
  attachments: Array<{ fileId: string; name?: string; itemType?: ItemType; itemId?: string } | { uploadId: string }>;
  replyTo?: { accountId: string; threadKey: string };
  links?: Array<{ itemType: ItemType; itemId: string }>;
  draftProviderId?: string;
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
  const account = req.accountId ? accounts.getOwned(db, user.id, req.accountId) : accounts.listAccounts(db, user.id).find(a => a.isDefault) ?? accounts.listAccounts(db, user.id)[0];
  if (!account) throw new MailSendError('No mail account connected — add one in Settings → Mail', 409);
  if (account.status !== 'ok' && account.status !== 'syncing') throw new MailSendError(`Mail account ${account.emailAddress} is ${account.status.replace('_', ' ')} — fix it in Settings → Mail`, 409);
  const provider = ctx.scheduler ? ctx.scheduler.getProvider(account.id) : ctx.providerFactory(account, accounts.readAuth(db, ctx.crypto, account.id)!);

  const attachments: OutgoingAttachment[] = []; const usedUploads: string[] = []; const tagged: Array<{ itemType: ItemType; itemId: string }> = [...(req.links ?? [])];
  for (const a of req.attachments ?? []) {
    if ('uploadId' in a) { const u = readUpload(ctx.dataDir, a.uploadId); if (!u) throw new MailSendError('Staged upload expired — re-attach the file'); attachments.push({ name: u.name, mime: u.mime, content: u.buf }); usedUploads.push(a.uploadId); }
    else { attachments.push(fileAttachment(ctx, a.fileId, a.name)); if (a.itemType && a.itemId) tagged.push({ itemType: a.itemType, itemId: a.itemId }); }
  }

  let inReplyTo: string | undefined; let references: string[] | undefined;
  if (req.replyTo) {
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
  usedUploads.forEach(id => discardUpload(ctx.dataDir, id));
  if (req.draftProviderId) { try { await provider.deleteDraft(req.draftProviderId); } catch { /* best effort */ } }

  const { messageIds, threadKeys } = upsertEnvelopes(ctx, account, [{
    providerMessageId: sent.providerMessageId, providerThreadId: sent.providerThreadId, messageIdHeader: msg.messageIdHeader, inReplyTo, references: references ?? [],
    from: msg.from, to: msg.to, cc: msg.cc, bcc: msg.bcc, subject: msg.subject, snippet: snippetOf(msg.text), date: new Date().toISOString(),
    isRead: true, isStarred: false, isDraft: false, attachments: attachments.map((a, i) => ({ attId: 'out' + i, name: a.name, mime: a.mime, size: a.content.length })), sizeBytes: msg.html.length,
    folderProviderIds: ['SENT'],
  }], { sentFromApp: true });
  const messageId = messageIds[0];
  const threadKey = (db.prepare('SELECT threadKey FROM mail_messages WHERE id = ?').get(messageId) as { threadKey: string }).threadKey;

  const effectsSkipped: ItemType[] = []; const to = req.to.map(a => a.addr).join(', ');
  const seen = new Set<string>();
  for (const t of tagged) {
    const key = t.itemType + ':' + t.itemId; if (seen.has(key)) continue; seen.add(key);
    createLink(db, { threadKey, itemType: t.itemType, itemId: t.itemId, linkedByUserId: user.id, subjectSnapshot: msg.subject, firstDate: new Date().toISOString(), participants: [msg.from, ...msg.to] });
    const eff = applySendEffects(db, { itemType: t.itemType, itemId: t.itemId, userId: user.id, role: user.role, to, threadKey });
    if (eff.skipped === 'role') effectsSkipped.push(t.itemType);
    if (eff.broadcast) ctx.broadcastChange({ ...eff.broadcast, action: 'updated', byUserId: user.id });
  }
  // Reply-state for a thread that only became linked by this send.
  const now = new Date().toISOString();
  if (tagged.length) {
    db.prepare('INSERT OR IGNORE INTO mail_thread_reply_state (threadKey, updatedAt) VALUES (?, ?)').run(threadKey, now);
    db.prepare(`UPDATE mail_thread_reply_state SET lastOutboundDate = MAX(COALESCE(lastOutboundDate,''), ?), updatedAt = ? WHERE threadKey = ?`).run(now, now, threadKey);
  }
  void threadKeys;
  return { messageId, threadKey, accountId: account.id, effectsSkipped };
}
