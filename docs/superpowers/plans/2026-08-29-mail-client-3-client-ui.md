# Mail Client — Plan 3 of 4: Client UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Mail tab — three-pane inbox, thread reading pane with sandboxed bodies and attachment handling, rich-text composer with autocomplete/drafts/signatures, Settings → Mail account management with the admin setup guide — and swap every item editor's Send onto the new composer with a "Sent · Open thread" chip.

**Architecture:** New `src/pages/mail/` section following the Documents-page pattern (route child in `App.tsx`, `WORKSPACE_NAV` entry, CommandPalette action, page dir, API client). Data flows through `src/utils/mailApi.ts` + hooks built on `useLiveQuery` (`mailThread`/`mailAccount` events). Bodies render in a sandboxed `<iframe srcdoc>`. The composer (`MailComposer`) is one component with `modal` and `inline` variants and replaces `EmailComposer` inside `DocumentActionsBar`.

**Tech Stack:** React 19, React Router 7, Tailwind 4 tokens (`bg-surface`, `bg-raised`, `border-edge`, `text-ink`, `text-ink-soft`, `text-ink-faint`, `text-accent`, `border-accent-500`), lucide-react, `@tiptap/react` + `@tiptap/starter-kit` + `@tiptap/extension-link` + `@tiptap/extension-placeholder`, vitest (`ui` project, jsdom, `@testing-library/react`).

**Spec:** `docs/superpowers/specs/2026-08-29-mail-client-design.md` §5 (all), §4.4 (client contracts), §8 (help page), §9 UI rows. Wireframes approved on 2026-08-29 (three-pane, inline reply, modal compose).

## Global Constraints

- Plan 1/2 server contracts are fixed; the client consumes exactly the routes/shapes in Plan 1 Task 12 (`ThreadListRow`, `MessageRow`, `BodyPayload`) and the accounts shape from `GET /api/mail/accounts`.
- `uuid` for ids; no `crypto.randomUUID`.
- Mobile: `< md` (767px, matches `AppShell.tsx:21`) stacked screens; `md`–`lg` two panes; `≥ lg` three panes.
- Every new component has a vitest test beside it; keep `src/utils/store.ts` untouched except deletions from Plan 1 — mail calls live in `src/utils/mailApi.ts`.
- Use existing primitives from `src/components/ui` (`Button`, `Modal`, `Field`, `Input`, `Select`, `Textarea`, `Checkbox`, `EmptyState`, `Skeleton`) and `useToast` from `src/components/Toast`.
- Sidebar entry goes **after Documents**.
- Changelog entry in `src/pages/Settings.tsx` (array near line 27) as the last task.

## File map

| File | Responsibility |
|---|---|
| `src/utils/mailApi.ts` (+test) | typed fetch client for `/api/mail/*` |
| `src/pages/mail/types.ts` | client types mirroring server contracts |
| `src/pages/mail/useMailAccounts.ts`, `useThreadList.ts`, `useThread.ts`, `useMailHeartbeat.ts` | data hooks |
| `src/pages/mail/MailPage.tsx` | route shell, pane layout, URL state |
| `src/pages/mail/FolderRail.tsx` | compose, account switcher, folders |
| `src/pages/mail/ThreadList.tsx`, `ThreadRow.tsx` | list + rows |
| `src/pages/mail/ThreadView.tsx`, `MessageCard.tsx`, `MessageBodyFrame.tsx`, `AttachmentChips.tsx` | reading pane |
| `src/pages/mail/SaveAttachmentsModal.tsx` | remote-attachment variant of the upload modal |
| `src/pages/mail/compose/MailComposer.tsx`, `RecipientsField.tsx`, `RichTextEditor.tsx`, `useDraftAutosave.ts` | composer |
| `src/pages/mail/MailSetupGuide.tsx` | admin help panel |
| `src/pages/settings/MailAccountsTab.tsx` | Settings → Mail (extracted, not inline in Settings.tsx) |
| `src/components/documents/DocumentActionsBar.tsx` | swap composer; sent chip |
| `src/components/documents/SentThreadChip.tsx` | "Sent · date · Open thread" |
| `src/components/shell/Sidebar.tsx`, `src/App.tsx`, `src/components/CommandPalette.tsx` | navigation |
| `src/pages/documents/UploadDocumentsModal.tsx` | accept `remoteItems` (pre-listed attachments) |

---

### Task 1: API client + types

**Files:**
- Create: `src/utils/mailApi.ts`, `src/pages/mail/types.ts`
- Test: `src/utils/mailApi.test.ts`

**Interfaces (produces):**

