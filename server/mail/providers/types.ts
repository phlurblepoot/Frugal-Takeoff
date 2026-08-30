export type MailProviderKind = 'google' | 'microsoft' | 'imap' | 'fake';
export interface Addr { addr: string; name?: string }
export interface AttachmentMeta { attId: string; name: string; mime: string; size: number; contentId?: string }
export interface Envelope {
  providerMessageId: string; providerThreadId?: string;
  messageIdHeader?: string; inReplyTo?: string; references: string[];
  from: Addr; to: Addr[]; cc: Addr[]; bcc: Addr[];
  subject: string; snippet: string; date: string;           // ISO
  isRead: boolean; isStarred: boolean; isDraft: boolean;
  attachments: AttachmentMeta[]; sizeBytes: number;
  folderProviderIds: string[];
}
export interface ProviderFolder { providerId: string; name: string; role: FolderRole | null; unreadCount?: number; totalCount?: number; sortOrder?: number }
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'spam' | 'starred';
export type SyncState = Record<string, unknown>;
export interface OutgoingAttachment { name: string; mime: string; content: Buffer; contentId?: string }
export interface OutgoingMessage {
  from: Addr; to: Addr[]; cc: Addr[]; bcc: Addr[]; subject: string; html: string; text: string;
  attachments: OutgoingAttachment[]; inReplyTo?: string; references?: string[]; messageIdHeader: string;
}
export interface MailProvider {
  kind: MailProviderKind;
  listFolders(): Promise<ProviderFolder[]>;
  backfill(opts: { since: Date; cursor?: string }): Promise<{ messages: Envelope[]; cursor?: string; done: boolean }>;
  incremental(state: SyncState): Promise<{ upserts: Envelope[]; deletes: string[]; state: SyncState }>;
  getBody(providerMessageId: string): Promise<{ html?: string; text?: string; attachments: AttachmentMeta[] }>;
  getAttachment(providerMessageId: string, attId: string): Promise<{ stream: NodeJS.ReadableStream; mime: string; size?: number; name: string }>;
  /** `messageIdHeader` is the Message-ID the provider actually used — Gmail/Graph rewrite
   *  the one we hand them, and the sent row must be indexed under the real value or the
   *  reply that quotes it will not thread. Omitted = ours was kept verbatim. */
  send(msg: OutgoingMessage): Promise<{ providerMessageId: string; providerThreadId?: string; messageIdHeader?: string }>;
  setFlags(ids: string[], flags: { read?: boolean; starred?: boolean }): Promise<void>;
  move(ids: string[], folderProviderId: string): Promise<void>;
  archive(ids: string[]): Promise<void>;
  trash(ids: string[]): Promise<void>;
  saveDraft(draft: OutgoingMessage, existingProviderId?: string): Promise<{ providerMessageId: string }>;
  deleteDraft(providerMessageId: string): Promise<void>;
  search(query: string, opts: { before?: Date; limit: number }): Promise<Envelope[]>;
  /** Optional live-change channel (IMAP IDLE, a webhook subscription, …).
   *  `onChange` is a hint that something moved — the caller re-syncs, it carries
   *  no payload. Providers without push simply omit both. */
  startPush?(onChange: () => void): Promise<void>;
  stopPush?(): Promise<void>;
}
export class AuthExpiredError extends Error {}
export class RateLimitedError extends Error { retryAfterMs = 60_000 }
export class ProviderNotFoundError extends Error {}
