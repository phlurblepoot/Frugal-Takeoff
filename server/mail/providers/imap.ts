// server/mail/providers/imap.ts
// The IMAP/SMTP provider: imapflow for reading and mailbox ops, nodemailer for
// sending, mailparser for bodies. Every operation opens its own short-lived
// connection and always logs out — the one long-lived connection is the IDLE
// listener started by startPush().
import type { Readable } from 'stream';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import type { ImapAuth } from '../accountStore';
import type {
  MailProvider, Envelope, ProviderFolder, SyncState, OutgoingMessage, AttachmentMeta, FolderRole, Addr,
} from './types';
import { AuthExpiredError, ProviderNotFoundError } from './types';
import { buildRawMime } from './mimeBuild';
import { normalizeMessageId } from '../threadKey';

// ---------------------------------------------------------------------------
// providerMessageId: "<folder> <uidValidity> <uid>". A UID alone is not stable
// (it is only unique within one folder and only valid for one UIDVALIDITY), so
// all three travel together in the single string the engine's unique index
// wants. Folder paths may contain spaces, so parsing reads from the END.
// ---------------------------------------------------------------------------
const SEP = ' ';
export const makePmid = (folder: string, uidValidity: number, uid: number): string =>
  `${folder}${SEP}${uidValidity}${SEP}${uid}`;

export function parsePmid(id: string): { folder: string; uidValidity: number; uid: number } {
  const parts = String(id ?? '').split(SEP);
  const uid = Number(parts.pop());
  const uidValidity = Number(parts.pop());
  return { folder: parts.join(SEP), uidValidity, uid };
}
/** Same, but null for anything that is not a real folder/uid pair — e.g. the
 *  synthetic id send() falls back to when the Sent APPEND was refused. */
function tryParsePmid(id: string): { folder: string; uidValidity: number; uid: number } | null {
  const p = parsePmid(id);
  return p.folder && Number.isInteger(p.uid) && p.uid > 0 ? p : null;
}
/** Marks a sent message the server would not let us APPEND — nothing to act on
 *  later, so it deliberately does NOT parse as a folder/uid pair. */
const unappendedSentId = (messageIdHeader: string): string => `sent:unappended:${messageIdHeader}`;

const ROLE_BY_USE: Record<string, FolderRole> = {
  '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash',
  '\\Junk': 'spam', '\\Archive': 'archive', '\\All': 'archive', '\\Flagged': 'starred',
};
const ROLE_BY_NAME: Array<[RegExp, FolderRole]> = [
  [/^inbox$/i, 'inbox'],
  [/^(sent|sent items|sent mail|sent messages)$/i, 'sent'],
  [/^drafts?$/i, 'drafts'],
  [/^(trash|deleted items|deleted messages|bin)$/i, 'trash'],
  [/^(junk|spam|junk e-?mail|bulk mail)$/i, 'spam'],
  [/^(archive|archives|all mail)$/i, 'archive'],
];

/** How far back each incremental poll re-reads flags so a read/star toggled in
 *  another client shows up here. Newer than this is covered by the UID walk. */
const FLAG_RESCAN_WINDOW = 200;
const OP_SOCKET_TIMEOUT_MS = 60_000;
const PUSH_IDLE_MS = 4 * 60_000;          // < the 29-minute IDLE ceiling in RFC 2177
const PUSH_REARM_MS = 1_000;              // never re-IDLE in a hot loop
const PUSH_BACKOFF_MS = 5_000;
const PUSH_BACKOFF_MAX_MS = 300_000;

