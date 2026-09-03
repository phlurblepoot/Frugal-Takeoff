// Client-side types for the mail client UI (Plan 3). Mirrors the shapes the
// live server routes actually return — see server/mail/routes.ts — not the
// (partially stale) shapes sketched in the task brief.

export interface Addr { addr: string; name?: string }

/** The closed set of app entities a mail thread can be linked to (server/mail/links.ts ItemType). */
export type ItemType =
  | 'proposal' | 'invoice' | 'changeOrder' | 'payApp' | 'issue' | 'rfi'
  | 'dailyReport' | 'punch' | 'task' | 'project' | 'customer';

export type MailAccountStatus = 'ok' | 'syncing' | 'auth_error' | 'needs_review' | 'disabled';

export interface MailAccount {
  id: string;
  provider: 'google' | 'microsoft' | 'imap' | 'fake';
  emailAddress: string;
  displayName: string | null;
  signatureHtml: string | null;
  isDefault: number;
  status: MailAccountStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  indexedSince: string;
  /** Server-computed: unread count across this account's inbox folder(s). */
  unreadCount: number;
}

export interface MailFolder {
  id: string;
  accountId: string;
  providerId: string;
  name: string;
  role: string | null;
  unreadCount: number;
  totalCount: number;
  sortOrder: number;
}

/** A mail_thread_links row. subjectSnapshot/participantsJson are nulled by the
 *  server for a thread the requesting user does not own a mailbox for. */
export interface ThreadLink {
  id: string;
  threadKey: string;
  subjectSnapshot: string | null;
  firstDate: string | null;
  participantsJson: string | null;
  itemType: ItemType;
  itemId: string;
  projectId: string | null;
  customerId: string | null;
  linkedByUserId: string;
  createdAt: string;
}

// Booleans that come out of SQLite as 0/1 travel over JSON as plain numbers —
// typed as `number` here (not `boolean`) to match what actually arrives.
export interface ThreadListRow {
  threadKey: string;
  subject: string;
  firstDate: string;
  lastDate: string;
  messageCount: number;
  unreadCount: number;
  hasAttachments: number;
  isStarred: number;
  participants: Addr[];
  folderIds: string[];
  snippet: string;
  links: ThreadLink[];
}

export interface AttachmentMeta {
  attId: string;
  name: string;
  mime: string;
  size: number;
  contentId?: string;
}

export interface MessageRow {
  id: string;
  accountId: string;
  threadKey: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  snippet: string;
  date: string;
  isRead: boolean;
  isStarred: boolean;
  isDraft: boolean;
  hasAttachments: boolean;
  attachments: AttachmentMeta[];
  sizeBytes: number;
  folderIds: string[];
  sentFromApp: boolean;
}

export interface BodyPayload {
  html: string;
  text: string;
  blockedRemoteImages: number;
  attachments: AttachmentMeta[];
}

/** GET /api/mail/messages/:id/body can 202 while a just-sent message's Graph
 *  copy is still being filed; the client renders a "Sending…" placeholder. */
export interface BodyPending { pending: true }

export type MailAction = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'trash' | 'move';

export interface SendRequest {
  accountId?: string;
  to: Addr[];
  cc?: Addr[];
  bcc?: Addr[];
  subject: string;
  html: string;
  attachments: Array<
    | { fileId: string; name?: string; itemType?: ItemType; itemId?: string }
    | { uploadId: string }
  >;
  replyTo?: { accountId: string; threadKey: string };
  links?: Array<{ itemType: ItemType; itemId: string }>;
  draftProviderId?: string;
}

export interface SendResult {
  messageId: string;
  threadKey: string;
  accountId: string;
  effectsSkipped: ItemType[];
}

export interface Recipient extends Addr {
  source: string;
  customerId?: string;
  role?: string;
}

export interface SetupInfo {
  publicUrl: string | null;
  google: {
    configured: boolean;
    redirectUri: string | null;
    /** Optional Gmail real-time push. `webhookUrl` embeds the shared secret, so
     *  it only ever comes back from the admin-only setup-info route. */
    pubsub: { configured: boolean; topic: string | null; webhookUrl: string | null };
  };
  microsoft: { configured: boolean; redirectUri: string | null; webhookUrl: string | null; tenant: string };
  secretKey: 'env' | 'file';
}
