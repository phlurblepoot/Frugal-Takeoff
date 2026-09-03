// server/mail/inboundHooks.ts
// What the app does with mail that arrives on a thread linked to one of its
// items. Today that is one rule: a reply to a sent RFI is captured as a
// PENDING reply for a human to accept or dismiss — never auto-answered, because
// "thanks, got it" is a reply too and would otherwise close out the RFI.
import type { MailAccountRow } from './accountStore';
import type { MailContext } from './context';
import { listLinksForThread } from './links';
import { htmlToText, stripQuotedReply } from './mime';
import type { AttachmentMeta } from './providers/types';
import { clearInboundHooks, registerInboundHook } from './sync/engine';
import { setPendingReply, type RfiPendingReply } from '../rfiStore';

/** A body fetch is a provider round-trip; past this the snippet we already
 *  indexed is a better answer than nothing. */
const BODY_TIMEOUT_MS = 20_000;

interface MessageRow {
  providerMessageId: string; snippet: string; fromAddr: string | null; fromName: string | null;
  date: string; attachmentsJson: string; messageIdHeader: string | null;
}
type RawBody = { html?: string; text?: string; attachments?: AttachmentMeta[] };
export interface InboundEvent { threadKey: string; messageId: string; account: MailAccountRow }

/** The sender's own words. Prefers the text part, falls back to flattened HTML,
 *  and finally to the indexed snippet when the body never arrived. */
function replyText(raw: RawBody | null, snippet: string): string {
  const source = raw?.text?.trim() ? raw.text : raw?.html ? htmlToText(raw.html) : '';
  const stripped = source.trim() ? stripQuotedReply(source).trim() : '';
  return stripped || stripQuotedReply(snippet || '').trim();
}

async function fetchBody(ctx: MailContext, accountId: string, providerMessageId: string): Promise<RawBody | null> {
  const provider = ctx.scheduler?.getProvider(accountId);
  if (!provider) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      provider.getBody(providerMessageId),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('getBody timed out')), BODY_TIMEOUT_MS); }),
    ]);
  } catch (e) {
    console.warn('[mail] inbound body fetch failed, using snippet:', (e as Error)?.message ?? e);
    return null;
  } finally { if (timer) clearTimeout(timer); }
}

async function captureRfiReply(ctx: MailContext, ev: InboundEvent, msg: MessageRow, rfiIds: string[]): Promise<void> {
  const { db } = ctx;
  const raw = await fetchBody(ctx, ev.account.id, msg.providerMessageId);
  // The provider's CURRENT part list wins when we have it: Gmail rotates the
  // attachment ids handed out at sync time, and the indexed ones stop resolving.
  const attachments = (raw?.attachments ?? JSON.parse(msg.attachmentsJson || '[]')) as AttachmentMeta[];
  const reply: RfiPendingReply = {
    threadKey: ev.threadKey,
    accountId: ev.account.id,
    mailMessageId: ev.messageId,
    messageIdHeader: msg.messageIdHeader ?? null,
    from: msg.fromName ? { addr: msg.fromAddr ?? '', name: msg.fromName } : { addr: msg.fromAddr ?? '' },
    date: msg.date,
    text: replyText(raw, msg.snippet),
    attachments: attachments.map(a => ({ attId: a.attId, name: a.name, mime: a.mime, size: a.size })),
    receivedAt: new Date().toISOString(),
  };
  for (const rfiId of rfiIds) {
    const row = db.prepare('SELECT projectId, pendingReplyJson FROM rfis WHERE id = ?').get(rfiId) as { projectId: string; pendingReplyJson: string | null } | undefined;
    if (!row) continue;
    // Same message twice (a retried hook, a re-indexed row) must not bump the
    // version or re-notify — only a genuinely newer reply replaces the pending one.
    const prev: RfiPendingReply | null = row.pendingReplyJson ? JSON.parse(row.pendingReplyJson) : null;
    if (prev?.mailMessageId === ev.messageId) continue;
    // Status is re-checked here, not just before the fetch: the RFI may have
    // been answered by hand while the body was in flight. setPendingReply
    // returns false in that case.
    if (!setPendingReply(db, rfiId, reply)) continue;
    const after = db.prepare('SELECT version FROM rfis WHERE id = ?').get(rfiId) as { version: number } | undefined;
    ctx.broadcastChange({ type: 'rfi', id: rfiId, projectId: row.projectId, version: after?.version, action: 'updated' });
  }
}

/** Engine hook: runs synchronously after the upsert commits, so it must not
 *  throw and must not block. The DB write happens once the body arrives. */
export function rfiPendingReplyHook(ctx: MailContext, ev: InboundEvent): void {
  try {
    const { db } = ctx;
    const rfiIds = listLinksForThread(db, ev.threadKey).filter(l => l.itemType === 'rfi').map(l => l.itemId);
    if (!rfiIds.length) return;
    // Only an RFI still awaiting its answer takes a pending reply. Checked here
    // as well as in setPendingReply so a chatty thread on an answered RFI costs
    // no provider round-trip at all.
    const statusStmt = db.prepare('SELECT status FROM rfis WHERE id = ?');
    const pending = rfiIds.filter(id => (statusStmt.get(id) as { status: string } | undefined)?.status === 'sent');
    if (!pending.length) return;
    const msg = db.prepare(`SELECT providerMessageId, snippet, fromAddr, fromName, date, attachmentsJson, messageIdHeader
                            FROM mail_messages WHERE id = ?`).get(ev.messageId) as MessageRow | undefined;
    if (!msg) return;
    void captureRfiReply(ctx, ev, msg, pending).catch(e => console.error('[mail] rfi pending reply capture failed', e));
  } catch (e) {
    console.error('[mail] rfi pending reply hook failed', e);
  }
}

let installed = false;
/** Wires the app's inbound-mail reactions into the sync engine. Idempotent:
 *  server startup calls it once, but a second call must not double-register. */
export function installInboundHooks(): void {
  if (installed) return;
  installed = true;
  registerInboundHook(rfiPendingReplyHook);
}
/** Tests only: forgets the install so a cleared registry can be re-populated. */
export function resetInboundHooks(): void { installed = false; clearInboundHooks(); }