// The subset of ImapFlow this provider uses. Declaring it locally (rather than
// depending on the full class) is what lets the tests inject a scripted fake.
export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  list(): Promise<ImapListItem[]>;
  mailboxOpen(path: string): Promise<{ path: string; uidValidity: bigint | number; uidNext?: number; exists?: number }>;
  fetch(range: unknown, query: unknown, options?: unknown): AsyncIterable<ImapFetchMessage>;
  fetchOne(range: string, query: unknown, options?: unknown): Promise<ImapFetchMessage | false>;
  download(range: string, part?: string, options?: unknown): Promise<{ meta?: ImapDownloadMeta; content: Readable | null }>;
  messageFlagsAdd(range: string, flags: string[], options?: unknown): Promise<unknown>;
  messageFlagsRemove(range: string, flags: string[], options?: unknown): Promise<unknown>;
  messageMove(range: string, destination: string, options?: unknown): Promise<unknown>;
  messageDelete(range: string, options?: unknown): Promise<unknown>;
  append(path: string, content: Buffer, flags?: string[]): Promise<{ uid?: number; uidValidity?: bigint | number } | false>;
  search(query: unknown, options?: unknown): Promise<number[] | false>;
  idle(): Promise<unknown>;
  /** Hard socket close, used when a connect could not be completed. */
  close?(): void;
  // `any` payload: each imapflow event carries a different shape
  on(event: string, listener: (...args: any[]) => void): unknown;
}
interface ImapListItem { path: string; name?: string; delimiter?: string; specialUse?: string; flags?: Set<string> }
interface ImapDownloadMeta { contentType?: string; filename?: string; expectedSize?: number }
interface ImapBodyNode {
  part?: string; type?: string; size?: number; id?: string; disposition?: string;
  dispositionParameters?: Record<string, string>; parameters?: Record<string, string>; childNodes?: ImapBodyNode[];
}
interface ImapAddress { address?: string; name?: string }
interface ImapFetchMessage {
  uid: number; size?: number; flags?: Set<string>; headers?: Buffer; internalDate?: Date | string;
  bodyStructure?: ImapBodyNode;
  envelope?: { messageId?: string; inReplyTo?: string | null; subject?: string; date?: Date | string; from?: ImapAddress[]; to?: ImapAddress[]; cc?: ImapAddress[]; bcc?: ImapAddress[] };
}

export interface ImapProviderOpts {
  fromAddress: string;
  clientFactory?: (auth: ImapAuth) => ImapClientLike;
  transportFactory?: (auth: ImapAuth) => { sendMail(options: Record<string, unknown>): Promise<unknown> };
  /** Test seams for the push loop's timers. */
  pushRearmMs?: number;
  pushBackoffMs?: number;
}

type FolderState = { uidValidity: number; lastUid: number };
type ImapSyncState = { folders: Record<string, FolderState> };

const FETCH_QUERY = {
  uid: true, envelope: true, flags: true, size: true, internalDate: true,
  bodyStructure: true, headers: ['references'],
};

const AUTH_FAIL_RE = /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed|\bAUTH\b.*(failed|reject)/i;
const SMTP_AUTH_FAIL_RE = /\b(535|534|530)\b|Invalid login|authentication (failed|credentials|unsuccessful)|Username and Password not accepted/i;

export class ImapMailProvider implements MailProvider {
  kind = 'imap' as const;
  private pushClient: ImapClientLike | null = null;
  private pushStopped = true;
  private pushLoop: Promise<void> | null = null;

  constructor(private auth: ImapAuth, private opts: ImapProviderOpts) {}

  // -- connection plumbing --------------------------------------------------

  private newClient(push = false): ImapClientLike {
    if (this.opts.clientFactory) return this.opts.clientFactory(this.auth);
    return new ImapFlow({
      host: this.auth.imapHost, port: this.auth.imapPort, secure: this.auth.imapSecure,
      auth: { user: this.auth.username, pass: this.auth.password },
      logger: false,                                   // never let credentials reach the log
      disableAutoIdle: true,
      ...(push ? { maxIdleTime: PUSH_IDLE_MS, socketTimeout: PUSH_IDLE_MS * 2 } : { socketTimeout: OP_SOCKET_TIMEOUT_MS }),
    }) as unknown as ImapClientLike;
  }

  /** Connects, runs `fn`, and logs out on every path — including throws. */
  private async withClient<T>(fn: (c: ImapClientLike) => Promise<T>): Promise<T> {
    const c = this.newClient();
    await this.connect(c);
    try {
      return await fn(c);
    } finally {
      await c.logout().catch(() => { /* the socket is going away regardless */ });
    }
  }