```ts
// src/pages/mail/types.ts
export interface Addr { addr: string; name?: string }
export interface MailAccount { id: string; provider: 'google'|'microsoft'|'imap'|'fake'; emailAddress: string; displayName: string | null; signatureHtml: string | null; isDefault: number; status: 'ok'|'syncing'|'auth_error'|'needs_review'|'disabled'; lastSyncAt: string | null; lastError: string | null; indexedSince: string; unreadCount: number }
export interface MailFolder { id: string; accountId: string; providerId: string; name: string; role: string | null; unreadCount: number; totalCount: number; sortOrder: number }
export interface ThreadLink { id: string; threadKey: string; itemType: string; itemId: string; projectId: string | null; customerId: string | null }
export interface ThreadListRow { threadKey: string; subject: string; firstDate: string; lastDate: string; messageCount: number; unreadCount: number; hasAttachments: number; isStarred: number; participants: Addr[]; folderIds: string[]; snippet: string; links: ThreadLink[] }
export interface AttachmentMeta { attId: string; name: string; mime: string; size: number; contentId?: string }
export interface MessageRow { id: string; accountId: string; threadKey: string; messageIdHeader: string | null; from: Addr | null; to: Addr[]; cc: Addr[]; bcc: Addr[]; subject: string; snippet: string; date: string; isRead: boolean; isStarred: boolean; isDraft: boolean; hasAttachments: boolean; attachments: AttachmentMeta[]; folderIds: string[]; sentFromApp: boolean }
export interface BodyPayload { html: string; text: string; blockedRemoteImages: number; attachments: AttachmentMeta[] }
export type MailAction = 'read'|'unread'|'star'|'unstar'|'archive'|'trash'|'move';
export interface SendRequest { accountId?: string; to: Addr[]; cc?: Addr[]; bcc?: Addr[]; subject: string; html: string; attachments: Array<{ fileId: string; name?: string; itemType?: string; itemId?: string } | { uploadId: string }>; replyTo?: { accountId: string; threadKey: string }; links?: Array<{ itemType: string; itemId: string }>; draftProviderId?: string }
export interface SendResult { messageId: string; threadKey: string; accountId: string; effectsSkipped: string[] }
export interface Recipient extends Addr { source: string; customerId?: string; role?: string }
export interface SetupInfo { publicUrl: string | null; google: { configured: boolean; redirectUri: string | null }; microsoft: { configured: boolean; redirectUri: string | null; webhookUrl: string | null; tenant: string }; secretKey: 'env'|'file' }
```

```ts
// src/utils/mailApi.ts — every function: getAuthHeaders() + handleResponse() from store.ts (import them; they are exported? check `grep -n "export const getAuthHeaders\|export const handleResponse" src/utils/store.ts`; if not exported, export them).
export const mailApi = {
  accounts: () => Promise<MailAccount[]>,
  createImapAccount: (b: {...}) => Promise<MailAccount>, testAccount: (id) => Promise<void>, patchAccount: (id, patch) => Promise<MailAccount>, deleteAccount: (id) => Promise<void>, loadOlder: (id, months) => Promise<{ indexedSince: string }>,
  oauthStartUrl: (provider: 'google'|'microsoft') => string,     // `/api/mail/oauth/${provider}/start?token=${encodeURIComponent(localStorage token)}` — read the token the same way getAuthHeaders does
  folders: (accountId) => Promise<MailFolder[]>,
  threads: (q: { accountId; folderId?; q?; before?; limit? }) => Promise<{ threads: ThreadListRow[]; hasMore: boolean; indexedSince: string }>,
  thread: (accountId, threadKey) => Promise<{ thread: ThreadListRow; messages: MessageRow[]; links: ThreadLink[] }>,
  body: (messageId, opts?: { images?: boolean }) => Promise<BodyPayload>,
  attachmentUrl: (messageId, attId, opts?: { inline?: boolean }) => string,   // includes ?token=
  saveAttachments: (messageId, items: Array<{ attId; name; kind; projectId?; customerId? }>) => Promise<{ fileIds: string[] }>,
  messageActions: (ids: string[], action: MailAction, folderId?) => Promise<void>,
  threadActions: (accountId, threadKeys: string[], action: MailAction, folderId?) => Promise<void>,
  send: (req: SendRequest) => Promise<SendResult>,
  saveDraft: (b: { accountId; to; cc; bcc; subject; html }, existingId?) => Promise<{ draftId: string }>, deleteDraft: (accountId, draftId) => Promise<void>,
  stageUpload: (file: File) => Promise<{ uploadId: string }>,    // POST /api/mail/uploads?name= with the File body
  searchServer: (accountId, q, before?) => Promise<{ count: number }>,
  recipients: (q) => Promise<Recipient[]>, unreadCount: () => Promise<{ total: number; byAccount: Record<string, number> }>, heartbeat: (accountIds: string[]) => Promise<void>,
  links: (itemType, itemId) => Promise<ThreadLink[]>, createLink: (b) => Promise<ThreadLink>, deleteLink: (id) => Promise<void>,
  setupInfo: () => Promise<SetupInfo>,
};
```

