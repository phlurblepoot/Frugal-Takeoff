# Mail Client — Design Spec (Phase 1 of the email integration)

**Date:** 2026-08-29
**Status:** approved in brainstorming, awaiting written-spec review
**Scope:** full in-app email client (inbox, threads, compose, folders, drafts, search, multi-account) backed by provider-native APIs, plus the link data model and the "send from an item creates a linked thread" rewire. Everything else in the integration wishlist is Phase 2 and builds on the model defined here.

---

## 1. Goals and non-goals

### Goals
1. Each user connects their own mailbox (Google Workspace, Microsoft 365, or generic IMAP) and gets a full client under a new top-level **Mail** tab: folders/labels, threaded conversations, rich-text compose with reply/forward, attachments both ways, message actions, search, synced drafts, multiple accounts, unread badge with live updates.
2. The server keeps a **lightweight envelope index** (last 180 days, extendable on demand). **Bodies and attachments are never bulk-downloaded**: they are fetched from the provider when opened and streamed to the browser. Attachment bytes are persisted only when the user explicitly saves them to Documents.
3. Sending a document from an item (proposal, invoice, change order, pay app, issue, RFI, daily report, punch) goes through the same mail subsystem, lands in the user's Sent/thread, and **links the item to the thread** in an app-level, mailbox-independent table.
4. Secrets (OAuth refresh tokens, IMAP passwords, the existing SMTP password) are encrypted at rest.
6. First inbound-reply consumer: a reply on a thread linked to a sent RFI is captured as a **pending response** the user reviews and accepts — never auto-marked answered.
5. Setup for the two OAuth providers is documented in an in-app help page and a runbook.