  private async connect(c: ImapClientLike): Promise<void> {
    try {
      await c.connect();
    } catch (e) {
      try { c.close?.(); } catch { /* the socket may already be gone */ }
      const err = e as Error & { authenticationFailed?: boolean };
      // Deliberately a fresh message: the server's text can quote the username.
      if (err?.authenticationFailed || AUTH_FAIL_RE.test(String(err?.message ?? ''))) {
        throw new AuthExpiredError('IMAP login rejected — re-enter the mailbox password in Settings → Mail');
      }
      throw e;
    }
  }

  // -- folders --------------------------------------------------------------

  private roleOf(box: ImapListItem): FolderRole | null {
    if (box.specialUse && ROLE_BY_USE[box.specialUse]) return ROLE_BY_USE[box.specialUse];
    const leaf = String(box.path).split(box.delimiter || '/').pop() || '';
    for (const [re, role] of ROLE_BY_NAME) if (re.test(leaf)) return role;
    return null;
  }

  private async selectable(c: ImapClientLike): Promise<ImapListItem[]> {
    const boxes = await c.list();
    return (boxes ?? []).filter(b => !b.flags?.has?.('\\Noselect'));
  }

  async listFolders(): Promise<ProviderFolder[]> {
    return this.withClient(async c => (await this.selectable(c)).map((b, i): ProviderFolder => ({
      providerId: b.path, name: b.name || b.path, role: this.roleOf(b), sortOrder: i,
    })));
  }

  private async roleFolder(c: ImapClientLike, role: FolderRole, fallback: string): Promise<string> {
    const box = (await this.selectable(c)).find(b => this.roleOf(b) === role);
    return box?.path ?? fallback;
  }

  // -- envelope mapping -----------------------------------------------------

  private toEnvelope(folder: string, uidValidity: number, m: ImapFetchMessage): Envelope {
    const e = m.envelope ?? {};
    const headers = m.headers ? m.headers.toString() : '';
    const refLine = /^references:[ \t]*((?:.|\r?\n[ \t])+)/im.exec(headers)?.[1] ?? '';
    const references = (refLine.match(/<[^>]+>/g) ?? [])
      .map(r => normalizeMessageId(r))
      .filter((r): r is string => !!r);
    const addr = (a: ImapAddress): Addr => {
      const name = (a?.name ?? '').trim();
      return { addr: String(a?.address ?? '').trim().toLowerCase(), ...(name ? { name } : {}) };
    };
    const list = (a: ImapAddress[] | undefined): Addr[] => (a ?? []).map(addr).filter(x => x.addr);
    const flags = m.flags ?? new Set<string>();
    const when = e.date ?? m.internalDate ?? new Date();
    const date = new Date(when);
    return {
      providerMessageId: makePmid(folder, uidValidity, m.uid),
      messageIdHeader: normalizeMessageId(e.messageId) ?? undefined,
      inReplyTo: normalizeMessageId(e.inReplyTo) ?? undefined,
      references,
      from: e.from?.[0] ? addr(e.from[0]) : { addr: '' },
      to: list(e.to), cc: list(e.cc), bcc: list(e.bcc),
      subject: e.subject || '',
      snippet: '',                                     // IMAP envelopes carry no preview; the body cache fills it in
      date: (isNaN(date.getTime()) ? new Date() : date).toISOString(),
      isRead: flags.has('\\Seen'), isStarred: flags.has('\\Flagged'), isDraft: flags.has('\\Draft'),
      attachments: this.attachmentsOf(m.bodyStructure),
      sizeBytes: m.size ?? 0,
      folderProviderIds: [folder],
    };
  }

