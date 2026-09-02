// Client for the mail-client REST surface — server/mail/routes.ts. Every call
// carries the app's own auth headers (Bearer token + X-Session-Id, matching
// every other API helper in src/utils/store.ts); GET/POST/PUT/PATCH/DELETE go
// through small shared wrappers below, with two exceptions that need the raw
// Response: stageUpload (binary body) and body() (may 202 with no BodyPayload).
import { getAuthHeaders, handleResponse } from './store';
import type {
  Addr,
  AttachmentMeta,
  BodyPayload,
  BodyPending,
  MailAccount,
  MailAccountStatus,
  MailAction,
  MailFolder,
  MessageRow,
  Recipient,
  SendRequest,
  SendResult,
  SetupInfo,
  ThreadLink,
  ThreadListRow,
} from '../pages/mail/types';

export type ImapAccountInput = {
  /** Present to update an existing IMAP account in place; omitted to create a new one. */
  id?: string;
  emailAddress: string;
  displayName?: string | null;
  imapHost: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  username: string;
  /** Blank on an update keeps the previously stored password. */
  password?: string;
};

export type MailAccountPatch = Partial<{
  displayName: string;
  signatureHtml: string;
  status: Extract<MailAccountStatus, 'ok' | 'disabled'>;
  isDefault: boolean;
}>;

export type SaveAttachmentItem = {
  attId: string;
  name: string;
  kind: string;
  projectId?: string;
  customerId?: string;
};

export type SaveAttachmentsResult = {
  fileIds: string[];
  saved: Array<{ attId: string; fileId: string }>;
  failed: Array<{ attId: string; error: string }>;
};

export type DraftInput = { accountId: string; to: Addr[]; cc?: Addr[]; bcc?: Addr[]; subject: string; html: string };

const jsonHeaders = (): Record<string, string> => ({ 'Content-Type': 'application/json', ...getAuthHeaders() });

async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, init);
  await handleResponse(res);
  return res.json() as Promise<T>;
}

async function apiVoid(url: string, init: RequestInit = {}): Promise<void> {
  const res = await fetch(url, init);
  await handleResponse(res);
}