- [ ] **Step 1: Write the failing test** — mock `global.fetch` (`vi.stubGlobal('fetch', vi.fn())`) and assert URL/method/body for `threads`, `messageActions`, `send`, `stageUpload` (raw body, `?name=`), `attachmentUrl` contains `?token=` and `inline=1`, `oauthStartUrl` embeds the token.
- [ ] **Step 2: Run** `npx vitest run --project ui src/utils/mailApi.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Run** → pass. **Step 5: Commit** `feat(mail-ui): mail API client and types`.

---

### Task 2: Navigation — route, sidebar entry with badge, palette actions

**Files:**
- Modify: `src/App.tsx` (~line 130, add `{ path: 'mail', element: <MailPage /> }`, `{ path: 'mail/:accountId', element: <MailPage /> }`, `{ path: 'mail/:accountId/:folderId', element: <MailPage /> }`, `{ path: 'mail/:accountId/:folderId/:threadKey', element: <MailPage /> }`), `src/components/shell/Sidebar.tsx:23-30`, `src/components/CommandPalette.tsx:80`, `src/components/shell/Sidebar.test.tsx`
- Create: `src/pages/mail/MailPage.tsx` (placeholder rendering `<h1>Mail</h1>` — filled in Task 3), `src/pages/mail/useMailUnread.ts` (+test)

**Interfaces:**
- `useMailUnread(): number` — loads `mailApi.unreadCount().total`, re-fetches via `useLiveQuery(load, { types: ['mailThread', 'mailAccount'] }, { debounceMs: 1000 })`; returns 0 when the request fails (user has no accounts / server old).
- `NavEntry` gains optional `badge?: () => number` — Sidebar renders a small pill (`bg-accent-500 text-[10px] font-semibold rounded-full px-1.5`) when `> 0`, with `aria-label="N unread"`; collapsed state shows a dot.

- [ ] **Step 1: Tests** — `Sidebar.test.tsx`: renders "Mail" after "Documents" (query all nav links, assert order); with `useMailUnread` mocked to 7, shows `7`; `useMailUnread.test.ts`: fetch mocked → returns total; failure → 0.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — `WORKSPACE_NAV` entry `{ id: 'mail', label: 'Mail', Icon: Mail, path: '/mail', match: p => p.startsWith('/mail'), badge: useMailUnreadRef }` — hooks can't live in a const array; instead `Sidebar` calls `const unread = useMailUnread()` and passes `badge={entry.id === 'mail' ? unread : 0}` to `NavRow`. Palette: `{ id: 'a:mail', title: 'Mail', icon: <Mail size={16}/>, run: () => navigate('/mail') }` and `{ id: 'a:mail-compose', title: 'New email', run: () => navigate('/mail?compose=1') }`.
- [ ] **Step 4: Run** → pass (`npx vitest run --project ui src/components/shell src/pages/mail`). **Step 5: Commit** `feat(mail-ui): Mail navigation entry with unread badge`.

---

### Task 3: Page shell, folder rail, thread list

**Files:**
- Create: `src/pages/mail/MailPage.tsx` (replace placeholder), `FolderRail.tsx`, `ThreadList.tsx`, `ThreadRow.tsx`, `useMailAccounts.ts`, `useThreadList.ts`, `useMailHeartbeat.ts`, `mailFormat.ts` (`formatMailDate(iso)`: today → `10:42 AM`, this year → `Aug 27`, else `8/27/25`; `participantsLabel(participants, ownAddresses)`: replaces own address with "me", joins first names, max 3 + "…")
- Tests: `MailPage.test.tsx`, `ThreadRow.test.tsx`, `FolderRail.test.tsx`, `mailFormat.test.ts`, `useThreadList.test.ts`

**Interfaces:**
- `useMailAccounts(): { accounts: MailAccount[]; loading: boolean; reload(): void }` — live on `mailAccount`.
- `useThreadList(accountId: string | null, folderId: string | null, q: string): { threads: ThreadListRow[]; loading: boolean; hasMore: boolean; loadMore(): void; indexedSince: string | null; reload(): void }` — first page on change; `loadMore` passes `before = last.lastDate`; live reload on `mailThread` (debounce 500 ms, preserves loaded pages by refetching with `limit = loaded count`).
- `useMailHeartbeat(accountId | null)` — `POST /api/mail/heartbeat` every 25 s while mounted and the tab is visible (`document.visibilityState`).
- URL state: `/mail/:accountId?/:folderId?/:threadKey?` + `?q=` + `?compose=1`. No account → redirect to default account's inbox once accounts load; no accounts at all → `EmptyState` "Connect a mail account" with a button to `/settings?tab=mail`.
- `MailPage` layout: `grid` with columns `auto 320px 1fr` at `lg`, `auto 1fr` at `md` (rail + list; opening a thread swaps the list for the thread with a Back button), single column `< md` (list → thread → compose as screens via the URL).
- `ThreadRow` props: `{ row: ThreadListRow; selected: boolean; ownAddresses: string[]; onOpen(): void; onToggleStar(): void }` — layout per wireframe: unread dot column, participants + `(count)`, subject (bold when unread), snippet (ellipsis), link chips (`row.links` → `itemType` label + project name? project names aren't in the row → show `itemType` label only, e.g. "RFI", "Proposal"; project chips come in Phase 2), right column date + 📎/★ icons. `data-testid="mail-thread-row"`, `data-unread`.
- `FolderRail` props: `{ accounts; accountId; folders: MailFolder[]; folderId; onSelectAccount; onSelectFolder; onCompose }` — Compose button, account `<select>` when `> 1`, role folders in fixed order (inbox, starred, sent, drafts, archive, trash, spam) then other folders alphabetically under a "Labels" caption; each shows `unreadCount` when `> 0`.
- `ThreadList` props: `{ threads; loading; hasMore; onLoadMore; indexedSince; onLoadOlder(); q; onQueryChange; selectedKey; ownAddresses; onOpen; onToggleStar }` — search input (debounced 300 ms into the URL `?q=`), rows, sentinel at the bottom: while `hasMore` → "Load more" (auto via IntersectionObserver when available; a button fallback), else "Showing mail since {date} · Load older mail" which calls `onLoadOlder` (→ `mailApi.loadOlder(accountId, 6)` then toast "Loading older mail…").

- [ ] **Step 1: Tests**
  - `mailFormat.test.ts`: the three date branches; participants label with "me" substitution and truncation.
  - `ThreadRow.test.tsx`: unread row has bold subject + `data-unread="true"`; star click calls `onToggleStar` without `onOpen`; link chip text "RFI" for `itemType: 'rfi'`; attachment icon when `hasAttachments`.
  - `FolderRail.test.tsx`: role folders ordered; label folders under "Labels"; unread counts; account select only when 2 accounts.
  - `useThreadList.test.ts`: `mailApi.threads` mocked → first page, `loadMore` passes `before`, `reload` refetches with `limit` = loaded count.
  - `MailPage.test.tsx` (MemoryRouter at `/mail`): with 0 accounts → "Connect a mail account" CTA; with 1 account → navigates to `/mail/<id>/<inboxId>` (mock `mailApi.accounts/folders/threads`), rows render.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** all files. Wrap `MailPage` body in the same page container the Documents page uses (`grep -n "className=\"" src/pages/documents/DocumentsPage.tsx | head -3` for the outer classes).
- [ ] **Step 4: Run** → pass; `npm run lint`. **Step 5: Commit** `feat(mail-ui): inbox page shell, folder rail, thread list`.

---
### Task 4: Thread view — message cards, sandboxed body, attachments

**Files:**
- Create: `src/pages/mail/ThreadView.tsx`, `MessageCard.tsx`, `MessageBodyFrame.tsx`, `AttachmentChips.tsx`, `useThread.ts`
- Tests: `ThreadView.test.tsx`, `MessageCard.test.tsx`, `MessageBodyFrame.test.tsx`, `AttachmentChips.test.tsx`

**Interfaces:**
- `useThread(accountId, threadKey): { thread; messages; links; loading; reload(); error }` — live on `mailThread` with `id: threadKey`.
- `ThreadView` props: `{ accountId: string; threadKey: string; ownAddresses: string[]; onBack?: () => void; onReply(mode: 'reply'|'replyAll'|'forward', message: MessageRow): void; onOpenInComposer(): void }`. Renders: toolbar (Reply / Reply all / Forward · Archive · Move ▾ · Trash · Star · Mark unread · on mobile collapses into `⋯`), link strip (only when `links.length`: chips `itemType` label; Phase 2 adds "+ Link"), subject, message cards — all collapsed except the last and any unread; expanding a card marks it read after 1 s (`mailApi.messageActions([id], 'read')`) and re-fetches nothing (the live event handles it — but optimistically flip `isRead` locally). Actions use `mailApi.threadActions`; archive/trash then call `onBack?.()`.
- `MessageCard` props: `{ message: MessageRow; expanded: boolean; onToggle(); ownAddresses; onReply(mode) }` — header (avatar initial, from name/addr, "to me, cc X", date, ▾), when expanded: `MessageBodyFrame messageId=…`, `AttachmentChips`. Collapsed: one line `from · snippet · date`.
- `MessageBodyFrame` props: `{ messageId: string }` — fetches `mailApi.body(messageId)`; shows `Skeleton` while loading; yellow bar "Remote images blocked · Load images" when `blockedRemoteImages > 0` (click → refetch with `images: true`); renders `<iframe sandbox="" srcDoc={doc} title="Message" />` where `doc` = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${origin} data:; style-src 'unsafe-inline'"><base target="_blank"><style>body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#111;background:#fff;word-break:break-word} img{max-width:100%;height:auto}</style></head><body>${html}</body></html>` — NOTE `sandbox=""` blocks scripts and same-origin, but the `<a>` links must still open: `sandbox="allow-popups allow-popups-to-escape-sandbox"` is required for `target=_blank` to work; use exactly that value. Auto-height: since same-origin is not allowed, the frame can't report its height via `contentDocument`; instead inject a tiny inline script? Scripts are blocked. Solution: inject `<script>` and allow `allow-scripts` **without** `allow-same-origin` (the frame becomes an opaque origin, so it can't touch the parent DOM or cookies), and have the script `postMessage({ type: 'mail-frame-height', height: document.documentElement.scrollHeight }, '*')` on load and on `resize`/image load; the parent listens and sets the iframe height (cap 20000px). Our own script is the only script (server sanitizer strips all others; CSP `script-src 'unsafe-inline'` must then be added to the meta CSP — restrict with a nonce: `script-src 'nonce-${nonce}'` where `nonce` is a `uuid` per render). Dark mode: leave email bodies light (matches every mail client); the frame background is white by design.
- `AttachmentChips` props: `{ messageId: string; attachments: AttachmentMeta[]; onSave(): void }` — each chip: icon by mime (`MimeIcon` from `src/pages/documents/MimeIcon.tsx`), name, size (`fmtSize` — copy the tiny helper), click → `window.open(mailApi.attachmentUrl(messageId, attId), '_blank')` for PDFs/images (`inline: true`) else navigate to the download URL (`<a href download>`); a `💾 Save to Documents…` button on the right when `attachments.length` → `onSave()`.