  /** Leaf BODYSTRUCTURE nodes that are real attachments. `attId` is the IMAP
   *  part path ("2", "1.2") — exactly what download() wants later. */
  private attachmentsOf(bs: ImapBodyNode | undefined): AttachmentMeta[] {
    const out: AttachmentMeta[] = [];
    const walk = (n: ImapBodyNode | undefined): void => {
      if (!n) return;
      if (n.childNodes?.length) { n.childNodes.forEach(walk); return; }
      const filename = n.dispositionParameters?.filename || n.parameters?.name;
      const type = (n.type || '').toLowerCase();
      const isBodyText = (type === 'text/plain' || type === 'text/html') && n.disposition !== 'attachment' && !filename;
      if (isBodyText || !n.part) return;
      if (n.disposition !== 'attachment' && !filename && !n.id && (!type || /^text\//.test(type) || /^multipart\//.test(type))) return;
      out.push({
        attId: String(n.part),
        name: filename || 'attachment',
        mime: n.type || 'application/octet-stream',
        size: n.size || 0,
        ...(n.id ? { contentId: String(n.id).replace(/^<|>$/g, '') } : {}),
      });
    };
    walk(bs);
    return out;
  }

  /** Fetches a UID range from the ALREADY OPEN mailbox. */
  private async fetchRange(
    c: ImapClientLike, path: string, uidValidity: number, range: string | { since: Date }, limit?: number,
  ): Promise<{ msgs: Envelope[]; maxUid: number }> {
    const msgs: Envelope[] = [];
    let maxUid = 0;
    for await (const m of c.fetch(range, FETCH_QUERY, { uid: true })) {
      if (!m || typeof m.uid !== 'number') continue;
      msgs.push(this.toEnvelope(path, uidValidity, m));
      if (m.uid > maxUid) maxUid = m.uid;
      if (limit && msgs.length >= limit) break;
    }
    return { msgs, maxUid };
  }

  private async scanFolder(
    c: ImapClientLike, path: string, range: string | { since: Date }, limit?: number,
  ): Promise<{ uidValidity: number; uidNext: number; msgs: Envelope[]; maxUid: number }> {
    const box = await c.mailboxOpen(path);
    const uidValidity = Number(box.uidValidity);
    const uidNext = Number(box.uidNext ?? 1);
    return { uidValidity, uidNext, ...(await this.fetchRange(c, path, uidValidity, range, limit)) };
  }

  // -- sync -----------------------------------------------------------------

  async backfill(opts: { since: Date; cursor?: string }): Promise<{ messages: Envelope[]; cursor?: string; done: boolean }> {
    return this.withClient(async c => {
      const messages: Envelope[] = [];
      for (const b of await this.selectable(c)) {
        const role = this.roleOf(b);
        if (role === 'trash' || role === 'spam') continue;        // history nobody asked to import
        const r = await this.scanFolder(c, b.path, { since: opts.since });
        messages.push(...r.msgs);
      }
      return { messages, done: true };
    });
  }

  async incremental(state: SyncState): Promise<{ upserts: Envelope[]; deletes: string[]; state: SyncState }> {
    const prevFolders = (state as ImapSyncState | undefined)?.folders ?? {};
    // Rebuilt from the live folder list, so folders deleted on the server drop
    // out of the state instead of accumulating forever.
    const next: ImapSyncState = { folders: {} };
    return this.withClient(async c => {
      const byId = new Map<string, Envelope>();
      for (const b of await this.selectable(c)) {
        const prev = prevFolders[b.path];
        const box = await c.mailboxOpen(b.path);
        const uidValidity = Number(box.uidValidity);
        const head = Math.max(0, Number(box.uidNext ?? 1) - 1);
        // A folder we have never synced (or one whose UIDVALIDITY the server
        // reset) is adopted at its current head: history is backfill's job, and
        // replaying it here would re-emit every message under new ids.
        if (!prev || prev.uidValidity !== uidValidity) {
          next.folders[b.path] = { uidValidity, lastUid: head };
          continue;
        }
        const fresh = await this.fetchRange(c, b.path, uidValidity, `${prev.lastUid + 1}:*`);
        // "N:*" is not empty when N is past the end — IMAP answers with the
        // highest existing UID — so the filter below is what keeps an idle
        // folder from re-emitting its newest message on every poll.
        for (const m of fresh.msgs) {
          if (parsePmid(m.providerMessageId).uid > prev.lastUid) byId.set(m.providerMessageId, m);
        }
        // Re-read a window of known UIDs so a read/star toggled in another
        // client reaches the engine's upsert (IMAP has no flag change feed).
        if (prev.lastUid > 0) {
          const from = Math.max(1, prev.lastUid - FLAG_RESCAN_WINDOW);
          const rescan = await this.fetchRange(c, b.path, uidValidity, `${from}:${prev.lastUid}`);
          for (const m of rescan.msgs) if (!byId.has(m.providerMessageId)) byId.set(m.providerMessageId, m);
        }
        next.folders[b.path] = { uidValidity, lastUid: Math.max(prev.lastUid, fresh.maxUid) };
      }
      // IMAP gives no cheap tombstones; disappearing messages are reconciled by
      // the next backfill rather than guessed at here.
      return { upserts: [...byId.values()], deletes: [], state: next as unknown as SyncState };
    });
  }

  // -- bodies ---------------------------------------------------------------

  async getBody(providerMessageId: string): Promise<{ html?: string; text?: string; attachments: AttachmentMeta[] }> {
    const p = tryParsePmid(providerMessageId);
    if (!p) throw new ProviderNotFoundError(providerMessageId);
    return this.withClient(async c => {
      await c.mailboxOpen(p.folder);
      // BODYSTRUCTURE first: imapflow serialises commands, and the download
      // stream must be consumed before another one can be issued.
      const one = await c.fetchOne(String(p.uid), { uid: true, bodyStructure: true }, { uid: true });
      const attachments = this.attachmentsOf(one ? one.bodyStructure : undefined);
      const dl = await c.download(String(p.uid), undefined, { uid: true });
      if (!dl?.content) throw new ProviderNotFoundError(providerMessageId);
      const parsed = await simpleParser(dl.content);
      return {
        html: parsed.html || undefined,
        text: parsed.text || undefined,
        attachments,
      };
    });
  }

  async getAttachment(providerMessageId: string, attId: string): Promise<{ stream: NodeJS.ReadableStream; mime: string; size?: number; name: string }> {
    const p = tryParsePmid(providerMessageId);
    if (!p) throw new ProviderNotFoundError(providerMessageId);
    // Not withClient: the stream outlives this call, so the logout is tied to
    // the stream ending instead of to the function returning.
    const c = this.newClient();
    await this.connect(c);
    let dl: { meta?: ImapDownloadMeta; content: Readable | null };
    try {
      await c.mailboxOpen(p.folder);
      dl = await c.download(String(p.uid), attId, { uid: true });
    } catch (e) {
      await c.logout().catch(() => {});
      throw e;
    }
    if (!dl?.content) {
      await c.logout().catch(() => {});
      throw new ProviderNotFoundError(attId);
    }
    // 'end', 'close' and 'error' can all fire — log out on the first of them.
    let closed = false;
    const close = (): void => { if (closed) return; closed = true; void c.logout().catch(() => {}); };
    const stream = dl.content;
    stream.once('end', close);
    stream.once('error', close);
    stream.once('close', close);
    return {
      stream,
      mime: dl.meta?.contentType || 'application/octet-stream',
      size: dl.meta?.expectedSize,
      name: dl.meta?.filename || 'attachment',
    };
  }

  // -- mailbox operations ---------------------------------------------------

  /** Batches ids per source folder — UIDs are only meaningful inside one. */
  private groupByFolder(ids: string[]): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const id of ids) {
      const p = tryParsePmid(id);
      if (!p) continue;                                 // synthetic/unknown id: nothing on the server to touch
      out.set(p.folder, [...(out.get(p.folder) ?? []), p.uid]);
    }
    return out;
  }