### Non-goals (Phase 2+)
- Manual link management from a thread (link customer/project/item, multiple items) — the *table* ships now, the UI later.
- Convert thread → task / RFI / issue.
- Reply indicators on items other than RFIs (the `mail_thread_reply_state` table ships now so this is a query later; RFI pending-reply capture is the Phase 1 consumer, §4.7).
- Cross-user "open in my mailbox" resolution UI (the thread-key rule is defined here; Phase 1 only renders the current user's own links).
- Gmail Pub/Sub push (history polling is used; Pub/Sub noted as an optional upgrade).
- Calendar, contacts sync, shared mailboxes, swipe gestures on mobile.

---

## 2. Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Providers | Mixed per user: Google Workspace, Microsoft 365, generic IMAP. OAuth for the first two. |
| Transport | **Provider-native APIs** (Gmail API, Microsoft Graph); IMAP/SMTP only for generic accounts. One `MailProvider` interface hides the difference. |
| Deployment | Both testing and production are behind HTTPS → standard OAuth redirect flow. `APP_PUBLIC_URL` env tells the server its public origin. |
| Local storage | Envelope index only, **180 days** on first connect, "Load older mail" extends the window. No bodies, no attachment bytes, no draft bodies. |
| Attachments | Streamed from the provider to the browser on open. "Save to Documents…" opens the existing upload modal pre-populated with the message's attachments; user removes/unchecks, sets type + project, confirms; only then are bytes fetched and stored. |
| Secrets | AES-256-GCM. Key from `MAIL_SECRET_KEY`; if unset, auto-generate `data/mail.key` (mode 0600). Existing SMTP password migrated into the new store. |
| Reuse of existing email code | The per-user SMTP config is **absorbed** into mail accounts. The seven item send routes are kept (their side effects and tests stay) but send via the new `sendService`. `EmailComposer` is replaced by the new composer. The deps-injected route module pattern is kept because it is what makes the send routes testable. |
| Thread identity across users | RFC `Message-ID` / `References` chain (identical in every recipient's mailbox) is the primary key; subject + date-window match is the fallback; otherwise render as a reference card. Provider thread ids (Gmail `threadId`, Graph `conversationId`) are per-mailbox and are used only for provider calls. |
| Layout | Three-pane inbox (folder rail / thread list / reading pane), inline reply at the bottom of a thread, compose as a centered modal. Confirmed on mockups. |
| Sidebar position | **After Documents** in `WORKSPACE_NAV`. |
| Rich text | **TipTap** (MIT, ~100 KB gz). |
| Phase 1 features | All nine asked: folders/labels, threading, rich-text compose + signature, attachments both ways, message actions, search (local + server fallback), drafts synced to provider, multiple accounts per user, unread badge + live updates. |

---

## 3. Data model (migration 31)

All new tables. Column types are SQLite (`TEXT`/`INTEGER`/`REAL`); JSON columns hold serialized arrays/objects. Timestamps are ISO strings unless noted.

### `mail_accounts`
| column | notes |
|---|---|
| `id` TEXT PK | uuid |
| `userId` TEXT NOT NULL → `users.id` | owner; every route scopes by this |
| `provider` TEXT NOT NULL | `'google'` \| `'microsoft'` \| `'imap'` |
| `emailAddress` TEXT NOT NULL | the mailbox address, also the From address |
| `displayName` TEXT | From name |
| `signatureHtml` TEXT | per-account signature |
| `isDefault` INTEGER | exactly one per user (enforced in `accountStore`) |
| `authBlob` TEXT NOT NULL | **sealed** JSON: `{refreshToken}` for OAuth; `{imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure, username, password}` for IMAP |
| `syncState` TEXT | JSON: Gmail `{historyId}`; Graph `{deltaLinks: {folderId: link}, subscriptionId, subscriptionExpires}`; IMAP `{folders: {path: {uidValidity, lastUid}}}` |
| `indexedSince` TEXT NOT NULL | start of the indexed window; moves earlier on "Load older" |
| `status` TEXT NOT NULL | `'ok'` \| `'syncing'` \| `'auth_error'` \| `'needs_review'` \| `'disabled'` |
| `lastSyncAt`, `lastError` TEXT | diagnostics shown in Settings |
| `createdAt`, `updatedAt` TEXT | |

Index: `(userId)`.

### `mail_folders`
`id` PK, `accountId` → `mail_accounts.id` (cascade), `providerId` (label id / folder id / IMAP path), `name`, `role` (`'inbox'|'sent'|'drafts'|'trash'|'archive'|'spam'|'starred'|NULL`), `unreadCount`, `totalCount`, `sortOrder`. Unique `(accountId, providerId)`.

### `mail_messages` — the envelope index
| column | notes |
|---|---|
| `id` TEXT PK | uuid (local, never exposed as thread identity) |
| `accountId` → `mail_accounts.id` (cascade) | |
| `providerMessageId`, `providerThreadId` TEXT | for provider calls only |
| `messageIdHeader` TEXT | normalized (`<…>` stripped, lowercased) |
| `inReplyTo` TEXT, `referencesJson` TEXT | normalized |
| `threadKey` TEXT NOT NULL | see §3.1 |
| `fromAddr`, `fromName` TEXT | |
| `toJson`, `ccJson`, `bccJson` TEXT | `[{addr, name}]` |
| `subject` TEXT, `snippet` TEXT | snippet ≤ 200 chars, provider-supplied or derived from text part |
| `date` TEXT NOT NULL | message date, ISO |
| `isRead`, `isStarred`, `isDraft` INTEGER | |
| `hasAttachments` INTEGER, `attachmentsJson` TEXT | `[{attId, name, mime, size, contentId?}]` metadata only |
| `sizeBytes` INTEGER | |
| `folderIdsJson` TEXT | local `mail_folders.id[]` |
| `sentFromApp` INTEGER | set by `sendService` |
| `createdAt`, `updatedAt` TEXT | |

Indexes: `(accountId, date DESC)`, `(accountId, threadKey)`, `(messageIdHeader)`, unique `(accountId, providerMessageId)`.

### `mail_threads` — denormalized list rows
`id` PK, `accountId`, `threadKey`, `subject` (first non-empty, `Re:`/`Fwd:` stripped for display), `firstDate`, `lastDate`, `messageCount`, `unreadCount`, `hasAttachments`, `isStarred`, `participantsJson` (`[{addr, name}]` deduped), `folderIdsJson` (union of member folders), `updatedAt`. Unique `(accountId, threadKey)`; index `(accountId, lastDate DESC)`. Maintained by the sync engine after every message upsert.

### `mail_thread_links` — app-level, mailbox-independent
| column | notes |
|---|---|
| `id` TEXT PK | |
| `threadKey` TEXT NOT NULL | cross-user identity |
| `subjectSnapshot`, `firstDate`, `participantsJson` | for the reference card and the subject+date fallback |
| `itemType` TEXT NOT NULL | `'proposal'|'invoice'|'changeOrder'|'payApp'|'issue'|'rfi'|'dailyReport'|'punch'|'task'|'project'|'customer'` |
| `itemId` TEXT NOT NULL | for `project`/`customer` types this is the project/customer id |
| `projectId`, `customerId` TEXT | resolved chain (item → project → customer); NULL where not applicable |
| `linkedByUserId` TEXT NOT NULL | |
| `createdAt` TEXT | |

Unique `(threadKey, itemType, itemId)`. Indexes on `(itemType, itemId)`, `(projectId)`, `(customerId)`, `(threadKey)`.

### `mail_thread_reply_state`
`threadKey` PK, `lastInboundDate`, `lastOutboundDate`, `updatedAt`. Written by the sync engine for any indexed message whose `threadKey` has at least one link row (checked at upsert time) and by `sendService`. Inbound = `fromAddr` is not an address of any of the app's mail accounts; outbound otherwise.

### 3.1 Thread-key derivation (`server/mail/threadKey.ts`)
1. Normalize all ids: strip angle brackets/whitespace, lowercase.
2. Candidates = `References` (in order) + `In-Reply-To` + own `Message-ID`.
3. For each candidate in order, if any message in **the same account** already has `threadKey` for a message with that `messageIdHeader`, reuse that `threadKey`.
4. Otherwise, if `References` is non-empty, `threadKey` = first element of `References` (the root).
5. Otherwise `threadKey` = own `Message-ID`.
6. If the message has no `Message-ID` (rare, malformed), synthesize `sha1(accountId + providerMessageId)` — such keys never match cross-user and are marked `synthetic:` prefixed.
7. When a later message arrives that bridges two existing keys (root arrives after children), the engine merges: rewrites the newer key to the older one across `mail_messages`, `mail_threads`, `mail_thread_links`, `mail_thread_reply_state`.

Cross-user resolution rule (used by Phase 2, defined here): exact `threadKey` in the current user's index → open it; else a message in the current user's index with the same normalized subject and `date` within ±3 days of `firstDate` and sharing ≥1 participant → open that thread; else render a reference card.

### `rfis` — new columns (same migration)
`pendingReplyJson` TEXT NULL — `{ threadKey, accountId, mailMessageId, messageIdHeader, from: {addr, name}, date, text, attachments: [{attId, name, mime, size}], receivedAt }`. Written by §4.7, cleared on accept/dismiss. Only the newest un-reviewed inbound reply is kept.
`responseSource` TEXT NULL — `'manual'` \| `'email'`; `responseMessageIdHeader` TEXT NULL — set when a response was accepted from a reply, so the editor can offer "Open thread".

### 3.2 Changes to existing storage
- `user_preferences` rows `smtp.host/port/secure/username/password/fromName/fromAddress`: migration 31 creates one `mail_accounts` row per user with `smtp.host` set — `provider='imap'`, `emailAddress=fromAddress||username`, `displayName=fromName`, `authBlob` sealed with `imapHost=smtpHost` (guess), `imapPort=993`, `imapSecure=1`, SMTP fields copied, `status='needs_review'`, `isDefault=1`, `indexedSince=now-180d`. Then deletes the `smtp.*` rows. No mail is synced until the user opens Settings → Mail and confirms/edits the IMAP host ("Test & activate").
- `server/files.ts`: add `'email-attachment'` to `MULTI_INSTANCE_KINDS` so saving several attachments from one message with a source triple does not version one over another.
- `projects.meta.email` / `emails` (legacy `BidEmail`) — left in place, no longer read. The proposal send route's `project.email.messageId` check is removed (replaced by thread links).

Migration 31 is additive plus the SMTP transform. It runs under the existing auto-backup. **Flag as SUPERVISED** per the migration protocol.

---

## 4. Server subsystem (`server/mail/`)

```
server/mail/
  crypto.ts            seal(obj)/open(str) with AES-256-GCM; key resolution (§7)
  accountStore.ts      CRUD; setDefault; never returns authBlob to callers outside providers
  threadKey.ts         §3.1, pure
  sanitize.ts          HTML sanitizer (DOMPurify on jsdom) + cid: rewrite + remote-image blocking
  providers/
    types.ts           MailProvider interface + typed errors (AuthExpiredError, RateLimitedError, NotFoundError)
    google.ts          googleapis: OAuth (PKCE), users.messages.list/get (format=metadata for index), history.list, attachments.get, messages.send (raw MIME), modify labels, drafts.*
    microsoft.ts       @azure/msal-node (auth) + Graph REST via fetch: delta on /mailFolders/{id}/messages, /messages/{id}?$select=…, /attachments/{id}/$value, /sendMail, PATCH isRead/flag, /move, drafts, change-notification subscriptions
    imap.ts            imapflow (list/fetch/idle/store/move/append) + nodemailer (SMTP send)
    fake.ts            in-memory provider for tests / E2E (MAIL_FAKE_PROVIDER=1)
    mime.ts            build raw RFC 2822 MIME (html + text alternative + attachments); parse headers for IMAP
  sync/
    engine.ts          backfill(account) and incremental(account); upserts messages/threads/folders; merges keys; emits broadcastChange
    scheduler.ts       one SyncWorker per active account; start/stop/retry with backoff+jitter; Graph subscription renewal; SIGTERM stop
    bodyCache.ts       LRU (50 MB / 10 min) of sanitized bodies keyed by message id
  sendService.ts       send(userId, SendRequest) → provider.send → index sent row → write links → reply-state
  links.ts             resolveChain(itemType, itemId) → {projectId, customerId}; link CRUD used by sendService now, Phase 2 UI later
  routes.ts            registerMailRoutes(app, deps)
  oauth.ts             start/callback handlers; signed state JWT; PKCE
  setupInfo.ts         computes redirect URIs / webhook URL from APP_PUBLIC_URL for the help page
```

### 4.1 `MailProvider` interface
```ts
interface MailProvider {
  listFolders(): Promise<ProviderFolder[]>;
  backfill(opts: { since: Date; cursor?: string; folder?: string }): Promise<{ messages: Envelope[]; cursor?: string; done: boolean }>;
  incremental(state: SyncState): Promise<{ upserts: Envelope[]; deletes: string[]; folderChanges: FolderChange[]; state: SyncState }>;
  getBody(providerMessageId: string): Promise<{ html?: string; text?: string; attachments: AttachmentMeta[] }>;
  getAttachment(providerMessageId: string, attId: string): Promise<{ stream: Readable; mime: string; size?: number; name: string }>;
  send(msg: OutgoingMessage): Promise<{ providerMessageId: string; providerThreadId?: string; messageIdHeader: string }>;
  setFlags(ids: string[], flags: { read?: boolean; starred?: boolean }): Promise<void>;
  move(ids: string[], folderProviderId: string): Promise<void>;
  archive(ids: string[]): Promise<void>;   // Gmail: remove INBOX label; Graph/IMAP: move to Archive
  trash(ids: string[]): Promise<void>;
  saveDraft(draft: OutgoingMessage, existingProviderId?: string): Promise<{ providerMessageId: string }>;
  deleteDraft(providerMessageId: string): Promise<void>;
  search(query: string, opts: { before?: Date; limit: number }): Promise<Envelope[]>;  // server-side, older-than-index fallback
}
```
`Envelope` is the provider-neutral shape mapped 1:1 onto `mail_messages`. Providers get a `TokenSource` (refreshes from the sealed refresh token, caches the access token in memory) rather than raw credentials.

### 4.2 Sync behavior
| Provider | Initial backfill | Incremental | Freshness |
|---|---|---|---|
| Google | `messages.list` with `after:<indexedSince>` paged, `messages.get?format=metadata` batched (100/req) | `history.list` from stored `historyId`; on 404 (expired) re-backfill from `indexedSince` | poll every **30 s** while any owner session has `/mail` open (client heartbeat), else every **5 min** |
| Microsoft | delta query per folder with `$filter=receivedDateTime ge …` | stored `deltaLink` per folder | Graph **change notifications** → `POST /api/mail/ms/webhook` (validation-token handshake, `clientState` secret) triggers incremental; subscriptions renewed by scheduler every 48 h; **5 min** delta poll as safety net; if `APP_PUBLIC_URL` unset → poll only |
| IMAP | per folder `FETCH 1:* (UID ENVELOPE BODYSTRUCTURE FLAGS INTERNALDATE)` with `SINCE` | `UID > lastUid` + FLAGS diff; `UIDVALIDITY` change → refetch folder | persistent **IDLE** on INBOX; other folders every 5 min |

After each write batch the engine calls `broadcastChange({ type: 'mailThread', id: threadKey, byUserId: ownerUserId })` and `{ type: 'mailAccount', id: accountId }` for status/unread changes. `EntityType` unions on server and client gain `'mailThread' | 'mailAccount'`.

"Load older mail": `POST /api/mail/accounts/:id/load-older { months: 6 }` moves `indexedSince` back and enqueues a backfill for the new window only.

Failure policy: `AuthExpiredError` (refresh token rejected) → `status='auth_error'`, worker stops, Settings shows *Reconnect*. Network/5xx/429 → exponential backoff with jitter (max 10 min), status stays `ok`, `lastError` updated. A worker never marks `auth_error` on transient errors.

### 4.3 Body and attachment path
- `GET /api/mail/messages/:id/body` → cache hit or `provider.getBody` → `sanitize.ts` → `{ html, text, blockedRemoteImages: n, attachments }`. Sanitizer: DOMPurify allowlist (no script/form/iframe/object/style-with-url), `cid:` → `/api/mail/messages/:id/attachments/:attId?inline=1`, remote `src`/`background` rewritten to `data-blocked-src` unless `?images=1`.
- `GET /api/mail/messages/:id/attachments/:attId` → streams provider bytes with `Content-Type` and `Content-Disposition: attachment` (or `inline` with `?inline=1` for images/PDF). Nothing is written to disk. Accepts `?token=` like the files route so `<img>`/`<a download>` work.
- `POST /api/mail/messages/:id/attachments/save` `{ items: [{ attId, name, kind, projectId?, customerId? }] }` → for each item fetch bytes, `putBuffer(db, dataDir, uuid(), buf, mime, { projectId, customerId, kind, name, sourceType: 'mailMessage', sourceId: messageId })` → returns `{ fileIds }`. 100 MB cap per file.

### 4.4 Routes (`registerMailRoutes`) — all `authenticateToken`; all account/message/thread access is scoped to `mail_accounts.userId = req.user.id`
| Route | Purpose |
|---|---|
| `GET /api/mail/accounts` | list (no secrets), status, unread totals |
| `POST /api/mail/accounts/imap` | create/update IMAP account `{emailAddress, displayName, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure, username, password?}` (password optional on update = keep) |
| `POST /api/mail/accounts/:id/test` | IMAP: login + SMTP verify; OAuth: profile call |
| `PATCH /api/mail/accounts/:id` | displayName, signatureHtml, isDefault, status disable/enable |
| `DELETE /api/mail/accounts/:id` | removes account + its index (links remain — they are mailbox-independent) |
| `POST /api/mail/accounts/:id/load-older` | extend window |
| `GET /api/mail/oauth/:provider/start` | 302 to provider consent (state JWT, PKCE) |
| `GET /api/mail/oauth/:provider/callback` | exchange code, create/update account, start worker, 302 `/settings?tab=mail&connected=<id>` |
| `POST /api/mail/ms/webhook` | Graph notifications (unauthenticated by design; validated by `clientState` + validation token) |
| `GET /api/mail/folders?accountId` | |
| `GET /api/mail/threads?accountId&folderId&q&before&limit` | list rows from `mail_threads` (+ link chips for the caller's own links) |
| `GET /api/mail/threads/:accountId/:threadKey` | messages of the thread (envelopes) |
| `GET /api/mail/messages/:id/body` · `…/attachments/:attId` · `POST …/attachments/save` | §4.3 |
| `POST /api/mail/messages/actions` | `{ ids, action: 'read'|'unread'|'star'|'unstar'|'archive'|'trash'|'move', folderId? }` — applies locally first (optimistic), then provider, reverts on failure |
| `POST /api/mail/threads/actions` | same, expanded to member messages |
| `POST /api/mail/send` | `SendRequest` (§4.5) |
| `POST /api/mail/drafts` · `PUT /api/mail/drafts/:id` · `DELETE /api/mail/drafts/:id` | provider-synced drafts (body is sent to provider, only the envelope is indexed) |
| `GET /api/mail/search?accountId&q&before` | server-side search for mail older than the index |
| `GET /api/mail/recipients?q` | autocomplete: customer role emails (with customer name + role) ∪ recent correspondents from the caller's index |
| `GET /api/mail/unread-count` | for the sidebar badge |
| `GET /api/mail/links?itemType&itemId` · `POST /api/mail/links` · `DELETE /api/mail/links/:id` | link CRUD (used by Phase 1 chips + sendService; Phase 2 UI) |
| `POST /api/mail/heartbeat { accountIds }` | marks accounts "actively viewed" for the fast Gmail poll |
| `GET /api/mail/setup-info` (admin) | redirect URIs, webhook URL, which env vars are set (never values) |

### 4.5 `sendService.send(userId, req)`
```ts
interface SendRequest {
  accountId?: string;               // default account when omitted
  to: Addr[]; cc?: Addr[]; bcc?: Addr[];
  subject: string; html: string;    // text alternative generated server-side
  attachments: Array<
    | { fileId: string; name?: string; itemType?: ItemType; itemId?: string }   // from Documents (item tag → link)
    | { uploadId: string }                                                        // staged device upload (§5.4)
  >;
  replyTo?: { accountId: string; threadKey: string };  // sets In-Reply-To/References to the thread's last message
  links?: Array<{ itemType: ItemType; itemId: string }>; // explicit links (item send routes pass their item)
  draftProviderId?: string;          // delete this draft after a successful send
}
```
Steps: resolve account → build MIME/outgoing → `provider.send` → upsert the sent envelope into `mail_messages` (`sentFromApp=1`, `threadKey` via §3.1 so replies land in the same thread) → for each link (explicit + attachment item tags) `links.create` with resolved chain (idempotent on the unique key) → **run item send effects (§4.6) for every linked item** → `mail_thread_reply_state.lastOutboundDate` → `broadcastChange`. For IMAP the provider APPENDs the sent MIME to the Sent folder (`\Seen`). Gmail/Graph save Sent automatically.

The seven existing item send routes keep their URL and auth but replace `sendProjectEmail` with `sendService.send`, passing `links: [{ itemType, itemId }]` and the generated PDF as `{ fileId }`; their status/activity side effects move into §4.6 so they run identically from either path. `registerEmailRoutes`' SMTP config/test routes (`/api/email/smtp`, `/api/email/test-smtp`) are removed; `getUserSmtp`/`buildTransporter` in `server.ts` are removed.

### 4.6 Item send effects (`server/mail/itemSendEffects.ts`)
One function `applySendEffects(db, { itemType, itemId, userId, role, threadKey, messageId })` holding the per-item side effects that today are inlined in the seven routes:

| itemType | effect (unchanged from today) |
|---|---|
| `proposal` | `markSent` (if not already sent/accepted), activity `proposal_sent`, broadcast |
| `invoice` | `setInvoiceStatus('sent')` unless already sent/paid |
| `changeOrder` | `setChangeOrderStatus('sent')` unless sent/approved/rejected |
| `issue` | `markIssueSent` |
| `rfi` | `markRfiSent` |
| `dailyReport`, `punch`, `payApp` | activity row only |
| `task`, `project`, `customer` | none (link only) |

It is invoked **both** by the item send routes and by `sendService` when a send carries an item tag — which is the case when a user replies in an existing thread and attaches a proposal (or any item document) from the Documents picker. So "send a proposal into an existing thread" marks the proposal sent exactly as the proposal's own Send button would, and the activity row records the thread it went to. Effects are idempotent (already-sent items are left alone), so resending the same document later only adds activity.

Role rule: effects for admin-gated item types (`proposal`, `invoice`, `changeOrder`, `payApp`) run only when the sending user is an admin — the same gate as their routes. Non-admins cannot pick those documents in the first place (`NON_ADMIN_EXCLUDED_KINDS` hides them from the picker), so in practice the gate is a server-side safety check; if it trips, the send still goes out and the link is still written, but the status is untouched and the response carries `effectsSkipped: [...]` so the composer can show a note.

### 4.7 Inbound reply hooks (`server/mail/inboundHooks.ts`)
After the sync engine upserts an **inbound** message (per the reply-state rule in §3) whose `threadKey` has link rows, it calls `applyInboundHooks(db, { threadKey, message })`. Phase 1 registers one hook:

**RFI pending response.** For every `rfi` link on the thread whose RFI is in status `sent` (not `open`, `answered`, `closed`): write `rfis.pendingReplyJson` from the message — sender, date, the reply's plain text with the quoted original stripped (`mailparser`/`talon`-style quote detection: lines after `On … wrote:`/`From:` headers/`>`-prefixed blocks are dropped; fall back to the full text if stripping leaves nothing), attachment metadata, and the message ids — then bump `version`/`updatedAt` and `broadcastChange({ type: 'rfi', id })`. A later inbound reply on the same thread replaces the pending one. The RFI status is **not** changed; `answeredAt` stays null. Outbound messages (the user's own replies) never touch it.

Accept / dismiss routes: `POST /api/rfis/:id/pending-reply/accept { text?: string, responseFileId?: string }` → `setRfiResponse` with the (possibly edited) text and optional file, sets `responseSource='email'` and `responseMessageIdHeader`, clears `pendingReplyJson`. `POST /api/rfis/:id/pending-reply/dismiss` → clears it only. Both are `authenticateToken` (RFIs are non-admin items).

Client: `RfiEditor` shows a banner above the Response section when `pendingReplyJson` is set — "Reply received from Alicia Chen · Aug 29 10:42 · [Use as response] [Dismiss] [Open thread]" — with the extracted text shown in a read-only preview. **Use as response** copies the text into the (editable) response field, and if the reply has attachments opens the Save-to-Documents modal (§5.2) pre-filled so one can be picked as the response file; the accept call is made on the editor's Save. `Open thread` navigates to the current user's copy of the thread when it exists in their index (exact `threadKey`, then subject+date fallback), otherwise shows the reference card. The RFI list row and the project's RFI tab show a small "reply" chip while a pending reply exists. `useLiveQuery` on `rfi` keeps the banner live when the reply arrives while the editor is open.

The generic `mail_thread_reply_state` row is still written for every linked thread (any item type); only the RFI hook has UI in Phase 1. Issues, change orders, proposals get "reply received" indicators in Phase 2 through the same hook registry.

Version note: the picker attaches the document's stored bytes as-is. If the item's generated PDF is stale relative to its data (the freshness chip in `DocumentActionsBar`), the composer shows the same "out of date — regenerate?" hint before send; it does not regenerate silently.

---

## 5. Client

### 5.1 Navigation and routing
- `WORKSPACE_NAV`: `Mail` entry **after Documents**, lucide `Mail` icon, unread badge from `GET /api/mail/unread-count` refreshed by `useLiveQuery` on `mailThread`/`mailAccount` events.
- Routes: `/mail` → redirect to default account inbox; `/mail/:accountId/:folderId`; `/mail/:accountId/:folderId/:threadKey`. Deep-linkable threads are what Phase 2 item links navigate to.
- CommandPalette: "Go to Mail", "New email".

### 5.2 `src/pages/mail/`
| file | purpose |
|---|---|
| `MailPage.tsx` | three-pane shell; responsive: ≥ lg three panes, md two panes (rail collapses to a drawer), < md stacked screens list → thread → compose with back nav |
| `FolderRail.tsx` | Compose button, account switcher, role folders, then provider labels/folders with unread counts |
| `ThreadList.tsx` + `ThreadRow.tsx` | virtualized list; unread dot, participants + count, subject, snippet, date, star/attachment icons, link chips; search box; infinite scroll; "Showing last 180 days · Load older mail" footer |
| `ThreadView.tsx` + `MessageCard.tsx` | toolbar (reply/reply all/forward/archive/move/trash/star/mark unread/⋯); link strip (Phase 1: shows existing chips only, no "+ Link" yet); older messages collapsed, latest expanded; sanitized body in a sandboxed `<iframe sandbox="" srcdoc>` with auto-height, CSP `default-src 'none'; img-src <self-attachment-route> data:; style-src 'unsafe-inline'`; "Remote images blocked · Load images" bar; attachment chips (click = download/open) + "Save to Documents…" |
| `SaveAttachmentsModal.tsx` | wraps the existing Documents upload modal in a mode that takes pre-listed remote items instead of `File`s: same type/project selectors, per-row remove/uncheck; confirm → `POST …/attachments/save` |
| `Composer.tsx` | modal (new/forward/"open in composer") and inline (reply) variants sharing one component: From account, To/Cc/Bcc pills with autocomplete (`GET /api/mail/recipients`), Always-CC pre-filled from `emailAlwaysCc`, subject, TipTap body (bold/italic/underline/heading/lists/quote/link/clear), signature inserted, quoted original for reply/forward, attachments via device (`AddFilesButton`) or `FilePickerModal` (documents; picked rows carry `sourceType/sourceId` → item tag), draft auto-save (debounced 3 s → drafts routes), Send |
| `mailApi.ts` (in `src/utils/`) | typed client for all `/api/mail/*` routes; kept out of `store.ts` |
| `useMailAccounts.ts`, `useThreadList.ts`, `useThread.ts` | data hooks built on `useLiveQuery` |

### 5.3 Settings → Mail tab (replaces the Email tab's SMTP card; "Always CC" card stays)
- Connected accounts list: provider icon, address, status pill (`ok` / `syncing` / `needs review` / `auth error → Reconnect` / `disabled`), last sync, default toggle, signature editor (TipTap), remove.
- Buttons: **Connect Google**, **Connect Microsoft** (disabled with "Not configured on this server" when the env vars are missing), **Add IMAP account** (form: address, display name, IMAP host/port/SSL, SMTP host/port/STARTTLS-or-SSL, username, password, "Test & save").
- Migrated legacy SMTP account shows `needs review` with the IMAP host pre-filled from the SMTP host; "Test & activate" flips it to `ok` and starts syncing.
- Admin-only **Server setup guide** panel (§8) with copy buttons for the exact redirect URIs and webhook URL from `GET /api/mail/setup-info`.

### 5.4 Item send rewire (client side)
`DocumentActionsBar`'s `send` slot mounts the new `Composer` (modal variant) pre-filled as today (resolved recipient, subject, body template, generated PDF as a tagged attachment). If the item already has a link, the composer header offers **Reply in existing thread** (default) / **New thread**. If the user has no active mail account, the slot renders "Connect a mail account in Settings → Mail" and Send is disabled. After a successful send the bar shows a chip: `Sent · <date> · Open thread` (navigates to `/mail/:accountId/:folderId/:threadKey` when the thread exists in the current user's index; otherwise a tooltip "Sent by <user> from their mailbox").

Device attachments in the composer are staged with `POST /api/mail/uploads` (raw body, temp file under `data/tmp/mail-uploads/`, deleted after send or after 1 h) and referenced as `{ uploadId }` so the send request stays JSON.

### 5.5 Mobile
Stacked screens; the reading pane's toolbar collapses into a `⋯` menu; composer is full-screen. Same responsive tokens as the Customers split view. Swipe actions deferred.

---

## 6. Provider setup (admin, one-time)

### Google Workspace
1. Google Cloud Console → project → enable **Gmail API**.
2. OAuth consent screen: **Internal** (Workspace only; avoids restricted-scope verification). Personal Gmail users would require External + verification — documented as unsupported by default.
3. Credentials → OAuth client (Web application) → authorized redirect URI `https://<host>/api/mail/oauth/google/callback` (one client per environment).
4. Scopes requested: `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/gmail.send`, `openid email`.
5. Env: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`.

### Microsoft 365
1. Entra admin center → App registrations → new registration, single-tenant (or multi-tenant if needed).
2. Redirect URI (Web) `https://<host>/api/mail/oauth/microsoft/callback`.
3. API permissions (delegated): `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`; grant admin consent.
4. Client secret → env `MS_OAUTH_CLIENT_ID`, `MS_OAUTH_CLIENT_SECRET`, `MS_OAUTH_TENANT` (tenant id or `common`).

### Generic IMAP
No admin setup. Users need IMAP + SMTP hosts and (usually) an app password.

### Server env summary
`APP_PUBLIC_URL` (required for OAuth + webhook URL construction), `MAIL_SECRET_KEY` (optional; auto key file otherwise), the five OAuth vars above, `MAIL_FAKE_PROVIDER=1` (tests/E2E only).

---

## 7. Security

- **Encryption at rest:** AES-256-GCM, random 12-byte IV per record, key = `MAIL_SECRET_KEY` (32 bytes hex/base64) or `data/mail.key` generated with `crypto.randomBytes(32)` and written with mode `0600` on first use. Key loss ⇒ users reconnect accounts; no other data loss. `mail.key` is added to the backup manifest and restore runbook (Phase 6 tooling).
- **OAuth:** PKCE (S256) for both providers; `state` = JWT signed with the app JWT secret containing `{ userId, provider, nonce, exp: 10 min }`; callback rejects mismatched user. Access tokens live only in memory; refresh tokens only sealed in `authBlob`. No secrets in logs or API responses.
- **Ownership:** every mail route resolves the account through `accountStore.getOwned(req.user.id, accountId)`; message/thread routes join through the account. No admin bypass into other users' mail.
- **Email HTML:** server-side sanitizer (DOMPurify on jsdom) + client sandboxed iframe with a restrictive CSP; remote images blocked until the user opts in per message; links `target=_blank rel=noopener`; `mailto:` intercepted to open the composer.
- **Attachments:** streamed, never persisted unless saved; saved files respect the 100 MB cap and existing `putBuffer` rules; served with `Content-Disposition` and `X-Content-Type-Options: nosniff`.
- **Webhook:** `clientState` = random secret stored in `settings` at first subscription; validation-token handshake; unknown subscription ids ignored; body never trusted beyond "go run incremental for account X".
- **Rate limits / quotas:** batched Gmail metadata gets, delta queries for Graph, single IMAP connection per account; backoff on 429.
- **Process lifecycle:** scheduler hooked into the existing `flushAndExit` on SIGTERM/SIGINT. Assumes one server process (Unraid deploy); documented.

---

## 8. Help page and runbook
- In-app: Settings → Mail → **Server setup guide** (admin-only) — step lists for Google and Microsoft exactly as §6, with the computed redirect URIs / webhook URL and copy buttons, plus a table of env vars showing set/unset.
- Repo: `docs/mail-setup.md` — the same content plus the key-file/backup notes and a troubleshooting section (auth_error, webhook validation failures, Gmail historyId expiry).
- Changelog entry in `Settings.tsx` per project convention.

---

## 9. Testing

| Layer | What |
|---|---|
| Unit (server) | `crypto` round-trip + key-file creation; `threadKey` (References walk, normalization, merge on late root, synthetic keys); `sanitize` allowlist + cid rewrite + image blocking; `mime` build/parse; `links.resolveChain`; sync engine against `providers/fake.ts` (backfill window, incremental upserts/deletes, folder counts, thread denormalization, reply-state); migration 31 on a seeded DB with `smtp.*` prefs (row created, sealed, prefs deleted, `needs_review`) |
| Unit (server, cont.) | `inboundHooks`: inbound reply on a thread linked to a `sent` RFI writes `pendingReplyJson` (quote-stripped text, attachments), a second reply replaces it, outbound messages and `open`/`answered`/`closed` RFIs are ignored, status never changes; accept sets response + `answered` + source fields and clears pending; dismiss clears only |
| Routes (supertest) | every `/api/mail/*` with the fake provider injected; ownership isolation between two users; optimistic action revert on provider failure; attachment save writes files with `sourceType='mailMessage'`; the seven item send routes asserting side effects + link rows + sent index row; `POST /api/mail/send` with a tagged proposal attachment into an existing thread → proposal marked sent + activity + link (and unchanged when already sent; `effectsSkipped` for a non-admin); OAuth start/callback with a stubbed token exchange; Graph webhook validation |
| Provider adapters | contract tests against recorded JSON fixtures for Gmail and Graph (no network); IMAP adapter against a fake imapflow client; `npm run mail:smoke -- --account <id>` manual live check |
| UI (vitest/jsdom) | RfiEditor pending-reply banner (use as response fills field, dismiss clears, chip on list row); ThreadList/ThreadRow rendering + unread/link chips; Composer autocomplete + always-CC prefill + attachment item tagging; SaveAttachmentsModal pre-fill/remove; Settings account cards + disabled OAuth buttons; Sidebar badge |
| E2E (Playwright, `MAIL_FAKE_PROVIDER=1`) | connect fake account → seeded threads visible → open thread → body renders in iframe, remote image blocked → reply inline → row moves to top; send an invoice from its editor → link chip appears → thread opens from chip; save attachment → appears in Documents; send an RFI → fake provider injects a reply → RFI editor shows the banner → Use as response → status answered |
| Manual smoke | send an RFI to yourself from a second account, reply, verify banner + accept flow; real Google + Microsoft + IMAP connect; push freshness (send yourself a mail); sanitizer on a hostile HTML sample; attachment save; phone/tablet stacked layout; SMTP-migrated account "Test & activate" |

---

## 10. Dependencies added
`googleapis` (or the lighter `@googleapis/gmail`), `@azure/msal-node`, `imapflow`, `mailparser`, `dompurify` + `jsdom` (jsdom already a dev dep → becomes runtime), `@tiptap/react` + `@tiptap/starter-kit` + `@tiptap/extension-link`. `nodemailer` stays (IMAP accounts' SMTP).

---

## 11. Rollout
1. Migration 31 on testing (supervised, backup auto-taken; confirm the migrated SMTP account shows `needs review`).
2. Register the OAuth apps for the testing hostname; set env; verify with the setup-info page.
3. Connect real accounts; run the manual smoke list.
4. Production: same env for the production hostname; pull; migrate; reconnect.