- [ ] **Step 1: Tests**
  - `MessageBodyFrame.test.tsx`: mocks `mailApi.body` → iframe present with `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`, `srcdoc` contains the sanitized html and a CSP meta; blocked bar shows and clicking it calls `body(id, { images: true })`; a `message` event `{ type: 'mail-frame-height', height: 500 }` sets the iframe style height.
  - `MessageCard.test.tsx`: collapsed shows snippet; expanded shows from/to/date and renders the frame (mock it); Reply buttons call `onReply` with the right mode.
  - `AttachmentChips.test.tsx`: renders name + size; PDF chip opens inline URL; Save button calls `onSave`.
  - `ThreadView.test.tsx`: mocks `useThread` → last message expanded, earlier collapsed; unread message expanded; Archive calls `threadActions(accountId, [key], 'archive')` then `onBack`; link strip renders "RFI" chip when links exist and is absent otherwise.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → pass. **Step 5: Commit** `feat(mail-ui): thread view with sandboxed message bodies and attachments`.

---

### Task 5: Save attachments to Documents (upload-modal variant)

**Files:**
- Modify: `src/pages/documents/UploadDocumentsModal.tsx` (accept `remoteItems`), `src/pages/documents/UploadDocumentsModal.test.tsx`
- Create: `src/pages/mail/SaveAttachmentsModal.tsx` (+test)