  async setFlags(ids: string[], flags: { read?: boolean; starred?: boolean }): Promise<void> {
    const groups = this.groupByFolder(ids);
    if (!groups.size || (flags.read === undefined && flags.starred === undefined)) return;
    await this.withClient(async c => {
      for (const [folder, uids] of groups) {
        await c.mailboxOpen(folder);
        const range = uids.join(',');
        if (flags.read !== undefined) {
          await (flags.read ? c.messageFlagsAdd(range, ['\\Seen'], { uid: true }) : c.messageFlagsRemove(range, ['\\Seen'], { uid: true }));
        }
        if (flags.starred !== undefined) {
          await (flags.starred ? c.messageFlagsAdd(range, ['\\Flagged'], { uid: true }) : c.messageFlagsRemove(range, ['\\Flagged'], { uid: true }));
        }
      }
    });
  }

  async move(ids: string[], folderProviderId: string): Promise<void> {
    const groups = this.groupByFolder(ids);
    if (!groups.size) return;
    await this.withClient(async c => {
      for (const [folder, uids] of groups) {
        if (folder === folderProviderId) continue;
        await c.mailboxOpen(folder);
        await c.messageMove(uids.join(','), folderProviderId, { uid: true });
      }
    });
  }

  /** One connection for both halves: find the destination, then move into it. */
  private async moveToRole(ids: string[], role: FolderRole, fallback: string): Promise<void> {
    const groups = this.groupByFolder(ids);
    if (!groups.size) return;
    await this.withClient(async c => {
      const dest = await this.roleFolder(c, role, fallback);
      for (const [folder, uids] of groups) {
        if (folder === dest) continue;
        await c.mailboxOpen(folder);
        await c.messageMove(uids.join(','), dest, { uid: true });
      }
    });
  }