const get = <T>(url: string): Promise<T> => apiFetch<T>(url, { method: 'GET', headers: getAuthHeaders() });
const post = <T>(url: string, body?: unknown, method: string = 'POST'): Promise<T> =>
  apiFetch<T>(url, { method, headers: jsonHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
const postVoid = (url: string, body?: unknown, method: string = 'POST'): Promise<void> =>
  apiVoid(url, { method, headers: jsonHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
const del = (url: string): Promise<void> => apiVoid(url, { method: 'DELETE', headers: getAuthHeaders() });

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const mailApi = {
  accounts: (): Promise<MailAccount[]> => get('/api/mail/accounts'),

  createImapAccount: (b: ImapAccountInput): Promise<MailAccount> => post('/api/mail/accounts/imap', b),

  testAccount: (id: string): Promise<void> => postVoid(`/api/mail/accounts/${encodeURIComponent(id)}/test`),

  patchAccount: (id: string, patch: MailAccountPatch): Promise<MailAccount> =>
    post(`/api/mail/accounts/${encodeURIComponent(id)}`, patch, 'PATCH'),

  deleteAccount: (id: string): Promise<void> => del(`/api/mail/accounts/${encodeURIComponent(id)}`),

  loadOlder: (id: string, months: number): Promise<{ indexedSince: string }> =>
    post(`/api/mail/accounts/${encodeURIComponent(id)}/load-older`, { months }),

  // The browser NAVIGATES here (a redirect to the provider's consent screen),
  // so it can't carry an Authorization header — the token rides in the query
  // string instead, read from localStorage the same way getAuthHeaders() does.
  oauthStartUrl: (provider: 'google' | 'microsoft'): string => {
    const token = localStorage.getItem('token') || '';
    return `/api/mail/oauth/${provider}/start?token=${encodeURIComponent(token)}`;
  },

  providers: (): Promise<{ google: boolean; microsoft: boolean }> => get('/api/mail/providers'),

  folders: (accountId: string): Promise<MailFolder[]> => get(`/api/mail/folders${qs({ accountId })}`),

  threads: (q: { accountId: string; folderId?: string; q?: string; before?: string; limit?: number }): Promise<{
    threads: ThreadListRow[];
    hasMore: boolean;
    indexedSince: string;
  }> => get(`/api/mail/threads${qs(q)}`),

  thread: (accountId: string, threadKey: string): Promise<{ thread: ThreadListRow; messages: MessageRow[]; links: ThreadLink[] }> =>
    get(`/api/mail/threads/${encodeURIComponent(accountId)}/${encodeURIComponent(threadKey)}`),

  body: (messageId: string, opts?: { images?: boolean }): Promise<BodyPayload | BodyPending> =>
    get(`/api/mail/messages/${encodeURIComponent(messageId)}/body${qs({ images: opts?.images ? 1 : undefined })}`),

  // <img>/<a download> can't set an Authorization header, so this (like
  // oauthStartUrl) carries the token in the query string; ?inline=1 asks the
  // server for an inline Content-Disposition instead of a download prompt.
  attachmentUrl: (messageId: string, attId: string, opts?: { inline?: boolean }): string => {
    const token = localStorage.getItem('token') || '';
    return `/api/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attId)}${qs({
      token,
      inline: opts?.inline ? 1 : undefined,
    })}`;
  },

  saveAttachments: (messageId: string, items: SaveAttachmentItem[]): Promise<SaveAttachmentsResult> =>
    post(`/api/mail/messages/${encodeURIComponent(messageId)}/attachments/save`, { items }),

  messageActions: (ids: string[], action: MailAction, folderId?: string): Promise<void> =>
    postVoid('/api/mail/messages/actions', { ids, action, folderId }),

  threadActions: (accountId: string, threadKeys: string[], action: MailAction, folderId?: string): Promise<void> =>
    postVoid('/api/mail/threads/actions', { accountId, threadKeys, action, folderId }),

  send: (req: SendRequest): Promise<SendResult> => post('/api/mail/send', req),

  saveDraft: (b: DraftInput, existingId?: string): Promise<{ draftId: string }> =>
    existingId ? post(`/api/mail/drafts/${encodeURIComponent(existingId)}`, b, 'PUT') : post('/api/mail/drafts', b, 'POST'),

  deleteDraft: (accountId: string, draftId: string): Promise<void> =>
    del(`/api/mail/drafts/${encodeURIComponent(draftId)}${qs({ accountId })}`),

  stageUpload: (file: File): Promise<{ uploadId: string }> =>
    apiFetch(`/api/mail/uploads?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', ...getAuthHeaders() },
      body: file,
    }),

  searchServer: (accountId: string, q: string, before?: string): Promise<{ count: number }> =>
    get(`/api/mail/search${qs({ accountId, q, before })}`),

  recipients: (q: string): Promise<Recipient[]> => get(`/api/mail/recipients${qs({ q })}`),

  unreadCount: (): Promise<{ total: number; byAccount: Record<string, number> }> => get('/api/mail/unread-count'),

  heartbeat: (accountIds: string[]): Promise<void> => postVoid('/api/mail/heartbeat', { accountIds }),

  links: (itemType: string, itemId: string): Promise<ThreadLink[]> => get(`/api/mail/links${qs({ itemType, itemId })}`),

  createLink: (b: { threadKey: string; itemType: string; itemId: string }): Promise<ThreadLink> => post('/api/mail/links', b),

  deleteLink: (id: string): Promise<void> => del(`/api/mail/links/${encodeURIComponent(id)}`),

  setupInfo: (): Promise<SetupInfo> => get('/api/mail/setup-info'),
};

// Re-exported so callers of mailApi can import the shape of an attachment
// without reaching into pages/mail/types directly.
export type { AttachmentMeta };