**Interfaces:**
- `UploadDocumentsModal` gains optional prop `remoteItems?: Array<{ id: string; name: string; size: number; mime: string }>` and `onUploadRemote?: (items: Array<{ id: string; name: string; kind: string; projectId?: string; customerId?: string }>) => Promise<{ ok: number; total: number }>`. When `remoteItems` is given: entries are seeded from them (`Entry` gets a union: `{ id; kind; file: File } | { id; kind; remote: { id; name; size; mime } }`), the dropzone/browse input is hidden, the footer button reads `Save N file(s)`, and `handleUpload` calls `onUploadRemote` instead of `saveBinaryFile`. Per-file remove/uncheck: reuse the existing chip remove (✕) — an unchecked/removed chip is simply dropped from `entries`. Type/project/customer selectors unchanged. Modal title becomes `Save attachments to Documents`. A footnote "Files are fetched from your mailbox only when you confirm." shows in remote mode.
- `SaveAttachmentsModal` props: `{ open; onClose; messageId: string; attachments: AttachmentMeta[]; defaultProjectId?: string }` — loads `projects`/`customers`/`customTypes` the same way `DocumentsPage` does (grep how it fetches them: `getProjects`/`getCustomers`/custom types from settings) and renders `UploadDocumentsModal` with `remoteItems` and `onUploadRemote` → `mailApi.saveAttachments(messageId, items.map(...))`; toasts "Saved N file(s) to Documents"; on success `onClose()`.

- [ ] **Step 1: Tests** — `UploadDocumentsModal.test.tsx` additions: with `remoteItems` seeded chips show names/sizes, no dropzone, button text `Save 2 files`, removing one and confirming calls `onUploadRemote` with the remaining item + chosen kind/projectId; `SaveAttachmentsModal.test.tsx`: renders the modal with the message's attachments and calls `mailApi.saveAttachments` with `{ attId, name, kind, projectId }`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (keep all existing upload-modal tests green). **Step 4: Run** → pass. **Step 5: Commit** `feat(mail-ui): save mail attachments through the Documents upload modal`.

---

### Task 6: Composer — recipients, rich text, attachments, drafts, signature

**Files:**
- Install: `npm i @tiptap/react @tiptap/starter-kit @tiptap/extension-link @tiptap/extension-placeholder`
- Create: `src/pages/mail/compose/MailComposer.tsx`, `RecipientsField.tsx`, `RichTextEditor.tsx`, `useDraftAutosave.ts`, `quote.ts`
- Tests: `MailComposer.test.tsx`, `RecipientsField.test.tsx`, `RichTextEditor.test.tsx`, `quote.test.ts`, `useDraftAutosave.test.ts`