  async archive(ids: string[]): Promise<void> { await this.moveToRole(ids, 'archive', 'Archive'); }
  async trash(ids: string[]): Promise<void> { await this.moveToRole(ids, 'trash', 'Trash'); }

  // -- sending --------------------------------------------------------------

  private transport(): { sendMail(options: Record<string, unknown>): Promise<unknown> } {
    if (this.opts.transportFactory) return this.opts.transportFactory(this.auth);
    return nodemailer.createTransport({
      host: this.auth.smtpHost, port: this.auth.smtpPort, secure: this.auth.smtpSecure,
      auth: { user: this.auth.username, pass: this.auth.password },
    });
  }

  /** The UID of a message we just APPENDed. Servers without UIDPLUS answer the
   *  APPEND without one, so fall back to looking the copy up by its Message-ID. */
  private async appendedUid(c: ImapClientLike, dest: string, appended: { uid?: number; uidValidity?: bigint | number } | false, messageIdHeader: string): Promise<string | null> {
    if (appended && appended.uid) return makePmid(dest, Number(appended.uidValidity ?? 0), Number(appended.uid));
    try {
      const box = await c.mailboxOpen(dest);
      const found = await c.search({ header: { 'message-id': messageIdHeader } }, { uid: true });
      const uid = found && found.length ? found[found.length - 1] : 0;
      return uid ? makePmid(dest, Number(box.uidValidity), uid) : null;
    } catch {
      return null;
    }
  }

  async send(msg: OutgoingMessage): Promise<{ providerMessageId: string; providerThreadId?: string; messageIdHeader?: string }> {
    const raw = await buildRawMime(msg);
    const rcpt = [...msg.to, ...msg.cc, ...msg.bcc].map(a => a.addr).filter(Boolean);
    try {
      await this.transport().sendMail({ envelope: { from: msg.from.addr || this.opts.fromAddress, to: rcpt }, raw });
    } catch (e) {
      const err = e as Error;
      if (SMTP_AUTH_FAIL_RE.test(String(err?.message ?? ''))) {
        throw new AuthExpiredError('SMTP login rejected — re-enter the mailbox password in Settings → Mail');
      }
      throw e;
    }
    // The message is already gone; a failed Sent copy must not fail the send.
    try {
      return await this.withClient(async c => {
        const dest = await this.roleFolder(c, 'sent', 'Sent');
        const r = await c.append(dest, raw, ['\\Seen']);
        const pmid = await this.appendedUid(c, dest, r, msg.messageIdHeader);
        return { providerMessageId: pmid ?? unappendedSentId(msg.messageIdHeader) };
      });
    } catch (e) {
      console.warn('[imap] could not append the sent copy to Sent:', (e as Error).message);
      return { providerMessageId: unappendedSentId(msg.messageIdHeader) };
    }
  }

  // -- drafts ---------------------------------------------------------------

  async saveDraft(draft: OutgoingMessage, existingProviderId?: string): Promise<{ providerMessageId: string }> {
    const raw = await buildRawMime(draft);
    const prev = existingProviderId ? tryParsePmid(existingProviderId) : null;
    return this.withClient(async c => {
      const dest = await this.roleFolder(c, 'drafts', 'Drafts');
      if (prev) {
        await c.mailboxOpen(prev.folder);
        // Delete first: an IMAP draft is immutable, so "editing" is replace.
        await c.messageDelete(String(prev.uid), { uid: true }).catch(() => { /* already gone */ });
      }
      const r = await c.append(dest, raw, ['\\Draft', '\\Seen']);
      const pmid = await this.appendedUid(c, dest, r, draft.messageIdHeader);
      if (!pmid) throw new Error('The mail server stored the draft but would not say where — reopen it from the Drafts folder');
      return { providerMessageId: pmid };
    });
  }

  async deleteDraft(providerMessageId: string): Promise<void> {
    const p = tryParsePmid(providerMessageId);
    if (!p) return;
    await this.withClient(async c => {
      await c.mailboxOpen(p.folder);
      await c.messageDelete(String(p.uid), { uid: true });
    });
  }

  // -- search ---------------------------------------------------------------

  async search(query: string, opts: { before?: Date; limit: number }): Promise<Envelope[]> {
    const q = (query || '').trim();
    if (!q) return [];
    return this.withClient(async c => {
      const out: Envelope[] = [];
      for (const b of await this.selectable(c)) {
        if (out.length >= opts.limit) break;
        const box = await c.mailboxOpen(b.path);
        const criteria = { or: [{ subject: q }, { from: q }, { body: q }], ...(opts.before ? { before: opts.before } : {}) };
        const uids = await c.search(criteria, { uid: true });
        if (!uids || !uids.length) continue;
        const room = opts.limit - out.length;
        const wanted = uids.slice(-room);                 // newest matches first
        const r = await this.fetchRange(c, b.path, Number(box.uidValidity), wanted.join(','), room);
        out.push(...r.msgs);
      }
      return out.slice(0, opts.limit);
    });
  }

  // -- push -----------------------------------------------------------------

  /** Holds one extra connection in IDLE on INBOX and pings `onChange` whenever
   *  the server announces new mail or a flag change. Reconnects with backoff. */
  async startPush(onChange: () => void): Promise<void> {
    if (!this.pushStopped) return;                                     // already running
    this.pushStopped = false;
    const rearm = this.opts.pushRearmMs ?? PUSH_REARM_MS;
    const baseBackoff = this.opts.pushBackoffMs ?? PUSH_BACKOFF_MS;
    const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

    const loop = async (): Promise<void> => {
      let backoff = baseBackoff;
      while (!this.pushStopped) {
        const c = this.newClient(true);
        this.pushClient = c;
        try {
          await this.connect(c);
          await c.mailboxOpen('INBOX');
          backoff = baseBackoff;
          c.on('exists', () => { if (!this.pushStopped) onChange(); });
          c.on('flags', () => { if (!this.pushStopped) onChange(); });
          while (!this.pushStopped) {
            await c.idle();
            if (!this.pushStopped && rearm) await sleep(rearm);
          }
        } catch (e) {
          if (!this.pushStopped) console.warn('[imap] IDLE connection dropped:', (e as Error).message);
        } finally {
          await c.logout().catch(() => {});
          if (this.pushClient === c) this.pushClient = null;
        }
        if (this.pushStopped) break;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, PUSH_BACKOFF_MAX_MS);
      }
    };
    this.pushLoop = loop();
    void this.pushLoop.catch(() => { /* the loop already logs */ });
  }

  async stopPush(): Promise<void> {
    this.pushStopped = true;
    // Breaks the socket out of IDLE so the loop's `await idle()` settles.
    await this.pushClient?.logout().catch(() => {});
    this.pushClient = null;
    // The loop is not awaited: it may still be parked inside idle() until the
    // socket actually closes, and stopPush must not block on the network.
    this.pushLoop = null;
  }
}