**Interfaces:**
- `quote.ts`: `quoteForReply(message: MessageRow, bodyHtml: string): string` → `<br><br><div class="ft-quote" style="border-left:2px solid #ccc;padding-left:8px;color:#555">On {date}, {from} wrote:<br>{bodyHtml}</div>`; `quoteForForward(message, bodyHtml)` → header block `---------- Forwarded message ----------` with From/Date/Subject/To lines; `replyAllRecipients(message, ownAddresses): { to: Addr[]; cc: Addr[] }` (to = from + original to minus own; cc = original cc minus own; dedupe); `replySubject(s)` → `Re: ` unless already `re:`; `forwardSubject(s)` → `Fwd: `.
- `RecipientsField` props: `{ label: 'To'|'Cc'|'Bcc'; value: Addr[]; onChange(v: Addr[]); autoFocus? }` — pills (`name · addr`, customer pills tinted via `source !== 'recent'`), free-text entry (Enter/comma/Tab/blur commits when it parses as an address; invalid text stays red), autocomplete dropdown from `mailApi.recipients(q)` (debounce 150 ms, min 1 char, arrow keys + Enter), paste of a comma list splits into pills.
- `RichTextEditor` props: `{ value: string; onChange(html: string); placeholder?; minHeight?: number; autoFocus? }` — TipTap with `StarterKit` (bold/italic/strike/headings/lists/blockquote/code), `Link` (openOnClick false; toolbar "link" prompts for URL), `Placeholder`; compact toolbar (B I U · H · • ≡ · " · 🔗 · clear formatting). Underline: StarterKit lacks it → add `@tiptap/extension-underline`. `value` prop changes from outside (e.g. inserting the quote) call `editor.commands.setContent` only when different from current HTML.
- `useDraftAutosave(opts: { accountId: string | null; enabled: boolean; get(): { to; cc; bcc; subject; html } }): { draftId: string | null; status: 'idle'|'saving'|'saved'|'error'; savedAt: Date | null; discard(): Promise<void> }` — debounced 3 s after `get()` output changes (compare JSON); `mailApi.saveDraft` (create then update); `discard` deletes the draft if any.
- `MailComposer` props:
  ```ts
  interface MailComposerProps {
    open: boolean; onClose(): void;
    variant: 'modal' | 'inline';
    accounts: MailAccount[]; defaultAccountId?: string;
    mode?: 'new' | 'reply' | 'replyAll' | 'forward';
    replyTo?: { accountId: string; threadKey: string; message: MessageRow; bodyHtml: string };   // reply/forward source
    initial?: { to?: Addr[]; cc?: Addr[]; bcc?: Addr[]; subject?: string; html?: string; attachments?: ComposerAttachment[] };
    /** Called with the resolved SendRequest; the caller performs the send (DocumentActionsBar wraps item routes). Default: mailApi.send. */
    onSend?: (req: SendRequest) => Promise<SendResult | void>;
    onSent?: (r: SendResult | void) => void;
    /** Fixed, non-removable primary attachment (item document) shown first. */
    primaryAttachment?: { name: string; itemType?: string; itemId?: string };
    /** Reply-in-existing-thread toggle for item sends: when provided, a header radio shows "Reply in existing thread (subject)" / "New thread". */
    existingThread?: { accountId: string; threadKey: string; subject: string };
    title?: string; onOpenInModal?(): void;   // inline → modal escalation
  }
  type ComposerAttachment = { kind: 'file'; fileId: string; name: string; size?: number; itemType?: string; itemId?: string } | { kind: 'upload'; uploadId: string; name: string; size: number };
  ```
  Behavior: From select (accounts with status ok/syncing; disabled others shown with reason); To/Cc/Bcc (Cc/Bcc collapsed behind a "Cc Bcc" toggle unless prefilled); always-CC from `getAlwaysCc()` merged into Cc on open; subject; `RichTextEditor` with the account `signatureHtml` appended below a `<br><br>--<br>` on open for `new`/`forward`/`reply` (above the quote); reply/forward → quote appended; attachments row: primary chip (locked) + removable chips + `📎 Attach file` (device: `<input type=file multiple>` → `mailApi.stageUpload` each, progress spinner) + `📁 From Documents` (`FilePickerModal` with `accept:'any'`, `multi`, `onPick(rows)` → chips `{ kind:'file', fileId: row.id, name: row.name, itemType: itemTypeFromSource(row.sourceType), itemId: row.sourceId }` where `itemTypeFromSource` maps `proposal→proposal, invoice→invoice, changeOrder/change-order→changeOrder, issue→issue, rfi→rfi, dailyReport/daily-report→dailyReport, aiaPayApp/payApp→payApp` — check the exact `sourceType` strings used by each editor's `DocumentActionsBar source` prop with `grep -rn "sourceType: '" src/pages/project | sort -u`); a chip with an item tag shows a small label (e.g. "Proposal"); draft autosave status text "Draft saved 4s ago" (only for `mailApi.send` default path — item sends don't autosave drafts); Send button disabled until ≥1 valid To; on send builds `SendRequest` (`replyTo` from `replyTo`/`existingThread` when "Reply in existing thread" is chosen), calls `onSend ?? mailApi.send`, on success toasts "Sent" (and, if `effectsSkipped.length`, a warning toast "Sent — status not updated for: …"), calls `discard()` on the draft, `onSent`, `onClose`. Errors toast the server message and keep the composer open. Modal variant uses `Modal width="lg"` with the From select in the title row and `⤢`/`✕`; inline variant renders a bordered card with "Open in composer" (`onOpenInModal`).
  Stale-document hint (spec §4.6): when a picked Documents row has `sourceType` and the item's `updatedAt` is newer than the file's `createdAt` — the picker row already carries `createdAt`; the item's `updatedAt` isn't known here → show the hint only when the caller passes `primaryAttachment` with `stale: true` (DocumentActionsBar knows `upToDate`). Add `stale?: boolean` to `primaryAttachment`.

- [ ] **Step 1: Tests**
  - `quote.test.ts`: reply quote includes "wrote:" and the html; forward header lines; `replyAllRecipients` excludes own addresses and dedupes; subjects.
  - `RecipientsField.test.tsx`: typing `a@b.com,` creates a pill; invalid text isn't committed; autocomplete shows results from mocked `mailApi.recipients` and Enter picks the highlighted one; backspace on empty input removes the last pill.
  - `RichTextEditor.test.tsx`: renders with placeholder; typing (via `editor.commands.insertContent` through a test ref or `userEvent.type`) triggers `onChange` with html; Bold toolbar toggles `<strong>`.
  - `useDraftAutosave.test.ts` (fake timers): first change → `saveDraft` create after 3 s; second change → update with the id; `discard` → `deleteDraft`.
  - `MailComposer.test.tsx`: opens with always-CC prefilled; Send disabled until To valid; send builds the request (to/cc/subject/html/attachments) and calls `onSend`; reply mode prefills To/subject and appends the quote; `existingThread` radio toggles `replyTo` in the request; picking a document via mocked `FilePickerModal` adds a tagged chip; `effectsSkipped` produces the warning toast.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** TipTap in jsdom: StarterKit works under jsdom; if `document.createRange` errors, add `src/test/setup.ts` polyfill `Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as any)` and `getBoundingClientRect`.
- [ ] **Step 4: Run** → pass; `npm run lint`. **Step 5: Commit** `feat(mail-ui): composer with recipients autocomplete, rich text, attachments, drafts`.

---

### Task 7: Wire compose/reply into MailPage; mobile stacking; palette `?compose=1`

**Files:**
- Modify: `src/pages/mail/MailPage.tsx`, `ThreadView.tsx`, tests

- [ ] **Step 1: Tests** — `MailPage.test.tsx` additions: `?compose=1` opens the modal composer; ThreadView reply click renders the inline composer under the thread with the quote; on `< md` viewport (mock `matchMedia`) only one pane renders at a time and Back returns to the list; after a successful send the inline composer closes and the thread reloads (mock `useThread.reload`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — `MailPage` owns `composer` state `{ kind: 'new' } | { kind: 'reply'; mode; message; bodyHtml } | null`; `ThreadView.onReply` fetches the body (`mailApi.body`) then opens the inline composer; "Open in composer" promotes the same state to the modal variant preserving typed content (lift the composer's draft state via `initial` — simplest: keep one `MailComposer` instance and only switch `variant`, which keeps React state).
- [ ] **Step 4: Run** → pass. **Step 5: Commit** `feat(mail-ui): compose and inline reply wired into the inbox; mobile stacked panes`.

---
### Task 8: Settings → Mail tab + admin setup guide

**Files:**
- Create: `src/pages/settings/MailAccountsTab.tsx` (+test), `src/pages/mail/MailSetupGuide.tsx` (+test), `src/pages/settings/ImapAccountForm.tsx` (+test)
- Modify: `src/pages/Settings.tsx` (`TabId` `'email'` → `'mail'`, tab label "Mail", render `<MailAccountsTab />`; keep the Always-CC card by moving it into `MailAccountsTab`; delete the old `EmailTab` component at lines 934-1110; read `?tab=` + `?connected=` + `?error=` from `useSearchParams` on mount to open the tab and toast), `src/pages/Settings.test.tsx` (if the Email tab is asserted anywhere)

**Interfaces:**
- `MailAccountsTab`: cards per account (provider icon: Google "G" badge / Microsoft "M" / IMAP `Server` icon; address; `displayName`; status pill — `ok` green "Connected", `syncing` blue, `needs_review` amber "Needs review", `auth_error` red "Reconnect needed", `disabled` gray; "Last sync {relative}"; `lastError` in small red text), actions: **Set default** (radio), **Signature** (expands `RichTextEditor` + Save → `patchAccount(id, { signatureHtml })`), **Test & activate** (needs_review/imap: `testAccount` → toast + reload), **Reconnect** (oauth: `window.location.href = mailApi.oauthStartUrl(provider)`), **Edit** (imap → `ImapAccountForm` prefilled, password blank = keep), **Disable/Enable**, **Remove** (confirm dialog: "Removes the local index for this mailbox. Thread links stay."). Buttons row: `Connect Google` / `Connect Microsoft` (disabled with tooltip "Not configured on this server — see the setup guide" when `setupInfo.<p>.configured` is false; setupInfo is admin-only, so for non-admins call `GET /api/mail/oauth/google/start` behavior: just attempt navigation and let the 501/501 page show? No — expose configured flags to everyone: add `configured: { google, microsoft }` to `GET /api/mail/accounts` response envelope? Simpler: new small route `GET /api/mail/providers` (any user) → `{ google: boolean; microsoft: boolean }`; add it to Plan 1's routes.ts now (one-liner) and to `mailApi.providers()`), `Add IMAP account` (opens `ImapAccountForm` modal). Always-CC card (moved verbatim from the old EmailTab, same `emailAlwaysCc` pref). Admin-only `MailSetupGuide` below.
- `ImapAccountForm` props: `{ open; onClose; existing?: MailAccount; onSaved(account: MailAccount) }` — fields per spec §5.3; "Test & save" = `createImapAccount` (or update with `id`) then `testAccount`; shows the server error inline on failure and leaves the account in `needs_review`.
- `MailSetupGuide`: fetches `mailApi.setupInfo()`; renders the two step lists from spec §6 with copy buttons (`navigator.clipboard?.writeText` guarded — plain-HTTP LAN may lack it; fall back to a selectable `<code>`), the env var table with set/unset badges, and the key-file note. Links to `docs/mail-setup.md` on GitHub are not assumed; the guide is self-contained.

- [ ] **Step 1: Tests** — `MailAccountsTab.test.tsx`: renders cards with status pills; needs_review card shows "Test & activate" and calls `testAccount`; Connect Google disabled when providers say not configured; Remove confirms then calls `deleteAccount`; `?connected=<id>` toasts "Connected …". `ImapAccountForm.test.tsx`: validation (required fields), submit calls `createImapAccount` then `testAccount`; error shown inline. `MailSetupGuide.test.tsx`: shows redirect URIs from mocked setupInfo and "not set" badges.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (+ the `GET /api/mail/providers` route and a supertest case in Plan 1's `routes.test.ts`). **Step 4: Run** → pass. **Step 5: Commit** `feat(mail-ui): Settings → Mail accounts, IMAP form, admin setup guide`.

---

### Task 9: Swap `DocumentActionsBar` onto `MailComposer`; sent-thread chip

**Files:**
- Modify: `src/components/documents/DocumentActionsBar.tsx` (props `send.composer` type → `MailComposerPrefill`; mount `MailComposer variant="modal"`; `handleSend` unchanged except it now receives a `SendRequest`), `src/components/documents/DocumentActionsBar.test.tsx`, all 8 editors under `src/pages/project/` that pass `send={{ composer: {...} }}` (`ProposalEditor`, `InvoiceEditor`, `ChangeOrderEditor`, `IssueEditor`, `RfiEditor`, `DailyReportEditor`, `ProjectPunch`, `AiaPayAppEditor`) and their `sendFn` bodies + `src/utils/store.ts` `send*` payload types (add `html?`, `replyTo?`, `accountId?`; keep `body` for plain text), `src/pages/project/proposal/useProposalEmailDefaults.ts`
- Create: `src/components/documents/SentThreadChip.tsx` (+test), `src/hooks/useItemThreadLinks.ts` (+test)
- Delete: `src/components/EmailComposer.tsx` (+ its test) once nothing imports it (`grep -rn EmailComposer src`).

**Interfaces:**
- `MailComposerPrefill = { title?: string; defaultTo?: string; defaultCc?: string; defaultBcc?: string; defaultSubject: string; defaultBody: string; headerEmailOptions?: {label; value}[]; defaultHeaderEmail?: string }` — same fields the editors already build (so editor changes are mechanical). `DocumentActionsBar` converts: `defaultTo/Cc/Bcc` strings → `parseAddressList` (client `src/utils/email.ts` has `parseAddressList`? it has validation helpers; add a client-side `parseAddresses(s): Addr[]` in `src/utils/email.ts` mirroring the server regex) → `initial.to/cc/bcc`; `defaultBody` (plain text with `\n`) → html via the same `textToHtml` the server uses (escape + `<br>`); `headerEmailOptions` → a small select rendered by `MailComposer` through a new optional prop `extraHeader?: React.ReactNode` + the bar keeps reading `headerEmail` from its own state.
- `send.sendFn: (fileId: string, req: SendRequest) => Promise<SendResult | void>` — editors forward `req` fields into their `send*` store call: `{ to: req.to.map(formatAddr).join(', '), cc, bcc, subject: req.subject, html: req.html, fileId, attachmentFileIds: req.attachments.filter(a => 'fileId' in a).map(a => a.fileId), replyTo: req.replyTo, accountId: req.accountId }`; the store functions return the JSON (`{ success, messageId, threadKey, accountId, effectsSkipped }`) instead of `void`.
- `useItemThreadLinks(itemType: string, itemId?: string): { links: ThreadLink[]; reload(); myThread(link): { accountId; threadKey } | null }` — loads `mailApi.links(itemType, itemId)`; `myThread` checks whether the current user's accounts have the thread: `mailApi.thread(accountId, link.threadKey)` per account lazily (cache 404s) — Phase 1 rule: exact threadKey only (subject+date fallback is Phase 2).
- `SentThreadChip` props: `{ itemType; itemId?: string }` — renders nothing without links; otherwise `Sent · {date of newest link} · Open thread` (navigates to `/mail/${accountId}/inbox-or-sent-folder/${threadKey}` — MailPage resolves a folder id of `_` to "any": add that convention: `folderId === '_'` → no folder filter) or, when `myThread` is null, a muted `Sent · {date} · by another user` with tooltip.
- `DocumentActionsBar` mounts `<SentThreadChip itemType={itemTypeFor(source.sourceType)} itemId={source.sourceId} />` next to the freshness chip, and passes `existingThread` to `MailComposer` when a link exists (`{ accountId, threadKey, subject }` from `myThread`). Blocked state: `send.blockedReason` computed by the bar itself from `useMailAccounts()` — no active account → `'Connect a mail account in Settings → Mail'` with the text rendered as a link; editors no longer need `getMailAccounts()` checks (remove the Plan 1 stopgap).

- [ ] **Step 1: Tests** — `DocumentActionsBar.test.tsx`: existing send tests updated to the new composer (mock `MailComposer` to a stub that calls `onSend` with a canned `SendRequest`); blocked reason when no accounts; `existingThread` passed when a link exists; chip renders after send (mock `useItemThreadLinks`). `SentThreadChip.test.tsx`: no links → null; own thread → link to `/mail/a1/_/key`; other user's → muted text. `useItemThreadLinks.test.ts`: resolves `myThread` across accounts, caches misses. Each editor's existing test (`RfiEditor.test.tsx`, `InvoiceEditor.test.tsx`, …) updated for the new `sendFn` signature.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** editor by editor (RFI first, then copy the pattern). **Step 4: Run** the whole `ui` project → pass; `npm run lint`. **Step 5: Commit** `feat(mail-ui): item editors send through MailComposer; Sent · Open thread chip`.

---

### Task 10: Polish, changelog, manual smoke, push

- [ ] **Step 1: Keyboard + a11y** — thread list rows are `role="button"` with `tabIndex=0`, Enter opens; `j/k` navigation is out of scope. Composer modal traps focus (Modal already does — verify with `grep -n focus src/components/ui/Modal.tsx`). Iframe has `title`. Unread badge has `aria-label`.
- [ ] **Step 2: Dark mode** — run the app in dark theme; thread list/reading pane use tokens only; the mail iframe stays light by design (add a 1px `border-edge` around it so it doesn't float).
- [ ] **Step 3: Changelog** — add an entry to the array in `src/pages/Settings.tsx` (~line 27) titled `v2.10.0 — Mail` listing: Mail tab (Google/Microsoft/IMAP), threads, compose/reply with rich text, attachments to/from Documents, drafts, search, per-account signatures, item sends now go through your connected mailbox and link the thread, SMTP settings migrated (re-check IMAP host in Settings → Mail).
- [ ] **Step 4: Manual smoke** (`MAIL_FAKE_PROVIDER=1 npm run dev` plus the real-provider testing host): connect each provider type; inbox loads; open thread; remote-image bar; download attachment; save attachment → appears in Documents with the chosen type; reply inline → appears in Sent + thread; compose new with a picked document → chip tag; send an RFI from its editor → RFI status `sent`, chip "Sent · Open thread" → opens the thread; phone width: list → thread → back; Settings: signature save, set default, remove account.
- [ ] **Step 5:** `npm run lint && npm test` → green. `git add -A && git commit -m "feat(mail-ui): polish + changelog v2.10.0" && git push origin testing`.

## Plan 3 self-review notes
- §5.1 ✔ Task 2; §5.2 ✔ Tasks 3–7 (MailPage, FolderRail, ThreadList/Row, ThreadView/MessageCard, SaveAttachmentsModal, Composer, mailApi, hooks); §5.3 ✔ Task 8; §5.4 ✔ Task 9 (+ blocked state, chip, existing-thread toggle, staged uploads through the composer); §5.5 ✔ Task 7; §8 in-app guide ✔ Task 8; §9 UI rows ✔.
- Added while planning: `GET /api/mail/providers` (any user) so non-admins see which Connect buttons work; folder id `_` convention for deep links without a folder; `primaryAttachment.stale` for the stale-PDF hint; `MailProvider`/`sendService` untouched.
